#!/usr/bin/env node
/**
 * KubeVision AI — 导演状态机单测运行器（R04 / 交付项 B）
 *
 * 【为什么需要这个包装脚本】
 * 1. 状态机是 TypeScript，而 `node --test` 不能直接 import .ts（零依赖约束下
 *    不引入 ts-node / tsx）。所以先用 `tsc` 把**单个文件**编译成 CommonJS，
 *    再由测试文件 require。
 * 2. 只编译一个文件（不跑全仓 tsc），单测才能在 2 秒内起跑；
 *    全仓类型检查交给 `pnpm typecheck`。
 * 3. 覆盖率用 Node 内置的 `--experimental-test-coverage`，不引第三方工具。
 *
 * 【用法】
 *   node scripts/run-demo-tests.mjs            # 跑单测 + 覆盖率
 *   node scripts/run-demo-tests.mjs --no-cov   # 只要结果，不要覆盖率
 *
 * 【退出码】透传 node --test 的退出码（0 = 全绿）
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
/*
 * 【为什么不是 .tmp-demo-test（带点）】Node 的覆盖率统计会跳过以 "." 开头的
 * 目录，导致报告里文件列表为空、只剩一句 100%（实测踩到）。
 * 用普通名字才能让"状态机文件覆盖率"这一项真正可读。
 */
const OUT_DIR = join(ROOT, 'tmp-demo-test');
const MACHINE_SRC = join('src', 'utils', 'demoMachine.ts');
const WITH_COVERAGE = !process.argv.includes('--no-cov');

/*
 * 【为什么不用 npx】Windows 上 execFileSync 直接 spawn `npx.cmd` 会抛
 * EINVAL（.cmd 需要 shell）。改为用 node 直接执行 typescript 的 tsc 入口，
 * 既跨平台又不依赖 shell，还能保证用的是仓库锁定的 TS 5.6.3。
 */
const TSC_ENTRY = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

console.log('KubeVision AI — 导演状态机单测');
console.log(`  源文件 : ${MACHINE_SRC}`);
console.log(`  输出   : ${OUT_DIR}`);

/* ---- 1. 清理并重建输出目录 ---- */
if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

/* ---- 2. 编译状态机（单文件） ---- */
try {
  execFileSync(
    process.execPath,
    [
      TSC_ENTRY,
      MACHINE_SRC,
      '--outDir',
      OUT_DIR,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--moduleResolution',
      'node',
      '--strict',
      '--skipLibCheck',
      '--esModuleInterop',
    ],
    { stdio: 'inherit', cwd: ROOT },
  );
} catch (err) {
  console.error('\n[FATAL] 状态机编译失败', err?.message ?? err);
  process.exit(1);
}

/* ---- 3. 跑单测 ---- */
const nodeArgs = ['--test'];
if (WITH_COVERAGE) {
  /*
   * 覆盖率只统计状态机文件本身。
   * 【为什么加 --test-coverage-include】默认覆盖率会包含 node_modules 与
   * 测试替身；限定到 demoMachine 才能回答"状态机文件覆盖率是否 ≥90%"。
   */
  nodeArgs.push('--experimental-test-coverage');
  nodeArgs.push(`--test-coverage-include=**/demoMachine.js`);
}
nodeArgs.push('tests/demoMachine.test.mjs');

console.log(`\n  执行   : node ${nodeArgs.join(' ')}\n`);

try {
  execFileSync(process.execPath, nodeArgs, { stdio: 'inherit', cwd: ROOT });
} catch (err) {
  console.error('\n[FAIL] 单测未全绿');
  process.exit(typeof err?.status === 'number' ? err.status : 1);
}

console.log('\n[OK] 状态机单测全部通过');
process.exit(0);