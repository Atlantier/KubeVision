/**
 * KubeVision AI — RAG 评测 dev-only 路由（R42 · Phase 2）
 *
 * 【为什么需要它】`retrieveSreRunbooks` 在 TS 源码里，`scripts/eval-rag.mjs` 是 .mjs，
 * 直接 import TS 需要新增 tsx 依赖（违反"不新增依赖"）。本路由只在 dev 构建可用，
 * 把检索引擎的真实运行结果暴露为 JSON，脚本 fetch 两次即可做确定性与指标评测。
 *
 * 【指标口径】
 * - Recall@1/@3：单目标正例中，期望文档是否进入第 1 / 前 3；
 * - MRR@5：第一个相关文档名次的倒数（缺失记 0）；
 * - NDCG@5：多文档用例按分级相关度（2/1/0）计算；
 * - 负例拒答率：8 条负例中检索返回空数组的比例（应接近 100%）；
 * - 误拒率：正例中检索返回空数组的比例（越低越好，目标 <5%）。
 *
 * 【消融】用 `scoreBreakdown` 重排同一批候选，得到 bm25-only / lexical-only
 * （lexical = 现有 vectorScore 路）两种对照；两路 RRF 即引擎原序。
 *
 * 【诚实边界】R09 校准只改变置信度数值、不改变名次；这里报告校准前后的
 * 平均置信度差值，不伪造"校准前后排名变化"。
 */

import { NextResponse } from 'next/server';
import { SRE_RUNBOOK_CORPUS, calibrateConfidence, retrieveSreRunbooks } from '@/utils/sreRagEngine';
import { buildRagEvalSet, type RagEvalCase } from '@/utils/ragEvalSet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 参与评测的检索条数（取满 12 篇，便于消融重排） */
const TOP_K = 12;

/** 单条用例的判定结果 */
interface CaseResult {
  readonly id: string;
  readonly kind: string;
  readonly query: string;
  /** 引擎原序（两路 RRF）的文档 id */
  readonly fusedIds: readonly string[];
  /** bm25-only 重排结果 */
  readonly bm25Ids: readonly string[];
  /** lexical-only 重排结果 */
  readonly lexicalIds: readonly string[];
  readonly expectedIds: readonly string[];
  /** 检索耗时（毫秒） */
  readonly latencyMs: number;
  /** 原始相似度（若命中） */
  readonly rawConfidence: number | null;
  /** 校准后置信度 */
  readonly calibratedConfidence: number | null;
}

/**
 * sortByBreakdown —— 按 scoreBreakdown 的指定字段重排候选。
 *
 * @param docs 引擎返回的文档（含 scoreBreakdown）
 * @param field 排序字段
 * @returns 重排后的 id 列表
 */
function sortByBreakdown(
  docs: ReadonlyArray<(typeof SRE_RUNBOOK_CORPUS)[number] & {
    scoreBreakdown?: { bm25Score: number; vectorScore: number };
  }>,
  field: 'bm25Score' | 'vectorScore',
): string[] {
  return [...docs]
    .sort((a, b) => (b.scoreBreakdown?.[field] ?? -1) - (a.scoreBreakdown?.[field] ?? -1))
    .map((doc) => doc.id);
}

/**
 * reciprocalRank —— 首个期望文档的名次倒数（前 topN）。
 *
 * @param ranking 排名 id 列表
 * @param expected 期望 id 列表
 * @returns 1/rank；未命中返回 0
 */
function reciprocalRank(ranking: readonly string[], expected: readonly string[]): number {
  const index = ranking.findIndex((id) => expected.includes(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

/**
 * dcg —— 折损累计增益（前 topN）。
 *
 * @param ranking 排名 id 列表
 * @param grades 相关度表
 * @param topN 截断
 * @returns DCG
 */
function dcg(ranking: readonly string[], grades: Readonly<Record<string, number>>, topN: number): number {
  let sum = 0;
  ranking.slice(0, topN).forEach((id, index): void => {
    sum += (grades[id] ?? 0) / Math.log2(index + 2);
  });
  return sum;
}

/**
 * ndcgAt5 —— NDCG@5。
 *
 * @param ranking 排名 id 列表
 * @param grades 相关度表
 * @returns NDCG@5
 */
function ndcgAt5(ranking: readonly string[], grades: Readonly<Record<string, number>>): number {
  const ideal = Object.values(grades)
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((sum, grade, index) => sum + grade / Math.log2(index + 2), 0);
  if (ideal === 0) return 0;
  return dcg(ranking, grades, 5) / ideal;
}

/**
 * percentile —— 百分位（linear interpolation）。
 *
 * @param values 已排序或未排序样本
 * @param p 百分位（0~1）
 * @returns 分位值
 */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

/**
 * evaluate —— 跑完整评测集，返回指标与逐条结果。
 *
 * @returns 评测报告
 */
function evaluate(): unknown {
  const cases: readonly RagEvalCase[] = buildRagEvalSet();
  const results: CaseResult[] = [];

  for (const testCase of cases) {
    const startedAt = performance.now();
    const docs = retrieveSreRunbooks(testCase.query, 'NONE', [], TOP_K);
    const latencyMs = performance.now() - startedAt;
    const fusedIds = docs.map((doc) => doc.id);
    const bm25Ids = sortByBreakdown(docs, 'bm25Score');
    const lexicalIds = sortByBreakdown(docs, 'vectorScore');
    const firstHit = docs.find((doc) => testCase.expectedIds.includes(doc.id));
    const rawConfidence = firstHit?.similarityScore ?? null;
    results.push({
      id: testCase.id,
      kind: testCase.kind,
      query: testCase.query,
      fusedIds,
      bm25Ids,
      lexicalIds,
      expectedIds: testCase.expectedIds,
      latencyMs,
      rawConfidence,
      calibratedConfidence: rawConfidence === null ? null : calibrateConfidence(rawConfidence),
    });
  }

  const positive = results.filter((item) => item.expectedIds.length > 0);
  const single = positive.filter((item) => item.kind !== 'multi');
  const negatives = results.filter((item) => item.kind === 'negative');

  /** 计算某一路的指标 */
  const metricsFor = (pick: (item: CaseResult) => readonly string[]) => {
    const recallAt = (k: number): number => {
      const hits = single.filter((item) => pick(item).slice(0, k).some((id) => item.expectedIds.includes(id)));
      return single.length === 0 ? 0 : hits.length / single.length;
    };
    const mrr =
      positive.reduce((sum, item) => sum + reciprocalRank(pick(item), item.expectedIds), 0) /
      (positive.length || 1);
    return { recallAt1: recallAt(1), recallAt3: recallAt(3), mrrAt5: mrr };
  };

  /* NDCG 单独算，避免在 metricsFor 里塞复杂分级逻辑 */
  const ndcgFor = (pick: (item: CaseResult) => readonly string[]): number => {
    const positiveResults = positive;
    const total = positiveResults.reduce((sum, item) => {
      const grades: Record<string, number> =
        item.expectedIds.length === 1
          ? { [item.expectedIds[0] as string]: 1 }
          : { [item.expectedIds[0] as string]: 2, [item.expectedIds[1] as string]: 1 };
      return sum + ndcgAt5(pick(item), grades);
    }, 0);
    return positiveResults.length === 0 ? 0 : total / positiveResults.length;
  };

  const fused = metricsFor((item) => item.fusedIds);
  const bm25 = metricsFor((item) => item.bm25Ids);
  const lexical = metricsFor((item) => item.lexicalIds);

  const negativeRejection =
    negatives.length === 0 ? 0 : negatives.filter((item) => item.fusedIds.length === 0).length / negatives.length;
  const falseReject = positive.length === 0 ? 0 : positive.filter((item) => item.fusedIds.length === 0).length / positive.length;
  const latencies = results.map((item) => item.latencyMs);
  const rawConfidences = results
    .map((item) => item.rawConfidence)
    .filter((value): value is number => value !== null);
  const calibratedConfidences = results
    .map((item) => item.calibratedConfidence)
    .filter((value): value is number => value !== null);
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    generatedAt: new Date().toISOString(),
    corpusSize: SRE_RUNBOOK_CORPUS.length,
    caseCount: cases.length,
    counts: {
      positive: positive.length,
      single: single.length,
      multi: positive.length - single.length,
      negative: negatives.length,
    },
    modes: {
      twoWayRrf: { ...fused, ndcgAt5: ndcgFor((item) => item.fusedIds) },
      bm25Only: { ...bm25, ndcgAt5: ndcgFor((item) => item.bm25Ids) },
      lexicalOnly: { ...lexical, ndcgAt5: ndcgFor((item) => item.lexicalIds) },
    },
    negativeRejectionRate: negativeRejection,
    falseRejectRate: falseReject,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      mean: mean(latencies),
      count: latencies.length,
    },
    calibration: {
      meanRaw: mean(rawConfidences),
      meanCalibrated: mean(calibratedConfidences),
      note: '校准只改变置信度数值，不改变排序名次；R09 校准系数前后不可在同一次运行中复现，故报告 ON/OFF 置信度均值而非伪造排名差',
    },
    cases: results.map((item) => ({
      id: item.id,
      kind: item.kind,
      query: item.query,
      expectedIds: item.expectedIds,
      fusedIds: item.fusedIds,
      latencyMs: Math.round(item.latencyMs * 1000) / 1000,
    })),
  };
}

/** GET /api/dev/rag-eval —— 仅 dev 构建可用 */
export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'dev only' }, { status: 404 });
  }
  return NextResponse.json(evaluate());
}