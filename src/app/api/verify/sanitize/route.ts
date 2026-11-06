/**
 * KubeVision AI — 脱敏器校验路由（仅供 scripts/verify.mjs 使用）
 *
 * 【职责】把 logSanitizer 暴露为可被验收脚本调用的端点，
 * 使回归测试验证**真实模块**而非复制品。
 *
 * 【安全约束】只做纯函数计算，不接触密钥、不写存储、无副作用。
 */

import { getSanitizerRuleNames, sanitizeRawLog } from '@/utils/logSanitizer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SanitizeRequestBody {
  readonly cases: readonly string[];
}

/**
 * POST /api/verify/sanitize —— 批量验证脱敏器。
 *
 * 【请求】{ cases: string[] }
 * 【响应】{ results: Array<{ sanitized, maskedCount }>, rules: string[] }
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = body as SanitizeRequestBody;
  if (!Array.isArray(parsed?.cases)) {
    return Response.json({ error: 'cases must be an array' }, { status: 400 });
  }

  const results = parsed.cases.map((raw) => {
    const { sanitized, maskedCount } = sanitizeRawLog(String(raw));
    return { sanitized, maskedCount };
  });

  return Response.json({ results, rules: getSanitizerRuleNames() });
}
