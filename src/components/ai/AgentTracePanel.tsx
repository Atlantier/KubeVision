'use client';

/**
 * AgentTracePanel —— 请求链路追踪紧凑摘要与按需展开瀑布面板。
 *
 * 【设计意图】
 * 1. 默认折叠为单行紧凑摘要条（约 28px 高），仅呈核心响应指标（TTFT / 总耗时 / 词元数）
 *    与展开入口，避免在右侧抽屉外围长期侵占对话正文可视高度。
 * 2. 点击「详情」展开限高滚动瀑布图与诚实边界声明（引擎 B 为确定性容灾引擎，节拍为编排值）。
 * 3. 在演示/录屏模式（present=true）下默认隐藏，支持通过上层「更多操作」菜单按需显隐。
 *
 * 【数据来源】useAgentTraceStore，由 CopilotDrawer 的 NDJSON 解析器写入（span / trace-summary 事件），零额外请求。
 */

import { memo, useState, type ReactElement } from 'react';
import { Activity, ChevronDown, ChevronUp } from 'lucide-react';
import { AGENT_COPY, UI_COPY } from '@/constants/copy';
import { usePresentMode } from '@/store/usePresentMode';
import {
  useAgentTraceStore,
  copyText,
  type ClientSpan,
  type ClientTraceSummary,
} from '@/store/useAgentTraceStore';
import { cn } from '@/utils/cn';

/** 预算阈值（毫秒） */
const TTFT_BUDGET_MS = 2000;
const TOTAL_BUDGET_MS = 8000;

export interface AgentTracePanelProps {
  /** 允许上层（如「更多」菜单）显式控制是否在演示模式下也呈现该面板 */
  readonly visible?: boolean;
}

/**
 * AgentTracePanel —— 单次请求链路追踪紧凑摘要条与可展开瀑布面板。
 *
 * 仅订阅 useAgentTraceStore 的 traceId / spans / summary 与演示模式开关，
 * 并以 React.memo 隔离流式文本合帧重渲染。
 */
function AgentTracePanel({ visible }: AgentTracePanelProps): ReactElement | null {
  const traceId = useAgentTraceStore((s): string | null => s.traceId);
  const spans = useAgentTraceStore((s): readonly ClientSpan[] => s.spans);
  const summary = useAgentTraceStore((s): ClientTraceSummary | null => s.summary);
  const present = usePresentMode((s): boolean => s.present);
  const [expanded, setExpanded] = useState<boolean>(false);

  const shouldShow = visible ?? !present;
  if (traceId === null || !shouldShow) return null;

  const ttftSlow = summary !== null && summary.ttftMs > TTFT_BUDGET_MS;
  const totalSlow = summary !== null && summary.totalMs > TOTAL_BUDGET_MS;

  let maxSpanEnd = 0;
  for (const span of spans) {
    const end = span.startMs + span.durationMs;
    if (end > maxSpanEnd) {
      maxSpanEnd = end;
    }
  }
  const timelineTotal = Math.max(1, summary?.totalMs ?? 0, maxSpanEnd);

  return (
    <div
      role="region"
      aria-label={AGENT_COPY.traceRegionLabel}
      className="min-w-0 max-w-full rounded-kv border border-white/[0.075] bg-slate-950/60 px-2 py-1"
    >
      {/* ============ 紧凑单行摘要头（常态仅占 1 行） ============ */}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[10px] tabular-nums">
          <span className="flex shrink-0 items-center gap-1 text-slate-400">
            <Activity className="h-3 w-3 shrink-0 text-cyan-400/80" aria-hidden />
            <span>{UI_COPY.traceHeader}</span>
          </span>

          {summary !== null ? (
            <div className="flex min-w-0 items-center gap-2 truncate">
              <span className={cn('shrink-0', ttftSlow ? 'text-amber-300' : 'text-cyan-300')}>
                {UI_COPY.traceTtftLabel} {summary.ttftMs.toFixed(0)}ms
              </span>
              <span className={cn('shrink-0', totalSlow ? 'text-amber-300' : 'text-slate-300')}>
                {UI_COPY.traceTotalLabel} {summary.totalMs.toFixed(0)}ms
              </span>
              {summary.promptTokens !== undefined || summary.completionTokens !== undefined ? (
                <span className="hidden truncate text-slate-400 sm:inline">
                  {summary.promptTokens ?? 0}/{summary.completionTokens ?? 0} tok
                </span>
              ) : null}
            </div>
          ) : (
            <span className="truncate text-slate-400">{UI_COPY.traceWaitingSummary}</span>
          )}
        </div>

        <button
          type="button"
          onClick={(): void => setExpanded((prev): boolean => !prev)}
          aria-expanded={expanded}
          aria-label={expanded ? '收起链路追踪瀑布详情' : '展开链路追踪瀑布详情'}
          className="flex shrink-0 items-center gap-1 rounded border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-slate-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-200"
        >
          <span>{expanded ? '收起' : `详情 (${spans.length})`}</span>
          {expanded ? (
            <ChevronUp className="h-2.5 w-2.5" aria-hidden />
          ) : (
            <ChevronDown className="h-2.5 w-2.5" aria-hidden />
          )}
        </button>
      </div>

      {/* ============ 按需展开：链路编号 + 全量汇总 + 限高瀑布时间轴 ============ */}
      {expanded ? (
        <div className="mt-1.5 border-t border-white/[0.06] pt-1.5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 font-mono text-[10px] tabular-nums">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-slate-400">
              <span>
                {summary === null
                  ? UI_COPY.traceTokensUnconfigured
                  : summary.promptTokens === undefined && summary.completionTokens === undefined
                    ? UI_COPY.traceTokensUnconfigured
                    : `${UI_COPY.traceTokensPrefix} ${summary.promptTokens ?? 0}/${summary.completionTokens ?? 0}`}
              </span>
              <span>
                {summary === null || summary.costCny === undefined
                  ? UI_COPY.traceCostUnconfigured
                  : `${UI_COPY.traceCostPrefix} ¥${summary.costCny.toFixed(4)}`}
              </span>
            </div>
            <button
              type="button"
              onClick={(): void => {
                void copyText(traceId);
              }}
              aria-label={`复制链路编号 ${traceId}`}
              title="点击复制链路编号"
              className="min-w-0 max-w-full truncate rounded-kv border border-white/[0.075] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-cyan-300/90 outline-none hover:text-cyan-200 focus-visible:ring-1 focus-visible:ring-cyan-400/60"
            >
              {traceId}
            </button>
          </div>

          <div className="mt-1.5 max-h-32 space-y-1 overflow-y-auto pr-0.5">
            {spans.map((span, index): ReactElement => {
              const rawLeft = (span.startMs / timelineTotal) * 100;
              const left = Math.max(0, Math.min(98, rawLeft));
              const rawWidth = (span.durationMs / timelineTotal) * 100;
              const width = Math.max(2, Math.min(100 - left, rawWidth));
              return (
                <div key={`${span.name}-${span.startMs}-${index}`} className="flex min-w-0 items-center gap-2">
                  <span
                    title={span.name}
                    className="w-[88px] shrink-0 truncate font-mono text-[10px] text-slate-400"
                  >
                    {span.name}
                  </span>
                  <span className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <span
                      className={
                        span.status === 'error'
                          ? 'absolute top-0 h-full rounded-full bg-rose-400'
                          : 'absolute top-0 h-full rounded-full bg-cyan-400/70'
                      }
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  </span>
                  <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-300">
                    {span.durationMs.toFixed(0)}ms
                  </span>
                </div>
              );
            })}
          </div>

          {/* 诚实边界说明：仅随详情展开显示 */}
          <p className="mt-1.5 border-t border-white/[0.06] pt-1 font-mono text-[10px] leading-relaxed text-slate-400">
            引擎 B 为确定性容灾引擎（非 LLM），节拍为编排值。
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default memo(AgentTracePanel);
