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

/** 性能事实源中允许出现的数值 */
const draw = perf.rendering.drawCalls;
const tri = perf.rendering.triangles;
const ragLatency = perf.rag.latencyMs;
const throughput = perf.sanitizer.throughputPerSec;
const firstLoadKb = (() => {
  const line = (perf.bundle?.routes ?? []).find((row) => row.includes('First Load') || row.trim().startsWith('┌'));
  const match = typeof line === 'string' ? line.match(/(\d+)\s*kB\s*$/) : null;
  return match === null ? null : Number(match[1]);
})();

/**
 * findContradictions —— 交叉核对：同一指标在文档里出现的值必须与事实源一致。
 *
 * 【为什么需要】"缺少最新数字"只能发现漏更新，发现不了"文档 A 写 423、文档 B 写 420"这种自相矛盾。
 * 这里对常见指标做上下文抽取：draw calls（允许 min~max 区间）、RAG 延迟（允许均值/中位/P95）、
 * 三角面、脱敏吞吐、首屏体积。发现不一致即 fail。
 */
function findContradictions(text, docName) {
  const problems = [];
  const allowed = (values) => values.filter((value) => typeof value === 'number' && Number.isFinite(value));

  /* draw calls：单个值必须等于中位；区间必须在实测 min~max 内 */
  for (const match of text.matchAll(/(?:draw\s*calls?|Draw Calls)[^\d\n]{0,16}(\d{2,4})(?:\s*[~～\-–]\s*(\d{2,4}))?/gi)) {
    const first = Number(match[1]);
    const second = match[2] === undefined ? null : Number(match[2]);
    if (second !== null) {
      if (first < draw.min || first > draw.max || second < draw.min || second > draw.max) {
        problems.push(`${docName}: draw calls 区间 ${first}~${second} 超出实测 ${draw.min}~${draw.max}`);
      }
    } else if (first !== draw.median) {
      problems.push(`${docName}: draw calls ${first} ≠ 中位 ${draw.median}`);
    }
  }

  /* RAG 延迟：允许均值/中位/P95；跳过"两路/三路"评测表里的引擎延迟 */
  for (const match of text.matchAll(/(?:RAG[^\d\n]{0,12}|检索[^\d\n]{0,6})(\d+\.\d{2})\s*ms/gi)) {
    const context = text.slice(Math.max(0, match.index - 30), match.index + 30);
    if (/两路|三路|1\.82|1\.98/.test(context)) continue;
    const value = Number(match[1]);
    if (!allowed([ragLatency.mean, ragLatency.median, ragLatency.p95]).includes(value)) {
      problems.push(`${docName}: RAG 延迟 ${value}ms 不在事实源 ${ragLatency.mean}/${ragLatency.median}/${ragLatency.p95}ms 内`);
    }
  }

  /* 三角面 */
  for (const match of text.matchAll(/(?:Triangles|三角面|三角形)[^\d\n]{0,14}([\d,]{5,9})/gi)) {
    const value = Number(match[1].replace(/,/g, ''));
    if (value !== tri.median) problems.push(`${docName}: 三角面 ${match[1]} ≠ 中位 ${tri.median}`);
  }

  /* 脱敏吞吐 */
  for (const match of text.matchAll(/([\d,]{3,9})\s*条\/秒/g)) {
    /* 跳过指标要求（如 "> 1,000 条/秒"）与目标/阈值语境，只核对"实测"陈述 */
    const context = text.slice(Math.max(0, match.index - 24), match.index + 12);
    if (/[>≥]|目标|要求|阈值/.test(context)) continue;
    const value = Number(match[1].replace(/,/g, ''));
    if (value !== throughput) problems.push(`${docName}: 脱敏吞吐 ${match[1]} 条/秒 ≠ ${throughput}`);
  }

  /* 首屏 First Load（若文档出现该口径） */
  if (firstLoadKb !== null) {
    for (const match of text.matchAll(/(?:First Load JS|First Load|首屏 JS)[^\d\n]{0,28}(\d{1,3})\s*kB/gi)) {
      const value = Number(match[1]);
      if (value !== firstLoadKb) problems.push(`${docName}: 首屏 First Load ${value}kB ≠ ${firstLoadKb}kB`);
    }
  }

  return problems;
}

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
  problems.push(...findContradictions(text, doc.name));
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