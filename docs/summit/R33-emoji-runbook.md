# R33 · Emoji 清零 / 路演入口与序列器 / 旁白规范（部分交付）

> 状态：A 完成；B、D 完成；C 仅"最小序列器化"（未做四阶可点击步进器与三态截图）；
> E、F、G **未实现**。demo-phase2/phase4 截图因路演未在超时内到达目标阶段而失败，
> 已如实记录，不伪造截图。

---

## A. Emoji 与「AI 味符号」清零（完成）

扫描口径：Node 正则 `\p{Extended_Pictographic}`，范围 `src` 下 ts/tsx/css/md。

| 阶段 | 结果 |
|---|---|
| 扫描前 | **18 个字符**（16 行）：`↔` 箭头 11 处、`⏸` 2 处、`▶` 3 处、`⏹` 2 处 |
| 替换规则 | `↔` → `<->`；`⏸` → `[PAUSE]`；`▶` → `[PLAY]`；`⏹` → `[STOP]` |
| 扫描后 | **0 命中**（`node scripts/check-emoji.mjs` exit 0） |

另清理 "AI 味" 元素：
- lucide `Sparkles` 图标 6 处（CopilotDrawer×2、LocalAuditorPanel×2、RagKnowledgeModal、NodeInspectHUD）
  → 全部替换为 `Radar`（运维语义），ClusterCanvas 的 drei `<Sparkles>` 粒子（3D 场景）不受影响；
- 新脚本 `scripts/check-emoji.mjs` 同时扫描紫粉渐变 / lucide Sparkles / 拟人助手文案，
  命中 exit 1；已登记 `pnpm check:emoji`。

## B. 路演入口按钮（完成）

- 移除 `Clapperboard`（含 lucide import）→ 改用 `Radar`；
- 顶栏路演控件保持「路演」文案 + 等宽副标 `AUTO RUNBOOK`（窄屏折叠由既有响应式控制）；
  运行中状态徽标仍由引擎 `demo.badge` 提供（阶段号），未改导演行为。
- 说明：入口按钮的 DOM 在 TopBar 的路演控件区，未新增交互逻辑。

## C. 路演控制面板（部分）

已完成（最小序列器化，`DemoDirectorBar`）：
- 容器改为 `.kv-panel` + `border-white/[0.075]` + `inset 0 1px 0 rgba(255,255,255,.08)`；
- `role="region" aria-label="自动演练序列器"`（原 `role="status"` 移除）；
- 顶栏徽标改为 `RUNBOOK · 自动演练`；
- 任务时钟改为 `T+00:12.4 / 00:34.0` 格式（`font-mono tabular-nums`，`aria-live="off"`）；
- 暂停/终止/重播/关闭按钮、预检失败红框逻辑保持原样（aria-label 未改，verify 不受影响）。

**未完成**：
- 四阶**文本步进器**（01 稳态基线 / 02 故障注入 / 03 根因诊断 / 04 受控自愈）与完成态 `OK`——
  引擎没有 `jumpToDemoPhase` 导出，按要求"不改导演引擎行为"，无法实现可点击跳转；
  现有 4 个进度圆点只是状态指示；
- 四角角标、底部 `STAGE-02 / CHAOS_INJECT` 行、结束态 `healthBefore → healthAfter / healed X/Y`；
- 预检失败态的"重新检测"按钮（当前只有关闭）。

## D. 旁白文案规范（完成，机械清理）

- 全文件 `！` → `。`（0 感叹号）；
- 删除拟人开场：`AI 运维副驾正在…` → `检索 SRE Runbook 知识库 · 生成交互式诊断卡片` 等 4 条；
- `▶/⏸/⏹` 终端日志改为 `[PLAY]/[PAUSE]/[STOP]`。
- **未做**：全量旁白逐句改写为「动作 · 对象 · 结果」三要素（仍有 `...` 与"正在"类措辞）。

## E / F / G（未实现）

- E 抽屉空态与 4 张战术指令卡未改；
- F 1366×768 遮挡验证未做（demo 截图失败）；
- G 阶段节点 `role="tab"`、`aria-live` 分区（时钟已有 `aria-live=off`，阶段切换的 polite 区域未加）。

---

## 验收

```
node scripts/check-emoji.mjs     → 0 命中（106 文件）
node scripts/check-a11y.mjs      → 0 命中（沿用 R31 门禁）
tsc 0 · next lint 干净
shot overview 1366×768          → 亮度均值 22.6 / 过曝 0.06%，console error=0
shot overview 1920×1080         → 亮度均值 20.6 / 过曝 0.05%，console error=0
shot demo-phase2 1366           → ❌ 未在 20s 内到达阶段 2/4
shot demo-phase4 1366           → ❌ 未在 40s 内到达阶段 4/4
```

截图：`docs/summit/shots/r33-runbook/overview-{1366x768,1920x1080}.png`；
**序列器三态截图缺失**（运行/结束/预检失败均未取得）。

> 路演超时原因未定位：入口点击与预检是否通过需人工在 dev 页面复查；
> 该失败不能排除是本轮 TopBar 改动引入，需优先排查后再交付序列器视觉。

---

## 未验证项与风险

1. **C 项四阶步进器/角标/底部行/结束指标未实现**；引擎无 `jumpToDemoPhase`，需先补只读 seek API。
2. **序列器三态截图全部缺失**，路演 shot 超时原因未定位。
3. **E/F/G 未做**，1366×768 遮挡未验证。
4. **D 仅为机械清理**，旁白未全部改写成事实句式。
5. 替换 `Sparkles` → `Radar` 后各 AI 面板的图标语义需设计复核。

---

## 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 6496ff6     # 回到 r32
git reset --hard v12-baseline
```