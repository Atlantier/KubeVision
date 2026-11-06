'use client';

/**
 * KubeVision AI — 顶部中控台导航栏（TopBar）
 *
 * 【设计意图】三段式战术布局：左（品牌 + 健康分环形徽标）/
 * 中（Pod 状态过滤胶囊组 + QPS 看板 + 混沌横幅）/ 右（双模拨片 +
 * 注入混沌战术按钮 + 性能 HUD 开关）。深空赛博美学：
 * bg-slate-900/75 + backdrop-blur-md + border-slate-800（AGENTS.md 第 5 条）。
 *
 * 【渲染性能契约】全部状态经 zustand 细粒度选择器订阅（每字段独立 selector），
 * 遥测高频轨（useFrame 消费的 Float32Array）与本组件完全隔离——
 * TopBar 仅读取 ≥1s 节流的 snapshotSummary，重渲染频率天然受控。
 *
 * 【响应式】中部胶囊组 overflow-x-auto 横向滚动适配小屏；
 * 左右两翼在 < 768px 时收敛为图标 + 关键数值，隐藏次要文案。
 */

import { useCallback, useMemo, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  Boxes,
  Gauge,
  OctagonAlert,
  Radar,
  Radio,
  Terminal,
  X,
  Zap,
} from 'lucide-react';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import type { ChaosScenario, PodStatus, TelemetrySnapshot } from '@/types/cluster';
import type { ConnectionMode, StatusFilter } from '@/types/store';
import type {
  ChaosBannerProps,
  HealthRingBadgeProps,
  HealthTier,
  ModeToggleProps,
  QpsBoardProps,
  StatusFilterOption,
  StatusFilterPillProps,
} from '@/types/layout';

/* ========================================================================== */
/* 模块级常量（视觉分级阈值 / 过滤胶囊静态表 / 混沌场景中文名）                    */
/* ========================================================================== */

/** 版本徽标文案（产品迭代号，集中定义防多处漂移） */
const VERSION_BADGE = 'v2.4-Edge';

/** 健康分翠绿档下限：score ≥ 85 → healthy（emerald） */
const HEALTH_TIER_HEALTHY_MIN = 85;

/** 健康分琥珀档下限：60 ≤ score ≤ 84 → warning（amber）；< 60 → critical（rose 闪烁） */
const HEALTH_TIER_WARNING_MIN = 60;

/**
 * 健康分 → 视觉分档纯函数（阈值契约见 layout.ts HealthTier JSDoc）。
 * 提取为独立函数供 TopBar 与后续 HUD 仪表复用，阈值只此一处。
 */
export function resolveHealthTier(score: number): HealthTier {
  if (score >= HEALTH_TIER_HEALTHY_MIN) return 'healthy';
  if (score >= HEALTH_TIER_WARNING_MIN) return 'warning';
  return 'critical';
}

/** 分档 → 环形描边/文本/辉光样式映射（Tailwind 类经 cn 合并，currentColor 驱动 SVG） */
const TIER_RING_CLASS: Readonly<Record<HealthTier, string>> = {
  healthy: 'text-emerald-400',
  warning: 'text-amber-400',
  critical: 'text-rose-500 animate-glow-pulse',
};

/** 分档 → 徽标外发光阴影（与 tailwind.config.ts shadow-glow-* 令牌一致） */
const TIER_GLOW_CLASS: Readonly<Record<HealthTier, string>> = {
  healthy: 'shadow-glow-emerald',
  warning: '',
  critical: 'shadow-glow-rose',
};

/**
 * Pod 状态过滤胶囊静态表（数据驱动渲染，新增状态只改表不改 JSX）。
 * 需求契约五胶囊：ALL / Running / Pending / CrashLoopBackOff / OOMKilled；
 * Terminating 为过渡态不设独立过滤（其 Pod 仍出现在 ALL 中）。
 */
const STATUS_FILTER_OPTIONS: readonly StatusFilterOption[] = [
  { filter: 'ALL', label: 'ALL' },
  { filter: 'Running', label: 'Running', status: 'Running' },
  { filter: 'Pending', label: 'Pending', status: 'Pending' },
  { filter: 'CrashLoopBackOff', label: 'CrashLoop', status: 'CrashLoopBackOff' },
  { filter: 'OOMKilled', label: 'OOMKilled', status: 'OOMKilled' },
];

/** 胶囊常态/激活态样式基类（受控视觉，active 由父层比对 Store 得出） */
const PILL_BASE_CLASS =
  'shrink-0 cursor-pointer select-none rounded-full border px-3 py-1 font-mono text-[11px] tracking-wide transition-colors duration-150';

/** 混沌场景 → 中文短名映射（横幅展示 [场景名] 的可读化投影） */
const CHAOS_LABEL: Readonly<Record<Exclude<ChaosScenario, 'NONE'>, string>> = {
  POD_OOM_SWARM: 'POD_OOM_SWARM · OOM 风暴',
  NODE_CPU_SPIKE: 'NODE_CPU_SPIKE · CPU 尖峰',
  NET_PACKET_LOSS: 'NET_PACKET_LOSS · 网络丢包',
};

/* ========================================================================== */
/* 子组件：健康分环形进度徽标                                                    */
/* ========================================================================== */

/**
 * HealthRingBadge —— SVG 双圆环健康分徽标。
 *
 * 【核心数学】环半径 r 由外径与描边宽推导：r = (size − strokeWidth) / 2；
 * 周长 C = 2πr；进度弧长经 strokeDasharray = C 与
 * strokeDashoffset = C × (1 − score/100) 表达——分数越高，
 * dashoffset 越小，可见弧越长。环体旋转 −90°（transform rotate）使
 * 0% 起点位于 12 点方向，符合仪表直觉。
 *
 * 【色彩链路】SVG stroke 取 currentColor，由外层 span 的 TIER_RING_CLASS
 * 文本色驱动：emerald(≥85) / amber(60~84) / rose+闪烁(<60)，
 * 单一色彩事实源，critical 档的 animate-glow-pulse 同时作用于文本与辉光。
 */
export function HealthRingBadge({
  score,
  size = 44,
  strokeWidth = 3.5,
  showLabel = false,
}: HealthRingBadgeProps) {
  // 防御性 clamp：越界分数（NaN/负数/>100）不会击穿 dashoffset 计算
  const clamped = Number.isNaN(score) ? 0 : Math.min(100, Math.max(0, Math.round(score)));
  const tier = resolveHealthTier(clamped);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped / 100);

  return (
    <div className="flex items-center gap-2" role="img" aria-label={`集群健康分 ${clamped} / 100`}>
      <span className={cn('relative inline-flex', TIER_GLOW_CLASS[tier], 'rounded-full')}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          {/* 底环轨道：slate-800，与面板描边同色系 */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-slate-800"
          />
          {/* 前景进度环：currentColor 继承分档文本色，端点圆角 */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className={cn('stroke-current transition-[stroke-dashoffset] duration-700 ease-out', TIER_RING_CLASS[tier])}
          />
        </svg>
        {/* 环心分数（等宽字体，两位对齐防抖动） */}
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center font-mono text-[11px] font-bold tabular-nums',
            TIER_RING_CLASS[tier],
          )}
        >
          {clamped}
        </span>
      </span>
      {showLabel ? (
        <span className={cn('font-mono text-[10px] uppercase tracking-wider', TIER_RING_CLASS[tier])}>
          health
        </span>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* 子组件：Pod 状态过滤胶囊                                                     */
/* ========================================================================== */

/**
 * StatusFilterPill —— 单个受控过滤胶囊（含实时计数角标）。
 *
 * 激活态以主题青色描边 + 青色辉光强调；计数为 0 且非 ALL 时降透明度，
 * 视觉引导用户注意「当前过滤无命中」。
 */
export function StatusFilterPill({ filter, label, count, active, onSelect }: StatusFilterPillProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(filter)}
      className={cn(
        PILL_BASE_CLASS,
        active
          ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-300 shadow-glow-cyan'
          : 'border-slate-700/70 bg-slate-800/40 text-slate-400 hover:border-slate-600 hover:text-slate-200',
        !active && count === 0 && filter !== 'ALL' && 'opacity-45',
      )}
    >
      {label}
      <span className={cn('ml-1.5 tabular-nums', active ? 'text-cyan-400/80' : 'text-slate-500')}>
        {count}
      </span>
    </button>
  );
}

/* ========================================================================== */
/* 子组件：混沌横幅 / QPS 看板 / 模式拨片                                        */
/* ========================================================================== */

/**
 * ChaosBanner —— 混沌演练激活横幅（红色闪烁 + 一键终止叉号）。
 *
 * 【渲染契约】仅 activeChaos !== 'NONE' 时由父层渲染；本体以
 * framer-motion 弹性入场（layoutId 保证与相邻元素的重排过渡平滑），
 * animate-glow-pulse 提供持续闪烁的告警呼吸感。
 * 场景名经 CHAOS_LABEL 映射附加中文释义（答辩可读性）。
 */
export function ChaosBanner({ scenario, onTerminate }: ChaosBannerProps) {
  const label = scenario === 'NONE' ? 'NONE' : CHAOS_LABEL[scenario];
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={{ type: 'spring', stiffness: 420, damping: 28 }}
      role="alert"
      className="flex shrink-0 items-center gap-2 rounded-full border border-rose-500/60 bg-rose-500/15 px-3 py-1 shadow-glow-rose"
    >
      <OctagonAlert className="h-3.5 w-3.5 animate-glow-pulse text-rose-400" aria-hidden />
      <span className="animate-glow-pulse font-mono text-[11px] font-bold tracking-wider text-rose-300">
        CHAOS ACTIVE: {label}
      </span>
      <button
        type="button"
        aria-label="一键终止混沌演练"
        title="一键终止演练（activeChaos → NONE）"
        onClick={onTerminate}
        className="ml-0.5 rounded-full p-0.5 text-rose-300/80 transition-colors hover:bg-rose-500/30 hover:text-rose-100"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </motion.div>
  );
}

/**
 * QpsBoard —— 实时 QPS 吞吐数字看板。
 *
 * toLocaleString 千分位格式化（12,850），tabular-nums 等宽数字防逐帧抖动；
 * Activity 图标以主题青色微脉冲呼应「流量正在观测」的语义。
 */
export function QpsBoard({ qps }: QpsBoardProps) {
  const display = Number.isNaN(qps) ? '—' : Math.round(qps).toLocaleString('en-US');
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-700/70 bg-slate-800/40 px-3 py-1"
      title="集群入口总 QPS（来自最近一份遥测快照）"
    >
      <Activity className="h-3.5 w-3.5 text-cyan-400" aria-hidden />
      <span className="font-mono text-[11px] font-bold tabular-nums text-slate-100">{display}</span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">qps</span>
    </div>
  );
}

/**
 * ModeToggle —— Demo Synthetic / Live Tunnel 双模切换拨片。
 *
 * 【交互契约】受控二段式拨片：激活滑块以 framer-motion layoutId
 * 在两档间弹性滑动（丝滑切换的物理感）；disabled 时整体降透明度并禁用指针。
 * Demo = 本地合成遥测引擎，Live = 真实集群 SSE 隧道（后续轮次接线）。
 */
export function ModeToggle({ mode, onChange, disabled = false }: ModeToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="数据源模式切换"
      className={cn(
        'relative flex rounded-full border border-slate-700/70 bg-slate-800/50 p-0.5',
        disabled && 'pointer-events-none opacity-45',
      )}
    >
      {(['demo', 'live'] as const satisfies readonly ConnectionMode[]).map((value) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(value)}
            className={cn(
              'relative z-10 flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors duration-200',
              active ? 'text-slate-950' : 'text-slate-400 hover:text-slate-200',
            )}
          >
            {active ? (
              <motion.span
                layoutId="mode-toggle-thumb"
                transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                className={cn(
                  'absolute inset-0 -z-10 rounded-full',
                  value === 'live' ? 'bg-emerald-400 shadow-glow-emerald' : 'bg-cyan-400 shadow-glow-cyan',
                )}
              />
            ) : null}
            {value === 'demo' ? <Boxes className="h-3 w-3" aria-hidden /> : <Radio className="h-3 w-3" aria-hidden />}
            <span className="hidden sm:inline">{value === 'demo' ? 'Demo Synthetic' : 'Live Tunnel'}</span>
            <span className="sm:hidden">{value === 'demo' ? 'Demo' : 'Live'}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ========================================================================== */
/* TopBar 主体                                                                 */
/* ========================================================================== */

/**
 * TopBar —— 中控台顶栏（品牌区 / 态势区 / 战术区 三段式）。
 *
 * 【订阅纪律】八个细粒度 selector 各取所需字段：任一字段变更只触发
 * 对应子树的重渲染比对，杜绝全量订阅；pods 计数经 useMemo 依赖
 * snapshotSummary.pods 引用（快照整体替换才失效，1Hz 上限）。
 */
export default function TopBar() {
  /* ---- 响应轨细粒度订阅 ---- */
  const snapshot = useClusterStore((s): TelemetrySnapshot => s.snapshotSummary);
  const statusFilter = useClusterStore((s): StatusFilter => s.statusFilter);
  const activeChaos = useClusterStore((s): ChaosScenario => s.activeChaos);
  const connectionMode = useClusterStore((s): ConnectionMode => s.connectionMode);
  const isPerfHudOpen = useClusterStore((s): boolean => s.isPerfHudOpen);
  const selectFilter = useClusterStore((s): ((filter: StatusFilter) => void) => s.setStatusFilter);
  const setChaos = useClusterStore((s): ((scenario: ChaosScenario) => void) => s.setActiveChaos);
  const setMode = useClusterStore((s): ((mode: ConnectionMode) => void) => s.setConnectionMode);
  const setChaosModalOpen = useClusterStore((s): ((open: boolean) => void) => s.setChaosModalOpen);
  const setPerfHudOpen = useClusterStore((s): ((open: boolean) => void) => s.setPerfHudOpen);

  /* ---- 派生数据：分状态计数（快照引用变更才重算） ---- */
  const countByStatus = useMemo((): Readonly<Record<PodStatus | 'ALL', number>> => {
    const counts: Record<PodStatus | 'ALL', number> = {
      ALL: snapshot.pods.length,
      Running: 0,
      Pending: 0,
      CrashLoopBackOff: 0,
      OOMKilled: 0,
      Terminating: 0,
    };
    for (const pod of snapshot.pods) counts[pod.status] += 1;
    return counts;
  }, [snapshot.pods]);

  /* ---- 战术回调（useCallback 稳定引用，避免子组件无谓重渲染） ---- */
  const handleTerminateChaos = useCallback((): void => {
    setChaos('NONE');
  }, [setChaos]);

  const handleInjectChaos = useCallback((): void => {
    // 打开混沌控制台模态框选择场景（模态框本体为后续轮次交付物）
    setChaosModalOpen(true);
  }, [setChaosModalOpen]);

  const handleTogglePerfHud = useCallback((): void => {
    setPerfHudOpen(!isPerfHudOpen);
  }, [isPerfHudOpen, setPerfHudOpen]);

  const healthScore = snapshot.clusterHealthScore;
  const chaosActive = activeChaos !== 'NONE';

  return (
    <header className="kv-panel relative z-30 flex h-14 shrink-0 items-center gap-3 rounded-none border-x-0 border-t-0 px-3 sm:px-4">
      {/* ============ 左翼：品牌 + 健康分环形徽标 ============ */}
      <div className="flex shrink-0 items-center gap-2.5">
        {/* 系统 Logo：Radar 雷达图标（态势感知语义）+ 青色辉光容器 */}
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-400/10 shadow-glow-cyan">
          <Radar className="h-[18px] w-[18px] text-cyan-400" aria-hidden />
        </span>
        <div className="hidden flex-col leading-none sm:flex">
          <span className="text-sm font-bold tracking-tight text-slate-50">
            KubeVision&nbsp;<span className="text-cyan-400">AI</span>
          </span>
          <span className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.25em] text-slate-500">
            situational awareness
          </span>
        </div>
        {/* 版本徽标 v2.4-Edge */}
        <span className="hidden rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 font-mono text-[11px] tracking-wider text-slate-400 md:inline-block">
          {VERSION_BADGE}
        </span>
        {/* 实时健康分环形徽标（≥85 翠绿 / 60~84 琥珀 / <60 红闪） */}
        <HealthRingBadge score={healthScore} />
      </div>

      {/* ============ 中翼：过滤胶囊组 + QPS + 混沌横幅（横向滚动） ============ */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {STATUS_FILTER_OPTIONS.map((option): ReactNode => (
          <StatusFilterPill
            key={option.filter}
            filter={option.filter}
            label={option.label}
            count={countByStatus[option.filter]}
            active={statusFilter === option.filter}
            onSelect={selectFilter}
          />
        ))}

        <QpsBoard qps={snapshot.totalQps} />

        {chaosActive ? (
          <ChaosBanner scenario={activeChaos} onTerminate={handleTerminateChaos} />
        ) : null}
      </div>

      {/* ============ 右翼：双模拨片 + 注入混沌 + 性能 HUD ============ */}
      <div className="flex shrink-0 items-center gap-2">
        <ModeToggle mode={connectionMode} onChange={setMode} />

        {/* 注入混沌战术按钮：红色 + Zap 图标，hover 辉光增强 */}
        <button
          type="button"
          onClick={handleInjectChaos}
          className="flex items-center gap-1.5 rounded-md border border-rose-500/50 bg-rose-500/15 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-rose-300 transition-all duration-150 hover:border-rose-400 hover:bg-rose-500/25 hover:shadow-glow-rose active:scale-95"
          title="打开混沌工程控制台，注入故障演练场景"
        >
          <Zap className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden lg:inline">Inject Chaos</span>
        </button>

        {/* 性能监控 HUD 开关（快捷键 Shift+P，监听器在 ShellLayout 全局挂载） */}
        <button
          type="button"
          onClick={handleTogglePerfHud}
          aria-pressed={isPerfHudOpen}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-all duration-150 active:scale-95',
            isPerfHudOpen
              ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-300 shadow-glow-cyan'
              : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:text-slate-200',
          )}
          title="性能监控 HUD（快捷键 Shift+P）"
        >
          {isPerfHudOpen ? <Gauge className="h-3.5 w-3.5" aria-hidden /> : <Terminal className="h-3.5 w-3.5" aria-hidden />}
          <span className="hidden xl:inline">Perf HUD</span>
        </button>
      </div>
    </header>
  );
}
