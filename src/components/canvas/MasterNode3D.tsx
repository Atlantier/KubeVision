'use client';

/**
 * KubeVision AI — MASTER 控制平面程序化 3D 模型（MasterNode3D）
 *
 * 【设计意图】集群控制平面（API-SERVER / etcd / scheduler / controller-manager
 * 的抽象化身）的纯程序化建模：零 .glb 外部资产，全部由原生 Three.js 几何体
 * 与材质组合而成（AGENTS.md 交付契约），世界坐标锚定 MASTER_POSITION [0, 2.5, 0]
 * ——三机架环形布局的几何中心正上方，「中心指挥 + 外围阵地」构图的视觉焦点。
 *
 * 【几何构成】（由外及内，全部为全息半透明材质，无任何不透明实体）
 * 1. **外层水晶壳**：半透明正八面体（octahedronGeometry, OCTA_RADIUS）。
 *    材质 opacity 0.12 / 0.22 且使用 AdditiveBlending——纯加色、不写深度，
 *    多个晶面叠加时自然增亮，形成通透的「能量包络」而非实心塑料壳。
 *    棱线通过 drei <Edges> 单独描亮：**只画八面体真正的 12 条棱**。
 * 2. **内层反向晶核**：半径 1.05 的八面体，反向自转 + 余弦滚转。
 *    opacity 0.22 + AdditiveBlending，同样配 <Edges> 勾勒轮廓。
 * 3. **三维十字能量轴**：三根互相垂直、穿过中心的纤细发光柱，
 *    构成精密全息反应堆的骨架。
 * 4. **白炽内核**：呼吸缩放（1 ± 0.12·sin(2.2t)）的高亮小球，
 *    心跳隐喻——控制平面存活即集群存活。
 * 5. **地面投射光束**：从水晶底部顶点垂直向下接入地面刻度环，
 *    让悬浮水晶呈现「由地面全息基座投射而出」的因果感（详见 BEAM 常量注释）。
 * 6. **底部刻度全息圆环**：双环轮廓 + 24 根径向刻度齿，贴地投影
 *    （世界 y ≈ 0.08），缓慢自转。
 *
 * 【为何删除 wireframe 棱线网格】
 * 旧实现用 `<meshBasicMaterial wireframe />` 画八面体棱线，但 wireframe
 * 沿**三角形边**绘制——八面体每个面由 2 个三角形拼成，因此在每个面上都会
 * 多画出一条斜向的对角线，观感非常脏。改用 drei <Edges>（基于
 * EdgesGeometry，按二面角阈值 15° 提取真实棱边），只保留 12 条干净棱线。
 *
 * 【60FPS 红线合规】useFrame 单回调集中处理全部动画：旋转/呼吸均由
 * clock.elapsedTime 的确定性函数驱动（非增量累积，无浮点漂移），
 * 全部经 ref 原地突变（rotation/scale/material 属性写入），
 * 零 new、零 setState、零 React 重渲染（AGENTS.md 第 3 条）。
 *
 * 【交互契约】hover 高亮（棱线与晶面增亮 + 光标 pointer）；点击
 * e.stopPropagation() 后 selectEntity(MASTER_ENTITY_ID, 'master')——
 * CameraRig 对 master 类型执行「全景鸟瞰」飞行。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { Edges, Html } from '@react-three/drei';
import * as THREE from 'three';

import { useClusterStore } from '@/store/useClusterStore';
import { MASTER_ENTITY_ID } from '@/types/canvas';
import { MASTER_POSITION } from '@/utils/spatialLayout';
import GlowHalo3D from '@/components/canvas/GlowHalo3D';
import type { SelectedEntityType } from '@/types/store';

/* ========================================================================== */
/* 模型几何常量（模块级，集中定义防漂移）                                          */
/* ========================================================================== */

/** 外层八面体半径（调度扫描包络） */
const OCTA_RADIUS = 1.85;

/** 外层纵向拉伸比：水晶略瘦高，比正球体更具「晶体」而非「球」的轮廓 */
const OCTA_SCALE_Y = 1.22;

/** 内层反向晶核半径（与外层保持充足间隙，双层结构互不穿插） */
const CORE_CRYSTAL_RADIUS = 1.05;

/** 白炽内核球半径（呼吸峰值 1.12 倍仍远小于晶核，不会被吞没） */
const NUCLEUS_RADIUS = 0.36;

/**
 * 三轴陀螺仪全息轨道环的几何参数。
 *
 * 【为什么用它替代十字直棍】原来 3 根 boxGeometry 细长条穿过球心，
 * 近看就是"糖葫芦签子"——刚性直棍既不符合能量场的柔性，也让中心显得死板。
 * 改用 3 道倾角各异的细环后，中心变成一个**精密陀螺仪**：
 * 三轴互不共面、各自以不同角速度旋转，视觉上持续产生新的交点与扫掠面，
 * 这是"仪器在运转"而非"模型在翻滚"的关键。
 *
 * 【半径递进 1.15 → 1.32 → 1.48】刻意让三道环比内层晶核（1.05）大、
 * 又全部包在外层八面体棱线（OCTA_RADIUS ≈ 2.55）之内，
 * 因此它们既不与晶核穿插，也不越出水晶包络。
 */
const GYRO_RINGS: ReadonlyArray<{
  readonly key: string;
  readonly radius: number;
  /** 环的静态倾角（欧拉角），三轴各不相同 */
  readonly tilt: readonly [number, number, number];
  /** 各环绕自身法线的自转角速度（rad/s），互不相同形成陀螺仪视差 */
  readonly spin: number;
  readonly thickness: number;
}> = [
  { key: 'gyro-a', radius: 1.15, tilt: [Math.PI / 3, 0, 0], spin: 0.85, thickness: 0.012 },
  { key: 'gyro-b', radius: 1.32, tilt: [-Math.PI / 4, 0, Math.PI / 5], spin: -1.24, thickness: 0.010 },
  { key: 'gyro-c', radius: 1.48, tilt: [Math.PI / 2, Math.PI / 6, 0], spin: 0.62, thickness: 0.008 },
];

/** 环绕控制平面缓慢上升旋转的微光星火数量 */
const AMBIENT_SPARK_COUNT = 36;

/** 星火环绕半径（控制平面外围能量场） */
const AMBIENT_SPARK_RADIUS = 2.2;

/** 星火整体环绕角速度（rad/s，约 47 秒/圈，极缓慢以免抢注意力） */
const AMBIENT_SPARK_SPIN_RATE = 0.135;

/** 星火静态相位表（黄金角错相，确定性可复现） */
const AMBIENT_SPARK_PHASES: readonly number[] = Array.from(
  { length: AMBIENT_SPARK_COUNT },
  (_, i): number => (i * 2.399963229728653) % (Math.PI * 2),
);

/**
 * 等离子星核的顶点着色器。
 *
 * 【输出什么】把世界空间法线与"从表面指向相机的视线向量"传给片元。
 * `vViewPosition = -mvPosition.xyz` 是 three 的惯例：它由顶点指向相机，
 * 因此 `dot(normal, normalize(vViewPosition))` 即"视线与法线的夹角余弦"——
 * 面朝相机处 ≈ 1，掠射轮廓处 ≈ 0。这正是径向衰减的物理量纲。
 */
const PLASMA_VERTEX_SHADER = `
varying vec3 vViewNormal;
varying vec3 vViewPosition;

void main() {
  vViewNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * 等离子星核的片元着色器 —— 无硬边径向衰减。
 *
 * 【核心数学】
 *   viewDot  = max(0, dot(N, V))   面心 1 → 轮廓 0
 *   core     = pow(viewDot, 3.2)    高次幂 → 只有正对相机的一小块是白炽
 *   corona   = pow(viewDot, 1.35)   低次幂 → 宽广的青色电晕
 *   alpha    = corona · uPulse · smoothstep(0, 0.02, viewDot)
 *
 * 【为何这样就消灭了死白硬边】球体的可见轮廓恰好是 `viewDot → 0` 的位置，
 * 而 alpha 在这里趋于 0，于是轮廓处**自然透明**，没有"圆片剪纸"的边。
 * 配合加色混合（AdditiveBlending），球体边缘与背景平滑叠加，肉眼看不出边界。
 *
 * 【颜色三级过渡】深海青 → 冰青 → 纯白，由 corona/core 两个权重连续插值，
 * 不存在任何硬分段，因此从任何机位看都是柔和的径向渐变。
 */
const PLASMA_FRAGMENT_SHADER = `
uniform float uPulse;
uniform vec3 uCoreColor;
uniform vec3 uCoronaColor;
uniform vec3 uDeepColor;

varying vec3 vViewNormal;
varying vec3 vViewPosition;

void main() {
  vec3 n = normalize(vViewNormal);
  vec3 v = normalize(vViewPosition);
  float viewDot = max(0.0, dot(n, v));

  float core = pow(viewDot, 3.2);
  float corona = pow(viewDot, 1.35);

  vec3 color = mix(uDeepColor, uCoronaColor, corona);
  color = mix(color, uCoreColor, core);

  float alpha = corona * uPulse;
  alpha *= smoothstep(0.0, 0.02, viewDot);

  gl_FragColor = vec4(color, alpha);
}
`;

/** 外层正向自转角速度（rad/s）：约 25 秒/圈，从容的全局扫描节奏 */
const OUTER_SPIN_RATE = 0.25;

/** 内层反向自转角速度（rad/s）：与外层不同速比，产生持续变化的视差层次 */
const INNER_SPIN_RATE = -0.38;

/** 内核呼吸角频率（rad/s）：≈2.85 秒/次心跳 */
const BREATH_RATE = 2.2;

/**
 * 外层晶格罩的自转速率（弧度/秒，反向）。
 *
 * 【为何比外壳快且反向】外壳 0.25 是"缓慢扫描"的仪表节奏；
 * 罩体取 0.55 的反向旋转，两层棱线以约 0.8 rad/s 的相对角速度穿插，
 * 视觉上产生持续的摩尔纹流动——这正是参考图中心"耀眼且活着"的来源。
 */
const CAGE_SPIN_RATE = 0.55;

/** 晶格罩相对外壳的尺寸倍数（略大，使两层棱线错开而非共面） */
const CAGE_SCALE = 1.34;

/** 内核呼吸振幅（±12% 缩放） */
const BREATH_AMPLITUDE = 0.12;

/** 底部全息圆环参数：内/外轮廓半径与刻度齿数量 */
const RING_INNER_RADIUS = 1.85;
const RING_OUTER_RADIUS = 2.35;
const RING_TICK_COUNT = 24;

/** 圆环局部 Y 偏移：MASTER_POSITION.y(2.5) − 2.42 = 世界 y ≈ 0.08（贴地投影） */
const RING_LOCAL_Y = -2.42;

/** 圆环自转角速度（rad/s） */
const RING_SPIN_RATE = 0.1;

/* -------------------------------------------------------------------------- */
/* 地面投射光束（悬浮水晶 ↔ 地面全息基座的连接体）                                   */
/* -------------------------------------------------------------------------- */

/**
 * 光束顶端：外层水晶的**底部顶点**（局部坐标）。
 *
 * 【推导】八面体 octahedronGeometry 的顶点位于 (±r, 0, 0) / (0, ±r, 0) / (0, 0, ±r)，
 * 底部顶点即 (0, −r, 0)；外层 mesh 又施加了 scale=[1, OCTA_SCALE_Y, 1]，
 * 故底部顶点的局部 Y = −OCTA_RADIUS × OCTA_SCALE_Y = −1.85 × 1.22 ≈ **−2.257**。
 */
const BEAM_TOP_Y = -OCTA_RADIUS * OCTA_SCALE_Y;

/** 光束底端：地面刻度环所在平面（局部 Y = RING_LOCAL_Y ≈ −2.42，世界 y ≈ 0.08） */
const BEAM_BOTTOM_Y = RING_LOCAL_Y;

/**
 * 光束高度。
 *
 * **注意：这不是 0.65，而是由两端点算出的真实间隙 ≈ 0.163。**
 *
 * 需求原文给出的 `cylinderGeometry` 高度为 0.65，但那与场景实测几何不符：
 * 水晶底部顶点在 −2.257，地面环在 −2.42，两者间距只有 0.163。
 * 若强行使用 0.65 且让顶端对齐顶点，光柱底端会落到 −2.907，
 * 即穿出地面网格约 0.42 世界单位——从斜轴机位看会像一根插进地板的柱子；
 * 若改为居中摆放，则两端同时溢出，问题更明显。
 *
 * 因此这里**只保留需求中的半径与段数**（顶 0.02 / 底 0.18 / 16 段 / 开口），
 * 高度改为由两端点派生，保证光束严丝合缝地架在「水晶尖端 ↔ 地面环」之间，
 * 不穿透任何一方。若后续希望得到更醒目的长光柱，
 * 应调整 RING_LOCAL_Y（把地面环下移）或抬升 MASTER_POSITION，而非单方面拉长圆柱。
 */
const BEAM_HEIGHT = BEAM_TOP_Y - BEAM_BOTTOM_Y;

/** 光束中心 Y：两端点的中点（几何中心约束，保证上下端精确对齐） */
const BEAM_CENTER_Y = (BEAM_TOP_Y + BEAM_BOTTOM_Y) / 2;

/** 光束顶部半径（贴近水晶尖端，收得很细） */
const BEAM_TOP_RADIUS = 0.02;

/** 光束底部半径（在地面环上张开，形成「基座投射口」） */
const BEAM_BOTTOM_RADIUS = 0.18;

/** 光束圆周分段（16 段足以在近距离下看不出多边形棱角） */
const BEAM_RADIAL_SEGMENTS = 16;

/** 主题流光 cyan-400（外层晶面与地面圆环） */
const GLOW_CYAN = '#22d3ee';

/** 冰青 highlight（十字能量轴、白炽内核辉光与地面光束） */
const GLOW_ICE = '#a5f3fc';

/** 淡青（内层晶核棱线） */
const GLOW_PALE = '#67e8f9';

/**
 * 刻度齿预计算表（渲染期一次性求值：24 根齿的平面位置与朝向）。
 * 齿为径向小方块，绕圆环均布；角度 θ_i = 2πi/24，
 * 位置 (R·sinθ, 0, R·cosθ)、朝向 rotationY = θ（长轴指向圆心）。
 */
const RING_TICKS: ReadonlyArray<{
  readonly position: [number, number, number];
  readonly rotationY: number;
}> = Array.from({ length: RING_TICK_COUNT }, (_, i): { position: [number, number, number]; rotationY: number } => {
  const theta = (2 * Math.PI * i) / RING_TICK_COUNT;
  const r = (RING_INNER_RADIUS + RING_OUTER_RADIUS) / 2;
  return {
    position: [r * Math.sin(theta), 0, r * Math.cos(theta)],
    rotationY: theta,
  };
});

/**
 * 铭牌的局部坐标。
 *
 * 【为何是这个位置】MasterNode3D 的 <group> 整体挂在 MASTER_POSITION
 * [0, 2.5, 0]，因此所有子节点的 Y 都是**相对 2.5 的局部值**。
 *
 * 旧值 [0, 0.42, 2.25] 换算成世界坐标 Y = 2.5 + 0.42 = **2.92**，
 * 而水晶纵向跨度约 0.32 ~ 4.68（半径 1.85 × 纵向拉伸 1.22），
 * 2.92 恰好落在晶体腰腹正中——铭牌直接插进水晶肚子里穿模。
 *
 * 新值 [0, RING_LOCAL_Y + 0.14, RING_OUTER_RADIUS + 0.45]：
 *   世界 Y = 2.5 + (−2.42 + 0.14) = **0.22**（略高于地面 y=0.08 的刻度环）
 *   世界 Z = 2.35 + 0.45 = **2.80**（朝相机侧探出，在刻度环正前方）
 */
const LABEL_POSITION: readonly [number, number, number] = [
  0,
  RING_LOCAL_Y + 0.14,
  RING_OUTER_RADIUS + 0.45,
];

/* ========================================================================== */
/* MasterNode3D 主体                                                           */
/* ========================================================================== */

/**
 * MasterNode3D —— 控制平面全息模型（挂载于 ClusterCanvas 场景根）。
 *
 * 【订阅纪律】仅订阅 selectedEntityId（低频 UI 字段）驱动选中高亮；
 * 动画通道全部走 useFrame ref 突变，与 React 渲染完全解耦。
 */
export default function MasterNode3D() {
  /* ---- Store 细粒度订阅 ---- */
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );

  /* ---- 交互态（低频 UI 事件，允许 useState） ---- */
  const [hovered, setHovered] = useState<boolean>(false);

  /* ---- 动画通道 ref（useFrame 内原地突变） ---- */
  const outerRef = useRef<THREE.Mesh>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const ringGroupRef = useRef<THREE.Group>(null);

  /**
   * 等离子星核的 uniforms（useMemo 预分配，useFrame 内只写 .value）。
   *
   * 【为何用 useMemo 而非 useRef】shaderMaterial 的 uniforms 对象必须**稳定**：
   * 若每次渲染新建对象，R3F 会在 props diff 时重建整个 shader program，
   * 每帧都要重新编译 GLSL——那是几十毫秒级的开销。
   */
  const plasmaUniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uPulse: { value: 1 },
      uCoreColor: { value: new THREE.Color('#ffffff') },
      uCoronaColor: { value: new THREE.Color('#67e8f9') },
      uDeepColor: { value: new THREE.Color('#06b6d4') },
    }),
    [],
  );

  /** 三道陀螺仪环的 group ref 表（按 GYRO_RINGS 下标对齐） */
  const gyroRefs = useRef<Array<THREE.Mesh | null>>([]);
  gyroRefs.current.length = GYRO_RINGS.length;

  /** 环绕星火 Points ref */
  const sparkRef = useRef<THREE.Points>(null);

  /**
   * 环绕星火的静态几何（半径 R 的球壳上按黄金角均匀分布）。
   *
   * 【零分配契约】位置属性在 useMemo 内一次算好，
   * useFrame 只旋转整个 Points 对象（改 rotation.y），
   * 不触碰任何顶点缓冲，因此每帧成本仅一次矩阵更新。
   */
  const sparkGeometry = useMemo((): THREE.BufferGeometry => {
    const positions = new Float32Array(AMBIENT_SPARK_COUNT * 3);
    for (let i = 0; i < AMBIENT_SPARK_COUNT; i++) {
      const phase = AMBIENT_SPARK_PHASES[i];
      /* 黄金角分布：极角 φ 由序号线性推进，方位角用黄金角错相 → 球壳均匀 */
      const phi = Math.acos(1 - (2 * (i + 0.5)) / AMBIENT_SPARK_COUNT);
      const radius = AMBIENT_SPARK_RADIUS * (0.75 + 0.25 * Math.sin(phase));
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(phase);
      positions[i * 3 + 1] = radius * Math.cos(phi) * 0.55;
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(phase);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, []);
  /**
   * 外层晶格罩（Octahedron Cage）ref。
   *
   * 【为何要第二层八面体】只有一层壳 + 一层核时，转动看起来像"一个东西在转"；
   * 参考图二的能量核心之所以"耀眼"，是因为**多层反向旋转的棱线**相互穿插，
   * 产生持续的视差与摩尔纹——这是晶体感的关键，也是静态几何给不了的。
   * 罩体只画棱线（表面 opacity 0），因此不遮挡内部晶核。
   */
  const cageRef = useRef<THREE.Mesh>(null);

  const isSelected = selectedEntityId === MASTER_ENTITY_ID;
  const emphasized = isSelected || hovered;

  /* hover 光标：Canvas 覆盖全视口，body 样式是唯一可靠通道 */
  useEffect(() => {
    if (!hovered) return undefined;
    const previous = document.body.style.cursor;
    document.body.style.cursor = 'pointer';
    return (): void => {
      document.body.style.cursor = previous;
    };
  }, [hovered]);

  /**
   * useFrame —— 双层反向自转 + 内核呼吸 + 圆环慢转（单回调集中处理）。
   *
   * 【确定性动画】全部角度/缩放为 elapsedTime 的纯函数（t·ω 与 sin(t)），
   * 非增量累积——无浮点误差漂移，暂停/恢复（如页签切换）后相位自洽。
   */
  useFrame((state): void => {
    const t = state.clock.getElapsedTime();

    /* 外层水晶壳：正向自转 + 正弦倾角摆动（调度扫描感） */
    if (outerRef.current !== null) {
      outerRef.current.rotation.y = t * OUTER_SPIN_RATE;
      outerRef.current.rotation.x = Math.sin(t * 0.4) * 0.18;
    }
    /* 内层晶核：反向自转 + 余弦滚转（仪差机械感）+ 呼吸缩放 */
    if (coreRef.current !== null) {
      coreRef.current.rotation.y = t * INNER_SPIN_RATE;
      coreRef.current.rotation.z = Math.cos(t * 0.32) * 0.22;
      const breath = 1 + BREATH_AMPLITUDE * Math.sin(t * BREATH_RATE);
      coreRef.current.scale.setScalar(breath);
    }
    /* 等离子星核脉动：uPulse ∈ [0.82, 1.18]，驱动整个径向衰减包络呼吸。
       必须原地写 .value —— 若赋新对象字面量，就是每帧一次堆分配，
       违反 AGENTS.md 第 3 条的 useFrame 零分配契约。 */
    plasmaUniforms.uPulse.value = 1 + 0.18 * Math.sin(t * BREATH_RATE + Math.PI / 4);

    /* 底部全息圆环：缓慢自转（刻度扫过 = 控制面巡检隐喻） */
    if (ringGroupRef.current !== null) {
      ringGroupRef.current.rotation.y = t * RING_SPIN_RATE;
    }
    /* 外层晶格罩：反向快速自转 + 反向倾角，与外壳形成穿插视差 */
    if (cageRef.current !== null) {
      cageRef.current.rotation.y = -t * CAGE_SPIN_RATE;
      cageRef.current.rotation.z = Math.sin(t * 0.55) * 0.12;
    }
    /*
     * 三轴陀螺仪环：各自绕自身法线匀速自转，互不同步。
     * 这里只写 rotation.z（环的局部法线轴），静态倾角由 JSX 的 tilt 承担，
     * 两者相乘才形成"倾斜的环在自转"——若把角速度也写进 tilt 会边转边歪。
     */
    const gyros = gyroRefs.current;
    for (let i = 0; i < GYRO_RINGS.length; i++) {
      const ring = gyros[i];
      if (ring !== null && ring !== undefined) {
        ring.rotation.z = t * GYRO_RINGS[i].spin;
      }
    }

    /* 环绕星火：整体缓慢上旋 + 轻微呼吸缩放（只动对象变换，不动顶点） */
    if (sparkRef.current !== null) {
      sparkRef.current.rotation.y = t * AMBIENT_SPARK_SPIN_RATE;
      const sparkBreath = 1 + 0.06 * Math.sin(t * 1.7);
      sparkRef.current.scale.setScalar(sparkBreath);
    }
  });

  return (
    <group
      position={MASTER_POSITION}
      onClick={(event): void => {
        /* 阻止穿透：防止一次点击同时命中 MASTER 与其身后的机架/地面 */
        event.stopPropagation();
        selectEntity(MASTER_ENTITY_ID, 'master');
      }}
      onPointerOver={(event): void => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(): void => setHovered(false)}
    >
      {/*
       * ═══ 第 1 层：外层水晶壳（全息通透包络）═══
       *
       * 【为何用 AdditiveBlending + 低 opacity】
       * 不透明混合的晶面会「遮挡」内部结构，整体读起来像半透明白塑料；
       * 纯加色混合下每个晶面只贡献亮度而不遮挡后方，多层叠加自然渐亮，
       * 形成真正通透的能量包络。
       *
       * 【棱线为何用 <Edges> 而非 wireframe】
       * wireframe 沿三角形边绘制，八面体每个面由 2 个三角形构成，
       * 因此会在面上多画出斜向对角线。<Edges threshold={15}> 基于
       * EdgesGeometry 按二面角阈值提取，只保留真正的 12 条棱。
       * scale={1.002} 让棱线极微外扩，避免与晶面共面产生 z-fighting。
       */}
      <mesh ref={outerRef} scale={[1, OCTA_SCALE_Y, 1]}>
        <octahedronGeometry args={[OCTA_RADIUS, 0]} />
        <meshStandardMaterial
          color={GLOW_CYAN}
          emissive={GLOW_CYAN}
          emissiveIntensity={emphasized ? 0.9 : 0.55}
          transparent
          opacity={emphasized ? 0.22 : 0.12}
          metalness={0.05}
          roughness={0.12}
          toneMapped={false}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
        <Edges scale={1.002} threshold={15} color={emphasized ? '#a5f3fc' : GLOW_CYAN} />
      </mesh>

      {/*
       * ═══ 第 1.5 层：外层旋转正八面体棱线晶格（Octahedron Cage）═══
       *
       * 【只画棱线】表面材质 opacity 0 + depthWrite false：
       * 完全透明的面片不会遮挡内部晶核，只有 <Edges> 的 12 条棱可见。
       * 因此几何上是一个"线框笼"，视觉上却像一层在外部旋转的能量晶格。
       *
       * 【棱色用冰青】比外壳的青色更白一档，让它在深空背景上有"最亮一层"的观感，
       * 与内部晶核、白炽内核形成"外亮—中亮—最亮"的向内汇聚。
       */}
      <mesh ref={cageRef} scale={[CAGE_SCALE, CAGE_SCALE * OCTA_SCALE_Y, CAGE_SCALE]} raycast={(): void => undefined}>
        <octahedronGeometry args={[OCTA_RADIUS, 0]} />
        <meshBasicMaterial color={GLOW_ICE} transparent opacity={0} depthWrite={false} toneMapped={false} />
        <Edges scale={1.002} threshold={15} color={emphasized ? '#ecfeff' : GLOW_ICE} />
      </mesh>

      {/*
       * ═══ 第 2 层：内层反向晶核 ═══
       * opacity 0.22 + AdditiveBlending + depthWrite false：
       * 只保留「内部还有一层结构在转动」的层次，由 <Edges> 给出清晰轮廓，
       * 不再依赖实体表面（旧的 0.85 实心白块即「塑料感」来源）。
       */}
      <mesh ref={coreRef}>
        <octahedronGeometry args={[CORE_CRYSTAL_RADIUS, 0]} />
        <meshStandardMaterial
          color={GLOW_ICE}
          emissive={GLOW_PALE}
          emissiveIntensity={1.4}
          metalness={0.1}
          roughness={0.15}
          transparent
          opacity={0.22}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
        <Edges threshold={15} color={GLOW_PALE} />
      </mesh>

      {/*
       * ═══ 第 3 层：三轴陀螺仪全息轨道环 ═══
       *
       * 【替代了什么】原来的三根 boxGeometry 十字直棍直接穿过球心，
       * 视觉上是"糖葫芦签子"——刚性、共面、且把中心切成了碎片。
       *
       * 【为什么环更像仪器】三道环倾角各异（π/3、−π/4+π/5、π/2+π/6），
       * 半径 1.15 / 1.32 / 1.48 递进，各自以不同角速度自转：
       * 任意时刻三环的交点都在移动，扫掠面持续变化，
       * 这正是陀螺仪"在工作"的视觉签名，而不是一个静态骨架。
       *
       * 【渲染参数】torusGeometry 的管径取得极细（0.008~0.012），
       * 配合加色混合，在深空背景上像一圈悬浮的激光轨道。
       */}
      {GYRO_RINGS.map((gyro): ReactNode => (
        <mesh
          key={gyro.key}
          ref={(node): void => {
            gyroRefs.current[GYRO_RINGS.indexOf(gyro)] = node;
          }}
          rotation={[gyro.tilt[0], gyro.tilt[1], gyro.tilt[2]]}
          raycast={(): void => undefined}
        >
          <torusGeometry args={[gyro.radius, gyro.thickness, 8, 128]} />
          <meshBasicMaterial
            color={GLOW_PALE}
            transparent
            opacity={0.55}
            toneMapped={false}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      ))}

      {/*
       * ═══ 第 4 层：等离子星核（自定义 GLSL 径向衰减）═══
       *
       * 【为什么必须自写 shader】标准材质靠 emissiveIntensity 提亮，
       * RGB 三个通道全部超过 1 被截断成纯白 —— 视觉上就是一个死白的硬边圆片，
       * 轮廓像剪纸。真实能量核的特征恰恰相反：**中心极亮、边缘完全透明**。
       *
       * 【实现】片元着色器用视线-法线夹角余弦做径向衰减：
       *   球体可见轮廓处 viewDot → 0，alpha → 0（自然透明，无缝融入背景）
       *   正对相机处 viewDot → 1，core = 1（白炽）
       * 配合 AdditiveBlending + depthWrite=false，多层能量自然叠加发光。
       *
       * 【uPulse】由 useFrame 每帧写 .value 做心跳脉动（零分配）。
       */}
      <mesh raycast={(): void => undefined}>
        <sphereGeometry args={[NUCLEUS_RADIUS, 48, 48]} />
        <shaderMaterial
          uniforms={plasmaUniforms}
          vertexShader={PLASMA_VERTEX_SHADER}
          fragmentShader={PLASMA_FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      {/*
       * ═══ 第 4b 层：环绕微光星火（36 颗缓慢上升旋转的微粒）═══
       *
       * 【解决什么】控制平面此前只有几条刚性结构线，缺少"数字生命力"。
       * 36 颗星火按球壳黄金角分布包围在半径 2.2 内，整体缓慢自转 + 呼吸缩放，
       * 让中心在静止机位下也持续有微小的光点在游走。
       *
       * 【性能】单个 Points 对象 = 1 次 Draw Call；顶点缓冲在 useMemo 内
       * 一次性生成，useFrame 只改对象变换（rotation.y / scale），不触碰缓冲。
       */}
      <points ref={sparkRef} geometry={sparkGeometry} raycast={(): void => undefined}>
        <pointsMaterial
          size={0.055}
          color={GLOW_ICE}
          transparent
          opacity={0.75}
          sizeAttenuation
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/*
       * ═══ 第 5 层：地面投射光束（悬浮水晶的能量脐带）═══
       *
       * 【设计意图】让水晶看起来不是「凭空悬浮」，而是**由地面全息基座向上投射**
       * 出来的实体。光束上细下粗（0.02 → 0.18），像一个从地面环张开、
       * 收束到水晶尖端的投射口，把「因果方向」写进几何里。
       *
       * 【渲染契约】
       * - cylinderGeometry 的 openEnded=true：只保留侧面圆筒，去掉上下端盖，
       *   避免在尖端与地面处出现两片明显的实心圆盘；
       * - AdditiveBlending：与水晶壳同族的加色混合，叠加后自然发光；
       * - depthWrite=false：不写深度，不遮挡地面刻度环与星环；
       * - DoubleSide：从任何机位（含俯视）都能看到筒壁，不会因背面剔除而消失；
       * - opacity 0.35：克制，作为结构连接而非视觉主角。
       */}
      <mesh position={[0, BEAM_CENTER_Y, 0]} raycast={(): void => undefined}>
        <cylinderGeometry
          args={[BEAM_TOP_RADIUS, BEAM_BOTTOM_RADIUS, BEAM_HEIGHT, BEAM_RADIAL_SEGMENTS, 1, true]}
        />
        <meshBasicMaterial
          color={GLOW_ICE}
          transparent
          opacity={0.35}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/*
       * ═══ 程序化假辉光（双层）═══
       * 外层大面积青色柔光营造整体氛围，内层小面积冰青白核强化「白炽」感。
       * 内层透明度压到 0.62：新版 shader 自带白炽核，
       * 若仍用 0.95 会与实体内核叠加过曝成一片纯白。
       */}
      <GlowHalo3D color={GLOW_CYAN} scale={5.4} opacity={0.85} falloff={2.2} pulse pulsePeriod={3.4} />
      <GlowHalo3D color={GLOW_ICE} scale={2.2} opacity={0.62} falloff={2.8} pulse pulsePeriod={2.1} />

      {/* ---- 底部刻度全息圆环：双环轮廓 + 24 径向刻度齿（贴地投影，缓慢自转）。
         【几何推导】ringGroupRef 只承担绕世界 Y 的慢转（刻度扫过 = 巡检隐喻）；
         「平铺贴地」的 −90°X 旋转下放到各子网格自身——ringGeometry 默认在
         XY 平面，绕自身 X 转 −π/2 后即平铺于世界 XZ 平面；刻度齿为径向小方块
         （boxGeometry 长轴沿 Z），绕自身 Y 转 θ 后长轴指向圆心，恒贴地。
         若把 −90°X 放在 group 上，齿会被连带立起且朝向错乱，故严禁上提。 ---- */}
      <group ref={ringGroupRef} position={[0, RING_LOCAL_Y, 0]}>
        {/* 外轮廓环（自身 −90°X 平铺贴地） */}
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[RING_OUTER_RADIUS - 0.035, RING_OUTER_RADIUS, 96]} />
          <meshBasicMaterial
            color={GLOW_CYAN}
            transparent
            opacity={emphasized ? 0.85 : 0.5}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* 内轮廓环 */}
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[RING_INNER_RADIUS, RING_INNER_RADIUS + 0.03, 96]} />
          <meshBasicMaterial
            color={GLOW_CYAN}
            transparent
            opacity={emphasized ? 0.7 : 0.38}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* 24 根径向刻度齿（渲染期预计算位置/朝向；几何由 R3F 内联托管，
            卸载自动 dispose——规避共享实例在 StrictMode 双挂载下的泄漏风险） */}
        {RING_TICKS.map((tick, index): ReactNode => (
          <mesh key={index} position={[tick.position[0], tick.position[1], tick.position[2]]} rotation={[0, tick.rotationY, 0]}>
            <boxGeometry args={[0.05, 0.022, 0.34]} />
            <meshBasicMaterial
              color={GLOW_CYAN}
              transparent
              opacity={emphasized ? 0.75 : 0.42}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>

      {/*
       * ---- 贴地全息铭牌 ----
       *
       * 【位置修复】详见 LABEL_POSITION 常量注释：旧的 [0, 0.42, 2.25]
       * 换算到世界坐标为 y=2.92，正好插进水晶腰腹（穿模）。
       * 现贴在刻度圆环正前方地面（世界 y=0.22），完全不遮挡晶体。
       *
       * 【样式】无底色全息微发光文字：纯 drop-shadow 发光而非 panel 背景，
       * 暗场里像悬浮的投影标注；whitespace-nowrap 强制单行。
       * drei Html 契约（AGENTS.md 第 6 条）：zIndexRange=[10,0] +
       * pointer-events-none，永不遮挡右侧 Copilot 抽屉与顶层 Modal。
       */}
      <Html
        position={[LABEL_POSITION[0], LABEL_POSITION[1], LABEL_POSITION[2]]}
        center
        distanceFactor={14}
        zIndexRange={[10, 0]}
        className="pointer-events-none"
      >
        <div className="flex flex-col items-center gap-1 whitespace-nowrap px-3 py-1.5 font-mono">
          {/*
           * ── 上沿：刻度线 + 系统标识 ──
           * 由"两条短横线"升级为**发光刻度线**：中间密、两侧疏，
           * 像仪器上的标尺刻度，比单纯的装饰横线更有"仪表"语义。
           */}
          <span className="flex items-center gap-1 text-[8px] uppercase tracking-[0.32em] text-cyan-400/60">
            {[3, 2, 1, 0, 1, 2, 3].map((tier, index): ReactNode => (
              <span
                key={`scale-${index}`}
                aria-hidden
                className="block bg-cyan-400/50"
                style={{ width: '1px', height: tier === 0 ? '6px' : '3px' }}
              />
            ))}
            <span className="ml-1.5 text-cyan-300/70">SYS.CORE // CONTROL PLANE · API-SERVER</span>
          </span>

          {/*
           * ── 主体：两侧光翼括弧 + 发光主标题 ──
           * 两侧用对称斜切括弧把标题"夹"起来，是 HUD 里表达
           * "该对象处于系统焦点"的标准手法。
           */}
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="block h-3 w-[6px] border-l border-t border-cyan-300/70"
              style={{ borderTopWidth: '1px', transform: 'skewX(-18deg)' }}
            />
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_6px_#22d3ee] animate-glow-pulse" />
              <span className="text-[11px] font-bold tracking-[0.18em] text-cyan-100 drop-shadow-[0_0_8px_rgba(34,211,238,0.8)]">
                控制平面 · API-SERVER
              </span>
            </span>
            <span
              aria-hidden
              className="block h-3 w-[6px] border-r border-t border-cyan-300/70"
              style={{ borderTopWidth: '1px', transform: 'skewX(18deg)' }}
            />
          </span>

          {/*
           * ── 底部：缓慢呼吸的能量基线 ──
           * 一条低透明度青色渐变横线，用 CSS 动画做 2.8s 呼吸，
           * 让铭牌"活着"又不抢标题。宽度 100% 通过 wrapper 撑开。
           */}
          <span
            aria-hidden
            className="mt-0.5 block h-px w-full animate-pulse"
            style={{
              background:
                'linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.75) 50%, transparent 100%)',
            }}
          />
        </div>
      </Html>
    </group>
  );
}