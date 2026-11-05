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
 * 片元着色器 —— 3 道由内向外周期性扩散的红色能量环。
 *
 * 【数学说明】
 * 1. 半径归一化：vUv 在 [0,1]²，圆心 (0.5,0.5)，故 r = |vUv − 0.5| · 2
 *    落在 [0, ≈1.414]（四角略超 1），环超出 1 后 alpha 已被 fade 压至近 0。
 * 2. 环心推进：progress_i = fract(uTime · SPEED + i/3)，三道相位差 1/3。
 * 3. 环带剖面：smoothstep(WIDTH, 0.0, |r − progress_i|) —— 距离环心越近
 *    强度越高（参数反向的 smoothstep 即「1 在 0 处、0 在 WIDTH 处」的钟形）。
 * 4. 平方衰减：fade = (1 − progress)²（契约公式），内新环亮、外老环暗。
 * 5. 加色输出：颜色 × 总强度，alpha 同步携带强度（AdditiveBlending 下
 *    实际生效的是 src.rgb 累加，alpha 用于可选的 alphaTest/排序语义）。
 */
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uOpacity;
  uniform vec3  uColor;
  uniform float uRingCount;
  uniform float uSpeed;
  uniform float uWidth;

  varying vec2 vUv;

  void main() {
    // 1. 归一化畸变半径（圆心 0 → 边缘 ≈1）
    float r = length(vUv - vec2(0.5)) * 2.0;

    float total = 0.0;

    // 2. 三道相位错开的扩散环
    for (int i = 0; i < 3; i++) {
      if (float(i) >= uRingCount) break;

      // 环心推进：fract 实现无缝循环
      float progress = fract(uTime * uSpeed + float(i) / max(uRingCount, 1.0));

      // 环带剖面（钟形），abs 距离为 0 时强度 1
      float dist = abs(r - progress);
      float band = smoothstep(uWidth, 0.0, dist);

      // 由内向外平方衰减（契约公式 (1.0 - r)^2，此处 r 取环心位置）
      float fade = pow(1.0 - progress, 2.0);

      total += band * fade;
    }

    // 3. 输出：强度驱动亮度与透明度
    float alpha = clamp(total, 0.0, 1.0) * uOpacity;
    gl_FragColor = vec4(uColor * total, alpha);
  }
`;

/* ========================================================================== */
/* 着色器参数常量                                                              */
/* ========================================================================== */

/** 环平面尺寸（世界单位，覆盖机架占地并向外扩散） */
const RING_PLANE_SIZE = 11;

/** 贴地高度（略高于地面网格 0.01 与机架底板 0.03，避免 z-fighting） */
const RING_Y = 0.05;

/** 扩散速度（progress/秒：1.0 ≈ 1.6 秒走完一环） */
const RING_SPEED = 0.62;

/** 环带宽度（归一化半径域，0.06 ≈ 视觉上 3~4px 的柔和光带） */
const RING_WIDTH = 0.085;

/** 环数（着色器循环上限 3，与 uniform 联动） */
const RING_COUNT = 3;

/** 基准透明度（加色混合下的整体强度调节） */
const RING_BASE_OPACITY = 0.85;

/** 警示红（契约指定 #f43f5e 的线性 RGB 近似，着色器内直接乘算） */
const RING_COLOR = new THREE.Color('#f43f5e');

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
      uRingCount: { value: RING_COUNT },
      uSpeed: { value: RING_SPEED },
      uWidth: { value: RING_WIDTH },
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
