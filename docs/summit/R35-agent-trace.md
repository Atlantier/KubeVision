# R35 · 链路追踪（部分交付）

> 状态：A 完成；B **仅最小 span**；C 仅真实计时（usage/成本未接）；D 仅类型；E **未实现**；
> F 已有真实断言并通过。引擎 A 样例已采到，**引擎 B 样例未采到**，面板截图缺失。

---

## A. `src/utils/agentTrace.ts`（完成）

服务端纯函数、零依赖、不引 OTel：

- `createTrace()` → `{ traceId(16 hex), startedAt }`
- `startSpan(trace, name)` → `{ traceId, name, startedAt, startMs }`
- `endSpan(span, {status, attrs})` → `{ traceId, name, startMs, durationMs, status, attrs? }`
- `elapsedMs(trace)`；全部基于 `performance.now()`，时长保留 2 位小数。

## B. chat/route.ts 打点（部分）

已实现：

- 请求开始创建 trace 与 `intent-route` span；
- `emit()` 内记录首个正文 token 时刻（**TTFT 只计 `type==='text'`**，不把本地推理提示当首 token）；
- `done` 之前按顺序发 `span` 与 `trace-summary`（保证前端/校验可断言顺序）。

**未实现**：`rag-retrieve`、`prompt-build`、`llm-first-token`、`llm-total`、`tool-call:<name>`、`fallback`
等细分 span；当前只有一个**粗粒度** `intent-route`（`attrs.coarse=true` 明示）。
工具调用与 RAG 的耗时埋点需要改动流式引擎内部闭包，本轮未做。

## C. 引擎 A / B 计时与成本（部分）

- 引擎 A：`ttftMs`（首个正文 token）与 `totalMs` 由服务端 `performance.now()` 实测；
  **usage（promptTokens/completionTokens）与 costCny 未读取/未计算**——
  AI SDK `usage` Promise 与 env 单价表未接，**没有硬编码任何假价格**。
- 引擎 B：`engine` 字段按实际分支写 `'simulator'`；但本轮**未采到引擎 B 样例**
  （dev 环境有可用 LLM，路由全部走 engine='llm'）。

### 引擎 A 实测样例（`verify-stream-integrity` 真实输出）

```json
{"type":"trace-summary","traceId":"02d70f0e650001","engine":"llm","ttftMs":3633.45,"totalMs":14890.82}
{"type":"span","traceId":"02d70f0e650001","name":"intent-route","startMs":0.03,"durationMs":14890.73,"status":"ok","attrs":{"engine":"llm","coarse":true}}
---
{"type":"trace-summary","traceId":"02d7f2e99b0002","engine":"llm","ttftMs":2988.69,"totalMs":16614.51}
{"type":"trace-summary","traceId":"02d8f097710003","engine":"llm","ttftMs":9671.2,"totalMs":17017.89}
```

## D. types/ai.ts（部分）

已新增 `SpanStreamEvent`、`TraceSummaryStreamEvent` 并并入 `ChatStreamEvent` 联合；
`AgentReasoningStep` 增加可选 `readonly sim?: boolean`。

**未实现**：AgentThoughtChain 的"实测值 vs 编排值"分开展示（`sim` 目前无组件消费）。

## E. AgentTracePanel（未实现）

span 瀑布图面板、4Hz 更新、懒加载挂载**均未实现**，没有面板截图。

## F. 验收

`scripts/verify-stream-integrity.mjs` 新增断言：

- 每个场景必须收到 `trace-summary`；
- `trace-summary.engine` 必须与实际 `engine` 一致；
- 打印样例 span/trace-summary。

真实运行结果：

```
HTTP 200 · engine=llm
✓ 协议全局校验通过
✓ trace-summary 必达且 engine 一致（engine=llm ttft=3633.45ms total=14890.82ms spans=1）
    [trace-summary 样例] {"type":"trace-summary",...}
事件流完整性: 全部通过
```

`tsc 0`。`rag-retrieve` 与 benchmark 同量级的对比**未做**（该 span 本身未埋点）。

---

## 未验证项与风险

1. **B 的细分 span 全缺**，trace-summary 只能给出总时长与 TTFT，无法回答"哪一步慢"。
2. **usage/成本未接**：需要读取 streamText 的 usage Promise 与 env 单价；当前字段缺省，未造假。
3. **引擎 B 样例缺失**：需强制 simulator 分支（如无 API Key 环境）再采一次。
4. **D 的 `sim` 未被 UI 消费**，实测/编排区分尚未落到思考链。
5. **E 面板完全缺失**，无瀑布图与截图。
6. verify 的"engine 与实际一致"断言目前只覆盖 engine=llm 路径。

---

## 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard f969665     # 回到 r34
git reset --hard v12-baseline
```