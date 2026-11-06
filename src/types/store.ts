/**
 * KubeVision AI — 双轨状态管理系统类型契约（唯一类型源）
 *
 * 【契约】依据 AGENTS.md 第 2 条：所有 Zustand Store 状态与 Action 签名
 * 必须严格引用 src/types/ 下的接口定义，禁止 any / @ts-ignore。
 *
 * 【双轨架构设计意图】
 * 轨道一（瞬态轨）：TelemetryTransientRef —— 模块级可变单例 + Float32Array，
 *   高频遥测（1Hz 快照 × 60FPS 插值）绕过 React 协调器直达 R3F useFrame，
 *   零组件重渲染（AGENTS.md 第 3 条 60FPS 红线）。
 * 轨道二（响应轨）：ClusterState / ClusterActions —— zustand persist Store，
 *   仅承载低频 UI 状态（选中态、面板开关、终端日志等），React 订阅重渲染。
 * 两轨以「快照引用」为唯一交汇点：syncSnapshotToTransientRef 写瞬态轨，
 * setSnapshotSummary 以 ≥1s 节流写响应轨，互不越界。
 */

import type { ChaosScenario, PodStatus, TelemetrySnapshot } from '@/types/cluster';

/* ========================================================================== */
/* 轨道一：瞬态引用池（useTelemetryRef.ts）                                     */
/* ========================================================================== */

/**
 * 性能 HUD 瞬态指标（每帧由 R3F 渲染循环写入，HUD 以 rAF 节流读取）。
 *
 * 【字段语义】
 * - fps：滚动窗口帧率（帧/秒）
 * - frameTimeMs：单帧 CPU+GPU 提交耗时（毫秒）
 * - drawCalls / triangles：WebGLRenderer.info.render 透传值
 * - sseLatencyMs：相邻两帧的到达间隔（毫秒，滚动均值）。
 *   理想值 ≈1000ms（服务端 1Hz 推送）。**注意语义**：这不是网络 RTT——
 *   SSE 帧未携带服务端发送时间戳，无法测真往返延迟，故本字段如实反映
 *   「收帧节奏抖动」：显著 >1000 表示推送延迟累积，显著 <1000 表示
 *   客户端本地降级引擎接管。由 useTelemetryStream 的 recordFrameLatency 写入。
 * - workerStatus：端侧推理 Worker 的运行状态串（'INITIALIZING (WebGPU)' /
 *   'READY (WASM)' / 'INFERENCING' / 'ERROR'），由 useEdgeLogClassifier
 *   在收到 Worker 的 status 消息时原地写入。注意它是**状态机当前态**
 *   而非进度——进度恒为 100% 后，状态仍会在 READY 与 INFERENCING 之间往返。
 *   字段名为历史兼容保留（原为模拟引擎 Worker 预留）。
 *
 * 【可变性说明】本接口字段刻意不加 readonly —— 瞬态轨的全部意义即
 * 每帧原地突变（mutable in-place），任何不可变拷贝都会触发 GC 压力。
 */
export interface GlStatsSnapshot {
  fps: number;
  frameTimeMs: number;
  drawCalls: number;
  triangles: number;
  sseLatencyMs: number;
  workerStatus: string;
}

/**
 * 遥测瞬态引用池 —— 全局单例可变对象（非 React 状态、非 zustand）。
 *
 * 【容量契约】Float32Array 按 MAX_PODS=48 / MAX_NODES=3 预分配定长，
 * Pod/Node 按快照数组下标 i 一一映射槽位；实际数量 ≤ 容量时，
 * 越界槽位由 syncSnapshotToTransientRef 清零防幽灵数据。
 * 48 = 3 机架 × 16 槽位的物理上限（见 spatialLayout.ts 槽位契约）。
 *
 * 【插值契约】podCpu/podMem 为「目标值」（每次快照同步阶跃写入），
 * podSmoothCpu 为「渲染当前值」（useFrame 内指数平滑逼近目标），
 * 二者分离使 InstancedMesh 颜色/高度变化呈现 60FPS 连续渐变而非 1Hz 跳变。
 *
 * 【可变性说明】同 GlStatsSnapshot：瞬态轨字段不加 readonly。
 */
export interface TelemetryTransientRef {
  /** 最新快照引用（整体替换，严禁原地修改快照内容） */
  snapshot: TelemetrySnapshot;
  /** 每个 Pod 的 CPU 实时目标值。长度恒为 MAX_PODS(48)，@range 每项 [0, 100] */
  podCpuFloat32: Float32Array;
  /** 每个 Pod 的内存实时目标值。长度恒为 MAX_PODS(48)，@range 每项 [0, 100] */
  podMemFloat32: Float32Array;
  /** CPU 平滑插值当前值（useFrame 消费/回写）。长度恒为 MAX_PODS(48) */
  podSmoothCpuFloat32: Float32Array;
  /** 节点网络吞吐目标值（Mbps）。长度恒为 MAX_NODES(3) */
  nodeNetFloat32: Float32Array;
  /** 性能 HUD 瞬态指标（渲染循环每帧写入） */
  glStats: GlStatsSnapshot;
}

/* ========================================================================== */
/* 轨道二：响应式 UI 状态（useClusterStore.ts）                                 */
/* ========================================================================== */

/** 选中实体类型三态 + MASTER 全息投影（null 表示无选中） */
export type SelectedEntityType = 'master' | 'node' | 'pod';

/** 数据源模式：demo 本地模拟引擎 / live 真实集群 SSE 推送 */
export type ConnectionMode = 'demo' | 'live';

/** 右侧抽屉页签：copilot 智能副驾 / auditor 端侧日志审计台 */
export type RightPanelTab = 'copilot' | 'auditor';

/** Pod 状态过滤器：五态 + ALL 全量 */
export type StatusFilter = PodStatus | 'ALL';

/**
 * MobileViewKey —— 小屏（< 1024px）浮动切换栏的二选一视图键。
 *
 * 【状态化缘由】原为 ShellLayout 本地 state；自视口工具条的「多模态快照诊断」
 * 需要在移动端也真正唤醒 Copilot 视图后，提升为 Store 状态——
 * triggerQuickPrompt 会将其联动切至 'copilot'，跨组件（画布工具条 → 外壳）
 * 的视图唤醒只有经 Store 才能贯通。定义随状态契约迁入本文件，
 * layout.ts 以再导出维持既有 import 兼容。
 */
export type MobileViewKey = 'topology' | 'copilot';

/**
 * 自愈动作历史记录条目（持久化字段，跨会话留存审计）。
 *
 * 【字段说明】actionType 采用开放 string 而非 RemediationActionType 枚举：
 * 历史需兼容 MCP 工具白名单（restart_pod / scale_deployment / drain_node）
 * 之外由 Agent 动态扩展的动作名，审计记录宁可宽松不可丢条目。
 */
export interface RemediationRecord {
  /** 记录唯一标识 */
  readonly id: string;
  /** 执行时刻，ISO 8601 字符串 */
  readonly timestamp: string;
  /** 目标实体 ID（Pod/Node 弱引用） */
  readonly targetId: string;
  /** 动作类型（通常取值为 RemediationActionType，开放 string 兼容扩展） */
  readonly actionType: string;
}

/**
 * Cluster 响应式状态切片 —— 仅低频 UI 状态，严禁写入高频遥测数值。
 *
 * 【SSR 契约】所有初始值必须为确定性字面量（快照引用 INITIAL_CLUSTER_SNAPSHOT、
 * 空集合、固定字符串），配合 persist.skipHydration=true 与客户端根组件
 * useEffect 手动 rehydrate()，杜绝水合不匹配（AGENTS.md 第 4 条）。
 */
export interface ClusterState {
  /** 低频 HUD 渲染用快照摘要（≥1s 节流整体替换，与瞬态轨解耦） */
  readonly snapshotSummary: TelemetrySnapshot;
  /** 当前选中实体 ID（null = 无选中） */
  readonly selectedEntityId: string | null;
  /** 当前选中实体类型（与 selectedEntityId 同生共死：id 为 null 时必为 null） */
  readonly selectedEntityType: SelectedEntityType | null;
  /** 数据源模式（持久化字段） */
  readonly connectionMode: ConnectionMode;
  /** 当前混沌演练场景（'NONE' = 稳态） */
  readonly activeChaos: ChaosScenario;
  /** Pod 状态过滤器（'ALL' = 不过滤） */
  readonly statusFilter: StatusFilter;
  /** 右侧抽屉当前页签 */
  readonly activeRightTab: RightPanelTab;
  /** 混沌工程控制台模态框开关 */
  readonly isChaosModalOpen: boolean;
  /** 性能 HUD 面板开关 */
  readonly isPerfHudOpen: boolean;
  /**
   * 环绕巡检自动旋转开关（OrbitControls autoRotate 的声明式数据源）。
   * CameraRig 以 autoRotate={isOrbitPatrolActive} 绑定，用户拖拽夺权时
   * 由 CameraRig 侧的 'start' 监听自动关闭（巡检让位于手动操作）。
   */
  readonly isOrbitPatrolActive: boolean;
  /** 小屏（< 1024px）当前视图键（topology / copilot），triggerQuickPrompt 会联动切换 */
  readonly activeMobileView: MobileViewKey;
  /** 底部终端日志行缓冲（运行期上限 200 条 FIFO；持久化仅最近 30 条） */
  readonly terminalLogs: string[];
  /** AI 快捷诊断指令触发载荷（Copilot 消费后置回 null，非持久化） */
  readonly quickPromptTrigger: string | null;
  /** 3D 画布多模态视觉快照 Base64 DataURL（VLM 输入素材，非持久化） */
  readonly capturedViewportDataUrl: string | null;
  /** 自愈免疫时间戳字典：targetId → 最近自愈 epoch 毫秒（免疫窗口去重依据） */
  readonly healedPodIds: Record<string, number>;
  /** 累计端侧脱敏凭证数（持久化字段，隐私审计角标） */
  readonly totalMaskedSecrets: number;
  /** 历史自愈记录（持久化字段，全量跨会话留存） */
  readonly remediationHistory: RemediationRecord[];
}

/**
 * Cluster Action 契约 —— 全部为同步纯状态迁移，禁止在 Action 内做
 * fetch / Worker 通信等副作用编排（副作用属于后续轮次的引擎层职责）。
 */
export interface ClusterActions {
  /** 选中实体（entityId=null 即取消选中，entityType 同步清空） */
  selectEntity: (entityId: string | null, entityType?: SelectedEntityType | null) => void;
  /** 切换 demo/live 数据源模式 */
  setConnectionMode: (mode: ConnectionMode) => void;
  /** 触发/解除混沌工程场景 */
  setActiveChaos: (scenario: ChaosScenario) => void;
  /**
   * 执行自愈动作回写：登记免疫时间戳 + 追加历史记录 + 终端审计日志。
   * @param targetId 目标实体 ID
   * @param actionType 动作类型（通常为 RemediationActionType 取值）
   */
  healEntity: (targetId: string, actionType: string) => void;
  /** 设置/清除 3D 视口多模态截图（dataUrl=null 即清除） */
  setCapturedViewport: (dataUrl: string | null) => void;
  /** 累加端侧脱敏计数（负数/小数防御：截断为非负整数） */
  incrementMaskedSecrets: (count: number) => void;
  /** 追加底部终端日志（运行期 FIFO 上限 200 条） */
  appendTerminalLog: (line: string) => void;
  /**
   * 仅清空终端滚动日志（保留 connectionMode / totalMaskedSecrets /
   * remediationHistory 等全部持久化数据），并写入一条清屏回执。
   *
   * 【为何与 clearPersistedHistory 分开】用户点终端上的「清屏」只想清掉
   * 屏幕上滚动的几行日志，若顺带清掉持久化审计数据就是数据丢失事故。
   */
  clearTerminalLogs: () => void;
  /** 触发 AI 快捷诊断指令（自动将右侧抽屉切换至 copilot 页签；小屏联动切至 copilot 视图） */
  triggerQuickPrompt: (prompt: string) => void;
  /** 手动切换右侧抽屉页签（copilot / auditor） */
  setActiveRightTab: (tab: RightPanelTab) => void;
  /** 切换环绕巡检自动旋转（视口工具条 / CameraRig 拖拽让位共用） */
  setOrbitPatrolActive: (active: boolean) => void;
  /** 切换小屏视图（底部浮动切换栏；triggerQuickPrompt 亦会调用） */
  setActiveMobileView: (view: MobileViewKey) => void;
  /** 消费侧复位快捷指令载荷（Copilot 读取后置回 null，防重复触发） */
  clearQuickPrompt: () => void;
  /** 一键重置本地持久化缓存（clearStorage + 持久化字段回归初始值） */
  clearPersistedHistory: () => void;
  /** 低频快照摘要写入口（模拟引擎 ≥1s 节流调用，高频轨走瞬态引用） */
  setSnapshotSummary: (snapshot: TelemetrySnapshot) => void;
  /** 设置 Pod 状态过滤器 */
  setStatusFilter: (filter: StatusFilter) => void;
  /** 混沌控制台模态框开关 */
  setChaosModalOpen: (open: boolean) => void;
  /** 性能 HUD 面板开关 */
  setPerfHudOpen: (open: boolean) => void;
}

/** useClusterStore 的完整 Store 类型（状态切片 + Action 契约） */
export type ClusterStore = ClusterState & ClusterActions;

/**
 * 持久化白名单切片 —— partialize 的唯一合法输出形状。
 *
 * 【隐私与体积契约】只落盘 4 个跨会话字段：connectionMode（用户偏好）、
 * totalMaskedSecrets（审计累计）、remediationHistory（自愈审计）、
 * terminalLogs（仅最近 30 条，防 localStorage 5MB 配额膨胀）。
 * 快照、选中态、截图 DataURL（可达数 MB）等一律不持久化。
 */
export interface PersistedClusterState {
  readonly connectionMode: ConnectionMode;
  readonly totalMaskedSecrets: number;
  readonly remediationHistory: RemediationRecord[];
  readonly terminalLogs: string[];
}
