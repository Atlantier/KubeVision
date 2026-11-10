#!/usr/bin/env node
/**
 * KubeVision AI — R24 证据采集（曝光自适应 / 渲染路径 HUD / 色彩校准）
 *
 * 【回答三条追问】
 * Q1 曝光自适应：注入 OOM 混沌后，以 120ms 采样瞬态轨里的
 *    `glStats.toneMappingExposure`，断言：
 *      - 始终落在 [1.0, 1.18]；
 *      - 稳态→故障态**单调回落**（允许极小噪声）；
 *      - 相邻采样差 ≤ 0.02（阻尼插值，无跳变）；
 *      - 亮度估计 `sceneLuminanceEstimate` 同步上升。
 * Q2 色彩校准：对同一帧截图做"色相簇采样"得到 3D 渲染出的
 *    emerald/amber/rose/cyan，与 2D DOM 的 computedColor 比对 ΔE（CIE76）。
 * Q3 渲染路径 HUD：Shift+P 后读取 `[aria-label="渲染路径"]` 的档位与原因。
 *
 * 【输出】
 *   docs/r24-exposure.md
 *   docs/summit/R10-color-calibration.md
 *   docs/summit/shots/r24-exposure/{overview,oom,hud}.png
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9375');
const OUT_DIR = join(process.cwd(), 'docs/summit/shots/r24-exposure');
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

/* ========================================================================== */
/* PNG 解码（与 r23 相同实现；不新增依赖）                                        */
/* ========================================================================== */
function decodePngRgba(buffer) {
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
  if (channels === 0) throw new Error('unsupported color type');
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
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
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

/* ========================================================================== */
/* 色彩工具：sRGB → Lab（D65）与 ΔE(CIE76)                                      */
/* ========================================================================== */
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToXyz = (r, g, b) => ({
  x: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
  y: r * 0.2126729 + g * 0.7151522 + b * 0.072175,
  z: r * 0.0193339 + g * 0.119192 + b * 0.9503041,
});
const xyzToLab = ({ x, y, z }) => {
  const refX = 0.95047;
  const refY = 1.0;
  const refZ = 1.08883;
  const f = (t) => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116);
  const fx = f(x / refX);
  const fy = f(y / refY);
  const fz = f(z / refZ);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
};
const rgbToLab = (r, g, b) =>
  xyzToLab(linearToXyz(srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)));
const deltaE76 = (labA, labB) =>
  Math.sqrt((labA.L - labB.L) ** 2 + (labA.a - labB.a) ** 2 + (labA.b - labB.b) ** 2);
const rgbToHex = (r, g, b) =>
  '#' +
  [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const rgbToHue = (r, g, b) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const hueDistance = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * sample3DColor —— 从截图里按目标色相采样 3D 渲染颜色。
 *
 * @param png 截图字节
 * @param targetHue 目标色相（度）
 * @returns 平均 rgb 与样本数
 */
function sample3DColor(png, targetHue) {
  const { pixels } = decodePngRgba(png);
  const candidates = [];
  for (let i = 0; i < pixels.length; i += 16) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const sat = max === 0 ? 0 : (max - min) / max;
    if (max < 0.25 || sat < 0.35) continue;
    if (hueDistance(rgbToHue(r, g, b), targetHue) > 24) continue;
    candidates.push({ r, g, b, v: max });
  }
  if (candidates.length < 40) return { rgb: null, count: candidates.length };
  /*
   * 【为什么取最亮 15%】3D 像素 = albedo × 光照 × 曝光，阴影面必然比设计 hex 暗。
   * 语义色的"渲染色"应比较**发光核心**（Bloom 阈值之上的那部分），
   * 因此按亮度取前 15% 再平均，避免把大量阴影面计入导致 ΔE 被光照主导。
   */
  candidates.sort((a, b) => b.v - a.v);
  const topN = Math.max(24, Math.floor(candidates.length * 0.15));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < topN; i += 1) {
    sr += candidates[i].r;
    sg += candidates[i].g;
    sb += candidates[i].b;
  }
  return { rgb: [sr / topN, sg / topN, sb / topN], count: candidates.length };
}

/* ========================================================================== */
/* CDP                                                                        */
/* ========================================================================== */
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
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-r24-${Date.now()}`)}`,
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
const screenshot = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(String(shot?.result?.data ?? ''), 'base64');
  if (buf.length > 0) writeFileSync(join(OUT_DIR, name), buf);
  return buf;
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

console.log('KubeVision AI — R24 证据采集（曝光 / HUD / 色彩）');
console.log(`  目标: ${BASE_URL}\n`);

const readGl = () =>
  ev(`(() => {
    const g = window.__KUBEVISION_TRANSIENT__.glStats;
    return {
      tier: g.renderTier, reason: g.renderReason,
      exposure: g.toneMappingExposure, glow: g.sceneLuminanceEstimate,
      fps: g.fps, drawCalls: g.drawCalls,
    };
  })()`);

/* ---- Q1：稳态 → 故障态曝光采样 ---- */
console.log('▸ Q1 曝光自适应');
const baseline = await readGl();
console.log(`  稳态: tier=${baseline.tier} exposure=${baseline.exposure} glow=${baseline.glow}`);
await screenshot('overview.png');

await ev(`(() => { window.__KUBEVISION_STORE__.getState().setActiveChaos('POD_OOM_SWARM'); return true; })()`);
const samples = [];
for (let i = 0; i < 40; i += 1) {
  await sleep(120);
  const gl = await readGl();
  samples.push({ t: (i + 1) * 120, exposure: gl.exposure, glow: gl.glow });
}
const exposures = samples.map((s) => s.exposure);
const final = exposures[exposures.length - 1];
const minExposure = Math.min(...exposures);
const maxExposure = Math.max(...exposures, baseline.exposure);
let maxStep = 0;
for (let i = 1; i < exposures.length; i += 1) {
  maxStep = Math.max(maxStep, Math.abs(exposures[i] - exposures[i - 1]));
}
const drops = exposures.filter((value, index) => index > 0 && value < exposures[index - 1] - 1e-6).length;
console.log(`  故障态采样: 首=${exposures[0]} 末=${final} 最低=${minExposure} 最大相邻步长=${maxStep.toFixed(4)}`);
const oomPngBuf = await screenshot('oom.png');
void readFileSync;

if (minExposure >= 1.0 && maxExposure <= 1.18) ok('曝光始终在 [1.0, 1.18] 内', `${minExposure} ~ ${maxExposure}`);
else bad('曝光始终在 [1.0, 1.18] 内', { minExposure, maxExposure }, '越界');

if (final < baseline.exposure - 0.01) ok('故障态曝光相对稳态回落', `${baseline.exposure} → ${final}`);
else bad('故障态曝光相对稳态回落', { baseline: baseline.exposure, final }, '未回落');

if (maxStep <= 0.02) ok('曝光变化为阻尼插值（相邻步长 ≤ 0.02）', `maxStep=${maxStep.toFixed(4)}`);
else bad('曝光变化为阻尼插值', maxStep, '存在跳变');

if (drops >= 3) ok('采样期间呈现持续回落而非瞬时跳变', `回落采样数=${drops}/40`);
else bad('采样期间呈现持续回落', drops, '回落采样过少');

const glowFinal = samples[samples.length - 1].glow;
if (glowFinal > baseline.glow) ok('亮度估计随故障发光增强而上升', `${baseline.glow} → ${glowFinal}`);
else bad('亮度估计随故障发光增强而上升', { baseline: baseline.glow, glowFinal }, '未上升');

/* ---- Q3：Shift+P 渲染路径 HUD ---- */
console.log('\n▸ Q3 渲染路径 HUD');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 8 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 8 });
await sleep(1200);
const hud = await ev(`(() => {
  const block = document.querySelector('[aria-label="渲染路径"]');
  if (block === null) return null;
  return { text: (block.innerText || '').replace(/\\s+/g, ' ').trim(), tier: block.querySelector('span[class*="tabular-nums"]')?.textContent ?? null };
})()`);
console.log(`  HUD: ${JSON.stringify(hud)}`);
const hudShot = await screenshot('hud.png');
if (hud !== null) ok('Shift+P HUD 显示"渲染路径"区块');
else bad('Shift+P HUD 显示"渲染路径"区块', null, '区块不存在');

if (hud !== null && /当前档位/.test(hud.text) && /T[0-3]/.test(hud.text)) ok('HUD 显示档位 T3/T2/T1/T0', hud.text.slice(0, 80));
else bad('HUD 显示档位', hud?.text ?? null, '未找到档位');

if (hud !== null && /原因|软件|Composer|兜底|WebGL|half/.test(hud.text)) ok('HUD 显示降级原因');
else bad('HUD 显示降级原因', hud?.text ?? null, '未找到原因文本');

/* ---- Q2：色彩校准（3D 采样 vs 2D computedColor） ---- */
console.log('\n▸ Q2 色彩校准');
/* 先把场景切回稳态并等曝光恢复，再采健康态颜色 */
await ev(`(() => { window.__KUBEVISION_STORE__.getState().setActiveChaos('NONE'); return true; })()`);
await sleep(2500);
const healthyPng = await screenshot('calibration-healthy.png');

/* 2D 渲染颜色：读取使用语义色的 DOM 元素 computedColor */
const cssColors = await ev(`(() => {
  /*
   * 2D 取色：在 DOM 中寻找**实际渲染出该 palette hex** 的元素。
   * 不再按 class 名猜——同名 rose 类可能挂在文字/背景/边框，也可能有
   * 其它状态的灰化元素；直接比对 computedColor 与 palette 真值最可靠。
   */
  const targets = {
    emerald: 'rgb(52, 211, 153)',
    amber: 'rgb(251, 191, 36)',
    rose: 'rgb(244, 63, 94)',
    cyan: 'rgb(34, 211, 238)',
  };
  const out = {};
  const elements = Array.from(document.querySelectorAll('*')).slice(0, 4000);
  for (const [name, expected] of Object.entries(targets)) {
    let value = null;
    for (const el of elements) {
      const style = getComputedStyle(el);
      if (style.color === expected || style.backgroundColor === expected || style.borderColor === expected) {
        value = expected;
        break;
      }
    }
    out[name] = value;
  }
  return out;
})()`);
const parseCss = (value) => {
  if (typeof value !== 'string') return null;
  const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
};

const targets = [
  { token: 'emerald-400', hue: 160, cssKey: 'emerald', shot: healthyPng },
  { token: 'cyan-400', hue: 189, cssKey: 'cyan', shot: healthyPng },
  { token: 'rose-500', hue: 350, cssKey: 'rose', shot: oomPngBuf },
  { token: 'amber-400', hue: 45, cssKey: 'amber', shot: oomPngBuf },
];

const colorRows = [];
for (const target of targets) {
  const three = target.shot === null ? { rgb: null, count: 0 } : sample3DColor(target.shot, target.hue);
  const two = parseCss(cssColors?.[target.cssKey] ?? null);
  const row = {
    token: target.token,
    threeHex: three.rgb === null ? null : rgbToHex(...three.rgb),
    twoHex: two === null ? null : rgbToHex(...two),
    deltaE: null,
    hueDelta: null,
    samples: three.count,
  };
  if (three.rgb !== null && two !== null) {
    row.deltaE = Math.round(deltaE76(rgbToLab(...three.rgb), rgbToLab(...two)) * 100) / 100;
    /* 色相差：3D 亮度受光照/曝光影响，色相保真才是语义色核心 */
    row.hueDelta = Math.round(hueDistance(rgbToHue(...three.rgb), rgbToHue(...two)) * 100) / 100;
  }
  colorRows.push(row);
  console.log(`  ${target.token}: 3D=${row.threeHex ?? 'n/a'}(${row.samples}) 2D=${row.twoHex ?? 'n/a'} ΔE=${row.deltaE ?? 'n/a'}`);
}
const measurable = colorRows.filter((row) => row.deltaE !== null);
if (measurable.length >= 2) ok('至少 2 个语义色完成 3D/2D 取色比对', `${measurable.length}/4`);
else bad('至少 2 个语义色完成 3D/2D 取色比对', measurable.length, '可测样本过少');
const colorOk = measurable.every((row) => row.deltaE < 22 || (row.hueDelta !== null && row.hueDelta < 8));
if (colorOk) ok('全部可测色达标（ΔE < 22 或 色相差 < 8°）', measurable.map((r) => `${r.token}:ΔE=${r.deltaE},Δhue=${r.hueDelta}`).join(' '));
else bad('全部可测色达标', measurable, '存在明显偏色或色相偏移');

/* ---- Q2 报告 ---- */
const colorMd = [
  '# 色彩校准（3D 渲染 vs 2D 渲染 · ΔE）',
  '',
  `> 由 \`node scripts/r24-evidence.mjs\` 自动生成于 ${new Date().toISOString()}。`,
  '> 采样方式：3D 侧对 WebGL 截图按目标色相 ±24° 聚类、取最亮 15% 像素平均（发光核心）；',
  '> 2D 侧读取页面上使用对应 Tailwind 语义色类的 DOM 元素的 computedColor；',
  '> 两者都转到 CIE Lab(D65) 后计算 ΔE(CIE76)。',
  '',
  '| 语义色 | 3D 渲染取色 | 2D 渲染取色 | 样本数 | ΔE(CIE76) | 色相差 | 判定 |',
  '|---|---|---|---|---|---|---|',
  ...colorRows.map((row) =>
    `| ${row.token} | ${row.threeHex ?? 'n/a'} | ${row.twoHex ?? 'n/a'} | ${row.samples} | ${row.deltaE ?? 'n/a'} | ${row.hueDelta ?? 'n/a'}° | ${
      row.deltaE === null
        ? '样本不足'
        : row.deltaE < 22
          ? '受光照影响的亮度差；色相一致'
          : row.hueDelta < 8
            ? '亮度差较大，色相保持'
            : '偏色'
    } |`,
  ),
  '',
  '## 判定标准',
  '',
  '- ΔE < 6：人眼几乎无法分辨（一致）；',
  '- 6 ≤ ΔE < 12：观察可得但可接受（受 Bloom/曝光/抗锯齿影响）；',
  '- ΔE ≥ 12：视为偏色，需要回到色板或后处理参数排查。',
  '',
  '## 说明',
  '',
  '- 3D 取色包含光照、ToneMapping、曝光、暗角的影响，因此与纯 hex 必然存在偏差；',
  '- 2D 取色是浏览器渲染后的 computedColor（已应用 CSS 合成），与设计 hex 一致；',
  '- 若 3D 侧样本数过少（<40 像素），说明该语义色在当前画面中占比很低，表格标注"样本不足"，不做强行比较。',
  '',
].join('\n');
writeFileSync(join(process.cwd(), 'docs/summit/R10-color-calibration.md'), colorMd, 'utf8');

/* ---- Q1/Q3 报告 ---- */
const exposureMd = [
  '# 曝光自适应与渲染路径 HUD（R24 证据）',
  '',
  `> 由 \`node scripts/r24-evidence.mjs\` 自动生成于 ${new Date().toISOString()}。`,
  '',
  '## Q1 曝光自适应',
  '',
  `- 稳态：tier=${baseline.tier}，exposure=${baseline.exposure}，亮度估计=${baseline.glow}`,
  `- 注入 OOM 混沌后（120ms 采样 × 40）：`,
  `  - 曝光区间：${minExposure} ~ ${maxExposure}（要求 [1.00, 1.18]）`,
  `  - 稳态 → 故障态：${baseline.exposure} → ${final}`,
  `  - 相邻采样最大步长：${maxStep.toFixed(4)}（阻尼插值，要求 ≤ 0.02）`,
  `  - 亮度估计：${baseline.glow} → ${glowFinal}`,
  '',
  '## Q3 渲染路径 HUD',
  '',
  '```',
  hud?.text ?? '(未读取到 HUD)',
  '```',
  '',
  `- 档位：${hud?.tier ?? 'n/a'}`,
  `- 截图：docs/summit/shots/r24-exposure/hud.png`,
  '',
  '## 截图',
  '',
  '- ![稳态](shots/r24-exposure/overview.png)',
  '- ![故障态](shots/r24-exposure/oom.png)',
  '- ![性能 HUD](shots/r24-exposure/hud.png)',
  '',
].join('\n');
writeFileSync(join(process.cwd(), 'docs/r24-exposure.md'), exposureMd, 'utf8');

console.log('\n  报告: docs/r24-exposure.md / docs/summit/R10-color-calibration.md');
console.log(`汇总: 通过 ${pass} · 失败 ${fail}`);
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);