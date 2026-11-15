# KubeVision AI

> **云原生三维空间态势感知与多模态智能自愈副驾系统** · **MIT License**
>
> **🌐 公网免部署在线体验（打开即用，无需 API Key / 无需 GPU / 无需 K8s 集群）**：[https://kube-vision-bice.vercel.app](https://kube-vision-bice.vercel.app)

KubeVision AI 把 **3D 空间态势**、**混合 RAG 知识检索**、**端侧隐私推理** 与 **生成式 UI** 融合成一个云原生运维中控台。左侧是可交互的 3D 集群拓扑，右侧是能自我规划、检索手册、调用 MCP 工具并执行自愈的 AI 副驾驶。

一句话概括：**用一块屏幕看清集群，用一句话完成从告警到复盘的闭环。**

## 为什么是 KubeVision（5 行）

1. **问题**：K8s 告警把三维现场压成一行日志——定位靠猜、根因无出处、高危操作难审计。
2. **方案**：3D 空间索引 + 双擎 Agent（云端 LLM / 离线引擎 B）+ 混合 RAG + 端侧脱敏 + MCP 人工在环闭环。
3. **证据**：35/35 自动化验收；draw calls 中位 235；RAG 三路 Recall@1 94.4%（+5.6pp，受控评测基准）；检索均值 8.39ms；脱敏 11,264 条/秒；完整安全声明见 [docs/SECURITY_ADVISORY.md](docs/SECURITY_ADVISORY.md)。
4. **边界**：默认走确定性仿真集群（真实 K8s 写操作受 `K8S_ALLOW_REAL_WRITE=true` 硬隔离）、FPS 采集于 SwiftShader 不代表真机 GPU、端侧模型超时降级为内置分类器、MCP 走 HTTP JSON-RPC 非 stdio、无真实客户/营收数据。
5. **价值**：离线优先、零凭证出域、可审计可复盘的 SRE 副驾，降低中小企业 K8s 排障门槛。

### 30 秒快速复现与虚实边界速览

- **30 秒一键启动（无需 Key / 无需真实集群）**：
  ```bash
  pnpm install --frozen-lockfile && pnpm dev   # 或 pnpm build && pnpm start
  ```
- **自动化验证入口**：`node scripts/verify.mjs --quick`（静态门禁）· `node scripts/verify.mjs`（完整 35 项含 CDP 浏览器 E2E）· 安全基线见 [docs/SECURITY_ADVISORY.md](docs/SECURITY_ADVISORY.md)。

| 能力域 | 真实运行路径（Real / Live） | 确定性仿真 / 降级兜底路径（Simulated / Fallback） | 诚实标识机制 |
|---|---|---|---|
| **集群遥测与自愈执行** | 配置 `K8S_API_SERVER` 后采集真实节点/Pod；仅当 `K8S_ALLOW_REAL_WRITE=true` 时允许写入（`MCP_ADMIN_TOKEN` 可选鉴权） | 默认 `demo` 确定性故障集群；`drain_node` 为 **Cordon（仅禁止新调度）**，`scale_deployment` 限 `[1, 50]`，严禁暗中回落伪装真集群 | 顶栏 Mode 标识 + `/api/health` 能力矩阵 +回执 `executionStage` 与 `kubectl` 预览 |
| **双擎 AI 副驾驶** | 配置 `OPENAI_API_KEY` 等走真实大模型流式 NDJSON + 多模态视觉分析 | 无 Key 或网关异常时自动切本地确定性仿真引擎 B，基于**真实遥测切片 + 真实 RAG 检索 + 多假设交叉验证推理链** | 抽屉底部「推理引擎」行如实显示当前引擎 |
| **混合 RAG 检索** | 语料级 IDF + Okapi BM25 + TF-IDF 余弦 + MiniLM 384d 句向量三路 RRF（含真实通道消融开关 `disableSemantic`/`disableBm25`） | 查询向量未就绪时退化为两路 RRF；无关/寒暄触发 IDF 与证据闸门零命中拒答 | UI 直接展示 Vector/BM25/Context 证据占比或零命中提示 |
| **端侧隐私与日志分类** | 浏览器内 9 类有序正则先脱敏（含 AI/VCS Token、通用 KV 密钥、IPv6）；WebWorker `requestId` 关联 MiniLM 句向量余弦分类 | 无 WebGPU/WASM 权重超时（3500ms 熔断）时切换带否定词消除与置信度校准的内置分类器 | 页签状态徽标如实标为 `WebGPU` / `WASM` / `内置 (builtin-fallback)` |
| **3D 渲染与质量门禁** | Real Three.js r169 / R3F 程序化网格 + InstancedMesh 批量渲染（Draw Calls 中位 235）+ WebGL Context Lost 恢复守卫 | 无独显环境运行于 SwiftShader 软件光栅化 | 全仓明确声明 SwiftShader FPS 不作为性能证据，仅展示硬件无关统计 |

---

## 一、项目概览与技术规格

### 1.1 基本信息

| 项目 | 内容 |
|---|---|
| 项目名称 | **KubeVision AI** |
| 核心定位 | 云原生三维空间态势感知与多模态智能自愈副驾系统 |
| 应用形态 | B/S 架构 Web 应用（Next.js 14 App Router 全栈单体） |
| 开源协议 | [MIT License](LICENSE) |
| 在线演示 | [https://kube-vision-bice.vercel.app](https://kube-vision-bice.vercel.app)（公网 Vercel 部署入口；免 Key 自动运行本地确定性引擎 B；配置云端 Key 开启完整大模型多模态流式体验） |
| 代码规模 | 145 个 TypeScript/TSX 源文件 · 70,577 行（`src/**/*.{ts,tsx}`，含注释） |
| 运行要求 | Node.js ≥ 22.13.0（推荐 24 LTS，见 [`.nvmrc`](.nvmrc)） + pnpm；**无需 GPU、无需真实 K8s 集群、无需 API Key**（无 Key 自动走引擎 B） |

---

## 二、核心工程能力与架构映射矩阵

> **架构速览**：下表按工程能力维度列出对应设计与核心实现入口，点击右侧链接即可直接跳转源码定位验证。

### 2.1 能力总览

| 能力维度 | 架构侧重 | 核心实现策略 |
|---|---|---|
| **AI 编排与检索深度** | **云端 + 端侧协同** | 双擎流式大模型 + 四阶段 ReAct Agent + BM25/TF-IDF/RRF 混合 RAG + 端侧 Transformers.js + MCP 工具闭环 |
| **交互与系统创新** | **空间化人机协同** | 空间-语义双向绑定（3D 坐标 ↔ 数据面板）、云端推理 + 端侧隐私审计双模协同 |
| **前端工程质量** | **契约与零退化** | 零 `any` 严格类型、<!-- VERIFY:BEGIN -->**通过 35 · 失败 0 · 跳过 0（共 35 项）**<!-- VERIFY:END -->、双轨状态架构（60FPS 为目标帧率，实测见局限） |
| **场景实用性** | **可控 SRE 闭环** | 覆盖真实 K8s 五大类高频故障，处置动作直连 MCP 协议 |
| **可视化体验** | **零外部模型渲染** | 程序化 3D 场景与 GLSL 特效、生成式 UI 卡片水合、全键盘与 3 分钟交互流 |
| **隐私与私有化潜力** | **本地合规优先** | 降低中小企业 K8s 运维门槛，敏感日志端侧零出域脱敏合规 |

### 2.2 AI 技术栈拆解与源码锚点

| 子模块 | 关键特性 | 核心实现 | 代码位置 |
|---|---|---|---|
| **大模型流式集成** | 双擎无痛切换 | 双引擎（真实 LLM + 确定性仿真器）NDJSON 流式协议；`fullStream` 逐帧消费；断流自动降级不中断交互 | [`src/app/api/chat/route.ts`](src/app/api/chat/route.ts) · [`CopilotDrawer.tsx`](src/components/ai/CopilotDrawer.tsx) |
| **ReAct Agent 工作流** | 四阶段可解释 | 四阶段推理链：意图规划 → 多模态视觉 → RAG 检索 → MCP 工具调用，每阶段实时回传耗时与详情到思维链 UI | [`AgentThoughtChain`](src/components/ai/GenUI/AgentThoughtChain.tsx) |
| **混合 RAG 检索** | 三路 RRF 校准 | 语料库级 IDF 预计算 + Okapi BM25（k₁=1.5, b=0.75）+ TF-IDF 加权余弦 + RRF 倒数秩融合 + Sigmoid 分段置信度校准；12 篇权威手册 | [`sreRagEngine.ts`](src/utils/sreRagEngine.ts) |
| **多模态融合** | 视口快照 + 语音 | 3D 视口截图 → 多模态数组消息（`[text, image]`）→ 视觉推理步骤；语音输入 / 语音播报双通道 | [`route.ts`](src/app/api/chat/route.ts) · [`useSpeechInput`](src/hooks/useSpeechInput.ts) |
| **端侧脱敏与 HITL 安全** | 零出域 + 强确认 | 9 类敏感凭证正则脱敏（零出域）+ WebGPU/WASM 384 维神经余弦分类 + 高危动作二次确认护栏 | [`logSanitizer.ts`](src/utils/logSanitizer.ts) · [`logClassifier.worker.ts`](src/workers/logClassifier.worker.ts) |
| **MCP 协议工具闭环** | 校验与回执签名 | 3 个 MCP 工具注册、参数校验、执行回执、3D 空间自愈脉冲 | [`route.ts`](src/app/api/chat/route.ts) |

### 2.3 关键技术创新点

| 创新点 | 说明 | 对比传统监控方案 |
|---|---|---|
| **空间-语义双向绑定** | 点击 3D 实体 → 相机飞跃 + 探针卡展开；点击卡片内 Pod 名 → 3D 场景反向定位。数据与空间互为索引 | 传统 Dashboard 只有表格，故障无空间位置感 |
| **云端推理 + 端侧审计双模** | 高危日志在浏览器内完成脱敏与语义分类，只有脱敏摘要才可能离开设备 | 常规方案把原始日志整包上云，存在凭证泄露风险 |
| **数字孪生级 3D 场景** | 零外部 `.glb` 资产，全部程序化几何 + 自定义 GLSL（等离子星核 / 全息数字雨 / 体积激光） | 多数方案依赖静态示意图或引入重型外部模型文件 |
| **从告警到复盘的全链路** | 注入故障 → AI 诊断 → 一键自愈 → 自动生成 Google SRE 标准复盘报告（可导出 .md） | 多数助手止步于文本建议，缺少结构化控制闭环 |

### 2.4 前端工程质量与受控基准快照

| 指标 | 实测值 |
|---|---|
| TypeScript 严格模式 | 全仓 0 个 `any` / `@ts-ignore` |

<!-- 以下区块为 docs/performance.json 与 docs/rag-eval.json 的受控基准快照归档 -->
<!-- METRICS:BEGIN -->
| 指标 | 实测值 | 采集口径 / 是否可作性能证据 |
|---|---|---|
| 数据采集时间 | 2026-11-14 19:09（Asia/Shanghai） | 历史受控基准快照（数据归档于 `docs/performance.json`） |
| 运行环境 | win32 x64 · AMD Ryzen 9 7845HX with Radeon Graphics · 31GB RAM · Node v24.16.0 · 24 核 | 同上 |
| WebGL 渲染器 | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) | 软件光栅化，**FPS 不作为性能证据** |
| Draw Calls | **235**（20 次采样 235~238） | 硬件无关，可作渲染优化证据 |
| Triangles | 206,626（中位） | 硬件无关 |
| 场景对象 | 154 Mesh / 27 InstancedMesh / 1,017 实例 / 3 Points / 4 Lines | 场景统计 |
| RAG 检索延迟 | 均值 **8.39ms** · 中位 8.07ms · P95 12.05ms（20 次采样） | 真实耗时 |
| 脱敏吞吐 | **11,264 条/秒**（100 条/批 × 5） | 真实耗时 |
| 端侧分类延迟 | 均值 0.12ms（21 条） | builtin (fallback)，非神经网络推理 |
| 首屏 JS | 路由 107 kB · First Load 194 kB · 共享 87.5 kB | next build 输出 |
| FPS（软件光栅化） | 均值 4.75 · 中位 5.00 · P95 6.00（20 次采样） | **不作为性能证据** |
| 帧时间（软件光栅化） | 均值 280.78ms · P95 892.40ms | **不作为性能证据** |
| 视口休眠 | 前台 `always` → 后台 `demand`，已验证生效 | 行为验证 |

| RAG 召回方案（真实评测） | Recall@1 | Recall@3 | MRR@5 | NDCG@5 |
|---|---|---|---|---|
| 两路 RRF（现行） | 88.9% | 94.4% | 0.927 | 0.918 |
| 三路 RRF（+MiniLM 句向量） | 94.4% | 100.0% | 0.976 | 0.979 |
| 增益（三路 − 两路） | +5.6pp | +5.6pp | +0.049 | +0.060 |
| bm25-only（消融） | 91.7% | 100.0% | 0.963 | 0.970 |
| lexical-only（消融） | 91.7% | 100.0% | 0.963 | 0.970 |
| 负例拒答率（两路 / 三路） | 100.0% | 100.0% | — | — |
| 误拒率（两路 / 三路，目标 <5%） | 2.4% | 0.0% | — | — |
| 检索延迟 P95（两路 / 三路） | 1.40ms | 2.06ms | — | — |

> RAG 评测：49 条用例（正例 41 / 负例 8），两次运行指标一致=是；三路查询向量 49 条。
<!-- METRICS:END -->

### 2.5 实用性

覆盖真实 K8s 五大类高频故障：**内存/OOM、崩溃循环、CPU 节流、网络分区、控制面异常**。12 篇手册均含真实内核/Cgroup/CNI 根因机理与可执行 SOP，非泛泛而谈。

### 2.6 用户体验

- 首屏 3 秒内建立"三机架 + 中央晶核 + 地面星环"的空间认知
- AI 回答不是纯文本，而是**可交互的生成式 UI 卡片**
- 全键盘可用：`Ctrl+K` 命令面板、`Esc` 分级退出栈
- 端侧审计面板提供"原始 vs 脱敏"一键对比

### 2.7 社会价值与商业潜力

- **降低门槛**：中小企业往往没有专职 K8s 运维，本系统把专家排障经验固化为可检索、可执行的 Agent
- **合规价值**：端侧脱敏满足金融/政务"数据不出内网"的信创要求
- **商业模式**：SaaS 订阅（按集群数计费）+ 私有化部署授权 + 开源社区版

---

## 三、3 分钟核心功能交互演练路径（唯一版）

> 本表是完整端到端交互主链路的推荐操作顺序；按钮文案来自真实 UI 抓取（headless Edge + CDP），与代码严格一致；
> 建议每步操作后停留 1.5–2 秒观察遥测脉冲与状态变化。

| 时间 | 操作（真实 UI 文案） | 期望画面 | 讲解要点（约字数） | 证明点 |
|---|---|---|---|---|
| 0:00–0:10 | 首屏静止，不操作 | 三机架 + 中央晶体 + 遥测在跑 | 「12 篇 SRE 手册、毫秒级检索、0 个 any、0 个外部 3D 模型。今天只跑一条从告警到复盘的链路。」（约 56 字） | 数字钩子；指标见 §六 |
| 0:10–0:30 | 点 worker-beta 机架内的 Pod 刀片 | 相机飞跃锁定 worker-beta，探针卡展开真实指标 | 「我点的不是表格行，是空间里的刀片；相机自己飞过去。空间位置和数据索引是同一个对象。」（约 62 字） | 空间=索引 |
| 0:30–0:45 | **Ctrl+K** → 输入 `beta` → **Enter** | 命令面板过滤并直达 worker-beta | 「键盘也是第一等公民：Ctrl+K，输 beta，回车。」（约 26 字） | 命令面板 Enter 执行 |
| 0:45–1:00 | 点 **「故障演练」** → 点 **「A · POD_OOM_SWARM · 内存溢出雪崩」** 卡片 | 顶栏变 **「演练中：OOM 风暴」**；机架红色脉冲 | 「点卡片就是注入，没有第二个确认按钮；故障是空间里的脉冲，不是一行日志。」（约 70 字） | 演练中 banner + 3D 脉冲 |
| 1:00–1:30 | 点相机图标（aria **「3D 视口多模态快照诊断」**） | 四阶段思考链 + 三张卡水合；**主动指「推理引擎」行** | 「相机截当前 3D 帧唤醒 Copilot：意图、多模态、RAG、工具。注意『推理引擎』这行：显示本地确定性容灾引擎不是坏了，是自动切离线仿真器。」（约 110 字） | 多模态 + 可解释 + 诚实标注 |
| 1:30–1:45 | 点 **「立即执行自愈方案」**（OOM 非高危，无复选框） | Pod 转绿 + 回执（kubectl 等价命令 + 审计摘要） | 「自愈永远要人点。OOM 重启不是高危；高危动作才会出现『我已知晓…』勾选，未勾选时按钮是『需二次确认』且不可点。」（约 90 字） | HITL + 回执可核对 |
| 1:45–2:05 | 点 **「RAG 知识库」** → 输入 `容器内存爆了 exit 137` → Enter | top-3：**90% / 76% / 73%**，并显示 Vector/BM25/Context 占比 | 「我没写 OOMKilled，只写『容器内存爆了 exit 137』；三条命中标了每路证据占比。」（约 65 字） | 真实检索 UI |
| 2:05–2:10 | 输入 `今天天气怎么样` → Enter | **「未命中任何 Runbook（查询缺乏区分度）」** | 「未命中就是未命中，不编。」（约 14 字） | 拒答可复现 |
| 2:10–2:25 | 页签 **「端侧日志审计」** → 预设 **「数据库连接串泄露」** → **「抓取并审计日志流」** | 脱敏前后对照 + 敏感类型计数 + 语义标签占比 | 「原始凭证不进模型：端侧先脱敏再分类；WebGPU 不可用会自动降级，页面写明当前引擎。」（约 80 字） | 零出域 + 降级可见 |
| 2:25–2:40 | 点 **「复盘报告」** | 「SRE 故障复盘报告」预览/源码/复制/下载 | 「推理链、RAG 引用、动作回执一键生成可归档复盘。」（约 48 字） | 可归档 |
| 2:40–3:00 | 按 **Esc** 逐层退出回全景 | 三机架全景 | 「看得见、说得清、管得住。」（约 58 字） | 三动词收尾 |

## 四、核心亮点

### 4.1 3D 空间态势感知

24 个 Pod、3 个 Worker 机架、1 个控制平面以程序化 3D 场景实时呈现。故障不是一行日志，而是**空间里的红色脉冲**——机架底部扩散警示波纹、Pod 实例剧烈红光抖动、网络流量变红卡顿、地面拓扑电路切换绯红。

**批量渲染优化**：场景 **154 个 Mesh / 27 个 InstancedMesh / 1,017 个实例**，全场景实测 **235 draw calls**（`docs/performance.json`，2026-11-14 采集）。实例合并把逐实例绘制压成少量 draw call。

**电影级材质与光影**：

| 技术 | 实现 | 效果 |
|---|---|---|
| **霓虹晶块** | `onBeforeCompile` 向 `meshStandardMaterial` 注入棱边掩码 + 菲涅尔 + 内芯项 | Pod 呈现"半透明果冻内芯 + 高亮棱边"的晶体质感，仍是 1 次 draw call |
| **程序化 PBR 环境** | `RoomEnvironment` + `PMREMGenerator` 生成环境贴图，零外部 `.hdr` 请求 | 机柜立柱获得工业级冷金属镜面高光 |
| **等离子星核** | 自定义 GLSL：视线-法线夹角余弦做径向衰减 + `uPulse` 心跳 | 中心极亮、边缘透明，告别"死白硬边圆片" |
| **全息数据星城** | 1,400 颗极坐标成簇粒子 + 160 段电路连线，各占 1 次 draw call | 地面从"死黑"变为发光数字母板 |
| **数字矩阵雨** | 纵深圆柱内壁 + 680 列 GLSL 光丝，`sin` 包络上下渐隐 | 深空背景的垂直数据流，不干扰前景 |

### 4.2 双引擎 AI 副驾驶

| 引擎 | 触发条件 | 能力 |
|---|---|---|
| **引擎 A**（真实大模型） | 配置 API Key | 接入任意 OpenAI 兼容服务商（智谱 GLM-4-Flash / DeepSeek / 通义千问 / GPT-4o-mini），支持多模态图像输入 |
| **引擎 B**（确定性仿真器） | 无 Key 或调用失败 | 基于**真实集群数据**生成专业诊断报告，全功能可用 |

**零 Key 也能完整演示**——这是刻意的离线优先设计：离线或受限网络下额度与连接不可控，引擎 B 保证任何环境下都能跑通全部能力。引擎 B 读取的是真实 Pod 指标与真实 RAG 命中结果，只仿真"表达方式"，不伪造观测事实。

### 4.3 混合 RAG 检索引擎

**12 篇**权威 Kubernetes SRE 排障手册（OOM/Cgroup、CrashLoopBackOff、CFS 节流、QoS 驱逐、CNI/VXLAN、调度失败、DNS、镜像拉取、etcd 仲裁、**APF 限流**、**ImagePullBackOff**），每条含特征词袋、根因机理与标准 SOP。

**三路混合检索 + RRF 融合**：

```
语料库级 IDF 预计算
  ├─ 稀疏路：Okapi BM25（k₁=1.5, b=0.75）—— 让 oom_score_adj / vxlan 等高区分度术语权重远高于通用词
  ├─ 稠密路：TF-IDF 加权向量余弦 —— 衡量整体语义方向一致性
  └─ 先验路：故障场景 / 受影响 Pod 上下文加权
        ↓
  RRF 倒数秩融合（只用名次，免疫量纲差异）
        ↓
  Sigmoid 分段置信度校准：强匹配 0.82~0.97 / 中等 0.58~0.81 / 弱相关 0.35~0.57
```

**防幻觉机制**：查询 IDF 质量闸门（无区分度直接返回空）+ 语义证据闸门（零分文档不进入排名池）。实测"你好"、"今天天气不错"均正确返回**零命中**，而非虚假高分。

实测：4 类故障场景全部命中正确手册，RAG 引擎平均检索延迟 **8.39ms**（P95 12.05ms，`docs/performance.json`）。

### 4.4 端侧隐私零出域

日志在离开浏览器之前完成脱敏。6 条有序规则覆盖：

| 类型 | 示例 | 替换为 |
|---|---|---|
| URL 内嵌凭证 | `postgres://admin:pwd@db:5432` | `[REDACTED_CREDENTIAL]` |
| 密码字段 | `db_password=xxx` | `[REDACTED_PASSWORD]` |
| 云厂商密钥 | AWS `AKIA...` / 阿里云 `LTAI...` / 腾讯云 `AKID...` | `[MASKED_KEY]` |
| JWT / Bearer | `eyJhbGci...` | `[MASKED_TOKEN]` |
| IPv4（含端口） | `10.244.1.15:6379` | `[REDACTED_IP]` |
| 邮箱 | `alice@example.com` | `[REDACTED_EMAIL]` |

脱敏后文本才允许送入模型。**实测吞吐 11,264 条/秒**（100 条/批，`docs/performance.json`）。

端侧推理运行在独立 Web Worker 中（Transformers.js v3 + WebGPU/WASM），主线程零阻塞。模型以 `all-MiniLM-L6-v2` 输出 **384 维句向量**，与 4 类语义原型锚点做余弦比对，再与领域特征词先验加权融合（0.68 神经 / 0.32 符号）。

### 4.5 生成式 UI 水合

AI 不只是回文字，而是**动态挂载可交互组件**：

- **AgentThoughtChain** — 可折叠的思考链时间轴
- **GenUISkeleton** — 工具调用期间的青色流光骨架屏
- **PodMetricsCard** — 双轨渐变进度条 + SVG 面积折线，点击 Pod 名联动 3D 相机
- **RootCauseAlert** — P0/P1 徽标 + 证据链 + 可展开的 RAG 溯源
- **ActionConfirm** — 高危二次确认 + 流光执行动画 + 一键自愈

---

## 五、快速开始

### 环境要求

- Node.js >= 22.13.0（推荐 Node 24 LTS，仓库已附 [`.nvmrc`](.nvmrc)）
- pnpm（本项目使用 pnpm 11.8）

### 安装与运行

```bash
pnpm install
pnpm dev
```

打开 http://localhost:3000 即可使用。**无需任何 API Key**。

### 配置真实大模型（可选）

```bash
cp .env.example .env.local
```

编辑 `.env.local`，填入任意 OpenAI 兼容服务商：

```bash
# 智谱 AI（推荐，glm-4-flash 有免费额度）
OPENAI_API_KEY=your-zhipu-api-key
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
AI_MODEL_NAME=glm-4-flash
```

重启 `pnpm dev` 生效。不配置也能完整运行（走引擎 B）。

`.env.example` 内含智谱、DeepSeek、通义千问、OpenAI 四家配置模板与排障提示。

---

## 六、验证与数据

### 一键验收回归

```bash
node scripts/verify.mjs
```

自动完成 <!-- VERIFY:BEGIN -->**通过 35 · 失败 0 · 跳过 0（共 35 项）**<!-- VERIFY:END -->，覆盖静态检查、核心算法、API 契约与浏览器端 E2E：

```
阶段 1 · 静态检查         tsc / ESLint / GLSL / 死导出 / 禁 any 扫描
阶段 2 · 核心算法单元校验  脱敏器 9 类敏感信息 / RAG 召回与真实消融 / 回执摘要与幂等防越权
阶段 3 · API 契约         SSE 推送 / NDJSON 流 / 推理链 / 卡片载荷 / capabilities 探测
阶段 4 · 浏览器端 E2E     3D 场景 / 相机联动 / 思考链 / 三张卡片 / 自愈 / 端侧审计
```

### 性能与评测基准快照（Controlled Benchmark Archive）

> **受控基准说明（口径披露）**：下方性能表格保留 `2026-11-14` 同一台测试机上的采集快照（原始数据归档于 [`docs/performance.json`](docs/performance.json) 与 [`docs/performance.md`](docs/performance.md)；历史采集与同步辅助脚本已从提交精简版移除，可复现的活跃校验脚本清单见 [`docs/SCRIPTS_INDEX.md`](docs/SCRIPTS_INDEX.md)）。其中 RAG 与 AI 评测均属于**受控确定性评测基准（Controlled Deterministic Benchmark）**，样本量与局限详见 [`docs/rag-eval.md`](docs/rag-eval.md) 与 [`docs/ai-quality.md`](docs/ai-quality.md)。
>
> **FPS 与帧时间严格不作为性能证据**：3D 场景在 SwiftShader 软件光栅化（无 GPU 加速）下运行，
> 数值被软件光栅化严重压低，与真实显卡无可比性。可作证据的是：
> ① 硬件无关指标（Draw Calls / Triangles / 场景对象数）；
> ② 真实耗时（RAG 检索、脱敏吞吐、端侧分类）；
> ③ 构建产物（首屏 JS 体积）。

<!-- METRICS:BEGIN -->
| 指标 | 实测值 | 采集口径 / 是否可作性能证据 |
|---|---|---|
| 数据采集时间 | 2026-11-14 19:09（Asia/Shanghai） | 历史受控基准快照（数据归档于 `docs/performance.json`） |
| 运行环境 | win32 x64 · AMD Ryzen 9 7845HX with Radeon Graphics · 31GB RAM · Node v24.16.0 · 24 核 | 同上 |
| WebGL 渲染器 | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) | 软件光栅化，**FPS 不作为性能证据** |
| Draw Calls | **235**（20 次采样 235~238） | 硬件无关，可作渲染优化证据 |
| Triangles | 206,626（中位） | 硬件无关 |
| 场景对象 | 154 Mesh / 27 InstancedMesh / 1,017 实例 / 3 Points / 4 Lines | 场景统计 |
| RAG 检索延迟 | 均值 **8.39ms** · 中位 8.07ms · P95 12.05ms（20 次采样） | 真实耗时 |
| 脱敏吞吐 | **11,264 条/秒**（100 条/批 × 5） | 真实耗时 |
| 端侧分类延迟 | 均值 0.12ms（21 条） | builtin (fallback)，非神经网络推理 |
| 首屏 JS | 路由 107 kB · First Load 194 kB · 共享 87.5 kB | next build 输出 |
| FPS（软件光栅化） | 均值 4.75 · 中位 5.00 · P95 6.00（20 次采样） | **不作为性能证据** |
| 帧时间（软件光栅化） | 均值 280.78ms · P95 892.40ms | **不作为性能证据** |
| 视口休眠 | 前台 `always` → 后台 `demand`，已验证生效 | 行为验证 |

| RAG 召回方案（真实评测） | Recall@1 | Recall@3 | MRR@5 | NDCG@5 |
|---|---|---|---|---|
| 两路 RRF（现行） | 88.9% | 94.4% | 0.927 | 0.918 |
| 三路 RRF（+MiniLM 句向量） | 94.4% | 100.0% | 0.976 | 0.979 |
| 增益（三路 − 两路） | +5.6pp | +5.6pp | +0.049 | +0.060 |
| bm25-only（消融） | 91.7% | 100.0% | 0.963 | 0.970 |
| lexical-only（消融） | 91.7% | 100.0% | 0.963 | 0.970 |
| 负例拒答率（两路 / 三路） | 100.0% | 100.0% | — | — |
| 误拒率（两路 / 三路，目标 <5%） | 2.4% | 0.0% | — | — |
| 检索延迟 P95（两路 / 三路） | 1.40ms | 2.06ms | — | — |

> RAG 评测：49 条用例（正例 41 / 负例 8），两次运行指标一致=是；三路查询向量 49 条。
<!-- METRICS:END -->

> 证据归档：[`docs/EVIDENCE.md`](docs/EVIDENCE.md)（可复现校验命令索引）、[`docs/performance.json`](docs/performance.json)（原始数据）、
> [`docs/performance.md`](docs/performance.md)（可读报告）、[`docs/SECURITY_ADVISORY.md`](docs/SECURITY_ADVISORY.md)（依赖与 CVE 治理）。

---

## 七、技术架构

### 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js 14.2.18 (App Router) + React 18.3.1 + TypeScript 5.6 |
| 3D | three r169 + @react-three/fiber 8.17.10 + @react-three/drei 9.114.3 |
| 状态 | zustand 4.5.7（双轨架构） |
| AI SDK | Vercel AI SDK 3.4.33 + zod 3.25 |
| 端侧推理 | @huggingface/transformers 3.1.2（WebGPU / WASM） |
| 样式 | Tailwind CSS 3.4.17 |

### 双轨状态架构

这是整个系统性能的基石：

```
轨道一 · 瞬态轨（useTelemetryRef）
  模块级可变单例 + Float32Array
  高频遥测（1Hz 快照 × 目标 60FPS 插值）绕过 React 协调器直达 useFrame
  零组件重渲染

轨道二 · 响应轨（useClusterStore）
  zustand persist Store
  仅承载低频 UI 状态（选中态、面板开关、终端日志）
  React 订阅重渲染
```

两轨以「快照引用」为唯一交汇点，互不越界。

### 核心目录

```
src/
├─ app/
│  ├─ page.tsx                  首页（动态懒加载 3D + Copilot + HUD）
│  └─ api/
│     ├─ chat/route.ts          双引擎 NDJSON 流式对话
│     ├─ telemetry/route.ts     SSE 遥测流
│     └─ verify/                验收脚本用的纯计算校验端点
├─ components/
│  ├─ canvas/                   R3F 场景（机架/Pod/网络流/波纹/相机/全息 HUD）
│  ├─ ai/
│  │  ├─ CopilotDrawer.tsx      右侧副驾驶主面板
│  │  ├─ LocalAuditorPanel.tsx  端侧隐私审计台
│  │  ├─ RagKnowledgeModal.tsx  RAG 知识库检视与检索沙盒
│  │  ├─ PostMortemModal.tsx    SRE 复盘报告预览与导出
│  │  └─ GenUI/                 5 个生成式 UI 组件
│  ├─ hud/                      巡检 HUD / 混沌控制台 / 性能遥测
│  └─ layout/                   外壳 / 顶栏 / 终端
├─ hooks/                       遥测流 / 端侧分类器 / 视口休眠 / 语音
├─ store/                       双轨状态
├─ types/                       严格类型契约
├─ utils/                       RAG 引擎 / 仿真引擎 / 脱敏器 / 空间布局 / 复盘报告
└─ workers/                     端侧日志分类 Worker
```

### 工程契约

本项目遵循 [AGENTS.md](AGENTS.md) 的严格工程标准：

- 禁止 `any` / `@ts-ignore`
- `useFrame` 内禁止 `new THREE.*`（防 GC 卡顿）
- `InstancedMesh` 基材质固定 `#ffffff` + `toneMapped={false}`
- 重型组件一律 `next/dynamic` 懒加载
- 核心算法必须有中文原理注释

---

### 7.6 HTTP API 清单

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/chat` | POST | 双擎 NDJSON 流式对话（意图 → RAG → 多模态 → MCP 工具卡片） |
| `/api/telemetry` | GET | SSE 遥测流（1Hz 合成集群快照 / 真实 K8s 或宿主机采样） |
| `/api/health` | GET | 运行态健康诊断与五层降级矩阵只读快照（零敏感凭据暴露） |
| `/api/logs/live` | GET | 采集 K8s 或宿主机运行时原始日志（返回未脱敏 `rawLog` 供浏览器端侧 PII 正则脱敏与 WebWorker 审计） |
| `/api/mcp` | POST / GET | MCP JSON-RPC 2.0 端点（`POST` 支持 `initialize` / `tools/list` / `tools/call` / `ping`；`GET` 返回只读工具清单） |
| `/api/mcp/execute` | POST / GET | MCP 工具执行与幂等回执查询（写操作需前端 HITL 二次确认；`GET` 支持按 `clientRequestId` 查询回执账本） |
| `/api/verify/rag` | POST | RAG 检索契约验证（评测/CI 用） |
| `/api/verify/sanitize` | POST | 脱敏契约验证（评测/CI 用） |

> 流式响应由路由自身返回 `Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no` 等头；
> [`vercel.json`](vercel.json) 亦已补充 `/api/*` 禁缓存流式头与 `/models/*` 静态模型长缓存头，确保直连与边缘网关双保险不缓冲 SSE/NDJSON。

## 八、交互指南

### 键盘快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl / ⌘ + K` | 唤起全局运维命令面板（搜索 Pod / 节点、触发动作、切换面板） |
| `Shift + P` | 呼出 / 隐藏性能遥测 HUD |
| `Esc` | 逐级退出：命令面板 → 混沌演练弹窗 → 性能 HUD → 取消 3D 选中并复位视角 |
| `↑ / ↓` | 命令面板内移动高亮项 |
| `Enter` | 命令面板内执行当前高亮项 |

> `Esc` 采用**分级退出栈**而非各面板各自监听——多组件同时抢 `Esc` 会导致
> 一次按键关掉多层界面。集中在一处按优先级处理，保证"一次只退一层"。

### 5 分钟加长版（在 3 分钟主链路上插入 4 段）

> 时间不够时按「RAG 详解 → 端侧 → 复盘」顺序压缩回 2:10。

| 插入点 | 时长 | 操作（真实文案） | 讲解要点 | 证据 |
|---|---|---|---|---|
| 0:45 后 | +30s | 点 **「性能」**（Shift+P） | 「154 mesh、27 个 InstancedMesh 承载 1,017 实例，全场 235 draw calls」 | docs/performance.json |
| 1:30 后 | +35s | 指 3D 画面与 HUD | 「遥测 1Hz，渲染插值在跑；1Hz 快照走瞬态引用，不进 React state，零组件重渲染」 | 双轨状态架构 |
| 2:05 后 | +45s | 停网关/断网 → 发问题 | 「几秒内切本地确定性容灾引擎（本次实测约 6.7s），是离线优先不是故障」 | trace-summary |
| 2:25 后 | +40s | **「RAG 知识库」** → **「新增自定义 Runbook」** → 填表 → **「提交入库」** | 「现场新增手册，入库后立即参与混合检索；提示『已写入语料池并选中』」 | RagKnowledgeModal |

## 九、文档

| 文档 | 内容 |
|---|---|
| [启动说明.md](启动说明.md) | **快速复现启动指南（无 Key 可跑）** |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署（本机/Docker/Vercel/离线）与 SSE 注意 |
| [docs/EVIDENCE.md](docs/EVIDENCE.md) | **证据链索引（证据 → 结论 → 复现命令）** |
| [docs/SECURITY_ADVISORY.md](docs/SECURITY_ADVISORY.md) | **依赖锁定策略与 CVE 安全处置声明** |
| [docs/SCRIPTS_INDEX.md](docs/SCRIPTS_INDEX.md) | **自动化验证与单元测试脚本索引** |
| [docs/BUSINESS_CASE.md](docs/BUSINESS_CASE.md) | 商业价值页（数字均标注假设） |
| [docs/SUBMISSION_CHECKLIST.md](docs/SUBMISSION_CHECKLIST.md) | 工程发布清单 + 上线前检查表 |
| [AGENTS.md](AGENTS.md) | 工程契约与编码标准 |
| [docs/performance.md](docs/performance.md) | 性能实测报告 |
| [docs/3d-memory-audit.md](docs/3d-memory-audit.md) | 3D 组件内存泄漏巡检 |
| [.env.example](.env.example) | 环境变量配置模板 |

---

## 自动演练（剧本路演）

- **定位**：兜底与加分项，不是主路径。主路径是上面 3 分钟手动链路；现场网络/嗓子/时间不可控时用它。
- **入口**：顶栏 **「剧本路演」** → 菜单选 **「OOM 全链路自愈约 34 秒 · 4 阶段」**（另有 CNI、节点 CPU 两个剧本）。
- **序列器**：字幕条 aria **「自动演练序列器」**，阶段徽标依次为
  `阶段 1/4 · 全景稳态巡航` → `阶段 2/4 · 故障注入与空间锁定` → `阶段 3/4 · RAG 混合检索与多卡诊断` → `阶段 4/4 · MCP 闭环自愈`；
  控制按钮 aria：重播 / 收起字幕条 / 暂停（继续）/ 停止并复位集群。
- **旁白与 TTS**：路演旁白以字幕文字呈现，现场讲解由主讲完成，不依赖 TTS；Copilot 的语音播报开关独立控制。
- **兜底**：启动前自检 5 项（3D 视口 / store / Copilot 抽屉 / SSE 非 fallback / WebGL 上下文）；失败时字幕显示
  **「DEMO-PREFLIGHT · 未通过」**，不要重试，切回手动链路。

## 已知局限与数据边界

> 本作品不声称超出以下边界的能力；所有性能/质量数字附采集环境，详见 §六。

| # | 局限 | 现状 | 影响 |
|---|---|---|---|
| 1 | **默认无真实 K8s 集群写权限** | 默认使用确定性仿真引擎；即使接入 `K8S_API_SERVER`，写操作受 `K8S_ALLOW_REAL_WRITE=true`（默认 `false`）硬隔离，`live` 模式拒绝暗中回落 | 默认不修改真实生产集群；`scale_deployment` 限制整数 `[1, 50]`，`drain_node` 当前仅执行 Cordon（`spec.unschedulable=true`） |
| 2 | **FPS 未在真实 GPU 采集** | 本机 SwiftShader，FPS 均值 4.75 / 中位 5（不作性能证据） | 不宣称 60FPS；只讲 Draw Calls/Triangles |
| 3 | **端侧模型降级** | 无 WebGPU 或权重超时时自动退回带否定词消除的 builtin fallback，并在 UI 标明 `内置 (builtin-fallback)` | `0.12ms` 非神经网络推理延迟；真机 WebGPU 仍视宿主硬件而定 |
| 4 | **MCP transport** | JSON-RPC 2.0 over HTTP（`/api/mcp`），支持可选 `MCP_ADMIN_TOKEN` 与同源校验，非 stdio | 未与官方 CLI/SDK 做 stdio 互通验证 |
| 5 | **无 Key 走引擎 B** | 无 API Key/网关不可用时自动回落确定性引擎（含多假设交叉验证思维链与真实遥测锚定） | 回落实测约 6.7s（含重试），不是瞬时 |
| 6 | **浏览器端三路召回** | Worker `requestId` 并发关联、引擎消融开关与 `queryEmbedding` 已实现并有单元测试 | Worker 未就绪或超时自动退回两路 RRF |
| 7 | **多步只读工具** | 代码已实现 `maxSteps:3`，但受控离线评测中 LLM 回落未触发多轮云端工具 | 不作为已线上大规模压测能力宣传 |
| 8 | **商业数据** | 无真实客户/营收/市场报告 | 商业页数字全部标注"假设/估算" |

## 十、设计取舍记录

一些刻意的决策，记录在此以免后人误改：

**为什么 3D 组件不手动 dispose？**
所有几何体与材质都是 JSX 声明式创建，R3F 会自动管理生命周期。手动 dispose 反而有重复释放风险。实测 4 次完整销毁重挂载，几何体数恒定，零泄漏。详见内存巡检报告。

**为什么几何体有重复实例不合并？**
改共享实例会在 React 18 StrictMode 双挂载下出现"一方 dispose、另一方仍持有"的 bug——用微小内存换正确性。

**为什么引擎 B 不叫"降级"？**
它不是残次品，而是**离线优先的正式路径**。基于真实集群数据的确定性推理，在无网络、无额度、受限弱网时保证系统可用。

**为什么注入检测只警告不阻断？**
「请忽略那条误报告警」在运维对话里可能完全合法。硬性拦截会妨碍正常工作流，真正的防线在服务端 System Prompt。

**为什么 RAG 分数不再是固定高分？**
早期实现把所有结果映射到 `[0.86, 0.98]`，该区间不携带信息量——审阅者问一句"为什么永远是 96%"即可击穿可信度。现行方案用 Sigmoid 分段校准，分数真实反映证据强弱，且无关查询会如实返回零命中。

---

## 十一、核心长文件精确导读地图（M22）

为便于开发者与审阅者快速定位核心逻辑，以下给出代码库五大核心文件的结构与关键行号段导航（行号与符号均与当前源码同步）：

| 核心文件 | 总行数 | 关键区块与精确行号定位 |
| :--- | :--- | :--- |
| [CopilotDrawer.tsx](src/components/ai/CopilotDrawer.tsx) | 4232 行 | `L156` `LocalAuditorPanel` 异步容错懒加载 · `L338` `isRootCauseTool` / GenUI 双命名映射 · `L381` `validatePrompt` 输入安全校验 · `L421` `ContextPill` 实体上下文胶囊 · `L907` `ProactiveAnomalyBanner` 主动异常横幅 · `L1570` 主组件（`L2569` `sanitizeRawLog` Canary Guard 外发脱敏、`L2873` `createNdjsonLineParser` 流式解析、`L3126` 视口截图与 `ViewportCaptureMeta`） |
| [route.ts (Chat API)](src/app/api/chat/route.ts) | 4104 行 | `L83` `force-dynamic` / `nodejs` / `maxDuration=60` · `L330` `createStreamTextGuard` 零 TTFT 流式文本守卫 · `L810` `buildSystemPrompt` RAG 知识注入 · `L1399` `streamWithLLM`（含三工具 Zod Schema） · `L2967` `parseRequestBody`（含 `user` 消息服务端兜底脱敏） · `L3189` `checkChatRateWindow` 滑动窗口限流守卫与 `L3212` `POST` 主入口 |
| [demoDirector.ts](src/utils/demoDirector.ts) | 2841 行 | `L130` `DemoDirectorSnapshot` 状态契约 · `L539` `DEMO_SCRIPTS` 三套自动演练剧本 · `L903` `clearAllTimers` 定时器集中清理 · `L1068` P0-1~P0-3 动态受灾目标自愈阶段动作 |
| [WorkerRack3D.tsx](src/components/canvas/WorkerRack3D.tsx) | 2605 行 | `L111–L206` 预分配 `THREE.Color` 常量（`useFrame` 零 GC） · `L460` 三类装饰件 `InstancedMesh` 容量与批量渲染 · `L605` GLSL 景深雾衰减着色器 |
| [ClusterCanvas.tsx](src/components/canvas/ClusterCanvas.tsx) | 1996 行 | `L169` `ClusterPostProcessing` 异步分片容错懒加载 · `L296` `RENDER_QUALITY_TIER` 画质档位解析 · `L772` 主体（含 `webglcontextlost` 卸载后处理与 `<=3` 次自动恢复状态机） · `L1294` `ClusterTopology2DFallback` 无 WebGL 2D 降级拓扑 |

---

## 十二、三大可验证工程命题与架构边界（M24）

本项目不以封装通用 LLM 对话框为定位，而是围绕「可信 AI 运维测试、可验证控制闭环、端云协同与渲染稳定性」提出三项可运行脚本直接验证的核心工程命题（第三方能力与项目自研贡献边界详表亦见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）：

| 工程命题 | 自研设计与实现范围 | 复用的第三方能力边界 | 可验证命令 / 契约脚本 |
| :--- | :--- | :--- | :--- |
| **1. 双态互证混合 RAG 检索引擎与零泄漏基准** | 自研三通道加权融合（Semantic + BM25 + Telemetry Keyword）、Sigmoid 证据支持度校准、`activeChaos='NONE'` 无标签泄漏评估与多假说交叉核验链路 | 离线稠密向量由 `bge-small-zh-v1.5` 预生成静态特征表；底层推理依赖 ONNX/Transformers 运行时 | `pnpm verify:rag`、`pnpm test:chat-stream` |
| **2. 受控自愈回执链与多域安全脱敏守卫** | 自研 MCP JSON-RPC 工具执行器、HMAC-SHA256 防篡改回执摘要、`confirmation` 参数一致性/幂等校验、双端 `sanitizeRawLog` 多规则脱敏及 60s 滑动窗口限流 | 加密原语基于 Node.js 内置 `crypto` 模块；云端语义推断对接 DeepSeek-V3 / OpenAI 兼容接口（可降级本地模拟器） | `pnpm verify:receipt`、`pnpm verify:sanitizer`、`pnpm test:demo:fast` |
| **3. 60 FPS WebGL 零 GC 机柜拓扑与 WebGPU/WASM 边缘日志审计** | 自研 `InstancedMesh` 预分配渲染循环、GLSL 自定义雾衰减着色器、WebGL `contextlost` 2D 自动降级/恢复状态机、Worker 消息 `requestId` 去重与混合特征日志审计 | 3D 底层基于 `three` 与 `@react-three/fiber` / `@react-three/drei`；端侧推理基于 `@huggingface/transformers`（浏览器无 WebGPU 时诚实回落 `builtin` 引擎） | `pnpm lint:glsl`、`pnpm verify:telemetry`、`pnpm verify:parity`、`pnpm check:style-contract -- --require-build` |

---

## License

本项目以 **MIT** 开源许可证发布，完整条款见 [LICENSE](LICENSE)。第三方运行时依赖与端侧模型许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
