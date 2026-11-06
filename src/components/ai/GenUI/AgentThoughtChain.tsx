'use client';

/**
 * KubeVision AI — AI 思考与规划过程可视化（AgentThoughtChain）
 *
 * 【设计意图】LLM 给出的结论若只有结果没有过程，用户无从判断可信度。
 * 本组件把 AgentReasoningStep[] 渲染为一条可折叠的赛博极客风时间轴：
 * 折叠态只给「几步 / 总耗时」的摘要（不喧宾夺主），
 * 展开态逐条呈现阶段徽标、步骤标题、完整思考叙述、
 * mcp:// 协议 URI 高亮标签与每步耗时——把「AI 怎么想的」变成可审计的证据。
 *
 * 【视觉契约】深空赛博运维美学：纵向时间轴（左侧发光竖线 + 节点圆点），
 * 每阶段有独立语义色（规划青 / 视觉品红 / 检索翠绿 / 工具琥珀 / 护栏红），
 * 与项目状态色体系保持一致，不引入新的色彩语义。
 *
 * 【性能契约】纯展示组件：无定时器、无订阅、无副作用；
 * 展开/折叠为本地 useState，切换不触发父级重渲染。
 */

import { useMemo, useState } from 'react';
import {
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Eye,
  Library,
  Plug,
  ShieldAlert,
} from 'lucide-react';

import { cn } from '@/utils/cn';
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
}: AgentThoughtChainProps) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);

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

  /* 无步骤且不在流式中：不渲染（避免空白面板占位） */
  if (ordered.sorted.length === 0 && !isStreaming) return null;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-slate-800 bg-slate-900/50 backdrop-blur-sm',
        className,
      )}
      aria-label="AI 思考与规划过程"
    >
      {/* ============ 折叠头部（点击切换） ============ */}
      <button
        type="button"
        onClick={(): void => setExpanded((prev): boolean => !prev)}
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
          agent&nbsp;reasoning
        </span>

        {/* 摘要徽标：步数 + 总耗时 */}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums text-slate-500">
          <span className="rounded-full border border-slate-700 bg-slate-800/70 px-1.5 py-0.5 text-slate-400">
            {ordered.sorted.length}&nbsp;steps
          </span>
          <span>{ordered.total}&nbsp;ms</span>
        </span>

        {/* 流式指示器：脉冲点 */}
        {isStreaming ? (
          <span className="h-1.5 w-1.5 shrink-0 animate-glow-pulse rounded-full bg-cyan-400" aria-label="思考中" />
        ) : null}
      </button>

      {/* ============ 展开态：时间轴 ============ */}
      {expanded ? (
        <ol className="relative space-y-0 border-t border-slate-800 px-2.5 py-2">
          {/* 纵向时间轴主线（absolute 贯穿，视觉上把各步骤串成一条推理链） */}
          <span
            className="pointer-events-none absolute bottom-3 left-[15px] top-3 w-px bg-gradient-to-b from-cyan-500/40 via-slate-700 to-transparent"
            aria-hidden
          />

          {ordered.sorted.map((step) => {
            const Icon = PHASE_ICON[step.phase];
            return (
              <li key={step.stepIndex} className="relative flex gap-2 py-1.5 pl-0">
                {/* 时间轴节点圆点 */}
                <span className="relative z-10 mt-1 flex h-2 w-2 shrink-0 items-center justify-center">
                  <span className={cn('h-1.5 w-1.5 rounded-full', PHASE_DOT[step.phase])} aria-hidden />
                </span>

                <div className="min-w-0 flex-1">
                  {/* 阶段徽标 + 标题 + 耗时 */}
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
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-600">
                      {step.latencyMs}&nbsp;ms
                    </span>
                  </div>

                  {/* 思考详情（多行支持，pre-wrap 保留换行） */}
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-slate-500">
                    {step.detail}
                  </p>

                  {/* MCP 协议 URI 高亮标签（仅工具调用阶段存在） */}
                  {step.mcpUri !== undefined ? (
                    <span className="mt-1 inline-flex max-w-full items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5">
                      <Plug className="h-2.5 w-2.5 shrink-0 text-amber-400" aria-hidden />
                      <code className="truncate font-mono text-[11px] text-amber-300">{step.mcpUri}</code>
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}

          {/* 流式结束时的收尾标记 */}
          {isStreaming ? (
            <li className="relative flex items-center gap-2 py-1">
              <span className="relative z-10 flex h-2 w-2 shrink-0 items-center justify-center">
                <span className="h-1.5 w-1.5 animate-glow-pulse rounded-full bg-cyan-400" aria-hidden />
              </span>
              <span className="font-mono text-[10px] italic text-cyan-400/70">thinking…</span>
            </li>
          ) : null}
        </ol>
      ) : null}
    </div>
  );
}
