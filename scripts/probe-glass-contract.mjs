#!/usr/bin/env node
/**
 * KubeVision AI — 玻璃契约浏览器计算样式探针（R2 · 跨视口可证明）
 *
 * 【设计意图】静态契约（check-style-contract）只能证明"类生成了"，不能证明
 * "浏览器真的按令牌渲染"。本探针在真实浏览器里逐视口创建 .kv-panel / .kv-chip /
 * .kv-overlay 临时元素，读取 computedStyle 的 backdropFilter / backgroundColor /
 * borderColor / boxShadow，逐项与 tokens.ts 令牌比对；并在 prefers-reduced-motion
 * 下断言 transition/animationDuration ≤ 1ms。四档视口：1920×1080 / 1366×768 /
 * 1024×768 / 800×600。
 *
 * 【单一事实源】期望的 blur 半径 / 基色 / hairline 全部从 src/constants/tokens.ts
 * 读取（GLASS / COLORS / STROKE），不在探针里另写数值——改令牌即改期望。
 *
 * 【输入】--base <url>（默认 http://127.0.0.1:3000）、--out <dir>。
 * 【输出】<out>/computed-style-4vp.json + 控制台逐项 pass/fail。
 * 【退出码】0 = 全部断言通过；1 = 存在失败；2 = 探针自身错误。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BASE = argOf('--base', 'http://127.0.0.1:3000');
const OUT = join(ROOT, argOf('--out', 'docs/summit/shots/r2-glass'));
const PORT = 9393;
const VIEWPORTS = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '800x600', width: 800, height: 600 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

/* ---- 从 tokens.ts 读取期望值（单一事实源） ---- */
const tokensSrc = readFileSync(join(ROOT, 'src/constants/tokens.ts'), 'utf8');
const glassBlur = (key) => {
  const m = tokensSrc.match(new RegExp(key + '\\s*:\\s*\\{[^}]*blurPx\\s*:\\s*(\\d+)'));
  return m ? Number(m[1]) : null;
};
const colorHex = (key) => {
  const m = tokensSrc.match(new RegExp(key + "\\s*:\\s*'(#[0-9a-fA-F]{6})'"));
  return m ? m[1] : null;
};
const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const strokeHairline = (tokensSrc.match(/hairline:\s*'([^']+)'/) ?? [])[1] ?? '';
const norm = (s) => String(s).replace(/\s+/g, '');
const panelRgb = hexToRgb(colorHex('panel'));
const voidRgb = hexToRgb(colorHex('void'));
const EXPECT = {
  blur: { panel: glassBlur('panel'), chip: glassBlur('chip'), overlay: glassBlur('overlay') },
  hairline: norm(strokeHairline),
  chipBg: norm(`rgba(${panelRgb.join(',')},0.55)`),
  overlayBg: norm(`rgba(${voidRgb.join(',')},0.78)`),
};

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
if (!EDGE) { console.error('[glass-probe] 未找到 Edge'); process.exit(2); }

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id; const t = setTimeout(() => rej(new Error('CDP timeout ' + method)), 30000);
    pending.set(n, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => ws.close() };
}
const ev = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};

/* 页内测量：为每个玻璃类创建临时元素并读取 computedStyle */
const MEASURE = `(() => {
  const classes = ['kv-panel', 'kv-chip', 'kv-overlay'];
  const out = {};
  for (const cls of classes) {
    const el = document.createElement('div');
    el.className = cls;
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.width = '120px';
    el.style.height = '80px';
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    out[cls] = {
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || '(none)',
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      borderTopColor: cs.borderTopColor,
      borderTopWidth: cs.borderTopWidth,
      boxShadow: cs.boxShadow,
    };
    el.remove();
  }
  return out;
})()`;

/* reduced-motion 测量：带过渡 + 动画的元素，读取时长 */
const MEASURE_MOTION = `(() => {
  const el = document.createElement('div');
  el.className = 'kv-fade-in transition-colors';
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const r = { transitionDuration: cs.transitionDuration, animationDuration: cs.animationDuration };
  el.remove();
  return r;
})()`;

const toMs = (v) => {
  const first = String(v).split(',')[0].trim();
  if (first.endsWith('ms')) return parseFloat(first);
  if (first.endsWith('s')) return parseFloat(first) * 1000;
  return parseFloat(first) || 0;
};

const browser = spawn(EDGE, ['--headless=new', '--no-first-run', '--hide-scrollbars', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP ?? '/tmp', 'kv-r2glass-' + Date.now())}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } });

let target = null;
for (let i = 0; i < 80; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) }); const list = await r.json(); target = list.find((x) => x.type === 'page') ?? null; if (target) break; } catch { /* retry */ }
  await sleep(400);
}
if (!target) { console.error('[glass-probe] 无 CDP 目标'); process.exit(2); }

const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

const assertions = [];
function assert(vp, name, pass, detail) {
  assertions.push({ viewport: vp, name, pass, detail });
}

try {
  await cdp.send('Page.navigate', { url: BASE });
  for (let i = 0; i < 200; i += 1) { if ((await ev(cdp, 'document.querySelector("canvas") !== null')) === true) break; await sleep(400); }
  await sleep(2500);

  const report = { at: new Date().toISOString(), base: BASE, expect: EXPECT, viewports: {} };

  for (const vp of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const m = await ev(cdp, MEASURE);
    report.viewports[vp.name] = { glass: m };

    /* kv-panel */
    const p = m['kv-panel'];
    assert(vp.name, 'kv-panel.backdropFilter', p.backdropFilter.includes(`blur(${EXPECT.blur.panel}px)`) && p.backdropFilter.includes('saturate'), p.backdropFilter);
    assert(vp.name, 'kv-panel.background(渐变)', p.backgroundImage.includes('linear-gradient') && p.backgroundImage.includes('15, 23, 42') && p.backgroundImage.includes('6, 10, 19'), p.backgroundImage.slice(0, 70));
    assert(vp.name, 'kv-panel.borderColor', norm(p.borderTopColor) === EXPECT.hairline && p.borderTopWidth === '1px', `${p.borderTopColor} / ${p.borderTopWidth}`);
    assert(vp.name, 'kv-panel.boxShadow', p.boxShadow.includes('inset') && p.boxShadow !== 'none', p.boxShadow.slice(0, 60));

    /* kv-chip */
    const c = m['kv-chip'];
    assert(vp.name, 'kv-chip.backdropFilter', c.backdropFilter === `blur(${EXPECT.blur.chip}px)`, c.backdropFilter);
    assert(vp.name, 'kv-chip.backgroundColor', norm(c.backgroundColor) === EXPECT.chipBg, c.backgroundColor);
    assert(vp.name, 'kv-chip.borderColor', norm(c.borderTopColor) === EXPECT.hairline && c.borderTopWidth === '1px', `${c.borderTopColor} / ${c.borderTopWidth}`);
    assert(vp.name, 'kv-chip.boxShadow', c.boxShadow.includes('inset'), c.boxShadow.slice(0, 60));

    /* kv-overlay */
    const o = m['kv-overlay'];
    assert(vp.name, 'kv-overlay.backdropFilter', o.backdropFilter === `blur(${EXPECT.blur.overlay}px)`, o.backdropFilter);
    assert(vp.name, 'kv-overlay.backgroundColor', norm(o.backgroundColor) === EXPECT.overlayBg, o.backgroundColor);
    assert(vp.name, 'kv-overlay.boxShadow', o.boxShadow === 'none', o.boxShadow);

    /* prefers-reduced-motion：transition/animationDuration ≤ 1ms */
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    const motion = await ev(cdp, MEASURE_MOTION);
    const tMs = toMs(motion.transitionDuration);
    const aMs = toMs(motion.animationDuration);
    report.viewports[vp.name].reducedMotion = motion;
    assert(vp.name, 'reduced-motion.transitionDuration≤1ms', tMs <= 1, `${motion.transitionDuration} (${tMs}ms)`);
    assert(vp.name, 'reduced-motion.animationDuration≤1ms', aMs <= 1, `${motion.animationDuration} (${aMs}ms)`);
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await sleep(200);
  }

  report.assertions = assertions;
  const failed = assertions.filter((a) => !a.pass);
  report.ok = failed.length === 0;
  writeFileSync(join(OUT, 'computed-style-4vp.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`KubeVision AI — 玻璃契约 computedStyle 探针（${BASE}）`);
  console.log(`期望（tokens.ts）: blur panel=${EXPECT.blur.panel} chip=${EXPECT.blur.chip} overlay=${EXPECT.blur.overlay} · hairline=${EXPECT.hairline}`);
  for (const vp of VIEWPORTS) {
    const rows = assertions.filter((a) => a.viewport === vp.name);
    const bad = rows.filter((a) => !a.pass);
    console.log(`\n  [${vp.name}] ${rows.length - bad.length}/${rows.length} 通过`);
    for (const a of rows) console.log(`    ${a.pass ? '✓' : '✗'} ${a.name}  (${a.detail})`);
  }
  console.log(failed.length === 0 ? `\n✓ 四档视口玻璃契约全部通过（${assertions.length} 断言）` : `\n✗ ${failed.length} 断言失败`);
  cdp.close(); browser.kill('SIGKILL');
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error('[glass-probe] 探针错误:', error);
  try { cdp.close(); browser.kill('SIGKILL'); } catch { /* ignore */ }
  process.exit(2);
}