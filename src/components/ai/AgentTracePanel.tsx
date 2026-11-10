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
 * 【诚实边界】底部固定一行：引擎 B 为确定性容灾引擎（非 LLM），节拍为编排值。
 */

import { useAgentTraceStore, copyText } from '@/store/useAgentTraceStore';

/** 预算阈值（毫秒） */
const TTFT_BUDGET_MS = 2000;
const TOTAL_BUDGET_MS = 8000;

/** 瀑布条最大宽度（%）按 span 的 startMs+durationMs 归一 */
export default function AgentTracePanel(): React.ReactElement | null {
  const traceId = useAgentTraceStore((s): string | null => s.traceId);
  const spans = useAgentTraceStore((s): readonly import('@/store/useAgentTraceStore').ClientSpan[] => s.spans);
  const summary = useAgentTraceStore((s): import('@/store/useAgentTraceStore').ClientTraceSummary | null => s.summary);

  if (traceId === null) return null;

  const ttftSlow = summary !== null && summary.ttftMs > TTFT_BUDGET_MS;
  const totalSlow = summary !== null && summary.totalMs > TOTAL_BUDGET_MS;

  return (
    <div
      role="region"
      aria-label="请求链路追踪"
      className="rounded-kv border border-white/[0.075] bg-slate-950/60 p-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
          TRACE
        </span>
        <button
          type="button"
          onClick={(): void => {
            void copyText(traceId);
          }}
          aria-label={`复制 traceId ${traceId}`}
          title="点击复制 traceId"
          className="rounded-kv border border-white/[0.075] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-cyan-300/90 hover:text-cyan-200 focus-visible:ring-1 focus-visible:ring-cyan-400/60 outline-none"
        >
          {traceId}
        </button>
      </div>

      {summary !== null ? (
        <div className="mt-1.5 flex items-center gap-3 font-mono text-[10px] tabular-nums">
          <span className={ttftSlow ? 'text-amber-300' : 'text-slate-300'}>
            TTFT {summary.ttftMs.toFixed(0)}ms
          </span>
          <span className={totalSlow ? 'text-amber-300' : 'text-slate-300'}>
            TOTAL {summary.totalMs.toFixed(0)}ms
          </span>
          <span className="text-slate-500">
            {summary.promptTokens === undefined && summary.completionTokens === undefined
              ? 'TOKENS 未配置'
              : `TOKENS ${summary.promptTokens ?? 0}/${summary.completionTokens ?? 0}`}
          </span>
          <span className="text-slate-500">
            {summary.costCny === undefined ? 'COST 未配置' : `COST ¥${summary.costCny.toFixed(4)}`}
          </span>
        </div>
      ) : (
        <p className="mt-1.5 font-mono text-[10px] text-slate-500">等待 trace-summary…</p>
      )}

      <div className="mt-1.5 space-y-1">
        {spans.map((span): React.ReactElement => {
          const total = Math.max(1, span.startMs + span.durationMs);
          const left = (span.startMs / total) * 100;
          const width = Math.max(1, (span.durationMs / total) * 100);
          return (
            <div key={`${span.name}-${span.startMs}`} className="flex items-center gap-2">
              <span className="w-24 shrink-0 truncate font-mono text-[10px] text-slate-400">
                {span.name}
              </span>
              <span className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                <span
                  className={span.status === 'error' ? 'absolute top-0 h-full rounded-full bg-rose-400' : 'absolute top-0 h-full rounded-full bg-cyan-300/80'}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </span>
              <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-500">
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