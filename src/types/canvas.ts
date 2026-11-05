/**
 * KubeVision AI — 3D 画布域类型契约（唯一类型源）
 *
 * 【契约】依据 AGENTS.md 第 2 条：画布域组件 Props 与相机载荷必须严格
 * 引用本文件接口，禁止 any / @ts-ignore。
 */

import type { WorkerNodeEntity } from '@/types/cluster';

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
