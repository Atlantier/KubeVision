'use client';

/**
 * AgentTracePanel —— 请求链路瀑布图（R36 · 追问 2/3）
 *
 * 【数据来源】useAgentTraceStore，由 CopilotDrawer 的 NDJSON 解析器写入
 * （span / trace-summary 事件），零额外请求。
 *
 * 【预算标注】TTFT > 2000ms 或 total > 8000ms 时对应数值以 amber 显示；
 * 这是回放"慢在哪"的第一层线索，不替代真实 APM。
 *
 * 【时间轴归一化】所有 span 共享同一 `timelineTotal`（取 `summary.totalMs` 与各 span
 * `startMs + durationMs` 最大值），保证不同阶段条形宽度按真实耗时比例展示，
 * 不再各自按自身结束时间归一导致首段恒为 100%。
 *
 * 【诚实边界】底部固定一行：引擎 B 为确定性容灾引擎（非 LLM），节拍为编排值。
 */

import { memo, type ReactElement } from 'react';
import { AGENT_COPY, UI_COPY } from '@/constants/copy';
import {
  useAgentTraceStore,
  copyText,
  type ClientSpan,
  type ClientTraceSummary,
} from '@/store/useAgentTraceStore';

/** 预算阈值（毫秒） */
const TTFT_BUDGET_MS = 2000;
const TOTAL_BUDGET_MS = 8000;

/**
 * AgentTracePanel —— 单次请求链路追踪与瀑布耗时面板。
 *
 * 仅订阅 useAgentTraceStore 的 traceId / spans / summary，并以 React.memo 隔离
 * 父级流式文本合帧重渲染，避免伴随每个 token 提交重复渲染瀑布图。
 */
function AgentTracePanel(): ReactElement | null {
  const traceId = useAgentTraceStore((s): string | null => s.traceId);
  const spans = useAgentTraceStore((s): readonly ClientSpan[] => s.spans);
  const summary = useAgentTraceStore((s): ClientTraceSummary | null => s.summary);

  if (traceId === null) return null;

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
      className="min-w-0 max-w-full rounded-kv border border-white/[0.075] bg-slate-950/60 p-2"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
          {UI_COPY.traceHeader}
        </span>
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

      {summary !== null ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums">
          <span className={ttftSlow ? 'text-amber-300' : 'text-slate-300'}>
            {UI_COPY.traceTtftLabel} {summary.ttftMs.toFixed(0)}ms
          </span>
          <span className={totalSlow ? 'text-amber-300' : 'text-slate-300'}>
            {UI_COPY.traceTotalLabel} {summary.totalMs.toFixed(0)}ms
          </span>
          <span className="text-slate-400">
            {summary.promptTokens === undefined && summary.completionTokens === undefined
              ? UI_COPY.traceTokensUnconfigured
              : `${UI_COPY.traceTokensPrefix} ${summary.promptTokens ?? 0}/${summary.completionTokens ?? 0}`}
          </span>
          <span className="text-slate-400">
            {summary.costCny === undefined
              ? UI_COPY.traceCostUnconfigured
              : `${UI_COPY.traceCostPrefix} ¥${summary.costCny.toFixed(4)}`}
          </span>
        </div>
      ) : (
        <p className="mt-1.5 font-mono text-[10px] text-slate-400">{UI_COPY.traceWaitingSummary}</p>
      )}

      <div className="mt-1.5 space-y-1">
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

      {/* R36 追问 3：诚实边界（固定行） */}
      <p className="mt-1.5 border-t border-white/[0.06] pt-1 font-mono text-[10px] leading-relaxed text-slate-500">
        引擎 B 为确定性容灾引擎（非 LLM），节拍为编排值。
      </p>
    </div>
  );
}

export default memo(AgentTracePanel);
