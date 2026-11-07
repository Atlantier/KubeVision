/**
 * KubeVision AI — 全息 HUD 视觉原语（HoloHud）
 *
 * 【解决什么问题】场景里有四处 drei `<Html>` 铭牌（机架贴地铭牌、控制平面铭牌、
 * Pod 悬停探针卡、巡检 HUD 卡片）。此前它们各写各的样式：有的只有一行字、
 * 有的是圆角黑底胶囊，彼此语言不统一，观感上"没有一个统一的 HUD 系统"。
 *
 * 本文件把「四角战术折角框 + 扫描线底纹 + 微型发光进度条」抽成可复用原语，
 * 四处铭牌只负责填内容，样式天然一致——这是让 3D 场景读起来像
 * "一套军用级数字孪生大屏"而不是"几个各写各的气泡"的关键。
 *
 * 【为什么放在 canvas 目录】这些都是纯 DOM 组件（drei Html 的内容层），
 * 与 3D 场景共存于同一个视觉体系；放在 canvas 下便于与铭牌同处一处维护。
 *
 * 【约束】全部为纯展示组件，不接受任何指针事件；
 * 外层 `<Html>` 仍由调用方负责 `zIndexRange={[10,0]}` + `pointer-events-none`。
 */

import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/utils/cn';

/* ========================================================================== */
/* 四角战术折角框                                                              */
/* ========================================================================== */

/** 折角边长（px）——4px 是"精密仪表"与"装饰花边"的分界：再长就变成装饰框 */
const CORNER_SIZE_PX = 4;

/**
 * HoloCorners —— 四角 L 形高光折角。
 *
 * 【设计意图】军用 HUD 的框不是闭合圆角矩形，而是四个直角折角：
 * 它暗示"这个区域被系统锁定/标定"，同时视觉重量集中在四角而非整条边框，
 * 不会把内容压成一块牌匾。
 */
export function HoloCorners({ color = '#22d3ee' }: { readonly color?: string }): ReactNode {
  const base = 'pointer-events-none absolute h-[4px] w-[4px] border-current';
  return (
    <>
      <span
        aria-hidden
        className={cn(base, 'left-0 top-0 border-l border-t')}
        style={{ color, width: CORNER_SIZE_PX, height: CORNER_SIZE_PX }}
      />
      <span
        aria-hidden
        className={cn(base, 'right-0 top-0 border-r border-t')}
        style={{ color, width: CORNER_SIZE_PX, height: CORNER_SIZE_PX }}
      />
      <span
        aria-hidden
        className={cn(base, 'bottom-0 left-0 border-b border-l')}
        style={{ color, width: CORNER_SIZE_PX, height: CORNER_SIZE_PX }}
      />
      <span
        aria-hidden
        className={cn(base, 'bottom-0 right-0 border-b border-r')}
        style={{ color, width: CORNER_SIZE_PX, height: CORNER_SIZE_PX }}
      />
    </>
  );
}

/**
 * HoloScanlines —— 极细横向扫描线底纹。
 *
 * 【为什么用 repeating-linear-gradient】图片纹理需要额外请求与解码；
 * CSS 重复渐变在 GPU 上合成，零网络成本，且线距可精确控制。
 * 线距 3px、线宽 1px、透明度 0.045 —— 足够在近景看出"CRT 扫描感"，
 * 又不会在中远景把文字糊成灰底。
 */
export function HoloScanlines(): ReactNode {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 opacity-[0.045]"
      style={{
        backgroundImage:
          'repeating-linear-gradient(0deg, rgba(226,232,240,0.9) 0px, rgba(226,232,240,0.9) 1px, transparent 1px, transparent 3px)',
      }}
    />
  );
}

/* ========================================================================== */
/* 微型发光进度条                                                              */
/* ========================================================================== */

/** 进度槽宽度与高度（px）：44×3 是铭牌尺度下"可读但不喧宾"的黄金尺寸 */
const BAR_WIDTH_PX = 44;
const BAR_HEIGHT_PX = 3;

/**
 * 按数值取状态色（与全局告警阈值同源）。
 *
 * @param value 使用率百分比 [0,100]
 * @returns 现值对应的高亮色
 */
function resolveTone(value: number): string {
  if (value >= 85) return '#f43f5e';
  if (value >= 70) return '#fbbf24';
  return '#10b981';
}

/**
 * MiniBar —— 「标签 + 数值 + 微型发光进度槽」三件套。
 *
 * 【视觉要点】
 * - 进度槽本身是极暗底槽（`bg-white/[0.06]`），填充条才有"发光"对比；
 * - 填充条叠加一层同色 box-shadow：小尺寸下这是唯一能表现"自发光"的手段，
 *   没有它，3px 的条看起来只是一段彩色矩形而非光带；
 * - 数值用 `tabular-nums` 等宽，避免 12%→100% 时宽度跳动导致整行抖动。
 */
export function MiniBar({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  /** 覆盖默认阈值取色（例如 MEM 恒为青蓝） */
  readonly tone?: string;
}): ReactNode {
  const clamped = Math.min(100, Math.max(0, value));
  const color = tone ?? resolveTone(clamped);
  const fillStyle: CSSProperties = {
    width: `${clamped}%`,
    backgroundColor: color,
    boxShadow: `0 0 4px ${color}`,
  };
  return (
    <span className="flex items-center gap-1">
      <span className="font-mono text-[8px] uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      <span className="w-[22px] text-right font-mono text-[9px] font-bold tabular-nums" style={{ color }}>
        {Math.round(clamped)}%
      </span>
      <span
        aria-hidden
        className="pointer-events-none relative overflow-hidden rounded-full bg-white/[0.06]"
        style={{ width: BAR_WIDTH_PX, height: BAR_HEIGHT_PX }}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
          style={fillStyle}
        />
      </span>
    </span>
  );
}

/* ========================================================================== */
/* 铭牌外壳                                                                    */
/* ========================================================================== */

/**
 * HoloFrame —— 全息铭牌外壳（毛玻璃 + 折角 + 扫描线 + 可选呼吸边光）。
 *
 * @param accent 主题色（决定折角颜色与外发光）
 * @param glow   是否叠加外发光（机架铭牌用 true，探针卡用 false 以免抢内容）
 */
export function HoloFrame({
  children,
  accent = '#22d3ee',
  glow = false,
  className,
}: {
  readonly children: ReactNode;
  readonly accent?: string;
  readonly glow?: boolean;
  readonly className?: string;
}): ReactNode {
  return (
    <div
      className={cn(
        'pointer-events-none relative overflow-hidden px-2 py-1',
        /* 深空半透明毛玻璃：不写死边框，靠四角折角与底纹表达结构 */
        'bg-slate-950/85 backdrop-blur-md',
        className,
      )}
      style={glow ? { boxShadow: `0 0 10px ${accent}33` } : undefined}
    >
      <HoloScanlines />
      <HoloCorners color={accent} />
      <div className="relative">{children}</div>
    </div>
  );
}