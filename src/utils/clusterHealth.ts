import type { AlertEvent, PodEntity, WorkerNodeEntity } from '@/types/cluster';

/**
 * KubeVision AI — 集群健康分唯一实现（R52 · B3 收敛）
 *
 * 【为什么必须唯一】历史上有两份实现：`useClusterStore` 的自愈闭环与
 * `syntheticEngine` 的遥测推进各写一遍。罚分表虽然相同，但任何一侧改权重
 * 都会让「引擎算出的分」与「自愈后托底的分」打架，用户会看到健康分跳变。
 * 这里收敛为一份纯函数，两侧只做调用。
 *
 * 【满分扣减模型（已锁定）】
 * - 节点：Ready 0 / HighLoad −6 / NetworkPartition −15
 * - Pod ：Running 0 / Pending −0.5 / Terminating −0.5 / CrashLoopBackOff −4 / OOMKilled −5
 * - 告警：P0 −3 / P1 −1.5 / P2（其它） −0.5
 * - 结果四舍五入并 clamp 到 [0, 100]
 *
 * 【不变量】任何输入下返回值 ∈ [0,100]；新增 P0 告警只会让分数**下降或不变**，
 * 绝不可能上升（单测断言，见 tests/clusterHealth.test.mjs）。
 */
export const HEALTH_SCORE_MAX = 100;

/** 把任意数值收敛到闭区间 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * computeClusterHealthScore —— 集群综合健康分（满分扣减）。
 *
 * @param nodes 节点实体
 * @param pods  Pod 实体
 * @param alerts 当前活跃告警
 * @returns 0~100 的整数健康分
 */
export function computeClusterHealthScore(
  nodes: readonly WorkerNodeEntity[],
  pods: readonly PodEntity[],
  alerts: readonly AlertEvent[],
): number {
  let penalty = 0;

  for (const node of nodes) {
    if (node.status === 'NetworkPartition') penalty += 15;
    else if (node.status === 'HighLoad') penalty += 6;
  }

  for (const pod of pods) {
    switch (pod.status) {
      case 'OOMKilled':
        penalty += 5;
        break;
      case 'CrashLoopBackOff':
        penalty += 4;
        break;
      case 'Pending':
      case 'Terminating':
        penalty += 0.5;
        break;
      case 'Running':
        break;
    }
  }

  for (const alert of alerts) {
    if (alert.level === 'P0') penalty += 3;
    else if (alert.level === 'P1') penalty += 1.5;
    else penalty += 0.5;
  }

  return Math.round(clamp(HEALTH_SCORE_MAX - penalty, 0, HEALTH_SCORE_MAX));
}