# R45 · Worker embed 协议 + 三路召回生产链路

> 本轮把 R44 的"仅评测可用"三路召回接到生产链路：
> 端侧 Worker 编码查询句向量 → 前端随 `/api/chat` 发送 → 服务端校验后进入三路 RRF。
> 模型未就绪/超时自动退回两路。**端到端浏览器运行未实测**（见风险）。

---

## 1. Worker embed 协议

### 类型（`src/types/ai.ts`）

- `ClassifierEmbedRequest { type:'embed'; texts: string[] }`
- `ClassifierEmbedResultMessage { type:'embed-result'; vectors: number[][] | null }`
- 并入 `ClassifierRequest` / `ClassifierResponse` 判别联合。

### Worker（`src/workers/logClassifier.worker.ts`）

- `isClassifierRequest` 接受 `embed`（校验 texts 为数组）；
- 分支逻辑：
  - **模型未就绪**（`modelHandle === null` 或 `extractor === null`）→ **立即**返回 `vectors:null`，
    绝不等待下载（满足"未就绪返回 null、不阻塞"）；
  - 就绪 → 复用已初始化的 `feature-extraction` 管道逐条编码（`pooling:'mean', normalize:true`），
    单次最多 8 条；
  - 任何推理异常 → `vectors:null`，**不把 0 向量当结果**。

## 2. 端侧桥（`src/utils/edgeEmbedding.ts`）

- 独立 Worker 单例（不依赖审计面板是否挂载），惰性创建并 `init`；
- 监听 `ready(fallback!==true)` 置就绪；`embed-result` 唤醒等待者；
- `embedQueryText(text, timeoutMs=300)`：
  - 未就绪 → **立即 null**（不触发等待）；
  - 就绪 → postMessage 并 race 300ms；
  - 结果必须是 384 维，否则 null；
- 调用方（对话）拿到 null 时不带字段发请求 → 服务端两路召回。

## 3. `/api/chat` 入参与检索

- `parseRequestBody` 新增 `queryEmbedding` 校验：数组、长度 **384**、全部有限数；
  不满足则**静默忽略**（不 400、不填 0）；
- `retrieveSreRunbooks(...)` 第 6 参传入 `body.queryEmbedding`；
- 引擎内再做 L2 归一与 NaN 过滤（R44），双重防御。

## 4. 前端发送

- `CopilotDrawer.sendMessage` 在 `fetch('/api/chat')` 前 `await embedQueryText(text)`，
  非 null 时并入请求体 `queryEmbedding`；
- 300ms 上限保证对话不被端侧模型下载拖慢。

## 5. 验收（真实输出）

```
tsc 0 · next lint 干净
POST /api/chat（384 维 embedding）      → HTTP 200，首事件 span,span,span,reasoning,span,engine
POST /api/chat（383 维，非法应忽略）    → HTTP 200（未 400，未崩溃）
```

- span 顺序仍为 `intent-route / rag-retrieve / prompt-build`（预流补发）→ reasoning；
- 非法长度不会影响请求合法性，符合"降级两路"的契约。

## 6. 未验证项与风险

1. **浏览器端 Worker 未实测**：headless 截图环境不触发对话，模型下载/编码/300ms 超时路径
   只经 tsc/lint 与代码审阅；**不能宣称生产三路已在线生效**。
2. **独立 Worker 可能重复加载模型**：若审计面板同时使用，会存在两份模型实例；
   后续应改为模块级共享 Worker（受 GlobalWorkerOptions 与打包约束）。
3. **300ms 对 WASM 冷调用可能偏紧**：首条消息可能因超时走两路，属预期降级；
   需要真机统计命中率。
4. **降级可见性依赖 `ragSignals.semantic.available=false` 的"未就绪"展示**，
   对话侧没有额外"本次已降级两路"的显式 chip，需产品确认是否足够。
5. `queryEmbedding` 未参与任何审计摘要/日志，仅用于检索。

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 46c9efb     # 回到 r44
git reset --hard v12-baseline
```