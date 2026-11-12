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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement } from 'react';
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
  CheckCircle2,
  ChevronDown,
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
import { cn } from '@/utils/cn';
import { useAgentTraceStore } from '@/store/useAgentTraceStore';
import AgentTracePanel from '@/components/ai/AgentTracePanel';
import { embedQueryText } from '@/utils/edgeEmbedding';
import { computeViewportPixelFeatures } from '@/utils/pixelFeatures';
import TraceIdChip from '@/components/hud/TraceIdChip';
import { useClusterStore } from '@/store/useClusterStore';
import {
  CHAT_ERROR_COPY,
  classifyToolName,
} from '@/types/ai';
import type {
  ActionConfirmProps,
  ChatStreamEvent,
  ClusterContext,
  CopilotMessage,
  CopilotToolCard,
  PodMetricsCardProps,
  RootCauseAlertProps,
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
    subtitle: '定位 Cgroup Exit 137 容器并生成自愈方案',
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

/** 消息列表自动滚动阈值（距底部小于此值才跟随，避免打断用户阅读历史） */
const STICKY_SCROLL_THRESHOLD_PX = 80;

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
        typeLabel: 'POD',
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
      <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] px-2 py-0.5 font-mono text-[10px] tracking-wide text-slate-500">
        <span className="h-1 w-1 shrink-0 rounded-full bg-slate-500" aria-hidden />
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
function summarizeToolCardsForHistory(cards: readonly CopilotToolCard[]): string {
  if (cards.length === 0) return '';

  const lines: string[] = [];
  for (const card of cards) {
    /* 骨架/失败态没有可用载荷，只记工具名，避免编造内容 */
    if (card.state !== 'ready' || card.args === undefined) {
      lines.push(`[已生成卡片: ${card.toolName}（载荷未就绪）]`);
      continue;
    }

    if (card.toolName === 'renderPodMetrics') {
      const args = card.args as PodMetricsCardProps;
      lines.push(
        `[已生成指标卡: Pod=${args.podName}, 命名空间=${args.namespace}, ` +
          `CPU=${args.cpuUsage}%, 内存=${args.memoryUsage}%, 重启=${args.restarts}次]`,
      );
    } else if (card.toolName === 'renderRootCauseAnalysis') {
      const args = card.args as RootCauseAlertProps;
      const citationIds = args.ragReferences.map((doc): string => doc.id).join(', ');
      lines.push(
        `[已生成根因卡片: 严重度=${args.severity}, 标题=${args.title}, ` +
          `置信度=${(args.confidence * 100).toFixed(0)}%, ` +
          `引用知识库=${citationIds.length > 0 ? citationIds : '无'}]`,
      );
    } else if (isActionTool(card.toolName)) {
      const args = card.args as ActionConfirmProps;
      lines.push(
        `[已生成自愈审批卡: 动作=${args.actionType}, 目标=${args.targetName}, ` +
          `工具=${args.mcpEndpoint}, 高危=${args.isHighRisk ? '是' : '否'}]`,
      );
    } else {
      lines.push(`[已生成卡片: ${card.toolName}]`);
    }
  }

  return `\n\n（本轮已生成的界面卡片，供你延续上下文）\n${lines.join('\n')}`;
}

/* ========================================================================== */
/* 子组件：单条工具卡片槽位                                                     */
/* ========================================================================== */

/**
 * ToolCardSlot —— 按工具调用状态渲染骨架屏或真实卡片。
 *
 * 【就地映射】骨架屏与结果卡占据同一个位置，result 到达后原地替换，
 * 用户看到的是"骨架 → 卡片"的连续过渡，而不是列表重排。
 */
function ToolCardSlot({
  card,
  onActionExecuted,
}: {
  readonly card: CopilotToolCard;
  readonly onActionExecuted?: (targetId: string, actionType: string) => void;
}) {
  if (card.state === 'skeleton') {
    return <GenUISkeleton toolName={card.toolName} mcpUri={card.mcpUri} />;
  }

  if (card.state === 'error' || card.args === undefined) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
        <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" aria-hidden />
        <span className="font-mono text-[12px] text-amber-300">
          {card.toolName} 返回的载荷无法渲染
          {card.errorMessage !== undefined ? `（${card.errorMessage}）` : ''}
        </span>
      </div>
    );
  }

  /* ---- 按工具名窄化载荷并挂载对应组件 ---- */
  if (isPodMetricsTool(card.toolName)) {
    const args = card.args as PodMetricsCardProps;
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
    const args = card.args as RootCauseAlertProps;
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
    const args = card.args as ActionConfirmProps;
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
}

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
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
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
              className="ml-auto rounded px-1 py-0.5 text-slate-500 transition-colors hover:text-slate-300"
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
 *
 * 【AI 消息结构】思考链（可折叠）→ 正文 Markdown 文本 → 工具卡片列表。
 * 顺序刻意如此：先让用户看到"AI 是怎么想的"，再给结论，最后给可交互卡片。
 */
function MessageBubble({
  message,
  onRetry,
  onActionExecuted,
  isSpeaking,
  onToggleSpeak,
}: {
  readonly message: CopilotMessage;
  readonly onRetry?: (messageId: string, prompt: string) => void;
  readonly onActionExecuted?: (targetId: string, actionType: string) => void;
  /** 本消息是否正在被朗读（驱动声波条动画与按钮文案） */
  readonly isSpeaking?: boolean;
  /** 切换本消息的朗读/停止 */
  readonly onToggleSpeak?: (message: CopilotMessage) => void;
}) {
  /**
   * 从本消息的根因卡推导 RAG 信号拆解，供思考链的检索步骤内联展示。
   *
   * 【必须放在所有 return 之前】本组件对 user / verification / assistant
   * 三类消息有各自的分支 return。若把 useMemo 写在中间某个 return 之后，
   * 后两类消息就会跳过这次 Hook 调用，导致同一次渲染中 Hook 数量不一致——
   * React 会直接抛 "Rendered more hooks than during the previous render"。
   * 抽到顶部是唯一正确的做法（ESLint react-hooks/rules-of-hooks 会检查这条）。
   *
   * 【非 assistant 消息的处理】user / verification 消息没有 toolCards，
   * find 自然返回 undefined，这里返回 null，不产生任何额外开销。
   */
  const reasoningRagBreakdown = useMemo((): RagSignalBreakdown | null => {
    const rootCard = message.toolCards.find(
      (card): boolean =>
        card.state === 'ready' &&
        card.toolName === 'renderRootCauseAnalysis' &&
        card.args !== undefined,
    );
    if (rootCard?.args === undefined) return null;
    const props = rootCard.args as RootCauseAlertProps;
    const breakdown = buildRagSignalBreakdown(props.ragReferences);
    return breakdown.available ? breakdown : null;
  }, [message.toolCards]);

  /* ---- 用户消息：右侧对齐气泡 + 已发送的视口缩略图 ---- */
  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
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
        <div className="max-w-[85%] rounded-lg rounded-br-sm border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1.5">
          <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-cyan-50">
            {message.text}
          </p>
        </div>
      </div>
    );
  }

  /* ---- 自愈验证摘要：绿色系统级回执，与 AI 回答明确区分 ---- */
  if (message.isVerification === true) {
    return (
      <div className="flex items-start gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-2 shadow-glow-emerald">
        <CheckCircle2 className="mt-[1px] h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-caption leading-relaxed text-emerald-100">
          {/* 行内富文本：回执里的目标名与 MCP 端点用反引号包裹，渲染为代码胶囊 */}
          <InlineMarkdown text={message.text} />
        </p>
      </div>
    );
  }

  /* ---- AI 消息：思考链 + 正文 + 卡片 ---- */
  return (
    <div className="flex flex-col gap-1.5">
      {/* 思考链（流式过程中实时追加，默认折叠） */}
      {message.reasoningSteps.length > 0 ? (
        <AgentThoughtChain
          steps={message.reasoningSteps}
          isStreaming={message.isStreaming && message.text.length === 0}
          ragBreakdown={reasoningRagBreakdown}
        />
      ) : null}

      {/* 正文：经 MarkdownLite 渲染（此前直接输出纯文本，会裸露 ## / ** 等语法） */}
      {message.text.length > 0 ? (
        <div className="rounded-lg rounded-bl-sm border border-white/[0.07] bg-slate-900/60 px-2.5 py-2">
          <MarkdownLite markdown={message.text} isStreaming={message.isStreaming} />
        </div>
      ) : null}

      {/* 工具卡片列表 */}
      {message.toolCards.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {/*
           * 【①②③ 编号导轨】（蓝图 §1.9）
           *
           * 图二把 Agent 的三张卡片标注为 ①→②→③ 的流水线顺序，
           * 让评委一眼看懂"这不是三张随机卡片，而是一条诊断链路"：
           * ① 采集指标 → ② 定位根因 → ③ 提出并执行自愈。
           *
           * 实现方式：在卡片左侧画一条竖直导轨，每个卡片前置一个圆形序号徽标，
           * 徽标之间有连贯的竖线——视觉上形成"流程"而非"列表"。
           * 序号用中文数字（一二三）而非 ①②③，因为 ①②③ 在某些
           * 等宽字体下渲染为方框，中文数字跨平台更稳。
           */}
          {message.toolCards.map((card, cardIndex) => (
            <div key={card.toolCallId} className="relative flex gap-2">
              {/* ---- 左侧导轨：序号徽标 + 连接线 ---- */}
              <div className="flex shrink-0 flex-col items-center">
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cyan-500/50 bg-cyan-500/[0.15] font-mono text-[10px] font-bold text-cyan-300"
                  aria-hidden
                >
                  {cardIndex + 1}
                </span>
                {/* 连接线：最后一个卡片不画，避免悬空断线 */}
                {cardIndex < message.toolCards.length - 1 ? (
                  <span className="mt-0.5 w-px flex-1 bg-gradient-to-b from-cyan-500/40 to-cyan-500/10" aria-hidden />
                ) : null}
              </div>
              {/* ---- 右侧：卡片本体 + 补全角标 ---- */}
              <div className="min-w-0 flex-1">
                {/*
                 * 【服务端补全角标】（诚实标注契约）
                 *
                 * 模型本次没有调用该工具（实测有 40%~50% 概率漏调），
                 * 卡片由路由层用真实集群数据补齐。此处显式标注来源，
                 * 让用户与评测者能区分「模型推断」与「服务端按规则拼装」——
                 * 不做标注就等于把兜底伪装成模型能力。
                 */}
                {card.synthesized === true ? (
                  <span
                    className="mb-1 inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-amber-300/90"
                    title="模型本次未调用该工具，此卡片由服务端依据真实集群数据补全"
                  >
                    <Info className="h-2.5 w-2.5 shrink-0" aria-hidden />
                    服务端补全 · 真实数据
                  </span>
                ) : null}
                <ToolCardSlot card={card} onActionExecuted={onActionExecuted} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/*
        * ---- 单条消息朗读按钮 ----
        *
        * 【为何每条消息都要有】旧实现只能靠右上角的全局开关控制播报，
        * 用户回看历史消息时无法单独重听某一条诊断结论——而"重听结论"
        * 恰恰是语音在运维场景里最有价值的用法（值班时边做事边听）。
        *
        * 【为何只在流结束后显示】流式生成中正文还在增长，
        * 此时朗读只会念到半句话。等整轮结束再允许朗读，语义完整。
        */}
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
            {/* 朗读中：跳动的声波条；静止：喇叭图标 */}
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
        <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            推理引擎 · {message.engine === 'llm' ? '云端大模型' : '本地确定性容灾引擎'}
        </p>
      ) : null}

      {/* ---- 失败降级提示框（带一键重试） ---- *
       * 【设计意图】流中断是最伤体验的失败：用户已经看到思考链在动、
       * 可能已读了一半正文，然后戛然而止。此处不用刺眼的红色错误块，
       * 而是一个克制的琥珀色提示 + 明确的「一键重试」——
       * 让用户知道"发生了什么"且"下一步只需点一下"，而不是陷入困惑。 */}
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
                /*
                 * 【断网恢复后"继续生成"】网络/服务端中断时，已产出内容仍在页面上。
                 * 这里在重试 prompt 末尾追加续写指令，模型会从断点继续而不是重头再来；
                 * 其他错误（工具参数等）仍是标准重试。
                 */
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
    </div>
  );
}

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
   * 【为什么要做这一层】用户的提问常常是"它为什么挂了"——一个"它"字
   * 承载了全部语义。若模型不知道当前选中的是哪个对象，任何诊断都只能泛泛而谈。
   * 这枚标签把**隐性上下文显性化**：用户能确认模型将看到什么，
   * 也能一眼发现自己是不是选错了对象。
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
    return 'MASTER 控制平面 · API-Server';
  }, [selectedEntityId, selectedEntityType]);
  const quickPromptTrigger = useClusterStore((s): string | null => s.quickPromptTrigger);
  const clearQuickPrompt = useClusterStore((s): (() => void) => s.clearQuickPrompt);
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
  /**
   * 浏览器是否支持语音识别（C3：不支持的浏览器要给出可操作提示）。
   *
   * 【为何用 state 而非直接读 window】服务端渲染时 window 不存在，
   * 直接在渲染体里读取会造成 hydration 不一致（服务端 true、客户端 false）。
   */
  const [speechAsrSupported, setSpeechAsrSupported] = useState<boolean>(true);
  /** RAG 知识库弹窗开关（低频 UI 态，允许 useState） */
  const [ragModalOpen, setRagModalOpen] = useState<boolean>(false);

  /* ---- 复盘报告：弹窗开关 + 已生成的 Markdown 与文件名 ---- */
  const [postMortemOpen, setPostMortemOpen] = useState<boolean>(false);
  const [postMortemMarkdown, setPostMortemMarkdown] = useState<string>('');
  const [postMortemFilename, setPostMortemFilename] = useState<string>('');

  /**
   * 会话起点时刻。
   *
   * 【为何用 ref 存而非 state】它只在首次挂载时确定一次、之后永不变化，
   * 放进 state 会引入无意义的渲染依赖。用 ref 惰性初始化，
   * 保证复盘时间线的基准点稳定。
   */
  const sessionStartedAtRef = useRef<number>(Date.now());

  /**
   * 是否有可复盘的内容。
   *
   * 【判定口径】至少产出一张 ready 态卡片才算。仅有聊天文字不构成
   * 可复盘的事故——没有指标、根因或动作，导出的报告只剩空章节，
   * 与其让用户下载一份无内容的文件，不如在源头上就不提供入口。
   */
  const hasReplayableContent = useMemo(
    (): boolean =>
      messages.some((message): boolean =>
        message.toolCards.some((card): boolean => card.state === 'ready'),
      ),
    [messages],
  );

  const [ttsEnabled, setTtsEnabled] = useState<boolean>(false);
  /** 用户是否已关闭主动异常横幅（关闭后本轮会话不再打扰） */
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(false);
  /** 输入安全校验的即时错误提示 */
  const [inputGuardError, setInputGuardError] = useState<string | null>(null);
  /** 提示注入等"放行但警告"的提示（区别于阻断性错误） */
  const [guardWarning, setGuardWarning] = useState<string | null>(null);
  /** 用户是否已向上滚离底部（驱动「回到最新诊断」胶囊显隐） */
  const [isAwayFromBottom, setIsAwayFromBottom] = useState<boolean>(false);
  /**
   * 底部「快捷指令」折叠入口的展开状态。
   *
   * 【默认折叠】已有对话时，快捷指令只是"偶尔想用"的辅助入口，
   * 默认收起以把高度全部让给消息流；空状态则由 2×2 卡片承担，
   * 根本不渲染这个入口（见输入区 JSX）。
   */
  const [isQuickPromptsOpen, setQuickPromptsOpen] = useState<boolean>(false);

  /* ---- Refs ---- */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 骨架屏看门狗定时器（toolCallId → timer）。
   *
   * 【解决什么】服务端保证 start/result 配对，但网络中断、代理截断、
   * 服务端异常退出都可能让某张卡收不到 result。旧实现只在"整条流结束"时
   * 兜底清理——若流一直不结束（长连接挂住），骨架屏就永久转圈。
   * 现在每张骨架屏独立计时 8 秒：超时即转"生成失败，点击重试"。
   */
  const skeletonWatchdogRef = useRef<Map<string, number>>(new Map());

  /**
   * 排队中的 prompt（A5）。
   *
   * 【解决什么】流式期间用户点"快照诊断"等操作会调用 sendMessage，
   * 旧实现直接 return——请求被静默丢弃，用户以为点了没反应。
   * 现在记下来，当前流结束后自动发送，并给出"已排队"提示。
   */
  const queuedPromptRef = useRef<string | null>(null);
  /**
   * sendMessage 的最新引用（A5 排队重发用）。
   *
   * 【为什么用 ref】finalize 在流结束的闭包里执行，此时直接递归调用
   * sendMessage 会命中旧的闭包（messages 为空），排队的请求会丢上下文。
   * 用 ref 指向最新一次渲染的 sendMessage 实例，保证重发用的是最新状态。
   */
  const sendMessageRef = useRef<((prompt: string) => void) | null>(null);
  const [queuedPromptNotice, setQueuedPromptNotice] = useState<string | null>(null);

  /**
   * TTS 播报请求（A6）。
   *
   * 【解决什么】旧实现把 speakMessage 写在 setMessages 的 updater 里，
   * React StrictMode 会双调用 updater，导致同一段文本播两遍。
   * 现在 updater 保持纯函数，播报请求走 ref + state，由 effect 执行。
   */
  const [speechRequest, setSpeechRequest] = useState<{ readonly messageId: string; readonly nonce: number } | null>(null);

  /**
   * 卸载清理：清空所有骨架屏看门狗。
   *
   * 【为什么必须做】StrictMode 开发模式下组件会"挂载 → 卸载 → 再挂载"，
   * 若首次挂载创建的 8 秒定时器不在卸载时清除，它们会在第二次挂载后
   * 对着已失效的闭包执行 patchMessage —— 表现为无谓的状态更新与定时器累积。
   * 这是 StrictMode 审计（docs/strictmode-audit.md）要求"卸载后零回调"的一部分。
   */
  useEffect((): (() => void) => {
    const watchdogs = skeletonWatchdogRef.current;
    return (): void => {
      for (const timer of watchdogs.values()) {
        window.clearTimeout(timer);
      }
      watchdogs.clear();
    };
  }, []);
  /** 是否应贴底滚动（用户手动上滑查看历史时置 false） */
  const stickToBottomRef = useRef<boolean>(true);

  /*
   * ===== A 项：Copilot 活动状态写入器 =====
   *
   * 【为什么用细粒度选择器而非解构整个 store】本组件是流式渲染热点
   * （每帧可能多次更新），订阅整棵 store 会让任何无关字段变化都触发重渲染。
   * 这三个 setter 引用恒定，订阅成本为零。
   *
   * 【写入位置纪律】只在流事件回调（开始 / 结束 / 出错 / abort）里写，
   * 绝不写在 render 或 setMessages 的 updater 内——StrictMode 下 updater
   * 会执行两次，放在里面会导致重复副作用。
   */
  const setCopilotStreaming = useClusterStore(
    (s): ((v: boolean) => void) => s.setCopilotStreaming,
  );
  const setLastAssistantMessageId = useClusterStore(
    (s): ((v: string | null) => void) => s.setLastAssistantMessageId,
  );
  const copilotAbortToken = useClusterStore((s): number => s.copilotAbortToken);

  /**
   * 上一次观察到的中止计数。
   *
   * 【为什么需要】effect 首次挂载也会执行一次，若不加比较就会把初始值
   * 当作一次中止请求，导致刚打开抽屉就把流掐断。
   */
  const lastAbortTokenRef = useRef<number>(copilotAbortToken);

  /**
   * D 项：观察到中止请求时切断当前流。
   *
   * 【为何由 store 计数驱动而非直接调用】导演引擎在 utils 层，不能反向
   * import React 组件；用计数当信号源，Copilot 侧自行观察，职责单向。
   */
  useEffect((): void => {
    if (copilotAbortToken === lastAbortTokenRef.current) return;
    lastAbortTokenRef.current = copilotAbortToken;

    abortRef.current?.abort();
    abortRef.current = null;
    /*
     * 中止后必须把活动状态复位，否则阶段 3→4 的事件门会一直等
     * copilotStreaming === false 而永远不推进。
     */
    setCopilotStreaming(false);
  }, [copilotAbortToken, setCopilotStreaming]);

  /* ========================================================================== */
  /* 滚动跟随                                                                   */
  /* ========================================================================== */

  /** scrollToBottom —— 仅在用户仍贴底时跟随，避免打断历史阅读 */
  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  /**
   * onScroll —— 记录用户是否仍在底部附近。
   *
   * 【双写：ref + state】ref 供 useFrame 级别的高频判断（不受重渲染影响），
   * state 用于驱动「↓ 回到最新诊断」胶囊的显隐——这是低频 UI 变化，
   * 用 React 状态是合适的；两者同步写入保证判断与显示永远一致。
   */
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance < STICKY_SCROLL_THRESHOLD_PX;
    stickToBottomRef.current = nearBottom;
    setIsAwayFromBottom(!nearBottom);
  }, []);

  /**
   * jumpToLatest —— 回到底部并恢复自动跟随。
   *
   * 【为何要显式恢复 stickToBottomRef】用户点胶囊的意图明确是"我要看最新的"，
   * 若只滚动一次而不恢复跟随标记，下一帧新消息到达时又会被判定为"用户在看历史"
   * 而停止跟随——那胶囊等于白点。
   */
  const jumpToLatest = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    stickToBottomRef.current = true;
    setIsAwayFromBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  /* 消息变化后跟随滚动（流式追加时持续贴底） */
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  /* ========================================================================== */
  /**
   * C3：探测浏览器原生语音识别能力（仅客户端执行，避免 hydration 不一致）。
   */
  useEffect((): void => {
    const candidate = window as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    setSpeechAsrSupported(
      candidate.SpeechRecognition !== undefined || candidate.webkitSpeechRecognition !== undefined,
    );
  }, []);

  /* 语音播报（TTS）—— 全场景自动播报 + 单条消息朗读                            */
  /* ========================================================================== */

  /**
   * 【改造要点】旧的 speakAlert 只播报根因卡，且不指定音色——这正是
   * "点了喇叭不响"与"单条消息无法朗读"两个症状的直接来源。
   * 现在统一交给 useSpeechSynthesis：中文音色优选、Markdown 净化、
   * 状态机可见（准备中/朗读中/不支持），三种"不响"的原因都能被界面表达。
   */
  const {
    playbackState: ttsPlaybackState,
    voiceInfo,
    speakingMessageId,
    isSupported: ttsSupported,
    speak,
    stop: stopSpeaking,
  } = useSpeechSynthesis();

  /**
   * speakMessage —— 朗读指定 AI 消息。
   *
   * 【抽取正文的策略】优先用消息正文（那是 AI 的主要输出），
   * 若正文为空则退到根因卡摘要——某些轮次模型只调工具不写正文。
   * 两者都没有时用一句兜底提示，保证「点了要有反应」。
   *
   * @param message 目标 AI 消息
   */
  const speakMessage = useCallback(
    (message: CopilotMessage): void => {
      const rootCauseCard = message.toolCards.find(
        (card): boolean =>
          card.state === 'ready' &&
          isRootCauseTool(card.toolName) &&
          card.args !== undefined,
      );
      const rootCauseProps =
        rootCauseCard?.args !== undefined ? (rootCauseCard.args as RootCauseAlertProps) : null;

      const primary = message.text.trim();
      const fallback =
        rootCauseProps !== null
          ? `${rootCauseProps.severity} 级故障。${rootCauseProps.title}。${rootCauseProps.rootCauseSummary}`
          : '本轮已完成诊断，详情见屏幕上的卡片。';

      speak(primary.length > 0 ? primary : fallback, message.id);
    },
    [speak],
  );

  /**
   * A6：TTS 播报 effect —— 播报副作用移出 setMessages updater。
   *
   * 【StrictMode 双播根因】旧实现把 speakMessage 写在 setMessages 的
   * updater 函数里。React 在开发模式会**双调用** updater 以检测副作用，
   * 于是同一段文本播两遍；生产模式虽不双调，但 updater 里做副作用本身
   * 就是错误用法（可能在渲染阶段被丢弃/重放）。
   *
   * 现在 updater 保持纯函数，finalize 只设置 speechRequest；本 effect
   * 在 messages 提交后读取最新消息并播报，天然只执行一次。
   */
  useEffect((): void => {
    if (speechRequest === null) return;
    const latest = messages.find((m): boolean => m.id === speechRequest.messageId);
    if (latest !== undefined && !latest.isStreaming && latest.text.trim().length > 0) {
      speakMessage(latest);
    }
    setSpeechRequest(null);
  }, [speechRequest, messages, speakMessage]);

  /**
   * toggleMessageSpeaking —— 单条消息的朗读/停止切换。
   *
   * 【为何以 speakingMessageId 为判据而非全局状态】用户可能正在听消息 A，
   * 此时点消息 B 的喇叭应当**切到 B**（而不是把 A 停掉后什么都不播）。
   * 因此判断条件是"这条消息是否正在朗读"。
   */
  const toggleMessageSpeaking = useCallback(
    (message: CopilotMessage): void => {
      if (speakingMessageId === message.id) {
        stopSpeaking();
        return;
      }
      speakMessage(message);
    },
    [speakMessage, speakingMessageId, stopSpeaking],
  );

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
    setPostMortemOpen(true);
  }, [buildClusterContext, messages]);

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
       * 【A5 自愈：流式期间不丢弃请求，改为排队】
       * 旧实现 `if (isStreaming) return` 会让"快照诊断/主动诊断"在
       * AI 正在回答时被静默吞掉——用户点了按钮，什么也没发生。
       * 现在记入队列并在当前流结束后自动发送，同时明确提示"已排队"。
       */
      if (isStreaming) {
        queuedPromptRef.current = text;
        setQueuedPromptNotice('已排队：当前回答结束后自动发送本次请求');
        return;
      }

      /* ---- 输入安全校验（发送前拦截，防注入/超长/空内容） ---- */
      const guard = validatePrompt(text);
      if (!guard.ok) {
        setInputGuardError(guard.reason);
        return;
      }
      setInputGuardError(null);
      /**
       * 【注入警告的落地】validatePrompt 对疑似提示注入**放行但警告**。
       * 此前只返回了 warning 却没有任何地方渲染它——那等于警告根本没发生。
       * 这里把它写进 guardWarning 状态并在输入区上方常驻显示，
       * 保证用户确实看到「系统识别到了可疑表述」。
       */
      setGuardWarning(guard.warning ?? null);

      /* ---- 中断上一条未完成的流 ---- */
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      /* ---- 取出待发送的视口快照，并立即清空待发预览 ---- */
      const viewportForSend = capturedViewportDataUrl;
      if (viewportForSend !== null) {
        setCapturedViewport(null);
      }

      /* R46：无 Key 也能真看图 —— 端侧计算像素特征（无截图则跳过） */
      const pixelFeatures =
        viewportForSend === null ? null : await computeViewportPixelFeatures(viewportForSend);

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

      /* 历史消息（供服务端理解上下文，取最近 8 条避免载荷膨胀） */
      const history = [...messages, userMessage]
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

      /**
       * finalize —— 流收尾函数（在 try 内赋值，供 catch/finally 共用）。
       *
       * 【为什么提升到 try 之外】A3 要求 abort 与正常结束统一收尾，
       * 而 catch/finally 在 try 块的作用域之外，看不到块内 const。
       * 这里先占位，进入流读取后赋值为真正的实现。
       */
      let finalize: () => void = (): void => {};

      try {
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
            /*
             * 【自定义语料随请求上送】
             *
             * 自定义 Runbook 存在浏览器 localStorage，服务端读不到。
             * 每次发消息时把当前语料一起带上，才能保证
             * "评委刚在弹窗里新增的条目，下一条提问立刻可被检索"。
             *
             * 【为何每次现读而不缓存】getCustomRunbooks() 是同步读取
             * localStorage 并做形状校验，开销在微秒级；而缓存会引入
             * "弹窗新增后缓存未失效"的一致性 bug。此处宁可直接读。
             */
            ...(getCustomRunbooks().length > 0
              ? { customRunbooks: getCustomRunbooks() }
              : {}),
            ...(queryEmbedding !== null ? { queryEmbedding } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok || response.body === null) {
          throw new Error(`服务端返回 ${response.status}`);
        }

        /* ---- 3. NDJSON 逐行解析 ---- */
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        /**
         * clearAllSkeletonWatchdogs —— 清空所有骨架屏看门狗。
         *
         * 【必须清】流结束/中断后若定时器还在跑，8 秒后会对已经结束的消息
         * 再 patch 一次（无用状态更新），且 StrictMode 下可能重复。
         */
        const clearAllSkeletonWatchdogs = (): void => {
          for (const timer of skeletonWatchdogRef.current.values()) {
            window.clearTimeout(timer);
          }
          skeletonWatchdogRef.current.clear();
        };

        /**
         * finalize —— 流收尾唯一入口（正常结束 / 异常 / abort 三条路径共用）。
         *
         * 【A3 自愈】旧实现只在正常结束分支把消息级 isStreaming 置 false；
         * abort 分支什么都不做，于是"停止生成"后打字光标不消失、
         * 朗读按钮也不出现（它依赖 !isStreaming）。现在三条路径统一收尾。
         *
         * 【幂等】catch 与 finally 都会调用，用 finalized 标记保证只执行一次。
         */
        let finalized = false;
        finalize = (): void => {
          if (finalized) return;
          finalized = true;

          clearAllSkeletonWatchdogs();

          /* 消息级状态复位 + 骨架屏兜底（服务端未及补发 result 时） */
          patchMessage(assistantId, (m): CopilotMessage => {
            const hasOrphan = m.toolCards.some((card): boolean => card.state === 'skeleton');
            return {
              ...m,
              isStreaming: false,
              ...(hasOrphan
                ? {
                    toolCards: m.toolCards.map((card): CopilotToolCard =>
                      card.state === 'skeleton'
                        ? { ...card, state: 'error', errorMessage: '流已结束但未收到该卡片的渲染结果' }
                        : card,
                    ),
                  }
                : {}),
            };
          });

          setIsStreaming(false);
          abortRef.current = null;
          setCopilotStreaming(false);

          /*
           * ---- A5：排队请求自动发送 ----
           * 先清提示再发送；真正发送放到下一帧，确保本次状态已提交。
           */
          const queued = queuedPromptRef.current;
          if (queued !== null) {
            queuedPromptRef.current = null;
            setQueuedPromptNotice(null);
            window.setTimeout((): void => {
              sendMessageRef.current?.(queued);
            }, 0);
          }

          /*
           * ---- A6：TTS 播报请求 ----
           * 这里只发"请求"，真正播报由 effect 在 messages 提交后执行。
           * 绝不把 speakMessage 写进 setMessages 的 updater（StrictMode 双播）。
           */
          if (ttsEnabled) {
            setSpeechRequest({ messageId: assistantId, nonce: Date.now() });
          }
        };

        let buffer = '';

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          /* 按 '\n' 切分；剩余不完整的半行留在 buffer 中等待下一 chunk */
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf('\n');
            if (line.length === 0) continue;

            let event: ChatStreamEvent;
            try {
              event = JSON.parse(line) as ChatStreamEvent;
            } catch {
              continue; /* 损坏行跳过，不中断整条流 */
            }

            /* ---- 4. 事件分派 ---- */
            switch (event.type) {
              case 'reasoning': {
                patchMessage(assistantId, (m): CopilotMessage => ({
                  ...m,
                  reasoningSteps: [...m.reasoningSteps, event.step],
                }));
                break;
              }

              case 'text': {
                patchMessage(assistantId, (m): CopilotMessage => ({
                  ...m,
                  text: m.text + event.content,
                }));
                break;
              }

              case 'tool-start': {
                /*
                 * 【A1 自愈：按 toolCallId 去重】
                 * 回落引擎可能重发同一张卡（旧服务端行为），或代理重放同一帧。
                 * 同 id 只挂一次，杜绝"两张指标卡"。
                 */
                const card: CopilotToolCard = {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  mcpUri: event.mcpUri,
                  state: 'skeleton',
                };
                patchMessage(assistantId, (m): CopilotMessage => {
                  if (m.toolCards.some((c): boolean => c.toolCallId === event.toolCallId)) return m;
                  return { ...m, toolCards: [...m.toolCards, card] };
                });

                /*
                 * 【A2 自愈：骨架屏 8 秒看门狗】
                 * 服务端保证 start/result 配对，但网络中断/代理截断仍可能丢 result。
                 * 旧实现只在"整条流结束"时兜底——流若挂住，卡片永久转圈。
                 * 现在每张骨架独立计时：超时即转失败态，用户可点重试。
                 */
                const watchdogTimer = window.setTimeout((): void => {
                  skeletonWatchdogRef.current.delete(event.toolCallId);
                  patchMessage(assistantId, (m): CopilotMessage => ({
                    ...m,
                    toolCards: m.toolCards.map((c): CopilotToolCard =>
                      c.toolCallId === event.toolCallId && c.state === 'skeleton'
                        ? { ...c, state: 'error', errorMessage: '超过 8 秒未收到渲染结果，已终止等待' }
                        : c,
                    ),
                  }));
                }, SKELETON_WATCHDOG_MS);
                skeletonWatchdogRef.current.set(event.toolCallId, watchdogTimer);
                break;
              }

              case 'tool-result': {
                /* 收到结果即撤销该卡的看门狗 */
                const pendingTimer = skeletonWatchdogRef.current.get(event.toolCallId);
                if (pendingTimer !== undefined) {
                  window.clearTimeout(pendingTimer);
                  skeletonWatchdogRef.current.delete(event.toolCallId);
                }

                const failed = event.status === 'error';
                patchMessage(assistantId, (m): CopilotMessage => {
                  const exists = m.toolCards.some((c): boolean => c.toolCallId === event.toolCallId);
                  /* 重复 result（旧服务端/重放）：已有 ready 卡片则忽略 */
                  const alreadyReady = m.toolCards.some(
                    (c): boolean => c.toolCallId === event.toolCallId && c.state === 'ready',
                  );
                  if (alreadyReady) return m;

                  if (!exists) {
                    /* 孤儿 result：补一张卡（而非丢弃，避免用户永远等不到） */
                    const created: CopilotToolCard =
                      failed || event.args === null
                        ? {
                            toolCallId: event.toolCallId,
                            toolName: event.toolName,
                            mcpUri: `mcp://k8s-cluster/tools/${event.toolName}`,
                            state: 'error',
                            errorMessage: event.errorMessage ?? '工具调用失败',
                          }
                        : {
                            toolCallId: event.toolCallId,
                            toolName: event.toolName,
                            mcpUri: `mcp://k8s-cluster/tools/${event.toolName}`,
                            state: 'ready',
                            args: event.args,
                            synthesized: event.synthesized === true,
                          };
                    return { ...m, toolCards: [...m.toolCards, created] };
                  }

                  return {
                    ...m,
                    toolCards: m.toolCards.map((c): CopilotToolCard => {
                      if (c.toolCallId !== event.toolCallId) return c;
                      if (failed || event.args === null) {
                        return { ...c, state: 'error', errorMessage: event.errorMessage ?? '工具调用失败' };
                      }
                      return {
                        ...c,
                        state: 'ready',
                        args: event.args,
                        synthesized: event.synthesized === true,
                      };
                    }),
                  };
                });
                break;
              }

              case 'engine': {
                patchMessage(assistantId, (m): CopilotMessage => ({
                  ...m,
                  engine: event.engine,
                }));
                break;
              }

              case 'error': {
                /* A9：结构化错误 → 分类文案 + requestId + 可重试标记 */
                patchMessage(assistantId, (m): CopilotMessage => ({
                  ...m,
                  failed: true,
                  failedPrompt: text,
                  errorCategory: event.category,
                  requestId: event.requestId,
                }));
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

              case 'done': {
                /* 终止事件由循环结束后的 finalize 统一处理，这里无需动作 */
                break;
              }

              default:
                /* 未知事件类型：向前兼容，直接忽略（协议扩展不影响旧前端） */
                break;
            }
          }
        }

        /* 流正常结束（done 事件或连接关闭）→ 统一收尾 */
        finalize();
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (!aborted) {
          /**
           * 【错误降级契约】中断时不留下一条半截的"正在输入"气泡，
           * 而是写入可读的错误说明并把原 prompt 记下来供重试。
           * 空正文 → 直接给错误文案；已有部分正文 → 保留正文并追加错误尾注
           * （用户已读到的内容不该被抹掉）。
           */
          const reason = error instanceof Error ? error.message : '未知错误';
          patchMessage(assistantId, (m): CopilotMessage => ({
            ...m,
            text:
              m.text.length > 0
                ? `${m.text}\n\n> [WARN] 诊断流意外中断：${reason}`
                : `> [ERR] 诊断请求失败：${reason}`,
            failed: true,
            failedPrompt: text,
            errorCategory: 'network',
          }));
        }
        /*
         * 【A3 自愈：abort 与正常结束统一走 finalize】
         * 旧实现 abort 分支什么都不做，消息级 isStreaming 永远为 true，
         * 表现为"停止生成后还显示打字光标、朗读按钮不出现"。
         * 现在两条路径汇聚到同一个收尾函数，内容保留、状态复位。
         */
        finalize();
      } finally {
        /* 兜底：任何异常路径都在这里收尾一次（finalize 幂等） */
        finalize();
      }    },
    [buildClusterContext, capturedViewportDataUrl, isStreaming, messages, patchMessage, setCapturedViewport,
      setCopilotStreaming,
      setLastAssistantMessageId,
      ttsEnabled],
  );

  /* 排队请求重发用：始终指向最新一次渲染的 sendMessage 闭包 */
  sendMessageRef.current = (prompt: string): void => {
    void sendMessage(prompt);
  };

  /**
   * retryLastRequest —— 一键重试上一次失败的请求。
   *
   * 【实现方式】移除失败的 AI 消息气泡（避免对话流里堆积无效残片），
   * 然后用同一 prompt 重新调用 sendMessage。用户消息保留（它确实发出去过）。
   */
  const retryLastRequest = useCallback(
    (failedMessageId: string, prompt: string): void => {
      setMessages((prev) => prev.filter((m): boolean => m.id !== failedMessageId));
      /* 下一帧再发，确保上一条已从数组移除（sendMessage 读的是闭包里的 messages） */
      window.setTimeout((): void => {
        void sendMessage(prompt);
      }, 0);
    },
    [sendMessage],
  );

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
   * 消费外部快捷指令（如 3D 画布工具条的"快照诊断"经 triggerQuickPrompt 写入）。
   * 读取后立即清空 store 载荷，防止重复触发。
   */
  useEffect(() => {
    if (quickPromptTrigger === null) return;
    const prompt = quickPromptTrigger;
    clearQuickPrompt();
    void sendMessage(prompt);
  }, [quickPromptTrigger, clearQuickPrompt, sendMessage]);

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
   * 【为何需要 preserveDrawingBuffer】three 的 WebGLRenderer 默认在每帧
   * 渲染后清空 drawing buffer，此时 canvas.toDataURL() 会得到一张全黑图。
   * 但本项目画布未开启 preserveDrawingBuffer（会损失性能），因此必须在
   * **同一帧内**请求渲染后再立刻读像素。这里采用 requestAnimationFrame
   * 后置读取：多数驱动的实现中，rAF 回调执行时上一帧内容仍可读。
   * 若得到全黑图，属浏览器实现差异，用户可重试。
   */
  const captureViewport = useCallback((): void => {
    const canvas = document.querySelector('canvas');
    if (canvas === null) return;
    try {
      const dataUrl = canvas.toDataURL('image/jpeg', CAPTURE_QUALITY);
      setCapturedViewport(dataUrl);
    } catch {
      /* 跨域/安全上下文限制导致污染画布：静默失败 */
    }
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
    setMessages([]);
    setIsStreaming(false);
    /* 清空会话时同时停掉播报与拾音，避免没有内容时声音/录音还在跑 */
    stopSpeaking();
    speechInput.abort();
  }, [speechInput, stopSpeaking]);

  /**
   * handleStopGeneration —— 停止当前流式生成，但**保留已产出的内容**。
   *
   * 【为何与 clearSession 分开】两者语义完全不同：
   * - clearSession = 销毁整段对话历史（用户想重新开始）；
   * - handleStopGeneration = 中途刹车（用户觉得答案太啰嗦/跑偏了）。
   *
   * 此前只有前者，用户为了停一段长回复被迫删掉全部历史——这是把
   * "停止"和"销毁"混为一谈。这里 abort 后仅把 isStreaming 置回 false，
   * 已渲染的正文与卡片原样留在屏幕上。
   *
   * 【兜底】abort 后 sendMessage 的 catch 会收到 AbortError 并跳过错误处理，
   * 因此这里只需确保 UI 状态复位；同时终止语音播报避免念到一半。
   */
  const handleStopGeneration = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

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
      { key: 'copilot', label: 'AI 运维副驾', sub: 'SRE Copilot', icon: Bot },
      { key: 'auditor', label: '端侧日志审计', sub: 'Edge Log Auditor (WASM)', icon: ShieldCheck },
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
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={(): void => setActiveRightTab(tab.key)}
              className={cn(
                'relative flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 transition-colors',
                active ? 'text-cyan-300' : 'text-slate-500 hover:text-slate-300',
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
                  transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                  className="absolute inset-x-1 bottom-0 h-px bg-cyan-400/90"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* ============ 正文区：按 Tab 切换 ============ */}
      {activeRightTab === 'auditor' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <LocalAuditorPanel />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
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
              onClick={(): void => setRagModalOpen(true)}
              aria-label="打开 SRE 领域知识库"
              title="SRE 领域知识库：浏览语料、实时检索沙盒、现场新增 Runbook"
              className="flex shrink-0 items-center gap-1 rounded border border-cyan-400/25 bg-cyan-400/[0.07] px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide text-cyan-300 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/[0.15]"
            >
              <BookOpen className="h-2.5 w-2.5" aria-hidden />
              RAG 知识库
              <span className="rounded-sm bg-cyan-400/20 px-1 text-[10px] tabular-nums text-cyan-200">
                12+
              </span>
            </button>

            {/*
             * ---- 导出 SRE 复盘报告 ----
             *
             * 【为何在这里而不是每条消息下】复盘是**会话级**产物：
             * 它要汇总整条时间线、所有推理步骤、全部卡片与知识库引用。
             * 挂在单条消息下会让用户误以为只导出那一轮的内容。
             *
             * 【为何要有卡片才显示】没有任何卡片说明这一轮没产生可复盘的
             * 排障证据，导出的报告只有空章节——与其让用户下载一份无内容
             * 的文件，不如在源头上就不提供入口。
             */}
            {hasReplayableContent ? (
              <button
                type="button"
                onClick={handleExportPostMortem}
                aria-label="导出 SRE 故障复盘报告"
                title="基于本次会话的时间线、推理链、RAG 引用与自愈动作生成复盘报告"
                className="flex shrink-0 items-center gap-1 rounded border border-emerald-400/25 bg-emerald-400/[0.07] px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide text-emerald-300 transition-colors hover:border-emerald-300/60 hover:bg-emerald-400/[0.15]"
              >
                <FileText className="h-2.5 w-2.5" aria-hidden />
                复盘报告
              </button>
            ) : null}

            {/* TTS 开关（图标按钮自身的选中态即状态，无需额外文字说明） */}
            <button
              type="button"
              onClick={(): void => {
                /**
                 * 【开启喇叭立即朗读最新回复】
                 *
                 * 旧实现只切换布尔值，用户点开喇叭后界面毫无动静——
                 * 必须等到下一轮回答才会有声音，观感上就是"按钮没反应"。
                 *
                 * 现在开启时立即朗读最新一条 AI 回复（若有），
                 * 关闭时立即停止正在播放的语音。这符合用户对开关的直觉预期：
                 * 打开就该有声音，关闭就该安静。
                 */
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
                      /* 下一帧再播：此时 ttsEnabled 尚未提交，
                         但 speak 不依赖它（开关只控制自动播报的触发条件） */
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
                'shrink-0 rounded p-1 transition-colors',
                ttsEnabled
                  ? ttsPlaybackState === 'speaking'
                    ? 'text-cyan-200'
                    : 'text-cyan-300 hover:text-cyan-200'
                  : 'text-slate-500 hover:text-slate-300',
              )}
            >
              {ttsEnabled ? (
                <Volume2
                  className={cn('h-3 w-3', ttsPlaybackState === 'speaking' && 'animate-pulse')}
                  aria-hidden
                />
              ) : (
                <VolumeX className="h-3 w-3" aria-hidden />
              )}
            </button>

            {/* 清空会话 */}
            <button
              type="button"
              onClick={clearSession}
              aria-label="清空会话"
              title="清空会话"
              className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:text-rose-300"
            >
              <Eraser className="h-3 w-3" aria-hidden />
            </button>
          </div>

          {/* ---- 消息流 ---- */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2 py-2"
            aria-live="polite"
            aria-label="对话消息流"
          >
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
              <div className="flex h-full flex-col items-center justify-center gap-4 px-4 py-6">
                {/* 微光徽标：单层细描边 + 柔和内发光，克制不刺眼 */}
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                  <Radar className="h-5 w-5 text-cyan-300/90" aria-hidden />
                </span>

                <div className="text-center">
                  <p className="text-[13px] font-medium tracking-tight text-slate-200">
                    KubeVision SRE 智能副驾
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                    选择一条战术指令，或直接描述你观察到的异常。
                  </p>
                </div>

                {/*
                 * 2×2 战术指令矩阵（工业风：编号 + 单色矢量图标，零 Emoji）。
                 *
                 * 卡片结构：左上 `CMD-0X` 等宽编号 + 14px 矢量图标容器，
                 * 右上 ArrowUpRight 微箭头；下方主标题 + 一行技术副标题。
                 * 流式生成中禁用（避免并发请求打架）。
                 */}
                <div className="grid w-full grid-cols-2 gap-2">
                  {QUICK_PROMPTS.map((prompt): React.ReactElement => {
                    const Icon = prompt.icon;
                    return (
                      <button
                        key={prompt.id}
                        type="button"
                        onClick={(): void => void sendMessage(prompt.text)}
                        disabled={isStreaming}
                        title={prompt.text}
                        className={cn(
                          'group relative rounded-lg border p-2.5 text-left transition-all duration-150',
                          isStreaming
                            ? 'cursor-not-allowed border-white/[0.04] bg-white/[0.01] opacity-50'
                            : 'border-white/[0.07] bg-white/[0.025] hover:border-cyan-400/40 hover:bg-white/[0.05]',
                        )}
                      >
                        {/* 顶部：编号 + 图标容器（左） / 微箭头（右） */}
                        <div className="flex items-start justify-between gap-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[10px] tracking-wider text-slate-500">
                              {prompt.id}
                            </span>
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-white/[0.07] bg-slate-900/80 text-cyan-400 transition-colors group-hover:border-cyan-400/40 group-hover:text-cyan-300">
                              <Icon className="h-3.5 w-3.5" aria-hidden />
                            </span>
                          </div>
                          <ArrowUpRight
                            className="mt-0.5 h-3 w-3 shrink-0 text-slate-500 transition-colors group-hover:text-cyan-400/80"
                            aria-hidden
                          />
                        </div>

                        {/* 主标题 */}
                        <span className="mt-2 block text-[12px] font-medium leading-snug text-slate-200">
                          {prompt.label}
                        </span>
                        {/* 技术副标题：一行，超出省略，保持卡片等高 */}
                        <span className="mt-0.5 block truncate text-[11px] leading-snug text-slate-500">
                          {prompt.subtitle}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onRetry={retryLastRequest}
                  onActionExecuted={handleActionExecuted}
                  isSpeaking={speakingMessageId === message.id}
                  onToggleSpeak={toggleMessageSpeaking}
                />
              ))
            )}
          </div>

          {/*
           * 【回到最新诊断 悬浮胶囊】（审查报告 §4.3）
           *
           * 用户在流式生成或阅读长报告时向上滚动后，auto-scroll 会让位
           * （stickToBottomRef=false），此时新内容在下方持续产出但看不到。
           * 这枚胶囊给出明确的"有新内容、点我回去"提示，
           * 比让用户自己滚到底更符合对话产品的直觉。
           *
           * 用 AnimatePresence 做进出场，避免突然闪现/消失。
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
                className="absolute bottom-[104px] left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-cyan-500/50 bg-slate-900/90 px-2.5 py-1 font-mono text-[11px] font-semibold text-cyan-300 shadow-glow-cyan kv-blur-panel transition-colors hover:border-cyan-400 hover:bg-slate-800/90 active:scale-95"
              >
                <ChevronDown className="h-3 w-3" aria-hidden />
                回到最新诊断
              </motion.button>
            ) : null}
          </AnimatePresence>

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
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
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
                      <span className="font-mono text-[10px] tracking-wider text-cyan-400/70">
                        上下文
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold tracking-wide text-cyan-100">
                        {selectedContextLabel}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-cyan-400/50">
                        auto
                      </span>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <AnimatePresence>
                {capturedViewportDataUrl !== null ? (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mb-2 overflow-hidden"
                  >
                    <div className="flex items-center gap-2 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.05] p-1">
                      {/*
                       * 【缩略图卡】带青色扫描边框 + 悬停放大。
                       *
                       * - 扫描边框：外框青色描边 + 内部一条 animate-scan-line
                       *   的细光带循环掠过，暗示"这是一份正在被解读的影像"；
                       * - 悬停放大：group-hover 时浮出一张 3 倍大的预览（绝对定位、
                       *   不改变布局），让用户确认自己截到的画面是否正确——
                       *   h-9 w-14 的缩略图根本看不清拓扑细节。
                       */}
                      <div className="group/thumb relative shrink-0">
                        <div className="relative overflow-hidden rounded border border-cyan-400/40">
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
                        </div>
                        {/* 悬停放大预览：绝对定位，向上浮出，不挤动任何布局 */}
                        <div className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 hidden w-72 overflow-hidden rounded-lg border border-cyan-400/[0.45] bg-slate-950/95 p-1 shadow-[0_12px_36px_rgba(2,6,23,0.9)] group-hover/thumb:block">
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
                        <span className="ml-1 text-slate-500">· 随消息发送</span>
                      </p>
                      <button
                        type="button"
                        onClick={(): void => setCapturedViewport(null)}
                        aria-label="移除快照"
                        title="移除快照"
                        className="shrink-0 rounded p-0.5 text-slate-500 transition-colors hover:text-rose-400"
                      >
                        <X className="h-3 w-3" aria-hidden />
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
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
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
                            <span className="text-slate-500">{prompt.code}</span>
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
                  /* Enter 发送，Shift+Enter 换行 */
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void sendMessage(inputValue);
                  }
                }}
                rows={2}
                placeholder="描述故障现象，或直接提问…（Enter 发送 / Shift+Enter 换行）"
                aria-label="对话输入框"
                className="w-full resize-none bg-transparent px-1 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
              />

              {/* ---- C3：语音能力说明（原生 Web Speech / 无需 URL 或 Key） ---- */}
              <p
                className="mt-1 font-mono text-[10px] leading-relaxed text-slate-500"
                aria-label="语音能力说明"
              >
                语音输入 / 播报使用<b className="text-slate-400">浏览器原生 Web Speech / SpeechSynthesis</b>
                ，无需配置任何 URL 或 API Key。
                {speechAsrSupported ? null : (
                  <span className="text-amber-400/90"> 当前浏览器不支持语音识别：请改用 Chrome / Edge，或直接键盘输入。</span>
                )}
              </p>

              {/* ---- 底部内嵌工具栏 ---- */}
              <div className="mt-1 flex items-center gap-1">
                {/* 截取 3D 视口 */}
                <button
                  type="button"
                  onClick={captureViewport}
                  aria-label="捕获当前 3D 视图"
                  title="截取当前 3D 视口快照，作为多模态输入"
                  className="flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] tracking-tight text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-cyan-300"
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
                    'relative flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] tracking-tight transition-colors',
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
                      className="rounded border border-amber-400/50 px-1 text-[10px] font-bold uppercase tracking-wider hover:bg-amber-500/20"
                      aria-label="重试语音输入"
                    >
                      重试
                    </button>
                  </span>
                ) : null}

                {/*
                 * 【战术指令开关 —— 仅对话态提供】
                 *
                 * 空状态时画面中央已有 2×2 战术矩阵，底部再放同一个入口就是
                 * **同一批指令出现两次**，纯属冗余。因此本按钮只在
                 * messages.length > 0（已进入对话）时渲染，
                 * 点击后在输入框上方展开一条极简工业风指令条。
                 */}
                {messages.length > 0 ? (
                  <button
                    type="button"
                    onClick={(): void => setQuickPromptsOpen((prev): boolean => !prev)}
                    aria-expanded={isQuickPromptsOpen}
                    aria-label={isQuickPromptsOpen ? '收起战术指令' : '展开战术指令'}
                    title="战术指令（Tactical Commands）"
                    className={cn(
                      'flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] tracking-tight transition-colors',
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

                {/*
                 * 【发送 / 停止生成 双态按钮】（审查报告 §4.3）
                 *
                 * 此前流式期间发送按钮只是变成禁用的旋转菊花——用户想中断
                 * 一段啰嗦的长回复，唯一出路是点「清空会话」把历史全删光。
                 * 这是把"停止"与"销毁"混为一谈的产品缺陷。
                 *
                 * 现在流式中切换为高辨识度的玫瑰红停止按钮，
                 * 点击调用 abortRef.abort()：已生成的内容保留，流优雅收尾。
                 */}
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={handleStopGeneration}
                    aria-label="停止生成"
                    title="停止生成（保留已生成内容）"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-rose-500/50 bg-rose-500/[0.15] px-2 py-1 font-mono text-[10px] font-semibold text-rose-300 transition-colors hover:bg-rose-500/25 active:scale-95"
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
                      'flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] font-semibold transition-colors',
                      canSend
                        ? 'border-cyan-400/50 bg-cyan-400/[0.15] text-cyan-300 shadow-glow-cyan hover:bg-cyan-400/25'
                        : 'cursor-not-allowed border-white/[0.06] bg-white/[0.02] text-slate-500',
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
      <RagKnowledgeModal open={ragModalOpen} onClose={(): void => setRagModalOpen(false)} />

      {/*
       * ---- SRE 故障复盘报告预览与导出 ----
       *
       * 与知识库弹窗同级挂载，同样经 createPortal 渲染到 body，
       * 因此 z-50 的全屏覆盖不会受抽屉容器的 transform 影响。
       */}
      <PostMortemModal
        open={postMortemOpen}
        onClose={(): void => setPostMortemOpen(false)}
        markdown={postMortemMarkdown}
        filename={postMortemFilename}
      />
    </div>
  );
}