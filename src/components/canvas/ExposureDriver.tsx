'use client';

/**
 * KubeVision AI — 自适应曝光控制器（R24）
 *
 * 【要解决什么】故障态下发光体（告警红、闪烁光斑、泛光）数量骤增，
 * 固定曝光会把画面高光糊成一片，状态色失去层次。需要让曝光随
 * **画面亮度估计**在 [1.0, 1.18] 内平滑回落。
 *
 * 【为什么不用 readPixels】每帧回读 GPU 像素会造成渲染管线同步停顿
 * （readPixels 是同步阻塞调用），在 60FPS 预算里是不可接受的开销。
 * 这里改为"场景亮度估计"：由瞬态轨里已有的低频数据（Pod 异常比例、
 * 混沌场景、健康分）合成一个 [0,1] 的亮度代理值——它不读 GPU、
 * 零分配、O(n) 且 n ≤ 48。
 *
 * 【为什么需要自定义 Effect 而不是直接设 gl.toneMappingExposure】
 * Composer 路径下渲染器的 toneMapping 被设为 NoToneMapping（由后处理
 * 的 ToneMapping pass 接管），此时 gl.toneMappingExposure 不生效。
 * 因此这里用 postprocessing 的 Effect 机制插入一个乘性曝光 pass，
 * 顺序在 ToneMapping 之前（线性 HDR 域里缩放，才是物理正确的曝光）。
 *
 * 【阻尼】每帧 `current += (target - current) * (1 - e^(-k·dt))`：
 * 帧率无关、无跳变、可证明收敛；实测 2.2 的 k 在 250ms 内走完约 42%，
 * 视觉上是"缓慢适应"而不是"忽然变暗"。
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Effect } from 'postprocessing';
import { Uniform } from 'three';
import { wrapEffect } from '@react-three/postprocessing';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import { useClusterStore } from '@/store/useClusterStore';

/** 曝光上下限（题目要求 [1.0, 1.18]） */
export const EXPOSURE_MIN = 1.0;
export const EXPOSURE_MAX = 1.18;

/** 亮度估计的采样周期（≤4Hz） */
const ESTIMATE_INTERVAL_MS = 250;

/** 阻尼系数（越大收敛越快；2.2 ≈ 0.25s 走完约 42%） */
const EXPOSURE_DAMPING = 2.2;

/** 自定义 Effect 的片元着色器：线性域乘性曝光 */
const EXPOSURE_FRAGMENT = /* glsl */ `
  uniform float exposure;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    outputColor = vec4(inputColor.rgb * exposure, inputColor.a);
  }
`;

/**
 * ExposureEffectImpl —— 乘性曝光 Effect。
 *
 * 【位置契约】必须排在 ToneMapping 之前：曝光是线性光强缩放，
 * 放在色调映射之后会破坏色调映射的输入假设。
 */
class ExposureEffectImpl extends Effect {
  constructor() {
    super('ExposureEffect', EXPOSURE_FRAGMENT, {
      uniforms: new Map<string, Uniform>([['exposure', new Uniform(EXPOSURE_MAX)]]),
    });
  }

  /**
   * 设置曝光值。
   *
   * @param value 目标曝光（会被 clamp 到 [1.0, 1.18]）
   */
  setExposure(value: number): void {
    const uniform = this.uniforms.get('exposure');
    if (uniform !== undefined) {
      uniform.value = Math.min(EXPOSURE_MAX, Math.max(EXPOSURE_MIN, value));
    }
  }
}

/**
 * React 组件封装（ref 暴露底层 Effect 实例）。
 *
 * 【为何需要类型断言】wrapEffect 的返回类型在当前 @react-three/postprocessing
 * 版本里对"构造函数无参"的 Effect 推断成了不可作为 JSX 使用的类型；
 * 这里的断言只作用于编译期组件签名，运行期仍是 wrapEffect 原样返回，
 * 不改变任何渲染行为。
 */
export const ExposureEffect = wrapEffect(ExposureEffectImpl) as unknown as React.ComponentType<{
  readonly ref?: React.Ref<ExposureEffectHandle>;
}>;

/** 控制器需要的 Effect 引用形状 */
export interface ExposureEffectHandle {
  setExposure: (value: number) => void;
}

/**
 * estimateSceneLuminance —— 从瞬态轨 + 低频 store 状态估计画面亮度 [0,1]。
 *
 * 【输入】Pod 异常比例、当前混沌场景、集群健康分——都是复发信息量极高的
 * "发光证据"，且全部来自已有的瞬态/低频轨道，不引入任何新增采样成本。
 *
 * @returns 亮度代理值（0=纯暗场景，1=大量告警发光）
 */
function estimateSceneLuminance(): number {
  const snapshot = telemetryTransientRef.snapshot;
  const pods = snapshot.pods;
  let abnormal = 0;
  for (const pod of pods) {
    if (pod.status !== 'Running') abnormal += 1;
  }
  const abnormalRatio = pods.length === 0 ? 0 : abnormal / pods.length;
  const chaos = useClusterStore.getState().activeChaos;
  const chaosGlow = chaos === 'NONE' ? 0 : 0.55;
  const healthDeficit = Math.min(1, Math.max(0, (100 - snapshot.clusterHealthScore) / 100));
  return Math.min(1, Math.max(0, abnormalRatio * 0.55 + chaosGlow * 0.3 + healthDeficit * 0.15));
}

/**
 * ExposureDriver —— 挂载在 Canvas 内的曝光驱动器。
 *
 * 【职责】低频（≤4Hz）估计亮度 → 计算目标曝光 → 每帧阻尼逼近 →
 * 写入 Effect uniform 与瞬态轨（供 HUD 显示），**全程不 setState**。
 *
 * @param props.effectRef 指向 ExposureEffect 实例的 ref
 */
export function ExposureDriver({ effectRef }: { readonly effectRef: React.MutableRefObject<ExposureEffectHandle | null> }): null {
  /** 当前实际曝光（阻尼状态） */
  const currentRef = useRef<number>(EXPOSURE_MAX);
  /** 目标曝光（低频更新） */
  const targetRef = useRef<number>(EXPOSURE_MAX);
  /** 上次估计时刻 */
  const lastEstimateAtRef = useRef<number>(0);

  useFrame(({ gl }, delta): void => {
    const now = performance.now();

    /* 低频估计：≤4Hz；只在到点时读一次瞬态轨（O(pods)） */
    if (now - lastEstimateAtRef.current >= ESTIMATE_INTERVAL_MS) {
      lastEstimateAtRef.current = now;
      const luminance = estimateSceneLuminance();
      /*
       * 目标曝光：亮度越高曝光越低（1.18 → 1.0）。
       * 这样故障态发光增强时画面不会糊成一片，而稳态仍保留电影感亮度。
       */
      targetRef.current = EXPOSURE_MAX - luminance * (EXPOSURE_MAX - EXPOSURE_MIN);
      telemetryTransientRef.glStats.sceneLuminanceEstimate =
        Math.round(luminance * 10000) / 10000;
    }

    /* 每帧阻尼插值（帧率无关；禁止跳变） */
    const alpha = 1 - Math.exp(-EXPOSURE_DAMPING * Math.min(delta, 0.1));
    currentRef.current += (targetRef.current - currentRef.current) * alpha;

    /* 渲染器 exposure：兜底路径（渲染器内置 NeutralToneMapping）直接生效 */
    gl.toneMappingExposure = currentRef.current;
    /* Composer 路径：通过自定义曝光 pass 生效（渲染器 toneMapping 已被关闭） */
    effectRef.current?.setExposure(currentRef.current);
    /* 瞬态轨：供 Shift+P HUD 读取，零重渲染 */
    telemetryTransientRef.glStats.toneMappingExposure =
      Math.round(currentRef.current * 10000) / 10000;
  });

  return null;
}