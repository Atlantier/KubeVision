# R41 · Demo 截图链路修复 + 首屏加载体验

> 本轮完成：① 定位并修复 demo-phase2/4 截图超时（并补齐运行/结束/预检失败三态截图）；
> ② 首屏加载体验：骨架→内容 200ms 淡入 + 三合一「系统启动状态」可折叠胶囊。
> 后续 Phase（RAG 评测 / trace、三路召回等）本轮未开始，如实标注。

---

## 1. Demo 截图超时：根因与修复

**根因**：r33 把路演字幕条 `aria-label` 从「剧本路演进行中：…」改为「自动演练序列器」，
而 `scripts/shot.mjs` 仍在等待 `[aria-label^="剧本路演进行中"]`，因此永远等不到阶段。

**修复**：
- `DemoDirectorBar` 增加数据属性 `data-demo-phase / data-demo-status / data-demo-index`
  （不改 `role="region" aria-label="自动演练序列器"` 语义）；
- `shot.mjs` 改为等待 `[aria-label="自动演练序列器"]` 并读取 `data-demo-phase`，
  **同时保留旧 aria-label 作为兼容回退**；
- 新增场景 `demo-preflight-fail`：移除 Copilot 抽屉（预检第 3 项）后走真实 UI 启动，
  触发红色细边框 + 原因文案的预检失败态（3D 画面保持完好）。

**实测三态截图**（1366×768）：

| 状态 | 文件 | 证据 |
|---|---|---|
| 运行中（阶段 2/4） | `docs/summit/shots/r41-runbook/demo-phase2-1366x768.png` | `已到达 阶段 2/4: 阶段 2/4 · 故障注入与空间锁定 / running`；148 draws |
| 结束（阶段 4/4） | `docs/summit/shots/r41-runbook/demo-phase4-1366x768.png` | `已到达 阶段 4/4: 阶段 4/4 · MCP 闭环自愈 / running`；420 draws |
| 预检失败 | `docs/summit/shots/r41-runbook/demo-preflight-fail-1366x768.png` | 成功制造并截图（phase 为空 = 未启动） |

> 预检失败态通过"移除抽屉再点启动"实现；该场景会真实执行预检逻辑，不是伪造画面。

---

## 2. 首屏加载体验

### 2.1 三合一「系统启动状态」胶囊

新增 `src/components/hud/StartupStatusCapsule.tsx`（挂载于 `page.tsx`）：

- 合并三条启动状态：**WebGL 场景**（canvas 是否挂载）、**Copilot 分块**（抽屉是否挂载且骨架消失）、
  **遥测数据流**（快照非空且 QPS>0）；
- 展开时逐条显示 `OK / ··` 与细节；头部显示 `系统启动中 2/3` → `系统就绪 3/3`；
- **可折叠**：点击头部切换，`aria-expanded` / `aria-controls` 完整；全部就绪 900ms 后自动收起，
  再观察 3s 后淡出（`?startupDebug=1` 时保持展开，便于截图/讲解）；
- 第 4 行"端侧模型"如实标注 **按需加载（未启用时不阻塞首屏）**，不冒充进度。

### 2.2 骨架→内容 200ms 淡入

- `globals.css` 新增 `@keyframes kv-fade-in` 与 `.kv-fade-in`（200ms，`--kv-ease`）；
- `ShellLayout` 左右栏容器挂 `kv-fade-in`；`prefers-reduced-motion` 全局降级为 1ms（既有规则）。
- **诚实说明**：Next `dynamic()` 的 loading 骨架在 chunk 就绪时是**直接卸载**，
  无法做骨架退场动画；因此实现的是"内容侧 200ms 淡入 + 骨架瞬时消失"，
  不是严格意义的双向交叉淡入。若要严格交叉需自管加载态（后续可做）。

### 2.3 截图

- `docs/summit/shots/r41-startup/overview-1366x768.png`
- `docs/summit/shots/r41-startup/overview-1920x1080.png`

截图使用 `shot.mjs --query "startupDebug=1"`（新增 `--query` 参数）保持胶囊展开；
实测可见左下角「系统就绪 3/3」与三行 `OK` 明细。

---

## 3. 验收

```
demo-phase2  : 已到达 阶段 2/4 · 截图成功 · 148 draws / 亮度均值 43.1 / 过曝 0.34%
demo-phase4  : 已到达 阶段 4/4 · 截图成功 · 420 draws / 亮度均值 25.5 / 过曝 0.06%
preflight-fail: 截图成功（真实预检失败流程）
startup 1366 : 截图成功 · 亮度均值 22.5 / 过曝 0.05%
startup 1920 : 截图成功 · 亮度均值 20.8 / 过曝 0.04%
tsc 0 · next lint 干净
```

---

## 4. 未开始（本轮）

- Phase 2：RAG 评测集 + `/api/dev/rag-eval` + README METRICS；
- Phase 3：traceId 贯穿 / 细分 span / usage 成本；
- Phase 4：三路召回 / 端侧像素特征 / 多步工具 / grounding；
- Phase 5：离线模型 / 语音 / AI 质量评测。

---

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard ee56ff5     # 回到 r40
git reset --hard v12-baseline
```