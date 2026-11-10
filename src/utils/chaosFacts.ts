/**
 * KubeVision AI — 混沌事实的跨端纯函数层（Chaos Facts）
 *
 * 【为什么与 chaosTargets.ts 分开】`chaosTargets.ts` 依赖
 * `@/types/cluster` 的 **值**（`INITIAL_CLUSTER_SNAPSHOT`，用于反查节点 ID），
 * 那是一个几 KB 的快照对象。服务端 `app/api/chat/route.ts` 只需要
 * "哪种故障该用哪种自愈动作"这一条规则，若直接 import `chaosTargets`，
 * 整份前端快照字典会被打进服务端 bundle——既浪费又制造无谓耦合。
 *
 * 【本文件的纪律】
 * - 只依赖 **类型**（`import type`，编译后完全消失）；
 * - 不 import React / zustand / three / 任何浏览器 API；
 * - 只放常量与纯函数，可被 Node 与浏览器同时加载。
 *
 * 【事实来源】动作映射必须与 `utils/chaosTargets.ts` 的
 * `CHAOS_TARGETS[*].remediationAction` 一致。两处的**唯一真相**是这里的
 * `CHAOS_REMEDIATION_ACTION`；`chaosTargets.ts` 引用它来填充映射表，
 * 从而避免第三次出现"两处各写一份"的漂移。
 */

import type { ChaosScenario } from '@/types/cluster';

/** 除 'NONE' 外的混沌场景 */
export type ActiveChaosScenario = Exclude<ChaosScenario, 'NONE'>;

/** 自愈动作类型（开放口径，与 store 的 remediationDiff.actionType 一致） */
export type ChaosRemediationAction = 'restart_pod' | 'scale_deployment' | 'drain_node';

/**
 * CHAOS_REMEDIATION_ACTION —— 混沌场景 → 应执行的自愈动作。
 *
 * 【取值依据（按代价从低到高选择）】
 * - `POD_OOM_SWARM`   → `restart_pod`：内存溢出是单 Pod 问题，重启代价最小；
 * - `NODE_CPU_SPIKE`  → `scale_deployment`：CPU 尖刺靠扩容分摊，迁移负载反而放大抖动；
 * - `NET_PACKET_LOSS` → `drain_node`：网络分区下该节点已不可信，必须把负载迁走。
 *
 * 【自愈 drain_node 滥用】旧实现把 drain_node 当默认兜底，于是"集群健康 100"
 * 和"OOM 内存溢出"都可能弹出一张红色驱逐卡——代价最大的动作被用在了
 * 最不需要它的场景上。
 */
export const CHAOS_REMEDIATION_ACTION = {
  POD_OOM_SWARM: 'restart_pod',
  NODE_CPU_SPIKE: 'scale_deployment',
  NET_PACKET_LOSS: 'drain_node',
} as const satisfies Readonly<Record<ActiveChaosScenario, ChaosRemediationAction>>;

/**
 * isActionAllowedForPod —— Pod 粒度自愈的动作白名单。
 *
 * 【为何需要】`drain_node` 语义是"驱逐整个节点"，作用在单个 Pod 上毫无意义：
 * 它既不重启容器，也不改善 Pod 状态，却会让 MCP 回执看起来"执行成功"。
 * 必须被拦下。
 *
 * @param action 待校验动作
 * @returns 该动作能否作用于 Pod
 */
export function isActionAllowedForPod(action: ChaosRemediationAction): boolean {
  return action === 'restart_pod' || action === 'scale_deployment';
}

/**
 * resolvePodAction —— 把场景动作收敛为"一定能作用于 Pod"的动作。
 *
 * 【为什么不直接抛错】路演是不可中断的时间轴：阶段 4 若因动作非法而抛错，
 * 整场演示会卡在 3/4。更稳妥的做法是降级到语义最温和的 `restart_pod`
 * （重启容器），并让调用方在日志里记下"发生了降级"，保持可追溯。
 *
 * @param scenario 混沌场景
 * @returns 可安全作用于 Pod 的动作
 */
export function resolvePodAction(scenario: ActiveChaosScenario): ChaosRemediationAction {
  const action = CHAOS_REMEDIATION_ACTION[scenario];
  return isActionAllowedForPod(action) ? action : 'restart_pod';
}

/**
 * pickRemediationActionType —— 兼容既有调用签名（服务端 chat 路由使用）。
 *
 * 【与 resolvePodAction 的区别】本函数保留了"无演练上下文"的分支：
 * 当 `chaos === 'NONE'` 时按节点自身状态推断，这是 chat 路由的历史语义，
 * 与路演无关，故不合并。
 *
 * @param chaos        当前混沌场景
 * @param targetIsNode 目标是否为节点级
 * @param nodeStatus   节点状态（目标为节点时提供）
 * @returns 动作类型
 */
export function pickRemediationActionType(
  chaos: ChaosScenario,
  targetIsNode: boolean,
  nodeStatus: string | null,
): ChaosRemediationAction {
  if (chaos === 'POD_OOM_SWARM') return CHAOS_REMEDIATION_ACTION.POD_OOM_SWARM;
  if (chaos === 'NODE_CPU_SPIKE') return CHAOS_REMEDIATION_ACTION.NODE_CPU_SPIKE;
  if (chaos === 'NET_PACKET_LOSS') return CHAOS_REMEDIATION_ACTION.NET_PACKET_LOSS;

  if (targetIsNode) {
    /* 无演练上下文时按节点自身状态判断：只有网络分区才值得迁移 */
    return nodeStatus === 'NetworkPartition' ? 'drain_node' : 'scale_deployment';
  }
  return 'restart_pod';
}
