# R47 · 文本 grounding 与置信度钳制（任务 D）

> 已完成：实体/百分比出处校验 + `[未证实]` 标注 + 根因卡置信度按证据强度钳制。
> 未完成：多步只读工具（C）、离线权重 / 语音 / AI 质量评测（Phase 5）。

---

## 1. grounding 模块（`src/utils/grounding.ts`）

- `collectGroundedTokens(ctx, runbooks)`：把**观测**（节点/Pod 的 id/name/namespace、
  健康分、QPS、CPU/MEM 百分比）与 **RAG 命中**（id/title/tags/特征词/**检索相似度百分比**）
  收成唯一事实源；
- `annotateUngrounded(text, ctx, runbooks)`：
  - 具名实体正则 `pod|worker|node|rack-...`，找不到出处 → 追加 `[未证实]`；
  - 带 `%` 的数字同理（避免"看起来像观测值"的编造百分比）；
  - 返回 `{ text, unverified[] }`；
- `clampConfidence(hasObservation, runbookHits)`：
  观测 + RAG = **0.92**；只有其一 = **0.6**；两者皆无 = **0.4**。

## 2. 接入点

| 位置 | 行为 |
|---|---|
| 引擎 B 报告（`streamWithSimulator`） | 打字前对整篇报告做 `annotateUngrounded`；有未证实项时末尾追加「grounding：N 处…已标注 [未证实]」 |
| 引擎 A 根因卡 | `tool-result` 发出前，把模型给的 `confidence` 钳制到证据上限（`clampConfidence`） |
| 引擎 B 根因卡 | `buildRootCauseArgs` 的置信度由固定 0.92/0.74 改为 `clampConfidence(...)`（无目标且无 RAG → 0.4） |

## 3. 实测（engine B，空观测上下文）

```
假设：clusterContext.nodes=[]、faultyPods=[]，但 RAG 命中 RUNBOOK-K8S-042
报告片段：… RUNBOOK-K8S-042 …（Similarity: 93.2%[未证实]）…
末尾：grounding：1 处实体/数字未在观测或知识库中找到出处，已标注 [未证实]。
```

首轮实测暴露一个**误标**：检索相似度（93.2%）被当成未证实——它其实是服务端真实计算结果。
已把 `similarityScore × 100` 纳入 grounded 百分比集合，修复后同一断言不再误伤。

## 4. 验收

```
tsc 0 · next lint 干净
POST /api/chat（空观测 + 故障问句）→ HTTP 200，流内含「[未证实]」与 grounding 汇总
相似度百分比修复后不再被误标（代码级）
```

## 5. 未完成与风险

1. **引擎 A 的自由正文未做实体改写**：流式文本逐字发出，无法回写；grounding 只作用于
   引擎 B 报告与卡片载荷。这是流式架构的固有限制。
2. **数字校验只覆盖带 `%` 的断言**：Exit Code、GB、毫秒等未校验（避免误伤）；
3. **实体正则可能漏检/误检**：例如 `worker-alpha` 这类短名在观测缺失时会被标注，
   属预期（确实无出处）。
4. **多步只读工具（C）未实现**。
5. **离线权重 / 语音全链路 / AI 质量 20 问评测未实现**（需要权重下载、音频设备与真实调用预算）。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 5d14ead     # 回到 r46
git reset --hard v12-baseline
```