#!/usr/bin/env node
/**
 * KubeVision AI — 最终证据截图（R55 · 任务 6）
 *
 * 用 headless Edge + CDP 打开真实页面，采集四张关键证据图：
 *  1. 首屏总览（1920×1080）
 *  2. 性能 HUD（点顶栏「性能」）
 *  3. RAG 三路检索结果（真实输入「容器内存爆了 exit 137」）
 *  4. 端侧审计（页签「端侧日志审计」→ 预设「数据库连接串泄露」→「抓取并审计日志流」）
 *
 * 用法：node scripts/capture-final-evidence.mjs [--base http://127.0.0.1:3000]
 * 产物：docs/evidence/*.png（文件名带日期）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const readArg = (flag) => {
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : null;
};
const BASE = readArg('--base') ?? 'http://127.0.0.1:3000';
const PORT = 9337;
const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'docs/evidence');
const DATE = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

/** 连接 CDP */
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
  '--window-size=1920,1080', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '/tmp', 'kv-evidence-' + Date.now())}`,
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE });
for (let i = 0; i < 200; i += 1) {
  if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(4000);

/** 截图并落盘 */
const shot = async (name) => {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const base64 = result.result?.data;
  if (typeof base64 !== 'string' || base64.length === 0) throw new Error('capture failed ' + name);
  const file = join(OUT_DIR, `${name}-${DATE}.png`);
  writeFileSync(file, Buffer.from(base64, 'base64'));
  console.log('  saved:', file.replace(ROOT + '\\', ''));
};

/** 点击可见按钮（按文本） */
const clickByText = (text) => evaluate(cdp, `(() => {
  const hit = Array.from(document.querySelectorAll('button')).find((b) => ((b.textContent || '') + (b.getAttribute('aria-label') || '')).includes(${JSON.stringify(text)}));
  if (!hit) return { ok: false };
  hit.click();
  return { ok: true };
})()`);

const clicks = [];
try {
  await shot('final-overview');
  clicks.push({ step: 'overview', ok: true });

  await evaluate(cdp, `(() => {
    const existing = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('性能监控 HUD'));
    if (existing) return { ok: true };
    const moreBtn = document.querySelector('button[aria-label="打开状态过滤与工具菜单"]');
    if (moreBtn) moreBtn.click();
    return { ok: Boolean(moreBtn) };
  })()`);
  await sleep(250);
  clicks.push({ step: 'perf-hud', ...(await evaluate(cdp, `(() => {
    const hit = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('性能监控 HUD'));
    if (!hit) return { ok: false };
    hit.click();
    return { ok: true };
  })()`)) });
  await sleep(1200);
  await shot('performance-hud');
  /* 关闭 HUD 与更多菜单，避免遮挡后续 */
  await evaluate(cdp, `(() => {
    const closeHud = document.querySelector('button[aria-label="关闭性能遥测"]');
    if (closeHud) {
      closeHud.click();
    } else {
      const hit = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('性能监控 HUD'));
      if (hit) hit.click();
    }
    const openMore = document.querySelector('button[aria-label="打开状态过滤与工具菜单"][aria-expanded="true"]');
    if (openMore) openMore.click();
  })()`);
  await sleep(400);

  clicks.push({ step: 'rag-open', ...(await clickByText('RAG 知识库')) });
  await sleep(900);
  clicks.push({ step: 'rag-query', ...(await evaluate(cdp, `(() => {
    const input = document.querySelector('input[aria-label="故障描述检索输入"]');
    if (!input) return { ok: false };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '容器内存爆了 exit 137');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return { ok: true };
  })()`)) });
  await sleep(1600);
  await shot('rag-three-way');
  await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('aria-label') || '') === '关闭知识库弹窗'); if (b) b.click(); })()`);
  await sleep(700);

  clicks.push({ step: 'auditor-tab', ...(await clickByText('端侧日志审计')) });
  await sleep(1800);
  clicks.push({ step: 'auditor-preset', ...(await clickByText('数据库连接串泄露')) });
  await sleep(500);
  clicks.push({ step: 'auditor-run', ...(await clickByText('抓取并审计日志流')) });
  await sleep(2600);
  await shot('auditor-before-after');
} catch (error) {
  console.error('[ERROR]', error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT_DIR, `capture-manifest-${DATE}.json`), JSON.stringify({ base: BASE, date: DATE, clicks }, null, 2) + '\n', 'utf8');
  cdp.close();
  cleanup();
}