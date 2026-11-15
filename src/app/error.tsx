'use client';

/**
 * KubeVision AI — App Router 路由级异常边界（R13 Main #1）
 *
 * 【职责】
 * 捕获主页面及其子组件树未就近处理的渲染异常，避免整屏白屏：
 * 1. 通过 useEffect 将异常脱敏记入前端内存环形缓冲区（kind='boundary'）；
 * 2. 展示清晰的中文故障摘要、digest 标识与一键局部恢复（reset）或整页重载按钮；
 * 3. 保留完整键盘焦点管理与深空赛博高对比度视觉语义。
 */

import { useEffect, type ReactElement } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';

import { isChunkLoadError, triggerSafeChunkReload } from '@/utils/dynamicWithRetry';
import { recordRuntimeError } from '@/utils/runtimeErrorBuffer';

interface RouteErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function RouteErrorBoundary({ error, reset }: RouteErrorProps): ReactElement {
  const chunkError = isChunkLoadError(error);

  useEffect(() => {
    recordRuntimeError({
      kind: 'boundary',
      message: error.message || '控制台视图渲染异常',
      source: error.digest ? `app/error:${error.digest}` : 'app/error',
    });

    if (chunkError) {
      triggerSafeChunkReload();
    }
  }, [error, chunkError]);

  const handleReload = (): void => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  const handleRecover = (): void => {
    if (chunkError) {
      handleReload();
      return;
    }
    reset();
  };

  return (
    <main
      role="alert"
      className="flex min-h-screen w-full items-center justify-center bg-slate-950 px-4 py-10 text-slate-100"
    >
      <section className="kv-blur-panel w-full max-w-lg rounded-xl border border-rose-500/40 bg-slate-900/90 p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-rose-500/40 bg-rose-500/20 text-rose-400">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[11px] uppercase tracking-wider text-rose-400">
              Runtime Error Boundary · 视图保护已接管
            </p>
            <h1 className="mt-1 text-lg font-semibold text-slate-50">
              控制台界面遇到意外渲染异常
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">
              该异常已被局部边界拦截，不会扩散破坏持久化数据。你可以尝试局部重新挂载当前视图，或刷新浏览器页面以恢复完整三维拓扑。
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/90 p-3 font-mono text-xs text-slate-300">
          <div className="text-[11px] text-slate-400">异常摘要</div>
          <div className="mt-1 break-words text-rose-300">
            {error.message || '未知渲染错误'}
          </div>
          {error.digest ? (
            <div className="mt-1.5 text-[11px] text-slate-400">
              Digest: <span className="text-cyan-300">{error.digest}</span>
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={handleRecover}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/50 bg-cyan-500/20 px-4 py-2 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{chunkError ? '重新加载分片' : '重试恢复视图'}</span>
          </button>
          <button
            type="button"
            onClick={handleReload}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-slate-800/90 px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>刷新整页</span>
          </button>
        </div>
      </section>
    </main>
  );
}
