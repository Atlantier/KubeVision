'use client';

/**
 * KubeVision AI — 运维中控台响应式全屏布局外壳（ShellLayout）
 *
 * 【布局契约】
 * - 桌面端（≥ lg / 1024px）：flex-row 双栏——左栏 65%（lg:basis-[65%]，
 *   相对定位容器承载 3D 视口槽位 + 悬浮其底部的 TerminalEcho），
 *   右栏 35%（lg:basis-[35%]，AI 抽屉槽位）。
 *   tailwind-merge 陷阱：比例类必须写作 `lg:basis-[65%] lg:grow-0 lg:shrink-0`，
 *   严禁与 `lg:flex-none` 同变体共存——cn()（twMerge）冲突表将 flex-none 归入
 *   flex 组，会**静默移除**同变体的 basis 组类（实测 twMerge('flex-1
 *   lg:basis-[65%] lg:flex-none') → 'flex-1 lg:flex-none'），导致 65/35
 *   分栏比例在桌面端失效，且 tsc/build/lint 全绿无感知。
 *   grow-0 + shrink-0 + basis 展开写法与 flex-none 视觉等价且不触发合并冲突。
 * - 小屏（< 1024px）：flex-col 上下分栏为基底，同时挂载底部浮动切换栏，
 *   在「3D 拓扑视图」与「AI Copilot 视图」间丝滑切换——双面板均常驻 DOM，
 *   仅以 AnimatePresence + 不透明度/位移过渡切换可见性，避免反复卸载
 *   R3F Canvas 触发 WebGL 上下文重建（上下文重建 ≈ 数百 ms 卡顿 + 显存重传）。
 *
 * 【全局键盘契约】Shift+P 切换性能 HUD（isPerfHudOpen），监听器挂载于
 * 本外壳（全局唯一），输入焦点在 input/textarea/contenteditable 时忽略，
 * 防止用户在 Copilot 输入框打字触发误切。
 *
 * 【性能 HUD 采样契约】HUD 数据来自瞬态轨 telemetryTransientRef.glStats
 * （渲染循环每帧写入）——严禁将高频数值接入 zustand/useState 逐帧更新；
 * 本组件以 setInterval 4Hz 低频采样进本地 state，读取与渲染解耦，
 * HUD 关闭时连采样定时器都不启动（零后台开销）。
 *
 * 【槽位开闭原则】viewport / drawer 为 ReactNode 插槽，本轮提供深空占位；
 * 后续轮次注入 next/dynamic(ssr:false) 的 R3F Canvas 与 Copilot 抽屉，
 * 外壳代码零改动。
 */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, Layers, ShieldCheck } from 'lucide-react';

import { AGENT_COPY } from '@/constants/copy';
import { Z_CLASS } from '@/constants/zIndex';
import { cn } from '@/utils/cn';
import { isInteractiveTarget } from '@/utils/keyboardTargets';
import { useClusterStore } from '@/store/useClusterStore';
import type { ChaosScenario } from '@/types/cluster';
import type { RightPanelTab } from '@/types/store';
import type {
  MobileViewKey,
  RightDrawerSlotProps,
  ShellLayoutProps,
} from '@/types/layout';

import TopBar from '@/components/layout/TopBar';
import TerminalEcho from '@/components/layout/TerminalEcho';
import PresentStatusHud from '@/components/layout/PresentStatusHud';
import ShortcutHelpOverlay from '@/components/layout/ShortcutHelpOverlay';
import { usePresentMode, PRESENT_DRAWER_WIDTH_PCT } from '@/store/usePresentMode';
import { togglePauseDemoDirector } from '@/utils/demoDirector';
import SplitPaneResizer, { useDrawerWidth } from '@/components/layout/SplitPaneResizer';

/* ========================================================================== */
/* 模块级常量                                                                  */
/* ========================================================================== */

/* 说明：原 CHAOS_SCENARIO_OPTIONS 常量已随内联模态框一同迁出——
   演练场景卡片的完整数据表现由独立的 ChaosControlModal 组件持有
   （见 src/components/hud/ChaosControlModal.tsx 的 CHAOS_DRILL_CARDS）。 */

/* ========================================================================== */
/* 子组件：右侧抽屉页签外壳                                                     */
/* ========================================================================== */

/**
 * RightDrawerSlot —— 右侧 AI 抽屉页签外壳（copilot / auditor 双页签）。
 *
 * 页签激活态以主题青色下划线 + 辉光强调；正文区 overflow-y-auto
 * 独立滚动（细滚动条样式由 globals.css 全局提供）。
 */
export function RightDrawerSlot({ activeTab, onTabChange, children }: RightDrawerSlotProps) {
  const tabs: ReadonlyArray<{ readonly key: RightPanelTab; readonly label: string; readonly srAnchor?: string }> = [
    { key: 'copilot', label: AGENT_COPY.copilotTitle },
    { key: 'auditor', label: AGENT_COPY.auditorTitle, srAnchor: AGENT_COPY.auditorSrOnlyAnchor },
  ];

  return (
    <div className="kv-panel flex h-full min-h-0 flex-col overflow-hidden rounded-none border-y-0 border-r-0 lg:rounded-lg lg:border">
      {/* 页签栏 */}
      <div role="tablist" aria-label="AI 抽屉页签" className="flex h-10 shrink-0 items-stretch gap-1 border-b border-white/[0.07] px-2">
        {tabs.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={(): void => onTabChange(tab.key)}
              className={cn(
                'relative flex items-center gap-1.5 px-3 font-mono text-[11px] tracking-wider transition-colors',
                active ? 'text-cyan-300' : 'text-slate-500 hover:text-slate-300',
              )}
            >
              {tab.key === 'copilot' ? <Bot className="h-3.5 w-3.5" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
              {tab.label}
              {tab.srAnchor !== undefined ? <span className="sr-only">{tab.srAnchor}</span> : null}
              {active ? (
                <motion.span
                  layoutId="drawer-tab-underline"
                  transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                  className="absolute inset-x-2 bottom-0 h-px bg-cyan-400 shadow-glow-cyan"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* 页签正文（独立滚动） */}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/* 说明：原 PerfHudPanel 已移除。性能遥测 HUD 迁至独立组件
   src/components/hud/PerfTelemetryHUD.tsx，由 page.tsx 通过 next/dynamic
   按需懒加载（首屏零开销）。本文件仅保留 Shift+P 的开关状态维护。 */
/* ========================================================================== */
/* 子组件：移动端底部浮动视图切换栏                                              */
/* ========================================================================== */

/**
 * MobileViewSwitcher —— 小屏（< lg）底部浮动切换栏。
 *
 * 二段式拨片在「3D 拓扑」与「AI 运维副驾」间切换 mobileView；
 * fixed 定位悬浮于视口底部安全区之上（pb 兼容 iOS home indicator），
 * z-30 低于顶层 Modal（z-50）与 HUD（z-40）。
 */
function MobileViewSwitcher({
  view,
  onChange,
  hidden = false,
}: {
  readonly view: MobileViewKey;
  readonly onChange: (view: MobileViewKey) => void;
  readonly hidden?: boolean;
}) {
  if (hidden) return null;
  const items: ReadonlyArray<{ readonly key: MobileViewKey; readonly label: string }> = [
    { key: 'topology', label: '3D 拓扑视图' },
    { key: 'copilot', label: AGENT_COPY.copilotTitle },
  ];
  return (
    <div
      className={cn('fixed inset-x-0 bottom-3 flex justify-center px-4 lg:hidden kv-safe-bottom', Z_CLASS.CHROME_POPOVER)}
      aria-label="移动端视图切换"
    >
      <div className="kv-panel pointer-events-auto flex items-center gap-1 rounded-full p-1 shadow-panel">
        {items.map((item) => {
          const active = view === item.key;
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={active}
              onClick={(): void => onChange(item.key)}
              className={cn(
                'relative flex min-h-[44px] items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition-colors kv-touch-feedback',
                active ? 'text-slate-950' : 'text-slate-400',
              )}
            >
              {active ? (
                <motion.span
                  layoutId="mobile-view-thumb"
                  transition={{ type: 'spring', stiffness: 480, damping: 32 }}
                  className={cn(
                    'absolute inset-0 rounded-full',
                    item.key === 'topology' ? 'bg-cyan-400 shadow-glow-cyan' : 'bg-emerald-400 shadow-glow-emerald',
                  )}
                />
              ) : null}
              {item.key === 'topology' ? <Layers className="relative z-10 h-3.5 w-3.5" aria-hidden /> : <Bot className="relative z-10 h-3.5 w-3.5" aria-hidden />}
              <span className="relative z-10">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* ShellLayout 主体                                                            */
/* ========================================================================== */

/**
 * ShellLayout —— 中控台全屏外壳（TopBar + 双栏主体 + 移动端切换 + 浮层群）。
 *
 * 【层级栈】TopBar z-30 / 移动端切换栏 z-30 / PerfHUD z-40 / 混沌 Modal z-50；
 * 画布内 drei <Html> 恒 zIndexRange=[10,0]，永不遮挡以上任何 UI（契约第 6 条）。
 */
export default function ShellLayout({ viewport, drawer, perfHud }: ShellLayoutProps) {
  /* ---- Store 细粒度订阅 ---- */
  const setPerfHudOpen = useClusterStore((s): ((open: boolean) => void) => s.setPerfHudOpen);
  const setActiveRightTab = useClusterStore((s): ((tab: RightPanelTab) => void) => s.setActiveRightTab);
  /* 混沌场景订阅：驱动视口四周的警示氛围光（仅一个字符串比较，开销可忽略） */
  const activeChaos = useClusterStore((s): ChaosScenario => s.activeChaos);

  /* ---- 移动端视图键（Store 状态，非持久化）：
     由本地 useState 提升而来——画布视口工具条的「快照诊断」经
     triggerQuickPrompt 联动切至 copilot 视图，跨组件唤醒只有经 Store 才能贯通 ---- */
  const mobileView = useClusterStore((s): MobileViewKey => s.activeMobileView);
  const setMobileView = useClusterStore((s): ((view: MobileViewKey) => void) => s.setActiveMobileView);

  /* ---- 右栏可拖拽宽度（localStorage 记忆；SSR 安全见 useDrawerWidth 注释） ---- */
  const [drawerWidthPct, setDrawerWidthPct] = useDrawerWidth();

  /* R32：演示模式（?present=1 或顶栏开关）——只改 DOM，不重建 Canvas */
  const present = usePresentMode((s): boolean => s.present);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);
  const effectiveDrawerPct = present ? PRESENT_DRAWER_WIDTH_PCT : drawerWidthPct;

  useEffect((): void => {
    const fromUrl = new URLSearchParams(window.location.search).get('present') === '1';
    if (fromUrl) usePresentMode.getState().setPresent(true);
  }, []);

  useEffect((): (() => void) => {
    document.body.dataset.present = present ? '1' : '0';
    return (): void => {
      delete document.body.dataset.present;
    };
  }, [present]);

  /** 拖拽中的标志：拖拽期间禁用宽度过渡，否则会与指针位置产生"橡皮筋"延迟 */
  const [isResizing, setIsResizing] = useState<boolean>(false);

  /**
   * 主容器引用：Resizer 需要测量左栏+右栏容器宽度来换算拖拽百分比。
   */
  const mainRef = useRef<HTMLDivElement>(null);
  const viewportSectionRef = useRef<HTMLElement>(null);
  const drawerSectionRef = useRef<HTMLElement>(null);

  /** 桌面端断点标记（>= 1024px 时双栏并排，不启用 inert） */
  const [isLgDesktop, setIsLgDesktop] = useState<boolean>(true);
  /** 移动端软键盘弹出态：收缩可视高度并聚焦输入控件时自动隐藏底部切换条 */
  const [keyboardOpen, setKeyboardOpen] = useState<boolean>(false);

  useEffect((): (() => void) => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const syncDesktop = (): void => setIsLgDesktop(mq.matches);
    syncDesktop();
    mq.addEventListener('change', syncDesktop);
    return (): void => mq.removeEventListener('change', syncDesktop);
  }, []);

  /* 小屏隐藏面同步 inert：保活 Canvas WebGL 上下文与 Copilot scrollTop/输入草稿，同时阻断后台焦点穿透 */
  useEffect((): void => {
    const viewportEl = viewportSectionRef.current;
    const drawerEl = drawerSectionRef.current;
    const hideViewport = !isLgDesktop && mobileView !== 'topology';
    const hideDrawer = !isLgDesktop && mobileView !== 'copilot';
    viewportEl?.toggleAttribute('inert', hideViewport);
    drawerEl?.toggleAttribute('inert', hideDrawer);
  }, [isLgDesktop, mobileView]);

  const maxHeightRef = useRef<number>(0);

  useEffect((): (() => void) => {
    const syncKeyboard = (): void => {
      if (isLgDesktop) {
        maxHeightRef.current = window.innerHeight;
        setKeyboardOpen(false);
        return;
      }
      if (window.innerHeight > maxHeightRef.current) {
        maxHeightRef.current = window.innerHeight;
      }
      const active = document.activeElement;
      const isTextInputFocused =
        active !== null && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      const vvHeight = window.visualViewport?.height ?? window.innerHeight;
      const baseline = Math.max(window.innerHeight, maxHeightRef.current);
      const shrunk = baseline > 0 && vvHeight < baseline * 0.75;
      setKeyboardOpen(isTextInputFocused || shrunk);
    };

    const syncKeyboardDeferred = (): void => {
      window.requestAnimationFrame(syncKeyboard);
    };

    syncKeyboard();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', syncKeyboard);
    window.addEventListener('resize', syncKeyboard);
    document.addEventListener('focusin', syncKeyboard);
    document.addEventListener('focusout', syncKeyboardDeferred);
    return (): void => {
      vv?.removeEventListener('resize', syncKeyboard);
      window.removeEventListener('resize', syncKeyboard);
      document.removeEventListener('focusin', syncKeyboard);
      document.removeEventListener('focusout', syncKeyboardDeferred);
    };
  }, [isLgDesktop]);

  /* ---- 全局键盘：Shift+P 切换性能 HUD ---- */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      /*
       * 【交互元素让位（R3）】焦点在 input/textarea/contentEditable/button/a/
       * select/summary/role=button|tab|menuitem|radio|checkbox/audio/video 上时，
       * 按键属于该控件：空格必须保留原生激活（旧实现只判输入框，焦点停在
       * 按钮上按空格会被 preventDefault 劫持，按钮永远按不动）。
       * 全局快捷键只在非交互背景生效；Ctrl/Cmd+K 在 page.tsx，不受此限。
       */
      if (isInteractiveTarget(event.target)) return;
      if (event.shiftKey && (event.key === 'P' || event.key === 'p')) {
        event.preventDefault();
        setPerfHudOpen(!useClusterStore.getState().isPerfHudOpen);
        return;
      }

      /* R32 追问 3：键盘可达 */
      if (event.key === '1' || event.key === '2') {
        event.preventDefault();
        setActiveRightTab(event.key === '1' ? 'copilot' : 'auditor');
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        const search = document.querySelector<HTMLElement>(
          'input[type="search"], [role="searchbox"], input[aria-label*="搜索"], input[placeholder*="搜索"]',
        );
        if (search !== null) {
          event.preventDefault();
          search.focus();
        }
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        togglePauseDemoDirector();
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        setHelpOpen((open): boolean => !open);
        return;
      }
      /* Esc 不在此处理：全站唯一派发器是 useEscapeStack（page.tsx），
         帮助浮层已注册为 Esc 层（ShortcutHelpOverlay），此处再写一份
         就会与分级栈抢键，一次 Esc 退多层。 */
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [setPerfHudOpen, setActiveRightTab]);

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-slate-950">
      {/* ============ 顶栏 ============ */}
      <TopBar />

      {/* ============ 主体：桌面双栏（右栏可拖拽）· 移动上下分栏 ============ *
       * 【桌面端无界工业风格：lg:gap-0 lg:p-2】
       * 早期用 lg:gap-3（12px）+ lg:p-3（12px），两栏之间实际有 12px+12px+12px
       * 的累计间隙，视觉上松散，且拖拽时分栏手柄与两侧面板之间出现明显"空洞"。
       * 收紧为 gap-0 + p-2（8px）后：
       * - 左右两栏**直接相接**，中间的 w-2.5（10px）拖拽手柄本身就是唯一的呼吸间距，
       *   这 10px 既承载视觉分隔又承载交互命中区，一个元素干两件事；
       * - 拖拽时宽度变化严丝合缝，不会因为 gap 的固定像素而使比例显得"漂移"
       *   （有 gap 时：右栏 = pct% × contentW，但 contentW 已扣除 gap，
       *   而视觉上两栏之间的空隙不随 pct 变化，比例观感会被固定 gap 带偏）。
       *
       * 【移动端保持不变】小屏仍是 gap-2 + p-2 + pb-14：
       * 上下分栏没有拖拽手柄承担间距，需要真实的外边距分隔两个面板；
       * pb-14 为底部悬浮切换栏（约 44px + 12px 间距）预留安全区，
       * 否则会盖住 TerminalEcho 与 Copilot 的快捷指令芯片。
       */}
      <main
        className={cn(
          'flex min-h-0 flex-1 flex-col p-2 lg:flex-row lg:gap-0 lg:p-2',
          keyboardOpen
            ? 'pb-2 lg:pb-2'
            : 'pb-[calc(4.75rem+env(safe-area-inset-bottom))] lg:pb-2',
        )}
      >
        <div
          ref={mainRef}
          className="relative flex min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden lg:flex-row lg:gap-0"
        >
          {/* ---- 左栏：3D 视口槽位（桌面 flex-1，移动端与右栏重叠常驻保活 WebGL 上下文） ---- */}
          <section
            ref={viewportSectionRef}
            aria-label="3D 集群拓扑视口"
            aria-hidden={!isLgDesktop && mobileView !== 'topology' ? true : undefined}
            className={cn(
              'kv-fade-in overflow-hidden rounded-lg border border-white/[0.07] bg-slate-900/40',
              'absolute inset-0 transition-[opacity,transform] duration-200 ease-out',
              mobileView === 'topology'
                ? 'pointer-events-auto z-10 translate-x-0 opacity-100'
                : 'pointer-events-none z-0 -translate-x-2 opacity-0',
              'lg:static lg:inset-auto lg:z-auto lg:min-h-0 lg:min-w-0 lg:flex-1 lg:pointer-events-auto lg:translate-x-0 lg:opacity-100',
            )}
          >
            {/* 视口槽位：后续轮次注入 dynamic(ssr:false) R3F Canvas */}
            {viewport}

            {/* ---- 混沌演练态势氛围光（审查报告 §2.4.2）---- */}
            {activeChaos !== 'NONE' ? (
              <div
                className="pointer-events-none absolute inset-0 z-[5] animate-glow-pulse rounded-lg"
                aria-hidden
                style={{
                  boxShadow:
                    'inset 0 0 60px 12px rgba(244, 63, 94, 0.07), inset 0 0 140px 40px rgba(245, 158, 11, 0.05)',
                }}
              />
            ) : null}

            {/* 事件流终端：右侧避让相机工具条（< lg 避让底部浮动视图切换栏，移动 44px 按钮需 right-[84px]） */}
            {present ? null : <TerminalEcho className="absolute bottom-[4.75rem] left-3 right-[84px] md:right-[74px] lg:bottom-3" />}

            {/* R73：演示态状态胶囊锚定在 3D 视口左下角 */}
            {present ? <PresentStatusHud /> : null}

            {/* R74：性能 HUD 锚定在 3D 视口内 */}
            <AnimatePresence initial={false}>{perfHud}</AnimatePresence>
          </section>

          {/* ---- 桌面端专属分割手柄 ---- */}
          <div className="hidden lg:flex">
            <SplitPaneResizer
              widthPct={drawerWidthPct}
              onWidthChange={setDrawerWidthPct}
              onDragStateChange={setIsResizing}
              containerRef={mainRef}
            />
          </div>

          {/* ---- 右栏：AI 抽屉槽位（移动端常驻 DOM 保活 scrollTop/草稿/SSE，仅切换透明度与位移） ---- */}
          <section
            ref={drawerSectionRef}
            aria-label="AI Copilot 抽屉"
            aria-hidden={!isLgDesktop && mobileView !== 'copilot' ? true : undefined}
            style={{ '--drawer-w': `${effectiveDrawerPct}%` } as React.CSSProperties}
            className={cn(
              'kv-panel kv-fade-in flex min-w-0 max-w-full flex-col overflow-hidden overflow-x-hidden rounded-lg',
              'absolute inset-0 transition-[opacity,transform] duration-200 ease-out',
              mobileView === 'copilot'
                ? 'pointer-events-auto z-10 translate-x-0 opacity-100'
                : 'pointer-events-none z-0 translate-x-2 opacity-0',
              'lg:static lg:inset-auto lg:z-auto lg:min-h-0 lg:min-w-0 lg:pointer-events-auto lg:translate-x-0 lg:opacity-100 lg:w-[var(--drawer-w)] lg:shrink-0 lg:grow-0',
              isResizing ? 'transition-none' : 'lg:transition-[width] lg:duration-200 lg:ease-out',
            )}
          >
            {drawer}
          </section>
        </div>
      </main>

      {/* R32：演示模式极简状态胶囊已移入 3D 视口 section 左下角（见上方） */}
      <ShortcutHelpOverlay open={helpOpen} onClose={(): void => setHelpOpen(false)} />

      {/* ============ 移动端底部浮动切换栏（< lg 可见；软键盘弹出时自动让位） ============ */}
      <MobileViewSwitcher view={mobileView} onChange={setMobileView} hidden={keyboardOpen} />

      {/* ============ 顶层：混沌演练 Modal 已迁出 ============
          原内联 ChaosConsoleModal 已替换为独立组件
          src/components/hud/ChaosControlModal.tsx，由 page.tsx 经
          next/dynamic 按需懒加载挂载（首屏零 JS 开销、代码分割）。
          本外壳不再持有该模态框，只保留联动入口：
          TopBar 的 Inject Chaos 按钮写入 isChaosModalOpen，
          page.tsx 订阅该字段决定是否渲染动态组件。 */}
    </div>
  );
}