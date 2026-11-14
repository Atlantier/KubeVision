/**
 * KubeVision AI — MCP JSON-RPC 2.0 over HTTP 端点（R37 · 任务 A）
 *
 * 【协议】JSON-RPC 2.0：initialize / tools/list / tools/call / ping。
 * - 严格回显 id（数字/字符串原样）；无 id 的通知返回 202；
 * - 错误码：-32700 解析错误、-32600 无效请求、-32601 方法不存在、
 *   -32602 参数错误、-32603 内部错误；
 * - tools/call 复用 /api/mcp/execute 的唯一执行逻辑（见 mcpExecutor.ts 注释），
 *   返回 { content:[{type:'text', text: JSON.stringify(receipt)}], isError:false }。
 *
 * 【保留 legacy】/api/mcp/execute 继续保留（verify.mjs 有断言），文档标注 legacy。
 */

import {
  callExecuteEndpoint,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  type McpToolName,
} from '@/utils/mcpExecutor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** JSON-RPC 响应形状 */
interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/**
 * rpcResult —— 构造成功响应。
 *
 * @param id 请求 id
 * @param result 结果
 */
function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * rpcError —— 构造错误响应。
 *
 * @param id 请求 id（解析失败时为 null）
 * @param code JSON-RPC 错误码
 * @param message 错误信息
 */
function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * isValidId —— 校验 JSON-RPC id 类型。
 *
 * @param value 任意值
 * @returns string/number/null 时通过
 */
function isValidId(value: unknown): value is string | number | null {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

/** POST /api/mcp —— 单个 JSON-RPC 请求 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, RPC_PARSE_ERROR, 'JSON 解析失败：请求体不是合法的 JSON 格式'), {
      status: 200,
    });
  }

  /* 通知（无 id）：本端点无状态副作用，直接 202 */
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && !('id' in body)) {
    return new Response(null, { status: 202 });
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json(rpcError(null, RPC_INVALID_REQUEST, '无效的 JSON-RPC 请求：请求体必须为 JSON 对象'), {
      status: 200,
    });
  }

  const requestObject = body as Record<string, unknown>;
  const id = requestObject.id;
  if (!isValidId(id)) {
    return Response.json(rpcError(null, RPC_INVALID_REQUEST, '无效的 JSON-RPC 请求：缺少合法的 id 字段'), {
      status: 200,
    });
  }
  if (typeof requestObject.method !== 'string') {
    return Response.json(rpcError(id, RPC_INVALID_REQUEST, '无效的 JSON-RPC 请求：method 必须为字符串'), {
      status: 200,
    });
  }

  const method = requestObject.method;
  const params =
    requestObject.params !== null && typeof requestObject.params === 'object'
      ? (requestObject.params as Record<string, unknown>)
      : {};

  try {
    if (method === 'initialize') {
      return Response.json(
        rpcResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kubevision-mcp', version: '1.0.0' },
        }),
        { status: 200 },
      );
    }

    if (method === 'ping') {
      return Response.json(rpcResult(id, {}), { status: 200 });
    }

    if (method === 'tools/list') {
      return Response.json(rpcResult(id, { tools: MCP_TOOLS }), { status: 200 });
    }

    if (method === 'tools/call') {
      const name = params.name;
      const args = params.arguments;
      if (typeof name !== 'string' || !MCP_TOOL_NAMES.includes(name as McpToolName)) {
        return Response.json(
          rpcError(id, RPC_INVALID_PARAMS, `未知 MCP 工具：${typeof name === 'string' ? name : '非字符串'}`),
          { status: 200 },
        );
      }
      if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
        const origin = new URL(request.url).origin;
        const receipt = await callExecuteEndpoint(origin, name as McpToolName, args as Record<string, unknown>);
        return Response.json(
          rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(receipt) }],
            isError: false,
          }),
          { status: 200 },
        );
      }
      return Response.json(rpcError(id, RPC_INVALID_PARAMS, 'tools/call 的 arguments 参数必须为对象'), {
        status: 200,
      });
    }

    return Response.json(rpcError(id, RPC_METHOD_NOT_FOUND, `未找到 JSON-RPC 方法：${method}`), { status: 200 });
  } catch (error) {
    return Response.json(
      rpcError(id, RPC_INTERNAL_ERROR, error instanceof Error ? error.message : 'MCP 服务内部执行错误'),
      { status: 200 },
    );
  }
}