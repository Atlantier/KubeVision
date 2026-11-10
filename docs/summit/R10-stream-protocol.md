# R10 · NDJSON 双引擎流式协议修复

> 本轮针对 9 条流式链路缺陷：先写"复现断言"（红），再修，最后断言转绿。
> 交付包含真实输出、缺陷→根因→文件:行号→断言对照表、第三张卡片截图、回滚命令。

---

## 0. 修复总览

| # | 缺陷 | 根因 | 状态 |
|---|---|---|---|
| A1 | 引擎 A 失败回落后重复产出卡片 | 两个引擎各自维护"已产出"集合，回落时引擎 B 无条件重发三卡 | ✅ 修复 |
| A2 | 第三张卡片（MCP 动作卡）永远骨架屏 | ① 历史摘要用错工具名别名 `renderActionCard`；② 引擎 A 已发 tool-start 后失败，无人补 result；③ 前端无超时兜底 | ✅ 修复 |
| A3 | 停止生成后消息级 isStreaming 不复位 | abort 分支不写收尾状态，只有正常结束分支写 | ✅ 修复 |
| A4 | sleep() 的 abort 监听器不移除 | 只 `addEventListener({once:true})`，正常 resolve 路径从不移除 | ✅ 修复 |
| A5 | 流式期间"快照诊断"被静默丢弃 | `sendMessage` 里 `if (isStreaming) return` | ✅ 修复（排队 + 提示 + 自动发送） |
| A6 | TTS 副作用在 setMessages updater 内，StrictMode 双播 | 播报调用写在 React updater 函数里 | ✅ 修复（ref + effect） |
| A7 | 复盘报告用导出时刻快照 | 报告直接读当前 clusterContext | ✅ 修复（事故前快照 + 前后分节） |
| A8 | 缺少事件契约金样 | 无 fixture、无全局协议断言 | ✅ 修复（fixture + 校验器 + mock） |
| A9 | 错误态不统一 | 只有一行 [ENGINE-ERROR] 文本，无分类/无 requestId | 🟡 部分（错误分类 + requestId + 卡片 8s 看门狗；3s 无解释提示未实现） |

---

## 1. 核心抽象：`src/utils/chatStreamProtocol.ts`

缺陷 A1/A2/A8 的共同点是**事件流的全局性质**，无法在单个函数里修复。
新增零依赖纯模块（可在 Node 中直接转译测试）：

- `createToolCallLedger()` —— 单请求工具调用账本（toolCallId → 状态 + 已完成工具名集合）；
- `missingToolNames(ledger, allowedTools)` —— 回落后"还差哪张卡"，引擎 B 只补差集；
- `repairPendingToolCalls(ledger, emit, reason)` —— 为悬空 tool-start 补发
  `status:'error'` 的 tool-result（A2 服务端侧）；
- `validateStreamEvents(events)` —— 校验：无重复 toolCallId / 无孤儿 result /
  无未配对 start / 流末必达 done / reasoning stepIndex 严格递增；
- `countDuplicateCardNames(events)` —— 按工具名统计重复卡片（A1 断言）。

---

## 2. 缺陷 → 根因 → 文件:行号 → 新增断言

### A1 回落重复卡片

- **根因**：`streamWithLLM` 内部 `emittedToolNames` 只在引擎 A 内可见；
  回落后 `streamWithSimulator` 从零开始，把三张卡全部重发。
- **修复**：请求级共享 `ToolCallLedger`（`route.ts:2799` 附近创建并传给两个引擎）；
  引擎 B 改为 `missingToolNames(ledger, allowedTools)`（`route.ts:2083`），只补缺失。
- **断言**：`scripts/verify-stream-integrity.mjs` A8-2 → `无重复卡片`；
  `--repro` 模式断言旧行为**确实重复**（`重复卡片: renderPodMetrics`）。

### A2 第三张卡片永久骨架屏

三个独立成因，全部修复：

1. **工具名别名漂移**（历史多轮摘要缺失同源）：
   `summarizeToolCardsForHistory` 判断 `card.toolName === 'renderActionCard'`，
   而服务端发的是 `proposeRemediationAction` → 动作卡分支永不命中。
   现在统一到 `src/types/ai.ts` 的 `TOOL_NAME` 常量表 + `classifyToolName()`，
   前端 `isPodMetricsTool/isRootCauseTool/isActionTool` 全部委托它。
2. **悬空 tool-start**：引擎 A 发 start 后失败无 result → 骨架悬空。
   回落前调用 `repairPendingToolCalls()` 补发 `status:'error'`（route.ts:2799）。
3. **前端无限等待**：新增 8 秒看门狗（`SKELETON_WATCHDOG_MS=8000`，CopilotDrawer:218），
   超时卡片转 `state:'error'` + 可读原因；`finalize()` 再把流结束时的残留骨架兜底清理。
- **断言**：`probe-action-card.mjs` —— `三张卡全部挂载`、`无残留骨架屏`；
  协议侧 `无未配对 tool-start`。

### A3 停止生成后 isStreaming 不复位

- **根因**：`catch` 的 abort 分支不写消息态；`finally` 只清理孤儿卡片。
- **修复**：抽出 `finalize()`（CopilotDrawer: 流读取循环前定义），
  正常结束 / 异常 / abort 三条路径统一调用（幂等）；保留已产出内容，
  `isStreaming=false` 后朗读按钮随 `!isStreaming` 条件自动恢复。
- **断言**：abort 后 `message.isStreaming === false`（运行时探针可验，见风险节）。

### A4 sleep() abort 监听器泄漏

- **根因**：`addEventListener('abort', ..., { once:true })` 只在 abort 发生时移除；
  正常完成路径下监听器一直挂在同一个 AbortSignal 上。一次请求调用 sleep 数十次。
- **修复**：命名 `onAbort`，`resolve` 与 `abort` 两条路径都 `removeEventListener`（route.ts:904）。
- **断言**：**未实现自动断言**。sleep() 定义在路由模块内部，Node 侧无法直接 import；
  若要"单请求监听器数量不增长"的硬断言，需把 sleep 抽到独立工具模块并注入计数。
  当前只有代码级修复（removeEventListener 双向配对），如实标注。

### A5 流式期间快照诊断被静默丢弃

- **根因**：`sendMessage` 开头 `if (text.length === 0 || isStreaming) return;`。
- **修复**：`isStreaming` 时写入 `queuedPromptRef` + 显示"已排队"提示；
  `finalize()` 中取出队列并在下一帧自动发送（`sendMessageRef` 保证用最新闭包）。
- **断言**：流式期间发送 → `排队提示` 出现且原请求不丢（探针可验）。

### A6 TTS 副作用在 setMessages updater 内

- **根因**：`patchMessage` 的 updater 里调用 `speakMessage`。React StrictMode 双调用 updater。
- **修复**：finalize 只 `setSpeechRequest({messageId, nonce})`；
  独立 `useEffect` 在 messages 提交后找到该消息并播报一次（CopilotDrawer:1260 附近）。
- **断言**：StrictMode 下播报次数为 1（需音频环境，标记为未验证）。

### A7 复盘报告用导出时刻快照

- **根因**：`buildPostMortemMarkdown({ clusterContext: buildClusterContext() })` 读实时值。
- **修复**：`PostMortemInput.incidentBefore`（`postMortemReport.ts:81`）由调用方从
  `store.lastRemediationDiff.beforeHealth` 填充（CopilotDrawer:1392）；
  新增「事故基线（事故发生时刻 vs 报告生成时刻）」章节，无事故时明确写
  "稳态巡检，无事故"（postMortemReport.ts:1175）。
- **断言**：报告含「事故基线」章节且 before≠after 时正确展示差值。

### A8 事件契约金样

- **新增**：`tests/fixtures/engine-b-stream.jsonl`（只读金样）+ `--record` 录制模式；
- 断言：事件构成（start=3/result=3/text>0/engine=1/done=1）、顺序合法、
  无孤儿 result、无重复 toolCallId、流末必达 done、reasoning 步骤数达标；
- 引擎 A 路径用 **mock 事件流**注入同样断言（协议模块直接驱动，无需真实模型）。

### A9 统一错误态

- `types/ai.ts` 新增 `CHAT_ERROR_CATEGORY`（network/model/tool_args/server/abort）+
  `CHAT_ERROR_COPY`（标题/建议/可重试性，文案唯一来源）+ `ChatStreamErrorEvent`
  （带 `requestId`）+ `ChatStreamDoneEvent`（终止事件）；
- 服务端异常分支推 error 事件并携带 requestId（route.ts: 异常处理块）；
- 前端按分类渲染失败提示（旧文案作为兜底），并展示请求 id；
- **部分完成**：任务要求的"任何转圈无解释 > 3s 不允许"只实现了卡片级 8s 看门狗，
  全局 3 秒无事件提示尚未实现（见风险）。

---

## 3. 复现断言（红）与修复后断言（绿）

### 3.1 红：旧行为确实破坏不变量

```
$ node scripts/verify-stream-integrity.mjs --repro
A1/A2 缺陷复现（旧行为，预期失败）
  旧行为事件流: 10 条
  未配对 tool-start: 存在（应为存在=缺陷复现）
  重复卡片: renderPodMetrics
  ✓ 缺陷已复现（红）：孤儿 start + 重复卡片，正是 A1/A2 的现象
（退出码 0 = 复现成功；日志 docs/summit/artifacts/r17-stream-repro-red.log）
```

### 3.2 绿：修复后同一脚本全绿

```
$ node scripts/verify-stream-integrity.mjs
（三个真实场景 + 金样 + mock，全部通过）
  HTTP 200 · engine=llm
  ✓ 协议全局校验通过（无重复 id / 无孤儿 result / 无未配对 start / 流末有终止）
  ✓ 无孤儿 tool-start（每个 start 都有配对 result）
  ✓ 三张卡齐全
  ✓ 动作卡载荷合法
A8-1 引擎 B 事件契约金样（只读 fixture，禁止手改）
  事件构成: reasoning=3 start=3 result=3 text=309 engine=1 done=1
  ✓ 顺序合法 / 无孤儿 result / 无重复 toolCallId / 流末有终止事件
  ✓ 三卡齐全（start=3 result=3）
  ✓ reasoning 步骤数达标（3 >= 3）
  ✓ 流末必达 done（终止事件唯一）
A8-2 引擎 A mock：中途失败回落（修复后行为）
  修复后事件流: 16 条 · 孤儿修复 1 条 · 引擎 B 补卡 2 张
  成功卡片: renderPodMetrics, renderRootCauseAnalysis, proposeRemediationAction
  ✓ 协议校验全绿
  ✓ 无重复卡片（回落只补缺失，A1 修复生效）
  ✓ 无未配对 tool-start（A2 修复生效）
事件流完整性: 全部通过（无骨架屏悬空风险）
（日志 docs/summit/artifacts/r17-stream-green.log）
```

### 3.3 第三张卡片运行时断言

```
$ node scripts/probe-action-card.mjs
✓ Copilot 抽屉已挂载
触发方式: {"via":"textarea-enter"}
卡片状态: {"metrics":1,"rootCause":1,"action":1,"skeletons":0,"failedCards":0}
✓ 三张卡全部挂载（含第三张 MCP 动作卡）
✓ 无残留骨架屏（第三张卡不再无限转圈）
✓ 无失败态卡片
✓ 截图已存档 .\docs\summit\shots\r17-action-card\third-card-after-fix.png
汇总: 通过 5 · 失败 0
```

**截图**：`docs/summit/shots/r17-action-card/third-card-after-fix.png`
—— 右侧抽屉第三张「自愈操作确认」卡完整渲染（动作 restart_pod、目标
payment-gateway-7f8b9-x2k、mcp://k8s-cluster/tools/restart_pod、可用"立即执行"按钮），
页面无任何骨架屏。

> **关于"修复前截图"**：该缺陷的触发条件是"引擎 A 部分产出后失败回落"。
> 本机 dev server 配置了真实 API Key，引擎 A 正常成功，无法在正常路径下
> 截到悬空骨架；因此修复前的证据采用**协议级复现**（§3.1 红），
> 而不是伪造一张截图。这一点如实标注。

---

## 4. 回归

| 项目 | 结果 |
|---|---|
| `node scripts/verify.mjs` | **33 项 / 通过 33 / 失败 0** |
| `verify-stream-integrity`（含金样+mock） | 全部通过 |
| `probe-action-card` | 5/5 |
| `tsc` | 0 错误 |
| `next lint` | 干净 |

---

## 5. 未验证项与风险

1. **A6 StrictMode 双播未做音频级验证**：无头环境无音频输出；只能保证副作用已移出 updater
   （代码级）+ effect 只执行一次（逻辑级）。
2. **A9 的"3 秒无解释"未实现**：目前只有卡片级 8 秒看门狗与结构化错误事件；
   流开始时若服务端长时间无任何事件，前端仍只显示打字光标。后续应加"等待服务端响应"提示。
3. **A8 金样并非严格"引擎 B"录制**：本机 dev server 配置了 API Key，
   `--record` 录到的是引擎 A 的完整流（同样满足契约：3 卡 + done）。
   无 Key 环境（CI）重新 `--record` 即可得到引擎 B 流；校验器对两者一视同仁。
4. **A2 的"引擎 A 中途失败"只在 mock 层验证**：真实模型中途失败难以稳定构造，
   建议用可注入故障的代理复现。
5. **A5 排队只保留最后一条**：连续多次排队会覆盖前一条；符合"最新意图优先"的直觉，
   但如果用户连点两个不同诊断，第一条会丢。

---

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 9ceb3f2        # 回到 r16
git reset --hard v12-baseline
```