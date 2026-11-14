'use client';

/**
 * KubeVision AI — 右侧智能运维副驾驶主面板（CopilotDrawer）
 *
 * 【职责】把「对话 → Agent 推理 → RAG 溯源 → 生成式 UI 卡片 → 自愈动作」
 * 串成一条可在 3D 视口旁直接使用的运维工作流。
 *
 * 【双模态布局】顶部 Tab 在「AI SRE Copilot」与「Edge Log Auditor (WASM)」
 * 之间切换，绑定 store 的 activeRightTab。审计台通过 next/dynamic 懒加载——
 * 它含 Transformers.js 端侧推理代码（体积大、且并非每次会话都用），
 * 首屏不加载可显著减小初始包体；切换到的瞬间才拉 chunk。
 *
 * 【NDJSON 消费契约】按 AGENTS.md 第 9 条，严禁引入 @ai-sdk/react：
 * 用原生 fetch + ReadableStreamDefaultReader + TextDecoder 手动按 '\n'
 * 切分（保留跨 chunk 的半行缓冲），JSON.parse 后按 event.type 窄化。
 * 这是「自己掌握协议」而非「依赖框架封装」的选择——换来零额外依赖，
 * 以及完全可控的错误处理与取消语义。
 *
 * 【流式渲染模型】AI 消息不是一次性渲染的：reasoning 事件追加思考链、
 * text 事件累积正文、tool-start 插入骨架屏、tool-result 原地水合为卡片。
 * 全部通过 setMessages 的函数式更新按 id 精确定位目标消息后局部替换，
 * 避免整表重建导致的闪烁与滚动跳动。
 *
 * 【多模态闭环】capturedViewportDataUrl 来自 3D 画布工具条（toDataURL 截图）。
 * 发送时一并送给服务端，并**立即清空**待发预览（防止下一条消息重复携带同一张图），
 * 同时在用户气泡里保留缩略图——用户始终能看见「我当时发出去的是什么」。
 */

import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import dynamic from 'next/dynamic';
import { AnimatePresence,
  motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  FileText,
  Bot,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Cpu,
  Eraser,
  Flame,
  Info,
  Mic,
  Network,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Crosshair,
  Terminal,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
  Radar,
} from 'lucide-react';

import ActionConfirm from '@/components/ai/GenUI/ActionConfirm';
import AgentThoughtChain from '@/components/ai/GenUI/AgentThoughtChain';
import GenUISkeleton from '@/components/ai/GenUI/GenUISkeleton';
import MarkdownLite, { InlineMarkdown } from '@/components/ai/MarkdownLite';
import PodMetricsCard from '@/components/ai/GenUI/PodMetricsCard';
import RootCauseAlert from '@/components/ai/GenUI/RootCauseAlert';
import { MOTION } from '@/constants/tokens';
import { Z_CLASS } from '@/constants/zIndex';
import { handleRovingTabKeyDown } from '@/hooks/useModalSheetBehavior';
import { cn } from '@/utils/cn';
import { isImeComposing } from '@/utils/keyboardTargets';
import { useAgentTraceStore } from '@/store/useAgentTraceStore';
import AgentTracePanel from '@/components/ai/AgentTracePanel';
import { embedQueryText } from '@/utils/edgeEmbedding';
import { computeViewportPixelFeatures } from '@/utils/pixelFeatures';
import { requestViewportCapture } from '@/utils/viewportCapture';
import {
  appendReasoning,
  mergeStreamState,
  appendText,
  applyToolResult,
  createChatStreamSession,
  createNdjsonLineParser,
  createPromptQueue,
  resetRound,
  setEngine,
  upsertToolStart,
  type ChatStreamSession,
  type PromptQueue,
  type SessionEndReason,
} from '@/utils/chatStreamConsumer';
import { isChatStreamEvent } from '@/utils/chatStreamSchema';
import { validateStreamEvents } from '@/utils/chatStreamProtocol';
import { AGENT_COPY } from '@/constants/copy';
import TraceIdChip from '@/components/hud/TraceIdChip';
import { useClusterStore } from '@/store/useClusterStore';
import {
  CHAT_ERROR_COPY,
  actionConfirmPayloadSchema,
  classifyToolName,
  podMetricsCardSchema,
  rootCauseAlertSchema,
  type ChatStreamEvent,
  type ClusterContext,
  type CopilotMessage,
  type CopilotToolCard,
} from '@/types/ai';
import { useSpeechSynthesis } from '@/hooks/useSpeechSynthesis';
import { useSpeechInput } from '@/hooks/useSpeechInput';
import { useVoiceActivity } from '@/hooks/useVoiceActivity';
import type { RightPanelTab, SelectedEntityType } from '@/types/store';
import type { PodEntity, WorkerNodeEntity } from '@/types/cluster';
import { MASTER_ENTITY_ID } from '@/utils/cameraFocus';
import RagKnowledgeModal from '@/components/ai/RagKnowledgeModal';
import PostMortemModal from '@/components/ai/PostMortemModal';
import { buildPostMortemFilename, buildPostMortemMarkdown } from '@/utils/postMortemReport';
import { renderIncidentTimelineMarkdown } from '@/utils/snapshotRingBuffer';
import { getCustomRunbooks } from '@/utils/sreRagEngine';
import { buildRagSignalBreakdown, type RagSignalBreakdown } from '@/utils/ragSignals';

/* ========================================================================== */
/* 懒加载：端侧日志审计台                                                        */
/* ========================================================================== */

/**
 * LocalAuditorPanel 懒加载（优化首屏包体积）。
 *
 * 【为何 ssr:false】该面板内含 Transformers.js（WebGPU/WASM 端侧推理）、
 * Worker 通信与浏览器 API，服务端求值必然失败；且其代码体积远大于
 * Copilot 外壳，用户可能整个会话都不切过去——按需 chunk 是明确收益。
 */
const LocalAuditorPanel = dynamic(() => import('@/components/ai/LocalAuditorPanel'), {
  ssr: false,
  loading: (): ReactElement => <AuditorSkeleton />,
});

/** 审计台加载骨架（与主题一致，避免切换瞬间白屏） */
function AuditorSkeleton() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <span className="flex h-10 w-10 animate-glow-pulse items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-400/10">
        <Radar className="h-5 w-5 text-cyan-400" aria-hidden />
      </span>
      <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400/70">
        loading edge auditor
      </p>
    </div>
  );
}

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/**
 * 战术指令条目（强类型，替代早期 `icon: string` 的 Emoji 方案）。
 *
 * 【为何彻底废除 Emoji】早期用四枚彩色 Emoji（听诊器 / 爆炸 / 天平 / 地球）指代指令，
 * 在深空运维台里是**最强的"AI 模板感"信号**：Emoji 由系统字体渲染，
 * 色调、笔画、光栅化方式与周围的等宽细线图标完全不在一个视觉体系内，
 * 一眼就能看出是"随手贴上去的"。本项目其余部分（顶栏、探针卡、卡片）
 * 全部使用单色 Lucide 矢量图标，Emoji 属于异类。
 *
 * 【改用「战术编号 + 单色矢量图标」】编号（CMD-01~04）提供工业仪表式的
 * 序号感与可引用性（文档/答辩里可以直说"点 CMD-02"），图标只承担语义速读，
 * 不争抢注意力。
 */
interface TacticalCommand {
  /** 战术编号：卡片左上角的等宽徽标 */
  readonly id: string;
  /** 指令条上的短码：仅两位数，无需 `CMD-` 前缀 */
  readonly code: string;
  /** 单色矢量图标组件 */
  readonly icon: LucideIcon;
  /** 主标题（卡片） */
  readonly label: string;
  /** 技术副标题（卡片，一行） */
  readonly subtitle: string;
  /** 指令条上的极简短名 */
  readonly short: string;
  /** 真实发送给模型的完整指令（保留全部限定词） */
  readonly text: string;
}

/**
 * 战术指令表（空状态 2×2 矩阵 + 对话态指令条的数据源）。
 *
 * 【text 与展示文案分离】展示文案要短，发送给模型的指令要保留限定词，
 * 否则模型不知道该产出什么形式。两者分开后卡片清爽、指令语义完整。
 */
const QUICK_PROMPTS: readonly TacticalCommand[] = [
  {
    id: 'CMD-01',
    code: '01',
    icon: Activity,
    label: '全集群健康巡检',
    subtitle: '扫描 3 节点 24 容器水位与 QoS 裕量',
    short: '集群巡检',
    text: '全面巡检当前集群健康状态',
  },
  {
    id: 'CMD-02',
    code: '02',
    icon: Flame,
    label: 'OOM 内存溢出排障',
    subtitle: '定位 cgroup Exit 137 容器并生成自愈方案',
    short: 'OOM 排障',
    text: '诊断 OOMKilled 根因并生成自愈方案',
  },
  {
    id: 'CMD-03',
    code: '03',
    icon: Cpu,
    label: '节点算力均衡分析',
    subtitle: '评估 CFS 节流风险与跨机架负载偏斜',
    short: '负载均衡',
    text: '结合 3D 视图分析节点负载均衡度',
  },
  {
    id: 'CMD-04',
    code: '04',
    icon: Network,
    label: 'CNI 网络链路诊断',
    subtitle: '探测 VXLAN 隧道丢包与跨节点吞吐瓶颈',
    short: '网络诊断',
    text: '评估当前网络吞吐瓶颈',
  },
];

/** 3D 视口截图压缩质量（JPEG 0.8：清晰度与体积的平衡点） */
const CAPTURE_QUALITY = 0.8;

/** 消息列表自动滚动暂停阈值（向上滚动超过 120px 时暂停跟随，避免打断历史阅读） */
const STICKY_SCROLL_THRESHOLD_PX = 120;

/** 文本流 rAF 合批提交下限间隔（毫秒，60FPS 单帧上限；首帧及 >100ms 停顿除外） */
const STREAM_FRAME_COMMIT_MS = 16;

/** 流式 delta 静默刷新阈值（毫秒）：帧间隔或空闲超过 100ms 立即提交缓冲文本 */
const STREAM_GAP_FLUSH_MS = 100;

/** 触发手动窗口虚拟化的消息条数阈值（>30 条启用） */
const VIRTUALIZE_THRESHOLD = 30;

/** 虚拟列表可视窗口上下超扫（overscan）条数 */
const VIRTUAL_OVERSCAN = 5;

/** 未实测气泡的初始预估高度（像素）与列表垂直间距（对应 space-y-2.5 = 10px） */
const VIRTUAL_DEFAULT_BUBBLE_HEIGHT = 132;
const VIRTUAL_ITEM_GAP_PX = 10;

/** 50+ 条消息窗口最大挂起 DOM 气泡目标上限（防止小卡片密集堆叠超标） */
const VIRTUAL_MAX_RENDERED_TARGET = 15;

/** 流式调试性能快照（仅 dev 或 ?debug=stream 暴露） */
interface StreamPerfDebugSnapshot {
  readonly totalBubbleCommits: number;
  readonly historyBubbleCommits: number;
  readonly activeBubbleCommits: number;
  readonly userBubbleCommits: number;
  readonly drawerCommits: number;
  readonly rafFlushes: number;
  readonly virtualized: boolean;
  readonly mountedMsgDomCount: number;
  readonly perMessageCommits: Readonly<Record<string, number>>;
}

interface StreamPerfDebugApi {
  readonly reset: () => void;
  readonly getSnapshot: () => StreamPerfDebugSnapshot;
}

declare global {
  interface Window {
    __KUBEVISION_STREAM_DEBUG__?: StreamPerfDebugApi;
  }
}

/** 判断当前运行期是否启用流式性能调试钩子（仅非生产环境或显式 ?debug=stream 开启） */
function isStreamDebugEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  if (typeof window === 'undefined') return false;
  const debugFlag = new URLSearchParams(window.location.search).get('debug');
  return debugFlag === 'stream' || debugFlag === '1' || debugFlag === 'true';
}

/**
 * 骨架屏看门狗超时（毫秒）。
 *
 * 【为什么是 8 秒】服务端最慢路径是引擎 A 失败后回落引擎 B：
 * 引擎 A 可能已经跑了数秒，回落补卡再花约 1.5 秒（三卡各 450ms）。
 * 8 秒足以覆盖正常最慢链路，又不会让用户对着骨架干等太久。
 */
const SKELETON_WATCHDOG_MS = 8000;

/* ========================================================================== */
/* 工具名 → 卡片组件映射（工具名兼容两套命名）                                     */
/* ========================================================================== */

/**
 * 判断工具名是否对应某类卡片。
 *
 * 【为何做兼容匹配】服务端（引擎 B）与 LLM（引擎 A）产出的工具名可能略有差异：
 * 协议契约示例为 reportRootCause / confirmAction，而实际实现使用
 * renderRootCauseAnalysis / proposeRemediationAction。用包含式匹配
 * 同时兼容两种命名，避免任一侧改名就静默不渲染卡片。
 */
function isPodMetricsTool(name: string): boolean {
  return classifyToolName(name) === 'metrics';
}
function isRootCauseTool(name: string): boolean {
  return classifyToolName(name) === 'rootCause';
}
function isActionTool(name: string): boolean {
  return classifyToolName(name) === 'remediation';
}

/** 生成消息 id（时间戳 + 随机后缀，避免同毫秒碰撞） */
function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ========================================================================== */
/* 输入安全校验                                                                */
/* ========================================================================== */

/** 单条 prompt 最大字符数（超出会挤占上下文且可能是误粘贴） */
const MAX_PROMPT_CHARS = 4000;

/**
 * 提示注入特征词表。
 *
 * 【威胁模型】本项目的 prompt 会被拼进服务端 System Prompt 的上下文里。
 * 恶意用户可能尝试用「忽略上述指令」「你现在是…」这类经典注入话术
 * 劫持模型行为，让它绕过安全护栏输出错误的运维建议——
 * 在运维场景下，一条被劫持的"建议"可能直接导致误删资源。
 *
 * 【为何只做"提示"不做"阻断"】这些词在正常运维对话里也可能合法出现
 * （如"请忽略那条误报告警"）。因此检测到后**不阻止发送**，
 * 而是给出警告并记录，让用户知情——安全设计要避免过度阻塞正常工作流。
 * 真正的防线在服务端（System Prompt 明确限定角色与输出范围）。
 */
const PROMPT_INJECTION_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  { name: '忽略指令', pattern: /(忽略|无视|忘掉|ignore|disregard)\s*(上述|以上|之前|前面|所有|all|previous|above)\s*(指令|提示|规则|instruction|prompt|rule)/i },
  { name: '角色劫持', pattern: /(你现在是|从现在起你是|you\s+are\s+now|act\s+as)\s*(?!sre|运维)/i },
  { name: '系统提示泄露', pattern: /(system\s*prompt|系统提示词|打印.*(指令|prompt)|reveal.*(instruction|prompt))/i },
  { name: '越权指令', pattern: /(删除|drop)\s*(所有|全部|all)\s*(namespace|命名空间|pod|资源|resource)/i },
];

/**
 * validatePrompt —— 用户输入的基础安全与合法性校验。
 *
 * 【校验项】
 * 1. 空内容 / 纯空白 → 拒绝；
 * 2. 超长（> MAX_PROMPT_CHARS）→ 拒绝，提示精简；
 * 3. 控制字符（除换行/制表）过多 → 拒绝（可能是二进制/乱码粘贴）；
 * 4. 提示注入特征 → **放行但警告**（不阻断正常工作流）。
 *
 * @returns ok=true 可发送；ok=false 时 reason 为面向用户的中文原因
 */
function validatePrompt(text: string): { readonly ok: true; readonly warning?: string } | { readonly ok: false; readonly reason: string } {
  if (text.length === 0) {
    return { ok: false, reason: '请输入诊断内容' };
  }
  if (text.length > MAX_PROMPT_CHARS) {
    return { ok: false, reason: `输入过长（${text.length} 字符），请精简至 ${MAX_PROMPT_CHARS} 字符以内` };
  }
  /* 控制字符检测：允许 \n \r \t，其余 C0/C1 控制符视为异常输入 */
  // eslint-disable-next-line no-control-regex
  const controlChars = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g);
  if (controlChars !== null && controlChars.length > 3) {
    return { ok: false, reason: '输入包含异常控制字符，请重新输入' };
  }
  for (const rule of PROMPT_INJECTION_PATTERNS) {
    if (rule.pattern.test(text)) {
      return { ok: true, warning: `检测到疑似「${rule.name}」表述，已放行但请注意：Copilot 仅执行运维诊断职责` };
    }
  }
  return { ok: true };
}

/* ========================================================================== */
/* 子组件：实体上下文胶囊                                                        */
/* ========================================================================== */

/**
 * 无效实体 id 的判定正则。
 *
 * 【为何需要这层防御】选中态来自 store，而 store 既可能被持久化恢复
 * （旧版本写入的脏值），也可能收到上游传下来的占位串（'n/a' / 'unknown'）。
 * 一旦占位串进入 ContextPill，界面就会出现 «POD n/a» 这种自相矛盾的标签——
 * 既声明了一个类型，又给出一个不存在的名字。这类字样会直接摧毁
 * 运维界面的可信度，必须在渲染前拦截。
 */
const INVALID_ENTITY_ID_PATTERN = /^(n\/?a|unknown|unknown-target|undefined|null|none|-)?$/i;

/** ContextPill 解析后的展示态 */
interface ResolvedContext {
  /** 类型短标：POD / NODE / MASTER */
  readonly typeLabel: string;
  /** 真实展示名（从快照解析，绝不使用裸 ID 顶替） */
  readonly displayName: string;
  /** 类型对应的配色（语义色，用于一眼区分 Pod / 节点 / 控制平面） */
  readonly colorClass: string;
  /** 悬浮提示：给出完整 ID，便于排障时核对 */
  readonly title: string;
}

/**
 * ContextPill —— 当前绑定的 3D 实体上下文胶囊。
 *
 * 【语义】告诉用户「你现在问的问题会针对哪个实体」。选中态来自 store，
 * 与 3D 画布的高亮完全同步——这是对话与空间视图之间的上下文锚点。
 *
 * 【本轮新增的防御契约】只有在**快照中真实存在**的实体才显示为实体胶囊；
 * 其余一切情况（id 为空、为占位串、或在 pods/nodes 里查无此项）
 * 统一退化为安静的「全局集群视角」。理由是：
 * 上下文胶囊的作用是让用户确信"我知道我在问谁"，若显示的名字是假的，
 * 它就从"消除歧义"变成了"制造歧义"，比不显示更糟。
 */
function ContextPill({
  entityId,
  entityType,
}: {
  readonly entityId: string | null;
  readonly entityType: SelectedEntityType | null;
}) {
  /* ---- 快照订阅：只取查询所需字段，避免高频遥测触发重渲染 ---- */
  const pods = useClusterStore((s): readonly PodEntity[] => s.snapshotSummary.pods);
  const nodes = useClusterStore((s): readonly WorkerNodeEntity[] => s.snapshotSummary.nodes);

  /**
   * 把原始 id 解析为可信的展示态。
   *
   * 【解析优先级】
   * 1. id 无效（空 / 'n/a' / 'unknown' 等）→ null（走兜底）
   * 2. id === MASTER_ENTITY_ID → 控制平面（Master 不在 pods/nodes 列表中）
   * 3. 在 pods 中按 id 命中 → 用 pod.name
   * 4. 在 nodes 中按 id 命中 → 用 node.name
   * 5. 全部未命中 → null（走兜底，**绝不拼出 'POD n/a'**）
   *
   * 【为何以查表结果为准，而非信任 entityType】
   * entityType 与 entityId 来自两个独立字段，理论上可能不同步
   * （例如旧持久化数据里类型是 'pod' 但 id 已被删除）。
   * 以"哪个表里能查到"来判定类型，比信任可能过期的类型字段更可靠。
   */
  const resolved = useMemo((): ResolvedContext | null => {
    if (entityId === null) return null;

    const raw = entityId.trim();
    if (INVALID_ENTITY_ID_PATTERN.test(raw)) return null;

    /* ---- 2. 控制平面：Master 是单例，不在 pods/nodes 列表中 ---- */
    if (raw === MASTER_ENTITY_ID || entityType === 'master') {
      return {
        typeLabel: 'MASTER',
        displayName: '控制平面',
        colorClass: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300',
        title: raw,
      };
    }

    /* ---- 3. Pod ---- */
    const pod = pods.find((p): boolean => p.id === raw);
    if (pod !== undefined) {
      return {
        typeLabel: 'Pod',
        displayName: pod.name,
        colorClass: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
        title: `${pod.namespace} / ${pod.name}`,
      };
    }

    /* ---- 4. 节点 ---- */
    const node = nodes.find((n): boolean => n.id === raw);
    if (node !== undefined) {
      return {
        typeLabel: 'NODE',
        displayName: node.name,
        colorClass: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
        title: `rack-${node.rackIndex} / ${node.name}`,
      };
    }

    /* ---- 5. 查无此实体 → 兜底，不渲染任何伪造标签 ---- */
    return null;
  }, [entityId, entityType, pods, nodes]);

  /*
   * ---- 兜底态：全局集群视角 ----
   *
   * 【视觉刻意安静】不使用任何状态色，只有极低对比的描边与文字。
   * 因为"没有绑定具体实体"是一个**中性**事实，不是警告也不是错误；
   * 用彩色强调它反而会把用户的注意力从 3D 视图上拉走。
   */
  if (resolved === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] px-2 py-0.5 font-mono text-[10px] tracking-wide text-slate-400">
        <span className="h-1 w-1 shrink-0 rounded-full bg-slate-400" aria-hidden />
        全局集群视角
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] tracking-wider',
        resolved.colorClass,
      )}
      title={resolved.title}
    >
      <span className="shrink-0 font-bold">{resolved.typeLabel}</span>
      <span className="truncate opacity-90">{resolved.displayName}</span>
    </span>
  );
}

/* ========================================================================== */
/* 纯函数：把已渲染的 GenUI 卡片压缩成供服务端理解的历史摘要                        */
/* ========================================================================== */

/**
 * summarizeToolCardsForHistory —— 把一条 assistant 消息的卡片压缩成文本附注。
 *
 * 【解决什么问题：多轮对话丢失卡片上下文】
 * 前端把卡片作为**独立数据结构** `toolCards` 渲染，而发送给 `/api/chat` 的
 * `history` 只带 `m.text`。于是第二轮用户追问
 * 「刚刚那张卡片里的根因怎么自愈？」时，服务端与模型**从没见过那张卡片**——
 * 它的正文早就流式结束了，不在 `text` 里，也不在任何消息里。
 * 模型只能反问"您指的是哪张卡片？"，多轮记忆在这里断掉。
 *
 * 【为何不直接塞 JSON】把整个 `args` 序列化会引入两类问题：
 * 1. 载荷膨胀：`RootCauseAlertProps` 含 `evidenceChain`、`ragReferences`
 *    全量文档（每篇含完整 SOP 与根因机理），一张卡就上千 token；
 * 2. 提示词污染：大段结构化 JSON 会挤占模型的推理预算，反而降低回答质量。
 * 因此只抽取**决策相关的关键字段**（谁、多严重、引用了哪几篇手册、
 * 动作是什么、是否已执行），压成一行自然语言附注。
 *
 * 【不污染 UI】这个函数只在组装请求载荷时调用，`m.text` 与 `toolCards`
 * 两个渲染源都保持原样——用户看到的界面与摘要无关。
 *
 * @param cards 该条 assistant 消息携带的卡片列表
 * @returns 可直接拼接在正文末尾的摘要文本；无卡片时返回空串
 */
/** 格式化 Zod 校验问题为紧凑可读摘要 */
function formatSchemaIssues(issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[]): string {
  if (issues.length === 0) return '字段不符合预期契约';
  return issues
    .slice(0, 2)
    .map((issue): string => {
      const pathText = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${pathText}${issue.message}`;
    })
    .join('；');
}

function summarizeToolCardsForHistory(cards: readonly CopilotToolCard[]): string {
  if (cards.length === 0) return '';

  const lines: string[] = [];
  for (const card of cards) {
    /* 骨架/失败态没有可用载荷，只记工具名，避免编造内容 */
    if (card.state !== 'ready' || card.args === undefined) {
      lines.push(`[已生成卡片: ${card.toolName}（载荷未就绪）]`);
      continue;
    }

    if (isPodMetricsTool(card.toolName)) {
      const parsed = podMetricsCardSchema.safeParse(card.args);
      if (parsed.success) {
        const args = parsed.data;
        lines.push(
          `[已生成指标卡: Pod=${args.podName}, 命名空间=${args.namespace}, ` +
            `CPU=${args.cpuUsage}%, 内存=${args.memoryUsage}%, 重启=${args.restarts}次]`,
        );
      } else {
        lines.push(`[已生成指标卡: ${card.toolName}（载荷校验未通过）]`);
      }
    } else if (isRootCauseTool(card.toolName)) {
      const parsed = rootCauseAlertSchema.safeParse(card.args);
      if (parsed.success) {
        const args = parsed.data;
        const citationIds = args.ragReferences.map((doc): string => doc.id).join(', ');
        lines.push(
          `[已生成根因卡片: 严重度=${args.severity}, 标题=${args.title}, ` +
            `置信度=${(args.confidence * 100).toFixed(0)}%, ` +
            `引用知识库=${citationIds.length > 0 ? citationIds : '无'}]`,
        );
      } else {
        lines.push(`[已生成根因卡片: ${card.toolName}（载荷校验未通过）]`);
      }
    } else if (isActionTool(card.toolName)) {
      const parsed = actionConfirmPayloadSchema.safeParse(card.args);
      if (parsed.success) {
        const args = parsed.data;
        lines.push(
          `[已生成自愈审批卡: 动作=${args.actionType}, 目标=${args.targetName}, ` +
            `工具=${args.mcpEndpoint}, 高危=${args.isHighRisk ? '是' : '否'}]`,
        );
      } else {
        lines.push(`[已生成自愈审批卡: ${card.toolName}（载荷校验未通过）]`);
      }
    } else {
      lines.push(`[已生成卡片: ${card.toolName}]`);
    }
  }

  return `\n\n（本轮已生成的界面卡片，供你延续上下文）\n${lines.join('\n')}`;
}

/* ========================================================================== */
/* 子组件：单卡错误边界与畸形载荷降级                                            */
/* ========================================================================== */

interface CardErrorBoundaryProps {
  readonly cardLabel: string;
  readonly children: ReactNode;
}

interface CardErrorBoundaryState {
  readonly hasError: boolean;
  readonly errorMessage: string;
  readonly retryNonce: number;
}

/**
 * CardErrorBoundary —— 单张 GenUI / 思考链卡片级别的独立 ErrorBoundary（R10）。
 *
 * 【设计意图】任意单张卡片因脏数据或 SVG 几何异常抛出渲染错误时，仅在原地降级为
 * 「这张卡渲染失败，其余不受影响」+ 重试按钮，绝不拖垮整个 Copilot 面板或 3D 视口。
 */
class CardErrorBoundary extends Component<CardErrorBoundaryProps, CardErrorBoundaryState> {
  public constructor(props: CardErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: '',
      retryNonce: 0,
    };
  }

  public static getDerivedStateFromError(error: Error): Partial<CardErrorBoundaryState> {
    return {
      hasError: true,
      errorMessage: error.message.length > 0 ? error.message : '组件渲染异常',
    };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(`[CardErrorBoundary:${this.props.cardLabel}]`, error, info.componentStack);
  }

  private readonly handleRetry = (): void => {
    this.setState((prev): CardErrorBoundaryState => ({
      hasError: false,
      errorMessage: '',
      retryNonce: prev.retryNonce + 1,
    }));
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          data-card-state="error-boundary"
          className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-2"
        >
          <p className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-rose-200">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
            <span>这张卡渲染失败，其余不受影响</span>
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-rose-300/80" title={this.state.errorMessage}>
            {this.props.cardLabel} · {this.state.errorMessage}
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="mt-1.5 inline-flex items-center gap-1 rounded border border-rose-500/50 bg-rose-500/[0.15] px-2 py-0.5 font-mono text-[10px] font-bold text-rose-200 transition-colors hover:border-rose-400 hover:bg-rose-500/25"
          >
            <RotateCw className="h-2.5 w-2.5" aria-hidden />
            重试
          </button>
        </div>
      );
    }

    return <div key={this.state.retryNonce}>{this.props.children}</div>;
  }
}

/**
 * InvalidCardPayload —— Zod 校验失败时展示的「载荷不合法」降级卡（可查看与复制原始 JSON）。
 */
function InvalidCardPayload({
  card,
  issueSummary,
}: {
  readonly card: CopilotToolCard;
  readonly issueSummary: string;
}) {
  const [showRawJson, setShowRawJson] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const rawJson = useMemo((): string => {
    try {
      return JSON.stringify(card.args ?? null, null, 2);
    } catch {
      return String(card.args);
    }
  }, [card.args]);

  const handleCopyJson = useCallback((): void => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(rawJson).then(
      (): void => {
        setCopied(true);
        window.setTimeout((): void => setCopied(false), 1600);
      },
      (): void => {
        /* 剪贴板权限受限时静默降级，用户仍可展开手动选择 */
      },
    );
  }, [rawJson]);

  return (
    <div
      role="alert"
      data-card-state="invalid"
      aria-label={`${card.toolName} 载荷不合法`}
      className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2"
    >
      <p className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
        <span>载荷不合法 · {card.toolName}</span>
      </p>
      <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-amber-200/80">
        {issueSummary}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={handleCopyJson}
          className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/[0.12] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-200 transition-colors hover:border-amber-400 hover:bg-amber-500/20"
        >
          {copied ? <Check className="h-2.5 w-2.5 text-emerald-300" aria-hidden /> : <Copy className="h-2.5 w-2.5" aria-hidden />}
          {copied ? '已复制原始 JSON' : '复制原始 JSON'}
        </button>
        <button
          type="button"
          onClick={(): void => setShowRawJson((prev): boolean => !prev)}
          className="rounded border border-white/[0.08] bg-slate-900/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 transition-colors hover:border-white/20 hover:text-slate-100"
        >
          {showRawJson ? '收起原始 JSON' : '查看原始 JSON'}
        </button>
      </div>
      {showRawJson ? (
        <pre className="mt-1.5 max-h-36 overflow-auto rounded border border-white/[0.06] bg-slate-950/75 p-1.5 font-mono text-[10px] leading-relaxed text-slate-300">
          <code>{rawJson}</code>
        </pre>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* 子组件：单条工具卡片槽位                                                     */
/* ========================================================================== */

/**
 * ToolCardSlot —— 按工具调用状态与 Zod 运行时契约渲染骨架屏、真实卡片或降级卡。
 * 使用 React.memo 避免正文增量更新时重复渲染已就绪的工具卡片。
 */
const ToolCardSlot = memo(function ToolCardSlot({
  card,
  onActionExecuted,
}: {
  readonly card: CopilotToolCard;
  readonly onActionExecuted?: (targetId: string, actionType: string) => void;
}) {
  if (card.state === 'skeleton') {
    return (
      <div data-card-state="skeleton">
        <GenUISkeleton toolName={card.toolName} mcpUri={card.mcpUri} />
      </div>
    );
  }

  if (card.state === 'error' || card.args === undefined) {
    return (
      <div
        data-card-state="error"
        className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5"
      >
        <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" aria-hidden />
        <span className="font-mono text-[12px] text-amber-300">
          {card.toolName} 返回的载荷无法渲染
          {card.errorMessage !== undefined ? `（${card.errorMessage}）` : ''}
        </span>
      </div>
    );
  }

  /* ---- Zod 校验窄化载荷并挂载对应组件（零 unsafe as 断言） ---- */
  if (isPodMetricsTool(card.toolName)) {
    const parsed = podMetricsCardSchema.safeParse(card.args);
    if (!parsed.success) {
      return <InvalidCardPayload card={card} issueSummary={formatSchemaIssues(parsed.error.issues)} />;
    }
    const args = parsed.data;
    return (
      <PodMetricsCard
        podId={args.podId}
        podName={args.podName}
        namespace={args.namespace}
        cpuUsage={args.cpuUsage}
        memoryUsage={args.memoryUsage}
        restarts={args.restarts}
        cpuHistory={args.cpuHistory}
        memHistory={args.memHistory}
      />
    );
  }

  if (isRootCauseTool(card.toolName)) {
    const parsed = rootCauseAlertSchema.safeParse(card.args);
    if (!parsed.success) {
      return <InvalidCardPayload card={card} issueSummary={formatSchemaIssues(parsed.error.issues)} />;
    }
    const args = parsed.data;
    return (
      <RootCauseAlert
        severity={args.severity}
        title={args.title}
        confidence={args.confidence}
        rootCauseSummary={args.rootCauseSummary}
        evidenceChain={args.evidenceChain}
        impactScope={args.impactScope}
        ragReferences={args.ragReferences}
      />
    );
  }

  if (isActionTool(card.toolName)) {
    const parsed = actionConfirmPayloadSchema.safeParse(card.args);
    if (!parsed.success) {
      return <InvalidCardPayload card={card} issueSummary={formatSchemaIssues(parsed.error.issues)} />;
    }
    const args = parsed.data;
    return (
      <ActionConfirm
        actionType={args.actionType}
        targetId={args.targetId}
        targetName={args.targetName}
        paramDescription={args.paramDescription}
        mcpEndpoint={args.mcpEndpoint}
        isHighRisk={args.isHighRisk}
        onActionExecuted={onActionExecuted}
      />
    );
  }

  /* 未知工具：友好降级，不崩溃 */
  return (
    <div className="rounded-md border border-white/[0.07] bg-slate-800/50 px-2 py-1.5 font-mono text-[12px] text-slate-400">
      未知工具 {card.toolName}
    </div>
  );
});

/* ========================================================================== */
/* 子组件：主动异常嗅探横幅                                                     */
/* ========================================================================== */

/**
 * ProactiveAnomalyBanner —— 3D 画布异常态势 → Copilot 的主动提示横幅。
 *
 * 【触发条件】同时满足才渲染：
 * 1. 存在 OOMKilled / CrashLoopBackOff 的 Pod，或 activeChaos !== 'NONE'；
 * 2. 用户尚未手动关闭本次提示（dismissed）。
 *
 * 【视觉分级】有混沌演练在跑 → 琥珀色（amber，演练属于"已知故障注入"）；
 * 仅存在自然异常 → 红色（rose，非预期故障更需警觉）。
 * 两者都用 animate-glow-pulse 做脉动，符合"醒目但不刺眼"。
 *
 * 【为何需要 dismissed】用户可能已经看过并在处理别的告警，横幅反复出现
 * 会变成噪音。关闭后本轮会话不再提示，直到用户手动要求重新嗅探。
 */
function ProactiveAnomalyBanner({
  faultyCount,
  chaosActive,
  chaosLabel,
  isBusy,
  onDiagnose,
  onDismiss,
}: {
  readonly faultyCount: number;
  readonly chaosActive: boolean;
  readonly chaosLabel: string;
  readonly isBusy: boolean;
  readonly onDiagnose: () => void;
  readonly onDismiss: () => void;
}) {
  /* 无异常 → 不渲染（正常态不该有噪音） */
  if (faultyCount === 0 && !chaosActive) return null;

  const isChaos = chaosActive;
  const tone = isChaos
    ? {
        wrapper: 'border-amber-500/60 bg-amber-500/[0.12] shadow-glow-amber',
        icon: 'text-amber-400',
        title: 'text-amber-200',
        btn: 'border-amber-500/60 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30',
      }
    : {
        wrapper: 'border-rose-500/60 bg-rose-500/[0.12] shadow-glow-rose',
        icon: 'text-rose-400',
        title: 'text-rose-200',
        btn: 'border-rose-500/60 bg-rose-500/20 text-rose-100 hover:bg-rose-500/30',
      };

  /* 文案：有异常计数就说计数，只有混沌场景则说场景 */
  const message =
    faultyCount > 0
      ? `检测到 ${faultyCount} 个容器实例异常，是否立即启动 SRE 根因分析？`
      : `检测到混沌演练场景 ${chaosLabel} 正在运行，是否启动根因分析？`;

  return (
    <motion.div
      initial={{ opacity: 0, scaleY: 0.94, y: -4 }}
      animate={{ opacity: 1, scaleY: 1, y: 0 }}
      exit={{
        opacity: 0,
        scaleY: 0.94,
        y: -4,
        transition: { duration: MOTION.panelExitSec, ease: MOTION.easeOut },
      }}
      transition={{ type: 'spring', ...MOTION.spring }}
      style={{ transformOrigin: 'top center' }}
      className="shrink-0 overflow-hidden"
      role="status"
      aria-live="polite"
      aria-label="主动异常嗅探提示"
    >
      <div className={cn('m-1.5 flex items-start gap-1.5 rounded-md border p-1.5 shadow-glow-amber', tone.wrapper)}>
        <AlertTriangle className={cn('mt-[1px] h-3.5 w-3.5 shrink-0 animate-glow-pulse', tone.icon)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn('text-[10px] font-bold leading-snug', tone.title)}>{message}</p>
          <div className="mt-1 flex items-center gap-1">
            <button
              type="button"
              onClick={onDiagnose}
              disabled={isBusy}
              className={cn(
                'rounded border px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider transition-colors',
                isBusy
                  ? 'cursor-not-allowed border-white/[0.07] bg-slate-800/60 text-slate-500'
                  : tone.btn,
              )}
            >
              {isBusy ? '诊断中…' : '一键启动诊断'}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="关闭异常提示"
              className="kv-touch-target ml-auto rounded px-1.5 py-1 text-slate-400 transition-colors hover:text-slate-200"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/* ========================================================================== */
/* 子组件：消息气泡                                                             */
/* ========================================================================== */

/**
 * MessageBubble —— 单条消息渲染（用户气泡 / AI 复合卡片）。
 * 使用 React.memo 隔离流式追加时的历史消息重渲染（确保 historyBubbleCommits === 0）。
 *
 * 【AI 消息结构】轮换复位提示（可选）→ 思考链（可折叠 + 独立错误边界）→ 正文 Markdown → 工具卡片列表（独立错误边界）。
 */
const MessageBubble = memo(function MessageBubble({
  message,
  onRetry,
  onActionExecuted,
  isSpeaking,
  onToggleSpeak,
  onCommitted,
}: {
  readonly message: CopilotMessage;
  readonly onRetry?: (messageId: string, prompt: string) => void;
  readonly onActionExecuted?: (targetId: string, actionType: string) => void;
  /** 本消息是否正在被朗读（驱动声波条动画与按钮文案） */
  readonly isSpeaking?: boolean;
  /** 切换本消息的朗读/停止 */
  readonly onToggleSpeak?: (message: CopilotMessage) => void;
  /** dev/debug 性能观测：每次 React 提交该气泡后记录 */
  readonly onCommitted?: (messageId: string, isStreamingMsg: boolean) => void;
}) {
  useLayoutEffect((): void => {
    onCommitted?.(message.id, message.isStreaming);
  });

  /**
   * 从本消息的根因卡推导 RAG 信号拆解，供思考链的检索步骤内联展示。
   * 使用 rootCauseAlertSchema.safeParse 取代危险的 as 断言。
   */
  const reasoningRagBreakdown = useMemo((): RagSignalBreakdown | null => {
    const rootCard = message.toolCards.find(
      (card): boolean =>
        card.state === 'ready' &&
        isRootCauseTool(card.toolName) &&
        card.args !== undefined,
    );
    if (rootCard?.args === undefined) return null;
    const parsed = rootCauseAlertSchema.safeParse(rootCard.args);
    if (!parsed.success) return null;
    const breakdown = buildRagSignalBreakdown(parsed.data.ragReferences);
    return breakdown.available ? breakdown : null;
  }, [message.toolCards]);

  /* ---- 用户消息：右侧对齐气泡 + 已发送的视口缩略图 ---- */
  if (message.role === 'user') {
    return (
      <div className="flex min-w-0 max-w-full flex-col items-end gap-1">
        {message.viewportSnapshot !== undefined ? (
          <div className="overflow-hidden rounded-md border border-cyan-500/40 bg-slate-900/60">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={message.viewportSnapshot}
              alt="已发送的 3D 视口快照"
              className="h-16 w-28 object-cover"
            />
            <p className="px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-cyan-400/80">
              已附带 3D 视口快照
            </p>
          </div>
        ) : null}
        <div
          data-copilot-msg="user"
          className="min-w-0 max-w-[85%] overflow-x-hidden rounded-lg rounded-br-sm border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1.5"
        >
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[11px] leading-relaxed text-cyan-50">
            {message.text}
          </p>
        </div>
      </div>
    );
  }

  /* ---- 自愈验证摘要：绿色系统级回执，与 AI 回答明确区分 ---- */
  if (message.isVerification === true) {
    return (
      <div
        data-copilot-msg="verification"
        className="flex min-w-0 max-w-full items-start gap-1.5 overflow-x-hidden rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-2 shadow-glow-emerald"
      >
        <CheckCircle2 className="mt-[1px] h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-caption leading-relaxed text-emerald-100">
          {/* 行内富文本：回执里的目标名与 MCP 端点用反引号包裹，渲染为代码胶囊 */}
          <InlineMarkdown text={message.text} />
        </p>
      </div>
    );
  }

  /* ---- AI 消息：复位提示 + 思考链 + 正文 + 卡片 ---- */
  return (
    <div data-copilot-msg="assistant" className="flex min-w-0 max-w-full flex-col gap-1.5">
      {/* R10-B：引擎中断/校验降级轮换横幅（独立于回答正文，不污染 Markdown） */}
      {message.resetNotice !== undefined && message.resetNotice.length > 0 ? (
        <div
          role="status"
          data-reset-notice="true"
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[10px] leading-snug text-amber-200"
        >
          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-300" aria-hidden />
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
            {message.resetNotice}
          </span>
        </div>
      ) : null}

      {/* 思考链（流式过程中实时追加，默认折叠；包裹独立错误边界） */}
      {message.reasoningSteps.length > 0 ? (
        <CardErrorBoundary cardLabel="AI 思考与规划过程">
          <AgentThoughtChain
            steps={message.reasoningSteps}
            isStreaming={message.isStreaming && message.text.length === 0}
            ragBreakdown={reasoningRagBreakdown}
          />
        </CardErrorBoundary>
      ) : null}

      {/* 正文：经 MarkdownLite 渲染 */}
      {message.text.length > 0 ? (
        <div className="min-w-0 max-w-full overflow-x-hidden break-words [overflow-wrap:anywhere] rounded-lg rounded-bl-sm border border-white/[0.07] bg-slate-900/60 px-2.5 py-2">
          <MarkdownLite markdown={message.text} isStreaming={message.isStreaming} />
        </div>
      ) : null}

      {/* 工具卡片列表（每张卡独立 ErrorBoundary 隔离） */}
      {message.toolCards.length > 0 ? (
        <div className="flex min-w-0 max-w-full flex-col gap-1.5">
          {message.toolCards.map((card, cardIndex) => (
            <div key={card.toolCallId} className="relative flex min-w-0 max-w-full gap-2">
              {/* ---- 左侧导轨：序号徽标 + 连接线 ---- */}
              <div className="flex shrink-0 flex-col items-center">
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cyan-500/50 bg-cyan-500/[0.15] font-mono text-[10px] font-bold text-cyan-300"
                  aria-hidden
                >
                  {cardIndex + 1}
                </span>
                {cardIndex < message.toolCards.length - 1 ? (
                  <span className="mt-0.5 w-px flex-1 bg-gradient-to-b from-cyan-500/40 to-cyan-500/10" aria-hidden />
                ) : null}
              </div>
              {/* ---- 右侧：卡片本体 + 补全角标 + 独立错误边界 ---- */}
              <div className="min-w-0 flex-1">
                {card.synthesized === true ? (
                  <span
                    className="mb-1 inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-amber-300/90"
                    title="模型本次未调用该工具，此卡片由服务端依据真实集群数据补全"
                  >
                    <Info className="h-2.5 w-2.5 shrink-0" aria-hidden />
                    服务端补全 · 真实数据
                  </span>
                ) : null}
                <CardErrorBoundary cardLabel={card.toolName}>
                  <ToolCardSlot card={card} onActionExecuted={onActionExecuted} />
                </CardErrorBoundary>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* ---- 单条消息朗读按钮 ---- */}
      {!message.isStreaming && message.text.trim().length > 0 && onToggleSpeak !== undefined ? (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(): void => onToggleSpeak(message)}
            aria-label={isSpeaking === true ? '停止朗读本条诊断' : '朗读本条诊断'}
            aria-pressed={isSpeaking === true}
            title={isSpeaking === true ? '停止朗读' : '朗读诊断'}
            className={cn(
              'flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wide transition-colors',
              isSpeaking === true
                ? 'border-cyan-400/50 bg-cyan-400/[0.15] text-cyan-200'
                : 'border-white/[0.04] bg-slate-800/40 text-slate-400 hover:border-cyan-400/40 hover:text-cyan-300',
            )}
          >
            {isSpeaking === true ? (
              <>
                <span className="flex h-2.5 items-end gap-[1.5px]" aria-hidden>
                  {[0, 1, 2, 3].map((bar): React.ReactElement => (
                    <span
                      key={`wave-${bar}`}
                      className="w-[2px] animate-pulse rounded-sm bg-cyan-300"
                      style={{
                        height: `${4 + (bar % 2 === 0 ? 6 : 3)}px`,
                        animationDelay: `${bar * 120}ms`,
                      }}
                    />
                  ))}
                </span>
                停止朗读
              </>
            ) : (
              <>
                <Volume2 className="h-2.5 w-2.5" aria-hidden />
                朗读诊断
              </>
            )}
          </button>
        </div>
      ) : null}

      {/* 引擎来源标注（诚实标注，仅在流结束后显示） */}
      {!message.isStreaming && message.engine !== undefined ? (
        <p className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
          推理引擎 · {message.engine === 'llm' ? '云端大模型' : '本地确定性容灾引擎'}
        </p>
      ) : null}

      {/* ---- 失败降级提示框（带一键重试） ---- */}
      {message.failed === true && !message.isStreaming ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.08] p-2">
          <p className="flex items-start gap-1 text-[10px] leading-relaxed text-amber-200">
            <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" aria-hidden />
            <span>
              {(() => {
                const copy = message.errorCategory !== undefined ? CHAT_ERROR_COPY[message.errorCategory] : null;
                if (copy !== null) return `${copy.title}：${copy.hint}`;
                return '诊断流意外中断，可能是网络波动或服务端繁忙。你可以直接重试，已输入的上下文会保留。';
              })()}
              {message.requestId !== undefined ? `（请求 id：${message.requestId}）` : ''}
            </span>
          </p>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-amber-300/70">链路</span>
            <TraceIdChip />
          </div>
          <button
            type="button"
            onClick={(): void => {
              if (onRetry !== undefined && message.failedPrompt !== undefined) {
                const resumable = message.errorCategory === 'network' || message.errorCategory === 'server';
                onRetry(
                  message.id,
                  resumable
                    ? `${message.failedPrompt}\n\n（上一轮回答因网络/服务端中断，请基于已给出的内容继续完成，不要重复已输出部分）`
                    : message.failedPrompt,
                );
              }
            }}
            className="mt-1.5 flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/[0.15] px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-amber-200 transition-colors hover:border-amber-400/70 hover:bg-amber-500/25"
          >
            <RotateCw className="h-2.5 w-2.5" aria-hidden />
            {message.errorCategory === 'network' || message.errorCategory === 'server'
              ? '继续生成'
              : '一键重试'}
          </button>
        </div>
      ) : null}

      {/* ---- R2 · 收尾不完整提示（未收到 done）：气泡底部「回答可能不完整」+ 重新生成 ---- */}
      {message.incomplete === true && !message.isStreaming ? (
        <div className="rounded-md border border-slate-500/40 bg-slate-500/[0.08] p-2">
          <p className="flex items-start gap-1 text-[10px] leading-relaxed text-slate-300">
            <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" aria-hidden />
            <span>回答可能不完整：连接在收到完成标记前结束，已生成内容保留，可重新生成。</span>
          </p>
          <button
            type="button"
            onClick={(): void => {
              if (onRetry !== undefined && message.failedPrompt !== undefined) {
                onRetry(message.id, message.failedPrompt);
              }
            }}
            className="mt-1.5 flex items-center gap-1 rounded border border-slate-500/50 bg-slate-500/[0.15] px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-slate-200 transition-colors hover:border-slate-400/70 hover:bg-slate-500/25"
          >
            <RotateCw className="h-2.5 w-2.5" aria-hidden />
            重新生成
          </button>
        </div>
      ) : null}
    </div>
  );
});

/* ========================================================================== */
/* 手动窗口虚拟化布局引擎（R9-D：>30 条历史消息仅挂在视口 ±5 条，流式尾部常驻） */
/* ========================================================================== */

interface VirtualItemPosition {
  readonly top: number;
  readonly height: number;
}

interface VirtualLayout {
  readonly items: readonly VirtualItemPosition[];
  readonly totalHeight: number;
}

interface VirtualRange {
  readonly start: number;
  readonly end: number;
}

/**
 * computeVirtualLayout —— 计算虚拟列表每条历史消息的累计纵向偏移与总高度。
 *
 * 【输入输出】接收待虚拟化消息切片、实测高度 Map 与是否存在常驻流式尾气泡，
 * 返回每个索引对应的 `{ top, height }` 前缀数组及总高度，供二分视口切片使用。
 */
function computeVirtualLayout(
  items: readonly CopilotMessage[],
  measuredHeights: ReadonlyMap<string, number>,
  hasPinnedTail: boolean,
): VirtualLayout {
  const positions: VirtualItemPosition[] = [];
  let top = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) continue;
    const measured = measuredHeights.get(item.id);
    const height = measured !== undefined && measured > 0 ? measured : VIRTUAL_DEFAULT_BUBBLE_HEIGHT;
    positions.push({ top, height });
    const hasGapAfter = i < items.length - 1 || hasPinnedTail;
    top += height + (hasGapAfter ? VIRTUAL_ITEM_GAP_PX : 0);
  }
  return { items: positions, totalHeight: top };
}

/**
 * computeVirtualRange —— 根据当前 scrollTop 与视口高度计算可见区间 ±5 超扫窗口。
 *
 * 【核心逻辑】先通过二分查找定位首个下边缘进入视口的气泡，再向后推进至可视底部，
 * 上下各扩展 VIRTUAL_OVERSCAN（5 条），并在超密集短卡场景下收敛外层超扫以满足
 * mountedMsgDomCount <= 15 的内存与节点上限。
 */
function computeVirtualRange(
  layout: VirtualLayout,
  scrollTop: number,
  viewportHeight: number,
  maxRenderedTarget: number,
): VirtualRange {
  const len = layout.items.length;
  if (len === 0) return { start: 0, end: 0 };

  const safeScrollTop = Math.max(0, scrollTop);
  const safeViewport = Math.max(viewportHeight, VIRTUAL_DEFAULT_BUBBLE_HEIGHT);
  const viewBottom = safeScrollTop + safeViewport;

  let low = 0;
  let high = len - 1;
  let firstVisible = len - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const entry = layout.items[mid];
    if (entry !== undefined && entry.top + entry.height > safeScrollTop) {
      firstVisible = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  let lastVisible = firstVisible;
  while (lastVisible < len - 1) {
    const nextEntry = layout.items[lastVisible + 1];
    if (nextEntry === undefined || nextEntry.top >= viewBottom) break;
    lastVisible += 1;
  }

  let start = Math.max(0, firstVisible - VIRTUAL_OVERSCAN);
  let end = Math.min(len, lastVisible + 1 + VIRTUAL_OVERSCAN);

  if (end - start > maxRenderedTarget) {
    let excess = end - start - maxRenderedTarget;
    const trimBelow = Math.min(excess, Math.max(0, end - (lastVisible + 1)));
    end -= trimBelow;
    excess -= trimBelow;
    if (excess > 0) {
      const trimAbove = Math.min(excess, Math.max(0, firstVisible - start));
      start += trimAbove;
    }
  }

  return { start, end };
}

/**
 * stabilizeBottomStickyRange —— 在贴底自动跟随状态下保持虚拟切片上界单调，防止尾气泡高度变化或收尾交接引发旧气泡回弹重挂。
 *
 * 【设计意图】当活跃流式尾气泡持续增高使滚动位置下移、或流结束（`done`）从 `pinnedTailMessage` 并入 `virtualPool` 时，
 * 若朴素 `computeVirtualRange` 在高度微调后把 `start` 向回拉退，会导致已离开渲染窗的历史气泡重新挂载提交。
 * 只要仍处于贴底模式（`stickToBottom === true`），在 `maxRendered` 节点预算范围内单调钳制 `start >= prevRange.start`。
 *
 * @param prevRange 上一帧虚拟切片区间
 * @param nextRange 当前位置计算出的目标切片区间
 * @param stickToBottom 当前是否处于自动贴底跟随状态
 * @param maxRendered 虚拟池允许挂载的最大节点数
 * @returns 经过上界单调稳定后的虚拟区间
 */
function stabilizeBottomStickyRange(
  prevRange: VirtualRange,
  nextRange: VirtualRange,
  stickToBottom: boolean,
  maxRendered: number,
): VirtualRange {
  if (!stickToBottom) return nextRange;
  if (prevRange.end <= prevRange.start) return nextRange;
  const minAllowedStart = Math.max(
    nextRange.start,
    prevRange.start,
    nextRange.end - maxRendered,
  );
  return {
    start: Math.min(minAllowedStart, nextRange.end),
    end: nextRange.end,
  };
}

/**
 * VirtualMessageItem —— 虚拟列表单条历史消息定位包装器。
 * 使用 translate3d 偏移定位，避免修改 top 触发重排，并通过 memo 隔离非变动历史条目的重渲染。
 */
const VirtualMessageItem = memo(function VirtualMessageItem({
  message,
  top,
  isSpeaking,
  onRetry,
  onActionExecuted,
  onToggleSpeak,
  onCommitted,
  onMeasureNode,
}: {
  readonly message: CopilotMessage;
  readonly top: number;
  readonly isSpeaking: boolean;
  readonly onRetry?: (messageId: string, prompt: string) => void;
  readonly onActionExecuted?: (targetId: string, actionType: string) => void;
  readonly onToggleSpeak?: (message: CopilotMessage) => void;
  readonly onCommitted?: (messageId: string, isStreamingMsg: boolean) => void;
  readonly onMeasureNode: (messageId: string, node: HTMLDivElement | null) => void;
}) {
  const setContainerRef = useCallback(
    (node: HTMLDivElement | null): void => {
      onMeasureNode(message.id, node);
    },
    [message.id, onMeasureNode],
  );
  const itemStyle = useMemo(
    (): {
      readonly position: 'absolute';
      readonly top: 0;
      readonly left: 0;
      readonly width: '100%';
      readonly maxWidth: '100%';
      readonly transform: string;
    } => ({
      position: 'absolute' as const,
      top: 0,
      left: 0,
      width: '100%',
      maxWidth: '100%',
      transform: `translate3d(0, ${top}px, 0)`,
    }),
    [top],
  );

  return (
    <div
      ref={setContainerRef}
      style={itemStyle}
      className="min-w-0 max-w-full overflow-x-hidden"
      data-virtual-msg-id={message.id}
    >
      <MessageBubble
        message={message}
        onRetry={onRetry}
        onActionExecuted={onActionExecuted}
        isSpeaking={isSpeaking}
        onToggleSpeak={onToggleSpeak}
        onCommitted={onCommitted}
      />
    </div>
  );
});

/**
 * PinnedTailItem —— 活跃流式尾气泡测量包装器。
 *
 * 【设计意图】正在流式输出的最后一条消息常驻在虚拟池末尾之外（免受窗口截断），但流结束（`done`）时
 * 它会并入 `virtualPool`。若未预先记录其真实高度，进入 `virtualPool` 的首帧将按 132px 默认值占位，
 * 导致 `totalHeight` 与 `scrollTop` 瞬间大幅回落并牵动虚拟窗口重新挂载历史气泡。
 * 本组件通过 `useLayoutEffect` 与局部 `ResizeObserver` 仅更新 `measuredHeightsRef` 缓存而不触发 React 重渲染。
 */
const PinnedTailItem = memo(function PinnedTailItem({
  message,
  isSpeaking,
  onRetry,
  onActionExecuted,
  onToggleSpeak,
  onCommitted,
  onRecordTailHeight,
}: {
  readonly message: CopilotMessage;
  readonly isSpeaking: boolean;
  readonly onRetry?: (messageId: string, prompt: string) => void;
  readonly onActionExecuted?: (targetId: string, actionType: string) => void;
  readonly onToggleSpeak?: (message: CopilotMessage) => void;
  readonly onCommitted?: (messageId: string, isStreamingMsg: boolean) => void;
  readonly onRecordTailHeight: (messageId: string, height: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect((): void => {
    const node = containerRef.current;
    if (node === null) return;
    const height = node.getBoundingClientRect().height;
    if (Number.isFinite(height) && height > 0) {
      onRecordTailHeight(message.id, height);
    }
  }, [message, onRecordTailHeight]);

  useEffect((): (() => void) | void => {
    const node = containerRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries): void => {
      for (const entry of entries) {
        const nextHeight = entry.contentRect.height;
        if (Number.isFinite(nextHeight) && nextHeight > 0) {
          onRecordTailHeight(message.id, nextHeight);
        }
      }
    });
    observer.observe(node);
    return (): void => {
      observer.disconnect();
    };
  }, [message.id, onRecordTailHeight]);

  return (
    <div
      ref={containerRef}
      className="min-w-0 max-w-full overflow-x-hidden"
      data-pinned-tail-id={message.id}
    >
      <MessageBubble
        message={message}
        onRetry={onRetry}
        onActionExecuted={onActionExecuted}
        isSpeaking={isSpeaking}
        onToggleSpeak={onToggleSpeak}
        onCommitted={onCommitted}
      />
    </div>
  );
});

/* ========================================================================== */
/* 主组件                                                                      */
/* ========================================================================== */

/**
 * CopilotDrawer —— 右侧 AI 副驾驶主面板。
 */
export default function CopilotDrawer() {
  /* ---- Store 订阅（全部细粒度选择，避免无关字段变更引发重渲染） ---- */
  const activeRightTab = useClusterStore((s): RightPanelTab => s.activeRightTab);
  const setActiveRightTab = useClusterStore((s): ((tab: RightPanelTab) => void) => s.setActiveRightTab);
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectedEntityType = useClusterStore((s): SelectedEntityType | null => s.selectedEntityType);
  const capturedViewportDataUrl = useClusterStore((s): string | null => s.capturedViewportDataUrl);
  const setCapturedViewport = useClusterStore((s): ((dataUrl: string | null) => void) => s.setCapturedViewport);

  /**
   * selectedContextLabel —— 当前选中实体的可读上下文标签。
   *
   * 【为何用 getState() 而非再订阅 nodes/pods】
   * 这两个数组是大对象，订阅它们会让抽屉在每次 1Hz 快照时重渲染。
   * 这里只在**选中态变化**时读一次最新快照，成本一次性且极低。
   */
  const selectedContextLabel = useMemo((): string | null => {
    if (selectedEntityId === null || selectedEntityType === null) return null;
    const snapshot = useClusterStore.getState().snapshotSummary;
    if (selectedEntityType === 'pod') {
      const pod = snapshot.pods.find((p): boolean => p.id === selectedEntityId);
      return pod !== undefined ? `${pod.name} · ${pod.namespace}` : selectedEntityId;
    }
    if (selectedEntityType === 'node') {
      const node = snapshot.nodes.find((n): boolean => n.id === selectedEntityId);
      return node !== undefined ? `${node.name} · rack-${node.rackIndex}` : selectedEntityId;
    }
    return '控制平面 · API Server';
  }, [selectedEntityId, selectedEntityType]);
  const quickPromptQueue = useClusterStore((s): readonly string[] => s.quickPromptQueue);
  const shiftQuickPrompt = useClusterStore((s): (() => void) => s.shiftQuickPrompt);
  /* 主动嗅探数据源：异常 Pod 列表 + 混沌场景（细粒度订阅，仅这两项变化时重渲染） */
  const faultyPodCount = useClusterStore(
    (s): number =>
      s.snapshotSummary.pods.filter(
        (p): boolean => p.status === 'OOMKilled' || p.status === 'CrashLoopBackOff',
      ).length,
  );
  const activeChaos = useClusterStore((s): string => s.activeChaos);

  /* ---- 本地 UI 状态 ---- */
  const [messages, setMessages] = useState<readonly CopilotMessage[]>([]);
  const [inputValue, setInputValue] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  /** 浏览器是否支持语音识别 */
  const [speechAsrSupported, setSpeechAsrSupported] = useState<boolean>(true);
  /** 底部语音说明默认收起为 1 行，点击详情按钮可展开完整提示 */
  const [speechHintExpanded, setSpeechHintExpanded] = useState<boolean>(false);
  /** 全局互斥模态框槽位 */
  const activeModal = useClusterStore((s) => s.activeModal);
  const openModal = useClusterStore((s) => s.openModal);
  const closeModal = useClusterStore((s) => s.closeModal);
  const ragModalOpen = activeModal === 'rag';
  const [snapshotPreviewOpen, setSnapshotPreviewOpen] = useState<boolean>(false);
  const postMortemOpen = activeModal === 'postMortem';

  /* ---- 复盘报告：已生成的 Markdown 与文件名 ---- */
  const [postMortemMarkdown, setPostMortemMarkdown] = useState<string>('');
  const [postMortemFilename, setPostMortemFilename] = useState<string>('');

  const sessionStartedAtRef = useRef<number>(Date.now());

  const hasReplayableContent = useMemo(
    (): boolean =>
      messages.some((message): boolean =>
        message.toolCards.some((card): boolean => card.state === 'ready'),
      ),
    [messages],
  );

  const [ttsEnabled, setTtsEnabled] = useState<boolean>(false);
  /** 用户是否已关闭主动异常横幅 */
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(false);
  /** 输入安全校验的即时错误提示 */
  const [inputGuardError, setInputGuardError] = useState<string | null>(null);
  /** 提示注入等"放行但警告"的提示 */
  const [guardWarning, setGuardWarning] = useState<string | null>(null);
  /** 用户是否已向上滚离底部（驱动「回到最新诊断」胶囊显隐） */
  const [isAwayFromBottom, setIsAwayFromBottom] = useState<boolean>(false);
  /** 底部「快捷指令」折叠入口的展开状态 */
  const [isQuickPromptsOpen, setQuickPromptsOpen] = useState<boolean>(false);

  /* ---- Refs ---- */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTopRef = useRef<number>(0);
  const programmaticJumpUntilRef = useRef<number>(0);
  const programmaticJumpTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const skeletonWatchdogRef = useRef<Map<string, number>>(new Map());
  const promptQueueRef = useRef<PromptQueue>(createPromptQueue());
  const activeSessionRef = useRef<ChatStreamSession | null>(null);
  const sendMessageRef = useRef<((prompt: string) => void) | null>(null);
  const [queuedPromptNotice, setQueuedPromptNotice] = useState<string | null>(null);
  const [speechRequest, setSpeechRequest] = useState<{ readonly messageId: string; readonly nonce: number } | null>(null);

  /* ---- 性能调试指标与回调稳定化引用（R9-A / R9-B） ---- */
  const activeAssistantIdRef = useRef<string | null>(null);
  const turnUserMessageIdsRef = useRef<Set<string>>(new Set());
  const turnAssistantMessageIdsRef = useRef<Set<string>>(new Set());
  const streamPerfStatsRef = useRef<{
    totalBubbleCommits: number;
    historyBubbleCommits: number;
    activeBubbleCommits: number;
    userBubbleCommits: number;
    drawerCommits: number;
    rafFlushes: number;
    perMessageCommits: Record<string, number>;
  }>({
    totalBubbleCommits: 0,
    historyBubbleCommits: 0,
    activeBubbleCommits: 0,
    userBubbleCommits: 0,
    drawerCommits: 0,
    rafFlushes: 0,
    perMessageCommits: {},
  });

  const messagesRef = useRef<readonly CopilotMessage[]>(messages);
  const isStreamingRef = useRef<boolean>(isStreaming);
  const ttsEnabledRef = useRef<boolean>(ttsEnabled);
  const capturedViewportRef = useRef<string | null>(capturedViewportDataUrl);

  /* ---- 文本流 rAF 合批缓冲 refs（R9-A） ---- */
  const textBufRef = useRef<Map<string, string>>(new Map());
  const rafIdRef = useRef<number | null>(null);
  const gapTimerRef = useRef<number | null>(null);
  const lastDeltaAtRef = useRef<Map<string, number>>(new Map());
  const lastCommitAtRef = useRef<number>(0);

  /* ---- 虚拟化窗口状态与布局测量 refs（R9-D） ---- */
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const itemResizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedElementToIdRef = useRef<WeakMap<Element, string>>(new WeakMap());
  const idToObservedElementRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [measureVersion, setMeasureVersion] = useState<number>(0);
  const [virtualRange, setVirtualRange] = useState<VirtualRange>({ start: 0, end: 0 });
  const virtualRangeRef = useRef<VirtualRange>({ start: 0, end: 0 });
  const virtualizedRef = useRef<boolean>(false);
  const hasPinnedTailRef = useRef<boolean>(false);
  const virtualLayoutRef = useRef<VirtualLayout>({ items: [], totalHeight: 0 });
  const prevVirtualPoolRef = useRef<readonly CopilotMessage[]>([]);

  const virtualized = messages.length > VIRTUALIZE_THRESHOLD;
  const hasPinnedTail =
    virtualized &&
    messages.length > 0 &&
    messages[messages.length - 1]?.isStreaming === true;
  const virtualPool = useMemo((): readonly CopilotMessage[] => {
    if (!virtualized) {
      if (prevVirtualPoolRef.current.length === 0) return prevVirtualPoolRef.current;
      prevVirtualPoolRef.current = [];
      return prevVirtualPoolRef.current;
    }
    const targetLen = hasPinnedTail ? messages.length - 1 : messages.length;
    const prev = prevVirtualPoolRef.current;
    if (prev.length === targetLen) {
      let unchanged = true;
      for (let i = 0; i < targetLen; i += 1) {
        if (prev[i] !== messages[i]) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return prev;
    }
    const next = hasPinnedTail ? messages.slice(0, -1) : messages;
    prevVirtualPoolRef.current = next;
    return next;
  }, [hasPinnedTail, messages, virtualized]);
  const pinnedTailMessage =
    virtualized && hasPinnedTail ? (messages[messages.length - 1] ?? null) : null;
  const virtualLayout = useMemo((): VirtualLayout => {
    if (measureVersion < 0) return { items: [], totalHeight: 0 };
    return virtualized
      ? computeVirtualLayout(virtualPool, measuredHeightsRef.current, hasPinnedTail)
      : { items: [], totalHeight: 0 };
  }, [hasPinnedTail, measureVersion, virtualPool, virtualized]);
  // 始终为虚拟池预留 1 个尾气泡槽位（流式固定尾与并入虚拟池阶段保持上限恒定，避免 done 时刻 14→15 放大引发旧气泡回挂）
  const maxVirtualRendered = VIRTUAL_MAX_RENDERED_TARGET - 1;
  const effectiveVirtualRange =
    virtualRange.end > virtualRange.start && virtualRange.end <= virtualPool.length
      ? virtualRange
      : computeVirtualRange(
          virtualLayout,
          Number.MAX_SAFE_INTEGER,
          VIRTUAL_DEFAULT_BUBBLE_HEIGHT * 4,
          maxVirtualRendered,
        );

  useLayoutEffect((): void => {
    virtualizedRef.current = virtualized;
    hasPinnedTailRef.current = hasPinnedTail;
    virtualLayoutRef.current = virtualLayout;
    messagesRef.current = messages;
    isStreamingRef.current = isStreaming;
    ttsEnabledRef.current = ttsEnabled;
    capturedViewportRef.current = capturedViewportDataUrl;
  });

  /**
   * cancelStreamTimers —— 取消尚未触发的 rAF 帧回调与 100ms 停顿刷新定时器。
   */
  const cancelStreamTimers = useCallback((): void => {
    if (rafIdRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (gapTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(gapTimerRef.current);
      gapTimerRef.current = null;
    }
  }, []);

  /**
   * flushBufferedText —— 将 textBufRef 中累加的高频 text delta 一次性合批写入 messages。
   *
   * 【设计意图】通过单次 setMessages updater 合并整帧或多消息待提交正文，
   * 将高频 SSE 分片下的 React 提交次数收敛至 60FPS 上限，并保障历史气泡零重渲染。
   */
  const flushBufferedText = useCallback(
    (targetMessageId?: string, commitTimestamp?: number): void => {
      if (!isMountedRef.current) {
        textBufRef.current.clear();
        lastDeltaAtRef.current.clear();
        cancelStreamTimers();
        return;
      }
      const pending: Array<readonly [string, string]> = [];
      if (targetMessageId !== undefined) {
        const chunk = textBufRef.current.get(targetMessageId);
        if (chunk !== undefined && chunk.length > 0) {
          pending.push([targetMessageId, chunk]);
        }
        textBufRef.current.delete(targetMessageId);
        lastDeltaAtRef.current.delete(targetMessageId);
      } else {
        for (const [msgId, chunk] of textBufRef.current.entries()) {
          if (chunk.length > 0) pending.push([msgId, chunk]);
        }
        textBufRef.current.clear();
        lastDeltaAtRef.current.clear();
      }

      if (textBufRef.current.size === 0) {
        cancelStreamTimers();
      }
      if (pending.length === 0) return;

      lastCommitAtRef.current =
        commitTimestamp ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
      streamPerfStatsRef.current.rafFlushes += 1;
      setMessages((prev): readonly CopilotMessage[] => {
        let changed = false;
        const next = prev.map((message): CopilotMessage => {
          const matched = pending.find(([id]): boolean => id === message.id);
          if (matched === undefined) return message;
          changed = true;
          return mergeStreamState(message, appendText(message, matched[1]));
        });
        return changed ? next : prev;
      });
    },
    [cancelStreamTimers],
  );

  /**
   * scheduleBufferedFlush —— 调度下一帧 rAF 提交与 100ms 静默兜底刷新。
   */
  const scheduleBufferedFlush = useCallback((): void => {
    if (!isMountedRef.current || typeof window === 'undefined') return;
    if (gapTimerRef.current !== null) {
      window.clearTimeout(gapTimerRef.current);
    }
    gapTimerRef.current = window.setTimeout((): void => {
      gapTimerRef.current = null;
      flushBufferedText();
    }, STREAM_GAP_FLUSH_MS);

    if (rafIdRef.current !== null || (typeof document !== 'undefined' && document.hidden)) {
      return;
    }
    const tickFrame = (frameTs: number): void => {
      rafIdRef.current = null;
      if (!isMountedRef.current || textBufRef.current.size === 0) return;
      const elapsed = frameTs - lastCommitAtRef.current;
      if (elapsed >= STREAM_FRAME_COMMIT_MS - 1) {
        flushBufferedText(undefined, frameTs);
        return;
      }
      rafIdRef.current = window.requestAnimationFrame(tickFrame);
    };
    rafIdRef.current = window.requestAnimationFrame(tickFrame);
  }, [flushBufferedText]);

  /**
   * enqueueTextDelta —— 将单个 text SSE 增量入队到 rAF 合批器。
   * 首条增量或距上次增量超过 100ms 时立即提交以保持零额外 TTFT 延迟，连续分片走 rAF 合批。
   */
  const enqueueTextDelta = useCallback(
    (messageId: string, delta: string): void => {
      if (delta.length === 0 || !isMountedRef.current) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const prevDeltaAt = lastDeltaAtRef.current.get(messageId) ?? 0;
      lastDeltaAtRef.current.set(messageId, now);

      const prevBuffered = textBufRef.current.get(messageId) ?? '';
      textBufRef.current.set(messageId, prevBuffered + delta);

      if (prevDeltaAt === 0 || now - prevDeltaAt > STREAM_GAP_FLUSH_MS) {
        flushBufferedText(messageId, now);
        lastDeltaAtRef.current.set(messageId, now);
        return;
      }
      scheduleBufferedFlush();
    },
    [flushBufferedText, scheduleBufferedFlush],
  );

  /**
   * takeBufferedText —— 在非 text 事件（工具卡/推理步/完成）到来前同步取出缓冲正文，
   * 确保与当前事件在同一次 setMessages 原子合并，不引入额外渲染且严格保序。
   */
  const takeBufferedText = useCallback(
    (messageId: string): string => {
      const buffered = textBufRef.current.get(messageId) ?? '';
      if (buffered.length > 0) {
        textBufRef.current.delete(messageId);
        lastDeltaAtRef.current.delete(messageId);
      }
      if (textBufRef.current.size === 0) {
        cancelStreamTimers();
      }
      return buffered;
    },
    [cancelStreamTimers],
  );

  /**
   * discardBufferedText —— 丢弃未提交的文本缓冲（轮换 reset / 清空会话 / 中止时调用）。
   */
  const discardBufferedText = useCallback(
    (messageId?: string): void => {
      if (messageId !== undefined) {
        textBufRef.current.delete(messageId);
        lastDeltaAtRef.current.delete(messageId);
      } else {
        textBufRef.current.clear();
        lastDeltaAtRef.current.clear();
      }
      if (textBufRef.current.size === 0) {
        cancelStreamTimers();
      }
    },
    [cancelStreamTimers],
  );

  /**
   * 卸载清理：标记卸载状态、取消 rAF/定时器、清空缓冲、中断在途流并销毁观察器。
   */
  useEffect((): (() => void) => {
    isMountedRef.current = true;
    const watchdogs = skeletonWatchdogRef.current;
    const queue = promptQueueRef.current;
    const textBuf = textBufRef.current;
    const deltaTimes = lastDeltaAtRef.current;
    const observedMap = idToObservedElementRef.current;
    return (): void => {
      isMountedRef.current = false;
      cancelStreamTimers();
      textBuf.clear();
      deltaTimes.clear();
      abortRef.current?.abort();
      abortRef.current = null;
      activeSessionRef.current?.finalize('abort');
      activeSessionRef.current = null;
      queue.clear();
      for (const timer of watchdogs.values()) {
        window.clearTimeout(timer);
      }
      watchdogs.clear();
      itemResizeObserverRef.current?.disconnect();
      itemResizeObserverRef.current = null;
      observedMap.clear();
    };
  }, [cancelStreamTimers]);

  /**
   * 浏览器标签页切换守卫：后台挂起时撤销 rAF 并立刻提交残余缓冲，回前台后按需续调度。
   */
  useEffect((): (() => void) | void => {
    if (typeof document === 'undefined') return;
    const handleVisibilityChange = (): void => {
      if (document.hidden) {
        if (rafIdRef.current !== null) {
          window.cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        flushBufferedText();
      } else if (textBufRef.current.size > 0) {
        scheduleBufferedFlush();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return (): void => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flushBufferedText, scheduleBufferedFlush]);

  /** 是否应贴底滚动（用户手动上滑超过 120px 查看历史时置 false） */
  const stickToBottomRef = useRef<boolean>(true);

  const setCopilotStreaming = useClusterStore(
    (s): ((v: boolean) => void) => s.setCopilotStreaming,
  );
  const setLastAssistantMessageId = useClusterStore(
    (s): ((v: string | null) => void) => s.setLastAssistantMessageId,
  );
  const copilotAbortToken = useClusterStore((s): number => s.copilotAbortToken);
  const lastAbortTokenRef = useRef<number>(copilotAbortToken);

  /**
   * 观察到外部中止请求时立即撤销流并清空未提交正文缓冲。
   */
  useEffect((): void => {
    if (copilotAbortToken === lastAbortTokenRef.current) return;
    lastAbortTokenRef.current = copilotAbortToken;

    abortRef.current?.abort();
    abortRef.current = null;
    discardBufferedText();
    activeSessionRef.current?.finalize('abort');
    activeSessionRef.current = null;
    setCopilotStreaming(false);
  }, [copilotAbortToken, discardBufferedText, setCopilotStreaming]);

  /* ========================================================================== */
  /* 滚动锚定与虚拟列表测量（R9-C / R9-D）                                      */
  /* ========================================================================== */

  /**
   * measureVirtualItemNode —— 注册/注销虚拟化消息外层节点的 ResizeObserver 观测。
   * 若视口上方节点实测高度发生变化且当前未处于贴底自动跟随，则等比平移 scrollTop 保持视口稳定。
   */
  const measureVirtualItemNode = useCallback((messageId: string, node: HTMLDivElement | null): void => {
    const prevNode = idToObservedElementRef.current.get(messageId);
    if (prevNode === node) return;

    if (prevNode !== undefined) {
      itemResizeObserverRef.current?.unobserve(prevNode);
      idToObservedElementRef.current.delete(messageId);
    }

    if (node === null) return;

    if (itemResizeObserverRef.current === null && typeof ResizeObserver !== 'undefined') {
      itemResizeObserverRef.current = new ResizeObserver((entries): void => {
        let changed = false;
        let scrollAdjust = 0;
        const container = scrollRef.current;
        for (const entry of entries) {
          const targetId = observedElementToIdRef.current.get(entry.target);
          if (targetId === undefined) continue;
          const nextHeight = entry.contentRect.height;
          if (!Number.isFinite(nextHeight) || nextHeight <= 0) continue;
          const prevHeight = measuredHeightsRef.current.get(targetId);
          if (prevHeight === undefined || Math.abs(prevHeight - nextHeight) >= 0.5) {
            if (
              prevHeight !== undefined &&
              container !== null &&
              !stickToBottomRef.current &&
              entry.target instanceof HTMLElement &&
              entry.target.offsetTop + prevHeight <= container.scrollTop + 2
            ) {
              scrollAdjust += nextHeight - prevHeight;
            }
            measuredHeightsRef.current.set(targetId, nextHeight);
            changed = true;
          }
        }
        if (changed && isMountedRef.current) {
          if (container !== null && Math.abs(scrollAdjust) >= 1) {
            container.scrollTop = Math.max(0, container.scrollTop + scrollAdjust);
          }
          setMeasureVersion((v): number => v + 1);
        }
      });
    }

    observedElementToIdRef.current.set(node, messageId);
    idToObservedElementRef.current.set(messageId, node);
    const rectHeight = node.getBoundingClientRect().height;
    if (rectHeight > 0 && measuredHeightsRef.current.get(messageId) === undefined) {
      measuredHeightsRef.current.set(messageId, rectHeight);
    }
    itemResizeObserverRef.current?.observe(node);
  }, []);

  /**
   * recordVirtualTailHeight —— 静默写入流式尾气泡的实时像素高度，零状态提交，确保并入虚拟池瞬间不跌回默认值。
   */
  const recordVirtualTailHeight = useCallback((messageId: string, height: number): void => {
    if (Number.isFinite(height) && height > 0) {
      measuredHeightsRef.current.set(messageId, height);
    }
  }, []);

  /**
   * 滚动内容区 ResizeObserver：流式正文增高、卡片水合或骨架展开时若处于贴底状态，
   * 直接赋值 scrollTop = scrollHeight（避免每帧在 React effect 中读取 scrollHeight 触发同步回流）。
   */
  useEffect((): (() => void) | void => {
    const contentEl = scrollContentRef.current;
    if (contentEl === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((): void => {
      const container = scrollRef.current;
      if (container === null || !stickToBottomRef.current) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      /* 平滑回底动画进行中不重复触发 scrollTo({ behavior: 'smooth' })，避免每帧重置缓动曲线导致停滞；由跳转定时器在结束帧一次性对齐最新底部 */
      if (now < programmaticJumpUntilRef.current) {
        return;
      }
      container.scrollTop = container.scrollHeight;
    });
    observer.observe(contentEl);
    return (): void => {
      observer.disconnect();
      if (programmaticJumpTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(programmaticJumpTimerRef.current);
        programmaticJumpTimerRef.current = null;
      }
    };
  }, []);

  /**
   * 新消息入列或虚拟窗口切换时同步对齐贴底位置并重算当前可视切片。
   */
  useLayoutEffect((): void => {
    const el = scrollRef.current;
    if (el !== null && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    if (!virtualized) {
      if (virtualRangeRef.current.start !== 0 || virtualRangeRef.current.end !== 0) {
        const empty: VirtualRange = { start: 0, end: 0 };
        virtualRangeRef.current = empty;
        setVirtualRange(empty);
      }
      return;
    }
    const scrollTop = el !== null ? el.scrollTop : 0;
    const viewportHeight = el !== null ? el.clientHeight : 0;
    const maxRendered = maxVirtualRendered;
    const rawNextRange = computeVirtualRange(virtualLayout, scrollTop, viewportHeight, maxRendered);
    const nextRange = stabilizeBottomStickyRange(
      virtualRangeRef.current,
      rawNextRange,
      stickToBottomRef.current,
      maxRendered,
    );
    if (
      nextRange.start !== virtualRangeRef.current.start ||
      nextRange.end !== virtualRangeRef.current.end
    ) {
      virtualRangeRef.current = nextRange;
      setVirtualRange(nextRange);
    }
  }, [hasPinnedTail, maxVirtualRendered, messages.length, virtualLayout, virtualized]);

  /**
   * handleScroll —— 记录用户是否上滑超过 120px，并在虚拟模式下通过 flushSync 同步刷新切片防止空白闪烁。
   */
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    let nearBottom = distance < STICKY_SCROLL_THRESHOLD_PX;
    if (nearBottom) {
      programmaticJumpUntilRef.current = 0;
    } else if (now < programmaticJumpUntilRef.current) {
      /* 仅当用户主动明显回滚（>24px）时才中断平滑回底，避免流式微幅高度抖动误取消跳转 */
      if (el.scrollTop < prevTop - 24) {
        programmaticJumpUntilRef.current = 0;
        if (programmaticJumpTimerRef.current !== null && typeof window !== 'undefined') {
          window.clearTimeout(programmaticJumpTimerRef.current);
          programmaticJumpTimerRef.current = null;
        }
      } else {
        nearBottom = true;
      }
    }
    stickToBottomRef.current = nearBottom;
    setIsAwayFromBottom((prev): boolean => (prev === !nearBottom ? prev : !nearBottom));

    if (virtualizedRef.current) {
      const maxRendered = VIRTUAL_MAX_RENDERED_TARGET - 1;
      const rawNextRange = computeVirtualRange(
        virtualLayoutRef.current,
        el.scrollTop,
        el.clientHeight,
        maxRendered,
      );
      const nextRange = stabilizeBottomStickyRange(
        virtualRangeRef.current,
        rawNextRange,
        nearBottom,
        maxRendered,
      );
      if (
        nextRange.start !== virtualRangeRef.current.start ||
        nextRange.end !== virtualRangeRef.current.end
      ) {
        virtualRangeRef.current = nextRange;
        try {
          flushSync((): void => {
            setVirtualRange(nextRange);
          });
        } catch {
          setVirtualRange(nextRange);
        }
      }
    }
  }, []);

  /**
   * jumpToLatest —— 点击「回到最新诊断」时平滑滚动到底部并恢复自动跟随。
   */
  const jumpToLatest = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    /* 保护窗口高于定时器延迟（400ms），避免定时器未触发前 handleScroll 误判超时并关闭 stickToBottomRef */
    programmaticJumpUntilRef.current = now + 520;
    lastScrollTopRef.current = el.scrollTop;
    if (programmaticJumpTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(programmaticJumpTimerRef.current);
      programmaticJumpTimerRef.current = null;
    }
    stickToBottomRef.current = true;
    setIsAwayFromBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    if (typeof window !== 'undefined') {
      programmaticJumpTimerRef.current = window.setTimeout((): void => {
        programmaticJumpTimerRef.current = null;
        if (isMountedRef.current && scrollRef.current !== null) {
          programmaticJumpUntilRef.current = 0;
          stickToBottomRef.current = true;
          setIsAwayFromBottom(false);
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          lastScrollTopRef.current = scrollRef.current.scrollTop;
        }
      }, 400);
    }
  }, []);

  /**
   * 观测 CopilotDrawer 自身提交次数并在 dev / ?debug 下挂载全局流式调试钩子。
   */
  useEffect((): void => {
    streamPerfStatsRef.current.drawerCommits += 1;
  });

  useEffect((): (() => void) | void => {
    if (!isStreamDebugEnabled()) return;
    const api: StreamPerfDebugApi = {
      reset: (): void => {
        const stats = streamPerfStatsRef.current;
        stats.totalBubbleCommits = 0;
        stats.historyBubbleCommits = 0;
        stats.activeBubbleCommits = 0;
        stats.userBubbleCommits = 0;
        stats.drawerCommits = 0;
        stats.rafFlushes = 0;
        stats.perMessageCommits = {};
        if (!isStreamingRef.current) {
          turnUserMessageIdsRef.current.clear();
          turnAssistantMessageIdsRef.current.clear();
          activeAssistantIdRef.current = null;
        }
      },
      getSnapshot: (): StreamPerfDebugSnapshot => {
        const stats = streamPerfStatsRef.current;
        const container = scrollRef.current;
        const mountedMsgDomCount =
          container !== null ? container.querySelectorAll('[data-copilot-msg]').length : 0;
        return {
          totalBubbleCommits: stats.totalBubbleCommits,
          historyBubbleCommits: stats.historyBubbleCommits,
          activeBubbleCommits: stats.activeBubbleCommits,
          userBubbleCommits: stats.userBubbleCommits,
          drawerCommits: stats.drawerCommits,
          rafFlushes: stats.rafFlushes,
          virtualized: virtualizedRef.current,
          mountedMsgDomCount,
          perMessageCommits: { ...stats.perMessageCommits },
        };
      },
    };
    window.__KUBEVISION_STREAM_DEBUG__ = api;
    return (): void => {
      if (window.__KUBEVISION_STREAM_DEBUG__ === api) {
        delete window.__KUBEVISION_STREAM_DEBUG__;
      }
    };
  }, []);

  const handleBubbleCommitted = useCallback((messageId: string, msgIsStreaming: boolean): void => {
    const stats = streamPerfStatsRef.current;
    stats.totalBubbleCommits += 1;
    stats.perMessageCommits[messageId] = (stats.perMessageCommits[messageId] ?? 0) + 1;
    const isCurrentActive =
      messageId === activeAssistantIdRef.current ||
      msgIsStreaming ||
      turnAssistantMessageIdsRef.current.has(messageId);
    if (isCurrentActive) {
      stats.activeBubbleCommits += 1;
    } else if (turnUserMessageIdsRef.current.has(messageId)) {
      stats.userBubbleCommits += 1;
    } else {
      stats.historyBubbleCommits += 1;
    }
  }, []);

  /* ========================================================================== */
  /* 浏览器原生语音能力探测与 TTS 播报                                          */
  /* ========================================================================== */

  useEffect((): void => {
    const candidate = window as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    setSpeechAsrSupported(
      candidate.SpeechRecognition !== undefined || candidate.webkitSpeechRecognition !== undefined,
    );
  }, []);

  const {
    playbackState: ttsPlaybackState,
    voiceInfo,
    speakingMessageId,
    isSupported: ttsSupported,
    speak,
    stop: stopSpeaking,
  } = useSpeechSynthesis();

  /**
   * speakMessage —— 朗读指定 AI 消息（通过 rootCauseAlertSchema 校验兜底摘要，移除 as 断言）。
   */
  const speakMessage = useCallback(
    (message: CopilotMessage): void => {
      const rootCauseCard = message.toolCards.find(
        (card): boolean =>
          card.state === 'ready' &&
          isRootCauseTool(card.toolName) &&
          card.args !== undefined,
      );
      const parsedRootCause =
        rootCauseCard?.args !== undefined
          ? rootCauseAlertSchema.safeParse(rootCauseCard.args)
          : null;
      const rootCauseProps =
        parsedRootCause !== null && parsedRootCause.success ? parsedRootCause.data : null;

      const primary = message.text.trim();
      const fallback =
        rootCauseProps !== null
          ? `${rootCauseProps.severity} 级故障。${rootCauseProps.title}。${rootCauseProps.rootCauseSummary}`
          : '本轮已完成诊断，详情见屏幕上的卡片。';

      speak(primary.length > 0 ? primary : fallback, message.id);
    },
    [speak],
  );

  const speakingMessageIdRef = useRef<string | null>(speakingMessageId);
  const speakMessageRef = useRef<(message: CopilotMessage) => void>(speakMessage);
  const stopSpeakingRef = useRef<() => void>(stopSpeaking);
  useLayoutEffect((): void => {
    speakingMessageIdRef.current = speakingMessageId;
    speakMessageRef.current = speakMessage;
    stopSpeakingRef.current = stopSpeaking;
  });

  useEffect((): void => {
    if (speechRequest === null) return;
    const latest = messages.find((m): boolean => m.id === speechRequest.messageId);
    if (latest !== undefined && !latest.isStreaming && latest.text.trim().length > 0) {
      speakMessage(latest);
    }
    setSpeechRequest(null);
  }, [speechRequest, messages, speakMessage]);

  /**
   * toggleMessageSpeaking —— 单条消息的朗读/停止切换（依赖 ref 维持稳定引用）。
   */
  const toggleMessageSpeaking = useCallback((message: CopilotMessage): void => {
    if (speakingMessageIdRef.current === message.id) {
      stopSpeakingRef.current();
      return;
    }
    speakMessageRef.current(message);
  }, []);

  /* 关闭 TTS 时立即停止正在进行的播报 */
  useEffect(() => {
    if (!ttsEnabled) {
      stopSpeaking();
    }
  }, [ttsEnabled, stopSpeaking]);


  /* ========================================================================== */
  /* 消息更新辅助                                                               */
  /* ========================================================================== */

  /** 按 id 局部更新 AI 消息（函数式更新，避免闭包陈旧值） */
  const patchMessage = useCallback(
    (messageId: string, patcher: (prev: CopilotMessage) => CopilotMessage): void => {
      setMessages((prev) =>
        prev.map((m): CopilotMessage => (m.id === messageId ? patcher(m) : m)),
      );
    },
    [],
  );

  /* ========================================================================== */
  /* 构造集群上下文                                                              */
  /* ========================================================================== */

  /**
   * buildClusterContext —— 从当前 store 快照构造 /api/chat 的 clusterContext。
   *
   * 【关键点】必须带上 selectedPodSnapshot：当用户选中的是**健康 Pod**时，
   * 它不在 faultyPods 里，服务端拿不到它的指标，卡片就会缺失或张冠李戴。
   * 这里把选中 Pod 的完整快照（含 6 点历史）一并送出，保证卡片绑定真实数据。
   */
  const buildClusterContext = useCallback((): ClusterContext => {
    const state = useClusterStore.getState();
    const snapshot = state.snapshotSummary;

    const toFaultSnapshot = (pod: (typeof snapshot.pods)[number]) => ({
      id: pod.id,
      name: pod.name,
      namespace: pod.namespace,
      status: pod.status,
      cpuUsage: pod.cpuUsage,
      memoryUsage: pod.memoryUsage,
      restarts: pod.restarts,
      nodeId: pod.nodeId,
      cpuHistory: pod.cpuHistory,
      memHistory: pod.memHistory,
    });

    /* 异常 Pod：状态非 Running/Ready 的（与引擎的告警口径一致） */
    const faultyPods = snapshot.pods
      .filter((p): boolean => p.status !== 'Running')
      .slice(0, 6)
      .map(toFaultSnapshot);

    /* 选中的 Pod 快照（健康与否都带，供服务端绑定卡片） */
    const selectedPod =
      state.selectedEntityType === 'pod' && state.selectedEntityId !== null
        ? snapshot.pods.find((p): boolean => p.id === state.selectedEntityId)
        : undefined;

    return {
      selectedEntityId: state.selectedEntityId,
      selectedEntityType: state.selectedEntityType,
      activeChaos: state.activeChaos,
      clusterHealthScore: snapshot.clusterHealthScore,
      totalQps: snapshot.totalQps,
      faultyPods,
      ...(selectedPod !== undefined ? { selectedPodSnapshot: toFaultSnapshot(selectedPod) } : {}),
      nodes: snapshot.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        status: n.status,
        cpuUsage: n.cpuUsage,
        memUsage: n.memUsage,
        rackIndex: n.rackIndex,
      })),
    };
  }, []);

  /**
   * handleExportPostMortem —— 生成复盘报告并打开预览弹窗。
   *
   * 【为何先生成再打开】用户点击后应立刻看到成品，而不是先看一个空白弹窗
   * 再等内容填充。生成是纯同步字符串拼接（毫秒级），无需 loading 态。
   *
   * 【时间基准】sessionStartedAtRef 在挂载时确定，保证同一次会话内
   * 反复导出时时间线的相对时刻保持一致，不会每点一次就往后漂一段。
   */
  const handleExportPostMortem = useCallback((): void => {
    const nowMs = Date.now();

    /*
     * 【A7 自愈：用事故发生时刻的快照，而不是导出时刻的实时值】
     *
     * 用户自愈完成后集群已恢复健康，若此时导出，旧实现写的是
     * "当前健康分 100"——与事故经过完全对不上。
     * 这里从最近一次自愈记录里取 beforeHealth（事故当时的健康分），
     * 异常 Pod 数按当前上下文与自愈目标数反推（至少 1 个）。
     */
    const diff = useClusterStore.getState().lastRemediationDiff;
    const incidentBefore =
      diff === null
        ? null
        : {
            healthScore: diff.beforeHealth,
            anomalyCount: Math.max(1, useClusterStore.getState().snapshotSummary.pods.filter(
              (p): boolean => p.status !== 'Running',
            ).length + 1),
            chaos: useClusterStore.getState().activeChaos,
          };

    const baseReport = buildPostMortemMarkdown({
      messages,
      clusterContext: buildClusterContext(),
      startedAtMs: sessionStartedAtRef.current,
      nowMs,
      incidentBefore,
      incidentTimelineMarkdown: renderIncidentTimelineMarkdown(),
    });
    /* R43：复盘报告附链路摘要（无 trace 时保持原样） */
    const traceSummary = useAgentTraceStore.getState().summary;
    const traceBlock =
      traceSummary === null
        ? ''
        : [
            '',
            '---',
            '',
            '## 链路追踪摘要',
            '',
            '| 指标 | 值 |',
            '|---|---|',
            '| traceId | ' + traceSummary.traceId + ' |',
            '| 引擎 | ' + traceSummary.engine + ' |',
            '| TTFT | ' + traceSummary.ttftMs.toFixed(0) + ' ms |',
            '| 总时长 | ' + traceSummary.totalMs.toFixed(0) + ' ms |',
            '| tokens | ' +
              (traceSummary.promptTokens === undefined && traceSummary.completionTokens === undefined
                ? '未配置'
                : String(traceSummary.promptTokens ?? 0) + ' / ' + String(traceSummary.completionTokens ?? 0)) +
              ' |',
            '| 成本 | ' + (traceSummary.costCny === undefined ? '未配置' : '¥' + traceSummary.costCny.toFixed(4)) + ' |',
          ].join('\n');
    setPostMortemMarkdown(baseReport + traceBlock);
    setPostMortemFilename(buildPostMortemFilename(nowMs));
    openModal('postMortem');
  }, [buildClusterContext, messages, openModal]);

  /* ========================================================================== */
  /* 核心：发送消息并消费 NDJSON 流                                                */
  /* ========================================================================== */

  /**
   * sendMessage —— 发送用户消息并以 NDJSON 流式方式消费服务端响应。
   *
   * 【核心流转】
   * 1. 构造用户消息（含待发送的视口快照缩略图），并**立即清空** store 中的
   *    capturedViewportDataUrl——避免下一条消息重复携带同一张图；
   * 2. 插入一条空的 AI 消息占位（isStreaming=true）；
   * 3. fetch('/api/chat') 拿到 body reader，按 '\n' 逐行解析 ChatStreamEvent；
   * 4. 分派：reasoning→追加思考链；text→累积正文；tool-start→插入骨架槽；
   *    tool-result→按 toolCallId 原地升级为卡片（并触发 TTS 播报）；
   *    engine→记录实际引擎；
   * 5. 流结束或出错时收尾（isStreaming=false）。
   *
   * 【取消语义】用 AbortController：用户可点"清空会话"或再次发送时中断旧流，
   * 避免两条流同时往同一个消息数组里写入导致状态错乱。
   */
  const sendMessage = useCallback(
    async (rawText: string): Promise<void> => {
      const text = rawText.trim();
      if (text.length === 0) return;

      /*
       * 【R2 · FIFO 排队】流式期间不丢弃请求：enqueue 追加到共享队列尾部，
       * 当前流收尾时 shift 出队首自动发送。连发多条按序执行，不再单槽覆盖丢上下文。
       */
      if (isStreamingRef.current) {
        promptQueueRef.current.enqueue(text);
        setQueuedPromptNotice(`已排队 ${promptQueueRef.current.length()} 条：当前回答结束后按序自动发送`);
        return;
      }

      /* ---- 输入安全校验（发送前拦截，防注入/超长/空内容） ---- */
      const guard = validatePrompt(text);
      if (!guard.ok) {
        setInputGuardError(guard.reason);
        return;
      }
      setInputGuardError(null);
      setGuardWarning(guard.warning ?? null);

      /* ---- 中断上一条未完成的流 ---- */
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      /* ---- 取出待发送的视口快照，并立即清空待发预览 ---- */
      const viewportForSend = capturedViewportRef.current;
      if (viewportForSend !== null) {
        setCapturedViewport(null);
      }

      /* ---- 1. 用户消息入列 ---- */
      const userMessage: CopilotMessage = {
        id: makeId('user'),
        role: 'user',
        text,
        ...(viewportForSend !== null ? { viewportSnapshot: viewportForSend } : {}),
        reasoningSteps: [],
        toolCards: [],
        isStreaming: false,
      };

      /* ---- 2. AI 占位消息 ---- */
      const assistantId = makeId('ai');
      const assistantMessage: CopilotMessage = {
        id: assistantId,
        role: 'assistant',
        text: '',
        reasoningSteps: [],
        toolCards: [],
        isStreaming: true,
      };

      activeAssistantIdRef.current = assistantId;
      turnUserMessageIdsRef.current.add(userMessage.id);
      turnAssistantMessageIdsRef.current.add(assistantId);

      /* 历史消息（供服务端理解上下文，取最近 8 条避免载荷膨胀） */
      const history = [...messagesRef.current, userMessage]
        .slice(-8)
        .map((m): { role: 'user' | 'assistant'; content: string } => ({
          role: m.role,
          content:
            m.role === 'assistant'
              ? `${m.text}${summarizeToolCardsForHistory(m.toolCards)}`
              : m.text,
        }));

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setInputValue('');
      setIsStreaming(true);
      setQueuedPromptNotice(null);

      /* A 项：流开始 → 写入活动状态（事件回调处，非渲染期） */
      setCopilotStreaming(true);
      setLastAssistantMessageId(assistantId);
      stickToBottomRef.current = true;

      /* R2 · trace 换轮：新请求开始即清空上一轮 span/summary，避免跨轮串味 */
      useAgentTraceStore.getState().begin();

      const session = createChatStreamSession({
        setStreaming: setIsStreaming,
        setCopilotStreaming,
        patchAssistant: (patch): void => {
          const buffered = takeBufferedText(assistantId);
          patchMessage(assistantId, (m): CopilotMessage => {
            const withText = buffered.length > 0 ? mergeStreamState(m, appendText(m, buffered)) : m;
            return {
              ...withText,
              isStreaming: patch.isStreaming,
              ...(patch.incomplete === true ? { incomplete: true, failedPrompt: text } : {}),
              ...(patch.failed === true ? { failed: true } : {}),
              toolCards: withText.toolCards.map((card): CopilotToolCard =>
                card.state === 'skeleton'
                  ? { ...card, state: 'error', errorMessage: '流已结束但未收到该卡片的渲染结果' }
                  : card,
              ),
            };
          });
        },
        schedule: (fn, ms): number => window.setTimeout(fn, ms),
        cancel: (id): void => window.clearTimeout(id),
        drainQueue: (): void => {
          const next = promptQueueRef.current.shift();
          if (next === undefined) {
            setQueuedPromptNotice(null);
            return;
          }
          setQueuedPromptNotice(
            promptQueueRef.current.length() > 0
              ? `已排队 ${promptQueueRef.current.length()} 条：当前回答结束后按序自动发送`
              : null,
          );
          window.setTimeout((): void => {
            sendMessageRef.current?.(next);
          }, 0);
        },
        requestTts: (): void => {
          if (ttsEnabledRef.current) setSpeechRequest({ messageId: assistantId, nonce: Date.now() });
        },
        onWatchdogTimeout: (toolCallId): void => {
          patchMessage(assistantId, (m): CopilotMessage => ({
            ...m,
            toolCards: m.toolCards.map((c): CopilotToolCard =>
              c.toolCallId === toolCallId && c.state === 'skeleton'
                ? { ...c, state: 'error', errorMessage: '超过 8 秒未收到渲染结果，已终止等待' }
                : c,
            ),
          }));
        },
      });
      activeSessionRef.current = session;

      const devCollected: ChatStreamEvent[] | null =
        process.env.NODE_ENV === 'production' ? null : [];
      const finalize = (reason: SessionEndReason): void => {
        if (reason === 'abort') {
          discardBufferedText(assistantId);
        }
        if (activeAssistantIdRef.current === assistantId) {
          activeAssistantIdRef.current = null;
        }
        if (devCollected !== null && reason === 'done' && !session.isFinalized()) {
          const violations = validateStreamEvents(devCollected);
          if (violations.length > 0) {
            console.error('[stream-protocol] 开发期协议违例', violations);
          }
        }
        session.finalize(reason);
        if (reason !== 'abort') {
          flushBufferedText(assistantId);
        }
      };

      try {
        /* R46：端侧像素特征（无截图则跳过） */
        const pixelFeatures =
          viewportForSend === null ? null : await computeViewportPixelFeatures(viewportForSend);

        /* R45：端侧模型就绪时带查询句向量（三路召回）；未就绪/300ms 超时自动两路 */
        const queryEmbedding = await embedQueryText(text);

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: history,
            clusterContext: buildClusterContext(),
            ...(viewportForSend !== null ? { viewportImage: viewportForSend } : {}),
            ...(pixelFeatures !== null ? { pixelFeatures } : {}),
            ...(getCustomRunbooks().length > 0
              ? { customRunbooks: getCustomRunbooks() }
              : {}),
            ...(queryEmbedding !== null ? { queryEmbedding } : {}),
          }),
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          finalize('abort');
          return;
        }
        if (!response.ok || response.body === null) {
          throw new Error(`服务端返回 ${response.status}`);
        }

        /* ---- 3. NDJSON 逐行解析（UTF-8 跨 chunk 安全 + 半行缓冲 + 流末 flush） ---- */
        const reader = response.body.getReader();
        let receivedDone = false;

        /**
         * dispatch —— 事件分派：text 走 rAF 合批队列，非 text 事件前先取出缓冲正文原子合并。
         */
        const dispatch = (event: ChatStreamEvent): void => {
          if (devCollected !== null) devCollected.push(event);
          switch (event.type) {
            case 'reasoning': {
              const buffered = takeBufferedText(assistantId);
              patchMessage(assistantId, (m): CopilotMessage => {
                const withText = buffered.length > 0 ? mergeStreamState(m, appendText(m, buffered)) : m;
                return mergeStreamState(withText, appendReasoning(withText, event.step));
              });
              break;
            }

            case 'text': {
              enqueueTextDelta(assistantId, event.content);
              break;
            }

            case 'tool-start': {
              const buffered = takeBufferedText(assistantId);
              patchMessage(assistantId, (m): CopilotMessage => {
                const withText = buffered.length > 0 ? mergeStreamState(m, appendText(m, buffered)) : m;
                return mergeStreamState(
                  withText,
                  upsertToolStart(withText, event.toolCallId, event.toolName, event.mcpUri),
                );
              });
              session.registerWatchdog(event.toolCallId, SKELETON_WATCHDOG_MS);
              break;
            }

            case 'tool-result': {
              session.clearWatchdog(event.toolCallId);
              const buffered = takeBufferedText(assistantId);
              patchMessage(assistantId, (m): CopilotMessage => {
                const withText = buffered.length > 0 ? mergeStreamState(m, appendText(m, buffered)) : m;
                return mergeStreamState(withText, applyToolResult(withText, event));
              });
              break;
            }

            case 'engine': {
              patchMessage(assistantId, (m): CopilotMessage => mergeStreamState(m, setEngine(m, event.engine)));
              break;
            }

            case 'error': {
              const buffered = takeBufferedText(assistantId);
              patchMessage(assistantId, (m): CopilotMessage => {
                const withText = buffered.length > 0 ? mergeStreamState(m, appendText(m, buffered)) : m;
                return {
                  ...withText,
                  failed: true,
                  failedPrompt: text,
                  errorCategory: event.category,
                  requestId: event.requestId,
                };
              });
              break;
            }

            case 'span': {
              useAgentTraceStore.getState().appendSpan({
                traceId: event.traceId,
                name: event.name,
                startMs: event.startMs,
                durationMs: event.durationMs,
                status: event.status,
                attrs: event.attrs,
              });
              break;
            }

            case 'trace-summary': {
              useAgentTraceStore.getState().setSummary({
                traceId: event.traceId,
                engine: event.engine,
                ttftMs: event.ttftMs,
                totalMs: event.totalMs,
                promptTokens: event.promptTokens,
                completionTokens: event.completionTokens,
                costCny: event.costCny,
              });
              break;
            }

            case 'reset': {
              /* R10-B：丢弃未刷新的旧轮缓冲正文；仅 new-round/缺省 清空 trace，fallback/guard 保留回落前 span */
              const reason = event.reason;
              const isFallbackReset = reason === 'engine-fallback' || reason === 'schema-guard';
              const fallbackNote =
                event.note !== undefined && event.note.trim().length > 0
                  ? event.note.trim()
                  : reason === 'engine-fallback'
                    ? '主引擎异常中断，已自动切换本地诊断引擎重新生成'
                    : reason === 'schema-guard'
                      ? '输出未通过安全/格式校验，已自动重置本轮结果'
                      : undefined;
              discardBufferedText(assistantId);
              if (!isFallbackReset) {
                useAgentTraceStore.getState().begin();
              }
              patchMessage(
                assistantId,
                (m): CopilotMessage =>
                  mergeStreamState(m, resetRound(m, { reason, note: fallbackNote })),
              );
              break;
            }

            case 'done': {
              session.markDone();
              receivedDone = true;
              finalize('done');
              break;
            }

            default:
              break;
          }
        };

        const parser = createNdjsonLineParser({
          onEvent: dispatch,
          onMalformedLine: (_line, meta): void => {
            if (meta?.atEof !== true) {
              session.markParseError();
            }
          },
          validate: isChatStreamEvent,
        });

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(value);
          if (receivedDone) break;
        }

        parser.flush();
        const endState = session.resolveState();
        finalize(endState === 'normal' ? 'done' : endState);
      } catch (error) {
        if (controller.signal.aborted) {
          finalize('abort');
          return;
        }
        const reason = error instanceof Error ? error.message : '未知错误';
        const buffered = takeBufferedText(assistantId);
        patchMessage(assistantId, (m): CopilotMessage => {
          const withText = buffered.length > 0 ? mergeStreamState(m, appendText(m, buffered)) : m;
          return {
            ...withText,
            text:
              withText.text.length > 0
                ? `${withText.text}\n\n> [WARN] 诊断流意外中断：${reason}`
                : `> [ERR] 诊断请求失败：${reason}`,
            failed: true,
            failedPrompt: text,
            errorCategory: 'network',
          };
        });
        finalize('error');
      } finally {
        const endState = session.resolveState();
        finalize(endState === 'normal' ? 'done' : endState);
        if (abortRef.current === controller) abortRef.current = null;
        activeSessionRef.current = null;
      }
    },
    [
      buildClusterContext,
      discardBufferedText,
      enqueueTextDelta,
      flushBufferedText,
      patchMessage,
      setCapturedViewport,
      setCopilotStreaming,
      setLastAssistantMessageId,
      takeBufferedText,
    ],
  );

  /* 排队请求重发用：始终指向最新一次渲染的 sendMessage 闭包 */
  sendMessageRef.current = (prompt: string): void => {
    void sendMessage(prompt);
  };

  /**
   * retryLastRequest —— 一键重试上一次失败的请求（无状态依赖，保持回调函数引用恒定）。
   */
  const retryLastRequest = useCallback((failedMessageId: string, prompt: string): void => {
    setMessages((prev) => prev.filter((m): boolean => m.id !== failedMessageId));
    window.setTimeout((): void => {
      sendMessageRef.current?.(prompt);
    }, 0);
  }, []);

  /**
   * handleProactiveDiagnose —— 主动异常横幅的「一键启动诊断」。
   *
   * 【指令构造】把嗅探到的态势事实编码进 prompt：异常 Pod 数量、
   * 具体故障类型分布、当前混沌场景。这样 Copilot 无需二次反问
   * 就能直接进入根因分析——主动感知的价值在于"已经替用户看清楚"。
   */
  const handleProactiveDiagnose = useCallback((): void => {
    const snapshot = useClusterStore.getState().snapshotSummary;
    const faults = snapshot.pods.filter(
      (p): boolean => p.status === 'OOMKilled' || p.status === 'CrashLoopBackOff',
    );
    const statusCounts = new Map<string, number>();
    for (const pod of faults) {
      statusCounts.set(pod.status, (statusCounts.get(pod.status) ?? 0) + 1);
    }
    const breakdown =
      statusCounts.size > 0
        ? [...statusCounts.entries()]
            .map(([status, count]): string => `${status}×${count}`)
            .join('、')
        : '无';

    const prompt =
      `主动异常嗅探发现集群存在 ${faults.length} 个异常容器实例（${breakdown}），` +
      `当前混沌场景 ${activeChaos}，集群健康分 ${snapshot.clusterHealthScore}/100。` +
      (faults.length > 0
        ? `涉及实例：${faults.slice(0, 3).map((p): string => p.name).join('、')}。`
        : '') +
      `请立即执行 SRE 根因分析，定位故障成因并给出可执行的自愈方案。`;

    setBannerDismissed(true);
    void sendMessage(prompt);
  }, [activeChaos, sendMessage]);

  /** dismissBanner —— 关闭主动提示（本轮场景不再打扰） */
  const dismissBanner = useCallback((): void => {
    setBannerDismissed(true);
  }, []);

  /**
   * 【横幅随故障场景变化自动唤醒】（审查报告 §5.3）
   *
   * 缺陷：`bannerDismissed` 一旦置 true 就永不重置，导致用户关掉横幅后，
   * 即便从 POD_OOM_SWARM 切到 NET_PACKET_LOSS 这样的**全新故障**，
   * 主动告警也再也不会弹出——而这恰恰是最该提醒的时刻。
   *
   * 自愈：监听 activeChaos 变化，每当注入新的非 NONE 场景时重置关闭态。
   * 语义上"关闭"应作用于"当前这次告警"，而不是"整个会话"——
   * 新的故障是新的事实，用户值得被重新提醒一次。
   *
   * 注意依赖只有 activeChaos：故障 Pod 数量的波动不重置（否则横幅会
   * 频繁复活），只有**场景切换**这种明确的用户动作才重新提示。
   */
  const prevChaosRef = useRef<string>(activeChaos);
  useEffect(() => {
    if (prevChaosRef.current !== activeChaos) {
      prevChaosRef.current = activeChaos;
      if (activeChaos !== 'NONE') setBannerDismissed(false);
    }
  }, [activeChaos]);

  /** 供横幅渲染的最终开关：已关闭则整体不显示 */
  const showProactiveBanner = !bannerDismissed;

  /**
   * handleActionExecuted —— 自愈完成后的闭环反馈（对话侧的"自愈验证摘要"）。
   *
   * 【为何需要一条独立的绿色系统消息】
   * user 在卡片上点执行后，卡片本身只是变成 "executed"，这是**局部**反馈。
   * 但自愈是一个跨系统的完整动作：Pod 状态变了、内存水位回落了、
   * 集群健康分提升了、3D 相机也飞过去了。用户需要一处能同时看到
   * 这些**结果事实**的地方——那就是对话流里这条系统级摘要。
   *
   * 【数据从哪来】不编造：healEntity 已同步更新了 snapshotSummary，
   * 此处从 store 读取自愈后的**真实**指标（状态/内存/健康分）。
   * 报告里的每个数字都是当前集群的真实值。
   *
   * 【为何用 setTimeout 0】healEntity 与 selectEntity 在同一 tick 内完成，
   * 但 React 状态提交是异步的。延后一帧再读 store，保证拿到的是
   * 已提交的愈合后快照，而不是愈合前的旧值。
   */
  const handleActionExecuted = useCallback((targetId: string, actionType: string): void => {
    window.setTimeout((): void => {
      const state = useClusterStore.getState();
      const snapshot = state.snapshotSummary;

      /* 定位被自愈的实体（可能是 Pod，也可能是节点） */
      const healedPod = snapshot.pods.find((p): boolean => p.id === targetId);
      const healedNode = snapshot.nodes.find((n): boolean => n.id === targetId);

      const targetLabel =
        healedPod !== undefined
          ? healedPod.name
          : healedNode !== undefined
            ? healedNode.name
            : targetId;

      /* 组装摘要：优先展示 Pod 的恢复指标，其次节点，再次兜底 */
      const detailParts: string[] = [];
      if (healedPod !== undefined) {
        detailParts.push(`恢复 ${healedPod.status} 状态`);
        detailParts.push(`内存水位回落至 ${healedPod.memoryUsage.toFixed(0)}%`);
      } else if (healedNode !== undefined) {
        detailParts.push(`节点状态 ${healedNode.status}`);
        detailParts.push(`CPU ${healedNode.cpuUsage.toFixed(0)}% / 内存 ${healedNode.memUsage.toFixed(0)}%`);
      } else {
        detailParts.push('目标实体已恢复');
      }
      detailParts.push(`集群健康度已提升至 ${snapshot.clusterHealthScore.toFixed(0)} 分`);

      const summary =
        `[OK] [MCP Verification] 目标容器 \`${targetLabel}\` 已通过 ` +
        `\`mcp://k8s-cluster/tools/${actionType}\` ${detailParts.join('，')}。`;

      /* 追加为一条独立的系统消息（非 AI 推理消息，不带思考链/卡片） */
      const sysMessage: CopilotMessage = {
        id: makeId('sys'),
        role: 'assistant',
        text: summary,
        reasoningSteps: [],
        toolCards: [],
        isStreaming: false,
        /* 用 engine 字段区分来源：verification 是本地的验证摘要，非模型生成 */
        engine: 'simulator',
        isVerification: true,
      };
      setMessages((prev) => [...prev, sysMessage]);
    }, 0);
  }, []);

  /* ========================================================================== */
  /* 快捷指令（来自外部触发 + 本地芯片）                                            */
  /* ========================================================================== */

  /**
   * 消费外部快捷指令队列（如 3D 画布工具条的"快照诊断"经 triggerQuickPrompt 写入）。
   *
   * 【为什么是队列而不是单槽】单槽会被后一条覆盖，流式期间连点就丢指令。这里每次取队首、
   * 立即出队，再交给 sendMessage；sendMessage 若正流式会把它转入内部 FIFO 排队，
   * 从而"外部连点 → 内部排队"形成一条不丢消息的链路。
   */
  useEffect(() => {
    const next = quickPromptQueue[0];
    if (next === undefined) return;
    shiftQuickPrompt();
    void sendMessage(next);
  }, [quickPromptQueue, shiftQuickPrompt, sendMessage]);

  /* 组件卸载：中止在途流 + 停止拾音 + 停止播报 */
  useEffect(() => {
    return (): void => {
      abortRef.current?.abort();
      /* 拾音的中止由 useSpeechInput 自身的卸载清理负责，这里不重复调用，
         避免在 hook 已释放资源后再触发一次 abort（会重复 close AudioContext） */
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  /* ========================================================================== */
  /* 3D 视口截图                                                                */
  /* ========================================================================== */

  /**
   * captureViewport —— 捕获当前 3D 视口快照。
   *
   * 【取图路径】画布不再常开 preserveDrawingBuffer（R5 第8步），直接
   * canvas.toDataURL() 会读到黑图。改为向 viewportCapture 队列排队：
   * 画布内的 FrameCaptureProvider 在渲染后同帧读取并兑现 Promise。
   * 画布未挂载（抽屉独立打开等）时得到 null，静默忽略。
   */
  const captureViewport = useCallback((): void => {
    void requestViewportCapture({ mime: 'image/jpeg', quality: CAPTURE_QUALITY }).then(
      (dataUrl): void => {
        if (dataUrl !== null) setCapturedViewport(dataUrl);
      },
    );
  }, [setCapturedViewport]);

  /* ========================================================================== */
  /* 语音输入                                                                   */
  /* ========================================================================== */

  /**
   * 【改造：语音输入改为真实麦克风频谱 + 断网声学兜底】
   *
   * 旧实现直接 new webkitSpeechRecognition()，在国内网络下必然触发
   * event.error === 'network'（它要连 Google 服务器），随后弹错误并停录音。
   * 演示现场一旦用 Chrome，语音功能就等于不可用。
   *
   * 新的 useSpeechInput 把三件事解耦：
   * 1. 麦克风采集（getUserMedia + AudioContext）——永远可用，不依赖网络；
   * 2. 云端转写（SpeechRecognition）——可用时优先，失败则静默降级；
   * 3. 声学兜底——识别不可用时仍保持拾音，完成后结合上下文生成指令。
   */
  const speechInput = useSpeechInput({
    getContext: useCallback(() => {
      const state = useClusterStore.getState();
      const snapshot = state.snapshotSummary;
      const selectedPod = snapshot.pods.find(
        (pod): boolean => pod.id === state.selectedEntityId,
      );
      const selectedNode = snapshot.nodes.find(
        (node): boolean => node.id === state.selectedEntityId,
      );
      return {
        faultyCount: snapshot.pods.filter((pod): boolean => pod.status !== 'Running').length,
        selectedName: selectedPod?.name ?? selectedNode?.name ?? null,
        chaos: state.activeChaos,
      };
    }, []),
  });

  /** isListening 从 hook 派生（不再由组件自行维护） */
  const isListening = speechInput.isListening;

  /**
   * toggleListening —— 开始 / 完成语音输入。
   *
   * 【与旧实现的关键差异】
   * - 开始时不再判断"浏览器是否支持识别"——不支持也能用声学模式；
   * - 完成时把 hook 产出的文本**追加**到输入框（而非覆盖），
   *   用户可能已经在输入框里写了一半；
   * - 全程无 alert / 无错误弹窗，只有一条非阻断的 notice 提示当前模式。
   */
  const toggleListening = useCallback((): void => {
    if (speechInput.isListening) {
      /* Q1：停止后由 finalText 消费 effect 统一决定"自动发送 / 填充输入框" */
      void speechInput.stop();
      return;
    }
    void speechInput.start();
  }, [speechInput]);

  /**
   * Q1：播报中用户开口 → 立即打断 TTS 并进入拾音。
   *
   * 打断检测走独立的能量 VAD（useVoiceActivity），不依赖语音识别，
   * 因此在断网/隐私模式下也可用；检测失败时静默降级为手动停止。
   */
  useVoiceActivity(speakingMessageId !== null && ttsEnabled, (): void => {
    stopSpeaking();
    void speechInput.start();
  });

  /**
   * Q1：拾音结束自动发送。
   *
   * 规则：
   * - 纯识别文本 → 直接发送（"说完就说"）；
   * - [声学推断] 兜底文本 → 只填充输入框**不自动发送**（推断可能不准确，
   *   把最终决定权交给用户，这是对"声学推断不是识别结果"的诚实处理）；
   * - 确认类短句（确认/执行/同意/confirm/yes）→ 派发语音确认事件，
   *   由动作卡决定是否执行（高危仍需显式二次确认）。
   */
  const voiceSentRef = useRef<string | null>(null);
  useEffect((): void => {
    const text = speechInput.consumeFinalText();
    if (text === null || text.trim().length === 0) return;
    if (voiceSentRef.current === text) return;
    voiceSentRef.current = text;

    if (text.startsWith('[声学推断]')) {
      setInputValue((prev): string => (prev.length > 0 ? `${prev} ${text}` : text));
      return;
    }
    if (/^(确认|执行|同意|confirm|yes)/i.test(text.trim())) {
      window.dispatchEvent(new CustomEvent('kv-voice-confirm'));
      return;
    }
    sendMessageRef.current?.(text);
  }, [speechInput]);


  /* ========================================================================== */
  /* 清空会话                                                                   */
  /* ========================================================================== */

  const clearSession = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    discardBufferedText();
    activeAssistantIdRef.current = null;
    turnUserMessageIdsRef.current.clear();
    turnAssistantMessageIdsRef.current.clear();
    activeSessionRef.current?.finalize('abort');
    activeSessionRef.current = null;
    setMessages([]);
    setIsStreaming(false);
    /* 清空会话时同时停掉播报与拾音，避免没有内容时声音/录音还在跑 */
    stopSpeaking();
    speechInput.abort();
  }, [discardBufferedText, speechInput, stopSpeaking]);

  /**
   * handleStopGeneration —— 停止当前流式生成，但**保留已产出的内容**。
   *
   * 【为何与 clearSession 分开】两者语义完全不同：
   * - clearSession = 销毁整段对话历史（用户想重新开始）；
   * - handleStopGeneration = 中途刹车（用户觉得答案太啰嗦/跑偏了）。
   *
   * 此前只有前者，用户为了停一段长回复被迫删掉全部历史——这是把
   * "停止"和"销毁"混为一谈。这里先落盘已缓冲的正文再 abort，并同步收敛流状态。
   */
  const handleStopGeneration = useCallback((): void => {
    const activeId = activeAssistantIdRef.current;
    if (activeId !== null) {
      flushBufferedText(activeId);
    } else {
      flushBufferedText();
    }
    abortRef.current?.abort();
    abortRef.current = null;
    activeAssistantIdRef.current = null;
    activeSessionRef.current?.finalize('abort');
    activeSessionRef.current = null;
    setIsStreaming(false);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, [flushBufferedText]);

  /* ========================================================================== */
  /* 渲染                                                                       */
  /* ========================================================================== */

  /**
   * 【双页签标签：中文主标 + 英文副标】
   *
   * 为何保留英文副标：`scripts/verify.mjs` 的浏览器 E2E 通过
   * `/Edge Log Auditor/i` 匹配页签文本定位点击目标。若只留中文，
   * 验收脚本会失配（审查报告 §3.2 的自动化兼容红线）。
   * 双语标注同时满足「界面汉化」与「测试可定位」两个约束，
   * 不必为了测试而牺牲界面语言。
   */
  const tabItems = useMemo(
    (): ReadonlyArray<{
      readonly key: RightPanelTab;
      readonly label: string;
      readonly sub: string;
      readonly icon: typeof Bot;
    }> => [
      /* sub 仅作为 sr-only 测试锚点与 title 提示，视觉上不渲染 */
      { key: 'copilot', label: AGENT_COPY.copilotTitle, sub: AGENT_COPY.copilotTitle, icon: Bot },
      { key: 'auditor', label: AGENT_COPY.auditorTitle, sub: AGENT_COPY.auditorSrOnlyAnchor, icon: ShieldCheck },
    ],
    [],
  );

  const canSend = inputValue.trim().length > 0 && !isStreaming;

  return (
    /*
     * 【aria-label 的双重用途】无障碍标识 + 导演引擎启动预检（G 项）的
     * 挂载探测点。预检若找不到它，说明抽屉还没加载完，此时启动路演会导致
     * 阶段 3 的诊断无处呈现。
     */
    <div aria-label="AI Copilot 抽屉" className="flex h-full min-h-0 flex-col">
      {/* ============ 顶部：单行页签（图标 + 纯中文标题） ============ *
       * 【为何改成单行】此前是"中文主标 + 英文副标"上下两行的堆叠布局，
       * 视觉上像两个小标签叠在一起，既占高度又显得啰嗦。
       * 现改为单行横向：图标 + 中文标题，清爽且与顶栏的控制语言一致。
       *
       * 【sr-only 护航】第二个页签内部保留 `<span className="sr-only">Edge Log Auditor</span>`：
       * scripts/verify.mjs 用 `/Edge Log Auditor/i` 正则匹配页签 textContent 来定位该 Tab，
       * 若彻底删除英文，验收套件会失配。sr-only 让文本存在于 DOM 与 textContent 中，
       * 但视觉上完全不可见——测试与观感两者兼得。
       */}
      <div
        role="tablist"
        aria-label="AI 抽屉视图切换"
        className="flex h-9 shrink-0 items-stretch gap-1 border-b border-white/[0.06] bg-white/[0.015] px-1.5"
      >
        {tabItems.map((tab) => {
          const active = activeRightTab === tab.key;
          const TabIcon = tab.icon;
          const tabKeys = ['copilot', 'auditor'] as const;
          return (
            <button
              key={tab.key}
              id={`copilot-drawer-tab-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`copilot-drawer-panel-${tab.key}`}
              tabIndex={active ? 0 : -1}
              onClick={(): void => setActiveRightTab(tab.key)}
              onKeyDown={(e: ReactKeyboardEvent<HTMLElement>): void =>
                handleRovingTabKeyDown(e, tabKeys, activeRightTab, setActiveRightTab, 'copilot-drawer-tab')
              }
              className={cn(
                'relative flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 transition-colors',
                active ? 'text-cyan-300' : 'text-slate-400 hover:text-slate-200',
              )}
              title={tab.label}
            >
              <TabIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate text-body font-medium leading-none">{tab.label}</span>
              {/*
               * 测试锚点：英文原名仅存在于可访问性树（sr-only），
               * 视觉上不渲染任何英文副标。
               */}
              <span className="sr-only">{tab.sub}</span>
              {active ? (
                <motion.span
                  layoutId="copilot-drawer-tab-underline"
                  transition={{ type: 'spring', ...MOTION.spring }}
                  className="absolute inset-x-1 bottom-0 h-px bg-cyan-400/90"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* ============ 正文区：按 Tab 切换 ============ */}
      {activeRightTab === 'auditor' ? (
        <div
          id="copilot-drawer-panel-auditor"
          role="tabpanel"
          aria-labelledby="copilot-drawer-tab-auditor"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <LocalAuditorPanel />
        </div>
      ) : (
        <div
          id="copilot-drawer-panel-copilot"
          role="tabpanel"
          aria-labelledby="copilot-drawer-tab-copilot"
          className="relative flex min-h-0 flex-1 flex-col"
        >
          {/* ---- 主动异常嗅探横幅：3D 画布 → Copilot 的主动感知联动 ---- *
           * 【设计意图】把「AI 等用户提问」变为「AI 主动发现异常并请缨」。
           * 当 3D 画布侧遥测出现故障态时，Copilot 立刻在顶部亮出横幅，
           * 用户一键即可启动根因分析——这是「双向主动感知」中
           * 「场景态势 → 对话」的那一半（另一半是 Copilot 诊断 → 相机聚焦）。
           *
           * 【为何不自动发起诊断】自动跑诊断会消耗额度、打断用户当前操作，
           * 且用户可能正在阅读别的结论。**提示 + 一键确认**才是恰当的主动：
           * 系统负责发现与准备，执行权始终留在人手里。 */}
          <ProactiveAnomalyBanner
            faultyCount={showProactiveBanner ? faultyPodCount : 0}
            chaosActive={showProactiveBanner && activeChaos !== 'NONE'}
            chaosLabel={activeChaos}
            isBusy={isStreaming}
            onDiagnose={handleProactiveDiagnose}
            onDismiss={dismissBanner}
          />

          {/*
           * ---- 极简单行状态栏（h-8）----
           *
           * 【本轮删掉的两样东西】
           * 1. TTS 状态文字行（喇叭图标 + 「tts 已开启 / 已关闭」文案）
           *    整行文字。它把"一个开关的当前状态"用一整行来复述，而开关本身
           *    就在旁边（图标按钮的选中态已经说明了状态）。这是纯冗余信息，
           *    却常年占据 32px 高度。**删除，不是折叠。**
           * 2. 原有的 `flex-col gap-1.5` 双层容器 —— 改成单行 flex。
           *
           * 【现状】在线就绪 · ContextPill · TTS 开关 · 清空会话 全部收进
           * 一条 32px 细栏，border-b 用 white/[0.06] 而非 slate-800，
           * 与顶栏、页签的分隔线材质统一。
           */}
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-white/[0.015] px-3">
            {/* 在线状态：微呼吸点 + 小字，不再占用整行 */}
            <span className="flex shrink-0 items-center gap-1" title="Copilot 在线">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              <span className="font-mono text-[10px] tracking-wide text-emerald-400/[0.85]">在线</span>
            </span>

            {/* 已绑定实体上下文胶囊 */}
            <span className="min-w-0 flex-1 truncate">
              <ContextPill entityId={selectedEntityId} entityType={selectedEntityType} />
            </span>

            {/*
             * ---- RAG 知识库入口 ----
             *
             * 【为何放在状态栏】它是"知识底座"的入口，与在线状态、上下文同级——
             * 都在表达"这次对话凭什么可信"：状态说明服务可达，胶囊说明
             * 当前聚焦哪个实体，而这里说明 AI 依据的是哪套手册。
             *
             * 【计数徽章为何是 12+】内置 12 篇恒定，但自定义条目是变量，
             * 写死 12 会在评委新增后立刻与弹窗内容不符。用 `12+` 表达
             * "至少 12 篇且可继续扩充"，与弹窗左上角的实时计数互补。
             */}
            <button
              type="button"
              onClick={(): void => openModal('rag')}
              aria-label="打开 SRE 领域知识库"
              title="SRE 领域知识库：浏览语料、实时检索沙盒、现场新增 Runbook"
              className="flex min-h-[44px] shrink-0 items-center gap-1 rounded border border-cyan-400/25 bg-cyan-400/[0.07] px-2 font-mono text-[10px] font-bold tracking-wide text-cyan-300 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/[0.15] md:min-h-0 md:px-1.5 md:py-0.5"
            >
              <BookOpen className="h-2.5 w-2.5" aria-hidden />
              RAG 知识库
              <span className="rounded-sm bg-cyan-400/20 px-1 text-[10px] tabular-nums text-cyan-200">
                12+
              </span>
            </button>

            {hasReplayableContent ? (
              <button
                type="button"
                onClick={handleExportPostMortem}
                aria-label="导出 SRE 故障复盘报告"
                title="基于本次会话的时间线、推理链、RAG 引用与自愈动作生成复盘报告"
                className="flex min-h-[44px] shrink-0 items-center gap-1 rounded border border-emerald-400/25 bg-emerald-400/[0.07] px-2 font-mono text-[10px] font-bold tracking-wide text-emerald-300 transition-colors hover:border-emerald-300/60 hover:bg-emerald-400/[0.15] md:min-h-0 md:px-1.5 md:py-0.5"
              >
                <FileText className="h-2.5 w-2.5" aria-hidden />
                复盘报告
              </button>
            ) : null}

            {/* TTS 开关（图标按钮自身的选中态即状态，无需额外文字说明） */}
            <button
              type="button"
              onClick={(): void => {
                setTtsEnabled((prev): boolean => {
                  const next = !prev;
                  if (next) {
                    const latestAssistant = [...messages]
                      .reverse()
                      .find(
                        (msg): boolean =>
                          msg.role === 'assistant' && msg.text.trim().length > 0,
                      );
                    if (latestAssistant !== undefined) {
                      window.setTimeout((): void => speakMessage(latestAssistant), 0);
                    }
                  } else {
                    stopSpeaking();
                  }
                  return next;
                });
              }}
              aria-pressed={ttsEnabled}
              aria-label="语音播报开关"
              title={
                !ttsSupported
                  ? '当前环境不支持语音合成'
                  : ttsEnabled
                    ? `关闭语音播报${voiceInfo.quality === 'natural' ? '（自然音色）' : ''}`
                    : '开启语音播报'
              }
              className={cn(
                'flex h-11 w-11 shrink-0 items-center justify-center rounded transition-colors md:h-auto md:w-auto md:p-1',
                ttsEnabled
                  ? ttsPlaybackState === 'speaking'
                    ? 'text-cyan-200'
                    : 'text-cyan-300 hover:text-cyan-200'
                  : 'text-slate-400 hover:text-slate-300',
              )}
            >
              {ttsEnabled ? (
                <Volume2
                  className={cn('h-3.5 w-3.5 md:h-3 md:w-3', ttsPlaybackState === 'speaking' && 'animate-pulse')}
                  aria-hidden
                />
              ) : (
                <VolumeX className="h-3.5 w-3.5 md:h-3 md:w-3" aria-hidden />
              )}
            </button>

            {/* 清空会话 */}
            <button
              type="button"
              onClick={clearSession}
              aria-label="清空会话"
              title="清空会话"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:text-rose-300 md:h-auto md:w-auto md:p-1"
            >
              <Eraser className="h-3.5 w-3.5 md:h-3 md:w-3" aria-hidden />
            </button>
          </div>

          {/* ---- 消息流视口容器（相对定位包住消息区与悬浮胶囊，防止胶囊遮挡输入区） ---- */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
              aria-live="polite"
              aria-label="对话消息流"
            >
              <div ref={scrollContentRef} className={messages.length === 0 ? 'h-full' : undefined}>
                {messages.length === 0 ? (
                  /*
                   * ---- 2×2 战术指令启动舱 ----
                   *
                   * 【为何要改】旧空状态是"灰底 + 死灰字 + 两行说明"，读起来像
                   * 一个还没做完的占位页；而空状态恰恰是用户**第一次**接触
                   * Copilot 的地方，应当直接给出"你可以做什么"的可点击入口。
                   *
                   * 现改为：微光徽标 + 标题 + 一句说明 + 2×2 指令卡片。
                   * 卡片即入口——用户不必先想"我该问什么"，点一张就能开始。
                   */
                  <div className="flex min-h-full flex-col justify-between gap-4 px-3 py-4 sm:px-4">
                    <div className="flex flex-col items-center gap-3 pt-2">
                      {/* 微光徽标：单层细描边 + 柔和内发光，克制不刺眼 */}
                      <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                        <Radar className="h-5 w-5 text-cyan-300/90" aria-hidden />
                      </span>

                      <div className="text-center">
                        <p className="text-[13px] font-medium tracking-tight text-slate-200">
                          {AGENT_COPY.copilotEmptyHeading}
                        </p>
                        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                          选择一条战术指令，或直接描述你观察到的异常。
                        </p>
                      </div>
                    </div>

                    {/*
                     * 2×2 战术指令矩阵（工业风：编号 + 单色矢量图标，零 Emoji；< sm 收拢单列保可读）。
                     */}
                    <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                      {QUICK_PROMPTS.map((prompt): ReactElement => {
                        const Icon = prompt.icon;
                        return (
                          <button
                            key={prompt.id}
                            type="button"
                            onClick={(): void => void sendMessage(prompt.text)}
                            disabled={isStreaming}
                            title={prompt.text}
                            className={cn(
                              'group relative min-h-[44px] rounded-lg border p-2.5 text-left transition-all duration-150 kv-touch-feedback',
                              isStreaming
                                ? 'cursor-not-allowed border-white/[0.04] bg-white/[0.01] opacity-50'
                                : 'border-white/[0.07] bg-white/[0.025] hover:border-cyan-400/40 hover:bg-white/[0.05]',
                            )}
                          >
                            {/* 顶部：编号 + 图标容器（左） / 微箭头（右） */}
                            <div className="flex items-start justify-between gap-1">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[10px] tracking-wider text-slate-400">
                                  {prompt.id}
                                </span>
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-white/[0.07] bg-slate-900/80 text-cyan-400 transition-colors group-hover:border-cyan-400/40 group-hover:text-cyan-300">
                                  <Icon className="h-3.5 w-3.5" aria-hidden />
                                </span>
                              </div>
                              <ArrowUpRight
                                className="mt-0.5 h-3 w-3 shrink-0 text-slate-400 transition-colors group-hover:text-cyan-400/80"
                                aria-hidden
                              />
                            </div>

                            {/* 主标题 */}
                            <span className="mt-2 block text-[12px] font-medium leading-snug text-slate-200">
                              {prompt.label}
                            </span>
                            {/* 技术副标题：一行，超出省略，保持卡片等高 */}
                            <span className="mt-0.5 block truncate text-[11px] leading-snug text-slate-400">
                              {prompt.subtitle}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    <p className="border-t border-white/[0.06] pt-2.5 text-center font-mono text-[10px] leading-relaxed text-slate-400">
                      支持 3D 视口快照多模态诊断、RAG Runbook 溯源与一键 MCP 闭环自愈
                    </p>
                  </div>
                ) : virtualized ? (
                  <div className="flex flex-col">
                    <div
                      className="relative w-full"
                      style={{ height: `${virtualLayout.totalHeight}px` }}
                    >
                      {virtualPool
                        .slice(
                          Math.min(effectiveVirtualRange.start, virtualPool.length),
                          Math.min(effectiveVirtualRange.end, virtualPool.length),
                        )
                        .map((message, offsetIdx): ReactElement => {
                          const realIdx =
                            Math.min(effectiveVirtualRange.start, virtualPool.length) + offsetIdx;
                          const itemPos = virtualLayout.items[realIdx];
                          const topPx =
                            itemPos !== undefined
                              ? itemPos.top
                              : realIdx * (VIRTUAL_DEFAULT_BUBBLE_HEIGHT + VIRTUAL_ITEM_GAP_PX);
                          return (
                            <VirtualMessageItem
                              key={message.id}
                              message={message}
                              top={topPx}
                              isSpeaking={speakingMessageId === message.id}
                              onRetry={retryLastRequest}
                              onActionExecuted={handleActionExecuted}
                              onToggleSpeak={toggleMessageSpeaking}
                              onCommitted={handleBubbleCommitted}
                              onMeasureNode={measureVirtualItemNode}
                            />
                          );
                        })}
                    </div>
                    {pinnedTailMessage !== null ? (
                      <PinnedTailItem
                        key={pinnedTailMessage.id}
                        message={pinnedTailMessage}
                        onRetry={retryLastRequest}
                        onActionExecuted={handleActionExecuted}
                        isSpeaking={speakingMessageId === pinnedTailMessage.id}
                        onToggleSpeak={toggleMessageSpeaking}
                        onCommitted={handleBubbleCommitted}
                        onRecordTailHeight={recordVirtualTailHeight}
                      />
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {messages.map((message): ReactElement => (
                      <MessageBubble
                        key={message.id}
                        message={message}
                        onRetry={retryLastRequest}
                        onActionExecuted={handleActionExecuted}
                        isSpeaking={speakingMessageId === message.id}
                        onToggleSpeak={toggleMessageSpeaking}
                        onCommitted={handleBubbleCommitted}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/*
             * 【回到最新诊断 悬浮胶囊】（相对消息区视口底部固定，不会盖住底部输入框）
             */}
            <AnimatePresence>
              {isAwayFromBottom && messages.length > 0 ? (
                <motion.button
                  type="button"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.16 }}
                  onClick={jumpToLatest}
                  aria-label="回到最新诊断"
                  className="pointer-events-auto absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-cyan-500/50 bg-slate-900/90 px-2.5 py-1 font-mono text-[11px] font-semibold text-cyan-300 shadow-glow-cyan kv-blur-panel transition-colors hover:border-cyan-400 hover:bg-slate-800/90 active:scale-95"
                >
                  <ChevronDown className="h-3 w-3" aria-hidden />
                  回到最新诊断
                </motion.button>
              ) : null}
            </AnimatePresence>
          </div>

          {/*
           * ---- 一体化圆角输入舱（Unified Composer）----
           *
           * 【为何要重做】此前是"边框 textarea + 右侧竖排三个小方钮 + 底部
           * 4 个快捷胶囊"的三段式拼装：看起来像三个独立控件被硬塞进同一块区域，
           * 而且那 4 个胶囊**永久固定**在底部——即使对话早已开始，它们仍占着
           * 一整行高度，把消息可视区压掉一截。
           *
           * 现在合成为一个圆角容器（Cursor / Raycast 语言）：
           * 顶部可选缩略图条 → 中部无边框 textarea → 底部内嵌工具栏。
           * 焦点态由容器统一响应（focus-within），输入框本身不再画边框，
           * 视觉上只有一个"输入舱"而不是"输入框 + 一堆按钮"。
           */}
          {/* R36：请求链路瀑布图（无 trace 时自返回 null，不占位） */}
          <div className="shrink-0 px-2 pt-1">
            <AgentTracePanel />
          </div>

          <div className="shrink-0 px-2 pb-2 pt-1.5">
            <div className="rounded-xl border border-white/[0.09] bg-slate-950/80 p-2 shadow-inner transition-colors focus-within:border-cyan-400/50">
              {/* ---- 顶部：选中上下文胶囊 + 视口快照缩略图 ---- */}
              <AnimatePresence>
                {selectedContextLabel !== null ? (
                  <motion.div
                    initial={{ opacity: 0, scaleY: 0.92, y: -4 }}
                    animate={{ opacity: 1, scaleY: 1, y: 0 }}
                    exit={{
                      opacity: 0,
                      scaleY: 0.92,
                      y: -4,
                      transition: { duration: MOTION.panelExitSec, ease: MOTION.easeOut },
                    }}
                    transition={{ type: 'spring', ...MOTION.spring }}
                    style={{ transformOrigin: 'top center' }}
                    className="mb-1.5 overflow-hidden"
                  >
                    {/*
                     * 【为何要自动附带上下文】用户的提问常常是"它为什么挂了"——
                     * 一个"它"字承载了全部语义。若模型不知道当前选中的是哪个
                     * 节点/容器，任何诊断都只能是泛泛而谈。这枚胶囊把"隐性上下文"
                     * 显性化为可见标签：用户能确认模型将看到什么，也能一眼看出
                     * 自己是否选错了对象。
                     */}
                    <div className="flex items-center gap-1.5 rounded-md border border-cyan-400/25 bg-cyan-400/[0.07] px-2 py-1">
                      <Crosshair className="h-2.5 w-2.5 shrink-0 text-cyan-300/90" aria-hidden />
                      <span className="font-mono text-[10px] tracking-wider text-cyan-300">
                        上下文
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold tracking-wide text-cyan-100">
                        {selectedContextLabel}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-cyan-300">
                        auto
                      </span>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <AnimatePresence>
                {capturedViewportDataUrl !== null ? (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    className="relative mb-2"
                  >
                    <div className="flex items-center gap-2 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.05] p-1">
                      {/*
                       * 【缩略图卡】桌面悬停放大 + 移动端点击切换放大预览（clamp 防窄屏裁切）。
                       */}
                      <div className="group/thumb relative shrink-0">
                        <button
                          type="button"
                          onClick={(): void => setSnapshotPreviewOpen((prev): boolean => !prev)}
                          aria-expanded={snapshotPreviewOpen}
                          aria-label="切换 3D 视口快照大图预览"
                          className="relative block overflow-hidden rounded border border-cyan-400/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={capturedViewportDataUrl}
                            alt="待发送的 3D 视口快照"
                            className="h-9 w-14 object-cover"
                          />
                          {/* 扫描光带：内部 1px 高光自上而下循环 */}
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-x-0 top-0 block h-[2px] animate-scan-line"
                            style={{
                              background:
                                'linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.9) 50%, transparent 100%)',
                            }}
                          />
                        </button>
                        {/* 悬停或点击放大预览：限幅防越出窄屏视口 */}
                        <div
                          onClick={(): void => setSnapshotPreviewOpen(false)}
                          className={cn(
                            'absolute bottom-full left-0 mb-2 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-cyan-400/[0.45] bg-slate-950/95 p-1 shadow-[0_12px_36px_rgba(2,6,23,0.9)]',
                            Z_CLASS.CHROME_POPOVER,
                            snapshotPreviewOpen
                              ? 'pointer-events-auto block'
                              : 'pointer-events-none hidden group-hover/thumb:block',
                          )}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={capturedViewportDataUrl}
                            alt="3D 视口快照放大预览"
                            className="h-auto w-full rounded object-contain"
                          />
                        </div>
                      </div>
                      <p className="min-w-0 flex-1 font-mono text-[10px] leading-tight tracking-wide text-cyan-300/80">
                        3D 视口快照就绪
                        <span className="ml-1 text-slate-400">· 点击预览或随消息发送</span>
                      </p>
                      <button
                        type="button"
                        onClick={(): void => {
                          setSnapshotPreviewOpen(false);
                          setCapturedViewport(null);
                        }}
                        aria-label="移除快照"
                        title="移除快照"
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:text-rose-400 md:h-6 md:w-6"
                      >
                        <X className="h-3.5 w-3.5 md:h-3 md:w-3" aria-hidden />
                      </button>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

            {/* ============ 语音拾音可视化（真实麦克风频谱）============ */}
            {isListening ? (
              <div className="mb-1.5 rounded-md border border-rose-500/30 bg-rose-500/[0.06] px-2 py-1.5">
                <div className="flex items-center gap-2">
                  {/* 12 频段实时频谱柱 */}
                  <div
                    className="flex h-5 flex-1 items-end gap-[2px]"
                    aria-label="麦克风实时频谱"
                    role="img"
                  >
                    {speechInput.snapshot.bands.map((energy, index): React.ReactElement => {
                      /**
                       * 【高度映射】能量值 0~1 直接映射到 4~20px。
                       * 下限留 4px 而非 0：静音时柱子完全消失会让界面看起来
                       * 像"坏了"，保留一条基线能持续传达"麦克风在工作"。
                       */
                      const height = 4 + energy * 16;
                      return (
                        <span
                          key={`band-${index}`}
                          className={cn(
                            'flex-1 rounded-sm transition-[height] duration-75',
                            energy > 0.35
                              ? 'bg-rose-400'
                              : energy > 0.12
                                ? 'bg-rose-400/70'
                                : 'bg-rose-400/30',
                          )}
                          style={{ height: `${height}px` }}
                          aria-hidden
                        />
                      );
                    })}
                  </div>

                  {/* 拾音计时器 */}
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-rose-300">
                    {speechInput.snapshot.elapsedSec.toFixed(1)}s
                  </span>

                  {/* 模式标签：如实标注云端 / 端侧 */}
                  <span
                    className={cn(
                      'shrink-0 rounded px-1 py-0.5 font-mono text-[10px] tracking-wider',
                      speechInput.mode === 'cloud'
                        ? 'bg-sky-500/[0.15] text-sky-300'
                        : 'bg-amber-500/[0.15] text-amber-300',
                    )}
                  >
                    {speechInput.mode === 'cloud' ? 'CLOUD' : '端侧声学'}
                  </span>
                </div>

                {/* 实时流式识别字幕条 */}
                {speechInput.snapshot.interimText.length > 0 ? (
                  <p className="mt-1 truncate font-mono text-[10px] text-rose-200/80">
                    {speechInput.snapshot.interimText}
                  </p>
                ) : null}
              </div>
            ) : null}

            {/*
              * 【语音模式提示 —— 拾音过程中也要显示】
              *
              * 此前的条件是 `!isListening` 才渲染，于是「云端识别不可用，
              * 已切端侧模式」这类提示在**最需要告知的时刻**（正在录音、
              * 用户正对着麦克风说话）反而被隐藏了，用户完全不知道
              * 识别方式已经变了。改为拾音期间也显示，且不阻断操作。
              */}
            {speechInput.notice !== null ? (
              <p className="mb-1 flex items-center gap-1 font-mono text-[11px] text-amber-400">
                <AlertTriangle className="h-2.5 w-2.5 shrink-0" aria-hidden />
                {speechInput.notice}
              </p>
            ) : null}

            {/* 输入安全校验提示（超长/异常字符等，发送前拦截） */}
            {inputGuardError !== null ? (
              <p className="mb-1 flex items-center gap-1 font-mono text-[11px] text-rose-400">
                <AlertTriangle className="h-2.5 w-2.5 shrink-0" aria-hidden />
                {inputGuardError}
              </p>
            ) : null}

            {/* 提示注入警告（放行但告知，不阻断正常工作流） */}
            {guardWarning !== null ? (
              <div className="mb-1 flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-1">
                <ShieldAlert className="mt-[1px] h-2.5 w-2.5 shrink-0 text-amber-400" aria-hidden />
                <p className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed text-amber-300">
                  {/* 行内富文本：护栏提示可能内嵌代码/加粗标记，避免裸露语法 */}
                  <InlineMarkdown text={guardWarning} />
                </p>
                <button
                  type="button"
                  onClick={(): void => setGuardWarning(null)}
                  aria-label="关闭安全提示"
                  className="shrink-0 text-amber-500/70 transition-colors hover:text-amber-300"
                >
                  <X className="h-2.5 w-2.5" aria-hidden />
                </button>
              </div>
            ) : null}

            {/*
               * ---- 战术指令条（对话态专用，展开时为输入框上方一行） ----
               *
               * 只在「已有对话 + 用户主动展开」时出现：
               * - 空状态：由中央 2×2 矩阵承担入口，这里完全不渲染（不重复）；
               * - 对话态：默认收起，点工具栏「战术指令」才展开，用完即收，
               *   不常驻占用消息可视区。
               *
               * 视觉：纯等宽字体 + 单色矢量图标，无 Emoji。
               */}
              <AnimatePresence initial={false}>
                {messages.length > 0 && isQuickPromptsOpen ? (
                  <motion.div
                    initial={{ opacity: 0, scaleY: 0.92, y: -4 }}
                    animate={{ opacity: 1, scaleY: 1, y: 0 }}
                    exit={{
                      opacity: 0,
                      scaleY: 0.92,
                      y: -4,
                      transition: { duration: MOTION.panelExitSec, ease: MOTION.easeOut },
                    }}
                    transition={{ duration: MOTION.panelExitSec, ease: MOTION.easeOut }}
                    style={{ transformOrigin: 'top center' }}
                    className="overflow-hidden"
                  >
                    <div className="mb-1.5 flex flex-wrap items-center gap-1 border-b border-white/[0.05] pb-1.5">
                      {QUICK_PROMPTS.map((prompt): React.ReactElement => {
                        const Icon = prompt.icon;
                        return (
                          <button
                            key={prompt.id}
                            type="button"
                            onClick={(): void => void sendMessage(prompt.text)}
                            disabled={isStreaming}
                            title={`${prompt.id} · ${prompt.subtitle}`}
                            className={cn(
                              'flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-tight transition-colors',
                              isStreaming
                                ? 'cursor-not-allowed border-white/[0.04] text-slate-500'
                                : 'border-white/[0.07] text-slate-400 hover:border-cyan-400/40 hover:bg-white/[0.03] hover:text-cyan-300',
                            )}
                          >
                            <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden />
                            <span className="text-slate-400">{prompt.code}</span>
                            {prompt.short}
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {/* ---- A5：排队提示（流式期间用户点了诊断，请求已排队） ---- */}
              {queuedPromptNotice !== null ? (
                <p
                  className="mb-1 rounded border border-cyan-400/25 bg-cyan-400/[0.08] px-1.5 py-1 font-mono text-[10px] text-cyan-300"
                  role="status"
                  aria-label="排队提示"
                >
                  {queuedPromptNotice}
                </p>
              ) : null}

              {/* ---- 中部：无边框 textarea（焦点态由容器统一表达） ---- */}
              <textarea
                value={inputValue}
                onChange={(e): void => setInputValue(e.target.value)}
                onKeyDown={(e): void => {
                  /* Enter 发送，Shift+Enter 换行；IME 组合期让位（isComposing + 229 双判） */
                  if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e.nativeEvent)) {
                    e.preventDefault();
                    void sendMessage(inputValue);
                  }
                }}
                rows={2}
                placeholder="描述故障现象，或直接提问…（Enter 发送 / Shift+Enter 换行）"
                aria-label="对话输入框"
                className="w-full resize-none bg-transparent px-1 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
              />

              {/* ---- R9-F：精简单行语音说明（默认 1 行 11px，点击 ⓘ 展开完整说明） ---- */}
              <div className="mt-1 flex items-start justify-between gap-1.5">
                <p
                  className={cn(
                    'min-w-0 flex-1 font-mono text-[11px] leading-snug text-slate-400',
                    speechHintExpanded ? 'whitespace-normal' : 'truncate',
                  )}
                  aria-label="语音能力说明"
                >
                  {speechAsrSupported
                    ? speechHintExpanded
                      ? '语音输入 / 播报使用浏览器原生 Web Speech / SpeechSynthesis，无需配置任何 URL 或 API Key。'
                      : '原生 Web Speech 语音输入与播报（无需 API Key）'
                    : speechHintExpanded
                      ? '语音播报使用浏览器原生 SpeechSynthesis；当前浏览器不支持语音识别，请改用 Chrome / Edge 或直接键盘输入。'
                      : '当前浏览器不支持语音识别，请改用 Chrome / Edge 或键盘输入'}
                </p>
                <button
                  type="button"
                  onClick={(): void => setSpeechHintExpanded((prev): boolean => !prev)}
                  aria-expanded={speechHintExpanded}
                  aria-label={speechHintExpanded ? '收起语音能力说明' : '展开语音能力说明'}
                  title="查看语音能力说明"
                  className="kv-touch-target flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-cyan-300"
                >
                  <Info className="h-3 w-3" aria-hidden />
                </button>
              </div>

              {/* ---- 底部内嵌工具栏 ---- */}
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {/* 截取 3D 视口 */}
                <button
                  type="button"
                  onClick={captureViewport}
                  aria-label="捕获当前 3D 视图"
                  title="截取当前 3D 视口快照，作为多模态输入"
                  className="flex min-h-[44px] min-w-0 shrink items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] tracking-tight text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-cyan-300 md:min-h-0 md:px-1.5"
                >
                  <Camera className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">截取 3D 视口</span>
                </button>

                {/* 语音输入 */}
                <button
                  type="button"
                  onClick={toggleListening}
                  aria-label={isListening ? '完成语音输入' : '开始语音输入'}
                  aria-pressed={isListening}
                  title={isListening ? '点击完成录音' : '语音输入（真实麦克风频谱）'}
                  className={cn(
                    'relative flex min-h-[44px] min-w-0 shrink items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] tracking-tight transition-colors md:min-h-0 md:px-1.5',
                    isListening
                      ? 'bg-rose-500/[0.15] text-rose-300'
                      : 'text-slate-400 hover:bg-white/[0.05] hover:text-cyan-300',
                  )}
                >
                  <Mic
                    className="h-3 w-3 shrink-0"
                    aria-hidden
                    /* Q2：电平由 CSS 变量驱动，零 React 重渲染 */
                    style={{
                      filter: isListening
                        ? 'drop-shadow(0 0 calc(var(--kv-mic-level, 0) * 6px) rgba(244,63,94,0.9))'
                        : undefined,
                      opacity: isListening ? 'calc(0.75 + var(--kv-mic-level, 0) * 0.25)' : undefined,
                    }}
                  />
                  <span className="truncate">{isListening ? '完成录音' : '语音输入'}</span>
                  {/* 录音脉冲红点 */}
                  {isListening ? (
                    <span className="absolute -right-0.5 -top-0.5 flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-500" />
                    </span>
                  ) : null}
                </button>

                {/*
                 * Q2：语音错误态必须给出具体原因与可操作出口。
                 * 旧实现只有一句泛化 notice，用户不知道是权限、浏览器不支持还是网络。
                 */}
                {speechInput.errorKind !== null ? (
                  <span
                    className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-300"
                    role="status"
                    aria-label="语音输入错误提示"
                  >
                    {speechInput.errorKind === 'permission'
                      ? '麦克风权限被拒绝：请在地址栏允许后重试'
                      : speechInput.errorKind === 'unsupported'
                        ? '当前浏览器不支持语音：请改用 Chrome / Edge'
                        : '语音网络异常：请检查网络后重试'}
                    <button
                      type="button"
                      onClick={(): void => void speechInput.start()}
                      className="min-h-[44px] rounded border border-amber-400/50 px-2 text-[10px] font-bold uppercase tracking-wider hover:bg-amber-500/20 md:min-h-0 md:px-1"
                      aria-label="重试语音输入"
                    >
                      重试
                    </button>
                  </span>
                ) : null}

                {/*
                 * 【战术指令开关 —— 仅对话态提供】
                 */}
                {messages.length > 0 ? (
                  <button
                    type="button"
                    onClick={(): void => setQuickPromptsOpen((prev): boolean => !prev)}
                    aria-expanded={isQuickPromptsOpen}
                    aria-label={isQuickPromptsOpen ? '收起战术指令' : '展开战术指令'}
                    title="战术指令（Tactical Commands）"
                    className={cn(
                      'flex min-h-[44px] min-w-0 shrink items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] tracking-tight transition-colors md:min-h-0 md:px-1.5',
                      isQuickPromptsOpen
                        ? 'bg-cyan-400/10 text-cyan-300'
                        : 'text-slate-400 hover:bg-white/[0.05] hover:text-cyan-300',
                    )}
                  >
                    <Terminal className="h-3 w-3 shrink-0" aria-hidden />
                    <span className="truncate">战术指令</span>
                  </button>
                ) : null}

                {/* 弹性间隙：把发送按钮推到最右 */}
                <span className="min-w-0 flex-1" />

                {isStreaming ? (
                  <button
                    type="button"
                    onClick={handleStopGeneration}
                    aria-label="停止生成"
                    title="停止生成（保留已生成内容）"
                    className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-md border border-rose-500/50 bg-rose-500/[0.15] px-3 py-1 font-mono text-[10px] font-semibold text-rose-300 transition-colors hover:bg-rose-500/25 active:scale-95 md:min-h-0 md:px-2"
                  >
                    <Square className="h-2.5 w-2.5" aria-hidden />
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(): void => void sendMessage(inputValue)}
                    disabled={!canSend}
                    aria-label="发送消息"
                    title="发送"
                    className={cn(
                      'flex min-h-[44px] shrink-0 items-center gap-1 rounded-md border px-3 py-1 font-mono text-[10px] font-semibold transition-colors md:min-h-0 md:px-2',
                      canSend
                        ? 'border-cyan-400/50 bg-cyan-400/[0.15] text-cyan-300 shadow-glow-cyan hover:bg-cyan-400/25'
                        : 'cursor-not-allowed border-white/[0.06] bg-white/[0.02] text-slate-400',
                    )}
                  >
                    发送
                    <kbd className="text-[10px] opacity-70">↵</kbd>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/*
       * ---- SRE 领域知识库弹窗 ----
       *
       * 【为何挂在这里而非页面级】弹窗开关态属于 Copilot 的局部 UI 上下文，
       * 由本组件持有最内聚；提到 ShellLayout 会让「知识库属于 Copilot」
       * 这层语义在代码结构上消失。
       *
       * 【层级】模态自带 fixed inset-0 z-50 + kv-blur-panel，打开时覆盖
       * 包括顶栏在内的全部内容，符合 AGENTS.md 第 6 条层级契约
       * （drei <Html> 恒为 [10,0]，绝不会盖住它）。
       */}
      <RagKnowledgeModal open={ragModalOpen} onClose={(): void => closeModal('rag')} />

      {/*
       * ---- SRE 故障复盘报告预览与导出 ----
       *
       * 与知识库弹窗同级挂载，同样经 createPortal 渲染到 body，
       * 因此 z-50 的全屏覆盖不会受抽屉容器的 transform 影响。
       */}
      <PostMortemModal
        open={postMortemOpen}
        onClose={(): void => closeModal('postMortem')}
        markdown={postMortemMarkdown}
        filename={postMortemFilename}
      />
    </div>
  );
}