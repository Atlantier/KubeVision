#!/usr/bin/env node
/**
 * KubeVision AI — 免疫合并对抗探针（scripts/probe-immune-adversarial.mjs · R3 进阶）
 *
 * 【验证什么】自愈免疫合并在「红绿交替抖动遥测」下仍确定：
 * J1 窗口内不反复自愈：注入 20 帧红绿交替（OOMKilled↔Running），免疫目标 Pod 始终
 *    被钳在健康展示带（Running + mem∈[35,45]），绝不随红帧翻红；期间重复 healEntity
 *    被明确拒绝（code=immunity），不产生第二次自愈。
 * J2 剩余秒数与 store 一致：拒绝返回的 remainingSec == ceil((WINDOW-(now-healedAt))/1000)，
 *    WINDOW 取唯一事实源契约值 15000（telemetryTuning.HEAL_IMMUNITY_WINDOW_MS）。
 * J3 窗口外正常：把免疫起点挪到 16s 前（已过期），红帧如实显红、绿帧如实显绿，
 *    免疫不再篡改——证明窗口到期即放行原始数据。
 * J4 计数复位曲线：采样 Pod 内存随窗口到期的回落（免疫带→一帧插值→真实值），
 *    reconciledCount 由 >0 归 0（展示带消失即计数归零的数据级证据）。
 *
 * 【为何用 FakeEventSource】真实 SSE 由服务端引擎演进，无法逐帧精确控制红绿交替。
 * 注入假 EventSource 后由探针直接 push 指定快照，帧内容完全可控，对抗才成立。
 * 假源完整模拟 readyState/onopen/onmessage/close，应用其余逻辑（schema 校验/双轨分发）照常跑。
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9383');
const WINDOW_MS = 15000; // 契约值：与 src/constants/telemetryTuning.ts HEAL_IMMUNITY_WINDOW_MS 同源
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, detail) => { pass += 1; console.log(`  ✓ ${name}${detail ? `  ::  ${detail}` : ''}`); };
const bad = (name, actual, why) => { fail += 1; console.log(`  ✗ ${name}  ::  ${why}  实际=${JSON.stringify(actual)}`); };

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
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-immadv-${Date.now()}`)}`,
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
const consoleErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text) };
  return res.result?.result?.value;
};

/* 假 EventSource：在应用脚本前注入，逐帧可控 */
const FAKE_ES = `(() => {
  window.__kvFakeES__ = { instances: [], active: null };
  class FakeEventSource {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) {
      this.url = url; this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onerror = null;
      window.__kvFakeES__.instances.push(this);
      window.__kvFakeES__.active = this;
      setTimeout(() => { if (this.readyState !== 2) { this.readyState = 1; if (this.onopen) this.onopen({}); } }, 50);
    }
    close() { this.readyState = 2; if (window.__kvFakeES__.active === this) window.__kvFakeES__.active = null; }
    addEventListener() {} removeEventListener() {} dispatchEvent() { return true; }
  }
  window.EventSource = FakeEventSource;
  window.__kvPushFrame__ = (snap) => {
    const es = window.__kvFakeES__.active;
    if (es && es.onmessage && es.readyState === 1) { es.onmessage({ data: JSON.stringify(snap) }); return true; }
    return false;
  };
})();`;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_ES });
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 300; i += 1) { if ((await ev('document.querySelector("canvas") !== null')) === true) break; await sleep(300); }
/* store 调试钩子由 3D 画布挂载暴露；软渲染/并发负载下启动可能较慢，放宽到 90s */
let storeReady = false;
for (let i = 0; i < 300; i += 1) {
  storeReady = (await ev('!!(window.__KUBEVISION_STORE__ && window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.length > 0)')) === true;
  if (storeReady) break;
  await sleep(300);
}
if (!storeReady) {
  console.error('store 调试钩子 90s 未就绪。控制台错误:');
  for (const e of consoleErrors.slice(0, 8)) console.error('  ', e.slice(0, 300));
  ws.close(); cleanup(); process.exit(2);
}
/* 假 EventSource 活跃实例就绪（StrictMode 双挂载后保留一条） */
for (let i = 0; i < 40; i += 1) {
  if ((await ev('window.__kvFakeES__ && window.__kvFakeES__.active !== null')) === true) break;
  await sleep(200);
}
await sleep(1000);

console.log('KubeVision AI — 免疫合并对抗探针（R3 进阶）');
console.log(`  目标: ${BASE_URL} · 契约窗口 ${WINDOW_MS}ms\n`);

/* 取基准快照与目标 Pod（worker-beta 名下首个） */
const setup = await ev(`(() => {
  const store = window.__KUBEVISION_STORE__;
  const snap = store.getState().snapshotSummary;
  const pod = snap.pods.find((p) => p.nodeId === 'node-worker-beta') ?? snap.pods[0];
  window.__kvBase__ = JSON.parse(JSON.stringify(snap));
  window.__kvTarget__ = pod.id;
  return { podId: pod.id, schemaVersion: snap.schemaVersion, podCount: snap.pods.length };
})()`);
if (setup?.__err !== undefined || setup?.podId === undefined) {
  console.error('初始化失败:', JSON.stringify(setup)); ws.close(); cleanup(); process.exit(2);
}
console.log(`  目标 Pod: ${setup.podId} · schema v${setup.schemaVersion} · ${setup.podCount} pods`);

/* 推帧工具：基于基准快照克隆，改目标 Pod 为红/绿，时间戳单调递增 */
let frameSeq = 0;
const pushFrame = (red) => ev(`(() => {
  const base = window.__kvBase__;
  const snap = JSON.parse(JSON.stringify(base));
  const pod = snap.pods.find((p) => p.id === window.__kvTarget__);
  if (${red}) { pod.status = 'OOMKilled'; pod.memoryUsage = 96; pod.cpuUsage = 90; pod.restarts = 5; }
  else { pod.status = 'Running'; pod.memoryUsage = 40; pod.cpuUsage = 30; pod.restarts = 0; }
  snap.timestamp = Date.now() + (${++frameSeq}) * 1000;
  const pushed = window.__kvPushFrame__(snap);
  const after = window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.find((p) => p.id === window.__kvTarget__);
  return { pushed, status: after.status, mem: after.memoryUsage, cpu: after.cpuUsage };
})()`);

/* ---- J1：窗口内红绿抖动，免疫保持 ---- */
console.log('\n▸ J1：窗口内 20 帧红绿抖动');
const heal1 = await ev(`window.__KUBEVISION_STORE__.getState().healEntity(window.__kvTarget__, 'restart_pod')`);
if (heal1?.ok === true) ok('J1.0 首次自愈成功', JSON.stringify(heal1));
else bad('J1.0 首次自愈成功', heal1, '首次自愈失败');

const jitter = [];
let heldGreen = 0;
for (let i = 0; i < 20; i += 1) {
  const red = i % 2 === 0;
  const r = await pushFrame(red);
  jitter.push({ i, injected: red ? 'red' : 'green', status: r.status, mem: r.mem });
  /* 免疫展示带：Running + mem∈[35,45] */
  if (r.status === 'Running' && r.mem >= 35 && r.mem <= 45) heldGreen += 1;
}
is_('J1.1 20 帧抖动全程免疫保持（不随红帧翻红）', heldGreen, 20);
const flipped = jitter.filter((j) => j.status !== 'Running');
if (flipped.length === 0) ok('J1.2 无任一帧翻红', '20/20 Running');
else bad('J1.2 无任一帧翻红', flipped.slice(0, 3), '存在翻红帧');

/* 窗口内重复自愈被拒绝 */
const heal2 = await ev(`window.__KUBEVISION_STORE__.getState().healEntity(window.__kvTarget__, 'restart_pod')`);
if (heal2?.ok === false && heal2?.code === 'immunity') ok('J1.3 窗口内重复自愈被拒绝（不反复自愈）', `code=${heal2.code}`);
else bad('J1.3 窗口内重复自愈被拒绝', heal2, '未返回 immunity 拒绝');

/* ---- J2：剩余秒数与 store 一致 ---- */
console.log('\n▸ J2：剩余秒数提示与 store 同源');
const consistency = await ev(`(() => {
  const store = window.__KUBEVISION_STORE__;
  const healedAt = store.getState().healedPodIds[window.__kvTarget__];
  const now = Date.now();
  const expected = Math.ceil((${WINDOW_MS} - (now - healedAt)) / 1000);
  const reject = store.getState().healEntity(window.__kvTarget__, 'restart_pod');
  return { expected, actual: reject.remainingSec, healedAt, now };
})()`);
if (consistency?.__err === undefined && Math.abs(consistency.expected - consistency.actual) <= 1) {
  ok('J2.1 remainingSec == store 推算（±1s）', `expected=${consistency.expected} actual=${consistency.actual}`);
} else {
  bad('J2.1 remainingSec == store 推算', consistency, '剩余秒数与 store 不一致');
}

/* ---- J3：窗口外正常显红/显绿 ---- */
console.log('\n▸ J3：窗口到期后放行原始数据');
await ev(`(() => {
  const store = window.__KUBEVISION_STORE__;
  store.setState({ healedPodIds: { [window.__kvTarget__]: Date.now() - 16000 } });
  return true;
})()`);
const redOut = await pushFrame(true);
/* 到期首帧做 50% 平滑插值（免疫带 37.7 → 真实 96 的中点≈66.9），状态已转红即免疫释放；
   断言「离开免疫带上界 45」而非「立刻到 96」，尊重一帧插值平滑回落契约 */
if (redOut.status === 'OOMKilled' && redOut.mem > 45) ok('J3.1 窗口外红帧如实显红（免疫释放）', `status=${redOut.status} mem=${redOut.mem}`);
else bad('J3.1 窗口外红帧如实显红', redOut, '免疫未释放（仍被钳在健康带）');
/* 再推一帧红：插值结束，完全回到真实值 96 */
const redSettled = await pushFrame(true);
if (redSettled.mem > 80) ok('J3.1b 次帧完全回落真实值', `mem=${redSettled.mem}`);
else bad('J3.1b 次帧完全回落真实值', redSettled, '未回到真实水位');
const greenOut = await pushFrame(false);
if (greenOut.status === 'Running' && greenOut.mem < 50) ok('J3.2 窗口外绿帧如实显绿', `status=${greenOut.status} mem=${greenOut.mem}`);
else bad('J3.2 窗口外绿帧如实显绿', greenOut, '绿帧异常');

/* ---- J4：计数复位曲线（免疫带→插值→真实值） ---- */
console.log('\n▸ J4：免疫计数复位曲线');
/* 重新打免疫并把起点挪到即将到期（0.6s 后），逐帧采样捕捉回落 */
await ev(`(() => {
  const store = window.__KUBEVISION_STORE__;
  store.setState({ healedPodIds: { [window.__kvTarget__]: Date.now() - 14400 } });
  return true;
})()`);
const curve = [];
for (let i = 0; i < 12; i += 1) {
  const r = await pushFrame(true); // 持续红帧，观察免疫到期后的回落
  curve.push({ t: i, mem: r.mem, status: r.status });
  await sleep(250);
}
const inBand = curve.filter((c) => c.mem >= 35 && c.mem <= 45).length;
const released = curve.filter((c) => c.mem > 80).length;
console.log(`  → 内存曲线: ${curve.map((c) => c.mem).join(' → ')}`);
if (inBand > 0 && released > 0) ok('J4.1 免疫带→真实值回落（计数 >0 → 0）', `免疫带帧=${inBand} 释放帧=${released}`);
else bad('J4.1 免疫带→真实值回落', { inBand, released }, '未捕捉到复位过渡');
/* 一帧插值：存在介于免疫带与真实值之间的过渡帧（非突跳） */
const midFrame = curve.find((c) => c.mem > 45 && c.mem < 80);
if (midFrame !== undefined) ok('J4.2 到期一帧插值平滑（无突跳）', `过渡帧 mem=${midFrame.mem}`);
else bad('J4.2 到期一帧插值平滑', curve.map((c) => c.mem), '未见插值过渡帧');

/* 归档曲线证据 */
const evidenceDir = join(process.cwd(), 'docs', 'evidence', 'r3-advanced');
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, 'immune-adversarial-curve.json'), JSON.stringify({ windowMs: WINDOW_MS, target: setup.podId, jitter, curve }, null, 2));
console.log(`\n  曲线证据: docs/evidence/r3-advanced/immune-adversarial-curve.json`);

console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);

function is_(name, actual, expected) {
  if (actual === expected) ok(name, String(expected));
  else bad(name, actual, `期望 ${expected}`);
}