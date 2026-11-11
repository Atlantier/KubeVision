#!/usr/bin/env node
/**
 * KubeVision AI — 一键总回归（scripts/verify-all.mjs）
 *
 * 顺序（失败即停，保存现场）：
 *   tsc → next lint → lint:glsl → check:a11y → check:emoji → check:layering
 *   → check:dead-exports → verify.mjs → verify-stream-integrity → verify-telemetry
 *   → verify-demo（脚本内置两遍连跑）→ probe-blackout（demo/chaos-oom/chaos-net/dpr-drop 各 3 次）
 *   → eval-rag → mcp-smoke → verify-privacy → check-docs-consistency
 *
 * 行为：
 *  - 自动探测/拉起 dev server（仅当 3000 不可达时；结束时只杀自己拉起的进程）；
 *  - 每一步 stdout/stderr 原样落盘到 docs/evidence/verify-all/<时间戳>/<序号>-<name>.log；
 *  - 失败时写 FAILURE.md（步骤、退出码、日志路径、尾部输出）并停止；
 *  - 结束时打印 Markdown 汇总表（通过/失败/耗时），同时写 summary.md / summary.json。
 *
 * 用法：node scripts/verify-all.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = join(ROOT, 'docs/evidence/verify-all', STAMP);
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 探测 dev server */
async function isUp() {
  try {
    const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(2500) });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/** 拉起 dev server（npx next dev，避免 pnpm 的依赖检查交互） */
function startDev() {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
  const args = process.platform === 'win32' ? ['/c', 'npx next dev'] : ['next', 'dev'];
  const child = spawn(command, args, { cwd: ROOT, stdio: 'ignore', detached: process.platform !== 'win32' });
  child.on('error', () => {});
  return child;
}

function killTree(child) {
  if (child === null || child.pid === undefined) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
}

/** 步骤定义 */
const node = process.execPath;
const STEPS = [
  { name: 'tsc', cmd: node, args: [join(ROOT, 'node_modules/typescript/bin/tsc'), '--noEmit'], needsDev: false },
  { name: 'next-lint', cmd: node, args: [join(ROOT, 'node_modules/next/dist/bin/next'), 'lint'], needsDev: false },
  { name: 'lint-glsl', cmd: node, args: ['scripts/lint-glsl.mjs'], needsDev: false },
  { name: 'check-a11y', cmd: node, args: ['scripts/check-a11y.mjs'], needsDev: false },
  { name: 'check-emoji', cmd: node, args: ['scripts/check-emoji.mjs'], needsDev: false },
  { name: 'check-layering', cmd: node, args: ['scripts/check-layering.mjs'], needsDev: false },
  { name: 'check-dead-exports', cmd: node, args: ['scripts/check-dead-exports.mjs'], needsDev: false },
  { name: 'verify', cmd: node, args: ['scripts/verify.mjs'], needsDev: true, timeoutMs: 420000 },
  { name: 'verify-stream-integrity', cmd: node, args: ['scripts/verify-stream-integrity.mjs'], needsDev: true, timeoutMs: 180000 },
  { name: 'verify-telemetry', cmd: node, args: ['scripts/verify-telemetry.mjs'], needsDev: false, timeoutMs: 180000 },
  { name: 'verify-demo', cmd: node, args: ['scripts/verify-demo.mjs'], needsDev: true, timeoutMs: 420000 },
  { name: 'probe-blackout-demo', cmd: node, args: ['scripts/probe-blackout.mjs', '--action', 'demo', '--repeat', '3', '--duration', '10'], needsDev: true, timeoutMs: 240000 },
  { name: 'probe-blackout-chaos-oom', cmd: node, args: ['scripts/probe-blackout.mjs', '--action', 'chaos-oom', '--repeat', '3', '--duration', '10'], needsDev: true, timeoutMs: 240000 },
  { name: 'probe-blackout-chaos-net', cmd: node, args: ['scripts/probe-blackout.mjs', '--action', 'chaos-net', '--repeat', '3', '--duration', '10'], needsDev: true, timeoutMs: 240000 },
  { name: 'probe-blackout-dpr-drop', cmd: node, args: ['scripts/probe-blackout.mjs', '--action', 'dpr-drop', '--repeat', '3', '--duration', '10'], needsDev: true, timeoutMs: 240000 },
  { name: 'eval-rag', cmd: node, args: ['scripts/eval-rag.mjs'], needsDev: true, timeoutMs: 300000 },
  { name: 'mcp-smoke', cmd: node, args: ['scripts/mcp-smoke.mjs'], needsDev: true, timeoutMs: 120000 },
  { name: 'verify-privacy', cmd: node, args: ['scripts/verify-privacy.mjs'], needsDev: true, timeoutMs: 300000 },
  { name: 'check-docs-consistency', cmd: node, args: ['scripts/check-docs-consistency.mjs'], needsDev: false },
];

function tail(text, lines = 30) {
  return text.split('\n').slice(-lines).join('\n');
}

async function main() {
  const startedAt = new Date();
  console.log(`KubeVision AI — 一键总回归（${STEPS.length} 步）`);
  console.log(`  输出目录: ${OUT_DIR}`);
  if (!(await isUp())) {
    console.log('  dev server 不可达，自动启动 npx next dev…');
    const dev = startDev();
    devRef = dev;
    for (let i = 0; i < 120; i += 1) {
      await sleep(1000);
      if (await isUp()) { console.log(`  dev ready after ${i + 1}s`); break; }
    }
    if (!(await isUp())) {
      console.error('  ✗ dev server 启动失败');
      killTree(dev);
      process.exit(1);
    }
  } else {
    console.log('  dev server 已就绪');
  }

  const rows = [];
  let failed = null;
  for (let i = 0; i < STEPS.length; i += 1) {
    const step = STEPS[i];
    console.log(`\n━━━ [${i + 1}/${STEPS.length}] ${step.name} ━━━`);
    /* 手工执行并收集输出（含日志落盘） */
    const logFile = join(OUT_DIR, `${String(i + 1).padStart(2, '0')}-${step.name}.log`);
    const started = Date.now();
    const outcome = await new Promise((resolve) => {
      const child = spawn(step.cmd, step.args, { cwd: ROOT, shell: false });
      let output = '';
      const timer = step.timeoutMs === undefined
        ? null
        : setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, step.timeoutMs);
      child.stdout.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text); });
      child.stderr.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stderr.write(text); });
      child.on('close', (code, signal) => {
        if (timer !== null) clearTimeout(timer);
        resolve({ code: code ?? (signal === null ? 1 : 124), output });
      });
      child.on('error', (error) => {
        if (timer !== null) clearTimeout(timer);
        resolve({ code: 127, output: output + '\n[spawn error] ' + String(error) });
      });
    });
    const durationMs = Date.now() - started;
    writeFileSync(logFile, `$ ${step.cmd} ${step.args.join(' ')}\n\n--- output ---\n${outcome.output}`, 'utf8');
    rows.push({ name: step.name, exitCode: outcome.code, durationMs, logFile: logFile.replace(ROOT + '\\', '').replace(ROOT + '/', '') });
    console.log(`  → exit ${outcome.code}（${(durationMs / 1000).toFixed(1)}s）`);
    if (outcome.code !== 0) {
      failed = { step: step.name, index: i + 1, exitCode: outcome.code, logFile, tail: tail(outcome.output) };
      break;
    }
  }

  const finishedAt = new Date();
  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    baseUrl: BASE_URL,
    outDir: OUT_DIR,
    steps: rows,
    failed,
    passCount: rows.filter((row) => row.exitCode === 0).length,
    failCount: failed === null ? 0 : 1,
    totalSteps: STEPS.length,
  };
  writeFileSync(join(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const lines = [];
  lines.push('# 一键总回归 summary');
  lines.push('');
  lines.push(`- 开始：${summary.startedAt}`);
  lines.push(`- 结束：${summary.finishedAt}`);
  lines.push(`- 输出目录：\`${OUT_DIR.replace(ROOT + '\\', '').replace(ROOT + '/', '')}\``);
  lines.push('');
  lines.push('| # | 步骤 | 结果 | 耗时(s) | 日志 |');
  lines.push('|---|---|---|---|---|');
  for (const row of rows) {
    const idx = rows.indexOf(row) + 1;
    lines.push(`| ${idx} | ${row.name} | ${row.exitCode === 0 ? 'PASS' : 'FAIL'} | ${(row.durationMs / 1000).toFixed(1)} | \`${row.logFile}\` |`);
  }
  if (failed !== null) {
    lines.push('');
    lines.push(`> **失败即停**：第 ${failed.index} 步 \`${failed.step}\` exit ${failed.exitCode}；现场日志 \`${failed.logFile.replace(ROOT + '\\', '').replace(ROOT + '/', '')}\`。`);
    lines.push('');
    lines.push('```text');
    lines.push(failed.tail);
    lines.push('```');
  }
  const summaryMd = lines.join('\n') + '\n';
  writeFileSync(join(OUT_DIR, 'summary.md'), summaryMd, 'utf8');

  console.log('\n══════════════════ verify:all 汇总 ══════════════════');
  console.log(summaryMd);
  if (failed !== null) {
    writeFileSync(join(OUT_DIR, 'FAILURE.md'), `# verify:all 失败现场\n\n- 步骤：${failed.step}\n- 退出码：${failed.exitCode}\n- 日志：${failed.logFile}\n\n\`\`\`text\n${failed.tail}\n\`\`\`\n`, 'utf8');
    killTree(devRef);
    process.exit(1);
  }
  killTree(devRef);
  process.exit(0);
}

let devRef = null;
main().catch((error) => {
  console.error('[FATAL]', error);
  killTree(devRef);
  process.exit(1);
});