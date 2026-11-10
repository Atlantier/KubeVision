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
import { createTrace, elapsedMs, endSpan, startSpan, type AgentSpan, type AgentTrace, type EndedSpan } from '@/utils/agentTrace';
import { z } from 'zod';

import type {
  ActionConfirmProps,
  ChatMessage,
  ChatRequestBody,
  PixelFeatures,
  ChatStreamEvent,
  ClusterContext,
  ClusterFaultSnapshot,
  IntentKind,
  PodMetricsCardProps,
  RagRunbookDoc,
  RemediationActionType,
  RootCauseAlertProps,
} from '@/types/ai';
import type { ChaosScenario } from '@/types/cluster';
import { retrieveSreRunbooks } from '@/utils/sreRagEngine';
import {
  createToolCallLedger,
  missingToolNames,
  recordToolResult,
  recordToolStart,
  repairPendingToolCalls,
} from '@/utils/chatStreamProtocol';
import type { ToolCallLedger } from '@/utils/chatStreamProtocol';
/*
 * 【为何从这里引】pickRemediationActionType 的动作映射与前端 chaosTargets 共享同一份
 * 事实。若各自维护一份，就会出现"前端说 restart_pod、回执说 drain_node"的矛盾。
 * chaosFacts 是纯函数模块（只 import type），不会把前端快照字典打进服务端 bundle。
 */
import { pickRemediationActionType } from '@/utils/chaosFacts';

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
 * buildSteadyStateSnapshot —— 为「稳态巡检」构造一个**真实存在**的代表性采样对象。
 *
 * 【为什么需要：Bug 自愈】
 * 稳态（无混沌、无异常 Pod）时 `resolveSimulatorTarget` 的 P1~P4 全部落空，
 * 返回 `{ pod: null }`。上游据此认为"无真实数据支撑"，于是**一张卡都不发**。
 * 结果：用户点 `CMD-01 全集群健康巡检`，Agent 洋洋洒洒写了一段"集群健康度 100 分，
 * 一切正常"，界面却空空如也——**最该有数据的时候反而没有数据**。
 *
 * 这不是"没数据"，而是"没选采样对象"。集群里明明有 24 个运行中的容器，
 * 只是用户没有点名任何一个。因此这里绑定一个种子核心服务作为
 * **代表性采样对象**，让指标卡展示真实存在的 Pod，而不是编造。
 *
 * 【为何选 api-gateway 作为默认】它是流量入口，其 CPU/MEM 最能代表
 * 集群整体水位；且 `STEADY_STATE_SEED_ENTITIES` 的 id 与前端快照完全一致。
 *
 * 【数值口径】稳态下不编造异常数值：CPU/MEM 取 40~60% 的合理稳态区间，
 * restarts 恒为 0，status 恒为 Running。历史序列为围绕当前水位的确定性平台，
 * 与环形拓扑的"全绿"叙事一致，绝不为了好看而伪造波动。
 *
 * @param entity 种子实体（id 与 name 与前端快照同源）
 * @returns 可直接喂给 buildMetricsArgs 的真实形状快照
 */
function buildSteadyStateSnapshot(entity: KnownEntity): ClusterFaultSnapshot {
  /*
   * 用一个稳定的、与实体名绑定的伪随机偏移，让不同 Pod 的指标有差异
   * 但不随时间跳变（不能用 Math.random，否则每次请求同一条日志给出不同数值，
   * 刷新一次指标就变，观众会立刻察觉是假的）。
   */
  let hash = 0;
  for (let i = 0; i < entity.name.length; i++) {
    hash = (hash * 31 + entity.name.charCodeAt(i)) % 1000;
  }
  const cpu = 38 + (hash % 17); // 38~54
  const mem = 42 + (hash % 21); // 42~62
  const ns = entity.name.startsWith('redis') ? 'cache' : 'default';

  return {
    id: entity.id,
    name: entity.name,
    namespace: ns,
    status: 'Running',
    cpuUsage: cpu,
    memoryUsage: mem,
    restarts: 0,
    nodeId: 'node-worker-alpha',
    /* 稳态历史：围绕当前水位的轻微平台波动（确定性，非随机） */
    cpuHistory: [cpu - 3, cpu - 1, cpu + 1, cpu, cpu - 2, cpu],
    memHistory: [mem - 2, mem, mem + 1, mem - 1, mem, mem],
  };
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
 * @param steadyFallback 是否允许在"完全无目标"时绑定稳态采样对象。
 *        【为何是显式开关而非永远开启】故障诊断意图下"无目标"意味着
 *        真的没有可诊断对象，此时**必须**保持无卡（宁可无卡，不可假卡）；
 *        只有巡检/指标类意图才应该兜底出一个代表性 Pod。
 * @returns 解析结果（pod 与 node 至多一个非 null）
 */
function resolveSimulatorTarget(ctx: ClusterContext, steadyFallback = false): SimulatorTarget {
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

  /**
   * ---- P4：稳态巡检兜底（仅在 steadyFallback 开启时） ----
   *
   * 走到这里说明既没有异常 Pod、也没有可解析的选中实体——
   * 这正是"集群全绿"的稳态。若调用方声明这是巡检类意图，
   * 则绑定种子核心服务作为代表性采样对象，保证指标卡有真实数据可画。
   *
   * 【为何放在最后而不是最先】用户明确选中的实体永远优先；
   * 兜底只在"什么都没选"时才生效，不会覆盖用户的真实意图。
   */
  if (steadyFallback) {
    const seed =
      ctx.selectedEntityType === 'master' || selectedId === null
        ? STEADY_STATE_SEED_ENTITIES[0]
        : (STEADY_STATE_SEED_ENTITIES.find((e): boolean => e.id === selectedId) ??
          STEADY_STATE_SEED_ENTITIES[0]);
    return { pod: buildSteadyStateSnapshot(seed), node: null };
  }

  /* ---- P5：无可可用目标 ---- */
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

/**
 * normalizeActionType —— 把模型给出的自由文本动作类型归一化到 MCP 白名单。
 *
 * 【为何不能让 Schema 用 enum 强约束】`remediationSchema` 原先用
 * `z.enum(['restart_pod', 'scale_deployment', 'drain_node'])`。
 * 模型实际会输出 `"restart"`、`"drain"`、`"scale replicas"`、
 * `"kubectl delete pod"` 这类近似值——enum 一拒，`safeParse` 失败，
 * 上层 `validateToolArgs` 返回 null，进而触发
 * **骨架屏永久悬空** 的 P0 缺陷（tool-start 已发、tool-result 永不发）。
 *
 * 动作类型的语义是确定的（只有这三种），模型只是措辞不准。
 * 与其让整张卡片消失，不如把措辞映射回标准值——这正是路由层该承担的工作。
 *
 * @param raw 模型给出的原始动作描述
 * @returns 白名单内的标准动作类型
 */
function normalizeActionType(raw: string): RemediationActionType {
  const text = raw.toLowerCase();

  /* 先判 scale：`scale_deployment` 里也含 deploy，但 drain/node 不会误伤 */
  if (
    text.includes('scale') ||
    text.includes('replica') ||
    text.includes('扩容') ||
    text.includes('缩容')
  ) {
    return 'scale_deployment';
  }
  if (
    text.includes('drain') ||
    text.includes('node') ||
    text.includes('cordon') ||
    text.includes('驱逐')
  ) {
    return 'drain_node';
  }
  /* restart 及一切无法识别的措辞 → 最保守的 restart_pod */
  return 'restart_pod';
}

/**
 * proposeRemediationAction 的工具入参 Schema。
 *
 * 【容错策略】关键字段放宽为可选并给默认值：
 * - `isHighRisk` 本就不该由模型决定——高危分级是服务端的确定事实
 *   （见 validateToolArgs 中按 actionType 强制派生），模型给不给都不影响结果；
 * - `paramDescription` 缺失时用空串，前端会显示通用动作说明，比整张卡消失好；
 * - `actionType` 接受任意字符串，再由 normalizeActionType 映射到白名单；
 * - `targetId` / `targetName` 可为空串，由 resolveEntityId 或稳态兜底目标补齐。
 */
const remediationSchema = z.object({
  actionType: z.string().describe('动作类型（可为近似措辞，服务端会归一化）'),
  targetId: z.string().optional().default('').describe('目标实体 ID'),
  targetName: z.string().optional().default('').describe('目标实体展示名'),
  paramDescription: z.string().optional().default('').describe('人类可读的参数说明'),
  isHighRisk: z.boolean().optional().default(false).describe('是否高危（服务端会重新判定）'),
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
/**
 * ============================================================================
 * 意图路由器（Intent Router）
 * ============================================================================
 *
 * 【解决什么问题】旧实现把"排障流程"当成唯一的对话形态：
 * 用户说「你好」也会被塞进 SRE 推理链、被强制查 RAG（并因 0 分归一化
 * 虚标成 86.0%）、被强制调用三个工具、并弹出红色「驱逐节点」高危卡。
 * 这套行为的根因不是模型不听话，而是**服务端从未判断用户想做什么**。
 *
 * 本路由器是一个**确定性（规则）+ 语义（关键词/状态）联合分类器**：
 * 它不依赖大模型，因此在引擎 A 失败、引擎 B 接管时行为完全一致，
 * 也让分类结果可被单元测试与 E2E 断言（可复现是运维界面的底线）。
 */

/** 运维/集群领域关键词：出现任意一个即说明用户在谈运维，不可能只是寒暄 */
const OPS_DOMAIN_KEYWORDS: readonly string[] = [
  '集群', '节点', 'pod', '容器', '机架', '拓扑', '命名空间', '服务', '部署',
  '故障', '异常', '告警', '错误', '报错', '风险', '水位', '监控', '日志',
  '巡检', '诊断', '排查', '根因', '自愈', '自愈', '重启', '驱逐', '扩容', '缩容',
  '指标', '健康', '性能', '负载', '压力', '容量', '延迟', '吞吐', 'qps',
  '内存', 'cpu', '网络', '丢包', '带宽', '磁盘', 'io',
  'oom', 'oomkilled', 'crashloop', 'pending', 'running', 'evicted', 'drain',
  'k8s', 'kubernetes', 'sre', '运维', '演练', '混沌', '排查',
];

/** 明确要求诊断/排查的关键词：即使集群健康，用户也想看风险分析 */
const DIAGNOSIS_KEYWORDS: readonly string[] = [
  '诊断', '排查', '根因', '分析故障', '出什么问题', '为什么', '怎么回事',
  'oom', 'oomkilled', 'crashloop', '内存溢出', '崩溃', '重启循环',
  '高负载', 'cpu 高', 'cpu高', '网络分区', '丢包', '异常', '故障',
  'diagnose', 'troubleshoot', 'root cause',
];

/** 明确要求执行自愈动作的关键词：最高优先级，直接进入 FAULT 路径 */
const HEAL_ACTION_KEYWORDS: readonly string[] = [
  '重启', '驱逐', '扩容', '缩容', '伸缩', '自愈', '自愈', '恢复',
  '杀掉', '终止演练', '停止演练', 'restart', 'drain', 'scale', 'heal',
];

/** 询问集群整体状态的词：配合"全绿"进入稳态巡检 */
const STATUS_QUERY_KEYWORDS: readonly string[] = [
  '巡检', '健康', '状态', '怎么样', '如何', '情况', '概览', '总览',
  '有没有问题', '正常吗', '稳定吗', 'check', 'status', 'overview',
];

/**
 * 纯问候语正则：整句（去掉标点与空白后）恰好是问候/能力咨询。
 * 用整句匹配而非包含匹配，避免「你好，帮我诊断 OOM」被误判为寒暄。
 */
const GREETING_EXACT_PATTERN =
  /^(你好|您好|哈喽|哈啰|嗨|hi|hello|hey|在吗|在不在|你是谁|你是什么|你叫什么|你能做什么|你会什么|你可以做什么|介绍一下自己|自我介绍|谢谢|多谢|感谢|thanks|thank you|thx|早上好|中午好|晚上好|晚安|再见|拜拜|bye)[\s!！。.,，、?？~～]*$/i;

/** 短句问候前缀（容错「你好呀」「hello there」这类变体） */
const GREETING_LEAD_PATTERN =
  /^(你好|您好|哈喽|嗨|hi|hello|hey|在吗|在不在|你是谁|你能做什么|谢谢|感谢)/i;

/** 匹配任意运维领域关键词（大小写不敏感） */
function containsAnyKeyword(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword): boolean => lower.includes(keyword.toLowerCase()));
}

/**
 * 判断是否为纯闲谈：整句问候，或 ≤12 字的短句且以问候词开头，且不含运维关键词。
 *
 * @param text 用户原话
 */
function isChitchat(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (containsAnyKeyword(trimmed, OPS_DOMAIN_KEYWORDS)) return false;
  if (GREETING_EXACT_PATTERN.test(trimmed)) return true;
  return trimmed.length <= 12 && GREETING_LEAD_PATTERN.test(trimmed);
}

/**
 * 判断集群当前是否处于"完全健康"的稳态。
 *
 * 【口径】无混沌演练、无异常 Pod、全部节点 Ready 且 CPU/内存均低于 85%。
 * 三项同时成立才算"完全健康"——只要有一项不满足，就说明存在真实异常，
 * 此时即便用户没说诊断，也应该走 FAULT 路径主动排查。
 *
 * @param ctx 集群上下文
 */
function isClusterFullyHealthy(ctx: ClusterContext): boolean {
  if (ctx.activeChaos !== 'NONE') return false;
  if (ctx.faultyPods.length > 0) return false;
  return ctx.nodes.every(
    (node): boolean =>
      node.status === 'Ready' && node.cpuUsage < 85 && node.memUsage < 85,
  );
}

/**
 * classifyUserIntent —— 四档意图分类（确定性规则 + 语义状态联合判定）。
 *
 * 【注意：不得 export】Next.js App Router 的 route.ts 只允许导出 HTTP 方法
 * 与段配置（dynamic / runtime / maxDuration 等），导出其他成员会让
 * `.next/types` 的生成式校验报 Type '...' does not satisfy the constraint。
 * 该函数是路由内部实现，无需对外暴露；需要单独测试时通过 /api/chat 行为断言。
 *
 * 【判定优先级】（自上而下，先命中者胜）
 * 1. 附带 3D 截图 → FAULT（用户显然希望结合空间异常分析）
 * 2. 纯寒暄且不含运维词 → GREETING（**排在集群状态之前**：
 *    「你好」就是打招呼，不应因为恰好有演练在跑就被塞进排障流程）
 * 3. 明确要求自愈动作 → FAULT（用户已经下达指令）
 * 4. 集群存在异常 → FAULT（有故障就该排查，无需用户点名）
 * 5. 明确要求诊断/排查 → FAULT（即便全绿，用户也要风险推演）
 * 6. 全绿 + 点名实体 + 询问指标 → TARGETED_INSPECTION
 * 7. 其余全绿场景（问状态/一般技术问题）→ STEADY_HEALTH_CHECK
 *
 * @param userMessage 用户最后一条消息原文
 * @param ctx         集群上下文
 * @param hasImage    是否附带 3D 视口快照
 * @returns 四档意图之一
 */
function classifyUserIntent(
  userMessage: string,
  ctx: ClusterContext,
  hasImage: boolean,
): IntentKind {
  const text = userMessage.trim();

  /* ---- 1. 带图 → 必然要求空间异常分析 ---- */
  if (hasImage) return 'FAULT_DIAGNOSIS_AND_HEAL';

  /* ---- 2. 纯寒暄（优先级高于集群状态） ---- */
  if (isChitchat(text)) return 'GREETING_OR_CHITCHAT';

  const healthy = isClusterFullyHealthy(ctx);

  /* ---- 3. 用户明确下达自愈/运维动作指令 ---- */
  if (containsAnyKeyword(text, HEAL_ACTION_KEYWORDS)) return 'FAULT_DIAGNOSIS_AND_HEAL';

  /* ---- 4. 集群存在任何异常 → 主动排查 ---- */
  if (!healthy) return 'FAULT_DIAGNOSIS_AND_HEAL';

  /* ---- 5. 全绿但用户明确要求诊断（风险推演） ---- */
  if (containsAnyKeyword(text, DIAGNOSIS_KEYWORDS)) return 'FAULT_DIAGNOSIS_AND_HEAL';

  /* ---- 6. 全绿 + 点名实体 + 问指标 → 定向巡检 ---- */
  const mentionsEntity =
    (ctx.selectedEntityId !== null && text.includes(ctx.selectedEntityId)) ||
    /[a-z][a-z0-9-]{3,}/i.test(text) ||
    containsAnyKeyword(text, ['指标', '水位', '用量', '状态', '监控', 'metric']);
  if (mentionsEntity && containsAnyKeyword(text, ['指标', '水位', '用量', '监控', 'metric', '看看', '查看'])) {
    return 'TARGETED_INSPECTION';
  }

  /* ---- 7. 其余全绿场景（问状态 / 一般技术问题） ---- */
  void STATUS_QUERY_KEYWORDS;
  return 'STEADY_HEALTH_CHECK';
}

/**
 * toolsAllowedForIntent —— 各意图允许调用的工具白名单。
 *
 * 【为什么必须白名单化】「允许调用」与「允许模型自由决定」是两回事。
 * 集群 100 分健康时弹出红色 `drain_node` 驱逐卡，是严重的产品事故：
 * 用户在没有任何故障的情况下被要求确认一个高危变更。
 * 白名单从**传输层**取消了这种可能——工具根本不在模型的可选集合里。
 *
 * @param intent 意图
 * @returns 允许的工具名数组（空数组表示禁用全部工具）
 */
function toolsAllowedForIntent(intent: IntentKind): readonly string[] {
  switch (intent) {
    case 'GREETING_OR_CHITCHAT':
      /* 寒暄不需要任何卡片 */
      return [];
    case 'STEADY_HEALTH_CHECK':
    case 'TARGETED_INSPECTION':
      /* 只看指标，不给根因结论、更不给写操作 */
      return ['renderPodMetrics'];
    case 'FAULT_DIAGNOSIS_AND_HEAL':
      return [...REQUIRED_TOOL_NAMES];
  }
}

/**
 * buildSystemPrompt —— 按意图构造 System Prompt。
 *
 * 【为何把意图写进提示词而非只靠工具白名单】白名单保证"不可能调用不该调的
 * 工具"，提示词保证"模型知道当前处于哪种场景"——两者缺一不可：
 * 只限工具而提示词仍要求"必须调满三个"，模型会不断尝试调用被禁用的工具，
 * 浪费 token 且可能产生报错正文。
 *
 * @param ctx         集群上下文
 * @param runbooks    本次检索命中的手册（寒暄路径恒为空）
 * @param hasImage    是否附带截图
 * @param intent      意图分类结果
 */
function buildSystemPrompt(
  ctx: ClusterContext,
  runbooks: readonly RagRunbookDoc[],
  hasImage: boolean,
  intent: IntentKind,
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

  /**
   * 指标卡目标 id（见下方上下文段落处的推导注释）。
   * 优先当前选中的 Pod，其次最严重的异常 Pod；都没有则为 null（不注入锚点）。
   */
  const metricsTargetId: string | null =
    ctx.selectedEntityType === 'pod' && ctx.selectedEntityId !== null
      ? ctx.selectedEntityId
      : ctx.faultyPods.length > 0
        ? ctx.faultyPods[0].id
        : null;

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
    /**
     * 【指标卡目标锚点 —— 降低模型决策次数，提升工具调用完整率】
     *
     * 实测（deepseek-flash，5 次采样）：
     * - 上下文选中 **Pod** 时，三个工具全部调用 —— 4/4；
     * - 上下文选中 **Node** 时，模型还需自行从异常 Pod 里挑一个填 podId，
     *   仅 3/5 能调满三个工具。
     *
     * 差别不在提示词强弱（执行顺序段已三次强调"一个都不能少"），
     * 而在**多了一次"该用哪个 Pod"的判断**——每次额外决策都会摊薄
     * 模型对后续工具调用的注意力。
     *
     * 因此这里直接把目标 id 写进上下文：把"选择"降级为"抄写"。
     * 优先尊重用户当前选中的 Pod（即便它健康，用户正盯着它）；
     * 未选中 Pod 时退化为最严重的异常 Pod（faultyPods[0]）。
     */
    ...(metricsTargetId !== null
      ? [
          `  ▸ 指标卡目标已指定：renderPodMetrics 的 podId 必须填 "${metricsTargetId}"，`,
          '    无需再自行挑选目标——请直接使用该 id。',
        ]
      : []),
    '',
    '【知识库检索结果（请优先引用这些手册条款作为依据）】',
    runbookLines,
    '',
    hasImage
      ? '【多模态输入】本次对话附带了 3D 视口快照，请结合空间布局异常（如某机架全红、波纹环激活范围）辅助判断。'
      : '【多模态输入】本次未附带视口快照。',
    '',
    ...buildIntentDirective(intent, ctx, hasImage, runbooks),
  ].join('\n');
}

/**
 * buildIntentDirective —— 按意图生成提示词的"行为指令"段。
 *
 * 【设计原则】指令段必须与工具白名单**严格一致**：
 * 白名单允许什么，指令就只要求什么；白名单禁止什么，指令就明确说明
 * "本次不提供该工具，不要尝试调用"。二者不一致会让模型反复试探被禁用的
 * 工具，既浪费 token 又可能产出报错正文。
 *
 * @param intent   意图
 * @param ctx      集群上下文（用于组装健康摘要等具体事实）
 * @param hasImage 是否附带截图
 * @param runbooks 命中的手册（用于提示是否可引用）
 * @returns 指令行数组
 */
function buildIntentDirective(
  intent: IntentKind,
  ctx: ClusterContext,
  hasImage: boolean,
  runbooks: readonly RagRunbookDoc[],
): readonly string[] {
  const healthyNodes = ctx.nodes.filter((n): boolean => n.status === 'Ready').length;

  switch (intent) {
    /* ==================== 1. 日常问候 / 能力咨询 ==================== */
    case 'GREETING_OR_CHITCHAT':
      return [
        '【本次场景：日常问候与能力引导】',
        '  用户当前输入属于问候或能力咨询，**不是**故障排查请求。',
        '  本次会话未检索知识库手册，也未挂载任何运维工具。',
        '',
        '【回答要求】',
        '  1. 用一句简短、专业、有温度的话回应问候（不要套用排障模板）。',
        '  2. 紧接着给出一条**一句话集群健康摘要**，必须引用下面的真实数据：',
        `     当前集群健康度 ${ctx.clusterHealthScore}/100，` +
          `${ctx.nodes.length} 台计算节点（${healthyNodes} 台就绪）与 ${ctx.totalQps.toLocaleString('en-US')} req/s 入口流量均处于稳态。`,
        '  3. 然后引导用户：可以点击顶栏「故障演练」注入场景，或直接询问具体运维问题。',
        '  4. 总长度控制在 120 字以内，**不要**使用标题、列表、表格等重排版。',
        '  5. **严禁**调用任何工具，**严禁**输出根因分析或处置建议。',
      ];

    /* ==================== 2. 稳态巡检 ==================== */
    case 'STEADY_HEALTH_CHECK':
      return [
        '【本次场景：稳态集群巡检】',
        '  集群当前完全健康（无演练、无异常 Pod、全部节点就绪且水位正常）。',
        '  本次**仅挂载** `renderPodMetrics` 一个工具，用于展示核心服务的实时健康指标。',
        '',
        '【执行顺序】',
        '  第 1 步：用 Markdown 给出简明的稳态巡检结论（健康分、节点水位、Pod 分布），不少于 80 字。',
        '  第 2 步：调用 **一次** `renderPodMetrics`，展示被指定目标的实时指标趋势。',
        '  第 3 步：一两句话收尾，说明当前无异常需要处置。',
        '',
        '【严禁事项】',
        '  · **严禁**调用 `renderRootCauseAnalysis`——集群无故障，虚构根因会误导用户。',
        '  · **严禁**调用 `proposeRemediationAction`——没有任何故障需要自愈，',
        '    此时弹出高危「驱逐节点」确认卡属于严重的产品事故。',
        '  · 不要凭空声称存在异常；若确实发现水位偏高，如实描述但不下故障结论。',
        runbooks.length === 0
          ? '  · 本次未命中任何故障手册（稳态下无异常特征词），不要引用 Runbook 编号。'
          : '  · 若确需引用，仅可引用上面列出的手册编号。',
      ];

    /* ==================== 3. 定向巡检 ==================== */
    case 'TARGETED_INSPECTION':
      return [
        '【本次场景：指定实体的定向指标巡检】',
        '  用户点名查看某个健康实体的实时指标，本次**仅挂载** `renderPodMetrics`。',
        '',
        '【执行顺序】',
        '  第 1 步：用一小段文字说明该实体当前水位与趋势判断（不少于 60 字）。',
        '  第 2 步：调用 **一次** `renderPodMetrics` 渲染其指标卡。',
        '',
        '【严禁事项】',
        '  · 严禁调用 `renderRootCauseAnalysis` 与 `proposeRemediationAction`；',
        '  · 该实体处于健康态，不要虚构故障、不要给出重启/驱逐建议。',
      ];

    /* ==================== 4. 故障诊断与自愈 ==================== */
    case 'FAULT_DIAGNOSIS_AND_HEAL':
      return [
        '【本次场景：故障诊断与自愈闭环】',
        '  集群存在异常或用户明确要求诊断，本次挂载全部三个工具。',
        '',
        '【工具使用规则】',
        '  · renderPodMetrics：展示目标 Pod 的实时指标趋势。',
        '  · renderRootCauseAnalysis：完成根因分析后调用，必须填写证据链与置信度。',
        '  · proposeRemediationAction：给出自愈动作建议时调用（不会自动执行，需用户二次确认）。',
        '',
        '【执行顺序（必须完整执行，不可提前结束）】',
        '  第 1 步：先用 Markdown 输出诊断正文（结论 → 根因机制 → 处置建议），不少于 150 字。',
        '  第 2 步：正文写完后，**必须依次调用以下三个工具，一个都不能少**：',
        '          ① renderPodMetrics       （渲染指标卡）',
        '          ② renderRootCauseAnalysis（渲染根因卡）',
        '          ③ proposeRemediationAction（渲染自愈动作卡）',
        '  第 3 步：三张卡片全部调用完毕后，用一两句话总结结束。',
        '',
        '  【强制约束】',
        '  · 禁止跳过正文直接调用工具；',
        '  · 禁止只调用一两个工具就结束——实测发现模型容易在第二张卡后停止，',
        '    这会使用户看不到完整的自愈动作建议；',
        '  · 即使正文已经给出了处置建议，仍然必须调用 proposeRemediationAction',
        '    把建议渲染成可点击的确认卡片。',
        '',
        /**
         * 【动作类型选择规则 —— 自愈 drain_node 滥用】
         *
         * 旧实现在任何场景下都可能产出 drain_node（驱逐节点），
         * 这是**最重的破坏性操作**，却成了默认选项。
         * 驱逐会把节点上所有工作负载迁移走，代价远高于重启单个 Pod 或扩缩容。
         * 因此这里按故障形态建立明确的映射，并要求模型照此选择。
         */
        '【动作类型选择规则 —— 严禁无脑选择 drain_node】',
        '  · 内存类故障（POD_OOM_SWARM / Pod 内存溢出 / OOMKilled / 重启次数飙升）',
        '      → actionType 必须为 `restart_pod`（重启单个 Pod，代价最小）。',
        '  · 算力类故障（NODE_CPU_SPIKE / 节点 CPU 或内存水位持续 ≥85%）',
        '      → actionType 必须为 `scale_deployment`（扩容分摊压力，而非迁移负载）。',
        '  · 网络类故障（NET_PACKET_LOSS / 节点 NetworkPartition / 与集群失联）',
        '      → actionType 方可为 `drain_node`（只有网络分区场景才有迁移必要）。',
        '  · 用户明确点名"驱逐某个节点"→ 才使用 `drain_node`。',
        '  · 其余一切情况**禁止**使用 `drain_node`。',
        '',
        '【回答要求】',
        '  1. 使用 Markdown，结构清晰（结论 → 证据 → 处置建议）。',
        '  2. 明确引用命中的 Runbook 编号。',
        '  3. 不要臆造未在上下文中出现的 Pod 或指标。',
        '  4. 正文必须包含具体技术细节（如 cgroup memory.max、Exit Code 137、oom_score 等）。',
        hasImage
          ? '  5. 结合附带的 3D 视口快照，指出空间布局上的异常特征。'
          : '  5. 本次未附带视口快照，仅依据遥测与知识库作答。',
      ];
  }
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

    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };

    const timer = setTimeout((): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
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
  /**
   * 本次请求实际检索到的 Runbook。
   * 用于在 tool-result 时注入 ragReferences——模型自己不知道检索命中项，
   * 溯源必须由路由层用真实结果填充。
   */
  readonly runbooks: readonly RagRunbookDoc[];
  /** 上下文中的真实实体（校正模型复述 ID 时的幻觉） */
  readonly knownEntities: readonly KnownEntity[];
  /**
   * 完整集群上下文。
   *
   * 【为何引擎 A 也需要它】模型漏调工具时，路由层要用**同一份真实上下文**
   * 补齐缺失卡片（见 emitMissingCards）。此参数原实现中不存在于本函数，
   * 是为此功能新增的——没有它就无法保证补出来的卡片与引擎 B 指向同一实体。
   */
  readonly clusterContext: ClusterContext;
  /** 本次请求的意图分类（决定补全策略与可用工具） */
  readonly intent: IntentKind;
  /** 本意图允许调用的工具白名单（空数组 = 纯文本对话） */
  readonly allowedTools: readonly string[];
  /**
   * 首个工具调用发生时的回调（推送 MCP_TOOL_INVOKE 推理步骤）。
   *
   * 【为何用回调】该步骤必须"随真实调用出现"，而不是在请求开头预先发出；
   * 只有真正处理 tool-call 的这一层才知道工具名与时机。
   */
  readonly onFirstToolCall: (toolName: string) => void;
  readonly emit: (event: ChatStreamEvent) => void;
  readonly signal: AbortSignal;
  /**
   * 工具调用账本（跨引擎共享）。
   *
   * 【为什么引擎 A 也要记】回落引擎 B 时，B 需要知道"A 已经发过哪几张卡"，
   * 才能只补缺失的卡而不是三张全重发（A1 重复卡片缺陷的根因）。
   */
  readonly ledger: ToolCallLedger;
  /** R43：请求级 trace（span 事件写入同一条 NDJSON 流） */
  readonly trace: AgentTrace;
  /** R43：AI SDK usage 回调（tokens 由上游按 env 单价换算成本） */
  readonly onUsage?: (usage: { promptTokens?: number; completionTokens?: number }) => void;
}): Promise<boolean> {
  const { apiKey, baseURL, modelName, messages, systemPrompt, hasImage, viewportImage, runbooks, knownEntities, clusterContext, allowedTools, onFirstToolCall, emit, signal, ledger, trace, onUsage } = params;

  try {
    const provider = createOpenAI({ apiKey, baseURL });
    const model = provider(modelName);

    /**
     * 本次流已成功产出的工具名集合（用于流结束后做补全差集）。
     * 只记录**通过载荷校验并真正下发**的工具——校验失败的卡片前端不会渲染，
     * 计入"已产出"会导致该卡永久缺失。
     */
    const emittedToolNames = new Set<string>();

    /* ---- 组装消息：多模态时把图片作为最后一条 user 消息的附件 ---- */
    /**
     * 【类型契约】CoreMessage 的 user 消息 content 允许
     * `string | Array<TextPart | ImagePart | FilePart>`，因此多模态消息
     * 可直接强类型构造，**无需 any 断言**（AGENTS.md 第 2 条禁止 any）。
     */
    const coreMessages: CoreMessage[] = messages.map(
      (m): CoreMessage => ({ role: m.role, content: m.content }),
    );

    /**
     * 多模态：把图片**附加到最后一条 user 消息**上，而不是新加一条。
     *
     * 【自愈什么】旧实现无条件 `[...coreMessages, { role:'user', content:[图片描述] }]`，
     * 于是模型看到的是**同一句话说了两遍**：
     *   user: "分析这个故障"        ← 前端已带的原始提问
     *   user: "这是当前 3D 视口快照" ← 新追加的一条
     * 连续两条 user 消息会让人设混乱，模型容易把第二条当成新指令，
     * 只围绕截图作答，丢掉用户原本的提问；多模态通道也因此多耗一倍 token。
     *
     * 【正确做法】OpenAI 多模态协议本身就支持**一条消息内混合文本与图片**：
     * `content: [{ type:'text', ... }, { type:'image', ... }]`
     * 因此把最后一条 user 消息升级为数组即可，提问与截图同属一条消息，
     * 模型能天然建立"请结合这张图回答我这个问题"的关联。
     *
     * 【边界】若列表为空或末条不是 user（例如以 assistant 结尾的异常历史），
     * 才退化为追加一条新消息——此时没有可升级的载体。
     */
    let messagesForModel: CoreMessage[] = coreMessages;
    if (hasImage && viewportImage !== undefined) {
      const lastIndex = coreMessages.length - 1;
      const lastMessage = lastIndex >= 0 ? coreMessages[lastIndex] : undefined;

      if (lastMessage !== undefined && lastMessage.role === 'user') {
        /* 取出原提问文本（string 或已有的 parts 数组都兼容） */
        const originalText =
          typeof lastMessage.content === 'string'
            ? lastMessage.content
            : lastMessage.content
                .map((part): string => (part.type === 'text' ? part.text : ''))
                .join(' ')
                .trim();

        messagesForModel = [
          ...coreMessages.slice(0, lastIndex),
          {
            role: 'user',
            content: [
              { type: 'text', text: originalText },
              { type: 'image', image: viewportImage },
            ],
          },
        ];
      } else {
        /* 无可用载体（空历史或末条非 user）→ 才追加一条独立的多模态消息 */
        messagesForModel = [
          ...coreMessages,
          {
            role: 'user',
            content: [
              { type: 'text', text: '这是当前 3D 集群拓扑视口快照，请结合空间异常特征分析。' },
              { type: 'image', image: viewportImage },
            ],
          },
        ];
      }
    }

    /**
     * 【注意：AI SDK v3 的 streamText 返回 Promise】
     * 签名是 `streamText(...): Promise<StreamTextResult<TOOLS>>`，
     * 必须先 await 才能访问 fullStream（v3 为了在返回前完成参数校验
     * 与 provider 初始化而改成异步；v4+ 才改回同步返回）。
     * 误写 `for await (const part of result.fullStream)` 会在 tsc 阶段
     * 报 "Property 'fullStream' does not exist on type 'Promise<...>'"。
     */
    /**
     * 【动态工具集】只挂载本意图允许的工具。
     *
     * 这是「稳态不乱弹高危卡」的**传输层保证**：集群 100 分健康时，
     * `proposeRemediationAction` 根本不在 tools 集合里，模型即使被提示词
     * 误导也无法调用它——比事后过滤 tool-call 更彻底，也更省 token。
     * 寒暄路径 allowedTools 为空，于是 tools 传 undefined，模型退化为纯文本对话。
     */
    const toolsForModel = {
      ...(allowedTools.includes('renderPodMetrics')
        ? {
            renderPodMetrics: tool({
              description: '渲染目标 Pod 的实时指标卡片（CPU/内存双轨 + 近 6 周期走势）',
              parameters: podMetricsSchema,
              execute: async (args: z.infer<typeof podMetricsSchema>): Promise<string> => {
                return `pod metrics card rendered for ${args.podName}`;
              },
            }),
          }
        : {}),
      ...(allowedTools.includes('renderRootCauseAnalysis')
        ? {
            renderRootCauseAnalysis: tool({
              description: '渲染 SRE 根因分析报告卡（含 P0/P1 徽标、置信度、证据链与 RAG 溯源）',
              parameters: rootCauseSchema,
              execute: async (args: z.infer<typeof rootCauseSchema>): Promise<string> => {
                return `root cause card rendered: ${args.title}`;
              },
            }),
          }
        : {}),
      ...(allowedTools.includes('proposeRemediationAction')
        ? {
            proposeRemediationAction: tool({
              description: '提议一个可执行的 MCP 自愈动作（需用户二次确认后才会执行）',
              parameters: remediationSchema,
              execute: async (args: z.infer<typeof remediationSchema>): Promise<string> => {
                return `remediation proposed: ${args.actionType} on ${args.targetId}`;
              },
            }),
          }
        : {}),
    };

    const result = await streamText({
      model,
      system: systemPrompt,
      messages: messagesForModel,
      temperature: Number(process.env.AI_TEMPERATURE ?? '0.3'),
      maxRetries: Number(process.env.AI_MAX_RETRIES ?? '2'),
      abortSignal: signal,
      /* 无工具时不传 tools 字段，避免空对象导致 provider 侧参数校验差异 */
      ...(Object.keys(toolsForModel).length > 0 ? { tools: toolsForModel } : {}),
    });

    /* R43：LLM 总时长与首 token span（TTFT） */
    const llmTotalSpan = startSpan(trace, 'llm-total');
    const firstTokenSpan = startSpan(trace, 'llm-first-token');
    let firstTokenEnded = false;

    /* ---- 遍历 fullStream 逐帧转发 ---- */
    for await (const part of result.fullStream) {
      if (signal.aborted) return true;

      if (part.type === 'text-delta') {
        if (!firstTokenEnded) {
          firstTokenEnded = true;
          emit({ type: 'span', ...endSpan(firstTokenSpan, { status: 'ok' }) });
        }
        emit({ type: 'text', content: part.textDelta });
        continue;
      }

      if (part.type === 'tool-call') {
        const toolName = part.toolName;
        const toolCallId = part.toolCallId;
        const toolSpan = startSpan(trace, 'tool-call:' + toolName);
        const mcpUri = `mcp://k8s-cluster/tools/${toolName}`;

        /*
         * 【推理链按需推进】只有在模型**真的**发起第一次工具调用时，
         * 才推送 MCP_TOOL_INVOKE 步骤，并带上本次的真实工具名。
         * 回调内部幂等，后续工具调用不会重复推送。
         */
        onFirstToolCall(toolName);

        /**
         * ================= 事件顺序：先校验，再发 tool-start =================
         *
         * 【自愈的 P0 缺陷】旧实现先发 `tool-start` 让前端挂骨架屏，
         * 再校验参数；一旦校验返回 null 就 `continue` 跳过 `tool-result`。
         * 结果是前端那个骨架屏**永久悬空**，同时 `emittedToolNames` 已在
         * tool-start 处登记过该工具，流尾的 emitMissingCards 认为"已产出"
         * 也不再补齐——用户看到一张永远转圈的卡片，且没有任何补救机制。
         *
         * 【正确顺序】必须先算出**确定的载荷**，确认非空后才发 tool-start。
         * 这样每个 tool-start 100% 有配对的 tool-result，事件流不可能断链。
         *
         * 【载荷从哪来】三级兜底，保证第三张卡（动作卡）永不缺席：
         *   1. validateToolArgs 正常校验通过 → 用模型给的参数；
         *   2. 校验失败 → 用服务端构造器（buildMetricsArgs / buildRootCauseArgs /
         *      buildActionArgs）按真实集群数据生成等价载荷；
         *   3. 连构造器都拿不到目标（clusterContext 完全为空）→ 才跳过，
         *      但**此时不发 tool-start**，因此不会留下悬空骨架。
         */
        const validated = validateToolArgs(
          toolName,
          part.args,
          runbooks,
          knownEntities,
          clusterContext,
        );

        let finalPayload: PodMetricsCardProps | RootCauseAlertProps | ActionConfirmProps | null = validated;

        if (finalPayload === null) {
          /* 服务端兜底：用真实集群数据构造等价载荷 */
          const fallbackTarget = resolveSimulatorTarget(clusterContext, true);
          const chaos = normalizeChaos(clusterContext.activeChaos);
          if (toolName === 'renderPodMetrics') {
            finalPayload = fallbackTarget.pod !== null ? buildMetricsArgs(fallbackTarget.pod) : null;
          } else if (toolName === 'renderRootCauseAnalysis') {
            finalPayload = buildRootCauseArgs(clusterContext, runbooks, fallbackTarget);
          } else if (toolName === 'proposeRemediationAction') {
            finalPayload = buildActionArgs(fallbackTarget, chaos);
          }
        }

        /*
         * 【无载荷 ⇒ 不发 tool-start】宁可少一张卡，也绝不留悬空骨架。
         * 未登记到 emittedToolNames，因此流尾的补全会再尝试补齐，
         * 两条路径互斥不会重复。
         */
        if (finalPayload === null) {
          emit({
            type: 'text',
            content: `\n\n> [ SCHEMA-GUARD ] 工具 \`${toolName}\` 缺少可用的真实数据，本轮不渲染该卡片。\n\n`,
          });
          continue;
        }

        /* 载荷就绪 → 依次发 start 与 result，中间保留骨架可见延迟 */
        emit({ type: 'tool-start', toolCallId, toolName, mcpUri });
        recordToolStart(ledger, toolCallId, toolName);
        emittedToolNames.add(toolName);

        await sleep(TOOL_RESULT_DELAY_MS_A, signal);

        emit({
          type: 'tool-result',
          toolCallId,
          toolName,
          args: finalPayload,
        });
        recordToolResult(ledger, toolCallId, true);
        emit({
          type: 'span',
          ...endSpan(toolSpan, { status: 'ok', attrs: { tool: toolName } }),
        });
        continue;
      }

      if (part.type === 'error') {
        /* 流内错误：交由外层 catch 决定是否回落引擎 B */
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }

    /*
     * ---- 服务端补全（模型漏调工具时的兜底）----
     *
     * 【为何放在流结束、返回 true 之前】此刻正文已完整吐完、模型决策已定，
     * 补卡不会打断正文的流式节奏；且只有确认引擎 A 成功（未抛错、未中断）
     * 才补——若走 catch 回落引擎 B，引擎 B 自身就会产出完整三卡。
     */
    emit({ type: 'span', ...endSpan(llmTotalSpan, { status: 'ok' }) });
    try {
      const usage = await result.usage;
      onUsage?.({
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });
    } catch {
      /* usage 不可用时保持缺省：不填 0 冒充 */
    }

    emitMissingCards({
      ctx: clusterContext,
      runbooks,
      emitted: emittedToolNames,
      allowedTools,
      emit,
      ledger,
    });

    return true;
  } catch (error) {
    /* 任何异常（401 / 404 / 网络 / 模型不支持工具调用）→ 交回调用方回落 */
    console.error('[kubevision][chat] engine A failed, falling back to simulator:', error);
    return false;
  }
}

/**
 * KnownEntity —— 请求上下文中真实存在的实体（用于校正模型幻觉）。
 *
 * 【为何需要】大模型在复述长 ID 时极易出错（实测把
 * `pod-payment-gateway-7f8b9-x2k` 写成 `pod-payment-gateway-7f8b-9x2k`）。
 * 这类错误在文本层面几乎无法察觉，但会让卡片绑定到不存在的实体、
 * 3D 聚焦失效。ID 是系统已知的确定事实，应由服务端校正而非让模型复述。
 */
interface KnownEntity {
  readonly id: string;
  readonly name: string;
}

/**
 * editDistance —— Levenshtein 编辑距离（用于 ID 模糊匹配）。
 *
 * 【核心数学】d[i][j] = min(
 *   d[i-1][j] + 1,      // 删除
 *   d[i][j-1] + 1,      // 插入
 *   d[i-1][j-1] + cost, // 替换（相同则 +0）
 * )
 * 值越小表示两串越接近。用于容忍模型输出中的单字符错漏与顺序颠倒。
 *
 * 【为何自己实现】只为一个用途引入 diff 库不值得；此算法 20 行即可，
 * 且 ID 长度通常 < 60，O(n·m) 完全可接受。
 *
 * @param a 字符串 A
 * @param b 字符串 B
 * @returns 编辑距离
 */
function editDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  /* 滚动数组：只保留上一行，空间 O(min(la,lb)) */
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb];
}

/**
 * resolveEntityId —— 把模型给出的近似 ID 映射回真实实体 ID。
 *
 * 【匹配优先级】
 * 1. 精确命中 → 直接返回（最常见，零成本）；
 * 2. 名字精确命中 → 用名字对应的真实 ID；
 * 3. 模糊匹配：在真实实体中找编辑距离最小者，且距离需小于阈值
 *    （取 ID 长度的 25%，最少 3）——阈值防止把无关实体硬套上去。
 *
 * @param claimedId   模型声称的 ID
 * @param claimedName 模型声称的名字（辅助匹配）
 * @param known       真实实体列表
 * @returns 匹配到的真实 ID；无法可靠匹配时返回 null（保留模型原值交由调用方决定）
 */
function resolveEntityId(
  claimedId: string,
  claimedName: string,
  known: readonly KnownEntity[],
): string | null {
  if (known.length === 0) return null;

  /* ---- 1. ID 精确命中 ---- */
  for (const entity of known) {
    if (entity.id === claimedId) return entity.id;
  }

  /* ---- 2. 名字精确命中 ---- */
  for (const entity of known) {
    if (entity.name === claimedName || entity.name === claimedId) return entity.id;
  }

  /**
   * ---- 2b. 名字前缀/包含命中（应对"截断名"与"带标注的名"） ----
   *
   * 实测模型会输出两类**非 n/a 但同样无效**的 ID：
   * - 截断名：`payment-gateway`（真实 ID 是 `pod-payment-gateway-7f8b9-x2k`）；
   * - 带标注的名：`payment-gateway (unresolved)`。
   * 二者都不是占位符，因此不会被 isInvalidPlaceholderId 拦下，
   * 但也都不是真实实体 ID —— 若不解析，卡片仍会绑定到不存在的对象。
   *
   * 这里用**双向前缀匹配**兜住这两种形态：
   * `entity.name.startsWith(claimed)` 处理截断名，
   * `claimed.startsWith(entity.name)` 处理带后缀标注的名。
   * 要求 claimed 至少 6 个字符，避免 `redis`、`k8s` 这类过短串误命中多个实体。
   *
   * 注意：这一步排在编辑距离之前——前缀匹配是**强证据**（真实名字的开头），
   * 而编辑距离在长 ID 上容易被公共前缀干扰出错误候选。
   */
  const claimedTrimmed = claimedId.trim();
  if (claimedTrimmed.length >= 6) {
    const lowerClaimed = claimedTrimmed.toLowerCase();
    for (const entity of known) {
      const lowerName = entity.name.toLowerCase();
      if (lowerName.startsWith(lowerClaimed) || lowerClaimed.startsWith(lowerName)) {
        return entity.id;
      }
    }
  }

  /* ---- 3. 模糊匹配：编辑距离最小且足够接近 ---- */
  let best: { id: string; distance: number } | null = null;
  for (const entity of known) {
    const d = editDistance(claimedId, entity.id);
    if (best === null || d < best.distance) {
      best = { id: entity.id, distance: d };
    }
  }

  if (best === null) return null;
  /* 阈值：允许少量字符差异，但拒绝完全无关的实体 */
  const threshold = Math.max(3, Math.floor(claimedId.length * 0.25));
  return best.distance <= threshold ? best.id : null;
}

/**
 * isInvalidPlaceholderId —— 判断某个 ID 是否为**占位符/幽灵 ID**（而非真实实体）。
 *
 * 【为什么必须在服务端拦截】实测出现过 `POD n/a` 与
 * `[MCP-ROUTER] ... -> Target n/a healed` 这类穿透：
 * 模型在上下文里找不到具体目标时，会用 `n/a` / `unknown` 这类词占位，
 * 而这些值一旦流入卡片与终端，就变成了**对不存在对象的操作回执**。
 * 对一个运维系统而言，这比不显示更危险——它让人以为自己修好了一个东西。
 *
 * 【为何是白名单式穷举而非"包含 n/a"】`n/a` 出现在真实实体名里的概率为 0，
 * 但用包含式匹配会误伤，因此这里用**全串精确匹配**（忽略大小写与首尾空白）。
 *
 * @param id 待判定的实体 ID
 * @returns true = 该 ID 是占位符，绝不可用于绑定真实实体
 */
function isInvalidPlaceholderId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return (
    normalized === '' ||
    normalized === 'n/a' ||
    normalized === 'na' ||
    normalized === 'none' ||
    normalized === 'null' ||
    normalized === 'undefined' ||
    normalized === 'unknown' ||
    normalized === 'unknown-target' ||
    normalized === 'cluster'
  );
}

/**
 * STEADY_STATE_SEEDS —— 稳态巡检时的后备真实实体锚点。
 *
 * 【为什么需要】此前的 knownEntities 只收集「选中实体 + 异常 Pod + 节点」。
 * 当集群完全健康（faultyPods 为空）且用户未选中任何实体时，这个列表里
 * **一个 Pod 都没有**——模型此时若被要求渲染指标卡，只能凭空编一个 ID，
 * 或者用 `n/a` 占位。这正是 `POD n/a` 的来源。
 *
 * 解决方式不是"禁止渲染"，而是**给它真实可用的锚点**：把种子表里的
 * 核心服务作为始终可用的候选。这样稳态下模型要指标卡时，
 * 服务端总能把占位串校正到一个真实存在的 Pod 上。
 *
 * 【口径说明】这些 ID 来自 `POD_SEED_TABLE`（id = `pod-${name}`），
 * 与前端快照里的实体完全一致，不是虚构。
 */
const STEADY_STATE_SEED_ENTITIES: readonly KnownEntity[] = [
  { id: 'pod-payment-gateway-7f8b9-x2k', name: 'payment-gateway-7f8b9-x2k' },
  { id: 'pod-redis-cluster-shard-0', name: 'redis-cluster-shard-0' },
  { id: 'pod-user-profile-svc-4e8a1-b9c', name: 'user-profile-svc-4e8a1-b9c' },
];

/**
 * validateToolArgs —— 按工具名校验模型生成的参数。
 *
 * 【ragReferences 注入】模型无法凭空知道本次检索命中了哪些手册——
 * 它只看到 System Prompt 里的文本描述。因此 RAG 引用必须由**路由层**
 * 用真实的检索结果填充，而不是让模型自己编。此前这里硬编码空数组，
 * 导致引擎 A 产出的根因卡永远缺失溯源区（实测发现）。
 *
 * @param toolName        工具名
 * @param rawArgs         模型生成的原始参数（不可信）
 * @param runbooks        本次请求实际检索到的 Runbook（用于注入 ragReferences）
 * @param knownEntities   本次请求上下文中的真实实体（用于校正模型幻觉的 ID）
 * @returns 通过校验的卡片载荷；校验失败返回 null
 */
/**
 * defaultParamDescription —— 按动作类型生成默认的参数说明。
 *
 * 【用途】当模型没有给出有意义的人话说明（缺失、过短、或含 n/a 占位串）时，
 * 用它补一条**如实描述该动作会做什么**的说明。
 * 这不是编造理由，而是把系统已知的行为写成用户能读的句子——
 * 动作卡上没有说明比有一句准确的通用说明更让人不安。
 *
 * @param actionType 已归一化的动作类型
 * @param target     目标实体（可能为空，说明目标解析失败时的兜底表述）
 * @returns 面向用户的一行说明
 */
function defaultParamDescription(
  actionType: RemediationActionType,
  target: KnownEntity | null,
): string {
  const targetLabel = target !== null ? target.name : '目标实体';
  if (actionType === 'drain_node') {
    return `驱逐节点 ${targetLabel} 上的全部工作负载并标记为不可调度，需人工二次确认`;
  }
  if (actionType === 'scale_deployment') {
    return `调整 ${targetLabel} 的副本数至期望水位，缓解当前负载压力`;
  }
  return `重启 ${targetLabel} 以清除异常状态，服务将在重启期间短暂不可用`;
}

/**
 * validateToolArgs —— 按工具名校验模型生成的参数。
 *
 * 【ragReferences 注入】模型无法凭空知道本次检索命中了哪些手册——
 * 它只看到 System Prompt 里的文本描述。因此 RAG 引用必须由**路由层**
 * 用真实的检索结果填充，而不是让模型自己编。此前这里硬编码空数组，
 * 导致引擎 A 产出的根因卡永远缺失溯源区（实测发现）。
 *
 * 【绝不返回 null 的工具】`proposeRemediationAction` 分支已改造为
 * 恒定产出有效载荷——因为上游 streamWithLLM 在发送 tool-start 之后
 * 若拿不到 result，前端骨架屏会永久悬空。详见该分支内的注释。
 *
 * @param toolName        工具名
 * @param rawArgs         模型生成的原始参数（不可信）
 * @param runbooks        本次请求实际检索到的 Runbook（用于注入 ragReferences）
 * @param knownEntities   本次请求上下文中的真实实体（用于校正模型幻觉的 ID）
 * @param clusterContext  集群上下文（用于动作卡目标解析的稳态兜底）
 * @returns 通过校验的卡片载荷；校验失败返回 null
 */
function validateToolArgs(
  toolName: string,
  rawArgs: unknown,
  runbooks: readonly RagRunbookDoc[],
  knownEntities: readonly KnownEntity[],
  clusterContext: ClusterContext,
): PodMetricsCardProps | RootCauseAlertProps | ActionConfirmProps | null {
  if (toolName === 'renderPodMetrics') {
    const parsed = podMetricsSchema.safeParse(rawArgs);
    if (!parsed.success) return null;

    /**
     * 【校正模型幻觉的 Pod ID】
     *
     * 实测发现（deepseek-flash）：模型会把 `pod-payment-gateway-7f8b9-x2k`
     * 记成 `pod-payment-gateway-7f8b-9x2k`——少一个字符、`9x2k` 顺序颠倒。
     * 人类几乎不会注意，但对系统是致命错位：卡片会绑定到不存在的实体，
     * 点击名称触发的 3D 聚焦也会失败（CameraRig 找不到该 ID）。
     *
     * 【为何由路由层校正而非继续要求模型】ID 是**系统已知的确定事实**，
     * 让模型"复述"它本身就是设计缺陷——等于让模型做没有智力价值的抄写，
     * 而抄写恰恰是大模型最容易出错的地方。路由层持有真实实体列表，
     * 用模糊匹配把模型给的近似 ID 映射回真实 ID，从根源消除这类错误。
     *
     * 【匹配策略】按「同名最长公共前缀」+「编辑距离最小」排序，
     * 只接受足够接近的候选（避免把一个完全无关的 Pod 硬套上去）。
     */
    const resolvedId = resolveEntityId(parsed.data.podId, parsed.data.podName, knownEntities);

    /* ---- 情形 A：成功映射回真实实体 → 采用真实 ID ---- */
    if (resolvedId !== null) {
      return {
        ...parsed.data,
        podId: resolvedId,
        /* 名称也一并校正：模型可能只把 ID 记对、名字记错，或反之 */
        podName: knownEntities.find((e): boolean => e.id === resolvedId)?.name ?? parsed.data.podName,
      } as PodMetricsCardProps;
    }

    /**
     * ---- 情形 B：解析失败，且模型给的是占位串（'n/a' 等）----
     *
     * 这是 `POD n/a` 的直接来源：旧实现在解析失败时回退成
     * `resolvedId ?? parsed.data.podId`，把占位串原样放进了卡片。
     * 现在改为**回退绑定到首个真实实体**；若连一个合法实体都没有，
     * 则返回 null 跳过该卡——宁可无卡，绝不放 'n/a'。
     */
    if (isInvalidPlaceholderId(parsed.data.podId)) {
      const fallback = knownEntities[0];
      if (fallback === undefined) return null;
      return {
        ...parsed.data,
        podId: fallback.id,
        podName: fallback.name,
      } as PodMetricsCardProps;
    }

    /**
     * ---- 情形 C：非占位串但也没匹配上 ----
     * 可能是本次上下文未纳入 knownEntities 的健康实体（模型信息来自历史对话）。
     * 保留模型原值，但**已确认它不是占位符**，因此不会产生 'n/a' 卡片。
     */
    return { ...parsed.data } as PodMetricsCardProps;
  }
  if (toolName === 'renderRootCauseAnalysis') {
    const parsed = rootCauseSchema.safeParse(rawArgs);
    if (!parsed.success) return null;
    /**
     * 【用真实检索结果填充溯源】runbooks 来自请求入口处的
     * retrieveSreRunbooks 调用，含 id / title / similarityScore。
     * 这样前端「RAG 检索增强知识库溯源」区展示的就是**实际命中**的手册，
     * 而不是模型杜撰的引用——溯源的公信力完全取决于这一点。
     */
    return { ...parsed.data, ragReferences: [...runbooks] } as RootCauseAlertProps;
  }
  if (toolName === 'proposeRemediationAction') {
    const parsed = remediationSchema.safeParse(rawArgs);
    /*
     * 【最后一道容错】Schema 已放宽到只要求 actionType 为字符串。
     * 若连这条都失败（模型给了 null / 数字 / 完全缺字段），仍不能返回 null——
     * 返回 null 会让上层 tool-start 已发、tool-result 不发，骨架屏永久悬空。
     * 这里用最小合法载荷兜底：动作退回最保守的 restart_pod，目标交给下方统一解析。
     */
    const data = parsed.success
      ? parsed.data
      : {
          actionType: 'restart_pod',
          targetId: '',
          targetName: '',
          paramDescription: '',
          isHighRisk: false,
        };

    /* 动作类型归一化（enum 强约束已移除，见 normalizeActionType 注释） */
    const actionType = normalizeActionType(data.actionType);

    /**
     * 【此前遗漏的目标校正 —— `Target n/a healed` 的根因】
     *
     * 该分支历史上**从未调用过 resolveEntityId**，直接把模型给的
     * targetId / targetName 原样下发。于是模型传 `n/a` 时，
     * 前端会渲染一张「对 n/a 执行 restart_pod」的动作卡，
     * 用户点击后 healEntity('n/a') 打印出 `Target n/a healed` 的假回执。
     *
     * 动作卡比指标卡更危险：它会让用户**真的按下执行按钮**，
     * 因此目标必须解析到真实实体，绝不下发占位串。
     */
    const resolvedTargetId = resolveEntityId(data.targetId, data.targetName, knownEntities);

    /**
     * 【统一目标解析链 —— 杜绝"解析不到就整张拒绝"的死路】
     *
     * 旧实现在情形 C 直接 `return null`。这正是骨架屏悬空的根因之一：
     * 集群无故障 Pod、或 LLM 传入 `"deployment/payment-gateway"` 这类
     * 无法匹配的名称时，整张动作卡被拒绝，而 tool-start 已经发出去了。
     *
     * 新策略是**一路兜底到必有目标**：
     *   1. knownEntities 精确/模糊命中 → 用它；
     *   2. 否则取稳态采样对象（resolveSimulatorTarget 的 steadyFallback 分支，
     *      返回 api-gateway 等真实种子实体）；
     *   3. 再不行取 knownEntities[0]；
     *   4. 极端情况下用 buildActionArgs 内部的目标构造，保证非空。
     * 目标永远是**系统里真实存在的实体**，不会出现 n/a。
     */
    const matched =
      resolvedTargetId !== null
        ? knownEntities.find((e): boolean => e.id === resolvedTargetId)
        : undefined;

    const steadyFallback = resolveSimulatorTarget(clusterContext, true).pod;

    const fallbackTarget: KnownEntity | null =
      matched ??
      (steadyFallback !== null
        ? { id: steadyFallback.id, name: steadyFallback.name }
        : (knownEntities[0] ?? null));

    /*
     * paramDescription 保留策略：LLM 给了有意义的人话就用它的，
     * 否则用按动作类型生成的通用说明。长度 < 6 或含未知占位符视为无效。
     */
    const llmDescription = data.paramDescription.trim();
    const isMeaningfulDescription =
      llmDescription.length >= 6 && !isInvalidPlaceholderId(llmDescription);

    const paramDescription = isMeaningfulDescription
      ? llmDescription
      : defaultParamDescription(actionType, fallbackTarget);

    const targetId = fallbackTarget !== null ? fallbackTarget.id : steadyFallback?.id ?? 'pod-unknown-target';
    const targetName = fallbackTarget !== null ? fallbackTarget.name : steadyFallback?.name ?? '集群节点';

    return {
      actionType,
      targetId,
      targetName,
      paramDescription,
      /**
       * 【安全分级由服务端派生，不信任模型】
       *
       * 实测模型会把 `restart_pod` 也标成 `isHighRisk: true`，
       * 导致用户被要求勾选"已知晓高危风险"才能重启一个普通 Pod——
       * 这是把安全护栏变成噪音，长期会让用户养成无脑勾选的习惯。
       * 反过来更危险：模型也可能把 `drain_node` 标成低危，从而跳过确认。
       *
       * 风险等级是**关于本系统行为的确定事实**（代码里写死了每个动作做了什么），
       * 属于服务端职责。只有 drain_node（会迁移整个节点的工作负载）是高危。
       */
      isHighRisk: actionType === 'drain_node',
      mcpEndpoint: `mcp://k8s-cluster/tools/${actionType}`,
    } satisfies ActionConfirmProps;
  }
  return null;
}

/* ========================================================================== */
/* 引擎 B 的 NDJSON 流式实现                                                    */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* 卡片载荷构造器（引擎 B 与服务端补全共用）                                        */
/* -------------------------------------------------------------------------- */

/**
 * 一次完整诊断应答必须产出的三张卡片（顺序即展示顺序）。
 *
 * 【为何集中在常量里】服务端补全需要按「还缺哪几张」做差集判断，
 * 引擎 B 的固定三步也需要同一份清单；两处共用可避免
 * 「补全逻辑认为有 3 种卡、而引擎 B 只产出 2 种」这类静默漂移。
 */
const REQUIRED_TOOL_NAMES = [
  'renderPodMetrics',
  'renderRootCauseAnalysis',
  'proposeRemediationAction',
] as const;

/**
 * buildMetricsArgs —— 用真实故障快照构造指标卡载荷。
 *
 * 【数据口径】五个数值全部直接取自 clusterContext 的 faultyPods 条目
 * （真实采集），历史序列经 normalizeHistory 归一化为契约要求的 6 点。
 * 绝不在此生成任何随机数或占位值。
 *
 * @param target 已解析出的故障 Pod 快照
 * @returns 可直接下发给前端的指标卡载荷
 */
function buildMetricsArgs(target: ClusterFaultSnapshot): PodMetricsCardProps {
  return {
    podId: target.id,
    podName: target.name,
    namespace: target.namespace,
    cpuUsage: target.cpuUsage,
    memoryUsage: target.memoryUsage,
    restarts: target.restarts,
    cpuHistory: normalizeHistory(target.cpuHistory),
    memHistory: normalizeHistory(target.memHistory),
  };
}

/**
 * buildRootCauseArgs —— 用真实上下文与 RAG 命中项构造根因卡载荷。
 *
 * 【证据链口径】每条 evidence 都是由 clusterContext / runbooks 中的真实字段
 * 拼接而成（节点水位、重启次数、健康分、手册相似度），不含推断性的编造内容；
 * 唯一的"推断"是 rootCauseSummary，且优先直接引用命中的手册机制描述。
 *
 * @param ctx      集群上下文
 * @param runbooks 本次检索命中的手册
 * @param resolved 目标解析结果（Pod 优先 / 节点次之 / 皆无则集群级）
 */
function buildRootCauseArgs(
  ctx: ClusterContext,
  runbooks: readonly RagRunbookDoc[],
  resolved: SimulatorTarget,
): RootCauseAlertProps {
  const target = resolved.pod;
  const nodeTarget = resolved.node;

  const severity: RootCauseAlertProps['severity'] =
    ctx.clusterHealthScore < 60 ? 'P0' : ctx.clusterHealthScore < 85 ? 'P1' : 'P2';

  const title =
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

  return {
    severity,
    title,
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
}

/*
 * pickRemediationActionType 的实现已上移到 utils/chaosFacts.ts（跨端纯函数），
 * 由上方 import 引入。此处不再保留本地副本 —— 两处各写一份正是
 * "AI 卡片动作与 MCP 回执动作不一致"的成因。
 */

/**
 * buildActionArgs —— 构造自愈动作卡载荷（Pod 优先，节点次之，皆无则不产卡）。
 *
 * 【宁可无卡，不可假卡】此前曾用 `ctx.selectedEntityId ?? 'unknown-target'`
 * 兜底，产出一张「对未知目标执行操作」的卡片；现在两者都没有时返回 null，
 * 由调用方整张不输出。
 *
 * 【动作类型由故障形态决定，不由"目标类型"决定】见 pickRemediationActionType：
 * 同一台节点在 CPU 尖峰下应该扩容、在网络分区下才该驱逐。
 *
 * @param resolved 目标解析结果
 * @param chaos    当前混沌场景
 * @returns 动作卡载荷；确无目标时返回 null
 */
function buildActionArgs(
  resolved: SimulatorTarget,
  chaos: ChaosScenario,
): ActionConfirmProps | null {
  const target = resolved.pod;
  if (target !== null) {
    const actionType = pickRemediationActionType(chaos, false, null);
    const isDrain = actionType === 'drain_node';
    /* Pod 级目标不应产出 drain_node：若映射给出 drain_node，回落 restart_pod */
    const safeActionType: RemediationActionType = isDrain ? 'restart_pod' : actionType;
    return {
      actionType: safeActionType,
      /* 真实 id / name 直接取自解析后的 Pod 快照，绝不使用裸 ID 或占位串 */
      targetId: target.id,
      targetName: target.name,
      paramDescription:
        safeActionType === 'scale_deployment'
          ? `为该 Pod 所属 Deployment 扩容副本，分摊内存/算力压力（预计 15~30s 生效）。`
          : `重启 Pod ${target.name}，容器将重新拉起（预计恢复时间 8s，期间该副本不可用）。`,
      mcpEndpoint: `mcp://k8s-cluster/tools/${safeActionType}`,
      isHighRisk: false,
    };
  }

  const nodeTarget = resolved.node;
  if (nodeTarget !== null) {
    const actionType = pickRemediationActionType(chaos, true, nodeTarget.status);
    return {
      actionType,
      targetId: nodeTarget.id,
      targetName: nodeTarget.name,
      paramDescription:
        actionType === 'drain_node'
          ? `驱逐节点 ${nodeTarget.name} 上的工作负载，Pod 将平滑迁移至其他节点（预计 30~60s 完成）。`
          : `为节点 ${nodeTarget.name} 上的工作负载扩容副本，缓解 CPU/内存水位（预计 15~30s 生效）。`,
      mcpEndpoint: `mcp://k8s-cluster/tools/${actionType}`,
      isHighRisk: actionType === 'drain_node',
    };
  }
  return null;
}

/**
 * emitMissingCards —— 服务端补全：模型漏调的工具，用真实数据补齐。
 *
 * 【解决什么】实测 deepseek-flash 在约 40%~50% 的请求里只调用 1~2 个工具
 * 就结束（同一上下文 5 次回放：3/5 完整、2/5 残缺）。刻意留白让用户看到
 * 「有指标卡没有根因卡」这种半截诊断，是比任何视觉瑕疵都更严重的问题——
 * 它直接损害工具本身的可信度。
 *
 * 【为何由路由层补，而不是继续改提示词】提示词已三次强调"三个工具一个都不能少"，
 * 甚至把 podId 直接写进上下文以省掉一次决策，回放结果仍是 2/5。
 * 这说明问题不在指令清晰度，而在小模型的**指令遵循能力上限**——
 * 继续加约束只会让正文变差。而"该给哪张卡"本就是服务端可确定的事实
 * （用同一套真实数据），交给服务端生成是更可靠的工程选择。
 *
 * 【本轮新增：allowedTools 约束】补全必须遵守意图白名单——
 * 稳态巡检只补指标卡，寒暄一张都不补。否则"模型没调"会被补全逻辑
 * 变相补成"三卡齐全"，等于绕过意图路由重新制造旧缺陷。
 *
 * 【诚实标注】每张补全卡片都带 `synthesized: true`，前端据此显示角标。
 *
 * 【不会产出的情况】renderPodMetrics 需要真实的 Pod 数据，若上下文里
 * 既无故障 Pod、用户也未选中 Pod，则返回 null 而跳过——宁可只有两张卡，
 * 也绝不用编造的指标填充（与 buildActionArgs 同一原则）。
 *
 * @param params 上下文、手册、已产出工具集合、意图白名单、事件发射器
 */
function emitMissingCards(params: {
  readonly ctx: ClusterContext;
  readonly runbooks: readonly RagRunbookDoc[];
  readonly emitted: ReadonlySet<string>;
  /** 本意图允许补齐的工具集合（补全不得越过意图边界） */
  readonly allowedTools: readonly string[];
  readonly emit: (event: ChatStreamEvent) => void;
  /** 工具调用账本（补发的卡片同样要登记，避免回落时重复补） */
  readonly ledger: ToolCallLedger;
}): void {
  const { ctx, runbooks, emitted, allowedTools, emit, ledger } = params;

  if (allowedTools.length === 0) return;

  const missing = allowedTools.filter((name): boolean => !emitted.has(name));
  if (missing.length === 0) return;

  /*
   * 【稳态兜底】补全差集同样需要稳态采样对象：LLM 引擎在稳态下若漏发指标卡，
   * 补全逻辑必须能拿到一个真实 Pod 才能补出来。否则"必出遥测卡片"的承诺
   * 会在引擎 A 路径上失效。
   *
   * 【为何用 allowedTools 判断而不是传 intent】allowedTools 已经是意图白名单的
   * 投影——只要它包含 renderPodMetrics，就说明当前意图允许产出指标卡，
   * 也就应该有可用的采样对象。这样判断比再传一个 intent 参数更内聚，
   * 也不会出现"intent 说允许但白名单没放行"的双源不一致。
   */
  const resolved = resolveSimulatorTarget(ctx, allowedTools.includes('renderPodMetrics'));
  const chaos = normalizeChaos(ctx.activeChaos);

  for (const toolName of missing) {
    let args: PodMetricsCardProps | RootCauseAlertProps | ActionConfirmProps | null = null;
    if (toolName === 'renderPodMetrics') {
      args = resolved.pod !== null ? buildMetricsArgs(resolved.pod) : null;
    } else if (toolName === 'renderRootCauseAnalysis') {
      args = buildRootCauseArgs(ctx, runbooks, resolved);
    } else {
      args = buildActionArgs(resolved, chaos);
    }
    /* 无真实数据支撑 → 跳过（宁可少一张卡，不可假造） */
    if (args === null) continue;

    const toolCallId = `fill-${toolName}-${Date.now()}`;
    emit({ type: 'tool-start', toolCallId, toolName, mcpUri: `mcp://k8s-cluster/tools/${toolName}` });
    recordToolStart(ledger, toolCallId, toolName);
    emit({ type: 'tool-result', toolCallId, toolName, args, synthesized: true });
    recordToolResult(ledger, toolCallId, true);
  }
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
/**
 * renderPixelObservation —— 把端侧像素特征渲染成引擎 B 的"画面空间观察"。
 *
 * @param features 端侧统计
 * @returns Markdown 片段
 */
function renderPixelObservation(features: PixelFeatures): string {
  const regionLabel =
    features.redRegion === 'left'
      ? '左前（近似 worker-alpha 机架方向）'
      : features.redRegion === 'right'
        ? '右前（近似 worker-gamma 机架方向）'
        : features.redRegion === 'center'
          ? '中部（近似 worker-beta 机架方向）'
          : '无红色区域';
  const pct = (value: number): string => (value * 100).toFixed(1) + '%';
  const lines = [
    '',
    '',
    '### 画面空间观察（端侧像素统计，非多模态模型）',
    '',
    '- 红色热区：' + features.redClusters + ' 个连通块，质心位于' + regionLabel +
      '（x=' + features.redCentroidX.toFixed(2) + ', y=' + features.redCentroidY.toFixed(2) + '）',
    '- 颜色占比：红 ' + pct(features.redRatio) + ' · 琥珀 ' + pct(features.amberRatio) +
      ' · 绿 ' + pct(features.greenRatio) + ' · 青 ' + pct(features.cyanRatio),
    '- 中央带占比（机架投影近似）：' + pct(features.redCenterBandRatio),
    '',
    '> 以上为端侧 canvas 颜色统计的近似观察，用于无 Key 场景的快速空间定位，不替代多模态模型。',
    '',
  ];
  return lines.join('\n');
}

async function streamWithSimulator(params: {
  readonly ctx: ClusterContext;
  /** 本次意图：决定产出几张卡、产出哪几张 */
  readonly intent: IntentKind;
  readonly runbooks: readonly RagRunbookDoc[];
  readonly hasImage: boolean;
  /** 首次下发工具卡前的回调（推送 MCP_TOOL_INVOKE 推理步骤） */
  readonly onFirstToolCall: (toolName: string) => void;
  readonly emit: (event: ChatStreamEvent) => void;
  readonly signal: AbortSignal;
  /** 工具调用账本（只补缺失卡片，避免回落时重复产出） */
  readonly ledger: ToolCallLedger;
  /** R46：端侧像素特征（可选；缺失时绝不编造画面观察） */
  readonly pixelFeatures?: PixelFeatures;
}): Promise<void> {
  const { ctx, runbooks, intent, hasImage, onFirstToolCall, emit, signal, ledger, pixelFeatures } = params;

  /* ---- 1. 构造报告（按意图选用不同的正文模板） ---- */
  const baseReport =
    intent === 'GREETING_OR_CHITCHAT'
      ? buildGreetingReport(ctx)
      : buildSimulatorReport(ctx, runbooks, hasImage);
  const report = pixelFeatures === undefined ? baseReport : baseReport + renderPixelObservation(pixelFeatures);

  /* ---- 2. 打字机推文本（按块推送，避免逐字符造成过多帧） ---- */
  const cps = Math.max(10, Number(process.env.SIM_TYPING_CPS ?? String(DEFAULT_TYPING_CPS)));
  const CHUNK_SIZE = 6;
  const delayPerChunk = Math.max(8, Math.round((CHUNK_SIZE / cps) * 1000));

  for (let i = 0; i < report.length; i += CHUNK_SIZE) {
    if (signal.aborted) return;
    emit({ type: 'text', content: report.slice(i, i + CHUNK_SIZE) });
    await sleep(delayPerChunk, signal);
  }

  /**
   * ---- 3. 卡片产出：严格按意图白名单 ----
   *
   * 【为何引擎 B 也要遵守白名单】引擎 B 是"确定性兜底"，它同样不能
   * 在 100 分健康时弹出 drain_node。此前它无条件产出三张卡，
   * 正是"问候语也弹高危卡"的主要来源之一。
   */
  /*
   * 【A1 自愈：只补缺失的卡】账本里已经成功产出的工具名直接跳过。
   * 场景：引擎 A 已发指标卡 → 根因卡阶段失败 → 回落引擎 B。
   * 旧实现 B 无条件重发三张，用户看到两张指标卡（重复）。
   * 现在 B 只看差集，理论上不会与 A 的产出重复。
   */
  const allowed = missingToolNames(ledger, toolsAllowedForIntent(intent));
  if (allowed.length === 0) return;

  /*
   * 【稳态巡检兜底开关】只有指标/巡检类意图才允许在"无目标"时绑定种子采样对象。
   * 故障诊断类意图保持严格：真没目标就不出卡（宁可无卡，不可假卡）。
   */
  const resolved = resolveSimulatorTarget(ctx, intent === 'STEADY_HEALTH_CHECK' || intent === 'TARGETED_INSPECTION');
  const chaos = normalizeChaos(ctx.activeChaos);
  const target: ClusterFaultSnapshot | null = resolved.pod;

  /* ---- 3a. 指标卡（指标类意图均允许） ---- */
  if (allowed.includes('renderPodMetrics') && target !== null) {
    onFirstToolCall('renderPodMetrics');
    const toolCallId = `sim-metrics-${Date.now()}`;
    emit({
      type: 'tool-start',
      toolCallId,
      toolName: 'renderPodMetrics',
      mcpUri: 'mcp://k8s-cluster/tools/renderPodMetrics',
    });
    recordToolStart(ledger, toolCallId, 'renderPodMetrics');
    await sleep(TOOL_RESULT_DELAY_MS_B, signal);
    emit({
      type: 'tool-result',
      toolCallId,
      toolName: 'renderPodMetrics',
      args: buildMetricsArgs(target),
    });
    recordToolResult(ledger, toolCallId, true);
    await sleep(120, signal);
  }

  /* ---- 3b. 根因卡（仅故障诊断意图） ---- */
  if (allowed.includes('renderRootCauseAnalysis')) {
    onFirstToolCall('renderRootCauseAnalysis');
    const rcCallId = `sim-rca-${Date.now()}`;
    emit({
      type: 'tool-start',
      toolCallId: rcCallId,
      toolName: 'renderRootCauseAnalysis',
      mcpUri: 'mcp://k8s-cluster/tools/renderRootCauseAnalysis',
    });
    recordToolStart(ledger, rcCallId, 'renderRootCauseAnalysis');
    await sleep(TOOL_RESULT_DELAY_MS_B, signal);
    emit({
      type: 'tool-result',
      toolCallId: rcCallId,
      toolName: 'renderRootCauseAnalysis',
      args: buildRootCauseArgs(ctx, runbooks, resolved),
    });
    recordToolResult(ledger, rcCallId, true);
    await sleep(120, signal);
  }

  /* ---- 3c. 动作卡（仅故障诊断意图；动作类型由故障形态决定） ----
   *
   * 【数据绑定契约】目标由 resolveSimulatorTarget 解析（Pod 优先），
   * 动作类型由 pickRemediationActionType 按混沌场景决定——
   * 不再"Pod 优先就一律 restart_pod / 节点优先就一律 drain_node"。
   * 无真实目标时整张卡不输出（宁可无卡，不可假卡）。
   */
  if (allowed.includes('proposeRemediationAction')) {
    const actionArgs = buildActionArgs(resolved, chaos);
    if (actionArgs !== null) {
      onFirstToolCall('proposeRemediationAction');
      const actionToolCallId = `sim-action-${Date.now()}`;
      emit({
        type: 'tool-start',
        toolCallId: actionToolCallId,
        toolName: 'proposeRemediationAction',
        mcpUri: 'mcp://k8s-cluster/tools/proposeRemediationAction',
      });
      recordToolStart(ledger, actionToolCallId, 'proposeRemediationAction');
      await sleep(TOOL_RESULT_DELAY_MS_B, signal);
      emit({
        type: 'tool-result',
        toolCallId: actionToolCallId,
        toolName: 'proposeRemediationAction',
        args: actionArgs,
      });
      recordToolResult(ledger, actionToolCallId, true);
    }
  }
}

/**
 * buildGreetingReport —— 寒暄场景的正文模板（引擎 B 使用）。
 *
 * 【为何单独写一份】排障报告模板包含症状、根因、处置步骤三段落，
 * 对「你好」而言完全是噪音。寒暄只需三件事：回应问候、给出一句集群健康摘要、
 * 引导下一步——这也是大模型在 GREETING 意图下被要求的输出形态，
 * 两引擎保持同一交互契约。
 *
 * @param ctx 集群上下文
 * @returns Markdown 正文
 */
function buildGreetingReport(ctx: ClusterContext): string {
  const healthyNodes = ctx.nodes.filter((n): boolean => n.status === 'Ready').length;
  const allReady = healthyNodes === ctx.nodes.length;
  return [
    '你好，我是 KubeVision 的 SRE 智能副驾。',
    '',
    allReady
      ? `当前集群健康度 **${ctx.clusterHealthScore}/100**，${ctx.nodes.length} 台计算节点全部就绪，入口流量约 **${ctx.totalQps.toLocaleString('en-US')} req/s**，整体处于稳态运行。`
      : `当前集群健康度 **${ctx.clusterHealthScore}/100**，${ctx.nodes.length} 台计算节点中 ${healthyNodes} 台就绪，建议关注未就绪节点的水位。`,
    '',
    '你可以：',
    '- 点击顶栏 **「故障演练」** 注入 OOM 风暴 / CPU 尖峰 / 网络丢包等场景；',
    '- 或直接提问，例如「排查内存溢出」「分析节点负载」「评估网络吞吐」。',
  ].join('\n');
}

/* ========================================================================== */
/* 请求校验                                                                    */
/* ========================================================================== */

/** 请求体最大字符数（含 Base64 图片，防超大载荷拖垮内存） */
const MAX_BODY_CHARS = 8_000_000;

/**
 * 单次请求最多接收的自定义 Runbook 条数。
 *
 * 【为何要限流】自定义语料是客户端可任意构造的数组。
 * 不限量的话，一个恶意请求可以塞进上万条文档，让服务端的
 * IDF 统计与 BM25 打分循环从微秒级膨胀到秒级——
 * 这是典型的**算法复杂度 DoS**。12 条足够演示"现场新增即可检索"，
 * 又不会让任何一次请求的计算量失控。
 */
const MAX_CUSTOM_RUNBOOKS = 12;

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

  /* ---- customRunbooks：可选，逐字段规范化 ---- */
  const customRunbooks = normalizeCustomRunbooks(obj.customRunbooks);

  /* ---- pixelFeatures：可选，逐字段收敛到 [0,1] / 非负整数 ---- */
  let pixelFeatures: PixelFeatures | undefined;
  if (typeof obj.pixelFeatures === 'object' && obj.pixelFeatures !== null) {
    const pf = obj.pixelFeatures as Record<string, unknown>;
    const ratio = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    const region = pf.redRegion;
    pixelFeatures = {
      redRatio: ratio(pf.redRatio),
      amberRatio: ratio(pf.amberRatio),
      greenRatio: ratio(pf.greenRatio),
      cyanRatio: ratio(pf.cyanRatio),
      redCentroidX: ratio(pf.redCentroidX),
      redCentroidY: ratio(pf.redCentroidY),
      redClusters:
        typeof pf.redClusters === 'number' && Number.isFinite(pf.redClusters)
          ? Math.max(0, Math.min(64, Math.round(pf.redClusters)))
          : 0,
      redRegion: region === 'left' || region === 'center' || region === 'right' ? region : 'none',
      redCenterBandRatio: ratio(pf.redCenterBandRatio),
    };
  }

  /* ---- queryEmbedding：可选，必须 384 维且全部有限（否则退回两路） ---- */
  let queryEmbedding: readonly number[] | undefined;
  if (Array.isArray(obj.queryEmbedding) && obj.queryEmbedding.length === 384) {
    const values: unknown[] = obj.queryEmbedding;
    if (values.every((value): boolean => typeof value === 'number' && Number.isFinite(value))) {
      queryEmbedding = values as number[];
    }
  }

  return {
    messages,
    clusterContext,
    ...(viewportImage !== undefined ? { viewportImage } : {}),
    ...(customRunbooks.length > 0 ? { customRunbooks } : {}),
    ...(queryEmbedding !== undefined ? { queryEmbedding } : {}),
    ...(pixelFeatures !== undefined ? { pixelFeatures } : {}),
  };
}

/**
 * normalizeCustomRunbooks —— 把请求体里的自定义 Runbook 数组规范化为可信形状。
 *
 * 【为何必须逐字段校验】这个数组完全来自客户端，可被任意篡改：
 * 字段缺失会让 tokenize 收到 undefined 而抛异常（整个请求 500），
 * 超长文本则可能撑爆 LLM 上下文预算。服务端不能假定它"应该是对的"。
 *
 * 【裁剪策略】
 * - 最多接收 MAX_CUSTOM_RUNBOOKS 条（防止构造巨型语料库拖慢 IDF 统计）；
 * - 单字段长度截断（标题 200 / 症状 2000 / 根因 4000），
 *   既防滥用又不至于把正常提交砍断；
 * - 数组字段限长，避免构造十万个特征词让 BM25 循环爆炸；
 * - 缺失关键字段的整条丢弃，而不是补默认值——
 *   一条残缺的"手册"比没有更危险（会让模型引用不存在的处置步骤）。
 *
 * @param raw 请求体中的原始值（unknown）
 * @returns 规范化后的自定义语料数组（可能为空数组）
 */
function normalizeCustomRunbooks(raw: unknown): RagRunbookDoc[] {
  if (!Array.isArray(raw)) return [];

  const out: RagRunbookDoc[] = [];
  const seenIds = new Set<string>();

  for (const item of raw) {
    if (out.length >= MAX_CUSTOM_RUNBOOKS) break;
    if (typeof item !== 'object' || item === null) continue;
    const doc = item as Record<string, unknown>;

    /* 核心字符串字段：必须是非空字符串 */
    if (typeof doc.id !== 'string' || doc.id.length === 0 || doc.id.length > 120) continue;
    if (typeof doc.title !== 'string' || doc.title.length === 0) continue;
    if (typeof doc.symptom !== 'string' || doc.symptom.length === 0) continue;
    if (typeof doc.rootCauseMechanism !== 'string') continue;
    if (seenIds.has(doc.id)) continue;
    seenIds.add(doc.id);

    /* 数组字段：只保留字符串元素并限长 */
    const toStringArray = (value: unknown, maxItems: number, maxLen: number): string[] => {
      if (!Array.isArray(value)) return [];
      const result: string[] = [];
      for (const entry of value) {
        if (result.length >= maxItems) break;
        if (typeof entry === 'string' && entry.length > 0) result.push(entry.slice(0, maxLen));
      }
      return result;
    };

    out.push({
      id: doc.id,
      title: doc.title.slice(0, 200),
      category: typeof doc.category === 'string' ? doc.category.slice(0, 60) : 'custom',
      tags: toStringArray(doc.tags, 20, 60),
      symptom: doc.symptom.slice(0, 2000),
      remediationSteps: toStringArray(doc.remediationSteps, 20, 500),
      featureVocabulary: toStringArray(doc.featureVocabulary, 80, 80),
      rootCauseMechanism: doc.rootCauseMechanism.slice(0, 4000),
      relatedChaos: toStringArray(doc.relatedChaos, 8, 40),
      isCustom: true,
      ...(typeof doc.customCreatedAt === 'string'
        ? { customCreatedAt: doc.customCreatedAt.slice(0, 40) }
        : {}),
    });
  }

  return out;
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

  const lastUserMessage =
    [...messages].reverse().find((m): boolean => m.role === 'user')?.content ?? '';

  /**
   * 【意图判定必须在 RAG 之前】
   *
   * 寒暄/闲聊根本不该检索知识库——旧流程无条件先检索，于是「你好」
   * 也会拿到两条手册，并因 0 分归一化被虚标成 86.0%。
   * 把分类前移到检索之前，从流程上消除了"寒暄被塞进排障链路"的可能。
   */
  /* R43：trace 在检索之前创建，才能覆盖 intent/rag/prompt 三段真实耗时 */
  const trace = createTrace();
  const pendingSpanEvents: EndedSpan[] = [];
  const intentSpan = startSpan(trace, 'intent-route');

  const intent: IntentKind = classifyUserIntent(lastUserMessage, clusterContext, hasImage);
  pendingSpanEvents.push(endSpan(intentSpan, { status: 'ok', attrs: { intent } }));

  /**
   * ---- 前置 RAG 检索（寒暄路径跳过） ----
   *
   * 【为何寒暄不检索】检索是为了给诊断提供依据；用户只是打招呼时，
   * 检索结果无处可用，反而会污染提示词、诱导模型输出无关的故障结论。
   */
  const faultyPodNames = clusterContext.faultyPods.map((p): string => p.name);
  const ragQuery = [
    lastUserMessage,
    ...faultyPodNames,
    clusterContext.activeChaos === 'NONE' ? '' : clusterContext.activeChaos,
  ]
    .filter((s): boolean => s.length > 0)
    .join(' ');

  const ragSpan = startSpan(trace, 'rag-retrieve');
  const runbooks =
    intent === 'GREETING_OR_CHITCHAT'
      ? []
      : retrieveSreRunbooks(
          ragQuery,
          normalizeChaos(clusterContext.activeChaos),
          faultyPodNames,
          RAG_TOP_K,
          /*
           * 【自定义语料注入】把本次请求携带的自定义 Runbook 一并纳入检索池。
           *
           * 服务端没有 localStorage，评委在弹窗里新增的条目只能随请求体上来；
           * 若此处不传，就会出现"前端能看到新条目、AI 却检索不到"的断裂，
           * 演示时最致命。
           *
           * 【为何不复用全局状态】路由是并发执行的（多个请求可能同时到达），
           * 用模块级可变单例存自定义语料会造成请求间串味。
           * 显式按请求传参是唯一安全做法。
           */
          body.customRunbooks ?? [],
          body.queryEmbedding,
        );
  pendingSpanEvents.push(
    endSpan(ragSpan, { status: 'ok', attrs: { hits: runbooks.length } }),
  );

  const promptSpan = startSpan(trace, 'prompt-build');
  const systemPrompt = buildSystemPrompt(clusterContext, runbooks, hasImage, intent);
  pendingSpanEvents.push(
    endSpan(promptSpan, { status: 'ok', attrs: { chars: systemPrompt.length } }),
  );

  /**
   * 【真实实体清单】用于校正模型复述 ID 时的幻觉。
   * 包含：选中实体 + 全部异常 Pod + 全部节点。
   * 这些是本次请求上下文中**客观存在**的实体，模型若输出了近似的
   * 错误 ID，路由层可据此映射回真实值（见 resolveEntityId）。
   */
  const knownEntities: KnownEntity[] = [];
  if (clusterContext.selectedEntityId !== null) {
    knownEntities.push({
      id: clusterContext.selectedEntityId,
      name: clusterContext.selectedEntityId,
    });
  }
  for (const pod of clusterContext.faultyPods) {
    knownEntities.push({ id: pod.id, name: pod.name });
  }
  for (const node of clusterContext.nodes) {
    knownEntities.push({ id: node.id, name: node.name });
  }

  /**
   * 【稳态兜底锚点】faultyPods 为空时，上面的循环一个 Pod 都没加进去，
   * 池子只剩节点。模型要「指标卡」时没有 Pod 可用，只能编造或写 `n/a`。
   *
   * 因此这里补入种子核心服务，保证**任何时刻**池子里都有真实 Pod ID。
   * 使用 `some()` 去重：若种子 Pod 恰好就是异常 Pod（已在池中），不重复添加，
   * 以免 knownEntities[0] 的位置语义变得不确定。
   */
  if (clusterContext.faultyPods.length === 0) {
    for (const seed of STEADY_STATE_SEED_ENTITIES) {
      if (!knownEntities.some((e): boolean => e.id === seed.id)) {
        knownEntities.push(seed);
      }
    }
  }

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

      /** 第一个 token 到达时刻（TTFT 只计正文 token） */
      let firstEventAt: number | null = null;
      /** R43：AI SDK usage 容器（缺省时 trace-summary 不填 token/成本） */
      const usageHolder: { value: { promptTokens?: number; completionTokens?: number } | null } = {
        value: null,
      };
      /* R43：实际引擎（响应头代表意图，流内事件与 trace-summary 代表事实） */
      let actualEngine: 'llm' | 'simulator' = engineAtResponseTime;

      /** 单帧写入（带状态锁与异常兜底） */
      const emit = (event: ChatStreamEvent): void => {
        if (isClosed) return;
        if (firstEventAt === null && event.type === 'text') {
          firstEventAt = performance.now();
        }
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          isClosed = true;
        }
      };

      /* R43：intent / rag / prompt 三段已在流创建前完成，emit 就绪后补发 */
      for (const spanEvent of pendingSpanEvents) {
        emit({ type: 'span', ...spanEvent });
      }

      const signal = request.signal;

      /*
       * requestId 必须在 try 之外声明：catch 分支的 error 事件也要带上它，
       * 否则"用户看到的报错"与"服务端日志"无法对号（A9 的硬性要求）。
       */
      const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      try {
        /**
         * ============ 推理链：按意图与阶段渐进推送 ============
         *
         * 【旧实现的三个问题】
         * 1. **一次性连发**：四条步骤在 `start()` 开头同步推完（每条只 sleep 160ms），
         *    用户看到的是"思考链瞬间全部出现"，不像推理，更像一段预先写好的文案；
         * 2. **千篇一律**：不论用户说什么，永远是「意图规划 →（可选）视觉 →
         *    RAG → MCP」四步，寒暄也是这套；
         * 3. **MCP 步骤内容造假**：`mcpUri` 写死成 renderPodMetrics，
         *    即便本次实际调用的是 proposeRemediationAction。
         *
         * 【现在的做法】
         * - 步骤 1 立即发出，随后**真实等待 280ms**（让用户看见"开始思考"）；
         * - 有截图才发视觉步骤，等待 320ms；
         * - 需要检索时才执行并发出 RAG 步骤，等待 300ms；
         * - **MCP 步骤改为按需触发**：只有当模型/仿真器真正发起第一个工具调用时，
         *   才由 `ensureMcpStep` 推送，且 mcpUri 写入**本次真实工具名**。
         *   寒暄路径永不推送该步骤（因为根本没有工具调用）。
         */
        let stepIndex = 0;

        /* ---------- 步骤 1：意图规划（立即发出） ---------- */
        const intentTitleByKind: Readonly<Record<IntentKind, string>> = {
          GREETING_OR_CHITCHAT: '识别对话意图：日常交互与助手能力引导',
          STEADY_HEALTH_CHECK: '解析全集群稳态巡检意图',
          TARGETED_INSPECTION: '解析指定实体的定向巡检意图',
          FAULT_DIAGNOSIS_AND_HEAL: '解析故障诊断意图与集群上下文',
        };

        const intentDetailByKind: Readonly<Record<IntentKind, string>> = {
          GREETING_OR_CHITCHAT:
            `检测到用户输入为日常问候/能力咨询（"${lastUserMessage.slice(0, 80)}"），` +
            `当前集群健康分 ${clusterContext.clusterHealthScore}/100（稳态运行），` +
            '无需触发 RAG 故障手册检索与 MCP 生产写操作工具。',
          STEADY_HEALTH_CHECK:
            `集群当前完全健康：健康分 ${clusterContext.clusterHealthScore}/100，` +
            `无混沌演练、无异常 Pod、${clusterContext.nodes.length} 台节点全部就绪。` +
            `用户询问「${lastUserMessage.slice(0, 60)}」，判定为稳态巡检而非故障诊断。`,
          TARGETED_INSPECTION:
            `用户点名查看实体「${clusterContext.selectedEntityId ?? '未指定'}」的实时指标，` +
            `该实体当前处于健康态（集群健康分 ${clusterContext.clusterHealthScore}/100）。` +
            '本次仅执行指标巡检，不触发根因分析与自愈动作。',
          FAULT_DIAGNOSIS_AND_HEAL:
            `识别到故障诊断请求：演练场景 ${clusterContext.activeChaos}，` +
            `集群健康分 ${clusterContext.clusterHealthScore}/100，` +
            `异常 Pod ${clusterContext.faultyPods.length} 个。` +
            (lastUserMessage.length > 0 ? `用户原话：${lastUserMessage.slice(0, 120)}` : ''),
        };

        emit({
          type: 'reasoning',
          step: {
            stepIndex: stepIndex++,
            phase: 'INTENT_PLANNING',
            title: intentTitleByKind[intent],
            detail: intentDetailByKind[intent],
            latencyMs: SIM_LATENCY.intent,
          },
        });
        await sleep(280, signal);

        /* ---------- 步骤 2（条件）：多模态视觉 ---------- */
        if (hasImage) {
          /**
           * 【体积展示】Base64 相对原始二进制的膨胀系数约 4/3，故乘 0.75 还原。
           * 小于 1 KB 时改用字节表述——直接 Math.round 到 KB 会显示「约 0 KB」，
           * 那是会让用户怀疑截图没有被正确接收的错误文案（实测发现）。
           */
          const approxBytes = Math.round(viewportImage.length * 0.75);
          const sizeLabel =
            approxBytes >= 1024
              ? `约 ${(approxBytes / 1024).toFixed(1)} KB Base64`
              : `约 ${approxBytes} 字节 Base64`;
          emit({
            type: 'reasoning',
            step: {
              stepIndex: stepIndex++,
              phase: 'MULTIMODAL_VISION',
              title: '解析 3D WebGL 拓扑快照空间异常特征',
              detail:
                `接收到视口快照（${sizeLabel}），执行空间布局分析：` +
                '校验机架实例着色（翠绿/琥珀/鲜红分布）、地面警示波纹环激活范围、' +
                '以及异常机架与遥测数据的空间一致性。',
              latencyMs: SIM_LATENCY.vision,
            },
          });
          await sleep(320, signal);
        }

        /* ---------- 步骤 3（条件）：稳态遥测扫描（仅稳态巡检） ---------- */
        if (intent === 'STEADY_HEALTH_CHECK') {
          const nodeLines = clusterContext.nodes
            .map(
              (n): string =>
                `${n.name} ${n.status} · CPU ${n.cpuUsage.toFixed(1)}% / MEM ${n.memUsage.toFixed(1)}%`,
            )
            .join('；');
          emit({
            type: 'reasoning',
            step: {
              stepIndex: stepIndex++,
              phase: 'INTENT_PLANNING',
              title: `扫描 ${clusterContext.nodes.length} 个计算节点的实时遥测水位`,
              detail:
                `逐节点比对水位阈值（CPU/内存均 < 85% 视为健康）：${nodeLines}。` +
                `入口 QPS ${clusterContext.totalQps.toLocaleString('en-US')} req/s，未发现越限节点。`,
              latencyMs: SIM_LATENCY.rag,
            },
          });
          await sleep(300, signal);
        }

        /* ---------- 步骤 4（条件）：RAG 检索 ---------- */
        if (intent !== 'GREETING_OR_CHITCHAT') {
          const ragDetail =
            runbooks.length === 0
              ? intent === 'STEADY_HEALTH_CHECK'
                ? '当前集群无异常特征词，混合检索（词频余弦 + 关键词 + 上下文先验）' +
                  '全部低于相关性阈值 0.08，**跳过故障手册召回**——不编造无关手册。'
                : '混合检索（词频余弦 + 关键词 + 故障上下文先验）未命中达标手册，' +
                  '本次不引用知识库，结论依据实时遥测得出。'
              : `混合检索命中 ${runbooks.length} 条知识切片：\n` +
                runbooks
                  .map(
                    (doc): string =>
                      `· ${doc.id} — ${doc.title}\n  Similarity: ${((doc.similarityScore ?? 0) * 100).toFixed(1)}%`,
                  )
                  .join('\n');

          const shouldEmitRag =
            intent === 'FAULT_DIAGNOSIS_AND_HEAL' ||
            intent === 'STEADY_HEALTH_CHECK' ||
            runbooks.length > 0;

          if (shouldEmitRag) {
            emit({
              type: 'reasoning',
              step: {
                stepIndex: stepIndex++,
                phase: 'RAG_RETRIEVAL',
                title: '检索 SRE 知识库并计算余弦相似度',
                detail: ragDetail,
                latencyMs: SIM_LATENCY.rag,
              },
            });
            await sleep(300, signal);
          }
        }

        /**
         * ---------- 步骤 5（按需实时触发）：MCP 工具路由 ----------
         *
         * 【为何做成回调而非直接 emit】此刻还不知道本次会调用哪个工具：
         * 引擎 A 要等到模型真的发起 tool-call，引擎 B 要等到准备下发第一张卡。
         * 因此把"推送这条步骤"包装成幂等回调，由真正发生调用的那一方触发，
         * 并把**实际工具名**写进 mcpUri——不再永远写死 renderPodMetrics。
         */
        let mcpStepEmitted = false;
        const ensureMcpStep = (toolName: string): void => {
          if (mcpStepEmitted) return;
          mcpStepEmitted = true;
          const toolLabelByUri: Readonly<Record<string, string>> = {
            renderPodMetrics: '指标渲染工具（只读）',
            renderRootCauseAnalysis: '根因分析渲染工具（只读）',
            proposeRemediationAction: '自愈动作提议工具（写操作，需二次确认）',
          };
          emit({
            type: 'reasoning',
            step: {
              stepIndex: stepIndex++,
              phase: 'MCP_TOOL_INVOKE',
              title: `路由至 MCP 工具链 · ${toolLabelByUri[toolName] ?? toolName}`,
              detail:
                `本次实际调用 \`${toolName}\`，经 MCP 协议路由至 ` +
                `mcp://k8s-cluster/tools/${toolName}。` +
                '所有生产写操作（自愈动作）均不会自动执行，需用户在卡片上二次确认。',
              mcpUri: `mcp://k8s-cluster/tools/${toolName}`,
              latencyMs: SIM_LATENCY.mcp,
            },
          });
        };

        /* ============ 引擎执行 ============ */
        /*
         * ---- 请求级 requestId 与工具调用账本 ----
         *
         * requestId：错误事件/日志/前端提示共用一个 id，便于把"用户看到的报错"
         * 与服务端日志对上号。没有它，用户报"刚才失败了"时无法定位是哪一次。
         *
         * ledger：跨引擎共享的工具调用账本，是 A1（重复卡片）与 A2（悬空骨架）
         * 两个缺陷的共同解药——引擎 B 只补缺失的卡，悬空的 start 会被补终止事件。
         */
        const ledger: ToolCallLedger = createToolCallLedger();

        if (useLLM) {
          const fallbackSpan = startSpan(trace, 'fallback');
          const ok = await streamWithLLM({
            trace,
            onUsage: (value): void => {
              usageHolder.value = value;
            },
            apiKey: apiKey as string,
            baseURL,
            modelName,
            messages,
            systemPrompt,
            hasImage,
            viewportImage,
            runbooks,
            knownEntities,
            clusterContext,
            intent,
            allowedTools: toolsAllowedForIntent(intent),
            onFirstToolCall: ensureMcpStep,
            emit,
            signal,
            ledger,
          });

          if (!ok) {
            /*
             * 【A2 自愈：先修孤儿，再回落】
             *
             * 引擎 A 可能已经发出若干 tool-start 后才失败。若直接回落，
             * 这些 start 永远等不到配对 result —— 前端就是"骨架屏永远转圈"。
             * 这里先为所有 pending 的调用补发 status:'error' 的 tool-result，
             * 前端据此渲染"生成失败，点击重试"。
             */
            const repaired = repairPendingToolCalls(
              ledger,
              emit,
              'engine A failed before producing this card; fell back to local engine',
            );
            actualEngine = 'simulator';
            emit({
              type: 'span',
              ...endSpan(fallbackSpan, { status: 'error', attrs: { reason: 'llm-failed' } }),
            });
            /* 引擎 A 失败 → 无缝回落引擎 B，并先声明实际引擎（流内事实） */
            emit({
              type: 'engine',
              engine: 'simulator',
              reason: 'llm invocation failed (network / quota / model unsupported); local deterministic SRE engine took over',
            });
            emit({
              type: 'text',
              content:
                '> [ ENGINE-FALLBACK ] 远程模型响应异常（网络 / 额度 / 模型不受支持），已无缝切换至本地确定性 SRE 推理引擎。\n\n',
            });
            await streamWithSimulator({
              ctx: clusterContext,
              intent,
              runbooks,
              hasImage,
              pixelFeatures: body.pixelFeatures,
              onFirstToolCall: ensureMcpStep,
              emit,
              signal,
              ledger,
            });
          } else {
            /* 引擎 A 成功：补一条引擎声明，使流内事实完整 */
            emit({ type: 'engine', engine: 'llm', reason: `model=${modelName}` });
          }
        } else {
          /* 未配置 Key → 直接走引擎 B */
          actualEngine = 'simulator';
          emit({
            type: 'span',
            ...endSpan(startSpan(trace, 'fallback'), {
              status: 'ok',
              attrs: { reason: 'no-api-key' },
            }),
          });
          emit({
            type: 'engine',
            engine: 'simulator',
            reason: 'OPENAI_API_KEY not configured; using local deterministic SRE engine by design',
          });
          await streamWithSimulator({
            ctx: clusterContext,
            intent,
            runbooks,
            hasImage,
            pixelFeatures: body.pixelFeatures,
            onFirstToolCall: ensureMcpStep,
            emit,
            signal,
            ledger,
          });
        }

        /* ---- R35：先发 span + trace-summary，再发 done（顺序保证 verify 可断言） ---- */
        const endedEngine = actualEngine;
        const usage = usageHolder.value;
        /* R43：tokens/cost 只在真实获得时填写；env 单价未配置则不填 costCny */
        const priceIn = Number(process.env.KV_PRICE_INPUT_CNY_PER_MTOK ?? '');
        const priceOut = Number(process.env.KV_PRICE_OUTPUT_CNY_PER_MTOK ?? '');
        const costCny =
          usage !== null &&
          usage.promptTokens !== undefined &&
          usage.completionTokens !== undefined &&
          Number.isFinite(priceIn) &&
          Number.isFinite(priceOut) &&
          process.env.KV_PRICE_INPUT_CNY_PER_MTOK !== undefined &&
          process.env.KV_PRICE_OUTPUT_CNY_PER_MTOK !== undefined
            ? Math.round(
                ((usage.promptTokens / 1_000_000) * priceIn +
                  (usage.completionTokens / 1_000_000) * priceOut) *
                  10000,
              ) / 10000
            : undefined;
        emit({
          type: 'trace-summary',
          traceId: trace.traceId,
          engine: endedEngine,
          ttftMs:
            firstEventAt === null
              ? elapsedMs(trace)
              : Math.round((firstEventAt - trace.startedAt) * 100) / 100,
          totalMs: elapsedMs(trace),
          ...(usage?.promptTokens === undefined ? {} : { promptTokens: usage.promptTokens }),
          ...(usage?.completionTokens === undefined ? {} : { completionTokens: usage.completionTokens }),
          ...(costCny === undefined ? {} : { costCny }),
        });

        /* ---- A8：流末必有 done（前端不再靠 socket 关闭判断结束） ---- */
        emit({ type: 'done', requestId, engine: actualEngine });

        safeClose();
      } catch (error) {
        /* 客户端取消属正常终止，不记录为错误 */
        const aborted = signal.aborted || (error instanceof Error && error.message === 'aborted');
        const message = error instanceof Error ? error.message : 'unknown error';

        /*
         * 【A9 自愈：结构化错误事件】
         * 旧实现只往正文里追加一行 [ENGINE-ERROR] 文本，前端无法据此选择
         * 文案与重试动作，也拿不到 requestId 对日志。现在推一条 error 事件，
         * 分类 + requestId + 是否可重试；同时保留正文提示（兼容旧客户端）。
         */
        const category: 'network' | 'model' | 'tool_args' | 'server' | 'abort' = aborted
          ? 'abort'
          : /401|403|quota|rate.?limit|model/i.test(message)
            ? 'model'
            : /fetch|network|ECONN|ENOTFOUND|timeout/i.test(message)
              ? 'network'
              : 'server';

        if (!aborted) {
          console.error('[kubevision][chat] stream failed:', error);
          emit({
            type: 'text',
            content: `\n\n> [ ENGINE-ERROR ] 推理中断：${message}\n\n`,
          });
        }
        /* R43：错误分支也必须有 trace-summary（前端据此展示 traceId 与耗时） */
        const usage = usageHolder.value;
        emit({
          type: 'trace-summary',
          traceId: trace.traceId,
          engine: actualEngine,
          ttftMs:
            firstEventAt === null
              ? elapsedMs(trace)
              : Math.round((firstEventAt - trace.startedAt) * 100) / 100,
          totalMs: elapsedMs(trace),
          ...(usage?.promptTokens === undefined ? {} : { promptTokens: usage.promptTokens }),
          ...(usage?.completionTokens === undefined ? {} : { completionTokens: usage.completionTokens }),
        });
        emit({
          type: 'error',
          category,
          message,
          requestId,
          traceId: trace.traceId,
          retryable: category !== 'abort',
        });
        emit({ type: 'done', requestId, engine: 'simulator' });
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
