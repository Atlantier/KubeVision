'use client';

/**
 * KubeVision AI — 机架故障警示涟漪环（ErrorRippleRing）
 *
 * 【设计意图】机架发生故障时，在其底部地面投射一圈向外扩散的红色能量环，
 * 复刻雷达告警/声呐回波的视觉语言——远处扫视 3D 场景即可定位「哪台机架出事了」。
 *
 * 【激活判定】（任一成立即激活该机架涟漪）
 * 1. 机架名下存在 CrashLoopBackOff / OOMKilled 的 Pod；
 * 2. 节点自身状态非 'Ready'（HighLoad / NetworkPartition）。
 *
 * 【自定义着色器数学】（AGENTS.md 第 8 条中文原理注释契约）
 * 渲染载体：水平放置的环形平面（绕 X 轴 −90° 使其贴合 XZ 地面）。
 * 顶点着色器把 uv 映射到局部坐标并输出归一化畸变半径 r ∈ [0,1]
 * （圆心为 0，边缘为 1）；片元着色器以 uTime 驱动 **3 道** 能量环：
 *
 *   progress_i = fract(uTime · SPEED + i / 3)          i ∈ {0,1,2}
 *   ring_i     = 环心位置 progress_i，宽度 WIDTH
 *   intensity_i = smoothstep(WIDTH, 0.0, |r − progress_i|)   环带内平滑隆起
 *   fade_i      = (1.0 − progress_i)²                       由内向外平方衰减（契约公式）
 *   alpha = Σ intensity_i · fade_i × uOpacity
 *
 * 三重相位错开（i/3）使环以 1/3 周期均匀接续，形成持续外扩的脉冲序列；
 * 平方衰减保证环远离中心时迅速淡出，不会在画布边缘留下突兀的硬边。
 *
 * 【材质契约】必须显式配置（缺一不可）：
 * - transparent: true     —— 允许 alpha 混合，否则片元 alpha 被忽略
 * - depthWrite: false     —— 不写深度，避免遮挡后绘制的 Pod/地面网格
 * - side: THREE.DoubleSide —— 水平平面从上方俯视/低角度侧视均可见
 * - blending: THREE.AdditiveBlending —— 加色混合产生能量辉光（叠层自然增亮）
 */

import { useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { useClusterStore } from '@/store/useClusterStore';
import { getRackTransform } from '@/utils/spatialLayout';
import type { RackErrorRingProps } from '@/types/canvas';

/* ========================================================================== */
/* 着色器源码（模块级常量：编译一次，多实例共享 program 缓存）                      */
/* ========================================================================== */

/**
 * 顶点着色器 —— 输出 vUv 供片元计算畸变半径。
 *
 * 采用最简 pass-through 变换（不引入法线/雾效，能量环是纯自发光加色层），
 * gl_Position = projectionMatrix · modelViewMatrix · position 为标准 MVP 链。
 */
const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * 片元着色器 —— 双层雷达波：锐利亮红波峰 + 柔和绯红尾迹。
 *
 * 【数学说明】
 * 1. 半径归一化：vUv ∈ [0,1]²，圆心 (0.5,0.5)，r = |vUv − 0.5| · 2 ∈ [0, ≈1.414]。
 *    r = 1 对应的世界半径即 RING_MAX_RADIUS，故环的最远扩散半径由平面尺寸精确约束。
 * 2. 环心推进：progress_i = fract(uTime · SPEED + i/3)，三道相位差 1/3，接续无缝。
 * 3. **双层剖面**（本轮核心改动）：
 *    · 波峰 peak  = smoothstep(uPeakWidth, 0.0, |r − progress|)
 *      —— uPeakWidth 仅 0.022，形成一道**锐利**的亮环，像雷达扫描线的前缘。
 *    · 尾迹 trail = smoothstep(uTrailWidth, 0.0, |r − progress|)
 *      × (1 − smoothstep(0.0, uBeamWidth, r − progress))
 *      —— uTrailWidth 宽达 0.115，但被方向因子乘掉：只有 r < progress（**已扫过
 *      的内侧**）才保留，外侧立即归零。于是形成「彗星」形态：
 *      锐利前缘 + 向后拖曳的柔光尾迹，而不再是左右对称的圆环带。
 *    · trail 额外乘以 (1 − peak)：避免波峰处与尾迹叠加导致中心过曝成白团。
 * 4. 平方衰减：fade = (1 − progress)²，内新环亮、外老环暗，与契约公式一致。
 * 5. **加色输出的正确姿势**：AdditiveBlending 下 three 的
 *    blendSrc = SrcAlphaFactor，最终 = src.rgb · src.a + dst.rgb。
 *    若 rgb 与 alpha 都携带强度，实际会变成**强度的平方**，波峰会迅速变暗。
 *    故这里 rgb 直接输出（已乘 uOpacity），alpha 恒为 1.0，
 *    使叠加严格线性——锐利波峰才能真正"亮"起来。
 */
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uOpacity;
  uniform vec3  uColor;
  uniform vec3  uPeakColor;
  uniform float uRingCount;
  uniform float uSpeed;
  uniform float uPeakWidth;
  uniform float uTrailWidth;
  uniform float uBeamWidth;
  uniform float uTrailGain;

  varying vec2 vUv;

  void main() {
    // 1. 归一化畸变半径（圆心 0 → 边缘 1，即 RING_MAX_RADIUS）
    float r = length(vUv - vec2(0.5)) * 2.0;

    float totalPeak  = 0.0;
    float totalTrail = 0.0;

    // 2. 三道相位错开的扩散波
    for (int i = 0; i < 3; i++) {
      if (float(i) >= uRingCount) break;

      // 波前位置：fract 实现无缝循环
      float progress = fract(uTime * uSpeed + float(i) / max(uRingCount, 1.0));

      float dist = abs(r - progress);

      // ---- 3a. 锐利亮红波峰（窄带） ----
      float peak = 1.0 - smoothstep(0.0, max(uPeakWidth, 1.0e-4), dist);

      // ---- 3b. 柔和绯红尾迹（宽带 × 内侧方向因子） ----
      float trailBand = 1.0 - smoothstep(0.0, max(uTrailWidth, 1.0e-4), dist);
      // r < progress（波前内侧）→ 1；r > progress（外侧）→ 迅速 0
      float behind = 1.0 - smoothstep(0.0, max(uBeamWidth, 1.0e-4), r - progress);
      // 扣掉与波峰重合的部分，避免中心叠加过曝
      float trail = trailBand * behind * (1.0 - peak);

      // ---- 3c. 由内向外平方衰减 ----
      float fadeBase = max(1.0 - progress, 0.0);
      float fade = fadeBase * fadeBase;

      totalPeak  += peak  * fade;
      totalTrail += trail * fade;
    }

    // 4. 双色合成：波峰提亮偏白，尾迹保持绯红
    vec3 rgb = uPeakColor * totalPeak + uColor * totalTrail * uTrailGain;

    // 5. 加色混合下 alpha 恒为 1.0，保证 rgb 线性叠加（详见上方第 5 点）
    gl_FragColor = vec4(clamp(rgb * uOpacity, 0.0, 8.0), 1.0);
  }
`;

/* ========================================================================== */
/* 着色器参数常量                                                              */
/* ========================================================================== */

/**
 * 波纹最大扩散半径（世界单位）。
 *
 * 【为何是 4.0】机架底座足迹半对角线约 1.58（RACK_BODY_SIZE 2.6×1.8），
 * 波纹外扩到 4.0 时约为底座足迹的 2.5 倍——足以"罩住"整台机架并向四周
 * 铺开约 2.4 个单位，让相邻机架（间距 16.45）完全不受干扰，
 * 同时又能与地面基座环（半径 2.2）形成明确的层级：基座是静态归属，
 * 波纹是动态告警。
 */
const RING_MAX_RADIUS = 4.0;

/**
 * 环平面边长。
 *
 * 【几何反推】着色器用 r = |vUv − 0.5| · 2 归一化，r = 1 恰对应平面**内切圆**，
 * 即半个边长。故要让 r = 1 落在 RING_MAX_RADIUS 上，边长必须是 2 × RING_MAX_RADIUS。
 * 此前固定写 11（半边长 5.5），导致环扩散到 4.0 之后仍有 1.5 的"空转区"，
 * 且平方衰减尚未归零就被裁掉——波纹看起来会突然消失。现在两者严格绑定。
 */
const RING_PLANE_SIZE = RING_MAX_RADIUS * 2;

/** 贴地高度（略高于地面网格 0.01 与机架底板 0.03，避免 z-fighting） */
const RING_Y = 0.05;

/** 扩散速度（progress/秒：0.62 ≈ 1.6 秒走完一环，对应约 4.0 世界单位/1.6s） */
const RING_SPEED = 0.62;

/**
 * 锐利波峰宽度（归一化半径域）。
 *
 * 0.022 × 4.0 ≈ 0.088 世界单位——在常见机位下约 2~3 像素。
 * 这是"雷达扫描线"那根锐利前缘的关键：再宽就变成光带，失去扫描感。
 */
const RING_PEAK_WIDTH = 0.022;

/**
 * 柔和尾迹宽度（归一化半径域）。
 *
 * 0.115 × 4.0 ≈ 0.46 世界单位，约为波峰的 5 倍宽，形成明显的拖尾。
 */
const RING_TRAIL_WIDTH = 0.115;

/**
 * 尾迹的"向内侧软化距离"（归一化半径域）。
 *
 * 控制 behind 因子的过渡带：r 比 progress 小超过该值即完全保留尾迹，
 * 反之迅速归零。0.035 让尾迹与波峰的交界有一小段柔和过渡，
 * 避免出现"刀切"的硬边。
 */
const RING_BEAM_WIDTH = 0.035;

/** 尾迹相对波峰的强度系数（尾迹是陪衬，不可抢走锐利前缘的视觉焦点） */
const RING_TRAIL_GAIN = 0.85;

/** 环数（着色器循环上限 3，与 uniform 联动） */
const RING_COUNT = 3;

/** 基准透明度（加色混合下的整体强度调节） */
const RING_BASE_OPACITY = 0.85;

/** 尾迹色：绯红（契约语义色） */
const RING_COLOR = new THREE.Color('#f43f5e');

/**
 * 波峰色：亮红。
 *
 * 【为何要双色】单色环无论怎么调参都是一个色块；波峰向亮红偏移后，
 * 前缘"过热发亮"、尾迹"冷却变暗"，才有能量波在传播的物理感。
 * #ff6b6b 的 R 通道拉满、G/B 抬高，在加色混合下会自然趋向白热。
 */
const RING_PEAK_COLOR = new THREE.Color('#ff6b6b');

/* ========================================================================== */
/* 单机架涟漪环                                                                */
/* ========================================================================== */

/**
 * RackErrorRing —— 单个机架的故障涟漪环（被父级渲染即代表激活）。
 *
 * 【生命周期】由父级 ErrorRippleRing 条件渲染：故障出现即挂载（环从 0 相起扩），
 * 故障消除即卸载（无残留）。uTime 以 elapsedTime 驱动，无需手动重置。
 */
export function RackErrorRing({ rackIndex }: RackErrorRingProps) {
  /* 机架世界坐标（与机架/ Pod 渲染同一空间事实源） */
  const rackTransform = useMemo(() => getRackTransform(rackIndex), [rackIndex]);

  const materialRef = useRef<THREE.ShaderMaterial>(null);

  /**
   * ShaderMaterial uniforms（useMemo 一次创建，引用稳定）。
   *
   * 【为何不写进 JSX 的 uniforms 字面量】JSX 内联对象每次渲染都会新建，
   * 导致 R3F 重建材质 uniform 绑定；useMemo 保持引用稳定，
   * useFrame 内直接改 .value 即可（零 React 参与）。
   */
  const uniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uTime: { value: 0 },
      uOpacity: { value: RING_BASE_OPACITY },
      uColor: { value: RING_COLOR },
      uPeakColor: { value: RING_PEAK_COLOR },
      uRingCount: { value: RING_COUNT },
      uSpeed: { value: RING_SPEED },
      uPeakWidth: { value: RING_PEAK_WIDTH },
      uTrailWidth: { value: RING_TRAIL_WIDTH },
      uBeamWidth: { value: RING_BEAM_WIDTH },
      uTrailGain: { value: RING_TRAIL_GAIN },
    }),
    [],
  );

  /* useFrame：仅推进 uTime 标量（零分配、零 setState） */
  useFrame((state): void => {
    const material = materialRef.current;
    if (material === null) return;
    const timeUniform = material.uniforms.uTime;
    if (timeUniform !== undefined) {
      timeUniform.value = state.clock.getElapsedTime();
    }
  });

  return (
    <mesh position={[rackTransform.position[0], RING_Y, rackTransform.position[2]]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[RING_PLANE_SIZE, RING_PLANE_SIZE]} />
      <shaderMaterial
        ref={materialRef}
        vertexShader={VERTEX_SHADER}
        fragmentShader={FRAGMENT_SHADER}
        uniforms={uniforms}
        /* ---- 材质契约四件套（缺一不可，详见文件头 JSDoc） ---- */
        transparent
        depthWrite={false}
        side={THREE.DoubleSide}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}

/* ========================================================================== */
/* 三机架涟漪环调度器                                                           */
/* ========================================================================== */

/**
 * ErrorRippleRing —— 遍历三机架，为每个故障机架激活一圈警示涟漪。
 *
 * 【订阅纪律】派生 selector 直接返回「故障机架索引数组」，zustand 默认的
 * Object.is 比较下，数组每次都是新引用会触发重渲染——因此 selector 内部
 * 返回**字符串签名**（如 "0,2"），仅签名变化才重渲染；渲染时再拆分。
 * 这一手法把「1Hz 快照流」对特效层的重渲染压到零（除非故障组合真的变了）。
 */
export default function ErrorRippleRing() {
  /**
   * 故障机架签名（低频：仅故障组合变化时改变）。
   *
   * 【判定】机架名下存在 CrashLoopBackOff/OOMKilled Pod，或节点非 Ready。
   * 返回如 "0,2" 的确定性签名；无故障返回空串。
   */
  const faultSignature = useClusterStore(
    (s): string => {
      const snapshot = s.snapshotSummary;
      const faulty: number[] = [];
      for (const node of snapshot.nodes) {
        const nodeFault = node.status !== 'Ready';
        const podFault = snapshot.pods.some(
          (p): boolean =>
            p.nodeId === node.id && (p.status === 'CrashLoopBackOff' || p.status === 'OOMKilled'),
        );
        if (nodeFault || podFault) faulty.push(node.rackIndex);
      }
      faulty.sort((a, b): number => a - b);
      return faulty.join(',');
    },
  );

  /* 签名 → 索引数组（整数键派生，稳定且可穷举 RackIndex 0|1|2） */
  const faultyRackIndices = useMemo((): readonly number[] => {
    if (faultSignature === '') return [];
    return faultSignature.split(',').map((token): number => Number.parseInt(token, 10));
  }, [faultSignature]);

  return (
    <group>
      {faultyRackIndices.map(
        (rackIndex): ReactNode => (
          <RackErrorRing key={rackIndex} rackIndex={rackIndex as 0 | 1 | 2} />
        ),
      )}
    </group>
  );
}
