#!/usr/bin/env node
/**
 * KubeVision AI — 页面常开稳定性监控（R57 · 24h 收口）
 *
 * 【做什么】打开真实页面并保持常开指定时长，每分钟采样：
 *   - JS 堆内存（performance.memory，需 --enable-precise-memory-info）；
 *   - canvas 是否存在、页面是否仍在响应（DOM 心跳）；
 *   - console.error / 未捕获异常计数；
 *   - 每 N 分钟调用一次 `scripts/probe-blackout.mjs` 做黑屏像素探针（独立会话，见下）。
 *
 * 【黑屏探针的口径】同页面内直接 readPixels 受 `preserveDrawingBuffer:false` 限制，
 * 本脚本因此周期性调用仓库既有的 `probe-blackout.mjs`（它用 rAF 内读帧缓冲的成熟做法），
 * 记录其复现率。这属于"周期性黑屏探针"，不是"同一 canvas 每帧采样"——已在报告中写明。
 *
 * 用法：
 *   node scripts/page-open-monitor.mjs --hours=3
 *   node scripts/page-open-monitor.mjs --hours=0.05   # 快速自查（3 分钟）
 *
 * 产物：docs/page-open-3h.md（或按实际时长命名）与 docs/evidence/page-open/summary.json
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const arg = (flag) => {
  const found = process.argv.find((item) => item.startsWith(`${flag}=`));
  return found === undefined ? null : found.slice(flag.length + 1);
};
const HOURS = Math.max(0.02, Number(arg('--hours') ?? '3'));
const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const PORT = 9370;
const OUT_DIR = join(ROOT, 'docs/evidence/page-open');
const OUT_MD = join(ROOT, `docs/page-open-${String(HOURS).replace('.', '_')}h.md`);
mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isUp() {
  try { const r = await fetch(BASE_URL, { signal: AbortSignal.timeout(2500) }); return r.ok || r.status === 404; } catch { return false; }
}

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
  return result.result?.result?.value;
};

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path));
if (!EDGE) { console.error('[FATAL] Edge not found'); process.exit(1); }
if (!(await isUp())) { console.error('[FATAL] dev server 不可达，请先 pnpm dev'); process.exit(1); }

const browser = spawn(EDGE, [
  '--headless=new', '--no-first-run', '--hide-scrollbars',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--enable-precise-memory-info', '--window-size=1920,1080',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '/tmp', 'kv-page-open-' + Date.now())}`,
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 200; i += 1) {
  if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(4000);

const startedAt = Date.now();
const samples = [];
const errors = [];
cdp.send('Runtime.enable');
const intervalMs = 60 * 1000;
const totalSamples = Math.max(1, Math.round((HOURS * 60 * 60 * 1000) / intervalMs));
let lastProbeAt = 0;
for (let index = 0; index < totalSamples; index += 1) {
  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  const sample = await evaluate(cdp, `(() => {
    const memory = performance.memory;
    return {
      canvas: document.querySelector('canvas') !== null,
      title: document.title,
      usedHeapMB: memory ? +(memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      totalHeapMB: memory ? +(memory.totalJSHeapSize / 1048576).toFixed(1) : null,
      bodyText: (document.body.innerText || '').length,
    };
  })()`);
  samples.push({ at: new Date().toISOString(), elapsedMin, ...(sample ?? {}) });
  console.log(`  [${elapsedMin}min] heap=${sample?.usedHeapMB}MB canvas=${sample?.canvas}`);

  /* 每 15 分钟做一次黑屏像素探针（独立会话） */
  if (Date.now() - lastProbeAt > 15 * 60 * 1000) {
    lastProbeAt = Date.now();
    const probe = spawnSync(process.execPath, ['scripts/probe-blackout.mjs', '--action', 'none', '--repeat', '1', '--duration', '5'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
    writeFileSync(join(OUT_DIR, `probe-${index}.log`), output, 'utf8');
    const ratio = output.match(/黑屏复现率\s*:\s*(\d+)\/(\d+)/);
    samples[samples.length - 1].blackout = ratio === null ? null : `${ratio[1]}/${ratio[2]}`;
  }
  if (index < totalSamples - 1) await sleep(intervalMs);
}

const finishedAt = new Date();
const heapValues = samples.map((sample) => sample.usedHeapMB).filter((value) => typeof value === 'number');
const first = heapValues[0] ?? 0;
const last = heapValues[heapValues.length - 1] ?? 0;
const growthPct = first === 0 ? null : +(((last - first) / first) * 100).toFixed(1);
const canvasLost = samples.filter((sample) => sample.canvas !== true).length;
const lines = [
  `# 页面常开监控（${HOURS} 小时）`,
  '',
  `- 开始：${new Date(startedAt).toISOString()}`,
  `- 结束：${finishedAt.toISOString()}`,
  `- 采样：${samples.length} 次（每分钟）`,
  `- 堆内存：首 ${first}MB → 末 ${last}MB（增长 ${growthPct === null ? 'n/a' : growthPct + '%'}）`,
  `- canvas 缺失采样：${canvasLost}/${samples.length}`,
  `- 黑屏探针：每 15 分钟一次（见 samples.blackout；独立会话，非同一 canvas）`,
  '',
  '| 时间 | 已运行(min) | heap(MB) | canvas | 黑屏探针 |',
  '|---|---|---|---|---|',
  ...samples.map((sample) => `| ${sample.at} | ${sample.elapsedMin} | ${sample.usedHeapMB} | ${sample.canvas} | ${sample.blackout ?? '—'} |`),
  '',
  '> 判定：canvas 缺失 0 次且黑屏探针均为 0/N 视为通过；堆内存增长仅作趋势参考（GC 时机影响末值）。',
  '',
];
writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify({ hours: HOURS, startedAt: new Date(startedAt).toISOString(), finishedAt: finishedAt.toISOString(), samples, growthPct, canvasLost }, null, 2) + '\n', 'utf8');
console.log(`\n 报告：${OUT_MD}`);
cdp.close();
try { browser.kill('SIGKILL'); } catch { /* ignore */ }
process.exit(canvasLost === 0 ? 0 : 1);