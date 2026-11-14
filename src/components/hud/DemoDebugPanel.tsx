'use client';

/**
 * DemoDebugPanel —— 路演可观测性自检面板（追问 3）
 *
 * 【解决什么问题】排练时最常遇到的不是"报错"，而是**沉默的卡顿**：
 * 字幕停了、进度条不动、也不知道卡在"等 AI 流"还是"等动作卡"。
 * 这个面板把引擎内部状态与 effects 调用序列直接摊在屏幕上，
 * 排练者不用开 DevTools 就能判断"最后一步是 awaitCard → 卡在等卡片"。
 *
 * 【为什么仅 ?demoDebug=1 显示】
 * 1. 它展示的是引擎内部字段（phaseStartedAt / deadline / timerCount），
 *    对评委没有意义，反而干扰演示画面；
 * 2. effects 序列会泄露编排细节，彩排看可以，正式演示不该露出；
 * 3. 默认关闭也就不影响任何既有视觉与性能预算。
 *
 * 【为什么不走 Store】追踪数据在导演模块里以环形缓冲存在，写进 Store 会让
 * 每次 effects 调用都触发一次全量订阅者重渲染。这里让面板跟着导演快照
 * （约 8Hz）刷新，并在每次刷新时直接读模块内缓冲，成本可控。
 */

import { useEffect, useState } from 'react';

import { Z_CLASS } from '@/constants/zIndex';
import { cn } from '@/utils/cn';
import {
  getDemoEffectTrace,
  PACING_LABEL,
  useDemoDirector,
} from '@/utils/demoDirector';

/**
 * DemoDebugPanel —— 自检面板主体。
 *
 * @returns 非调试模式下渲染 null
 */
export default function DemoDebugPanel(): React.ReactElement | null {
  /*
   * 【为什么要一个 mounted 状态】isDebugAvailable 依赖 window.location，
   * 服务端渲染时不存在；直接读会导致 hydration mismatch。
   * 先渲染 null，挂载后再判断，两端首帧一致。
   */
  const [enabled, setEnabled] = useState(false);
  useEffect((): void => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    setEnabled(params.get('demoDebug') === '1');
  }, []);

  const demo = useDemoDirector();

  /*
   * 【R3 · 渲染纯度】nowMs 由 Effect 定时器写入，render 体内不再读 Date.now()。
   * 旧实现每次渲染现读时钟：StrictMode 双渲染/并发重放时同一帧产出两个值，
   * 是不纯渲染（水合与并发安全的隐患）。250ms 节拍对「秒级剩余 / 0.1s 阶段已过」
   * 的调试显示足够，且面板仅 ?demoDebug=1 挂载，成本可忽略。
   */
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect((): (() => void) | undefined => {
    if (!enabled) return undefined;
    setNowMs(Date.now());
    const timer = setInterval((): void => setNowMs(Date.now()), 250);
    return (): void => clearInterval(timer);
  }, [enabled]);

  if (!enabled) return null;

  const trace = getDemoEffectTrace();
  const recent = trace.slice(-12).reverse();

  /* deadline 剩余秒数（仅事件驱动阶段会被填上；时钟未就绪时显示 —） */
  const deadlineRemainSec =
    demo.phaseDeadline === null || nowMs === null
      ? null
      : Math.max(0, Math.ceil((demo.phaseDeadline - nowMs) / 1000));

  /* 距本阶段开始已过秒数 */
  const phaseAgeSec =
    demo.phaseStartedAt === null || nowMs === null
      ? null
      : Math.max(0, Math.round((nowMs - demo.phaseStartedAt) / 100) / 10);

  return (
    <div
      aria-label="路演可观测性自检面板"
      className={cn(
        'pointer-events-none fixed bottom-[10.5rem] left-5 w-[min(19rem,calc(100vw-2.5rem))] select-none rounded border border-cyan-400/25 bg-slate-950/[0.88] p-2 font-mono text-[10px] leading-relaxed text-slate-300',
        Z_CLASS.HUD_OVERLAY,
      )}
      style={{ boxShadow: '0 8px 28px rgba(2,6,23,0.7)' }}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="tracking-[0.18em] text-cyan-300/90">DEMO · OBSERVE</span>
        <span
          className={cn(
            'rounded px-1 py-[1px] text-[10px] uppercase tracking-wider',
            demo.status === 'running'
              ? 'bg-emerald-400/[0.15] text-emerald-300'
              : demo.status === 'paused'
                ? 'bg-amber-400/[0.15] text-amber-300'
                : demo.status === 'finished'
                  ? 'bg-cyan-400/[0.15] text-cyan-300'
                  : 'bg-white/[0.06] text-slate-400',
          )}
        >
          {demo.status}
        </span>
      </div>

      {/* ---- 阶段与时间 ---- */}
      <Row label="阶段" value={`${demo.phaseIndex + 1}/4 · ${demo.badge || '—'}`} />
      <Row label="节奏" value={`${PACING_LABEL[demo.pacing]} · ${Math.round(demo.durationMs / 1000)}s`} />
      <Row
        label="进度"
        value={`${(demo.elapsedMs / 1000).toFixed(1)}s (${Math.round(demo.progress * 100)}%)`}
      />
      <Row label="阶段已过" value={phaseAgeSec === null ? '—' : `${phaseAgeSec}s`} />
      <Row
        label="deadline"
        value={deadlineRemainSec === null ? '—（无硬截止）' : `剩 ${deadlineRemainSec}s`}
        tone={deadlineRemainSec !== null && deadlineRemainSec <= 5 ? 'warn' : 'normal'}
      />
      <Row
        label="断点"
        value={demo.awaitingNarratorAdvance ? '等待按空格' : '否'}
        tone={demo.awaitingNarratorAdvance ? 'warn' : 'normal'}
      />
      {demo.preflightError !== null ? (
        <Row label="预检" value={demo.preflightError} tone="bad" />
      ) : null}

      {/* ---- effects 调用序列 ---- */}
      <div className="mt-1.5 border-t border-white/[0.07] pt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">
        effects 调用序列（新→旧）
      </div>
      <div className="mt-0.5 space-y-[1px]">
        {recent.length === 0 ? (
          <div className="text-slate-500">（尚无调用，先启动一套剧本）</div>
        ) : (
          recent.map((entry, i): React.ReactNode => (
            <div
              key={`trace-${entry.atMs}-${i}`}
              className="flex items-baseline gap-1.5 truncate"
            >
              <span className="w-9 shrink-0 text-right tabular-nums text-slate-500">
                {(entry.atMs / 1000).toFixed(1)}s
              </span>
              <span className={i === 0 ? 'shrink-0 text-cyan-200' : 'shrink-0 text-slate-400'}>
                {entry.name}
              </span>
              <span className="truncate text-slate-500">{entry.detail}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Row —— 面板中的"标签 + 值"行。
 *
 * @param props.label 标签
 * @param props.value 值
 * @param props.tone  告警色（warn 琥珀 / bad 玫红）
 */
function Row({
  label,
  value,
  tone = 'normal',
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'normal' | 'warn' | 'bad';
}): React.ReactElement {
  return (
    <div className="flex items-baseline gap-1.5 truncate">
      <span className="w-12 shrink-0 text-slate-500">{label}</span>
      <span
        className={cn(
          'truncate',
          tone === 'warn' ? 'text-amber-300' : tone === 'bad' ? 'text-rose-300' : 'text-slate-200',
        )}
      >
        {value}
      </span>
    </div>
  );
}