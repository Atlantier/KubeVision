# 工程发布与质量自检清单（RELEASE CHECKLIST）

> 本清单用于发布源码归档、部署公网示例或复现本地运行前的完整工程检查。
> 本项目采用 [MIT License](../LICENSE) 开源发布，默认无需 GPU、无需真实 Kubernetes 集群、无需云端 API Key。

## 1. 工程交付与文档清单

| # | 检查项 | 状态 | 位置 |
|---|---|---|---|
| 1 | 项目总览与快速复现路径（含虚实边界、M22 代码导读地图） | **已就绪** | [`README.md`](../README.md) |
| 2 | 本地启动与环境变量说明（Node ≥ 22.13.0 / 推荐 24 LTS） | **已就绪** | [`启动说明.md`](../启动说明.md) · [`.env.example`](../.env.example) |
| 3 | 部署配置（Dockerfile / Vercel 流式 SSE 头保障） | **已就绪** | [`Dockerfile`](../Dockerfile) · [`vercel.json`](../vercel.json) · [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) |
| 4 | 源码压缩包打包与 SHA-256 校验指南 | **已就绪** | [`docs/SUBMISSION_PACKAGE.md`](SUBMISSION_PACKAGE.md) |
| 5 | 证据链索引与自动化 35 项端到端验证 | **已就绪** | [`docs/EVIDENCE.md`](EVIDENCE.md) · [`docs/SCRIPTS_INDEX.md`](SCRIPTS_INDEX.md) |
| 6 | 安全声明、依赖锁定矩阵与端侧零出域规则 | **已就绪** | [`docs/SECURITY_ADVISORY.md`](SECURITY_ADVISORY.md) |
| 7 | 开源协议与第三方模型/语料版权边界声明 | **已就绪（MIT）** | [`LICENSE`](../LICENSE) · [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) |
| 8 | 商业场景分析（所有市场/财务假设均明确标注） | **已就绪** | [`docs/BUSINESS_CASE.md`](BUSINESS_CASE.md) |
| 9 | GitHub Actions 自动化 CI 验证工作流（Node 24） | **已就绪** | [`.github/workflows/verify.yml`](../.github/workflows/verify.yml) |
| 10 | 离线与弱网兜底方案（确定性引擎 B + Chunk 重试退避） | **已内置于系统** | 顶栏「剧本路演」 + `src/utils/dynamicWithRetry.ts` |

## 2. 发布前质量门禁（Release Gate）

| 检查阶段 | 检查项 | 通过标准 |
|---|---|---|
| 代码类型与规范 | `pnpm typecheck && pnpm lint && pnpm lint:glsl` | 0 TypeScript 错误、0 ESLint 错误/警告、0 GLSL HIGH 告警 |
| 死导出与样式契约 | `pnpm check:dead-exports && pnpm build && pnpm check:style-contract -- --require-build` | 0 新增死导出、生产构建通过、样式契约全绿 |
| 核心模块单元测试 | `pnpm test:health && pnpm test:keyboard && pnpm test:slots && pnpm test:chunk-retry && pnpm test:chat-stream && pnpm test:demo:fast` | 全部单测与流式协议校验全绿 |
| 安全与算法基准 | `pnpm verify:rag && pnpm verify:receipt && pnpm verify:sanitizer && pnpm verify:telemetry && pnpm verify:parity` | RAG 零泄漏评测、HMAC 回执、9 类脱敏、遥测与双端一致校验通过 |
| 端到端回归 | `node scripts/verify.mjs` | **35 / 35** 全项通过（含 headless 浏览器 WebGL 与多模态流验证） |
| 仓库纯净度 | `git status` 与归档校验 | 不含 `.env.local`、真实密钥、`node_modules/` 或 `.next/` 产物 |

## 3. 一键复核命令

```bash
pnpm typecheck
pnpm lint && pnpm lint:glsl
pnpm check:dead-exports
pnpm build
pnpm check:style-contract -- --require-build
node scripts/verify.mjs            # 完整 35 项端到端验收（自动启停 dev server + 浏览器）
```
