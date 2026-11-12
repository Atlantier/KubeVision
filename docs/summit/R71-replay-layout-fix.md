# R71 · 回放时间轴与终端/视口工具条的重叠修复

> 文件：`src/components/layout/TopBar.tsx`、`src/components/hud/DemoReplayTimeline.tsx`
> 症状：路演结束回到 idle 后 `sceneRect` 被清空，回放条退化为全屏 `bottom-6` 居中，
> 与底部 `TerminalEcho`、右下 `ViewportToolbar` 重叠。

## 1. TopBar：持续追踪 3D 视口

- 旧 `useEffect` 在 `demo.status === 'idle'` 时 `setSceneRect(null)` 并提前返回，
  回放条失去视口坐标。
- 新 effect **只要 TopBar 挂载就运行**（空依赖），不再依赖 demo 状态：
  - `measure()` 优先查 `#kubevision-3d-viewport`，回退
    `[aria-label="3D 集群拓扑视口"]`；
  - 读取 `getBoundingClientRect()` 的 `left/width`；
  - `ResizeObserver` 观察视口 + body（分栏拖拽/视口挂载替换都能捕捉）；
  - `window.resize` 兜底；
  - 相同矩形返回 previous，避免无意义重渲染。
- idle / finished 状态下保留最后一次 `sceneRect`。

## 2. 回放条安全区定位

- `sceneRect !== null`：
  ```tsx
  className="pointer-events-none fixed bottom-14 z-30 flex justify-center pl-3 pr-[76px]"
  style={{ left: `${sceneRect.left}px`, width: `${sceneRect.width}px` }}
  ```
  - `bottom-14`（56px）位于折叠态 `TerminalEcho` 之上；
  - `pr-[76px]` 让出右下角 `ViewportToolbar`（与 `TerminalEcho right-[74px]` 对齐）。
- `sceneRect === null` 的降级：
  ```tsx
  className="pointer-events-none fixed bottom-14 left-3 right-[76px] z-30 flex justify-center lg:right-[440px]"
  ```
- 移除旧的 `bottom-6 left-1/2 -translate-x-1/2 z-40 max-w-[54rem]` 容器。

## 3. DemoReplayTimeline 紧凑化

- 展开面板：
  ```tsx
  className="pointer-events-auto w-full max-w-[46rem] rounded-lg border border-amber-400/40 bg-slate-950/92 px-3.5 py-2.5 shadow-[0_12px_36px_-8px_rgba(2,6,23,0.92)] backdrop-blur-md"
  ```
- 移除旧 `max-w-[54rem] / bg-slate-950/88 / 内联 boxShadow`，统一由 Tailwind 表达。
- 折叠态入口改为 `rounded-full` 胶囊，保留时间轴图标、`N 帧`徽标，并新增
  `ChevronDown` 展开箭头；它位于父容器的 `bottom-14` 安全区内。

## 4. 验证

```text
npx tsc --noEmit → 0 error
npx next lint    → No ESLint warnings or errors
npx next build   → exit 0（4/4 static pages，First Load 177 kB）
```

### 4.1 真实回放实测（R72 补证）

用 headless Edge 完整跑一遍自动路演，结束后点击「事故回放」展开面板，
读取三个元素的实际矩形：

```text
panel    left=152.1 top=789.0 right=888.1 bottom=944.0
terminal left= 21.0 top=947.0 right=1021.3 bottom=979.0
toolbar  left=1033.3 top=803.0 right=1083.3 bottom=979.0
overlapTerminal = false
overlapToolbar  = false
```

- 面板底边 944 与终端顶边 947 之间保留 3px 间隔；
- 面板右边 888 与工具条左边 1033 之间保留 145px 间隔；
- 截图：`docs/summit/shots/r71-replay/replay-expanded-1680x1000.png`；
- 测量数据：`docs/summit/shots/r71-replay/layout.json`。

### 4.2 其他约束

- `sceneRect` 不再因 idle 重置，回放条在路演结束后仍绑定 3D 视口；
- 底部 56px + 右侧 76px 安全区，实测与 `TerminalEcho` / `ViewportToolbar` 零交集；
- 回放面板宽度 736px（46rem），窄视口下自动收缩。

## 5. 风险

1. 实测只覆盖 1680×1000 视口；其他尺寸仍依赖同一套安全区常量，
   若 `TerminalEcho` / `ViewportToolbar` 尺寸变化，`bottom-14 / pr-[76px] /
   right-[76px]` 需同步调整。
2. `ResizeObserver` 同时观察 body，极少数布局循环可能触发多次 measure；
   已用“相同矩形返回 previous”抑制重渲染。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 96e4fb3   # R70 计时改造
```