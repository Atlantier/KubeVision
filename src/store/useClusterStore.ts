'use client';

/**
 * KubeVision AI — 集群响应式 UI 状态 Store（双轨状态管理 · 轨道二：低频响应轨）
 *
 * 【设计意图】（AGENTS.md 第 3 条 + 第 4 条）
 * 本 Store 只承载**低频 UI 状态**（选中态、面板开关、终端日志、审计累计等），
 * 高频遥测数值一律走轨道一瞬态引用池（useTelemetryRef.ts），二者以
 * snapshotSummary（≥1s 节流整体替换）为唯一交汇点，互不越界：
 *   - 60FPS 渲染数据 → Float32Array 原地突变，零 React 重渲染；
 *   - 用户交互状态 → zustand 细粒度订阅，按需重渲染。
 *
 * 【SSR 水合安全三重防护】
 * 1. 文件首行 'use client'：锁定客户端边界，服务端仅生成预渲染壳；
 * 2. persist 配置 skipHydration: true：**禁用 zustand 的自动水合**。
 *    自动水合会在 store 创建时同步读取 localStorage，而服务端渲染与
 *    客户端首次渲染的初始状态因此产生差异 → React Hydration Mismatch。
 *    改为「服务端与客户端首帧都使用确定性字面量初始值，挂载后再补水」；
 * 3. 客户端根组件 useEffect 中手动调用 rehydratePersistedClusterState()
 *    （本文件导出），此时首帧已提交，状态更新走正常 React 更新通道。
 *
 * 【持久化白名单】partialize 仅落盘 4 个跨会话字段：
 *   connectionMode / totalMaskedSecrets / remediationHistory / terminalLogs(最近30条)。
 *   快照、选中态、capturedViewportDataUrl（DataURL 可达数 MB）一律不持久化，
 *   既防 localStorage 5MB 配额膨胀，也避免把易失运行时状态误当用户偏好。
 */

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type {
  AlertEvent,
  ChaosScenario,
  PodEntity,
  PodStatus,
  TelemetrySnapshot,
  WorkerNodeEntity,
} from '@/types/cluster';
import { INITIAL_CLUSTER_SNAPSHOT } from '@/types/cluster';
import type {
  ClusterState,
  ClusterStore,
  PersistedClusterState,
  RemediationRecord,
  SelectedEntityType,
  StatusFilter,
} from '@/types/store';
import { syncSnapshotToTransientRef } from '@/store/useTelemetryRef';

/* ========================================================================== */
/* 模块级常量（容量上限与持久化键，集中定义防漂移）                               */
/* ========================================================================== */

/** localStorage 持久化键名（带项目前缀，防与同域其他应用冲突） */
const PERSIST_STORAGE_KEY = 'kubevision-cluster-store';

/** 持久化 Schema 版本（字段结构变更时递增，配合 migrate 做向前兼容） */
const PERSIST_VERSION = 1;

/** 终端日志运行期 FIFO 上限（超出丢弃最旧行，防长会话内存无界增长） */
const TERMINAL_LOG_RUNTIME_LIMIT = 200;

/** 终端日志持久化条数上限（仅最近 30 条落盘，防 localStorage 配额膨胀） */
const TERMINAL_LOG_PERSIST_LIMIT = 30;

/** 自愈免疫窗口（毫秒）：同一 targetId 在此窗口内的重复自愈请求将被去重 */
const HEAL_IMMUNITY_WINDOW_MS = 30_000;

/**
 * 自愈记录 ID 单调计数器（模块级，非持久化）。
 *
 * 【设计意图】与 Date.now() 组合生成 `heal-<epoch>-<seq>` 形态的唯一 ID：
 * epoch 保证跨会话单调，seq 保证同毫秒内多条动作不碰撞，
 * 且完全不依赖 crypto.randomUUID（Safari 15 以下与部分内网环境缺失）。
 */
let remediationSeq = 0;

/* ========================================================================== */
/* 自愈闭环常量（healEntity 的恢复目标水位与健康分契约）                          */
/* ========================================================================== */

/** 自愈后 Pod 的 CPU 恢复水位（%）——容器重启后的稳态基线 */
const HEALED_POD_CPU = 28;

/** 自愈后 Pod 的内存恢复水位（%）——堆已回收、缓存冷启动后的稳态基线 */
const HEALED_POD_MEM = 42;

/**
 * 自愈后集群健康分下限（%）。
 *
 * 【设计意图】healEntity 代表一次「控制器已验证」的修复（日志尾句
 * Status verified: Running）。此时若健康分仍被尚未随下一轮 SSE tick
 * 清除的历史告警拖低，会出现「3D 场景全绿但 HUD 显示 42 分」的视觉矛盾。
 * 故对加权公式结果施加 96 分下限：既保留「未完全恢复到满分」的真实感
 * （余量 4 分对应尚在收敛的尾部指标），又保证修复动作的成效立即可见。
 */
const HEAL_RECOVERY_FLOOR = 96;

/** 健康分上限（百分比量程封顶） */
const HEALTH_SCORE_MAX = 100;

/** 历史序列长度契约（与 PodEntity.cpuHistory/memHistory「恒为 6 点」一致） */
const RECOVERY_HISTORY_POINTS = 6;

/** 恢复曲线冷启动起点（CPU %）：容器刚重启，JVM/运行时未完成预热 */
const RECOVERY_COLD_START_CPU = 6;

/** 恢复曲线冷启动起点（内存 %）：堆与页缓存自空态逐步装载 */
const RECOVERY_COLD_START_MEM = 11;

/**
 * 需纳入自愈范围的异常 Pod 状态集合。
 *
 * 【语义取舍】仅 Pending / CrashLoopBackOff / OOMKilled 三态视为「待修复异常」：
 * - Running 为健康态，无需干预；
 * - Terminating 是**有意的优雅退出**（缩容/滚动更新），把它「救活」会违背
 *   K8s 控制器语义并制造僵尸副本，故明确排除。
 */
const ABNORMAL_POD_STATUSES: readonly PodStatus[] = [
  'Pending',
  'CrashLoopBackOff',
  'OOMKilled',
];

/** 判定 Pod 状态是否属于待修复异常态（O(n) 小集合线性查找，n=3，热路径无开销） */
function isAbnormalPodStatus(status: PodStatus): boolean {
  return ABNORMAL_POD_STATUSES.includes(status);
}

/**
 * buildRecoveryHistory —— 构造自愈后的 6 点确定性恢复曲线。
 *
 * 【核心逻辑】容器重启后资源占用自冷启动基线单调爬升至稳态水位，
 * 故按线性插值生成 from → to 的 6 点序列：
 *   history[i] = round(from + (to − from) · i / (N−1)),  i ∈ [0, N−1]
 * 末位强制精确等于 to，以满足 PodEntity 的「索引 5 = 当前值」契约
 * （否则 3D 历史趋势环的末端会与 cpuUsage 读数自相矛盾）。
 *
 * 【确定性】纯算术、无随机、无时间依赖，同一输入恒得同一输出，
 * 因此修复后的快照依旧可被 SSR/CSR 逐字节复现，不引入水合风险。
 *
 * @param from 冷启动起点水位（%）
 * @param to   稳态目标水位（%），即序列末位值
 * @returns 长度恒为 RECOVERY_HISTORY_POINTS(6) 的整数水位序列
 */
function buildRecoveryHistory(from: number, to: number): number[] {
  const history: number[] = [];
  for (let i = 0; i < RECOVERY_HISTORY_POINTS; i++) {
    const ratio = i / (RECOVERY_HISTORY_POINTS - 1);
    history.push(Math.round(from + (to - from) * ratio));
  }
  // 末位精确锚定当前值，消除四舍五入漂移
  history[RECOVERY_HISTORY_POINTS - 1] = to;
  return history;
}

/** 算术均值（空数组返回 0，避免 NaN 污染快照） */
function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * computeClusterHealthScore —— 集群综合健康分加权公式。
 *
 * 【设计意图】把「节点状态 > Pod 状态 > 活跃告警」的三级严重度
 * 折算为 0~100 的单一可读分值，供 HUD 环形仪表与 MASTER 全息球着色消费。
 * 采用「满分扣减」模型（100 − Σ罚分）而非加权平均：任一维度崩坏都能
 * 独立拉低总分，符合 SRE「短板决定可用性」的直觉。
 *
 * 【罚分权重】（数值经 24 Pod / 3 节点规模标定，单节点全崩约扣 45 分）
 * - 节点：Ready 0 / HighLoad −6 / NetworkPartition −15（脑裂最致命）
 * - Pod ：Running 0 / Pending −0.5 / Terminating −0.5
 *         / CrashLoopBackOff −4 / OOMKilled −5
 * - 告警：P0 −3 / P1 −1.5 / P2 −0.5
 *
 * 【输入输出】
 * @param nodes  节点实体数组
 * @param pods   Pod 实体数组
 * @param alerts 活跃告警数组
 * @returns 0~100 的整数健康分（下限 clamp 至 0，上限 clamp 至 100）
 */
function computeClusterHealthScore(
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

  const score = Math.round(HEALTH_SCORE_MAX - penalty);
  return Math.min(HEALTH_SCORE_MAX, Math.max(0, score));
}

/**
 * deriveHealedSnapshot —— 由原快照不可变派生「已修复」新快照（自愈闭环核心）。
 *
 * 【为何必须派生新对象】TelemetrySnapshot 全字段 readonly，且当前快照很可能
 * 就是模块级种子常量 INITIAL_CLUSTER_SNAPSHOT 本身（snapshotSummary 与
 * telemetryTransientRef.snapshot 初始均引用它）。任何原地 mutate 都会
 * **永久污染种子常量**，导致后续重置/刷新回到「已被修改的初始态」，
 * 并违反 cluster.ts 的「快照为不可变值对象」契约。故此处全程 map/filter
 * 产出全新数组与实体对象，原快照与种子常量分毫不动。
 *
 * 【核心状态流转】
 * 1. Pod 轨：命中 healPodIds 的 Pod → status='Running'、cpuUsage=28、
 *    memoryUsage=42，并重建 6 点恢复曲线（末位锚定新水位，保证趋势环自洽）。
 *    restarts **刻意保留原值**：真实 K8s 中重启计数单调不减，它是故障取证
 *    的关键痕迹，抹零会丢失「该 Pod 曾崩溃 12 次」的运维信息。
 * 2. Node 轨：仅当 targetId 为节点时，该节点 status→'Ready'，
 *    且 cpuUsage/memUsage 重算为其名下（已修复）Pod 水位的算术均值——
 *    真实派生而非魔法数字，保证节点读数与 Pod 读数永不自相矛盾。
 * 3. 告警轨：entityId 命中已修复实体（Pod 或该节点）的告警予以清除，
 *    否则告警面板会对一个已验证 Running 的 Pod 持续闪烁 P0，视觉与语义双重矛盾。
 * 4. 健康分：按加权公式重算，再施加 HEAL_RECOVERY_FLOOR(96) 下限（见常量 JSDoc）。
 *
 * 【顺序保持契约】pods/nodes 数组顺序严格不变（map 原位替换），
 * 使 InstancedMesh 的 instanceId 下标映射与 spatialLayout 槽位关系不被打乱。
 *
 * @param snapshot    原快照（只读，不被修改）
 * @param healPodIds  待修复 Pod ID 集合
 * @param healNodeId  待修复节点 ID（targetId 为节点时非 null）
 * @returns 全新 TelemetrySnapshot 实例
 */
function deriveHealedSnapshot(
  snapshot: TelemetrySnapshot,
  healPodIds: ReadonlySet<string>,
  healNodeId: string | null,
): TelemetrySnapshot {
  const healedPods: PodEntity[] = snapshot.pods.map((pod): PodEntity =>
    healPodIds.has(pod.id)
      ? {
          ...pod,
          status: 'Running',
          cpuUsage: HEALED_POD_CPU,
          memoryUsage: HEALED_POD_MEM,
          cpuHistory: buildRecoveryHistory(RECOVERY_COLD_START_CPU, HEALED_POD_CPU),
          memHistory: buildRecoveryHistory(RECOVERY_COLD_START_MEM, HEALED_POD_MEM),
        }
      : pod,
  );

  const healedNodes: WorkerNodeEntity[] = snapshot.nodes.map((node): WorkerNodeEntity => {
    if (node.id !== healNodeId) return node;
    const members = healedPods.filter((pod): boolean => pod.nodeId === node.id);
    return {
      ...node,
      status: 'Ready',
      cpuUsage: Math.round(meanOf(members.map((pod): number => pod.cpuUsage))),
      memUsage: Math.round(meanOf(members.map((pod): number => pod.memoryUsage))),
    };
  });

  const healedAlerts: AlertEvent[] = snapshot.activeAlerts.filter(
    (alert): boolean => !healPodIds.has(alert.entityId) && alert.entityId !== healNodeId,
  );

  const computedScore = computeClusterHealthScore(healedNodes, healedPods, healedAlerts);

  return {
    ...snapshot,
    clusterHealthScore: Math.min(HEALTH_SCORE_MAX, Math.max(computedScore, HEAL_RECOVERY_FLOOR)),
    nodes: healedNodes,
    pods: healedPods,
    activeAlerts: healedAlerts,
  };
}

/**
 * 初始状态工厂 —— 返回全部确定性字面量（SSR/CSR 首帧逐字节一致）。
 *
 * 【契约】严禁在此调用 Date.now() / Math.random() / localStorage 读取，
 * 否则服务端预渲染与客户端首帧状态不一致，触发 Hydration Mismatch。
 * 提取为工厂函数而非共享常量对象，保证 clearPersistedHistory() 每次
 * 拿到全新数组/字典引用，杜绝「重置后仍与旧状态共享可变引用」的隐蔽 bug。
 *
 * 【类型说明】仅返回状态切片 ClusterState；Action 实现由 create 回调内联提供，
 * create<ClusterStore> 的泛型约束会在编译期强制二者合并后完整覆盖
 * ClusterState & ClusterActions，漏实现任何 Action 都会 tsc 报错。
 */
function createInitialClusterState(): ClusterState {
  return {
    snapshotSummary: INITIAL_CLUSTER_SNAPSHOT,
    selectedEntityId: null,
    selectedEntityType: null,
    connectionMode: 'demo',
    activeChaos: 'NONE',
    statusFilter: 'ALL',
    activeRightTab: 'copilot',
    isChaosModalOpen: false,
    isPerfHudOpen: false,
    terminalLogs: [],
    quickPromptTrigger: null,
    capturedViewportDataUrl: null,
    healedPodIds: {},
    totalMaskedSecrets: 0,
    remediationHistory: [],
  };
}

/* ========================================================================== */
/* Store 定义                                                                  */
/* ========================================================================== */

/**
 * useClusterStore —— 集群 UI 响应式状态 Store（zustand + persist）。
 *
 * 【类型参数说明】persist<ClusterStore, [], [], PersistedClusterState> 中
 * 第 4 个类型参数显式声明「落盘形状」，使 partialize 的返回值受
 * PersistedClusterState 严格约束——任何多写/漏写字段都会在 tsc 阶段报错，
 * 持久化白名单因此成为编译期契约而非运行时约定。
 *
 * 【订阅最佳实践】组件应按字段细粒度订阅以避免无关重渲染：
 *   const isHudOpen = useClusterStore((s) => s.isPerfHudOpen);
 * 严禁 useClusterStore() 无选择器全量订阅（任一字段变更都会重渲染）。
 */
export const useClusterStore = create<ClusterStore>()(
  persist(
    (set, get) => ({
      ...createInitialClusterState(),

      /**
       * selectEntity —— 选中/取消选中实体。
       *
       * 【不变式维护】entityId 与 entityType 必须同生共死：
       * 传入 entityId=null 时二者一并清空，防止出现「有类型无 ID」的悬挂选中态
       * 导致详情面板渲染空白卡片。entityType 为 undefined 或 null 时按 ID 前缀
       * 推断（node-* → node，pod-* → pod，其余 → master），
       * 便利射线拾取调用方省略类型参数，同时保证 id 非空时 type 必非空。
       */
      selectEntity: (entityId, entityType) => {
        if (entityId === null) {
          set({ selectedEntityId: null, selectedEntityType: null });
          return;
        }
        const resolvedType: SelectedEntityType =
          entityType ??
          (entityId.startsWith('node-')
            ? 'node'
            : entityId.startsWith('pod-')
              ? 'pod'
              : 'master');
        set({ selectedEntityId: entityId, selectedEntityType: resolvedType });
      },

      /** setConnectionMode —— 切换 demo/live 数据源（持久化字段） */
      setConnectionMode: (mode) => {
        set({ connectionMode: mode });
        get().appendTerminalLog(
          `[system] connection mode switched → ${mode === 'live' ? 'LIVE cluster SSE' : 'DEMO simulated engine'}`,
        );
      },

      /**
       * setActiveChaos —— 触发/解除混沌工程场景。
       *
       * 【职责边界】本 Action 只做状态迁移与审计日志，**不执行故障注入**：
       * 模拟引擎（后续轮次）订阅 activeChaos 变更后自行演算受影响的
       * Pod/Node 状态，保持 Store 为纯状态容器的可测试性。
       */
      setActiveChaos: (scenario) => {
        set({ activeChaos: scenario });
        get().appendTerminalLog(
          scenario === 'NONE'
            ? '[chaos] drill cleared → steady state'
            : `[chaos] scenario injected → ${scenario}`,
        );
      },

      /**
       * healEntity —— 自愈动作闭环回写（登记 + 修复 + 双轨贯通 + 审计）。
       *
       * 【核心逻辑：五步闭环】
       * 1. **免疫去重**：查 healedPodIds[targetId]，若距上次自愈 < 30s 免疫窗口，
       *    直接拒绝并写终端日志——防止 Agent 在告警风暴期对同一 Pod 反复重启
       *    形成「自愈抖动」（真实 SRE 事故模式）。
       * 2. **解析修复范围**：targetId 支持两种粒度——
       *    - Pod 粒度（snapshot.pods 中存在该 id）：仅修复自身；
       *    - Node 粒度（snapshot.nodes 中存在该 id）：批量修复该节点下**所有异常 Pod**
       *      （Pending / CrashLoopBackOff / OOMKilled，Terminating 刻意排除），
       *      同时恢复节点自身 status→Ready 与派生水位；
       *    - 未知 id：不修复任何实体，但仍完成登记/历史/审计闭环，
       *      保证「记录已执行的自愈意图」这一审计语义不因实体缺失而丢失。
       * 3. **状态修复（不可变派生）**：以当前 snapshotSummary 为基底调用
       *    deriveHealedSnapshot 产出全新快照——命中 Pod 置 Running、
       *    cpuUsage=28、memoryUsage=42 并重建 6 点恢复曲线；清除相关告警；
       *    健康分按加权公式重算并施加 96 分下限。
       *    **严禁原地修改**：原快照极可能就是模块级种子常量
       *    INITIAL_CLUSTER_SNAPSHOT 本身，mutate 会永久污染种子。
       * 4. **双轨贯通**：修复后的快照一次性写入两条轨道——
       *    响应轨 set snapshotSummary（驱动 HUD/详情面板重渲染），
       *    瞬态轨 syncSnapshotToTransientRef（原地更新 Float32Array 目标值，
       *    下一帧 useFrame 即读到修复后水位，无需等待 React 渲染周期）。
       *    两轨引用同一新快照对象，从根源杜绝「面板显示已修复、
       *    3D 场景仍是红色」的双轨撕裂。
       * 5. **混沌复位 + 登记 + 审计**：若当前处于混沌注入态则 activeChaos→'NONE'
       *    （修复动作视为本轮演练的终止信号）；healedPodIds 对**全部受影响实体**
       *    逐一登记时间戳（Node 粒度时节点与其下每个异常 Pod 均进入免疫窗口）；
       *    RemediationRecord 追加至持久化 remediationHistory（新记录置顶）。
       *
       * 【终端日志契约】固定输出带时间戳（由 appendTerminalLog 注入 HH:mm:ss）的
       * 控制器风格审计行：
       *   [KUBE-CONTROLLER] Executed ${actionType} on ${targetId} -> Status verified: Running
       *
       * 【输入输出】
       * @param targetId 目标实体 ID（Pod ID 或 Node ID，弱引用自动判别粒度）
       * @param actionType 动作类型（通常取值为 RemediationActionType）
       */
      healEntity: (targetId, actionType) => {
        const state = get();
        const now = Date.now();
        const previous = state.healedPodIds[targetId];

        /* ---- 步骤 1：免疫窗口去重 ---- */
        if (previous !== undefined && now - previous < HEAL_IMMUNITY_WINDOW_MS) {
          get().appendTerminalLog(
            `[KUBE-CONTROLLER] BLOCKED ${actionType} on ${targetId} -> immunity window active (${Math.ceil((HEAL_IMMUNITY_WINDOW_MS - (now - previous)) / 1000)}s left)`,
          );
          return;
        }

        /* ---- 步骤 2：解析修复范围（Pod 粒度 / Node 粒度 / 未知 id） ---- */
        const snapshot = state.snapshotSummary;
        const targetIsNode = snapshot.nodes.some(
          (node): boolean => node.id === targetId,
        );
        const targetIsPod = snapshot.pods.some((pod): boolean => pod.id === targetId);

        const healPodIds = new Set<string>();
        if (targetIsPod) {
          healPodIds.add(targetId);
        } else if (targetIsNode) {
          // Node 粒度：批量纳入该节点下所有异常 Pod（Terminating 为有意退出，排除）
          for (const pod of snapshot.pods) {
            if (pod.nodeId === targetId && isAbnormalPodStatus(pod.status)) {
              healPodIds.add(pod.id);
            }
          }
        }
        const healNodeId: string | null = targetIsNode ? targetId : null;

        /* ---- 步骤 3：不可变派生修复快照（严禁原地修改，见 deriveHealedSnapshot JSDoc） ---- */
        const healedSnapshot = deriveHealedSnapshot(snapshot, healPodIds, healNodeId);

        /* ---- 步骤 4a：免疫登记（全部受影响实体，防级联重复自愈） ---- */
        const immunityEntries: Record<string, number> = {};
        immunityEntries[targetId] = now;
        for (const podId of healPodIds) {
          immunityEntries[podId] = now;
        }
        if (healNodeId !== null) {
          immunityEntries[healNodeId] = now;
        }

        /* ---- 步骤 4b：修复记录（持久化白名单字段，新记录置顶） ---- */
        const record: RemediationRecord = {
          id: `heal-${now}-${remediationSeq++}`,
          timestamp: new Date(now).toISOString(),
          targetId,
          actionType,
        };

        const chaosWasActive = state.activeChaos !== 'NONE';

        /* ---- 步骤 4c：单次 set 原子提交响应轨全部变更
         * （拆成多次 set 会触发多轮订阅者重渲染，违背低频轨最小渲染纪律） ---- */
        set((current) => ({
          snapshotSummary: healedSnapshot,
          healedPodIds: { ...current.healedPodIds, ...immunityEntries },
          remediationHistory: [record, ...current.remediationHistory],
          // 混沌注入态复位：修复动作视为本轮演练的终止信号
          ...(chaosWasActive ? { activeChaos: 'NONE' as const } : {}),
        }));

        /* ---- 步骤 4d：瞬态轨同步（同一新快照对象写入 Float32Array 目标值）
         * 下一帧 useFrame 即读到修复后水位，无需等待 React 渲染周期；
         * 两轨引用同一对象，杜绝「面板已修复、3D 场景仍红」的双轨撕裂 ---- */
        syncSnapshotToTransientRef(healedSnapshot);

        /* ---- 步骤 5：终端审计（固定控制器风格行 + 混沌复位/批量修复附加行） ---- */
        get().appendTerminalLog(
          `[KUBE-CONTROLLER] Executed ${actionType} on ${targetId} -> Status verified: Running`,
        );
        if (chaosWasActive) {
          get().appendTerminalLog(
            `[KUBE-CONTROLLER] Chaos drill ${state.activeChaos} terminated -> cluster restored to steady state`,
          );
        }
        if (healPodIds.size > 1) {
          get().appendTerminalLog(
            `[KUBE-CONTROLLER] Node-scope heal on ${targetId} -> ${healPodIds.size} abnormal pods recovered`,
          );
        }
      },

      /** setCapturedViewport —— 设置/清除 3D 视口多模态截图（非持久化，体积敏感） */
      setCapturedViewport: (dataUrl) => {
        set({ capturedViewportDataUrl: dataUrl });
      },

      /**
       * incrementMaskedSecrets —— 累加端侧脱敏凭证计数（隐私审计角标）。
       *
       * 【防御】负数与小数无审计意义：先 Math.floor 取整，再 clamp 到 ≥0，
       * 保证累计值单调不减，角标永不出现负数或 NaN。
       */
      incrementMaskedSecrets: (count) => {
        const delta = Math.max(0, Math.floor(Number.isNaN(count) ? 0 : count));
        if (delta === 0) return;
        set((state) => ({ totalMaskedSecrets: state.totalMaskedSecrets + delta }));
      },

      /**
       * appendTerminalLog —— 追加底部终端日志（运行期 FIFO 上限 200 条）。
       *
       * 【时间戳策略】行内容前缀统一注入 HH:mm:ss 本地时刻，
       * 使终端呈现真实运维控制台观感；调用方传入纯消息体即可。
       */
      appendTerminalLog: (line) => {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const stamped = `${hh}:${mm}:${ss} ${line}`;

        set((state) => {
          const next = [...state.terminalLogs, stamped];
          // 超出运行期上限时丢弃最旧行（slice 而非 shift，避免原地突变持久化数组）
          return next.length > TERMINAL_LOG_RUNTIME_LIMIT
            ? { terminalLogs: next.slice(next.length - TERMINAL_LOG_RUNTIME_LIMIT) }
            : { terminalLogs: next };
        });
      },

      /**
       * triggerQuickPrompt —— 触发 AI 快捷诊断指令。
       *
       * 【联动契约】写入载荷的同时强制将 activeRightTab 切至 'copilot'：
       * 用户点击任意快捷诊断按钮（如「分析 OOM 根因」）时，右侧抽屉若停留在
       * auditor 页签会导致「指令已发出但界面无反馈」的割裂体验，故一并切换。
       */
      triggerQuickPrompt: (prompt) => {
        set({ quickPromptTrigger: prompt, activeRightTab: 'copilot' });
      },

      /** clearQuickPrompt —— 消费侧复位指令载荷（Copilot 读取后调用，防重复触发） */
      clearQuickPrompt: () => {
        set({ quickPromptTrigger: null });
      },

      /**
       * setActiveRightTab —— 手动切换右侧抽屉页签（copilot / auditor）。
       *
       * 与 triggerQuickPrompt 的自动切换互补：后者是「指令驱动的隐式切换」，
       * 本 Action 是「用户点击页签的显式切换」。
       */
      setActiveRightTab: (tab) => {
        set({ activeRightTab: tab });
      },

      /**
       * clearPersistedHistory —— 一键重置本地持久化缓存。
       *
       * 【核心逻辑】两步走：
       * 1. useClusterStore.persist.clearStorage()：物理删除 localStorage 条目，
       *    确保刷新后不会从旧缓存重新水合出「已清除」的历史；
       * 2. set(...) 将 4 个持久化字段回归初始值，使当前会话 UI 立即反映清除结果
       *    （无需等待刷新）。
       * 非持久化字段（快照、选中态、截图）刻意保留，重置审计缓存不应打断
       * 用户当前的 3D 观察上下文。
       */
      clearPersistedHistory: () => {
        useClusterStore.persist.clearStorage();
        set({
          connectionMode: 'demo',
          totalMaskedSecrets: 0,
          remediationHistory: [],
          terminalLogs: [],
        });
      },

      /**
       * setSnapshotSummary —— 低频快照摘要写入口（轨道二唯一遥测入口）。
       *
       * 【调用契约】由模拟引擎/SSE 层以 ≥1s 节流调用，整体替换引用。
       * 高频轨（每帧插值）严禁走此入口，必须调用
       * syncSnapshotToTransientRef（轨道一），否则 1Hz 快照将驱动
       * HUD 之外的整棵订阅树重渲染，击穿 60FPS 红线。
       */
      setSnapshotSummary: (snapshot: TelemetrySnapshot) => {
        set({ snapshotSummary: snapshot });
      },

      /** setStatusFilter —— 设置 Pod 状态过滤器（'ALL' = 不过滤） */
      setStatusFilter: (filter: StatusFilter) => {
        set({ statusFilter: filter });
      },

      /** setChaosModalOpen —— 混沌控制台模态框开关 */
      setChaosModalOpen: (open) => {
        set({ isChaosModalOpen: open });
      },

      /** setPerfHudOpen —— 性能 HUD 面板开关 */
      setPerfHudOpen: (open) => {
        set({ isPerfHudOpen: open });
      },
    }),
    {
      name: PERSIST_STORAGE_KEY,
      version: PERSIST_VERSION,

      /**
       * createJSONStorage(() => localStorage)
       *
       * 【SSR 安全】zustand 的 createJSONStorage 内部以 try/catch 惰性求值
       * getStorage()：服务端 localStorage 未定义会抛 ReferenceError 并被捕获，
       * 返回 undefined 使 persist 退化为无操作，不会导致模块 import 崩溃。
       */
      storage: createJSONStorage(() => localStorage),

      /**
       * skipHydration: true —— 禁用自动水合（Hydration Mismatch 根治手段）。
       *
       * 详见文件头「SSR 水合安全三重防护」第 2 条：首帧统一使用确定性初始值，
       * 挂载后由客户端根组件调用 rehydratePersistedClusterState() 手动补水。
       */
      skipHydration: true,

      /**
       * partialize —— 持久化白名单（编译期受 PersistedClusterState 约束）。
       *
       * terminalLogs 在此处二次裁剪到最近 30 条：运行期缓冲 200 条用于
       * 当前会话的完整回溯，落盘只留最近 30 条作为跨会话摘要，
       * 兼顾调试体验与 localStorage 配额安全。
       */
      partialize: (state): PersistedClusterState => ({
        connectionMode: state.connectionMode,
        totalMaskedSecrets: state.totalMaskedSecrets,
        remediationHistory: state.remediationHistory,
        terminalLogs: state.terminalLogs.slice(-TERMINAL_LOG_PERSIST_LIMIT),
      }),
    },
  ),
);

/* ========================================================================== */
/* 水合辅助（客户端根组件调用）                                                  */
/* ========================================================================== */

/**
 * rehydratePersistedClusterState —— 客户端手动水合入口（幂等）。
 *
 * 【调用契约】必须在客户端根组件的 useEffect 中调用一次：
 *   useEffect(() => { rehydratePersistedClusterState(); }, []);
 * 此时首帧 HTML 已提交，从 localStorage 读出的持久化字段以正常 React
 * 更新通道合并进 Store，不会产生水合不匹配。
 *
 * 【幂等性】内部以模块级标志位守卫，StrictMode 双调用 / 多组件重复调用
 * 均只会真正补水一次，避免重复触发订阅者重渲染。
 * rehydrate() 返回 Promise<void | unknown>（旧缓存解析失败时 resolve undefined），
 * 失败分支写一行终端日志便于排查，绝不抛出以免中断根组件挂载。
 */
let hasRehydrated = false;

export function rehydratePersistedClusterState(): void {
  if (hasRehydrated) return;
  hasRehydrated = true;

  void useClusterStore
    .persist
    .rehydrate()
    ?.then(() => {
      const { terminalLogs } = useClusterStore.getState();
      if (terminalLogs.length > 0) {
        useClusterStore
          .getState()
          .appendTerminalLog('[system] persisted session state rehydrated from localStorage');
      }
    })
    .catch(() => {
      useClusterStore
        .getState()
        .appendTerminalLog('[system] WARN persisted state rehydration failed → using defaults');
    });
}

/**
 * useHasHydratedClusterStore —— 水合完成标志的响应式读取 Hook。
 *
 * 【设计意图】部分 UI（如「历史自愈记录」面板）需要在补水完成后才渲染真实数据，
 * 否则会闪现一帧空态。本 Hook 订阅 persist.onFinishHydration 事件，
 * 返回布尔标志供组件条件渲染。skipHydration 模式下若无缓存可补，
 * rehydrate() 不触发 finish 事件，故初始值直接取 hasRehydrated 模块标志兜底。
 */
export function useHasHydratedClusterStore(): boolean {
  const [hydrated, setHydrated] = useState<boolean>(hasRehydrated);

  useEffect(() => {
    const unsubscribe = useClusterStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    // 订阅建立前水合可能已完成（竞态），此处二次校正
    setHydrated(hasRehydrated);
    return unsubscribe;
  }, []);

  return hydrated;
}
