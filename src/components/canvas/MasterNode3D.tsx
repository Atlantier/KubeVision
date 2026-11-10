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
import { PALETTE } from '@/constants/palette';
import CrystalOptics from '@/components/canvas/CrystalOptics';

import { useClusterStore } from '@/store/useClusterStore';
import { MASTER_ENTITY_ID } from '@/types/canvas';
import { MASTER_POSITION } from '@/utils/spatialLayout';
import GlowHalo3D from '@/components/canvas/GlowHalo3D';
import { HoloCorners, HoloMicroRuler, HoloRefractionEdges, HoloSpecularSheen } from '@/components/canvas/HoloHud';
import type { SelectedEntityType } from '@/types/store';
import { KV_DEBUG_NAN_DEFINES } from '@/utils/glslNanGuard';

/* ========================================================================== */
/* 模型几何常量（模块级，集中定义防漂移）                                          */
/* ========================================================================== */

/** 外层八面体半径（调度扫描包络） */
const OCTA_RADIUS = 1.68;

/** 外层纵向拉伸比：水晶略瘦高，比正球体更具「晶体」而非「球」的轮廓 */
const OCTA_SCALE_Y = 1.22;

/** 内层反向晶核半径（与外层保持充足间隙，双层结构互不穿插） */
const CORE_CRYSTAL_RADIUS = 1.05;

/** 八面体顶点数（6 个：±X / ±Y / ±Z 各一对） */
const OCTA_VERTEX_COUNT = 6;

/** 中心白炽星核球半径（紧凑锐利，收敛自旧版 0.36 的"大棉花球"） */
const NUCLEUS_RADIUS = 0.16;

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

/* -------------------------------------------------------------------------- */
/* 星云星座粒子群（Constellation Point Cloud）                                  */
/* -------------------------------------------------------------------------- */

/** 内部星座粒子数量（360 颗，单次 Draw Call 的 Points） */
const CONSTELLATION_COUNT = 360;

/**
 * 八面体体积约束（L1 范数不等式）。
 *
 * 【几何原理】正八面体 |x|+|y|+|z| ≤ r 是它的解析定义。
 * 外层八面体做了纵向拉伸（scaleY = 1.22），因此约束变为
 *   |x| + |y / 1.22| + |z| ≤ r·0.9
 * 其中 0.9 是刻意留出的内缩系数：粒子必须严格落在**面片之内**，
 * 贴到棱线上会与 Edges 线框打架，看起来像"粒子漏出晶体"。
 *
 * 【密度】用 u = random^(1/3) 把半径分布偏向中心：
 * 立方根采样让粒子在体积内均匀，再乘 0.75 幂次把重心进一步压向内芯，
 * 形成"中心致密、边缘稀疏"的星云形态——这是星云而非均匀点阵的关键。
 */
const CONSTELLATION_RADIUS = OCTA_RADIUS * 0.9;

/** 星云粒子的三种粒径档位（大 / 中 / 微），按序号循环 */
const CONSTELLATION_SIZES: readonly number[] = [1.0, 0.62, 0.38];

/** 内部神经晶格连线的节点对数（28 对 + 6 个外顶点连线） */
const NEURAL_PAIR_COUNT = 28;

/** 星云粒子/连线随整颗晶体自转的角速度（rad/s，与外壳同步但更慢） */
const CONSTELLATION_SPIN_RATE = 0.18;

/**
 * 星云星座粒子的顶点着色器。
 *
 * 【职责】把三件事传给片元，并完成逐粒子的悬浮位移：
 * 1. `aSize`   粒径档位 → 作为点尺寸的乘数（大/中/微三档）；
 * 2. `aPhase`  独立相位 → 每颗粒子的闪烁与悬浮互不同步，避免整片同步脉动；
 * 3. 悬浮位移  pos.y += sin(uTime · 0.8 + aPhase) · 0.035
 *    振幅仅 3.5cm：晶体内部的星云应当是"呼吸"，不是"沸腾"。
 *
 * 【点尺寸公式】gl_PointSize = aSize · uScale · (300 / -mvPosition.z)
 * 这是 three 内置 pointsMaterial 的标准透视缩放式，改成手写后
 * 可以逐粒子调制粒径（内置材质只有全局 size）。
 */
const CONSTELLATION_VERTEX_SHADER = `
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;

varying float vPhase;
varying float vSize;

void main() {
  vPhase = aPhase;
  vSize = aSize;

  vec3 displaced = position;
  displaced.y += sin(uTime * 0.8 + aPhase) * 0.035;

  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * uScale * (300.0 / max(0.001, -mvPosition.z));
}
`;

/**
 * 星云星座粒子的片元着色器 —— 圆形径向高斯星芒点。
 *
 * 【为什么必须手写】Points 默认渲染的是**方形像素块**，放大会露出硬边方块，
 * 一眼假。用 `gl_PointCoord`（点内归一化坐标 [0,1]²）计算到中心的距离，
 * 再做径向高斯衰减，才能得到圆形柔光的星点。
 *
 * 【三层色阶】
 *   d < 0.22          → 炽白 #ffffff（核心）
 *   0.22 ≤ d < 0.55   → 电光青 #38bdf8（内圈）
 *   d ≥ 0.55          → 深海蓝 #0284c7（外圈，边缘透明）
 * 三档之间用 smoothstep 平滑过渡，且 alpha 在 d → 1 时归零，
 * 因此点的边界完全消失，只有中心的光。
 *
 * 【闪烁】`flicker = 0.62 + 0.38·sin(uTime·2.4 + vPhase)`：
 * 每颗粒子有自己的相位，整片星云呈现细密的明灭，而不是统一呼吸。
 */
const CONSTELLATION_FRAGMENT_SHADER = `
uniform float uTime;
uniform float uOpacity;
uniform vec3 uColor;

varying float vPhase;
varying float vSize;

void main() {
  vec2 centered = gl_PointCoord - vec2(0.5);
  float d = length(centered) * 2.0;
  if (d > 1.0) discard;

  float core = 1.0 - smoothstep(0.0, 0.22, d);
  float mid = 1.0 - smoothstep(0.18, 0.55, d);
  float outer = 1.0 - smoothstep(0.5, 1.0, d);

  vec3 color = vec3(0.011, 0.518, 0.780);          /* #0284c7 外圈 */
  color = mix(color, uColor, mid);        /* 内圈取健康度色温 */
  color = mix(color, vec3(1.0, 1.0, 1.0), core);    /* #ffffff 核心 */

  float flicker = 0.62 + 0.38 * sin(uTime * 2.4 + vPhase);
  float alpha = (core * 0.95 + mid * 0.55 + outer * 0.25) * flicker * uOpacity;
  alpha *= 1.0 - smoothstep(0.85, 1.0, d);

  gl_FragColor = vec4(clamp(color, 0.0, 8.0), clamp(alpha, 0.0, 1.0));
  #ifdef KV_DEBUG_NAN
    if (!(gl_FragColor.r == gl_FragColor.r)
        || !(gl_FragColor.g == gl_FragColor.g)
        || !(gl_FragColor.b == gl_FragColor.b)
        || !(gl_FragColor.a == gl_FragColor.a)
        || abs(gl_FragColor.r) > 1.0e38
        || abs(gl_FragColor.g) > 1.0e38
        || abs(gl_FragColor.b) > 1.0e38) {
      gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); // glsl-lint-allow: 洋红调试标记为常量输出，无 HDR 溢出风险
    }
  #endif
}
`;

/* -------------------------------------------------------------------------- */
/** 星火环绕半径（控制平面外围能量场） */
const AMBIENT_SPARK_RADIUS = 2.2;

/** 环绕控制平面缓慢上升旋转的微光星火数量 */
const AMBIENT_SPARK_COUNT = 36;

/* -------------------------------------------------------------------------- */
/* 赤道环与斜交极轨细线环                                                        */
/* -------------------------------------------------------------------------- */

/** 赤道水平光环半径（略大于内层晶核 1.05、小于外层八面体 1.68 的腰部跨度） */
const EQUATOR_RADIUS = 1.88;

/** 赤道环线宽与自转角速度（rad/s，约 9 秒一圈，是全场最快的光环） */
const EQUATOR_THICKNESS = 0.012;
const EQUATOR_SPIN_RATE = 0.72;

/**
 * 两道斜交极轨细环。
 *
 * 【为何"斜交"】单看赤道环只是一条水平圈；再叠两道人造卫星式的极轨道，
 * 三者构成一个**三维球壳骨架**，中心立刻从"扁平的圈"变成"有经纬的星体"。
 * 倾角取 π/2±0.42 —— 刻意让两条极轨互不重合、也不与赤道共面。
 *
 * 【opacity 0.22】这是"背景结构"的强度：它们只负责经纬感，
 * 绝不能抢走星云粒子与棱线的主体地位。
 */
const POLAR_RINGS: ReadonlyArray<{
  readonly key: string;
  readonly tilt: readonly [number, number, number];
  readonly spin: number;
}> = [
  { key: 'polar-a', tilt: [Math.PI / 2 + 0.42, 0, 0.18], spin: 0.34 },
  { key: 'polar-b', tilt: [Math.PI / 2 - 0.42, 0.2, -0.18], spin: -0.27 },
];

/** 极轨细环的半径与线宽 */
const POLAR_RING_RADIUS = 1.62;
const POLAR_RING_THICKNESS = 0.008;

/* -------------------------------------------------------------------------- */
/* 集群健康度 → 色温联动                                                         */
/* -------------------------------------------------------------------------- */

/** 健康态：冰晶青蓝 */
const TONE_HEALTHY = new THREE.Color('#38bdf8');
/** 警告态：流光琥珀 */
const TONE_WARNING = new THREE.Color('#fbbf24');
/** 故障态：绯红等离子 */
/* L10：主控故障色 / 主题青统一到 palette（HDR 增益由发光强度承担） */
const TONE_CRITICAL = PALETTE.critical.color;

/** 健康分阈值：≥90 健康、≥70 警告、其余故障 */
const HEALTHY_SCORE_THRESHOLD = 90;
const WARNING_SCORE_THRESHOLD = 70;

/**
 * 色温过渡阻尼率 k（1/秒）。
 *
 * 【取值依据】SSE 快照 1Hz；k=2.2 使一次状态跃迁在约 1.4 秒内基本完成，
 * 观感是"晶体慢慢变色"而不是"啪一下换色"——这正是仪表该有的从容。
 */
const TONE_LERP_RATE = 2.2;

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

  float core = pow(max(viewDot, 1.0e-4), 3.2);
  float corona = pow(max(viewDot, 1.0e-4), 1.35);

  vec3 color = mix(uDeepColor, uCoronaColor, corona);
  color = mix(color, uCoreColor, core);

  float alpha = corona * uPulse;
  alpha *= smoothstep(0.0, 0.02, viewDot);

  gl_FragColor = vec4(clamp(color, 0.0, 8.0), clamp(alpha, 0.0, 1.0));
  #ifdef KV_DEBUG_NAN
    if (!(gl_FragColor.r == gl_FragColor.r)
        || !(gl_FragColor.g == gl_FragColor.g)
        || !(gl_FragColor.b == gl_FragColor.b)
        || !(gl_FragColor.a == gl_FragColor.a)
        || abs(gl_FragColor.r) > 1.0e38
        || abs(gl_FragColor.g) > 1.0e38
        || abs(gl_FragColor.b) > 1.0e38) {
      gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); // glsl-lint-allow: 洋红调试标记为常量输出，无 HDR 溢出风险
    }
  #endif
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

/* ========================================================================== */
/* 好莱坞级特效一：几何复杂度强化                                                */
/* ========================================================================== */

/**
 * 二十面体测地线量子内胆的半径。
 *
 * 【为何比八面体小这么多】内胆必须完全容纳在双层八面体内部，
 * 否则会在晶面上穿出、破坏"水晶包裹内核"的层次。
 * 八面体内切球半径 = OCTA_RADIUS / √3 ≈ 0.97，取 0.86 留出安全余量。
 */
const ICOSA_CORE_RADIUS = 0.86;

/**
 * 内胆的细分等级（0 = 原始 20 面，1 = 80 面，2 = 320 面）。
 *
 * 【为何取 1】测地线球体的视觉价值在于"高密但可读"——等级 0 太像普通
 * 二十面体（与八面体区分度不够），等级 2 的 320 面在机柜大小的视口里
 * 会糊成一团球，反而失去几何美感。等级 1 的 80 面恰好在"看得出是
 * 多面体"与"足够密实"之间，是测地线穹顶的经典折中。
 */
const ICOSA_CORE_DETAIL = 1;

/**
 * 内胆自转角速度（rad/s，反向且明显慢于内核）。
 *
 * 【为何要"慢"】内胆是背景层的结构装饰，它的作用是让中央区域
 * 在静置时也有细微变化。若与外层同速或更快，会与八面体线框
 * 争夺视觉焦点，反而显得杂乱。取 OUTER_SPIN_RATE 的 0.7 倍反向。
 */
const ICOSA_CORE_SPIN_RATE = -0.17;

/**
 * 双向正交精密刻度星轨环的半径。
 *
 * 【取值依据】必须落在八面体内部（内切球 0.97）但又要大于内胆，
 * 形成"内胆 → 刻度环 → 八面体线框"的三层同心结构。
 */
const GIMBAL_RING_RADIUS = 1.12;

/** 星轨环的刻度齿数量（双向各 36 齿 = 10° 一格，精密仪器感） */
const GIMBAL_TICK_COUNT = 36;

/** 星轨环自转角速度：两环反向，形成正交差速 */
const GIMBAL_RING_A_SPIN = 0.31;
const GIMBAL_RING_B_SPIN = -0.24;

/**
 * 刻度齿的几何尺寸。
 *
 * 【为何如此之短】刻度齿是"度盘上的刻线"，作用是提供角度参照，
 * 不是装饰条。长 0.055 / 宽 0.006 在 1.12 半径的环上约占
 * 5% 半径、0.5% 宽度——正好是精密仪器刻线的比例。
 * B 环略短，让两环在视觉上有主次（A 为主刻度、B 为副刻度）。
 */
const GIMBAL_TICK_LENGTH_A = 0.055;
const GIMBAL_TICK_LENGTH_B = 0.042;

/** 八面体顶点电光锚点的呼吸角频率与基准尺寸 */
const VERTEX_ANCHOR_BREATH_RATE = 1.9;
const VERTEX_ANCHOR_BASE_SCALE = 1;

/* ========================================================================== */
/* 地面投射光束（悬浮水晶 <-> 地面全息基座的连接体）                                   */
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
 * 高度改为由两端点派生，保证光束严丝合缝地架在「水晶尖端 <-> 地面环」之间，
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
const LABEL_POSITION: readonly [number, number, number] = [0, -1.96, 1.48];

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

  /* ---- 本轮新增：几何复杂度强化 ---- */

  /**
   * 二十面体测地线量子内胆 ref。
   *
   * 【为何用线框而非实体】内胆位于双层八面体内部，若用实体材质
   * 会挡住最中心的等离子星核——那才是视觉焦点。线框既表达了
   * "高密测地线结构"，又保持了通透性。
   */
  const icosaCoreRef = useRef<THREE.LineSegments>(null);

  /** 双向正交刻度星轨环 A（绕 X 轴倾斜）ref */
  const gimbalRingARef = useRef<THREE.Group>(null);
  /** 双向正交刻度星轨环 B（绕 Z 轴倾斜，与 A 正交）ref */
  const gimbalRingBRef = useRef<THREE.Group>(null);

  /** 八面体顶点电光锚点实例网格 ref（呼吸辉光由材质 emissive 驱动） */
  const vertexAnchorRef = useRef<THREE.InstancedMesh>(null);

  /**
   * 二十面体测地线内胆的线框几何（useMemo 预分配）。
   *
   * 【为何不能在 JSX 里内联 new THREE.IcosahedronGeometry(...)】
   * `<wireframeGeometry args={[new THREE.IcosahedronGeometry(...)]} />`
   * 这种写法会在**每次组件重渲染**时创建一个新的 IcosahedronGeometry，
   * 而 args 引用变化会让 R3F 重建 wireframeGeometry——1Hz 遥测快照
   * 触发重渲染时就会持续产生几何垃圾，最终被 GPU 侧 accumulate 成内存增长。
   * 用 useMemo 固定在首次渲染创建，此后引用恒定。
   */
  const icosaCoreGeometry = useMemo(
    (): THREE.WireframeGeometry =>
      new THREE.WireframeGeometry(
        new THREE.IcosahedronGeometry(ICOSA_CORE_RADIUS, ICOSA_CORE_DETAIL),
      ),
    [],
  );

  /** 星轨环 A 的刻度齿实例网格（36 实例 → 1 次 Draw Call） */
  const gimbalTicksARef = useRef<THREE.InstancedMesh>(null);
  /** 星轨环 B 的刻度齿实例网格 */
  const gimbalTicksBRef = useRef<THREE.InstancedMesh>(null);

  /**
   * 刻度齿的实例矩阵表（两环各 36 个，useMemo 一次算好）。
   *
   * 【为何必须实例化】36 × 2 = 72 个刻度齿若各自一个 <mesh>，
   * 就是 72 次 draw call——实测把整场景从 388 推到 466（+78）。
   * 它们材质相同、只有位置与朝向不同，正是 InstancedMesh 的典型场景：
   * 72 → 2 次 draw call，省下 70 次。
   *
   * 【矩阵只在挂载时写一次】刻度齿是静态装饰：环的自转由外层
   * group 的 rotation.z 承担，子节点相对位置不变，
   * 因此实例矩阵永不变化，useFrame 零开销。
   */
  const gimbalTickMatrices = useMemo(
    (): { ringA: ReadonlyArray<THREE.Matrix4>; ringB: ReadonlyArray<THREE.Matrix4> } => {
      /* 临时 Object3D 仅在此用一次，绝不进入渲染循环 */
      const temp = new THREE.Object3D();
      const build = (tickLength: number): ReadonlyArray<THREE.Matrix4> => {
        const matrices: THREE.Matrix4[] = [];
        for (let i = 0; i < GIMBAL_TICK_COUNT; i += 1) {
          const angle = (i / GIMBAL_TICK_COUNT) * Math.PI * 2;
          /* 齿根贴在环上，齿身朝外：位置取"环半径 + 半个齿长" */
          temp.position.set(
            Math.cos(angle) * (GIMBAL_RING_RADIUS + tickLength / 2),
            Math.sin(angle) * (GIMBAL_RING_RADIUS + tickLength / 2),
            0,
          );
          /* 齿的长边沿径向：绕 Z 旋转 angle 让本地 X 轴指回半径方向 */
          temp.rotation.set(0, 0, angle);
          temp.scale.set(1, 1, 1);
          temp.updateMatrix();
          matrices.push(temp.matrix.clone());
        }
        return matrices;
      };
      return {
        ringA: build(GIMBAL_TICK_LENGTH_A),
        ringB: build(GIMBAL_TICK_LENGTH_B),
      };
    },
    [],
  );

  /**
   * 把刻度齿矩阵写入两个 InstancedMesh。
   *
   * 【为何必须置 needsUpdate】InstancedMesh 的实例矩阵存在 GPU 缓冲里，
   * 通过 setMatrixAt 只改动 CPU 侧副本。不置 instanceMatrix.needsUpdate
   * 的话，渲染时仍用旧的（全零）矩阵——所有齿会堆在原点，
   * 视觉上表现为"刻度齿消失"（AGENTS.md 第 7 条）。
   */
  useEffect((): void => {
    const apply = (mesh: THREE.InstancedMesh | null, matrices: ReadonlyArray<THREE.Matrix4>): void => {
      if (mesh === null) return;
      for (let i = 0; i < matrices.length; i += 1) {
        mesh.setMatrixAt(i, matrices[i]);
      }
      mesh.count = matrices.length;
      mesh.instanceMatrix.needsUpdate = true;
    };
    apply(gimbalTicksARef.current, gimbalTickMatrices.ringA);
    apply(gimbalTicksBRef.current, gimbalTickMatrices.ringB);
  }, [gimbalTickMatrices]);

  /**
   * 最新总 QPS 的 ref 镜像。
   *
   * 【为何需要 ref 而非直接用订阅值】useFrame 的回调闭包在首次渲染后
   * 就固定了（R3F 不会每帧重建回调）。若直接读订阅的 totalQps 变量，
   * 拿到的是**首次渲染时的值**，永远不更新——这是 R3F 里非常经典的
   * stale closure 陷阱。用 ref 镜像后，useEffect 每 1Hz 刷新，
   * useFrame 帧内读到的永远是最新值，且不触发重渲染。
   */
  const totalQpsRef = useRef<number>(0);

  /** 星云星座粒子 Points ref */
  const constellationRef = useRef<THREE.Points>(null);
  /** 内部神经晶格连线 ref */
  const neuralRef = useRef<THREE.LineSegments>(null);

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
   * 【为何要第二层】只有一层壳 + 一层核时，转动像"一个东西在转"；
   * 参考图的能量核心之所以"耀眼"，是因为**多层反向旋转的棱线**相互穿插，
   * 产生持续的视差与摩尔纹。罩体只画棱线（表面 opacity 0），不遮挡内部。
   */
  const cageRef = useRef<THREE.Mesh>(null);

  /* ---------------------------------------------------------------------- */
  /* 星云星座粒子群 / 神经晶格 / 垂直光柱 —— 数据与 uniforms                    */
  /* ---------------------------------------------------------------------- */

  /**
   * 星云星座粒子的 uniforms。
   *
   * uTime：驱动悬浮与闪烁（useFrame 原地写）；
   * uScale：点尺寸整体缩放（DPR/相机距离的兜底调节）；
   * uOpacity：整片星云的透明度。
   */
  const constellationUniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uTime: { value: 0 },
      uScale: { value: 1 },
      uOpacity: { value: 0.92 },
      /** 健康度色温（useFrame 内与 TONE_* 三态 lerp，初始为健康青蓝） */
      uColor: { value: new THREE.Color('#38bdf8') },
    }),
    [],
  );

  /* ---------------------------------------------------------------------- */
  /* 集群健康度联动：三态色温                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * 当前集群健康分（低频订阅，1Hz 上限）。
   *
   * 【为何在这里订阅】色温是"整颗晶体的状态"，必须来自集群整体健康度
   * 而不是选中态。订阅单个数值字段，快照其余部分变化不会触发本组件重渲染。
   */
  const clusterHealthScore = useClusterStore(
    (s): number => s.snapshotSummary.clusterHealthScore,
  );

  /**
   * 集群总 QPS（驱动镜头光晕亮度）。
   *
   * 【订阅粒度】只取 totalQps 一个标量，快照整体变化但 QPS 未变时
   * 不会触发重渲染——这是项目一贯的细粒度订阅纪律。
   */
  const totalQps = useClusterStore((s): number => s.snapshotSummary.totalQps);

  /** 三态目标色（普通值，渲染期按分档一次性选定；useFrame 只读不选） */
  const healthTargetColor = useMemo((): THREE.Color => {
    if (clusterHealthScore >= HEALTHY_SCORE_THRESHOLD) return TONE_HEALTHY;
    if (clusterHealthScore >= WARNING_SCORE_THRESHOLD) return TONE_WARNING;
    return TONE_CRITICAL;
  }, [clusterHealthScore]);

  /**
   * 色温当前值（持久态，跨帧 lerp）。
   *
   * 【为何不直接写 uniform】粒子 / 连线 / 光柱三类材质各有一份颜色，
   * 若各自 lerp 会因起始值不同而出现"颜色不同步"的割裂。
   * 用**单一持久色**统一插值，再广播给三处，颜色永远一致。
   */
  const healthColorCurrent = useMemo((): THREE.Color => TONE_HEALTHY.clone(), []);



  /**
   * QPS → ref 镜像（供 useFrame 读取，避免 stale closure）。
   *
   * 【依赖 totalQps 而非 clusterHealthScore】QPS 变化比健康分频繁得多
   * （健康分只在跨阈值时才变），而光晕亮度需要跟随瞬时负载起伏，
   * 所以必须单独订阅。
   */
  useEffect((): void => {
    totalQpsRef.current = totalQps;
  }, [totalQps]);

  /** 赤道环 ref（水平光环，最快自转） */
  const equatorRef = useRef<THREE.Mesh>(null);
  /** 两道斜交极轨环 ref 表 */
  const polarRingRefs = useRef<Array<THREE.Mesh | null>>([]);
  polarRingRefs.current.length = POLAR_RINGS.length;

  /**
   * 星云粒子几何 —— 360 颗严格约束在八面体内部的确定性点云。
   *
   * 【为何必须是确定性】若用 Math.random()，每次挂载/热更新都会得到不同星图，
   * 破坏"同一颗晶体"的稳定观感，也让截图/断言无法复现。
   * 这里用固定种子的线性同余发生器（LCG）：
   *   seed = (seed · 1664525 + 1013904223) mod 2^32
   * 序列完全可复现，且分布足够随机。
   *
   * 【正八面体约束】取三分量在 [-1,1] 的均匀样本，若满足
   *   |x| + |y / OCTA_SCALE_Y| + |z| ≤ CONSTELLATION_RADIUS
   * 则收下；否则整体缩放将该点投影回八面体内部。
   * 这种"拒绝采样 + 投影"既保证严格在内，又不会在棱边堆积。
   *
   * 【密度向内集中】最后把每个点乘 0.75 次幂的径向压缩系数
   * （见下面 radiusScale），让中心致密、边缘稀疏 → 真星云形态。
   */
  const constellationGeometry = useMemo((): THREE.BufferGeometry => {
    const positions = new Float32Array(CONSTELLATION_COUNT * 3);
    const sizes = new Float32Array(CONSTELLATION_COUNT);
    const phases = new Float32Array(CONSTELLATION_COUNT);

    let seed = 20240816;
    const nextRandom = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let i = 0; i < CONSTELLATION_COUNT; i++) {
      /* 采样三分量并投影回八面体内部 */
      let x = nextRandom() * 2 - 1;
      let y = nextRandom() * 2 - 1;
      let z = nextRandom() * 2 - 1;
      const l1 = Math.abs(x) + Math.abs(y / OCTA_SCALE_Y) + Math.abs(z);
      if (l1 > 1e-4) {
        /* 把 L1 范数归一化到 [0.15, 1] 的球壳内：0.15 避免全部堆在原点 */
        const target = 0.15 + nextRandom() * 0.85;
        const scale = (target * CONSTELLATION_RADIUS) / l1;
        x *= scale;
        y *= scale;
        z *= scale;
      }

      /* 径向压缩：u^0.75 让中心更密（星云形态） */
      const norm = Math.sqrt(x * x + y * y + z * z);
      if (norm > 1e-4) {
        const compressed = Math.pow(norm / CONSTELLATION_RADIUS, 0.75) * CONSTELLATION_RADIUS;
        const k = compressed / norm;
        x *= k;
        y *= k;
        z *= k;
      }

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      sizes[i] = CONSTELLATION_SIZES[i % CONSTELLATION_SIZES.length];
      phases[i] = nextRandom() * Math.PI * 2;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    return geometry;
  }, []);

  /**
   * 内部神经晶格连线几何 —— 28 对关键节点 + 6 个外顶点。
   *
   * 【设计意图】参考图里晶核内部不是散点，而是**点与点之间还有细线相连**，
   * 像星座/神经元。没有连线时 360 颗粒子只是"发光的灰尘"；
   * 有了连线，它们才组成一个"有结构的星系"。
   *
   * 【实现】从点云里按固定步长挑 28 对（保证跨区域、不扎堆），
   * 再把八面体 6 个顶点各连一条到点云中相邻的节点。
   * 全部写入一个 LineSegments 几何 → 1 次 Draw Call。
   */
  const neuralGeometry = useMemo((): THREE.BufferGeometry => {
    const source = constellationGeometry.getAttribute('position') as THREE.BufferAttribute;
    const vertices: number[] = [];

    /* 28 对内部连线：用互质步长跳跃选取，避免连线集中在同一簇 */
    for (let p = 0; p < NEURAL_PAIR_COUNT; p++) {
      const a = (p * 37) % CONSTELLATION_COUNT;
      const b = (p * 91 + 13) % CONSTELLATION_COUNT;
      if (a === b) continue;
      vertices.push(source.getX(a), source.getY(a), source.getZ(a));
      vertices.push(source.getX(b), source.getY(b), source.getZ(b));
    }

    /* 6 个外顶点 → 点云节点的辐条 */
    const anchors: ReadonlyArray<readonly [number, number]> = [
      [CONSTELLATION_RADIUS, 0],
      [-CONSTELLATION_RADIUS, 0],
      [0, CONSTELLATION_RADIUS * OCTA_SCALE_Y],
      [0, -CONSTELLATION_RADIUS * OCTA_SCALE_Y],
      [0, 0],
      [0, 0],
    ];
    for (let a = 0; a < anchors.length; a++) {
      const target = (a * 59) % CONSTELLATION_COUNT;
      const ax = a < 2 ? anchors[a][0] : 0;
      const ay = a >= 2 && a < 4 ? anchors[a][1] : 0;
      const az = a >= 4 ? (a === 4 ? CONSTELLATION_RADIUS : -CONSTELLATION_RADIUS) : 0;
      vertices.push(ax, ay, az);
      vertices.push(source.getX(target), source.getY(target), source.getZ(target));
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    return geometry;
  }, [constellationGeometry]);

  /**
   * 八面体 6 顶点星芒锚点的实例矩阵（模块级常量推导，挂载时写一次）。
   *
   * 顶点位置：±X、±Y（按 OCTA_SCALE_Y 拉伸）、±Z。
   * 用 Object3D 复合矩阵再 clone——创建期一次，不在 useFrame 内。
   */
  const vertexAnchorMatrices = useMemo((): ReadonlyArray<THREE.Matrix4> => {
    const list: THREE.Matrix4[] = [];
    const temp = new THREE.Object3D();
    const positions: ReadonlyArray<readonly [number, number, number]> = [
      [OCTA_RADIUS, 0, 0],
      [-OCTA_RADIUS, 0, 0],
      [0, OCTA_RADIUS * OCTA_SCALE_Y, 0],
      [0, -OCTA_RADIUS * OCTA_SCALE_Y, 0],
      [0, 0, OCTA_RADIUS],
      [0, 0, -OCTA_RADIUS],
    ];
    for (const p of positions) {
      temp.position.set(p[0], p[1], p[2]);
      temp.updateMatrix();
      list.push(temp.matrix.clone());
    }
    return list;
  }, []);

  /** 写入顶点星芒实例矩阵（挂载一次） */
  useEffect((): void => {
    const mesh = vertexAnchorRef.current;
    if (mesh === null) return;
    for (let i = 0; i < vertexAnchorMatrices.length; i++) {
      mesh.setMatrixAt(i, vertexAnchorMatrices[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [vertexAnchorMatrices]);

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
  useFrame((state, delta): void => {
    const t = state.clock.getElapsedTime();

    /** 星云粒子与光柱的时间/脉动驱动（原地写 uniform，零分配） */
    constellationUniforms.uTime.value = t;

    /* ---- 赤道环 / 斜交极轨环自转（三种角速度，形成球壳经纬差速） ---- */
    if (equatorRef.current !== null) {
      equatorRef.current.rotation.z = t * EQUATOR_SPIN_RATE;
    }
    const polars = polarRingRefs.current;
    for (let i = 0; i < POLAR_RINGS.length; i++) {
      const ring = polars[i];
      if (ring !== null && ring !== undefined) {
        ring.rotation.z = t * POLAR_RINGS[i].spin;
      }
    }

    /* ==================================================================
     * 集群健康度 → 色温平滑联动
     *
     * 【核心数学】帧率无关指数阻尼：α = 1 − e^(−k·Δt)
     *   healthColorCurrent.lerp(healthTargetColor, α)
     * 单一持久色统一插值后**广播**给两处材质：
     *   · 星云粒子 uniform uColor（内圈色调）
     *   · 神经连线 material.color
     * 因此两者的变色永远同步，不会出现"粒子先黄、连线后黄"的割裂。
     *
     * 【零分配】healthColorCurrent 是 useMemo 预分配的 Color，
     * lerp 原地突变；uniform 的 .value 已是 Color 实例，copy 原地写入。
     * ================================================================== */
    const clampedDelta = Math.min(delta, 0.1);
    const toneAlpha = 1 - Math.exp(-TONE_LERP_RATE * clampedDelta);
    healthColorCurrent.lerp(healthTargetColor, toneAlpha);

    (constellationUniforms.uColor.value as THREE.Color).copy(healthColorCurrent);

    const neural = neuralRef.current;
    if (neural !== null) {
      const neuralMaterial = neural.material;
      if (neuralMaterial instanceof THREE.LineBasicMaterial) {
        neuralMaterial.color.copy(healthColorCurrent);
      }
    }

    /* 星云整体随晶体缓慢自转（比外壳更慢，形成内外差速观感） */
    if (constellationRef.current !== null) {
      constellationRef.current.rotation.y = t * CONSTELLATION_SPIN_RATE;
    }
    if (neuralRef.current !== null) {
      neuralRef.current.rotation.y = t * CONSTELLATION_SPIN_RATE;
    }

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

    /* ==================================================================
     * 本轮新增特效的动画驱动
     *
     * 【零分配纪律】以下全部只写已有的 .rotation / .scale / uniform .value，
     * 不 new 任何 THREE 对象，符合 AGENTS.md 第 3 条。
     * ================================================================== */

    /* ---- 二十面体测地线内胆：反向慢速自转 + 极轻微滚转 ---- */
    if (icosaCoreRef.current !== null) {
      icosaCoreRef.current.rotation.y = t * ICOSA_CORE_SPIN_RATE;
      icosaCoreRef.current.rotation.x = Math.sin(t * 0.21) * 0.14;
    }

    /* ---- 双向正交刻度星轨环：各自绕法线自转，方向相反形成正交差速 ---- */
    if (gimbalRingARef.current !== null) {
      gimbalRingARef.current.rotation.z = t * GIMBAL_RING_A_SPIN;
    }
    if (gimbalRingBRef.current !== null) {
      gimbalRingBRef.current.rotation.z = t * GIMBAL_RING_B_SPIN;
    }

    /* ---- 顶点电光锚点：呼吸脉动（lio 缩放 + 材质自发光） ---- */
    if (vertexAnchorRef.current !== null) {
      const anchorBreath = VERTEX_ANCHOR_BASE_SCALE + 0.16 * Math.sin(t * VERTEX_ANCHOR_BREATH_RATE);
      vertexAnchorRef.current.scale.setScalar(anchorBreath);
      /*
       * 【为何在 useFrame 里改材质而不改实例矩阵】
       * 锚点需要"整体同步呼吸"——若逐实例写矩阵，就要 6 次 setMatrixAt
       * 加一次 needsUpdate，而整体 scale 只需一次 .scale.setScalar()，
       * 矩阵由 GPU 在渲染时自动合成。后者快一个数量级。
       */
      const anchorMaterial = vertexAnchorRef.current.material;
      if (anchorMaterial instanceof THREE.MeshBasicMaterial) {
        anchorMaterial.opacity = 0.72 + 0.28 * Math.sin(t * VERTEX_ANCHOR_BREATH_RATE);
      }
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
        {/*
         * 【通透暗晶外壳】opacity 0.025 + color #022c43（深海墨青）。
         *
         * 旧版是 opacity 0.12~0.22 的亮青加色面片——多层晶面叠加后亮度
         * 持续累积，配合 Bloom 就糊成一团浅蓝棉花糖。
         * 新版把面片压到**几乎不可见**（0.025）并改用普通混合，
         * 晶面只暗示体积边界，全部结构信息交给棱线与内部星云。
         */}
        <meshBasicMaterial
          color="#022c43"
          transparent
          opacity={emphasized ? 0.045 : 0.025}
          side={THREE.DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
        {/* 外层主棱线：亮白 #f0f9ff —— 整颗晶体最锐利的轮廓 */}
        <Edges scale={1.002} threshold={15} color={emphasized ? '#ffffff' : '#f0f9ff'} />
        {/* 内嵌青色副棱线：略内缩，与外层白棱构成"双线描边"的精密感 */}
        <Edges scale={0.996} threshold={15} color="#38bdf8" />
      </mesh>

      {/*
       * ═══ 第 1b 层：八面体 6 个顶点的高光菱形星芒锚点 ═══
       *
       * 【为何需要】通透化之后，八面体尖端是两个面交汇的尖角，
       * 在深空背景上容易"飞掉"（读者找不到轮廓终点）。
       * 在 6 个顶点各钉一枚微型高光锚点，轮廓立刻被锚定，
       * 同时产生参考图那种顶点迸光的精致感。
       *
       * 【几何】八面体顶点位于 (±r,0,0)/(0,±r,0)/(0,0,±r)；
       * 外层施加 scaleY=1.22，故上下顶点需按同一比例缩放 Y。
       * 单实例网格 → 6 个锚点仅 1 次 Draw Call。
       */}
      <instancedMesh
        ref={vertexAnchorRef}
        args={[undefined, undefined, OCTA_VERTEX_COUNT]}
        frustumCulled={false}
        raycast={(): void => undefined}
      >
        <octahedronGeometry args={[0.055, 0]} />
        <meshBasicMaterial
          color="#f0f9ff"
          toneMapped={false}
          transparent
          opacity={0.95}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </instancedMesh>

      {/*
       * ═══ 第 1c 层：二十面体测地线量子内胆（Geodesic Icosahedron Quantum Core）═══
       *
       * 【为何再加一层】中央区域此前只有"八面体外壳 + 八面体内核"两层，
       * 都是 8 面体（12 条棱），结构信息量偏低——远看就是一个菱形套菱形。
       * 插入一层二十面体（20 面、30 条棱）后，中央形成
       * 「八面体(8面) → 二十面体(20面) → 内核」的复杂度递进，
       * 正是好莱坞科幻片里"量子核心"那种高密几何感。
       *
       * 【为何用 LineSegments + WireframeGeometry 而非 wireframe 材质】
       * 与项目既有的八面体棱线一致：wireframe 会在每个三角面上画出
       * 内部对角线（测地线细分后三角形很多，对角线会糊成一片），
       * 而 WireframeGeometry 只提取真实棱边，线条干净。
       *
       * 【半径 0.86】八面体内切球 = 1.68/√3 ≈ 0.97，取 0.86 留安全余量，
       * 保证内胆完全被外壳包裹、任何角度都不会穿出晶面。
       */}
      <lineSegments ref={icosaCoreRef} geometry={icosaCoreGeometry} raycast={(): void => undefined}>
        <lineBasicMaterial
          color="#7dd3fc"
          transparent
          opacity={emphasized ? 0.72 : 0.42}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>

      {/*
       * ═══ 第 1d 层：双向正交精密刻度星轨环（Orthogonal Gimbal Rings）═══
       *
       * 【结构】两圈半径相同的刻度环，分别绕 X 轴与 Z 轴倾斜 90°，
       * 因此二者正交、互不共面——这是"万向节（gimbal）"的经典形态。
       *
       * 【为何要刻度齿】纯圆环只是"一个圈"，没有仪器感。
       * 沿环周均布 36 道极短径向刻线（10° 一格）后，
       * 立刻读作"精密测量仪器的度盘"，与中央量子核心的科技感呼应。
       *
       * 【两环反向自转】A 环 0.31 rad/s、B 环 −0.24 rad/s，
       * 在正交平面上反向旋转会产生持续变化的交叉点位置，
       * 这是机械陀螺仪最迷人的视觉特征。
       */}
      <group ref={gimbalRingARef} rotation={[Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        {/* 环本体：极细圆环 */}
        <mesh raycast={(): void => undefined}>
          <torusGeometry args={[GIMBAL_RING_RADIUS, 0.004, 6, 96]} />
          <meshBasicMaterial
            color="#a5f3fc"
            transparent
            opacity={emphasized ? 0.85 : 0.5}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        {/*
         * 36 道刻度齿（InstancedMesh 合并为 1 次 Draw Call）。
         * 逐齿矩阵已在挂载 effect 中写入，此处只声明几何与材质。
         * 【base color 必须 #ffffff】AGENTS.md 第 7 条：InstancedMesh 动态
         * 着色时基础材质需为白色，实际色由 instanceColor 或材质自发光决定。
         * 本处不使用 instanceColor，故直接用材质色表现青色。
         */}
        <instancedMesh
          ref={gimbalTicksARef}
          args={[undefined, undefined, GIMBAL_TICK_COUNT]}
          raycast={(): void => undefined}
          frustumCulled={false}
        >
          <boxGeometry args={[GIMBAL_TICK_LENGTH_A, 0.006, 0.006]} />
          <meshBasicMaterial
            color="#67e8f9"
            transparent
            opacity={emphasized ? 0.8 : 0.42}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </instancedMesh>
      </group>

      {/* B 环：绕 Z 轴倾斜 90°，与 A 环正交 */}
      <group ref={gimbalRingBRef} rotation={[0, Math.PI / 2, 0]} raycast={(): void => undefined}>
        <mesh raycast={(): void => undefined}>
          <torusGeometry args={[GIMBAL_RING_RADIUS, 0.0035, 6, 96]} />
          <meshBasicMaterial
            color="#cffafe"
            transparent
            opacity={emphasized ? 0.7 : 0.38}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <instancedMesh
          ref={gimbalTicksBRef}
          args={[undefined, undefined, GIMBAL_TICK_COUNT]}
          raycast={(): void => undefined}
          frustumCulled={false}
        >
          <boxGeometry args={[GIMBAL_TICK_LENGTH_B, 0.005, 0.005]} />
          <meshBasicMaterial
            color="#a5f3fc"
            transparent
            opacity={emphasized ? 0.65 : 0.34}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </instancedMesh>
      </group>

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
       *
       * 【本轮通透化】面片 opacity 0.22 → **0.04**：内层不再是"发光的面"，
       * 而是略带体积暗示的暗面 + 亮青色线框（#22d3ee / 0.55）。
       * 内外因此是「白棱外框 + 青棱内框」的几何套嵌，
       * 而不是两块叠在一起发光的塑料。
       */}
      <mesh ref={coreRef}>
        <octahedronGeometry args={[CORE_CRYSTAL_RADIUS, 0]} />
        <meshBasicMaterial
          color="#022c43"
          transparent
          opacity={emphasized ? 0.07 : 0.04}
          side={THREE.DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
        <Edges scale={1.002} threshold={15} color="#22d3ee" transparent opacity={0.55} />
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
          defines={KV_DEBUG_NAN_DEFINES}
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
      {/* 旧的 scale 5.4 / opacity 0.85 大面积柔光已收敛，见下方星核辉光 */}

      {/*
       * ═══ 第 2b 层：内部星云星座粒子群（360 颗，单次 Draw Call）═══
       *
       * 【整颗晶体的灵魂】通透外壳之后，八面体内部必须有"内容"：
       * 360 颗严格约束在八面体体积内的粒子，越靠中心越密，
       * 由自定义 shader 绘制成圆形径向高斯星芒点（绝非方形像素块）。
       *
       * 【为何用 points 而非 InstancedMesh】星星是"光"不是"物"：
       * Points + 自定义点精灵可逐粒子控制粒径与闪烁相位；
       * InstancedMesh 画小球需要更多三角面，且没有 gl_PointCoord 的柔边。
       */}
      <points
        ref={constellationRef}
        geometry={constellationGeometry}
        raycast={(): void => undefined}
      >
        <shaderMaterial
          defines={KV_DEBUG_NAN_DEFINES}
          uniforms={constellationUniforms}
          vertexShader={CONSTELLATION_VERTEX_SHADER}
          fragmentShader={CONSTELLATION_FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>

      {/*
       * ═══ 第 2c 层：内部神经晶格连线（28 对节点 + 6 顶点辐条）═══
       *
       * 【为何要连线】没有连线时 360 颗粒子只是"发光的灰尘"；
       * 有了点与点的细线，它们才组成"有结构的星系"——
       * 这正是参考图晶核内部繁复璀璨的星座纹理。
       * WebGL 线宽上限为 1px，因此靠低透明度 + 加色叠加取胜。
       */}
      <lineSegments ref={neuralRef} geometry={neuralGeometry} raycast={(): void => undefined}>
        <lineBasicMaterial
          color="#38bdf8"
          transparent
          opacity={0.28}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </lineSegments>

      {/*
       * ═══ 程序化星核辉光（本轮收敛）═══
       *
       * 旧配置 scale 5.4 / opacity 0.85 的大面积柔光，叠在八面体上再经 Bloom
       * 放大，整颗晶体被糊成浅蓝棉花糖。现在只保留一枚紧凑锐利的星核辉光
       * （2.15 / 0.62）：它的职责是给中心白炽点一层薄光晕，而非覆盖整颗晶体。
       */}
      {/* R25：7 层封闭光学结构（替代 godray / pillar / flare） */}
      <CrystalOptics />

      <GlowHalo3D color={GLOW_CYAN} scale={2.15} opacity={0.62} falloff={2.6} pulse pulsePeriod={2.6} />

      {/*
       * ═══ 中心紧凑高光星核点（0.16 纯白球）═══
       *
       * 很小但极亮：它是整颗晶体的"瞳孔"。
       * 与等离子 shader、星核辉光合成「白点 → 青晕 → 暗晶外壳」三级亮度，
       * 而不是旧版那种"整块都在发光"的均质白团。
       */}
      <mesh raycast={(): void => undefined}>
        <sphereGeometry args={[NUCLEUS_RADIUS, 24, 24]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </mesh>

      {/*
       * ═══ 第 2e 层：赤道光环 + 两道斜交极轨细环 ═══
       *
       * 【为何需要】上方是通透的暗晶外壳 + 内部星云，下方是地面刻度环，
       * 但晶体**腰部是空的**——缺少一圈把"上下"接起来的水平结构。
       * 补上赤道环（1.88）后，晶体立刻有了"星体的赤道"。
       *
       * 【三道环的层次】赤道环最亮最明确（opacity 0.5）；两道极轨 0.22，
       * 倾角 π/2±0.42、互不共面。三者叠加形成三维球壳骨架，
       * 视觉上从"几圈线"升级为"有经纬的星体"。
       *
       * 【零分配】useFrame 只写各自的 rotation.z，不触碰几何或材质。
       */}
      <mesh ref={equatorRef} rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[EQUATOR_RADIUS, EQUATOR_RADIUS + EQUATOR_THICKNESS, 128]} />
        <meshBasicMaterial
          color={GLOW_CYAN}
          transparent
          opacity={emphasized ? 0.7 : 0.5}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {POLAR_RINGS.map((polar, index): ReactNode => (
        <mesh
          key={polar.key}
          ref={(node): void => {
            polarRingRefs.current[index] = node;
          }}
          rotation={[polar.tilt[0], polar.tilt[1], polar.tilt[2]]}
          raycast={(): void => undefined}
        >
          <ringGeometry args={[POLAR_RING_RADIUS, POLAR_RING_RADIUS + POLAR_RING_THICKNESS, 128]} />
          <meshBasicMaterial
            color={GLOW_PALE}
            transparent
            opacity={0.22}
            side={THREE.DoubleSide}
            toneMapped={false}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      ))}

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
       * 【位置自愈】详见 LABEL_POSITION 常量注释：旧的 [0, 0.42, 2.25]
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
        {/*
         * ---- 光学玻璃拟态控制平面铭牌（本轮重构）----
         *
         * 【废除闭合边框】上一版是 `border border-cyan-400/35` 的完整闭合框 +
         * `bg-slate-950/90` 近不透明深底，观感是"贴在场景上的一块黑牌"。
         * 本版改为与机架铭牌统一的光学玻璃语言：
         *   · 基底 `bg-slate-950/50 kv-blur-panel`——半通透，
         *     背后的墨色晶体与光纤总线仍隐约可见；
         *   · 无闭合边，结构由上下 1px 折射亮边 + 四角发光靶标表达；
         *   · 斜向折射高光 + 顶部毫米微标尺，把面板从"标题牌"升级为"仪表台"。
         */}
        <div className="relative flex flex-col items-center gap-1 overflow-hidden whitespace-nowrap bg-slate-950/50 px-3 py-1 kv-blur-panel">
          <HoloSpecularSheen />
          <HoloRefractionEdges accent="#22d3ee" />
          <HoloCorners color="#22d3ee" />

          {/*
           * ── 顶部毫米级微标尺 ──
           * 上一版的"七道渐变刻度"是纯装饰，没有读数语义。
           * 换成 HoloMicroRuler 后，刻度长短交替 + 游标三角 + 等宽编号，
           * 读者会本能地把它当作"量程"，这是展陈级仪表的通用语言。
           */}
          <HoloMicroRuler
            label="SYS // CONTROL-PLANE"
            accent="#22d3ee"
            tickCount={28}
            cursorAt={0.62}
            className="w-full"
          />
          {/*
           * ── 左右对称水平发光翼线 ──
           * 从标题两侧向外延伸的细横线，是 HUD 铭牌的"翼展"：
           * 它把孤立的文字锚进视野，暗示这是一块被标定的系统面板。
           *
           * 说明：原先紧邻其上还有一条「顶部 1px 渐变青色扫描高光」，
           * 它的职责已由 HoloRefractionEdges 统一接管（上沿折射亮边），
           * 两条叠在一起会形成双亮线，反而削弱玻璃质感，故移除。
           */}
          <span
            aria-hidden
            className="block h-px w-full"
            style={{
              background:
                'linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.85) 30%, rgba(165,243,252,0.95) 50%, rgba(34,211,238,0.85) 70%, transparent 100%)',
            }}
          />
          {/*
           * ── 系统标识行 ──
           * 左侧七道发光刻度（中间高），后接 SYS.CORE 标识，
           * 像仪器面板上的量程标记。
           */}
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.32em] text-cyan-400/60">
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
           * 对称斜切括弧把标题"夹"起来，是 HUD 表达"该对象处于系统焦点"的标准手法。
           */}
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="block h-3 w-[6px] border-l border-t border-cyan-300/70"
              style={{ borderTopWidth: '1px', transform: 'skewX(-18deg)' }}
            />
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_6px_#22d3ee] animate-glow-pulse" />
              <span className="text-[11px] font-semibold tracking-wider text-cyan-50 drop-shadow-[0_0_8px_rgba(34,211,238,0.8)]">
                控制平面 · API-SERVER
              </span>
            </span>
            <span
              aria-hidden
              className="block h-3 w-[6px] border-r border-t border-cyan-300/70"
              style={{ borderTopWidth: '1px', transform: 'skewX(18deg)' }}
            />
          </span>

          {/* ── 底部：缓慢呼吸的能量基线 ── */}
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