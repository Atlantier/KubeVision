import type { Config } from 'tailwindcss';
import { TYPE_SCALE } from './src/constants/tokens';

/**
 * KubeVision AI — Tailwind CSS v3 设计令牌（深空赛博运维美学）
 *
 * 【契约】严格锁定 Tailwind v3：使用 `tailwind.config.ts` + `content` 扫描 +
 * `theme.extend`，严禁迁移到 Tailwind v4 的 CSS-first `@theme` 配置或
 * `@import "tailwindcss"` 语法。
 *
 * 【设计意图】
 * 把 AGENTS.md 第 5 条视觉规范固化为可复用的语义令牌：
 *   - 背景 slate-950、面板 slate-900/75 + backdrop-blur + slate-800 描边
 *   - 状态色：正常 emerald-400 / 高负载 amber-400 / 崩溃 rose-500 / 主题流光 cyan-400
 *   - 自定义发光阴影（cyan / emerald / rose）用于状态徽标与焦点强调
 *   - .bg-cyber-grid 网格背景在 globals.css 的 @layer utilities 中定义
 */
const config: Config = {
  content: [
    './src/pages/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  /**
   * 玻璃四层 + 两个可组合 blur 工具类是设计系统基元，必须"真实存在"于构建产物，
   * 供 2D HUD 与 3D <Html> 随时引用。Tailwind v3 会按 content 使用情况裁剪
   * @layer components/utilities 里的自定义类（例如 kv-blur-chip 暂未被引用就会被删），
   * 用 safelist 强制保留，避免"类名写了但构建里不存在"的静默失效。
   */
  safelist: ['kv-panel', 'kv-chip', 'kv-overlay', 'kv-blur-panel', 'kv-blur-chip'],
  theme: {
    extend: {
      spacing: {
        kv1: '4px',
        kv2: '8px',
        kv3: '12px',
        kv4: '16px',
        kv5: '20px',
        kv6: '24px',
        kv8: '32px',
      },
      borderRadius: {
        kv: '4px',
        'kv-md': '6px',
        'kv-lg': '8px',
        'kv-xl': '12px',
      },
      transitionDuration: {
        fast: '140ms',
        base: '200ms',
        slow: '320ms',
      },
      transitionTimingFunction: {
        kv: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },

      colors: {
        kv: {
          void: 'var(--kv-void)',
          panel: 'var(--kv-panel)',
          border: 'var(--kv-border)',
          primary: 'var(--kv-text-primary)',
          secondary: 'var(--kv-text-secondary)',
          tertiary: 'var(--kv-text-tertiary)',
          muted: 'var(--kv-text-muted)',
          emerald: 'var(--kv-emerald)',
          amber: 'var(--kv-amber)',
          rose: 'var(--kv-rose)',
          cyan: 'var(--kv-cyan)',
        },
        // 深空基底：比 slate-950 更深一档，用于 3D 画布背后的无限纵深
        void: {
          DEFAULT: '#020617',
          deep: '#010411',
        },
        // 运维状态语义色（引用 Tailwind 原生色阶，保证 hover/active 派生一致）
        status: {
          healthy: '#34d399', // emerald-400
          warning: '#fbbf24', // amber-400
          critical: '#f43f5e', // rose-500
          accent: '#22d3ee', // cyan-400
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      /**
       * 语义字号 7 级（映射自 tokens.ts TYPE_SCALE，单一事实源）。
       * 全站用 text-micro / text-caption / text-body / text-body-lg /
       * text-title / text-h2 / text-h1，禁止 <10px 与半像素裸值。
       */
      fontSize: {
        micro: [`${TYPE_SCALE.micro}px`, { lineHeight: '1.4' }],
        caption: [`${TYPE_SCALE.caption}px`, { lineHeight: '1.45' }],
        body: [`${TYPE_SCALE.body}px`, { lineHeight: '1.5' }],
        'body-lg': [`${TYPE_SCALE.bodyLg}px`, { lineHeight: '1.5' }],
        title: [`${TYPE_SCALE.title}px`, { lineHeight: '1.45' }],
        h2: [`${TYPE_SCALE.h2}px`, { lineHeight: '1.35' }],
        h1: [`${TYPE_SCALE.h1}px`, { lineHeight: '1.25' }],
      },
      boxShadow: {
        // 自定义发光阴影：0 位移 + 大范围低透明度外发光，营造霓虹辉光
        'glow-cyan': '0 0 12px 0 rgba(34, 211, 238, 0.45), 0 0 32px -4px rgba(34, 211, 238, 0.35)',
        'glow-emerald':
          '0 0 12px 0 rgba(52, 211, 153, 0.45), 0 0 32px -4px rgba(52, 211, 153, 0.35)',
        /* 琥珀辉光：用于"警告级"提示（如主动异常嗅探横幅的混沌演练态）。
           补此 token 的原因：此前 UI 里写了 shadow-glow-amber 但配置中缺失，
           Tailwind 对未知类名静默忽略，导致该处发光效果实际未生效——
           这类"写了但没效果"的样式缺陷靠肉眼极难发现，靠比对类名与配置才发现。 */
        'glow-amber':
          '0 0 12px 0 rgba(245, 158, 11, 0.45), 0 0 32px -4px rgba(245, 158, 11, 0.35)',
        'glow-rose': '0 0 12px 0 rgba(244, 63, 94, 0.45), 0 0 32px -4px rgba(244, 63, 94, 0.35)',
        // 面板抬升阴影：深空环境下用近黑投影而非灰色
        panel: '0 8px 32px -8px rgba(0, 0, 0, 0.6)',
        // 顶层模态抬升阴影：保留顶部 1px 内高光 + 比面板更深更远的外投影，
        // 与 .kv-panel 叠加时不丢失玻璃受光棱边（utilities 层覆盖 components 层 box-shadow）
        modal: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.09), 0 24px 80px 0 rgba(2, 6, 23, 0.9)',
      },
      keyframes: {
        // 主题流光：沿边框缓慢扫过的高光，用于加载态与 Copilot 思考指示
        'glow-pulse': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        'scan-line': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        /*
         * laser-scan —— 分栏手柄的"激光流光"。
         *
         * 【为何不是 scan-line 的复用】scan-line 的位移是 -100% → 100%
         * （按其自身高度的百分比），用在 1/3 高度的亮带上会扫出容器之外；
         * 这里用 translateY(-33%) → translateY(300%) 让亮带**在 1px 宽的
         * 导轨内**完整走完一轮，且首尾都不溢出。
         */
        'laser-scan': {
          '0%': { transform: 'translateY(-120%)', opacity: '0' },
          '15%': { opacity: '1' },
          '85%': { opacity: '1' },
          '100%': { transform: 'translateY(320%)', opacity: '0' },
        },
      },
      animation: {
        'glow-pulse': 'glow-pulse 2.4s ease-in-out infinite',
        'scan-line': 'scan-line 4s linear infinite',
        'laser-scan': 'laser-scan 2.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
