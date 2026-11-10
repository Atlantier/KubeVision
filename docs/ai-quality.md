# AI 质量评测（20 问 · RAG vs 裸模型）

> 由 'node scripts/eval-ai-quality.mjs' 调用本地网关生成于 2026-11-10T13:22:20.581Z。
> 每条问句跑两次：默认（RAG）与 'disableRag:true'（裸模型），共 40 次调用。
> 有效配对：**20/20**；引擎非 llm 的配对数：0。

## 汇总

| 指标 | RAG | 裸模型 | 差值 |
|---|---|---|---|
| 关键词正确率 | 91.7% | 91.7% | -0.0pp |
| 引用命中率 | 95.0% | 50.0% | 45.0pp |
| 动作合理性（期望动作题） | 100.0% | 100.0% | — |
| 平均 TTFT | 8033ms | 9534ms | — |
| 平均总时长 | 21307ms | 22808ms | — |
| 平均 tokens（prompt/completion） | 9180 / 3250 | 7242 / 3415 | — |

## 逐题

| # | 问句 | RAG 正确率 | RAG 引用 | RAG 动作 | 裸模型正确率 | 裸模型引用 | 裸模型动作 |
|---|---|---|---|---|---|---|---|
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |
| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |

## 口径与限制

1. **正确率是关键词命中率**，不是人工评分：它只能证明"回答覆盖了必要术语"，不能证明推理正确；
2. **引用命中**统计"动作卡/根因卡的 ragReferences 非空或正文出现 RUNBOOK id"；
3. **动作合理性**只校验动作卡的动作类型在白名单内且 target 指向上下文真实实体，
   不评价动作是否最优；
4. 裸模型只是 'disableRag=true'（不注入知识库），其余 Prompt/工具/引擎完全一致；
5. 20 条问句覆盖 OOM/CrashLoop/CPU/网络/DNS/镜像/Pending/etcd/APIServer/VXLAN/巡检/容量/
   能力/流程等典型场景，非随机采样。
