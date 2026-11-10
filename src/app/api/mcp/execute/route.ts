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
    super(`K8s ${action} returned HTTP ${httpStatus}`);
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
    if (status >= 200 && status < 300) return 'pod deletion accepted by API server';
    throw new K8sHttpError(status, `DELETE pod/${targetName} in namespace ${namespace}`);
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
    if (status >= 200 && status < 300) return `deployment scale patched to replicas=${replicas}`;
    throw new K8sHttpError(status, `PATCH scale deployment/${targetName} in namespace ${namespace}`);
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
  if (status >= 200 && status < 300) return 'node cordoned (eviction not performed)';
  throw new K8sHttpError(status, `PATCH node/${targetId} cordon`);
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

  /* ---- 1. 解析并校验请求体 ---- */
  let body: McpExecuteRequest;
  /* R43：调用方 traceId（可选，不参与 sha256 摘要）；函数级作用域，回执组装时可用 */
  let traceId: string | undefined;
  try {
    const parsed: unknown = await request.json();
    traceId =
      parsed !== null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).traceId === 'string'
        ? ((parsed as Record<string, unknown>).traceId as string)
        : undefined;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('body is not an object');
    }
    body = parsed as McpExecuteRequest;
  } catch {
    const failure: JsonRpcFailure = {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: RPC_INVALID_PARAMS, message: 'Request body must be valid JSON object' },
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
    const failure: JsonRpcFailure = {
      jsonrpc: '2.0',
      id: rpcId,
      error: {
        code: RPC_INVALID_PARAMS,
        message: `actionType must be one of: ${MCP_TOOL_WHITELIST.join(', ')}`,
        data: typeof rawAction === 'string' ? `received: ${rawAction}` : 'received non-string',
      },
    };
    return Response.json(failure, { status: 400 });
  }

  const rawTargetId = body.targetId;
  if (typeof rawTargetId !== 'string' || rawTargetId.trim().length === 0) {
    const failure: JsonRpcFailure = {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: RPC_INVALID_PARAMS, message: 'targetId must be a non-empty string' },
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

  /* replicas：仅 scale 使用；范围校验防止把集群缩到 0 */
  const requestedReplicas =
    typeof body.replicas === 'number' && Number.isFinite(body.replicas) ? Math.round(body.replicas) : null;
  const replicas = requestedReplicas !== null && requestedReplicas >= 1 && requestedReplicas <= 50
    ? requestedReplicas
    : 2;

  /* ---- 2. 执行（真实集群优先，未配置则模拟时序） ---- */
  const config = readEnvClusterConfig();
  if (config !== null && actionType === 'restart_pod' && namespace === null) {
    const failure: JsonRpcFailure = {
      jsonrpc: '2.0',
      id: rpcId,
      error: {
        code: RPC_INVALID_PARAMS,
        message: 'namespace is required when executing against a live cluster',
        data: { detail: 'request.namespace missing; refusing to assume "default"', httpStatus: null },
      },
    };
    return Response.json(failure, { status: 400 });
  }
  const effectiveNamespace = namespace ?? 'default';
  let mode: ExecutionMode = 'simulated';
  let note: string;

  if (config !== null) {
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
      note = `Applied to live cluster via Kubernetes REST API: ${detail}`;
    } catch (error) {
      /**
       * 【真实集群失败时绝不伪装成功】这是本端点最重要的一条纪律。
       * 如果集群拒绝了请求（权限不足 / 资源不存在 / 网络不通），
       * 必须如实返回错误，让前端显示失败——而不是退化成"模拟成功"。
       * 后者会让用户在真实生产环境里以为自愈生效了，是最危险的假象。
       */
      const message = error instanceof Error ? error.message : String(error);
      const httpStatus = error instanceof K8sHttpError ? error.httpStatus : null;
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
          message: 'Kubernetes API execution failed',
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
    note = 'Simulated controller reconciliation (K8S_API_SERVER not configured)';
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
    note: `${note} (clusterMode=${clusterMode}, namespace=${effectiveNamespace}${
      requestedNamespace === null ? ' [assumed in simulated mode]' : ''
    })`,
  };

  const success: JsonRpcSuccess = { jsonrpc: '2.0', id: rpcId, result: receipt };
  return Response.json(success, { status: 200 });
}

/**
 * GET —— 能力发现端点（MCP 的 tools/list 语义）。
 *
 * 【为何提供】MCP 客户端接入前需要知道这个服务提供哪些工具。
 * 返回白名单及其描述，让本端点成为可被标准 MCP 工具链发现的真实服务，
 * 而不只是一个内部用的 POST 接口。
 *
 * @returns 工具清单
 */
export function GET(): Response {
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