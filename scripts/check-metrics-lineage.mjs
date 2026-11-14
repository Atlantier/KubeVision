#!/usr/bin/env node
/**
 * KubeVision AI — 指标与文档数据血缘校验器（scripts/check-metrics-lineage.mjs）
 *
 * 【设计意图】
 * 防止 README、白皮书、PPT、performance.md 与性能快照 JSON 发生事实脱节。
 * 校验单一事实源 JSON（performance.json / rag-eval.json / verify-summary.json /
 * mode-parity.json）的结构完整性，确认 README / 白皮书的自动同步区块一致，
 * 并校验关键披露声明（SwiftShader 软件光栅化、按需静置 1 draw call）完整落地。
 *
 * 【用法】node scripts/check-metrics-lineage.mjs
 * 【退出码】0 = 血缘完整一致；1 = 发现缺口或脱节
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const errors = [];

function checkJson(relPath, validators) {
  const full = join(ROOT, relPath);
  if (!existsSync(full)) {
    errors.push(`缺失单一事实源文件: ${relPath}`);
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(full, 'utf8'));
    for (const [desc, fn] of validators) {
      if (!fn(data)) {
        errors.push(`${relPath} 校验失败: ${desc}`);
      }
    }
    return data;
  } catch (err) {
    errors.push(`${relPath} JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function extractFirstLoadKb(perf) {
  const row = (perf?.bundle?.routes ?? []).find(
    (line) => typeof line === 'string' && /^\s*[┌├└]\s*[○ƒ]?\s*\/\s/.test(line),
  );
  const match = typeof row === 'string' ? row.match(/(\d+(?:\.\d+)?)\s*kB\s*$/) : null;
  return match === null ? null : Number(match[1]);
}

console.log('KubeVision AI — 指标数据血缘校验\n');

const perf = checkJson('docs/performance.json', [
  ['generatedAt ISO 时间戳', (d) => typeof d.generatedAt === 'string' && d.generatedAt.length >= 10],
  ['bundle.routes["/"] 首屏 First Load JS', (d) => extractFirstLoadKb(d) !== null],
  ['rendering.drawCalls.median', (d) => typeof d.rendering?.drawCalls?.median === 'number' && d.rendering.drawCalls.median > 0],
  ['rendering.triangles.median', (d) => typeof d.rendering?.triangles?.median === 'number' && d.rendering.triangles.median > 0],
  ['batching.instancedTotal', (d) => typeof d.batching?.instancedTotal === 'number' && d.batching.instancedTotal > 0],
  ['rag.latencyMs.mean', (d) => typeof d.rag?.latencyMs?.mean === 'number' && d.rag.latencyMs.mean > 0],
  ['sanitizer.throughputPerSec', (d) => typeof d.sanitizer?.throughputPerSec === 'number' && d.sanitizer.throughputPerSec > 0],
]);

const rag = checkJson('docs/rag-eval.json', [
  ['modes.twoWayRrf.recallAt1', (d) => typeof d.modes?.twoWayRrf?.recallAt1 === 'number'],
  ['modes.threeWayRrf.recallAt1', (d) => typeof d.modes?.threeWayRrf?.recallAt1 === 'number'],
  ['corpusSize / caseCount', (d) => typeof d.corpusSize === 'number' && typeof d.caseCount === 'number'],
]);

const verifySummary = checkJson('docs/verify-summary.json', [
  ['total / pass / fail / skip', (d) => typeof d.total === 'number' && typeof d.pass === 'number' && d.fail === 0],
]);

const modeParity = checkJson('docs/mode-parity.json', [
  ['scenarios 全部通过', (d) => Array.isArray(d.scenarios) && d.scenarios.length > 0 && d.scenarios.every((s) => s.pass === true)],
]);

/* 检查文档自动生成区块标记是否完整（各文档按 sync-docs-metrics 契约校验） */
const DOC_SYNC_TAGS = [
  ['README.md', ['METRICS', 'VERIFY']],
  ['docs/COMPETITION_TECHNICAL_WHITEPAPER.md', ['METRICS', 'VERIFY', 'PARITY']],
];
for (const [docPath, tags] of DOC_SYNC_TAGS) {
  const full = join(ROOT, docPath);
  if (!existsSync(full)) {
    errors.push(`缺失目标文档: ${docPath}`);
    continue;
  }
  const text = readFileSync(full, 'utf8');
  for (const tag of tags) {
    if (!text.includes(`<!-- ${tag}:BEGIN -->`) || !text.includes(`<!-- ${tag}:END -->`)) {
      errors.push(`${docPath} 缺少自动同步标记: <!-- ${tag}:BEGIN/END -->`);
    }
  }
}

/* 校验 sync-docs-metrics --check 与 JSON 事实源是否完全同步 */
try {
  execFileSync(process.execPath, ['scripts/sync-docs-metrics.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
} catch {
  errors.push('sync-docs-metrics --check 未通过：README 或白皮书自动区块与最新 JSON 不一致');
}

/* 检查 SwiftShader 免责与 1 draw call 说明 */
const designSysPath = join(ROOT, 'docs/design-system.md');
if (existsSync(designSysPath)) {
  const text = readFileSync(designSysPath, 'utf8');
  if (!/SwiftShader/i.test(text) || !/不作为性能证据|软件光栅化/.test(text)) {
    errors.push('docs/design-system.md 未标注 SwiftShader 软件光栅化免责声明');
  }
} else {
  errors.push('缺失 docs/design-system.md');
}

const renderAbPath = join(ROOT, 'docs/render-ab.md');
if (existsSync(renderAbPath)) {
  const text = readFileSync(renderAbPath, 'utf8');
  if (!/静置帧|按需渲染/.test(text) || !/SwiftShader/i.test(text)) {
    errors.push('docs/render-ab.md 未解释 1 draw calls 静置帧口径及 SwiftShader 免责声明');
  }
} else {
  errors.push('缺失 docs/render-ab.md');
}

if (perf && rag && verifySummary && modeParity) {
  const firstLoadKb = extractFirstLoadKb(perf);
  console.log(`  · performance.json : FirstLoad=${firstLoadKb} kB | DrawCalls=${perf.rendering.drawCalls.median} | Triangles=${perf.rendering.triangles.median} | Throughput=${perf.sanitizer.throughputPerSec}/s`);
  console.log(`  · rag-eval.json    : 2-Way R@1=${(rag.modes.twoWayRrf.recallAt1 * 100).toFixed(1)}% | 3-Way R@1=${(rag.modes.threeWayRrf.recallAt1 * 100).toFixed(1)}%`);
  console.log(`  · verify-summary   : ${verifySummary.pass}/${verifySummary.total} pass (fail=${verifySummary.fail}, skip=${verifySummary.skip})`);
  console.log(`  · mode-parity.json : ${modeParity.scenarios.length}/${modeParity.scenarios.length} scenarios pass`);
}

if (errors.length === 0) {
  console.log('\n✓ 数据血缘与诚实披露口径全部通过（0 缺口）');
  process.exit(0);
} else {
  console.error(`\n✗ 发现 ${errors.length} 项数据血缘/披露缺口:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
