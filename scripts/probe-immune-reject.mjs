#!/usr/bin/env node
/**
 * KubeVision AI — 自愈免疫窗口拒绝语义探针（scripts/probe-immune-reject.mjs）
 *
 * 【验证 C2 的"二选一"落点：**明确拒绝**，而不是"排队但永不执行"】
 * 1. 第一次 healEntity → ok:true，快照进入愈合态；
 * 2. 30 秒免疫窗口内第二次 healEntity（同目标）→ ok:false、
 *    code='immunity'、remainingSec ∈ (0,30]；
 * 3. 终端必须出现 REJECTED 审计行；
 * 4. pendingRemediations 不得新增条目（队列已废弃，不再制造"稍后重试"的假承诺）。
 *
 * 【为何直接驱动 store】UI 的"执行"按钮在成功后进入 done 态不可再点；
 * 要验证"窗口内重复调用"的唯一稳定入口是 store 本身——这正是缺陷所在层。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9372');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, detail) => {
  pass += 1;
  console.log(`  ✓ ${name}${detail ? `  ::  ${detail}` : ''}`);
};
const bad = (name, actual, why) => {
  fail += 1;
  console.log(`  ✗ ${name}  ::  ${why}  实际=${JSON.stringify(actual)}`);
};

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (EDGE === undefined) {
  console.error('未找到 Edge');
  process.exit(2);
}

const browser = spawn(
  EDGE,
  [
    '--headless=new',
    '--no-first-run',
    '--window-size=1280,900',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-immune-${Date.now()}`)}`,
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
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) {
  if ((await ev('document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
/* 等待首帧遥测到货（pods 非空）后再驱动 store */
for (let i = 0; i < 60; i += 1) {
  const ready = await ev('window.__KUBEVISION_STORE__ && window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.length > 0');
  if (ready === true) break;
  await sleep(400);
}
await sleep(1200);

console.log('KubeVision AI — 自愈免疫窗口拒绝语义探针');
console.log(`  目标: ${BASE_URL}\n`);

const result = await ev(`(() => {
  const store = window.__KUBEVISION_STORE__;
  const state = store.getState();
  const pods = state.snapshotSummary.pods;
  /* 优先挑异常 Pod；没有就挑第一个 */
  const pod =
    pods.find((p) => p.status === 'OOMKilled' || p.status === 'CrashLoopBackOff' || p.status === 'Error') ?? pods[0];
  if (!pod) return { error: 'no pod' };

  const pendingBefore = state.pendingRemediations.length;
  const first = state.healEntity(pod.id, 'restart_pod');
  const afterFirst = store.getState();
  const pendingAfterFirst = afterFirst.pendingRemediations.length;
  const terminalAfterFirst = afterFirst.terminalLogs.slice(-3);

  const second = afterFirst.healEntity(pod.id, 'restart_pod');
  const afterSecond = store.getState();
  const pendingAfterSecond = afterSecond.pendingRemediations.length;
  const terminalAfterSecond = afterSecond.terminalLogs.slice(-4);

  return { podId: pod.id, pendingBefore, first, pendingAfterFirst, terminalAfterFirst, second, pendingAfterSecond, terminalAfterSecond };
})()`);

console.log(`  目标 Pod: ${result?.podId ?? '(none)'}`);
console.log(`  第一次: ${JSON.stringify(result?.first)}`);
console.log(`  第二次: ${JSON.stringify(result?.second)}`);

if (result?.first?.ok === true) ok('第一次自愈成功（ok:true）');
else bad('第一次自愈成功（ok:true）', result?.first, '首次自愈未成功');

if (result?.second?.ok === false && result?.second?.code === 'immunity') {
  ok('窗口内重复自愈被明确拒绝', `code=${result.second.code}`);
} else {
  bad('窗口内重复自愈被明确拒绝', result?.second, '未返回 immunity 拒绝');
}

const remaining = Number(result?.second?.remainingSec ?? -1);
if (remaining > 0 && remaining <= 30) ok('拒绝结果携带剩余秒数', `remainingSec=${remaining}`);
else bad('拒绝结果携带剩余秒数', { remaining }, 'remainingSec 不在 (0,30]');

if (String(result?.second?.message ?? '').includes('免疫窗口内不可重复自愈')) {
  ok('拒绝文案明确', result.second.message);
} else {
  bad('拒绝文案明确', result?.second?.message, '文案不匹配');
}

const rejectedLine = (result?.terminalAfterSecond ?? []).find((line) => String(line).includes('REJECTED'));
if (rejectedLine !== undefined) ok('终端写入 REJECTED 审计行', rejectedLine);
else bad('终端写入 REJECTED 审计行', result?.terminalAfterSecond, '未找到 REJECTED');

if (result?.pendingAfterSecond === result?.pendingBefore) {
  ok('未新增任何"排队重试"条目（不存在假承诺）', `pending=${result.pendingAfterSecond}`);
} else {
  bad('未新增任何"排队重试"条目', { before: result?.pendingBefore, after: result?.pendingAfterSecond }, '队列仍在增长');
}

console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);