/**
 * KubeVision AI — 异步 Chunk 加载重试单测
 *
 * 【覆盖核心不变量】
 * 1. `isChunkLoadError` 精准识别 ChunkLoadError、`Loading chunk 934 failed`、
 *    动态脚本失败与 `ERR_CONNECTION_CLOSED`，不误伤普通业务 Error；
 * 2. `retryDynamicImport` 在瞬时 Chunk 失败时按配置次数重试并最终成功，
 *    且在遇到非 Chunk 业务错误时立即透传不浪费重试等待时间。
 *
 * 【运行】pnpm test:chunk-retry
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isChunkLoadError, retryDynamicImport } from '../src/utils/dynamicWithRetry.ts';

test('isChunkLoadError 识别 ChunkLoadError 与真实公网 934 报错', () => {
  const webpackErr = new Error(
    'Loading chunk 934 failed. (error: https://kube-vision-bice.vercel.app/_next/static/chunks/934.71c26a758bc21198.js)',
  );
  webpackErr.name = 'ChunkLoadError';
  assert.equal(isChunkLoadError(webpackErr), true);

  assert.equal(
    isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://example.com/chunk.js')),
    true,
  );
  assert.equal(isChunkLoadError('net::ERR_CONNECTION_CLOSED'), true);
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'foo')")), false);
  assert.equal(isChunkLoadError(null), false);
});

test('retryDynamicImport 对瞬时 Chunk 失败执行退避重试并成功', async () => {
  let attempts = 0;
  const wrapped = retryDynamicImport(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('Loading chunk 934 failed.');
        err.name = 'ChunkLoadError';
        throw err;
      }
      return { ok: true, attempts };
    },
    { retries: 3, baseDelayMs: 50, startDelayMs: 0 },
  );

  const result = await wrapped();
  assert.deepEqual(result, { ok: true, attempts: 3 });
});

test('retryDynamicImport 对非 Chunk 业务异常立即失败不重试', async () => {
  let attempts = 0;
  const wrapped = retryDynamicImport(
    async () => {
      attempts += 1;
      throw new SyntaxError('Unexpected token in business module');
    },
    { retries: 4, baseDelayMs: 50, startDelayMs: 0 },
  );

  await assert.rejects(wrapped, /Unexpected token in business module/);
  assert.equal(attempts, 1);
});

test('retryDynamicImport 重试耗尽后透传最后一次 Chunk 异常', async () => {
  let attempts = 0;
  const wrapped = retryDynamicImport(
    async () => {
      attempts += 1;
      const err = new Error(`Loading chunk 934 failed attempt ${attempts}`);
      err.name = 'ChunkLoadError';
      throw err;
    },
    { retries: 2, baseDelayMs: 50, startDelayMs: 0 },
  );

  await assert.rejects(wrapped, /Loading chunk 934 failed attempt 3/);
  assert.equal(attempts, 3);
});
