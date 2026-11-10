#!/usr/bin/env node
/**
 * KubeVision AI — 质量矩阵标定（R30 · 追问 1）
 *
 * 【做什么】依次以 `?quality=off|low|balanced|high`（T0/T1/T2/T3）加载同一场景，
 * 记录 fps / frameTime / draw calls / triangles / 显存估算，并输出
 * docs/quality-matrix.md。
 *
 * 【重要前提】本沙箱没有真实独显/集显，Edge 只能跑 SwiftShader 软件光栅化。
 * 因此本脚本标注的"硬件"会是 SwiftShader——**这些数字不能作为 60FPS 决策依据**。
 * 脚本本身可在真机上直接复跑（`node scripts/quality-matrix.mjs`），
 * 届时 renderer 会变成真实 GPU 名称，矩阵才有标定意义。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9388');
const OUT_MD = join(process.cwd(), 'docs/quality-matrix.md');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path));
if (EDGE === undefined) {
  console.error('未找到 Edge');
  process.exit(2);
}

const TIERS = [
  { query: 'high', tier: 'T3', label: '全特效' },
  { query: 'balanced', tier: 'T2', label: '关 DoF / 中等 Bloom' },
  { query: 'low', tier: 'T1', label: '关阴影/反射 + Bloom 降级' },
  { query: 'off', tier: 'T0', label: '后处理全关' },
];

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
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-qm-${Date.now()}`)}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => {
  try {
    browser.kill('SIGKILL');
  } catch {
    /* ignore */
  }
});

let target = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    target = list.find((item) => item.type === 'page') ?? null;
    if (target !== null) break;
  } catch {
    /* 等浏览器 */
  }
  await sleep(500);
}
if (target === null) {
  console.error('CDP 未就绪');
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
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.result?.exceptionDetails) return { __err: String(response.result.exceptionDetails.text) };
  return response.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

const rows = [];
for (const tierDef of TIERS) {
  await send('Page.navigate', { url: `${BASE_URL}/?quality=${tierDef.query}` });
  for (let i = 0; i < 240; i += 1) {
    if ((await evaluate('document.querySelector("canvas") !== null')) === true) break;
    await sleep(400);
  }
  await sleep(9000);

  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const stats = await evaluate(`(() => {
      const g = window.__KUBEVISION_TRANSIENT__.glStats;
      const render = window.__KUBEVISION_RENDER__;
      const state = window.__KUBEVISION_R3F__?.get?.();
      const gl = state?.gl ?? null;
      const scene = state?.scene ?? null;
      let vramBytes = 0;
      let textureBytes = 0;
      const seenTextures = new Set();
      if (scene !== null) {
        scene.traverse((object) => {
          const geometry = object.geometry;
          if (geometry !== undefined && geometry.attributes !== undefined) {
            for (const attribute of Object.values(geometry.attributes)) {
              vramBytes += attribute.array ? attribute.array.byteLength : 0;
            }
            if (geometry.index !== null && geometry.index !== undefined) {
              vramBytes += geometry.index.array.byteLength;
            }
          }
          const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          for (const material of materials) {
            for (const key of ['map', 'roughnessMap', 'bumpMap', 'normalMap', 'aoMap', 'emissiveMap']) {
              const texture = material[key];
              if (texture === undefined || texture === null || seenTextures.has(texture)) continue;
              seenTextures.add(texture);
              const image = texture.image;
              if (image !== undefined && image !== null && image.width) {
                textureBytes += image.width * image.height * 4;
              }
            }
          }
        });
      }
      return {
        fps: g.fps,
        frameTimeMs: g.frameTimeMs,
        drawCalls: g.drawCalls,
        triangles: g.triangles,
        renderer: state?.gl ? (() => { try { const ext = state.gl.getContext().getExtension('WEBGL_debug_renderer_info'); return ext === null ? 'unknown' : state.gl.getContext().getParameter(ext.UNMASKED_RENDERER_WEBGL); } catch { return 'unknown'; } })() : 'unknown',
        post: render ? render.getPost() : null,
        vramBytes,
        textureBytes,
        glTextures: gl ? gl.info.memory.textures : null,
        glGeometries: gl ? gl.info.memory.geometries : null,
      };
    })()`);
    if (stats !== null && stats !== undefined && stats.__err === undefined) samples.push(stats);
    await sleep(1000);
  }

  rows.push({
    tier: tierDef.tier,
    query: tierDef.query,
    label: tierDef.label,
    samples,
  });
  const last = samples[samples.length - 1];
  console.log(`  ${tierDef.tier} (${tierDef.query}): ${last?.fps ?? 'n/a'} FPS / ${last?.frameTimeMs ?? 'n/a'}ms / ${last?.drawCalls ?? 'n/a'} draws / post=${String(last?.post)}`);
}

/* ---- 汇总 + 报告 ---- */
const renderer = rows.flatMap((row) => row.samples.map((sample) => sample.renderer)).find((value) => value && value !== 'unknown') ?? 'unknown';
const isSoftware = /swiftshader|software|llvmpipe/i.test(String(renderer));

const summary = rows.map((row) => {
  const valid = row.samples.filter((sample) => sample !== null && sample !== undefined);
  const avg = (key) => (valid.length === 0 ? 0 : valid.reduce((sum, sample) => sum + sample[key], 0) / valid.length);
  const max = (key) => Math.max(...valid.map((sample) => sample[key]), 0);
  const last = valid[valid.length - 1] ?? {};
  return {
    tier: row.tier,
    query: row.query,
    label: row.label,
    fps: avg('fps'),
    frameTimeMs: avg('frameTimeMs'),
    drawCalls: last.drawCalls ?? 0,
    triangles: last.triangles ?? 0,
    vramMB: ((last.vramBytes ?? 0) + (last.textureBytes ?? 0)) / 1024 / 1024,
    post: last.post ?? null,
    glTextures: last.glTextures ?? null,
    glGeometries: last.glGeometries ?? null,
  };
});

const lines = [
  '# 质量矩阵标定（T3 / T2 / T1 / T0）',
  '',
  `> 由 \`node scripts/quality-matrix.mjs\` 自动生成于 ${new Date().toISOString()}。`,
  `> 渲染器：\`${renderer}\``,
  '',
  isSoftware
    ? '## ⚠️ 重要：本结果来自软件光栅化（SwiftShader）\n\n本沙箱没有可用独显/集显，Edge 只能软渲染。**这些 fps 数字不能作为 60FPS 决策依据**，只用于记录档位切换对 draw calls / 显存估算的影响。真机复跑命令：`node scripts/quality-matrix.mjs`（renderer 会显示真实 GPU 名称）。'
    : '## 硬件\n\n本矩阵来自真实 GPU 渲染器，可作为 60FPS 决策依据。',
  '',
  '## 矩阵',
  '',
  '| 档位 | 说明 | fps（均值） | frameTime（均值） | draw calls | triangles | 显存估算 | 后处理 |',
  '|---|---|---|---|---|---|---|---|',
  ...summary.map(
    (row) =>
      `| ${row.tier} (\`?quality=${row.query}\`) | ${row.label} | ${row.fps.toFixed(1)} | ${row.frameTimeMs.toFixed(1)} ms | ${row.drawCalls} | ${row.triangles} | ≈${row.vramMB.toFixed(1)} MB | ${row.post ? 'on' : 'off'} |`,
  ),
  '',
  '## 降档定位顺序（若真机独显不到 60FPS）',
  '',
  '按需求契约，定位顺序固定为 **先降反射 → 再降阴影 → 再降 Bloom**，禁止缩小场景：',
  '',
  '1. 反射：`MeshReflectorMaterial` 会整场景再渲染一遍，是本项目最贵的单项；T1 起关闭。',
  '2. 阴影：PCFSoft 2048 阴影贴图；T1 起关闭。',
  '3. Bloom：levels 6→5→4、intensity 0.72→0.66→0.60；T0 随整条后处理链关闭。',
  '4. 以上仍不足时，才由治理器继续降粒子密度（不是删场景物体）。',
  '',
  '## 未验证项',
  '',
  '- 本沙箱无真机 GPU，独显/集显两轮标定**未完成**；须在真实硬件上复跑本脚本。',
  '- 显存估算为"几何 buffer + 程序化纹理近似"，不是驱动真实占用；仅用于档位间相对比较。',
  '',
];
mkdirSync(join(process.cwd(), 'docs'), { recursive: true });
writeFileSync(OUT_MD, lines.join('\n'), 'utf8');

const payload = { generatedAt: new Date().toISOString(), renderer, isSoftware, summary };
writeFileSync(join(process.cwd(), 'docs/quality-matrix.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`\n[报告] ${OUT_MD}`);
ws.close();
process.exit(0);