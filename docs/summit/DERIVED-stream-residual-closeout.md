# 衍生轮 · 流式残余未验证项与风险收口

> **轮次说明**：上一轮（`489f128`）是 **R2 的次轮**，此前误标为 "R3"，本轮已正名为
> `R2b`（`docs/summit/R2b-stream-determinism-gate.md` 及 `r2b-*` 证据）。**本轮是衍生轮，
> 不属于任何 R**。范围：把 R2 次轮遗留的 6 项"未验证项与风险"逐条做实，并修复过程中
> 发现的真实缺陷。不改演示选择器、不改四语义色、不升级依赖。

## 0. 先修正轮次命名

- `docs/summit/R3-stream-determinism-gate.md` → `R2b-stream-determinism-gate.md`（标题改为 "R2 次轮"）
- `docs/summit/artifacts/r3-stream-determinism.json` → `r2b-stream-determinism.json`
- `docs/summit/artifacts/r3-request-race.json` → 删除（按浏览器拆成 `r2b-request-race-edge.json` / `-chrome.json`）

## 1. 六项遗留风险逐条收口

### 风险 1 · 竞态矩阵只跑 Chromium(Edge)，Firefox/Safari 未覆盖

- 探针新增 `--browser edge|chrome`；**Edge 17/17、Chrome 17/17** 双 Blink 载体交叉通过。
- 本机无 Gecko/WebKit 载体的**硬证据**：
  - `where.exe firefox` → 无；
  - `C:\Program Files\Mozilla Firefox\firefox.exe`、`(x86)` 均 absent；
  - `node_modules` 无 `playwright` / `playwright-core` / `puppeteer` / `@playwright`。
- 残余边界（如实保留）：Firefox/Safari 的 DOM/React 生命周期行为未在本机实测。
  流式解析内核本身是 `TextDecoder + JSON` 的标准 API，且已在 Node 下做确定性回放，
  不存在引擎私有 API 依赖。

### 风险 2 · 截断流的 incomplete 视觉提示未截图

竞态探针新增 **场景 F**：页内拦截 `/api/chat`，返回一条"有正文/卡片但无 done"的合法截断流。
断言 4 项并截图：

```text
✓ F. 截断流（无 done）→ 气泡底部显示「回答可能不完整」
✓ F. 截断流 → 提供「重新生成」动作
✓ F. 截断流的已生成内容与工具卡片被保留（reset 不清卡片）  assistantBubbles=1
✓ F. 截断流不被误判为硬错误（无 console.error / copilotStreaming 复位）
```

截图：`docs/summit/artifacts/incomplete-truncated-{edge,chrome}-1366x768.png`
（可见正文、PodMetricsCard、底部「回答可能不完整：连接在收到完成标记前结束，已生成内容保留，可重新生成。」+「重新生成」）。

### 风险 3 · reset 晚于流前 intent/rag span，只能"不动 trace"

**已从根上修掉**：`route.ts` 把 `requestId` 声明与 `reset` 下发移到 `pendingSpanEvents` 之前，
**reset 成为整条流第一帧**。客户端 reset 处理随之可安全 `useAgentTraceStore.begin()`
（不再有"清 trace 会误抹本轮 span"的顾虑），同时仍只复位正文/思考链、**保留工具卡片**。

### 风险 4 · 排队语义以气泡数间接判定，未逐条核对 5 条送达

**探针改走真实发送路径**（textarea 原生 value setter + `input` 事件 + `Enter` keydown），
并暴露了一个**真实缺陷**：`triggerQuickPrompt` 原为**单槽赋值**，连点 5 次只剩最后 1 条。
已改为 **store 级 FIFO 队列**（`quickPromptQueue` + `shiftQuickPrompt`），与抽屉内部
`promptQueue` 语义一致。新断言：

```text
✓ A. 真实发送路径连点 5 次：首条进流式、发送键被停止键替换、无重复气泡  accepted=5/5
✓ A. FIFO 排队语义：连发后 4 条全部进入队列（提示达 4 条，未覆盖）        maxQueued=4
✓ A. FIFO 逐条送达：5 次连点最终产出 5 条用户消息（不覆盖、不丢）          userBubbles=5/5
✓ A. 无重复气泡：assistant 气泡数 === user 气泡数                          assistant=5 user=5
```

> 输入区真实契约（探针按此测量，不臆测）：流式中发送按钮被「停止」按钮**条件替换**
> （不是 disabled）；此时用户仍可 Enter 发送并进入排队。

### 风险 5 · 开发期断言只覆盖客户端消费侧

**已补服务端产侧**：`route.ts` 新增 `SEVERE_ASSERT = NODE_ENV !== 'production'` 与
`assertStreamProtocol(events, requestId)`；`emit` 在开发期累积事件，两条正常收尾路径
（llm / simulator 的 done 之后）各调一次 `validateStreamEvents`，违例打
`[stream-protocol:server]`。生产构建整段为 `false` 常量分支，不累积、不校验。

同时修正客户端断言的**误报**：此前对"截断流缺 done"也告警 `missing-terminal`，
现改为**仅 `reason === 'done'` 时校验**（截断/中止本就没有 done，属预期而非产侧违约）。

### 风险 6 · 未跑 verify:all 全量

**已跑通**：`node scripts/verify-all.mjs` → **23/23 通过，总耗时 15.4 min**。逐步骤耗时：

| 步骤 | 秒 | 说明 |
|---|---:|---|
| probe-request-race | 160.9 | 本轮新增；5 条真实 LLM 串行送达 ≈100s + 场景隔离 |
| verify-demo | 107.8 | 路演两遍 |
| 4× probe-blackout | ≈422 | 既有探针，各 `--repeat 3 --duration 10`（固有 ≈3×10s + 启停） |
| verify | 71.4 | 四阶段 E2E |
| verify-stream-integrity | 59.2 | 真实流 + 18 条内核单测 |
| verify-privacy | 54.0 | 抓包 + 审计 |
| probe-glass-contract | 38.6 | 4 视口 × 16 断言 |
| 其余 16 步 | ≈13 | 静态检查 |

结论：脚本顺序执行 + fail-fast，无卡死、无冗余等待；15.4 min 属预期（大头是 4 个既有
blackout 探针 7 min 与本轮新增 race 探针 2.7 min）。证据：
`docs/evidence/verify-all/2026-11-12T08-50-20-099Z/`（`summary.json` passCount=23 / failCount=0）。

## 2. 过程中发现并修复的真实缺陷

1. **`triggerQuickPrompt` 单槽覆盖丢消息** → store FIFO 队列（见风险 4）。
2. **`check-a11y` 5 处裸 `backdrop-blur-*`**（`backdrop-blur-md` / `backdrop-blur-[8px]`）→
   统一为设计系统 tokens：`kv-blur-chip` / `kv-blur-panel`（0 命中）。
3. **`check-dead-exports` 4 条误报**（`COLORS`/`GLASS`/`MOTION`/`clearFrameBuffer`）：
   根因是 R1 删除 `getTokenCssVariables` 后 tokens 失去唯一 src 消费者，而 checker 只扫
   `src/`，看不到 `scripts/` 与 `tailwind.config.ts` 这两个合法消费者。修复：把引用语料
   扩展到 `scripts/**` + `tailwind.config.ts`（并保留 `clearFrameBuffer` 在
   `resetDemoEphemeralState` 中的真实 src 引用——路演复位清空事故时间线帧缓冲）。
   基线由 18 条**收缩**为 12 条（收紧，非放松），`新增死导出 = 0`。
4. **开发期协议断言对截断流误报** → 只在 `reason === 'done'` 时校验。

## 3. 验收（真实执行）

```text
npx tsc --noEmit                          → 0 error
npx next lint                             → ✔ No ESLint warnings or errors
npx next build                            → exit 0（4/4 static pages）
check-a11y                                → 0 命中（此前 5）
check-dead-exports                        → 新增 0（基线 18 → 12）
check-style-contract                      → 全绿
probe-stream-determinism                  → 8 类 × 20 次 = 160，零缺陷
probe-request-race --browser edge         → 17/17
probe-request-race --browser chrome       → 17/17
verify-stream-integrity                   → 全绿（含 18 条内核单测）
run-demo-tests                            → pass 11 / fail 0
verify-demo                               → 通过 22 · 失败 0
verify:all（全量 23 步）                   → 23/23 通过（15.4 min）
```

## 4. 最小复现

**A. 8×20 确定性扰动（离线）**
```bash
node scripts/probe-stream-determinism.mjs        # ✓ 8×20 全零缺陷，exit 0
# 红：把 chatStreamConsumer.ts 的 finalize 里 setStreaming(false)/setCopilotStreaming(false) 删掉
node scripts/probe-stream-determinism.mjs        # ✗ 8 类各 20/20「卡住」，exit 1
```

**B. 竞态 + 截断流视觉（需 dev）**
```bash
pnpm dev
node scripts/probe-request-race.mjs --browser edge      # 17/17
node scripts/probe-request-race.mjs --browser chrome    # 17/17
```

**C. 全量门禁**
```bash
node scripts/verify-all.mjs                      # 23/23（约 15 min）
```

## 5. 仍未验证 / 残余风险

1. **Firefox / Safari 未实测**：本机无 Gecko/WebKit 载体，也无 Playwright/Puppeteer（依赖锁禁止新增）。
   已用 Edge + Chrome 双 Blink 交叉，解析内核为标准 API 且离线回放覆盖。
2. **verify-privacy 偶发 flake**（非本轮引入）：需要混沌日志在 ~12s 内产出高危记录才会出现
   「移交 Copilot」按钮，超时则报"未观察到 /api/chat"。证据：`verify:all` 首轮在此失败，
   单独复跑 **5/5 通过**；历史 `r20-privacy-egress.log` 亦为 `via:record` 通过。
   本轮未改该脚本（避免放松断言）。
3. 竞态探针的 A 场景串行等待 5 次真实 LLM 回复，约 100s，是 verify:all 新增的最长单步；
   属测试保真度成本，未用 mock 替换。
4. 本轮不覆盖 60min soak / 3h 常开 / 真机 Safari。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 489f128   # R2 次轮
```