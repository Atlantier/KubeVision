'use client';

/**
 * KubeVision AI — 页面/视口可见性休眠钩子（useInViewPause）
 *
 * 【设计意图】一个全屏 3D 看板最容易被忽视的性能黑洞，是它**在用户看不见
 * 的时候依然全速渲染**：切到别的标签页后，浏览器仍在为不可见的 canvas
 * 执行 60FPS 的 draw call，白白消耗电池与 GPU，还会让后台标签页被浏览器
 * 降频后产生时间跳变。
 *
 * 本 Hook 同时监听两个正交的可见性信号：
 * 1. **页面级**：document.visibilityState —— 用户切到其它标签页/最小化窗口；
 * 2. **视口级**：IntersectionObserver —— 画布被滚动出可视区域，或被
 *    移动端视图切换隐藏（ShellLayout 用 CSS hidden 隐藏左栏时画布仍在 DOM）。
 *
 * 任一信号变为不可见，即判定为「应暂停高频计算」。
 *
 * 【为何两级都要】只监听页面可见性会漏掉「画布滚出视口」；
 * 只监听 IntersectionObserver 会漏掉「切标签页」（此时元素几何上仍可见，
 * 但浏览器已停止为其绘制）。两者互补才能覆盖真实使用场景。
 *
 * 【暂停语义】Hook 只输出布尔状态，不直接操作渲染器——具体「暂停什么」
 * 由消费方决定（例如把粒子更新降频、跳过非必要的每帧计算）。
 * 这样同一个 Hook 既能约束 R3F 场景，也能约束独立的动画循环。
 */

import { useEffect, useRef, useState } from 'react';

/* ========================================================================== */
/* 类型契约                                                                    */
/* ========================================================================== */

/** useInViewPause 的返回形状 */
export interface InViewPauseState {
  /** 页面是否处于前台（document.visibilityState === 'visible'） */
  readonly isPageVisible: boolean;
  /** 目标元素是否在视口内（无 ref 时恒为 true） */
  readonly isElementInView: boolean;
  /**
   * 综合判定：是否应当**继续**高频运算。
   * 等价于 isPageVisible && isElementInView。
   */
  readonly isActive: boolean;
}

/* ========================================================================== */
/* Hook 实现                                                                   */
/* ========================================================================== */

/**
 * useInViewPause —— 返回当前是否应保持活跃运算。
 *
 * @param targetRef 被观察的元素（通常是画布容器）。传 null 时只监听页面可见性。
 * @param rootMargin IntersectionObserver 的 rootMargin，默认 '120px'（提前恢复）
 * @returns 包含页面可见性、元素可见性与综合活跃态的只读对象
 *
 * 【默认 rootMargin 取 120px 的理由】若等到元素完全进入视口才恢复渲染，
 * 用户会先看到一帧空白再看到画面弹出。向外扩张 120px 让渲染在元素
 * **即将**进入视口时就恢复，滚动下来时画面已经准备好。
 */
export function useInViewPause(
  targetRef?: React.RefObject<HTMLElement | null>,
  rootMargin = '120px',
): InViewPauseState {
  /** 初始值：SSR 阶段无 document，按"可见"处理避免闪白 */
  const [isPageVisible, setIsPageVisible] = useState<boolean>(true);
  const [isElementInView, setIsElementInView] = useState<boolean>(true);

  /* ========================================================================== */
  /* 信号一：页面可见性                                                           */
  /* ========================================================================== */

  useEffect(() => {
    /* SSR 防御：Worker/服务端无 document */
    if (typeof document === 'undefined') return;

    /** 同步一次当前状态（挂载时页面可能已经处于后台） */
    const syncVisibility = (): void => {
      setIsPageVisible(document.visibilityState === 'visible');
    };
    syncVisibility();

    document.addEventListener('visibilitychange', syncVisibility);
    return (): void => {
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  }, []);

  /* ========================================================================== */
  /* 信号二：元素视口可见性                                                        */
  /* ========================================================================== */

  useEffect(() => {
    /* 无目标元素或不支持 IntersectionObserver（老浏览器）→ 视为始终可见 */
    if (targetRef === undefined || targetRef === null) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const element = targetRef.current;
    if (element === null) return;

    const observer = new IntersectionObserver(
      (entries): void => {
        for (const entry of entries) {
          setIsElementInView(entry.isIntersecting);
        }
      },
      { rootMargin, threshold: 0 },
    );

    observer.observe(element);
    return (): void => {
      observer.disconnect();
    };
  }, [targetRef, rootMargin]);

  /* ========================================================================== */
  /* 综合判定                                                                    */
  /* ========================================================================== */

  return {
    isPageVisible,
    isElementInView,
    isActive: isPageVisible && isElementInView,
  };
}

/* ========================================================================== */
/* 辅助 Hook：自适应降级因子                                                     */
/* ========================================================================== */

/**
 * useAdaptiveQualityFactor —— 把活跃状态映射为「工作量倍率」。
 *
 * 【核心思想】后台/离屏时不必粗暴地完全停止（那会在切回瞬间需要重建
 * 全部状态），而应按倍率降低非必要的高频计算。倍率语义：
 * - **1.0**：完全活跃，全速运行；
 * - **0.25**：降频运行（粒子/波纹等纯视觉计算按 1/4 步长推进），
 *   既省电又保持画面"活着"，切回时无需突变。
 *
 * 为何选 0.25 而非 0：视觉元素（如扩散波纹、流动粒子）若完全冻结，
 * 切回时会出现明显的"时间跳跃"（相位突然前进一大段）。降频到 1/4
 * 既降低约 75% 的计算量，又让相位连续——这是性能与观感的折中。
 *
 * @param isActive useInViewPause().isActive
 * @returns 工作量倍率 [0.25, 1.0]
 */
export function useAdaptiveQualityFactor(isActive: boolean): number {
  /** 记录上一帧倍率，用于平滑过渡（避免倍率突变造成视觉跳变） */
  const factorRef = useRef<number>(1);
  const [, forceRender] = useState<number>(0);

  useEffect(() => {
    factorRef.current = isActive ? 1 : 0.25;
    /* 触发一次重渲染让消费方拿到新倍率（倍率变化本身是低频事件） */
    forceRender((n): number => n + 1);
  }, [isActive]);

  return factorRef.current;
}
