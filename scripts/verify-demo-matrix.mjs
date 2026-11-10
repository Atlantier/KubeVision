#!/usr/bin/env node
/**
 * KubeVision AI — 三场景路演事实矩阵（scripts/verify-demo-matrix.mjs）
 *
 * 【它回答什么问题】单场景通过不代表三个故障域都自洽。本脚本把
 * POD_OOM_SWARM / NET_PACKET_LOSS / NODE_CPU_SPIKE 三个场景各跑一遍完整路演，
 * 输出一张矩阵，逐列对齐：
 *
 *   剧本 | 场景 | 期望节点(由 rackIndex 派生) | 实际 HUD 选中节点 |
 *   受害数 | AI 正文宿主节点 | MCP actionType | healedPodIds 命中数
 *
 * 任一"应该相等"的列不相等，即判定该场景未完成。
 *
 * 【期望值从哪来】脚本内自带 rackIndex→场景 的期望表（镜像
 * syntheticEngine 的 OOM/SPIKE/PARTITION 常量）。**刻意不 import
 * chaosTargets**：测试必须独立表达期望，否则就变成"拿实现验证实现"。
 *
 * 【为什么必须 dev 构建】读取 window.__KUBEVISION_STORE__；生产构建下
 * 调试钩子按设计被剔除，脚本明确报错退出而不是静默通过。
 *
 * 【用法】
 *   node scripts/verify-demo-matrix.mjs
 *   node scripts/verify-demo-matrix.mjs --only oom-autofix
 *   node scripts/verify-demo-matrix.mjs --base http://127.0.0.1:3000
 *
 * 【退出码】0 = 全场景一致；1 = 存在不一致；2 = 环境不可用
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const baseUrl = readArg('--base') ?? 'http://127.0.0.1:3000';
const onlyScript = readArg('--only');
const CDP_PORT = 9342;

/** 剧本 → 场景 → 期望 rackIndex（镜像 syntheticEngine 的常量） */
const CASES = [
  { script: 'oom-autofix', label: 'OOM 全链路自愈', scenario: 'POD_OOM_SWARM', rackIndex: 1 },
  { script: 'network-latency-trace', label: 'CNI 网络延迟追踪', scenario: 'NET_PACKET_LOSS', rackIndex: 2 },
  { script: 'cpu-spike-autofix', label: '节点 CPU 尖刺扩缩容', scenario: 'NODE_CPU_SPIKE', rackIndex: 0 },
];

/** 场景 → 期望动作（镜像 chaosFacts 的映射） */
const EXPECTED_ACTION = {
  POD_OOM_SWARM: 'restart_pod',
  NODE_CPU_SPIKE: 'scale_deployment',
  NET_PACKET_LOSS: 'drain_node',
};

function readArg(flag) {
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/* CDP                                                                         */
/* ========================================================================== */

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push(String((msg.params.args ?? [])[0]?.value ?? '').slice(0, 160));
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`CDP 超时: ${method}`)), 30000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close(), consoleErrors };
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const d = res.result?.exceptionDetails;
  if (d !== undefined) {
    return { __err: String(d.exception?.description ?? d.text ?? 'unknown') };
  }
  return res.result?.result?.value;
}

/* ========================================================================== */
/* 页面探针                                                                    */
/* ========================================================================== */

/** 阶段 2 时点：HUD 选中 + 受害数（从导演日志解析，单一口径） */
const READ_PHASE2 = `(() => {
  const store = window.__KUBEVISION_STORE__;
  if (!store) return { __noStore: true };
  const s = store.getState();
  const snap = s.snapshotSummary;
  const bar = document.querySelector('[aria-label^="剧本路演进行中"]');
  const logs = s.terminalLogs ?? [];

  /* 受害数：解析导演自己打的校验日志，避免在脚本里复制一份解析逻辑 */
  const verifyLine = logs
    .filter((l) => typeof l === 'string' && (l.includes('受灾校验通过') || l.includes('受灾校验超时')))
    .slice(-1)[0];
  let victimCount = null;
  if (verifyLine !== undefined) {
    const hit = verifyLine.match(/命中\\s*(\\d+)\\s*个受害容器/);
    victimCount = hit === null ? null : Number(hit[1]);
  }

  const selectedNode = snap.nodes.find((n) => n.id === s.selectedEntityId) ?? null;

  return {
    phase: bar === null ? null : bar.getAttribute('aria-label'),
    chaos: s.activeChaos,
    selected: s.selectedEntityId,
    selectedName: selectedNode === null ? null : selectedNode.name,
    selectedRack: selectedNode === null ? null : selectedNode.rackIndex,
    victimCount,
    nodes: snap.nodes.map((n) => ({ id: n.id, name: n.name, rackIndex: n.rackIndex })),
    abnormal: snap.pods.filter((p) => p.status !== 'Running').map((p) => ({ id: p.id, nodeId: p.nodeId, status: p.status })),
  };
})()`;

/** 终态：healedPodIds / MCP 回执 / AI 正文 */
const READ_FINAL = `(() => {
  const store = window.__KUBEVISION_STORE__;
  if (!store) return { __noStore: true };
  const s = store.getState();
  const logs = s.terminalLogs ?? [];

  const mcpLine = logs.filter((l) => typeof l === 'string' && /MCP 回执/.test(l)).slice(-1)[0];
  let mcpAction = null;
  if (mcpLine !== undefined) {
    const hit = mcpLine.match(/·\\s*([a-z_]+)\\s*已完成/);
    mcpAction = hit === null ? null : hit[1];
  }

  /* 闭环结论日志（解析"命中 x/y"） */
  const verdict = logs.filter((l) => typeof l === 'string' &&
    (l.includes('闭环校验通过') || l.includes('部分覆盖') || l.includes('自愈未完全验证'))).slice(-1)[0];
  let covered = null;
  let total = null;
  if (verdict !== undefined) {
    /*
     * 【必须先剥掉"阶段 N/4"】结论行形如
     *   "阶段 4/4 · 闭环校验通过：3/3 个受害者已自愈"
     * 直接匹配第一个比值会抓到 4/4（阶段进度），导致矩阵显示 4/4 而实际
     * 只修了 3 个。先剔掉阶段标记，再取第一个比值才是受害者覆盖数。
     */
    const cleaned = verdict.replace(/阶段[ ]*[0-9]+[/][0-9]+/g, '');
    const hit = cleaned.match(/([0-9]+)[/]([0-9]+)/);
    if (hit !== null) { covered = Number(hit[1]); total = Number(hit[2]); }
  }

  /* AI 正文宿主节点：从抽屉文本里找 worker-xxx */
  const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
  const drawerText = drawer === null ? '' : (drawer.textContent || '');
  /*
   * 【优先抓"宿主节点/受灾节点"短语】AI 分析可能顺带提到其他节点做对比，
   * 只按"文中出现过的节点"判定会把对比对象也算成宿主，造成假失败。
   * 先用带前缀的正则锁定宿主表述，抓不到才退化为全文首个节点。
   */
  const hostMatch = drawerText.match(/(?:宿主节点|受灾节点)\s*[:：]?\s*(worker-(?:alpha|beta|gamma))/);
  const allHits = drawerText.match(/worker-(?:alpha|beta|gamma)/g) ?? [];
  const uniqueNodes = Array.from(new Set(allHits));
  const hostNode = hostMatch === null
    ? (uniqueNodes[0] ?? null)
    : hostMatch[1];

  /* prompt 里的事实（导演刚打出来的那行） */
  const promptLine = logs.filter((l) => typeof l === 'string' && l.includes('诊断提示词：')).slice(-1)[0];

  return {
    healedIds: Object.keys(s.healedPodIds ?? {}),
    targetVictims: (() => {
      const line = logs.filter((l) => typeof l === 'string' && l.includes('目标受害者')).slice(-1)[0];
      if (line === undefined) return null;
      const m = line.match(/目标受害者[ ]*([0-9]+)[ ]*个/);
      return m === null ? null : Number(m[1]);
    })(),
    mcpAction,
    mcpLine: mcpLine ?? null,
    verdict: verdict ?? null,
    covered,
    total,
    aiNodes: uniqueNodes,
    aiHostNode: hostNode,
    promptLine: promptLine ?? null,
    lastDirectorLog: logs.filter((l) => typeof l === 'string' && l.includes('DEMO-DIRECTOR')).slice(-1)[0] ?? null,
  };
})()`;

/* ========================================================================== */
/* 单场景执行                                                                  */
/* ========================================================================== */

async function runCase(cdp, testCase) {
  const { script, label, scenario, rackIndex } = testCase;
  process.stdout.write(`\n▶ ${script}（${scenario}）…`);

  /* 重置到干净起点 */
  await cdp.send('Page.navigate', { url: baseUrl });
  for (let i = 0; i < 300; i += 1) {
    if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
    await sleep(400);
  }
  await sleep(9000);

  /*
   * 【关键：清空持久化终端日志，保证"本场景只读本场景的证据"】
   * terminalLogs 走 zustand persist，跨页面刷新仍然存在。若不清空，
   * 网络剧本会读到 OOM 剧本留下的闭环结论与 MCP 回执 —— 上一版矩阵里
   * 三个场景读出同一个回执 ID（mcp-mwa02qvd-b393）就是这么来的，
   * 看起来像"三个场景全过了"，实际是同一份旧证据被重复引用。
   */
  await evaluate(cdp, 'window.__KUBEVISION_STORE__.getState().clearTerminalLogs()');
  await sleep(600);

  /* 启动剧本 */
  const started = await evaluate(
    cdp,
    `(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
      if (!btn) return { error: 'start button missing' };
      btn.click();
      await new Promise((r) => setTimeout(r, 800));
      const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
        .find((b) => (b.textContent || '').includes(${JSON.stringify(label)}));
      if (!item) return { error: 'menu item missing: ' + ${JSON.stringify(label)} };
      item.click();
      return { ok: true };
    })()`,
  );
  if (started?.ok !== true) {
    return { ...testCase, error: JSON.stringify(started) };
  }

  /* 等阶段 2 并完成校验轮询 */
  let phase2 = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(300);
    const s = await evaluate(cdp, READ_PHASE2);
    if (s && typeof s.phase === 'string' && s.phase.includes('阶段 2/4')) {
      await sleep(3000);
      phase2 = await evaluate(cdp, READ_PHASE2);
      break;
    }
  }

  /* 等闭环结论：healed>0 + 回执，或出现结论日志，硬超时 100s */
  let final = null;
  const t0 = Date.now();
  for (let i = 0; i < 200; i += 1) {
    await sleep(500);
    const s = await evaluate(cdp, READ_FINAL);
    if (s && ((s.healedIds ?? []).length > 0 && s.mcpAction !== null)) {
      await sleep(1500);
      final = await evaluate(cdp, READ_FINAL);
      break;
    }
    /*
     * 【结论先到、回执后到】闭环结论日志在 healEntity 落库时就写了，
     * 而 MCP 回执要等控制器调谐完成（实测晚 1~3 秒）。若一看到结论就收尾，
     * 矩阵会读到 mcpAction=null 并误判 actionType 不符。
     * 因此看到结论后再给回执最多 8 秒窗口。
     */
    if (s && s.verdict !== null) {
      for (let k = 0; k < 16; k += 1) {
        await sleep(500);
        const late = await evaluate(cdp, READ_FINAL);
        if (late && late.mcpAction !== null) {
          final = late;
          break;
        }
      }
      if (final === null) final = await evaluate(cdp, READ_FINAL);
      break;
    }
    if (Date.now() - t0 > 100000) {
      final = await evaluate(cdp, READ_FINAL);
      break;
    }
  }
  if (final === null) final = await evaluate(cdp, READ_FINAL);

  /* 收尾停止 */
  await evaluate(
    cdp,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').includes('停止剧本路演'));
      if (btn) btn.click();
      return true;
    })()`,
  );
  await sleep(1000);

  process.stdout.write(' 完成');
  return { ...testCase, phase2, final };
}

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

async function main() {
  console.log('KubeVision AI — 三场景路演事实矩阵（verify-demo-matrix）');
  console.log(`  目标  : ${baseUrl}`);
  console.log(`  commit: ${readCommit()}`);
  console.log(`  场景  : ${CASES.map((c) => c.scenario).join(' / ')}`);

  let serverReady = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        serverReady = true;
        break;
      }
    } catch {
      /* 等 */
    }
    await sleep(1000);
  }
  if (!serverReady) {
    console.error(`[FATAL] ${baseUrl} 不可达，请先 pnpm dev`);
    process.exit(2);
  }

  const EDGE_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edgePath = EDGE_PATHS.find((p) => existsSync(p));
  if (edgePath === undefined) {
    console.error('[FATAL] 未找到 Edge');
    process.exit(2);
  }

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-matrix-${Date.now()}`);
  const browser = spawn(
    edgePath,
    [
      '--headless=new',
      '--no-first-run',
      '--window-size=1680,1000',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { detached: false, stdio: 'ignore' },
  );
  const cleanup = () => {
    try {
      browser.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      const list = await res.json();
      target = list.find((t) => t.type === 'page') ?? null;
      if (target !== null) break;
    } catch {
      /* 等 */
    }
    await sleep(500);
  }
  if (target === null) {
    console.error('[FATAL] CDP 未就绪');
    cleanup();
    process.exit(2);
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  /* 先确认 dev 构建 */
  await cdp.send('Page.navigate', { url: baseUrl });
  for (let i = 0; i < 300; i += 1) {
    if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
    await sleep(400);
  }
  await sleep(6000);
  const hasStore = await evaluate(cdp, 'typeof window.__KUBEVISION_STORE__ !== "undefined"');
  if (hasStore !== true) {
    console.error(
      '[FATAL] 未检测到 window.__KUBEVISION_STORE__。\n' +
        '        调试钩子仅存在于 dev 构建，请用 `pnpm dev` 启动后重跑。',
    );
    cleanup();
    process.exit(2);
  }

  const cases = onlyScript === null ? CASES : CASES.filter((c) => c.script === onlyScript);
  if (cases.length === 0) {
    console.error(`[FATAL] --only 未匹配任何剧本: ${onlyScript}`);
    cleanup();
    process.exit(2);
  }

  const results = [];
  for (const testCase of cases) {
    const r = await runCase(cdp, testCase);
    results.push(r);
  }

  cdp.close();
  cleanup();

  /* ====================================================================== */
  /* 输出矩阵                                                                */
  /* ====================================================================== */
  console.log('\n\n' + '='.repeat(132));
  console.log('场景 × 事实 矩阵');
  console.log('='.repeat(132));
  console.log(
    '| 场景 | 期望节点(rack) | 锁定节点(HUD) | 受害数 | AI正文宿主节点 | HUD选中节点 | MCP actionType | healed命中 |',
  );
  console.log('|---|---|---|---|---|---|---|---|');

  const rows = [];
  let inconsistent = 0;

  for (const r of results) {
    if (r.error !== undefined) {
      console.log(`| ${r.scenario} | ✗ 启动失败 | ${r.error} | | | | | |`);
      inconsistent += 1;
      continue;
    }

    const expectedNodeName = (r.phase2?.nodes ?? []).find((n) => n.rackIndex === r.rackIndex)?.name ?? `rack-${r.rackIndex}`;
    const hudSelected = r.phase2?.selected ?? '(none)';
    const selectedName = r.phase2?.selectedName ?? '(unknown)';
    /* 受害数取"阶段 4 实际瞄准的数量"——它才是 healed 覆盖率的分母 */
    const victimCount = r.final?.targetVictims ?? r.phase2?.victimCount;
    const aiNodes = r.final?.aiNodes ?? [];
    const aiHostNode = r.final?.aiHostNode ?? null;
    const aiNodeText = aiHostNode === null ? `(未出现) [全文:${aiNodes.join('/')}]` : aiHostNode;
    const mcpAction = r.final?.mcpAction ?? '(无回执)';
    const covered = r.final?.covered;
    const total = r.final?.total;
    const healedHit = covered === null || total === null ? '(无结论)' : `${covered}/${total}`;

    const checks = [];

    /* 1. HUD 选中节点 == 期望 rack 对应的节点 */
    const hudOk = hudSelected === (r.phase2?.nodes ?? []).find((n) => n.rackIndex === r.rackIndex)?.id;
    checks.push({ name: '锁定节点', ok: hudOk });

    /* 2. AI 正文宿主节点包含 HUD 选中节点名 */
    const aiOk = aiHostNode !== null && aiHostNode === selectedName;
    checks.push({ name: 'AI正文宿主==HUD选中', ok: aiOk });

    /* 3. healed 覆盖受害者 */
    const healedOk =
      total !== null &&
      covered === total &&
      (victimCount === null || victimCount === undefined || total === victimCount);
    checks.push({ name: 'healed覆盖受害', ok: healedOk });

    /* 4. MCP actionType 与场景映射一致（Pod 粒度允许 drain_node→restart_pod 降级） */
    const expectedAction = EXPECTED_ACTION[r.scenario];
    const actionOk =
      mcpAction === expectedAction ||
      (expectedAction === 'drain_node' && mcpAction === 'restart_pod');
    checks.push({ name: 'actionType', ok: actionOk });

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) inconsistent += 1;
    const flag = failed.length === 0 ? '✓' : `✗ ${failed.map((c) => c.name).join(',')}`;

    console.log(
      `| ${r.scenario} | ${expectedNodeName}(rack-${r.rackIndex}) | ${selectedName} | ${victimCount ?? '?'} | ` +
        `${aiNodeText} | ${selectedName} | ${mcpAction} | ${healedHit} |`,
    );
    rows.push({ scenario: r.scenario, checks, flag, expectedNodeName, selectedName });
  }

  console.log('');
  for (const row of rows) {
    console.log(`  ${row.flag === '✓' ? '✓' : '✗'} ${row.scenario}`);
    for (const c of row.checks) {
      console.log(`      ${c.ok ? '✓' : '✗'} ${c.name}`);
    }
  }

  /* 打印一份原始事实，便于人工复核 */
  console.log('\n' + '-'.repeat(132));
  console.log('原始事实（逐场景）');
  console.log('-'.repeat(132));
  for (const r of results) {
    if (r.error !== undefined) continue;
    console.log(`\n[${r.script}] ${r.scenario}`);
    console.log(`  阶段2 chaos    : ${r.phase2?.chaos}`);
    console.log(`  HUD selected   : ${r.phase2?.selected} (rack-${r.phase2?.selectedRack})`);
    console.log(`  受害数(阶段2)  : ${r.phase2?.victimCount}`);
    console.log(`  受害数(阶段4)  : ${r.final?.targetVictims}`);
    console.log(`  阶段2异常Pod   : ${JSON.stringify(r.phase2?.abnormal ?? [])}`);
    console.log(`  AI 正文节点    : ${JSON.stringify(r.final?.aiNodes ?? [])}`);
    console.log(`  MCP 回执       : ${r.final?.mcpLine}`);
    console.log(`  闭环结论       : ${r.final?.verdict}`);
    console.log(`  healedPodIds   : ${JSON.stringify(r.final?.healedIds ?? [])}`);
    console.log(`  诊断提示词     : ${r.final?.promptLine}`);
  }

  console.log('\n' + '='.repeat(132));
  if (inconsistent > 0) {
    console.log(`结论：${inconsistent} / ${results.length} 个场景存在不一致 —— 视为未完成`);
    process.exit(1);
  }
  console.log(`结论：${results.length} / ${results.length} 个场景事实自洽 ✓`);
  process.exit(0);
}

function readCommit() {
  try {
    return String(execSync('git rev-parse --short HEAD', { encoding: 'utf8' })).trim();
  } catch {
    return 'unknown';
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(2);
});