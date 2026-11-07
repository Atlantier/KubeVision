'use client';

/**
 * KubeVision AI — 地面拓扑星环（ClusterTopologyFloor3D）
 *
 * 【解决什么问题】三个 Worker 机架 + Master 若只悬浮在无限网格上、彼此仅靠
 * 顶部拱形光缆相连，地面就是空的——四个实体读起来像「各自漂浮的孤岛」。
 * 参考图那种「机架站在精密数码阵法上」的构图，才是把散点聚成系统的关键。
 *
 * 【本轮升级：从"两圈环 + 三根直线"到"多层动态数码阵法"】
 * 旧实现是静态的双圈 + 单根平面条，远看是几条线，缺少"仪器在运转"的层次。
 * 现结构：
 * 1. **四重主轨道**（RACK_RADIUS 处）：主发光轨 + 外侧 64 段虚线刻度环 +
 *    内侧双细导轨 + 沿轨道游走的脉冲流光弧（useFrame 缓慢旋转）；
 * 2. **控制平面内环**：Master 周围的双环，呼应其底座刻度环；
 * 3. **三线并行径向总线**（每机架一道）：1 根主干道 + 2 根细护线，
 *    沿线有向机架输送的地面光脉冲（useFrame 推进）；
 * 4. **每机架四层复合数码基座**：
 *    · 半径 2.45：8 段断开的战术锁定括弧环；
 *    · 半径 2.18：高亮主环 + 36 枚径向刻度齿（反向自转）；
 *    · 半径 1.82：三层衰减能量底盘（模拟径向渐变柔光）；
 *    · 前方两侧对称的精密导流短轨。
 *
 * 【为什么统一用 AdditiveBlending】
 * 这些都是「光」而非「面」。加色混合下环与环、环与机架的重叠处自然增亮，
 * 且不会出现不透明混合特有的「灰蒙蒙压暗」——主轨道会从机架底座下方穿过，
 * 若用普通混合会把机架底部压暗一块。
 *
 * 【性能契约】
 * - 所有位置/弧段/齿位**在模块加载期一次求值**，渲染期只查表；
 * - useFrame 内只做标量赋值与 rotation 写入，**零 new、零数组分配**；
 * - 不使用 useState，不订阅高频遥测（仅节点/Pod 状态位变化时重渲染）。
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { useClusterStore } from '@/store/useClusterStore';
import { RACK_RADIUS, getRackTransform } from '@/utils/spatialLayout';
import type { PodEntity, WorkerNodeEntity } from '@/types/cluster';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 主轨道环的环宽（世界单位） */
const ORBIT_THICKNESS = 0.055;

/** 主轨道外侧虚线刻度环的半径与段数 */
const ORBIT_TICK_RADIUS = RACK_RADIUS + 0.30;
const ORBIT_TICK_COUNT = 64;
const ORBIT_TICK_THICKNESS = 0.16;
/** 每段刻度占该扇区的比例（0.55 → 段与段之间留空，形成"虚线"） */
const ORBIT_TICK_DUTY = 0.55;

/** 主轨道内侧双细导轨的半径（两道，制造扫描轨道层次） */
const ORBIT_RAIL_INNER = RACK_RADIUS - 0.30;
const ORBIT_RAIL_OUTER = RACK_RADIUS - 0.26;

/** 沿轨道游走的脉冲流光弧：张角与环宽 */
const ORBIT_PULSE_ARC = Math.PI / 7;
const ORBIT_PULSE_THICKNESS = 0.14;

/** 控制平面内环半径 */
const INNER_RING_RADIUS = 3.1;

/** 内环环宽 */
const INNER_THICKNESS = 0.035;

/** 径向总线的宽度与长度 */
const RADIAL_WIDTH = 0.075;
/** 主干道两侧细护线的宽度与横向偏移 */
const RADIAL_GUARD_WIDTH = 0.022;
const RADIAL_GUARD_OFFSET = 0.105;
const RADIAL_LENGTH = RACK_RADIUS - INNER_RING_RADIUS;

/** 地面光脉冲的尺寸与推进速度（周期/秒） */
const LANE_PULSE_LENGTH = 0.85;
const LANE_PULSE_WIDTH = 0.10;
const LANE_PULSE_SPEED = 0.22;

/* ---- 机架基座复合数码阵（四层）---- */

/** 最外层：8 段断开的战术锁定括弧环 */
const PEDESTAL_BRACKET_RADIUS = 2.45;
const PEDESTAL_BRACKET_THICKNESS = 0.06;
const PEDESTAL_BRACKET_COUNT = 8;
const PEDESTAL_BRACKET_DUTY = 0.62;

/** 第二层：高亮主发光环 */
const PEDESTAL_MAIN_RADIUS = 2.18;
const PEDESTAL_MAIN_THICKNESS = 0.07;

/** 第二层的 36 枚径向刻度齿 */
const PEDESTAL_TEETH_COUNT = 36;
const PEDESTAL_TEETH_RADIUS = 2.30;
const PEDESTAL_TEETH_WIDTH = 0.05;
const PEDESTAL_TEETH_LENGTH = 0.20;

/** 第三层：能量底盘的三个递减环（用三层模拟径向渐变） */
const PEDESTAL_DISK_RADII: readonly number[] = [1.82, 1.46, 1.10];
const PEDESTAL_DISK_OPACITIES: readonly number[] = [0.15, 0.11, 0.08];

/** 第四层：前方两侧导流短轨 */
const GUIDE_RAIL_WIDTH = 0.06;
const GUIDE_RAIL_LENGTH = 0.62;
const GUIDE_RAIL_OFFSET_X = 0.92;
const GUIDE_RAIL_OFFSET_Z = 2.05;

/** 环的线段数：96 段足以在近距离观察下看不出多边形棱角 */
const RING_SEGMENTS = 96;

/** 主色：轨道常态（低饱和青，作为背景结构不抢主体） */
const COLOR_ORBIT = '#1e4d5c';

/** 主色：内环 / 径向电路 / 刻度（略亮，呼应控制平面） */
const COLOR_INNER = '#22d3ee';

/** 高危色：故障链路 */
const COLOR_FAULT = '#f43f5e';

/** 正常色：机架基座环（青绿，与 Pod Running 语义同源） */
const COLOR_BASE_HEALTHY = '#10b981';

/** 机架基座环透明度：正常态克制、故障态醒目 */
const OPACITY_BASE_HEALTHY = 0.42;
const OPACITY_BASE_FAULT = 0.85;

/** 贴地高度：略高于 Grid 与反射地面，避免 z-fighting */
const FLOOR_Y = 0.014;

/** 各动画角速度 / 推进速度（rad/s 与 周期/s） */
const ORBIT_PULSE_SPIN_RATE = 0.28;
const PEDESTAL_TEETH_SPIN_RATE = -0.20;

/* ========================================================================== */
/* 预计算表（模块加载期一次求值）                                                */
/* ========================================================================== */

/** 弧段参数：thetaStart / thetaLength */
interface ArcSpec {
  readonly thetaStart: number;
  readonly thetaLength: number;
}

/**
 * 生成均分的断弧表（用于虚线刻度、括弧环）。
 *
 * 【为何预计算】这些弧段的 thetaStart 只依赖常量与序号，可在模块加载期
 * 一次算好；若写在 JSX 里逐帧求值会产生大量临时对象，且每帧结果相同。
 *
 * @param count 段数
 * @param duty  每段占扇区比例（<1 则形成间隙）
 */
function buildArcs(count: number, duty: number): readonly ArcSpec[] {
  const sector = (Math.PI * 2) / count;
  const arcs: ArcSpec[] = [];
  for (let i = 0; i < count; i++) {
    arcs.push({ thetaStart: i * sector, thetaLength: sector * duty });
  }
  return arcs;
}

/** 主轨道外侧 64 段虚线刻度 */
const ORBIT_TICKS: readonly ArcSpec[] = buildArcs(ORBIT_TICK_COUNT, ORBIT_TICK_DUTY);

/** 基座最外圈 8 段锁定括弧 */
const PEDESTAL_BRACKETS: readonly ArcSpec[] = buildArcs(
  PEDESTAL_BRACKET_COUNT,
  PEDESTAL_BRACKET_DUTY,
);

/**
 * 基座 36 枚径向刻度齿的位置与朝向。
 *
 * 【几何】齿为长轴沿 Z 的小方块，位置 (R·sinθ, 0, R·cosθ)，
 * 绕 Y 旋转 θ 后长轴指向圆心——与主轨道刻度同一构造语言。
 */
const PEDESTAL_TEETH: ReadonlyArray<{
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
}> = (() => {
  const teeth: Array<{ position: readonly [number, number, number]; rotationY: number }> = [];
  for (let i = 0; i < PEDESTAL_TEETH_COUNT; i++) {
    const theta = (Math.PI * 2 * i) / PEDESTAL_TEETH_COUNT;
    teeth.push({
      position: [
        PEDESTAL_TEETH_RADIUS * Math.sin(theta),
        0,
        PEDESTAL_TEETH_RADIUS * Math.cos(theta),
      ],
      rotationY: theta,
    });
  }
  return teeth;
})();

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
 * 机架真实位置由 spatialLayout 的 getRackTransform(rackIndex) 唯一决定。
 * 若这里用数组下标推导，一旦节点顺序与 rackIndex 不一致，基座环与径向总线
 * 就会偏到别的机架上。直接读 node.rackIndex 并调用同一函数，
 * 保证与 WorkerRack3D / PodInstancedMesh 共用单一事实源。
 */
interface RackFooting {
  /** React key（节点 id） */
  readonly key: string;
  /** 世界 XZ 平面坐标（Y 恒为 0，统一由父 group 抬到 FLOOR_Y） */
  readonly x: number;
  readonly z: number;
  /** 该机架的极角（用于把径向总线旋转到正确朝向） */
  readonly angle: number;
  /** 是否处于故障态（决定基座与总线的颜色/透明度） */
  readonly faulted: boolean;
}

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * ClusterTopologyFloor3D —— 多层动态数码光圈 + 刻度扫描环 + 脉冲流动电路。
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
   * 仅在节点或 Pod 状态位变化时重算（低频），不在 useFrame 热路径上。
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

  /* ---- 动画通道 ref（useFrame 内原地写入，零分配） ---- */
  const orbitPulseRef = useRef<THREE.Group>(null);
  /** 每机架的刻度齿实例网格（反向自转：整体旋转该 mesh 即可） */
  const teethRefs = useRef<Array<THREE.InstancedMesh | null>>([]);
  /** 每机架径向总线上的流动光脉冲 */
  const lanePulseRefs = useRef<Array<THREE.Mesh | null>>([]);
  /** 主轨道 64 段虚线刻度的单实例网格（1 次 Draw Call） */
  const orbitTicksRef = useRef<THREE.InstancedMesh>(null);

  teethRefs.current.length = racks.length;
  lanePulseRefs.current.length = racks.length;

  /**
   * 刻度齿实例矩阵（每机架 36 枚）与轨道刻度实例矩阵（64 段）。
   *
   * 【为何必须实例化】本文件最初把刻度齿写成 36 个独立 boxGeometry mesh、
   * 轨道刻度写成 64 个独立 ringGeometry mesh：单帧新增 ~172 次 Draw Call，
   * 再叠加 MeshReflectorMaterial 的二次场景渲染（×2），
   * 直接把软件光栅化与低端 GPU 打到**整屏黑**（不报错，只是画不出来）。
   * 改为 InstancedMesh 后这两类降为 2 次 Draw Call。
   */
  const toothMatrices = useMemo((): ReadonlyArray<THREE.Matrix4> => {
    const list: THREE.Matrix4[] = [];
    const object = new THREE.Object3D();
    for (const tooth of PEDESTAL_TEETH) {
      object.position.set(tooth.position[0], tooth.position[1], tooth.position[2]);
      object.rotation.set(0, tooth.rotationY, 0);
      object.updateMatrix();
      list.push(object.matrix.clone());
    }
    return list;
  }, []);

  const orbitTickMatrices = useMemo((): ReadonlyArray<THREE.Matrix4> => {
    const list: THREE.Matrix4[] = [];
    const object = new THREE.Object3D();
    for (const arc of ORBIT_TICKS) {
      /* 平面几何用本地 Z 旋转：mesh 已绕 X 转了 −90°，本地 Z 即世界 Y */
      object.position.set(0, 0, 0);
      object.rotation.set(0, 0, arc.thetaStart);
      object.updateMatrix();
      list.push(object.matrix.clone());
    }
    return list;
  }, []);

  /** 写入轨道刻度实例矩阵（挂载一次；StrictMode 双挂载安全） */
  useEffect((): void => {
    const mesh = orbitTicksRef.current;
    if (mesh === null) return;
    for (let i = 0; i < orbitTickMatrices.length; i++) {
      mesh.setMatrixAt(i, orbitTickMatrices[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [orbitTickMatrices]);

  /** 写入各机架刻度齿实例矩阵（挂载一次；随机架数组长度变化重建） */
  useEffect((): void => {
    for (let i = 0; i < teethRefs.current.length; i++) {
      const mesh = teethRefs.current[i];
      if (mesh === null || mesh === undefined) continue;
      for (let k = 0; k < toothMatrices.length; k++) {
        mesh.setMatrixAt(k, toothMatrices[k]);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }, [toothMatrices, racks.length]);

  /**
   * useFrame —— 三类低频动画。
   *
   * 【零分配】只写 rotation.y / position.z 两个标量通道，
   * 不 new 任何 Object3D / Vector3 / Color；颜色与透明度全部来自低频渲染期。
   *
   * 【为何脉冲用 fract 而不是 sin】sin 会在两端折返（看起来像来回滑动），
   * fract 让脉冲沿总线**单向循环**输送，语义正确且无回程。
   */
  useFrame((state): void => {
    const t = state.clock.getElapsedTime();

    /* 1) 主轨道脉冲流光弧：缓慢绕环扫过 */
    if (orbitPulseRef.current !== null) {
      orbitPulseRef.current.rotation.z = t * ORBIT_PULSE_SPIN_RATE;
    }

    /* 2) 每机架刻度齿：反向自转（与主轨道互为反向 → 视差感） */
    const teeth = teethRefs.current;
    for (let i = 0; i < teeth.length; i++) {
      const group = teeth[i];
      if (group !== null && group !== undefined) {
        group.rotation.y = t * PEDESTAL_TEETH_SPIN_RATE;
      }
    }

    /* 3) 每机架径向总线上的地面流动光脉冲 */
    const pulses = lanePulseRefs.current;
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      if (pulse !== null && pulse !== undefined) {
        /* 相位错开：三个机架的脉冲不同步，避免整体齐步像机械 */
        const cycle = (t * LANE_PULSE_SPEED + i * 0.33) % 1;
        pulse.position.z = INNER_RING_RADIUS + cycle * RADIAL_LENGTH;
        /* 两端淡入淡出：靠近控制平面与到达机架时不硬切 */
        const fade = Math.sin(cycle * Math.PI);
        const material = pulse.material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.opacity = 0.25 + 0.65 * fade;
        }
      }
    }
  });

  return (
    <group position={[0, FLOOR_Y, 0]}>
      {/*
       * ═══ 第一重：主发光轨（机架站立的闭合圆环）═══
       * ringGeometry 默认在 XY 平面，绕 X 轴 −90° 后平铺于世界 XZ 平面。
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

      {/*
       * ═══ 第二重：外侧 64 段虚线刻度环 ═══
       * 每段是一次独立 ringGeometry（thetaStart / thetaLength），
       * 64 段 × 3 机架共享同一批几何参数，用 map 展开即可。
       * 视觉上形成"精密仪器刻度盘"的断续节奏，与连续主轨形成对比。
       */}
      {/*
       * ═══ 第二重：外侧 64 段虚线刻度环（单实例网格，1 次 Draw Call）═══
       *
       * 【为何实例化】64 段独立 mesh × 每帧被反射地面二次渲染 = 128 次
       * Draw Call，仅这一组就能把低端 GPU 打垮。实例化后降为 1 次。
       * 几何只建"一段弧"（thetaStart=0），各实例靠本地 Z 旋转摆到扇区位置。
       */}
      <instancedMesh
        ref={orbitTicksRef}
        args={[undefined, undefined, ORBIT_TICK_COUNT]}
        rotation={[-Math.PI / 2, 0, 0]}
        frustumCulled={false}
        raycast={(): void => undefined}
      >
        <ringGeometry
          args={[
            ORBIT_TICK_RADIUS,
            ORBIT_TICK_RADIUS + ORBIT_TICK_THICKNESS,
            RING_SEGMENTS,
            1,
            0,
            ((Math.PI * 2) / ORBIT_TICK_COUNT) * ORBIT_TICK_DUTY,
          ]}
        />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.34}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </instancedMesh>

      {/* ═══ 第三重：内侧双细导轨 ═══ */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[ORBIT_RAIL_INNER, ORBIT_RAIL_INNER + 0.015, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.30}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[ORBIT_RAIL_OUTER, ORBIT_RAIL_OUTER + 0.015, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.22}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/*
       * ═══ 第四重：沿轨道游走的脉冲流光弧 ═══
       * 一段较宽的短弧，由 useFrame 绕环缓慢旋转 → "扫描线在巡检"的隐喻。
       * 单独一个 group 承载旋转，便于只写一个 rotation.z。
       */}
      <group ref={orbitPulseRef} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh raycast={(): void => undefined}>
          <ringGeometry
            args={[
              RACK_RADIUS - ORBIT_PULSE_THICKNESS,
              RACK_RADIUS + ORBIT_PULSE_THICKNESS,
              RING_SEGMENTS,
              1,
              0,
              ORBIT_PULSE_ARC,
            ]}
          />
          <meshBasicMaterial
            color="#a5f3fc"
            transparent
            opacity={0.55}
            side={THREE.DoubleSide}
            toneMapped={false}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>

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
          opacity={0.30}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/*
       * ═══ 三线并行径向总线（每机架一道）═══
       *
       * 【几何构造】用 planeGeometry 画细长矩形，中心置于两环之间中点
       * （沿 +Z 平移 (起点+终点)/2），再用 group 绕 Y 旋转该机架极角，
       * 即可让总线精确指向机架。
       *
       * 【三线】主干道宽 0.075 + 两侧护线各 0.022（横向偏移 ±0.105），
       * 从"一根杆子"升级为有保护线束的总线结构。
       *
       * 【流动光脉冲】一条细长发光片，由 useFrame 沿 z 单向循环推进
       * （fract 而非 sin，避免来回折返），并在两端淡入淡出。
       */}
      {racks.map((rack, index): React.ReactElement => {
        const midOffset = (INNER_RING_RADIUS + RACK_RADIUS) / 2;
        const laneColor = rack.faulted ? COLOR_FAULT : COLOR_INNER;
        return (
          <group key={`radial-${rack.key}`} rotation={[0, rack.angle, 0]}>
            {/* 主干道 */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, midOffset]} raycast={(): void => undefined}>
              <planeGeometry args={[RADIAL_WIDTH, RADIAL_LENGTH]} />
              <meshBasicMaterial
                color={laneColor}
                transparent
                opacity={rack.faulted ? 0.75 : 0.32}
                side={THREE.DoubleSide}
                toneMapped={false}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>

            {/* 两侧细护线 */}
            {[-RADIAL_GUARD_OFFSET, RADIAL_GUARD_OFFSET].map((offsetX): React.ReactElement => (
              <mesh
                key={`guard-${offsetX > 0 ? 'right' : 'left'}`}
                rotation={[-Math.PI / 2, 0, 0]}
                position={[offsetX, 0, midOffset]}
                raycast={(): void => undefined}
              >
                <planeGeometry args={[RADIAL_GUARD_WIDTH, RADIAL_LENGTH]} />
                <meshBasicMaterial
                  color={laneColor}
                  transparent
                  opacity={rack.faulted ? 0.55 : 0.18}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            ))}

            {/* 沿总线输送的地面光脉冲（useFrame 推进 position.z） */}
            <mesh
              ref={(node): void => {
                lanePulseRefs.current[index] = node;
              }}
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, 0.002, midOffset]}
              raycast={(): void => undefined}
            >
              <planeGeometry args={[LANE_PULSE_WIDTH, LANE_PULSE_LENGTH]} />
              <meshBasicMaterial
                color={rack.faulted ? '#fda4af' : '#a5f3fc'}
                transparent
                opacity={0.6}
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
       * ═══ 每机架四层复合数码基座 ═══
       *
       * 图五里最抓眼的细节之一：机架脚下不是一个圆圈，而是多圈层叠的
       * 精密数码阵——断弧括弧、刻度齿、能量底盘、导流短轨各司其职。
       * 下面按"由外向内"四层展开，故障机架整体切换绯红。
       */}
      {racks.map((rack, index): React.ReactElement => {
        const ringColor = rack.faulted ? COLOR_FAULT : COLOR_BASE_HEALTHY;
        const ringOpacity = rack.faulted ? OPACITY_BASE_FAULT : OPACITY_BASE_HEALTHY;
        return (
          <group key={`base-${rack.key}`} position={[rack.x, 0, rack.z]}>
            {/* ── 第 1 层：8 段断开的战术锁定括弧环（半径 2.45）── */}
            {PEDESTAL_BRACKETS.map((arc, arcIndex): React.ReactElement => (
              <mesh
                key={`bracket-${arcIndex}`}
                rotation={[-Math.PI / 2, 0, 0]}
                raycast={(): void => undefined}
              >
                <ringGeometry
                  args={[
                    PEDESTAL_BRACKET_RADIUS - PEDESTAL_BRACKET_THICKNESS,
                    PEDESTAL_BRACKET_RADIUS,
                    RING_SEGMENTS,
                    1,
                    arc.thetaStart,
                    arc.thetaLength,
                  ]}
                />
                <meshBasicMaterial
                  color={ringColor}
                  transparent
                  opacity={ringOpacity * 0.75}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            ))}

            {/* ── 第 2 层：高亮主发光环（半径 2.18）── */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
              <ringGeometry
                args={[
                  PEDESTAL_MAIN_RADIUS - PEDESTAL_MAIN_THICKNESS,
                  PEDESTAL_MAIN_RADIUS,
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

            {/* ── 第 2b 层：36 枚径向刻度齿（单实例网格，反向自转）──
                 *
                 * 【实例化理由】36 齿 × 3 机架 = 108 个独立 mesh，
                 * 再被反射地面二次渲染 = 216 次 Draw Call。
                 * 改为每机架 1 个 InstancedMesh（36 实例）后降为 3 次；
                 * 反向自转直接旋转该 mesh 对象，实例矩阵无需每帧重写。
                 */}
            <instancedMesh
              ref={(node): void => {
                teethRefs.current[index] = node;
              }}
              args={[undefined, undefined, PEDESTAL_TEETH_COUNT]}
              frustumCulled={false}
              raycast={(): void => undefined}
            >
              <boxGeometry args={[PEDESTAL_TEETH_WIDTH, 0.004, PEDESTAL_TEETH_LENGTH]} />
              <meshBasicMaterial
                color={ringColor}
                transparent
                opacity={ringOpacity * 0.55}
                toneMapped={false}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </instancedMesh>

            {/* ── 第 3 层：三层递减能量底盘（模拟径向渐变柔光）── */}
            {PEDESTAL_DISK_RADII.map((radius, diskIndex): React.ReactElement => (
              <mesh
                key={`disk-${diskIndex}`}
                rotation={[-Math.PI / 2, 0, 0]}
                raycast={(): void => undefined}
              >
                <circleGeometry args={[radius, RING_SEGMENTS]} />
                <meshBasicMaterial
                  color={ringColor}
                  transparent
                  opacity={PEDESTAL_DISK_OPACITIES[diskIndex]}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            ))}

            {/* ── 第 4 层：机架前方两侧对称伸出的精密导流短轨 ── */}
            {[-1, 1].map((sideSign): React.ReactElement => (
              <mesh
                key={`guide-rail-${sideSign > 0 ? 'right' : 'left'}`}
                rotation={[-Math.PI / 2, 0, 0]}
                position={[sideSign * GUIDE_RAIL_OFFSET_X, 0, GUIDE_RAIL_OFFSET_Z]}
                raycast={(): void => undefined}
              >
                <planeGeometry args={[GUIDE_RAIL_LENGTH, GUIDE_RAIL_WIDTH]} />
                <meshBasicMaterial
                  color={ringColor}
                  transparent
                  opacity={ringOpacity * 0.6}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            ))}

            {/*
             * ── 故障态第三环 + 外扩辉光环（三环绯红能量波纹）──
             * 仅故障机架挂载：正常态下这两个 mesh 不存在，零 draw call。
             */}
            {rack.faulted ? (
              <group position={[0, 0.002, 0]}>
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