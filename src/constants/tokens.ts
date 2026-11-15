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
  /** 遮罩淡入/淡出时长（秒）：140ms */
  overlayFadeSec: 0.14,
  /** 弹层入场时长（秒）：200ms */
  panelEnterSec: 0.2,
  /** 弹层退场时长（秒）：180ms（确保 <= 200ms 且不阻塞连续交互与键盘探针） */
  panelExitSec: 0.18,
  /** 统一标准缓动曲线 [0.22, 1, 0.36, 1] */
  easeOut: [0.22, 1, 0.36, 1] as const,
  /** 统一弹性阻尼曲线（全站所有 spring 动画共享） */
  spring: { stiffness: 420, damping: 34 },
} as const;

/** 玻璃三层（blur 只能来自这两个值 + overlay 的 30px） */
export const GLASS = {
  panel: { blurPx: 20, use: '仅顶栏 / 抽屉 / 模态' },
  chip: { blurPx: 8, use: '终端条 / 工具条 / 图例 / 筛选横幅（无大投影）' },
  overlay: { blurPx: 30, use: '全屏遮罩' },
} as const;

/**
 * 状态语义色令牌表（text / ring / badge 三态）
 *
 * 【设计意图】把"健康/高负载/崩溃/主题"四种状态在文字、焦点环、徽标上的
 * 配色收敛为单一事实源，避免各组件各自拼 `text-emerald-400` / `bg-emerald-500/10`
 * 导致色阶漂移。四语义色沿用 AGENTS.md（emerald-400 / amber-400 / rose-500 / cyan-400），
 * 不修改色值本身；这里只统一"用在哪种 UI 元素上"的组合。
 *
 * 【透明度档位】全部使用 Tailwind 默认 opacity 刻度（/10、/40），
 * 不使用 /8、/12 等非刻度裸值（那类值在 Tailwind v3 会静默失效）。
 */
export const STATUS = {
  healthy: {
    text: 'text-emerald-400',
    ring: 'ring-emerald-400/40',
    badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  },
  warning: {
    text: 'text-amber-400',
    ring: 'ring-amber-400/40',
    badge: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  },
  critical: {
    text: 'text-rose-500',
    ring: 'ring-rose-500/40',
    badge: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  },
  accent: {
    text: 'text-cyan-400',
    ring: 'ring-cyan-400/40',
    badge: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  },
} as const;