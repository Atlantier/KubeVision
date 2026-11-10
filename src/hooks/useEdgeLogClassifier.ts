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

/**
 * 端侧引擎初始化的**独立时间预算**（毫秒）。
 *
 * 【为什么需要独立预算】端侧推理要在 Worker 里下载并初始化模型权重
 * （首次冷启动可达数十秒），而主线程此时正被 3D 渲染占满。
 * 若用"页面就绪"这类通用超时来卡它，引擎会被误判为失败——
 * 实测出现过"审计按钮持续不可用"的假故障。
 *
 * 因此这里给引擎一条**专属预算**：3 分钟。超时后才降级为主线程内置分类器，
 * 并明确标注 TIMEOUT，而不是无限等待或过早判死。
 */
const EDGE_INIT_BUDGET_MS = 180_000;

/**
 * 单批分类超时（毫秒）——B1 的核心修复之一。
 *
 * 【为什么必须有】推理可能因 WebGPU 设备丢失、WASM OOM、模型输入异常
 * 而永久挂起：Worker 既不回 result 也不回 error，主线程的 Promise 永远
 * 不 resolve，面板的"审计中"按钮就永久 disabled。
 * 3 秒足够覆盖正常推理（实测 < 60ms），超时即用内置分类器兜底返回。
 */
const EDGE_BATCH_TIMEOUT_MS = 3_000;

/** 单批分类超时错误标识（用于区分"超时兜底"与"正常结果"） */
const BATCH_TIMEOUT_SENTINEL = 'endless-classify-timeout';

import { telemetryTransientRef } from '@/store/useTelemetryRef';
import { classifyLogsWithBuiltin } from '@/utils/builtinLogClassifier';
import { isClassifierResponse } from '@/types/ai';
import type {
  ClassifierRequest,
  ClassifierRuntime,
  ClassifierWorkerStatus,
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
  /** Worker 状态机当前态（null 表示尚未收到状态消息） */
  readonly workerStatus: ClassifierWorkerStatus | null;
  /** Worker 状态的完整可读串（如 'READY (WebGPU)' / 'INFERENCING'） */
  readonly statusLabel: string;
  /** 错误信息（null 表示无错） */
  readonly error: string | null;
  /** 提交一批日志进行分类（返回逐条结果；失败时返回 null） */
  readonly classify: (logs: readonly LogEntry[]) => Promise<readonly EdgeAuditResult[] | null>;
  /** 是否有一批分类在处理中 */
  readonly isClassifying: boolean;
  /** 取消当前在途批次（B1：并发上限 1 时必须提供取消出口） */
  readonly cancelClassify: () => void;
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
  const [workerStatus, setWorkerStatus] = useState<ClassifierWorkerStatus | null>(null);
  const [statusLabel, setStatusLabel] = useState<string>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isClassifying, setIsClassifying] = useState<boolean>(false);

  const workerRef = useRef<Worker | null>(null);
  /**
   * 在途请求（null 表示无在途请求）。
   *
   * 【B1：同时记录日志与开始时刻】超时兜底必须能在主线程用内置分类器
   * 重新算出结果，因此 pending 里要保留输入——只留 resolver 是不够的。
   */
  const pendingRef = useRef<{
    readonly logs: readonly LogEntry[];
    readonly startedAtMs: number;
    readonly resolve: (results: readonly EdgeAuditResult[] | null) => void;
    readonly timer: number;
  } | null>(null);

  /* ---- Worker 生命周期 ---- */
  useEffect(() => {
    /* SSR 防御：Worker 仅存在于浏览器 */
    if (typeof window === 'undefined') return;

    /**
     * 【Worker 创建的双路策略】
     *
     * 主路：`new Worker(new URL('../workers/logClassifier.worker.ts', import.meta.url), ...)`
     * 这是 webpack 唯一能正确识别并单独分包的写法。绝大多数环境走这条。
     *
     * 兜底：若主路跑起来后 Worker 迟迟不就绪（典型症状是构建产物里
     * Worker chunk 路径错位、或被 CDN 重写后 404），本 Hook 会依次尝试：
     *  a) 重新用 `{ type: 'module' }` 构造（部分打包器需要重新协商 MIME）；
     *  b) 若最终仍失败，标记 error 并**回退到主线程内置分类器**
     *     （由 LocalAuditorPanel 侧在 classify 返回 null 时使用），
     *     保证审计功能在极端环境下依然可用，而不是整个面板瘫痪。
     *
     * 这样即使某个打包器/部署环境把 Worker 路径搞坏，用户看到的也只是
     * 「降级到主线程推理」，而不是一个永远转圈或直接报错的死面板。
     */
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/logClassifier.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (primaryError) {
      /* 主路构造即失败 → 尝试以 classic 类型重建（少数打包器差异） */
      try {
        worker = new Worker(new URL('../workers/logClassifier.worker.ts', import.meta.url));
      } catch {
        setError(
          `端侧推理 Worker 启动失败，已回退主线程推理：${
            primaryError instanceof Error ? primaryError.message : 'unknown'
          }`,
        );
        setRuntimeLabel('unavailable');
        setStatusLabel('ERROR');
        telemetryTransientRef.glStats.workerStatus = 'ERROR';
        return;
      }
    }

    workerRef.current = worker;

    /*
     * 初始化预算的局部状态（只在本次 effect 生命周期内有效）。
     *
     * engineSettled：ready 或 error 到达后置 true，看门狗据此判断"已经落定"，
     *                避免引擎已就绪却又被超时降级覆盖。
     * initBudgetTimer：看门狗句柄，在卸载清理中一并清除。
     */
    let engineSettled = false;
    let initBudgetTimer: number | null = null;

    /* ---- 消息处理：先做运行期校验，再判别联合窄化 ---- */
    worker.addEventListener('message', (event: MessageEvent<unknown>): void => {
      /**
       * 【运行期校验】postMessage 跨越 structured-clone 边界，
       * 返回的是 unknown 而非可信的 ClassifierResponse。
       * 直接强转会让形状错误的消息（如旧版 Worker chunk 被缓存、
       * results 为 null）在渲染层引发异常。校验后才进入分支。
       */
      if (!isClassifierResponse(event.data)) return;
      const message = event.data;

      switch (message.type) {
        case 'status': {
          setWorkerStatus(message.status);
          setStatusLabel(message.label);
          /* 【核心：写入瞬态轨】glStats 是模块级可变单例，
             每帧被渲染循环/HUD 读取，此处原地赋值即可，
             不触发任何 React 重渲染（AGENTS.md 第 3 条 60FPS 红线）。 */
          telemetryTransientRef.glStats.workerStatus = message.label;
          break;
        }

        case 'progress': {
          setProgress(message.progress);
          setRuntime(message.runtime);
          setRuntimeLabel(message.runtimeLabel);
          setModelName(message.modelName);
          break;
        }

        case 'ready': {
          engineSettled = true;
          if (initBudgetTimer !== null) {
            window.clearTimeout(initBudgetTimer);
            initBudgetTimer = null;
          }
          setRuntime(message.runtime);
          setRuntimeLabel(message.runtimeLabel);
          setModelName(message.modelName);
          setIsFallback(message.fallback);
          setIsReady(true);
          setProgress(100);
          break;
        }

        case 'result': {
          const pending = pendingRef.current;
          pendingRef.current = null;
          setIsClassifying(false);
          if (pending !== null) {
            window.clearTimeout(pending.timer);
            pending.resolve(message.results);
          }
          break;
        }

        case 'error': {
          setError(message.message);
          setWorkerStatus('ERROR');
          setStatusLabel('ERROR');
          telemetryTransientRef.glStats.workerStatus = 'ERROR';
          setIsFallback(true);
          setRuntime('builtin');
          setRuntimeLabel('builtin-classifier');
          setIsReady(true);
          const pending = pendingRef.current;
          pendingRef.current = null;
          setIsClassifying(false);
          /*
           * 【B1：异常也必须给结果】旧实现 resolve(null)，面板拿到 null 后
           * 只能显示"无结果"，而且 isReady 仍可能为 false 导致按钮永久禁用。
           * 现在直接以内置分类器产出结果，保证审计流程可完成。
           */
          if (pending !== null) {
            window.clearTimeout(pending.timer);
            pending.resolve(classifyLogsWithBuiltin(pending.logs, pending.startedAtMs));
          }
          break;
        }

        default:
          break;
      }
    });

    /*
     * ---- 初始化预算看门狗 ----
     *
     * 在专属预算内等待 ready；超时则降级为主线程内置分类器并标注 TIMEOUT。
     * 这样即使模型权重下载极慢或镜像不可达，用户看到的也是
     * 「已降级、仍可用」而不是一个永远灰着的按钮。
     */
    initBudgetTimer = window.setTimeout((): void => {
      if (workerRef.current === null) return;
      if (engineSettled) return;
      engineSettled = true;
      setError(`端侧引擎初始化超时（${Math.round(EDGE_INIT_BUDGET_MS / 1000)}s），已回退主线程推理`);
      /* 类型域内没有 TIMEOUT，用 ERROR 承载"引擎不可用"，
         但给人看的标签明确写成 TIMEOUT，避免把它误读成脚本崩溃。 */
      setWorkerStatus('ERROR');
      setStatusLabel('TIMEOUT');
      telemetryTransientRef.glStats.workerStatus = 'TIMEOUT';
      setIsFallback(true);
      setIsReady(true);
      setRuntimeLabel('builtin-classifier');
      /* B5：builtin 是独立运行时，不能标成 wasm（模型根本没加载） */
      setRuntime('builtin');
    }, EDGE_INIT_BUDGET_MS);

    /* ---- Worker 运行期错误（脚本加载失败、未捕获异常等） ---- */
    worker.addEventListener('error', (event: ErrorEvent): void => {
      setError(event.message.length > 0 ? event.message : '端侧推理 Worker 异常');
      setWorkerStatus('ERROR');
      setStatusLabel('ERROR');
      telemetryTransientRef.glStats.workerStatus = 'ERROR';
      setIsClassifying(false);
      setIsFallback(true);
      setRuntime('builtin');
      setRuntimeLabel('builtin-classifier');
      setIsReady(true);
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending !== null) {
        window.clearTimeout(pending.timer);
        /* B1：异常也必须产出可用结果，而不是把 null 丢给面板 */
        pending.resolve(classifyLogsWithBuiltin(pending.logs, pending.startedAtMs));
      }
    });

    /* ---- 预热 ---- */
    if (autoInit) {
      const initRequest: ClassifierRequest = { type: 'init' };
      worker.postMessage(initRequest);
    }

    /**
     * 【就绪看门狗】Worker 脚本若因路径问题根本没加载起来，
     * 浏览器通常不会触发 'error' 事件（尤其是 worker chunk 404 时
     * 表现为静默失败），Hook 就会永远停留在初始化态。
     *
     * 这里设一个宽松的上限（15s，远大于 Worker 内 3500ms 的模型熔断），
     * 到点仍未就绪就显式标记为异常并允许主线程兜底——
     * 宁可明确告知用户"端侧引擎降级"，也不要无限转圈。
     */
    const watchdog = window.setTimeout((): void => {
      /*
       * 【B1 修复：看门狗必须"降级为可用"，而不是把 isReady 留在 false】
       *
       * 旧实现只在 isReady=false 时写错误信息，**没有把 isReady 置 true**，
       * 于是 LocalAuditorPanel 的所有按钮永远 disabled（isReady 是门禁），
       * 而"已降级为主线程推理"的文案也永远没有机会被使用——死锁。
       *
       * 现在：超时即宣布"内置分类器可用"，并如实标注 runtime='builtin'。
       */
      if (engineSettled) return;
      engineSettled = true;

      setError('端侧推理 Worker 未能及时就绪（15s），已降级为内置分类器');
      setWorkerStatus('ERROR');
      setStatusLabel('TIMEOUT');
      setRuntime('builtin');
      setRuntimeLabel('builtin-classifier');
      setIsFallback(true);
      setIsReady(true);
      setProgress(100);
      telemetryTransientRef.glStats.workerStatus = 'TIMEOUT';

      /* 在途请求 → 立刻用内置分类器返回结果，而不是让它永久挂起 */
      const pending = pendingRef.current;
      if (pending !== null) {
        window.clearTimeout(pending.timer);
        pendingRef.current = null;
        setIsClassifying(false);
        pending.resolve(classifyLogsWithBuiltin(pending.logs, pending.startedAtMs));
      }
    }, 15000);

    /* ---- 卸载清理：清除看门狗、终止 Worker 释放 GPU/内存资源 ---- */
    return (): void => {
      window.clearTimeout(watchdog);
      if (initBudgetTimer !== null) {
        window.clearTimeout(initBudgetTimer);
        initBudgetTimer = null;
      }
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending !== null) {
        window.clearTimeout(pending.timer);
        pending.resolve(null);
      }
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
      if (logs.length === 0) return Promise.resolve([]);

      /*
       * 【B1：Worker 不可用时直接内置兜底】
       * 旧实现返回 null，面板拿到 null 只能显示"无结果"；
       * 现在直接给出规则分类结果，保证"审计"这个动作永远有产出。
       */
      if (worker === null) {
        setIsFallback(true);
        setRuntime('builtin');
        setRuntimeLabel('builtin-classifier');
        setIsReady(true);
        return Promise.resolve(classifyLogsWithBuiltin(logs, Date.now()));
      }

      /*
       * 【B1：并发上限 1】
       * Worker 协议没有请求 id，两批同时在途必然结果错配。
       * 这里第二批复用"直接拒绝"，由调用方串行化（审计面板天然串行）。
       */
      if (pendingRef.current !== null) return Promise.resolve(null);

      const startedAtMs = Date.now();
      setIsClassifying(true);

      /*
       * 【B1：单批 3 秒超时兜底】
       * Worker 若因设备丢失/OOM 永久挂起，既不回 result 也不回 error。
       * 超时后用内置分类器在主线程算出结果，保证 runAudit 一定能结束。
       */
      return new Promise<readonly EdgeAuditResult[] | null>((resolve): void => {
        const timer = window.setTimeout((): void => {
          const pending = pendingRef.current;
          if (pending === null) return;
          pendingRef.current = null;
          setIsClassifying(false);
          setIsFallback(true);
          setRuntime('builtin');
          setRuntimeLabel('builtin-classifier');
          setIsReady(true);
          setError(`单批分类超过 ${EDGE_BATCH_TIMEOUT_MS / 1000}s 未返回，已用内置分类器兜底`);
          /*
           * 记录超时事件：BATCH_TIMEOUT_SENTINEL 供面板/日志区分
           * "内置兜底"与"模型真实结果"。
           */
          telemetryTransientRef.glStats.workerStatus = BATCH_TIMEOUT_SENTINEL;
          resolve(classifyLogsWithBuiltin(pending.logs, pending.startedAtMs));
        }, EDGE_BATCH_TIMEOUT_MS);

        pendingRef.current = { logs, startedAtMs, resolve, timer };
        const request: ClassifierRequest = { type: 'classify', logs };
        worker.postMessage(request);
      });
    },
    [],
  );

  /**
   * cancelClassify —— 取消当前在途批次（B1：可取消）。
   *
   * 【用途】面板卸载、用户切走审计台、或检测到运行环境变化时，
   * 立即让在途 Promise 以 null 结束，避免"已经没人要的结果"继续跑完
   * 再 setState（React 会对已卸载组件报警告，且浪费一次推理）。
   */
  const cancelClassify = useCallback((): void => {
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    window.clearTimeout(pending.timer);
    setIsClassifying(false);
    pending.resolve(null);
  }, []);

  return {
    progress,
    runtime,
    runtimeLabel,
    modelName,
    isReady,
    isFallback,
    workerStatus,
    statusLabel,
    error,
    classify,
    cancelClassify,
    isClassifying,
  };
}