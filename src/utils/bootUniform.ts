/**
 * KubeVision AI — 开场编排 uBoot（R29 · B 项）
 *
 * 【契约】uBoot 是**模块级单例 uniform 值**，只有一个 useFrame（BootController）
 * 推进它，所有需要"开场渐入"的层读取同一个值：
 *   groundRingAlpha *= uBoot;  matrixRainAlpha *= uBoot;
 *   crystalScale *= smoothstep(uBoot);  labelOpacity *= uBoot;  racksScale *= uBoot;
 *
 * 【时间轴】0–1.2s 线性推进，再经 smoothstep 平滑（无跳变）；
 * 相机运镜在 0–2.4s 内完成并把机位精确落在 OVERVIEW；
 * HUD 分段入场 1.2–2.8s（由 HUD 自身 CSS 延迟实现，不占 useFrame）。
 *
 * 【prefers-reduced-motion: reduce】uBoot 直接置 1、取消运镜、循环幅度 ×1/4。
 */

/** uBoot 全局值（0 = 完全未入场，1 = 完全入场） */
export const bootUniform: { value: number } = { value: 0 };

/** uBoot 线性推进时长（秒） */
export const BOOT_DURATION = 1.2;

/** 开场运镜时长（秒）：0–2.4s 推到 OVERVIEW */
export const OPENING_FLIGHT_DURATION = 2.4;
/** 开场运镜起点机位（需求契约值） */
export const OPENING_CAMERA_POSITION: readonly [number, number, number] = [10.6, 17.2, 26.5];
/** 开场运镜阻尼系数（需求契约值） */
export const OPENING_FLIGHT_DAMPING = 3.2;

/**
 * smoothstep —— R01 安全的平滑插值（edge0 < edge1 = 0 < 1）。
 *
 * @param x 输入（会被 clamp 到 [0,1]）
 * @returns 平滑后的 [0,1] 值
 */
export function smoothstep01(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}