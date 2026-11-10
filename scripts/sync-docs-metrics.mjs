#!/usr/bin/env node
/**
 * KubeVision AI — 文档指标同步（scripts/sync-docs-metrics.mjs）
 *
 * 【解决什么问题】README / 白皮书里的性能数字是**手抄**的：改一次实现就多一处
 * 对不上的旧数字（实测已出现 Draw Calls 307 vs 402、RAG 11.14ms vs 6.59ms、
 * 吞吐 9,573 vs 16,324 三处互相矛盾）。文档一旦与实测脱节，评审现场
 * 任何一个数字被追问都会连带怀疑其它数据。
 *
 * 【做法】所有"会变"的指标都放进标记区块：
 *     <!-- METRICS:BEGIN --> … <!-- METRICS:END -->
 *     <!-- VERIFY:BEGIN --> … <!-- VERIFY:END -->
 * 本脚本从 docs/performance.json（benchmark 产出）与 docs/verify-summary.json
 * （capture-evidence 产出）重新生成区块内容并原地替换。人只写标记，不写数字。
 *
 * 【幂等】重复运行输出完全一致（除采集时间来自源 JSON），可作为 CI 的
 * `--check`：文档与实测不一致时退出码 1。
 *
 * 【用法】
 *   node scripts/sync-docs-metrics.mjs            # 同步
 *   node scripts/sync-docs-metrics.mjs --check    # 只检查，不写入
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CHECK_ONLY = process.argv.includes('--check');

/** 参与同步的文档（必须已含标记区块） */
const TARGETS = ['README.md', 'docs/COMPETITION_TECHNICAL_WHITEPAPER.md'];

/* ========================================================================== */
/* 工具                                                                        */
/* ========================================================================== */

/**
 * 千分位格式化。
 *
 * @param value 数值
 * @returns 带千分位的字符串
 */
function thousands(value) {
  return Math.round(value).toLocaleString('en-US');
}

/**
 * 固定小数位。
 *
 * @param value 数值
 * @param digits 小数位
 * @returns 字符串
 */
function fixed(value, digits = 2) {
  return Number(value).toFixed(digits);
}

/**
 * 把 ISO 时间转成人类可读的本地时间（Asia/Shanghai 展示口径）。
 *
 * @param iso ISO 8601 字符串
 * @returns 形如 2026-11-10 13:45
 */
function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

/* ========================================================================== */
/* 生成区块内容                                                                */
/* ========================================================================== */

/**
 * 由 performance.json 生成 METRICS 区块的 Markdown。
 *
 * @param report performance.json 内容
 * @returns Markdown 文本（不含标记行）
 */
function renderMetrics(report) {
  const env = report.environment ?? {};
  const rendering = report.rendering ?? {};
  const batching = report.batching ?? {};
  const fps = rendering.fps ?? {};
  const frame = rendering.frameTimeMs ?? {};
  const draw = rendering.drawCalls ?? {};
  const tri = rendering.triangles ?? {};
  const rag = report.rag?.latencyMs ?? {};
  const sanitizer = report.sanitizer ?? {};
  const edge = report.edgeInference?.latencyMs ?? {};
  const bundle = report.bundle?.routes ?? [];

  /* 从 next build 输出里解析首屏体积（两行：路由行 + shared 行） */
  const routeLine = bundle.find((line) => line.includes('○ /') && !line.includes('_not-found')) ?? '';
  const sharedLine = bundle.find((line) => line.includes('First Load JS shared')) ?? '';
  const firstLoad = routeLine.trim().split(/\s{2,}/).slice(-1)[0] ?? '—';
  const shared = sharedLine.trim().split(/\s{2,}/).slice(-1)[0] ?? '—';

  const rows = [
    '| 指标 | 实测值 | 采集口径 / 是否可作性能证据 |',
    '|---|---|---|',
    `| 数据采集时间 | ${formatTime(report.generatedAt)}（Asia/Shanghai） | \`node scripts/benchmark.mjs\` |`,
    `| 运行环境 | ${env.os ?? '—'} · Node ${env.node ?? '—'} · ${env.cpuCores ?? '—'} 核 | 同上 |`,
    `| WebGL 渲染器 | ${env.webglRenderer ?? '—'} | 软件光栅化，**FPS 不作为性能证据** |`,
    `| Draw Calls | **${thousands(draw.median ?? 0)}**（${draw.count ?? 0} 次采样 ${thousands(draw.min ?? 0)}~${thousands(draw.max ?? 0)}） | 硬件无关，可作渲染优化证据 |`,
    `| Triangles | ${thousands(tri.median ?? 0)}（中位） | 硬件无关 |`,
    `| 场景对象 | ${batching.meshes ?? '—'} Mesh / ${batching.instanced ?? '—'} InstancedMesh / ${thousands(batching.instancedTotal ?? 0)} 实例 / ${batching.points ?? '—'} Points / ${batching.lines ?? '—'} Lines | 场景统计 |`,
    `| RAG 检索延迟 | 均值 **${fixed(rag.mean)}ms** · 中位 ${fixed(rag.median)}ms · P95 ${fixed(rag.p95)}ms（${rag.count ?? 0} 次采样） | 真实耗时 |`,
    `| 脱敏吞吐 | **${thousands(sanitizer.throughputPerSec ?? 0)} 条/秒**（${sanitizer.batchSize ?? '—'} 条/批 × ${sanitizer.latencyMs?.count ?? 0}） | 真实耗时 |`,
    `| 端侧分类延迟 | 均值 ${fixed(edge.mean)}ms（${edge.count ?? 0} 条） | ${report.edgeInference?.runtime ?? '—'}，非神经网络推理 |`,
    `| 首屏 JS | 路由 ${routeLine.trim().split(/\s{2,}/).slice(-2)[0] ?? '—'} · First Load ${firstLoad} · 共享 ${shared} | next build 输出 |`,
    `| FPS（软件光栅化） | 均值 ${fixed(fps.mean)} · 中位 ${fixed(fps.median)} · P95 ${fixed(fps.p95)}（${fps.count ?? 0} 次采样） | **不作为性能证据** |`,
    `| 帧时间（软件光栅化） | 均值 ${fixed(frame.mean)}ms · P95 ${fixed(frame.p95)}ms | **不作为性能证据** |`,
    `| 视口休眠 | 前台 \`${rendering.viewportSleep?.visible ?? '—'}\` → 后台 \`${rendering.viewportSleep?.hidden ?? '—'}\`，${rendering.viewportSleep?.works === true ? '已验证生效' : '未验证'} | 行为验证 |`,
  ];
  return rows.join('\n');
}

/**
 * 由 verify-summary.json 生成 VERIFY 区块内容（单行，可嵌入表格/正文）。
 *
 * @param summary 验收汇总
 * @returns 文本
 */
function renderVerify(summary) {
  if (summary === null) {
    return '未采集（先运行 `node scripts/capture-evidence.mjs`）';
  }
  return `**通过 ${summary.pass} · 失败 ${summary.fail} · 跳过 ${summary.skip}（共 ${summary.total} 项）**`;
}

/* ========================================================================== */
/* 替换区块                                                                    */
/* ========================================================================== */

/**
 * 替换文本中的标记区块内容。
 *
 * @param text 原文本
 * @param name 区块名（METRICS / VERIFY）
 * @param content 新内容
 * @returns 替换后的文本；未找到标记时返回 null
 */
function replaceBlock(text, name, content) {
  const begin = `<!-- ${name}:BEGIN -->`;
  const end = `<!-- ${name}:END -->`;

  /*
   * 【块级 vs 行内】标记可能出现在两种位置：
   * 1. 独占若干行（块级，如 README 的性能表）→ 内容前后要换行；
   * 2. 嵌在 Markdown 表格单元格或句子中间（行内，如"自动完成 <!-- VERIFY -->"）→
   *    绝不能插入换行，否则表格被截断成多行、句子被拆散（实测踩到）。
   * 判定方式：看 BEGIN 标记所在行、它之前是否只有空白。
   */
  /*
   * 【同一文档可能出现多处同名区块】例如 README 里既有评分表的行内计数，
   * 又有验收章节的句子；只替换第一处会留下一堆空标记（实测踩到）。
   * 这里循环替换，直到文中不再出现该区块。
   */
  let out = text;
  let cursor = 0;
  for (;;) {
    /* 关键：从上一处替换之后继续找，否则会重复命中刚写入的同一区块（死循环） */
    const beginIdx = out.indexOf(begin, cursor);
    if (beginIdx < 0) break;
    const finishIdx = out.indexOf(end, beginIdx);
    if (finishIdx < 0) break;
    const lineStart = out.lastIndexOf('\n', beginIdx) + 1;
    const isBlockLevel = out.slice(lineStart, beginIdx).trim() === '';
    const body = isBlockLevel ? `\n${content}\n` : content;
    out = `${out.slice(0, beginIdx + begin.length)}${body}${out.slice(finishIdx)}`;
    cursor = beginIdx + begin.length + body.length + end.length;
  }
  return out;
}

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

const perfPath = join(ROOT, 'docs/performance.json');
if (!existsSync(perfPath)) {
  console.error('[FATAL] 缺少 docs/performance.json，请先运行 node scripts/benchmark.mjs');
  process.exit(2);
}
const report = JSON.parse(readFileSync(perfPath, 'utf8'));

const verifyPath = join(ROOT, 'docs/verify-summary.json');
const summary = existsSync(verifyPath) ? JSON.parse(readFileSync(verifyPath, 'utf8')) : null;

const metricsBlock = renderMetrics(report);
const verifyBlock = renderVerify(summary);

console.log('KubeVision AI — 文档指标同步');
console.log(`  数据源: docs/performance.json（采集于 ${formatTime(report.generatedAt)}）`);
console.log(`  验收源: ${summary === null ? '（缺失，使用占位）' : `docs/verify-summary.json（通过 ${summary.pass} / 共 ${summary.total}）`}`);
console.log('');

let changed = 0;
let missing = 0;
for (const rel of TARGETS) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    console.log(`  ○ ${rel} 不存在，跳过`);
    continue;
  }
  const original = readFileSync(file, 'utf8');
  let next = original;

  const afterMetrics = replaceBlock(next, 'METRICS', metricsBlock);
  if (afterMetrics === null) {
    console.log(`  ✗ ${rel} 缺少 <!-- METRICS:BEGIN --> 标记`);
    missing += 1;
  } else {
    next = afterMetrics;
  }

  const afterVerify = replaceBlock(next, 'VERIFY', verifyBlock);
  if (afterVerify === null) {
    console.log(`  ✗ ${rel} 缺少 <!-- VERIFY:BEGIN --> 标记`);
    missing += 1;
  } else {
    next = afterVerify;
  }

  if (next === original) {
    console.log(`  = ${rel} 已是最新`);
    continue;
  }
  changed += 1;
  if (CHECK_ONLY) {
    console.log(`  ✗ ${rel} 与实测不一致（--check 模式不写入）`);
  } else {
    writeFileSync(file, next, 'utf8');
    console.log(`  ✓ ${rel} 已同步`);
  }
}

console.log('');
if (missing > 0) {
  console.error(`[FAIL] 有 ${missing} 处标记缺失，请在文档中加入 <!-- METRICS:BEGIN/END --> 与 <!-- VERIFY:BEGIN/END -->`);
  process.exit(1);
}
if (CHECK_ONLY && changed > 0) {
  console.error(`[FAIL] 有 ${changed} 个文档与实测不一致，请运行 node scripts/sync-docs-metrics.mjs`);
  process.exit(1);
}
console.log(changed === 0 ? '✓ 所有文档指标均为最新' : `✓ 已同步 ${changed} 个文档`);