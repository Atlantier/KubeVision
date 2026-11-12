# R1 · 视觉地基 P0（玻璃单一事实源 + 静默失效 Tailwind 类 + 设计令牌）

> 范围：只改样式/令牌，不改业务逻辑、不改四语义色、不升级依赖。
> 分支：`chore/dead-code-cleanup` · 提交：见本轮 commit · 日期：2026-11-12

## 1. 玻璃四层单一事实源（src/app/globals.css）

- 删除坏变量 `--: 20px` / `--: 8px`、所有 `var(--)`、空选择器 `. {}`，以及与
  `@layer components` 重复的文末 `.kv-panel`（此前文末坏规则覆盖了好的那套）。
- 五个玻璃类各只有一条正确规则，全部带 `-webkit-` 前缀：
  - `.kv-panel`：纵向渐变底 + `blur(20px) saturate(140%)` + 发丝描边 + 顶部内高光 + 外投影；
  - `.kv-chip`：`blur(8px)`；`.kv-overlay`：`blur(30px)`；
  - `.kv-blur-panel` / `.kv-blur-chip`：可组合 blur 工具类（只供 blur，不写背景，
    可与任意 `bg-*` 叠加），真实存在（此前是空选择器，静默失效）。
- blur 数值唯一真源 = `tokens.ts` GLASS（20/8/30）→ `:root` 的
  `--kv-blur-panel/chip/overlay`，由 `check-style-contract.mjs` 静态校验一致。
- 删除未接线的 `getTokenCssVariables()`（从未在根布局注入），改由静态检查保证三处一致。
- 焦点环改 `outline + outline-offset`（不再用全局 box-shadow 吃面板阴影）；
  `overflow-hidden` / `.kv-panel` 容器用 `outline-offset:-2px`。
- 新增 `@supports not (backdrop-filter …)` 降级：提高面板/徽标/遮罩不透明度保可读。
- `tailwind.config.ts` 用 `safelist` 强制保留五个玻璃基元，避免 Tailwind v3 按 usage
  裁剪掉未被引用的 `kv-blur-chip`（"类名写了但构建里不存在"）。

## 2. 静默失效 Tailwind 类（全量扫描 src/**/*.tsx）

- 实测确认：Tailwind v3 只生成默认 opacity 刻度
  `{0,5,10,20,25,30,40,50,60,70,75,80,90,95,100}`，裸写 `/8 /12 /15 /35 /45 /55 /65 /85 /88 /92`
  等一律被静默丢弃（构建 CSS 里查无此类）。
- 修复 **79 处非刻度裸透明度** → `/[0.NN]`；**15 处双重透明度** `white/[0.07]/NN` →
  单一合法值 `/[0.04]` 或 `/[0.05]`。覆盖 CopilotDrawer / LocalAuditorPanel /
  DemoReplayTimeline / DemoDebugPanel / ActionConfirm / GenUISkeleton / PodMetricsCard /
  RootCauseAlert / MarkdownLite / RagKnowledgeModal / TerminalEcho / ViewportToolbar /
  NodeInspectHUD / ChaosControlModal / TopBar 等 23 个文件。
- 新增 `scripts/check-style-contract.mjs`：静态拒绝空选择器 / `--:` / `var(--)` /
  双重透明度 / 非刻度裸透明度 / 半像素与 <10px 字号；校验 GLASS 三处一致；
  读构建 CSS 断言五个玻璃类与本轮修复的 64 个括号透明度类都有生成规则。
  已接入 `verify:quick`（phaseStatic）与 `verify:all`。

## 3. 设计系统统一

- `TYPE_SCALE` 7 级映射进 `tailwind.config.ts` `fontSize`
  （`text-micro/caption/body/body-lg/title/h2/h1`，import 自 tokens 单一事实源）。
- 修复 6 处半像素字号：`text-[10.5px]→text-caption`、`text-[11.5px]→text-body`；
  全仓已无 <10px / 半像素字号。
- 新增 `STATUS.text/ring/badge` 语义色令牌表（四语义色值不变）。
- 顶层 Modal 统一 `.kv-panel + shadow-modal`：PostMortemModal / RagKnowledgeModal
  去掉 `bg-slate-950/95 + 内联阴影 + 青框`，scrim 改 `.kv-overlay`；ChaosControlModal
  同样统一玻璃底，但保留 rose 危险描边（颜色只表达状态）。
- 全局默认描边收敛到 `border-white/[0.075]`（= STROKE.hairline）。

## 4. 验收（真实执行）

```text
npx tsc --noEmit            → 0 error
npx next lint               → No ESLint warnings or errors
npx next build              → exit 0（4/4 static pages，First Load 177 kB）
node scripts/check-style-contract.mjs → 13 项全绿
node scripts/verify.mjs --quick       → 8/8 通过（含新增「样式契约」）
node scripts/run-demo-tests.mjs       → 11/11
node scripts/verify-demo.mjs          → 22/0（演示路径完整，红线 10）
```

构建 CSS 不再含 `--:` / `. {}` / `var(--)`。浏览器 computedStyle 实测：

```text
.kv-panel       backdropFilter = blur(20px) saturate(1.4)   （≡ saturate(140%)）
.kv-chip        backdropFilter = blur(8px)
.kv-overlay     backdropFilter = blur(30px)
.kv-blur-panel  backdropFilter = blur(20px) saturate(1.4)
.kv-blur-chip   backdropFilter = blur(8px)
```

证据：`docs/summit/shots/r1-glass/computed-style.json`、`overview-1680x1000.png`。

## 5. 仍需后续轮处理

1. **全站字号语义类迁移**：本轮已建 `fontSize` 语义令牌并清零非法字号，但存量
   `text-[10px]/[11px]/[12px]…`（约 500 处）尚未逐一替换为 `text-micro/caption/body…`。
   属高churn纯样式等价替换，建议单独一轮做，避免与本轮 P0 混在一起。
2. **圆角二选一收敛**：`rounded-kv*` 与原生 `rounded-lg/xl` 仍并存，未强制统一。
3. **STATUS 令牌推广**：`STATUS.text/ring/badge` 已定义，但各组件仍散写语义色类，
   未逐一替换为令牌引用。
4. computedStyle 探针只测了玻璃类本身，未对每个业务面板逐一截图比对。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 478eece   # R74 之前的干净基线
```