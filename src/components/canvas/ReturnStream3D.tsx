'use client';

/**
 * KubeVision AI — 回流数据流（R28 追问 1：流量方向性）
 *
 * 【解决什么】旧实现三条弧线只有"去程"粒子（控制平面 → 机架），
 * 数据流看起来像单向喷射，无法表达"请求 → 响应"的真实语义。
 *
 * 本组件在同一批曲线上叠加**回程**粒子（机架 → 控制平面）：
 *  - 去程（既有 NetworkStream3D）：主题青，速度随 nodeNet；
 *  - 回程（本组件）：淡蓝 `#93c5fd`，沿同一曲线反向取样（t 从 1→0）；
 *  - **Pod 异常时回程缺失**：该机架名下出现非 Running Pod 或节点非 Ready 时，
 *    回程粒子被隐藏（scale=0）——请求还在发，响应回不来，这就是"故障"最直观的视觉证据。
 *
 * 【性能】单个 InstancedMesh = **1 draw call**；54 个实例；
 * useFrame 内零分配（复用模块级 temp 对象与 LANE_CURVES 切线缓存）、零 setState。
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { LANE_CURVES } from '@/components/canvas/NetworkStream3D';
import { telemetryTransientRef } from '@/store/useTelemetryRef';

/** 每条回程车道的粒子数 */
const RETURN_PER_LANE = 18;
/** 三条车道总实例数 */
const RETURN_TOTAL = RETURN_PER_LANE * 3;
/** 回程颜色（淡蓝，与去程主题青形成方向区分） */
const RETURN_COLOR = '#93c5fd';
/** 相位推进速度（周期/秒） */
const RETURN_SPEED = 0.16;
/** 回程缺失判定刷新间隔（毫秒） */
const MISSING_CHECK_MS = 250;

/** 模块级临时对象（useFrame 零分配） */
const tempObject = new THREE.Object3D();
const tempColor = new THREE.Color(RETURN_COLOR);
const tempVec = new THREE.Vector3();

/**
 * isRackResponseMissing —— 判定某机架是否"响应回不来"。
 *
 * 【语义】只要该机架存在非 Running 的 Pod，或节点本身非 Ready，
 * 就认为这一侧的响应链路异常，回程粒子应当消失。
 *
 * @param rackIndex 机架索引
 * @returns 是否缺失回程
 */
function isRackResponseMissing(rackIndex: number): boolean {
  const snapshot = telemetryTransientRef.snapshot;
  const node = snapshot.nodes.find((item): boolean => item.rackIndex === rackIndex);
  if (node === undefined) return true;
  if (node.status !== 'Ready') return true;
  return snapshot.pods.some(
    (pod): boolean => pod.nodeId === node.id && pod.status !== 'Running',
  );
}

/** ReturnStream3D —— 三条弧线上的淡蓝回程粒子（1 draw call） */
export default function ReturnStream3D(): React.ReactElement {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  /** 每条车道/每个实例的持久相位 */
  const phaseRef = useRef<Float32Array>(
    (() => {
      const phases = new Float32Array(RETURN_TOTAL);
      for (let i = 0; i < RETURN_TOTAL; i += 1) phases[i] = (i * 0.6180339887) % 1;
      return phases;
    })(),
  );
  /** 缺失状态镜像（useFrame 读取，250ms 刷新，避免每帧访问快照数组） */
  const missingRef = useRef<boolean[]>([false, false, false]);
  const lastCheckRef = useRef<number>(0);

  /** 初始化实例色（触发 instanceColor 缓冲创建，AGENTS.md 第 7 条前置） */
  useEffect((): void => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    for (let i = 0; i < RETURN_TOTAL; i += 1) {
      mesh.setColorAt(i, tempColor);
    }
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, []);

  /** 相位初值（挂载时一次，避免首帧全在起点） */
  useMemo((): void => {
    const phases = phaseRef.current;
    for (let lane = 0; lane < 3; lane += 1) {
      for (let p = 0; p < RETURN_PER_LANE; p += 1) {
        phases[lane * RETURN_PER_LANE + p] = (p / RETURN_PER_LANE + lane * 0.13) % 1;
      }
    }
  }, []);

  useFrame((_state, delta): void => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const dt = Math.min(delta, 0.1);
    const now = performance.now();

    if (now - lastCheckRef.current >= MISSING_CHECK_MS) {
      lastCheckRef.current = now;
      for (let lane = 0; lane < 3; lane += 1) {
        missingRef.current[lane] = isRackResponseMissing(lane);
      }
    }

    const phases = phaseRef.current;
    for (let lane = 0; lane < 3; lane += 1) {
      const curve = LANE_CURVES[lane];
      const missing = missingRef.current[lane];
      for (let p = 0; p < RETURN_PER_LANE; p += 1) {
        const index = lane * RETURN_PER_LANE + p;
        let u = phases[index];
        u = (u + RETURN_SPEED * dt) % 1;
        phases[index] = u;
        if (missing) {
          /* 回程缺失：缩到 0（不提交可见像素），而不是删除实例（容量恒定） */
          tempObject.scale.setScalar(0);
          tempObject.position.set(0, -100, 0);
        } else {
          /* 反向取样：t = 1-u，从机架回到控制平面 */
          curve.getPointAt(1 - u, tempVec);
          tempObject.position.copy(tempVec);
          tempObject.scale.setScalar(0.55 + 0.45 * (1 - u));
        }
        tempObject.rotation.set(0, 0, 0);
        tempObject.updateMatrix();
        mesh.setMatrixAt(index, tempObject.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, RETURN_TOTAL]}
      raycast={(): void => undefined}
      frustumCulled={false}
      renderOrder={3}
    >
      <sphereGeometry args={[0.024, 6, 6]} />
      <meshBasicMaterial
        color="#ffffff"
        transparent
        opacity={0.72}
        depthWrite={false}
        toneMapped={false}
        blending={THREE.AdditiveBlending}
      />
    </instancedMesh>
  );
}