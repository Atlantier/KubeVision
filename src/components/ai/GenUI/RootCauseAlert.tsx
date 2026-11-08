'use client';

/**
 * KubeVision AI — SRE 根因分析告警卡（生成式 UI · RootCauseAlert）
 *
 * 【设计意图】这是 Copilot 价值最高的卡片：它不只报告「哪里坏了」，
 * 而是呈现「为什么坏 + 证据链 + 知识库依据」。三部分构成完整的可解释性：
 * 1. 定性 + confidence：P0/P1/P2 徽标 + 模型自评可信度进度条；
 * 2. 证据链（evidenceChain）：时间有序的观测事实，支撑结论；
 * 3. RAG 溯源（ragReferences）：命中的 Runbook 编号、标题、相似度 ——
 *    这是「AI 的回答有据可查」的物理证明，也是本项目的答辩亮点。
 *
 * 【为何把 RAG 溯源做成折叠区】它是「需要时才深挖」的二级信息：
 * 日常排障看结论与证据链即可；审计/答辩时才展开追到具体手册条款。
 * 默认折叠但**明确标注命中数量**（如「2 条溯源」），让用户知道有据可查。
 *
 * 【视觉契约】按 severity 分级配色：P0 rose-500（最强警示，带脉冲）、
 * P1 amber-400、P2 cyan-400，与全局告警色体系严格一致。
 */

import { useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertOctagon,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Gauge,
  Layers,
  ListTree,
  Tag,
  Target,
} from 'lucide-react';

import { cn } from '@/utils/cn';
import MarkdownLite, { InlineMarkdown } from '@/components/ai/MarkdownLite';
import {
  buildRagSignalBreakdown,
  extractFeatureTerms,
  formatScore,
  formatSharePercent,
  type RagSignal,
  type RagSignalBreakdown,
} from '@/utils/ragSignals';
import type { RootCauseAlertProps } from '@/types/ai';

/* ========================================================================== */
/* 严重度视觉映射                                                              */
/* ========================================================================== */

/** severity → 卡片边框色 */
const SEVERITY_BORDER: Readonly<Record<RootCauseAlertProps['severity'], string>> = {
  P0: 'border-rose-500/60',
  P1: 'border-amber-500/50',
  P2: 'border-cyan-500/40',
};

/** severity → 徽标样式 */
const SEVERITY_BADGE: Readonly<Record<RootCauseAlertProps['severity'], string>> = {
  P0: 'border-rose-500/60 bg-rose-500/20 text-rose-300',
  P1: 'border-amber-500/50 bg-amber-500/15 text-amber-300',
  P2: 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300',
};

/** severity → 外辉光（P0 最强） */
const SEVERITY_GLOW: Readonly<Record<RootCauseAlertProps['severity'], string>> = {
  P0: 'shadow-glow-rose',
  P1: '',
  P2: '',
};

/** severity → confidence进度条填充色 */
const SEVERITY_BAR: Readonly<Record<RootCauseAlertProps['severity'], string>> = {
  P0: 'bg-gradient-to-r from-rose-500 to-rose-400',
  P1: 'bg-gradient-to-r from-amber-500 to-amber-400',
  P2: 'bg-gradient-to-r from-cyan-500 to-cyan-400',
};

/* ========================================================================== */
/* 子组件：三路检索信号贡献拆解条                                                */
/* ========================================================================== */

/**
 * RetrievalSignalBar —— RAG 混合检索的三路信号贡献可视化。
 *
 * 【设计意图】把 `sreRagEngine.ts` 里的融合数学过程变成一眼可读的证据构成：
 * 一条三色分段条 + 图例，展示 BM25 稀疏词频 / Dense 语义向量 /
 * Topology 拓扑先验各自贡献了多少份额。
 *
 * 【为何必须分段而非三条独立进度条】
 * 三条独立进度条各自有各自的长度基准，读者无法一眼看出"哪一路占主导"；
 * 分段条共享同一条长度基准（100%），份额对比是**直接可比**的。
 * 这正是 RRF 融合的本质：三路证据按权重拼成最终排名，而不是各自独立存在。
 *
 * 【为何同时显示 score 与 share】
 * - share（分段长度）：这次判定主要靠哪一路；
 * - score（图例数字）：这一路本身有多强。
 * 二者缺一会误读：份额 80% 但 score 只有 0.12，说明三路都很弱，
 * 只是相对而言这一路稍强——此时不应给出高置信度结论。
 *
 * @param props breakdown=信号拆解数据，severity=用于标题语气
 */
function RetrievalSignalBar({
  breakdown,
}: {
  readonly breakdown: RagSignalBreakdown;
  readonly severity: RootCauseAlertProps['severity'];
}): ReactNode {
  /** 主导信号（份额最大）的展示信息，用于一行结论文案 */
  const dominant = breakdown.signals.find(
    (signal): boolean => signal.key === breakdown.dominantKey,
  );

  return (
    <div className="px-2.5 pb-2">
      <div className="rounded border border-slate-800 bg-slate-950/40 p-1.5">
        {/* ---- 标题行：标题 + 融合终值 ---- */}
        <div className="flex items-center gap-1.5">
          <Layers className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wider text-slate-500">
            三路检索信号贡献
          </span>
          <span
            className="shrink-0 font-mono text-[10px] tabular-nums text-slate-400"
            title="RRF 倒数秩融合分（融合终值，未经置信度校准）"
          >
            RRF {formatScore(breakdown.fusedScore)}
          </span>
        </div>

        {/* ---- 三色分段条 ---- */}
        <div
          className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800/80"
          role="img"
          aria-label={`检索信号构成：${breakdown.signals
            .map((signal): string => `${signal.label} ${formatSharePercent(signal.share)}`)
            .join('，')}`}
        >
          {breakdown.signals.map((signal: RagSignal): ReactNode =>
            signal.share > 0 ? (
              <div
                key={signal.key}
                className={cn('h-full transition-[width] duration-500', signal.barClass)}
                style={{ width: `${signal.share * 100}%` }}
                title={`${signal.label}（${signal.term}）得分 ${formatScore(signal.score)} · 占总证据 ${formatSharePercent(signal.share)}`}
              />
            ) : null,
          )}
        </div>

        {/* ---- 图例：三路各自份额 + 原始得分 ---- */}
        <div className="mt-1.5 grid grid-cols-3 gap-1">
          {breakdown.signals.map((signal: RagSignal): ReactNode => (
            <div
              key={signal.key}
              className="flex min-w-0 flex-col gap-0.5"
              title={signal.description}
            >
              <span className="flex items-center gap-1">
                <span className={cn('h-1 w-1 shrink-0 rounded-full', signal.dotClass)} aria-hidden />
                <span className="truncate font-mono text-[9px] tracking-tight text-slate-500">
                  {signal.term}
                </span>
                <span
                  className={cn('shrink-0 font-mono text-[9px] font-bold tabular-nums', signal.textClass)}
                >
                  {formatSharePercent(signal.share)}
                </span>
              </span>
              <span className="truncate font-mono text-[9px] tabular-nums text-slate-600">
                {formatScore(signal.score)}
              </span>
            </div>
          ))}
        </div>

        {/* ---- 一行结论：主导信号 + 校准置信度 ---- */}
        {dominant !== undefined ? (
          <p className="mt-1 truncate font-mono text-[9px] leading-relaxed text-slate-600">
            主导证据 · <span className={dominant.textClass}>{dominant.term}</span>
            {' · '}校准置信度 {formatSharePercent(breakdown.calibratedScore)}
            {breakdown.topDocId !== null ? ` · ${breakdown.topDocId}` : ''}
          </p>
        ) : null}

        {/*
         * ---- RRF 满值的成因说明 ----
         *
         * 【为何需要这一行】rrfScore 的归一化基准是「每条路由都排第 1 名」，
         * 所以 1.000 表达的是**排名一致性满分**，不是分数满分。
         * 实测出现过三路份额 37%/16%/47%、向量分仅 0.16 却显示 RRF 1.000
         * 的情况——若不解释，读者会把"三路都把这篇排第一"
         * 误读成"三路打分都很高"，这是两种完全不同的证据强度。
         */}
        {breakdown.rrfIsRankPerfect ? (
          <p
            className="mt-0.5 font-mono text-[9px] leading-relaxed text-slate-600/80"
            title="RRF 归一化基准为「每条路由均排第 1 名」，1.000 表示排名完全一致，不代表三路得分都高"
          >
            RRF 1.000 = 三路排名完全一致（非得分满分）
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * RootCauseAlert —— SRE 根因分析报告卡。
 *
 * @param props 见 RootCauseAlertProps（severity/title/confidence/rootCauseSummary/evidenceChain/impactScope/ragReferences）
 */
export default function RootCauseAlert({
  severity,
  title,
  confidence,
  rootCauseSummary,
  evidenceChain,
  impactScope,
  ragReferences,
}: RootCauseAlertProps) {
  /** RAG 溯源区展开态（默认折叠：二级信息，按需深挖） */
  const [citationsOpen, setCitationsOpen] = useState<boolean>(false);

  /**
   * 当前展开的引用条目 id（null 表示全部收起）。
   *
   * 【为何用单值而非 Set】溯源面板同时只应展开一条——
   * 同时展开多条会把 GenUI 卡片撑爆，也让"我正在核查哪一条"失去焦点。
   * 用单值 state 天然保证互斥，无需额外逻辑。
   */
  const [expandedCitationId, setExpandedCitationId] = useState<string | null>(null);

  /** confidence百分比（clamp 到 [0,100]，防越界输入画出超长进度条） */
  const confidencePct = useMemo((): number => {
    const raw = Number.isFinite(confidence) ? confidence : 0;
    return Math.max(0, Math.min(100, Math.round(raw * 100)));
  }, [confidence]);

  /**
   * 三路检索信号拆解（BM25 稀疏 / Dense 语义 / Topology 先验）。
   *
   * 【为何依赖 ragReferences 而非 confidence】confidence 是模型自评的
   * 主观可信度，与检索证据强度是**两件不同的事**：模型可以很自信地
   * 给出一个只靠单路证据支撑的结论。真正的"证据构成"只存在于
   * 引擎回填的 scoreBreakdown 里。分开呈现，用户才能看出
   * "92% 置信度背后是三路均衡还是单一信号撑起来的"。
   */
  const signalBreakdown = useMemo((): RagSignalBreakdown => {
    return buildRagSignalBreakdown(ragReferences);
  }, [ragReferences]);

  /**
   * 命中特征词（引擎 matchedTerms 优�先 + 手册词袋补充 + 文本正则兜底）。
   *
   * 【为何兜底文本包含 title 与 summary】实测某些轮次模型只给根因描述、
   * 不给 matchedTerms，而描述里恰好写着 "OOMKilled / Exit 137"。
   * 把这些词提取出来，胶囊区就不会空着——它是可解释性最直观的一环。
   */
  const featureTerms = useMemo(() => {
    return extractFeatureTerms(
      ragReferences,
      `${title} ${rootCauseSummary} ${evidenceChain.join(' ')}`,
      12,
    );
  }, [ragReferences, title, rootCauseSummary, evidenceChain]);

  /** 深层机理折叠区展开态 */
  const [mechanismOpen, setMechanismOpen] = useState<boolean>(false);

  return (
    <div
      className={cn(
        'w-full overflow-hidden rounded-md border bg-slate-900/70 backdrop-blur-sm',
        SEVERITY_BORDER[severity],
        SEVERITY_GLOW[severity],
      )}
      role="alert"
      aria-label={`根因分析：${title}`}
    >
      {/* ============ 头部：P 级徽标 + 标题 ============ */}
      <div className="flex items-start gap-2 p-2.5 pb-2">
        <span
          className={cn(
            'mt-0.5 inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider',
            SEVERITY_BADGE[severity],
            severity === 'P0' && 'animate-glow-pulse',
          )}
        >
          <AlertOctagon className="h-2.5 w-2.5" aria-hidden />
          {severity}
        </span>
        <h3 className="min-w-0 flex-1 text-[12px] font-bold leading-snug text-slate-100">{title}</h3>
      </div>

      {/* ============ confidence进度条 ============ */}
      <div className="px-2.5 pb-2">
        <div className="flex items-center gap-1.5">
          <Gauge className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            根因置信度
          </span>
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-800">
            <div
              className={cn('h-full rounded-full transition-[width] duration-500', SEVERITY_BAR[severity])}
              style={{ width: `${confidencePct}%` }}
              role="progressbar"
              aria-valuenow={confidencePct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="根因置信度"
            />
          </div>
          <span className="shrink-0 font-mono text-[11px] font-bold tabular-nums text-slate-300">
            {confidencePct}%
          </span>
        </div>
      </div>

      {/* ============ 三路混合检索信号贡献拆解 ============ */}
      {signalBreakdown.available ? (
        <RetrievalSignalBar breakdown={signalBreakdown} severity={severity} />
      ) : null}

      {/* ============ 命中特征词胶囊 ============ */}
      {featureTerms.length > 0 ? (
        <div className="px-2.5 pb-2">
          <p className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            <Tag className="h-2.5 w-2.5 shrink-0" aria-hidden />
            命中特征词 · {featureTerms.length}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {featureTerms.map((term): ReactNode => (
              <span
                key={term.term}
                /*
                 * 【权重驱动视觉强度】weight 1/2/3 对应三档边框与底色深浅。
                 * 让"出现在多篇手册里的核心术语"比"顺带匹配到的词"更醒目，
                 * 用户一眼能看出哪个词是这次判定的关键依据。
                 */
                className={cn(
                  'rounded border px-1 py-0.5 font-mono text-[10px] transition-colors',
                  term.weight >= 3
                    ? 'border-cyan-400/60 bg-cyan-400/15 font-bold text-cyan-200'
                    : term.weight === 2
                      ? 'border-cyan-400/40 bg-cyan-400/[0.09] text-cyan-300'
                      : 'border-slate-600/60 bg-slate-800/50 text-slate-400',
                )}
                title={
                  term.source === 'engine'
                    ? '引擎实际参与打分的命中词'
                    : '来自手册特征词袋或根因描述的技术术语'
                }
              >
                {term.term}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* ============ 根因摘要 ============ *
       * 【MarkdownLite 渲染】rootCauseSummary 由模型生成，实测含
       * `**88.1%**`、`` `memory.max` ``、`**建议暂缓执行**` 等标记。
       * 裸 `<p>{rootCauseSummary}</p>` 会把星号与反引号直接暴露。
       */}
      <div className="px-2.5 pb-2">
        <p className="flex items-start gap-1 font-mono text-[11px] uppercase tracking-wider text-slate-500">
          <Target className="mt-[2px] h-2.5 w-2.5 shrink-0" aria-hidden />
          核心根因判定
        </p>
        <div className="mt-1 border-l-2 border-slate-700 pl-2">
          <MarkdownLite markdown={rootCauseSummary} className="text-[11px] leading-relaxed text-slate-300" />
        </div>
      </div>

      {/* ============ 影响范围 ============ */}
      {impactScope.length > 0 ? (
        <div className="px-2.5 pb-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">故障爆炸半径</p>
          {/* 单段文本 → InlineMarkdown，避免块级容器撑散卡片 */}
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-amber-300/90">
            <InlineMarkdown text={impactScope} />
          </p>
        </div>
      ) : null}

      {/* ============ 时间轴证据链 ============ */}
      {evidenceChain.length > 0 ? (
        <div className="border-t border-slate-800 px-2.5 py-2">
          <p className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            <ListTree className="h-2.5 w-2.5" aria-hidden />
            可观测性证据链 · {evidenceChain.length}
          </p>
          <ol className="relative mt-1.5 space-y-1">
            {/* 纵向时间轴主线 */}
            <span
              className="pointer-events-none absolute bottom-1 left-[3px] top-1 w-px bg-gradient-to-b from-rose-500/40 via-slate-700 to-transparent"
              aria-hidden
            />
            {evidenceChain.map((evidence, index) => (
              <li key={`${index}-${evidence.slice(0, 16)}`} className="flex items-start gap-1.5">
                <span className="relative z-10 mt-[5px] h-1 w-1 shrink-0 rounded-full bg-slate-500" aria-hidden />
                {/*
                 * 【InlineMarkdown 渲染】证据条目里常出现
                 * `memory.max`、**88.1%**、`RUNBOOK-K8S-042` 这类标记。
                 * 此前整条塞进 `<code>` 里等比等宽渲染，反引号裸露且毫无层级；
                 * 现在由行内解析器识别，代码片段自动获得胶囊高亮、
                 * 加粗数字获得强调，证据链才真正"可读"。
                 */}
                <span className="min-w-0 flex-1 break-words font-mono text-[12px] leading-relaxed text-slate-400">
                  <InlineMarkdown text={evidence} />
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {/* ============ 深层内核机理与 SOP 溯源（折叠区） ============ */}
      {ragReferences.length > 0 ? (
        <div className="border-t border-slate-800">
          <button
            type="button"
            onClick={(): void => setMechanismOpen((prev): boolean => !prev)}
            aria-expanded={mechanismOpen}
            aria-label={mechanismOpen ? '收起深层内核机理' : '展开深层内核机理与 SOP 溯源'}
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-slate-800/40"
          >
            {mechanismOpen ? (
              <ChevronDown className="h-2.5 w-2.5 shrink-0 text-slate-400" aria-hidden />
            ) : (
              <ChevronRight className="h-2.5 w-2.5 shrink-0 text-slate-400" aria-hidden />
            )}
            <ListTree className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wider text-slate-400">
              深层内核机理与 SOP 溯源
            </span>
            <span className="shrink-0 rounded-full border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-slate-400">
              {ragReferences.length} 篇
            </span>
          </button>

          <AnimatePresence initial={false}>
            {mechanismOpen ? (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                className="overflow-hidden"
              >
                <div className="space-y-1.5 px-2.5 pb-2">
                  {ragReferences.map((doc, docIndex): ReactNode => (
                    <div
                      key={`mech-${doc.id}`}
                      className="rounded border border-slate-800 bg-slate-950/50 p-1.5"
                    >
                      {/* 溯源编号 + 标题 */}
                      <div className="flex items-start gap-1.5">
                        <span className="shrink-0 rounded bg-slate-700/60 px-1 py-0.5 font-mono text-[9px] font-bold tracking-wider text-slate-300">
                          {docIndex + 1}/{ragReferences.length}
                        </span>
                        <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 font-mono text-[9px] font-bold text-emerald-300">
                          {doc.id}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400">
                          {doc.title}
                        </span>
                      </div>

                      {/* 内核机理 */}
                      <div className="mt-1">
                        <p className="font-mono text-[9px] uppercase tracking-wider text-emerald-400/60">
                          内核 / Cgroup / CNI 层机理
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-slate-400">
                          {doc.rootCauseMechanism}
                        </p>
                      </div>

                      {/* 完整 SOP 步骤（此处不截断，因为是折叠区，用户主动展开即想看全） */}
                      {doc.remediationSteps.length > 0 ? (
                        <div className="mt-1">
                          <p className="font-mono text-[9px] uppercase tracking-wider text-emerald-400/60">
                            标准处置 SOP · {doc.remediationSteps.length} 步
                          </p>
                          <ol className="mt-0.5 space-y-0.5">
                            {doc.remediationSteps.map((step, stepIndex): ReactNode => (
                              <li
                                key={`sop-${doc.id}-${stepIndex}`}
                                className="flex gap-1.5 font-mono text-[10px] leading-snug text-slate-400"
                              >
                                <span className="shrink-0 tabular-nums text-emerald-500/60">
                                  {stepIndex + 1}.
                                </span>
                                <span className="min-w-0 break-words">
                                  <InlineMarkdown text={step} />
                                </span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      ) : null}

                      {/* 分类与关联演练场景 */}
                      {doc.tags.length > 0 || doc.relatedChaos !== undefined ? (
                        <p className="mt-1 font-mono text-[9px] tracking-wider text-slate-600">
                          分类 {doc.category}
                          {doc.relatedChaos !== undefined && doc.relatedChaos.length > 0
                            ? ` · 关联演练 ${doc.relatedChaos.join(' / ')}`
                            : ''}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}

      {/* ============ RAG 检索增强知识库溯源（折叠区） ============ */}
      <div className="border-t border-slate-800">
        <button
          type="button"
          onClick={(): void => setCitationsOpen((prev): boolean => !prev)}
          aria-expanded={citationsOpen}
          className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left transition-colors hover:bg-slate-800/40"
        >
          {citationsOpen ? (
            <ChevronDown className="h-2.5 w-2.5 shrink-0 text-emerald-400" aria-hidden />
          ) : (
            <ChevronRight className="h-2.5 w-2.5 shrink-0 text-emerald-400" aria-hidden />
          )}
          <BookOpen className="h-3 w-3 shrink-0 text-emerald-400" aria-hidden />
          {/*
           * 文案不带 Emoji：左侧已有 <BookOpen /> 矢量图标，
           * "Emoji + 图标"叠床架屋，是廉价 AI 模板的典型痕迹。
           */}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold uppercase tracking-wider text-emerald-300">
            RAG 检索增强知识库溯源
          </span>
          <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-emerald-300">
            {ragReferences.length} 条引用
          </span>
        </button>

        {/*
         * 展开态：Runbook 编号 + 标题 + 相似度
         *
         * 【为何需要 AnimatePresence + 弹簧高度动画】（蓝图 §1.9 / 审查报告 §4.2）
         * 原实现是裸的条件渲染：点击展开时内容**瞬间出现**，下方所有卡片
         * （ActionConfirm 等）在同一帧被整体推下去——这是典型的"折叠瞬移"，
         * 观感上像页面抖了一下。用 height: auto 的弹簧动画后，卡片是
         * "撑开"而不是"弹跳"，下方内容平滑跟随。
         */}
        <AnimatePresence initial={false}>
          {citationsOpen ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 34 }}
              className="overflow-hidden"
            >
              <ul className="space-y-1 px-2.5 pb-2">
                {ragReferences.length === 0 ? (
                  <li className="font-mono text-[12px] text-slate-600">— 暂未匹配到排障手册 —</li>
                ) : (
                  ragReferences.map((doc) => {
                    /* similarityScore ∈ [0,1]，展示为百分比（如 0.964 → 96.4%） */
                    const similarityPct =
                      doc.similarityScore === undefined ? null : Math.round(doc.similarityScore * 1000) / 10;
                    const isExpanded = expandedCitationId === doc.id;
                    const breakdown = doc.scoreBreakdown;
                    return (
                      <li
                        key={doc.id}
                        className="rounded border border-slate-800 bg-slate-950/50 transition-colors hover:border-emerald-500/40"
                      >
                        {/*
                         * ---- 引用条（可点击展开详情）----
                         *
                         * 【为何整条可点】溯源区的存在意义是"让结论可核查"，
                         * 若只能看编号与分数，评委仍得去别处查手册。
                         * 点开即在原地看到根因机理与 SOP，核查闭环才成立。
                         */}
                        <button
                          type="button"
                          onClick={(): void => setExpandedCitationId(isExpanded ? null : doc.id)}
                          aria-expanded={isExpanded}
                          className="w-full p-1.5 text-left"
                        >
                          <div className="flex items-start gap-1.5">
                            <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 font-mono text-[11px] font-bold text-emerald-300">
                              {doc.id}
                            </span>
                            {doc.isCustom === true ? (
                              <span className="shrink-0 rounded border border-cyan-400/40 bg-cyan-400/10 px-1 py-0.5 font-mono text-[9px] font-bold text-cyan-300">
                                自定义
                              </span>
                            ) : null}
                            {similarityPct !== null ? (
                              <span
                                className="ml-auto shrink-0 font-mono text-[11px] font-bold tabular-nums text-emerald-400"
                                title={`校准置信度 ${doc.similarityScore?.toFixed(4)}`}
                              >
                                匹配度 {similarityPct.toFixed(1)}%
                              </span>
                            ) : null}
                            {isExpanded ? (
                              <ChevronDown className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
                            ) : (
                              <ChevronRight className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
                            )}
                          </div>
                          <p className="mt-1 text-[10px] font-medium leading-snug text-slate-300">{doc.title}</p>
                          <p className="mt-0.5 font-mono text-[10px] tracking-wider text-slate-600">
                            {doc.category} · {doc.tags.slice(0, 3).join(' / ')}
                          </p>

                          {/*
                           * ---- Vector / BM25 双路得分微标签 ----
                           *
                           * 【为何要暴露拆解】单一"匹配度 96%"无法自证。
                           * 显示两路分后才能看出依据：BM25 高说明关键术语
                           * 精确命中（稀疏侧证据强），Vector 高说明整体语义
                           * 方向一致（稠密侧证据强）。二者都低却分数高，
                           * 说明只靠上下文先验——评委一眼可辨。
                           */}
                          {breakdown !== undefined ? (
                            <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[9px] tabular-nums">
                              <span
                                className="rounded bg-emerald-500/10 px-1 py-0.5 text-emerald-400/90"
                                title="TF-IDF 加权词元 + 双字 N-Gram 的余弦相似度（稠密侧）"
                              >
                                VEC {breakdown.vectorScore.toFixed(3)}
                              </span>
                              <span
                                className="rounded bg-cyan-500/10 px-1 py-0.5 text-cyan-400/90"
                                title="Okapi BM25 稀疏得分（已按查询 IDF 质量归一）"
                              >
                                BM25 {breakdown.bm25Score.toFixed(3)}
                              </span>
                              {breakdown.contextBoost > 0 ? (
                                <span
                                  className="rounded bg-amber-500/10 px-1 py-0.5 text-amber-400/90"
                                  title="故障场景 / 受影响 Pod 的上下文先验"
                                >
                                  CTX {breakdown.contextBoost.toFixed(3)}
                                </span>
                              ) : null}
                            </div>
                          ) : null}

                          {/*
                           * ---- 命中特征词胶囊 ----
                           *
                           * 【这是可解释性最有力的一环】"命中了 x509 / harbor /
                           * imagepullbackoff" 是任何人可立刻核验的事实，
                           * 比任何百分比都有说服力。
                           */}
                          {doc.matchedTerms !== undefined && doc.matchedTerms.length > 0 ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {doc.matchedTerms.map((term): ReactNode => (
                                <span
                                  key={term}
                                  className="rounded border border-cyan-400/35 bg-cyan-400/[0.08] px-1 py-0.5 font-mono text-[9px] text-cyan-200"
                                >
                                  {term}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </button>

                        {/*
                         * ---- 展开态：根因机理 + 标准 SOP 摘要 ----
                         *
                         * 【内容取舍】只给机理 + 前 3 步 SOP。
                         * 溯源面板是"核查用"的，不是手册阅读器——
                         * 完整手册有 5~6 步，全渲染会把 GenUI 卡片撑成
                         * 一整页，反而破坏对话流。想看全文可去知识库弹窗。
                         */}
                        <AnimatePresence initial={false}>
                          {isExpanded ? (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                              className="overflow-hidden"
                            >
                              <div className="space-y-1.5 border-t border-slate-800 px-1.5 py-2">
                                <div>
                                  <p className="font-mono text-[9px] uppercase tracking-wider text-emerald-400/70">
                                    根因机理
                                  </p>
                                  <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-slate-400">
                                    {doc.rootCauseMechanism}
                                  </p>
                                </div>
                                {doc.remediationSteps.length > 0 ? (
                                  <div>
                                    <p className="font-mono text-[9px] uppercase tracking-wider text-emerald-400/70">
                                      标准修复步骤
                                    </p>
                                    <ol className="mt-0.5 space-y-0.5">
                                      {doc.remediationSteps.slice(0, 3).map((step, index): ReactNode => (
                                        <li key={step} className="flex gap-1.5 font-mono text-[10px] leading-snug text-slate-400">
                                          <span className="shrink-0 tabular-nums text-emerald-500/70">
                                            {index + 1}.
                                          </span>
                                          <span className="min-w-0 break-words">{step}</span>
                                        </li>
                                      ))}
                                    </ol>
                                    {doc.remediationSteps.length > 3 ? (
                                      <p className="mt-1 font-mono text-[9px] text-slate-600">
                                        另有 {doc.remediationSteps.length - 3} 步，见知识库完整手册
                                      </p>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            </motion.div>
                          ) : null}
                        </AnimatePresence>
                      </li>
                    );
                  })
                )}
              </ul>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}