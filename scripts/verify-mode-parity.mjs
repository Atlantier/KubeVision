#!/usr/bin/env node
/**
 * KubeVision AI — 跨模式故障语义等价性校验（scripts/verify-mode-parity.mjs）
 *
 * 【要证明什么】同一套混沌演练，在「demo 合成引擎」和「live 实时采集 + 叠加层」
 * 两种数据源下，必须让观众看到**同样的故障语义**：
 *   · 受害者数量（异常 Pod 数）
 *   · 节点状态（Ready / HighLoad / NetworkPartition）
 *   · 告警级别分布（P0 / P1 / P2）
 *   · 集群健康分
 * 否则切到实时模式后同一场演练"长得不一样"，是数据可信度问题，不是视觉问题。
 *
 * 【怎么比】live 侧用**宿主桥接 mock**：构造一份与种子快照同拓扑、
 * 但数值完全不同的"真实采集快照"（模拟宿主机读数），再走
 * applyLiveChaosOverlay。这样比较的是**叠加层语义**，而不是数值本身。
 *
 * 【为什么不用真实 collectLiveTelemetrySnapshot()】它会读宿主机实时 CPU/内存，
 * 每次结果都不同，无法做确定性对照。语义校验必须可复现。
 *
 * 【输出】终端对照表 + docs/mode-parity.json（供 sync-docs-metrics.mjs
 * 写入白皮书「数据边界声明」章节）。
 *
 * 【用法】
 *   node scripts/verify-mode-parity.mjs
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'tmp-parity');

/* ========================================================================== */
/* 1. 转译引擎（与 sim-drift 同款单文件转译）                                    */
/* ========================================================================== */

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

/**
 * 转译一个 TS 文件到临时目录。
 *
 * @param srcRel 源文件相对路径
 * @param outName 输出名（不含扩展名）
 * @param rewrite 别名改写
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
  writeFileSync(join(OUT_DIR, `${outName}.cjs`), code, 'utf8');
}

function rewriteAliases(code) {
  return code
    .replace(/require\("@\/types\/cluster"\)/g, 'require("./cluster.cjs")')
    .replace(/require\('@\/types\/cluster'\)/g, "require('./cluster.cjs')")
    .replace(/require\("@\/constants\/telemetryTuning"\)/g, 'require("./telemetryTuning.cjs")')
    .replace(/require\('@\/constants\/telemetryTuning'\)/g, "require('./telemetryTuning.cjs')")
    .replace(/require\("@\/utils\/clusterHealth"\)/g, 'require("./clusterHealth.cjs")')
    .replace(/require\('@\/utils\/clusterHealth'\)/g, "require('./clusterHealth.cjs')");
}

transpile('src/constants/telemetryTuning.ts', 'telemetryTuning');
transpile('src/types/cluster.ts', 'cluster', rewriteAliases);
transpile('src/utils/clusterHealth.ts', 'clusterHealth', rewriteAliases);
transpile('src/utils/syntheticEngine.ts', 'syntheticEngine', rewriteAliases);

const engine = require(join(OUT_DIR, 'syntheticEngine.cjs'));
const cluster = require(join(OUT_DIR, 'cluster.cjs'));

/* ========================================================================== */
/* 2. 语义提取                                                                  */
/* ========================================================================== */

/** 场景枚举与期望的故障语义基线（与设计文档一致） */
const SCENARIOS = [
  { chaos: 'POD_OOM_SWARM', name: 'OOM 风暴' },
  { chaos: 'NET_PACKET_LOSS', name: '网络丢包' },
  { chaos: 'NODE_CPU_SPIKE', name: 'CPU 尖峰' },
];

/**
 * 从一份快照里提取"故障语义"（与具体数值无关的口径）。
 *
 * @param snapshot 遥测快照
 * @returns 语义对象
 */
function extractSemantics(snapshot) {
  const abnormal = snapshot.pods.filter((pod) => pod.status !== 'Running');

  /** 每台节点的状态按机架排序（保证两侧顺序可比） */
  const nodeStatus = snapshot.nodes
    .slice()
    .sort((a, b) => a.rackIndex - b.rackIndex)
    .map((node) => `${node.rackIndex}:${node.status}`);

  /** 告警级别计数 */
  const alertLevels = { P0: 0, P1: 0, P2: 0 };
  for (const alert of snapshot.activeAlerts) {
    if (alert.level in alertLevels) alertLevels[alert.level] += 1;
  }

  return {
    victimCount: abnormal.length,
    victimIds: abnormal.map((pod) => pod.id).sort(),
    nodeStatus,
    alertLevels,
    alertTotal: snapshot.activeAlerts.length,
    healthScore: snapshot.clusterHealthScore,
  };
}

/**
 * 构造「宿主桥接 mock」快照：与种子同拓扑、数值不同。
 *
 * 【为什么数值要不同】如果 mock 直接用种子快照，就分不清"语义一致"
 * 是因为叠加层正确，还是因为两侧输入本来就一样。这里把 CPU/内存整体偏移，
 * 保证 live 侧底盘与 demo 完全不同，只有**叠加语义**是共同变量。
 *
 * @returns 模拟的真实采集快照
 */
function buildHostBridgeMock() {
  const seed = cluster.INITIAL_CLUSTER_SNAPSHOT;
  return {
    ...seed,
    timestamp: seed.timestamp + 3600 * 1000,
    totalQps: 9000,
    clusterHealthScore: 96,
    nodes: seed.nodes.map((node, index) => ({
      ...node,
      cpuUsage: 12 + index * 7,
      memUsage: 30 + index * 9,
      status: 'Ready',
    })),
    pods: seed.pods.map((pod, index) => ({
      ...pod,
      cpuUsage: 10 + (index % 9) * 3,
      memoryUsage: 25 + (index % 7) * 4,
      status: 'Running',
    })),
    activeAlerts: [],
  };
}

/* ========================================================================== */
/* 3. 逐场景对照                                                                */
/* ========================================================================== */

const TICKS = 40;
const rows = [];
let mismatches = 0;

for (const scenario of SCENARIOS) {
  /* demo：从种子快照连续演进 40 tick */
  let demoSnapshot = cluster.INITIAL_CLUSTER_SNAPSHOT;
  for (let i = 0; i < TICKS; i += 1) {
    demoSnapshot = engine.stepTelemetrySimulation(demoSnapshot, scenario.chaos);
  }

  /* live：宿主桥接 mock + 叠加层 */
  const liveSnapshot = engine.applyLiveChaosOverlay(buildHostBridgeMock(), scenario.chaos);

  const demo = extractSemantics(demoSnapshot);
  const live = extractSemantics(liveSnapshot);

  const victimMatch = demo.victimCount === live.victimCount;
  const victimIdMatch = JSON.stringify(demo.victimIds) === JSON.stringify(live.victimIds);
  const nodeMatch = JSON.stringify(demo.nodeStatus) === JSON.stringify(live.nodeStatus);
  const alertMatch = JSON.stringify(demo.alertLevels) === JSON.stringify(live.alertLevels);
  const healthMatch = demo.healthScore === live.healthScore;
  const pass = victimMatch && nodeMatch && alertMatch;

  if (!pass) mismatches += 1;

  rows.push({
    scenario: scenario.chaos,
    name: scenario.name,
    pass,
    victimMatch,
    victimIdMatch,
    nodeMatch,
    alertMatch,
    healthMatch,
    demo,
    live,
  });

  console.log(`\n▸ ${scenario.name}（${scenario.chaos}）`);
  console.log(`  受害者数       demo=${demo.victimCount}  live=${live.victimCount}  ${victimMatch ? '✓' : '✗'}`);
  console.log(`  受害者集合     ${victimIdMatch ? '完全一致' : '不一致（见 JSON）'}`);
  console.log(`  节点状态       demo=[${demo.nodeStatus.join(', ')}]`);
  console.log(`                 live=[${live.nodeStatus.join(', ')}]  ${nodeMatch ? '✓' : '✗'}`);
  console.log(
    `  告警级别分布   demo=P0:${demo.alertLevels.P0}/P1:${demo.alertLevels.P1}/P2:${demo.alertLevels.P2}` +
      `  live=P0:${live.alertLevels.P0}/P1:${live.alertLevels.P1}/P2:${live.alertLevels.P2}  ${alertMatch ? '✓' : '✗'}`,
  );
  console.log(`  健康分         demo=${demo.healthScore}  live=${live.healthScore}  ${healthMatch ? '同分' : '不同分（口径差异，见说明）'}`);
}

/* ========================================================================== */
/* 4. 汇总与落盘                                                                */
/* ========================================================================== */

console.log('\n════════════ 汇总 ════════════');
console.log(`  场景数: ${rows.length} · 语义一致: ${rows.length - mismatches} · 不一致: ${mismatches}`);
console.log('  判定口径: 受害者数 / 节点状态 / 告警级别分布 三项必须一致；');
console.log('            健康分不参与判定（两侧底盘健康分本就不同，属预期差异）。');

const report = {
  generatedAt: new Date().toISOString(),
  ticks: TICKS,
  scenarios: rows.map((row) => ({
    scenario: row.scenario,
    name: row.name,
    pass: row.pass,
    victimCount: { demo: row.demo.victimCount, live: row.live.victimCount, match: row.victimMatch },
    victimIdsMatch: row.victimIdMatch,
    nodeStatus: { demo: row.demo.nodeStatus, live: row.live.nodeStatus, match: row.nodeMatch },
    alertLevels: { demo: row.demo.alertLevels, live: row.live.alertLevels, match: row.alertMatch },
    healthScore: { demo: row.demo.healthScore, live: row.live.healthScore, match: row.healthMatch },
  })),
  matches: rows.length - mismatches,
  mismatches,
};

writeFileSync(join(ROOT, 'docs/mode-parity.json'), JSON.stringify(report, null, 2), 'utf8');
rmSync(OUT_DIR, { recursive: true, force: true });

console.log('\n  ✓ 已写入 docs/mode-parity.json（由 sync-docs-metrics.mjs 同步到白皮书）');
process.exit(mismatches === 0 ? 0 : 1);