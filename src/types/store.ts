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
 * RemediationDiff —— 自愈动作的「修复前后」指标对比快照。
 *
 * 【为什么需要它】自愈目前对用户来说是一个「黑盒按钮」：点下去，3D 场景里
 * 某个盒子从红变绿，终端打一行回执。用户无从判断这次修复**到底改善了多少**——
 * CPU 是从 96% 降到 41%，还是从 92% 降到 88%？没有量化，自愈就只是个动画。
 *
 * 本结构在 healEntity 执行时同时取修复前快照与修复后快照的对应字段，
 * 让卡片可以渲染「96.0% → 41.0%」这样的对比，把一次点击变成一次可验证的改善。
 *
 * 【口径说明】
 * - before* 取自**本次修复动作执行前**的 clusterSummary；
 * - after* 取自 deriveHealedSnapshot 产出的新快照中**同一目标**的对应值；
 * - Node 粒度自愈时，指标取该节点自身的 cpuUsage / memUsage，
 *   status 取节点状态（source 语义在 Node 上是 Ready/NotReady）。
 * 两个时刻的数据同源同口径，差值才有意义。
 */
export interface RemediationDiff {
  /** 目标实体 ID（Pod ID 或 Node ID） */
  readonly targetId: string;
  /** 目标实体展示名（用于卡片标题，避免显示裸 ID） */
  readonly targetName: string;
  /** 本次动作类型（restart_pod / scale_deployment / drain_node 等） */
  readonly actionType: string;
  /** 修复前 CPU 使用率（百分比 0~100） */
  readonly beforeCpu: number;
  /** 修复后 CPU 使用率（百分比 0~100） */
  readonly afterCpu: number;
  /** 修复前内存使用率（百分比 0~100） */
  readonly beforeMem: number;
  /** 修复后内存使用率（百分比 0~100） */
  readonly afterMem: number;
  /** 修复前集群健康分（0~100） */
  readonly beforeHealth: number;
  /** 修复后集群健康分（0~100） */
  readonly afterHealth: number;
  /** 修复前实体状态（Pod 为 PodStatus，Node 为 Ready/NotReady） */
  readonly beforeStatus: string;
  /** 修复后实体状态 */
  readonly afterStatus: string;
  /** 记录时刻，ISO 8601 字符串（与 RemediationRecord.timestamp 同口径） */
  readonly timestamp: string;
}

/**
 * PendingRemediation —— 等待指数退避后重试的自愈任务。
 *
 * 【解决什么】原有的 30s 免疫窗口采用「直接拒绝」策略：窗口内重复触发
 * 只打一行 BLOCKED 日志就丢弃。问题在于——
 * 用户在故障未消除时往往会**连续点击**几次（这是很自然的反应），
 * 这些点击全部被静默丢弃，用户看到的是「点了没反应」。
 *
 * 退避队列把「拒绝」变成「排队」：记录这次请求、给出明确的退避秒数、
 * 让界面能显示「已排队，N 秒后自动重试」。这既保留了防抖动的初衷
 * （不会立刻重复执行），又不让用户的意图凭空消失。
 *
 * 【延迟公式】backoffSec = min(30, 2^(retryCount + 1))
 * 即 2s → 4s → 8s → 16s → 30s（封顶），指数退避让连续点击迅速降频。
 */
export interface PendingRemediation {
  /** 队列条目唯一标识 */
  readonly id: string;
  /** 目标实体 ID */
  readonly targetId: string;
  /** 目标实体展示名 */
  readonly targetName: string;
  /** 动作类型 */
  readonly actionType: string;
  /** 该目标在当前免疫窗口内的第几次重试（0 起） */
  readonly retryCount: number;
  /** 本次计算出的退避秒数（已按 30s 封顶） */
  readonly backoffSec: number;
  /** 入队时刻，ISO 8601 字符串 */
  readonly scheduledAt: string;
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
  /**
   * 导演模式信号：自动路演在走真实 HITL 流程时，允许代用户完成
   * 「勾选风险 → 点击立即执行」两步。
   *
   * 【为何必须是内存态、非持久化】它是"当前正在演示"的运行时标志，
   * 刷新后不该残留；若被持久化，用户下次手动打开卡片会莫名其妙地自动执行。
   */
  /**
   * WebGL 上下文是否已丢失（G 项预检第 5 项，接 R01 的状态）。
   *
   * 【为什么要进 store】R01 之前它在 ClusterCanvas 的局部 state 里，
   * 只有画布自己知道；而启动预检发生在导演引擎侧，必须能读到它。
   * 上下文丢失时画面完全静止，此时启动路演等于演一场静止的戏。
   */
  readonly isGlContextLost: boolean;
  /**
   * 导演是否已绕过动作卡直接执行（C 项）。
   *
   * 【解决什么矛盾】8 秒内动作卡未挂载时导演降级直调 healEntity，而旁白
   * 已在讲"自愈完成"。若卡片随后才挂载，它内部仍是"待执行"态，同一屏会出现
   * 「字幕说已完成 / 卡片说待执行」——规格明令禁止的矛盾。
   * 该标记置位后，后挂载的卡片直接渲染为已执行态。
   */
  readonly demoFallbackExecuted: boolean;

  readonly demoAutoConfirm: boolean;

  /*
   * ===== Copilot 活动状态（A 项）=====
   *
   * 【为什么需要】阶段 3→4 原本靠固定定时器推进，与 AI 流真实进度无关。
   * 改成事件驱动后，导演必须能观察到"流是否结束""动作卡是否已挂载"，
   * 这要求 Copilot 侧把内部事件写到 store 上。
   *
   * 【订阅纪律】全部为低频标量，组件必须用细粒度选择器读取
   * （如 s => s.copilotStreaming），禁止订阅整个 store 对象——
   * 流式增量每秒可达数十次，整树订阅会把渲染打爆。
   */

  /** Copilot 是否正在流式生成（流开始 true；结束/出错/abort false） */
  readonly copilotStreaming: boolean;
  /** 最近一条 assistant 消息 ID（流开始时写入） */
  readonly lastAssistantMessageId: string | null;
  /** 已挂载的动作卡所属消息 ID（动作卡水合完成写入，卸载清空） */
  readonly actionCardMountedId: string | null;
  /**
   * Copilot 流中止请求计数（D 项）。
   *
   * 【为何用自增计数而非布尔】布尔需要"置 true → 消费方复位 false"两次写，
   * 期间第二次请求会被吞掉。自增每次都是新值，消费方观察数值变化即可中止，
   * 天然幂等且不丢请求。
   */
  readonly copilotAbortToken: number;
  /**
   * 环绕巡检是否由程序化方式开启（E 项）。
   *
   * · true  → 编排的一部分，选中态变化**不得**解除；
   * · false → 用户自己开的，进入聚焦时可以解除。
   */
  readonly patrolLockedByProgram: boolean;
  /**
   * 等待退避后重试的自愈队列（非持久化）。
   *
   * 【为何不持久化】退避窗口最长 30s，跨会话留存一个早已过期的重试任务是
   * 有害的——刷新页面后突然自动执行一个几分钟前排队的重启，属于事故。
   * 队列只活在当前会话的内存里。
   */
  readonly pendingRemediations: readonly PendingRemediation[];
  /**
   * 最近一次自愈的前后指标对比（非持久化，仅用于卡片展示）。
   *
   * 【为何不持久化】对比的语义是「刚刚这次修复改善了多少」。
   * 刷新页面后展示上一次会话的修复对比没有意义，反而会让用户误以为
   * 那是刚刚发生的。卡片执行后由 healEntity 写入，卡片重渲染读取。
   */
  readonly lastRemediationDiff: RemediationDiff | null;
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
   * 执行自愈动作回写：登记免疫时间戳 + 追加历史记录 + 计算前后对比 + 终端审计日志。
   *
   * 【免疫窗口行为变更】窗口内重复触发**不再直接丢弃**，而是入队
   * `pendingRemediations` 并计算指数退避秒数，让用户看到"已排队"而非"没反应"。
   *
   * @param targetId 目标实体 ID
   * @param actionType 动作类型（通常为 RemediationActionType 取值）
   */
  healEntity: (targetId: string, actionType: string) => void;
  /**
   * 清空退避队列（用户可手动取消除已排队但尚未到期的重试）。
   *
   * @param targetId 只清除该目标；省略则清除全部
   */
  clearPendingRemediations: (targetId?: string) => void;
  /**
   * 清除最近一次自愈对比（卡片重置/换会话时调用，避免旧对比挂在新卡片上）。
   */
  clearLastRemediationDiff: () => void;
  /**
   * 清空自愈免疫表。
   *
   * 【为何必须有这个入口】`healEntity` 会按 30 秒免疫窗口去重：同一目标
   * 30 秒内重复自愈会被转入退避队列而不是真正执行。自动路演若在 30 秒内
   * 连跑第二遍，第二遍的自愈全部会被免疫窗口吞掉，表现为"路演跑了但没自愈"。
   * 修复前 Store 没有任何清除免疫表的入口，这正是"连跑两遍第二遍失败"的根因。
   */
  clearHealedPodIds: () => void;
  /**
   * 复位「路演临时态」——只清演示期产生的易变数据，不动持久化审计记录。
   *
   * 【清理范围】healedPodIds / pendingRemediations / lastRemediationDiff /
   * capturedViewportDataUrl / statusFilter→'ALL' /
   * isChaosModalOpen→false / isPerfHudOpen→false / activeRightTab→'copilot'。
   *
   * 【为何与 clearPersistedHistory 分开】后者是"用户主动清除审计数据"，
   * 属于数据删除；本动作只是让下一次演示从干净起点开始，
   * remediationHistory 与 totalMaskedSecrets 必须保留（它们是审计证据）。
   */
  resetDemoEphemeralState: () => void;
  /** 设置导演自动确认标志（start 置 true / stop 与 finished 置 false） */
  setDemoAutoConfirm: (enabled: boolean) => void;
  /** 标记 WebGL 上下文丢失/恢复（由 ClusterCanvas 事件回调写入） */
  setGlContextLost: (lost: boolean) => void;
  /**
   * 标记"导演已绕过动作卡直接执行"（C 项的卡片状态统一）。
   *
   * 【解决什么矛盾】8 秒内动作卡没挂载时导演降级直调 healEntity，
   * 而此时旁白已经在讲"自愈完成"。若卡片随后才挂载，它内部状态仍是
   * "待执行"，于是同一屏出现「字幕说已完成 / 卡片说待执行」——这正是
   * 规格明令禁止的矛盾。写入本标记后，后挂载的卡片直接渲染为已执行态。
   */
  setDemoFallbackExecuted: (value: boolean) => void;
  /**
   * 写入 Copilot 流式状态。
   *
   * 【必须在事件回调里调用】若写在 setMessages updater 内部，StrictMode 下
   * updater 会执行两次，导致重复副作用。只能由流事件回调显式调用。
   */
  setCopilotStreaming: (streaming: boolean) => void;
  /** 写入最近一条 assistant 消息 ID */
  setLastAssistantMessageId: (messageId: string | null) => void;
  /** 写入已挂载的动作卡消息 ID（null 表示无卡挂载） */
  setActionCardMountedId: (messageId: string | null) => void;
  /**
   * 请求中止当前 Copilot 流（自增计数）。
   *
   * 【用途】导演 stop 时必须切断进行中的 AI 流，否则停止后屏幕继续吐 token，
   * 与"已停止并复位"的日志直接矛盾。
   */
  requestCopilotAbort: () => void;
  /**
   * 清除待消费的快捷指令（D 项）。
   *
   * 【为什么需要】triggerQuickPrompt 把指令写进 store，由 Copilot 消费后才
   * 置回 null。若路演在 Copilot 尚未消费时就停止，指令会残留，
   * 下次挂载抽屉时被重放——表现为"点了停止，结果又跑了一次诊断"。
   */
  clearQuickPromptTrigger: () => void;
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
  /**
   * 开关 3D 环绕巡检。
   *
   * @param active 是否开启
   * @param reason 触发来源（默认 'user'）
   *   · `'user'`         用户点工具条 → 允许 CameraRig 在进入聚焦时解除；
   *   · `'programmatic'` 导演引擎编排 → CameraRig **不得**擅自解除。
   *
   * 【为什么需要 reason】阶段 4 是「先 selectEntity(null) 再开巡检」，
   * 旧 CameraRig 会在选中变化时无条件解除，于是刚开的巡检立刻被关掉。
   */
  setOrbitPatrolActive: (active: boolean, reason?: 'user' | 'programmatic') => void;
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
