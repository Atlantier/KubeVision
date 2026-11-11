# R64 · 自动路演阶段 4 `0ms` vs `600ms` 自愈竞态修复

> 文件：`src/utils/demoDirector.ts`（另修正 `scripts/verify-demo.mjs` 的异步取样与嵌套模板转义）
> 症状：自动路演阶段 4 的 `ActionConfirm` 卡片翻红「免疫窗口内不可重复自愈，剩余 30 秒」，不出现绿色 done 与 `[OK] [MCP Verification]`。

## 1. 根因（确认）

`enterHeal` 在 `button.click()` 后 **同一同步宏任务内（0ms）** 读取
`actions().healedPodIds` 并补齐 `remaining`：

```ts
button.click();
const healedAfterHitl = new Set(Object.keys(actions().healedPodIds)); // 仍为空
const remaining = victimIds.filter(...);                              // 包含卡片目标
for (const victimId of remaining) actions().healEntity(victimId, podAction);
```

但 `ActionConfirm.handleExecute` 要等 **600ms 流光动画 + `/api/mcp/execute`**
（`await Promise.all([requestDone, animationDone])`）才调用 `healEntity`。
导演提前把卡片目标写进 30s 免疫表，600ms 后卡片再治愈就被 Store 拒绝：
`{ ok:false, code:'immunity', message:'免疫窗口内不可重复自愈，剩余 30 秒' }`。

## 2. 修复

### 2.1 等待卡片自身完成

点击后读取卡片的 `data-target-id`，并用 `pollUntil` 最多等 **3500ms**：

```ts
let executedCardTargetId: string | null = null;
if (button !== null && !button.disabled) {
  button.click();
  executedViaUi = true;
  executedCardTargetId = card.getAttribute('data-target-id');
}
let cardHealed = false;
if (executedViaUi) {
  cardHealed = await pollUntil(
    (): boolean =>
      executedCardTargetId !== null && executedCardTargetId.length > 0
        ? actions().healedPodIds[executedCardTargetId] !== undefined
        : Object.keys(actions().healedPodIds).length > 0,
    3500,
    DOM_POLL_MS,
    generation,
  );
  if (generation !== runGeneration) return;
}
```

只有等待完成后才计算 `healedAfterHitl` / `remaining`，卡片目标已被排除，
导演只补齐**其余**同批次受害者。

### 2.2 避免重复 `/api/mcp/execute`

`executedViaUi === true` 时，卡片自己已经发起真实请求并写入 `[MCP-ROUTER]`；
`repairMcpReceipt(...)` 只在 `!executedViaUi` 的兜底路径调用。
为了不影响 `verify-demo` 的 J-3 回执断言，导演在卡片落库后补一条**纯日志**
（不发起第二次 HTTP POST）：

```ts
[MCP 回执] redis-cluster-shard-0 · restart_pod 已完成（动作卡自身 /api/mcp/execute；导演未重复 POST）
```

该日志在终态旁白之前写入，避免 verify 在阶段完成瞬间取样读不到。

### 2.3 验证脚本修正（配套）

`scripts/verify-demo.mjs` 的 `READ_STATE` 是嵌套模板字符串：
`\s` 会被外层模板求值成字面量 `s`，必须写成 `\\s` 才能让浏览器拿到 `\s`。
R64 修正了这两处转义；同时在读取 `final` 后最多等 6s（30×200ms）直到
`mcpAction` 出现，避免“剧本已完整跑完”先于 MCP 回执写入造成误报 null。
这是测试取样修正，不是放宽断言：仍要求 `mcpAction === 'restart_pod'`。

## 3. 验证

### 3.1 单测

```text
node scripts/run-demo-tests.mjs
pass 11 · fail 0 · line coverage 97.43%
```

### 3.2 自动路演（真实浏览器，`scripts/verify-demo.mjs`）

关键结果（最近一次完整跑）：

```text
✓ J-3 自愈覆盖全部受害 Pod                  :: 3/3
✓ J-3 MCP 回执 actionType 与场景映射一致     :: restart_pod
✓ J-3 动作卡终态为 executed（无 pending 并存）
✓ J-5 第二遍无 QUEUED 免疫日志               :: 增量=0
✓ J-5 连跑两遍受害者数量一致                :: 3 → 3
```

运行日志确认不再出现“免疫窗口内不可重复自愈”：
终端只有 `[KUBE-CONTROLLER] Executed restart_pod ...`、`[MCP 回执] ... 已完成`
与 `[DEMO-DIRECTOR] HITL 卡片已自行发起 /api/mcp/execute，导演跳过重复 MCP 回执请求`。

汇总仍为 **通过 19 · 失败 3**，剩余失败与本轮竞态无关：

1. `J-2 三张 GenUI 卡片齐全`：最后一次跑在慢环境/流式时序下只捕获到 metrics 卡
   （同一修复的前几次跑 J-2 通过；属于既有 AI 流时序抖动，见风险台账）；
2. `J-4 全流程零 console.error / 零未捕获异常`：`pageErrors:["Uncaught"]`，既有问题；
3. `J-6 恢复后进度单调不回退`：`pausedElapsedSec/resumedElapsedSec` 读取为 null，
   既有字幕格式问题（阶段单调本身通过）。

失败现场：`docs/summit/failures/2026-11-11T11-55-35-650Z/`（J-2/J-4/J-6）。
截图：`docs/summit/shots/r10-verify/phase2-lock.png`、`finished.png`。

## 4. 未验证 / 风险

1. 最后一次跑的 J-2 卡片缺失是流式时序抖动，不是本轮代码改动引起；未做无限重跑直到全绿。
2. J-4 `Uncaught` 与 J-6 elapsed null 是既有未解问题，本轮未处理。
3. 3500ms 等待是经验值（600ms 动画 + 本机 MCP 约 220ms + 慢渲染余量）；
   更慢机器上可能仍超时，超时会走导演补齐兜底并输出“未确认”日志，不伪造成功。
4. 自动路演仍是 dev/SwiftShader 环境验证；真实 GPU/生产网络未覆盖。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 30f8d3e   # R63 机架环境反射修复
```