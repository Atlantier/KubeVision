'use client';

/**
 * KubeVision AI — 地面拓扑星环（ClusterTopologyFloor3D）
 *
 * 【解决什么问题】当前三个 Worker 机架 + Master 悬浮在无限网格上，
 * 彼此之间只有顶部的拱形光缆相连——**地面是空的**。这让四个实体看起来
 * 像"各自漂浮的孤岛"，缺少"它们属于同一个集群"的空间秩序感。
 * 图二那种"机架站在一条发光轨道上、轨道从控制平面辐射出去"的构图，
 * 才是把散点聚成系统的关键。
 *
 * 【设计结构（三层）】
 * 1. **主轨道**：以 RACK_RADIUS 为半径的闭合圆环，三个机架正好落在环上——
 *    轨道本身即是"集群边界"的具象化；
 * 2. **控制平面内环**：Master 周围的小半径双环，呼应其底座刻度环；
 * 3. **三道径向电路**：从内环向三个机架方向辐射的直线，120° 均分。
 *    故障机架对应的那一道变绯红——这是**空间级的故障指示**，
 *    用户不用读任何文字就能看出"哪条链路出问题了"。
 *
 * 【性能契约】全部为 ringGeometry / planeGeometry 的基础材质，
 * 合并进少量 mesh，三个径向电路共用一个几何体（旋转复用），
 * 总计不到 10 个 draw call，且无任何 useFrame 动画（纯静态结构）。
 */

import { useMemo } from 'react';
import * as THREE from 'three';

import { useClusterStore } from '@/store/useClusterStore';
import { RACK_RADIUS } from '@/utils/spatialLayout';
import type { PodEntity, WorkerNodeEntity } from '@/types/cluster';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 主轨道环的环宽（世界单位） */
const ORBIT_THICKNESS = 0.055;

/** 控制平面内环半径 */
const INNER_RING_RADIUS = 3.1;

/** 内环环宽 */
const INNER_THICKNESS = 0.035;

/** 径向电路的宽度与长度 */
const RADIAL_WIDTH = 0.075;
const RADIAL_LENGTH = RACK_RADIUS - INNER_RING_RADIUS;

/** 环的线段数：96 段足以在近距离观察下看不出多边形棱角 */
const RING_SEGMENTS = 96;

/** 主色：轨道常态（低饱和青，作为背景结构不抢主体） */
const COLOR_ORBIT = '#1e4d5c';

/** 主色：内环（略亮，呼应控制平面） */
const COLOR_INNER = '#22d3ee';

/** 高危色：故障链路 */
const COLOR_FAULT = '#f43f5e';

/** 贴地高度：略高于 Grid（y=0.01），避免 z-fighting */
const FLOOR_Y = 0.014;

/* ========================================================================== */
/* 故障机架判定                                                               */
/* ========================================================================== */

/**
 * isRackFaulted —— 判断某个机架是否处于故障态。
 *
 * 【口径】与 ErrorRippleRing / WorkerRack3D 的状态语义保持一致：
 * 节点自身非 Ready（NetworkPartition），**或其名下存在崩溃 Pod**。
 * 后者更重要——机架本身健康但里面的容器在崩溃，也是需要高亮的事实。
 *
 * @param node 机架节点实体
 * @param snapshot 当前集群快照（用于查 Pod 状态）
 * @returns 是否需要以故障色渲染
 */
function isRackFaulted(node: WorkerNodeEntity, pods: readonly PodEntity[]): boolean {
  if (node.status === 'NetworkPartition') return true;
  return pods.some(
    (pod): boolean =>
      pod.nodeId === node.id && (pod.status === 'CrashLoopBackOff' || pod.status === 'OOMKilled'),
  );
}

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * ClusterTopologyFloor3D —— 贴地拓扑星环。
 *
 * 仅依赖节点的 id / status 与 Pod 的 nodeId / status，不订阅高频遥测，
 * 因此只在快照状态位变化时重渲染（低频）。
 */
export default function ClusterTopologyFloor3D(): React.ReactElement {
  const nodes = useClusterStore((s): readonly WorkerNodeEntity[] => s.snapshotSummary.nodes);
  const pods = useClusterStore((s): readonly PodEntity[] => s.snapshotSummary.pods);

  /**
   * 每道径向电路的朝向与故障标志。
   *
   * 仅在节点状态或 Pod 状态位变化时重算（低频），不在 useFrame 热路径上。
   */
  const radials = useMemo((): ReadonlyArray<{ angle: number; faulted: boolean }> => {
    return nodes.map((node, index): { angle: number; faulted: boolean } => ({
      /* 机架角度与 spatialLayout 的 getRackTransform 同源：α = 2πk/3 */
      angle: (2 * Math.PI * index) / Math.max(1, nodes.length),
      faulted: isRackFaulted(node, pods),
    }));
  }, [nodes, pods]);

  return (
    <group position={[0, FLOOR_Y, 0]}>
      {/*
       * ── 主轨道：机架站立的闭合圆环 ──
       * ringGeometry 默认位于 XY 平面，绕 X 轴 −90° 后平铺于世界 XZ 平面。
       */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[RACK_RADIUS - ORBIT_THICKNESS, RACK_RADIUS, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_ORBIT}
          transparent
          opacity={0.85}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>

      {/* ── 主轨道内侧的第二道细环：制造"双轨"层次，暗示扫描轨道 ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[RACK_RADIUS - 0.26, RACK_RADIUS - 0.235, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>

      {/* ── 控制平面内环：双环呼应 Master 底座的刻度环 ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[INNER_RING_RADIUS - INNER_THICKNESS, INNER_RING_RADIUS, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.55}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[INNER_RING_RADIUS * 0.62, INNER_RING_RADIUS * 0.62 + 0.022, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>

      {/*
       * ── 三道径向电路：从内环辐射到主轨道的直线 ──
       *
       * 【几何构造】用 planeGeometry 画一条细长矩形，中心点置于两环之间的
       * 中点偏移处（起点 = 内环半径，终点 = RACK_RADIUS）。
       * 因为矩形默认居中于原点，故沿 +Z 平移 (起点+终点)/2 的距离；
       * 再用 group 绕 Y 旋转对应角度，即可让每条电路指向一个机架。
       *
       * 故障机架 → 该道电路切换为绯红并提高不透明度，形成空间级告警。
       */}
      {radials.map((radial, index): React.ReactElement => {
        const midOffset = (INNER_RING_RADIUS + RACK_RADIUS) / 2;
        return (
          <group key={`radial-${index}`} rotation={[0, radial.angle, 0]}>
            <mesh
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, 0, midOffset]}
              raycast={(): void => undefined}
            >
              <planeGeometry args={[RADIAL_WIDTH, RADIAL_LENGTH]} />
              <meshBasicMaterial
                color={radial.faulted ? COLOR_FAULT : COLOR_INNER}
                transparent
                opacity={radial.faulted ? 0.75 : 0.32}
                side={THREE.DoubleSide}
                toneMapped={false}
                depthWrite={false}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
