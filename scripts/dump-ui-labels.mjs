#!/usr/bin/env node
/**
 * 开发期 UI 文案抓取（不参与产品）：用 CDP 打开真实页面，逐级展开关键入口，
 * 把按钮文本 / aria-label / role=tab / dialog 文案落盘，供答辩稿"以代码为准"。
 *
 * 用法：node scripts/dump-ui-labels.mjs [--base http://127.0.0.1:3000] [--out tmp-ui-dump.json]
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const readArg = (flag) => {
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : null;
};
const BASE = readArg('--base') ?? 'http://127.0.0.1:3000';
const OUT = readArg('--out') ?? 'tmp-ui-dump.json';
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error('CDP timeout ' + method)), 30000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}

const evaluate = async (cdp, expression) => {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text) };
  return res.result?.result?.value;
};

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const edgePath = EDGE_PATHS.find((p) => existsSync(p));
if (!edgePath) { console.error('[FATAL] Edge not found'); process.exit(1); }

const browser = spawn(edgePath, [
  '--headless=new', '--no-first-run', '--hide-scrollbars',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1600,900', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '/tmp', 'kv-ui-dump-' + Date.now())}`,
  'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } };
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
    const list = await res.json();
    target = list.find((t) => t.type === 'page') ?? null;
    if (target) break;
  } catch { /* retry */ }
  await sleep(500);
}
if (!target) { console.error('[FATAL] CDP not ready'); process.exit(1); }
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE });
for (let i = 0; i < 200; i += 1) {
  if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(4000);

/** 抓当前可见按钮/页签/dialog 文案 */
const snapshot = () => evaluate(cdp, `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const clean = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
  const buttons = Array.from(document.querySelectorAll('button'))
    .filter(visible)
    .map((b) => ({
      text: clean(b.textContent),
      aria: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      disabled: b.disabled,
    }))
    .filter((b) => b.text || b.aria || b.title);
  const tabs = Array.from(document.querySelectorAll('[role="tab"],[role="tablist"] button'))
    .filter(visible)
    .map((t) => ({ text: clean(t.textContent), aria: t.getAttribute('aria-label'), selected: t.getAttribute('aria-selected') }));
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'))
    .filter(visible)
    .map((d) => ({ aria: d.getAttribute('aria-label'), text: clean(d.textContent).slice(0, 900) }));
  const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
    .filter(visible)
    .map((h) => clean(h.textContent))
    .slice(0, 12);
  const placeholders = Array.from(document.querySelectorAll('input,textarea'))
    .filter(visible)
    .map((i) => ({ placeholder: i.getAttribute('placeholder'), aria: i.getAttribute('aria-label'), value: i.value?.slice(0, 40) }));
  return { buttons, tabs, dialogs, headings, placeholders, title: document.title, url: location.href };
})()`);

const clickByText = (text) => evaluate(cdp, `(() => {
  const candidates = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="tab"]'));
  const hit = candidates.find((el) => (el.textContent || '').replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}));
  if (!hit) return { ok: false };
  hit.click();
  return { ok: true, text: (hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80), aria: hit.getAttribute('aria-label') };
})()`);

const pressKey = (key, code, modifiers = 0) => evaluate(cdp, `(() => {
  const options = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true, ctrlKey: ${modifiers === 2}, metaKey: false };
  document.dispatchEvent(new KeyboardEvent('keydown', options));
  window.dispatchEvent(new KeyboardEvent('keydown', options));
  return true;
})()`);

const escape = async () => { await evaluate(cdp, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`); await sleep(500); };

const result = {};
try {
  result.initial = await snapshot();

  /* 故障演练 */
  result.clickFaultDrill = await clickByText('故障演练');
  await sleep(900);
  result.faultDrillDialog = await snapshot();
  await escape();

  /* RAG 知识库 */
  result.clickRag = await clickByText('RAG 知识库');
  await sleep(900);
  result.ragDialog = await snapshot();
  await escape();

  /* 路演 */
  result.clickDemo = await clickByText('路演');
  await sleep(700);
  result.demoMenu = await snapshot();
  await escape();

  /* 端侧日志审计页签 */
  result.clickAuditor = await clickByText('端侧日志审计');
  await sleep(1200);
  result.auditorPanel = await snapshot();
  await escape();

  /* 相机图标 / 快照诊断 aria-label */
  result.viewportToolbar = await evaluate(cdp, `(() => {
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => ({ aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), text: (b.textContent || '').trim().slice(0, 30) })).filter((b) => b.aria || b.title);
    return buttons.filter((b) => /快照|诊断|相机|导出|截图|camera|snapshot/i.test((b.aria || '') + ' ' + (b.title || '') + ' ' + b.text));
  })()`);

  /* 回到 Copilot 页签（审计页签下没有 CMD 卡片与 RAG 入口） */
  result.backToCopilot = await clickByText('AI 运维副驾');
  await sleep(900);

  /* ---------- 命令面板（真实按钮：搜索拓扑⌘K） ---------- */
  await clickByText('搜索拓扑');
  await sleep(900);
  result.commandPalette = await snapshot();
  await escape();

  /* ---------- 注入 OOM：点场景卡片即注入 ---------- */
  await clickByText('故障演练');
  await sleep(700);
  result.injectOom = await evaluate(cdp, `(() => {
    const card = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').startsWith('A · POD_OOM_SWARM'));
    if (!card) return { ok: false };
    card.click();
    return { ok: true };
  })()`);
  await sleep(1600);
  result.chaosBanner = await evaluate(cdp, `(() => {
    const text = (document.body.textContent || '').replace(/\\s+/g, ' ');
    const banner = document.querySelector('[aria-label*="演练中"],[data-chaos-banner]');
    const terminate = Array.from(document.querySelectorAll('button')).filter((b) => /终止|停止演练|结束演练/.test((b.textContent || '') + (b.getAttribute('aria-label') || ''))).map((b) => ({ text: (b.textContent || '').trim(), aria: b.getAttribute('aria-label') }));
    return { bannerAria: banner === null ? null : banner.getAttribute('aria-label'), terminate, snippet: text.slice(0, 500) };
  })()`);

  /* ---------- CMD-02 诊断，等动作卡出现 ---------- */
  result.runCmd02 = await clickByText('CMD-02');
  let actionSeen = false;
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    actionSeen = (await evaluate(cdp, `document.body.textContent.includes('立即执行自愈方案') || document.body.textContent.includes('需二次确认') || document.body.textContent.includes('请先勾选确认')`)) === true;
    if (actionSeen) break;
  }
  result.actionCardSeen = actionSeen;
  result.actionCard = await evaluate(cdp, `(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const execute = buttons.find((b) => /立即执行自愈方案|需二次确认|请先勾选确认/.test(b.textContent || ''));
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).map((c) => ({
      checked: c.checked,
      label: (c.closest('label')?.textContent || c.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      disabled: c.disabled,
    }));
    let cardText = '';
    if (execute) { let node = execute; for (let i = 0; i < 8 && node; i += 1) { node = node.parentElement; if (node && (node.textContent || '').includes('立即执行自愈方案')) { cardText = (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 900); break; } } }
    const postMortem = buttons.filter((b) => /复盘报告/.test((b.textContent || '') + (b.getAttribute('aria-label') || ''))).map((b) => ({ text: (b.textContent || '').trim(), aria: b.getAttribute('aria-label'), disabled: b.disabled }));
    const engineLine = Array.from(document.querySelectorAll('span,div,p')).map((el) => (el.textContent || '').trim()).find((t) => t.startsWith('推理引擎'));
    return { executeButton: execute ? { text: (execute.textContent || '').trim(), aria: execute.getAttribute('aria-label'), disabled: execute.disabled } : null, checkboxes, cardText, postMortem, engineLine: engineLine ?? null };
  })()`);

  /* ---------- 恢复稳态：D · NONE ---------- */
  await clickByText('故障演练');
  await sleep(700);
  result.restore = await evaluate(cdp, `(() => {
    const card = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').startsWith('D · NONE'));
    if (!card) return { ok: false };
    card.click();
    return { ok: true };
  })()`);
  await sleep(900);

  /* ---------- RAG 检索：正例 + 负例拒答 ---------- */
  await clickByText('RAG 知识库');
  await sleep(900);
  const typeQuery = async (query) => evaluate(cdp, `(() => {
    const input = document.querySelector('input[aria-label="故障描述检索输入"]');
    if (!input) return { ok: false };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return { ok: true };
  })()`);
  result.ragQuery1 = await typeQuery('容器内存爆了 exit 137');
  await sleep(1500);
  result.ragResult1 = await snapshot();
  result.ragQuery2 = await typeQuery('今天天气怎么样');
  await sleep(1500);
  result.ragResult2 = await snapshot();
  await escape();
} catch (error) {
  result.error = String(error);
} finally {
  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('UI dump written:', OUT);
  cdp.close();
  cleanup();
}

process.exit(result.error ? 1 : 0);