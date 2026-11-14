/**
 * KubeVision AI — 巡检 HUD 层类型契约（唯一类型源）
 *
 * 【契约】依据 AGENTS.md 第 2 条：所有组件 Props 必须严格引用 src/types/
 * 下的接口定义，禁止 any / @ts-ignore。本文件覆盖 NodeInspectHUD 及其
 * 子组件（顶层图例、手势提示、实体探针卡片、SVG Sparkline）的全部 Props 形状。
 *
 * 【设计意图】
 * 1. 「实体巡检视图模型（EntityInspectView）」把三态实体（pod / node / master）
 *    的异构字段收敛为单一展示形状，卡片 JSX 因此只依赖一个类型，
 *    新增实体类型时只需扩展派生函数，渲染层零改动（开放-封闭原则）。
 * 2. 历史序列**不伪造**：PodEntity 自带 cpuHistory/memHistory（6 点 FIFO）；
 *    WorkerNodeEntity 与 MASTER 无历史字段，故其序列由名下 Pod 真实历史
 *    聚合派生（详见 NodeInspectHUD 内 deriveEntityView 的 JSDoc），
 *    来源以 historySource 字段显式标注，UI 可据此展示数据口径。
 */

import type { SelectedEntityType } from '@/types/store';

/* ========================================================================== */
/* 通用视觉分级                                                                */
/* ========================================================================== */

/**
 * InspectTone —— 巡检语义色三级（与项目 status 语义色体系严格对齐）。
 *
 * 【配色契约】（AGENTS.md 第 5 条）
 * - 'healthy'  → emerald-400 正常（图例：翠绿 = Running）
 * - 'warning'  → amber-400   过渡/高负载（图例：琥珀 = Pending）
 * - 'critical' → rose-500    故障（图例：鲜红 = Faulty）
 */
export type InspectTone = 'healthy' | 'warning' | 'critical';

/* ========================================================================== */
/* 空态：拓扑图例与操作手势                                                     */
/* ========================================================================== */

/**
 * TopologyLegendItem —— 集群拓扑图例条目（未选中实体时展示）。
 *
 * 【语义】把 3D 场景中的实例着色语言翻译为可读的状态词典：
 * 用户看到某个方块是翠绿/琥珀/鲜红，即可对应到 Pod 生命周期状态。
 */
export interface TopologyLegendItem {
  /** 稳定键（同 tone 在图例中至多出现一次） */
  readonly key: string;
  /** 状态名（英文原文，如 'Running'） */
  readonly label: string;
  /** 色板语义（决定圆点颜色） */
  readonly tone: InspectTone;
  /** 中文释义（一句话说明该状态在视觉上代表什么） */
  readonly description: string;
}

/**
 * GestureHintItem —— 相机操作手势提示条目。
 *
 * 【内容契约】覆盖 OrbitControls 的四类交互：左键旋转、右键平移、
 * 滚轮缩放、单击实体特写巡检（本项目的射线选中语义）。
 */
export interface GestureHintItem {
  /** 稳定键 */
  readonly key: string;
  /** 操作名（中文，如 '左键拖拽'） */
  readonly label: string;
  /** 该操作产生的效果（中文，如 '旋转视角'） */
  readonly effect: string;
}

/* ========================================================================== */
/* 实体巡检视图模型                                                            */
/* ========================================================================== */

/**
 * InspectMetaRow —— 探针卡片的元信息行（命名空间 / 节点 IP / 容量 等）。
 *
 * 【为何用「标签 + 值」数组而非固定字段】三类实体（pod/node/master）
 * 的可用元信息互不相同（Pod 有 namespace 与宿主 IP，Node 有机架与容量，
 * MASTER 有集群规模），统一为行数组后卡片渲染逻辑完全一致。
 */
export interface InspectMetaRow {
  /** 行标签（大写英文，终端风格，如 'NAMESPACE' / 'NODE IP'） */
  readonly label: string;
  /** 行值（可为空串，渲染层以 '—' 兜底） */
  readonly value: string;
}

/**
 * SparklineSeries —— 单条迷你波形图的渲染载荷。
 *
 * 【数值契约】values 长度 ≥ 2，每项 ∈ [0, 100]（百分比水位域）；
 * 渲染层将值域线性映射到 SVG 视口高度，并做上下留白防峰值削顶。
 */
export interface SparklineSeries {
  /** 系列名（如 'CPU' / 'MEM'） */
  readonly label: string;
  /** 序列采样值，索引 0 最旧、末项最新。@range 每项 [0, 100]，长度 ≥ 2 */
  readonly values: readonly number[];
  /** 主色（CSS 颜色字符串，决定描边与面积渐变基色） */
  readonly color: string;
  /** 末值展示文本（含单位，如 '46.0%'） */
  readonly latestText: string;
}

/**
 * EntityHistorySource —— 波形序列的数据口径（显式标注，杜绝"看似实时实则虚构"）。
 *
 * - 'direct'   → 实体自带历史（PodEntity.cpuHistory / memHistory，真实采集）
 * - 'derived'  → 由名下/全局 Pod 历史聚合派生（节点与 MASTER 无历史字段）
 */
export type EntityHistorySource = 'direct' | 'derived';

/**
 * EntityInspectView —— 实体巡检视图模型（卡片渲染的唯一输入）。
 *
 * 【核心流转】selectedEntityId + selectedEntityType + snapshotSummary
 * → deriveEntityView() 纯函数 → 本模型 → 卡片 JSX（零分支渲染）。
 */
export interface EntityInspectView {
  /** 实体 ID（healEntity / triggerQuickPrompt 的目标标识） */
  readonly entityId: string;
  /** 实体类型（决定卡片头部图标与徽标文案口径） */
  readonly entityType: SelectedEntityType;
  /** 展示名（Pod metadata.name / 节点名 / 'MASTER control plane'） */
  readonly displayName: string;
  /** 左上角空间层级面包屑（如 `'集群 / 机架 rack-0 / 槽位 slot-1'`） */
  readonly breadcrumb?: string;
  /** 状态原文（PodStatus / NodeStatus / 集群健康分档名） */
  readonly statusLabel: string;
  /** 状态语义色（驱动徽标高亮） */
  readonly statusTone: InspectTone;
  /** 元信息行（NAMESPACE / NODE IP / RACK / CAPACITY 等，按实体类型裁剪） */
  readonly metaRows: readonly InspectMetaRow[];
  /**
   * 累计重启次数。Pod 取自身 restarts；
   * 节点取名下 Pod 重启之和；MASTER 取全集群重启之和。
   */
  readonly restarts: number;
  /** CPU 波形序列（带末值与配色） */
  readonly cpuSeries: SparklineSeries;
  /** 内存波形序列（带末值与配色） */
  readonly memSeries: SparklineSeries;
  /** 波形数据口径（'direct' 真实采集 / 'derived' 聚合派生） */
  readonly historySource: EntityHistorySource;
}

/* ========================================================================== */
/* 组件 Props                                                                  */
/* ========================================================================== */

/**
 * SparklineProps —— 纯 SVG 迷你波形图 Props。
 *
 * 【绘制契约】折线以 <polyline> 描边，填充区以 <path> 闭合至底边并引用
 * <linearGradient>（上浓下透）实现面积渐变；梯度 ID 由 useId 生成，
 * 保证同页多个实例互不串色（SVG id 是文档全局命名空间）。
 */
export interface SparklineProps {
  /** 波形载荷（序列 + 配色 + 末值文本） */
  readonly series: SparklineSeries;
  /** SVG 视口宽度（用户单位，配合 preserveAspectRatio="none" 自适应拉伸） */
  readonly width?: number;
  /** SVG 视口高度（用户单位） */
  readonly height?: number;
}

/**
 * NodeInspectHUDProps —— 巡检 HUD 组件 Props。
 *
 * 【无状态设计】组件不接受任何数据 Props：选中态与快照全部经
 * useClusterStore 细粒度订阅获取（单一数据源），Props 仅为挂载位置微调预留。
 */
export interface NodeInspectHUDProps {
  /** 附加容器类名（由挂载方注入定位相关类，默认已含左上角定位） */
  readonly className?: string;
}
