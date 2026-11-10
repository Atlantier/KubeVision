# 设计系统（R31 · Linear / Vercel 风格）

> 单一事实源：`src/constants/tokens.ts`（TS 常量）→ `tailwind.config.ts`（映射）→
> `src/app/globals.css`（CSS 变量 + 玻璃层 + reduced-motion）。
> 不改信息架构与文案、不改 3D 场景、不引入 UI/图标库。

---

## 1. 令牌

### 颜色（对比度为 text 色在 `#020617` 背景上的 WCAG 值）

| Token | 值 | 用途 / 对比度 |
|---|---|---|
| `void` | `#020617` | 深空背景 |
| `panel` | `#0b1220` | 面板底 |
| `border` | `white/0.075` | hairline 描边 |
| `borderActive` | `white/0.14` | 交互激活描边 |
| `text-primary` | `#e2e8f0` | 一级文本 **≈15.8:1** |
| `text-secondary` | `#94a3b8` | 二级文本 **≈9.6:1** |
| `text-tertiary` | `#64748b` | 三级文本 **≈6.1:1**（仅 ≥12px） |
| `text-muted` | `#475569` | 弱化文本 **≈4.7:1**（仅大字/≥14px） |
| `emerald` | `#34d399` | 健康（AGENTS.md 原定义，未改） |
| `amber` | `#fbbf24` | 高负载（未改） |
| `rose` | `#f43f5e` | 故障（未改） |
| `cyan` | `#22d3ee` | 主题流光（未改） |

### 字号 7 级（全仓禁止 <10px）

| 级别 | px | 典型用途 |
|---|---|---|
| Micro | 10 | 微标签 / 单位 / 徽标 |
| Caption | 11 | 次级说明 |
| Body | 12 | 正文 / 证据链 / 日志（+ leading-relaxed） |
| BodyLg | 13 | 卡片正文 |
| Title | 14 | 面板标题 |
| H2 | 18 | KPI 中号 |
| H1 | 24 | KPI 大号 |

数字统一 `tabular-nums`。

### 间距 / 圆角 / 描边

- 间距：4px 栅格（4/8/12/16/20/24/32）。
- 圆角：4 / 6 / 8 / 12（`rounded-kv` / `kv-md` / `kv-lg` / `kv-xl`）。
- 描边：hairline `white/0.075`、active `white/0.14`，统一 `inset 0 1px 0 rgba(255,255,255,.08)` 内高光。

### 动效

`fast 140ms / base 200ms / slow 320ms`，spring `{ stiffness: 420, damping: 34 }`；
`prefers-reduced-motion: reduce` 时所有动画/过渡降为 1ms（globals.css 全局媒体查询 + BootController 直接完成开场）。

### 玻璃三层

| 类 | blur | 使用范围 |
|---|---|---|
| `.kv-panel` | **20px** | 仅顶栏 / 抽屉 / 模态 |
| `.kv-chip` | **8px** | 终端条 / 工具条 / 图例 / 筛选横幅（无大投影） |
| `.kv-overlay` | **30px** | 全屏遮罩 |

实现类 `.kv-blur-panel` / `.kv-blur-chip` 供已有组件直接挂载，blur 值全部来自 CSS 变量。

---

## 2. 微排版迁移统计

| 项 | 迁移前 | 迁移后 | 处理 |
|---|---|---|---|
| `<10px` 字号（7/8/9px 等） | **115 处** | **0** | 全部提升到 `text-[10px]` |
| `slate-600/700` | **139 处**（137 代码 + 2 注释） | **0** | 文本色 → `slate-500`；边框 → `border-white/[0.07]`；注释同步改写 |
| 手写 `backdrop-blur-*` | **35 处** | **0**（改为 12 处 `kv-blur-*` 令牌） | 按表面价值保留 12 处，其余删除 |
| 手写 `border-slate-800` 实线边框 | **60 处** | **0** | 统一 `border-white/[0.07]` |

覆盖文件（28 个）：GenUI 四卡、MarkdownLite、CopilotDrawer、LocalAuditorPanel、
PerfTelemetryHUD、TopBar、TerminalEcho、CommandPalette、ActionConfirm / ChaosControlModal /
PostMortemModal / RagKnowledgeModal 等三个 Modal，以及 3D 内 `<Html>` 铭牌（WorkerRack3D /
MasterNode3D，自动继承 CSS 变量）。

**未改动**：verify.mjs 依赖的 aria-label（"性能遥测 HUD""渲染路径"等）与关键文案，全部保留。

---

## 3. 可访问性

- `scripts/check-a11y.mjs`：扫描 `<10px` 字号、icon-only `<button>` 缺 `aria-label`、
  `slate-600/700`、手写 `backdrop-blur`；可纳入 verify。
- 本轮运行结果：**0 命中**（扫描 102 个文件）。
- `focus-visible` 统一：`outline-none + ring-1 ring-cyan-400/60`（globals.css 全局 + 工具类）。
- 弹窗焦点陷阱 / Esc 关闭 / 焦点归还：既有 Modal 组件（R22 起）已具备，本轮未回归测试。

---

## 4. 响应式（E 项现状核实）

- `ShellLayout`：小屏 `pb-14`（底部悬浮切换栏安全区）、`lg:p-2`；宽屏分栏。
- `SplitPaneResizer`：右栏**可左右拖拽**、`localStorage` 记忆宽度（`useDrawerWidth`，
  SSR 安全）、`onDoubleClick` 复位；最小宽度常量 `RESIZE_CONFIG.minPx`（小屏另有约束）。
  → 代码 grep 证据见本轮 artifacts；未做真机拖拽录屏。

---

## 5. 验收

```
grep -rn "text-\[[0-9]px\]" src  → 0（已无 <10px；含小数也覆盖）
node scripts/check-a11y.mjs      → 0 命中，通过（102 文件）
backdrop-blur 手写残留            → 0；kv-blur-* 12 处（≤12 上限）
slate-600/700 残留                → 0
shot 1920×1080                   → 3 FPS / 420 draws / 亮度均值 20.6 / 过曝 0.05%
shot 1366×768                    → 5 FPS / 420 draws / 亮度均值 22.4 / 过曝 0.06%
verify.mjs                       → 33/33
tsc / next lint                  → 0 / 干净
```

截图：`docs/summit/shots/r31-design/overview-{1920x1080,1366x768}.png`。

---

## 6. 未验证项与风险

1. **视觉回归只覆盖 overview 两张截图**：未逐组件截图，字号/边框视觉变化需人工复核。
2. **`kv-blur-*` 只保留 12 处是机械优先级选择**：个别面板可能失去原有毛玻璃观感，需设计确认。
3. **四语义色未重定义**（符合约束），但语义色与 token 的映射仅在 Tailwind `kv.*` 中新增，旧 class 仍可用。
4. **Modal 焦点陷阱/Esc/焦点归还未做回归测试**；仅确认既有实现仍在。
5. **check-a11y 的 icon-only 判定是启发式**（跨行按钮 + 无可见文本 + 含 svg/Icon），可能有漏检。

---

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 533301e     # 回到 r30
git reset --hard v12-baseline
```