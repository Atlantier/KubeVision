/**
 * KubeVision AI — 质量档位状态（R29 · F 项，M1）
 *
 * 【为什么非持久化】质量档位是"本次会话的运行时决策"，刷新后应重新探测；
 * 持久化反而会让上次的降档结果污染新会话。
 *
 * 【三档语义】tier 3 = 全特效，2 = 保留后处理/关 DoF，1 = 基础，
 * 0 = 后处理全关。URL `?quality=high|balanced|low` 为手动覆盖；
 * 演示/路演模式（?demo=1）禁止自动升降档。
 */

import { create } from 'zustand';

/** 质量档位：0 最低、3 最高 */
export type QualityTier = 0 | 1 | 2 | 3;

/** 档位来源 */
export type QualitySource = 'auto' | 'url' | 'hud';

/** 质量状态 */
interface QualityState {
  /** 当前档位 */
  readonly tier: QualityTier;
  /** 是否为自动治理 */
  readonly auto: boolean;
  /** 最后一次设置的来源 */
  readonly source: QualitySource;
  /** 设置档位 */
  setTier: (tier: QualityTier, source: QualitySource) => void;
  /** 开关自动治理 */
  setAuto: (auto: boolean) => void;
}

/**
 * 从 URL 解析初始档位。
 *
 * @returns 档位与来源
 */
export function resolveInitialQuality(): { tier: QualityTier; source: QualitySource } {
  if (typeof window === 'undefined') return { tier: 3, source: 'auto' };
  const params = new URLSearchParams(window.location.search);
  const manual = params.get('quality');
  if (manual === 'low') return { tier: 1, source: 'url' };
  if (manual === 'balanced') return { tier: 2, source: 'url' };
  if (manual === 'high') return { tier: 3, source: 'url' };
  return { tier: 3, source: 'auto' };
}

/** 是否演示模式（禁止自动升降档） */
export function isDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('demo') === '1';
}

const initial = resolveInitialQuality();

export const useQualityStore = create<QualityState>((set) => ({
  tier: initial.tier,
  auto: initial.source === 'auto' && !isDemoMode(),
  source: initial.source,
  setTier: (tier, source): void => set({ tier, source }),
  setAuto: (auto): void => set({ auto }),
}));