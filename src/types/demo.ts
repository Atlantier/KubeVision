/**
 * KubeVision AI — 自动路演的事实快照类型（Demo Facts）
 *
 * 【解决什么问题】路演旁白若写死具体数字与名称（如"24 个容器实例""健康度 100"
 * "payment-gateway 内存溢出"），一旦运行时快照与文案不符，就是**当众自证矛盾**：
 * 字幕说 24 个实例、顶栏显示 21 个；字幕说 payment-gateway、探针卡写
 * redis-cluster-shard-0。评委只要抬眼对一下就能发现。
 *
 * 因此旁白改为「静态兜底 + 运行时事实模板」两段式：
 * - `fallback` 不含量化断言，任何情况下都能念；
 * - `template(facts)` 优先使用，用**当帧快照**渲染真实数字与名称。
 *
 * 【字段来源（全部来自 store 的 snapshotSummary 与导演引擎自身状态）】
 * | 字段 | 来源 |
 * |---|---|
 * | nodeName | `snapshotSummary.nodes` 中 `id === CHAOS_TARGETS[scenario].nodeId` 的 `name` |
 * | nodeId | `CHAOS_TARGETS[scenario].nodeId`（由 rackIndex 反查派生） |
 * | victimCount | `resolveVictims(snapshot, scenario).podIds.length` |
 * | actionType | `CHAOS_TARGETS[scenario].remediationAction`，经 Pod 白名单收敛 |
 * | healthBefore | 阶段 4 开始时 `snapshotSummary.clusterHealthScore` 四舍五入 |
 * | healthAfter | 阶段 4 收尾时 `snapshotSummary.clusterHealthScore` 四舍五入 |
 * | totalPods | `snapshotSummary.pods.length` |
 * | runningPods | `snapshotSummary.pods` 中 `status === 'Running'` 的数量 |
 * | chaosLabel | `CHAOS_TARGETS[scenario].label`（中文短标签） |
 *
 * 【取不到怎么办】任何字段取不到即为 `null`。模板函数必须**整句省略**含该字段的
 * 从句，而不是填 0 或填占位符——"显示 0 个受害容器"和"不显示受害容器数量"
 * 是完全不同的两种诚实程度。
 */

import type { ChaosRemediationAction } from '@/utils/chaosFacts';
import type { ActiveChaosScenario } from '@/utils/chaosFacts';

/**
 * 路演事实快照。
 *
 * 所有字段可为 null：null 表示"当帧取不到该事实"，模板应省略对应从句，禁止编造。
 */
export interface DemoFacts {
  /** 受灾节点实体 ID（由 rackIndex 反查派生）；取不到为 null */
  readonly nodeId: string | null;
  /** 受灾节点可读名（如 worker-beta）；取不到为 null */
  readonly nodeName: string | null;
  /** 当帧解析出的受害 Pod 数；取不到为 null */
  readonly victimCount: number | null;
  /** 实际下发的自愈动作（已过 Pod 白名单）；取不到为 null */
  readonly actionType: ChaosRemediationAction | null;
  /** 阶段 4 开始时的集群健康分；取不到为 null */
  readonly healthBefore: number | null;
  /** 阶段 4 收尾时的集群健康分；取不到为 null */
  readonly healthAfter: number | null;
  /** 快照中的容器总数；取不到为 null */
  readonly totalPods: number | null;
  /** 快照中 Running 状态的容器数；取不到为 null */
  readonly runningPods: number | null;
  /** 当前混沌场景；无演练时为 null */
  readonly scenario: ActiveChaosScenario | null;
  /** 混沌场景的中文短标签（如「OOM 内存溢出」）；取不到为 null */
  readonly chaosLabel: string | null;
}
