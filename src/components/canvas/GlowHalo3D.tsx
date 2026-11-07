'use client';

/**
 * KubeVision AI — 程序化假辉光光晕（GlowHalo3D）
 *
 * 【解决什么问题】
 * 在没有后处理泛光（UnrealBloomPass）的前提下，自发光体在屏幕上只是一个
 * 「硬边亮块」——亮，但不像「在发光」。真实世界里的强光源会把光溢散到
 * 周围空气与镜头里，这层柔和的外溢才是「发光感」的真正来源。
 *
 * 【为何不引入后处理】
 * AGENTS.md 第 9 条锁定依赖世代矩阵。引入 @react-three/postprocessing 会
 * 连带触发 three/addons 与 R3F 的版本协商风险；而本场景只需要少数几处
 * 辉光，为一个点特效装配整条后处理管线并不划算。用一个 AdditiveBlending
 * 的径向渐变面片即可，成本几乎为零。
 *
 * 【核心数学：双层高斯叠加（外层柔光 + 中心白炽核）】
 * 设面片 UV 中心为原点，归一化半径 r = |vUv * 2 - 1|：
 *
 *   1. 外层柔光：
 *        smoothEdge = (1 - r)^1.8
 *        outerBloom = exp(-r² · uFalloff·1.6) · smoothEdge
 *      指数高斯保证中心亮、外围平滑收敛；再乘 (1-r)^1.8 让边界在 r→1 时
 *      以零斜率落地，彻底消除「圆盘贴纸」那种可见的硬圆边。
 *
 *   2. 中心白炽核：
 *        whiteCore = exp(-r² · 18) · 0.85
 *      更陡峭的高斯，模拟光源本体过曝成白炽的点状核心。
 *
 *   3. 色相插值：
 *        finalColor = mix(uColor, vec3(1), whiteCore)
 *      天然形成「中心纯白 → 外围目标色」的过渡，而非整片单色。
 *
 * 【为何用 Billboard】
 * 面片必须始终正对相机，否则从侧面看会退化成一条线。drei 的 <Billboard>
 * 每帧把物体朝向相机，正是所需。
 *
 * 【渲染契约（AGENTS.md 第 3 / 7 条）】
 * - AdditiveBlending：光叠加而非遮挡，符合物理发光行为；
 * - premultipliedAlpha：片元输出的是**预乘 alpha**（rgb 已乘 alpha）。
 *   开启该标记后，three 对 AdditiveBlending 采用 blendSrc = One，
 *   否则 alpha 会被二次相乘（实际效果 ≈ alpha²），导致辉光整体变暗发灰；
 * - depthWrite = false：不写深度，不遮挡其后绘制的不透明物体；
 * - toneMapped = false：绕过色调映射，保证亮部不被压暗；
 * - useFrame 内零分配：shader uniform 全部在 useMemo 中预建。
 */

import { useMemo, useRef } from 'react';
import { Billboard } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/* ========================================================================== */
/* 类型契约                                                                    */
/* ========================================================================== */

/** GlowHalo3D 的 Props */
export interface GlowHalo3DProps {
  /** 光晕主色（HEX 字符串或 CSS 颜色名） */
  readonly color: string;
  /** 面片直径（世界单位；1×1 基准面片按此值整体缩放） */
  readonly scale: number;
  /** 中心不透明度 0~1，默认 0.85 */
  readonly opacity?: number;
  /** 外层高斯收敛系数，默认 2.4（越大光晕越紧） */
  readonly falloff?: number;
  /** 是否呼吸脉动（默认 false，仅核心光晕开启） */
  readonly pulse?: boolean;
  /** 脉动周期（秒），默认 3.2 */
  readonly pulsePeriod?: number;
  /** 附加世界坐标偏移 */
  readonly position?: readonly [number, number, number];
}

/* ========================================================================== */
/* 着色器源码                                                                  */
/* ========================================================================== */

/** 顶点着色器：仅透传 UV（Billboard 已负责朝向，无需额外变换） */
const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * 片元着色器：双层高斯 —— 外层柔光 + 中心白炽核。
 *
 * 【为何要 discard 四角】
 * PlaneGeometry 的 UV 在四角为 (0,0)/(1,1)，映射到 [-1,1]² 后四角长度
 * 达 √2 > 1。若不丢弃，面片会呈现一个**方形**的弱光底噪，
 * 在暗背景上肉眼可见。r > 1 时直接 discard，保证只有圆形光斑参与混合。
 *
 * 【输出约定】片元返回**预乘 alpha** 颜色，与材质的 premultipliedAlpha
 * 标记配套（详见文件头渲染契约）。
 */
const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uFalloff;
  varying vec2 vUv;

  void main() {
    /* 把 [0,1]² 的 UV 映射到以中心为原点的 [-1,1]² 坐标 */
    vec2 centered = vUv * 2.0 - 1.0;
    float r = length(centered);

    /* 四角落在单位圆外：直接丢弃，避免方形底噪 */
    if (r > 1.0) discard;

    /* ── 1. 外层柔光：指数高斯 × 平滑落地边缘 ──
       指数项负责「中心亮、外围暗」的高斯衰减；
       (1-r)^1.8 负责让 r→1 时衰减到零且斜率平缓，消除硬圆边。 */
    float smoothEdge = pow(max(0.0, 1.0 - r), 1.8);
    float outerBloom = exp(-r * r * (uFalloff * 1.6)) * smoothEdge;

    /* ── 2. 中心白炽核：更陡峭的高斯，模拟光源本体过曝 ──
       18.0 是收敛常数，使得 r≈0.35 处已衰减到约 11%，
       即白核只占面片中心约三分之一半径。 */
    float whiteCore = exp(-r * r * 18.0) * 0.85;

    /* ── 3. 色相插值：中心趋向纯白，外围保留目标色 ──
       用 whiteCore 作为混合因子，天然产生「白炽中心 → 主题色外晕」。 */
    vec3 finalColor = mix(uColor, vec3(1.0, 1.0, 1.0), clamp(whiteCore, 0.0, 1.0));

    /* ── 4. 合成 alpha：柔光占 0.75 权重，白核占 0.9 权重 ── */
    float alpha = clamp((outerBloom * 0.75 + whiteCore * 0.9) * uOpacity, 0.0, 1.0);

    /* 预乘 alpha 输出（rgb 已乘 alpha），配合 premultipliedAlpha 标记 */
    gl_FragColor = vec4(finalColor * alpha, alpha);
  }
`;

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * GlowHalo3D —— 可复用的程序化辉光面片。
 *
 * @param props 见 GlowHalo3DProps
 */
export default function GlowHalo3D({
  color,
  scale,
  opacity = 0.85,
  falloff = 2.4,
  pulse = false,
  pulsePeriod = 3.2,
  position,
}: GlowHalo3DProps): React.ReactElement {
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  /**
   * uniform 对象必须用 useMemo 稳定引用：
   * 若每次渲染都新建 `{ uColor: { value } }`，R3F 会重建材质并丢失 uniform
   * 绑定；稳定引用后 useFrame 内直接改 `.value` 即可（零 React 参与）。
   */
  const uniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uFalloff: { value: falloff },
    }),
    [color, opacity, falloff],
  );

  /* 呼吸脉动：仅修改 uniform，不触碰几何体（零分配） */
  useFrame((state): void => {
    if (!pulse) return;
    const mat = materialRef.current;
    if (mat === null) return;
    /* sin ∈ [-1,1] → 映射到 [0.55, 1.0] 的透明度区间，避免完全熄灭 */
    const t = state.clock.elapsedTime;
    const wave = Math.sin((t / pulsePeriod) * Math.PI * 2);
    mat.uniforms.uOpacity.value = opacity * (0.775 + wave * 0.225);
  });

  /**
   * 光晕不参与射线拾取：它是纯视觉元素，若吃指针事件会挡住背后的
   * Master / Pod 点击（这是发光面片最容易踩的交互坑）。
   */
  const noRaycast = (): void => undefined;

  return (
    <Billboard position={position !== undefined ? [position[0], position[1], position[2]] : [0, 0, 0]}>
      {/*
       * 缩放直接作用在 mesh 上：Billboard 每帧只调整整棵子树的朝向四元数，
       * 不覆盖 scale，因此两者互不干扰。用 1×1 基准面片 + scale 的好处是
       * 着色器内的 UV 语义恒定（始终 [0,1]²），换任何尺寸都不需改 shader。
       */}
      <mesh raycast={noRaycast} scale={scale}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial
          ref={materialRef}
          uniforms={uniforms}
          vertexShader={VERTEX_SHADER}
          fragmentShader={FRAGMENT_SHADER}
          transparent
          premultipliedAlpha
          depthWrite={false}
          depthTest
          blending={THREE.AdditiveBlending}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </Billboard>
  );
}