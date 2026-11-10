/**
 * KubeVision AI — 质量治理器（R29 · F 项，M1）
 *
 * 【输入】telemetryTransientRef.glStats.fps（2Hz 采样）。
 * 【降档】2s 窗口内 fps < 50 连续 2 次（≈4s 持续低帧）→ 降一档。
 * 【升档】fps > 58 连续 6s → 升一档，且 30s 冷却期内不再升档。
 * 【顺序】粒子密度 → Bloom levels/intensity → DoF 关 → 阴影关 → 反射关 → 后处理全关。
 *   —— 通过把档位映射到渲染开关实现（档位越低，越靠后的项先关）。
 * 【红线】降档只改渲染开关与参数，**绝不改 DPR/RT 尺寸**（R01）。
 * 【演示】?demo=1 或 store.auto=false 时禁止自动升降档。
 */

import { useEffect } from 'react';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import { isDemoMode, useQualityStore, type QualityTier } from '@/store/useQualityStore';

/** 低帧阈值 */
const LOW_FPS = 50;
/** 高帧阈值 */
const HIGH_FPS = 58;
/** 降档所需连续低帧次数（2Hz 采样） */
const DOWN_SAMPLES = 2;
/** 升档所需连续高帧次数（2Hz 采样 ≈ 3s/次判定? 6s = 3 次） */
const UP_SAMPLES = 3;
/** 升档冷却（毫秒） */
const UP_COOLDOWN_MS = 30_000;

export function useQualityGovernor(): void {
  useEffect((): (() => void) => {
    let lowStreak = 0;
    let highStreak = 0;
    let lastUpgradeAt = 0;
    let timer: number | null = null;

    const sample = (): void => {
      const store = useQualityStore.getState();
      if (!store.auto || isDemoMode()) return;
      const fps = telemetryTransientRef.glStats.fps;
      if (!Number.isFinite(fps) || fps <= 0) return;

      if (fps < LOW_FPS) {
        lowStreak += 1;
        highStreak = 0;
      } else if (fps > HIGH_FPS) {
        highStreak += 1;
        lowStreak = 0;
      } else {
        lowStreak = 0;
        highStreak = 0;
      }

      if (lowStreak >= DOWN_SAMPLES && store.tier > 0) {
        store.setTier((store.tier - 1) as QualityTier, 'auto');
        lowStreak = 0;
      } else if (
        highStreak >= UP_SAMPLES &&
        store.tier < 3 &&
        performance.now() - lastUpgradeAt > UP_COOLDOWN_MS
      ) {
        store.setTier((store.tier + 1) as QualityTier, 'auto');
        highStreak = 0;
        lastUpgradeAt = performance.now();
      }
    };

    timer = window.setInterval(sample, 2000);
    return (): void => {
      if (timer !== null) window.clearInterval(timer);
    };
  }, []);
}