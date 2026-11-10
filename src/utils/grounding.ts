/**
 * KubeVision AI — 文本 grounding（R47 · 任务 D）
 *
 * 【解决什么】模型/仿真器输出里会出现"看起来很像真的"的实体名与数字：
 * 不存在的 Pod、没发生过的百分比。用户无法分辨哪句有出处。这里用**观测数据 +
 * RAG 命中**作为唯一事实源，把找不到出处的实体标注为「未证实」，并按证据强度
 * 钳制根因卡置信度。
 *
 * 【为什么只标实体、不做全文改写】流式正文已经逐字发出，无法回写；能可靠校验的
 * 是"具名实体"（Pod/节点/机架）。数字的出处同样重要，但把每个百分比都做字符串
 * 比对会误伤（模型可能写 42% 而观测是 42.3%），因此只对**明确带单位的高风险数字**
 * 做校验，并在卡片里用证据链承担数字出处。
 */

import type { ClusterContext, RagRunbookDoc } from '@/types/ai';

/** 实体候选正则：pod/worker/node/rack 前缀的具名标识 */
const ENTITY_PATTERN = /\b(?:pod|worker|node|rack)-[a-z0-9][a-z0-9-]{1,60}\b/gi;
/** 带百分号的数字（高风险断言） */
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*%/g;

/**
 * collectGroundedTokens —— 收集"有出处"的实体与数字。
 *
 * @param ctx 本次请求的集群上下文（观测）
 * @param runbooks RAG 命中（知识库出处）
 * @returns 小写 token 集合
 */
export function collectGroundedTokens(
  ctx: ClusterContext,
  runbooks: readonly RagRunbookDoc[],
): Set<string> {
  const tokens = new Set<string>();
  const add = (value: string | null | undefined): void => {
    if (value === null || value === undefined) return;
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > 0) tokens.add(trimmed);
  };

  /* 观测：节点与异常 Pod 的 id/name */
  for (const node of ctx.nodes) {
    add(node.id);
    add(node.name);
  }
  for (const pod of ctx.faultyPods) {
    add(pod.id);
    add(pod.name);
    add(pod.nodeId);
    add(pod.namespace);
  }
  add(ctx.selectedEntityId);

  /* 观测：高风险数字（百分比的两种常见写法） */
  const addPercentages = (value: number | null | undefined): void => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    for (const digits of [0, 1, 2]) {
      add(`${value.toFixed(digits)}%`);
      add(`${Math.round(value * 10 ** digits) / 10 ** digits}%`);
    }
  };
  addPercentages(ctx.clusterHealthScore);
  addPercentages(ctx.totalQps);
  for (const node of ctx.nodes) {
    addPercentages(node.cpuUsage);
    addPercentages(node.memUsage);
  }
  for (const pod of ctx.faultyPods) {
    addPercentages(pod.cpuUsage);
    addPercentages(pod.memoryUsage);
  }

  /* 知识库：标题/id/标签/特征词都算出处 */
  for (const document of runbooks) {
    add(document.id);
    add(document.title);
    for (const term of document.tags ?? []) add(term);
    for (const term of document.featureVocabulary ?? []) add(term);
    /*
     * 检索相似度是服务端真实计算结果，报告里会以百分比出现；
     * 它属于"RAG 命中出处"，必须计入 grounded 百分比，否则会被误标未证实。
     */
    if (document.similarityScore !== undefined) {
      addPercentages(document.similarityScore * 100);
    }
  }
  return tokens;
}

/** grounding 结果 */
export interface GroundingResult {
  /** 标注后的文本 */
  readonly text: string;
  /** 未证实实体（去重） */
  readonly unverified: readonly string[];
}

/**
 * annotateUngrounded —— 对找不到出处的实体/百分比追加「[未证实]」。
 *
 * @param text 原始文本
 * @param ctx 观测上下文
 * @param runbooks RAG 命中
 * @returns 标注结果
 */
export function annotateUngrounded(
  text: string,
  ctx: ClusterContext,
  runbooks: readonly RagRunbookDoc[],
): GroundingResult {
  const grounded = collectGroundedTokens(ctx, runbooks);
  const unverified = new Set<string>();

  const annotated = text
    .replace(ENTITY_PATTERN, (match: string): string => {
      if (grounded.has(match.toLowerCase())) return match;
      unverified.add(match);
      return `${match}[未证实]`;
    })
    .replace(PERCENT_PATTERN, (match: string, digits: string): string => {
      const token = `${digits}%`.toLowerCase();
      if (grounded.has(token)) return match;
      unverified.add(token);
      return `${match}[未证实]`;
    });

  return { text: annotated, unverified: [...unverified] };
}

/**
 * clampConfidence —— 按证据强度钳制置信度。
 *
 * 【规则】有目标观测 + 有 RAG 命中 = 0.92；只有其一 = 0.6；两者皆无 = 0.4。
 * 这是"证据不足时钳制动作卡置信度"在上层卡片上的落地。
 *
 * @param hasObservation 是否有具体 Pod/节点目标
 * @param runbookHits RAG 命中数
 * @returns 钳制后的置信度
 */
export function clampConfidence(hasObservation: boolean, runbookHits: number): number {
  if (hasObservation && runbookHits > 0) return 0.92;
  if (hasObservation || runbookHits > 0) return 0.6;
  return 0.4;
}