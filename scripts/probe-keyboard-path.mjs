#!/usr/bin/env node
/**
 * KubeVision AI — 键盘-only 全路径探针（scripts/probe-keyboard-path.mjs · R3 进阶）
 *
 * 【验证什么】仅用 Tab/Shift+Tab/Enter/Space/Esc/方向键（+Ctrl+K 唤起面板）走完黄金动线：
 * 开命令面板 → 选 worker-beta → 开故障演练 → 选 OOM → 开 RAG → 开复盘 → 逐层收起回全景。
 *
 * 【三条硬断言】
 * A1 任一时刻只有一层响应 Esc：收起阶段每按一次 Esc 恰好关闭最上层一个弹层；
 * A2 焦点不进背景：弹层打开时焦点落在该弹层内（测量并如实报告；焦点陷阱完整治理属 R12）；
 * A3 连续开合 20 次无监听泄漏：注入 addEventListener/removeEventListener 计数，
 *    20 次开关命令面板后 window+document 的 keydown 监听净数与基线一致
 *    （R3 把 Esc 收敛为「层数组」而非「每弹层一个 window 监听」，结构性防泄漏）。
 *
 * 【输出】分步截图（docs/evidence/r3-advanced/keyboard-path/）+ 监听器数量曲线。
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9384');
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
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-kbdpath-${Date.now()}`)}`,
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
ws.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text) };
  return res.result?.result?.value;
};

/* 监听器计数注入：window+document 的 keydown 净存活数 */
const LISTENER_INSTRUMENT = `(() => {
  window.__kvListeners__ = { window: 0, document: 0 };
  const wrap = (obj, key) => {
    const origAdd = obj.addEventListener.bind(obj);
    const origRemove = obj.removeEventListener.bind(obj);
    obj.addEventListener = function (type, listener, options) {
      if (type === 'keydown') window.__kvListeners__[key] += 1;
      return origAdd(type, listener, options);
    };
    obj.removeEventListener = function (type, listener, options) {
      if (type === 'keydown') window.__kvListeners__[key] -= 1;
      return origRemove(type, listener, options);
    };
  };
  wrap(window, 'window');
  wrap(document, 'document');
})();`;

const EVIDENCE_DIR = join(process.cwd(), 'docs', 'evidence', 'r3-advanced', 'keyboard-path');
mkdirSync(EVIDENCE_DIR, { recursive: true });
let shotIndex = 0;
const screenshot = async (label) => {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  const data = res.result?.data;
  if (data) {
    shotIndex += 1;
    const file = join(EVIDENCE_DIR, `${String(shotIndex).padStart(2)}-${label}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
  }
};

const pressKey = async (key, code, vk, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(220);
};
const pressTab = () => pressKey('Tab', 'Tab', 9);
/* Enter 用完整序列（rawKeyDown + char '\r' + keyUp）：CDP 单纯 keyDown 不触发
   按钮原生 click 激活，char 事件才产生默认激活；对输入框 onKeyDown 同样生效 */
const pressEnter = async () => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(220);
};
const pressSpace = () => pressKey(' ', 'Space', 32);
const pressEscape = () => pressKey('Escape', 'Escape', 27);
const pressArrowDown = () => pressKey('ArrowDown', 'ArrowDown', 40);
const pressCtrlK = () => pressKey('k', 'KeyK', 75, 2); // 2 = Ctrl

const activeLabel = () => ev(`document.activeElement ? (document.activeElement.getAttribute('aria-label') || document.activeElement.tagName) : null`);
const dialogOpen = (label) => ev(`document.querySelector('[role="dialog"][aria-label="${label}"]') !== null`);
const focusInDialog = (label) => ev(`(() => {
  const d = document.querySelector('[role="dialog"][aria-label="${label}"]');
  return d !== null && d.contains(document.activeElement);
})()`);
const listenerCount = () => ev(`window.__kvListeners__.window + window.__kvListeners__.document`);

/* Tab 直到焦点落在指定 aria-label 的元素（前缀匹配），纯键盘导航 */
const tabUntil = async (labelPrefix, maxTabs = 80) => {
  for (let i = 0; i < maxTabs; i += 1) {
    const cur = await activeLabel();
    if (typeof cur === 'string' && cur.startsWith(labelPrefix)) return true;
    await pressTab();
  }
  return false;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: LISTENER_INSTRUMENT });
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) { if ((await ev('document.querySelector("canvas") !== null')) === true) break; await sleep(300); }
for (let i = 0; i < 60; i += 1) {
  const ready = await ev('window.__KUBEVISION_STORE__ && window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.length > 0');
  if (ready === true) break;
  await sleep(300);
}
await sleep(3000);
await ev('document.body.focus(); true');

console.log('KubeVision AI — 键盘-only 全路径探针（R3 进阶）');
console.log(`  目标: ${BASE_URL}\n`);

const baselineListeners = await listenerCount();
console.log(`  基线 keydown 监听数（window+document）: ${baselineListeners}`);
const listenerCurve = [{ phase: 'baseline', count: baselineListeners }];

/* ---- 步骤 1：Tab 到命令面板触发按钮 + Enter 打开 ---- */
console.log('\n▸ 步骤 1：开命令面板（Tab 导航 + Enter）');
const reachedPalette = await tabUntil('打开运维命令面板');
if (reachedPalette) {
  await pressEnter();
  await sleep(700);
  if ((await dialogOpen('运维命令面板')) === true) ok('1.1 键盘打开命令面板', 'Tab→Enter');
  else bad('1.1 键盘打开命令面板', null, 'Enter 后面板未打开');
} else {
  bad('1.1 键盘打开命令面板', null, 'Tab 80 次未到达面板按钮');
}
await screenshot('palette-open');
listenerCurve.push({ phase: 'palette-open', count: await listenerCount() });

/* ---- 步骤 2：方向键选 worker-beta + Enter ---- */
console.log('\n▸ 步骤 2：方向键选 worker-beta');
const activeItemLabel = () => ev(`(() => {
  const list = document.querySelector('[role="dialog"][aria-label="运维命令面板"]');
  if (!list) return null;
  const btn = [...list.querySelectorAll('button')].find((b) => b.className.includes('bg-cyan-500/10'));
  if (!btn) return null;
  const labelSpan = btn.querySelector('span.min-w-0 > span');
  return labelSpan ? labelSpan.textContent : null;
})()`);
let foundBeta = false;
for (let i = 0; i < 80; i += 1) {
  const lab = await activeItemLabel();
  if (lab === 'worker-beta') { foundBeta = true; break; }
  await pressArrowDown();
}
if (foundBeta) {
  await pressEnter();
  await sleep(900);
  const sel = await ev(`window.__KUBEVISION_STORE__.getState().selectedEntityId`);
  const selType = await ev(`window.__KUBEVISION_STORE__.getState().selectedEntityType`);
  if (sel === 'node-worker-beta' && selType === 'node') ok('2.1 方向键+Enter 选中 worker-beta 节点', `${sel}`);
  else bad('2.1 方向键+Enter 选中 worker-beta', { sel, selType }, '选中目标不符');
} else {
  bad('2.1 方向键选 worker-beta', null, '80 次 ArrowDown 未到达 worker-beta');
}
await screenshot('worker-beta-selected');

/* ---- 步骤 3：Tab 到故障演练按钮 + Enter 打开 ---- */
console.log('\n▸ 步骤 3：开故障演练（Tab + Enter）');
await ev('document.body.focus(); true');
const reachedChaos = await tabUntil('打开故障演练场景选择');
if (reachedChaos) {
  await pressEnter();
  await sleep(800);
  if ((await dialogOpen('混沌工程故障演练控制台')) === true) ok('3.1 键盘打开故障演练控制台', 'Tab→Enter');
  else bad('3.1 键盘打开故障演练控制台', null, 'Enter 后控制台未打开');
} else {
  bad('3.1 键盘打开故障演练控制台', null, 'Tab 未到达故障演练按钮');
}
const chaosFocus = await focusInDialog('混沌工程故障演练控制台');
console.log(`  焦点在控制台内: ${chaosFocus}（A2 测量；完整焦点陷阱属 R12）`);
await screenshot('chaos-modal');
listenerCurve.push({ phase: 'chaos-open', count: await listenerCount() });

/* ---- 步骤 4：Tab 到 OOM 卡片 + Enter 注入 ---- */
console.log('\n▸ 步骤 4：选 OOM 场景（Tab + Enter）');
const reachedOOM = await tabUntil('A · POD_OOM_SWARM');
if (reachedOOM) {
  await pressEnter();
  await sleep(900);
  const chaos = await ev(`window.__KUBEVISION_STORE__.getState().activeChaos`);
  if (chaos === 'POD_OOM_SWARM') ok('4.1 键盘注入 OOM 雪崩', `activeChaos=${chaos}`);
  else bad('4.1 键盘注入 OOM 雪崩', chaos, 'activeChaos 不符');
} else {
  bad('4.1 键盘选 OOM 卡片', null, 'Tab 未到达 OOM 卡片');
}
await screenshot('oom-injected');

/* ---- 步骤 4.5：键盘触发快照诊断（生成可复盘卡片） ---- */
console.log('\n▸ 步骤 4.5：快照诊断（Tab + Enter，生成复盘所需卡片）');
await ev('document.body.focus(); true');
const reachedDiag = await tabUntil('3D 视口多模态快照诊断');
if (reachedDiag) {
  await pressEnter();
  ok('4.5.1 键盘触发快照诊断', 'Tab→Enter');
} else {
  bad('4.5.1 键盘触发快照诊断', null, 'Tab 未到达快照诊断按钮');
}
/* 复盘按钮仅在 hasReplayableContent（有 ready 卡片）时渲染；轮询等待诊断产出 */
let pmButtonReady = false;
for (let i = 0; i < 300; i += 1) {
  const present = await ev(`document.querySelector('button[aria-label="导出 SRE 故障复盘报告"]') !== null`);
  if (present === true) { pmButtonReady = true; break; }
  await sleep(300);
}
if (pmButtonReady) ok('4.5.2 诊断产出可复盘内容（复盘按钮出现）', 'hasReplayableContent=true');
else bad('4.5.2 诊断产出可复盘内容', null, '90s 内复盘按钮未出现');
await screenshot('diagnosis-cards');

/* ---- 步骤 5：Tab 到 RAG 按钮 + Enter 打开 ---- */
console.log('\n▸ 步骤 5：开 RAG 知识库（Tab + Enter）');
await ev('document.body.focus(); true');
const reachedRAG = await tabUntil('打开 SRE 领域知识库');
if (reachedRAG) {
  await pressEnter();
  await sleep(800);
  if ((await dialogOpen('SRE 领域知识库')) === true) ok('5.1 键盘打开 RAG 知识库', 'Tab→Enter');
  else bad('5.1 键盘打开 RAG 知识库', null, 'Enter 后知识库未打开');
} else {
  bad('5.1 键盘打开 RAG 知识库', null, 'Tab 未到达 RAG 按钮');
}
await screenshot('rag-open');
/* 关闭 RAG 以便继续键盘导航到复盘触发器（焦点不能穿到背景） */
await pressEscape();
await sleep(500);

/* ---- 步骤 6：Tab 到复盘按钮 + Enter 打开 ---- */
console.log('\n▸ 步骤 6：开复盘报告（Tab + Enter）');
await ev('document.body.focus(); true');
const reachedPM = await tabUntil('导出 SRE 故障复盘报告', 150);
if (reachedPM) {
  await pressEnter();
  await sleep(900);
  if ((await dialogOpen('SRE 故障复盘报告')) === true) ok('6.1 键盘打开复盘报告', 'Tab→Enter');
  else bad('6.1 键盘打开复盘报告', null, 'Enter 后复盘未打开');
} else {
  bad('6.1 键盘打开复盘报告', null, 'Tab 未到达复盘按钮');
}
await screenshot('postmortem-open');
listenerCurve.push({ phase: 'postmortem-open', count: await listenerCount() });

/* ---- 步骤 7：逐层 Esc 收起回全景（A1 单层断言） ---- */
console.log('\n▸ 步骤 7：逐层 Esc 收起回全景');
/* 当前最上层应为复盘（70）。每按一次 Esc 断言恰好关一层 */
const openDialogs = () => ev(`[...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute('aria-label'))`);
let escLayers = 0;
for (let i = 0; i < 8; i += 1) {
  const before = await openDialogs();
  if (!Array.isArray(before) || before.length === 0) break;
  await pressEscape();
  await sleep(500);
  const after = await openDialogs();
  const removed = before.filter((x) => !after.includes(x));
  if (removed.length === 1) { escLayers += 1; ok(`7.${escLayers} Esc 只关一层`, `关闭「${removed[0]}」`); }
  else bad(`7.${i + 1} Esc 单层`, { before, after }, `关闭了 ${removed.length} 层（期望 1）`);
}
/* 清选中回全景（page-core 兜底层） */
await pressEscape();
await sleep(600);
const finalSel = await ev(`window.__KUBEVISION_STORE__.getState().selectedEntityId`);
const finalDialogs = await openDialogs();
if (finalSel === null && Array.isArray(finalDialogs) && finalDialogs.length === 0) ok('7.x 回全景（无弹层 + 选中已清）', 'selectedEntityId=null');
else bad('7.x 回全景', { finalSel, finalDialogs }, '仍有弹层或选中');
await screenshot('overview-restored');
listenerCurve.push({ phase: 'overview', count: await listenerCount() });

/* ---- A3：连续开合命令面板 20 次，监听器零泄漏 ---- */
console.log('\n▸ A3：命令面板开合 20 次监听泄漏检测');
const beforeCycles = await listenerCount();
for (let i = 0; i < 20; i += 1) {
  await pressCtrlK();
  await sleep(180);
  await pressEscape();
  await sleep(180);
}
await sleep(500);
const afterCycles = await listenerCount();
listenerCurve.push({ phase: 'after-20-cycles', count: afterCycles });
if (afterCycles === beforeCycles) ok('A3 20 次开合后 keydown 监听净数不变', `${beforeCycles} → ${afterCycles}`);
else bad('A3 20 次开合监听泄漏', { beforeCycles, afterCycles }, '监听数增长');
const paletteGone = (await dialogOpen('运维命令面板')) === false;
if (paletteGone) ok('A3b 20 次开合后面板已闭合', '无残留');
else bad('A3b 面板闭合', null, '仍有残留面板');

/* 归档监听曲线 */
writeFileSync(join(EVIDENCE_DIR, 'listener-curve.json'), JSON.stringify({ baseline: baselineListeners, curve: listenerCurve }, null, 2));
console.log(`\n  截图与曲线: docs/evidence/r3-advanced/keyboard-path/`);
console.log(`  监听曲线: ${listenerCurve.map((c) => `${c.phase}=${c.count}`).join(' → ')}`);

console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);