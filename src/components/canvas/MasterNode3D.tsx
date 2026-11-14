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

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Edges, Html, type EdgesRef } from '@react-three/drei';
import * as THREE from 'three';

import {
  CAMERA_MOTION,
  REDUCED_MOTION_AMPLITUDE,
  computeHoverAlpha,
  isReducedMotion,
} from '@/constants/motion';
import { PALETTE } from '@/constants/palette';
import { recordDebugHoverSample, recordDebugHoverStart } from '@/utils/cameraDebugBridge';
import { scheduleSelectionFlight } from '@/utils/canvasClickIntent';

import { useClusterStore } from '@/store/useClusterStore';
import { MASTER_ENTITY_ID } from '@/types/canvas';
import { MASTER_POSITION } from '@/utils/spatialLayout';
import GlowHalo3D from '@/components/canvas/GlowHalo3D';
import { HUD_LABEL_SPEC, applyHtmlFogAttenuation, createHtmlFogStyleCache } from '@/constants/hud';
import type { SelectedEntityType } from '@/types/store';
import { KV_DEBUG_NAN_DEFINES, withNanGuard } from '@/utils/glslNanGuard';
import { mergeStaticBoxes } from '@/utils/mergeStaticGeometries';

/* ========================================================================== */
/* 模型几何常量（模块级，集中定义防漂移）                                          */
/* ========================================================================== */

/** 外层八面体半径（调度扫描包络） */
const OCTA_RADIUS = 1.68;

/** 外层纵向拉伸比：水晶略瘦高，比正球体更具「晶体」而非「球」的轮廓 */
const OCTA_SCALE_Y = 1.22;

/** 八面体顶点数（6 个：±X / ±Y / ±Z 各一对） */
const OCTA_VERTEX_COUNT = 6;

/** 中心白炽星核球半径（紧凑锐利，收敛自旧版 0.36 的"大棉花球"） */

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

/* R67：零向量安全归一化，避免 normalize(0) 产生 NaN 传入片元 */
vec3 safeNormalize(vec3 v, vec3 fallback) {
  float lenSq = dot(v, v);
  return lenSq > 1.0e-8 ? v * inversesqrt(lenSq) : fallback;
}

void main() {
  vViewNormal = safeNormalize(normalMatrix * normal, vec3(0.0, 0.0, 1.0));
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

/* R61：零向量安全归一化，避免 normalize(0) = 0 * inversesqrt(0) = NaN */
vec3 safeNormalize(vec3 v, vec3 fallback) {
  float lenSq = dot(v, v);
  return lenSq > 1.0e-8 ? v * inversesqrt(lenSq) : fallback;
}

void main() {
  vec3 n = safeNormalize(vViewNormal, vec3(0.0, 0.0, 1.0));
  vec3 v = safeNormalize(vViewPosition, vec3(0.0, 0.0, 1.0));
  /* 下界 1e-4：pow(viewDot, 2.2) 永远不会收到 0.0 底数 */
  float viewDot = clamp(dot(n, v), 1.0e-4, 1.0);

  float core = pow(max(viewDot, 1.0e-4), 3.2);
  float corona = pow(max(viewDot, 1.0e-4), 1.35);

  vec3 color = mix(uDeepColor, uCoronaColor, corona);
  color = mix(color, uCoreColor, core);

  float alpha = corona * uPulse;
  alpha *= smoothstep(0.0, 0.02, viewDot);

  gl_FragColor = vec4(clamp(color, 0.0, 8.0), clamp(alpha, 0.0, 0.88));
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

/**
 * 外层八面体半透明菲涅尔晶壳顶点着色器（Part 1 · 替代 transmission={0.72}）。
 */
const CRYSTAL_SHELL_VERTEX_SHADER = `
varying vec3 vViewNormal;
varying vec3 vViewPosition;

/* 零向量安全归一化：八面体 sharp normal 或掠射视角防 normalize(0)=NaN */
vec3 safeNormalize(vec3 v, vec3 fallback) {
  float lenSq = dot(v, v);
  return lenSq > 1.0e-8 ? v * inversesqrt(lenSq) : fallback;
}

void main() {
  vViewNormal = safeNormalize(normalMatrix * normal, vec3(0.0, 0.0, 1.0));
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * 外层八面体半透明菲涅尔晶壳片元着色器 —— 替代 meshPhysicalMaterial transmission（Part 1）。
 *
 * 【设计意图】（性能 + 光学双收益）
 * 原 meshPhysicalMaterial transmission={0.72} 会迫使 Three.js 为主相机与 T3 真反射虚拟相机
 * 各执行一次 _transmissionRenderTarget 全场景重绘（每相机 Pass 约 +64 Draw Call，双 Pass 约 +128）。
 * 本着色器以单次透明绘制计算视空间 DoubleSide Fresnel：中心低雾度通透露出内部星云与热核，
 * 掠射晶面轮廓聚集青蓝边缘高光，同时 100% 保留 T3 MeshReflectorMaterial 真实镜面反射。
 */
const CRYSTAL_SHELL_FRAGMENT_SHADER = withNanGuard(`
uniform vec3 uBaseColor;
uniform vec3 uEmissiveColor;
uniform vec3 uRimColor;
uniform float uBaseAlpha;
uniform float uEmphasis;

varying vec3 vViewNormal;
varying vec3 vViewPosition;

vec3 safeNormalize(vec3 v, vec3 fallback) {
  float lenSq = dot(v, v);
  return lenSq > 1.0e-8 ? v * inversesqrt(lenSq) : fallback;
}

void main() {
  vec3 n = safeNormalize(vViewNormal, vec3(0.0, 0.0, 1.0));
  vec3 v = safeNormalize(vViewPosition, vec3(0.0, 0.0, 1.0));
  /* DoubleSide 晶壳正反面均参与光学边缘高光，abs(dot) 保证正反连续 */
  float facing = clamp(abs(dot(n, v)), 0.0, 1.0);
  /* 为什么指数取 2.4（Part 1）：高于 2.0 使正面中心保持通透、边缘高光收敛为纤细玻璃折射带 */
  float fresnel = pow(max(1.0 - facing, 1.0e-4), 2.4);
  float edgeSheen = smoothstep(0.08, 0.92, fresnel);
  float emphasisGain = clamp(uEmphasis, 0.0, 1.0);

  vec3 tint = mix(uBaseColor, uEmissiveColor, 0.42 + 0.36 * fresnel);
  vec3 color = tint * (0.48 + 0.24 * emphasisGain) + uRimColor * edgeSheen * (0.95 + 0.40 * emphasisGain);
  float alpha = uBaseAlpha + fresnel * 0.26 + emphasisGain * 0.07;

  gl_FragColor = vec4(clamp(color, 0.0, 2.4), clamp(alpha, 0.06, 0.56));
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
`);

/** 外层正向自转角速度（rad/s）：约 25 秒/圈，从容的全局扫描节奏 */
const OUTER_SPIN_RATE = 0.25;


/** 内层反向自转角速度（rad/s）：与外层不同速比，产生持续变化的视差层次 */
const INNER_SPIN_RATE = -0.38;

/** 内核呼吸角频率（rad/s）：≈2.85 秒/次心跳 */
const BREATH_RATE = 2.2;

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
 * 内胆自转角速度（rad/s，反向且明显慢于内核）。
 *
 * 【为何要"慢"】内胆是背景层的结构装饰，它的作用是让中央区域
 * 在静置时也有细微变化。若与外层同速或更快，会与八面体线框
 * 争夺视觉焦点，反而显得杂乱。取 OUTER_SPIN_RATE 的 0.7 倍反向。
 */
const ICOSA_CORE_SPIN_RATE = -0.17;

/** 星轨环的刻度齿数量（双向各 36 齿 = 10° 一格，精密仪器感） */
const GIMBAL_TICK_COUNT = 36;

/** 星轨环自转角速度：两环反向，形成正交差速 */
const GIMBAL_RING_A_SPIN = 0.31;
const GIMBAL_RING_B_SPIN = -0.24;

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
 * 24 根径向刻度齿静态合批几何（模块加载期合并一次，24 Draw Calls → 1）。
 * 材质与局部坐标同原实现完全一致，且自动计算完整包围球（无需 frustumCulled=false）。
 */
const RING_TICKS_GEOMETRY: THREE.BufferGeometry = mergeStaticBoxes(
  RING_TICKS.map((tick) => ({
    size: [0.05, 0.022, 0.34] as const,
    position: tick.position,
    rotation: [0, tick.rotationY, 0] as const,
  })),
);

/**
 * 铭牌的局部坐标（R67 / R6-1）。
 *
 * 晶核正下方居中：世界坐标约 [0, 0.54, 1.48]，屏幕投影约 (48.5%, 62.7%)，
 * 与中心 ±5% 区域保持充足留白，零文字覆盖晶核与屏心。
 */
const LABEL_POSITION: readonly [number, number, number] = [0, -1.96, 1.48];
/** Master 全息铭牌世界坐标常量（useFrame 吃雾计算零分配直读） */
const MASTER_HUD_WORLD_POS: readonly [number, number, number] = [
  MASTER_POSITION[0] + LABEL_POSITION[0],
  MASTER_POSITION[1] + LABEL_POSITION[1],
  MASTER_POSITION[2] + LABEL_POSITION[2],
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
  const gl = useThree((s): THREE.WebGLRenderer => s.gl);

  /* ---- Store 细粒度订阅 ---- */
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );

  /* ---- R7 瞬态交互引用（悬停/按压零 setState） ---- */
  const hoveredRef = useRef<boolean>(false);
  const hoverAmountRef = useRef<number>(0);
  const pressedRef = useRef<boolean>(false);

  /* ---- 动画通道 ref（useFrame 内原地突变） ---- */
  const floatGroupRef = useRef<THREE.Group>(null);
  const outerRef = useRef<THREE.Mesh>(null);
  const outerMatRef = useRef<THREE.ShaderMaterial>(null);
  const outerEdgesRef = useRef<EdgesRef | null>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const coreMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const coreEdgesRef = useRef<EdgesRef | null>(null);
  const selectionRingRef = useRef<THREE.Mesh>(null);
  const pulseRingRef = useRef<THREE.Mesh>(null);
  const pulseRingMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const ringGroupRef = useRef<THREE.Group>(null);
  const masterHudRef = useRef<HTMLDivElement>(null);
  const masterFogCache = useMemo(() => createHtmlFogStyleCache(), []);
  const equatorRingMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const innerRingMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const ringTicksMatRef = useRef<THREE.MeshBasicMaterial>(null);

  /**
   * 外层菲涅尔晶壳 uniforms（useMemo 预分配，useFrame 原地突变 uEmphasis）。
   */
  const crystalUniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uBaseColor: { value: new THREE.Color('#06b6d4') },
      uEmissiveColor: { value: new THREE.Color('#0891b2') },
      uRimColor: { value: new THREE.Color('#67e8f9') },
      /* 为什么是 0.14（Part 1）：中心保留微弱青色通透感而不糊内核星云，边缘 Fresnel 叠至 0.40+ */
      uBaseAlpha: { value: 0.14 },
      uEmphasis: { value: 0 },
    }),
    [],
  );

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
  const icosaCoreRef = useRef<THREE.Mesh>(null);
  const icosaCoreMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const plasmaMatRef = useRef<THREE.ShaderMaterial>(null);
  const constellationMatRef = useRef<THREE.PointsMaterial>(null);
  const neuralMatRef = useRef<THREE.LineBasicMaterial>(null);
  const gyroMatRefs = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const gimbalTicksAMatRef = useRef<THREE.LineBasicMaterial>(null);
  const gimbalTicksBMatRef = useRef<THREE.LineBasicMaterial>(null);
  const vertexAnchorMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const beamMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const equatorRingRef = useRef<THREE.Mesh>(null);
  const polarRingRef = useRef<THREE.Mesh | null>(null);
  const tickRingMatRef = useRef<THREE.MeshBasicMaterial>(null);

  /** 双向正交刻度星轨环 A（绕 X 轴倾斜）ref */
  const gimbalRingARef = useRef<THREE.Group>(null);
  /** 双向正交刻度星轨环 B（绕 Z 轴倾斜，与 A 正交）ref */
  const gimbalRingBRef = useRef<THREE.Group>(null);

  /** 八面体顶点电光锚点实例网格 ref（呼吸辉光由材质 emissive 驱动） */
  const vertexAnchorRef = useRef<THREE.InstancedMesh>(null);

  /** 星轨环 A 的刻度线几何 ref（LineSegments，36 条短刻线 → 1 次 draw call） */
  const gimbalTicksARef = useRef<THREE.LineSegments>(null);
  /** 星轨环 B 的刻度线几何 ref */
  const gimbalTicksBRef = useRef<THREE.LineSegments>(null);

  /**
   * 双正交万向节刻度线几何（R67）。
   *
   * 72 条短刻线写入一个 LineSegments 几何，两环共享同一份顶点缓冲：
   * 环 A / 环 B 各自放在自己的 group 里旋转，几何本身零每帧修改。
   * 半径 1.76，刻度沿径向向外 0.055 / 0.042 —— 与规范中的
   * torusGeometry(1.76, 0.008) 环体保持同一半径，视觉上像精密度盘。
   */
  const gimbalTickGeometry = useMemo((): THREE.BufferGeometry => {
    const vertices = new Float32Array(GIMBAL_TICK_COUNT * 2 * 3);
    for (let i = 0; i < GIMBAL_TICK_COUNT; i += 1) {
      const angle = (i / GIMBAL_TICK_COUNT) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      /* 每条刻线两个端点：环半径内侧 → 外侧 0.055 */
      vertices[i * 6] = cos * 1.76;
      vertices[i * 6 + 1] = sin * 1.76;
      vertices[i * 6 + 2] = 0;
      vertices[i * 6 + 3] = cos * (1.76 + 0.055);
      vertices[i * 6 + 4] = sin * (1.76 + 0.055);
      vertices[i * 6 + 5] = 0;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    return geometry;
  }, []);

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

  /** 环绕星火 InstancedMesh ref（R67：八面体微粒实例） */
  const sparkRef = useRef<THREE.InstancedMesh>(null);

  /**
   * 环绕星火的实例矩阵（R67：单位八面体 + 黄金角球壳分布）。
   *
   * 【零分配契约】矩阵在 useMemo 内一次算好；useFrame 只旋转整个
   * InstancedMesh（改 rotation.y / scale），不触碰实例缓冲。
   */
  const sparkMatrices = useMemo((): ReadonlyArray<THREE.Matrix4> => {
    const matrices: THREE.Matrix4[] = [];
    const temp = new THREE.Object3D();
    for (let i = 0; i < AMBIENT_SPARK_COUNT; i++) {
      const phase = AMBIENT_SPARK_PHASES[i];
      const phi = Math.acos(1 - (2 * (i + 0.5)) / AMBIENT_SPARK_COUNT);
      const radius = AMBIENT_SPARK_RADIUS * (0.75 + 0.25 * Math.sin(phase));
      temp.position.set(
        radius * Math.sin(phi) * Math.cos(phase),
        radius * Math.cos(phi) * 0.55,
        radius * Math.sin(phi) * Math.sin(phase),
      );
      temp.scale.setScalar(0.035);
      temp.updateMatrix();
      matrices.push(temp.matrix.clone());
    }
    return matrices;
  }, []);

  /** 写入星火实例矩阵（挂载一次） */
  useEffect((): void => {
    const mesh = sparkRef.current;
    if (mesh === null) return;
    for (let i = 0; i < sparkMatrices.length; i++) {
      mesh.setMatrixAt(i, sparkMatrices[i]);
    }
    mesh.count = sparkMatrices.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [sparkMatrices]);

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
      /* R67：几何改为单位八面体（args 1），用实例矩阵缩到 0.055 的微缩锚点 */
      temp.scale.setScalar(0.055);
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

  const applyMasterHighlightImmediate = useCallback(
    (hoverFraction: number, isPressedNow: boolean): void => {
      const emphasis = isSelected ? 1 : Math.max(hoverFraction, isPressedNow ? 1 : 0);
      crystalUniforms.uEmphasis.value = emphasis;
      if (equatorRingMatRef.current !== null) {
        equatorRingMatRef.current.opacity = 0.5 + 0.2 * emphasis;
      }
      if (tickRingMatRef.current !== null) {
        tickRingMatRef.current.opacity = 0.5 + 0.35 * emphasis;
      }
      if (innerRingMatRef.current !== null) {
        innerRingMatRef.current.opacity = 0.38 + 0.32 * emphasis;
      }
      if (ringTicksMatRef.current !== null) {
        ringTicksMatRef.current.opacity = 0.42 + 0.33 * emphasis;
      }
      if (outerEdgesRef.current !== null) {
        outerEdgesRef.current.material.opacity = isPressedNow ? 1.0 : 0.72 + 0.28 * emphasis;
        outerEdgesRef.current.material.linewidth = isPressedNow ? 1.0 : 1.2 + 0.5 * emphasis;
      }
      if (coreEdgesRef.current !== null) {
        coreEdgesRef.current.material.opacity = isPressedNow ? 1.0 : 0.65 + 0.35 * emphasis;
        coreEdgesRef.current.material.linewidth = isPressedNow ? 1.0 : 1.0 + 0.4 * emphasis;
      }
    },
    [isSelected, crystalUniforms],
  );

  useEffect((): (() => void) => {
    const clearPressed = (): void => {
      if (!pressedRef.current) return;
      pressedRef.current = false;
      applyMasterHighlightImmediate(hoverAmountRef.current, false);
    };
    window.addEventListener('pointerup', clearPressed);
    window.addEventListener('pointercancel', clearPressed);
    return (): void => {
      window.removeEventListener('pointerup', clearPressed);
      window.removeEventListener('pointercancel', clearPressed);
    };
  }, [applyMasterHighlightImmediate]);

  const handleMasterClick = useCallback(
    (event: ThreeEvent<MouseEvent>): void => {
      if (event.delta >= CAMERA_MOTION.dblClickMaxMovePx) return;
      event.stopPropagation();
      scheduleSelectionFlight(() => selectEntity(MASTER_ENTITY_ID, 'master'));
    },
    [selectEntity],
  );

  const handleMasterPointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>): void => {
      if (event.button !== 0) return;
      event.stopPropagation();
      pressedRef.current = true;
      applyMasterHighlightImmediate(hoverAmountRef.current, true);
    },
    [applyMasterHighlightImmediate],
  );

  const handleMasterPointerUp = useCallback((): void => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    applyMasterHighlightImmediate(hoverAmountRef.current, false);
  }, [applyMasterHighlightImmediate]);

  const handleMasterPointerOver = useCallback(
    (event: ThreeEvent<PointerEvent>): void => {
      event.stopPropagation();
      if (!hoveredRef.current) {
        hoveredRef.current = true;
        hoverAmountRef.current = Math.max(hoverAmountRef.current, CAMERA_MOTION.hoverInstantJump);
        gl.domElement.style.cursor = 'pointer';
        applyMasterHighlightImmediate(hoverAmountRef.current, pressedRef.current);
        recordDebugHoverStart(MASTER_ENTITY_ID, 'master', hoverAmountRef.current, 1);
      }
    },
    [gl, applyMasterHighlightImmediate],
  );

  const handleMasterPointerOut = useCallback((): void => {
    if (!hoveredRef.current) return;
    hoveredRef.current = false;
    gl.domElement.style.cursor = 'auto';
  }, [gl]);

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
    if (equatorRingRef.current !== null) {
      equatorRingRef.current.rotation.z = t * EQUATOR_SPIN_RATE;
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

    /* R67：粒子/连线改用内置材质后，直接写 material.color（零分配） */
    if (constellationMatRef.current !== null) {
      constellationMatRef.current.color.copy(healthColorCurrent);
    }
    if (neuralMatRef.current !== null) {
      neuralMatRef.current.color.copy(healthColorCurrent);
    }

    /* 星云整体随晶体缓慢自转（比外壳更慢，形成内外差速观感） */
    if (constellationRef.current !== null) {
      constellationRef.current.rotation.y = t * CONSTELLATION_SPIN_RATE;
    }
    if (neuralRef.current !== null) {
      neuralRef.current.rotation.y = t * CONSTELLATION_SPIN_RATE;
    }

    /* 外层水晶壳：正向自转 + 正弦倾角摆动 + R7 零帧瞬时高光与 1-exp(-16*dt) 收敛 */
    const clampedDtForCrystal = Math.min(delta, 0.1);
    const motionScale = isReducedMotion() ? REDUCED_MOTION_AMPLITUDE : 1;
    const hoverTarget = hoveredRef.current ? 1 : 0;
    hoverAmountRef.current += (hoverTarget - hoverAmountRef.current) * computeHoverAlpha(clampedDtForCrystal);
    if (hoveredRef.current) {
      recordDebugHoverSample(MASTER_ENTITY_ID, hoverAmountRef.current);
    }
    const emphasis = isSelected ? 1 : Math.max(hoverAmountRef.current, pressedRef.current ? 1 : 0);
    crystalUniforms.uEmphasis.value = emphasis;

    if (equatorRingMatRef.current !== null) {
      equatorRingMatRef.current.opacity = 0.5 + 0.2 * emphasis;
    }
    if (tickRingMatRef.current !== null) {
      tickRingMatRef.current.opacity = 0.5 + 0.35 * emphasis;
    }
    if (innerRingMatRef.current !== null) {
      innerRingMatRef.current.opacity = 0.38 + 0.32 * emphasis;
    }
    if (ringTicksMatRef.current !== null) {
      ringTicksMatRef.current.opacity = 0.42 + 0.33 * emphasis;
    }
    if (outerEdgesRef.current !== null) {
      outerEdgesRef.current.material.opacity = pressedRef.current ? 1.0 : 0.72 + 0.28 * emphasis;
      outerEdgesRef.current.material.linewidth = pressedRef.current ? 1.0 : 1.2 + 0.5 * emphasis;
    }
    if (coreEdgesRef.current !== null) {
      coreEdgesRef.current.material.opacity = pressedRef.current ? 1.0 : 0.65 + 0.35 * emphasis;
      coreEdgesRef.current.material.linewidth = pressedRef.current ? 1.0 : 1.0 + 0.4 * emphasis;
    }

    if (outerRef.current !== null) {
      outerRef.current.rotation.y = t * OUTER_SPIN_RATE;
      outerRef.current.rotation.x = Math.sin(t * 0.4) * 0.18 * motionScale;
    }
    /* 内层晶核：反向自转 + 余弦滚转（仪差机械感）+ 呼吸缩放 */
    if (coreRef.current !== null) {
      coreRef.current.rotation.y = t * INNER_SPIN_RATE;
      coreRef.current.rotation.z = Math.cos(t * 0.32) * 0.22 * motionScale;
      const breath = 1 + BREATH_AMPLITUDE * motionScale * Math.sin(t * BREATH_RATE);
      /* R67：JSX 的基础缩放为 0.78，呼吸必须相对基础缩放，不能把它覆盖掉 */
      coreRef.current.scale.setScalar(0.78 * breath);
    }
    /* 等离子星核脉动（reduced-motion 时幅度 ×0.25） */
    plasmaUniforms.uPulse.value = 1 + 0.18 * motionScale * Math.sin(t * BREATH_RATE + Math.PI / 4);

    /* 底部全息圆环：缓慢自转（刻度扫过 = 控制面巡检隐喻） */
    if (ringGroupRef.current !== null) {
      ringGroupRef.current.rotation.y = t * RING_SPIN_RATE;
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
      const sparkBreath = 1 + 0.06 * motionScale * Math.sin(t * 1.7);
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
      icosaCoreRef.current.rotation.x = Math.sin(t * 0.21) * 0.14 * motionScale;
    }

    /* ---- 双向正交刻度星轨环：各自绕法线自转，方向相反形成正交差速 ---- */
    if (gimbalRingARef.current !== null) {
      gimbalRingARef.current.rotation.z = t * GIMBAL_RING_A_SPIN;
    }
    if (gimbalRingBRef.current !== null) {
      gimbalRingBRef.current.rotation.z = t * GIMBAL_RING_B_SPIN;
    }

    /* ---- 顶点电光锚点：呼吸脉动（缩放 + 材质自发光，reduced-motion ×0.25） ---- */
    if (vertexAnchorRef.current !== null) {
      const anchorBreath =
        VERTEX_ANCHOR_BASE_SCALE + 0.16 * motionScale * Math.sin(t * VERTEX_ANCHOR_BREATH_RATE);
      vertexAnchorRef.current.scale.setScalar(anchorBreath);
      const anchorMaterial = vertexAnchorRef.current.material;
      if (anchorMaterial instanceof THREE.MeshBasicMaterial) {
        anchorMaterial.opacity = 0.72 + 0.28 * motionScale * Math.sin(t * VERTEX_ANCHOR_BREATH_RATE);
      }
    }

    /* ---- R67：浮游组呼吸、选中锁定框、点击脉冲波纹、底部光柱呼吸 ---- */
    if (floatGroupRef.current !== null) {
      floatGroupRef.current.position.y = Math.sin(t * 0.8) * 0.04 * motionScale;
    }
    if (selectionRingRef.current !== null) {
      selectionRingRef.current.rotation.z = t * 0.35;
    }
    if (pulseRingRef.current !== null && pulseRingMatRef.current !== null) {
      /* 2.2s 一圈的向外扩散：scale 1→2.8，alpha 0.36→0；reduced-motion 时幅值缩至 25% */
      const cycle = (t * 0.45) % 1;
      pulseRingRef.current.scale.setScalar(1 + cycle * 1.8 * motionScale);
      pulseRingMatRef.current.opacity = (1 - cycle) * 0.36 * motionScale;
    }
    if (beamMatRef.current !== null) {
      beamMatRef.current.opacity = 0.32 + 0.04 * motionScale * Math.sin(t * 1.6);
    }

    /* R6-3：Master 铭牌距离吃雾 + 透视缩放护栏驱动（useFrame 零分配 / 零 setState） */
    applyHtmlFogAttenuation(
      masterHudRef.current,
      state.camera.position,
      MASTER_HUD_WORLD_POS[0],
      MASTER_HUD_WORLD_POS[1],
      MASTER_HUD_WORLD_POS[2],
      masterFogCache,
      HUD_LABEL_SPEC.MASTER_LABEL,
      state.camera instanceof THREE.PerspectiveCamera ? state.camera.fov : 45,
    );

  });

  return (
    <group
      position={MASTER_POSITION}
      onClick={handleMasterClick}
      onPointerDown={handleMasterPointerDown}
      onPointerUp={handleMasterPointerUp}
      onPointerOver={handleMasterPointerOver}
      onPointerOut={handleMasterPointerOut}
    >
      {/*
       * ═══ R67：多层全息晶核（由内到外 8 层 + 底部光柱/环）═══
       *
       * 【重构说明】移除 CrystalOptics 后，Master 中央重新由本文件承担全部
       * 几何层次：选中锁定框、脉冲波纹、八面体晶壳、反向晶核、二十面体内胆、
       * 等离子热核、星座点云/神经连线、三轴陀螺环、双正交万向节、顶点锚点、
       * 环绕星火。全部挂载在 floatGroupRef 下，由 useFrame 统一驱动。
       */}
      <group ref={floatGroupRef}>
        {/* ---- 选中态：外扩六边形锁定框 ---- */}
        {isSelected ? (
          <mesh ref={selectionRingRef} rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
            <ringGeometry args={[2.05, 2.12, 6]} />
            <meshBasicMaterial
              color="#22d3ee"
              transparent
              opacity={0.7}
              side={THREE.DoubleSide}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        ) : null}

        {/* ---- 点击/选中脉冲波纹：useFrame 驱动 scale 与 opacity ---- */}
        <mesh ref={pulseRingRef} rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
          <ringGeometry args={[1.0, 1.08, 64]} />
          <meshBasicMaterial
            ref={pulseRingMatRef}
            color="#22d3ee"
            transparent
            opacity={0}
            side={THREE.DoubleSide}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>

        {/* ---- 第 1 层：外层八面体半透明全息晶壳 + 发光棱线 ---- */}
        <mesh
          ref={outerRef}
          onClick={handleMasterClick}
          onPointerDown={handleMasterPointerDown}
          onPointerUp={handleMasterPointerUp}
          onPointerOver={handleMasterPointerOver}
          onPointerOut={handleMasterPointerOut}
        >
          <octahedronGeometry args={[1.45, 0]} />
          <shaderMaterial
            ref={outerMatRef}
            defines={KV_DEBUG_NAN_DEFINES}
            uniforms={crystalUniforms}
            vertexShader={CRYSTAL_SHELL_VERTEX_SHADER}
            fragmentShader={CRYSTAL_SHELL_FRAGMENT_SHADER}
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
          <Edges ref={outerEdgesRef} scale={1.002} threshold={1} color="#67e8f9" transparent opacity={0.72} />
        </mesh>

        {/* ---- 第 2 层：内层反向旋转八面体晶核 + 高亮棱线 ---- */}
        <mesh ref={coreRef} scale={0.78}>
          <octahedronGeometry args={[1.05, 0]} />
          <meshStandardMaterial
            ref={coreMatRef}
            color="#22d3ee"
            emissive="#06b6d4"
            emissiveIntensity={1.2}
            wireframe={false}
            transparent
            opacity={0.42}
            roughness={0.2}
            metalness={0.3}
            depthWrite={false}
            toneMapped={false}
          />
          <Edges ref={coreEdgesRef} scale={1.003} threshold={1} color="#a5f3fc" transparent opacity={0.65} />
        </mesh>

        {/* ---- 第 3 层：80 面二十面体测地线高密线框内胆 ---- */}
        <mesh ref={icosaCoreRef}>
          <icosahedronGeometry args={[0.72, 1]} />
          <meshBasicMaterial
            ref={icosaCoreMatRef}
            color="#67e8f9"
            wireframe
            transparent
            opacity={0.32}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>

        {/* ---- 第 4 层：中心热核等离子体球 ---- */}
        <mesh raycast={(): void => undefined}>
          <sphereGeometry args={[0.42, 32, 32]} />
          <shaderMaterial
            ref={plasmaMatRef}
            defines={KV_DEBUG_NAN_DEFINES}
            uniforms={plasmaUniforms}
            vertexShader={PLASMA_VERTEX_SHADER}
            fragmentShader={PLASMA_FRAGMENT_SHADER}
            transparent
            depthWrite={false}
            blending={THREE.NormalBlending}
            toneMapped={false}
          />
        </mesh>

        {/* ---- 第 5a 层：360 颗微缩星座点云 ---- */}
        <points ref={constellationRef} geometry={constellationGeometry} raycast={(): void => undefined}>
          <pointsMaterial
            ref={constellationMatRef}
            color="#a5f3fc"
            size={0.032}
            sizeAttenuation
            transparent
            opacity={0.78}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </points>

        {/* ---- 第 5b 层：28 条神经网络拓扑连线 ---- */}
        <lineSegments ref={neuralRef} geometry={neuralGeometry} raycast={(): void => undefined}>
          <lineBasicMaterial
            ref={neuralMatRef}
            color="#22d3ee"
            transparent
            opacity={0.38}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </lineSegments>

        {/* ---- 第 6 层：三轴正交陀螺仪能量环 ---- */}
        {[0, 1, 2].map((idx: number): ReactNode => (
          <mesh
            key={`gyro-${idx}`}
            ref={(el): void => {
              gyroRefs.current[idx] = el;
            }}
            rotation={[GYRO_RINGS[idx].tilt[0], GYRO_RINGS[idx].tilt[1], GYRO_RINGS[idx].tilt[2]]}
            raycast={(): void => undefined}
          >
            <torusGeometry args={[1.55 + idx * 0.14, 0.012, 16, 96]} />
            <meshBasicMaterial
              ref={(el): void => {
                gyroMatRefs.current[idx] = el;
              }}
              color="#22d3ee"
              transparent
              opacity={0.48}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        ))}

        {/* ---- 第 7 层：双正交 72 刻度精密万向节环 ---- */}
        <group ref={gimbalRingARef} rotation={[Math.PI / 3, 0, 0]}>
          <lineSegments ref={gimbalTicksARef} geometry={gimbalTickGeometry} raycast={(): void => undefined}>
            <lineBasicMaterial
              ref={gimbalTicksAMatRef}
              color="#22d3ee"
              transparent
              opacity={0.42}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </lineSegments>
          <mesh raycast={(): void => undefined}>
            <torusGeometry args={[1.76, 0.008, 12, 96]} />
            <meshBasicMaterial
              color="#67e8f9"
              transparent
              opacity={0.35}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        </group>
        <group ref={gimbalRingBRef} rotation={[-Math.PI / 3, Math.PI / 4, 0]}>
          <lineSegments ref={gimbalTicksBRef} geometry={gimbalTickGeometry} raycast={(): void => undefined}>
            <lineBasicMaterial
              ref={gimbalTicksBMatRef}
              color="#67e8f9"
              transparent
              opacity={0.42}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </lineSegments>
          <mesh raycast={(): void => undefined}>
            <torusGeometry args={[1.76, 0.008, 12, 96]} />
            <meshBasicMaterial
              color="#67e8f9"
              transparent
              opacity={0.35}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        </group>

        {/* ---- 第 8a 层：6 顶点微型八面体悬浮锚点 ---- */}
        <instancedMesh
          ref={vertexAnchorRef}
          args={[undefined, undefined, OCTA_VERTEX_COUNT]}
          raycast={(): void => undefined}
          frustumCulled={false}
        >
          <octahedronGeometry args={[1, 0]} />
          <meshBasicMaterial
            ref={vertexAnchorMatRef}
            color="#ffffff"
            transparent
            opacity={0.85}
            depthWrite={false}
            toneMapped={false}
          />
        </instancedMesh>

        {/* ---- 第 8b 层：环绕光尘（单位八面体实例） ---- */}
        <instancedMesh
          ref={sparkRef}
          args={[undefined, undefined, AMBIENT_SPARK_COUNT]}
          raycast={(): void => undefined}
          frustumCulled={false}
        >
          <octahedronGeometry args={[1, 0]} />
          <meshBasicMaterial
            color="#ffffff"
            transparent
            opacity={0.75}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </instancedMesh>
      </group>


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
          ref={beamMatRef}
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
       * ═══ 程序化星核辉光（本轮收敛）═══
       *
       * 旧配置 scale 5.4 / opacity 0.85 的大面积柔光，叠在八面体上再经 Bloom
       * 放大，整颗晶体被糊成浅蓝棉花糖。现在只保留一枚紧凑锐利的星核辉光
       * （2.15 / 0.62）：它的职责是给中心白炽点一层薄光晕，而非覆盖整颗晶体。
       */}
      <GlowHalo3D color={GLOW_CYAN} scale={2.15} opacity={0.62} falloff={2.6} pulse pulsePeriod={2.6} />

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
      <mesh ref={equatorRingRef} rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[EQUATOR_RADIUS, EQUATOR_RADIUS + EQUATOR_THICKNESS, 128]} />
        <meshBasicMaterial
          ref={equatorRingMatRef}
          color={GLOW_CYAN}
          transparent
          opacity={0.5}
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
            if (index === 0) polarRingRef.current = node;
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
            ref={tickRingMatRef}
            color={GLOW_CYAN}
            transparent
            opacity={0.5}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* 内轮廓环 */}
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[RING_INNER_RADIUS, RING_INNER_RADIUS + 0.03, 96]} />
          <meshBasicMaterial
            ref={innerRingMatRef}
            color={GLOW_CYAN}
            transparent
            opacity={0.38}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* 24 根径向刻度齿（模块期已通过 mergeGeometries 合批为 1 次 Draw Call） */}
        <mesh geometry={RING_TICKS_GEOMETRY}>
          <meshBasicMaterial
            ref={ringTicksMatRef}
            color={GLOW_CYAN}
            transparent
            opacity={0.42}
            toneMapped={false}
          />
        </mesh>
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
      {/* ---- 极简全息标签：R6-1 收敛为单行「控制平面 · API Server」 + R6-2 规格表 + R6-3 吃雾 ---- */}
      <Html
        position={[LABEL_POSITION[0], LABEL_POSITION[1], LABEL_POSITION[2]]}
        center
        distanceFactor={HUD_LABEL_SPEC.MASTER_LABEL.distanceFactor}
        zIndexRange={[10, 0]}
        className="pointer-events-none"
        style={{ pointerEvents: 'none' }}
      >
        {/* R6-1：为什么是单行轻量玻璃胶囊：移除原 SYS.CORE/微标尺/翼线避免中心视区杂乱抢戏 */}
        <div
          ref={masterHudRef}
          className="pointer-events-none inline-flex items-center gap-1.5 whitespace-nowrap rounded-[2px] bg-slate-950/60 px-2 py-0.5 md:px-2.5 md:py-1 kv-blur-chip"
          style={{
            boxShadow: 'inset 0 0 0 1px rgba(34,211,238,0.22)',
          }}
        >
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300 shadow-[0_0_6px_#22d3ee]"
          />
          <span
            data-kv-label="master"
            className="font-sans font-medium leading-[1.15] tracking-wide text-cyan-50 drop-shadow-[0_0_6px_rgba(34,211,238,0.55)]"
            style={{ fontSize: HUD_LABEL_SPEC.MASTER_LABEL.clampFontSize }}
          >
            控制平面<span className="hidden md:inline"> · API Server</span>
          </span>
        </div>
      </Html>
    </group>
  );
}