# R32 · 演示模式 / 键盘可达 / 视觉回归基线

> 状态：追问 1、3、4 已落地（4 的比对口径有需说明的偏差）；**追问 2 未实现**。

---

## 1. 追问 1：演示模式（`?present=1` 或顶栏「演示」开关）

实现：`src/store/usePresentMode.ts` + `ShellLayout` + `TopBar` 按钮 + `PresentStatusHud`。

| 项 | 实现 |
|---|---|
| 入口 | `?present=1` URL（客户端 effect 读取，SSR 安全）或顶栏「演示」按钮（`aria-pressed`） |
| 隐藏终端 | `ShellLayout` 中条件隐藏 `<TerminalEcho>`；Canvas **常驻不卸载** |
| 性能 HUD | `body[data-present='1']` CSS 隐藏整个 Perf HUD；改由 `PresentStatusHud` 显示 **健康分 / 告警数 / QPS** 三项 |
| 抽屉宽度 | 38% → **34%**（`PRESENT_DRAWER_WIDTH_PCT`），沿用既有 `transition-[width] duration-200`（≤240ms） |
| Cmd+K | 命令面板未改动，演示模式下仍可用 |
| 3D 画布 | 无任何 Canvas/Scene 卸载路径，切换零重建 |

**未验证**：未在 `?present=1` 下截图/录屏确认视觉结果（需真机复核）。

---

## 2. 追问 2：首屏加载体验 —— ❌ 未实现

未实现"端侧模型进度 + Copilot chunk 进度 + SSE 状态"的三合一可折叠胶囊；
本条不做假实现，留待 R33。现状仍是各自独立 loading 文案。

---

## 3. 追问 3：键盘可达

在 `ShellLayout` 全局 keydown 中新增（输入框聚焦时自动让位）：

| 键 | 行为 |
|---|---|
| `1` / `2` | 切换右栏页签：copilot / auditor（`setActiveRightTab`） |
| `F` | 聚焦搜索：查找 `input[type=search]`、`[role=searchbox]`、aria-label/placeholder 含"搜索"的输入；**若页面无搜索输入框则不生效**（当前搜索在命令面板内，F 不会打开面板） |
| `Space` | `togglePauseDemoDirector()` 暂停/恢复路演 |
| `?` | 打开/关闭快捷键帮助浮层 |
| `Esc` | 关闭帮助浮层 |

帮助浮层：`src/components/layout/ShortcutHelpOverlay.tsx`，`role="dialog" aria-modal`、
打开聚焦关闭按钮、每行 `kbd` 带 `aria-keyshortcuts`、focus-visible 焦点环。
文档：本文件 + `docs/design-system.md` 的键盘章节（后续补）。

**未验证**：`1/2/F/Space/?` 未做真机键盘回归测试。

---

## 4. 追问 4：视觉回归基线

- 基线目录：`docs/summit/visual-baseline/`（6 张，复用历史确定性截图）：

| 文件 | 来源 | 对应需求 |
|---|---|---|
| 01-first-screen.png | r31 overview 1366 | 首屏 |
| 02-pod-selected.png | r28 pod-closeup | 选中 Pod 近景（近似） |
| 03-oom-fault.png | r24 oom | OOM 故障态 |
| 04-crystal.png | r25 crystal | 晶体特写（替代 RAG 弹窗/复盘报告） |
| 05-genui-cards.png | r06 demo-phase2 1920 | 路演阶段 2（近似 AI 三卡） |
| 06-postmortem.png | r06 demo-phase4 1920 | 路演阶段 4（近似复盘） |

> **诚实说明**：需求点名的"AI 三卡 / RAG 弹窗 / 复盘报告"三个交互界面
> 无法用现有 shot.mjs 确定性场景直接截取，本轮以最接近的历史场景代替；
> 精确的交互界面基线需在 R33 用 CDP 点击脚本补齐。

- 比对脚本：`scripts/visual-diff.mjs`（PNG 自解码、逐像素 RGBA 差值和 >30 记为差异，
  阈值默认 **1.5%**，输出 `docs/summit/visual-diff.{md,json}`，超阈值 exit 1）。

本轮运行结果（baseline vs `docs/summit/visual-current/`）：

```
01-first-screen.png   3.439%  fail
02-pod-selected.png  12.594%  fail
03~06                 n/a     missing（未重采集）
```

**结论：门槛生效但当前基线不可用于判定**——两次截图来自不同动画相位
（粒子/彗星/雷达扫描随时间变化），即使同一构建也会产生数个百分点差异。
必须用"固定时间轴/固定随机种子"的采集（或仅在静态 UI 区域做掩码比对）才能
让 1.5% 阈值有意义；本轮只完成了工具与基线结构，不宣称通过。

---

## 5. 验收

```
tsc 0 · next lint 干净
check-a11y 0 命中（102 文件，R31 门禁仍绿）
shot overview/pod-closeup 1366 : 已采集（visual-current）
visual-diff : 阈值 1.5% 生效；本轮 2 场景超阈值（动画相位差异，见上）
verify.mjs  : 未重跑（本轮只改 DOM/快捷键，未动 3D 渲染路径）
```

---

## 6. 未验证项与风险

1. **追问 2 完全未实现**。
2. **演示模式未截图/录屏验证**（宽度 34%、终端隐藏、HUD 胶囊均只经 tsc/lint）。
3. **F 键在无搜索输入框时静默失效**；帮助浮层未做焦点陷阱（仅 Esc 关闭 + 打开聚焦）。
4. **视觉基线非需求点名的六个交互界面**；且动画相位导致比对必然超阈值。
5. **`1/2/Space/?` 未做真实键盘事件回归**。

---

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard de9d8d2     # 回到 r31
git reset --hard v12-baseline
```