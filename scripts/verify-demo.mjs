#!/usr/bin/env node
/**
 * KubeVision AI — 自动路演回归脚本（scripts/verify-demo.mjs）
 *
 * 【为什么需要它】自动路演是评委面前"最后一道保险"。它刻意绕过了人工操作，
 * 所以任何事实错误都会**自动**发生、且没人来得及拦截。本脚本把 R1 的
 * 6 条验收硬指标固化成可重复执行的断言，任何后续改动都必须先过这一关。
 *
 * 【与 verify.mjs 的分工】
 * - `verify.mjs`：全站 32 项静态/接口/E2E 冒烟（含 ActionConfirm 的可访问性契约）；
 * - 本脚本：只盯"路演自证链路"——镜头锁的是不是真受灾机架、自愈修的是不是真受害者、
 *   HITL 是不是真的走了 UI、旁白数字与画面是否一致、连跑两遍是否等价。
 *
 * 【为何必须跑在 dev 构建上】项目把 `window.__KUBEVISION_STORE__` 设计为
 * dev-only（生产构建被 DCE 移除）。路演断言需要读 Store 真相，因此：
 *   先 `pnpm dev`（或本脚本自动拉起），再执行本脚本。
 * 生产构建下脚本会明确报错退出，而不是静默跳过。
 *
 * 【用法】
 *   node scripts/verify-demo.mjs                 # 默认 http://127.0.0.1:3000
 *   node scripts/verify-demo.mjs --skip-repeat   # 跳过"连跑两遍"（省时间）
 *   node scripts/verify-demo.mjs --base=http://127.0.0.1:3000
 *
 * 【退出码】0 = 全部通过；1 = 有失败（并打印全部实际值，禁止只打印 PASS/FAIL）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ========================================================================== */
/* 配置                                                                        */
/* ========================================================================== */

/** 基础 URL（可由 --base= 覆盖） */
const BASE_URL = readArg('--base') ?? 'http://127.0.0.1:3000';

/**
 * 压力场景开关。
 *
 * 【为什么默认关闭】压力矩阵要跑慢网、强制 500、GL 丢失、连点、停止清理
 * 五个场景，额外约 3 分钟。日常回归要快，压测按需触发。
 */
const STRESS = process.argv.includes('--stress');

/**
 * 失败注入开关（测试装置自检用）。
 *
 * 【为什么保留它】"失败时自动归档证据"这条能力本身也需要被验证：
 * 若从不触发失败，就无法证明 store 快照 / console / 末帧截图真的会落盘。
 * 置位后会在汇总前主动记一条失败断言，用来验证归档链路。
 *
 * 【为什么只认环境变量、不认命令行参数】它是**测试装置的自伤开关**，
 * 一旦被误敲进 CI 或别人的验收命令里，会把一次正常的全绿跑成红色。
 * 环境变量必须显式导出才能生效，天然不会出现在命令历史里被顺手复用：
 *   PowerShell:  $env:KV_VERIFY_INJECT_FAILURE='1'; node scripts/verify-demo.mjs
 *   bash:        KV_VERIFY_INJECT_FAILURE=1 node scripts/verify-demo.mjs
 */
const INJECT_FAILURE = process.env.KV_VERIFY_INJECT_FAILURE === '1';

/** 是否跳过"连跑两遍"（第二遍耗时约 40s）；--stress 模式默认跳过以控制总时长 */
const SKIP_REPEAT =
  process.argv.includes('--skip-repeat') || (STRESS && !process.argv.includes('--with-repeat'));

/** CDP 调试端口（与 verify.mjs 的 9333 错开，避免并行冲突） */
const CDP_PORT = 9334;

/**
 * 期望的「混沌场景 → 受灾机架」映射。
 *
 * 【事实来源】`src/utils/syntheticEngine.ts` 的
 * `OOM_RACK_INDEX = 1`（L80）、`SPIKE_RACK_INDEX = 0`（L87）、
 * `PARTITION_RACK_INDEX = 2`（L90）。
 *
 * 【为什么脚本里还要写一份】测试必须独立表达"期望值"，否则就变成
 * "拿实现去验证实现"。这里写死后，一旦源码映射被改错，本脚本会立刻失败。
 * 同时下面的断言也会校验**不变量**（选中节点名下必须有异常 Pod），
 * 因此即便机架编号整体重排，只要不变式成立仍会通过——两层保护。
 */
const EXPECTED_ACTION = {
  POD_OOM_SWARM: 'restart_pod',
  NET_PACKET_LOSS: 'drain_node',
  NODE_CPU_SPIKE: 'scale_deployment',
};

/** 断言的演示剧本（R1 只覆盖 OOM 主链路；网络链路逻辑同构） */
const SCRIPT_LABEL_PREFIX = 'OOM 全链路自愈';

/* ========================================================================== */
/* 断言与输出                                                                  */
/* ========================================================================== */

let passCount = 0;
let failCount = 0;
/** 失败项的实际值明细（退出时整块打印） */
const failureDetails = [];

function ok(name, detail = '') {
  passCount += 1;
  console.log(`  \u2713 ${name}${detail ? `  ::  ${detail}` : ''}`);
}

function bad(name, actual, detail = '') {
  failCount += 1;
  const line = `${name}  ::  ${detail ? detail + ' 之外' : ''}实际值=${JSON.stringify(actual)}`;
  console.log(`  \u2717 ${line}`);
  failureDetails.push({ name, actual, detail });
}

function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/* 截图与 canvas 亮度探针（R01 黑屏回归并入本脚本）                              */
/* ========================================================================== */

/**
 * 亮度阈值（0~255，Rec.709 加权）。
 *
 * 【为什么是 2.0】3D 背景本身是近黑的深空色（#020611 量级），正常画面里
 * 机架的高光与告警光带会把平均亮度顶到 5~20；而真正的黑屏（上下文丢失 /
 * 渲染中断 / NaN 短路）整帧几乎全 0。实测基线见 docs/summit/blackout-baseline.md，
 * 2.0 在"近黑但有内容"与"真黑"之间留了足够余量。
 */
const BRIGHTNESS_THRESHOLD = 2.0;

/** 截图输出目录（按轮次归档） */
const SHOT_DIR = join(process.cwd(), 'docs', 'summit', 'shots', 'r10-verify');

/**
 * 采样 canvas 平均亮度（只读，不改变页面状态）。
 *
 * 【实现要点】复用 probe-blackout.mjs 的 readPixels 方案：
 * 1. 必须 `st.gl.getContext()` 取原始 WebGL 上下文——THREE.WebGLRenderer
 *    本身没有 readPixels 方法，误用会抛 "is not a function" 被误判成黑屏；
 * 2. 只在 rAF 回调里读，才能读到 R3F 本帧渲染结果；
 * 3. 16×16 等距采样 + Rec.709 加权，避免用 RGB 平均误判蓝/绿画面。
 *
 * @param {object} cdp CDP 会话
 * @returns {Promise<{avg:number,max:number,min:number,points:number,lost:boolean}|{error:string}>}
 */
async function sampleCanvasBrightness(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const st = window.__KUBEVISION_R3F__ ? window.__KUBEVISION_R3F__.get() : null;
      if (st === null) return { error: 'no R3F store' };
      const gl = st.gl;
      const ctx = gl.getContext();
      const canvas = gl.domElement;

      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          if (ctx.isContextLost()) {
            resolve({ lost: true, avg: 0, max: 0, min: 0, points: 0 });
            return;
          }
          const w = canvas.width;
          const h = canvas.height;
          if (w === 0 || h === 0) { resolve({ error: 'zero-sized canvas' }); return; }
          const buffer = new Uint8Array(w * h * 4);
          try {
            ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, buffer);
          } catch (e) {
            resolve({ error: 'readPixels threw: ' + String(e).slice(0, 80) });
            return;
          }
          const GRID = 16;
          let sum = 0;
          let max = 0;
          let min = 255;
          let points = 0;
          for (let gy = 0; gy < GRID; gy += 1) {
            for (let gx = 0; gx < GRID; gx += 1) {
              const px = Math.min(w - 1, Math.floor(((gx + 0.5) * w) / GRID));
              const py = Math.min(h - 1, Math.floor(((gy + 0.5) * h) / GRID));
              const idx = (py * w + px) * 4;
              const r = buffer[idx];
              const g = buffer[idx + 1];
              const b = buffer[idx + 2];
              const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              sum += lum;
              if (lum > max) max = lum;
              if (lum < min) min = lum;
              points += 1;
            }
          }
          resolve({ lost: false, avg: sum / points, max, min, points });
        });
      });
    })()`,
  );
}

/**
 * 采集一张 PNG 截图并落盘。
 *
 * 【为什么失败不抛】截图是证据而不是断言前提：磁盘满、路径不可写都不该
 * 让整轮回归失败。失败时返回 null 并由调用方记录一条 warn。
 *
 * @param {object} cdp CDP 会话
 * @param {string} name 文件名（不含扩展名）
 * @returns {Promise<string|null>} 落盘路径；失败返回 null
 */
async function captureScreenshot(cdp, name) {
  try {
    if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const base64 = res?.result?.data;
    if (typeof base64 !== 'string' || base64.length === 0) return null;
    const file = join(SHOT_DIR, `${name}.png`);
    writeFileSync(file, Buffer.from(base64, 'base64'));
    return file;
  } catch {
    return null;
  }
}

/**
 * 采一次亮度并记录到样本表（供末尾统一断言）。
 *
 * @param {object} cdp CDP 会话
 * @param {string} label 采样时点标签
 * @param {Array<{label:string,avg:number,lost:boolean,error?:string}>} sink 样本表
 * @returns {Promise<object>} 采样结果
 */
async function recordBrightness(cdp, label, sink) {
  const sample = await sampleCanvasBrightness(cdp);
  const entry = {
    label,
    avg: typeof sample?.avg === 'number' ? Number(sample.avg.toFixed(2)) : null,
    lost: sample?.lost === true,
    error: typeof sample?.error === 'string' ? sample.error : undefined,
  };
  sink.push(entry);
  return entry;
}

function readArg(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? null : hit.slice(flag.length + 1);
}

/* ========================================================================== */
/* CDP 客户端                                                                  */
/* ========================================================================== */

/**
 * 建立到页面的 CDP WebSocket 会话。
 *
 * @param {string} wsUrl DevTools websocket 地址
 * @returns {Promise<{ send: (method: string, params?: object) => Promise<any>, close: () => void }>}
 */
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];
  /*
   * 【全量 console 缓冲】失败归档时只留 error 是不够的：很多卡顿是
   * warn（如 React 警告、资源 404）先出现。这里保留全部类型，
   * 上限 300 条防止长跑把内存撑大。
   */
  const consoleAll = [];
  /** 事件钩子（同一时刻只允许一个消费者，够用且避免多路抢答） */
  let eventHandler = null;

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const type = msg.params?.type ?? 'log';
      const text = (msg.params?.args ?? [])
        .map((a) => String(a.value ?? a.description ?? ''))
        .join(' ')
        .slice(0, 400);
      consoleAll.push({ type, text });
      if (consoleAll.length > 300) consoleAll.shift();
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const text = (msg.params.args ?? [])
        .map((a) => String(a.value ?? a.description ?? ''))
        .join(' ')
        .slice(0, 200);
      consoleErrors.push(text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(msg.params?.exceptionDetails?.text ?? '').slice(0, 200));
    }
    if (typeof msg.method === 'string' && eventHandler !== null) {
      /* 事件钩子用于 Fetch 拦截等需要主动应答的场景；异常不得中断消息循环 */
      try {
        eventHandler(msg);
      } catch {
        /* 忽略：钩子失败不应影响断言主流程 */
      }
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`CDP 超时: ${method}`)), 25000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    close: () => ws.close(),
    consoleErrors,
    pageErrors,
    consoleAll,
    /**
     * 注册事件钩子（用于 Fetch.requestPaused 等需要应答的 CDP 事件）。
     *
     * @param {(msg: object) => void|Promise<void>} fn 事件回调；传 null 解除
     */
    setEventHandler: (fn) => {
      eventHandler = fn;
    },
  };
}

/**
 * 在页面内求值并返回可序列化结果。
 *
 * @param {object} cdp CDP 会话
 * @param {string} expression 待求值表达式
 * @returns {Promise<any>} 结果；异常时返回 { __err: string }
 */
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

/* ========================================================================== */
/* 页面探针（全部基于 Store 真相 + DOM）                                        */
/* ========================================================================== */

/** 读取路演与集群的关键状态 */
const READ_STATE = `(() => {
  const store = window.__KUBEVISION_STORE__;
  if (!store) return { __noStore: true };
  const s = store.getState();
  const snap = s.snapshotSummary;
  /* R41 后字幕条改名「自动演练序列器」，阶段信息走 data-demo-phase；保留旧 aria 兜底 */
  const bar =
    document.querySelector('[aria-label="自动演练序列器"]') ??
    document.querySelector('[aria-label^="剧本路演进行中"]');
  const logs = s.terminalLogs ?? [];
  const barText = bar === null ? '' : (bar.textContent || '');
  const elapsedHit = barText.match(/([0-9.]+)s\\s*\\/\\s*([0-9]+)s/);
  return {
    phase: bar ? (bar.getAttribute('data-demo-phase') ?? bar.getAttribute('aria-label')) : null,
    barText,
    barElapsedSec: elapsedHit === null ? null : Number(elapsedHit[1]),
    barTotalSec: elapsedHit === null ? null : Number(elapsedHit[2]),
    status: s.demoAutoConfirm,
    chaos: s.activeChaos,
    selected: s.selectedEntityId,
    orbit: s.isOrbitPatrolActive,
    health: snap.clusterHealthScore,
    healedIds: Object.keys(s.healedPodIds ?? {}),
    pending: (s.pendingRemediations ?? []).length,
    alerts: (snap.activeAlerts ?? []).length,
    abnormalPods: (snap.pods ?? []).filter((p) => p.status !== 'Running').map((p) => ({
      id: p.id, name: p.name, nodeId: p.nodeId, status: p.status,
    })),
    nodes: (snap.nodes ?? []).map((n) => ({ id: n.id, name: n.name, rackIndex: n.rackIndex })),
    queuedLogs: logs.filter((l) => typeof l === 'string' && l.includes('QUEUED')).length,
    directorLogs: logs.filter((l) => typeof l === 'string' && l.includes('DEMO-DIRECTOR')).length,
    lastDirectorLog: logs.filter((l) => typeof l === 'string' && l.includes('DEMO-DIRECTOR')).slice(-1)[0] ?? null,
    mcpAction: (() => {
      const m = logs.filter((l) => typeof l === 'string' && /MCP 回执/.test(l)).slice(-1)[0];
      if (m === undefined) return null;
      const hit = m.match(/·\\s*([a-z_]+)\\s*已完成/);
      return hit === null ? null : hit[1];
    })(),
    topBarHealth: (() => {
      const el = Array.from(document.querySelectorAll('[role="img"]')).find((e) =>
        (e.getAttribute('aria-label') || '').startsWith('集群健康分'));
      if (el === null) return null;
      const hit = (el.getAttribute('aria-label') || '').match(/集群健康分\\s*(\\d+)/);
      return hit === null ? null : Number(hit[1]);
    })(),
  };
})()`;

/** 统计 AI 抽屉里三张卡片的挂载情况 */
const READ_CARDS = `(() => {
  const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
  if (!drawer) return { __noDrawer: true };
  const labels = Array.from(drawer.querySelectorAll('[aria-label]')).map((el) =>
    el.getAttribute('aria-label') || '');
  const actionCards = labels.filter((l) => l.startsWith('自愈操作确认'));
  const text = drawer.textContent || '';
  return {
    metricsCard: labels.some((l) => l.startsWith('Pod 指标卡')) ? 1 : 0,
    rootCauseCard: labels.some((l) => l.startsWith('根因分析')) ? 1 : 0,
    actionCard: actionCards.length,
    actionCardExecuted: /已执行/.test(text) && /3D 拓扑已自愈恢复/.test(text),
    actionCardPending: /立即执行自愈方案/.test(text),
    hostNodeInProse: (() => {
      const hit = text.match(/宿主节点\\s*([a-z0-9-]+)/i);
      return hit === null ? null : hit[1];
    })(),
  };
})()`;

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

/* ========================================================================== */
/* 失败证据归档（追问 1）                                                       */
/* ========================================================================== */

/** 失败证据根目录 */
const FAILURE_ROOT = join(process.cwd(), 'docs', 'summit', 'failures');

/**
 * 把当次现场的完整证据落盘。
 *
 * 【为什么必须自动做】路演失败往往是**时序性**的：刷新一次就复现不了。
 * 只打印"哪条断言失败"没有价值，必须同时留下：
 *   · store 快照（当时的混沌/选中/自愈/告警到底是什么）；
 *   · 全量 console（很多卡顿先是 warn）；
 *   · 最后一帧截图（画面黑没黑、卡片在不在、字幕写的是什么）；
 *   · 导演追踪（effects 停在哪个调用上）。
 * 这四样凑齐，才能在不复现的情况下定位问题。
 *
 * @param {object} cdp CDP 会话
 * @returns {Promise<string|null>} 归档目录；失败返回 null
 */
async function saveFailureArtifacts(cdp) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(FAILURE_ROOT, stamp);
    mkdirSync(dir, { recursive: true });

    /* ---- 1. store + 引擎快照 ---- */
    const storeDump = await evaluate(
      cdp,
      `(() => {
        const store = window.__KUBEVISION_STORE__;
        if (!store) return { __noStore: true };
        const s = store.getState();
        const logs = s.terminalLogs ?? [];
        return {
          activeChaos: s.activeChaos,
          selectedEntityId: s.selectedEntityId,
          selectedEntityType: s.selectedEntityType,
          connectionMode: s.connectionMode,
          healedPodIds: s.healedPodIds,
          pendingRemediations: s.pendingRemediations,
          lastRemediationDiff: s.lastRemediationDiff,
          demoAutoConfirm: s.demoAutoConfirm,
          isOrbitPatrolActive: s.isOrbitPatrolActive,
          isGlContextLost: s.isGlContextLost,
          statusFilter: s.statusFilter,
          snapshotSummary: s.snapshotSummary,
          directorDebug: window.__demoDirectorDebug__ === undefined ? null : {
            timerCount: window.__demoDirectorDebug__.timerCount,
            status: window.__demoDirectorDebug__.status,
            pacing: window.__demoDirectorDebug__.pacing,
            phaseIndex: window.__demoDirectorDebug__.phaseIndex,
            awaitingNarratorAdvance: window.__demoDirectorDebug__.awaitingNarratorAdvance,
          },
          terminalLogsTail: logs.slice(-80),
        };
      })()`,
    );
    writeFileSync(join(dir, 'store-snapshot.json'), JSON.stringify(storeDump, null, 2), 'utf8');

    /* ---- 2. 全量 console + 页面异常 ---- */
    const consoleLines = [
      '# console 全量（按时间顺序）',
      ...cdp.consoleAll.map((c) => `[${c.type}] ${c.text}`),
      '',
      '# 未捕获异常',
      ...(cdp.pageErrors.length === 0 ? ['(none)'] : cdp.pageErrors),
    ];
    writeFileSync(join(dir, 'console.log'), consoleLines.join(String.fromCharCode(10)), 'utf8');

    /* ---- 3. 最后一帧截图 ---- */
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const base64 = shot?.result?.data;
      if (typeof base64 === 'string' && base64.length > 0) {
        writeFileSync(join(dir, 'last-frame.png'), Buffer.from(base64, 'base64'));
      }
    } catch {
      /* 截图失败不阻断归档 */
    }

    /* ---- 4. 失败清单 ---- */
    writeFileSync(
      join(dir, 'failures.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          baseUrl: BASE_URL,
          passCount,
          failCount,
          failures: failureDetails,
        },
        null,
        2,
      ),
      'utf8',
    );

    return dir;
  } catch (err) {
    console.log(`  [warn] 失败证据归档未完成: ${err?.message ?? err}`);
    return null;
  }
}

/* ========================================================================== */
/* 压力场景矩阵（--stress）                                                     */
/* ========================================================================== */

/**
 * 跑压力场景矩阵。
 *
 * 【为什么单列一节】常规断言验证"顺利路径"，而答辩现场真正会翻车的是
 * 慢网、上游 500、GL 上下文丢失、手抖连点、演示中组件卸载这些异常路径。
 * 这些场景在生产里低频、在演示现场却一次就致命，必须脚本化。
 *
 * @param {object} cdp CDP 会话
 * @returns {Promise<Array<{scenario:string,result:string,actual:object}>>} 矩阵行
 */
async function runStressMatrix(cdp) {
  section('压力场景矩阵（--stress）');

  const rows = [];
  /**
   * 记录一行矩阵结果。
   *
   * @param {string} scenario 场景名
   * @param {boolean} pass 是否通过
   * @param {object} actual 实际观测值（失败时必填，成功时也打印关键量）
   * @param {string} detail 通过时展示的摘要
   */
  const judge = (scenario, pass, actual, detail = '') => {
    rows.push({ scenario, result: pass ? '通过' : '失败', actual });
    if (pass) ok(`S·${scenario}`, detail);
    else bad(`S·${scenario}`, actual);
  };

  /* ---- 工具：启动 OOM 剧本（单次点击） ---- */
  const startDemo = async () =>
    evaluate(
      cdp,
      `(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) =>
          (x.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
        if (!b) return { error: 'start button missing' };
        b.click();
        await new Promise((r) => setTimeout(r, 800));
        const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
          .find((x) => (x.textContent || '').includes(${JSON.stringify(SCRIPT_LABEL_PREFIX)}));
        if (!item) return { error: 'menu item missing' };
        item.click();
        return { ok: true };
      })()`,
    );

  /* ---- 工具：点停止 ---- */
  const stopDemo = async () => {
    await evaluate(
      cdp,
      `(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) =>
          (x.getAttribute('aria-label') || '').includes('停止剧本路演'));
        if (b) b.click();
        return true;
      })()`,
    );
    await sleep(1500);
  };

  /* ====================================================================== */
  /* S1 · 慢网 300ms                                                         */
  /* ====================================================================== */
  await stopDemo();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 300,
    downloadThroughput: Math.round((1.5 * 1024 * 1024) / 8),
    uploadThroughput: Math.round((750 * 1024) / 8),
  });
  await sleep(600);

  const s1Start = await startDemo();
  let s1Cards = null;
  let s1Brightness = null;
  if (s1Start?.ok === true) {
    /* 慢网下给足时间：等到动作卡出现或 100 秒 */
    for (let i = 0; i < 200; i += 1) {
      await sleep(500);
      const c = await evaluate(cdp, READ_CARDS);
      if ((c?.actionCard ?? 0) >= 1) {
        await sleep(1200);
        s1Cards = await evaluate(cdp, READ_CARDS);
        break;
      }
    }
    s1Brightness = await sampleCanvasBrightness(cdp);
  }
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await cdp.send('Network.disable');

  judge(
    '慢网300ms：卡片仍恰好各一份且画面不黑',
    s1Start?.ok === true &&
      s1Cards?.metricsCard === 1 &&
      s1Cards?.rootCauseCard === 1 &&
      s1Cards?.actionCard === 1 &&
      (s1Brightness?.avg ?? 0) > BRIGHTNESS_THRESHOLD,
    { start: s1Start, cards: s1Cards, brightness: s1Brightness },
    `cards=${s1Cards?.metricsCard}/${s1Cards?.rootCauseCard}/${s1Cards?.actionCard} avg=${s1Brightness?.avg?.toFixed?.(2)}`,
  );
  await stopDemo();

  /* ====================================================================== */
  /* S2 · 上游 500：不崩、给重试、重试后卡片不重复                              */
  /* ====================================================================== */
  let forcedCount = 0;
  cdp.setEventHandler(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    if (request.url.includes('/api/chat') && forcedCount === 0) {
      forcedCount += 1;
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 500,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ error: 'forced-upstream-500' })).toString('base64'),
      });
      return;
    }
    await cdp.send('Fetch.continueRequest', { requestId });
  });
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/chat*', requestStage: 'Request' }],
  });

  const s2Start = await startDemo();
  let s2FailureUi = null;
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    s2FailureUi = await evaluate(
      cdp,
      `(() => {
        const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
        const text = drawer === null ? '' : (drawer.textContent || '');
        return {
          hasFailureNotice: text.includes('诊断流意外中断'),
          hasRetry: text.includes('一键重试'),
          crashed: document.querySelector('canvas') === null,
          storeAlive: typeof window.__KUBEVISION_STORE__ !== 'undefined',
        };
      })()`,
    );
    if (s2FailureUi?.hasFailureNotice === true) break;
  }

  /* 点一键重试：第二次请求放行（forcedCount 已为 1） */
  const retried = await evaluate(
    cdp,
    `(() => {
      const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
      if (!drawer) return { error: 'no drawer' };
      const btn = Array.from(drawer.querySelectorAll('button')).find((b) =>
        (b.textContent || '').includes('一键重试'));
      if (!btn) return { error: 'retry button missing' };
      btn.click();
      return { ok: true };
    })()`,
  );
  let s2Cards = null;
  if (retried?.ok === true) {
    for (let i = 0; i < 160; i += 1) {
      await sleep(500);
      const c = await evaluate(cdp, READ_CARDS);
      if ((c?.actionCard ?? 0) >= 1) {
        await sleep(1500);
        s2Cards = await evaluate(cdp, READ_CARDS);
        break;
      }
    }
  }
  await cdp.send('Fetch.disable');

  judge(
    '上游500：不崩、暴露重试、重试后卡片不重复',
    forcedCount === 1 &&
      s2FailureUi?.hasFailureNotice === true &&
      s2FailureUi?.hasRetry === true &&
      s2FailureUi?.crashed === false &&
      s2FailureUi?.storeAlive === true &&
      retried?.ok === true &&
      s2Cards?.metricsCard === 1 &&
      s2Cards?.rootCauseCard === 1 &&
      s2Cards?.actionCard === 1,
    { forcedCount, failureUi: s2FailureUi, retried, cardsAfterRetry: s2Cards },
    `forced=${forcedCount} notice=${s2FailureUi?.hasFailureNotice} cardsAfterRetry=${s2Cards?.metricsCard}/${s2Cards?.rootCauseCard}/${s2Cards?.actionCard}`,
  );
  await stopDemo();

  /* ====================================================================== */
  /* S3 · webglcontextlost 页面不崩                                          */
  /* ====================================================================== */
  const s3PrevErrors = cdp.pageErrors.length;
  const s3Before = await evaluate(
    cdp,
    `(() => ({
      canvas: document.querySelector('canvas') !== null,
      storeAlive: typeof window.__KUBEVISION_STORE__ !== 'undefined',
    }))()`,
  );
  const s3Dispatched = await evaluate(
    cdp,
    `(() => {
      const c = document.querySelector('canvas');
      if (!c) return { error: 'no canvas' };
      c.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      return { ok: true };
    })()`,
  );
  await sleep(3000);
  const s3After = await evaluate(
    cdp,
    `(() => ({
      canvas: document.querySelector('canvas') !== null,
      storeAlive: typeof window.__KUBEVISION_STORE__ !== 'undefined',
      glLostFlag: window.__KUBEVISION_STORE__.getState().isGlContextLost,
      rootChildren: document.body.querySelectorAll('*').length,
    }))()`,
  );
  const s3NewErrors = cdp.pageErrors.length - s3PrevErrors;
  judge(
    'webglcontextlost：页面不崩、GL 丢失状态被记录',
    s3Dispatched?.ok === true &&
      s3Before.canvas === true &&
      s3After.canvas === true &&
      s3After.storeAlive === true &&
      s3After.glLostFlag === true &&
      s3NewErrors === 0,
    { before: s3Before, dispatch: s3Dispatched, after: s3After, newPageErrors: s3NewErrors },
    `glLostFlag=${s3After.glLostFlag} newErrors=${s3NewErrors}`,
  );

  /* 让上下文恢复：重载页面，避免后续场景受污染 */
  await cdp.send('Page.navigate', { url: BASE_URL });
  for (let i = 0; i < 240; i += 1) {
    const ready = await evaluate(cdp, 'document.querySelector("canvas") !== null');
    if (ready === true) break;
    await sleep(400);
  }
  await sleep(9000);

  /* ====================================================================== */
  /* S4 · 连点 5 次只产生一个实例                                             */
  /* ====================================================================== */
  await evaluate(cdp, 'window.__KUBEVISION_STORE__.getState().clearTerminalLogs()');
  const burst = await evaluate(
    cdp,
    `(async () => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        (x.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
      if (!b) return { error: 'start button missing' };
      b.click();
      await new Promise((r) => setTimeout(r, 800));
      const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
        .find((x) => (x.textContent || '').includes(${JSON.stringify(SCRIPT_LABEL_PREFIX)}));
      if (!item) return { error: 'menu item missing' };
      for (let i = 0; i < 5; i += 1) item.click();
      return { ok: true };
    })()`,
  );
  await sleep(2500);
  const burstState = await evaluate(
    cdp,
    `(() => {
      const dbg = window.__demoDirectorDebug__;
      const logs = window.__KUBEVISION_STORE__.getState().terminalLogs ?? [];
      return {
        timerCount: dbg === undefined ? null : dbg.timerCount,
        startLogs: logs.filter((l) => typeof l === 'string' && l.includes('▶ 启动剧本')).length,
        status: dbg === undefined ? null : dbg.status,
      };
    })()`,
  );
  judge(
    '连点5次：仅一个实例',
    burst?.ok === true && burstState.startLogs === 1 && (burstState.timerCount ?? 0) > 0,
    { burst, burstState },
    `startLogs=${burstState.startLogs} timerCount=${burstState.timerCount}`,
  );

  /* ====================================================================== */
  /* S5 · 停止后无游离定时器与 Store 写入                                     */
  /* ====================================================================== */
  const s5BeforeStop = await evaluate(
    cdp,
    `(() => {
      const dbg = window.__demoDirectorDebug__;
      const st = window.__KUBEVISION_STORE__.getState();
      return {
        timerCount: dbg === undefined ? null : dbg.timerCount,
        directorLogs: (st.terminalLogs ?? []).filter((l) => typeof l === 'string' && l.includes('DEMO-DIRECTOR')).length,
        healed: Object.keys(st.healedPodIds ?? {}).length,
        streaming: st.copilotStreaming,
      };
    })()`,
  );
  await evaluate(
    cdp,
    `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        (x.getAttribute('aria-label') || '').includes('停止剧本路演'));
      if (b) b.click();
      return true;
    })()`,
  );
  await sleep(900);
  const s5Settled = await evaluate(
    cdp,
    `(() => {
      const dbg = window.__demoDirectorDebug__;
      const st = window.__KUBEVISION_STORE__.getState();
      return {
        timerCount: dbg === undefined ? null : dbg.timerCount,
        directorLogs: (st.terminalLogs ?? []).filter((l) => typeof l === 'string' && l.includes('DEMO-DIRECTOR')).length,
        healed: Object.keys(st.healedPodIds ?? {}).length,
        streaming: st.copilotStreaming,
      };
    })()`,
  );
  /* stop 自身会写 1~2 条收尾日志，以此为基线再看 5 秒 */
  await sleep(5000);
  const s5After = await evaluate(
    cdp,
    `(() => {
      const dbg = window.__demoDirectorDebug__;
      const st = window.__KUBEVISION_STORE__.getState();
      return {
        timerCount: dbg === undefined ? null : dbg.timerCount,
        directorLogs: (st.terminalLogs ?? []).filter((l) => typeof l === 'string' && l.includes('DEMO-DIRECTOR')).length,
        healed: Object.keys(st.healedPodIds ?? {}).length,
        streaming: st.copilotStreaming,
      };
    })()`,
  );
  /*
   * 【关于"演示中卸载 TopBar"】真正的 React 卸载无法从 CDP 直接触发，
   * 而 useDemoDirector 的卸载清理调用的正是同一个 stopDemoDirector('unmount')。
   * 因此这里断言 stop 之后的**可观测契约**：定时器归零、导演日志不再新增、
   * Store 不再被写。报告里如实标注该等价关系，不假称已做过组件卸载。
   */
  judge(
    '停止后：定时器归零、5秒无日志新增、无 AI 流',
    s5BeforeStop.timerCount !== null &&
      s5Settled.timerCount === 0 &&
      s5After.timerCount === 0 &&
      s5After.directorLogs === s5Settled.directorLogs &&
      s5After.streaming === false,
    { beforeStop: s5BeforeStop, settled: s5Settled, after5s: s5After },
    `timers ${s5BeforeStop.timerCount}→0，logs ${s5Settled.directorLogs}→${s5After.directorLogs}，streaming=${s5After.streaming}`,
  );

  /* ====================================================================== */
  /* 矩阵输出                                                                */
  /* ====================================================================== */
  console.log('\n' + '-'.repeat(78));
  console.log('压力场景 × 结果');
  console.log('-'.repeat(78));
  console.log('| 场景 | 结果 | 关键实际值 |');
  console.log('|---|---|---|');
  for (const row of rows) {
    console.log(`| ${row.scenario} | ${row.result} | ${JSON.stringify(row.actual).slice(0, 160)} |`);
  }

  return rows;
}

async function main() {
  console.log('KubeVision AI — 自动路演回归（verify-demo）');
  console.log(`  目标: ${BASE_URL}`);
  console.log(`  连跑两遍: ${SKIP_REPEAT ? '跳过' : '启用'}`);

  /* ---- 前置：dev server 是否可达 ---- */
  let serverReady = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(4000) });
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
    console.error(`\n[FATAL] ${BASE_URL} 不可达。请先运行 pnpm dev。`);
    process.exit(1);
  }

  /* ---- 启动 headless Edge ---- */
  const EDGE_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edgePath = EDGE_PATHS.find((p) => existsSync(p));
  if (edgePath === undefined) {
    console.error('\n[FATAL] 未找到 Edge 浏览器，无法执行 E2E。');
    process.exit(1);
  }

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-verify-demo-${Date.now()}`);
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

  /* ---- 等 CDP 就绪 ---- */
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
    console.error('\n[FATAL] CDP 未就绪。');
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
  await cdp.send('Page.navigate', { url: BASE_URL });

  /* ---- 等页面与 Store 就绪 ---- */
  for (let i = 0; i < 300; i += 1) {
    const ready = await evaluate(cdp, 'document.querySelector("canvas") !== null');
    if (ready === true) break;
    await sleep(400);
  }
  await sleep(10000);

  const hasStore = await evaluate(cdp, 'typeof window.__KUBEVISION_STORE__ !== "undefined"');
  if (hasStore !== true) {
    console.error(
      '\n[FATAL] 未检测到 window.__KUBEVISION_STORE__。' +
        '\n        该项目把调试钩子设计为 dev-only，请使用 `pnpm dev` 启动服务后重跑。',
    );
    cleanup();
    process.exit(1);
  }

  /*
   * ---- 演示就绪轮询（R08 预检引入后的必要前置） ----
   *
   * 【为什么必须有】R08 给 startDemoDirector 加了启动预检，其中两项依赖
   * 运行时就绪：Copilot 抽屉已挂载、SSE 数据已流动（totalQps > 0）。
   * 冷启动（.next 刚重建）时首屏 10 秒内抽屉的懒加载 chunk 可能还没到，
   * 预检会直接拒绝启动——表现为"点了路演但什么都没发生"，断言全部读到 null。
   *
   * 这里显式等到"抽屉 + 数据"都就绪再开跑，把环境准备与业务断言分开。
   */
  let demoReady = null;
  for (let i = 0; i < 120; i += 1) {
    demoReady = await evaluate(
      cdp,
      `(() => {
        const store = window.__KUBEVISION_STORE__;
        if (!store) return { store: false };
        const qps = store.getState().snapshotSummary.totalQps;
        return {
          store: true,
          drawer: document.querySelector('[aria-label="AI Copilot 抽屉"]') !== null,
          viewport: document.querySelector('[aria-label="3D 集群拓扑视口"]') !== null,
          qps,
          glLost: store.getState().isGlContextLost,
        };
      })()`,
    );
    if (
      demoReady &&
      demoReady.drawer === true &&
      demoReady.viewport === true &&
      demoReady.qps > 0 &&
      demoReady.glLost !== true
    ) {
      break;
    }
    await sleep(500);
  }
  console.log(`  → 就绪检查: ${JSON.stringify(demoReady)}`);
  if (
    !demoReady ||
    demoReady.drawer !== true ||
    demoReady.viewport !== true ||
    !(demoReady.qps > 0)
  ) {
    bad('演示环境就绪（抽屉/视口/SSE 数据）', demoReady);
  } else {
    ok('演示环境就绪（抽屉/视口/SSE 数据）', `qps=${demoReady.qps}`);
  }

  /* ====================================================================== */
  /* 第一遍：主链路                                                          */
  /* ====================================================================== */
  section('第一遍 · 主链路（R1 §J-1 ~ §J-4）');

  const runStart = Date.now();
  const started = await evaluate(
    cdp,
    `(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
      if (!btn) return { error: 'start button missing' };
      btn.click();
      /* React 需要一帧才把菜单渲染出来：同步查询必然拿不到 */
      await new Promise((resolve) => setTimeout(resolve, 800));
      const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
        .find((b) => (b.textContent || '').includes(${JSON.stringify(SCRIPT_LABEL_PREFIX)}));
      if (!item) return { error: 'script menu item missing' };
      item.click();
      return { ok: true };
    })()`,
  );
  if (started?.ok !== true) {
    console.error(`\n[FATAL] 无法启动剧本: ${JSON.stringify(started)}`);
    cleanup();
    process.exit(1);
  }

  /* ---- 等阶段 2 ---- */
  let phase2 = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(300);
    const s = await evaluate(cdp, READ_STATE);
    if (s && typeof s.phase === 'string' && s.phase.includes('阶段 2/4')) {
      /* 再等一轮让故障校验轮询完成 */
      await sleep(2600);
      phase2 = { at: Date.now() - runStart, ...(await evaluate(cdp, READ_STATE)) };
      break;
    }
  }

  if (phase2 === null) {
    bad('阶段 2 可观察', null, '超时未进入阶段 2');
  } else {
    console.log(`  → 阶段 2 @${(phase2.at / 1000).toFixed(1)}s  selected=${phase2.selected}  chaos=${phase2.chaos}`);

    /* §J-1：选中节点名下必须有异常 Pod */
    const selectedNode = (phase2.nodes ?? []).find((n) => n.id === phase2.selected) ?? null;
    const abnormalOnSelected = (phase2.abnormalPods ?? []).filter(
      (p) => p.nodeId === phase2.selected,
    );
    if (selectedNode !== null && abnormalOnSelected.length > 0) {
      ok(
        'J-1 阶段 2 镜头锁定的是真受灾机架',
        `${selectedNode.name} 名下 ${abnormalOnSelected.length} 个异常 Pod`,
      );
    } else {
      bad('J-1 阶段 2 镜头锁定的是真受灾机架', {
        selected: phase2.selected,
        selectedNode,
        abnormalOnSelected: abnormalOnSelected.length,
        allAbnormal: (phase2.abnormalPods ?? []).length,
      });
    }

    /* §J-1：告警非空 */
    if ((phase2.alerts ?? 0) > 0) {
      ok('J-1 阶段 2 activeAlerts 非空', `${phase2.alerts} 条`);
    } else {
      bad('J-1 阶段 2 activeAlerts 非空', { alerts: phase2.alerts ?? 0 });
    }
  }

  /*
   * ---- §J-1 附加：阶段 2 截图存档 + 亮度采样 ----
   *
   * 【为什么要在这里采】阶段 2 是"故障已注入、镜头已锁定"的画面峰值，
   * 既是最该存档的证据，也是黑屏最容易被发现的时点（大量告警光带应可见）。
   */
  const brightnessSamples = [];
  const shotPhase2 = await captureScreenshot(cdp, 'phase2-lock');
  const b2 = await recordBrightness(cdp, '阶段2', brightnessSamples);
  console.log(
    `  → 阶段2 截图=${shotPhase2 === null ? '(失败)' : shotPhase2} 亮度 avg=${b2.avg} lost=${b2.lost}`,
  );
  if (shotPhase2 !== null) ok('J-1 阶段 2 截图已存档', shotPhase2);
  else bad('J-1 阶段 2 截图已存档', { shotPhase2 });

  /* ---- 等阶段 3 + AI 流结束（卡片挂载） ---- */
  let phase3 = null;
  let cards = null;
  for (let i = 0; i < 220; i += 1) {
    await sleep(500);
    const s = await evaluate(cdp, READ_STATE);
    /*
     * 【判定要放宽】只盯字幕条 aria-label 会偶发错过窗口：
     * 阶段 4 一旦结束，aria 立刻变成"已完成"，而轮询间隔 500ms。
     * 因此只要满足任一条即认定已进入阶段 4：
     *   · 字幕条显示阶段 4/4；
     *   · 导演日志出现过"阶段 4/4"（不会被后续覆盖）；
     *   · healedPodIds 已非空（自愈只发生在阶段 4）。
     */
    const reachedPhase4 =
      s !== null &&
      s !== undefined &&
      ((typeof s.phase === 'string' && s.phase.includes('阶段 4/4')) ||
        (typeof s.lastDirectorLog === 'string' && s.lastDirectorLog.includes('阶段 4/4')) ||
        (s.healedIds ?? []).length > 0);
    if (reachedPhase4) {
      /*
       * 【有界轮询等动作卡水合】R08 把阶段 3→4 改成事件驱动后，进入阶段 4
       * 的那一刻卡片通常已挂载；但慢环境/冷启动下仍有几秒偏差。固定等 1.5 秒
       * 会偶发读到 actionCard=0（实测踩到），而随后 J-3 又能通过——说明只是
       * 采样太早。这里改为最多等 10 秒直到动作卡出现。
       */
      for (let k = 0; k < 20; k += 1) {
        cards = await evaluate(cdp, READ_CARDS);
        if ((cards?.actionCard ?? 0) >= 1) break;
        await sleep(500);
      }
      phase3 = { ...s };
      break;
    }
  }

  if (cards === null) {
    bad('阶段 3 卡片可观察', null, '超时未进入阶段 4');
  } else {
    console.log(
      `  → 卡片 metrics=${cards.metricsCard} rootCause=${cards.rootCauseCard} action=${cards.actionCard}`,
    );
    /* §J-2：三张卡片齐全 */
    if (cards.metricsCard === 1 && cards.rootCauseCard === 1 && cards.actionCard === 1) {
      ok('J-2 三张 GenUI 卡片齐全', '1/1/1');
    } else {
      bad('J-2 三张 GenUI 卡片齐全', cards);
    }

    const b3 = await recordBrightness(cdp, '阶段3', brightnessSamples);
    console.log(`  → 阶段3 亮度 avg=${b3.avg}`);

    /* §J-2：AI 正文中的宿主节点 == 选中节点对应节点名 */
    const selectedNodeName =
      (phase3?.nodes ?? []).find((n) => n.id === phase3?.selected)?.name ?? null;
    if (cards.hostNodeInProse !== null && selectedNodeName !== null) {
      /* 进入阶段 4 后 selected 已被清空，回落到阶段 2 的选中节点 */
      const compared = phase3?.selected ?? phase2?.selected ?? null;
      const comparedNode = (phase3?.nodes ?? []).find((n) => n.id === compared)?.name ?? null;
      if (comparedNode !== null && cards.hostNodeInProse === comparedNode) {
        ok('J-2 AI 正文宿主节点与 HUD 选中节点一致', comparedNode);
      } else {
        bad('J-2 AI 正文宿主节点与 HUD 选中节点一致', {
          proseNode: cards.hostNodeInProse,
          compared,
          comparedNode,
        });
      }
    } else {
      ok('J-2 AI 正文未出现宿主节点字样（无需比对）', `prose=${cards.hostNodeInProse}`);
    }
  }

  /* ---- 等阶段 4 完成 + 自然结束 ---- */
  let final = null;
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const s = await evaluate(cdp, READ_STATE);
    if (s && typeof s.lastDirectorLog === 'string' && s.lastDirectorLog.includes('剧本已完整跑完')) {
      await sleep(1200);
      final = await evaluate(cdp, READ_STATE);
      break;
    }
  }
  if (final === null) final = await evaluate(cdp, READ_STATE);
  /*
   * R64：MCP 回执是卡片 600ms 动画 + /api/mcp/execute 之后才写入终端的，
   * “剧本已完整跑完”可能先到。这里最多等 6s，让 J-3 读到真实的最终回执，
   * 而不是在异步写日志前取样导致误报 null。
   */
  for (let i = 0; i < 30; i += 1) {
    const action = final?.mcpAction;
    if (typeof action === 'string' && action.length > 0) break;
    await sleep(200);
    final = await evaluate(cdp, READ_STATE);
  }
  const finalCards = await evaluate(cdp, READ_CARDS);

  console.log(
    `  → 结束态 health=${final?.health} topBarHealth=${final?.topBarHealth} orbit=${final?.orbit} healed=${final?.healedIds?.length}`,
  );

  /* §J-3：healedPodIds 覆盖全部受害者 */
  const victimIds = (phase2?.abnormalPods ?? []).map((p) => p.id);
  const healedIds = final?.healedIds ?? [];
  const covered = victimIds.filter((id) => healedIds.includes(id));
  if (victimIds.length > 0 && covered.length === victimIds.length) {
    ok('J-3 自愈覆盖全部受害 Pod', `${covered.length}/${victimIds.length}`);
  } else {
    bad('J-3 自愈覆盖全部受害 Pod', {
      victimIds,
      healedIds,
      covered: covered.length,
      total: victimIds.length,
    });
  }

  /* §J-3：MCP 回执 actionType 与场景映射一致 */
  const expectedAction = EXPECTED_ACTION.POD_OOM_SWARM;
  if (final?.mcpAction === expectedAction) {
    ok('J-3 MCP 回执 actionType 与场景映射一致', final.mcpAction);
  } else {
    bad('J-3 MCP 回执 actionType 与场景映射一致', {
      actual: final?.mcpAction ?? null,
      expected: expectedAction,
    });
  }

  /* §J-3：动作卡状态 executed（不得"已完成"与"待执行"并存） */
  if (finalCards?.actionCardExecuted === true && finalCards?.actionCardPending !== true) {
    ok('J-3 动作卡终态为 executed（无 pending 并存）');
  } else {
    bad('J-3 动作卡终态为 executed（无 pending 并存）', finalCards);
  }

  /* §J-4：旁白健康分 == 顶栏健康分 */
  const narrationHealth = (() => {
    const text = final?.phase ?? '';
    const hit = text.match(/健康分\s*(\d+)/);
    return hit === null ? null : Number(hit[1]);
  })();
  if (narrationHealth === null) {
    ok('J-4 旁白未出现健康分数值（无需比对）', 'narration 不含"健康分 N"');
  } else if (narrationHealth === final?.topBarHealth) {
    ok('J-4 旁白健康分与顶栏一致', String(narrationHealth));
  } else {
    bad('J-4 旁白健康分与顶栏一致', {
      narrationHealth,
      topBarHealth: final?.topBarHealth,
    });
  }

  /* §J-4：orbit === true */
  if (final?.orbit === true) {
    ok('J-4 结束态环绕巡检开启');
  } else {
    bad('J-4 结束态环绕巡检开启', { orbit: final?.orbit ?? null });
  }

  /* ---- §J-4 附加：canvas 亮度探针（把 R01 黑屏回归并进来） ---- */
  const b4 = await recordBrightness(cdp, '结束态', brightnessSamples);
  const shotFinal = await captureScreenshot(cdp, 'finished');
  const dimSamples = brightnessSamples.filter(
    (s) => s.lost === true || s.error !== undefined || (s.avg ?? 0) <= BRIGHTNESS_THRESHOLD,
  );
  console.log(
    `  → 亮度样本 ${brightnessSamples.map((s) => `${s.label}=${s.avg}`).join(' ')} 阈值=${BRIGHTNESS_THRESHOLD} 截图=${shotFinal === null ? '(失败)' : shotFinal}`,
  );
  if (dimSamples.length === 0) {
    ok(
      'J-4 canvas 亮度探针全程高于阈值（R01 黑屏回归）',
      `${brightnessSamples.length} 次采样最小值=${Math.min(...brightnessSamples.map((s) => s.avg ?? 0)).toFixed(2)} > ${BRIGHTNESS_THRESHOLD}`,
    );
  } else {
    bad('J-4 canvas 亮度探针全程高于阈值（R01 黑屏回归）', {
      threshold: BRIGHTNESS_THRESHOLD,
      dimSamples,
      allSamples: brightnessSamples,
    });
  }
  if (shotFinal !== null) ok('J-4 结束态截图已存档', shotFinal);

  /* §J-4：零 console error */
  if (cdp.consoleErrors.length === 0 && cdp.pageErrors.length === 0) {
    ok('J-4 全流程零 console.error / 零未捕获异常');
  } else {
    bad('J-4 全流程零 console.error / 零未捕获异常', {
      consoleErrors: cdp.consoleErrors.slice(0, 5),
      pageErrors: cdp.pageErrors.slice(0, 5),
    });
  }

  /* ====================================================================== */
  /* 第二遍：连跑一致性                                                      */
  /* ====================================================================== */
  if (SKIP_REPEAT) {
    section('第二遍 · 连跑一致性（已跳过）');
  } else {
    section('第二遍 · 连跑一致性（R1 §J-5）');

    /* 结束后 5s 内启动第二遍，检验免疫窗口不会被"吞掉" */
    await sleep(5000);
    const firstHealedCount = healedIds.length;
    const firstVictimCount = victimIds.length;

    /*
     * 【基线】终端日志是跨轮累积的：第一遍若产生过 1 条 QUEUED，直接读总数
     * 会把它算到第二遍头上（实测踩到）。必须比增量。
     */
    const queuedBeforeSecond = (await evaluate(cdp, READ_STATE))?.queuedLogs ?? 0;

    const restarted = await evaluate(
      cdp,
      `(async () => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          (b.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
        if (!btn) return { error: 'start button missing' };
        btn.click();
        /* React 需要一帧才把菜单渲染出来：同步查询必然拿不到 */
        await new Promise((resolve) => setTimeout(resolve, 800));
        const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
          .find((b) => (b.textContent || '').includes(${JSON.stringify(SCRIPT_LABEL_PREFIX)}));
        if (!item) return { error: 'menu item missing' };
        item.click();
        return { ok: true };
      })()`,
    );

    if (restarted?.ok !== true) {
      bad('J-5 第二遍可启动', restarted);
    } else {
      let second = null;
      /* 第二遍的阶段 2 受害者集合：用于"两遍受害数一致"的对比 */
      let secondVictims = null;
      for (let i = 0; i < 280; i += 1) {
        await sleep(500);
        const s = await evaluate(cdp, READ_STATE);
        if (
          secondVictims === null &&
          s &&
          typeof s.phase === 'string' &&
          s.phase.includes('阶段 2/4')
        ) {
          /*
           * 【等到注入生效再采】阶段 2 刚进入的那一瞬异常 Pod 还没回传，
           * 立刻采样会得到空数组（实测踩到 secondVictims=[]）。
           * 与第一遍一致：等 2.6 秒再读。
           */
          await sleep(2600);
          const settled = await evaluate(cdp, READ_STATE);
          secondVictims = (settled?.abnormalPods ?? []).map((p) => p.id).sort();
        }
        if (s && typeof s.lastDirectorLog === 'string' && s.lastDirectorLog.includes('剧本已完整跑完')) {
          await sleep(1200);
          second = await evaluate(cdp, READ_STATE);
          break;
        }
      }

      if (second === null) {
        bad('J-5 第二遍跑完', null, '超时');
      } else {
        const secondHealed = (second.healedIds ?? []).length;
        console.log(
          `  → 第二遍 healed=${secondHealed} queuedLogs=${second.queuedLogs} (首遍 healed=${firstHealedCount} queued=?)`,
        );
        if (secondHealed >= firstHealedCount && secondHealed > 0) {
          ok('J-5 第二遍自愈数量不少于首遍', `${firstHealedCount} → ${secondHealed}`);
        } else {
          bad('J-5 第二遍自愈数量不少于首遍', {
            firstHealedCount,
            secondHealed,
            secondHealedIds: second.healedIds,
          });
        }
        const queuedDelta = (second.queuedLogs ?? 0) - queuedBeforeSecond;
        if (queuedDelta === 0) {
          ok(
            'J-5 第二遍无 QUEUED 免疫日志',
            `增量=0（基线 ${queuedBeforeSecond} → ${second.queuedLogs}）`,
          );
        } else {
          bad('J-5 第二遍无 QUEUED 免疫日志', {
            queuedBeforeSecond,
            queuedAfterSecond: second.queuedLogs,
            delta: queuedDelta,
          });
        }
        const firstVictims = victimIds.slice().sort();
        if (
          secondVictims !== null &&
          secondVictims.length === firstVictims.length &&
          firstVictims.length > 0
        ) {
          ok('J-5 连跑两遍受害者数量一致', `${firstVictims.length} → ${secondVictims.length}`);
        } else {
          bad('J-5 连跑两遍受害者数量一致', {
            firstVictims,
            secondVictims,
            firstCount: firstVictims.length,
            secondCount: secondVictims === null ? null : secondVictims.length,
          });
        }
      }
    }
  }

  /* ====================================================================== */
  /* 第三遍：pause / resume / stop                                           */
  /* ====================================================================== */
  section('收尾 · pause / resume / stop（R1 §J-6）');

  /* 先确保干净：点停止 */
  await evaluate(
    cdp,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').includes('停止剧本路演'));
      if (btn) btn.click();
      return true;
    })()`,
  );
  await sleep(1500);

  const beforeStopLogCount = (await evaluate(cdp, READ_STATE))?.directorLogs ?? 0;

  /* 停止后 5 秒内不得新增导演日志 */
  await sleep(5000);
  const afterStop = await evaluate(cdp, READ_STATE);
  const afterStopLogCount = afterStop?.directorLogs ?? 0;
  if (afterStopLogCount === beforeStopLogCount) {
    ok('J-6 stop 后 5 秒内无新增导演日志', `${beforeStopLogCount} → ${afterStopLogCount}`);
  } else {
    bad('J-6 stop 后 5 秒内无新增导演日志', {
      beforeStopLogCount,
      afterStopLogCount,
    });
  }

  if (afterStop?.phase !== null) {
    bad('J-6 stop 后字幕条消失', { phase: afterStop?.phase ?? null });
  } else {
    ok('J-6 stop 后字幕条消失');
  }

  /* pause / resume：阶段序号不得回退 */
  const startedPause = await evaluate(
    cdp,
    `(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
      if (!btn) return { error: 'start button missing' };
      btn.click();
      /* React 需要一帧才把菜单渲染出来：同步查询必然拿不到 */
      await new Promise((resolve) => setTimeout(resolve, 800));
      const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
        .find((b) => (b.textContent || '').includes(${JSON.stringify(SCRIPT_LABEL_PREFIX)}));
      if (!item) return { error: 'menu item missing' };
      item.click();
      return { ok: true };
    })()`,
  );

  if (startedPause?.ok === true) {
    await sleep(2500);
    const pausedPhase = (await evaluate(cdp, READ_STATE))?.phase ?? null;
    await evaluate(
      cdp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          (b.getAttribute('aria-label') || '').includes('暂停剧本路演'));
        if (btn) btn.click();
        return true;
      })()`,
    );
    await sleep(4000);
    const pausedState = await evaluate(cdp, READ_STATE);
    const stillPaused = pausedState?.phase ?? null;
    const pausedElapsedSec = pausedState?.barElapsedSec ?? null;

    if (pausedPhase === stillPaused) {
      ok('J-6 暂停期间阶段序号不推进', String(pausedPhase));
    } else {
      bad('J-6 暂停期间阶段序号不推进', { pausedPhase, stillPaused });
    }

    await evaluate(
      cdp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          (b.getAttribute('aria-label') || '').includes('继续剧本路演'));
        if (btn) btn.click();
        return true;
      })()`,
    );
    await sleep(2500);
    const resumedState = await evaluate(cdp, READ_STATE);
    const resumedPhase = resumedState?.phase ?? null;
    const resumedElapsedSec = resumedState?.barElapsedSec ?? null;

    /* 进度单调不回退：恢复后的已用时长不得小于暂停时 */
    if (pausedElapsedSec === null || resumedElapsedSec === null) {
      bad('J-6 恢复后进度单调不回退', { pausedElapsedSec, resumedElapsedSec });
    } else if (resumedElapsedSec + 0.05 >= pausedElapsedSec) {
      ok('J-6 恢复后进度单调不回退', `${pausedElapsedSec}s → ${resumedElapsedSec}s`);
    } else {
      bad('J-6 恢复后进度单调不回退', { pausedElapsedSec, resumedElapsedSec });
    }
    const phaseNumber = (p) => {
      const hit = typeof p === 'string' ? p.match(/阶段\s*(\d)\/4/) : null;
      return hit === null ? -1 : Number(hit[1]);
    };
    if (phaseNumber(resumedPhase) >= phaseNumber(stillPaused)) {
      ok('J-6 恢复后阶段单调不回退', `${phaseNumber(stillPaused)} → ${phaseNumber(resumedPhase)}`);
    } else {
      bad('J-6 恢复后阶段单调不回退', { stillPaused, resumedPhase });
    }
  } else {
    bad('J-6 pause/resume 可启动', startedPause);
  }

  /* 收尾停止 */
  await evaluate(
    cdp,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').includes('停止剧本路演'));
      if (btn) btn.click();
      return true;
    })()`,
  );
  await sleep(1200);

  /* ====================================================================== */
  /* 压力场景矩阵（--stress）                                                  */
  /* ====================================================================== */
  if (STRESS) {
    await runStressMatrix(cdp);
  }

  /* 测试装置自检：主动制造一条失败，用于验证归档链路 */
  if (INJECT_FAILURE) {
    bad('INJECTED 测试装置自检（KV_VERIFY_INJECT_FAILURE=1）', {
      note: '这条失败是刻意注入的，用于验证失败证据归档',
      at: new Date().toISOString(),
    });
  }

  /* ====================================================================== */
  /* 失败证据归档（追问 1）                                                    */
  /* ====================================================================== */
  let artifactDir = null;
  if (failCount > 0) {
    artifactDir = await saveFailureArtifacts(cdp);
  }

  /* ====================================================================== */
  /* 汇总                                                                    */
  /* ====================================================================== */
  cdp.close();
  cleanup();

  section('汇总');
  console.log(`  通过 ${passCount} · 失败 ${failCount}`);

  if (failCount > 0) {
    if (artifactDir !== null) {
      console.log(`\n  失败证据已归档: ${artifactDir}`);
      console.log('    · store-snapshot.json / console.log / last-frame.png / failures.json');
    }
    console.log('\n  失败明细（实际值）：');
    for (const item of failureDetails) {
      console.log(`    · ${item.name}`);
      console.log(`      ${JSON.stringify(item.actual, null, 2).split('\n').join('\n      ')}`);
    }
    process.exit(1);
  }

  console.log('\n  全部通过 ✓');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
