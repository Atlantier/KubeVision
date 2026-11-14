#!/usr/bin/env node
/**
 * KubeVision AI — R7 进阶：3D 相机运镜 / 阻尼 / Hover / Reduced-Motion 量化探针（scripts/probe-camera.mjs）
 *
 * 【覆盖条目 H1 ~ H7（R7 进阶全自动真机回归）】
 *   H1：Pod 焦点特写 Box3 屏占比 <= 25% × 28%、宿主 Rack >= 11/12 <Edges> 高亮与导光轨 >= 0.35、
 *       InspectHUD 空间路径面包屑（集群 / 机架 rack-X / 槽位 slot-Y）；
 *   H2：720ms 三段式飞行 & 820ms 球面插值速度-时间分布
 *       （0~25% ∈ [8%,22%]，50% >= 65%，末 15% >= 120ms）与 ViewportToolbar aria-busy + SVG 环；
 *   H3：dt 归一化阻尼在 60fps 与降帧（~30fps）下同角度收敛残差 < 8%；
 *   H4：零重排/零 React Commit Hover（getSceneCommitCount === 0、第 0 帧响应、90ms >= 90%）+
 *       pointerdown 1px 高亮描边 + pointerup 80ms 后再起飞；
 *   H5：双击复位边界判定（140ms/<6px 触发；400ms/>280ms 与 20px/>6px 不触发）；
 *   H6：SplitPaneResizer ±8px 触控隔离带按下拖动不触发 OrbitControls 误转；
 *   H7：prefers-reduced-motion 降敏切换（<= 200ms 线性切镜、autoRotate 禁用与原因标注、循环幅值 25%）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT_DIR = join(ROOT, '.verify-artifacts');
const REPORT_PATH = join(ARTIFACT_DIR, 'r7-camera-report.json');
const PORT = Number(readArg('--port') ?? 3027);
const CDP_PORT = Number(readArg('--cdp-port') ?? 9347);
const EXTERNAL_BASE = readArg('--base');
const GPU_MODE = readArg('--gpu') ?? (process.platform === 'win32' ? 'd3d11' : 'swiftshader');
const BASE_URL = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;
const TARGET_URL = `${BASE_URL}/?debug=camera`;

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

function readArg(flag) {
  const pref = `${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  return EDGE_PATHS.find((p) => existsSync(p)) ?? null;
}

function startNextServer() {
  const nextBin = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(PORT)], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  let logs = '';
  child.stdout?.on('data', (d) => {
    logs += d.toString();
  });
  child.stderr?.on('data', (d) => {
    logs += d.toString();
  });
  return { child, getLogs: () => logs };
}

function stopChild(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* ignore */
  }
}

async function waitForServer(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* waiting */
    }
    await sleep(300);
  }
  return false;
}

async function openCdpSession(browserPath, cdpPort, width = 1920, height = 1080, url = TARGET_URL, preloadScript = null) {
  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-r7-cam-${cdpPort}-${Date.now()}`);
  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--no-first-run',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      '--use-gl=angle',
      ...(GPU_MODE === 'd3d11'
        ? ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(1200),
      });
      if (res.ok) break;
    } catch {
      await sleep(250);
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
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (!text.includes('favicon.ico')) {
        pageErrors.push(text);
      }
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
    if (r.result?.exceptionDetails) {
      return { __err: r.result.exceptionDetails.text ?? JSON.stringify(r.result.exceptionDetails) };
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  if (preloadScript) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: preloadScript });
  }

  await send('Page.navigate', { url });

  for (let i = 0; i < 120; i += 1) {
    const ready = await ev(
      `Boolean(window.__KUBEVISION_CAMERA_DEBUG__ && document.querySelector('canvas') && window.__KUBEVISION_CAMERA_DEBUG__.getProbeAnchors()?.pod)`,
    );
    if (ready === true) break;
    await sleep(300);
  }

  for (let i = 0; i < 40; i += 1) {
    const animating = await ev(`window.__KUBEVISION_CAMERA_DEBUG__?.getState()?.isAnimating`);
    if (animating === false) break;
    await sleep(150);
  }
  await sleep(300);

  return {
    send,
    ev,
    pageErrors,
    close: () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      try {
        browser.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    },
  };
}

async function mouseMove(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
}

async function mouseClick(cdp, x, y, holdMs = 30, clickCount = 1) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
  if (holdMs > 0) await sleep(holdMs);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
}

async function mouseDrag(cdp, x0, y0, x1, y1, steps = 6, stepMs = 16) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none', clickCount: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
  for (let s = 1; s <= steps; s += 1) {
    const f = s / steps;
    await sleep(stepMs);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Number((x0 + (x1 - x0) * f).toFixed(1)),
      y: Number((y0 + (y1 - y0) * f).toFixed(1)),
      button: 'left',
      clickCount: 1,
      buttons: 1,
    });
  }
  await sleep(stepMs);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 0 });
}

function analyzeFlightCurve(trace) {
  if (!trace || !Array.isArray(trace.samples) || trace.samples.length < 4) {
    return { valid: false, reason: 'insufficient samples' };
  }
  const s0 = trace.startPos;
  const s1 = trace.endPos;
  const totalDist = Math.hypot(s1[0] - s0[0], s1[1] - s0[1], s1[2] - s0[2]);
  if (totalDist < 0.05) {
    return { valid: false, reason: 'trivial distance' };
  }
  const progressAt = (frac) => {
    let best = trace.samples[0];
    let bestDiff = Infinity;
    for (const pt of trace.samples) {
      const diff = Math.abs(pt.p - frac);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = pt;
      }
    }
    const covered = Math.hypot(best.x - s0[0], best.y - s0[1], best.z - s0[2]);
    return Number((covered / totalDist).toFixed(4));
  };
  let enteredTailMs = null;
  for (const pt of trace.samples) {
    const remaining = Math.hypot(s1[0] - pt.x, s1[1] - pt.y, s1[2] - pt.z) / totalDist;
    if (remaining <= 0.15 && enteredTailMs === null) {
      enteredTailMs = pt.tMs;
    }
  }
  const lastSample = trace.samples[trace.samples.length - 1];
  const endMs = trace.completedAtMs ?? lastSample.tMs;
  const m25 = progressAt(0.25);
  const m50 = progressAt(0.5);
  const last15Ms = enteredTailMs === null ? 0 : Number((endMs - enteredTailMs).toFixed(1));
  return {
    valid: true,
    kind: trace.kind,
    durationTargetMs: trace.durationTargetMs,
    completedAtMs: trace.completedAtMs,
    sampleCount: trace.samples.length,
    m25,
    m50,
    last15Ms,
    arrived: trace.arrived,
  };
}

async function waitFlightSettle(cdp, maxWaitMs = 2600) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const animating = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__?.getState()?.isAnimating`);
    if (animating === false) return true;
    await sleep(90);
  }
  return false;
}

async function waitBusyClear(cdp, selector, maxWaitMs = 2200) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const busy = await cdp.ev(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-busy') ?? null`);
    if (busy === null) return null;
    await sleep(80);
  }
  return 'true';
}

async function run() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('✗ 未找到 Edge/Chrome 浏览器，无法运行 R7 探针');
    process.exit(1);
  }

  let nextServer = null;
  if (!EXTERNAL_BASE) {
    const started = startNextServer();
    nextServer = started.child;
    const alive = await waitForServer(BASE_URL);
    if (!alive) {
      console.error('✗ next start 启动超时（请先确认已执行 pnpm build）');
      console.error(started.getLogs());
      stopChild(nextServer);
      process.exit(1);
    }
  }

  const cdp = await openCdpSession(browserPath, CDP_PORT, 1920, 1080, TARGET_URL);
  let cdpHalfFps = null;
  const checks = [];
  const pushCheck = (id, name, pass, metrics) => {
    checks.push({ id, name, pass, metrics });
    const icon = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${icon} [${id}] ${name} -> ${JSON.stringify(metrics)}`);
  };

  try {
    console.log('\n▸ R7 进阶探针：KubeVision 3D 运镜与交互真实帧级评测 (1920×1080)');

    const anchors = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getProbeAnchors()`);
    if (!anchors?.pod) {
      throw new Error('未能获取 3D 探针锚点');
    }

    /* ---------------- H4: Zero-commit hover & frame-0 + pointerdown/up 80ms ---------------- */
    await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.clearHoverTraces()`);
    await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.resetSceneCommitCount()`);
    await mouseMove(cdp, anchors.rack.x, anchors.rack.y);
    const frame0RackCursor = await cdp.ev(`getComputedStyle(document.querySelector('canvas')).cursor`);
    await sleep(140);
    await mouseMove(cdp, anchors.master.x, anchors.master.y);
    await sleep(140);
    await mouseMove(cdp, anchors.pod.x, anchors.pod.y);
    const frame0PodCursor = await cdp.ev(`getComputedStyle(document.querySelector('canvas')).cursor`);
    await sleep(140);
    const hoverTraces = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getHoverTraces()`);
    const hoverCommitCount = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getSceneCommitCount()`);
    await mouseMove(cdp, 24, 180);
    await sleep(80);

    const podHoverTrace = [...(hoverTraces ?? [])].reverse().find((h) => h.entityId === anchors.pod.id);
    const rackHoverTrace = [...(hoverTraces ?? [])].reverse().find((h) => h.entityId === anchors.rack.id);
    const hover90Value = (tr) => {
      if (!tr?.samples?.length) return 0;
      const hit = tr.samples.find((s) => s.dtMs >= 90) ?? tr.samples[tr.samples.length - 1];
      return hit.value;
    };
    const h4HoverPass =
      hoverCommitCount === 0 &&
      (frame0PodCursor === 'pointer' || frame0RackCursor === 'pointer') &&
      (podHoverTrace?.initialValue ?? 0) > 0 &&
      hover90Value(podHoverTrace) >= 0.9;

    /* Test pointerdown bright border + 80ms post-pointerup flight delay on Rack */
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: anchors.rack.x,
      y: anchors.rack.y,
      button: 'none',
      clickCount: 0,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: anchors.rack.x,
      y: anchors.rack.y,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    });
    await sleep(30);
    const rackPressedDiag = await cdp.ev(
      `window.__KUBEVISION_CAMERA_DEBUG__.getRackEdgesDiagnostic(${JSON.stringify(anchors.rack.id)})`,
    );
    const animatingWhileHeld = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().isAnimating`);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: anchors.rack.x,
      y: anchors.rack.y,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    });
    await sleep(25);
    const animatingAt25MsAfterUp = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().isAnimating`);
    await sleep(260);
    const animatingAfterDelay = await cdp.ev(
      `Boolean(window.__KUBEVISION_CAMERA_DEBUG__.getState().isAnimating || window.__KUBEVISION_CAMERA_DEBUG__.getLatestFlightTrace()?.kind === 'entity')`,
    );

    pushCheck(
      'H4',
      '零重排 Hover + 按下高光边 + 抬手 80ms 起飞',
      h4HoverPass &&
        rackPressedDiag?.pressedBorderActive === true &&
        animatingWhileHeld === false &&
        animatingAt25MsAfterUp === false &&
        animatingAfterDelay === true,
      {
        hoverCommitCount,
        frame0PodCursor,
        frame0RackCursor,
        podInitialHover: podHoverTrace?.initialValue ?? null,
        podHover90ms: hover90Value(podHoverTrace),
        rackHover90ms: hover90Value(rackHoverTrace),
        pressedBorderActive: rackPressedDiag?.pressedBorderActive ?? false,
        animatingWhileHeld,
        animatingAt25MsAfterUp,
        animatingAfterDelay,
      },
    );

    /* Wait rack flight to finish, then click Overview preset and settle before H1 */
    await waitFlightSettle(cdp);
    const ovInitPt = await cdp.ev(
      `(() => { const b = document.querySelector('button[aria-label*="全景鸟瞰"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
    );
    await mouseClick(cdp, ovInitPt.x, ovInitPt.y);
    await sleep(160);
    await waitFlightSettle(cdp);
    await sleep(200);

    /* ---------------- H1: Pod Framing + Host Rack Highlight + Breadcrumb ---------------- */
    const freshAnchors = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getProbeAnchors()`);
    await mouseClick(cdp, freshAnchors.pod.x, freshAnchors.pod.y);
    await sleep(220);
    await waitFlightSettle(cdp);
    await sleep(120);
    const podProj1920 = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getSelectedPodBoxProjection()`);
    const podRackDiag = await cdp.ev(
      `window.__KUBEVISION_CAMERA_DEBUG__.getRackEdgesDiagnostic(${JSON.stringify(freshAnchors.pod.rackId)})`,
    );
    const breadcrumbText = await cdp.ev(
      `document.querySelector('[data-testid="inspect-breadcrumb"]')?.textContent?.trim() ?? null`,
    );
    /* Verify desktop 1280×800 split-pane Pod framing bound as well */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(160);
    const podProj1280 = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getSelectedPodBoxProjection()`);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(120);

    const h1BoxOk = (p) => Boolean(p) && p.widthPct > 3 && p.widthPct <= 25 && p.heightPct > 3 && p.heightPct <= 28;
    const h1Pass =
      h1BoxOk(podProj1920) &&
      h1BoxOk(podProj1280) &&
      (podRackDiag?.edgeCount ?? 0) >= 11 &&
      (podRackDiag?.railEmissiveMax ?? 0) >= 0.35 &&
      typeof breadcrumbText === 'string' &&
      /集群\s*\/\s*机架\s*rack-\d+\s*\/\s*槽位\s*slot-\d+/.test(breadcrumbText);

    pushCheck('H1', 'Pod 特写 Box3 屏占比与宿主框架/面包屑', h1Pass, {
      podProj1920,
      podProj1280,
      rackEdgeCount: podRackDiag?.edgeCount ?? 0,
      railEmissiveMax: podRackDiag?.railEmissiveMax ?? 0,
      isHighlightedForPod: podRackDiag?.isHighlightedForPod ?? false,
      breadcrumbText,
    });

    const podFlightCurve = analyzeFlightCurve(await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getLatestFlightTrace()`));

    /* Return to overview cleanly via toolbar click */
    const ovBtnPt = await cdp.ev(
      `(() => { const b = document.querySelector('button[aria-label*="全景鸟瞰"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
    );
    await mouseClick(cdp, ovBtnPt.x, ovBtnPt.y);
    await sleep(180);
    await waitFlightSettle(cdp);
    await sleep(160);

    /* ---------------- H2: 820ms Spherical overview<->topdown + aria-busy + 速度曲线 ---------------- */
    const tdBtnPt = await cdp.ev(
      `(() => { const b = document.querySelector('button[aria-label*="俯视拓扑"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
    );
    await mouseClick(cdp, tdBtnPt.x, tdBtnPt.y);
    await sleep(120);
    const busyMidFlight = await cdp.ev(
      `document.querySelector('button[aria-label*="俯视拓扑"]')?.getAttribute('aria-busy') ?? null`,
    );
    const dashOffsetMidFlight = await cdp.ev(
      `document.querySelector('button[aria-label*="俯视拓扑"] svg circle:nth-child(2)')?.style?.strokeDashoffset ?? null`,
    );
    await waitFlightSettle(cdp);
    const topDownFlightCurve = analyzeFlightCurve(
      await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getLatestFlightTrace()`),
    );
    const busyAfterArrival = await waitBusyClear(cdp, 'button[aria-label*="俯视拓扑"]');

    const curveOk = (c) =>
      c?.valid === true && c.m25 >= 0.08 && c.m25 <= 0.22 && c.m50 >= 0.65 && c.last15Ms >= 120;
    const h2Pass =
      curveOk(podFlightCurve) &&
      curveOk(topDownFlightCurve) &&
      podFlightCurve.durationTargetMs <= 800 &&
      topDownFlightCurve.durationTargetMs === 820 &&
      busyMidFlight === 'true' &&
      busyAfterArrival === null;

    pushCheck('H2', '720ms/820ms 运镜曲线配额与按钮 aria-busy', h2Pass, {
      podFlightCurve,
      topDownFlightCurve,
      busyMidFlight,
      dashOffsetMidFlight,
      busyAfterArrival,
      linearComparison: {
        linearMenuMs: 180,
        kubeVisionEntityMs: podFlightCurve.durationTargetMs,
        kubeVisionPresetMs: topDownFlightCurve.durationTargetMs,
        midAccelerationRatio: Number((podFlightCurve.m50 / Math.max(0.001, podFlightCurve.m25)).toFixed(2)),
      },
    });

    /* Reset to overview for H3 / H5 / H6 */
    await mouseClick(cdp, ovBtnPt.x, ovBtnPt.y);
    await sleep(160);
    await waitFlightSettle(cdp);
    await sleep(150);

    /* ---------------- H5: Double-Click Reset Boundary (280ms / <6px) ---------------- */
    const dragRect = await cdp.ev(
      `(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left + r.width * 0.22, y: r.top + r.height * 0.35 }; })()`,
    );
    await mouseDrag(cdp, dragRect.x, dragRect.y, dragRect.x + 120, dragRect.y + 30);
    await sleep(550);

    const reset0 = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().lastDblClickResetCount`);
    /* Case A: 400ms interval -> no reset */
    await mouseClick(cdp, dragRect.x, dragRect.y, 12, 1);
    await sleep(400);
    await mouseClick(cdp, dragRect.x, dragRect.y, 12, 1);
    await sleep(360);
    const resetAfterSlow = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().lastDblClickResetCount`);

    /* Case B: 60ms interval, 20px shift -> no reset */
    await mouseClick(cdp, dragRect.x, dragRect.y, 12, 1);
    await sleep(60);
    await mouseClick(cdp, dragRect.x + 20, dragRect.y, 12, 1);
    await sleep(360);
    const resetAfterFar = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().lastDblClickResetCount`);

    /* Case C: ~60ms interval, 2px shift -> triggers reset */
    await mouseClick(cdp, dragRect.x, dragRect.y, 10, 1);
    await sleep(40);
    await mouseClick(cdp, dragRect.x + 2, dragRect.y + 1, 10, 2);
    await sleep(220);
    await waitFlightSettle(cdp);
    await sleep(160);
    const resetAfterValid = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().lastDblClickResetCount`);
    const posAfterReset = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().position`);
    const distToOverview = Math.hypot(
      posAfterReset[0] - 7.8,
      posAfterReset[1] - 14,
      posAfterReset[2] - 22,
    );

    pushCheck(
      'H5',
      '双击复位时间/位移边界 (280ms / 6px)',
      resetAfterSlow === reset0 && resetAfterFar === reset0 && resetAfterValid === reset0 + 1 && distToOverview < 1.2,
      { reset0, resetAfterSlow, resetAfterFar, resetAfterValid, distToOverview: Number(distToOverview.toFixed(3)) },
    );

    /* ---------------- H6: SplitPaneResizer ±8px Moat ---------------- */
    const moatPt = await cdp.ev(
      `(() => {
        const g = document.querySelector('[data-testid="split-resizer-guard"]');
        if (!g) return null;
        const r = g.getBoundingClientRect();
        return { x: Number((r.left + 2).toFixed(1)), y: Number((r.top + r.height * 0.5).toFixed(1)), width: r.width };
      })()`,
    );
    const posBeforeMoat = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().position`);
    if (moatPt) {
      await mouseDrag(cdp, moatPt.x, moatPt.y, moatPt.x - 24, moatPt.y + 10);
      await sleep(300);
    }
    const posAfterMoat = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().position`);
    const moatCamDelta = Math.hypot(
      posAfterMoat[0] - posBeforeMoat[0],
      posAfterMoat[1] - posBeforeMoat[1],
      posAfterMoat[2] - posBeforeMoat[2],
    );
    pushCheck('H6', 'SplitPaneResizer ±8px 保护区不触发误转', Boolean(moatPt) && moatPt.width >= 16 && moatCamDelta < 0.02, {
      moatPt,
      moatCamDelta: Number(moatCamDelta.toFixed(4)),
    });

    /* ---------------- H7: prefers-reduced-motion: reduce ---------------- */
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await sleep(240);
    const reducedState = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState()`);
    const patrolBtnInfo = await cdp.ev(
      `(() => {
        const b = document.querySelector('button[data-disabled-reason="reduced-motion"]');
        return b ? { disabled: b.disabled, reason: b.getAttribute('data-disabled-reason'), title: b.getAttribute('title') || b.getAttribute('aria-label') } : null;
      })()`,
    );
    const tdFreshPt = await cdp.ev(
      `(() => { const b = document.querySelector('button[aria-label*="俯视拓扑"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, hit: document.elementFromPoint(r.left + r.width/2, r.top + r.height/2)?.closest('button')?.getAttribute('aria-label') ?? null }; })()`,
    );
    await mouseClick(cdp, tdFreshPt.x, tdFreshPt.y);
    await sleep(450);
    await waitFlightSettle(cdp);
    const reducedFlight = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getLatestFlightTrace()`);

    pushCheck(
      'H7',
      'prefers-reduced-motion 降敏（<=200ms切镜 / 自动旋转禁用 / 25%幅值）',
      reducedState.reducedMotion === true &&
        reducedState.autoRotate === false &&
        reducedState.breathAmplitudeScale === 0.25 &&
        patrolBtnInfo?.disabled === true &&
        (reducedFlight?.durationTargetMs ?? 999) <= 200,
      {
        reducedState: {
          reducedMotion: reducedState.reducedMotion,
          autoRotate: reducedState.autoRotate,
          breathAmplitudeScale: reducedState.breathAmplitudeScale,
        },
        patrolBtnInfo,
        tdFreshHit: tdFreshPt.hit,
        reducedFlightTargetMs: reducedFlight?.durationTargetMs ?? null,
        reducedFlightCompletedMs: reducedFlight?.completedAtMs ?? null,
      },
    );

    /* Reset media & camera back to normal overview for H3 */
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await sleep(200);
    await mouseClick(cdp, ovBtnPt.x, ovBtnPt.y);
    await sleep(160);
    await waitFlightSettle(cdp);
    await sleep(250);

    /* ---------------- H3: dt-Normalized Damping Consistency (Native High-FPS vs 30fps) ---------------- */
    const nativeDamping = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().dampingFactor`);
    const posInit60 = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().position`);
    await mouseDrag(cdp, dragRect.x, dragRect.y, dragRect.x + 150, dragRect.y, 6, 30);
    await sleep(1100);
    const posSettled60 = await cdp.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().position`);
    const deltaAngle = (p0, p1) => {
      const a0 = Math.atan2(p0[0], p0[2]);
      const a1 = Math.atan2(p1[0], p1[2]);
      return Math.abs(a1 - a0);
    };
    const angleNative = deltaAngle(posInit60, posSettled60);

    /* Open isolated second Edge session throttling rAF to ~30fps (33ms cadence) */
    const lowFpsScript = `(() => {
      const origRaf = window.requestAnimationFrame.bind(window);
      let pending = [];
      let scheduled = false;
      let lastFire = 0;
      const pump = (ts) => {
        if (ts - lastFire < 31) {
          origRaf(pump);
          return;
        }
        lastFire = ts;
        scheduled = false;
        const batch = pending.splice(0, pending.length);
        for (const cb of batch) cb(ts);
      };
      window.requestAnimationFrame = (cb) => {
        pending.push(cb);
        if (!scheduled) {
          scheduled = true;
          origRaf(pump);
        }
        return pending.length;
      };
    })();`;
    cdpHalfFps = await openCdpSession(browserPath, CDP_PORT + 1, 1920, 1080, TARGET_URL, lowFpsScript);
    const posInit30 = await cdpHalfFps.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().position`);
    await mouseDrag(cdpHalfFps, dragRect.x, dragRect.y, dragRect.x + 150, dragRect.y, 6, 30);
    await sleep(1100);
    const posSettled30 = await cdpHalfFps.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().position`);
    const angle30 = deltaAngle(posInit30, posSettled30);
    const diffRatio = angleNative > 0.01 ? Math.abs(angle30 - angleNative) / angleNative : 1;
    const h3Damping = await cdpHalfFps.ev(`window.__KUBEVISION_CAMERA_DEBUG__.getState().dampingFactor`);

    pushCheck(
      'H3',
      'dt 归一化阻尼多帧率收口残差 (< 8%)',
      angleNative > 0.08 && diffRatio < 0.08 && h3Damping > nativeDamping * 1.4 && h3Damping > 0.065,
      {
        angleNativeRad: Number(angleNative.toFixed(4)),
        angle30Rad: Number(angle30.toFixed(4)),
        residualPct: Number((diffRatio * 100).toFixed(2)),
        nativeEffectiveDampingFactor: Number(nativeDamping.toFixed(5)),
        throttled30FpsEffectiveDampingFactor: Number(h3Damping.toFixed(5)),
      },
    );

    /* Verify runtime zero errors */
    const allErrors = [...cdp.pageErrors, ...cdpHalfFps.pageErrors];
    pushCheck('ERR', '运行时零 Console/Page Error', allErrors.length === 0, { count: allErrors.length, sample: allErrors.slice(0, 3) });

    if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });
    const allPass = checks.every((c) => c.pass);
    const report = {
      measuredAt: new Date().toISOString(),
      targetUrl: TARGET_URL,
      allPass,
      checks,
    };
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\n${allPass ? '✓ R7 进阶探针全部通过！' : '✗ R7 进阶探针存在未通过项'} 报告已写入 ${REPORT_PATH}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    cdp.close();
    cdpHalfFps?.close();
    stopChild(nextServer);
  }
}

run().catch((err) => {
  console.error('✗ probe-camera 执行异常:', err);
  process.exit(1);
});
