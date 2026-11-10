/**
 * KubeVision AI — 集群健康分单测（R52 · B3）
 *
 * 【覆盖的核心不变量】P0 告警**必不升分**：新增 P0 只会让分数下降或不变，
 * 任何实现都不能出现"越告警越健康"的反向结果。同时验证空输入满分、
 * 多罚分钳制到 [0,100]。
 *
 * 【运行】pnpm test:health → node --test tests/clusterHealth.test.mjs
 * Node 24 原生类型剥离可直接 import .ts（clusterHealth.ts 只有 import type，
 * 运行时无外部依赖）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { HEALTH_SCORE_MAX, computeClusterHealthScore } from '../src/utils/clusterHealth.ts';

/** 告警样本工厂 */
function alert(level) {
  return {
    id: `alert-${level}`,
    timestamp: '2026-11-10T00:00:00.000Z',
    level,
    entityId: 'pod-a',
    entityName: 'pod-a',
    message: 'test',
    suggestion: 'test',
  };
}

test('空集群 = 满分 100', () => {
  assert.equal(computeClusterHealthScore([], [], []), HEALTH_SCORE_MAX);
});

test('一条 P0 扣 3 分且必不升分', () => {
  const base = computeClusterHealthScore([], [], []);
  const withP0 = computeClusterHealthScore([], [], [alert('P0')]);
  assert.equal(withP0, 97);
  assert.ok(withP0 < base, 'P0 告警后健康分必须严格下降');
});

test('追加 P0 只会让分数单调不增', () => {
  const nodes = [{ id: 'n1', name: 'n1', status: 'HighLoad' }];
  const pods = [{ id: 'p1', name: 'p1', status: 'CrashLoopBackOff' }];
  const before = computeClusterHealthScore(nodes, pods, []);
  const after = computeClusterHealthScore(nodes, pods, [alert('P0')]);
  assert.ok(after <= before, `追加 P0 后不得升分: before=${before} after=${after}`);
  assert.equal(before, 90); // 100 - HighLoad 6 - CrashLoop 4
  assert.equal(after, 87);
});

test('多罚分钳制在 [0, 100]', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, name: `n${i}`, status: 'NetworkPartition' }));
  const pods = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, status: 'OOMKilled' }));
  const alerts = Array.from({ length: 10 }, (_, i) => alert('P0'));
  const score = computeClusterHealthScore(nodes, pods, alerts);
  assert.equal(score, 0);
  assert.ok(score >= 0 && score <= HEALTH_SCORE_MAX);
});