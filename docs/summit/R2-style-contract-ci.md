# R2 · 玻璃/样式契约 CI 可校验 + 跨视口可证明

> 承 R1 Main（`aef4520`）。范围：只改样式守卫脚本 / 探针 / 设计文档，不改业务逻辑、
> 不改四语义色、不升级依赖。`src/` 最终与 HEAD 内容一致（演示用临时注入均已还原）。

## 1. 全量透明度比对（check-style-contract.mjs 扩展）

- 提取 src（`.ts`+`.tsx`，剥离块注释）**全部含透明度修饰符的类**（裸刻度值 + 括号任意值），
  逐个与生产 CSS 选择器比对，输出「源码类总数 / 已生成数 / 缺失清单」。
- **缺失即 exit 1 阻断 verify，不设白名单**。基线：**218 类 / 已生成 218 / 缺失 0**。
- 已接入 `verify:quick`（phaseStatic，R1 已接）与 `verify:all`。

## 2. 四档视口 computedStyle 探针（probe-glass-contract.mjs，新增）

- 1920×1080 / 1366×768 / 1024×768 / 800×600，逐视口实测 `.kv-panel / .kv-chip / .kv-overlay`
  的 `backdropFilter / backgroundColor / borderColor / boxShadow` 逐项符合令牌；
  `prefers-reduced-motion` 下 `transition/animationDuration ≤ 1ms`。
- 期望值从 `tokens.ts`（GLASS/COLORS/STROKE）读取，单一事实源。
- **52 断言全过**（每视口 13 条）。接入 `verify:all`（needsDev）。
- 证据：`docs/summit/shots/r2-glass/computed-style-4vp.json`。

## 3. 能红能绿演示（两类闸门）

- **坏变量闸门**：`.kv-panel` `var(--kv-blur-panel)` → `var(--)` → exit 1（红）；恢复 → exit 0（绿）。
- **缺失类闸门**：注入 `bg-notacolor-500/50`（合法刻度、假颜色，静态检查放行但 Tailwind 不生成）
  → 全量比对报缺失、exit 1（红）；移除 → exit 0（绿）。
- 证据：`docs/summit/shots/r2-glass/red-green-demo.md`。

## 4. 文档

`docs/design-system.md` 增补「§8 玻璃四层契约 + 改值只改 tokens.ts」：四层结构表、
单一事实源链路（tokens.GLASS → globals :root --kv-blur-* → 类）、CI 闸门与能红能绿说明。

## 5. 验收（真实执行）

```text
npx tsc --noEmit                 → 0 error
npx next lint                    → No ESLint warnings or errors
npx next build                   → exit 0（4/4 static pages）
node scripts/check-style-contract.mjs → 13 项全绿（218/218/0）
node scripts/probe-glass-contract.mjs → 52 断言全过（四档视口）
node scripts/verify.mjs --quick  → 8/8 通过
```

## 6. 未验证项与风险

1. 探针用 headless Edge（SwiftShader）；真实 GPU/ Safari 的 backdrop-filter 表现未逐浏览器实测。
2. 全量比对依赖生产 CSS，需先 `pnpm build`；无构建时该节 skip（静态检查仍跑）。
3. 缺失类闸门对"动态拼接类名"无能为力（Tailwind 本身也无法静态生成），属既有边界。
4. reduced-motion 只测了过渡/动画时长，未测 BootController 开场直接完成（R31 已实现）。

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard aef4520   # R1
```