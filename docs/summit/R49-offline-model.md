# R49 · 端侧模型离线化（权重随包 + 本地优先 + 引用声明 + 延迟记录）

> 追问 1 部分完成：权重已放入 `public/models/`、Worker 改为本地优先、冷启动/热推理延迟已记录、
> 公开模型引用声明已写。**浏览器端离线加载未实测**（headless 不触发端侧模型）。

---

## 1. 权重随包

- 来源：本机 `node_modules/@huggingface/transformers` 缓存中的 Xenova/all-MiniLM-L6-v2；
- 复制到 `public/models/Xenova/all-MiniLM-L6-v2/`：
  `config.json`、`tokenizer.json`、`tokenizer_config.json`、`onnx/model.onnx`（86.2 MB）；
- 静态资源实测：`GET /models/Xenova/all-MiniLM-L6-v2/config.json` → 200；
  `GET …/onnx/model.onnx`（Range 0-1023）→ 206。

## 2. Worker 本地优先

```ts
transformers.env.allowLocalModels = true;
transformers.env.localModelPath = '/models/';
transformers.env.remoteHost = 'https://hf-mirror.com/'; // 本地缺失时兜底
```

- 本地路径存在时不再走网络；缺失/损坏仍回退 CDN（`allowRemoteModels` 保持默认 true）。

## 3. 冷启动 / 热推理延迟

- Worker 顶层记录 `WORKER_STARTED_AT`；
- `ready` 消息新增 `coldStartMs`（Worker 启动 → 模型就绪）；
- `embed-result` 新增 `latencyMs`（本次编码耗时，热推理）；
- 客户端 `edgeEmbedding` 打印：
  `[edge-embed] ready coldStart=…ms` / `[edge-embed] warm inference=…ms`。

## 4. 公开模型引用声明

新增 `public/models/README.md`：

- 模型 `Xenova/all-MiniLM-L6-v2`（原始 `sentence-transformers/all-MiniLM-L6-v2`）；
- 许可证 **Apache-2.0**；来源 URL；用途（384 维句向量 / RAG + 语义分类）；
- 文件清单与 `onnx/model.onnx` **SHA-256**（`759C3CD2…C469C46E`）；
- 说明仓库体积增加约 86 MB，若不可接受可改 Git LFS 或构建期下载。

## 5. 验收

```
tsc 0 · next lint 干净
/models/.../config.json → HTTP 200
/models/.../onnx/model.onnx (Range) → HTTP 206
SHA-256 已记录在 public/models/README.md
```

## 6. 未验证项与风险

1. **浏览器离线加载未实测**：headless 环境不触发端侧模型，`allowLocalModels` + `localModelPath`
   的实际加载路径只经代码审阅；若本地加载失败会自动回退 CDN（用户可能无感）。
2. **dtype 与权重形态**：Worker 以 `dtype:'q8'` 建管道，本地是 fp32 ONNX；
   transformers.js 运行时量化是否与本地文件兼容未验证。
3. **仓库体积**：+86 MB；未使用 LFS。
4. 冷启动只在部分 ready 分支上报（正常路径与超时后台升级路径），字段为可选。
5. **语音全链路与 AI 质量 20 问评测仍未实现**（无音频设备；LLM 当前持续超时回落）。

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 8aa5bc3     # 回到 r48
git reset --hard v12-baseline
```