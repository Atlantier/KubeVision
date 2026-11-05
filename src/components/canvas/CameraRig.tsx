'use client';

/**
 * KubeVision AI — 相机运镜系统（CameraRig）
 *
 * 【设计意图】封装 OrbitControls 的自由观察 + 「选中实体 → 自动飞行特写」的
 * 导演级运镜，二者以瞬态 isAnimatingRef 布尔量仲裁，实现**防锁死**控制权交接：
 * 动画插值期间用户随时拖拽鼠标即可夺回控制权（onStart 立即终止动画），
 * 相机永远不会把用户锁在预设轨道上。
 *
 * 【60FPS 红线合规】（AGENTS.md 第 3 条）
 * - useFrame 内零 new：targetPosVec / targetLookVec 两个 THREE.Vector3
 *   经 useMemo 在组件挂载时一次性预分配，此后每帧仅 .set()/.lerp() 原地突变；
 * - useFrame 内零 useState / 零 React 重渲染：飞行目标存于 focusRef
 *   （可变 ref），动画开关存于 isAnimatingRef（瞬态布尔），
 *   组件仅在 selectedEntityId / selectedEntityType 变更时重渲染（低频）。
 *
 * 【插值数学：帧率无关指数阻尼】
 * 每帧以 α = 1 − e^(−k·Δt)（k = FLIGHT_DAMPING_RATE = 4）对
 * camera.position 与 controls.target 做 lerp：
 * - 帧率无关：60FPS 与 144FPS 下飞行时长一致（Δt 归一化）；
 * - 无过冲：指数衰减单调逼近目标，天然平滑减速（ease-out 手感）；
 * - Δt 钳制 0.1s：掉帧长间隔时限制单帧步长，防止相机瞬移穿越几何体。
 * 到达判定：camera.position.distanceTo(目标) < ARRIVAL_EPSILON(0.15)
 * 时吸附终点并置 isAnimatingRef = false，交还自由旋转控制权。
 *
 * 【控制权交接三通道】（任一触发即动画结束）
 * 1. 到达终点（距离 < 0.15）→ 吸附 + false；
 * 2. 用户拖拽（OrbitControls 'start' 事件）→ 立即 false（不吸附，
 *    相机停在当前插值位置，由用户接管——「打断即所得」的运镜手感）；
 * 3. 新的飞行指令（选中变更/视角预设）→ true 并刷新目标（覆盖旧飞行）。
 */

import { useEffect, useMemo, useRef, type ComponentRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

import { useClusterStore } from '@/store/useClusterStore';
import type { CameraFocus } from '@/types/canvas';
import type { SelectedEntityType } from '@/types/store';
import {
  OVERVIEW_CAMERA_POSITION,
  OVERVIEW_LOOK_AT,
  resolveCameraFocus,
  resolveViewPresetFocus,
} from '@/utils/cameraFocus';
import { subscribeViewPreset } from '@/utils/viewPresetBus';

/* ========================================================================== */
/* 类型与常量                                                                  */
/* ========================================================================== */

/**
 * OrbitControls 实例类型：经 ComponentRef 从 drei 组件类型提取
 * （内部即 three-stdlib 的 OrbitControlsImpl），避免直接 import three-stdlib
 * ——它未被提升到根 node_modules（pnpm 隔离结构），但类型可经 drei 的
 * 声明文件正常解析。
 */
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

/** 极角下限（弧度）：θ ≥ 0.2，防止相机翻越天顶产生万向节翻转 */
const MIN_POLAR_ANGLE = 0.2;

/** 极角上限（弧度）：θ ≤ π/2 − 0.05，防止相机穿入地面以下 */
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.05;

/** 轨道最大距离：35 世界单位（全景鸟瞰 [0,14,22] 的模长 ≈ 26，留有余量） */
const MAX_ORBIT_DISTANCE = 35;

/** 轨道最小距离：0.8（防止滚轮推近时相机穿入 Pod/机架几何体内部） */
const MIN_ORBIT_DISTANCE = 0.8;

/** 阻尼系数（需求契约值）：0.05，OrbitControls 惯性旋转的松紧度 */
const ORBIT_DAMPING_FACTOR = 0.05;

/** 飞行指数阻尼率 k（1/秒）：越大飞行越快；4 ≈ 0.7 秒内完成 95% 行程 */
const FLIGHT_DAMPING_RATE = 4;

/** 到达判定阈值（需求契约值）：相机距目标机位 < 0.15 即吸附终点并结束动画 */
const ARRIVAL_EPSILON = 0.15;

/** 单帧 Δt 钳制上限（秒）：掉帧时限制插值步长，防相机瞬移穿模 */
const MAX_FRAME_DELTA = 0.1;

/**
 * 环绕巡检自转速度（OrbitControls autoRotateSpeed 单位：60FPS 下 2.0 = 30 秒/圈）。
 * 取 2.0：态势巡检的从容节奏，既能让观察者看清三机架轮转细节，
 * 又不至于慢到误以为功能未生效。
 */
const ORBIT_PATROL_SPEED = 2.0;

/* ========================================================================== */
/* CameraRig 主体                                                              */
/* ========================================================================== */

/**
 * CameraRig —— OrbitControls + 选中实体自动运镜（R3F Canvas 内挂载）。
 *
 * 【订阅纪律】仅细粒度订阅 selectedEntityId / selectedEntityType 两个
 * 低频 UI 字段；遥测快照在 effect 内以 getState() 按需读取（不订阅），
 * 因此 1Hz 快照流**不会**触发本组件重渲染——相机逻辑与遥测频率完全解耦。
 */
export default function CameraRig() {
  /* ---- Store 细粒度订阅（选中态两字段 + 巡检开关） ---- */
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectedEntityType = useClusterStore((s): SelectedEntityType | null => s.selectedEntityType);
  const isOrbitPatrolActive = useClusterStore((s): boolean => s.isOrbitPatrolActive);

  /* ---- 瞬态运行期引用（零重渲染通道） ---- */
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  /** 动画开关：true = 正在向 focusRef 目标插值飞行 */
  const isAnimatingRef = useRef<boolean>(false);
  /** 当前飞行目标载荷（resolveCameraFocus 解算结果） */
  const focusRef = useRef<CameraFocus>({
    position: OVERVIEW_CAMERA_POSITION,
    lookAt: OVERVIEW_LOOK_AT,
  });

  /**
   * 预分配插值临时向量（AGENTS.md 第 3 条：useFrame 内禁止 new THREE.Vector3）。
   * useMemo 空依赖 → 组件生命周期内仅分配一次，每帧 .set() 原地复用。
   */
  const targetPosVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const targetLookVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);

  /**
   * disengagePatrolIfActive —— 若环绕巡检开启则自动解除（经 Store Action 回写）。
   *
   * 【冲突根因】autoRotate 在每次 controls.update() 中给相机施加绕 target 的
   * 切向位移（speed 2.0 ≈ 0.09 单位/帧），而预设/选中飞行的指数阻尼 lerp
   * 收敛率 α≈0.064/帧——二者同时生效会形成半径 ≈1.4 单位的「追逐平衡」，
   * 永远无法满足 <0.15 的到达判定，飞行悬而不决。故契约定为：
   * **程序化飞行优先，起飞即解除巡检**（用户拖拽让位同理，见 handleUserTakeover）。
   * 解除经 setOrbitPatrolActive(false) 回写 Store：工具条按钮高亮同步熄灭、
   * 终端留下审计行，状态与行为永不背离。
   */
  const disengagePatrolIfActive = (): void => {
    const state = useClusterStore.getState();
    if (state.isOrbitPatrolActive) {
      state.setOrbitPatrolActive(false);
    }
  };

  /* ---- 飞行触发通道 1：选中实体变更（含取消选中 → 全景鸟瞰） ---- */
  useEffect(() => {
    disengagePatrolIfActive();
    // getState() 按需读取最新快照（不订阅：1Hz 快照流不触发本组件重渲染）
    const snapshot = useClusterStore.getState().snapshotSummary;
    focusRef.current = resolveCameraFocus(selectedEntityId, selectedEntityType, snapshot);
    isAnimatingRef.current = true;
  }, [selectedEntityId, selectedEntityType]);

  /* ---- 飞行触发通道 2：外部视角预设（viewPresetBus 广播，UI 层零 three 依赖） ---- */
  useEffect(() => {
    return subscribeViewPreset((preset): void => {
      disengagePatrolIfActive();
      // 穷举 ViewPresetKey（overview / topdown），机位解算收敛在 cameraFocus 纯函数层
      focusRef.current = resolveViewPresetFocus(preset);
      isAnimatingRef.current = true;
    });
  }, []);

  /* ---- 控制权交接通道：用户拖拽 onStart → 立即终止动画（防锁死核心） ---- */
  useEffect(() => {
    const controls = controlsRef.current;
    if (controls === null) return undefined;
    const handleUserTakeover = (): void => {
      // 打断即所得：相机停在当前插值位置，不吸附终点，由用户全权接管
      isAnimatingRef.current = false;
      // 环绕巡检让位：用户拖拽即手动操作优先，自动解除 autoRotate
      disengagePatrolIfActive();
    };
    controls.addEventListener('start', handleUserTakeover);
    return (): void => {
      controls.removeEventListener('start', handleUserTakeover);
    };
  }, []);

  /* ---- 每帧插值（瞬态通道：零 setState / 零 new） ---- */
  useFrame((state, delta): void => {
    if (!isAnimatingRef.current) return;

    const focus = focusRef.current;
    const controls = controlsRef.current;
    const clampedDelta = Math.min(delta, MAX_FRAME_DELTA);
    // 帧率无关指数阻尼：α = 1 − e^(−k·Δt)
    const alpha = 1 - Math.exp(-FLIGHT_DAMPING_RATE * clampedDelta);

    // 预分配向量原地装载目标（tuple → Vector3，零分配）
    targetPosVec.set(focus.position[0], focus.position[1], focus.position[2]);
    targetLookVec.set(focus.lookAt[0], focus.lookAt[1], focus.lookAt[2]);

    state.camera.position.lerp(targetPosVec, alpha);
    if (controls !== null) {
      controls.target.lerp(targetLookVec, alpha);
      // 手动 update 使本帧的 target 变更立即生效（drei 内部 update 在下一帧）
      controls.update();
    }

    // 到达判定：< 0.15 吸附终点并交还控制权
    if (state.camera.position.distanceTo(targetPosVec) < ARRIVAL_EPSILON) {
      state.camera.position.copy(targetPosVec);
      if (controls !== null) {
        controls.target.copy(targetLookVec);
        controls.update();
      }
      isAnimatingRef.current = false;
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={ORBIT_DAMPING_FACTOR}
      minPolarAngle={MIN_POLAR_ANGLE}
      maxPolarAngle={MAX_POLAR_ANGLE}
      minDistance={MIN_ORBIT_DISTANCE}
      maxDistance={MAX_ORBIT_DISTANCE}
      // 平移限制在水平面小范围，防止用户把场景拖出视野后「迷路」
      enablePan
      panSpeed={0.6}
      rotateSpeed={0.75}
      zoomSpeed={0.85}
      /* 环绕巡检：声明式绑定 Store 开关（严禁命令式戳 ref）。
       * autoRotateSpeed 2.0 ≈ 30 秒/圈——态势巡检的从容节奏，
       * 且 drei 的 useFrame(-1) 持续 update 保证 damping 与 autoRotate 共存稳定。
       * 用户拖拽时经 'start' 监听自动关闭（见 handleUserTakeover）。 */
      autoRotate={isOrbitPatrolActive}
      autoRotateSpeed={ORBIT_PATROL_SPEED}
    />
  );
}
