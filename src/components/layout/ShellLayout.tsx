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
import { Blocks, Bot, Layers, ShieldCheck, TerminalSquare } from 'lucide-react';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import type { ChaosScenario } from '@/types/cluster';
import type { RightPanelTab } from '@/types/store';
import type {
  ChaosScenarioOption,
  MobileViewKey,
  PerfHudSample,
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

/** 混沌控制台场景选项表（含中文释义，注入即 setActiveChaos(场景)） */
const CHAOS_SCENARIO_OPTIONS: readonly ChaosScenarioOption[] = [
  {
    scenario: 'POD_OOM_SWARM',
    label: 'Pod OOM 风暴',
    description: '业务区 Pod 批量内存溢出击杀（OOMKilled 蔓延 + P0 告警风暴）',
  },
  {
    scenario: 'NODE_CPU_SPIKE',
    label: '节点 CPU 尖峰',
    description: '单节点 CPU 水位飙升越限（HighLoad 蔓延 + 全局 QPS 抖动）',
  },
  {
    scenario: 'NET_PACKET_LOSS',
    label: '网络丢包分区',
    description: '机架间网络丢包失联（NetworkPartition 脑裂渲染 + 遥测延迟上升）',
  },
];

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

/* ========================================================================== */
/* 子组件：性能监控 HUD（浮层，z-40，低于顶层 Modal 的 z-50）                    */
/* ========================================================================== */

/**
 * PerfHudPanel —— 性能监控 HUD 浮层。
 *
 * 【数据流】4Hz 定时采样 telemetryTransientRef.glStats（瞬态轨，渲染循环写入）
 * + snapshotSummary 实体计数（响应轨），合并为 PerfHudSample 进本地 state。
 * 采样器仅在 HUD 开启时运行（关闭即零后台开销）；组件卸载清理定时器。
 */
function PerfHudPanel() {
  const [sample, setSample] = useState<PerfHudSample | null>(null);
  const snapshotSummary = useClusterStore((s) => s.snapshotSummary);

  useEffect(() => {
    const timer = setInterval((): void => {
      const stats = telemetryTransientRef.glStats;
      setSample({
        fps: stats.fps,
        frameTimeMs: stats.frameTimeMs,
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        sseLatencyMs: stats.sseLatencyMs,
        workerStatus: stats.workerStatus,
        podCount: snapshotSummary.pods.length,
        nodeCount: snapshotSummary.nodes.length,
        alertCount: snapshotSummary.activeAlerts.length,
      });
    }, PERF_HUD_SAMPLE_INTERVAL_MS);
    return (): void => clearInterval(timer);
  }, [snapshotSummary]);

  const rows: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
    { label: 'FPS', value: sample !== null && sample.fps > 0 ? sample.fps.toFixed(0) : '--' },
    {
      label: 'Frame',
      value: sample !== null && sample.frameTimeMs > 0 ? `${sample.frameTimeMs.toFixed(1)} ms` : '--',
    },
    { label: 'Draw Calls', value: sample !== null ? String(sample.drawCalls) : '--' },
    {
      label: 'Triangles',
      value: sample !== null && sample.triangles > 0 ? sample.triangles.toLocaleString('en-US') : '--',
    },
    {
      /* 标签语义：本指标测量的是「相邻两帧的到达间隔」（理想 1000ms），
         而非网络 RTT——SSE 帧未携带服务端发送时间戳，无法算真 RTT。
         如实标注为 Frame Interval 而非误导性的 Latency。 */
      label: 'Frame Interval',
      value: sample !== null && sample.sseLatencyMs > 0 ? `${sample.sseLatencyMs.toFixed(0)} ms` : '--',
    },
    { label: 'Sim Worker', value: sample !== null ? sample.workerStatus : '--' },
    {
      label: 'Entities',
      value: sample !== null ? `${sample.nodeCount} nodes / ${sample.podCount} pods / ${sample.alertCount} alerts` : '--',
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18 }}
      className="kv-panel pointer-events-auto absolute right-3 top-16 z-40 w-60 p-3"
      aria-label="性能监控 HUD"
    >
      <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-400">
        perf&nbsp;hud · {PERF_HUD_SAMPLE_HZ}hz
      </p>
      <dl className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-2">
            <dt className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{row.label}</dt>
            <dd className="font-mono text-[11px] tabular-nums text-slate-200">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 border-t border-slate-800 pt-1.5 font-mono text-[9px] text-slate-600">
        数据源：telemetryTransientRef.glStats（瞬态轨，零重渲染采样）
      </p>
    </motion.div>
  );
}

/* ========================================================================== */
/* 子组件：混沌工程控制台模态框（z-50 顶层）                                     */
/* ========================================================================== */

/**
 * ChaosConsoleModal —— 混沌注入控制台（Inject Chaos 战术按钮的落点）。
 *
 * 【层级契约】z-50 顶层 Modal（AGENTS.md 第 6 条：严禁被画布内 drei <Html>
 * 遮挡，后者 zIndexRange=[10,0]）；backdrop 半透明近黑 + 面板弹性入场；
 * Escape 键与背景点击均可关闭；选择场景即 setActiveChaos(场景) 并关闭。
 */
function ChaosConsoleModal() {
  const setActiveChaos = useClusterStore((s): ((scenario: ChaosScenario) => void) => s.setActiveChaos);
  const setChaosModalOpen = useClusterStore((s): ((open: boolean) => void) => s.setChaosModalOpen);

  /* Escape 关闭（模态框开启期间挂载监听，关闭即卸载） */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setChaosModalOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [setChaosModalOpen]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="混沌工程控制台">
      {/* 背景遮罩（点击关闭） */}
      <button
        type="button"
        aria-label="关闭混沌控制台"
        className="absolute inset-0 cursor-default bg-slate-950/70 backdrop-blur-sm"
        onClick={(): void => setChaosModalOpen(false)}
      />
      {/* 控制台面板 */}
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 12 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        className="kv-panel pointer-events-auto relative w-full max-w-lg p-5 shadow-glow-rose"
      >
        <div className="mb-4 flex items-center gap-2">
          <Blocks className="h-4 w-4 text-rose-400" aria-hidden />
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.25em] text-rose-300">
            chaos&nbsp;engineering&nbsp;console
          </h2>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-slate-400">
          选择故障注入场景，模拟引擎将演算受影响实体并推送异常遥测；
          顶栏出现 CHAOS ACTIVE 横幅后可一键终止，或在自愈闭环中执行修复动作自动复位。
        </p>
        <div className="space-y-2">
          {CHAOS_SCENARIO_OPTIONS.map((option) => (
            <button
              key={option.scenario}
              type="button"
              onClick={(): void => {
                setActiveChaos(option.scenario);
                setChaosModalOpen(false);
              }}
              className="group flex w-full items-start gap-3 rounded-md border border-slate-800 bg-slate-900/60 p-3 text-left transition-all duration-150 hover:border-rose-500/50 hover:bg-rose-500/10 active:scale-[0.99]"
            >
              <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-rose-500 shadow-glow-rose transition-transform group-hover:scale-125" aria-hidden />
              <span className="min-w-0">
                <span className="block font-mono text-[11px] font-bold tracking-wider text-slate-200 group-hover:text-rose-200">
                  {option.scenario} · {option.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{option.description}</span>
              </span>
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

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
  const isPerfHudOpen = useClusterStore((s): boolean => s.isPerfHudOpen);
  const isChaosModalOpen = useClusterStore((s): boolean => s.isChaosModalOpen);
  const activeRightTab = useClusterStore((s): RightPanelTab => s.activeRightTab);
  const setPerfHudOpen = useClusterStore((s): ((open: boolean) => void) => s.setPerfHudOpen);
  const setActiveRightTab = useClusterStore((s): ((tab: RightPanelTab) => void) => s.setActiveRightTab);

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

      {/* ============ 主体：桌面双栏 65/35 · 移动上下分栏 ============ */}
      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2 lg:flex-row lg:gap-3 lg:p-3">
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

          {/* 事件流终端：绝对定位于视口底部，右侧避让相机工具条（z-20）
              —— right-[74px] = 工具条右距 12 + 宽 50 + 间隙 12，
              两者在右下角不再重叠，terminal 的 clear 按钮与日志区完整可点 */}
          <TerminalEcho className="absolute bottom-3 left-3 right-[74px]" />

          {/* 性能 HUD：悬浮于视口右上（z-40） */}
          <AnimatePresence>{isPerfHudOpen ? <PerfHudPanel /> : null}</AnimatePresence>
        </section>

        {/* ---- 右栏：AI 抽屉槽位（35%） ---- */}
        <section
          aria-label="AI Copilot 抽屉"
          className={cn(
            'min-h-0 flex-1 lg:basis-[35%] lg:grow-0 lg:shrink-0',
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

      {/* ============ 顶层：混沌控制台 Modal（z-50） ============ */}
      <AnimatePresence>{isChaosModalOpen ? <ChaosConsoleModal /> : null}</AnimatePresence>
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
