#!/usr/bin/env node
/**
 * KubeVision AI — 生成 runbook 句向量（R39 · 任务 A2）
 *
 * 【开发期一次性脚本】用已安装的 @huggingface/transformers 在 Node 侧编码
 * 12 篇内置手册，产出 `src/utils/runbookEmbeddings.ts`（12×384 float，随包提交）。
 * **运行时不加载模型**：该文件只是预计算矩阵。
 *
 * 【约束】
 * - 不新增依赖：使用项目已锁定的 @huggingface/transformers 3.1.2；
 * - 与 Worker 使用同一 MODEL_ID，保证客户端/服务端向量空间一致；
 * - 本脚本需要模型可用（首次会下载权重），在离线环境会失败——失败时**不要**提交半成品。
 *
 * 用法：node scripts/build-runbook-embeddings.mjs
 * 产物：src/utils/runbookEmbeddings.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* 与服务端 RAG/Worker 共用的模型 id 必须一致；改这里会破坏向量空间 */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
/** 句向量维度 */
const DIMENSION = 384;

/**
 * 读取语料文本字段（title + symptom + tags），与检索时的文档文本口径一致。
 *
 * @param doc 语料文档
 * @returns 用于编码的文本
 */
function documentText(doc) {
  return [doc.title, doc.symptom, (doc.tags ?? []).join(' ')].join('\n');
}

async function main() {
  /* 动态 import：脚本是 .mjs，项目内是 TS；这里直接引 TS 需要 tsx，
     因此复用编译期已生成的语料常量不现实——改为读取 TS 源码不优雅。
     本脚本以"语料通过参数注入"为契约：调用方传入 title/symptom/tags 的 JSON。 */
  const corpusPath = process.argv[2] ?? 'tmp/corpus.json';
  const { readFileSync, existsSync } = await import('node:fs');
  if (!existsSync(corpusPath)) {
    console.error(
      `[FATAL] 缺少语料输入 ${corpusPath}。请先导出 12 篇手册的 {id,title,symptom,tags} JSON：\n` +
        '  node -e "..." 或从 sreRagEngine.SRE_RUNBOOK_CORPUS 导出。\n' +
        '【说明】本脚本不直接 import TS 源码（避免新增 tsx 依赖）。',
    );
    process.exit(2);
  }

  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  if (!Array.isArray(corpus) || corpus.length === 0) {
    console.error('[FATAL] 语料为空');
    process.exit(2);
  }

  const transformers = await import('@huggingface/transformers');
  console.log(`[1/3] 加载模型 ${MODEL_ID} …`);
  const extractor = await transformers.pipeline('feature-extraction', MODEL_ID);

  console.log(`[2/3] 编码 ${corpus.length} 篇手册 …`);
  const rows = [];
  for (const doc of corpus) {
    const output = await extractor(documentText(doc), { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data, (value) => Math.round(value * 1e6) / 1e6);
    if (vector.length !== DIMENSION) {
      console.error(`[FATAL] ${doc.id} 维度 ${vector.length} ≠ ${DIMENSION}`);
      process.exit(1);
    }
    rows.push({ id: doc.id, vector });
  }

  console.log('[3/3] 写出 src/utils/runbookEmbeddings.ts …');
  const body = rows
    .map(
      (row) =>
        `  {\n    id: '${row.id}',\n    vector: [${row.vector.join(', ')}],\n  },`,
    )
    .join('\n');
  const content = `/**
 * KubeVision AI — 预计算 runbook 句向量（R39 · 任务 A2）
 *
 * 由 scripts/build-runbook-embeddings.mjs 生成，**请勿手改**。
 * 模型：${MODEL_ID}（384 维，均值池化 + L2 归一化）。
 * 运行时只读取该矩阵，不加载模型。
 */

/** 一条 runbook 的预计算向量 */
export interface RunbookEmbedding {
  readonly id: string;
  readonly vector: readonly number[];
}

/** 句向量维度（与服务端校验一致） */
export const RUNBOOK_EMBEDDING_DIM = ${DIMENSION};

/** 12 篇内置手册的句向量 */
export const RUNBOOK_EMBEDDINGS: readonly RunbookEmbedding[] = [
${body}
];
`;
  writeFileSync(join(process.cwd(), 'src/utils/runbookEmbeddings.ts'), content, 'utf8');
  console.log(`[完成] 写入 src/utils/runbookEmbeddings.ts（${rows.length} 条）`);
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});