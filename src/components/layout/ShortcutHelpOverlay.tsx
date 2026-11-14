'use client';

/**
 * ShortcutHelpOverlay —— "?" 快捷键帮助浮层（R32 · 追问 3）。
 *
 * 【键位契约】
 *   1 / 2  → 切换右栏页签（Copilot / 审计）
 *   F      → 聚焦搜索
 *   Space  → 暂停/恢复路演
 *   ?      → 打开/关闭本浮层
 *   Esc    → 关闭浮层
 * 每行带 aria-keyshortcuts，读屏可播报。
 *
 * 【焦点】打开时聚焦关闭按钮；Esc 经 useEscapeStack 分级栈关闭（本层优先级 60）；
 * 关闭后焦点归还由触发方处理（不抢页面焦点）。
 */

import { useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { MOTION } from '@/constants/tokens';
import { Z_CLASS } from '@/constants/zIndex';
import { useEscapeLayer } from '@/hooks/useEscapeStack';
import { useFocusReturn, useSheetSwipeClose } from '@/hooks/useModalSheetBehavior';
import { cn } from '@/utils/cn';

interface ShortcutHelpOverlayProps {
  /** 是否显示 */
  readonly open: boolean;
  /** 关闭回调 */
  readonly onClose: () => void;
}

const SHORTCUTS: ReadonlyArray<{ keys: string; label: string; aria: string }> = [
  { keys: '1 / 2', label: '切换右栏页签（Copilot / 审计）', aria: '1 2' },
  { keys: 'F', label: '聚焦搜索', aria: 'F' },
  { keys: 'Space', label: '暂停 / 恢复路演', aria: 'Space' },
  { keys: '?', label: '打开 / 关闭快捷键帮助', aria: 'Shift+Slash' },
  { keys: 'Esc', label: '关闭浮层', aria: 'Escape' },
  { keys: 'Cmd/Ctrl + K', label: '命令面板', aria: 'Meta+K Control+K' },
];

/** ShortcutHelpOverlay 组件 */
export default function ShortcutHelpOverlay({ open, onClose }: ShortcutHelpOverlayProps): React.ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useFocusReturn(open, closeRef, dialogRef);
  const swipe = useSheetSwipeClose(onClose);

  /*
   * 【R3】Esc 关闭注册进全站分级退出栈（优先级 60：低于命令面板/混沌/RAG/复盘
   * 等功能层，高于视口浮层与页面兜底）。旧实现挂在 ShellLayout 的 window 监听里，
   * 不判 defaultPrevented——混沌弹窗开着时按 Esc 会连帮助浮层一起关掉。
   */
  useEscapeLayer(open ? { id: 'shortcut-help', priority: 60, label: '快捷键帮助', onEscape: onClose } : null);

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          ref={dialogRef}
          key="shortcut-help-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: MOTION.overlayFadeSec, ease: MOTION.easeOut } }}
          transition={{ duration: MOTION.overlayFadeSec, ease: MOTION.easeOut }}
          role="dialog"
          aria-modal="true"
          aria-label="快捷键帮助"
          tabIndex={-1}
          className={cn(
            'kv-overlay fixed inset-0 flex items-end justify-center p-0 md:items-center md:p-4',
            Z_CLASS.MODAL,
          )}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: swipe.dragOffsetY }}
            exit={{
              opacity: 0,
              scale: 0.96,
              y: 12,
              transition: { duration: MOTION.panelExitSec, ease: MOTION.easeOut },
            }}
            transition={{ type: 'spring', ...MOTION.spring }}
            className="kv-panel max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl rounded-b-none p-4 kv-safe-bottom md:rounded-xl"
            onClick={(event): void => event.stopPropagation()}
          >
            <div
              className="mb-2 flex cursor-grab touch-none justify-center py-1 md:hidden"
              onPointerDown={swipe.handlePointerDown}
              onPointerMove={swipe.handlePointerMove}
              onPointerUp={swipe.handlePointerUp}
              onPointerCancel={swipe.handlePointerCancel}
              aria-hidden
            >
              <span className="h-1 w-10 rounded-full bg-white/25" />
            </div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-slate-100">快捷键</h2>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="关闭快捷键帮助"
                className="kv-touch-target flex min-h-[40px] min-w-[44px] items-center justify-center rounded-kv border border-white/[0.075] px-2 py-1 font-mono text-[10px] text-slate-300 hover:text-slate-100 md:min-h-0 md:min-w-0"
              >
                ESC
              </button>
            </div>
            <ul className="space-y-1.5">
              {SHORTCUTS.map((item): React.ReactElement => (
                <li key={item.keys} className="flex items-center justify-between gap-3">
                  <span className="text-[12px] text-slate-300">{item.label}</span>
                  <kbd
                    aria-keyshortcuts={item.aria}
                    className="rounded-kv border border-white/[0.075] bg-slate-900/60 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200"
                  >
                    {item.keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}