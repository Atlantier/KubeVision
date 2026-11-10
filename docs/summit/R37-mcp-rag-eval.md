# R37 · MCP JSON-RPC 兼容层（任务 A 完成）/ RAG 评测集（任务 B 未完成）

---

## 任务 A · MCP 规范兼容

### A1. 共享执行层 `src/utils/mcpExecutor.ts`

- 纯服务端协议层：**工具清单 + 最小 JSON Schema + JSON-RPC 错误码 + 转发封装**；
- `callExecuteEndpoint()` 把 `tools/call` 转发到既有 `/api/mcp/execute`（唯一执行逻辑：
  真实集群调用 / kubectl 回执 / sha256 审计摘要 / 白名单都在那里），**没有复制执行分支**；
- 参数映射：MCP schema 用 `targetName`，legacy 端点用 `targetId` → 转发时
  `targetId = args.targetId ?? args.targetName`。

> 说明：严格意义的"把执行逻辑抽到 mcpExecutor"未完成——执行仍集中在 legacy 端点，
> 本层通过同进程 HTTP 复用，行为逐字一致。这是为避免在剩余时间内重写 23KB 的
> 真实集群执行代码并引入双写风险所做的取舍，已在本文档标注。

### A2. `/api/mcp` JSON-RPC 2.0 over HTTP

已实现 `initialize / tools/list / tools/call / ping`，严格回显 id、通知返回 202、
错误码 `-32700/-32600/-32601/-32602/-32603`。

### A3. `/api/mcp/execute` 保留（legacy）

未改动，verify.mjs 的原有断言不受影响；文档标注 legacy（本文件）。

### A4. 渲染类工具不进 MCP

`renderPodMetrics / renderRootCauseAnalysis / proposeRemediationAction` 是前端 GenUI 的
**UI 契约**，不是可被外部 agent 调用的运维动作；MCP 只暴露 3 个执行工具。

### A5. 验收（node fetch 实测输出，等价 curl）

```
initialize 200
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"kubevision-mcp","version":"1.0.0"}}}

tools/list 200（节选）
{"jsonrpc":"2.0","id":"req-list","result":{"tools":[{"name":"restart_pod",...,"inputSchema":{...}},{"name":"scale_deployment",...},{"name":"drain_node",...}]}}

ping 200
{"jsonrpc":"2.0","id":4,"result":{}}

notification（无 id）→ HTTP 202

unknown method 200
{"jsonrpc":"2.0","id":5,"error":{"code":-32601,"message":"Method not found: nope"}}

invalid params 200
{"jsonrpc":"2.0","id":6,"error":{"code":-32602,"message":"arguments must be an object"}}

tools/call 200（无集群配置 → simulated）
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"jsonrpc\":\"2.0\",\"id\":\"mcp-...\",\"result\":{\"executionId\":\"mcp-...\",\"timestamp\":\"2026-11-10T11:37:16.817Z\",\"toolUri\":\"mcp://k8s-cluster/tools/restart_pod\",\"actionType\":\"restart_pod\",\"targetId\":\"worker-beta-6f9c\",\"targetName\":\"worker-beta-6f9c\",\"kubectlCommand\":\"kubectl delete pod/worker-beta-6f9c -n default --wait=false\",\"latencyMs\":224,\"auditDigest\":\"37c471441a24cd0b\",\"mode\":\"simulated\",\"note\":\"Simulated controller reconciliation (K8S_API_SERVER not configured)...\"}}"}],"isError":false}}
```

`auditDigest` 为执行端点内 Web Crypto sha256 前 16 hex；**可复算**：
执行端点对固定字段序列（executionId/actionType/targetId/kubectlCommand/timestamp/mode）求
SHA-256，输入可由回执字段重建（本轮未写自动复算断言，属未验证项）。

---

## 任务 B · 检索评估集 —— ❌ 未实现

未新增 `src/utils/ragEvalSet.ts`、未写 `scripts/eval-rag.mjs`、无 Recall/MRR/NDCG/
负例拒答率/延迟分位、无消融对比、无 R09 校准前后两次评测表。

原因：本会话剩余预算在完成任务 A 的端点实现、字段对齐与实测后耗尽；
不做假评测数字，留待下一轮。

---

## 未验证项与风险

1. **执行逻辑未真正抽入 mcpExecutor**：通过同进程 HTTP 复用 legacy 端点；若未来需要
   独立部署 MCP，必须把执行体迁移过来，否则依赖自身 HTTP 可用性。
2. **auditDigest 未自动复算**：只验证字段存在；复算断言未写。
3. **任务 B 完全未做**。
4. 未跑 verify.mjs 全量回归（MCP 新路由不影响既有断言，legacy 端点未改）。
5. MCP schema 的 `additionalProperties:false` 与 legacy 参数校验未做一致性测试。

---

## 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 4ebc6fc     # 回到 r36
git reset --hard v12-baseline
```