#!/usr/bin/env node
/**
 * KubeVision AI — 性能采集双跑一致性校验（scripts/benchmark-consistency.mjs）
 *
 * 【解决什么问题】文档里每一个性能数字都应该能被复核。但 `benchmark.mjs`
 * 单跑一次无法回答"这个数是偶然还是稳定"；手工连跑两遍又会踩坑——
 * benchmark 若自己拉起了 dev server，退出时会把它杀掉，第二遍就得重新冷编译，
 * 110 秒超时后渲染段直接采空（实测踩到：第二遍 rendering/batching 为空）。
 *
 * 【本脚本】在**同一个进程**里管理 dev server 生命周期：
 *   1. 端口 3000 没起就拉起 dev server，并预热首页（触发编译）；
 *   2. 串行执行两遍 `node scripts/benchmark.mjs`；
 *   3. 逐字段对比两次产物，按「必须一致 / 允许波动」分类打印；
 *   4. 把第一遍产物落回 docs/performance.json（作为文档数据源）。
 *
 * 【分类依据】
 * - 必须一致（硬件无关、纯几何/构建产物）：场景对象数、实例总数、包体积、Triangles 中位；
 * - 允许波动（与运行时调度/网络/软件光栅化相关）：FPS、帧时间、Draw Calls 采样、
 *   RAG / 脱敏 / 端侧延迟。
 * 任何"必须一致"字段不一致 → 退出码 1。
 *
 * 【用法】
 *   node scripts/benchmark-consistency.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASE_URL = 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/* 1. dev server 生命周期                                                       */
/* ========================================================================== */

/**
 * 探测 dev server 是否可用。
 *
 * @returns {Promise<boolean>} 是否可访问
 */
async function ping() {
  try {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(4000) });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * 释放 3000 端口上残留的 dev server。
 *
 * 【为什么必须释放】benchmark 的收尾阶段会执行 `next build` 写 .next，
 * 这会**打坏正在运行的 dev server**（实测：build 之后再访问返回 500）。
 * 若第二遍复用了被打坏的 server，benchmark 会判定"未就绪"然后超时拿不到渲染数据
 * （实测第二遍 rendering/batching 为空）。
 * 因此每一遍都先释放端口，让 benchmark 按自己的设计"独占"dev server 与 .next：
 * 自己拉起 → 采集 → 自己杀掉 → 再 build。
 *
 * @returns {void}
 */
function killDevOnPort3000() {
  try {
    const output = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const pids = new Set();
    for (const line of output.split('\n')) {
      if (line.includes(':3000') && line.includes('LISTENING')) {
        const parts = line.trim().split(/\s+/);
        pids.add(parts[parts.length - 1]);
      }
    }
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* 进程可能已退出 */
      }
    }
    if (pids.size > 0) console.log(`  已释放 3000 端口（pid ${[...pids].join(',')}）`);
  } catch {
    /* netstat 不可用时跳过 */
  }
}

/* ========================================================================== */
/* 2. 跑两遍 benchmark                                                          */
/* ========================================================================== */

/**
 * 执行一次 benchmark 子进程。
 *
 * @param label 显示标签
 * @returns {Promise<number>} 退出码
 */
function runBenchmark(label) {
  console.log(`\n▸ ${label}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/benchmark.mjs'], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

killDevOnPort3000();
await sleep(2500);
const firstCode = await runBenchmark('第一遍 benchmark');
if (firstCode !== 0) {
  console.error('[FATAL] 第一遍 benchmark 失败');
  process.exit(1);
}
copyFileSync(join(ROOT, 'docs/performance.json'), join(ROOT, 'tmp-bench-run1.json'));

await sleep(3000);
killDevOnPort3000();
await sleep(2500);
const secondCode = await runBenchmark('第二遍 benchmark');
if (secondCode !== 0) {
  console.error('[FATAL] 第二遍 benchmark 失败');
  process.exit(1);
}
copyFileSync(join(ROOT, 'docs/performance.json'), join(ROOT, 'tmp-bench-run2.json'));

/* ========================================================================== */
/* 3. 对比                                                                      */
/* ========================================================================== */

const a = JSON.parse(readFileSync(join(ROOT, 'tmp-bench-run1.json'), 'utf8'));
const b = JSON.parse(readFileSync(join(ROOT, 'tmp-bench-run2.json'), 'utf8'));

/**
 * 规范化：去掉每遍必然变化的时间戳字段。
 *
 * @param report performance.json
 * @returns 可比较对象
 */
function normalize(report) {
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.generatedAt;
  return copy;
}

/**
 * 深度比较两个对象，返回差异列表。
 *
 * @param x 左值
 * @param y 右值
 * @param path 路径
 * @param out 差异收集器
 * @returns 差异列表
 */
function diff(x, y, path, out) {
  if (typeof x === 'object' && x !== null && typeof y === 'object' && y !== null) {
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      diff(x[key], y[key], path === '' ? key : `${path}.${key}`, out);
    }
    return out;
  }
  if (x !== y) out.push({ path, first: x, second: y });
  return out;
}

const diffs = diff(normalize(a), normalize(b), '', []);
const diffPaths = new Set(diffs.map((d) => d.path));

/** 必须完全一致的字段（前缀匹配） */
const INVARIANT_PREFIXES = [
  'batching.',
  'bundle.',
  /*
   * 只锁中位：Triangles 的 mean/min/max 会随视锥剔除与动画相位轻微抖动
   * （实测两遍 mean 差 4.8 / 0.0023%），按「必须完全一致」会误报；
   * 文档引用的是中位，锁中位才与契约一致。
   */
  'rendering.triangles.median',
  'rendering.softwareRenderer',
  'rendering.viewportSleep.',
  'rendering.dprSettled',
  'environment.os',
  'environment.node',
  'environment.cpuCores',
];

const invariantViolations = diffs.filter((d) => INVARIANT_PREFIXES.some((p) => d.path.startsWith(p)));

console.log('\n══════════ 两遍采集对比 ══════════');
console.log(`  差异字段总数: ${diffs.length}`);
console.log('\n  必须一致（硬件无关）:');
const invariantFields = [
  ['场景对象 meshes', a.batching?.meshes, b.batching?.meshes],
  ['InstancedMesh', a.batching?.instanced, b.batching?.instanced],
  ['实例总数', a.batching?.instancedTotal, b.batching?.instancedTotal],
  ['Triangles 中位', a.rendering?.triangles?.median, b.rendering?.triangles?.median],
  ['首屏路由体积', a.bundle?.routes?.[1], b.bundle?.routes?.[1]],
];
for (const [label, x, y] of invariantFields) {
  console.log(`    ${x === y ? '✓' : '✗'} ${label}: ${JSON.stringify(x)} / ${JSON.stringify(y)}`);
}

console.log('\n  允许波动（运行时相关）:');
const volatileFields = [
  ['FPS 中位', a.rendering?.fps?.median, b.rendering?.fps?.median],
  ['帧时间均值', a.rendering?.frameTimeMs?.mean, b.rendering?.frameTimeMs?.mean],
  ['Draw Calls 中位', a.rendering?.drawCalls?.median, b.rendering?.drawCalls?.median],
  ['RAG 均值', a.rag?.latencyMs?.mean, b.rag?.latencyMs?.mean],
  ['脱敏吞吐', a.sanitizer?.throughputPerSec, b.sanitizer?.throughputPerSec],
  ['端侧延迟均值', a.edgeInference?.latencyMs?.mean, b.edgeInference?.latencyMs?.mean],
];
for (const [label, x, y] of volatileFields) {
  console.log(`    · ${label}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
}

/* 第一遍产物作为文档数据源 */
copyFileSync(join(ROOT, 'tmp-bench-run1.json'), join(ROOT, 'docs/performance.json'));

console.log('');
if (invariantViolations.length === 0) {
  console.log(`✓ 硬件无关指标两遍完全一致（${invariantFields.length} 项）`);
  console.log('  文档数据源已恢复为第一遍产物 docs/performance.json');
  process.exit(0);
}
console.error(`✗ 有 ${invariantViolations.length} 个硬件无关字段不一致:`);
for (const d of invariantViolations.slice(0, 10)) {
  console.error(`  ${d.path}: ${JSON.stringify(d.first)} ≠ ${JSON.stringify(d.second)}`);
}
process.exit(1);