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
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

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
 * 【取值依据】0.16 是在深黑背景上"能看见但不抢戏"的临界点：
 * 低于 0.10 在普通显示器上几乎看不出流动感，高于 0.20 会明显压过前景发光体。
 */
const RAIN_MAX_OPACITY = 0.16;

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
 * 数字矩阵雨的片元着色器。
 *
 * 【核心数学】
 * 1. **列轨划分**：`col = floor(vUv.x * 96)` 把环向切成 96 列；
 *    列内再留 64% 的有效宽度（`colMask`），列之间因此有真实的间隙，
 *    不会糊成一片连续的光墙。
 *
 * 2. **伪随机哈希**：`hash(n) = fract(sin(n) · 43758.5453)` 是图形学经典的
 *    确定性噪声：同一输入恒得同一输出（可复现），且分布足够散。
 *    每列用 `hash(col)` 取速度、`hash(col + 7.0)` 取相位，
 *    因此 96 列的流动节奏互不同步——同步下落会立刻暴露"这是程序生成"。
 *
 * 3. **光滴形态（头部亮 + 尾部指数衰减）**：
 *    `dist = fract(head − y)` 是该格到"列头"的距离；
 *    `trail = exp(−dist · 6.0)` 让亮度随距离指数衰减 —— 头部最亮、
 *    往下迅速变暗，这正是矩阵雨中"光滴拖尾"的形态。
 *
 * 4. **格子断续**：`lit = step(0.72, hash(...))` 只点亮约 28% 的格子，
 *    再叠加字符高度 `glyph`（格内 0.25~0.85 才有内容），
 *    于是每一列都是断断续续的字符碎片，而不是一条连续亮带。
 *
 * 5. **上下边缘渐隐**：`edgeFade` 在 vUv.y < 0.18 与 > 0.85 处平滑归零，
 *    光幕与天空、地面之间没有硬边——这是"融入深空"而非"贴了一张图"的关键。
 *
 * 6. **配色**：主体在青绿 `#10b981` 与青蓝 `#22d3ee` 之间按列哈希取色，
 *    头部向近白 `#e0fffa` 靠拢，形成参考图那种冷冽的数字流光。
 */
const RAIN_FRAGMENT_SHADER = `
uniform float uTime;
uniform float uOpacity;

varying vec2 vUv;

const float PI2 = 6.28318530718;

/* 图形学经典哈希：输入相同 → 输出恒定，分布均匀 */
float hash(float n) {
  return fract(sin(n) * 43758.5453123);
}

void main() {
  /* ---- 列轨 ---- */
  float columns = 96.0;
  float col = floor(vUv.x * columns);
  float localX = fract(vUv.x * columns);
  float colMask = step(0.18, localX) * step(localX, 0.82);

  /* ---- 列参数：速度与相位逐列不同 ---- */
  float speed = 0.55 + hash(col) * 0.95;
  float offset = hash(col + 7.0);

  /* ---- 格子与字符高度 ---- */
  float rows = 44.0;
  float cell = floor(vUv.y * rows);
  float localY = fract(vUv.y * rows);
  float glyph = step(0.25, localY) * step(localY, 0.85);

  /* ---- 点亮概率：约 28% 的格子有内容 ---- */
  float lit = step(0.72, hash(col * 13.0 + cell * 7.0 + offset));

  /* ---- 光滴：头部亮、尾部指数衰减 ---- */
  float head = fract(offset + uTime * speed * 0.14);
  float dist = fract(head - vUv.y + 1.0);
  float trail = exp(-dist * 6.0);

  /* ---- 上下边缘渐隐 ---- */
  float edgeFade = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y));

  /* ---- 合成 ---- */
  float alpha = lit * (0.35 + 0.65 * trail) * colMask * glyph * edgeFade * uOpacity;

  vec3 bodyColor = mix(vec3(0.063, 0.725, 0.506), vec3(0.133, 0.827, 0.933), hash(col + 3.0));
  vec3 headColor = vec3(0.878, 0.996, 0.980);
  vec3 color = mix(bodyColor, headColor, trail * 0.65);

  gl_FragColor = vec4(color, alpha);
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

  useFrame((state): void => {
    uniforms.uTime.value = state.clock.getElapsedTime();
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