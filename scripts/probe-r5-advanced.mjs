#!/usr/bin/env node
/**
 * KubeVision AI — R5 进阶全量实测探针（scripts/probe-r5-advanced.mjs）
 *
 * 【测量契约 T1-T5】
 * - T1：开启 Composer 后主场景 / 反射 pass / 合计 Draw Call 分解（含 Shift+P HUD 三数核对）；
 * - T2：全景 Overview 态 T3 档 3s 均值 Draw Call 与反射 pass 占比；
 * - T3：质量降档 T3 → T2 → T1 → T0 逐档实测及单调降幅；
 * - T4：真实连续 rAF 帧间隔采样的帧时间分位数 p50 / p95 / p99 与 p99/p50；
 * - T5：60s 稳态内存增量（JSHeapUsedSize < 5 MB）；
 *
 * 【三条反作弊核验】
 * 1. 场景 frustumCulled === false 对象数量不得超出 R5 进阶改造前基线（28 个）；
 * 2. 60s 稳态期 `mergeGeometries` 运行期调用增量必须为 0（initCalls > 0 且 runtimeCalls === 0）；
 * 3. 开发期 2s 预算巡检触发 `[renderBudget]` console.warn 时零页面异常/零 UI 报错弹窗。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_URL ?? 'http://127.0.0.1:3000/?quality=high&demo=1';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9369');
const SOAK_SECONDS = Number(process.env.KV_R5_SOAK_S ?? '60');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

if (!EDGE) {
  console.error('未找到 Microsoft Edge，无法启动无头 WebGL 探针');
  process.exit(2);
}

const percentile = (sorted, q) => {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return Number(sorted[idx].toFixed(2));
};

const avg = (arr, key) => {
  if (arr.length === 0) return 0;
  return Number((arr.reduce((s, x) => s + x[key], 0) / arr.length).toFixed(1));
};

const browser = spawn(
  EDGE,
  [
    '--headless=new',
    '--no-first-run',
    '--window-size=1920,1080',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-precise-memory-info',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-r5adv-${Date.now()}`)}`,
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
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

for (let i = 0; i < 60; i += 1) {
  try {
    await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    break;
  } catch {
    await sleep(500);
  }
}

const target = await (
  await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
const consoleWarnings = [];
const pageErrors = [];

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const type = msg.params?.type;
    const text = (msg.params?.args ?? [])
      .map((a) => a.value ?? a.description ?? '')
      .join(' ');
    if (type === 'warning') {
      consoleWarnings.push(text);
    } else if (type === 'error') {
      pageErrors.push(text);
    }
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const text = msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? 'exception';
    pageErrors.push(String(text));
  }
};

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const ev = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) {
    throw new Error(
      String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text).slice(0, 500),
    );
  }
  return res.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Performance.enable');
await send('HeapProfiler.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE_URL });

for (let i = 0; i < 120; i += 1) {
  const ready = await ev(
    `!!(window.__KUBEVISION_R3F__ && window.__KUBEVISION_TRANSIENT__ && window.__KUBEVISION_TRANSIENT__.glStats.fps > 0 && window.__KUBEVISION_RENDER__ && typeof window.__KUBEVISION_RENDER__.getMergeStats === 'function')`,
  );
  if (ready === true) break;
  await sleep(500);
}
await sleep(3200);

/* 1. 静态合批与视锥剔除反作弊核查 */
const sceneAudit = await ev(`(() => {
  const scene = window.__KUBEVISION_R3F__.get().scene;
  const frustumFalse = [];
  let visibleRenderables = 0;
  scene.traverse((obj) => {
    if ((obj.isMesh || obj.isPoints || obj.isLine) && obj.visible) {
      visibleRenderables += 1;
      if (obj.frustumCulled === false) {
        frustumFalse.push({ type: obj.type, name: obj.name || '(unnamed)' });
      }
    }
  });
  return {
    visibleRenderables,
    frustumFalseCount: frustumFalse.length,
    mergeStatsInit: window.__KUBEVISION_RENDER__.getMergeStats(),
    envCaps: window.__KUBEVISION_RENDER__.getEnvCaps(),
  };
})()`);

/* 2. Shift+P 开启 HUD 并检验 T1 三数分解 & T2 全景 3s 均值 */
const sendKey = (type, key, code, vk, modifiers) =>
  send('Input.dispatchKeyEvent', {
    type,
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  });
await sendKey('keyDown', 'Shift', 'ShiftLeft', 16, 8);
await sendKey('rawKeyDown', 'P', 'KeyP', 80, 8);
await sendKey('keyUp', 'P', 'KeyP', 80, 8);
await sendKey('keyUp', 'Shift', 'ShiftLeft', 16, 0);
await sleep(1000);

const sampleGl = async (count = 10, intervalMs = 300) => {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(
      await ev(`(() => {
        const g = window.__KUBEVISION_TRANSIENT__.glStats;
        return {
          total: g.drawCalls,
          main: g.drawCallsMain,
          reflection: g.drawCallsReflection,
          triangles: g.triangles,
          fps: g.fps,
          frameTimeMs: g.frameTimeMs,
          tier: g.renderTier,
        };
      })()`),
    );
    await sleep(intervalMs);
  }
  return rows;
};

/* T3（post=true, refl=false） */
await ev(`window.__KUBEVISION_RENDER__.setQualityTier(3); window.__KUBEVISION_RENDER__.setPost(true); window.__KUBEVISION_RENDER__.setReflector(false);`);
await sleep(2500);
const t3PostOnlySamples = await sampleGl(10, 300);

/* T3（post=true, refl=true）—— 给 SwiftShader 7s 编译 MeshReflectorMaterial 着色器 */
await ev(`window.__KUBEVISION_RENDER__.setReflector(true);`);
await sleep(7000);
const t3PostReflSamples = await sampleGl(10, 300);
const hudRead = await ev(`(() => {
  const label = [...document.querySelectorAll('p')].find((el) => el.textContent && el.textContent.includes('draws 合计'));
  const card = label ? label.closest('div') : null;
  const text = card ? card.innerText.replace(/\\s+/g, ' ').trim() : '';
  const nums = (text.match(/\\d+/g) ?? []).map(Number);
  return { found: Boolean(card), text, nums };
})()`);

/* 3. T3 降档对比（T3 -> T2 -> T1 -> T0，post=true 下看后处理+档位差异，并记录真实 fallback T0） */
await ev(`window.__KUBEVISION_RENDER__.setReflector(false); window.__KUBEVISION_RENDER__.setPost(true);`);
for (let w = 0; w < 20; w += 1) {
  const refl = await ev(`window.__KUBEVISION_TRANSIENT__.glStats.drawCallsReflection`);
  if (refl === 0) break;
  await sleep(400);
}
const tierCurve = {};
for (const tier of [3, 2, 1, 0]) {
  await ev(`window.__KUBEVISION_RENDER__.setQualityTier(${tier});`);
  await sleep(2500);
  const rows = await sampleGl(6, 300);
  tierCurve[`T${tier}`] = {
    drawCallsAvg: avg(rows, 'total'),
    mainAvg: avg(rows, 'main'),
    reflectionAvg: avg(rows, 'reflection'),
    trianglesAvg: avg(rows, 'triangles'),
  };
}

/* 恢复默认软渲染路径状态再采帧时间，测量真实连续帧间隔分位数 T4 */
await ev(`window.__KUBEVISION_RENDER__.setQualityTier(3); window.__KUBEVISION_RENDER__.setPost(false); window.__KUBEVISION_RENDER__.setReflector(false);`);
await sleep(2500);
const t0FallbackSamples = await sampleGl(8, 300);

const frameDeltas = await ev(`(() => new Promise((resolve) => {
  const deltas = [];
  let prev = performance.now();
  let warmup = 3;
  const step = (now) => {
    if (warmup > 0) {
      warmup -= 1;
      prev = now;
      requestAnimationFrame(step);
      return;
    }
    deltas.push(now - prev);
    prev = now;
    if (deltas.length >= 45 || performance.now() - prev > 20000) {
      resolve(deltas);
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}))()`);

const sortedFrames = [...frameDeltas].sort((a, b) => a - b);
const p50 = percentile(sortedFrames, 0.5);
const p95 = percentile(sortedFrames, 0.95);
const p99 = percentile(sortedFrames, 0.99);
const p99OverP50 = p50 && p50 > 0 ? Number((p99 / p50).toFixed(2)) : null;

/* 4. 2s 渲染预算巡检验证：强制 T3+refl 后等待 2.5s 检查是否打出 [renderBudget] warn 且页面无报错 */
await ev(`window.__KUBEVISION_RENDER__.checkBudget();`);
await sleep(2400);

/* 5. T5: 60s 稳态内存增量 + mergeGeometries 调用次数稳态 = 0 */
const readHeap = async () => {
  const m = await send('Performance.getMetrics');
  const list = m.result?.metrics ?? [];
  const get = (n) => list.find((x) => x.name === n)?.value ?? -1;
  return {
    used: get('JSHeapUsedSize'),
    total: get('JSHeapTotalSize'),
    nodes: get('Nodes'),
    listeners: get('JSEventListeners'),
  };
};

await send('HeapProfiler.collectGarbage');
await sleep(800);
const heapStart = await readHeap();
const mergeBeforeSoak = await ev(`window.__KUBEVISION_RENDER__.getMergeStats()`);
const heapSeries = [];
const soakRounds = Math.max(1, Math.round(SOAK_SECONDS / 5));
for (let i = 0; i < soakRounds; i += 1) {
  await sleep(5000);
  heapSeries.push(await readHeap());
}
await send('HeapProfiler.collectGarbage');
await sleep(800);
const heapEnd = await readHeap();
const mergeAfterSoak = await ev(`window.__KUBEVISION_RENDER__.getMergeStats()`);

const heapDeltaMb = Number(((heapEnd.used - heapStart.used) / (1024 * 1024)).toFixed(2));
const heapPeakMb = Number(((Math.max(...heapSeries.map((x) => x.used)) - heapStart.used) / (1024 * 1024)).toFixed(2));
const runtimeMergeDelta = mergeAfterSoak.runtimeCalls - mergeBeforeSoak.runtimeCalls;
const renderBudgetWarns = consoleWarnings.filter((w) => w.includes('[renderBudget]'));
const uiErrorBannerCount = await ev(`document.querySelectorAll('[role="alert"], .kv-error-banner').length`);

const t1Main = avg(t3PostReflSamples, 'main');
const t1Refl = avg(t3PostReflSamples, 'reflection');
const t1Total = avg(t3PostReflSamples, 'total');
const t2PostOnlyTotal = avg(t3PostOnlySamples, 'total');
const t2ReflPct = t1Total > 0 ? Number(((t1Refl / t1Total) * 100).toFixed(1)) : 0;
const t0Calls = tierCurve.T0.drawCallsAvg;
const t3Calls = tierCurve.T3.drawCallsAvg;
const t0OverT3Pct = t3Calls > 0 ? Number(((t0Calls / t3Calls) * 100).toFixed(1)) : 0;

const summary = {
  measuredAt: new Date().toISOString(),
  environment: sceneAudit.envCaps,
  T1_composerBreakdown: {
    mainAvg: t1Main,
    reflectionAvg: t1Refl,
    totalAvg: t1Total,
    equationHolds: Math.abs(t1Total - (t1Main + t1Refl)) <= 1,
    hudFound: hudRead.found,
    hudNums: hudRead.nums,
    t3PostOnlyAvg: t2PostOnlyTotal,
  },
  T2_overviewT3Budget: {
    t3PostReflAvg: t1Total,
    t3PostOnlyAvg: t2PostOnlyTotal,
    budgetTarget: 200,
    reflectionSharePct: t2ReflPct,
    reflectionShareTargetPct: 8,
    meetsBudgetWithoutVisualCuts: t1Total <= 200 && t2ReflPct <= 8,
  },
  T3_tierMonotonicDrop: {
    tiers: tierCurve,
    t0FallbackAvg: avg(t0FallbackSamples, 'total'),
    monotonicNonIncreasing:
      tierCurve.T3.drawCallsAvg >= tierCurve.T2.drawCallsAvg &&
      tierCurve.T2.drawCallsAvg >= tierCurve.T1.drawCallsAvg &&
      tierCurve.T1.drawCallsAvg >= tierCurve.T0.drawCallsAvg,
    t0OverT3Pct,
    meets25PctTargetWithoutVisualCuts: t0OverT3Pct <= 25,
  },
  T4_frameTimePercentilesMs: {
    sampleFrames: sortedFrames.length,
    p50,
    p95,
    p99,
    min: Number(sortedFrames[0].toFixed(2)),
    max: Number(sortedFrames[sortedFrames.length - 1].toFixed(2)),
    p99OverP50,
    meets2xTarget: p99OverP50 !== null && p99OverP50 <= 2.0,
  },
  T5_memory60sSoak: {
    soakSeconds: soakRounds * 5,
    startMb: Number((heapStart.used / 1048576).toFixed(2)),
    endMb: Number((heapEnd.used / 1048576).toFixed(2)),
    deltaMb: heapDeltaMb,
    peakDeltaMb: heapPeakMb,
    nodesDelta: heapEnd.nodes - heapStart.nodes,
    listenersDelta: heapEnd.listeners - heapStart.listeners,
    pass: heapDeltaMb < 5,
  },
  antiCheat: {
    visibleRenderables: sceneAudit.visibleRenderables,
    frustumFalseCount: sceneAudit.frustumFalseCount,
    frustumBaselineMax: 28,
    noNewFrustumCulledFalse: sceneAudit.frustumFalseCount <= 28,
    mergeInitCalls: mergeAfterSoak.initCalls,
    mergeMergedParts: mergeAfterSoak.mergedParts,
    mergeRuntimeCalls60sDelta: runtimeMergeDelta,
    mergeSteadyStateZero: runtimeMergeDelta === 0 && mergeAfterSoak.initCalls > 0,
    renderBudgetWarnCount: renderBudgetWarns.length,
    renderBudgetWarnSample: renderBudgetWarns[0] ?? null,
    pageErrorsCount: pageErrors.length,
    uiErrorBannerCount,
  },
};

const outDir = join(process.cwd(), 'docs', 'summit');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'r5-advanced-probe.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log('\nKubeVision AI — R5 进阶实测报告 (probe-r5-advanced)');
console.log(JSON.stringify(summary, null, 2));

const hardFail =
  !summary.T1_composerBreakdown.equationHolds ||
  !summary.T1_composerBreakdown.hudFound ||
  !summary.T5_memory60sSoak.pass ||
  !summary.antiCheat.noNewFrustumCulledFalse ||
  !summary.antiCheat.mergeSteadyStateZero ||
  summary.antiCheat.renderBudgetWarnCount === 0 ||
  summary.antiCheat.pageErrorsCount > 0;

ws.close();
cleanup();
process.exit(hardFail ? 1 : 0);
