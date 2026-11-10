#!/usr/bin/env node
/**
 * KubeVision AI — 生成 RAG 评测查询句向量（R44 · Phase 4，dev-only）
 *
 * 【为什么需要】三路召回要求调用方提供 384 维查询向量；评测脚本是 .mjs，
 * 服务端不加载模型（约束：transformers 只在 Worker / 开发脚本）。因此用本脚本
 * **一次性**把 49 条评测查询编码成向量，写入 dev 产物，eval 路由读取后即可
 * 真实对比「两路 vs 三路」。
 *
 * 用法：
 *   node scripts/build-eval-query-embeddings.mjs
 * 产物：docs/summit/artifacts/rag-eval-query-embeddings.json（id → base64 Float32）
 *
 * 注意：首次运行会下载模型；离线/代理失效时先清空代理并设置 HF_ENDPOINT。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSION = 384;
const ROOT = process.cwd();
const CASES_PATH = join(ROOT, 'tmp/eval-cases.json');
const OUT_DIR = join(ROOT, 'docs/summit/artifacts');
const OUT_PATH = join(OUT_DIR, 'rag-eval-query-embeddings.json');

/**
 * fetchCases —— 从 dev 路由拉评测用例（若本地 tmp 文件不存在）。
 *
 * @returns 用例数组
 */
async function fetchCases() {
  const response = await fetch('http://127.0.0.1:3000/api/dev/rag-eval?cases=1');
  if (!response.ok) throw new Error(`cases endpoint HTTP ${response.status}`);
  return await response.json();
}

async function main() {
  const cases = existsSync(CASES_PATH) ? JSON.parse(readFileSync(CASES_PATH, 'utf8')) : await fetchCases();
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('评测用例为空');

  const transformers = await import('@huggingface/transformers');
  console.log(`[1/3] 加载模型 ${MODEL_ID} …`);
  const extractor = await transformers.pipeline('feature-extraction', MODEL_ID);

  console.log(`[2/3] 编码 ${cases.length} 条查询 …`);
  const payload = {};
  for (const testCase of cases) {
    const output = await extractor(String(testCase.query), { pooling: 'mean', normalize: true });
    const vector = Float32Array.from(output.data);
    if (vector.length !== DIMENSION) throw new Error(`${testCase.id} 维度 ${vector.length} ≠ ${DIMENSION}`);
    const buffer = Buffer.alloc(DIMENSION * 4);
    for (let i = 0; i < DIMENSION; i += 1) buffer.writeFloatLE(vector[i] ?? 0, i * 4);
    payload[testCase.id] = buffer.toString('base64');
  }

  console.log('[3/3] 写出查询向量 …');
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[完成] ${OUT_PATH}（${Object.keys(payload).length} 条）`);
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});