/**
 * KubeVision AI — 服务端遥测/长连接指标账本与单行 JSON 结构化日志（R13）
 *
 * 【设计意图】
 * 1. 把进程级 SSE 连接预算、总帧数、心跳帧数、预算拒收次数、最大存活回收次数、
 *    最近采集耗时（ms）与连续失败计数统一收敛在 `globalThis` 单例上（防 Next.js HMR/多 chunk 割裂）；
 * 2. 提供严格单行 JSON 结构化日志输出，所有事件携带 `traceId` 与 `durationMs`，
 *    并对字符串字段执行换行/控制字符/长度清洗，绝不输出未脱敏的原始用户日志文本。
 */

import type { StructuredTelemetryLogEvent } from '@/types/health';

/** 默认最大并发 SSE 长连接数（支持 20 并发压测同时防止无限连接耗尽） */
const DEFAULT_MAX_SSE_CONNECTIONS = Math.max(
  1,
  Number.parseInt(process.env.KV_MAX_SSE_CONNECTIONS ?? '24', 10) || 24,
);

/** 单条 SSE 默认兜底存活时长：Vercel Serverless 自动设为 50 秒（抢在 60s 网关限制前平滑轮转），本地默认 30 分钟 */
const DEFAULT_SSE_LIFETIME_FALLBACK_MS =
  process.env.VERCEL === '1' ? 50_000 : 30 * 60 * 1000;

/** 默认单条 SSE 连接最大存活窗口（支持 KV_MAX_SSE_LIFETIME_MS 覆盖，到期提示客户端平滑重连） */
export const DEFAULT_MAX_SSE_LIFETIME_MS = Math.max(
  5_000,
  Number.parseInt(
    process.env.KV_MAX_SSE_LIFETIME_MS ?? String(DEFAULT_SSE_LIFETIME_FALLBACK_MS),
    10,
  ) || DEFAULT_SSE_LIFETIME_FALLBACK_MS,
);

/**
 * normalizeEnvValue —— 规范化环境变量字符串（去首尾空白与成对包裹引号，空串转为 undefined）。
 *
 * 【设计意图】Vercel 控制台或 `.env.local` 复制粘贴配置时，常见误带首尾空格、换行或
 * 成对引号（`"https://..."` / `'sk-...'`），直接传给 HTTP Header 或 URL 构造器会触发
 * 401/URL 解析异常，导致配置的环境变量看似“不生效”。
 *
 * @param raw `process.env[key]` 原始值
 * @returns 规范化后的非空字符串，无效/空串返回 undefined
 */
export function normalizeEnvValue(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let cleaned = raw.trim();
  if (
    cleaned.length >= 2 &&
    ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'")))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * normalizeBaseUrl —— 规范化 OpenAI 兼容网关基址（去引号/空白与末尾多余斜杠）。
 */
function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const normalized = normalizeEnvValue(raw);
  if (normalized === undefined) return undefined;
  const stripped = normalized.replace(/\/+$/, '');
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * parseBoundedEnvNumber —— 安全解析数值型环境变量（空串或 NaN 自动回退默认值并夹紧范围）。
 */
function parseBoundedEnvNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  integerOnly = false,
): number {
  const normalized = normalizeEnvValue(raw);
  if (normalized === undefined) return fallback;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.min(max, Math.max(min, parsed));
  return integerOnly ? Math.trunc(clamped) : clamped;
}

/**
 * isConfiguredLlmApiKey —— 判断 OPENAI_API_KEY 是否为真实可用凭证。
 *
 * 【设计意图】过滤 `.env.example` 中的常见示例占位符（如 `your-api-key-here`），
 * 防止未填真实密钥时 `/api/health` 误报 `llmConfigured: true` 以及 `/api/chat`
 * 徒耗一次外部 401 往返才降级。
 *
 * @param apiKey 环境变量读取到的原始密钥值
 * @returns 为非空且非示例占位符时返回 true
 */
export function isConfiguredLlmApiKey(apiKey: string | undefined): apiKey is string {
  const normalized = normalizeEnvValue(apiKey);
  if (normalized === undefined) return false;
  return !/^(your-[a-z0-9-]*key-here|sk-your-[a-z0-9-]*key-here|replace-with-your-key|<your-[a-z0-9-]*key>)$/i.test(
    normalized,
  );
}

/** 服务端统一解析后的 LLM 环境配置（供 /api/chat 与 /api/health 共用，防止双端口径漂移） */
export interface LlmEnvConfig {
  /** 已去空白/去引号的有效密钥（未配置或占位符时为 undefined） */
  readonly apiKey: string | undefined;
  /** 是否具备可用 LLM 凭证 */
  readonly llmConfigured: boolean;
  /** 已去末尾斜杠与空串兜底的 OpenAI 兼容网关基址（缺省为 undefined，走 SDK 默认值） */
  readonly baseURL: string | undefined;
  /** 模型名称（优先级：AI_MODEL_NAME -> OPENAI_MODEL -> 'glm-4-flash'） */
  readonly modelName: string;
  /** 采样温度 [0, 2] */
  readonly temperature: number;
  /** 最大重试次数 [0, 5] */
  readonly maxRetries: number;
  /** 是否对兼容网关自动关闭隐式 thinking（AI_DISABLE_THINKING !== 'false'） */
  readonly disableThinking: boolean;
}

/**
 * resolveLlmEnvConfig —— 单一权威 LLM 环境变量解析器。
 *
 * 【设计意图 / 输入输出 / 核心逻辑】
 * - 统一读取 `OPENAI_API_KEY`、`OPENAI_BASE_URL`（兼容 `OPENAI_API_BASE`）、
 *   `AI_MODEL_NAME`（兼容 `OPENAI_MODEL`，默认 `'glm-4-flash'`）、`AI_TEMPERATURE`、
 *   `AI_MAX_RETRIES` 与 `AI_DISABLE_THINKING`；
 * - 对所有字符串做去首尾空白、去成对引号、去基址尾部斜杠及空串兜底，确保
 *   `/api/health` 与 `/api/chat` 对同一份 Vercel / `.env.local` 配置得出完全一致的结论。
 *
 * @returns 强类型规范化配置对象 LlmEnvConfig
 */
export function resolveLlmEnvConfig(): LlmEnvConfig {
  const rawKey = normalizeEnvValue(process.env.OPENAI_API_KEY);
  const llmConfigured = isConfiguredLlmApiKey(rawKey);
  const baseURL = normalizeBaseUrl(process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE);
  const modelName =
    normalizeEnvValue(process.env.AI_MODEL_NAME) ??
    normalizeEnvValue(process.env.OPENAI_MODEL) ??
    'glm-4-flash';
  const disableThinkingRaw = normalizeEnvValue(process.env.AI_DISABLE_THINKING);

  return {
    apiKey: llmConfigured ? rawKey : undefined,
    llmConfigured,
    baseURL,
    modelName,
    temperature: parseBoundedEnvNumber(process.env.AI_TEMPERATURE, 0.3, 0, 2, false),
    maxRetries: parseBoundedEnvNumber(process.env.AI_MAX_RETRIES, 2, 0, 5, true),
    disableThinking: disableThinkingRaw?.toLowerCase() !== 'false',
  };
}

/** 默认 SSE 注释心跳帧发送周期（15 秒，防 Nginx / 负载均衡器空闲断流） */
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

interface InternalTelemetryMetricsState {
  readonly activeConnectionIds: Set<string>;
  totalFramesSent: number;
  totalHeartbeatsSent: number;
  budgetRejectedCount: number;
  lifetimeClosedCount: number;
  lastCollectionDurationMs: number;
  liveConsecutiveFailures: number;
  degradedToDemoCount: number;
}

const METRICS_GLOBAL_SYMBOL = Symbol.for('kubevision.telemetry.metrics.state');

interface GlobalWithMetrics {
  [METRICS_GLOBAL_SYMBOL]?: InternalTelemetryMetricsState;
}

/**
 * getState —— 获取或初始化跨模块共享的服务端遥测账本。
 */
function getState(): InternalTelemetryMetricsState {
  const g = globalThis as unknown as GlobalWithMetrics;
  if (g[METRICS_GLOBAL_SYMBOL] === undefined) {
    g[METRICS_GLOBAL_SYMBOL] = {
      activeConnectionIds: new Set<string>(),
      totalFramesSent: 0,
      totalHeartbeatsSent: 0,
      budgetRejectedCount: 0,
      lifetimeClosedCount: 0,
      lastCollectionDurationMs: 0,
      liveConsecutiveFailures: 0,
      degradedToDemoCount: 0,
    };
  }
  return g[METRICS_GLOBAL_SYMBOL];
}

/**
 * createTraceId —— 生成轻量可排序请求/连接追踪 ID。
 *
 * @param prefix 链路前缀（如 'sse' / 'chat'）
 */
export function createTraceId(prefix = 'kv'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/**
 * sanitizeAttr —— 清洗结构化日志附加属性，阻断换行注入与长文本外泄。
 */
function sanitizeAttr(value: string | number | boolean): string | number | boolean {
  if (typeof value !== 'string') return value;
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 160);
}

/**
 * logStructuredEvent —— 输出单行 JSON 结构化遥测/对话生命周期事件。
 *
 * 【日志规范】始终包含 `event / route / traceId / durationMs / timestamp`，
 * 禁止记录未脱敏的用户消息原文、原始日志正文或任何 Bearer/API 密钥。
 */
export function logStructuredEvent(event: StructuredTelemetryLogEvent): void {
  const sanitizedAttrs: Record<string, string | number | boolean> = {};
  if (event.attrs !== undefined) {
    for (const [k, v] of Object.entries(event.attrs)) {
      if (v !== undefined) sanitizedAttrs[k] = sanitizeAttr(v);
    }
  }
  const line = JSON.stringify({
    event: event.event,
    route: event.route,
    traceId: event.traceId,
    durationMs: Math.max(0, Math.round(event.durationMs * 100) / 100),
    timestamp: event.timestamp,
    ...(Object.keys(sanitizedAttrs).length > 0 ? { attrs: sanitizedAttrs } : {}),
  });
  console.log(line);
}

/**
 * tryAcquireSseSlot —— 原子检查并发预算并登记 SSE 连接 ID（只紧不松）。
 */
export function tryAcquireSseSlot(
  connId: string,
  requestedMax?: number,
): { readonly acquired: boolean; readonly activeConnections: number; readonly maxConnections: number } {
  const state = getState();
  const effectiveMax =
    typeof requestedMax === 'number' && Number.isFinite(requestedMax) && requestedMax >= 1
      ? Math.min(DEFAULT_MAX_SSE_CONNECTIONS, Math.trunc(requestedMax))
      : DEFAULT_MAX_SSE_CONNECTIONS;

  if (state.activeConnectionIds.size >= effectiveMax) {
    state.budgetRejectedCount += 1;
    return {
      acquired: false,
      activeConnections: state.activeConnectionIds.size,
      maxConnections: effectiveMax,
    };
  }

  state.activeConnectionIds.add(connId);
  return {
    acquired: true,
    activeConnections: state.activeConnectionIds.size,
    maxConnections: effectiveMax,
  };
}

/**
 * releaseSseSlot —— 幂等释放 SSE 连接配额。
 */
export function releaseSseSlot(connId: string): void {
  getState().activeConnectionIds.delete(connId);
}

/** 记录一次 SSE 数据帧发送 */
export function recordSseFrame(): void {
  getState().totalFramesSent += 1;
}

/** 记录一次 SSE 心跳帧发送 */
export function recordSseHeartbeat(): void {
  getState().totalHeartbeatsSent += 1;
}

/** 记录一次 SSE 单连接最大存活期满回收 */
export function recordSseLifetimeClose(): void {
  getState().lifetimeClosedCount += 1;
}

/** 记录一次 live 采集退化为 demo 合成源 */
export function recordDegradedToDemo(): void {
  getState().degradedToDemoCount += 1;
}

/**
 * recordLiveCollectionResult —— 记录一次实时采集耗时与成功/失败连续次数。
 */
export function recordLiveCollectionResult(durationMs: number, ok: boolean): number {
  const state = getState();
  state.lastCollectionDurationMs = Math.max(0, Math.round(durationMs * 100) / 100);
  if (ok) {
    state.liveConsecutiveFailures = 0;
  } else {
    state.liveConsecutiveFailures += 1;
  }
  return state.liveConsecutiveFailures;
}

/**
 * getTelemetryHealthMetrics —— 读取 `/api/health` 所需的只读遥测与预算快照。
 */
export function getTelemetryHealthMetrics(): {
  readonly activeConnections: number;
  readonly maxConnections: number;
  readonly maxConnectionLifetimeMs: number;
  readonly totalFramesSent: number;
  readonly totalHeartbeatsSent: number;
  readonly budgetRejectedCount: number;
  readonly lifetimeClosedCount: number;
  readonly lastCollectionDurationMs: number;
  readonly liveConsecutiveFailures: number;
  readonly degradedToDemoCount: number;
} {
  const state = getState();
  return {
    activeConnections: state.activeConnectionIds.size,
    maxConnections: DEFAULT_MAX_SSE_CONNECTIONS,
    maxConnectionLifetimeMs: DEFAULT_MAX_SSE_LIFETIME_MS,
    totalFramesSent: state.totalFramesSent,
    totalHeartbeatsSent: state.totalHeartbeatsSent,
    budgetRejectedCount: state.budgetRejectedCount,
    lifetimeClosedCount: state.lifetimeClosedCount,
    lastCollectionDurationMs: state.lastCollectionDurationMs,
    liveConsecutiveFailures: state.liveConsecutiveFailures,
    degradedToDemoCount: state.degradedToDemoCount,
  };
}
