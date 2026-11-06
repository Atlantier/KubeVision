/**
 * KubeVision AI — Copilot 双擎流式对话路由（/api/chat）
 *
 * 【职责】把「Agent 自主规划 + RAG 检索增强 + 多模态快照感知 + MCP 工具调用」
 * 融合为一条 NDJSON 流，逐帧推送给前端，驱动思考链时间轴与生成式 UI 卡片。
 *
 * 【为何是 NDJSON 而非 SSE】
 * 本路由是**请求-响应**语义（一问一答，答完即断），不需要 SSE 的长连接与
 * 自动重连；NDJSON（每行一个 JSON）天然适合「逐事件流式产出 + 读完即止」，
 * 且前端可用 ReadableStreamDefaultReader 精确手动控制（AGENTS.md 第 9 条
 * 明确禁止引入 @ai-sdk/react，前端统一用原生 fetch + reader 解析）。
 *
 * 【双擎架构】
 * 引擎 A（真实大模型）：配置 OPENAI_API_KEY 时启用。通过
 * createOpenAI({ apiKey, baseURL }) 适配任意 OpenAI 兼容服务商
 * （智谱 glm-4-flash 免费额度 / DeepSeek / 通义千问 / OpenAI 官方），
 * 把 RAG 命中结果注入 System Prompt，并注册三个 Zod 工具
 * （renderPodMetrics / renderRootCauseAnalysis / proposeRemediationAction）。
 * 遍历 result.fullStream：text-delta → { type:'text' }；
 * tool-call → 先推 tool-start（前端出骨架屏），延迟 300ms 再推 tool-result
 * （让骨架屏可见，否则两帧连发会一闪而过，失去「正在调用工具」的感知）。
 *
 * 引擎 B（确定性 SRE 仿真器）：无 Key 或 A 抛错时**自动无缝接管**。
 * 不调用任何外部 API，而是基于真实故障数据（Prometheus 风格的指标 +
 * RAG 命中 + 是否携带视觉快照）生成专业 Markdown 诊断报告，
 * 以打字机速率逐字推送，并依次发出 tool-start（延迟 450ms 展示骨架）与
 * tool-result，精准水合三张卡片（PodMetricsCard / RootCauseAlert / ActionConfirm）。
 *
 * 【为何必须有引擎 B】演示/评审环境的网络与额度不可控。若只有引擎 A，
 * 一旦断网或欠费，整个 Copilot 变成一片错误——那是产品级灾难。
 * 引擎 B 保证**任何环境下都能完整演示全部能力**（思考链、RAG 溯源、
 * 三张卡片、动作确认），且数据来自真实集群状态而非杜撰。
 *
 * 【RAG 前置】无论走哪个引擎，请求到达后都**先**执行 retrieveSreRunbooks
 * 检索 Top-2 Runbook，再据此构造推理步骤与 System Prompt——
 * 这保证「知识先于生成」，模型永远基于检索到的手册作答而非自由发挥。
 */

import { createOpenAI } from '@ai-sdk/openai';
import { streamText, tool, type CoreMessage } from 'ai';
import { z } from 'zod';

import type {
  ActionConfirmProps,
  AgentReasoningStep,
  ChatMessage,
  ChatRequestBody,
  ChatStreamEvent,
  ClusterContext,
  ClusterFaultSnapshot,
  PodMetricsCardProps,
  RagRunbookDoc,
  RootCauseAlertProps,
} from '@/types/ai';
import { retrieveSreRunbooks } from '@/utils/sreRagEngine';

/* ---- Next.js Route Segment 配置 ---- */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** NDJSON 响应头（每行一个 JSON 对象） */
const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

/** 工具调用延迟：引擎 A 用 300ms（需求契约），引擎 B 用 450ms（骨架屏更明显） */
const TOOL_RESULT_DELAY_MS_A = 300;
const TOOL_RESULT_DELAY_MS_B = 450;

/** 仿真器打字机速率（字符/秒），可用 SIM_TYPING_CPS 覆盖 */
const DEFAULT_TYPING_CPS = 60;

/** 推理步骤耗时展示值（毫秒）：仿真器的确定性数值，非真实测量 */
const SIM_LATENCY = {
  intent: 38,
  vision: 96,
  rag: 22,
  mcp: 124,
} as const;

/** RAG 检索返回条数 */
const RAG_TOP_K = 2;

/* ========================================================================== */
/* 引擎 B 的目标解析与数据绑定（三张卡片的唯一数据源）                              */
/* ========================================================================== */

/**
 * SimulatorTarget —— 引擎 B 卡片绑定的目标解析结果（Pod 与 Node 互斥）。
 */
interface SimulatorTarget {
  /** 解析出的目标 Pod 真实快照（null 表示本次无 Pod 级目标） */
  readonly pod: ClusterFaultSnapshot | null;
  /** 解析出的目标节点真实摘要（null 表示无节点级目标） */
  readonly node: ClusterContext['nodes'][number] | null;
}

/**
 * resolveSimulatorTarget —— 解析三张生成式 UI 卡片应绑定的**真实实体**。
 *
 * 【为何需要这个函数：修正一个真实的数据绑定缺陷】
 * 早期实现直接取 `ctx.faultyPods[0]` 作为目标，导致两类错绑：
 * 1. 用户在 3D 画布上选中了 Pod B，但 faultyPods[0] 是 Pod A——
 *    于是卡片展示的是 A 的指标，而用户正盯着 B。**卡片与用户关注对象不一致**，
 *    这是最危险的错绑：用户可能据此对错误的实例执行自愈动作；
 * 2. 用户选中的是健康 Pod（不在 faultyPods 中）时直接取不到数据，
 *    只能退化为无卡片或编造数值，两者都不可接受。
 *
 * 【解析优先级（严格按此顺序，已在下文逐条注释）】
 * P1. 选中实体是 Pod 且能在「异常列表」或「选中快照」中查到 → 用它
 *     （这是「用户正在看的那台」，优先级最高）；
 * P2. 否则若有异常 Pod → 取第一个异常 Pod（保证诊断仍聚焦最严重故障）；
 * P3. 否则若选中实体是 Node → 取该节点的真实摘要（节点级诊断）；
 * P4. 都不满足 → pod/node 均为 null，上层据此**不产出任何卡片**，
 *     绝不输出 'unknown-target' 这类占位值（宁可无卡，不可假卡）。
 *
 * @param ctx 请求携带的集群上下文
 * @returns 解析结果（pod 与 node 至多一个非 null）
 */
function resolveSimulatorTarget(ctx: ClusterContext): SimulatorTarget {
  const selectedId = ctx.selectedEntityId;
  const typeIsPod = ctx.selectedEntityType === 'pod';
  const typeIsNode = ctx.selectedEntityType === 'node';
  /**
   * 【类型缺失的容错】selectedEntityType 可能为 null 或客户端未来新增的
   * 未知取值。此时不能直接放弃绑定——「selectedEntityId 能匹配到某个 Pod
   * 快照」本身就是强证据，说明用户选中的就是那台 Pod。
   * 因此把「显式 pod」与「类型未知」同等对待，都允许走 Pod 分支；
   * 仅当类型**显式为 node** 时才排斥 Pod 分支（尊重明确意图）。
   */
  const maybePod = typeIsPod || (!typeIsPod && !typeIsNode);

  /* ---- P1：用户选中的 Pod（真实指标优先从异常列表取，其次取选中快照） ---- */
  if (maybePod && selectedId !== null) {
    const fromFaulty = ctx.faultyPods.find((p): boolean => p.id === selectedId);
    if (fromFaulty !== undefined) {
      return { pod: fromFaulty, node: null };
    }
    const snapshot = ctx.selectedPodSnapshot;
    if (snapshot !== undefined && snapshot.id === selectedId) {
      return { pod: snapshot, node: null };
    }
    /* 选中 Pod 但两处都查不到 → 继续往下走 P2，
       仍可绑定最严重的异常 Pod（总比无卡好，且不会张冠李戴到别的实例） */
  }

  /* ---- P2：首个异常 Pod（诊断聚焦最严重故障） ---- */
  if (ctx.faultyPods.length > 0) {
    return { pod: ctx.faultyPods[0], node: null };
  }

  /* ---- P3：选中的节点（节点级诊断，名称从 nodes 摘要取真实值） ---- */
  if (typeIsNode && selectedId !== null) {
    const node = ctx.nodes.find((n): boolean => n.id === selectedId);
    if (node !== undefined) {
      return { pod: null, node };
    }
  }

  /* ---- P4：无可用目标 ---- */
  return { pod: null, node: null };
}

/**
 * normalizeHistory —— 把历史序列归一化为契约要求的 6 点。
 *
 * 【为何需要】PodMetricsCardProps 契约规定 cpuHistory / memHistory
 * 「长度恒为 6」。但请求体来自客户端，可能因采集窗口不完整而传入
 * 少于 6 点（甚至空数组）。若不归一化，卡片折线图的横轴刻度会随输入变化，
 * 与其它卡片并排时视觉不一致；空数组更会让面积路径退化为空字符串。
 *
 * 【归一化规则】
 * 1. 过滤非有限值并 clamp 到 [0,100]（契约值域）；
 * 2. 多于 6 点 → 保留最近 6 点（末位是当前值，不可丢）；
 * 3. 少于 6 点 → 在最前面重复首值补齐（即假定该 Pod 此前水位平稳），
 *    而不是补 0 —— 补 0 会画出一条误导性的暴跌曲线。
 *
 * @param values 原始历史序列
 * @returns 长度恒为 6、值域 [0,100] 的新数组
 */
function normalizeHistory(values: readonly number[]): number[] {
  const cleaned: number[] = [];
  for (const raw of values) {
    if (!Number.isFinite(raw)) continue;
    cleaned.push(Math.max(0, Math.min(100, raw)));
  }
  if (cleaned.length === 0) {
    return [0, 0, 0, 0, 0, 0];
  }
  if (cleaned.length >= 6) {
    return cleaned.slice(-6);
  }
  const padded: number[] = [];
  const missing = 6 - cleaned.length;
  for (let i = 0; i < missing; i++) padded.push(cleaned[0]);
  for (const v of cleaned) padded.push(v);
  return padded;
}

/**
 * clampPercent —— 把任意数值收敛到百分比值域 [0, 100]。
 *
 * 【用途】请求体来自客户端，cpuUsage / memoryUsage / clusterHealthScore
 * 都可能传入越界值（如 118、-3）甚至 NaN。越界值会让进度条宽度超出容器、
 * 拐点跑出 SVG 视口，因此在校验层统一收敛，渲染层拿到的一定是合法值。
 *
 * @param value 原始数值
 * @returns [0, 100] 区间内的数值
 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * normalizeFaultSnapshot —— 把不可信的 Pod 快照对象规范化为 ClusterFaultSnapshot。
 *
 * 【为何不用 `as ClusterFaultSnapshot` 断言】断言只是让编译器闭嘴，
 * 运行期若客户端少传 name / cpuHistory，卡片渲染时才会炸（且报错位置
 * 距离真正的问题源很远）。这里逐字段取值 + 类型判定 + 兜底默认值，
 * 保证下游拿到的对象**形状恒定**：numbers 一定是有限数、数组一定是数组、
 * 字符串一定非空（name 缺省回退到 id）。
 *
 * 返回 null 表示这条快照连最基本的 id 都没有，无法绑定，由调用方过滤掉。
 *
 * @param raw 原始未知对象（来自 JSON.parse）
 * @returns 规范化后的快照；不可用时返回 null
 */
function normalizeFaultSnapshot(raw: unknown): ClusterFaultSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return null;

  /** 取字符串字段（缺省回退） */
  const takeString = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.length > 0 ? value : fallback;

  /** 取有限数值字段（缺省回退） */
  const takeNumber = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  /** 取数值数组字段（过滤非有限值） */
  const takeNumberArray = (value: unknown): number[] => {
    if (!Array.isArray(value)) return [];
    const out: number[] = [];
    for (const item of value) {
      if (typeof item === 'number' && Number.isFinite(item)) out.push(item);
    }
    return out;
  };

  return {
    id: o.id,
    name: takeString(o.name, o.id),
    namespace: takeString(o.namespace, 'default'),
    status: takeString(o.status, 'Unknown'),
    cpuUsage: clampPercent(takeNumber(o.cpuUsage, 0)),
    memoryUsage: clampPercent(takeNumber(o.memoryUsage, 0)),
    restarts: Math.max(0, Math.trunc(takeNumber(o.restarts, 0))),
    nodeId: takeString(o.nodeId, ''),
    cpuHistory: takeNumberArray(o.cpuHistory),
    memHistory: takeNumberArray(o.memHistory),
  };
}

/* ========================================================================== */
/* 工具：Zod Schema（三个 MCP 工具的载荷契约）                                    */
/* ========================================================================== */

/**
 * renderPodMetrics 工具的 Zod Schema —— 与 PodMetricsCardProps 同构。
 *
 * 【为何用 zod 而非 TS 类型】LLM 生成的工具参数是**不可信的外部输入**，
 * 必须做运行期校验。zod schema 同时承担两职：给模型的参数说明（JSON Schema）
 * 与运行期校验器，是 AI SDK 工具定义的标准做法。
 */
const podMetricsSchema = z.object({
  podId: z.string().describe('目标 Pod 的 ID'),
  podName: z.string().describe('Pod 展示名称'),
  namespace: z.string().describe('所属命名空间'),
  cpuUsage: z.number().min(0).max(100).describe('当前 CPU 使用率百分比'),
  memoryUsage: z.number().min(0).max(100).describe('当前内存使用率百分比'),
  restarts: z.number().int().min(0).describe('累计重启次数'),
  cpuHistory: z.array(z.number().min(0).max(100)).describe('近 6 个周期的 CPU 历史'),
  memHistory: z.array(z.number().min(0).max(100)).describe('近 6 个周期的内存历史'),
});

/** renderRootCauseAnalysis 工具的 Zod Schema —— 与 RootCauseAlertProps 的核心字段同构 */
const rootCauseSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2']).describe('故障等级'),
  title: z.string().describe('一句话定性标题'),
  confidence: z.number().min(0).max(1).describe('根因置信度 0~1'),
  rootCauseSummary: z.string().describe('根因分析叙述'),
  evidenceChain: z.array(z.string()).describe('时间有序的证据链'),
  impactScope: z.string().describe('影响范围'),
});

/** proposeRemediationAction 工具的 Zod Schema —— 与 ActionConfirmProps 的核心字段同构 */
const remediationSchema = z.object({
  actionType: z
    .enum(['restart_pod', 'scale_deployment', 'drain_node'])
    .describe('MCP 工具白名单动作类型'),
  targetId: z.string().describe('目标实体 ID'),
  targetName: z.string().describe('目标实体展示名'),
  paramDescription: z.string().describe('人类可读的参数说明'),
  isHighRisk: z.boolean().describe('是否高危（true 需二次确认）'),
});

/* ========================================================================== */
/* System Prompt 构造（RAG 注入口）                                             */
/* ========================================================================== */

/**
 * buildSystemPrompt —— 构造注入 RAG 知识的 System Prompt。
 *
 * 【核心逻辑】把四类上下文拼装为结构化提示：
 * 1. 角色设定：资深云原生 SRE 专家，回答必须具体、可执行；
 * 2. 集群实时态势：健康分、当前混沌场景、选中实体、异常 Pod 明细；
 * 3. RAG 检索结果：命中的 Runbook（编号 + 标题 + 相似度 + 处置步骤），
 *    并明确要求模型「优先引用手册条款」——这是 RAG 增强生成的落地方式；
 * 4. 工具使用规则：告知三个工具的用途与调用时机。
 *
 * 【为何把 RAG 放进 System 而非 User】System Prompt 具有更高的指令权重，
 * 且对多轮对话持续有效；把手册放进 user 消息会在历史累积中被稀释。
 *
 * @param ctx     集群上下文
 * @param runbooks 命中的 Runbook 切片（含 similarityScore）
 * @param hasImage 是否携带 3D 视口快照
 * @returns 完整 System Prompt 文本
 */
function buildSystemPrompt(
  ctx: ClusterContext,
  runbooks: readonly RagRunbookDoc[],
  hasImage: boolean,
): string {
  /* ---- 异常 Pod 明细（逐行列出关键指标，便于模型引用具体数字） ---- */
  const faultyLines =
    ctx.faultyPods.length === 0
      ? '  （当前无异常 Pod）'
      : ctx.faultyPods
          .map(
            (p: ClusterFaultSnapshot): string =>
              `  - ${p.name} [${p.namespace}] status=${p.status} cpu=${p.cpuUsage.toFixed(1)}% mem=${p.memoryUsage.toFixed(1)}% restarts=${p.restarts} node=${p.nodeId}`,
          )
          .join('\n');

  /* ---- 节点水位 ---- */
  const nodeLines = ctx.nodes
    .map((n): string => `  - ${n.name} status=${n.status} cpu=${n.cpuUsage.toFixed(1)}% mem=${n.memUsage.toFixed(1)}% rack=${n.rackIndex}`)
    .join('\n');

  /* ---- RAG 手册注入 ---- */
  const runbookLines =
    runbooks.length === 0
      ? '  （本次未命中知识库手册）'
      : runbooks
          .map((doc): string => {
            const sim = doc.similarityScore === undefined ? 'n/a' : `${(doc.similarityScore * 100).toFixed(1)}%`;
            const steps = doc.remediationSteps.map((s, i): string => `      ${i + 1}. ${s}`).join('\n');
            return [
              `  ▸ [${doc.id}] ${doc.title}  (Similarity: ${sim})`,
              `    症状：${doc.symptom}`,
              `    根因机制：${doc.rootCauseMechanism}`,
              `    标准处置步骤：`,
              steps,
            ].join('\n');
          })
          .join('\n\n');

  return [
    '你是 KubeVision AI 的资深云原生 SRE 专家。你的回答必须具体、可执行、有据可依。',
    '',
    '【当前集群实时态势】',
    `  集群健康分：${ctx.clusterHealthScore}/100`,
    `  入口 QPS：${ctx.totalQps}`,
    `  混沌演练场景：${ctx.activeChaos}`,
    `  当前选中实体：${ctx.selectedEntityId ?? '未选中'} (${ctx.selectedEntityType ?? 'n/a'})`,
    '  异常 Pod 明细：',
    faultyLines,
    '  节点水位：',
    nodeLines,
    '',
    '【知识库检索结果（请优先引用这些手册条款作为依据）】',
    runbookLines,
    '',
    hasImage
      ? '【多模态输入】本次对话附带了 3D 视口快照，请结合空间布局异常（如某机架全红、波纹环激活范围）辅助判断。'
      : '【多模态输入】本次未附带视口快照。',
    '',
    '【工具使用规则】',
    '  · renderPodMetrics：当需要展示某个 Pod 的实时指标趋势时调用。',
    '  · renderRootCauseAnalysis：完成根因分析后调用，必须填写证据链与置信度。',
    '  · proposeRemediationAction：给出修复动作建议时调用（不会自动执行，需用户二次确认）。',
    '',
    '【回答要求】',
    '  1. 使用 Markdown，结构清晰（结论 → 证据 → 处置建议）。',
    '  2. 明确引用命中的 Runbook 编号。',
    '  3. 不要臆造未在上下文中出现的 Pod 或指标。',
  ].join('\n');
}

/* ========================================================================== */
/* 引擎 B：确定性 SRE 仿真器                                                    */
/* ========================================================================== */

/**
 * sleep — 可被 abort 中断的延迟工具。
 *
 * 【为何不用裸 setTimeout】客户端中途断开时应尽快结束，而非傻等。
 * 监听 abortSignal 后 reject，让上层 catch 后自然终止流。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject): void => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout((): void => {
      resolve();
    }, ms);
    signal?.addEventListener(
      'abort',
      (): void => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/**
 * buildSimulatorReport —— 生成引擎 B 的专业 Markdown 诊断报告。
 *
 * 【数据来源全部真实】报告中的每个数字都来自 clusterContext 与 RAG 结果：
 * 异常 Pod 的真实水位、命中手册的真实编号与相似度、真实的混沌场景名。
 * 仿真的是「模型的表达方式」，不是「编造的数据」——这是本项目对
 * 「AI 演示」这件事的底线：可以仿真延迟与文案风格，绝不伪造观测事实。
 *
 * @param ctx      集群上下文
 * @param runbooks RAG 命中的手册
 * @param hasImage 是否携带视口快照
 * @returns 完整 Markdown 文本
 */
function buildSimulatorReport(
  ctx: ClusterContext,
  runbooks: readonly RagRunbookDoc[],
  hasImage: boolean,
): string {
  const primary = runbooks[0];
  const primaryLabel =
    primary === undefined
      ? '知识库未命中'
      : `${primary.id} · ${primary.title}（Similarity: ${((primary.similarityScore ?? 0) * 100).toFixed(1)}%）`;

  const worst = ctx.faultyPods.length > 0 ? ctx.faultyPods[0] : null;
  const chaosLabel =
    ctx.activeChaos === 'NONE' ? '稳态（无混沌演练）' : ctx.activeChaos;

  const lines: string[] = [];

  lines.push('## 诊断结论');
  lines.push('');
  if (worst !== null) {
    const sev = ctx.clusterHealthScore < 60 ? 'P0' : ctx.clusterHealthScore < 85 ? 'P1' : 'P2';
    lines.push(
      `**${sev} · ${worst.name} 触发 ${worst.status}，集群健康分 ${ctx.clusterHealthScore}/100**`,
    );
    lines.push('');
    lines.push(
      `目标 Pod \`${worst.name}\`（命名空间 \`${worst.namespace}\`，宿主节点 \`${worst.nodeId}\`）` +
        `当前 CPU ${worst.cpuUsage.toFixed(1)}%、内存 ${worst.memoryUsage.toFixed(1)}%、` +
        `累计重启 ${worst.restarts} 次，已进入 ${worst.status} 状态。`,
    );
  } else {
    lines.push(`**集群当前健康（健康分 ${ctx.clusterHealthScore}/100），未检测到异常 Pod**`);
    lines.push('');
    lines.push(`当前演练场景为 ${chaosLabel}。建议保持观察，或注入混沌场景验证自愈闭环。`);
  }

  lines.push('');
  lines.push('## 根因分析');
  lines.push('');
  if (primary !== undefined) {
    lines.push(`依据 **${primaryLabel}**：`);
    lines.push('');
    lines.push(`> ${primary.rootCauseMechanism}`);
  } else {
    lines.push('未在知识库中检索到匹配手册，以下依据通用 K8s 排障经验推断：');
    lines.push('');
    lines.push('> 容器异常退出通常由资源超限、依赖不可达或探针配置不当引起。');
  }

  if (hasImage) {
    lines.push('');
    lines.push('## 多模态空间观察');
    lines.push('');
    const rackHint =
      worst !== null ? `异常 Pod 所在的 \`${worst.nodeId}\` 机架` : '当前选中的机架';
    lines.push(
      `结合 3D 视口快照，${rackHint}区域的实例渲染呈现告警态，` +
        `机架底部扩散波纹环已激活，与遥测数据的时间窗口吻合，` +
        `可排除纯渲染层误报——故障在数据面与呈现面是一致的。`,
    );
  }

  lines.push('');
  lines.push('## 处置建议');
  lines.push('');
  if (primary !== undefined) {
    primary.remediationSteps.slice(0, 4).forEach((step, index): void => {
      lines.push(`${index + 1}. ${step}`);
    });
  } else {
    lines.push('1. 确认 Pod 事件与上一次容器日志');
    lines.push('2. 检查资源配置与依赖服务可达性');
  }
  lines.push('');
  lines.push('> 建议先执行「隔离并重启实例」验证是否为瞬时故障；若复发则按手册深入根因。');

  return lines.join('\n');
}

/* ========================================================================== */
/* 引擎 A 的 NDJSON 流式实现                                                    */
/* ========================================================================== */

/**
 * streamWithLLM —— 引擎 A：真实大模型流式推理。
 *
 * 【核心流转】
 * 1. createOpenAI({ apiKey, baseURL }) 适配任意 OpenAI 兼容端点；
 * 2. streamText 注入 RAG 增强的 System Prompt + 三个 Zod 工具；
 * 3. 遍历 fullStream：
 *    - 'text-delta' → 推 { type:'text', content: textDelta }
 *    - 'tool-call'  → 先推 tool-start（前端挂骨架屏），
 *                     延迟 300ms 后推 tool-result（带完整 args 水合卡片）
 *
 * 【参数校验】tool-call 的 args 是模型生成的不可信数据，推给前端前
 * 用对应 zod schema 校验；校验失败则跳过该工具调用并推一条警示文本，
 * 绝不让畸形载荷进入 UI（否则卡片渲染会崩）。
 *
 * @returns 是否已成功接管（false 表示调用失败，调用方应回落到引擎 B）
 */
async function streamWithLLM(params: {
  readonly apiKey: string;
  readonly baseURL: string | undefined;
  readonly modelName: string;
  readonly messages: readonly ChatMessage[];
  readonly systemPrompt: string;
  readonly hasImage: boolean;
  readonly viewportImage: string | undefined;
  readonly emit: (event: ChatStreamEvent) => void;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const { apiKey, baseURL, modelName, messages, systemPrompt, hasImage, viewportImage, emit, signal } = params;

  try {
    const provider = createOpenAI({ apiKey, baseURL });
    const model = provider(modelName);

    /* ---- 组装消息：多模态时把图片作为最后一条 user 消息的附件 ---- */
    /**
     * 【类型契约】CoreMessage 的 user 消息 content 允许
     * `string | Array<TextPart | ImagePart | FilePart>`，因此多模态消息
     * 可直接强类型构造，**无需 any 断言**（AGENTS.md 第 2 条禁止 any）。
     */
    const coreMessages: CoreMessage[] = messages.map(
      (m): CoreMessage => ({ role: m.role, content: m.content }),
    );

    /* 多模态：携带 Base64 图片时追加一条带 image part 的 user 消息 */
    const messagesForModel: CoreMessage[] =
      hasImage && viewportImage !== undefined
        ? [
            ...coreMessages,
            {
              role: 'user',
              content: [
                { type: 'text', text: '这是当前 3D 集群拓扑视口快照，请结合空间异常特征分析。' },
                { type: 'image', image: viewportImage },
              ],
            },
          ]
        : coreMessages;

    /**
     * 【注意：AI SDK v3 的 streamText 返回 Promise】
     * 签名是 `streamText(...): Promise<StreamTextResult<TOOLS>>`，
     * 必须先 await 才能访问 fullStream（v3 为了在返回前完成参数校验
     * 与 provider 初始化而改成异步；v4+ 才改回同步返回）。
     * 误写 `for await (const part of result.fullStream)` 会在 tsc 阶段
     * 报 "Property 'fullStream' does not exist on type 'Promise<...>'"。
     */
    const result = await streamText({
      model,
      system: systemPrompt,
      messages: messagesForModel,
      temperature: Number(process.env.AI_TEMPERATURE ?? '0.3'),
      maxRetries: Number(process.env.AI_MAX_RETRIES ?? '2'),
      abortSignal: signal,
      tools: {
        renderPodMetrics: tool({
          description: '渲染目标 Pod 的实时指标卡片（CPU/内存双轨 + 近 6 周期走势）',
          parameters: podMetricsSchema,
          execute: async (args: z.infer<typeof podMetricsSchema>): Promise<string> => {
            return `pod metrics card rendered for ${args.podName}`;
          },
        }),
        renderRootCauseAnalysis: tool({
          description: '渲染 SRE 根因分析报告卡（含 P0/P1 徽标、置信度、证据链与 RAG 溯源）',
          parameters: rootCauseSchema,
          execute: async (args: z.infer<typeof rootCauseSchema>): Promise<string> => {
            return `root cause card rendered: ${args.title}`;
          },
        }),
        proposeRemediationAction: tool({
          description: '提议一个可执行的 MCP 自愈动作（需用户二次确认后才会执行）',
          parameters: remediationSchema,
          execute: async (args: z.infer<typeof remediationSchema>): Promise<string> => {
            return `remediation proposed: ${args.actionType} on ${args.targetId}`;
          },
        }),
      },
    });

    /* ---- 遍历 fullStream 逐帧转发 ---- */
    for await (const part of result.fullStream) {
      if (signal.aborted) return true;

      if (part.type === 'text-delta') {
        emit({ type: 'text', content: part.textDelta });
        continue;
      }

      if (part.type === 'tool-call') {
        const toolName = part.toolName;
        const toolCallId = part.toolCallId;
        const mcpUri = `mcp://k8s-cluster/tools/${toolName}`;

        /* 步骤 1：tool-start（前端立即渲染骨架屏） */
        emit({ type: 'tool-start', toolCallId, toolName, mcpUri });

        /* 步骤 2：延迟 300ms —— 让骨架屏有可见的存在感 */
        await sleep(TOOL_RESULT_DELAY_MS_A, signal);

        /* 步骤 3：校验 args 后推 tool-result（前端据此水合卡片） */
        const validated = validateToolArgs(toolName, part.args);
        if (validated === null) {
          emit({
            type: 'text',
            content: `\n\n> ⚠️ 工具 \`${toolName}\` 返回的参数未通过校验，已跳过渲染以保护界面。\n\n`,
          });
          continue;
        }
        emit({
          type: 'tool-result',
          toolCallId,
          toolName,
          args: validated,
        });
        continue;
      }

      if (part.type === 'error') {
        /* 流内错误：交由外层 catch 决定是否回落引擎 B */
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }

    return true;
  } catch (error) {
    /* 任何异常（401 / 404 / 网络 / 模型不支持工具调用）→ 交回调用方回落 */
    console.error('[kubevision][chat] engine A failed, falling back to simulator:', error);
    return false;
  }
}

/**
 * validateToolArgs —— 按工具名校验模型生成的参数。
 *
 * @returns 通过校验的卡片载荷；校验失败返回 null
 */
function validateToolArgs(
  toolName: string,
  rawArgs: unknown,
): PodMetricsCardProps | RootCauseAlertProps | ActionConfirmProps | null {
  if (toolName === 'renderPodMetrics') {
    const parsed = podMetricsSchema.safeParse(rawArgs);
    return parsed.success ? (parsed.data as PodMetricsCardProps) : null;
  }
  if (toolName === 'renderRootCauseAnalysis') {
    const parsed = rootCauseSchema.safeParse(rawArgs);
    if (!parsed.success) return null;
    /* RootCauseAlertProps 还需 ragReferences —— 由前端/store 侧注入，
       此处留空数组占位（路由层不持有 RAG 引用，避免载荷膨胀） */
    return { ...parsed.data, ragReferences: [] } as RootCauseAlertProps;
  }
  if (toolName === 'proposeRemediationAction') {
    const parsed = remediationSchema.safeParse(rawArgs);
    if (!parsed.success) return null;
    return {
      ...parsed.data,
      mcpEndpoint: `mcp://k8s-cluster/tools/${parsed.data.actionType}`,
    } as ActionConfirmProps;
  }
  return null;
}

/* ========================================================================== */
/* 引擎 B 的 NDJSON 流式实现                                                    */
/* ========================================================================== */

/**
 * streamWithSimulator —— 引擎 B：确定性 SRE 仿真器（无 Key / 调用失败时接管）。
 *
 * 【核心流转】
 * 1. 用真实数据构造 Markdown 报告；
 * 2. 以打字机速率逐字推 { type:'text' }（按 CPS 换算每帧字符数与延迟）；
 * 3. 依次推三张卡片：
 *    renderPodMetrics  → tool-start → 450ms → tool-result（真实 Pod 指标）
 *    renderRootCauseAnalysis → tool-start → 450ms → tool-result（带真实 RAG 引用）
 *    proposeRemediationAction → tool-start → 450ms → tool-result（真实目标）
 *
 * 【为何 450ms 而非 300ms】仿真器没有真实网络耗时，骨架屏若只停留 300ms
 * 几乎无法被感知；450ms 刚好让用户看清「正在调用工具」这层信息。
 */
async function streamWithSimulator(params: {
  readonly ctx: ClusterContext;
  readonly runbooks: readonly RagRunbookDoc[];
  readonly hasImage: boolean;
  readonly emit: (event: ChatStreamEvent) => void;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { ctx, runbooks, hasImage, emit, signal } = params;

  /* ---- 1. 构造报告 ---- */
  const report = buildSimulatorReport(ctx, runbooks, hasImage);

  /* ---- 2. 打字机推文本（按块推送，避免逐字符造成过多帧） ---- */
  const cps = Math.max(10, Number(process.env.SIM_TYPING_CPS ?? String(DEFAULT_TYPING_CPS)));
  const CHUNK_SIZE = 6;
  const delayPerChunk = Math.max(8, Math.round((CHUNK_SIZE / cps) * 1000));

  for (let i = 0; i < report.length; i += CHUNK_SIZE) {
    if (signal.aborted) return;
    emit({ type: 'text', content: report.slice(i, i + CHUNK_SIZE) });
    await sleep(delayPerChunk, signal);
  }

  /* ---- 3. 目标解析（用户选中优先，修正「卡片张冠李戴」缺陷） ---- */
  const resolved = resolveSimulatorTarget(ctx);
  const target: ClusterFaultSnapshot | null = resolved.pod;

  /* ---- 3a. 卡片一：Pod 指标（真实数据，直接取自 clusterContext） ---- */
  if (target !== null) {
    const toolCallId = `sim-metrics-${Date.now()}`;
    emit({
      type: 'tool-start',
      toolCallId,
      toolName: 'renderPodMetrics',
      mcpUri: 'mcp://k8s-cluster/tools/renderPodMetrics',
    });
    await sleep(TOOL_RESULT_DELAY_MS_B, signal);
    const metricsArgs: PodMetricsCardProps = {
      podId: target.id,
      podName: target.name,
      namespace: target.namespace,
      cpuUsage: target.cpuUsage,
      memoryUsage: target.memoryUsage,
      restarts: target.restarts,
      /* 历史序列归一化为契约要求的 6 点（防客户端传入残缺窗口） */
      cpuHistory: normalizeHistory(target.cpuHistory),
      memHistory: normalizeHistory(target.memHistory),
    };
    emit({ type: 'tool-result', toolCallId, toolName: 'renderPodMetrics', args: metricsArgs });
    await sleep(120, signal);
  }

  /* ---- 4. 卡片二：根因分析（携带真实 RAG 引用） ---- */
  const severity: RootCauseAlertProps['severity'] =
    ctx.clusterHealthScore < 60 ? 'P0' : ctx.clusterHealthScore < 85 ? 'P1' : 'P2';
  const nodeTarget = resolved.node;
  const rootCauseTitle =
    target !== null
      ? `${target.name} 触发 ${target.status}，疑似资源超限或依赖异常`
      : nodeTarget !== null
        ? `节点 ${nodeTarget.name} 水位异常（CPU ${nodeTarget.cpuUsage.toFixed(1)}% / MEM ${nodeTarget.memUsage.toFixed(1)}%）`
        : `集群健康分下降至 ${ctx.clusterHealthScore}/100`;
  const evidenceChain: string[] = [];
  if (target !== null) {
    evidenceChain.push(
      `${target.nodeId} 上 ${target.name} 内存水位 ${target.memoryUsage.toFixed(1)}%`,
    );
    evidenceChain.push(`kubelet 记录 ${target.status}，累计重启 ${target.restarts} 次`);
  } else if (nodeTarget !== null) {
    evidenceChain.push(
      `节点 ${nodeTarget.name}（rack-${nodeTarget.rackIndex}）状态 ${nodeTarget.status}`,
    );
    evidenceChain.push(
      `节点水位 CPU ${nodeTarget.cpuUsage.toFixed(1)}% / MEM ${nodeTarget.memUsage.toFixed(1)}%`,
    );
  }
  evidenceChain.push(`集群健康分 ${ctx.clusterHealthScore}/100，活跃场景 ${ctx.activeChaos}`);
  if (runbooks[0] !== undefined) {
    evidenceChain.push(
      `知识库命中 ${runbooks[0].id}（Similarity ${((runbooks[0].similarityScore ?? 0) * 100).toFixed(1)}%）`,
    );
  }

  const rcCallId = `sim-rca-${Date.now()}`;
  emit({
    type: 'tool-start',
    toolCallId: rcCallId,
    toolName: 'renderRootCauseAnalysis',
    mcpUri: 'mcp://k8s-cluster/tools/renderRootCauseAnalysis',
  });
  await sleep(TOOL_RESULT_DELAY_MS_B, signal);
  const rcaArgs: RootCauseAlertProps = {
    severity,
    title: rootCauseTitle,
    confidence: runbooks.length > 0 ? 0.92 : 0.74,
    rootCauseSummary:
      runbooks[0] !== undefined
        ? `${runbooks[0].rootCauseMechanism}`
        : '未命中知识库手册，依据通用排障经验推断为资源超限或依赖不可达。',
    evidenceChain,
    impactScope:
      target !== null
        ? `${target.namespace} / ${target.name}（受影响副本 1 个，宿主机 ${target.nodeId}）`
        : nodeTarget !== null
          ? `节点 ${nodeTarget.name}（rack-${nodeTarget.rackIndex}）上的全部工作负载`
          : '集群整体（暂无单点故障）',
    ragReferences: [...runbooks],
  };
  emit({ type: 'tool-result', toolCallId: rcCallId, toolName: 'renderRootCauseAnalysis', args: rcaArgs });
  await sleep(120, signal);

  /* ---- 5. 卡片三：修复动作建议（真实目标 + 二次确认） ----
   *
   * 【数据绑定修正】动作卡此前存在两个真实缺陷：
   * 1. 动作类型取自 `ctx.selectedEntityType === 'node'`，与实际绑定的 target
   *    可能不一致——例如用户选中节点、但同时存在异常 Pod 时，会输出
   *    drain_node 却把 Pod 的 id 填进 targetId，语义自相矛盾；
   * 2. 无 target 时退化为 `ctx.selectedEntityId ?? 'unknown-target'`，
   *    把裸 ID 同时当作 targetId 与 targetName，甚至产出 'unknown-target'
   *    这类占位值——用户会看到一张「对未知目标执行操作」的卡片。
   *
   * 现统一改为：动作类型与目标全部由 resolveSimulatorTarget 的解析结果决定，
   * **Pod 优先**（restart_pod），仅当确无 Pod 级目标时才做节点级 drain_node，
   * 两者都没有则**整张卡不输出**（宁可无卡，不可假卡）。
   */
  /* nodeTarget 已在上方「卡片二」处由 resolved.node 解构，此处直接复用 */

  /**
   * 【为何用嵌套分支而非布尔标志 + 断言】
   * 布尔标志（hasPodTarget）无法让 TS 窄化 target 的类型，
   * 于是不得不写 `target as ClusterFaultSnapshot` 这类断言——
   * 断言绕过编译器检查，未来若 target 类型变化不会报错。
   * 改成 if/else if 分支后，`target !== null` 即可完成窄化，
   * 全程零类型断言（AGENTS.md 第 2 条的契约精神）。
   */
  if (target !== null) {
    /* ---- Pod 级目标：restart_pod（中危，无需二次确认） ---- */
    const actionCallId = `sim-action-${Date.now()}`;
    emit({
      type: 'tool-start',
      toolCallId: actionCallId,
      toolName: 'proposeRemediationAction',
      mcpUri: 'mcp://k8s-cluster/tools/proposeRemediationAction',
    });
    await sleep(TOOL_RESULT_DELAY_MS_B, signal);

    const actionArgs: ActionConfirmProps = {
      actionType: 'restart_pod',
      /* 真实 id / name 直接取自解析后的 Pod 快照，绝不使用裸 ID 或占位串 */
      targetId: target.id,
      targetName: target.name,
      paramDescription: `重启 Pod ${target.name}，容器将重新拉起（预计恢复时间 8s，期间该副本不可用）。`,
      mcpEndpoint: 'mcp://k8s-cluster/tools/restart_pod',
      isHighRisk: false,
    };
    emit({ type: 'tool-result', toolCallId: actionCallId, toolName: 'proposeRemediationAction', args: actionArgs });
  } else if (nodeTarget !== null) {
    /* ---- 节点级目标（确无 Pod 级目标时）：drain_node（高危，强制二次确认） ---- */
    const actionCallId = `sim-action-${Date.now()}`;
    emit({
      type: 'tool-start',
      toolCallId: actionCallId,
      toolName: 'proposeRemediationAction',
      mcpUri: 'mcp://k8s-cluster/tools/proposeRemediationAction',
    });
    await sleep(TOOL_RESULT_DELAY_MS_B, signal);

    const actionArgs: ActionConfirmProps = {
      actionType: 'drain_node',
      targetId: nodeTarget.id,
      targetName: nodeTarget.name,
      paramDescription: `驱逐节点 ${nodeTarget.name} 上的工作负载，Pod 将平滑迁移至其他节点（预计 30~60s 完成）。`,
      mcpEndpoint: 'mcp://k8s-cluster/tools/drain_node',
      isHighRisk: true,
    };
    emit({ type: 'tool-result', toolCallId: actionCallId, toolName: 'proposeRemediationAction', args: actionArgs });
  }
  /* 两者皆无 → 整张动作卡不输出（宁可无卡，不可对 'unknown-target' 假卡） */
}

/* ========================================================================== */
/* 请求校验                                                                    */
/* ========================================================================== */

/** 请求体最大字符数（含 Base64 图片，防超大载荷拖垮内存） */
const MAX_BODY_CHARS = 8_000_000;

/**
 * normalizeChaos —— 把不可信的 chaos 字符串收敛为合法的 ChaosScenario。
 *
 * 【为何需要】clusterContext 来自客户端，activeChaos 是 string 类型
 * （契约上宽松以兼容未来新增场景）。但 retrieveSreRunbooks 要求严格的
 * ChaosScenario 联合类型。此函数做白名单校验，非法值回落 'NONE'——
 * 既不使用 `as never` 之类绕过类型系统的写法（违反 AGENTS.md 第 2 条
 * 的契约精神），也保证引擎行为可预期。
 *
 * @param raw 原始 chaos 字符串
 * @returns 合法的 ChaosScenario
 */
function normalizeChaos(raw: string): 'NONE' | 'POD_OOM_SWARM' | 'NODE_CPU_SPIKE' | 'NET_PACKET_LOSS' {
  if (raw === 'POD_OOM_SWARM' || raw === 'NODE_CPU_SPIKE' || raw === 'NET_PACKET_LOSS') {
    return raw;
  }
  return 'NONE';
}

/**
 * parseRequestBody —— 解析并校验请求载荷（不可信输入的第一道防线）。
 *
 * @returns 校验通过的载荷；失败返回 null（调用方回 400）
 */
async function parseRequestBody(request: Request): Promise<ChatRequestBody | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > MAX_BODY_CHARS) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  /* ---- messages：至少一条，role/content 合法 ---- */
  if (!Array.isArray(obj.messages) || obj.messages.length === 0) return null;
  const messages: ChatMessage[] = [];
  for (const m of obj.messages) {
    if (typeof m !== 'object' || m === null) return null;
    const mm = m as Record<string, unknown>;
    const role = mm.role;
    const content = mm.content;
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof content !== 'string') return null;
    messages.push({ role, content });
  }

  /* ---- clusterContext：核心数值字段必须存在 ---- */
  const ctxRaw = obj.clusterContext;
  if (typeof ctxRaw !== 'object' || ctxRaw === null) return null;
  const c = ctxRaw as Record<string, unknown>;

  /* faultyPods / selectedPodSnapshot / nodes 走逐字段规范化，
     而不是 `as X[]` 断言——断言会把校验责任推给调用方，
     一旦客户端少传字段就会在渲染层炸开。 */
  const normalizePodList = (raw: unknown): ClusterFaultSnapshot[] => {
    if (!Array.isArray(raw)) return [];
    const out: ClusterFaultSnapshot[] = [];
    for (const item of raw) {
      const snap = normalizeFaultSnapshot(item);
      if (snap !== null) out.push(snap);
    }
    return out;
  };

  const normalizeNodeList = (raw: unknown): ClusterContext['nodes'] => {
    if (!Array.isArray(raw)) return [];
    const out: Array<ClusterContext['nodes'][number]> = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const n = item as Record<string, unknown>;
      if (typeof n.name !== 'string') continue;
      out.push({
        id: typeof n.id === 'string' ? n.id : n.name,
        name: n.name,
        status: typeof n.status === 'string' ? n.status : 'Unknown',
        cpuUsage: clampPercent(typeof n.cpuUsage === 'number' ? n.cpuUsage : 0),
        memUsage: clampPercent(typeof n.memUsage === 'number' ? n.memUsage : 0),
        rackIndex: typeof n.rackIndex === 'number' ? Math.trunc(n.rackIndex) : 0,
      });
    }
    return out;
  };

  const selectedPodSnapshot =
    c.selectedPodSnapshot === undefined ? undefined : normalizeFaultSnapshot(c.selectedPodSnapshot) ?? undefined;

  const clusterContext: ClusterContext = {
    selectedEntityId: typeof c.selectedEntityId === 'string' ? c.selectedEntityId : null,
    selectedEntityType: typeof c.selectedEntityType === 'string' ? c.selectedEntityType : null,
    activeChaos: typeof c.activeChaos === 'string' ? c.activeChaos : 'NONE',
    clusterHealthScore: typeof c.clusterHealthScore === 'number' ? clampPercent(c.clusterHealthScore) : 100,
    totalQps: typeof c.totalQps === 'number' ? Math.max(0, c.totalQps) : 0,
    faultyPods: normalizePodList(c.faultyPods),
    ...(selectedPodSnapshot !== undefined ? { selectedPodSnapshot } : {}),
    nodes: normalizeNodeList(c.nodes),
  };

  /* ---- viewportImage：可选，必须是 data URL ---- */
  let viewportImage: string | undefined;
  if (typeof obj.viewportImage === 'string' && obj.viewportImage.startsWith('data:image/')) {
    viewportImage = obj.viewportImage;
  }

  return { messages, clusterContext, viewportImage };
}

/* ========================================================================== */
/* 路由主体                                                                    */
/* ========================================================================== */

/**
 * POST —— 双擎流式对话入口。
 *
 * 【响应头设计】
 * - 'Content-Type': application/x-ndjson; charset=utf-8 —— 每行一个 JSON
 * - 'Cache-Control': no-cache, no-transform —— 禁缓存、禁压缩改写
 * - 'X-Accel-Buffering': no —— 关闭 nginx 缓冲，保证逐帧即时到达
 * - 'x-kubevision-engine': llm | simulator —— 实际生效的引擎（便于调试与断言）
 */
export async function POST(request: Request): Promise<Response> {
  const body = await parseRequestBody(request);
  if (body === null) {
    return Response.json({ error: 'invalid request body' }, { status: 400 });
  }

  const { messages, clusterContext, viewportImage } = body;
  const hasImage = viewportImage !== undefined;

  /* ---- 前置 RAG 检索（无论走哪个引擎都先做） ---- */
  const lastUserMessage =
    [...messages].reverse().find((m): boolean => m.role === 'user')?.content ?? '';
  /* 用「用户问题 + 异常 Pod 特征 + 混沌场景」共同构造检索查询，
     比只用用户问题命中率高得多（Pod 名里的服务特征词是强信号） */
  const faultyPodNames = clusterContext.faultyPods.map((p): string => p.name);
  const ragQuery = [
    lastUserMessage,
    ...faultyPodNames,
    clusterContext.activeChaos === 'NONE' ? '' : clusterContext.activeChaos,
  ]
    .filter((s): boolean => s.length > 0)
    .join(' ');

  const runbooks = retrieveSreRunbooks(
    ragQuery,
    normalizeChaos(clusterContext.activeChaos),
    faultyPodNames,
    RAG_TOP_K,
  );

  const systemPrompt = buildSystemPrompt(clusterContext, runbooks, hasImage);

  /* ---- 引擎选择 ---- */
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  const modelName = process.env.AI_MODEL_NAME ?? 'glm-4-flash';
  const useLLM = typeof apiKey === 'string' && apiKey.trim().length > 0;

  /* ---- 构造 NDJSON 流 ---- */
  const encoder = new TextEncoder();

  /**
   * 【引擎标识的两处声明（各自局限）】
   *
   * `engineAtResponseTime` 只反映「请求头发出那一刻」的**预判**结果：
   * 有 Key 就写 llm。但引擎 A 是否真能成功要到流开始后才能知道——
   * 届时响应头早已发给客户端，无法再修改。
   *
   * 因此实际生效的引擎必须在**流内**再声明一次：
   * 降级发生时先推送一条 `{ type:'engine', engine:'simulator', reason:... }`
   * 事件，让前端与 E2E 都能读到真实结果。这是 HTTP 流式响应的固有约束，
   * 不是设计疏漏——响应头代表意图，流内事件代表事实。
   */
  const engineAtResponseTime: 'llm' | 'simulator' = useLLM ? 'llm' : 'simulator';
  let isClosed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const safeClose = (): void => {
    if (isClosed) return;
    isClosed = true;
    if (controllerRef !== null) {
      try {
        controllerRef.close();
      } catch {
        /* 已被客户端取消，属正常竞态 */
      }
      controllerRef = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      controllerRef = controller;

      /** 单帧写入（带状态锁与异常兜底） */
      const emit = (event: ChatStreamEvent): void => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          isClosed = true;
        }
      };

      const signal = request.signal;

      try {
        /* ============ 推理步骤 1：意图规划 ============ */
        const intentStep: AgentReasoningStep = {
          stepIndex: 0,
          phase: 'INTENT_PLANNING',
          title: '解析运维意图与集群上下文',
          detail:
            `识别到用户请求针对「${clusterContext.selectedEntityId ?? '全集群'}」，` +
            `当前演练场景 ${clusterContext.activeChaos}，集群健康分 ${clusterContext.clusterHealthScore}/100，` +
            `异常 Pod ${clusterContext.faultyPods.length} 个。` +
            (lastUserMessage.length > 0 ? `用户原话：${lastUserMessage.slice(0, 120)}` : ''),
          latencyMs: SIM_LATENCY.intent,
        };
        emit({ type: 'reasoning', step: intentStep });
        await sleep(160, signal);

        /* ============ 推理步骤 2（条件）：多模态视觉 ============ */
        let nextStepIndex = 1;
        if (hasImage) {
          /**
           * 【体积展示】Base64 相对原始二进制的膨胀系数约 4/3，故乘 0.75 还原。
           * 小于 1 KB 时改用字节表述——直接 Math.round 到 KB 会显示「约 0 KB」，
           * 那是会让用户怀疑截图没有被正确接收的错误文案（实测发现）。
           */
          const approxBytes = Math.round(viewportImage.length * 0.75);
          const sizeLabel = approxBytes >= 1024
            ? `约 ${(approxBytes / 1024).toFixed(1)} KB Base64`
            : `约 ${approxBytes} 字节 Base64`;
          const visionStep: AgentReasoningStep = {
            stepIndex: nextStepIndex,
            phase: 'MULTIMODAL_VISION',
            title: '解析 3D WebGL 拓扑快照空间异常特征',
            detail:
              `接收到视口快照（${sizeLabel}），执行空间布局分析：` +
              `校验机架实例着色（翠绿/琥珀/鲜红分布）、地面警示波纹环激活范围、` +
              `以及异常机架与遥测数据的空间一致性。`,
            latencyMs: SIM_LATENCY.vision,
          };
          emit({ type: 'reasoning', step: visionStep });
          nextStepIndex += 1;
          await sleep(160, signal);
        }

        /* ============ 推理步骤 3：RAG 检索 ============ */
        const ragStep: AgentReasoningStep = {
          stepIndex: nextStepIndex,
          phase: 'RAG_RETRIEVAL',
          title: '检索 SRE 知识库并计算余弦相似度',
          detail:
            runbooks.length === 0
              ? '混合检索（词频余弦 + 关键词 + 故障上下文先验）未命中匹配手册。'
              : `混合检索命中 ${runbooks.length} 条知识切片：\n` +
                runbooks
                  .map(
                    (doc): string =>
                      `· ${doc.id} — ${doc.title}\n  Similarity: ${((doc.similarityScore ?? 0) * 100).toFixed(1)}%`,
                  )
                  .join('\n'),
          latencyMs: SIM_LATENCY.rag,
        };
        emit({ type: 'reasoning', step: ragStep });
        nextStepIndex += 1;
        await sleep(160, signal);

        /* ============ 推理步骤 4：MCP 工具路由 ============ */
        const mcpStep: AgentReasoningStep = {
          stepIndex: nextStepIndex,
          phase: 'MCP_TOOL_INVOKE',
          title: '路由至 MCP 工具链',
          detail:
            '根据诊断需要，将调用指标渲染、根因报告与动作提议三类 MCP 工具；' +
            '所有写操作（自愈动作）均需用户二次确认后由前端执行。',
          mcpUri: 'mcp://k8s-cluster/tools/renderPodMetrics',
          latencyMs: SIM_LATENCY.mcp,
        };
        emit({ type: 'reasoning', step: mcpStep });
        await sleep(160, signal);

        /* ============ 引擎执行 ============ */
        if (useLLM) {
          const ok = await streamWithLLM({
            apiKey: apiKey as string,
            baseURL,
            modelName,
            messages,
            systemPrompt,
            hasImage,
            viewportImage,
            emit,
            signal,
          });

          if (!ok) {
            /* 引擎 A 失败 → 无缝回落引擎 B，并先声明实际引擎（流内事实） */
            emit({
              type: 'engine',
              engine: 'simulator',
              reason: 'llm invocation failed (network / quota / model unsupported); local deterministic SRE engine took over',
            });
            emit({
              type: 'text',
              content:
                '> ⚠️ 远程模型调用未成功（可能是网络或额度问题），已自动切换至本地确定性 SRE 推理引擎。\n\n',
            });
            await streamWithSimulator({
              ctx: clusterContext,
              runbooks,
              hasImage,
              emit,
              signal,
            });
          } else {
            /* 引擎 A 成功：补一条引擎声明，使流内事实完整 */
            emit({ type: 'engine', engine: 'llm', reason: `model=${modelName}` });
          }
        } else {
          /* 未配置 Key → 直接走引擎 B */
          emit({
            type: 'engine',
            engine: 'simulator',
            reason: 'OPENAI_API_KEY not configured; using local deterministic SRE engine by design',
          });
          await streamWithSimulator({
            ctx: clusterContext,
            runbooks,
            hasImage,
            emit,
            signal,
          });
        }

        safeClose();
      } catch (error) {
        /* 客户端取消属正常终止，不记录为错误 */
        const aborted = signal.aborted || (error instanceof Error && error.message === 'aborted');
        if (!aborted) {
          console.error('[kubevision][chat] stream failed:', error);
          emit({
            type: 'text',
            content: `\n\n> ❌ 推理中断：${error instanceof Error ? error.message : 'unknown error'}\n\n`,
          });
        }
        safeClose();
      }
    },

    cancel(): void {
      /* 客户端 reader.cancel()：标记关闭，异步循环会因 signal.aborted 尽快退出 */
      isClosed = true;
      controllerRef = null;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': NDJSON_CONTENT_TYPE,
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
      /* 预判引擎（有 Key 即 llm）；实际生效引擎以流内 { type:'engine' } 事件为准 */
      'x-kubevision-engine': engineAtResponseTime,
    },
  });
}
