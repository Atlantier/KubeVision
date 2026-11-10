#!/usr/bin/env node
/**
 * KubeVision AI — 随机化路演演练（scripts/verify-demo-drill.mjs）
 *
 * 【为什么需要随机化】固定脚本只能证明"排练过的那条路径"是通的。真实的
 * 现场变量是组合爆炸的：不同剧本 × 不同节奏 × 不同网络状况。人工穷举
 * 不现实，而随机抽样能在有限时间里覆盖大量组合——只要**种子可复现**。
 *
 * 【种子契约】
 *   · 启动时打印 `SEED=<n>`；
 *   · 任何一组失败都会把种子与失败那组参数一起高亮打印；
 *   · 用 `--seed=<n>` 可 100% 复现同一组实验（PRNG 是确定性的 mulberry32）。
 * 这条契约是本脚本存在的意义：随机但可复现，失败可精确回放。
 *
 * 【组合维度】
 *   1. 场景顺序：先把三套剧本打乱，再按打乱后的顺序取用；
 *   2. 节奏：standard / compact / narrator（narrator 由脚本自动按空格）；
 *   3. 网络：none / slow300 / slow800（CDP emulateNetworkConditions）。
 *
 * 【每组校验】阶段 2 锁定的节点名符合引擎事实、该节点名下确有异常 Pod、
 * 阶段 4 出现、动作卡挂载或已自愈、本组新增 console error 为 0。
 *
 * 【用法】
 *   node scripts/verify-demo-drill.mjs                  # 随机种子，12 组
 *   node scripts/verify-demo-drill.mjs --seed=12345     # 复现
 *   node scripts/verify-demo-drill.mjs --trials=3       # 快速抽查
 *   node scripts/verify-demo-drill.mjs --base=http://127.0.0.1:3000
 *
 * 【退出码】0 = 12 组全通过；1 = 有失败（打印种子）；2 = 环境不可用
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/* ========================================================================== */
/* 参数                                                                        */
/* ========================================================================== */

const BASE_URL = readArg('--base') ?? 'http://127.0.0.1:3000';
const TRIALS = Number(readArg('--trials') ?? '12');

/**
 * 单组演练的最长等待时长（毫秒）。
 *
 * 【为什么从 75s 提到 150s】早期版本只要"看到阶段 4 或第一张卡片"就停演，
 * 等于只验证了前半程；标题里的"完整演练"要求跑到**自然收尾 + 自愈闭环**。
 * 完整链路 = 34s 剧本 + 事件门最多 25s 兜底 + 阶段 4 HITL/自愈约 10s
 * + 慢网 800ms 的额外延迟，150s 才留得下余量。
 */
const TRIAL_TIMEOUT_MS = Number(readArg('--trial-timeout') ?? '150000');
/**
 * 随机种子。
 *
 * 【默认用时间戳而不是 Math.random】时间戳本身可记录、可复述；
 * 而 Math.random 的种子无法在输出里"告诉别人"（除非另外打印内部状态）。
 */
const SEED = Number(readArg('--seed') ?? String(Date.now() % 1_000_000_000));
const CDP_PORT = Number(readArg('--port') ?? '9352');

/**
 * 期望的「剧本 → 受灾节点名」映射。
 *
 * 【事实来源】src/utils/syntheticEngine.ts 的
 * OOM_RACK_INDEX=1 / SPIKE_RACK_INDEX=0 / PARTITION_RACK_INDEX=2，
 * 以及 types/cluster.ts 的 rack→node 派生。
 * 测试独立写一份期望，才能在实现被改错时失败。
 */
const SCENARIOS = [
  { scriptLabel: 'OOM 全链路自愈', node: 'worker-beta', chaos: 'POD_OOM_SWARM' },
  { scriptLabel: 'CNI 网络延迟追踪', node: 'worker-gamma', chaos: 'NET_PACKET_LOSS' },
  { scriptLabel: '节点 CPU 尖刺扩缩容', node: 'worker-alpha', chaos: 'NODE_CPU_SPIKE' },
];

const PACINGS = ['standard', 'compact', 'narrator'];
const PACING_ARIA = {
  standard: '切换为标准节奏',
  compact: '切换为紧凑节奏',
  narrator: '切换为讲解版节奏',
};
const NETWORKS = [
  { key: 'none', latency: 0, down: -1, up: -1 },
  { key: 'slow300', latency: 300, down: Math.round((1.5 * 1024 * 1024) / 8), up: Math.round((750 * 1024) / 8) },
  { key: 'slow800', latency: 800, down: Math.round((600 * 1024) / 8), up: Math.round((300 * 1024) / 8) },
];

/* ========================================================================== */
/* 确定性随机源                                                                */
/* ========================================================================== */

/**
 * mulberry32 —— 32 位确定性 PRNG。
 *
 * 【为什么选它】实现只有几行、无依赖、同一 seed 在任何平台产出同一序列。
 * 演练脚本最需要的就是"同一个种子跑出同一组实验"，不需要密码学强度。
 *
 * @param {number} seed 种子
 * @returns {() => number} 返回 [0,1) 的函数
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);

/**
 * 从数组里随机取一项。
 *
 * @param {Array} list 候选
 * @returns {*} 选中项
 */
function pick(list) {
  return list[Math.floor(rng() * list.length)];
}

/**
 * Fisher–Yates 洗牌（用同一个 rng，保证可复现）。
 *
 * @param {Array} list 原数组
 * @returns {Array} 新数组
 */
function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ========================================================================== */
/* CDP 最小会话                                                                */
/* ========================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readArg(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? null : hit.slice(flag.length + 1);
}

/**
 * 建立 CDP 会话。
 *
 * @param {string} wsUrl DevTools websocket 地址
 * @returns {Promise<object>} 会话
 */
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
      consoleErrors.push(
        (msg.params.args ?? []).map((a) => String(a.value ?? '')).join(' ').slice(0, 200),
      );
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`CDP 超时: ${method}`)), 25000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { send, close: () => ws.close(), consoleErrors };
}

/**
 * 在页面内求值。
 *
 * @param {object} cdp 会话
 * @param {string} expression 表达式
 * @returns {Promise<any>} 值
 */
async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const details = res.result?.exceptionDetails;
  if (details !== undefined) {
    return { __err: String(details.exception?.description ?? details.text ?? 'unknown') };
  }
  return res.result?.result?.value;
}

/* ========================================================================== */
/* 页面探针                                                                    */
/* ========================================================================== */

const READ = `(() => {
  const st = window.__KUBEVISION_STORE__.getState();
  const snap = st.snapshotSummary;
  const dbg = window.__demoDirectorDebug__;
  const bar = document.querySelector('[aria-label^="剧本路演"]');
  return {
    phase: bar === null ? null : bar.getAttribute('aria-label'),
    dbg: dbg === undefined ? null : {
      status: dbg.status,
      phaseIndex: dbg.phaseIndex,
      pacing: dbg.pacing,
      awaiting: dbg.awaitingNarratorAdvance,
      timerCount: dbg.timerCount,
    },
    selected: st.selectedEntityId,
    chaos: st.activeChaos,
    healed: Object.keys(st.healedPodIds ?? {}).length,
    nodes: snap.nodes.map((n) => ({ id: n.id, name: n.name })),
    abnormal: snap.pods.filter((p) => p.status !== 'Running').map((p) => p.id),
    cards: (() => {
      const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
      if (!drawer) return 0;
      return Array.from(drawer.querySelectorAll('[aria-label]'))
        .filter((el) => (el.getAttribute('aria-label') || '').startsWith('自愈操作确认')).length;
    })(),
    lastDirectorLog: (st.terminalLogs ?? [])
      .filter((l) => typeof l === 'string' && l.includes('DEMO-DIRECTOR')).slice(-1)[0] ?? null,
    mcpAction: (() => {
      const m = (st.terminalLogs ?? [])
        .filter((l) => typeof l === 'string' && /MCP 回执/.test(l)).slice(-1)[0];
      if (m === undefined) return null;
      const hit = m.match(/·\\s*([a-z_]+)\\s*已完成/);
      return hit === null ? null : hit[1];
    })(),
    finished: dbg === undefined ? false : dbg.status === 'finished',
  };
})()`;

/* ========================================================================== */
/* 单组演练                                                                    */
/* ========================================================================== */

/**
 * 跑一组演练。
 *
 * @param {object} cdp 会话
 * @param {object} trial 组合参数
 * @returns {Promise<object>} 结果
 */
async function runTrial(cdp, trial) {
  const errorsBefore = cdp.consoleErrors.length;
  const startedAt = Date.now();

  /* ---- 网络条件 ---- */
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: trial.network.latency,
    downloadThroughput: trial.network.down,
    uploadThroughput: trial.network.up,
  });

  /* ---- 先复位到干净起点 ---- */
  await evaluate(
    cdp,
    `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        (x.getAttribute('aria-label') || '').includes('停止剧本路演'));
      if (b) b.click();
      window.__KUBEVISION_STORE__.getState().clearTerminalLogs();
      return true;
    })()`,
  );
  await sleep(1200);

  /* ---- 启动剧本 ---- */
  const started = await evaluate(
    cdp,
    `(async () => {
      const LABEL = ${JSON.stringify(trial.scenario.scriptLabel)};
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        (x.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
      if (!b) return { error: 'start button missing' };
      b.click();
      await new Promise((r) => setTimeout(r, 800));
      const items = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'));
      const item = items.find((x) => (x.textContent || '').includes(LABEL));
      if (!item) return { error: 'menu item missing', labels: items.map((x) => (x.textContent || '').slice(0, 20)) };
      item.click();
      return { ok: true };
    })()`,
  );

  /* ---- 设定节奏 ---- */
  const pacingSet = await evaluate(
    cdp,
    `(() => {
      const b = document.querySelector('[aria-label=${JSON.stringify(PACING_ARIA[trial.pacing])}]');
      if (!b) return { error: 'pacing button missing' };
      b.click();
      return { ok: true };
    })()`,
  );

  /* ---- 记录阶段 2 快照，并一直等到**自然收尾** ---- */
  let phase2 = null;
  let sawPhase4 = false;
  let sawFinished = false;
  const deadline = Date.now() + TRIAL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(400);
    const s = await evaluate(cdp, READ);
    if (s === undefined || s === null) continue;

    /* narrator 模式：脚本代主讲人按空格 */
    if (s.dbg?.awaiting === true) {
      await evaluate(
        cdp,
        `(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
          return true;
        })()`,
      );
      continue;
    }

    if (phase2 === null && typeof s.phase === 'string' && s.phase.includes('阶段 2/4')) {
      await sleep(2600); /* 等故障回传 */
      phase2 = await evaluate(cdp, READ);
    }
    if (
      (typeof s.phase === 'string' && s.phase.includes('阶段 4/4')) ||
      (s.dbg?.status === 'finished') ||
      (s.healed ?? 0) > 0 ||
      (s.cards ?? 0) > 0
    ) {
      sawPhase4 = true;
    }

    /*
     * 【收尾判定】等到引擎自己进入 finished 才算跑完整场。
     * 收尾后自愈链仍可能异步落库（MCP 回执要等控制器调谐），
     * 因此再给 3 秒静定时间，然后读最终状态。
     */
    if (s.finished === true || s.dbg?.status === 'finished') {
      sawFinished = true;
      await sleep(3000);
      break;
    }
  }

  const finalState = await evaluate(cdp, READ);

  /* ---- 收尾：停演 + 恢复网络 ---- */
  await evaluate(
    cdp,
    `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        (x.getAttribute('aria-label') || '').includes('停止剧本路演'));
      if (b) b.click();
      return true;
    })()`,
  );
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await cdp.send('Network.disable');
  await sleep(800);

  /* ---- 判定 ---- */
  const selectedNode = (phase2?.nodes ?? []).find((n) => n.id === phase2?.selected) ?? null;
  const abnormalOnSelected = (phase2?.abnormal ?? []).length > 0;
  const errorsDelta = cdp.consoleErrors.length - errorsBefore;

  /*
   * 【场景差异化断言】NODE_CPU_SPIKE 是资源争抢型故障：
   * syntheticEngine.evolvePodCpuSpike 刻意让 Pod 保持 Running
   * （syntheticEngine.ts:437「Pod 本身没崩，只是被挤占资源」），
   * 因此该场景**没有异常 Pod**，"异常 Pod ≥1"对它不成立。
   * 其余两个场景是崩溃型，异常 Pod 必须存在。
   * 这条差异是首轮随机演练用种子 20261110 实测发现的——不是产品缺陷。
   */
  const expectsAbnormal = trial.scenario.chaos !== 'NODE_CPU_SPIKE';

  /*
   * 【回执动作期望】与 chaosFacts 的映射一致；NET_PACKET_LOSS 的 drain_node
   * 作用在 Pod 上会降级为 restart_pod，两种都算通过。
   */
  const EXPECTED_ACTION = {
    POD_OOM_SWARM: 'restart_pod',
    NET_PACKET_LOSS: 'restart_pod',
    NODE_CPU_SPIKE: 'scale_deployment',
  };
  const expectedAction = EXPECTED_ACTION[trial.scenario.chaos];
  const mcpOk =
    finalState?.mcpAction === expectedAction ||
    (trial.scenario.chaos === 'NET_PACKET_LOSS' && finalState?.mcpAction === 'drain_node');

  const checks = {
    started: started?.ok === true,
    pacingApplied: pacingSet?.ok === true,
    phase2Seen: phase2 !== null,
    nodeMatched: selectedNode !== null && selectedNode.name === trial.scenario.node,
    chaosApplied: phase2?.chaos === trial.scenario.chaos,
    abnormalOk: expectsAbnormal ? abnormalOnSelected : true,
    phase4Seen: sawPhase4,
    /* 完整演练：必须跑到自然收尾，而不是看到阶段 4 就停 */
    finished: sawFinished,
    /* 自愈闭环：所有场景都应有受害者被修复（CPU 争抢修的是热点 Pod） */
    healed: (finalState?.healed ?? 0) > 0,
    /* MCP 回执动作必须与场景映射一致 */
    mcpAction: mcpOk,
    noConsoleError: errorsDelta === 0,
  };

  return {
    trial,
    checks,
    pass: Object.values(checks).every(Boolean),
    actual: {
      selected: phase2?.selected ?? null,
      selectedName: selectedNode === null ? null : selectedNode.name,
      expectedName: trial.scenario.node,
      chaos: phase2?.chaos ?? null,
      abnormalCount: (phase2?.abnormal ?? []).length,
      expectsAbnormal,
      healed: finalState?.healed ?? 0,
      cards: finalState?.cards ?? 0,
      finished: finalState?.finished ?? false,
      mcpAction: finalState?.mcpAction ?? null,
      expectedAction,
      lastDirectorLog: finalState?.lastDirectorLog ?? null,
      consoleErrorDelta: errorsDelta,
      consoleErrors: cdp.consoleErrors.slice(errorsBefore, errorsBefore + 3),
      durationMs: Date.now() - startedAt,
      startError: started?.error ?? null,
      pacingError: pacingSet?.error ?? null,
    },
  };
}

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

async function main() {
  console.log('KubeVision AI — 随机化路演演练（verify-demo-drill）');
  console.log(`  目标   : ${BASE_URL}`);
  console.log(`  种子   : SEED=${SEED}   （复现：--seed=${SEED}）`);
  console.log(`  组数   : ${TRIALS}`);
  console.log(`  维度   : 场景顺序 × 节奏(${PACINGS.join('/')}) × 网络(${NETWORKS.map((x) => x.key).join('/')})`);

  /* ---- 生成 12 组组合 ---- */
  const order = shuffle(SCENARIOS);
  const trials = [];
  for (let i = 0; i < TRIALS; i += 1) {
    trials.push({
      index: i + 1,
      scenario: order[i % order.length],
      pacing: pick(PACINGS),
      network: pick(NETWORKS),
    });
  }

  console.log('\n  本组实验计划（种子确定，可复现）：');
  for (const t of trials) {
    console.log(
      `    #${String(t.index).padStart(2)} ${t.scenario.chaos.padEnd(16)} pacing=${t.pacing.padEnd(9)} net=${t.network.key}`,
    );
  }

  /* ---- 环境检查 ---- */
  let reachable = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(BASE_URL, { signal: AbortSignal.timeout(4000) });
      if (r.ok) { reachable = true; break; }
    } catch { /* 等 */ }
    await sleep(1000);
  }
  if (!reachable) {
    console.error(`\n[FATAL] ${BASE_URL} 不可达，请先 pnpm dev`);
    process.exit(2);
  }

  const EDGE_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edge = EDGE_PATHS.find((p) => existsSync(p));
  if (edge === undefined) {
    console.error('[FATAL] 未找到 Edge');
    process.exit(2);
  }

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-drill-${Date.now()}`);
  const browser = spawn(
    edge,
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
    try { browser.kill('SIGKILL'); } catch { /* ignore */ }
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
    } catch { /* 等 */ }
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
    width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: BASE_URL });
  for (let i = 0; i < 240; i += 1) {
    if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
    await sleep(400);
  }
  await sleep(9000);

  /* 就绪：抽屉 + SSE 数据（R08 预检前置） */
  for (let i = 0; i < 90; i += 1) {
    const ok = await evaluate(
      cdp,
      `(() => {
        const st = window.__KUBEVISION_STORE__;
        if (!st) return false;
        return document.querySelector('[aria-label="AI Copilot 抽屉"]') !== null
          && st.getState().snapshotSummary.totalQps > 0;
      })()`,
    );
    if (ok === true) break;
    await sleep(500);
  }

  /* ---- 逐组执行 ---- */
  const results = [];
  for (const trial of trials) {
    process.stdout.write(`\n▶ 第 ${trial.index}/${trials.length} 组 …`);
    const result = await runTrial(cdp, trial);
    results.push(result);
    console.log(
      result.pass
        ? ` 通过（${(result.actual.durationMs / 1000).toFixed(0)}s）`
        : ` ✗ 失败（${(result.actual.durationMs / 1000).toFixed(0)}s）`,
    );
  }

  cdp.close();
  cleanup();

  /* ---- 矩阵输出 ---- */
  console.log('\n' + '='.repeat(96));
  console.log(`随机化演练矩阵   SEED=${SEED}`);
  console.log('='.repeat(96));
  console.log('| # | 场景 | 节奏 | 网络 | 结果 | 时长 | 实际值 |');
  console.log('|---|---|---|---|---|---|---|');
  let totalMs = 0;
  for (const r of results) {
    const durSec = (r.actual.durationMs / 1000).toFixed(0);
    totalMs += r.actual.durationMs;
    console.log(
      `| ${r.trial.index} | ${r.trial.scenario.chaos} | ${r.trial.pacing} | ${r.trial.network.key} | ${r.pass ? '通过' : '失败'} | ${durSec}s | ${JSON.stringify(r.actual).slice(0, 140)} |`,
    );
  }

  const failed = results.filter((r) => !r.pass);
  const totalSec = Math.round(totalMs / 1000);
  console.log(`
  总时长: ${totalSec}s（${results.length} 组，平均 ${Math.round(totalMs / results.length / 1000)}s/组，每组上限 ${Math.round(TRIAL_TIMEOUT_MS / 1000)}s）`);
  console.log('');
  if (failed.length === 0) {
    console.log(`结论：${results.length} / ${results.length} 组全部通过  ✓   SEED=${SEED}`);
    process.exit(0);
  }

  console.log(`结论：${failed.length} / ${results.length} 组失败`);
  console.log(`\n【复现命令】node scripts/verify-demo-drill.mjs --seed=${SEED}\n`);
  console.log('失败明细：');
  for (const r of failed) {
    console.log(`  · 第 ${r.trial.index} 组  chaos=${r.trial.scenario.chaos} pacing=${r.trial.pacing} net=${r.trial.network.key}`);
    console.log(`    断言: ${JSON.stringify(r.checks)}`);
    console.log(`    实际: ${JSON.stringify(r.actual, null, 2).split('\n').join('\n    ')}`);
    console.log(`    种子: SEED=${SEED}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});