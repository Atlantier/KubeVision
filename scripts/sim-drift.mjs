#!/usr/bin/env node
/**
 * KubeVision AI — 合成引擎长跑漂移与调参取证（scripts/sim-drift.mjs）
 *
 * 【解决什么问题】"QPS 从 12850 漂到 3298"、"三节点 CPU 随机游走到 0/0/0"、
 * "节点卡在 75~88% 的 HighLoad 琥珀态"——这些都是**长跑**才暴露的缺陷。
 * 本脚本离线跑 300 tick（= 36 秒仿真时间），输出：
 *   1. QPS / CPU / 内存曲线（ASCII）；
 *   2. 节点角色基线一致性校验（种子水位 vs 调参表）；
 *   3. 过阻尼保护校验（单帧最大变化量是否被限幅）；
 *   4. 故障恢复曲线（尖峰 20 tick → 稳态 40 tick）。
 *
 * 【为什么需要"编译"步骤】引擎是 TypeScript，且用 `@/...` 路径别名。
 * 项目零依赖不引 ts-node，这里用仓库自带的 typescript 做**单文件转译**，
 * 把三个无外部依赖的文件落盘到临时目录再 require（2 秒内可跑完）。
 *
 * 【用法】
 *   node scripts/sim-drift.mjs                 # 300 tick
 *   node scripts/sim-drift.mjs --ticks=600
 *   node scripts/sim-drift.mjs --json          # 只输出机器可读摘要
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'tmp-sim');
const TICKS = Number(readArg('--ticks') ?? '300');
const JSON_ONLY = process.argv.includes('--json');

function readArg(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? null : hit.slice(flag.length + 1);
}

/* ========================================================================== */
/* 1. 转译三个 TS 文件到临时目录（CommonJS + 别名改写）                          */
/* ========================================================================== */

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

/**
 * 转译一个 TS 文件为 CommonJS 并落盘。
 *
 * @param {string} srcRel 源文件相对路径
 * @param {string} outName 输出文件名（不含扩展名）
 * @param {(code: string) => string} rewrite 输出代码的额外改写
 * @returns {string} 输出文件绝对路径
 */
function transpile(srcRel, outName, rewrite) {
  const source = readFileSync(join(ROOT, srcRel), 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: srcRel,
  });
  const code = rewrite === undefined ? result.outputText : rewrite(result.outputText);
  const file = join(OUT_DIR, `${outName}.cjs`);
  writeFileSync(file, code, 'utf8');
  return file;
}

/** 把 `@/xxx` 别名改写成同目录相对 require（仅用于这三个文件） */
function rewriteAliases(code) {
  return code
    .replace(/require\("@\/types\/cluster"\)/g, 'require("./cluster.cjs")')
    .replace(/require\('@\/types\/cluster'\)/g, "require('./cluster.cjs')")
    .replace(/require\("@\/constants\/telemetryTuning"\)/g, 'require("./telemetryTuning.cjs")')
    .replace(/require\('@\/constants\/telemetryTuning'\)/g, "require('./telemetryTuning.cjs')");
}

transpile('src/constants/telemetryTuning.ts', 'telemetryTuning');
transpile('src/types/cluster.ts', 'cluster', rewriteAliases);
transpile('src/utils/syntheticEngine.ts', 'syntheticEngine', rewriteAliases);

const engine = require(join(OUT_DIR, 'syntheticEngine.cjs'));
const cluster = require(join(OUT_DIR, 'cluster.cjs'));
const tuning = require(join(OUT_DIR, 'telemetryTuning.cjs'));

/* ========================================================================== */
/* 2. 角色基线一致性校验                                                        */
/* ========================================================================== */

/**
 * 校验种子快照的节点水位是否等于调参表里的角色基线。
 *
 * 【为什么非要校验】种子水位写在 types/cluster.ts，角色基线写在
 * constants/telemetryTuning.ts，两处都是手写数字。一旦有人只改一边，
 * 开场就会出现"节点从 A 值慢慢漂到 B 值"的诡异斜坡——这种问题
 * 在浏览器里极难归因，必须在这里直接报错。
 *
 * @returns {Array<{node: string, role: string, expected: object, actual: object}>} 不一致列表
 */
function checkRoleConsistency() {
  const mismatches = [];
  cluster.INITIAL_CLUSTER_SNAPSHOT.nodes.forEach((node, index) => {
    const role = tuning.NODE_ROLE_BY_RACK[index];
    const profile = tuning.NODE_ROLE_PROFILE[role];
    if (node.cpuUsage !== profile.cpu || node.memUsage !== profile.mem) {
      mismatches.push({
        node: node.name,
        role,
        expected: { cpu: profile.cpu, mem: profile.mem },
        actual: { cpu: node.cpuUsage, mem: node.memUsage },
      });
    }
  });
  return mismatches;
}

/* ========================================================================== */
/* 3. 跑 300 tick                                                              */
/* ========================================================================== */

let snapshot = cluster.INITIAL_CLUSTER_SNAPSHOT;
const qpsSeries = [];
const cpuSeries = [[], [], []];
const memSeries = [[], [], []];
const statusChanges = [];
/** 单帧最大变化量（过阻尼保护的核心指标） */
let maxCpuStep = 0;
let maxMemStep = 0;

for (let i = 0; i < TICKS; i += 1) {
  const prevStatus = snapshot.nodes.map((n) => n.status);
  const prevNodes = snapshot.nodes;
  snapshot = engine.stepTelemetrySimulation(snapshot, 'NONE');
  qpsSeries.push(snapshot.totalQps);
  snapshot.nodes.forEach((node, idx) => {
    cpuSeries[idx].push(node.cpuUsage);
    memSeries[idx].push(node.memUsage);
    if (i > 0) {
      maxCpuStep = Math.max(maxCpuStep, Math.abs(node.cpuUsage - prevNodes[idx].cpuUsage));
      maxMemStep = Math.max(maxMemStep, Math.abs(node.memUsage - prevNodes[idx].memUsage));
    }
    if (node.status !== prevStatus[idx]) {
      statusChanges.push({ tick: i + 1, node: node.name, from: prevStatus[idx], to: node.status });
    }
  });
}

/* ========================================================================== */
/* 4. 故障恢复曲线                                                             */
/* ========================================================================== */

let recoverySnap = cluster.INITIAL_CLUSTER_SNAPSHOT;
const recovery = [];
for (let i = 0; i < 60; i += 1) {
  const scenario = i < 20 ? 'NODE_CPU_SPIKE' : 'NONE';
  const prev = recoverySnap;
  recoverySnap = engine.stepTelemetrySimulation(recoverySnap, scenario);
  const alpha = recoverySnap.nodes.find((n) => n.rackIndex === 0);
  const prevAlpha = prev.nodes.find((n) => n.rackIndex === 0);
  recovery.push({
    tick: i + 1,
    scenario,
    cpu: alpha.cpuUsage,
    mem: alpha.memUsage,
    status: alpha.status,
    cpuStep: Math.abs(alpha.cpuUsage - prevAlpha.cpuUsage),
  });
}

/* ========================================================================== */
/* 5. 统计与 ASCII 曲线                                                        */
/* ========================================================================== */

function stats(list) {
  const min = Math.min(...list);
  const max = Math.max(...list);
  const sum = list.reduce((a, b) => a + b, 0);
  return {
    min: Math.round(min * 10) / 10,
    max: Math.round(max * 10) / 10,
    first: Math.round(list[0] * 10) / 10,
    last: Math.round(list[list.length - 1] * 10) / 10,
    avg: Math.round((sum / list.length) * 10) / 10,
  };
}

function asciiCurve(list, min, max) {
  const W = 60;
  const H = 8;
  const grid = Array.from({ length: H }, () => Array(W).fill(' '));
  for (let col = 0; col < W; col += 1) {
    const idx = Math.min(list.length - 1, Math.floor((col * list.length) / W));
    const v = list[idx];
    const ratio = max === min ? 0.5 : (v - min) / (max - min);
    const row = H - 1 - Math.min(H - 1, Math.max(0, Math.round(ratio * (H - 1))));
    grid[row][col] = '*';
  }
  return grid.map((row, i) => {
    const label = (max - ((max - min) * i) / (H - 1)).toFixed(0).padStart(5);
    return `${label} |${row.join('')}`;
  });
}

const qpsStats = stats(qpsSeries);
const roleMismatches = checkRoleConsistency();
const summary = {
  ticks: TICKS,
  qps: qpsStats,
  maxCpuStep: Math.round(maxCpuStep * 10) / 10,
  maxMemStep: Math.round(maxMemStep * 10) / 10,
  stepLimits: { cpu: tuning.NODE_MAX_STEP_CPU, mem: tuning.NODE_MAX_STEP_MEM },
  roleMismatches,
  nodeRoles: cluster.INITIAL_CLUSTER_SNAPSHOT.nodes.map((node, index) => {
    const role = tuning.NODE_ROLE_BY_RACK[index];
    return {
      node: node.name,
      role,
      label: tuning.NODE_ROLE_PROFILE[role].label,
      baseline: { cpu: tuning.NODE_ROLE_PROFILE[role].cpu, mem: tuning.NODE_ROLE_PROFILE[role].mem },
      cpu: stats(cpuSeries[index]),
      mem: stats(memSeries[index]),
      finalStatus: node.status,
    };
  }),
  statusChanges,
};

if (JSON_ONLY) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(roleMismatches.length === 0 ? 0 : 1);
}

console.log('KubeVision AI — 合成引擎调参取证');
console.log(`  tick 数: ${TICKS}（≈ ${(TICKS * 120) / 1000} 秒仿真时间，场景 NONE 稳态）`);
console.log('');
console.log('── 角色基线与调参表一致性 ──────────────────────────');
if (roleMismatches.length === 0) {
  console.log('  ✓ 三个种子节点的水位与 NODE_ROLE_PROFILE 完全一致');
} else {
  console.log('  ✗ 种子水位与调参表不一致（会导致开场出现回归斜坡）:');
  for (const m of roleMismatches) {
    console.log(`    ${m.node} (${m.role}) 期望 ${JSON.stringify(m.expected)} 实际 ${JSON.stringify(m.actual)}`);
  }
}
console.log('');
console.log('── 节点角色画像（稳态实测 vs 基线）───────────────');
for (let i = 0; i < summary.nodeRoles.length; i += 1) {
  const n = summary.nodeRoles[i];
  console.log(
    `  ${n.node.padEnd(14)} ${String(n.label).padEnd(4)} 基线 cpu=${String(n.baseline.cpu).padStart(2)}/mem=${String(n.baseline.mem).padStart(2)}` +
      `  →  实测 cpu ${n.cpu.min}~${n.cpu.max}(avg ${n.cpu.avg})  mem ${n.mem.min}~${n.mem.max}(avg ${n.mem.avg})  终态 ${n.finalStatus}`,
  );
}
const cpuAvgs = summary.nodeRoles.map((n) => n.cpu.avg);
const memAvgs = summary.nodeRoles.map((n) => n.mem.avg);
const cpuSpread = Math.max(...cpuAvgs) - Math.min(...cpuAvgs);
const memSpread = Math.max(...memAvgs) - Math.min(...memAvgs);
console.log(`  → 三节点区分度: CPU 极差 ${cpuSpread.toFixed(1)} · 内存极差 ${memSpread.toFixed(1)} 个百分点`);
console.log('');
console.log('── 过阻尼保护 ──────────────────────────────────────');
console.log(
  `  单帧最大变化: CPU ${summary.maxCpuStep}（限幅 ${summary.stepLimits.cpu}）· 内存 ${summary.maxMemStep}（限幅 ${summary.stepLimits.mem}）`,
);
console.log(
  summary.maxCpuStep <= summary.stepLimits.cpu + 0.05 && summary.maxMemStep <= summary.stepLimits.mem + 0.05
    ? '  ✓ 稳态全程未越过限幅阈值'
    : '  ✗ 存在越过限幅阈值的帧',
);
console.log('');
console.log('── QPS ──────────────────────────────────────────────');
console.log(`  首帧 ${qpsStats.first} → 末帧 ${qpsStats.last} | min ${qpsStats.min} max ${qpsStats.max} avg ${qpsStats.avg}`);
console.log(`  漂移幅度: ${Math.round(qpsStats.max - qpsStats.min)}（越接近 0 越稳）`);
for (const line of asciiCurve(qpsSeries, Math.min(...qpsSeries), Math.max(...qpsSeries))) console.log(line);
console.log('');
for (let i = 0; i < snapshot.nodes.length; i += 1) {
  const node = snapshot.nodes[i];
  const c = stats(cpuSeries[i]);
  const m = stats(memSeries[i]);
  console.log(`── 节点 ${node.name}（${summary.nodeRoles[i].label}）CPU / 内存 ──────`);
  console.log(`  CPU  首帧 ${c.first}% → 末帧 ${c.last}% | min ${c.min} max ${c.max} avg ${c.avg} | 终态 ${node.status}`);
  console.log(`  MEM  首帧 ${m.first}% → 末帧 ${m.last}% | min ${m.min} max ${m.max} avg ${m.avg}`);
  for (const line of asciiCurve(cpuSeries[i], Math.min(...cpuSeries[i]), Math.max(...cpuSeries[i]))) console.log(line);
  console.log('');
}
console.log('── 故障恢复曲线（worker-alpha）──────────────────────');
console.log('  tick  0-19: NODE_CPU_SPIKE    tick 20-59: NONE');
for (const r of recovery.filter((x) => x.tick % 3 === 1 || x.tick === 20 || x.tick === 21 || x.tick === 22)) {
  const bar = '#'.repeat(Math.round(r.cpu / 3));
  console.log(
    `  ${String(r.tick).padStart(3)} ${r.scenario.padEnd(14)} cpu=${String(r.cpu).padStart(5)}% step=${String(Number(r.cpuStep.toFixed(1))).padStart(4)} ${bar.padEnd(34)} ${r.status}`,
  );
}
const afterFault = recovery.filter((x) => x.tick > 20);
const releaseSteps = afterFault.map((x) => x.cpuStep);
console.log(`  → 解除后首帧步长 ${releaseSteps[0].toFixed(1)}（限幅 ${summary.stepLimits.cpu}）`);
console.log(
  `  → 故障解除后首帧 ${afterFault[0].cpu}% · 第 10 帧 ${afterFault[9].cpu}% · 第 20 帧 ${afterFault[19].cpu}% · 末帧 ${afterFault[afterFault.length - 1].cpu}%`,
);
console.log(`  → 终态 ${afterFault[afterFault.length - 1].status}`);
console.log('');
console.log('── 节点状态变更 ──────────────────────────────────────');
if (statusChanges.length === 0) console.log('  （全程无状态跳变）');
else for (const c of statusChanges.slice(0, 12)) console.log(`  tick ${c.tick}: ${c.node} ${c.from} → ${c.to}`);
console.log('');
console.log('JSON 摘要:');
console.log(JSON.stringify(summary, null, 2));

process.exit(roleMismatches.length === 0 ? 0 : 1);