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
import { useFrame, useThree } from '@react-three/fiber';
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
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.04;

/** 轨道最大距离：35 世界单位（全景鸟瞰 [0,14,22] 的模长 ≈ 26，留有余量） */
const MAX_ORBIT_DISTANCE = 36;

/** 轨道最小距离：0.8（防止滚轮推近时相机穿入 Pod/机架几何体内部） */
const MIN_ORBIT_DISTANCE = 1.8;

/** 阻尼系数（需求契约值）：0.05，OrbitControls 惯性旋转的松紧度 */
const ORBIT_DAMPING_FACTOR = 0.065;

/** 飞行指数阻尼率 k（1/秒）：越大飞行越快；4 ≈ 0.7 秒内完成 95% 行程 */
const FLIGHT_DAMPING_RATE = 4;

/** 到达判定阈值（需求契约值）：相机距目标机位 < 0.15 即吸附终点并结束动画 */
const ARRIVAL_EPSILON = 0.15;

/** 单帧 Δt 钳制上限（秒）：掉帧时限制插值步长，防相机瞬移穿模 */
const MAX_FRAME_DELTA = 0.1;

/* --------------------------------------------------------------------------
 * 弧线绕飞（Arc Avoidance）
 * -------------------------------------------------------------------------- */

/**
 * 飞行进度推进速率（每秒，归一化域）。
 *
 * 【为何需要进度】直线阻尼插值只能得到一条**连接起点与终点的直线**：
 * 从环外飞向环内机架时，这条直线会直接穿过机架隔板、甚至穿过中央八面体水晶。
 * 引入归一化进度 p ∈ [0,1] 后，可在直线上叠加 sin(π·p) 包络的偏移，
 * 把轨迹弯成弧线——两端偏移为 0（起终点精确），中段最大（绕开障碍）。
 * 速率 1.6 ≈ 0.62 秒走完全程，比纯阻尼略慢，弧线才有"看得见的优雅"。
 */
const FLIGHT_ARC_RATE = 1.6;

/** 弧线抬升幅度：min(MAX, 飞行距离 × RATIO)——短途不抬太高，长途从容越过机架 */
const FLIGHT_ARC_LIFT_MAX = 2.4;
const FLIGHT_ARC_LIFT_RATIO = 0.16;

/** 弧线切向偏摆幅度：让轨迹不只是"抬高"，而是真正侧向绕行 */
const FLIGHT_ARC_SIDESTEP_MAX = 1.8;
const FLIGHT_ARC_SIDESTEP_RATIO = 0.12;

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
  /**
   * 场景相机引用（用于在**起飞瞬间**快照当前机位，供弧线绕飞起算）。
   *
   * 【为何从 useThree 取而不在 useFrame 里用 state.camera】
   * 两个飞行触发 effect 需要"此刻相机在哪"，而 effect 无法拿到 useFrame 的 state。
   * useThree 的 camera 引用在整个 Canvas 生命周期内稳定，
   * 不会引起额外重渲染（它只在 camera 对象被替换时变化）。
   */
  const camera = useThree((s): THREE.Camera => s.camera);

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

  /* ---- 弧线绕飞预分配向量（useFrame 内零分配） ---- */
  /** 本次飞行的起点（focus 变更时快照当前相机位置） */
  const flightStartVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  /** 起点 → 终点的单位方向 */
  const flightDirVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  /** 水平切向（垂直于飞行方向，用于侧向绕行） */
  const flightSideVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  /** 叠加弧线后的本帧期望机位 */
  const arcPointVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  /** 归一化飞行进度 [0,1] */
  const flightProgressRef = useRef<number>(0);

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

    /*
     * ---- E 项：程序化锁生效时不解除 ----
     *
     * 【修复的缺陷】导演阶段 4 收尾是「先 selectEntity(null) 再
     * setOrbitPatrolActive(true)」。两者落在同一批更新里时，选中变化 effect
     * 会调用本函数，把**刚开启**的巡检立刻关掉——表现为"巡检开了又被关"，
     * 收尾的环绕仪式感直接消失。
     *
     * 现在：导演用 programmatic 开启的巡检带锁，本函数遇到锁直接返回。
     * 用户自己开的巡检（无锁）仍可被聚焦/拖拽打断，原有交互语义不变。
     */
    if (state.patrolLockedByProgram) return;

    if (state.isOrbitPatrolActive) {
      state.setOrbitPatrolActive(false, 'user');
    }
  };

  /* ---- 飞行触发通道 1：选中实体变更（含取消选中 → 全景鸟瞰） ---- */
  useEffect(() => {
    /*
     * 【只在进入聚焦时解除巡检】selectedEntityId === null 表示"回到全景"，
     * 其语义是"不再聚焦某个实体"，而不是"停止自转"。用户从特写退回全景时
     * 通常仍希望看到环绕巡检；更重要的是导演阶段 4 正是以 selectEntity(null)
     * 收尾后再开巡检，无条件解除会把它刚开的巡检关掉。
     */
    if (selectedEntityId !== null) {
      disengagePatrolIfActive();
    }
    // getState() 按需读取最新快照（不订阅：1Hz 快照流不触发本组件重渲染）
    const snapshot = useClusterStore.getState().snapshotSummary;
    focusRef.current = resolveCameraFocus(selectedEntityId, selectedEntityType, snapshot);
    /*
     * 起点快照 + 进度归零：弧线绕飞依赖这两个量。
     * 起点必须在**起飞瞬间**取相机真实位置（而非上一次的目标机位），
     * 否则打断动画后再次点击会让弧线从错误的位置起算。
     */
    flightStartVec.copy(camera.position);
    flightProgressRef.current = 0;
    isAnimatingRef.current = true;
  }, [selectedEntityId, selectedEntityType, camera, flightStartVec]);

  /* ---- 飞行触发通道 2：外部视角预设（viewPresetBus 广播，UI 层零 three 依赖） ---- */
  useEffect(() => {
    return subscribeViewPreset((preset): void => {
      disengagePatrolIfActive();
      // 穷举 ViewPresetKey（overview / topdown），机位解算收敛在 cameraFocus 纯函数层
      focusRef.current = resolveViewPresetFocus(preset);
      flightStartVec.copy(camera.position);
      flightProgressRef.current = 0;
      isAnimatingRef.current = true;
    });
  }, [camera, flightStartVec]);

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

    /*
     * ================= 弧线绕飞（Arc Avoidance）=================
     *
     * 【解决什么】旧实现直接对 targetPosVec 做阻尼 lerp：起点与终点之间
     * 的轨迹是一条**直线**。从环外飞向环内机架特写位时，这条直线会从
     * 机架背后斜穿过去——穿过隔板、穿过刀片，严重时穿过中央八面体水晶，
     * 观感就是"镜头钻进模型里"。
     *
     * 【轨迹构造】设 p ∈ [0,1] 为飞行进度，start 为起飞瞬间的相机位置：
     *   L(p) = start + (target − start)·p          直线点
     *   w(p) = sin(π·p)                            包络：两端 0、中段 1
     *   P(p) = L(p) + up·(lift·w) + side·(step·w)  弧线点
     *
     * - w 两端为 0 ⇒ 起终点精确不变，不会有"起飞一抖 / 到位一偏"；
     * - up 抬高让镜头从障碍上方越过（抬升量按飞行距离缩放）；
     * - side 取飞行方向的**水平垂线**，让轨迹真的侧向绕出去——
     *   只抬高而不横移时，正俯冲的视角仍会切到水晶，横向分量是必要的。
     *
     * 【为何仍保留阻尼】相机向 P(p) 做指数阻尼而非直接 set：
     * 掉帧或切后台时进度仍连续，机位变化依旧平滑，且与既有的
     * 到达判定（距离 < 0.15 吸附）天然兼容。
     */
    flightProgressRef.current = Math.min(
      1,
      flightProgressRef.current + FLIGHT_ARC_RATE * clampedDelta,
    );
    const progress = flightProgressRef.current;

    /* 飞行向量与距离（起飞点 → 目标） */
    flightDirVec.subVectors(targetPosVec, flightStartVec);
    const flightDistance = flightDirVec.length();

    if (flightDistance > 0.001) {
      /* 归一化方向；水平切向 = 世界 Y × 方向，恒垂直于飞行方向 */
      flightDirVec.multiplyScalar(1 / flightDistance);
      flightSideVec.set(0, 1, 0).cross(flightDirVec);
      const sideLength = flightSideVec.length();
      if (sideLength > 0.001) {
        flightSideVec.multiplyScalar(1 / sideLength);
      } else {
        /* 近乎纯竖直飞行时叉积退化为零向量：放弃侧摆，只保留抬升 */
        flightSideVec.set(0, 0, 0);
      }

      const envelope = Math.sin(Math.PI * progress);
      const lift = Math.min(FLIGHT_ARC_LIFT_MAX, flightDistance * FLIGHT_ARC_LIFT_RATIO) * envelope;
      const sideStep =
        Math.min(FLIGHT_ARC_SIDESTEP_MAX, flightDistance * FLIGHT_ARC_SIDESTEP_RATIO) * envelope;

      arcPointVec.lerpVectors(flightStartVec, targetPosVec, progress);
      arcPointVec.y += lift;
      arcPointVec.addScaledVector(flightSideVec, sideStep);
    } else {
      arcPointVec.copy(targetPosVec);
    }

    state.camera.position.lerp(arcPointVec, alpha);
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
      flightProgressRef.current = 1;
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
