/**
 * KubeVision AI — 3D / UI 统一色板单一事实源（L10）
 *
 * 【为什么需要它】
 * 同一套运维语义色此前散落在 3D 组件与 UI 组件里：3D 用的是"为黑底提亮"
 * 的变体（#10b981 / #ff3b6b / #f59e0b），UI 用的是 Tailwind 语义色
 * （emerald-400 / rose-500 / amber-400 / cyan-400）。两边各自演化，
 * 结果是同一个「健康」在 HUD 是 emerald-400、在机柜是 #10b981，
 * 截图里出现两套互不相同的绿——评委看到的"颜色语言"不统一。
 *
 * 【本模块的定位】只做 **token 扩展**：给出 hex / THREE.Color / 自发光倍率 /
 * CSS 变量名四件套，供 3D 与 UI 引用。**不删除** AGENTS.md 第 5 条既有色板
 * （emerald/amber/rose/cyan 仍是对外语义色），只是把 3D 的"提亮变体"收编为
 * 这些语义色的派生 token。
 *
 * 【为何不在本模块直接 new THREE.Color 到顶层并共享可变对象】
 * THREE.Color 是可变对象；被多处引用后任何一处原地修改都会污染全局。
 * 这里每项保留独立的 `color` 实例，并约定 **只读使用**（渲染层需要可变副本时
 * 自行 `.clone()`）。
 */

import { Color } from 'three';

/** 一个语义色 token */
export interface PaletteToken {
  /** token 名（调试/文档用） */
  readonly name: string;
  /** sRGB hex（CSS 与 3D 共用同一真值） */
  readonly hex: string;
  /** 对应的 Tailwind 语义名（UI 侧对照） */
  readonly tailwind: string;
  /** 只读 THREE.Color 实例（渲染层需要修改时请 clone） */
  readonly color: Color;
  /** 自发光/加色混合倍率（HDR 输出 = color * multiplier） */
  readonly emitterMultiplier: number;
  /** 对应 CSS 变量名（DOM 浮层用 var() 引用） */
  readonly cssVar: string;
}

/**
 * PALETTE —— 语义色单一事实源。
 *
 * 只覆盖 4 类状态 + 主题色；其余装饰色（网格青、装甲灰等）不进 token，
 * 避免把"设计调参"和"语义契约"混在一起。
 */
export const PALETTE = {
  /** Pod/节点健康态 —— UI emerald-400 */
  healthy: {
    name: 'healthy',
    hex: '#34d399',
    tailwind: 'emerald-400',
    color: new Color('#34d399'),
    emitterMultiplier: 1.25,
    cssVar: '--kv-color-healthy',
  },
  /** 故障/崩溃/分区 —— UI rose-500 */
  critical: {
    name: 'critical',
    hex: '#f43f5e',
    tailwind: 'rose-500',
    color: new Color('#f43f5e'),
    emitterMultiplier: 1.5,
    cssVar: '--kv-color-critical',
  },
  /** 高负载/过渡态 —— UI amber-400 */
  elevated: {
    name: 'elevated',
    hex: '#fbbf24',
    tailwind: 'amber-400',
    color: new Color('#fbbf24'),
    emitterMultiplier: 1.35,
    cssVar: '--kv-color-elevated',
  },
  /** 主题/选中/数据流 —— UI cyan-400 */
  theme: {
    name: 'theme',
    hex: '#22d3ee',
    tailwind: 'cyan-400',
    color: new Color('#22d3ee'),
    emitterMultiplier: 1.45,
    cssVar: '--kv-color-theme',
  },
} as const satisfies Readonly<Record<string, PaletteToken>>;

/** token 名联合类型 */
export type PaletteName = keyof typeof PALETTE;

/**
 * paletteOf —— 按名取 token。
 *
 * @param name token 名
 * @returns 对应 token
 */
export function paletteOf(name: PaletteName): PaletteToken {
  return PALETTE[name];
}

/**
 * getPaletteCssDeclarations —— 生成 CSS 变量声明块（根节点注入用）。
 *
 * 【用途】DOM 浮层（HUD/图例）与 3D 共享同一色值时，让 CSS 直接引用
 * `var(--kv-color-healthy)`，色板调整只需改本文件一处。
 *
 * @returns 形如 `{ '--kv-color-healthy': '#34d399', ... }`
 */
export function getPaletteCssDeclarations(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of Object.values(PALETTE)) {
    out[token.cssVar] = token.hex;
  }
  return out;
}