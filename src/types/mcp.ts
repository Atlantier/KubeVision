/**
 * KubeVision AI — MCP 执行契约类型（跨端共享）
 *
 * 【为什么单独建文件】此前 McpExecuteReceipt 在路由与卡片组件里各定义了一份，
 * 字段一旦调整就会出现"服务端返回了新字段、前端类型没跟上"的静默漂移。
 * 回执摘要复算（Q5）要求两端对同一组字段、同一顺序负责，因此必须有唯一类型源。
 */

/** 执行模式：real 真实集群 / simulated 模拟控制器时序 */
export type McpExecutionMode = 'real' | 'simulated';

/** MCP 工具白名单三态 */
export type McpActionType = 'restart_pod' | 'scale_deployment' | 'drain_node';

/**
 * McpExecuteReceipt —— 服务端执行成功回执（JSON-RPC result 载荷）。
 *
 * auditDigest 的参与字段**顺序**写在 mcpReceiptDigest.buildReceiptDigestPayload，
 * 任何改动都属于协议破坏性变更。
 */
export type McpExecutionStage = 'accepted' | 'verified';

export interface McpExecuteReceipt {
  readonly executionId: string;
  readonly timestamp: string;
  readonly toolUri: string;
  readonly actionType: McpActionType;
  readonly targetId: string;
  readonly targetName: string;
  readonly kubectlCommand: string;
  readonly latencyMs: number;
  readonly auditDigest: string;
  readonly mode: McpExecutionMode;
  readonly executionStage?: McpExecutionStage;
  readonly note: string;
}