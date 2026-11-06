'use client';

/**
 * KubeVision AI — 3D 选中实体空间锁定光环（SelectionBeacon3D）
 *
 * 【解决什么问题】审查报告 §2.4 指出的核心短板：
 * 点击 Worker 机架时 WorkerRack3D 有青色呼吸描边与底座环，但点击**单个 Pod**
 * 推近特写后，PodInstancedMesh 根本不读 selectedEntityId——同层 4 个相邻槽位
 * 的 Pod 方块挤在画面中心，用户完全分不清左上角探针面板指的是哪一颗。
 *
 * 【方案】挂载一个独立的轻量锁定标记（1 个线框包围盒 + 1 个旋转刻度环），
 * 订阅 selectedEntityId 定位到对应槽位坐标。这不是「给 Pod 加特效」，
 * 而是**在空间里画一个准星**——与巡检面板形成「数据 ↔ 空间」的闭环指认。
 *
 * 【性能契约（AGENTS.md 第 3 条）】
 * - useFrame 内零 useState、零 React 更新；
 * - 所有 THREE 对象在 useMemo 中预分配，useFrame 只做原地 .set() / 赋值；
 * - 呼吸与自转由 useFrame 直接写 ref.current.rotation / scale，
 *   不触发任何组件重渲染。
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { useClusterStore } from '@/store/useClusterStore';
import { getPodWorldTransform } from '@/utils/spatialLayout';
import type { PodEntity } from '@/types/cluster';
import type { SelectedEntityType } from '@/types/store';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 锁定环半径（略大于 Pod 盒子，形成包围感） */
const RING_RADIUS = 0.34;

/** 锁定环线框细分（8 边形在透视下既有科技感又省三角形） */
const RING_SEGMENTS = 8;

/** 呼吸周期（秒）——与机架选中态的呼吸节奏保持一致 */
const BREATH_PERIOD_S = 1.6;

/** 呼吸缩放幅度（±8%，克制不喧宾夺主） */
const BREATH_AMPLITUDE = 0.08;

/** 自转速度（弧度/秒）——缓慢扫过，暗示"正在锁定" */
const SPIN_SPEED = 0.9;

/** 顶部竖线高度（从 Pod 顶部向上延伸的指示杆） */
const BEAM_HEIGHT = 0.42;

/** 锁定主色（主题青，与全局选中态语义一致） */
const BEACON_COLOR = '#22d3ee';

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * SelectionBeacon3D —— 选中 Pod 的空间锁定光环。
 *
 * 【为何只处理 Pod】机架与 Master 已有自己的选中视觉（WorkerRack3D 的
 * 描边 + 底座环、MasterNode3D 的 emphasized 状态），重复叠加反而杂乱。
 * 本组件专门补 Pod 这一层的缺失。
 *
 * 【渲染条件】仅当 selectedEntityType === 'pod' 且能在快照中找到该 Pod 时渲染。
 */
export default function SelectionBeacon3D(): React.ReactElement | null {
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectedEntityType = useClusterStore((s): SelectedEntityType | null => s.selectedEntityType);
  const pods = useClusterStore((s): readonly PodEntity[] => s.snapshotSummary.pods);

  /* 定位目标 Pod 并解算其槽位世界坐标（仅选中变化时重算） */
  const anchor = useMemo((): { position: [number, number, number]; rotationY: number } | null => {
    if (selectedEntityType !== 'pod' || selectedEntityId === null) return null;
    const pod = pods.find((p): boolean => p.id === selectedEntityId);
    if (pod === undefined) return null;

    const transform = getPodWorldTransform(pod.rackIndex, pod.slotIndex);
    return { position: transform.position, rotationY: transform.rotationY };
  }, [selectedEntityType, selectedEntityId, pods]);

  /* ---- 预分配动画对象引用 ---- */
  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const boxRef = useRef<THREE.LineSegments>(null);

  useFrame((state): void => {
    if (anchor === null) return;

    /* 用场景时钟驱动动画：单一时间源，标签页切回时不会累积跳变 */
    const t = state.clock.elapsedTime;

    /* ---- 呼吸缩放：sin 波在 1±AMPLITUDE 之间往复 ---- */
    const group = groupRef.current;
    if (group !== null) {
      const breath = 1 + Math.sin((t / BREATH_PERIOD_S) * Math.PI * 2) * BREATH_AMPLITUDE;
      group.scale.setScalar(breath);
    }

    /* ---- 刻度环自转（仅改 rotation.y，零分配） ---- */
    const ring = ringRef.current;
    if (ring !== null) {
      ring.rotation.z = t * SPIN_SPEED;
    }

    /* ---- 线框包围盒做轻微反向自转，制造"锁定扫描"层次感 ---- */
    const box = boxRef.current;
    if (box !== null) {
      box.rotation.y = -t * SPIN_SPEED * 0.5;
    }
  });

  /* 无 Pod 选中 → 不渲染任何场景节点（零开销） */
  if (anchor === null) return null;

  return (
    <group
      ref={groupRef}
      position={anchor.position}
      rotation={[0, anchor.rotationY, 0]}
      /* 锁定标记不参与射线拾取，避免遮挡真实的 Pod 点击 */
      raycast={(): void => undefined}
    >
      {/*
       * 刻度环：躺平在 Pod 底部（绕 X 轴 -90° 平铺 XZ 平面），
       * 用 8 边形线框 + 稀疏刻度感表达"扫描锁定"。
       */}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.46, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[RING_RADIUS - 0.02, RING_RADIUS, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={BEACON_COLOR}
          transparent
          opacity={0.85}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>

      {/* 内圈：更小更淡，形成双环层次 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.46, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[RING_RADIUS * 0.55, RING_RADIUS * 0.62, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={BEACON_COLOR}
          transparent
          opacity={0.5}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>

      {/*
       * 线框包围盒：BoxGeometry 的 EdgesGeometry 只保留 12 条棱，
       * 比实体半透明包围盒更"仪表化"，且三角形数个位数。
       */}
      <lineSegments ref={boxRef} raycast={(): void => undefined}>
        <edgesGeometry args={[new THREE.BoxGeometry(0.42, 0.5, 0.42)]} />
        <lineBasicMaterial color={BEACON_COLOR} transparent opacity={0.75} toneMapped={false} />
      </lineSegments>

      {/*
       * 顶部指示杆：从 Pod 顶部向上伸出的细线，
       * 在俯视角下帮助用户从上方判断锁定目标位置。
       */}
      <mesh position={[0, 0.5, 0]} raycast={(): void => undefined}>
        <boxGeometry args={[0.012, BEAM_HEIGHT, 0.012]} />
        <meshBasicMaterial color={BEACON_COLOR} transparent opacity={0.6} toneMapped={false} />
      </mesh>
    </group>
  );
}
