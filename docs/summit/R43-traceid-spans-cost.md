# R43 · TraceId 贯穿 / 细分 span / usage 与成本

> Phase 3 交付：服务端 6 类细分 span、真实 usage tokens、env 单价成本（未配置不填）、
> 错误分支 trace-summary + traceId、前端 traceId 徽标、复盘报告链路摘要、Shift+P 链路预算行、
> MCP 回执 traceId 透传。
> 未完成：审计日志内的 traceId 字段、面板截图、引擎 B 的 tool-call span。

---

## 1. 服务端 span（真实计时，`performance.now()`）

一次真实请求（`verify-stream-integrity`，engine=llm）实测 8 条 span：

```jsonc
{"name":"intent-route","startMs":0.01,"durationMs":0.09,"attrs":{"intent":"FAULT_DIAGNOSIS_AND_HEAL"}}
{"name":"rag-retrieve","startMs":0.12,"durationMs":6.22,"attrs":{"hits":2}}
{"name":"prompt-build","startMs":6.35,"durationMs":0.26,"attrs":{"chars":3539}}
{"name":"llm-first-token","startMs":1568.63,"durationMs":1008.97}
{"name":"llm-total","durationMs":≈15000}
{"name":"tool-call:renderPodMetrics", ...}
{"name":"trace-summary"} → ttft=2577.63ms total=16593ms promptTokens=2672 completionTokens=2496
```

- `intent-route / rag-retrieve / prompt-build` 在流创建前完成，先收集为 `pendingSpanEvents`，
  流开始后一次性补发（顺序保持在正文之前）；
- `llm-first-token` 只在**首个正文 text-delta** 结束（不含本地推理提示），即 TTFT；
- `llm-total` 在 fullStream 结束后结束；
- 每个 `tool-call:<name>` 在 tool-call 到达时开始、tool-result 发出后结束；
- 回落引擎 B 时发 `fallback` span（status=error，attrs.reason=llm-failed）；
  未配置 Key 时发 `fallback`（status=ok，attrs.reason=no-api-key）。

## 2. usage 与成本

- `streamText` 的 `result.usage` Promise 在流结束后 await，tokens 写入 `trace-summary`；
- 成本读取 env 单价（**不硬编码**）：
  - `KV_PRICE_INPUT_CNY_PER_MTOK`
  - `KV_PRICE_OUTPUT_CNY_PER_MTOK`
  两者任一缺失 → `costCny` **不写字段**；前端面板显示「未配置」，不显示 0。
- 本环境未配置单价，因此样例 trace-summary **没有 costCny**；tokens 在引擎 A 成功时已实测（2672/2496）。
- 后续复测遇到 LLM 超时回落，trace-summary 正确变为 `engine=simulator` 且不含 tokens（不冒充）。

## 2.1 实际引擎一致性（本轮修复的真实性缺陷）

首轮实现里 `trace-summary.engine` 取的是 `useLLM`（响应头意图）。实测在 LLM 超时回落时，
trace-summary 仍写 `llm`，与实际执行引擎不符。现在改为跟踪 `actualEngine`：
回落即置 `simulator`，trace-summary / done / error 分支均写实际引擎；
verify-stream-integrity 的断言也改为"与流内最后一个 engine 事件一致"（无事件才回退 header）。

实测回落样例（engine A 超时 6s 后回落）：

```
{"name":"fallback","startMs":608.38,"durationMs":6020.28,"status":"error","attrs":{"reason":"llm-failed"}}
trace-summary: engine=simulator（header 仍是 llm，这是"意图 vs 事实"的正确区分）
```

## 3. 错误分支

- `catch` 分支现在**也发 trace-summary**（engine 与响应头一致），并给 `error` 事件补 `traceId`；
- 前端错误卡片新增 `TraceIdChip`：点击复制，可与服务端 span 对号。

## 4. 前端贯穿点

| 位置 | 实现 |
|---|---|
| 错误卡片 | `TraceIdChip`（读取 trace store，点击复制，`aria-label` 完整） |
| 复盘报告 | `buildPostMortemMarkdown` 后追加「链路追踪摘要」表（traceId/引擎/TTFT/总时长/tokens/成本；缺省写未配置） |
| Shift+P 数据健康 | 新增「链路预算」行：TTFT>2000ms、TOTAL>8000ms 以 amber 显示；engine 区分 LLM/容灾引擎 |
| MCP 回执 | `/api/mcp/execute` 接受可选 `traceId` 并原样回传（**不参与 sha256 审计摘要**，摘要口径不变） |
| 面板 | AgentTracePanel 已有 waterfall + amber 预算 + 诚实边界（r36） |

## 5. 验收

```
verify-stream-integrity : ✓ trace-summary 必达且 engine 一致（spans=8，tokens 出现）
mcp-smoke               : 10/10
traceId 透传测试        : mcp execute receipt traceId=demo-trace-123（见 artifacts）
verify.mjs              : 33/33
tsc 0 · next lint 干净
```

## 6. 未验证项与风险

1. **审计日志（LocalAuditorPanel）仍未带 traceId**——需求四处贯穿只完成错误卡片/复盘/MCP 回执/面板。
2. **AgentTracePanel 无截图**：需要一次真实对话后截抽屉，本轮未做交互式截图脚本。
3. **引擎 B 的 tool-call span 未埋点**（只有 fallback span）；simulator 的卡片下发耗时仍不可见。
4. **成本换算未实测**：env 单价未配置，`costCny` 分支未执行；需在配置单价后复测。
5. `llm-first-token` 的 duration 语义是"从 LLM 调用开始到首 token"，不是整请求 TTFT；整请求 TTFT 以 trace-summary 为准。
6. span 只覆盖 engine A；两个引擎的 span 命名一致性需要后续统一。

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 027b4c1     # 回到 r42
git reset --hard v12-baseline
```