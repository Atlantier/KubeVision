#!/usr/bin/env node
/**
 * KubeVision AI — 合成引擎长跑漂移取证（scripts/sim-drift.mjs）
 *
 * 【解决什么问题】"QPS 从 12850 漂到 3298"、"三节点 CPU 随机游走到 0/0/0"、
 * "节点卡在 75~88% 的 HighLoad 琥珀态"——这些都是**长跑**才暴露的缺陷，
 * 单元测试跑几十帧看不出来。本脚本离线跑 300 tick（= 36 秒仿真时间），
 * 把 QPS 与三节点 CPU 的曲线打成 ASCII 图，用来对比修复前后。
 *
 * 【为什么需要"编译"步骤】引擎是 TypeScript，且用 `@/types/cluster` 路径别名。
 * 项目零依赖不引 ts-node，所以这里用仓库自带的 typescript 编译器做
 * **单文件转译**，并把别名改写成相对路径后落盘到临时目录再 require。
 * 只转译两个文件（cluster.ts 是纯类型+常量，无外部依赖），2 秒内可跑完。
 *
 * 【用法】
 *   node scripts/sim-drift.mjs            # 跑 300 tick 并打印曲线
 *   node scripts/sim-drift.mjs --ticks=600
 *   node scripts/sim-drift.mjs --json     # 只输出机器可读摘要
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
/* 1. 转译两个 TS 文件到临时目录（CommonJS + 别名改写）                          */
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

/* cluster.ts 无外部依赖，直接转译 */
transpile('src/types/cluster.ts', 'cluster');

/* syntheticEngine.ts 把 '@/types/cluster' 改写成 './cluster.cjs' */
transpile('src/utils/syntheticEngine.ts', 'syntheticEngine', (code) =>
  code
    .replace(/require\("@\/types\/cluster"\)/g, 'require("./cluster.cjs")')
    .replace(/require\('@\/types\/cluster'\)/g, "require('./cluster.cjs')"),
);

const engine = require(join(OUT_DIR, 'syntheticEngine.cjs'));
const cluster = require(join(OUT_DIR, 'cluster.cjs'));

/* ========================================================================== */
/* 2. 跑 300 tick                                                              */
/* ========================================================================== */

let snapshot = cluster.INITIAL_CLUSTER_SNAPSHOT;
const qpsSeries = [];
const cpuSeries = [[], [], []];
const statusChanges = [];

for (let i = 0; i < TICKS; i += 1) {
  const prevStatus = snapshot.nodes.map((n) => n.status);
  snapshot = engine.stepTelemetrySimulation(snapshot, 'NONE');
  qpsSeries.push(snapshot.totalQps);
  snapshot.nodes.forEach((node, idx) => {
    cpuSeries[idx].push(node.cpuUsage);
    if (node.status !== prevStatus[idx]) {
      statusChanges.push({ tick: i + 1, node: node.name, from: prevStatus[idx], to: node.status });
    }
  });
}

/* ========================================================================== */
/* 3. 统计与 ASCII 曲线                                                        */
/* ========================================================================== */

/**
 * 计算序列统计量。
 *
 * @param {number[]} list 数值序列
 * @returns {{min:number,max:number,first:number,last:number,avg:number}}
 */
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

/**
 * 把序列画成 ASCII 曲线（宽度压缩到 60 列，高度 8 行）。
 *
 * @param {number[]} list 数值序列
 * @param {number} min 纵轴下界
 * @param {number} max 纵轴上界
 * @returns {string[]} 行数组（从高到低）
 */
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
const cpuStats = cpuSeries.map((s) => stats(s));

const summary = {
  ticks: TICKS,
  qps: qpsStats,
  nodeCpu: snapshot.nodes.map((node, idx) => ({
    node: node.name,
    ...cpuStats[idx],
    finalStatus: node.status,
  })),
  statusChanges,
};

if (JSON_ONLY) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

console.log('KubeVision AI — 合成引擎 300 tick 漂移取证');
console.log(`  tick 数: ${TICKS}（≈ ${(TICKS * 120) / 1000} 秒仿真时间，场景 NONE 稳态）`);
console.log('');
console.log('── QPS ──────────────────────────────────────────────');
console.log(`  首帧 ${qpsStats.first} → 末帧 ${qpsStats.last} | min ${qpsStats.min} max ${qpsStats.max} avg ${qpsStats.avg}`);
console.log(`  漂移幅度: ${Math.round(qpsStats.max - qpsStats.min)}（越接近 0 越稳）`);
for (const line of asciiCurve(qpsSeries, Math.min(...qpsSeries), Math.max(...qpsSeries))) console.log(line);
console.log('');
for (let i = 0; i < snapshot.nodes.length; i += 1) {
  const node = snapshot.nodes[i];
  const s = cpuStats[i];
  console.log(`── 节点 ${node.name} CPU（rack ${node.rackIndex}）──────────────`);
  console.log(`  首帧 ${s.first}% → 末帧 ${s.last}% | min ${s.min} max ${s.max} avg ${s.avg} | 终态 ${node.status}`);
  for (const line of asciiCurve(cpuSeries[i], Math.min(...cpuSeries[i]), Math.max(...cpuSeries[i]))) console.log(line);
  console.log('');
}
/* ---- 故障恢复曲线：NODE_CPU_SPIKE 打 20 tick，再回稳态 40 tick ---- */
let recoverySnap = cluster.INITIAL_CLUSTER_SNAPSHOT;
const recovery = [];
for (let i = 0; i < 60; i += 1) {
  const scenario = i < 20 ? 'NODE_CPU_SPIKE' : 'NONE';
  recoverySnap = engine.stepTelemetrySimulation(recoverySnap, scenario);
  const alpha = recoverySnap.nodes.find((n) => n.rackIndex === 0);
  recovery.push({ tick: i + 1, scenario, cpu: alpha.cpuUsage, mem: alpha.memUsage, status: alpha.status });
}
console.log('── 故障恢复曲线（worker-alpha）──────────────────────');
console.log('  tick  0-19: NODE_CPU_SPIKE    tick 20-59: NONE');
for (const r of recovery.filter((x) => x.tick % 3 === 1 || x.tick === 20 || x.tick === 21 || x.tick === 22)) {
  const bar = '#'.repeat(Math.round(r.cpu / 3));
  console.log(`  ${String(r.tick).padStart(3)} ${r.scenario.padEnd(14)} cpu=${String(r.cpu).padStart(5)}% ${bar.padEnd(34)} ${r.status}`);
}
const afterFault = recovery.filter((x) => x.tick > 20);
console.log(`  → 故障解除后首帧 ${afterFault[0].cpu}% · 第 10 帧 ${afterFault[9].cpu}% · 第 20 帧 ${afterFault[19].cpu}% · 末帧 ${afterFault[afterFault.length - 1].cpu}%`);
console.log(`  → 终态 ${afterFault[afterFault.length - 1].status}`);
console.log('');

console.log('── 节点状态变更 ──────────────────────────────────────');
if (statusChanges.length === 0) console.log('  （全程无状态跳变）');
else for (const c of statusChanges.slice(0, 12)) console.log(`  tick ${c.tick}: ${c.node} ${c.from} → ${c.to}`);
console.log('');
console.log('JSON 摘要:');
console.log(JSON.stringify(summary, null, 2));