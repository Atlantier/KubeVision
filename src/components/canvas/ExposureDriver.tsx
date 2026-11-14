'use client';

/**
 * KubeVision AI — 自适应曝光控制器（R24 / R62 修复）
 *
 * 【要解决什么】故障态下发光体（告警红、闪烁光斑、泛光）数量骤增，
 * 固定曝光会把画面高光糊成一片，状态色失去层次。需要让曝光随
 * **画面亮度估计**在 [0.85, 1.00] 内平滑回落。
 *
 * 【R62 关键修复：双重曝光】
 * 旧实现同时做两件事：
 *   1. useFrame 里 `gl.toneMappingExposure = 1.18`；
 *   2. 后处理 ExposureEffect 里 `inputColor.rgb * uExposure`（也是 1.18）。
 * 稳态画面被乘了 1.18 × 1.18 = 1.3924 倍，所有高光直接过曝发白。
 * 现在：
 *   · `gl.toneMappingExposure` 只在挂载 effect 中固定为 **1.0**，useFrame 不再碰；
 *   · 曝光系数唯一来源是 ExposureEffect 的 `uExposure`（[0.85, 1.0]）；
 *   · 片元里先做 NaN/Infinity 防御，再做软膝高光滚降，局部高亮平滑收敛。
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

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Effect } from 'postprocessing';
import { Uniform, type WebGLRenderer } from 'three';
import { wrapEffect } from '@react-three/postprocessing';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import { useClusterStore } from '@/store/useClusterStore';

/**
 * 曝光上下限（R62 / R6-5 协同）。
 *
 * 稳态上限 1.00：绝不凭空放大亮度；故障/高发光期温和压到 0.85（-15%）。
 * 为什么是 0.85：R6-5 把 ambientLight 抬至 0.36、地面提至 #060d1a 后，
 * 下限锁定 0.85 确保自适应曝光最暗时地面仍保深海蓝灰（不跌回死黑）且不过曝。
 */
export const EXPOSURE_MIN = 0.85;
export const EXPOSURE_MAX = 1.0;

/** 亮度估计的采样周期（≤4Hz） */
const ESTIMATE_INTERVAL_MS = 250;

/** 阻尼系数（越大收敛越快；2.2 ≈ 0.25s 走完约 42%） */
const EXPOSURE_DAMPING = 2.2;

/**
 * 自定义 Effect 的片元着色器：线性域乘性曝光 + 防御 + 软膝高光滚降。
 *
 * 【安全判据】用范围取反 `!(x >= 0 && x <= 64)` 而不是 `x == x`：
 * Windows ANGLE→D3D11 的 HLSL 优化可能把自比较折叠掉，范围判据同时
 * 覆盖 NaN、负数与 ±Infinity。
 *
 * 【软膝】exposed / (1 + max(0, exposed - 0.85) * 0.45)：
 * 0.85 以下保持线性；以上分母逐渐增大，高光平滑压缩到约 2.2 上限，
 * 不会出现整片死白。
 */
const EXPOSURE_FRAGMENT = /* glsl */ `
  uniform float uExposure;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec3 safeRgb = inputColor.rgb;
    bvec3 invalid = bvec3(
      !(safeRgb.r >= 0.0 && safeRgb.r <= 64.0),
      !(safeRgb.g >= 0.0 && safeRgb.g <= 64.0),
      !(safeRgb.b >= 0.0 && safeRgb.b <= 64.0)
    );
    if (any(invalid)) {
      safeRgb = vec3(0.0);
    }
    vec3 exposed = safeRgb * uExposure;
    // 高光软膝滚降：超过 1.0 的高亮平滑压缩，防止局部死白过曝
    vec3 compressed = exposed / (vec3(1.0) + max(vec3(0.0), exposed - vec3(0.85)) * 0.45);
    float safeAlpha = (inputColor.a >= 0.0 && inputColor.a <= 1.0) ? inputColor.a : 1.0;
    outputColor = vec4(compressed, safeAlpha);
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
      uniforms: new Map<string, Uniform>([['uExposure', new Uniform(EXPOSURE_MAX)]]),
    });
  }

  /**
   * 设置曝光值。
   *
   * @param value 目标曝光（会被 clamp 到 [0.85, 1.0]）
   */
  setExposure(value: number): void {
    const uniform = this.uniforms.get('uExposure');
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
 * 【R62 单一曝光源】渲染器 toneMappingExposure 固定在 1.0（挂载 effect），
 * useFrame 只写 ExposureEffect 的 uExposure；禁止再写 gl.toneMappingExposure，
 * 否则会与后处理乘性曝光形成 1.0×1.0 以外的双重放大。
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

  /** 渲染器实例：只用于挂载时把 toneMappingExposure 固定为 1.0。 */
  const gl = useThree((state): WebGLRenderer => state.gl);

  /**
   * R62：渲染器曝光固定 1.0。
   *
   * 这条只在挂载/渲染器变化时执行一次，绝不放进 useFrame；
   * 曝光系数由 ExposureEffect.uExposure 唯一控制。
   */
  useEffect((): void => {
    gl.toneMappingExposure = 1.0;
  }, [gl]);

  useFrame((_state, delta): void => {
    const now = performance.now();

    /* 低频估计：≤4Hz；只在到点时读一次瞬态轨（O(pods)） */
    if (now - lastEstimateAtRef.current >= ESTIMATE_INTERVAL_MS) {
      lastEstimateAtRef.current = now;
      const luminance = estimateSceneLuminance();
      /*
       * 目标曝光：亮度越高曝光越低（1.00 → 0.85）。
       * 稳态保持 1.0 标准曝光；故障态高光增多时温和压暗 15%。
       */
      targetRef.current = EXPOSURE_MAX - luminance * (EXPOSURE_MAX - EXPOSURE_MIN);
      telemetryTransientRef.glStats.sceneLuminanceEstimate =
        Math.round(luminance * 10000) / 10000;
    }

    /* 每帧阻尼插值（帧率无关；禁止跳变） */
    const alpha = 1 - Math.exp(-EXPOSURE_DAMPING * Math.min(delta, 0.1));
    currentRef.current += (targetRef.current - currentRef.current) * alpha;

    /* 唯一曝光写入点：后处理 Effect 的 uExposure */
    effectRef.current?.setExposure(currentRef.current);
    /* 瞬态轨：供 Shift+P HUD 读取，零重渲染 */
    telemetryTransientRef.glStats.toneMappingExposure =
      Math.round(currentRef.current * 10000) / 10000;
  });

  return null;
}