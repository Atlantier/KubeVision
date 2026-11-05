/**
 * KubeVision AI — 3D 画布域类型契约（唯一类型源）
 *
 * 【契约】依据 AGENTS.md 第 2 条：画布域组件 Props 与相机载荷必须严格
 * 引用本文件接口，禁止 any / @ts-ignore。
 */

import type { PodStatus, RackIndex, WorkerNodeEntity } from '@/types/cluster';

/**
 * MASTER_ENTITY_ID 再导出 —— 定义收敛在 cameraFocus.ts 纯函数层
 * （resolveCameraFocus 的 master 分支匹配依据），此处再导出供画布域组件引用，
 * 保持「画布域类型统一从 @/types/canvas 取用」的消费惯例。
 */
export { MASTER_ENTITY_ID } from '@/utils/cameraFocus';

/**
 * ViewPresetKey —— 外部视角预设键。
 *
 * 【设计意图】UI 层（视口工具条、顶栏、快捷键、Copilot 卡片按钮）通过
 * viewPresetBus 广播预设键触发相机飞行，无需 import three / 持有 R3F 内部引用。
 * - 'overview' → 全景鸟瞰 [0, 14, 22]（环形布局 + 中心 MASTER 同屏）
 * - 'topdown'  → 俯视拓扑（极角钳制在 minPolarAngle=0.2 边界的近垂直俯视，
 *                纯正俯视 θ=0 会触发 OrbitControls 万向节退化，故取约束边界值）
 * 后续可扩展 'cockpit' 等预设，CameraRig 与调用方代码零改动（开闭原则）。
 */
export type ViewPresetKey = 'overview' | 'topdown';

/**
 * CameraFocus —— 一次相机飞行的目标载荷（机位 + 注视点）。
 *
 * 【消费方】CameraRig 在 useFrame 中以指数阻尼将 camera.position 插值到
 * position、controls.target 插值到 lookAt；由 cameraFocus.ts 纯函数解算。
 * readonly 元组保证载荷不可变（飞行途中不会被外部篡改）。
 */
export interface CameraFocus {
  /** 目标相机机位（世界坐标） */
  readonly position: readonly [number, number, number];
  /** 目标注视点（世界坐标，写入 OrbitControls.target） */
  readonly lookAt: readonly [number, number, number];
}

/**
 * WorkerRack3DProps —— 计算节点机架程序化 3D 模型 Props。
 *
 * 【契约】直接接收完整 WorkerNodeEntity（而非 rackIndex 再查表）：
 * 组件是纯展示层，数据获取职责留给父级 ClusterCanvas 的细粒度订阅，
 * 保证「快照整体替换 → 三个机架同步重渲染」的单向数据流。
 */
export interface WorkerRack3DProps {
  /** 该机架对应的 Worker 节点实体（含状态/负载/Pod 反向索引） */
  readonly node: WorkerNodeEntity;
}

/**
 * PodHoverLabelData —— Pod 悬停微型标签视图模型。
 *
 * 【消费方】PodInstancedMesh 的悬停层：以 hoveredInstanceId 为键从
 * snapshotSummary 派生（shallow 比较），仅悬停期间随 1Hz 快照刷新
 * 实现「实时 CPU/MEM%」；非悬停态选择器恒返回 null（引用稳定），
 * 遥测流对渲染器零重渲染开销。
 */
export interface PodHoverLabelData {
  /** Pod 展示名 */
  readonly name: string;
  /** 生命周期状态（徽标文案与颜色依据） */
  readonly status: PodStatus;
  /** CPU 使用率百分比。@range [0, 100] */
  readonly cpuUsage: number;
  /** 内存使用率百分比。@range [0, 100] */
  readonly memoryUsage: number;
  /** 机架索引（标签世界坐标查表键之一） */
  readonly rackIndex: RackIndex;
  /** 槽位索引（标签世界坐标查表键之一）。@range [0, 15] */
  readonly slotIndex: number;
}

/**
 * Pod 状态徽标样式 —— 悬停标签的状态色与文案映射。
 *
 * 【配色契约】按 cluster.ts 的 PodStatus 五态映射到深空赛博状态色体系
 * （AGENTS.md 第 5 条）：Running → emerald-400 正常；Pending/Terminating →
 * amber-400 过渡；CrashLoopBackOff/OOMKilled → rose-500 崩溃 + 脉冲告警。
 */
export interface PodStatusBadgeStyle {
  /** 徽标文案（PodStatus 原文） */
  readonly label: PodStatus;
  /** 徽标圆点/文字色（CSS 颜色字符串） */
  readonly color: string;
  /** 附加 Tailwind 类（crash 态脉冲动画等） */
  readonly extraClass?: string;
}

/**
 * RackErrorRingProps —— 单机架故障警示涟漪环 Props。
 *
 * 【契约】只接收 rackIndex：环的世界坐标由 getRackTransform(rackIndex)
 * 在组件内部解算（空间布局单一事实源），激活与否由父级 ErrorRippleRing
 * 依据快照状态判定——被渲染即激活，组件自身不做条件判断。
 */
export interface RackErrorRingProps {
  /** 机架索引，取值域 {0, 1, 2} */
  readonly rackIndex: RackIndex;
}
