# R3 · 流式确定性门禁（可回放 / 可对抗）

> 承 R2 (`779c3e9`)。目标：把 R2 修好的流式链路变成**可回放、可对抗、可计量**的门禁，
> 并把协议校验引入开发期生产路径。不重构协议、不改演示选择器、不改四语义色。

## 1. 确定性对抗探针 `scripts/probe-stream-determinism.mjs`

用金样 `docs/summit/artifacts/r17-stream-fixture.jsonl`（320 行：原子构成 3 reasoning /
309 text / 3 tool-start / 3 tool-result / 1 engine / 1 done）回放，注入 8 类扰动，各 20 次。

**关键：探针不另写解析逻辑**——它转译并 `require` 生产同款
`src/utils/chatStreamConsumer.ts`，与抽屉共用 `createNdjsonLineParser` /
`createChatStreamSession` / 消息变换。因此结论代表线上行为，不是平行实现。

| # | 扰动 | 注入方式 |
|---|---|---|
| 1 | `chunk-half` | 把字节流切成 2~7 字节碎片（最恶劣 chunk 边界） |
| 2 | `proxy-buffer` | 攒 1~3 个 chunk 再一次性爆发 |
| 3 | `malformed-frame` | 插入坏 JSON 行（另测缺字段/未知 type） |
| 4 | `mid-abort` | 在 ~55% 字节处切断 |
| 5 | `stop-resend` | abort 后立即重发完整流 |
| 6 | `dup-tool-start` | 每个 tool-start 再插一次 |
| 7 | `foreign-trace` | 改写 span/trace-summary 的 traceId |
| 8 | `no-done` | 删除 done 事件 |

5 个失败维度：**卡住**（收尾后 streaming 未复位）/ **丢帧**（text/reasoning/ready 少于期望）/
**重复卡**（同 toolCallId 多张）/ **误回落**（切断被当 failed 硬错误）/ **乱码**（U+FFFD）。

### 8×20 结果

```text
✓ chunk-half       runs=20  卡住=0 丢帧=0 重复卡=0 误回落=0 乱码=0
✓ proxy-buffer     runs=20  卡住=0 丢帧=0 重复卡=0 误回落=0 乱码=0
✓ malformed-frame  runs=20  卡住=0 丢帧=0 重复卡=0 误回落=0 乱码=0
✓ mid-abort        runs=20  卡住=0 丢帧=0 重复卡=0 误回落=0 乱码=0
✓ stop-resend      runs=20  卡住=0 丢帧=0 重复卡=0 误回落=0 乱码=0
✓ dup-tool-start   runs=20  卡住=0 丢帧=0 重复卡=0 误回落=0 乱码=0
✓ foreign-trace    runs=20  卡住=0 丢帧=0 重复卡=0 误回落=0 乱码=0
✓ no-done          runs=20  卡住=0 丢帧=0 重复卡=0 误回落=0 乱码=0

扰动总数: 8 × 20 = 160 次 · 零缺陷
```

**能红能绿**：临时移除 `finalize` 里的 `setStreaming(false)/setCopilotStreaming(false)`
→ 8 类全部 20/20 命中「卡住」（exit 1，160 缺陷）；恢复 → 全 0（exit 0）。证明探针不是常绿摆设。
证据：`docs/summit/artifacts/r3-stream-determinism.json`。

## 2. 请求竞态矩阵 `scripts/probe-request-race.mjs`

真实浏览器（headless Edge / D3D11 / 1366×768）制造 5 类竞态，断言 10 项：

| 场景 | 断言 | 结果 |
|---|---|---|
| A 快速连发 5 条 | 首条进流式、出现「停止」按钮、无发送按钮、assistant 气泡=1 | ✓ |
| A | 连发期间零 console.error / 零未捕获异常 | ✓ 0 errors |
| B 流式中切页签（拓扑↔审计） | 无卸载后更新、无异常 | ✓ 0 errors |
| B | 切页签后气泡不重复 | ✓ 1 |
| C 流式中关抽屉 | 无 setState-on-unmounted | ✓ 0 errors |
| C | 关闭后 copilotStreaming 复位、停止按钮消失 | ✓ |
| D 流式中刷新 | 无卸载后更新、无异常 | ✓ 0 errors |
| D | 刷新后 copilotStreaming=false、textarea 可用、无残留气泡 | ✓ |
| E 刷新后再发送 | 能正常进入流式（链路未卡死） | ✓ |
| E | 全矩阵零 console.error / 零未捕获异常 | ✓ 0 errors |

**10/10 通过**。证据：`docs/summit/artifacts/r3-request-race.json`。

> 输入区可用性的真实契约（探针按此测量，而非猜测）：流式中发送按钮被「停止」按钮
> **条件替换**（不是 disabled）；恢复后出现可用发送按钮、停止按钮消失。

## 3. 开发期协议断言（生产零开销）

`CopilotDrawer` 收尾前，`NODE_ENV !== 'production'` 时把已分发事件交给
`validateStreamEvents`（重复 id / 孤儿 result / 未配对 start / done 唯一），违例打
`console.error('[stream-protocol] …')`。

```text
源码: process.env.NODE_ENV === 'production' ? null : []   ← 生产恒 null
       dispatch 内 if (devCollected !== null) push
       finalize 内 validateStreamEvents(devCollected)
产物: 'stream-protocol' 不出现在 .next/static/chunks/*.js  → 生产已 tree-shake
      verify:demo J-4「全流程零 console.error」仍 ✓（开发期断言未误报）
```

## 4. 反作弊自查（逐条）

| 约束 | 落实 |
|---|---|
| 不许把 sleep 改 0 但不并行化冒充优化 | 未改任何 sleep/延时；两个探针均为串行真实测量，未声称加速 |
| 不许 reset 清空整个消息列表（须保留工具卡片） | `resetRound` 只清 `text`/`reasoningSteps`，**`toolCards` 原样保留**；探针 `dup-tool-start` 20/20 验证卡片不丢 |
| 不许 schema 失败用默认值填充 | `consumeLine` 校验失败即 `onMalformedLine` → `markParseError()` → 收尾 error；**无任何默认值兜底** |

## 5. 验收（真实执行）

```text
npx tsc --noEmit                          → 0 error
npx next lint                             → ✔ No ESLint warnings or errors
npx next build                            → exit 0（4/4 static pages）
node scripts/probe-stream-determinism.mjs → 8×20 全零缺陷（exit 0）
node scripts/probe-request-race.mjs       → 10/10 通过（exit 0）
node scripts/verify-stream-integrity.mjs  → 全绿（含 15 条消费内核单测）
node scripts/run-demo-tests.mjs           → pass 11 / fail 0
node scripts/verify-demo.mjs              → 通过 22 · 失败 0（红线 10 演示路径完整）
```

## 6. 最小复现步骤

**A. 确定性扰动（离线，无需服务）**
```bash
# 红：破坏收尾
#   把 chatStreamConsumer.ts 里 finalize 的 setStreaming(false)/setCopilotStreaming(false) 删掉
node scripts/probe-stream-determinism.mjs     # → ✗ 8 类各 20/20「卡住」，exit 1
# 绿：恢复后
node scripts/probe-stream-determinism.mjs     # → ✓ 全 0，exit 0
```

**B. 竞态（需 dev）**
```bash
pnpm dev
node scripts/probe-request-race.mjs           # → 10/10，exit 0
```

**C. 截断流（最小单元复现）**
```bash
node scripts/run-chat-stream-tests.mjs        # 含「去 done + 末尾无换行 + 中文被切断」
```

## 7. 未验证项与风险

1. 竞态矩阵只在 Chromium(Edge) 跑；Firefox/Safari 未覆盖（本机无载体）。
2. `no-done` 扰动判为 incomplete 属设计语义；浏览器端截断的**视觉**提示未截图（逻辑已单测覆盖）。
3. `reset` 仍晚于流前 intent/rag span，故 reset 只复位正文/思考链、不动 trace 与卡片。
4. 竞态矩阵的「排队语义」以 `assistantBubbles===1` + 队列提示存在性间接判定，未逐一核对 5 条排队全部送达。
5. 开发期断言仅覆盖客户端消费侧；服务端产侧的协议违例由 `verify:stream` 覆盖。

## 8. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 779c3e9   # R2
```