#!/usr/bin/env node
/**
 * KubeVision AI — Esc 提示 chip 与语音错误态探针（scripts/probe-voice-esc-ui.mjs）
 *
 * 【验证三件事】
 * Q3：底部 .kv-chip 随弹层变化显示"Esc 关闭：<最上层名>"；
 * Q2：语音失败时给出**具体原因**（权限 / 不支持 / 网络）并提供"重试"按钮；
 * Q3 一致性：chip 的文案与 Esc 实际行为一致（按 Esc 后对应弹层关闭、chip 消失/切换）。
 *
 * 【环境说明】无头 Edge 没有麦克风设备，getUserMedia 会失败——这正好覆盖
 * "不支持/无设备"错误分支；有真实麦克风的环境会跳过该断言（日志中标注）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9373');
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
const is = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name, JSON.stringify(expected));
  else bad(name, actual, `期望 ${JSON.stringify(expected)}`);
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
    '--window-size=1440,900',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-vui-${Date.now()}`)}`,
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
const pressEscape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(420);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) {
  if ((await ev('document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(9000);

console.log('KubeVision AI — Esc 提示 chip 与语音错误态探针');
console.log(`  目标: ${BASE_URL}\n`);

/** 读取 chip 状态 */
const chipState = () =>
  ev(`(() => {
    const chip = document.querySelector('.kv-chip');
    return chip === null
      ? { visible: false, label: null }
      : { visible: true, label: chip.getAttribute('aria-label'), text: (chip.textContent || '').trim() };
  })()`);

/* ---- Q3：chip 随弹层出现 ---- */
console.log('▸ Q3：Esc 提示 chip');
is('3.0 初始无弹层时 chip 不显示', (await chipState()).visible, false);

await ev(`(() => { window.__KUBEVISION_STORE__.getState().setChaosModalOpen(true); return true; })()`);
for (let i = 0; i < 40; i += 1) {
  if ((await ev(`document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]') !== null`)) === true) break;
  await sleep(150);
}
await sleep(300);
const chaosChip = await chipState();
is('3.1 打开混沌弹窗后 chip 出现', chaosChip.visible, true);
is('3.2 chip 文案指向最上层弹层', chaosChip.label, 'Esc 关闭：混沌演练控制台');

await pressEscape();
/* 弹窗退场动画期间 chip 仍会显示，轮询等待卸载完成 */
let chipHidden = false;
for (let i = 0; i < 25; i += 1) {
  await sleep(100);
  if ((await chipState()).visible === false) { chipHidden = true; break; }
}
is('3.3 Esc 关闭后 chip 消失', chipHidden, true);

/* ---- Q3：命令面板 chip ---- */
await ev(`(() => { const b = document.querySelector('button[aria-label="打开运维命令面板"]'); if (b) b.click(); return true; })()`);
await sleep(1200);
const paletteChip = await chipState();
is('3.4 命令面板打开时 chip 指向命令面板', paletteChip.label, 'Esc 关闭：运维命令面板');
await pressEscape();
await sleep(900);

/* ---- Q2：语音错误原因 + 重试 ---- */
console.log('\n▸ Q2：语音错误态');
await ev(`(() => { window.__KUBEVISION_STORE__.getState().setActiveRightTab('copilot'); return true; })()`);
await sleep(700);
const clicked = await ev(`(() => {
  const button = document.querySelector('button[aria-label="开始语音输入"]');
  if (button === null) return false;
  button.click();
  return true;
})()`);
if (clicked !== true) {
  bad('2.1 麦克风按钮可点击', null, '按钮未找到');
} else {
  await sleep(4000);
  const speechState = await ev(`(() => {
    const error = document.querySelector('[aria-label="语音输入错误提示"]');
    const retry = document.querySelector('button[aria-label="重试语音输入"]');
    const listening = document.querySelector('button[aria-label="完成语音输入"]') !== null;
    return {
      hasError: error !== null,
      errorText: error === null ? null : (error.textContent || '').trim(),
      hasRetry: retry !== null,
      listening,
    };
  })()`);
  console.log(`  语音状态: ${JSON.stringify(speechState)}`);
  if (speechState.listening === true) {
    ok('2.1 有麦克风设备：进入拾音（错误态断言跳过）');
  } else if (speechState.hasError === true) {
    ok('2.1 无麦克风时显示具体错误原因', speechState.errorText);
    if (speechState.hasRetry === true) ok('2.2 错误态提供"重试"按钮');
    else bad('2.2 错误态提供"重试"按钮', speechState, '未找到重试按钮');
    const specific = /权限|不支持|网络/.test(String(speechState.errorText ?? ''));
    if (specific) ok('2.3 错误原因属于权限/不支持/网络三类');
    else bad('2.3 错误原因属于权限/不支持/网络三类', speechState.errorText, '文案不具体');
  } else {
    bad('2.1 无麦克风时显示具体错误原因', speechState, '既未拾音也无错误提示');
  }
}

console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);