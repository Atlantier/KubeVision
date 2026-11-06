'use client';

/**
 * KubeVision AI — 实体巡检悬浮 HUD（NodeInspectHUD）
 *
 * 【设计意图】把「点选 3D 实体」升级为一次完整的巡检会话：未选中时是
 * 场景的读图说明书（图例 + 手势），选中后切换为玻璃态探针卡片，
 * 同屏呈现身份、状态、元信息、实时波形与两根战术按钮（AI 诊断 / 隔离重启），
 * 让「发现异常 → 诊断根因 → 执行修复」形成闭环而不必离开 3D 视口。
 *
 * 【双态互斥的动画契约】
 * 空态图例与实体卡片由外层 <AnimatePresence mode="wait"> 统一托管：
 * mode="wait" 保证退场动画结束再播入场（两次形态不会交叠成一团），
 * 切换时卡片自左上方淡入并轻微下浮（y: -8 → 0），闭合时反向收回。
 *
 * 【指针事件契约】（AGENTS.md 第 6 条的同一原则）
 * 外层定位容器 pointer-events-none：不遮挡画布拖拽/缩放——HUD 悬浮在
 * 3D 视口上，若整个容器吃指针事件，用户将无法在 HUD 覆盖的矩形区域内
 * 旋转相机。卡片本体 pointer-events-auto：卡片内的按钮/关闭必须可点。
 * 这一组合使「视觉上悬浮覆盖 + 交互上无障碍穿透」同时成立。
 *
 * 【订阅纪律】三个字段各自细粒度订阅（selectedEntityId / selectedEntityType /
 * snapshotSummary），互不影响；派生的视图模型以 useMemo 缓存，
 * 仅在实体或快照变更时重算——1Hz 快照流不会造成额外渲染放大。
 *
 * 【历史序列口径：绝不伪造数据】
 * PodEntity 自带 cpuHistory / memHistory（契约：最近 6 点 FIFO，真实采集），
 * 故 Pod 直接消费 'direct' 序列。
 * WorkerNodeEntity 与 MASTER **没有历史字段**（见 types/cluster.ts），
 * 因此它们的波形由真实数据聚合派生（'derived'）：
 * - Node：取该节点名下全部 Pod 的 cpuHistory/memHistory，逐点取算术平均，
 *   得到「该节点 Pod 侧平均水位」的真实历史曲线；
 * - MASTER：取全集群所有 Pod 的逐点平均，代表集群整体 Pod 侧水位。
 * 两者都不是随机数或装饰性假线，而是同源真实历史的**聚合**，
 * 并在卡片底部显式标注数据口径（DIRECT / DERIVED），避免误读为节点自身采集。
 *
 * 【重置视角】关闭按钮同时执行 selectEntity(null)（清空选中，相机飞回全景）
 * 与 dispatchViewPreset('overview')（广播全景预设，保证即使相机因其他路径
 * 偏移也复位到标准机位）——「关闭卡片 = 退出巡检会话」的语义一致性。
 */

import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  ChevronDown,
  Cpu,
  HardDrive,
  LayoutGrid,
  MemoryStick,
  MousePointerClick,
  Move3d,
  RotateCcw,
  Server,
  ShieldCheck,
  Sparkles,
  X,
  ZoomIn,
} from 'lucide-react';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import { MASTER_ENTITY_ID } from '@/types/canvas';
import { dispatchViewPreset } from '@/utils/viewPresetBus';
import type { PodEntity, TelemetrySnapshot, WorkerNodeEntity } from '@/types/cluster';
import type { SelectedEntityType } from '@/types/store';
import type {
  EntityHistorySource,
  EntityInspectView,
  GestureHintItem,
  InspectMetaRow,
  InspectTone,
  NodeInspectHUDProps,
  SparklineProps,
  SparklineSeries,
  TopologyLegendItem,
} from '@/types/hud';

/* ========================================================================== */
/* 视觉常量                                                                    */
/* ========================================================================== */

/** 波形序列配色：CPU 主题青（算力），MEM 紫罗兰（内存，与 CPU 明确区分） */
const CPU_COLOR = '#22d3ee';
const MEM_COLOR = '#a78bfa';

/** 历史序列目标点数（与 PodEntity 契约的 6 点 FIFO 对齐） */
const HISTORY_POINTS = 6;

/** Sparkline 默认视口尺寸（用户单位；preserveAspectRatio=none 自适应拉伸） */
const SPARKLINE_WIDTH = 132;
const SPARKLINE_HEIGHT = 34;

/** Sparkline 垂直内边距（用户单位）：防峰值削顶/触底，留 12% 呼吸空间 */
const SPARKLINE_PAD_Y = 4;

/** 语义色 → Tailwind 文本色类（徽标/图例圆点颜色，与 status 体系一致） */
const TONE_TEXT_CLASS: Readonly<Record<InspectTone, string>> = {
  healthy: 'text-emerald-400',
  warning: 'text-amber-400',
  critical: 'text-rose-500',
};

/** 语义色 → Tailwind 背景色类（圆点/状态条） */
const TONE_BG_CLASS: Readonly<Record<InspectTone, string>> = {
  healthy: 'bg-emerald-400',
  warning: 'bg-amber-400',
  critical: 'bg-rose-500',
};

/** 语义色 → 边框/底纹（卡片状态高亮描边） */
const TONE_RING_CLASS: Readonly<Record<InspectTone, string>> = {
  healthy: 'border-emerald-400/40',
  warning: 'border-amber-400/40',
  critical: 'border-rose-500/50',
};

/** 语义色 → 辉光阴影类 */
const TONE_GLOW_CLASS: Readonly<Record<InspectTone, string>> = {
  healthy: 'shadow-glow-emerald',
  warning: 'shadow-glow-amber',
  critical: 'shadow-glow-rose',
};

/* ========================================================================== */
/* 空态静态表                                                                  */
/* ========================================================================== */

/**
 * 拓扑图例（三态）。
 *
 * 【与 3D 场景严格对齐】这三条正是 PodInstancedMesh 的实例着色语言：
 * Running → emerald-400；Pending / Terminating → amber-400；
 * CrashLoopBackOff / OOMKilled → rose-500（文件名契约见 PodInstancedMesh.tsx）。
 */
const TOPOLOGY_LEGEND: readonly TopologyLegendItem[] = [
  {
    key: 'running',
    label: 'Running',
    tone: 'healthy',
    description: '容器正常运行，服务健康',
  },
  {
    key: 'pending',
    label: 'Pending',
    tone: 'warning',
    description: '调度或启动中，尚未就绪',
  },
  {
    key: 'faulty',
    label: '异常告警',
    tone: 'critical',
    description: 'CrashLoopBackOff / OOMKilled 故障',
  },
];

/** 操作手势提示（对应 OrbitControls 的真实绑定行为） */
const GESTURE_HINTS: readonly GestureHintItem[] = [
  { key: 'rotate', label: '左键拖拽', effect: '旋转视角' },
  { key: 'pan', label: '右键拖拽', effect: '平移视野' },
  { key: 'zoom', label: '滚轮', effect: '缩放远近' },
  { key: 'inspect', label: '点击实体', effect: '特写巡检' },
];

/* ========================================================================== */
/* 纯函数：波形与视图模型派生                                                    */
/* ========================================================================== */

/**
 * clampPercent —— 把任意数值收敛到 [0, 100] 百分比域。
 *
 * 【为何需要】聚合派生（如节点名下 Pod 平均）在浮点运算后可能落到
 * 99.99999 或 -1e-15，直接喂给 SVG 会画出越界坐标；统一在此收敛，
 * 保证绘图输入恒在定义域内（防御性纯函数，不含副作用）。
 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * formatPercent —— 百分比展示文本（一位小数 + 百分号）。
 *
 * 【为何保留一位小数】波形是 6 点历史，整数化会让相邻点差异消失、
 * 曲线呈现台阶状；一位小数保留真实变化量的同时仍足够紧凑。
 */
function formatPercent(value: number): string {
  return `${clampPercent(value).toFixed(1)}%`;
}

/**
 * padHistory —— 把长度不足的序列左补至目标点数（首值复制填充）。
 *
 * 【用途】聚合派生时若某节点名下无 Pod（空 podIds），平均序列为空数组，
 * 必须补点才能交给 Sparkline（其契约要求长度 ≥ 2）。
 * 补点采用首值复制而非零填充：零值会在图上画出一条误导性的暴跌线，
 * 而复制首值呈现的是一条平直线——「无数据」的正确视觉表达。
 */
function padHistory(values: readonly number[]): number[] {
  if (values.length === 0) {
    const fallback: number[] = [];
    for (let i = 0; i < HISTORY_POINTS; i++) fallback.push(0);
    return fallback;
  }
  if (values.length >= HISTORY_POINTS) return values.slice(-HISTORY_POINTS);
  const padded: number[] = [];
  const missing = HISTORY_POINTS - values.length;
  for (let i = 0; i < missing; i++) padded.push(clampPercent(values[0]));
  for (const value of values) padded.push(clampPercent(value));
  return padded;
}

/**
 * averageHistories —— 对多组等长历史序列逐点取算术平均。
 *
 * 【核心数学】给定 n 组长度为 L 的序列，输出长度为 L 的平均序列：
 *   out[i] = (Σ_{k=0}^{n-1} seq_k[i]) / n
 * 用于把「名下多个 Pod 的历史」聚合为「节点侧平均水位历史」。
 * 空集合返回空数组（由调用方 padHistory 兜底）。
 *
 * @param sequences 等长历史序列集合（长度不一致时以最短者为准，防御越界）
 * @returns 逐点平均序列（长度 = 输入序列最短长度）
 */
function averageHistories(sequences: readonly (readonly number[])[]): number[] {
  if (sequences.length === 0) return [];
  let shortest = Number.POSITIVE_INFINITY;
  for (const sequence of sequences) {
    if (sequence.length < shortest) shortest = sequence.length;
  }
  if (!Number.isFinite(shortest) || shortest === 0) return [];

  const averaged: number[] = [];
  for (let i = 0; i < shortest; i++) {
    let sum = 0;
    for (const sequence of sequences) sum += sequence[i];
    averaged.push(clampPercent(sum / sequences.length));
  }
  return averaged;
}

/**
 * derivePodView —— PodEntity → 巡检视图模型（真实历史，'direct' 口径）。
 */
function derivePodView(
  pod: PodEntity,
  snapshot: TelemetrySnapshot,
): EntityInspectView {
  const hostNode = snapshot.nodes.find((node): boolean => node.id === pod.nodeId);

  /* Pod 五态 → 视觉三级：Running 健康；Pending/Terminating 过渡；崩溃双态告警 */
  const statusTone: InspectTone =
    pod.status === 'Running'
      ? 'healthy'
      : pod.status === 'Pending' || pod.status === 'Terminating'
        ? 'warning'
        : 'critical';

  const metaRows: InspectMetaRow[] = [
    { label: '命名空间', value: pod.namespace },
    { label: '所属节点', value: hostNode?.name ?? pod.nodeId },
    { label: 'Pod IP', value: pod.ip },
    { label: '机架 / 槽位', value: `rack-${pod.rackIndex} · slot-${pod.slotIndex}` },
  ];

  return {
    entityId: pod.id,
    entityType: 'pod',
    displayName: pod.name,
    statusLabel: pod.status,
    statusTone,
    metaRows,
    restarts: pod.restarts,
    cpuSeries: {
      label: 'CPU',
      values: padHistory(pod.cpuHistory),
      color: CPU_COLOR,
      latestText: formatPercent(pod.cpuUsage),
    },
    memSeries: {
      label: 'MEM',
      values: padHistory(pod.memHistory),
      color: MEM_COLOR,
      latestText: formatPercent(pod.memoryUsage),
    },
    historySource: 'direct',
  };
}

/**
 * deriveNodeView —— WorkerNodeEntity → 巡检视图模型（'derived' 口径）。
 *
 * 【历史序列派生依据】WorkerNodeEntity 契约中没有 cpuHistory/memHistory，
 * 故取该节点名下全部 Pod 的 cpuHistory / memHistory 逐点平均：
 * 这是「该节点上 Pod 侧平均水位」的真实历史，反映节点内工作负载走向。
 * 当前水位（cpuUsage / memUsage）仍取节点自身字段（真实节点级采集），
 * 二者口径不同，故以 historySource='derived' 显式标注，避免误读。
 */
function deriveNodeView(
  node: WorkerNodeEntity,
  snapshot: TelemetrySnapshot,
): EntityInspectView {
  const rackPods = snapshot.pods.filter((pod): boolean => pod.nodeId === node.id);

  const avgCpu = padHistory(averageHistories(rackPods.map((pod) => pod.cpuHistory)));
  const avgMem = padHistory(averageHistories(rackPods.map((pod) => pod.memHistory)));

  /* 节点重启次数：名下 Pod 重启次数之和（节点自身无 restarts 字段） */
  let restarts = 0;
  for (const pod of rackPods) restarts += pod.restarts;

  const statusTone: InspectTone =
    node.status === 'Ready' ? 'healthy' : node.status === 'HighLoad' ? 'warning' : 'critical';

  const metaRows: InspectMetaRow[] = [
    { label: '节点 IP', value: node.ip },
    { label: '机架', value: `rack-${node.rackIndex}` },
    { label: '容量', value: `${node.cpuCapacity} 核 / ${node.memCapacity} GiB` },
    { label: 'Pod 数', value: `${rackPods.length} 个已调度` },
  ];

  return {
    entityId: node.id,
    entityType: 'node',
    displayName: node.name,
    statusLabel: node.status,
    statusTone,
    metaRows,
    restarts,
    cpuSeries: {
      label: 'CPU',
      values: avgCpu,
      color: CPU_COLOR,
      latestText: formatPercent(node.cpuUsage),
    },
    memSeries: {
      label: 'MEM',
      values: avgMem,
      color: MEM_COLOR,
      latestText: formatPercent(node.memUsage),
    },
    historySource: 'derived',
  };
}

/**
 * deriveMasterView —— MASTER 控制平面 → 巡检视图模型（'derived' 口径）。
 *
 * 【历史序列派生依据】MASTER 是抽象控制平面（无对应快照实体），
 * 其波形取全集群所有 Pod 的逐点平均——代表集群整体工作负载水位趋势。
 * 当前水位则按「全集群 Pod 平均」实时计算（与历史序列同源同口径，
 * 因此这里的 latestText 与曲线末端自然连续，不会出现跳变）。
 */
function deriveMasterView(snapshot: TelemetrySnapshot): EntityInspectView {
  const pods = snapshot.pods;
  const nodes = snapshot.nodes;

  const avgCpu = padHistory(averageHistories(pods.map((pod) => pod.cpuHistory)));
  const avgMem = padHistory(averageHistories(pods.map((pod) => pod.memHistory)));

  /* 当前 CPU/MEM 水位：全集群 Pod 实时平均（曲线末端与前值同口径） */
  let cpuSum = 0;
  let memSum = 0;
  let restarts = 0;
  for (const pod of pods) {
    cpuSum += pod.cpuUsage;
    memSum += pod.memoryUsage;
    restarts += pod.restarts;
  }
  const cpuNow = pods.length > 0 ? cpuSum / pods.length : 0;
  const memNow = pods.length > 0 ? memSum / pods.length : 0;

  /* 集群健康分 → 视觉三级（与 TopBar HealthRingBadge 的分档阈值一致：85 / 60） */
  const score = snapshot.clusterHealthScore;
  const statusTone: InspectTone =
    score >= 85 ? 'healthy' : score >= 60 ? 'warning' : 'critical';

  const running = pods.filter((pod): boolean => pod.status === 'Running').length;

  const metaRows: InspectMetaRow[] = [
    { label: '作用域', value: '集群控制平面' },
    { label: '工作节点', value: `${nodes.length} 个` },
    { label: 'Pod 数', value: `${running}/${pods.length} 运行中` },
    { label: 'QPS', value: snapshot.totalQps.toLocaleString('en-US') },
  ];

  return {
    entityId: MASTER_ENTITY_ID,
    entityType: 'master',
    displayName: 'MASTER control plane',
    statusLabel: `Health ${Math.round(score)}`,
    statusTone,
    metaRows,
    restarts,
    cpuSeries: {
      label: 'CPU',
      values: avgCpu,
      color: CPU_COLOR,
      latestText: formatPercent(cpuNow),
    },
    memSeries: {
      label: 'MEM',
      values: avgMem,
      color: MEM_COLOR,
      latestText: formatPercent(memNow),
    },
    historySource: 'derived',
  };
}

/**
 * deriveEntityView —— 三分支实体解析（巡检视图模型的唯一构造入口）。
 *
 * 【核心流转】selectedEntityType 决定解析分支（显式类型优先，不做字符串猜测）；
 * 找不到对应实体（ID 与类型不匹配、快照中已消失）时返回 null，
 * 上层据此回落到空态图例——绝不渲染半截卡片。
 *
 * @param entityId    选中实体 ID
 * @param entityType  选中实体类型（'pod' | 'node' | 'master'）
 * @param snapshot    当前快照摘要
 * @returns 巡检视图模型；实体不存在时为 null
 */
function deriveEntityView(
  entityId: string,
  entityType: SelectedEntityType,
  snapshot: TelemetrySnapshot,
): EntityInspectView | null {
  if (entityType === 'pod') {
    const pod = snapshot.pods.find((candidate): boolean => candidate.id === entityId);
    return pod === undefined ? null : derivePodView(pod, snapshot);
  }
  if (entityType === 'node') {
    const node = snapshot.nodes.find((candidate): boolean => candidate.id === entityId);
    return node === undefined ? null : deriveNodeView(node, snapshot);
  }
  /* master：抽象控制平面，恒可解析（快照即其全部状态） */
  return deriveMasterView(snapshot);
}

/* ========================================================================== */
/* 子组件：Sparkline（纯 SVG 面积渐变波形）                                       */
/* ========================================================================== */

/**
 * Sparkline —— 纯 SVG 绘制的实时迷你波形图（描边 + 面积渐变填充）。
 *
 * 【绘制数学】
 * 1. 值域映射：v ∈ [0,100] → y = H − PAD − (v/100) × (H − 2·PAD)。
 *    减去 PAD 并压缩可用高度，使 100% 峰值与 0% 谷值都不贴边（防削顶）。
 * 2. 横轴等距：n 个点均分宽度，x_i = i × W / (n − 1)。
 * 3. 折线：<polyline points="x0,y0 x1,y1 …"> 描边发光；
 * 4. 面积：闭合路径 M x0,y0 L … L x_{n-1},y_{n-1} L W,H L 0,H Z，
 *    填充指向 <linearGradient>（上方 color@0.45 → 下方 color@0）；
 *    渐变 id 由 useId 生成，避免同页多实例 id 冲突（SVG id 全局唯一）。
 * 5. 末端高亮：最后一个点画实心圆 + 外圈光环，强调「当前值」。
 *
 * 【为何用 SVG 而非 Canvas】6 点折线用 SVG 开销极低，且能直接复用
 * Tailwind 的 currentColor 与 CSS 过渡（stroke 颜色随状态变化时平滑过渡）。
 */
function Sparkline({ series, width = SPARKLINE_WIDTH, height = SPARKLINE_HEIGHT }: SparklineProps) {
  /* 唯一渐变 id：React 18 useId 输出含冒号，需在 SVG url() 引用前安全化 */
  const rawId = useId();
  const gradientId = `kv-spark-${rawId.replace(/:/g, '')}`;

  const geometry = useMemo((): { readonly line: string; readonly area: string; readonly lastX: number; readonly lastY: number } => {
    const values = series.values;
    const count = values.length;
    const usableHeight = height - SPARKLINE_PAD_Y * 2;
    const stepX = count > 1 ? width / (count - 1) : width;

    const points: string[] = [];
    let lastX = 0;
    let lastY = height - SPARKLINE_PAD_Y;
    for (let i = 0; i < count; i++) {
      const x = i * stepX;
      const y = height - SPARKLINE_PAD_Y - (clampPercent(values[i]) / 100) * usableHeight;
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      lastX = x;
      lastY = y;
    }

    /* 面积路径：折线 + 右下角 + 左下角 + 闭合，形成填充区域 */
    const area = `M ${points[0]} L ${points.slice(1).join(' L ')} L ${width.toFixed(2)},${height} L 0,${height} Z`;

    return { line: points.join(' '), area, lastX, lastY };
  }, [series.values, width, height]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${series.label} 实时波形，当前 ${series.latestText}`}
      className="overflow-visible"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={series.color} stopOpacity={0.45} />
          <stop offset="100%" stopColor={series.color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {/* 面积填充（引用渐变，形成由浓到透的体积感） */}
      <path d={geometry.area} fill={`url(#${gradientId})`} stroke="none" />
      {/* 折线描边（发光由 SVG 自身 filter 之外的浅色 stroke 叠加实现） */}
      <polyline
        points={geometry.line}
        fill="none"
        stroke={series.color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.95}
      />
      {/* 末端当前值高亮：光环 + 实心点 */}
      <circle cx={geometry.lastX} cy={geometry.lastY} r={3.4} fill={series.color} opacity={0.18} />
      <circle cx={geometry.lastX} cy={geometry.lastY} r={1.7} fill={series.color} />
    </svg>
  );
}

/* ========================================================================== */
/* 子组件：空态（图例 + 手势）                                                   */
/* ========================================================================== */

/**
 * TopologyLegendPanel —— 未选中实体时的精简说明面板。
 *
 * 【内容】状态图例（三色语义）+ 操作手势提示（四条交互）。
 * 设计目标：新用户看向 3D 场景能在 3 秒内看懂颜色语言与操作方式。
 *
 * 【为何改为默认收起的胶囊】（蓝图 §1.4 / 审查报告 §2.4）
 * 原实现是常驻的 248px 宽、约 200px 高的完整卡片，永久占据 3D 视口左上角。
 * 实测它遮挡了相当一部分画面，是"四角围城"观感的主要来源之一。
 *
 * 现在改为：**常态只有一行紧凑胶囊**（三个色点 + "读图说明"），
 * 点击才展开完整图例。既保留了新用户的可发现性（色点本身就是图例），
 * 又把稳态下的画面占用从 ~200px 高压缩到 ~24px。
 */
function TopologyLegendPanel() {
  const [expanded, setExpanded] = useState<boolean>(false);

  return (
    <div className="kv-panel pointer-events-auto max-w-full overflow-hidden">
      {/* ---- 常态：一行紧凑胶囊（点击切换展开） ---- */}
      <button
        type="button"
        onClick={(): void => setExpanded((prev): boolean => !prev)}
        aria-expanded={expanded}
        aria-label="展开或收起读图说明"
        className="flex w-full items-center gap-1.5 px-2 py-1 transition-colors hover:bg-slate-100/5"
      >
        <LayoutGrid className="h-3 w-3 shrink-0 text-cyan-400" aria-hidden />
        {/* 三个状态色点：图例语义在收起态由它们承载，无需文字也能读懂 */}
        {TOPOLOGY_LEGEND.map((item): ReactNode => (
          <span
            key={item.key}
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_BG_CLASS[item.tone])}
            title={`${item.label} · ${item.description}`}
            aria-hidden
          />
        ))}
        <span className="ml-0.5 font-mono text-[10px] tracking-wider text-slate-400">读图说明</span>
        <ChevronDown
          className={cn(
            'ml-auto h-3 w-3 shrink-0 text-slate-500 transition-transform duration-200',
            expanded && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {/* ---- 展开态：完整图例 + 手势提示（弹簧高度动画） ---- */}
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            className="overflow-hidden"
          >
            <div className="border-t border-slate-800 px-2.5 py-2">
              {/* 状态图例 */}
              <ul className="space-y-1.5">
                {TOPOLOGY_LEGEND.map((item) => (
                  <li key={item.key} className="flex items-start gap-2">
                    <span
                      className={cn('mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full', TONE_BG_CLASS[item.tone])}
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className={cn('font-mono text-[10px] font-bold tracking-wide', TONE_TEXT_CLASS[item.tone])}>
                        {item.label}
                      </span>
                      <span className="ml-1.5 text-[10px] leading-snug text-slate-500">{item.description}</span>
                    </span>
                  </li>
                ))}
              </ul>

              {/* 分隔 */}
              <div className="my-2 border-t border-slate-800" />

              {/* 手势提示 */}
              <div className="mb-1.5 flex items-center gap-1.5">
                <Move3d className="h-3 w-3 text-slate-500" aria-hidden />
                <p className="font-mono text-[10px] tracking-wider text-slate-500">相机操作</p>
              </div>
              <ul className="grid grid-cols-2 gap-x-2 gap-y-1">
                {GESTURE_HINTS.map((hint) => (
                  <li key={hint.key} className="flex items-center gap-1">
                    {hint.key === 'rotate' ? (
                      <RotateCcw className="h-2.5 w-2.5 shrink-0 text-slate-600" aria-hidden />
                    ) : hint.key === 'pan' ? (
                      <Move3d className="h-2.5 w-2.5 shrink-0 text-slate-600" aria-hidden />
                    ) : hint.key === 'zoom' ? (
                      <ZoomIn className="h-2.5 w-2.5 shrink-0 text-slate-600" aria-hidden />
                    ) : (
                      <MousePointerClick className="h-2.5 w-2.5 shrink-0 text-slate-600" aria-hidden />
                    )}
                    <span className="truncate font-mono text-[10px] text-slate-500">
                      {hint.label} <span className="text-slate-600">·</span>{' '}
                      <span className="text-slate-400">{hint.effect}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ========================================================================== */
/* 子组件：实体探针卡片                                                          */
/* ========================================================================== */

/**
 * EntityProbeCard —— 玻璃态实体详情探针（选中实体时展示）。
 *
 * 【核心流转】
 * 1. 头部：实体类型图标 + 名称（truncate 防长 Pod 名撑破）+ 关闭按钮；
 * 2. 状态徽标：语义色圆点 + 状态原文（高亮描边随状态色变化）；
 * 3. 元信息网格：NAMESPACE / NODE / IP / RACK-SLOT（按实体类型裁剪）；
 * 4. 重启次数：Restarts 指标（>0 时以琥珀/红强调，0 时中性）；
 * 5. 双波形：CPU / MEM Sparkline 并排；
 * 6. 双按钮：AI 根因诊断（triggerQuickPrompt）+ 隔离并重启（healEntity）。
 */
function EntityProbeCard({
  view,
  onClose,
  onDiagnose,
  onHeal,
}: {
  readonly view: EntityInspectView;
  readonly onClose: () => void;
  readonly onDiagnose: () => void;
  readonly onHeal: () => void;
}) {
  const EntityIcon = view.entityType === 'pod' ? Sparkles : view.entityType === 'node' ? Server : Activity;

  /* 重启次数强调：≥3 次视为反复崩溃（rose），1~2 次琥珀，0 中性 */
  const restartsTone: InspectTone =
    view.restarts >= 3 ? 'critical' : view.restarts > 0 ? 'warning' : 'healthy';

  return (
    <div
      className={cn(
        'kv-panel pointer-events-auto w-[288px] max-w-full overflow-hidden p-3',
        TONE_RING_CLASS[view.statusTone],
        TONE_GLOW_CLASS[view.statusTone],
      )}
    >
      {/* ---- 头部：图标 + 名称 + 关闭 ---- */}
      <div className="flex items-start gap-1.5">
        <EntityIcon className={cn('mt-[2px] h-3.5 w-3.5 shrink-0', TONE_TEXT_CLASS[view.statusTone])} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11px] font-bold tracking-wide text-slate-100" title={view.displayName}>
            {view.displayName}
          </p>
          <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.18em] text-slate-600">
            {view.entityType}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭巡检卡片并重置视角"
          title="关闭并重置视角"
          className="shrink-0 rounded p-0.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200 active:scale-95"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {/* ---- 状态徽标 ---- */}
      <div className={cn('mt-2 flex items-center gap-1.5 rounded border px-2 py-1', TONE_RING_CLASS[view.statusTone])}>
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_BG_CLASS[view.statusTone])} aria-hidden />
        <span className={cn('font-mono text-[10px] font-bold tracking-wider', TONE_TEXT_CLASS[view.statusTone])}>
          {view.statusLabel}
        </span>
        <span className="ml-auto flex items-center gap-1 font-mono text-[11px] text-slate-500">
          RESTARTS
          <span className={cn('font-bold tabular-nums', TONE_TEXT_CLASS[restartsTone])}>{view.restarts}</span>
        </span>
      </div>

      {/* ---- 元信息网格 ---- */}
      <dl className="mt-2 space-y-1">
        {view.metaRows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-2">
            <dt className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-slate-600">{row.label}</dt>
            <dd
              className="min-w-0 truncate font-mono text-[10px] tabular-nums text-slate-300"
              title={row.value.length > 0 ? row.value : '—'}
            >
              {row.value.length > 0 ? row.value : '—'}
            </dd>
          </div>
        ))}
      </dl>

      {/* ---- 双波形（CPU / MEM） ---- */}
      <div className="mt-2.5 space-y-2">
        <SparklineBlock series={view.cpuSeries} icon={<Cpu className="h-2.5 w-2.5" aria-hidden />} />
        <SparklineBlock series={view.memSeries} icon={<MemoryStick className="h-2.5 w-2.5" aria-hidden />} />
      </div>

      {/* ---- 数据口径标注（direct 真实采集 / derived 聚合派生） ---- */}
      <p className="mt-1.5 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-slate-700">
        <HardDrive className="h-2 w-2" aria-hidden />
        history&nbsp;source&nbsp;·&nbsp;{view.historySource === 'direct' ? 'direct samples' : 'derived from pod samples'}
      </p>

      {/* ---- 战术按钮组 ---- */}
      <div className="mt-2.5 space-y-1.5">
        <button
          type="button"
          onClick={onDiagnose}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-cyan-300 transition-all duration-150 hover:border-cyan-400/70 hover:bg-cyan-500/20 active:scale-[0.98]"
        >
          <Sparkles className="h-3 w-3" aria-hidden />
          交由 AI Copilot 根因诊断
        </button>
        {/*
         * 【按实体类型定制动作】此前 Master / Node / Pod 一律渲染
         * 「隔离并重启实例」并统一调用 healEntity(id,'restart_pod')：
         * - 选中 MASTER 时会传出 'master-control-plane' 这个不存在的 Pod ID，
         *   Store 查不到却仍打印成功的 [KUBE-CONTROLLER] 日志——**虚假成功回执**；
         * - 选中 Worker 节点时对节点传 'restart_pod' 语义也不对。
         *
         * 真实 K8s 运维中这三类实体的处置动作完全不同，此处按类型区分：
         * - pod    → 重启 Pod（可执行）
         * - node   → 驱逐节点并恢复水位（可执行，节点级动作）
         * - master → 控制面只读巡检（禁用破坏性操作，符合生产安全逻辑）
         */}
        {view.entityType === 'master' ? (
          <button
            type="button"
            disabled
            aria-disabled
            className="flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-800/40 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-600"
            title="控制面为只读保护对象，不提供破坏性运维动作"
          >
            <ShieldCheck className="h-3 w-3" aria-hidden />
            控制面只读巡检
          </button>
        ) : (
          <button
            type="button"
            onClick={onHeal}
            className="flex w-full items-center justify-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-300 transition-all duration-150 hover:border-emerald-400/70 hover:bg-emerald-500/20 active:scale-[0.98]"
          >
            <RotateCcw className="h-3 w-3" aria-hidden />
            {view.entityType === 'node' ? '驱逐节点并恢复水位' : '隔离并重启 Pod'}
          </button>
        )}
      </div>
    </div>
  );
}

/** SparklineBlock —— 单条波形的标题行 + SVG 组合（CPU/MEM 复用） */
function SparklineBlock({
  series,
  icon,
}: {
  readonly series: SparklineSeries;
  readonly icon: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-slate-500">
          <span style={{ color: series.color }}>{icon}</span>
          {series.label}
        </span>
        <span className="font-mono text-[10px] font-bold tabular-nums" style={{ color: series.color }}>
          {series.latestText}
        </span>
      </div>
      <Sparkline series={series} />
    </div>
  );
}

/* ========================================================================== */
/* NodeInspectHUD 主体                                                         */
/* ========================================================================== */

/**
 * NodeInspectHUD —— 3D 视口左上角的实体巡检悬浮层（双态：图例 / 探针卡片）。
 *
 * 【挂载位置】由 ClusterCanvas 的 DOM 包装层内挂载，absolute 定位左上角
 * （left-3 top-3），z-20 与 ViewportToolbar 同级——高于画布内 drei <Html>
 * （zIndexRange=[10,0]），低于 PerfHud（z-40）与顶层 Modal（z-50）。
 *
 * 【小屏护栏】外层附加 max-w-[calc(100%-1.5rem)]：卡片本体固定 288px 宽，
 * 在 375px 手机竖屏下会贴到视口边缘；约束外层最大宽度后卡片随容器收窄，
 * 保证左右各留 12px 呼吸间隙且不产生横向溢出。
 *
 * 【双态渲染】view === null → 空态图例；否则 → 实体探针卡片。
 * 二者由 AnimatePresence mode="wait" 互斥过渡，避免形态交叠。
 */
export default function NodeInspectHUD({ className }: NodeInspectHUDProps) {
  /* ---- 三字段细粒度订阅（互不影响的重渲染边界） ---- */
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectedEntityType = useClusterStore((s): SelectedEntityType | null => s.selectedEntityType);
  const snapshot = useClusterStore((s): TelemetrySnapshot => s.snapshotSummary);

  /* ---- Action 订阅（引用稳定，可安全进入 useCallback 依赖） ---- */
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );
  const triggerQuickPrompt = useClusterStore((s): ((prompt: string) => void) => s.triggerQuickPrompt);
  const healEntity = useClusterStore((s): ((targetId: string, actionType: string) => void) => s.healEntity);
  const appendTerminalLog = useClusterStore((s): ((line: string) => void) => s.appendTerminalLog);

  /**
   * 巡检视图模型（实体 + 快照变更才重算）。
   *
   * 【降级策略】若选中 ID 与类型在快照中找不到对应实体（例如快照整体替换
   * 后该 Pod 已消失），deriveEntityView 返回 null → 回落到空态图例，
   * 而不是渲染一张字段残缺的卡片。
   */
  const view = useMemo((): EntityInspectView | null => {
    if (selectedEntityId === null || selectedEntityType === null) return null;
    return deriveEntityView(selectedEntityId, selectedEntityType, snapshot);
  }, [selectedEntityId, selectedEntityType, snapshot]);

  /** 关闭并重置视角：清空选中（相机飞回全景）+ 广播 overview 预设（确保复位） */
  const handleClose = useCallback((): void => {
    selectEntity(null);
    dispatchViewPreset('overview');
  }, [selectEntity]);

  /**
   * handleDiagnose —— 交由 AI Copilot 根因诊断。
   *
   * 【Prompt 构造】把实体的可观测事实（类型/名称/状态/重启/当前水位）
   * 编码为中文指令，Copilot 侧无需再次查表即可直接进入根因分析；
   * triggerQuickPrompt 内部联动右侧抽屉切至 copilot 页签（移动端切视图）。
   */
  const handleDiagnose = useCallback((): void => {
    if (view === null) return;
    const prompt =
      `请对 ${view.entityType} 实体「${view.displayName}」（ID: ${view.entityId}）执行专项根因诊断。` +
      `当前状态 ${view.statusLabel}，累计重启 ${view.restarts} 次，` +
      `CPU ${view.cpuSeries.latestText}、内存 ${view.memSeries.latestText}。` +
      `请结合最近历史趋势判断潜在故障根因，并给出可执行的修复建议。`;
    triggerQuickPrompt(prompt);
  }, [view, triggerQuickPrompt]);

  /**
   * handleHeal —— 隔离并重启实例。
   *
   * 【链路】healEntity 内部：免疫窗口去重 → 派生愈合快照（崩溃 Pod 复位
   * Running、健康分托底 ≥96）→ 写回响应轨 + 同步瞬态轨 → 追加
   * [KUBE-CONTROLLER] 终端回显。3D 侧在下一次同步后即刻转绿，
   * 网络流/涟漪环也随故障标志消失而自动复原。
   */
  const handleHeal = useCallback((): void => {
    if (view === null) return;

    /**
     * 【按实体类型分派动作，并拒绝控制面】
     *
     * 修复两个真实缺陷（审查报告 §5.1）：
     * 1. master 控制面没有对应的 Pod 实体，此前一律传 'master-control-plane'
     *    给 healEntity，Store 找不到该 ID 却仍打印成功的
     *    [KUBE-CONTROLLER] executed 日志——**虚假成功回执比报错更危险**，
     *    会让值班人员误以为控制面已被修复。此处直接拒绝并给明确提示。
     * 2. node 级目标应走节点维护动作（drain_node），而非 Pod 的 restart_pod。
     */
    if (view.entityType === 'master') {
      appendTerminalLog(
        '[WARN] 控制面为只读保护对象，已拒绝破坏性运维动作（master-control-plane）',
      );
      return;
    }

    const actionType = view.entityType === 'node' ? 'drain_node' : 'restart_pod';
    healEntity(view.entityId, actionType);
  }, [view, healEntity, appendTerminalLog]);

  return (
    <div
      className={cn('pointer-events-none absolute left-3 top-3 z-20 max-w-[calc(100%-1.5rem)]', className)}
      aria-label="实体巡检 HUD"
    >
      <AnimatePresence mode="wait">
        {view === null ? (
          <motion.div
            key="legend"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <TopologyLegendPanel />
          </motion.div>
        ) : (
          <motion.div
            key={`probe-${view.entityId}`}
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <EntityProbeCard
              view={view}
              onClose={handleClose}
              onDiagnose={handleDiagnose}
              onHeal={handleHeal}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
