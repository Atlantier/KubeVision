# R38 · MCP 冒烟 / RAG 评测与 METRICS（部分交付）

> 状态：追问 1 完成（10/10 通过）；**追问 2、3 未实现**。
> 未产出评测数字，未把占位内容写进 README METRICS 区块。

---

## 追问 1：MCP Inspector 等价冒烟（完成）

新增 `scripts/mcp-smoke.mjs`（零外部依赖，只用 Node 原生 fetch），等价 MCP Inspector 流程：

`initialize → tools/list → tools/call → ping`，外加未知方法（-32601）与通知（202）两条错误路径。

实测输出：

```
KubeVision AI — MCP 冒烟测试
  端点: http://127.0.0.1:3000/api/mcp

  ✓ initialize  ::  protocolVersion=2024-11-05
  ✓ initialize.capabilities.tools.listChanged=false
  ✓ initialize.serverInfo  ::  {"name":"kubevision-mcp","version":"1.0.0"}
  ✓ tools/list 包含 3 个执行工具  ::  restart_pod, scale_deployment, drain_node
  ✓ tools/list 每个工具都有 object 型 inputSchema
  ✓ tools/call 返回 content[] + isError:false
  ✓ tools/call 回执含 executionId/kubectlCommand/auditDigest/mode  ::  mode=simulated
  ✓ ping 返回空对象
  ✓ 未知方法返回 -32601
  ✓ 通知（无 id）返回 202

汇总: 通过 10 · 失败 0
```

已登记 `pnpm mcp:smoke`；日志：`docs/summit/artifacts/r38-mcp-smoke.log`。

断言覆盖：
- `protocolVersion` / capabilities / serverInfo 逐字段精确匹配；
- 三个工具名齐备且每个 `inputSchema.type==='object'` 且含 `properties`；
- `tools/call` → `content[0].type==='text'`、`isError===false`、回执含
  `executionId / kubectlCommand / auditDigest / mode`（本环境 `mode='simulated'`）；
- `ping` 返回 `{}`；未知方法 `-32601`；无 id 通知 HTTP 202。

## 追问 2：口语+错别字+中英混杂评测集（未实现）

未新增 `src/utils/ragEvalSet.ts` 的口语/错别字/中英混杂用例，未统计"应命中却被拒答"的
误拒率，也无 <5% 目标验证。剩余预算不足；不编造指标。

## 追问 3：README METRICS 自动生成（未实现）

未扩展 `scripts/sync-docs-metrics.mjs`，README 的 METRICS 区块保持原样（由既有
`docs/performance.json` / `docs/verify-summary.json` 生成，未注入未经验证的评测值）。

---

## 未验证项与风险

1. **追问 2、3 完全未做**。
2. mcp-smoke 依赖 dev server 已启动（3000 端口），CI 中需先启动再跑。
3. `tools/call` 在真实集群（`K8S_API_SERVER` 配置）下的 `mode='real'` 分支未冒烟覆盖。
4. auditDigest 仍未做自动复算断言（沿自 R37 的未验证项）。

---

## 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard fea38eb     # 回到 r37
git reset --hard v12-baseline
```