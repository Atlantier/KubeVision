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

/** 小屏自动降档阈值：宽度 < 640px 或视口面积 < 600,000 px² */
export const COMPACT_VIEWPORT_MIN_WIDTH = 640;
export const COMPACT_VIEWPORT_MIN_AREA = 600_000;

/**
 * 判定当前视口是否处于受限小屏（自动模式下限缩重装饰特效，保留全部故障语义与截图能力）。
 */
export function isCompactViewport(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  return width < COMPACT_VIEWPORT_MIN_WIDTH || width * height < COMPACT_VIEWPORT_MIN_AREA;
}

/** 质量状态 */
interface QualityState {
  /** 当前档位 */
  readonly tier: QualityTier;
  /** 是否为自动治理 */
  readonly auto: boolean;
  /** 最后一次设置的来源 */
  readonly source: QualitySource;
  /** 小屏视口自动降载标记（仅影响 auto 模式的上限） */
  readonly viewportConstrained: boolean;
  /** 设置档位 */
  setTier: (tier: QualityTier, source: QualitySource) => void;
  /** 开关自动治理 */
  setAuto: (auto: boolean) => void;
  /** 同步小屏降载状态 */
  setViewportConstrained: (constrained: boolean) => void;
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
  if (manual === 'off') return { tier: 0, source: 'url' };
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
  viewportConstrained: false,
  setTier: (tier, source): void => set({ tier, source }),
  setAuto: (auto): void => set({ auto }),
  setViewportConstrained: (constrained): void =>
    set((state): QualityState =>
      state.viewportConstrained === constrained ? state : { ...state, viewportConstrained: constrained },
    ),
}));