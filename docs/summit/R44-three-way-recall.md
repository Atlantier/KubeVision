# R44 · 真 embedding 三路召回（部分交付）

> Phase 4 已完成：句向量产物 + 引擎可选第三路 + 三路 RRF + `ragSignals` 第四路 + 两路/三路评测增益。
> **未完成**：Worker embed 协议、生产链路（UI 尚未把查询向量随请求发送，运行时仍是两路）、
> 端侧像素特征、多步只读工具、grounding。

---

## 1. 句向量产物（A2 完成）

- 模型：`Xenova/all-MiniLM-L6-v2`（384 维，mean pooling + L2 normalize）；
- 生成：`scripts/build-runbook-embeddings.mjs`（开发期一次性；Node 侧加载模型，运行时不加载）；
- 语料来源：`/api/dev/rag-eval?corpus=1`（dev-only 导出真实 12 篇手册，避免手抄漂移）；
- 产物：`src/utils/runbookEmbeddings.ts`
  - Float32 小端 base64 存储，**raw 18,432 B**（12×384×4），TS 文件 26.7KB；
  - `getAllRunbookVectors()` / `getRunbookVector(id)` 惰性解码 + 模块级缓存；
  - 运行时仅解码矩阵，**不加载模型**。

> 模型首次下载遇到失效代理（127.0.0.1:7890），清空代理 + `HF_ENDPOINT=https://hf-mirror.com`
> 后成功；该环境细节已记录，避免复现时误判。

## 2. 引擎三路召回（A3 完成）

`retrieveSreRunbooks(query, chaos, faultyPods, topK, extraRunbooks, queryEmbedding?)`：

- `queryEmbedding` 可选；**长度必须 384**、分量全部有限、L2 范数 > 0，否则静默退回两路；
- 通过校验后做 L2 归一化，与预计算手册向量点积（clamp [0,1]）；
- 自定义语料没有预计算向量 → 该路贡献 0，不伪造；
- 三路各自排名 → `rrfFuse(ranks, 3)`；融合终值：`base*0.75 + semantic*0.25`（两路时保持原权重）；
- `scoreBreakdown` 新增 `lexicalCosine`（=原 `vectorScore`，兼容字段保留）、`semanticScore`、
  `semanticAvailable`。

## 3. ragSignals 第四路（A4 完成）

- `RagSignalKey` 增加 `semantic`（MiniLM，violet 视觉）；
- `RagSignal` 增加 `available?: boolean`；
- 句向量不可用时：该路 `available:false`、`score/share=0`、**不计入份额分母**，
  界面显示"未就绪"而不是 0 分条；
- 主导信号计算跳过不可用路。

## 4. 两路 vs 三路评测（真实运行，两次一致）

评测查询向量：`scripts/build-eval-query-embeddings.mjs` 用同一模型编码 49 条查询
（dev 产物 `docs/summit/artifacts/rag-eval-query-embeddings.json`，98.9KB）。
eval 路由对每条用例**同时跑两路与三路**，逐条对比：

| 召回方案 | Recall@1 | Recall@3 | MRR@5 | NDCG@5 |
|---|---|---|---|---|
| 两路 RRF | 66.7% | 75.0% | 0.746 | 0.757 |
| 三路 RRF（+MiniLM） | **69.4%** | **77.8%** | **0.803** | **0.831** |
| 增益 | **+2.8pp** | **+2.8pp** | **+0.057** | **+0.074** |

- 负例拒答率：两路 87.5% / 三路 87.5%（不变）；
- 误拒率：两路 0.0% / 三路 0.0%（目标 <5%，通过）；
- 延迟 P95：两路 1.82ms / 三路 1.98ms（+0.16ms）；
- 确定性：两次运行指标一致 = 是。

三路只在**同一个候选池**上增加排名路，因此负例拒答不受影响，符合预期。

## 5. 未完成与阻塞（必须诚实说明）

1. **Worker embed 协议未实现**：`{type:'embed'} → {type:'embed-result'}`（未就绪 null、300ms 超时）
   完全没写，因此端侧无法产生查询向量。
2. **生产链路仍是两路**：`/api/chat` 未接收/传递 `queryEmbedding`，UI 也未随请求发送。
   三路目前只在 eval 路由中通过预计算查询向量生效——**不能宣称线上已启用三路召回**。
3. **断网降级 UI 标注未做**：没有"三路→两路"的可见提示。
4. **端侧像素特征（B）、多步只读工具（C）、grounding（D）全部未做。**
5. 检索延迟只测了引擎函数本身，不含 HTTP/Worker 通信开销。

## 6. 验收

```
tsc 0 · next lint 干净
eval:rag          : 确定性 PASS；两路 → 三路 R@1 66.7%→69.4%（+2.8pp）
README / whitepaper: METRICS 区块已同步三路行与增益行
产物               : src/utils/runbookEmbeddings.ts（26.7KB，raw 18,432B）
```

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 65bf3d9     # 回到 r43
git reset --hard v12-baseline
```