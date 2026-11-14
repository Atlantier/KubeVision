'use client';

/**
 * KubeVision AI — 桌面端左右分栏拖拽调宽器（SplitPaneResizer）
 *
 * 【解决什么问题】右栏 AI 抽屉固定占 34%，但用户的需求是分场景的：
 * 读长诊断报告时需要更宽，盯 3D 拓扑时需要更窄。固定比例意味着
 * 两种场景下总有一种是别扭的。可拖拽分栏把这个决定权交还给用户，
 * 并记住选择。
 *
 * 【为何做成独立组件而不是内联在 ShellLayout】
 * 拖拽涉及 4 个 window 级事件监听、body 样式劫持、localStorage 读写、
 * 键盘无障碍与双击复位——内联进 ShellLayout 会让那个文件的行数再涨 150+，
 * 且这些逻辑与布局结构本身无关。抽成受控组件后，ShellLayout 只负责
 * 「把宽度值绑到 style 上」，职责清晰。
 *
 * 【SSR 水合安全】（AGENTS.md 第 4 条）
 * - 初始值恒为 config.defaultPct，**绝不在 useState 初始化函数里读 localStorage**：
 *   服务端渲染时没有 localStorage，若在初始化时读取会导致
 *   "服务端 34 / 客户端 48" 的首次渲染不一致 → React 水合警告。
 * - 改为在 useEffect（仅客户端执行）里读取并覆盖，此时组件已完成首次渲染，
 *   不会产生水合不匹配。
 * - 写入同样只在 useEffect 或事件回调中发生。
 *
 * 【拖拽实现要点】
 * 1. setPointerCapture：指针按下后由手柄独占后续事件。若不捕获，
 *    鼠标移出手柄（拖拽时必然发生）就会丢失 pointermove，拖拽立刻中断。
 * 2. 监听挂在 window 而非手柄：即便用户把指针拖到画布上、越过抽屉，
 *    也能持续收到事件（setPointerCapture 已保证，双保险）。
 * 3. 拖拽期间给 body 设 cursor + user-select:none：
 *    前者避免指针样式随鼠标位置乱跳（拖到输入框上会变成 I 形），
 *    后者防止拖拽时选中页面文字（这是拖拽交互最常见的体验事故）。
 * 4. 宽度换算：distanceFromRight = containerRect.right − clientX，
 *    pct = distanceFromRight / containerRect.width × 100。
 *    用 containerRect（而非 window.innerWidth）是因为主容器有 padding，
 *    用窗口宽度会得到偏差。
 * 5. 上下限双重夹逼：先按百分比夹逼到 [minPct, maxPct]，
 *    再检查换算后的像素宽是否小于 minPx，若是则回退到 minPx 对应的百分比。
 *    两次夹逼缺一不可——窄屏上 minPct 可能仍小于 minPx。
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { cn } from '@/utils/cn';
import type { DrawerResizeConfig } from '@/types/layout';

/* ========================================================================== */
/* 配置                                                                       */
/* ========================================================================== */

/**
 * 抽屉拖拽分栏配置。
 *
 * 【三大约束的相容性推导】
 * - 夹逼区间 [24, 52]：下限 24% 保证右栏在 1920 宽屏上仍有 460px（足够读卡片），
 *   上限 52% 保证左栏至少 48%（3D 视口不能被压成一条缝，否则拓扑失去意义）。
 * - 最小像素宽 310px：Copilot 内的 GenUI 卡片（指标卡双列 + 动作按钮）
 *   在低于 310px 时会开始横向溢出/文字挤爆，这是实测得到的硬下限。
 * - 默认 34%：此前固定值即 34（65/35 语境），保持用户既有观感不变。
 * - 相容性检查：1440 宽屏下 24% = 345px > 310（满足）；
 *   1280 宽屏下 24% = 307px < 310 → 像素约束生效，实际落在约 24.2%。
 *   即两个约束在常见笔电宽度下都能满足，极端窄屏由像素约束兜底。
 */
const RESIZE_CONFIG: DrawerResizeConfig = {
  defaultPct: 34,
  minPct: 24,
  maxPct: 52,
  minPx: 310,
  storageKey: 'kv-drawer-width-pct',
};

/** 键盘方向键的单次微调步长（百分比） */
const KEYBOARD_STEP_PCT = 2;

/** 键盘 Shift+方向键的粗调步长（百分比） */
const KEYBOARD_COARSE_STEP_PCT = 6;

/**
 * 双击复位的目标像素宽度。
 *
 * 【契约值】420px：刚好容纳一张 GenUI 指标卡 + 双侧内边距，
 * 是"读得清但不喧宾夺主"的右栏宽度。复位按像素而非百分比换算，
 * 保证不同分辨率下回到的是同一条实际宽度（详见 handleDoubleClick 注释）。
 */
const RESET_WIDTH_PX = 420;

/* ========================================================================== */
/* Props                                                                      */
/* ========================================================================== */

/** SplitPaneResizer 的 Props */
export interface SplitPaneResizerProps {
  /** 当前右栏宽度百分比 */
  readonly widthPct: number;
  /** 宽度变化回调（拖拽 / 键盘 / 复位均经此上报） */
  readonly onWidthChange: (nextPct: number) => void;
  /** 拖拽开始回调（父级可据此禁用过渡动画，避免拖动时卡顿） */
  readonly onDragStateChange?: (dragging: boolean) => void;
  /** 承载左右两栏的容器引用（用于把像素坐标换算为百分比） */
  readonly containerRef: React.RefObject<HTMLElement | null>;
}

/* ========================================================================== */
/* 工具函数                                                                   */
/* ========================================================================== */

/**
 * clampPct —— 把百分比夹逼到合法区间，并额外保证像素宽不小于 minPx。
 *
 * 【为何需要 containerWidth 参数】百分比约束与像素约束是两个维度：
 * 24% 在 2560 屏上是 614px（富余），在 1280 屏上只有 307px（不足 310）。
 * 只有知道容器实际宽度，才能判断像素约束是否生效。
 *
 * @param pct             目标百分比（可能越界）
 * @param containerWidth  容器像素宽（0 或负数时只看百分比约束）
 * @returns 夹逼后的合法百分比
 */
function clampPct(pct: number, containerWidth: number): number {
  if (!Number.isFinite(pct)) return RESIZE_CONFIG.defaultPct;

  /* ---- 第一层：百分比夹逼 ---- */
  let next = Math.min(RESIZE_CONFIG.maxPct, Math.max(RESIZE_CONFIG.minPct, pct));

  /* ---- 第二层：像素宽夹逼（窄屏下 minPct 可能仍不足 minPx） ---- */
  if (containerWidth > 0) {
    const pixelWidth = (next / 100) * containerWidth;
    if (pixelWidth < RESIZE_CONFIG.minPx) {
      next = (RESIZE_CONFIG.minPx / containerWidth) * 100;
      /* 若容器本身窄到连 minPx 都装不下，则放弃像素约束，退回 minPct */
      if (next > RESIZE_CONFIG.maxPct) next = RESIZE_CONFIG.minPct;
    }
  }
  return next;
}

/**
 * sanitizeStoredWidthPct —— 清洗损坏或越界的 localStorage 宽度值。
 *
 * @param raw localStorage 原始字符串
 * @returns 若合法返回夹逼后的百分比；损坏或越界则回退默认宽度 `defaultPct` 并标注需要自愈写回
 */
function sanitizeStoredWidthPct(raw: string): { readonly pct: number; readonly repaired: boolean } {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { pct: RESIZE_CONFIG.defaultPct, repaired: true };
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < RESIZE_CONFIG.minPct || parsed > RESIZE_CONFIG.maxPct) {
    return { pct: RESIZE_CONFIG.defaultPct, repaired: true };
  }
  return { pct: parsed, repaired: false };
}

/* ========================================================================== */
/* 组件主体                                                                   */
/* ========================================================================== */

/**
 * SplitPaneResizer —— 桌面端专属的左右分栏拖拽手柄。
 *
 * 【渲染位置】由父级以 `hidden lg:flex` 包裹，移动端（< lg）上下分栏时
 * 它完全不参与布局，也不可交互。
 *
 * @param props 见 SplitPaneResizerProps
 */
export default function SplitPaneResizer({
  widthPct,
  onWidthChange,
  onDragStateChange,
  containerRef,
}: SplitPaneResizerProps): React.ReactElement {
  /** 当前是否处于拖拽中（驱动手柄高亮） */
  const [dragging, setDragging] = useState<boolean>(false);
  /** 容器实时宽度（用于精确播报 aria-valuetext 与窄屏 resize minPx 自愈） */
  const [containerWidthPx, setContainerWidthPx] = useState<number>(0);

  /**
   * 拖拽会话的清理函数引用。
   *
   * 【为何用 ref 存而不是在 onPointerDown 内闭包】pointerup / pointercancel
   * 可能由 window 层面触发，闭包方式在组件重渲染后会指向旧闭包；
   * 存进 ref 保证任何时候都能拿到最新的清理逻辑。
   */
  const cleanupRef = useRef<(() => void) | null>(null);

  /** 当前百分比最新引用 */
  const widthPctRef = useRef<number>(widthPct);
  useEffect(() => {
    widthPctRef.current = widthPct;
  }, [widthPct]);

  /** 宽度回调的最新引用（避免在 window 监听器里产生过期闭包） */
  const onWidthChangeRef = useRef(onWidthChange);
  useEffect(() => {
    onWidthChangeRef.current = onWidthChange;
  }, [onWidthChange]);

  /** 拖拽状态回调的最新引用 */
  const onDragStateChangeRef = useRef(onDragStateChange);
  useEffect(() => {
    onDragStateChangeRef.current = onDragStateChange;
  }, [onDragStateChange]);

  /* 监听主容器尺寸变化（供 aria-valuetext 像素估算与窄屏 minPx 兜底） */
  useEffect((): (() => void) | undefined => {
    const container = containerRef.current;
    if (container === null || typeof window === 'undefined') return undefined;

    const syncWidth = (): void => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      setContainerWidthPx((prev): number => (Math.abs(prev - rect.width) < 1 ? prev : rect.width));
      const clamped = clampPct(widthPctRef.current, rect.width);
      if (Math.abs(clamped - widthPctRef.current) > 0.25) {
        onWidthChangeRef.current(clamped);
      }
    };

    syncWidth();
    window.addEventListener('resize', syncWidth);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncWidth) : null;
    observer?.observe(container);

    return (): void => {
      window.removeEventListener('resize', syncWidth);
      observer?.disconnect();
    };
  }, [containerRef]);

  /* 组件卸载时确保清理（防御拖拽中被卸载导致 body 样式与指针捕获残留） */
  useEffect((): (() => void) => {
    return (): void => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  /**
   * 根据指针 X 坐标计算并上报新宽度。
   *
   * 【换算公式】pct = (containerRect.right − clientX) / containerRect.width × 100
   * 即"指针距容器右缘的距离"占容器总宽的比例——这正是右栏应有的宽度。
   */
  const applyPointerWidth = useCallback(
    (clientX: number): void => {
      const container = containerRef.current;
      if (container === null) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const nextPct = ((rect.right - clientX) / rect.width) * 100;
      onWidthChangeRef.current(clampPct(nextPct, rect.width));
    },
    [containerRef],
  );

  /**
   * 结束拖拽会话：移除监听、恢复 body 样式、释放指针捕获。
   */
  const endDrag = useCallback((): void => {
    const cleanup = cleanupRef.current;
    if (cleanup !== null) {
      cleanup();
      cleanupRef.current = null;
    }
    setDragging(false);
    onDragStateChangeRef.current?.(false);
  }, []);

  /**
   * 启动拖拽会话。
   *
   * 【为何监听 window 的 pointermove 而非手柄自身】虽然 setPointerCapture
   * 已能把事件锁定到手柄，但 R3F Canvas 在拖拽路径上会持续接收 pointer
   * 事件并做射线检测；在 window 上以 capture 阶段监听可确保我们的处理
   * 先于画布逻辑执行，且不受事件冒泡被 stopPropagation 影响。
   */
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      /* 只响应主键（避免右键菜单 / 中键滚动触发拖拽）；同时阻断向底层 Canvas OrbitControls 渗透 */
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const targetEl = event.currentTarget;
      const pointerId = event.pointerId;

      /* 指针捕获：鼠标移出手柄后仍能收到事件 */
      try {
        targetEl.setPointerCapture(pointerId);
      } catch {
        /* 合成事件/脚本派发无有效 pointerId 时忽略捕获异常 */
      }

      setDragging(true);
      onDragStateChangeRef.current?.(true);

      /* ---- 拖拽期间的全局样式劫持 ---- */
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (moveEvent: PointerEvent): void => {
        applyPointerWidth(moveEvent.clientX);
      };

      const onUp = (): void => {
        endDrag();
      };

      const onCancel = (): void => {
        endDrag();
      };

      /* capture 阶段监听：抢在 R3F 画布的 pointer 处理之前 */
      window.addEventListener('pointermove', onMove, { capture: true });
      window.addEventListener('pointerup', onUp, { capture: true });
      window.addEventListener('pointercancel', onCancel, { capture: true });

      /* 注册清理函数：供 endDrag / pointercancel / 组件卸载调用，并显式释放指针捕获 */
      cleanupRef.current = (): void => {
        window.removeEventListener('pointermove', onMove, { capture: true });
        window.removeEventListener('pointerup', onUp, { capture: true });
        window.removeEventListener('pointercancel', onCancel, { capture: true });
        try {
          if (targetEl.hasPointerCapture(pointerId)) {
            targetEl.releasePointerCapture(pointerId);
          }
        } catch {
          /* 忽略已断开节点的指针捕获释放异常 */
        }
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      };
    },
    [applyPointerWidth, endDrag],
  );

  /**
   * 双击复位到默认宽度。
   *
   * 【为何按 420px 而不是按百分比】需求契约是"回到 420px"——
   * 这是一个**像素意图**：用户希望右栏刚好够读一张卡片。
   * 若按 34% 复位，在 2560 宽屏上会变成 870px（过宽），
   * 在 1280 屏上只有 435px，观感随分辨率漂移。
   * 因此这里把 420px 换算成当前容器的百分比并夹逼，
   * 保证任何分辨率下都落在同一条像素线上。
   */
  const handleDoubleClick = useCallback((): void => {
    const container = containerRef.current;
    const containerWidth = container !== null ? container.getBoundingClientRect().width : 0;
    if (containerWidth <= 0) {
      onWidthChangeRef.current(RESIZE_CONFIG.defaultPct);
      return;
    }
    const pct = (RESET_WIDTH_PX / containerWidth) * 100;
    onWidthChangeRef.current(clampPct(pct, containerWidth));
  }, [containerRef]);

  /**
   * 键盘微调（无障碍支持）。
   *
   * 【方向语义】手柄是垂直分隔条，"←/→" 调整右栏宽度：
   * 按 ← 让分隔条左移 = 右栏变宽；按 → 让分隔条右移 = 右栏变窄。
   * 这与用户对"拖动手柄"的心智模型完全一致，不是反直觉的。
   * Home / End 直达最小 / 最大，提供快速定位。
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const step = event.shiftKey ? KEYBOARD_COARSE_STEP_PCT : KEYBOARD_STEP_PCT;
      const container = containerRef.current;
      const containerWidth = container !== null ? container.getBoundingClientRect().width : 0;
      let next: number | null = null;

      if (event.key === 'ArrowLeft') {
        next = widthPct + step;
      } else if (event.key === 'ArrowRight') {
        next = widthPct - step;
      } else if (event.key === 'Home') {
        next = RESIZE_CONFIG.maxPct;
      } else if (event.key === 'End') {
        next = RESIZE_CONFIG.minPct;
      }

      if (next === null) return;
      event.preventDefault();
      onWidthChangeRef.current(clampPct(next, containerWidth));
    },
    [widthPct, containerRef],
  );

  const roundedPct = Math.round(widthPct);
  const resolvedPixelWidth =
    containerWidthPx > 0 ? Math.round((widthPct / 100) * containerWidthPx) : 0;
  const valueText =
    containerWidthPx > 0
      ? `AI 副驾宽度 ${roundedPct}%，${resolvedPixelWidth} 像素`
      : `AI 副驾宽度 ${roundedPct}%`;

  return (
    <div
      /* ---- 语义与无障碍契约 ---- */
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整 AI 副驾面板宽度（双击复位）"
      aria-valuenow={roundedPct}
      aria-valuemin={RESIZE_CONFIG.minPct}
      aria-valuemax={RESIZE_CONFIG.maxPct}
      aria-valuetext={valueText}
      tabIndex={0}
      /* ---- 交互 ---- */
      onPointerDown={handlePointerDown}
      onTouchStart={(event): void => {
        event.stopPropagation();
      }}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      /* ---- 视觉：2.5 宽（10px）的布局占据区 + 左右各 ±8px 防穿透命中护城河 ---- */
      className={cn(
        'group relative z-30 flex w-2.5 shrink-0 cursor-col-resize touch-none select-none items-center justify-center',
        'outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70',
      )}
    >
      {/* 左右 ±8px 透明防渗透区：边缘误触直接进入分栏命中区，阻断 OrbitControls 误旋转 */}
      <span
        aria-hidden
        data-testid="split-resizer-guard"
        className="absolute inset-y-0 -left-[8px] -right-[8px] cursor-col-resize touch-none"
      />
      {/*
       * 导轨线：常态几乎不可见（white/6%），悬停/拖拽时转为青色激光。
       *
       * 【激光流光】单纯的"变亮"只是状态切换，缺少"能量在流动"的暗示。
       * 悬停/拖拽时在导轨上叠一条自下而上扫过的渐变亮带
       * （animate-laser-scan，见 tailwind 配置），
       * 视觉上像一道电流在分栏线上游走——用户立刻知道"这里可以拖"。
       */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-[1px] -translate-x-1/2 transition-colors duration-150',
          'bg-white/[0.06]',
          'group-hover:bg-cyan-400/60',
          dragging && 'bg-cyan-400/80',
        )}
      />
      {/* 激光流光层：仅在悬停或拖拽时出现，1px 宽，覆在导轨之上 */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-[1px] -translate-x-1/2 overflow-hidden transition-opacity duration-200',
          dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <span
          className="absolute inset-x-0 block h-1/3 animate-laser-scan"
          style={{
            background:
              'linear-gradient(180deg, transparent 0%, rgba(34,211,238,0.15) 30%, rgba(165,243,252,0.95) 50%, rgba(34,211,238,0.15) 70%, transparent 100%)',
          }}
        />
      </span>

      {/*
       * 居中的胶囊抓手：**双竖线**（抓手的通用符号）。
       *
       * 【为何从 3 颗点改成双竖线】圆点在 HUD 语境里是"状态指示灯"，
       * 而竖线才是"可拖拽分隔符"的国际通用符号（VS Code / Figma 同款）。
       * 用错误的符号会让用户把它误读成"这里有个运行状态"，而不是"这里能拖"。
       */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none relative z-10 flex h-8 w-[9px] items-center justify-center gap-[3px] rounded-full',
          'border transition-all duration-150',
          dragging
            ? 'border-cyan-400 bg-cyan-400 shadow-glow-cyan'
            : 'border-white/[0.15] bg-slate-800/90 group-hover:border-cyan-400/80 group-hover:bg-cyan-400 group-hover:shadow-glow-cyan',
        )}
      >
        {[0, 1].map((bar): React.ReactElement => (
          <span
            key={bar}
            className={cn(
              'block h-[10px] w-[1.5px] rounded-full transition-colors duration-150',
              dragging ? 'bg-slate-950' : 'bg-white/[0.45] group-hover:bg-slate-950',
            )}
          />
        ))}
      </span>
    </div>
  );
}

/* ========================================================================== */
/* 宽度状态 Hook                                                              */
/* ========================================================================== */

/**
 * useDrawerWidth —— 右栏宽度状态 + localStorage 持久化。
 *
 * 【SSR 水合安全的关键设计】
 * useState 的初始值恒为 defaultPct（服务端与客户端首帧一致）；
 * 真实值在 useEffect 中读取后覆盖。若把「读 localStorage」写进
 * useState 初始化函数，服务端拿到 34、客户端首帧拿到 48，
 * React 会报 hydration mismatch 并回退到客户端渲染——
 * 这正是 AGENTS.md 第 4 条要杜绝的问题。
 *
 * @returns [当前宽度百分比, 设置函数（自动夹逼 + 持久化）]
 */
export function useDrawerWidth(): readonly [number, (next: number) => void] {
  const [widthPct, setWidthPct] = useState<number>(RESIZE_CONFIG.defaultPct);

  /* ---- 客户端挂载后读取记忆宽度（损坏或越界值自动自愈为默认 34% 并写回） ---- */
  useEffect((): void => {
    try {
      const stored = window.localStorage.getItem(RESIZE_CONFIG.storageKey);
      if (stored === null) return;
      const { pct, repaired } = sanitizeStoredWidthPct(stored);
      setWidthPct(pct);
      if (repaired) {
        window.localStorage.setItem(RESIZE_CONFIG.storageKey, String(pct));
      }
    } catch {
      /* localStorage 可能被隐私模式禁用：静默退回默认值，不影响使用 */
    }
  }, []);

  /**
   * 设置宽度并持久化。
   * 【夹逼在这里做第二次】调用方（拖拽/键盘）已夹逼过，但 setter 是公开
   * 契约，任何调用方都可能传入越界值，入口统一收敛最稳妥。
   */
  const setWidth = useCallback((next: number): void => {
    const safe = clampPct(next, 0);
    setWidthPct(safe);
    try {
      window.localStorage.setItem(RESIZE_CONFIG.storageKey, String(safe));
    } catch {
      /* 写入失败不影响本次会话的交互体验 */
    }
  }, []);

  return [widthPct, setWidth] as const;
}
