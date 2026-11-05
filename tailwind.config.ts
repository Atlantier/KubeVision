import type { Config } from 'tailwindcss';

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
  theme: {
    extend: {
      colors: {
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
      boxShadow: {
        // 自定义发光阴影：0 位移 + 大范围低透明度外发光，营造霓虹辉光
        'glow-cyan': '0 0 12px 0 rgba(34, 211, 238, 0.45), 0 0 32px -4px rgba(34, 211, 238, 0.35)',
        'glow-emerald':
          '0 0 12px 0 rgba(52, 211, 153, 0.45), 0 0 32px -4px rgba(52, 211, 153, 0.35)',
        'glow-rose': '0 0 12px 0 rgba(244, 63, 94, 0.45), 0 0 32px -4px rgba(244, 63, 94, 0.35)',
        // 面板抬升阴影：深空环境下用近黑投影而非灰色
        panel: '0 8px 32px -8px rgba(0, 0, 0, 0.6)',
      },
      backgroundImage: {
        // 与 globals.css 的 .bg-cyber-grid 互补：径向暗角叠加，聚焦视口中心
        'radial-fade':
          'radial-gradient(ellipse 80% 60% at 50% 0%, rgba(34, 211, 238, 0.08), transparent 70%)',
      },
      keyframes: {
        // 主题流光：沿边框缓慢扫过的高光，用于加载态与 Copilot 思考指示
        'glow-pulse': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        'grid-pan': {
          '0%': { backgroundPosition: '0 0' },
          '100%': { backgroundPosition: '48px 48px' },
        },
        'scan-line': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
      },
      animation: {
        'glow-pulse': 'glow-pulse 2.4s ease-in-out infinite',
        'grid-pan': 'grid-pan 8s linear infinite',
        'scan-line': 'scan-line 4s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
