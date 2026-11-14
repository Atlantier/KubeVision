# KubeVision AI — 工程脚本全景索引（Scripts Index）

> 本文档对 `scripts/` 目录下全部自动化脚本进行 100% 分类纳管，并在 `package.json` 中提供统一 npm scripts 入口。所有生成临时转译目录（`tmp-*`）的脚本均已注册进程退出钩子自动回收，不会在仓库根目录遗留垃圾文件。

## 一、核心构建与静态质量门禁

| 脚本文件 | `package.json` 入口 | 用途说明 |
|---|---|---|
| `scripts/check-copy.mjs` | `check:copy` | 全文扫描文案语气、禁止词与真实性表述门禁 |
| `scripts/check-emoji.mjs` | `check:emoji` | 禁止生产代码及关键页面出现非预期 Emoji 字符 |
| `scripts/check-layering.mjs` | `check:layering` | 检查组件、Store、工具层之间的单向依赖分层契约 |
| `scripts/check-dead-exports.mjs` | `check:dead-exports` | 检查静态导出与未消费模块，防止死代码堆积 |
| `scripts/check-contrast.mjs` | `check:contrast` | 验证深空赛博主题文本与背景色 WCAG 对比度达标 |
| `scripts/check-a11y.mjs` | `check:a11y` | 键盘焦点、ARIA 标签、语义角色无障碍检查（支持 `--runtime`） |
| `scripts/check-style-contract.mjs` | `check:style-contract` | Tailwind 3 / tokens.ts / CSS 变量与生产 CSS 编译产物校验（`--require-build`） |
| `scripts/check-docs-consistency.mjs` | `check:docs` | 从 JSON 单一事实源动态比对 README、白皮书、PPT 等文档数字漂移 |
| `scripts/check-metrics-lineage.mjs` | `check:metrics-lineage` | 校验 `performance.json` / `rag-eval.json` / `verify-summary.json` / `mode-parity.json` 血缘与免责声明完整性 |
| `scripts/lint-glsl.mjs` | `lint:glsl` | Three.js 自定义 GLSL 着色器语法静态校验 |
| `scripts/audit-deps.mjs` | `audit:deps` | 依赖树体积、许可与黄金版本契约核查 |
| `scripts/strictmode-audit.mjs` | `strictmode:audit` | React StrictMode 双挂载安全性检查 |

## 二、单元、算法与流式协议验证

| 脚本文件 | `package.json` 入口 | 用途说明 |
|---|---|---|
| `scripts/run-demo-tests.mjs` | `test:demo` / `test:demo:fast` | 导演状态机单元测试与行覆盖率统计 |
| `scripts/run-chat-stream-tests.mjs` | `test:chat-stream` | `chatStreamConsumer` 与 Schema 流式消费内核单元测试 |
| `scripts/verify-stream-integrity.mjs` | `verify:stream` | NDJSON 双擎协议解析、断流恢复与金样重放校验 |
| `scripts/verify-rag.mjs` | `verify:rag` | 客户端纯向量/混合 RAG 检索引擎单元测试 |
| `scripts/verify-mode-parity.mjs` | `verify:parity` | 双模（模拟集群 / 真实连接）数据槽位一致性校验 |
| `scripts/verify-telemetry.mjs` | `verify:telemetry` | 遥测环形缓冲与瞬态槽位读写校验 |
| `scripts/verify-sanitizer.mjs` | `verify:sanitizer` | 日志敏感凭证脱敏器（Token/Key/URL 密码）单元测试 |
| `scripts/verify-receipt-digest.mjs` | `verify:receipt` | MCP 操作回执 SHA-256 摘要两端一致性校验 |
| `scripts/verify-privacy.mjs` | `verify:privacy` | 端侧推理隐私边界校验（零原文外传） |
| `scripts/verify-mcp-execute.mjs` | `verify:mcp` | `/api/mcp/execute` 鉴权、参数校验与执行路径校验 |
| `scripts/sim-drift.mjs` | `sim:drift` | 300 tick 合成遥测引擎长跑稳态、过阻尼与健康分一致性仿真 |

## 三、全量验收与跨端/路演回归

| 脚本文件 | `package.json` 入口 | 用途说明 |
|---|---|---|
| `scripts/verify.mjs` | `verify` / `verify:quick` | 主验收套件（静态检查 + 单元测试 + API + CDP 无头浏览器验证） |
| `scripts/verify-all.mjs` | `verify:all` | 一键串行总控（默认跑完全部步骤并汇总全部失败项） |
| `scripts/verify-demo.mjs` | `verify:demo` | 端到端 3 分钟路演自动演练回归（CDP 真实页面） |
| `scripts/verify-demo-facts.mjs` | `verify:demo-facts` | 路演旁白/状态节点与代码事实一致性质检 |
| `scripts/verify-demo-matrix.mjs` | `verify:demo-matrix` | 多故障场景与导演剧本矩阵回归 |
| `scripts/verify-demo-drill.mjs` | `verify:demo-drill` | 故障演练注入与恢复链路验证 |
| `scripts/mcp-smoke.mjs` | `mcp:smoke` | MCP 服务端点与工具路由冒烟验证 |
| `scripts/shot.mjs` | `shot` | 页面关键状态高分辨率截图工具 |
| `scripts/visual-diff.mjs` | `visual:diff` | 关键 UI 视觉基线比对工具 |
| `scripts/quality-matrix.mjs` | `quality:matrix` | 全质量门禁聚合矩阵报告 |

## 四、专项探针与 R4–R14 深度压测 / 对抗演练

| 脚本文件 | `package.json` 入口 | 用途说明 |
|---|---|---|
| `scripts/adversarial-walkthrough.mjs` | `probe:adversarial` | R14 8 类非常规操作 × 20 次扰动（160 次）+ 30 次性能预算 p50/p75/p95 + 3 类破坏性恢复 |
| `scripts/soak.mjs` | `soak` | 多会话长跑稳定性、SSE 并发与混沌故障恢复压力测试 |
| `scripts/soak-closeout.mjs` | `soak:closeout` | 压测收口数据归档脚本 |
| `scripts/probe-r13.mjs` / `probe-r13-robustness.mjs` | `probe:r13` / `probe:r13-robustness` | R13 WebGL/WebGPU/Worker、A11y 与异常注入边界探针 |
| `scripts/probe-r12.mjs` | `probe:r12` | R12 对话、MCP 执行、脱敏与 RAG 联调探针 |
| `scripts/probe-r10-reliability.mjs` | `probe:r10` | R10 高可靠状态合并、SSE 重连与降级探针 |
| `scripts/probe-r8-layout.mjs` | `probe:r8` | R8 PC 宽屏与移动端窄屏响应式布局探针 |
| `scripts/probe-r6-advanced.mjs` / `probe-r5-advanced.mjs` | `probe:r6-advanced` / `probe:r5-advanced` | R5/R6 AI 诊断流与端侧推理专项探针 |
| `scripts/probe-r4-consistency.mjs` / `probe-r4-oom10.mjs` / `probe-r4-advanced.mjs` / `probe-r4-perf.mjs` | `probe:r4-*` | R4 三节点与百 Pod 3D 场景一致性、OOM×10 与帧率探针 |
| `scripts/probe-glass-contract.mjs` | `probe:glass` | 跨浏览器（Edge/Chrome）与跨 GPU（SwiftShader/D3D11）毛玻璃 computedStyle 探针 |
| `scripts/probe-stream-determinism.mjs` | `probe:stream-determinism` | 20 轮字节流切片确定性回放探针 |
| `scripts/probe-stream-perf.mjs` | `probe:stream-perf` | 首字延迟与流式吞吐性能探针 |
| `scripts/probe-request-race.mjs` | `probe:race` | 快速连发与中止重发请求世代隔离探针 |
| `scripts/probe-immune-adversarial.mjs` / `probe-immune-reject.mjs` | `probe:immune-adversarial` / `probe:immune` | SSE 状态免疫合并与陈旧快照拦截探针 |
| `scripts/probe-hydration-adversarial.mjs` | `probe:hydration` | SSR/CSR 水合一致性与零 Console Error 对抗探针 |
| `scripts/probe-escape-stack.mjs` / `probe-keyboard.mjs` / `probe-keyboard-path.mjs` / `probe-voice-esc-ui.mjs` | `probe:escape` / `probe:keyboard*` / `probe:voice-ui` | Esc 栈、全局快捷键、语音 UI 状态探针 |
| `scripts/probe-blackout.mjs` / `probe-camera.mjs` / `probe-data-health.mjs` / `probe-action-card.mjs` / `probe-edge-runtime.mjs` / `probe-receipt-verify.mjs` / `probe-page-open.mjs` | `probe:*` | 断网黑洞、相机预设飞跃、健康度计算、ActionCard 与首开监控探针 |

## 五、离线数据集构建、基准采集、文档同步与交付打包

| 脚本文件 | `package.json` 入口 | 用途说明 |
|---|---|---|
| `scripts/build-runbook-embeddings.mjs` | `rag:build-runbooks` | 离线预计算 Runbook 向量库嵌入权重 |
| `scripts/build-eval-query-embeddings.mjs` | `rag:build-queries` | 离线预计算评测集 Query 嵌入向量 |
| `scripts/eval-rag.mjs` / `eval-ai-quality.mjs` | `eval:rag` / `eval:ai-quality` | RAG Hit@1/Hit@3/MRR/NDCG@3 与 AI 输出质量评估 |
| `scripts/benchmark.mjs` / `benchmark-consistency.mjs` | `benchmark` / `benchmark:consistency` | 包体积、3D Draw Calls/Triangles、RAG、脱敏与端侧推理性能采集与双跑一致校验 |
| `scripts/opening-frames.mjs` | `opening:frames` | 开场动画首秒帧采样与稳定性分析 |
| `scripts/sync-docs-metrics.mjs` | `docs:metrics` | 从 JSON 事实源自动回写 README 与技术白皮书统计区块 |
| `scripts/capture-evidence.mjs` / `capture-final-evidence.mjs` / `r23-pipeline-evidence.mjs` / `r24-evidence.mjs` / `capture-walkthrough.mjs` | `docs:evidence` / `evidence:final` / `evidence:r23` / `evidence:r24` / `docs:walkthrough` | 自动化验收终端截图与关键场景留痕采集 |
| `scripts/build-whitepaper-pdf.mjs` / `build-pitch-pdf.mjs` | `docs:pdf` / `docs:ppt` | 导出《技术白皮书》PDF 与路演 Pitch Deck PDF |
| `scripts/dump-ui-labels.mjs` | `audit:ui-labels` | 运行时抽取真实页面交互标签用于答辩手册核对 |
| `scripts/package-demo.mjs` | `package:demo` | 打包干净离线交付压缩包（`release/kubevision-demo-<commit>-<stamp>.zip` + `.sha256`，默认不含 `.env.local`） |
