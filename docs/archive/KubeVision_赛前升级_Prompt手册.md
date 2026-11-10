# KubeVision AI · 赛前升级 Prompt 工程手册

> **用途**：把"找 Bug / 清冗余 / 美术升级 / 全面精进"四件事，固化为 9 轮可直接执行的 AI 编码任务。
> **每一轮 = 1 个「主 Prompt」+ 1 个「进阶优化追问 Prompt」**，主 Prompt 负责"把事做对"，追问 Prompt 负责"把事做深、做出可验证证据"。
> **审计基线**：`master @ 14732fd`（2026-11-09 15:45，工作树干净）。
> **审计方式**：全仓只读静态审计 + 在项目**之外的临时副本**（`%TEMP%\kvision-run-*`，node_modules 走 Junction）用 `next dev` + headless Edge / CDP **真实点击复现**；未修改仓库任何源文件。
> **参赛背景（可确证部分）**：本作品对应「AI WEB 网页开发挑战赛（团队赛）」赛道，主题核心为"AI 驱动的 Web 应用创新挑战"，隶属第十七届全国大学生计算机应用能力与数字素养大赛暨 2026 第九届传智杯；省赛预计 2026-11 月（一个来源为 11-22），报名截止 11-18，国赛 12 月。**官方评分细则与赛道 ID 10037 的对应关系无法从公网核验**（`www.boxuegu.com` 解析到非公网 IP），README 中的 35/25/10/10/10/10 只能视为"团队自述口径"。

---

## 0. 手册使用说明

### 0.1 这份手册解决什么

| 你要解决的问题 | 对应轮次 | 一句话结论 |
|---|---|---|
| 一键自动路演"演出来是错的" | **R1** | 3 个 P0：**场景→节点映射写反、自愈目标从未命中故障 Pod、HITL 被绕过且终态自相矛盾**（已实跑复现） |
| 其他地方还有没有 Bug | **R2** | 5 个 P1（RAG 校准系数算错 / Esc 退出栈失效 / 端侧审计死锁 / MCP 假成功回执 / HITL 目标被替换）+ 20 个 P2 |
| 数据/指标口径混乱、数据自己会漂移 | **R3** | QPS 复利漂移（12,850→3,298→7,629）、节点 CPU 随机游走归零、live 采集叠加、README↔performance 6 组数字互相矛盾 |
| 美术怎么升级 | **R4 + R5** | 短板已从"几何/材质"转移到**渲染管线**：正常路径无 ToneMapping、无抗锯齿、兜底路径没关反射/阴影、80 处 <10px 字号、构图前排裁切 |
| 项目还能怎么精进 | **R6 + R7 + R8 + R9** | AI "名实相符"（实测可观测层 / MCP 规范化 / 检索评测 / 真 embedding）、死代码清理（≈810 行）、演示与交付物（PPT/视频/证据链） |

### 0.2 轮次地图（按"投入产出比"排序，非必须顺序执行）

| 轮次 | 主题 | 优先级 | 预估工期 | 依赖 | 关键验收命令 |
|---|---|---|---|---|---|
| **R1** | 自动路演 P0 重建（Demo Integrity） | **P0** | 0.5–1 天 | 无 | `node scripts/verify-demo.mjs`（本轮新增） |
| **R2** | 运行时缺陷修复包（非路演） | **P0** | 1–1.5 天 | R3 可并行 | `node scripts/verify.mjs` |
| **R3** | 遥测真实性与数据自洽 | **P0** | 0.5–1 天 | 无 | `node scripts/benchmark.mjs` + 新增不变式测试 |
| **R4** | 视觉管线与电影级质感（3D） | P1 | 1–1.5 天 | R5 同步 | 三组 A/B 截图 + `Shift+P` 帧预算 |
| **R5** | UI 设计系统与信息层级（2D） | P1 | 1 天 | R4 同步 | `grep -n "text-\[[0-9]px\]"` 归零 + 对比度脚本 |
| **R6** | AI 技术深度"名实相符" | P0/P1 | 2–3 天 | R2 修完流式链 | `verify-stream-integrity.mjs` + 新增评测脚本 |
| **R7** | 冗余/死代码/旧代码清理 | P1 | 0.5–1 天 | 无（独立） | `tsc --noEmit` + `next lint` + `verify --quick` |
| **R8** | 演示叙事与现场作战 | **P0** | 1 天（+3 次彩排） | R1/R4/R5 | 3 次彩排计时误差 ≤10s |
| **R9** | 竞赛交付物与证据链 | **P0** | 2–3 天（与 R8 并行） | 全部 | 交付物 15 项逐项打勾 |

> **推荐排期（13 天版）**：D1 R1 + R3 → D2 R2 → D3 R4/R5 → D4 R6（R1–R4）→ D5 收尾验证 + R7 → D6–D8 R9（PPT/视频/README）→ D9–D12 R8 彩排；**R8 的彩排必须最后做**，因为演示脚本依赖所有 UI 文案与自动路演行为已冻结。

### 0.3 每一轮怎么用（三步法）

1. **新开一个干净的 AI 编码会话**（避免上下文污染），把「0.4 全局前置块」+ 该轮「主 Prompt」一起粘贴。
2. 待 AI 完成后，**先自己跑验收命令**；不通过就把报错原文回贴，让它修到全绿（不要让它"解释为什么通过"）。
3. 再粘贴该轮「进阶优化追问 Prompt」，做第二轮深化；最后把「验收清单」逐项打勾，**打不了勾的写进风险台账**，不要口头承诺。

### 0.4 全局前置块（每一轮主 Prompt 前都建议带上）

```text
【项目】KubeVision AI：Next.js 14.2.18 App Router 全栈单体 + React 18.3.1 + TypeScript 5.6（strict）
        + three r169 + @react-three/fiber 8.17.10 + drei 9.114.3 + @react-three/postprocessing 2.16.3
        + zustand 4.5.5 + Vercel AI SDK 3.4.33 + @huggingface/transformers 3.1.2 + Tailwind 3.4.17。
【路径】仓库根目录：C:\Users\Dannie\Desktop\AI项目\KubeVision
【必读】先完整阅读 AGENTS.md（强制工程契约），再读 README.md 与 docs/COMPETITION_TECHNICAL_WHITEPAPER.md 的相关章节。
【红线】（违反任一条即视为失败，必须重做）
  1. 严禁新增/升级依赖，严禁改动 package.json 依赖版本（依赖世代锁）。
  2. 严禁 any / @ts-ignore / @ts-expect-error；所有 Props/Store/API 载荷必须引用 src/types/ 下的既有契约。
  3. useFrame 内禁止 new THREE.*、禁止 setState、禁止触发 React 重渲染；高频数据走 useTelemetryRef 瞬态轨。
  4. 涉及 three / R3F / window / Worker / localStorage / SpeechRecognition 的代码必须客户端边界安全；重组件 next/dynamic + ssr:false。
  5. 禁止破坏离线优先：无 API Key、断网时全部核心链路必须仍可演示（引擎 B / 本地降级）。
  6. 核心算法（RAG 余弦、BM25、RRF、空间矩阵、GLSL、流式状态合并）必须保留/补充中文 JSDoc 原理注释。
  7. 不要改动与本轮无关的文件；不要顺手"美化"格式；不要删除既有中文注释。
【工作纪律】
  - 修改任何文件前先读该文件；大文件用偏移量分段读，禁止凭记忆改。
  - 每完成一个逻辑单元，立刻跑一次 `npx tsc -p tsconfig.json --noEmit`（不要生成 tsbuildinfo：加 `--incremental false`）。
  - 所有结论必须给证据：文件:行号、命令输出、截图/终端日志；禁止"应该可以""应该没问题"。
  - 交付时输出：①改动文件清单（含行数变化）②每个缺陷的根因一句话 ③验收命令的真实输出 ④未验证项与风险 ⑤回滚方式（git 命令）。
```

### 0.5 证据纪律（评委视角的"可信度工程"）

- **运行时事实 > 静态推断 > 口头描述**。任何"已修复"的声明，必须配一条可复现的验证命令或截图。
- 数据类结论（draw calls、检索延迟、脱敏吞吐）**只能由脚本生成**，禁止手填；脚本要跑两遍，结果必须一致。
- 演示相关修复，必须录一段 1080p 短视频作为证据（R1/R8 的验收都以此为准）。

### 0.6 本手册的"可砍清单"（时间不够时按序放弃）

R6 轮内的选做项（多步 tool calling / grounding / 端侧视觉 / 语音全链路 / 离线权重）→ R4 的 M3/M4（draw call 合并 / 发光预算）→ R9 的 Dockerfile 与部署链接 → R7 的 B 类重构。**P0 不可砍**：R1、R2 的 5 个 P1、R3、R8、R9 的提交物。

### 0.7 文件地图（按轮次高频）

```
src/utils/demoDirector.ts            一键路演状态机（R1 核心，814 行）
src/components/layout/TopBar.tsx     路演按钮/字幕条/顶栏（R1/R5，1271 行）
src/store/useClusterStore.ts         双轨状态 Store（R1/R2/R3，1055 行）
src/utils/syntheticEngine.ts         合成遥测引擎（R3，1165 行）
src/hooks/useTelemetryStream.ts      SSE 订阅 + 免疫合并（R2/R3，772 行）
src/app/api/telemetry/route.ts       SSE 推流（R3）
src/app/api/chat/route.ts            双擎流式 + 工具 + RAG 编排（R2/R6，2828 行）
src/components/ai/CopilotDrawer.tsx  AI 抽屉（R2/R6，2681 行）
src/utils/sreRagEngine.ts            BM25/TF-IDF/RRF/校准（R2/R6，1310 行）
src/workers/logClassifier.worker.ts  端侧 384 维推理（R2/R6）
src/app/api/mcp/execute/route.ts     MCP 执行端点（R2/R6）
src/components/canvas/*              R3F 场景（R4）
src/app/globals.css + tailwind.config.ts  设计令牌（R5）
scripts/verify.mjs / benchmark.mjs   验收与性能脚本（R3/R9）
```

---

## 1. 审计结论（Evidence Base，所有 Prompt 的事实来源）

### 1.1 一句话诊断

> **工程底子 85 分，自洽性与证据链 60 分。**
> 真正的风险不是"功能少"，而是**"演示链路在评委眼前自证矛盾"**：镜头锁着健康机架、AI 说故障在另一台、最后宣布"自愈完成"而卡片还在等用户点击。修完 R1/R2/R3 之后，作品的"可信度"会比"功能数"高一个档。

### 1.2 P0 缺陷（自动路演，已在临时副本实跑复现）

| # | 缺陷 | 证据（运行期） | 影响 |
|---|---|---|---|
| **P0-1** | 混沌场景→锁定节点映射写反：OOM 剧本锁 `node-worker-alpha`，而 OOM 受害 Pod 全在 `node-worker-beta`；网络剧本锁 beta，而丢包受害机架是 gamma | 阶段 2 采样：`selected=node-worker-alpha`，`byRack={0:坏0, 1:坏3, 2:坏0}`；同一屏 AI 正文写"宿主节点 node-worker-beta"，左侧 HUD 写"worker-alpha" | 核心卖点"空间锁定告警机架"当场被证伪 |
| **P0-2** | 阶段 4 自愈解析不到故障 Pod：按聚焦节点过滤 → victims=[] → 兜底对 `node-worker-alpha` 执行 `drain_node`；真正受害 Pod 一个没修；画面恢复实际来自 `setActiveChaos('NONE')`（取消演练） | 结束态 `healedPodIds=['node-worker-alpha']`（命中 victim 应 ≥4）；MCP 回执 `drain_node`，而 AI 卡片是 `restart_pod / redis-cluster-shard-0` | 宣称的"MCP 闭环自愈"与真实动作不符 |
| **P0-3** | HITL 被绕过 + 终态自相矛盾：导演直接调 `healEntity`，不经过「勾选 → 立即执行」；字幕条写"MCP 闭环自愈完成"，右侧动作卡仍 pending「立即执行自愈方案」 | 截图 `05-finished.png`：字幕条"已自愈" vs 卡片"待执行" | HITL 护栏（演示卖点）被打脸；评委点击会触发重复自愈 |

> 复现脚本与截图：`%TEMP%\kvision-review\demo-repro.mjs`、`%TEMP%\kvision-review\shots\*.png`；完整报告：`%TEMP%\kvision-review\t1-demo.md`。

### 1.3 P1 缺陷索引（R2/R3 的修复清单）

| 域 | 缺陷 | 位置 | 后果 |
|---|---|---|---|
| 路演 | 未强制切回 demo 模式（持久化 live 时路演"什么都没发生"） | `demoDirector.ts:358-364` vs `TopBar.tsx:938-946` | 现场保险失效 |
| 路演 | 阶段 3→4 固定 15s，不感知 AI 流真实结束 | `demoDirector.ts:135-164` | 慢网络/真 LLM 下阶段 4 打断诊断 |
| 路演 | 阶段 4 "环绕巡检"被 CameraRig 同批关掉 | `demoDirector.ts:470-473` + `CameraRig.tsx:191-204` | 收尾仪式感消失 |
| 路演 | 30s 内重复路演被免疫窗口吞掉（无 `clearHealedPodIds`） | `useClusterStore.ts:70,559-588` | 第二次演示失败 |
| 遥测 | QPS 复利漂移：`qpsBaseline=prev.totalQps` 每 tick 再乘正弦 | `syntheticEngine.ts:673-682` | 12,850→3,298→1,059→7,629，数据不可信 |
| 遥测 | 节点 CPU 随机游走无回归，长会话归零 | `syntheticEngine.ts:580-585`（注释称"回归"） | 健康度 100 但全节点 0% CPU |
| RAG | Sigmoid 中/弱段系数写错（宣称 0.58，实际 0.28 段得 0.2999；0.10 段得 0.2462），阈值处跳变且按校准分排序导致 Top-K 反转 | `sreRagEngine.ts:828-834,1356-1362` | 检索可信度被追问击穿 |
| 交互 | Esc "分级退出栈"失效：4 处独立 window keydown，一次 Esc 关两层并清选中 | `page.tsx:242-259`、`RagKnowledgeModal.tsx:466-475`、`PostMortemModal.tsx:146-155`、`ChaosControlModal.tsx:154-161` | 演示误触失控 |
| 端侧 | 审计降级死锁：看门狗不置 `isReady`、classify 无超时、runAudit 无 null 兜底 | `useEdgeLogClassifier.ts:279-292,236-250,315-334` | 端侧页签卡死 |
| MCP | 真集群 `restart_pod` 命名空间写死 default、404 当成功、kubectl 回执与实际动作不符 | `api/mcp/execute/route.ts:141-155,277-300` | 假成功回执 |
| HITL | ActionConfirm 目标静默回退 `pods[0]` 后照常执行，回调仍传原 targetId | `ActionConfirm.tsx:263-288,378`；`CopilotDrawer.tsx:1677-1724` | 确认对象≠执行对象 |

### 1.4 P2/P3 索引（30 条，详见 R2 清单）

- **流式/Agent**：引擎 A 失败回落 B 重复卡片（`chat/route.ts:2753-2773`）· 停止生成后消息级 `isStreaming` 不复位（`CopilotDrawer.tsx:1523-1573`）· `sleep()` abort 监听泄漏（`chat/route.ts:890-908`）· 流式期间"快照诊断"被静默丢弃（`:1734-1739,1291`）· 多轮历史动作卡永远缺失（`:483`）· TTS 写在 setMessages updater 内 StrictMode 双播（`:1512-1521`）· 复盘报告用导出时刻快照（`:1254-1266`）。
- **RAG/脱敏**：IDF 缓存指纹只看长度+首末 id（`sreRagEngine.ts:630-657`）· 脱敏非幂等（`logSanitizer.ts:141-143`）· URL 凭证遇未转义 `@` 截断泄露（`:107-108`）。
- **端侧/语音**：Worker 模型并发重复初始化（`logClassifier.worker.ts:800-802`）· 拾音 rAF 每帧 setState 拉满整树重渲染（`useSpeechInput.ts:358-409`）· 静音不自动收尾、麦克风常开（`:393-403`）· start 无并发互斥（`:526-563`）· 识别失败用推断文本冒充结果（`:569-611`）。
- **遥测/状态**：live 采集无在飞互斥（`api/telemetry/route.ts:216-268`）· live+K8s 内存恒 0（`liveTelemetry.ts:798-818`）· 免疫合并误把无异常 Pod 的节点强制 Ready（`useTelemetryStream.ts:313-335`）· 自愈免疫排队无消费者（`useClusterStore.ts:559-588`）。
- **P3**：`/api/verify/rag` 未校验元素（`verify/rag/route.ts:42-49`）· 瞬态池按下标映射（`useTelemetryRef.ts:126-150`）· 固定 seed 时间戳跨模式混用（`types/cluster.ts:249`）· TTS blocked 态不复位（`useSpeechSynthesis.ts:401-417`）。

### 1.5 冗余 / 死代码 / 旧代码审计结论

| 类别 | 数量 | 代表项 | 建议 |
|---|---|---|---|
| **A 类·安全删除（零引用）** | **≈322 行源码 + 3 个产物** | `HoloLeaderLine`（HoloHud.tsx:276-354，79 行）、`useAdaptiveQualityFactor`（useInViewPause.ts:127-159）、`useHasHydratedClusterStore`（useClusterStore.ts:1017-1054）、`BootstrapChecklistItem`、`ChaosScenarioOption`/`PerfHudSample`、`sanitizeBatch`/`hasSensitiveData`、`getRunbookById`、`createEngineState`、`DEFAULT_DRAWER_PCT`、死 CSS（`.kv-status-dot` 族/`.text-glow-*`/`.kv-html-label`）、3 个 `tsconfig*.tsbuildinfo`（1.27MB） | R7 批 1 直接删 |
| **B 类·需确认** | ≈490 行代码 + 750 行文档 | `ShellLayout` 不可达占位回退（≈107 行）、`useOptionalGltfModel` GLB 休眠管线（209+106 行）、`computeClusterHealthScore` 双份实现、时间戳格式 3 份、`McpExecuteReceipt` 类型双份、`.cursorrules` 过期、根目录 2 份旧报告被代码 21 处悬空引用 | R7 批 2 逐项决策 |
| **C 类·文档漂移** | 6 组指标 + 12 处口径 | README/白皮书 307 draw calls vs `docs/performance.*` 396；11.14ms vs 7.87ms；9,573 vs 14,931 条/s；64 文件/34,600 行 vs 69 文件/45,956 行（非空 36,314）；`useSpeechRecognition.ts` 死链；白皮书 `K8S_API_URL` vs 代码 `K8S_API_SERVER`；`public/models` 规范 5 处与代码不符 | R3/R9 统一从脚本生成 |

### 1.6 视觉诊断（R4/R5 的事实来源）

**已落地、不要重复做的**（`kubevision_championship_blueprint.md` 的 1.1–1.8/2.x/3.1/4.x 基本已完成且质量更高）：程序化 PBR 环境、`onBeforeCompile` 棱边/菲涅尔、机架多部件拼装、假辉光 `GlowHalo3D`、光学玻璃 HUD、长焦斜轴构图、地面拓扑星环、矩阵雨。

**真正的 5 个根因**：

1. **正常路径没有色调映射**：`@react-three/postprocessing` 的 `EffectComposer` 挂载时把 `gl.toneMapping` 置为 `NoToneMapping`，而 Composer 只在 `heavyRenderEnabled=true` 时挂（`ClusterCanvas.tsx:675`）→ 正常路径线性直出、高光硬切；软件兜底路径反而是 R3F 默认 ACES，两条路径观感割裂。
2. **后处理无抗锯齿**：`multisampling={0}`（`:675`），Canvas 的 `antialias` 对 FBO 无效 → Retina/4K 细环与光缆锯齿闪烁。
3. **兜底名不副实**：`heavyRenderEnabled` 只关 Composer，反射（每帧全场景重渲）、ContactShadows、阴影全部照跑 → SwiftShader 实测 2 FPS。
4. **微排版塌陷**：`<10px` 字号 **80 处**（7px×3 / 8px×6 / 9px×71，含 3D 铭牌）；`text-slate-600`（2.66:1）72 处、`slate-700` 10 处。
5. **构图**：1920 全屏 3D 视口 1247×1016，前排机架底部被视口裁掉 18px 且压在 TerminalEcho 上；Master 精确在 (50%,50%) 死居中。

**参数级方案（摘录，完整表见 R4 Prompt）**：

| 项 | 现值 | 建议 |
|---|---|---|
| ToneMapping | 正常路径无 | `ToneMappingMode.NEUTRAL` + `toneMappingExposure=1.05`（NEUTRAL 保状态色相，ACES/AgX 会压灰运维语义色） |
| Bloom | threshold .62 / smoothing .24 / intensity .55 / radius .56 / levels 8 | **.78 / .14 / .72 / .62 / 6** |
| AA | multisampling 0 | T3 `multisampling=2`；T2 `<FXAA/>`；`antialias:false`（顺序：Bloom→ToneMapping→AA→Vignette/Noise） |
| 灯光 | ambient .42 / hemi .55 / key 1.85 / rim .65 / point 36 | **.18 / .34 / 2.30 / .95 / 28**（key:fill ≈3.4:1） |
| 阴影 | 1024² / ±16 | 2048² / ±13 / normalBias .02；ContactShadows 768 / blur 1.6 |
| 反射 | 512/256 + 全场景重渲 | T2 固定 256 + blur[180,56] + mixStrength 9；T1 换 1DC 哑光 shader |
| DPR | 初值 2，范围 [1,2] | `min(devicePixelRatio,1.75)`，下限 0.85 |
| 构图 | lookAt `[0,2.5,0]` | `OVERVIEW_LOOK_AT=[0,1.20,0]`（零脚本改动；前排入画、Master 上移到 44% 高） |
| 字号 | 80 处 <10px | 全仓 0 处 <10px；正文 ≥12px，辅助标签 10–11px，`slate-600/700` → `slate-500` |
| 玻璃 | 27 处 `backdrop-blur` | 收敛为 `.kv-panel`（20px，仅顶栏/抽屉/模态）+ `.kv-chip`（8px，小浮层），省 1.5–3ms |

### 1.7 AI 技术含金量体检（R6 的事实来源）

| 能力 | 判定 | 说明（评委追问最容易被击穿的点） |
|---|---|---|
| 双擎 NDJSON 流式 | **A 真实现** | 先校验后发 `tool-start` + 双兜底 + 流内 `engine` 事实声明，工程最扎实 |
| 四阶段 ReAct | **C 演示性** | 耗时是 `SIM_LATENCY` 常量（`chat/route.ts:77-83`）；无 `maxSteps`、无 observation 回环 |
| 混合 RAG | **A/B** | BM25/IDF/RRF/Sigmoid 全真；但"稠密路"是 TF-IDF 词袋、RRF 只融 2 路、无 Recall@K 评测 |
| Sigmoid 校准 | **A 真实现**（但系数写错，见 R2） | 分段系数由边界条件反解，是"自我纠错"素材 |
| 端侧 384 维 zero-shot | **A 真实现**，演示路径是 **B** | 模型未随包（`public/models` 无权重），现场走内置分类器，UI 有诚实标注 |
| 6 类 PII 脱敏 | **A 真实现** | 端云只移交脱敏摘要；注意非幂等与 URL 凭证截断（R2） |
| MCP JSON-RPC | **B 半实现** | 执行证据链真；但无 `initialize/tools/list/tools/call`，`id` 不回显 → 标准客户端连不上 |
| GenUI 水合 | **A 真实现** | synthesized 诚实角标 |
| 多模态截图 | **B 半实现** | 有 Key 时真；无 Key 时引擎 B 不读像素，却写"空间观察" |
| 语音双通道 | **A 真实现** | 麦克风频谱 + 声学兜底 + 中文音色，比白皮书写的更复杂 |

**最高性价比 5 项**（全部零新增依赖）：R1 实测可观测层（消解"耗时是编的"）→ R3 检索评测集（消解"没有评测"）→ R2 MCP 规范化（消解"不是 MCP"）→ R4 真 embedding 双路召回（消解"假稠密路"）→ R9 端侧像素特征（消解"截图没被看"）。

### 1.8 竞赛事实与评分推演（R8/R9 的事实来源）

- **评分维度现状**：团队自述六维（AI 35 / 创新 25 / 工程 10 / 实用 10 / 体验 10 / 社会价值 10）**无官方出处**；外部可印证的往届 Web 赛道维度为"创意 15% / UX 20% / 技术实现 25%（后两项页面截断）"。
- **估算分**：保守 60–63 / 乐观 80–83（100 分制）；对标第八届省一 88 分，**缺口不在功能，在"证据链"与"合规件"**。
- **5 个失分点**：① 数据自相矛盾 6 组；② 提交物缺 7 项（PPT-PDF/3min 视频/源码 zip/LICENSE/部署链接/团队信息/第三方引用声明）；③ 默认无 Key → 抽屉显示"本地确定性容灾引擎"，需主动反转叙事；④ 演示脚本 4 处与真实 UI 文案不符（自愈必须先勾选复选框）；⑤ 商业/社会价值只有定性段子，无市场规模/竞品矩阵/单位经济/试点数据。
- **最危险瞬间**：评委看到"推理引擎 · 本地确定性容灾引擎"会先入为主认为 AI 是假的。**必须主动讲**这一行，并演示"切云端 LLM → 断网 1 秒回落到引擎 B"。
- **不确定项（今天必须向指导教师/赛点确认）**：官方评分表与提交规范原件、赛道 ID 10037 对应关系、报名状态与组别（A/B/C）、省赛形式（线上评审 or 现场答辩）与时长、现场机器有无独显、是否允许公网部署链接。

### 1.9 数据自相矛盾清单（R3/R9 必须统一）

| 指标 | README/白皮书现值 | `docs/performance.json` 实测 | 处置 |
|---|---|---|---|
| Draw Calls | 307（min=max=307） | **396**（min=max=396） | 统一为脚本最新值，并注明采集环境 |
| InstancedMesh / 实例 | 10 / 352 | **21 / 610** | 同上 |
| 逐个渲染 draw calls | 589 | **921** | 同上 |
| Mesh / Points / Lines | 237 / 6 / 2 | **311 / 6 / 3** | 同上 |
| RAG 检索 | 11.14ms / P95 12.48 | **7.87ms / P95 9.62** | 同上 |
| 脱敏吞吐 | 9,573 条/s | **14,931 条/s** | 同上 |
| 代码规模 | 64 文件 / 34,600 行 | **69 文件 / 45,956 行（非空 36,314）** | 同上 |
| 验收项数 | "32 项全绿" | `ok()` 35 处、`skip()` 10 处 | 实跑后填真实通过数并存证 |

---

## R1 · 自动路演 P0 重建（Demo Integrity）

**目标**：让"一键路演"成为**评委无法挑错的自证链路**——镜头锁定真实受灾机架、自愈命中真实受害 Pod、HITL 由真实 UI 完成、旁白数字与画面一致、连跑两遍结果一致、任何环境都能自检。
**前置**：完整阅读 `src/utils/demoDirector.ts`、`src/components/layout/TopBar.tsx:685-1271`、`src/store/useClusterStore.ts`、`src/components/canvas/CameraRig.tsx`、`src/components/ai/GenUI/ActionConfirm.tsx`、`src/app/api/telemetry/route.ts`、`src/utils/syntheticEngine.ts:60-100,620-705`。
**产出**：修复后的 `demoDirector.ts` + 新增 `src/utils/chaosTargets.ts` + Store 新增复位动作 + `scripts/verify-demo.mjs` + README「剧本路演」章节。

### R1 · 主 Prompt（复制给 AI 编码工具）

````text
你是资深 React 18 状态机架构师 + 演示系统工程师，负责修复 KubeVision 的「一键自动路演（Auto-Play Demo Director）」。
这是参赛作品在评委面前的"最后一道保险"：任何一处事实错误都会被当场识破，必须做到"系统自己证明自己"。

【已复现的 3 个 P0（必须逐条修复，不得以"演示能跑"为通过标准）】
P0-1 场景→节点映射写反：`demoDirector.ts:111-116` 把 OOM 剧本锁定为 node-worker-alpha、网络剧本锁定为 node-worker-beta；
     但 `syntheticEngine.ts:73-94` 的事实是：POD_OOM_SWARM→rackIndex 1（node-worker-beta）、NET_PACKET_LOSS→rackIndex 2（node-worker-gamma）、NODE_CPU_SPIKE→rackIndex 0（node-worker-alpha）。
     运行期已证实：阶段 2 镜头与探针卡锁在健康的 worker-alpha，而 3 个 OOMKilled Pod 全在 worker-beta；AI 正文写"宿主节点 node-worker-beta"，同屏左侧 HUD 写"worker-alpha"。
P0-2 阶段 4 自愈解析不到受害者：`resolveHealTargets()` 只按 `pod.nodeId === 聚焦节点` 过滤 → victims=[] → 兜底对健康节点执行 `drain_node`；
     真正受害 Pod 一个未修；画面恢复实际来自 `setActiveChaos('NONE')`。终态 `healedPodIds=['node-worker-alpha']`（若命中应为 ≥4），MCP 回执 actionType='drain_node'，
     而 AI 动作卡是 'restart_pod / redis-cluster-shard-0' —— 宣称的闭环与真实动作不符。
P0-3 HITL 被绕过 + 终态自相矛盾：导演直接调用 `healEntity`，不经过 ActionConfirm 的「勾选 → 立即执行」流程；
     字幕条显示"MCP 闭环自愈完成"时，右侧动作卡仍是 pending「立即执行自愈方案」。同一屏幕上"AI 需要人类确认"与"系统已替你执行"同时成立。

【实施要求（按 A–J 顺序做，每步完成后自检）】

A. 建立单一事实源（消除硬编码漂移）
   新增 `src/utils/chaosTargets.ts`，作为全仓唯一的"混沌场景 → 受灾目标"映射：
   - 导出 `CHAOS_TARGETS: Readonly<Record<Exclude<ChaosScenario,'NONE'>, { rackIndex: number; nodeId: string; expectedPodStatus: 'OOMKilled'|'CrashLoopBackOff'|'Pending'; remediationAction: 'restart_pod'|'scale_deployment'|'drain_node'; label: string }>>`
   - rackIndex 必须与 `syntheticEngine.ts` 的 OOM/SPIKE/PARTITION 常量一致；nodeId 由 `types/cluster.ts` 的 rack→node 映射派生（禁止再写节点字面量）。
   - `demoDirector.ts`、`ChaosControlModal.tsx`、`app/api/chat/route.ts` 的 `pickRemediationActionType` 全部改为引用该表（chat 侧可只引用 action 规则，避免把前端字典打进服务端；若跨端共享，抽 `src/utils/chaosFacts.ts` 纯函数并加中文 JSDoc）。
   - 增加运行时断言：`nodeId` 必须能在 `snapshot.nodes` 中找到，否则启动前自检失败。

B. 重写阶段动作（事实驱动，不许硬编码叙事承诺）
   1) 阶段 2：从 CHAOS_TARGETS 取 nodeId → `selectEntity(nodeId,'node')`；注入后 2 秒内轮询 `snapshotSummary`，断言该节点名下异常 Pod 数 ≥1；
      若超时仍无异常（例如 SSE 降级/失败），旁白降级为"已注入故障，等待数据回传"，不得宣称"已锁定告警机架"。
   2) 阶段 3：触发 AI 诊断前先设置真实 3D 截图（复用「快照诊断」的 capture 管线：canvas.toDataURL → setCapturedViewport），让自动路演覆盖"多模态"卖点；
      记录本次请求的 assistantMessageId（见 C）。
   3) 阶段 4：
      - 受害者解析改为**全局**：优先取 `snapshotSummary.activeAlerts` 中 P0 告警的 entityId（过滤出 pod-*），其次取全量 `pods.filter(p => p.status !== 'Running')`，最多 3 个；
        禁止再按聚焦节点过滤，禁止 `drain_node` 兜底。
      - actionType 由 CHAOS_TARGETS.remediationAction 决定（OOM→restart_pod、网络→drain_node、CPU→scale_deployment）；对 Pod 目标强制不许 drain_node。
      - 执行后必须校验：`Object.keys(healedPodIds)` 覆盖全部受害者 ID；未覆盖则**如实降级**旁白为"已终止演练并恢复稳态，自愈未完全验证"，禁止宣称 MCP 闭环。
      - MCP 回执请求的 targetId 必须是首个受害 Pod（而不是节点），targetName 用可读名（`pod.name` 而非 pod.id）。
   4) 旁白动态化：`DemoPhase.narration` 改为"静态兜底 + 运行时事实模板"两段式；在 `enterPhase` 里用当帧快照渲染 `{victimCount}`、`{nodeName}`、`{actionType}`、`{healthBefore}→{healthAfter}`。事实取不到时去掉具体数字/名称，绝不编造。

C. 事件驱动同步（替换固定 15 秒窗口）
   - 在 Store 或轻量事件总线新增 Copilot 活动状态：`copilotStreaming: boolean`、`lastAssistantMessageId: string|null`、`lastToolCardIds: string[]`（由 CopilotDrawer 在流开始/结束/卡片水合时写入；保持现有细粒度订阅风格，禁止整树全量订阅）。
   - 阶段 3 → 阶段 4 的推进条件改为：`copilotStreaming===false && actionCardMounted===true`，外加 25s 超时兜底（超时则旁白如实说明"诊断未在预期时间内完成，继续演示自愈流程"）。
   - 总时长 `durationMs` 改为"阶段表 + 运行时完成事件"自适应：进度条总长随实际推进重算（对外仍保持 ~30–40s 的观感）。

D. HITL 用真实 UI 完成（不要另开执行路径）
   - 新增"导演模式"信号（如 `useClusterStore.demoAutoConfirm: boolean`，仅内存态、非持久化）。
   - 阶段 4 等动作卡挂载后：①若卡片含复选框，自动勾选；②点击「立即执行自愈方案」；③等待 `ActionConfirm` 回调完成后进入收尾。
   - 卡片/按钮需带 `data-demo-auto="true"` 或 aria 标注「自动演示模式」，让评委看得出这是演示编排而不是绕过护栏。
   - 若 8s 内卡片未挂载：降级为"直接 healEntity + 旁白说明自动演示未获取到动作卡"，并把卡片状态在终态统一置为 executed 或移除（禁止出现"已完成"与"待执行"并存）。

E. 连接模式与全量复位
   - `startDemoDirector` 首步：若 `connectionMode !== 'demo'`，调用 `setConnectionMode('demo')` 并写审计行「路演需要合成数据源，已自动切回」。
   - Store 新增 `resetDemoEphemeralState()`：清空 healedPodIds、pendingRemediations、lastRemediationDiff、capturedViewportDataUrl，statusFilter→'ALL'，关闭 isChaosModalOpen/isPerfHudOpen，activeRightTab→'copilot'。
     启动前与 stop 后都调用；补一个 `clearHealedPodIds()` 动作（当前 Store 无任何清除免疫表的入口，导致 30s 内重复路演自愈被免疫窗口吞掉）。
   - `stopDemoDirector` 还需：清空 quickPromptTrigger、停止 TTS 解说、通过事件总线 abort 进行中的 Copilot 流（新增 `demoBus` 或 store 的 abort token），避免停止后 AI 继续流式输出。

F. 相机/巡检协调（修复"巡检开了又被关"）
   - 现状：阶段 4 先 `selectEntity(null)` 再 `setOrbitPatrolActive(true)`，`CameraRig` 的选中变化 effect 会调用 `disengagePatrolIfActive()` 把巡检立即关掉（终端同一秒出现 engaged→disengaged）。
   - 方案：CameraRig 增加 `cameraArrived` 事件（飞行到达 <0.15 时通过回调/store 广播）；导演引擎在收到到达事件后再开启巡检；或给 `setOrbitPatrolActive` 增加 `reason:'user'|'programmatic'`，CameraRig 只对 user 拖拽/非空选中飞行执行 disengage。
   - 阶段 1 同理：若启动前用户已选中实体，先等相机回到全景再开巡检。

G. 暂停 / 停止 / 页面可见性
   - pause：暂停 TTS 播报、标记"AI 流暂停展示"（不强制 abort，但要停止字幕推进）；resume 后继续。
   - 页面隐藏（document.visibilityState==='hidden'）自动 pause，恢复可见时字幕条提示「已暂停，点击继续」——避免切 PPT 再切回时阶段"补触发"连跳。
   - unmount 清理保持幂等（现有实现可复用）。

H. 启动自检（Preflight）
   - 启动前依次检查：`[aria-label="3D 集群拓扑视口"]` 存在、`window.__KUBEVISION_STORE__` 存在、Copilot 抽屉已挂载（DOM 标记）、SSE 传输 ≠ 'fallback'（或允许 fallback 但旁白标注）、connectionMode='demo'。
   - 任一失败：不启动剧本，在字幕条位置显示「演示环境自检未通过：<原因>」，并在终端打一条 `[DEMO-PREFLIGHT]` 日志。禁止"假装在跑然后成功结束"。

I. 结束态
   - finished 时字幕条提供「重播 / 关闭」两个动作；8s 无操作自动收起并复位（保留一次 `stopDemoDirector` 语义）。
   - 结束时把动作卡状态与旁白统一（见 D），并把 orbit 置 true（巡检收尾）后不再被关掉。

J. 回归脚本 `scripts/verify-demo.mjs`（复用 scripts/verify.mjs 的 CDP harness：headless Edge + Runtime.evaluate）
   必须断言并打印实际值：
   1) 阶段 2：selectedEntityId 的节点名下存在异常 Pod，且 activeAlerts 非空；截图存档。
   2) 阶段 3：AI 流结束后 cards={metrics:1,rootCause:1,action:1}；AI 正文中的宿主节点 == selectedEntityId 对应节点。
   3) 阶段 4：healedPodIds 覆盖全部受害 Pod；MCP 回执 actionType 与 CHAOS_TARGETS 一致；动作卡状态 executed。
   4) 结束态：旁白中的健康分数值 == 顶栏健康分；orbit===true；console error 数 === 0。
   5) 连续跑两遍（第二遍在结束后 5s 内启动）：两遍 healedPodIds/victim 数量一致，第二遍不得出现 QUEUED 免疫日志。
   6) pause 4s → resume：阶段序号与进度单调不回退；stop：5s 内无新增 [DEMO-DIRECTOR] 日志、无 AI 流。
   脚本退出码非 0 时打印所有实际值（禁止只打印 PASS/FAIL）。

【硬约束】
- 不新增依赖；不改 package.json；不引入 any；所有新类型放 src/types/ 并在中文 JSDoc 中写清输入输出与状态流转。
- 保持 `useSyncExternalStore` 单例订阅架构；导演状态机仍留在 utils 层（不要塞进组件 useState）。
- 不破坏现有 `verify.mjs` 32 项断言（尤其 ActionConfirm 的 aria-label 与文案）。
- 改动必须可通过 `npx tsc -p tsconfig.json --noEmit --incremental false` 与 `npx next lint`。
- 不要顺手删无关代码；不要改视觉样式（R4/R5 负责）。

【交付格式】
1. 改动文件清单（含 +/− 行数）。
2. 每个 P0/P1 的根因一句话 + 修复点（文件:行号）。
3. `verify-demo.mjs` 的真实运行输出（含两遍连跑结果）。
4. 3 张关键截图：阶段 2（镜头在真正受灾机架）、阶段 3（AI 正文与 HUD 一致）、结束态（卡片 executed + 巡检中）。
5. 未验证项与回滚命令。
````

### R1 · 进阶优化追问 Prompt

````text
上一轮的修复我已验收。现在做"路演系统 2.0"的四项深化，仍然遵守同一套工程契约（无新依赖、零 any、中文 JSDoc、不破坏 verify.mjs）。

追问 1｜剧本参数化与"评委节奏"适配
把剧本从"写死 34s"升级为可参数化：`DemoScript` 增加 `pacing: { label: '标准'|'紧凑'|'讲解版'; phaseGaps: number[] }`。
- 标准：现有时长；紧凑：总时长压到 ~20s（AI 阶段等待流结束但压缩字幕停留）；讲解版：每阶段结束后插入"等待主讲人按空格继续"的断点（暂停点）。
- 字幕条上显示当前节奏与下一个断点提示；`Ctrl+Shift+D` 可在不重启的情况下切换节奏（切换时进度按比例重算，不重置已完成阶段）。
- 为三种节奏各写一条 verify-demo 断言（总时长/断点数/阶段数）。

追问 2｜"事故重放"能力（数字孪生时间轴）
新增 `src/utils/demoRecorder.ts`：每次路演按阶段记录 8–12 个关键帧（timestamp、selectedEntityId、activeChaos、victimIds、healthScore、cards 状态）。
- 结束后可在字幕条上打开「时间轴回放」：拖动进度条，按关键帧插值还原 3D 高亮/选中/健康分（不重放真实副作用，只做展示层回放）。
- 回放模式必须有醒目标识（防止评委误以为在跑真实演练）；`Esc` 退出。
- 验收：回放 34s 时间轴不卡顿、不触发任何写 Store 的副作用（用 mock store 断言零 action 调用）。

追问 3｜对抗性自检（现场环境模拟）
写一组"故障注入式"测试（可放在 verify-demo 里作为 --stress 模式）：
- 网络慢 300ms/800ms（用 CDP Network.emulateNetworkConditions）：阶段推进仍正确、旁白不抢跑；
- 引擎 A 返回 500：自动回落引擎 B，卡片不重复、流不悬挂；
- `webglcontextlost` 事件：页面不崩、给出恢复提示；
- 双击启动按钮 5 次：只有一个剧本实例、无重复定时器（用 `window.__demoDirectorDebug__.timerCount` 或等价调试口暴露计数）；
- 演示进行中卸载 TopBar（模拟路由切换）：无游离定时器、无 store 写入（监听 5s）。
输出一张"压力场景 × 结果"矩阵表。

追问 4｜把导演引擎做成可单测的纯状态机
- 抽 `DemoEffects` 接口（selectNode/injectChaos/triggerDiagnosis/heal/appendLog/narrate/setOrbit…），真实实现走 Store，测试实现走内存 mock；
- `demoDirector` 核心状态机改为 `createDemoMachine(script, effects, clock)` 纯函数工厂（clock 注入 `now()` 与 `schedule()`），可用 `node:test` 做单元测试：暂停恢复、跨阶段补触发、切换剧本、异常 effects（抛错）时的清理；
- 目标：核心状态机单测覆盖率 ≥90%，且新增 `pnpm test:demo` 脚本；不引入 vitest/jest 等新依赖（用 node:test）。
- 交付：单测文件 + 覆盖率说明 + 与 verify-demo 的分工说明（单测管逻辑，CDP 管真实 UI）。
````

### R1 验收清单

- [ ] 阶段 2 截图：选中节点名下有红色 Pod；AI 正文宿主节点与 HUD 选中节点一致。
- [ ] 阶段 4：`healedPodIds` 覆盖全部 victim；MCP 回执 actionType 与场景映射一致；动作卡 executed。
- [ ] 结束态：字幕旁白健康分 == 顶栏健康分；orbit=true；无 console error。
- [ ] 连跑两遍（间隔 <30s）结果一致，无 QUEUED 免疫日志。
- [ ] pause/resume 时间轴不跳段；stop 后 5s 无 AI 流/无导演日志。
- [ ] `tsc --noEmit --incremental false`、`next lint`、`node scripts/verify.mjs` 全绿。

---

## R2 · 运行时缺陷修复包（路演之外）

**目标**：把 5 个 P1 + 20 个 P2 按"用户可感知"的优先级修完，重点保住两条生命线：**流式链路不悬挂**、**端侧隐私链路不死锁**。
**前置**：先读 `t2` 完整清单（本手册 §1.3/§1.4），修复前对每条缺陷写一句"复现路径"。

### R2 · 主 Prompt

````text
你是资深全栈 AI 工程师，负责修复 KubeVision 在"路演"之外的运行时缺陷。以下每条都已由只读审计确认（含文件:行号）。
请分三批修复，每批一个独立 commit，修完立即跑回归。

【批次 A · AI 流式与 Agent 链路（最高优先，直接影响演示）】
A1. 引擎 A 中途失败回落引擎 B 会重复产出卡片（chat/route.ts:2753-2773 + CopilotDrawer.tsx:1431-1463）：
    增加"本轮已产出的工具调用集合"，回落时只补缺失卡片；前端按 toolCallId 去重（同 id 不重复挂载）。
A2. "停止生成"后消息级 isStreaming 永不复位（CopilotDrawer.tsx:1523-1573）：
    abort 分支与正常结束分支统一走 finalize()，把目标消息 isStreaming 置 false（保留已产出内容），TTS 按钮恢复可用。
A3. sleep() 的 abort 监听在正常完成时未移除（chat/route.ts:890-908）：
    用 `signal?.removeEventListener` 放在 finally；补一条"引擎 B 单请求监听器数量不增长"的断言（Node 可用 getEventListeners 或自己维护计数）。
A4. 流式期间"快照诊断"被静默丢弃（CopilotDrawer.tsx:1734-1739/1291）：
    改为排队：若 isStreaming，则缓存 pendingPrompt 并在当前流结束后自动发送（字幕/提示条告知"已排队"），不要静默 return。
A5. 多轮历史动作卡永远缺失（CopilotDrawer.tsx:483）：
    前端判断工具名与后端不一致（renderActionCard vs proposeRemediationAction），统一映射表并补历史摘要用例。
A6. TTS 在 setMessages updater 内执行副作用（CopilotDrawer.tsx:1512-1521）：
    把播报移出 updater（用 ref 记录待播报文本，effect 中执行），StrictMode 下不得双播。
A7. 复盘报告用导出时刻快照（CopilotDrawer.tsx:1254-1266）：
    报告应使用"事故发生时"的 before 快照（store 已有 lastRemediationDiff.beforeHealth 等字段），把 before/after 明确分节；无事故发生则如实写"稳态巡检，无事故"。

【批次 B · 端侧隐私与 MCP 执行（第二优先，涉及可信度）】
B1. 端侧审计降级死锁（useEdgeLogClassifier.ts:279-292/236-250/315-334）：
    - 15s 看门狗必须置 isReady=true（标记 builtin 模式），并写入 `runtime='builtin'`；
    - classify 增加单批超时（如 3s），超时返回内置分类器结果而不是悬挂；
    - runAudit 消费端对 null/异常做兜底，面板不得永久 disabled；批量并发上限 1，进度可取消。
B2. MCP 真集群路径修复（api/mcp/execute/route.ts:277-300/141-155）：
    - restart_pod 的 namespace 从请求体/实体查询取，不得写死 'default'；
    - 404/409 不得当成功：非 2xx 一律返回 JSON-RPC error（-32603）并标注 httpStatus；
    - kubectl 回执必须与实际动作一致（DELETE pod 就写 `kubectl delete pod`，不是 rollout restart；scale 的 replicas 数与回执一致）；
    - 保留 `mode:'simulated'` 的模拟路径与 auditDigest 可复算性。
B3. ActionConfirm 目标静默替换（ActionConfirm.tsx:263-288/378）：
    目标不存在时**不得回退 pods[0] 继续执行**；应停在确认态并显示"目标已不存在于当前快照，请重新诊断"，或重新解析后把 effectiveTargetId 回传给回调（回调与 HITL 确认对象必须同一）。
B4. 脱敏器（logSanitizer.ts:107-108/141-143）：
    URL 凭证规则支持密码中未转义 '@'（贪婪匹配到最后一个 @ 再切分）；所有替换符加"已是占位符则不重复替换"的短路，保证幂等；maskedCount 不虚增。

【批次 C · 交互与状态一致性（第三优先）】
C1. Esc 分级退出栈（page.tsx:242-259 + 3 个模态框各自的 window keydown）：
    建立统一 `useEscapeStack` 或"注册式退出栈"：每个弹窗向栈注册 onEscape 并返回优先级；全局只保留一个 keydown 监听（在 page.tsx），按优先级只退一层。输入框内 Esc 仍让位。
C2. 自愈免疫排队无消费者（useClusterStore.ts:559-588）：
    二选一：①实现真正的延迟重试调度器（到期重新调用 healEntity，并在 HUD 显示倒计时）；②取消排队语义，明确拒绝并提示"免疫窗口内不可重复自愈，剩余 Ns"。禁止保留"提示会重试但永不执行"的假承诺。
C3. 免疫合并误伤节点级故障（useTelemetryStream.ts:313-335）：
    节点 Ready 修正只对"免疫目标 Pod 所在节点"生效；其它节点保持服务端状态（避免 15s 内新注入的节点故障被掩盖）。
C4. live 采集链路（api/telemetry/route.ts:216-268 + liveTelemetry.ts:637-650/769-827）：
    - 加"在飞互斥"：上一帧采集未完成则跳过本轮，保证帧序与时间戳单调；
    - Pod 内存字段回填（:798-818 解析后未赋值）；
    - 采集失败保留上一帧并计数，连续失败 3 次降级为 demo 并写审计行。
C5. 语音链路（useSpeechInput.ts:358-409/393-403/526-563/569-611）：
    - 电平可视化从 rAF+setState 改为 ref + 低频 setState（≤8Hz），或用 CSS 变量驱动，避免 CopilotDrawer 整树 60FPS 重渲染；
    - 静音 1.8s 自动收尾；start 并发互斥（isStartingRef）；云端识别失败走声学兜底时，输入框内容明确标注"[声学推断]"，禁止冒充识别结果。
C6. RAG 校准系数（sreRagEngine.ts:828-834/1356-1362）：
    按函数自身注释声明的分段边界重新反解系数（强/中/弱三段必须连续、单调、无跳变），修完后用 4 类故障 + 2 个无关键做前后对比表；排序使用原始融合分而非校准分（或有明确 tie-break），确保"证据更强排名更前"。
C7. IDF 缓存指纹（sreRagEngine.ts:630-657）：指纹纳入全部文档内容哈希（简单 FNV-1a 即可），自定义 Runbook 编辑后必须失效。

【通用要求】
- 每条修复先写"缺陷复现断言"，再修；修完断言必须由红转绿（可加到 scripts/verify.mjs 或新脚本 scripts/verify-runtime.mjs）。
- 禁止用 try/catch 吞错来"修复"；错误路径必须有日志与 UI 状态。
- 涉及 API 契约的改动同时更新 src/types/ 与 README/白皮书对应章节。
- 修复不改变既有公开行为（除明确为缺陷的行为），改动范围尽量小；不要碰视觉与文案。

【交付】
1. 三批 commit（A/B/C），每批附：缺陷编号、根因、改动文件:行号、新增断言。
2. 回归输出：tsc / lint / verify.mjs / 新增 verify-runtime.mjs。
3. 一张"缺陷 → 验证方式 → 实际结果"的表。
4. 未修复项与原因（诚实列出，不许静默跳过）。
````

### R2 · 进阶优化追问 Prompt

````text
继续上一轮修复，做四项深化（不新增依赖）：

追问 1｜事件契约测试（防回归）
为 NDJSON 流建立"事件序列金样"：录制一次引擎 B 完整流（reasoning×4 + tool-start×3 + tool-result×3 + text chunks + done），
写成一个只读 fixture，在 `scripts/verify-stream-integrity.mjs` 里断言：事件顺序合法、无孤儿 tool-result、无重复 toolCallId、流结束后必达 done/engine 事件。
引擎 A 路径用 mock fetch 注入同样断言。目标：以后任何流式改动都能一键发现契约破坏。

追问 2｜错误预算与用户可见状态
统一 `types/ai.ts` 中的错误态：网络错误/模型错误/工具参数错误/服务端 5xx/abort 五类，各自有 UI 文案与重试动作；
前端禁止出现"转圈但无解释"超过 3s 的状态；每条错误都带 traceId（若尚无 trace，则先用 requestId），便于日志对账。

追问 3｜长跑稳定性
写 `scripts/soak.mjs`（Node）：连续调用 /api/chat 引擎 B 20 次 + /api/telemetry 连接 60s + 反复切换 chaos 20 次，
监控：内存增长（<10%）、监听器数量、SSE 连接数、定时器数量；输出报告 docs/soak.md。修复中发现的泄漏必须修掉。

追问 4｜React 18 StrictMode 一致性
在 dev（StrictMode 双挂载）下逐条验证：流式发送、TTS、语音拾音、端侧 Worker、SSE 订阅、自动审计定时器。
所有 effect 必须"挂载两次只产生一份资源、卸载后零回调"。写一份 docs/strictmode-audit.md 记录每条链路的行为与证据。
````

---

## R3 · 遥测真实性与数据自洽

**目标**：让"数据"经得起长跑与追问——QPS 不漂移、节点水位有回归、live 采集不叠加、免疫合并不掩盖新故障、所有对外指标由脚本生成且全站一致。

### R3 · 主 Prompt

````text
你是资深可观测性/时序数据工程师。KubeVision 的合成遥测引擎存在"数据自漂移"缺陷，已复现：
同一会话 90s 内 QPS 从种子 12,850 漂到 3,298 → 1,059 → 7,629；三个节点 CPU 从 39/34/30 随机游走到 0/0/0（健康分仍 100）。
这些数字会出现在顶栏、HUD、演示旁白里，评委追问"QPS 为什么乱跳"就会击穿整条可信度。

【根因（已定位）】
1) `syntheticEngine.ts:673-682`：`qpsBaseline = prevSnapshot.totalQps`，随后 `totalQps = round(baseline*(1+qpsWave+noiseQps)*penalty)` ——
   每 tick 在上一 tick 的结果上再乘正弦项，等价于复利漂移；而注释与设计意图是"围绕基准做正弦起伏"。
2) `syntheticEngine.ts:580-585`：节点 CPU/MEM 写的是 `node.cpuUsage + noiseNet*1.8`（随机游走），注释却称"轻度回归"；
   Pod 有均值回归（REVERSION_RATE=0.18），节点没有 → 长时间运行必然漂到 0 或 100。
3) `applyLiveChaosOverlay` 与 live 采集链路复用同一套演进函数，需一并校验是否会继承同类问题。

【任务】
A. QPS 锚定
   - 引入不可变基准常量（建议 `QPS_BASELINE = INITIAL_CLUSTER_SNAPSHOT.totalQps`，或从种子快照派生一次），每 tick 直接 `round(QPS_BASELINE*(1+wave+noise)*penalty)`；
   - 预留 `qpsBaseline` 字段时不得再从上一帧读取；补中文 JSDoc 写明"为什么不能用上一帧做基准（复利漂移）"。
B. 节点水位均值回归
   - 为节点 CPU/MEM 引入与 Pod 同口径的回归：`next = current + (baseline - current)*REVERSION_RATE + noise`，baseline 取种子快照对应节点值；
   - 故障场景（CPU 尖峰/OOM/网络分区）仍按现有规则覆盖；故障解除后按回归曲线回到基线（可观察"恢复过程"）。
C. 时间戳与跨模式一致性
   - `SEED_TIMESTAMP_MS` 固定编译期常量导致 demo 快照时间与墙钟无关；改为"连接建立时以 Date.now() 为起点、since 保证单调"（保持 SSR 确定性：store 初始值仍用固定种子，首帧之后由 SSE 帧接管）；
   - live/demo 两模式的 timestamp 不得互相污染（连接切换时沿用 since 单调，不倒退、不跳变超过 1 tick + 网络时延）。
D. live 采集链路
   - 加"在飞互斥"（上一帧未完成跳过本轮）；帧时间戳按采集完成时刻单调推进；采集失败保留上一帧并计数，连续 3 次降级 demo 并写审计行；
   - 修复 live+K8s 模式 Pod 内存恒为 0（解析后未回填）。
E. 免疫合并的边界
   - `useTelemetryStream.ts:313-335` 的节点 Ready 修正只对"免疫目标 Pod 所属节点"生效；其它节点保持服务端状态；
   - 免疫窗口到期后，被改写过的 Pod 必须平滑回到服务端值（不允许突跳），必要时在合并层做一帧插值标记。
F. 数据不变式测试（新增 `scripts/verify-telemetry.mjs`，node:test 风格或纯脚本断言）
   1) 长跑 300 tick（chaos 轮换 NONE→OOM→NONE→NET→NONE→SPIKE→NONE）：QPS ∈ [0.85,1.15]×基线；节点 CPU ∈ [10,90]；健康分 ∈ [0,100]；
   2) 同种子同输入 => 输出逐字节一致（确定性）；不同 tick 必不同；
   3) 时间戳严格单调 +1000ms（重连 since 场景除外，需单独断言）；
   4) pods[].cpuHistory/memHistory 长度恒 6、末位 == 当前值；Node podIds 与 Pod nodeId 双向一致；
   5) chaos 复位后 60 tick 内节点回到基线 ±8%。
G. 指标口径统一
   - 跑 `node scripts/benchmark.mjs`，把 README/白皮书/`docs/performance.md` 中 7 组矛盾数字（307→396、352→610、10→21、589→921、11.14→7.87、9573→14931、64/34,600→69/45,956）全部改为脚本生成；
   - 在 README 增加"数据采集环境与时间"声明（SwiftShader/无 GPU；FPS 不作为性能证据）；
   - 新增 `scripts/sync-docs-metrics.mjs`：读取 docs/performance.json，自动替换 README/白皮书中的占位区块（用 `<!-- METRICS:BEGIN -->` 标记），避免下次再漂移。

【约束】
- 纯函数保持无副作用、无 Math.random（沿用 hashNoise 确定性噪声）；SSR 初始快照仍必须是编译期常量。
- 修改 syntheticEngine 不得改变渲染层的字段契约（PodEntity/WorkerNodeEntity 形状不变）。
- 每项改动补中文 JSDoc（设计意图/输入输出/数学逻辑），并说明"为什么旧写法错"。
- 不碰视觉、不碰演示台词（R1 负责），只修数据层与文档数字。

【交付】
1. 数据层改动清单与前后对比曲线（可用 ASCII 或截图：300 tick 的 QPS/CPU 范围）。
2. verify-telemetry.mjs 输出（全绿）。
3. benchmark 重跑输出 + README/白皮书数字更新 diff。
4. 明确列出"哪些指标仍无法自证"（如真机 FPS），以及演示时该怎么讲。
````

### R3 · 进阶优化追问 Prompt

````text
继续深化数据可信度，四项：

追问 1｜属性测试（Property-based，零依赖实现）
不引入 fast-check：自己写一个最小生成器（随机种子 + 场景序列），跑 200 组随机 60-tick 场景，
断言不变量（QPS 有界/CPU 有界/历史长度/健康分公式单调性：新增 P0 告警后健康分必不升）。
失败用例要可复现（打印随机种子与序列）。

追问 2｜数据质量 HUD（把"可信"做成可见功能）
在 `Shift+P` 性能 HUD 中增加"数据健康"区块：QPS 相对基线偏差、节点水位偏离、快照时间戳间隔抖动、SSE 重连次数、免疫改写条数。
要求全部读瞬态轨（glStats/telemetryTransientRef），零 React 重渲染；偏差异常时用 amber 标注。
答辩话术："我们连自己的数据都要监控——这就是可观测性产品的自我要求。"

追问 3｜快照版本与回放
给 TelemetrySnapshot 增加 `schemaVersion`（types 中定义常量），SSE 帧携带；客户端遇到未知版本时降级为只读并提示。
同时保留最近 120 帧环形缓冲（内存约 120×若干 KB），支持"回放最近 2 分钟"用于复盘报告与事故时间线。

追问 4｜跨模式等价性
写一个对照测试：同一 chaos 序列下，demo 引擎与 live 引擎（用宿主桥接 mock）产出的
"故障语义"一致（受害者数量/节点状态/告警级别），仅数值来源不同。
输出对照表，并写进白皮书"数据边界声明"章节——这是评委问"没有真集群是不是造假"时最有力的回答。
````

---

## R4 · 视觉管线与电影级质感（3D）

**目标**：不新增资产、不新增依赖，把 3D 从"好看"拉到"电影级"——先修**渲染管线**（色调映射/AA/降级），再调**灯光与能量预算**，最后做**开场编排与性能保险丝**。
**重要前提**：`kubevision_championship_blueprint.md` 的几何/材质/假辉光方案**基本已全部落地且质量更高**，本轮**禁止重复**做"棱边着色器/假辉光/机架拼装/斜轴相机"。

### R4 · 主 Prompt

````text
你是实时 3D 视觉总监 + WebGL 渲染管线工程师。目标：在不新增依赖、不新增 3D 资产、守住 60FPS 的前提下，
把 KubeVision 的 3D 视口从"不错的科幻场景"提升到"电影级全息运维大屏"。

【已知渲染管线硬伤（按优先级修）】
1) 正常路径没有色调映射：@react-three/postprocessing 的 EffectComposer 在挂载时会把 gl.toneMapping 置为 NoToneMapping，
   而 Composer 只在 heavyRenderEnabled=true 时挂载（ClusterCanvas.tsx:675）→ 正常路径线性直出、高光硬切；
   软渲染兜底路径反而是 R3F 默认 ACES，同一条场景两条渲染路径观感割裂。
2) 后处理无抗锯齿：multisampling={0}（ClusterCanvas.tsx:675），Canvas 的 antialias 对 FBO 无效 → 高 DPI 屏细环/光缆闪烁。
3) 兜底名不副实：heavyRenderEnabled 只关 Composer，MeshReflectorMaterial 反射（每帧全场景重渲）、ContactShadows、阴影仍全开。
4) 灯光 fill 过强（ambient .42 + hemi .55，key:fill≈2:1），体积感被抹平；Master 核心 5 层加色无能量预算，Bloom 在无 TM 线性空间里校准。
5) 3D 状态色（Pod #10b981 / 故障 #ff3b6b）与 UI 语义色（emerald-400 #34d399 / rose-500 #f43f5e）不是同一套色相。

【实施包 L（低成本高收益，必须全做）】
L1 ToneMapping：ClusterCanvas 的 EffectComposer 内加 `<ToneMapping mode={ToneMappingMode.NEUTRAL}/>`，
   onCreated 里 `gl.toneMappingExposure = 1.05`（上限 1.18，按 A/B 截图逐级校）。
   选 NEUTRAL 而不是 ACES/AgX：运维语义色（绿/琥珀/绯红）必须保持色相，ACES 会压灰、AgX 会降饱和。
   顺序必须是 Bloom → ToneMapping → AA → Vignette → Noise。
L2 Bloom 重调：threshold .62→.78、smoothing .24→.14、intensity .55→.72、radius .56→.62、levels 8→6（mipmapBlur 保留）。
L3 双暗角去重：保留 Composer Vignette(offset .22, darkness .28)；CSS 暗角 rgba(2,6,23,.65)→.42，起止 55%→62%。
L4 抗锯齿：Canvas/WebGLRenderer 的 antialias 在 Composer 路径下无效，改为 antialias:false；
   T3 用 multisampling={2}，T2 用 `<FXAA/>`（1 pass，0.2–0.4ms），T1 不加；AA 必须在 ToneMapping 之后。
L5 DPR：初值 Math.min(devicePixelRatio,1.75)，范围下限 0.85；drei PerformanceMonitor 补 ms={200}，onFallback 升级为切 T1 档。
L6 灯光：ambient .42→.18、hemisphere .55→.34、key 1.85→2.30（#eaf4ff）、rim .65→.95、中心 point 36→28；目标 key:fill≈3.4:1。
L7 阴影：shadow-mapSize 1024→2048、正交范围 ±16→±13、normalBias .02、bias -.0005；ContactShadows res 768 / blur 1.6 / opacity .55。
L8 自定义 Shader 雾衰减：GlowHalo3D / ErrorRippleRing / CyberMatrixRain3D / WorkerRack3D 的 beam bloom 等 ShaderMaterial
   末尾乘 `smoothstep(0.75,1.0, depth/uFogFar)`，uFogFar=64，与现有线性雾远端一致；或接 three 的 fog chunk（material.fog=true）。
L9 3D 铭牌改固定像素字号：去掉 drei `<Html distanceFactor>`（不传即 scale=1，恒定像素）；机架名 9.5→12px、徽标/计数 7→10px、
   Master 正文 11px、Pod hover 名称 10→11px、状态 8→10px。收益 0 成本。
L10 微排版：全仓 <10px 字号归零（7px×3 / 8px×6 / 9px×71 → 10px）；text-slate-600（2.66:1，72 处）与 slate-700（10 处）→ slate-500（4.24:1）；
   正文 ≥ slate-400（7.87:1）；slate-500 只允许出现在 ≥11px 的等宽次级标签。
L11 色彩 token 收口：新增 src/constants/palette.ts 作为单一事实源（hex + THREE.Color + emitter 倍率 + CSS 变量名）；
   ViewportToolbar 的 fuchsia-500 巡逻按钮改为 cyan-400 激活填充（若要区分"巡检中"用 amber-400 描边+呼吸）；3D 状态色统一到 UI 色相。
L12 构图：只改 OVERVIEW_LOOK_AT（cameraFocus.ts）从 [0,2.5,0] → [0,1.20,0]，相机 [7.8,14,22]、fov 40 不动。
   预期：前排机架底边 1034→~984 完整入画、Master 从 50% 上移到 44%、右余量 51px。不要改 fov/相机位（会破坏 verify.mjs:638 的断言）。
L13 开场编排 uBoot：模块级 `uBoot={value:0}`，一个 useFrame 里 `uBoot += delta/1.2` 并 smoothstep；
   地面环/矩阵雨/光导柱 emissive/铭牌 opacity/机架晶核 scale 全部乘 boot。0 新增 draw call、0 新增显存。
L14 兜底拆分：把 heavyRenderEnabled 拆成 postEnabled 与 reflectorEnabled 两个开关；软渲染路径两者都关、DPR 降到 1.0、shadows='basic'；
   软渲染判定追加 WebGL2 + EXT_color_buffer_half_float 能力检查（three r169 只创建 WebGL2 上下文）。

【实施包 M（1–3 天，按剩余时间取舍）】
M1 质量治理器：新增 src/store/useQualityStore.ts（非持久化）+ src/hooks/useQualityGovernor.ts。
   输入 telemetryTransientRef.glStats.fps（GlStatsCollector 已 2Hz 写入）；2s 窗口 fps<50 连续 2 次降一档、>58 连续 6s 升一档（30s 冷却）；
   降档顺序：DPR−0.25 → Bloom levels 6→4/intensity−0.1 → 反射 256→关 → 阴影 off → 后处理全关（T0）；
   演示模式禁止自动升档；手动覆盖 `?quality=high|low` + Shift+P 三档按钮。禁止在 useFrame 里 setState（读瞬态轨）。
M2 反射降级：T2/T3 保留 MeshReflectorMaterial 但 resolution 固定 256、blur [180,56]、mixStrength 15→9、mirror .55→.45、roughness .62→.68；
   T1/T0 卸载反射 mesh，改 1DC 自写 shader 哑光圆盘（径向渐变+噪声+中心暗斑，additive 微光），接触阴影继续承担"咬地"。
M3 Draw call 合并：三座相同机架的静态装饰（立柱/百叶/铆钉/倒角/导光柱/缝隙 AO）改为跨机架共享 InstancedMesh，
   预计 −90~−120 DC（396→≤300）；可拾取装甲壳保持独立 mesh（交互语义不能并）。
M4 发光能量预算：晶核中心（屏幕半径 120px）加色层 alpha 总和 ≤1.15；路面主轨内侧 ≤0.55；外围 ≤0.40；机架顶冠 ≤0.45。
   具体：GlowHalo opacity .62→.42、flare 峰值 .85→.62、godray ×0.8、量子点 ×0.75、雷达扇区 .26→.20、星城亮度 ×0.85、BEAM_BLOOM ×0.8。
M5 统一动效节拍：全局 MOTION_BEAT=3.6s；晶核呼吸 3.6/1、陀螺环 3.6/4·3.6/3·3.6/2、赤道/极环 3.6/5·3.6/2、雷达扫掠 3.6/1；
   故障涟漪 1.2s/环（错相 0.4s，允许打破节拍）；雨幕速度不动。
M6 玻璃降本：新增 .kv-chip（blur 8px，无大投影）用于终端条/工具条/图例胶囊；.kv-panel（blur 20px）只留给顶栏/抽屉/模态；
   27 处 blur 收敛为 2 个 token，预计省 1.5–3ms。
M8 首屏联动：demo 阶段 1 改为开场运镜（相机 [10.6,17.2,26.5] → overview，k=3.2，uBoot 0→1 同步）；
   `prefers-reduced-motion: reduce` 时 uBoot=1、循环动画幅度 ×1/4、运镜取消。

【禁止项（硬红线）】
- 禁止 multisampling=8（8×MSAA HDR RT >200MB，集显必炸）。
- 禁止新增 fuchsia/紫色等新色相（状态色体系只有 emerald/amber/rose/cyan 四类）。
- 禁止双重发光（组件内加色层 + Bloom 同时堆叠到同一区域，必须先过 M4 预算表）。
- 禁止改雾参数（15,64）而不回归 verify；禁止改相机位/fov 而不评估 verify.mjs:638 断言。
- 禁止在 useFrame 内 new THREE.* / setState；所有临时向量 useMemo 预分配。
- 禁止引入新的后处理资产（LUT 贴图等）或 .glb 模型；"零外部 3D 资产"是卖点。
- AGENTS.md 第 5/7 条（配色、toneMapped）只做"扩展 token"，不得删除既有契约；需要调整先在文档说明。

【验收】
1. 三组 A/B 截图（1920×1080 全屏、同一帧）：overview / 选中 Pod 特写 / POD_OOM_SWARM 故障态；对比 ToneMapping 与 Bloom 调整前后。
2. `Shift+P` 性能 HUD：draw calls（合并后应下降）、帧时间、DPR 与档位；软件渲染路径必须明显降载（反射/Shadow/Composer 均关）。
3. 视觉一致性：3D 中 Pod 正常态取色与 UI emerald-400 对比 ΔE 不可肉眼可辨；故障态同 rose-500。
4. `npx tsc` + `node scripts/verify.mjs` 全绿；`verify.mjs` 中相机断言不得因构图修改而假通过（如改 z 必须同步改基准）。
5. 写 docs/visual-upgrade.md：参数表、A/B 截图、性能数据、已知未做项（如 DOF/N8AO 仅在 T3 可选）。
````

### R4 · 进阶优化追问 Prompt

````text
继续视觉深化，四项（仍禁止新增依赖）：

追问 1｜真机性能标定
在至少 2 台机器（独显 + 集显）上跑 benchmark/HUD，记录 T3/T2/T1/T0 四档的 fps、frameTime、draw calls、显存估算；
输出 docs/quality-matrix.md。若独显达不到 60FPS，按"先降反射→再降阴影→再降 Bloom"的顺序定位，禁止用"改小场景"糊弄。

追问 2｜渲染路径一致性
证明"有 Composer"与"无 Composer（兜底）"两条路径的观感差异可接受：各截同一帧，量化平均亮度/对比度/色相偏移；
若差异过大，给兜底路径加一个轻量 ToneMapping shader（单 pass）而不是放弃色彩管理。

追问 3｜能量审计
把 M4 的预算做成可断言的常量表（如 src/constants/glowBudget.ts），写一个开发期脚本扫描各材质 opacity/emitter 配置，超预算即 console.warn；
在页面上加 `?glowDebug=1` 调试模式，显示各区域加色总和（可用 HTML overlay，不进主循环）。

追问 4｜"3 秒第一印象"成片
按开场分镜（uBoot 0→1.2s、相机推镜 0→2.4s、HUD 分段入场 1.2–2.8s、首屏信息密度 3D≥92%）
录一条 5s 的无操作开场视频；与当前实现的第 1 帧做对比，确认"打开就有东西在发生"。
写一份 3 帧截图对照（0s / 1.5s / 3s）作为 R8 录屏素材。
````

---

## R5 · UI 设计系统与信息层级（2D）

**目标**：让 HUD/抽屉/弹窗看起来像"一套产品"而不是"一堆组件"：字号阶梯、对比度、玻璃层级、动效节拍、信息密度一致；同时把 27 处 `backdrop-blur` 的合成成本降下来。

### R5 · 主 Prompt

````text
你是资深产品设计系统工程师（Linear/Vercel 风格），负责把 KubeVision 的 2D 界面统一到一套可落地的设计系统。
现状：3D 已相当精致，但 2D 存在"字号塌陷、灰阶过低、玻璃层级混乱、动效各自为政"的问题，评审在高 DPI 屏/投影上会直接感到"廉价"。

【已确认的问题（必须修）】
1) 全仓 <10px 字号 80 处（7px×3 / 8px×6 / 9px×71），分布在 Copilot、LocalAuditorPanel、PerfTelemetryHUD、GenUI 卡片、3D 铭牌。
   在 1920×1080 投影/2K 125% 缩放下中文会糊、等宽数字会粘连。
2) 低对比灰：text-slate-600（2.66:1）72 处、slate-700（1.95:1）10 处，违反 WCAG AA（正文 4.5:1）。
3) 玻璃层级混乱：.kv-panel（blur 20px）与临时写死的 backdrop-blur-md / blur-xl 混用，全仓 27 处 blur；
   小浮层（终端条/工具条/图例）也用了重玻璃，合成开销高且边缘不统一。
4) 动效各自为政：抽屉/卡片/弹窗的 enter/exit 时长与曲线不一致；部分层级缺少 AnimatePresence 导致 exit 失效（已修的部分不要回退）。
5) 响应式：小屏底部悬浮视图切换器遮挡 TerminalEcho 与快捷指令芯片；抽屉宽度拖拽在窄屏下的最小值未约束。
6) 可访问性：图标按钮缺少 aria-label 的不在少数；键盘焦点环在深色玻璃上不可见。

【任务】
A. 建立设计令牌（单一事实源）
   - 新增 src/constants/tokens.ts（或按现有结构扩展 tailwind.config.ts + globals.css），至少覆盖：
     颜色（void/panel/border/text-primary/secondary/tertiary/muted + 四语义色 + 各自对比度注释）、
     字号 7 级（Micro 10 / Caption 11 / Body 12 / BodyLg 13 / Title 14 / H2 18 / H1 24，单位 px，禁止 <10px）、
     间距 4px 栅格、圆角（4/6/8/12）、描边（hairline 0.075 白 / active 0.14 白）、
     动效（fast 140ms / base 200ms / slow 320ms + spring {stiffness:420,damping:34}）、
     玻璃三层（panel 20px / chip 8px / overlay 30px）。
   - 用 CSS 变量输出（便于非 Tailwind 上下文，如 drei <Html> 与 3D 铭牌引用）；Tailwind 只做语义扩展，不改变 AGENTS.md 第 5 条已定义的状态色。
B. 微排版迁移（机械但必须彻底）
   - 7/8/9px → 10px（全部）；卡片正文 9px → 12px；证据链/日志正文 → 12px 且 leading-relaxed；
     面板标题 14px、核心 KPI 18–24px；等宽数字加 tabular-nums。
   - slate-600/700 → slate-500；正文统一 slate-300/400；slate-500 仅用于 ≥11px 次级标签。
   - 遍历全仓（含 GenUI 四卡、MarkdownLite、Copilot、LocalAuditorPanel、PerfTelemetryHUD、TopBar、TerminalEcho、CommandPalette、三个 Modal）。
   - 验收：`grep -rn "text-\[[0-9]px\]" src` 中不存在 <10px；`grep -rn "text-slate-600\|text-slate-700" src` 为 0（或仅剩有意保留的装饰位）。
C. 玻璃与描边统一
   - 新增 .kv-chip（blur 8px、无大投影）用于终端条/工具条/图例胶囊/筛选横幅；.kv-panel 只用于顶栏/抽屉/模态；
   - 统一边框为 `border-white/[0.07]` + `inset 0 1px 0 rgba(255,255,255,0.08)`；删除各组件里手写的 slate-800 实线边框；
   - 目标：全仓 backdrop-blur 处数 ≤ 12，且全部来自两个 token。
D. 动效统一
   - 建立 MOTION token 并在 framer-motion 中复用；所有折叠/展开使用 height:auto + opacity 的 spring；
   - 确保所有条件渲染的弹层外层都有 AnimatePresence（已有修复不回退）；
   - `prefers-reduced-motion: reduce` 时禁用非必要动画（保留状态变化）。
E. 响应式与遮挡
   - 小屏：为 <main> 增加底部安全留白（pb-14 lg:pb-3），确保移动视图切换器不遮挡 TerminalEcho 与快捷指令；
   - 抽屉拖拽最小宽度限制在 360px（小屏 320px），并保存用户偏好（localStorage）；
   - 1080p 100% 缩放下关键数字（QPS/健康分/评分）可读性检查：截 1920×1080 与 1366×768 两种图。
F. 可访问性
   - 所有图标按钮补 aria-label；焦点环用 `focus-visible:ring-1 ring-cyan-400/60 outline-none`；
   - 弹窗焦点陷阱（首次打开聚焦、Esc 关闭、关闭后焦点回到触发按钮）；对比度达标（正文 ≥4.5:1，大字 ≥3:1）。
G. 验收与文档
   - 新增 `docs/design-system.md`：token 表（含对比度数值）、字号阶梯、玻璃三层规范、动效时长表、组件使用示例；
   - 新增 `scripts/check-a11y.mjs`（纯静态/正则最小版）：扫描 `text-[<10px]`、缺 aria-label 的 icon-only button、`text-slate-600/700`，CI 可跑；
   - 三张截图：1920 全屏 / 1366×768 / 选中 Pod 的探针卡展开态。

【约束】
- 不改变信息架构与文案（文案纠错在 R8 统一做）；不改 3D 场景（R4 负责）；不引入 UI 库/图标库。
- 所有组件改动遵循现有 TypeScript 契约与 cn() 工具；禁止内联 style 与 Tailwind 任意值混用（除必须的 px 精度）。
- 不改 verify.mjs 依赖的 aria-label 与关键文案（如"性能遥测 HUD""AI 思考与规划过程"等），如需改必须先同步脚本。

【交付】
1. token 文件 + 改动文件清单（按组件分组）。
2. 迁移统计：<10px 从 80 → 0；低对比灰从 82 → 0（或保留清单）；backdrop-blur 从 27 → ≤12。
3. 三张截图 + check-a11y.mjs 输出。
4. 设计系统文档 + 未迁移项与原因。
````

### R5 · 进阶优化追问 Prompt

````text
继续 UI 深化，四项：

追问 1｜信息密度分级（"评委模式"）
为窄屏/投影场景新增"演示模式"视图预设：隐藏终端、收起性能 HUD、抽屉宽度 38%→34%、HUD 只保留健康分/告警/QPS，
其余信息通过 Cmd+K 可达。用 URL `?present=1` 或顶栏一个"演示"开关触发，并写入 docs（现场使用）。
要求：切换不重建 3D 画布（Canvas 常驻 DOM），切换动画 ≤240ms。

追问 2｜首屏加载体验（骨架 → 内容无缝）
把 CanvasSkeleton/DrawerSkeleton 的扫描线与 uBoot 状态统一：3D 首帧出现时骨架不做"闪断"（交叉淡入 200ms）；
端侧模型加载进度、Copilot chunk 加载进度、SSE 连接状态三者合并成一个"系统启动状态"胶囊（可折叠），
避免首屏出现 3 个互不相关的 loading 文案。

追问 3｜键盘可达性升级
在现有 Cmd+K / Esc 栈 / ↑↓ 的基础上补：`1/2` 切换抽屉页签、`F` 聚焦搜索、`Space` 暂停/恢复自动路演、
`?` 打开快捷键帮助浮层（可关闭、记忆偏好）；全部写进 aria-keyshortcuts 与 docs/design-system.md。

追问 4｜视觉回归基线
用 CDP 截 6 张关键界面图（首屏、选中 Pod、OOM 故障态、AI 三卡、RAG 弹窗、复盘报告），存 docs/visual-baseline/，
写一个 `scripts/visual-diff.mjs`（纯像素差异阈值，不引入新依赖，可用 canvas 或 PNG 解析手写最小实现）；
之后任何视觉改动先跑 diff，超过阈值（如 1.5% 像素差）必须人工确认——防止"改一个组件崩另一处"。
````

---

## R6 · AI 技术深度"名实相符"

**目标**：把 5 处"叙事与代码事实的错位"补成真本事（这是 AI 技术深度 35% 的主战场），且**全部零新增依赖**：实测可观测层 → MCP 规范化 → 检索评测 → 真 embedding 召回 →（可选）多步 tool calling / grounding / 端侧视觉。

### R6 · 主 Prompt

````text
你是 AI Agent 架构师 + RAG 工程师。KubeVision 的 AI 能力"真实现比例"高于竞赛平均，但存在 5 处会被评委一击即破的错位。
本轮的硬要求是"名实相符"：要么把宣称补成真的，要么把文案改成诚实的边界。禁止新增依赖（AGENTS.md 依赖世代锁）。

【已知错位（逐条处理）】
E1 四阶段 ReAct 的耗时是编排常量（chat/route.ts:77-83 SIM_LATENCY），评委问"38ms 是实测吗"即穿帮；
E2 "混合 RAG 的稠密路"实际是 TF-IDF 词袋、RRF 只融合两路、无 Recall@K 评测；
E3 MCP 只有执行端点，无 initialize / tools/list / tools/call、JSON-RPC id 不回显 → 标准客户端连不上；
E4 无 API Key 时引擎 B 不读截图，却在正文写"空间观察"；
E5 断网时 384 维模型实际走内置分类器（UI 有诚实标注，但文档未写清）。

【任务（按优先级 A→D 必做，E/F 选做）】

任务 A · 实测可观测层（1.5–2 人日，先做这个）
  1) 新增 src/utils/agentTrace.ts（服务端纯函数，仅用 Node/Web 标准 API，不引 OTel）：
     createTrace() → {traceId, spans[]}; startSpan(name) 记录 performance.now()，endSpan 记录 durationMs/status/attrs。
  2) chat/route.ts 打点：intent-route、rag-retrieve、prompt-build、llm-first-token、llm-total、tool-call:<name>、fallback。
     新增 NDJSON 事件：
       {type:'span'; traceId; name; startMs; durationMs; status:'ok'|'error'; attrs?}
       {type:'trace-summary'; traceId; engine:'llm'|'simulator'; ttftMs; totalMs; promptTokens?; completionTokens?; costCny?}
  3) 引擎 A：流结束后读取 AI SDK 的 usage（ai@3.4.33 的 streamText 结果对象有 usage Promise），token×单价（env 配置，未配置则显示"未配置"）→ costCny。
     引擎 B：ttft/total 由服务端真实打字机计时；仍标 engine:'simulator'，绝不冒充 LLM。
  4) types/ai.ts 扩展 ChatStreamEvent 与 AgentReasoningStep sim 标记；AgentThoughtChain 展示实测值（编排值仅在引擎 B 的"编排相位"标签下保留）。
  5) 新增 AgentTracePanel（next/dynamic 懒加载）：span 瀑布图 + token/成本 + TTFT；只在抽屉内展开时渲染，4Hz 更新不触发 3D 重渲染。
  6) 验收：引擎 A 的 rag-retrieve 实测耗时与 benchmark.mjs 同量级；断网时 trace 仍有 span；verify-stream-integrity 增加"trace-summary 必达且 engine 与实际一致"断言。

任务 B · MCP 规范兼容（1–1.5 人日）
  1) 抽出 src/utils/mcpExecutor.ts：把真实集群执行、kubectl 回执、sha256 审计摘要、id 生成、env 配置读取、参数白名单迁入（纯服务端模块），
     /api/mcp/execute 与新 /api/mcp 共用，禁止逻辑双写。
  2) 新增 src/app/api/mcp/route.ts（JSON-RPC 2.0 over HTTP）：
     - initialize → {protocolVersion:'2024-11-05', capabilities:{tools:{listChanged:false}}, serverInfo:{name:'kubevision-mcp',version:'1.0.0'}}
     - tools/list → 3 个执行工具（restart_pod / scale_deployment / drain_node），inputSchema 用 JSON Schema 字面量（手写最小子集，不引 zod-to-json-schema）
     - tools/call → 复用 executor → {content:[{type:'text',text: JSON.stringify(receipt)}], isError:false}
     - ping → {}
     - 严格回显 id；错误码 -32700/-32600/-32601/-32602/-32603；通知（无 id）返回 202。
  3) 保留 /api/mcp/execute 不动（verify.mjs 有断言），文档标注 legacy。
  4) 文档写清"渲染类工具不进 MCP，它们是 UI 契约不是外部工具"——这个分层是加分项。
  5) 验收：curl 三个方法返回标准结构；tools/call 无集群配置时返回 mode:'simulated' 且 auditDigest 可复算。

任务 C · 检索评估集与指标（1 人日）
  1) 新增 src/utils/ragEvalSet.ts：30–40 条标注集，覆盖 12 篇手册 × 2–3 种改写（中文口语/英文术语/混合）+ 8 条负例（寒暄/无关/跨域）+ 5 条多文档相关（分级 2/1/0）。
     interface RagEvalCase { id; query; chaos; relevant: {docId; grade:0|1|2}[]; note? }
  2) 新增 scripts/eval-rag.mjs：调 /api/verify/rag 的 eval 模式（或直接 import 检索引擎，避免起服务），计算 Recall@1/@3、MRR@5、NDCG@5、负例拒答率、延迟 P50/P95；
     输出 docs/rag-eval.md（表格 + 消融：bm25-only / vector-only / 双路 RRF / 加 embedding 后）。
  3) 纪律：数字必须脚本生成、跑两遍一致；未达标就改算法或改文案，禁止手填。
  4) 修正 RAG 校准系数（见 R2 C6）后重跑评测，前后对比入表。

任务 D · 真实 embedding 第三路召回（2–3 人日）
  1) Worker 协议扩展 {type:'embed', texts} → {type:'embed-result', vectors:Float32Array[]}；复用已初始化的 feature-extraction 管道；模型未就绪返回 null，300ms 超时不阻塞。
  2) 新增 scripts/build-runbook-embeddings.mjs（开发期一次性）：Node 侧用已安装的 @huggingface/transformers 编码 12 篇手册 → 写 src/utils/runbookEmbeddings.ts（12×384 float ≈18KB 随包提交；运行时不加载模型）。
  3) 服务端 retrieveSreRunbooks 增加可选 queryEmbedding：校验 384 维 + L2 归一化 + NaN 过滤；有则加第三路排名，RRF 融合 3 路；无则回退现有两路。
  4) 展示：vectorScore 更名 lexicalCosine（保留兼容字段）；ragSignals 增加第四路 embedding（标签"句向量 MiniLM"），模型未就绪则 available:false，绝不填 0 冒充。
  5) 验收：eval 表出现"三路 vs 两路"的增益；断网时降级为两路且 UI 明确标注。

任务 E（选做）· 真实多步 tool calling（2–3 人日）
  - 新增只读数据工具：getPodMetrics / searchRunbooks / getRecentEvents（真 execute，返回观测值）；
  - 渲染类 render* 工具保持"下发卡片"语义，execute 返回 rendered 回执；
  - streamText 增加 maxSteps:3 + onStepFinish，把真实 toolResults 作为 reasoning step 下发；schema 失败时把 zod 错误作为 observation 回灌让模型自修一次；
  - 安全：写操作工具永不可由模型直接执行（执行仍走 HITL 卡片），"可读可观测、不可写"写进提示词与白名单。

任务 F（选做）· RAG grounding 与引用核验（1–2 人日）
  - 生成正文后做"引用核验"：正文里出现的 Pod 名/ID/数字必须能在本次工具观测或 RAG 命中里找到出处；找不到则降级为"未证实"或移除该断言；
  - 置信度钳制：证据不足时不得输出高置信动作卡；输出一张"证据链 → 结论"的映射 JSON，前端可展开。

【通用约束】
- 引擎 B 的所有"仿真"必须诚实标注；文档与 UI 的边界描述必须一致（"编排相位" vs "实测耗时"）。
- 不破坏离线优先：所有新增能力在无网络/无 Key 时必须有降级路径，且降级后核心演示仍完整。
- 流式协议新增事件必须向后兼容（未知 type 前端忽略）；verify-stream-integrity 必须继续全绿。
- 不新增依赖；transformers 只在 Worker/开发脚本中使用，服务端不加载 onnx。

【交付】
1. "错位 → 修复方式 → 新证据"映射表（每条附文件:行号与验证命令输出）。
2. trace-summary 实际样例（引擎 A/引擎 B 各一条）。
3. tools/list 的 curl 输出 + tools/call 回执。
4. docs/rag-eval.md（before/after 两版）。
5. 诚实边界清单：哪些能力仍是"演示/编排"（不许包装成"已实现"）。
````

### R6 · 进阶优化追问 Prompt

````text
继续 AI 深度深化（选做项，按剩余时间取舍）：

追问 1｜端侧像素特征（让"无 Key 也能真看图"）
不依赖云端多模态：在截图发送前，于客户端计算 3D 视口的"空间异常特征"——按屏幕分块统计青/绿/琥珀/绯红占比、红色区域质心、
连通块数量、与机架投影区域的交叠度；把特征向量与 RS 字典一起发给服务端，引擎 B 据此生成"我在画面里看到 3 个红色热区，集中在右前机架"一类真实观察。
验收：无 Key、断网时"空间观察"与画面一致（构造 3 种故障态各录一条）；有 Key 时仍优先云端多模态。

追问 2｜语音全链路（可打断的对话）
- 播报中说话即打断（VAD/能量阈值），打断后进入拾音；拾音结束自动发送；发送后立即播报首句（流式 TTS 分句）；
- HITL 语音确认："确认重启"才允许高危操作（与复选框同等语义，但需显式二次确认）；
- 全部能力检测降级，失败静默回退键盘。

追问 3｜端侧模型离线化
把 Xenova/all-MiniLM-L6-v2 权重随包（public/models/，ONNX + tokenizer + config），Worker 优先本地路径、失败再 CDN；
记录冷启动/热推理延迟；文档更新"公开模型引用声明"。验收：断网首次打开也能完成 384 维分类与查询编码。

追问 4｜AI 价值度量（把"智能"变成可量化）
建一个内部评测脚本：20 条典型运维问句，统计"结论正确性（人工标注）/引用命中率/动作卡合理性/平均时延"；
与"不用 RAG 的裸模型"做对照（引擎 A 可切换），输出 docs/ai-quality.md。
答辩一句："我们的 AI 不是凭感觉好，是在 20 条真实问句上做过对照评测。"
````

---

## R7 · 冗余 / 死代码 / 旧代码清理与工程防腐

**目标**：在不动功能的前提下，删掉 ≈322 行零引用代码 + ≈750 行文档/配置冗余，并建立"防再生"机制；同时把工程配置（pnpm/ESLint/vercel/依赖清单）修到"评委一看就专业"。

### R7 · 主 Prompt

````text
你是代码资产治理工程师。请对 KubeVision 做一次"外科手术式"清理：只删不用的、合并重复的、修正过期的，不引入任何行为变化。
基线：master @ 14732fd，工作树干净。先 `git checkout -b chore/dead-code-cleanup`，分三批 commit。

【批 1 · 零风险删除（A 类，已证零引用，≈322 行源码 + 3 个本地产物）】
逐项删除前必须自己再 grep 一次引用，确认 0 引用后再删：
1. HoloLeaderLine（src/components/canvas/HoloHud.tsx:276-354，79 行）
2. useAdaptiveQualityFactor（src/hooks/useInViewPause.ts:127-159，33 行）
3. useHasHydratedClusterStore（src/store/useClusterStore.ts:1017-1054，38 行）
4. BootstrapChecklistItem（src/types/cluster.ts:66-85，20 行，含"第1轮遗留"失效分节）
5. ChaosScenarioOption + PerfHudSample（src/types/layout.ts:237-245,275-292，27 行）
6. sanitizeBatch + hasSensitiveData（src/utils/logSanitizer.ts:248-293，45 行）
7. getRunbookById（src/utils/sreRagEngine.ts:1390-1401，12 行）
8. createEngineState（src/utils/syntheticEngine.ts:836-855，20 行）
9. DEFAULT_DRAWER_PCT（src/components/layout/SplitPaneResizer.tsx:461，1 行）
10. 死 CSS：globals.css 中 .kv-status-dot 族（:136-154）、.text-glow-*（:181-193）、.kv-html-label（:195-199）——TSX 引用为 0；
    同时删除 tailwind.config.ts 中未使用的 bg-radial-fade / grid-pan 令牌（如确认 0 引用）。
11. 删除根目录 3 个 tsconfig*.tsbuildinfo（1.27MB，已 .gitignore 且对应 tsconfig 已不存在）。
12. 可选：清掉"仅本文件使用"的多余 export 关键字（附录 A 56 处），零逻辑改动。
批次验收：`npx tsc -p tsconfig.json --noEmit --incremental false`、`npx next lint`、`node scripts/verify.mjs --quick` 全绿；
并输出"删除符号 → 引用计数 0 的证据"表。

【批 2 · 需确认项（逐项决策并留记录，不要一刀切）】
B1. ShellLayout 的 ViewportPlaceholder/DrawerPlaceholder/RightDrawerSlot（≈107 行）：page.tsx 始终传槽位，回退链路不可达。
    二选一：删除（更简单）或补"槽位为空的合法场景"并写测试；在 docs/3d-memory-audit.md 或提交信息里记录决策理由。
B2. useOptionalGltfModel（141 行）+ WorkerRack3D 挂载槽 + public/models 规范（106 行）：默认因 NEXT_PUBLIC_ENABLE_GLTF_MODELS 未文档化而短路。
    二选一：删除整条休眠管线（推荐，卖点是"零外部 3D 资产"）并同步删除 public/models/README_BLENDER_SPEC.md；或保留但写入 .env.example 与文档。
B3. computeClusterHealthScore 双份实现（store 私版 38 行 vs syntheticEngine 导出）：收敛到 src/utils/clusterHealth.ts 纯函数，两处 import；补单测（P0 告警必不升分）。
B4. 时间戳格式 3 份实现：收敛到 src/utils/time.ts（formatClock / formatDateTime），替换全仓。
B5. McpExecuteReceipt 类型双份（route 与 ActionConfirm）：收敛到 src/types/ai.ts 或 src/types/mcp.ts（新增），两边 import。
B6. `.cursorrules` 与 AGENTS.md 重复且过期：删除 .cursorrules 或改为一行指针"以 AGENTS.md 为准"；根目录 2 份未入库旧报告/蓝图（602 行）被代码 21 处引用（悬空）：
    统一移到 docs/archive/ 并在引用处更新路径（注意：引用是注释路径，不影响编译），或直接删除悬空引用注释。
B7. 38 个冗余 'use client'（page.tsx 是唯一真边界）：只在"确实需要客户端边界"的组件保留，其余删除——本项低收益，可放到最后。
批次验收：完整 build（仅在本地临时副本或 CI 跑，避免污染工作树产物）+ `node scripts/verify.mjs` 全绿。

【批 3 · 配置与防腐（防止再次腐化）】
C1. pnpm 配置：当前 .npmrc 的 peer/hoist 设置在 pnpm 11 下可能失效，迁移到 pnpm-workspace.yaml；package.json 增加 `"packageManager": "pnpm@11.8.0"`。
C2. ESLint：启用 `@typescript-eslint/no-explicit-any: error`（当前未启用，导致"零 any"靠自觉）；把 next lint 纳入 verify。
C3. vercel.json：删除与 route.ts 重复的 headers 配置，只保留 regions/maxDuration；确认 SSE 的 no-transform 不被 CDN 覆盖（在 README 部署章节注明）。
C4. .gitignore：确认 *.tsbuildinfo、.next、node_modules、docs/evidence/ 大文件规则齐全。
C5. scripts：`build-whitepaper-pdf.mjs` 未在 package.json 登记，补 `docs:pdf` 脚本；新增 `verify:demo`（R1 产物）与 `verify:telemetry`（R3 产物）入口。
C6. 文档防腐：
    - 新增 `docs/CONTRIBUTING.md`：数据指标必须由脚本生成、禁止手填；改动 3D/视觉必须附 A/B 截图；提交信息模板。
    - 新增 `scripts/sync-docs-metrics.mjs`（R3 交付）并在 README 用 `<!-- METRICS:BEGIN -->` 区块承载自动生成数字。
    - README 死链 `src/hooks/useSpeechRecognition.ts` 修正为 `useSpeechInput.ts`；补充 `/api/logs/live`、`/api/mcp/execute` 到目录树。
C7. LICENSE + THIRD_PARTY_NOTICES.md：新增 MIT（或"仅限竞赛评审使用"）与第三方依赖/模型（Xenova/all-MiniLM-L6-v2、three、R3F、AI SDK 等）声明。

【约束】
- 纯清理，禁止顺手重构业务逻辑、禁止改 UI/文案；每批 commit 必须可独立回滚。
- 删除任何文件/符号前，必须在提交信息里写"引用计数 0 的检索命令与输出"。
- 不删除 docs/ 下的竞赛材料（白皮书、performance）；只处理过期/重复内容并归档。
- 不引入新依赖（ESLint 插件如已在 eslint-config-next 内可使用，否则不装）。

【交付】
1. 三个 commit 的 diff 统计（+/− 行、文件数）。
2. "删除项 → 证据 → 验证"表；净删行数。
3. 配置改动清单与理由。
4. docs/CONTRIBUTING.md、LICENSE、THIRD_PARTY_NOTICES.md。
5. 回归输出（tsc/lint/verify/quick）。
````

### R7 · 进阶优化追问 Prompt

````text
继续工程防腐，三项：

追问 1｜架构分层校验脚本
写 scripts/check-layering.mjs（静态扫描 import 路径）：
- src/utils/** 不得 import src/components/**（现有 demoDirector 反向依赖 store 是允许的，但要有白名单并注释）；
- src/components/canvas/** 不得 import src/components/ai/**；
- src/app/api/** 不得 import React/DOM-only 模块；
- 任何文件不得 import 'use client' 组件到服务端文件。
白名单集中在一处（脚本内常量），CI 或 verify 里跑；发现新违规直接 fail。

追问 2｜死代码防再生
写 scripts/check-dead-exports.mjs：扫描所有 export，统计仓内引用数，输出"疑似死代码"清单（白名单可维护）。
要求：只在"新增死代码"时 fail（与基线对比），避免历史遗留阻塞；基线文件 docs/dead-exports-baseline.json 一并提交。

追问 3｜依赖与体积治理
- 检查 package.json 中是否有未使用依赖（如某包只在旧代码中出现），生成报告 docs/deps-audit.md；
- 记录首屏 bundle 体积（next build 输出）并写入 README"工程质量"章节；
- 给出"体积预算"：首屏 JS、3D chunk、AI chunk 各多少 KB，超过则告警（脚本读取 .next/ 产物）。不新增依赖。
````

---

## R8 · 演示叙事与现场作战

**目标**：把"作品"翻译成"评委 3 分钟能看懂、能记住、能复述"的演示；所有动作必须**以真实 UI 文案为准**；把自动路演作为兜底而非主路径；形成可彩排的脚本 + 风险预案 + 追问应答。

### R8 · 主 Prompt

````text
你是竞赛答辩导演 + 资深 SRE 布道者。请基于 KubeVision 的真实 UI 与代码行为，产出一套"现场零翻车"的演示体系。
所有台词与动作必须以真实界面文案为准（下方已给出纠错表），禁止沿用旧 README 里不存在的按钮名。

【真实 UI 文案纠错（写脚本必须用这一列）】
| 旧材料写的 | 真实 UI |
|---|---|
| 「混沌故障演练」 | 顶栏 **「故障演练」**（激活后原地变 `● 演练中：场景名 | ×`） |
| "选择 POD_OOM_SWARM → 注入" | 弹窗内**直接点场景卡片即注入**（无独立注入按钮） |
| 「确认并执行自愈」 | 卡片内**先勾选**"我已知晓该操作将影响生产环境…" → 再点 **「立即执行自愈方案」**（不勾选按钮恒灰，最容易翻车） |
| 「端侧隐私日志审计」 | 页签 **「端侧日志审计」**（副标题 Edge Log Auditor (WASM)） |
| "右下角点击「快照诊断」" | **3D 视口工具条**内的相机图标（aria="3D 视口多模态快照诊断"） |
| 「RAG 知识库 12+」 | **「RAG 知识库」**（打开 SRE 领域知识库） |
| 未记载 | 顶栏 **「剧本路演」**（一键全自动演示，OOM 34s / CNI 32s，字幕条 + TTS） |
| 未记载 | Shift+P 性能 HUD；Ctrl/Cmd+K 命令面板；Esc 分级退出 |

【任务 1｜3 分钟 canonical 分镜（唯一版，供提交视频与现场共用）】
按如下骨架细化到"秒 + 点击坐标 + 预期画面 + 讲解词（口语化，标注字数）+ 这一步证明什么"：
0:00–0:10 首屏静止（三机架/中央晶核/地面星环/星尘流），开场钩子三选一：
         A "K8s 排障最难的不是没有数据——是数据都在，但没人知道先看哪一块。"
         B "接下来 3 分钟，我在 5 个容器里制造一次真实 OOM，然后让 AI 用 3 次点击修好它。"
         C "12 篇 SRE 手册、11 毫秒检索、0 个 any、0 个外部 3D 模型文件——这就是 KubeVision。"
0:10–0:30 点 worker-beta 机架上的 Pod → 相机飞跃 + 探针卡（讲"空间=索引，单一坐标真相源 spatialLayout.ts"）
0:30–0:45 Ctrl+K → 输入 beta → Enter（讲"键盘是一等公民"）
0:45–1:00 顶栏「故障演练」→ 点 POD_OOM_SWARM 卡片（点卡片即注入；讲"故障是空间里的红色脉冲"）
1:00–1:30 视口工具条「快照诊断」→ 思考链四阶段 + 三卡水合（讲"多模态输入 + 可解释链路"）
1:30–1:45 ActionConfirm：勾选复选框 → 「立即执行自愈方案」→ 600ms 流光 + Pod 转绿 + [MCP Verification] + 终端审计行（讲 HITL）
1:45–2:05 「RAG 知识库」→ 输入"容器内存爆了 exit 137" → Top-3 三路得分 + 命中词胶囊（讲"可解释检索 + 零命中拒答"）
2:05–2:25 「端侧日志审计」→ 预设"数据库连接串泄露" → 「抓取并审计」（讲"原始凭证零出域 + 三级降级链"）
2:25–2:40 「复盘报告」→ 8 章报告（讲"从告警到可归档"）
2:40–3:00 Esc 回全景 → 三动词收尾：看得见（空间定位）/ 说得清（三路证据）/ 管得住（HITL+零出域）
规则：每步点击后停 1.5–2 秒再讲；任何一步失败，3 秒内切兜底（见任务 3）。

【任务 2｜5 分钟现场加长版】
在 3 分钟版上插入 4 段（各 30–50s）：①Shift+P 展示 Draw Calls 恒定与实例合并；②双轨状态架构（1Hz→60FPS 插值、零重渲染）；
③断网演示：拔网/关 WiFi 后跑「剧本路演」OOM 剧本，讲"离线优先是设计不是降级"；④新增自定义 Runbook 立刻可检索。
给出"可砍顺序"：RAG 详展 → 端侧 → 复盘，砍到 2 分 10 秒仍完整。

【任务 3｜风险与兜底矩阵（每条含：触发信号 / 3 秒动作 / 话术过渡）】
必须覆盖：断网、无 API Key（默认！抽屉会显示"本地确定性容灾引擎"）、WebGPU 不可用、端侧模型加载慢（30–90s）、
演示脚本中途失败（按钮找不到/勾选遗漏/误按 Esc）、投影 1080p 字体小、现场机集显低帧、端口被占/服务未起、超时、TTS 与主讲抢声。
额外给出：为保证"断网也能跑"，**开演前必须完成的预热清单**（生产模式 pnpm build && pnpm start、浏览器 100% 全屏、
先注入一次故障并终止以确认链路、端侧页签状态确认、音量静音、计时器不可见、备用机同版本）。

【任务 4｜自动路演（剧本路演）的定位与话术】
明确"剧本路演是兜底与加分项，不是主路径"：
- 若现场设备/网络异常，一键剧本路演可完整跑通 34s 链路（但必须使用 R1 修复后的版本）；
- 讲法："这是我们为评委准备的自动演示模式——它把整条链路用时间轴跑一遍，讲解者只需要讲。"
- 同时给出"自动路演不适合当主路径"的理由（P1 修复前存在目标不一致风险；修复后可作为 5 分钟版的可选段落）。

【任务 5｜答辩追问 Top 10 + 标准答法】
每题 2–4 句、≤40 秒、必须给文件/数据佐证（背下路径）：3D 是装饰还是有用？AI 是真模型还是写死脚本？为什么自己做 RAG？
92.4% 是不是编的？端侧推理真跑模型了吗？MCP 是真 MCP 吗？数据哪来的/没有真集群是不是 Mock？性能 FPS 到底多少？
商业价值谁付钱？36k 行代码怎么保证质量？
另给 3 个"危险追问"的诚实回答模板（没演示的功能/数字对不上/是否用了 AI 写代码）。

【任务 6｜彩排与验收】
输出一张彩排评分表：完整流程计时（目标 2:50–3:00）、每步失败次数、卡顿时长、评委可能追问点；
要求彩排 3 次、误差 ≤10s；每次彩排后更新"卡点清单"并给出修复动作。

【约束】
- 台词必须口语化、不念 PPT 标题、不在开场介绍团队（留最后 10 秒或 Q&A）；
- 所有数字以 R3 脚本生成的最新值为准（脚本跑完再写台词）；
- 不承诺未验证能力（如"60FPS""真实集群""标准 MCP transport"——在三项上都只能按白皮书边界表述）。

【交付】
1. 3 分钟分镜表（表格：时间/动作/预期画面/讲解词/证明点）。
2. 5 分钟加长版差异表 + 可砍清单。
3. 风险兜底矩阵 + 开演前 5 分钟预热清单（可打印）。
4. 剧本路演话术段落。
5. 追问 Top10 答法 + 危险追问 3 条。
6. 彩排评分表模板。
````

### R8 · 进阶优化追问 Prompt

````text
继续演示深化，三项：

追问 1｜录屏工程化
按分镜生成一份"录屏执行单"：分辨率 1920×1080、30fps、浏览器 100% 缩放、无鼠标抖动（用键盘/脚本化点击辅助）、
旁白逐句稿（含停顿标记）、BGM 建议（若有）；录 3 遍取最好，保留本地 mp4 备份（不依赖 B 站）。
额外：准备一条"纯画面无旁白"的 60s 版本，供 PPT 内嵌或现场静音播放。

追问 2｜现场设备预案
列出"主讲机 + 备份机"双机清单：同版本代码、同浏览器版本、离线可跑、`.next` 构建产物预置、备用电源/HDMI 线/U 盘（含 zip 与 mp4）；
写一份"现场 15 分钟检查表"，并按优先级排序（投影 > 网络 > 音量 > 鼠标）。

追问 3｜评委视角彩排
让 AI 扮演"技术评委 + 产品评委 + 投资评委"三种角色，各提 5 个刁钻问题（含追问链），
你现场作答，AI 按"是否有证据 / 是否诚实 / 是否 40 秒内"打分并给改进建议。至少做两轮。
````

---

## R9 · 竞赛交付物与证据链

**目标**：把"技术实力"变成"可提交、可复查、可自证"的材料包；所有材料中的数字必须来自同一次脚本运行；官方赛事名称用规范全称。

### R9 · 主 Prompt

````text
你是竞赛交付项目经理 + 技术文档工程师。请为 KubeVision 建立"零缺口"的提交包，并生成缺失材料。
背景：赛事可确证为「AI WEB 网页开发挑战赛（团队赛）」，隶属第十七届全国大学生计算机应用能力与数字素养大赛暨 2026 第九届传智杯；
官方评分细则未能从公网获取，README 现有六维权重为团队自述口径，材料中不得声称"官方评分标准"。
当前缺失/待升级项（已核查）：
- 缺失：介绍 PPT（转 PDF）、≤3 分钟演示视频、源码 zip、LICENSE、部署链接、第三方与模型引用声明、verify/benchmark 运行证据截图、Dockerfile、答辩讲稿、备用录屏。
- 占位：README 团队信息 8 处【待填写】；组别/赛区/报名状态无记录。
- 需升级：README（数据与按钮文案过期、缺"剧本路演"章节）、技术白皮书 PDF（生成时间早于最新提交）、performance 数据（6 组矛盾）。

【任务 1｜README 重构（对外第一入口）】
保留现有结构与技术深度，但必须：
1) 顶部信息改为规范赛事全称 + 赛道名 + 团队信息表（保留占位符但标注"提交前必填"）；
2) 数据指标全部来自 `node scripts/benchmark.mjs` 最新输出（draw calls/实例/三角形/检索延迟/脱敏吞吐/代码规模），并注明采集环境；
3) 新增「一键剧本路演」章节（OOM 34s / CNI 32s、字幕条、TTS、如何作为现场兜底）；
4) 新增「已知局限与数据边界」章节（未接真集群、FPS 未真机采集、端侧模型 fallback、MCP 非标准 transport、无 Key 走引擎 B）；
5) 修正死链（useSpeechRecognition → useSpeechInput）与按钮文案错误；
6) 明确 3 分钟演示路径为唯一版本（删除并存的 5 分钟旧脚本或明确标注为加长版）。

【任务 2｜技术白皮书升级 + PDF 重导】
- 与 README 数字对齐；补 R1/R3/R6 新增能力（自动路演、实测 trace、MCP 规范、检索评测、真 embedding）；
- 修正 K8S_API_URL → K8S_API_SERVER 等 12 处文档/代码不一致；
- 用 `node scripts/build-whitepaper-pdf.mjs` 重导 PDF，生成时间晚于最后一次代码提交，体积 ≤10MB。

【任务 3｜PPT（10–12 页，转 PDF ≤10MB）】
结构：封面（作品名+赛事全称+赛道+团队/院校）→ 一句话价值+3 个数字 → 痛点 3 条 → 系统架构图（端云双擎）→
三大技术亮点（双擎/ReAct/RAG）→ 空间-语义双向绑定（前后对比截图 2 张）→ 端侧零出域（原始 vs 脱敏 + 三级降级）→
工程与数据（Draw Calls/检索延迟/验收通过数 + 采集环境）→ 商业与落地（客户/竞品/定价/试点）→ 团队分工 + 第三方引用 + 联系邮箱。
要求：每页不超过 40 字正文；所有截图来自 R4/R5 升级后的最终版本；给出可直接生成 PPTX/PDF 的脚本文案（页面标题、要点、讲稿备注）。

【任务 4｜3 分钟演示视频脚本】
按 R8 的 canonical 分镜生成"录屏执行单"：逐镜时间码、画面动作、旁白稿、字幕文本、要点标注；
规格：mp4 / 1920×1080 / 30fps / ≤3:00；另给 60s 无旁白版与本地备份说明。

【任务 5｜源码包与部署】
- 生成打包清单：排除 node_modules/.next/.git/docs/evidence 大文件；命名规范"学校+队名+队长联系方式"；
- 写 `启动说明.md`（Node≥18.17、pnpm 版本、pnpm i && pnpm dev、无 Key 也可跑）；
- 新增 Dockerfile + .dockerignore（多阶段构建，暴露 3000，避免把 .env.local 打进镜像）；
- 部署：给出 Vercel 或自托管步骤、环境变量清单、SSE 长连接注意事项（no-transform、maxDuration）；若不能公网部署，给出离线运行说明与截图。

【任务 6｜证据链（评委最吃的"可自证"）】
- 建 `docs/evidence/`：verify.mjs 运行截图（含日期与通过数）、benchmark 截图、剧本路演全过程 3 张关键截图、
  端侧审计前后对比截图、RAG 检索三路得分截图、性能 HUD 截图；
- 每张图配一行说明（这张图证明什么、在哪个文件/命令可复现）；
- 生成 `docs/EVIDENCE.md` 索引表（证据 → 结论 → 复现命令）。

【任务 7｜第三方引用与合规】
`THIRD_PARTY_NOTICES.md`：Next.js/React/three/R3F/drei/postprocessing/zustand/AI SDK/Transformers.js/Tailwind 的许可证与用途；
模型引用：Xenova/all-MiniLM-L6-v2（ONNX 权重来源与许可证）；语料声明：12 篇 Runbook 为团队自撰/改编并注明参考来源；
LICENSE：MIT 或"仅限竞赛评审使用"（与团队确认后选择）。

【约束】
- 所有数字只来自脚本输出；禁止手填、禁止沿用旧值；
- 不伪造任何官方文件、评分标准或报名信息；不确定的赛事细节必须标注"待确认"并向指导教师核实；
- 材料中的功能描述必须与代码一致，不允许"写出来但没实现"；
- 不改动功能代码（仅文档/配置/脚本），如需改脚本须保证 verify 全绿。

【交付】
1. 15 项提交物清单（已有/已补/仍缺/负责人/截止时间）。
2. 更新后的 README 关键段落 diff、白皮书 PDF 生成时间与体积。
3. PPT 页面文案（10–12 页）+ 讲稿备注。
4. 视频录屏执行单。
5. `启动说明.md`、Dockerfile、THIRD_PARTY_NOTICES.md、LICENSE、docs/EVIDENCE.md。
6. 一份"提交前 24 小时检查表"。
````

### R9 · 进阶优化追问 Prompt

````text
继续交付物深化，三项：

追问 1｜数据一致性守门
写 `scripts/check-docs-consistency.mjs`：读取 docs/performance.json，校验 README/白皮书/PPT 文案中的关键数字与之一致（用标记区块或正则），
不一致则 fail；把它加入 verify 流程。目标：评委交叉核对时"零矛盾"。

追问 2｜商业价值补齐
基于现有产品能力，补一页"商业与落地"：
目标客户画像（无专职 SRE 的中小团队 / 有信创要求的企业）、竞品矩阵（Datadog/Lens/Rancher 等 4 家 × 5 维）、
商业模式（开源社区版 + SaaS 按集群订阅 + 私有化授权）、单位经济（粗算 ARPU/成本结构，标注假设）、90 天 PoC 计划与 3 个验证指标（MTTR/定位耗时/高危操作审计覆盖率）。
要求：所有数字标注"假设/估算"，不伪装成实测。

追问 3｜答辩 PPT 的"证据页"
把 R6 的检索评测（Recall/MRR/NDCG）、R3 的数据不变式、R1 的自动路演断言结果做成 2 页"可验证证据页"，
每页含：结论一句话 + 图表 + 复现命令 + 数据时间戳。评委追问时直接翻页，比口头解释有说服力。
````

---

## 终验清单（Definition of Done）

> 每一组必须**全勾**才算"可提交"；打不了勾的写进风险台账并给出兜底话术。

### D1 功能与演示
- [ ] 自动路演：镜头锁定真实受灾机架；AI 正文节点与 HUD 一致；healedPodIds 覆盖 victim；动作卡 executed；连跑两遍一致；pause/resume/stop 无残留。
- [ ] 手动演示链路：故障注入 → 快照诊断 → 三卡 → 勾选确认 → 自愈 → 回执 → 复盘报告，全链路 2 次彩排零卡点。
- [ ] 离线：断网 + 无 Key 下，上述链路（引擎 B）完整可跑；端侧审计显示降级但可用。
- [ ] 语音：拾音/播报/打断/降级均可演示（可选）。

### D2 数据与指标
- [ ] `node scripts/benchmark.mjs` 跑两遍结果一致；README/白皮书/PPT 数字与 `docs/performance.json` 零差异。
- [ ] `scripts/verify-telemetry.mjs` 全绿（QPS 有界、CPU 有界、时间戳单调、历史长度恒 6）。
- [ ] RAG 评测表存在且数字由脚本生成（Recall@1/@3、MRR、NDCG@5、负例拒答率）。
- [ ] 端侧延迟/脱敏吞吐/检索延迟标注采集环境与时间。

### D3 视觉与体验
- [ ] `grep -rn "text-\[[0-9]px\]" src` 无 <10px；对比度扫描无正文 <4.5:1。
- [ ] 三组 A/B 截图（overview/Pod 特写/故障态）观感一致；1920×1080 与 1366×768 两种分辨率下无遮挡、无裁切。
- [ ] 性能 HUD 显示档位与帧时间；软渲染路径明显降载（Composer/反射/阴影关）。
- [ ] 首屏 3 秒内建立空间认知（三机架/晶核/星环/星尘），无加载闪烁断层。

### D4 工程质量
- [ ] `tsc --noEmit --incremental false`、`next lint`、`node scripts/verify.mjs` 全绿；0 个 any / @ts-ignore。
- [ ] `node scripts/verify-demo.mjs` 全绿；`scripts/verify-stream-integrity.mjs` 无孤儿事件。
- [ ] `scripts/check-layering.mjs` 无新增违规；`check-dead-exports` 无新增死代码。
- [ ] 首屏 bundle 体积记录在案；依赖无未使用项（或已说明保留原因）。
- [ ] 死代码清理完成（净删 ≥300 行源码），配置修正（pnpm/ESLint/vercel/scripts 登记）。

### D5 交付物
- [ ] README（团队信息填全、剧目路演章节、已知局限、数据一致）。
- [ ] 白皮书 .md + PDF（生成时间晚于最后提交、≤10MB）。
- [ ] PPT / PDF（≤10MB，10–12 页，含商业页与证据页）。
- [ ] 3 分钟演示视频（1080p/30fps，≤3:00）+ 60s 无旁白版 + 本地备份 mp4。
- [ ] 源码 zip（规范命名、启动说明、不含 node_modules/.next/.env.local）+ Dockerfile。
- [ ] LICENSE + THIRD_PARTY_NOTICES.md + 部署链接或离线运行说明。
- [ ] docs/evidence/ 截图与 docs/EVIDENCE.md 索引；verify/benchmark 运行存证。
- [ ] 报名回执/组别/赛区信息存档；官方评分表与提交规范原件已获取（若无法获取，材料中不引用"官方标准"）。

### D6 现场
- [ ] 彩排 3 次，计时误差 ≤10s；卡点清单清零或已备兜底。
- [ ] 双机同版本、离线可跑、备用录屏、备用电源/线材/U 盘。
- [ ] 开演前 15 分钟检查表执行完毕；主讲人熟记 10 条追问答法与 3 条危险追问诚实模板。

---

## 附录 A · 关键缺陷索引总表（供 R1/R2/R3 直接引用）

| 级别 | 缺陷 | 位置 |
|---|---|---|
| P0 | 混沌→节点映射写反（OOM→alpha / NET→beta） | `src/utils/demoDirector.ts:111-116,529-552` vs `src/utils/syntheticEngine.ts:73-94` |
| P0 | 阶段 4 自愈目标解析错误 → 对健康节点 drain_node | `src/utils/demoDirector.ts:422-438,457-473` |
| P0 | HITL 被绕过 + 终态"已完成 vs 待执行"矛盾 | `src/utils/demoDirector.ts:457-473` + `src/components/ai/GenUI/ActionConfirm.tsx` |
| P1 | 未强制 demo 连接模式 | `src/utils/demoDirector.ts:358-364` |
| P1 | 阶段 3→4 固定 15s 窗口 | `src/utils/demoDirector.ts:135-164` |
| P1 | 巡检被 CameraRig 同批关闭 | `src/utils/demoDirector.ts:470-473` + `src/components/canvas/CameraRig.tsx:191-204` |
| P1 | 重复路演被 30s 免疫吞掉、无清除入口 | `src/store/useClusterStore.ts:70,559-588` |
| P1 | QPS 复利漂移 | `src/utils/syntheticEngine.ts:673-682` |
| P1 | 节点 CPU 随机游走无回归 | `src/utils/syntheticEngine.ts:580-585` |
| P1 | RAG Sigmoid 系数错误/排序反转 | `src/utils/sreRagEngine.ts:828-834,1356-1362` |
| P1 | Esc 退出栈失效（4 处独立监听） | `src/app/page.tsx:242-259` 等 4 处 |
| P1 | 端侧审计降级死锁 | `src/hooks/useEdgeLogClassifier.ts:279-292,236-250,315-334` |
| P1 | MCP 假成功回执（namespace/404/kubectl 不一致） | `src/app/api/mcp/execute/route.ts:141-155,277-300` |
| P1 | ActionConfirm 静默替换执行目标 | `src/components/ai/GenUI/ActionConfirm.tsx:263-288,378` |
| P2 | 引擎 A 回落重复卡片 | `src/app/api/chat/route.ts:2753-2773` |
| P2 | 停止生成后 isStreaming 不复位 | `src/components/ai/CopilotDrawer.tsx:1523-1573` |
| P2 | sleep() 监听泄漏 | `src/app/api/chat/route.ts:890-908` |
| P2 | 流式中"快照诊断"被丢弃 | `src/components/ai/CopilotDrawer.tsx:1734-1739` |
| P2 | 动作卡多轮历史缺失 | `src/components/ai/CopilotDrawer.tsx:483` |
| P2 | TTS 写在 updater 内（StrictMode 双播） | `src/components/ai/CopilotDrawer.tsx:1512-1521` |
| P2 | 复盘报告用导出时刻快照 | `src/components/ai/CopilotDrawer.tsx:1254-1266` |
| P2 | IDF 缓存指纹不足 | `src/utils/sreRagEngine.ts:630-657` |
| P2 | 脱敏非幂等 / URL 凭证截断 | `src/utils/logSanitizer.ts:107-108,141-143` |
| P2 | Worker 模型并发重复初始化 | `src/workers/logClassifier.worker.ts:800-802` |
| P2 | 拾音 rAF 每帧 setState | `src/hooks/useSpeechInput.ts:358-409` |
| P2 | 静音不自动收尾 / start 无互斥 / 冒充识别结果 | `src/hooks/useSpeechInput.ts:393-403,526-563,569-611` |
| P2 | live 采集无在飞互斥 | `src/app/api/telemetry/route.ts:216-268` |
| P2 | live 内存恒 0 | `src/utils/liveTelemetry.ts:798-818` |
| P2 | 免疫合并误伤节点 | `src/hooks/useTelemetryStream.ts:313-335` |
| P2 | 免疫排队无消费者 | `src/store/useClusterStore.ts:559-588` |
| P3 | verify/rag 未校验元素 | `src/app/api/verify/rag/route.ts:42-49` |
| P3 | 瞬态池按下标映射 | `src/store/useTelemetryRef.ts:126-150` |
| P3 | 固定 seed 时间戳跨模式混用 | `src/types/cluster.ts:249` |
| P3 | TTS blocked 态不复位 | `src/hooks/useSpeechSynthesis.ts:401-417` |

## 附录 B · 美术/性能参数速查（可直接抄进 R4）

| 项 | 建议值 |
|---|---|
| ToneMapping | `ToneMappingMode.NEUTRAL` + `toneMappingExposure 1.05`（上限 1.18） |
| Bloom | `threshold .78 / smoothing .14 / intensity .72 / radius .62 / levels 6 / mipmapBlur true` |
| AA | T3 `multisampling={2}`；T2 `<FXAA/>`；`antialias:false`；顺序 Bloom→TM→AA→Vignette→Noise |
| Vignette | Composer `offset .22 / darkness .28`；CSS 暗角 `rgba(2,6,23,.42)`、起止 62% |
| DPR | 初值 `min(devicePixelRatio,1.75)`；下限 0.85；`PerformanceMonitor ms=200` |
| 灯光 | ambient .18 / hemi .34 / key 2.30(#eaf4ff) / rim .95 / point 28 |
| 阴影 | 2048² / 正交 ±13 / normalBias .02 / bias -.0005；ContactShadows 768、blur 1.6、opacity .55 |
| 反射 | T2/T3：resolution 256、blur [180,56]、mixStrength 9、mirror .45、roughness .68；T1/T0 关闭换 1DC shader |
| 构图 | `OVERVIEW_LOOK_AT` 由 `[0,2.5,0]` → `[0,1.20,0]`；相机 `[7.8,14,22]`、fov 40 不动 |
| 铭牌 | 机架名 12px、徽标/计数 10px、Master 11px、Pod hover 名称 11px、状态 10px（去掉 distanceFactor） |
| 发光预算 | 晶核 ≤1.15 / 主轨 ≤0.55 / 外围 ≤0.40 / 顶冠 ≤0.45（alpha 总和） |
| 动效节拍 | `MOTION_BEAT=3.6s`；120/200/320ms + spring {420,34} |
| 档位 | T3 独显 2.0 + 全开；T2 默认 1.5 + Bloom/TM/FXAA；T1 1.25 关反射/阴影；T0 软件渲染全关 + DPR1.0 |
| 禁止 | multisampling=8、新色相、双重发光、改雾 (15,64)、改相机位/fov 不评估 verify |

## 附录 C · 3 分钟分镜速查（打印版）

| 时间 | 动作（真实文案） | 讲点 |
|---|---|---|
| 0:00–0:10 | 不操作 | 钩子（A/B/C 三选一）+ 一句话定位 |
| 0:10–0:30 | 点 worker-beta 上的 Pod | 空间=索引；单一坐标真相源 |
| 0:30–0:45 | Ctrl/Cmd+K → `beta` → Enter | 键盘一等公民 |
| 0:45–1:00 | 顶栏「故障演练」→ `POD_OOM_SWARM` 卡片（点卡即注入） | 故障是空间脉冲 |
| 1:00–1:30 | 视口工具条「快照诊断」 | 多模态输入 + 可解释四阶段 |
| 1:30–1:45 | 勾选复选框 → 「立即执行自愈方案」 | HITL 护栏 + 控制器回执 |
| 1:45–2:05 | 「RAG 知识库」→ 输入"容器内存爆了 exit 137" | 三路证据 + 零命中拒答 |
| 2:05–2:25 | 「端侧日志审计」→ 预设"数据库连接串泄露" → 「抓取并审计」 | 原始凭证零出域 + 三级降级 |
| 2:25–2:40 | 「复盘报告」 | 从告警到可归档 |
| 2:40–3:00 | Esc 回全景 | 看得见 / 说得清 / 管得住 |

## 附录 D · 评委追问 Top 10 速查

| # | 追问 | 一句话答法（完整版见 R8 产物） |
|---|---|---|
| 1 | 3D 是装饰还是真有用？ | 是索引：点实体出卡片、点卡片反向定位，共用 `spatialLayout.ts` 一份坐标；截图还喂给多模态。 |
| 2 | AI 是真模型还是写死脚本？ | 双引擎：有 Key 走引擎 A 流式；无 Key/断网自动回落引擎 B，并推 `engine` 事件在 UI 诚实标注。 |
| 3 | 为什么自己做 RAG？ | 运维要可追溯证据：BM25+TF-IDF+RRF+Sigmoid 分段校准，能回答"结论来自哪篇手册哪条 SOP"。 |
| 4 | 92.4% 是不是编的？ | 分段 Sigmoid 系数由边界条件反解，非固定高分；查询 IDF 闸门 + 证据闸门；无关问题如实零命中。 |
| 5 | 端侧真跑模型吗？ | WebGPU→WASM→内置分类器三级链；真推理是 MiniLM 384 维 zero-shot；面板诚实标注当前运行时。 |
| 6 | MCP 是真 MCP 吗？ | 工具契约与执行回执是真的；本轮补 `/api/mcp` 标准 JSON-RPC（initialize/tools/list/tools/call + id 回显）。 |
| 7 | 没真集群是不是 Mock？ | 数据源是合成引擎（如实声明），但故障机理/Runbook/指标语义是真的；live 适配口已预留。 |
| 8 | 性能 FPS 多少？ | 不拿 FPS 当证据（SwiftShader 无 GPU），用硬件无关的 Draw Calls（恒定，且合并后更低）；真机数据另行标注。 |
| 9 | 商业价值谁付钱？ | 无专职 SRE 的中小团队 + 信创企业；开源社区版 + SaaS 按集群订阅 + 私有化授权；付费点是 MTTR 与合规。 |
| 10 | 36k 行怎么保证质量？ | AGENTS.md 工程契约（禁 any/60FPS/SSR/中文注释）+ verify 四阶段自动化 + 依赖世代锁；AI 是加速器，架构与验收标准是团队定的。 |

## 附录 E · 审计证据与复现方式

| 证据 | 路径/命令 | 说明 |
|---|---|---|
| 自动路演实跑复现脚本 | `%TEMP%\kvision-review\demo-repro.mjs`（隔离副本 + headless Edge + CDP） | 会在临时副本运行，不修改仓库；采样 store/相机/DOM/console |
| 路演截图 | `%TEMP%\kvision-review\shots\00-idle.png` … `05-finished.png` | 02=锁定健康机架、03=AI 正文与 HUD 矛盾、05=终态"已自愈 vs 待执行" |
| T1 路演根因报告 | `%TEMP%\kvision-review\t1-demo.md` | P0/P1/P2 全量、运行期采样 |
| T2 缺陷巡检报告 | `%TEMP%\kvision-review\t2-bugs.md` | 30 条，含复现与修复方向 |
| T3 代码资产报告 | `%TEMP%\kvision-review\t3-debt.md` | 40 条，A/B/C 三批 |
| T4 视觉审计 | `%TEMP%\kvision-review\t4-visual.md` | 参数表、预算、竞品、3 秒分镜 |
| T5 AI 体检 | `%TEMP%\kvision-review\t5-ai.md` | 11 项 A/B/C 判定、R1–R13 路线 |
| T6 竞赛策略 | `%TEMP%\kvision-review\t6-competition.md` | 赛事事实、评分推演、分镜、追问、排期 |
| 运行期采样（原始） | 见 T1 报告 §5 | 阶段 2/4 的 store JSON、终端日志摘录 |
| 项目只读基线 | `git log --oneline -1` = `14732fd`；`git status` 干净 | 所有结论基于该 commit |

> 注：临时目录可能被系统清理；如需长期留档，把上述报告与截图复制到 `docs/review-2026-11-09/`（本节不要求修改仓库，由团队自行决定）。

## 附录 F · 使用本手册的三条纪律

1. **一次只做一轮**：混轮执行会让 AI 同时改演示、数据、视觉，回归难以定位；每轮结束必须 commit 并跑全量验收。
2. **不接受口头完成**：任何"已完成"必须附命令输出、截图或测试结果；无法自证的内容写进"未验证项"，不要包装。
3. **诚实优于完美**：竞赛评委更看重"边界清楚、证据充分"，而不是"什么都能"。所有降级、编排、仿真都要主动标注——这正是本项目"引擎 B / synthesized / 数据边界声明"的既有优点，继续发扬。

---

*本手册为只读审计产出，未修改 KubeVision 仓库任何源文件；仓库中仅新增本文件和最终交付物。审计基线 commit `14732fd`，报告生成时间 2026-11-09。官方赛事规则未能从公网核验，涉及官方口径的内容均标注为"待确认"。*