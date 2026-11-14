/**
 * KubeVision AI — 渲染预算与开发期巡检契约（R5 进阶）
 *
 * 【设计意图】将四档质量等级（T3/T2/T1/T0）的 Draw Call 预算与反射 Pass 占比
 * 上限固化为单一事实源，并在开发模式下每 2 秒自动巡检一次瞬态渲染指标：
 * 超预算时仅输出 `console.warn` 以暴露性能回归，绝不弹出 UI 报错或阻断渲染循环。
 */

import type { QualityTier } from '@/store/useQualityStore';

/** R5 进阶各质量档位总 Draw Call 上限预算 */
export const RENDER_DRAW_CALL_BUDGET: Readonly<Record<QualityTier, number>> = {
  3: 200,
  2: 140,
  1: 90,
  0: 50,
};

/** 反射 Pass 在总 Draw Call 中的预算占比上限（8%） */
export const RENDER_REFLECTION_RATIO_BUDGET = 0.08;

/** 开发期预算巡检采样周期（2 秒，避免刷屏） */
export const RENDER_BUDGET_SAMPLE_INTERVAL_MS = 2000;

/** 渲染预算评估结果 */
export interface RenderBudgetEvaluation {
  readonly tier: QualityTier;
  readonly drawCalls: number;
  readonly drawCallsReflection: number;
  readonly budget: number;
  readonly overBudget: boolean;
  readonly overBy: number;
  readonly reflectionRatio: number;
  readonly reflectionOverBudget: boolean;
}

/**
 * evaluateRenderBudget —— 按给定档位与当前帧统计评估是否超出 Draw Call / 反射预算。
 *
 * 【纯函数】无副作用，可在 Node 探针或浏览器测试中直接复用。
 */
export function evaluateRenderBudget(
  tier: QualityTier,
  drawCalls: number,
  drawCallsReflection: number,
): RenderBudgetEvaluation {
  const budget = RENDER_DRAW_CALL_BUDGET[tier];
  const safeCalls = Number.isFinite(drawCalls) && drawCalls >= 0 ? drawCalls : 0;
  const safeReflection = Number.isFinite(drawCallsReflection) && drawCallsReflection >= 0 ? drawCallsReflection : 0;
  const overBy = safeCalls > budget ? safeCalls - budget : 0;
  const reflectionRatio = safeCalls > 0 ? safeReflection / safeCalls : 0;
  return {
    tier,
    drawCalls: safeCalls,
    drawCallsReflection: safeReflection,
    budget,
    overBudget: safeCalls > budget,
    overBy,
    reflectionRatio,
    reflectionOverBudget: safeReflection > 0 && reflectionRatio > RENDER_REFLECTION_RATIO_BUDGET,
  };
}

/**
 * checkAndWarnRenderBudget —— 开发期 2 秒巡检触发器：超预算时仅写 console.warn。
 *
 * 【安全契约】
 * - 生产环境空操作；
 * - 未完成首帧渲染（drawCalls === 0）时不误报；
 * - 仅打印警告日志，不抛异常、不影响任何 UI 状态。
 */
export function checkAndWarnRenderBudget(
  tier: QualityTier,
  drawCalls: number,
  drawCallsReflection: number,
): RenderBudgetEvaluation {
  const result = evaluateRenderBudget(tier, drawCalls, drawCallsReflection);
  if (process.env.NODE_ENV === 'production' || result.drawCalls === 0) {
    return result;
  }

  if (result.overBudget || result.reflectionOverBudget) {
    const reflectionPct = (result.reflectionRatio * 100).toFixed(1);
    const reasons: string[] = [];
    if (result.overBudget) {
      reasons.push(`Draw Calls ${result.drawCalls} > T${result.tier} 预算 ${result.budget}（超出 +${result.overBy}）`);
    }
    if (result.reflectionOverBudget) {
      reasons.push(
        `反射占比 ${reflectionPct}% > 预算 ${(RENDER_REFLECTION_RATIO_BUDGET * 100).toFixed(0)}%（reflection=${result.drawCallsReflection}）`,
      );
    }
    console.warn(`[renderBudget] 超预算警告（仅 dev 观测，不阻断渲染）：${reasons.join('；')}`);
  }

  return result;
}
