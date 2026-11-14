/**
 * KubeVision AI — 系统健康度与降级状态只读诊断端点（GET /api/health，R13 进阶）
 *
 * 【设计意图】
 * 1. 只读无鉴权，供运维探针、答辩演示及端到端测试脚本实时检查系统运行状况；
 * 2. 返回当前 AI 引擎模式（llm / simulator）、SSE 活跃连接数与并发上限、累计推流帧数、
 *    最近一次 live 采集耗时、五层全链路降级矩阵摘要与当前激活降级层；
 * 3. 安全硬红线：绝不泄露 OPENAI_API_KEY、K8S_BEARER_TOKEN、K8S_API_SERVER 等任何凭据或私钥。
 */

import packageJson from '../../../../package.json';
import { DEGRADATION_MATRIX } from '@/constants/degradationMatrix';
import type { DegradationTierId, HealthApiResponse } from '@/types/health';
import { getHostSamplerSubscriberCount } from '@/utils/liveTelemetry';
import { getTelemetryHealthMetrics } from '@/utils/telemetryMetrics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 进程启动基准时间戳（用于计算只读运行时长） */
const PROCESS_STARTED_AT_MS = Date.now();

/**
 * GET —— 返回严格强类型的 `/api/health` 运行态诊断快照（零敏感字段）。
 */
export function GET(): Response {
  const apiKey = process.env.OPENAI_API_KEY;
  const llmConfigured = typeof apiKey === 'string' && apiKey.trim().length > 0;
  const modelName =
    typeof process.env.OPENAI_MODEL === 'string' && process.env.OPENAI_MODEL.trim().length > 0
      ? process.env.OPENAI_MODEL.trim()
      : 'glm-4-flash';

  const sseMetrics = getTelemetryHealthMetrics();
  const hostSamplerSubscribers = getHostSamplerSubscriberCount();

  const activeTiers: DegradationTierId[] = [];
  if (!llmConfigured) activeTiers.push('llm-fallback');
  if (sseMetrics.liveConsecutiveFailures > 0 || sseMetrics.degradedToDemoCount > 0) {
    activeTiers.push('sse-synthetic');
  }

  const payload: HealthApiResponse = {
    status: sseMetrics.liveConsecutiveFailures >= 3 ? 'degraded' : 'ok',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.max(0, Math.round((Date.now() - PROCESS_STARTED_AT_MS) / 1000)),
    version: typeof packageJson.version === 'string' ? packageJson.version : '0.1.0',
    engine: {
      mode: llmConfigured ? 'llm' : 'simulator',
      llmConfigured,
      modelName: llmConfigured ? modelName : 'local-deterministic-sre',
      fallbackReady: true,
    },
    sse: {
      activeConnections: sseMetrics.activeConnections,
      maxConnections: sseMetrics.maxConnections,
      maxConnectionLifetimeMs: sseMetrics.maxConnectionLifetimeMs,
      totalFramesSent: sseMetrics.totalFramesSent,
      totalHeartbeatsSent: sseMetrics.totalHeartbeatsSent,
      budgetRejectedCount: sseMetrics.budgetRejectedCount,
      lifetimeClosedCount: sseMetrics.lifetimeClosedCount,
      lastCollectionDurationMs: sseMetrics.lastCollectionDurationMs,
      hostSamplerSubscribers,
      liveConsecutiveFailures: sseMetrics.liveConsecutiveFailures,
    },
    degradation: {
      activeTiers,
      matrixSummary: DEGRADATION_MATRIX.map((item) => ({
        id: item.id,
        tier: item.tier,
        name: item.name,
        triggerCondition: item.triggerCondition,
        userFacingPrompt: item.userFacingPrompt,
        recoveryCondition: item.recoveryCondition,
        forbiddenClaims: item.forbiddenClaims,
      })),
    },
  };

  return Response.json(payload, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store, no-cache',
    },
  });
}
