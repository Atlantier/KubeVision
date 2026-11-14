'use client';

/**
 * 模态框与移动端 Bottom Sheet 通用交互钩子（焦点陷阱 + 焦点归还 + Tablist 漫游 + 下拉关闭）
 *
 * 【设计意图】
 * 统一规范 Chaos / RAG / PostMortem / ShortcutHelp / CommandPalette 以及全站 Tablist 的键盘与指针交互：
 * 1. `useFocusReturn`:
 *    - 开启时捕获触发焦点，延迟 1 帧将焦点移入首焦点目标（`initialFocusRef` 或容器内首个可聚焦控件）；
 *    - 运行期激活顶层弹窗焦点陷阱（Tab / Shift+Tab 严格在当前最顶层模态容器内首尾循环，绝不泄漏到背景）；
 *    - 同步标记页面顶栏 `<header>` 处于 `inert` 状态（并保留 `<main>` 供脚本无障碍诊断测试聚焦而不被 Tab 误入）；
 *    - 关闭或卸载时，若焦点仍在关闭中的弹窗内部、或已跌落至 body/断开 DOM，立即无感归还触发元素；
 * 2. `handleRovingTabKeyDown`: 为所有 WAI-ARIA `role="tablist"` 提供 ArrowLeft/ArrowRight/Home/End 漫游；
 * 3. `useSheetSwipeClose`: 为 < md 视口底部弹层把手提供下拉手势关闭，并在抬起/取消时显式释放指针捕获。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

/** 触发下拉关闭所需的最小纵向拖拽距离（px） */
const SWIPE_CLOSE_THRESHOLD_PX = 72;

/** 可聚焦控件选择器 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** 活跃模态框实例栈项（用于叠层裁决与背景 inert 管理） */
interface ActiveModalEntry {
  readonly id: symbol;
  readonly getContainer: () => HTMLElement | null;
}

const activeModalStack: ActiveModalEntry[] = [];
let headerWasInertBeforeStack = false;

/** 同步页面顶栏 inert 状态：任意模态开启时禁止背景顶栏接收焦点或鼠标点击 */
function syncBackgroundHeaderInert(): void {
  if (typeof document === 'undefined') return;
  const header = document.querySelector('header');
  if (header === null) return;
  const hasActiveModal = activeModalStack.some((entry): boolean => {
    const el = entry.getContainer();
    return el !== null && el.isConnected;
  });
  if (hasActiveModal) {
    if (!header.hasAttribute('data-kv-modal-inert')) {
      headerWasInertBeforeStack = header.hasAttribute('inert');
      header.setAttribute('data-kv-modal-inert', 'true');
    }
    header.setAttribute('inert', '');
  } else {
    header.removeAttribute('data-kv-modal-inert');
    if (!headerWasInertBeforeStack) {
      header.removeAttribute('inert');
    }
    headerWasInertBeforeStack = false;
  }
}

/** 计算容器的有效 zIndex 与栈序，选出当前最顶层活跃模态容器 */
function getTopmostModalContainer(): HTMLElement | null {
  let bestEl: HTMLElement | null = null;
  let bestZ = -1;
  for (const entry of activeModalStack) {
    const el = entry.getContainer();
    if (el === null || !el.isConnected) continue;
    const rawZ = window.getComputedStyle(el).zIndex;
    const parsedZ = Number.parseInt(rawZ, 10);
    const zVal = Number.isFinite(parsedZ) ? parsedZ : 50;
    if (zVal >= bestZ) {
      bestZ = zVal;
      bestEl = el;
    }
  }
  return bestEl;
}

/** 收集容器内所有可见且未禁用的可聚焦元素 */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter((el): boolean => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    if (el.getAttribute('aria-hidden') === 'true' || el.closest('[inert]') !== null) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    return el.getClientRects().length > 0;
  });
}

/**
 * useFocusReturn —— 模态开启捕获触发焦点 + 顶层焦点陷阱，关闭时自动归还。
 *
 * @param isOpen 弹层是否处于打开状态
 * @param initialFocusRef 打开后首选聚焦元素引用；缺省时回退到容器内首个可聚焦元素
 * @param containerRef 模态容器引用（传入后开启 Tab / Shift+Tab 焦点陷阱）
 */
export function useFocusReturn(
  isOpen: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
  containerRef?: RefObject<HTMLElement | null>,
): void {
  useEffect((): (() => void) | undefined => {
    if (!isOpen || typeof document === 'undefined') return undefined;

    const modalId = Symbol('modal-focus-trap');
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const entry: ActiveModalEntry = {
      id: modalId,
      getContainer: (): HTMLElement | null => containerRef?.current ?? null,
    };

    if (containerRef !== undefined) {
      activeModalStack.push(entry);
      syncBackgroundHeaderInert();
    }

    let capturedContainer: HTMLElement | null = containerRef?.current ?? null;

    const focusTimer = window.requestAnimationFrame((): void => {
      capturedContainer = containerRef?.current ?? null;
      syncBackgroundHeaderInert();
      const target = initialFocusRef?.current ?? null;
      if (target !== null && target.isConnected) {
        target.focus({ preventScroll: true });
        return;
      }
      const container = capturedContainer;
      if (container !== null) {
        const focusables = getFocusableElements(container);
        if (focusables.length > 0) {
          focusables[0]?.focus({ preventScroll: true });
        } else {
          container.focus({ preventScroll: true });
        }
      }
    });

    const handleTrapKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const container = containerRef?.current ?? null;
      if (container === null || !container.isConnected) return;
      capturedContainer = container;
      /* 多个弹窗叠层时，仅最顶层容器消费 Tab 陷阱 */
      if (getTopmostModalContainer() !== container) return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;

      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
        return;
      }

      if (event.shiftKey) {
        if (active === first || active === container) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
        return;
      }

      if (active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    if (containerRef !== undefined) {
      window.addEventListener('keydown', handleTrapKeyDown, true);
    }

    return (): void => {
      window.cancelAnimationFrame(focusTimer);
      if (containerRef !== undefined) {
        window.removeEventListener('keydown', handleTrapKeyDown, true);
        const idx = activeModalStack.findIndex((item): boolean => item.id === modalId);
        if (idx >= 0) {
          activeModalStack.splice(idx, 1);
        }
        syncBackgroundHeaderInert();
      }

      window.requestAnimationFrame((): void => {
        if (previousFocus === null || !previousFocus.isConnected) return;
        const active = document.activeElement;
        const stillInsideClosingModal =
          capturedContainer !== null && active instanceof Node && capturedContainer.contains(active);
        const lostFocus =
          active === null ||
          active === document.body ||
          active === document.documentElement ||
          !active.isConnected ||
          stillInsideClosingModal;
        if (lostFocus) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    };
  }, [isOpen, initialFocusRef, containerRef]);
}

/**
 * handleRovingTabKeyDown —— WAI-ARIA Tablist 标准键盘漫游（ArrowLeft/Right + Home/End）。
 *
 * 【设计意图】让所有 role="tablist" 遵循单一 Tab 停靠点 + 方向键组内漫游规范：
 * 未激活页签 tabIndex=-1，激活页签 tabIndex=0，按左右方向键或 Home/End 同步切换选中项与焦点。
 */
export function handleRovingTabKeyDown<T extends string>(
  event: ReactKeyboardEvent<HTMLElement>,
  keys: readonly T[],
  activeKey: T,
  onSelect: (nextKey: T) => void,
  tabIdPrefix: string,
): void {
  if (keys.length === 0) return;
  const currentIndex = keys.indexOf(activeKey);
  if (currentIndex < 0) return;

  let nextIndex = -1;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      nextIndex = (currentIndex + 1) % keys.length;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      nextIndex = (currentIndex - 1 + keys.length) % keys.length;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = keys.length - 1;
      break;
    default:
      return;
  }

  const nextKey = keys[nextIndex];
  if (nextKey === undefined) return;
  event.preventDefault();
  onSelect(nextKey);

  if (typeof document !== 'undefined') {
    window.requestAnimationFrame((): void => {
      const target = document.getElementById(`${tabIdPrefix}-${nextKey}`);
      if (target instanceof HTMLElement) {
        target.focus({ preventScroll: true });
      }
    });
  }
}

/**
 * useSheetSwipeClose —— 移动端 Bottom Sheet 顶部把手下拉关闭手势。
 */
export function useSheetSwipeClose(onClose: () => void): {
  readonly dragOffsetY: number;
  readonly handlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly handlePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly handlePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly handlePointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
} {
  const startYRef = useRef<number | null>(null);
  const offsetRef = useRef<number>(0);
  const [dragOffsetY, setDragOffsetY] = useState<number>(0);

  const reset = useCallback((): void => {
    startYRef.current = null;
    offsetRef.current = 0;
    setDragOffsetY(0);
  }, []);

  const releaseCaptureSafely = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* 忽略已完成释放的 pointerId */
    }
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    startYRef.current = event.clientY;
    offsetRef.current = 0;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 忽略合成事件不支撑 pointerCapture 的场景 */
    }
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (startYRef.current === null) return;
    const delta = Math.max(0, event.clientY - startYRef.current);
    offsetRef.current = delta;
    setDragOffsetY(delta);
  }, []);

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      releaseCaptureSafely(event);
      if (startYRef.current === null) return;
      const shouldClose = offsetRef.current >= SWIPE_CLOSE_THRESHOLD_PX;
      reset();
      if (shouldClose) {
        onClose();
      }
    },
    [onClose, releaseCaptureSafely, reset],
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      releaseCaptureSafely(event);
      reset();
    },
    [releaseCaptureSafely, reset],
  );

  return {
    dragOffsetY,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  };
}
