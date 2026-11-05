/**
 * KubeVision AI — AI 域全局严格类型契约（唯一类型源）
 *
 * 【契约】依据 AGENTS.md 第 2 条：禁止 any / @ts-ignore。本文件覆盖
 * RAG 检索、Agent 推理链、生成式 UI 卡片、NDJSON 流式协议与端侧审计的全部载荷。
 *
 * 【协议设计意图】
 * 前端流消费统一采用原生 fetch + ReadableStreamDefaultReader 解析自定义
 * NDJSON 协议（AGENTS.md 第 9 条，严禁引入 @ai-sdk/react）。
 * ChatStreamEvent 即该协议的行级事件判别联合（discriminated union），
 * 以 type 字段窄化，消费端 switch 分支获得完全类型安全与穷举检查。
 */

/* ========================================================================== */
/* RAG 知识库                                                                  */
/* ========================================================================== */

/**
 * RagRunbookDoc —— SRE Runbook 知识库检索切片。
 *
 * 【RAG 流转】文档库 → Transformers.js 端侧 Embedding 向量化 →
 * sreRagEngine.ts 余弦相似度 Top-K 检索 → similarityScore 回填 →
 * 注入 LLM system prompt / RootCauseAlertProps.ragReferences 展示。
 * similarityScore 可选：入库态文档尚无检索语境，仅检索命中后回填。
 */
export interface RagRunbookDoc {
  /** 切片唯一标识（形如 'runbook-oom-killed-001'） */
  readonly id: string;
  /** Runbook 标题（如 'Pod OOMKilled 应急处置手册'） */
  readonly title: string;
  /** 知识分类（如 'memory' / 'network' / 'scheduling' / 'runtime'） */
  readonly category: string;
  /** 检索标签（Embedding 之外的关键词召回通道） */
  readonly tags: string[];
  /** 故障症状描述（与告警 message / 日志文本做语义匹配的锚点） */
  readonly symptom: string;
  /** 处置步骤有序列表（Copilot 行动建议的直接素材） */
  readonly remediationSteps: string[];
  /** 余弦相似度得分。@range [0, 1]，仅检索命中后回填，1 为完全相似 */
  readonly similarityScore?: number;
  /**
   * 故障特征词袋（检索通道二：关键词/子串命中）。
   *
   * 【为何需要】端侧 Embedding 模型尚未接入时，纯语义向量不可得；
   * 此字段提供确定性的**可解释召回依据**：查询串命中越多特征词，
   * 说明该 Runbook 与该故障表象越贴近。相比黑盒向量，它还能在前端
   * 「溯源」区直接展示「命中了哪些特征词」，对答辩与排障信任度至关重要。
   * 词袋使用小写英文与英文术语（kubectl 输出、内核日志原文风格）。
   */
  readonly featureVocabulary: string[];
  /**
   * 根因机制说明（Linux 内核 / Cgroup / CNI 层的底层原理）。
   *
   * 【用途】LLM 增强生成的「技术深度」来源：只给「重启 Pod」这类
   * 操作步骤无法体现 SRE 专业性，必须讲清 OOM Killer 如何依据
   * oom_score_adj 选择受害者、cgroup v2 的 memory.max 如何触发、
   * VXLAN 隧道丢包如何导致 CNI 无法完成 IPAM 分配等机制。
   */
  readonly rootCauseMechanism: string;
  /**
   * 关联的混沌场景（用于上下文加权）。
   *
   * 【检索增强】当 activeChaos 命中该字段时，说明当前演练场景与该
   * Runbook 的适用故障类型一致，应给予显著加权——这是「用已知的
   * 故障上下文缩小检索空间」的经典 RAG 增强手法。
   */
  readonly relatedChaos?: readonly string[];
}

/* ========================================================================== */
/* Agent 推理链                                                                */
/* ========================================================================== */

/**
 * Agent 推理阶段五态模型（思考过程可视化时间轴的泳道划分）：
 * - INTENT_PLANNING    → 意图理解与任务规划
 * - MULTIMODAL_VISION  → 多模态视觉分析（3D 画布截图 → VLM 解读）
 * - RAG_RETRIEVAL      → 知识库检索增强
 * - MCP_TOOL_INVOKE    → MCP 协议工具调用
 * - SAFETY_GUARD       → 高危动作安全护栏审查
 */
export type AgentReasoningPhase =
  | 'INTENT_PLANNING'
  | 'MULTIMODAL_VISION'
  | 'RAG_RETRIEVAL'
  | 'MCP_TOOL_INVOKE'
  | 'SAFETY_GUARD';

/**
 * AgentReasoningStep —— Agent 单步思考过程（Copilot 抽屉时间轴渲染单元）。
 *
 * 【设计意图】LLM 推理过程以结构化步骤流式下发（而非裸文本），
 * 前端逐步追加渲染「思考链」时间轴；mcpUri 仅在 MCP_TOOL_INVOKE
 * 阶段出现，格式为 'mcp://k8s-cluster/tools/<toolName>'
 * （如 'mcp://k8s-cluster/tools/renderPodMetrics'）。
 * latencyMs 用于每步耗时观测，暴露 Agent 性能瓶颈。
 */
export interface AgentReasoningStep {
  /** 步骤序号（从 0 开始单调递增，时间轴排序键） */
  readonly stepIndex: number;
  /** 所属推理阶段（五态泳道） */
  readonly phase: AgentReasoningPhase;
  /** 步骤标题（短文案，如 '解析用户意图' / '检索 OOM 处置手册'） */
  readonly title: string;
  /** 步骤详情（完整思考叙述，支持多行） */
  readonly detail: string;
  /** MCP 工具端点 URI（仅 MCP_TOOL_INVOKE 阶段，形如 'mcp://k8s-cluster/tools/renderPodMetrics'） */
  readonly mcpUri?: string;
  /** 本步骤耗时（毫秒） */
  readonly latencyMs: number;
}

/* ========================================================================== */
/* 生成式 UI 卡片载荷（LLM tool-call 参数 → 前端组件 Props 同构）               */
/* ========================================================================== */

/**
 * PodMetricsCardProps —— Pod 指标卡片（生成式 UI）。
 *
 * 【触发】LLM 调用 renderPodMetrics 工具，tool-result 事件的 args
 * 即本接口实例，前端据此动态挂载指标卡组件到对话流。
 */
export interface PodMetricsCardProps {
  /** 目标 Pod ID（PodEntity.id 弱引用） */
  readonly podId: string;
  /** Pod 展示名 */
  readonly podName: string;
  /** 所属命名空间 */
  readonly namespace: string;
  /** 当前 CPU 使用率百分比。@range [0, 100] */
  readonly cpuUsage: number;
  /** 当前内存使用率百分比。@range [0, 100] */
  readonly memoryUsage: number;
  /** 累计重启次数 */
  readonly restarts: number;
  /** 最近 6 个时间点的 CPU 历史序列（与 PodEntity.cpuHistory 同构）。@range 每项 [0, 100]，长度恒为 6 */
  readonly cpuHistory: number[];
  /** 最近 6 个时间点的内存历史序列（与 PodEntity.memHistory 同构）。@range 每项 [0, 100]，长度恒为 6 */
  readonly memHistory: number[];
}

/**
 * RootCauseAlertProps —— 根因分析告警卡（生成式 UI，Copilot 最高价值卡片）。
 *
 * 【触发】LLM 完成 RAG 检索 + 多信号关联后调用 reportRootCause 工具下发。
 * confidence 为模型自评置信度，驱动卡片可信度进度条渲染；
 * evidenceChain 为调用链证据（时间有序），ragReferences 为命中的知识库切片
 * （含 similarityScore），二者共同构成「可解释性答辩」的完整证据链。
 */
export interface RootCauseAlertProps {
  /** 故障等级：P0 致命 / P1 严重 / P2 警告（与 AlertLevel 同域） */
  readonly severity: 'P0' | 'P1' | 'P2';
  /** 故障标题（一句话定性，如 'checkout 服务内存泄漏引发 OOM 雪崩'） */
  readonly title: string;
  /** 根因置信度。@range [0, 1]，模型自评 */
  readonly confidence: number;
  /** 根因摘要（完整分析叙述） */
  readonly rootCauseSummary: string;
  /** 调用链证据数组（时间有序，如 '16:02:11 node-worker-a-02 内存水位 94%'） */
  readonly evidenceChain: string[];
  /** 影响范围描述（波及的服务/命名空间/用户面） */
  readonly impactScope: string;
  /** 命中的 RAG 知识库引用（含 similarityScore，按得分降序） */
  readonly ragReferences: RagRunbookDoc[];
}

/**
 * 高危运维动作三态模型（MCP 工具白名单，动作即工具名）：
 * - restart_pod       → 重启 Pod（中危）
 * - scale_deployment  → 扩缩容 Deployment（中危）
 * - drain_node        → 驱逐节点（高危，触发 SAFETY_GUARD 二次确认）
 */
export type RemediationActionType = 'restart_pod' | 'scale_deployment' | 'drain_node';

/**
 * ActionConfirmProps —— 动作确认卡（生成式 UI，人在回路安全闸门）。
 *
 * 【触发】LLM 决定执行运维动作时**不直接执行**，而是下发本卡片等待
 * 用户显式确认（Human-in-the-loop）；确认后前端携带 mcpEndpoint
 * 调用 MCP 工具执行。isHighRisk 为 true 时卡片渲染 rose-500 高危样式
 * 并强制勾选确认框，与 SAFETY_GUARD 推理阶段联动。
 */
export interface ActionConfirmProps {
  /** 动作类型（MCP 工具白名单三态） */
  readonly actionType: RemediationActionType;
  /** 目标实体 ID（PodEntity.id / Deployment 名 / WorkerNodeEntity.id） */
  readonly targetId: string;
  /** 目标实体展示名 */
  readonly targetName: string;
  /** 参数说明（人类可读，如 '副本数 3 → 6，预计增量内存 12Gi'） */
  readonly paramDescription: string;
  /** MCP 协议端点（形如 'mcp://k8s-cluster/tools/restartPod'） */
  readonly mcpEndpoint: string;
  /** 高危动作标识（true → rose-500 警示样式 + 强制二次确认） */
  readonly isHighRisk: boolean;
  /**
   * 动作执行完成回调（可选）。
   *
   * 【用途】卡片自身只负责「确认 → 执行 → 展示已执行」这一段，
   * 而执行之后的外部副作用（刷新对话流、上报埋点、触发下一步 Agent 推理、
   * 关闭父级面板等）属于调用方职责。通过本回调向上冒泡，
   * 卡片因此保持**纯展示 + 单一自愈动作**的职责边界，
   * 不硬编码任何父级业务逻辑。
   *
   * 【调用时机】在 healEntity 已提交、且卡片切换到 done 态之后同步触发，
   * 保证父级收到回调时 3D/store 状态已经是最新的
   * （不会出现「回调里读到旧状态」的时序陷阱）。
   *
   * @param targetId   目标实体 ID（原样回传，便于父级定位）
   * @param actionType 已执行的 MCP 动作类型
   */
  readonly onActionExecuted?: (targetId: string, actionType: string) => void;
}

/* ========================================================================== */
/* NDJSON 流式协议事件（判别联合，type 窄化）                                    */
/* ========================================================================== */

/** 推理步骤事件：Agent 思考链逐步下发（Copilot 时间轴追加渲染） */
export interface ChatStreamReasoningEvent {
  readonly type: 'reasoning';
  readonly step: AgentReasoningStep;
}

/** 文本增量事件：LLM 回答正文流式分片（逐 token/句追加） */
export interface ChatStreamTextEvent {
  readonly type: 'text';
  readonly content: string;
}

/** 工具调用开始事件：MCP 工具进入执行态（渲染 loading 占位卡） */
export interface ChatStreamToolStartEvent {
  readonly type: 'tool-start';
  /** 工具调用唯一标识（与 tool-result 配对键） */
  readonly toolCallId: string;
  /** 工具名（如 'renderPodMetrics' / 'reportRootCause' / 'confirmAction'） */
  readonly toolName: string;
  /** MCP 工具端点 URI（形如 'mcp://k8s-cluster/tools/renderPodMetrics'） */
  readonly mcpUri: string;
}

/**
 * 工具调用结果事件：args 携带生成式 UI 卡片载荷。
 *
 * 【命名说明】沿用协议契约字段名 args（LLM tool-call 参数与卡片 Props
 * 同构：模型产出的调用参数即前端渲染载荷），消费端按 toolName 窄化：
 * renderPodMetrics → PodMetricsCardProps；reportRootCause → RootCauseAlertProps；
 * confirmAction → ActionConfirmProps。
 */
export interface ChatStreamToolResultEvent {
  readonly type: 'tool-result';
  /** 工具调用唯一标识（与 tool-start 配对键） */
  readonly toolCallId: string;
  /** 工具名（卡片类型判别依据） */
  readonly toolName: string;
  /** 生成式 UI 卡片载荷（三选一，按 toolName 窄化） */
  readonly args: PodMetricsCardProps | RootCauseAlertProps | ActionConfirmProps;
}

/**
 * ChatStreamEvent —— NDJSON 流式协议行级事件判别联合。
 *
 * 【解析契约】每行一个 JSON 对象，前端 ReadableStreamDefaultReader +
 * TextDecoder 按 '\n' 切分（跨 chunk 半行缓冲），JSON.parse 后以
 * event.type 做 switch 窄化，穷举四个分支即可安全消费。
 */
export type ChatStreamEvent =
  | ChatStreamReasoningEvent
  | ChatStreamTextEvent
  | ChatStreamToolStartEvent
  | ChatStreamToolResultEvent;

/* ========================================================================== */
/* GenUI 组件 Props（思考链 / 骨架屏）                                           */
/* ========================================================================== */

/**
 * AgentThoughtChainProps —— AI 思考与规划过程可视化组件的 Props。
 *
 * 【设计意图】把 AgentReasoningStep[] 渲染为可折叠的时间轴：
 * 折叠态只显示阶段汇总（几步、总耗时），展开态逐条显示
 * 步骤图标 + 阶段徽标 + mcp:// URI 高亮 + 每步耗时。
 * 默认折叠是为了不喧宾夺主——用户主要关心结论，思考链是「可信度证据」。
 */
export interface AgentThoughtChainProps {
  /** 推理步骤序列（按 stepIndex 升序；组件内部会再排序防御） */
  readonly steps: readonly AgentReasoningStep[];
  /** 是否处于流式接收中（true → 展示「思考中」脉冲点与进行中的光标） */
  readonly isStreaming?: boolean;
  /** 初始是否展开，默认 false（折叠态） */
  readonly defaultExpanded?: boolean;
  /** 附加容器类名 */
  readonly className?: string;
}

/**
 * GenUISkeletonProps —— 工具调用进行中的生成式 UI 骨架屏 Props。
 *
 * 【触发时机】NDJSON 流收到 ChatStreamToolStartEvent（tool-start）后立即挂载，
 * 待对应 toolCallId 的 tool-result 到达时被真实卡片替换。
 * 它的存在意义是：**让"AI 正在调用工具"这一中间状态可见**，
 * 而不是让用户对着空白对话流等待——可感知的进度等于可信的智能。
 */
export interface GenUISkeletonProps {
  /** 工具名（如 'renderPodMetrics'） */
  readonly toolName: string;
  /** MCP 工具端点 URI（形如 'mcp://k8s-cluster/tools/renderPodMetrics'） */
  readonly mcpUri: string;
  /** 附加容器类名 */
  readonly className?: string;
}

/* ========================================================================== */
/* 端侧日志审计（Transformers.js WebGPU/WASM 浏览器端推理）                      */
/* ========================================================================== */

/**
 * 端侧日志语义标签四态模型（零样本分类 / 微调分类器输出空间）：
 * - CRITICAL_PANIC      → 致命崩溃（panic / fatal / segfault 类日志）
 * - RESOURCE_EXHAUSTED  → 资源耗尽（OOM / no space / too many open files）
 * - NETWORK_TIMEOUT     → 网络超时（timeout / connection refused / EOF）
 * - NORMAL_INFO         → 常规信息（无风险）
 */
export type EdgeLogLabel =
  | 'CRITICAL_PANIC'
  | 'RESOURCE_EXHAUSTED'
  | 'NETWORK_TIMEOUT'
  | 'NORMAL_INFO';

/**
 * LogEntry —— 端侧日志审计条目（脱敏前后双文本留存）。
 *
 * 【隐私契约】rawText 为采集原文；sanitizedText 为正则脱敏后文本
 * （IP / Token / Secret / 邮箱等敏感模式掩码为 [REDACTED]），
 * maskedCount 记录掩码次数供审计角标展示。**送入端侧模型与 LLM
 * 上下文的一律是 sanitizedText**，rawText 仅本地留存比对。
 */
export interface LogEntry {
  /** 日志条目唯一标识 */
  readonly id: string;
  /** 原始日志文本（仅本地留存，禁止外发） */
  readonly rawText: string;
  /** 脱敏后日志文本（端侧推理与 LLM 上下文的唯一合法输入） */
  readonly sanitizedText: string;
  /** 脱敏掩码替换次数（0 表示无敏感信息命中） */
  readonly maskedCount: number;
  /** 日志时间戳，Unix epoch 毫秒 */
  readonly timestamp: number;
  /** 来源 Pod 名 */
  readonly podName: string;
  /** 来源命名空间 */
  readonly namespace: string;
}

/**
 * EdgeAuditResult —— 端侧模型单条日志审计结论。
 *
 * 【推理链路】sanitizedText → Transformers.js（WebGPU 优先，WASM 回退）
 * 序列分类 → label + confidence；inferenceLatencyMs 记录单条推理耗时，
 * 用于 WebGPU/WASM 后端性能对比观测（答辩数据）。
 */
export interface EdgeAuditResult {
  /** 语义分类标签（四态） */
  readonly label: EdgeLogLabel;
  /** 分类置信度。@range [0, 1]，softmax 最大概率 */
  readonly confidence: number;
  /** 单条推理耗时（毫秒，含 tokenize + forward + decode） */
  readonly inferenceLatencyMs: number;
}
