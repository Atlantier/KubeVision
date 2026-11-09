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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ========================================================================== */
/* 参数                                                                        */
/* ========================================================================== */

const SCENE_KEYS = ['overview', 'pod-closeup', 'oom', 'crystal', 'demo-phase2', 'demo-phase4'];

const baseUrl = readArg('--base') ?? 'http://127.0.0.1:3000';
const scene = readArg('--scene') ?? 'overview';
const sizeArg = readArg('--size') ?? '1920x1080';
const outDir = readArg('--out') ?? 'docs/summit/shots/v12-baseline';
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
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
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
  writeFileSync(filePath, Buffer.from(shot.result.data, 'base64'));

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
    viewport: { width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1 },
    metrics,
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
  console.log(`  Store     : ${JSON.stringify(metrics?.store ?? {})}`);
  console.log(`  glStats   : ${JSON.stringify(metrics?.glStats ?? null)}`);
  console.log(`  DPR       : ${String(metrics?.dpr)} (devicePixelRatio=${metrics?.devicePixelRatio})`);
  console.log(`  canvas    : ${JSON.stringify(metrics?.canvas ?? null)}`);
  console.log(`  renderer  : ${String(metrics?.renderer)}`);
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
