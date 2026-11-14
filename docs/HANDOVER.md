# KubeVision 改造交接文档

> 更新时间：2026-11-14 · 分支 `chore/dead-code-cleanup`
> 任务来源：`docs/KubeVision_终极Prompt手册.md`（**未跟踪用户文档，严禁提交**）

---

## 1. 一句话现状

**R5–R14（均含 main + 进阶）已全部完成并通过全套基准、静态/样式契约、对抗压测与洁净发布包终验收（`READY FOR COMPETITION SUBMISSION`）**：
- R7 `pnpm probe:camera`（真机 `d3d11`）`H1–H7` + `ERR=0` 全项通过（Pod 特写 `16.25%×16.5%` / `17.8%×16.5%`、720ms/820ms 实测 `720.1ms`/`820ms`、`dt` 阻尼跨帧率残差 `3.22% < 8%`、hover `commit=0`、Esc/`prefers-reduced-motion` `181.3ms`），同步闭环 `R6-2`。
- R8 `pnpm probe:r8`（`scripts/probe-r8-layout.mjs`）`PASS 75 · FAIL 0`（覆盖 6 档视口 `360×740`–`1920×1080` + 连续宽度 `1080/1180/1260` + E1–E5 边界 + 全链路 E2E），并完成 `pnpm probe:keyboard`（`15/15`）、`pnpm probe:escape`（`11/11`）、`node scripts/check-style-contract.mjs --require-build`（`14/14`，`221/221` 透明度类零缺失）、`pnpm check:a11y`（`133` 文件 `0` 命中）、`node scripts/verify.mjs --full`（`verify-demo` `22/22`；`verify` `35/36`，唯一失败 `文档数字一致性` 按计划留待 R14）。
- **R9 终检（`pnpm probe:stream-perf` · `d3d11`）**：**16/16 PASS**（总 Bubble 提交 `1718→77`，历史重渲染 `1290→0`，长任务 `65→0`，`CLS 0.00071`，修复 `N2c` 平滑回底竞态后 `distanceFromBottom=0`，50+ 虚拟化 DOM `12` / 滚顶 `min=11` / 历史重渲染 `0`，N4/N5/N6 及 0 error 全部通过）。
- **R10 终检（`pnpm probe:r10` + `pnpm eval:rag` + `pnpm eval:ai-quality`）**：`probe:r10` **12/12 PASS**（`F1–F4` 容灾/隔离/12s 超时与只读 GET 复查/UTF-8 EOF 截断零乱码 + 真实 Upstream socket 中断 `F1-Server`；真实 LLM TTFT `p50 5605.66ms→685.39ms` / `p95 10596.70ms→840.23ms`，Simulator `p50=33.39ms`）；`eval:rag` 49 用例确定性 PASS（三路 `R@1 94.4%` / `R@3 100.0%` / 误拒率 `0.0%` / 错别字 `R@1 91.7%`）；`eval:ai-quality` 20/20 真实 LLM 零回落（RAG 正确率 `80.0%` vs 裸模型 `78.3%`，引用率 `65.0%` vs `0.0%`，动作合理性 `100.0%`）。
- **R13 终检（`probe:r13-robustness` + `check-a11y --runtime` + `soak` + 样式契约）**：`probe:r13-robustness` **15/15 PASS**（`/api/health` 5 层矩阵与零密钥泄露、SSE 预算第 4 条 `budget-exceeded` / 心跳 `713ms` / 最大生命 `1515ms` / 20 并发 `20/20 P95=1055ms active=0`、3 标签 `?mode=live` `validCpu=36 nan=0 midSubs=3 endSubs=0`、`/api/chat` 30 次三路取消 `pathA=10/pathB=10/pathC=10 falseEngineAFailed=0`、4 大演练截图 `docs/screenshots/r13-drill-{1..4}.png`、20 条异常环状缓冲 `dedup=2 uiItems=5`、`verify-demo --inject-throw-test` 完整堆栈与 `page-error.md` 自检）；`check-a11y --runtime` 通过、`probe-r13` **11/11**、`verify-stream-integrity` 全通、`soak` **8/8**（`heapGrowth=3.3%`、跨阶段 OLS 斜率 `heap=0.829 MB/阶段 · timer=0.143 · interval=0.000 · listener=0.46`）；末次透明度刻度修正后 `pnpm build`、`check-style-contract --require-build`（`14/14, 235/235`）、`typecheck`/`lint`/`check:copy`/`check-emoji`/`check:layering`/`check:dead-exports`/`check:contrast`（53 文件 0 违约）/`check:a11y` 全通过。
- **R14 终稿终检（同源 / 安全 / 对抗 / 彩排 / 发布包）**：`next.config.mjs` 开启 `poweredByHeader: false` 与全套安全响应头（`capture-evidence.mjs` 实测 `HTTP 安全响应头` PASS 且零 CSP 阻塞）；`package.json` 锁定全量 14 项范围版本并同步 `pnpm-lock.yaml`，修正 `Dockerfile`，清理 21 个 `tmp-*` 与旧包并向 12 个脚本注入退场清理，新建 `docs/SCRIPTS_INDEX.md`；`benchmark-consistency.mjs` 2 次连续运行 5/5 硬件无关字段一致（`docs/performance.json` @ `2026-11-14T11:09:52.166Z`）；升级 `check-docs-consistency.mjs`（**10/10 PASS / 0 漂移**）与 `check-metrics-lineage.mjs`（**0 断链**）并同步 10 份文档及重新导出白皮书 PDF（26 页 / 1,835,134 bytes）与 PPT PDF（12 页 / 4,004,151 bytes）；`verify.mjs` **36/36 PASS**、静态门禁 **8/8 PASS**、单测/协议 **9/9 PASS**、`verify-demo.mjs --skip-repeat` 连续 3 轮均 **19/19 PASS**、`adversarial-walkthrough.mjs` **160/160 PASS** + 全性能预算绿 + 破坏性恢复 **3/3 PASS**；clean `pnpm build`（First Load JS **194 kB**）+ `check-style-contract --require-build` **14/14 (235/235)**；洁净重打包 `release/kubevision-demo-345d528-2026-11-14T11-46-15.zip`（82.2 MB, 0 `.env*`/密钥/`tmp-*`）；生成终稿报告 `docs/summit/R14-FINAL-RELEASE-REPORT.md`。

仓库无 remote，将在 `chore/dead-code-cleanup` 提交 R14 收口后快进对齐 `master`；未跟踪用户文档 `docs/KubeVision_终极Prompt手册.md` 与 `.verify-artifacts/` 基线/诊断产物保持未追踪未提交。

---

## 2. 执行约定（接手必读）

- **口令**：用户说「完成 Rx main」/「完成 Rx 进阶」= 执行手册中该轮对应段落。手册行号基于 2026-11-12 快照会漂移，**按文件/符号名定位**，不要死抠行号。
- **每轮交付固定 5 项**：①改动文件清单（含行数变化）②每个缺陷一句根因 ③验收命令真实输出 ④未验证项与风险 ⑤回滚 git 命令；并向 `docs/summit/RISK_LEDGER.md` 追加「改动→证据→验收」。
- **证据纪律**：只许真实命令输出；SwiftShader 软渲染下 **FPS 不作性能证据**（draw call / programs / 堆增量等硬件无关指标可作证据）；数据类结论只能来自 `scripts/benchmark.mjs`。
- **硬约束**：不降可视信息量、不删功能过检、不放水断言、不加地板假数据、不新增依赖、无 `any`/`@ts-ignore`、`useFrame` 零分配（禁止 `new THREE.*`）、输出完整可编译代码（禁省略占位）。
- **手册 §0.3 PREFIX 明示可放弃**「R5 的 draw call 极限目标」（见第 5 节遗留项）。
- **每轮独立提交可逐条 revert**；不要 amend 已提交内容；`pnpm dev` 与 `next build` **严禁同时跑**（共用 `.next` 会互相撞坏）。

---

## 3. 已完成轮次

| 轮次 | 状态 | 关键提交 | 摘要 |
|---|---|---|---|
| R1 视觉地基 | main+进阶完成 | `aef4520` / `d9c4dd1` / `c54b503` | 玻璃四层、令牌单一事实源、设计系统统一 |
| R2 流式链路 | main+进阶完成 | `779c3e9` / `489f128` / `547a311` | NDJSON done/残行/中止/续写/排队/trace 换轮 |
| R3 交互确定性 | main+进阶完成 | `c49e410` / `a1ba445` | Esc 单层、IME、空格、水合、免疫常量、缩放；三个对抗探针 |
| R4 数据可信度 | main+进阶完成 | `884317f` / `2de7c0a` | 槽位复用、阶段不重入、requestId、单采样器、统一健康分、seq 去重；「同一事实三处同数」运行期可证 |
| **R5 3D 渲染性能** | **main + 进阶 + Part1 完成** | `9e106b4`..`17c6536` + 工作区 | 修测量、反射限档、几何合并、档位同源、静态合批 8 处 102 子件；Part 1 去 `MasterNode3D` `transmission={0.72}` 保留 T3 真反射，T3 开反射 583→**466**、benchmark 中位 **229** |
| **R6 3D 观感重制** | **main + 进阶完成** | 工作区 | 屏心单行 `控制平面 · API Server`（0 遮挡）；`HUD_LABEL_SPEC` + 吃雾 + `objectScale` 护栏 + `canvas-html-spec` 守卫（全景 13.0–17.0px / 特写 16.96px）；Vignette 0.12 + DOM 暗角 `0.20`（四角留存 `67.56%→86.33%`）；地面 `#060d1a` + `0.36` 环境光（0% 纯黑）；Pod emerald 双路径着色对齐（色相差 **0.05°/0.06°**）；`Q1–Q6` 实机 `d3d11` 探针全通 |
| **R7 相机与选中手感** | **main + 进阶完成** | 工作区 | Pod 特写 `16.25%×16.5%`（`1920`）/ `17.8%×16.5%`（`1280`）+ 宿主框架与面包屑；720ms/820ms 运镜曲线（实测 `720.1ms`/`820ms`）与 `aria-busy`；`dt` 归一化阻尼残差 **3.22%**；hover 零 commit；双击 `280ms/6px` 窗；`SplitPaneResizer` 保护区零误转；`prefers-reduced-motion` `181.3ms`；同步关闭 `R6-2` |
| **R8 外壳信息架构与多端适配** | **main + 进阶完成** | 工作区 | 统一 `Z_CLASS`（浮层/`z=50`/`z=60`）；RAG/Chaos Store 互斥与两段 Esc 退栈；`TopBar` 顶级按钮 `<= 7`（实测 `6` 个）与 `< md` `44×44` 触控；`MobileViewSwitcher` `bottom-3` 悬底 + 软键盘自动显隐 + `inert` 切屏保留 Canvas 与草稿；`TerminalEcho`/`ViewportToolbar`/`StartupStatusCapsule`/`DemoReplayTimeline` 避让；`NodeInspectHUD` `< md` 折叠详情、`ChaosControlModal` Bottom Sheet 去 `&nbsp;` 防碰撞、`PerfTelemetryHUD` 阶梯排布与 `viewportConstrained` 标记；`probe:r8` **75/75** |
| **R9 副驾流式丝滑** | **main + 进阶完成** | 工作区 | `MarkdownLite.tsx`（闭块增量缓存/`React.memo`/N4 外链降级/N5 未闭合围栏/N6 长串折行）；`AgentTracePanel.tsx`；`CopilotDrawer.tsx` + `ShellLayout.tsx`（rAF 批刷、`120px` 停靠、`>30` 虚拟化与独立尾气泡、修 `N2c` 平滑滚动与保护窗竞态、`N1` abort 复位、`ActionConfirm` 目标级隔离与 `12s` 超时复查、`zod` `safeParse`、`CardErrorBoundary`）；`probe:stream-perf`（`d3d11`）**16/16**（历史重渲染 `0`、`longtask=0`、`CLS 0.00071`） |
| **R10 AI 可靠性与可信度** | **main + 进阶完成** | 工作区 | `src/types/ai.ts`（四卡 Zod schema，零运行时 `as *Props` 强转）；`chatStreamConsumer.ts` + `CopilotDrawer.tsx`（`{type:'reset'}` 免疫、EOF 半截 JSON 判 `incomplete` 不误判 `failed`）；`chat/route.ts`（并行 `enginePromise`、`clearReasoningTimers()`、去冗余只读工具与 `maxSteps=2`、`STEADY_CONCEPTUAL_PATTERN` 分流、异步 `tool-result`、`createThinkingOptOutFetch()`）；`mcp/execute/route.ts` + `mcpExecutor.ts`（`GET ?clientRequestId=` 复查）；`sreRagEngine.ts` + `RagKnowledgeModal.tsx`（`fusedScore`/`rrfScore` 分离）；`probe:r10` **12/12**（TTFT `p50 685ms / p95 840ms`）、`eval:rag` 49/49、`eval:ai-quality` 20/20、`run-chat-stream-tests` **19/19**、`probe-stream-determinism` **160/160** |
| **R11 文案与术语治理** | **main + 进阶完成** | 已归档 | `src/constants/copy/*`（34 条 TERMS 与 J1–J3）、混沌标签收敛、`postMortemReport.ts` 去泄漏、`check:copy` 0 违规、只读「术语表（34）」页签 |
| **R12 交互与动效治理** | **main + 进阶完成** | 已归档 | `CommandPalette` 模糊匹配/分组/`combobox`、栈式焦点陷阱与 `<header inert>`、`AnimatePresence`、`SplitPaneResizer` 自愈、`reducedMotion="user"`、`check:contrast` 0 违约、`probe:r12` **19/19** |
| **R13 稳健性与工程防线** | **main + 进阶完成** | 工作区 | `DEGRADATION_MATRIX` + `/api/health` 零凭据诊断；SSE 预算/心跳/TTL 与取消清洗；`liveTelemetry.ts` 850ms 共享采样；`/api/chat` 30 次取消零误降级；`error.tsx`/`global-error.tsx`/`ClusterTopology2DFallback` + `runtimeErrorBuffer.ts` + `PerfTelemetryHUD` 异常诊断；`probe:r13-robustness` **15/15**、`check-a11y --runtime`、`probe-r13` **11/11**、`soak` **8/8**（OLS 斜率）、`build`/`style-contract`（235/235）全绿 |

### R5 main 已落地的 4 个可回滚提交

1. `9e106b4` **先修测量**：`gl.info.autoReset=false` + 每帧读数后 reset；包裹 `gl.render` 测反射 pass 增量；`GlStatsSnapshot` 拆 `drawCallsMain / drawCallsReflection / drawCalls`（合计）；HUD 显示三数，benchmark 同步采集。
2. `3758cd8` **反射降级（方案 A）**：`qualityReflector = qualityTier >= 3`，T2/T1/T0 使用已有的 `RackGroundReflection` 假反射带，省一次整场景重渲染。
3. `a4aa114` **几何合并**：`ClusterTopologyFloor3D` 基座 33→6（三角汤 + vertexColors，复用 RADAR_STATIC_GEOMETRY 手法）；`WorkerRack3D` 百叶窗 27→3（instancedMesh，基色 #ffffff + `toneMapped={false}` + needsUpdate）。
4. `5623e2f` **档位同源 + 清白付成本**：`TIER_EFFECT_MATRIX` 常量表；DoF 只留 T3 且 `DofFocusDriver` 同条件挂载；`ToneMappingSync`（Canvas 子组件，priority 0 每帧守卫，composer 路径 `NoToneMapping`，否则 `NeutralToneMapping`）；dpr 1x 屏 [0.75,1] / 2x 屏 [1,1.5]、tier≤1 锁 0.75；`preserveDrawingBuffer:false` + `src/utils/viewportCapture.ts` 按需截图队列（priority 2 provider）；能力探测模块级缓存；shadows 按软渲染能力一次性固定。

### R5 main 实测验收（真实输出）

| 指标 | 结果 |
|---|---|
| draw call 随档位单调 | T3 **425** → T2 **414** → T1 **407** → T0/兜底 **401** |
| HUD 三数 | 兜底 401/401/0；T3 开反射 **802 = 429 + 373**（main+reflection==total） |
| 反射成本 A/B | 合并前 off 503 → on 964（+461）；合并后 off 401 → on 778 |
| 降档不重编译 | programs `90→85→82→82→90`（同档往返 Δ0） |
| toneMapping 随档位 | 7 → 0（composer）→ 7 |
| 60s 堆增量 | **+2.34MB**（<5MB） |
| 其他门禁 | typecheck 0 错；benchmark×2 硬件无关项一致；lint:glsl 无 HIGH；strictmode:audit 6/6 |

---

## 4. 剩余工作总览

### 4.1 R5 进阶（已完成零视觉削减改造与实测，T2/T3 极限指标已如实入账）

- 已完成 `src/utils/mergeStaticGeometries.ts`（8 处模块加载期静态合批 102 个子件，60s 稳态 `runtimeCalls=0`，新增 `frustumCulled=false` 为 0）与 `src/constants/renderBudget.ts`（T3≤200 / T2≤140 / T1≤90 / T0≤50 + 8% 反射占比，dev 2s 采样 `console.warn`）。
- 实测报告见 `docs/summit/r5-advanced-probe.json` 与 `docs/summit/RISK_LEDGER.md`（R5 进阶节 & `R5-8`）：
  - T1：`583 = main 316 + reflection 267`（Composer 反射开）；T0 兜底 **285**；`benchmark:consistency` ×2 中位 **288**（`meshes 151`）。
  - T2 / T3：T3 309 → T2 299.8 → T1 294 → T0 285（单调 ✓）；T3≤200 与 反射≤8% / T0≤25% 因保留完整视觉装饰未在不砍视觉前提下达成，待决策削减清单见台账与交付报告。
  - T4：45 帧连续 rAF `p50=476.8ms / p95=506.8ms / p99=513.4ms`，`p99/p50=1.08 ≤ 2.0` ✓。
  - T5：60s 稳态堆增量 `+0.20 MB < 5 MB` ✓；`strictmode:audit` 6/6 ✓。

### 4.2 R5 main 遗留项（已入台账，非阻塞）

- T3 ≤200 draw call 未达标（425 / 802），手册可砍条款兜底。
- 透明件审计 12 个候选逐一核对，均不可安全改 `transparent:false`。
- 首帧 PNG 快照仍被 200KB 门槛拒收（既有行为，非本轮引入）。
- 真实 GPU / 生产构建的帧率与 commit 开销未测（SwiftShader 不能作证）。
- 视觉与 R6 验收后需对齐（R5 完成判据含「视觉与 R6 验收后无差异」）。
- 台账记录：`5623e2f` 曾误删 `WorkerRack3D` 的 linewidth 呼吸动画（手册「死代码」前提不成立），已由 `17c6536` 恢复；**不要再次删除**。

### 4.3 R9–R10（已完成）与 R11–R14（待推进）

| 轮次 | 优先级 | 核心目标 | 当前状态与完成判据要点 |
|---|---|---|---|
| R9 副驾流式丝滑 | P1 | 消息增量渲染、MarkdownLite O(n²)、虚拟化、锚定、动作卡目标级隔离 | **已完成**：`probe:stream-perf`（`d3d11`）**16/16**（`rootCommits 538→152`、总 bubble 渲染 `1718→77`、历史重渲染 `1290→0`、`longtask 65→0`、`CLS 0.00071`、`N2c dist=0`、50+ 虚拟化 DOM `12`/滚顶 `min=11`/历史 `0`） |
| R10 AI 可靠性与可信度 | P1 | 首 token 前装饰 sleep、回落两段结论、畸形载荷白屏、MCP 超时、RAG 置信度语义 | **已完成**：`run-chat-stream-tests` **19/19**、`probe-stream-determinism` **160/160**、`probe:r10` **12/12**（TTFT `p50 5605.66→685.39ms`、`p95 10596.70→840.23ms`）、`eval:rag` 49 用例三路 `R@1 94.4% / R@3 100.0% / 误拒率 0.0%`、`eval:ai-quality` 20/20（RAG 正确率 `80.0%` vs 裸模型 `78.3%`，引用率 `65.0%` vs `0.0%`） |
| R11 全站汉化与术语治理 | 已完成（main + 进阶） | `src/constants/copy/*`（34 条术语 A–E + J1–J3）、全站文案与报告去泄漏替换、`check:copy`（C1–C8）与只读「术语表（34）」 | `check:copy` 139 文件 0 违规（allowlist 12/12）；`verify-demo` 22/22；`verify.mjs` 34/35（仅文档数字一致性留待 R14）；术语表 UI CDP 0 报错 |
| R12 交互与动效治理 | 已完成（main + 进阶） | `CommandPalette` 模糊匹配/分组/`combobox-listbox`、`useFocusReturn` 栈式焦点陷阱与 `<header inert>`、`AnimatePresence` 退场、WAI-ARIA Tabs/Menu、`SplitPaneResizer` 损坏存储自愈、`<MotionConfig reducedMotion="user">`、单全局 Toast、`check:contrast` WCAG AA/触控整改 | `check:contrast` 50 文件 0 违约；`check-style-contract` 229/229；`probe:r12` 19/19（`listeners=5, cls=0.0000`）；`probe:escape` 11/11；`probe:keyboard` 15/15；`probe:keyboard-path` 12/12；`verify-demo` 22/22；`verify.mjs --full` 35/36（仅 `R8-1` 留待 R14） |
| R13 错误边界/a11y/长连接 | 已完成（main + 进阶） | 已提交归档 | `/api/health` 5 层矩阵、`DEGRADATION_MATRIX`、SSE 预算/心跳/TTL、850ms `live` 共享采样、`/api/chat` 3 路取消零误降级、`error.tsx`/`global-error.tsx`/`CanvasErrorBoundary` + 2D 拓扑降级、20 条环状异常缓冲与 `PerfHUD` 最近 5 条诊断、`soak` OLS 斜率与 `--inject-throw-test` / `--runtime` A11y | `probe:r13-robustness` **15/15**、`check-a11y --runtime` 通过、`probe-r13` **11/11**、`verify-stream-integrity` 全通、`soak` **8/8**（`heap斜率=0.829 MB/阶段`）；样式修整后构建与静态门禁全绿 |
| R14 工程一致性/交付卫生 | 已完成（main + 进阶） | 工作区待提交（含 fast-forward `master`） | `next.config.mjs` 安全头（`poweredByHeader: false` + CSP/HSTS/XFO）；`package.json` 锁全量版本 + `pnpm-lock.yaml` 同步 + `Dockerfile` 修正；清除旧泄露 release 与 21 个根 `tmp-*`、注入 12 个脚本退场清理并新增 `docs/SCRIPTS_INDEX.md`；升级 `check-docs-consistency` / `check-metrics-lineage` 与 `verify-rag` / `adversarial-walkthrough`；同源同步 10 份文档、重导出白皮书/PPT PDF、重打包洁净离线包并产出 `docs/summit/R14-FINAL-RELEASE-REPORT.md` | `verify.mjs` **36/36**、静态 **8/8**、单测/协议 **9/9**、`verify-demo` ×3 **19/19**、`benchmark-consistency` **5/5**、`docs-consistency` **10/10 (0 漂移)**、`metrics-lineage` **0 断链**、`adversarial` **160/160 + 3/3 恢复 + 全预算绿**、`style-contract` **14/14 (235/235)**、离线 zip 0 `.env*` |

**依赖顺序**：R1→(R2/R3/R4/R5)→R6→R7→R8→R9→R10→R11→R12→R13→R14。P0 不可砍：R1/R2/R3/R4/R5/R11 文案-脚本同步/R14 全量回归。

---

## 5. 环境与常用命令

- Node v24 / pnpm 11.8；Next.js 14.2.18（App Router）+ React 18.3.1 + three 0.169 + R3F 8.17.10 + drei 9.114.3。
- 开发：`pnpm dev`（默认 3000）。起服务后先 `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000` 预热。
- 质量门禁：
  - `pnpm typecheck`、`pnpm lint`、`pnpm check:a11y`、`pnpm check:contrast`
  - `pnpm benchmark` / `pnpm benchmark:consistency`（数据结论唯一来源）
  - `pnpm lint:glsl`、`pnpm strictmode:audit`、`pnpm check:layering`、`pnpm check:dead-exports`、`node scripts/check-style-contract.mjs --require-build`
  - `pnpm verify:all` / `node scripts/verify.mjs --full`（注：`文档数字一致性` 按计划留待 R14 对齐）
  - `pnpm probe:camera`、`pnpm probe:r8`、`pnpm probe:r12`、`pnpm probe:keyboard`、`pnpm probe:keyboard-path`、`pnpm probe:escape`、`pnpm evidence:final`
- 质量档位：`?quality=high|balanced|low|off` 对应 tier 3/2/1/0；`?demo=1` 冻结 governor（软渲染下 FPS 低会自动降档，**探针必须带 `demo=1`**）。

---

## 6. 踩坑清单（接手前必看）

1. **`useFrame` 只能在 Canvas 子组件里调用**。在渲染 `<Canvas>` 的宿主组件里调用会抛 `R3F: Hooks can only be used within the Canvas component!`，表现为整个 Canvas 不挂载（容易被误判为 dev server / `.next` 损坏）。排查靠 CDP `Runtime.exceptionThrown`。
2. **任何 priority>0 的 `useFrame` 订阅都会关闭 R3F 自动渲染**（`if (!state.internal.priority && state.gl.render)`）。EffectComposer 占 priority 1；截图 provider 用 priority 2 在合成后取帧。
3. **drei `<Edges>` 是 fat-line**（three-stdlib `LineSegments2 + LineMaterial`），`linewidth` 真实生效，不是死代码。
4. **`pnpm dev` 与 `next build` 不能同时跑**：共用 `.next` 会把 webpack registry 撞坏，动态 import 永久停在骨架屏。
5. **孤儿子进程**：`TaskStop` 只杀 pnpm 外壳，next 子进程可能继续占 3000；用 `netstat -ano | grep ":3000 "` 找到 PID，确认是 next 再 `taskkill //PID <pid> //F`（不要动 msedgewebview2，那是宿主进程）。
6. **探针串行单跑**：并发多个 SwiftShader headless 会争 CPU 导致 Canvas 初始化超时；跑前清理 kv- 标记的僵尸 Edge 进程。
7. **探针读 HUD 要按每秒循环比对**，单次 500ms 可能读到上一档残留值；档位切换后需等 shader 预热稳定（连续 3 次 program 计数相同）。
8. **多标签页共享 localStorage**：persist 每秒落盘会覆盖其他页注入的种子，多页探针先导航旧页到 `about:blank` 再串行开新页。
9. **`node probe | tee` 的退出码是 tee 的**，取证用重定向而非管道。
10. **改前基线用 `git worktree add`**，严禁在 worktree 里跑 `pnpm dev`（deps-check 会试图 purge node_modules junction），直接用 `node node_modules/next/dist/bin/next dev --port 3001`。
11. 手册文档 `docs/KubeVision_终极Prompt手册.md` **永不提交**；`tmp-*.mjs` 探针为临时脚本，未跟踪。

---

## 7. 回滚

R5 main 逆序逐条可独立回退：

```bash
git revert 17c6536   # 恢复 linewidth 动画（修正）
git revert 49c40ac   # 台账/证据文档
git revert 5623e2f   # R5-4 档位同源 + 清白付成本
git revert a4aa114   # R5-3 几何合并
git revert 3758cd8   # R5-2 反射限档
git revert 9e106b4   # R5-1 修测量（最后退）
```

---

## 8. R5–R14 收口完成状态与提交前人工事项

1. **R5–R14 已全部完成并归档收口**：
   - R5–R13 与 **R14（工程一致性、安全响应头、依赖锁与交付卫生、10 份文档零漂移、对抗压测 160/160、3×19 黄金彩排、洁净离线打包与终稿报告 `docs/summit/R14-FINAL-RELEASE-REPORT.md`）** 已全部完成 main + 进阶并通过终验收，可在 `chore/dead-code-cleanup` 提交后快进 `master` 对齐（**严禁提交** `docs/KubeVision_终极Prompt手册.md` 与 `.verify-artifacts/`）。
2. **团队提交前人工确认清单**：
   - 替换 `README.md`（18 处）与 `docs/pitch/index.html`（3 处）中的 `【待填写】` 占位符后重跑 `pnpm docs:ppt`；
   - 按组委会/团队口径确认 `LICENSE` 全文与最终投稿压缩包命名，并按真实录制计划完成独立视频录制。
