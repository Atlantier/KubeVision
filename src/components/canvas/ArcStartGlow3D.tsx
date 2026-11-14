'use client';

/**
 * KubeVision AI — 弧线起点汇聚光斑（R25 · B8）
 *
 * 【要解决什么】NetworkStream3D 的三条光缆起点从晶体赤道环外缘出发，
 * 但线条本身"插在空中"——用户看不出能量是从晶体哪个位置汇聚出的。
 * 这里在每条弧线起点放一个 0.15s 周期的汇聚光斑：平时几乎不可见，
 * 数据包出发瞬间提亮并收缩，形成"能量从晶体抽出→注入光缆"的因果链。
 *
 * 【为何单独组件】NetworkStream3D 的 useFrame 已负责 54 个粒子的推进，
 * 再塞入 3 个光斑的状态会让那个热路径更难读；拆成独立小组件后，
 * 这里只有 3 个 mesh 的 opacity 更新，互不影响。
 *
 * 【零分配】只写 material.opacity / mesh.scale（预分配对象），不 new。
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { REDUCED_MOTION_AMPLITUDE, isReducedMotion } from '@/constants/motion';
import { getRackTransform } from '@/utils/spatialLayout';
import { MASTER_POSITION } from '@/utils/spatialLayout';

/** 赤道环半径：弧线起点 = 晶核中心 + 水平方向 × 该半径（与 CrystalOptics 晶体赤道一致） */
export const CRYSTAL_EQUATOR_RADIUS = 1.05;

/** 汇聚节奏：1.5s 一轮，前 0.15s 为高亮窗口（10% duty） */
const CONVERGE_PERIOD = 1.5;
const CONVERGE_WINDOW = 0.15;

/** 三条车道的起点（模块级一次计算，静态拓扑） */
const ARC_STARTS: readonly THREE.Vector3[] = (() => {
  const master = new THREE.Vector3(MASTER_POSITION[0], MASTER_POSITION[1], MASTER_POSITION[2]);
  const starts: THREE.Vector3[] = [];
  for (let k = 0; k < 3; k += 1) {
    const rack = getRackTransform(k);
    const dir = new THREE.Vector3(rack.position[0] - master.x, 0, rack.position[2] - master.z).normalize();
    starts.push(master.clone().addScaledVector(dir, CRYSTAL_EQUATOR_RADIUS));
  }
  return starts;
})();

/** ArcStartGlow3D —— 三条弧线起点的汇聚光斑 */
export default function ArcStartGlow3D(): React.ReactElement {
  const meshRefs = useRef<ReadonlyArray<THREE.Mesh | null>>([]);
  const materialRefs = useRef<ReadonlyArray<THREE.MeshBasicMaterial | null>>([]);
  const animPhaseRef = useRef<number>(0);

  useFrame((_state, delta): void => {
    const dt = Math.min(delta, 0.1);
    const motionScale = isReducedMotion() ? REDUCED_MOTION_AMPLITUDE : 1;
    animPhaseRef.current += dt * motionScale;
    const t = animPhaseRef.current;
    for (let k = 0; k < ARC_STARTS.length; k += 1) {
      const mesh = meshRefs.current[k];
      const material = materialRefs.current[k];
      if (mesh === null || mesh === undefined || material === null || material === undefined) continue;
      /* 相位错开：三条车道不同时闪烁 */
      const phase = (t + k * (CONVERGE_PERIOD / 3)) % CONVERGE_PERIOD;
      /* 前 0.15s 窗口内：亮度从 1 快速衰减到 0；窗口外恒 0.05（几乎不可见） */
      const windowNorm = phase < CONVERGE_WINDOW ? 1 - phase / CONVERGE_WINDOW : 0;
      const intensity = 0.05 + 0.95 * motionScale * windowNorm * windowNorm;
      material.opacity = intensity * 0.9;
      /* 收敛：窗口初期尺寸大，结束前收缩到 0.6 倍（"汇聚"而不是"爆开"） */
      const scale = 0.55 + 0.45 * (1 - windowNorm * motionScale);
      mesh.scale.setScalar(scale);
    }
  });

  return (
    <group>
      {ARC_STARTS.map((start, index) => (
        <mesh
          key={`arc-start-${index}`}
          position={[start.x, start.y, start.z]}
          ref={(node): void => {
            meshRefs.current = [
              ...meshRefs.current.slice(0, index),
              node,
              ...meshRefs.current.slice(index + 1),
            ];
          }}
          raycast={(): void => undefined}
          renderOrder={3}
        >
          <sphereGeometry args={[0.11, 16, 12]} />
          <meshBasicMaterial
            ref={(material): void => {
              materialRefs.current = [
                ...materialRefs.current.slice(0, index),
                material,
                ...materialRefs.current.slice(index + 1),
              ];
            }}
            color="#a5f3fc"
            transparent
            opacity={0.05}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      ))}
    </group>
  );
}