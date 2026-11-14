/**
 * KubeVision AI — RAG 评测 dev-only 路由（R44 Phase 4：两路 vs 三路）
 *
 * 【为什么需要它】`retrieveSreRunbooks` 是 TS 源码，`scripts/eval-rag.mjs` 是 .mjs，
 * 直接 import 需要新增 tsx 依赖。本路由只在 dev 构建可用，暴露真实检索指标。
 *
 * 【两路 vs 三路】
 * - 两路：词法余弦（TF-IDF）+ BM25 → RRF；
 * - 三路：额外注入 MiniLM 句向量（从 `docs/summit/artifacts/rag-eval-query-embeddings.json`
 *   读取，由 scripts/build-eval-query-embeddings.mjs 生成）→ 三路 RRF。
 * 查询向量缺失时三路自动退化为两路（不填 0 冒充）。
 *
 * 【指标】Recall@1/@3、MRR@5、NDCG@5、负例拒答率、误拒率、延迟 P50/P95。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { SRE_RUNBOOK_CORPUS, retrieveSreRunbooks } from '@/utils/sreRagEngine';
import { buildRagEvalSet, type RagEvalCase } from '@/utils/ragEvalSet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 参与评测的检索条数 */
const TOP_K = 12;
/** 查询向量集（dev 产物） */
const QUERY_VECTORS_PATH = join(process.cwd(), 'docs/summit/artifacts/rag-eval-query-embeddings.json');

/** 单条用例的两种排名 */
interface CaseResult {
  readonly id: string;
  readonly kind: string;
  readonly query: string;
  readonly expectedIds: readonly string[];
  readonly fusedTwoIds: readonly string[];
  readonly fusedThreeIds: readonly string[];
  readonly bm25Ids: readonly string[];
  readonly lexicalIds: readonly string[];
  readonly latencyTwoMs: number;
  readonly latencyThreeMs: number;
  readonly rawConfidence: number | null;
  readonly calibratedConfidence: number | null;
}

/**
 * decodeBase64ToFloat32 —— base64 → Float32Array。
 *
 * @param base64 字符串
 * @returns 向量
 */
function decodeBase64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * loadQueryVectors —— 读取 dev 查询向量产物。
 *
 * @returns id → Float32Array；文件缺失返回 null
 */
function loadQueryVectors(): ReadonlyMap<string, Float32Array> | null {
  if (!existsSync(QUERY_VECTORS_PATH)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(QUERY_VECTORS_PATH, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const map = new Map<string, Float32Array>();
    for (const [id, base64] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof base64 === 'string') map.set(id, decodeBase64ToFloat32(base64));
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * sortByBreakdown —— 按 scoreBreakdown 字段重排候选。
 *
 * @param docs 引擎返回
 * @param field 字段
 * @returns id 列表
 */
function sortByBreakdown(
  docs: ReadonlyArray<
    (typeof SRE_RUNBOOK_CORPUS)[number] & {
      scoreBreakdown?: { bm25Score: number; lexicalCosine?: number; vectorScore: number };
    }
  >,
  field: 'bm25Score' | 'lexicalCosine',
): string[] {
  return [...docs]
    .sort((a, b) => {
      const av =
        field === 'bm25Score'
          ? (a.scoreBreakdown?.bm25Score ?? -1)
          : (a.scoreBreakdown?.lexicalCosine ?? a.scoreBreakdown?.vectorScore ?? -1);
      const bv =
        field === 'bm25Score'
          ? (b.scoreBreakdown?.bm25Score ?? -1)
          : (b.scoreBreakdown?.lexicalCosine ?? b.scoreBreakdown?.vectorScore ?? -1);
      return bv - av;
    })
    .map((doc) => doc.id);
}

/**
 * reciprocalRank —— 首个期望文档名次倒数。
 *
 * @param ranking 排名
 * @param expected 期望
 * @returns 1/rank 或 0
 */
function reciprocalRank(ranking: readonly string[], expected: readonly string[]): number {
  const index = ranking.findIndex((id) => expected.includes(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

/**
 * ndcgAt5 —— NDCG@5（多文档按 2/1 分级）。
 *
 * @param ranking 排名
 * @param grades 相关度
 * @returns NDCG@5
 */
function ndcgAt5(ranking: readonly string[], grades: Readonly<Record<string, number>>): number {
  const ideal = Object.values(grades)
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((sum, grade, index) => sum + grade / Math.log2(index + 2), 0);
  if (ideal === 0) return 0;
  const dcg = ranking.slice(0, 5).reduce((sum, id, index) => sum + (grades[id] ?? 0) / Math.log2(index + 2), 0);
  return dcg / ideal;
}

/**
 * percentile —— 百分位。
 *
 * @param values 样本
 * @param p 百分位 0~1
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
 * metricsFor —— 对某一路排名计算指标。
 *
 * @param positive 正例
 * @param single 单目标正例
 * @param pick 取排名
 * @returns Recall/MRR/NDCG
 */
function metricsFor(
  positive: readonly CaseResult[],
  single: readonly CaseResult[],
  pick: (item: CaseResult) => readonly string[],
): { recallAt1: number; recallAt3: number; mrrAt5: number; ndcgAt5: number } {
  const recallAt = (k: number): number => {
    if (single.length === 0) return 0;
    const hits = single.filter((item) => pick(item).slice(0, k).some((id) => item.expectedIds.includes(id)));
    return hits.length / single.length;
  };
  const mrr =
    positive.reduce((sum, item) => sum + reciprocalRank(pick(item), item.expectedIds), 0) / (positive.length || 1);
  const ndcg =
    positive.reduce((sum, item) => {
      const grades: Record<string, number> =
        item.expectedIds.length === 1
          ? { [item.expectedIds[0] as string]: 1 }
          : { [item.expectedIds[0] as string]: 2, [item.expectedIds[1] as string]: 1 };
      return sum + ndcgAt5(pick(item), grades);
    }, 0) / (positive.length || 1);
  return { recallAt1: recallAt(1), recallAt3: recallAt(3), mrrAt5: mrr, ndcgAt5: ndcg };
}

/**
 * evaluate —— 跑完整评测（同时跑两路与三路）。
 *
 * @param queryVectors 查询向量（可为 null）
 * @returns 报告
 */
function evaluate(queryVectors: ReadonlyMap<string, Float32Array> | null): unknown {
  const cases: readonly RagEvalCase[] = buildRagEvalSet();
  const results: CaseResult[] = [];

  for (const testCase of cases) {
    const twoStarted = performance.now();
    const docsTwo = retrieveSreRunbooks(testCase.query, 'NONE', [], TOP_K);
    const latencyTwoMs = performance.now() - twoStarted;

    const embedding = queryVectors?.get(testCase.id) ?? null;
    const threeStarted = performance.now();
    const docsThree =
      embedding === null
        ? docsTwo
        : retrieveSreRunbooks(testCase.query, 'NONE', [], TOP_K, [], embedding);
    const latencyThreeMs = performance.now() - threeStarted;

    const firstHit = docsThree.find((doc) => testCase.expectedIds.includes(doc.id));
    /*
     * rawConfidence 取引擎归一化后的融合分 fusedScore（校准前），
     * calibratedConfidence 直接取引擎回填的 similarityScore（避免再次调用 calibrateConfidence 造成二次校准）。
     */
    const rawConfidence = firstHit?.scoreBreakdown?.fusedScore ?? null;
    const calibratedConfidence = firstHit?.similarityScore ?? null;
    results.push({
      id: testCase.id,
      kind: testCase.kind,
      query: testCase.query,
      expectedIds: testCase.expectedIds,
      fusedTwoIds: docsTwo.map((doc) => doc.id),
      fusedThreeIds: docsThree.map((doc) => doc.id),
      bm25Ids: sortByBreakdown(docsThree, 'bm25Score'),
      lexicalIds: sortByBreakdown(docsThree, 'lexicalCosine'),
      latencyTwoMs,
      latencyThreeMs,
      rawConfidence,
      calibratedConfidence,
    });
  }

  const positive = results.filter((item) => item.expectedIds.length > 0);
  const single = positive.filter((item) => item.kind !== 'multi');
  const negatives = results.filter((item) => item.kind === 'negative');

  const two = metricsFor(positive, single, (item) => item.fusedTwoIds);
  const three = metricsFor(positive, single, (item) => item.fusedThreeIds);
  const bm25 = metricsFor(positive, single, (item) => item.bm25Ids);
  const lexical = metricsFor(positive, single, (item) => item.lexicalIds);

  const slicePair = (subsetPos: readonly CaseResult[], subsetSingle: readonly CaseResult[]) => ({
    count: subsetPos.length,
    twoWayRrf: metricsFor(subsetPos, subsetSingle, (item) => item.fusedTwoIds),
    threeWayRrf: metricsFor(subsetPos, subsetSingle, (item) => item.fusedThreeIds),
  });
  const colloquialCases = single.filter((item) => item.kind === 'colloquial');
  const typoCases = single.filter((item) => item.kind === 'typo');
  const mixedCases = single.filter((item) => item.kind === 'mixed');
  const nonTypoSingleCases = single.filter((item) => item.kind !== 'typo');
  const multiCases = positive.filter((item) => item.kind === 'multi');

  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const confidences = results.map((item) => item.rawConfidence).filter((value): value is number => value !== null);
  const calibrated = results
    .map((item) => item.calibratedConfidence)
    .filter((value): value is number => value !== null);

  const rejection = (pick: (item: CaseResult) => readonly string[]): number =>
    negatives.length === 0 ? 0 : negatives.filter((item) => pick(item).length === 0).length / negatives.length;
  const falseReject = (pick: (item: CaseResult) => readonly string[]): number =>
    positive.length === 0 ? 0 : positive.filter((item) => pick(item).length === 0).length / positive.length;

  const latenciesTwo = results.map((item) => item.latencyTwoMs);
  const latenciesThree = results.map((item) => item.latencyThreeMs);

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
    threeWay: { available: queryVectors !== null, queryVectors: queryVectors?.size ?? 0 },
    modes: {
      twoWayRrf: two,
      threeWayRrf: three,
      bm25Only: bm25,
      lexicalOnly: lexical,
    },
    byKind: {
      colloquial: slicePair(colloquialCases, colloquialCases),
      typo: slicePair(typoCases, typoCases),
      mixed: slicePair(mixedCases, mixedCases),
      nonTypoSingle: slicePair(nonTypoSingleCases, nonTypoSingleCases),
      multi: slicePair(multiCases, []),
    },
    negativeRejectionRate: {
      twoWay: rejection((item) => item.fusedTwoIds),
      threeWay: rejection((item) => item.fusedThreeIds),
    },
    falseRejectRate: {
      twoWay: falseReject((item) => item.fusedTwoIds),
      threeWay: falseReject((item) => item.fusedThreeIds),
    },
    latencyMs: {
      twoWay: {
        p50: percentile(latenciesTwo, 0.5),
        p95: percentile(latenciesTwo, 0.95),
        mean: mean(latenciesTwo),
        count: latenciesTwo.length,
      },
      threeWay: {
        p50: percentile(latenciesThree, 0.5),
        p95: percentile(latenciesThree, 0.95),
        mean: mean(latenciesThree),
        count: latenciesThree.length,
      },
    },
    calibration: {
      meanRaw: mean(confidences),
      meanCalibrated: mean(calibrated),
      note: 'meanRaw 取未经 Sigmoid 校准的融合终值 fusedScore，meanCalibrated 取引擎输出的 similarityScore（无二次重复校准；校准只映射置信度数值、不改变排名顺序）',
    },
    cases: results.map((item) => ({
      id: item.id,
      kind: item.kind,
      query: item.query,
      expectedIds: item.expectedIds,
      fusedTwoIds: item.fusedTwoIds,
      fusedThreeIds: item.fusedThreeIds,
    })),
  };
}

/** GET /api/dev/rag-eval —— 仅 dev 构建可用（?corpus=1 / ?cases=1 / 默认评测） */
export async function GET(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'dev only' }, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  if (params.get('cases') === '1') {
    return NextResponse.json(buildRagEvalSet());
  }
  if (params.get('corpus') === '1') {
    return NextResponse.json(
      SRE_RUNBOOK_CORPUS.map((doc) => ({ id: doc.id, title: doc.title, symptom: doc.symptom, tags: doc.tags })),
    );
  }
  return NextResponse.json(evaluate(loadQueryVectors()));
}