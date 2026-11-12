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

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';

import type {
  AlertEvent,
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
  RemediationDiff,
  RemediationRecord,
  SelectedEntityType,
  StatusFilter,
} from '@/types/store';
import { syncSnapshotToTransientRef } from '@/store/useTelemetryRef';
import { HEAL_IMMUNITY_WINDOW_MS } from '@/constants/telemetryTuning';
import { clearFrameBuffer } from '@/utils/snapshotRingBuffer';
import { MASTER_ENTITY_ID } from '@/utils/cameraFocus';
import { computeHealthScore } from '@/utils/clusterHealth';

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

/**
 * persist 落盘最小间隔（R4：1Hz 成本）。
 *
 * 【为什么必须节流】zustand persist 在**每次 set** 都序列化并写 localStorage，
 * 即使 partialize 白名单外的字段（如 1Hz 快照摘要）变化也照写不误。
 * 遥测每秒 set 一次 + 终端日志追加，静置时主线程被同步 IO 持续占用。
 * 白名单已只留 4 个跨会话字段，这里再把写入频率钳到 ≤1 次/秒（验收红线），
 * 尾随节流保证最后一次变更最终落盘（最多延迟一个间隔）。
 */
const PERSIST_WRITE_INTERVAL_MS = 1000;

/**
 * createThrottledPersistStorage —— 尾随节流的 localStorage 包装（R4）。
 *
 * 【读写一致性】setItem 先把最新值存入 pending：getItem 命中 pending 时
 * 直接返回它（read-your-writes），rehydrate 不会读到落后于内存的旧值。
 * 【清理语义】removeItem 立即生效并作废 pending（clearStorage 不得被节流拖延）。
 * 【SSR 安全】工厂只创建闭包，不触碰 localStorage；zustand 在服务端
 * 求值 storage 失败时 persist 自动退化为无操作（与原实现一致）。
 */
function createThrottledPersistStorage(): StateStorage {
  let lastWriteAt = 0;
  let pendingValue: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    pendingTimer = null;
    if (pendingValue === null) return;
    const value = pendingValue;
    pendingValue = null;
    lastWriteAt = Date.now();
    try {
      localStorage.setItem(PERSIST_STORAGE_KEY, value);
    } catch {
      /* 配额耗尽 / 隐私模式：静默降级为不持久化，绝不中断 UI */
    }
  };

  return {
    getItem: (name: string): string | null => {
      if (name === PERSIST_STORAGE_KEY && pendingValue !== null) return pendingValue;
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name: string, value: string): void => {
      if (name !== PERSIST_STORAGE_KEY) {
        try {
          localStorage.setItem(name, value);
        } catch {
          /* 同上 */
        }
        return;
      }
      pendingValue = value;
      const wait = PERSIST_WRITE_INTERVAL_MS - (Date.now() - lastWriteAt);
      if (wait <= 0) {
        flush();
        return;
      }
      if (pendingTimer === null) pendingTimer = setTimeout(flush, wait);
    },
    removeItem: (name: string): void => {
      if (name === PERSIST_STORAGE_KEY) {
        pendingValue = null;
        if (pendingTimer !== null) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
      }
      try {
        localStorage.removeItem(name);
      } catch {
        /* 同上 */
      }
    },
  };
}

/*
 * 自愈免疫窗口：唯一事实源在 constants/telemetryTuning.ts（HEAL_IMMUNITY_WINDOW_MS），
 * 与 useTelemetryStream 的视觉保持窗口同引用——「剩余秒数提示」与 3D 免疫态同生共死。
 */

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

/** 历史序列长度契约（与 PodEntity.cpuHistory/memHistory「恒为 6 点」一致） */
const RECOVERY_HISTORY_POINTS = 6;

/** 恢复曲线冷启动起点（CPU %）：容器刚重启，JVM/运行时未完成预热 */
const RECOVERY_COLD_START_CPU = 6;

/** 恢复曲线冷启动起点（内存 %）：堆与页缓存自空态逐步装载 */
const RECOVERY_COLD_START_MEM = 11;

/**
 * 需纳入自愈范围的异常 Pod 状态集合。
 *
 * 【语义取舍】仅 Pending / CrashLoopBackOff / OOMKilled 三态视为「待自愈异常」：
 * - Running 为健康态，无需干预；
 * - Terminating 是**有意的优雅退出**（缩容/滚动更新），把它「救活」会违背
 *   K8s 控制器语义并制造僵尸副本，故明确排除。
 */
const ABNORMAL_POD_STATUSES: readonly PodStatus[] = [
  'Pending',
  'CrashLoopBackOff',
  'OOMKilled',
];

/** 判定 Pod 状态是否属于待自愈异常态（O(n) 小集合线性查找，n=3，热路径无开销） */
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
 * 因此自愈后的快照依旧可被 SSR/CSR 逐字节复现，不引入水合风险。
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
 * deriveHealedSnapshot —— 由原快照不可变派生「已自愈」新快照（自愈闭环核心）。
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
 *    且 cpuUsage/memUsage 重算为其名下（已自愈）Pod 水位的算术均值——
 *    真实派生而非魔法数字，保证节点读数与 Pod 读数永不自相矛盾。
 * 3. 告警轨：entityId 命中已自愈实体（Pod 或该节点）的告警予以清除，
 *    否则告警面板会对一个已验证 Running 的 Pod 持续闪烁 P0，视觉与语义双重矛盾。
 * 4. 健康分：经唯一入口 computeHealthScore 按罚分模型重算（R4：无地板，
 *    与引擎/live 同口径，三处展示同一个数）。
 *
 * 【顺序保持契约】pods/nodes 数组顺序严格不变（map 原位替换），
 * 使 InstancedMesh 的 instanceId 下标映射与 spatialLayout 槽位关系不被打乱。
 *
 * @param snapshot    原快照（只读，不被修改）
 * @param healPodIds  待自愈 Pod ID 集合
 * @param healNodeId  待自愈节点 ID（targetId 为节点时非 null）
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

  /*
   * 【R4：健康分无地板】先组装自愈后的完整快照，再经唯一入口 computeHealthScore
   * 重算。旧实现的 96 分地板会让「自愈后分数」与「引擎下一帧算出的分数」打架
   * （地板值 ≠ 罚分模型值），三处展示自相矛盾。现在自愈派生与引擎同口径：
   * 分数完全由实体状态决定，异常清干净自然回到满分，无需粉饰。
   */
  const healed: TelemetrySnapshot = {
    ...snapshot,
    nodes: healedNodes,
    pods: healedPods,
    activeAlerts: healedAlerts,
    clusterHealthScore: 0,
  };

  return { ...healed, clusterHealthScore: computeHealthScore(healed) };
}

/**
 * findEntityMetrics —— 从快照中取出指定实体的指标三元组（CPU / 内存 / 状态）。
 *
 * 【为何需要这个辅助】自愈前后对比必须取自**同一套字段口径**：
 * Pod 与 Node 是两个不同的实体类型，各自持有 cpuUsage / memoryUsage / status。
 * 若在两处分别写取值逻辑，很容易出现"before 取 Pod、after 取 Node"的错配，
 * 差值就完全失去意义。集中到一处，口径只有一份。
 *
 * 【找不到时返回 0】调用方在使用前已确认目标存在（healEntity 步骤 2b 的闸门），
 * 因此这里的兜底分支在实践中不会走到；返回 0 而非抛错是为了不让一个
 * 理论上的边界情况打断整个自愈流程。
 *
 * @param snapshot 待检索的遥测快照
 * @param entityId 目标实体 ID（Pod ID 或 Node ID）
 * @returns CPU 使用率、内存使用率、状态字符串
 */
function findEntityMetrics(
  snapshot: TelemetrySnapshot,
  entityId: string,
): { cpu: number; mem: number; status: string } {
  const pod = snapshot.pods.find((item): boolean => item.id === entityId);
  if (pod !== undefined) {
    return { cpu: pod.cpuUsage, mem: pod.memoryUsage, status: pod.status };
  }
  const node = snapshot.nodes.find((item): boolean => item.id === entityId);
  if (node !== undefined) {
    return { cpu: node.cpuUsage, mem: node.memUsage, status: node.status };
  }
  return { cpu: 0, mem: 0, status: 'Unknown' };
}

/**
 * resolveEntityDisplayName —— 把实体 ID 解析为可读展示名。
 *
 * 【为何必须解析】动作卡上显示 `pod-redis-cluster-shard-0` 这种内部 ID
 * 对用户毫无意义；展示 `redis-cluster-shard-0` 才是他认识的容器名。
 * 解析失败时退回原 ID（总比显示空白好）。
 *
 * @param snapshot 待检索的遥测快照
 * @param entityId 目标实体 ID
 * @returns 展示名；未找到时返回原 ID
 */
function resolveEntityDisplayName(snapshot: TelemetrySnapshot, entityId: string): string {
  const pod = snapshot.pods.find((item): boolean => item.id === entityId);
  if (pod !== undefined) return pod.name;
  const node = snapshot.nodes.find((item): boolean => item.id === entityId);
  if (node !== undefined) return node.name;
  return entityId;
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
    isOrbitPatrolActive: false,
    activeMobileView: 'topology',
    terminalLogs: [],
    quickPromptQueue: [],
    capturedViewportDataUrl: null,
    healedPodIds: {},
    pendingRemediations: [],
    lastRemediationDiff: null,
    totalMaskedSecrets: 0,
    remediationHistory: [],
    demoAutoConfirm: false,
    isGlContextLost: false,
    telemetryReadOnly: false,
    telemetrySchemaNotice: null,
    demoFallbackExecuted: false,
    copilotStreaming: false,
    lastAssistantMessageId: null,
    actionCardMountedId: null,
    copilotAbortToken: 0,
    patrolLockedByProgram: false,
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

        /**
         * 【幽灵 ID 入口拦截】
         *
         * 历史缺陷：selectEntity 直接信任调用方传入的 ID，任何字符串都会被写入
         * selectedEntityId。当上游（大模型动作卡的 targetId、旧持久化会话）
         * 传来 `n/a` 这类不存在的值时，选中态就变成**指向空气**：
         * 探针卡片渲染 `POD n/a`、相机聚焦找不到目标而静默失败、
         * 后续 healEntity 还会基于这个假 ID 打印成功回执。
         *
         * 现在在写入前做一次存在性校验：只有真实存在于当前快照的 Pod /
         * Node，或等于 MASTER_ENTITY_ID 的控制平面，才允许成为选中实体。
         * 非法 ID 一律**静默归零**（不抛错、不写日志）——UI 层不该因为
         * 上游的一个脏值而中断，直接当作"没有选中"即可。
         */
        const snapshot = get().snapshotSummary;
        const existsInCluster =
          entityId === MASTER_ENTITY_ID ||
          snapshot.pods.some((pod): boolean => pod.id === entityId) ||
          snapshot.nodes.some((node): boolean => node.id === entityId);

        if (!existsInCluster) {
          set({ selectedEntityId: null, selectedEntityType: null });
          /**
           * 【安全审计】静默归零不等于静默无痕。
           *
           * 之前的实现注释写着"不抛错、不写日志——UI 层不该因为上游的一个
           * 脏值而中断"。这个判断对**用户体验**是对的：确实不该弹错误框。
           * 但对**安全可观测性**是错的：幽灵 ID 出现本身是一个信号——
           * 它意味着上游（大模型动作卡、旧持久化会话、跨轮对话引用）
           * 正在把不存在的实体 ID 送进来。如果连一行日志都不留，
           * 这类问题在线上会完全不可见，只能靠用户报告"点了没反应"才发现。
           *
           * 因此改为：界面行为不变（依然静默不选中），但终端留一条
           * [AUDIT-SECURITY] 审计行。前缀经 TerminalEcho 的 TONE_RULES
           * 映射为告警色调，便于值班者快速识别这是「被拒绝的非法请求」
           * 而非普通业务日志。
           */
          get().appendTerminalLog(
            `[AUDIT-SECURITY] rejected selectEntity("${entityId}") -> target not found in current snapshot`,
          );
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
       * healEntity —— 自愈动作闭环回写（登记 + 自愈 + 双轨贯通 + 审计）。
       *
       * 【核心逻辑：五步闭环】
       * 1. **免疫去重**：查 healedPodIds[targetId]，若距上次自愈 < 免疫窗口
       *    （HEAL_IMMUNITY_WINDOW_MS，与视觉保持同值），直接拒绝并写终端日志——
       *    防止 Agent 在告警风暴期对同一 Pod 反复重启形成「自愈抖动」（真实 SRE 事故模式）。
       * 2. **解析自愈范围**：targetId 支持两种粒度——
       *    - Pod 粒度（snapshot.pods 中存在该 id）：仅自愈自身；
       *    - Node 粒度（snapshot.nodes 中存在该 id）：批量自愈该节点下**所有异常 Pod**
       *      （Pending / CrashLoopBackOff / OOMKilled，Terminating 刻意排除），
       *      同时恢复节点自身 status→Ready 与派生水位；
       *    - 未知 id：不自愈任何实体，但仍完成登记/历史/审计闭环，
       *      保证「记录已执行的自愈意图」这一审计语义不因实体缺失而丢失。
       * 3. **状态自愈（不可变派生）**：以当前 snapshotSummary 为基底调用
       *    deriveHealedSnapshot 产出全新快照——命中 Pod 置 Running、
       *    cpuUsage=28、memoryUsage=42 并重建 6 点恢复曲线；清除相关告警；
       *    健康分按加权公式重算并施加 96 分下限。
       *    **严禁原地修改**：原快照极可能就是模块级种子常量
       *    INITIAL_CLUSTER_SNAPSHOT 本身，mutate 会永久污染种子。
       * 4. **双轨贯通**：自愈后的快照一次性写入两条轨道——
       *    响应轨 set snapshotSummary（驱动 HUD/详情面板重渲染），
       *    瞬态轨 syncSnapshotToTransientRef（原地更新 Float32Array 目标值，
       *    下一帧 useFrame 即读到自愈后水位，无需等待 React 渲染周期）。
       *    两轨引用同一新快照对象，从根源杜绝「面板显示已自愈、
       *    3D 场景仍是红色」的双轨撕裂。
       * 5. **混沌复位 + 登记 + 审计**：若当前处于混沌注入态则 activeChaos→'NONE'
       *    （自愈动作视为本轮演练的终止信号）；healedPodIds 对**全部受影响实体**
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

        /**
         * ---- 步骤 1：免疫窗口 → **明确拒绝**（C2）----
         *
         * 【自愈的缺陷】旧实现承诺"已排队，N 秒后重试"并写入 pendingRemediations，
         * 但全项目没有任何调度器消费这个队列——任务永不执行。这是对用户的
         * 不实承诺，比"直接拒绝"更糟（用户会一直等一个不会发生的重试）。
         *
         * 【现在的行为】窗口内重复自愈：终端写 REJECTED 审计行，返回
         * { ok:false, remainingSec }，由卡片展示"免疫窗口内不可重复自愈，
         * 剩余 N 秒"。不做任何"稍后自动执行"的暗示。
         */
        if (previous !== undefined && now - previous < HEAL_IMMUNITY_WINDOW_MS) {
          const remainingSec = Math.ceil((HEAL_IMMUNITY_WINDOW_MS - (now - previous)) / 1000);
          get().appendTerminalLog(
            `[KUBE-CONTROLLER] REJECTED ${actionType} on ${targetId} -> immunity window active (${remainingSec}s remaining): duplicate heal suppressed, no automatic retry`,
          );
          return {
            ok: false,
            code: 'immunity',
            remainingSec,
            message: `免疫窗口内不可重复自愈，剩余 ${remainingSec} 秒`,
          };
        }
        /* ---- 步骤 2：解析自愈范围（Pod 粒度 / Node 粒度 / 未知 id） ---- */
        const snapshot = state.snapshotSummary;
        const targetIsNode = snapshot.nodes.some(
          (node): boolean => node.id === targetId,
        );
        const targetIsPod = snapshot.pods.some((pod): boolean => pod.id === targetId);

        /**
         * ---- 步骤 2b：目标不存在 → 安全返回，绝不写虚假回执 ----
         *
         * 【为何这是最关键的一道闸】此前若 targetId 不在快照里（例如 'n/a'），
         * 下面的 healPodIds 为空、healNodeId 为 null，deriveHealedSnapshot 原样
         * 返回未变快照——但代码仍会继续执行到步骤 4/5：
         * - healedPodIds 被写入 { 'n/a': now }，污染持久化的免疫窗口；
         * - remediationHistory 追加一条目标为 'n/a' 的自愈记录；
         * - 终端打印 `Executed ... on n/a -> Status verified: Running`，
         *   **一条彻头彻尾的假成功回执**。
         *
         * 现在在最前面拦下：目标不在当前集群就什么都不写、不打印成功行，
         * 只留一条 SKIPPED 审计说明（让排障者知道"有调用但被拒绝"，
         * 而不是毫无痕迹）。
         */
        if (!targetIsPod && !targetIsNode) {
          get().appendTerminalLog(
            `[KUBE-CONTROLLER] REJECTED ${actionType} on ${targetId} -> target not found in cluster snapshot`,
          );
          return { ok: false, code: 'target-missing', message: '目标已不存在于当前快照，请重新诊断后确认' };
        }

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

        /* ---- 步骤 3：不可变派生自愈快照（严禁原地修改，见 deriveHealedSnapshot JSDoc） ---- */
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

        /* ---- 步骤 4b：自愈记录（持久化白名单字段，新记录置顶） ---- */
        const record: RemediationRecord = {
          id: `heal-${now}-${remediationSeq++}`,
          timestamp: new Date(now).toISOString(),
          targetId,
          actionType,
        };

        const chaosWasActive = state.activeChaos !== 'NONE';

        /**
         * ---- 步骤 4b·补：计算自愈前后指标对比 ----
         *
         * 【为何在 set 之前算】before 必须取自**尚未提交**的旧快照，
         * after 取自 newly derived 的愈合快照。一旦 set 完成，
         * get().snapshotSummary 就已是新值，before 将无从获取。
         *
         * 【取值口径】
         * - Pod 粒度：取该 Pod 自身的 cpuUsage/memoryUsage/status；
         * - Node 粒度：取该节点的 cpuUsage/memUsage/status；
         * - 健康分：始终取整个集群的 clusterHealthScore（局部自愈也会改善总分）。
         * before/after 同源同口径，差值才有解释力。
         */
        const beforeEntity = findEntityMetrics(snapshot, targetId);
        const afterEntity = findEntityMetrics(healedSnapshot, targetId);

        const diff: RemediationDiff = {
          targetId,
          targetName: resolveEntityDisplayName(snapshot, targetId),
          actionType,
          beforeCpu: beforeEntity.cpu,
          afterCpu: afterEntity.cpu,
          beforeMem: beforeEntity.mem,
          afterMem: afterEntity.mem,
          beforeHealth: snapshot.clusterHealthScore,
          afterHealth: healedSnapshot.clusterHealthScore,
          beforeStatus: beforeEntity.status,
          afterStatus: afterEntity.status,
          timestamp: new Date(now).toISOString(),
        };

        /* ---- 步骤 4c：单次 set 原子提交响应轨全部变更
         * （拆成多次 set 会触发多轮订阅者重渲染，违背低频轨最小渲染纪律） ---- */
        set((current) => ({
          snapshotSummary: healedSnapshot,
          healedPodIds: { ...current.healedPodIds, ...immunityEntries },
          remediationHistory: [record, ...current.remediationHistory],
          lastRemediationDiff: diff,
          // 混沌注入态复位：自愈动作视为本轮演练的终止信号
          ...(chaosWasActive ? { activeChaos: 'NONE' as const } : {}),
        }));

        /* ---- 步骤 4d：瞬态轨同步（同一新快照对象写入 Float32Array 目标值）
         * 下一帧 useFrame 即读到自愈后水位，无需等待 React 渲染周期；
         * 两轨引用同一对象，杜绝「面板已自愈、3D 场景仍红」的双轨撕裂 ---- */
        syncSnapshotToTransientRef(healedSnapshot);

        /* ---- 步骤 5：终端审计（固定控制器风格行 + 混沌复位/批量自愈附加行） ---- */
        get().appendTerminalLog(
          `[KUBE-CONTROLLER] Executed ${actionType} on ${targetId} -> Status verified: Running`,
        );
        /* 前后对比审计行：把"改善了多少"落到终端，而不只是留在卡片里 */
        get().appendTerminalLog(
          `[KUBE-CONTROLLER] Self-heal delta on ${diff.targetName}: CPU ${diff.beforeCpu.toFixed(1)}%→${diff.afterCpu.toFixed(1)}%, MEM ${diff.beforeMem.toFixed(1)}%→${diff.afterMem.toFixed(1)}%, health ${diff.beforeHealth.toFixed(0)}→${diff.afterHealth.toFixed(0)}`,
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

        return { ok: true };
      },

      /**
       * clearPendingRemediations —— 清空退避队列。
       *
       * 【使用场景】用户主动放弃重试、或切换集群上下文时，陈旧的排队任务
       * 不应继续存在——否则它们会在将来某个时刻突然生效。
       *
       * @param targetId 只清除该目标；省略则全清
       */
      clearPendingRemediations: (targetId) => {
        set((current) => ({
          pendingRemediations:
            targetId === undefined
              ? []
              : current.pendingRemediations.filter(
                  (item): boolean => item.targetId !== targetId,
                ),
        }));
        get().appendTerminalLog(
          targetId === undefined
            ? '[KUBE-CONTROLLER] pending remediation queue cleared'
            : `[KUBE-CONTROLLER] pending remediation queue cleared for ${targetId}`,
        );
      },

      /** clearLastRemediationDiff —— 清除最近一次自愈对比（换会话/重开卡片时避免串味） */
      clearLastRemediationDiff: () => {
        set({ lastRemediationDiff: null });
      },

      /**
       * clearHealedPodIds —— 清空自愈免疫表。
       *
       * 【为何必须有】`healEntity` 对同一目标有免疫窗口（HEAL_IMMUNITY_WINDOW_MS）：
       * 窗口内重复自愈会被明确拒绝。自动路演若在窗口内连跑第二遍，
       * 第二遍的自愈会被免疫窗口整体吞掉，表现为"跑了但没自愈"。
       * 自愈前 Store 没有任何清除入口，这是"连跑两遍第二遍失败"的根因。
       *
       * 【安全性】只清免疫时间戳，不动 remediationHistory —— 审计记录必须保留。
       */
      clearHealedPodIds: () => {
        set({ healedPodIds: {} });
        get().appendTerminalLog('[DEMO-DIRECTOR] immunity window table cleared');
      },

      /**
       * resetDemoEphemeralState —— 复位路演临时态，让下一次演示从干净起点开始。
       *
       * 【清理范围与理由】
       * · healedPodIds / pendingRemediations / lastRemediationDiff：
       *   都是"上一次自愈留下的痕迹"，不清会让新剧本读到旧状态；
       * · capturedViewportDataUrl：多模态截图体积大且属于上一轮语境；
       * · statusFilter → 'ALL'：路演要展示全量容器，若用户事先筛了"仅崩溃"
       *   会让画面只剩红块，失去对比；
       * · isChaosModalOpen / isPerfHudOpen → false：避免弹窗挡住 3D 演示；
       * · activeRightTab → 'copilot'：阶段 3 要让评委看到 AI 副驾。
       *
       * 【刻意不清的东西】remediationHistory 与 totalMaskedSecrets 属于审计证据，
       * 清掉就是数据丢失；connectionMode / snapshotSummary 也不动（由调用方管理）。
       *
       * 【为什么顺带清帧缓冲】快照环形缓冲是"本次路演"的事故时间线素材。
       * 复位后新一轮若还混着旧帧，复盘时间线会把两次路演拼在一起，拼接出并不存在的事故。
       */
      resetDemoEphemeralState: () => {
        clearFrameBuffer();
        set({
          healedPodIds: {},
          pendingRemediations: [],
          lastRemediationDiff: null,
          capturedViewportDataUrl: null,
          statusFilter: 'ALL',
          isChaosModalOpen: false,
          isPerfHudOpen: false,
          activeRightTab: 'copilot',
        });
      },

      /** setDemoAutoConfirm —— 导演模式信号（内存态，仅路演期间为 true） */
      setDemoAutoConfirm: (enabled) => {
        set({ demoAutoConfirm: enabled });
      },

      /**
       * setTelemetrySchemaState —— 遥测 schema 协商结果写入。
       *
       * 【为什么必须进 store】只读降级要驱动多处 UI（HUD 提示条、顶栏徽标），
       * 它是低频状态（只在连接建立/首帧校验时变化），进 React 状态是合理的；
       * 高频的「数据健康指标」则走 telemetryHealthRef 瞬态轨，两者分工明确。
       */
      setTelemetrySchemaState: (readOnly, notice) => {
        set({ telemetryReadOnly: readOnly, telemetrySchemaNotice: notice });
      },

      /** setGlContextLost —— 由 ClusterCanvas 的 webglcontextlost/restored 回调写入 */
      setGlContextLost: (lost) => {
        set({ isGlContextLost: lost });
      },

      /** setDemoFallbackExecuted —— 导演降级直执行后置位，供后挂载卡片显示已执行 */
      setDemoFallbackExecuted: (value) => {
        set({ demoFallbackExecuted: value });
      },

      /** setCopilotStreaming —— 由 Copilot 流事件回调写入，非渲染期调用 */
      setCopilotStreaming: (streaming) => {
        set({ copilotStreaming: streaming });
      },

      /** setLastAssistantMessageId —— 流开始时写入当前 assistant 消息 ID */
      setLastAssistantMessageId: (messageId) => {
        set({ lastAssistantMessageId: messageId });
      },

      /** setActionCardMountedId —— 动作卡水合完成写入，卸载置 null */
      setActionCardMountedId: (messageId) => {
        set({ actionCardMountedId: messageId });
      },

      /** requestCopilotAbort —— 自增计数，Copilot 侧观察变化后中止流 */
      requestCopilotAbort: () => {
        set((current) => ({ copilotAbortToken: current.copilotAbortToken + 1 }));
      },

      /** clearQuickPromptTrigger —— 主动清空待消费的快捷指令队列 */
      clearQuickPromptTrigger: () => {
        set({ quickPromptQueue: [] });
      },

      /** shiftQuickPrompt —— 消费队首指令（Copilot 读取后调用，防重复触发） */
      shiftQuickPrompt: () => {
        set((current) => ({ quickPromptQueue: current.quickPromptQueue.slice(1) }));
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
       * clearTerminalLogs —— 仅清空终端滚动日志（不动任何持久化数据）。
       *
       * 【为何必须独立于 clearPersistedHistory】
       * 此前 TerminalEcho 的 clear 按钮直接调用 clearPersistedHistory()，
       * 用户只想清掉左下角几行滚动日志，却连带洗白了 connectionMode
       * （数据源偏好）、totalMaskedSecrets（端侧累计脱敏计数）与
       * remediationHistory（自愈审计历史）——这是**真实的数据丢失事故**，
       * 属于最危险的一类「操作与预期不符」缺陷（审查报告 §5.2）。
       *
       * 本动作只做一件事：清空 terminalLogs 并留一条系统回执，
       * 让用户明确知道「清屏发生了什么」。
       */
      clearTerminalLogs: () => {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        set({ terminalLogs: [`${hh}:${mm}:${ss} [SYSTEM] 终端回显已清屏`] });
      },

      /**
       * triggerQuickPrompt —— 触发 AI 快捷诊断指令。
       *
       * 【联动契约】写入载荷的同时强制切换两处 Copilot 可见性：
       * 1. activeRightTab → 'copilot'：桌面端右侧抽屉若停留在 auditor 页签，
       *    会出现「指令已发出但界面无反馈」的割裂体验；
       * 2. activeMobileView → 'copilot'：小屏（< 1024px）右抽屉默认隐藏，
       *    若不联动切换，视口工具条的「快照诊断」在移动端将唤醒失败。
       * 双联动保证任何视口宽度下指令都能得到即时视觉响应。
       */
      triggerQuickPrompt: (prompt) => {
        set((current) => ({
          quickPromptQueue: [...current.quickPromptQueue, prompt],
          activeRightTab: 'copilot',
          activeMobileView: 'copilot',
        }));
      },

      /** clearQuickPrompt —— 消费侧清空整个指令队列（停止路演等场景） */
      clearQuickPrompt: () => {
        set({ quickPromptQueue: [] });
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
       * setOrbitPatrolActive —— 切换环绕巡检自动旋转。
       *
       * 【声明式契约】本 Action 只翻转布尔状态；CameraRig 以
       * autoRotate={isOrbitPatrolActive} 声明式绑定 OrbitControls，
       * 严禁组件侧命令式戳 controls ref（状态与行为单点收敛在 Store）。
       * 巡检期间用户拖拽鼠标时，CameraRig 的 'start' 监听会自动关闭巡检
       * （手动操作优先），同样经由本 Action 回写，保持状态一致。
       */
      setOrbitPatrolActive: (active, reason = 'user') => {
        /*
         * 【E 项：记录"是谁开的巡检"】programmatic 表示这是导演编排的一部分，
         * CameraRig 看到锁就不再因选中态变化解除它。
         * 关闭巡检时一律清锁，恢复原有交互语义。
         */
        const lockedByProgram = active && reason === 'programmatic';
        set({ isOrbitPatrolActive: active, patrolLockedByProgram: lockedByProgram });
        get().appendTerminalLog(
          active
            ? lockedByProgram
              ? '[system] orbit patrol engaged by demo director (programmatic)'
              : '[system] orbit patrol engaged → auto-rotate ON (drag to take over)'
            : '[system] orbit patrol disengaged → auto-rotate OFF',
        );
      },

      /**
       * setActiveMobileView —— 切换小屏视图（topology / copilot）。
       *
       * 【状态化缘由】原为 ShellLayout 本地 state；提升为 Store 状态后，
       * 画布视口工具条的「快照诊断」可跨组件唤醒移动端 Copilot 视图
       * （triggerQuickPrompt 内部联动）。双面板常驻 DOM 仅切可见性，
       * 避免卸载 R3F Canvas 触发 WebGL 上下文重建。
       */
      setActiveMobileView: (view) => {
        set({ activeMobileView: view });
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
       * createJSONStorage(createThrottledPersistStorage)
       *
       * 【SSR 安全】zustand 的 createJSONStorage 内部以 try/catch 惰性求值
       * getStorage()：服务端 localStorage 未定义会抛 ReferenceError 并被捕获，
       * 返回 undefined 使 persist 退化为无操作，不会导致模块 import 崩溃。
       * 【R4】包装层把落盘频率钳到 ≤1 次/秒（见 PERSIST_WRITE_INTERVAL_MS）。
       */
      storage: createJSONStorage(createThrottledPersistStorage),

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
 * rehydratePersistedClusterState —— 客户端手动水合入口（Promise 幂等）。
 *
 * 【调用契约】必须在客户端根组件的 useEffect 中调用一次：
 *   useEffect(() => { void rehydratePersistedClusterState(); }, []);
 * 此时首帧 HTML 已提交，从 localStorage 读出的持久化字段以正常 React
 * 更新通道合并进 Store，不会产生水合不匹配。
 *
 * 【为何用 Promise 守卫而非布尔标志】
 * 原实现用 `let hasRehydrated = false`：第一次调用立刻把标志置 true，
 * 然后才发起异步 rehydrate。这留下一段危险窗口——若 StrictMode 在
 * rehydrate 尚未 resolve 时双调用，第二次会被标志挡住，
 * 而**此时真实水合可能还没完成**，依赖水合结果的组件会读到默认值并永久
 * 停留（标志已是 true，不会再有第二次机会）。
 *
 * 改为缓存 Promise 后，第二次调用拿到的是**同一个 Promise**，
 * 它可以 await 到真正的完成时刻，而不是被"已调用过"误导。
 * 这同时保证：无论调用多少次，落盘的 rehydrate 只执行一次。
 *
 * 【严禁把标记写入 localStorage】曾考虑用 localStorage 记录
 * "已水合过"，但那是错误的：标记与实际数据生命周期不同步——
 * 用户清空浏览器数据、无痕模式、或数据被外部修改时，
 * 标记仍存在会让应用**永久跳过水合**，表现为"设置全部丢失且无法恢复"。
 * 模块级 Promise 只活在当前页面生命周期内，与数据同生共死，才是正确粒度。
 */
let rehydrationPromise: Promise<void> | null = null;

export function rehydratePersistedClusterState(): Promise<void> {
  /* 已发起过 → 复用同一个 Promise（StrictMode 双挂载 / 多组件调用皆安全） */
  const existing = rehydrationPromise;
  if (existing !== null) return existing;

  const task = (async (): Promise<void> => {
    try {
      await useClusterStore.persist.rehydrate();
      const { terminalLogs } = useClusterStore.getState();
      if (terminalLogs.length > 0) {
        useClusterStore
          .getState()
          .appendTerminalLog('[system] persisted session state rehydrated from localStorage');
      }
    } catch {
      /* 旧缓存解析失败 / storage 被禁用 → 用默认值继续，绝不中断挂载 */
      useClusterStore
        .getState()
        .appendTerminalLog('[system] WARN persisted state rehydration failed → using defaults');
    }
  })();

  rehydrationPromise = task;
  return task;
}

