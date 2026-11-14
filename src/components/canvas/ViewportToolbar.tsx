'use client';

/**
 * KubeVision AI — 3D 视口相机/多模态控制工具条（ViewportToolbar）
 *
 * 【R7 增强特性】
 * 1. 视角预设按钮在相机飞行期间展示 `aria-busy="true"` 与 SVG 细环形进度指示器
 *    （60FPS 进度经 `cameraFlightBus` + SVG `<circle>` DOM ref 直写，零重渲染）；
 * 2. 响应系统 `prefers-reduced-motion: reduce`：自动巡检按钮置灰禁用并显式标注原因。
 */

import { Camera, Globe2, Layers, Map, Rotate3d } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { isReducedMotion, subscribeReducedMotion } from '@/constants/motion';
import { Z_CLASS } from '@/constants/zIndex';
import type { ViewPresetKey } from '@/types/canvas';
import type { ViewportToolbarProps } from '@/types/layout';
import {
  getFlightStatus,
  subscribeFlightProgress,
  subscribeFlightStatus,
  type CameraFlightStatus,
} from '@/utils/cameraFlightBus';
import { cn } from '@/utils/cn';

const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const REDUCED_MOTION_PATROL_REASON =
  '已开启系统“减少动效”（prefers-reduced-motion），自动环绕巡检已暂停';

interface ToolbarButtonProps {
  readonly label: string;
  readonly title?: string;
  readonly active?: boolean;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly onClick: () => void;
  readonly progressCircleRef?: { current: SVGCircleElement | null };
  readonly children: ReactNode;
}

function ToolbarButton({
  label,
  title,
  active = false,
  busy = false,
  disabled = false,
  disabledReason,
  onClick,
  progressCircleRef,
  children,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      aria-busy={busy || undefined}
      title={title ?? label}
      data-disabled-reason={disabled && disabledReason ? disabledReason : undefined}
      className={cn(
        'relative flex h-11 w-11 items-center justify-center rounded-md border transition-all duration-150 md:h-9 md:w-9',
        disabled
          ? 'cursor-not-allowed border-white/[0.06] bg-slate-900/60 text-slate-400 opacity-60'
          : active
            ? 'border-cyan-400/60 bg-cyan-400/[0.15] text-cyan-300 shadow-glow-cyan active:scale-90'
            : 'border-white/[0.05] bg-slate-800/50 text-slate-400 hover:border-white/[0.07] hover:text-slate-200 active:scale-90',
      )}
    >
      {busy ? (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
          viewBox="0 0 36 36"
          aria-hidden="true"
        >
          <circle
            cx="18"
            cy="18"
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(34, 211, 238, 0.16)"
            strokeWidth="1.5"
          />
          <circle
            ref={progressCircleRef}
            cx="18"
            cy="18"
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(34, 211, 238, 0.72)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE}
          />
        </svg>
      ) : null}
      {children}
      {disabled && disabledReason ? (
        <span
          className="pointer-events-none absolute -left-1 -top-1 rounded border border-amber-400/40 bg-slate-950/90 px-1 font-mono text-[10px] leading-none text-amber-300"
          aria-hidden="true"
        >
          停
        </span>
      ) : null}
    </button>
  );
}

export default function ViewportToolbar({
  isOverviewActive,
  isTopDownActive,
  isPatrolActive,
  hasCapturedViewport,
  onOverview,
  onTopDown,
  onTogglePatrol,
  onCaptureDiagnose,
  is2DMode = false,
  onToggle2DMode,
}: ViewportToolbarProps) {
  const [flightStatus, setFlightStatus] = useState<CameraFlightStatus>(() => getFlightStatus());
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => isReducedMotion());

  const overviewRingRef = useRef<SVGCircleElement | null>(null);
  const topDownRingRef = useRef<SVGCircleElement | null>(null);

  useEffect(() => {
    setReducedMotion(isReducedMotion());
    const unsubMotion = subscribeReducedMotion(setReducedMotion);
    const unsubStatus = subscribeFlightStatus(setFlightStatus);
    const unsubProgress = subscribeFlightProgress((progress, status) => {
      const targetPreset: ViewPresetKey | null = status.isFlying ? status.activePreset : null;
      const offset = RING_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, progress)));
      if (overviewRingRef.current !== null && targetPreset === 'overview') {
        overviewRingRef.current.style.strokeDashoffset = `${offset.toFixed(2)}`;
      }
      if (topDownRingRef.current !== null && targetPreset === 'topdown') {
        topDownRingRef.current.style.strokeDashoffset = `${offset.toFixed(2)}`;
      }
    });

    return () => {
      unsubMotion();
      unsubStatus();
      unsubProgress();
    };
  }, []);

  const isFlyingOverview = flightStatus.isFlying && flightStatus.activePreset === 'overview';
  const isFlyingTopDown = flightStatus.isFlying && flightStatus.activePreset === 'topdown';
  const effectivePatrolActive = !reducedMotion && isPatrolActive;

  return (
    <div
      className={cn(
        'pointer-events-auto absolute bottom-[4.75rem] right-3 flex flex-col gap-1.5 rounded-lg border border-white/[0.07] bg-slate-900/75 p-1.5 shadow-panel lg:bottom-3',
        Z_CLASS.CANVAS_FLOATING,
      )}
      role="toolbar"
      aria-label="3D 视口相机与多模态控制"
    >
      <ToolbarButton
        label="全景鸟瞰（复位视角）"
        active={isOverviewActive}
        busy={isFlyingOverview}
        progressCircleRef={overviewRingRef}
        onClick={onOverview}
      >
        <Globe2 className="h-4 w-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="俯视拓扑（垂直俯瞰）"
        active={isTopDownActive}
        busy={isFlyingTopDown}
        progressCircleRef={topDownRingRef}
        onClick={onTopDown}
      >
        <Map className="h-4 w-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label={
          reducedMotion
            ? REDUCED_MOTION_PATROL_REASON
            : effectivePatrolActive
              ? '环绕巡检：点击停止自动旋转'
              : '环绕巡检：点击开启自动旋转'
        }
        title={reducedMotion ? REDUCED_MOTION_PATROL_REASON : undefined}
        active={effectivePatrolActive}
        disabled={reducedMotion}
        disabledReason={reducedMotion ? 'reduced-motion' : undefined}
        onClick={onTogglePatrol}
      >
        <Rotate3d
          className={cn(
            'h-4 w-4',
            effectivePatrolActive && 'animate-spin [animation-duration:3s]',
          )}
          aria-hidden
        />
      </ToolbarButton>
      <button
        type="button"
        onClick={onCaptureDiagnose}
        aria-label="3D 视口多模态快照诊断"
        title="截取当前 3D 帧并唤醒 AI 运维副驾执行多模态空间异常联合诊断"
        className="relative flex h-11 w-11 items-center justify-center rounded-md border border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300 transition-all duration-150 hover:border-fuchsia-400 hover:bg-fuchsia-500/20 hover:shadow-[0_0_12px_0_rgba(217,70,239,0.45)] active:scale-90 md:h-9 md:w-9"
      >
        <Camera className="h-4 w-4" aria-hidden />
        {hasCapturedViewport ? (
          <span
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-glow-emerald"
            aria-label="快照已就绪"
          />
        ) : null}
      </button>
      {onToggle2DMode ? (
        <ToolbarButton
          label={is2DMode ? '切回 3D WebGL 拓扑' : '切换至 2D SVG 兼容拓扑'}
          active={is2DMode}
          onClick={onToggle2DMode}
        >
          <Layers className="h-4 w-4" aria-hidden />
        </ToolbarButton>
      ) : null}
    </div>
  );
}
