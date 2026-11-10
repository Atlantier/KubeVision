#!/usr/bin/env node
/**
 * KubeVision AI — 第三张卡片（MCP 动作卡）渲染探针
 *
 * 【验证什么】
 * 1. 一轮故障诊断后，三张卡（指标 / 根因 / 自愈动作）都真实挂载；
 * 2. 动作卡不再停留在骨架屏（它在历史上因工具名别名不匹配而永远转圈）；
 * 3. 截图存档，作为"第三张卡片修复后"的视觉证据。
 *
 * 【为什么必须用真实浏览器】"卡片是否挂载、骨架是否消失"是 DOM 事实，
 * 协议单测只能证明服务端发了 tool-result，证明不了前端把它渲染成了卡片。
 *
 * 【用法】node scripts/probe-action-card.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9362');
const OUT_DIR = join(process.cwd(), 'docs/summit/shots/r17-action-card');
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
mkdirSync(OUT_DIR, { recursive: true });

const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-action-${Date.now()}`);
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

console.log('KubeVision AI — 第三张卡片渲染探针');
console.log(`  目标: ${BASE_URL}\n`);

/* ---- 1. 切到 Copilot 抽屉 ---- */
await ev(`(() => {
  const store = window.__KUBEVISION_STORE__;
  if (typeof store.getState().setActiveRightTab === 'function') {
    store.getState().setActiveRightTab('copilot');
  }
  return true;
})()`);
await sleep(800);
const drawerReady = await ev(`document.querySelector('[aria-label="AI Copilot 抽屉"]') !== null`);
if (drawerReady === true) ok('Copilot 抽屉已挂载');
else bad('Copilot 抽屉已挂载', drawerReady, '抽屉未出现');

/* ---- 2. 触发一轮故障诊断（直接驱动输入框：快捷提示在部分布局下不渲染） ---- */
const triggered = await ev(`(() => {
  const textarea = document.querySelector('textarea[aria-label="对话输入框"]');
  if (textarea === null) return { via: 'none', reason: 'textarea missing' };

  /* React 受控组件：必须用原生 value setter + input 事件，直接赋 value 不会更新 state */
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '诊断 OOMKilled 根因并生成自愈方案');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  /* Enter 发送（与用户敲回车完全同一条代码路径） */
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  return { via: 'textarea-enter', value: textarea.value };
})()`);
console.log(`  触发方式: ${JSON.stringify(triggered)}`);

/* ---- 3. 等待三张卡挂载（最多 75 秒） ---- */
let snapshot = null;
for (let i = 0; i < 150; i += 1) {
  await sleep(500);
  snapshot = await ev(`(() => {
    const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
    if (drawer === null) return null;
    const labels = Array.from(drawer.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label') || '');
    const skeletons = Array.from(drawer.querySelectorAll('[data-card-state="skeleton"]')).length
      + labels.filter((l) => l.includes('骨架')).length;
    return {
      metrics: labels.filter((l) => l.startsWith('Pod 指标卡')).length,
      rootCause: labels.filter((l) => l.startsWith('根因分析')).length,
      action: labels.filter((l) => l.startsWith('自愈操作确认')).length,
      skeletons,
      failedCards: labels.filter((l) => l.includes('无法渲染')).length,
    };
  })()`);
  if (snapshot !== null && snapshot.action >= 1) break;
}

console.log(`  卡片状态: ${JSON.stringify(snapshot)}`);
if (snapshot !== null && snapshot.metrics >= 1 && snapshot.rootCause >= 1 && snapshot.action >= 1) {
  ok('三张卡全部挂载（含第三张 MCP 动作卡）', `metrics=${snapshot.metrics} rootCause=${snapshot.rootCause} action=${snapshot.action}`);
} else {
  bad('三张卡全部挂载（含第三张 MCP 动作卡）', snapshot, '动作卡未挂载（历史缺陷：工具名别名不匹配）');
}

if (snapshot !== null && snapshot.skeletons === 0) {
  ok('无残留骨架屏（第三张卡不再无限转圈）');
} else {
  bad('无残留骨架屏', snapshot, '仍有骨架屏未水合');
}

if (snapshot !== null && snapshot.failedCards === 0) {
  ok('无失败态卡片（说明载荷与服务端配对完整）');
} else {
  bad('无失败态卡片', snapshot, '存在失败态卡片');
}

/* ---- 4. 截图存档 ---- */
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const base64 = shot?.result?.data;
if (typeof base64 === 'string' && base64.length > 0) {
  const file = join(OUT_DIR, 'third-card-after-fix.png');
  const fs = await import('node:fs');
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  ok('截图已存档', file.replace(process.cwd(), '.'));
} else {
  bad('截图已存档', null, 'captureScreenshot 未返回数据');
}

console.log(`\n汇总: 通过 ${results.pass} · 失败 ${results.fail}`);
ws.close();
cleanup();
process.exit(results.fail > 0 ? 1 : 0);