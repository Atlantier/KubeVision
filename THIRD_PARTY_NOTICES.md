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