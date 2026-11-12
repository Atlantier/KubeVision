# R73 · 演示胶囊 / 读图说明 / 性能面板 三处布局修复

> 文件：`src/components/layout/ShellLayout.tsx`、`src/components/layout/PresentStatusHud.tsx`、
> `src/components/hud/NodeInspectHUD.tsx`、`src/components/hud/PerfTelemetryHUD.tsx`
> 目标：消除演示状态胶囊与 Copilot 页签重叠、读图说明展开宽度/圆角突变、矮视口性能面板压住工具条。

## 1. 演示状态胶囊

- `ShellLayout`：`<PresentStatusHud />` 从根容器移入
  `<section aria-label="3D 集群拓扑视口">` 内部，与 `TerminalEcho` 同级；
  演示模式下终端隐藏，左下角是空闲安全区。
- `PresentStatusHud` 定位类改为：
  ```tsx
  className="pointer-events-none absolute bottom-3 left-3 z-20 flex items-center gap-3 rounded-lg border border-cyan-400/25 bg-slate-950/85 px-3.5 py-2 font-mono text-xs text-slate-200 shadow-lg backdrop-blur-md"
  ```
  不再使用 `fixed right-3 top-14 z-40`，彻底离开右侧抽屉页签区域。

**实测（1366×768，`?present=1`）**

```text
hud:      left=21  top=713  right=236 bottom=747
viewport: left= 8  top= 56  right=889 bottom=760
insideViewport=true
overlapTabs=false（present 模式下页签栏本身隐藏）
```

截图：`docs/summit/shots/r73-ui/present-status-hud-1366x768.png`。

## 2. 读图说明展开/收缩

`TopologyLegendPanel` 重构为“固定按钮 + 独立浮层”：

- 外层：`pointer-events-none relative flex flex-col items-start`；
- 触发按钮几何恒定：`rounded-lg`、固定 padding、`transition-all duration-200`，
  内含 `Layers` 图标、三色状态点、`读图说明`、带
  `transition-transform duration-200 ease-out` 的 `ChevronDown`（展开旋转 180°）；
- 展开内容由 `<AnimatePresence initial={false}>` + `motion.div` 独立挂载：
  ```tsx
  initial={{ opacity: 0, y: -6, scale: 0.96 }}
  animate={{ opacity: 1, y: 0, scale: 1 }}
  exit={{ opacity: 0, y: -6, scale: 0.96 }}
  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
  style={{ transformOrigin: 'top left' }}
  className="pointer-events-auto relative mt-1.5 w-64 overflow-hidden rounded-lg border border-cyan-400/25 bg-slate-950/90 px-3.5 py-3 shadow-[0_16px_40px_-8px_rgba(2,6,23,0.92)] backdrop-blur-md"
  ```
- 卡片内挂载 `HoloRefractionEdges` / `HoloCorners` 与原有图例、手势提示；
- 不再切换外框 `rounded-full/rounded-2xl`，宽度不再参与动画。

**实测（1366×768，展开后）**

```text
button: left=21 top=69  width=142 height=29
panel:  left=21 top=104 width=256 height=206
```

按钮尺寸不随展开变化；浮层从左上角锚点缩放入场。

截图：`docs/summit/shots/r73-ui/topology-legend-open-1366x768.png`。

## 3. 性能面板矮视口加固

`PerfTelemetryHUD` 根容器增加：

```tsx
max-h-[calc(100%-11rem)] overflow-y-auto
```

**实测（1366×768，Shift+P 打开）**

```text
perf:    left=1086 top=57.5 right=1354 bottom=627.5 height=570
toolbar: left= 826 top=571  right= 876 bottom=747
overlapToolbar=false
scrollHeight=568 clientHeight=568
```

底部预留 11rem，性能面板底边距工具条顶部仍有约 56px 余量；内容超高时面板内部滚动。

截图：`docs/summit/shots/r73-ui/perf-hud-1366x768.png`；
测量数据：`docs/summit/shots/r73-ui/layout.json`。

## 4. 验证

```text
npx tsc --noEmit → 0 error
npx next lint    → No ESLint warnings or errors
npx next build   → exit 0（4/4 static pages，First Load 177 kB）
```

## 5. 剩余风险

1. 实测只覆盖 1366×768；其他视口依赖同一套 `bottom-3 / top-16 / 11rem` 约定。
2. 读图说明浮层展开后会覆盖部分 3D 画面（这是下拉面板的预期行为），
   按钮本身不移动；若后续要求点击外部关闭，可再加 outside-click。
3. 性能面板在极矮视口仍会覆盖右侧 Copilot 内容（HUD 的既有设计），
   本轮只保证不与右下工具条重叠。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 2b9d7e0   # R72 验证收口
```