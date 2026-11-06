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

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertOctagon,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Gauge,
  ListTree,
  Target,
} from 'lucide-react';

import { cn } from '@/utils/cn';
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

  /** confidence百分比（clamp 到 [0,100]，防越界输入画出超长进度条） */
  const confidencePct = useMemo((): number => {
    const raw = Number.isFinite(confidence) ? confidence : 0;
    return Math.max(0, Math.min(100, Math.round(raw * 100)));
  }, [confidence]);

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
            confidence
          </span>
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-800">
            <div
              className={cn('h-full rounded-full transition-[width] duration-500', SEVERITY_BAR[severity])}
              style={{ width: `${confidencePct}%` }}
              role="progressbar"
              aria-valuenow={confidencePct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="根因confidence"
            />
          </div>
          <span className="shrink-0 font-mono text-[11px] font-bold tabular-nums text-slate-300">
            {confidencePct}%
          </span>
        </div>
      </div>

      {/* ============ 根因摘要 ============ */}
      <div className="px-2.5 pb-2">
        <p className="flex items-start gap-1 font-mono text-[11px] uppercase tracking-wider text-slate-500">
          <Target className="mt-[2px] h-2.5 w-2.5 shrink-0" aria-hidden />
          核心根因判定
        </p>
        <p className="mt-1 whitespace-pre-wrap break-words border-l-2 border-slate-700 pl-2 text-[10.5px] leading-relaxed text-slate-300">
          {rootCauseSummary}
        </p>
      </div>

      {/* ============ 影响范围 ============ */}
      {impactScope.length > 0 ? (
        <div className="px-2.5 pb-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">故障爆炸半径</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-amber-300/90">{impactScope}</p>
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
                <code className="min-w-0 flex-1 break-words font-mono text-[12px] leading-relaxed text-slate-400">
                  {evidence}
                </code>
              </li>
            ))}
          </ol>
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
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold uppercase tracking-wider text-emerald-300">
            📚 RAG 检索增强知识库溯源
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
                    return (
                      <li
                        key={doc.id}
                        className="rounded border border-slate-800 bg-slate-950/50 p-1.5 transition-colors hover:border-emerald-500/40"
                      >
                        <div className="flex items-start gap-1.5">
                          <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 font-mono text-[11px] font-bold text-emerald-300">
                            {doc.id}
                          </span>
                          {similarityPct !== null ? (
                            <span
                              className="ml-auto shrink-0 font-mono text-[11px] font-bold tabular-nums text-emerald-400"
                              title={`余弦相似度 ${doc.similarityScore?.toFixed(4)}`}
                            >
                              匹配度 {similarityPct.toFixed(1)}%
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-[10px] font-medium leading-snug text-slate-300">{doc.title}</p>
                        <p className="mt-0.5 font-mono text-[10px] tracking-wider text-slate-600">
                          {doc.category} · {doc.tags.slice(0, 3).join(' / ')}
                        </p>
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
