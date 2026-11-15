/**
 * KubeVision AI — 异步 Chunk 加载容错、退避重试与安全刷新工具
 *
 * 【设计意图】
 * Next.js `next/dynamic` 在模块初次加载遇到瞬时网络抖动、HTTP/2 流重置
 * （如公网边缘节点 `net::ERR_CONNECTION_CLOSED`）或构建发布窗口期错位时，
 * 默认会把失败的 Promise 缓存在模块级 Loadable 包装器内，导致 React `reset()`
 * 无法重新发起网络请求，用户首屏必然撞上不可局部恢复的 ErrorBoundary。
 *
 * 【核心机制】
 * 1. `isChunkLoadError`：统一识别 Webpack `ChunkLoadError`、动态脚本加载失败与瞬时连接断开；
 * 2. `retryDynamicImport`：在 `next/dynamic` 缓存 Promise 之前拦截失败，利用 Webpack 14
 *    失败后自动重置 `installedChunks[id]` 的特性，按指数退避策略自动重拉缺失 chunk；
 *    同时支持可选 `startDelayMs` 错峰加载非关键重型面板，削峰首屏并发连接风暴；
 * 3. `triggerSafeChunkReload`：极端情况下若全量重试仍失败，借助 15 秒 `sessionStorage`
 *    冷却锁执行至多一次无死循环的整页刷新以切换最新资源清单。
 */

/** 默认自动重试次数（不含初次加载，合计最多 5 次尝试） */
const DEFAULT_CHUNK_RETRIES = 4;

/** 每次重试的基础退避时延（毫秒） */
const DEFAULT_BASE_DELAY_MS = 320;

/** 自动刷新冷却锁键名与最短间隔（防止离线时陷入无限刷新） */
const CHUNK_RELOAD_STORAGE_KEY = 'kv_chunk_auto_reload_ts';
const CHUNK_RELOAD_COOLDOWN_MS = 15_000;

export interface RetryDynamicImportOptions {
  /** 允许额外重试的次数（默认 4 次） */
  readonly retries?: number;
  /** 基础退避时长（毫秒，默认 320ms） */
  readonly baseDelayMs?: number;
  /** 首轮加载前的错峰延时（毫秒，默认 0ms），用于分散 T=0 并发 chunk 请求 */
  readonly startDelayMs?: number;
}

const CHUNK_ERROR_PATTERN =
  /ChunkLoadError|Loading chunk [\w-]+ failed|Loading CSS chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|ERR_CONNECTION_CLOSED|error loading dynamically imported module/i;

/**
 * 判断异常是否属于动态分片（Chunk）加载或传输层瞬时故障。
 *
 * @param error 捕获到的未知异常值
 * @returns 若为 chunk/动态脚本加载失败返回 `true`
 */
export function isChunkLoadError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error === 'object') {
    const maybe = error as { readonly name?: unknown; readonly message?: unknown; readonly type?: unknown };
    if (typeof maybe.name === 'string' && maybe.name === 'ChunkLoadError') {
      return true;
    }
    if (typeof maybe.message === 'string' && CHUNK_ERROR_PATTERN.test(maybe.message)) {
      return true;
    }
  }
  if (typeof error === 'string') {
    return CHUNK_ERROR_PATTERN.test(error);
  }
  return false;
}

function waitMs(durationMs: number): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();
  return new Promise((resolve): void => {
    setTimeout(resolve, durationMs);
  });
}

/**
 * 包装动态 `import()` 加载器，提供首屏错峰延时与 Chunk 失败自动退避重试。
 *
 * 【工作原理】
 * - 只有命中 `isChunkLoadError(err)` 时才重试，业务语法/初始化异常立即透传，避免掩盖真 Bug；
 * - 第 k 次重试等待 `min(3000, baseDelayMs * 2^(k-1)) + random(0..120)` ms，打散重连尖峰。
 *
 * @param loader 返回动态模块 Promise 的工厂函数（如 `() => import('...')`）
 * @param options 重试次数、基础时延与初始错峰配置
 * @returns 兼容 `next/dynamic` 的高可靠加载函数
 */
export function retryDynamicImport<T>(
  loader: () => Promise<T>,
  options: RetryDynamicImportOptions = {},
): () => Promise<T> {
  const retries = Math.max(0, options.retries ?? DEFAULT_CHUNK_RETRIES);
  const baseDelayMs = Math.max(50, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const startDelayMs = Math.max(0, options.startDelayMs ?? 0);

  return async (): Promise<T> => {
    if (startDelayMs > 0) {
      await waitMs(startDelayMs);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await loader();
      } catch (error: unknown) {
        lastError = error;
        const canRetry = attempt < retries && isChunkLoadError(error);
        if (!canRetry) {
          throw error;
        }
        const backoff = Math.min(3_000, baseDelayMs * Math.pow(2, attempt));
        const jitter = Math.floor(Math.random() * 120);
        await waitMs(backoff + jitter);
      }
    }

    throw lastError;
  };
}

/**
 * 在受 `sessionStorage` 冷却锁保护的前提下触发一次整页重载，用于恢复不可逆 Chunk 失效。
 *
 * @returns 若本次触发了刷新（未处于冷却期内）返回 `true`，否则返回 `false`
 */
export function triggerSafeChunkReload(): boolean {
  if (typeof window === 'undefined') return false;
  const now = Date.now();
  try {
    const raw = window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    const lastTs = raw !== null ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(lastTs) && now - lastTs < CHUNK_RELOAD_COOLDOWN_MS) {
      return false;
    }
    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(now));
  } catch {
    /* 无痕模式或禁用存储时不阻断手动恢复流程 */
  }
  window.location.reload();
  return true;
}
