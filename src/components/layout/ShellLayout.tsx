'use client';

/**
 * KubeVision AI — 运维中控台响应式全屏布局外壳（ShellLayout）
 *
 * 【布局契约】
 * - 桌面端（≥ lg / 1024px）：flex-row 双栏——左栏 65%（lg:basis-[65%]，
 *   相对定位容器承载 3D 视口槽位 + 悬浮其底部的 TerminalEcho），
 *   右栏 35%（lg:basis-[35%]，AI 抽屉槽位）。
 *   ⚠️ tailwind-merge 陷阱：比例类必须写作 `lg:basis-[65%] lg:grow-0 lg:shrink-0`，
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

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, Layers, ShieldCheck, TerminalSquare } from 'lucide-react';

import { cn } from '@/utils/cn';
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

/* ========================================================================== */
/* 模块级常量                                                                  */
/* ========================================================================== */

/** 性能 HUD 采样频率（Hz）：4Hz 对人眼足够流畅，且远低于渲染帧率 */
const PERF_HUD_SAMPLE_HZ = 4;

/** 性能 HUD 采样间隔（毫秒，由频率换算） */
const PERF_HUD_SAMPLE_INTERVAL_MS = Math.round(1000 / PERF_HUD_SAMPLE_HZ);

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
  const tabs: ReadonlyArray<{ readonly key: RightPanelTab; readonly label: string }> = [
    { key: 'copilot', label: 'SRE Copilot' },
    { key: 'auditor', label: 'Edge Auditor' },
  ];

  return (
    <div className="kv-panel flex h-full min-h-0 flex-col overflow-hidden rounded-none border-y-0 border-r-0 lg:rounded-lg lg:border">
      {/* 页签栏 */}
      <div role="tablist" aria-label="AI 抽屉页签" className="flex h-10 shrink-0 items-stretch gap-1 border-b border-slate-800 px-2">
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
                'relative flex items-center gap-1.5 px-3 font-mono text-[11px] uppercase tracking-wider transition-colors',
                active ? 'text-cyan-300' : 'text-slate-500 hover:text-slate-300',
              )}
            >
              {tab.key === 'copilot' ? <Bot className="h-3.5 w-3.5" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
              {tab.label}
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
 * 二段式拨片在「3D 拓扑」与「AI Copilot」间切换 mobileView；
 * fixed 定位悬浮于视口底部安全区之上（pb 兼容 iOS home indicator），
 * z-30 低于顶层 Modal（z-50）与 HUD（z-40）。
 */
function MobileViewSwitcher({ view, onChange }: { readonly view: MobileViewKey; readonly onChange: (view: MobileViewKey) => void }) {
  const items: ReadonlyArray<{ readonly key: MobileViewKey; readonly label: string }> = [
    { key: 'topology', label: '3D 拓扑视图' },
    { key: 'copilot', label: 'AI Copilot 视图' },
  ];
  return (
    <div className="fixed inset-x-0 bottom-3 z-30 flex justify-center px-4 lg:hidden" aria-label="移动端视图切换">
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
                'relative flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-colors',
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
export default function ShellLayout({ viewport, drawer }: ShellLayoutProps) {
  /* ---- Store 细粒度订阅 ---- */
  const activeRightTab = useClusterStore((s): RightPanelTab => s.activeRightTab);
  const setPerfHudOpen = useClusterStore((s): ((open: boolean) => void) => s.setPerfHudOpen);
  const setActiveRightTab = useClusterStore((s): ((tab: RightPanelTab) => void) => s.setActiveRightTab);
  /* 混沌场景订阅：驱动视口四周的警示氛围光（仅一个字符串比较，开销可忽略） */
  const activeChaos = useClusterStore((s): ChaosScenario => s.activeChaos);

  /* ---- 移动端视图键（Store 状态，非持久化）：
     由本地 useState 提升而来——画布视口工具条的「📸 快照诊断」经
     triggerQuickPrompt 联动切至 copilot 视图，跨组件唤醒只有经 Store 才能贯通 ---- */
  const mobileView = useClusterStore((s): MobileViewKey => s.activeMobileView);
  const setMobileView = useClusterStore((s): ((view: MobileViewKey) => void) => s.setActiveMobileView);

  /* ---- 全局键盘：Shift+P 切换性能 HUD ---- */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 输入焦点让位：Copilot 输入框内打大写 P 不应触发 HUD
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (event.shiftKey && (event.key === 'P' || event.key === 'p')) {
        event.preventDefault();
        setPerfHudOpen(!useClusterStore.getState().isPerfHudOpen);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [setPerfHudOpen]);

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-slate-950">
      {/* ============ 顶栏 ============ */}
      <TopBar />

      {/* ============ 主体：桌面双栏 65/35 · 移动上下分栏 ============ *
       * 【移动端底部留白】小屏下 MobileViewSwitcher 以 fixed bottom-3 悬浮，
       * 此前会直接盖住 3D 视口底部的 TerminalEcho 与 Copilot 面板最底部的
       * 快捷指令芯片。pb-14 为切换栏（约 44px + 12px 间距）预留安全区，
       * 桌面端无需该留白故 lg:pb-3 回归正常。
       */}
      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2 pb-14 lg:flex-row lg:gap-3 lg:p-3">
        {/* ---- 左栏：3D 视口槽位（65%）+ 底部悬浮 TerminalEcho ---- */}
        <section
          aria-label="3D 集群拓扑视口"
          className={cn(
            'relative min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/40 lg:basis-[65%] lg:grow-0 lg:shrink-0',
            // 移动端：copilot 视图时隐藏左栏（常驻 DOM，不卸载画布）
            mobileView === 'copilot' && 'hidden lg:block',
          )}
        >
          {/* 视口槽位：后续轮次注入 dynamic(ssr:false) R3F Canvas */}
          {viewport ?? <ViewportPlaceholder />}

          {/* ---- 混沌演练态势氛围光（审查报告 §2.4.2）----
              值班人员余光扫一眼就该知道集群处于故障演练态，而不是
              必须先读到顶部的红色胶囊。这里用一层极克制的内阴影暗角：
              透明度 6-8%、pointer-events-none 不拦截任何交互、
              与画布同层但覆盖其上，营造"整块屏幕被警示色浸染"的氛围。 */}
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

          {/* 事件流终端：绝对定位于视口底部，右侧避让相机工具条（z-20）
              —— right-[74px] = 工具条右距 12 + 宽 50 + 间隙 12，
              两者在右下角不再重叠，terminal 的 clear 按钮与日志区完整可点 */}
          <TerminalEcho className="absolute bottom-3 left-3 right-[74px]" />

          {/* 性能遥测 HUD 已迁出本组件：由 page.tsx 通过 next/dynamic
              懒加载 PerfTelemetryHUD 挂载（按需载入，首屏零开销）。
              此处仅保留 Shift+P 的开关状态（isPerfHudOpen），
              键盘监听仍在下方 useEffect 中维护。 */}
        </section>

        {/* ---- 右栏：AI 抽屉槽位（35%） ---- *
         * 【视觉契约修复】此前该 <section> 没有任何边框/圆角/背景，
         * 外部传入的 drawer 直接裸渲染，与左侧带描边的 3D 视口并排时
         * 出现明显的视觉割裂（左侧是"面板"，右侧是"黑洞"）。
         * 现在把 .kv-panel 容器下沉到这一层，左右两栏材质完全对称。
         */}
        <section
          aria-label="AI Copilot 抽屉"
          className={cn(
            'kv-panel min-h-0 flex-1 overflow-hidden rounded-lg lg:basis-[35%] lg:grow-0 lg:shrink-0',
            // 移动端：topology 视图时隐藏右栏
            mobileView === 'topology' && 'hidden lg:block',
          )}
        >
          {drawer ?? (
            <RightDrawerSlot activeTab={activeRightTab} onTabChange={setActiveRightTab}>
              <DrawerPlaceholder tab={activeRightTab} />
            </RightDrawerSlot>
          )}
        </section>
      </main>

      {/* ============ 移动端底部浮动切换栏（< lg 可见） ============ */}
      <MobileViewSwitcher view={mobileView} onChange={setMobileView} />

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

/* ========================================================================== */
/* 占位内容（后续轮次被真实槽位内容替换）                                          */
/* ========================================================================== */

/** ViewportPlaceholder —— 3D 视口占位（深空网格 + 接入预告） */
function ViewportPlaceholder() {
  return (
    <div className="bg-cyber-grid pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="pointer-events-none flex flex-col items-center gap-2 text-center">
        <TerminalSquare className="h-8 w-8 text-slate-700" aria-hidden />
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-slate-600">
          3d viewport slot
        </p>
        <p className="max-w-xs text-[11px] leading-relaxed text-slate-700">
          R3F Canvas（next/dynamic · ssr:false）将于下一轮接入此槽位
        </p>
      </div>
    </div>
  );
}

/** DrawerPlaceholder —— 抽屉正文占位（按页签展示接入预告） */
function DrawerPlaceholder({ tab }: { readonly tab: RightPanelTab }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {tab === 'copilot' ? <Bot className="h-8 w-8 text-slate-700" aria-hidden /> : <ShieldCheck className="h-8 w-8 text-slate-700" aria-hidden />}
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-slate-600">
        {tab === 'copilot' ? 'sre copilot slot' : 'edge auditor slot'}
      </p>
      <p className="max-w-[240px] text-[11px] leading-relaxed text-slate-700">
        {tab === 'copilot'
          ? 'NDJSON 流式对话 + 生成式 UI 卡片将于后续轮次接入'
          : 'Transformers.js 端侧日志审计台将于后续轮次接入'}
      </p>
    </div>
  );
}
