'use client';

/**
 * KubeVision AI — Agent 思考链时间轴（AgentThoughtChain）
 *
 * 【设计意图】把 LLM/本地引擎的推理过程以**结构化步骤流**呈现，而不是一段
 * 不可解释的"思考文本"。每一步带阶段徽标、标题、耗时与详情，配合纵向时间轴
 * 形成"推理轨迹"的可视化。
 *
 * 【流式契约（本轮重点升级）】
 * 服务端现在按阶段真实推送推理步骤（步骤之间插入真实等待），组件侧必须
 * 让这种"逐条到达"被**看见**：
 * 1. 每条新步骤用 framer-motion 做入场过渡（淡入 + 轻微上浮）；
 * 2. 流式进行中时，**最新一条**步骤右侧挂一枚旋转加载器，明确表示
 *    "这一步还在进行"；
 * 3. 底部提示文案随**最新步骤的 phase** 动态变化，而不是千篇一律的
 *    "深度思考中…"——用户看到的是"正在比对 SRE 权威排障手册"这类
 *    具体动作描述，信息密度与可信度都更高。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Eye,
  Library,
  Loader2,
  Plug,
  ShieldAlert,
} from 'lucide-react';

import { cn } from '@/utils/cn';
import { InlineMarkdown } from '@/components/ai/MarkdownLite';
import { formatScore, formatSharePercent } from '@/utils/ragSignals';
import type { AgentReasoningPhase, AgentThoughtChainProps } from '@/types/ai';

/* ========================================================================== */
/* 阶段视觉映射表                                                               */
/* ========================================================================== */

/** 阶段 → 中文徽标文案 */
const PHASE_LABEL: Readonly<Record<AgentReasoningPhase, string>> = {
  INTENT_PLANNING: '意图规划',
  MULTIMODAL_VISION: '多模态视觉',
  RAG_RETRIEVAL: '知识检索',
  MCP_TOOL_INVOKE: 'MCP 工具',
  SAFETY_GUARD: '安全护栏',
};

/** 阶段 → 图标组件 */
const PHASE_ICON: Readonly<Record<AgentReasoningPhase, typeof BrainCircuit>> = {
  INTENT_PLANNING: BrainCircuit,
  MULTIMODAL_VISION: Eye,
  RAG_RETRIEVAL: Library,
  MCP_TOOL_INVOKE: Plug,
  SAFETY_GUARD: ShieldAlert,
};

/**
 * 阶段 → 文本色类。
 *
 * 【配色语义】与项目状态色严格对齐，不另造色：
 * - 规划 → cyan-400（主题流光，思考进行中）
 * - 视觉 → fuchsia-400（多模态通道，区别于常规文本）
 * - 检索 → emerald-400（知识命中的正反馈）
 * - 工具 → amber-400（外部调用的注意态）
 * - 护栏 → rose-500（高危阻断，最强警示）
 */
const PHASE_TEXT: Readonly<Record<AgentReasoningPhase, string>> = {
  INTENT_PLANNING: 'text-cyan-300',
  MULTIMODAL_VISION: 'text-fuchsia-300',
  RAG_RETRIEVAL: 'text-emerald-300',
  MCP_TOOL_INVOKE: 'text-amber-300',
  SAFETY_GUARD: 'text-rose-300',
};

/** 阶段 → 边框/底色（徽标胶囊） */
const PHASE_BADGE: Readonly<Record<AgentReasoningPhase, string>> = {
  INTENT_PLANNING: 'border-cyan-500/40 bg-cyan-500/10',
  MULTIMODAL_VISION: 'border-fuchsia-500/40 bg-fuchsia-500/10',
  RAG_RETRIEVAL: 'border-emerald-500/40 bg-emerald-500/10',
  MCP_TOOL_INVOKE: 'border-amber-500/40 bg-amber-500/10',
  SAFETY_GUARD: 'border-rose-500/40 bg-rose-500/10',
};

/** 阶段 → 时间轴节点圆点色 */
const PHASE_DOT: Readonly<Record<AgentReasoningPhase, string>> = {
  INTENT_PLANNING: 'bg-cyan-400',
  MULTIMODAL_VISION: 'bg-fuchsia-400',
  RAG_RETRIEVAL: 'bg-emerald-400',
  MCP_TOOL_INVOKE: 'bg-amber-400',
  SAFETY_GUARD: 'bg-rose-500',
};

/**
 * 阶段 → 流式底部提示文案。
 *
 * 【为何要按阶段区分】旧实现固定显示"深度思考中…"——这句话对任何阶段成立，
 * 因此也不传递任何信息。现在按最新到达步骤的真实阶段给出**具体动作描述**：
 * 用户在等待时能知道"系统此刻到底在做什么"，这既是体验优化，
 * 也是对推理链本身的可信度背书（如果文案与实际阶段不符，用户会立刻察觉）。
 */
const PHASE_STREAMING_HINT: Readonly<Record<AgentReasoningPhase, string>> = {
  INTENT_PLANNING: '正在分析集群上下文...',
  MULTIMODAL_VISION: '正在解析 3D 视口快照的空间异常特征...',
  RAG_RETRIEVAL: '正在比对 SRE 权威排障手册...',
  MCP_TOOL_INVOKE: '正在调用 MCP 协议工具并生成交互卡片...',
  SAFETY_GUARD: '正在执行安全护栏校验...',
};

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * AgentThoughtChain —— 可折叠的 AI 思考链时间轴。
 *
 * @param props 见 AgentThoughtChainProps（steps / isStreaming / defaultExpanded / className）
 */
export default function AgentThoughtChain({
  steps,
  isStreaming = false,
  defaultExpanded = false,
  className,
  ragBreakdown = null,
}: AgentThoughtChainProps) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  /** 用户是否手动干预过展开态——干预后不再自动接管（尊重用户意图） */
  const userToggledRef = useRef<boolean>(false);

  /**
   * 【流式自动展开】（审查报告 §4.2）
   *
   * 对标 Cursor / DeepSeek / Claude：推理进行中但正文尚未吐出时，
   * 用户最需要看到实时的步骤流转。此前默认折叠，前几秒只能盯着一行
   * 折叠条干等，完全体现不出"Agent 正在思考"的价值。
   *
   * 策略：
   * 1. 流式开始（isStreaming=true）且用户未手动干预 → 自动展开；
   * 2. 流式结束 → 自动收起（把屏幕让给正文与卡片）；
   * 3. 一旦用户手动点过折叠头，后续不再自动接管——
   *    自动展开是「贴心默认」，不能变成「和用户抢控制权」。
   */
  useEffect(() => {
    if (userToggledRef.current) return;
    setExpanded(isStreaming);
  }, [isStreaming]);

  /**
   * 步骤排序与总耗时（防御性处理：契约要求升序，但流式拼接可能乱序）。
   * useMemo 依赖 steps 引用——流式追加时引用变化才重算，展开切换不重算。
   */
  const ordered = useMemo(() => {
    const sorted = [...steps].sort((a, b): number => a.stepIndex - b.stepIndex);
    let total = 0;
    for (const step of sorted) total += step.latencyMs;
    return { sorted, total };
  }, [steps]);

  /**
   * 标题随推理链形态自适应。
   *
   * 【为何要变】服务端现在按意图产出不同的推理链：寒暄只有 1 步意图识别、
   * 稳态巡检到「知识检索」为止、只有故障诊断才会出现「MCP 工具」。
   * 顶栏若永远写「AI 诊断推理链」，在一句「你好」的回复上方挂"诊断推理链"
   * 就是自相矛盾的。用**已到达的阶段集合**反推标题，零额外 props。
   */
  const headerLabel = useMemo((): string => {
    const phases = new Set(ordered.sorted.map((step): AgentReasoningPhase => step.phase));
    if (!phases.has('MCP_TOOL_INVOKE')) {
      /* 没有工具调用：说明这是一次"只思考不操作"的对话或巡检 */
      return phases.has('RAG_RETRIEVAL') ? '集群巡检推理' : '对话意图识别';
    }
    return phases.has('RAG_RETRIEVAL') ? 'AI 诊断推理链' : '工具调度推理';
  }, [ordered.sorted]);

  /**
   * 最新一步的阶段（驱动底部提示文案）。
   * 无步骤时回落到意图规划，保证流式刚开始就有合理文案。
   */
  const latestPhase: AgentReasoningPhase =
    ordered.sorted.length > 0 ? ordered.sorted[ordered.sorted.length - 1].phase : 'INTENT_PLANNING';

  /* 无步骤且不在流式中：不渲染（避免空白面板占位） */
  if (ordered.sorted.length === 0 && !isStreaming) return null;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-white/[0.07] bg-slate-900/50',
        className,
      )}
      aria-label="AI 思考与规划过程"
    >
      {/* ============ 折叠头部（点击切换） ============ */}
      <button
        type="button"
        onClick={(): void => {
          /* 标记用户已手动干预：此后流式状态变化不再自动接管展开态 */
          userToggledRef.current = true;
          setExpanded((prev): boolean => !prev);
        }}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-slate-800/40"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-cyan-400" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-cyan-400" aria-hidden />
        )}
        <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
        <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300">
          {headerLabel}
        </span>

        {/* 摘要徽标：步数 + 总耗时 */}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums text-slate-500">
          <span className="rounded-full border border-white/[0.07] bg-slate-800/70 px-1.5 py-0.5 text-slate-400">
            {ordered.sorted.length} 步
          </span>
          <span>{ordered.total} ms</span>
        </span>

        {/* 流式指示器：脉冲点 */}
        {isStreaming ? (
          <span className="h-1.5 w-1.5 shrink-0 animate-glow-pulse rounded-full bg-cyan-400" aria-label="思考中" />
        ) : null}
      </button>

      {/* ============ 展开态：时间轴 ============ */}
      {expanded ? (
        <ol className="relative space-y-0 border-t border-white/[0.07] px-2.5 py-2">
          {/* 纵向时间轴主线（absolute 贯穿，视觉上把各步骤串成一条推理链） */}
          <span
            className="pointer-events-none absolute bottom-3 left-[15px] top-3 w-px bg-gradient-to-b from-cyan-500/40 via-slate-500 to-transparent"
            aria-hidden
          />

          {/*
           * 【流式逐项入场 —— 让"推理推进"真正被看见】
           *
           * 服务端已改为按阶段真实推送（每步之间插入 280~320ms 等待），
           * 组件侧用 motion 把每一次追加渲染成一次"新的思考发生"：
           * 淡入 + 从下方 6px 上浮到位，220ms easeOut。
           *
           * 【为何用 y 而非 x】推理步骤是**纵向时间轴**上的追加项，
           * 沿 y 轴上浮与"时间向下延展"的方向一致；x 偏移会让它看起来像
           * 从侧边滑入的卡片，与时间轴的语义不符。
           */}
          <AnimatePresence initial={false}>
            {ordered.sorted.map((step, index) => {
              const Icon = PHASE_ICON[step.phase];
              const isLatest = index === ordered.sorted.length - 1;
              /* 只有"最新一步"且仍在流式时才显示进行中加载器 */
              const isPending = isLatest && isStreaming;
              return (
                <motion.li
                  key={step.stepIndex}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                  className="relative flex gap-2 py-1.5 pl-0"
                >
                  {/* 时间轴节点圆点：最新一步在流式中带脉冲光环 */}
                  <span className="relative z-10 mt-1 flex h-2 w-2 shrink-0 items-center justify-center">
                    {isPending ? (
                      <span
                        className={cn(
                          'absolute h-2 w-2 animate-ping rounded-full opacity-50',
                          PHASE_DOT[step.phase],
                        )}
                        aria-hidden
                      />
                    ) : null}
                    <span className={cn('h-1.5 w-1.5 rounded-full', PHASE_DOT[step.phase])} aria-hidden />
                  </span>

                  <div className="min-w-0 flex-1">
                    {/* 阶段徽标 + 标题 + 耗时 + 进行中加载器 */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider',
                          PHASE_BADGE[step.phase],
                          PHASE_TEXT[step.phase],
                        )}
                      >
                        <Icon className="h-2.5 w-2.5" aria-hidden />
                        {PHASE_LABEL[step.phase]}
                      </span>
                      <span className="min-w-0 flex-1 font-mono text-[10px] font-bold text-slate-200">
                        {step.title}
                      </span>

                      {/*
                       * 【进行中加载器】流式期间只有最新一步挂旋转圈，
                       * 用来表达"这一步尚未完成，后续步骤可能继续到达"。
                       * 已完成步骤不挂——那会让整条链看起来永远在忙。
                       */}
                      {isPending ? (
                        <Loader2
                          className={cn('h-2.5 w-2.5 shrink-0 animate-spin', PHASE_TEXT[step.phase])}
                          aria-label="该步骤进行中"
                        />
                      ) : null}

                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-500">
                        {step.latencyMs} ms
                      </span>
                    </div>

                    {/*
                     * 思考详情。
                     *
                     * 【为何改为 InlineMarkdown 渲染】detail 由服务端模板拼装，
                     * 实测会包含两类富文本线索：
                     * 1. 反引号包裹的工具名（`renderPodMetrics`）——此前原样
                     *    暴露反引号；
                     * 2. 裸 Runbook 编号（RUNBOOK-K8S-042）与相似度百分比——
                     *    混在中文句子里毫无辨识度。
                     * 现在前者渲染为胶囊、后者经 highlightRunbookIds 自动提升
                     * 为青色代码胶囊，用户一眼就能定位"这条结论引自哪本手册"。
                     * whitespace-pre-wrap 保留在段落上，多行 detail 的换行不变。
                     */}
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-caption leading-relaxed text-slate-500">
                      <InlineMarkdown text={step.detail} highlightRunbookIds />
                    </p>

                    {/*
                     * ---- RAG 融合检索命中率指示条（仅检索阶段） ----
                     *
                     * 【为何内联在步骤里而非卡片底部】思考链是"推理过程"，
                     * 检索是其中一步。把融合结果挂在这一步下方，推理链与
                     * 下方 GenUI 根因卡形成**数据呼应**：用户看到链条里
                     * 显示"BM25 主导 46%"，往下滚就能在根因卡上看到
                     * 同一条三色条与同样的份额——两处讲的是同一件事。
                     *
                     * 【为何用微型条而非完整图例】思考链是折叠区内的紧凑视图，
                     * 完整图例已在根因卡上。此处只需传递"三路各占多少"，
                     * 因此采用单行细条 + 三个微型百分比，不重复长文案。
                     */}
                    {step.phase === 'RAG_RETRIEVAL' && ragBreakdown?.available === true ? (
                      <div
                        className="mt-1 rounded border border-emerald-500/20 bg-emerald-500/[0.04] px-1.5 py-1"
                        aria-label="RAG 融合检索信号构成"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-emerald-400/70">
                            融合检索
                          </span>
                          {/* 三色微型条 */}
                          <div className="flex h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-800">
                            {ragBreakdown.signals.map((signal) =>
                              signal.share > 0 ? (
                                <div
                                  key={`badge-${signal.key}`}
                                  className={cn('h-full', signal.barClass)}
                                  style={{ width: `${signal.share * 100}%` }}
                                  title={`${signal.label} 得分 ${formatScore(signal.score)}`}
                                />
                              ) : null,
                            )}
                          </div>
                          <span
                            className="shrink-0 font-mono text-[10px] font-bold tabular-nums text-emerald-300"
                            title="校准后的置信度"
                          >
                            {formatSharePercent(ragBreakdown.calibratedScore)}
                          </span>
                        </div>
                        {/* 三路微型百分比 */}
                        <div className="mt-0.5 flex items-center gap-2">
                          {ragBreakdown.signals.map((signal) => (
                            <span
                              key={`legend-${signal.key}`}
                              className="flex items-center gap-0.5 font-mono text-[10px] tabular-nums text-slate-500"
                              title={signal.description}
                            >
                              <span
                                className={cn('h-1 w-1 shrink-0 rounded-full', signal.dotClass)}
                                aria-hidden
                              />
                              <span className={signal.textClass}>{signal.term}</span>
                              {formatSharePercent(signal.share)}
                            </span>
                          ))}
                          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-slate-500">
                            RRF {formatScore(ragBreakdown.fusedScore)}
                          </span>
                        </div>
                      </div>
                    ) : null}

                    {/* MCP 协议 URI 高亮标签（仅工具调用阶段存在） */}
                    {step.mcpUri !== undefined ? (
                      <span className="mt-1 inline-flex max-w-full items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5">
                        <Plug className="h-2.5 w-2.5 shrink-0 text-amber-400" aria-hidden />
                        <code className="truncate font-mono text-[11px] text-amber-300">{step.mcpUri}</code>
                      </span>
                    ) : null}
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>

          {/*
           * 流式收尾标记：表示"还有下一步在生成"。
           * 文案按最新步骤的 phase 动态变化——用户能读到系统此刻的具体动作，
           * 而不是一句对任何阶段都成立、因而毫无信息量的"深度思考中"。
           */}
          {isStreaming ? (
            <li className="relative flex items-center gap-2 py-1">
              <span className="relative z-10 flex h-2 w-2 shrink-0 items-center justify-center">
                <span className="h-1.5 w-1.5 animate-glow-pulse rounded-full bg-cyan-400" aria-hidden />
              </span>
              <span className="font-mono text-[10px] italic text-cyan-400/70">
                {PHASE_STREAMING_HINT[latestPhase]}
              </span>
            </li>
          ) : null}
        </ol>
      ) : null}
    </div>
  );
}