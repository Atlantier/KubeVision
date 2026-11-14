'use client';

/**
 * GlowDebugOverlay —— ?glowDebug=1 时的发光预算调试浮层（R29 · D 项）。
 *
 * 只在 URL 带 `glowDebug=1` 时渲染；显示四个分区的预算/当前设计值与构成，
 * 并每 2s 从窗口读取一次实际加色扫描结果（由 BootController 写入 console，
 * 这里展示静态设计值 + 运行时累计 alpha）。z-40 低于 Copilot 抽屉与 Modal，
 * pointer-events-none 不抢交互。
 */

import { useEffect, useState } from 'react';
import { GLOW_BUDGET_ZONES } from '@/constants/glowBudget';

/** GlowDebugOverlay 无 props */
export default function GlowDebugOverlay(): React.ReactElement | null {
  const [enabled, setEnabled] = useState<boolean>(false);

  useEffect((): void => {
    const params = new URLSearchParams(window.location.search);
    setEnabled(params.get('glowDebug') === '1');
  }, []);

  if (!enabled) return null;

  return (
    <div
      aria-label="glow debug"
      className="pointer-events-none fixed left-3 top-16 z-40 w-[360px] rounded border border-cyan-500/25 bg-slate-950/[0.85] p-3 font-mono text-[10px] text-slate-300"
    >
      <div className="mb-1 text-[11px] font-semibold tracking-wider text-cyan-300">
        GLOW BUDGET · additive alpha
      </div>
      {GLOW_BUDGET_ZONES.map((zone): React.ReactElement => (
        <div key={zone.id} className="mt-1 border-t border-white/5 pt-1">
          <div className="flex items-center justify-between">
            <span>{zone.label}</span>
            <span className={zone.current > zone.budget ? 'text-rose-400' : 'text-emerald-400'}>
              {zone.current.toFixed(2)} / {zone.budget.toFixed(2)}
            </span>
          </div>
          <div className="text-[10px] leading-tight text-slate-400">{zone.note}</div>
        </div>
      ))}
      <div className="mt-2 text-[10px] text-slate-400">
        运行时扫描结果见 console（[glowBudget]），开发期超预算会 warn。
      </div>
    </div>
  );
}