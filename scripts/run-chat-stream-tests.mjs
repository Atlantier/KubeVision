#!/usr/bin/env node
/**
 * KubeVision AI — 流式消费内核单测运行器（R2）
 *
 * 【为什么用 transpileModule 而不是 tsc】消费内核用 `import type { … } from '@/types/ai'`
 * 引用类型；`@/` 是 tsconfig 的路径别名。单文件 `tsc` 会因无法解析别名而报 TS2307。
 * TypeScript 的 `transpileModule` 只做语法级转译（`import type` 直接被擦除），
 * 不解析模块、正好绕开别名问题——这也是 verify-stream-integrity.mjs 的既有做法。
 * 真正的类型正确性由全仓 `pnpm typecheck` 守护。
 *
 * 【用法】node scripts/run-chat-stream-tests.mjs
 * 【退出码】透传 node --test 的退出码（0 = 全绿）
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'tmp-chat-stream-test');
const OUT_UTILS = join(OUT_DIR, 'utils');
process.on('exit', () => {
  try { rmSync(OUT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

console.log('KubeVision AI — 流式消费内核单测');
console.log(`  输出 : ${OUT_DIR}`);

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_UTILS, { recursive: true });

/* ---- 逐文件语法级转译（import type 被擦除，zod 保留为运行时 require） ---- */
const SOURCES = [
  { rel: 'src/utils/chatStreamConsumer.ts', out: join(OUT_UTILS, 'chatStreamConsumer.js') },
  { rel: 'src/utils/chatStreamSchema.ts', out: join(OUT_UTILS, 'chatStreamSchema.js') },
];
for (const source of SOURCES) {
  const text = readFileSync(join(ROOT, source.rel), 'utf8');
  const result = ts.transpileModule(text, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      strict: true,
    },
    fileName: source.rel,
  });
  writeFileSync(source.out, result.outputText, 'utf8');
}

if (!existsSync(join(OUT_UTILS, 'chatStreamConsumer.js')) || !existsSync(join(OUT_UTILS, 'chatStreamSchema.js'))) {
  console.error('[FATAL] 转译产物缺失');
  process.exit(1);
}

console.log('\n  执行 : node --test tests/chatStreamConsumer.test.mjs\n');

try {
  execFileSync(process.execPath, ['--test', 'tests/chatStreamConsumer.test.mjs'], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, KV_STREAM_TEST_DIR: OUT_DIR },
  });
} catch (err) {
  console.error('\n[FAIL] 流式消费内核单测未全绿');
  process.exit(typeof err?.status === 'number' ? err.status : 1);
}

console.log('\n[OK] 流式消费内核单测全部通过');
process.exit(0);