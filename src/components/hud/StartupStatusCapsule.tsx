'use client';

/**
 * KubeVision AI — 系统启动状态胶囊（R41 · 首屏加载体验）
 *
 * 【解决什么】首屏原本有三条互不相关的 loading 文案（3D 画布骨架、右侧抽屉骨架、
 * 遥测连接状态），用户看到的是"三个互相不知道对方在干嘛的加载器"。本组件把
 * **WebGL 场景 / Copilot chunk / 遥测数据流** 三条启动状态合并成一个可折叠胶囊，
 * 全部就绪后自动收成一行小徽标，不再长期占用视觉。
 *
 * 【为什么用轮询而不是订阅】三条状态分属 Next dynamic loading、DOM 挂载与 zustand
 * 快照，没有统一事件源；200ms 轮询是成本最低、无需改造现有模块的做法（首屏期最多
 * 几十次 DOM 查询，就绪后立即停表）。
 *
 * 【可折叠】点击头部切换展开/收起；`aria-expanded` 暴露状态；
 * `?startupDebug=1` 时保持展开，便于截图与现场讲解。
 */

import { useEffect, useRef, useState } from 'react';
import { Z_CLASS } from '@/constants/zIndex';
import { useClusterStore } from '@/store/useClusterStore';
import { cn } from '@/utils/cn';

/** 单条启动状态 */
interface StartupItem {
  readonly key: 'webgl' | 'copilot' | 'telemetry';
  readonly label: string;
  readonly ready: boolean;
  readonly detail: string;
}

/** 轮询间隔（毫秒） */
const POLL_MS = 200;
/** 全部就绪后自动折叠延迟（毫秒） */
const AUTO_COLLAPSE_MS = 900;

/**
 * readStartupItems —— 读取三条启动状态（纯 DOM + store 快照）。
 *
 * @returns 三条状态
 */
function readStartupItems(): StartupItem[] {
  const canvasReady =
    typeof document !== 'undefined' &&
    document.querySelector('[aria-label="3D 集群拓扑视口"] canvas') !== null;
  const copilotSkeleton =
    typeof document !== 'undefined' && document.querySelector('[aria-label="AI 副驾加载中"]') !== null;
  const copilotReady =
    typeof document !== 'undefined' &&
    document.querySelector('[aria-label="AI Copilot 抽屉"]') !== null &&
    !copilotSkeleton;
  const snapshot = useClusterStore.getState().snapshotSummary;
  const telemetryReady = snapshot.nodes.length > 0 && snapshot.totalQps > 0;

  return [
    {
      key: 'webgl',
      label: 'WebGL 场景',
      ready: canvasReady,
      detail: canvasReady ? '已挂载' : '编译与实例化中',
    },
    {
      key: 'copilot',
      label: 'Copilot 分块',
      ready: copilotReady,
      detail: copilotReady ? '已加载' : '按需下载中',
    },
    {
      key: 'telemetry',
      label: '遥测数据流',
      ready: telemetryReady,
      detail: telemetryReady ? 'SSE 已流动' : '等待首帧快照',
    },
  ];
}

/** StartupStatusCapsule 组件 */
export default function StartupStatusCapsule(): React.ReactElement | null {
  const [items, setItems] = useState<StartupItem[]>(() => readStartupItems());
  const [expanded, setExpanded] = useState<boolean>(true);
  const [hidden, setHidden] = useState<boolean>(false);
  const collapsedOnceRef = useRef<boolean>(false);
  const mountedAtRef = useRef<number>(Date.now());

  useEffect((): (() => void) => {
    const debug =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('startupDebug') === '1';
    const timer = window.setInterval((): void => {
      const next = readStartupItems();
      setItems(next);
      const allReady = next.every((item): boolean => item.ready);
      /* 全部就绪且已展示过至少 1.2s → 自动折叠一次（不强制隐藏，用户仍可点开） */
      if (allReady && !collapsedOnceRef.current && Date.now() - mountedAtRef.current > 1200) {
        collapsedOnceRef.current = true;
        if (!debug) {
          window.setTimeout((): void => setExpanded(false), AUTO_COLLAPSE_MS);
        }
      }
      /* 就绪后再观察 3s 仍全绿 → 整枚胶囊淡出（避免长期占位） */
      if (allReady && Date.now() - mountedAtRef.current > 4200 && !debug) {
        setHidden(true);
      }
    }, POLL_MS);
    return (): void => window.clearInterval(timer);
  }, []);

  if (hidden) return null;

  const readyCount = items.filter((item): boolean => item.ready).length;
  const allReady = readyCount === items.length;
  const state = allReady ? 'ready' : 'loading';

  return (
    <div
      className={cn(
        'pointer-events-auto fixed bottom-[9.25rem] left-5 max-w-[calc(100vw-2.5rem)] lg:bottom-[7.5rem]',
        Z_CLASS.HUD_OVERLAY,
      )}
      data-startup-state={state}
      aria-label="系统启动状态"
      role="group"
    >
      <div className="kv-chip overflow-hidden rounded-lg border border-white/[0.075] bg-slate-950/[0.85]">
        <button
          type="button"
          onClick={(): void => setExpanded((open): boolean => !open)}
          aria-expanded={expanded}
          aria-controls="startup-status-list"
          className="flex min-h-[44px] w-full items-center gap-2 px-2.5 py-1.5 font-mono text-[10px] tracking-[0.08em] text-slate-300 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60 sm:min-h-0"
        >
          <span
            aria-hidden
            className={allReady ? 'h-1.5 w-1.5 rounded-full bg-emerald-400' : 'h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300'}
          />
          <span>{allReady ? '系统就绪' : '系统启动中'}</span>
          <span className="tabular-nums text-slate-400">
            {readyCount}/{items.length}
          </span>
          <span aria-hidden className="text-slate-400">
            {expanded ? '−' : '+'}
          </span>
        </button>

        {expanded ? (
          <ul id="startup-status-list" className="space-y-0.5 border-t border-white/[0.06] px-2.5 py-1.5">
            {items.map((item): React.ReactElement => (
              <li key={item.key} className="flex items-center gap-2 font-mono text-[10px]">
                <span aria-hidden className={item.ready ? 'text-emerald-400' : 'text-amber-300'}>
                  {item.ready ? 'OK' : '··'}
                </span>
                <span className="w-20 shrink-0 text-slate-400">{item.label}</span>
                <span className={item.ready ? 'text-slate-400' : 'text-amber-300/90'}>{item.detail}</span>
              </li>
            ))}
            <li className="flex items-center gap-2 font-mono text-[10px] text-slate-400">
              <span aria-hidden>··</span>
              <span className="w-20 shrink-0">端侧模型</span>
              <span>按需加载（未启用时不阻塞首屏）</span>
            </li>
          </ul>
        ) : null}
      </div>
      <p className="mt-1 max-w-[220px] font-mono text-[10px] leading-relaxed text-slate-400" aria-live="polite">
        {allReady ? '全部启动项就绪，可开始操作' : '启动项将在就绪后自动收起'}
      </p>
    </div>
  );
}