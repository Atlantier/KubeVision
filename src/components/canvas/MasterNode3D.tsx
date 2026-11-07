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
  color = mix(color, vec3(0.220, 0.741, 0.973), mid); /* #38bdf8 内圈 */
  color = mix(color, vec3(1.0, 1.0, 1.0), core);    /* #ffffff 核心 */

  float flicker = 0.62 + 0.38 * sin(uTime * 2.4 + vPhase);
  float alpha = (core * 0.95 + mid * 0.55 + outer * 0.25) * flicker * uOpacity;
  alpha *= 1.0 - smoothstep(0.85, 1.0, d);

  gl_FragColor = vec4(color, alpha);
}
`;

/* -------------------------------------------------------------------------- */
/* 垂直贯穿能量光柱（Vertical Energy Pillar）                                    */
/* -------------------------------------------------------------------------- */

/** 光柱宽度（直径）与总高度：从地面雷达中心 −2.48 直达高空 +3.72 */
const PILLAR_WIDTH = 0.26;
const PILLAR_BOTTOM_Y = -2.48;
const PILLAR_TOP_Y = 3.72;
const PILLAR_HEIGHT = PILLAR_TOP_Y - PILLAR_BOTTOM_Y;
const PILLAR_CENTER_Y = (PILLAR_TOP_Y + PILLAR_BOTTOM_Y) / 2;

/**
 * 垂直光柱的着色器（顶点）。
 *
 * 传递平面 UV：`vUv.y = 0` 为底部、`= 1` 为顶部，用于纵向渐变；
 * `vUv.x` 用于横向衰减。
 */
const PILLAR_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * 垂直光柱的着色器（片元）。
 *
 * 【核心数学】两个方向上的指数衰减相乘：
 *   横向：`lx = 1 - abs(vUv.x - 0.5) * 2` → 中心 1、边缘 0，取 pow(lx, 2.2)
 *   纵向：`ly = sin(vUv.y · π)^0.65` → 两端趋 0、中段最亮
 * alpha = 横向 · 纵向 · uPulse
 *
 * 【为何纵向用 sin(π·y) 而非线性】线性渐变会让光柱在顶端/底端"截断"，
 * 出现一条硬边；sin 包络两端自然归零，光柱是"淡入淡出"的。
 * 0.65 次幂把峰值段拉宽，让中段（穿过晶核的区域）保持明亮。
 */
const PILLAR_FRAGMENT_SHADER = `
uniform float uPulse;
uniform vec3 uColor;

varying vec2 vUv;

void main() {
  float lx = 1.0 - abs(vUv.x - 0.5) * 2.0;
  float lateral = pow(max(0.0, lx), 2.2);
  float vertical = pow(max(0.0, sin(vUv.y * 3.14159265)), 0.65);

  float alpha = lateral * vertical * uPulse * 0.9;
  vec3 color = mix(uColor, vec3(1.0, 1.0, 1.0), lateral * 0.55);
  gl_FragColor = vec4(color, alpha);
}
`;

/** 星火环绕半径（控制平面外围能量场） */
const AMBIENT_SPARK_RADIUS = 2.2;

/** 环绕控制平面缓慢上升旋转的微光星火数量 */
const AMBIENT_SPARK_COUNT = 36;

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
const LABEL_POSITION: readonly [number, number, number] = [0, -2.28, 2.45];

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

  /** 八面体 6 顶点星芒锚点实例网格 ref */
  const vertexAnchorRef = useRef<THREE.InstancedMesh>(null);

  /** 星云星座粒子 Points ref */
  const constellationRef = useRef<THREE.Points>(null);
  /** 内部神经晶格连线 ref */
  const neuralRef = useRef<THREE.LineSegments>(null);
  /** 垂直贯穿能量光柱（两片正交平面的父 group）ref */
  const pillarRef = useRef<THREE.Group>(null);

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
    }),
    [],
  );

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

  /** 垂直贯穿能量光柱的 uniforms */
  const pillarUniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uPulse: { value: 1 },
      uColor: { value: new THREE.Color('#38bdf8') },
    }),
    [],
  );

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
  useFrame((state): void => {
    const t = state.clock.getElapsedTime();

    /** 星云粒子与光柱的时间/脉动驱动（原地写 uniform，零分配） */
    constellationUniforms.uTime.value = t;
    pillarUniforms.uPulse.value = 1 + 0.22 * Math.sin(t * 1.7);

    /* 星云整体随晶体缓慢自转（比外壳更慢，形成内外差速观感） */
    if (constellationRef.current !== null) {
      constellationRef.current.rotation.y = t * CONSTELLATION_SPIN_RATE;
    }
    if (neuralRef.current !== null) {
      neuralRef.current.rotation.y = t * CONSTELLATION_SPIN_RATE;
    }

    /* 垂直光柱：轻微旋转，让双平面交叉的辉光持续变化 */
    if (pillarRef.current !== null) {
      pillarRef.current.rotation.y = t * 0.22;
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
       * ═══ 第 2d 层：垂直贯穿能量光柱 ═══
       *
       * 【形态】两片正交纵向平面（交叉成十字），宽 0.26、高 6.2，
       * 从地面雷达中心 y=−2.48 一路向上穿透晶核直达高空 y=+3.72。
       *
       * 【为何交叉平面而非圆柱】圆柱从侧面看是一条实心柱；
       * 交叉平面在任意机位都能看到"光在平面上铺开"，
       * 且着色器可按 UV 做横向指数衰减——圆柱做不到"中心亮、两侧透明"。
       */}
      <group ref={pillarRef} position={[0, PILLAR_CENTER_Y, 0]}>
        {[0, 1].map((planeIndex): ReactNode => (
          <mesh
            key={`pillar-plane-${planeIndex}`}
            rotation={[0, (planeIndex * Math.PI) / 2, 0]}
            raycast={(): void => undefined}
          >
            <planeGeometry args={[PILLAR_WIDTH, PILLAR_HEIGHT]} />
            <shaderMaterial
              uniforms={pillarUniforms}
              vertexShader={PILLAR_VERTEX_SHADER}
              fragmentShader={PILLAR_FRAGMENT_SHADER}
              transparent
              depthWrite={false}
              side={THREE.DoubleSide}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>

      {/*
       * ═══ 程序化星核辉光（本轮收敛）═══
       *
       * 旧配置 scale 5.4 / opacity 0.85 的大面积柔光，叠在八面体上再经 Bloom
       * 放大，整颗晶体被糊成浅蓝棉花糖。现在只保留一枚紧凑锐利的星核辉光
       * （2.15 / 0.62）：它的职责是给中心白炽点一层薄光晕，而非覆盖整颗晶体。
       */}
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
        <div className="flex flex-col items-center gap-1 whitespace-nowrap border border-cyan-400/35 bg-slate-950/80 px-3 py-1 font-mono backdrop-blur-md">
          {/*
           * ── 左右对称水平发光翼线 ──
           * 从标题两侧向外延伸的细横线，是 HUD 铭牌的"翼展"：
           * 它把孤立的文字锚进视野，暗示这是一块被标定的系统面板。
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