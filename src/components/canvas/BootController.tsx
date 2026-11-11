'use client';

/**
 * BootController —— 开场编排的唯一推进者（R29 · B 项）。
 *
 * 【契约】整棵渲染树只有这一个 useFrame 写 `bootUniform.value`：
 *   - 常规：uBoot += delta / 1.2，再取 smoothstep（0–1.2s 渐入）；
 *   - prefers-reduced-motion: reduce：uBoot = 1（直接完成、不播开场）。
 * 其它层（晶核 scale、地面环 alpha、矩阵雨、铭牌 opacity）只**读** uBoot，
 * 因此开场同步天然一致，且 0 新增 draw call。
 */

import { useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { bootUniform, BOOT_DURATION, smoothstep01 } from '@/utils/bootUniform';
import { isReducedMotion } from '@/constants/motion';

/** BootController 无 props */
export default function BootController(): null {
  useEffect((): void => {
    if (isReducedMotion()) bootUniform.value = 1;
  }, []);

  useFrame((_state, delta): void => {
    if (bootUniform.value >= 1) return;
    if (isReducedMotion()) {
      bootUniform.value = 1;
      return;
    }
    bootUniform.value = Math.min(1, bootUniform.value + Math.min(delta, 0.1) / BOOT_DURATION);
  });

  /* 对外暴露平滑值供渲染层读取（不写回 uniform，避免双重 smoothstep） */
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__KUBEVISION_BOOT__ = smoothstep01(bootUniform.value);
  }
  return null;
}