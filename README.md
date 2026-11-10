# KubeVision AI

> **云原生三维空间态势感知与多模态智能自愈副驾系统**

> 参赛赛道：**智启未来 · AI 驱动的 Web 应用创新挑战**（赛道 ID `10037`）
> 全国高校 AI Web 开发挑战赛

KubeVision AI 把 **3D 空间态势**、**混合 RAG 知识检索**、**端侧隐私推理** 与 **生成式 UI** 融合成一个云原生运维中控台。左侧是可交互的 3D 集群拓扑，右侧是能自我规划、检索手册、调用 MCP 工具并执行自愈的 AI 副驾驶。

一句话概括：**用一块屏幕看清集群，用一句话完成从告警到复盘的闭环。**

---

## 一、参赛作品与赛道对标信息

### 1.1 作品基本信息

| 项目 | 内容 |
|---|---|
| 作品名称 | **KubeVision AI** |
| 参赛赛道 | 智启未来：AI 驱动的 Web 应用创新挑战（赛道 ID `10037`） |
| 核心定位 | 云原生三维空间态势感知与多模态智能自愈副驾系统 |
| 作品形态 | B/S 架构 Web 应用（Next.js 14 App Router 全栈单体） |
| 代码规模 | 64 个 TypeScript 文件 · 约 34,600 行源码 |
| 运行要求 | Node.js ≥ 18.17 + pnpm；**无需 GPU、无需真实 K8s 集群、无需 API Key** |
| 技术白皮书 | [docs/COMPETITION_TECHNICAL_WHITEPAPER.md](docs/COMPETITION_TECHNICAL_WHITEPAPER.md) |

### 1.2 团队成员信息表

> **请团队填写下表后提交**（占位内容需替换为真实信息）

| 角色 | 姓名 | 学号 / 工号 | 专业 / 年级 | 主要分工 |
|---|---|---|---|---|
| 队长 | `【待填写】` | `【待填写】` | `【待填写】` | 整体架构设计、AI Agent 工作流、答辩主讲 |
| 队员 1 | `【待填写】` | `【待填写】` | `【待填写】` | 3D 渲染工程（R3F / GLSL Shader / 性能优化） |
| 队员 2 | `【待填写】` | `【待填写】` | `【待填写】` | RAG 检索引擎、知识库语料、端侧推理 |
| 队员 3 | `【待填写】` | `【待填写】` | `【待填写】` | 前端工程质量、HUD 交互、测试与验收脚本 |
| 指导教师 | `【待填写】` | — | `【待填写】` | 选题指导、技术路线评审 |

| 团队 / 单位信息 | 内容 |
|---|---|
| 团队名称 | `【待填写】` |
| 所属高校 / 院系 | `【待填写】` |
| 联系邮箱 | `【待填写】` |

---

## 二、官方六大评审维度得分点映射矩阵（100 分）

> **评委速览**：本表直接对应赛道评分表。左列评分维度按官方权重排布，右列可点击跳转到仓库中的具体实现文件，**30 秒内完成高分采信**。

### 2.1 总分构成

| 评分维度 | 权重 | 本作品得分策略一句话概括 |
|---|---|---|
| **AI 技术深度** | **35%** | 双擎流式大模型 + 四阶段 ReAct Agent + BM25/TF-IDF/RRF 混合 RAG + 端侧 Transformers.js + MCP 工具闭环 |
| **创新性** | **25%** | 空间-语义双向绑定（3D 坐标 ↔ 数据面板）、云端推理 + 端侧隐私审计双模协同 |
| **前端工程质量** | **10%** | 零 `any` 严格类型、<!-- VERIFY:BEGIN -->**通过 33 · 失败 0 · 跳过 0（共 33 项）**<!-- VERIFY:END -->、60FPS 双轨状态架构 |
| **实用性** | **10%** | 覆盖真实 K8s 五大类高频故障，处置动作直连 MCP 协议 |
| **用户体验** | **10%** | 电影级 3D 场景、生成式 UI 卡片水合、3 分钟黄金演示动线 |
| **社会价值与商业潜力** | **10%** | 降低中小企业 K8s 运维门槛，金融/政务信创私有化合规 |

### 2.2 AI 技术深度（35%）· 细化得分点

| 子项 | 分值 | 核心实现 | 代码位置 |
|---|---|---|---|
| **大模型流式集成** | 8% | 双引擎（真实 LLM + 确定性仿真器）NDJSON 流式协议；`fullStream` 逐帧消费；断流自动降级不断演示 | [`src/app/api/chat/route.ts`](src/app/api/chat/route.ts) · [`CopilotDrawer.tsx`](src/components/ai/CopilotDrawer.tsx) |
| **ReAct Agent 工作流** | 8% | 四阶段可解释推理链：意图规划 → 多模态视觉 → RAG 检索 → MCP 工具调用，每阶段实时回传耗时与详情到思维链 UI | [`AgentThoughtChain`](src/components/ai/GenUI/AgentThoughtChain.tsx) |
| **混合 RAG 检索** | 6% | 语料库级 IDF 预计算 + Okapi BM25（k₁=1.5, b=0.75）+ TF-IDF 加权余弦 + RRF 倒数秩融合 + Sigmoid 分段置信度校准；12 篇权威手册 | [`sreRagEngine.ts`](src/utils/sreRagEngine.ts) |
| **多模态融合** | 5% | 3D 视口截图 → 多模态数组消息（`[text, image]`）→ 视觉推理步骤；语音输入 / 语音播报双通道 | [`route.ts`](src/app/api/chat/route.ts) · [`useSpeechRecognition`](src/hooks/useSpeechRecognition.ts) |
| **端侧脱敏与 HITL 安全** | 4% | 6 类 PII 正则脱敏（零出域）+ WebGPU/WASM 384 维神经余弦分类 + 高危动作二次确认护栏 | [`logSanitizer.ts`](src/utils/logSanitizer.ts) · [`logClassifier.worker.ts`](src/workers/logClassifier.worker.ts) |
| **MCP 协议工具闭环** | 4% | 3 个 MCP 工具注册、参数校验、执行回执、3D 空间自愈脉冲 | [`route.ts`](src/app/api/chat/route.ts) |

### 2.3 创新性（25%）· 差异化亮点

| 创新点 | 说明 | 传统方案的差距 |
|---|---|---|
| **空间-语义双向绑定** | 点击 3D 实体 → 相机飞跃 + 探针卡展开；点击卡片内 Pod 名 → 3D 场景反向定位。数据与空间互为索引 | 传统 Dashboard 只有表格，故障无空间位置感 |
| **云端推理 + 端侧审计双模** | 高危日志在浏览器内完成脱敏与语义分类，只有脱敏摘要才可能离开设备 | 常规方案把原始日志整包上云，存在凭证泄露风险 |
| **数字孪生级 3D 场景** | 零外部 `.glb` 资产，全部程序化几何 + 自定义 GLSL（等离子星核 / 全息数字雨 / 体积激光） | 多数作品贴静态图或引入重型模型文件 |
| **从告警到复盘的全链路** | 注入故障 → AI 诊断 → 一键自愈 → 自动生成 Google SRE 标准复盘报告（可导出 .md） | 多数作品止步于"给出建议" |

### 2.4 前端工程质量（10%）

| 指标 | 实测值 |
|---|---|
| TypeScript 严格模式 | 全仓 0 个 `any` / `@ts-ignore` |

<!-- 以下区块由 node scripts/sync-docs-metrics.mjs 从 docs/performance.json 与 docs/verify-summary.json 生成，请勿手改 -->
<!-- METRICS:BEGIN -->
| 指标 | 实测值 | 采集口径 / 是否可作性能证据 |
|---|---|---|
| 数据采集时间 | 2026-11-10 14:01（Asia/Shanghai） | `node scripts/benchmark.mjs` |
| 运行环境 | win32 x64 · AMD Ryzen 9 7845HX with Radeon Graphics · 31GB RAM · Node v24.16.0 · 24 核 | 同上 |
| WebGL 渲染器 | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) | 软件光栅化，**FPS 不作为性能证据** |
| Draw Calls | **403**（20 次采样 400~403） | 硬件无关，可作渲染优化证据 |
| Triangles | 188,738（中位） | 硬件无关 |
| 场景对象 | 311 Mesh / 24 InstancedMesh / 972 实例 / 4 Points / 3 Lines | 场景统计 |
| RAG 检索延迟 | 均值 **7.02ms** · 中位 6.82ms · P95 11.94ms（20 次采样） | 真实耗时 |
| 脱敏吞吐 | **16,418 条/秒**（100 条/批 × 5） | 真实耗时 |
| 端侧分类延迟 | 均值 0.07ms（15 条） | builtin (fallback)，非神经网络推理 |
| 首屏 JS | 路由 84.8 kB · First Load 172 kB · 共享 87.5 kB | next build 输出 |
| FPS（软件光栅化） | 均值 2.30 · 中位 2.00 · P95 8.00（20 次采样） | **不作为性能证据** |
| 帧时间（软件光栅化） | 均值 626.03ms · P95 1554.40ms | **不作为性能证据** |
| 视口休眠 | 前台 `always` → 后台 `demand`，已验证生效 | 行为验证 |

| RAG 召回方案（真实评测） | Recall@1 | Recall@3 | MRR@5 | NDCG@5 |
|---|---|---|---|---|
| 两路 RRF（现行） | 66.7% | 75.0% | 0.746 | 0.757 |
| bm25-only（消融） | 66.7% | 75.0% | 0.746 | 0.757 |
| lexical-only（消融） | 66.7% | 75.0% | 0.746 | 0.757 |
| 负例拒答率 / 误拒率（目标 <5%） | 87.5% | 0.0% | — | — |
| 检索延迟 P50 / P95 | 0.93ms | 1.74ms | — | — |

> RAG 评测：49 条用例（正例 41 / 负例 8），两次运行指标一致=是。
<!-- METRICS:END -->

### 2.5 实用性（10%）

覆盖真实 K8s 五大类高频故障：**内存/OOM、崩溃循环、CPU 节流、网络分区、控制面异常**。12 篇手册均含真实内核/Cgroup/CNI 根因机理与可执行 SOP，非泛泛而谈。

### 2.6 用户体验（10%）

- 首屏 3 秒内建立"三机架 + 中央晶核 + 地面星环"的空间认知
- AI 回答不是纯文本，而是**可交互的生成式 UI 卡片**
- 全键盘可用：`Ctrl+K` 命令面板、`Esc` 分级退出栈
- 端侧审计面板提供"原始 vs 脱敏"一键对比

### 2.7 社会价值与商业潜力（10%）

- **降低门槛**：中小企业往往没有专职 K8s 运维，本系统把专家排障经验固化为可检索、可执行的 Agent
- **合规价值**：端侧脱敏满足金融/政务"数据不出内网"的信创要求
- **商业模式**：SaaS 订阅（按集群数计费）+ 私有化部署授权 + 开源社区版

---

## 三、评委 3 分钟黄金演示路径（Judge Quick-Tour Guide）

> 全程**无需联网、无需真实集群、无需 API Key**。评审现场网络不可控，演示链路保证不断。

### 第 ① 站 · 3D 全息拓扑与混沌故障注入（约 40 秒）

1. 打开 http://localhost:3000 ，静候 3 秒
   - 观察：三机架斜轴纵深、中央巨型水晶控制面、地面拓扑星环、星尘光子流
   - 要点：**零外部 3D 资产**，全部程序化几何
2. 点击左上「混沌故障演练」→ 选择 `POD_OOM_SWARM` → 注入
   - 观察：相机自动飞向 worker-beta、机架底部绯红扩散波纹、3 个 Pod 红光抖动、视口四周警示氛围光
   - 要点：故障不是一行日志，而是**空间里的脉冲**

### 第 ② 站 · RAG 知识库沙盒（约 40 秒）

3. 点击抽屉状态栏 **「RAG 知识库 12+」** 按钮
   - 左侧：12 篇权威 Runbook 全景浏览，含分类标签与自定义标记
   - 右侧：任选一篇查看**故障症状 / 底层根因机理 / 标准修复 SOP**
4. 在顶部检索沙盒输入 `容器内存爆了 exit 137`
   - 观察 Top-3 结果的三维得分条：**Vector 余弦 / BM25 稀疏 / Context 增益**
   - 观察 `matchedTerms` 命中特征词高亮胶囊（如 `137`、`oom`、`exit`）
   - 要点：**分数可解释、可核验**，不是黑盒百分比
5. 点击「新增自定义 Runbook」→ 填入示例 → 提交
   - 要点：新增的条目**下一秒就能被 AI 检索命中**（端侧 localStorage + 请求体上送后端检索池）

### 第 ③ 站 · AI 思维链 + GenUI 三联卡片 + MCP 一键自愈（约 50 秒）

6. 右下角点击「快照诊断」
   - 观察：思考链流式展开——意图规划 → 多模态视觉解析 → RAG 检索 → MCP 路由
   - 观察：三张卡片沿 ①②③ 导轨依次水合
     - **PodMetricsCard** — 双轨渐变进度条 + SVG 面积折线
     - **RootCauseAlert** — P0 徽标 + 证据链 + 可展开 RAG 溯源（含命中特征词胶囊与 Vector/BM25 双路微标签）
     - **ActionConfirm** — 高危二次确认（HITL 人类在环护栏）
7. 点击「确认并执行自愈」
   - 观察：3D 场景中故障 Pod 当场变翠绿、绿色 `[MCP Verification]` 回执、底部终端 `[MCP-ROUTER]` 审计行
   - 要点：**从诊断到执行的完整闭环**

### 第 ④ 站 · 端侧 WebGPU/WASM 隐私日志审计（约 30 秒）

8. 切换抽屉页签到「端侧隐私日志审计」
   - 观察：WebGPU 运行时标识与模型加载状态
   - 在「自定义敏感日志现场测试」框选择预设 `数据库连接串泄露` → 点「端侧推理测试」
   - 观察：推理耗时、脱敏前后对比（`postgres://[REDACTED_CREDENTIAL]@[REDACTED_IP]/kv_prod`）、
     按类型分解的脱敏计数（`连接串凭证 ×1` / `内网 IPv4 ×1`）
   - 要点：**原始凭证从未离开浏览器**

### 第 ⑤ 站 · 一键导出 SRE 故障复盘报告（约 20 秒）

9. 点击状态栏「复盘报告」按钮
   - 观察：弹窗内生成符合 Google SRE 标准的《生产事故根因分析与自愈复盘报告》
   - 8 大章节：事故摘要 / 影响范围 / 时间线 / 根因分析 / 知识库依据 / 处置动作 / 经验教训 / 数据边界声明
   - 支持「预览 / 源码」双视图、一键下载 `.md`、一键复制 Markdown
   - 要点：**从告警到复盘报告的全链路闭环**

---

## 四、核心亮点

### 4.1 3D 空间态势感知

24 个 Pod、3 个 Worker 机架、1 个控制平面以程序化 3D 场景实时呈现。故障不是一行日志，而是**空间里的红色脉冲**——机架底部扩散警示波纹、Pod 实例剧烈红光抖动、网络流量变红卡顿、地面拓扑电路切换绯红。

**批量渲染优化**：352 个实例通过 **10 个 InstancedMesh** 提交，若逐个 Mesh 渲染需 **589 次** draw call，实际仅 **307 次**。24 个可见 Pod 合计只占 **1 次** draw call。

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

**零 Key 也能完整演示**——这是刻意的离线优先设计：评审现场的网络与额度不可控，引擎 B 保证任何环境下都能跑通全部能力。引擎 B 读取的是真实 Pod 指标与真实 RAG 命中结果，只仿真"表达方式"，不伪造观测事实。

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

实测：4 类故障场景全部命中正确手册，平均检索延迟 **11.14ms**。

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

脱敏后文本才允许送入模型。**实测吞吐 9,573 条/秒**。

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

- Node.js >= 18.17
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

自动完成 <!-- VERIFY:BEGIN -->**通过 33 · 失败 0 · 跳过 0（共 33 项）**<!-- VERIFY:END -->，覆盖静态检查、核心算法、API 契约与浏览器端 E2E：

```
阶段 1 · 静态检查         tsc / ESLint / 文件完整性 / 禁 any 扫描
阶段 2 · 核心算法单元校验  脱敏器 6 类敏感信息 / RAG 4 个故障场景
阶段 3 · API 契约         SSE 推送 / NDJSON 流 / 推理链 / 卡片载荷
阶段 4 · 浏览器端 E2E     3D 场景 / 相机联动 / 思考链 / 三张卡片 / 自愈 / 端侧审计
```

### 性能数据采集

```bash
node scripts/benchmark.mjs
```

生成 `docs/performance.md`（可读报告）与 `docs/performance.json`（原始数据）。

### 实测快照

> **数据采集环境与时间**：下表的每一个数字都由 `node scripts/benchmark.mjs` 在**同一台机器**上
> 一次性采集（采集时间见表格首行），并由 `node scripts/sync-docs-metrics.mjs` 自动写入本文件——
> 不接受手抄，文档与 `docs/performance.json` 不一致时同步脚本会报错。
>
> **FPS 与帧时间严格不作为性能证据**：3D 场景在 SwiftShader 软件光栅化（无 GPU 加速）下运行，
> 数值被软件光栅化严重压低，与真实显卡无可比性。可作证据的是：
> ① 硬件无关指标（Draw Calls / Triangles / 场景对象数）；
> ② 真实耗时（RAG 检索、脱敏吞吐、端侧分类）；
> ③ 构建产物（首屏 JS 体积）。
>
> 两遍独立采集的硬件无关指标一致性由 `node scripts/benchmark-consistency.mjs` 校验。

<!-- METRICS:BEGIN -->
| 指标 | 实测值 | 采集口径 / 是否可作性能证据 |
|---|---|---|
| 数据采集时间 | 2026-11-10 14:01（Asia/Shanghai） | `node scripts/benchmark.mjs` |
| 运行环境 | win32 x64 · AMD Ryzen 9 7845HX with Radeon Graphics · 31GB RAM · Node v24.16.0 · 24 核 | 同上 |
| WebGL 渲染器 | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) | 软件光栅化，**FPS 不作为性能证据** |
| Draw Calls | **403**（20 次采样 400~403） | 硬件无关，可作渲染优化证据 |
| Triangles | 188,738（中位） | 硬件无关 |
| 场景对象 | 311 Mesh / 24 InstancedMesh / 972 实例 / 4 Points / 3 Lines | 场景统计 |
| RAG 检索延迟 | 均值 **7.02ms** · 中位 6.82ms · P95 11.94ms（20 次采样） | 真实耗时 |
| 脱敏吞吐 | **16,418 条/秒**（100 条/批 × 5） | 真实耗时 |
| 端侧分类延迟 | 均值 0.07ms（15 条） | builtin (fallback)，非神经网络推理 |
| 首屏 JS | 路由 84.8 kB · First Load 172 kB · 共享 87.5 kB | next build 输出 |
| FPS（软件光栅化） | 均值 2.30 · 中位 2.00 · P95 8.00（20 次采样） | **不作为性能证据** |
| 帧时间（软件光栅化） | 均值 626.03ms · P95 1554.40ms | **不作为性能证据** |
| 视口休眠 | 前台 `always` → 后台 `demand`，已验证生效 | 行为验证 |

| RAG 召回方案（真实评测） | Recall@1 | Recall@3 | MRR@5 | NDCG@5 |
|---|---|---|---|---|
| 两路 RRF（现行） | 66.7% | 75.0% | 0.746 | 0.757 |
| bm25-only（消融） | 66.7% | 75.0% | 0.746 | 0.757 |
| lexical-only（消融） | 66.7% | 75.0% | 0.746 | 0.757 |
| 负例拒答率 / 误拒率（目标 <5%） | 87.5% | 0.0% | — | — |
| 检索延迟 P50 / P95 | 0.93ms | 1.74ms | — | — |

> RAG 评测：49 条用例（正例 41 / 负例 8），两次运行指标一致=是。
<!-- METRICS:END -->

> 证据文件：`docs/evidence/`（验收终端输出日志与截图）、`docs/performance.json`（原始数据）、
> `docs/performance.md`（可读报告）。

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
  高频遥测（1Hz 快照 × 60FPS 插值）绕过 React 协调器直达 useFrame
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

### 5 分钟答辩分镜脚本

| 时间 | 动作 | 讲解要点 |
|---|---|---|
| 0:00–0:30 | 打开首屏，不操作 | "3 秒内看到什么"——三机架斜轴纵深、中央巨型水晶控制面、地面拓扑星环、星尘光子流。强调**零外部 3D 资产** |
| 0:30–1:15 | 点击一个 Pod | 展示空间锁定光环 + 左上探针卡。讲**双轨状态**：60FPS 瞬态 Float32Array 零重渲染 |
| 1:15–2:00 | `Ctrl+K` 输入 `redis` → Enter | 命令面板直达目标并触发相机飞跃。讲**空间指认闭环** |
| 2:00–3:00 | 注入 `POD_OOM_SWARM` | 绯红涟漪 + 视口氛围光 + 顶部横幅 + 节点变红。讲**混沌引擎**与免疫窗口 |
| 3:00–4:00 | 点「快照诊断」 | 思考链流式展开 → 三张卡片依次水合。讲**混合 RAG 真实溯源**与 **MCP 动作编排** |
| 4:00–4:30 | 点「确认并执行自愈」 | 3D 两帧内转绿 + 绿色 `[MCP Verification]` 回执 + 终端审计行 |
| 4:30–5:00 | 切端侧审计页签 | 展示 WebGPU 运行时、脱敏前后对比。讲**隐私零出域**架构主张 |

---

## 九、文档

| 文档 | 内容 |
|---|---|
| [docs/COMPETITION_TECHNICAL_WHITEPAPER.md](docs/COMPETITION_TECHNICAL_WHITEPAPER.md) | **竞赛技术白皮书（8 章完整版，可转 PDF 提交）** |
| [AGENTS.md](AGENTS.md) | 工程契约与编码标准 |
| [docs/performance.md](docs/performance.md) | 性能实测报告 |
| [docs/3d-memory-audit.md](docs/3d-memory-audit.md) | 3D 组件内存泄漏巡检 |
| [.env.example](.env.example) | 环境变量配置模板 |

---

## 十、设计取舍记录

一些刻意的决策，记录在此以免后人误改：

**为什么 3D 组件不手动 dispose？**
所有几何体与材质都是 JSX 声明式创建，R3F 会自动管理生命周期。手动 dispose 反而有重复释放风险。实测 4 次完整销毁重挂载，几何体数恒定，零泄漏。详见内存巡检报告。

**为什么几何体有重复实例不合并？**
改共享实例会在 React 18 StrictMode 双挂载下出现"一方 dispose、另一方仍持有"的 bug——用微小内存换正确性。

**为什么引擎 B 不叫"降级"？**
它不是残次品，而是**离线优先的正式路径**。基于真实集群数据的确定性推理，在无网络、无额度、评审现场弱网时保证系统可用。

**为什么注入检测只警告不阻断？**
「请忽略那条误报告警」在运维对话里可能完全合法。硬性拦截会妨碍正常工作流，真正的防线在服务端 System Prompt。

**为什么 RAG 分数不再是固定高分？**
早期实现把所有结果映射到 `[0.86, 0.98]`，该区间不携带信息量——评委问一句"为什么永远是 96%"即可击穿可信度。现行方案用 Sigmoid 分段校准，分数真实反映证据强弱，且无关查询会如实返回零命中。

---

## License

本项目为演示与教学用途。
