# 第三方组件与模型声明（THIRD PARTY NOTICES）

本项目自身以 MIT 许可证发布（见 `LICENSE`）。以下第三方依赖/模型按其各自许可证分发；
具体版本与完整许可证原文以 `pnpm-lock.yaml`、`node_modules/<pkg>/LICENSE` 及上游仓库为准。

## 运行时依赖

| 组件 | 许可证 | 用途 |
|---|---|---|
| Next.js 14 | MIT | App Router / Server Routes / 构建 |
| React 18 / React DOM | MIT | UI 运行时 |
| three.js | MIT | 3D 渲染 |
| @react-three/fiber | MIT | R3F React 渲染器 |
| @react-three/drei | MIT | R3F 辅助组件（Html 等） |
| @react-three/postprocessing | MIT | 后期处理（Bloom/Vignette 等） |
| zustand | MIT | 客户端状态管理 |
| framer-motion | MIT | 动效与布局动画 |
| tailwindcss / postcss / autoprefixer | MIT | 样式与构建 |
| tailwind-merge / clsx | MIT | 类名合并 |
| lucide-react | ISC | 图标 |
| zod | MIT | 运行时 Schema 校验 |
| ai（Vercel AI SDK） | Apache-2.0 | LLM 流式调用与工具调用 |
| @ai-sdk/openai | Apache-2.0 | OpenAI 兼容协议适配 |
| @huggingface/transformers（transformers.js） | Apache-2.0 | 浏览器端 ONNX 推理（端侧日志分类 / 句向量） |
| onnxruntime-web（transitive） | MIT | ONNX WebGPU/WASM 运行时 |

## 端侧模型

| 模型 | 许可证 | 来源 | 说明 |
|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2`（ONNX 转换版） | **Apache-2.0** | https://huggingface.co/Xenova/all-MiniLM-L6-v2 | 384 维句向量；权重随包存放于 `public/models/Xenova/all-MiniLM-L6-v2/`（含 `onnx/model.onnx`），文件级 SHA-256 与体积见 `public/models/README.md`。原始模型：`sentence-transformers/all-MiniLM-L6-v2`。 |

## 字体与图标

- 字体：项目仅使用 `next/font` 内置/系统字体，不随包分发第三方字体文件；
- 图标：`lucide-react`（ISC），以 React 组件形式内联使用。

## 合规说明

1. 本项目**不包含**任何真实集群凭据、用户数据或第三方数据集；
2. RAG 知识库手册为本项目自撰的演示语料（`src/utils/sreRagEngine.ts`），非第三方版权内容；
3. 模型的 Apache-2.0 许可证允许商用与再分发；如替换/再训练模型，需同步更新本文件与
   `public/models/README.md` 的出处、许可证与校验和；
4. 若你分发本项目的构建产物（含 `public/models/`），请保留本声明与 `LICENSE`。
## RAG 语料来源声明

- 内置 12 篇 Runbook（RUNBOOK-K8S-042/043/051/052/061/062/071/081/091/101、SRE-RB-011/012）为本项目**自撰语料**，
  用于演示云原生排障语义，**不复制任何第三方文档原文**；
- 语料中的命令、退出码与机制描述依据 Kubernetes / Linux 公开文档与通用 SRE 实践，未逐句引用受版权保护的文本；
- 自定义 Runbook 由使用者在浏览器 localStorage 内自建，服务端不持久化；
- 若后续引入第三方语料，必须在本节登记来源、许可证与作者，并同步更新 `docs/rag-eval.json` 的评测口径。

## 核心自研与第三方能力边界矩阵（M24）

| 模块层级 | 第三方开源底座 / 预训练资源 | 本项目自主设计与编码贡献 |
|---|---|---|
| **3D 态势与渲染性能** | Three.js / R3F / Postprocessing 基础能力 | 双轨状态架构（`useTelemetryRef` + `useClusterStore`）、程序化机柜与 `InstancedMesh` 批渲染、`spatialLayout.ts` 单源坐标几何、`webglcontextlost` 到 2D 无缝升降级 |
| **混合 RAG 与证据约束** | `Xenova/all-MiniLM-L6-v2` (Apache-2.0) | 12 篇自撰 SRE Runbook、语料级 IDF + Okapi BM25 + TF-IDF + 384d 句向量三路 RRF 融合、Sigmoid 证据门与 `grounding.ts` 结构化实体-指标校验、`RagQueryOptions` 真消融开关 |
| **端侧隐私与日志审计** | Transformers.js / onnxruntime-web | 同步 9 类正则脱敏引擎（含 AI/VCS Token 与 IPv6）、发送前 Canary 拦截门、`requestId` 并发隔离 Worker、带否定短语消除与低证据阈值的确定性兜底分类器 |
| **双擎流式与 MCP 闭环** | Next.js App Router / Vercel AI SDK | 自研 NDJSON 双擎容灾状态机、按 `clientRequestId` 指纹幂等校验、高危动作 Cordon 确认绑定、`K8S_ALLOW_REAL_WRITE` 物理隔离与 Google SRE 风格纯函数复盘导出 |
