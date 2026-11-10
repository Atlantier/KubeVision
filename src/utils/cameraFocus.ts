/**
 * KubeVision AI — 相机机位解算纯函数层（零 three 依赖 · SSR 安全 · 可单测）
 *
 * 【设计意图】把「选中实体 → 相机机位/注视点」的解算逻辑从 CameraRig 组件中
 * 剥离为纯函数：
 * 1. 不 import three（返回 readonly 元组），可在 Node 环境直接跑数值断言，
 *    无需 WebGL / 浏览器即可回归验证机位数学；
 * 2. 内部复用 spatialLayout.ts 的 getRackTransform / getPodWorldTransform，
 *    保证「相机看到的实体位置」与「渲染引擎摆放的实体位置」永远同源，
 *    杜绝两套坐标公式漂移；
 * 3. CameraRig 只做 three 绑定与插值动画，职责单一。
 *
 * 【机位几何契约】
 * - Pod 特写：直接采用 getPodWorldTransform 返回的 cameraPosition
 *   （沿 Pod 正面内法线后退 1.6、抬升 0.42，俯角 ≈14.7°，取景推导见
 *   spatialLayout.ts 常量 JSDoc），注视点即 Pod 中心。
 * - 机架总览：沿机架正面内法线（由 rotationY 解出 n = (sinθ, 0, cosθ)，
 *   指向世界中心一侧）后退 RACK_STANDOFF 并抬升 RACK_ELEVATION，
 *   注视点取机架几何中心高度（约 4 层托盘的半高），整机架 4.8 单位高
 *   在 fov 45° 下完整入画并保留环形布局语境。
 * - 全景鸟瞰：OVERVIEW_CAMERA_POSITION [0, 14, 22]（需求契约值），
 *   注视 MASTER_POSITION [0, 2.5, 0]——中心全息投影与三机架同屏。
 */

import type { TelemetrySnapshot } from '@/types/cluster';
import type { CameraFocus, ViewPresetKey } from '@/types/canvas';
import type { SelectedEntityType } from '@/types/store';
import {
  MASTER_POSITION,
  getPodWorldTransform,
  getRackTransform,
} from '@/utils/spatialLayout';

/* ========================================================================== */
/* 全景鸟瞰契约常量                                                            */
/* ========================================================================== */

/**
 * 全景鸟瞰机位（取消选中/未知实体的安全回退位）。
 *
 * 【斜轴构图】X 从 0 改为 7.8，与 ClusterCanvas 的初始机位严格一致——
 * 正后方机位会让三机架对称排布、互相遮挡且地面星环被压成一条线；
 * 偏置后呈现前中后三层纵深，星环的椭圆轮廓才可见（蓝图 §1.8）。
 *
 * 【y=14 不可改】scripts/verify.mjs L606 以 `|pos[1] - 14| > 1` 判断
 * 相机是否已离开全景机位，该值是验收断言的锚点。
 */
export const OVERVIEW_CAMERA_POSITION: readonly [number, number, number] = [7.8, 14, 22];

/**
 * 全景注视点（R29 · A 项：构图修复）。
 *
 * 【改动】[0, 2.5, 0] → **[0, 1.20, 0]**，相机 [7.8, 14, 22] 与 fov 40 保持不动。
 * 【为什么】旧注视点抬到 2.5 时画面被"仰视"压缩——前排机架底边被裁掉，
 * 晶核被推到约 52% 高度。下移注视点相当于整体构图下压：
 *   · 前排机架底边完整入画；
 *   · 晶核屏幕位置约 44% 高度，地面获得呼吸空间。
 * 【不变量】OVERVIEW_CAMERA_POSITION 未动，因此 verify 的相机位置断言
 * （pos[1]≈14、pos[2]≈22 判"是否离开全景机位"）继续有效，无需改基准。
 */
export const OVERVIEW_LOOK_AT: readonly [number, number, number] = [0, 1.2, 0];

/* ========================================================================== */
/* 俯视拓扑机位（极角约束反解）                                                  */
/* ========================================================================== */

/**
 * 俯视拓扑相机与注视点的水平距离参数（世界单位）。
 *
 * 【几何推导 · 极角约束反解】OrbitControls 的极角 θ 定义为相机相对注视点
 * 的方位与 +Y 轴的夹角，且被 CameraRig 钳制在 [0.2, π/2−0.05]：
 * - 纯正俯视（θ=0，相机在注视点正上方）会被 minPolarAngle=0.2 拒绝，
 *   且 θ=0 时方位角失去定义（万向节退化，autoRotate 会抖动）；
 * - 故取 θ = 0.2（约束边界上最接近垂直俯视的合法值）。
 * 以注视点为球心、R = TOPDOWN_DISTANCE 为半径的球面坐标：
 *   y = R·cosθ = 28 × cos(0.2) ≈ 27.44（相机高度）
 *   r = R·sinθ = 28 × sin(0.2) ≈ 5.56（水平偏移，取 +Z 方向，
 *       与 overview 的 [0,14,22] 同侧，两预设间切换的飞行弧线自然）
 * 模长 R=28 < maxDistance(35)，不会被轨道距离约束二次钳制。
 * 俯视效果：三机架环形布局与 24 Pod 槽位阵列以近垂直视角完整铺开，
 * 「拓扑图」式的空间关系一目了然（slotIndex 网格、机架 120° 均布尽收眼底）。
 */
const TOPDOWN_DISTANCE = 28;

/** 俯视极角（弧度）：钳制在 minPolarAngle 边界（推导见上） */
const TOPDOWN_POLAR = 0.2;

/**
 * 俯视拓扑机位常量：[28·sin0.2, 28·cos0.2 + lookAtY, 0]（注视 MASTER 锚点，
 * 水平偏移沿 +Z，与全景鸟瞰同侧）。模块加载期一次求值（纯常量表达式，SSR 安全）。
 */
export const TOPDOWN_CAMERA_POSITION: readonly [number, number, number] = [
  TOPDOWN_DISTANCE * Math.sin(TOPDOWN_POLAR),
  MASTER_POSITION[1] + TOPDOWN_DISTANCE * Math.cos(TOPDOWN_POLAR),
  0,
];

/** 俯视注视点：与全景一致（MASTER 锚点），保证两预设仅相机位不同、视野中心不变 */
export const TOPDOWN_LOOK_AT: readonly [number, number, number] = MASTER_POSITION;

/**
 * resolveViewPresetFocus —— 视角预设键 → 相机飞行载荷（纯函数）。
 *
 * 【消费方】CameraRig 的 viewPresetBus 订阅回调；视口工具条按钮经总线间接触发。
 * 穷举 ViewPresetKey 联合（TS 编译期保证新增预设必须在此补分支）。
 */
export function resolveViewPresetFocus(preset: ViewPresetKey): CameraFocus {
  switch (preset) {
    case 'overview':
      return { position: OVERVIEW_CAMERA_POSITION, lookAt: OVERVIEW_LOOK_AT };
    case 'topdown':
      return { position: TOPDOWN_CAMERA_POSITION, lookAt: TOPDOWN_LOOK_AT };
  }
}

/* ========================================================================== */
/* 机架总览机位参数                                                            */
/* ========================================================================== */

/**
 * 机架总览：相机沿机架正面内法线的后退距离（世界单位，整机架入画）。
 *
 * 【取值推导】机架高 4.4，fov 45° 下完整入画距离 = (4.4/2)/tan(22.5°) ≈ 5.3，
 * 取 6.0 留少量余量。此值必须显著小于 RACK_RADIUS(9.5)：若逼近环半径，
 * 三个「朝内观察」的机位会一同收敛到世界中心（半径 9.5−standoff → 0），
 * 导致选中不同机架时相机几乎不位移、且贴住中心 MASTER 全息球与点光源。
 * standoff=6.0 时相机落在半径 3.5 处，三机位彼此分离约 6 单位，构图清晰。
 */
const RACK_STANDOFF = 6.0;

/** 机架总览：相机相对机架底座的抬升高度（略高于机架半高，轻微俯视全景托盘） */
const RACK_ELEVATION = 4.0;

/** 机架总览：注视点高度（4 层托盘的几何中心，TIER_BASE_Y + 1.5 × TIER_HEIGHT ≈ 2.13） */
const RACK_LOOK_AT_HEIGHT = 2.1;

/* ========================================================================== */
/* 解算主函数                                                                  */
/* ========================================================================== */

/**
 * MASTER 控制平面实体 ID（MasterNode3D 点击选中的载荷 ID）。
 *
 * 【定义归属】cameraFocus 是纯函数层（不依赖 React 域类型），故本 ID 在此定义、
 * canvas.ts 再导出——resolveCameraFocus 需要按它精确匹配 master 分支，
 * MasterNode3D 需要按它调用 selectEntity，单一事实源杜绝两处字符串漂移。
 */
export const MASTER_ENTITY_ID = 'master-control-plane';

/**
 * resolveCameraFocus —— 由选中实体解算相机飞行载荷（纯函数）。
 *
 * 【核心流转】
 * 1. 未选中（entityId=null）或类型为 'master'（含 MASTER_ENTITY_ID）→ 全景鸟瞰
 *    （MASTER 位于环形布局几何中心，鸟瞰位即是它的最佳观察机位）；
 * 2. entityId 在 snapshot.pods 中命中 → Pod 特写机位
 *    （getPodWorldTransform(rackIndex, slotIndex).cameraPosition + Pod 中心注视）；
 * 3. entityId 在 snapshot.nodes 中命中 → 机架总览机位
 *    （getRackTransform(rackIndex) + 内法线后退/抬升 + 机架半高注视）；
 * 4. 均未命中（实体已被清理/ID 过期）→ 全景鸟瞰安全回退，
 *    绝不返回 null 让相机停在半途（「取消选中飞回全景」语义的自然延伸）。
 *
 * 【输入输出】
 * @param entityId   选中实体 ID（null = 未选中）
 * @param entityType 选中实体类型（与 entityId 同生共死）
 * @param snapshot   当前遥测快照（实体 → rackIndex/slotIndex 的查询源）
 * @returns CameraFocus（position + lookAt，恒有值）
 */
export function resolveCameraFocus(
  entityId: string | null,
  entityType: SelectedEntityType | null,
  snapshot: TelemetrySnapshot,
): CameraFocus {
  /* ---- 1. 未选中 / MASTER 控制平面：全景鸟瞰 ---- */
  if (
    entityId === null ||
    entityType === null ||
    entityType === 'master' ||
    entityId === MASTER_ENTITY_ID
  ) {
    return { position: OVERVIEW_CAMERA_POSITION, lookAt: OVERVIEW_LOOK_AT };
  }

  /* ---- 2. Pod 特写：坐标与机位全部取自 spatialLayout（与渲染同源） ---- */
  const pod = snapshot.pods.find((p): boolean => p.id === entityId);
  if (pod !== undefined) {
    const podTransform = getPodWorldTransform(pod.rackIndex, pod.slotIndex);
    return {
      position: podTransform.cameraPosition,
      lookAt: podTransform.position,
    };
  }

  /* ---- 3. 机架总览：沿正面内法线后退 + 抬升 ---- */
  const node = snapshot.nodes.find((n): boolean => n.id === entityId);
  if (node !== undefined) {
    const rack = getRackTransform(node.rackIndex);
    const theta = rack.rotationY;
    // 机架正面内法线 n = (sinθ, 0, cosθ)，指向世界中心一侧（推导见 spatialLayout.ts）
    const normalX = Math.sin(theta);
    const normalZ = Math.cos(theta);
    return {
      position: [
        rack.position[0] + normalX * RACK_STANDOFF,
        rack.position[1] + RACK_ELEVATION,
        rack.position[2] + normalZ * RACK_STANDOFF,
      ],
      lookAt: [rack.position[0], rack.position[1] + RACK_LOOK_AT_HEIGHT, rack.position[2]],
    };
  }

  /* ---- 4. 未知实体：全景鸟瞰安全回退 ---- */
  return { position: OVERVIEW_CAMERA_POSITION, lookAt: OVERVIEW_LOOK_AT };
}
