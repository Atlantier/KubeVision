'use client';

/**
 * KubeVision AI — R7 相机运镜与交互系统（CameraRig）
 *
 * 【设计意图】
 * 统一调度开场运镜、实体特写飞行、视角预设过渡与 OrbitControls 自由观察，
 * 在 60FPS / 144FPS 高刷与移动端窄屏下均保持防锁死、帧率无关阻尼与零抖动手感：
 * 1. **时间轴驱动三段式飞行**：标准飞行 `720ms`，采用 `cubic-bezier(0.56, 0, 0.08, 1)`
 *    搭配 `sin(πp)^1.4` 绕飞包络（起手柔、中段果断、收尾轻粘）；
 * 2. **180° 预设球面插值**：`overview <-> topdown` 自动切换为半径 / 极角 / 方位角
 *    球面独立插值（`820ms`），杜绝穿越集群中心；
 * 3. **控制权防锁死仲裁**：飞行期间令 `controls.enabled = false`（让 `drei` `useFrame(-1)`
 *    不再触发 `controls.update()` 与之抢相机，本组件内 `useFrame` 不调用多余
 *    `controls.update()`），通过捕获阶段指针/滚轮监听即时解锁并由用户接管；
 * 4. **帧率无关阻尼与输入整形**：`damping = 1 - (1 - 0.065)^(dt * 60)`；
 *    画布 `280ms / < 6px` 双击复位概览；滚轮 `deltaY` 限幅 `±40` 与触控板 `ctrlKey × 0.5`；
 *    `prefers-reduced-motion` 下飞行压至 `180ms` 线性推进并暂停 `autoRotate`。
 */

import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

import {
  CAMERA_MOTION,
  REDUCED_MOTION_AMPLITUDE,
  computeDtDamping,
  computeFlightArcEnvelope,
  easeThreeStageFlight,
  isReducedMotion,
  subscribeReducedMotion,
} from '@/constants/motion';
import { useClusterStore } from '@/store/useClusterStore';
import type { CameraFocus, ViewPresetKey } from '@/types/canvas';
import type { SelectedEntityType } from '@/types/store';
import {
  OPENING_CAMERA_POSITION,
  OPENING_FLIGHT_DAMPING,
  OPENING_FLIGHT_DURATION,
} from '@/utils/bootUniform';
import {
  beginDebugFlightTrace,
  endDebugFlightTrace,
  incrementDblClickResetCount,
  isCameraDebugEnabled,
  pushDebugFlightSample,
  updateDebugCameraState,
} from '@/utils/cameraDebugBridge';
import { publishFlightProgress, publishFlightStatus } from '@/utils/cameraFlightBus';
import {
  OVERVIEW_CAMERA_POSITION,
  OVERVIEW_LOOK_AT,
  resolveCameraFocus,
  resolveViewPresetFocus,
} from '@/utils/cameraFocus';
import { markDoubleClickResetTriggered } from '@/utils/canvasClickIntent';
import { dispatchViewPreset, subscribeViewPreset } from '@/utils/viewPresetBus';

/* ========================================================================== */
/* 类型与常量                                                                  */
/* ========================================================================== */

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

const MIN_POLAR_ANGLE = 0.2;
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.04;
const MAX_ORBIT_DISTANCE = 36;
const MAX_FRAME_DELTA = 0.1;

const FLIGHT_ARC_LIFT_MAX = 2.4;
const FLIGHT_ARC_LIFT_RATIO = 0.16;
const FLIGHT_ARC_SIDESTEP_MAX = 1.8;
const FLIGHT_ARC_SIDESTEP_RATIO = 0.12;
const ORBIT_PATROL_SPEED = 2.0;
const SPHERICAL_AZIMUTH_THRESHOLD_RAD = Math.PI * 0.45;

/**
 * clearOrbitResidualDelta —— 单次重置 OrbitControls 残余速度分量（仅在起飞结束/打断瞬间调用）。
 *
 * 【为什么仅在态变边界调用一次】飞行期间 `controls.enabled = false` 挂起了 `drei` 的
 * `useFrame(-1)` 更新；恢复自由态前通过瞬间关闭阻尼执行一次 `update()` 清空残留的
 * `sphericalDelta / panOffset`，避免起飞前的拖拽惯性在落地后突然窜出。
 */
function clearOrbitResidualDelta(controls: OrbitControlsImpl): void {
  const prevDamping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = prevDamping;
}

/**
 * applyNarrowPortraitFraming —— 窄屏竖屏（如 390x844 移动端）自适应全景构图修正（M20）。
 *
 * 【设计意图】窄屏竖屏下透视相机水平 FOV 明显收窄，固定桌面全景机位 [7.8, 14, 22]
 * 会裁切两侧机架边缘。仅在视口宽度 < 520 且高大于宽时收敛水平偏置并沿视线适度后退，
 * 桌面与宽屏 E2E 视口零改动。
 */
function applyNarrowPortraitFraming(focus: CameraFocus): CameraFocus {
  if (typeof window === 'undefined') return focus;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w <= 0 || w >= 520 || h <= w) return focus;

  const dx = focus.position[0] - focus.lookAt[0];
  const dy = focus.position[1] - focus.lookAt[1];
  const dz = focus.position[2] - focus.lookAt[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 12) return focus;

  const clampedScale = Math.min(1.28, (MAX_ORBIT_DISTANCE - 1) / dist);
  return {
    position: [
      focus.lookAt[0] + dx * 0.55 * clampedScale,
      focus.lookAt[1] + dy * clampedScale,
      focus.lookAt[2] + dz * clampedScale,
    ],
    lookAt: focus.lookAt,
  };
}

/* ========================================================================== */
/* CameraRig 主体                                                              */
/* ========================================================================== */

export default function CameraRig() {
  const camera = useThree((s): THREE.Camera => s.camera);
  const gl = useThree((s): THREE.WebGLRenderer => s.gl);

  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectedEntityType = useClusterStore((s): SelectedEntityType | null => s.selectedEntityType);
  const isOrbitPatrolActive = useClusterStore((s): boolean => s.isOrbitPatrolActive);

  const [reducedMotion, setReducedMotion] = useState<boolean>(() => isReducedMotion());
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < CAMERA_MOTION.mobileBreakpointPx : false,
  );

  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const isAnimatingRef = useRef<boolean>(false);
  const prevSelectionKeyRef = useRef<string>(
    `${selectedEntityId ?? 'null'}|${selectedEntityType ?? 'null'}`,
  );

  const focusRef = useRef<CameraFocus>({
    position: OVERVIEW_CAMERA_POSITION,
    lookAt: OVERVIEW_LOOK_AT,
  });
  const openingTargetRef = useRef<CameraFocus>({
    position: OVERVIEW_CAMERA_POSITION,
    lookAt: OVERVIEW_LOOK_AT,
  });

  const targetPosVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const targetLookVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const flightStartVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const flightStartLookVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const currentLookVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const flightDirVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const flightSideVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const arcPointVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);

  /* ---- 球面插值预分配对象（useFrame 内零堆分配） ---- */
  const sphericalOffsetStartVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const sphericalOffsetEndVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const sphericalStart = useMemo((): THREE.Spherical => new THREE.Spherical(), []);
  const sphericalEnd = useMemo((): THREE.Spherical => new THREE.Spherical(), []);
  const sphericalCurr = useMemo((): THREE.Spherical => new THREE.Spherical(), []);

  const flightDurationRef = useRef<number>(CAMERA_MOTION.flightDurationS);
  const flightElapsedRef = useRef<number>(0);
  const flightStartWallMsRef = useRef<number>(0);
  const useSphericalFlightRef = useRef<boolean>(false);
  const activePresetRef = useRef<ViewPresetKey | null>('overview');
  const previousPresetRef = useRef<ViewPresetKey | null>('overview');
  const flightKindRef = useRef<'preset' | 'entity' | null>(null);

  const openingProgressRef = useRef<number>(0);
  const openingDoneRef = useRef<boolean>(false);

  useEffect(() => {
    setReducedMotion(isReducedMotion());
    return subscribeReducedMotion((nextReduced) => {
      setReducedMotion(nextReduced);
      if (nextReduced) {
        const store = useClusterStore.getState();
        if (store.isOrbitPatrolActive) {
          store.setOrbitPatrolActive(false, 'user');
        }
      }
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleResize = (): void => {
      setIsMobileViewport(window.innerWidth < CAMERA_MOTION.mobileBreakpointPx);
      openingTargetRef.current = applyNarrowPortraitFraming({
        position: OVERVIEW_CAMERA_POSITION,
        lookAt: OVERVIEW_LOOK_AT,
      });
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const disengagePatrolIfActive = (): void => {
    const state = useClusterStore.getState();
    if (state.patrolLockedByProgram) return;
    if (state.isOrbitPatrolActive) {
      state.setOrbitPatrolActive(false, 'user');
    }
  };

  /**
   * beginFlight —— 初始化一次程序化相机飞行（统一计算时长、起终点快照与球面模式）。
   */
  const beginFlight = (
    rawFocus: CameraFocus,
    kind: 'preset' | 'entity',
    preset: ViewPresetKey | null,
  ): void => {
    const nextFocus = applyNarrowPortraitFraming(rawFocus);
    const controls = controlsRef.current;
    focusRef.current = nextFocus;
    openingDoneRef.current = true;
    flightStartVec.copy(camera.position);

    if (controls !== null) {
      flightStartLookVec.copy(controls.target);
      controls.enabled = false;
    } else {
      flightStartLookVec.set(OVERVIEW_LOOK_AT[0], OVERVIEW_LOOK_AT[1], OVERVIEW_LOOK_AT[2]);
    }

    targetPosVec.set(nextFocus.position[0], nextFocus.position[1], nextFocus.position[2]);
    targetLookVec.set(nextFocus.lookAt[0], nextFocus.lookAt[1], nextFocus.lookAt[2]);

    /* 判定是否为 overview <-> topdown（或大幅方位角翻转）球面插值通道 */
    let shouldUseSpherical = false;
    if (kind === 'preset' && preset !== null) {
      const prevPreset = previousPresetRef.current;
      const isPresetFlip =
        (prevPreset === 'overview' && preset === 'topdown') ||
        (prevPreset === 'topdown' && preset === 'overview');

      sphericalOffsetStartVec.subVectors(flightStartVec, flightStartLookVec);
      sphericalOffsetEndVec.subVectors(targetPosVec, targetLookVec);
      sphericalStart.setFromVector3(sphericalOffsetStartVec);
      sphericalEnd.setFromVector3(sphericalOffsetEndVec);
      const deltaAzimuth = Math.abs(
        Math.atan2(
          Math.sin(sphericalEnd.theta - sphericalStart.theta),
          Math.cos(sphericalEnd.theta - sphericalStart.theta),
        ),
      );
      shouldUseSpherical = isPresetFlip || deltaAzimuth >= SPHERICAL_AZIMUTH_THRESHOLD_RAD;
      previousPresetRef.current = preset;
    } else {
      previousPresetRef.current = null;
    }

    const reducedNow = isReducedMotion();
    const durationS = reducedNow
      ? CAMERA_MOTION.reducedFlightDurationS
      : shouldUseSpherical
        ? CAMERA_MOTION.topdownSphericalDurationS
        : CAMERA_MOTION.flightDurationS;

    useSphericalFlightRef.current = shouldUseSpherical;
    flightDurationRef.current = durationS;
    flightElapsedRef.current = 0;
    flightStartWallMsRef.current = performance.now();
    activePresetRef.current = preset;
    flightKindRef.current = kind;
    isAnimatingRef.current = true;

    publishFlightStatus({ isFlying: true, activePreset: preset, kind });
    publishFlightProgress(0);

    beginDebugFlightTrace(
      shouldUseSpherical ? 'preset-spherical' : kind,
      durationS * 1000,
      [flightStartVec.x, flightStartVec.y, flightStartVec.z],
      nextFocus.position,
    );
  };

  /**
   * abortFlightToUser —— 立即中止飞行/开场并恢复 OrbitControls 自由控制权。
   */
  const abortFlightToUser = (): void => {
    const wasFlying = isAnimatingRef.current || !openingDoneRef.current;
    if (!wasFlying) return;

    isAnimatingRef.current = false;
    openingDoneRef.current = true;

    const controls = controlsRef.current;
    if (controls !== null) {
      controls.target.copy(currentLookVec);
      controls.enabled = true;
      camera.lookAt(controls.target);
      clearOrbitResidualDelta(controls);
    }

    const store = useClusterStore.getState();
    if (store.isOrbitPatrolActive) {
      store.setOrbitPatrolActive(false, 'user');
    }

    publishFlightStatus({
      isFlying: false,
      activePreset: null,
      kind: null,
    });
    publishFlightProgress(1);
    endDebugFlightTrace(false, flightElapsedRef.current * 1000);
  };

  /* ---- 挂载开场运镜 ---- */
  useEffect((): void => {
    const framedOverview = applyNarrowPortraitFraming({
      position: OVERVIEW_CAMERA_POSITION,
      lookAt: OVERVIEW_LOOK_AT,
    });
    openingTargetRef.current = framedOverview;
    currentLookVec.set(
      framedOverview.lookAt[0],
      framedOverview.lookAt[1],
      framedOverview.lookAt[2],
    );
    if (isReducedMotion()) {
      camera.position.set(
        framedOverview.position[0],
        framedOverview.position[1],
        framedOverview.position[2],
      );
      openingDoneRef.current = true;
      const controls = controlsRef.current;
      if (controls !== null) {
        controls.target.copy(currentLookVec);
        controls.enabled = true;
        clearOrbitResidualDelta(controls);
      }
      return;
    }

    camera.position.set(
      OPENING_CAMERA_POSITION[0],
      OPENING_CAMERA_POSITION[1],
      OPENING_CAMERA_POSITION[2],
    );
    const controls = controlsRef.current;
    if (controls !== null) {
      controls.target.copy(currentLookVec);
      controls.enabled = false;
    }
  }, [camera, currentLookVec]);

  /* ---- 飞行通道 1：选中实体变更（跳过首次挂载重复飞行） ---- */
  useEffect(() => {
    const nextKey = `${selectedEntityId ?? 'null'}|${selectedEntityType ?? 'null'}`;
    if (nextKey === prevSelectionKeyRef.current) {
      return;
    }
    prevSelectionKeyRef.current = nextKey;
    if (selectedEntityId !== null) {
      disengagePatrolIfActive();
    }
    const snapshot = useClusterStore.getState().snapshotSummary;
    const nextFocus = resolveCameraFocus(selectedEntityId, selectedEntityType, snapshot);
    beginFlight(nextFocus, 'entity', selectedEntityId === null ? 'overview' : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntityId, selectedEntityType]);

  /* ---- 飞行通道 2：视角预设总线 ---- */
  useEffect(() => {
    return subscribeViewPreset((preset): void => {
      disengagePatrolIfActive();
      const nextFocus = resolveViewPresetFocus(preset);
      beginFlight(nextFocus, 'preset', preset);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  /* ---- 用户接管 + 滚轮缩放整形 + 280ms/<6px 双击复位 ---- */
  useEffect(() => {
    const domElement = gl.domElement;
    if (domElement === undefined || domElement === null) return undefined;

    let pointerDownX = 0;
    let pointerDownY = 0;
    let pointerActive = false;
    let lastTap: { x: number; y: number; timeMs: number } | null = null;
    let restoreZoomFrame = false;

    const handleCapturePointerDown = (event: PointerEvent): void => {
      if (event.button === 0) {
        pointerDownX = event.clientX;
        pointerDownY = event.clientY;
        pointerActive = true;
      }
      /* 用户按住画布准备拖拽时，若飞行仍在进行则立刻挂起飞行并释放 OrbitControls */
      abortFlightToUser();
    };

    const handleCapturePointerUp = (event: PointerEvent): void => {
      if (!pointerActive || event.button !== 0) return;
      pointerActive = false;
      const moveFromDown = Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY);
      if (moveFromDown >= CAMERA_MOTION.dblClickMaxMovePx) {
        lastTap = null;
        return;
      }

      const now = performance.now();
      if (
        lastTap !== null &&
        now - lastTap.timeMs <= CAMERA_MOTION.dblClickWindowMs &&
        Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < CAMERA_MOTION.dblClickMaxMovePx
      ) {
        lastTap = null;
        markDoubleClickResetTriggered();
        incrementDblClickResetCount();
        prevSelectionKeyRef.current = 'null|null';
        useClusterStore.getState().selectEntity(null);
        dispatchViewPreset('overview');
        return;
      }

      lastTap = { x: event.clientX, y: event.clientY, timeMs: now };
    };

    const handleCaptureTouchStart = (): void => {
      abortFlightToUser();
    };

    const handleCaptureWheel = (event: WheelEvent): void => {
      abortFlightToUser();
      const controls = controlsRef.current;
      if (controls === null) return;
      const clampedAbs = Math.min(CAMERA_MOTION.wheelDeltaClamp, Math.abs(event.deltaY));
      if (clampedAbs <= 0) return;
      const ctrlScale = event.ctrlKey ? CAMERA_MOTION.wheelCtrlFactor : 1;
      const modulated = Math.max(
        0.06,
        CAMERA_MOTION.zoomSpeed * (clampedAbs / CAMERA_MOTION.wheelDeltaClamp) * ctrlScale,
      );
      controls.zoomSpeed = modulated;
      if (!restoreZoomFrame) {
        restoreZoomFrame = true;
        queueMicrotask(() => {
          restoreZoomFrame = false;
          if (controlsRef.current !== null) {
            controlsRef.current.zoomSpeed = CAMERA_MOTION.zoomSpeed;
          }
        });
      }
    };

    const controls = controlsRef.current;
    const handleControlsStart = (): void => {
      const store = useClusterStore.getState();
      if (store.isOrbitPatrolActive) {
        store.setOrbitPatrolActive(false, 'user');
      }
    };

    domElement.addEventListener('pointerdown', handleCapturePointerDown, { capture: true });
    domElement.addEventListener('pointerup', handleCapturePointerUp, { capture: true });
    domElement.addEventListener('touchstart', handleCaptureTouchStart, {
      capture: true,
      passive: true,
    });
    domElement.addEventListener('wheel', handleCaptureWheel, { capture: true, passive: true });
    controls?.addEventListener('start', handleControlsStart);

    return () => {
      domElement.removeEventListener('pointerdown', handleCapturePointerDown, { capture: true });
      domElement.removeEventListener('pointerup', handleCapturePointerUp, { capture: true });
      domElement.removeEventListener('touchstart', handleCaptureTouchStart, { capture: true });
      domElement.removeEventListener('wheel', handleCaptureWheel, { capture: true });
      controls?.removeEventListener('start', handleControlsStart);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl]);

  /* ---- 主渲染前更新（priority -2：先于 drei OrbitControls useFrame(-1) 执行） ---- */
  useFrame((state, delta): void => {
    const controls = controlsRef.current;
    const clampedDelta = Math.min(Math.max(delta, 0), MAX_FRAME_DELTA);
    const reducedNow = isReducedMotion();
    const minDist = isMobileViewport
      ? CAMERA_MOTION.mobileMinDistance
      : CAMERA_MOTION.desktopMinDistance;
    const enablePan = !isMobileViewport;

    /* ---- 1. 开场运镜（仅非 reduced-motion 时执行，期间挂起 OrbitControls 自动更新） ---- */
    if (!openingDoneRef.current) {
      if (controls !== null && controls.enabled) {
        controls.enabled = false;
      }
      openingProgressRef.current = Math.min(
        1,
        openingProgressRef.current + clampedDelta / OPENING_FLIGHT_DURATION,
      );
      const alpha = 1 - Math.exp(-OPENING_FLIGHT_DAMPING * clampedDelta);
      const openingTarget = openingTargetRef.current;
      targetPosVec.set(
        openingTarget.position[0],
        openingTarget.position[1],
        openingTarget.position[2],
      );
      targetLookVec.set(
        openingTarget.lookAt[0],
        openingTarget.lookAt[1],
        openingTarget.lookAt[2],
      );
      state.camera.position.lerp(targetPosVec, alpha);
      currentLookVec.lerp(targetLookVec, alpha);
      state.camera.lookAt(currentLookVec);

      if (
        openingProgressRef.current >= 1 ||
        state.camera.position.distanceTo(targetPosVec) < 0.05
      ) {
        state.camera.position.copy(targetPosVec);
        currentLookVec.copy(targetLookVec);
        state.camera.lookAt(currentLookVec);
        openingDoneRef.current = true;
        if (controls !== null) {
          controls.target.copy(currentLookVec);
          controls.enabled = true;
          clearOrbitResidualDelta(controls);
        }
      }
    }

    /* ---- 2. 程序化飞行（720ms 三段式 / 820ms 球面 / <=200ms 减少动效） ---- */
    if (isAnimatingRef.current) {
      if (controls !== null && controls.enabled) {
        controls.enabled = false;
      }

      const focus = focusRef.current;
      targetPosVec.set(focus.position[0], focus.position[1], focus.position[2]);
      targetLookVec.set(focus.lookAt[0], focus.lookAt[1], focus.lookAt[2]);

      const durationS = Math.max(0.05, flightDurationRef.current);
      const wallElapsedMs = Math.max(0, performance.now() - flightStartWallMsRef.current);
      flightElapsedRef.current = Math.min(durationS, wallElapsedMs / 1000);
      const p = Math.min(1, flightElapsedRef.current / durationS);
      const eased = easeThreeStageFlight(p, reducedNow);

      currentLookVec.lerpVectors(flightStartLookVec, targetLookVec, eased);

      if (useSphericalFlightRef.current) {
        sphericalOffsetStartVec.subVectors(flightStartVec, flightStartLookVec);
        sphericalOffsetEndVec.subVectors(targetPosVec, targetLookVec);
        sphericalStart.setFromVector3(sphericalOffsetStartVec);
        sphericalEnd.setFromVector3(sphericalOffsetEndVec);

        const deltaAzimuth = Math.atan2(
          Math.sin(sphericalEnd.theta - sphericalStart.theta),
          Math.cos(sphericalEnd.theta - sphericalStart.theta),
        );
        sphericalCurr.radius = THREE.MathUtils.lerp(sphericalStart.radius, sphericalEnd.radius, eased);
        sphericalCurr.phi = THREE.MathUtils.clamp(
          THREE.MathUtils.lerp(sphericalStart.phi, sphericalEnd.phi, eased),
          MIN_POLAR_ANGLE,
          MAX_POLAR_ANGLE,
        );
        sphericalCurr.theta = sphericalStart.theta + deltaAzimuth * eased;
        sphericalOffsetStartVec.setFromSpherical(sphericalCurr);
        state.camera.position.copy(currentLookVec).add(sphericalOffsetStartVec);
      } else {
        flightDirVec.subVectors(targetPosVec, flightStartVec);
        const flightDistance = flightDirVec.length();
        arcPointVec.lerpVectors(flightStartVec, targetPosVec, eased);

        if (flightDistance > 0.001 && !reducedNow) {
          flightDirVec.multiplyScalar(1 / flightDistance);
          flightSideVec.set(0, 1, 0).cross(flightDirVec);
          const sideLen = flightSideVec.length();
          if (sideLen > 0.001) {
            flightSideVec.multiplyScalar(1 / sideLen);
          } else {
            flightSideVec.set(0, 0, 0);
          }

          const envelope = computeFlightArcEnvelope(p, false);
          const lift =
            Math.min(FLIGHT_ARC_LIFT_MAX, flightDistance * FLIGHT_ARC_LIFT_RATIO) * envelope;
          const sideStep =
            Math.min(FLIGHT_ARC_SIDESTEP_MAX, flightDistance * FLIGHT_ARC_SIDESTEP_RATIO) *
            envelope;
          arcPointVec.y += lift;
          arcPointVec.addScaledVector(flightSideVec, sideStep);
        }

        state.camera.position.copy(arcPointVec);
      }

      if (controls !== null) {
        controls.target.copy(currentLookVec);
      }
      state.camera.lookAt(currentLookVec);
      publishFlightProgress(p);
      pushDebugFlightSample(
        wallElapsedMs,
        p,
        state.camera.position.x,
        state.camera.position.y,
        state.camera.position.z,
      );

      if (p >= 1) {
        state.camera.position.copy(targetPosVec);
        currentLookVec.copy(targetLookVec);
        if (controls !== null) {
          controls.target.copy(targetLookVec);
          controls.enabled = true;
          clearOrbitResidualDelta(controls);
        }
        state.camera.lookAt(targetLookVec);
        isAnimatingRef.current = false;
        publishFlightProgress(1);
        publishFlightStatus({
          isFlying: false,
          activePreset: activePresetRef.current,
          kind: flightKindRef.current,
        });
        endDebugFlightTrace(true, wallElapsedMs);
      }
    } else if (openingDoneRef.current && controls !== null) {
      /* ---- 3. 自由态：由 drei OrbitControls useFrame(-1) 统一 update，此处仅同步 dt 阻尼与开关 ---- */
      if (!controls.enabled) {
        controls.enabled = true;
      }
      controls.dampingFactor = computeDtDamping(clampedDelta, CAMERA_MOTION.orbitBaseDamping);
      const patrolActive = !reducedNow && useClusterStore.getState().isOrbitPatrolActive;
      if (controls.autoRotate !== patrolActive) {
        controls.autoRotate = patrolActive;
      }
    }

    if (isCameraDebugEnabled()) {
      const lookTarget = controls?.target ?? currentLookVec;
      updateDebugCameraState({
        position: [state.camera.position.x, state.camera.position.y, state.camera.position.z],
        target: [lookTarget.x, lookTarget.y, lookTarget.z],
        dampingFactor: controls?.dampingFactor ?? CAMERA_MOTION.orbitBaseDamping,
        isAnimating: isAnimatingRef.current,
        autoRotate: controls?.autoRotate ?? false,
        reducedMotion: reducedNow,
        minDistance: minDist,
        enablePan,
        zoomSpeed: controls?.zoomSpeed ?? CAMERA_MOTION.zoomSpeed,
        wheelDeltaClamp: CAMERA_MOTION.wheelDeltaClamp,
        breathAmplitudeScale: reducedNow ? REDUCED_MOTION_AMPLITUDE : 1,
      });
    }
  }, -2);

  const effectiveAutoRotate = !reducedMotion && isOrbitPatrolActive;
  const minOrbitDistance = isMobileViewport
    ? CAMERA_MOTION.mobileMinDistance
    : CAMERA_MOTION.desktopMinDistance;

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={CAMERA_MOTION.orbitBaseDamping}
      minPolarAngle={MIN_POLAR_ANGLE}
      maxPolarAngle={MAX_POLAR_ANGLE}
      minDistance={minOrbitDistance}
      maxDistance={MAX_ORBIT_DISTANCE}
      enablePan={!isMobileViewport}
      panSpeed={0.6}
      rotateSpeed={0.75}
      zoomSpeed={CAMERA_MOTION.zoomSpeed}
      autoRotate={effectiveAutoRotate}
      autoRotateSpeed={ORBIT_PATROL_SPEED}
    />
  );
}
