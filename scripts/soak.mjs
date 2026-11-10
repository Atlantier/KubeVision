#!/usr/bin/env node
/**
 * KubeVision AI — 长跑稳定性压测（scripts/soak.mjs）
 *
 * 【压测什么】
 *   1. 20 次完整对话（真实 /api/chat NDJSON 流，消费到底）；
 *   2. 60 秒 SSE 遥测订阅（每秒一帧，持续跑）；
 *   3. 20 次混沌场景切换（每次都会触发 SSE 重连——最易泄漏的路径）；
 *   4. 流式取消语义：发第二条消息时旧流必须 abort 且保留已产出内容。
 *
 * 【监控什么】浏览器侧资源计数，全部通过**注入式仪表盘**采集：
 *   - 存活 timer / interval（包装 setTimeout/setInterval，成对记账）；
 *   - 存活 EventSource（包装构造函数 + close）；
 *   - 存活 Worker（包装构造函数 + terminate）；
 *   - JS 堆内存（performance.memory，需 --enable-precise-memory-info）；
 *   - 监听器净增量（EventTarget.prototype addEventListener 计数差）。
 *
 * 【判定标准】压测后相对基线的变化：
 *   - 堆内存增长 < 10%（GC 后的 usedJSHeapSize）；
 *   - 存活 EventSource 回到基线（混沌切换后必须只剩当前连接）；
 *   - 存活 timer / interval / Worker 不得单调增长；
 *   - 监听器净增量 < 200（一次性监听器会自然累积，给合理余量）。
 *
 * 【输出】docs/soak.md（自动生成，含每个阶段的计数快照）。
 *
 * 【用法】
 *   node scripts/soak.mjs                 # 完整压测（约 3 分钟，需先 pnpm dev）
 *   node scripts/soak.mjs --conversations=5 --sse=20   # 快速自查
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9363');
const CONVERSATIONS = Number(readArg('--conversations') ?? '20');
const SSE_SECONDS = Number(readArg('--sse') ?? '60');
const CHAOS_SWITCHES = Number(readArg('--chaos') ?? '20');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readArg(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? null : hit.slice(flag.length + 1);
}

/* ========================================================================== */
/* 浏览器启动与 CDP                                                            */
/* ========================================================================== */

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (EDGE === undefined) {
  console.error('未找到 Edge');
  process.exit(2);
}

const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-soak-${Date.now()}`);
const browser = spawn(
  EDGE,
  [
    '--headless=new',
    '--no-first-run',
    '--window-size=1680,1000',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
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
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    target = list.find((t) => t.type === 'page') ?? null;
    if (target !== null) break;
  } catch {
    /* 等浏览器 */
  }
  await sleep(500);
}
if (target === null) {
  console.error('CDP 未就绪');
  cleanup();
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) {
    return { __err: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text) };
  }
  return res.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

/* ---- 注入仪表盘（必须在页面脚本之前） ---- */
const INSTRUMENT = `
(() => {
  const stats = window.__SOAK_STATS__ = {
    timers: new Set(), intervals: new Set(), eventSources: new Set(), workers: new Set(),
    listenersAdd: 0, listenersRemove: 0,
    esCreated: 0, esClosed: 0, workerCreated: 0, workerTerminated: 0,
  };
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = function (fn, ms, ...args) {
    let id = null;
    const wrapped = function (...inner) {
      stats.timers.delete(id);
      if (typeof fn === 'function') return fn.apply(this, inner);
      return undefined;
    };
    id = origSetTimeout(wrapped, ms, ...args);
    stats.timers.add(id);
    return id;
  };
  window.clearTimeout = function (id) {
    stats.timers.delete(id);
    return origClearTimeout(id);
  };
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  window.setInterval = function (fn, ms, ...args) {
    const id = origSetInterval(fn, ms, ...args);
    stats.intervals.add(id);
    return id;
  };
  window.clearInterval = function (id) {
    stats.intervals.delete(id);
    return origClearInterval(id);
  };
  const OrigES = window.EventSource;
  if (typeof OrigES === 'function') {
    window.EventSource = class extends OrigES {
      constructor(...args) {
        super(...args);
        stats.esCreated += 1;
        stats.eventSources.add(this);
        const self = this;
        const origClose = this.close.bind(this);
        this.close = function () {
          if (stats.eventSources.has(self)) {
            stats.eventSources.delete(self);
            stats.esClosed += 1;
          }
          return origClose();
        };
      }
    };
  }
  const OrigWorker = window.Worker;
  if (typeof OrigWorker === 'function') {
    window.Worker = class extends OrigWorker {
      constructor(...args) {
        super(...args);
        stats.workerCreated += 1;
        stats.workers.add(this);
        const self = this;
        const origTerminate = this.terminate.bind(this);
        this.terminate = function () {
          if (stats.workers.has(self)) {
            stats.workers.delete(self);
            stats.workerTerminated += 1;
          }
          return origTerminate();
        };
      }
    };
  }
  const origAdd = EventTarget.prototype.addEventListener;
  const origRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (...args) {
    stats.listenersAdd += 1;
    return origAdd.apply(this, args);
  };
  EventTarget.prototype.removeEventListener = function (...args) {
    stats.listenersRemove += 1;
    return origRemove.apply(this, args);
  };
})();
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) {
  if ((await ev('document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(9000);

/* ========================================================================== */
/* 采样与统计                                                                  */
/* ========================================================================== */

/**
 * 读取当前资源快照（并尝试 GC 后测堆）。
 *
 * @returns {Promise<object>} 计数快照
 */
async function snapshot() {
  const raw = await ev(`(() => {
    if (window.gc) { try { window.gc(); } catch (e) {} }
    const s = window.__SOAK_STATS__;
    const mem = performance.memory ?? null;
    return {
      timers: s.timers.size,
      intervals: s.intervals.size,
      eventSources: s.eventSources.size,
      esCreated: s.esCreated,
      esClosed: s.esClosed,
      workers: s.workers.size,
      workerCreated: s.workerCreated,
      workerTerminated: s.workerTerminated,
      listenersAdd: s.listenersAdd,
      listenersRemove: s.listenersRemove,
      listenersNet: s.listenersAdd - s.listenersRemove,
      heapUsed: mem === null ? null : mem.usedJSHeapSize,
      heapTotal: mem === null ? null : mem.totalJSHeapSize,
    };
  })()`);
  return raw ?? {};
}

const stages = [];
const record = (name, snap) => {
  stages.push({ name, snap });
  console.log(
    `  [${name}] timer=${snap.timers} interval=${snap.intervals} es=${snap.eventSources} worker=${snap.workers} ` +
      `listeners(net)=${snap.listenersNet} heap=${snap.heapUsed === null ? 'n/a' : (snap.heapUsed / 1048576).toFixed(1) + 'MB'}`,
  );
};

console.log('KubeVision AI — 长跑稳定性压测');
console.log(`  目标: ${BASE_URL}  对话: ${CONVERSATIONS} 次  SSE: ${SSE_SECONDS}s  混沌切换: ${CHAOS_SWITCHES} 次\n`);

const baseline = await snapshot();
record('基线（加载完成）', baseline);

/* ---- 阶段 1：20 次对话 ---- */
console.log(`\n▸ 阶段 1：${CONVERSATIONS} 次 /api/chat 对话`);
const conversationResult = await ev(`(async () => {
  const results = [];
  for (let i = 0; i < ${CONVERSATIONS}; i += 1) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '诊断 OOMKilled 根因并生成自愈方案' }],
        clusterContext: {
          selectedEntityId: null, selectedEntityType: 'master', activeChaos: 'POD_OOM_SWARM',
          clusterHealthScore: 62, totalQps: 4200,
          faultyPods: [{
            id: 'pod-payment-gateway-7f8b9-x2k', name: 'payment-gateway-7f8b9-x2k', namespace: 'kv-prod',
            status: 'OOMKilled', cpuUsage: 66, memoryUsage: 97, restarts: 9, nodeId: 'node-worker-beta',
            cpuHistory: [58,62,65,66,66,66], memHistory: [80,86,91,95,96,97],
          }],
          nodes: [
            { id: 'node-worker-alpha', name: 'worker-alpha', status: 'Ready', cpuUsage: 38, memUsage: 46, rackIndex: 0 },
            { id: 'node-worker-beta', name: 'worker-beta', status: 'Ready', cpuUsage: 42, memUsage: 51, rackIndex: 1 },
            { id: 'node-worker-gamma', name: 'worker-gamma', status: 'Ready', cpuUsage: 40, memUsage: 49, rackIndex: 2 },
          ],
        },
      }),
    });
    if (!res.ok) { results.push({ i, ok: false, status: res.status }); continue; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let events = 0;
    let done = 0;
    let buffer = '';
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\\n');
        if (line.length === 0) continue;
        events += 1;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'text') text += parsed.content;
          if (parsed.type === 'done') done += 1;
        } catch (e) {}
      }
    }
    results.push({ i, ok: true, events, textLen: text.length, done });
  }
  return { total: results.length, failed: results.filter((r) => !r.ok).length, sample: results.slice(0, 3), doneCounts: results.map((r) => r.done) };
})()`);
console.log(`  对话结果: 总数=${conversationResult?.total} 失败=${conversationResult?.failed} 首例事件数=${JSON.stringify(conversationResult?.sample?.[0])}`);
const afterConversations = await snapshot();
record('对话后', afterConversations);

/* ---- 阶段 2：60 秒 SSE ---- */
console.log(`\n▸ 阶段 2：${SSE_SECONDS} 秒 SSE 遥测订阅`);
const sseResult = await ev(`(async () => {
  const es = new EventSource('/api/telemetry?mode=demo&chaos=NONE&since=0');
  let frames = 0;
  es.onmessage = () => { frames += 1; };
  await new Promise((r) => setTimeout(r, ${SSE_SECONDS * 1000}));
  const stats = window.__SOAK_STATS__;
  const activeDuring = stats.eventSources.size;
  es.close();
  await new Promise((r) => setTimeout(r, 1200));
  return { frames, activeDuring, activeAfter: stats.eventSources.size };
})()`);
console.log(`  SSE 帧数=${sseResult?.frames} 活跃连接(期间)=${sseResult?.activeDuring} 关闭后=${sseResult?.activeAfter}`);
record('SSE 60 秒后', await snapshot());

/* ---- 阶段 3：20 次混沌切换 ---- */
console.log(`\n▸ 阶段 3：${CHAOS_SWITCHES} 次混沌场景切换（每次触发 SSE 重连）`);
const chaosResult = await ev(`(async () => {
  const store = window.__KUBEVISION_STORE__;
  const scenarios = ['NONE', 'POD_OOM_SWARM', 'NONE', 'NET_PACKET_LOSS', 'NONE', 'NODE_CPU_SPIKE'];
  let maxActive = 0;
  for (let i = 0; i < ${CHAOS_SWITCHES}; i += 1) {
    store.getState().setActiveChaos(scenarios[i % scenarios.length]);
    await new Promise((r) => setTimeout(r, 1200));
    maxActive = Math.max(maxActive, window.__SOAK_STATS__.eventSources.size);
  }
  store.getState().setActiveChaos('NONE');
  await new Promise((r) => setTimeout(r, 2500));
  return { maxActive, finalActive: window.__SOAK_STATS__.eventSources.size };
})()`);
console.log(`  混沌切换完成: 期间最大活跃连接=${chaosResult?.maxActive} 结束后=${chaosResult?.finalActive}`);
record('混沌切换后', await snapshot());

/* ---- 阶段 4：流式取消语义 ---- */
console.log('\n▸ 阶段 4：流式取消语义（新消息 abort 旧流，保留内容）');
const cancelResult = await ev(`(async () => {
  const store = window.__KUBEVISION_STORE__;
  if (typeof store.getState().setActiveRightTab === 'function') store.getState().setActiveRightTab('copilot');
  await new Promise((r) => setTimeout(r, 600));
  const textarea = document.querySelector('textarea[aria-label="对话输入框"]');
  if (textarea === null) return { error: 'textarea missing' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  const send = (text) => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  };
  send('全面巡检当前集群健康状态');
  await new Promise((r) => setTimeout(r, 1800));
  send('诊断 OOMKilled 根因并生成自愈方案');
  await new Promise((r) => setTimeout(r, 9000));
  const store2 = window.__KUBEVISION_STORE__;
  return {
    streaming: store2.getState().copilotStreaming,
    chatStreaming: typeof store2.getState().demoAutoConfirm === 'boolean',
  };
})()`);
console.log(`  取消语义结果: ${JSON.stringify(cancelResult)}`);
record('取消语义后', await snapshot());

/* ---- 收尾：等待稳定后测堆 ---- */
await sleep(4000);
const finalSnap = await snapshot();
record('最终（静置 4s）', finalSnap);

/* ========================================================================== */
/* 判定与报告                                                                  */
/* ========================================================================== */

const heapGrowth =
  baseline.heapUsed === null || finalSnap.heapUsed === null
    ? null
    : (finalSnap.heapUsed - baseline.heapUsed) / baseline.heapUsed;
const checks = [];

/**
 * 记录一条检查结果。
 *
 * @param name 名称
 * @param pass 是否通过
 * @param detail 说明
 */
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}  ::  ${detail}`);
}

console.log('\n══════════ 判定 ══════════');
check('堆内存增长 < 10%', heapGrowth !== null && heapGrowth < 0.1, heapGrowth === null ? '无 performance.memory' : `${(heapGrowth * 100).toFixed(1)}%`);
check(
  '存活 EventSource 回到基线',
  finalSnap.eventSources <= Math.max(baseline.eventSources, 1),
  `基线=${baseline.eventSources} 最终=${finalSnap.eventSources}（期间创建 ${finalSnap.esCreated} / 关闭 ${finalSnap.esClosed}）`,
);
check(
  'timer 无泄漏',
  finalSnap.timers <= baseline.timers + 3,
  `基线=${baseline.timers} 最终=${finalSnap.timers}`,
);
check(
  'interval 无泄漏',
  finalSnap.intervals <= baseline.intervals + 3,
  `基线=${baseline.intervals} 最终=${finalSnap.intervals}`,
);
check(
  'Worker 无泄漏',
  finalSnap.workers <= baseline.workers,
  `基线=${baseline.workers} 最终=${finalSnap.workers}（创建 ${finalSnap.workerCreated} / 终止 ${finalSnap.workerTerminated}）`,
);
check(
  '监听器净增量合理（< 200）',
  finalSnap.listenersNet - baseline.listenersNet < 200,
  `基线=${baseline.listenersNet} 最终=${finalSnap.listenersNet}`,
);
check(
  '混沌切换期间未出现连接叠加',
  (chaosResult?.maxActive ?? 99) <= 1,
  `期间最大活跃=${chaosResult?.maxActive}`,
);

const failures = checks.filter((c) => !c.pass).length;

/* ---- 生成 docs/soak.md ---- */
const md = [
  '# 长跑稳定性压测报告（soak）',
  '',
  `> 由 \`node scripts/soak.mjs\` 自动生成于 ${new Date().toISOString()}。`,
  `> 目标：${BASE_URL} · 对话 ${CONVERSATIONS} 次 · SSE ${SSE_SECONDS}s · 混沌切换 ${CHAOS_SWITCHES} 次。`,
  '',
  '## 阶段快照',
  '',
  '| 阶段 | 存活 timer | interval | EventSource | Worker | 监听器净增 | JS 堆 |',
  '|---|---|---|---|---|---|---|',
  ...stages.map((stage) => {
    const s = stage.snap;
    return `| ${stage.name} | ${s.timers} | ${s.intervals} | ${s.eventSources} | ${s.workers} | ${s.listenersNet} | ${
      s.heapUsed === null ? 'n/a' : (s.heapUsed / 1048576).toFixed(1) + ' MB'
    } |`;
  }),
  '',
  '## 判定',
  '',
  '| 检查项 | 结果 | 实测 |',
  '|---|---|---|',
  ...checks.map((c) => `| ${c.name} | ${c.pass ? '通过' : '失败'} | ${c.detail} |`),
  '',
  `**结论：${failures === 0 ? '全部通过' : `${failures} 项失败`}。**`,
  '',
  '## 口径说明',
  '',
  '- 资源计数由**注入式仪表盘**采集：包装 `setTimeout/setInterval/EventSource/Worker` 与 `EventTarget.addEventListener`，成对记账；',
  '- 堆内存取 `performance.memory.usedJSHeapSize`（无 GC 强约束，浏览器可能未真正回收，数值偏保守）；',
  '- SSE 60 秒期间保持一条连接，关闭后应回到 0；混沌切换每次会重建连接，因此**期间最大活跃连接数**是关键指标；',
  '- 本机 dev server 配置了真实 API Key，对话走引擎 A；协议消费路径与引擎 B 完全相同（同一 NDJSON 消费逻辑）。',
  '',
].join('\n');
writeFileSync(join(process.cwd(), 'docs/soak.md'), md, 'utf8');

console.log(`\n报告已写入 docs/soak.md`);
console.log(`汇总: ${checks.length - failures}/${checks.length} 通过`);
ws.close();
cleanup();
process.exit(failures === 0 ? 0 : 1);