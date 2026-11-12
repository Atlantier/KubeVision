# R70 · 路演去除预估总时长/倒计时，改为阶段 4 事件驱动收尾

> 文件：`src/utils/demoDirector.ts`、`src/components/layout/TopBar.tsx`
> 目标：云端 LLM/MCP 响应慢于“理想总时长”时不再提前截断路演；UI 不再展示不可信的预估秒数/倒计时。

## 1. demoDirector 改造

### 1.1 阶段 4 事件驱动收尾

- **删除** `scheduleFrom` 中基于 `effectiveDurationMs() - elapsed` 的 finish 定时器，
  以及事件门未决时的 6s 重复检查收尾。总时长不再直接触发 `finishDemoDirector()`。
- 新增模块级 `finishHandle` 与 `FINISH_STEADY_HOLD_MS = 4200`。
- 新增 `scheduleFinishAfterSteadyState(generation)`：
  - 仅在 `status === 'running'` 时排布；
  - 非 `narrator` 模式：4.2s 后且 generation/status 未变化时调用 `finishDemoDirector()`；
  - `narrator` 模式：**不自动收尾**，等待主讲人点击「完成」。
- 在 `enterHeal` 的异步闭环、最终旁白/MCP 回执之后调用该函数；
  无受害 Pod 的降级终态也调用，避免永远停在 running。
- `clearAllTimers()` 同步清理 `finishHandle`，停止/重播不会留下幽灵收尾。

### 1.2 进度改为阶段推进

- `publish()` 中 `elapsedMs` 不再被理想总时长截断，字幕条显示真实 T+。
- `progress` 改为：
  - `idle` → 0；`finished` → 1；
  - 运行/暂停：`totalPhases = max(1, phases.length)`，
    `stageInner = min(0.85, phaseElapsedMs / 10000)`，
    `progress = min(0.96, (max(0, phaseIndex) + stageInner) / totalPhases)`。
- 等待云端 LLM 时进度停在当前阶段区间，不会提前满格；阶段 4 完成后进入 finished 才 100%。

### 1.3 日志去除预估秒数

- 启动日志：改为 `（4 阶段全链路实况演练）`。
- 节奏切换日志：仅 `节奏切换为 ${PACING_LABEL[mode]}`，不再附带总时长。
- `recordDemoEffect('setPacing', mode)` 不再写秒数。

### 1.4 讲解模式手动完成

新增导出 `finishDemoDirectorNow()`；TopBar 在 narrator + 阶段 4 时显示「完成」按钮，
调用它进入完成态（保留字幕/进度，8s 后自动收起）。

## 2. TopBar 改造

### 2.1 剧本菜单

- `DemoScriptMenuItem` 删除 `durationMs` 属性与 `约 X 秒 · 4 阶段` 文案；
- 改为 `4 阶段全链路 · 实时 AI 诊断与自愈闭环`；
- 调用方不再传 `durationMs`。

### 2.2 节奏按钮提示

新增 `PACING_HINT`：
- `标准（自动连贯演练）`
- `紧凑（快速切镜演练）`
- `讲解（阶段断点 · 空格推进）`

用于 `aria-label` 与 `title`。

### 2.3 字幕条时间指示

- 删除 `totalSec` 与 `T+... / 00:XX` 分母。
- 新增：
  - `stageCurrent = max(1, phaseIndex + 1)`；
  - `stageTotal = max(1, phases.length)`；
  - `elapsedClock = mm:ss`。
- 右侧指示改为 `阶段 X/Y · T+mm:ss`。
- 删除 `phaseRemainSec` 倒计时；阶段 3 运行中显示呼吸态
  `· 正在等待云端 AI 诊断响应…`。

## 3. 验证

```text
npx tsc --noEmit          → 0 error
npx next lint             → No ESLint warnings or errors
npx next build            → exit 0（4/4 static pages，First Load 177 kB）
node scripts/run-demo-tests.mjs → pass 11 / fail 0
node scripts/verify.mjs --quick → 7/7
```

真实自动路演（最终一次）：

```text
通过 20 · 失败 2
✓ J-1/J-2 全通过
✓ J-3 自愈覆盖 3/3、动作卡 executed
✓ J-4 零 console.error、亮度探针通过
✓ J-5 连跑一致、无 QUEUED
✗ J-3 MCP 回执 actionType 读取 null（间歇性取样时序，前一次跑通过 restart_pod）
✗ J-6 pausedElapsedSec/resumedElapsedSec null（既有字幕格式问题，阶段单调通过）
```

- 关键验证：路演完整跑完，没有在 34s“理想时长”处被固定定时器截断；
  阶段 4 异步自愈完成后才进入收尾。
- 截图：`docs/summit/shots/r10-verify/phase2-lock.png`、`finished.png`。

## 4. 风险

1. `MAX_FLIGHT`/`FINISH_STEADY_HOLD_MS` 均为经验值；超慢设备上 4.2s 展示可能偏短，
   但不会再截断仍在执行的阶段 4 异步链（收尾只由闭环完成触发）。
2. narrator 模式需用户点击「完成」；若用户不操作，状态保持 running（不再自动截断）。
3. J-3 MCP 回执断言仍存在间歇性 null（测试取样时序），J-6 elapsed 为既有问题。
4. 剧本的 `durationMs` 仍保留为元数据/节奏换算基准，但不再作为 UI 展示或收尾依据。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 77db0fa   # R69 相机修复
```