'use client';

/**
 * KubeVision AI — 实体巡检悬浮 HUD（NodeInspectHUD）
 *
 * 【设计意图】把「点选 3D 实体」升级为一次完整的巡检会话：未选中时是
 * 场景的读图说明书（图例 + 手势），选中后切换为玻璃态探针卡片，
 * 同屏呈现身份、状态、元信息、实时波形与两根战术按钮（AI 诊断 / 隔离重启），
 * 让「发现异常 → 诊断根因 → 执行自愈」形成闭环而不必离开 3D 视口。
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

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode } from 'react';
import { AnimatePresence,
  motion } from 'framer-motion';
import {
  Activity,
  ChevronDown,
  Cpu,
  Filter,
  Layers,
  MemoryStick,
  MousePointerClick,
  Move3d,
  RotateCcw,
  Server,
  ShieldCheck,
  X,
  Zap,
  ZoomIn,
  Radar,
} from 'lucide-react';

import { cn } from '@/utils/cn';
import { UI_COPY } from '@/constants/copy';
import { MOTION } from '@/constants/tokens';
import { Z_CLASS } from '@/constants/zIndex';
import { useEscapeLayer } from '@/hooks/useEscapeStack';
import {
  HoloCorners,
  HoloMicroRuler,
  HoloRefractionEdges,
  HoloScanlines,
  HoloSpecularSheen,
} from '@/components/canvas/HoloHud';
import { useClusterStore } from '@/store/useClusterStore';
import { MASTER_ENTITY_ID } from '@/types/canvas';
import { dispatchViewPreset } from '@/utils/viewPresetBus';
import type { PodEntity, PodStatus, TelemetrySnapshot, WorkerNodeEntity } from '@/types/cluster';
import type { SelectedEntityType, StatusFilter } from '@/types/store';
import type {
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

/**
 * 内存波形在实体处于 critical 态时的告警配色（绯红）。
 *
 * 【为何只切内存不切 CPU】内存溢出（OOMKilled / 节点内存打满）是这套系统
 * 里最典型的故障形态，而 OOM 的因果链恰恰是"内存先顶满 → 容器被杀"。
 * 把内存曲线单独染成绯红，等于把故障的**直接证据**高亮出来，
 * 比整张卡片变色更有指向性，也不会让 CPU 曲线失去与常态的可比性。
 */
const MEM_CRITICAL_COLOR = '#f43f5e';

/** Pod 状态 → 中文徽标文案。英文原文保留在 title 提示中供 kubectl 对照。 */
const POD_STATUS_LABEL: Readonly<Record<PodStatus, string>> = {
  Running: '运行中',
  Pending: '调度中',
  CrashLoopBackOff: '崩溃重启',
  OOMKilled: '内存溢出',
  Terminating: '终止中',
};

/**
 * 节点状态 → 中文徽标文案。
 *
 * 【Ready 保留英文原文】节点就绪态在 K8s 运维语境里几乎等同于专有名词
 * （`kubectl get node` 的输出列就叫 READY，取值 Ready/NotReady），
 * 因此写成「就绪 (Ready)」：中文先行便于扫读，括号保留原文便于核对。
 * 另外两态（高负载 / 网络分区）是本系统自有的语义扩展，无官方英文对标，
 * 故直接中文化。
 */
const NODE_STATUS_LABEL: Readonly<Record<WorkerNodeEntity['status'], string>> = {
  Ready: '就绪 (Ready)',
  HighLoad: '高负载',
  NetworkPartition: '网络分区',
};

/** 历史序列目标点数（与 PodEntity 契约的 6 点 FIFO 对齐） */
const HISTORY_POINTS = 6;

/** Sparkline 默认视口尺寸（用户单位；preserveAspectRatio=none 自适应拉伸） */
const SPARKLINE_WIDTH = 132;
const SPARKLINE_HEIGHT = 32;

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
/**
 * 卡片外框（本轮改为光学玻璃拟态）。
 *
 * 【自愈什么 · 历史】更早的版本用 shadow-glow-emerald / amber / rose
 * 这类大面积彩色模糊阴影：在深色画布上那不是"发光"，而是一团脏荧光雾，
 * 边界糊掉、颜色发闷、还随状态在三色间跳变。
 *
 * 【自愈什么 · 本轮】上一版改成"单像素 hairline 描边 + 88% 不透明深底"，
 * 边框问题解决了，但它和 3D 视口里的机架/控制平面铭牌**不是同一套语言**：
 *   · 3D HUD：border 0px · radius 0px · 底色 50% 通透
 *   · 本卡片：border 1px · radius 8px · 底色 88% 近乎不透明
 * 两者在同一个视口里紧邻出现，观感上像两套 UI 拼在一起。
 *
 * 【本版】对齐 3D HUD 的光学玻璃语言：
 *   · 移除闭合边框（border-0）与圆角（rounded-none）——
 *     结构改由 HoloCorners 四角靶标 + HoloRefractionEdges 上下折射亮边表达；
 *   · 底色降到 50% 通透 + blur(24px)，与 HoloFrame 完全同源；
 *   · 保留一层中性冷投影（悬浮层级仍需与 3D 场景区分）。
 *
 * 【为何不改 .kv-panel 全局类】那套"黑曜石高定玻璃"是应用外壳
 * （TopBar / 抽屉 / 其他 DOM 面板）的统一语言，改动它会波及全站；
 * 而本卡片是浮在 3D 视口上的仪表，应当跟随 3D HUD 而非应用外壳。
 */
const CARD_SHELL_CLASS =
  'rounded-none border-0 bg-slate-950/50 shadow-[0_12px_36px_rgba(2,6,23,0.7)]';

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
    label: '运行正常',
    tone: 'healthy',
    description: '容器正常运行，服务健康',
  },
  {
    key: 'pending',
    label: '调度启动中',
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
    breadcrumb: `集群 / 机架 rack-${pod.rackIndex} / 槽位 slot-${pod.slotIndex}`,
    statusLabel: POD_STATUS_LABEL[pod.status],
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
      label: '内存',
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
    statusLabel: NODE_STATUS_LABEL[node.status],
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
      label: '内存',
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
    { label: '架构角色', value: 'API Server' },
    {
      label: '在线节点',
      value: `${nodes.filter((n): boolean => n.status === 'Ready').length} / ${nodes.length} Ready`,
    },
    { label: '容器就绪', value: `${running} / ${pods.length}` },
    { label: '吞吐速率', value: `${snapshot.totalQps.toLocaleString('en-US')} QPS` },
  ];

  return {
    entityId: MASTER_ENTITY_ID,
    entityType: 'master',
    displayName: '控制平面 · API Server',
    statusLabel: `健康分 ${Math.round(score)}`,
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
      label: '内存',
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
 * Sparkline —— 纯 SVG 绘制的实时迷你波形图（平滑描边 + 面积渐变填充）。
 *
 * 【绘制数学】
 * 1. 值域映射：v ∈ [0,100] → y = H − PAD − (v/100) × (H − 2·PAD)。
 *    减去 PAD 并压缩可用高度，使 100% 峰值与 0% 谷值都不贴边（防削顶）。
 * 2. 横轴等距：n 个点均分宽度，x_i = i × W / (n − 1)。
 * 3. **平滑曲线（本轮核心改动）**：由生硬的 `<polyline>` 折线升级为
 *    `<path>` 三次贝塞尔（C 指令），用 **Catmull-Rom 样条**插值生成控制点。
 *    Catmull-Rom 的几何意义是：曲线在 P1 处的切线方向平行于 (P2 − P0)，
 *    因此相邻线段在节点处**切线连续（C¹）**——这正是示波器轨迹那种
 *    "不带折角"的柔顺感来源。折线只是 C⁰ 连续，每个采样点都是一个可见拐点。
 *
 *    由 Catmull-Rom 转三次贝塞尔的公式（张力 τ = 1 的标准型）：
 *      对于 P1 → P2 这一段，
 *        C1 = P1 + (P2 − P0) / 6
 *        C2 = P2 − (P3 − P1) / 6
 *      端点处的 P0 / P3 用 P1 / P2 自身顶替（虚拟端点），
 *      等价于把端点切线压平——这符合"最新值在右端"的读图直觉。
 *
 * 4. **控制点纵坐标夹逼**：Catmull-Rom 在剧烈跳变处会产生**过冲（overshoot）**，
 *    控制点可能落到绘图带之外，曲线就会冲出 PAD 区间甚至越出 viewBox。
 *    因此把 C1.y / C2.y 夹逼回 [PAD, H − PAD]，保证曲线始终留在安全带内。
 *    夹逼只在极端跳变时发生，常态下控制点本就落在带内，不影响平滑度。
 * 5. 面积：复用同一条平滑路径闭合到底边（L W,H → L 0,H → Z），
 *    填充指向 <linearGradient>（上方 color@0.45 → 下方 color@0），
 *    渐变 id 由 useId 生成，避免同页多实例 id 冲突（SVG id 全局唯一）。
 * 6. 末端高亮：最后一个点画实心圆 + 外圈光环，强调「当前值」。
 *
 * 【为何用 SVG 而非 Canvas】6 点曲线用 SVG 开销极低，且能直接复用
 * Tailwind 的 currentColor 与 CSS 过渡（stroke 颜色随状态变化时平滑过渡）。
 */
function Sparkline({ series, width = SPARKLINE_WIDTH, height = SPARKLINE_HEIGHT }: SparklineProps) {
  /* 唯一渐变 id：React 18 useId 输出含冒号，需在 SVG url() 引用前安全化 */
  const rawId = useId();
  const gradientId = `kv-spark-${rawId.replace(/:/g, '')}`;

  const geometry = useMemo((): {
    readonly line: string;
    readonly area: string;
    readonly lastX: number;
    readonly lastY: number;
  } => {
    const values = series.values;
    const count = values.length;
    const usableHeight = height - SPARKLINE_PAD_Y * 2;
    const stepX = count > 1 ? width / (count - 1) : width;

    /* ---- 1. 采样点：等距 x + 线性映射 y ---- */
    const points: Array<{ readonly x: number; readonly y: number }> = [];
    for (let i = 0; i < count; i++) {
      const x = i * stepX;
      const y = height - SPARKLINE_PAD_Y - (clampPercent(values[i]) / 100) * usableHeight;
      points.push({ x, y });
    }

    const first = points[0];
    const last = points[points.length - 1];

    /* 防御：0 点（理论上不会出现，values 契约要求长度 ≥ 2） */
    if (first === undefined || last === undefined) {
      return { line: '', area: '', lastX: 0, lastY: height - SPARKLINE_PAD_Y };
    }

    /* 控制点纵坐标的安全带：与采样点的可用高度一致，防过冲越界 */
    const minY = SPARKLINE_PAD_Y;
    const maxY = height - SPARKLINE_PAD_Y;
    const clampY = (v: number): number => Math.min(maxY, Math.max(minY, v));

    /* ---- 2. Catmull-Rom → 三次贝塞尔 ---- */
    let path = `M ${first.x.toFixed(2)},${first.y.toFixed(2)}`;
    for (let i = 0; i < points.length - 1; i++) {
      /* 虚拟端点：首段用 P1 顶替 P0，末段用 P2 顶替 P3 */
      const p0 = points[i > 0 ? i - 1 : i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2 < points.length ? i + 2 : i + 1];

      /* 标准 Catmull-Rom（张力 1）→ 贝塞尔控制点，除以 6 是公式常数 */
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = clampY(p2.y - (p3.y - p1.y) / 6);

      path +=
        ` C ${c1x.toFixed(2)},${c1y.toFixed(2)}` +
        ` ${c2x.toFixed(2)},${c2y.toFixed(2)}` +
        ` ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
    }

    /* ---- 3. 面积路径：同一条平滑曲线闭合到底边 ---- */
    const area =
      `${path}` +
      ` L ${width.toFixed(2)},${height.toFixed(2)}` +
      ` L 0,${height.toFixed(2)} Z`;

    return { line: path, area, lastX: last.x, lastY: last.y };
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
      {/*
       * ---- 仪器网格刻度线（本轮新增）----
       *
       * 【为什么需要】此前趋势图是一块**纯面积填充**：读者只能看出"在涨还是在跌"，
       * 无法判断"现在到底多高"——没有坐标参考的曲线不是仪表，是装饰。
       *
       * 【构造】三条水平参考线（25% / 50% / 75%）+ 四条纵向时间刻度。
       * 用极低不透明度（0.06 / 0.05）绘制，因此远看只是"有一层精密网格"，
       * 不会与曲线争夺注意力；近看则能读出当前值落在哪个区间。
       *
       * 【为何画在面积之前】SVG 按文档序绘制，网格先画 → 永远位于面积与曲线之下，
       * 不会被半透明填充盖住而变脏。
       */}
      <g aria-hidden stroke={series.color} strokeWidth={0.5} fill="none">
        {[0.25, 0.5, 0.75].map((ratio): ReactNode => {
          const gy = SPARKLINE_PAD_Y + (height - SPARKLINE_PAD_Y * 2) * ratio;
          return <line key={`grid-h-${ratio}`} x1={0} y1={gy} x2={width} y2={gy} opacity={0.06} />;
        })}
        {[0.25, 0.5, 0.75].map((ratio): ReactNode => (
          <line
            key={`grid-v-${ratio}`}
            x1={width * ratio}
            y1={SPARKLINE_PAD_Y}
            x2={width * ratio}
            y2={height - SPARKLINE_PAD_Y}
            opacity={0.05}
            strokeDasharray="2 3"
          />
        ))}
        {/* 顶/底基线：只在这里给足不透明度，形成"量程边界"的仪器感 */}
        <line x1={0} y1={SPARKLINE_PAD_Y} x2={width} y2={SPARKLINE_PAD_Y} opacity={0.16} />
        <line
          x1={0}
          y1={height - SPARKLINE_PAD_Y}
          x2={width}
          y2={height - SPARKLINE_PAD_Y}
          opacity={0.16}
        />
      </g>

      {/* 面积填充（引用渐变，形成由浓到透的体积感） */}
      <path d={geometry.area} fill={`url(#${gradientId})`} stroke="none" />
      {/* 平滑曲线描边（C 指令贝塞尔，节点处切线连续） */}
      <path
        d={geometry.line}
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
 * 又把稳态下的画面占用从 ~200px 高压缩到 ~28px。
 *
 * 【本轮：外框升级为悬浮胶囊徽章】
 * 原先套的是通用 `.kv-panel`（含纵向渐变 + 大投影），在收起态像一块
 * 被截断的矩形卡片，与它自身"一行小胶囊"的体量不匹配。
 * 现改为专用胶囊外壳：`rounded-full border-white/[0.08] bg-slate-950/75
 *`——半透明深底 + 毛玻璃让背后的 3D 场景仍隐约可见，
 * 视觉上像一枚浮在视口上的精致徽章，而不是又一个面板。
 *
 * 【圆角随展开态切换】收起态 `rounded-full` 是胶囊；展开后高度达到
 * 十几行内容，若仍是 full 圆角会变成两端半圆的怪异形状，
 * 故展开时切到 `rounded-2xl`。两者用 transition 平滑过渡。
 */
function TopologyLegendPanel() {
  const [expanded, setExpanded] = useState<boolean>(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /**
   * R74：展开后支持点击外部 / Esc 关闭。
   *
   * 只用 pointerdown 而不是 click：拖拽 3D 相机时 pointerup 可能落在画布外，
   * click 不一定触发；pointerdown 能稳定表达“用户开始操作别处”。
   * 点击面板/按钮内部不关闭（root.contains 判断）。
   *
   * 【R3】Esc 关闭注册进分级退出栈（优先级 30：视口浮层，低于一切功能模态）。
   * 旧实现自挂 window keydown 且不判层级——混沌弹窗开着时按 Esc 会把图例
   * 一起关掉；入栈后一次 Esc 只退最上层。
   */
  const closeLegend = useCallback((): void => setExpanded(false), []);
  useEscapeLayer(
    expanded ? { id: 'topology-legend', priority: 30, label: '读图说明', onEscape: closeLegend } : null,
  );

  useEffect((): (() => void) | undefined => {
    if (!expanded) return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root === null || !(event.target instanceof Node) || root.contains(event.target)) {
        return;
      }
      setExpanded(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return (): void => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [expanded]);

  /**
   * R73：触发按钮与浮层彻底解耦。
   *
   * 【为什么不把按钮和内容放在同一个自适应容器里】旧实现在 open 切换时
   * 直接改外框宽度与 rounded-full/rounded-2xl，0ms 内从 124px 跳到 256px，
   * 收起时还会先变成畸形大胶囊。现在按钮几何恒定，只有下方的绝对浮层
   * 通过 transform/opacity 进出，宽度不再参与动画。
   */
  return (
    <div ref={rootRef} className="pointer-events-none relative flex flex-col items-start">
      <button
        type="button"
        onClick={(): void => setExpanded((prev): boolean => !prev)}
        aria-expanded={expanded}
        aria-label="切换 3D 拓扑读图说明"
        className={cn(
          'pointer-events-auto group flex min-h-[44px] items-center gap-2 rounded-lg border px-3 py-1.5 kv-blur-chip transition-all duration-200 md:min-h-0',
          expanded
            ? 'border-cyan-400/[0.45] bg-slate-900/90 text-cyan-200 shadow-[0_0_20px_-4px_rgba(34,211,238,0.35)]'
            : 'border-slate-800/90 bg-slate-950/80 text-slate-300 hover:border-cyan-400/[0.35] hover:text-cyan-200',
        )}
      >
        <Layers className="h-3 w-3 shrink-0 text-cyan-400" aria-hidden />
        <span className="flex items-center gap-1" aria-hidden>
          {TOPOLOGY_LEGEND.map((item): ReactNode => (
            <span
              key={item.key}
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_BG_CLASS[item.tone])}
              title={`${item.label} · ${item.description}`}
            />
          ))}
        </span>
        <span className="font-mono text-[10px] tracking-wider">读图说明</span>
        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 text-slate-400 transition-transform duration-200 ease-out',
            expanded && 'rotate-180 text-cyan-300',
          )}
          aria-hidden
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="topology-legend-dropdown"
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            style={{ transformOrigin: 'top left' }}
            className="pointer-events-auto relative mt-1.5 max-h-[min(22rem,calc(100dvh-11rem))] w-[min(16rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-cyan-400/25 bg-slate-950/90 px-3.5 py-3 shadow-[0_16px_40px_-8px_rgba(2,6,23,0.92)] kv-blur-panel"
          >
            <HoloRefractionEdges accent="#22d3ee" />
            <HoloCorners color="#22d3ee" />
            <div className="relative">
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
                      <span className="ml-1.5 text-[10px] leading-snug text-slate-400">{item.description}</span>
                    </span>
                  </li>
                ))}
              </ul>

              {/* 分隔 */}
              <div className="my-2 border-t border-white/[0.07]" />

              {/* 手势提示 */}
              <div className="mb-1.5 flex items-center gap-1.5">
                <Move3d className="h-3 w-3 text-slate-400" aria-hidden />
                <p className="font-mono text-[10px] tracking-wider text-slate-400">相机操作</p>
              </div>
              <ul className="grid grid-cols-2 gap-x-2 gap-y-1">
                {GESTURE_HINTS.map((hint) => (
                  <li key={hint.key} className="flex items-center gap-1">
                    {hint.key === 'rotate' ? (
                      <RotateCcw className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
                    ) : hint.key === 'pan' ? (
                      <Move3d className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
                    ) : hint.key === 'zoom' ? (
                      <ZoomIn className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
                    ) : (
                      <MousePointerClick className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
                    )}
                    <span className="truncate font-mono text-[10px] text-slate-400">
                      {hint.label} <span className="text-slate-400">·</span>{' '}
                      <span className="text-slate-300">{hint.effect}</span>
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
 * 【本轮的布局改造：从竖排长卡改为 176px 双列紧凑卡】
 * 旧卡片是 5 段竖排：头部（名称 + 类型行）→ 状态徽标行 → 4 行元信息 dl →
 * 竖排双波形 → 数据口径说明 → 竖排双按钮。总高约 300px+，在 3D 视口左上角
 * 占据过大面积，把拓扑场景压得只剩右侧一条。问题不在信息量，而在**排布方式**：
 * 每一行都只有一个信息单元，纵向堆叠必然变长。
 *
 * 现压缩为 4 行，横向利用空间：
 *  1. 头部：状态呼吸点 + 名称 + 内联状态徽标 + 重启徽标 + 关闭按钮（单行）
 *  2. 波形：CPU / 内存 **左右并排**（grid-cols-2），各含百分比大数字 + 32px Sparkline
 *  3. 元数据：4 行 dl 压成一行 `·` 分隔条
 *  4. 战术按钮：两枚按钮 **左右并排**（grid-cols-2）
 *
 * 删掉的两项：
 * - 单独占一行的 `RESTARTS` 框 → 并入头部徽标（且仅 restarts > 0 时出现，
 *   0 次重启是常态，不该在稳态占用头部空间）；
 * - `history source · direct samples` 英文说明行 → 该信息对用户零价值
 *   （用户不关心曲线是直接采集还是聚合派生，只关心趋势），且是纯英文。
 *   数据口径仍保留在视图模型里，供需要时在别处呈现。
 *
 * 【状态语义】statusTone 同时驱动：呼吸点颜色、徽标配色、卡片外环、
 * 以及 **内存波形在 critical 态转为绯红**（OOM 故障的直接证据高亮）。
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
  const EntityIcon = view.entityType === 'pod' ? Radar : view.entityType === 'node' ? Server : Activity;

  /* 重启次数强调：≥3 次视为反复崩溃（rose），1~2 次琥珀 */
  const restartsTone: InspectTone =
    view.restarts >= 3 ? 'critical' : view.restarts > 0 ? 'warning' : 'healthy';

  /**
   * 内存序列配色：critical 态切换为绯红。
   *
   * 【为何在渲染层而非派生层做】派生层（derivePodView 等）只负责"数据是什么"，
   * 配色是"怎么显示"的问题，属于渲染层职责。放在这里也保证同一个序列
   * 在不同上下文中可以被赋予不同颜色，而不必改动视图模型。
   */
  const memSeries = useMemo((): SparklineSeries => {
    if (view.statusTone !== 'critical') return view.memSeries;
    return { ...view.memSeries, color: MEM_CRITICAL_COLOR };
  }, [view.memSeries, view.statusTone]);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState<boolean>(false);

  /** 元数据条：只取 value 并用 `·` 连接（label 保留在 title 中供核对） */

  return (
    <div
      className={cn(
        'pointer-events-auto relative max-h-[calc(100dvh-11rem)] w-[min(320px,calc(100vw-1.5rem))] overflow-y-auto p-3 sm:w-[340px]',
        CARD_SHELL_CLASS,
      )}
    >
      {/*
       * ---- 与其他铭牌统一的全息 HUD 语言 ----
       *
       * 机架贴地铭牌、控制平面铭牌、Pod 悬停探针卡都已采用
       * 「四角战术折角 + 扫描线底纹」，巡检卡若不跟随就会显得是另一套 UI。
       * 这里只叠加装饰层（绝对定位、pointer-events-none），
       * 不改动任何既有布局与交互。
       */}
      <HoloScanlines />
      {/*
       * ---- 四角战术折角 ----
       *
       * 【本轮修正】上一轮折角按 tone 染色（绿/琥珀/红）。但折角是**结构标记**
       * 而非状态标记——状态已经由左侧呼吸点、状态徽标、外环色三重表达，
       * 折角再变色就变成"同一个信息说四遍"。
       * 现固定为主题青（与 3D 视口内铭牌同一套青色 HUD 语言），
       * 状态语义交还给真正该承担它的元素。
       */}
      <HoloCorners color="#22d3ee" />

      {/*
       * ---- 光学折射亮边 + 斜向折射高光 ----
       *
       * 【本轮修正】上一版只手工画了「顶部激光高光边线」一条。
       * 单边高光暗示的是"一块被照亮的平面"，而玻璃板是被光**穿过**的——
       * 上下沿都必须有折射亮边，才能读作"有厚度的光学基板"。
       * 同时补一层 135° 斜向折射高光：这是玻璃与塑料的分野。
       */}
      <HoloSpecularSheen />
      <HoloRefractionEdges accent="#22d3ee" />

      {/*
       * ---- 顶部毫米级微标尺装饰条 ----
       *
       * 检视舱是"查看单个实体"的面板，语义上最接近仪表的"读数面"。
       * 加一条 `SYS // INSPECT` 微标尺后，面板从信息卡片变成仪表读数窗。
       */}
      <HoloMicroRuler
        label={UI_COPY.holoRulerInspect}
        accent="#22d3ee"
        tickCount={20}
        cursorAt={0.42}
        className="mb-0.5"
      />

      {view.breadcrumb !== undefined ? (
        <p
          data-testid="inspect-breadcrumb"
          className="truncate font-mono text-[10px] tracking-[0.06em] text-cyan-300/80"
          title={view.breadcrumb}
        >
          {view.breadcrumb}
        </p>
      ) : null}

      {/* ============ 第 1 行：状态点 + 名称 + 状态徽标 + 重启徽标 + 关闭 ============ */}
      <div className="flex items-center gap-1.5">
        {/* 状态呼吸点：critical 时叠加 ping 脉冲，稳态只保留静点 */}
        <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
          {view.statusTone === 'critical' ? (
            <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', TONE_BG_CLASS[view.statusTone])} />
          ) : null}
          <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', TONE_BG_CLASS[view.statusTone])} />
        </span>

        <EntityIcon className={cn('h-3 w-3 shrink-0', TONE_TEXT_CLASS[view.statusTone])} aria-hidden />

        <p className="min-w-0 flex-1 truncate font-mono text-xs font-bold text-slate-100" title={view.displayName}>
          {view.displayName}
        </p>

        {/* 内联状态徽标胶囊 */}
        <span
          className={cn(
            'shrink-0 rounded border px-1 py-0.5 font-mono text-[10px] font-bold leading-none tracking-wide',
            TONE_RING_CLASS[view.statusTone],
            TONE_TEXT_CLASS[view.statusTone],
          )}
          title={view.statusLabel}
        >
          {view.statusLabel}
        </span>

        {/*
         * 重启徽标（本轮改为常驻）。
         *
         * 【自愈什么】旧实现只在 restarts > 0 时渲染，看似省空间，实则让
         * "0 次重启"这一关键稳态信息完全不可见——用户无法确认集群是否真的干净。
         *
         * 【改为】始终显示：0 次时用沉稳灰青（hairline 边框 + slate-400 文字），
         * 传达"读过了，就是 0"而不是"没有这项数据"；> 0 才升级为琥珀/玫瑰告警色。
         * 灰徽章在视觉上安静，不会与健康态的绿色状态徽标抢注意力。
         */}
        <span
          className={cn(
            'shrink-0 rounded border px-1 py-0.5 font-mono text-[10px] font-bold leading-none tabular-nums tracking-wide',
            view.restarts === 0
              ? 'border-white/[0.04] text-slate-400'
              : restartsTone === 'critical'
                ? 'border-rose-500/50 text-rose-300'
                : 'border-amber-500/50 text-amber-300',
          )}
          title={view.restarts === 0 ? '初始稳态：该对象无重启记录' : `累计重启 ${view.restarts} 次`}
        >
          {view.restarts} 次重启
        </span>

        <button
          type="button"
          onClick={onClose}
          aria-label="关闭巡检卡片并重置视角"
          title="关闭并重置视角"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 active:scale-95 md:h-auto md:w-auto md:p-0.5"
        >
          <X className="h-3.5 w-3.5 md:h-3 md:w-3" aria-hidden />
        </button>
      </div>

      {/* 移动端（< md）按需折叠实时波形与元信息网格，避免首屏巡检卡遮挡 3D 视野 */}
      <button
        type="button"
        onClick={(): void => setMobileDetailsOpen((prev): boolean => !prev)}
        aria-expanded={mobileDetailsOpen}
        className="mt-2 flex min-h-[44px] w-full items-center justify-between rounded border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 font-mono text-[10px] font-semibold text-slate-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-200 md:hidden"
      >
        <span>{mobileDetailsOpen ? '收起指标详情' : '展开指标详情'}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-slate-400 transition-transform duration-150', mobileDetailsOpen && 'rotate-180')}
          aria-hidden
        />
      </button>

      {/* ============ 第 2 行：CPU / 内存 双列波形 ============ */}
      <div className={cn('mt-2 grid-cols-2 gap-2', mobileDetailsOpen ? 'grid' : 'hidden md:grid')}>
        <MiniGauge series={view.cpuSeries} icon={<Cpu className="h-2.5 w-2.5" aria-hidden />} />
        <MiniGauge series={memSeries} icon={<MemoryStick className="h-2.5 w-2.5" aria-hidden />} />
      </div>

      {/* ============ 第 3 行：2×2 结构化微仪表网格 ============ */}
      {/*
       * 【自愈什么】此前是一行用 `·` 连接的纯值串（`3 个 · 24 / 24 运行中 · 1,586`），
       * 字段名被全部丢弃——读者根本不知道 `3 个` 指什么、`1,586` 是什么单位。
       * 信息没传达出去，却照样占满一整行。
       *
       * 【改为】2×2 微仪表网格：左列浅灰字段名（等宽、固定不收缩），
       * 右列亮白数值（tabular-nums 等宽数字，纵向对齐）。
       * 这是仪表盘的标准做法：标签与值分列，视线能沿列快速扫读。
       */}
      <div
        className={cn(
          'mt-2 grid-cols-2 gap-x-3 gap-y-1 rounded border border-white/[0.06] bg-white/[0.03] px-2 py-1.5',
          mobileDetailsOpen ? 'grid' : 'hidden md:grid',
        )}
      >
        {view.metaRows.length === 0 ? (
          <span className="col-span-2 font-mono text-[10px] text-slate-400">—</span>
        ) : (
          view.metaRows.slice(0, 4).map((row): ReactNode => (
            <div key={row.label} className="flex min-w-0 items-baseline gap-1.5">
              <span
                className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-400"
                title={row.label}
              >
                {row.label}
              </span>
              <span
                className="min-w-0 truncate font-mono text-[10px] font-semibold tabular-nums text-slate-100"
                title={row.value}
              >
                {row.value}
              </span>
            </div>
          ))
        )}
      </div>

      {/* ============ 第 4 行：双战术按钮并排 ============ */}
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={onDiagnose}
          className="flex min-h-[44px] items-center justify-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-1.5 font-mono text-[10px] font-bold tracking-wide text-cyan-300 transition-all duration-150 hover:border-cyan-400/70 hover:bg-cyan-500/20 active:scale-[0.98] md:min-h-0"
        >
          <Radar className="h-2.5 w-2.5 shrink-0" aria-hidden />
          <span className="truncate">AI 深度诊断</span>
        </button>

        {/*
         * 【按实体类型定制动作】Master / Node / Pod 的处置动作完全不同：
         * - pod    → 重启 Pod（可执行）
         * - node   → 驱逐节点并恢复水位（可执行，节点级动作）
         * - master → 控制面只读巡检（禁用破坏性操作，符合生产安全逻辑）
         * 早期一律渲染「隔离并重启实例」并传 'master-control-plane' 给
         * healEntity，会打印虚假成功回执。
         */}
        {view.entityType === 'master' ? (
          <button
            type="button"
            disabled
            aria-disabled
            className="flex min-h-[44px] cursor-not-allowed items-center justify-center gap-1 rounded border border-white/[0.06] bg-white/[0.02] px-1.5 py-1.5 font-mono text-[10px] font-bold tracking-wide text-slate-400 md:min-h-0"
            title="控制平面为只读保护对象，不提供破坏性运维动作"
          >
            <ShieldCheck className="h-2.5 w-2.5 shrink-0" aria-hidden />
            <span className="truncate">控制平面只读</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onHeal}
            className="flex min-h-[44px] items-center justify-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-1.5 font-mono text-[10px] font-bold tracking-wide text-emerald-300 transition-all duration-150 hover:border-emerald-400/70 hover:bg-emerald-500/20 active:scale-[0.98] md:min-h-0"
          >
            <RotateCcw className="h-2.5 w-2.5 shrink-0" aria-hidden />
            <span className="truncate">{view.entityType === 'node' ? '驱逐并恢复水位' : '隔离并重启'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * MiniGauge —— 双列波形格（左侧标题 + 右侧大号百分比 + 下方 32px Sparkline）。
 *
 * 【为何百分比放大、标题缩小】这是仪表盘的核心读图逻辑：用户扫一眼需要的是
 * **当前水位数值**（89.0%），而不是「CPU」这个词（它由位置与图标已经说明）。
 * 因此百分比用 font-bold 大号，标题保持小号淡色。
 */
function MiniGauge({
  series,
  icon,
}: {
  readonly series: SparklineSeries;
  readonly icon: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-1">
        <span className="flex min-w-0 items-center gap-0.5 font-mono text-[10px] tracking-wide text-slate-400">
          <span style={{ color: series.color }}>{icon}</span>
          <span className="truncate">{series.label}</span>
        </span>
        <span className="shrink-0 font-mono text-[13px] font-bold tabular-nums leading-none" style={{ color: series.color }}>
          {series.latestText}
        </span>
      </div>
      <Sparkline series={series} height={SPARKLINE_HEIGHT} />
    </div>
  );
}

/* ========================================================================== */
/* 子组件：当前筛选视图横幅                                                     */
/* ========================================================================== */

/**
 * 筛选值 → 横幅展示元数据（中文名 + K8s 原始枚举）。
 *
 * 【为何同时给中英双语】中文负责扫读，括号里的原始枚举负责与 kubectl 对照：
 * 值班人员看到「调度中 (Pending)」能立刻对上 `kubectl get pods` 的 STATUS 列。
 */
const FILTER_BANNER_META: Readonly<
  Record<
    Exclude<StatusFilter, 'ALL'>,
    { readonly label: string; readonly raw: string }
  >
> = {
  Running: { label: '运行中', raw: 'Running' },
  Pending: { label: '调度中', raw: 'Pending' },
  CrashLoopBackOff: { label: '崩溃重启', raw: 'CrashLoopBackOff' },
  OOMKilled: { label: '内存溢出', raw: 'OOMKilled' },
  Terminating: { label: '终止中', raw: 'Terminating' },
};

/**
 * FilterStatusBanner —— 3D 视口顶部中央的「当前筛选视图」浮动状态条。
 *
 * 【解决什么】顶栏筛选按钮生效后，视口里没有任何文字说明当前处于哪个视图：
 * - 稳态下「全部」与「运行中」的画面**完全一致**（24 个绿容器），
 *   用户点完不知道自己是否切换成功；
 * - 点「调度中」这类 0 匹配项时，容器缩小（旧实现）或幽灵化（新实现），
 *   但没有任何地方告诉他"这是因为当前没有该状态的容器"。
 *
 * 横幅把这层信息显式化：
 * - 有匹配 → 青色条：`正在筛选：「运行中」容器 · 共命中 24 / 24 个实例` + 重置入口；
 * - 零匹配 → 琥珀条：说明当前集群确实没有该状态，并给「注入故障演练」
 *   与「返回全部视图」两条出路（既解释了现象，又提供了下一步动作）。
 *
 * 【只有 statusFilter ≠ 'ALL' 才渲染】全量视图是默认态，常驻说明属于噪音。
 */
function FilterStatusBanner() {
  const statusFilter = useClusterStore((s): StatusFilter => s.statusFilter);
  const snapshot = useClusterStore((s): TelemetrySnapshot => s.snapshotSummary);
  const setStatusFilter = useClusterStore(
    (s): ((filter: StatusFilter) => void) => s.setStatusFilter,
  );
  const setChaosModalOpen = useClusterStore(
    (s): ((open: boolean) => void) => s.setChaosModalOpen,
  );
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) =>
      s.selectEntity,
  );

  /**
   * handleExitFilteredView —— 统一退出「筛选视图」。
   *
   * 【为什么要同时清空选中实体】
   * 筛选视图与相机聚焦是**同一段观察意图的两个侧面**：用户按下「崩溃重启」
   * 过滤器时，往往同时点开了某个实例看细节；此时按 ESC 若只退回全部视图而
   * 保留选中态，相机会继续锁在那个实例上——视图退出了，镜头却没退出，
   * 用户还得再找一次关闭按钮。统一处理让一次 ESC 回到"干净的初始观察态"。
   *
   * 【相机如何复位】`selectEntity(null)` 已足够：CameraRig 的聚焦 effect
   * 观察到 entityId 为 null 即回到全景鸟瞰位（见 cameraFocus 的类型契约），
   * 无需额外 dispatchViewPreset。
   *
   * 【复用点】ESC 与横幅上两个「返回全部」按钮共用本函数，
   * 保证键盘与鼠标两条路径行为完全一致。
   */
  const handleExitFilteredView = useCallback((): void => {
    setStatusFilter('ALL');
    selectEntity(null);
  }, [setStatusFilter, selectEntity]);

  /**
   * ESC 退出筛选视图（同时清空选中实体）。
   *
   * 【R3：入栈而非自挂监听】优先级 10——高于页面兜底（清选中/关 HUD），
   * 低于一切模态与视口浮层。分级栈结构性保证「关掉弹窗绝不顺手重置过滤器」，
   * 不再依赖 defaultPrevented 的监听器注册顺序碰巧成立。
   *
   * 【触发条件严格限定 statusFilter !== 'ALL'】只有处于筛选态时 ESC 才是
   * "退出筛选"。全量视图下 ESC 不该顺手清掉用户正在看的实体——
   * 那属于探针卡关闭按钮（X）的职责，两条路径语义不同。
   */
  useEscapeLayer(
    statusFilter !== 'ALL'
      ? { id: 'status-filter', priority: 10, label: '筛选视图', onEscape: handleExitFilteredView }
      : null,
  );

  /* 全量视图：默认态，不渲染任何说明 */
  if (statusFilter === 'ALL') return null;

  const meta = FILTER_BANNER_META[statusFilter];
  const total = snapshot.pods.length;
  const matched = snapshot.pods.filter((pod): boolean => pod.status === statusFilter).length;
  const isEmpty = matched === 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ type: 'spring', ...MOTION.spring }}
      role="status"
      aria-live="polite"
      className={cn(
        'kv-panel pointer-events-auto flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2 rounded-full px-3 py-1.5',
        isEmpty ? 'border-amber-500/[0.45]' : 'border-cyan-500/40',
      )}
    >
      <Filter
        className={cn('h-3 w-3 shrink-0', isEmpty ? 'text-amber-400' : 'text-cyan-400')}
        aria-hidden
      />

      {isEmpty ? (
        /*
         * 【零命中说明（本轮强化）】用户点了一个计数为 0 的筛选器时，
         * 画面里 24 台刀片全部转为冷灰蓝幽灵态——整体变灰、却没有任何高亮，
         * 极易被误读为"点击无效"或"画面坏了"。
         * 因此文案必须同时回答两件事：
         *   1. 集群里确实没有该状态的容器（不是按钮失效）；
         *   2. 那些变灰的方块**仍然存在**，是刻意的幽灵透视参考态。
         * 只写"无处于该状态的容器"仍不够——用户会追问"那我的容器去哪了"。
         */
        <span className="font-mono text-[11px] leading-tight text-amber-300">
          当前集群无「{meta.label}（{meta.raw}）」容器 · {total} 个实例均处于幽灵透视参考态 · 请点击右侧注入故障演练或返回全部视图
        </span>
      ) : (
        <span className="font-mono text-[11px] leading-tight text-cyan-300">
          正在筛选：「{meta.label}」容器 · 共命中 {matched} / {total} 个实例
        </span>
      )}

      {isEmpty ? (
        <>
          {/* 零匹配：给"注入故障演练"这条出路，让用户能制造出该状态 */}
          <button
            type="button"
            onClick={(): void => setChaosModalOpen(true)}
            className="flex shrink-0 items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] tracking-tight text-amber-300 transition-colors hover:bg-amber-500/20"
          >
            <Zap className="h-2.5 w-2.5" aria-hidden />
            注入故障演练
          </button>
          <button
            type="button"
            onClick={handleExitFilteredView}
            className="shrink-0 rounded-full border border-white/[0.08] px-2 py-0.5 font-mono text-[10px] tracking-tight text-slate-400 transition-colors hover:border-white/[0.16] hover:text-slate-200"
          >
            返回全部视图
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={handleExitFilteredView}
          className="shrink-0 rounded-full border border-cyan-500/40 px-2 py-0.5 font-mono text-[10px] tracking-tight text-cyan-300 transition-colors hover:bg-cyan-500/[0.15]"
        >
          重置为全部（Esc）
        </button>
      )}
    </motion.div>
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
      `请结合最近历史趋势判断潜在故障根因，并给出可执行的自愈建议。`;
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
     * 自愈两个真实缺陷（审查报告 §5.1）：
     * 1. master 控制面没有对应的 Pod 实体，此前一律传 'master-control-plane'
     *    给 healEntity，Store 找不到该 ID 却仍打印成功的
     *    [KUBE-CONTROLLER] executed 日志——**虚假成功回执比报错更危险**，
     *    会让值班人员误以为控制面已被自愈。此处直接拒绝并给明确提示。
     * 2. node 级目标应走节点维护动作（drain_node），而非 Pod 的 restart_pod。
     */
    if (view.entityType === 'master') {
      appendTerminalLog(
        '[WARN] 控制平面为只读保护对象，已拒绝破坏性运维动作（master-control-plane）',
      );
      return;
    }

    const actionType = view.entityType === 'node' ? 'drain_node' : 'restart_pod';
    healEntity(view.entityId, actionType);
  }, [view, healEntity, appendTerminalLog]);

  return (
    <>
      {/*
       * ---- 当前筛选视图横幅（视口顶部中央） ----
       *
       * 独立于左上角的巡检卡：筛选是"全局视图状态"，与"某个实体被选中"
       * 是两个正交的维度，放在中央顶部才不会与实体探针争位。
       * z-20 与探针卡同级（高于画布内 <Html> 的 [10,0]）。
       */}
      <div
        className={cn(
          'pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 max-w-[calc(100%-1.5rem)]',
          Z_CLASS.CANVAS_FLOATING,
        )}
      >
        <AnimatePresence>
          <FilterStatusBanner />
        </AnimatePresence>
      </div>

      <div
        className={cn(
          'pointer-events-none absolute left-3 top-3 max-h-[calc(100%-6rem)] max-w-[calc(100%-1.5rem)]',
          Z_CLASS.CANVAS_FLOATING,
          className,
        )}
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
            transition={{ type: 'spring', ...MOTION.spring }}
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
    </>
  );
}