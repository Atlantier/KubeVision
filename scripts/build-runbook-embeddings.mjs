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
    const vector = Array.from(output.data, (value) => Math.fround(value));
    if (vector.length !== DIMENSION) {
      console.error(`[FATAL] ${doc.id} 维度 ${vector.length} ≠ ${DIMENSION}`);
      process.exit(1);
    }
    const buffer = Buffer.alloc(DIMENSION * 4);
    for (let i = 0; i < DIMENSION; i += 1) {
      buffer.writeFloatLE(vector[i] ?? 0, i * 4);
    }
    rows.push({ id: doc.id, base64: buffer.toString('base64') });
  }

  console.log('[3/3] 写出 src/utils/runbookEmbeddings.ts …');
  const body = rows
    .map((row) => `  { id: '${row.id}', base64: '${row.base64}' },`)
    .join('\n');
  const content = `/**
 * KubeVision AI — 预计算 runbook 句向量（R44 · Phase 4）
 *
 * 由 scripts/build-runbook-embeddings.mjs 生成，**请勿手改**。
 * 模型：${MODEL_ID}（384 维，均值池化 + L2 归一化）。
 * 存储：Float32 小端 base64（raw 18,432 B），运行时解码，**不加载模型**。
 */

/** 句向量维度（与服务端校验一致） */
export const RUNBOOK_EMBEDDING_DIM = ${DIMENSION};

/** 一条 runbook 的预计算向量（base64 形态，惰性解码） */
interface RunbookEmbeddingRecord {
  readonly id: string;
  readonly base64: string;
}

/** 12 篇内置手册的句向量（base64） */
const RUNBOOK_EMBEDDINGS_BASE64: readonly RunbookEmbeddingRecord[] = [
${body}
];

/**
 * decodeBase64ToFloat32 —— base64 → Float32Array（小端）。
 *
 * 【为什么用 atob】浏览器与 Node 18+ 都内置 atob；服务端/客户端/开发脚本三处通用，
 * 不引入新依赖，也不需要 Buffer 的运行时分支。
 *
 * @param base64 base64 字符串
 * @returns Float32Array（长度 384）
 */
function decodeBase64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** 惰性解码缓存（模块级，只解一次） */
let decodedVectors: ReadonlyArray<{ id: string; vector: Float32Array }> | null = null;

/**
 * getAllRunbookVectors —— 取全部 12 篇预计算向量（惰性解码 + 缓存）。
 *
 * @returns id → Float32Array 的数组
 */
export function getAllRunbookVectors(): ReadonlyArray<{ id: string; vector: Float32Array }> {
  if (decodedVectors === null) {
    decodedVectors = RUNBOOK_EMBEDDINGS_BASE64.map((record) => ({
      id: record.id,
      vector: decodeBase64ToFloat32(record.base64),
    }));
  }
  return decodedVectors;
}

/**
 * getRunbookVector —— 按 id 取单条预计算向量。
 *
 * @param id runbook id
 * @returns 向量；不存在返回 null
 */
export function getRunbookVector(id: string): Float32Array | null {
  return getAllRunbookVectors().find((record) => record.id === id)?.vector ?? null;
}
`;
  writeFileSync(join(process.cwd(), 'src/utils/runbookEmbeddings.ts'), content, 'utf8');
  console.log(`[完成] 写入 src/utils/runbookEmbeddings.ts（${rows.length} 条）`);
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});