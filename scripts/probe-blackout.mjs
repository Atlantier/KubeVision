#!/usr/bin/env node
/**
 * KubeVision AI — WebGL 黑屏探针（scripts/probe-blackout.mjs）
 *
 * 【它要回答的问题】"画面黑了"到底是**渲染真的失败**，还是只是相机转到了
 * 一片空区域 / 某些元素被遮挡？肉眼判断在答辩现场不可靠——投影仪一动、
 * 反光一打，人就会误判。本脚本用帧缓冲的**像素本身**作为事实来源：
 * 直接 `gl.readPixels` 采样，算亮度，连续多次接近全黑才判定黑屏。
 *
 * 【追问 1 追加：可重复的红绿灯】
 * 单次探测只能说"这次没黑"，无法回答"会不会偶尔黑"。因此本版支持
 * `--repeat N`：同一动作用同一浏览器会话连跑 N 次（每轮强制重载页面回到
 * 干净起点），汇总出**复现率 x/N** 与**首次黑屏距动作触发的毫秒数分布**，
 * 并可写成 markdown 作为长期基线。复现率才是能被追问的指标：
 * "5 次里 0 次"与"5 次里 2 次"是完全不同的结论。
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
 *   2. 每轮先做 **3 次基线采样**，把
 *      "采样抛异常（实现问题）/ 回读全黑（环境限制）/ 真的黑" 三种情形分开报，
 *      实现问题直接非零退出，绝不伪造红灯。
 *
 * 【用法】
 *   node scripts/probe-blackout.mjs --action demo --duration 60
 *   node scripts/probe-blackout.mjs --action demo --duration 45 --repeat 5 --md docs/summit/blackout-baseline.md
 *   node scripts/probe-blackout.mjs --action dpr-drop --duration 30 --threshold 2
 *
 * 【参数】
 *   --action    demo | chaos-oom | chaos-net | dpr-drop | none（默认 none）
 *   --duration  单次探测时长（秒，默认 60）
 *   --repeat    重复次数（默认 1）
 *   --interval  采样间隔（毫秒，默认 500；受 SwiftShader 限制实际约 2~3.5s）
 *   --threshold 亮度阈值（0~255，默认 2.0）
 *   --out       日志目录（默认 docs/summit/logs）
 *   --md        汇总 markdown 输出路径
 *   --base      目标 URL（默认 http://127.0.0.1:3000）
 *
 * 【退出码】0 = 未复现黑屏；2 = 复现黑屏；1 = 环境/致命错误
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/* ========================================================================== */
/* 参数                                                                        */
/* ========================================================================== */

const VALID_ACTIONS = ['demo', 'chaos-oom', 'chaos-net', 'dpr-drop', 'none'];

const baseUrl = readArg('--base') ?? 'http://127.0.0.1:3000';
const action = readArg('--action') ?? 'none';
const durationSec = Number(readArg('--duration') ?? '60');
const repeatCount = Math.max(1, Math.trunc(Number(readArg('--repeat') ?? '1')));
const intervalMs = Number(readArg('--interval') ?? '500');
const threshold = Number(readArg('--threshold') ?? '2.0');
const outDir = readArg('--out') ?? 'docs/summit/logs';
const mdPath = readArg('--md');

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
if (!Number.isFinite(repeatCount) || repeatCount < 1) {
  console.error(`[FATAL] --repeat 必须是 ≥1 的整数，收到 "${readArg('--repeat')}"`);
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
 * 1. 复用同一块 `Uint8Array` 接收帧缓冲，避免每轮分配 4~8MB 造成 GC；
 * 2. 只在 **rAF 回调内**读取——R3F 的渲染也发生在 rAF 阶段，晚于它注册的
 *    回调能在同一帧读到有效像素；
 * 3. 16×16 = 256 个等距采样点，计算平均亮度（Rec.709 加权）。
 *
 * 【为什么是 Rec.709 加权而非 RGB 平均】人眼对绿色最敏感。若用 RGB 平均，
 * 一个纯蓝的暗画面会被判得比实际更亮，反之纯绿会被判得过暗。
 * 加权才与"看起来黑不黑"一致。
 *
 * 【关键】`st.gl` 是 THREE.WebGLRenderer，**没有** readPixels 方法，
 * 必须 `st.gl.getContext()` 取原始 WebGL 上下文。早期版本误用
 * `gl.readPixels` 会抛 "is not a function"，被自检误报成黑屏。
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
 * @param {object} cdp CDP 会话
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
/* 单轮探测                                                                    */
/* ========================================================================== */

/**
 * 跑完一整轮探测（重载页面 → 自检 → 施动作 → 采样 → 出结论）。
 *
 * 【为什么每轮都重载】只有在干净起点上，N 次运行才可比较。若在同一页面上
 * 连跑，上一轮的混沌、选中、免疫窗口都会残留，复现率就失去意义。
 *
 * @param {object} cdp CDP 会话
 * @param {number} roundIndex 第几轮（1-based）
 * @returns {Promise<object>} 单轮结果
 */
async function runRound(cdp, roundIndex) {
  const lines = [];
  const log = (line) => {
    console.log(line);
    lines.push(line);
  };

  log('');
  log('#'.repeat(78));
  log(`# 第 ${roundIndex}/${repeatCount} 轮  ·  action=${action}  ·  ${durationSec}s`);
  log('#'.repeat(78));

  /* ---- 重载到干净起点 ---- */
  await cdp.send('Page.navigate', { url: baseUrl });
  for (let i = 0; i < 300; i += 1) {
    if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
    await sleep(400);
  }
  await sleep(10000);

  /* ---- 注入探针 ---- */
  const injected = await evaluate(cdp, PROBE_SCRIPT);
  if (injected?.ok !== true) {
    return { roundIndex, fatal: `探针注入失败: ${JSON.stringify(injected)}`, lines };
  }

  /* ---- 自检：区分「实现错误 / 回读不可用 / 真的黑」 ---- */
  log('[自检] 读取 3 次基线亮度…');
  const baseline = [];
  for (let i = 0; i < 3; i += 1) {
    const s = await evaluate(cdp, 'window.__KUBEVISION_BLACKOUT_PROBE__()');
    baseline.push(s);
    log(`  基线 ${i + 1}: ${formatSample(s)}`);
    await sleep(intervalMs);
  }

  const baselineErrors = baseline.filter((s) => s?.error !== undefined || s?.__err !== undefined);
  const baselineAvg =
    baseline.reduce((acc, s) => acc + (typeof s?.avg === 'number' ? s.avg : 0), 0) / 3;
  log(`  基线均值: ${baselineAvg.toFixed(3)}`);

  if (baselineErrors.length > 0) {
    return {
      roundIndex,
      fatal: `readPixels 采样抛异常: ${JSON.stringify(baselineErrors[0])}`,
      lines,
    };
  }
  if (baselineAvg <= threshold) {
    return {
      roundIndex,
      probeUnusable: true,
      baselineAvg,
      fatal: 'readPixels 回读接近全黑（preserveDrawingBuffer=false？），本环境不可用',
      lines,
    };
  }
  log('[自检] 通过');

  /* ---- 施加动作，并记录动作触发的精确时刻 T0 ---- */
  const applied = await applyAction(cdp);
  const actionTriggeredAt = Date.now();
  log(`[动作] ${applied.detail}`);
  log('[动作] 触发时刻 = T0');

  /* ---- 采样循环 ---- */
  log('');
  log('  时间(s) | 距T0(ms) | 状态   | 平均亮度 | 最大 | 最小 | 混沌');
  log('  ' + '-'.repeat(74));

  const probeStart = Date.now();
  let consecutiveBlack = 0;
  let sampleCount = 0;
  let errorCount = 0;
  let firstBlackoutLatencyMs = null;
  let firstBlackoutSample = null;
  let firstBlackoutStore = null;
  let blackoutEvents = 0;
  const blackoutList = [];

  while (Date.now() - probeStart < durationSec * 1000) {
    const elapsed = Date.now() - probeStart;
    const sample = await evaluate(cdp, 'window.__KUBEVISION_BLACKOUT_PROBE__()');
    const sinceAction = Date.now() - actionTriggeredAt;
    sampleCount += 1;

    if (sample?.__err !== undefined || sample?.error !== undefined) {
      errorCount += 1;
      log(
        `  ${(elapsed / 1000).toFixed(1).padStart(7)} | ${String(sinceAction).padStart(8)} | 采样错误 | ${String(
          sample?.error ?? sample?.__err,
        ).slice(0, 40)}`,
      );
      await sleep(intervalMs);
      continue;
    }

    const avg = typeof sample.avg === 'number' ? sample.avg : 0;
    const isBlack = avg < threshold || sample.lost === true;
    if (isBlack) consecutiveBlack += 1;
    else consecutiveBlack = 0;

    const store = await evaluate(cdp, STORE_SNAPSHOT);
    log(
      `  ${(elapsed / 1000).toFixed(1).padStart(7)} | ${String(sinceAction).padStart(8)} | ` +
        `${(sample.lost === true ? 'CTX-LOST' : isBlack ? 'BLACK' : 'OK').padEnd(6)} | ` +
        `${avg.toFixed(3).padStart(8)} | ${(sample.max ?? 0).toFixed(0).padStart(4)} | ` +
        `${(sample.min ?? 0).toFixed(0).padStart(4)} | ${String(store?.activeChaos ?? '?')}`,
    );

    if (consecutiveBlack >= CONSECUTIVE_BLACK_LIMIT) {
      blackoutEvents += 1;
      const latency = Date.now() - actionTriggeredAt;
      if (firstBlackoutLatencyMs === null) {
        firstBlackoutLatencyMs = latency;
        firstBlackoutSample = sample;
        firstBlackoutStore = store;
      }
      blackoutList.push({ latencyMs: latency, avg, max: sample.max, min: sample.min, store });
      log(`  >> 黑屏判定 #${blackoutEvents}：距 T0 ${latency}ms，avg=${avg.toFixed(3)}`);
      consecutiveBlack = 0;
    }

    await sleep(intervalMs);
  }

  const verdict = blackoutEvents > 0 ? 'RED' : 'GREEN';
  log('');
  log(
    `[结论] 第 ${roundIndex} 轮：${verdict}（黑屏事件 ${blackoutEvents}，采样 ${sampleCount}，错误 ${errorCount}）`,
  );
  if (firstBlackoutLatencyMs !== null) {
    log(`       首次黑屏距 T0 = ${firstBlackoutLatencyMs}ms`);
    log(`       当时 Sample: ${JSON.stringify(firstBlackoutSample)}`);
    log(`       当时 Store : ${JSON.stringify(firstBlackoutStore)}`);
  }

  return {
    roundIndex,
    verdict,
    sampleCount,
    errorCount,
    blackoutEvents,
    firstBlackoutLatencyMs,
    firstBlackoutSample,
    firstBlackoutStore,
    baselineAvg,
    lines,
    blackoutList,
  };
}

/* ========================================================================== */
/* 汇总 markdown                                                               */
/* ========================================================================== */

/**
 * 生成 blackout-baseline.md。
 *
 * 【为什么要写进仓库】单次运行的终端输出会随会话消失，"5 次里 0 次"这个
 * 结论需要长期可引用。把复现率与延迟分布固化到 markdown，后续轮次若把
 * 0/5 变成 2/5，diff 一眼可见。
 *
 * @param {object[]} results 各轮结果
 * @returns {string} markdown 文本
 */
function renderMarkdown(results) {
  const total = results.length;
  const valid = results.filter((r) => r.fatal === undefined && r.probeUnusable !== true);
  const reds = valid.filter((r) => r.verdict === 'RED').length;
  const unusable = results.filter((r) => r.probeUnusable === true).length;
  const fatals = results.filter((r) => r.fatal !== undefined && r.probeUnusable !== true).length;

  const latencies = results
    .filter((r) => typeof r.firstBlackoutLatencyMs === 'number')
    .map((r) => r.firstBlackoutLatencyMs)
    .sort((a, b) => a - b);

  const pct = valid.length === 0 ? '—' : `${((reds / valid.length) * 100).toFixed(0)}%`;
  const stat = (fn) => (latencies.length === 0 ? '—' : String(fn(latencies)));
  const median = (arr) => (arr.length === 0 ? 0 : arr[Math.floor(arr.length / 2)]);

  const rows = results
    .map((r) => {
      if (r.probeUnusable === true) {
        return `| ${r.roundIndex} | 环境不可用 | — | — | — | ${r.fatal} |`;
      }
      if (r.fatal !== undefined) {
        return `| ${r.roundIndex} | 致命错误 | — | — | — | ${r.fatal} |`;
      }
      return (
        `| ${r.roundIndex} | ${r.verdict === 'RED' ? '**红灯**' : '绿灯'} | ` +
        `${r.sampleCount} | ${r.blackoutEvents} | ` +
        `${r.firstBlackoutLatencyMs === null ? '—' : r.firstBlackoutLatencyMs} | ` +
        `基线亮度 ${Number(r.baselineAvg).toFixed(2)} |`
      );
    })
    .join('\n');

  const detailBlocks = results
    .filter((r) => Array.isArray(r.blackoutList) && r.blackoutList.length > 0)
    .map((r) => {
      const items = r.blackoutList
        .map(
          (b) =>
            `  - 距 T0 **${b.latencyMs}ms**，avg=${b.avg.toFixed(3)}，max=${b.max}，min=${b.min}，` +
            `chaos=${b.store?.activeChaos ?? '?'}，selected=${b.store?.selectedEntityId ?? 'null'}`,
        )
        .join('\n');
      return `### 第 ${r.roundIndex} 轮现场\n\n${items}`;
    })
    .join('\n\n');

  return `# KubeVision AI — 黑屏基线（可重复红绿灯）

> 由 \`scripts/probe-blackout.mjs\` 自动生成。**请勿手改**：重跑命令即可刷新。

## 1. 结论

| 指标 | 值 |
|---|---|
| 动作 | \`${action}\` |
| 单次探测时长 | ${durationSec}s |
| 重复次数 | ${total} |
| 有效轮次 | ${valid.length} |
| **黑屏复现率** | **${reds}/${valid.length}（${pct}）** |
| 环境不可用轮次 | ${unusable} |
| 致命错误轮次 | ${fatals} |
| 判定 | ${reds > 0 ? '**红灯** —— 存在可复现黑屏' : '绿灯 —— 未复现黑屏'} |
| 采样间隔（请求值） | ${intervalMs}ms |
| 亮度阈值 | ${threshold}/255 |
| commit | \`${readCommit()}\` |
| 生成时刻 | ${new Date().toISOString()} |

## 2. 首次黑屏距动作触发（T0）的延迟分布

| 统计量 | 毫秒 |
|---|---|
| 样本数 | ${latencies.length} |
| 最小 | ${stat((a) => a[0])} |
| 中位数 | ${stat(median)} |
| 最大 | ${stat((a) => a[a.length - 1])} |
| 全部 | ${latencies.length === 0 ? '—（未复现，无延迟可统计）' : latencies.join(', ')} |

## 3. 逐轮明细

| 轮次 | 判定 | 采样数 | 黑屏事件 | 首次黑屏延迟(ms) | 备注 |
|---|---|---|---|---|---|
${rows}
${detailBlocks.length > 0 ? `\n${detailBlocks}\n` : ''}
## 4. 读这份表时必须知道的事

1. **"0/${valid.length}"不等于"永不黑屏"**。它只说明在**本次环境、本次时长**内没黑。
   真机 GPU 的上下文丢失（TDR、显存耗尽）本探针无法触及。
2. **实际采样周期约 2~3.5 秒，远大于请求的 ${intervalMs}ms**。
   每次 \`readPixels\` 整个帧缓冲（约 4~5MB）再经 CDP 回传，在 SwiftShader
   软件光栅化下单次就要 2~3 秒。因此**短于约 3 秒的瞬时黑屏会被漏采**，
   这份复现率是**下界**而非确值。
3. **阈值 ${threshold}/255 是刻意压低的结果**。3D 背景本身是近黑
   （\`#020815\` ≈ 亮度 7.7），"画面偏暗"是设计不是故障；只有均匀的 0
   才算黑屏。基线亮度实测约 30、峰值 172~255，与 0 相差两个数量级，
   说明探针分辨力足够。
4. **FPS 不能作为证据**，见 \`docs/summit/BASELINE.md\` 的软渲染/独显对比章节。
`;
}

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

async function main() {
  const startedAt = new Date();
  console.log('KubeVision AI — WebGL 黑屏探针（probe-blackout.mjs）');
  console.log(`  目标     : ${baseUrl}`);
  console.log(`  动作     : ${action}`);
  console.log(`  时长     : ${durationSec}s × ${repeatCount} 轮`);
  console.log(`  间隔/阈值: ${intervalMs}ms / ${threshold}`);
  console.log(`  开始     : ${startedAt.toISOString()}`);
  console.log(`  commit   : ${readCommit()}`);

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

  /* ---- 启动 headless Edge（多轮复用同一浏览器） ---- */
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

  /* ---- 多轮重复 ---- */
  const results = [];
  for (let round = 1; round <= repeatCount; round += 1) {
    const result = await runRound(cdp, round);
    results.push(result);
    writePerRunLog(result);

    if (result.fatal !== undefined) {
      console.error(`\n[FATAL] 第 ${round} 轮：${result.fatal}`);
      /* 致命/环境不可用直接终止：继续跑只会把同一结论重复 N 次 */
      cdp.close();
      cleanup();
      writeMarkdown(results);
      process.exit(1);
    }
  }

  cdp.close();
  cleanup();

  /* ---- 汇总 ---- */
  const valid = results.filter((r) => r.fatal === undefined && r.probeUnusable !== true);
  const reds = valid.filter((r) => r.verdict === 'RED').length;
  const latencies = valid
    .filter((r) => typeof r.firstBlackoutLatencyMs === 'number')
    .map((r) => r.firstBlackoutLatencyMs)
    .sort((a, b) => a - b);

  console.log('');
  console.log('='.repeat(78));
  console.log('汇总');
  console.log('='.repeat(78));
  console.log(`  重复次数     : ${results.length}`);
  console.log(`  有效轮次     : ${valid.length}`);
  console.log(`  黑屏复现率   : ${reds}/${valid.length}`);
  console.log(`  首次黑屏延迟 : ${latencies.length === 0 ? '未复现' : `${latencies.join(', ')} ms`}`);
  console.log(`  判定         : ${reds > 0 ? '【红灯 · 存在可复现黑屏】' : '【绿灯 · 未复现黑屏】'}`);

  writeMarkdown(results);

  process.exit(reds > 0 ? 2 : 0);
}

/**
 * 写汇总 markdown（仅在提供了 --md 时）。
 *
 * @param {object[]} results 各轮结果
 */
function writeMarkdown(results) {
  if (mdPath === null) return;
  try {
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, renderMarkdown(results), 'utf8');
    console.log(`\n[汇总] 已写入 ${mdPath}`);
  } catch (err) {
    console.error(`[WARN] markdown 写入失败: ${String(err)}`);
  }
}

/**
 * 把单轮日志落盘（保留每轮完整采样曲线）。
 *
 * @param {object} result 单轮结果
 */
function writePerRunLog(result) {
  try {
    mkdirSync(outDir, { recursive: true });
    const suffix = repeatCount > 1 ? `-r${result.roundIndex}of${repeatCount}` : '';
    const file = join(outDir, `probe-blackout-${action}${suffix}.log`);
    writeFileSync(file, `${result.lines.join('\n')}\n`, 'utf8');
    console.log(`[日志] ${file}`);
  } catch (err) {
    console.error(`[WARN] 日志写入失败: ${String(err)}`);
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
