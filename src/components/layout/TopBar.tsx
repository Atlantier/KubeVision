'use client';

/**
 * KubeVision AI — 顶部中控台导航栏（TopBar）
 *
 * 【设计意图】对标 Linear / Datadog 的极简黑曜石顶栏，彻底去除早期版本
 * "满屏彩色圆角胶囊堆砌"的廉价 AI 模板感。核心改造原则：
 *
 * 1. **容器优先，胶囊退让**：5 个状态过滤项不再各自画边框，而是收进同一个
 *    深色凹槽底座，由一枚 Framer Motion 滑块指示当前选中。
 *    边框从 5 条降到 1 条——这是"模板感"与"产品感"最直接的分水岭。
 * 2. **激活态用亮度而非色相**：滑块是 `bg-white/[0.09]` 的微亮面片，
 *    不是高饱和实心色块。色彩只保留给**真正需要引起注意**的东西
 *    （故障计数、混沌告警、数据源状态点）。
 * 3. **裸露数字优于装饰盒子**：QPS 去掉外层方框，改为一条竖向细分割线 +
 *    等宽裸数字；数字本身就是仪表，再套一个框只是噪音。
 * 4. **克制的高级色**：稳态健康环用内敛的 emerald 细环，去掉刺眼外发光；
 *    青色仅保留在少量功能性提示上。
 *
 * 【三段式结构】
 * - 左翼：品牌图标 + 单行标题 ┃ 竖分割线 ┃ 紧凑健康环（32px）+ 分数
 * - 中翼：一体化分段过滤轨道 · QPS 裸字仪表 · ⌘K 命令面板触发器
 * - 右翼：黑曜石凹槽双模拨片 · 混沌演练二合一按钮 · 性能 HUD 开关
 *
 * 【渲染性能契约】全部状态经 zustand 细粒度选择器订阅（每字段独立 selector），
 * 遥测高频轨（useFrame 消费的 Float32Array）与本组件完全隔离——
 * TopBar 仅读取 ≥1s 节流的 snapshotSummary，重渲染频率天然受控。
 *
 * 【响应式】中翼横向滚动适配小屏；左右两翼在窄屏收敛为图标 + 关键数值。
 */

import { useCallback, useMemo, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  Boxes,
  Gauge,
  OctagonAlert,
  Radar,
  Radio,
  Search,
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
/* 模块级常量                                                                  */
/* ========================================================================== */

/** 健康分翠绿档下限：score ≥ 85 → healthy（emerald） */
const HEALTH_TIER_HEALTHY_MIN = 85;

/** 健康分琥珀档下限：60 ≤ score ≤ 84 → warning（amber）；< 60 → critical（rose） */
const HEALTH_TIER_WARNING_MIN = 60;

/** 顶栏健康环直径（px）——紧凑型，不喧宾夺主 */
const TOPBAR_HEALTH_RING_SIZE = 32;

/** 顶栏健康环描边宽度（px）——2.5 比 3.5 更纤细，配合小尺寸更精致 */
const TOPBAR_HEALTH_RING_STROKE = 2.5;

/**
 * 健康分 → 视觉分档纯函数（阈值契约见 layout.ts HealthTier JSDoc）。
 *
 * 【为何保留导出】NodeInspectHUD 的探针卡片使用同一套 85/60 阈值判断
 * 实体色调；导出此函数可让两处共用单一事实源，避免阈值漂移。
 */
export function resolveHealthTier(score: number): HealthTier {
  if (score >= HEALTH_TIER_HEALTHY_MIN) return 'healthy';
  if (score >= HEALTH_TIER_WARNING_MIN) return 'warning';
  return 'critical';
}

/**
 * 分档 → 环形描边与文字色。
 *
 * 【为何去掉 shadow-glow-* 外发光】早期 healthy 档挂 `shadow-glow-emerald`，
 * 在深色顶栏上形成一圈明显的绿色光晕，刺眼且廉价——这是"AI 模板感"的
 * 典型特征。稳态应该是内敛的：环本身就是信号，不需要再加泛光。
 * 仅 critical 档保留 animate-glow-pulse（脉动而非静态泛光），
 * 因为那是真实的紧急状态，值得被注意到。
 */
const TIER_RING_CLASS: Readonly<Record<HealthTier, string>> = {
  healthy: 'text-emerald-400',
  warning: 'text-amber-400',
  critical: 'text-rose-500 animate-glow-pulse',
};

/** 分档 → 分数文字色（比环略亮一档，保证可读性） */
const TIER_TEXT_CLASS: Readonly<Record<HealthTier, string>> = {
  healthy: 'text-emerald-300',
  warning: 'text-amber-300',
  critical: 'text-rose-400',
};

/**
 * Pod 状态过滤项静态表（数据驱动渲染，新增状态只改表不改 JSX）。
 *
 * 【本轮彻底汉化】按用户要求全部改为中文：
 * 全部 / 运行中 / 调度中 / 崩溃重启 / 内存溢出。
 *
 * 【关于此前的"保留英文"准则】早期按审查报告 §3.1 保留了 K8s 枚举原文，
 * 理由是便于与 kubectl 输出对照。但顶栏是**全局态速览**，不是排障明细视图：
 * 用户在这里需要的是"一眼看懂当前集群构成"，中文短词的可扫读性明显更好；
 * 需要看原始枚举时，左上探针卡与终端日志仍然给的是 `CrashLoopBackOff`
 * 原文——两处分工，各取所需。
 */
const STATUS_FILTER_OPTIONS: readonly StatusFilterOption[] = [
  { filter: 'ALL', label: '全部' },
  { filter: 'Running', label: '运行中', status: 'Running' },
  { filter: 'Pending', label: '调度中', status: 'Pending' },
  { filter: 'CrashLoopBackOff', label: '崩溃重启', status: 'CrashLoopBackOff' },
  { filter: 'OOMKilled', label: '内存溢出', status: 'OOMKilled' },
];

/**
 * 异常状态 → 计数大于 0 时的强调色样式。
 *
 * 【设计意图】只有**真的出问题了**才给颜色：
 * - 崩溃重启 / 内存溢出 → 绯红（这是真正的故障态）；
 * - 调度中 → 琥珀（过渡态，未必是问题但值得留意）；
 * - 运行中 / 全部 → 不给强调色（正常态不需要颜色来吸引注意）。
 * 若计数为 0，则由 StatusFilterPill 内部降为低对比紧凑态，
 * 让稳态时的顶栏尽量安静。
 */
const FILTER_ALERT_CLASS: Readonly<Partial<Record<StatusFilter, string>>> = {
  CrashLoopBackOff: 'text-rose-300',
  OOMKilled: 'text-rose-300',
  Pending: 'text-amber-300',
};

/** 异常状态计数角标的背景色（与文字色配对） */
const FILTER_ALERT_BADGE_CLASS: Readonly<Partial<Record<StatusFilter, string>>> = {
  CrashLoopBackOff: 'bg-rose-500/20 text-rose-300',
  OOMKilled: 'bg-rose-500/20 text-rose-300',
  Pending: 'bg-amber-500/20 text-amber-300',
};

/** 混沌场景 → 中文短名（告警胶囊内的可读标签） */
const CHAOS_LABEL: Readonly<Record<Exclude<ChaosScenario, 'NONE'>, string>> = {
  POD_OOM_SWARM: 'OOM 风暴',
  NODE_CPU_SPIKE: 'CPU 尖峰',
  NET_PACKET_LOSS: '网络丢包',
};

/**
 * 过滤轨道激活滑块的 layoutId。
 *
 * 【为何必须是常量而非字面量】framer-motion 的 layoutId 是全局共享的动画键：
 * 若页面上存在两个同 id 的组件，滑块会在两者之间"穿越"。
 * 集中定义便于排查这类冲突，也便于后续扩展第二个分段控件时避开。
 */
const FILTER_SLIDER_LAYOUT_ID = 'topbar-filter-active';

/* ========================================================================== */
/* 子组件：健康分环形进度徽标                                                    */
/* ========================================================================== */

/**
 * HealthRingBadge —— SVG 双圆环健康分徽标。
 *
 * 【核心数学】环半径 r = (size − strokeWidth) / 2；周长 C = 2πr；
 * 进度弧长经 strokeDasharray = C 与 strokeDashoffset = C × (1 − score/100)
 * 表达——分数越高，dashoffset 越小，可见弧越长。环体旋转 −90° 使 0% 起点
 * 位于 12 点方向，符合仪表直觉。
 *
 * 【色彩链路】SVG stroke 取 currentColor，由外层 span 的 TIER_RING_CLASS
 * 文本色驱动：emerald(≥85) / amber(60~84) / rose+闪烁(<60)，
 * 单一色彩事实源。
 *
 * 【本轮调整】默认尺寸保持 44（供其他场景使用），但 TopBar 内传入 32，
 * 并且默认不再附带任何外发光——`shadowGlow` 参数保留以便调用方显式开启。
 */
export function HealthRingBadge({
  score,
  size = 44,
  strokeWidth = 3.5,
  showLabel = false,
}: HealthRingBadgeProps) {
  /* 防御性 clamp：越界分数（NaN/负数/>100）不会击穿 dashoffset 计算 */
  const clamped = Number.isNaN(score) ? 0 : Math.min(100, Math.max(0, Math.round(score)));
  const tier = resolveHealthTier(clamped);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped / 100);

  return (
    <div className="flex items-center gap-2" role="img" aria-label={`集群健康分 ${clamped} / 100`}>
      <span className="relative inline-flex rounded-full">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          {/* 底环轨道：极低对比白描边，与凹槽容器材质同源 */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-white/[0.08]"
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
            className={cn(
              'stroke-current transition-[stroke-dashoffset] duration-700 ease-out',
              TIER_RING_CLASS[tier],
            )}
          />
        </svg>
        {/* 环心分数（等宽字体，tabular-nums 防逐帧抖动） */}
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center font-mono font-bold tabular-nums',
            size <= 36 ? 'text-[10px]' : 'text-[11px]',
            TIER_TEXT_CLASS[tier],
          )}
        >
          {clamped}
        </span>
      </span>
      {showLabel ? (
        <span className={cn('font-mono text-[10px] tracking-wider', TIER_TEXT_CLASS[tier])}>健康度</span>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* 子组件：分段过滤轨道内的单个选项                                               */
/* ========================================================================== */

/**
 * StatusFilterPill —— 分段过滤轨道中的单个选项（无独立边框）。
 *
 * 【与旧版的关键差异】
 * 1. **不再画边框**：border 由父级凹槽容器统一提供，此处只负责内容与状态色。
 * 2. **激活态由父级滑块承载**：本组件只负责文字提亮，
 *    滑块（bg-white/[0.09]）由 StatusFilterTrack 用 layoutId 渲染在其下方。
 * 3. **计数为 0 且未选中时自动降级**：文字降到 `text-slate-600` 且计数字隐藏，
 *    让稳态顶栏保持安静——只有真正有数据的项才占据视觉权重。
 * 4. **计数 > 0 的异常状态给强调色**：绯红/琥珀的文字与角标底色。
 */
export function StatusFilterPill({ filter, label, count, active, onSelect }: StatusFilterPillProps) {
  const alertClass = FILTER_ALERT_CLASS[filter];
  const alertBadgeClass = FILTER_ALERT_BADGE_CLASS[filter];
  const isZero = count === 0 && filter !== 'ALL';

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={(): void => onSelect(filter)}
      className={cn(
        'relative z-10 flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-2 py-1',
        'font-mono text-[11px] tracking-tight transition-colors duration-150',
        // ---- 激活态：文字提亮（滑块由父级渲染） ----
        active
          ? 'text-slate-100'
          : // ---- 零计数降级：极低对比，不抢视线 ----
            isZero
            ? 'text-slate-600 hover:text-slate-400'
            : // ---- 有数据未选中：常规次级文字，异常态带强调色 ----
              cn('text-slate-400 hover:text-slate-200', alertClass),
      )}
    >
      <span>{label}</span>
      {/*
       * 计数值：零计数时**完全隐藏**（不是显示 0）。
       * 一排 "0 0 0" 会让顶栏看起来像监控仪表盘的模板占位，
       * 隐藏后稳态只剩「全部 24」这一个有效数字，信息密度反而更高。
       */}
      {count > 0 ? (
        <span
          className={cn(
            'rounded px-1 py-px text-[10px] tabular-nums',
            active
              ? 'bg-white/[0.08] text-slate-200'
              : alertBadgeClass ?? 'bg-white/[0.04] text-slate-500',
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * StatusFilterTrack —— 一体化分段过滤轨道（凹槽底座 + 共享滑块）。
 *
 * 【为何把 5 个胶囊收进一个底座】5 个独立边框的胶囊并排时，
 * 顶栏会出现 5 条竖边 + 5 个圆角，视觉噪音密集，这是"AI 模板感"的主要来源。
 * 收进单一凹槽后：只有 1 条外边框，内部靠间距与滑块区分，
 * 信息结构立刻从"一排按钮"变成"一个分段控件"。
 *
 * 【滑块实现】用 framer-motion 的 layoutId 让高亮面片在选项间平滑滑动：
 * 由于 layoutId 全局唯一，同一时刻只有一个元素持有它，
 * motion 会自动计算前后位置差并补间，形成「丝滑滑块」效果。
 */
function StatusFilterTrack({
  activeFilter,
  counts,
  onSelect,
}: {
  readonly activeFilter: StatusFilter;
  readonly counts: Readonly<Record<PodStatus | 'ALL', number>>;
  readonly onSelect: (filter: StatusFilter) => void;
}): React.ReactElement {
  return (
    <div
      role="group"
      aria-label="按 Pod 状态过滤"
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-white/[0.07] bg-slate-950/60 p-0.5"
    >
      {STATUS_FILTER_OPTIONS.map((option): ReactNode => {
        const active = activeFilter === option.filter;
        const count = counts[option.filter];
        return (
          <div key={option.filter} className="relative">
            {/* 激活滑块：绝对定位铺满该项，z-0 位于文字之下 */}
            {active ? (
              <motion.span
                layoutId={FILTER_SLIDER_LAYOUT_ID}
                transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                aria-hidden
                className="absolute inset-0 rounded-md bg-white/[0.09] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]"
              />
            ) : null}
            <StatusFilterPill
              filter={option.filter}
              label={option.label}
              count={count}
              active={active}
              onSelect={onSelect}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ========================================================================== */
/* 子组件：混沌告警 / QPS / 模式拨片 / 命令面板触发器                              */
/* ========================================================================== */

/**
 * ChaosBanner —— 混沌演练激活横幅（保留导出以兼容既有契约）。
 *
 * 【本轮不再在 TopBar 中使用】按需求将"混沌演练按钮"与"告警横幅"二合一：
 * 激活态直接由 ChaosDrillControl 在按钮位置展开，避免顶栏同时出现
 * 「一个演练按钮 + 一条告警横幅」两份混沌相关 UI。
 * 组件本身保留导出，供其他需要独立告警条的场景复用。
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
      className="flex shrink-0 items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1"
    >
      <OctagonAlert className="h-3.5 w-3.5 animate-glow-pulse text-rose-400" aria-hidden />
      <span className="font-mono text-[11px] font-semibold text-rose-300">演练中：{label}</span>
      <button
        type="button"
        aria-label="一键终止混沌演练"
        onClick={onTerminate}
        className="rounded p-0.5 text-rose-400/70 transition-colors hover:bg-rose-500/20 hover:text-rose-200"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </motion.div>
  );
}

/**
 * ChaosDrillControl —— 混沌演练的「二合一」控件（按钮 ↔ 告警胶囊）。
 *
 * 【为何合并】此前顶栏有两个独立元素：右翼的「混沌故障演练」按钮 +
 * 中翼的告警横幅。激活时用户会看到两处混沌相关 UI，既占位置又割裂——
 * 用户此刻唯一关心的是"演练正在进行，怎么停"，而不是"能不能再开一个演练"。
 *
 * 【两态设计】
 * - `activeChaos === 'NONE'`：普通按钮 [故障演练]，点击打开场景选择模态框。
 * - `activeChaos !== 'NONE'`：原地变形为告警胶囊 [● 演练中: 场景名 | ×]。
 *   点击**左侧主体**切回场景选择（换一个场景演练）；
 *   点击**右侧 ×** 直接终止恢复稳态，且必须 stopPropagation
 *   防止同时触发外层的场景选择。
 *
 * 【无障碍】两种形态下 role 与 aria-label 保持语义清晰：
 * 激活态整体是 role="alert"（状态播报），内部两个按钮各有独立 aria-label。
 */
function ChaosDrillControl({
  activeChaos,
  onOpenModal,
  onTerminate,
}: {
  readonly activeChaos: ChaosScenario;
  readonly onOpenModal: () => void;
  readonly onTerminate: () => void;
}): React.ReactElement {
  const active = activeChaos !== 'NONE';

  if (!active) {
    return (
      <button
        type="button"
        onClick={onOpenModal}
        aria-label="打开故障演练场景选择"
        title="打开混沌工程控制台，注入故障演练场景"
        className={cn(
          'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5',
          'font-mono text-[11px] tracking-tight transition-colors duration-150',
          'border-white/[0.08] bg-slate-950/70 text-slate-300',
          'hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300',
        )}
      >
        <Zap className="h-3.5 w-3.5" aria-hidden />
        {/*
         * 【窄屏图标化仍需可访问名称】文案在 < lg 时隐藏，只剩一个闪电图标；
         * 若不给 aria-label，屏幕阅读器只会读出"按钮"，用户不知道它做什么。
         * 因此上方补 aria-label，且其值不依赖可见文案。
         */}
        <span className="hidden lg:inline">故障演练</span>
      </button>
    );
  }

  return (
    <div
      role="alert"
      className="flex items-center gap-0.5 rounded-lg border border-rose-500/45 bg-rose-500/10 pl-2 pr-0.5 py-0.5"
    >
      {/* ---- 左侧主体：点击切换场景 ---- */}
      <button
        type="button"
        onClick={onOpenModal}
        aria-label="切换故障演练场景"
        title="点击切换演练场景"
        className="flex items-center gap-1.5 rounded px-0.5 py-1 font-mono text-[11px] tracking-tight text-rose-300 transition-colors hover:text-rose-200"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400 animate-glow-pulse" aria-hidden />
        <span className="hidden sm:inline">演练中：</span>
        <span className="font-semibold">{CHAOS_LABEL[activeChaos as Exclude<ChaosScenario, 'NONE'>]}</span>
      </button>

      {/* ---- 右侧 ×：直接终止，必须阻断冒泡 ---- */}
      <button
        type="button"
        onClick={(event): void => {
          /* stopPropagation：防止事件冒泡到外层容器（若有）触发额外动作 */
          event.stopPropagation();
          onTerminate();
        }}
        aria-label="终止故障演练，恢复稳态"
        title="终止演练，恢复稳态"
        className="rounded p-1 text-rose-400/80 transition-colors hover:bg-rose-500/25 hover:text-rose-100"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}

/**
 * QpsBoard —— 裸字精密仪表（无外层方框）。
 *
 * 【为何去掉边框】QPS 是一个**持续变化的数字**，它需要的是一条竖向分割线
 * 与等宽字体，而不是一个方框。方框会把它从"仪表读数"降格成"又一个按钮"，
 * 且与左侧的分段控件边框形成重复。
 *
 * tabular-nums 保证数字逐帧变化时字符宽度恒定，数值不会左右跳动。
 */
export function QpsBoard({ qps }: QpsBoardProps) {
  const display = Number.isNaN(qps) ? '—' : Math.round(qps).toLocaleString('en-US');
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 border-l border-white/[0.08] pl-3"
      title="集群入口总 QPS（来自最近一份遥测快照）"
    >
      <Zap className="h-3 w-3 text-cyan-400/80" aria-hidden />
      <span className="font-mono text-[12px] font-semibold tabular-nums text-slate-100">{display}</span>
      <span className="font-mono text-[10px] tracking-wide text-slate-500">req/s</span>
    </div>
  );
}

/**
 * CommandPaletteTrigger —— 命令面板唤醒按钮（⌘K）。
 *
 * 【为何用合成键盘事件而非直接改状态】命令面板的开关状态由 page.tsx
 * 的本地 useState 持有，TopBar 无法直接访问。而 page.tsx 已监听全局
 * keydown 处理 Cmd/Ctrl+K——派发一个合成的 KeyboardEvent 即可复用该入口，
 * 无需为了一个按钮把 UI 状态提升到 store（那会让所有订阅方无谓重渲染）。
 *
 * 【为何同时设 metaKey 与 ctrlKey】处理端只判断 `metaKey || ctrlKey`，
 * 两个都设为 true 可确保在 Mac 与 Windows 上都命中，且不需要分支。
 */
function CommandPaletteTrigger(): React.ReactElement {
  const handleClick = useCallback((): void => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        ctrlKey: true,
        bubbles: true,
      }),
    );
  }, []);

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="打开运维命令面板"
      title="打开命令面板（⌘K / Ctrl+K）：搜索 Pod、节点与运维动作"
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1',
        'border-white/[0.07] bg-slate-950/60 text-slate-400',
        'font-mono text-[11px] transition-colors duration-150',
        'hover:border-white/[0.12] hover:bg-slate-900/80 hover:text-slate-200',
      )}
    >
      <Search className="h-3 w-3" aria-hidden />
      <span className="hidden xl:inline">搜索拓扑</span>
      <kbd className="ml-0.5 hidden rounded border border-white/[0.08] bg-white/[0.04] px-1 py-px text-[10px] text-slate-500 sm:inline">
        ⌘K
      </kbd>
    </button>
  );
}

/**
 * ModeToggle —— 黑曜石凹槽双模切换拨片。
 *
 * 【本轮核心改动：删除刺眼的实心亮青色块】
 * 旧实现在激活档使用 `bg-cyan-400 text-slate-950`——一块高饱和青色实心，
 * 在深色顶栏上极其抢眼，是"廉价 AI 模板感"的典型特征。
 *
 * 现改为：底座是深色凹槽（bg-slate-950/70 + 发丝描边），
 * 激活滑块是**微亮面片**（bg-white/[0.08]）而非彩色实心块，
 * 再配一枚 emerald 呼吸小绿点表达"数据源活跃"。
 * 这样整个控件的视觉重量从"彩色按钮"降为"状态切换器"，
 * 与 Linear / Datadog 的克制语言一致。
 */
export function ModeToggle({ mode, onChange, disabled = false }: ModeToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="数据源模式切换"
      className={cn(
        'relative flex shrink-0 items-center rounded-lg border border-white/[0.08] bg-slate-950/70 p-0.5',
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
            onClick={(): void => onChange(value)}
            className={cn(
              'relative z-10 flex items-center gap-1.5 rounded-md px-2 py-1',
              'font-mono text-[10px] tracking-tight transition-colors duration-200',
              active ? 'text-slate-100' : 'text-slate-500 hover:text-slate-300',
            )}
          >
            {active ? (
              <motion.span
                layoutId="topbar-mode-toggle-thumb"
                transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                aria-hidden
                className="absolute inset-0 -z-10 rounded-md border border-white/[0.1] bg-white/[0.08]"
              />
            ) : null}
            {/* 激活态配呼吸小绿点（仅 live 有意义：表示隧道连通） */}
            {active ? (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 animate-glow-pulse" aria-hidden />
            ) : value === 'demo' ? (
              <Boxes className="h-3 w-3 shrink-0" aria-hidden />
            ) : (
              <Radio className="h-3 w-3 shrink-0" aria-hidden />
            )}
            <span className="hidden sm:inline">{value === 'demo' ? '合成' : '实时'}</span>
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

  const handleOpenChaosModal = useCallback((): void => {
    setChaosModalOpen(true);
  }, [setChaosModalOpen]);

  const handleTogglePerfHud = useCallback((): void => {
    setPerfHudOpen(!isPerfHudOpen);
  }, [isPerfHudOpen, setPerfHudOpen]);

  const healthScore = snapshot.clusterHealthScore;
  const healthTier = resolveHealthTier(
    Number.isNaN(healthScore) ? 0 : Math.min(100, Math.max(0, Math.round(healthScore))),
  );

  return (
    <header className="kv-panel relative z-30 flex h-12 shrink-0 items-center gap-3 rounded-none border-x-0 border-t-0 border-b border-white/[0.07] px-3 sm:px-4">
      {/* ============ 左翼：品牌 + 竖分割线 + 紧凑健康环 ============ */}
      <div className="flex shrink-0 items-center gap-2.5">
        {/*
         * 品牌图标：极简线框雷达（无彩色填充块）。
         * 早期是 `bg-cyan-400/10 + border-cyan-400/40 + shadow-glow-cyan` 的
         * 发光方块——正是"廉价 AI 模板"的典型元素。现改为中性的
         * 深色圆角容器 + 白色描边，让品牌标识靠**形状**而非**颜色**被识别。
         */}
        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04]">
          <Radar className="h-4 w-4 text-slate-200" aria-hidden />
        </span>

        {/*
         * 单行标题：删除 v2.4-Edge 版本徽标框与第二行副标题。
         * 版本号是给开发者看的信息，不该占据顶栏这种黄金位置；
         * 副标题"3D 态势感知"也与产品名重复。精简为一行标题后，
         * 左翼视觉重量显著下降，与其余控件形成合理层级。
         */}
        <span className="hidden text-sm font-semibold tracking-tight text-slate-50 sm:inline">
          KubeVision<span className="text-slate-400"> AI</span>
        </span>

        {/* 竖分割线：分隔品牌区与健康度区 */}
        <span className="hidden h-4 w-px bg-white/[0.08] sm:block" aria-hidden />

        {/*
         * 紧凑健康度：32px 细环 + 小字标签 + 分数。
         * 环内不再重复显示分数（32px 环内容纳两位数字会挤），
         * 改为环右侧并列「健康度 + 分数」，可读性更好。
         * 分数颜色随分档变化，环本身用内敛的 emerald（无外发光）。
         */}
        <div className="flex items-center gap-2" title={`集群健康分 ${Math.round(healthScore)} / 100`}>
          <HealthRingBadge score={healthScore} size={TOPBAR_HEALTH_RING_SIZE} strokeWidth={TOPBAR_HEALTH_RING_STROKE} />
          <div className="hidden flex-col leading-none sm:flex">
            <span className="font-mono text-[10px] tracking-wide text-slate-500">健康度</span>
            <span
              className={cn(
                'mt-0.5 font-mono text-[13px] font-bold tabular-nums',
                TIER_TEXT_CLASS[healthTier],
              )}
            >
              {Number.isNaN(healthScore) ? '—' : Math.round(healthScore)}
            </span>
          </div>
        </div>
      </div>

      {/* ============ 中翼：分段过滤轨道 + QPS 裸表 + ⌘K（横向滚动） ============ */}
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <StatusFilterTrack activeFilter={statusFilter} counts={countByStatus} onSelect={selectFilter} />

        <QpsBoard qps={snapshot.totalQps} />

        <CommandPaletteTrigger />

        {/*
         * 【Live Tunnel 静默假死提示】
         * 服务端在 mode=live 下只发心跳注释、不推业务帧（真实集群连接器
         * 尚未接线）。若不提示，用户切到实时隧道后会看到完全静止的画面，
         * 无法区分「集群稳定」与「数据源没接上」。
         * 这里给出诚实说明与一键切回入口。
         */}
        {connectionMode === 'live' ? (
          <button
            type="button"
            role="status"
            onClick={(): void => setMode('demo')}
            className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/35 bg-amber-500/[0.08] px-2 py-1 font-mono text-[10px] tracking-tight text-amber-300/90 transition-colors hover:border-amber-400/60 hover:bg-amber-500/15"
            title="当前构建未接入真实集群 Agent，实时隧道无可推送数据帧。点击切回合成演练流"
            aria-label="切回合成演练数据流"
          >
            <Radio className="h-2.5 w-2.5 animate-glow-pulse" aria-hidden />
            等待 Agent · 点击切回
          </button>
        ) : null}
      </div>

      {/* ============ 右翼：双模拨片 + 混沌二合一 + 性能 HUD ============ */}
      <div className="flex shrink-0 items-center gap-2">
        <ModeToggle mode={connectionMode} onChange={setMode} />

        {/* 混沌演练二合一控件：未激活是按钮，激活后原地变为告警胶囊 */}
        <ChaosDrillControl
          activeChaos={activeChaos}
          onOpenModal={handleOpenChaosModal}
          onTerminate={handleTerminateChaos}
        />

        {/* 性能监控 HUD 开关（快捷键 Shift+P，监听器在 ShellLayout 全局挂载） */}
        <button
          type="button"
          onClick={handleTogglePerfHud}
          aria-pressed={isPerfHudOpen}
          aria-label={`性能监控 HUD（快捷键 Shift+P）· 当前${isPerfHudOpen ? '已开启' : '已关闭'}`}
          aria-keyshortcuts="Shift+P"
          className={cn(
            'flex items-center gap-1.5 rounded-lg border px-2 py-1.5',
            'font-mono text-[11px] tracking-tight transition-colors duration-150',
            isPerfHudOpen
              ? 'border-cyan-400/35 bg-cyan-400/[0.08] text-cyan-300'
              : 'border-white/[0.08] bg-slate-950/70 text-slate-400 hover:border-white/[0.12] hover:text-slate-200',
          )}
          title="性能监控 HUD（快捷键 Shift+P）"
        >
          {isPerfHudOpen ? (
            <Gauge className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Terminal className="h-3.5 w-3.5" aria-hidden />
          )}
          {/* 文案在 < xl 隐藏，故 aria-label 承担完整可访问名称（见上方注释） */}
          <span className="hidden xl:inline">性能</span>
        </button>
      </div>
    </header>
  );
}