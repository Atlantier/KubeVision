#!/usr/bin/env node
/**
 * KubeVision AI — 键盘确定性探针（scripts/probe-keyboard.mjs · R3）
 *
 * 【验证 R3 的行为矩阵】
 * K1 空格原生激活：焦点在按钮上按真实 Space，按钮必须被激活（RAG 打开），
 *    全局快捷键不得 preventDefault 劫持（旧缺陷：按钮永远按不动）；
 * K2 空格让位边界：合成 Space 在按钮上 defaultPrevented=false，
 *    在非交互背景（body）上 defaultPrevented=true（背景快捷键仍生效）；
 * K3 IME 双判：命令面板输入框内 isComposing=true / keyCode=229 的 Enter
 *    只上屏候选、不执行命令（面板不关闭）；普通 Enter 正常执行；
 * K4 Esc 分层：图例浮层入栈可关；帮助浮层 + 混沌弹窗同开时，
 *    一次 Esc 只关最上层（混沌），帮助浮层保留，再按一次才关帮助；
 * K5 数字键让位：背景按 2 切审计页签；焦点在按钮上按 2 不切换、不 preventDefault。
 *
 * 【为什么用 CDP 真键盘 + 合成事件双轨】K1 必须真键（合成 keydown 不触发原生激活）；
 * K2/K3/K5 需要读 defaultPrevented / 构造 isComposing，合成事件才可观测。
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
    '--window-size=1680,1000',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-kbd-${Date.now()}`)}`,
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
const pressKey = async (key, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(320);
};
const pressEscape = () => pressKey('Escape', 'Escape', 27);
const pressSpace = () => pressKey(' ', 'Space', 32);

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) {
  if ((await ev('document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
for (let i = 0; i < 60; i += 1) {
  const ready = await ev('window.__KUBEVISION_STORE__ && window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.length > 0');
  if (ready === true) break;
  await sleep(400);
}
await sleep(3000);

console.log('KubeVision AI — 键盘确定性探针（R3）');
console.log(`  目标: ${BASE_URL}\n`);

const ragOpen = () => ev(`document.querySelector('[aria-label="SRE 领域知识库"][role="dialog"]') !== null`);
const paletteOpen = () => ev(`document.querySelector('[role="dialog"][aria-label="运维命令面板"]') !== null`);
const helpOpen = () => ev(`document.querySelector('[role="dialog"][aria-label="快捷键帮助"]') !== null`);
const chaosOpen = () => ev(`window.__KUBEVISION_STORE__.getState().isChaosModalOpen`);

/* ---- K1：真实 Space 激活聚焦按钮 ---- */
console.log('▸ K1：空格原生激活（焦点在按钮）');
const focused = await ev(`(() => {
  const b = document.querySelector('button[aria-label="打开 SRE 领域知识库"]');
  if (b === null) return false;
  b.focus();
  return document.activeElement === b;
})()`);
if (focused === true) {
  await pressSpace();
  is('K1.1 Space 激活按钮 → RAG 知识库打开（未被劫持）', await ragOpen(), true);
  await pressEscape();
  await sleep(400);
  is('K1.2 Esc 关闭 RAG（焦点在按钮，非输入框）', await ragOpen(), false);
} else {
  bad('K1.1 Space 激活按钮', null, '未找到 RAG 按钮或无法聚焦');
}

/* ---- K2：合成 Space 的让位边界 ---- */
console.log('\n▸ K2：空格让位边界（defaultPrevented 观测）');
const spaceOnButton = await ev(`(() => {
  const b = document.querySelector('button[aria-label="打开 SRE 领域知识库"]');
  if (b === null) return null;
  const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
  b.dispatchEvent(e);
  return e.defaultPrevented;
})()`);
is('K2.1 按钮上 Space 不被 preventDefault', spaceOnButton, false);
const spaceOnBody = await ev(`(() => {
  const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e.defaultPrevented;
})()`);
is('K2.2 背景上 Space 仍被快捷键消费', spaceOnBody, true);

/* ---- K3：命令面板 IME 双判 ---- */
console.log('\n▸ K3：IME 组合期 Enter 不执行命令');
await ev(`(() => { const b = document.querySelector('button[aria-label="打开运维命令面板"]'); if (b) b.click(); return true; })()`);
await sleep(900);
if ((await paletteOpen()) === true) {
  ok('K3.0 命令面板已打开');
  /* 构造能力自检：keyCode 必须可写入 init（Chrome 支持），否则 229 用例无效 */
  const settable = await ev(`new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229 }).keyCode === 229`);
  if (settable !== true) {
    bad('K3 IME 用例', null, 'keyCode 不可写入 init，229 用例无效');
  } else {
    const dispatchEnter = (init) => ev(`(() => {
      const input = document.querySelector('[role="dialog"][aria-label="运维命令面板"] input');
      if (!input) return false;
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...${init} }));
      return true;
    })()`);
    /* 组合期 Enter（isComposing 主判）——分 tick 派发，贴近真实 IME 时序 */
    await dispatchEnter('{ isComposing: true }');
    await sleep(300);
    is('K3.1 isComposing Enter 不执行（面板保留）', await paletteOpen(), true);
    /* 旧 IME 确认帧（keyCode 229 兜底） */
    await dispatchEnter('{ keyCode: 229 }');
    await sleep(300);
    is('K3.2 keyCode 229 Enter 不执行（面板保留）', await paletteOpen(), true);
    /* 普通 Enter：应执行命令（面板关闭）。命令含 selectEntity → 相机飞行，
       SwiftShader 软渲染会阻塞主线程拖慢退场动画，故轮询等待而非固定短延时 */
    await dispatchEnter('{}');
    let closed = false;
    for (let i = 0; i < 50; i += 1) {
      await sleep(100);
      if ((await paletteOpen()) === false) { closed = true; break; }
    }
    is('K3.3 普通 Enter 正常执行（面板关闭）', closed, true);
  }
} else {
  bad('K3.0 命令面板已打开', null, '未找到命令面板');
}
/* 隔离：确保面板关闭 */
for (let i = 0; i < 4; i += 1) {
  if ((await paletteOpen()) === false) break;
  await ev('document.activeElement && document.activeElement.blur(); true');
  await pressEscape();
}

/* ---- K4：Esc 分层（图例 / 帮助 + 混沌） ---- */
console.log('\n▸ K4：Esc 一次只退一层');
/* K3 的普通 Enter 可能选中实体 → 图例被探针卡取代；先清选中让图例回场。
   清选中触发相机飞回全景，软渲染下 DOM 回场有延迟，轮询等待图例按钮出现 */
await ev(`window.__KUBEVISION_STORE__.getState().selectEntity(null); true`);
for (let i = 0; i < 50; i += 1) {
  const present = await ev(`document.querySelector('button[aria-label="切换 3D 拓扑读图说明"]') !== null`);
  if (present === true) break;
  await sleep(100);
}
const legendExpanded = () => ev(`(() => {
  const b = document.querySelector('button[aria-label="切换 3D 拓扑读图说明"]');
  return b === null ? null : b.getAttribute('aria-expanded') === 'true';
})()`);
await ev(`(() => { const b = document.querySelector('button[aria-label="切换 3D 拓扑读图说明"]'); if (b) b.click(); return true; })()`);
await sleep(500);
if ((await legendExpanded()) === true) {
  ok('K4.0 图例已展开');
  await pressEscape();
  let collapsed = false;
  for (let i = 0; i < 30; i += 1) {
    if ((await legendExpanded()) === false) { collapsed = true; break; }
    await sleep(100);
  }
  is('K4.1 Esc 关闭图例（入栈生效）', collapsed, true);
} else {
  bad('K4.0 图例已展开', null, '图例按钮未找到或未展开');
}

/* 帮助 + 混沌同开：Esc 先关混沌（90），帮助（60）保留 */
await ev(`(() => {
  const e = new KeyboardEvent('keydown', { key: '?', code: 'Slash', shiftKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return true;
})()`);
await sleep(500);
const helpOpened = await helpOpen();
await ev(`window.__KUBEVISION_STORE__.getState().setChaosModalOpen(true); true`);
for (let i = 0; i < 40; i += 1) {
  const mounted = await ev(`document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]') !== null`);
  if (mounted === true) break;
  await sleep(150);
}
await sleep(300);
if (helpOpened === true) {
  ok('K4.2 帮助浮层已打开');
  await pressEscape();
  is('K4.3 第一次 Esc 只关混沌，帮助保留', [await chaosOpen(), await helpOpen()], [false, true]);
  await pressEscape();
  let helpClosed = false;
  for (let i = 0; i < 30; i += 1) {
    if ((await helpOpen()) === false) { helpClosed = true; break; }
    await sleep(100);
  }
  is('K4.4 第二次 Esc 才关帮助', helpClosed, true);
} else {
  bad('K4.2 帮助浮层已打开', null, '? 快捷键未打开帮助');
  await pressEscape();
}

/* ---- K5：数字键让位 ---- */
console.log('\n▸ K5：数字键 1/2 不劫持交互元素');
const tabOf = () => ev(`window.__KUBEVISION_STORE__.getState().activeRightTab`);
await ev(`window.__KUBEVISION_STORE__.getState().setActiveRightTab('copilot'); true`);
await sleep(300);
const digitOnBody = await ev(`(() => {
  const e = new KeyboardEvent('keydown', { key: '2', code: 'Digit2', bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e.defaultPrevented;
})()`);
await sleep(300);
is('K5.1 背景按 2 切到审计页签', [digitOnBody, await tabOf()], [true, 'auditor']);
const digitOnButton = await ev(`(() => {
  const b = document.querySelector('button[aria-label="打开运维命令面板"]');
  if (b === null) return null;
  b.focus();
  const e = new KeyboardEvent('keydown', { key: '1', code: 'Digit1', bubbles: true, cancelable: true });
  b.dispatchEvent(e);
  return e.defaultPrevented;
})()`);
await sleep(300);
is('K5.2 按钮上按 1 不切换、不 preventDefault', [digitOnButton, await tabOf()], [false, 'auditor']);
await ev(`window.__KUBEVISION_STORE__.getState().setActiveRightTab('copilot'); true`);

console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);