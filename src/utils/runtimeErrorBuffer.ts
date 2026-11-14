'use client';

/**
 * KubeVision AI — 前端运行时异常环形缓冲区与全局监听器（R13 进阶 #5）
 *
 * 【设计意图】
 * 在不接入任何第三方埋点或网络上报的前提下，建立轻量级纯前端内存诊断缓冲区：
 * 1. 统一收口 `window.error`、`window.unhandledrejection` 以及 React ErrorBoundary 异常。
 * 2. 以 `(kind + 脱敏消息)` 作为去重键，在 2000ms 时间窗内合并高频重复风暴，防止死循环报错拖垮 UI。
 * 3. 采用固定容量 `MAX_ENTRIES = 20` 的环形队列策略（超限淘汰最旧条目），内存占用恒定有界。
 * 4. 供 PerfHUD 折叠区展示「最近 5 个异常」与一键复制诊断摘要。
 */

import type { RuntimeErrorEntry, RuntimeErrorKind } from '@/types/health';

const MAX_ENTRIES = 20;
const DEDUP_WINDOW_MS = 2000;
const MAX_MESSAGE_LEN = 240;
const MAX_SOURCE_LEN = 160;

export interface RuntimeErrorInput {
  readonly kind: RuntimeErrorKind;
  readonly message: string;
  readonly source?: string;
  readonly traceId?: string;
}

interface InternalBufferItem {
  readonly dedupKey: string;
  readonly lastSeenAtMs: number;
  readonly entry: RuntimeErrorEntry;
}

export interface RuntimeErrorDebugBridge {
  readonly record: (input: RuntimeErrorInput) => RuntimeErrorEntry;
  readonly getRecent: (limit?: number) => readonly RuntimeErrorEntry[];
  readonly clear: () => void;
  readonly formatSummary: (limit?: number) => string;
}

declare global {
  interface Window {
    __KUBEVISION_ERROR_BUFFER__?: RuntimeErrorDebugBridge;
  }
}

type ErrorBufferListener = () => void;

const bufferItems: InternalBufferItem[] = [];
const listeners = new Set<ErrorBufferListener>();
let traceSeq = 0;
let activeInstallCount = 0;
let teardownListeners: (() => void) | null = null;

function sanitizeErrorText(raw: unknown, maxLength: number): string {
  const base =
    typeof raw === 'string'
      ? raw
      : raw instanceof Error
        ? raw.message || raw.name
        : raw === null || raw === undefined
          ? ''
          : String(raw);

  const compact = base
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    .replace(/\b(sk-[A-Za-z0-9]{6,}|AIza[0-9A-Za-z_-]{8,})\b/g, '***')
    .replace(/\s+/g, ' ')
    .trim();

  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function hashKey(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function nextErrorTraceId(): string {
  traceSeq += 1;
  const ts = Date.now().toString(36);
  const seq = traceSeq.toString(36).padStart(3, '0');
  return `err-${ts}-${seq}`;
}

function notifyListeners(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      /* 监听器自身异常不得反向破坏异常缓冲区 */
    }
  });
}

function extractRejectionMessage(reason: unknown): { message: string; source: string } {
  if (reason instanceof Error) {
    const stackLine =
      typeof reason.stack === 'string'
        ? reason.stack
            .split('\n')
            .slice(1, 3)
            .map((line) => line.trim())
            .find((line) => line.length > 0) ?? ''
        : '';
    return {
      message: reason.message || reason.name || '未捕获 Promise 异常',
      source: stackLine || 'unhandledrejection',
    };
  }
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    const msg = (reason as { readonly message?: unknown }).message;
    return {
      message: sanitizeErrorText(msg, MAX_MESSAGE_LEN) || '未捕获 Promise 异常',
      source: 'unhandledrejection',
    };
  }
  return {
    message: sanitizeErrorText(reason, MAX_MESSAGE_LEN) || '未捕获 Promise 异常',
    source: 'unhandledrejection',
  };
}

/**
 * 写入一条运行时异常至客户端内存环形缓冲区。
 *
 * 【去重与淘汰规则】
 * - 同一 `kind + message` 在 2000ms 内重复触发会就地累加 `count` 并刷新 `lastSeenAt`；
 * - 超过 20 条上限时淘汰最旧条目，始终保留最新异常轨迹。
 */
export function recordRuntimeError(input: RuntimeErrorInput): RuntimeErrorEntry {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cleanMessage = sanitizeErrorText(input.message, MAX_MESSAGE_LEN) || '未知运行时异常';
  const cleanSource = sanitizeErrorText(input.source ?? 'runtime', MAX_SOURCE_LEN) || 'runtime';
  const dedupKey = `${input.kind}::${cleanMessage}`;

  for (let i = bufferItems.length - 1; i >= 0; i -= 1) {
    const existing = bufferItems[i];
    if (
      existing &&
      existing.dedupKey === dedupKey &&
      nowMs - existing.lastSeenAtMs <= DEDUP_WINDOW_MS
    ) {
      const updatedEntry: RuntimeErrorEntry = {
        ...existing.entry,
        count: existing.entry.count + 1,
        lastSeenAt: nowIso,
        source: existing.entry.source || cleanSource,
      };
      bufferItems.splice(i, 1);
      bufferItems.push({
        dedupKey,
        lastSeenAtMs: nowMs,
        entry: updatedEntry,
      });
      notifyListeners();
      return updatedEntry;
    }
  }

  const entry: RuntimeErrorEntry = {
    id: `err-${input.kind}-${hashKey(dedupKey)}-${nowMs.toString(36)}`,
    traceId: input.traceId ?? nextErrorTraceId(),
    kind: input.kind,
    message: cleanMessage,
    source: cleanSource,
    count: 1,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
  };

  bufferItems.push({
    dedupKey,
    lastSeenAtMs: nowMs,
    entry,
  });

  if (bufferItems.length > MAX_ENTRIES) {
    bufferItems.splice(0, bufferItems.length - MAX_ENTRIES);
  }

  notifyListeners();
  return entry;
}

/**
 * 读取最近 `limit` 条运行时异常（按最新捕获时间倒序排列）。
 */
export function getRecentRuntimeErrors(limit = 5): readonly RuntimeErrorEntry[] {
  const safeLimit = Math.max(1, Math.min(MAX_ENTRIES, Math.floor(limit)));
  if (bufferItems.length === 0) {
    return [];
  }
  return bufferItems
    .slice(-safeLimit)
    .map((item) => item.entry)
    .reverse();
}

/**
 * 清空前端内存异常缓冲区。
 */
export function clearRuntimeErrors(): void {
  if (bufferItems.length === 0) {
    return;
  }
  bufferItems.length = 0;
  notifyListeners();
}

/**
 * 订阅运行时异常缓冲区变化，返回取消订阅函数。
 */
export function subscribeRuntimeErrors(listener: ErrorBufferListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 生成可复制的纯文本诊断摘要（供 PerfHUD「复制摘要」按钮使用）。
 */
export function formatRuntimeErrorsSummary(limit = 5): string {
  const recent = getRecentRuntimeErrors(limit);
  if (recent.length === 0) {
    return '[KubeVision Runtime Diagnostics] 当前会话暂无运行时异常记录。';
  }
  const lines = [
    `[KubeVision Runtime Diagnostics] 最近 ${recent.length} 条异常记录（生成于 ${new Date().toISOString()}）`,
    ...recent.map(
      (item, index) =>
        `${index + 1}. [${item.kind}] traceId=${item.traceId} count=${item.count} last=${item.lastSeenAt} source=${item.source} :: ${item.message}`,
    ),
  ];
  return lines.join('\n');
}

/**
 * 在客户端安装全局未捕获异常与 Promise 拒绝监听器（幂等 + 引用计数卸载）。
 *
 * 兼容 React 18 StrictMode 双挂载：仅在首次激活时注册原生事件，
 * 并在所有持有方卸载后清理事件与调试桥。
 */
export function installGlobalRuntimeErrorListeners(): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  activeInstallCount += 1;

  if (!teardownListeners) {
    const onWindowError = (event: ErrorEvent): void => {
      const filePart = event.filename ? event.filename : 'window';
      const locPart =
        typeof event.lineno === 'number' && event.lineno > 0
          ? `${filePart}:${event.lineno}:${event.colno ?? 0}`
          : filePart;
      const msg =
        event.message ||
        (event.error instanceof Error ? event.error.message : String(event.error ?? '全局脚本异常'));
      recordRuntimeError({
        kind: 'error',
        message: msg,
        source: locPart,
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
      const parsed = extractRejectionMessage(event.reason);
      recordRuntimeError({
        kind: 'unhandledrejection',
        message: parsed.message,
        source: parsed.source,
      });
    };

    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.__KUBEVISION_ERROR_BUFFER__ = {
      record: recordRuntimeError,
      getRecent: getRecentRuntimeErrors,
      clear: clearRuntimeErrors,
      formatSummary: formatRuntimeErrorsSummary,
    };

    teardownListeners = () => {
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      delete window.__KUBEVISION_ERROR_BUFFER__;
      teardownListeners = null;
    };
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeInstallCount = Math.max(0, activeInstallCount - 1);
    if (activeInstallCount === 0 && teardownListeners) {
      teardownListeners();
    }
  };
}
