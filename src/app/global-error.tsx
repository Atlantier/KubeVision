'use client';

/**
 * KubeVision AI — App Router 根级全局异常兜底边界（R13 Main #1）
 *
 * 【职责】
 * 当根布局（layout.tsx）或跨布局根组件发生未捕获异常时，Next.js App Router
 * 使用本组件替代整棵 HTML 树，提供最终中文兜底界面与安全重启入口。
 */

import './globals.css';
import { useEffect, type ReactElement } from 'react';
import { AlertOctagon, RefreshCw, RotateCcw } from 'lucide-react';

import { recordRuntimeError } from '@/utils/runtimeErrorBuffer';

interface GlobalErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function GlobalErrorBoundary({ error, reset }: GlobalErrorProps): ReactElement {
  useEffect(() => {
    recordRuntimeError({
      kind: 'boundary',
      message: error.message || '根布局全局异常',
      source: error.digest ? `app/global-error:${error.digest}` : 'app/global-error',
    });
  }, [error]);

  const handleReload = (): void => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  return (
    <html lang="zh-CN" className="dark">
      <body className="min-h-screen bg-slate-950 font-sans text-slate-100 antialiased selection:bg-cyan-500/30 selection:text-slate-50">
        <main
          role="alert"
          className="flex min-h-screen w-full items-center justify-center px-4 py-10"
        >
          <section className="kv-blur-panel w-full max-w-lg rounded-xl border border-rose-500/50 bg-slate-900/90 p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-rose-500/40 bg-rose-500/20 text-rose-400">
                <AlertOctagon className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[11px] uppercase tracking-wider text-rose-400">
                  Global Error Boundary · 全局安全兜底
                </p>
                <h1 className="mt-1 text-lg font-semibold text-slate-50">
                  KubeVision 根框架检测到致命异常
                </h1>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">
                  为避免白屏或状态损坏，全局安全壳已激活。点击重试将重建应用根视图；若问题仍存在，请刷新页面。
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/95 p-3 font-mono text-xs text-slate-300">
              <div className="text-[11px] text-slate-400">错误详情</div>
              <div className="mt-1 break-words text-rose-300">
                {error.message || '未知根框架异常'}
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
                onClick={reset}
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/50 bg-cyan-500/20 px-4 py-2 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>尝试重建应用</span>
              </button>
              <button
                type="button"
                onClick={handleReload}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-slate-800/90 px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>重新加载页面</span>
              </button>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
