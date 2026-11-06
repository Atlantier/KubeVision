/**
 * KubeVision AI — RAG 检索校验路由（仅供 scripts/verify.mjs 使用）
 *
 * 【职责】把 sreRagEngine 暴露为可被验收脚本调用的端点，
 * 使回归测试验证**真实检索结果**而非复刻逻辑。
 *
 * 【安全约束】只做纯函数计算，不接触密钥、不写存储、无副作用。
 */

import { retrieveSreRunbooks } from '@/utils/sreRagEngine';
import type { ChaosScenario } from '@/types/cluster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RagRequestBody {
  readonly cases: ReadonlyArray<{
    readonly query: string;
    readonly chaos: string;
  }>;
}

/**
 * POST /api/verify/rag —— 批量验证 RAG 检索。
 *
 * 【请求】{ cases: Array<{ query, chaos }> }
 * 【响应】{ results: Array<{ topId, score, count }> }
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = body as RagRequestBody;
  if (!Array.isArray(parsed?.cases)) {
    return Response.json({ error: 'cases must be an array' }, { status: 400 });
  }

  const results = parsed.cases.map((c) => {
    /* 白名单收敛 chaos，避免非法值污染检索上下文 */
    const chaos: ChaosScenario =
      c.chaos === 'POD_OOM_SWARM' || c.chaos === 'NODE_CPU_SPIKE' || c.chaos === 'NET_PACKET_LOSS'
        ? c.chaos
        : 'NONE';

    const hits = retrieveSreRunbooks(String(c.query), chaos, [], 2);
    const top = hits[0];
    return {
      topId: top?.id ?? null,
      score: top?.similarityScore ?? 0,
      count: hits.length,
    };
  });

  return Response.json({ results });
}
