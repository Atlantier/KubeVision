'use client';

/**
 * DemoReplayTimeline —— 路演事故回放时间轴（追问 2）
 *
 * 【设计意图】把录下来的 8~12 个关键帧做成一条可拖动的时间轴，讲完路演后
 * 评委追问"健康分到底从多少掉到多少"，直接拖到对应帧给他看。
 *
 * 【只读契约（本组件最重要的一条）】
 * 回放**绝不调用任何 Store 写动作**：不切混沌、不改选中、不动镜头。
 * 它只做一件事——把录下来的事实渲染成面板。
 * 原因很实际：演示现场已经复位到稳态，任何一次误写都会把画面搞乱，
 * 而"回放把现场搞坏"比"没有回放"严重得多。因此本文件不 import 任何
 * 写 action，只读 `useDemoRecorder` 的快照。
 *
 * 【退出方式】Esc 或点「退出回放」。Esc 是演示者最顺手的"退出"肌肉记忆。
 */

import { useEffect } from 'react';
import { ChevronDown, History, RotateCcw, X } from 'lucide-react';

import { cn } from '@/utils/cn';
import {
  enterDemoReplay,
  exitDemoReplay,
  setDemoReplayIndex,
  useDemoRecorder,
  type DemoCardState,
} from '@/utils/demoRecorder';

/** 卡片状态的中文标签 */
const CARD_STATE_LABEL: Readonly<Record<DemoCardState, string>> = {
  none: '未挂载',
  mounted: '已挂载待确认',
  executed: '已执行',
};

/** 混沌场景的中文标签（回放面板用，避免再拉一份映射表） */
const CHAOS_LABEL: Readonly<Record<string, string>> = {
  NONE: '无',
  POD_OOM_SWARM: 'OOM 内存溢出',
  NODE_CPU_SPIKE: '节点 CPU 尖刺',
  NET_PACKET_LOSS: 'CNI 网络丢包',
};

/**
 * DemoReplayTimeline —— 回放入口 + 回放面板。
 *
 * 未进入回放时只渲染一个入口按钮；进入回放后展开为底部面板。
 */
export default function DemoReplayTimeline(): React.ReactElement | null {
  const recorder = useDemoRecorder();
  const isReplaying = recorder.replayIndex !== null;

  /*
   * Esc 退出回放。
   *
   * 【为什么挂在 window 而不是面板上】演示者按 Esc 时焦点可能停在
   * range 滑块或按钮上，挂在面板上会因事件冒泡路径不同而失效。
   * 仅在回放态才注册，避免长期占用 Esc。
   */
  useEffect((): (() => void) | undefined => {
    if (!isReplaying) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      exitDemoReplay();
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isReplaying]);

  /* 没有录像就不占位 */
  if (recorder.frames.length === 0) return null;

  const currentIndex = recorder.replayIndex ?? 0;
  const frame = recorder.frames[Math.min(currentIndex, recorder.frames.length - 1)];

  /* ---------- 未回放：只给一个入口 ---------- */
  if (!isReplaying) {
    return (
      <button
        type="button"
        onClick={enterDemoReplay}
        aria-label={`打开事故回放（已录 ${recorder.frames.length} 帧）`}
        title="事故回放（只读）"
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-slate-950/80 px-3 py-1 font-mono text-[10px] text-cyan-200 transition-colors hover:border-cyan-300/60 hover:text-cyan-100"
      >
        <History className="h-3 w-3" aria-hidden />
        事故回放
        <span className="text-[10px] text-cyan-400/70">{recorder.frames.length} 帧</span>
        <ChevronDown className="h-3 w-3 text-cyan-400/70" aria-hidden />
      </button>
    );
  }

  /* ---------- 回放面板 ---------- */
  if (frame === undefined) return null;

  return (
    <div
      role="region"
      aria-label="事故回放时间轴（只读）"
      className="pointer-events-auto w-full max-w-[46rem] rounded-lg border border-amber-400/40 bg-slate-950/92 px-3.5 py-2.5 shadow-[0_12px_36px_-8px_rgba(2,6,23,0.92)] backdrop-blur-md"
    >
      {/* 顶缘：回放态醒目标识 —— 琥珀色与运行态青色区分开 */}
      <span
        aria-hidden
        className="block h-px w-full"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, rgba(251,191,36,0.6) 30%, rgba(253,230,138,0.95) 50%, rgba(251,191,36,0.6) 70%, transparent 100%)',
        }}
      />

      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
        <span className="flex items-center gap-1.5 rounded border border-amber-400/50 bg-amber-400/12 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-amber-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" aria-hidden />
          回放中 · 只读
        </span>
        <span className="truncate font-mono text-[10px] text-slate-400">
          第 {currentIndex + 1} / {recorder.frames.length} 帧 · {(frame.tMs / 1000).toFixed(1)}s
        </span>
        <button
          type="button"
          onClick={exitDemoReplay}
          aria-label="退出事故回放（Esc）"
          title="退出回放（Esc）"
          className="ml-auto flex h-5 w-5 items-center justify-center rounded border border-white/[0.10] bg-white/[0.04] text-slate-300 transition-colors hover:border-amber-400/50 hover:text-amber-200"
        >
          <X className="h-2.5 w-2.5" aria-hidden />
        </button>
      </div>

      {/* 时间轴滑块 */}
      <div className="flex items-center gap-2 px-3 pt-2">
        <RotateCcw className="h-3 w-3 shrink-0 text-amber-300/70" aria-hidden />
        <input
          type="range"
          min={0}
          max={recorder.frames.length - 1}
          step={1}
          value={currentIndex}
          onChange={(event): void => {
            setDemoReplayIndex(Number(event.currentTarget.value));
          }}
          aria-label="回放帧位置"
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-white/[0.10] accent-amber-400"
        />
      </div>

      {/* 帧事实 */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2 font-mono text-[10px] sm:grid-cols-3">
        <Field label="阶段" value={frame.phaseBadge.length > 0 ? frame.phaseBadge : '—'} />
        <Field label="混沌" value={CHAOS_LABEL[frame.activeChaos] ?? frame.activeChaos} />
        <Field
          label="选中实体"
          value={frame.selectedEntityId === null ? '全景' : frame.selectedEntityId.replace(/^node-/, '')}
        />
        <Field
          label="受害 Pod"
          value={frame.victimIds.length === 0 ? '无' : `${frame.victimIds.length} 个`}
        />
        <Field
          label="健康分"
          value={String(Math.round(frame.healthScore))}
          tone={
            frame.healthScore >= 85 ? 'good' : frame.healthScore >= 65 ? 'warn' : 'bad'
          }
        />
        <Field label="动作卡" value={CARD_STATE_LABEL[frame.cardState]} />
      </div>

      {/* 当时字幕（可能为空，空则不占高度） */}
      {frame.narration.length > 0 ? (
        <div className="truncate border-t border-white/[0.05] px-3 py-1.5 text-[10px] text-slate-300">
          {frame.narration}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Field —— 回放面板里的"标签 + 值"单元。
 *
 * @param props.label 标签
 * @param props.value 值
 * @param props.tone  健康分颜色档位（仅健康分使用）
 */
function Field({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'good' | 'warn' | 'bad';
}): React.ReactElement {
  return (
    <span className="flex items-baseline gap-1.5 truncate">
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <span
        className={cn(
          'truncate',
          tone === 'good'
            ? 'text-emerald-300'
            : tone === 'warn'
              ? 'text-amber-300'
              : tone === 'bad'
                ? 'text-rose-300'
                : 'text-slate-200',
        )}
      >
        {value}
      </span>
    </span>
  );
}