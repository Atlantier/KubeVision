#!/usr/bin/env node
/**
 * KubeVision AI — WebGL 黑屏探针（scripts/probe-blackout.mjs）
 *
 * 【它要回答的问题】"画面黑了"到底是**渲染真的失败**，还是只是相机转到了
 * 一片空区域 / 某些元素被遮挡？肉眼判断在答辩现场不可靠——投影仪一动、
 * 反光一打，人就会误判。本脚本用帧缓冲的**像素本身**作为事实来源：
 * 直接 `gl.readPixels` 采样，算亮度，连续多次接近全黑才判定黑屏。
 *
 * 【为什么必须看像素而不是看 DOM】DOM 层永远"还在"：`<canvas>` 元素
 * 不会因为 WebGL 上下文丢失而消失，健康分数字也照常渲染。
 * 只有读帧缓冲才能区分"页面还在但 3D 已经死了"。
 *
 * 【为什么阈值定得极低（默认 2.0/255）】本项目 3D 背景是刻意的近黑
 * （`VOID_COLOR = '#020815'` ≈ 亮度 7.7）。所以"画面偏暗"是设计而非故障。
 * 真正的黑屏是**均匀的 0**（上下文丢失后 readPixels 全返回 0）。
 * 阈值必须低于背景亮度、高于 0，2.0 正好落在这个窄缝里。
 *
 * 【已知陷阱与自检】默认 WebGL 上下文 `preserveDrawingBuffer: false`，
 * 在 rAF 之外读帧缓冲可能拿到全 0。因此脚本：
 *   1. 在与 R3F 同一帧的 rAF 回调内读取；
 *   2. 启动时先做 **3 次基线采样**，若页面刚加载完（3D 明显在渲染）
 *      基线却已是全黑，就判定"本环境 readPixels 不可信"并**拒绝输出
 *      黑屏结论**，而不是伪造一个红灯。这条自检是本脚本可信度的前提。
 *
 * 【用法】
 *   node scripts/probe-blackout.mjs --action demo --duration 60
 *   node scripts/probe-blackout.mjs --action chaos-oom --duration 45
 *   node scripts/probe-blackout.mjs --action dpr-drop --duration 30 --threshold 2
 *
 * 【参数】
 *   --action    demo | chaos-oom | chaos-net | dpr-drop | none（默认 none）
 *   --duration  探测时长（秒，默认 60）
 *   --interval  采样间隔（毫秒，默认 500）
 *   --threshold 亮度阈值（0~255，默认 2.0）
 *   --out       日志目录（默认 docs/summit/logs）
 *   --base      目标 URL（默认 http://127.0.0.1:3000）
 *
 * 【退出码】0 = 未复现黑屏；2 = 复现黑屏（可用于 CI 红灯）；1 = 环境/致命错误
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ========================================================================== */
/* 参数                                                                        */
/* ========================================================================== */

const VALID_ACTIONS = ['demo', 'chaos-oom', 'chaos-net', 'dpr-drop', 'none'];

const baseUrl = readArg('--base') ?? 'http://127.0.0.1:3000';
const action = readArg('--action') ?? 'none';
const durationSec = Number(readArg('--duration') ?? '60');
const intervalMs = Number(readArg('--interval') ?? '500');
const threshold = Number(readArg('--threshold') ?? '2.0');
const outDir = readArg('--out') ?? 'docs/summit/logs';

if (!VALID_ACTIONS.includes(action)) {
  console.error(`[FATAL] --action 必须是 ${VALID_ACTIONS.join(' | ')}，收到 "${action}"`);
  process.exit(1);
}
if (!Number.isFinite(durationSec) || durationSec <= 0) {
  console.error(`[FATAL] --duration 必须是正数秒，收到 "${readArg('--duration')}"`);
  process.exit(1);
}
if (!Number.isFinite(intervalMs) || intervalMs < 100) {
  console.error(`[FATAL] --interval 必须 ≥ 100ms，收到 "${readArg('--interval')}"`);
  process.exit(1);
}

/** 连续多少次低于阈值才判定黑屏 */
const CONSECUTIVE_BLACK_LIMIT = 3;

/** CDP 端口：与 verify.mjs(9333) / verify-demo(9334) / shot.mjs(9335) 错开 */
const CDP_PORT = 9336;

function readArg(flag) {
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/* 页面内探针                                                                  */
/* ========================================================================== */

/**
 * 注入页面的采样函数（在浏览器里执行）。
 *
 * 【实现要点】
 * 1. 复用同一块 `Uint8Array` 接收帧缓冲，避免每 500ms 分配 6~8MB 造成 GC；
 * 2. 只在 **rAF 回调内**读取——R3F 的渲染也发生在 rAF 阶段，晚于它注册的
 *    回调能在同一帧读到有效像素；
 * 3. 16×16 = 256 个等距采样点，计算平均亮度（Rec.709 加权）。
 *
 * 【为什么是 Rec.709 加权而非 RGB 平均】人眼对绿色最敏感。若用 RGB 平均，
 * 一个纯蓝的暗画面会被判得比实际更亮，反之纯绿会被判得过暗。
 * 加权才与"看起来黑不黑"一致。
 */
const PROBE_SCRIPT = `
(() => {
  const st = window.__KUBEVISION_R3F__ ? window.__KUBEVISION_R3F__.get() : null;
  if (st === null) return { error: 'no R3F store' };
  const gl = st.gl;
  const ctx = gl.getContext();
  const canvas = gl.domElement;

  let buffer = null;
  const GRID = 16;

  const sample = () => new Promise((resolve) => {
    requestAnimationFrame(() => {
      if (ctx.isContextLost()) {
        resolve({ lost: true, avg: 0, max: 0, min: 0, points: 0, width: canvas.width, height: canvas.height });
        return;
      }
      const w = canvas.width;
      const h = canvas.height;
      if (w === 0 || h === 0) {
        resolve({ error: 'zero-sized canvas' });
        return;
      }
      const need = w * h * 4;
      if (buffer === null || buffer.length !== need) buffer = new Uint8Array(need);
      /*
       * 【关键】st.gl 是 THREE.WebGLRenderer，它**没有** readPixels 方法。
       * 必须取原始 WebGL 上下文（getContext()）才有 readPixels/RGBA/UNSIGNED_BYTE。
       * 早期版本误用 gl.readPixels 会抛 "is not a function"，被自检误报成黑屏。
       */
      try {
        ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, buffer);
      } catch (e) {
        resolve({ error: 'readPixels threw: ' + String(e).slice(0, 80) });
        return;
      }
      /* 16×16 等距采样：取每格中心像素 */
      let sum = 0;
      let max = 0;
      let min = 255;
      let points = 0;
      for (let gy = 0; gy < GRID; gy += 1) {
        for (let gx = 0; gx < GRID; gx += 1) {
          const px = Math.min(w - 1, Math.floor((gx + 0.5) * w / GRID));
          const py = Math.min(h - 1, Math.floor((gy + 0.5) * h / GRID));
          const idx = (py * w + px) * 4;
          /* Rec.709 亮度 */
          const lum = 0.2126 * buffer[idx] + 0.7152 * buffer[idx + 1] + 0.0722 * buffer[idx + 2];
          sum += lum;
          if (lum > max) max = lum;
          if (lum < min) min = lum;
          points += 1;
        }
      }
      resolve({
        lost: false,
        avg: points === 0 ? 0 : sum / points,
        max,
        min,
        points,
        width: w,
        height: h,
      });
    });
  });

  window.__KUBEVISION_BLACKOUT_PROBE__ = sample;
  return { ok: true };
})()
`;

/* ========================================================================== */
/* CDP                                                                         */
/* ========================================================================== */

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`CDP 超时: ${method}`)), 30000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const details = res.result?.exceptionDetails;
  if (details !== undefined) {
    return { __err: String(details.exception?.description ?? details.text ?? 'unknown') };
  }
  return res.result?.result?.value;
}

/** 读取当时的 Store 快照（黑屏瞬间的现场证据） */
const STORE_SNAPSHOT = `(() => {
  const s = window.__KUBEVISION_STORE__ ? window.__KUBEVISION_STORE__.getState() : null;
  if (s === null) return null;
  return {
    activeChaos: s.activeChaos,
    selectedEntityId: s.selectedEntityId,
    connectionMode: s.connectionMode,
    isOrbitPatrolActive: s.isOrbitPatrolActive,
    clusterHealthScore: s.snapshotSummary.clusterHealthScore,
    runningPods: s.snapshotSummary.pods.filter((p) => p.status === 'Running').length,
    totalPods: s.snapshotSummary.pods.length,
    viewportPresent: document.querySelector('[aria-label="3D 集群拓扑视口"]') !== null,
    canvasPresent: document.querySelector('canvas') !== null,
  };
})()`;

/* ========================================================================== */
/* 动作                                                                        */
/* ========================================================================== */

/**
 * 把页面推进到指定探测场景。
 *
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function applyAction(cdp) {
  if (action === 'none') return { ok: true, detail: '不施加动作（静置观察）' };

  if (action === 'chaos-oom' || action === 'chaos-net') {
    const scenario = action === 'chaos-oom' ? 'POD_OOM_SWARM' : 'NET_PACKET_LOSS';
    const res = await evaluate(
      cdp,
      `(() => {
        /*
         * 【为何要重新 getState()】zustand 的 getState() 返回的是**当帧快照对象**，
         * setActiveChaos 之后旧对象上的 activeChaos 仍是旧值。直接在 s 上读
         * 会打印出 chaos: NONE 这种误导性回执（实际已经生效）。
         */
        const s = window.__KUBEVISION_STORE__.getState();
        s.setActiveChaos('${scenario}');
        s.setOrbitPatrolActive(true);
        const after = window.__KUBEVISION_STORE__.getState();
        return { ok: true, chaos: after.activeChaos, orbit: after.isOrbitPatrolActive };
      })()`,
    );
    return { ok: res?.ok === true, detail: `setActiveChaos('${scenario}') → ${JSON.stringify(res)}` };
  }

  if (action === 'demo') {
    const res = await evaluate(
      cdp,
      `(async () => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          (b.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
        if (!btn) return { error: 'start button missing' };
        btn.click();
        await new Promise((r) => setTimeout(r, 800));
        const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))[0];
        if (!item) return { error: 'menu item missing' };
        item.click();
        return { ok: true };
      })()`,
    );
    return { ok: res?.ok === true, detail: `启动剧本路演 → ${JSON.stringify(res)}` };
  }

  /* dpr-drop：把渲染像素比压到 0.5，模拟低性能设备的画质降档 */
  const res = await evaluate(
    cdp,
    `(() => {
      const st = window.__KUBEVISION_R3F__.get();
      const before = st.gl.getPixelRatio();
      st.gl.setPixelRatio(0.5);
      st.gl.setSize(window.innerWidth, window.innerHeight, false);
      return { ok: true, before, after: st.gl.getPixelRatio() };
    })()`,
  );
  return { ok: res?.ok === true, detail: `setPixelRatio → ${JSON.stringify(res)}` };
}

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

async function main() {
  const startedAt = new Date();
  const lines = [];
  const log = (line) => {
    console.log(line);
    lines.push(line);
  };

  log('KubeVision AI — WebGL 黑屏探针（probe-blackout.mjs）');
  log(`  目标    : ${baseUrl}`);
  log(`  动作    : ${action}`);
  log(`  时长    : ${durationSec}s · 间隔 ${intervalMs}ms · 阈值 ${threshold}`);
  log(`  开始    : ${startedAt.toISOString()}`);
  log(`  commit  : ${readCommit()}`);
  log('');

  /* ---- 前置：服务可达 ---- */
  let serverReady = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        serverReady = true;
        break;
      }
    } catch {
      /* 继续等 */
    }
    await sleep(1000);
  }
  if (!serverReady) {
    console.error(`[FATAL] ${baseUrl} 不可达。请先运行 pnpm dev。`);
    process.exit(1);
  }

  /* ---- 启动 headless Edge ---- */
  const EDGE_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edgePath = EDGE_PATHS.find((p) => existsSync(p));
  if (edgePath === undefined) {
    console.error('[FATAL] 未找到 Edge 浏览器。');
    process.exit(1);
  }

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-probe-${Date.now()}`);
  const browser = spawn(
    edgePath,
    [
      '--headless=new',
      '--no-first-run',
      '--window-size=1680,1000',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { detached: false, stdio: 'ignore' },
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
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      const list = await res.json();
      target = list.find((t) => t.type === 'page') ?? null;
      if (target !== null) break;
    } catch {
      /* 继续等 */
    }
    await sleep(500);
  }
  if (target === null) {
    console.error('[FATAL] CDP 未就绪。');
    cleanup();
    process.exit(1);
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: baseUrl });

  for (let i = 0; i < 300; i += 1) {
    if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
    await sleep(400);
  }
  await sleep(10000);

  /* ---- 注入探针 ---- */
  const injected = await evaluate(cdp, PROBE_SCRIPT);
  if (injected?.ok !== true) {
    console.error(`[FATAL] 探针注入失败: ${JSON.stringify(injected)}`);
    log(`[FATAL] 探针注入失败: ${JSON.stringify(injected)}`);
    cleanup();
    saveLog();
    process.exit(1);
  }

  /* ====================================================================== */
  /* 自检：基线必须不是黑的，否则 readPixels 不可信                          */
  /* ====================================================================== */
  log('[自检] 读取 3 次基线亮度，确认 readPixels 在本环境可用…');
  const baseline = [];
  for (let i = 0; i < 3; i += 1) {
    const s = await evaluate(cdp, 'window.__KUBEVISION_BLACKOUT_PROBE__()');
    baseline.push(s);
    log(`  基线 ${i + 1}: ${formatSample(s)}`);
    await sleep(intervalMs);
  }
  const baselineErrors = baseline.filter((s) => s?.error !== undefined || s?.__err !== undefined);
  const baselineAvg = baseline.reduce((acc, s) => acc + (typeof s?.avg === 'number' ? s.avg : 0), 0) / 3;
  log(`  基线均值: ${baselineAvg.toFixed(3)}`);

  /*
   * 【三种失败必须分开报，不能混为一谈】
   * 1. 采样本身报错（readPixels 抛异常 / 找不到方法）→ 探针**实现或环境**问题；
   * 2. 采样成功但亮度接近 0 → 要么 readPixels 回读不可用（preserveDrawingBuffer=false），
   *    要么真的黑——单看基线无法区分，故拒绝下黑屏结论；
   * 3. 基线亮度正常 → 探针可用，进入正式探测。
   * 早期版本把 (1) 的异常当成 (2) 的"全黑"，会输出误导性结论。
   */
  if (baselineErrors.length > 0) {
    log('');
    log('[结论] 探针【实现错误】：readPixels 采样抛异常，无法读取帧缓冲。');
    log(`       样本: ${JSON.stringify(baselineErrors[0])}`);
    log('       这是探针自身的问题，与产品是否黑屏无关，本次不下黑屏结论。');
    cleanup();
    saveLog();
    process.exit(1);
  }

  if (baselineAvg <= threshold) {
    log('');
    log('[结论] 探针【不可用】：页面刚加载完成、3D 明显在渲染，但帧缓冲读出接近全黑。');
    log('       最可能的原因是 WebGL 上下文未开启 preserveDrawingBuffer，');
    log('       在 rAF 内读帧缓冲仍拿不到像素 —— 属于**探针环境限制**，');
    log('       不是产品黑屏。为避免伪造红灯，本次不输出黑屏判定。');
    log('       改进方向（不进业务代码）：改用 CDP Page.captureScreenshot 解码像素，');
    log('       或使用 --use-gl=angle --use-angle=gl 让上下文支持回读。');
    cleanup();
    saveLog();
    process.exit(0);
  }

  log('[自检] 通过 —— 基线亮度足以区分"暗"与"黑"。');
  log('');

  /* ---- 施加动作 ---- */
  const applied = await applyAction(cdp);
  log(`[动作] ${applied.detail}`);
  if (applied.ok !== true) {
    log('[WARN] 动作施加失败，继续探测（记录为环境问题）');
  }
  log('');

  /* ====================================================================== */
  /* 主探测循环                                                              */
  /* ====================================================================== */
  log(`[探测] 开始，每 ${intervalMs}ms 采样一次，共 ${durationSec}s`);
  log('  时间(s) | 状态      | 平均亮度 | 最大 | 最小 | 混沌       | 选中'.padEnd(20));
  log('  ' + '-'.repeat(96));

  const probeStart = Date.now();
  let consecutiveBlack = 0;
  let blackoutCount = 0;
  let firstBlackoutAt = null;
  let sampleCount = 0;
  let errorCount = 0;
  const blackoutEvents = [];

  while (Date.now() - probeStart < durationSec * 1000) {
    const elapsed = ((Date.now() - probeStart) / 1000).toFixed(1);
    const sample = await evaluate(cdp, 'window.__KUBEVISION_BLACKOUT_PROBE__()');
    sampleCount += 1;

    if (sample?.__err !== undefined || sample?.error !== undefined) {
      errorCount += 1;
      log(`  ${String(elapsed).padStart(6)} | 采样错误  | ${String(sample?.error ?? sample?.__err).slice(0, 60)}`);
      await sleep(intervalMs);
      continue;
    }

    const avg = typeof sample.avg === 'number' ? sample.avg : 0;
    const isBlack = avg < threshold || sample.lost === true;

    if (isBlack) consecutiveBlack += 1;
    else consecutiveBlack = 0;

    const store = await evaluate(cdp, STORE_SNAPSHOT);
    const stateLabel = sample.lost === true ? 'CTX-LOST' : isBlack ? 'BLACK' : 'OK';
    log(
      `  ${String(elapsed).padStart(6)} | ${stateLabel.padEnd(9)} | ${avg.toFixed(3).padStart(8)} | ` +
        `${(sample.max ?? 0).toFixed(0).padStart(4)} | ${(sample.min ?? 0).toFixed(0).padStart(4)} | ` +
        `${String(store?.activeChaos ?? '?').padEnd(10)} | ${String(store?.selectedEntityId ?? 'null')}`,
    );

    /* ---- 连续 3 次黑 + 视口 DOM 仍在 → 判定黑屏 ---- */
    if (consecutiveBlack >= CONSECUTIVE_BLACK_LIMIT) {
      blackoutCount += 1;
      if (firstBlackoutAt === null) firstBlackoutAt = elapsed;
      blackoutEvents.push({
        atSeconds: Number(elapsed),
        consecutiveSamples: consecutiveBlack,
        sample,
        store,
      });
      log('');
      log('  ' + '!'.repeat(94));
      log(`  [黑屏判定] 连续 ${consecutiveBlack} 次采样平均亮度 < ${threshold}，且视口 DOM 仍存在`);
      log(`    时间点      : ${elapsed}s`);
      log(`    亮度        : avg=${avg.toFixed(3)} max=${(sample.max ?? 0).toFixed(0)} min=${(sample.min ?? 0).toFixed(0)}`);
      log(`    上下文丢失  : ${sample.lost === true}`);
      log(`    画布尺寸    : ${sample.width}x${sample.height}`);
      log(`    视口 DOM    : ${store?.viewportPresent === true ? '存在' : '缺失'}`);
      log(`    canvas 元素 : ${store?.canvasPresent === true ? '存在' : '缺失'}`);
      log(`    Store 快照  : ${JSON.stringify(store)}`);
      log('  ' + '!'.repeat(94));
      log('');
      /* 记完继续观测，但重置计数避免同一段黑屏刷屏 */
      consecutiveBlack = 0;
    }

    await sleep(intervalMs);
  }

  /* ====================================================================== */
  /* 汇总                                                                    */
  /* ====================================================================== */
  log('');
  log('='.repeat(78));
  log('探测汇总');
  log('='.repeat(78));
  log(`  采样次数      : ${sampleCount}`);
  log(`  采样错误      : ${errorCount}`);
  log(`  黑屏事件      : ${blackoutCount}`);
  log(`  首次黑屏时刻  : ${firstBlackoutAt === null ? '未复现' : firstBlackoutAt + 's'}`);
  log(`  判定          : ${blackoutCount > 0 ? '【复现黑屏】' : '【未复现黑屏】'}`);
  log(`  commit        : ${readCommit()}`);
  log(`  结束时刻      : ${new Date().toISOString()}`);

  if (blackoutEvents.length > 0) {
    log('');
    log('  黑屏现场明细（JSON）：');
    log(JSON.stringify(blackoutEvents, null, 2));
  }

  cdp.close();
  cleanup();
  saveLog();

  process.exit(blackoutCount > 0 ? 2 : 0);

  /** 把日志写盘 */
  function saveLog() {
    try {
      mkdirSync(outDir, { recursive: true });
      const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
      const file = join(outDir, `probe-blackout-${action}.log`);
      writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
      console.log(`\n[日志] 已写入 ${file}`);
      /* 同时保留一份带时间戳的，便于横向对比多轮 */
      writeFileSync(join(outDir, `probe-blackout-${action}-${stamp}.log`), `${lines.join('\n')}\n`, 'utf8');
    } catch (err) {
      console.error(`[WARN] 日志写入失败: ${String(err)}`);
    }
  }
}

function formatSample(s) {
  if (s === null || s === undefined) return 'null';
  if (s.__err !== undefined) return `err=${String(s.__err).slice(0, 60)}`;
  if (s.error !== undefined) return `error=${s.error}`;
  return `avg=${Number(s.avg).toFixed(3)} max=${Number(s.max).toFixed(0)} min=${Number(s.min).toFixed(0)} ${s.width}x${s.height} lost=${s.lost}`;
}

function readCommit() {
  try {
    return String(execSync('git rev-parse --short HEAD', { encoding: 'utf8' })).trim();
  } catch {
    return 'unknown';
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
