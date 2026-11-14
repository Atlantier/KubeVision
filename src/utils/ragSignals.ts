/**
 * KubeVision AI — RAG 混合检索信号可视化工具
 *
 * 【这个文件解决什么】
 * `sreRagEngine.ts` 里的三路混合检索是一个数学过程：BM25 稀疏匹配 +
 * TF-IDF 加权向量余弦 + 拓扑/上下文先验，再经 RRF 倒数秩融合与
 * Sigmoid 校准。对使用者而言，最终只看到一个「匹配度 92.4%」——
 * 这个数字**无法自证**：它可能是三路都强，也可能是某一路特别强撑起来的。
 *
 * 本模块把 engine 回填的 `scoreBreakdown` 转成可直接渲染的贡献份额，
 * 让「这个分数由什么构成」在界面上可读。根因卡与推理链共用同一份
 * 计算，避免两处各写一套导致口径漂移。
 *
 * 【为何放在 utils 而非组件内】
 * 1. 两个组件（RootCauseAlert / AgentThoughtChain）都要用；
 * 2. 它是纯函数，可独立推理与复用，不属于任何 UI；
 * 3. 贡献份额的归一化规则是**口径问题**，散落在组件里最容易出错。
 */

import type { RagRunbookDoc } from '@/types/ai';

/* ========================================================================== */
/* 类型契约                                                                    */
/* ========================================================================== */

/**
 * RagSignalKey —— 三路检索信号 + 融合终值。
 *
 * 【为何把 rrf 也列进来】前三路是**输入**，rrf 是**输出**。
 * 单独展示输入能让用户看到"证据构成"，单独展示输出能给"最终结论"。
 * 二者对照才能发现「三路都弱却融合分高」这类异常（说明校准段位偏高）。
 */
export type RagSignalKey = 'bm25' | 'dense' | 'topology' | 'semantic';

/**
 * RagSignal —— 单路检索信号的展示契约。
 *
 * 【score 与 share 的区别】
 * - score：该路原始得分（0~1），反映"这一路有多强"；
 * - share：该路在**总证据中的占比**（0~1，三路相加为 1），
 *   反映"这次判定主要靠哪一路"。
 * 两者不可混用：score 都低时 share 仍会归一化成 100%，
 * 此时应结合 rrfScore 判断绝对强度。
 */
export interface RagSignal {
  readonly key: RagSignalKey;
  /** 中文短标签（图例用） */
  readonly label: string;
  /** 英文术语（技术说明用） */
  readonly term: string;
  /** 原始得分 [0,1] */
  readonly score: number;
  /** 占总证据的份额 [0,1]，三路之和为 1 */
  readonly share: number;
  /** 分段条的填充色类名 */
  readonly barClass: string;
  /** 文字/图例色类名 */
  readonly textClass: string;
  /** 圆点/边框类名 */
  readonly dotClass: string;
  /** 面向用户的解释（tooltip） */
  readonly description: string;
  /**
   * R44：该路信号本次是否真正参与打分。
   * false 表示"不可用"（如句向量模型/查询向量未就绪），界面应显示"未就绪"，
   * 绝不能画成 0 分条——"没有这一路"和"这一路得了 0 分"语义完全不同。
   */
  readonly available?: boolean;
}

/**
 * RagSignalBreakdown —— 一次检索的完整信号拆解。
 *
 * 【available 的意义】当核因卡的 ragReferences 为空、或引擎未回填
 * scoreBreakdown 时，本结构不可用。此时组件应**隐藏**可视化区，
 * 而不是渲染一条全 0 的假进度条——后者会让用户以为"检索了但全没命中"，
 * 与"根本没检索"是完全不同的语义。
 */
export interface RagSignalBreakdown {
  /** 是否有可用的拆解数据 */
  readonly available: boolean;
  /** 三路信号（bm25 / dense / topology），按 share 降序便于阅读 */
  readonly signals: readonly RagSignal[];
  /** 多路融合终值 [0,1]（经候选池与证据门控归一化后的 fused 分，未做 Sigmoid 校准） */
  readonly fusedScore: number;
  /** 原始 RRF 倒数秩排名一致性分 [0,1]（仅反映各路名次是否一致，不反映绝对证据强弱） */
  readonly rrfScore: number;
  /** 校准后的置信度 [0,1]（顶层相似度 similarityScore，若无则退回 fusedScore） */
  readonly calibratedScore: number;
  /** 进入 RRF 排序池的候选文档数 C（缺失时为 null） */
  readonly candidatePoolSize: number | null;
  /** 本次检索总语料篇数 N（缺失时为 null） */
  readonly corpusSize: number | null;
  /** 候选池规模折减系数 min(1, C / min(N, 4))（缺失时为 null） */
  readonly poolFactor: number | null;
  /** 命中手册的主标识（用于标题，如 RUNBOOK-K8S-042） */
  readonly topDocId: string | null;
  /** 主导信号（share 最大的那一路） */
  readonly dominantKey: RagSignalKey | null;
  /**
   * RRF 是否达到排名满值（每条路由都排第 1）。
   *
   * 【为何单独暴露】rrfScore = 1.0 的成因是"三路排名完全一致"，
   * 而不是"三路得分都高"。二者是完全不同的信息，界面必须能分辨，
   * 否则会把"排名一致"误读成"证据强"。
   */
  readonly rrfIsRankPerfect: boolean;
}

/* ========================================================================== */
/* 常量：信号视觉契约                                                          */
/* ========================================================================== */

/**
 * 三路信号的视觉定义。
 *
 * 【配色语义与项目状态色一致】
 * - BM25 稀疏 → cyan（青）：词频统计，冷色，理性计数
 * - Dense 语义 → emerald（翠绿）：语义命中，正反馈色
 * - Topology 先验 → amber（琥珀）：外部上下文加权，注意态
 * 三者在此项目中各自有既有语义，沿用比另造一套更易读。
 */
const SIGNAL_VISUALS: Readonly<
  Record<RagSignalKey, { label: string; term: string; barClass: string; textClass: string; dotClass: string; description: string }>
> = {
  bm25: {
    label: '稀疏词频',
    term: 'BM25',
    barClass: 'bg-cyan-400',
    textClass: 'text-cyan-300',
    dotClass: 'bg-cyan-400',
    description: 'Okapi BM25 关键词精确匹配：专业术语（如 oom_score_adj / vxlan）命中越多分越高',
  },
  dense: {
    label: '语义向量',
    term: 'Dense',
    barClass: 'bg-emerald-400',
    textClass: 'text-emerald-300',
    dotClass: 'bg-emerald-400',
    description: 'TF-IDF 加权向量余弦相似度：衡量查询与手册的语义方向一致性',
  },
  topology: {
    label: '拓扑先验',
    term: 'Topology',
    barClass: 'bg-amber-400',
    textClass: 'text-amber-300',
    dotClass: 'bg-amber-400',
    description: '故障场景 / 受影响 Pod / 3D 空间归属的上下文加权',
  },
  /* R44：第四路句向量（MiniLM） */
  semantic: {
    label: '句向量',
    term: 'MiniLM',
    barClass: 'bg-violet-400',
    textClass: 'text-violet-300',
    dotClass: 'bg-violet-400',
    description: 'MiniLM 384 维句向量余弦：模型或查询向量未就绪时显示“未就绪”，不填 0 冒充',
  },
};

/** 各信号的展示顺序（固定顺序，避免排序变化导致图例跳动） */
const SIGNAL_ORDER: readonly RagSignalKey[] = ['bm25', 'dense', 'topology', 'semantic'];

/* ========================================================================== */
/* 核心：从 Runbook 列表推导信号拆解                                            */
/* ========================================================================== */

/**
 * buildRagSignalBreakdown —— 从命中的 Runbook 列表推导三路信号拆解。
 *
 * 【为何取 Top-1 的拆解而非所有文档的平均】
 * 用户看到的"匹配度"就是 Top-1 的分数，对应地，构成这个分数的证据
 * 也应当取 Top-1 自己的拆解。取平均会得到一个不存在于任何单篇文档上的
 * 中间值，解释力反而下降。
 *
 * 【归一化方式：直接按原始分比例】三路得分本身都是 [0,1] 且量纲一致
 * （引擎在回填 scoreBreakdown 前已各自归一化），因此直接按比例分配份额
 * 是诚实的。若某路为 0，其份额就是 0——这正确地表达了"这一路没提供证据"。
 *
 * @param docs 命中的 Runbook 列表（通常来自 RootCauseAlertProps.ragReferences）
 * @returns 可视化所需的信号拆解
 */
export function buildRagSignalBreakdown(docs: readonly RagRunbookDoc[]): RagSignalBreakdown {
  /* ---- 1. 找到第一份带 scoreBreakdown 的文档（通常即 Top-1） ---- */
  const topDoc = docs.find(
    (doc): boolean => doc.scoreBreakdown !== undefined,
  );

  if (topDoc === undefined || topDoc.scoreBreakdown === undefined) {
    return {
      available: false,
      signals: [],
      fusedScore: 0,
      rrfScore: 0,
      calibratedScore: 0,
      candidatePoolSize: null,
      corpusSize: null,
      poolFactor: null,
      topDocId: docs[0]?.id ?? null,
      dominantKey: null,
      rrfIsRankPerfect: false,
    };
  }

  const breakdown = topDoc.scoreBreakdown;

  /* ---- 2. 三路原始分（clamp 到 [0,1] 防御异常值画出超宽条） ---- */
  const semanticAvailable = breakdown.semanticAvailable === true;
  const rawScores: Record<RagSignalKey, number> = {
    bm25: clamp01(breakdown.bm25Score),
    dense: clamp01(breakdown.lexicalCosine ?? breakdown.vectorScore),
    topology: clamp01(breakdown.contextBoost),
    semantic: semanticAvailable ? clamp01(breakdown.semanticScore ?? 0) : 0,
  };

  /* ---- 3. 归一化为份额（不可用的一路不计入分母） ---- */
  const total =
    rawScores.bm25 +
    rawScores.dense +
    rawScores.topology +
    (semanticAvailable ? rawScores.semantic : 0);

  const signals: RagSignal[] = SIGNAL_ORDER.map((key): RagSignal => {
    const visual = SIGNAL_VISUALS[key];
    const score = rawScores[key];
    const available = key === 'semantic' ? semanticAvailable : true;
    /**
     * total 为 0 时三路均无证据：此时份额全部置 0（而非各占 1/3）。
     * 各占 1/3 会画出"三等分满条"，暗示三路都有贡献，是误导。
     */
    const share = total > 0 ? score / total : 0;
    return {
      key,
      label: visual.label,
      term: visual.term,
      score,
      share,
      available,
      barClass: visual.barClass,
      textClass: visual.textClass,
      dotClass: visual.dotClass,
      description: visual.description,
    };
  });

  /* ---- 4. 主导信号（份额最大者） ---- */
  let dominantKey: RagSignalKey | null = null;
  if (total > 0) {
    let bestShare = -1;
    for (const signal of signals) {
      if (signal.available === false) continue;
      if (signal.share > bestShare) {
        bestShare = signal.share;
        dominantKey = signal.key;
      }
    }
  }

  const rrfScore = clamp01(breakdown.rrfScore);
  const fusedScore = clamp01(breakdown.fusedScore ?? breakdown.rrfScore);
  const calibratedScore = clamp01(
    topDoc.similarityScore ?? breakdown.fusedScore ?? breakdown.rrfScore,
  );
  const candidatePoolSize =
    typeof breakdown.candidatePoolSize === 'number' &&
    Number.isFinite(breakdown.candidatePoolSize)
      ? breakdown.candidatePoolSize
      : null;
  const corpusSize =
    typeof breakdown.corpusSize === 'number' && Number.isFinite(breakdown.corpusSize)
      ? breakdown.corpusSize
      : null;
  const poolFactor =
    typeof breakdown.poolFactor === 'number' && Number.isFinite(breakdown.poolFactor)
      ? clamp01(breakdown.poolFactor)
      : null;

  return {
    available: true,
    signals,
    fusedScore,
    rrfScore,
    calibratedScore,
    candidatePoolSize,
    corpusSize,
    poolFactor,
    topDocId: topDoc.id,
    dominantKey,
    /**
     * 【RRF 满值语义】rrfScore 的归一化基准是「每条路由都排第 1 名」
     * （见 sreRagEngine.rrfFuse 的 maxPossible = routeCount / (k+1)）。
     * 因此 1.000 并不意味着"三路得分都满分"，而是"该文档在每条路由上
     * 都排在第一位"——这是**排名一致性**的满分，不是分数满分。
     *
     * 界面必须区分这两者，否则用户看到 RRF 1.000 会以为证据强度完美，
     * 而实际上向量分可能只有 0.16。这里显式计算"是否排名全一致"，
     * 让文案可以如实说明成因。
     */
    rrfIsRankPerfect: breakdown.rrfScore >= 0.9999,
  };
}

/** clamp01 —— 把任意数值收敛到 [0,1]（NaN 归零） */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/* ========================================================================== */
/* 特征词提取                                                                  */
/* ========================================================================== */

/**
 * FeatureTerm —— 命中特征词的展示契约。
 *
 * 【weight 的用途】同一个词在查询中命中且在多篇手册的特征词袋里出现，
 * 说明它是本次检索的**高区分度术语**（IDF 高）。用权重控制胶囊的视觉强度，
 * 让"最关键的那个词"比"顺带提到的词"更醒目。
 */
export interface FeatureTerm {
  readonly term: string;
  /** 命中强度 [1,3]：1=弱相关，2=中等，3=强（出现在多篇手册中） */
  readonly weight: 1 | 2 | 3;
  /** 来源标记：engine=引擎回填的 matchedTerms，vocab=手册特征词袋 */
  readonly source: 'engine' | 'vocab';
}

/**
 * TECHNICAL_TERM_PATTERN —— 从自由文本中识别技术特征词的模式。
 *
 * 【为何需要它】引擎的 matchedTerms 有时为空（例如手册是自定义的，
 * 或模型生成的根因描述里带了术语但没走检索匹配）。此时仍应从
 * `rootCauseSummary` 等文本里提取术语，否则可视化区会空着。
 *
 * 覆盖三类：
 * 1. K8s / 内核 / 网络术语（大小写混合、下划线、连字符）；
 * 2. 退出码与错误码（Exit 137 / HTTP 429 / x509）；
 * 3. 带单位的指标名（memory.max / cfs_quota_us）。
 */
const TECHNICAL_TERM_PATTERN =
  /\b(?:OOMKilled|OOM|Exit\s*137|exit\s*code\s*\d+|cgroup_memory|cgroup|memory\.max|cfs_quota_us|CFS|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CPU\s*Throttl\w*|CNI|VXLAN|IPVS|kube-?proxy|etcd|APF|QoS|PodDisruptionBudget|PDB|x509|TLS|DNS|NAT|OOMScoreAdj|oom_score_adj|throttl\w*|Eviction|Evicted|Backoff|NotReady|Unschedulable|TopologySpread|NodeAffinity|readiness|liveness|SIGKILL|SIGTERM)\b/gi;

/**
 * extractFeatureTerms —— 提取用于展示的特征词胶囊。
 *
 * 【两源合并，引擎优先】`matchedTerms` 是引擎**实际参与打分**的词，
 * 可信度最高；特征词袋里的词补充"这篇手册关心什么"的背景信息。
 * 二者都保留但标记来源，界面可据此区分展示。
 *
 * 【去重与权重】同一术语可能在多个来源出现，按出现次数提升权重
 * （封顶 3），因为这确实反映它在本次检索中的重要性。
 *
 * @param docs          命中的手册（提供 matchedTerms 与 featureVocabulary）
 * @param fallbackText  兜底文本（根因摘要/证据链），从中正则提取术语
 * @param limit         返回上限（默认 10，过多会撑爆卡片）
 * @returns 按权重降序排列的特征词
 */
export function extractFeatureTerms(
  docs: readonly RagRunbookDoc[],
  fallbackText: string,
  limit = 10,
): FeatureTerm[] {
  /** term(小写) → { 原文, 权重, 来源 } */
  const collected = new Map<string, { display: string; weight: number; source: 'engine' | 'vocab' }>();

  const add = (raw: string, source: 'engine' | 'vocab'): void => {
    const display = raw.trim();
    if (display.length === 0 || display.length > 32) return;
    const key = display.toLowerCase();
    const existing = collected.get(key);
    if (existing === undefined) {
      collected.set(key, { display, weight: 1, source });
      return;
    }
    /* 已存在：权重递增（最多 3），并保留更高优先级的来源标记 */
    collected.set(key, {
      display: existing.display,
      weight: Math.min(3, existing.weight + 1),
      source: source === 'engine' ? 'engine' : existing.source,
    });
  };

  /* ---- 1. 引擎回填的 matchedTerms（最高优先级） ---- */
  for (const doc of docs) {
    for (const term of doc.matchedTerms ?? []) {
      add(term, 'engine');
    }
  }

  /* ---- 2. 手册特征词袋（补充背景） ---- */
  for (const doc of docs) {
    for (const term of doc.featureVocabulary) {
      add(term, 'vocab');
    }
  }

  /* ---- 3. 兜底文本正则提取（前两源都空时最有用） ---- */
  const matches = fallbackText.match(TECHNICAL_TERM_PATTERN);
  if (matches !== null) {
    for (const term of matches) {
      add(term, 'vocab');
    }
  }

  /* ---- 4. 排序：权重降序 → 来源优先 → 长度升序（短术语更可能是关键词） ---- */
  return [...collected.values()]
    .sort((a, b): number => {
      if (a.weight !== b.weight) return b.weight - a.weight;
      if (a.source !== b.source) return a.source === 'engine' ? -1 : 1;
      return a.display.length - b.display.length;
    })
    .slice(0, limit)
    .map(
      (item): FeatureTerm => ({
        term: item.display,
        weight: Math.min(3, item.weight) as 1 | 2 | 3,
        source: item.source,
      }),
    );
}

/**
 * formatScore —— 把 [0,1] 得分格式化为三位小数文本。
 *
 * 【为何固定三位】BLOCK 内的得分差异常在千分位（如 0.234 与 0.237），
 * 两位小数会显示成一样，失去拆解的意义。
 *
 * @param value 原始得分
 * @returns 三位小数文本
 */
export function formatScore(value: number): string {
  return clamp01(value).toFixed(3);
}

/**
 * formatSharePercent —— 把份额格式化为整数百分比文本。
 *
 * @param share 份额 [0,1]
 * @returns 形如 '42%' 的文本
 */
export function formatSharePercent(share: number): string {
  return `${Math.round(clamp01(share) * 100)}%`;
}