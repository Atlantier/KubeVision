'use client';

/**
 * KubeVision AI — 极客事件流终端（TerminalEcho）
 *
 * 【设计意图】位于左侧 3D 视口底部的半透明可折叠事件流：默认展开 h-32，
 * 点击折叠为 h-8 状态栏（仅显示最新一行 + 行数徽标）。实时滚动打印
 * terminalLogs，按 [WARN] / [ERR] / [CHAOS-MESH] / [KUBE-CONTROLLER] /
 * [EDGE-WASM] / [MCP-ROUTER] 前缀自动高亮七种语义色调，
 * 复刻真实 NOC（网络作战中心）控制台的视觉语言。
 *
 * 【pointer-events 契约】外层容器显式 pointer-events-auto——本组件悬浮于
 * 3D 画布之上，而画布外层包裹层（ShellLayout 视口槽）为保护 R3F 射线拾取
 * 可能设 pointer-events-none，终端必须自行恢复指针交互（滚动/点击折叠/清空）。
 *
 * 【层级与避让契约】终端显式声明 z-10（位于相机工具条 z-20 之下、画布之上），
 * 且挂载类名以 right-[74px] 取代满宽的 inset-x-3：工具条占据 bottom-3 right-3
 * （宽 50 + 右距 12 ≈ 62px），若终端仍延伸到右边界，两者会在右下角形成
 * 约 50×128 的重叠区——工具条压在日志滚动区与 clear 按钮上方，既遮挡内容
 * 又抢走该区域点击。右让 74px（12 右距 + 50 宽 + 12 间隙）使二者并排不相交。
 *
 * 【滚动性能契约】日志到达时以「scrollTop 直接赋值」滚动到底部，
 * 而非 scrollIntoView（后者会触发布局抖动且可能被浏览器平滑滚动策略延迟）。
 * 自动跟随仅在用户未向上翻阅时生效（贴底判定阈值 24px），
 * 保证人工回看历史时不被新日志强行拽走。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import type { TerminalLineProps, TerminalEchoProps, TerminalLogTone, TerminalToneRule } from '@/types/layout';

/* ========================================================================== */
/* 日志色调分类规则（静态表，按严重度降序首个命中）                                */
/* ========================================================================== */

/**
 * 前缀 → 色调映射规则表（匹配契约见 layout.ts TerminalToneRule JSDoc：
 * includes 匹配 + 严重度降序 + 首个命中返回）。
 *
 * 排列顺序即优先级：ERR > WARN > CHAOS-MESH > KUBE-CONTROLLER >
 * EDGE-WASM > MCP-ROUTER；全部未命中兜底 info。
 */
const TONE_RULES: readonly TerminalToneRule[] = [
  { prefix: '[ERR]', tone: 'err' },
  { prefix: '[WARN]', tone: 'warn' },
  { prefix: '[CHAOS-MESH]', tone: 'chaos' },
  { prefix: '[KUBE-CONTROLLER]', tone: 'controller' },
  { prefix: '[EDGE-WASM]', tone: 'edge' },
  { prefix: '[MCP-ROUTER]', tone: 'router' },
];

/**
 * 色调 → Tailwind 文本类映射（配色契约见 layout.ts TerminalLogTone JSDoc）。
 * chaos 用 fuchsia（品红）刻意区别于 err 的 rose 红：演练是「受控的假故障」，
 * 视觉上必须与真实崩溃区分，防止值班人员误读。
 */
const TONE_TEXT_CLASS: Readonly<Record<TerminalLogTone, string>> = {
  err: 'text-rose-400',
  warn: 'text-amber-300',
  chaos: 'text-fuchsia-400',
  controller: 'text-cyan-300',
  edge: 'text-emerald-300',
  router: 'text-sky-300',
  info: 'text-slate-400',
};

/**
 * classifyTerminalLine —— 按前缀规则表分类日志行色调（纯函数）。
 *
 * @param line 完整日志行（形如 'HH:mm:ss [PREFIX] message'）
 * @returns 命中的语义色调；无命中返回 'info'
 */
export function classifyTerminalLine(line: string): TerminalLogTone {
  for (const rule of TONE_RULES) {
    if (line.includes(rule.prefix)) return rule.tone;
  }
  return 'info';
}

/* ========================================================================== */
/* 子组件：单行日志                                                            */
/* ========================================================================== */

/** TerminalLine —— 单行渲染（等宽字体 + 语义色 + hover 行高亮） */
export function TerminalLine({ line, tone }: TerminalLineProps) {
  return (
    <p
      className={cn(
        'whitespace-pre-wrap break-all px-3 py-px font-mono text-[11px] leading-[1.6] transition-colors hover:bg-slate-100/5',
        TONE_TEXT_CLASS[tone],
      )}
    >
      {line}
    </p>
  );
}

/* ========================================================================== */
/* TerminalEcho 主体                                                           */
/* ========================================================================== */

/**
 * TerminalEcho —— 半透明可折叠极客事件流终端。
 *
 * 【渲染性能】memoized lines 依赖 terminalLogs 数组引用（Store FIFO 更新才失效）；
 * 单行组件无内部状态，200 行上限下 DOM 节点数受控（无需虚拟滚动）。
 */
export default function TerminalEcho({ className, defaultCollapsed = false }: TerminalEchoProps) {
  /* ---- Store 细粒度订阅 ---- */
  const terminalLogs = useClusterStore((s): string[] => s.terminalLogs);
  /* 【只清屏，不动持久化数据】详见 store.clearTerminalLogs 注释：
     此前误用 clearPersistedHistory 会连带清掉 connectionMode /
     totalMaskedSecrets / remediationHistory，属数据丢失事故。 */
  const clearTerminalLogs = useClusterStore((s): (() => void) => s.clearTerminalLogs);

  /* ---- 折叠态（本地 UI 状态，非持久化——折叠偏好无跨会话价值） ---- */
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed);

  /* ---- 滚动容器与自动跟随 ---- */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 用户是否贴底（贴底才自动跟随新日志；向上翻阅时冻结） */
  const stickToBottomRef = useRef<boolean>(true);

  /** 预分类：每行 → { line, tone }（引用级 memo，日志数组不变不重算） */
  const classifiedLines = useMemo(
    (): Array<{ readonly line: string; readonly tone: TerminalLogTone }> =>
      terminalLogs.map((line): { line: string; tone: TerminalLogTone } => ({
        line,
        tone: classifyTerminalLine(line),
      })),
    [terminalLogs],
  );

  /**
   * 滚动贴底判定：距底部 < 24px 视为「用户正在跟随实时流」。
   * onScroll 为高频事件，内部只做一次 ref 布尔写入（无 setState、无重渲染）。
   */
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  /** 新日志到达且用户贴底时，直接赋值 scrollTop 滚至底部（展开态才需要） */
  useEffect(() => {
    if (collapsed) return;
    const el = scrollRef.current;
    if (el !== null && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [classifiedLines, collapsed]);

  /** 折叠 → 展开时立即滚到底部并恢复自动跟随（错过展开动画期的新日志） */
  useEffect(() => {
    if (!collapsed) {
      stickToBottomRef.current = true;
      const el = scrollRef.current;
      if (el !== null) el.scrollTop = el.scrollHeight;
    }
  }, [collapsed]);

  /** 折叠态状态栏显示的最新一行（无日志时显示待机文案） */
  const latestLine = terminalLogs.length > 0 ? terminalLogs[terminalLogs.length - 1] : null;

  return (
    <div
      className={cn(
        'pointer-events-auto z-10 flex flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-950/80 backdrop-blur-md shadow-panel transition-[height] duration-300 ease-out',
        collapsed ? 'h-8' : 'h-32',
        className,
      )}
      aria-label="集群事件流终端"
    >
      {/* ============ 头部状态栏（恒 h-8，点击切换折叠） ============ */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-slate-800/80 bg-slate-900/60">
        <button
          type="button"
          onClick={(): void => setCollapsed((prev): boolean => !prev)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left transition-colors hover:bg-slate-100/5"
          aria-expanded={!collapsed}
          title={collapsed ? '展开事件流终端' : '折叠事件流终端'}
        >
          {collapsed ? (
            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
          )}
          <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-300">
            event&nbsp;stream
          </span>
          {/* 行数徽标 */}
          <span className="shrink-0 rounded-full border border-slate-700 bg-slate-800/80 px-1.5 font-mono text-[11px] tabular-nums text-slate-400">
            {terminalLogs.length}
          </span>
          {/* 折叠态：内联显示最新一行（截断），展开态隐藏 */}
          {collapsed && latestLine !== null ? (
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-mono text-[10px]',
                TONE_TEXT_CLASS[classifyTerminalLine(latestLine)],
              )}
            >
              {latestLine}
            </span>
          ) : null}
        </button>

        {/* 仅清屏：不触碰数据源偏好、脱敏计数与自愈审计历史 */}
        <button
          type="button"
          onClick={clearTerminalLogs}
          aria-label="清空终端日志"
          className="mr-2 flex shrink-0 items-center gap-1 rounded border border-slate-700/70 bg-slate-800/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-400 transition-colors hover:border-rose-500/50 hover:text-rose-300 active:scale-95"
          title="清空终端滚动日志（不影响数据源偏好、脱敏计数与自愈审计历史）"
        >
          <Trash2 className="h-3 w-3" aria-hidden />
          <span className="hidden sm:inline">清屏</span>
        </button>
      </div>

      {/* ============ 日志滚动区（展开态可见；折叠态高度归零） ============ */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={cn('min-h-0 flex-1 overflow-y-auto py-1', collapsed && 'invisible')}
      >
        {classifiedLines.length === 0 ? (
          <p className="px-3 py-1 font-mono text-[11px] text-slate-600">
            -- awaiting cluster events... (bootstrap complete, telemetry stream idle) --
          </p>
        ) : (
          classifiedLines.map((entry, index): ReactNode => (
            <TerminalLine key={`${index}-${entry.line.slice(0, 32)}`} line={entry.line} tone={entry.tone} />
          ))
        )}
      </div>
    </div>
  );
}
