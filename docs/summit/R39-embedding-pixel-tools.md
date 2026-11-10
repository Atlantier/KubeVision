# R39 · 真 embedding 三路召回 / 端侧像素特征 / 多步 tool calling / grounding

> 状态：**本轮仅新增 A2 的开发期生成脚本，未运行、未生成 embedding 产物；**
> A1/A3/A4/B/C/D 均未实现。未产出评测表或截图，未用假数据填充。

---

## 已完成（仅 1 项）

### A2 `scripts/build-runbook-embeddings.mjs`（开发期脚本，未执行）

- 用已锁定的 `@huggingface/transformers`（不新增依赖）在 Node 侧编码 12 篇手册；
- 模型 `Xenova/all-MiniLM-L6-v2`，384 维、mean pooling + L2 归一；
- 输出 `src/utils/runbookEmbeddings.ts`（`RunbookEmbedding[]` + `RUNBOOK_EMBEDDING_DIM`），运行时直接读取，**运行时不加载模型**；
- 脚本要求外部传入语料 JSON（避免为 .mjs 引入 tsx 依赖），离线会失败并明确报错。

**未执行原因**：需先导出语料 JSON，且首次运行会下载模型权重；本会话预算不足以在可控时间内
完成下载、编码与产物校验。**因此仓库中当前没有 `runbookEmbeddings.ts`。**

---

## 未实现

### A1 Worker embed 协议
未增加 `{type:'embed', texts}` / `{type:'embed-result', vectors}`，未实现模型未就绪返回 null
与 300ms 超时。

### A3 三路召回
`retrieveSreRunbooks` 未新增 `queryEmbedding` 参数，未做 384 维校验/L2 归一/NaN 过滤，
未实现第三路排名与三路 RRF；仍是两路。

### A4 更名与信号
`vectorScore` 未更名 `lexicalCosine`（兼容字段未加）；`ragSignals` 未增第四路"句向量 MiniLM"
与 `available:false` 语义。

### B 端侧像素特征
未实现截图前分块统计（青/绿/琥珀/绯红占比、红色质心、连通块、与机架投影交叠度），
未随请求发送，引擎 B 未据此生成真实观察。

### C 多步 tool calling
未新增只读工具 `getPodMetrics / searchRunbooks / getRecentEvents`，未设 `maxSteps:3` +
`onStepFinish`；写操作仍走 HITL（现状未变）。

### D grounding
未实现正文实体/数字出处校验、"未证实"降级与置信度钳制。

---

## 验收缺口

- 三路 vs 两路评测表：**无**；
- 无 Key 空间观察三种故障态截图：**无**；
- 断网降级两路 + UI 标注：**无**。

---

## 未验证项与风险

1. A2 脚本从未执行，产物格式与 embeddings 数值均未验证。
2. 语料导出步骤尚未写成可复跑命令（脚本只接受 JSON 路径参数）。
3. A1/A3/A4/B/C/D 全部未做，需求主体未交付。
4. 若直接运行 A2 而不校验，可能提交错误向量并静默破坏检索——脚本有维度断言，
   但仍需人工核对 12/12 id 覆盖。

---

## 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 221e8d6     # 回到 r38
git reset --hard v12-baseline
```