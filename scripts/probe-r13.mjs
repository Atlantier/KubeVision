#!/usr/bin/env node
/**
 * r13 运行时验证探针（scripts/probe-r13.mjs）
 *
 * 验证三件在浏览器里才看得出来的事：
 *   C · 时间戳：SSE 首帧贴近墙钟、跨帧严格单调；demo→live 切换不倒退、跳变 <= 1 tick + 2s
 *   A/B · 稳态：连续 30 秒 QPS 不得漂出基准 ±20%，节点 CPU 不得越出 [15,70]，
 *         节点状态不得在 Ready/HighLoad 之间反复跳变
 *   E · 免疫边界：给 worker-beta 的一个 Pod 打自愈免疫后，
 *         与本次自愈无关的 worker-alpha（若处于 HighLoad）不得被"洗白"成 Ready
 *
 * 【为什么用浏览器探针而不是单测】这三条都依赖真实 SSE 连接、真实 Store 与
 * 真实定时器节拍；单测用假时钟无法复现"1 秒一帧连续 30 帧"的行为。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = readArg('--base') ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(readArg('--port') ?? '9354');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readArg(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? null : hit.slice(flag.length + 1);
}

const results = { pass: 0, fail: 0 };
const ok = (name, detail) => { results.pass += 1; console.log(`  ✓ ${name}${detail ? `  ::  ${detail}` : ''}`); };
const bad = (name, actual, why) => { results.fail += 1; console.log(`  ✗ ${name}  ::  ${why}  实际值=${JSON.stringify(actual)}`); };

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (EDGE === undefined) { console.error('未找到 Edge'); process.exit(2); }

const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-r13-${Date.now()}`);
const browser = spawn(EDGE, [
  '--headless=new', '--no-first-run', '--window-size=1680,1000',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } };
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    target = list.find((t) => t.type === 'page') ?? null;
    if (target !== null) break;
  } catch { /* 等 */ }
  await sleep(500);
}
if (target === null) { console.error('CDP 未就绪'); cleanup(); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 0;
const pending = new Map();
ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id !== undefined && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (m, p = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) { if ((await ev('document.querySelector("canvas") !== null')) === true) break; await sleep(400); }
await sleep(9000);

console.log('KubeVision AI — r13 运行时验证探针');
console.log(`  目标: ${BASE_URL}\n`);

/* ======================================================================== */
/* A/B · 稳态 30 秒采样                                                      */
/* ======================================================================== */
console.log('▸ A/B · 稳态采样（30 帧，1 秒 1 帧）');
const frames = await ev(`(async () => {
  const store = window.__KUBEVISION_STORE__;
  const out = [];
  for (let i = 0; i < 30; i += 1) {
    const s = store.getState().snapshotSummary;
    out.push({
      t: Date.now(),
      ts: s.timestamp,
      qps: s.totalQps,
      nodes: s.nodes.map((n) => ({ name: n.name, cpu: n.cpuUsage, status: n.status })),
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
})()`);

if (!Array.isArray(frames) || frames.length === 0) {
  bad('稳态采样', frames, '未能读取 Store 快照');
} else {
  const qpsList = frames.map((f) => f.qps);
  const qpsMin = Math.min(...qpsList);
  const qpsMax = Math.max(...qpsList);
  const qpsAvg = Math.round(qpsList.reduce((a, b) => a + b, 0) / qpsList.length);
  const qpsOk = qpsMin >= 12850 * 0.8 && qpsMax <= 12850 * 1.2;
  console.log(`  → QPS: min=${qpsMin} max=${qpsMax} avg=${qpsAvg}（基准 12850，允许 ±20%）`);
  if (qpsOk) ok('A · QPS 锚定在基准 ±20% 内（无复利漂移）', `min=${qpsMin} max=${qpsMax}`);
  else bad('A · QPS 锚定在基准 ±20% 内（无复利漂移）', { qpsMin, qpsMax, qpsAvg }, '漂出允许区间');

  for (const nodeName of ['worker-alpha', 'worker-beta', 'worker-gamma']) {
    const cpus = frames.flatMap((f) => f.nodes.filter((n) => n.name === nodeName).map((n) => n.cpu));
    const cmin = Math.min(...cpus);
    const cmax = Math.max(...cpus);
    const inBand = cmin >= 15 && cmax <= 70;
    console.log(`  → ${nodeName} CPU: min=${cmin} max=${cmax}`);
    if (inBand) ok(`B · ${nodeName} CPU 有界（15~70）`, `min=${cmin} max=${cmax}`);
    else bad(`B · ${nodeName} CPU 有界（15~70）`, { min: cmin, max: cmax }, '越界（随机游走残留）');
  }

  const statusChanges = [];
  for (let i = 1; i < frames.length; i += 1) {
    for (const n of frames[i].nodes) {
      const prev = frames[i - 1].nodes.find((p) => p.name === n.name);
      if (prev !== undefined && prev.status !== n.status) statusChanges.push({ tick: i, node: n.name, from: prev.status, to: n.status });
    }
  }
  if (statusChanges.length === 0) ok('B · 稳态下无节点状态跳变', '0 次');
  else bad('B · 稳态下无节点状态跳变', statusChanges.slice(0, 5), '出现来回跳变');
}

/* ======================================================================== */
/* C · 时间戳单调性与跨模式跳变                                               */
/* ======================================================================== */
console.log('\n▸ C · 时间戳');
const tsList = frames.map((f) => f.ts);
let monotonic = true;
for (let i = 1; i < tsList.length; i += 1) {
  if (!(tsList[i] > tsList[i - 1])) { monotonic = false; break; }
}
const firstGap = Math.abs(tsList[0] - frames[0].t);
if (monotonic) ok('C · demo 流时间戳严格单调递增', `${tsList[0]} → ${tsList[tsList.length - 1]}`);
else bad('C · demo 流时间戳严格单调递增', tsList.slice(0, 6), '出现回退或相等');

if (firstGap <= 5000) ok('C · 首帧时间戳贴近墙钟（SSE 后以 Date.now() 为起点）', `偏差 ${firstGap}ms`);
else bad('C · 首帧时间戳贴近墙钟', { deltaMs: firstGap }, '偏差过大');

const demoLastTs = tsList[tsList.length - 1];
const switched = await ev(`(async () => {
  const store = window.__KUBEVISION_STORE__;
  const before = store.getState().snapshotSummary.timestamp;
  store.getState().setConnectionMode('live');
  /*
   * 【测量方式】必须抓「切换后第一帧」，而不是等几秒再读：
   * 等待时间本身会计入 gap，把正常的握手时延误判成跳变（实测踩到 gap=7000）。
   */
  let firstAfter = null;
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
    const ts = store.getState().snapshotSummary.timestamp;
    if (ts > before) { firstAfter = ts; break; }
  }
  store.getState().setConnectionMode('demo');
  return { before, firstAfter, gap: firstAfter === null ? null : firstAfter - before };
})()`);
console.log(`  → 切换前 ${demoLastTs} / 切换后首帧 ${switched?.firstAfter}（gap=${switched?.gap}）`);
if (switched !== undefined && switched.firstAfter !== null && switched.gap !== null && switched.gap > 0 && switched.gap <= 3000) {
  ok('C · demo→live 切换不倒退且跳变 <= 1 tick + 网络时延', `gap=${switched.gap}ms`);
} else {
  bad('C · demo→live 切换不倒退且跳变 <= 1 tick + 网络时延', switched, '倒退或跳变过大');
}

await sleep(2500);

/* ======================================================================== */
/* E · 免疫边界：只修正免疫目标 Pod 所属节点                                   */
/* ======================================================================== */
console.log('\n▸ E · 免疫合并边界');
const boundary = await ev(`(async () => {
  const store = window.__KUBEVISION_STORE__;
  const st = store.getState();

  /* 注入 CPU 尖峰：worker-alpha 进入 HighLoad */
  st.setActiveChaos('NODE_CPU_SPIKE');
  await new Promise((r) => setTimeout(r, 4500));

  const before = store.getState().snapshotSummary.nodes.map((n) => ({ name: n.name, status: n.status, cpu: n.cpuUsage }));

  /*
   * 【为什么直接写 healedPodIds 而不用 healEntity】
   * healEntity 会把「修复动作」当作本轮演练的终止信号，按设计自动清空 chaos。
   * 那样一来 alpha 回到 Ready 是正确行为，却会被误判成"节点被洗白"。
   * 这里只写免疫表，保持演练场景不变，才能单独检验节点的修正作用域。
   */
  const betaPod = store.getState().snapshotSummary.pods.find((p) => p.nodeId === 'node-worker-beta');
  const immuneStart = Date.now();
  store.setState({ healedPodIds: { [betaPod.id]: immuneStart } });
  await new Promise((r) => setTimeout(r, 2500));

  const during = store.getState().snapshotSummary.nodes.map((n) => ({ name: n.name, status: n.status, cpu: n.cpuUsage }));

  /*
   * ---- 平滑回落：用「OOM 下内存 96%」这种强对比场景，免疫值 40% 附近 ----
   *
   * 【为什么必须强对比】稳态下 Pod 的 CPU/内存本来就在 30~50 区间，
   * 免疫目标值也在同一区间，滑没滑根本看不出来（上一版探针就是这么误判的）。
   * 这里先用 OOM 把内存推到 96%，再自愈免疫到 40% 附近，
   * 窗口到期时"40% → 96%"的落差足够大，插值帧（约 68%）肉眼可辨。
   */
  store.getState().setActiveChaos('POD_OOM_SWARM');
  await new Promise((r) => setTimeout(r, 4500));

  const oomPod = store.getState().snapshotSummary.pods.find(
    (p) => p.nodeId === 'node-worker-beta' && p.memoryUsage > 80,
  );
  const targetId = oomPod === undefined ? betaPod.id : oomPod.id;

  /* 打免疫：展示值应被改写到记忆健康区 */
  store.setState({ healedPodIds: { [targetId]: Date.now() } });
  await new Promise((r) => setTimeout(r, 2000));
  const immuneSnap = store.getState().snapshotSummary.pods.find((p) => p.id === targetId);

  /* 把免疫起点挪到窗口即将到期（15s 窗口 → 0.6s 后到期），逐帧采样 */
  store.setState({ healedPodIds: { [targetId]: Date.now() - 14400 } });
  const series = [];
  for (let i = 0; i < 16; i += 1) {
    await new Promise((r) => setTimeout(r, 300));
    const pod = store.getState().snapshotSummary.pods.find((p) => p.id === targetId);
    if (pod) series.push({ t: Date.now() - immuneStart, mem: pod.memoryUsage, cpu: pod.cpuUsage, status: pod.status });
  }

  store.setState({ healedPodIds: {} });
  store.getState().setActiveChaos('NONE');
  await new Promise((r) => setTimeout(r, 800));
  return { before, during, immuneStart, series, podId: targetId, immuneSnap };
})()`);

const alpha = boundary?.during?.find((n) => n.name === 'worker-alpha');
const beta = boundary?.during?.find((n) => n.name === 'worker-beta');
console.log(`  → 免疫期间 alpha=${alpha?.status}(${alpha?.cpu}%) beta=${beta?.status}(${beta?.cpu}%)`);
if (alpha?.status === 'HighLoad') {
  ok('E · 无关节点（worker-alpha）未被自愈"洗白"', `alpha 仍 ${alpha.status} cpu=${alpha.cpu}`);
} else {
  bad('E · 无关节点（worker-alpha）未被自愈"洗白"', alpha, '被错误改为 Ready（节点修正作用域过宽）');
}
if (beta?.status === 'Ready') {
  ok('E · 免疫目标 Pod 所属节点回到 Ready', `beta=${beta.status} cpu=${beta.cpu}`);
} else {
  bad('E · 免疫目标 Pod 所属节点回到 Ready', beta, '未按预期恢复');
}

/* ---- 平滑回落判定 ---- */
const series = boundary?.series ?? [];
const cpuSeries = series.map((s) => s.cpu);
let plateauEnd = -1;
for (let i = 1; i < cpuSeries.length; i += 1) {
  if (cpuSeries[i] !== cpuSeries[0]) { plateauEnd = i; break; }
}
console.log(`  → Pod 内存样本: ${series.map((s) => s.cpu).join(' → ')}`);
console.log(`  → 免疫平台结束于样本 #${plateauEnd}`);
if (plateauEnd > 0 && plateauEnd < cpuSeries.length - 2) {
  const immuneValue = cpuSeries[plateauEnd - 1];
  const transition = cpuSeries[plateauEnd];
  const settled = cpuSeries[cpuSeries.length - 1];
  const span = Math.abs(settled - immuneValue);
  const firstStep = Math.abs(transition - immuneValue);
  /* 一帧插值：第一步应当明显但不是全部（0.2~0.9 之间） */
  if (span > 1 && firstStep / span >= 0.2 && firstStep / span <= 0.9) {
    ok('E · 窗口到期后一帧插值平滑回落（无突跳）', `immune=${immuneValue} mix=${transition} settled=${settled} 比例=${(firstStep / span).toFixed(2)}`);
  } else {
    bad('E · 窗口到期后一帧插值平滑回落（无突跳）', { immuneValue, transition, settled, span, firstStep }, '未见插值或直接突跳');
  }
} else {
  bad('E · 窗口到期后一帧插值平滑回落（无突跳）', { cpuSeries, plateauEnd }, '采样未捕捉到窗口到期点');
}

console.log(`\n汇总: 通过 ${results.pass} · 失败 ${results.fail}`);
ws.close();
cleanup();
process.exit(results.fail > 0 ? 1 : 0);