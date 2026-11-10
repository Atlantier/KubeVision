/**
 * KubeVision AI — 内置语料导出（dev-only，R44 Phase 4）
 *
 * 【用途】`scripts/build-runbook-embeddings.mjs` 需要 12 篇手册的 {id,title,symptom,tags} JSON。
 * .mjs 不能直接 import TS，因此这里用 dev-only 路由把真实语料导出，避免手工复制造成漂移。
 * 生产构建返回 404。
 */

import { NextResponse } from 'next/server';
import { SRE_RUNBOOK_CORPUS } from '@/utils/sreRagEngine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/dev/corpus */
export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'dev only' }, { status: 404 });
  }
  return NextResponse.json(
    SRE_RUNBOOK_CORPUS.map((doc) => ({
      id: doc.id,
      title: doc.title,
      symptom: doc.symptom,
      tags: doc.tags,
    })),
  );
}
