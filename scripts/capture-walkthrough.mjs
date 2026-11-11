#!/usr/bin/env node
/**
 * KubeVision AI — 全量手动走查截图（R57）
 *
 * 用真实 UI 走关键路径并截图，覆盖：
 *   1) 首屏；2) 选中 Pod；3) 故障注入；4) 快照诊断三卡（含动作卡）；
 *   5) 复盘报告；6) 1366×768；7) 语音输入入口（无麦克风时的降级提示）。
 *
 * 说明：抽屉拖拽、语音播报、真断网等需要人工操作/硬件，脚本不伪造；
 * 对应项在 docs/summit/MANUAL_WALKTHROUGH.md 标 ⚠ 并写明人工步骤。
 *
 * 用法：node scripts/capture-walkthrough.mjs（需 pnpm dev）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASE = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const DATE = new Date().toISOString().slice(0, 10);
const OUT = join(ROOT, 'docs/evidence/walkthrough');
const PORT = 9375;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(OUT, { recursive: true });

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path));
if (!EDGE) { console.error('[FATAL] Edge not found'); process.exit(1); }

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error('CDP timeout ' + method)), 30000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}
const evaluate = async (cdp, expression) => {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) return { __err: String(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text) };
  return result.result?.result?.value;
};

const browser = spawn(EDGE, [
  '--headless=new', '--no-first-run', '--hide-scrollbars',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1680,1000', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '/tmp', 'kv-walk-' + Date.now())}`,
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } });

let target = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
    const list = await response.json();
    target = list.find((item) => item.type === 'page') ?? null;
    if (target) break;
  } catch { /* retry */ }
  await sleep(500);
}
if (!target) { console.error('[FATAL] CDP not ready'); process.exit(1); }
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE });
for (let i = 0; i < 200; i += 1) {
  if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(4000);

const shot = async (name) => {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const data = result.result?.data;
  if (typeof data !== 'string' || data.length === 0) throw new Error('capture failed ' + name);
  const file = join(OUT, `walkthrough-${name}-${DATE}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('  saved:', file.replace(ROOT + '\\', ''));
};

const state = [];
try {
  await shot('01-first-screen');
  state.push({ item: '首屏 3 秒', image: `walkthrough-01-first-screen-${DATE}.png`, ok: true });

  /* 选中 Pod（使用 dev 调试钩子，等价于点击机架中的 Pod 刀片） */
  const selected = await evaluate(cdp, `(() => {
    const store = window.__KUBEVISION_STORE__;
    if (!store) return { ok: false, reason: 'no store' };
    const s = store.getState();
    const node = s.snapshotSummary.nodes.find((n) => n.rackIndex === 1);
    s.selectEntity(node.id, 'node');
    return { ok: true, id: node.id };
  })()`);
  await sleep(5200);
  await shot('02-pod-selected');
  state.push({ item: '选中 Pod / 相机锁定 + 探针卡', image: `walkthrough-02-pod-selected-${DATE}.png`, ok: selected?.ok === true, detail: selected });

  /* 故障注入 */
  await evaluate(cdp, `(() => { const s = window.__KUBEVISION_STORE__.getState(); s.setActiveChaos('POD_OOM_SWARM'); })()`);
  await sleep(3200);
  await shot('03-chaos-injected');
  state.push({ item: '故障注入（演练中：OOM 风暴）', image: `walkthrough-03-chaos-injected-${DATE}.png`, ok: true });

  /* 快照诊断等价路径：CMD-02 触发三卡 */
  await evaluate(cdp, `(() => {
    const tab = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('AI 运维副驾'));
    if (tab) tab.click();
  })()`);
  await sleep(600);
  const cmd = await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('CMD-02'));
    if (!button) return { ok: false };
    button.click();
    return { ok: true };
  })()`);
  let cardsSeen = false;
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    cardsSeen = (await evaluate(cdp, `document.body.textContent.includes('立即执行自愈方案') && document.body.textContent.includes('根因')`)) === true;
    if (cardsSeen) break;
  }
  await sleep(800);
  await shot('04-three-cards');
  state.push({ item: '快照诊断三卡（动作卡待执行态）', image: `walkthrough-04-three-cards-${DATE}.png`, ok: cmd?.ok === true && cardsSeen, detail: { cmd, cardsSeen } });

  /* 点一次「立即执行自愈方案」，记录第三张 MCP 卡最终态 */
  const execute = await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('立即执行自愈方案'));
    if (!button) return { ok: false };
    button.click();
    return { ok: true };
  })()`);
  await sleep(4200);
  await shot('04b-action-executed');
  state.push({ item: '第三张 MCP 卡最终态（人工点击执行）', image: `walkthrough-04b-action-executed-${DATE}.png`, ok: execute?.ok === true, detail: execute });

  /* 复盘报告 */
  const postmortem = await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('复盘报告'));
    if (!button) return { ok: false };
    button.click();
    return { ok: true };
  })()`);
  await sleep(900);
  await shot('05-postmortem');
  state.push({ item: '复盘报告', image: `walkthrough-05-postmortem-${DATE}.png`, ok: postmortem?.ok === true });
  await evaluate(cdp, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`);
  await sleep(500);

  /* 1366×768 */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await sleep(2200);
  await shot('06-1366x768');
  state.push({ item: '窗口缩放 1366×768', image: `walkthrough-06-1366x768-${DATE}.png`, ok: true });

  /* 语音输入入口（无麦克风时浏览器拒绝，界面会提示） */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const voice = await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('语音输入'));
    if (!button) return { ok: false };
    button.click();
    return { ok: true };
  })()`);
  await sleep(2000);
  await shot('07-voice-input');
  state.push({ item: '语音输入入口（无麦克风降级）', image: `walkthrough-07-voice-input-${DATE}.png`, ok: voice?.ok === true, detail: voice });

  writeFileSync(join(OUT, 'walkthrough-manifest.json'), JSON.stringify({ date: DATE, base: BASE, state }, null, 2) + '\n', 'utf8');
  console.log('  manifest written');
} catch (error) {
  console.error('[ERROR]', error);
  process.exitCode = 1;
} finally {
  cdp.close();
  try { browser.kill('SIGKILL'); } catch { /* ignore */ }
}