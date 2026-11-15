'use client';

/**
 * KubeVision AI — 局部动态槽位错误边界（DynamicSlotBoundary）
 *
 * 【设计意图】
 * 防止单个懒加载重型模块（如 3D 视口、WebGL 后处理链或 AI 副驾驶抽屉）在网络
 * 抖动或渲染异常时击穿至路由级 `src/app/error.tsx` 导致整页崩溃。
 * - `silent=true` 模式（如可选后处理 pass）：静默降级返回 `null`，保障核心 3D 拓扑可用；
 * - 普通面板模式：捕获 `ChunkLoadError` 后先尝试一次受冷却保护的整页同步恢复；
 *   若仍失败，则渲染局部赛博恢复卡，保证顶栏、遥测流与另一侧面板持续可用。
 */

import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

import { isChunkLoadError, triggerSafeChunkReload } from '@/utils/dynamicWithRetry';
import { recordRuntimeError } from '@/utils/runtimeErrorBuffer';

interface DynamicSlotBoundaryProps {
  /** 面板可读名称，用于诊断日志与兜底提示 */
  readonly slotName: string;
  /** 静默降级：异常时直接返回 null（适用于纯装饰/可选后处理子模块） */
  readonly silent?: boolean;
  readonly children: ReactNode;
}

interface DynamicSlotBoundaryState {
  readonly error: Error | null;
  readonly retryEpoch: number;
}

export default class DynamicSlotBoundary extends Component<
  DynamicSlotBoundaryProps,
  DynamicSlotBoundaryState
> {
  public constructor(props: DynamicSlotBoundaryProps) {
    super(props);
    this.state = {
      error: null,
      retryEpoch: 0,
    };
  }

  public static getDerivedStateFromError(error: Error): Partial<DynamicSlotBoundaryState> {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    const firstFrame = info.componentStack?.split('\n')[1]?.trim() ?? this.props.slotName;
    recordRuntimeError({
      kind: 'boundary',
      message: error.message || `${this.props.slotName} 模块加载异常`,
      source: `DynamicSlotBoundary(${firstFrame})`,
    });

    if (!this.props.silent && isChunkLoadError(error)) {
      triggerSafeChunkReload();
    }
  }

  private readonly handleRecover = (): void => {
    const { error } = this.state;
    if (error !== null && isChunkLoadError(error)) {
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
      return;
    }
    this.setState((prev): DynamicSlotBoundaryState => ({
      error: null,
      retryEpoch: prev.retryEpoch + 1,
    }));
  };

  public render(): ReactNode {
    const { error, retryEpoch } = this.state;
    if (error !== null) {
      if (this.props.silent) {
        return null;
      }

      const chunkError = isChunkLoadError(error);
      return (
        <div
          role="alert"
          className="flex h-full min-h-[14rem] w-full items-center justify-center bg-slate-950/90 p-5 text-slate-100"
        >
          <div className="kv-blur-panel w-full max-w-md rounded-xl border border-rose-500/40 bg-slate-900/90 p-5 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-rose-500/40 bg-rose-500/20 text-rose-400">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[10px] uppercase tracking-wider text-rose-400">
                  Slot Guard · {this.props.slotName}
                </p>
                <h2 className="mt-1 text-sm font-semibold text-slate-50">
                  {chunkError ? '分片资源加载超时，请重试加载' : '模块渲染异常已局部隔离'}
                </h2>
                <p className="mt-1.5 break-words font-mono text-[11px] text-rose-300">
                  {error.message || '未知加载异常'}
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={this.handleRecover}
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/50 bg-cyan-500/20 px-3.5 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{chunkError ? '刷新并重新加载' : '重试挂载模块'}</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return <Fragment key={retryEpoch}>{this.props.children}</Fragment>;
  }
}
