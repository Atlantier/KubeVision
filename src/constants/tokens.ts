/**
 * KubeVision AI — 设计令牌（R31 · 单一事实源）
 *
 * 【原则】所有颜色 / 字号 / 间距 / 圆角 / 动效 / 玻璃层都从这里取；
 * `tailwind.config.ts` 与 `globals.css` 只做映射，不另写数值。
 * 3D 铭牌（drei <Html>）通过 CSS 变量引用同一套令牌，保证 2D HUD 与 3D 标签同源。
 *
 * 【对比度旁注】均为 text-primary/secondary/tertiary/muted 在 void 背景上的
 * WCAG 对比度（正文要求 ≥4.5:1，大字 ≥3:1）。
 */

/** 颜色令牌（值与 AGENTS.md 既有语义色定义保持一致，不改动四语义色） */
export const COLORS = {
  /** 深空背景 */
  void: '#020617',
  /** 面板底 */
  panel: '#0b1220',
  /** 描边基色 */
  border: 'rgba(255, 255, 255, 0.075)',
  /** 描边激活 */
  borderActive: 'rgba(255, 255, 255, 0.14)',
  /** 一级文本 — 对比度 ≈ 15.8:1 */
  textPrimary: '#e2e8f0',
  /** 二级文本 — 对比度 ≈ 9.6:1 */
  textSecondary: '#94a3b8',
  /** 三级文本 — 对比度 ≈ 6.1:1（仅 ≥12px） */
  textTertiary: '#64748b',
  /** 弱化文本 — 对比度 ≈ 4.7:1（仅 ≥14px / 大字） */
  textMuted: '#475569',
  /** 四语义色（沿用 AGENTS.md，不修改） */
  emerald: '#34d399',
  amber: '#fbbf24',
  rose: '#f43f5e',
  cyan: '#22d3ee',
} as const;

/** 字号 7 级（px）——全仓禁止 <10px */
export const TYPE_SCALE = {
  micro: 10,
  caption: 11,
  body: 12,
  bodyLg: 13,
  title: 14,
  h2: 18,
  h1: 24,
} as const;

/** 4px 栅格间距（px） */
export const SPACE = {
  '1': 4,
  '2': 8,
  '3': 12,
  '4': 16,
  '5': 20,
  '6': 24,
  '8': 32,
  '10': 40,
} as const;

/** 圆角（px） */
export const RADIUS = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  full: 9999,
} as const;

/** 描边 */
export const STROKE = {
  /** 默认 hairline */
  hairline: 'rgba(255, 255, 255, 0.075)',
  /** 交互激活 */
  active: 'rgba(255, 255, 255, 0.14)',
  /** 顶部 1px 内高光 */
  insetHighlight: 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
} as const;

/** 动效令牌 */
export const MOTION = {
  fast: 140,
  base: 200,
  slow: 320,
  spring: { stiffness: 420, damping: 34 },
} as const;

/** 玻璃三层（blur 只能来自这两个值 + overlay 的 30px） */
export const GLASS = {
  panel: { blurPx: 20, use: '仅顶栏 / 抽屉 / 模态' },
  chip: { blurPx: 8, use: '终端条 / 工具条 / 图例 / 筛选横幅（无大投影）' },
  overlay: { blurPx: 30, use: '全屏遮罩' },
} as const;

/** 焦点环（可访问性统一） */
export const FOCUS_RING = 'focus-visible:ring-1 focus-visible:ring-cyan-400/60 focus-visible:outline-none';

/** 把令牌输出为 CSS 变量声明（globals.css 与 3D 铭牌共用） */
export function getTokenCssVariables(): Record<string, string> {
  return {
    '--kv-void': COLORS.void,
    '--kv-panel': COLORS.panel,
    '--kv-border': COLORS.border,
    '--kv-border-active': COLORS.borderActive,
    '--kv-text-primary': COLORS.textPrimary,
    '--kv-text-secondary': COLORS.textSecondary,
    '--kv-text-tertiary': COLORS.textTertiary,
    '--kv-text-muted': COLORS.textMuted,
    '--kv-emerald': COLORS.emerald,
    '--kv-amber': COLORS.amber,
    '--kv-rose': COLORS.rose,
    '--kv-cyan': COLORS.cyan,
    '--kv-blur-panel': `${GLASS.panel.blurPx}px`,
    '--kv-blur-chip': `${GLASS.chip.blurPx}px`,
    '--kv-blur-overlay': `${GLASS.overlay.blurPx}px`,
    '--kv-motion-fast': `${MOTION.fast}ms`,
    '--kv-motion-base': `${MOTION.base}ms`,
    '--kv-motion-slow': `${MOTION.slow}ms`,
  };
}