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

import type { RagSignalBreakdown } from '@/utils/ragSignals';

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

  /* ------------------------------------------------------------------ */
  /* 可解释性字段（仅检索命中后回填，入库态为 undefined）                    */
  /* ------------------------------------------------------------------ */

  /**
   * 本次检索真正命中的核心领域特征词（Top-5）。
   *
   * 【为何要展示它】RAG 最容易被质疑的一点是「凭什么是这几篇」。
   * 一个裸分数无法自证；而「因为查询里出现了 oom_kill_process、
   * exit code 137、memory.limits 这三个高 IDF 术语」是**可核验的**。
   * 评委与运维可以直接判断命中是否合理，而不是盲信一个百分比。
   *
   * 【如何选取】取查询词元与文档词表的交集，按 IDF 降序取前 5 ——
   * 只展示"稀缺词"而非 the/pod 这类通用词，因为通用词不具区分度。
   */
  readonly matchedTerms?: string[];

  /**
   * 混合检索三路得分拆解。
   *
   * 【教学价值】单看最终分只能知道"像不像"，看拆解才能知道
   * "**为什么**像"：稀疏 BM25 高 → 关键术语精确命中；
   * 稠密 TF-IDF 高 → 整体语义方向一致；contextBoost 高 → 环境先验吻合。
   * 三者的相对高低直接反映检索器在用什么证据做判断。
   */
  readonly scoreBreakdown?: {
    /** TF-IDF 加权词元 + 双字 N-Gram 的余弦相似度，[0,1] */
    readonly vectorScore: number;
    /** 归一化后的 Okapi BM25 稀疏得分，[0,1] */
    readonly bm25Score: number;
    /** 故障场景 / 受影响 Pod / 分类呼应的上下文先验，[0,1] */
    readonly contextBoost: number;
    /** 倒数秩融合分 RRF，[0,1]（已是融合后的终值口径） */
    readonly rrfScore: number;
    /** 原始融合分（C5：排序依据，未被舍入/校准污染） */
    readonly fusedScore?: number;
    /** R44：词法余弦（原 vectorScore 的新名字；保留 vectorScore 作为兼容字段） */
    readonly lexicalCosine?: number;
    /** R44：句向量（MiniLM 384 维）余弦，[0,1] */
    readonly semanticScore?: number;
    /** R44：本次检索是否真正使用了句向量路（false 表示模型/查询向量未就绪） */
    readonly semanticAvailable?: boolean;
  };

  /**
   * 是否为用户（或评委）现场注入的自定义 Runbook。
   *
   * 【为何需要标记】自定义语料来自 localStorage，其质量与权威性
   * 与内置语料不同级别。UI 上必须区分——否则评委无法判断
   * "这条建议依据的是官方手册还是我刚随手写的那条"。
   */
  readonly isCustom?: boolean;

  /** 自定义语料的注入时间（ISO 字符串，仅自定义条目有值） */
  readonly customCreatedAt?: string;
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
  /**
   * R35：该步骤是否为"模拟编排值"（仅引擎 B 的编排相位为 true）。
   *
   * 【为什么需要】引擎 B（simulator）的耗时是编排节拍，不是真实推理耗时；
   * 前端必须能区分"实测"与"模拟节拍"，不得把编排值当实测值展示。
   */
  readonly sim?: boolean;
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
 * IntentKind —— 用户请求的四档意图分类（意图路由器的输出）。
 *
 * 【为什么需要意图分类】此前无论用户说什么（哪怕只是「你好」，或集群
 * 100 分健康），服务端都会：固定执行 SRE 排障推理链、固定检索 RAG 手册、
 * 固定强制调用三个工具并弹出红色「驱逐节点」高危卡片。
 * 这是把**排障流程**当成了唯一的对话形态——对问候语而言，它既是噪音，
 * 也是对用户真实意图的误判。
 *
 * 四档语义：
 * - `GREETING_OR_CHITCHAT`   日常问候/能力咨询。不检索、不调工具、零卡片。
 * - `STEADY_HEALTH_CHECK`    集群全绿，用户问状态/巡检。仅允许指标卡。
 * - `TARGETED_INSPECTION`    点名某个健康实体的指标。仅允许指标卡。
 * - `FAULT_DIAGNOSIS_AND_HEAL` 存在异常、明确要求诊断/自愈、或带截图。
 *                              才走完整三卡排障闭环。
 */
export type IntentKind =
  | 'GREETING_OR_CHITCHAT'
  | 'STEADY_HEALTH_CHECK'
  | 'TARGETED_INSPECTION'
  | 'FAULT_DIAGNOSIS_AND_HEAL';

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

/**
 * 工具名单一事实源（Single Source of Truth）。
 *
 * 【解决的缺陷】前端历史上按 'renderActionCard' 判断动作卡，而服务端实际发送
 * 'proposeRemediationAction'——两边各写一份工具名，任何一次改名都会让卡片
 * 静默不渲染（第三张卡永远骨架屏的直接原因之一）。
 * 现在服务端、前端、复盘摘要、测试断言全部引用本常量表，禁止再写裸字符串。
 */
export const TOOL_NAME = {
  /** 指标卡 */
  POD_METRICS: 'renderPodMetrics',
  /** 根因分析卡 */
  ROOT_CAUSE: 'renderRootCauseAnalysis',
  /** 自愈动作卡（历史别名 renderActionCard / confirmAction 均已废弃） */
  REMEDIATION: 'proposeRemediationAction',
} as const;

/** 工具名联合类型 */
export type ChatToolName = (typeof TOOL_NAME)[keyof typeof TOOL_NAME];

/**
 * 判定工具名归属（兼容历史别名，但判定结果唯一）。
 *
 * @param name 事件里的 toolName
 * @returns 归一化后的工具种类；无法识别返回 'unknown'
 */
export function classifyToolName(name: string): 'metrics' | 'rootCause' | 'remediation' | 'unknown' {
  if (name === TOOL_NAME.POD_METRICS || name.includes('PodMetrics')) return 'metrics';
  if (name === TOOL_NAME.ROOT_CAUSE || name.includes('RootCause')) return 'rootCause';
  if (
    name === TOOL_NAME.REMEDIATION ||
    name.includes('Remediation') ||
    name.includes('Action')
  ) {
    return 'remediation';
  }
  return 'unknown';
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
  /**
   * 生成式 UI 卡片载荷（三选一，按 toolName 窄化）。
   *
   * 【失败态为 null】当引擎中途失败/取消时，服务端会为悬空的 tool-start
   * 补发一条 `status:'error'` 的 result，此时没有可渲染载荷，args 为 null。
   * 前端据此渲染"生成失败，点击重试"，而不是无限骨架屏。
   */
  readonly args: PodMetricsCardProps | RootCauseAlertProps | ActionConfirmProps | null;
  /**
   * 本次调用的终态（缺省 'ok'，向后兼容旧服务端）。
   * - 'ok'：载荷可用；
   * - 'error'：失败/取消，args 为 null，前端展示失败态并可重试。
   */
  readonly status?: 'ok' | 'error';
  /** 失败原因（仅 status='error' 时有值，便于排查） */
  readonly errorMessage?: string;
  /**
   * 是否为**服务端补全**（缺省 false 表示模型原生调用）。
   *
   * 【为何需要】实测 deepseek-flash 约 40%~50% 的请求只调用 1~2 个工具就结束，
   * 用户会看到残缺的诊断卡片组。路由层在流结束后用**真实集群数据**补齐缺失卡片，
   * 保证演示与使用的完整性。但「补全」与「模型主动产出」语义不同，必须如实标注，
   * 否则等于把服务端兜底伪装成模型的理解能力——不可接受的信息欺骗。
   */
  readonly synthesized?: boolean;
}

/**
 * ChatStreamEngineEvent —— 引擎标识事件（流内事实声明）。
 *
 * 【为何需要】HTTP 响应头在流开始前就已发送，无法反映「流开始后」才发生的
 * 引擎降级。而 x-kubevision-engine 头只能表达**预判**（有 Key 就是 llm）。
 * 当引擎 A 调用失败、实际由引擎 B 接管时，必须有一条流内事件说明真相，
 * 否则调试者与监控会误以为本次回答来自大模型。
 *
 * 【消费约定】前端可据此在对话流顶部显示「回答来自：真实模型 / 本地引擎」，
 * 诚实标注数据来源，而不是让用户误判。
 */
export interface ChatStreamEngineEvent {
  readonly type: 'engine';
  /** 实际生效的引擎 */
  readonly engine: 'llm' | 'simulator';
  /** 选择该引擎的原因（人类可读，仅降级时有值） */
  readonly reason?: string;
}

/**
 * ChatErrorCategory —— 统一错误分类（任务书 A9）。
 *
 * 【为什么必须分类】旧实现所有失败都折成一条 "诊断请求失败" 文本，
 * 用户不知道是网络断了、模型限流、工具参数不合法、还是服务端 5xx，
 * 也不知道该重试还是改问法。分类之后每类都有确定的文案与重试动作。
 */
export const CHAT_ERROR_CATEGORY = {
  NETWORK: 'network',
  MODEL: 'model',
  TOOL_ARGS: 'tool_args',
  SERVER: 'server',
  ABORT: 'abort',
} as const;

/** 错误分类联合类型 */
export type ChatErrorCategory = (typeof CHAT_ERROR_CATEGORY)[keyof typeof CHAT_ERROR_CATEGORY];

/**
 * 各错误分类的展示文案与可重试性（前端唯一文案来源）。
 *
 * 【约束】不在这里塞视觉样式；只给"标题 + 建议动作"的纯文本。
 */
export const CHAT_ERROR_COPY: Readonly<
  Record<ChatErrorCategory, { readonly title: string; readonly hint: string; readonly retryable: boolean }>
> = {
  network: { title: '网络连接中断', hint: '检查网络后重试，已生成的内容会保留', retryable: true },
  model: { title: '模型服务异常', hint: '上游模型限流或不可用，可稍后重试', retryable: true },
  tool_args: { title: '工具参数不合法', hint: '模型给出的工具参数无效，重试可让服务端重新生成', retryable: true },
  server: { title: '服务端内部错误', hint: '服务端 5xx，请稍后重试', retryable: true },
  abort: { title: '已停止生成', hint: '本次回答已中止，可重新发送', retryable: false },
};

/**
 * ChatStreamErrorEvent —— 结构化错误事件（向后兼容：旧前端忽略未知 type）。
 */
export interface ChatStreamErrorEvent {
  readonly type: 'error';
  /** 错误分类 */
  readonly category: ChatErrorCategory;
  /** 人类可读原因（服务端日志同源，便于对照） */
  readonly message: string;
  /** 请求 id（服务端生成，贯穿日志与前端提示） */
  readonly requestId: string;
  /** R43：贯穿链路 id（前端错误卡片可复制；与 span/trace-summary 同源） */
  readonly traceId?: string;
  /** 是否建议重试 */
  readonly retryable: boolean;
}

/**
 * ChatStreamDoneEvent —— 流终止事件（任务书 A8：流末必达 done）。
 *
 * 【为什么需要】旧协议没有显式终止事件：前端只能靠 socket 关闭猜测结束，
 * 遇到代理截断会误判为"正常结束"，骨架屏清理与 TTS 都失去可靠触发点。
 */
export interface ChatStreamDoneEvent {
  readonly type: 'done';
  /** 本次请求的 id（与 error 事件同源） */
  readonly requestId: string;
  /** 实际生效引擎（便于一条事件拿到全部事实） */
  readonly engine: 'llm' | 'simulator';
}

/**
 * ChatStreamResetEvent —— 轮换复位事件（R2 唯一允许新增的事件类型）。
 *
 * 【为什么需要】连续发起多条请求时，上一轮的思考链 / 卡片 / trace 若不清空，
 * 会与新一轮事件混在同一条消息里，造成"重复气泡 / 跨轮 trace 串味"。
 * 服务端在每条流的最开始下发 reset，前端据此把占位消息与 trace 复位到干净起点，
 * 再消费后续事件。它不携带业务载荷，只声明"从这里开始是全新一轮"。
 *
 * 【兼容约定】旧前端忽略未知 type（向前兼容），因此新增 reset 不破坏既有消费端；
 * 既有事件的结构与语义一律不变（不重构协议）。
 */
export interface ChatStreamResetEvent {
  readonly type: 'reset';
  /** 本次请求的 id（与 done/error 同源，便于对号） */
  readonly requestId: string;
  /** 复位原因（人类可读，便于排查；缺省 'new-round'） */
  readonly reason?: string;
}

/**
 * ChatStreamEvent —— NDJSON 流式协议行级事件判别联合。
 *
 * 【解析契约】每行一个 JSON 对象，前端 ReadableStreamDefaultReader +
 * TextDecoder 按 '\n' 切分（跨 chunk 半行缓冲），JSON.parse 后以
 * event.type 做 switch 窄化，穷举五个分支即可安全消费。
 */
/** R35：单条链路 span 事件（服务端 agentTrace 产出，前端画瀑布图） */
export interface SpanStreamEvent {
  readonly type: 'span';
  readonly traceId: string;
  readonly name: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly status: 'ok' | 'error';
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * R35：一次请求的 trace 汇总事件。
 *
 * 【engine 契约】engine='llm' 时 token/成本来自 AI SDK usage；
 * engine='simulator' 时 ttft/total 由服务端真实计时，token/成本不填——
 * 绝不冒充 LLM 的用量或价格。
 */
export interface TraceSummaryStreamEvent {
  readonly type: 'trace-summary';
  readonly traceId: string;
  readonly engine: 'llm' | 'simulator';
  readonly ttftMs: number;
  readonly totalMs: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly costCny?: number;
}

export type ChatStreamEvent =
  | SpanStreamEvent
  | TraceSummaryStreamEvent
  | ChatStreamReasoningEvent
  | ChatStreamTextEvent
  | ChatStreamToolStartEvent
  | ChatStreamToolResultEvent
  | ChatStreamEngineEvent
  | ChatStreamErrorEvent
  | ChatStreamDoneEvent
  | ChatStreamResetEvent;

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
  /**
   * RAG 混合检索信号拆解（用于在 RAG_RETRIEVAL 步骤下渲染微型融合指示条）。
   *
   * 【为何由父级传入而非组件自算】该数据来自根因卡的 ragReferences，
   * 而思考链本身只持有 `AgentReasoningStep[]`——它没有检索结果。
   * 父级（CopilotDrawer）同时持有思考链与工具卡片，由它计算并下传，
   * 可避免思考链反向依赖 store 或工具卡，保持组件纯粹。
   *
   * 【undefined 与 null 的区别】
   * - undefined：尚无检索结果（流式早期），**不渲染**该指示条；
   * - null：已确认无可用拆解（无命中手册），同样不渲染。
   * 二者都表示"没有可展示的数据"，不渲染假进度条是唯一诚实的处理。
   */
  readonly ragBreakdown?: RagSignalBreakdown | null;
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
/* Copilot 对话请求载荷（/api/chat 入参）                                        */
/* ========================================================================== */

/**
 * ClusterFaultSnapshot —— 异常 Pod 的精简快照（送入 LLM 上下文的最小必要字段）。
 *
 * 【为何不直接传完整 TelemetrySnapshot】24 个 Pod 的完整对象（含 6 点历史、
 * 时间戳字符串等）序列化后可达数万 token，既昂贵又稀释关键信号。
 * 此处只保留「诊断必需」的字段：身份、状态、水位、重启数与历史趋势，
 * 让模型聚焦于异常本身。
 */
export interface ClusterFaultSnapshot {
  /** Pod ID */
  readonly id: string;
  /** Pod 名称 */
  readonly name: string;
  /** 命名空间 */
  readonly namespace: string;
  /** 生命周期状态（Running / Pending / CrashLoopBackOff / OOMKilled / Terminating） */
  readonly status: string;
  /** CPU 使用率百分比 */
  readonly cpuUsage: number;
  /** 内存使用率百分比 */
  readonly memoryUsage: number;
  /** 累计重启次数 */
  readonly restarts: number;
  /** 宿主节点 ID */
  readonly nodeId: string;
  /** 近 6 点 CPU 历史 */
  readonly cpuHistory: readonly number[];
  /** 近 6 点内存历史 */
  readonly memHistory: readonly number[];
}

/**
 * ClusterContext —— 对话请求携带的集群上下文（Agent 的「态势感知」输入）。
 *
 * 【设计意图】让 LLM 无需工具调用就能「看见」当前集群快照：
 * 选中了哪个实体、正在演练什么故障、健康分多少、哪些 Pod 异常。
 * 这是让回答从「泛泛而谈」变为「针对你这台集群」的关键输入。
 */
export interface ClusterContext {
  /** 当前选中实体 ID（null 表示未选中） */
  readonly selectedEntityId: string | null;
  /** 当前选中实体类型（'master' | 'node' | 'pod' | null） */
  readonly selectedEntityType: string | null;
  /** 当前混沌演练场景 */
  readonly activeChaos: string;
  /** 集群综合健康分。@range [0, 100] */
  readonly clusterHealthScore: number;
  /** 集群入口总 QPS */
  readonly totalQps: number;
  /** 异常 Pod 快照列表（仅异常态，通常 0~5 条） */
  readonly faultyPods: readonly ClusterFaultSnapshot[];
  /**
   * 用户当前在 3D 画布中选中的 Pod 快照（可选，无论该 Pod 健康与否）。
   *
   * 【为何必须单独携带】faultyPods 只包含「异常态」Pod。当用户在画布上选中的
   * 是一个**健康** Pod（如巡检时点开某个 Running 实例）时，服务端无法从
   * faultyPods 里找到它的真实指标，只能退化为无数据或编造——两者都不可接受。
   * 因此客户端应把选中 Pod 的完整快照一并送来，让生成式 UI 卡片
   * （PodMetricsCard / RootCauseAlert / ActionConfirm）能绑定**真实**
   * id / name / cpuUsage / memoryUsage / cpuHistory / memHistory。
   *
   * 【优先级】卡片目标解析时，本字段（配合 selectedEntityId 匹配）优先于
   * faultyPods[0]，保证「卡片对准用户正在看的那台 Pod」。
   */
  readonly selectedPodSnapshot?: ClusterFaultSnapshot;
  /** Worker 节点摘要（名称 + 状态 + 水位），供节点级诊断引用 */
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly cpuUsage: number;
    readonly memUsage: number;
    readonly rackIndex: number;
  }>;
}

/**
 * ChatMessage —— 对话历史单条消息（OpenAI 兼容的 role/content 形状）。
 *
 * 【为何在此定义而非直接用 ai 包的 Message 类型】路由需要对入参做严格
 * 校验与窄化（不可信的外部输入），自定义契约便于 zod 校验与错误提示；
 * 送入 streamText 前再映射为 SDK 期望的 CoreMessage。
 */
export interface ChatMessage {
  /** 角色（system 由服务端注入，客户端只允许 user/assistant） */
  readonly role: 'user' | 'assistant';
  /** 消息正文 */
  readonly content: string;
}

/**
 * ChatRequestBody —— /api/chat 的完整请求载荷。
 *
 * 【viewportImage 说明】3D 视口快照的 Base64 DataURL（形如
 * 'data:image/jpeg;base64,...'）。仅在用户点击「多模态快照诊断」时携带；
 * 存在时引擎会额外推送 MULTIMODAL_VISION 推理步骤，并在有 Key 时
 * 走多模态模型通道。
 */
/**
 * R46：端侧像素特征（无多模态 Key 时引擎 B 的"看图"依据）。
 *
 * 【来源】客户端在发送前用 canvas 对 3D 视口截图做颜色统计；全部为近似值，
 * 其中 redCenterBandRatio 以屏幕中央 40% 横向带作为"机架投影区"的代理。
 */
export interface PixelFeatures {
  readonly redRatio: number;
  readonly amberRatio: number;
  readonly greenRatio: number;
  readonly cyanRatio: number;
  readonly redCentroidX: number;
  readonly redCentroidY: number;
  readonly redClusters: number;
  readonly redRegion: 'left' | 'center' | 'right' | 'none';
  readonly redCenterBandRatio: number;
}

export interface ChatRequestBody {
  /** 对话历史（至少一条 user 消息） */
  readonly messages: readonly ChatMessage[];
  /** 集群上下文 */
  readonly clusterContext: ClusterContext;
  /** 3D 视口快照（Base64 DataURL，可选） */
  readonly viewportImage?: string;
  /**
   * R45：端侧 MiniLM 查询句向量（384 维，可选）。
   *
   * 【降级】端侧模型未就绪 / 300ms 超时 → 不发送；服务端自动退回两路召回。
   */
  readonly queryEmbedding?: readonly number[];
  /** R46：端侧像素特征（可选；缺失时引擎 B 不编造画面观察） */
  readonly pixelFeatures?: PixelFeatures;
  /**
   * R51：禁用 RAG 检索（评测用，裸模型对照）。
   * 只影响本次请求的 runbooks 注入，不改变引擎选择与其他能力。
   */
  readonly disableRag?: boolean;
  /**
   * 客户端携带的自定义 Runbook 语料（可选）。
   *
   * 【为何必须随请求体上送】自定义语料存在浏览器 localStorage 里，
   * 服务端**读不到**。若不随请求传输，评委在弹窗里刚新增的条目
   * 永远不会被 `/api/chat` 的检索器看到——"新增即可检索"的演示闭环断裂。
   *
   * 【安全边界】服务端会把它当作**不可信外部输入**逐字段规范化
   * （见 route.ts 的 normalizeCustomRunbooks），而不是直接断言使用。
   * 客户端可以篡改这个数组，因此必须假定其形状可能非法。
   */
  readonly customRunbooks?: readonly RagRunbookDoc[];
}

/* ========================================================================== */
/* Copilot 会话消息与语音输入（前端消费层）                                       */
/* ========================================================================== */

/**
 * CopilotToolCard —— 工具调用在会话中的渲染状态（skeleton → card）。
 *
 * 【设计意图】tool-start 与 tool-result 是两条独立事件，需要在前端合并为
 * 同一个卡片槽位：先以 skeleton 态占位（展示骨架屏），收到 result 后
 * 原地升级为 ready 态（水合真实组件）。用 toolCallId 作为配对键，
 * 保证乱序/交叉到达时也能正确匹配。
 */
export interface CopilotToolCard {
  /** 工具调用唯一标识（与流事件 toolCallId 一致） */
  readonly toolCallId: string;
  /** 工具名（决定渲染哪个 GenUI 组件） */
  readonly toolName: string;
  /** MCP 端点 URI（骨架屏提示用） */
  readonly mcpUri: string;
  /** 生命周期：skeleton 等待结果 / ready 可渲染 / error 载荷校验失败 */
  readonly state: 'skeleton' | 'ready' | 'error';
  /** 卡片载荷（仅 ready 态存在） */
  readonly args?: PodMetricsCardProps | RootCauseAlertProps | ActionConfirmProps;
  /** 失败原因（仅 error 态存在；骨架超时 / 服务端终止时展示可读说明） */
  readonly errorMessage?: string;
  /**
   * 是否为服务端补全的卡片（见 ChatStreamToolResultEvent.synthesized）。
   * UI 据此显示「服务端补全」角标，诚实标注卡片来源。
   */
  readonly synthesized?: boolean;
}

/**
 * CopilotMessage —— 对话流中的一条消息（用户或 AI）。
 *
 * 【用户消息】携带 text 与可选的 viewportSnapshot（已发送的 3D 视口缩略图）。
 * 【AI 消息】携带 reasoningSteps（思考链）、text（正文流式累积）、
 * toolCards（生成式 UI 卡片槽位）与 engine（实际生效引擎，诚实标注）。
 */
export interface CopilotMessage {
  /** 消息唯一标识 */
  readonly id: string;
  /** 角色 */
  readonly role: 'user' | 'assistant';
  /** 正文（AI 消息为流式累积结果） */
  readonly text: string;
  /** 用户消息附带的 3D 视口快照 DataURL（AI 消息恒为 undefined） */
  readonly viewportSnapshot?: string;
  /** AI 消息的推理步骤序列（实时追加） */
  readonly reasoningSteps: readonly AgentReasoningStep[];
  /** AI 消息的工具调用卡片槽位 */
  readonly toolCards: readonly CopilotToolCard[];
  /** 实际生效引擎（仅 AI 消息，来自 stream 的 engine 事件） */
  readonly engine?: 'llm' | 'simulator';
  /** 是否仍在流式接收（true → 显示打字光标与"思考中"指示） */
  readonly isStreaming: boolean;
  /**
   * 是否为失败消息（请求中断/异常）。
   *
   * 【用途】气泡据此渲染「一键重试」降级提示框。刻意与 isStreaming 分开：
   * 流结束（isStreaming=false）既可能是成功也可能是失败，二者语义不同，
   * 混用一个布尔会让"正常结束"和"异常中断"在 UI 上无法区分。
   */
  readonly failed?: boolean;
  /** 失败消息对应的原始 prompt（重试时复用，避免用户重打） */
  readonly failedPrompt?: string;
  /** 失败分类（A9：决定展示文案与重试动作） */
  readonly errorCategory?: ChatErrorCategory;
  /** 服务端请求 id（A9：错误提示与日志对号） */
  readonly requestId?: string;
  /**
   * 是否为"收尾不完整"消息（R2 收尾三态之一）。
   *
   * 【三态口径】流结束（isStreaming=false）有三种结局：
   * - 收到唯一 done → 正常（failed/incomplete 均不为 true）；
   * - 未收到 done（连接被截断 / 代理切断）→ incomplete=true，
   *   气泡底部渲染「回答可能不完整」+ 重新生成，而非冒充正常结束；
   * - 解析出错 / 请求异常 → failed=true（走错误降级块）。
   * incomplete 与 failed 刻意分开：前者"内容可能有但没把握"，后者"明确失败"。
   */
  readonly incomplete?: boolean;
  /**
   * 是否为自愈验证摘要消息（绿色系统级消息）。
   *
   * 【为何单独标记】这类消息不是 LLM 生成的对话内容，而是前端在
   * healEntity 完成后从真实快照里读出结果拼成的**系统回执**。
   * 视觉上以翠绿边框区分，语义上与模型回答明确分离——
   * 用户需要一眼看出"这是系统确认的事实"而非"AI 说的话"。
   */
  readonly isVerification?: boolean;
}

/**
 * SpeechRecognitionLike —— 浏览器原生语音识别的最小可用接口子集。
 *
 * 【为何自行声明而非用 DOM lib 类型】TypeScript 的 DOM lib 至今未内置
 * SpeechRecognition（仅部分版本提供 webkitSpeechRecognition，且命名不一致），
 * 直接使用全局名会编译失败。此处只声明真正用到的成员，既避免 any，
 * 又不引入第三方类型包（AGENTS.md 第 2 条要求零 any）。
 */
export interface SpeechRecognitionLike {
  /** 识别语言（如 'zh-CN'） */
  lang: string;
  /** 是否为连续识别 */
  continuous: boolean;
  /** 是否返回中间结果 */
  interimResults: boolean;
  /** 识别结果回调 */
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  /** 错误回调 */
  onerror: ((event: { readonly error: string }) => void) | null;
  /** 结束回调 */
  onend: (() => void) | null;
  /** 开始识别 */
  start: () => void;
  /** 停止识别 */
  stop: () => void;
  /** 中止识别 */
  abort: () => void;
}

/** 语音识别结果事件的最小形状（含 results 索引访问） */
export interface SpeechRecognitionResultEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: {
      readonly isFinal: boolean;
      readonly length: number;
      readonly [index: number]: { readonly transcript: string };
    };
  };
}

/** 挂载了语音识别的 window 扩展（构造器可能存在于 window 或 webkit 前缀下） */
export interface SpeechRecognitionWindow {
  readonly SpeechRecognition?: new () => SpeechRecognitionLike;
  readonly webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}

/* ========================================================================== */
/* 语音模块契约（TTS 播报 / STT 拾音）                                           */
/* ========================================================================== */

/**
 * TtsPlaybackState —— 语音播报的运行态。
 *
 * 【为何需要显式状态机而非单个布尔】"点了喇叭不响"这个用户抱怨背后有三类
 * 完全不同的原因，若用一个 `isSpeaking` 布尔表达，界面无法区分，
 * 用户和开发者都只能盲猜：
 * - 'preparing'  : 已受理，浏览器正在等待音频通道（Chrome 有约 200ms 起步延迟）
 * - 'speaking'   : 正在出声
 * - 'unsupported': 当前环境没有 speechSynthesis（或语音列表为空）
 * - 'blocked'    : 浏览器自动播放策略拦截了首次发音（需用户手势）
 * 把这三类分开表达，才能给出准确的界面提示而不是笼统的"没反应"。
 */
export type TtsPlaybackState = 'idle' | 'preparing' | 'speaking' | 'unsupported' | 'blocked';

/**
 * VoiceSelectResult —— 中文音色优选结果。
 *
 * 【字段说明】
 * - voice    : 选中的音色对象（null 表示系统未安装任何中文音色）
 * - quality  : 音质档位，用于界面诚实标注（natural 为神经网络自然音色，
 *              standard 为传统拼接音色，none 为无可用音色）
 * - source   : 说明本次选择命中了哪条规则，便于排障时解释"为什么是这把声音"
 */
export interface VoiceSelectResult {
  readonly voice: SpeechSynthesisVoice | null;
  readonly quality: 'natural' | 'standard' | 'none';
  readonly source: string;
}

/**
 * AsrFallbackMode —— 语音输入的运行模式。
 *
 * 【为何要区分两种模式】国内网络下 Chrome 的 webkitSpeechRecognition 依赖
 * Google 服务器，几乎必然触发 `network` 错误。若此时弹出报错框，
 * 演示会当场失败。改为回落"声学包络模式"后，麦克风仍在真实拾音、
 * 频谱仍在跳动，用户说完依然能得到一条指令——体验是连贯的，
 * 只是识别手段从"云端转写"降级为"端侧声学特征推断"。
 * 界面必须如实标注当前处于哪种模式，不能让用户误以为语音被真正识别了。
 */
export type AsrFallbackMode = 'cloud' | 'acoustic';

/**
 * SpeechInputSnapshot —— 语音输入的实时可视化数据（每帧更新）。
 *
 * 【为何按帧更新而不用 React state】频谱柱需要 ~30-60Hz 刷新，
 * 走 React state 会让整个抽屉每秒重渲染数十次，直接违背 60FPS 红线。
 * 该快照由 hook 内部用 rAF 写入，组件通过受控的节流回调消费
 * （仅保留 12 个频段值 + 计时 + 字幕，均为小对象，拷贝成本可忽略）。
 */
export interface SpeechInputSnapshot {
  /** 12 个频段的归一化能量（0~1），驱动频谱柱高度 */
  readonly bands: readonly number[];
  /** 已拾音时长（秒） */
  readonly elapsedSec: number;
  /** 实时识别字幕（cloud 模式为中间结果，acoustic 模式为进度提示） */
  readonly interimText: string;
  /** 累计有效发声帧数（用于判定用户是否真的说过话） */
  readonly activeVoiceFrames: number;
  /** 当前运行模式 */
  readonly mode: AsrFallbackMode;
}

/** 语音输入 hook 的对外接口 */
export interface SpeechInputController {
  /** 是否正在拾音 */
  readonly isListening: boolean;
  /** 实时可视化快照 */
  readonly snapshot: SpeechInputSnapshot;
  /** 当前模式 */
  readonly mode: AsrFallbackMode;
  /** 面向用户的非阻断提示（如"云端识别不可用，已切换端侧模式"） */
  readonly notice: string | null;
  /** 结构化错误原因（Q2：权限 / 不支持 / 网络） */
  readonly errorKind: 'permission' | 'unsupported' | 'network' | null;
  /** 最近一次 stop 产出的最终文本（Q1：自动发送的载体） */
  readonly finalText: string | null;
  /** 取走并清空 finalText（一次性消费，防止重复自动发送） */
  readonly consumeFinalText: () => string | null;
  /** 开始拾音 */
  readonly start: () => Promise<void>;
  /** 停止拾音并返回最终文本 */
  readonly stop: () => Promise<string>;
  /** 立即中止（不产出文本，用于组件卸载） */
  readonly abort: () => void;
}

/* ========================================================================== */
/* 端侧 Worker 消息协议（主线程 <-> logClassifier.worker）                         */
/* ========================================================================== */

/**
 * ClassifierRuntime —— 端侧推理运行时后端标识。
 *
 * 【语义】WebGPU 走独立显卡/集成显卡的并行算力；WASM SIMD 走 CPU 的
 * 128 位向量指令。前者通常快 3~10 倍，但并非所有浏览器/设备都支持。
 * 这个值会实时回显到性能 HUD，让用户明确知道「此刻用的是哪个后端」——
 * 性能数字脱离后端标识是没有意义的。
 */
/**
 * 端侧分类的三种运行时（B5：必须在 UI 与文档中明确区分）。
 *
 * - 'webgpu'：WebGPU 硬件加速（最快，模型真实参与推理）；
 * - 'wasm'：WebAssembly SIMD 回退（模型真实参与推理，但慢一个量级）；
 * - 'builtin'：内置确定性规则分类器——**模型没有加载**，
 *   由 [[builtinLogClassifier]] 的词表打分得到结果。
 *
 * 三者语义完全不同：前两者可以说"端侧模型在推理"，后者只能说
 * "规则引擎在兜底"。把 builtin 混标成 wasm 是对能力的虚假陈述。
 */
export type ClassifierRuntime = 'webgpu' | 'wasm' | 'builtin';

/** 主线程 → Worker 的分类请求消息 */
export interface ClassifierClassifyRequest {
  readonly type: 'classify';
  /** 待分类的日志条目（sanitizedText 是唯一合法输入） */
  readonly logs: readonly LogEntry[];
}

/** 主线程 → Worker 的初始化请求消息 */
export interface ClassifierInitRequest {
  readonly type: 'init';
}

/** R45：主线程 → Worker 的句向量请求（复用已初始化的 feature-extraction 管道） */
export interface ClassifierEmbedRequest {
  readonly type: 'embed';
  /** 待编码文本（最多 8 条，Worker 侧截断） */
  readonly texts: readonly string[];
}

/** 主线程 → Worker 的全部请求消息 */
export type ClassifierRequest =
  | ClassifierClassifyRequest
  | ClassifierInitRequest
  | ClassifierEmbedRequest;

/**
 * ClassifierWorkerStatus —— Worker 运行状态机的四态。
 *
 * 【为何需要独立的状态消息】进度（progress）表达的是「模型下载到哪一步」，
 * 而状态表达的是「Worker 此刻在做什么」。两者正交：模型早已就绪后，
 * 进度恒为 100%，但 Worker 仍会在 READY 与 INFERENCING 之间往返。
 * 性能 HUD 需要的是后者——「这个线程现在是忙是闲」，
 * 因此状态必须作为独立消息类型下发，而不是从进度里推断。
 *
 * 【状态流转】
 *   INITIALIZING ──(模型就绪/降级)──> READY
 *        │                              │
 *        └──(失败)──> ERROR            ├──(收到 classify)──> INFERENCING
 *                                       │                          │
 *                                       └──────(结果下发)──────────┘
 */
export type ClassifierWorkerStatus = 'INITIALIZING' | 'READY' | 'INFERENCING' | 'ERROR';

/**
 * ClassifierStatusMessage —— Worker 状态的即时回传消息。
 *
 * 【同步回传契约】Worker 在**收到主线程指令的同一事件循环内**立即发出
 * 对应的状态消息（init → INITIALIZING，classify → INFERENCING），
 * 而不是等异步工作完成后再一并回传。这让 HUD 能立刻反映「指令已被受理」，
 * 消除「点了按钮但界面毫无反应」的不确定感——即使真实推理需要数百毫秒。
 *
 * 【label 字段】给 HUD 直接渲染的完整可读串，形如 'READY (WebGPU)' /
 * 'INFERENCING'。由 Worker 统一拼装而非让 HUD 自己组合：
 * 状态与运行时的组合规则只应有一处定义。
 */
export interface ClassifierStatusMessage {
  readonly type: 'status';
  /** 状态机当前态 */
  readonly status: ClassifierWorkerStatus;
  /** 运行时后端 */
  readonly runtime: ClassifierRuntime;
  /** 运行时可读标签（'WebGPU Hardware Accelerated' / 'WebAssembly SIMD'） */
  readonly runtimeLabel: string;
  /** HUD 直接展示的完整状态串（如 'READY (WebGPU)' / 'INFERENCING'） */
  readonly label: string;
}

/** Worker → 主线程：模型加载进度消息（见上方 ClassifierProgressMessage） */

/**
 * Worker → 主线程的模型加载进度消息。
 *
 * 【runtime 字段】每次进度回传都带上运行时标识，而不是只在 ready 时给一次：
 * 前端 HUD 可能在任意时刻挂载并开始监听，每条消息都自解释才不会有空白期。
 * runtimeLabel 是给用户看的中文/英文可读串
 * （'WebGPU Hardware Accelerated' / 'WebAssembly SIMD'）。
 */
export interface ClassifierProgressMessage {
  readonly type: 'progress';
  /** 加载进度 0~100 */
  readonly progress: number;
  /** 运行时后端 */
  readonly runtime: ClassifierRuntime;
  /** 运行时可读标签（HUD 直接展示） */
  readonly runtimeLabel: string;
  /** 模型名（含降级时切换为内置分类器的标识） */
  readonly modelName: string;
}

/** Worker → 主线程：模型就绪（或已降级为内置分类器） */
export interface ClassifierReadyMessage {
  readonly type: 'ready';
  /** R49：从 Worker 启动到模型就绪的冷启动耗时（毫秒） */
  readonly coldStartMs?: number;
  readonly runtime: ClassifierRuntime;
  readonly runtimeLabel: string;
  readonly modelName: string;
  /** 是否使用了内置降级分类器（true 表示外部模型不可用） */
  readonly fallback: boolean;
}

/** Worker → 主线程：单条日志的分类结果 */
export interface ClassifierResultMessage {
  readonly type: 'result';
  /** 逐条分类结果（与请求 logs 顺序一一对应） */
  readonly results: readonly EdgeAuditResult[];
}

/** Worker → 主线程：错误消息 */
export interface ClassifierErrorMessage {
  readonly type: 'error';
  readonly message: string;
}

/** R45：Worker → 主线程的句向量结果（模型未就绪时 vectors=null，不填 0 冒充） */
export interface ClassifierEmbedResultMessage {
  readonly type: 'embed-result';
  readonly vectors: readonly (readonly number[])[] | null;
  /** R49：本次句向量编码的热推理耗时（毫秒） */
  readonly latencyMs?: number;
}

/** Worker → 主线程的全部响应消息 */
export type ClassifierResponse =
  | ClassifierStatusMessage
  | ClassifierProgressMessage
  | ClassifierReadyMessage
  | ClassifierResultMessage
  | ClassifierEmbedResultMessage
  | ClassifierErrorMessage;

/**
 * isClassifierResponse —— 运行期校验一条未知消息是否为合法的 Worker 响应。
 *
 * 【为何必须做运行期校验】TypeScript 类型在编译后完全消失，
 * `self.postMessage` 跨越的是 structured-clone 边界——它不携带任何类型信息，
 * 也不保证发送方就是预期的那份代码（例如旧版 Worker chunk 被浏览器缓存、
 * 或第三方脚本向同一 Worker 投递消息）。若主线程直接信任 `event.data`，
 * 一个形状错误的 `{ type: 'result', results: null }` 就能让
 * `.map` 在渲染层抛异常，把整个对话面板打挂。
 *
 * 【校验策略】先确认是对象且有字符串 type，再按 type 逐一检查
 * 该类型必需的字段是否存在且类型正确。刻意只做**形状校验**而非深度遍历：
 * 本协议消息体都很小，浅层校验已足以防止崩溃，过度校验反而增加耦合。
 *
 * 【未知 type 的处理】返回 false。这为协议向前兼容留出空间——
 * 未来 Worker 新增消息类型时，旧主线程会安全忽略而非崩溃。
 *
 * @param value postMessage 收到的任意值
 * @returns 是否为可安全消费的 ClassifierResponse
 */
export function isClassifierResponse(value: unknown): value is ClassifierResponse {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  const type = rec.type;
  if (typeof type !== 'string') return false;

  /** 判断字段是否为有限数 */
  const isFiniteNumber = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v);
  /** 判断字段是否为非空字符串 */
  const isNonEmptyString = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0;

  switch (type) {
    case 'status':
      return (
        (rec.status === 'INITIALIZING' ||
          rec.status === 'READY' ||
          rec.status === 'INFERENCING' ||
          rec.status === 'ERROR') &&
        (rec.runtime === 'webgpu' || rec.runtime === 'wasm') &&
        isNonEmptyString(rec.label)
      );

    case 'progress':
      return (
        isFiniteNumber(rec.progress) &&
        (rec.runtime === 'webgpu' || rec.runtime === 'wasm') &&
        typeof rec.runtimeLabel === 'string' &&
        typeof rec.modelName === 'string'
      );

    case 'ready':
      return (
        (rec.runtime === 'webgpu' || rec.runtime === 'wasm') &&
        typeof rec.runtimeLabel === 'string' &&
        typeof rec.modelName === 'string' &&
        typeof rec.fallback === 'boolean'
      );

    case 'result':
      return Array.isArray(rec.results);

    case 'error':
      return typeof rec.message === 'string';

    default:
      return false;
  }
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
