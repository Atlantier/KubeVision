/**
 * KubeVision AI — 前端 trace 瞬态仓库（R36）
 *
 * 【为什么非持久化】trace 是单次请求的诊断上下文，刷新即失效；
 * 持久化会把上次请求的耗时/成本带到下一次，产生误导。
 *
 * 【零重渲染边界】面板仅在抽屉展开时读取；写入发生在 NDJSON 事件解析处
 * （每请求 O(span 数) 次，不是每帧）。
 */

import { create } from 'zustand';

/** 前端可见的 span（与服务端 SpanStreamEvent 对齐） */
export interface ClientSpan {
  readonly traceId: string;
  readonly name: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly status: 'ok' | 'error';
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
}

/** trace 汇总（与服务端 TraceSummaryStreamEvent 对齐） */
export interface ClientTraceSummary {
  readonly traceId: string;
  readonly engine: 'llm' | 'simulator';
  readonly ttftMs: number;
  readonly totalMs: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly costCny?: number;
}

interface AgentTraceState {
  readonly traceId: string | null;
  readonly spans: readonly ClientSpan[];
  readonly summary: ClientTraceSummary | null;
  /** 开始一次新请求：清空上一轮 */
  readonly begin: () => void;
  /** 追加 span（同 traceId 才接受） */
  readonly appendSpan: (span: ClientSpan) => void;
  /** 设置汇总 */
  readonly setSummary: (summary: ClientTraceSummary) => void;
}

export const useAgentTraceStore = create<AgentTraceState>((set) => ({
  traceId: null,
  spans: [],
  summary: null,
  begin: (): void => set({ traceId: null, spans: [], summary: null }),
  appendSpan: (span): void =>
    set((state): AgentTraceState => {
      if (state.traceId !== null && state.traceId !== span.traceId) return state;
      return { ...state, traceId: span.traceId, spans: [...state.spans, span] };
    }),
  setSummary: (summary): void =>
    set({ traceId: summary.traceId, summary }),
}));

/**
 * copyText —— 复制到剪贴板（失败静默，不抛错）。
 *
 * @param text 要复制的文本
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* 剪贴板权限被拒时静默失败，不阻塞 UI */
  }
}