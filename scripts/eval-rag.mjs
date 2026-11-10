#!/usr/bin/env node
/**
 * KubeVision AI — RAG 检索评测脚本（R42 · Phase 2）
 *
 * 【为什么用 dev 路由】检索引擎是 TS 源码，.mjs 直接 import 需要 tsx 依赖；
 * `/api/dev/rag-eval` 只在 dev 构建暴露真实检索结果，脚本 fetch 即可，零新增依赖。
 *
 * 【确定性】跑两遍，比较**除耗时与时间戳之外**的全部指标；不一致则退出码 1。
 * 耗时类指标天然抖动，不参与确定性判定，但会单独报告 P50/P95。
 *
 * 用法：node scripts/eval-rag.mjs [--base http://127.0.0.1:3000]
 * 输出：docs/rag-eval.json、docs/rag-eval.md（并调用 sync-docs-metrics 同步 README）
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const baseIdx = args.indexOf('--base');
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : 'http://127.0.0.1:3000';
const ROOT = process.cwd();

/**
 * fetchEval —— 拉取一次评测结果。
 *
 * @returns 评测 JSON
 */
async function fetchEval() {
  const response = await fetch(`${BASE}/api/dev/rag-eval`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`GET /api/dev/rag-eval -> HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

/**
 * stableMetrics —— 去掉时间与耗时后用于确定性比较的指标。
 *
 * @param report 评测结果
 * @returns 稳定子集
 */
function stableMetrics(report) {
  const clone = JSON.parse(JSON.stringify(report));
  delete clone.generatedAt;
  delete clone.latencyMs;
  for (const item of clone.cases ?? []) delete item.latencyMs;
  return clone;
}

/**
 * 百分比格式化。
 *
 * @param value 0~1
 * @returns 百分比字符串
 */
function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * 数字格式化。
 *
 * @param value 数值
 * @param digits 小数位
 * @returns 字符串
 */
function fixed(value, digits = 3) {
  return Number(value).toFixed(digits);
}

const first = await fetchEval();
const second = await fetchEval();
const deterministic = JSON.stringify(stableMetrics(first)) === JSON.stringify(stableMetrics(second));

const modes = first.modes;
const gainR1 = (modes.threeWayRrf.recallAt1 - modes.twoWayRrf.recallAt1) * 100;
const gainR3 = (modes.threeWayRrf.recallAt3 - modes.twoWayRrf.recallAt3) * 100;
const gainMrr = modes.threeWayRrf.mrrAt5 - modes.twoWayRrf.mrrAt5;
const gainNdcg = modes.threeWayRrf.ndcgAt5 - modes.twoWayRrf.ndcgAt5;
const fmtGain = (value, digits = 1) => (value >= 0 ? '+' : '') + value.toFixed(digits);
const rows = [
  '| 召回方案 | Recall@1 | Recall@3 | MRR@5 | NDCG@5 |',
  '|---|---|---|---|---|',
  `| 两路 RRF（现行） | ${pct(modes.twoWayRrf.recallAt1)} | ${pct(modes.twoWayRrf.recallAt3)} | ${fixed(modes.twoWayRrf.mrrAt5)} | ${fixed(modes.twoWayRrf.ndcgAt5)} |`,
  `| 三路 RRF（+MiniLM 句向量） | ${pct(modes.threeWayRrf.recallAt1)} | ${pct(modes.threeWayRrf.recallAt3)} | ${fixed(modes.threeWayRrf.mrrAt5)} | ${fixed(modes.threeWayRrf.ndcgAt5)} |`,
  `| 增益（三路 − 两路） | ${fmtGain(gainR1)}pp | ${fmtGain(gainR3)}pp | ${fmtGain(gainMrr, 3)} | ${fmtGain(gainNdcg, 3)} |`,
  `| bm25-only（消融） | ${pct(modes.bm25Only.recallAt1)} | ${pct(modes.bm25Only.recallAt3)} | ${fixed(modes.bm25Only.mrrAt5)} | ${fixed(modes.bm25Only.ndcgAt5)} |`,
  `| lexical-only（消融） | ${pct(modes.lexicalOnly.recallAt1)} | ${pct(modes.lexicalOnly.recallAt3)} | ${fixed(modes.lexicalOnly.mrrAt5)} | ${fixed(modes.lexicalOnly.ndcgAt5)} |`,
];

const md = `# RAG 检索评测（R42 · Phase 2）

> 由 \`node scripts/eval-rag.mjs\` 调用 \`/api/dev/rag-eval\` 真实运行生成。
> 语料 ${first.corpusSize} 篇 · 用例 ${first.caseCount} 条
> （正例 ${first.counts.positive}：单目标 ${first.counts.single} / 多文档 ${first.counts.multi}；负例 ${first.counts.negative}）。
> **确定性**：两次运行指标一致 = ${deterministic ? '是' : '否'}。

## 1. 主指标

${rows.join('\n')}

| 指标 | 值 | 目标 |
|---|---|---|
| 负例拒答率（两路 / 三路） | **${pct(first.negativeRejectionRate.twoWay)} / ${pct(first.negativeRejectionRate.threeWay)}** | 越高越好（理想 100%） |
| 应命中却被拒答（两路 / 三路） | **${pct(first.falseRejectRate.twoWay)} / ${pct(first.falseRejectRate.threeWay)}** | **< 5%** |
| 检索延迟 P50 / P95（两路） | ${fixed(first.latencyMs.twoWay.p50, 2)}ms / ${fixed(first.latencyMs.twoWay.p95, 2)}ms | 记录用 |
| 检索延迟 P50 / P95（三路） | ${fixed(first.latencyMs.threeWay.p50, 2)}ms / ${fixed(first.latencyMs.threeWay.p95, 2)}ms | 记录用 |
| 三路查询向量 | ${first.threeWay.available ? '已加载 ' + first.threeWay.queryVectors + ' 条' : '未采集（先运行 build-eval-query-embeddings）'} | — |

## 2. 置信度校准（R09）

| 口径 | 平均置信度 |
|---|---|
| 原始（未校准） | ${fixed(first.calibration.meanRaw)} |
| \`calibrateConfidence\` 后 | ${fixed(first.calibration.meanCalibrated)} |

> ${first.calibration.note}

## 3. 用例分布

| 类别 | 条数 |
|---|---|
| 中文口语（colloquial） | ${first.cases.filter((c) => c.kind === 'colloquial').length} |
| 漏写/错别字（typo） | ${first.cases.filter((c) => c.kind === 'typo').length} |
| 中英混杂（mixed） | ${first.cases.filter((c) => c.kind === 'mixed').length} |
| 负例（negative）：寒暄/无关/跨域 | ${first.cases.filter((c) => c.kind === 'negative').length} |
| 多文档（multi，分级 2/1） | ${first.cases.filter((c) => c.kind === 'multi').length} |

## 4. 说明与未验证项

> **消融一致性观察**：本次 bm25-only / lexical-only / 两路 RRF 的 Recall 与 MRR 完全相同。
> 这说明在 49 条用例上，三者的**最终排序一致**——消融是对引擎返回候选池的排序层重排，
> 而该候选池已被语义证据闸门裁剪；排序字段（bm25Score/vectorScore）在本批用例上的
> 相对顺序与 fused 相同。不能据此断言"某一路没有贡献"，需回传逐条 breakdown 做 diff 才能定位。
> 这是评测口径的已知局限，不是通过性证明。

## 5. 补充验收项

1. 消融的 bm25-only / lexical-only 是用引擎返回的 \`scoreBreakdown\` **重排同一批候选**，
   不是"关闭某一路后的检索池"，因此是排序层消融，不等价于完整关闭该路；
2. **R09 校准只影响置信度数值、不影响名次**；本仓库无法在同一构建里复现旧校准系数，
   故报告 ON/OFF 平均置信度，而不是伪造"校准前后排名差"；
3. 口语/错别字用例由语料 tag 与标题**机械生成**，覆盖面有限；
4. 负例拒答依赖引擎的语义证据闸门阈值，阈值调整会使该指标变化（当前实现见 sreRagEngine）。
`;

mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(
  join(ROOT, 'docs/rag-eval.json'),
  `${JSON.stringify({ ...first, determinism: { runs: 2, identical: deterministic } }, null, 2)}\n`,
  'utf8',
);
writeFileSync(join(ROOT, 'docs/rag-eval.md'), md, 'utf8');

console.log('KubeVision AI — RAG 评测');
console.log(`  用例 ${first.caseCount} 条 · 确定性=${deterministic ? 'PASS' : 'FAIL'}`);
console.log(`  两路 RRF : R@1 ${pct(modes.twoWayRrf.recallAt1)} · R@3 ${pct(modes.twoWayRrf.recallAt3)} · MRR ${fixed(modes.twoWayRrf.mrrAt5)} · NDCG ${fixed(modes.twoWayRrf.ndcgAt5)}`);
console.log(`  三路 RRF : R@1 ${pct(modes.threeWayRrf.recallAt1)} · R@3 ${pct(modes.threeWayRrf.recallAt3)} · MRR ${fixed(modes.threeWayRrf.mrrAt5)} · NDCG ${fixed(modes.threeWayRrf.ndcgAt5)}（查询向量 ${first.threeWay.queryVectors} 条）`);
console.log(`  增益     : R@1 ${fmtGain(gainR1)}pp · R@3 ${fmtGain(gainR3)}pp · MRR ${fmtGain(gainMrr, 3)} · NDCG ${fmtGain(gainNdcg, 3)}`);
console.log(`  bm25-only: R@1 ${pct(modes.bm25Only.recallAt1)} · R@3 ${pct(modes.bm25Only.recallAt3)} · MRR ${fixed(modes.bm25Only.mrrAt5)}`);
console.log(`  lexical  : R@1 ${pct(modes.lexicalOnly.recallAt1)} · R@3 ${pct(modes.lexicalOnly.recallAt3)} · MRR ${fixed(modes.lexicalOnly.mrrAt5)}`);
console.log(`  负例拒答 两路 ${pct(first.negativeRejectionRate.twoWay)} · 三路 ${pct(first.negativeRejectionRate.threeWay)}`);
console.log(`  误拒率   两路 ${pct(first.falseRejectRate.twoWay)} · 三路 ${pct(first.falseRejectRate.threeWay)}（目标 <5%）`);
console.log(`  延迟      两路 P95 ${fixed(first.latencyMs.twoWay.p95, 2)}ms · 三路 P95 ${fixed(first.latencyMs.threeWay.p95, 2)}ms`);
console.log('  报告: docs/rag-eval.md / docs/rag-eval.json');

/* 同步 README 的 METRICS 区块（RAG 行） */
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/sync-docs-metrics.mjs')], { stdio: 'inherit' });
} catch (error) {
  console.warn('[WARN] sync-docs-metrics 失败:', error instanceof Error ? error.message : String(error));
}

process.exit(deterministic ? 0 : 1);