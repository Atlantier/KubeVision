#!/usr/bin/env node
/**
 * KubeVision AI — 24h 稳定性收口：60 分钟压测循环（R57）
 *
 * 【做什么】在指定时长内循环执行：
 *   1. `scripts/soak.mjs`（完整对话/SSE/混沌切换/取消语义，自带内存与句柄断言）；
 *   2. `scripts/probe-blackout.mjs --action demo --repeat 3 --duration 10`（每轮黑屏复现率）。
 * 每轮结束后把 soak 报告与探针输出归档到 docs/evidence/soak/，并写趋势汇总 docs/soak-closeout.md。
 *
 * 【为什么循环而不是把 soak 本身拉长】soak 每轮会重建页面与浏览器，能覆盖"进程/页面重启"路径；
 * 单纯把一次 soak 拉长 60 分钟只覆盖单页面长跑，漏掉重连/重载类泄漏。两者互补：
 * 本脚本管"60 分钟多轮"，`scripts/page-open-monitor.mjs` 管"单页面常开 3 小时"。
 *
 * 用法：
 *   node scripts/soak-closeout.mjs                 # 默认 60 分钟
 *   node scripts/soak-closeout.mjs --minutes=5     # 快速自查（仍会跑完整一轮 soak，约 3-4 分钟）
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const minutesArg = process.argv.find((arg) => arg.startsWith('--minutes='));
const MINUTES = Math.max(1, Number(minutesArg === undefined ? 60 : minutesArg.split('=')[1]));
const EVIDENCE_DIR = join(ROOT, 'docs/evidence/soak');
mkdirSync(EVIDENCE_DIR, { recursive: true });
const OUT_MD = join(ROOT, 'docs/soak-closeout.md');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isUp() {
  try {
    const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(2500) });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

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
  } catch { /* ignore */ }
}

/** 运行子命令，输出落盘 */
function run(command, args, logFile, timeoutMs) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, shell: false });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(logFile, `$ ${command} ${args.join(' ')}\n\n--- output ---\n${output}`, 'utf8');
  return { code: result.status ?? 1, durationMs: Date.now() - started, output, logFile };
}

function summarizeSoak() {
  const mdPath = join(ROOT, 'docs/soak.md');
  if (!existsSync(mdPath)) return { ok: false, note: 'docs/soak.md 未生成' };
  const text = readFileSync(mdPath, 'utf8');
  const pass = /通过|PASS|✓/.test(text) && !/失败|FAIL/.test(text);
  return { ok: pass, note: text.split('\n').filter((line) => line.trim().length > 0).slice(-5).join(' | ') };
}

async function main() {
  const startedAt = new Date();
  console.log(`KubeVision AI — 60 分钟稳定性循环（目标 ${MINUTES} 分钟）`);
  let dev = null;
  if (!(await isUp())) {
    console.log('  dev server 不可达，启动 npx next dev…');
    dev = startDev();
    for (let i = 0; i < 120; i += 1) { await sleep(1000); if (await isUp()) break; }
    if (!(await isUp())) { killTree(dev); console.error('  ✗ dev 启动失败'); process.exit(1); }
  }

  const rows = [];
  let cycle = 0;
  let failures = 0;
  while (Date.now() - startedAt.getTime() < MINUTES * 60 * 1000) {
    cycle += 1;
    console.log(`\n━━━ cycle ${cycle}（已运行 ${((Date.now() - startedAt.getTime()) / 60000).toFixed(1)} 分钟）━━━`);
    const soak = run(process.execPath, ['scripts/soak.mjs'], join(EVIDENCE_DIR, `cycle-${String(cycle).padStart(2, '0')}-soak.log`), 6 * 60 * 1000);
    const soakSummary = summarizeSoak();
    console.log(`  soak: exit ${soak.code}（${(soak.durationMs / 1000).toFixed(0)}s）${soakSummary.ok ? 'PASS' : 'CHECK'}`);
    const probe = run(
      process.execPath,
      ['scripts/probe-blackout.mjs', '--action', 'demo', '--repeat', '3', '--duration', '10'],
      join(EVIDENCE_DIR, `cycle-${String(cycle).padStart(2, '0')}-blackout.log`),
      4 * 60 * 1000,
    );
    const probeMatch = probe.output.match(/黑屏复现率\s*:\s*(\d+)\/(\d+)/);
    console.log(`  blackout: exit ${probe.code} ${probeMatch === null ? '' : `${probeMatch[1]}/${probeMatch[2]}`}`);
    const ok = soak.code === 0 && probe.code === 0;
    if (!ok) failures += 1;
    rows.push({ cycle, soakExit: soak.code, soakOk: soakSummary.ok, blackoutExit: probe.code, blackout: probeMatch === null ? null : `${probeMatch[1]}/${probeMatch[2]}`, at: new Date().toISOString() });
    if (!ok) { console.error('  ✗ 本轮失败，停止（保留现场）'); break; }
    await sleep(20000);
  }

  const finishedAt = new Date();
  const lines = [
    '# 60 分钟稳定性循环（soak-closeout）',
    '',
    `- 开始：${startedAt.toISOString()}`,
    `- 结束：${finishedAt.toISOString()}`,
    `- 目标时长：${MINUTES} 分钟；实际：${((finishedAt.getTime() - startedAt.getTime()) / 60000).toFixed(1)} 分钟`,
    `- 轮次：${rows.length}；失败轮次：${failures}`,
    '',
    '| 轮次 | soak | 黑屏探针 | 时间 |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row.cycle} | ${row.soakExit === 0 ? 'PASS' : 'FAIL'} | ${row.blackout ?? 'n/a'} | ${row.at} |`),
    '',
    '> 说明：轮次之间间隔 20 秒；每轮 soak 自带堆内存/句柄断言（详见 `docs/soak.md` 与 `docs/evidence/soak/`）。',
    '> 若本轮中断，报告会如实标记"未完成目标时长"，不补写假数据。',
    '',
  ];
  writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
  writeFileSync(join(EVIDENCE_DIR, 'summary.json'), JSON.stringify({ startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), targetMinutes: MINUTES, cycles: rows.length, failures, rows }, null, 2) + '\n', 'utf8');
  console.log(`\n 报告：docs/soak-closeout.md（轮次 ${rows.length}，失败 ${failures}）`);
  killTree(dev);
  process.exit(failures === 0 && rows.length > 0 ? 0 : 1);
}

main().catch((error) => { console.error('[FATAL]', error); process.exit(1); });