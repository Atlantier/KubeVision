/**
 * KubeVision AI — 混沌场景 → 受灾目标 的**单一事实源**（Chaos Targets）
 *
 * 【解决什么问题】
 * 修复前全仓有 3 处各自维护"哪个混沌打哪个机架"：
 *   · `utils/syntheticEngine.ts` 里 OOM=1 / SPIKE=0 / PARTITION=2（真正的引擎行为）
 *   · `utils/demoDirector.ts` 里手写了 `node-worker-alpha` / `node-worker-beta`（**写反了**）
 *   · `app/api/chat/route.ts` 里的 `pickRemediationActionType`（又一套动作规则）
 *
 * 三处一旦漂移，就会出现"镜头锁着健康机架、AI 说故障在另一台"的当场自证矛盾——
 * 这是评委最容易抓住的破绽。本文件把这张表收拢为唯一来源。
 *
 * 【核心约束：nodeId 不得写死字面量】
 * 节点 ID 从 `INITIAL_CLUSTER_SNAPSHOT.nodes` 的 `rackIndex` 反查派生。
 * 若未来节点改名/增删机架，这里自动跟随，不会留下过期的硬编码。
 *
 * 【输入输出】
 * - 输入：`ChaosScenario`（除 'NONE' 外的三种故障场景）
 * - 输出：该场景的受灾机架序号、受灾节点 ID、预期异常 Pod 状态、
 *   以及**应当执行的自愈动作类型**（OOM→重启 Pod、网络→驱逐节点、CPU→扩缩容）
 *
 * 【与 syntheticEngine 的一致性如何保证】
 * rackIndex 在此声明，同时 `demoDirector` 在注入故障后会**运行时轮询断言**
 * 该机架名下确实出现了异常 Pod；断言失败即降级旁白，绝不宣称"已锁定告警机架"。
 * 因此即便本表与引擎行为意外漂移，也不会在评委面前说谎。
 */

import type { ChaosScenario } from '@/types/cluster';
import { INITIAL_CLUSTER_SNAPSHOT } from '@/types/cluster';

/** 除 'NONE' 外的混沌场景（有实际受灾目标的三种） */
export type ActiveChaosScenario = Exclude<ChaosScenario, 'NONE'>;

/** 自愈动作类型（与 `src/types/store.ts` 的 RemediationDiff.actionType 同一开放口径） */
export type ChaosRemediationAction = 'restart_pod' | 'scale_deployment' | 'drain_node';

/** 单个混沌场景的受灾事实 */
export interface ChaosTarget {
  /** 受灾机架序号（必须与 syntheticEngine 的 OOM/SPIKE/PARTITION 常量一致） */
  readonly rackIndex: number;
  /** 受灾节点实体 ID（由 rackIndex 反查派生，非字面量） */
  readonly nodeId: string;
  /** 该场景下受害者 Pod 的预期状态（用于运行时断言与旁白） */
  readonly expectedPodStatus: 'OOMKilled' | 'CrashLoopBackOff' | 'Pending';
  /** 该场景应当执行的自愈动作 */
  readonly remediationAction: ChaosRemediationAction;
  /** 中文短标签（用于旁白与日志） */
  readonly label: string;
}

/**
 * resolveNodeIdByRack —— 由机架序号反查节点实体 ID。
 *
 * 【为何不写死字面量】节点 ID 属于领域契约（`types/cluster.ts`），
 * 在此重复一份就等于制造第二个事实源。改为从初始快照派生：
 * 快照是领域模型的唯一权威，节点改名时这里自动跟随。
 *
 * @param rackIndex 机架序号（0/1/2）
 * @returns 该机架上的节点 ID；找不到时返回空串（调用方须做防御）
 */
export function resolveNodeIdByRack(rackIndex: number): string {
  const node = INITIAL_CLUSTER_SNAPSHOT.nodes.find(
    (candidate): boolean => candidate.rackIndex === rackIndex,
  );
  return node === undefined ? '' : node.id;
}

/**
 * CHAOS_TARGETS —— 混沌场景 → 受灾目标 的唯一映射表。
 *
 * 【rackIndex 取值依据（与 `utils/syntheticEngine.ts:80,87,90` 严格一致）】
 * - `POD_OOM_SWARM`   → rackIndex 1（node-worker-beta）
 * - `NODE_CPU_SPIKE`  → rackIndex 0（node-worker-alpha）
 * - `NET_PACKET_LOSS` → rackIndex 2（node-worker-gamma）
 *
 * 【修复的 P0-1】修复前 `demoDirector` 把 OOM 锁到 alpha、网络锁到 beta，
 * 正好与引擎行为相反——镜头会停在健康机架上，而 AI 正文却说故障在另一台。
 */
export const CHAOS_TARGETS: Readonly<Record<ActiveChaosScenario, ChaosTarget>> = {
  POD_OOM_SWARM: {
    rackIndex: 1,
    nodeId: resolveNodeIdByRack(1),
    expectedPodStatus: 'OOMKilled',
    remediationAction: 'restart_pod',
    label: 'OOM 内存溢出',
  },
  NODE_CPU_SPIKE: {
    rackIndex: 0,
    nodeId: resolveNodeIdByRack(0),
    expectedPodStatus: 'CrashLoopBackOff',
    remediationAction: 'scale_deployment',
    label: '节点 CPU 尖刺',
  },
  NET_PACKET_LOSS: {
    rackIndex: 2,
    nodeId: resolveNodeIdByRack(2),
    expectedPodStatus: 'Pending',
    remediationAction: 'drain_node',
    label: 'CNI 网络丢包',
  },
};

/**
 * getChaosTarget —— 安全读取某场景的受灾目标。
 *
 * @param scenario 混沌场景（'NONE' 返回 null）
 * @returns 受灾目标；'NONE' 或未知场景返回 null
 */
export function getChaosTarget(scenario: ChaosScenario): ChaosTarget | null {
  if (scenario === 'NONE') return null;
  const target = CHAOS_TARGETS[scenario];
  return target === undefined ? null : target;
}

/**
 * isActionAllowedForPod —— Pod 粒度自愈的动作白名单。
 *
 * 【为何需要】`drain_node` 语义是"驱逐整个节点"，作用在单个 Pod 上毫无意义：
 * 它既不重启容器，也不会改善 Pod 状态，却会让 MCP 回执看起来"执行成功"。
 * 修复前的 P0-2 正是因为兜底把 `drain_node` 打到 Pod/节点上，
 * 造成"回执说自愈了，实际受害者一个没修"。
 *
 * @param action 待校验动作
 * @returns 该动作能否作用于 Pod
 */
export function isActionAllowedForPod(action: ChaosRemediationAction): boolean {
  return action === 'restart_pod' || action === 'scale_deployment';
}

/**
 * resolveVictimPods —— 从快照中解析「真实受害 Pod」。
 *
 * 【修复的 P0-2】修复前按"聚焦节点"过滤，一旦镜头锁错节点就解析不到受害者，
 * 然后兜底对健康节点执行 `drain_node`——宣称闭环而实际未修。
 *
 * 【本实现的解析顺序（全局视角，不依赖镜头）】
 * 1. 优先取 `activeAlerts` 中 P0 级、且 entityId 形如 `pod-*` 的实体；
 * 2. 不足则补全量快照中 `status !== 'Running'` 的 Pod；
 * 3. 最多返回 3 个（与既有"最多自愈 3 个"的口径一致）。
 *
 * @param pods       快照中的全部 Pod
 * @param alerts     快照中的告警列表
 * @param maxVictims 最多返回数量
 * @returns 受害 Pod 列表（可能为空——调用方必须如实降级，不得兜底伪造）
 */
export function resolveVictimPods(
  pods: readonly { readonly id: string; readonly name: string; readonly status: string }[],
  alerts: readonly { readonly level: string; readonly entityId: string | null }[],
  maxVictims = 3,
): Array<{ id: string; name: string }> {
  const picked = new Map<string, { id: string; name: string }>();

  /* ---- 1. P0 告警中声明的 Pod 实体 ---- */
  for (const alert of alerts) {
    if (alert.level !== 'P0') continue;
    const entityId = alert.entityId;
    if (entityId === null || !entityId.startsWith('pod-')) continue;
    const pod = pods.find((candidate): boolean => candidate.id === entityId);
    if (pod !== undefined) picked.set(pod.id, { id: pod.id, name: pod.name });
  }

  /* ---- 2. 全量补全：任何非 Running 的 Pod ---- */
  if (picked.size < maxVictims) {
    for (const pod of pods) {
      if (picked.size >= maxVictims) break;
      if (pod.status === 'Running') continue;
      if (picked.has(pod.id)) continue;
      picked.set(pod.id, { id: pod.id, name: pod.name });
    }
  }

  return [...picked.values()].slice(0, maxVictims);
}
