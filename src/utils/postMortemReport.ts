/**
 * KubeVision AI — SRE 生产事故复盘报告生成器（纯函数，零副作用）
 *
 * 【设计意图】事故复盘（Post-Mortem）是 SRE 文化的核心仪式：它把「一次故障的
 * 偶然处置」沉淀为「可复用的组织记忆」。本模块把 Copilot 会话里散落的三类事实
 * —— 用户提问、Agent 推理链（reasoningSteps）、生成式 UI 卡片载荷（toolCards.args）
 * 与集群态势快照（ClusterContext）—— 收敛为一份符合 Google SRE Post-Mortem
 * 结构的 Markdown 文档，供工程师导出归档、评审与追踪改进项。
 *
 * 【为什么必须是纯函数】
 * 1. 可测试：时间由调用方以 startedAtMs / nowMs 注入，同一输入必然得到逐字节
 *    相同的输出（内部不调用 Date.now()、不使用随机数），因此可以写快照断言；
 * 2. 可审计：报告里每一个数字都能追溯到某条消息或某个快照字段；
 * 3. SSR 安全：不触碰 window / document / Blob / localStorage，服务端调用也不会抛错。
 *
 * 【诚实性契约（最重要的一条）】
 * 复盘报告一旦开始「补全」缺失的字段，它就从证据退化成了文学。因此本模块：
 * - 没有根因卡 → 明确写「本次会话未产出根因分析卡片」，绝不凭空生成根因；
 * - 卡片未就绪（skeleton / error）→ 只记录其存在与状态，不推测其载荷；
 * - 消息本身不带绝对时间戳（CopilotMessage 契约里没有时间字段）→ 时间线以
 *   reasoningSteps.latencyMs 顺序累加推算，并在报告里显式声明该口径，
 *   而不是把推算值伪装成内核级精确时间；
 * - 从未执行的动作绝不标注「已执行」，判定依据只有会话中的 MCP Verification 回执。
 *
 * 【文本安全】表格单元格内的竖线一律转义为 `\|`（否则 GFM 表格会被切碎）；
 * 截断一律使用三个 ASCII 句点 "..."，不引入 Unicode 省略号字符。
 */

import type {
  ActionConfirmProps,
  ClusterContext,
  ClusterFaultSnapshot,
  CopilotMessage,
  CopilotToolCard,
  PodMetricsCardProps,
  RagRunbookDoc,
  RootCauseAlertProps,
} from '@/types/ai';
import { renderIncidentTimelineMarkdown } from '@/utils/snapshotRingBuffer';

/* ========================================================================== */
/* 对外类型契约                                                                */
/* ========================================================================== */

/**
 * PostMortemInput —— 生成复盘报告所需的全部输入。
 *
 * 【字段缘由】这里刻意只放「会话事实 + 两个时间锚点」，不直接传 Zustand store：
 * 报告生成器不应该知道状态管理层的存在，否则单测就得先造一个 store。
 * nowMs 由调用方注入（而不是内部取 Date.now()），保证同一份会话数据在任意
 * 时刻重算都能得到可复现的报告编号与生成时间。
 */
export interface PostMortemInput {
  readonly messages: readonly CopilotMessage[];
  readonly clusterContext: ClusterContext;
  /** 会话开始的时间戳（ms） */
  readonly startedAtMs: number;
  /** 生成报告的时刻（ms），由调用方传入以保证可测试性 */
  readonly nowMs: number;
  /**
   * 可选：遥测帧事故时间线（Markdown 表格）。
   *
   * 【来源】utils/snapshotRingBuffer.ts 的 renderIncidentTimelineMarkdown()，
   * 它从最近 120 帧（约 2 分钟）遥测快照推导「告警出现/解除、健康分骤降/回升」。
   *
   * 【为什么由调用方传入而不是函数内部读】本函数承诺是**纯函数**
   * （不读 Date.now、不碰 DOM、不改入参）。环形缓冲是模块级可变单例，
   * 直接读进来会破坏可测试性与确定性。需要"自动带上时间线"的调用方
   * 可以用下面导出的 buildPostMortemMarkdownWithLiveTimeline 包装器。
   */
  readonly incidentTimelineMarkdown?: string;
}

/* ========================================================================== */
/* 常量契约                                                                    */
/* ========================================================================== */

/** 知识库根因机制的摘要长度上限（契约要求 300 字符以内，含省略号） */
const MECHANISM_EXCERPT_MAX = 300;

/** 时间线「详情」列的字符上限（过长会把表格撑成一堵墙） */
const TIMELINE_DETAIL_MAX = 160;

/** 改进项里引用证据链时的字符上限（只给锚点，不复制全文） */
const EVIDENCE_HINT_MAX = 80;

/** 时间线表格的最大行数（超出部分只给总数说明，避免报告无限膨胀） */
const MAX_TIMELINE_ROWS = 120;

/** 经验教训条目数量下界（Google SRE 复盘至少要给出 3 条可执行改进项） */
const MIN_LESSON_ITEMS = 3;

/** 经验教训条目数量上界（超过 5 条就没人跟进了） */
const MAX_LESSON_ITEMS = 5;

/** 唯一的省略标记（ASCII 三点，项目禁止 Unicode 省略号） */
const ASCII_ELLIPSIS = '...';

/** 判定「已执行」的自愈回执特征串（由 CopilotDrawer 的系统回执模板产出） */
const VERIFICATION_MARKER = 'MCP Verification';

/* ========================================================================== */
/* 通用格式化与清洗（全部为纯函数）                                               */
/* ========================================================================== */

/**
 * pad2 —— 数字左补零到两位。
 *
 * @param value 非负整数（负数取其绝对值，仅用于时间展示，不做业务判定）
 * @returns 至少两位的字符串
 */
function pad2(value: number): string {
  return Math.abs(Math.trunc(value)).toString().padStart(2, '0');
}

/**
 * toSafeDate —— 把可能非法的时间戳收敛为合法 Date。
 *
 * 【为何需要】nowMs / startedAtMs 由调用方传入，可能来自持久化会话（脏值）或
 * 测试里的 NaN。`new Date(NaN).getFullYear()` 返回 NaN，会让报告标题出现
 * 「NaN-NaN-NaN」这种自毁可信度的字样，因此在入口处统一收敛到 epoch 0。
 *
 * @param epochMs 毫秒时间戳
 * @returns 合法 Date 实例
 */
function toSafeDate(epochMs: number): Date {
  return new Date(Number.isFinite(epochMs) ? epochMs : 0);
}

/**
 * formatDateTime —— 时间戳 → `YYYY-MM-DD HH:mm:ss`（本地时区口径）。
 *
 * @param epochMs 毫秒时间戳
 * @returns 固定宽度的可排序时间串
 */
function formatDateTime(epochMs: number): string {
  const date = toSafeDate(epochMs);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/**
 * formatTimestampCompact —— 时间戳 → `YYYYMMDD-HHmmss`（文件名 / 报告编号专用）。
 *
 * @param epochMs 毫秒时间戳
 * @returns 无分隔符的紧凑时间串
 */
function formatTimestampCompact(epochMs: number): string {
  const date = toSafeDate(epochMs);
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

/**
 * formatTimezoneOffset —— 时间戳所在时区的 UTC 偏移标签。
 *
 * 【为何必须显式标注】复盘会被跨时区评审；一个裸的 `13:30:45` 在异地读者眼里
 * 是无法对齐的。把 `UTC+08:00` 写进报告，等于把时间语义钉死在文档里。
 *
 * @param epochMs 毫秒时间戳
 * @returns 形如 `UTC+08:00` / `UTC-05:00` 的标签
 */
function formatTimezoneOffset(epochMs: number): string {
  const offsetMinutes = -toSafeDate(epochMs).getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

/**
 * formatRelative —— 相对时刻 → `+mm:ss`。
 *
 * @param offsetMs 相对会话起点的毫秒偏移（负数按 0 处理）
 * @returns 形如 `+00:45` 的串
 */
function formatRelative(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.round(offsetMs / 1000));
  return `+${pad2(Math.floor(totalSeconds / 60))}:${pad2(totalSeconds % 60)}`;
}

/**
 * formatDuration —— 时长 → `mm:ss` / `hh:mm:ss`。
 *
 * @param durationMs 毫秒时长（负数按 0 处理）
 * @returns 可读时长
 */
function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * normalizeInline —— 把多行文本压成单行（换行/连续空白折叠为一个空格）。
 *
 * 【为何统一压平】卡片里的 rootCauseSummary / impactScope 是多行叙述，直接塞进
 * Markdown 段落会在客户端渲染时产生破碎的块级结构；表格单元格更不允许换行。
 *
 * @param raw 原文
 * @returns 单行文本
 */
function normalizeInline(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * escapeTableCell —— GFM 表格单元格转义。
 *
 * 【核心逻辑】先把换行压平，再把竖线转义为 `\|`：MarkdownLite 的表格解析器按
 * 竖线切分单元格，未转义的 `|`（常见于 `kubectl -o jsonpath` 或 `a|b` 写法）
 * 会把一行切成错位的多列，整张表随之错乱。
 *
 * @param raw 单元格原文
 * @returns 可安全嵌入表格的文本
 */
function escapeTableCell(raw: string): string {
  return normalizeInline(raw).replace(/\|/g, '\\|');
}

/**
 * truncateText —— 截断到指定字符数，超出时追加 ASCII 省略号。
 *
 * 【长度口径】返回值长度不超过 max（省略号占用名额），而不是 max + 3——
 * 契约写的是「300 字符以内」，多出来的三个点也算超标。
 *
 * @param raw 原文（会先压平为单行）
 * @param max 最大字符数（必须 >= 省略号长度）
 * @returns 截断后的文本
 */
function truncateText(raw: string, max: number): string {
  const normalized = normalizeInline(raw);
  const budget = Math.max(ASCII_ELLIPSIS.length, max);
  if (normalized.length <= budget) return normalized;
  return `${normalized.slice(0, budget - ASCII_ELLIPSIS.length)}${ASCII_ELLIPSIS}`;
}

/**
 * formatPercent —— 百分比数值 → 展示串。
 *
 * @param value 百分比（[0,100] 语义，非法值回落为 `--`）
 * @returns 形如 `87%` 的串
 */
function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '--';
  return `${Math.round(value)}%`;
}

/**
 * formatScore —— 评分展示（整数不留小数位，非整数保留一位）。
 *
 * @param value 评分（[0,100] 语义）
 * @returns 展示串
 */
function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '--';
  return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

/**
 * formatInteger —— 千分位整数（QPS / 重启次数等计数值）。
 *
 * @param value 数值
 * @returns 形如 `12,850` 的串；非法值返回 `--`
 */
function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '--';
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * formatConfidence —— 置信度 / 相似度（[0,1]）→ 百分比展示串。
 *
 * @param value [0,1] 的得分（undefined / 非有限数回落为 `--`）
 * @returns 形如 `92%` 的串
 */
function formatConfidence(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '--';
  return `${Math.round(value * 100)}%`;
}

/**
 * formatLatency —— 单步耗时展示。
 *
 * @param latencyMs 毫秒
 * @returns 形如 `420 ms` 的串
 */
function formatLatency(latencyMs: number): string {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return '0 ms';
  return `${Math.round(latencyMs)} ms`;
}

/**
 * severityLabel —— 告警等级 → 中英对照标签。
 *
 * 【为何用 switch 而非 Record 索引】卡片载荷来自 NDJSON 流（不可信外部输入），
 * 运行期可能出现契约之外的等级字符串。switch 的 default 分支保证任何脏值都
 * 不会渲染成 `undefined`。
 *
 * @param severity 等级原文
 * @returns 展示标签
 */
function severityLabel(severity: string): string {
  switch (severity) {
    case 'P0':
      return 'P0（致命）';
    case 'P1':
      return 'P1（严重）';
    case 'P2':
      return 'P2（警告）';
    default:
      return `${severity}（未登记等级）`;
  }
}

/**
 * phaseLabel —— Agent 推理阶段五态 → 中文泳道名。
 *
 * @param phase 阶段标识
 * @returns 中文标签（未登记值原样返回，避免吞掉信息）
 */
function phaseLabel(phase: string): string {
  switch (phase) {
    case 'INTENT_PLANNING':
      return '意图规划';
    case 'MULTIMODAL_VISION':
      return '多模态视觉';
    case 'RAG_RETRIEVAL':
      return '知识库检索';
    case 'MCP_TOOL_INVOKE':
      return 'MCP 工具调用';
    case 'SAFETY_GUARD':
      return '安全护栏';
    default:
      return phase;
  }
}

/**
 * actionLabel —— MCP 运维动作三态 → 中文可读名。
 *
 * @param actionType 动作类型（restart_pod / scale_deployment / drain_node）
 * @returns 中文名
 */
function actionLabel(actionType: string): string {
  switch (actionType) {
    case 'restart_pod':
      return '重启 Pod';
    case 'scale_deployment':
      return '扩缩容 Deployment';
    case 'drain_node':
      return '驱逐节点';
    default:
      return actionType;
  }
}

/**
 * chaosLabel —— 混沌演练场景 → 中文说明。
 *
 * @param chaos 场景标识（'NONE' 表示稳态）
 * @returns 中文标签
 */
function chaosLabel(chaos: string): string {
  switch (chaos) {
    case 'NONE':
      return 'NONE（稳态，无故障注入）';
    case 'POD_OOM_SWARM':
      return 'POD_OOM_SWARM（Pod OOM 集群性爆发）';
    case 'NODE_CPU_SPIKE':
      return 'NODE_CPU_SPIKE（节点 CPU 尖峰）';
    case 'NET_PACKET_LOSS':
      return 'NET_PACKET_LOSS（网络丢包）';
    default:
      return chaos;
  }
}

/* ========================================================================== */
/* 卡片载荷窄化（运行期类型守卫，零 any）                                          */
/* ========================================================================== */

/** 卡片载荷的三选一联合（与 CopilotToolCard.args 的非空形态一致） */
type CardPayload = NonNullable<CopilotToolCard['args']>;

/**
 * isRootCausePayload —— 判定载荷是否为根因分析卡。
 *
 * 【判定依据】evidenceChain 是 RootCauseAlertProps 独有的字段；用 `in` 窄化而
 * 不是 `as` 断言——断言只是关掉编译器的嘴，守卫才是真的在运行期验证形状。
 *
 * @param payload 卡片载荷
 * @returns 是否为根因卡
 */
function isRootCausePayload(payload: CardPayload): payload is RootCauseAlertProps {
  return 'evidenceChain' in payload && Array.isArray(payload.evidenceChain);
}

/**
 * isActionPayload —— 判定载荷是否为自愈动作审批卡。
 *
 * @param payload 卡片载荷
 * @returns 是否为审批卡
 */
function isActionPayload(payload: CardPayload): payload is ActionConfirmProps {
  return 'mcpEndpoint' in payload && 'actionType' in payload;
}

/**
 * isPodMetricsPayload —— 判定载荷是否为 Pod 指标卡。
 *
 * @param payload 卡片载荷
 * @returns 是否为指标卡
 */
function isPodMetricsPayload(payload: CardPayload): payload is PodMetricsCardProps {
  return 'podId' in payload && Array.isArray(payload.cpuHistory);
}

/* ========================================================================== */
/* 会话模型（一次性抽取，供各章节复用）                                           */
/* ========================================================================== */

/** 抽取出的根因卡（附带其在会话时间轴上的推算时刻） */
interface ExtractedRootCause {
  readonly offsetMs: number;
  readonly props: RootCauseAlertProps;
  readonly toolName: string;
  readonly synthesized: boolean;
}

/** 抽取出的自愈审批卡 */
interface ExtractedAction {
  readonly offsetMs: number;
  readonly props: ActionConfirmProps;
  readonly toolName: string;
  readonly synthesized: boolean;
}

/** 抽取出的 Pod 指标卡 */
interface ExtractedPodMetrics {
  readonly offsetMs: number;
  readonly props: PodMetricsCardProps;
  readonly synthesized: boolean;
}

/**
 * ExecutedActionRecord —— 一条「已执行」的自愈回执。
 *
 * 【来源限定】只从 `isVerification === true` 的系统消息（或含 MCP Verification
 * 标记的消息）里解析，绝不从模型正文里猜——模型完全可以「声称」执行过某个动作。
 */
interface ExecutedActionRecord {
  /** MCP 动作名（如 restart_pod） */
  readonly actionType: string;
  /** 完整 MCP 端点 URI */
  readonly endpoint: string;
  /** 回执中标注的目标容器名（未标注时为「未标注目标」） */
  readonly targetLabel: string;
  /** 推算时刻 */
  readonly offsetMs: number;
  /** 回执原文（单行化，用于附录引用） */
  readonly rawText: string;
}

/** 时间线单行事件 */
interface TimelineEvent {
  /** 相对会话起点的毫秒偏移 */
  readonly offsetMs: number;
  /** 事件列文案 */
  readonly stage: string;
  /** 详情列文案 */
  readonly detail: string;
}

/** 一次会话被抽取出的全部结构化事实 */
interface SessionModel {
  readonly rootCauses: readonly ExtractedRootCause[];
  readonly actions: readonly ExtractedAction[];
  readonly podMetrics: readonly ExtractedPodMetrics[];
  readonly executedActions: readonly ExecutedActionRecord[];
  readonly timeline: readonly TimelineEvent[];
  /** 未就绪卡片数（skeleton / error）——报告里如实计数，不推测载荷 */
  readonly pendingCardCount: number;
  /** 失败消息数（failed === true） */
  readonly failedMessageCount: number;
  /** 用户提问轮数 */
  readonly userTurnCount: number;
  /** 推理步骤累计耗时（时间线推算的总跨度） */
  readonly totalReasoningLatencyMs: number;
}

/**
 * createEndpointPattern —— 构造「MCP 端点 + 动作名」的匹配正则。
 *
 * 【为什么每次新建】带 g 标志的正则有 lastIndex 状态，模块级复用会在多次
 * exec 之间互相污染（第二次匹配从上次结束位置开始，直接漏掉回执）。
 * 工厂函数保证每次解析都拿到干净的正则实例。
 *
 * @returns 全局正则：group[1] = 主机路径段，group[2] = 动作名
 */
function createEndpointPattern(): RegExp {
  return /mcp:\/\/([^\s`]+)\/tools\/([A-Za-z0-9_]+)/g;
}

/**
 * parseVerificationReceipts —— 从自愈验证回执文本里解析执行痕迹。
 *
 * 【真实回执形状】（由 CopilotDrawer.handleActionExecuted 拼装）
 * `[OK] [MCP Verification] 目标容器 \`<name>\` 已通过 \`mcp://k8s-cluster/tools/<actionType>\` ...`
 * 因此只需提取「目标容器」与端点即可还原「谁被执行了什么」。
 * 若一个端点都没有，仍保留一条占位记录：说明回执存在但无法对应到具体动作。
 *
 * @param text 回执正文
 * @param offsetMs 该消息在时间轴上的推算时刻
 * @returns 解析出的执行记录（至少一条）
 */
function parseVerificationReceipts(text: string, offsetMs: number): ExecutedActionRecord[] {
  const targetMatch = /目标容器\s*`([^`]+)`/.exec(text);
  const targetLabel = targetMatch !== null ? normalizeInline(targetMatch[1]) : '未标注目标';
  const rawText = truncateText(text, TIMELINE_DETAIL_MAX);

  const records: ExecutedActionRecord[] = [];
  const pattern = createEndpointPattern();
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    records.push({
      actionType: match[2],
      endpoint: `mcp://${match[1]}/tools/${match[2]}`,
      targetLabel,
      offsetMs,
      rawText,
    });
    match = pattern.exec(text);
  }

  if (records.length === 0) {
    records.push({
      actionType: 'unknown',
      endpoint: '未标注端点',
      targetLabel,
      offsetMs,
      rawText,
    });
  }
  return records;
}

/**
 * buildSessionModel —— 单次遍历会话，抽取卡片、执行回执与时间线。
 *
 * 【时间线推算算法（核心逻辑）】
 * 时钟游标 cursor 从 0 开始，按消息顺序推进：
 * 1. 用户消息：不推进时钟（提问瞬间与上一条回复末刻视为同一时刻），
 *    只落一行「用户提问」事件；
 * 2. AI 消息：按 stepIndex 升序逐条累加 reasoningSteps.latencyMs，
 *    每一步落一行「推理 · <阶段>」事件；累加后的 cursor 即该步结束时刻；
 * 3. 该消息的 toolCards 依次落在 cursor 上（卡片与推理步骤的交叉顺序在
 *    CopilotMessage 契约里不可还原，因此不臆造更细的粒度，只用数组顺序保序）；
 * 4. 正文非空的 AI 消息再落一行「Agent 结论输出」；
 * 5. 自愈验证回执消息：解析执行痕迹并落一行「自愈验证回执」，不推进时钟。
 *
 * 【为什么不编造毫秒级时间】CopilotMessage 没有 timestamp 字段。与其用
 * 消息下标 × 固定系数伪造，不如把推算口径写清楚——后者在复盘评审时站得住脚。
 *
 * @param messages 会话消息列表
 * @returns 结构化会话模型
 */
function buildSessionModel(messages: readonly CopilotMessage[]): SessionModel {
  const rootCauses: ExtractedRootCause[] = [];
  const actions: ExtractedAction[] = [];
  const podMetrics: ExtractedPodMetrics[] = [];
  const executedActions: ExecutedActionRecord[] = [];
  const timeline: TimelineEvent[] = [];

  let cursor = 0;
  let pendingCardCount = 0;
  let failedMessageCount = 0;
  let userTurnCount = 0;
  let totalReasoningLatencyMs = 0;

  for (const message of messages) {
    /* ---------- 用户消息：时间轴锚点，不推进时钟 ---------- */
    if (message.role === 'user') {
      userTurnCount += 1;
      timeline.push({
        offsetMs: cursor,
        stage: '用户提问',
        detail: truncateText(message.text, TIMELINE_DETAIL_MAX) || '（空消息）',
      });
      continue;
    }

    /* ---------- AI 消息 ---------- */
    if (message.failed === true) {
      failedMessageCount += 1;
      timeline.push({
        offsetMs: cursor,
        stage: '请求失败',
        detail: truncateText(message.text, TIMELINE_DETAIL_MAX) || '该轮请求中断，未获得回复',
      });
      continue;
    }

    /**
     * ---------- 自愈验证回执（系统级消息，不是模型回答） ----------
     * 这是「已执行」的唯一可信来源：它由前端在 healEntity 完成后、从真实快照
     * 拼装而成，模型无法伪造到这条通道里。
     */
    if (message.isVerification === true || message.text.includes(VERIFICATION_MARKER)) {
      const receipts = parseVerificationReceipts(message.text, cursor);
      executedActions.push(...receipts);
      timeline.push({
        offsetMs: cursor,
        stage: '自愈执行回执',
        detail: truncateText(message.text, TIMELINE_DETAIL_MAX),
      });
      continue;
    }

    /* ---------- 推理步骤：按 stepIndex 升序累加耗时 ---------- */
    const steps = [...message.reasoningSteps].sort(
      (left, right): number => left.stepIndex - right.stepIndex,
    );
    for (const step of steps) {
      const latency = Number.isFinite(step.latencyMs) && step.latencyMs > 0 ? step.latencyMs : 0;
      cursor += latency;
      totalReasoningLatencyMs += latency;
      const mcpSuffix = step.mcpUri !== undefined && step.mcpUri !== '' ? ` · ${step.mcpUri}` : '';
      timeline.push({
        offsetMs: cursor,
        stage: `推理 · ${phaseLabel(step.phase)}`,
        detail: truncateText(
          `${step.title}${mcpSuffix} · 耗时 ${formatLatency(latency)}`,
          TIMELINE_DETAIL_MAX,
        ),
      });
    }

    /* ---------- 工具卡片：落在当前游标上，保序不造时刻 ---------- */
    for (const card of message.toolCards) {
      if (card.state !== 'ready' || card.args === undefined) {
        pendingCardCount += 1;
        timeline.push({
          offsetMs: cursor,
          stage: '工具卡片（未就绪）',
          detail: truncateText(
            `${card.toolName} · state=${card.state} · ${card.mcpUri}`,
            TIMELINE_DETAIL_MAX,
          ),
        });
        continue;
      }

      const payload = card.args;
      if (isRootCausePayload(payload)) {
        rootCauses.push({
          offsetMs: cursor,
          props: payload,
          toolName: card.toolName,
          synthesized: card.synthesized === true,
        });
        timeline.push({
          offsetMs: cursor,
          stage: '根因分析卡片',
          detail: truncateText(
            `${severityLabel(payload.severity)} · ${payload.title} · 置信度 ${formatConfidence(
              payload.confidence,
            )}`,
            TIMELINE_DETAIL_MAX,
          ),
        });
      } else if (isActionPayload(payload)) {
        actions.push({
          offsetMs: cursor,
          props: payload,
          toolName: card.toolName,
          synthesized: card.synthesized === true,
        });
        timeline.push({
          offsetMs: cursor,
          stage: '自愈审批卡片',
          detail: truncateText(
            `${actionLabel(payload.actionType)} · 目标 ${payload.targetName} · 高危 ${
              payload.isHighRisk ? '是' : '否'
            }`,
            TIMELINE_DETAIL_MAX,
          ),
        });
      } else if (isPodMetricsPayload(payload)) {
        podMetrics.push({
          offsetMs: cursor,
          props: payload,
          synthesized: card.synthesized === true,
        });
        timeline.push({
          offsetMs: cursor,
          stage: 'Pod 指标卡片',
          detail: truncateText(
            `${payload.podName}（${payload.namespace}）· CPU ${formatPercent(
              payload.cpuUsage,
            )} · 内存 ${formatPercent(payload.memoryUsage)} · 重启 ${payload.restarts} 次`,
            TIMELINE_DETAIL_MAX,
          ),
        });
      } else {
        timeline.push({
          offsetMs: cursor,
          stage: '未知卡片载荷',
          detail: truncateText(`${card.toolName} · 载荷形状不在三类契约内`, TIMELINE_DETAIL_MAX),
        });
      }
    }

    /* ---------- 正文结论 ---------- */
    if (normalizeInline(message.text) !== '') {
      timeline.push({
        offsetMs: cursor,
        stage: 'Agent 结论输出',
        detail: truncateText(message.text, TIMELINE_DETAIL_MAX),
      });
    }
  }

  return {
    rootCauses,
    actions,
    podMetrics,
    executedActions,
    timeline,
    pendingCardCount,
    failedMessageCount,
    userTurnCount,
    totalReasoningLatencyMs,
  };
}

/* ========================================================================== */
/* 派生工具                                                                    */
/* ========================================================================== */

/**
 * collectRunbookRefs —— 汇总所有根因卡引用的 Runbook（按 id 去重，保持出现顺序）。
 *
 * 【为何保序而不按分数重排】同一篇手册可能被多张卡片引用，分数各自不同。
 * 去重时保留**首次出现**的顺序，读者可以据此还原「哪张卡先命中了什么」；
 * 排序会丢失这层因果线索。
 *
 * @param model 会话模型
 * @returns 去重后的知识库切片
 */
function collectRunbookRefs(model: SessionModel): RagRunbookDoc[] {
  const seen = new Set<string>();
  const refs: RagRunbookDoc[] = [];
  for (const card of model.rootCauses) {
    for (const doc of card.props.ragReferences) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      refs.push(doc);
    }
  }
  return refs;
}

/**
 * summarizePodStatuses —— 异常 Pod 的状态分布（如 `OOMKilled 2 个、Running 1 个`）。
 *
 * @param pods 异常 Pod 快照
 * @returns 中文分布串；空集合返回「无」
 */
function summarizePodStatuses(pods: readonly ClusterFaultSnapshot[]): string {
  if (pods.length === 0) return '无';
  const counts = new Map<string, number>();
  for (const pod of pods) {
    counts.set(pod.status, (counts.get(pod.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]): string => `${status} ${count} 个`).join('、');
}

/**
 * summarizeNodes —— 节点就绪度摘要。
 *
 * @param context 集群上下文
 * @returns 形如 `节点 3/3 处于 Ready` 的串
 */
function summarizeNodes(context: ClusterContext): string {
  const total = context.nodes.length;
  const ready = context.nodes.filter((node): boolean => node.status === 'Ready').length;
  return `节点 ${ready}/${total} 处于 Ready`;
}

/**
 * resolveAffectedEntity —— 推断「受影响实体」的展示名。
 *
 * 【优先级】快照里的异常 Pod > 用户选中实体 > 根因卡标题 > 兜底说明。
 * 之所以把 faultyPods 排在选中实体之前：事故报告关心的是「谁坏了」，
 * 而不是「用户当时在看谁」。三者都没有时如实写未识别，不编一个名字。
 *
 * @param context 集群上下文
 * @param primary 首张根因卡（可能不存在）
 * @returns 展示名
 */
function resolveAffectedEntity(
  context: ClusterContext,
  primary: ExtractedRootCause | undefined,
): string {
  const firstFaulty = context.faultyPods[0];
  if (firstFaulty !== undefined) {
    return `POD ${firstFaulty.name}（命名空间 ${firstFaulty.namespace}）`;
  }
  if (
    context.selectedEntityId !== null &&
    context.selectedEntityId.trim() !== '' &&
    context.selectedEntityType !== null
  ) {
    return `${context.selectedEntityType.toUpperCase()} ${context.selectedEntityId}`;
  }
  if (primary !== undefined) {
    return `根因卡标题所述范围：${normalizeInline(primary.props.title)}`;
  }
  return '本次会话未识别到具体受影响实体';
}

/**
 * pickWorstPod —— 从异常 Pod 里挑出「最值得先处理」的那个。
 *
 * 【打分口径】内存水位 + 重启次数 × 5：内存是 OOM 类故障的直接驱动量，
 * 重启次数则代表「已经持续恶化过多久」，两者相加既照顾当前严重度，
 * 也照顾恶化趋势。纯数值、无随机，保证报告可复现。
 *
 * @param pods 异常 Pod 快照
 * @returns 最严重的 Pod；无异常 Pod 时返回 undefined
 */
function pickWorstPod(pods: readonly ClusterFaultSnapshot[]): ClusterFaultSnapshot | undefined {
  let worst: ClusterFaultSnapshot | undefined;
  let worstScore = Number.NEGATIVE_INFINITY;
  for (const pod of pods) {
    const memory = Number.isFinite(pod.memoryUsage) ? pod.memoryUsage : 0;
    const restarts = Number.isFinite(pod.restarts) ? pod.restarts : 0;
    const score = memory + restarts * 5;
    if (score > worstScore) {
      worstScore = score;
      worst = pod;
    }
  }
  return worst;
}

/**
 * maxValue —— 数值序列最大值（空序列回落到 fallback）。
 *
 * @param values 数值序列
 * @param fallback 兜底值
 * @returns 最大值
 */
function maxValue(values: readonly number[], fallback: number): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max === Number.NEGATIVE_INFINITY ? fallback : max;
}

/** 节点摘要类型（ClusterContext.nodes 的元素） */
type NodeSummary = ClusterContext['nodes'][number];

/**
 * pickBusiestNode —— 选出 CPU 水位最高的节点。
 *
 * @param context 集群上下文
 * @returns 节点摘要；无节点时返回 undefined
 */
function pickBusiestNode(context: ClusterContext): NodeSummary | undefined {
  let busiest: NodeSummary | undefined;
  let highest = Number.NEGATIVE_INFINITY;
  for (const node of context.nodes) {
    const cpu = Number.isFinite(node.cpuUsage) ? node.cpuUsage : 0;
    if (cpu > highest) {
      highest = cpu;
      busiest = node;
    }
  }
  return busiest;
}

/* ========================================================================== */
/* 章节构建器                                                                  */
/* ========================================================================== */

/**
 * buildReportId —— 报告编号（`KV-PM-YYYYMMDD-HHmmss`）。
 *
 * @param epochMs 生成时刻
 * @returns 可直接归档引用的编号
 */
function buildReportId(epochMs: number): string {
  return `KV-PM-${formatTimestampCompact(epochMs)}`;
}

/**
 * buildHeaderLines —— 报告头（标题 + 生成时间 / 编号 / 数据来源声明）。
 *
 * @param input 报告输入
 * @returns Markdown 行数组
 */
function buildHeaderLines(input: PostMortemInput): string[] {
  const startMs = Number.isFinite(input.startedAtMs) ? input.startedAtMs : 0;
  const reportMs = Number.isFinite(input.nowMs) ? input.nowMs : startMs;
  const spanMs = Math.max(0, reportMs - startMs);
  return [
    '# KubeVision AI 生产事故根因分析与自愈复盘报告',
    '',
    `> 生成时间：${formatDateTime(reportMs)}（${formatTimezoneOffset(reportMs)}）`,
    `> 报告编号：${buildReportId(reportMs)}`,
    `> 会话起点：${formatDateTime(startMs)}（${formatTimezoneOffset(
      startMs,
    )}） · 会话跨度：${formatDuration(spanMs)}`,
    '> 数据来源：端侧实时集群快照（ClusterContext：健康分 / 入口 QPS / 异常 Pod / 节点水位）+ Agent 推理链（reasoningSteps：五态阶段与单步耗时）+ 生成式 UI 卡片载荷（toolCards.args：指标卡 / 根因卡 / 自愈审批卡）。全部字段由浏览器内的会话状态推导，报告中不存在手工补写的数据。',
  ];
}

/**
 * buildSummarySection —— 第 1 章：事故摘要（表格 + 表象概述）。
 *
 * @param input 报告输入
 * @param model 会话模型
 * @returns Markdown 行数组
 */
function buildSummarySection(input: PostMortemInput, model: SessionModel): string[] {
  const context = input.clusterContext;
  const startMs = Number.isFinite(input.startedAtMs) ? input.startedAtMs : 0;
  const primary = model.rootCauses[0];
  const lines: string[] = [];

  const affectedEntity = resolveAffectedEntity(context, primary);
  const severityText =
    primary !== undefined
      ? severityLabel(primary.props.severity)
      : '未定级（本次会话未产出根因分析卡片）';
  /**
   * 【秒级对齐】formatRelative 把偏移四舍五入到秒，而绝对时刻若直接用原始
   * 毫秒会与相对时刻出现「同一事件两个时间」的错位（绝对 13:30:45 配 +00:01）。
   * 这里先把偏移对齐到整秒再换算绝对时刻，两列永远自洽。
   */
  const detectionOffsetMs = primary !== undefined ? Math.round(primary.offsetMs / 1000) * 1000 : 0;
  const detectionMs = startMs + detectionOffsetMs;
  const detectionText =
    primary !== undefined
      ? `${formatDateTime(detectionMs)}（${formatTimezoneOffset(
          detectionMs,
        )}）· 相对会话起点 ${formatRelative(detectionOffsetMs)} · 由推理链耗时推算`
      : `${formatDateTime(startMs)}（${formatTimezoneOffset(
          startMs,
        )}）· 会话起点（无根因卡可定位检测时刻）`;
  const statusText = `${summarizePodStatuses(context.faultyPods)}；${summarizeNodes(
    context,
  )}；演练场景 ${context.activeChaos}`;

  lines.push('## 1. 事故摘要 (Incident Summary)');
  lines.push('');
  lines.push('| 项目 | 内容 |');
  lines.push('| --- | --- |');
  lines.push(`| 受影响实体 | ${escapeTableCell(affectedEntity)} |`);
  lines.push(`| 严重度 | ${escapeTableCell(severityText)} |`);
  lines.push(`| 检测时刻 | ${escapeTableCell(detectionText)} |`);
  lines.push(`| 当前状态 | ${escapeTableCell(statusText)} |`);
  lines.push(
    `| 集群健康分 | ${escapeTableCell(`${formatScore(context.clusterHealthScore)} / 100`)} |`,
  );
  lines.push(`| 吞吐 QPS | ${escapeTableCell(`${formatInteger(context.totalQps)} QPS`)} |`);
  lines.push('');

  /* ---- 表象概述：逐句拼装，每句都对应一个可核对的字段 ---- */
  const symptomParts: string[] = [];
  symptomParts.push(
    `集群健康分 ${formatScore(context.clusterHealthScore)}/100，入口吞吐 ${formatInteger(
      context.totalQps,
    )} QPS`,
  );
  if (context.faultyPods.length > 0) {
    symptomParts.push(
      `快照中存在 ${context.faultyPods.length} 个异常 Pod（${summarizePodStatuses(
        context.faultyPods,
      )}）`,
    );
  } else {
    symptomParts.push('快照中不存在异常 Pod（clusterContext.faultyPods 为空）');
  }
  if (context.activeChaos !== 'NONE') {
    symptomParts.push(`混沌演练场景 ${chaosLabel(context.activeChaos)}处于激活状态`);
  }
  if (primary !== undefined) {
    symptomParts.push(
      `Agent 判定根因标题为「${normalizeInline(primary.props.title)}」，自评置信度 ${formatConfidence(
        primary.props.confidence,
      )}，引用 Runbook ${primary.props.ragReferences.length} 篇`,
    );
  } else {
    symptomParts.push('本次会话未产出根因分析卡片，根因尚未形成可引用的结论');
  }
  lines.push(`**表象概述**：${symptomParts.join('；')}。`);
  lines.push('');

  const executedCount = model.executedActions.filter(
    (record): boolean => record.actionType !== 'unknown',
  ).length;
  lines.push(`- 会话规模：${model.userTurnCount} 轮用户提问，共 ${input.messages.length} 条消息。`);
  lines.push(
    `- 卡片产出：根因卡 ${model.rootCauses.length} 张、自愈审批卡 ${
      model.actions.length
    } 张、指标卡 ${model.podMetrics.length} 张${
      model.pendingCardCount > 0 ? `，另有 ${model.pendingCardCount} 张卡片未就绪` : ''
    }。`,
  );
  lines.push(
    `- 自愈闭环：${
      executedCount > 0
        ? `检测到 ${executedCount} 条 MCP Verification 执行回执，已执行动作 ${model.executedActions
            .filter((record): boolean => record.actionType !== 'unknown')
            .map((record): string => actionLabel(record.actionType))
            .join('、')}。`
        : '会话中未检测到 MCP Verification 执行回执，所有审批卡均按「待审批」处理。'
    }`,
  );
  if (model.failedMessageCount > 0) {
    lines.push(
      `- 异常消息：${model.failedMessageCount} 条消息被标记为失败（failed=true），其内容不完整，未纳入本次定论。`,
    );
  }

  return lines;
}

/**
 * buildImpactSection —— 第 2 章：影响范围（impactScope + 异常 Pod 明细 + 实测指标）。
 *
 * @param input 报告输入
 * @param model 会话模型
 * @returns Markdown 行数组
 */
function buildImpactSection(input: PostMortemInput, model: SessionModel): string[] {
  const context = input.clusterContext;
  const lines: string[] = [];

  lines.push('## 2. 影响范围 (Impact)');
  lines.push('');

  if (model.rootCauses.length === 0) {
    lines.push('本次会话未产出根因分析卡片，因此没有可引用的 impactScope 描述。');
    lines.push('');
  } else {
    lines.push('**Agent 给出的影响范围（来自 RootCauseAlertProps.impactScope）**');
    lines.push('');
    model.rootCauses.forEach((card, index): void => {
      lines.push(
        `- 卡片 ${index + 1} · 严重度 ${card.props.severity}：${normalizeInline(
          card.props.impactScope,
        )}`,
      );
    });
    lines.push('');
  }

  /* ---- 2.1 异常 Pod 明细 ---- */
  lines.push('### 2.1 异常 Pod 明细（来自 clusterContext.faultyPods）');
  lines.push('');
  if (context.faultyPods.length === 0) {
    lines.push('当前快照中没有异常 Pod。故障可能已自愈，或本次会话启动于稳态窗口。');
  } else {
    lines.push('| Pod 名称 | 命名空间 | 状态 | CPU | 内存 | 重启次数 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const pod of context.faultyPods) {
      lines.push(
        `| ${escapeTableCell(pod.name)} | ${escapeTableCell(pod.namespace)} | ${escapeTableCell(
          pod.status,
        )} | ${escapeTableCell(formatPercent(pod.cpuUsage))} | ${escapeTableCell(
          formatPercent(pod.memoryUsage),
        )} | ${escapeTableCell(`${formatInteger(pod.restarts)} 次`)} |`,
      );
    }
  }
  lines.push('');

  /* ---- 2.2 指标卡实测快照 ---- */
  if (model.podMetrics.length > 0) {
    lines.push('### 2.2 Agent 指标卡实测快照（来自 renderPodMetrics 卡片）');
    lines.push('');
    lines.push('| Pod 名称 | 命名空间 | CPU | 内存 | 重启次数 | CPU 历史（6 点） |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const card of model.podMetrics) {
      const history = card.props.cpuHistory
        .map((value): string => formatPercent(value))
        .join(' -> ');
      lines.push(
        `| ${escapeTableCell(card.props.podName)} | ${escapeTableCell(
          card.props.namespace,
        )} | ${escapeTableCell(formatPercent(card.props.cpuUsage))} | ${escapeTableCell(
          formatPercent(card.props.memoryUsage),
        )} | ${escapeTableCell(`${formatInteger(card.props.restarts)} 次`)} | ${escapeTableCell(
          history,
        )} |`,
      );
    }
    lines.push('');
  }

  /* ---- 2.3 用户观测焦点 ---- */
  const selected = context.selectedPodSnapshot;
  if (selected !== undefined) {
    lines.push('### 2.3 用户观测焦点（selectedPodSnapshot）');
    lines.push('');
    lines.push(
      `- 实体：POD ${escapeTableCell(selected.name)}（命名空间 ${escapeTableCell(
        selected.namespace,
      )}），状态 ${escapeTableCell(selected.status)}`,
    );
    lines.push(
      `- 实时水位：CPU ${formatPercent(selected.cpuUsage)}、内存 ${formatPercent(
        selected.memoryUsage,
      )}、累计重启 ${formatInteger(selected.restarts)} 次`,
    );
    lines.push(
      `- 内存历史（6 点）：${selected.memHistory.map((value): string => formatPercent(value)).join(' -> ')}`,
    );
  }

  return lines;
}

/**
 * buildTimelineSection —— 第 3 章：时间线（`| 相对时刻 | 事件 | 详情 |`）。
 *
 * @param model 会话模型
 * @returns Markdown 行数组
 */
/**
 * buildIncidentBufferSection —— 遥测帧事故时间线章节（可选）。
 *
 * 【与「会话时间线」的区别】前面的时间线来自 Copilot 对话消息（人做了什么），
 * 这一节来自**遥测帧**（系统发生了什么）：告警何时出现、健康分何时跌破、
 * 何时回升。复盘时两者对照，才能回答"是人没看到，还是数据没报出来"。
 *
 * @param input 复盘输入
 * @returns 章节行数组；没有时间线时返回空数组（不输出空章节）
 */
function buildIncidentBufferSection(input: PostMortemInput): string[] {
  const markdown = input.incidentTimelineMarkdown ?? '';
  if (markdown.trim().length === 0) return [];
  return [
    '## 遥测帧事故时间线',
    '',
    '> 由最近 120 帧遥测快照自动推导（每秒 1 帧，约 2 分钟窗口），相对时间为缓冲内偏移。',
    '',
    markdown,
    '',
  ];
}

function buildTimelineSection(model: SessionModel): string[] {
  const lines: string[] = [];
  lines.push('## 3. 时间线 (Timeline)');
  lines.push('');
  lines.push(
    '> 时间口径：CopilotMessage 契约不含绝对时间戳，相对时刻由每条 AI 消息的 reasoningSteps.latencyMs 顺序累加推算（用户提问不推进时钟），格式为 `+mm:ss`。该时间线用于还原因果顺序，不作为内核级精确证据。',
  );
  lines.push('');

  if (model.timeline.length === 0) {
    lines.push('本次会话没有任何消息，时间线为空。');
    return lines;
  }

  const visible = model.timeline.slice(0, MAX_TIMELINE_ROWS);
  lines.push('| 相对时刻 | 事件 | 详情 |');
  lines.push('| --- | --- | --- |');
  for (const event of visible) {
    lines.push(
      `| ${escapeTableCell(formatRelative(event.offsetMs))} | ${escapeTableCell(
        event.stage,
      )} | ${escapeTableCell(event.detail)} |`,
    );
  }
  if (model.timeline.length > visible.length) {
    lines.push('');
    lines.push(
      `时间线共 ${model.timeline.length} 条事件，上表按发生顺序展示前 ${visible.length} 条（超出部分已省略，可用原始会话数据回溯）。`,
    );
  }

  return lines;
}

/**
 * buildRootCauseSection —— 第 4 章：根因分析（每张卡一个小节）。
 *
 * @param model 会话模型
 * @returns Markdown 行数组
 */
function buildRootCauseSection(model: SessionModel): string[] {
  const lines: string[] = [];
  lines.push('## 4. 根因分析 (Root Cause Analysis)');
  lines.push('');

  if (model.rootCauses.length === 0) {
    lines.push('本次会话未产出根因分析卡片。');
    lines.push('');
    lines.push(
      '> 说明：没有任何根因卡（reportRootCause / renderRootCauseAnalysis）进入会话，因此本报告不对根因作任何推测。若故障确实存在，应重新发起一次带异常 Pod 上下文的诊断请求。',
    );
    return lines;
  }

  model.rootCauses.forEach((card, index): void => {
    const props = card.props;
    lines.push(`### 4.${index + 1} ${normalizeInline(props.title)}`);
    lines.push('');
    lines.push(
      `- 严重度：${severityLabel(props.severity)} · 模型自评置信度：${formatConfidence(props.confidence)}`,
    );
    lines.push(
      `- 卡片来源：${card.synthesized ? '服务端补全（synthesized=true）' : '模型原生调用'} · 工具名 \`${card.toolName}\``,
    );
    lines.push(`- 时间位置：${formatRelative(card.offsetMs)}`);
    lines.push('');
    lines.push('**根因摘要**');
    lines.push('');
    lines.push(normalizeInline(props.rootCauseSummary));
    lines.push('');
    lines.push('**证据链（时间有序）**');
    lines.push('');
    if (props.evidenceChain.length === 0) {
      lines.push('该卡片未提供证据链条目。');
    } else {
      props.evidenceChain.forEach((evidence, evidenceIndex): void => {
        lines.push(`${evidenceIndex + 1}. ${normalizeInline(evidence)}`);
      });
    }
    lines.push('');
  });

  return lines;
}

/**
 * buildKnowledgeSection —— 第 5 章：知识库依据（引用表 + 每篇根因机制摘要）。
 *
 * @param model 会话模型
 * @returns Markdown 行数组
 */
function buildKnowledgeSection(model: SessionModel): string[] {
  const lines: string[] = [];
  const refs = collectRunbookRefs(model);

  lines.push('## 5. 知识库依据 (Knowledge Base References)');
  lines.push('');

  if (refs.length === 0) {
    lines.push(
      model.rootCauses.length === 0
        ? '本次会话未产出根因分析卡片，因此没有任何 Runbook 被引用。'
        : '本次会话的根因卡片未携带 ragReferences，知识库依据缺失。',
    );
    return lines;
  }

  lines.push('| 编号 | 标题 | 匹配度 | 分类 |');
  lines.push('| --- | --- | --- | --- |');
  for (const doc of refs) {
    lines.push(
      `| ${escapeTableCell(doc.id)} | ${escapeTableCell(doc.title)} | ${escapeTableCell(
        formatConfidence(doc.similarityScore),
      )} | ${escapeTableCell(doc.category)} |`,
    );
  }
  lines.push('');

  refs.forEach((doc, index): void => {
    lines.push(`### 5.${index + 1} ${doc.id} · ${normalizeInline(doc.title)}`);
    lines.push('');
    lines.push(
      `- 匹配度：${formatConfidence(doc.similarityScore)} · 分类：${doc.category} · 语料来源：${
        doc.isCustom === true ? '自定义语料（localStorage）' : '内置语料'
      }`,
    );
    lines.push(
      `- 根因机制（截断至 ${MECHANISM_EXCERPT_MAX} 字符）：${truncateText(
        doc.rootCauseMechanism,
        MECHANISM_EXCERPT_MAX,
      )}`,
    );
    lines.push('');
  });

  return lines;
}

/**
 * buildRemediationSection —— 第 6 章：处置动作（审批卡 + 执行状态判定）。
 *
 * 【执行状态判定口径】「已执行」只认 MCP Verification 回执里的动作名；
 * 卡片自身没有执行状态字段（ActionConfirmProps 的执行态是组件内部 state，
 * 不进会话数据），因此任何未经回执确认的动作一律标「待审批」。
 *
 * @param model 会话模型
 * @returns Markdown 行数组
 */
function buildRemediationSection(model: SessionModel): string[] {
  const lines: string[] = [];
  lines.push('## 6. 处置动作 (Remediation Actions)');
  lines.push('');

  if (model.actions.length === 0 && model.executedActions.length === 0) {
    lines.push('本次会话未产出处置动作卡片，也没有检测到自愈执行回执。');
    return lines;
  }
  lines.push(
    '> 状态判定口径：ActionConfirmProps.onActionExecuted 是回调函数而非会话数据，卡片执行态不进入消息流；因此本表只以「MCP Verification 执行回执」作为「已执行」的唯一证据，无回执即视为「待审批」。',
  );
  lines.push('');

  if (model.actions.length > 0) {
    lines.push('| 动作类型 | 目标 | MCP 端点 | 是否高危 | 执行状态 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const action of model.actions) {
      const matched = model.executedActions.find(
        (record): boolean => record.actionType === action.props.actionType,
      );
      const statusText =
        matched !== undefined ? `已执行（${formatRelative(matched.offsetMs)} 回执）` : '待审批';
      lines.push(
        `| ${escapeTableCell(actionLabel(action.props.actionType))} | ${escapeTableCell(
          action.props.targetName,
        )} | ${escapeTableCell(action.props.mcpEndpoint)} | ${escapeTableCell(
          action.props.isHighRisk ? '是（需二次确认）' : '否',
        )} | ${escapeTableCell(statusText)} |`,
      );
    }
    lines.push('');

    model.actions.forEach((action, index): void => {
      const matched = model.executedActions.find(
        (record): boolean => record.actionType === action.props.actionType,
      );
      lines.push(
        `### 6.${index + 1} ${actionLabel(action.props.actionType)} · ${normalizeInline(
          action.props.targetName,
        )}`,
      );
      lines.push('');
      lines.push(`- 目标实体 ID：${action.props.targetId}`);
      lines.push(`- MCP 端点：\`${action.props.mcpEndpoint}\``);
      lines.push(`- 参数说明：${normalizeInline(action.props.paramDescription)}`);
      lines.push(
        `- 卡片来源：${action.synthesized ? '服务端补全（synthesized=true）' : '模型原生调用'} · 工具名 \`${action.toolName}\``,
      );
      lines.push(
        `- 执行状态：${
          matched !== undefined
            ? `已执行 —— 会话中检索到对应的 MCP Verification 回执（相对时刻 ${formatRelative(
                matched.offsetMs,
              )}，目标 ${matched.targetLabel}）`
            : '待审批 —— 会话中未检索到该动作的 MCP Verification 回执，动作尚未执行'
        }`,
      );
      lines.push('');
    });
  }

  if (model.executedActions.length > 0) {
    lines.push('### 6.A 自愈执行回执原文');
    lines.push('');
    model.executedActions.forEach((record): void => {
      lines.push(
        `- ${formatRelative(record.offsetMs)} · ${actionLabel(record.actionType)} · ${
          record.endpoint
        } · ${record.rawText}`,
      );
    });
    const unknownCount = model.executedActions.filter(
      (record): boolean => record.actionType === 'unknown',
    ).length;
    if (unknownCount > 0) {
      lines.push('');
      lines.push(
        `> 注意：${unknownCount} 条回执未包含可解析的 MCP 端点，无法对应到具体动作卡片，已按原文保留。`,
      );
    }
  }

  return lines;
}

/**
 * buildLessonItems —— 第 7 章：经验教训与后续改进项（3~5 条，全部可执行）。
 *
 * 【为什么不能写「加强监控」】空话型改进项没有任何验收标准，下次复盘时
 * 无法判断是否完成。因此每条都绑定：
 * 1. 一个具体的实体或数值（Pod 名、水位、重启次数、健康分、QPS）；
 * 2. 一个具体的动作（改哪个字段、跑哪条命令、验收阈值多少）；
 * 3. 有 RAG 命中时引用对应 Runbook 编号，让改进项与知识库互相锚定。
 *
 * 【条目生成策略】按信号优先级收集候选（内存 / 重启 / 网络 / 节点水位 /
 * 自愈留痕 / 证据固化 / SLO 回归 / 检索质量 / 时间口径），再取前 5 条。
 * 恒有三条兜底项（SLO 基线、RAG 命中质量、时间口径），保证任何输入都满足
 * 「不少于 3 条」的契约。
 *
 * @param input 报告输入
 * @param model 会话模型
 * @returns Markdown 复选框行数组
 */
function buildLessonItems(input: PostMortemInput, model: SessionModel): string[] {
  const context = input.clusterContext;
  const refs = collectRunbookRefs(model);
  const primary = model.rootCauses[0];
  const worstPod = pickWorstPod(context.faultyPods);
  const candidates: string[] = [];

  /* ---- 候选 1：内存配额（OOM 类故障的第一处置项） ---- */
  const memoryRef = refs.find((doc): boolean => doc.category === 'memory');
  if (worstPod !== undefined && (worstPod.memoryUsage >= 80 || memoryRef !== undefined)) {
    const peak = maxValue(worstPod.memHistory, worstPod.memoryUsage);
    /* 峰值上浮 30% 后向上取整到 5 的倍数（水位单位是百分比，故以 100 为上限封顶） */
    const rawLimit = Math.ceil((peak * 1.3) / 5) * 5;
    const limitAdvice =
      rawLimit >= 100
        ? '100%（已顶到水位刻度上限，实际应直接按 MiB 重新核算 limit）'
        : `${formatPercent(rawLimit)}（水位百分比口径，落地时须换算为 MiB）`;
    candidates.push(
      `- [ ] 为 ${worstPod.name}（命名空间 ${worstPod.namespace}）按 cgroup v2 memory.max 口径补全内存配额：当前水位 ${formatPercent(
        worstPod.memoryUsage,
      )}，近 ${worstPod.memHistory.length} 个采样点峰值为 ${formatPercent(
        peak,
      )}，按「峰值上浮 30% 后向上取整到 5 的倍数」推算的 limit 参考值为 ${limitAdvice}；requests 取 limit 的 70%，使 QoS 从 Burstable 升为 Guaranteed，避免节点内存压力下 OOM Killer 依据 oom_score_adj 优先选中本容器。`,
    );
  }

  /* ---- 候选 2：重启治理（CrashLoopBackOff 的根因常是探针配置而非代码） ---- */
  const restartPod = context.faultyPods.find((pod): boolean => pod.restarts > 0);
  if (restartPod !== undefined) {
    const crashRef = refs.find((doc): boolean => doc.category === 'runtime');
    candidates.push(
      `- [ ] ${restartPod.name} 已累计 ${formatInteger(restartPod.restarts)} 次重启${
        crashRef !== undefined ? `，与 ${crashRef.id} 的 CrashLoopBackOff 判定口径一致` : ''
      }：把 startupProbe 与 livenessProbe 拆开，startupProbe 的 periodSeconds 乘 failureThreshold 必须覆盖冷启动最坏耗时，livenessProbe 只判活不判就绪，避免探针把仍在初始化的容器反复打回重启循环。`,
    );
  }

  /* ---- 候选 3：网络链路（VXLAN / CNI 类） ---- */
  const networkRef = refs.find((doc): boolean => doc.category === 'network');
  if (context.activeChaos === 'NET_PACKET_LOSS' || networkRef !== undefined) {
    const nodeNames =
      context.nodes.length > 0
        ? context.nodes.map((node): string => node.name).join('、')
        : '（上下文中未提供节点）';
    candidates.push(
      `- [ ] 针对 ${chaosLabel(
        context.activeChaos,
      )} 场景复核 VXLAN 隧道与 CNI 丢包：对节点 ${nodeNames} 依次探测路径 MTU（禁止分片地 ping 目标地址），并核对 vxlan VNI 与 underlay 网卡 MTU 是否一致；${
        networkRef !== undefined
          ? `${networkRef.id}（${networkRef.title}）已给出对应判定步骤`
          : '同时把本类故障补进知识库，当前未命中任何 network 类 Runbook'
      }。`,
    );
  }

  /* ---- 候选 4：节点水位与调度余量 ---- */
  const busiestNode = pickBusiestNode(context);
  if (busiestNode !== undefined && (busiestNode.cpuUsage >= 75 || busiestNode.memUsage >= 80)) {
    candidates.push(
      `- [ ] 对 ${busiestNode.name}（CPU ${formatPercent(busiestNode.cpuUsage)}、内存 ${formatPercent(
        busiestNode.memUsage,
      )}）执行 kubectl describe node 复核 Allocatable 与已分配 requests 的差额，并按 QoS 分级口径把非关键负载迁出该节点；当前状态下任何一次副本扩容都会把该节点推向 HighLoad。`,
    );
  }

  /* ---- 候选 5：自愈留痕（已执行要补审批，未执行要定责任人） ---- */
  const executedRecord = model.executedActions.find(
    (record): boolean => record.actionType !== 'unknown',
  );
  if (executedRecord !== undefined) {
    candidates.push(
      `- [ ] 为已执行的自愈动作补审批留痕：本次在 ${formatRelative(
        executedRecord.offsetMs,
      )} 经 ${executedRecord.endpoint} 对 ${executedRecord.targetLabel} 执行了「${actionLabel(
        executedRecord.actionType,
      )}」，需在变更系统补录工单号，并核对 healedPodIds 免疫窗口是否会把同 Pod 的重复告警吞掉——免疫窗口是去重机制，不是故障已消除的证明。`,
    );
  } else if (model.actions.length > 0) {
    candidates.push(
      `- [ ] ${model.actions.length} 张自愈审批卡仍处于待审批状态（首张目标 ${
        model.actions[0].props.targetName
      }）：明确责任人与执行窗口，首张卡片标注的动作「${actionLabel(
        model.actions[0].props.actionType,
      )}」高危属性为${model.actions[0].props.isHighRisk ? '是（必须两人复核）' : '否'}，未执行的卡片不得在下一轮复盘中记为已处置。`,
    );
  }

  /* ---- 候选 6：把证据链固化为可自动触发的告警 ---- */
  if (primary !== undefined && primary.props.evidenceChain.length > 0) {
    const firstEvidence = truncateText(primary.props.evidenceChain[0], EVIDENCE_HINT_MAX);
    candidates.push(
      `- [ ] 把证据链首条「${firstEvidence}」固化为 Prometheus 告警表达式并设置 for: 2m，使同类根因在升级为 P0 之前先产生 P2 预警；本次根因自评置信度为 ${formatConfidence(
        primary.props.confidence,
      )}，低于 70% 的结论在复盘中应按推断标注，不得直接转化为变更依据。`,
    );
  }

  /* ---- 恒有三条兜底项（保证任何输入都不少于 3 条） ---- */
  candidates.push(
    `- [ ] 以本次集群健康分 ${formatScore(context.clusterHealthScore)}/100、入口 ${formatInteger(
      context.totalQps,
    )} QPS、异常 Pod ${context.faultyPods.length} 个为基线，在 ${chaosLabel(
      context.activeChaos,
    )} 场景下做一次 15 分钟回归演练：验收标准为健康分回升至 95 以上、异常 Pod 归零、且不再产生 P0 告警；未达标则回滚本轮配额与探针变更。`,
  );
  candidates.push(
    `- [ ] 复核本次检索质量：会话共命中 ${refs.length} 篇 Runbook${
      refs.length > 0 ? `（${refs.map((doc): string => doc.id).join('、')}）` : ''
    }；${
      refs.length === 0
        ? '命中为 0 说明端侧 Embedding 可能已退化为关键词通道，需为 memory / network 两类故障各补一条症状样本做检索回归'
        : '对未命中的其余分类各补一条真实症状描述作为检索回归样本，防止下次同类故障因措辞差异而检索落空'
    }。`,
  );
  candidates.push(
    `- [ ] 补全复盘的时间口径：本报告时间线由 ${model.timeline.length} 条事件与累计 ${formatLatency(
      model.totalReasoningLatencyMs,
    )} 推理耗时推算（总跨度 ${formatDuration(
      model.totalReasoningLatencyMs,
    )}），缺少消息级时间戳；需在 NDJSON 协议中为每条消息补充时间字段，使复盘时间线与告警系统的真实时刻可逐点对齐。`,
  );

  return candidates.slice(0, Math.max(MIN_LESSON_ITEMS, MAX_LESSON_ITEMS));
}

/**
 * buildLessonSection —— 第 7 章：经验教训与后续改进。
 *
 * @param input 报告输入
 * @param model 会话模型
 * @returns Markdown 行数组
 */
function buildLessonSection(input: PostMortemInput, model: SessionModel): string[] {
  const lines: string[] = [];
  const startMs = Number.isFinite(input.startedAtMs) ? input.startedAtMs : 0;
  const reportMs = Number.isFinite(input.nowMs) ? input.nowMs : startMs;
  lines.push('## 7. 经验教训与后续改进 (Lessons Learned & Action Items)');
  lines.push('');
  lines.push(
    `以下改进项依据本次会话的真实卡片与 clusterContext 数值生成（会话跨度 ${formatDuration(
      Math.max(0, reportMs - startMs),
    )}，推理步骤累计耗时 ${formatLatency(
      model.totalReasoningLatencyMs,
    )}）；每条都给出可验收的动作或阈值，不使用「加强监控」这类无法验收的表述。`,
  );
  lines.push('');
  lines.push(...buildLessonItems(input, model));
  return lines;
}

/**
 * buildDisclaimerSection —— 第 8 章：免责与数据边界声明。
 *
 * @returns Markdown 行数组
 */
function buildDisclaimerSection(): string[] {
  return [
    '## 8. 免责与数据边界声明',
    '',
    '- 本报告由 KubeVision AI 在浏览器端侧生成，生成过程未发起任何外部网络请求，报告正文不含任何凭据明文。',
    '- 所有 Pod 名称、命名空间、状态、水位、重启次数、节点水位、健康分与 QPS 均来自端侧实时集群快照与会话上下文；卡片文本（根因摘要、证据链、影响范围、参数说明）由模型生成，并已逐卡标注「模型原生调用」或「服务端补全」。',
    '- 所有敏感信息已由端侧脱敏链路处理：IP、Token、Secret、邮箱等模式在进入推理上下文前即被掩码为 [REDACTED]；原始凭证与原始日志仅留存于本地浏览器，未离开浏览器、未写入本报告。',
    '- 时间线时刻为 reasoningSteps.latencyMs 顺序累加的推算值，用于还原因果顺序，不等同于内核或告警系统的精确时间戳。',
    '- 本报告是复盘证据与改进清单，不构成生产变更指令。任何高危动作（尤其是 drain_node 驱逐节点）必须经过人工二次确认与变更审批流程后方可执行。',
  ];
}

/* ========================================================================== */
/* 对外导出                                                                    */
/* ========================================================================== */

/**
 * buildPostMortemMarkdown —— 把一次 Copilot 会话渲染为 Google SRE 风格的复盘报告。
 *
 * 【设计意图】把「对话流水」升维成「可归档的事故文档」。八个章节严格对齐
 * Google SRE Post-Mortem 的叙事结构：摘要 → 影响 → 时间线 → 根因 → 依据 →
 * 处置 → 改进 → 边界声明，让读者先看清事实、再判断归因、最后落到行动。
 *
 * 【输入】messages（会话消息，含推理链与卡片）、clusterContext（集群态势快照）、
 * startedAtMs（会话起点，用于推算相对时刻）、nowMs（生成时刻，用于报告编号与生成时间）。
 *
 * 【输出】可直接写入 .md 文件的 Markdown 字符串（以换行结尾）。
 *
 * 【数据缺失时的行为】
 * - 无任何卡片 → 仍然输出合法报告，第 1、3 章有内容，第 4、5、6 章明确写「未产出」；
 * - 无根因卡 → 不生成任何根因段落，也不编造 impactScope；
 * - 无 RAG 引用 → 第 5 章明确写「知识库依据缺失」；
 * - 无执行回执 → 所有审批卡标「待审批」。
 *
 * 【纯函数保证】不读取 Date.now()、不访问 DOM、不改写入参（内部数组均为新建）。
 *
 * @param input 见 PostMortemInput
 * @returns Markdown 全文
 */
export function buildPostMortemMarkdown(input: PostMortemInput): string {
  const model = buildSessionModel(input.messages);
  const sections: string[][] = [
    buildHeaderLines(input),
    buildSummarySection(input, model),
    buildImpactSection(input, model),
    buildTimelineSection(model),
    buildIncidentBufferSection(input),
    buildRootCauseSection(model),
    buildKnowledgeSection(model),
    buildRemediationSection(model),
    buildLessonSection(input, model),
    buildDisclaimerSection(),
  ];

  /**
   * 【空行归一化】每个章节构建器都可能在末尾留下一个空行占位（便于单独复用），
   * 拼接时就可能产生连续两行空白。统一压成「章节间恰好一个空行」：
   * Markdown 用一个空行分块即可，多余空行只会让源码变脏、行数虚增。
   */
  const lines: string[] = [];
  for (const section of sections) {
    /* 去掉本节首尾的空行，块内空行原样保留 */
    const trimmed = [...section];
    while (trimmed.length > 0 && trimmed[0] === '') trimmed.shift();
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
    if (trimmed.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(...trimmed);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * buildPostMortemFilename —— 生成归档用的 Markdown 文件名。
 *
 * 【设计意图】导出文件名本身就是元数据：`kubevision-postmortem-20261108-133045.md`
 * 同时表达了「产品归属 + 文档类型 + 生成时刻」，按文件名排序即按时间排序，
 * 批量归档时无需再打开文件确认。时间取调用方的 nowMs 而非内部时钟，
 * 保证同一份会话在同一时刻导出的文件名可复现（可测试）。
 *
 * 【边界处理】nowMs 非法（NaN / Infinity）时回落到 epoch 0，
 * 避免出现 `kubevision-postmortem-NaN-NaN-NaN.md` 这类无法归档的文件名。
 *
 * @param nowMs 生成时刻的毫秒时间戳
 * @returns 形如 `kubevision-postmortem-20261108-133045.md` 的文件名
 */
/**
 * buildPostMortemMarkdownWithLiveTimeline —— 自动附带遥测帧时间线的复盘报告。
 *
 * 【与本文件其余部分的边界】这是**唯一有副作用的入口**：它会读取模块级
 * 环形缓冲（最近 120 帧）。保留纯函数版本给测试与可复现场景使用，
 * 现场导出报告时用这个包装器即可自动附上事故时间线。
 *
 * @param input 复盘输入（无需提供 incidentTimelineMarkdown）
 * @returns Markdown 全文
 */
export function buildPostMortemMarkdownWithLiveTimeline(
  input: Omit<PostMortemInput, 'incidentTimelineMarkdown'>,
): string {
  return buildPostMortemMarkdown({
    ...input,
    incidentTimelineMarkdown: renderIncidentTimelineMarkdown(),
  });
}

export function buildPostMortemFilename(nowMs: number): string {
  const safeMs = Number.isFinite(nowMs) ? nowMs : 0;
  return `kubevision-postmortem-${formatTimestampCompact(safeMs)}.md`;
}
