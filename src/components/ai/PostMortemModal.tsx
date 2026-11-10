'use client';

/**
 * KubeVision AI — SRE 故障复盘报告预览与导出弹窗（PostMortemModal）
 *
 * 【职责】把 `buildPostMortemMarkdown` 生成的 Markdown 以三种方式交付给用户：
 * 1. **预览**：用项目自带的 MarkdownLite 渲染，看到的就是最终排版；
 * 2. **源码**：等宽 `<pre>` 展示原始 Markdown，便于粘贴到工单 / Wiki；
 * 3. **导出**：Blob + 临时 `<a download>` 触发浏览器下载 .md 文件。
 *
 * 【为何必须 createPortal 到 document.body】
 * 本项目踩过这个坑：`position: fixed` 在一个带 `transform` / `filter` /
 * `backdrop-filter` 的祖先容器内会退化为相对该祖先定位（CSS 规范的
 * containing block 规则），于是弹窗被裁进右侧 Copilot 抽屉里。
 * portal 到 body 之后，定位链路上不再有这类祖先，`inset-0` 才是真正的全屏。
 *
 * 【为何要「复制 Markdown」这条路径】实际工作流里，复盘报告往往不是下载成
 * 文件，而是直接粘进 Confluence / 飞书 / Jira。多给一个复制按钮，
 * 比让用户先下载再打开再全选要顺手得多。
 *
 * 【SSR 安全】`document` 只在 open === true 的渲染分支里被访问，
 * 而该分支在服务端渲染时不会走到（父级按需 dynamic 引入且初始 open=false）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEscapeLayer } from '@/hooks/useEscapeStack';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, FileText, X } from 'lucide-react';

import MarkdownLite from '@/components/ai/MarkdownLite';
import { buildPostMortemFilename } from '@/utils/postMortemReport';
import { cn } from '@/utils/cn';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 复制成功文案的保留时长（毫秒）——契约要求 2 秒 */
const COPY_FEEDBACK_MS = 2000;

/** 下载文件的 MIME 类型（显式带 charset，避免 Windows 记事本打开时中文乱码） */
const MARKDOWN_MIME = 'text/markdown;charset=utf-8';

/* ========================================================================== */
/* 类型契约                                                                    */
/* ========================================================================== */

/** 视图模式：渲染预览 / 原始源码 */
type ViewMode = 'preview' | 'source';

/** PostMortemModal 的 Props */
export interface PostMortemModalProps {
  /** 是否打开（false 直接返回 null，卸载整个遮罩） */
  readonly open: boolean;
  /** 关闭回调（关闭按钮、遮罩点击、Escape 三处共用） */
  readonly onClose: () => void;
  /** 已生成的 Markdown 全文 */
  readonly markdown: string;
  /**
   * 下载时使用的文件名（含 .md 后缀），**可选**。
   *
   * 【为何可选】调用方（CopilotDrawer）在生成报告的同一次点击里用
   * `buildPostMortemFilename(nowMs)` 快照了文件名，并把它一并传下来——
   * 这样下载名与报告正文里的「报告编号 / 生成时间」严格同源，
   * 不会因为用户在弹窗里停留几分钟而漂移。
   *
   * 若调用方不传（例如单独复用本弹窗做演示），组件回落到下载时刻现算的文件名，
   * 行为依旧正确。因此它是**可选增强**，不破坏本组件的最小三参契约。
   */
  readonly filename?: string;
}

/** 标签页定义（顺序即渲染顺序） */
const VIEW_TABS: ReadonlyArray<{ readonly key: ViewMode; readonly label: string }> = [
  { key: 'preview', label: '预览' },
  { key: 'source', label: '源码' },
];

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * PostMortemModal —— 复盘报告预览与导出弹窗。
 *
 * 【状态机】
 * - mode       → 当前标签页（preview / source），关闭时复位为 preview；
 * - copied     → 复制成功反馈（2 秒后自动回落，定时器在卸载与重入时清理）；
 * - copyError  → 复制失败提示（clipboard API 在非 HTTPS 下不可用时的降级文案）。
 *
 * 【为什么要「关闭时复位」而不是「关闭时卸载」】父级可能选择保持挂载
 * （避免每次打开都重建 DOM），若不复位，下次打开会停在上次的源码页且残留
 * 「已复制」文案，看起来像是上一次的残留状态。
 *
 * @param props 见 PostMortemModalProps
 * @returns 打开时返回 portal 到 body 的弹窗元素，关闭时返回 null
 */
export default function PostMortemModal({
  open,
  onClose,
  markdown,
  filename,
}: PostMortemModalProps): React.ReactElement | null {
  const [mode, setMode] = useState<ViewMode>('preview');
  const [copied, setCopied] = useState<boolean>(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  /** 复制反馈定时器（卸载 / 重入时必须清理，避免对已卸载组件 setState） */
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * clearFeedbackTimer —— 清理反馈定时器。
   *
   * 抽成独立函数而不是内联，是因为卸载 effect 与「连续点击复制」两处都要用，
   * 重复写一遍 clearTimeout + 置 null 容易出现漏置 null（下次判断失效）。
   */
  const clearFeedbackTimer = useCallback((): void => {
    if (feedbackTimerRef.current !== null) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
  }, []);

  /* 卸载清理：杜绝定时器泄漏与 setState on unmounted 警告 */
  useEffect((): (() => void) => {
    return (): void => {
      clearFeedbackTimer();
    };
  }, [clearFeedbackTimer]);

  /* 关闭时复位视图状态，下次打开回到预览页、无残留提示 */
  useEffect((): void => {
    if (!open) {
      setMode('preview');
      setCopied(false);
      setCopyError(null);
      clearFeedbackTimer();
    }
  }, [open, clearFeedbackTimer]);

  /**
   * 【C1】Esc 交给页面级分级退出栈（优先级 70：低于 RAG / 混沌 / 命令面板）。
   * 关闭态不注册，注册表随 open 变化自动增删。
   */
  useEscapeLayer(open ? { id: 'post-mortem', priority: 70, label: '复盘报告', onEscape: onClose } : null);

  /**
   * handleDownload —— 用 Blob + 临时 `<a download>` 触发 .md 下载。
   *
   * 【核心流转】Markdown 字符串 → Blob（带 UTF-8 charset）→ createObjectURL →
   * 创建游离 anchor 并模拟点击 → 立即移除 anchor → 延后一拍 revokeObjectURL。
   *
   * 【为何要 revoke】Blob URL 会一直持有该 Blob 的内存直到页面卸载；
   * 反复导出而不释放会造成内存泄漏。但**不能同步 revoke**——
   * 部分浏览器（尤其 Firefox）在 click() 返回后仍异步读取 URL，
   * 立刻释放会导致下载到 0 字节文件。用 requestAnimationFrame 推后一拍，
   * 此时下载已由浏览器接管，释放是安全的。
   *
   * 【文件名来源优先级】调用方快照的 filename > 下载时刻现算。
   * 前者与报告正文中的报告编号同源，后者保证复用时不至于没有名字。
   */
  const handleDownload = useCallback((): void => {
    const downloadName =
      filename !== undefined && filename !== '' ? filename : buildPostMortemFilename(Date.now());
    const blob = new Blob([markdown], { type: MARKDOWN_MIME });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.requestAnimationFrame((): void => {
      URL.revokeObjectURL(url);
    });
  }, [filename, markdown]);

  /**
   * handleCopy —— 把 Markdown 源码写入剪贴板。
   *
   * 【降级处理】`navigator.clipboard` 只在安全上下文（HTTPS / localhost）可用。
   * 内网 HTTP 部署下它是 undefined，此时**不能静默失败**——
   * 用户会以为按钮坏了。因此明确提示「请切到源码页手动全选复制」，
   * 把不可用的能力如实告知，并给出一条可行的替代路径。
   *
   * 【定时器语义】成功后才启动 2 秒倒计时；若用户在 2 秒内再次点击，
   * 先清旧定时器再置新，保证文案不会提前回落。
   */
  const handleCopy = useCallback((): void => {
    setCopyError(null);

    const onSuccess = (): void => {
      setCopied(true);
      clearFeedbackTimer();
      feedbackTimerRef.current = setTimeout((): void => {
        setCopied(false);
        feedbackTimerRef.current = null;
      }, COPY_FEEDBACK_MS);
    };

    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      setCopied(false);
      setCopyError(
        '当前环境不支持剪贴板 API（需 HTTPS 或 localhost），请切到「源码」页手动选择复制',
      );
      return;
    }

    navigator.clipboard.writeText(markdown).then(onSuccess, (): void => {
      setCopied(false);
      setCopyError('复制被浏览器拒绝（权限或非安全上下文），请切到「源码」页手动选择复制');
    });
  }, [markdown, clearFeedbackTimer]);

  /* ---- 契约：关闭态直接返回 null（不残留任何遮罩节点） ---- */
  if (!open) return null;

  const charCount = markdown.length;
  const lineCount = markdown === '' ? 0 : markdown.split('\n').length;
  const isPreview = mode === 'preview';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-md sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="SRE 故障复盘报告"
    >
      {/* ============ 遮罩点击关闭（独立按钮，位于面板之下，不与面板交互冲突） ============ */}
      <button
        type="button"
        aria-label="点击遮罩关闭复盘报告弹窗"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />

      {/* ============ 主面板：深空毛玻璃 ============ */}
      <div className="relative flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-cyan-400/30 bg-slate-950/95 shadow-[0_24px_80px_rgba(2,6,23,0.9)] backdrop-blur-2xl">
        {/* ---- 顶部主题流光细线 ---- */}
        <div
          className="h-px w-full shrink-0 bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent"
          aria-hidden
        />

        {/* ==================== 标题栏：标题 + 字数统计 + 关闭 ==================== */}
        <header className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2 sm:px-4">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-400/10">
            <FileText className="h-3.5 w-3.5 text-cyan-400" aria-hidden />
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13px] font-semibold tracking-wide text-slate-100">
              SRE 故障复盘报告
            </h2>
            <p className="mt-0.5 truncate font-mono text-[9px] tracking-[0.16em] text-slate-500">
              incident post-mortem · markdown export
            </p>
          </div>

          {/* 字数统计：字符数是交付给用户的第一手感指标（太短说明会话没内容） */}
          <span
            className="shrink-0 rounded border border-slate-700 bg-slate-900/70 px-2 py-0.5 font-mono text-[10px] tabular-nums text-slate-400"
            title={`${charCount} 个字符 · ${lineCount} 行`}
          >
            {charCount} 字符
          </span>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭复盘报告弹窗"
            className="shrink-0 rounded-md border border-slate-800 p-1.5 text-slate-500 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-300 active:scale-95"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </header>

        {/* ==================== 标签栏：预览 / 源码 ==================== */}
        <div
          role="tablist"
          aria-label="报告视图切换"
          className="flex shrink-0 items-center gap-1 border-b border-slate-800 bg-slate-900/50 px-3 py-1.5 sm:px-4"
        >
          {VIEW_TABS.map((tab): React.ReactElement => {
            const isActive = tab.key === mode;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={(): void => setMode(tab.key)}
                className={cn(
                  'rounded px-2.5 py-1 font-mono text-[10px] tracking-wider transition-colors',
                  isActive
                    ? 'border border-cyan-400/50 bg-cyan-400/15 text-cyan-300'
                    : 'border border-transparent text-slate-500 hover:bg-white/[0.05] hover:text-slate-300',
                )}
              >
                {tab.label}
              </button>
            );
          })}

          <span className="ml-auto hidden font-mono text-[9px] text-slate-600 sm:inline">
            {lineCount} 行
          </span>
        </div>

        {/* ==================== 内容区 ==================== */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {isPreview ? (
            markdown.trim() === '' ? (
              <p className="rounded border border-dashed border-slate-800 px-3 py-6 text-center text-[11px] text-slate-500">
                报告内容为空：请先在 Copilot 中完成至少一轮排障对话。
              </p>
            ) : (
              <MarkdownLite
                markdown={markdown}
                className="text-[12px] leading-relaxed text-slate-300"
              />
            )
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-400">
              {markdown}
            </pre>
          )}
        </div>

        {/* ==================== 底部操作栏 ==================== */}
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-800 bg-slate-900/40 px-3 py-2 sm:px-4">
          <button
            type="button"
            onClick={handleDownload}
            aria-label="下载 Markdown 报告"
            className="flex items-center gap-1.5 rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-cyan-300 transition-colors hover:border-cyan-400/70 hover:bg-cyan-500/25 active:scale-[0.985]"
          >
            <Download className="h-2.5 w-2.5" aria-hidden />
            下载 .md
          </button>

          <button
            type="button"
            onClick={handleCopy}
            aria-label="复制 Markdown 源码"
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-[0.985]',
              copied
                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-cyan-400/40 hover:text-cyan-300',
            )}
          >
            {copied ? (
              <Check className="h-2.5 w-2.5" aria-hidden />
            ) : (
              <Copy className="h-2.5 w-2.5" aria-hidden />
            )}
            {copied ? '已复制' : '复制 Markdown'}
          </button>

          {/* 复制失败降级提示：占据剩余空间，过长时截断并保留 title 全文 */}
          {copyError !== null ? (
            <span
              role="status"
              className="min-w-0 flex-1 truncate font-mono text-[9px] leading-relaxed text-amber-400/90"
              title={copyError}
            >
              {copyError}
            </span>
          ) : (
            <span
              className="ml-auto hidden min-w-0 items-center gap-1 font-mono text-[9px] text-slate-600 sm:flex"
              title={filename ?? '下载时按当前时刻生成文件名'}
            >
              <span className="truncate">{filename ?? 'kubevision-postmortem-*.md'}</span>
              <span className="shrink-0 text-slate-700">·</span>
              <span className="shrink-0">端侧生成，原始凭证未离开浏览器</span>
            </span>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
