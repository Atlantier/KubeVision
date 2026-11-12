# R2 · 流式链路确定性修复

> 分支 `chore/dead-code-cleanup` · 承 R1(`aef4520`)/R2 样式契约 · 只改流式消费链路，
> 不重构 NDJSON 协议（仅新增 `reset` 事件），不改四语义色，不升级依赖。

## 1. 收尾判定（done 唯一判据）

- `case 'done'`：收到即 `session.markDone()` + `finalize('done')` + `break`，不再等连接关闭。
- 抽出 `consumeLine()`（`chatStreamConsumer.ts`）：`trim → 空行跳过 → JSON.parse → isChatStreamEvent → onEvent`。
- 流末 `parser.flush()`：`decoder.decode()`（stream:false）冲刷残留字节 + 消费最后一条无 `\n` 残行，**截断流不丢尾**。
- 收尾三态：`done`=normal / 未收到=incomplete（气泡底部「回答可能不完整」+ 重新生成）/ 解析出错=error。
- `chatStreamProtocol.ts`：删除只写不读的 `terminalKinds`/`terminalCount`，
  **`doneCount !== 1` 为唯一判据**（0=missing-terminal，>1=duplicate-terminal）；engine/reset 不参与。

## 2. 生命周期收尾（finalize 在任何 await 之前定义）

- 旧缺陷：`let finalize = () => {}` 先占位、`fetch` 成功后才赋真值；`embedQueryText`/`fetch`
  在赋值前抛错 → catch/finally 调到空函数 → `isStreaming`/`copilotStreaming` 永不复位、输入框锁死。
- 现在 `createChatStreamSession()` 在第一个 `await` 之前创建，`finalize` 从第一行起就是真实实现。
- 覆盖路径：端侧像素特征失败 / `embedQueryText` 失败 / fetch 网络异常 / 非 2xx / 无 body /
  读流异常 / 用户停止 / 清空会话 / 组件卸载。`finalize` 幂等（`finalized` 标记），
  catch 与 finally 重复调用不重复出队、不重复补丁。
- `computeViewportPixelFeatures` 移入 `try`；卸载 effect 追加 `abort + finalize('abort') + queue.clear()`。

## 3. 运行时形状校验（zod）

- 新增 `src/utils/chatStreamSchema.ts`：`chatStreamEventSchema`（discriminatedUnion）
  + `isChatStreamEvent()` 守卫。畸形帧走 `onMalformedLine` 降级，**不再整条流崩溃**。
- **同源契约**：`SCHEMA_TYPE_SYNC` 用双向可赋值断言把 `z.infer<typeof schema>` 与
  `src/types/ai.ts` 的 `ChatStreamEvent` 锁死；任一侧漂移 `pnpm typecheck` 直接报错。

## 4. 中止不回落

- `catch` 与 `if (!response.ok)` 首行判 `controller.signal.aborted` → `finalize('abort')` 直接返回；
  **用户主动停止不注入「诊断流意外中断」错误**、不播报。

## 5. trace 换轮

- `sendMessage` 开头 `useAgentTraceStore.getState().begin()`。
- `appendSpan`：traceId 变化即自动换轮（清空上一轮 span/summary），不再拒收新轮。
- `tool-start` 看门狗交由会话 `registerWatchdog`：**建新定时器前先 `clearTimeout(prev)`**，重复 start 不泄漏。
- 卸载 / 全局中止（`copilotAbortToken`）均对活跃会话做幂等 `finalize('abort')`，无遗留 setTimeout。

## 6. 排队改 FIFO

- `createPromptQueue()`（数组 FIFO）替代单槽 `queuedPromptRef`：流式期间连发追加尾部，
  收尾 shift 出队首按序发送，**不丢上下文**；提示条显示剩余条数。

## 7. 中文 JSDoc

`chatStreamConsumer.ts` 的 `createNdjsonLineParser` / `consumeLine` / `resolveFinalizationState` /
`createChatStreamSession` / `createPromptQueue` 均补「设计意图 + 输入输出 + UTF-8 跨 chunk 与半行状态流转」。

## 8. 验收（真实执行）

```text
npx tsc --noEmit                              → 0 error
npx next lint                                 → ✔ No ESLint warnings or errors
npx next build                                → exit 0（4/4 static pages）
node scripts/verify-stream-integrity.mjs      → 全部通过（含 15 条消费内核单测）
node scripts/run-demo-tests.mjs               → pass 11 / fail 0
node scripts/verify-demo.mjs                  → 通过 22 · 失败 0
```

浏览器 E2E（headless Edge / D3D11，`docs/summit/shots/r2-stream/abort-stop.json`）：

```text
streaming started: true
after abort: copilotStreaming=false  inputDisabled=false  liveTimers=0
             hasAbortErrorText=false（未注入中断错误）  hasIncompleteText=false
PASS: input restored + copilotStreaming=false
```

真实 NDJSON 流（165 行）：`reset=1 · done=1 · engine=1`，末行为 `{"type":"done",...}`。

## 9. 未验证项与风险

1. E2E 的 `assistantBubbles` 选择器未命中 DOM 结构（返回 0），"无重复气泡"由
   `finalize` 幂等单测（`patchAssistant` 只执行一次）保证，未做 DOM 级重复计数。
2. 截断流的 incomplete 提示通过单测覆盖真实解析路径，但未在浏览器中断网复现截图。
3. 消息级 `incomplete` 与 `failed` 互斥，二者同时为真的极端场景未定义（会话保证互斥）。
4. `reset` 晚于流前 intent/rag span 下发（既有排序未改），故客户端 reset 只复位消息内容、不清 trace。

## 10. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 478eece   # R74 基线
```