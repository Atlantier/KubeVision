#!/usr/bin/env node
/**
 * KubeVision AI — 设计系统 / 可访问性静态与运行时检查（R31 · G + R13 Main #7）
 *
 * 静态扫描 src/：
 *  1. 小于 10px 的任意字号（`text-[Npx]` 与 `fontSize: N`）；
 *  2. icon-only `<button>` 缺少 aria-label（按钮内无可见文本且无 aria-label/aria-labelledby）；
 *  3. 已禁用的 slate-600 / slate-700 颜色用法；
 *  4. 手写 `backdrop-blur-*`（应改用 kv-blur-panel / kv-blur-chip 令牌）。
 *
 * 运行时 `--runtime` 门禁（Headless Edge CDP）：
 *  1. 校验可交互控件无正向 `tabIndex`（tabIndex > 0）陷阱；
 *  2. 校验可聚焦/可见按钮与控件均有非空可访问名称；
 *  3. 真实 Tab 键盘遍历多枚核心控件，验证 `:focus-visible` 焦点环可见；
 *  4. 校验打开混沌模态框后 `<header>` 自动获得 `inert`，Esc 关闭后解除。
 *
 * 退出码：0 = 全部通过；1 = 存在命中或运行时断言失败。
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNTIME_MODE = process.argv.includes('--runtime');
const BASE_URL =
  process.argv.find((arg) => arg.startsWith('--base='))?.slice('--base='.length) ??
  'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_A11Y_CDP_PORT ?? '9364');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ROOT = join(process.cwd(), 'src');
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx|ts)$/.test(entry.name)) files.push(full);
  }
}
walk(ROOT);

const hits = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const relative = file.replace(process.cwd() + '\\', '').replace(process.cwd() + '/', '');

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    /* 1. 小字号 */
    for (const match of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
      if (Number(match[1]) < 10) {
        hits.push({ kind: 'small-font', file: relative, line: lineNo, detail: match[0] });
      }
    }
    for (const match of line.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)) {
      if (Number(match[1]) < 10) {
        hits.push({ kind: 'small-font', file: relative, line: lineNo, detail: match[0] });
      }
    }

    /* 2. slate-600/700 */
    for (const match of line.matchAll(/slate-(600|700)/g)) {
      hits.push({ kind: 'legacy-color', file: relative, line: lineNo, detail: match[0] });
    }

    /* 3. 手写 backdrop-blur */
    for (const match of line.matchAll(/backdrop-blur-[a-z0-9[\]-]*/g)) {
      hits.push({ kind: 'blur-raw', file: relative, line: lineNo, detail: match[0] });
    }
  });

  /* 4. icon-only 按钮缺 aria-label（跨行标签配对） */
  const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  for (const match of source.matchAll(buttonRe)) {
    const attrs = match[1];
    const body = match[2];
    if (/aria-label\s*=/.test(attrs) || /aria-labelledby\s*=/.test(attrs)) continue;
    const visibleText = body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const hasIcon = /<(svg|Icon|HiOutline|Fi|Lucide)/.test(body);
    if (visibleText.length === 0 && hasIcon) {
      const lineNo = source.slice(0, match.index).split('\n').length;
      hits.push({
        kind: 'a11y-icon-button',
        file: relative,
        line: lineNo,
        detail: '<button> 有图标但无 aria-label',
      });
    }
  }
}

const grouped = new Map();
for (const hit of hits) {
  const key = hit.kind;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(hit);
}

console.log('KubeVision AI — 设计系统 / 可访问性检查');
console.log(`  扫描文件: ${files.length} 个 · 静态命中: ${hits.length}`);
for (const [kind, list] of grouped) {
  console.log(`\n  [${kind}] ${list.length} 处`);
  for (const hit of list.slice(0, 20)) {
    console.log(`    ${hit.file}:L${hit.line}  ${hit.detail}`);
  }
  if (list.length > 20) console.log(`    … 其余 ${list.length - 20} 处省略`);
}

if (hits.length > 0) {
  console.log('\n  ✗ 静态检查存在命中（见上）');
  process.exit(1);
}
console.log('\n  ✓ 静态检查 0 命中，通过');

if (!RUNTIME_MODE) {
  process.exit(0);
}

/* ========================================================================== */
/* 运行时 CDP A11y 巡检（--runtime）                                            */
/* ========================================================================== */

function findEdgePath() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function runRuntimeA11yChecks() {
  console.log(`\n  → 启动运行时 A11y 巡检（目标: ${BASE_URL}）…`);
  try {
    const ping = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!ping.ok) {
      console.error(`  ✗ 服务未就绪（GET /api/health 返回 ${ping.status}）`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`  ✗ 无法连接服务 ${BASE_URL}: ${err?.message ?? err}`);
    process.exit(1);
  }

  const edgePath = findEdgePath();
  if (!edgePath) {
    console.error('  ✗ 未找到 Microsoft Edge 可执行文件');
    process.exit(1);
  }

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-a11y-${Date.now()}`);
  const browser = spawn(
    edgePath,
    [
      '--headless=new',
      '--no-first-run',
      '--window-size=1440,900',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { detached: false, stdio: 'ignore' },
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
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      const list = await res.json();
      target = list.find((t) => t.type === 'page') ?? null;
      if (target) break;
    } catch {
      /* wait */
    }
    await sleep(300);
  }
  if (!target) {
    console.error('  ✗ CDP 会话建立超时');
    cleanup();
    process.exit(1);
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: BASE_URL });

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    const ok = await cdp.evaluate(
      `document.querySelector('header') !== null && document.querySelectorAll('button').length >= 5`,
    );
    if (ok === true) {
      ready = true;
      break;
    }
    await sleep(350);
  }
  if (!ready) {
    console.error('  ✗ 页面未在预期时间内完成水合渲染');
    cdp.close();
    cleanup();
    process.exit(1);
  }
  await sleep(1200);

  const runtimeFailures = [];

  /* 1. 静态运行期 DOM 扫描：正向 tabIndex + 可访问名称 */
  const domAudit = await cdp.evaluate(`(() => {
    const selectors = 'button, a[href], input, select, textarea, [tabindex]';
    const all = Array.from(document.querySelectorAll(selectors));
    const positiveTabIndex = [];
    const missingNames = [];
    let visibleInteractiveCount = 0;

    for (const el of all) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const hidden = style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0;
      if (hidden) continue;
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
        /* 仍计入控件 */
      }
      visibleInteractiveCount += 1;
      const ti = el.getAttribute('tabindex');
      if (ti !== null && Number(ti) > 0) {
        positiveTabIndex.push({ tag: el.tagName, tabIndex: Number(ti), text: (el.innerText || '').slice(0, 40) });
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        const hasLabel =
          (el.getAttribute('aria-label') || '').trim() !== '' ||
          (el.getAttribute('placeholder') || '').trim() !== '' ||
          (el.id && document.querySelector('label[for="' + el.id + '"]') !== null);
        if (!hasLabel) {
          missingNames.push({ tag: el.tagName, className: String(el.className || '').slice(0, 60) });
        }
        continue;
      }
      const ariaLabel = (el.getAttribute('aria-label') || '').trim();
      const labelledBy = (el.getAttribute('aria-labelledby') || '').trim();
      const labelText = labelledBy
        ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim()
        : '';
      const title = (el.getAttribute('title') || '').trim();
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!ariaLabel && !labelText && !title && !text) {
        missingNames.push({ tag: el.tagName, className: String(el.className || '').slice(0, 60) });
      }
    }
    return { visibleInteractiveCount, positiveTabIndex, missingNames };
  })()`);

  if (!domAudit || domAudit.visibleInteractiveCount === 0) {
    runtimeFailures.push('未检测到可见可交互控件');
  } else {
    console.log(`  ✓ 运行期可见可交互控件: ${domAudit.visibleInteractiveCount} 个`);
  }
  if ((domAudit?.positiveTabIndex?.length ?? 0) > 0) {
    runtimeFailures.push(`发现正向 tabIndex 陷阱: ${JSON.stringify(domAudit.positiveTabIndex)}`);
  } else {
    console.log('  ✓ tabIndex 顺序审计通过（0 个正向 tabIndex）');
  }
  if ((domAudit?.missingNames?.length ?? 0) > 0) {
    runtimeFailures.push(`发现缺少可访问名称的控件: ${JSON.stringify(domAudit.missingNames.slice(0, 5))}`);
  } else {
    console.log('  ✓ 全部可见交互控件均具备非空可访问名称');
  }

  /* 2. Tab 键焦点遍历与 :focus-visible 指示器验证 */
  const focusVisited = [];
  let visibleFocusCount = 0;
  for (let step = 0; step < 8; step += 1) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
    await sleep(60);
    const active = await cdp.evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const st = window.getComputedStyle(el);
      const hasOutline = st.outlineStyle !== 'none' && parseFloat(st.outlineWidth || '0') > 0;
      const hasRingShadow = st.boxShadow !== 'none' && st.boxShadow !== '';
      return {
        tag: el.tagName,
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
        outlineStyle: st.outlineStyle,
        outlineWidth: st.outlineWidth,
        boxShadow: st.boxShadow,
        focusVisibleMatch: el.matches(':focus-visible'),
        hasVisualFocus: hasOutline || hasRingShadow,
      };
    })()`);
    if (active) {
      focusVisited.push(active);
      if (active.hasVisualFocus || active.focusVisibleMatch) {
        visibleFocusCount += 1;
      }
    }
  }
  if (focusVisited.length < 3 || visibleFocusCount === 0) {
    runtimeFailures.push(
      `Tab 焦点遍历未观测到有效 :focus-visible 指示器: visited=${JSON.stringify(focusVisited.slice(0, 4))}`,
    );
  } else {
    console.log(
      `  ✓ Tab 键盘遍历到达 ${focusVisited.length} 个控件（${visibleFocusCount} 个具备可见焦点指示器）`,
    );
  }

  /* 3. ChaosControlModal 开启时 <header inert> 契约与 Esc 恢复 */
  const openedChaos = await cdp.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.getAttribute('aria-label') || b.textContent || '').includes('故障演练'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(300);
  const inertWhileOpen = await cdp.evaluate(`(() => {
    const header = document.querySelector('header');
    const dialog = document.querySelector('[role="dialog"]');
    return {
      hasHeader: header !== null,
      headerInert: header !== null && header.hasAttribute('inert'),
      hasDialog: dialog !== null,
    };
  })()`);

  if (!openedChaos || !inertWhileOpen?.headerInert || !inertWhileOpen?.hasDialog) {
    runtimeFailures.push(
      `模态框开启时 <header inert> 校验失败: opened=${openedChaos}, state=${JSON.stringify(inertWhileOpen)}`,
    );
  } else {
    console.log('  ✓ ChaosControlModal 开启时 <header inert> 与 dialog role 正常生效');
  }

  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await sleep(350);
  const inertAfterClose = await cdp.evaluate(`(() => {
    const header = document.querySelector('header');
    return {
      headerInert: header !== null && header.hasAttribute('inert'),
      hasDialog: document.querySelector('[role="dialog"]') !== null,
    };
  })()`);
  if (inertAfterClose?.headerInert || inertAfterClose?.hasDialog) {
    runtimeFailures.push(`Esc 关闭模态框后 <header inert> 未清理: ${JSON.stringify(inertAfterClose)}`);
  } else {
    console.log('  ✓ Esc 关闭模态框后 <header inert> 与焦点屏蔽正确解除');
  }

  cdp.close();
  cleanup();

  if (runtimeFailures.length > 0) {
    console.error('\n  ✗ 运行时 A11y 校验失败:');
    for (const err of runtimeFailures) {
      console.error(`    · ${err}`);
    }
    process.exit(1);
  }
  console.log('\n  ✓ 静态 + 运行时 A11y 门禁全部通过');
  process.exit(0);
}

runRuntimeA11yChecks().catch((err) => {
  console.error('\n  [FATAL] 运行时 A11y 检查异常:', err);
  process.exit(1);
});
