#!/usr/bin/env node
/**
 * KubeVision AI — R10 进阶：故障注入与端到端可靠性验证套件（scripts/probe-r10-reliability.mjs）
 *
 * 【覆盖矩阵（R10 F1–F5 进阶）】
 *   - F1 双擎中途回落（UI + 真实后端 Socket 中断）：
 *        1) 浏览器端：Engine A 输出残缺正文 + PodMetricsCard 后收到 {type:'reset', reason:'engine-fallback'}，
 *           验证旧正文清空成单一结论、保留且不重复卡片、无 [ ENGINE-FALLBACK ] 文本、TracePanel 不断链；
 *        2) 真实后端：本地 mock OpenAI SSE 输出首段后主动 destroy TCP socket，验证 /api/chat 真实下发
 *           reason='engine-fallback' 的 reset 事件并无缝切到 Engine B 收尾；
 *   - F2 畸形卡片隔离：传入非法类型字段与 memHistory:null 等载荷，验证仅坏卡降级为
 *        「载荷不合法」或「这张卡渲染失败，其余不受影响」，兄弟卡与 3D Canvas 完好，StrictMode 下 0 误杀；
 *   - F3 MCP 执行 15s 超时防重入：拦截 POST /api/mcp/execute 延迟 15s，验证前端 12s 切换至
 *        timeout（「执行超时，结果未知」+「重新查询」），无重试执行按钮，点击「重新查询」不重复 POST；
 *   - F4 UTF-8 跨分片截断流：故意在多字节中文 UTF-8 中间切 chunk 且无 done 提前断流，
 *        验证显示「回答可能不完整」且 Copilot 抽屉 0 个 U+FFFD（）乱码；
 *   - F5 TTFT 量化对比：跑完与 baseline 同套 20 题测量 serverTtftMs / clientFirstTextMs p50 & p95，
 *        对比 .verify-artifacts/phase1-baseline.json，并独立校验无 Key 仿真引擎 TTFT <= 80ms。
 *
 * 【用法】
 *   node scripts/probe-r10-reliability.mjs
 *   node scripts/probe-r10-reliability.mjs --base http://127.0.0.1:3000
 *   node scripts/probe-r10-reliability.mjs --port=3000 --cdp-port=9372 --skip-live-f1
 */

import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT_DIR = join(ROOT, '.verify-artifacts');
const BASELINE_PATH = join(ARTIFACT_DIR, 'phase1-baseline.json');
const REPORT_PATH = join(ARTIFACT_DIR, 'r10-reliability-report.json');

function readArg(flag, fallback = null) {
  const pref = `${flag}=`;
  const inline = process.argv.find((a) => a.startsWith(pref));
  if (inline !== undefined) return inline.slice(pref.length);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

const EXTERNAL_BASE = readArg('--base');
const PORT = Number(readArg('--port', '3000'));
const CDP_PORT = Number(readArg('--cdp-port', '9372'));
const SKIP_LIVE_F1 = process.argv.includes('--skip-live-f1') || Boolean(EXTERNAL_BASE);
const BASE_URL = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(ARTIFACT_DIR, { recursive: true });

let passCount = 0;
let failCount = 0;
const findings = [];

function check(name, cond, actual, expected) {
  if (cond) {
    passCount += 1;
    findings.push({ status: 'PASS', name, actual, expected });
    console.log(`  ✓ ${name}  ::  实际=${JSON.stringify(actual)}`);
  } else {
    failCount += 1;
    findings.push({ status: 'FAIL', name, actual, expected });
    console.log(`  ✗ ${name}  ::  实际=${JSON.stringify(actual)}  期望=${JSON.stringify(expected)}`);
  }
}

function killTree(proc) {
  if (!proc || proc.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {
    /* ignore */
  }
}

async function isUrlReachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUrlReachable(url)) return true;
    await sleep(800);
  }
  return false;
}

function startDevServer(port, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  return spawn('cmd.exe', ['/d', '/s', '/c', 'pnpm', 'dev', '-p', String(port)], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
}

let activeServerProc = null;
let activeBrowserProc = null;
let activeMockHttp = null;

function cleanupAll() {
  killTree(activeBrowserProc);
  activeBrowserProc = null;
  killTree(activeServerProc);
  activeServerProc = null;
  if (activeMockHttp) {
    try { activeMockHttp.close(); } catch {}
    activeMockHttp = null;
  }
}

process.on('exit', cleanupAll);
process.on('SIGINT', () => {
  cleanupAll();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanupAll();
  process.exit(143);
});

/* ---- F5 数据集（与 phase1-baseline.mjs / eval-ai-quality.mjs 完全同源） ---- */
const FAULT_CONTEXT = {
  selectedEntityId: null,
  selectedEntityType: null,
  activeChaos: 'POD_OOM_SWARM',
  clusterHealthScore: 46,
  totalQps: 860,
  faultyPods: [
    {
      id: 'pod-worker-beta-6f9c',
      name: 'worker-beta-6f9c',
      namespace: 'default',
      status: 'OOMKilled',
      cpuUsage: 41.2,
      memoryUsage: 97.4,
      restarts: 6,
      nodeId: 'node-worker-beta',
    },
    {
      id: 'pod-worker-beta-7d1e',
      name: 'worker-beta-7d1e',
      namespace: 'default',
      status: 'CrashLoopBackOff',
      cpuUsage: 12.6,
      memoryUsage: 63.1,
      restarts: 11,
      nodeId: 'node-worker-beta',
    },
  ],
  nodes: [
    { id: 'node-worker-alpha', name: 'worker-alpha', status: 'Ready', cpuUsage: 32.4, memUsage: 48.1, rackIndex: 0 },
    { id: 'node-worker-beta', name: 'worker-beta', status: 'HighLoad', cpuUsage: 91.7, memUsage: 88.3, rackIndex: 1 },
    { id: 'node-worker-gamma', name: 'worker-gamma', status: 'Ready', cpuUsage: 27.9, memUsage: 44.6, rackIndex: 2 },
  ],
};

const STEADY_CONTEXT = {
  selectedEntityId: null,
  selectedEntityType: null,
  activeChaos: 'NONE',
  clusterHealthScore: 100,
  totalQps: 1200,
  faultyPods: [],
  nodes: FAULT_CONTEXT.nodes.map((node) => ({ ...node, status: 'Ready', cpuUsage: 31.5, memUsage: 46.2 })),
};

const QUESTIONS = [
  { id: 'q01', question: 'worker-beta 出现 OOMKilled，根因可能是什么？', context: 'fault' },
  { id: 'q02', question: 'CrashLoopBackOff 应该怎么排查？', context: 'fault' },
  { id: 'q03', question: '节点 CPU 饱和导致调度阻塞，给出处置建议', context: 'fault' },
  { id: 'q04', question: 'NetworkPartition 网络分区如何定位？', context: 'fault' },
  { id: 'q05', question: '容器 DNS 解析失败怎么处理？', context: 'fault' },
  { id: 'q06', question: '镜像拉取失败 ImagePullBackOff 怎么排查？', context: 'fault' },
  { id: 'q07', question: 'Pod 一直 Pending 可能是什么原因？', context: 'fault' },
  { id: 'q08', question: 'etcd 健康度怎么检查？', context: 'steady' },
  { id: 'q09', question: 'APIServer 出现 429 限流怎么处理？', context: 'steady' },
  { id: 'q10', question: 'VXLAN 隧道丢包与 MTU 错配如何诊断？', context: 'fault' },
  { id: 'q11', question: '当前集群整体健康情况怎么样？', context: 'steady' },
  { id: 'q12', question: '稳态下是否需要扩容？', context: 'steady' },
  { id: 'q13', question: '针对当前 OOM 故障，建议执行什么自愈动作？', context: 'fault' },
  { id: 'q14', question: '你现在能做什么？', context: 'steady' },
  { id: 'q15', question: '解释一下 RAG 检索在你的诊断中起什么作用', context: 'steady' },
  { id: 'q16', question: '为什么集群健康分下降了？', context: 'fault' },
  { id: 'q17', question: '如何避免 Pod 再次 OOM？', context: 'fault' },
  { id: 'q18', question: '对节点执行 drain 有什么风险？', context: 'steady' },
  { id: 'q19', question: '怎么验证一次自愈操作是否成功？', context: 'steady' },
  { id: 'q20', question: '给我演示一次完整的故障排查与自愈流程', context: 'fault' },
];

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return Math.round((sorted[base] + rest * (sorted[base + 1] - sorted[base])) * 100) / 100;
  }
  return Math.round(sorted[base] * 100) / 100;
}

function summarizeNumbers(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    n: arr.length,
    min: Math.round(sorted[0] * 100) / 100,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    mean: Math.round((sum / arr.length) * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

async function consumeChatNdjson(baseUrl, question, ctx) {
  const t0 = performance.now();
  let clientFirstTextMs = null;
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: question }],
      clusterContext: ctx,
    }),
    signal: AbortSignal.timeout(90000),
  });
  const headerEngine = res.headers.get('x-kubevision-engine');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'text' && clientFirstTextMs === null) {
          clientFirstTextMs = Math.round((performance.now() - t0) * 100) / 100;
        }
        events.push(ev);
      } catch {
        /* ignore */
      }
    }
  }
  if (buf.trim()) {
    try {
      const ev = JSON.parse(buf.trim());
      if (ev.type === 'text' && clientFirstTextMs === null) {
        clientFirstTextMs = Math.round((performance.now() - t0) * 100) / 100;
      }
      events.push(ev);
    } catch {
      /* ignore */
    }
  }
  const summary = events.find((e) => e.type === 'trace-summary') ?? null;
  const engineEv = [...events].reverse().find((e) => e.type === 'engine') ?? null;
  const textCombined = events.filter((e) => e.type === 'text').map((e) => e.content ?? '').join('');
  return {
    status: res.status,
    headerEngine,
    actualEngine: engineEv?.engine ?? summary?.engine ?? null,
    serverTtftMs: summary?.ttftMs ?? null,
    serverTotalMs: summary?.totalMs ?? null,
    clientFirstTextMs,
    clientTotalMs: Math.round((performance.now() - t0) * 100) / 100,
    reasoningCount: events.filter((e) => e.type === 'reasoning').length,
    textLen: textCombined.length,
    textCombined,
    events,
  };
}

async function launchCdpSession() {
  const edgePath = EDGE_PATHS.find((p) => existsSync(p));
  if (!edgePath) throw new Error('未找到可用 Edge / Chrome 浏览器');

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-r10-rel-${Date.now()}`);
  activeBrowserProc = spawn(edgePath, [
    '--headless=new',
    '--no-first-run',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1680,1000',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
      target = list.find((t) => t.type === 'page') ?? null;
      if (target) break;
    } catch {
      /* wait */
    }
    await sleep(400);
  }
  if (!target) throw new Error('Edge CDP page target 未就绪');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(msg.params?.exceptionDetails?.text ?? 'exception').slice(0, 300));
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  };

  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    const t = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`CDP timeout: ${method}`));
    }, 30000);
    pending.set(id, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });

  return { ws, send, ev, consoleErrors, pageErrors };
}

async function sendPrompt(cdp, text) {
  return cdp.ev(`(() => {
    const ta = document.querySelector('textarea[aria-label="对话输入框"]');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
}

async function waitIdle(cdp, maxWaitMs = 20000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(120);
    const streaming = await cdp.ev(`window.__KUBEVISION_STORE__.getState().copilotStreaming`);
    if (streaming === false) return true;
  }
  return false;
}

async function clearSession(cdp) {
  await cdp.ev(`(() => {
    const btn = document.querySelector('button[aria-label="清空会话"]');
    if (btn && !btn.disabled) btn.click();
    return true;
  })()`);
  await sleep(250);
}

async function runBrowserFaultSuite(cdp) {
  await cdp.send('Page.navigate', { url: BASE_URL });
  for (let i = 0; i < 240; i += 1) {
    const ready = await cdp.ev(`Boolean(window.__KUBEVISION_STORE__ && document.querySelector('[aria-label="AI Copilot 抽屉"]') && document.querySelector('textarea[aria-label="对话输入框"]'))`);
    if (ready === true) break;
    await sleep(500);
  }
  await sleep(2500);

  await cdp.ev(`(() => {
    window.__KUBEVISION_STORE__.getState().setActiveRightTab('copilot');
    const origFetch = window.fetch;
    let scenario = 'f1';
    const counters = { postExecCalls: 0, getQueryCalls: 0 };
    window.__SET_R10_FAULT__ = (s) => { scenario = s; };
    window.__R10_COUNTERS__ = counters;

    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = ((init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();

      if (url.indexOf('/api/mcp/execute') !== -1 && scenario === 'f3') {
        if (method === 'GET') {
          counters.getQueryCalls += 1;
          return Promise.resolve(new Response(JSON.stringify({
            jsonrpc: '2.0',
            result: {
              found: true,
              status: 'succeeded',
              updatedAt: Date.now(),
              receipt: {
                executionId: 'exec-f3-probe',
                timestamp: new Date().toISOString(),
                toolUri: 'mcp://k8s-cluster/tools/restart_pod',
                actionType: 'restart_pod',
                targetId: 'pod-payment-gateway-7f8b9-x2k',
                targetName: 'payment-gateway-7f8b9-x2k',
                kubectlCommand: 'kubectl delete pod/payment-gateway-7f8b9-x2k -n production --wait=false',
                latencyMs: 120,
                auditDigest: '0'.repeat(64),
                mode: 'simulated',
                note: '已在模拟集群回执确认 (clusterMode=demo, namespace=production)',
              },
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        counters.postExecCalls += 1;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            resolve(new Response(JSON.stringify({
              jsonrpc: '2.0',
              result: { ok: true, status: 'succeeded', note: 'clusterMode=demo, namespace=default' },
            }), { status: 200, headers: { 'content-type': 'application/json' } }));
          }, 15000);
          if (init && init.signal) {
            if (init.signal.aborted) {
              clearTimeout(t);
              reject(new DOMException('Aborted', 'AbortError'));
              return;
            }
            init.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new DOMException('The operation was aborted', 'AbortError'));
            }, { once: true });
          }
        });
      }

      if (url.indexOf('/api/chat') === -1) {
        return origFetch.call(window, input, init);
      }

      const enc = new TextEncoder();
      const makeStream = (fn) => new ReadableStream({
        async start(controller) {
          const pushObj = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + '\\n'));
          await fn(pushObj, controller);
          try { controller.close(); } catch {}
        }
      });

      if (scenario === 'f1') {
        const stream = makeStream(async (pushObj) => {
          pushObj({ type: 'reset', requestId: 'req-f1', reason: 'new-round' });
          pushObj({ type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: '识别故障诊断意图', detail: 'Engine A 启动', latencyMs: 12 } });
          pushObj({ type: 'engine', engine: 'llm', reason: 'mock-engine-a' });
          pushObj({ type: 'text', content: '【Engine A 残缺误判片段】正在分析集群上下文……' });
          pushObj({ type: 'tool-start', toolCallId: 'f1-pod-1', toolName: 'renderPodMetrics', mcpUri: 'mcp://k8s-cluster/tools/renderPodMetrics' });
          pushObj({ type: 'tool-result', toolCallId: 'f1-pod-1', toolName: 'renderPodMetrics', args: {
            podId: 'pod-worker-beta-6f9c', podName: 'worker-beta-6f9c', namespace: 'default',
            cpuUsage: 41.2, memoryUsage: 97.4, restarts: 6,
            cpuHistory: [31, 34, 38, 40, 41, 41.2], memHistory: [84, 88, 91, 94, 96, 97.4],
          }});
          await new Promise((r) => setTimeout(r, 80));
          /* 模拟 Engine A 中途报错触发结构化 reset 回落 */
          pushObj({ type: 'reset', requestId: 'req-f1', reason: 'engine-fallback', note: '远程模型中断，以下由本地容灾引擎重新生成' });
          pushObj({ type: 'engine', engine: 'simulator', reason: 'engine-a-midstream-fallback' });
          pushObj({ type: 'reasoning', step: { stepIndex: 1, phase: 'HYPOTHESIS_GENERATION', title: '切换本地容灾推理引擎', detail: '保留已产出指标卡并生成根因结论', latencyMs: 20 } });
          pushObj({ type: 'tool-start', toolCallId: 'f1-rca-1', toolName: 'renderRootCauseAnalysis', mcpUri: 'mcp://k8s-cluster/tools/renderRootCauseAnalysis' });
          pushObj({ type: 'tool-result', toolCallId: 'f1-rca-1', toolName: 'renderRootCauseAnalysis', args: {
            severity: 'P0',
            title: 'worker-beta-6f9c 容器内存触顶触发 OOMKilled',
            confidence: 0.92,
            rootCauseSummary: '订单缓冲队列未限流导致容器 RSS 触及 memory.max 上限，触发内核 OOM Killer（Exit Code 137）。',
            evidenceChain: ['Exit Code 137', '重启次数达 6 次', 'RUNBOOK-K8S-042 命中内存泄漏处置条款'],
            impactScope: 'default 命名空间 worker-beta 节点订单处理链路',
            ragReferences: [{
              id: 'RUNBOOK-K8S-042',
              title: 'Kubernetes Pod OOMKilled 根因定位',
              category: 'oom',
              tags: ['OOMKilled', 'memory.max'],
              symptom: '容器内存触及 cgroup memory.max 上限后被内核强制终止',
              remediationSteps: ['安全滚动重启受损 Pod 并释放泄漏内存', '核查订单缓冲队列内存上限配置'],
              similarityScore: 0.92,
              featureVocabulary: ['oom', 'memory', 'worker-beta'],
              rootCauseMechanism: '无界缓存队列持续占用匿名页内存触发 Exit Code 137',
            }],
          }});
          pushObj({ type: 'tool-start', toolCallId: 'f1-act-1', toolName: 'proposeRemediationAction', mcpUri: 'mcp://k8s-cluster/tools/proposeRemediationAction' });
          pushObj({ type: 'tool-result', toolCallId: 'f1-act-1', toolName: 'proposeRemediationAction', args: {
            actionType: 'restart_pod',
            targetId: 'pod-worker-beta-6f9c',
            targetName: 'worker-beta-6f9c',
            paramDescription: '安全滚动重启 worker-beta-6f9c（namespace: default）释放泄漏内存，等效：kubectl delete pod worker-beta-6f9c -n default',
            mcpEndpoint: 'mcp://k8s-cluster/tools/restartPod',
            isHighRisk: false,
          }});
          pushObj({ type: 'text', content: '- **结论**：\`worker-beta-6f9c\` 触发 \`OOMKilled\`。\\n\\n建议动作：点击下方自愈确认卡片重启异常 Pod。' });
          pushObj({ type: 'trace-summary', traceId: 'tr-f1-fallback', engine: 'simulator', ttftMs: 42, totalMs: 320 });
          pushObj({ type: 'done', requestId: 'req-f1', engine: 'simulator' });
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }));
      }

      if (scenario === 'f2') {
        const events = [
          { type: 'reset', requestId: 'req-f2', reason: 'new-round' },
          { type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: '恶意卡片载荷隔离校验', detail: 'F2', latencyMs: 10 } },
          { type: 'engine', engine: 'simulator', reason: 'f2-malformed' },
          { type: 'tool-start', toolCallId: 'f2-good-pod', toolName: 'renderPodMetrics', mcpUri: 'mcp://k8s-cluster/tools/renderPodMetrics' },
          { type: 'tool-result', toolCallId: 'f2-good-pod', toolName: 'renderPodMetrics', args: {
            podId: 'pod-worker-beta-6f9c', podName: 'worker-beta-6f9c', namespace: 'default',
            cpuUsage: 41.2, memoryUsage: 97.4, restarts: 6,
            cpuHistory: [31, 34, 38, 40, 41, 41.2], memHistory: [84, 88, 91, 94, 96, 97.4],
          }},
          { type: 'tool-start', toolCallId: 'f2-bad-pod', toolName: 'renderPodMetrics', mcpUri: 'mcp://k8s-cluster/tools/renderPodMetrics' },
          { type: 'tool-result', toolCallId: 'f2-bad-pod', toolName: 'renderPodMetrics', args: {
            podId: 'pod-corrupt-1', podName: 'corrupt-pod', cpuUsage: 'bad-nan', memHistory: null, restarts: 'nope',
          }},
          { type: 'tool-start', toolCallId: 'f2-bad-rca', toolName: 'renderRootCauseAnalysis', mcpUri: 'mcp://k8s-cluster/tools/renderRootCauseAnalysis' },
          { type: 'tool-result', toolCallId: 'f2-bad-rca', toolName: 'renderRootCauseAnalysis', args: {
            title: 12345, confidence: 'invalid-score', symptoms: 'not-array', runbooks: null,
          }},
          { type: 'tool-start', toolCallId: 'f2-good-act', toolName: 'proposeRemediationAction', mcpUri: 'mcp://k8s-cluster/tools/proposeRemediationAction' },
          { type: 'tool-result', toolCallId: 'f2-good-act', toolName: 'proposeRemediationAction', args: {
            actionType: 'restart_pod',
            targetId: 'pod-worker-beta-6f9c',
            targetName: 'worker-beta-6f9c',
            paramDescription: '恢复健康水位（namespace: default）：kubectl delete pod worker-beta-6f9c -n default',
            mcpEndpoint: 'mcp://k8s-cluster/tools/restartPod',
            isHighRisk: false,
          }},
          { type: 'text', content: '- **结论**：坏卡片已局部隔离降级，正常卡片继续工作。\\n\\n建议动作：核查并保留有效自愈建议。' },
          { type: 'done', requestId: 'req-f2', engine: 'simulator' },
        ];
        return Promise.resolve(new Response(events.map((e) => JSON.stringify(e)).join('\\n') + '\\n', {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        }));
      }

      if (scenario === 'f3') {
        const events = [
          { type: 'reset', requestId: 'req-f3', reason: 'new-round' },
          { type: 'reasoning', step: { stepIndex: 0, phase: 'ACTION_CONFIRMATION', title: '准备自愈卡片以验证 12s 超时', detail: 'F3', latencyMs: 10 } },
          { type: 'engine', engine: 'simulator', reason: 'f3-timeout' },
          { type: 'tool-start', toolCallId: 'f3-act-1', toolName: 'proposeRemediationAction', mcpUri: 'mcp://k8s-cluster/tools/proposeRemediationAction' },
          { type: 'tool-result', toolCallId: 'f3-act-1', toolName: 'proposeRemediationAction', args: {
            actionType: 'restart_pod',
            targetId: 'pod-payment-gateway-7f8b9-x2k',
            targetName: 'payment-gateway-7f8b9-x2k',
            paramDescription: '验证 12s 执行超时保护机制（namespace: production）：kubectl delete pod/payment-gateway-7f8b9-x2k -n production --wait=false',
            mcpEndpoint: 'mcp://k8s-cluster/tools/restartPod',
            isHighRisk: false,
          }},
          { type: 'text', content: '- **结论**：等待执行自愈操作并验证 12 秒超时隔离。\\n\\n建议动作：点击执行并观察超时状态切换。' },
          { type: 'done', requestId: 'req-f3', engine: 'simulator' },
        ];
        return Promise.resolve(new Response(events.map((e) => JSON.stringify(e)).join('\\n') + '\\n', {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        }));
      }

      if (scenario === 'f4') {
        const stream = new ReadableStream({
          async start(controller) {
            const head = [
              { type: 'reset', requestId: 'req-f4', reason: 'new-round' },
              { type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: '检验中文多字节断流恢复', detail: 'F4', latencyMs: 8 } },
              { type: 'engine', engine: 'simulator', reason: 'f4-truncated' },
            ].map((e) => JSON.stringify(e)).join('\\n') + '\\n';
            controller.enqueue(enc.encode(head));

            const utfLineBytes = enc.encode(JSON.stringify({ type: 'text', content: '根因诊断完整：内核触发 OOMKilled 机制正在输出' }) + '\\n');
            /* 故意在中文 3 字节 UTF-8 字符内部切分分片 */
            let splitAt = Math.floor(utfLineBytes.length * 0.55);
            while (splitAt < utfLineBytes.length - 1 && (utfLineBytes[splitAt] & 0xc0) !== 0x80) {
              splitAt += 1;
            }
            controller.enqueue(utfLineBytes.slice(0, splitAt));
            await new Promise((r) => setTimeout(r, 70));
            controller.enqueue(utfLineBytes.slice(splitAt));
            await new Promise((r) => setTimeout(r, 70));
            /* 末尾塞入截断半行且不发出 done 直接关闭 */
            controller.enqueue(enc.encode('{"type":"text","content":"半截未换行'));
            controller.close();
          }
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }));
      }

      return origFetch.call(window, input, init);
    };
    return true;
  })()`);

  /* ---- F1-Browser ---- */
  console.log('\n[F1-Browser] Engine A 中途 reset(engine-fallback) 单一结论与卡片去重保留');
  await clearSession(cdp);
  await cdp.ev(`window.__SET_R10_FAULT__('f1')`);
  await sendPrompt(cdp, 'F1 测试：Engine A 中途故障切引擎');
  await waitIdle(cdp, 15000);
  await sleep(250);
  const f1Ui = await cdp.ev(`(() => {
    const assistants = document.querySelectorAll('[data-copilot-msg="assistant"]');
    const last = assistants[assistants.length - 1];
    const htmlText = last ? (last.textContent || '') : '';
    const drawerText = document.querySelector('[aria-label="AI Copilot 抽屉"]')?.textContent || '';
    return {
      leakedPreReset: htmlText.includes('Engine A 残缺误判片段'),
      hasSingleConclusion: htmlText.includes('触发 OOMKilled') && htmlText.includes('建议动作：'),
      hasResetBanner: htmlText.includes('容灾引擎') || htmlText.includes('远程模型中断'),
      noBracketFallbackTag: !drawerText.includes('[ ENGINE-FALLBACK ]'),
      podCards: last ? last.querySelectorAll('[aria-label^="Pod 指标卡"]').length : 0,
      rcaCards: last ? last.querySelectorAll('[aria-label^="根因分析"]').length : 0,
      actionCards: last ? last.querySelectorAll('[aria-label^="自愈操作确认"]').length : 0,
      skeletons: last ? last.querySelectorAll('[aria-label="AI 正在调用工具"], [data-card-state="skeleton"]').length : 0,
      traceVisible: Boolean(document.querySelector('[role="region"][aria-label="请求链路追踪"]')),
    };
  })()`);
  check('F1a 清空 Engine A 残缺正文仅留单一结论 + 容灾横幅', !f1Ui.leakedPreReset && f1Ui.hasSingleConclusion && f1Ui.hasResetBanner && f1Ui.noBracketFallbackTag, f1Ui, 'clean single conclusion & banner');
  check('F1b 保留 reset 前 PodMetricsCard 且 3 张卡片零重复/0 骨架遗留 + Trace 完整', f1Ui.podCards === 1 && f1Ui.rcaCards === 1 && f1Ui.actionCards === 1 && f1Ui.skeletons === 0 && f1Ui.traceVisible, f1Ui, '1/1/1 & 0 skeletons');

  /* ---- F2 ---- */
  console.log('\n[F2] 畸形与空字段卡片局部隔离 + 3D Canvas 完好 + StrictMode 零误杀');
  await clearSession(cdp);
  await cdp.ev(`window.__SET_R10_FAULT__('f2')`);
  await sendPrompt(cdp, 'F2 测试：畸形卡片隔离');
  await waitIdle(cdp, 10000);
  await sleep(250);
  const f2Ui = await cdp.ev(`(() => {
    const last = Array.from(document.querySelectorAll('[data-copilot-msg="assistant"]')).slice(-1)[0];
    const txt = last ? (last.textContent || '') : '';
    const canvas = document.querySelector('canvas');
    const cr = canvas ? canvas.getBoundingClientRect() : null;
    const badMarkers = (txt.match(/载荷不合法|这张卡渲染失败，其余不受影响/g) || []).length;
    return {
      badMarkers,
      goodPodCards: last ? last.querySelectorAll('[aria-label^="Pod 指标卡"]').length : 0,
      goodActionCards: last ? last.querySelectorAll('[aria-label^="自愈操作确认"]').length : 0,
      canvasAlive: Boolean(cr && cr.width > 0 && cr.height > 0),
    };
  })()`);
  check('F2 仅坏卡降级提示（载荷不合法 / ErrorBoundary）且好卡与 3D Canvas 完好', f2Ui.badMarkers >= 2 && f2Ui.goodPodCards === 1 && f2Ui.goodActionCards === 1 && f2Ui.canvasAlive, f2Ui, 'badMarkers>=2 & goodPod=1 & goodAction=1 & canvasAlive');

  /* ---- F3 ---- */
  console.log('\n[F3] MCP 执行 15s 延迟触发 12s 超时态（执行超时，结果未知 + 重新查询，禁自动重执行）');
  await clearSession(cdp);
  await cdp.ev(`window.__SET_R10_FAULT__('f3')`);
  await sendPrompt(cdp, 'F3 测试：MCP 执行 12s 超时隔离');
  await waitIdle(cdp, 10000);
  await sleep(250);

  const f3Start = Date.now();
  const clickedExec = await cdp.ev(`(() => {
    const card = document.querySelector('[aria-label^="自愈操作确认"]');
    if (!card) return false;
    const cb = card.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) cb.click();
    const btns = Array.from(card.querySelectorAll('button'));
    const execBtn = btns[btns.length - 1];
    if (!execBtn || execBtn.disabled) return false;
    execBtn.click();
    return true;
  })()`);

  let timeoutObserved = null;
  let timeoutElapsedMs = null;
  for (let i = 0; i < 64; i += 1) {
    await sleep(250);
    const cardState = await cdp.ev(`(() => {
      const card = document.querySelector('[aria-label^="自愈操作确认"]');
      const txt = card ? (card.textContent || '') : '';
      const btnTexts = card ? Array.from(card.querySelectorAll('button')).map((b) => (b.textContent || '').trim()) : [];
      return {
        hasTimeoutNotice: txt.includes('执行超时，结果未知'),
        hasRequeryBtn: btnTexts.some((t) => t.includes('重新查询')),
        hasRetryExecBtn: btnTexts.some((t) => t.includes('立即执行自愈方案') || t.includes('重试执行') || t.includes('重新执行')),
        btnTexts,
      };
    })()`);
    if (cardState.hasTimeoutNotice && cardState.hasRequeryBtn) {
      timeoutObserved = cardState;
      timeoutElapsedMs = Date.now() - f3Start;
      break;
    }
  }

  let afterRequery = null;
  if (timeoutObserved) {
    await cdp.ev(`(() => {
      const card = document.querySelector('[aria-label^="自愈操作确认"]');
      const btn = card ? Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').includes('重新查询')) : null;
      if (btn) btn.click();
      return Boolean(btn);
    })()`);
    await sleep(600);
    afterRequery = await cdp.ev(`window.__R10_COUNTERS__`);
  }

  check('F3a 15s 延迟下在 ~12s 进入 timeout 态并禁止重放执行按钮', clickedExec && timeoutObserved !== null && timeoutElapsedMs >= 9500 && timeoutElapsedMs <= 14000 && !timeoutObserved.hasRetryExecBtn, { clickedExec, timeoutElapsedMs, timeoutObserved }, '9500..14000ms & timeout & no retry-exec');
  check('F3b 点击「重新查询」仅做只读查询、未再次 POST /api/mcp/execute', Boolean(afterRequery && afterRequery.postExecCalls === 1 && afterRequery.getQueryCalls >= 1), afterRequery, 'postExecCalls=1 & getQueryCalls>=1');

  /* ---- F4 ---- */
  console.log('\n[F4] UTF-8 半汉字跨分片 + 无 done 截断流（回答可能不完整 + 0 乱码）');
  await clearSession(cdp);
  await cdp.ev(`window.__SET_R10_FAULT__('f4')`);
  await sendPrompt(cdp, 'F4 测试：中文 UTF-8 跨分片截断');
  await waitIdle(cdp, 10000);
  await sleep(250);
  const f4Ui = await cdp.ev(`(() => {
    const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
    const last = Array.from(document.querySelectorAll('[data-copilot-msg="assistant"]')).slice(-1)[0];
    const drawerText = drawer ? (drawer.textContent || '') : '';
    const lastText = last ? (last.textContent || '') : '';
    return {
      hasChineseBody: lastText.includes('根因诊断完整：内核触发 OOMKilled 机制正在输出'),
      hasIncompleteHint: lastText.includes('回答可能不完整'),
      hasRegenerateBtn: lastText.includes('重新生成'),
      replacementCharCount: (drawerText.match(/\\uFFFD/g) || []).length,
    };
  })()`);
  check('F4 显示「回答可能不完整」且全抽屉 U+FFFD 乱码数为 0', f4Ui.hasChineseBody && f4Ui.hasIncompleteHint && f4Ui.hasRegenerateBtn && f4Ui.replacementCharCount === 0, f4Ui, 'incomplete & 0 U+FFFD');

  check('浏览器套全部完成且 0 pageError / 0 consoleError', cdp.pageErrors.length === 0 && cdp.consoleErrors.length === 0, { pageErrors: cdp.pageErrors, consoleErrors: cdp.consoleErrors }, 'empty');

  return { f1Ui, f2Ui, f3: { timeoutElapsedMs, timeoutObserved, afterRequery }, f4Ui };
}

async function runLiveF1AndSimulatorTtft() {
  /* 启动本地 mock OpenAI SSE 服务器（发出首段后立刻 destroy TCP socket，模拟 Engine A 中途中断） */
  let mockHits = 0;
  await new Promise((resolve) => {
    activeMockHttp = createServer((req, res) => {
      mockHits += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        const chunk1 = JSON.stringify({
          id: 'chatcmpl-f1-probe',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'probe-fault-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ENGINE_A_PARTIAL_SHOULD_RESET ' }, finish_reason: null }],
        });
        res.write(`data: ${chunk1}\n\n`);
        setTimeout(() => {
          try { req.socket.destroy(); } catch {}
        }, 70);
      });
    });
    activeMockHttp.listen(0, '127.0.0.1', resolve);
  });
  const addr = activeMockHttp.address();
  const mockPort = typeof addr === 'object' && addr ? addr.port : 0;

  console.log(`\n[F1-Server] 启动独立容灾测试服务 (mock OpenAI :${mockPort} -> Next dev :${PORT})...`);
  activeServerProc = startDevServer(PORT, {
    OPENAI_API_KEY: 'sk-probe-f1-socket-drop',
    OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    AI_MODEL_NAME: 'probe-fault-model',
    AI_MAX_RETRIES: '0',
  });
  const up = await waitForServer(BASE_URL, 120000);
  if (!up) throw new Error('F1-Server 启动超时');

  const f1Res = await consumeChatNdjson(BASE_URL, 'worker-beta OOMKilled 怎么排查与自愈？', FAULT_CONTEXT);
  const events = f1Res.events;
  const resetIdx = events.findIndex((e) => e.type === 'reset' && e.reason === 'engine-fallback');
  const postResetEngine = resetIdx >= 0 ? events.slice(resetIdx).find((e) => e.type === 'engine') : null;
  const postResetCards = resetIdx >= 0 ? events.slice(resetIdx).filter((e) => e.type === 'tool-result').map((e) => e.toolName) : [];
  const hasDone = events.some((e) => e.type === 'done');
  const hasLegacyBracketText = f1Res.textCombined.includes('[ ENGINE-FALLBACK ]');

  check('F1-Server 真实 Upstream Socket 中断触发 reset(engine-fallback) 并切至 Engine B', mockHits >= 1 && resetIdx >= 0 && postResetEngine?.engine === 'simulator' && hasDone && !hasLegacyBracketText, {
    mockHits,
    resetIdx,
    postResetEngine,
    postResetCards,
    hasDone,
    hasLegacyBracketText,
  }, 'reset(engine-fallback) -> simulator -> done');

  killTree(activeServerProc);
  activeServerProc = null;
  activeMockHttp.close();
  activeMockHttp = null;
  await sleep(1000);

  /* F5b: 无 Key 纯仿真器 TTFT <= 80ms 验证 */
  console.log(`\n[F5b] 启动无 Key 纯 Simulator TTFT 测试服务 (:${PORT})...`);
  activeServerProc = startDevServer(PORT, {
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: '',
  });
  const upSim = await waitForServer(BASE_URL, 120000);
  if (!upSim) throw new Error('F5b Simulator 服务启动超时');

  const simRuns = [];
  for (let i = 0; i < 5; i += 1) {
    const q = QUESTIONS[i];
    const r = await consumeChatNdjson(BASE_URL, q.question, FAULT_CONTEXT);
    simRuns.push({
      id: q.id,
      engine: r.actualEngine,
      serverTtftMs: r.serverTtftMs,
      clientFirstTextMs: r.clientFirstTextMs,
      reasoningCount: r.reasoningCount,
    });
  }
  const simTtftStats = summarizeNumbers(simRuns.map((r) => r.serverTtftMs).filter((v) => typeof v === 'number'));
  const simReasoningMin = Math.min(...simRuns.map((r) => r.reasoningCount));
  check('F5b Simulator 引擎 TTFT <= 80ms 且推理步数 >= 3', Boolean(simTtftStats && simTtftStats.p95 <= 80 && simReasoningMin >= 3), { simTtftStats, simReasoningMin }, 'p95<=80ms & reasoning>=3');

  killTree(activeServerProc);
  activeServerProc = null;
  await sleep(800);

  return { f1Server: { mockHits, resetIdx, postResetEngine, postResetCards, hasDone }, simRuns, simTtftStats };
}

async function main() {
  console.log(`[R10 Probe] 启动 R10 F1–F5 可靠性与 TTFT 验证套件 (target=${BASE_URL})`);

  if (!EXTERNAL_BASE) {
    if (await isUrlReachable(BASE_URL)) {
      throw new Error(`端口 ${PORT} 已被占用，请先清理旧服务或传入 --base`);
    }
    console.log(`[R10 Probe] 启动主 Next dev server (port=${PORT})...`);
    activeServerProc = startDevServer(PORT);
    const ready = await waitForServer(BASE_URL, 120000);
    if (!ready) throw new Error('主 dev server 启动超时 (120s)');
  }

  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    browserFaults: null,
    f5LiveTtft: null,
    liveBackendFaults: null,
  };

  try {
    const cdp = await launchCdpSession();
    try {
      report.browserFaults = await runBrowserFaultSuite(cdp);
    } finally {
      try { cdp.ws.close(); } catch {}
      killTree(activeBrowserProc);
      activeBrowserProc = null;
    }

    /* ---- F5: 20 题真实 /api/chat TTFT 对比 Phase 1 基线 ---- */
    console.log('\n[F5] 运行 20 题 TTFT 实测并对比 Phase 1 基线...');
    const rows = [];
    for (let i = 0; i < QUESTIONS.length; i += 1) {
      const q = QUESTIONS[i];
      const ctx = q.context === 'fault' ? FAULT_CONTEXT : STEADY_CONTEXT;
      const r = await consumeChatNdjson(BASE_URL, q.question, ctx);
      const cleanText = r.textCombined.trim();
      const endsWithSuggested = cleanText.includes('建议动作：');
      const hasAiDisclaimer = /作为\s*AI|作为一个人工智能|我无法确定/i.test(cleanText);
      rows.push({
        id: q.id,
        status: r.status,
        engine: r.actualEngine,
        serverTtftMs: r.serverTtftMs,
        clientFirstTextMs: r.clientFirstTextMs,
        serverTotalMs: r.serverTotalMs,
        reasoningCount: r.reasoningCount,
        textLen: r.textLen,
        endsWithSuggested,
        hasAiDisclaimer,
      });
      console.log(`  [${i + 1}/20] ${q.id} engine=${r.actualEngine} serverTtft=${r.serverTtftMs}ms reasoning=${r.reasoningCount} len=${r.textLen}`);
    }

    const serverTtftStats = summarizeNumbers(rows.map((r) => r.serverTtftMs).filter((v) => typeof v === 'number'));
    const clientTtftStats = summarizeNumbers(rows.map((r) => r.clientFirstTextMs).filter((v) => typeof v === 'number'));
    const minReasoning = Math.min(...rows.map((r) => r.reasoningCount));
    const all200 = rows.every((r) => r.status === 200);
    const disclaimerCount = rows.filter((r) => r.hasAiDisclaimer).length;
    const suggestedActionCount = rows.filter((r) => r.endsWithSuggested).length;

    let baselineComparison = null;
    if (existsSync(BASELINE_PATH)) {
      const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
      const baseServer = base?.r10TtftBaseline?.serverTtftMs ?? null;
      if (baseServer && serverTtftStats) {
        baselineComparison = {
          baselineP50Ms: baseServer.p50,
          postP50Ms: serverTtftStats.p50,
          deltaP50Ms: Math.round((baseServer.p50 - serverTtftStats.p50) * 100) / 100,
          baselineP95Ms: baseServer.p95,
          postP95Ms: serverTtftStats.p95,
          deltaP95Ms: Math.round((baseServer.p95 - serverTtftStats.p95) * 100) / 100,
        };
      }
    }

    report.f5LiveTtft = { serverTtftStats, clientTtftStats, minReasoning, disclaimerCount, suggestedActionCount, baselineComparison, rows };
    check('F5a 20 题全量 HTTP 200 且每题推理链 >= 3 步', all200 && minReasoning >= 3, { all200, minReasoning }, '200 & reasoning>=3');
    check('F5c 20 题无“作为 AI”免责声明且含“建议动作：”结尾指引', disclaimerCount === 0 && suggestedActionCount === rows.length, { disclaimerCount, suggestedActionCount, total: rows.length }, '0 disclaimers & 20/20 action');
    if (baselineComparison) {
      check('F5d TTFT 较 Phase 1 基线大幅下降 (Δp50 >= 900ms, Δp95 >= 1000ms)', baselineComparison.deltaP50Ms >= 900 && baselineComparison.deltaP95Ms >= 1000, baselineComparison, 'Δp50>=900ms & Δp95>=1000ms');
    }

    if (!EXTERNAL_BASE) {
      killTree(activeServerProc);
      activeServerProc = null;
      await sleep(1000);
    }

    if (!SKIP_LIVE_F1) {
      report.liveBackendFaults = await runLiveF1AndSimulatorTtft();
    }

    writeFileSync(REPORT_PATH, `${JSON.stringify({ ...report, passed: passCount, failed: failCount, findings }, null, 2)}\n`, 'utf8');
    console.log(`\n[R10 Probe] 总结：PASS ${passCount} · FAIL ${failCount} -> ${REPORT_PATH}`);
    process.exitCode = failCount === 0 ? 0 : 1;
  } finally {
    cleanupAll();
  }
}

main().catch((err) => {
  console.error('[R10 Probe] 致命错误:', err);
  cleanupAll();
  process.exit(1);
});
