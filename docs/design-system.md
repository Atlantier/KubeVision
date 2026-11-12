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

---

## 8. 玻璃四层契约 + 改值只改 tokens.ts（R2 · CI 可校验）

### 8.1 四层结构（`.kv-panel` 的"高定玻璃"）

`.kv-panel` 由四层叠加而成，缺一层就退回"廉价深色块"：

| 层 | 属性 | 值 | 作用 |
|---|---|---|---|
| ① 纵向渐变底 | `background` | `linear-gradient(180deg, rgba(15,23,42,.78) → rgba(6,10,19,.88))` | 顶部受光、底部沉入阴影，底部更实更易读 |
| ② 强毛玻璃 | `backdrop-filter` | `blur(var(--kv-blur-panel)) saturate(140%)` | 柔化背景且补饱和，透出颜色仍鲜活 |
| ③ 发丝描边 | `border` | `1px solid rgba(255,255,255,.075)` | 白色低透明 = 玻璃边缘高光，而非"画上去的框" |
| ④ 双层阴影 | `box-shadow` | `inset 0 1px 0 rgba(255,255,255,.09)` + `0 16px 40px -12px rgba(0,0,0,.65)` | 顶部受光棱边 + 悬浮层级 |

`.kv-chip` / `.kv-overlay` 为轻量/重毛玻璃变体；`.kv-blur-panel` / `.kv-blur-chip`
是"只供 blur、不写背景"的可组合工具类，供已用 `bg-*` 的 HUD 直接叠加。

### 8.2 改值只改 tokens.ts（单一事实源链路）

```
src/constants/tokens.ts  GLASS { panel.blurPx:20, chip.blurPx:8, overlay.blurPx:30 }
        │  （唯一可编辑数值处）
        ▼
src/app/globals.css  :root { --kv-blur-panel:20px; --kv-blur-chip:8px; --kv-blur-overlay:30px }
        │  （CSS 变量，供 2D HUD 与 3D <Html> 共同继承）
        ▼
.kv-panel / .kv-chip / .kv-overlay / .kv-blur-*  引用 var(--kv-blur-*)
```

**要改模糊半径，只改 `tokens.ts` 的 `GLASS.*.blurPx`，再同步 `globals.css` 的
`--kv-blur-*`**（两者由 `check-style-contract.mjs` 静态校验一致，漂移即报错）。
不要在组件里手写 `backdrop-blur-*` 或第二个 `.kv-panel`。颜色基座同理走
`COLORS` / `STROKE`。`tailwind.config.ts` 用 `safelist` 保证五个玻璃基元不被
usage 裁剪，始终可被引用。

### 8.3 CI 闸门（能红能绿）

- `scripts/check-style-contract.mjs`（接入 `verify:quick` / `verify:all`）：
  - 静态拒绝 `--:` / `var(--)` / 空选择器 `. {}` / 双重透明度 / 非刻度裸透明度 / 半像素与 <10px 字号；
  - 校验 `tokens.GLASS` 与 `globals.css` blur 变量一致；
  - **全量透明度比对**：提取 src 全部含透明度修饰符的类，逐个与生产 CSS 选择器比对，
    输出「源码类总数 / 已生成数 / 缺失清单」，缺失即阻断 verify，不设白名单。
- `scripts/probe-glass-contract.mjs`（接入 `verify:all`，需 dev/preview 服务）：
  四档视口（1920×1080 / 1366×768 / 1024×768 / 800×600）实测 `.kv-panel / .kv-chip /
  .kv-overlay` 的 `backdropFilter / backgroundColor / borderColor / boxShadow` 逐项符合令牌；
  `prefers-reduced-motion` 下 `transition/animationDuration ≤ 1ms`。期望值从 `tokens.ts` 读取。

**能红能绿证明**：把 `.kv-panel` 的 `var(--kv-blur-panel)` 改回 `var(--)` → 契约脚本
exit 1（红）；恢复 → exit 0（绿）。注入一个"合法刻度但不存在的颜色"类
（如 `bg-notacolor-500/50`）→ 静态检查通过但全量比对报缺失、exit 1（红）；移除 → 绿。