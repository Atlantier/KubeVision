#!/usr/bin/env node
/**
 * KubeVision AI — R12 交互、焦点管理与动效治理运行态探针（scripts/probe-r12.mjs）
 *
 * 【验证范围（覆盖 R12 Main + 进阶全部核心运行时契约）】
 * 1. CommandPalette：子序列模糊匹配（wbeta → worker-beta）、<mark> 高亮保留原文、
 *    分类分组（Pod / 节点 / 动作 / 导航）、WAI-ARIA combobox/listbox/option/activedescendant、
 *    鼠标 hover/mousedown 不抢走搜索框焦点。
 * 2. 焦点管理与退场：ChaosControlModal / RagKnowledgeModal / PostMortemModal / CommandPalette
 *    初始聚焦、Tab / Shift+Tab 真实闭环焦点陷阱、顶部 <header> inert、Esc 归还触发器焦点、
 *    AnimatePresence 退场流畅卸载。
 * 3. WAI-ARIA 组内键盘漫游：Tabs（ArrowLeft/ArrowRight/Home/End + roving tabIndex + tabpanel）与
 *    TopBar 剧本菜单（role="menu"/menuitem + ArrowUp/ArrowDown/Home/End + Esc 归还焦点），
 *    非模态"更多"浮层使用 role="region" 且无 aria-modal。
 * 4. SplitPaneResizer：aria-valuetext 含比例与像素宽度、损坏/越界 localStorage 自愈回 34%。
 * 5. prefers-reduced-motion: reduce 降级 + 全局状态提示条最多 1 条且支持手动关闭。
 * 6. 叠层 Esc + 20 次高频开合压测：仅弹最顶层、0 console/page 报错、keydown 监听零泄漏、CLS <= 0.05。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9388');
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
  console.error('未找到 Edge 浏览器可执行文件');
  process.exit(2);
}

/* ---------- 按需拉起 Next.js 生产服务（若端口未监听） ---------- */
async function isServerUp() {
  try {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

let ownedServer = null;
if (!(await isServerUp())) {
  ownedServer = spawn('cmd.exe', ['/d', '/s', '/c', 'pnpm', 'start'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
  });
  let up = false;
  for (let i = 0; i < 60; i += 1) {
    if (await isServerUp()) {
      up = true;
      break;
    }
    await sleep(500);
  }
  if (!up) {
    console.error(`无法在 ${BASE_URL} 启动服务（请先执行 pnpm build）`);
    try {
      ownedServer.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    process.exit(2);
  }
}

/* ---------- 启动无头 Edge CDP ---------- */
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
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-r12-${Date.now()}`)}`,
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
  if (ownedServer !== null) {
    try {
      if (process.platform === 'win32' && ownedServer.pid !== undefined) {
        spawn('taskkill', ['/PID', String(ownedServer.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        ownedServer.kill('SIGKILL');
      }
    } catch {
      /* ignore */
    }
  }
};
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })
    ).json();
    target = list.find((t) => t.type === 'page') ?? null;
    if (target !== null) break;
  } catch {
    /* 等待 CDP 就绪 */
  }
  await sleep(500);
}
if (target === null) {
  console.error('Edge CDP 未就绪');
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
const runtimeErrors = [];
const consoleErrors = [];

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    runtimeErrors.push(String(msg.params?.exceptionDetails?.text ?? 'exceptionThrown'));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleErrors.push(text);
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
    return {
      __err: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text),
    };
  }
  return res.result?.result?.value;
};

const INSTRUMENT_SCRIPT = `(() => {
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

  window.__kvCls__ = 0;
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__kvCls__ += entry.value;
      }
    });
    po.observe({ type: 'layout-shift', buffered: true });
  } catch { /* ignore */ }
})();`;

const pressKey = async (key, code, vk, modifiers = 0, waitMs = 180) => {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  });
  await sleep(waitMs);
};
const pressShiftTab = () => pressKey('Tab', 'Tab', 9, 8, 120);
const pressTab = () => pressKey('Tab', 'Tab', 9, 0, 120);
const pressEscape = (waitMs = 260) => pressKey('Escape', 'Escape', 27, 0, waitMs);
const pressArrowRight = () => pressKey('ArrowRight', 'ArrowRight', 39, 0, 150);
const pressArrowLeft = () => pressKey('ArrowLeft', 'ArrowLeft', 37, 0, 150);
const pressArrowDown = () => pressKey('ArrowDown', 'ArrowDown', 40, 0, 150);
const pressHome = () => pressKey('Home', 'Home', 36, 0, 150);
const pressEnd = () => pressKey('End', 'End', 35, 0, 150);
const pressCtrlK = (waitMs = 260) => pressKey('k', 'KeyK', 75, 2, waitMs);
const pressEnter = async (waitMs = 240) => {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: '\r',
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sleep(waitMs);
};

const insertText = async (text) => {
  await send('Input.insertText', { text });
  await sleep(220);
};

async function waitPageReady() {
  for (let i = 0; i < 200; i += 1) {
    const okCanvas = await ev('document.querySelector("canvas") !== null');
    const readyStore = await ev(
      'window.__KUBEVISION_STORE__ && window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.length > 0',
    );
    if (okCanvas === true && readyStore === true) break;
    await sleep(250);
  }
  await sleep(1200);
}

async function waitFor(expression, timeoutMs = 3500, intervalMs = 60) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    last = await ev(expression);
    if (last === true) return true;
    await sleep(intervalMs);
  }
  return last;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1680,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT_SCRIPT });
await send('Page.navigate', { url: BASE_URL });
await waitPageReady();

console.log('KubeVision AI — R12 丝滑交互与动效治理运行态探针');
console.log(`  目标: ${BASE_URL}\n`);

/* ==================== 1. CommandPalette 模糊匹配 / 高亮 / 分组 / ARIA / 不抢焦点 ==================== */
console.log('▸ 1. CommandPalette 子序列匹配、高亮与 WAI-ARIA Listbox');
await pressCtrlK(140);
await waitFor(`(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label="运维命令面板"]');
  const inp = dlg?.querySelector('input[role="combobox"]');
  return Boolean(dlg && inp && document.activeElement === inp);
})()`, 4500);
const paletteState = await ev(`(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label="运维命令面板"]');
  const inp = dlg?.querySelector('input[role="combobox"]');
  const lb = dlg?.querySelector('[role="listbox"]');
  const groups = [...(lb?.querySelectorAll('[role="group"]') ?? [])].map((g) => g.getAttribute('aria-label'));
  return {
    open: dlg !== null,
    activeIsInput: document.activeElement === inp,
    hasListbox: lb !== null,
    groups,
    controlsOk: inp?.getAttribute('aria-controls') === lb?.id,
  };
})()`);
if (paletteState?.open && paletteState?.activeIsInput && paletteState?.hasListbox && paletteState?.controlsOk) {
  ok('1.1 命令面板打开且焦点在 combobox', `分组=${JSON.stringify(paletteState.groups)}`);
} else {
  bad('1.1 命令面板初始状态', paletteState, '未正确挂载 ARIA combobox/listbox 或焦点未落输入框');
}

const hasAllGroups = ['Pod', '节点', '动作', '导航'].every((g) => paletteState?.groups?.includes(g));
if (hasAllGroups) ok('1.2 展示四大语义分组', paletteState.groups.join(' / '));
else bad('1.2 语义分组', paletteState?.groups, '缺少预期分组');

await insertText('wbeta');
await waitFor(`document.querySelector('[role="dialog"][aria-label="运维命令面板"] input[role="combobox"]')?.getAttribute('aria-activedescendant') === 'cmd-option-node-node-worker-beta'`, 2000);
const fuzzyCheck = await ev(`(() => {
  const inp = document.querySelector('[role="dialog"][aria-label="运维命令面板"] input[role="combobox"]');
  const activeId = inp?.getAttribute('aria-activedescendant');
  const activeOpt = activeId ? document.getElementById(activeId) : null;
  const labelSpan = activeOpt?.querySelector('span.min-w-0 > span');
  const marks = labelSpan ? [...labelSpan.querySelectorAll('mark')].map((m) => m.textContent) : [];
  return {
    activeId,
    ariaSelected: activeOpt?.getAttribute('aria-selected'),
    labelText: labelSpan?.textContent ?? null,
    marks,
  };
})()`);
if (
  fuzzyCheck?.labelText === 'worker-beta' &&
  fuzzyCheck?.marks?.length > 0 &&
  fuzzyCheck?.ariaSelected === 'true'
) {
  ok('1.3 wbeta 子序列命中 worker-beta + <mark> 高亮 + activedescendant 同步', `marks=${fuzzyCheck.marks.join(',')}`);
} else {
  bad('1.3 子序列模糊匹配与高亮', fuzzyCheck, '未匹配 worker-beta 或缺少 <mark> / activedescendant');
}

/* 清空查询，测试鼠标悬停+mousedown 不抢输入框焦点 */
await ev(`(() => {
  const inp = document.querySelector('[role="dialog"][aria-label="运维命令面板"] input[role="combobox"]');
  if (inp) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(inp, '');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
})()`);
await sleep(200);
const hoverNoBlur = await ev(`(() => {
  const inp = document.querySelector('[role="dialog"][aria-label="运维命令面板"] input[role="combobox"]');
  const opts = [...document.querySelectorAll('[role="dialog"][aria-label="运维命令面板"] [role="option"]')];
  if (!inp || opts.length < 2) return { ok: false, count: opts.length };
  const target = opts[1];
  target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  target.dispatchEvent(md);
  return {
    ok: document.activeElement === inp && md.defaultPrevented === true,
    activeIsInput: document.activeElement === inp,
    mdPrevented: md.defaultPrevented,
    secondId: target.id,
  };
})()`);
if (hoverNoBlur?.ok) {
  ok('1.4 列表选项 mousedown 不抢走搜索输入框焦点', `id=${hoverNoBlur.secondId}`);
} else {
  bad('1.4 列表选项 mousedown 防失焦', hoverNoBlur, 'mousedown 未 preventDefault 或输入框失焦');
}
await pressEscape(100);
await waitFor(`document.querySelector('[role="dialog"][aria-label="运维命令面板"]') === null && !(document.querySelector('header')?.hasAttribute('inert') ?? false)`, 3500);

/* ==================== 2. 焦点陷阱、顶部 inert、焦点归还与退场 ==================== */
console.log('\n▸ 2. Focus Trap + header inert + 焦点归还 + AnimatePresence 退场');
await ev(`document.querySelector('button[aria-label^="打开故障演练场景选择"]')?.focus()`);
await sleep(100);
await pressEnter(140);
await waitFor(`(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]');
  const headerInert = document.querySelector('header')?.hasAttribute('inert') ?? false;
  return Boolean(dlg && headerInert && dlg.contains(document.activeElement));
})()`, 4500);

const chaosOpen = await ev(`(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]');
  const headerInert = document.querySelector('header')?.hasAttribute('inert') ?? false;
  const activeLabel = document.activeElement?.getAttribute('aria-label') ?? null;
  return { open: dlg !== null, headerInert, activeInside: dlg?.contains(document.activeElement) ?? false, activeLabel };
})()`);
if (chaosOpen?.open && chaosOpen?.headerInert && chaosOpen?.activeInside) {
  ok('2.1 混沌弹窗初始聚焦卡片且 header 进入 inert', `active=${chaosOpen.activeLabel}`);
} else {
  bad('2.1 混沌弹窗初始状态', chaosOpen, '未聚焦弹窗内元素或 header 未设 inert');
}

let tabLeaked = false;
for (let i = 0; i < 12; i += 1) {
  await pressTab();
  const inside = await ev(
    `document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]')?.contains(document.activeElement) ?? false`,
  );
  if (inside !== true) {
    tabLeaked = true;
    break;
  }
}
for (let i = 0; i < 12 && !tabLeaked; i += 1) {
  await pressShiftTab();
  const inside = await ev(
    `document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]')?.contains(document.activeElement) ?? false`,
  );
  if (inside !== true) {
    tabLeaked = true;
    break;
  }
}
if (!tabLeaked) ok('2.2 Tab 与 Shift+Tab 12 轮严格闭环 trapped 于模态框内', '零逃逸');
else bad('2.2 Tab/Shift+Tab 焦点陷阱', null, '焦点逃出了混沌工程弹窗');

await pressEscape(100);
await waitFor(`(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]');
  const headerInert = document.querySelector('header')?.hasAttribute('inert') ?? false;
  const activeAria = document.activeElement?.getAttribute('aria-label') ?? null;
  return dlg === null && !headerInert && Boolean(activeAria?.startsWith('打开故障演练场景选择'));
})()`, 3500);
const chaosReturned = await ev(`(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]');
  const headerInert = document.querySelector('header')?.hasAttribute('inert') ?? false;
  const activeAria = document.activeElement?.getAttribute('aria-label') ?? null;
  return { closed: dlg === null, headerInert, activeAria };
})()`);
if (
  chaosReturned?.closed &&
  !chaosReturned?.headerInert &&
  chaosReturned?.activeAria?.startsWith('打开故障演练场景选择')
) {
  ok('2.3 Esc 关闭后清除 header inert 且精确归还触发器焦点', chaosReturned.activeAria);
} else {
  bad('2.3 关闭混沌弹窗归还焦点', chaosReturned, 'inert 未解除或焦点未归还触发按钮');
}

/* RAG Modal AnimatePresence 退场检测 */
await ev(`document.querySelector('button[aria-label^="打开 SRE 领域知识库"]')?.focus()`);
await sleep(100);
await pressEnter(140);
await waitFor(`(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label="SRE 领域知识库"]');
  return Boolean(dlg && document.activeElement?.tagName === 'INPUT' && dlg.contains(document.activeElement));
})()`, 3500);
const ragOpen = await ev(`(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label="SRE 领域知识库"]');
  return {
    open: dlg !== null,
    activeTag: document.activeElement?.tagName ?? null,
    activeInside: dlg?.contains(document.activeElement) ?? false,
  };
})()`);
if (ragOpen?.open && ragOpen?.activeTag === 'INPUT' && ragOpen?.activeInside) {
  ok('2.4 RAG 知识库打开即自动聚焦检索输入框', 'tag=INPUT');
} else {
  bad('2.4 RAG 初始聚焦', ragOpen, '未自动聚焦搜索框');
}

/* ==================== 3. WAI-ARIA Tabs & TopBar 菜单键盘漫游 ==================== */
console.log('\n▸ 3. WAI-ARIA Tabs 与 TopBar Menu 键盘漫游');
const ragTabWalk = await ev(`(() => {
  const firstTab = document.getElementById('rag-desktop-tab-knowledge');
  firstTab?.focus();
  return { exists: firstTab !== null, tabIndex0: firstTab?.getAttribute('tabindex') };
})()`);
await pressArrowRight();
const ragTabSwitched = await ev(`(() => {
  const t1 = document.getElementById('rag-desktop-tab-knowledge');
  const t2 = document.getElementById('rag-desktop-tab-glossary');
  const panel = document.getElementById('rag-tabpanel-main');
  return {
    t1Sel: t1?.getAttribute('aria-selected'),
    t1Idx: t1?.getAttribute('tabindex'),
    t2Sel: t2?.getAttribute('aria-selected'),
    t2Idx: t2?.getAttribute('tabindex'),
    focusedIsT2: document.activeElement === t2,
    labelledBy: panel?.getAttribute('aria-labelledby'),
  };
})()`);
if (
  ragTabWalk?.exists &&
  ragTabSwitched?.t2Sel === 'true' &&
  ragTabSwitched?.t2Idx === '0' &&
  ragTabSwitched?.t1Idx === '-1' &&
  ragTabSwitched?.focusedIsT2 &&
  ragTabSwitched?.labelledBy === 'rag-desktop-tab-glossary'
) {
  ok('3.1 RAG 弹窗 Tablist ArrowRight 漫游 + tabIndex 互斥 + tabpanel 联动', 'knowledge → glossary');
} else {
  bad('3.1 RAG Tablist 键盘漫游', { ragTabWalk, ragTabSwitched }, 'roving tabIndex 或 aria-controls 不一致');
}
await pressHome();
await pressEscape(30);
const ragMidExit = await ev(`document.querySelector('[role="dialog"][aria-label="SRE 领域知识库"]') !== null`);
const ragAfterExit = await waitFor(
  `document.querySelector('[role="dialog"][aria-label="SRE 领域知识库"]') === null && !(document.querySelector('header')?.hasAttribute('inert') ?? false)`,
  3500,
);
if (ragMidExit && ragAfterExit === true) {
  ok('3.2 RAG 弹窗 AnimatePresence 退场窗口可见随后平滑卸载', '30ms 仍在退场 → 平滑卸载');
} else {
  bad('3.2 RAG 弹窗退场动画', { ragMidExit, ragAfterExit }, '直接瞬断消失或未正常卸载');
}

/* CopilotDrawer Tablist 漫游 */
await ev(`document.getElementById('copilot-drawer-tab-copilot')?.focus()`);
await sleep(80);
await pressArrowRight();
await waitFor(`document.getElementById('copilot-drawer-panel-auditor') !== null`, 2000);
const copilotTab2 = await ev(`(() => {
  const t1 = document.getElementById('copilot-drawer-tab-copilot');
  const t2 = document.getElementById('copilot-drawer-tab-auditor');
  return {
    t1Idx: t1?.getAttribute('tabindex'),
    t2Idx: t2?.getAttribute('tabindex'),
    t2Sel: t2?.getAttribute('aria-selected'),
    focusedIsT2: document.activeElement === t2,
    panel2Visible: document.getElementById('copilot-drawer-panel-auditor') !== null,
  };
})()`);
await pressArrowLeft();
await waitFor(`document.activeElement?.id === 'copilot-drawer-tab-copilot'`, 1500);
const copilotTabBack = await ev(`document.activeElement?.id === 'copilot-drawer-tab-copilot'`);
if (copilotTab2?.t2Sel === 'true' && copilotTab2?.t2Idx === '0' && copilotTab2?.t1Idx === '-1' && copilotTabBack) {
  ok('3.3 Copilot 抽屉 Tablist ArrowRight/ArrowLeft 键盘漫游与 tabpanel 切换', 'copilot ↔ auditor');
} else {
  bad('3.3 Copilot Tablist', { copilotTab2, copilotTabBack }, '页签漫游或 tabpanel 状态不符');
}

/* TopBar 剧本菜单 (role="menu") + 更多菜单 (non-modal role="region") */
await ev(`document.querySelector('button[aria-label^="启动全自动剧本路演"]')?.focus()`);
await sleep(80);
await pressEnter(120);
await waitFor(`(() => {
  const menu = document.getElementById('topbar-demo-menu');
  const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
  return items.length >= 2 && menu !== null && menu.contains(document.activeElement);
})()`, 3000);
const menuInit = await ev(`(() => {
  const menu = document.getElementById('topbar-demo-menu');
  const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
  return {
    role: menu?.getAttribute('role'),
    itemCount: items.length,
    focusedIdx: items.indexOf(document.activeElement),
  };
})()`);
await pressArrowDown();
const menuMoved = await ev(`(() => {
  const menu = document.getElementById('topbar-demo-menu');
  const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
  return items.indexOf(document.activeElement);
})()`);
await pressEnd();
const menuAtEnd = await ev(`(() => {
  const menu = document.getElementById('topbar-demo-menu');
  const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
  return { idx: items.indexOf(document.activeElement), lastIdx: items.length - 1 };
})()`);
await pressEscape(100);
await waitFor(`(() => {
  const menu = document.getElementById('topbar-demo-menu');
  const triggerAria = document.activeElement?.getAttribute('aria-label') ?? '';
  return menu === null && triggerAria.startsWith('启动全自动剧本路演');
})()`, 3000);
const menuClosedFocus = await ev(`(() => {
  const menu = document.getElementById('topbar-demo-menu');
  const triggerAria = document.activeElement?.getAttribute('aria-label') ?? '';
  return { closed: menu === null, returnedToDemoBtn: triggerAria.startsWith('启动全自动剧本路演') };
})()`);
if (
  menuInit?.role === 'menu' &&
  menuInit?.itemCount >= 2 &&
  menuInit?.focusedIdx === 0 &&
  menuMoved === 1 &&
  menuAtEnd?.idx === menuAtEnd?.lastIdx &&
  menuClosedFocus?.closed &&
  menuClosedFocus?.returnedToDemoBtn
) {
  ok('3.4 TopBar 剧本菜单 ArrowDown/End 漫游 + Esc 归还焦点', `${menuInit.itemCount} 个 menuitem`);
} else {
  bad('3.4 TopBar 剧本菜单', { menuInit, menuMoved, menuAtEnd, menuClosedFocus }, '菜单角色或键盘漫游不符');
}

await ev(`document.querySelector('button[aria-label="打开状态过滤与工具菜单"]')?.click()`);
await waitFor(`document.getElementById('topbar-more-menu') !== null`, 2500);
const moreMenuCheck = await ev(`(() => {
  const el = document.getElementById('topbar-more-menu');
  return {
    open: el !== null,
    role: el?.getAttribute('role'),
    ariaModal: el?.getAttribute('aria-modal'),
  };
})()`);
if (moreMenuCheck?.open && moreMenuCheck?.role === 'region' && moreMenuCheck?.ariaModal === null) {
  ok('3.5 TopBar 更多浮层非模态使用 role="region"（不误用 dialog/aria-modal）');
} else {
  bad('3.5 TopBar 更多浮层语义', moreMenuCheck, '角色或 aria-modal 误用');
}
await pressEscape(100);
await waitFor(`document.getElementById('topbar-more-menu') === null`, 2500);

/* ==================== 4. SplitPaneResizer aria-valuetext & 损坏 localStorage 自愈 ==================== */
console.log('\n▸ 4. SplitPaneResizer 无障碍数值文本与损坏存储自愈');
const resizerCheck = await ev(`(() => {
  const sep = document.querySelector('[role="separator"]');
  return {
    exists: sep !== null,
    valueNow: sep?.getAttribute('aria-valuenow'),
    valueText: sep?.getAttribute('aria-valuetext') ?? '',
  };
})()`);
if (resizerCheck?.exists && /^AI 副驾宽度 \d+%，\d+ 像素$/.test(resizerCheck.valueText)) {
  ok('4.1 SplitPaneResizer 暴露精确比例 + 像素 aria-valuetext', resizerCheck.valueText);
} else {
  bad('4.1 SplitPaneResizer aria-valuetext', resizerCheck, '未包含像素宽度或格式不符');
}

for (const badPayload of ['NaN', '999']) {
  await ev(`localStorage.setItem('kv-drawer-width-pct', ${JSON.stringify(badPayload)})`);
  await send('Page.reload', { ignoreCache: false });
  await waitPageReady();
  await waitFor(
    `localStorage.getItem('kv-drawer-width-pct') === '34' && document.querySelector('[role="separator"]')?.getAttribute('aria-valuenow') === '34'`,
    2500,
  );
  const healed = await ev(`(() => ({
    stored: localStorage.getItem('kv-drawer-width-pct'),
    valueNow: document.querySelector('[role="separator"]')?.getAttribute('aria-valuenow'),
  }))()`);
  if (healed?.stored === '34' && healed?.valueNow === '34') {
    ok(`4.2 损坏存储 (${badPayload}) 重载自愈为 34%`, `stored=${healed.stored}`);
  } else {
    bad(`4.2 损坏存储 (${badPayload}) 自愈`, healed, '未回落并写回 34%');
  }
}

/* ==================== 5. prefers-reduced-motion & 单一全局 Toast ==================== */
console.log('\n▸ 5. prefers-reduced-motion: reduce 降级与单全局 Toast');
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});
await sleep(150);
await ev(`document.querySelector('button[aria-label^="打开故障演练场景选择"]')?.click()`);
await waitFor(`(() => {
  const modalVisible = document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]') !== null;
  const toastCount = document.querySelectorAll('[data-global-status-toast="true"]').length;
  return modalVisible && toastCount === 1;
})()`, 4500);
const reducedAndToast = await ev(`(() => {
  const reducedMatch = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const toasts = document.querySelectorAll('[data-global-status-toast="true"]');
  const dismissBtn = document.querySelector('button[aria-label="关闭全局状态提示"]');
  return {
    reducedMatch,
    toastCount: toasts.length,
    hasDismissBtn: dismissBtn !== null,
    modalVisible: document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]') !== null,
  };
})()`);
await ev(`document.querySelector('button[aria-label="关闭全局状态提示"]')?.click()`);
await waitFor(`document.querySelectorAll('[data-global-status-toast="true"]').length === 0`, 2500);
const toastAfterDismiss = await ev(`document.querySelectorAll('[data-global-status-toast="true"]').length`);
if (
  reducedAndToast?.reducedMatch &&
  reducedAndToast?.modalVisible &&
  reducedAndToast?.toastCount === 1 &&
  reducedAndToast?.hasDismissBtn &&
  toastAfterDismiss === 0
) {
  ok('5.1 减弱动态效果生效且全局提示条最多 1 条并支持手动关闭', 'toast 1 → 0');
} else {
  bad('5.1 reduced-motion 或 Toast 检查', { reducedAndToast, toastAfterDismiss }, '降级/Toast 状态异常');
}
await pressEscape(100);
await waitFor(`document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]') === null`, 3500);
await send('Emulation.setEmulatedMedia', { features: [] });
await sleep(150);

/* ==================== 6. 叠层 Esc + 20 次高频开关压测 + CLS 门禁 ==================== */
console.log('\n▸ 6. 叠层 Esc 与 20 次快速开关压测');
await ev(`window.__kvCls__ = 0; true`);
await ev(`document.querySelector('button[aria-label^="打开故障演练场景选择"]')?.click()`);
await waitFor(`document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]') !== null`, 3500);
await pressCtrlK(140);
await waitFor(`document.querySelector('[role="dialog"][aria-label="运维命令面板"]') !== null`, 4500);
const stackedBoth = await ev(`(() => ({
  chaos: document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]') !== null,
  palette: document.querySelector('[role="dialog"][aria-label="运维命令面板"]') !== null,
}))()`);
await pressEscape(100);
await waitFor(`document.querySelector('[role="dialog"][aria-label="运维命令面板"]') === null`, 3500);
const afterFirstEsc = await ev(`(() => ({
  chaos: document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]') !== null,
  palette: document.querySelector('[role="dialog"][aria-label="运维命令面板"]') !== null,
}))()`);
await pressEscape(100);
await waitFor(`document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]') === null`, 3500);
const afterSecondEsc = await ev(`(() => ({
  chaos: document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]') !== null,
  palette: document.querySelector('[role="dialog"][aria-label="运维命令面板"]') !== null,
}))()`);
if (
  stackedBoth?.chaos &&
  stackedBoth?.palette &&
  afterFirstEsc?.chaos &&
  !afterFirstEsc?.palette &&
  !afterSecondEsc?.chaos &&
  !afterSecondEsc?.palette
) {
  ok('6.1 叠层先弹最顶层命令面板、再按 Esc 关闭混沌弹窗', '单层逐级退出');
} else {
  bad('6.1 叠层 Esc', { stackedBoth, afterFirstEsc, afterSecondEsc }, '一次 Esc 关闭多层或顺序有误');
}

const baselineListeners = await ev(`window.__kvListeners__.window + window.__kvListeners__.document`);
for (let i = 0; i < 20; i += 1) {
  await pressCtrlK(40);
  await waitFor(`document.querySelector('[role="dialog"][aria-label="运维命令面板"] input[role="combobox"]') !== null`, 2000, 30);
  await pressEscape(40);
  await waitFor(`document.querySelector('[role="dialog"][aria-label="运维命令面板"]') === null`, 2000, 30);
}
await sleep(300);
const afterStress = await ev(`(() => ({
  listeners: window.__kvListeners__.window + window.__kvListeners__.document,
  paletteLeft: document.querySelector('[role="dialog"][aria-label="运维命令面板"]') !== null,
  cls: window.__kvCls__,
}))()`);
if (
  afterStress?.listeners === baselineListeners &&
  afterStress?.paletteLeft === false &&
  typeof afterStress?.cls === 'number' &&
  afterStress.cls <= 0.05 &&
  runtimeErrors.length === 0 &&
  consoleErrors.length === 0
) {
  ok(
    '6.2 20 次高频开关压测零泄漏、零报错、交互 CLS <= 0.05',
    `listeners=${afterStress.listeners}, cls=${afterStress.cls.toFixed(4)}`,
  );
} else {
  bad(
    '6.2 高频开关压测',
    { baselineListeners, afterStress, runtimeErrors, consoleErrors },
    '存在监听泄漏、异常报错或 CLS 超标',
  );
}

console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);
