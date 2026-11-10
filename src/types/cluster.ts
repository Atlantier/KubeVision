/**
 * KubeVision AI — 集群领域全局严格类型契约（唯一类型源）
 *
 * 【契约】依据 AGENTS.md 第 2 条：禁止 any / @ts-ignore；所有组件 Props、
 * Zustand Store、API Route 载荷、SSE/NDJSON 流事件必须严格引用本文件接口。
 *
 * 【设计意图】
 * 1. 全部实体字段使用 readonly，强制「不可变快照」数据流：每一轮遥测 tick
 *    生成全新的 TelemetrySnapshot，Zustand 以整体替换方式提交，
 *    杜绝 R3F useFrame 渲染循环中意外共享可变引用导致的状态漂移。
 * 2. 数值区间约束（rackIndex ∈ {0,1,2}、slotIndex ∈ [0,15]、usage ∈ [0,100] 等）
 *    通过「字面量联合类型（可编译期穷举的维度）+ JSDoc @range 标注（连续数值维度）」
 *    双重表达：rackIndex 用字面量联合在编译期锁死机架数量；
 *    连续百分比区间无法用 TS 原生表达，以 JSDoc 契约标注，
 *    运行期由模拟引擎/校验层（zod schema，后续轮次）保证。
 * 3. cpuHistory / memHistory 固定保留最近 6 个时间点，供 3D 柱状历史环与
 *    Copilot 趋势分析消费，长度契约见 JSDoc。
 */

/* ========================================================================== */
/* 基础状态枚举                                                                */
/* ========================================================================== */

/**
 * Pod 生命周期状态五态模型（K8s 真实状态的可视化收敛投影）：
 * - Running           → 正常态（emerald-400）
 * - Pending           → 调度中（cyan-400 呼吸态）
 * - CrashLoopBackOff  → 崩溃循环（rose-500 脉冲告警）
 * - OOMKilled         → 内存溢出击杀（rose-500 + 特殊徽标）
 * - Terminating       → 优雅退出中（slate-500 半透明）
 */
export type PodStatus = 'Running' | 'Pending' | 'CrashLoopBackOff' | 'OOMKilled' | 'Terminating';

/**
 * Worker 节点状态三态模型：
 * - Ready             → 健康（emerald-400）
 * - HighLoad          → 高负载（amber-400，CPU/内存水位越限或网络拥塞）
 * - NetworkPartition  → 网络分区（rose-500，与集群失联，脑裂渲染态）
 */
export type NodeStatus = 'Ready' | 'HighLoad' | 'NetworkPartition';

/**
 * 混沌工程演练场景枚举（前端模拟引擎的故障注入开关）：
 * - NONE             → 无演练，稳态集群
 * - POD_OOM_SWARM    → Pod OOM 集群性爆发（批量 OOMKilled + P0 告警风暴）
 * - NODE_CPU_SPIKE   → 节点 CPU 尖峰（HighLoad 蔓延 + QPS 抖动）
 * - NET_PACKET_LOSS  → 网络丢包（NetworkPartition 分区 + 遥测延迟上升）
 */
export type ChaosScenario = 'NONE' | 'POD_OOM_SWARM' | 'NODE_CPU_SPIKE' | 'NET_PACKET_LOSS';

/**
 * 告警等级三级模型（SRE 通用分级）：
 * - P0 → 致命（服务不可用，rose-500 + 全屏脉冲）
 * - P1 → 严重（功能降级，amber-400）
 * - P2 → 警告（潜在风险，cyan-400）
 */
export type AlertLevel = 'P0' | 'P1' | 'P2';

/**
 * 机架索引字面量联合：数据中心 3 机架布局（A/B/C），
 * 编译期锁死取值域 {0, 1, 2}，3D 空间布局算法（spatialLayout.ts）
 * 依此计算 X 轴机架偏移，任何越界赋值在 tsc 阶段即被拦截。
 */
export type RackIndex = 0 | 1 | 2;

/* ========================================================================== */
/* UI 底座自检类型（第 1 轮遗留，page.tsx 占位页消费，保留以维持单一类型源）      */
/* ========================================================================== */

/**
 * 节点健康状态三态模型（与 tailwind.config.ts status 语义色一一对应）：
 * - healthy  → emerald-400 正常态
 * - warning  → amber-400 高负载态
 * - critical → rose-500 崩溃态
 *
 * 该联合类型同时驱动：状态徽标 CSS 类映射、InstancedMesh 实例着色、
 * Copilot 告警文案分级。集中定义保证三处消费永不漂移。
 */
export type NodeHealthStatus = 'healthy' | 'warning' | 'critical';

/** 初始化自检清单条目：label 展示文案 + status 徽标状态 */
export interface BootstrapChecklistItem {
  readonly label: string;
  readonly status: NodeHealthStatus;
}

/* ========================================================================== */
/* 告警实体                                                                    */
/* ========================================================================== */

/**
 * 告警事件实体 —— 集群异常的统一载荷。
 *
 * 【流转路径】模拟引擎产出 → TelemetrySnapshot.activeAlerts →
 * Zustand 告警面板 / 3D 场景告警光柱 / Copilot 上下文注入（RAG 检索的 query 素材）。
 * entityId 采用「弱引用」设计：指向 PodEntity.id 或 WorkerNodeEntity.id，
 * 消费方按实体类型自行解析，避免联合类型带来的窄化负担。
 */
export interface AlertEvent {
  /** 告警唯一标识（UUID v4） */
  readonly id: string;
  /** 触发时刻，ISO 8601 字符串（如 '2026-11-05T16:00:00.000Z'） */
  readonly timestamp: string;
  /** 告警等级：P0 致命 / P1 严重 / P2 警告 */
  readonly level: AlertLevel;
  /** 关联实体 ID（PodEntity.id 或 WorkerNodeEntity.id，弱引用） */
  readonly entityId: string;
  /** 关联实体展示名（冗余存储，告警面板免二次查表） */
  readonly entityName: string;
  /** 人类可读告警摘要（中文，供 Copilot prompt 直接注入） */
  readonly message: string;
}

/* ========================================================================== */
/* 集群实体                                                                    */
/* ========================================================================== */

/**
 * Pod 实体 —— 3D 场景中最小渲染单元（InstancedMesh 实例）。
 *
 * 【空间定位契约】(rackIndex, slotIndex) 二维坐标唯一确定 Pod 在
 * 数据中心网格中的逻辑位置：rackIndex ∈ {0,1,2} 选定机架（X 轴），
 * slotIndex ∈ [0,15] 选定机架内槽位（Y 轴层位，每机架 16 槽），
 * spatialLayout.ts 依此计算世界坐标矩阵，保证 537 个 Pod 实例零重叠。
 *
 * 【历史序列契约】cpuHistory / memHistory 恒为最近 6 个采样点
 * （索引 0 最旧、5 最新，FIFO 滚动窗口），驱动 Pod 头顶的历史趋势环渲染。
 */
export interface PodEntity {
  /** Pod 唯一标识（形如 'pod-checkout-service-7d9f8b6c4-xk2mv'） */
  readonly id: string;
  /** Pod 展示名（K8s metadata.name） */
  readonly name: string;
  /** 所属命名空间（K8s metadata.namespace，如 'production' / 'staging'） */
  readonly namespace: string;
  /** 调度宿主节点 ID（WorkerNodeEntity.id 弱引用） */
  readonly nodeId: string;
  /** 机架索引，取值域 {0, 1, 2}（编译期字面量联合锁死） */
  readonly rackIndex: RackIndex;
  /** 机架内槽位索引。@range [0, 15] 整数，每机架 16 个槽位 */
  readonly slotIndex: number;
  /** Pod 生命周期状态（五态模型，驱动实例着色） */
  readonly status: PodStatus;
  /** CPU 使用率百分比。@range [0, 100] */
  readonly cpuUsage: number;
  /** 内存使用率百分比。@range [0, 100] */
  readonly memoryUsage: number;
  /** 容器累计重启次数（CrashLoopBackOff 判定的核心信号） */
  readonly restarts: number;
  /** Pod 集群内 IP（形如 '10.244.1.15'） */
  readonly ip: string;
  /** 创建时刻，ISO 8601 字符串 */
  readonly createdAt: string;
  /** 最近 6 个时间点的 CPU 使用率历史序列（FIFO，索引 5 为当前值）。@range 每项 [0, 100]，长度恒为 6 */
  readonly cpuHistory: number[];
  /** 最近 6 个时间点的内存使用率历史序列（FIFO，索引 5 为当前值）。@range 每项 [0, 100]，长度恒为 6 */
  readonly memHistory: number[];
}

/**
 * Worker 节点实体 —— 3D 场景中的机架服务器渲染单元。
 *
 * 【容量与水位】cpuCapacity / memCapacity 为节点可分配总量（核数 / GiB），
 * cpuUsage / memUsage 为百分比水位（[0,100]），HighLoad 判定依据
 * 水位越限阈值（后续轮次由模拟引擎契约固化，建议 ≥ 85 触发）。
 * podIds 为反向索引：节点 → 挂载 Pod 列表，与 PodEntity.nodeId 双向一致，
 * 供「点击节点高亮其全部 Pod」的射线交互 O(1) 查询。
 */
export interface WorkerNodeEntity {
  /** 节点唯一标识（形如 'node-worker-a-01'） */
  readonly id: string;
  /** 节点展示名（K8s node metadata.name） */
  readonly name: string;
  /** 节点内网 IP（形如 '192.168.10.21'） */
  readonly ip: string;
  /** 节点状态（三态模型，驱动机架主体着色与分区特效） */
  readonly status: NodeStatus;
  /** CPU 可分配总容量（核） */
  readonly cpuCapacity: number;
  /** 内存可分配总容量（GiB） */
  readonly memCapacity: number;
  /** CPU 使用率百分比水位。@range [0, 100] */
  readonly cpuUsage: number;
  /** 内存使用率百分比水位。@range [0, 100] */
  readonly memUsage: number;
  /** 实时网络吞吐量（Mbps，双向合计，驱动节点间流量粒子带渲染） */
  readonly networkMbps: number;
  /** 机架索引，取值域 {0, 1, 2}（与 PodEntity.rackIndex 同一坐标系） */
  readonly rackIndex: RackIndex;
  /** 挂载的 Pod ID 列表（反向索引，与 PodEntity.nodeId 双向一致） */
  readonly podIds: string[];
}

/* ========================================================================== */
/* 遥测快照                                                                    */
/* ========================================================================== */

/**
 * 遥测快照 —— 单个 tick 的集群全量状态（不可变值对象）。
 *
 * 【数据流】模拟引擎每 tick（建议 1000ms）产出一份完整快照 →
 * SSE/NDJSON 推送或本地 setState → Zustand 整体替换（不做深合并）→
 * 3D 场景经 useTelemetryRef 瞬态引用消费（绕过 React 重渲染，
 * AGENTS.md 第 3 条 60FPS 红线）。
 *
 * 【健康分契约】clusterHealthScore ∈ [0, 100] 由加权算法聚合
 * （节点状态权重 > Pod 状态权重 > 告警等级惩罚），后续轮次在
 * 模拟引擎中以中文 JSDoc 固化公式。
 */
export interface TelemetrySnapshot {
  /** 快照生成时刻，Unix epoch 毫秒时间戳（数值型，便于时序差分计算） */
  readonly timestamp: number;
  /**
   * 遥测 schema 版本号（当前为 {@link TELEMETRY_SCHEMA_VERSION}）。
   *
   * 【为什么快照必须带版本】SSE 是长连接、前后端可能不同版本并存
   * （页面缓存了旧 bundle、服务端已升级；或反向代理混入了旧帧）。
   * 若不校验版本，旧字段名/旧语义会被当成合法数据渲染，
   * 表现为「画面在动但数值明显不对」——比直接报错更难排查。
   *
   * 【客户端契约】版本缺失或高于客户端支持版本时，进入**只读降级**：
   * 停止应用新帧（保留最后一帧合法画面）并在 HUD 明确提示，
   * 而不是猜测字段含义继续画。
   */
  readonly schemaVersion: number;
  /** 集群综合健康分。@range [0, 100]，100 为完全健康 */
  readonly clusterHealthScore: number;
  /** 集群入口总 QPS（每秒请求数，驱动全局流量粒子密度） */
  readonly totalQps: number;
  /** 全量 Worker 节点列表 */
  readonly nodes: WorkerNodeEntity[];
  /** 全量 Pod 列表 */
  readonly pods: PodEntity[];
  /** 当前活跃告警列表（已按等级与时间排序：P0 优先、同级新告警在前） */
  readonly activeAlerts: AlertEvent[];
}

/* ========================================================================== */
/* 静态初始种子数据（稳态集群 · 零告警 · SSR/CSR 确定性）                        */
/* ========================================================================== */

/**
 * INITIAL_CLUSTER_SNAPSHOT 构造说明：
 *
 * 【设计意图】为 Zustand Store、混沌模拟引擎与 3D 场景提供第 0 轮确定性初始态：
 * 3 个 Worker 机架节点（worker-alpha/beta/gamma <-> rackIndex 0/1/2）+
 * 24 个真实云原生命名风格 Pod（每节点 8 个，均匀分布）。
 *
 * 【确定性契约】所有字段（含时间戳）均为编译期固定字面量，严禁 Date.now() /
 * Math.random()，保证服务端预渲染与客户端水合得到逐字节一致的快照，
 * 从数据源头杜绝 Hydration Mismatch（AGENTS.md 第 4 条）。
 *
 * 【槽位分布】每机架 16 槽（4 层 × 2×2），种子 Pod 每层取前排两列
 * （slotIndex ∈ {0,1,4,5,8,9,12,13}），垂直方向 4 层均匀铺开、
 * 水平方向双列对称；每层余下两个纵深槽位（j ∈ {2,3}）留作混沌演练扩容位。
 *
 * 【派生一致性】Pod.id 由名称派生（`pod-${name}`）；WorkerNodeEntity.podIds
 * 由 Pod 表按 nodeId 反向聚合生成，与 PodEntity.nodeId 双向一致，零手工冗余。
 */

/**
 * 遥测 schema 版本号（客户端与服务端的兼容契约）。
 *
 * 【版本历史】
 * - v1：初始契约（timestamp / clusterHealthScore / totalQps / nodes / pods / activeAlerts）
 * - v2：新增 schemaVersion 字段本身（本轮），用于后续演进时的版本协商
 *
 * 【兼容策略】客户端只接受 schemaVersion === 本文常量的帧；
 * 缺失（旧帧）或更高（新服务端）一律进入只读降级并提示，
 * 绝不"尽力解析"——错误字段语义比停更危险。
 */
export const TELEMETRY_SCHEMA_VERSION = 2;

/** 种子快照基准时刻：2026-11-05T08:00:00Z（固定常量表达式，纯函数求值，SSR 安全） */
const SEED_TIMESTAMP_MS: number = Date.UTC(2026, 10, 5, 8, 0, 0);

/** 机架索引 → Worker 节点 ID 映射表（与 spatialLayout.ts 的三机架环形拓扑一一对应） */
const NODE_ID_BY_RACK: readonly [string, string, string] = [
  'node-worker-alpha',
  'node-worker-beta',
  'node-worker-gamma',
];

/**
 * Pod 种子条目（内部构造类型）：
 * id 由 name 派生、nodeId 由 rackIndex 查表注入，故不在种子表中冗余存储。
 * cpuHistory / memHistory 采用 6 元组类型，编译期锁死「长度恒为 6」契约，
 * 任何缺项/多项在 tsc 阶段即报错。
 */
interface PodSeedEntry {
  readonly name: string;
  readonly namespace: string;
  readonly rackIndex: RackIndex;
  readonly slotIndex: number;
  readonly status: PodStatus;
  readonly cpuUsage: number;
  readonly memoryUsage: number;
  readonly restarts: number;
  readonly ip: string;
  readonly createdAt: string;
  readonly cpuHistory: readonly [number, number, number, number, number, number];
  readonly memHistory: readonly [number, number, number, number, number, number];
}

/**
 * 24 个 Pod 种子表（每机架 8 个，slotIndex ∈ {0,1,4,5,8,9,12,13}）。
 *
 * 命名遵循 K8s 真实风格三类：
 * Deployment（<name>-<replicaset哈希>-<pod后缀>，如 payment-gateway-7f8b9-x2k）、
 * StatefulSet（<name>-<序号>，如 redis-cluster-shard-0 / kafka-broker-0）、
 * DaemonSet/系统组件（如 coredns-7d5f8-2bx / fluent-bit-x8q2z）。
 * 历史序列为围绕当前水位的确定性微幅波动（索引 5 收敛到当前值），
 * 全部处于健康区间，与稳态零告警的初始叙事一致。
 */
const POD_SEED_TABLE: readonly PodSeedEntry[] = [
  /* ---- 机架 0 · worker-alpha（业务核心区） ---- */
  {
    name: 'payment-gateway-7f8b9-x2k',
    namespace: 'production',
    rackIndex: 0,
    slotIndex: 0,
    status: 'Running',
    cpuUsage: 46,
    memoryUsage: 58,
    restarts: 0,
    ip: '10.244.0.11',
    createdAt: '2026-11-04T23:41:07.000Z',
    cpuHistory: [41, 44, 47, 43, 45, 46],
    memHistory: [54, 55, 57, 56, 57, 58],
  },
  {
    name: 'auth-sso-6c9d4-m8p',
    namespace: 'production',
    rackIndex: 0,
    slotIndex: 1,
    status: 'Running',
    cpuUsage: 38,
    memoryUsage: 44,
    restarts: 0,
    ip: '10.244.0.12',
    createdAt: '2026-11-04T23:41:12.000Z',
    cpuHistory: [34, 36, 39, 35, 37, 38],
    memHistory: [41, 42, 43, 42, 43, 44],
  },
  {
    name: 'order-service-5d7c8-q4z',
    namespace: 'production',
    rackIndex: 0,
    slotIndex: 4,
    status: 'Running',
    cpuUsage: 52,
    memoryUsage: 61,
    restarts: 0,
    ip: '10.244.0.13',
    createdAt: '2026-11-05T01:07:33.000Z',
    cpuHistory: [47, 49, 54, 50, 51, 52],
    memHistory: [57, 58, 62, 59, 60, 61],
  },
  {
    name: 'inventory-api-8b3f2-j7n',
    namespace: 'production',
    rackIndex: 0,
    slotIndex: 5,
    status: 'Running',
    cpuUsage: 33,
    memoryUsage: 47,
    restarts: 0,
    ip: '10.244.0.14',
    createdAt: '2026-11-05T01:07:41.000Z',
    cpuHistory: [30, 32, 35, 31, 34, 33],
    memHistory: [44, 45, 46, 45, 46, 47],
  },
  {
    name: 'ingress-nginx-controller-lm4t7',
    namespace: 'ingress-nginx',
    rackIndex: 0,
    slotIndex: 8,
    status: 'Running',
    cpuUsage: 61,
    memoryUsage: 52,
    restarts: 0,
    ip: '10.244.0.21',
    createdAt: '2026-11-04T22:15:02.000Z',
    cpuHistory: [55, 58, 63, 59, 60, 61],
    memHistory: [49, 50, 52, 50, 51, 52],
  },
  {
    name: 'kafka-broker-0',
    namespace: 'middleware',
    rackIndex: 0,
    slotIndex: 9,
    status: 'Running',
    cpuUsage: 57,
    memoryUsage: 68,
    restarts: 0,
    ip: '10.244.0.31',
    createdAt: '2026-11-04T22:18:47.000Z',
    cpuHistory: [52, 55, 59, 56, 58, 57],
    memHistory: [64, 65, 67, 66, 67, 68],
  },
  {
    name: 'prometheus-server-0',
    namespace: 'observability',
    rackIndex: 0,
    slotIndex: 12,
    status: 'Running',
    cpuUsage: 44,
    memoryUsage: 71,
    restarts: 0,
    ip: '10.244.0.41',
    createdAt: '2026-11-03T09:26:15.000Z',
    cpuHistory: [40, 42, 46, 43, 45, 44],
    memHistory: [68, 69, 72, 70, 71, 71],
  },
  {
    name: 'grafana-6f9d8b-t3v',
    namespace: 'observability',
    rackIndex: 0,
    slotIndex: 13,
    status: 'Running',
    cpuUsage: 12,
    memoryUsage: 26,
    restarts: 0,
    ip: '10.244.0.42',
    createdAt: '2026-11-03T09:26:41.000Z',
    cpuHistory: [9, 11, 14, 10, 13, 12],
    memHistory: [24, 25, 27, 25, 26, 26],
  },

  /* ---- 机架 1 · worker-beta（中间件与数据区） ---- */
  {
    name: 'redis-cluster-shard-0',
    namespace: 'middleware',
    rackIndex: 1,
    slotIndex: 0,
    status: 'Running',
    cpuUsage: 29,
    memoryUsage: 63,
    restarts: 0,
    ip: '10.244.1.11',
    createdAt: '2026-11-04T22:20:05.000Z',
    cpuHistory: [26, 28, 31, 27, 30, 29],
    memHistory: [60, 61, 63, 62, 62, 63],
  },
  {
    name: 'redis-cluster-shard-1',
    namespace: 'middleware',
    rackIndex: 1,
    slotIndex: 1,
    status: 'Running',
    cpuUsage: 31,
    memoryUsage: 66,
    restarts: 0,
    ip: '10.244.1.12',
    createdAt: '2026-11-04T22:20:09.000Z',
    cpuHistory: [28, 30, 33, 29, 32, 31],
    memHistory: [63, 64, 66, 65, 65, 66],
  },
  {
    name: 'user-profile-svc-4e8a1-b9c',
    namespace: 'production',
    rackIndex: 1,
    slotIndex: 4,
    status: 'Running',
    cpuUsage: 41,
    memoryUsage: 49,
    restarts: 0,
    ip: '10.244.1.13',
    createdAt: '2026-11-05T00:52:18.000Z',
    cpuHistory: [37, 39, 43, 40, 42, 41],
    memHistory: [46, 47, 49, 48, 48, 49],
  },
  {
    name: 'cart-service-9f2e6-d5h',
    namespace: 'production',
    rackIndex: 1,
    slotIndex: 5,
    status: 'Running',
    cpuUsage: 37,
    memoryUsage: 43,
    restarts: 0,
    ip: '10.244.1.14',
    createdAt: '2026-11-05T00:52:26.000Z',
    cpuHistory: [33, 35, 39, 36, 38, 37],
    memHistory: [40, 41, 43, 42, 42, 43],
  },
  {
    name: 'checkout-worker-3a7b9-r2m',
    namespace: 'production',
    rackIndex: 1,
    slotIndex: 8,
    status: 'Running',
    cpuUsage: 55,
    memoryUsage: 58,
    restarts: 0,
    ip: '10.244.1.15',
    createdAt: '2026-11-05T00:52:34.000Z',
    cpuHistory: [50, 52, 57, 54, 56, 55],
    memHistory: [55, 56, 58, 57, 57, 58],
  },
  {
    name: 'zookeeper-0',
    namespace: 'middleware',
    rackIndex: 1,
    slotIndex: 9,
    status: 'Running',
    cpuUsage: 22,
    memoryUsage: 51,
    restarts: 0,
    ip: '10.244.1.31',
    createdAt: '2026-11-04T22:19:12.000Z',
    cpuHistory: [19, 21, 24, 20, 23, 22],
    memHistory: [48, 49, 51, 50, 50, 51],
  },
  {
    name: 'elasticsearch-data-1',
    namespace: 'observability',
    rackIndex: 1,
    slotIndex: 12,
    status: 'Running',
    cpuUsage: 64,
    memoryUsage: 77,
    restarts: 0,
    ip: '10.244.1.41',
    createdAt: '2026-11-04T20:05:33.000Z',
    cpuHistory: [59, 61, 66, 62, 65, 64],
    memHistory: [74, 75, 78, 76, 76, 77],
  },
  {
    name: 'fluent-bit-x8q2z',
    namespace: 'logging',
    rackIndex: 1,
    slotIndex: 13,
    status: 'Running',
    cpuUsage: 9,
    memoryUsage: 18,
    restarts: 0,
    ip: '10.244.1.51',
    createdAt: '2026-11-04T20:06:01.000Z',
    cpuHistory: [7, 8, 10, 8, 9, 9],
    memHistory: [16, 17, 18, 17, 17, 18],
  },

  /* ---- 机架 2 · worker-gamma（智能计算与平台区） ---- */
  {
    name: 'notification-hub-2c6d5-w7j',
    namespace: 'production',
    rackIndex: 2,
    slotIndex: 0,
    status: 'Running',
    cpuUsage: 27,
    memoryUsage: 39,
    restarts: 0,
    ip: '10.244.2.11',
    createdAt: '2026-11-05T02:11:47.000Z',
    cpuHistory: [24, 26, 29, 25, 28, 27],
    memHistory: [36, 37, 39, 38, 38, 39],
  },
  {
    name: 'search-indexer-8e4f3-p6t',
    namespace: 'production',
    rackIndex: 2,
    slotIndex: 1,
    status: 'Running',
    cpuUsage: 49,
    memoryUsage: 55,
    restarts: 0,
    ip: '10.244.2.12',
    createdAt: '2026-11-05T02:11:55.000Z',
    cpuHistory: [44, 46, 51, 47, 50, 49],
    memHistory: [52, 53, 55, 54, 54, 55],
  },
  {
    name: 'recommendation-ml-5b9c2-k4d',
    namespace: 'ai-workloads',
    rackIndex: 2,
    slotIndex: 4,
    status: 'Running',
    cpuUsage: 73,
    memoryUsage: 81,
    restarts: 0,
    ip: '10.244.2.13',
    createdAt: '2026-11-05T03:40:22.000Z',
    cpuHistory: [68, 70, 75, 71, 74, 73],
    memHistory: [78, 79, 82, 80, 80, 81],
  },
  {
    name: 'postgres-primary-0',
    namespace: 'middleware',
    rackIndex: 2,
    slotIndex: 5,
    status: 'Running',
    cpuUsage: 42,
    memoryUsage: 64,
    restarts: 0,
    ip: '10.244.2.31',
    createdAt: '2026-11-04T22:21:30.000Z',
    cpuHistory: [38, 40, 44, 41, 43, 42],
    memHistory: [61, 62, 64, 63, 63, 64],
  },
  {
    name: 'mongodb-replica-2',
    namespace: 'middleware',
    rackIndex: 2,
    slotIndex: 8,
    status: 'Running',
    cpuUsage: 35,
    memoryUsage: 59,
    restarts: 0,
    ip: '10.244.2.32',
    createdAt: '2026-11-04T22:21:58.000Z',
    cpuHistory: [31, 33, 37, 34, 36, 35],
    memHistory: [56, 57, 59, 58, 58, 59],
  },
  {
    name: 'vault-agent-injector-h3n9s',
    namespace: 'platform',
    rackIndex: 2,
    slotIndex: 9,
    status: 'Running',
    cpuUsage: 6,
    memoryUsage: 12,
    restarts: 0,
    ip: '10.244.2.61',
    createdAt: '2026-11-04T19:58:09.000Z',
    cpuHistory: [4, 5, 7, 5, 6, 6],
    memHistory: [10, 11, 12, 11, 11, 12],
  },
  {
    name: 'coredns-7d5f8-2bx',
    namespace: 'kube-system',
    rackIndex: 2,
    slotIndex: 12,
    status: 'Running',
    cpuUsage: 8,
    memoryUsage: 15,
    restarts: 0,
    ip: '10.244.2.71',
    createdAt: '2026-11-04T19:55:00.000Z',
    cpuHistory: [6, 7, 9, 7, 8, 8],
    memHistory: [13, 14, 15, 14, 14, 15],
  },
  {
    name: 'jaeger-collector-4c2e9-v6p',
    namespace: 'observability',
    rackIndex: 2,
    slotIndex: 13,
    status: 'Running',
    cpuUsage: 19,
    memoryUsage: 44,
    restarts: 0,
    ip: '10.244.2.41',
    createdAt: '2026-11-04T20:06:30.000Z',
    cpuHistory: [16, 18, 21, 17, 20, 19],
    memHistory: [41, 42, 44, 43, 43, 44],
  },
];

/**
 * 节点种子条目（内部构造类型）：podIds 由 Pod 表反向聚合派生，不手工维护。
 */
interface NodeSeedEntry {
  readonly id: string;
  readonly name: string;
  readonly ip: string;
  readonly status: NodeStatus;
  readonly cpuCapacity: number;
  readonly memCapacity: number;
  readonly cpuUsage: number;
  readonly memUsage: number;
  readonly networkMbps: number;
  readonly rackIndex: RackIndex;
}

/**
 * 3 个 Worker 机架节点种子（异构容量：alpha/beta 32C128G，gamma 16C64G）。
 *
 * 【CPU/内存水位按"机架角色"差异化】三台节点不是复制品：
 * - worker-alpha（compute，计算型）：CPU 44 / 内存 36 —— CPU 偏高、内存偏低；
 * - worker-beta （memory，内存型） ：CPU 36 / 内存 48 —— 内存偏高、CPU 偏低；
 * - worker-gamma（network，网络型）：CPU 40 / 内存 40 —— 两项居中。
 *
 * 【为什么种子水位就要体现角色】种子的水位是**稳态起点**：
 * 若种子与角色基线不一致，开场前十几秒会出现一段"莫名其妙的下坡/上坡"
 * （从种子值回归到基线）。让种子直接等于角色基线，稳态画面从第一帧起
 * 就有可辨识的个性，也不会出现开场瞬移。
 *
 * 【与调参表的同步契约】这三个数值必须等于
 * `src/constants/telemetryTuning.ts` 里 `NODE_ROLE_PROFILE` 的 cpu/mem。
 * 该一致性由 `scripts/sim-drift.mjs` 在每次运行时校验（不一致直接报错），
 * 避免两处手写数值悄悄漂移。
 */
const NODE_SEED_TABLE: readonly NodeSeedEntry[] = [
  {
    id: 'node-worker-alpha',
    name: 'worker-alpha',
    ip: '192.168.10.11',
    status: 'Ready',
    cpuCapacity: 32,
    memCapacity: 128,
    cpuUsage: 44,
    memUsage: 36,
    networkMbps: 386.4,
    rackIndex: 0,
  },
  {
    id: 'node-worker-beta',
    name: 'worker-beta',
    ip: '192.168.10.12',
    status: 'Ready',
    cpuCapacity: 32,
    memCapacity: 128,
    cpuUsage: 36,
    memUsage: 48,
    networkMbps: 291.7,
    rackIndex: 1,
  },
  {
    id: 'node-worker-gamma',
    name: 'worker-gamma',
    ip: '192.168.10.13',
    status: 'Ready',
    cpuCapacity: 16,
    memCapacity: 64,
    cpuUsage: 40,
    memUsage: 40,
    networkMbps: 164.2,
    rackIndex: 2,
  },
];

/** 由种子表构造的 24 个 Pod 实体（id 派生 + nodeId 查表注入） */
const SEED_PODS: PodEntity[] = POD_SEED_TABLE.map(
  (seed): PodEntity => ({
    id: `pod-${seed.name}`,
    name: seed.name,
    namespace: seed.namespace,
    nodeId: NODE_ID_BY_RACK[seed.rackIndex],
    rackIndex: seed.rackIndex,
    slotIndex: seed.slotIndex,
    status: seed.status,
    cpuUsage: seed.cpuUsage,
    memoryUsage: seed.memoryUsage,
    restarts: seed.restarts,
    ip: seed.ip,
    createdAt: seed.createdAt,
    cpuHistory: [...seed.cpuHistory],
    memHistory: [...seed.memHistory],
  }),
);

/** 由种子表构造的 3 个节点实体（podIds 反向聚合，与 PodEntity.nodeId 双向一致） */
const SEED_NODES: WorkerNodeEntity[] = NODE_SEED_TABLE.map(
  (seed): WorkerNodeEntity => ({
    ...seed,
    podIds: SEED_PODS.filter((pod): boolean => pod.nodeId === seed.id).map(
      (pod): string => pod.id,
    ),
  }),
);

/**
 * INITIAL_CLUSTER_SNAPSHOT —— 全局静态初始遥测快照（本文件唯一运行时常量导出）。
 *
 * 稳态叙事：24 Pod 全 Running、3 节点全 Ready、零活跃告警、健康分满分 100，
 * 为后续混沌演练（ChaosScenario 注入）提供最大化对比基线。
 * 消费方（Zustand Store 初始态 / 3D 场景首帧）应将其视为不可变值对象，
 * 任何更新均以新快照整体替换，严禁原地修改。
 */
export const INITIAL_CLUSTER_SNAPSHOT: TelemetrySnapshot = {
  timestamp: SEED_TIMESTAMP_MS,
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  clusterHealthScore: 100,
  totalQps: 12850,
  nodes: SEED_NODES,
  pods: SEED_PODS,
  activeAlerts: [],
};