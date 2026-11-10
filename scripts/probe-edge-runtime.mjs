#!/usr/bin/env node
/**
 * KubeVision AI — 端侧审计运行时探针（scripts/probe-edge-runtime.mjs）
 *
 * 【验证 B1 / B5 的运行时事实】
 * 1. 审计面板的运行时徽标必须是三态之一（WebGPU / WASM SIMD / 内置分类器），
 *    且带 data-runtime 便于断言——B5 要求"当前运行时必须在面板显示"；
 * 2. 引擎初始化期间或降级后，面板的审计按钮**不得永久 disabled**
 *    ——B1 的死锁点就是看门狗超时后 isReady 仍为 false；
 * 3. 面板出现"当前运行时"文字，明确模型是否参与推理。
 *
 * 【为什么必须真浏览器】isReady 门禁直接体现在 DOM 的 disabled 属性上，
 * 这是产品事实，不是代码事实。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9365');
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
    '--window-size=1680,1000',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-edge-${Date.now()}`)}`,
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
await sleep(8000);

console.log('KubeVision AI — 端侧审计运行时探针');
console.log(`  目标: ${BASE_URL}\n`);

/* ---- 切到审计台 ---- */
await ev(`(() => {
  const store = window.__KUBEVISION_STORE__;
  if (typeof store.getState().setActiveRightTab === 'function') store.getState().setActiveRightTab('auditor');
  return true;
})()`);
await sleep(6000);

const snapshot = await ev(`(() => {
  const badge = document.querySelector('[data-runtime]');
  const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]') ?? document.body;
  const text = drawer.innerText || '';
  const buttons = Array.from(document.querySelectorAll('button'));
  const auditButton = buttons.find((b) => /开始|审计|分类/.test(b.textContent || '') && !/关闭/.test(b.textContent || ''));
  return {
    runtime: badge === null ? null : badge.getAttribute('data-runtime'),
    badgeLabel: badge === null ? null : (badge.textContent || '').trim(),
    runtimeLineShown: /当前运行时/.test(text),
    auditButtonFound: auditButton !== undefined,
    auditButtonDisabled: auditButton === undefined ? null : auditButton.disabled === true,
    bodyHasFallback: /内置确定性分类器|builtin/.test(text),
  };
})()`);

console.log(`  快照: ${JSON.stringify(snapshot)}`);

/* 1. 运行时徽标三态 */
if (snapshot !== null && ['webgpu', 'wasm', 'builtin'].includes(snapshot.runtime)) {
  ok('运行时徽标为三态之一', `data-runtime=${snapshot.runtime} · ${snapshot.badgeLabel}`);
} else {
  bad('运行时徽标为三态之一', snapshot, '缺少 data-runtime 或值不在三态内（B5）');
}

/* 2. 面板显示"当前运行时" */
if (snapshot !== null && snapshot.runtimeLineShown === true) {
  ok('面板明确显示"当前运行时"文字');
} else {
  bad('面板明确显示"当前运行时"文字', snapshot, '未找到运行时说明（B5）');
}

/* 3. 审计按钮不得永久 disabled（B1） */
if (snapshot !== null && snapshot.auditButtonFound === true && snapshot.auditButtonDisabled === false) {
  ok('审计按钮可用（未因 isReady 死锁永久禁用）');
} else {
  bad('审计按钮可用', snapshot, '按钮未找到或仍禁用（B1 死锁）');
}

console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);