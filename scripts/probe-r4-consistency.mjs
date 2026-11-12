#!/usr/bin/env node
/**
 * KubeVision AI — R4 数据可信度探针（scripts/probe-r4-consistency.mjs）
 *
 * 【验证什么（R4 Main 验收）】
 * X1 同一 Pod CPU 三处一致：3D 瞬态槽位值 == 面板 snapshotSummary == 复盘环形缓冲帧，
 *    逐 Pod 全量比对（误差 ≤1%，实测应为 0）；
 * X2 三处健康分相等且无地板：三处读数相等，且等于独立罚分表重算值；
 *    注入 OOM 混沌后分数必须真实下降（地板会把它托住，本断言专杀地板）；
 * X5 双标签页 live 一致非 0：两条独立 SSE 连接读同一份单一采样器广播，
 *    节点 CPU 逐值相等且总体 > 0；
 * P1 静置成本：遥测管线主线程耗时 < 3ms/秒（performance.now 实测累加）；
 * P2 localStorage 写入 ≤ 1 次/秒（setItem 拦截计数）；
 * P3 seq 去重计数稳态为 0、帧计数 ≈ 1Hz（时间轴无重复帧）。
 *
 * 【取证方式】全部为运行期实测：CDP Runtime.evaluate 直读双轨 + 环形缓冲，
 * 独立罚分表写在探针内（不 import 被测代码，防止"自己验自己"）。
 * SwiftShader 软渲染的 GL 耗时不计入管线成本（与渲染开销分离，见 glStats 契约）。
 *
 * 【前置】dev server 已运行（pnpm dev）。
 * 【用法】node scripts/probe-r4-consistency.mjs
 * 【退出码】0 全绿；1 有断言失败；2 环境不可用
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9384');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, detail) => { pass += 1; console.log(`  ✓ ${name}${detail ? `  ::  ${detail}` : ''}`); };
const bad = (name, actual, why) => { fail += 1; console.log(`  ✗ ${name}  ::  ${why}  实际=${JSON.stringify(actual)}`); };

/* ---- dev server 可达性 ---- */
try {
  const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (e) {
  console.error(`[FATAL] ${BASE_URL} 不可达（先 pnpm dev）: ${e.message}`);
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
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-r4cons-${Date.now()}`)}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } };
process.on('exit', cleanup);

/* ---- 等待 CDP 端口就绪（浏览器冷启动需要时间） ---- */
let cdpReady = false;
for (let i = 0; i < 60; i += 1) {
  try {
    await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    cdpReady = true;
    break;
  } catch { /* 等浏览器 */ }
  await sleep(500);
}
if (!cdpReady) { console.error('CDP 未就绪'); cleanup(); process.exit(2); }

/* ---- CDP 连接工具（每页一条 WebSocket） ---- */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text) };
    return res.result?.result?.value;
  };
  return { ws, send, ev, errors };
}

async function newPage(url, initScript) {
  const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) })).json();
  if (t?.webSocketDebuggerUrl === undefined) throw new Error(`创建页面失败: ${JSON.stringify(t)}`);
  const page = await attach(t.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  if (initScript !== undefined) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
  await page.send('Page.navigate', { url });
  return page;
}

/* 独立罚分表（与 src/utils/clusterHealth.ts 锁定模型同值，但独立书写作为 oracle） */
const ORACLE_SCORE = `(snap) => {
  let penalty = 0;
  for (const n of snap.nodes) {
    if (n.status === 'NetworkPartition') penalty += 15;
    else if (n.status === 'HighLoad') penalty += 6;
  }
  for (const p of snap.pods) {
    if (p.status === 'OOMKilled') penalty += 5;
    else if (p.status === 'CrashLoopBackOff') penalty += 4;
    else if (p.status === 'Pending' || p.status === 'Terminating') penalty += 0.5;
  }
  for (const a of snap.activeAlerts) {
    if (a.level === 'P0') penalty += 3;
    else if (a.level === 'P1') penalty += 1.5;
    else penalty += 0.5;
  }
  return Math.round(Math.min(100, Math.max(0, 100 - penalty)));
}`;

/* 计数器注入：localStorage 写入拦截 + React commit 计数（信息量） */
const COUNTERS = `(() => {
  window.__kvLsWrites__ = 0;
  const origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (k === 'kubevision-cluster-store') window.__kvLsWrites__ += 1;
    return origSet.call(this, k, v);
  };
  window.__kvCommits__ = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject() { return 1; },
    onCommitFiberRoot() { window.__kvCommits__ += 1; },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    emit() {},
    sub() { return () => {}; },
  };
})();`;

console.log('KubeVision AI — R4 数据可信度探针');
console.log(`  目标: ${BASE_URL}\n`);

/* ====================================================================== */
/* 页面 A：demo 模式（X1 / X2 / P1 / P2 / P3）                              */
/* ====================================================================== */
const pageA = await newPage(BASE_URL, COUNTERS);
let ready = false;
for (let i = 0; i < 300; i += 1) {
  ready = (await pageA.ev('!!(window.__KUBEVISION_STORE__ && window.__KUBEVISION_TRANSIENT__ && window.__KUBEVISION_FRAMES__ && window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.length > 0)')) === true;
  if (ready) break;
  await sleep(300);
}
if (!ready) {
  console.error('页面 A 90s 未就绪:', pageA.errors.slice(0, 5));
  cleanup(); process.exit(2);
}
/* 确保 demo 模式（持久化可能残留 live） */
await pageA.ev(`window.__KUBEVISION_STORE__.getState().setConnectionMode('demo')`);
await sleep(3000);

console.log('── X1 · 同一 Pod CPU 三处一致（3D 槽位 / 面板 / 复盘缓冲）──');
{
  let totalPods = 0;
  let mismatches = 0;
  let maxErrPct = 0;
  for (let round = 0; round < 5; round += 1) {
    const r = await pageA.ev(`(() => {
      const store = window.__KUBEVISION_STORE__.getState();
      const transient = window.__KUBEVISION_TRANSIENT__;
      const frames = window.__KUBEVISION_FRAMES__(2);
      const report = frames[frames.length - 1];
      const reportById = new Map(report.pods.map((p) => [p.id, p]));
      const out = [];
      for (const pod of store.snapshotSummary.pods) {
        const slot = transient.podSlotById.get(pod.id);
        const gl = slot === undefined ? null : transient.podCpuFloat32[slot];
        const rp = reportById.get(pod.id);
        out.push({ id: pod.id, panel: pod.cpuUsage, gl, report: rp ? rp.cpuUsage : null });
      }
      return out;
    })()`);
    if (r?.__err !== undefined) { bad('X1 采样', r.__err, 'evaluate 异常'); break; }
    for (const row of r) {
      totalPods += 1;
      if (row.gl === null || row.report === null) { mismatches += 1; continue; }
      const err = Math.max(Math.abs(row.gl - row.panel), Math.abs(row.report - row.panel));
      const pct = row.panel > 0 ? (err / row.panel) * 100 : err;
      if (pct > maxErrPct) maxErrPct = pct;
      if (pct > 1) mismatches += 1;
    }
    await sleep(1200);
  }
  if (mismatches === 0 && totalPods > 0) {
    ok(`X1 ${totalPods} 个 Pod×轮次全量一致`, `最大误差 ${maxErrPct.toFixed(3)}%（阈值 1%）`);
  } else {
    bad('X1 三处 CPU 一致性', { totalPods, mismatches, maxErrPct }, '存在超差或缺失');
  }
}

console.log('\n── X2 · 三处健康分相等 + 独立罚分表重算（无地板）──');
{
  const readScore = `(() => {
    const store = window.__KUBEVISION_STORE__.getState();
    const transient = window.__KUBEVISION_TRANSIENT__;
    const frames = window.__KUBEVISION_FRAMES__(2);
    const report = frames[frames.length - 1];
    const snap = store.snapshotSummary;
    return {
      panel: snap.clusterHealthScore,
      gl: transient.snapshot.clusterHealthScore,
      report: report.clusterHealthScore,
      oracle: (${ORACLE_SCORE})(snap),
      alerts: snap.activeAlerts.length,
      abnormalPods: snap.pods.filter((p) => p.status !== 'Running').length,
    };
  })()`;
  const steady = await pageA.ev(readScore);
  if (steady.panel === steady.gl && steady.gl === steady.report && steady.panel === steady.oracle) {
    ok('X2a 稳态三处相等且等于罚分表重算', JSON.stringify(steady));
  } else {
    bad('X2a 稳态健康分', steady, '三处不等或偏离罚分模型（疑似地板）');
  }

  /* 注入 OOM 混沌：分数必须真实下降——地板会把分数托在高位，本断言专杀地板 */
  await pageA.ev(`window.__KUBEVISION_STORE__.getState().setActiveChaos('POD_OOM_SWARM')`);
  await sleep(4500);
  const chaos = await pageA.ev(readScore);
  if (chaos.panel === chaos.gl && chaos.gl === chaos.report && chaos.panel === chaos.oracle && chaos.abnormalPods > 0 && chaos.panel < 100) {
    ok('X2b 混沌下三处相等、无地板、分数真实下降', JSON.stringify(chaos));
  } else {
    bad('X2b 混沌健康分', chaos, '应三处相等 == oracle 且 < 100（有异常 Pod）');
  }
  await pageA.ev(`window.__KUBEVISION_STORE__.getState().setActiveChaos('NONE')`);
  await sleep(2000);
}

console.log('\n── P1/P2/P3 · 静置 30s 成本取证 ──');
{
  const before = await pageA.ev(`(() => ({
    pipelineMs: window.__KUBEVISION_TRANSIENT__.glStats.telemetryPipelineMs,
    frames: window.__KUBEVISION_TRANSIENT__.glStats.telemetryFrameCount,
    stale: window.__KUBEVISION_TRANSIENT__.glStats.staleSeqFrames,
    lsWrites: window.__kvLsWrites__,
    commits: window.__kvCommits__,
    t: performance.now(),
  }))()`);
  await sleep(30000);
  const after = await pageA.ev(`(() => ({
    pipelineMs: window.__KUBEVISION_TRANSIENT__.glStats.telemetryPipelineMs,
    frames: window.__KUBEVISION_TRANSIENT__.glStats.telemetryFrameCount,
    stale: window.__KUBEVISION_TRANSIENT__.glStats.staleSeqFrames,
    lsWrites: window.__kvLsWrites__,
    commits: window.__kvCommits__,
    t: performance.now(),
  }))()`);
  const seconds = (after.t - before.t) / 1000;
  const pipelinePerSec = (after.pipelineMs - before.pipelineMs) / seconds;
  const lsPerSec = (after.lsWrites - before.lsWrites) / seconds;
  const frames = after.frames - before.frames;
  const staleDelta = after.stale - before.stale;
  const commits = after.commits - before.commits;

  if (pipelinePerSec < 3) ok(`P1 管线主线程成本 ${pipelinePerSec.toFixed(3)}ms/s < 3ms/s`, `${seconds.toFixed(1)}s 窗口，帧数 ${frames}`);
  else bad('P1 管线成本', pipelinePerSec, '应 < 3ms/s');

  if (lsPerSec <= 1) ok(`P2 localStorage 写入 ${lsPerSec.toFixed(3)} 次/s ≤ 1`, `共 ${after.lsWrites - before.lsWrites} 次`);
  else bad('P2 localStorage 写频', lsPerSec, '应 ≤ 1 次/s');

  if (staleDelta === 0 && frames >= Math.floor(seconds * 0.8)) {
    ok(`P3 帧计数 ${frames} 帧/${seconds.toFixed(0)}s（≈1Hz），seq 重复帧 ${staleDelta}`, '时间轴无重复');
  } else {
    bad('P3 帧率/去重', { frames, staleDelta, seconds }, '帧率应 ≈1Hz 且无重复帧');
  }
  console.log(`  ℹ React commit 计数（信息量）: ${commits} 次/${seconds.toFixed(0)}s —— frameCount 已移瞬态轨，page 根不再 1Hz 重渲染`);
}

/* ====================================================================== */
/* 页面 B/C：live 模式双标签页（X5）                                         */
/* ====================================================================== */
console.log('\n── X5 · 双标签页 live 一致非 0（单一采样器广播）──');
/*
 * 【先释放页面 A】同源 localStorage 是共享的：A 的 demo 持久化每秒落盘，
 * 会覆盖 B/C 注入的 live 种子；A 的 SwiftShader 渲染也会抢 GPU。
 * 导航到 about:blank 即卸载应用（SSE 断开 → 采样器退订，顺带验证 release 路径）。
 */
await pageA.send('Page.navigate', { url: 'about:blank' });
await sleep(1500);

const LIVE_SEED = `(() => {
  try {
    localStorage.setItem('kubevision-cluster-store', JSON.stringify({
      state: { connectionMode: 'live', totalMaskedSecrets: 0, remediationHistory: [], terminalLogs: [] },
      version: 1,
    }));
  } catch (e) { /* ignore */ }
})();`;
const readLive = `(() => {
  const st = window.__KUBEVISION_STORE__ && window.__KUBEVISION_STORE__.getState();
  if (!st) return null;
  const snap = st.snapshotSummary;
  return {
    mode: st.connectionMode,
    nodes: snap.nodes.map((n) => ({ id: n.id, cpu: n.cpuUsage, mem: n.memUsage })),
    podCpus: snap.pods.slice(0, 8).map((p) => p.cpuUsage),
    source: (snap.activeAlerts[0] && snap.activeAlerts[0].message || '').slice(0, 24),
  };
})()`;

/* 串行打开两个 live 页（软渲染下并发挂载会互相拖慢 Canvas 初始化） */
const pageB = await newPage(BASE_URL, LIVE_SEED);
let bReady = false;
for (let i = 0; i < 360; i += 1) {
  const b = await pageB.ev(readLive);
  if (b && b.mode === 'live' && b.nodes.length > 0 && b.source.includes('LIVE-OS-BRIDGE')) { bReady = true; break; }
  await sleep(500);
}
const pageC = await newPage(BASE_URL, LIVE_SEED);
let cReady = false;
for (let i = 0; i < 360; i += 1) {
  const c = await pageC.ev(readLive);
  if (c && c.mode === 'live' && c.nodes.length > 0 && c.source.includes('LIVE-OS-BRIDGE')) { cReady = true; break; }
  await sleep(500);
}
if (!bReady || !cReady) {
  bad('X5 live 就绪', { bReady, cReady, b: await pageB.ev(readLive), c: await pageC.ev(readLive) }, '180s 内未进入 live 宿主机桥接');
} else {
  await sleep(3000);
  let matched = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const b = await pageB.ev(readLive);
    const c = await pageC.ev(readLive);
    const sameNodes = JSON.stringify(b.nodes) === JSON.stringify(c.nodes);
    const samePods = JSON.stringify(b.podCpus) === JSON.stringify(c.podCpus);
    const nonZero = b.nodes.some((n) => n.cpu > 0) && b.podCpus.some((v) => v > 0);
    if (sameNodes && samePods && nonZero) { matched = { b, c }; break; }
    await sleep(350);
  }
  if (matched !== null) {
    ok('X5 双连接节点/Pod CPU 逐值相等且非 0', `节点=${JSON.stringify(matched.b.nodes)} · 来源=${matched.b.source}`);
  } else {
    bad('X5 双标签页一致性', { b: await pageB.ev(readLive), c: await pageC.ev(readLive) }, '12 次采样未出现一致非零读数');
  }
}

/* ---- 控制台错误汇总 ---- */
const allErrors = [...pageA.errors, ...pageB.errors, ...pageC.errors]
  .filter((e) => !/SwiftShader|swiftshader|GPU|WebGL/i.test(e));
if (allErrors.length === 0) ok('控制台无新增运行时错误（三页合计）');
else bad('控制台错误', allErrors.slice(0, 5), '存在运行时异常');

console.log(`\n══════ 汇总 ══════\n  通过 ${pass} · 失败 ${fail}`);
pageA.ws.close(); pageB.ws.close(); pageC.ws.close();
cleanup();
process.exit(fail > 0 ? 1 : 0);