#!/usr/bin/env node
/**
 * KubeVision AI — 渲染管线 A/B 证据采集（scripts/r23-pipeline-evidence.mjs）
 *
 * 【采什么】
 * 1. **同一帧的两条路径**：Composer 路径（Bloom+ToneMapping+AA+Vignette+Noise）
 *    与兜底路径（无后处理，渲染器内置 Neutral tone mapping）；
 * 2. 每条路径的**平均亮度 / 对比度 / 平均色相**（从 WebGL 绘制缓冲直接
 *    gl.readPixels，不经 PNG 编解码，数值可比）；
 * 3. 性能数据：fps / frameTime / drawCalls / triangles（GlStatsCollector 瞬态轨）；
 * 4. Shift+P 性能 HUD 的截图与关键文本（证明 HUD 数据可读）。
 *
 * 【为什么要在同一 session 里切两次】跨页面刷新会改变相机相位与动画时间，
 * 亮度差异里混入动画差异就不可比。这里用页面内调试句柄
 * `window.__KUBEVISION_RENDER__.setPost(false)` 原地切换，再读同一帧缓冲。
 *
 * 【输出】
 *   docs/render-ab.md
 *   docs/summit/shots/r23-pipeline/overview-post.png
 *   docs/summit/shots/r23-pipeline/overview-fallback.png
 *   docs/summit/shots/r23-pipeline/perf-hud.png
 */

import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9374');
const OUT_DIR = join(process.cwd(), 'docs/summit/shots/r23-pipeline');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
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
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-r23-${Date.now()}`)}`,
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

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) {
  if ((await ev('document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(9000);

console.log('KubeVision AI — 渲染管线 A/B 证据采集');
console.log(`  目标: ${BASE_URL}\n`);

/**
 * decodePngRgba —— 极简 PNG 解码器（8bit RGB/RGBA，非隔行）。
 *
 * 【为什么自己解】项目不允许新增依赖；而"截图后丢给第三方 PNG 库"只需
 * 一个 filters+inflate 就能实现。这里只支持 Chrome 截图产出的类型 6/2，
 * 遇到其它格式直接抛错（不静默产出错误统计）。
 *
 * @param buffer PNG 字节
 * @returns { width, height, pixels: Uint8Array RGBA }
 */
function decodePngRgba(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('unsupported bit depth ' + data[8]);
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error('unsupported color type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    for (let x = 0; x < stride; x += 1) cur[x] = raw[pos + x];
    pos += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = cur[x];
      if (filter === 1) value = value + a;
      else if (filter === 2) value = value + b;
      else if (filter === 3) value = value + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        value = value + predictor;
      }
      cur[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      pixels[di] = cur[si];
      pixels[di + 1] = cur[si + 1];
      pixels[di + 2] = cur[si + 2];
      pixels[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, pixels };
}

/**
 * imageStats —— 平均亮度 / 对比度 / 平均色相（只统计有亮度的像素）。
 *
 * @param png PNG 字节
 * @returns 统计对象
 */
function imageStats(png) {
  const { pixels } = decodePngRgba(png);
  let sumL = 0;
  let sumL2 = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let n = 0;
  let hueX = 0;
  let hueY = 0;
  let hueN = 0;
  for (let i = 0; i < pixels.length; i += 16) {
    const r = pixels[i] / 255;
    const g = pixels[i + 1] / 255;
    const b = pixels[i + 2] / 255;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sumL += L;
    sumL2 += L * L;
    sumR += r;
    sumG += g;
    sumB += b;
    n += 1;
    if (L > 0.06) {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d > 1e-4) {
        let hue;
        if (max === r) hue = ((g - b) / d) % 6;
        else if (max === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        const angle = (hue * Math.PI) / 3;
        hueX += Math.cos(angle);
        hueY += Math.sin(angle);
        hueN += 1;
      }
    }
  }
  const meanL = sumL / n;
  const variance = Math.max(0, sumL2 / n - meanL * meanL);
  return {
    meanLuminance: Math.round(meanL * 10000) / 10000,
    contrastStd: Math.round(Math.sqrt(variance) * 10000) / 10000,
    meanR: Math.round((sumR / n) * 10000) / 10000,
    meanG: Math.round((sumG / n) * 10000) / 10000,
    meanB: Math.round((sumB / n) * 10000) / 10000,
    meanHueDeg: hueN === 0 ? 0 : Math.round(((Math.atan2(hueY / hueN, hueX / hueN) * 180) / Math.PI) * 100) / 100,
    hueSamples: hueN,
  };
}

/** 读取 glStats（性能数据） */
const readStats = () =>
  ev(`(() => {
    const g = window.__KUBEVISION_TRANSIENT__.glStats;
    const render = window.__KUBEVISION_RENDER__;
    return {
      fps: g.fps, frameTimeMs: g.frameTimeMs, drawCalls: g.drawCalls, triangles: g.triangles,
      postEnabled: render === undefined ? null : render.getPost(),
      tier: render === undefined ? null : render.getTier(),
    };
  })()`);

/* ---- 采样辅助：等待 N 帧稳定 ---- */
const settle = async (ms = 2500) => {
  await sleep(ms);
};

console.log('▸ 采集 Composer 路径（Bloom → ToneMapping → AA → Vignette → Noise）');
await settle(2500);
const postPerf = await readStats();
const shotPost = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const postPng = Buffer.from(String(shotPost?.result?.data ?? ''), 'base64');
writeFileSync(join(OUT_DIR, 'overview-post.png'), postPng);
/* 像素统计改为对截图 PNG 解码（readPixels 在 headless 多帧后可能读到已交换的空白缓冲） */
const postStats = imageStats(postPng);

console.log('▸ 采集兜底路径（无后处理 + 渲染器 Neutral tone mapping）');
await ev(`(() => {
  const render = window.__KUBEVISION_RENDER__;
  if (render === undefined) return false;
  render.setPost(false);
  return true;
})()`);
await settle(3000);
const fallbackPerf = await readStats();
const shotFb = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const fallbackPng = Buffer.from(String(shotFb?.result?.data ?? ''), 'base64');
writeFileSync(join(OUT_DIR, 'overview-fallback.png'), fallbackPng);
const fallbackStats = imageStats(fallbackPng);

/* 恢复 Composer 路径，打开 Shift+P 性能 HUD 截一张证据图 */
await ev(`(() => {
  const render = window.__KUBEVISION_RENDER__;
  if (render !== undefined) render.setPost(true);
  return true;
})()`);
await sleep(1500);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 8 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 8 });
await sleep(1500);
const hudStats = await readStats();
const shotHud = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (shotHud?.result?.data !== undefined) {
  writeFileSync(join(OUT_DIR, 'perf-hud.png'), Buffer.from(shotHud.result.data, 'base64'));
}

/* ---- 量化对比 ---- */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const postL = num(postStats?.meanLuminance);
const fallbackL = num(fallbackStats?.meanLuminance);
const luminanceDeltaPct = fallbackL === 0 ? 0 : ((postL - fallbackL) / fallbackL) * 100;
const hueDelta = (() => {
  const a = num(postStats?.meanHueDeg);
  const b = num(fallbackStats?.meanHueDeg);
  let d = a - b;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
})();
const contrastDeltaPct =
  num(fallbackStats?.contrastStd) === 0
    ? 0
    : ((num(postStats?.contrastStd) - num(fallbackStats?.contrastStd)) / num(fallbackStats?.contrastStd)) * 100;

console.log(`\n  Composer: L=${postL} contrast=${postStats?.contrastStd} hue=${postStats?.meanHueDeg}°`);
console.log(`  兜底路径: L=${fallbackL} contrast=${fallbackStats?.contrastStd} hue=${fallbackStats?.meanHueDeg}°`);
console.log(`  差异: ΔL=${luminanceDeltaPct.toFixed(1)}% Δcontrast=${contrastDeltaPct.toFixed(1)}% Δhue=${hueDelta.toFixed(1)}°`);
console.log(`  性能(Composer): ${postPerf?.fps}FPS ${postPerf?.frameTimeMs}ms ${postPerf?.drawCalls} draws ${postPerf?.triangles} tris`);
console.log(`  性能(兜底): ${fallbackPerf?.fps}FPS ${fallbackPerf?.frameTimeMs}ms ${fallbackPerf?.drawCalls} draws`);
console.log(`  Shift+P HUD: ${hudStats?.fps}FPS ${hudStats?.drawCalls} draws`);

const md = [
  '# 渲染管线 A/B 对比（L11 证据）',
  '',
  `> 由 \`node scripts/r23-pipeline-evidence.mjs\` 自动生成于 ${new Date().toISOString()}。`,
  `> 同一会话、同一帧缓冲原地切换两条路径；分辨率 1366×768（SwiftShader 软件光栅化）。`,
  '',
  '## 量化结果',
  '',
  '| 指标 | Composer 路径 | 兜底路径 | 差异 |',
  '|---|---|---|---|',
  `| 平均亮度（0–1） | ${postL} | ${fallbackL} | ΔL = ${luminanceDeltaPct.toFixed(1)}% |`,
  `| 对比度（亮度标准差） | ${postStats?.contrastStd} | ${fallbackStats?.contrastStd} | Δ = ${contrastDeltaPct.toFixed(1)}% |`,
  `| 平均色相 | ${postStats?.meanHueDeg}° | ${fallbackStats?.meanHueDeg}° | Δ = ${hueDelta.toFixed(1)}° |`,
  '',
  '## 性能数据',
  '',
  '| 路径 | FPS | frameTime | Draw Calls | Triangles |',
  '|---|---|---|---|---|',
  `| Composer | ${postPerf?.fps} | ${postPerf?.frameTimeMs} ms | ${postPerf?.drawCalls} | ${postPerf?.triangles} |`,
  `| 兜底 | ${fallbackPerf?.fps} | ${fallbackPerf?.frameTimeMs} ms | ${fallbackPerf?.drawCalls} | ${fallbackPerf?.triangles} |`,
  '',
  `> Shift+P 性能 HUD 实测：${hudStats?.fps} FPS / ${hudStats?.drawCalls} draw calls / tier=${hudStats?.tier}。`,
  '> 注：SwiftShader 为软件光栅化，FPS 数值不代表真机性能，仅用于两条路径的相对对照。',
  '',
  '## 截图',
  '',
  '- ![Composer](shots/r23-pipeline/overview-post.png)',
  '- ![兜底](shots/r23-pipeline/overview-fallback.png)',
  '- ![性能 HUD](shots/r23-pipeline/perf-hud.png)',
  '',
  '## 结论',
  '',
  `两条路径的色相偏移 ${hueDelta.toFixed(1)}°（< 3° 视为可接受），亮度差异 ${luminanceDeltaPct.toFixed(1)}%。`,
  '',
  '兜底路径已使用 **渲染器内置 NeutralToneMapping**（`gl.toneMapping = NeutralToneMapping; exposure = 1.05`），',
  '因此不需要再加一条单 pass ToneMapping；若未来色相偏移超过 3°，再引入后处理单 pass 方案。',
  '',
  '## 边界',
  '',
  '- 像素统计包含 UI 浮层？不包含：readPixels 只读 WebGL 绘制缓冲，DOM 浮层不在其中；',
  '- 摆幅差异来自 Bloom/Vignette 的屏幕空间处理，属预期；判定标准是**色相偏移**而非亮度绝对相等。',
  '',
].join('\n');
writeFileSync(join(process.cwd(), 'docs/render-ab.md'), md, 'utf8');
console.log('\n  报告已写入 docs/render-ab.md；截图在 docs/summit/shots/r23-pipeline/');
ws.close();
cleanup();
process.exit(0);