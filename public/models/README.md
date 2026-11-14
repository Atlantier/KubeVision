# 端侧模型权重（随包离线）

本目录存放 **Xenova/all-MiniLM-L6-v2** 的 ONNX 权重，供端侧 Worker 离线加载。
运行时优先读取本目录；本地缺失时才回退 CDN（`https://hf-mirror.com/`）。

## 模型引用声明（公开模型出处）

| 项 | 值 |
|---|---|
| 模型 | `Xenova/all-MiniLM-L6-v2`（ONNX 转换版） |
| 原始模型 | `sentence-transformers/all-MiniLM-L6-v2` |
| 许可证 | **Apache-2.0** |
| 来源 | https://huggingface.co/Xenova/all-MiniLM-L6-v2 （原始模型：https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2） |
| 用途 | 端侧文本句向量（384 维，mean pooling + L2 normalize），用于 RAG 查询向量与日志语义分类 |
| 文件 | `config.json`、`tokenizer.json`、`tokenizer_config.json`、`onnx/model.onnx` |
| 体积 | 约 **86.2 MB**（fp32 ONNX） |
| `onnx/model.onnx` SHA-256 | `759C3CD2B7FE7E93933AD23C4C9181B7396442A2ED746EC7C1D46192C469C46E` |

## 加载契约

- Worker（`src/workers/logClassifier.worker.ts`）设置：
  - `transformers.env.allowLocalModels = true`
  - `transformers.env.localModelPath = '/models/'`
  - `transformers.env.remoteHost = 'https://hf-mirror.com/'`（仅兜底）
- 本地路径通过 Next 静态资源提供（已实测：`/models/Xenova/all-MiniLM-L6-v2/config.json` 200，
  `onnx/model.onnx` 支持 Range 206）；
- Worker 上报 `coldStartMs`（启动→就绪）与每次 `embed-result.latencyMs`（热推理），
  客户端在 console 记录 `[edge-embed] ready coldStart=… / warm inference=…`。

## 说明与风险

- 仓库因此增加约 86 MB；如不接受，可改用 Git LFS 或改为构建期下载脚本。
- Worker 优先以 `dtype: 'fp32'` 直接加载随包 `onnx/model.onnx`（避免 `dtype: 'q8'` 拼接 `_quantized` 导致本地 404）；仅当本地静态资源缺失时回退 CDN 拉取 `q8` 量化版。
- 本目录仅放推理权重，不包含训练数据；Apache-2.0 允许商用与再分发，但需保留本声明。