#!/usr/bin/env node
/**
 * KubeVision AI — Esc 分级退出栈探针（scripts/probe-escape-stack.mjs）
 *
 * 【验证 C1 的行为矩阵】
 * 1. 一次 Esc 只退一层：混沌弹窗 + 性能 HUD + 3D 选中同时存在时，
 *    Esc 依次关闭 chaos → HUD → 清选中，**绝不合并**；
 * 2. 关闭弹窗不得顺带清选中（旧缺陷）；
 * 3. 命令面板 / RAG 知识库各自可被 Esc 关闭（注册式层）；
 * 4. 输入框内按 Esc 让位：焦点在 textarea 时任何弹层都不关闭。
 *
 * 【为什么用 CDP 真键盘事件】用 JS 合成 KeyboardEvent 只能验证我们的监听逻辑，
 * 验证不了"浏览器真实按键 + 焦点目标"的组合；Input.dispatchKeyEvent 更接近用户操作。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9371');
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
    '--window-size=1680,1000',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-esc-${Date.now()}`)}`,
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
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await sleep(320);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) {
  if ((await ev('document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(9000);

console.log('KubeVision AI — Esc 分级退出栈探针');
console.log(`  目标: ${BASE_URL}\n`);

/** 读取页面状态 */
const state = () =>
  ev(`(() => {
    const store = window.__KUBEVISION_STORE__.getState();
    return {
      chaos: store.isChaosModalOpen,
      hud: store.isPerfHudOpen,
      selected: store.selectedEntityId,
      ragOpen: document.querySelector('[aria-label="SRE 领域知识库"][role="dialog"]') !== null,
      commandOpen: document.querySelector('[role="dialog"][aria-label="运维命令面板"]') !== null,
    };
  })()`);

/* ---- 用例 1：一次 Esc 只退一层 ---- */
console.log('▸ 用例 1：chaos + HUD + 选中 同时存在');
const selectedPodId = await ev(`(() => {
  const store = window.__KUBEVISION_STORE__;
  const pod = store.getState().snapshotSummary.pods[0];
  if (!pod) return null;
  store.getState().setChaosModalOpen(true);
  store.getState().setPerfHudOpen(true);
  store.getState().selectEntity(pod.id, 'pod');
  return pod.id;
})()`);
/* 等待混沌弹窗真正挂载（懒加载 chunk 到货前 store 标志为 true 但层未注册） */
for (let i = 0; i < 40; i += 1) {
  const mounted = await ev(
    "document.querySelector('[role=\"dialog\"][aria-label=\"混沌工程故障演练控制台\"]') !== null",
  );
  if (mounted === true) break;
  await sleep(150);
}
await sleep(300);
const before1 = await state();
is('1.1 初始三层同时成立', [before1.chaos, before1.hud, before1.selected !== null], [true, true, true]);

await pressEscape();
const after1 = await state();
is('1.2 第一次 Esc 只关混沌弹窗', [after1.chaos, after1.hud, after1.selected !== null], [false, true, true]);

await pressEscape();
const after2 = await state();
is('1.3 第二次 Esc 只关性能 HUD', [after2.chaos, after2.hud, after2.selected !== null], [false, false, true]);

await pressEscape();
const after3 = await state();
is('1.4 第三次 Esc 才清选中', [after3.chaos, after3.hud, after3.selected !== null], [false, false, false]);
console.log(`  选中 Pod: ${selectedPodId}`);

/* ---- 用例 2：命令面板 ---- */
console.log('\n▸ 用例 2：命令面板');
await ev(`(() => { const b = document.querySelector('button[aria-label="打开运维命令面板"]'); if (b) b.click(); return true; })()`);
await sleep(900);
const paletteBefore = await state();
if (paletteBefore.commandOpen === true) {
  ok('2.1 命令面板已打开');
  await pressEscape();
  /* 面板关闭有退场动画（AnimatePresence）：轮询 2s 等待 DOM 真正移除 */
  let paletteClosed = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(100);
    if ((await state()).commandOpen === false) { paletteClosed = true; break; }
  }
  is('2.2 Esc 关闭命令面板', paletteClosed, true);
} else {
  bad('2.1 命令面板已打开', paletteBefore, '未找到命令面板（aria-label 可能变化）');
}

/* 无论用例 2 结果如何，确保命令面板已关闭（否则它会以优先级 100 抢走后续 Esc） */
for (let i = 0; i < 4; i += 1) {
  if ((await state()).commandOpen === false) break;
  await ev('document.body.focus(); if (document.activeElement) document.activeElement.blur(); true');
  await pressEscape();
}
is('2.9 用例 2 结束后命令面板已关闭（隔离后续用例）', (await state()).commandOpen, false);

/* ---- 用例 3：RAG 知识库弹窗 ---- */
console.log('\n▸ 用例 3：RAG 知识库');
await ev(`(() => { const store = window.__KUBEVISION_STORE__; store.getState().setActiveRightTab('copilot'); return true; })()`);
await sleep(600);
await ev(`(() => { const b = document.querySelector('button[aria-label="打开 SRE 领域知识库"]'); if (b) b.click(); return true; })()`);
await sleep(900);
const ragBefore = await state();
if (ragBefore.ragOpen === true) {
  ok('3.1 RAG 知识库已打开');
  /* 焦点在检索输入框：Esc 必须让位，不得关闭 */
  const focused = await ev(`(() => {
    const input = document.querySelector('[aria-label="故障描述检索输入"]');
    if (input === null) return false;
    input.focus();
    return document.activeElement === input;
  })()`);
  if (focused === true) {
    await pressEscape();
    is('3.2 输入框内 Esc 让位（RAG 不关闭）', (await state()).ragOpen, true);
    /* 焦点移出输入框后再按 Esc → 关闭 */
    await ev('document.body.focus(); document.activeElement && document.activeElement.blur(); true');
    await sleep(250);
    await pressEscape();
    is('3.3 焦点离开输入框后 Esc 关闭 RAG', (await state()).ragOpen, false);
  } else {
    bad('3.1b 检索输入框可获得焦点', null, '未找到输入框');
  }
} else {
  bad('3.1 RAG 知识库已打开', ragBefore, '未打开（按钮未找到？）');
}

/* ---- 用例 4：混沌弹窗内输入框让位 ---- */
console.log('\n▸ 用例 4：弹窗打开时输入框内 Esc 让位');
await ev(`(() => {
  const store = window.__KUBEVISION_STORE__;
  store.getState().setChaosModalOpen(true);
  store.getState().setActiveRightTab('copilot');
  return true;
})()`);
await sleep(700);
const focusTextarea = await ev(`(() => {
  const textarea = document.querySelector('textarea[aria-label="对话输入框"]');
  if (textarea === null) return false;
  textarea.focus();
  return document.activeElement === textarea;
})()`);
if (focusTextarea === true) {
  await pressEscape();
  is('4.1 焦点在输入框时 Esc 不关闭弹窗', (await state()).chaos, true);
} else {
  bad('4.1 焦点在输入框时 Esc 不关闭弹窗', null, '输入框不可聚焦');
}

console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);