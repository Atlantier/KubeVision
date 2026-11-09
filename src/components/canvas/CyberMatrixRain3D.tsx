'use client';

/**
 * KubeVision AI — 远景深空「数字矩阵雨」背景光幕（CyberMatrixRain3D）
 *
 * 【解决什么问题】场景上半部此前是纯黑：三座机柜与中央晶核之上什么都没有，
 * 画面在纵深上被"截断"了。目标效果图的背景里有若隐若现的**垂直下落二进制
 * 光滴**，它提供的是"这台机器背后是一整套数据洪流"的氛围，而不是装饰。
 *
 * 【实现选择：背向圆柱面 + 程序化着色器】
 * - 用一块半径 28、高 22、中心在 [0, 8, 0] 的**圆柱内壁**（`BackSide`）作为光幕，
 *   相机永远在它内部，因此它会环绕包裹整个场景的远景天际线；
 * - 光幕内容完全由片元着色器程序化生成，零贴图、零几何细节，
 *   GPU 成本只有一次全屏级的片元计算；
 * - `AdditiveBlending` + `depthWrite={false}`：只往上加光，不遮挡任何前景物体。
 *
 * 【不透明度红线：≤ 0.16】这是本组件最重要的约束。数字雨是**氛围层**，
 * 一旦超过 0.16 就会与前景的机柜、晶核、数据星城争夺注意力，
 * 画面立刻变成"背景比主体还亮"的廉价观感。所有亮度都在着色器末端乘以
 * `uOpacity`（默认 0.16）统一封顶。
 *
 * 【60FPS 红线合规】useFrame 内只写一个 uniform 标量（uTime），
 * 无 new、无 setState、无几何/材质重写（AGENTS.md 第 3 条）。
 */

import { useFrame } from '@react-three/fiber';
import { useClusterStore } from '@/store/useClusterStore';
import { useMemo } from 'react';
import * as THREE from 'three';
import { KV_DEBUG_NAN_DEFINES } from '@/utils/glslNanGuard';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 光幕圆柱半径（远大于场景半径 9.5，确保完全包裹） */
const RAIN_RADIUS = 28;

/** 光幕高度与中心 Y：中心抬高到 8，使下缘低于地面、上缘高过机柜顶部 */
const RAIN_HEIGHT = 22;
const RAIN_CENTER_Y = 8;

/** 圆柱径向分段：48 段在远景距离下足够平滑，不会看出多边形棱角 */
const RAIN_RADIAL_SEGMENTS = 48;

/**
 * 数字雨总不透明度上限（氛围层红线）。
 *
 * 【本轮从 0.16 下调到 0.075】旧值在深黑背景上偏亮，配合 4:1 的粗砖块，
 * 整片背景像"发光的横条纹墙"而不是雨幕。改到 0.075 后它真正退回远景层：
 * 正常观看距离下只是隐约的流动纹理，凑近才看得到光丝。
 */
const RAIN_MAX_OPACITY = 0.075;

/**
 * 故障态下的不透明度提升值。
 *
 * 【为何要分态】集群进入故障时，背景雨幕略微增强 → 整屏氛围随之"变紧张"，
 * 这是不依赖任何文字的空间级状态提示。0.115 仍远低于会干扰前景的阈值。
 */
const RAIN_FAULT_OPACITY = 0.115;

/** 健康分阈值：≥90 视为健康态（与晶核色温、地面扇区共用同一口径） */
const HEALTHY_SCORE_THRESHOLD = 90;

/* ========================================================================== */
/* 着色器                                                                     */
/* ========================================================================== */

/**
 * 数字矩阵雨的顶点着色器。
 *
 * 只传递圆柱 UV：`vUv.x` 是环向（0→1 绕一圈），`vUv.y` 是纵向（0 = 底部）。
 * 环向用于划分列轨，纵向用于格子与流动相位。
 */
const RAIN_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * 数字矩阵雨的片元着色器（本轮重写）。
 *
 * 【修复的两个致命缺陷】
 * 1. **横向亮砖**：圆柱半径 28（周长 ≈ 175.9），旧 `columns = 96` 使单列宽达
 *    1.83 世界单位；而 `rows = 44` 在 22 高度上每格仅 0.5 单位。
 *    宽:高 = 3.7:1 → 每个"字符"都是一块扁平的横向砖头。
 *    本轮 `columns = 680`，单列宽 ≈ 0.26 世界单位，配合细长拖尾才是"光丝"。
 * 2. **向上逆流**：旧公式 `head = fract(offset + uTime·speed·0.14)`，
 *    随时间增大 head 增大，而 `vUv.y` 越大越靠上 → 雨滴视觉上**倒着往上飞**。
 *    本轮改为 `fract(offset − uTime·speed·0.09)`，head 递减，
 *    头部自上而下扫过 —— 这才是"坠落的雨"。
 *
 * 【拖尾方向】头部在 head，拖尾在它**上方**（雨滴从上往下掉，走过的路径留在身后），
 * 因此 `trailDist = fract(vUv.y − head)`：vUv.y 略大于 head 的位置 trailDist 小 →
 * 最亮；越往上 trailDist 越大 → 指数衰减。这正是彗尾的数学形式。
 *
 * 【纵向断点】`bitMask` 以 110 的频率在纵向上切出细密断续的二进制光点，
 * 让拖尾不是一条平滑光带，而是"数据流"的颗粒感。
 *
 * 【横向束缚】`xMask = smoothstep(0.38, 0.12, |cellUv.x − 0.5|)`：
 * 列中心 1、靠近列缘迅速归零，使每列成为一根**纤细光丝**而非填满列宽的色块。
 */
const RAIN_FRAGMENT_SHADER = `
uniform float uTime;
uniform float uOpacity;

varying vec2 vUv;

/* 图形学经典哈希：输入相同 → 输出恒定，分布均匀 */
float hash(float n) {
  return fract(sin(n) * 43758.5453123);
}

void main() {
  /* ---- 环向列轨：680 列 → 单列世界宽约 0.26（纤细分丝） ---- */
  float columns = 680.0;
  float column = floor(vUv.x * columns);
  vec2 cellUv = vec2(fract(vUv.x * columns), vUv.y);
  float columnHash = hash(column);

  /* ---- 稀疏度过滤：仅约 28% 的列活跃（保留大量空列，才有深空呼吸感）---- */
  float activeColumn = step(0.72, columnHash);
  if (activeColumn < 0.5) discard;

  /* ---- 逐列参数：速度与初始相位互不同步 ---- */
  float speed = 0.55 + hash(column + 7.0) * 0.95;
  float offset = hash(column + 3.1);

  /* ---- 坠落：head 随时间递减，自上而下扫过（修复逆流） ---- */
  float head = fract(offset - uTime * speed * 0.09);

  /* ---- 拖尾距离：head 上方（身后路径）为小值 → 最亮 ---- */
  float trailDist = fract(vUv.y - head);

  /* ---- 拖尾长度与指数衰减：头部极亮、尾部迅速消失 ---- */
  float tailLength = 0.26;
  float inTail = step(trailDist, tailLength);
  float trail = exp(-trailDist * 14.0) * inTail;

  /* ---- 纵向微脉冲数字断点：让拖尾呈颗粒状数据流而非平滑光带 ---- */
  float bitMask = step(0.28, fract(vUv.y * 110.0 + columnHash * 17.0));

  /* ---- 横向纤细束缚：列中心 1、列缘 0 → 一根细光丝 ---- */
  float xMask = 1.0 - smoothstep(0.12, 0.38, abs(cellUv.x - 0.5));

  /* ---- 环向呼吸遮罩：3 个波瓣缓慢起伏，避免整圈亮度均匀 ---- */
  float breathMask = 0.55 + 0.45 * sin(vUv.x * 6.28318 * 3.0);

  /* ---- 上下边缘渐隐：融入深空，不留接缝 ---- */
  float edgeFade = smoothstep(0.0, 0.16, vUv.y) * (1.0 - smoothstep(0.86, 1.0, vUv.y));

  /* ---- 合成 ---- */
  float alpha = trail * bitMask * xMask * breathMask * edgeFade * uOpacity;

  /* 头部青白、尾部青绿：mix 由 trail 驱动，头部最亮时接近纯白 */
  vec3 tailColor = mix(vec3(0.063, 0.725, 0.506), vec3(0.133, 0.827, 0.933), hash(column + 11.0));
  vec3 headColor = vec3(0.878, 0.996, 0.980);
  vec3 color = mix(tailColor, headColor, trail);

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

/* ========================================================================== */
/* 组件                                                                       */
/* ========================================================================== */

/**
 * CyberMatrixRain3D —— 远景深空数字矩阵雨光幕。
 *
 * 挂载于场景根，位于所有前景物体的外侧（半径 28），
 * 因此它只影响"天空"，不会与任何主体发生深度冲突。
 */
export default function CyberMatrixRain3D(): React.ReactElement {
  const uniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uTime: { value: 0 },
      uOpacity: { value: RAIN_MAX_OPACITY },
    }),
    [],
  );

  /**
   * 故障态联动：集群健康分低于 90 时雨幕略微增强。
   *
   * 【为何用健康分而不是布尔】故障是渐变的（90 → 70 → 崩溃），
   * 用分数做插值目标，雨幕强度会随告警升级而平滑加强，
   * 与晶核色温、地面扇区染红是同一套"空间级状态语言"。
   */
  const clusterHealthScore = useClusterStore((s): number => s.snapshotSummary.clusterHealthScore);

  /** 目标不透明度（渲染期按健康分选定，useFrame 只做插值） */
  const targetOpacity =
    clusterHealthScore >= HEALTHY_SCORE_THRESHOLD ? RAIN_MAX_OPACITY : RAIN_FAULT_OPACITY;

  useFrame((state, delta): void => {
    uniforms.uTime.value = state.clock.getElapsedTime();
    /*
     * 指数阻尼逼近目标不透明度：α = 1 − e^(−k·Δt)
     * 原地写 .value，零分配；故障恢复时雨幕同样平滑退回。
     */
    const clampedDelta = Math.min(delta, 0.1);
    const alpha = 1 - Math.exp(-2.2 * clampedDelta);
    const current = uniforms.uOpacity.value as number;
    uniforms.uOpacity.value = current + (targetOpacity - current) * alpha;
  });

  return (
    <mesh position={[0, RAIN_CENTER_Y, 0]} raycast={(): void => undefined}>
      {/*
       * openEnded=true：去掉圆柱上下端盖，只保留侧壁。
       * 有端盖会在天空正上方形成一块遮挡视线的圆盘。
       */}
      <cylinderGeometry
        args={[RAIN_RADIUS, RAIN_RADIUS, RAIN_HEIGHT, RAIN_RADIAL_SEGMENTS, 1, true]}
      />
      <shaderMaterial
          defines={KV_DEBUG_NAN_DEFINES}
        uniforms={uniforms}
        vertexShader={RAIN_VERTEX_SHADER}
        fragmentShader={RAIN_FRAGMENT_SHADER}
        transparent
        depthWrite={false}
        side={THREE.BackSide}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  );
}