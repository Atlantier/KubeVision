/**
 * KubeVision AI — 服务端轻量链路追踪（R35 · A）
 *
 * 【为什么不用 OTel】本项目要求"零新增依赖、服务端纯函数"：
 * OpenTelemetry 需要 SDK + exporter + 上下文管理，对本项目的单进程 NDJSON 流
 * 是过度设计。这里用 `performance.now()` + 纯函数实现最小 span 模型，
 * 产物直接写入既有 NDJSON 流（`type:'span'` / `type:'trace-summary'`）。
 *
 * 【坐标语义】
 *   - `startMs` 是相对本 trace 创建时刻的毫秒偏移（便于前端画瀑布图）；
 *   - `durationMs` 是 span 自身耗时；
 *   - traceId 用 16 位十六进制（时间戳 + 计数器，单进程唯一性足够）。
 *
 * 【线程模型】纯函数、无全局副作用；同一请求内的调用是串行 await，
 * 并发请求各自持有自己的 trace 对象，不会互相干扰。
 */

/** 一个 trace 的上下文 */
export interface AgentTrace {
  /** 16 位十六进制 trace id */
  readonly traceId: string;
  /** trace 创建时刻（performance.now()） */
  readonly startedAt: number;
}

/** 一个 span 的句柄 */
export interface AgentSpan {
  /** 所属 trace */
  readonly trace: AgentTrace;
  /** span 名称（如 intent-route / rag-retrieve / llm-first-token） */
  readonly name: string;
  /** 起始时刻（performance.now()） */
  readonly startedAt: number;
  /** 相对 trace 起点的毫秒偏移 */
  readonly startMs: number;
}

/** 结束 span 时的状态与附加属性 */
export interface EndSpanOptions {
  /** 'ok' 或 'error' */
  readonly status: 'ok' | 'error';
  /** 附加属性（只允许可 JSON 序列化的值） */
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
}

/** 结束后的 span 事件载荷（与 NDJSON `type:'span'` 对齐） */
export interface EndedSpan {
  /** 所属 trace id */
  readonly traceId: string;
  /** span 名称 */
  readonly name: string;
  /** 相对 trace 起点偏移（毫秒） */
  readonly startMs: number;
  /** 耗时（毫秒，保留 2 位小数） */
  readonly durationMs: number;
  /** 状态 */
  readonly status: 'ok' | 'error';
  /** 附加属性 */
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
}

/** 模块级计数器（用于 traceId 去重；纯内存、无 IO） */
let traceCounter = 0;

/**
 * createTrace —— 创建一个 trace。
 *
 * @returns trace 上下文
 */
export function createTrace(): AgentTrace {
  traceCounter = (traceCounter + 1) % 0xffff;
  const stamp = Math.floor(performance.now() * 1000).toString(16).padStart(10, '0');
  const counter = traceCounter.toString(16).padStart(4, '0');
  return {
    traceId: `${stamp}${counter}`.slice(-16),
    startedAt: performance.now(),
  };
}

/**
 * startSpan —— 在 trace 内开始一个 span。
 *
 * @param trace 所属 trace
 * @param name span 名称
 * @returns span 句柄
 */
export function startSpan(trace: AgentTrace, name: string): AgentSpan {
  const startedAt = performance.now();
  return {
    trace,
    name,
    startedAt,
    startMs: Math.max(0, startedAt - trace.startedAt),
  };
}

/**
 * endSpan —— 结束 span，返回可直接写入 NDJSON 的事件载荷。
 *
 * @param span startSpan 的返回值
 * @param options 状态与属性
 * @returns span 事件载荷
 */
export function endSpan(span: AgentSpan, options: EndSpanOptions): EndedSpan {
  const endedAt = performance.now();
  return {
    traceId: span.trace.traceId,
    name: span.name,
    startMs: Math.round(span.startMs * 100) / 100,
    durationMs: Math.round((endedAt - span.startedAt) * 100) / 100,
    status: options.status,
    ...(options.attrs === undefined ? {} : { attrs: options.attrs }),
  };
}

/**
 * elapsedMs —— trace 从创建到现在的毫秒数（保留 2 位小数）。
 *
 * @param trace trace 上下文
 * @returns 毫秒
 */
export function elapsedMs(trace: AgentTrace): number {
  return Math.round((performance.now() - trace.startedAt) * 100) / 100;
}