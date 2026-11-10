#!/usr/bin/env node
/**
 * KubeVision AI — 回执防篡改 UI 探针（scripts/probe-receipt-verify.mjs）
 *
 * 【验证 Q5 的产品行为】
 * 1. 自愈动作执行成功后，回执区出现「校验回执」按钮；
 * 2. 点击后现场复算 auditDigest，一致 → 绿色"校验通过"；
 * 3. 把页面里 Web Crypto 的 digest 替换成错误结果（模拟摘要被篡改/不一致），
 *    再点一次 → 出现红色"校验失败"。
 *
 * 【为什么用 monkeypatch 制造失败】真实篡改需要改服务端回执，端到端环境无法
 * 稳定构造；而 UI 的失败分支只取决于"复算结果 ≠ 回执值"，替换 digest 实现
 * 能精确命中该分支，且不修改任何产品代码。
 *
 * 【用法】node scripts/probe-receipt-verify.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9370');
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
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-receipt-${Date.now()}`)}`,
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
await sleep(9000);

console.log('KubeVision AI — 回执防篡改 UI 探针');
console.log(`  目标: ${BASE_URL}\n`);

/* ---- 1. 触发一轮故障诊断并等待动作卡 ---- */
await ev(`(() => {
  const store = window.__KUBEVISION_STORE__;
  if (typeof store.getState().setActiveRightTab === 'function') store.getState().setActiveRightTab('copilot');
  return true;
})()`);
await sleep(800);

await ev(`(() => {
  const textarea = document.querySelector('textarea[aria-label="对话输入框"]');
  if (textarea === null) return { ok: false };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '诊断 OOMKilled 根因并生成自愈方案');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  return { ok: true };
})()`);

let cardReady = false;
for (let i = 0; i < 120; i += 1) {
  await sleep(600);
  const found = await ev(`document.querySelector('[aria-label^="自愈操作确认"]') !== null`);
  if (found === true) {
    cardReady = true;
    break;
  }
}
if (cardReady) ok('动作卡已挂载');
else bad('动作卡已挂载', null, '等待超时');

/* ---- 2. 执行自愈动作，等待回执 ---- */
const executed = await ev(`(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const exec = buttons.find((b) => (b.textContent || '').includes('立即执行自愈方案'));
  if (exec === undefined) return { ok: false, reason: 'execute button missing' };
  exec.click();
  return { ok: true };
})()`);
if (executed?.ok === true) ok('已点击「立即执行自愈方案」');
else bad('已点击「立即执行自愈方案」', executed, '执行按钮未找到');

let verifyButtonFound = false;
for (let i = 0; i < 100; i += 1) {
  await sleep(600);
  const found = await ev(`document.querySelector('button[aria-label="校验回执摘要是否与字段一致"]') !== null`);
  if (found === true) {
    verifyButtonFound = true;
    break;
  }
}
if (verifyButtonFound) ok('回执区出现「校验回执」按钮');
else bad('回执区出现「校验回执」按钮', null, '未找到按钮（回执未返回？）');

/* ---- 3. 正常校验：应显示绿色通过 ---- */
if (verifyButtonFound) {
  await ev(`(() => {
    const b = document.querySelector('button[aria-label="校验回执摘要是否与字段一致"]');
    if (b !== null) b.click();
    return true;
  })()`);
  let okState = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(400);
    const state = await ev(`(() => {
      const el = document.querySelector('[data-digest-check]');
      return el === null ? null : { state: el.getAttribute('data-digest-check'), text: (el.textContent || '').trim().slice(0, 120) };
    })()`);
    if (state?.state === 'ok') {
      okState = state;
      break;
    }
  }
  if (okState !== null) ok('校验通过（绿色）', okState.text);
  else bad('校验通过（绿色）', null, '未出现 data-digest-check="ok"');
}

/* ---- 4. 制造摘要不一致：替换 Web Crypto digest 后再校验 ---- */
const tampered = await ev(`(() => {
  if (typeof crypto === 'undefined' || crypto.subtle === undefined) return { ok: false, reason: 'no subtle' };
  window.__origDigest = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = async () => new Uint8Array(32).fill(9).buffer;
  const b = document.querySelector('button[aria-label="校验回执摘要是否与字段一致"]');
  if (b === null) return { ok: false, reason: 'button missing' };
  b.click();
  return { ok: true };
})()`);

if (tampered?.ok === true) ok('已注入摘要不一致（monkeypatch crypto.subtle.digest）');
else bad('已注入摘要不一致', tampered, 'monkeypatch 失败');

let failState = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(400);
  const state = await ev(`(() => {
    const el = document.querySelector('[data-digest-check="fail"]');
    if (el === null) return null;
    const cls = el.className || '';
    return { text: (el.textContent || '').trim().slice(0, 140), isRose: cls.includes('rose') };
  })()`);
  if (state !== null) {
    failState = state;
    break;
  }
}
if (failState !== null) ok('校验失败显示红色告警', failState.text);
else bad('校验失败显示红色告警', null, '未出现 data-digest-check="fail"');

if (failState !== null) {
  if (failState.isRose === true) ok('失败态使用 rose 红色样式');
  else bad('失败态使用 rose 红色样式', failState, '未检测到 rose 类');
}

/* 恢复 digest 实现，避免影响后续 */
await ev(`(() => { if (window.__origDigest) crypto.subtle.digest = window.__origDigest; return true; })()`);

console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);