#!/usr/bin/env node
/**
 * KubeVision AI — R13 系统健壮性与工程化防线端到端探针（scripts/probe-r13-robustness.mjs）
 *
 * 【覆盖清单（R13 Main #1~#7 + R13 进阶 #1~#5）】
 *   1. `/api/health` 只读健康接口契约校验与零凭据泄露扫描；
 *   2. `/api/telemetry` SSE 连接预算限制（`?maxConn=3` 第 4 条拒绝并释放）、15s/自定义心跳帧（`?heartbeatMs=`）、
 *      最大生命周期断开（`?maxLifeMs=`）与 20 并发压测（P95 < 1500ms）；
 *   3. 3 标签页并发 `?mode=live` 单例采集复用与 CPU [0, 100] 边界校验；
 *   4. `/api/chat` 三种客户端断开路径（AbortSignal、reader.cancel、超时断流）各 ×10 次共 30 次压测，
 *      确认取消后零误降级 simulator 日志且零冗余帧溢出；
 *   5. Headless Edge CDP 四大故障演练与真机截图留档（`docs/screenshots/r13-drill-*.png`）：
 *      - Drill 1：LLM 上游不可用降级提示（Engine B 兜底）
 *      - Drill 2：SSE 连续失败切入本地合成兜底不卡死
 *      - Drill 3：`webglcontextlost` 静态快照冻结与恢复提示
 *      - Drill 4：3D `<Canvas>` 异常边界捕获自动降级 2D SVG 集群拓扑与 Pod 选中联动
 *   6. 前端运行期异常环形缓冲区（2000ms 去重 + 20 条上限）与 PerfHUD「最近 5 个异常」交互；
 *   7. 调用 `node scripts/verify-demo.mjs --inject-throw-test` 验证 `page-error.md` 全帧堆栈取证闭环。
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL =
  process.argv.find((arg) => arg.startsWith('--base='))?.slice('--base='.length) ??
  'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_R13_CDP_PORT ?? '9366');
const SCREENSHOT_DIR = join(process.cwd(), 'docs', 'screenshots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(name, detail = '') {
  passCount += 1;
  console.log(`  ✓ ${name}${detail ? `  ::  ${detail}` : ''}`);
}

function bad(name, detail) {
  failCount += 1;
  failures.push({ name, detail });
  console.error(`  ✗ ${name}  ::  ${JSON.stringify(detail)}`);
}

function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function findEdgePath() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function ensureServerRunning() {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      return { proc: null, logs: [], startedHere: false };
    }
  } catch {
    /* need spawn */
  }

  const url = new URL(BASE_URL);
  const port = url.port || '3000';
  console.log(`  → 未检测到已运行服务，自动启动 next dev (port=${port})…`);
  const logs = [];
  const nextBin = join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
  const proc = spawn(process.execPath, [nextBin, 'dev', '-H', url.hostname || '127.0.0.1', '-p', port], {
    cwd: process.cwd(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        logs.push(line);
        if (logs.length > 1000) logs.shift();
      }
    }
  });
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        logs.push(line);
        if (logs.length > 1000) logs.shift();
      }
    }
  });

  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        console.log(`  → 服务已就绪 (${BASE_URL})`);
        return { proc, logs, startedHere: true };
      }
    } catch {
      /* wait */
    }
    await sleep(750);
  }

  try {
    if (proc.pid && process.platform === 'win32') {
      execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {
    /* ignore */
  }
  throw new Error(`无法在预期时间内启动服务: ${BASE_URL}\n最近日志:\n${logs.slice(-15).join('\n')}`);
}

async function readSseUntil(url, options) {
  const { timeoutMs = 4000, stopOnMatch, signal } = options;
  const ac = new AbortController();
  const mergedSignal = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const startedAt = Date.now();
  let rawText = '';
  let status = 0;
  let headers = null;
  let closedNaturally = false;

  try {
    const res = await fetch(url, { signal: mergedSignal });
    status = res.status;
    headers = res.headers;
    const reader = res.body?.getReader();
    if (!reader) {
      return { status, headers, rawText, elapsedMs: Date.now() - startedAt, closedNaturally: true };
    }
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        closedNaturally = true;
        break;
      }
      rawText += decoder.decode(value, { stream: true });
      if (stopOnMatch && stopOnMatch(rawText)) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  } catch {
    /* abort expected when stop condition or timeout hit */
  } finally {
    clearTimeout(timer);
    ac.abort();
  }

  return {
    status,
    headers,
    rawText,
    elapsedMs: Date.now() - startedAt,
    closedNaturally,
  };
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  let eventHandler = null;
  const consoleErrors = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const text = (msg.params.args ?? [])
        .map((a) => String(a.value ?? a.description ?? ''))
        .join(' ');
      consoleErrors.push(text.slice(0, 240));
    }
    if (typeof msg.method === 'string' && eventHandler) {
      Promise.resolve(eventHandler(msg)).catch(() => {});
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      return {
        __err: String(
          res.result.exceptionDetails.exception?.description ??
            res.result.exceptionDetails.text ??
            'eval error',
        ),
      };
    }
    return res.result?.result?.value;
  };

  return {
    send,
    evaluate,
    consoleErrors,
    setEventHandler: (fn) => {
      eventHandler = fn;
    },
    close: () => ws.close(),
  };
}

async function saveScreenshot(cdp, filename) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const data = shot?.result?.data;
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error(`截图返回为空: ${filename}`);
  }
  const outPath = join(SCREENSHOT_DIR, filename);
  writeFileSync(outPath, Buffer.from(data, 'base64'));
  return outPath;
}

async function testHealthEndpoint() {
  section('1. /api/health 诊断契约与凭据隔离审计');
  const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(4000) });
  if (res.status !== 200) {
    bad('GET /api/health 状态码', { status: res.status });
    return;
  }
  const rawBody = await res.text();
  let json = null;
  try {
    json = JSON.parse(rawBody);
  } catch (err) {
    bad('GET /api/health JSON 解析', String(err));
    return;
  }

  const secretPatterns = [/OPENAI_API_KEY/i, /DEEPSEEK_API_KEY/i, /Bearer\s+[A-Za-z0-9]/i, /\bsk-[A-Za-z0-9]{10,}/];
  const leaked = secretPatterns.some((re) => re.test(rawBody));
  if (leaked) {
    bad('/api/health 零凭据泄露检查', 'detected potential secret token in response');
  } else {
    ok('/api/health 零凭据泄露检查', 'only boolean llmConfigured exposed');
  }

  const tiersCount = json?.degradation?.matrixSummary?.length ?? 0;
  const maxConn = json?.sse?.maxConnections ?? 0;
  if (
    (json?.status === 'ok' || json?.status === 'degraded') &&
    typeof json?.engine?.llmConfigured === 'boolean' &&
    json?.engine?.fallbackReady === true &&
    maxConn === 24 &&
    tiersCount === 5
  ) {
    ok(
      '/api/health 五层降级矩阵与 SSE 配额字段完整',
      `status=${json.status}, engine=${json.engine.mode}, tiers=${tiersCount}, maxConn=${maxConn}`,
    );
  } else {
    bad('/api/health 响应字段不符合契约', json);
  }
}

async function testSseBudgetHeartbeatLifetimeAndConcurrency() {
  section('2. SSE 预算上限 / 心跳保活 / 生命周期封顶 / 20 并发压测');

  /* 2.1 连接预算：?maxConn=3 打开 3 条长连接，第 4 条应触发 budget-exceeded */
  const holders = [1, 2, 3].map(() => new AbortController());
  const holdPromises = holders.map((ac) =>
    readSseUntil(`${BASE_URL}/api/telemetry?mode=demo&maxConn=3`, {
      timeoutMs: 3500,
      signal: ac.signal,
    }),
  );
  await sleep(600);

  const rejectedRes = await readSseUntil(`${BASE_URL}/api/telemetry?mode=demo&maxConn=3`, {
    timeoutMs: 2500,
    stopOnMatch: (txt) => txt.includes('event: budget-exceeded'),
  });

  if (
    rejectedRes.rawText.includes('event: budget-exceeded') &&
    rejectedRes.rawText.includes('上限')
  ) {
    ok('SSE 连接预算拒绝第 4 条超限连接', 'received event: budget-exceeded + 中文说明');
  } else {
    bad('SSE 连接预算拒绝第 4 条超限连接', rejectedRes.rawText.slice(0, 300));
  }

  holders.forEach((ac) => ac.abort());
  await Promise.allSettled(holdPromises);
  await sleep(300);

  const healthAfterClose = await (await fetch(`${BASE_URL}/api/health`)).json();
  if ((healthAfterClose?.sse?.activeConnections ?? -1) === 0) {
    ok('SSE 连接断开后槽位严格归零释放', 'activeConnections=0');
  } else {
    bad('SSE 连接断开后槽位未归零', healthAfterClose?.sse);
  }

  /* 2.2 注释心跳帧 */
  const hbRes = await readSseUntil(`${BASE_URL}/api/telemetry?mode=demo&heartbeatMs=700`, {
    timeoutMs: 2400,
    stopOnMatch: (txt) => txt.includes(': heartbeat'),
  });
  if (hbRes.rawText.includes(': heartbeat')) {
    ok('SSE 注释心跳帧按周期送达', `elapsed=${hbRes.elapsedMs}ms`);
  } else {
    bad('SSE 注释心跳帧未到达', hbRes.rawText.slice(0, 300));
  }

  /* 2.3 最大生命周期主动收口 */
  const lifeRes = await readSseUntil(`${BASE_URL}/api/telemetry?mode=demo&maxLifeMs=1500`, {
    timeoutMs: 4000,
  });
  if (lifeRes.closedNaturally && lifeRes.elapsedMs >= 1300 && lifeRes.elapsedMs < 3500) {
    ok('SSE 最大生命周期到点主动平稳关闭', `closedNaturally=true, elapsed=${lifeRes.elapsedMs}ms`);
  } else {
    bad('SSE 最大生命周期未按期关闭', {
      closedNaturally: lifeRes.closedNaturally,
      elapsedMs: lifeRes.elapsedMs,
    });
  }

  /* 2.4 20 并发 SSE 首帧与释放压测 */
  const conns = await Promise.all(
    Array.from({ length: 20 }, () =>
      readSseUntil(`${BASE_URL}/api/telemetry?mode=demo`, {
        timeoutMs: 3500,
        stopOnMatch: (txt) => txt.includes('"clusterHealthScore"'),
      }),
    ),
  );
  const latencies = conns
    .filter((c) => c.status === 200 && c.rawText.includes('"clusterHealthScore"'))
    .map((c) => c.elapsedMs)
    .sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 9999;

  await sleep(300);
  const healthAfter20 = await (await fetch(`${BASE_URL}/api/health`)).json();

  if (
    latencies.length === 20 &&
    p95 < 1500 &&
    (healthAfter20?.sse?.activeConnections ?? -1) === 0
  ) {
    ok('20 并发 SSE 首帧送达与断连回收', `20/20 OK · P95=${p95}ms · active=0`);
  } else {
    bad('20 并发 SSE 首帧或回收异常', {
      succeeded: latencies.length,
      p95,
      sse: healthAfter20?.sse,
    });
  }
}

async function testLiveConcurrency3Tabs() {
  section('3. 三标签页并发 `?mode=live` 单例采样共享与边界校验');
  const controllers = [1, 2, 3].map(() => new AbortController());
  const streamPromises = controllers.map((ac) =>
    readSseUntil(`${BASE_URL}/api/telemetry?mode=live&chaos=NONE`, {
      timeoutMs: 3200,
      signal: ac.signal,
    }),
  );

  await sleep(1600);
  const midHealth = await (await fetch(`${BASE_URL}/api/health`)).json();
  const results = await Promise.all(streamPromises);

  let validCpuCount = 0;
  let nanCount = 0;
  for (const r of results) {
    const matches = [...r.rawText.matchAll(/data:\s*(\{[^\n]+\})/g)];
    for (const m of matches) {
      try {
        const snap = JSON.parse(m[1]);
        const cpus = (snap.nodes ?? []).map((n) => n.cpuUsage);
        for (const c of cpus) {
          if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 100) {
            nanCount += 1;
          } else {
            validCpuCount += 1;
          }
        }
      } catch {
        /* ignore partial trailing chunk */
      }
    }
  }

  await sleep(300);
  const endHealth = await (await fetch(`${BASE_URL}/api/health`)).json();
  const midSubs = midHealth?.sse?.hostSamplerSubscribers ?? 99;
  const endSubs = endHealth?.sse?.hostSamplerSubscribers ?? 99;

  if (validCpuCount >= 6 && nanCount === 0 && midSubs <= 3 && endSubs === 0) {
    ok(
      '3 标签页 live 并发采样无 NaN 且共享窗口释放归零',
      `validCpu=${validCpuCount}, nan=${nanCount}, midSubs=${midSubs}, endSubs=${endSubs}`,
    );
  } else {
    bad('3 标签页 live 并发采样异常', { validCpuCount, nanCount, midSubs, endSubs });
  }
}

async function testChatCancelPaths30Runs(serverLogs) {
  section('4. `/api/chat` 三种断开取消路径 × 10 次（共 30 次）零误降级校验');
  const logCountBefore = serverLogs.length;
  let simulatorTailCount = 0;
  let httpErrorCount = 0;
  let pathACount = 0;
  let pathBCount = 0;
  let pathCCount = 0;

  const payload = JSON.stringify({
    messages: [{ role: 'user', content: '请执行 OOM 与节点 CPU 尖峰深度排查测试。' }],
    clusterContext: {
      selectedEntityId: 'pod-payment-gateway-7f8b9-x2k',
      selectedEntityType: 'pod',
      activeChaos: 'POD_OOM_SWARM',
      clusterHealthScore: 68,
      totalQps: 9800,
      faultyPods: [
        {
          id: 'pod-payment-gateway-7f8b9-x2k',
          name: 'payment-gateway-7f8b9-x2k',
          namespace: 'prod-core',
          status: 'OOMKilled',
          cpuUsage: 88,
          memUsage: 97,
          restartCount: 6,
          nodeId: 'node-worker-alpha',
        },
      ],
      nodes: [
        { id: 'node-worker-alpha', name: 'worker-alpha', status: 'Ready', cpuUsage: 82, memUsage: 91, rackIndex: 0 },
        { id: 'node-worker-beta', name: 'worker-beta', status: 'Ready', cpuUsage: 44, memUsage: 52, rackIndex: 1 },
      ],
    },
  });

  /* Path A (x10): AbortController.abort() 中途取消（首包抵达即取消，60ms 兜底定时器） */
  for (let i = 0; i < 10; i += 1) {
    const ac = new AbortController();
    let sawEngineFallback = false;
    let sawSimulatorDoneAfterFallback = false;
    const abortTimer = setTimeout(() => ac.abort(), 60);
    try {
      const res = await fetch(`${BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: ac.signal,
      });
      if (!res.ok) {
        httpErrorCount += 1;
      }
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let chunkIndex = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunkIndex += 1;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.includes('"reason":"engine-fallback"')) {
            sawEngineFallback = true;
          }
          if (
            sawEngineFallback &&
            chunk.includes('"type":"done"') &&
            chunk.includes('"engine":"simulator"')
          ) {
            sawSimulatorDoneAfterFallback = true;
          }
          if (chunkIndex === 1 && !ac.signal.aborted) {
            ac.abort();
          }
        }
      }
    } catch {
      /* AbortError expected */
    } finally {
      clearTimeout(abortTimer);
      if (ac.signal.aborted) {
        pathACount += 1;
      }
    }
    if (sawSimulatorDoneAfterFallback) simulatorTailCount += 1;
  }

  /* Path B (x10): reader.cancel() 主动取消流 */
  for (let i = 0; i < 10; i += 1) {
    let sawPostCancelFrame = false;
    try {
      const res = await fetch(`${BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (!res.ok) {
        httpErrorCount += 1;
      }
      const reader = res.body?.getReader();
      if (reader) {
        const first = await reader.read();
        if (!first.done) {
          await reader.cancel('client reader cancel probe');
          pathBCount += 1;
          const after = await reader.read();
          if (!after.done) sawPostCancelFrame = true;
        }
      }
    } catch {
      pathBCount += 1;
    }
    if (sawPostCancelFrame) simulatorTailCount += 1;
  }

  /* Path C (x10): AbortSignal.timeout(45) 超时断流 */
  for (let i = 0; i < 10; i += 1) {
    const timeoutSignal = AbortSignal.timeout(45);
    let sawEngineFallback = false;
    let sawSimulatorDoneAfterFallback = false;
    try {
      const res = await fetch(`${BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: timeoutSignal,
      });
      if (!res.ok) {
        httpErrorCount += 1;
      }
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.includes('"reason":"engine-fallback"')) {
            sawEngineFallback = true;
          }
          if (
            sawEngineFallback &&
            chunk.includes('"type":"done"') &&
            chunk.includes('"engine":"simulator"')
          ) {
            sawSimulatorDoneAfterFallback = true;
          }
        }
      }
    } catch {
      /* TimeoutError / AbortError expected */
    } finally {
      if (timeoutSignal.aborted) {
        pathCCount += 1;
      }
    }
    if (sawSimulatorDoneAfterFallback) simulatorTailCount += 1;
  }

  await sleep(400);
  const completedAborts = pathACount + pathBCount + pathCCount;
  const newServerLogs = serverLogs.slice(logCountBefore);
  const falseFailures = newServerLogs.filter((line) => line.includes('engine A failed'));

  if (
    completedAborts === 30 &&
    httpErrorCount === 0 &&
    simulatorTailCount === 0 &&
    falseFailures.length === 0
  ) {
    ok(
      '30 次客户端断开取消均零误报零残留输出',
      `aborts=30/30 (pathA=${pathACount}, pathB=${pathBCount}, pathC=${pathCCount}) · httpErrors=${httpErrorCount} · falseEngineAFailed=${falseFailures.length} · postCancelTail=${simulatorTailCount}`,
    );
  } else {
    bad('客户端断开取消存在误降级或尾部溢出', {
      completedAborts,
      pathACount,
      pathBCount,
      pathCCount,
      httpErrorCount,
      simulatorTailCount,
      falseFailures,
    });
  }
}

async function runBrowserDrillsAndErrorBufferChecks() {
  section('5. Headless Edge 四大故障演练截图 + 运行时异常缓冲区 + 2D 拓扑');
  const edgePath = findEdgePath();
  if (!edgePath) {
    bad('定位 Edge 浏览器', 'msedge.exe not found');
    return;
  }

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-r13-robust-${Date.now()}`);
  const browser = spawn(
    edgePath,
    [
      '--headless=new',
      '--no-first-run',
      '--window-size=1440,900',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { detached: false, stdio: 'ignore' },
  );

  const cleanupBrowser = () => {
    try {
      browser.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanupBrowser);

  let target = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      const list = await res.json();
      target = list.find((t) => t.type === 'page') ?? null;
      if (target) break;
    } catch {
      /* wait */
    }
    await sleep(300);
  }
  if (!target) {
    bad('CDP 连接建立', 'target page not found');
    cleanupBrowser();
    return;
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/chat*', requestStage: 'Request' },
      { urlPattern: '*/api/telemetry*', requestStage: 'Request' },
    ],
  });

  let interceptChatToFallback = false;
  let failTelemetryCount = 0;

  cdp.setEventHandler(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    const reqUrl = request?.url ?? '';

    if (reqUrl.includes('/api/chat') && interceptChatToFallback) {
      const ndjson = [
        JSON.stringify({
          type: 'reset',
          requestId: 'drill-llm-tier1',
          reason: 'engine-fallback',
          note: '上游大模型暂时不可用，已切换至离线确定性应急引擎（第 1 层降级）。',
        }),
        JSON.stringify({
          type: 'engine',
          engine: 'simulator',
          reason: 'llm-upstream-unavailable',
        }),
        JSON.stringify({
          type: 'text',
          content:
            '【第 1 层降级演练 · 离线应急引擎已接管】检测到上游推理模型不可用，系统已自动切换至基于 SRE 手册的确定性离线应急分析模式，当前结论严格源自集群快照与本地知识库。',
        }),
        JSON.stringify({
          type: 'done',
          requestId: 'drill-llm-tier1',
          engine: 'simulator',
        }),
      ].join('\n');
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/x-ndjson; charset=utf-8' }],
        body: Buffer.from(`${ndjson}\n`, 'utf8').toString('base64'),
      });
      return;
    }

    if (reqUrl.includes('/api/telemetry') && failTelemetryCount > 0) {
      failTelemetryCount -= 1;
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 503,
        responseHeaders: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
        body: Buffer.from('Service Unavailable', 'utf8').toString('base64'),
      });
      return;
    }

    await cdp.send('Fetch.continueRequest', { requestId });
  });

  await cdp.send('Page.navigate', { url: BASE_URL });

  for (let i = 0; i < 90; i += 1) {
    const ready = await cdp.evaluate(
      `document.querySelector('canvas') !== null && typeof window.__KUBEVISION_STORE__ !== 'undefined' && typeof window.__KUBEVISION_TOPOLOGY__ !== 'undefined'`,
    );
    if (ready === true) break;
    await sleep(400);
  }
  await sleep(1800);

  /* ---- Drill 1: LLM 不可用第 1 层降级提示 ---- */
  interceptChatToFallback = true;
  await cdp.evaluate(`(() => {
    window.__KUBEVISION_STORE__.getState().triggerQuickPrompt('演练测试：请汇报当前集群状态与降级模式');
    return true;
  })()`);
  let drill1Text = '';
  for (let i = 0; i < 30; i += 1) {
    drill1Text = await cdp.evaluate(
      `document.querySelector('[aria-label="AI Copilot 抽屉"]')?.textContent || ''`,
    );
    if (drill1Text.includes('第 1 层降级演练')) break;
    await sleep(250);
  }
  interceptChatToFallback = false;
  await saveScreenshot(cdp, 'r13-drill-1-llm-fallback.png');
  if (drill1Text.includes('第 1 层降级演练')) {
    ok('演练 1：LLM 不可用切入第 1 层降级并截图', 'docs/screenshots/r13-drill-1-llm-fallback.png');
  } else {
    bad('演练 1：未观测到第 1 层降级回复', drill1Text.slice(-180));
  }

  /* ---- Drill 2: SSE 断流切换本地合成兜底不卡死 ---- */
  failTelemetryCount = 8;
  await cdp.evaluate(`(() => {
    window.__KUBEVISION_STORE__.getState().setActiveChaos('POD_OOM_SWARM');
    return true;
  })()`);
  await sleep(1800);
  const snap1 = await cdp.evaluate(`(() => {
    const s = window.__KUBEVISION_STORE__.getState().snapshotSummary;
    return { qps: s.totalQps, seq: s.seq, timestamp: s.timestamp };
  })()`);
  await sleep(2000);
  const snap2 = await cdp.evaluate(`(() => {
    const s = window.__KUBEVISION_STORE__.getState().snapshotSummary;
    return { qps: s.totalQps, seq: s.seq, timestamp: s.timestamp };
  })()`);
  await saveScreenshot(cdp, 'r13-drill-2-sse-synthetic.png');
  failTelemetryCount = 0;
  await cdp.evaluate(`(() => {
    window.__KUBEVISION_STORE__.getState().setActiveChaos('NONE');
    return true;
  })()`);

  if (
    typeof snap1?.qps === 'number' &&
    snap1.qps > 0 &&
    typeof snap2?.qps === 'number' &&
    snap2.qps > 0 &&
    snap2.timestamp > snap1.timestamp &&
    snap2.seq > snap1.seq
  ) {
    ok(
      '演练 2：SSE 连续断流切换本地兜底且数据持续推进',
      `qps=${snap1.qps}->${snap2.qps}, seq=${snap1.seq}->${snap2.seq}, tsDelta=${snap2.timestamp - snap1.timestamp}ms · docs/screenshots/r13-drill-2-sse-synthetic.png`,
    );
  } else {
    bad('演练 2：SSE 断流后快照停止推进', { snap1, snap2 });
  }

  /* ---- Drill 3: WebGL 上下文丢失冻结快照 + 恢复条 ---- */
  await cdp.evaluate(`(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    const ev = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(ev);
    return true;
  })()`);
  await sleep(700);
  const drill3State = await cdp.evaluate(`(() => ({
    lost: window.__KUBEVISION_STORE__.getState().isGlContextLost,
    banner: document.body.innerText.includes('图形上下文已丢失'),
  }))()`);
  await saveScreenshot(cdp, 'r13-drill-3-webgl-context-lost.png');
  if (drill3State?.lost === true && drill3State?.banner === true) {
    ok(
      '演练 3：WebGL 上下文丢失展示冻结快照与恢复提示条',
      'docs/screenshots/r13-drill-3-webgl-context-lost.png',
    );
  } else {
    bad('演练 3：WebGL 上下文丢失状态或提示条未生效', drill3State);
  }
  await cdp.evaluate(`(() => {
    const canvas = document.querySelector('canvas');
    if (canvas) canvas.dispatchEvent(new Event('webglcontextrestored'));
    return true;
  })()`);
  await sleep(700);

  /* ---- Drill 4: 3D 画布异常边界捕获自动降级 2D SVG 拓扑 + 选中联动 ---- */
  await cdp.evaluate(`(() => {
    window.__KUBEVISION_TOPOLOGY__.triggerCanvasError('R13_DRILL_4_WEBGL_BOUNDARY');
    return true;
  })()`);
  await sleep(600);

  const clickPodOk = await cdp.evaluate(`(() => {
    const mode = window.__KUBEVISION_TOPOLOGY__.getMode();
    const fallbackEl = document.querySelector('[data-testid="topology-2d-fallback"]');
    const svgEl = document.querySelector('svg[aria-label="2D 集群拓扑降级视图"]');
    const podBtn = Array.from(document.querySelectorAll('[data-testid="topology-2d-fallback"] button'))
      .find((b) => (b.getAttribute('aria-label') || '').startsWith('选择 Pod '));
    if (podBtn) podBtn.click();
    return {
      mode,
      hasFallback: fallbackEl !== null,
      hasSvg: svgEl !== null,
      podLabel: podBtn?.getAttribute('aria-label') || null,
    };
  })()`);
  await sleep(350);
  const selectedAfterClick = await cdp.evaluate(
    `window.__KUBEVISION_STORE__.getState().selectedEntityId`,
  );
  await saveScreenshot(cdp, 'r13-drill-4-topology-2d-fallback.png');

  if (
    clickPodOk?.mode === '2d' &&
    clickPodOk?.hasFallback === true &&
    clickPodOk?.hasSvg === true &&
    typeof selectedAfterClick === 'string' &&
    selectedAfterClick.startsWith('pod-')
  ) {
    ok(
      '演练 4：3D 画布异常边界降级 2D SVG 拓扑且支持 Pod 选中联动',
      `selected=${selectedAfterClick} · docs/screenshots/r13-drill-4-topology-2d-fallback.png`,
    );
  } else {
    bad('演练 4：2D 拓扑降级或选中联动异常', { clickPodOk, selectedAfterClick });
  }

  /* ---- 测试 6：前端异常环形缓冲区（去重 + 上限 + PerfHUD 折叠展示） ---- */
  const bufferVerify = await cdp.evaluate(`(async () => {
    const buf = window.__KUBEVISION_ERROR_BUFFER__;
    if (!buf) return { error: 'buffer bridge missing' };
    buf.clear();
    buf.record({ kind: 'error', message: 'DUPLICATE_风暴', source: 'probe.js:1' });
    buf.record({ kind: 'error', message: 'DUPLICATE_风暴', source: 'probe.js:1' });
    const afterDedup = buf.getRecent(5);
    for (let i = 0; i < 23; i += 1) {
      buf.record({ kind: 'unhandledrejection', message: 'RING_ERR_' + i, source: 'probe:' + i });
    }
    const recent5 = buf.getRecent(5);
    const summaryText = buf.formatSummary(5);

    window.__KUBEVISION_STORE__.getState().setPerfHudOpen(true);
    let toggleBtn = null;
    for (let i = 0; i < 40; i += 1) {
      toggleBtn = document.querySelector('button[aria-label="最近异常诊断"]');
      if (toggleBtn) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (toggleBtn) toggleBtn.click();
    await new Promise((r) => setTimeout(r, 250));
    const errListItems = document.querySelectorAll('[aria-label="异常列表"] li').length;
    const hasCopyBtn = document.querySelector('button[aria-label="复制异常摘要"]') !== null;

    return {
      dedupCount: afterDedup[0]?.count ?? 0,
      recent5Len: recent5.length,
      newestMsg: recent5[0]?.message ?? '',
      hasSummaryHeader: summaryText.includes('最近 5 条异常记录'),
      errListItems,
      hasCopyBtn,
    };
  })()`);

  if (
    bufferVerify?.dedupCount === 2 &&
    bufferVerify?.recent5Len === 5 &&
    bufferVerify?.newestMsg === 'RING_ERR_22' &&
    bufferVerify?.hasSummaryHeader === true &&
    bufferVerify?.errListItems === 5 &&
    bufferVerify?.hasCopyBtn === true
  ) {
    ok(
      '前端异常环形缓冲区（去重/淘汰）与 PerfHUD 最近 5 个异常联动正常',
      `dedup=${bufferVerify.dedupCount}, uiItems=${bufferVerify.errListItems}`,
    );
  } else {
    bad('前端异常缓冲区或 PerfHUD 异常展示异常', bufferVerify);
  }

  await cdp.send('Fetch.disable');
  cdp.close();
  cleanupBrowser();
}

async function runVerifyDemoThrowTest() {
  section('6. `verify-demo.mjs --inject-throw-test` 完整多帧堆栈落盘验证');
  const code = await new Promise((resolve) => {
    const child = spawn(
      'node',
      ['scripts/verify-demo.mjs', '--inject-throw-test', `--base=${BASE_URL}`],
      { cwd: process.cwd(), stdio: 'inherit' },
    );
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code === 0) {
    ok('verify-demo --inject-throw-test 通过（完整堆栈 + page-error.md 落盘）');
  } else {
    bad('verify-demo --inject-throw-test 失败', { exitCode: code });
  }
}

async function main() {
  const server = await ensureServerRunning();
  try {
    await testHealthEndpoint();
    await testSseBudgetHeartbeatLifetimeAndConcurrency();
    await testLiveConcurrency3Tabs();
    await testChatCancelPaths30Runs(server.logs);
    await runBrowserDrillsAndErrorBufferChecks();
    await runVerifyDemoThrowTest();
  } finally {
    if (server.startedHere && server.proc && server.proc.pid) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /PID ${server.proc.pid} /T /F`, { stdio: 'ignore' });
        } else {
          server.proc.kill('SIGKILL');
        }
      } catch {
        /* ignore */
      }
    }
  }

  section('R13 Robustness 总览');
  console.log(`  通过 ${passCount} · 失败 ${failCount}`);
  if (failCount > 0) {
    console.error('\n  失败明细:', JSON.stringify(failures, null, 2));
    process.exit(1);
  }
  console.log('\n  全部 R13 健壮性与工程化防线验证通过 ✓');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[FATAL] R13 Robustness 探针异常:', err);
  process.exit(1);
});
