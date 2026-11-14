#!/usr/bin/env node
/**
 * KubeVision AI — R6 进阶量化视觉回归探针（scripts/probe-r6-advanced.mjs）
 *
 * 【测量目标（R6 进阶 Q1–Q6，零主观描述，全像素/DOM 可测量输出）】
 * - Q1 屏心无字：页面正心 x[912,1008]y[486,594] 与 3D Canvas 正心 ±5% 内
 *      无 DOM 铭牌重叠，且高对比水平文字像素条带（ΔE>12, 8<高<=26px）簇数 = 0；
 * - Q2 铭牌字号：全景 overview 全部主铭牌 getBoundingClientRect().height ∈ [10, 18] px，
 *      机架特写 pod-closeup 全部主铭牌 ∈ [10, 22] px（同时校验无旧 SYS.CORE）；
 * - Q3 四角亮度：同景深中性平场下经后处理 Vignette + DOM 径向暗角叠加后，
 *      Canvas 四角 120×120 平均亮度 ≥ 中心 120×120 的 75%（另附原始图非调暗对照）；
 * - Q4 暗部非纯黑：地面非加色采样区 ≥200 像素中亮度 0 占比 < 5%；
 * - Q5 反射无方向拖影：镜面反射地面区垂直梯度能量 Ey / 水平梯度能量 Ex ≤ 1.5；
 * - Q6 语义色不失真：Composer (?quality=high) 与降档 (?quality=low) 健康 Pod 绿像素色相角差 < 6°
 *      （同时附测 ?quality=off 兜底 NeutralToneMapping 色相差）。
 *
 * 【用法】
 *   node scripts/probe-r6-advanced.mjs
 *   node scripts/probe-r6-advanced.mjs --base http://127.0.0.1:3000 --before-base http://127.0.0.1:3001 --gpu d3d11
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

if (EDGE === undefined) {
  console.error('[FATAL] 未找到 Microsoft Edge');
  process.exit(2);
}

function readArg(flag, fallback = null) {
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

const AFTER_BASE = readArg('--base', 'http://127.0.0.1:3000');
const BEFORE_BASE = readArg('--before-base', null);
const GPU_MODE = readArg('--gpu', 'd3d11');
const OUT_JSON = readArg('--out', 'docs/summit/r6-advanced-probe.json');
const SHOTS_DIR = readArg('--shots-dir', 'docs/summit/shots/r6-advanced');
const CDP_PORT = Number(readArg('--cdp-port', '9381'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/* 零依赖 8-bit PNG 解码与色彩/梯度数学                                       */
/* ========================================================================== */

function decodePng(buffer) {
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
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0 || width === 0 || height === 0) {
    throw new Error(`Unsupported PNG format: colorType=${colorType} ${width}x${height}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x += 1) cur[x] = raw[pos + x];
    pos += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
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

function lumaAt(pixels, width, x, y) {
  const i = (y * width + x) * 4;
  return 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
}

function rgbToLab(r, g, b) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / 1.0;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE76(lab1, lab2) {
  return Math.hypot(lab1[0] - lab2[0], lab1[1] - lab2[1], lab1[2] - lab2[2]);
}

function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, v: max * 100 };
}

function hueAngleDiff(h1, h2) {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

/** Q1：在指定矩形内统计 ΔE>12 且垂直高 8<h<=28px 的横向文字像素条带簇 */
function analyzeCenterTextClusters(png, x0, x1, y0, y1) {
  const { width, pixels } = png;
  const borderSamples = [];
  for (let x = x0; x <= x1; x += 2) {
    for (const y of [y0, y1]) {
      const i = (y * width + x) * 4;
      borderSamples.push(rgbToLab(pixels[i], pixels[i + 1], pixels[i + 2]));
    }
  }
  const refLab = [0, 0, 0];
  for (const lab of borderSamples) {
    refLab[0] += lab[0];
    refLab[1] += lab[1];
    refLab[2] += lab[2];
  }
  refLab[0] /= borderSamples.length;
  refLab[1] /= borderSamples.length;
  refLab[2] /= borderSamples.length;

  const rowBrightTextWidth = [];
  for (let y = y0; y <= y1; y += 1) {
    let activeCols = 0;
    let runs = 0;
    let inRun = false;
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * width + x) * 4;
      const de = deltaE76(rgbToLab(pixels[i], pixels[i + 1], pixels[i + 2]), refLab);
      const luma = lumaAt(pixels, width, x, y);
      /* 文字核心显著区别于边缘深蓝玻璃背景，且同水平线存在多笔画间断（runs >= 3，排除单根连续斜线光束） */
      const hit = de > 12 && luma > 135;
      if (hit) {
        activeCols += 1;
        if (!inRun) {
          runs += 1;
          inRun = true;
        }
      } else {
        inRun = false;
      }
    }
    rowBrightTextWidth.push({ y, activeCols, runs });
  }

  /* 合并相邻多笔画活跃行，按高度区分「文字条带(8<h<=28)」与大块晶核光团 */
  const bands = [];
  const rawBrightBands = [];
  let start = null;
  let rawStart = null;
  for (const row of rowBrightTextWidth) {
    if (row.activeCols >= 6) {
      if (rawStart === null) rawStart = row.y;
    } else if (rawStart !== null) {
      rawBrightBands.push({ yStart: rawStart, yEnd: row.y - 1, heightPx: row.y - rawStart });
      rawStart = null;
    }
    if (row.activeCols >= 8 && row.runs >= 3) {
      if (start === null) start = row.y;
    } else if (start !== null) {
      bands.push({ yStart: start, yEnd: row.y - 1, heightPx: row.y - start });
      start = null;
    }
  }
  if (rawStart !== null) {
    rawBrightBands.push({ yStart: rawStart, yEnd: y1, heightPx: y1 - rawStart + 1 });
  }
  if (start !== null) {
    bands.push({ yStart: start, yEnd: y1, heightPx: y1 - start + 1 });
  }
  const textSizedBands = bands.filter((b) => b.heightPx > 8 && b.heightPx <= 28);
  return { bands, rawBrightBands, textSizedClusterCount: textSizedBands.length };
}

/** 采样矩形平均亮度 */
function meanBoxLuma(png, x0, y0, boxW, boxH) {
  const { width, height, pixels } = png;
  const cx0 = Math.max(0, Math.round(x0));
  const cy0 = Math.max(0, Math.round(y0));
  const cx1 = Math.min(width, cx0 + boxW);
  const cy1 = Math.min(height, cy0 + boxH);
  let sum = 0;
  let cnt = 0;
  for (let y = cy0; y < cy1; y += 1) {
    for (let x = cx0; x < cx1; x += 1) {
      sum += lumaAt(pixels, width, x, y);
      cnt += 1;
    }
  }
  return cnt > 0 ? +(sum / cnt).toFixed(3) : 0;
}

/** Q4：地面暗部（避开高光圆环）采样 ≥200 非加色像素，统计亮度 0 占比 */
function analyzeGroundDarkRegion(png, canvasRect) {
  const { width, pixels } = png;
  /* 相对 1920x1080 Canvas：中右下方非环线石板带 */
  const rx0 = Math.round(canvasRect.left + canvasRect.width * 0.60);
  const rx1 = Math.round(canvasRect.left + canvasRect.width * 0.74);
  const ry0 = Math.round(canvasRect.top + canvasRect.height * 0.75);
  const ry1 = Math.round(canvasRect.top + canvasRect.height * 0.83);
  const samples = [];
  for (let y = ry0; y < ry1; y += 3) {
    for (let x = rx0; x < rx1; x += 3) {
      const i = (y * width + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luma < 65) {
        samples.push({ r, g, b, luma });
      }
    }
  }
  const zeroLumaCount = samples.filter((s) => s.luma < 1).length;
  const meanRgb =
    samples.length > 0
      ? [
          +(samples.reduce((a, s) => a + s.r, 0) / samples.length).toFixed(2),
          +(samples.reduce((a, s) => a + s.g, 0) / samples.length).toFixed(2),
          +(samples.reduce((a, s) => a + s.b, 0) / samples.length).toFixed(2),
        ]
      : [0, 0, 0];
  return {
    sampledPixels: samples.length,
    zeroLumaCount,
    zeroLumaRatioPct: samples.length > 0 ? +((zeroLumaCount / samples.length) * 100).toFixed(2) : 100,
    meanRgb,
    roi: { rx0, rx1, ry0, ry1 },
  };
}

/** Q5：计算反射区域垂直/水平梯度能量比（Sobel/中心差分平方能量比与 L1 比） */
function analyzeReflectionDirectionalGradient(png, canvasRect) {
  const { width, pixels } = png;
  /* 选取 worker-gamma 下方镜面反射过渡区（[0.155..0.265, 0.50..0.61]，真实 MeshReflectorMaterial 倒影落点且避开中央水平强发射雷达环线） */
  const x0 = Math.round(canvasRect.left + canvasRect.width * 0.155);
  const x1 = Math.round(canvasRect.left + canvasRect.width * 0.265);
  const y0 = Math.round(canvasRect.top + canvasRect.height * 0.50);
  const y1 = Math.round(canvasRect.top + canvasRect.height * 0.61);
  let gxSq = 0;
  let gySq = 0;
  let gxAbs = 0;
  let gyAbs = 0;
  let count = 0;
  for (let y = y0 + 1; y < y1 - 1; y += 1) {
    for (let x = x0 + 1; x < x1 - 1; x += 1) {
      const gx = (lumaAt(pixels, width, x + 1, y) - lumaAt(pixels, width, x - 1, y)) * 0.5;
      const gy = (lumaAt(pixels, width, x, y + 1) - lumaAt(pixels, width, x, y - 1)) * 0.5;
      gxSq += gx * gx;
      gySq += gy * gy;
      gxAbs += Math.abs(gx);
      gyAbs += Math.abs(gy);
      count += 1;
    }
  }
  return {
    roi: { x0, x1, y0, y1 },
    pixelCount: count,
    energyRatioEyOverEx: +(gySq / Math.max(gxSq, 1e-6)).toFixed(3),
    energyRatioExOverEy: +(gxSq / Math.max(gySq, 1e-6)).toFixed(3),
    l1RatioGyOverGx: +(gyAbs / Math.max(gxAbs, 1e-6)).toFixed(3),
  };
}

/** Q6：健康 Pod 区域绿像素采样并计算 HSV 色相 */
function sampleHealthyPodHsv(png, canvasRect) {
  const { width, pixels } = png;
  const x0 = Math.round(canvasRect.left + canvasRect.width * 0.20);
  const x1 = Math.round(canvasRect.left + canvasRect.width * 0.80);
  const y0 = Math.round(canvasRect.top + canvasRect.height * 0.18);
  const y1 = Math.round(canvasRect.top + canvasRect.height * 0.82);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * width + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (g >= 75 && g <= 230 && g > r * 1.25 && g > b * 1.05 && b < g * 0.92) {
        sumR += r;
        sumG += g;
        sumB += b;
        count += 1;
      }
    }
  }
  const avgRgb = count > 0 ? [sumR / count, sumG / count, sumB / count] : [0, 0, 0];
  const hsv = rgbToHsv(avgRgb[0], avgRgb[1], avgRgb[2]);
  return {
    sampledPixels: count,
    avgRgb: avgRgb.map((v) => +v.toFixed(1)),
    hsv: {
      h: +hsv.h.toFixed(2),
      s: +hsv.s.toFixed(1),
      v: +hsv.v.toFixed(1),
    },
  };
}

/* ========================================================================== */
/* 单次 CDP 浏览器采集（支持 before / after 同一探针口径）                     */
/* ========================================================================== */

async function captureTarget(baseUrl, targetName, queryStr, gpuMode, cdpPort) {
  const args = [
    '--headless=new',
    '--no-first-run',
    '--hide-scrollbars',
    '--window-size=1920,1080',
    '--use-gl=angle',
    ...(gpuMode === 'd3d11'
      ? ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-r6adv-${targetName}-${Date.now()}`)}`,
    'about:blank',
  ];
  const browser = spawn(EDGE, args, { stdio: 'ignore' });
  const killBrowser = () => {
    try {
      browser.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) })).json();
        break;
      } catch {
        await sleep(300);
      }
    }
    const target = await (
      await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
    ).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let nextId = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push(msg.params?.exceptionDetails?.text ?? 'exception');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        pageErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails) };
      return r.result?.result?.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.navigate', { url: `${baseUrl}${queryStr}` });

    for (let i = 0; i < 120; i += 1) {
      const ok = await ev(`Boolean(window.__KUBEVISION_STORE__ && window.__KUBEVISION_R3F__ && document.querySelector('canvas'))`);
      if (ok === true) break;
      await sleep(350);
    }
    await sleep(3800);

    const overviewDom = await ev(`(() => {
      const s = window.__KUBEVISION_STORE__.getState();
      s.setActiveChaos('NONE');
      s.selectEntity(null);
      s.setOrbitPatrolActive(false);
      s.setChaosModalOpen(false);
      s.setPerfHudOpen(false);
      return new Promise((resolve) => {
        setTimeout(() => {
          const canvas = document.querySelector('canvas');
          const cRect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: 1220, height: 1080 };
          const pageCenter = { x0: 912, x1: 1008, y0: 486, y1: 594 };
          const canvasCenter = {
            x0: cRect.left + cRect.width * 0.45,
            x1: cRect.left + cRect.width * 0.55,
            y0: cRect.top + cRect.height * 0.45,
            y1: cRect.top + cRect.height * 0.55,
          };
          const overlaps = (r, box) => !(r.right < box.x0 || r.left > box.x1 || r.bottom < box.y0 || r.top > box.y1);

          /* 兼容改前（无 data-kv-label）与改后（有 data-kv-label） */
          const kvEls = Array.from(document.querySelectorAll('[data-kv-label]'));
          const labels = kvEls.length > 0
            ? kvEls.map((el) => {
                const r = el.getBoundingClientRect();
                return {
                  id: el.getAttribute('data-kv-label'),
                  text: (el.textContent || '').trim(),
                  heightPx: +r.height.toFixed(2),
                  rect: { left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) },
                };
              })
            : ['SYS.CORE', 'CONTROL-PLANE', 'CONTROL PLANE', 'worker-alpha', 'worker-beta', 'worker-gamma'].flatMap((kw) =>
                Array.from(document.querySelectorAll('span,div')).filter((el) =>
                  el.children.length === 0 && (el.textContent || '').trim().includes(kw)
                ).map((el) => {
                  const r = el.getBoundingClientRect();
                  return {
                    id: 'legacy:' + kw,
                    text: (el.textContent || '').trim(),
                    heightPx: +r.height.toFixed(2),
                    rect: { left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) },
                  };
                })
              );

          const canvasCenterHits = labels.filter((l) => overlaps(l.rect, canvasCenter));
          const pageCenterHits = labels.filter((l) => overlaps(l.rect, pageCenter));
          const t = window.__KUBEVISION_TRANSIENT__?.glStats ?? null;
          const r3f = window.__KUBEVISION_R3F__;
          const gl = r3f?.get?.()?.gl ?? r3f?.gl;
          let renderer = 'unknown';
          try {
            const ctx = gl?.getContext?.();
            const ext = ctx?.getExtension?.('WEBGL_debug_renderer_info');
            renderer = ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
          } catch {}
          resolve({
            renderer,
            canvasRect: { left: +cRect.left.toFixed(2), top: +cRect.top.toFixed(2), width: +cRect.width.toFixed(2), height: +cRect.height.toFixed(2) },
            glStats: t,
            labels,
            canvasCenterHitCount: canvasCenterHits.length,
            canvasCenterHits,
            pageCenterHitCount: pageCenterHits.length,
            pageCenterHits,
          });
        }, 1200);
      });
    })()`);

    const overviewShot = await send('Page.captureScreenshot', { format: 'png' });
    const overviewBuf = Buffer.from(overviewShot.result.data, 'base64');

    /* Q3 平场校准帧（保持同页 EffectComposer + DOM radial-gradient，不更改任何暗角或亮度逻辑） */
    const vignetteFlatBuf = await (async () => {
      await ev(`(() => {
        const r3f = window.__KUBEVISION_R3F__;
        const st = r3f?.get?.() ?? r3f;
        window.__KV_CAL_BACKUP__ = {
          bg: st.scene.background ? st.scene.background.clone() : null,
          hadBg: Boolean(st.scene.background),
          layersMask: st.camera.layers.mask,
        };
        /* 将相机切到未使用的层 31，零副作用剔除全部 3D 物体，保留 scene.background → EffectComposer → DOM 暗角完整链路 */
        st.camera.layers.set(31);
        /* 等线性中性灰底背景（低于 Bloom threshold 1.0，纯测 Composer Vignette + DOM 径向衰减） */
        if (st.scene.background?.set) {
          st.scene.background.set('#64748b');
        } else if (st.scene.fog?.color?.clone) {
          const c = st.scene.fog.color.clone();
          c.set('#64748b');
          st.scene.background = c;
        }
        /* 仅隐藏边角漂浮 HUD/Toolbar/3D 标签与 sidebar，绝不能隐藏包含 canvas 的 <section aria-label>！ */
        const canvas = document.querySelector('canvas');
        const hideEl = (el) => {
          if (!el || el === canvas || (canvas && el.contains(canvas))) return;
          if (typeof el.className === 'string' && el.className.includes('radial-gradient')) return;
          if (el.querySelector && el.querySelector('[class*="radial-gradient"]')) return;
          if (el.dataset.kvPrevVis !== undefined) return;
          el.dataset.kvPrevVis = el.style.visibility || '';
          el.style.visibility = 'hidden';
        };
        document.querySelectorAll('aside, header, [aria-label], [data-kv-label]').forEach(hideEl);
        const vig = document.querySelector('[class*="radial-gradient"]');
        const viewportRoot = vig?.parentElement;
        if (viewportRoot) {
          Array.from(viewportRoot.children).forEach(hideEl);
        }
        const r3fRoot = canvas?.parentElement?.parentElement;
        if (r3fRoot) {
          Array.from(r3fRoot.children).forEach(hideEl);
        }
      })()`);
      await sleep(450);
      const flat = await send('Page.captureScreenshot', { format: 'png' });
      await ev(`(() => {
        const st = window.__KUBEVISION_R3F__?.get?.() ?? window.__KUBEVISION_R3F__;
        const bk = window.__KV_CAL_BACKUP__;
        if (bk) {
          st.camera.layers.mask = bk.layersMask;
          if (bk.hadBg && bk.bg && st.scene.background?.copy) st.scene.background.copy(bk.bg);
          else if (!bk.hadBg) st.scene.background = null;
        }
        document.querySelectorAll('[data-kv-prev-vis]').forEach((el) => {
          el.style.visibility = el.dataset.kvPrevVis || '';
          delete el.dataset.kvPrevVis;
        });
      })()`);
      return Buffer.from(flat.result.data, 'base64');
    })();

    /* 机架特写（pod-closeup）与铭牌尺码采证 */
    await ev(`(() => {
      const s = window.__KUBEVISION_STORE__.getState();
      s.setActiveChaos('NONE');
      s.selectEntity('node-worker-alpha', 'node');
      s.setOrbitPatrolActive(false);
    })()`);
    await sleep(3800);

    const closeupDom = await ev(`(() => {
      const kvEls = Array.from(document.querySelectorAll('[data-kv-label]'));
      const labels = kvEls.length > 0
        ? kvEls.map((el) => {
            const r = el.getBoundingClientRect();
            return {
              id: el.getAttribute('data-kv-label'),
              text: (el.textContent || '').trim(),
              heightPx: +r.height.toFixed(2),
            };
          })
        : ['worker-alpha', 'worker-beta', 'worker-gamma'].flatMap((kw) =>
            Array.from(document.querySelectorAll('span'))
              .filter((el) => (el.textContent || '').trim() === kw && Boolean(el.closest('[style*="translate3d"]')))
              .map((el) => ({ id: 'legacy:' + kw, text: kw, heightPx: +el.getBoundingClientRect().height.toFixed(2) }))
          );
      return { labels };
    })()`);

    const closeupShot = await send('Page.captureScreenshot', { format: 'png' });
    const closeupBuf = Buffer.from(closeupShot.result.data, 'base64');

    ws.close();
    return { overviewDom, overviewBuf, vignetteFlatBuf, closeupDom, closeupBuf, pageErrors };
  } finally {
    killBrowser();
  }
}

async function measureFullSuite(baseUrl, name, gpuMode, portStart) {
  console.log(`\n▸ 采集目标 [${name}] (${baseUrl}, gpu=${gpuMode})…`);
  const high = await captureTarget(baseUrl, `${name}-high`, '?quality=high&demo=1', gpuMode, portStart);
  const low = await captureTarget(baseUrl, `${name}-low`, '?quality=low&demo=1', gpuMode, portStart + 1);
  const off = await captureTarget(baseUrl, `${name}-off`, '?quality=off&demo=1', gpuMode, portStart + 2);

  const outShotDir = join(SHOTS_DIR, name);
  mkdirSync(outShotDir, { recursive: true });
  writeFileSync(join(outShotDir, 'overview-1920x1080.png'), high.overviewBuf);
  writeFileSync(join(outShotDir, 'overview-vignette-cal.png'), high.vignetteFlatBuf);
  writeFileSync(join(outShotDir, 'pod-closeup-high.png'), high.closeupBuf);
  writeFileSync(join(outShotDir, 'pod-closeup-low.png'), low.closeupBuf);
  writeFileSync(join(outShotDir, 'pod-closeup-off.png'), off.closeupBuf);

  const overviewPng = decodePng(high.overviewBuf);
  const calPng = decodePng(high.vignetteFlatBuf);
  const closeupHighPng = decodePng(high.closeupBuf);
  const closeupLowPng = decodePng(low.closeupBuf);
  const closeupOffPng = decodePng(off.closeupBuf);

  const cRect = high.overviewDom.canvasRect;

  /* Q1 */
  const q1PagePx = analyzeCenterTextClusters(overviewPng, 912, 1008, 486, 594);
  const q1CanvasPx = analyzeCenterTextClusters(
    overviewPng,
    Math.round(cRect.left + cRect.width * 0.45),
    Math.round(cRect.left + cRect.width * 0.55),
    Math.round(cRect.top + cRect.height * 0.45),
    Math.round(cRect.top + cRect.height * 0.55),
  );
  const q1 = {
    pageCenterHitCountDom: high.overviewDom.pageCenterHitCount,
    canvasCenterHitCountDom: high.overviewDom.canvasCenterHitCount,
    canvasCenterHits: high.overviewDom.canvasCenterHits,
    pageBoxTextSizedClusters: q1PagePx.textSizedClusterCount,
    canvasBoxTextSizedClusters: q1CanvasPx.textSizedClusterCount,
    pass:
      high.overviewDom.pageCenterHitCount === 0 &&
      high.overviewDom.canvasCenterHitCount === 0 &&
      q1PagePx.textSizedClusterCount === 0,
  };

  /* Q2 */
  const ovHeights = high.overviewDom.labels.map((l) => l.heightPx);
  const clAlpha = high.closeupDom.labels.find((l) => l.id.includes('worker-alpha')) ?? high.closeupDom.labels[0];
  const q2 = {
    overviewLabels: high.overviewDom.labels,
    overviewMinPx: ovHeights.length > 0 ? Math.min(...ovHeights) : null,
    overviewMaxPx: ovHeights.length > 0 ? Math.max(...ovHeights) : null,
    closeupTarget: clAlpha ?? null,
    pass:
      ovHeights.length >= 4 &&
      Math.min(...ovHeights) >= 10 &&
      Math.max(...ovHeights) <= 18 &&
      clAlpha !== undefined &&
      clAlpha.heightPx >= 10 &&
      clAlpha.heightPx <= 22,
  };

  /* Q3：实拍平场（Composer Vignette + DOM 叠加）与未改亮度对照 */
  const tlCal = meanBoxLuma(calPng, cRect.left + 2, cRect.top + 2, 120, 120);
  const trCal = meanBoxLuma(calPng, cRect.left + cRect.width - 122, cRect.top + 2, 120, 120);
  const blCal = meanBoxLuma(calPng, cRect.left + 2, cRect.top + cRect.height - 122, 120, 120);
  const brCal = meanBoxLuma(calPng, cRect.left + cRect.width - 122, cRect.top + cRect.height - 122, 120, 120);
  const centerCal = meanBoxLuma(
    calPng,
    cRect.left + cRect.width * 0.5 - 60,
    cRect.top + cRect.height * 0.5 - 60,
    120,
    120,
  );
  const cornersCalMean = +((tlCal + trCal + blCal + brCal) / 4).toFixed(3);
  const cornerToCenterCalPct = +((cornersCalMean / Math.max(centerCal, 1e-3)) * 100).toFixed(2);
  const rawCenter = meanBoxLuma(
    overviewPng,
    cRect.left + cRect.width * 0.5 - 60,
    cRect.top + cRect.height * 0.5 - 60,
    120,
    120,
  );
  const rawCorners = [
    meanBoxLuma(overviewPng, cRect.left + 2, cRect.top + 2, 120, 120),
    meanBoxLuma(overviewPng, cRect.left + cRect.width - 122, cRect.top + 2, 120, 120),
    meanBoxLuma(overviewPng, cRect.left + 2, cRect.top + cRect.height - 122, 120, 120),
    meanBoxLuma(overviewPng, cRect.left + cRect.width - 122, cRect.top + cRect.height - 122, 120, 120),
  ];
  const q3 = {
    calibrationCenter120Luma: centerCal,
    calibrationCorner120Lumas: { tl: tlCal, tr: trCal, bl: blCal, br: brCal },
    calibrationCornersMean: cornersCalMean,
    cornerToCenterRetentionPct: cornerToCenterCalPct,
    rawSceneCenterLuma: rawCenter,
    rawSceneCornersMean: +((rawCorners.reduce((a, b) => a + b, 0)) / 4).toFixed(2),
    pass: centerCal >= 30 && cornerToCenterCalPct >= 75,
  };

  /* Q4 */
  const q4Ground = analyzeGroundDarkRegion(overviewPng, cRect);
  const q4 = {
    ...q4Ground,
    pass: q4Ground.sampledPixels >= 200 && q4Ground.zeroLumaRatioPct < 5,
  };

  /* Q5 */
  const q5Grad = analyzeReflectionDirectionalGradient(overviewPng, cRect);
  const q5 = {
    ...q5Grad,
    pass: q5Grad.energyRatioEyOverEx <= 1.5 && q5Grad.energyRatioExOverEy <= 1.5,
  };

  /* Q6 */
  const podHigh = sampleHealthyPodHsv(closeupHighPng, cRect);
  const podLow = sampleHealthyPodHsv(closeupLowPng, cRect);
  const podOff = sampleHealthyPodHsv(closeupOffPng, cRect);
  const diffHighLow = +hueAngleDiff(podHigh.hsv.h, podLow.hsv.h).toFixed(2);
  const diffHighOff = +hueAngleDiff(podHigh.hsv.h, podOff.hsv.h).toFixed(2);
  const q6 = {
    high: podHigh,
    low: podLow,
    offFallback: podOff,
    hueDiffHighVsLowDeg: diffHighLow,
    hueDiffHighVsOffDeg: diffHighOff,
    pass: diffHighLow < 6 && diffHighOff < 6,
  };

  return {
    target: name,
    renderer: high.overviewDom.renderer,
    glStats: high.overviewDom.glStats,
    pageErrors: [...high.pageErrors, ...low.pageErrors, ...off.pageErrors],
    Q1_centerNoText: q1,
    Q2_labelSizes: q2,
    Q3_cornerBrightness: q3,
    Q4_groundDarkNoBlack: q4,
    Q5_reflectionNoStreak: q5,
    Q6_semanticColorParity: q6,
    allPass: q1.pass && q2.pass && q3.pass && q4.pass && q5.pass && q6.pass && high.pageErrors.length === 0,
  };
}

const afterResult = await measureFullSuite(AFTER_BASE, 'after', GPU_MODE, CDP_PORT);
let beforeResult = null;
let comparison = null;
if (BEFORE_BASE !== null) {
  beforeResult = await measureFullSuite(BEFORE_BASE, 'before', GPU_MODE, CDP_PORT + 10);
  comparison = {
    Q1_canvasCenterHits: {
      before: beforeResult.Q1_centerNoText.canvasCenterHitCountDom,
      after: afterResult.Q1_centerNoText.canvasCenterHitCountDom,
      delta: afterResult.Q1_centerNoText.canvasCenterHitCountDom - beforeResult.Q1_centerNoText.canvasCenterHitCountDom,
    },
    Q2_closeupMaxHeightPx: {
      before: beforeResult.Q2_labelSizes.closeupTarget?.heightPx ?? null,
      after: afterResult.Q2_labelSizes.closeupTarget?.heightPx ?? null,
      delta:
        beforeResult.Q2_labelSizes.closeupTarget && afterResult.Q2_labelSizes.closeupTarget
          ? +(afterResult.Q2_labelSizes.closeupTarget.heightPx - beforeResult.Q2_labelSizes.closeupTarget.heightPx).toFixed(2)
          : null,
    },
    Q3_cornerRetentionPct: {
      before: beforeResult.Q3_cornerBrightness.cornerToCenterRetentionPct,
      after: afterResult.Q3_cornerBrightness.cornerToCenterRetentionPct,
      deltaPctPt: +(
        afterResult.Q3_cornerBrightness.cornerToCenterRetentionPct -
        beforeResult.Q3_cornerBrightness.cornerToCenterRetentionPct
      ).toFixed(2),
    },
    Q4_groundZeroPct: {
      before: beforeResult.Q4_groundDarkNoBlack.zeroLumaRatioPct,
      after: afterResult.Q4_groundDarkNoBlack.zeroLumaRatioPct,
      beforeMeanRgb: beforeResult.Q4_groundDarkNoBlack.meanRgb,
      afterMeanRgb: afterResult.Q4_groundDarkNoBlack.meanRgb,
    },
    Q5_reflectionEyOverEx: {
      before: beforeResult.Q5_reflectionNoStreak.energyRatioEyOverEx,
      after: afterResult.Q5_reflectionNoStreak.energyRatioEyOverEx,
      delta: +(
        afterResult.Q5_reflectionNoStreak.energyRatioEyOverEx -
        beforeResult.Q5_reflectionNoStreak.energyRatioEyOverEx
      ).toFixed(3),
    },
    Q6_hueDiffHighVsOffDeg: {
      before: beforeResult.Q6_semanticColorParity.hueDiffHighVsOffDeg,
      after: afterResult.Q6_semanticColorParity.hueDiffHighVsOffDeg,
      delta: +(
        afterResult.Q6_semanticColorParity.hueDiffHighVsOffDeg -
        beforeResult.Q6_semanticColorParity.hueDiffHighVsOffDeg
      ).toFixed(2),
    },
    Q6_hueDiffHighVsLowDeg: {
      before: beforeResult.Q6_semanticColorParity.hueDiffHighVsLowDeg,
      after: afterResult.Q6_semanticColorParity.hueDiffHighVsLowDeg,
      delta: +(
        afterResult.Q6_semanticColorParity.hueDiffHighVsLowDeg -
        beforeResult.Q6_semanticColorParity.hueDiffHighVsLowDeg
      ).toFixed(2),
    },
  };
}

const report = {
  measuredAt: new Date().toISOString(),
  gpuMode: GPU_MODE,
  afterBase: AFTER_BASE,
  beforeBase: BEFORE_BASE,
  before: beforeResult,
  after: afterResult,
  comparison,
};

writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\n✓ R6 进阶报告已写入 ${OUT_JSON}`);
console.log(JSON.stringify({ allPass: afterResult.allPass, comparison, afterSummary: {
  Q1: afterResult.Q1_centerNoText.pass,
  Q2: afterResult.Q2_labelSizes.pass,
  Q3: afterResult.Q3_cornerBrightness.cornerToCenterRetentionPct,
  Q4: afterResult.Q4_groundDarkNoBlack.zeroLumaRatioPct,
  Q5: afterResult.Q5_reflectionNoStreak.energyRatioEyOverEx,
  Q6_low: afterResult.Q6_semanticColorParity.hueDiffHighVsLowDeg,
  Q6_off: afterResult.Q6_semanticColorParity.hueDiffHighVsOffDeg,
} }, null, 2));

if (!afterResult.allPass) {
  process.exit(1);
}
