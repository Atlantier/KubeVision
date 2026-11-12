'use client';

/**
 * PresentStatusHud —— 演示模式下的极简状态胶囊（R32 · 追问 1）。
 *
 * 【为什么替换整个 Perf HUD】路演时观众只需要三件事：集群健康、告警数、
 * 入口 QPS。原 Perf HUD 的帧率/渲染路径/AI 预算等数据是给工程师看的，
 * 演示模式下由 CSS 隐藏，这里只呈现决策级指标。
 *
 * 数据来自 zustand 与瞬态轨（1Hz 更新），不进入 useFrame、不触发 3D 重渲染。
 */

import { useEffect, useState } from 'react';
import { useClusterStore } from '@/store/useClusterStore';
import { telemetryTransientRef } from '@/store/useTelemetryRef';

/** PresentStatusHud 无 props */
export default function PresentStatusHud(): React.ReactElement {
  const health = useClusterStore((s): number => s.snapshotSummary.clusterHealthScore);
  const alerts = useClusterStore((s): number => s.snapshotSummary.activeAlerts.length);
  const [qps, setQps] = useState<number>(0);

  useEffect((): (() => void) => {
    const timer = window.setInterval((): void => {
      setQps(Math.round(telemetryTransientRef.snapshot.totalQps));
    }, 1000);
    return (): void => window.clearInterval(timer);
  }, []);

  const tone = health >= 90 ? '#34d399' : health >= 70 ? '#fbbf24' : '#f43f5e';
  return (
    <div
      aria-label="演示状态"
      className="pointer-events-none absolute bottom-3 left-3 z-20 flex items-center gap-3 rounded-lg border border-cyan-400/25 bg-slate-950/85 px-3.5 py-2 font-mono text-xs text-slate-200 shadow-lg backdrop-blur-md"
    >
      <span className="flex items-center gap-1">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
        <span className="text-slate-400">健康</span>
        <span style={{ color: tone }}>{health}</span>
      </span>
      <span className={alerts > 0 ? 'text-rose-300' : 'text-slate-400'}>
        告警 <span className="text-slate-200">{alerts}</span>
      </span>
      <span className="text-slate-400">
        QPS <span className="text-cyan-300">{qps.toLocaleString('en-US')}</span>
      </span>
    </div>
  );
}