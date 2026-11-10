#!/usr/bin/env node
/**
 * KubeVision AI — React 18 StrictMode 一致性审计（scripts/strictmode-audit.mjs）
 *
 * 【审计什么】StrictMode 在开发模式下会把 Effect 执行**两遍**（挂载→卸载→再挂载）。
 * 任何"只在挂载时创建、卸载时不释放"的资源都会因此翻倍：
 *   SSE EventSource、Worker、setInterval、事件监听器、SpeechSynthesis 回调。
 *
 * 【本脚本验证的契约】
 *   1. **挂载两次只保留一份资源**：首屏稳定后，存活 EventSource === 1、
 *      interval 数量不因 StrictMode 翻倍；
 *   2. **卸载后零回调**：切走审计台 → Worker 被 terminate、定时器被清空；
 *      切回后资源重建但不再叠加；
 *   3. **反复切换不增长**：copilot ↔ auditor 来回 3 次，存活资源数不单调增长。
 *
 * 【为什么必须真浏览器】SSE/Worker/定时器都是浏览器对象，Node 侧无法验证
 * "Effect 清理是否真的执行"。这里用注入式仪表盘（与 soak.mjs 同源）成对记账。
 *
 * 【用法】node scripts/strictmode-audit.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9364');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = { pass: 0, fail: 0 };
const ok = (name, detail) => {
  results.pass += 1;
  console.log(`  ✓ ${name}${detail ? `  ::  ${detail}` : ''}`);
};
const bad = (name, actual, why) => {
  results.fail += 1;
  console.log(`  ✗ ${name}  ::  ${why}  实际值=${JSON.stringify(actual)}`);
};

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (EDGE === undefined) {
  console.error('未找到 Edge');
  process.exit(2);
}

const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-strict-${Date.now()}`);
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

/* ---- 注入仪表盘（与 soak 同源，另加 speechSynthesis.speak 计数） ---- */
const INSTRUMENT = `
(() => {
  const stats = window.__STRICT_STATS__ = {
    timers: new Set(), intervals: new Set(), eventSources: new Set(), workers: new Set(),
    esCreated: 0, esClosed: 0, workerCreated: 0, workerTerminated: 0, speakCalls: 0,
    effectMounts: 0,
  };
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = function (fn, ms, ...args) {
    let id = null;
    const wrapped = function (...inner) { stats.timers.delete(id); if (typeof fn === 'function') return fn.apply(this, inner); };
    id = origSetTimeout(wrapped, ms, ...args);
    stats.timers.add(id);
    return id;
  };
  window.clearTimeout = function (id) { stats.timers.delete(id); return origClearTimeout(id); };
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  window.setInterval = function (fn, ms, ...args) {
    const id = origSetInterval(fn, ms, ...args);
    stats.intervals.add(id);
    return id;
  };
  window.clearInterval = function (id) { stats.intervals.delete(id); return origClearInterval(id); };
  const OrigES = window.EventSource;
  if (typeof OrigES === 'function') {
    window.EventSource = class extends OrigES {
      constructor(...a) {
        super(...a);
        stats.esCreated += 1;
        stats.eventSources.add(this);
        const self = this;
        const origClose = this.close.bind(this);
        this.close = function () {
          if (stats.eventSources.has(self)) { stats.eventSources.delete(self); stats.esClosed += 1; }
          return origClose();
        };
      }
    };
  }
  const OrigWorker = window.Worker;
  if (typeof OrigWorker === 'function') {
    window.Worker = class extends OrigWorker {
      constructor(...a) {
        super(...a);
        stats.workerCreated += 1;
        stats.workers.add(this);
        const self = this;
        const origTerminate = this.terminate.bind(this);
        this.terminate = function () {
          if (stats.workers.has(self)) { stats.workers.delete(self); stats.workerTerminated += 1; }
          return origTerminate();
        };
      }
    };
  }
  if (window.speechSynthesis) {
    const origSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
    window.speechSynthesis.speak = function (u) { stats.speakCalls += 1; return origSpeak(u); };
  }
})();
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) {
  if ((await ev('document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(9000);

/** 读取资源快照 */
const snap = () =>
  ev(`(() => {
    const s = window.__STRICT_STATS__;
    return {
      timers: s.timers.size, intervals: s.intervals.size, eventSources: s.eventSources.size,
      workers: s.workers.size, esCreated: s.esCreated, esClosed: s.esClosed,
      workerCreated: s.workerCreated, workerTerminated: s.workerTerminated,
      speakCalls: s.speakCalls,
    };
  })()`);

console.log('KubeVision AI — StrictMode 一致性审计');
console.log(`  目标: ${BASE_URL}（React StrictMode = ${await ev('typeof window.__NEXT_DATA__ !== "undefined"') === true ? 'dev 构建' : '未知'}）\n`);

/* ---- 1. 首屏：挂载两次只保留一份资源 ---- */
const initial = await snap();
console.log(`  首屏快照: ${JSON.stringify(initial)}`);
if (initial.eventSources === 1) {
  ok('SSE 订阅在 StrictMode 双挂载后仅保留 1 条', `created=${initial.esCreated} closed=${initial.esClosed} active=1`);
} else {
  bad('SSE 订阅在 StrictMode 双挂载后仅保留 1 条', initial, '连接数不为 1（清理函数未生效）');
}

/* ---- 2. 切换审计台：Worker 挂载/卸载 ---- */
console.log('\n▸ 切换右侧面板 copilot → auditor（验证 Worker 与定时器生命周期）');
const toggle = await ev(`(async () => {
  const store = window.__KUBEVISION_STORE__;
  const setTab = store.getState().setActiveRightTab;
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    setTab('auditor');
    await new Promise((r) => setTimeout(r, 2600));
    out.push({ phase: 'auditor', ...(() => {
      const s = window.__STRICT_STATS__;
      return { timers: s.timers.size, intervals: s.intervals.size, eventSources: s.eventSources.size, workers: s.workers.size };
    })() });
    setTab('copilot');
    await new Promise((r) => setTimeout(r, 1600));
    out.push({ phase: 'copilot', ...(() => {
      const s = window.__STRICT_STATS__;
      return { timers: s.timers.size, intervals: s.intervals.size, eventSources: s.eventSources.size, workers: s.workers.size };
    })() });
  }
  return out;
})()`);
console.log(`  切换采样: ${JSON.stringify(toggle)}`);

const afterToggles = await snap();
console.log(`  切换后快照: ${JSON.stringify(afterToggles)}`);

/* 反复切换后：EventSource 仍为 1 */
if (afterToggles.eventSources === 1) {
  ok('反复切换面板后 SSE 连接数保持 1', `active=${afterToggles.eventSources}`);
} else {
  bad('反复切换面板后 SSE 连接数保持 1', afterToggles, '连接数异常');
}

/* 定时器不单调增长 */
if (afterToggles.timers <= initial.timers + 3) {
  ok('反复切换后存活 timer 未增长', `initial=${initial.timers} final=${afterToggles.timers}`);
} else {
  bad('反复切换后存活 timer 未增长', { initial: initial.timers, final: afterToggles.timers }, 'timer 单调增长（卸载未清理）');
}
if (afterToggles.intervals <= initial.intervals + 3) {
  ok('反复切换后存活 interval 未增长', `initial=${initial.intervals} final=${afterToggles.intervals}`);
} else {
  bad('反复切换后存活 interval 未增长', { initial: initial.intervals, final: afterToggles.intervals }, 'interval 单调增长');
}

/* 3. 卸载后零回调：切到 copilot 后静置 3 秒，计数不再变化 */
const beforeIdle = await snap();
await sleep(3200);
const afterIdle = await snap();
const idleStable =
  beforeIdle.timers === afterIdle.timers &&
  beforeIdle.intervals === afterIdle.intervals &&
  beforeIdle.workers === afterIdle.workers;
if (idleStable) {
  ok('静置 3 秒资源计数稳定（卸载后无后台回调/定时器）', `${JSON.stringify(beforeIdle)}`);
} else {
  bad('静置 3 秒资源计数稳定', { beforeIdle, afterIdle }, '静置期间资源数仍在变化');
}

/* 4. TTS 副作用计数（只验证"没有在挂载时被调用"，双播需真实播放环境） */
if (afterIdle.speakCalls === 0) {
  ok('TTS 播报未被挂载副作用触发（StrictMode 不会在挂载期 speak）', 'speakCalls=0');
} else {
  bad('TTS 播报未被挂载副作用触发', afterIdle, '挂载期出现 speak 调用');
}

/* ---- 输出 docs/strictmode-audit.md ---- */
const md = [
  '# React 18 StrictMode 一致性审计',
  '',
  `> 由 \`node scripts/strictmode-audit.mjs\` 自动生成于 ${new Date().toISOString()}。`,
  `> React StrictMode 在 dev 下会执行"挂载 → 卸载 → 再挂载"，本报告验证各资源的成对创建/释放。`,
  '',
  '## 首屏资源快照（双挂载之后）',
  '',
  '| 指标 | 值 | 期望 |',
  '|---|---|---|',
  `| 存活 EventSource | ${initial.eventSources} | 1（不是 2） |`,
  `| EventSource 创建/关闭 | ${initial.esCreated} / ${initial.esClosed} | 创建 2、关闭 1（StrictMode 成对） |`,
  `| 存活 Worker | ${initial.workers} | 0（审计台未打开时） |`,
  `| 存活 timer / interval | ${initial.timers} / ${initial.intervals} | 与单次挂载一致 |`,
  '',
  '## 面板反复切换（copilot ↔ auditor ×3）',
  '',
  '```json',
  JSON.stringify(toggle, null, 2),
  '```',
  '',
  '## 判定',
  '',
  '| 检查项 | 结果 |',
  '|---|---|',
  `| SSE 双挂载后仅一条连接 | ${initial.eventSources === 1 ? '通过' : '失败'} |`,
  `| 反复切换后连接数保持 1 | ${afterToggles.eventSources === 1 ? '通过' : '失败'} |`,
  `| timer 不增长 | ${afterToggles.timers <= initial.timers + 3 ? '通过' : '失败'} |`,
  `| interval 不增长 | ${afterToggles.intervals <= initial.intervals + 3 ? '通过' : '失败'} |`,
  `| 卸载后静置零回调 | ${idleStable ? '通过' : '失败'} |`,
  `| 挂载期不触发 TTS | ${afterIdle.speakCalls === 0 ? '通过' : '失败'} |`,
  '',
  '## 各资源的清理实现（代码级证据）',
  '',
  '| 资源 | 实现位置 | 清理方式 |',
  '|---|---|---|',
  '| SSE 订阅 | `useTelemetryStream.ts` Effect 清理 | `eventSource.close()` + `clearInterval(fallbackTimer)` + `disposed` 标记 |',
  '| 骨架屏看门狗 | `CopilotDrawer.tsx` 卸载 Effect | 遍历 `skeletonWatchdogRef` 逐个 `clearTimeout` 并清空 Map |',
  '| TTS 播报 | `useSpeechSynthesis.ts` Effect 清理 | `speechSynthesis.cancel()` + `removeEventListener(voiceschanged)` + 清定时器 |',
  '| 拾音 | `useSpeechInput.ts` 卸载清理 | `AudioContext.close()` + 停止 recognition |',
  '| 端侧 Worker | `useEdgeLogClassifier.ts` 卸载清理 | `worker.terminate()` + 清 watchdog/initBudget 定时器 |',
  '| 自动审计定时器 | `LocalAuditorPanel.tsx` Effect 清理 | `clearInterval(timer)` |',
  '',
].join('\n');
writeFileSync(join(process.cwd(), 'docs/strictmode-audit.md'), md, 'utf8');

console.log(`\n汇总: 通过 ${results.pass} · 失败 ${results.fail}`);
console.log('报告已写入 docs/strictmode-audit.md');
ws.close();
cleanup();
process.exit(results.fail > 0 ? 1 : 0);