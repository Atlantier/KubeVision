# KubeVision AI

> 云原生 3D 态势感知与 SRE 智能副驾驶
> 用一块屏幕看清集群，用一句话启动诊断。

KubeVision AI 把 **3D 空间态势**、**RAG 知识检索**、**端侧隐私推理** 与 **生成式 UI** 融合成一个云原生运维中控台。左侧是可交互的 3D 集群拓扑，右侧是能自我规划、检索手册、调用工具并执行自愈的 AI 副驾驶。

---

## 核心亮点

### 🎯 3D 空间态势感知

24 个 Pod、3 个 Worker 机架、1 个控制平面以程序化 3D 场景实时呈现。故障不是一行日志，而是**空间里的红色脉冲**——机架底部扩散警示波纹、Pod 实例剧烈红光抖动、网络流量变红卡顿、地面拓扑电路切换绯红。相机可自动飞向你关注的实体。

**批量渲染优化**：48 个容器实例通过单个 `InstancedMesh` 提交；每个机架内部的 16 个刀片插槽幽灵框也合并为**单个** `InstancedMesh`（否则 3 机架共需 48 次额外 draw call）。全场景 **141 次 draw call / 24,288 三角面**——24 个可见 Pod 合计只占 **1 次** draw call。

**零依赖电影级质感**（不引入 `@react-three/postprocessing`，严守依赖世代锁）：

| 技术 | 实现 | 效果 |
|---|---|---|
| **霓虹晶块** | `onBeforeCompile` 向 `meshStandardMaterial` 注入棱边掩码 + 菲涅尔 + 内芯项，全部写入 `totalEmissiveRadiance` | Pod 呈现"半透明果冻内芯 + 高亮棱边"的晶体质感，且仍是 1 次 draw call |
| **PBR 吞光修复** | 场景无环境贴图时高 `metalness` 会砍掉大部分漫反射固色（反射纯黑 = 反射黑）；Pod 降到 0.05、机柜硬件件降到 0.2，并补微弱自发光与 `<Edges>` 棱线 | 翠绿从"暗沉泥绿"恢复为霓虹色；机架顶盖/底座从"死黑"变为有倒角结构的暗金属 |
| **程序化假泛光** | `GlowHalo3D`：Billboard 面片 + 双层高斯（外层柔光 + 中心白炽核）+ 预乘 alpha | 发光体产生柔和外溢光晕，而不是硬边贴片 |
| **巨型水晶控制面** | 半透明实心八面体（吃光照产生厚度感）+ `<Edges>` 12 棱 + 反向晶核 + 白炽内核 + 地面投射光束 | 控制平面成为视觉重心，撑起整屏构图 |
| **重工机柜** | 四角承重立柱 + 双层阶梯顶冠 + 顶冠光纤接口环（承接网络光缆终点）+ 16 槽幽灵插槽框 + 腔体状态点光 | 机架从"单薄火柴盒"变为有骨架、有插槽阵列、被状态色真实照亮的机柜 |
| **星尘光子流** | 黄金分割低差异序列抖动 `fract(i·φ⁻¹)` + 三级粒径 `0.7/1.0/1.4` | 打破等距"佛珠"感，形成可复现的粒子流 |
| **地面拓扑星环** | 主轨道环 + 控制面内环 + 三道 120° 径向电路（故障链路变绯红） | 机架"站在轨道上"，四个实体形成系统而非孤岛 |

### 🤖 双引擎 AI 副驾驶

| 引擎 | 触发条件 | 能力 |
|---|---|---|
| **引擎 A**（真实大模型） | 配置 API Key | 接入任意 OpenAI 兼容服务商（智谱 GLM-4-Flash / DeepSeek / 通义千问 / GPT-4o-mini），支持多模态图像输入 |
| **引擎 B**（确定性仿真器） | 无 Key 或调用失败 | 基于**真实集群数据**生成专业诊断报告，全功能可用 |

**零 Key 也能完整演示**——这是刻意的离线优先设计：评审现场的网络与额度不可控，引擎 B 保证任何环境下都能跑通全部能力（思考链、RAG 溯源、三张卡片、一键自愈）。引擎 B 读取的是真实 Pod 指标与真实 RAG 命中结果，只仿真"表达方式"，不伪造观测事实。

### 📚 混合 RAG 检索引擎

10 条权威 Kubernetes SRE 排障手册（OOM/Cgroup、CrashLoopBackOff、CFS 节流、QoS 驱逐、CNI/VXLAN、调度失败、DNS、镜像拉取、etcd 仲裁），每条含：

- **故障特征词袋** — 关键词召回通道
- **内核/Cgroup/CNI 根因机制** — 让 LLM 的回答有技术深度
- **标准处置 SOP** — 可直接执行的步骤

三路信号融合检索：**词频向量余弦相似度** + **关键词命中率** + **故障上下文先验**，分数保序映射到 `[0.86, 0.98]`。

实测：4 类故障场景全部命中正确手册，平均检索延迟 **5.7ms**。

### 🔒 端侧隐私零出域

日志在离开浏览器之前完成脱敏。5 条有序规则覆盖：

| 类型 | 示例 | 替换为 |
|---|---|---|
| URL 内嵌凭证 | `postgres://admin:pwd@db:5432` | `[REDACTED_CREDENTIAL]` |
| 密码字段 | `db_password=xxx` | `[REDACTED_PASSWORD]` |
| 云厂商密钥 | AWS `AKIA...` / 阿里云 `LTAI...` / 腾讯云 `AKID...` | `[MASKED_KEY]` |
| JWT / Bearer | `eyJhbGci...` | `[MASKED_TOKEN]` |
| IPv4（含端口） | `10.244.1.15:6379` | `[REDACTED_IP]` |
| 邮箱 | `alice@example.com` | `[REDACTED_EMAIL]` |

脱敏后文本才允许送入模型。**实测吞吐 16,000 条/秒**。

端侧推理运行在独立 Web Worker 中（Transformers.js v3 + WebGPU/WASM），主线程零阻塞。**3500ms 熔断保护**：模型权重下载超时或离线时，自动切换到内置确定性分类器，进度推至 100% Ready，界面绝不卡死。

### 🎨 生成式 UI 水合

AI 不只是回文字，而是**动态挂载可交互组件**：

- **AgentThoughtChain** — 可折叠的思考链时间轴，展示意图规划 → 多模态视觉 → 知识检索 → MCP 工具调用
- **GenUISkeleton** — 工具调用期间的青色流光骨架屏
- **PodMetricsCard** — 双轨渐变进度条 + SVG 面积折线，点击 Pod 名联动 3D 相机
- **RootCauseAlert** — P0/P1 徽标 + 证据链 + 可展开的 RAG 溯源
- **ActionConfirm** — 高危二次确认 + 600ms 流光执行动画 + 一键自愈

---

## 快速开始

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

## 验证与数据

### 一键验收回归

```bash
node scripts/verify.mjs
```

自动完成 **32 项检查**，覆盖静态检查、核心算法、API 契约与浏览器端 E2E：

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

| 指标 | 值 | 说明 |
|---|---|---|
| Draw Calls | **69**（恒定） | 78 个实例批渲染；若逐个渲染需 142 次 |
| Triangles | 14,744 | |
| RAG 检索 | **5.7ms** 均值 | 20 次采样，P95 7.64ms |
| 脱敏吞吐 | **16,003 条/秒** | 100 条批量 |
| 首屏 JS | **62.4 kB** | 3D 与 AI 代码全部懒加载 |
| 视口休眠 | `always → demand` | 页面隐藏时停止渲染 |

> FPS 数据采集于 SwiftShader 软件光栅化环境（无 GPU），不代表真实显卡表现。详见 [docs/performance.md](docs/performance.md)。

---

## 技术架构

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
│  ├─ canvas/                   R3F 场景（机架/Pod/网络流/波纹/相机）
│  ├─ ai/
│  │  ├─ CopilotDrawer.tsx      右侧副驾驶主面板
│  │  ├─ LocalAuditorPanel.tsx  端侧隐私审计台
│  │  └─ GenUI/                 5 个生成式 UI 组件
│  ├─ hud/                      巡检 HUD / 混沌控制台 / 性能遥测
│  └─ layout/                   外壳 / 顶栏 / 终端
├─ hooks/                       遥测流 / 端侧分类器 / 视口休眠
├─ store/                       双轨状态
├─ types/                       9 份严格类型契约
├─ utils/                       RAG 引擎 / 仿真引擎 / 脱敏器 / 空间布局
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

## 交互指南

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
| 0:00–0:30 | 打开首屏，不操作 | "3 秒内看到什么"——三机架斜轴纵深、中央巨型水晶控制面、地面拓扑星环、星尘光子流。强调**零外部 3D 资产**，全部程序化几何 |
| 0:30–1:15 | 点击一个 Pod | 展示空间锁定光环 + 左上探针卡。讲**双轨状态**：60FPS 瞬态 Float32Array 零重渲染 vs 1Hz zustand 响应轨 |
| 1:15–2:00 | `Ctrl+K` 输入 `redis` → Enter | 命令面板直达目标并触发相机飞跃。讲**空间指认闭环**：数据面板 ↔ 3D 坐标 |
| 2:00–3:00 | 注入 `POD_OOM_SWARM` | 绯红涟漪 + 视口氛围光 + 顶部横幅 + 节点变红。讲**混沌引擎**与免疫窗口 |
| 3:00–4:00 | 点 `📸` 快照诊断 | 思考链流式展开 → 三张卡片沿 ①②③ 导轨依次水合。讲**RAG 真实溯源**（RUNBOOK-K8S-042 91.1%）与 **MCP 动作编排** |
| 4:00–4:30 | 点「确认并执行自愈」 | 3D 两帧内转绿 + 绿色 `[MCP Verification]` 回执 + 终端审计行。讲**端到端闭环** |
| 4:30–5:00 | 切端侧审计页签 | 展示 WebGPU 运行时、脱敏前后对比。讲**隐私零出域**架构主张 |

> 全程不需要联网、不需要真实集群——`GOTO_API_KEY` 未配置时会自动降级到
> 本地确定性引擎，演示链路完全不断。

### 3 分钟演示动线

1. **看态势** — 左侧 3D 场景，注意机架与 Pod 的实时状态着色
2. **注入故障** — 左上 `混沌故障演练` → 选 `POD_OOM_SWARM`
   - 相机自动飞向 worker-beta 机架
   - 机架底部亮起红色扩散波纹
   - 3 个 Pod 剧烈红光抖动
   - 顶部出现红色闪烁横幅，视口四周浮现警示氛围光
3. **快照诊断** — 右下角 `📸` 按钮
   - 自动捕获 3D 视口并唤醒 Copilot
   - 思考链展示多模态视觉解析 → RAG 检索 → MCP 路由
   - 依次水合三张卡片（沿 ①②③ 编号导轨）
4. **一键自愈** — 在 ActionConfirm 卡片点执行
   - 3D 场景中故障 Pod 当场变翠绿
   - 相机聚焦到被修复实体
   - 对话流追加绿色 `[MCP Verification]` 回执
   - 底部终端写入 `[MCP-ROUTER]` 审计行
5. **端侧审计** — 切到 `端侧隐私日志审计` 页签
   - 查看 WebGPU/WASM 运行时后端与模型加载状态
   - 点击「抓取并审计」→ 日志脱敏 → 端侧分类
   - 对比原始（红色高亮敏感信息）与脱敏后（绿色高亮占位符）
   - 高危日志可「仅将脱敏安全摘要移交 Copilot」

---

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 工程契约与编码标准 |
| [docs/performance.md](docs/performance.md) | 性能实测报告 |
| [docs/3d-memory-audit.md](docs/3d-memory-audit.md) | 3D 组件内存泄漏巡检 |
| [.env.example](.env.example) | 环境变量配置模板 |

---

## 设计取舍记录

一些刻意的决策，记录在此以免后人误改：

**为什么 3D 组件不手动 dispose？**
所有几何体与材质都是 JSX 声明式创建，R3F 会自动管理生命周期。手动 dispose 反而有重复释放风险。实测 4 次完整销毁重挂载，几何体数恒定 67，零泄漏。详见内存巡检报告。

**为什么几何体有重复实例不合并？**
67 个几何体可归并为 18 种签名，但实际显存仅 138.5 KB。改共享实例会在 React 18 StrictMode 双挂载下出现"一方 dispose、另一方仍持有"的 bug——用微小内存换正确性。

**为什么引擎 B 不叫"降级"？**
它不是残次品，而是**离线优先的正式路径**。基于真实集群数据的确定性推理，在无网络、无额度、评审现场弱网时保证系统可用。

**为什么注入检测只警告不阻断？**
「请忽略那条误报告警」在运维对话里可能完全合法。硬性拦截会妨碍正常工作流，真正的防线在服务端 System Prompt。

---

## License

本项目为演示与教学用途。
