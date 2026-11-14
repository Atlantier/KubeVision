'use client';

/**
 * 模态框与移动端 Bottom Sheet 通用交互钩子（焦点捕获归还 + 拖拽把手下拉关闭）
 *
 * 【设计意图】
 * 统一规范 Chaos / RAG / PostMortem / ShortcutHelp / CommandPalette 的焦点流转与移动端手势关闭：
 * 1. `useFocusReturn`: 打开时记住原焦点并移入弹窗首焦点，关闭/卸载后仅在焦点跌落至 body 时
 *    无感归还至触发元素（避免打断「命令面板跳转至另一弹层」的主动焦点迁移）；
 * 2. `useSheetSwipeClose`: 为 < md 视口底部弹层把手提供下拉手势关闭与阻尼位移状态，
 *    保持内部滚动区互不干扰。
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/** 触发下拉关闭所需的最小纵向拖拽距离（px） */
const SWIPE_CLOSE_THRESHOLD_PX = 72;

/**
 * useFocusReturn —— 模态开启捕获触发焦点，关闭时自动归还。
 */
export function useFocusReturn(
  isOpen: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  useEffect((): (() => void) | undefined => {
    if (!isOpen || typeof document === 'undefined') return undefined;

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusTimer = window.requestAnimationFrame((): void => {
      if (initialFocusRef?.current !== null && initialFocusRef?.current !== undefined) {
        initialFocusRef.current.focus({ preventScroll: true });
      }
    });

    return (): void => {
      window.cancelAnimationFrame(focusTimer);
      window.requestAnimationFrame((): void => {
        if (previousFocus === null || !previousFocus.isConnected) return;
        const active = document.activeElement;
        /* 仅当当前焦点已因弹层关闭跌落至 body/html 或已不在 DOM 中时才归还，不抢夺新弹窗焦点 */
        const lostFocus =
          active === null ||
          active === document.body ||
          active === document.documentElement ||
          !active.isConnected;
        if (lostFocus) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    };
  }, [isOpen, initialFocusRef]);
}

/**
 * useSheetSwipeClose —— 移动端 Bottom Sheet 顶部把手下拉关闭手势。
 */
export function useSheetSwipeClose(onClose: () => void): {
  readonly dragOffsetY: number;
  readonly handlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly handlePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly handlePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly handlePointerCancel: () => void;
} {
  const startYRef = useRef<number | null>(null);
  const offsetRef = useRef<number>(0);
  const [dragOffsetY, setDragOffsetY] = useState<number>(0);

  const reset = useCallback((): void => {
    startYRef.current = null;
    offsetRef.current = 0;
    setDragOffsetY(0);
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    startYRef.current = event.clientY;
    offsetRef.current = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (startYRef.current === null) return;
    const delta = Math.max(0, event.clientY - startYRef.current);
    offsetRef.current = delta;
    setDragOffsetY(delta);
  }, []);

  const handlePointerUp = useCallback((): void => {
    if (startYRef.current === null) return;
    const shouldClose = offsetRef.current >= SWIPE_CLOSE_THRESHOLD_PX;
    reset();
    if (shouldClose) {
      onClose();
    }
  }, [onClose, reset]);

  return {
    dragOffsetY,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel: reset,
  };
}
