'use client';

/**
 * KubeVision AI — MASTER 控制平面晶体的新光学结构（R25）
 *
 * 【本文件解决什么】旧实现用「双锥体积光柱 + 竖直光柱 + 横向镜头光晕」堆叠，
 * 能量是**向外发射**的（射向天空/贯穿画面），既不符合"能量被约束在晶体结构内"
 * 的物理直觉，也会产生延伸到地平线的亮带（地平线无法消失）。
 *
 * 新结构改成一个**封闭的能量系统**：能量在晶体内沿棱线与粒子流动，
 * 光子从棱中段"漏"出来（edge leak），而不是从顶部射向天空。
 *
 * 【7 层结构（由内向外）】
 *  1. 内核奇点 r≈0.40：二十面体 + 3 倍频 simplex 噪声流动，中心近白→电光青→深蓝
 *  2. 体积雾球 r≈0.95：BackSide + Additive，pow(dot(N,V),2.6)，替代 godray 的光感
 *  3. 晶体主体：八面体半透明折射感（法线+菲涅尔），透明度 ≤ 0.28
 *  4. 棱线两层 r=1.42/1.54 + 顶点高光点，沿边 t 的流光
 *  5. 内部星云 360 粒子，轨道 r<1.15，多轨道涡旋 + 闪烁相位差
 *  6. 外层大气光晕 r≈1.85，pow(dot(N,V),3.8)，3 道陀螺环
 *  7. 棱线漏光 uLeak：晶核脉冲时中段提亮并向两端扩散（替代顶部光柱）
 *
 * 【能量预算（alpha 上限）】内核 0.22 + 雾球 0.30 + 晶体 0.28 + 大气 0.20 +
 * 棱线/粒子/锚点/陀螺环 0.15 = **1.15**（结构上限，R13 会再调）。
 *
 * 【红线】useFrame 内零 `new THREE.*`、零 setState；所有 Color/Vector 预分配。
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import { useClusterStore } from '@/store/useClusterStore';

/**
 * detectSoftwareRenderer —— 判断当前是否软件光栅化（与 ClusterCanvas 同口径）。
 *
 * @returns 软件渲染返回 true
 */
function detectSoftwareRenderer(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl === null) return true;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info === null ? '' : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
    return /swiftshader|software|llvmpipe|mesa offscreen|basic render/i.test(name);
  } catch {
    return true;
  }
}

/**
 * resolveCrystalQuality —— 读 R10 的质量档位（URL ?quality=high|balanced|low）。
 *
 * @returns 质量档位
 */
function resolveCrystalQuality(): 'high' | 'balanced' | 'low' {
  if (typeof window === 'undefined') return 'high';
  try {
    const param = new URLSearchParams(window.location.search).get('quality');
    if (param === 'low') return 'low';
    if (param === 'balanced') return 'balanced';
  } catch {
    /* URL 解析失败按默认 high */
  }
  return 'high';
}

/* ========================================================================== */
/* 常量                                                                        */
/* ========================================================================== */

const CORE_RADIUS = 0.4;
const FOG_SPHERE_RADIUS = 0.95;
const CRYSTAL_RADIUS = 1.05;
const WIRE_INNER_RADIUS = 1.42;
const WIRE_OUTER_RADIUS = 1.54;
const ATMOSPHERE_RADIUS = 1.85;
const NEBULA_COUNT = 360;
const NEBULA_RADIUS = 1.15;
const VERTEX_SPARK_COUNT = 12;
const GYRO_RING_COUNT = 3;

/** 色温：健康 = 冰川青（#00f2fe / #38bdf8） */
const TONE_HEALTHY = new THREE.Color('#38bdf8');
const TONE_HEALTHY_CORE = new THREE.Color('#00f2fe');
/** 高负载 → 琥珀 */
const TONE_WARNING = new THREE.Color('#fbbf24');
/** 故障 → 绯红 */
const TONE_CRITICAL = new THREE.Color('#f43f5e');
/** 健康分阈值（与全局一致） */
const HEALTHY_SCORE = 90;
const WARNING_SCORE = 70;
/** 色温阻尼：常规 k=2.2；故障恢复使用 1.2s 缓动 => k≈0.83 */
const TONE_LERP_RATE = 2.2;
const RECOVERY_RATE = 1 / 1.2;

/* ========================================================================== */
/* GLSL：3D simplex 噪声（3 倍频，R01 安全：无倒置 smoothstep、全部 clamp）        */
/* ========================================================================== */

const SIMPLEX_NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/** 3 个倍频叠加：低频塑造大团流动，高频提供细节 */
float fbm3(vec3 p) {
  float value = 0.0;
  value += 0.55 * snoise(p);
  value += 0.30 * snoise(p * 2.03 + vec3(11.7, 3.1, 7.9));
  value += 0.15 * snoise(p * 4.11 + vec3(2.3, 9.4, 5.2));
  return value;
}
`;

/* ========================================================================== */
/* 着色器                                                                      */
/* ========================================================================== */

/** 1. 内核奇点：3 倍频噪声流动 + 中心白→电光青→深蓝 */
const CORE_VERTEX = /* glsl */ `
  varying vec3 vLocalPos;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    vLocalPos = position;
    vNormalView = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const CORE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uBreath;
  uniform vec3 uColorCool;
  uniform vec3 uColorHot;
  uniform vec3 uColorDeep;
  varying vec3 vLocalPos;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  ${SIMPLEX_NOISE}
  void main() {
    float flow = fbm3(vLocalPos * 3.2 + vec3(0.0, uTime * 0.45, uTime * 0.28));
    float radial = clamp(1.0 - length(vLocalPos) / 0.4, 0.0, 1.0);
    /* 中心近白 → 电光青 → 深蓝 */
    vec3 color = mix(uColorDeep, uColorCool, clamp(radial * 1.4, 0.0, 1.0));
    color = mix(color, uColorHot, clamp(radial * radial * 1.6, 0.0, 1.0));
    color *= 0.72 + 0.28 * flow;
    float fresnel = pow(clamp(dot(normalize(vNormalView), normalize(vViewDir)), 0.0, 1.0), 1.6);
    color += uColorHot * fresnel * 0.35;
    color *= uBreath;
    float alpha = clamp(0.16 + 0.10 * radial + 0.06 * abs(flow), 0.0, 0.22);
    gl_FragColor = vec4(clamp(color, 0.0, 8.0), alpha);
  }
`;

/** 2. 体积雾球：视角相关衰减，温润无棱角 */
const FOG_VERTEX = /* glsl */ `
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    vNormalView = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FOG_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uBreath;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    float facing = max(dot(normalize(vNormalView), normalize(vViewDir)), 1.0e-4);
    float alpha = pow(max(facing, 1.0e-4), 2.6) * 0.30 * uBreath;
    gl_FragColor = vec4(clamp(uColor, 0.0, 8.0), clamp(alpha, 0.0, 0.30));
  }
`;

/** 3. 晶体主体：法线 + 菲涅尔假折射（T2/T1/软渲染路径） */
const CRYSTAL_VERTEX = /* glsl */ `
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  varying vec3 vLocalPos;
  void main() {
    vLocalPos = position;
    vNormalView = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const CRYSTAL_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uTint;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  varying vec3 vLocalPos;
  void main() {
    vec3 normal = normalize(vNormalView);
    vec3 view = normalize(vViewDir);
    float facing = clamp(dot(normal, view), 0.0, 1.0);
    float fresnel = pow(max(1.0 - facing, 1.0e-4), 2.4);
    /* 假折射：法线扰动 + 视角函数，模拟内部弯折的青光 */
    vec3 refracted = refract(-view, normal, 0.74);
    float bend = clamp(length(refracted) * 1.8, 0.0, 1.0);
    vec3 color = mix(uColor, uTint, 0.35 + 0.35 * bend);
    color += uTint * fresnel * 0.9;
    /* 透明度上限 0.28：绝不遮挡内核 */
    float alpha = clamp(0.06 + fresnel * 0.22, 0.0, 0.28);
    gl_FragColor = vec4(clamp(color, 0.0, 8.0), alpha);
  }
`;

/** 4. 棱线：沿边参数 t 的流光 + uLeak 中段漏光 */
const WIRE_VERTEX = /* glsl */ `
  attribute float aT;
  varying float vT;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    vT = aT;
    vNormalView = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const WIRE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uLeak;
  uniform float uBaseAlpha;
  varying float vT;
  void main() {
    /* 沿边的流光：sin 脉冲沿 t 推进，而不是整条匀亮 */
    float flow = 0.55 + 0.45 * sin(vT * 18.0 - uTime * 2.4);
    /* 漏光：中段提亮并向两端扩散（uLeak 由晶核脉冲驱动） */
    float midDist = (vT - 0.5) / 0.22;
    float mid = exp(-(midDist * midDist));
    float leak = uLeak * mid * 1.8;
    float alpha = (uBaseAlpha * flow + leak) * (0.65 + 0.35 * flow);
    gl_FragColor = vec4(clamp(uColor * (1.0 + leak), 0.0, 8.0), clamp(alpha, 0.0, 1.0));
  }
`;

/** 5. 星云粒子：大小随距相机衰减 + 闪烁 */
const NEBULA_VERTEX = /* glsl */ `
  attribute float aPhase;
  attribute float aSize;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vTwinkle;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float twinkle = 0.45 + 0.55 * sin(uTime * 1.7 + aPhase * 6.2831);
    vTwinkle = twinkle;
    gl_PointSize = clamp(aSize * uPixelRatio * (2.2 / -mvPosition.z), 0.6, 6.0);
  }
`;

const NEBULA_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying float vTwinkle;
  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float dist = length(centered);
    if (dist > 0.5) discard;
    float falloff = 1.0 - smoothstep(0.0, 0.5, dist);
    gl_FragColor = vec4(clamp(uColor * (0.7 + 0.6 * vTwinkle), 0.0, 8.0), falloff * 0.5 * vTwinkle);
  }
`;

/** 6. 外层大气光晕：轮廓泛光 */
const ATMOSPHERE_VERTEX = /* glsl */ `
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    vNormalView = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uBreath;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    float facing = max(dot(normalize(vNormalView), normalize(vViewDir)), 1.0e-4);
    /* 只在轮廓处泛光：pow 3.8 */
    float alpha = pow(max(facing, 1.0e-4), 3.8) * 0.20 * uBreath;
    gl_FragColor = vec4(clamp(uColor, 0.0, 8.0), clamp(alpha, 0.0, 0.20));
  }
`;

/* ========================================================================== */
/* 几何构建（模块/useMemo 期一次分配）                                           */
/* ========================================================================== */

/**
 * buildWireGeometry —— 从八面体提取棱线并写入沿边参数 aT。
 *
 * 【为何不用 wireframe】wireframe 沿三角边绘制，八面体每个面由 2 个三角形
 * 组成，会在面上多画斜线；EdgesGeometry 按二面角阈值只保留真实棱。
 *
 * @param radius 棱线半径
 * @returns 带 aT 属性的 LineSegments 几何
 */
function buildWireGeometry(radius: number): THREE.BufferGeometry {
  const octa = new THREE.OctahedronGeometry(radius, 0);
  const edges = new THREE.EdgesGeometry(octa, 15);
  octa.dispose();
  const positions = edges.getAttribute('position');
  const count = positions.count;
  const t = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    t[i] = (i % 2 === 0 ? 0 : 1) + Math.floor(i / 2) * 0.13;
  }
  edges.setAttribute('aT', new THREE.BufferAttribute(t, 1));
  return edges;
}

/**
 * buildNebulaGeometry —— 内部星云（多轨道涡旋，r < 1.15）。
 *
 * @returns Points 几何（position / aPhase / aSize）
 */
function buildNebulaGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(NEBULA_COUNT * 3);
  const phases = new Float32Array(NEBULA_COUNT);
  const sizes = new Float32Array(NEBULA_COUNT);
  const golden = 2.399963229728653;
  for (let i = 0; i < NEBULA_COUNT; i += 1) {
    const arm = i % 3;
    const ratio = (i + 0.5) / NEBULA_COUNT;
    const radius = NEBULA_RADIUS * Math.pow(ratio, 0.72);
    const angle = arm * 2.0943951 + radius * 6.6 + (i % 7) * 0.09;
    const y = Math.sin(i * golden) * 0.42 * (1 - ratio * 0.6);
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(angle) * radius;
    phases[i] = (i * golden) % (Math.PI * 2);
    sizes[i] = 0.035 + (i % 5) * 0.012;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  return geometry;
}

/* ========================================================================== */
/* 组件                                                                        */
/* ========================================================================== */

/** CrystalOptics 无外部 props：颜色/呼吸均来自瞬态轨与低频 store */
export default function CrystalOptics(): React.ReactElement {
  /**
   * A3：晶体主体是否使用 MeshPhysicalMaterial 真折射。
   *
   * 【性能预算】transmission 需要额外 RT 与一次屏幕空间采样，
   * 只在 T3（high 档）且**非软件光栅化**时启用；T2/T1/软渲染
   * 一律退回自写的 Fresnel 假折射 shader（视觉近似、成本恒定）。
   */
  const usePhysicalCrystal = useMemo((): boolean => {
    return resolveCrystalQuality() === 'high' && !detectSoftwareRenderer();
  }, []);

  /** 色温当前值（预分配，useFrame 内只 lerp） */
  const toneCurrent = useMemo((): THREE.Color => new THREE.Color('#38bdf8'), []);
  /** 色温目标值（预分配，useFrame 内 copy） */
  const toneTarget = useMemo((): THREE.Color => new THREE.Color('#38bdf8'), []);
  /** 8 条棱的方向与流光泄漏强度 */
  const wireInnerRef = useRef<THREE.LineSegments>(null);
  const wireOuterRef = useRef<THREE.LineSegments>(null);
  const nebulaRef = useRef<THREE.Points>(null);
  const gyroRefs = useRef<ReadonlyArray<THREE.Mesh | null>>([]);

  /** 材质 uniforms（useMemo 稳定引用，useFrame 只改 .value） */
  const coreUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uBreath: { value: 1 },
      uColorCool: { value: new THREE.Color('#38bdf8') },
      uColorHot: { value: new THREE.Color('#f0fdff') },
      uColorDeep: { value: new THREE.Color('#0a2a4a') },
    }),
    [],
  );
  const fogUniforms = useMemo(
    () => ({ uColor: { value: new THREE.Color('#38bdf8') }, uBreath: { value: 1 } }),
    [],
  );
  const crystalUniforms = useMemo(
    () => ({ uColor: { value: new THREE.Color('#0b3b5a') }, uTint: { value: new THREE.Color('#38bdf8') } }),
    [],
  );
  const wireInnerUniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color('#38bdf8') },
      uTime: { value: 0 },
      uLeak: { value: 0 },
      uBaseAlpha: { value: 0.45 },
    }),
    [],
  );
  const wireOuterUniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color('#38bdf8') },
      uTime: { value: 0 },
      uLeak: { value: 0 },
      uBaseAlpha: { value: 0.28 },
    }),
    [],
  );
  const nebulaUniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color('#38bdf8') },
      uTime: { value: 0 },
      uPixelRatio: { value: typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio, 1.75) },
    }),
    [],
  );
  const atmosphereUniforms = useMemo(
    () => ({ uColor: { value: new THREE.Color('#22d3ee') }, uBreath: { value: 1 } }),
    [],
  );

  /** 几何预分配 */
  const wireInnerGeometry = useMemo(() => buildWireGeometry(WIRE_INNER_RADIUS), []);
  const wireOuterGeometry = useMemo(() => buildWireGeometry(WIRE_OUTER_RADIUS), []);
  const nebulaGeometry = useMemo(() => buildNebulaGeometry(), []);

  /** 顶点高光点几何：八面体 6 顶点 × 2 层 */
  const vertexSparkGeometry = useMemo((): THREE.BufferGeometry => {
    const positions = new Float32Array(VERTEX_SPARK_COUNT * 3);
    const r = WIRE_OUTER_RADIUS;
    const dirs = [
      [r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r],
      [r * 0.92, r * 0.38, 0], [-r * 0.92, -r * 0.38, 0], [0, r * 0.38, r * 0.92],
      [0, -r * 0.38, -r * 0.92], [r * 0.38, 0, -r * 0.92], [-r * 0.38, 0, r * 0.92],
    ];
    dirs.forEach((dir, index) => {
      positions[index * 3] = dir[0];
      positions[index * 3 + 1] = dir[1];
      positions[index * 3 + 2] = dir[2];
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, []);

  useFrame((state, delta): void => {
    const t = state.clock.elapsedTime;
    const dt = Math.min(delta, 0.1);

    /* ---- C. 色温目标：健康=冰川青 / 高负载=琥珀 / 故障=绯红 ---- */
    const snapshot = useClusterStore.getState().snapshotSummary;
    const health = snapshot.clusterHealthScore;
    if (health >= HEALTHY_SCORE) {
      toneTarget.copy(TONE_HEALTHY);
    } else if (health >= WARNING_SCORE) {
      toneTarget.copy(TONE_WARNING);
    } else {
      toneTarget.copy(TONE_CRITICAL);
    }
    /* 故障恢复用 1.2s 慢缓动；其余沿用常规阻尼 */
    const recovering = health >= HEALTHY_SCORE && toneCurrent.getHex() === TONE_CRITICAL.getHex();
    const rate = recovering ? RECOVERY_RATE : TONE_LERP_RATE;
    toneCurrent.lerp(toneTarget, 1 - Math.exp(-rate * dt));

    /* ---- QPS 联动呼吸（幅度 ≤ 6%） ---- */
    const qps = telemetryTransientRef.snapshot.totalQps;
    const qpsNorm = Math.min(1, Math.log10(qps + 1) / 4);
    const breath = 1 + 0.06 * qpsNorm * Math.sin(t * 2.2);
    /* 晶核脉冲 → 棱线漏光（这是替代顶部光柱的能量表达） */
    const leak = 0.25 + 0.75 * Math.max(0, Math.sin(t * 2.2));

    /* 所有 uniform 原地写值（零分配） */
    coreUniforms.uTime.value = t;
    coreUniforms.uBreath.value = breath;
    (coreUniforms.uColorCool.value as THREE.Color).copy(toneCurrent);
    (coreUniforms.uColorHot.value as THREE.Color).copy(breath > 1 ? TONE_HEALTHY_CORE : TONE_HEALTHY_CORE);
    (coreUniforms.uColorDeep.value as THREE.Color).copy(toneCurrent).multiplyScalar(0.18);
    fogUniforms.uBreath.value = breath;
    (fogUniforms.uColor.value as THREE.Color).copy(toneCurrent);
    (crystalUniforms.uTint.value as THREE.Color).copy(toneCurrent);
    (crystalUniforms.uColor.value as THREE.Color).copy(toneCurrent).multiplyScalar(0.22);
    wireInnerUniforms.uTime.value = t;
    wireInnerUniforms.uLeak.value = leak * 0.6;
    (wireInnerUniforms.uColor.value as THREE.Color).copy(toneCurrent);
    wireOuterUniforms.uTime.value = t * 0.8;
    wireOuterUniforms.uLeak.value = leak * 0.35;
    (wireOuterUniforms.uColor.value as THREE.Color).copy(toneCurrent);
    nebulaUniforms.uTime.value = t;
    (nebulaUniforms.uColor.value as THREE.Color).copy(toneCurrent);
    atmosphereUniforms.uBreath.value = breath;
    (atmosphereUniforms.uColor.value as THREE.Color).copy(toneCurrent);

    /* 粒子整体涡旋（只改 transform，不动顶点） */
    const nebula = nebulaRef.current;
    if (nebula !== null) {
      nebula.rotation.y = t * 0.22;
      nebula.rotation.x = Math.sin(t * 0.3) * 0.08;
    }
    /* 内层棱线反向旋转，外层正向，形成视差 */
    if (wireInnerRef.current !== null) wireInnerRef.current.rotation.y = -t * 0.12;
    if (wireOuterRef.current !== null) wireOuterRef.current.rotation.y = t * 0.09;
    /* 陀螺环：3 道不同倾角、3.6s 节拍的整数分之一（1.8s / 0.9s / 0.6s） */
    const gyros = gyroRefs.current;
    for (let i = 0; i < GYRO_RING_COUNT; i += 1) {
      const ring = gyros[i];
      if (ring !== null && ring !== undefined) {
        ring.rotation.z = t * ((i + 1) * (Math.PI * 2)) / (3.6 / (i + 1));
      }
    }
  });

  return (
    <group>
      {/* ---- 1. 内核奇点 r≈0.40 ---- */}
      <mesh raycast={(): void => undefined} renderOrder={1}>
        <icosahedronGeometry args={[CORE_RADIUS, 4]} />
        <shaderMaterial
          uniforms={coreUniforms}
          vertexShader={CORE_VERTEX}
          fragmentShader={CORE_FRAGMENT}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      {/* ---- 2. 体积雾球 r≈0.95（BackSide + Additive） ---- */}
      <mesh raycast={(): void => undefined} renderOrder={0}>
        <sphereGeometry args={[FOG_SPHERE_RADIUS, 32, 24]} />
        <shaderMaterial
          uniforms={fogUniforms}
          vertexShader={FOG_VERTEX}
          fragmentShader={FOG_FRAGMENT}
          transparent
          depthWrite={false}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      {/* ---- 3. 晶体主体：八面体菲涅尔假折射（透明度 ≤ 0.28） ---- */}
      <mesh
        scale={[1, 1.22, 1]}
        raycast={(): void => undefined}
        renderOrder={1}
      >
        <octahedronGeometry args={[CRYSTAL_RADIUS, 0]} />
        {usePhysicalCrystal ? (
          /*
           * T3 真折射：transmission 由 MeshPhysicalMaterial 走屏幕空间折射。
           * 透明度上限 0.28、不写深度，确保内核永远可见。
           */
          <meshPhysicalMaterial
            color="#7dd3fc"
            transmission={0.35}
            thickness={1.2}
            ior={1.45}
            roughness={0.18}
            metalness={0.1}
            transparent
            opacity={0.28}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        ) : (
          /* T2/T1 / 软渲染：Fresnel 假折射（成本恒定，无色偏） */
          <shaderMaterial
            uniforms={crystalUniforms}
            vertexShader={CRYSTAL_VERTEX}
            fragmentShader={CRYSTAL_FRAGMENT}
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        )}
      </mesh>

      {/* ---- 4. 棱线两层 + 顶点高光点 ---- */}
      <lineSegments
        ref={wireInnerRef}
        geometry={wireInnerGeometry}
        raycast={(): void => undefined}
        renderOrder={2}
      >
        <shaderMaterial
          uniforms={wireInnerUniforms}
          vertexShader={WIRE_VERTEX}
          fragmentShader={WIRE_FRAGMENT}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </lineSegments>
      <lineSegments
        ref={wireOuterRef}
        geometry={wireOuterGeometry}
        raycast={(): void => undefined}
        renderOrder={2}
      >
        <shaderMaterial
          uniforms={wireOuterUniforms}
          vertexShader={WIRE_VERTEX}
          fragmentShader={WIRE_FRAGMENT}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </lineSegments>
      <points geometry={vertexSparkGeometry} raycast={(): void => undefined} renderOrder={2}>
        <pointsMaterial
          size={0.055}
          color="#f0fdff"
          transparent
          opacity={0.9}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/* ---- 5. 内部星云：360 粒子，轨道半径 < 1.15 ---- */}
      <points ref={nebulaRef} geometry={nebulaGeometry} raycast={(): void => undefined} renderOrder={1}>
        <shaderMaterial
          uniforms={nebulaUniforms}
          vertexShader={NEBULA_VERTEX}
          fragmentShader={NEBULA_FRAGMENT}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>

      {/* ---- 6. 外层大气光晕 r≈1.85 + 3 道陀螺环 ---- */}
      <mesh raycast={(): void => undefined} renderOrder={0}>
        <sphereGeometry args={[ATMOSPHERE_RADIUS, 32, 24]} />
        <shaderMaterial
          uniforms={atmosphereUniforms}
          vertexShader={ATMOSPHERE_VERTEX}
          fragmentShader={ATMOSPHERE_FRAGMENT}
          transparent
          depthWrite={false}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      {Array.from({ length: GYRO_RING_COUNT }, (_, index) => {
        const tilt = [0.35 + index * 0.62, 0.4 + index * 0.9, 0.2 + index * 0.5];
        return (
          <mesh
            key={`gyro-${index}`}
            ref={(node): void => {
              if (node !== null) gyroRefs.current = [...gyroRefs.current.slice(0, index), node, ...gyroRefs.current.slice(index + 1)];
            }}
            rotation={[tilt[0], tilt[1], tilt[2]]}
            raycast={(): void => undefined}
            renderOrder={2}
          >
            <torusGeometry args={[ATMOSPHERE_RADIUS * (0.86 + index * 0.05), 0.006, 8, 128]} />
            <meshBasicMaterial
              color="#38bdf8"
              transparent
              opacity={0.22 - index * 0.04}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        );
      })}
    </group>
  );
}