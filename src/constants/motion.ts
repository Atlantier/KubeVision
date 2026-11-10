/**
 * KubeVision AI — 全局动效节拍（R29 · E 项）
 *
 * 【为什么需要单一节拍】此前每个组件各自写死角速度（2.2 / 2.8 / 3.9 rad/s…），
 * 并排观察时像多台不同步的机器，观感"杂乱"。R29 起所有循环动效统一以
 * **MOTION_BEAT = 3.6s** 为基拍，取它的整数分之一作为周期：
 *   - 晶核呼吸：3.6/1（1 拍）
 *   - 陀螺环：3.6/2、3.6/3、3.6/4
 *   - 赤道/极环：3.6/2、3.6/5
 *   - 雷达扫掠：3.6/1
 *   - 故障涟漪：1.2s/环 = 3.6/3（允许打破节拍，故障必须抢注意力）
 *
 * 【角频率换算】周期 T 秒 → 角频率 ω = 2π/T；所有组件统一从本文件取 ω，
 * 不再各自写魔法数。
 */

/** 全局基础节拍（秒） */
export const MOTION_BEAT = 3.6;

/**
 * 由节拍分数得到角频率。
 *
 * @param fraction 占一拍的比例（如 1 = 每拍一次，1/2 = 每拍两次）
 * @returns 角频率 ω（rad/s）
 */
export function beatOmega(fraction: number): number {
  return (Math.PI * 2) / (MOTION_BEAT * fraction);
}

/** 晶核呼吸角频率（3.6/1） */
export const MOTION_BREATH_OMEGA = beatOmega(1);
/** 雷达扫掠角频率（3.6/1） */
export const MOTION_RADAR_OMEGA = beatOmega(1);
/** 陀螺环 2 倍频（3.6/2） */
export const MOTION_GYRO_FAST_OMEGA = beatOmega(1 / 2);
/** 陀螺环 3 倍频（3.6/3） */
export const MOTION_GYRO_MID_OMEGA = beatOmega(1 / 3);
/** 陀螺环 4 倍频（3.6/4） */
export const MOTION_GYRO_SLOW_OMEGA = beatOmega(1 / 4);
/** 赤道环（3.6/2） */
export const MOTION_EQUATOR_OMEGA = beatOmega(1 / 2);
/** 极轨环（3.6/5） */
export const MOTION_POLAR_OMEGA = beatOmega(1 / 5);
/** 故障涟漪周期（1.2s/环） */
export const MOTION_RIPPLE_PERIOD = MOTION_BEAT / 3;

/**
 * isReducedMotion —— 是否请求"减少动效"。
 *
 * 【契约】prefers-reduced-motion: reduce 时：
 *   - uBoot 直接 = 1（不做开场）；
 *   - 循环动画幅度 ×1/4（呼吸几乎不可见，不是完全静止）；
 *   - 取消开场运镜。
 *
 * @returns 用户要求减少动效时返回 true
 */
export function isReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 减少动效时的循环幅度系数（×1/4） */
export const REDUCED_MOTION_AMPLITUDE = 0.25;