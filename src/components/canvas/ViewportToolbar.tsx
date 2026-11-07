'use client';

/**
 * KubeVision AI — 3D 视口相机/多模态控制工具条（ViewportToolbar）
 *
 * 【渲染位置契约】挂载于 ClusterCanvas 的 DOM 包装层（普通 React 子树，
 * **非 R3F 场景内部**）：HTML 按钮无 WebGL 射线拾取需求，放 DOM 层可避免
 * drei <Html> 的层级/射线安全约束，且事件语义与外层 ShellLayout UI 完全一致。
 *
 * 【层级契约】外层容器 pointer-events-auto + z-20：
 * - 高于画布内 drei <Html> 机架铭牌（zIndexRange=[10,0]）；
 * - 低于 PerfHUD（z-40）与顶层 Modal（z-50）；
 * - pointer-events-auto 恢复指针交互（画布悬浮层默认穿透，
 *   与 TerminalEcho 同一契约）。
 *
 * 【玻璃态视觉】bg-slate-900/75 + backdrop-blur-md + border-slate-800
 * （AGENTS.md 第 5 条面板规范），激活态按钮以主题青色辉光强调。
 */

import { Camera, Globe2, Map, Rotate3d } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/utils/cn';
import type { ViewportToolbarProps } from '@/types/layout';

/**
 * ToolbarButton —— 工具条单按钮（图标 + 悬浮 tooltip + 激活态辉光）。
 *
 * 竖排紧凑布局下文案以 title 属性承载（悬浮原生 tooltip），
 * aria-label 保证读屏可达；active 态复用主题青色辉光令牌。
 */
interface ToolbarButtonProps {
  readonly label: string;
  readonly active?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function ToolbarButton({ label, active = false, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-md border transition-all duration-150 active:scale-90',
        active
          ? 'border-cyan-400/60 bg-cyan-400/15 text-cyan-300 shadow-glow-cyan'
          : 'border-slate-700/70 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:text-slate-200',
      )}
    >
      {children}
    </button>
  );
}

/**
 * ViewportToolbar —— 右下角悬浮玻璃态工具条（竖排 4 按钮）。
 *
 * 【按钮语义】
 * 1. 全景鸟瞰（Globe2）：广播 'overview' 预设，复位到 [0,14,22] 环形全览；
 * 2. 俯视拓扑（Map）：广播 'topdown' 预设，近垂直俯视三机架槽位阵列；
 * 3. 环绕巡检（Rotate3d）：切换 autoRotate 自动旋转（激活态持续辉光）；
 * 4. 多模态快照诊断（Camera）：截取当前 3D 帧 → setCapturedViewport →
 *    triggerQuickPrompt 自动唤醒右侧 Copilot（移动端联动切视图）。
 *
 * 前两个预设按钮的高亮互斥（isOverviewActive / isTopDownActive 由父层
 * 跟踪最近一次飞行指令），巡检与快照按钮独立（巡检为开关态、快照带就绪角标）。
 */
export default function ViewportToolbar({
  isOverviewActive,
  isTopDownActive,
  isPatrolActive,
  hasCapturedViewport,
  onOverview,
  onTopDown,
  onTogglePatrol,
  onCaptureDiagnose,
}: ViewportToolbarProps) {
  return (
    <div
      className="pointer-events-auto absolute bottom-3 right-3 z-20 flex flex-col gap-1.5 rounded-lg border border-slate-800 bg-slate-900/75 p-1.5 shadow-panel backdrop-blur-md"
      role="toolbar"
      aria-label="3D 视口相机与多模态控制"
    >
      <ToolbarButton label="全景鸟瞰（复位视角）" active={isOverviewActive} onClick={onOverview}>
        <Globe2 className="h-4 w-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton label="俯视拓扑（垂直俯瞰）" active={isTopDownActive} onClick={onTopDown}>
        <Map className="h-4 w-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label={isPatrolActive ? '环绕巡检：点击停止自动旋转' : '环绕巡检：点击开启自动旋转'}
        active={isPatrolActive}
        onClick={onTogglePatrol}
      >
        <Rotate3d className={cn('h-4 w-4', isPatrolActive && 'animate-spin [animation-duration:3s]')} aria-hidden />
      </ToolbarButton>
      {/* 快照按钮：独立视觉——品红渐变强调「多模态诊断」的特殊性，
          已有截图时右上角显示就绪小圆点 */}
      <button
        type="button"
        onClick={onCaptureDiagnose}
        aria-label="3D 视口多模态快照诊断"
        title="截取当前 3D 帧并唤醒 AI Copilot 执行多模态空间异常联合诊断"
        className="relative flex h-9 w-9 items-center justify-center rounded-md border border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300 transition-all duration-150 hover:border-fuchsia-400 hover:bg-fuchsia-500/20 hover:shadow-[0_0_12px_0_rgba(217,70,239,0.45)] active:scale-90"
      >
        <Camera className="h-4 w-4" aria-hidden />
        {hasCapturedViewport ? (
          <span
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-glow-emerald"
            aria-label="快照已就绪"
          />
        ) : null}
      </button>
    </div>
  );
}
