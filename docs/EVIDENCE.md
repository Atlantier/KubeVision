# 证据链索引（EVIDENCE）

> 本索引汇总当前仓库内可**直接复现**的工程/算法/浏览器端验收证据，以及 **2026-11-14 受控基准快照（Controlled Deterministic Benchmark）** 归档结论。
> 说明：提交精简版已清理未纳入 Git 追踪的二进制截图/历史草稿报告及一次性采集辅助脚本，全部活跃可执行验证脚本清单见 [`docs/SCRIPTS_INDEX.md`](SCRIPTS_INDEX.md)。

## 1. 活跃可复现证据（可直接在本仓库运行验证）

| # | 证据文件 / 数据源 | 证明结论 | 复现命令 |
|---|---|---|---|
| 1 | `docs/verify-summary.json` · [`scripts/verify.mjs`](../scripts/verify.mjs) | 自动化验收 **35/35 通过（0 失败 0 跳过）**，覆盖静态门禁 / API 契约 / CDP 无头浏览器 3D 与交互 | `node scripts/verify.mjs`（静态快速：`pnpm verify:quick`） |
| 2 | [`scripts/verify-rag.mjs`](../scripts/verify-rag.mjs) | 混合 RAG 检索引擎与三路真实通道消融开关（`disableSemantic`/`disableBm25`）单测全通过 | `pnpm verify:rag` |
| 3 | [`scripts/verify-sanitizer.mjs`](../scripts/verify-sanitizer.mjs) | 端侧 9 类敏感凭证（含 AI/VCS Token、通用 KV 密钥、IPv6）脱敏单测与吞吐基准全通过 | `pnpm verify:sanitizer` |
| 4 | [`scripts/verify-receipt-digest.mjs`](../scripts/verify-receipt-digest.mjs) | MCP 操作回执 SHA-256 摘要两端一致性、实群写隔离（403）、幂等校验（409）与副本防篡改 | `pnpm verify:receipt` |
| 5 | [`scripts/verify-telemetry.mjs`](../scripts/verify-telemetry.mjs) · [`scripts/verify-mode-parity.mjs`](../scripts/verify-mode-parity.mjs) | 双轨遥测环形槽位、模拟/真实模式数据契约一致性检验 | `pnpm verify:telemetry && pnpm verify:parity` |
| 6 | [`scripts/run-demo-tests.mjs`](../scripts/run-demo-tests.mjs) · [`scripts/run-chat-stream-tests.mjs`](../scripts/run-chat-stream-tests.mjs) | 导演状态机单测与 NDJSON 流式消费内核单元测试全通过 | `pnpm test:demo:fast && pnpm test:chat-stream` |
| 7 | [`scripts/check-style-contract.mjs`](../scripts/check-style-contract.mjs) · [`scripts/check-dead-exports.mjs`](../scripts/check-dead-exports.mjs) · [`scripts/lint-glsl.mjs`](../scripts/lint-glsl.mjs) | 样式令牌一致性、零新增死导出、自定义 GLSL 着色器语法静态门禁全通过 | `pnpm lint:glsl && pnpm check:dead-exports && node scripts/check-style-contract.mjs --require-build` |
| 8 | [`docs/SECURITY_ADVISORY.md`](SECURITY_ADVISORY.md) | `next@14.2.18` 版本锁定考量、`pnpm audit` 暴露面评估与工程级缓解措施 | 人工审阅与 `pnpm audit` |

## 2. 受控基准历史快照（Controlled Deterministic Benchmark Archive）

> 以下 JSON/MD 报告为 `2026-11-10` 至 `2026-11-14` 期间在基准环境下采集并归档的只读数据快照，用于展示渲染批次压缩与算法量化基线（相关采集脚本未随精简交付仓库保留）：

| # | 归档文件 | 证明结论与口径限制 |
|---|---|---|
| A | [`docs/performance.md`](performance.md) + [`docs/performance.json`](performance.json) | 硬件无关渲染指标（Draw Calls 中位 **235**、Triangles **206,626**、27 InstancedMesh 承载 1,017 实例）；FPS 于 SwiftShader 软渲染采集（**不作为真机 GPU 性能依据**） |
| B | [`docs/rag-eval.md`](rag-eval.md) + [`docs/rag-eval.json`](rag-eval.json) | **受控基准评测**：49 条人工构造用例，两路 R@1 88.9%、三路 94.4%（+5.6pp），负例拒答 100%；详见该文档口径说明 |
| C | [`docs/ai-quality.md`](ai-quality.md) + [`docs/ai-quality.json`](ai-quality.json) | **受控配对评测**：20 条典型 SRE 问句对比（RAG vs `disableRag=true`），统计关键词命中率与引用命中率，不代表主观专家人工评分 |
| D | [`docs/deps-audit.md`](deps-audit.md) | `.next/` 生产包体与未用依赖基线快照（首次 JS gzip 172.2 KB） |
| E | [`docs/render-ab.md`](render-ab.md) · [`docs/quality-matrix.md`](quality-matrix.md) · [`docs/privacy-egress.md`](privacy-egress.md) · [`docs/soak.md`](soak.md) · [`docs/strictmode-audit.md`](strictmode-audit.md) | 历史后处理色相一致性 A/B、质量矩阵、零出域金丝雀审计、长跑泄漏回归与 React 18 StrictMode 审计快照 |

## 使用说明

1. 评审现场可优先运行 `pnpm verify:quick` 与 `node scripts/verify.mjs`，3 分钟内完成静态 + 算法 + 浏览器 E2E 全量验真；
2. 任何性能或算法数字均与对应 `.json` 源文件绑定，严禁脱离环境口径夸大解读（尤其是 SwiftShader FPS 与受控集样本量）；
3. 真实集群接入默认安全优先：`K8S_ALLOW_REAL_WRITE=false` 阻断无意写入，详见 [`启动说明.md`](../启动说明.md) 与 [`docs/SECURITY_ADVISORY.md`](SECURITY_ADVISORY.md)。