'use client';

/**
 * KubeVision AI — 端侧日志分类 Worker 集成 Hook（useEdgeLogClassifier）
 *
 * 【职责】把 logClassifier.worker 的生命周期、进度回传与请求-响应配对
 * 收敛到一个 Hook 里，让 UI 只关心「我的日志分类好了没」。
 *
 * 【Worker 实例化模式】Next.js（webpack 5）要求用
 * `new Worker(new URL('../workers/x.worker.ts', import.meta.url), { type: 'module' })`
 * 才能让打包器识别并单独产出 Worker chunk。写成字符串路径
 * （'../workers/x.worker.js'）在构建后路径会失效——这是 Next.js 里
 * 最容易踩的 Worker 坑之一。
 *
 * 【请求-响应配对】Worker 是全局单例、消息无内建 id，因此本 Hook
 * 采用「一次只允许一批在途请求」的模型：发 classify 后阻塞新请求，
 * 收到 result 即视为本批完成。审计场景本就是串行批处理，
 * 这比给每条日志编 id 更简单且不会错配。
 *
 * 【进度与运行时回显】Worker 每次 progress 消息都自带 runtime 与
 * runtimeLabel，Hook 直接透传给 HUD——HUD 无需再自己探测能力。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ClassifierRequest,
  ClassifierResponse,
  ClassifierRuntime,
  EdgeAuditResult,
  LogEntry,
} from '@/types/ai';

/* ========================================================================== */
/* 类型契约                                                                    */
/* ========================================================================== */

/** Hook 对外暴露的状态与操作 */
export interface UseEdgeLogClassifierResult {
  /** 模型加载进度 0~100 */
  readonly progress: number;
  /** 运行时后端（null 表示 Worker 尚未回传） */
  readonly runtime: ClassifierRuntime | null;
  /** 运行时可读标签（'WebGPU Hardware Accelerated' / 'WebAssembly SIMD'） */
  readonly runtimeLabel: string;
  /** 模型名（降级时为内置分类器标识） */
  readonly modelName: string;
  /** 是否已就绪（可接受分类请求） */
  readonly isReady: boolean;
  /** 是否降级到内置分类器 */
  readonly isFallback: boolean;
  /** 错误信息（null 表示无错） */
  readonly error: string | null;
  /** 提交一批日志进行分类（返回逐条结果；失败时返回 null） */
  readonly classify: (logs: readonly LogEntry[]) => Promise<readonly EdgeAuditResult[] | null>;
  /** 是否有一批分类在处理中 */
  readonly isClassifying: boolean;
}

/* ========================================================================== */
/* Hook 实现                                                                   */
/* ========================================================================== */

/**
 * useEdgeLogClassifier —— 端侧日志分类 Worker 的 React 绑定。
 *
 * @param autoInit 是否在挂载时立即预热模型（true 时提前开始下载/加载）
 */
export function useEdgeLogClassifier(autoInit = true): UseEdgeLogClassifierResult {
  const [progress, setProgress] = useState<number>(0);
  const [runtime, setRuntime] = useState<ClassifierRuntime | null>(null);
  const [runtimeLabel, setRuntimeLabel] = useState<string>('detecting…');
  const [modelName, setModelName] = useState<string>('initializing…');
  const [isReady, setIsReady] = useState<boolean>(false);
  const [isFallback, setIsFallback] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isClassifying, setIsClassifying] = useState<boolean>(false);

  const workerRef = useRef<Worker | null>(null);
  /** 在途请求的 resolver（null 表示当前无在途请求） */
  const pendingRef = useRef<((results: readonly EdgeAuditResult[] | null) => void) | null>(null);

  /* ---- Worker 生命周期 ---- */
  useEffect(() => {
    /* SSR 防御：Worker 仅存在于浏览器 */
    if (typeof window === 'undefined') return;

    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/logClassifier.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      setError('端侧推理 Worker 启动失败');
      setRuntimeLabel('unavailable');
      return;
    }

    workerRef.current = worker;

    /* ---- 消息处理：判别联合窄化 ---- */
    worker.addEventListener('message', (event: MessageEvent<ClassifierResponse>): void => {
      const message = event.data;

      switch (message.type) {
        case 'progress': {
          setProgress(message.progress);
          setRuntime(message.runtime);
          setRuntimeLabel(message.runtimeLabel);
          setModelName(message.modelName);
          break;
        }

        case 'ready': {
          setRuntime(message.runtime);
          setRuntimeLabel(message.runtimeLabel);
          setModelName(message.modelName);
          setIsFallback(message.fallback);
          setIsReady(true);
          setProgress(100);
          break;
        }

        case 'result': {
          const resolve = pendingRef.current;
          pendingRef.current = null;
          setIsClassifying(false);
          if (resolve !== null) resolve(message.results);
          break;
        }

        case 'error': {
          setError(message.message);
          const resolve = pendingRef.current;
          pendingRef.current = null;
          setIsClassifying(false);
          if (resolve !== null) resolve(null);
          break;
        }

        default:
          break;
      }
    });

    /* ---- Worker 运行期错误 ---- */
    worker.addEventListener('error', (event: ErrorEvent): void => {
      setError(event.message.length > 0 ? event.message : '端侧推理 Worker 异常');
      setIsClassifying(false);
      const resolve = pendingRef.current;
      pendingRef.current = null;
      if (resolve !== null) resolve(null);
    });

    /* ---- 预热 ---- */
    if (autoInit) {
      const initRequest: ClassifierRequest = { type: 'init' };
      worker.postMessage(initRequest);
    }

    /* ---- 卸载清理：终止 Worker 释放 GPU/内存资源 ---- */
    return (): void => {
      const resolve = pendingRef.current;
      pendingRef.current = null;
      if (resolve !== null) resolve(null);
      worker.terminate();
      workerRef.current = null;
    };
  }, [autoInit]);

  /**
   * classify —— 提交一批日志。
   *
   * 【并发保护】若已有在途请求，直接返回 null 并保留现有请求——
   * 审计场景是串行批处理，并发提交只会让结果错配。
   */
  const classify = useCallback(
    (logs: readonly LogEntry[]): Promise<readonly EdgeAuditResult[] | null> => {
      const worker = workerRef.current;
      if (worker === null || logs.length === 0) {
        return Promise.resolve(null);
      }
      if (pendingRef.current !== null) {
        /* 已有在途请求：拒绝新请求，避免结果错配 */
        return Promise.resolve(null);
      }

      setIsClassifying(true);
      return new Promise<readonly EdgeAuditResult[] | null>((resolve): void => {
        pendingRef.current = resolve;
        const request: ClassifierRequest = { type: 'classify', logs };
        worker.postMessage(request);
      });
    },
    [],
  );

  return {
    progress,
    runtime,
    runtimeLabel,
    modelName,
    isReady,
    isFallback,
    error,
    classify,
    isClassifying,
  };
}
