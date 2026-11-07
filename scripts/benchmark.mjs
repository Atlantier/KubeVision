/**
 * 性能数据采集脚本（scripts/benchmark.mjs）
 *
 * 【用途】采集可用于答辩/文档的真实性能数字，输出 Markdown 表格与 JSON。
 *
 * 【采集项】
 * 1. 渲染性能：FPS / Frame Time / Draw Calls / Triangles（多轮采样取统计值）
 * 2. InstancedMesh 批渲染效果：对比"逐 Pod 渲染"的等效 draw call 数
 * 3. 端侧推理性能：WebGPU vs WASM 的单条日志分类延迟
 * 4. RAG 检索延迟
 * 5. 脱敏器吞吐
 * 6. 包体积
 *
 * 【诚实性契约】所有数字均为实测，不做"理论值"填充。
 * 若某项在当前环境测不到（如无 WebGPU），如实标注 skip 而非编造。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const OUT_DIR = join(ROOT, 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/* 工具                                                                       */
/* ========================================================================== */

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: ROOT,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
  });
}

async function waitForServer(url, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch { /* 等待 */ }
    await sleep(1500);
  }
  return false;
}

/** 统计工具：均值 / 中位数 / P95 / 最小值 / 最大值 */
function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    count: sorted.length,
    mean: +(sum / sorted.length).toFixed(2),
    median: +pick(0.5).toFixed(2),
    p95: +pick(0.95).toFixed(2),
    min: +sorted[0].toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
  };
}

/* ========================================================================== */
/* 采集                                                                       */
/* ========================================================================== */

const report = {
  generatedAt: new Date().toISOString(),
  environment: {},
  rendering: {},
  batching: {},
  edgeInference: {},
  rag: {},
  sanitizer: {},
  bundle: {},
  notes: [],
};

async function collectEnvironment() {
  console.log('\x1b[36m▸ 采集运行环境\x1b[0m');
  /**
   * 【为何不 spawn】先前用 `spawn(node, ['-e', script])` 采集，
   * 在 Windows + shell:true 下长参数含引号/空格会被 shell 截断，
   * 导致输出为空（OS: n/a）。改为在**本进程内**直接读 os 模块，
   * 零子进程、零转义问题。
   */
  const osMod = await import('node:os');
  const cpus = osMod.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'unknown cpu';
  const totalGB = Math.round(osMod.totalmem() / 1073741824);

  report.environment.os = `${process.platform} ${process.arch} · ${cpuModel} · ${totalGB}GB RAM`;
  report.environment.node = process.version;
  report.environment.cpuCores = cpus.length;

  console.log(`  OS: ${report.environment.os}`);
  console.log(`  Node: ${report.environment.node}`);
}

async function collectRendering(baseUrl) {
  console.log('\x1b[36m▸ 采集渲染性能（浏览器内实测）\x1b[0m');

  const EDGE_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edgePath = EDGE_PATHS.find((p) => existsSync(p));
  if (!edgePath) {
    report.notes.push('未找到 Edge，渲染性能采集跳过');
    return;
  }

  const CDP_PORT = 9334;
  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-bench-${Date.now()}`);
  const browser = spawn(edgePath, [
    '--headless=new', '--no-first-run',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } };
  process.on('exit', cleanup);

  let cdpReady = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { cdpReady = true; break; }
    } catch { /* 等待 */ }
    await sleep(500);
  }
  if (!cdpReady) {
    report.notes.push('CDP 未就绪，渲染性能采集跳过');
    cleanup();
    return;
  }

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws failed'));
    setTimeout(() => rej(new Error('timeout')), 10000);
  });

  let msgId = 0;
  const pendingMap = new Map();
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.id !== undefined && pendingMap.has(d.id)) { pendingMap.get(d.id)(d); pendingMap.delete(d.id); }
  };
  const cdpSend = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pendingMap.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };

  await cdpSend('Runtime.enable');
  await cdpSend('Page.enable');
  await cdpSend('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await cdpSend('Page.navigate', { url: baseUrl });

  let appReady = false;
  for (let i = 0; i < 240; i++) {
    try {
      if (await evaluate("!!(window.__KUBEVISION_R3F__ && window.__KUBEVISION_TRANSIENT__)")) { appReady = true; break; }
    } catch { /* 加载中 */ }
    if (i > 0 && i % 20 === 0) console.log(`  \x1b[90m  等待应用… ${Math.round(i * 0.5)}s\x1b[0m`);
    await sleep(500);
  }
  if (!appReady) {
    report.notes.push('应用未就绪，渲染性能采集跳过');
    ws.close(); cleanup();
    return;
  }

  /* WebGL 后端信息 */
  const gpuInfo = await evaluate(`(() => {
    const st = window.__KUBEVISION_R3F__.get();
    const gl = st.gl.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
      dpr: st.viewport.dpr,
    };
  })()`);
  report.environment.webglRenderer = gpuInfo.renderer;
  report.environment.webglVendor = gpuInfo.vendor;
  report.environment.dpr = gpuInfo.dpr;
  console.log(`  WebGL: ${gpuInfo.renderer}`);
  console.log(`  DPR: ${gpuInfo.dpr}`);

  /* 稳态采样 20 次（每次间隔 600ms，覆盖约 12s） */
  console.log('  采样渲染指标（20 × 600ms）…');
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const s = await evaluate(`(() => {
      const g = window.__KUBEVISION_TRANSIENT__.glStats;
      const st = window.__KUBEVISION_R3F__.get();
      return { fps: g.fps, frameTimeMs: g.frameTimeMs, drawCalls: g.drawCalls, triangles: g.triangles, dpr: st.viewport.dpr };
    })()`);
    samples.push(s);
    await sleep(600);
  }

  /* 过滤掉启动初期的异常值（fps 为 0 的样本） */
  const valid = samples.filter((s) => s.fps > 0);

  /**
   * 【可信度标注】SwiftShader 是**软件光栅化器**（无 GPU），
   * 其帧率不代表真实硬件表现。报告必须显式标注，否则读者会误判。
   */
  const isSoftwareRenderer = /swiftshader|llvmpipe|software/i.test(gpuInfo.renderer);

  report.rendering = {
    fps: stats(valid.map((s) => s.fps)),
    frameTimeMs: stats(valid.map((s) => s.frameTimeMs)),
    drawCalls: stats(valid.map((s) => s.drawCalls)),
    triangles: stats(valid.map((s) => s.triangles)),
    sampleCount: valid.length,
    dprSettled: valid[valid.length - 1]?.dpr ?? null,
    softwareRenderer: isSoftwareRenderer,
  };

  if (isSoftwareRenderer) {
    report.notes.push(
      'FPS / Frame Time 采集于 SwiftShader 软件光栅化环境（无 GPU 加速），' +
      '数值显著低于真实显卡。**Draw Calls 与 Triangles 不受影响**，仍可作为批量渲染优化的有效证据。',
    );
  }

  console.log(`  FPS: ${JSON.stringify(report.rendering.fps)}${isSoftwareRenderer ? ' [软件渲染]' : ''}`);
  console.log(`  Draw Calls: ${JSON.stringify(report.rendering.drawCalls)}`);

  /* InstancedMesh 批渲染效果：统计场景对象构成 */
  const sceneComposition = await evaluate(`(() => {
    const st = window.__KUBEVISION_R3F__.get();
    let meshes = 0, instanced = 0, instancedTotal = 0, points = 0, lines = 0;
    st.scene.traverse(o => {
      if (o.isInstancedMesh) { instanced++; instancedTotal += o.count; }
      else if (o.isMesh) meshes++;
      else if (o.isPoints) points++;
      else if (o.isLine || o.isLineSegments) lines++;
    });
    return { meshes, instanced, instancedTotal, points, lines, drawCalls: st.gl.info.render.calls };
  })()`);
  report.batching = sceneComposition;
  console.log(`  场景: ${JSON.stringify(sceneComposition)}`);

  /* 后台休眠验证：frameloop 切换 */
  const frameloopVisible = await evaluate(`(() => window.__KUBEVISION_R3F__.get().frameloop)()`);
  await evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  })()`);
  await sleep(1500);
  const frameloopHidden = await evaluate(`(() => window.__KUBEVISION_R3F__.get().frameloop)()`);
  await evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  })()`);
  await sleep(1500);

  report.rendering.viewportSleep = {
    visible: frameloopVisible,
    hidden: frameloopHidden,
    works: frameloopVisible === 'always' && frameloopHidden === 'demand',
  };
  console.log(`  视口休眠: ${frameloopVisible} → ${frameloopHidden} (${report.rendering.viewportSleep.works ? 'OK' : 'FAIL'})`);

  /* 端侧推理延迟（通过 auditor 面板真实调用 Worker） */
  console.log('  采集端侧推理延迟…');
  await evaluate(`(() => {
    const tl = document.querySelector('[aria-label="AI 抽屉视图切换"]');
    const btn = Array.from(tl.querySelectorAll('[role="tab"]')).find(b => /Edge Log Auditor/i.test(b.textContent || ''));
    if (btn) btn.click();
    return true;
  })()`);

  let engineReady = false;
  for (let i = 0; i < 160; i++) {
    const r = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /抓取并审计/.test(x.textContent || ''));
      return b ? !b.disabled : false;
    })()`);
    if (r) { engineReady = true; break; }
    await sleep(500);
  }

  if (engineReady) {
    /**
     * 【运行时识别】用更宽的匹配：页面可能显示 "WebGPU Hardware Accelerated"
     * 或 "WASM SIMD"，也可能因网格模型降级显示 builtin。逐个尝试。
     */
    const runtimeInfo = await evaluate(`(() => {
      const t = document.body.textContent || '';
      const label = t.match(/WebGPU Hardware Accelerated|WebAssembly SIMD/);
      const status = t.match(/READY \\((WebGPU|WASM)\\)/);
      const isBuiltin = /builtin/i.test(t);
      const model = t.match(/Xenova\\/all-MiniLM-L6-v2|builtin-semantic-classifier/);
      return {
        runtimeLabel: label ? label[0] : (isBuiltin ? 'builtin (fallback)' : 'unknown'),
        status: status ? status[0] : 'unknown',
        isFallback: isBuiltin,
        model: model ? model[0] : 'unknown',
      };
    })()`);
    report.edgeInference.runtime = runtimeInfo.runtimeLabel;
    report.edgeInference.status = runtimeInfo.status;
    report.edgeInference.model = runtimeInfo.model;
    report.edgeInference.fallback = runtimeInfo.isFallback;

    if (runtimeInfo.isFallback) {
      report.notes.push(
        '端侧推理运行在内置确定性分类器（外部模型权重未加载：离线/镜像不可达/' +
        '或超过 3500ms 熔断）。延迟数据反映的是内置分类器，不是神经网络推理。',
      );
    }

    /* 触发 3 轮审计，收集延迟样本 */
    const latencies = [];
    for (let round = 0; round < 3; round++) {
      await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => /抓取并审计/.test(x.textContent || ''));
        if (b && !b.disabled) b.click();
        return true;
      })()`);
      await sleep(2500);
      const lats = await evaluate(`(() => {
        const t = document.body.textContent || '';
        return (t.match(/(\\d+\\.\\d{2})ms/g) || []).map(s => parseFloat(s));
      })()`);
      latencies.push(...lats);
    }
    report.edgeInference.latencyMs = stats(latencies);
    report.edgeInference.sampleCount = latencies.length;
    console.log(
      `  端侧推理: ${runtimeInfo.runtimeLabel}${runtimeInfo.isFallback ? ' [降级]' : ''} · ${JSON.stringify(report.edgeInference.latencyMs)}`,
    );
  } else {
    report.notes.push('端侧引擎未就绪，推理延迟采集跳过');
  }

  ws.close();
  cleanup();
  await sleep(1000);
}

async function collectApiLatency(baseUrl) {
  console.log('\x1b[36m▸ 采集 API 延迟\x1b[0m');

  /**
   * 【预热】dev 模式下 Next.js 首次命中某路由需要即时编译，
   * 首个请求可能耗时数百毫秒（实测 P95 达 335ms 就是冷启动导致）。
   * 先发一次不发计的预热请求，再采样，才能反映真实计算延迟。
   */
  console.log('  预热路由…');
  for (let i = 0; i < 2; i++) {
    try {
      await fetch(`${baseUrl}/api/verify/rag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases: [{ query: 'warmup oom memory', chaos: 'POD_OOM_SWARM' }] }),
        signal: AbortSignal.timeout(30000),
      });
      await fetch(`${baseUrl}/api/verify/sanitize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases: ['warmup 10.0.0.1 token'] }),
        signal: AbortSignal.timeout(30000),
      });
    } catch { /* 预热失败不影响后续 */ }
    await sleep(300);
  }

  /* RAG 检索延迟（纯计算，预热后采样） */
  const ragLatencies = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    try {
      await fetch(`${baseUrl}/api/verify/rag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases: [{ query: 'pod oomkilled memory limit exceeded', chaos: 'POD_OOM_SWARM' }] }),
        signal: AbortSignal.timeout(10000),
      });
      ragLatencies.push(performance.now() - t0);
    } catch { /* 忽略单次失败 */ }
  }
  report.rag.latencyMs = stats(ragLatencies);
  report.rag.sampleCount = ragLatencies.length;
  console.log(`  RAG 检索: ${JSON.stringify(report.rag.latencyMs)}`);

  /* 脱敏器吞吐（通过校验路由，100 条批量） */
  const batch = Array.from({ length: 100 }, (_, i) =>
    `2026-11-06T13:02:${String(i % 60).padStart(2, '0')}Z ERROR [payment-gateway] failed to connect postgres://user${i}:pass${i}@10.244.1.${i % 255}:5432/db token=Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx${i}`.repeat(1));
  const sanitizeLatencies = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    try {
      await fetch(`${baseUrl}/api/verify/sanitize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases: batch }),
        signal: AbortSignal.timeout(15000),
      });
      sanitizeLatencies.push(performance.now() - t0);
    } catch { /* 忽略 */ }
  }
  const meanMs = sanitizeLatencies.length > 0
    ? sanitizeLatencies.reduce((a, b) => a + b, 0) / sanitizeLatencies.length
    : null;
  report.sanitizer = {
    batchSize: batch.length,
    latencyMs: stats(sanitizeLatencies),
    throughputPerSec: meanMs !== null ? Math.round((batch.length / meanMs) * 1000) : null,
  };
  console.log(`  脱敏吞吐: ${report.sanitizer.throughputPerSec}/s (${batch.length} 条/批)`);
}

async function collectBundle() {
  console.log('\x1b[36m▸ 采集包体积\x1b[0m');
  const build = await run('npx', ['next', 'build']);
  const lines = build.stdout.split('\n');
  const routeLines = lines.filter((l) => /^[┌├└]/.test(l.trim()) || l.includes('First Load JS'));
  report.bundle.routes = routeLines.map((l) => l.trim()).filter((l) => l.length > 0);
  for (const l of report.bundle.routes.slice(0, 8)) console.log(`  ${l}`);
}

/* ========================================================================== */
/* 输出                                                                       */
/* ========================================================================== */

function renderMarkdown() {
  const r = report;
  const md = [];

  md.push('# KubeVision AI — 性能实测数据');
  md.push('');
  md.push(`> 采集时间：${r.generatedAt}`);
  md.push('> 所有数字均为实测值，未做理论填充。');
  md.push('');

  md.push('## 运行环境');
  md.push('');
  md.push('| 项目 | 值 |');
  md.push('|---|---|');
  md.push(`| 操作系统 | ${r.environment.os || 'n/a'} |`);
  md.push(`| Node | ${r.environment.node ?? 'n/a'} |`);
  md.push(`| WebGL 渲染器 | ${r.environment.webglRenderer ?? 'n/a'} |`);
  md.push(`| WebGL 厂商 | ${r.environment.webglVendor ?? 'n/a'} |`);
  md.push(`| 稳态 DPR | ${r.environment.dpr ?? 'n/a'} |`);
  md.push('');

  if (r.rendering.fps) {
    const sw = r.rendering.softwareRenderer;
    md.push('## 渲染性能（1920×1080 稳态）');
    md.push('');
    if (sw) {
      md.push('> **本数据采集于 SwiftShader 软件光栅化环境（无 GPU 加速）**。');
      md.push('> FPS 与 Frame Time 显著低于真实显卡，仅供参考渲染循环是否健康；');
      md.push('> **Draw Calls 与 Triangles 为硬件无关指标，可作批量渲染优化的有效证据**。');
      md.push('');
    }
    md.push(`采样 ${r.rendering.sampleCount} 次，间隔 600ms。`);
    md.push('');
    md.push('| 指标 | 均值 | 中位数 | P95 | 最小 | 最大 |');
    md.push('|---|---|---|---|---|---|');
    const row = (label, s) => s ? `| ${label} | ${s.mean} | ${s.median} | ${s.p95} | ${s.min} | ${s.max} |` : null;
    md.push(row('FPS', r.rendering.fps));
    md.push(row('Frame Time (ms)', r.rendering.frameTimeMs));
    md.push(row('Draw Calls', r.rendering.drawCalls));
    md.push(row('Triangles', r.rendering.triangles));
    md.push('');

    if (r.rendering.viewportSleep) {
      const vs = r.rendering.viewportSleep;
      md.push(`**视口休眠**：前台 \`frameloop=${vs.visible}\` → 后台 \`frameloop=${vs.hidden}\` ${vs.works ? '已生效' : '未生效'}`);
      md.push('');
    }
  }

  if (r.batching.meshes !== undefined) {
    const b = r.batching;
    md.push('## 批量渲染优化效果');
    md.push('');
    md.push('| 项目 | 数量 |');
    md.push('|---|---|');
    md.push(`| 普通 Mesh | ${b.meshes} |`);
    md.push(`| InstancedMesh | ${b.instanced} |`);
    md.push(`| 实例总数 | ${b.instancedTotal} |`);
    md.push(`| Points | ${b.points} |`);
    md.push(`| Lines | ${b.lines} |`);
    md.push(`| **实际 Draw Calls** | **${b.drawCalls}** |`);
    md.push('');
    md.push(`> ${b.instancedTotal} 个实例通过 ${b.instanced} 个 InstancedMesh 批量提交，`);
    md.push(`> 若逐个 Mesh 渲染需 ${b.meshes + b.instancedTotal} 次 draw call，实际仅 ${b.drawCalls} 次。`);
    md.push('');
  }

  if (r.edgeInference.latencyMs) {
    const e = r.edgeInference;
    md.push('## 端侧推理性能');
    md.push('');
    md.push(`运行时：**${e.runtime}** · 状态：${e.status}`);
    md.push('');
    md.push(`采样 ${e.sampleCount} 条日志分类。`);
    md.push('');
    md.push('| 指标 | 均值 | 中位数 | P95 | 最小 | 最大 |');
    md.push('|---|---|---|---|---|---|');
    const s = e.latencyMs;
    md.push(`| 单条分类延迟 (ms) | ${s.mean} | ${s.median} | ${s.p95} | ${s.min} | ${s.max} |`);
    md.push('');
  }

  if (r.rag.latencyMs) {
    md.push('## API 延迟');
    md.push('');
    md.push('| 项目 | 均值 | 中位数 | P95 |');
    md.push('|---|---|---|---|');
    const s = r.rag.latencyMs;
    md.push(`| RAG 混合检索 (ms) | ${s.mean} | ${s.median} | ${s.p95} |`);
    md.push('');
  }

  if (r.sanitizer.throughputPerSec) {
    const s = r.sanitizer;
    md.push('## 隐私脱敏吞吐');
    md.push('');
    md.push(`批量 ${s.batchSize} 条，实测吞吐 **${s.throughputPerSec} 条/秒**`);
    md.push(`（均值延迟 ${s.latencyMs.mean} ms）。`);
    md.push('');
  }

  if (r.bundle.routes && r.bundle.routes.length > 0) {
    md.push('## 构建产物与包体积');
    md.push('');
    md.push('```');
    for (const l of r.bundle.routes) md.push(l);
    md.push('```');
    md.push('');
  }

  if (r.notes.length > 0) {
    md.push('## 采集说明');
    md.push('');
    for (const n of r.notes) md.push(`- ${n}`);
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push('*本文件由 `scripts/benchmark.mjs` 自动生成，重新运行可刷新数据。*');

  return md.join('\n');
}

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

async function main() {
  console.log('\n\x1b[1m╔════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[1m║  KubeVision AI — 性能数据采集                      ║\x1b[0m');
  console.log('\x1b[1m╚════════════════════════════════════════════════════╝\x1b[0m\n');

  await collectEnvironment();

  /* dev server */
  const baseUrl = 'http://127.0.0.1:3000';
  const already = await (async () => {
    try { const r = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) }); return r.ok || r.status === 404; } catch { return false; }
  })();

  const dev = already ? null : spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['dev'],
    { cwd: ROOT, shell: process.platform === 'win32', stdio: 'ignore' },
  );
  const killDev = () => {
    if (dev === null) return;
    try {
      if (process.platform === 'win32' && dev.pid !== undefined) {
        spawn('taskkill', ['/PID', String(dev.pid), '/T', '/F'], { stdio: 'ignore' });
      } else { dev.kill('SIGKILL'); }
    } catch { /* ignore */ }
  };
  process.on('exit', killDev);

  if (!already) console.log('\n  启动 dev server…');
  const up = await waitForServer(baseUrl);
  if (!up) {
    console.error('\x1b[31m  dev server 未就绪，终止采集\x1b[0m');
    killDev();
    process.exit(1);
  }
  console.log(`  \x1b[32m✓\x1b[0m dev server: ${baseUrl}\n`);

  await collectRendering(baseUrl);
  await collectApiLatency(baseUrl);
  killDev();
  await sleep(2000);

  await collectBundle();

  /* 写文件 */
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'performance.md'), renderMarkdown(), 'utf8');
  writeFileSync(join(OUT_DIR, 'performance.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('\n\x1b[32m✓ 已生成:\x1b[0m');
  console.log('  docs/performance.md   （可读报告）');
  console.log('  docs/performance.json （原始数据）\n');
}

main().catch((e) => {
  console.error('\x1b[31m采集异常:\x1b[0m', e);
  process.exitCode = 1;
});
