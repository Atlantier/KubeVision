#!/usr/bin/env node
/**
 * KubeVision AI — 确定性场景截图与渲染指标采集（scripts/shot.mjs）
 *
 * 【为什么需要一个"确定性"截图器】答辩材料里的每一张图都会被评委当作
 * "系统当时真的这样"的证据。手工截图无法复现：同样的机位、同样的故障态、
 * 同样的分辨率，换一次运行就可能差一个动画相位。本脚本把"场景"定义为
 * **一组 Store 状态 + 固定等待**，因此同一 commit 上重复执行得到可比对的图。
 *
 * 【与 verify.mjs 的关系】复用其 CDP harness 思路（headless Edge +
 * Runtime.evaluate + Page.captureScreenshot），零新增依赖。
 *
 * 【为何必须跑在 dev 构建】状态驱动依赖 `window.__KUBEVISION_STORE__` 与
 * `window.__KUBEVISION_TRANSIENT__`，二者按项目契约在**生产构建被 DCE 移除**。
 * 生产构建下脚本会明确报错退出，不会静默产出错误证据。
 *
 * 【用法】
 *   node scripts/shot.mjs --scene overview
 *   node scripts/shot.mjs --scene oom --size 1366x768 --out docs/summit/shots/v12-baseline
 *   node scripts/shot.mjs --scene demo-phase2 --base http://127.0.0.1:3000
 *
 * 【参数】
 *   --scene  overview | pod-closeup | oom | crystal | demo-phase2 | demo-phase4
 *   --size   1920x1080（默认） | 1366x768
 *   --out    输出目录（默认 docs/summit/shots/v12-baseline）
 *   --base   目标 URL（默认 http://127.0.0.1:3000）
 *   --tag    写入 meta.json 的场景标签（默认取 --out 的末级目录名）
 *
 * 【退出码】0 成功；1 失败（含无法读取 Store / WebGL 上下文丢失等硬失败）
 */

import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { basename, extname, join, resolve } from 'node:path';

/* ========================================================================== */
/* 参数                                                                        */
/* ========================================================================== */

const SCENE_KEYS = ['overview', 'pod-closeup', 'oom', 'crystal', 'demo-phase2', 'demo-phase4'];

const baseUrl = readArg('--base') ?? 'http://127.0.0.1:3000';
const scene = readArg('--scene') ?? 'overview';
const sizeArg = readArg('--size') ?? '1920x1080';
const outDir = readArg('--out') ?? 'docs/summit/shots/v12-baseline';
/**
 * 渲染后端：swiftshader（默认，软件光栅化，可复现）| d3d11（走真实独显）
 *
 * 【为什么要暴露这个开关】FPS 在软渲染下没有参考价值，但 draw calls 与
 * frameTime 有——它们是同一套指标在两种后端下的直接对照。把后端做成显式
 * 参数，A/B 才有可比性，而不是靠人记"上次用的是哪个 GL 参数"。
 */
const gpuMode = readArg('--gpu') ?? 'swiftshader';
if (gpuMode !== 'swiftshader' && gpuMode !== 'd3d11') {
  console.error(`[FATAL] --gpu 必须是 swiftshader | d3d11，收到 "${gpuMode}"`);
  process.exit(1);
}
const tag = readArg('--tag') ?? outDir.split(/[\\/]/).filter(Boolean).pop() ?? 'untagged';

if (!SCENE_KEYS.includes(scene)) {
  console.error(`[FATAL] --scene 必须是 ${SCENE_KEYS.join(' | ')}，收到 "${scene}"`);
  process.exit(1);
}

const sizeMatch = sizeArg.match(/^(\d+)x(\d+)$/);
if (sizeMatch === null) {
  console.error(`[FATAL] --size 形如 1920x1080，收到 "${sizeArg}"`);
  process.exit(1);
}
const viewportWidth = Number(sizeMatch[1]);
const viewportHeight = Number(sizeMatch[2]);

/** CDP 端口：与 verify.mjs(9333) / verify-demo(9334) 错开 */
const CDP_PORT = 9335;

/**
 * 截图前等待的 requestAnimationFrame 帧数。
 *
 * 【为何是 6 帧】需要覆盖：1 帧让 setState 引发的重渲染提交 →
 * 1~2 帧让 CameraRig 的 lerp 位移 →
 * 1~2 帧让 useFrame 里的材质/实例矩阵写入生效 →
 * 1 帧余量给浏览器合成器。少于 4 帧会拍到"上一状态"；
 * 多于 10 帧并无收益，只是拖慢采集。
 */
const POST_STATE_FRAMES = 6;

function readArg(flag) {
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/* 场景定义：Store 状态 + 等待预算                                              */
/* ========================================================================== */

/**
 * 场景脚本。
 *
 * 【设计原则】每个场景只做「设置 Store 状态」这一件事，不用鼠标模拟——
 * 鼠标事件会引入不可控的命中顺序，状态直设才是确定性的。
 *
 * `settleMs` 是状态设置后到截图前的等待预算：
 * 镜头飞行动画约 1.2s 收敛，故障数据要等 1Hz 遥测至少 2 个 tick 才稳定。
 */
const SCENES = {
  overview: {
    label: '全景稳态（三机架 + 控制平面 + 地面拓扑）',
    settleMs: 3200,
    apply: `(() => {
      const s = window.__KUBEVISION_STORE__.getState();
      s.setActiveChaos('NONE');
      s.selectEntity(null);
      s.setOrbitPatrolActive(false);
      s.setChaosModalOpen(false);
      s.setPerfHudOpen(false);
      return { chaos: 'NONE', selected: null };
    })()`,
  },
  'pod-closeup': {
    label: '刀片近景（worker-alpha 机架内 Pod 阵列）',
    settleMs: 4200,
    apply: `(() => {
      const s = window.__KUBEVISION_STORE__.getState();
      s.setActiveChaos('NONE');
      /* selectEntity 会同时写入实体类型，无需单独调用类型 setter */
      s.selectEntity('node-worker-alpha', 'node');
      s.setOrbitPatrolActive(false);
      return { selected: 'node-worker-alpha' };
    })()`,
  },
  oom: {
    label: 'OOM 故障态（受灾机架 worker-beta 特写 + 红色告警）',
    settleMs: 5200,
    apply: `(() => {
      const s = window.__KUBEVISION_STORE__.getState();
      s.setActiveChaos('POD_OOM_SWARM');
      s.setOrbitPatrolActive(false);
      /* 聚焦真实受灾机架：OOM 的 rackIndex 为 1 */
      const node = s.snapshotSummary.nodes.find((n) => n.rackIndex === 1);
      if (node !== undefined) s.selectEntity(node.id, 'node');
      return { chaos: 'POD_OOM_SWARM', selected: node === undefined ? null : node.id };
    })()`,
  },
  crystal: {
    /*
     * 【场景诚实性说明】`resolveCameraFocus` 对 master 类型走的是"全景鸟瞰"
     * 分支（cameraFocus.ts:144：MASTER 位于环形布局几何中心，鸟瞰即最佳机位），
     * 因此本场景**不是**晶体特写，而是"晶体选中高亮 + 鸟瞰机位"。
     * 标签如实写清，避免用一张鸟瞰图冒充特写。
     */
    label: '控制平面选中态（中央晶体高亮 + 环形布局鸟瞰）',
    settleMs: 4200,
    apply: `(() => {
      const s = window.__KUBEVISION_STORE__.getState();
      s.setActiveChaos('NONE');
      s.selectEntity('master-control-plane', 'master');
      s.setOrbitPatrolActive(false);
      return { selected: 'master-control-plane' };
    })()`,
  },
  'demo-phase2': {
    label: '路演阶段 2（故障注入 + 镜头锁定真受灾机架）',
    settleMs: 0,
    apply: null,
    demoWaitUntil: '阶段 2/4',
    demoWaitTimeoutMs: 20000,
  },
  'demo-phase4': {
    label: '路演阶段 4（MCP 闭环自愈 + 动作卡）',
    settleMs: 0,
    apply: null,
    demoWaitUntil: '阶段 4/4',
    demoWaitTimeoutMs: 40000,
  },
};

/* ========================================================================== */
/* CDP 会话                                                                    */
/* ========================================================================== */

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const consoleWarns = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? [])
        .map((a) => String(a.value ?? a.description ?? ''))
        .join(' ')
        .slice(0, 200);
      if (msg.params.type === 'error') consoleErrors.push(text);
      if (msg.params.type === 'warning') consoleWarns.push(text);
    }
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

  return { send, close: () => ws.close(), consoleErrors, consoleWarns };
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

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

async function main() {
  /*
   * 【--diff 分流】差异模式不需要启动截图流程，也不读 --scene。
   * 放在最前面，避免 --scene 校验先报错。
   */
  const diffRequest = readDiffArgs();
  if (diffRequest !== null) {
    await runDiff(diffRequest.baseA, diffRequest.baseB);
    return;
  }

  console.log('KubeVision AI — 确定性场景截图（shot.mjs）');
  console.log(`  场景: ${scene} — ${SCENES[scene].label}`);
  console.log(`  视口: ${viewportWidth}x${viewportHeight} @ DPR 1`);
  console.log(`  输出: ${outDir}`);

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
    console.error(`\n[FATAL] ${baseUrl} 不可达。请先运行 pnpm dev。`);
    process.exit(1);
  }

  /* ---- 启动 headless Edge ---- */
  const EDGE_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edgePath = EDGE_PATHS.find((p) => existsSync(p));
  if (edgePath === undefined) {
    console.error('\n[FATAL] 未找到 Edge 浏览器。');
    process.exit(1);
  }

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-shot-${Date.now()}`);
  const browser = spawn(
    edgePath,
    [
      '--headless=new',
      '--no-first-run',
      '--hide-scrollbars',
      /* ---- 渲染后端：两种模式互斥参数 ---- */
      ...(gpuMode === 'swiftshader'
        ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']),
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${viewportWidth},${viewportHeight}`,
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

  /* ---- 等 CDP ---- */
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
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: baseUrl });

  for (let i = 0; i < 300; i += 1) {
    if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
    await sleep(400);
  }
  await sleep(10000);

  const hasHooks = await evaluate(
    cdp,
    'typeof window.__KUBEVISION_STORE__ !== "undefined" && typeof window.__KUBEVISION_R3F__ !== "undefined"',
  );
  if (hasHooks !== true) {
    console.error(
      '\n[FATAL] 未检测到 __KUBEVISION_STORE__ / __KUBEVISION_R3F__。' +
        '\n        这两者按项目契约仅存在于 dev 构建，请用 `pnpm dev` 启动后重跑。',
    );
    cleanup();
    process.exit(1);
  }

  /* ====================================================================== */
  /* 驱动到目标状态                                                          */
  /* ====================================================================== */
  const def = SCENES[scene];

  if (def.apply !== null) {
    const applied = await evaluate(cdp, def.apply);
    console.log(`  已设置状态: ${JSON.stringify(applied)}`);
    if (applied !== null && typeof applied === 'object' && applied.__err !== undefined) {
      console.error(`[FATAL] 状态设置失败: ${applied.__err}`);
      cleanup();
      process.exit(1);
    }
    await sleep(def.settleMs);
  } else {
    /* ---- 路演场景：经真实 UI 启动，等字幕条到达目标阶段 ---- */
    const started = await evaluate(
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
    if (started?.ok !== true) {
      console.error(`[FATAL] 无法启动路演: ${JSON.stringify(started)}`);
      cleanup();
      process.exit(1);
    }
    console.log('  路演已启动，等待目标阶段…');

    let reached = false;
    for (let i = 0; i < def.demoWaitTimeoutMs / 300; i += 1) {
      await sleep(300);
      const aria = await evaluate(
        cdp,
        `(() => {
          const bar = document.querySelector('[aria-label^="剧本路演进行中"]');
          return bar === null ? null : bar.getAttribute('aria-label');
        })()`,
      );
      if (typeof aria === 'string' && aria.includes(def.demoWaitUntil)) {
        reached = true;
        console.log(`  已到达 ${def.demoWaitUntil}: ${aria}`);
        break;
      }
    }
    if (!reached) {
      console.error(`[FATAL] 未在 ${def.demoWaitTimeoutMs}ms 内到达 ${def.demoWaitUntil}`);
      cleanup();
      process.exit(1);
    }
    /* 给阶段内异步动作（故障校验 / 卡片挂载）留出时间 */
    await sleep(scene === 'demo-phase4' ? 6000 : 3000);
  }

  /* ---- 等待固定帧数后才截图（覆盖动画收敛） ---- */
  await evaluate(
    cdp,
    `(async () => {
      for (let i = 0; i < ${POST_STATE_FRAMES}; i += 1) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      return true;
    })()`,
  );

  /* ====================================================================== */
  /* 采集渲染指标                                                            */
  /* ====================================================================== */
  const metrics = await evaluate(
    cdp,
    `(() => {
      const out = {
        glStats: null,
        dpr: null,
        devicePixelRatio: window.devicePixelRatio,
        contextLost: null,
        renderer: null,
        canvas: null,
        store: {},
      };
      /* ---- 瞬态轨：Shift+P HUD 的同源数据 ---- */
      const t = window.__KUBEVISION_TRANSIENT__;
      if (t && t.glStats) {
        out.glStats = {
          fps: t.glStats.fps,
          frameTimeMs: t.glStats.frameTimeMs,
          drawCalls: t.glStats.drawCalls,
          triangles: t.glStats.triangles,
          sseLatencyMs: t.glStats.sseLatencyMs,
          workerStatus: t.glStats.workerStatus,
        };
      }
      /* ---- R3F 渲染器：DPR（= 自适应画质档位的可观测代理）与上下文状态 ---- */
      const r3f = window.__KUBEVISION_R3F__;
      if (r3f) {
        const st = r3f.get();
        try {
          out.dpr = st.gl.getPixelRatio();
        } catch (e) { out.dpr = null; }
        try {
          const ctx = st.gl.getContext();
          out.contextLost = typeof ctx.isContextLost === 'function' ? ctx.isContextLost() : null;
          const ext = ctx.getExtension('WEBGL_debug_renderer_info');
          out.renderer = ext === null ? 'unknown' : ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        } catch (e) { /* 上下文已丢失时读取会抛错，保持 null */ }
        out.canvas = { width: st.gl.domElement.width, height: st.gl.domElement.height };
      }
      /* ---- Store 事实快照（证明这张图对应的状态） ---- */
      const s = window.__KUBEVISION_STORE__.getState();
      out.store = {
        activeChaos: s.activeChaos,
        selectedEntityId: s.selectedEntityId,
        connectionMode: s.connectionMode,
        clusterHealthScore: s.snapshotSummary.clusterHealthScore,
        runningPods: s.snapshotSummary.pods.filter((p) => p.status === 'Running').length,
        totalPods: s.snapshotSummary.pods.length,
        activeAlerts: s.snapshotSummary.activeAlerts.length,
        isOrbitPatrolActive: s.isOrbitPatrolActive,
      };
      return out;
    })()`,
  );

  /* ====================================================================== */
  /* 截图                                                                    */
  /* ====================================================================== */
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (typeof shot.result?.data !== 'string') {
    console.error('[FATAL] 截图失败：未返回图像数据');
    cleanup();
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const fileName = `${scene}-${viewportWidth}x${viewportHeight}.png`;
  const filePath = join(outDir, fileName);
  const pngBuffer = Buffer.from(shot.result.data, 'base64');
  writeFileSync(filePath, pngBuffer);

  /* R30 · 追问 3：亮度直方图 + 过曝告警（>250 像素占比 >3% 即告警） */
  let luminance = null;
  try {
    luminance = computeLuminanceStats(pngBuffer);
  } catch (error) {
    console.warn('[WARN] 亮度直方图计算失败: ' + String(error));
  }
  const OVEREXPOSED_RATIO_LIMIT = 3;
  if (luminance !== null && luminance.overexposedRatio > OVEREXPOSED_RATIO_LIMIT) {
    console.warn(
      '[直方图] 过曝告警：亮度>250 像素占比 ' +
        luminance.overexposedRatio.toFixed(2) +
        '% > ' +
        OVEREXPOSED_RATIO_LIMIT +
        '%（回归门槛）',
    );
    process.exitCode = 2;
  }

  /* ---- 读 commit 与时间戳 ---- */
  const commit = readCommit();
  const timestamp = new Date().toISOString();

  const entry = {
    scene,
    sceneLabel: def.label,
    file: fileName,
    timestamp,
    commit,
    tag,
    gpuMode,
    viewport: { width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1 },
    metrics,
    luminance,
    consoleErrors: cdp.consoleErrors.length,
    consoleWarns: cdp.consoleWarns.length,
    consoleErrorSamples: cdp.consoleErrors.slice(0, 5),
    consoleWarnSamples: cdp.consoleWarns.slice(0, 5),
    note:
      'dpr 取自 renderer.getPixelRatio()，是该构建下唯一可观测的"自适应画质档位"代理；' +
      'glStats 的 fps/frameTime 来自 SwiftShader 软件光栅化，不代表真机 GPU 性能，' +
      'drawCalls/triangles 与硬件无关。',
  };

  /* ---- meta.json：同目录多次采集时按 scene 合并 ---- */
  const metaPath = join(outDir, 'meta.json');
  let meta = { baseline: { commit, tag, generatedAt: timestamp }, scenes: {} };
  if (existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        meta = {
          baseline: parsed.baseline ?? meta.baseline,
          scenes: parsed.scenes ?? {},
        };
      }
    } catch {
      /* 旧 meta 损坏则重写，不阻断采集 */
    }
  }
  meta.baseline = { commit, tag, generatedAt: timestamp };
  meta.scenes[`${scene}@${viewportWidth}x${viewportHeight}`] = entry;
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  /* ====================================================================== */
  /* 输出摘要                                                                */
  /* ====================================================================== */
  console.log('\n' + '='.repeat(78));
  console.log('采集完成');
  console.log('='.repeat(78));
  console.log(`  截图      : ${filePath}`);
  console.log(`  元数据    : ${metaPath}`);
  console.log(`  commit    : ${commit}`);
  console.log(`  gpuMode   : ${gpuMode}`);
  console.log(`  Store     : ${JSON.stringify(metrics?.store ?? {})}`);
  console.log(`  glStats   : ${JSON.stringify(metrics?.glStats ?? null)}`);
  console.log(`  DPR       : ${String(metrics?.dpr)} (devicePixelRatio=${metrics?.devicePixelRatio})`);
  console.log(`  canvas    : ${JSON.stringify(metrics?.canvas ?? null)}`);
  console.log(`  renderer  : ${String(metrics?.renderer)}`);
  if (luminance !== null) {
    const bar = luminance.bins
      .map((count, index) => {
        const ratio = (count / luminance.totalPixels) * 100;
        const level = ratio > 12 ? '#' : ratio > 4 ? '+' : ratio > 1 ? '.' : ' ';
        return level;
      })
      .join('');
    console.log(
      `  亮度直方图: [${bar}] 均值=${luminance.mean.toFixed(1)} 过曝=${luminance.overexposedRatio.toFixed(2)}%`,
    );
  }
  console.log(`  ctxLost   : ${String(metrics?.contextLost)}`);
  console.log(`  console   : error=${cdp.consoleErrors.length} warn=${cdp.consoleWarns.length}`);

  cdp.close();
  cleanup();

  /* ---- 硬失败判定 ---- */
  const hardFailures = [];
  if (metrics?.contextLost === true) hardFailures.push('WebGL 上下文已丢失');
  if (metrics?.glStats === null) hardFailures.push('未能读取 glStats（瞬态轨未就绪）');

  if (hardFailures.length > 0) {
    console.error(`\n[FAIL] ${hardFailures.join('；')}`);
    process.exit(1);
  }
  console.log('\n  OK');
  process.exit(0);
}

/* ========================================================================== */
/* 差异模式（--diff tagA tagB）：零依赖 PNG 像素差                              */
/* ========================================================================== */

/**
 * 解析 `--diff A B` 或 `--diff=A,B`。
 *
 * 【为什么单独解析】`--diff` 需要**两个**位置参数，常规 `readArg`
 * 只能取一个。放在 `main()` 最前面分流，也避开 `--scene` 的合法性校验
 * （差异模式不需要场景）。
 *
 * @returns {{baseA: string, baseB: string} | null}
 */
function readDiffArgs() {
  const inline = process.argv.find((a) => a.startsWith('--diff='));
  if (inline !== undefined) {
    const parts = inline
      .slice('--diff='.length)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length !== 2) {
      console.error('[FATAL] --diff= 需要逗号分隔的两个 tag：--diff=A,B');
      process.exit(1);
    }
    return { baseA: parts[0], baseB: parts[1] };
  }
  const idx = process.argv.indexOf('--diff');
  if (idx < 0) return null;
  const baseA = process.argv[idx + 1];
  const baseB = process.argv[idx + 2];
  if (baseA === undefined || baseB === undefined || baseA.startsWith('--') || baseB.startsWith('--')) {
    console.error('[FATAL] --diff 需要两个参数：--diff <tagA> <tagB>');
    process.exit(1);
  }
  return { baseA, baseB };
}

/**
 * 把 tag 解析成截图目录。
 *
 * 【解析顺序】含路径分隔符 → 当路径；已是存在的目录 → 当路径；
 * 否则按约定拼成 `docs/summit/shots/<tag>`。
 *
 * @param {string} tag tag 或路径
 * @returns {string} 绝对目录路径
 */
function resolveShotDir(tag) {
  if (tag.includes('/') || tag.includes('\\')) return resolve(tag);
  const direct = resolve(tag);
  if (existsSync(direct) && statSync(direct).isDirectory()) return direct;
  return resolve(join('docs/summit/shots', tag));
}

/**
 * 收集目录下所有 PNG，返回 `Map<场景键, 绝对路径>`。
 *
 * 【键的取法】用去掉扩展名的文件名（如 `overview-1920x1080`）。
 * 两个 tag 目录里同名文件即视为同一场景的 A/B 两张，按此配对。
 *
 * @param {string} dir 目录
 * @returns {Map<string, string>}
 */
function collectPngs(dir) {
  const map = new Map();
  for (const name of readdirSync(dir)) {
    if (extname(name).toLowerCase() !== '.png') continue;
    map.set(basename(name, extname(name)), join(dir, name));
  }
  return map;
}

/**
 * 在页面内执行的像素比对函数（注入后由 Node 侧调用）。
 *
 * 【为什么把解码放到浏览器里做】PNG 解码在 Node 侧需要 zlib + 滤镜还原
 * （PAETH/Sub/Up 等），手写极易出错；而浏览器原生 `createImageBitmap`
 * 就是最权威的解码器。这样**零依赖**且结果可信——正好满足"不引依赖"的约束。
 *
 * 【差异如何度量】
 * 单像素取 RGBA 四通道绝对差之和 `d = |ΔR|+|ΔG|+|ΔB|+|ΔA|`，`d > 阈值`
 * 记为"有差异"。四通道都要算：一边有内容一边透明（alpha 从 255→0）
 * 若只看 RGB 会被判成"没变化"。
 *
 * 【为什么不用 SSIM】SSIM 需要滑窗统计与多次卷积，实现复杂且对
 * "截图动画相位不同"这种大量小幅差异反而不如逐像素直观。本工具的用途是
 * 找"哪里变了"，逐像素 + 热区网格更直接。
 *
 * @returns {Promise<object>} 差异结果
 */
const DIFF_FN_SCRIPT = `
(() => {
  window.__KV_DIFF__ = async (urlA, urlB, gridN, pixelThreshold) => {
    const load = async (u) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error('fetch failed ' + res.status + ' for ' + u);
      const blob = await res.blob();
      return await createImageBitmap(blob);
    };
    const imgA = await load(urlA);
    const imgB = await load(urlB);

    const W = Math.max(imgA.width, imgB.width);
    const H = Math.max(imgA.height, imgB.height);

    const toData = (img) => {
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      /* 先清成全透明：尺寸不一致时缺失区域应体现为 alpha 差异，而非黑块 */
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, W, H);
    };

    const dataA = toData(imgA);
    const dataB = toData(imgB);
    const A = dataA.data;
    const B = dataB.data;

    const total = W * H;
    let diffPixels = 0;
    let sumDelta = 0;
    let minX = W;
    let minY = H;
    let maxX = -1;
    let maxY = -1;

    const cells = new Array(gridN * gridN).fill(0);
    /* 每格累计差值和，用于"变化最剧烈"的排序 */
    const cellDelta = new Array(gridN * gridN).fill(0);

    for (let y = 0; y < H; y += 1) {
      const rowBase = y * W * 4;
      const gy = Math.min(gridN - 1, Math.floor((y * gridN) / H));
      for (let x = 0; x < W; x += 1) {
        const i = rowBase + x * 4;
        const d =
          Math.abs(A[i] - B[i]) +
          Math.abs(A[i + 1] - B[i + 1]) +
          Math.abs(A[i + 2] - B[i + 2]) +
          Math.abs(A[i + 3] - B[i + 3]);
        if (d > pixelThreshold) {
          diffPixels += 1;
          sumDelta += d;
          const gx = Math.min(gridN - 1, Math.floor((x * gridN) / W));
          cells[gy * gridN + gx] += 1;
          cellDelta[gy * gridN + gx] += d;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const hotZones = [];
    for (let idx = 0; idx < cells.length; idx += 1) {
      if (cells[idx] === 0) continue;
      const gx = idx % gridN;
      const gy = Math.floor(idx / gridN);
      hotZones.push({
        gx,
        gy,
        diffCount: cells[idx],
        deltaSum: cellDelta[idx],
        x: Math.round((gx * W) / gridN),
        y: Math.round((gy * H) / gridN),
        w: Math.round(W / gridN),
        h: Math.round(H / gridN),
      });
    }
    /* 先按差像素数排，数量相同再按差值强度排 */
    hotZones.sort((p, q) => q.diffCount - p.diffCount || q.deltaSum - p.deltaSum);

    return {
      width: W,
      height: H,
      sizeA: { w: imgA.width, h: imgA.height },
      sizeB: { w: imgB.width, h: imgB.height },
      sizeMismatch: imgA.width !== imgB.width || imgA.height !== imgB.height,
      totalPixels: total,
      diffPixels,
      diffPercent: total === 0 ? 0 : (diffPixels / total) * 100,
      meanDelta: diffPixels === 0 ? 0 : sumDelta / diffPixels,
      bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      hotZoneCount: hotZones.length,
      hotZones: hotZones.slice(0, 12),
      gridN,
      pixelThreshold,
    };
  };
  return { ok: true };
})()
`;

/* ========================================================================== */
/* 亮度直方图（R30 · 追问 3：画面过曝回归门槛）                                    */
/* ========================================================================== */

/**
 * decodePngRgba —— 解码 8-bit RGB/RGBA 非隔行 PNG。
 *
 * 【为什么自己解码】零新增依赖；截图是 Page.captureScreenshot 输出的标准 PNG，
 * 只用 node:zlib inflate + 5 种 filter 反解即可，不需要图像库。
 *
 * @param buffer PNG 字节
 * @returns 宽高与 RGBA 像素
 */
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
  if (channels === 0) throw new Error('unsupported PNG color type: ' + colorType);
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

/**
 * computeLuminanceStats —— 计算亮度直方图与过曝比例。
 *
 * 【口径】亮度 L = 0.2126R + 0.7152G + 0.0722B（Rec.709，sRGB 未线性化；
 * 作为"感知过曝"门槛足够，且与截图字节一一对应、可复现）。
 * 过曝定义：L > 250（不是 255，给抗锯齿/压缩留 5 级余量）。
 *
 * @param buffer 截图 PNG 字节
 * @returns 直方图、均值、分位与过曝比例
 */
function computeLuminanceStats(buffer) {
  const { pixels } = decodePngRgba(buffer);
  const bins = new Array(16).fill(0);
  let sum = 0;
  let overexposed = 0;
  const total = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    sum += luma;
    if (luma > 250) overexposed += 1;
    bins[Math.min(15, Math.floor(luma / 16))] += 1;
  }
  return {
    bins,
    mean: sum / total,
    overexposed,
    overexposedRatio: (overexposed / total) * 100,
    totalPixels: total,
  };
}

/* ---- 差异模式的独立浏览器启动（2D canvas 解码不需要 WebGL） ---- */
const DIFF_CDP_PORT = 9337;

/**
 * 差异模式主流程。
 *
 * 【为何起本地 HTTP 服务】页面要 `fetch` 两张 PNG。若直接把 1MB 图片
 * base64 塞进 `Runtime.evaluate` 的表达式字符串，单条消息会达到数 MB，
 * 容易触发 CDP 消息上限并让调试端口卡顿。起一个临时 HTTP 服务让页面自己
 * 去取，既避开体积问题，也顺带通过 `Access-Control-Allow-Origin: *`
 * 解决跨源读像素的污染问题（被污染的画布 `getImageData` 会抛 SecurityError）。
 *
 * @param {string} baseA 基线 tag
 * @param {string} baseB 对比 tag
 */
async function runDiff(baseA, baseB) {
  const dirA = resolveShotDir(baseA);
  const dirB = resolveShotDir(baseB);

  console.log('KubeVision AI — 截图 A/B 差异（shot.mjs --diff）');
  console.log(`  A(${baseA}): ${dirA}`);
  console.log(`  B(${baseB}): ${dirB}`);

  if (!existsSync(dirA)) {
    console.error(`[FATAL] A 目录不存在: ${dirA}`);
    process.exit(1);
  }
  if (!existsSync(dirB)) {
    console.error(`[FATAL] B 目录不存在: ${dirB}`);
    process.exit(1);
  }

  const filesA = collectPngs(dirA);
  const filesB = collectPngs(dirB);
  const keys = [...filesA.keys()].filter((k) => filesB.has(k)).sort();

  if (keys.length === 0) {
    console.error('[FATAL] 两个目录没有同名 PNG，无法配对。');
    console.error(`  A 含: ${[...filesA.keys()].join(', ') || '(空)'}`);
    console.error(`  B 含: ${[...filesB.keys()].join(', ') || '(空)'}`);
    process.exit(1);
  }
  console.log(`  配对成功 ${keys.length} 组: ${keys.join(', ')}`);

  /* ---- 临时 HTTP 服务 ---- */
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const key = url.searchParams.get('k');
      const side = url.searchParams.get('s');
      const map = side === 'a' ? filesA : side === 'b' ? filesB : null;
      const filePath = map === null || key === null ? undefined : map.get(key);
      if (filePath === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      const buf = readFileSync(filePath);
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(buf.length),
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end(buf);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`  临时服务: http://127.0.0.1:${port}`);

  const closeServer = () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };
  process.on('exit', closeServer);

  /* ---- 启动 headless Edge ---- */
  const EDGE_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edgePath = EDGE_PATHS.find((p) => existsSync(p));
  if (edgePath === undefined) {
    console.error('[FATAL] 未找到 Edge 浏览器。');
    closeServer();
    process.exit(1);
  }

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-diff-${Date.now()}`);
  const browser = spawn(
    edgePath,
    [
      '--headless=new',
      '--no-first-run',
      '--hide-scrollbars',
      `--remote-debugging-port=${DIFF_CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { detached: false, stdio: 'ignore' },
  );
  const cleanupBrowser = () => {
    try {
      browser.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanupBrowser);

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${DIFF_CDP_PORT}/json/list`, {
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
    cleanupBrowser();
    closeServer();
    process.exit(1);
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  /* 页面需要同源上下文才能 fetch 本地服务：先导航到该服务的一个稳定 URL */
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?k=&s=` });
  await sleep(1500);

  const injected = await evaluate(cdp, DIFF_FN_SCRIPT);
  if (injected?.ok !== true) {
    console.error(`[FATAL] 差异函数注入失败: ${JSON.stringify(injected)}`);
    cleanupBrowser();
    closeServer();
    process.exit(1);
  }

  /* ---- 逐组比对 ---- */
  const GRID_N = 16;
  const PIXEL_THRESHOLD = 30; /* RGBA 差值和；30 ≈ 每通道平均差 7.5，可滤掉压缩噪声 */
  const results = [];

  for (const key of keys) {
    const urlA = `http://127.0.0.1:${port}/?k=${encodeURIComponent(key)}&s=a`;
    const urlB = `http://127.0.0.1:${port}/?k=${encodeURIComponent(key)}&s=b`;
    const res = await evaluate(
      cdp,
      `window.__KV_DIFF__(${JSON.stringify(urlA)}, ${JSON.stringify(urlB)}, ${GRID_N}, ${PIXEL_THRESHOLD})`,
    );
    if (res === null || res === undefined || res.__err !== undefined) {
      console.error(`  [跳过] ${key}: ${JSON.stringify(res)}`);
      continue;
    }
    results.push({ key, ...res });
  }

  cdp.close();
  cleanupBrowser();
  closeServer();

  if (results.length === 0) {
    console.error('[FATAL] 没有任何一组比对成功。');
    process.exit(1);
  }

  /* ---- 输出 ---- */
  console.log('');
  console.log('='.repeat(78));
  console.log('差异汇总');
  console.log('='.repeat(78));
  console.log('  场景                       差异像素     差异%    均值Δ   边界框');
  console.log('  ' + '-'.repeat(74));
  for (const r of results) {
    const name = r.key.padEnd(24).slice(0, 24);
    const px = String(r.diffPixels).padStart(9);
    const pct = `${r.diffPercent.toFixed(3)}%`.padStart(8);
    const mean = r.meanDelta.toFixed(1).padStart(7);
    const bbox = r.bbox === null ? '—' : `${r.bbox.x},${r.bbox.y} ${r.bbox.w}x${r.bbox.h}`;
    console.log(`  ${name} ${px} ${pct} ${mean}  ${bbox}`);
  }

  console.log('');
  console.log('  热区（Top 6，按差异像素数排序）');
  for (const r of results) {
    console.log(`  [${r.key}]  ${r.hotZoneCount} 个热格 / ${r.gridN}x${r.gridN}`);
    for (const z of r.hotZones.slice(0, 6)) {
      console.log(
        `    格(${z.gx},${z.gy}) 像素区 x=${z.x} y=${z.y} ${z.w}x${z.h}  差异像素=${z.diffCount}  Δ和=${z.deltaSum}`,
      );
    }
    if (r.sizeMismatch) {
      console.log(`    ! 尺寸不一致: A=${r.sizeA.w}x${r.sizeA.h} B=${r.sizeB.w}x${r.sizeB.h}（按较大画布比对，缺失区记为差异）`);
    }
  }

  /* ---- 落盘 ---- */
  const reportPath =
    readArg('--report') ??
    join('docs/summit/shots', `diff-${sanitizeTag(baseA)}-vs-${sanitizeTag(baseB)}.json`);
  const mdPathDiff =
    readArg('--md') ??
    join('docs/summit/shots', `diff-${sanitizeTag(baseA)}-vs-${sanitizeTag(baseB)}.md`);

  const payload = {
    generatedAt: new Date().toISOString(),
    commit: readCommit(),
    baseA,
    baseB,
    dirA,
    dirB,
    gridN: GRID_N,
    pixelThreshold: PIXEL_THRESHOLD,
    results,
    caveat:
      '同一场景两次截图的动画相位（彗星位置、雷达扫描角、粒子闪烁）天然不同，' +
      '因此 diffPercent 几乎不会为 0。本工具的用途是定位"结构变化"发生在哪，' +
      '判断时应看热区坐标是否落在预期区域，而不是只看百分比大小。',
  };

  try {
    mkdirSync(dirnameOf(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`\n[报告] ${reportPath}`);
  } catch (err) {
    console.error(`[WARN] JSON 写入失败: ${String(err)}`);
  }

  const md = renderDiffMarkdown(payload);
  try {
    mkdirSync(dirnameOf(mdPathDiff), { recursive: true });
    writeFileSync(mdPathDiff, md, 'utf8');
    console.log(`[报告] ${mdPathDiff}`);
  } catch (err) {
    console.error(`[WARN] Markdown 写入失败: ${String(err)}`);
  }

  process.exit(0);
}

/** 取路径的目录部分（不引 path.dirname 之外的逻辑，保持可读） */
function dirnameOf(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx < 0 ? '.' : p.slice(0, idx);
}

/** 把 tag 清洗成安全文件名片段 */
function sanitizeTag(tag) {
  return tag.replace(/[\\/:\s]+/g, '_');
}

/**
 * 生成差异 markdown 报告。
 *
 * @param {object} payload 差异结果
 * @returns {string} markdown
 */
function renderDiffMarkdown(payload) {
  const rows = payload.results
    .map((r) => {
      const bbox = r.bbox === null ? '—' : `(${r.bbox.x}, ${r.bbox.y}) ${r.bbox.w}×${r.bbox.h}`;
      const top = r.hotZones[0];
      const hottest = top === undefined ? '—' : `(${top.x}, ${top.y}) ${top.w}×${top.h}`;
      return `| \`${r.key}\` | ${r.totalPixels} | ${r.diffPixels} | ${r.diffPercent.toFixed(3)}% | ${r.meanDelta.toFixed(1)} | ${bbox} | ${hottest} |`;
    })
    .join('\n');

  const detail = payload.results
    .map((r) => {
      const cells = r.hotZones
        .slice(0, 8)
        .map(
          (z) =>
            `| ${z.gx},${z.gy} | ${z.x} | ${z.y} | ${z.w} | ${z.h} | ${z.diffCount} | ${z.deltaSum} |`,
        )
        .join('\n');
      return `### \`${r.key}\`（差异 ${r.diffPercent.toFixed(3)}%，${r.diffPixels} px）\n\n| 格 | x | y | w | h | 差异像素 | Δ和 |\n|---|---|---|---|---|---|---|\n${cells}`;
    })
    .join('\n\n');

  return `# 截图 A/B 差异报告

> 由 \`scripts/shot.mjs --diff\` 自动生成，**请勿手改**。

## 元信息

| 项 | 值 |
|---|---|
| A | \`${payload.baseA}\` → \`${payload.dirA}\` |
| B | \`${payload.baseB}\` → \`${payload.dirB}\` |
| commit | \`${payload.commit}\` |
| 生成时刻 | ${payload.generatedAt} |
| 网格 | ${payload.gridN}×${payload.gridN} |
| 像素阈值 | RGBA 差值和 > ${payload.pixelThreshold} |

## 汇总

| 场景 | 总像素 | 差异像素 | 差异% | 均值Δ | 差异边界框 | 最热格 |
|---|---|---|---|---|---|---|
${rows}

## 热区明细（Top 8）

${detail}

## 判读须知

${payload.caveat}
`;
}

/**
 * 读取当前 commit（短哈希）。非 git 环境下返回 'unknown'。
 *
 * @returns {string} 短 commit
 */
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
