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
 * 【与 syntheticEngine 的一致性如何保证（三层）】
 * 1. **同源**：rackIndex 不在本文件写常量，直接 import `syntheticEngine` 导出的
 *    `OOM_RACK_INDEX` / `SPIKE_RACK_INDEX` / `PARTITION_RACK_INDEX`。
 *    两处各写一份字面量正是 P0-1（镜头锁错机架）的成因，物理上消除之。
 * 2. **派生**：nodeId 由 rackIndex 反查 `INITIAL_CLUSTER_SNAPSHOT.nodes` 得出，
 *    不出现 'node-worker-alpha' 之类字面量。
 * 3. **运行期断言**：demoDirector 注入后轮询快照，确认该机架名下真的出现异常 Pod；
 *    断言失败即降级旁白，绝不宣称"已锁定告警机架"。
 */

import type { ChaosScenario, TelemetrySnapshot } from '@/types/cluster';
import { INITIAL_CLUSTER_SNAPSHOT } from '@/types/cluster';
import {
  OOM_RACK_INDEX,
  PARTITION_RACK_INDEX,
  SPIKE_RACK_INDEX,
} from '@/utils/syntheticEngine';
import {
  CHAOS_REMEDIATION_ACTION,
  type ActiveChaosScenario,
  type ChaosRemediationAction,
} from '@/utils/chaosFacts';

/*
 * 【类型单一来源】ActiveChaosScenario / ChaosRemediationAction 定义在
 * `utils/chaosFacts.ts`（跨端纯函数层），此处再导出是为了保持
 * "chaos 域类型统一从 @/utils/chaosTargets 取用"的既有消费习惯。
 */
export type { ActiveChaosScenario, ChaosRemediationAction };

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
    rackIndex: OOM_RACK_INDEX,
    nodeId: resolveNodeIdByRack(OOM_RACK_INDEX),
    expectedPodStatus: 'OOMKilled',
    remediationAction: CHAOS_REMEDIATION_ACTION.POD_OOM_SWARM,
    label: 'OOM 内存溢出',
  },
  NODE_CPU_SPIKE: {
    rackIndex: SPIKE_RACK_INDEX,
    nodeId: resolveNodeIdByRack(SPIKE_RACK_INDEX),
    expectedPodStatus: 'CrashLoopBackOff',
    remediationAction: CHAOS_REMEDIATION_ACTION.NODE_CPU_SPIKE,
    label: '节点 CPU 尖刺',
  },
  NET_PACKET_LOSS: {
    rackIndex: PARTITION_RACK_INDEX,
    nodeId: resolveNodeIdByRack(PARTITION_RACK_INDEX),
    expectedPodStatus: 'Pending',
    remediationAction: CHAOS_REMEDIATION_ACTION.NET_PACKET_LOSS,
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

/* isActionAllowedForPod 的实现收敛在 chaosFacts（跨端纯函数），此处再导出 */
export { isActionAllowedForPod } from '@/utils/chaosFacts';

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

/**
 * resolveVictims —— 解析某混沌场景的受害 Pod（规格 A 项导出面）。
 *
 * 【设计意图】把"谁受害了"从**镜头焦点**上解耦。修复前的 P0-2 按
 * `pod.nodeId === selectedEntityId` 过滤，一旦镜头锁错节点就解析不到受害者，
 * 随后兜底对健康节点执行 drain_node —— 宣称闭环而实际一个没修。
 *
 * 【解析顺序（两段式）】
 * 1. **本场景受灾机架上的异常 Pod 优先**：`pod.nodeId === target.nodeId`
 *    且 `status !== 'Running'`。这是最可信的一层，因为它同时满足
 *    "引擎说该机架受灾"与"快照确有异常"。
 * 2. **不足则补全量异常 Pod**：不依赖机架，任何非 Running 的 Pod 都算，
 *    填满 maxVictims 为止。用于 SSE 降级/告警未及回传时的兜底。
 *
 * 【稳定排序】第 2 段按 `pod.id` 字典序取，保证同一快照多次调用得到同一结果——
 * 否则"先修哪个"会随数组顺序漂移，截图与日志无法复现。
 *
 * @param snapshot 集群快照（含 pods / nodes）
 * @param scenario 混沌场景
 * @param maxVictims 最多返回数量（与既有"最多自愈 3 个"口径一致）
 * @returns 受害 Pod id 列表与本场景受灾节点 id；无受害者时 podIds 为空数组
 */
export function resolveVictims(
  snapshot: Pick<TelemetrySnapshot, 'pods' | 'nodes'>,
  scenario: ActiveChaosScenario,
  maxVictims = 3,
): { podIds: string[]; nodeId: string } {
  const target = CHAOS_TARGETS[scenario];
  const nodeId = target === undefined ? '' : target.nodeId;

  /* ---- 第 1 段：受灾机架上的异常 Pod ---- */
  const onTargetRack = snapshot.pods
    .filter(
      (pod): boolean => pod.nodeId === nodeId && pod.status !== 'Running',
    )
    .map((pod): string => pod.id)
    .sort((a, b): number => (a < b ? -1 : a > b ? 1 : 0));

  const picked: string[] = onTargetRack.slice(0, maxVictims);
  if (picked.length >= maxVictims) return { podIds: picked, nodeId };

  /* ---- 第 2 段：全量异常 Pod 补全（稳定排序） ---- */
  const rest = snapshot.pods
    .filter((pod): boolean => pod.status !== 'Running' && !picked.includes(pod.id))
    .map((pod): string => pod.id)
    .sort((a, b): number => (a < b ? -1 : a > b ? 1 : 0));

  for (const id of rest) {
    if (picked.length >= maxVictims) break;
    picked.push(id);
  }

  return { podIds: picked, nodeId };
}

/**
 * assertChaosTargets —— 启动前自检：每个受灾 nodeId 必须真实存在于快照。
 *
 * 【为什么需要】nodeId 是从 rackIndex 反查派生的。如果未来有人调整了
 * `INITIAL_CLUSTER_SNAPSHOT.nodes` 的 rackIndex 分配、或增删机架，
 * 反查可能返回空串——那样 `selectEntity('')` 会被 store 的幽灵 ID 守卫
 * 拒绝，镜头纹丝不动，而旁白照样宣称"已锁定"。属于静默失败，最难查。
 *
 * 【为何抛错而不是返回 false】这是**启动前**自检，属于开发者级别的配置错误。
 * 返回 false 容易被调用方忽略；抛错带上下文能立刻定位是哪一项映射坏了。
 *
 * @param snapshot 集群快照
 * @throws Error 当任一场景的 nodeId 为空、或在 nodes 中找不到时
 */
export function assertChaosTargets(
  snapshot: Pick<TelemetrySnapshot, 'nodes'>,
): void {
  const scenarios: readonly ActiveChaosScenario[] = [
    'POD_OOM_SWARM',
    'NODE_CPU_SPIKE',
    'NET_PACKET_LOSS',
  ];

  for (const scenario of scenarios) {
    const target = CHAOS_TARGETS[scenario];
    if (target === undefined) {
      throw new Error(`[chaosTargets] CHAOS_TARGETS 缺少场景 ${scenario}`);
    }
    if (target.nodeId === '') {
      throw new Error(
        `[chaosTargets] 场景 ${scenario} 的 rackIndex=${target.rackIndex} 反查不到节点；` +
          '请检查 INITIAL_CLUSTER_SNAPSHOT.nodes 的 rackIndex 分配是否覆盖 0/1/2。',
      );
    }
    const exists = snapshot.nodes.some((node): boolean => node.id === target.nodeId);
    if (!exists) {
      throw new Error(
        `[chaosTargets] 场景 ${scenario} 派生的 nodeId='${target.nodeId}'` +
          `（rackIndex=${target.rackIndex}）不在快照 nodes 中；` +
          `现有节点: ${snapshot.nodes.map((node): string => node.id).join(', ')}`,
      );
    }
  }
}
