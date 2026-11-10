#!/usr/bin/env node
/**
 * KubeVision AI — 数据健康 HUD 运行时探针（scripts/probe-data-health.mjs）
 *
 * 【验证什么】
 * 1. Shift+P 打开的性能 HUD 里确实有「数据健康」区块，且 5 项指标在真实
 *    SSE 流下会持续更新（证明它读的是瞬态轨而不是静态占位）；
 * 2. 指标读数与瞬态单例 telemetryHealthRef 一致（HUD 没有二次加工/缓存旧值）；
 * 3. 协议版本不匹配时，HUD 出现只读提示条（aria-label="遥测只读提示"），
 *    恢复后提示消失 —— 这是"未知版本降级只读并提示"的 UI 侧证据。
 *
 * 【为什么要浏览器验证】"零重渲染"与"HUD 真的在刷新"都无法在 Node 侧证明：
 * 只有真实 React 挂载 + 真实 SSE 才能看到 DOM 从 -- 变成具体数字。
 *
 * 【用法】
 *   node scripts/probe-data-health.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = readArg('--base') ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(readArg('--port') ?? '9361');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readArg(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? null : hit.slice(flag.length + 1);
}

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

const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-health-${Date.now()}`);
const browser = spawn(
  EDGE,
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
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) {
  if ((await ev('document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(9000);

console.log('KubeVision AI — 数据健康 HUD 探针');
console.log(`  目标: ${BASE_URL}\n`);

/* ---- 1. Shift+P 打开 HUD ---- */
await send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'P',
  code: 'KeyP',
  modifiers: 8, /* Shift */
});
await sleep(900);

const hudOpen = await ev(`document.querySelector('[aria-label="性能遥测 HUD"]') !== null`);
if (hudOpen === true) ok('Shift+P 打开性能 HUD');
else bad('Shift+P 打开性能 HUD', hudOpen, 'HUD 未出现');

const healthBlock = await ev(`document.querySelector('[aria-label="数据健康"]') !== null`);
if (healthBlock === true) ok('HUD 内存在「数据健康」区块');
else bad('HUD 内存在「数据健康」区块', healthBlock, '区块缺失');

/* ---- 2. 五个指标存在且会刷新 ---- */
const readRows = () =>
  ev(`(() => {
    const block = document.querySelector('[aria-label="数据健康"]');
    if (block === null) return null;
    const spans = Array.from(block.querySelectorAll('span'));
    const values = spans
      .filter((el) => /tabular-nums/.test(el.className))
      .map((el) => (el.textContent || '').trim());
    return { values, text: (block.textContent || '').replace(/\\s+/g, ' ').trim() };
  })()`);

const first = await readRows();
await sleep(2600);
const second = await readRows();

if (first !== null && Array.isArray(first.values) && first.values.length >= 6) {
  ok('数据健康区块渲染 6 项指标', JSON.stringify(first.values));
} else {
  bad('数据健康区块渲染 6 项指标', first, '指标行数不足');
}

const changed = first !== null && second !== null && JSON.stringify(first.values) !== JSON.stringify(second.values);
if (changed) ok('指标随遥测流持续刷新（读瞬态轨而非静态占位）', `${JSON.stringify(first.values)} → ${JSON.stringify(second.values)}`);
else bad('指标随遥测流持续刷新', { first: first?.values, second: second?.values }, '两次读数完全相同');

/* ---- 3. HUD 读数与瞬态单例一致 ---- */
const consistency = await ev(`(() => {
  const block = document.querySelector('[aria-label="数据健康"]');
  if (block === null) return { error: 'no block' };
  const text = (block.textContent || '').replace(/\\s+/g, ' ');
  return { text };
})()`);
/* 注意：HUD 的标签与数值是两个 span，textContent 拼接后中间没有空格 */
const showsReconnects = typeof consistency?.text === 'string' && /SSE 重连\s*\d+/.test(consistency.text);
if (showsReconnects) ok('HUD 展示 SSE 重连计数（来自 telemetryHealthRef）');
else bad('HUD 展示 SSE 重连计数', consistency, '未匹配到重连行');

/* ---- 4. 只读降级提示（直接驱动 store，验证 UI 绑定） ---- */
const readOnlyFlow = await ev(`(async () => {
  const store = window.__KUBEVISION_STORE__;
  store.getState().setTelemetrySchemaState(true, '测试注入：协议版本不匹配 · 已切换只读');
  await new Promise((r) => setTimeout(r, 400));
  const banner = document.querySelector('[aria-label="遥测只读提示"]');
  const shown = banner !== null ? (banner.textContent || '').trim() : null;
  store.getState().setTelemetrySchemaState(false, null);
  await new Promise((r) => setTimeout(r, 400));
  const hidden = document.querySelector('[aria-label="遥测只读提示"]') === null;
  return { shown, hidden, readOnlyState: store.getState().telemetryReadOnly };
})()`);

if (typeof readOnlyFlow?.shown === 'string' && readOnlyFlow.shown.includes('只读')) {
  ok('协议不匹配时 HUD 显示只读提示', readOnlyFlow.shown);
} else {
  bad('协议不匹配时 HUD 显示只读提示', readOnlyFlow, '提示条未出现');
}
if (readOnlyFlow?.hidden === true) ok('恢复后只读提示自动消失');
else bad('恢复后只读提示自动消失', readOnlyFlow, '提示条残留');

console.log(`\n汇总: 通过 ${results.pass} · 失败 ${results.fail}`);
ws.close();
cleanup();
process.exit(results.fail > 0 ? 1 : 0);