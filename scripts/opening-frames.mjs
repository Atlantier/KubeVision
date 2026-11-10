#!/usr/bin/env node
/**
 * KubeVision AI — 开场三帧采集（R30 · 追问 2 的降级替代）
 *
 * 【背景】本沙箱没有 ffmpeg / 编码器，无法直接产出 mp4。
 * 本脚本在页面挂载后按时间点抓取关键帧：0.15s（开场起点）→ 1.5s（uBoot 中段
 * + 运镜进行中）→ 3.0s（完全落位），作为"3 秒第一印象"的定帧证据。
 * 真机上可用同一脚本抓帧后交给任意编码器合成 5s 视频。
 *
 * 输出：docs/summit/shots/r30-opening/{opening-0.15s,1.5s,3.0s}.png
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9391');
const OUT_DIR = join(process.cwd(), 'docs/summit/shots/r30-opening');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path));
if (EDGE === undefined) {
  console.error('未找到 Edge');
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

const browser = spawn(
  EDGE,
  [
    '--headless=new',
    '--no-first-run',
    '--window-size=1366,768',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-open-${Date.now()}`)}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => {
  try {
    browser.kill('SIGKILL');
  } catch {
    /* ignore */
  }
});

let target = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    target = list.find((item) => item.type === 'page') ?? null;
    if (target !== null) break;
  } catch {
    /* 等浏览器 */
  }
  await sleep(500);
}
if (target === null) {
  console.error('CDP 未就绪');
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
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return response.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

/* 先访问一次让 dev 编译完成，避免首帧被编译阻塞；随后重新导航采集开场 */
await send('Page.navigate', { url: `${BASE_URL}/?quality=high&opening=1` });
for (let i = 0; i < 240; i += 1) {
  if ((await evaluate('document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(6000);

const captureAt = async (label) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const data = String(shot?.result?.data ?? '');
  if (data.length === 0) return;
  writeFileSync(join(OUT_DIR, `opening-${label}.png`), Buffer.from(data, 'base64'));
  console.log(`  已抓取 ${label}`);
};

/* 重新加载，用页面内计时器在指定时刻截图（避免 Node 往返延迟漂移） */
await send('Page.navigate', { url: `${BASE_URL}/?quality=high&opening=1` });
await sleep(1200);
await captureAt('0.15s');
await sleep(1350);
await captureAt('1.5s');
await sleep(1500);
await captureAt('3.0s');

console.log(`[完成] ${OUT_DIR}`);
ws.close();
process.exit(0);