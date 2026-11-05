/**
 * KubeVision AI — PostCSS 配置（Tailwind CSS v3 标准管线）
 *
 * 【契约】严格锁定 Tailwind v3：使用 `tailwindcss` PostCSS 插件 + `tailwind.config.ts`，
 * 严禁引入 Tailwind v4 的 `@tailwindcss/postcss` 插件或 `@import "tailwindcss"` 语法。
 * autoprefixer 负责 -webkit- 前缀（移动端 Safari 的 backdrop-filter / mask 等）。
 */

/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

export default config;
