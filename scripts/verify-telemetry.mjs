#!/usr/bin/env node
/**
 * KubeVision AI — 遥测引擎长跑与属性测试（scripts/verify-telemetry.mjs）
 *
 * 【为什么需要这个脚本】演示链路已经有一整套 CDP 验收（verify-demo），但它
 * 只能证明"某一次实时画面是对的"。遥测引擎真正的危险在**长跑与边界**：
 * QPS 复利漂移、节点随机游走、健康分越界、时间戳倒退、历史数组长度契约破损——
 * 这些跑 30 秒看不出来，跑 300 tick 才暴露。
 *
 * 【为什么直接 import 引擎纯函数、不起服务】
 * 1. 引擎是无副作用纯函数（快照进 → 快照出），根本不需要 HTTP/浏览器；
 * 2. 起 dev server + headless 浏览器跑 300 tick 至少要 1 分钟，纯函数版 300 tick
 *    只要几毫秒，于是"长跑"和"属性测试 200 组"才跑得起；
 * 3. 失败时是确定性的、可复现的——不依赖时序、GPU、网络。
 *
 * 【实现方式】TypeScript 源码无法被 node 直接 import，这里用仓库自带的
 * typescript 做单文件转译（与 scripts/sim-drift.mjs 同款），再动态引入。
 *
 * 【用法】
 *   node scripts/verify-telemetry.mjs            # 全部用例
 *   node scripts/verify-telemetry.mjs --verbose  # 打印每帧采样
 *
 * 【退出码】0 = 全绿；1 = 有断言失败（node:test 自带汇总）
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'tmp-telemetry');
const VERBOSE = process.argv.includes('--verbose');

/* ========================================================================== */
/* 1. 转译引擎（三个无外部依赖的 TS 文件）                                        */
/* ========================================================================== */

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

/**
 * 把 TS 源文件转译成 CommonJS 并落盘。
 *
 * @param srcRel 相对仓库根的源路径
 * @param outName 输出文件名（不含扩展名）
 * @param rewrite 输出代码的别名改写函数
 * @returns 输出文件绝对路径
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

/** 把 `@/...` 别名改写成同目录相对 require */
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
transpile('src/utils/snapshotRingBuffer.ts', 'snapshotRingBuffer', rewriteAliases);
transpile('src/utils/frameTimeline.ts', 'frameTimeline', rewriteAliases);
transpile('src/store/useTelemetryRef.ts', 'useTelemetryRef', rewriteAliases);

const engine = require(join(OUT_DIR, 'syntheticEngine.cjs'));
const clusterHealth = require(join(OUT_DIR, 'clusterHealth.cjs'));
const cluster = require(join(OUT_DIR, 'cluster.cjs'));
const tuning = require(join(OUT_DIR, 'telemetryTuning.cjs'));
const ring = require(join(OUT_DIR, 'snapshotRingBuffer.cjs'));
const timeline = require(join(OUT_DIR, 'frameTimeline.cjs'));
const transient = require(join(OUT_DIR, 'useTelemetryRef.cjs'));

/* ========================================================================== */
/* 2. 公共夹具                                                                  */
/* ========================================================================== */

const TICK_MS = engine.TICK_INTERVAL_MS;
const QPS_BASELINE = engine.QPS_BASELINE;
const SEED = cluster.INITIAL_CLUSTER_SNAPSHOT;

/** 混沌场景枚举（与引擎契约一致） */
const SCENARIOS = ['NONE', 'POD_OOM_SWARM', 'NET_PACKET_LOSS', 'NODE_CPU_SPIKE'];

/** 各场景对 QPS 的惩罚系数（与引擎内部实现同源，测试侧独立写一份以便实现被改错时失败） */
const QPS_PENALTY = {
  NONE: 1,
  POD_OOM_SWARM: 0.82,
  NODE_CPU_SPIKE: 0.9,
  NET_PACKET_LOSS: 0.72,
};

/** 各场景的受灾机架（-1 表示无） */
const FAULT_RACK = {
  NONE: -1,
  POD_OOM_SWARM: engine.OOM_RACK_INDEX,
  NODE_CPU_SPIKE: engine.SPIKE_RACK_INDEX,
  NET_PACKET_LOSS: engine.PARTITION_RACK_INDEX,
};

/**
 * 按场景序列推进引擎。
 *
 * @param scenarios 每 tick 的场景
 * @param start 起始快照（默认种子快照）
 * @returns 每 tick 之后的快照数组
 */
function runSequence(scenarios, start = SEED) {
  let snapshot = start;
  const frames = [];
  for (const scenario of scenarios) {
    snapshot = engine.stepTelemetrySimulation(snapshot, scenario);
    frames.push(snapshot);
  }
  return frames;
}

/**
 * 构造 300 tick 的混沌轮换序列：NONE→OOM→NONE→NET→NONE→SPIKE→NONE。
 *
 * @returns {string[]} 长度 300 的场景序列
 */
function buildRotation() {
  const plan = [
    ['NONE', 43],
    ['POD_OOM_SWARM', 43],
    ['NONE', 43],
    ['NET_PACKET_LOSS', 43],
    ['NONE', 43],
    ['NODE_CPU_SPIKE', 43],
    ['NONE', 42],
  ];
  const sequence = [];
  for (const [scenario, ticks] of plan) {
    for (let i = 0; i < ticks; i += 1) sequence.push(scenario);
  }
  return sequence;
}

/**
 * mulberry32 确定性 PRNG（属性测试用，零依赖）。
 *
 * @param seed 32 位种子
 * @returns () => [0,1)
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 收集单帧的所有不变量违例。
 *
 * @param snapshot 快照
 * @param expectedTs 期望时间戳（上一帧 + TICK_MS）
 * @returns {string[]} 违例描述列表
 */
function collectInvariants(snapshot, expectedTs) {
  const issues = [];

  if (snapshot.timestamp !== expectedTs) {
    issues.push(`时间戳 ${snapshot.timestamp} ≠ 期望 ${expectedTs}`);
  }
  if (!Number.isFinite(snapshot.totalQps) || snapshot.totalQps < 0) {
    issues.push(`QPS 非法: ${snapshot.totalQps}`);
  }
  if (
    !Number.isFinite(snapshot.clusterHealthScore) ||
    snapshot.clusterHealthScore < 0 ||
    snapshot.clusterHealthScore > 100
  ) {
    issues.push(`健康分越界: ${snapshot.clusterHealthScore}`);
  }

  for (const node of snapshot.nodes) {
    if (!Number.isFinite(node.cpuUsage) || node.cpuUsage < 0 || node.cpuUsage > 100) {
      issues.push(`${node.name} CPU 越界: ${node.cpuUsage}`);
    }
    if (!Number.isFinite(node.memUsage) || node.memUsage < 0 || node.memUsage > 100) {
      issues.push(`${node.name} 内存越界: ${node.memUsage}`);
    }
    /* 反向索引一致性：podIds 中每个 Pod 的 nodeId 必须指回该节点 */
    for (const podId of node.podIds) {
      const pod = snapshot.pods.find((p) => p.id === podId);
      if (pod === undefined) issues.push(`${node.name}.podIds 含不存在的 Pod: ${podId}`);
      else if (pod.nodeId !== node.id) issues.push(`${podId}.nodeId=${pod.nodeId} ≠ ${node.id}`);
    }
    const owned = snapshot.pods.filter((p) => p.nodeId === node.id).length;
    if (owned !== node.podIds.length) {
      issues.push(`${node.name} podIds 数量 ${node.podIds.length} ≠ 实际归属 ${owned}`);
    }
  }

  for (const pod of snapshot.pods) {
    if (pod.cpuHistory.length !== 6 || pod.memHistory.length !== 6) {
      issues.push(`${pod.id} 历史长度 ${pod.cpuHistory.length}/${pod.memHistory.length} ≠ 6`);
    }
    if (pod.cpuHistory[5] !== pod.cpuUsage) {
      issues.push(`${pod.id} cpuHistory 末位 ${pod.cpuHistory[5]} ≠ 当前 ${pod.cpuUsage}`);
    }
    if (pod.memHistory[5] !== pod.memoryUsage) {
      issues.push(`${pod.id} memHistory 末位 ${pod.memHistory[5]} ≠ 当前 ${pod.memoryUsage}`);
    }
  }

  return issues;
}

/* ========================================================================== */
/* 3. A-1 · 300 tick 混沌轮换                                                   */
/* ========================================================================== */

test('A-1 300 tick 混沌轮换：QPS / CPU / 健康分全部在有界区间内', () => {
  const scenarios = buildRotation();
  const frames = runSequence(scenarios);
  assert.equal(frames.length, 300, '应产出 300 帧');

  const violations = [];
  const qpsSteady = { min: Infinity, max: -Infinity };
  const qpsChaos = { min: Infinity, max: -Infinity };
  const cpuByNode = new Map();

  frames.forEach((snapshot, index) => {
    const scenario = scenarios[index];
    const penalty = QPS_PENALTY[scenario];

    /* ---- QPS：稳态帧锚定基准 ±15%，故障帧锚定「基准 × 惩罚」±15% ---- */
    if (scenario === 'NONE') {
      qpsSteady.min = Math.min(qpsSteady.min, snapshot.totalQps);
      qpsSteady.max = Math.max(qpsSteady.max, snapshot.totalQps);
      const lo = QPS_BASELINE * 0.85;
      const hi = QPS_BASELINE * 1.15;
      if (snapshot.totalQps < lo || snapshot.totalQps > hi) {
        violations.push(`tick ${index + 1} 稳态 QPS ${snapshot.totalQps} 越界 [${lo.toFixed(0)},${hi.toFixed(0)}]`);
      }
    } else {
      qpsChaos.min = Math.min(qpsChaos.min, snapshot.totalQps);
      qpsChaos.max = Math.max(qpsChaos.max, snapshot.totalQps);
      const lo = QPS_BASELINE * penalty * 0.85;
      const hi = QPS_BASELINE * penalty * 1.15;
      if (snapshot.totalQps < lo || snapshot.totalQps > hi) {
        violations.push(`tick ${index + 1} ${scenario} QPS ${snapshot.totalQps} 越界 [${lo.toFixed(0)},${hi.toFixed(0)}]`);
      }
    }

    /* ---- 节点 CPU：非受灾节点 [10,90]；受灾节点按故障语义豁免上界 ---- */
    for (const node of snapshot.nodes) {
      const key = node.name;
      if (!cpuByNode.has(key)) cpuByNode.set(key, { min: Infinity, max: -Infinity });
      const stat = cpuByNode.get(key);
      stat.min = Math.min(stat.min, node.cpuUsage);
      stat.max = Math.max(stat.max, node.cpuUsage);

      const isFaultTarget = node.rackIndex === FAULT_RACK[scenario];
      if (isFaultTarget) {
        /* 故障态：CPU 尖峰目标是 92~99，允许到 100 */
        if (node.cpuUsage < 0 || node.cpuUsage > 100) {
          violations.push(`tick ${index + 1} ${node.name} 故障态 CPU ${node.cpuUsage} 越界`);
        }
      } else if (node.cpuUsage < 10 || node.cpuUsage > 90) {
        violations.push(`tick ${index + 1} ${key} 非受灾 CPU ${node.cpuUsage} 越界 [10,90]`);
      }
    }

    /* ---- 健康分 ---- */
    if (snapshot.clusterHealthScore < 0 || snapshot.clusterHealthScore > 100) {
      violations.push(`tick ${index + 1} 健康分 ${snapshot.clusterHealthScore} 越界`);
    }
  });

  if (VERBOSE) {
    console.log('  QPS 稳态区间:', qpsSteady, ' 故障区间:', qpsChaos);
    for (const [name, stat] of cpuByNode) console.log(`  ${name} CPU:`, stat);
  }

  assert.deepEqual(violations.slice(0, 5), [], `300 tick 违例 ${violations.length} 处:\n${violations.slice(0, 10).join('\n')}`);
  assert.ok(qpsSteady.min >= QPS_BASELINE * 0.85 && qpsSteady.max <= QPS_BASELINE * 1.15, '稳态 QPS 应在基准 ±15%');
});

/* ========================================================================== */
/* 4. A-2 · 确定性                                                            */
/* ========================================================================== */

test('A-2 同种子同输入 ⇒ 输出逐字节一致；不同 tick 必不同', () => {
  const sequence = buildRotation().slice(0, 60);
  const first = runSequence(sequence);
  const second = runSequence(sequence);

  assert.equal(JSON.stringify(first), JSON.stringify(second), '两次同输入结果必须逐字节一致');

  /* 不同 tick 的快照必须不同（防止"引擎空转"） */
  assert.notEqual(JSON.stringify(first[10]), JSON.stringify(first[11]), '相邻 tick 不得完全相同');

  /* 时间戳也必须推进 */
  assert.equal(first[11].timestamp - first[10].timestamp, TICK_MS, '相邻 tick 时间戳差应为 1000ms');
});

/* ========================================================================== */
/* 5. A-3 · 时间戳                                                            */
/* ========================================================================== */

test('A-3 时间戳严格 +1000ms；重连 since 场景单调', () => {
  const frames = runSequence(buildRotation().slice(0, 120));
  let expected = SEED.timestamp;
  frames.forEach((snapshot, index) => {
    expected += TICK_MS;
    assert.equal(snapshot.timestamp, expected, `第 ${index + 1} 帧时间戳应为 ${expected}`);
  });

  /* 重连续接：服务端会以 since 抬起起点，引擎随后必须继续 +1000 */
  const since = SEED.timestamp + 12 * TICK_MS;
  const resumed = engine.stepTelemetrySimulation({ ...SEED, timestamp: since }, 'NONE');
  assert.equal(resumed.timestamp, since + TICK_MS, 'since 起点后首帧应严格 +1000ms');
});

/* ========================================================================== */
/* 6. A-4 · 历史数组与双向索引契约                                              */
/* ========================================================================== */

test('A-4 cpuHistory/memHistory 恒为 6 且末位等于当前值；podIds ↔ nodeId 双向一致', () => {
  const frames = runSequence(buildRotation());
  let checked = 0;

  for (const snapshot of frames) {
    for (const pod of snapshot.pods) {
      assert.equal(pod.cpuHistory.length, 6, `${pod.id} cpuHistory 长度`);
      assert.equal(pod.memHistory.length, 6, `${pod.id} memHistory 长度`);
      assert.equal(pod.cpuHistory[5], pod.cpuUsage, `${pod.id} cpuHistory 末位`);
      assert.equal(pod.memHistory[5], pod.memoryUsage, `${pod.id} memHistory 末位`);
      checked += 1;
    }
    for (const node of snapshot.nodes) {
      const owned = snapshot.pods.filter((p) => p.nodeId === node.id);
      assert.equal(node.podIds.length, owned.length, `${node.name} podIds 数量`);
      for (const podId of node.podIds) {
        const pod = snapshot.pods.find((p) => p.id === podId);
        assert.notEqual(pod, undefined, `${node.name}.podIds 含不存在 Pod ${podId}`);
        assert.equal(pod.nodeId, node.id, `${podId} 归属不一致`);
      }
    }
  }

  assert.ok(checked > 0, '至少应校验到一个 Pod');
  if (VERBOSE) console.log(`  校验 Pod 帧数: ${checked}`);
});

/* ========================================================================== */
/* 7. A-5 · 故障复位后的回归                                                    */
/* ========================================================================== */

test('A-5 chaos 复位后 60 tick 内节点回到基线 ±8%', () => {
  /* 先打 20 tick 尖峰，再回稳态 60 tick */
  const frames = runSequence([
    ...Array.from({ length: 20 }, () => 'NODE_CPU_SPIKE'),
    ...Array.from({ length: 60 }, () => 'NONE'),
  ]);

  const tail = frames.slice(-10);
  const alphaTail = tail.map((snapshot) => snapshot.nodes.find((n) => n.rackIndex === engine.SPIKE_RACK_INDEX).cpuUsage);
  const mean = alphaTail.reduce((a, b) => a + b, 0) / alphaTail.length;
  const baseline = tuning.NODE_ROLE_PROFILE.compute.cpu;
  const tolerance = baseline * 0.08;

  if (VERBOSE) console.log(`  alpha 末 10 帧: ${alphaTail.join(', ')} 均值 ${mean.toFixed(1)} 基线 ${baseline}`);

  assert.ok(
    Math.abs(mean - baseline) <= tolerance,
    `复位 60 tick 后均值 ${mean.toFixed(1)} 应落在基线 ${baseline} ±8%（±${tolerance.toFixed(1)}）内`,
  );

  /* 同时确认故障期间确实到过尖峰区间（否则这条回归测试形同虚设） */
  const spikePeak = Math.max(
    ...frames.slice(0, 20).map((snapshot) => snapshot.nodes.find((n) => n.rackIndex === engine.SPIKE_RACK_INDEX).cpuUsage),
  );
  assert.ok(spikePeak >= 90, `尖峰期间 CPU 峰值 ${spikePeak} 应 ≥ 90`);
});

/* ========================================================================== */
/* 8. A-6 · 健康分单调性                                                        */
/* ========================================================================== */

test('A-6 新增 P0 告警后健康分不升（单调性）', () => {
  const snapshot = SEED;
  const base = clusterHealth.computeClusterHealthScore(snapshot.nodes, snapshot.pods, snapshot.activeAlerts);

  const alert = {
    id: 'alert-test-p0',
    timestamp: '2026-11-05T08:00:00.000Z',
    level: 'P0',
    entityId: snapshot.pods[0].id,
    entityName: snapshot.pods[0].name,
    message: '测试用 P0 告警',
  };
  const withP0 = clusterHealth.computeClusterHealthScore(snapshot.nodes, snapshot.pods, [alert]);

  assert.ok(withP0 <= base, `加入 P0 后健康分不得上升：${base} → ${withP0}`);
  assert.ok(withP0 < base, `P0 罚分应使健康分严格下降：${base} → ${withP0}`);

  /* 再叠加 P1 也必须继续不升 */
  const withP1 = clusterHealth.computeClusterHealthScore(snapshot.nodes, snapshot.pods, [
    alert,
    { ...alert, id: 'alert-test-p1', level: 'P1' },
  ]);
  assert.ok(withP1 <= withP0, `追加 P1 后健康分不得上升：${withP0} → ${withP1}`);
});

/* ========================================================================== */
/* 9. B · 属性测试（200 组 × 60 tick）                                          */
/* ========================================================================== */

test('B 属性测试：200 组随机种子 × 60 tick 全程不变量成立', () => {
  const GROUPS = 200;
  const TICKS_PER_GROUP = 60;
  const baseSeed = 20261110;
  const failures = [];

  for (let group = 0; group < GROUPS; group += 1) {
    const seed = baseSeed + group * 7919;
    const rng = mulberry32(seed);
    const scenarios = Array.from({ length: TICKS_PER_GROUP }, () => SCENARIOS[Math.floor(rng() * SCENARIOS.length)]);

    const frames = runSequence(scenarios);
    let expectedTs = SEED.timestamp;

    for (let i = 0; i < frames.length; i += 1) {
      expectedTs += TICK_MS;
      const issues = collectInvariants(frames[i], expectedTs);
      if (issues.length > 0) {
        failures.push({
          seed,
          group: group + 1,
          tick: i + 1,
          scenario: scenarios[i],
          sequence: scenarios.join(','),
          issues: issues.slice(0, 4),
        });
        break;
      }
    }
  }

  if (VERBOSE && failures.length === 0) {
    console.log(`  已跑 ${GROUPS} 组 × ${TICKS_PER_GROUP} tick，零违例`);
  }

  assert.equal(
    failures.length,
    0,
    `属性测试失败 ${failures.length} 组（复现：种子 = ${failures[0]?.seed}）:\n` +
      failures
        .slice(0, 3)
        .map(
          (f) =>
            `  组 ${f.group} 种子 ${f.seed} tick ${f.tick} 场景 ${f.scenario}\n` +
            `    序列: ${f.sequence}\n    违例: ${f.issues.join(' | ')}`,
        )
        .join('\n'),
  );
});

/* ========================================================================== */
/* 10. A-7 · schema 版本契约                                                   */
/* ========================================================================== */

test('A-7 每一帧都携带当前 schemaVersion', () => {
  const frames = runSequence(buildRotation().slice(0, 30));
  for (const snapshot of frames) {
    assert.equal(
      snapshot.schemaVersion,
      cluster.TELEMETRY_SCHEMA_VERSION,
      '所有引擎产出帧都必须带当前 schema 版本（客户端据此做版本协商）',
    );
  }
  /* 种子快照同样必须带版本（SSR 首屏与运行时同源） */
  assert.equal(cluster.INITIAL_CLUSTER_SNAPSHOT.schemaVersion, cluster.TELEMETRY_SCHEMA_VERSION);
});

/* ========================================================================== */
/* 11. B-2 · 帧环形缓冲与事故时间线                                             */
/* ========================================================================== */

test('B-2 环形缓冲保留最近 120 帧，并可从告警变化推导事故时间线', () => {
  ring.clearFrameBuffer();
  assert.equal(ring.getFrameBufferSize(), 0, '清空后缓冲应为 0');

  /* 跑 150 帧（含 OOM 段），超过容量 30 帧 */
  const scenarios = [...Array.from({ length: 100 }, () => 'NONE'), ...Array.from({ length: 50 }, () => 'POD_OOM_SWARM')];
  const frames = runSequence(scenarios);
  for (const frame of frames) ring.pushSnapshotFrame(frame);

  assert.equal(ring.getFrameBufferSize(), ring.FRAME_BUFFER_CAPACITY, '缓冲应恒等于容量 120');
  const recent = ring.getRecentFrames();
  assert.equal(recent.length, 120, '按容量读取');
  /* 最旧一帧应是被丢弃后的第 31 帧（150-120+1） */
  assert.equal(recent[0].timestamp, frames[30].timestamp, '应丢弃最旧的 30 帧');
  assert.equal(recent[recent.length - 1].timestamp, frames[frames.length - 1].timestamp, '末帧为最新帧');

  /* 时间线：OOM 期间应出现 P0 告警事件 */
  const timeline = ring.buildIncidentTimeline();
  assert.ok(timeline.length > 0, '含故障段时应产出时间线条目');
  assert.ok(
    timeline.some((entry) => entry.kind === 'alert-raised' && entry.level === 'P0'),
    '应记录到 P0 告警出现事件',
  );

  const markdown = ring.renderIncidentTimelineMarkdown();
  assert.ok(markdown.includes('| 相对时间 | 事件 | 详情 |'), 'Markdown 应包含表头');

  ring.clearFrameBuffer();
  assert.equal(ring.buildIncidentTimeline().length, 0, '清空后时间线为空');
});

/* ========================================================================== */
/* 12. R4 进阶 · X1/X2/X6 一致性断言（同一事实三处同数）                          */
/* ========================================================================== */

/**
 * X1 · 同一 Pod CPU 三处一致 + freeSlots 真复用。
 *
 * 【三处】3D = 瞬态池 podCpuFloat32[槽位]（渲染循环的真实读法）；
 *         面板 = 快照 pods[i].cpuUsage（store.snapshotSummary 的数据源）；
 *         报告 = 环形缓冲帧（复盘报告的数据源）。
 * 【反作弊】结构断言渲染器必须读瞬态池，不许把 3D 改读 HUD 值来"凑一致"；
 *           freeSlots 栈深度与复用数逐批打印，证明是真复用而非恒等式造假。
 */
test('X1 同 Pod CPU 三处一致 + freeSlots 真复用（累计 696 个不同 ID）', () => {
  ring.clearFrameBuffer();
  const t = transient.telemetryTransientRef;

  /* 结构断言：3D 渲染循环读瞬态轨（PodInstancedMesh useFrame 内） */
  const rendererSrc = readFileSync(join(ROOT, 'src/components/canvas/PodInstancedMesh.tsx'), 'utf8');
  assert.ok(
    /telemetryTransientRef\.podCpuFloat32/.test(rendererSrc),
    '3D 渲染循环必须读瞬态池 podCpuFloat32（不许改读 HUD/面板值）',
  );

  const mkPods = (ids, base) =>
    ids.map((id, i) => ({
      ...SEED.pods[i % SEED.pods.length],
      id,
      name: id,
      cpuUsage: base + (i % 17),
      memoryUsage: 30 + (i % 23),
    }));

  /* 模拟 deliver 的双轨分发（无免疫场景：reconciled === raw） */
  const deliver = (pods, seq) => {
    const frame = { ...SEED, pods, seq, timestamp: SEED.timestamp + seq * TICK_MS };
    transient.syncSnapshotToTransientRef(frame);
    ring.pushSnapshotFrame(frame);
    return frame;
  };
  const checkThreeWay = (frame) => {
    const report = ring.getRecentFrames(1)[0];
    for (const pod of frame.pods) {
      const slot = transient.getPodSlotIndex(pod.id);
      assert.ok(slot >= 0 && slot < transient.MAX_PODS, `${pod.id} 必须有合法槽位`);
      const gl = t.podCpuFloat32[slot];
      const rep = report.pods.find((p) => p.id === pod.id);
      assert.ok(rep !== undefined, `${pod.id} 必须在报告帧中`);
      assert.equal(gl, pod.cpuUsage, `${pod.id} 3D≠面板`);
      assert.equal(rep.cpuUsage, pod.cpuUsage, `${pod.id} 报告≠面板`);
    }
  };

  /* 批 A 48 个 ID 占满 → 批 B 48 个全新 ID（累计 96）必须全复用 */
  const idsA = Array.from({ length: 48 }, (_, i) => `pod-xA-${i}`);
  checkThreeWay(deliver(mkPods(idsA, 40), 1));
  const slotsA = idsA.map((id) => transient.getPodSlotIndex(id));
  console.log(`    [freeSlots] 批A 48 占满：栈深 ${t.podFreeSlots.length}，高水位 ${Math.max(...slotsA) + 1}`);

  const idsB = Array.from({ length: 48 }, (_, i) => `pod-xB-${i}`);
  checkThreeWay(deliver(mkPods(idsB, 60), 2));
  const slotsB = idsB.map((id) => transient.getPodSlotIndex(id));
  const reused = slotsB.filter((s) => slotsA.includes(s)).length;
  console.log(`    [freeSlots] 批B 复用：${reused}/48 槽位来自批A回收，栈深 ${t.podFreeSlots.length}`);
  assert.equal(reused, 48, '整批换血必须 100% 复用回收槽位');

  /* 20 轮 churn × 30 个全新 ID（累计 96+600=696 个不同 ID） */
  const distinct = new Set([...idsA, ...idsB]);
  for (let round = 0; round < 20; round += 1) {
    const ids = Array.from({ length: 30 }, (_, i) => {
      const id = `pod-xC-${round}-${i}`;
      distinct.add(id);
      return id;
    });
    checkThreeWay(deliver(mkPods(ids, 20 + round), 3 + round));
  }
  console.log(`    [freeSlots] 累计不同 ID ${distinct.size}（>48），终态占用 ${t.podSlotById.size}，栈深 ${t.podFreeSlots.length}`);
  assert.ok(distinct.size > 48);
  assert.ok(t.podSlotById.size <= transient.MAX_PODS);

  ring.clearFrameBuffer();
});

/**
 * X2 · 三处健康分相等且无地板/天花板。
 *
 * 【反作弊】独立罚分表 oracle 逐帧重算比对；构造满载故障证明分数能低于 50
 * （旧 live 下限 50 会托住），健康态精确 100（不依赖 96 地板）。
 */
test('X2 健康分 == 唯一罚分模型（300 帧逐帧重算，无地板/天花板）', () => {
  const frames = runSequence(buildRotation());
  for (const f of frames) {
    const oracle = clusterHealth.computeClusterHealthScore(f.nodes, f.pods, f.activeAlerts);
    assert.equal(f.clusterHealthScore, oracle, '引擎帧健康分必须等于罚分模型');
    assert.equal(clusterHealth.computeHealthScore(f), oracle, '快照级入口必须同值');
  }

  /* 无 50 地板：满载故障（3 节点分区 + 24 Pod OOM + 10 条 P0）→ 罚 195 → 0 */
  const worst = {
    ...SEED,
    nodes: SEED.nodes.map((n) => ({ ...n, status: 'NetworkPartition' })),
    pods: SEED.pods.map((p) => ({ ...p, status: 'OOMKilled' })),
    activeAlerts: Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`,
      timestamp: '',
      level: 'P0',
      entityId: 'x',
      entityName: 'x',
      message: '',
    })),
  };
  const worstScore = clusterHealth.computeHealthScore(worst);
  assert.equal(worstScore, 0, '满载故障应罚到 0（任何地板都会托住它）');

  /* 无 96 地板依赖：健康态精确 100；轻故障（1 条 P1）= 98.5 → 99，不是 96+ */
  const healthy = { ...SEED, activeAlerts: [] };
  assert.equal(clusterHealth.computeHealthScore(healthy), 100);
  const mild = {
    ...SEED,
    activeAlerts: [{ id: 'm', timestamp: '', level: 'P1', entityId: 'x', entityName: 'x', message: '' }],
  };
  assert.equal(clusterHealth.computeHealthScore(mild), 99);

  console.log(`    [X2] 300 帧全等于 oracle；满载故障=${worstScore}（无 50 地板）；轻故障=99（无 96 地板）；健康=100`);
});

/**
 * X6 · seq 去重 + 时间戳单调修正（客户端时钟快 5 分钟不跳未来）。
 *
 * 【反作弊】模拟 100 帧重复攻击断言零漂移；guardFrameTimestamp 源码禁用 Date.now；
 * 修正量恒为 +1 tick，与客户端墙钟无关。
 */
test('X6 seq 去重 + 时间戳服务端为准（时钟 +5min 不跳未来）', () => {
  /* seq 链：300 tick 严格 +1 */
  const frames = runSequence(buildRotation());
  let prev = SEED.seq;
  for (const f of frames) {
    assert.equal(f.seq, prev + 1, '引擎 seq 必须严格 +1');
    prev = f.seq;
  }

  /* 去重判定契约 */
  assert.equal(timeline.isDuplicateSeq(5, 5), true, '相等 seq 是重复');
  assert.equal(timeline.isDuplicateSeq(4, 5), true, '回退 seq 是重复');
  assert.equal(timeline.isDuplicateSeq(6, 5), false, '前进 seq 接受');
  assert.equal(timeline.isDuplicateSeq(0, -1), false, '新连接首帧（复位 -1）接受');

  /* 100 帧重复攻击：全丢弃，时间轴零漂移 */
  let lastSeq = 10;
  let knownTs = SEED.timestamp + 10 * TICK_MS;
  const originTs = knownTs;
  let dropped = 0;
  for (let i = 0; i < 100; i += 1) {
    const dupSeq = 10;
    if (timeline.isDuplicateSeq(dupSeq, lastSeq)) {
      dropped += 1;
      continue;
    }
    lastSeq = dupSeq;
    knownTs = timeline.guardFrameTimestamp(knownTs, knownTs, TICK_MS);
  }
  assert.equal(dropped, 100, '重复帧必须全部丢弃');
  assert.equal(knownTs, originTs, '重复帧不得推动时间轴（旧实现每帧 +1000 漂移）');

  /* 客户端时钟快 5 分钟：乱序帧修正只 +1 tick，绝不采用客户端墙钟 */
  const serverTs = SEED.timestamp + 20 * TICK_MS;
  const clientNowFast = serverTs + 5 * 60 * 1000;
  const guarded = timeline.guardFrameTimestamp(serverTs - TICK_MS, serverTs, TICK_MS);
  assert.equal(guarded, serverTs + TICK_MS, '修正量恒为 +1 tick');
  assert.ok(guarded < clientNowFast, '不得跳到客户端未来时刻');
  const src = readFileSync(join(ROOT, 'src/utils/frameTimeline.ts'), 'utf8');
  /* 只检查代码本体（JSDoc 里提及 Date.now 是说明文字，不算引用） */
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/Date\.now/.test(codeOnly), '时间轴纯函数禁止引用客户端墙钟');

  console.log(`    [X6] 300 帧 seq 严格 +1；100/100 重复帧丢弃零漂移；时钟 +5min 修正仅 +1 tick（${guarded} < 客户端 ${clientNowFast}）`);
});

/* ========================================================================== */
/* 13. 收尾：清理转译产物                                                       */
/* ========================================================================== */

process.on('exit', () => {
  try {
    rmSync(OUT_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
});