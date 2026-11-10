# R34 · 阶段跳转（未实现）/ 讲解者三行提示 / 术语统一

> 状态：追问 2、3 已落地；**追问 1 未实现**（原因见下，未做假实现）。

---

## 追问 1：阶段跳转与导演一致性 —— ❌ 未实现

需求要求点击步进器时导演**幂等进入该阶段**（重置后续副作用、复位被改动状态、进度/时钟/旁白一致、并发防抖）。

核查结果：`src/utils/demoDirector.ts` 的导出 API 只有
`startDemoDirector / stopDemoDirector / pauseDemoDirector / resumeDemoDirector /
replayDemoDirector / dismissFinishedDemo / togglePauseDemoDirector /
advanceNarratorBreakpoint / setDemoPacing` —— **没有 `jumpToDemoPhase`**。
导演引擎是**一次性时间轴 + 闭包定时器**结构（`phaseIndex` 由 `advance()` 推进，
后续阶段的副作用在各自的定时回调内联执行），"幂等进入任意阶段"需要：

1. 抽出每阶段的进入/退出副作用为可重放入口；
2. 建立副作用注册表并支持逆序回滚；
3. 重算时钟/进度/旁白的统一状态源；
4. 并发跳转防抖与进行中跳转的取消语义。

这属于对导演引擎行为的结构性改造（上一轮约束为"不改导演引擎行为"），
本轮剩余预算不足以安全完成，**因此没有给按钮加跳转、也没有用"假装跳转"的 UI**。
四阶可视化仍是既有 4 个进度圆点（非可点击）。下一轮建议先补 `seekToDemoPhase(index)`
并配套 `DemoEffectTrace` 的回滚，再接 UI 步进器。

---

## 追问 2：讲解者友好三行提示（完成，未截图验证）

`DemoDirectorBar` 底部新增三行（`font-mono text-[10px]`、`aria-live="polite"` 仅在首行）：

1. `下一步`＋
   - 讲解版断点：`按空格继续：即将进入 03 根因诊断`
   - 运行中：`下一阶段：<badge>`
   - 结束：`序列结束：可重播或关闭`
   - 预检失败：`预检未通过：请检查 dev 依赖后重新启动`
2. `当前 <badge> · T+<elapsed>s`（时钟与顶栏一致，来自同一 `demo.elapsedMs`）
3. `Space 继续 / 暂停 · Esc 关闭 · ? 快捷键`

> **未截图验证**：demo-phase2/4 的 shot 在 R33 已超时失败（未定位），
> 本轮没有可用的运行态/断点态截图，不宣称视觉通过。

---

## 追问 3：整体语言一致性审计（完成）

新增 `docs/summit/R15-terminology.md`：

- 统一术语：故障 / 告警 / 自愈 / 处置 / 路演 / 阶段 / 根因 / Pod。
- 句式：「动作 · 对象 · 结果」；禁止感叹号、拟人、Emoji。
- 机械替换（35 个文件）：`修复` → `自愈`、`调谐` → `自愈`；`grep 修复|调谐` = 0。
- **`异常` 未全量替换**：它在代码中同时表示"异常检测/异常比例"等技术语义，
  仓促替换会扭曲可解释性；本轮约定用户可见句式用"故障"，技术上下文保留"异常"（文档已说明）。
- 未覆盖：Toast/Modal 动态拼接文案、demoDirector 旁白逐句重写、术语 lint 规则。

---

## 验收

```
tsc 0 · next lint 干净
verify.mjs     → 33/33（替换后回归通过）
check:a11y     → 0 命中
check:emoji    → 0 命中
grep 修复|调谐 → 0（src 全量）
```

未新增截图（见追问 2 说明）。

---

## 未验证项与风险

1. **追问 1 完全未实现**；需求核心的"跳转一致性"仍缺。
2. **三行提示未截图**，仅在代码层成立；`isPreflightError` 优先级是否正确需运行时确认。
3. **`修复`→`自愈` 的全量替换改变了部分注释与文案语义**，需产品复核（尤其"故障自愈"与"人工处置"的区分）。
4. **`异常` 刻意保留**，可能被误认为未统一；文档已解释理由。
5. 旁白与 Toast 未逐句按术语表重写。

---

## 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard b165840     # 回到 r33
git reset --hard v12-baseline
```