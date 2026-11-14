# KubeVision R14 终稿发布与竞赛验收报告

> **发布判定（Release Verdict）**：`READY FOR COMPETITION SUBMISSION`（提交前仅剩团队人工替换 `【待填写】` 占位符、`LICENSE` 最终口径确认及现场/录屏提交动作）
> **基线提交与分支**：`chore/dead-code-cleanup`（基于 `345d528` 并完成 R14 收口及 `master` 快进同步）
> **同源基准时间戳**：`docs/performance.json` (`2026-11-14T11:09:52.166Z`) · 证据截图 `docs/evidence/verify-2026-11-14T11-19-35-295Z.png` · 对抗报告 `docs/summit/r14-adversarial-report.json` (`2026-11-14T11:34:34Z`)

---

## 1. 发布结论与核心验证总览

| 验证维度 | 执行命令 / 产物 | 实测结果 | 判定 |
|---|---|---|---|
| 端到端基准捕获与门禁 | `node scripts/capture-evidence.mjs` (`verify.mjs`) | **36/36 PASS**（0 FAIL，0 SKIP），更新 `docs/verify-summary.json` | PASS |
| 静态质量与安全基线（8 项） | `typecheck` / `lint` / `check:copy` / `check:emoji` / `check:layering` / `check:dead-exports` / `check:contrast` / `check:a11y` | **8/8 PASS**（详情见第 2 节） | PASS |
| 单元、RAG 与协议契约（9 项） | `verify:rag` / `verify:parity` / `verify:telemetry` / `test:demo` / `test:chat-stream` / `test:slots` / `test:health` / `test:keyboard` / `verify:stream` | **9/9 PASS**（详情见第 2 节） | PASS |
| 黄金演示连续彩排（×3） | `node scripts/verify-demo.mjs --skip-repeat` 连续运行 3 轮 | Run 1 **19/19** · Run 2 **19/19** · Run 3 **19/19**，**0** console/page errors | PASS |
| 跨轮基准一致性 | `node scripts/benchmark-consistency.mjs` | 2 次连续运行，**5/5** 硬件无关指标完全一致 | PASS |
| 对抗扰动、性能预算与破坏性恢复 | `node scripts/adversarial-walkthrough.mjs` (`docs/summit/r14-adversarial-report.json`) | 扰动 **160/160 PASS**，性能预算全绿，破坏性恢复 **3/3 PASS** | PASS |
| 文档同源与指标血缘 | `sync-docs-metrics.mjs` + `check-docs-consistency.mjs` + `check-metrics-lineage.mjs` | **10/10** 文档 **0 漂移**，指标血缘 **0 断链** | PASS |
| 宣讲 PDF 产出 | `pnpm docs:pdf` + `pnpm docs:ppt` | 白皮书 **26 页 / 1,835,134 bytes (1792 KB)**；PPT **12 页 / 4,004,151 bytes (3.82 MB)**（均 `<= 10 MB`） | PASS |
| 生产构建与样式契约 | `pnpm build` + `node scripts/check-style-contract.mjs --require-build` | Route `/` **107 kB**，First Load JS **194 kB**；Style 合约 **14/14 PASS**（`053ce7f468b9d878.css`，**235/235** 透明类生成，0 缺失） | PASS |
| 离线交付包与卫生审计 | `node scripts/package-demo.mjs`（未传 `--include-env`） | `release/kubevision-demo-345d528-2026-11-14T11-46-15.zip`（**86,225,590 bytes / 82.2 MB**，282 文件，301 zip 条目，**0 `.env*`/密钥/`tmp-*`**） | PASS |

---

## 2. 四大终验收类别与工程基线明细

### 2.1 四大验收类别汇总

| 验收类别 | 覆盖范围 | 核心实测结果 | 备注 |
|---|---|---|---|
| **Class A · 静态与合规门禁** | TS 类型、ESLint、文案禁词、Emoji、分层、死导出、对比度、A11y | **8/8 PASS** | `typecheck` exit 0；`lint` 0 警告/0 错误；`check:copy` 147 文件 / 12/12 allowlist / C1–C8 = 0；`check:emoji` 148 文件 / 0 hits；`check:layering` 4/4 规则 (147 文件 / 678 imports)；`check:dead-exports` 0 新增 (11 <= 12 baseline)；`check:contrast` 53 文件 / 0 WCAG AA 与触控违规；`check:a11y` 147 文件 / 0 hits |
| **Class B · 单元与协议契约** | RAG、双引擎一致性、遥测、演示导演、NDJSON 流、插槽、健康检查、键盘栈 | **9/9 PASS** | `verify:rag` 11/11（part 6 离线跳过 live API 对比）；`verify:parity` 3/3；`verify:telemetry` 12/12；`test:demo` 11/11 (97.43% line / 100% fn)；`test:chat-stream` 19/19；`test:slots` 6/6；`test:health` 4/4；`test:keyboard` 15/15；`verify:stream` 3 场景全通（`tool-start/result` 配对，`orphan=0`，`engine=llm`，含 `trace-summary`）+ A8-1 黄金夹具 |
| **Class C · 浏览器实测与对抗** | 36 项基准验收、3 次黄金彩排、8×20 对抗扰动、30 样本预算、3 项破坏性恢复 | **全绿通过** | `verify.mjs` 36/36（含 `HTTP 安全响应头` PASS、零 CSP 拦截）；`verify-demo` ×3 均为 19/19；对抗 **160/160**；破坏性恢复 **3/3** |
| **Class D · 文档、安全、构建与交付卫生** | 同源校验、指标血缘、PDF 渲染、安全响应头、依赖锁、Clean Build & Zip | **全绿通过** | `package.json` 已锁定全部 14 项 `^`/`~` 版本并同步 `pnpm-lock.yaml`；删除旧 `release/kubevision-demo-74eb67e*` 与 21 个根 `tmp-*`；为 12 个 `scripts/*.mjs` 注入 `process.on('exit', ...)` 自动清理；`Dockerfile` 移除无效 `pnpm-workspace.yaml` 拷贝；新增 `docs/SCRIPTS_INDEX.md` 5 类索引 |

### 2.2 8×20 对抗扰动测试结果（`160/160 PASS`）

来源：`docs/summit/r14-adversarial-report.json`（`2026-11-14T11:34:34Z`）。

| # | 对抗扰动场景 | 执行次数 | 通过数 | 结果 |
|---|---|---|---|---|
| 1 | 高频快速连点切换与触发 | 20 | 20 | **20/20 PASS** |
| 2 | IME 中文输入法组合态输入（校验 `copilotStreaming` 与消息流） | 20 | 20 | **20/20 PASS** |
| 3 | 流式响应 50ms Abort 中断并立即重发 | 20 | 20 | **20/20 PASS** |
| 4 | 断网 3s 后自动恢复重连 | 20 | 20 | **20/20 PASS** |
| 5 | 连续 20 次 `Escape` 分级栈关闭 | 20 | 20 | **20/20 PASS** |
| 6 | 390×844 移动端视口高频切换 | 20 | 20 | **20/20 PASS** |
| 7 | `visibilitychange` 后台切回恢复 | 20 | 20 | **20/20 PASS** |
| 8 | 连续开启 3 层 Modal（`AnimatePresence` 与精确 `aria-label` 栈校验） | 20 | 20 | **20/20 PASS** |

### 2.3 运行时性能预算（30 样本；页面重载为 5 样本）

| 指标项 | p50 | p75 | p95 / 实测值 | 预算阈值 | 判定 |
|---|---|---|---|---|---|
| `/api/health` 响应延迟 | 11.07 ms | 12.15 ms | **15.11 ms** | `<= 150 ms` | PASS |
| `/api/telemetry` SSE 建连首帧 | 8.14 ms | 9.19 ms | **10.8 ms** | `<= 500 ms` | PASS |
| `clientRafRoundtrip` 客户端帧往返 | 122.7 ms | 128.4 ms | **160.3 ms** | `<= 250 ms` | PASS |
| `hydrationReady`（5 次重载） | 723.5 ms | 842.3 ms | **901.4 ms** | `<= 5000 ms` | PASS |
| `heapDeltaMb` 内存增量 | — | — | **46.95 MB** | `<= 64 MB` | PASS |
| `CLS` 累积布局偏移 | — | — | **0.0333** | `<= 0.05` | PASS |
| 压测期间异常 (`uncaughtExceptions` / `consoleErrorCountDuringChaos`) | — | — | **0 / 0** | `0 / 0` | PASS |

### 2.4 破坏性异常恢复矩阵（`3/3 PASS`）

| 测试代号 | 破坏性输入 / 故障场景 | 实测观测结果 | 判定 |
|---|---|---|---|
| **D1** | 非法 JSON、空载荷、非法 MCP 请求后查询健康状态 | `badJson=400`，`empty=400`，`badMcp=400`，`healthAfter=200` | PASS |
| **D2** | 恶意/异常参数扰动后检查服务可用性 | `health=200`，`status=ok` | PASS |
| **D3** | 异常恢复后发起正常对话链路验证 | `status=200`，`engine=llm` | PASS |

---

## 3. 100 分竞赛 QA 评分卡（6 维度实证锚点）

| 维度 | 权重 | 得分 | 核心实证锚点（文件 / 脚本 / 实测输出） |
|---|---|---|---|
| **1. 架构分层与渲染性能规范** | 20 | **20** | `pnpm check:layering`（4/4 规则，147 文件 / 678 imports）；`docs/performance.json`（154 meshes / 27 InstancedMesh / 1,017 实例，drawCalls 中位数 **235** / triangles 中位数 **206,626**）；First Load JS **194 kB** |
| **2. AI 检索与流式协议可靠性** | 20 | **20** | `docs/rag-eval.json`（49 用例，二路 RRF R@1 **88.9%**，三路 RRF R@1 **94.4%** / R@3 **100.0%**，拒识 **100.0%**，误拒 **0%**）；RAG 运行时 P95 **12.05ms**；`verify:stream` 配对 `orphan=0`、`test:chat-stream` **19/19 PASS** |
| **3. 可观测性与五层优雅降级** | 15 | **15** | `verify:telemetry` **12/12 PASS**（脱敏速率 **11,264 条/秒**，`mean 8.88ms`）；`verify:parity` **3/3 PASS**；`test:health` **4/4 PASS**；`D1–D3` 破坏性恢复 **3/3 PASS** |
| **4. 交互无障碍与对抗稳健性** | 15 | **15** | `check:contrast` 0 违规、`check:a11y` 0 违规、`test:keyboard` **15/15 PASS**、`test:slots` **6/6 PASS**、`adversarial-walkthrough.mjs` **160/160 PASS** & 性能预算全绿 |
| **5. 安全基线与交付卫生** | 15 | **15** | `next.config.mjs` 开启 `poweredByHeader: false` 与全套安全响应头（`CSP`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `HSTS`, `Permissions-Policy`）；`capture-evidence.mjs` 验证 `HTTP 安全响应头` PASS 且 0 CSP 拦截；离线包 `2a6c63b50471eb53a5faf80a5d1916d6a9bce03a708afe2b6f56b286a5738e8a`（**0 个 `.env*`/密钥/临时文件**） |
| **6. 文档同源性与路演完备度** | 15 | **15** | `check-docs-consistency.mjs` **10/10 PASS**（0 漂移）；`check-metrics-lineage.mjs` **0 断链**；白皮书 PDF（26 页）与 PPT PDF（12 页）完成导出；`verify-demo` 连续 3 次 **19/19 PASS** |
| **合计** | **100** | **100** | **全部 6 个维度均附带本地可复现脚本与落盘证据** |

---

## 4. 诚实技术边界与披露清单（评审答辩口径对齐）

以下边界已在 `docs/COMPETITION_TECHNICAL_WHITEPAPER.md`、`docs/summit/DEMO_DIRECTOR_PLAYBOOK.md`、`docs/summit/RISK_LEDGER.md` 及技术说明文档中显式披露，严禁在现场超范围宣称：

1. **软件渲染（SwiftShader）FPS 口径**：本机无头 Chrome（SwiftShader）采集到 FPS 中位数为 **5**（均值 `4.75`，P95 `6`），**仅用于无 GPU 容器下链路可达与合批稳定性对照，不作为硬件 GPU 实时渲染帧率指标**；合批实测以几何与绘制调用为准（154 meshes / 27 InstancedMesh / 1,017 实例，drawCalls 中位数 235，triangles 中位数 206,626）。
2. **空白/静止基线帧口径**：`1 draw calls` 属于未渲染集群实体的轻量占位/降级对照状态，正常 3D 拓扑主视口实测 drawCalls 中位数为 **235**。
3. **端侧模型与回退口径**：无头与非 WebGPU 环境下端侧推理自动运行于 `builtin (fallback)`（`mean 0.12ms`），页面状态标识明确标注实际路径，不冒充全量 WebGPU 神经推理延迟。
4. **遥测与真实集群适配器**：默认开箱演示采用高保真合成故障遥测流；生产级 `K8S_API_SERVER` 只读接入适配层已实现但本环境未连真实集群，答辩时如实说明“演示为合成故障语义数据，适配器代码就绪”。
5. **MCP 协议与 RAG 评测范围**：MCP 通过 JSON-RPC 2.0 over HTTP 集成外部工具调用；RAG 检索准确率（二路 R@1 **88.9%**，三路 R@1 **94.4%** / R@3 **100.0%**，拒识 **100.0%**）基于 `docs/rag-eval.json` 49 个精选正负样本评估，运行时端到端检索延迟均值为 **8.39ms**（P95 **12.05ms**）。
6. **容器构建与视频/长跑边界**：本机无 Docker daemon 与录屏硬件（`Dockerfile` 已静态修正，Actions CI 配置已入仓但未在云端 runner 实跑；路演视频录制与更长时间 soak 需在实体机执行，详见 `docs/summit/RISK_LEDGER.md`）。

---

## 5. 提交前人工待办清单（需队长/团队自行完成）

按项目确认要求，以下占位符与条款在代码侧故意保留原样，请在最终提交压缩包前人工替换并二次核验：

- [ ] **`README.md`**：共 **18 处** `【待填写】` 占位符（团队名称、参赛学校、队员信息、指导老师、联系方式/邮箱等）。
- [ ] **`docs/pitch/index.html`**：共 **3 处** `【待填写】` 占位符，替换后重新执行 `pnpm docs:ppt` 生成最新 `docs/KubeVision_PITCH.pdf`。
- [ ] **`LICENSE`**：当前保留「提交前待团队确认」及默认文本，请按竞赛组委会与团队最终授权口径确认或替换。
- [ ] **离线提交包最终命名与环境变量**：当前洁净包位于 `release/kubevision-demo-345d528-2026-11-14T11-46-15.zip`（SHA256: `2a6c63b50471eb53a5faf80a5d1916d6a9bce03a708afe2b6f56b286a5738e8a`），按团队与院校模板重命名后，如现场需要启用真实外部模型密钥再另行安全配置 `.env.local`（切勿重新打入公共提交 zip）。

---

## 6. 评审高频高压 Q&A（10 问）

1. **Q1：无 GPU 环境看到 5 FPS，怎么证明 3D 合批性能不是卡顿设计？**  
   **A**：5 FPS 来自无头浏览器 SwiftShader CPU 软光栅基线；架构上已将 1,017 个动态实例合批至 **27 个 `InstancedMesh`**（总 154 meshes，drawCalls 中位数 **235**），并通过 `useTelemetryRef` 在 `useFrame` 中零 GC 原地更新矩阵与颜色，独立于软光栅耗时。
2. **Q2：RAG 准确率 94.4% 是真大模型跑出来的，还是写死关键词？**  
   **A**：`docs/rag-eval.json` 49 个用例对比显示，二路 RRF（BM25 + Dense）R@1 为 **88.9%**，叠加 Reranker 后三路 RRF 提升至 **94.4%**（R@3 **100.0%**），8 个无关负样本拒识率 **100.0%**、误拒 **0%**；运行时均值 **8.39ms**（P95 **12.05ms**）。
3. **Q3：如果没有外网或 API 额度耗尽，现场演示会直接报错吗？**  
   **A**：不会。`/api/health` 与五层降级矩阵支持端侧/内置引擎与双引擎路由无缝接管，`verify:parity` 3/3、破坏性测试 D1–D3 均在异常输入后保持服务 `200 / ok`，并如实标出实际引擎。
4. **Q4：SSE 流式推送与 AI 助手并发输出时，会阻塞主线程或丢工具回执吗？**  
   **A**：`verify:stream` 验证 3 类对话场景下 `tool-start` 与 `tool-result` 严格配对（`orphan=0`）且携带 `trace-summary`；30 样本实测 `/api/telemetry` SSE 首帧 P95 **10.8ms**，`clientRafRoundtrip` P95 **160.3ms**，`CLS` **0.0333**。
5. **Q5：高频快速操作、中文输入法选词或强行断网会不会把前端状态打崩？**  
   **A**：`adversarial-walkthrough.mjs` 对 8 类高危扰动各连击 20 次（总 **160/160 PASS**），包括 IME 组合态、50ms Abort 重发、断网 3s 恢复、3 层 Modal 连开与 390×844 切换，期间未捕获异常与控制台错误均为 **0**。
6. **Q6：日志和上下文直接发给大模型，如何防止 Secret / Token 泄露？**  
   **A**：遥测与上下文管线内置高速脱敏清洗器，实测吞吐 **11,264 条/秒**（`mean 8.88ms`），`verify:telemetry` **12/12 PASS**；同时离线打包默认不带 `--include-env`，经审计 zip 内 `.env*` 为 **0**。
7. **Q7：为什么文档和代码之间不会出现“PPT 写一套、代码跑另一套”？**  
   **A**：项目建立了单一真实数据源 `docs/performance.json` + 自动同步脚本 `sync-docs-metrics.mjs` + 一致性门禁 `check-docs-consistency.mjs`（10/10 零漂移）+ 指标血缘门禁 `check-metrics-lineage.mjs`（0 断链），且每次构建后运行 `benchmark-consistency.mjs` 复核硬件无关字段。
8. **Q8：HTTP 安全头和前端可访问性（A11y）做到什么程度？**  
   **A**：`next.config.mjs` 禁用 `X-Powered-By` 并下发 CSP、HSTS、X-Frame-Options DENY、nosniff 等响应头（已通过 `capture-evidence.mjs` 线上验证且 0 CSP 报错）；对比度 `check:contrast`（53 文件）与 `check:a11y`（147 文件）均为 **0 违规**，键盘与焦点栈测试 **15/15 PASS**。
9. **Q9：如何连接真实 Kubernetes 集群？为什么现在用合成数据？**  
   **A**：服务端已实现基于 `K8S_API_SERVER` 环境变量的只读适配接口；答辩场景需要可控、可复现、安全的混沌故障注入，因此默认以合成遥测引擎运行，不在无真实集群时伪造在线生产数据。
10. **Q10：你们如何保证打包给评委的仓库能一次构建、样式不丢失？**  
    **A**：`package.json` 已消除全部 14 个浮动范围版本并重锁 `pnpm-lock.yaml`，每次发布前执行 clean `pnpm build` + `check-style-contract.mjs --require-build`（验证生成 CSS `053ce7f468b9d878.css` 内 **235/235** 个透明度/样式类全部命中，First Load JS **194 kB**）。

---

## 7. 现场应急回滚与排障卡（Emergency Rollback Card）

| 异常情形 | 立即应对动作 | 验证 / 恢复后操作 |
|---|---|---|
| **1. 3000 端口被残留进程占用或构建失败** | 检查并结束占用 3000 端口的 Node 进程后重跑 `pnpm build` 或启动开发服务 | 运行 `node scripts/verify.mjs --quick` 确认主链路恢复 |
| **2. 现场网络波动导致外部 LLM 超时** | 直接依赖系统自动降级通道或切换离线内置回退响应，向评委说明“离线容灾接管已生效” | 访问 `/api/health` 确认返回 `200` 及降级矩阵状态 |
| **3. 路演过程中 3D Canvas 渲染异常或 WebGL 上下文丢失** | 系统由 `CanvasErrorBoundary` 自动切换 2D 拓扑降级视图（不黑屏） | 使用顶部重播/恢复按钮或刷新页面恢复 3D 视图 |
| **4. 需快速从压缩包重建洁净演示环境** | 解压 `release/kubevision-demo-345d528-2026-11-14T11-46-15.zip`（先校验 SHA256 `2a6c63b50471eb53a5faf80a5d1916d6a9bce03a708afe2b6f56b286a5738e8a`）并按 `启动说明.md` 启动 | 若需真实 LLM Key，在本地新建 `.env.local` 填入，不要混入发布包 |
