/**
 * KubeVision AI — MCP 工具执行共享层（R37 · 任务 A）
 *
 * 【职责边界】
 * - 本文件是 JSON-RPC MCP 端点的**纯协议层**：工具清单/输入 Schema、JSON-RPC 错误码、
 *   以及把 tools/call 转发给既有执行端点 `/api/mcp/execute` 的客户端封装。
 * - **执行逻辑仍只有一份**：真实集群调用、kubectl 回执、sha256 审计摘要、白名单
 *   都在 `/api/mcp/execute` 内，本文件不复制任何执行分支（禁止逻辑双写）。
 * - 渲染类工具（renderPodMetrics / renderRootCauseAnalysis / proposeRemediationAction）
 *   **不进 MCP**：它们是前端 GenUI 的 UI 契约，不是可被外部 agent 调用的运维动作。
 *
 * 【为何转发而不是直接 import】执行端点依赖 Next 的 Request/Response 环境与
 * env 读取；用 HTTP 转发保证 MCP 与 legacy 端点行为逐字一致（同一回执、同一 digest），
 * 避免出现"两套执行语义"。
 */

/** MCP 工具白名单（与 /api/mcp/execute 完全一致） */
export const MCP_TOOL_NAMES = ['restart_pod', 'scale_deployment', 'drain_node'] as const;

/** MCP 工具名类型 */
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** tools/list 返回的工具定义 */
export interface McpToolDefinition {
  readonly name: McpToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** 三个执行工具的最小 JSON Schema（手写，不引 schema 库） */
export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'restart_pod',
    description: '删除指定 Pod 触发重建（等价 kubectl delete pod --wait=false）',
    inputSchema: {
      type: 'object',
      properties: {
        targetName: { type: 'string', description: 'Pod 名称' },
        namespace: { type: 'string', description: '命名空间，默认 default' },
        clusterMode: { type: 'string', enum: ['demo', 'live'], description: '审计用的集群模式' },
      },
      required: ['targetName'],
      additionalProperties: false,
    },
  },
  {
    name: 'scale_deployment',
    description: '调整 Deployment 副本数（等价 kubectl scale deployment，允许范围 1-50）',
    inputSchema: {
      type: 'object',
      properties: {
        targetName: { type: 'string', description: 'Deployment 名称' },
        namespace: { type: 'string', description: '命名空间，默认 default' },
        replicas: { type: 'number', minimum: 1, maximum: 50, description: '目标副本数（1-50 的整数）' },
        clusterMode: { type: 'string', enum: ['demo', 'live'] },
      },
      required: ['targetName', 'replicas'],
      additionalProperties: false,
    },
  },
  {
    name: 'drain_node',
    description: '隔离节点调度（等价 kubectl cordon 设置 spec.unschedulable=true，不直接驱逐存量 Pod；高危动作，需二次确认）',
    inputSchema: {
      type: 'object',
      properties: {
        targetName: { type: 'string', description: '节点名称' },
        namespace: { type: 'string', description: '命名空间（审计字段）' },
        clusterMode: { type: 'string', enum: ['demo', 'live'] },
      },
      required: ['targetName'],
      additionalProperties: false,
    },
  },
];

/** JSON-RPC 2.0 标准错误码 */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/**
 * callExecuteEndpoint —— 把 tools/call 转发给既有执行端点（单点执行逻辑）。
 *
 * @param origin 当前请求 origin（http://host:port）
 * @param toolName 工具名
 * @param args 工具参数
 * @returns 执行回执（含 executionId / kubectlCommand / auditDigest / mode 等）
 */
const MCP_EXECUTE_TIMEOUT_MS = 10_000;

/**
 * 调用本地 /api/mcp/execute 端点执行受白名单约束的运维动作。
 *
 * 【超时与中文错误归一化】默认附带 10s AbortController 超时守卫，避免服务端挂起
 * 拖垮 JSON-RPC 调度；统一抛出清晰中文错误，方便上层展示与定位。
 */
export async function callExecuteEndpoint(
  origin: string,
  toolName: McpToolName,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout((): void => controller.abort(), MCP_EXECUTE_TIMEOUT_MS);

  try {
    const response = await fetch(`${origin}/api/mcp/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionType: toolName, ...args, targetId: args.targetId ?? args.targetName }),
      signal: controller.signal,
      cache: 'no-store',
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const errorMessage =
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof payload.error === 'object' &&
        payload.error !== null &&
        'message' in payload.error &&
        typeof payload.error.message === 'string'
          ? payload.error.message
          : JSON.stringify(payload);
      throw new Error(`MCP 执行端点返回异常（HTTP ${response.status}）：${errorMessage}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('调用 MCP 执行端点超时（超过 10s 未响应），请稍后核实集群实际状态');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}