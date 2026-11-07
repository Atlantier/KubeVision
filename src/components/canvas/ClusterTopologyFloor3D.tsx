'use client';

/**
 * KubeVision AI — 地面拓扑星环（ClusterTopologyFloor3D）
 *
 * 【解决什么问题】三个 Worker 机架 + Master 若只悬浮在无限网格上、彼此仅靠
 * 顶部拱形光缆相连，地面就是空的——四个实体读起来像「各自漂浮的孤岛」，
 * 缺少「它们属于同一个集群」的空间秩序感。图二那种「机架站在发光轨道上、
 * 轨道从控制平面辐射出去」的构图，才是把散点聚成系统的关键。
 *
 * 【设计结构（四层）】
 * 1. **主轨道环**：以 RACK_RADIUS 为半径的闭合圆环，三个机架正好落在环上——
 *    轨道本身即是「集群边界」的具象化；
 * 2. **控制平面内环**：Master 周围的小半径双环，呼应其底座刻度环；
 * 3. **三道径向电路**：从内环向三个机架方向辐射的直线，120° 均分。
 *    故障机架对应的那一道变绯红——**空间级的故障指示**，
 *    用户不用读任何文字就能看出「哪条链路出问题了」；
 * 4. **机架基座双圈环**：每个机架落脚点铺设半径 2.2 的贴地双圈全息基座，
 *    让机架「稳坐」在发光基座之中而非浮在网格线上。常亮不呼吸，
 *    正常态青绿、故障态绯红——同时承担「该机架是否健康」的空间提示。
 *
 * 【为什么统一用 AdditiveBlending】
 * 这些都是「光」而非「面」。加色混合下，环与环、环与机架的重叠处自然增亮，
 * 且在深色地面上不会出现不透明混合特有的「灰蒙蒙压暗」——
 * 尤其主轨道会从机架底座下方穿过，若用普通混合会把机架底部压暗一块。
 *
 * 【性能契约】全部为 ringGeometry / planeGeometry 的基础材质，
 * 无任何 useFrame 动画（纯静态结构）；仅在节点状态位或 Pod 状态位变化时
 * 重新求值色与透明度（低频），不订阅高频遥测。
 */

import { useMemo } from 'react';
import * as THREE from 'three';

import { useClusterStore } from '@/store/useClusterStore';
import { RACK_RADIUS, getRackTransform } from '@/utils/spatialLayout';
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

/**
 * 机架基座双圈环参数。
 *
 * 【半径 2.2 的取值依据】机架底座 RACK_BODY_SIZE = [2.6, 4.4, 1.8]，
 * 其足迹半对角线 = √(1.3² + 0.9²) ≈ 1.58。取 2.2 使基座环在机架四周
 * 留出约 0.6 的环形余量——既有「坐落其中」的包裹感，又不会与相邻机架
 * 的基座环相交（相邻机架间距 = 2·RACK_RADIUS·sin60° ≈ 16.45，
 * 远大于两倍基座直径 8.8）。
 */
const BASE_RING_OUTER_RADIUS = 2.2;
const BASE_RING_OUTER_THICKNESS = 0.07;
const BASE_RING_INNER_RADIUS = 1.78;
const BASE_RING_INNER_THICKNESS = 0.045;

/** 环的线段数：96 段足以在近距离观察下看不出多边形棱角 */
const RING_SEGMENTS = 96;

/** 主色：轨道常态（低饱和青，作为背景结构不抢主体） */
const COLOR_ORBIT = '#1e4d5c';

/** 主色：内环 / 径向电路（略亮，呼应控制平面） */
const COLOR_INNER = '#22d3ee';

/** 高危色：故障链路 */
const COLOR_FAULT = '#f43f5e';

/** 正常色：机架基座环（青绿，与 Pod Running 语义同源） */
const COLOR_BASE_HEALTHY = '#10b981';

/** 机架基座环透明度：正常态克制、故障态醒目 */
const OPACITY_BASE_HEALTHY = 0.42;
const OPACITY_BASE_FAULT = 0.85;

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
 * @param pods 当前集群快照的 Pod 列表（用于查状态）
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
/* 机架落脚点数据契约                                                            */
/* ========================================================================== */

/**
 * 单个机架的落脚点渲染数据。
 *
 * 【为何从 getRackTransform 取坐标而非按数组下标算角度】
 * 机架的真实位置由 spatialLayout 的 getRackTransform(rackIndex) 唯一决定
 * （α_k = 2πk/3，位置 = (R·sinα, 0, R·cosα)）。若这里改用「数组下标」推导，
 * 一旦节点数组顺序与 rackIndex 不一致，基座环与径向电路就会偏到别的机架上。
 * 直接读 node.rackIndex 并调用同一函数，保证与 WorkerRack3D / PodInstancedMesh
 * 共用单一事实源，任何排序变化都不会错位。
 */
interface RackFooting {
  /** React key（节点 id） */
  readonly key: string;
  /** 世界 XZ 平面坐标（Y 恒为 0，统一由父 group 抬到 FLOOR_Y） */
  readonly x: number;
  readonly z: number;
  /** 该机架的极角（用于把径向电路旋转到正确朝向） */
  readonly angle: number;
  /** 是否处于故障态（决定基座环与径向电路的颜色/透明度） */
  readonly faulted: boolean;
}

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * ClusterTopologyFloor3D —— 贴地拓扑星环 + 机架基座。
 *
 * 仅依赖节点的 id / status / rackIndex 与 Pod 的 nodeId / status，
 * 不订阅高频遥测，因此只在快照状态位变化时重渲染（低频）。
 */
export default function ClusterTopologyFloor3D(): React.ReactElement {
  const nodes = useClusterStore((s): readonly WorkerNodeEntity[] => s.snapshotSummary.nodes);
  const pods = useClusterStore((s): readonly PodEntity[] => s.snapshotSummary.pods);

  /**
   * 每个机架的落脚点（位置 / 朝向 / 故障态）。
   *
   * 仅在节点或 Pod 状态位变化时重算（低频），不在 useFrame 热路径上——
   * 本组件没有任何逐帧动画，这是刻意的：地面结构越稳定，上面的机架运动
   * 才越显眼，动态元素过多反而互相干扰。
   */
  const racks = useMemo((): readonly RackFooting[] => {
    return nodes.map((node): RackFooting => {
      const transform = getRackTransform(node.rackIndex);
      const x = transform.position[0];
      const z = transform.position[2];
      return {
        key: node.id,
        x,
        z,
        /* 极角：由实际坐标反解，天然与 getRackTransform 同源且符号安全 */
        angle: Math.atan2(x, z),
        faulted: isRackFaulted(node, pods),
      };
    });
  }, [nodes, pods]);

  return (
    <group position={[0, FLOOR_Y, 0]}>
      {/*
       * ── 主轨道：机架站立的闭合圆环 ──
       * ringGeometry 默认位于 XY 平面，绕 X 轴 −90° 后平铺于世界 XZ 平面。
       * 加色混合保证其穿过机架底座时只是「叠加亮度」，不压暗底座。
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
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* ── 主轨道内侧的第二道细环：制造「双轨」层次，暗示扫描轨道 ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[RACK_RADIUS - 0.26, RACK_RADIUS - 0.235, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
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
          blending={THREE.AdditiveBlending}
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
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/*
       * ── 三道径向电路：从内环辐射到主轨道的直线 ──
       *
       * 【几何构造】用 planeGeometry 画一条细长矩形，中心点置于两环之间的
       * 中点偏移处（起点 = 内环半径，终点 = RACK_RADIUS）。
       * 矩形默认居中于原点，故沿 +Z 平移 (起点+终点)/2；
       * 再用 group 绕 Y 旋转该机架的极角，即可让每条电路精确指向机架。
       *
       * 故障机架 → 该道电路切换为绯红并提高不透明度，形成空间级告警。
       */}
      {racks.map((rack): React.ReactElement => {
        const midOffset = (INNER_RING_RADIUS + RACK_RADIUS) / 2;
        return (
          <group key={`radial-${rack.key}`} rotation={[0, rack.angle, 0]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, midOffset]} raycast={(): void => undefined}>
              <planeGeometry args={[RADIAL_WIDTH, RADIAL_LENGTH]} />
              <meshBasicMaterial
                color={rack.faulted ? COLOR_FAULT : COLOR_INNER}
                transparent
                opacity={rack.faulted ? 0.75 : 0.32}
                side={THREE.DoubleSide}
                toneMapped={false}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
          </group>
        );
      })}

      {/*
       * ── 机架基座双圈全息环 ──
       *
       * 【设计意图】机架原本直接「站」在网格线上，缺少承接结构，读起来不踏实。
       * 在每座机架的落脚点铺一枚半径 2.2 的贴地双圈环，机架便有了明确的
       * 「停放位」，三座机架稳稳坐落在发光星环之中。
       *
       * 【状态语义】常亮不呼吸（与涟漪环的「告警扩散」区分开）：
       * - 正常态青绿 #10b981 / opacity 0.42 —— 与 Pod Running 语义同源；
       * - 故障态绯红 #f43f5e / opacity 0.85 —— 与径向电路、涟漪环同一套警示色。
       * 三处地面元素（轨道 / 径向电路 / 基座）因此共用一套色彩语言。
       *
       * 【几何】两枚同心环：外环稍粗（0.07）定边界，内环稍细（0.045）定重心，
       * 双圈比单圈更有「基座」的机械厚度感。
       */}
      {racks.map((rack): React.ReactElement => {
        const ringColor = rack.faulted ? COLOR_FAULT : COLOR_BASE_HEALTHY;
        const ringOpacity = rack.faulted ? OPACITY_BASE_FAULT : OPACITY_BASE_HEALTHY;
        return (
          <group key={`base-${rack.key}`} position={[rack.x, 0, rack.z]}>
            {/* 外圈：基座边界 */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
              <ringGeometry
                args={[
                  BASE_RING_OUTER_RADIUS - BASE_RING_OUTER_THICKNESS,
                  BASE_RING_OUTER_RADIUS,
                  RING_SEGMENTS,
                ]}
              />
              <meshBasicMaterial
                color={ringColor}
                transparent
                opacity={ringOpacity}
                side={THREE.DoubleSide}
                toneMapped={false}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
            {/* 内圈：重心参考线 */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
              <ringGeometry
                args={[
                  BASE_RING_INNER_RADIUS,
                  BASE_RING_INNER_RADIUS + BASE_RING_INNER_THICKNESS,
                  RING_SEGMENTS,
                ]}
              />
              <meshBasicMaterial
                color={ringColor}
                transparent
                opacity={ringOpacity}
                side={THREE.DoubleSide}
                toneMapped={false}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>

            {/*
             * ---- 故障态第三环 + 外扩辉光环（三环绯红能量波纹）----
             *
             * 【为什么必须加到三环】两环在正常态下是"基座边界"，语义是静态的；
             * 一旦机架出问题，地面必须**自己开口说话**。参考图右下角那种
             * 三环同心、由内向外逐层变淡的绯红能量场，是"这里出事了"最强、
             * 也最不依赖 UI 文字的地面信号。
             *
             * 【几何】中环（1.38~1.50）为能量场主体实环；外扩辉光环
             * （1.86~1.92）比基座外圈更大，视觉上溢出机架轮廓，
             * 形成"波纹正在向外扩散"的冲击感。
             *
             * 【零开销】仅故障机架挂载本组：正常态下这三个 mesh 根本不存在，
             * 不产生 draw call，也不参与任何每帧计算（本文件全程无 useFrame）。
             */}
            {rack.faulted ? (
              <group position={[0, FLOOR_Y + 0.002, 0]}>
                {/* 中环：能量场主体 */}
                <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
                  <ringGeometry args={[1.38, 1.5, RING_SEGMENTS]} />
                  <meshBasicMaterial
                    color={COLOR_FAULT}
                    transparent
                    opacity={0.72}
                    side={THREE.DoubleSide}
                    toneMapped={false}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                  />
                </mesh>
                {/* 外扩辉光环：溢出基座轮廓，制造波纹扩散感 */}
                <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
                  <ringGeometry args={[1.86, 1.92, RING_SEGMENTS]} />
                  <meshBasicMaterial
                    color={COLOR_FAULT}
                    transparent
                    opacity={0.34}
                    side={THREE.DoubleSide}
                    toneMapped={false}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                  />
                </mesh>
              </group>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}