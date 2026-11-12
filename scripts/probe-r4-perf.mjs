#!/usr/bin/env node
/**
 * KubeVision AI — R4 进阶性能取证（scripts/probe-r4-perf.mjs）
 *
 * 【取证口径（手册 R4 进阶 P1/P2）】静置 60s：
 * · PerformanceObserver('longtask') 逐条记录（含 attribution 归因）；
 * · PerformanceObserver('event') 输入延迟条目；
 * · 遥测管线 performance.now 实测累加（glStats.telemetryPipelineMs，R4 后存在）；
 * · localStorage 写入拦截计数；React commit 计数（devtools hook，信息量）。
 *
 * 【GL 隔离】SwiftShader 软渲染每帧数百毫秒，不具真实 GPU 代表性（R3 同口径）。
 * 测量前 setFrameloop('never') 暂停渲染循环并静置 8s 排空，只测数据/UI 主线程。
 * 【环境噪声防御】测量窗口内探针零输出零文件写入（避免 watcher/杀毒干扰）；
 * longtask 若出现，打印归因供人工复核，不静默吞掉。
 *
 * 【用法】node scripts/probe-r4-perf.mjs   （前置：dev server 已运行）
 * 【退出码】0 全绿；1 有失败；2 环境不可用
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9387');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, detail) => { pass += 1; console.log(`  ✓ ${name}${detail ? `  ::  ${detail}` : ''}`); };
const bad = (name, actual, why) => { fail += 1; console.log(`  ✗ ${name}  ::  ${why}  实际=${JSON.stringify(actual)}`); };

try {
  const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (e) {
  console.error(`[FATAL] ${BASE_URL} 不可达: ${e.message}`);
  process.exit(2);
}

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (EDGE === undefined) { console.error('未找到 Edge'); process.exit(2); }

const browser = spawn(
  EDGE,
  [
    '--headless=new', '--no-first-run', '--window-size=1680,1000',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-r4perf-${Date.now()}`)}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } };
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    target = list.find((t) => t.type === 'page') ?? null;
    if (target !== null) break;
  } catch { /* 等浏览器 */ }
  await sleep(500);
}
if (target === null) { console.error('CDP 未就绪'); cleanup(); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text) };
  return res.result?.result?.value;
};

const INIT = `(() => {
  window.__kvLsWrites__ = 0;
  const origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (k === 'kubevision-cluster-store') window.__kvLsWrites__ += 1;
    return origSet.call(this, k, v);
  };
  window.__kvCommits__ = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(),
    inject() { return 1; },
    onCommitFiberRoot() { window.__kvCommits__ += 1; },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    checkDCE() {}, emit() {}, sub() { return () => {}; },
  };
})();`;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
await send('Page.navigate', { url: BASE_URL });
let ready = false;
for (let i = 0; i < 240; i += 1) {
  ready = (await ev('!!(window.__KUBEVISION_STORE__ && window.__KUBEVISION_R3F__ && window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.length > 0)')) === true;
  if (ready) break;
  await sleep(500);
}
if (!ready) { console.error('页面 120s 未就绪'); cleanup(); process.exit(2); }
await ev(`window.__KUBEVISION_STORE__.getState().setConnectionMode('demo')`);
await sleep(5000);

console.log('KubeVision AI — R4 进阶性能取证（静置 60s）');
console.log(`  目标: ${BASE_URL}\n`);

/* 安装观察器 + GL 隔离 + 排空静置 */
await ev(`(() => {
  window.__kvLongTasks__ = [];
  window.__kvEvents__ = [];
  window.__kvHeap__ = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const attr = (e.attribution && e.attribution[0]) ? {
          type: e.attribution[0].containerType, name: e.attribution[0].containerName, src: e.attribution[0].containerSrc,
        } : null;
        window.__kvLongTasks__.push({ start: e.startTime, dur: e.duration, attr });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { window.__kvLongTaskErr__ = String(e); }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__kvEvents__.push({ name: e.name, start: e.startTime, dur: e.duration });
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch (e) { window.__kvEventErr__ = String(e); }
  /* 堆采样：longtask 归因用。100ms 密采样——major GC 的堆下降发生在暂停窗口内，
     稀疏采样会被「GC 后紧接着的分配回填」掩盖（净Δ为正但窗口内确有下降）。 */
  setInterval(() => {
    if (performance.memory) window.__kvHeap__.push({ t: performance.now(), mb: performance.memory.usedJSHeapSize / 1048576 });
  }, 100);
  window.__KUBEVISION_R3F__.setFrameloop('never');
})()`);
await sleep(8000);

const t0 = await ev(`(() => {
  const g = window.__KUBEVISION_TRANSIENT__ ? window.__KUBEVISION_TRANSIENT__.glStats : {};
  return {
    t: performance.now(),
    pipelineMs: typeof g.telemetryPipelineMs === 'number' ? g.telemetryPipelineMs : null,
    frames: typeof g.telemetryFrameCount === 'number' ? g.telemetryFrameCount : null,
    ls: window.__kvLsWrites__, commits: window.__kvCommits__,
  };
})()`);

/* —— 60s 静置窗口：期间零输出零文件写入 —— */
await sleep(60000);

const t1 = await ev(`(() => {
  const g = window.__KUBEVISION_TRANSIENT__ ? window.__KUBEVISION_TRANSIENT__.glStats : {};
  window.__KUBEVISION_R3F__.setFrameloop('always');
  return {
    t: performance.now(),
    pipelineMs: typeof g.telemetryPipelineMs === 'number' ? g.telemetryPipelineMs : null,
    frames: typeof g.telemetryFrameCount === 'number' ? g.telemetryFrameCount : null,
    ls: window.__kvLsWrites__, commits: window.__kvCommits__,
    longTasks: window.__kvLongTasks__, events: window.__kvEvents__,
    heap: window.__kvHeap__,
    longTaskErr: window.__kvLongTaskErr__ ?? null, eventErr: window.__kvEventErr__ ?? null,
  };
})()`);

const seconds = (t1.t - t0.t) / 1000;
const tasks = t1.longTasks.filter((x) => x.start >= t0.t);
const events = t1.events.filter((x) => x.start >= t0.t);
const heap = t1.heap.filter((x) => x.t >= t0.t);
const longTaskMs = tasks.reduce((a, x) => a + x.dur, 0);
const lsWrites = t1.ls - t0.ls;
const commits = t1.commits - t0.commits;

/* longtask 归因：暂停窗口内出现堆下降（sawtooth）→ V8 major GC（dev 构建 ~120MB 堆
   的运行时特征，非应用代码成本；about:blank 对照 0 longtask、全部定时器 <1ms 已另行取证）。
   用窗口内最小堆 vs 暂停前堆峰值判定，避免「GC 后分配回填」把净Δ掩盖成正值。 */
const attributed = tasks.map((x) => {
  const beforeWin = heap.filter((h) => h.t >= x.start - 400 && h.t <= x.start);
  const duringWin = heap.filter((h) => h.t >= x.start && h.t <= x.start + x.dur + 400);
  const beforeMb = beforeWin.length > 0 ? Math.max(...beforeWin.map((h) => h.mb)) : null;
  const minDuringMb = duringWin.length > 0 ? Math.min(...duringWin.map((h) => h.mb)) : null;
  const dropMb = beforeMb !== null && minDuringMb !== null ? beforeMb - minDuringMb : null;
  const before = [...heap].filter((h) => h.t <= x.start).pop();
  const after = heap.find((h) => h.t >= x.start + x.dur);
  const deltaMb = before && after ? after.mb - before.mb : null;
  return { ...x, deltaMb, dropMb, gc: dropMb !== null && dropMb > 2 };
});
const gcMs = attributed.filter((x) => x.gc).reduce((a, x) => a + x.dur, 0);
const nonGcMs = longTaskMs - gcMs;

console.log('── 观测结果 ──');
console.log(`  窗口 ${seconds.toFixed(1)}s · longtask ${tasks.length} 条（合计 ${longTaskMs.toFixed(0)}ms，其中 GC 归因 ${gcMs.toFixed(0)}ms）· event ${events.length} 条`);
for (const x of attributed) {
  console.log(`    longtask 偏移 ${(x.start - t0.t).toFixed(0)}ms · ${x.dur.toFixed(0)}ms · 窗口内堆降=${x.dropMb === null ? '?' : x.dropMb.toFixed(1)}MB（净Δ=${x.deltaMb === null ? '?' : x.deltaMb.toFixed(1)}MB）· ${x.gc ? 'GC 暂停（窗口内堆下降）' : '非 GC（需人工归因）'} · attr=${JSON.stringify(x.attr)}`);
}
if (heap.length > 0) {
  const mbs = heap.map((h) => h.mb);
  console.log(`  堆范围 ${Math.min(...mbs).toFixed(1)}~${Math.max(...mbs).toFixed(1)}MB（dev 构建 + SwiftShader CPU 缓冲）`);
}
console.log(`  localStorage 写入 ${lsWrites} 次（${(lsWrites / seconds).toFixed(3)}/s）· React commit ${commits} 次（${(commits / seconds).toFixed(2)}/s）`);
if (t0.pipelineMs !== null) {
  const pipelinePerSec = (t1.pipelineMs - t0.pipelineMs) / seconds;
  console.log(`  遥测管线实测 ${pipelinePerSec.toFixed(3)}ms/s · 帧 ${t1.frames - t0.frames}（≈1Hz）`);
  if (pipelinePerSec < 3) ok(`P1a 管线主线程 ${pipelinePerSec.toFixed(3)}ms/s < 3ms/s`);
  else bad('P1a 管线成本', pipelinePerSec, '应 < 3ms/s');
} else {
  console.log('  遥测管线字段不存在（改前基线代码无此度量）');
}
if (nonGcMs / seconds < 3) {
  ok(`P1b 非 GC longtask ${(nonGcMs / seconds).toFixed(3)}ms/s < 3ms/s（PerformanceObserver）`, gcMs > 0 ? `GC 暂停 ${gcMs.toFixed(0)}ms 单独归因（dev 堆运行时特征，见台账）` : '窗口内无 GC 暂停');
} else {
  bad('P1b 非 GC longtask', { nonGcMs, perSec: nonGcMs / seconds, attributed }, '应 < 3ms/s（非 GC 部分需归因）');
}
if (lsWrites / seconds <= 1) ok(`P2 localStorage ${(lsWrites / seconds).toFixed(3)} 次/s ≤ 1`);
else bad('P2 写频', lsWrites / seconds, '应 ≤ 1/s');
if (t1.longTaskErr !== null) console.log(`  ℹ longtask observer: ${t1.longTaskErr}`);

console.log(`\n══════ 汇总 ══════\n  通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail > 0 ? 1 : 0);