/**
 * KubeVision AI — MCP 工具执行端点（Model Context Protocol over HTTP）
 *
 * 【这个端点是干什么的】
 * 前端 ActionConfirm 卡片点击「立即执行自愈方案」后，必须先由一个**服务端**
 * 组件受理这次工具调用，返回可核验的执行回执，用户界面才据此宣布"已执行"。
 * 在此之前，执行是一个纯前端动作：点按钮 → 改 store → 3D 变绿。
 * 那套流程在演示上成立，但有一个根本缺陷——**没有任何执行证据**。
 * 用户无法回答"这次操作真的被系统受理了吗？执行 ID 是什么？等价于哪条
 * kubectl 命令？耗时多少？"这些正是生产运维必须留痕的内容。
 *
 * 本端点补上这一环：返回结构化回执（executionId / toolUri / kubectlCommand /
 * latencyMs / auditDigest / timestamp），让自愈从"动画"变成"可审计的事件"。
 *
 * 【双路径执行】
 * 1. 配置了 K8S_API_SERVER + K8S_BEARER_TOKEN → 向真实集群发起 REST 自愈请求：
 *    - restart_pod      → DELETE pod（K8s 会按 Deployment 模板自动重建）
 *    - scale_deployment → PATCH deployment 的 replicas（scale 子资源）
 *    - drain_node       → PATCH node 打上不可调度污点（cordon 语义）
 *                        真正的驱逐（eviction）需要逐 Pod 调用 eviction 子资源，
 *                        这里如实只做 cordon 并声明，不假装驱逐已完成。
 * 2. 未配置 → 模拟标准控制器自愈时序（约 220ms）并返回同样的回执结构。
 *
 * 【为何模拟路径要等 220ms 而不是立即返回】
 * 控制器自愈在真实世界里不是瞬时完成的（API Server 接受 → 控制器观测 →
 * 重建 Pod → 就绪探针通过）。这个延迟让前端的"执行中"动画有真实的时长感，
 * 也让整条链路在有无真实集群时表现一致——否则演示环境的瞬间返回会掩盖
 * 真实环境的等待体验，属于对使用者的欺骗。
 *
 * 【MCP JSON-RPC 2.0 契约】
 * 回执遵循 JSON-RPC 2.0 的响应结构（jsonrpc / id / result），
 * 使该端点可以被真正的 MCP 客户端当作工具服务消费，而不只是内部接口。
 */

import type { NextRequest } from 'next/server';
import type { McpExecuteReceipt as SharedMcpExecuteReceipt } from '@/types/mcp';

/* ---- 必须动态执行：涉及外部集群调用与时间戳，绝不可静态化 ---- */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 模拟自愈耗时（毫秒）：对应真实控制器"受理 → 观测 → 重建"的可见等待 */
const SIMULATED_RECONCILE_MS = 220;

/** 真实 K8s API 请求超时（毫秒）：防止网络挂起拖垮前端请求 */
const K8S_REQUEST_TIMEOUT_MS = 8_000;

/** MCP 工具白名单（与前端 RemediationActionType 严格一致） */
const MCP_TOOL_WHITELIST = ['restart_pod', 'scale_deployment', 'drain_node'] as const;

type McpActionType = (typeof MCP_TOOL_WHITELIST)[number];

/** 执行模式：real 真实集群 / simulated 模拟控制器时序 */
type ExecutionMode = 'real' | 'simulated';

/**
 * McpExecuteRequest —— POST 请求体契约。
 *
 * 【字段可选性说明】targetName 只用于人工可读的回执与日志，
 * 缺失不影响执行；clusterMode 仅作审计记录（标记本次来自 demo 还是 live）。
 * 真正决定行为的只有 actionType 与 targetId。
 */
interface McpExecuteRequest {
  readonly actionType?: unknown;
  readonly targetId?: unknown;
  readonly targetName?: unknown;
  /**
   * 目标命名空间。
   *
   * 【B2 自愈：不得写死 'default'】旧实现把 namespace 硬编码在 REST 路径里，
   * 对 live 集群执行时会去删 default 命名空间的同名 Pod——轻则 404，
   * 重则删错资源。现在由前端传入（来自集群快照里该 Pod 的真实 namespace），
   * 真实集群模式下缺失直接拒绝，绝不猜测。
   */
  readonly namespace?: unknown;
  /** 期望副本数（仅 scale_deployment 使用；回执命令与实际 PATCH 必须一致） */
  readonly replicas?: unknown;
  readonly clusterMode?: unknown;
  /** R10-D：客户端幂等查询键（前端超时后通过 GET 只读对账，绝不重复触发写操作） */
  readonly clientRequestId?: unknown;
  /** M01：显式二次确认开关（可选） */
  readonly requireConfirmation?: unknown;
  /** M01：二次确认凭据，绑定 actionType / targetId / issuedAt / highRiskAcknowledged */
  readonly confirmation?: unknown;
}

/** R10-D：近期执行回执内存账本上限（FIFO 淘汰，防止长期运行内存增长） */
const EXECUTION_LEDGER_MAX_ENTRIES = 128;

/** M01：确认凭据有效期（5 分钟）与最大时钟超前容差（60 秒） */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const CONFIRMATION_CLOCK_SKEW_MS = 60 * 1000;

interface ExecutionLedgerRecord {
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly updatedAt: number;
  readonly payloadFingerprint?: string;
  readonly receipt?: SharedMcpExecuteReceipt;
  readonly errorMessage?: string;
  readonly httpStatus?: number | null;
}

/**
 * authorizeMcpRequest —— 可选管理令牌与同源校验（M01）。
 *
 * 【设计意图】
 * 1. 若配置 `MCP_ADMIN_TOKEN`，要求请求头携带匹配的 `x-mcp-admin-token` 或 Bearer Token；
 * 2. 若请求包含 Origin 与 Host 头，拒绝跨站恶意站点发起的非同源写请求。
 */
function authorizeMcpRequest(request: NextRequest): string | null {
  const configuredToken = process.env.MCP_ADMIN_TOKEN?.trim() ?? '';
  if (configuredToken.length > 0) {
    const headerToken = request.headers.get('x-mcp-admin-token')?.trim() ?? '';
    const authHeader = request.headers.get('authorization')?.trim() ?? '';
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    if (headerToken !== configuredToken && bearerToken !== configuredToken) {
      return 'MCP 执行端点已启用令牌保护：缺少有效 x-mcp-admin-token 或 Authorization Bearer 凭据';
    }
  }

  const originHeader = request.headers.get('origin')?.trim() ?? '';
  const hostHeader = request.headers.get('host')?.trim() ?? '';
  if (originHeader.length > 0 && hostHeader.length > 0) {
    try {
      const originHost = new URL(originHeader).host.toLowerCase();
      if (originHost !== hostHeader.toLowerCase()) {
        return `禁止跨域发起 MCP 变更请求（origin=${originHost}, host=${hostHeader}）`;
      }
    } catch {
      return '请求包含非法的 Origin 头，已拒绝执行';
    }
  }

  return null;
}

/**
 * validateConfirmationPayload —— 校验二次确认凭据是否与本次变更目标严格绑定（M01）。
 */
function validateConfirmationPayload(
  confirmation: unknown,
  actionType: McpActionType,
  targetId: string,
): string | null {
  if (typeof confirmation !== 'object' || confirmation === null || Array.isArray(confirmation)) {
    return '缺少合法的二次确认凭据 confirmation 对象';
  }
  const rec = confirmation as {
    readonly confirmed?: unknown;
    readonly targetId?: unknown;
    readonly actionType?: unknown;
    readonly issuedAt?: unknown;
    readonly highRiskAcknowledged?: unknown;
  };
  if (rec.confirmed !== true) {
    return 'confirmation.confirmed 必须为 true';
  }
  if (typeof rec.targetId !== 'string' || rec.targetId.trim() !== targetId) {
    return 'confirmation.targetId 与当前变更目标不一致，已拒绝执行';
  }
  if (rec.actionType !== actionType) {
    return 'confirmation.actionType 与当前动作不一致，已拒绝执行';
  }
  if (typeof rec.issuedAt !== 'string') {
    return 'confirmation.issuedAt 必须为 ISO 时间戳字符串';
  }
  const issuedMs = Date.parse(rec.issuedAt);
  if (!Number.isFinite(issuedMs)) {
    return 'confirmation.issuedAt 时间戳格式非法';
  }
  const ageMs = Date.now() - issuedMs;
  if (ageMs > CONFIRMATION_TTL_MS || ageMs < -CONFIRMATION_CLOCK_SKEW_MS) {
    return '二次确认凭据已过期或时间偏移超限，请在前端卡片重新确认';
  }
  if (actionType === 'drain_node' && rec.highRiskAcknowledged !== true) {
    return '高危动作 drain_node（节点 Cordon 隔离）必须勾选确认 highRiskAcknowledged=true';
  }
  return null;
}

const executionLedger = new Map<string, ExecutionLedgerRecord>();

/**
 * recordExecutionStatus —— 登记 MCP 执行状态到有界内存账本。
 *
 * 【设计意图】前端 ActionConfirm 在 12s 超时后会切换为不确定态并提供「重新查询」，
 * 通过 clientRequestId / traceId 只读回查服务端是否已落盘回执，避免盲目二次执行造成重复变更。
 */
function recordExecutionStatus(
  keys: readonly (string | undefined)[],
  record: ExecutionLedgerRecord,
): void {
  for (const key of keys) {
    if (key === undefined || key.trim().length === 0) continue;
    const normalized = key.trim();
    if (executionLedger.has(normalized)) {
      executionLedger.delete(normalized);
    } else if (executionLedger.size >= EXECUTION_LEDGER_MAX_ENTRIES) {
      const oldestKey = executionLedger.keys().next().value;
      if (oldestKey !== undefined) executionLedger.delete(oldestKey);
    }
    executionLedger.set(normalized, record);
  }
}


/** JSON-RPC 2.0 成功响应包 */
interface JsonRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly result: SharedMcpExecuteReceipt;
}

/** JSON-RPC 2.0 错误响应包 */
interface JsonRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly error: {
    readonly code: number;
    readonly message: string;
    /**
     * 附加数据。字符串用于自由说明；对象用于结构化标注（如 httpStatus）——
     * B2 要求上游非 2xx 时必须把 HTTP 状态码带进 JSON-RPC error。
     */
    readonly data?: unknown;
  };
}

/** JSON-RPC 标准错误码 */
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

/**
 * compactId —— 生成紧凑的执行 ID（便于在终端/日志中一眼读完）。
 *
 * 【为何不用 crypto.randomUUID】UUID 是 36 字符带连字符的长串，
 * 在窄终端里会被换行截断，反而难以核对。这里用时间戳基 36 + 随机尾缀，
 * 长度约 14 字符，且前缀天然携带时间序，排序即时间序。
 *
 * @returns 形如 `mcp-m3k9x2-a7f1` 的执行 ID
 */
function compactId(): string {
  const timePart = Date.now().toString(36);
  /* 随机部分仅用于同毫秒内的区分，不承担安全职责（不用于令牌/密钥） */
  const randPart = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `mcp-${timePart}-${randPart}`;
}

/**
 * buildKubectlCommand —— 生成动作对应的标准 kubectl 等价命令。
 *
 * 【价值】这是回执里信息密度最高的一项：它把「我们做了什么」翻译成
 * 运维人员可以直接理解、复制、复核的形式。也正因如此，
 * drain_node 必须如实写成 cordon 而非 drain —— 见下方注释。
 *
 * @param actionType 白名单动作
 * @param targetName 目标实体展示名
 * @returns 单行 kubectl 命令
 */
function buildKubectlCommand(
  actionType: McpActionType,
  targetName: string,
  namespace = 'default',
  replicas = 2,
): string {
  /*
   * 【B2 自愈：回执命令必须与实际执行一致】
   *
   * 旧实现的 restart_pod 实际发的是 `DELETE /api/v1/namespaces/default/pods/{name}`，
   * 回执却写 `kubectl rollout restart deployment/{name}`——前者只重启单个 Pod，
   * 后者滚动重启整个 Deployment，影响面完全不同。运维照回执复核会得出错误结论。
   *
   * 现在：
   * - restart_pod  → kubectl delete pod（与 DELETE 资源逐字对应）；
   * - scale        → --replicas 使用实际 PATCH 的值（不再是含糊的 +1）；
   * - drain_node   → cordon（本端点确实只做 cordon）。
   */
  if (actionType === 'restart_pod') {
    return `kubectl delete pod/${targetName} -n ${namespace} --wait=false`;
  }
  if (actionType === 'scale_deployment') {
    return `kubectl scale deployment/${targetName} -n ${namespace} --replicas=${replicas}`;
  }
  if (actionType === 'drain_node') {
    /**
     * 【诚实性关键点】本端点对 drain_node 实际只执行了 cordon（打不可调度污点），
     * 没有逐 Pod 调用 eviction 子资源。若这里写成 `kubectl drain --ignore-daemonsets`，
     * 就会让用户以为工作负载已被驱逐——那是**对执行结果的不实陈述**。
     * 写 cordon 才是与实际行为一致的描述。
     */
    return `kubectl cordon ${targetName}`;
  }
  return `kubectl rollout restart deployment/${targetName}`;
}

/**
 * sha256Hex —— 计算审计摘要（Web Crypto，Node 18+ 原生可用）。
 *
 * 【为何要 auditDigest】回执需要一个**可与外部日志对账**的指纹。
 * 把本次操作的关键字段拼起来哈希，任何一方事后都能用同样输入复算出同一摘要，
 * 从而证明"我们看到的是同一次执行"。
 *
 * @param payload 参与摘要的字符串载荷
 * @returns 十六进制摘要前 16 位（足够区分，且便于终端显示）
 */
async function sha256Hex(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte): string => byte.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16);
}

/**
 * K8sHttpError —— 携带上游 HTTP 状态码的执行错误。
 *
 * 【B2 要求】真实集群返回 404/409/403 时，JSON-RPC error 里必须能读到
 * httpStatus，前端与日志才能区分"目标不存在"与"权限不足"。
 * 只抛 message 字符串会把这个信息丢掉。
 */
class K8sHttpError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number, action: string) {
    super(`Kubernetes API ${action} 返回 HTTP ${httpStatus}`);
    this.name = 'K8sHttpError';
    this.httpStatus = httpStatus;
  }
}

/**
 * readEnvClusterConfig —— 读取真实集群凭证。
 *
 * 【每次请求重新读取而非模块级缓存】环境变量可能在进程生命周期内被容器
 * 编排系统更新；缓存会让"改了凭证却不生效"成为难以排查的问题。
 *
 * @returns 配置齐全时返回 server/token，否则 null
 */
function readEnvClusterConfig(): { server: string; token: string } | null {
  const server = process.env.K8S_API_SERVER;
  const token = process.env.K8S_BEARER_TOKEN;
  if (server === undefined || server.trim().length === 0) return null;
  if (token === undefined || token.trim().length === 0) return null;
  return { server: server.replace(/\/+$/, ''), token: token.trim() };
}

/**
 * callK8sApi —— 向真实 Kubernetes API 发起一次 REST 请求。
 *
 * 【为何统一走这个薄封装】三条动作路径的鉴权头、超时、错误归一化完全一致，
 * 分散在三个分支里会导致"某条路径忘了带 token"这类低级但致命的错误。
 *
 * @param server API Server 基址（无尾斜杠）
 * @param token Bearer Token
 * @param path REST 路径（以 / 开头）
 * @param method HTTP 方法
 * @param body 可选 JSON 载荷
 * @returns HTTP 状态码与响应文本
 */
async function callK8sApi(
  server: string,
  token: string,
  path: string,
  method: 'DELETE' | 'PATCH' | 'GET',
  body?: string,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout((): void => controller.abort(), K8S_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${server}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/merge-patch+json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
      cache: 'no-store',
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Kubernetes API 请求超时（超过 ${K8S_REQUEST_TIMEOUT_MS}ms 未响应）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * canonicalizeTargetName —— 从实体 ID 反推可用于 kubectl 的名字。
 *
 * 【为什么需要】前端传来的 targetId 形如 `pod-payment-gateway-7f8b9-x2k`，
 * 那是**系统内部的实体 ID**；而 kubectl 需要的是 K8s metadata.name
 * （`payment-gateway-7f8b9-x2k`）。直接把内部 ID 拼进命令会得到一条
 * 在任何集群上都跑不通的假命令。
 *
 * 这里剥掉 `pod-` / `node-` 前缀作为近似；targetName 若已提供则优先用它。
 *
 * @param targetId 内部实体 ID
 * @param targetName 前端已知的展示名（可能为空）
 * @returns 适合拼入 kubectl 的名字
 */
function canonicalizeTargetName(targetId: string, targetName: string): string {
  if (targetName.trim().length > 0) return targetName.trim();
  if (targetId.startsWith('pod-')) return targetId.slice(4);
  if (targetId.startsWith('node-')) return targetId.slice(5);
  return targetId;
}

/**
 * executeAgainstRealCluster —— 对真实集群执行自愈请求。
 *
 * 【drain_node 的真实边界】只做 cordon（打不可调度污点），不做 eviction。
 * 完整 drain 需要对节点上每个 Pod 逐个调用 /eviction 子资源，且需处理
 * DaemonSet、本地存储、PDB 等一系列边界，属于远超本端点的职责范围。
 * 如实做一半 + 在回执里说明，比假装做完要负责得多。
 *
 * @returns 执行结果描述；失败时抛出带信息的 Error
 */
async function executeAgainstRealCluster(
  config: { server: string; token: string },
  actionType: McpActionType,
  targetId: string,
  targetName: string,
  namespace: string,
  replicas: number,
): Promise<string> {
  if (actionType === 'restart_pod') {
    /**
     * restart_pod 用 DELETE pod 实现：K8s 的 Deployment/StatefulSet 控制器
     * 观测到副本缺失会自动重建。这比 `kubectl rollout restart`（改 PodTemplate
     * 触发滚动）粒度更窄——前者只重启这一个实例，后者重启整个 Deployment。
     * 我们的动作语义明确是"重启这个 Pod"，因此选 DELETE。
     */
    const { status } = await callK8sApi(
      config.server,
      config.token,
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(targetName)}`,
      'DELETE',
    );
    /*
     * 【B2 自愈：404 / 409 不得当成功】
     *
     * 旧实现把 404 解释成"Pod 已不存在，等价于已重启"并返回成功。
     * 但 404 也可能意味着 namespace/名字拼错、RBAC 过滤后不可见、
     * 或目标根本不是 Pod——把它当成功会让用户以为动作生效了。
     * 409 同理（冲突/禁止删除）必须如实上报。
     * 只有 2xx 才是"API Server 已受理"。
     */
    if (status >= 200 && status < 300) return 'API Server 已受理 Pod 删除请求';
    throw new K8sHttpError(status, `删除 Pod ${targetName}（namespace=${namespace}）`);
  }

  if (actionType === 'scale_deployment') {
    /* 回执里的 --replicas 必须与实际 PATCH 的 spec.replicas 同值 */
    const patch = JSON.stringify({ spec: { replicas } });
    const { status } = await callK8sApi(
      config.server,
      config.token,
      `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(targetName)}/scale`,
      'PATCH',
      patch,
    );
    if (status >= 200 && status < 300) return `已通过 PATCH 调整 Deployment 副本数为 replicas=${replicas}`;
    throw new K8sHttpError(status, `扩缩容 Deployment ${targetName}（namespace=${namespace}）`);
  }

  /**
   * drain_node → cordon：给节点打 spec.unschedulable = true。
   * 这是 K8s 中"不再往此节点调度新 Pod"的标准表达，也是 drain 的第一步。
   */
  const patch = JSON.stringify({ spec: { unschedulable: true } });
  const { status } = await callK8sApi(
    config.server,
    config.token,
    `/api/v1/nodes/${encodeURIComponent(targetId.startsWith('node-') ? targetId.slice(5) : targetId)}`,
    'PATCH',
    patch,
  );
  if (status >= 200 && status < 300) return '节点已设置为不可调度（Cordon，未驱逐存量 Pod）';
  throw new K8sHttpError(status, `隔离节点 ${targetId}（Cordon）`);
}

/**
 * POST —— MCP 工具执行入口。
 *
 * @param request NextRequest；body 为 McpExecuteRequest
 * @returns JSON-RPC 2.0 响应（成功 200 / 参数错误 400 / 内部错误 500）
 */
export async function POST(request: NextRequest): Promise<Response> {
  const startedAt = Date.now();
  const rpcId = compactId();

  /* ---- 0. 令牌与同源安全门禁 ---- */
  const authError = authorizeMcpRequest(request);
  if (authError !== null) {
    const failure: JsonRpcFailure = {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: RPC_INVALID_PARAMS, message: authError },
    };
    return Response.json(failure, { status: 403 });
  }

  /* ---- 1. 解析并校验请求体 ---- */
  let body: McpExecuteRequest;
  /* R43：调用方 traceId（可选，不参与 sha256 摘要）；函数级作用域，回执组装时可用 */
  let traceId: string | undefined;
  let clientRequestId: string | undefined;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('请求体不是合法对象');
    }
    const record: McpExecuteRequest & { readonly traceId?: unknown } = parsed;
    traceId = typeof record.traceId === 'string' && record.traceId.trim().length > 0 ? record.traceId.trim() : undefined;
    clientRequestId =
      typeof record.clientRequestId === 'string' && record.clientRequestId.trim().length > 0
        ? record.clientRequestId.trim()
        : undefined;
    body = record;
  } catch {
    const failure: JsonRpcFailure = {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: RPC_INVALID_PARAMS, message: '请求体必须为合法的 JSON 对象' },
    };
    return Response.json(failure, { status: 400 });
  }

  /**
   * 【参数校验】actionType 必须命中白名单，targetId 必须是非空字符串。
   * 这里刻意**不做任何默认值兜底**——与 chat 路由的卡片补全策略相反：
   * 卡片可以补全（缺一张卡只是界面不完整），但**执行动作绝不能猜**。
   * 猜错一个动作类型意味着对错误的资源做了破坏性操作。
   */
  const rawAction = body.actionType;
  const actionType =
    typeof rawAction === 'string'
      ? MCP_TOOL_WHITELIST.find((candidate): boolean => candidate === rawAction)
      : undefined;

  if (actionType === undefined) {
    const message = `actionType 必须为白名单动作之一：${MCP_TOOL_WHITELIST.join(', ')}`;
    recordExecutionStatus([clientRequestId, traceId], {
      status: 'failed',
      updatedAt: Date.now(),
      errorMessage: message,
      httpStatus: 400,
    });
    const failure: JsonRpcFailure = {
      jsonrpc: '2.0',
      id: rpcId,
      error: {
        code: RPC_INVALID_PARAMS,
        message,
        data: typeof rawAction === 'string' ? `实际收到：${rawAction}` : '实际收到非字符串参数',
      },
    };
    return Response.json(failure, { status: 400 });
  }

  const rawTargetId = body.targetId;
  if (typeof rawTargetId !== 'string' || rawTargetId.trim().length === 0) {
    const message = 'targetId 必须为非空字符串';
    recordExecutionStatus([clientRequestId, traceId], {
      status: 'failed',
      updatedAt: Date.now(),
      errorMessage: message,
      httpStatus: 400,
    });
    const failure: JsonRpcFailure = {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: RPC_INVALID_PARAMS, message },
    };
    return Response.json(failure, { status: 400 });
  }

  const targetId = rawTargetId.trim();
  const targetName =
    typeof body.targetName === 'string' && body.targetName.trim().length > 0
      ? body.targetName.trim()
      : canonicalizeTargetName(targetId, '');
  const clusterMode = body.clusterMode === 'live' ? 'live' : 'demo';

  /*
   * 【B2：namespace 从请求/实体取，不写死】
   * - live 模式：必须由前端传入（来自集群快照中该 Pod 的真实 namespace），
   *   缺失直接 400 拒绝——宁可失败，也不能去 default 里删一个同名 Pod；
   * - simulated 模式：允许缺省为 'default'，但回执 note 里如实标注这是假设值。
   */
  const requestedNamespace =
    typeof body.namespace === 'string' && body.namespace.trim().length > 0
      ? body.namespace.trim()
      : null;
  const namespace =
    requestedNamespace !== null ? requestedNamespace : clusterMode === 'live' ? null : 'default';

  /* replicas：仅 scale 使用；M17 严格整数范围 [1, 50] 校验，拒绝静默回退默认值 */
  let replicas = 2;
  if (actionType === 'scale_deployment' && body.replicas !== undefined) {
    if (
      typeof body.replicas !== 'number' ||
      !Number.isInteger(body.replicas) ||
      body.replicas < 1 ||
      body.replicas > 50
    ) {
      const message = 'scale_deployment 的 replicas 必须为 1 到 50 之间的整数（禁止缩容至 0 或超出上限）';
      recordExecutionStatus([clientRequestId, traceId], {
        status: 'failed',
        updatedAt: Date.now(),
        errorMessage: message,
        httpStatus: 400,
      });
      const failure: JsonRpcFailure = {
        jsonrpc: '2.0',
        id: rpcId,
        error: {
          code: RPC_INVALID_PARAMS,
          message,
          data: { detail: `收到非法 replicas=${String(body.replicas)}` },
        },
      };
      return Response.json(failure, { status: 400 });
    }
    replicas = body.replicas;
  }

  /* ---- 1.5 二次确认凭据校验（live 模式、显式 requireConfirmation 或携带 confirmation 时强制执行） ---- */
  const shouldVerifyConfirmation =
    clusterMode === 'live' ||
    body.requireConfirmation === true ||
    body.confirmation !== undefined;
  if (shouldVerifyConfirmation) {
    const confirmError = validateConfirmationPayload(body.confirmation, actionType, targetId);
    if (confirmError !== null) {
      recordExecutionStatus([clientRequestId, traceId], {
        status: 'failed',
        updatedAt: Date.now(),
        errorMessage: confirmError,
        httpStatus: 403,
      });
      const failure: JsonRpcFailure = {
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: RPC_INVALID_PARAMS, message: `二次确认校验未通过：${confirmError}` },
      };
      return Response.json(failure, { status: 403 });
    }
  }

  /* ---- 2. 执行（live 实写隔离总开关 + 幂等指纹校验） ---- */
  const config = readEnvClusterConfig();
  const realWriteAllowed = process.env.K8S_ALLOW_REAL_WRITE === 'true';

  if (clusterMode === 'live' && (!realWriteAllowed || config === null)) {
    const message =
      config === null
        ? 'live 真实集群模式未配置 K8S_API_SERVER / K8S_BEARER_TOKEN，拒绝退回模拟执行'
        : '真实集群写操作保护已启用：请显式配置 K8S_ALLOW_REAL_WRITE=true 后再执行 live 变更';
    recordExecutionStatus([clientRequestId, traceId], {
      status: 'failed',
      updatedAt: Date.now(),
      errorMessage: message,
      httpStatus: 403,
    });
    const failure: JsonRpcFailure = {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: RPC_INVALID_PARAMS, message },
    };
    return Response.json(failure, { status: 403 });
  }

  if (clusterMode === 'live' && config !== null && actionType === 'restart_pod' && namespace === null) {
    const message = '真实集群模式下必须提供 namespace 参数';
    recordExecutionStatus([clientRequestId, traceId], {
      status: 'failed',
      updatedAt: Date.now(),
      errorMessage: message,
      httpStatus: 400,
    });
    const failure: JsonRpcFailure = {
      jsonrpc: '2.0',
      id: rpcId,
      error: {
        code: RPC_INVALID_PARAMS,
        message,
        data: { detail: '请求缺少 namespace，拒绝默认使用 "default"', httpStatus: null },
      },
    };
    return Response.json(failure, { status: 400 });
  }

  const effectiveNamespace = namespace ?? 'default';
  const payloadFingerprint = `${actionType}:${targetId}:${effectiveNamespace}:${
    actionType === 'scale_deployment' ? String(replicas) : ''
  }:${clusterMode}`;

  if (clientRequestId !== undefined) {
    const existing = executionLedger.get(clientRequestId);
    if (existing !== undefined) {
      if (existing.payloadFingerprint !== undefined && existing.payloadFingerprint !== payloadFingerprint) {
        const message = '同一 clientRequestId 不可篡改变更目标、动作或参数指纹';
        const failure: JsonRpcFailure = {
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: RPC_INVALID_PARAMS, message },
        };
        return Response.json(failure, { status: 409 });
      }
      if (existing.status === 'pending') {
        const failure: JsonRpcFailure = {
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: RPC_INVALID_PARAMS, message: '相同 clientRequestId 正在执行中，请勿重复提交' },
        };
        return Response.json(failure, { status: 409 });
      }
      if (existing.status === 'succeeded' && existing.receipt !== undefined) {
        const idempotentSuccess: JsonRpcSuccess = {
          jsonrpc: '2.0',
          id: rpcId,
          result: existing.receipt,
        };
        return Response.json(idempotentSuccess, { status: 200 });
      }
    }
  }

  recordExecutionStatus([clientRequestId, traceId], {
    status: 'pending',
    updatedAt: Date.now(),
    payloadFingerprint,
  });

  let mode: ExecutionMode = 'simulated';
  let note: string;

  if (clusterMode === 'live' && realWriteAllowed && config !== null) {
    mode = 'real';
    try {
      const detail = await executeAgainstRealCluster(
        config,
        actionType,
        targetId,
        targetName,
        effectiveNamespace,
        replicas,
      );
      note = `Kubernetes API Server 已受理变更请求（accepted）：${detail}`;
    } catch (error) {
      /**
       * 【真实集群失败时绝不伪装成功】这是本端点最重要的一条纪律。
       * 如果集群拒绝了请求（权限不足 / 资源不存在 / 网络不通），
       * 必须如实返回错误，让前端显示失败——而不是退化成"模拟成功"。
       * 后者会让用户在真实生产环境里以为自愈生效了，是最危险的假象。
       */
      const message = error instanceof Error ? error.message : String(error);
      const httpStatus = error instanceof K8sHttpError ? error.httpStatus : null;
      recordExecutionStatus([clientRequestId, traceId], {
        status: 'failed',
        updatedAt: Date.now(),
        payloadFingerprint,
        errorMessage: `Kubernetes API 执行失败：${message.slice(0, 240)}`,
        httpStatus,
      });
      /*
       * 【B2：非 2xx 一律 JSON-RPC error(-32603)，并标注 httpStatus】
       * 上游 4xx 时响应码用 502（网关/上游错误），上游 5xx 用 500；
       * 但无论哪种，error.data 里都带 httpStatus，前端可据此显示"目标不存在"。
       */
      const failure: JsonRpcFailure = {
        jsonrpc: '2.0',
        id: rpcId,
        error: {
          code: RPC_INTERNAL_ERROR,
          message: 'Kubernetes API 执行失败',
          data: { detail: message.slice(0, 300), httpStatus },
        },
      };
      return Response.json(failure, {
        status: httpStatus !== null && httpStatus >= 400 && httpStatus < 500 ? 502 : 500,
      });
    }
  } else {
    /* 模拟标准控制器自愈时序：让有无真实集群时的体验一致 */
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, SIMULATED_RECONCILE_MS);
    });
    note =
      actionType === 'drain_node'
        ? '仿真控制器已核验 Cordon 隔离调度状态（verified：spec.unschedulable=true，未驱逐存量 Pod）'
        : '仿真控制器自愈态已核验（verified）';
  }

  /* ---- 3. 组装回执 ---- */
  const latencyMs = Date.now() - startedAt;
  const timestamp = new Date().toISOString();
  const kubectlCommand = buildKubectlCommand(actionType, targetName, effectiveNamespace, replicas);
  const executionId = compactId();

  /**
   * 审计摘要输入固定为 5 个字段的有序拼接，任一字段变化都会改变摘要。
   * 外部系统只要有同样 5 个值就能复算出同一摘要，用于对账。
   */
  const auditDigest = await sha256Hex(
    `${executionId}|${actionType}|${targetId}|${timestamp}|${kubectlCommand}`,
  );

  const executionStage = mode === 'real' ? ('accepted' as const) : ('verified' as const);

  const receipt: SharedMcpExecuteReceipt = {
    executionId,
    timestamp,
    toolUri: `mcp://k8s-cluster/tools/${actionType}`,
    actionType,
    targetId,
    targetName,
    kubectlCommand,
    latencyMs,
    auditDigest,
    ...(traceId === undefined ? {} : { traceId }),
    mode,
    executionStage,
    note: `${note} (clusterMode=${clusterMode}, namespace=${effectiveNamespace}${
      requestedNamespace === null ? ' [模拟模式默认推测]' : ''
    })`,
  };

  recordExecutionStatus([clientRequestId, traceId, executionId], {
    status: 'succeeded',
    updatedAt: Date.now(),
    payloadFingerprint,
    receipt,
  });

  const success: JsonRpcSuccess = { jsonrpc: '2.0', id: rpcId, result: receipt };
  return Response.json(success, { status: 200 });
}

/**
 * GET —— 能力发现与只读状态查询端点（MCP tools/list + R10-D 超时后结果回查）。
 *
 * 【为何复用 GET】无查询参数时保持既有 tools/list 语义完全不变；
 * 当传入 `?clientRequestId=...` / `?traceId=...` / `?executionId=...` 时，
 * 只读返回内存账本里的最近执行状态（pending/succeeded/failed/unknown），
 * 让前端在 12s 超时后点击「重新查询」可核对回执而不重复写集群。
 *
 * @param request Request 对象（支持 ?clientRequestId / ?traceId / ?executionId 只读状态回查）
 * @returns 工具清单或指定执行的只读状态
 */
export function GET(request: Request): Response {
  const url = new URL(request.url, 'http://localhost');
  const lookupKey =
    url.searchParams.get('clientRequestId')?.trim() ??
    url.searchParams.get('traceId')?.trim() ??
    url.searchParams.get('executionId')?.trim() ??
    '';
  if (lookupKey.length > 0) {
    const entry = executionLedger.get(lookupKey);
    if (entry === undefined) {
      return Response.json({
        jsonrpc: '2.0',
        result: { found: false, status: 'unknown' as const },
      });
    }
    return Response.json({
      jsonrpc: '2.0',
      result: {
        found: true,
        status: entry.status,
        updatedAt: entry.updatedAt,
        ...(entry.receipt === undefined ? {} : { receipt: entry.receipt }),
        ...(entry.errorMessage === undefined ? {} : { errorMessage: entry.errorMessage }),
        ...(entry.httpStatus === undefined ? {} : { httpStatus: entry.httpStatus }),
      },
    });
  }

  const tools = MCP_TOOL_WHITELIST.map((name): { name: string; uri: string; command: string } => ({
    name,
    uri: `mcp://k8s-cluster/tools/${name}`,
    command: buildKubectlCommand(name, '<target>', '<namespace>'),
  }));

  return Response.json({
    jsonrpc: '2.0',
    result: {
      protocolVersion: '2.0',
      server: 'kubevision-mcp-executor',
      simulatedReconcileMs: SIMULATED_RECONCILE_MS,
      realClusterConfigured: readEnvClusterConfig() !== null,
      tools,
    },
  });
}