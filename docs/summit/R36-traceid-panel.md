# R36 · TraceId 贯穿 / 预算标注 / 诚实边界

> 状态：面板与前端 trace 管线已落地；**traceId 贯穿（错误提示/审计/MCP 回执/复盘报告）
> 与 Shift+P 汇总未实现**；面板截图缺失。均为诚实记录，未做假数据。

---

## 1. 已实现

### 前端 trace 仓库（`src/store/useAgentTraceStore.ts`）

- `traceId / spans / summary` 非持久化状态；
- `begin()` / `appendSpan()` / `setSummary()`；`copyText()` 剪贴板（失败静默）；
- 写入发生在 CopilotDrawer 的 NDJSON 解析器（每请求 O(span 数)，非每帧）。

### 解析器接入（`CopilotDrawer.tsx`）

新增两个 case：
- `span` → `appendSpan`（校验 traceId 一致）；
- `trace-summary` → `setSummary`。

### AgentTracePanel（`src/components/ai/AgentTracePanel.tsx`）

- 无 trace 时返回 null，不占位；
- 顶栏 traceId **点击复制**（`aria-label`＋focus-visible 环）；
- TTFT / TOTAL 展示：**>2000ms / >8000ms 用 amber 标注**；
- TOKENS / COST：服务端未提供时显示 **「未配置」**，不显示 0 或假价格；
- span 瀑布条（startMs 偏移 + durationMs 宽度，error 红色）；
- **底部固定一行诚实边界**：`引擎 B 为确定性容灾引擎（非 LLM），节拍为编排值。`
- 已挂载在抽屉输入舱上方（抽屉打开时渲染）。

## 2. 未实现

### 追问 1：traceId 贯穿

- 前端错误提示：`error` 事件已带 `requestId`，但**未把 traceId 写入错误卡片**（trace-summary 在 error 分支不发送，
  且 UI 未接）；
- 审计日志（LocalAuditorPanel 请求审计）：未加 traceId 字段；
- MCP 回执（`/api/mcp/execute`）：未加 traceId；
- 复盘报告（PostMortemModal）：未附 trace 摘要；
- 因此"点击复制 traceId"目前只在面板内可用，未贯穿到上述四处。

### 追问 2：Shift+P 数据健康区块汇总

DataHealthBlock 仍是原有五项指标，**未加 TTFT/总时长超预算汇总**。

### 截图

未采集面板截图：需要一次真实对话把 span/trace-summary 写入 store，再截抽屉；
本轮无交互式截图脚本，未伪造。

## 3. 验证

```
tsc 0 · next lint 干净
（R35 的 verify-stream-integrity trace 断言仍然有效，服务端 trace-summary 由真实请求产生）
```

## 4. 未验证项与风险

1. **面板未经运行时验证**：仅 tsc/lint；解析器 case 与组件订阅是否在真实流中正确工作未截图确认。
2. **Q1 四处贯穿全缺**，traceId 仍只存在于面板。
3. **Q2 HUD 汇总缺失**。
4. 面板在抽屉内常驻（无 trace 时不占位），与"仅抽屉展开时渲染"基本一致，但未做懒加载
   `next/dynamic`（组件体积小，静态引入可接受；如需严格懒加载需再改）。
5. error 分支不发送 trace-summary，导致错误场景无 traceId 可展示——这是 Q1 的前置阻塞。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 023250d     # 回到 r35
git reset --hard v12-baseline
```