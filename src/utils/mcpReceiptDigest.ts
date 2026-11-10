/**
 * KubeVision AI — MCP 回执摘要复算（mcpReceiptDigest）
 *
 * 【为什么需要独立模块】
 * 服务端用 `sha256(executionId|actionType|targetId|timestamp|kubectlCommand)` 前 16 位
 * 作为 auditDigest，用于和外部日志对账。客户端要展示"校验回执"按钮，就必须
 * **复算同一个公式**——如果前端另写一份，任何字段顺序/分隔符不一致都会让
 * "校验失败"变成误报，反而损害可信度。
 *
 * 因此把公式收敛到本模块：
 * - 服务端（route.ts）与客户端（ActionConfirm）都引用它；
 * - 单元测试可以对"篡改任一字段必然不匹配"做确定性断言。
 *
 * 【为何是纯函数 + async】Web Crypto 的 digest 是异步 API；
 * 但载荷构造（payload）保持纯同步，便于单测与日志打印。
 */

import type { McpExecuteReceipt } from '@/types/mcp';

/**
 * buildReceiptDigestPayload —— 构造参与摘要的规范化载荷。
 *
 * 【字段顺序锁定】顺序即协议。任何调整都会让历史回执全部校验失败，
 * 属于破坏性变更，必须同步升级版本号。
 *
 * @param receipt 回执（至少包含 5 个参与字段）
 * @returns 以 '|' 连接的规范化字符串
 */
export function buildReceiptDigestPayload(
  receipt: Pick<
    McpExecuteReceipt,
    'executionId' | 'actionType' | 'targetId' | 'timestamp' | 'kubectlCommand'
  >,
): string {
  return [
    receipt.executionId,
    receipt.actionType,
    receipt.targetId,
    receipt.timestamp,
    receipt.kubectlCommand,
  ].join('|');
}

/**
 * computeReceiptDigest —— 用 Web Crypto 计算摘要前 16 位。
 *
 * @param payload 规范化载荷
 * @returns 16 位十六进制摘要
 */
export async function computeReceiptDigest(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte): string => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * verifyReceiptDigest —— 校验回执摘要是否与字段一致。
 *
 * 【用途】"校验回执"按钮的核心逻辑；任何字段被篡改（哪怕是 targetId 一个字符），
 * 复算结果都会不同，从而把"回执被改过"这件事变成可见的红色失败态。
 *
 * @param receipt 完整回执
 * @returns ok 表示一致；expected/actual 用于 UI 展示差异
 */
export async function verifyReceiptDigest(
  receipt: Pick<
    McpExecuteReceipt,
    'executionId' | 'actionType' | 'targetId' | 'timestamp' | 'kubectlCommand' | 'auditDigest'
  >,
): Promise<{ readonly ok: boolean; readonly expected: string; readonly actual: string }> {
  const expected = await computeReceiptDigest(buildReceiptDigestPayload(receipt));
  return { ok: expected === receipt.auditDigest, expected, actual: receipt.auditDigest };
}