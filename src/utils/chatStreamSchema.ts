/**
 * KubeVision AI — NDJSON 流式事件运行时形状校验（R2 · zod 单一事实源）
 *
 * 【为什么需要运行时守卫】前端此前用 `JSON.parse(line) as ChatStreamEvent` 直接断言，
 * 没有任何运行时校验：一条畸形帧（缺字段 / 类型错位）会在 switch 分派里访问
 * `event.step.stepIndex` 之类的深层属性时直接抛错，整条流崩溃。现在用 zod 在消费前
 * 做形状校验，畸形帧走"降级块"而不是让整条诊断流陪葬。
 *
 * 【同源契约】本 schema 与 src/types/ai.ts 的 ChatStreamEvent 必须完全同形：
 * 文件末尾的 SCHEMA_TYPE_SYNC 用双向可赋值断言在编译期强制二者一致——
 * 任何一侧改了字段而另一侧没跟上，`pnpm typecheck` 立即报错。schema 即 z.infer 的
 * 唯一事实源，类型不允许与 schema 漂移。
 *
 * 【卡片载荷的校验粒度】tool-result.args 是三选一的复杂卡片 Props，这里用
 * z.custom 只做"null 或对象"的包络校验（防止把字符串/数字当卡片渲染而崩溃）；
 * 卡片内部的字段合法性由各 GenUI 组件与服务端 zod schema 各自负责，职责不越界。
 */

import { z } from 'zod';
import type {
  ChatStreamEvent,
  PodMetricsCardProps,
  RootCauseAlertProps,
  ActionConfirmProps,
} from '@/types/ai';

/* ---- 推理步骤（与 AgentReasoningStep 同形） ---- */
const reasoningPhaseSchema = z.enum([
  'INTENT_PLANNING',
  'MULTIMODAL_VISION',
  'RAG_RETRIEVAL',
  'MCP_TOOL_INVOKE',
  'SAFETY_GUARD',
]);

const reasoningStepSchema = z.object({
  stepIndex: z.number(),
  phase: reasoningPhaseSchema,
  title: z.string(),
  detail: z.string(),
  mcpUri: z.string().optional(),
  latencyMs: z.number(),
  sim: z.boolean().optional(),
});

/* ---- 卡片载荷包络：null 或对象（内部字段由各卡片组件自行校验） ---- */
const cardArgsSchema = z.custom<PodMetricsCardProps | RootCauseAlertProps | ActionConfirmProps | null>(
  (value): boolean => value === null || (typeof value === 'object' && value !== null),
);

/* ---- 各事件 schema（type 为判别键） ---- */
const reasoningEventSchema = z.object({ type: z.literal('reasoning'), step: reasoningStepSchema });
const textEventSchema = z.object({ type: z.literal('text'), content: z.string() });
const toolStartEventSchema = z.object({
  type: z.literal('tool-start'),
  toolCallId: z.string(),
  toolName: z.string(),
  mcpUri: z.string(),
});
const toolResultEventSchema = z.object({
  type: z.literal('tool-result'),
  toolCallId: z.string(),
  toolName: z.string(),
  args: cardArgsSchema,
  status: z.enum(['ok', 'error']).optional(),
  errorMessage: z.string().optional(),
  synthesized: z.boolean().optional(),
});
const engineEventSchema = z.object({
  type: z.literal('engine'),
  engine: z.enum(['llm', 'simulator']),
  reason: z.string().optional(),
});
const errorEventSchema = z.object({
  type: z.literal('error'),
  category: z.enum(['network', 'model', 'tool_args', 'server', 'abort']),
  message: z.string(),
  requestId: z.string(),
  traceId: z.string().optional(),
  retryable: z.boolean(),
});
const doneEventSchema = z.object({
  type: z.literal('done'),
  requestId: z.string(),
  engine: z.enum(['llm', 'simulator']),
});
const resetEventSchema = z.object({
  type: z.literal('reset'),
  requestId: z.string(),
  reason: z.string().optional(),
});
const spanEventSchema = z.object({
  type: z.literal('span'),
  traceId: z.string(),
  name: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  status: z.enum(['ok', 'error']),
  attrs: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
const traceSummaryEventSchema = z.object({
  type: z.literal('trace-summary'),
  traceId: z.string(),
  engine: z.enum(['llm', 'simulator']),
  ttftMs: z.number(),
  totalMs: z.number(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  costCny: z.number().optional(),
});

/**
 * chatStreamEventSchema —— NDJSON 行级事件判别联合 schema（z.infer 的唯一事实源）。
 * 与 src/types/ai.ts 的 ChatStreamEvent 一一对应，含 R2 新增的 reset 事件。
 */
export const chatStreamEventSchema = z.discriminatedUnion('type', [
  reasoningEventSchema,
  textEventSchema,
  toolStartEventSchema,
  toolResultEventSchema,
  engineEventSchema,
  errorEventSchema,
  doneEventSchema,
  resetEventSchema,
  spanEventSchema,
  traceSummaryEventSchema,
]);

/**
 * isChatStreamEvent —— 运行时形状守卫。
 *
 * 【输入输出】输入任意 JSON.parse 产物（unknown）；输出布尔，true 时把值窄化为
 * ChatStreamEvent。用 safeParse 而非 parse：畸形帧返回 false 走降级，绝不抛错。
 *
 * @param value 待校验的解析产物
 * @returns 是否为合法流事件
 */
export function isChatStreamEvent(value: unknown): value is ChatStreamEvent {
  return chatStreamEventSchema.safeParse(value).success;
}

/* ---- 同源编译期断言：schema 的 z.infer 必须与 ai.ts 的 ChatStreamEvent 完全同形 ---- */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * SCHEMA_TYPE_SYNC —— 编译期"同源"证明。
 *
 * 【为什么是常量而不是注释】若 schema 与 ChatStreamEvent 任一侧漂移，
 * MutuallyAssignable 会算出 false，而这里要求 true，`pnpm typecheck` 直接报错。
 * 这就把"schema 与类型同源"从口头约定变成了机器强制的闸门。
 */
export const SCHEMA_TYPE_SYNC: MutuallyAssignable<z.infer<typeof chatStreamEventSchema>, ChatStreamEvent> = true;