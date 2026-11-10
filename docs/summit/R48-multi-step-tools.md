# R48 · 多步只读工具（任务 C）

> 已实现：`getPodMetrics / searchRunbooks / getRecentEvents` 三个只读数据工具（真 execute），
> `maxSteps: 3` + `onStepFinish`；只读工具的 tool-call 不进入卡片通道；写操作仍 HITL。
> **未在真实多步推理中验证**：本环境 LLM 持续超时回落 simulate，read tools 未被模型调用。

---

## 1. 工具设计

| 工具 | 参数 | 执行（真实数据） |
|---|---|---|
| `getPodMetrics` | `podId` | 从 `clusterContext.faultyPods` / `selectedPodSnapshot` 查找真实 Pod，返回 status/cpu/mem/restarts/nodeId；找不到返回 `{error:'pod not found in observation context'}`（不编造） |
| `searchRunbooks` | `query`、`topK(1..5)` | 直接调用 `retrieveSreRunbooks`（复用同一检索引擎/三路能力），返回 id/title/score |
| `getRecentEvents` | `limit(1..10)` | 从观测派生事件：非 Ready 节点、异常 Pod、集群健康分与 chaos |

## 2. 多步与协议隔离

- `streamText({ maxSteps: 3, onStepFinish })`：允许"调用只读工具 → 结果回灌 → 继续推理"，
  最多 3 个 LLM 步骤；
- 只读工具的 tool-call 在 `fullStream` 中会被 `READ_ONLY_TOOL_NAMES` 拦截并 `continue`：
  **不发 tool-start / tool-result、不推进 MCP 步骤、不登记 emittedToolNames**；
  因此前端不会出现"读数据却弹卡片骨架"的错误事件流；
- 写操作（`proposeRemediationAction`）仍只产出卡片，真正执行由用户在 `ActionConfirm` 二次确认
  （MCP `/api/mcp/execute`），模型永不直接执行写操作。

## 3. 验收

```
tsc 0 · next lint 干净
verify-stream-integrity：全部通过（3 场景 trace-summary 必达、engine 一致、无孤儿 tool-start）
```

- 由于本环境 `engine=llm` 持续在 ~6s 超时后回落 `simulator`，**只读工具没有被模型实际调用过**；
  simulator 路径不挂工具，因此本次回归只证明"原有事件流未被破坏"，不证明多步工具可用。

## 4. 未验证项与风险

1. **多步链路未实测**：需要 LLM 网络正常时，观察 `getPodMetrics/searchRunbooks` 被调用、
   结果回灌后模型继续产出最终卡片；当前环境无法触发。
2. **工具参数校验依赖 AI SDK + Zod**，模型可能传错 Pod 名；找不到时返回 error 字符串（安全），
   但模型是否据此纠正未验证。
3. **maxSteps=3 的 token 成本上升**：每次请求最多 3 轮 LLM 调用；未做成本上限保护
   （已有 env 单价成本字段，但未按请求 budget 熔断）。
4. **getRecentEvents 是"观测派生"**，不是真实事件历史（无事件存储）；命名与文档已注明。
5. 只读工具仅在 `allowedTools.length > 0` 时挂载，寒暄路径不挂（省 token）。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 7d1cb48     # 回到 r47
git reset --hard v12-baseline
```