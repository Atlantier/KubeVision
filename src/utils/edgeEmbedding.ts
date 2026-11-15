'use client';

/**
 * KubeVision AI — 端侧查询句向量桥（R45 · 三路召回生产链路）
 *
 * 【解决什么】三路召回需要 384 维查询向量，而模型只在 Worker 里加载
 * （约束：transformers 不进主线程、不进服务端）。本模块用**独立**的
 * 端侧 Worker 实例做"文本 → 向量"，供对话发送前调用。
 *
 * 【为什么是独立 Worker】审计面板的 Worker 属于该面板生命周期；
 * 对话可能在审计面板未打开时发生。独立实例保证对话不依赖面板挂载，
 * 代价是模型可能被加载两份（仅在两个功能同时使用时），已在文档标注。
 *
 * 【降级契约】
 * - 模型未就绪 / 初始化中 / 300ms 超时 → 返回 null；
 * - 调用方（CopilotDrawer）随后不带 queryEmbedding 发请求 → 服务端自动两路召回；
 * - 绝不阻塞对话：超时只是"这一条消息不用三路"，不是错误。
 */

/** 默认超时（需求契约值） */
const EMBED_TIMEOUT_MS = 300;

/** Worker 单例与状态 */
let worker: Worker | null = null;
let workerReady = false;
let initializing = false;
let nextEmbedSeq = 0;

interface PendingEmbedRequest {
  readonly resolve: (vectors: number[][] | null) => void;
  readonly timer: number;
}

const pendingRequests = new Map<string, PendingEmbedRequest>();

/**
 * ensureWorker —— 惰性创建 Worker 并开始初始化（不等待模型下载）。
 *
 * @returns Worker 实例（SSR 下返回 null）
 */
function ensureWorker(): Worker | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  if (worker !== null) return worker;

  try {
    worker = new Worker(new URL('../workers/logClassifier.worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    /* 打包器不支持或浏览器禁用 Worker：返回 null，调用方走两路 */
    worker = null;
    return null;
  }

  worker.addEventListener('message', (event: MessageEvent<unknown>): void => {
    const data = event.data;
    if (typeof data !== 'object' || data === null) return;
    const message = data as Record<string, unknown>;
    if (message.type === 'ready' && message.fallback !== true) {
      workerReady = true;
      console.info(
        '[edge-embed] ready coldStart=' + String(message.coldStartMs ?? 'n/a') + 'ms',
      );
      return;
    }
    if (message.type === 'embed-result') {
      const vectors = Array.isArray(message.vectors)
        ? (message.vectors as number[][])
        : null;
      console.info('[edge-embed] warm inference=' + String(message.latencyMs ?? 'n/a') + 'ms');

      const requestId = typeof message.requestId === 'string' ? message.requestId : null;
      if (requestId !== null) {
        const entry = pendingRequests.get(requestId);
        if (entry !== undefined) {
          pendingRequests.delete(requestId);
          window.clearTimeout(entry.timer);
          entry.resolve(vectors);
        }
        return;
      }

      /* 兼容未携带 requestId 的旧式消息：按 FIFO 弹出首条 */
      const firstKey = pendingRequests.keys().next().value;
      if (firstKey !== undefined) {
        const entry = pendingRequests.get(firstKey);
        pendingRequests.delete(firstKey);
        if (entry !== undefined) {
          window.clearTimeout(entry.timer);
          entry.resolve(vectors);
        }
      }
    }
  });

  /* 初始化：触发模型加载；就绪前 embed 请求直接返回 null */
  if (!initializing) {
    initializing = true;
    worker.postMessage({ type: 'init' });
  }
  return worker;
}

/**
 * embedQueryText —— 把文本编码为 384 维查询向量（带 requestId 并发关联与超时清理）。
 *
 * @param text 查询文本
 * @param timeoutMs 超时（默认 300ms）
 * @returns 归一化向量；未就绪/超时/失败返回 null
 */
export async function embedQueryText(
  text: string,
  timeoutMs: number = EMBED_TIMEOUT_MS,
): Promise<number[] | null> {
  const activeWorker = ensureWorker();
  if (activeWorker === null || !workerReady) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const requestId = `emb-${Date.now()}-${++nextEmbedSeq}`;

  return await new Promise<number[] | null>((resolve): void => {
    let settled = false;
    const finish = (value: number[] | null): void => {
      if (settled) return;
      settled = true;
      const entry = pendingRequests.get(requestId);
      if (entry !== undefined) {
        pendingRequests.delete(requestId);
        window.clearTimeout(entry.timer);
      }
      resolve(value);
    };

    const timer = window.setTimeout((): void => finish(null), timeoutMs);
    pendingRequests.set(requestId, {
      timer,
      resolve: (vectors): void => {
        const first = vectors?.[0];
        finish(Array.isArray(first) && first.length === 384 ? first : null);
      },
    });

    try {
      activeWorker.postMessage({ type: 'embed', texts: [trimmed], requestId });
    } catch {
      finish(null);
    }
  });
}