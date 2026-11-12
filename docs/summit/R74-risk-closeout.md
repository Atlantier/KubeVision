# R74 · R73 残余风险收口（多视口 / outside-click / 性能 HUD 不再压 Copilot）

> 目标：把 R73 列出的三条风险从“已知”变为“已验证或有明确边界”。

## 1. 读图说明支持 outside-click / Esc 关闭

`TopologyLegendPanel` 新增 `rootRef` 与展开期监听：

- `document` 上监听 `pointerdown`：点击 `rootRef` 之外立即收起；
- `window` 上监听 `keydown`：Esc 收起；
- 用 pointerdown 而非 click：拖拽相机时 pointerup 可能落在画布外，click 不一定触发；
- 只在 `expanded === true` 时注册，收起后自动清理。

四档视口实测 `aria-expanded`：

```text
1920x1080: true -> false (outside) / false (Esc)
1366x768 : true -> false (outside) / false (Esc)
1024x768 : true -> false (outside) / false (Esc)
800x600  : true -> false (outside) / false (Esc)
```

触发按钮几何仍保持 142×29，不随展开变化。

## 2. 性能 HUD 移入 3D 视口，不再覆盖 Copilot

- `ShellLayoutProps` 新增 `perfHud?: ReactNode`；
- `page.tsx` 把 `PerfTelemetryHUD` 作为 `perfHud` 传给 `ShellLayout`，保留 dynamic 懒加载；
- `ShellLayout` 在 3D 视口 `<section>` 内用 `<AnimatePresence>{perfHud}</AnimatePresence>` 渲染；
- HUD 的 `absolute right-3 top-16` 现在相对 3D 视口，而不是页面根容器，
  因此不再覆盖右侧 Copilot 内容。
- 高度钳制从 `max-h-[calc(100%-11rem)]` 调整为
  `max-h-[calc(100%-18rem)]`：11rem 只扣了工具条高度，没扣 HUD 的 64px 顶部偏移；
  实测 1366×768 会压到工具条，18rem 后四档视口全部安全。
- 宽度增加 `max-w-[calc(100%-1.5rem)]`，窄视口不溢出。

四档实测：

```text
size        hud bottom  toolbar top  overlapToolbar  insideViewport
1920x1080   691         883          false           true
1366x768    527         571          false           true
1024x768    527         571          false           true
800x600     319         355          false           true
```

证据：`docs/summit/shots/r74-ui/multi-viewport-verified.json`。

## 3. 演示状态胶囊多视口

R73 已将 `PresentStatusHud` 移入 3D 视口左下角；R74 复测四档视口：

```text
1920x1080 / 1366x768 / 1024x768 / 800x600：insideViewport = true
```

## 4. 验证

```text
npx tsc --noEmit → 0 error
npx next lint    → No ESLint warnings or errors
npx next build   → exit 0（4/4 static pages，First Load 177 kB）
```

## 5. 仍存在的边界

1. Perf HUD 仍在 3D 视口内覆盖部分场景画面（浮层 HUD 的既有语义），
   但不再覆盖 Copilot 与右下工具条。
2. 多视口只测四档常见尺寸，不是全尺寸矩阵；安全区常量变化时需复测。
3. outside-click 使用 pointerdown 语义；若未来面板内出现拖拽交互，需要再评估误关闭。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 1137d6a   # R73 UI 修复
```