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
 *        edge = max(1e-4, 1 - r)
 *        smoothEdge = edge²（数学等价于整数次幂，改用乘法）
 *        outerBloom = exp(-r² · uFalloff·1.6) · smoothEdge
 *      指数高斯保证中心亮、外围平滑收敛；edge² 让边界在 r→1 时
 *      以零斜率落地，彻底消除「圆盘贴纸」那种可见的硬圆边。
 *      R59：r ≥ 1 直接返回透明，四角不再执行可能产生 NaN 的指数运算。
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
import { withNanGuard } from '@/utils/glslNanGuard';

/**
 * 光晕面片允许的最大直径（世界单位）。
 *
 * 【R59 说明】任务描述里的 HALO_PLANE_SIZE = 7.2 在当前仓库不存在（grep 0 处）：
 * 本组件实际是「1×1 基准面片 + 调用方 scale」（唯一调用点 MasterNode3D 传 2.15），
 * 不存在固定 7.2 的几何常量。这里新增 5.6 作为**上限护栏**并使用
 * Math.min(scale, HALO_PLANE_SIZE)，保持现有 2.15 外观不变，同时阻止
 * 未来传入过大 scale 导致光晕覆盖半个屏幕、叠加 Bloom 后过曝。
 */
const HALO_PLANE_SIZE = 5.6;

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
  varying float vFogDepth;
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

/**
 * 片元着色器：双层高斯 —— 外层柔光 + 中心白炽核。
 *
 * 【为何 r ≥ 1 直接返回透明】
 * PlaneGeometry 的 UV 在四角为 (0,0)/(1,1)，映射到 [-1,1]² 后四角长度
 * 达 √2 > 1。旧实现先 discard、再对 r>1 执行 pow(max(0.0, 1.0-r), 1.8)：
 * 四角处底数为 0，GLSL 的 pow(0, y) 属未定义行为（exp2(y·log2(0)) 会得到
 * -Inf/NaN），在屏幕中央叠加 Bloom 后放大成黑块。
 * 现在 r ≥ 1 时直接写透明并 return，既保留"只有圆形光斑参与混合"的语义，
 * 又从源头阻止四角执行任何指数运算。
 *
 * 【输出约定】片元返回**预乘 alpha** 颜色，与材质的 premultipliedAlpha
 * 标记配套（详见文件头渲染契约）。
 */
const FRAGMENT_SHADER = withNanGuard(/* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uFalloff;
  uniform float uFogFar;
  varying vec2 vUv;
  varying float vFogDepth;

  void main() {
    /* 把 [0,1]² 的 UV 映射到以中心为原点的 [-1,1]² 坐标 */
    vec2 centered = vUv * 2.0 - 1.0;
    float r = length(centered);

    /* R59：r ≥ 1（四角/圆外）直接输出透明并返回，避免 0 的幂运算未定义 */
    if (r >= 1.0) {
      gl_FragColor = clamp(vec4(0.0), 0.0, 1.0);
      return;
    }

    /* ── 1. 外层柔光：指数高斯 × 平滑落地边缘 ──
       指数项负责「中心亮、外围暗」的高斯衰减；
       (1-r)^2 负责让 r→1 时衰减到零且斜率平缓，消除硬圆边。
       R59：用乘法代替整数次幂——数学等价，且避免部分驱动/ANGLE 上的
       精度与 NaN 风险（lint-glsl 亦禁止整数次幂）。 */
    float edge = max(1.0e-4, 1.0 - r);
    float smoothEdge = edge * edge;
    float outerBloom = exp(-r * r * (uFalloff * 1.6)) * smoothEdge;

    /* ── 2. 中心白炽核：更陡峭的高斯，模拟光源本体过曝 ──
       18.0 是收敛常数，使得 r≈0.35 处已衰减到约 11%，
       即白核只占面片中心约三分之一半径。 */
    float whiteCore = exp(-r * r * 18.0) * 0.85;

    /* ── 3. 色相插值：中心趋向纯白，外围保留目标色 ──
       用 whiteCore 作为混合因子，天然产生「白炽中心 → 主题色外晕」。 */
    vec3 finalColor = mix(uColor, vec3(1.0, 1.0, 1.0), clamp(whiteCore, 0.0, 1.0));

    /* ── 4. 合成 alpha：R59 下调权重（白核 0.55 / 柔光 0.22），避免中心白斑过曝 ── */
    float alpha = clamp((whiteCore * 0.55 + outerBloom * 0.22) * uOpacity, 0.0, 1.0);

    /* 预乘 alpha 输出（rgb 已乘 alpha），配合 premultipliedAlpha 标记 */
  /* L9：自定义着色器雾衰减（uFogFar=64 与线性雾远端一致；edge0<edge1 满足 R01） */
  float kvFog = 1.0 - smoothstep(0.75 * uFogFar, uFogFar, vFogDepth);
    gl_FragColor = vec4(clamp(finalColor * alpha, 0.0, 8.0) * kvFog, clamp(alpha, 0.0, 1.0) * kvFog);
    /* R59：NaN/±Infinity/负值守卫由 withNanGuard 注入到 main 末尾（无条件生效） */
  }
`);

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
   * 有效直径：保留调用方 scale 语义，同时用 HALO_PLANE_SIZE 做上限护栏。
   * 当前唯一调用点传 2.15，不受影响；未来误传大值时不会覆盖半屏。
   */
  const effectiveScale = Math.min(scale, HALO_PLANE_SIZE);

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
      uFogFar: { value: 64 },
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
      <mesh raycast={noRaycast} scale={effectiveScale}>
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