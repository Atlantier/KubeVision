#!/usr/bin/env node
/**
 * KubeVision AI — 瞬态槽位复用单测（R4 · P0-1 回归）
 *
 * 【证明什么】
 * 1. 累计 48+ 个不同 Pod ID 后，新 Pod 仍能分到槽位并写入真实水位
 *    （旧实现只增不复用 + 耗尽 break，第 49 个 ID 起恒 0%）；
 * 2. 回收即入栈、分配先取栈（LIFO），槽位总量恒 ≤ MAX_PODS；
 * 3. 容量耗尽用 continue：超出部分跳过但返回 truncated=false 标志，
 *    容量内的 Pod 全部着色，绝不越界写入。
 *
 * 【实现方式】与 verify-telemetry 同款：typescript 单文件转译 + 别名改写，
 * 不依赖浏览器/dev server，确定性可复现。
 *
 * 【用法】node --test tests/telemetrySlots.test.mjs
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'tmp-slots');

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
process.on('exit', () => {
  try {
    if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  } catch {
    // 忽略进程退出阶段的临时目录清理异常
  }
});

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

function rewriteAliases(code) {
  return code
    .replace(/require\("@\/types\/cluster"\)/g, 'require("./cluster.cjs")')
    .replace(/require\('@\/types\/cluster'\)/g, "require('./cluster.cjs')");
}

transpile('src/types/cluster.ts', 'cluster', rewriteAliases);
transpile('src/store/useTelemetryRef.ts', 'useTelemetryRef', rewriteAliases);

const cluster = require(join(OUT_DIR, 'cluster.cjs'));
const ref = require(join(OUT_DIR, 'useTelemetryRef.cjs'));

const SEED = cluster.INITIAL_CLUSTER_SNAPSHOT;
const MAX_PODS = ref.MAX_PODS;

/** 用种子 Pod 模板克隆一批指定 ID / 水位的 Pod（其余字段保持合法契约） */
function makePods(ids, cpuBase) {
  return ids.map((id, i) => {
    const template = SEED.pods[i % SEED.pods.length];
    return {
      ...template,
      id,
      name: `churn-${id}`,
      cpuUsage: cpuBase + (i % 17),
      memoryUsage: 30 + (i % 23),
    };
  });
}

function makeSnapshot(pods) {
  return { ...SEED, pods, timestamp: SEED.timestamp + 1000, seq: 1 };
}

/** 读取某 Pod 当前槽位上的 CPU 目标值（读方唯一入口 getPodSlotIndex） */
function slotCpu(podId) {
  const slot = ref.getPodSlotIndex(podId);
  if (slot < 0) return null;
  return ref.telemetryTransientRef.podCpuFloat32[slot];
}

test('S-1 种子 24 Pod 全部有着色槽位', () => {
  ref.syncSnapshotToTransientRef(SEED);
  for (const pod of SEED.pods) {
    const slot = ref.getPodSlotIndex(pod.id);
    assert.ok(slot >= 0 && slot < MAX_PODS, `${pod.id} 应有合法槽位`);
    assert.equal(ref.telemetryTransientRef.podCpuFloat32[slot], pod.cpuUsage);
  }
});

test('S-2 累计 96 个不同 ID（两批 48）后新 Pod 仍有着色——freeSlots 真复用', () => {
  const batchA = makePods(Array.from({ length: MAX_PODS }, (_, i) => `pod-A-${i}`), 40);
  const okA = ref.syncSnapshotToTransientRef(makeSnapshot(batchA));
  assert.equal(okA, true, '第一批 48 个应全部同步成功');
  const slotsA = new Set(batchA.map((p) => ref.getPodSlotIndex(p.id)));
  assert.equal(slotsA.size, MAX_PODS, '48 个 Pod 应占满 48 个互异槽位');

  /* 第二批：48 个全新 ID（累计 96 个不同 ID，远超容量） */
  const batchB = makePods(Array.from({ length: MAX_PODS }, (_, i) => `pod-B-${i}`), 60);
  const okB = ref.syncSnapshotToTransientRef(makeSnapshot(batchB));
  assert.equal(okB, true, '第二批 48 个新 ID 必须全部同步成功（复用回收槽位）');

  const slotsB = new Set(batchB.map((p) => ref.getPodSlotIndex(p.id)));
  assert.equal(slotsB.size, MAX_PODS, '新 Pod 应占满 48 个互异槽位');
  for (const pod of batchB) {
    const slot = ref.getPodSlotIndex(pod.id);
    assert.ok(slot >= 0, `${pod.id} 必须分到槽位（旧实现此处恒 -1）`);
    assert.equal(ref.telemetryTransientRef.podCpuFloat32[slot], pod.cpuUsage);
    assert.ok(pod.cpuUsage > 0, '着色值必须非 0');
  }
  /* 复用证据：两批占用的是同一组物理槽位 */
  assert.deepEqual([...slotsB].sort((a, b) => a - b), [...slotsA].sort((a, b) => a - b));
  assert.equal(ref.telemetryTransientRef.podFreeSlots.length, 0, '满员时空闲栈应为空');
  /* 旧 ID 的槽位已回收清零（防幽灵） */
  for (const pod of batchA) assert.equal(ref.getPodSlotIndex(pod.id), -1);
});

test('S-3 容量耗尽：continue 而非 break，truncated 标志上报', () => {
  const ids = Array.from({ length: MAX_PODS + 12 }, (_, i) => `pod-over-${i}`);
  const pods = makePods(ids, 50);
  const ok = ref.syncSnapshotToTransientRef(makeSnapshot(pods));
  assert.equal(ok, false, '超出容量必须返回 false（truncated 上报）');
  /* 容量内的 Pod 全部着色（旧实现 break 后后续 Pod 全丢） */
  for (let i = 0; i < MAX_PODS; i += 1) {
    const slot = ref.getPodSlotIndex(pods[i].id);
    assert.ok(slot >= 0 && slot < MAX_PODS, `第 ${i} 个 Pod 应有槽位`);
    assert.equal(ref.telemetryTransientRef.podCpuFloat32[slot], pods[i].cpuUsage);
  }
  for (let i = MAX_PODS; i < pods.length; i += 1) {
    assert.equal(ref.getPodSlotIndex(pods[i].id), -1, '超出部分不分配槽位');
  }
  assert.equal(ref.telemetryTransientRef.podSlotById.size, MAX_PODS, '槽位表不得越界膨胀');
});

test('S-4 回收即入栈、分配先取栈（LIFO 身份复用）', () => {
  const base = makePods(['pod-x-0', 'pod-x-1', 'pod-x-2'], 20);
  ref.syncSnapshotToTransientRef(makeSnapshot(base));
  const slotOfX1 = ref.getPodSlotIndex('pod-x-1');

  /* 移除 x-1 → 其槽位入栈 */
  ref.syncSnapshotToTransientRef(makeSnapshot([base[0], base[2]]));
  assert.equal(ref.getPodSlotIndex('pod-x-1'), -1);
  assert.ok(ref.telemetryTransientRef.podFreeSlots.includes(slotOfX1), '回收槽位必须入栈');
  assert.equal(ref.telemetryTransientRef.podCpuFloat32[slotOfX1], 0, '回收槽位必须清零');

  /* 新 Pod y → 优先弹栈复用 x-1 的槽位 */
  const newcomer = makePods(['pod-y-new'], 77)[0];
  ref.syncSnapshotToTransientRef(makeSnapshot([base[0], base[2], newcomer]));
  assert.equal(ref.getPodSlotIndex('pod-y-new'), slotOfX1, '新 Pod 应复用刚回收的槽位');
  assert.equal(slotCpu('pod-y-new'), 77);
});

test('S-5 200 轮随机churn：槽位恒 ≤48、无重复、水位逐 Pod 一致', () => {
  const pool = Array.from({ length: 100 }, (_, i) => `pod-churn-${i}`);
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let round = 0; round < 200; round += 1) {
    const count = 1 + Math.floor(rand() * MAX_PODS);
    const chosen = new Set();
    while (chosen.size < count) chosen.add(pool[Math.floor(rand() * pool.length)]);
    const pods = makePods([...chosen], 10 + (round % 60));
    const ok = ref.syncSnapshotToTransientRef(makeSnapshot(pods));
    assert.equal(ok, true, `第 ${round} 轮（${count} Pod）不应截断`);

    const used = new Set();
    for (const pod of pods) {
      const slot = ref.getPodSlotIndex(pod.id);
      assert.ok(slot >= 0 && slot < MAX_PODS, `第 ${round} 轮 ${pod.id} 槽位合法`);
      assert.ok(!used.has(slot), `第 ${round} 轮槽位 ${slot} 不得被两个 Pod 共用`);
      used.add(slot);
      assert.equal(ref.telemetryTransientRef.podCpuFloat32[slot], pod.cpuUsage);
      assert.equal(ref.telemetryTransientRef.podMemFloat32[slot], pod.memoryUsage);
    }
    assert.ok(ref.telemetryTransientRef.podSlotById.size <= MAX_PODS);
  }
});

test('S-6 NaN 防御仍生效（不污染插值）', () => {
  const pods = makePods(['pod-nan'], 30);
  pods[0] = { ...pods[0], cpuUsage: Number.NaN, memoryUsage: Number.NaN };
  ref.syncSnapshotToTransientRef(makeSnapshot(pods));
  const slot = ref.getPodSlotIndex('pod-nan');
  assert.equal(ref.telemetryTransientRef.podCpuFloat32[slot], 0);
  assert.equal(ref.telemetryTransientRef.podMemFloat32[slot], 0);
});