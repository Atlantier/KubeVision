#!/usr/bin/env node
/**
 * KubeVision AI — 文档数字一致性校验（R55 · 任务 9）
 *
 * 【解决什么问题】README / 白皮书 / PPT 文案里的性能与验收数字此前靠手填，
 * 一次 benchmark 重跑后就会出现"文档写 403、数据文件写 420"的漂移。
 * 本脚本以 `docs/performance.json` / `docs/rag-eval.json` / `docs/verify-summary.json`
 * 为唯一事实源，校验：
 *   1. 关键数字是否出现在 README / 白皮书 / PPT 文案中；
 *   2. 是否残留已知的旧数字/旧口径（307、11.14ms、K8S_API_URL、旧按钮名…）；
 *   3. 验收通过数是否与 verify-summary 一致。
 *
 * 退出码：0 一致；1 存在漂移（verify 会失败）。
 * 用法：node scripts/check-docs-consistency.mjs [--json]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes('--json');
const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
const readText = (file) => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : '');

const perf = readJson('docs/performance.json');
const rag = readJson('docs/rag-eval.json');
const verify = readJson('docs/verify-summary.json');

/** 千分位格式化 */
const comma = (value) => Number(value).toLocaleString('en-US');
const fixed = (value, digits = 2) => Number(value).toFixed(digits);

/** 必须出现的关键数字（允许多种排版，做归一化后匹配） */
const REQUIRED_NUMBERS = [
  { name: 'Draw Calls 中位', value: String(perf.rendering.drawCalls.median), aliases: [String(perf.rendering.drawCalls.median)] },
  { name: 'Triangles 中位', value: comma(perf.rendering.triangles.median), aliases: [comma(perf.rendering.triangles.median), String(perf.rendering.triangles.median)] },
  { name: 'RAG 均值延迟', value: `${fixed(perf.rag.latencyMs.mean)}ms`, aliases: [`${fixed(perf.rag.latencyMs.mean)}ms`, `${fixed(perf.rag.latencyMs.mean)} ms`] },
  { name: 'RAG P95 延迟', value: `${fixed(perf.rag.latencyMs.p95)}ms`, aliases: [`${fixed(perf.rag.latencyMs.p95)}ms`, `${fixed(perf.rag.latencyMs.p95)} ms`] },
  { name: '脱敏吞吐', value: `${comma(perf.sanitizer.throughputPerSec)} 条/秒`, aliases: [comma(perf.sanitizer.throughputPerSec), String(perf.sanitizer.throughputPerSec)] },
  { name: '首屏 First Load', value: '176 kB', aliases: ['176 kB', '176kB'] },
  { name: '验收通过数', value: `${verify.pass}/${verify.total}`, aliases: [`通过 ${verify.pass}`, `${verify.pass} 项`, `${verify.pass}/${verify.total}`] },
];

/** 已知旧数字 / 旧口径：出现即视为漂移（尽量用足够长的串，避免误伤普通数字） */
const STALE_TOKENS = [
  '307',
  '11.14ms',
  '9,573',
  '14,931',
  '16,418',
  '188,738',
  '84.8 kB',
  '172 kB',
  'K8S_API_URL',
  'useSpeechRecognition',
  '混沌故障演练',
  '确认并执行自愈',
  '「快照诊断」',
];

/** 需要校验的文档 */
const DOCS = [
  { name: 'README.md', file: 'README.md', numbers: true },
  { name: '白皮书', file: 'docs/COMPETITION_TECHNICAL_WHITEPAPER.md', numbers: true },
  { name: 'PPT 文案', file: 'docs/KubeVision_PITCH_COPY.md', numbers: true },
  { name: 'PPT HTML', file: 'docs/pitch/index.html', numbers: false },
];

const results = [];
for (const doc of DOCS) {
  const text = readText(doc.file);
  if (text.length === 0) {
    results.push({ doc: doc.name, file: doc.file, status: 'skip', detail: '文件不存在（可选）' });
    continue;
  }
  const problems = [];
  if (doc.numbers) {
    for (const item of REQUIRED_NUMBERS) {
      const hit = item.aliases.some((alias) => text.includes(alias));
      if (!hit) problems.push(`缺少最新数字：${item.name}=${item.value}`);
    }
  }
  for (const token of STALE_TOKENS) {
    if (text.includes(token)) problems.push(`残留旧口径/旧数字："${token}"`);
  }
  results.push({ doc: doc.name, file: doc.file, status: problems.length === 0 ? 'pass' : 'fail', problems });
}

/* RAG 评测数字来自另一文件，单独校验 README/白皮书是否同步了 R@1 口径 */
const ragExpected = [`${(rag.modes.twoWayRrf.recallAt1 * 100).toFixed(1)}%`, `${(rag.modes.threeWayRrf.recallAt1 * 100).toFixed(1)}%`];
for (const doc of DOCS.filter((entry) => entry.numbers)) {
  const text = readText(doc.file);
  if (text.length === 0) continue;
  const missing = ragExpected.filter((value) => !text.includes(value));
  if (missing.length > 0) {
    const target = results.find((entry) => entry.file === doc.file);
    target.status = 'fail';
    target.problems = [...(target.problems ?? []), `RAG 评测 Recall@1 未同步：缺少 ${missing.join(' / ')}`];
  }
}

const failed = results.filter((entry) => entry.status === 'fail');

if (JSON_OUT) {
  console.log(JSON.stringify({ performanceGeneratedAt: perf.generatedAt, verifyGeneratedAt: verify.generatedAt, results }, null, 2));
} else {
  console.log('文档数字一致性校验（check-docs-consistency）');
  console.log(`  事实源：performance.json @ ${perf.generatedAt}`);
  console.log(`          verify-summary.json @ ${verify.generatedAt}（${verify.pass}/${verify.total}）`);
  for (const entry of results) {
    if (entry.status === 'skip') {
      console.log(`  · ${entry.doc}：跳过（${entry.detail}）`);
    } else if (entry.status === 'pass') {
      console.log(`  ✓ ${entry.doc}：数字与口径一致`);
    } else {
      console.log(`  ✗ ${entry.doc}：${entry.problems.length} 处漂移`);
      for (const problem of entry.problems.slice(0, 8)) console.log(`      - ${problem}`);
    }
  }
  console.log(failed.length === 0 ? '\n  ✓ 文档与脚本数字一致' : `\n  ✗ ${failed.length} 份文档存在漂移，请运行对应脚本刷新后再提交`);
}

process.exit(failed.length === 0 ? 0 : 1);