/**
 * KubeVision AI — 运维中控台布局外壳组件类型契约（唯一类型源）
 *
 * 【契约】依据 AGENTS.md 第 2 条：所有组件 Props 必须严格引用 src/types/
 * 下的接口定义，禁止 any / @ts-ignore。本文件覆盖 TopBar / TerminalEcho /
 * ShellLayout 三大外壳组件及其内部子组件的全部 Props 形状。
 *
 * 【设计意图】把「视觉分级阈值、日志色调分类、移动端视图键」等
 * 跨组件共享的语义常量类型集中定义，避免各组件各自书写字面量联合导致漂移。
 */

import type { ReactNode } from 'react';

import type { ChaosScenario, NodeHealthStatus, PodStatus } from '@/types/cluster';
import type { ConnectionMode, RightPanelTab, StatusFilter } from '@/types/store';

/* ========================================================================== */
/* 健康分视觉分级                                                              */
/* ========================================================================== */

/**
 * HealthTier —— 健康分视觉三级分档（复用集群三态视觉令牌，单一色彩事实源）。
 *
 * 【阈值契约】（TopBar 环形徽标与后续 HUD 仪表共用）
 * - score ≥ 85      → 'healthy'  翠绿 emerald-400
 * - 60 ≤ score ≤ 84 → 'warning'  琥珀 amber-400
 * - score < 60      → 'critical' 警示红 rose-500 + 闪烁脉冲
 *
 * 【类型复用说明】直接等价于 cluster.ts 的 NodeHealthStatus（healthy/warning/
 * critical 三态），二者共享同一套 tailwind status 语义色令牌，
 * 故不新造重复联合类型——同一视觉分档在全项目只有一处定义。
 */
export type HealthTier = NodeHealthStatus;

/* ========================================================================== */
/* 移动端视图切换                                                              */
/* ========================================================================== */

/**
 * MobileViewKey —— 小屏（< 1024px）浮动切换栏的二选一视图键。
 *
 * 【设计意图】移动端无法同屏容纳 3D 拓扑与 Copilot 抽屉，故以底部浮动
 * 切换栏在两视图间做不透明度交叉淡入淡出（双面板常驻 DOM，仅切换可见性，
 * 避免反复卸载 R3F Canvas 造成 WebGL 上下文重建的高昂开销）。
 */
export type MobileViewKey = 'topology' | 'copilot';

/* ========================================================================== */
/* TopBar 子组件 Props                                                         */
/* ========================================================================== */

/**
 * HealthRingBadge —— 集群健康分环形进度徽标 Props。
 *
 * 【渲染契约】以 SVG 双圆环实现：底环为 slate-800 轨道，前景环按
 * strokeDashoffset = 周长 × (1 − score/100) 描边；色彩经 currentColor
 * 继承 HealthTier 对应的 Tailwind 文本色，critical 档叠加闪烁动画。
 */
export interface HealthRingBadgeProps {
  /** 集群健康分。@range [0, 100]，越界值内部 clamp */
  readonly score: number;
  /** 环形外径（px），默认 44 */
  readonly size?: number;
  /** 描边宽度（px），默认 3.5 */
  readonly strokeWidth?: number;
  /** 是否在环右侧附带分档文字标签，默认 false（TopBar 内已独立展示分数） */
  readonly showLabel?: boolean;
}

/**
 * StatusFilterPill —— Pod 状态快速过滤胶囊 Props。
 *
 * 【交互契约】点击回调 onSelect 由父层收敛为 setStatusFilter(filter)，
 * 胶囊自身无状态（受控组件），active 由父层比对当前 statusFilter 得出，
 * 保证过滤态与 Store 单向数据流严格一致。
 */
export interface StatusFilterPillProps {
  /** 本胶囊对应的过滤值（'ALL' 或某一 PodStatus） */
  readonly filter: StatusFilter;
  /** 展示文案（状态名原文，如 'CrashLoopBackOff'） */
  readonly label: string;
  /** 当前快照中命中该过滤值的 Pod 数量（实时角标） */
  readonly count: number;
  /** 是否为当前激活过滤项 */
  readonly active: boolean;
  /** 点击选择回调 */
  readonly onSelect: (filter: StatusFilter) => void;
}

/**
 * 过滤胶囊配置项：把「过滤值 + 展示文案 + 计数取数状态」打包为静态表，
 * 使 TopBar 的胶囊组渲染成为纯数据驱动（新增状态只改表不改 JSX）。
 */
export interface StatusFilterOption {
  /** 过滤值 */
  readonly filter: StatusFilter;
  /** 展示文案 */
  readonly label: string;
  /** 计数所依据的 Pod 状态；'ALL' 项为 undefined（计全量） */
  readonly status?: PodStatus;
}

/** ChaosBanner —— 混沌演练激活横幅 Props（含一键终止叉号） */
export interface ChaosBannerProps {
  /** 当前激活的混沌场景名（'NONE' 时本组件不渲染） */
  readonly scenario: ChaosScenario;
  /** 一键终止演练回调（setActiveChaos('NONE')） */
  readonly onTerminate: () => void;
}

/** QpsBoard —— 实时 QPS 吞吐数字看板 Props */
export interface QpsBoardProps {
  /** 集群入口总 QPS（来自 TelemetrySnapshot.totalQps） */
  readonly qps: number;
}

/** ModeToggle —— Demo Synthetic / Live Tunnel 双模切换拨片 Props */
export interface ModeToggleProps {
  /** 当前数据源模式 */
  readonly mode: ConnectionMode;
  /** 模式切换回调 */
  readonly onChange: (mode: ConnectionMode) => void;
  /** 禁用态（如 live 隧道握手中禁止来回切换） */
  readonly disabled?: boolean;
}

/* ========================================================================== */
/* TerminalEcho 日志色调分类                                                   */
/* ========================================================================== */

/**
 * TerminalLogTone —— 极客事件流日志的语义色调七分类。
 *
 * 【配色契约】（与深空赛博美学状态色体系对齐）
 * - err        → rose-400    错误/崩溃
 * - warn       → amber-300   告警/降级
 * - chaos      → fuchsia-400 混沌演练（刻意区别于 err 红，避免误读为真实故障）
 * - controller → cyan-300    K8s 控制器动作（主题流光色，自愈闭环的权威来源）
 * - edge       → emerald-300 端侧 WASM/WebGPU 推理（健康态绿）
 * - router     → sky-300     MCP 工具路由
 * - info       → slate-400   常规信息（默认兜底）
 */
export type TerminalLogTone =
  | 'err'
  | 'warn'
  | 'chaos'
  | 'controller'
  | 'edge'
  | 'router'
  | 'info';

/**
 * TerminalToneRule —— 「日志前缀标签 → 色调」映射规则条目。
 *
 * 【匹配契约】日志行实际形如 `HH:mm:ss [PREFIX] message`，前缀不在行首，
 * 故按 includes 匹配而非 startsWith；规则表按严重度降序排列，
 * 首个命中即返回（一行同时含 [ERR] 与 [WARN] 时判为 err）。
 */
export interface TerminalToneRule {
  /** 方括号前缀标签原文（如 '[KUBE-CONTROLLER]'） */
  readonly prefix: string;
  /** 命中后应用的色调 */
  readonly tone: TerminalLogTone;
}

/** TerminalLine —— 单行日志渲染 Props（已分类色调） */
export interface TerminalLineProps {
  /** 完整日志行原文（含 HH:mm:ss 时间戳前缀） */
  readonly line: string;
  /** 该行语义色调 */
  readonly tone: TerminalLogTone;
}

/** TerminalEcho —— 半透明可折叠极客事件流终端 Props */
export interface TerminalEchoProps {
  /** 附加容器类名（由 ShellLayout 注入定位相关类） */
  readonly className?: string;
  /** 初始是否折叠，默认 false（展开为 h-32） */
  readonly defaultCollapsed?: boolean;
}

/* ========================================================================== */
/* ShellLayout 与槽位 Props                                                    */
/* ========================================================================== */

/**
 * ShellLayout —— 运维中控台响应式全屏外壳 Props。
 *
 * 【槽位契约】viewport / drawer 均为可选 ReactNode 插槽：
 * 本轮由外壳提供占位内容，后续轮次注入真实的
 * next/dynamic 懒加载 R3F Canvas（ssr: false）与 Copilot 抽屉，
 * 外壳布局代码无需再改动（开闭原则）。
 */
export interface ShellLayoutProps {
  /** 左侧 3D 视口插槽（桌面端占 65% 宽） */
  readonly viewport?: ReactNode;
  /** 右侧 AI 抽屉插槽（桌面端占 35% 宽） */
  readonly drawer?: ReactNode;
}

/** RightDrawerSlot —— 右侧抽屉页签外壳 Props */
export interface RightDrawerSlotProps {
  /** 当前激活页签（copilot / auditor） */
  readonly activeTab: RightPanelTab;
  /** 页签切换回调 */
  readonly onTabChange: (tab: RightPanelTab) => void;
  /** 抽屉正文内容 */
  readonly children?: ReactNode;
}

/** ChaosScenarioOption —— 混沌控制台场景选项（含中文释义，答辩可解释性） */
export interface ChaosScenarioOption {
  /** 场景枚举值 */
  readonly scenario: ChaosScenario;
  /** 场景短标题 */
  readonly label: string;
  /** 故障影响面说明 */
  readonly description: string;
}

/**
 * PerfHudSample —— 性能 HUD 单次采样载荷。
 *
 * 【数据来源】前六项直读瞬态引用池 telemetryTransientRef.glStats（渲染循环写入），
 * 后三项来自响应轨 snapshotSummary 的实体计数，二者在一次采样中合并，
 * 使 HUD 同屏呈现「渲染性能 × 集群规模」的完整观测面。
 */
export interface PerfHudSample {
  readonly fps: number;
  readonly frameTimeMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly sseLatencyMs: number;
  readonly workerStatus: string;
  readonly podCount: number;
  readonly nodeCount: number;
  readonly alertCount: number;
}
