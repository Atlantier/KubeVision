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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import dynamic from 'next/dynamic';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  Camera,
  Eraser,
  Loader2,
  Mic,
  MicOff,
  Send,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

import ActionConfirm from '@/components/ai/GenUI/ActionConfirm';
import AgentThoughtChain from '@/components/ai/GenUI/AgentThoughtChain';
import GenUISkeleton from '@/components/ai/GenUI/GenUISkeleton';
import PodMetricsCard from '@/components/ai/GenUI/PodMetricsCard';
import RootCauseAlert from '@/components/ai/GenUI/RootCauseAlert';
import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import type {
  ActionConfirmProps,
  ChatStreamEvent,
  ClusterContext,
  CopilotMessage,
  CopilotToolCard,
  PodMetricsCardProps,
  RootCauseAlertProps,
  SpeechRecognitionLike,
  SpeechRecognitionWindow,
} from '@/types/ai';
import type { RightPanelTab, SelectedEntityType } from '@/types/store';

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
        <Sparkles className="h-5 w-5 text-cyan-400" aria-hidden />
      </span>
      <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400/70">
        loading&nbsp;edge&nbsp;auditor
      </p>
    </div>
  );
}

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 快捷指令芯片（高价值一键提问） */
const QUICK_PROMPTS: ReadonlyArray<{ readonly icon: string; readonly text: string }> = [
  { icon: '🩺', text: '全面巡检当前集群异常' },
  { icon: '💥', text: '诊断 OOMKilled 根因并生成自愈方案' },
  { icon: '⚖️', text: '结合 3D 视图分析节点负载均衡度' },
  { icon: '🌐', text: '评估当前网络吞吐瓶颈' },
];

/** 3D 视口截图压缩质量（JPEG 0.8：清晰度与体积的平衡点） */
const CAPTURE_QUALITY = 0.8;

/** 消息列表自动滚动阈值（距底部小于此值才跟随，避免打断用户阅读历史） */
const STICKY_SCROLL_THRESHOLD_PX = 80;

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
  return name === 'renderPodMetrics' || name.includes('PodMetrics');
}
function isRootCauseTool(name: string): boolean {
  return name === 'reportRootCause' || name.includes('RootCause');
}
function isActionTool(name: string): boolean {
  return name === 'confirmAction' || name.includes('Remediation') || name.includes('Action');
}

/** 生成消息 id（时间戳 + 随机后缀，避免同毫秒碰撞） */
function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ========================================================================== */
/* 子组件：实体上下文胶囊                                                        */
/* ========================================================================== */

/**
 * ContextPill —— 当前绑定的 3D 实体上下文胶囊。
 *
 * 【语义】告诉用户「你现在问的问题会针对哪个实体」。选中态来自 store，
 * 与 3D 画布的高亮完全同步——这是对话与空间视图之间的上下文锚点。
 */
function ContextPill({
  entityId,
  entityType,
}: {
  readonly entityId: string | null;
  readonly entityType: SelectedEntityType | null;
}) {
  if (entityId === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-500">
        未绑定实体
      </span>
    );
  }

  const typeLabel = entityType === 'pod' ? 'POD' : entityType === 'node' ? 'NODE' : 'MASTER';
  const colorClass =
    entityType === 'pod'
      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
      : entityType === 'node'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
        : 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300';

  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-wider',
        colorClass,
      )}
      title={entityId}
    >
      <span className="shrink-0 font-bold">{typeLabel}</span>
      <span className="truncate opacity-90">{entityId}</span>
    </span>
  );
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
function ToolCardSlot({ card }: { readonly card: CopilotToolCard }) {
  if (card.state === 'skeleton') {
    return <GenUISkeleton toolName={card.toolName} mcpUri={card.mcpUri} />;
  }

  if (card.state === 'error' || card.args === undefined) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
        <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" aria-hidden />
        <span className="font-mono text-[9.5px] text-amber-300">
          {card.toolName} 返回的载荷无法渲染
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
        onActionExecuted={args.onActionExecuted}
      />
    );
  }

  /* 未知工具：友好降级，不崩溃 */
  return (
    <div className="rounded-md border border-slate-700 bg-slate-800/50 px-2 py-1.5 font-mono text-[9.5px] text-slate-400">
      未知工具 {card.toolName}
    </div>
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
function MessageBubble({ message }: { readonly message: CopilotMessage }) {
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
            <p className="px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-cyan-400/80">
              3d&nbsp;viewport&nbsp;sent
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

  /* ---- AI 消息：思考链 + 正文 + 卡片 ---- */
  return (
    <div className="flex flex-col gap-1.5">
      {/* 思考链（流式过程中实时追加，默认折叠） */}
      {message.reasoningSteps.length > 0 ? (
        <AgentThoughtChain steps={message.reasoningSteps} isStreaming={message.isStreaming && message.text.length === 0} />
      ) : null}

      {/* 正文 */}
      {message.text.length > 0 ? (
        <div className="rounded-lg rounded-bl-sm border border-slate-800 bg-slate-900/60 px-2.5 py-1.5">
          <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-200">
            {message.text}
            {/* 流式光标 */}
            {message.isStreaming ? (
              <span className="ml-0.5 inline-block h-3 w-1 animate-glow-pulse bg-cyan-400 align-middle" aria-hidden />
            ) : null}
          </p>
        </div>
      ) : null}

      {/* 工具卡片列表 */}
      {message.toolCards.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {message.toolCards.map((card) => (
            <ToolCardSlot key={card.toolCallId} card={card} />
          ))}
        </div>
      ) : null}

      {/* 引擎来源标注（诚实标注，仅在流结束后显示） */}
      {!message.isStreaming && message.engine !== undefined ? (
        <p className="font-mono text-[8px] uppercase tracking-wider text-slate-600">
          answered&nbsp;by&nbsp;{message.engine === 'llm' ? 'remote llm' : 'local deterministic engine'}
        </p>
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
  const quickPromptTrigger = useClusterStore((s): string | null => s.quickPromptTrigger);
  const clearQuickPrompt = useClusterStore((s): (() => void) => s.clearQuickPrompt);

  /* ---- 本地 UI 状态 ---- */
  const [messages, setMessages] = useState<readonly CopilotMessage[]>([]);
  const [inputValue, setInputValue] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(false);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [speechSupported, setSpeechSupported] = useState<boolean>(true);
  const [speechError, setSpeechError] = useState<string | null>(null);

  /* ---- Refs ---- */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** 是否应贴底滚动（用户手动上滑查看历史时置 false） */
  const stickToBottomRef = useRef<boolean>(true);

  /* ========================================================================== */
  /* 滚动跟随                                                                   */
  /* ========================================================================== */

  /** scrollToBottom —— 仅在用户仍贴底时跟随，避免打断历史阅读 */
  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  /** onScroll —— 记录用户是否仍在底部附近 */
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < STICKY_SCROLL_THRESHOLD_PX;
  }, []);

  /* 消息变化后跟随滚动（流式追加时持续贴底） */
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  /* ========================================================================== */
  /* 语音识别支持探测                                                            */
  /* ========================================================================== */

  useEffect(() => {
    const w = window as unknown as SpeechRecognitionWindow;
    setSpeechSupported(w.SpeechRecognition !== undefined || w.webkitSpeechRecognition !== undefined);
  }, []);

  /* ========================================================================== */
  /* TTS 播报                                                                   */
  /* ========================================================================== */

  /**
   * speakAlert —— 播报简短中文告警摘要。
   *
   * 【为何只播摘要而非全文】语音是"注意力提示"而非"阅读替代"：
   * 用户听到一句"检测到 P0 级故障，payment-gateway 内存溢出"
   * 就知道该回来看屏幕了；念完整篇报告只会让人排队等它念完。
   */
  const speakAlert = useCallback((title: string, severity: string): void => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(
        `检测到 ${severity} 级故障。${title}`,
      );
      utter.lang = 'zh-CN';
      utter.rate = 1.05;
      utter.pitch = 1;
      utter.volume = 1;
      window.speechSynthesis.speak(utter);
    } catch {
      /* 浏览器不支持或用户未授权：静默失败，不影响主流程 */
    }
  }, []);

  /* 关闭 TTS 时立即停止正在进行的播报 */
  useEffect(() => {
    if (!ttsEnabled && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, [ttsEnabled]);

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
      if (text.length === 0 || isStreaming) return;

      /* ---- 中断上一条未完成的流 ---- */
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      /* ---- 取出待发送的视口快照，并立即清空待发预览 ---- */
      const viewportForSend = capturedViewportDataUrl;
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

      /* 历史消息（供服务端理解上下文，取最近 8 条避免载荷膨胀） */
      const history = [...messages, userMessage]
        .slice(-8)
        .map((m): { role: 'user' | 'assistant'; content: string } => ({
          role: m.role,
          content: m.text,
        }));

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setInputValue('');
      setIsStreaming(true);
      stickToBottomRef.current = true;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: history,
            clusterContext: buildClusterContext(),
            ...(viewportForSend !== null ? { viewportImage: viewportForSend } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok || response.body === null) {
          throw new Error(`服务端返回 ${response.status}`);
        }

        /* ---- 3. NDJSON 逐行解析 ---- */
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
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
                const card: CopilotToolCard = {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  mcpUri: event.mcpUri,
                  state: 'skeleton',
                };
                patchMessage(assistantId, (m): CopilotMessage => ({
                  ...m,
                  toolCards: [...m.toolCards, card],
                }));
                break;
              }

              case 'tool-result': {
                /* 原地升级对应槽位（按 toolCallId 配对） */
                patchMessage(assistantId, (m): CopilotMessage => ({
                  ...m,
                  toolCards: m.toolCards.map((c): CopilotToolCard =>
                    c.toolCallId === event.toolCallId
                      ? { ...c, state: 'ready', args: event.args }
                      : c,
                  ),
                }));

                /* TTS：收到根因诊断结果时播报简短摘要 */
                if (ttsEnabled && isRootCauseTool(event.toolName)) {
                  const args = event.args as RootCauseAlertProps;
                  speakAlert(args.title, args.severity);
                }
                break;
              }

              case 'engine': {
                patchMessage(assistantId, (m): CopilotMessage => ({
                  ...m,
                  engine: event.engine,
                }));
                break;
              }

              default:
                break;
            }
          }
        }

        /* 流正常结束 */
        patchMessage(assistantId, (m): CopilotMessage => ({ ...m, isStreaming: false }));
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (!aborted) {
          patchMessage(assistantId, (m): CopilotMessage => ({
            ...m,
            isStreaming: false,
            text:
              m.text.length > 0
                ? m.text
                : `> ⚠️ 请求失败：${error instanceof Error ? error.message : '未知错误'}`,
          }));
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [buildClusterContext, capturedViewportDataUrl, isStreaming, messages, patchMessage, setCapturedViewport, speakAlert, ttsEnabled],
  );

  /* ========================================================================== */
  /* 快捷指令（来自外部触发 + 本地芯片）                                            */
  /* ========================================================================== */

  /**
   * 消费外部快捷指令（如 3D 画布工具条的"📸 快照诊断"经 triggerQuickPrompt 写入）。
   * 读取后立即清空 store 载荷，防止重复触发。
   */
  useEffect(() => {
    if (quickPromptTrigger === null) return;
    const prompt = quickPromptTrigger;
    clearQuickPrompt();
    void sendMessage(prompt);
  }, [quickPromptTrigger, clearQuickPrompt, sendMessage]);

  /* 组件卸载：中止在途流 + 停止语音识别 + 停止播报 */
  useEffect(() => {
    return (): void => {
      abortRef.current?.abort();
      recognitionRef.current?.abort();
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
   * toggleListening —— 切换浏览器原生语音识别。
   *
   * 【实现要点】
   * 1. 构造器可能挂在 window.SpeechRecognition 或 window.webkitSpeechRecognition；
   * 2. onresult 里只取最终结果（isFinal）追加到输入框，中间结果不写入——
   *    否则输入框会随识别过程反复抖动；
   * 3. onend 必须复位 isListening，否则识别自然结束后面板仍显示录音中。
   */
  const toggleListening = useCallback((): void => {
    /* 正在录音 → 停止 */
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const w = window as unknown as SpeechRecognitionWindow;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (Ctor === undefined) {
      setSpeechSupported(false);
      setSpeechError('当前浏览器不支持语音识别，请使用 Chrome / Edge');
      return;
    }

    try {
      const recognition = new Ctor();
      recognition.lang = 'zh-CN';
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onresult = (event): void => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) transcript += result[0].transcript;
        }
        if (transcript.length > 0) {
          setInputValue((prev): string => (prev.length > 0 ? `${prev}${transcript}` : transcript));
        }
      };

      recognition.onerror = (event): void => {
        setSpeechError(
          event.error === 'not-allowed'
            ? '麦克风权限被拒绝，请在浏览器地址栏允许后重试'
            : `语音识别出错：${event.error}`,
        );
        setIsListening(false);
      };

      recognition.onend = (): void => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      setSpeechError(null);
      recognition.start();
      setIsListening(true);
    } catch {
      setSpeechError('无法启动语音识别');
      setIsListening(false);
    }
  }, [isListening]);

  /* ========================================================================== */
  /* 清空会话                                                                   */
  /* ========================================================================== */

  const clearSession = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setIsStreaming(false);
    setSpeechError(null);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  /* ========================================================================== */
  /* 渲染                                                                       */
  /* ========================================================================== */

  const tabItems = useMemo(
    (): ReadonlyArray<{ readonly key: RightPanelTab; readonly label: string }> => [
      { key: 'copilot', label: 'AI SRE Copilot' },
      { key: 'auditor', label: 'Edge Log Auditor (WASM)' },
    ],
    [],
  );

  const canSend = inputValue.trim().length > 0 && !isStreaming;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ============ 顶部：双模态 Tab 切换器 ============ */}
      <div
        role="tablist"
        aria-label="AI 抽屉视图切换"
        className="flex h-9 shrink-0 items-stretch gap-0.5 border-b border-slate-800 bg-slate-900/40 px-1.5"
      >
        {tabItems.map((tab) => {
          const active = activeRightTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={(): void => setActiveRightTab(tab.key)}
              className={cn(
                'relative min-w-0 flex-1 truncate px-2 font-mono text-[9.5px] uppercase tracking-wider transition-colors',
                active ? 'text-cyan-300' : 'text-slate-500 hover:text-slate-300',
              )}
              title={tab.label}
            >
              {tab.label}
              {active ? (
                <motion.span
                  layoutId="copilot-drawer-tab-underline"
                  transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                  className="absolute inset-x-1 bottom-0 h-px bg-cyan-400 shadow-glow-cyan"
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
        <div className="flex min-h-0 flex-1 flex-col">
          {/* ---- 状态控制头 ---- */}
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-slate-800/70 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              {/* 在线状态呼吸灯 */}
              <span className="flex items-center gap-1" title="Copilot 在线">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                <span className="font-mono text-[8.5px] uppercase tracking-wider text-emerald-400/90">
                  online
                </span>
              </span>

              {/* 已绑定实体上下文胶囊 */}
              <span className="min-w-0 flex-1 truncate">
                <ContextPill entityId={selectedEntityId} entityType={selectedEntityType} />
              </span>

              {/* TTS 开关 */}
              <button
                type="button"
                onClick={(): void => setTtsEnabled((prev): boolean => !prev)}
                aria-pressed={ttsEnabled}
                aria-label="语音播报开关"
                title={ttsEnabled ? '关闭语音播报' : '开启语音播报'}
                className={cn(
                  'shrink-0 rounded border px-1 py-0.5 transition-colors',
                  ttsEnabled
                    ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
                    : 'border-slate-700 bg-slate-800/50 text-slate-500 hover:text-slate-300',
                )}
              >
                {ttsEnabled ? <Volume2 className="h-3 w-3" aria-hidden /> : <VolumeX className="h-3 w-3" aria-hidden />}
              </button>

              {/* 清空会话 */}
              <button
                type="button"
                onClick={clearSession}
                aria-label="清空会话"
                title="清空会话"
                className="shrink-0 rounded border border-slate-700 bg-slate-800/50 px-1 py-0.5 text-slate-500 transition-colors hover:border-rose-500/40 hover:text-rose-300"
              >
                <Eraser className="h-3 w-3" aria-hidden />
              </button>
            </div>
            <p className="font-mono text-[8px] uppercase tracking-wider text-slate-600">
              {ttsEnabled ? '🔊 tts 已开启 · 根因诊断将语音播报' : '🔇 tts 已关闭'}
            </p>
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
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <Sparkles className="h-6 w-6 text-slate-700" aria-hidden />
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-600">
                  sre copilot ready
                </p>
                <p className="text-[10px] leading-relaxed text-slate-600">
                  提问集群故障、或使用下方快捷指令开始诊断。
                  <br />
                  支持语音输入与 3D 视口快照多模态分析。
                </p>
              </div>
            ) : (
              messages.map((message) => <MessageBubble key={message.id} message={message} />)
            )}
          </div>

          {/* ---- 输入区 ---- */}
          <div className="shrink-0 border-t border-slate-800/70 px-2 py-1.5">
            {/* 视口快照预览（待发送） */}
            <AnimatePresence>
              {capturedViewportDataUrl !== null ? (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mb-1.5 overflow-hidden"
                >
                  <div className="relative inline-block overflow-hidden rounded border border-cyan-500/40 bg-slate-900/60">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={capturedViewportDataUrl}
                      alt="待发送的 3D 视口快照"
                      className="h-14 w-24 object-cover"
                    />
                    <button
                      type="button"
                      onClick={(): void => setCapturedViewport(null)}
                      aria-label="移除快照"
                      className="absolute right-0.5 top-0.5 rounded bg-slate-950/80 p-0.5 text-slate-300 transition-colors hover:text-rose-400"
                    >
                      <X className="h-2.5 w-2.5" aria-hidden />
                    </button>
                    <p className="px-1 py-0.5 font-mono text-[7.5px] uppercase tracking-wider text-cyan-400/80">
                      3d&nbsp;snapshot&nbsp;ready
                    </p>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>

            {/* 语音错误/不支持提示 */}
            {speechError !== null || !speechSupported ? (
              <p className="mb-1 flex items-center gap-1 font-mono text-[8.5px] text-amber-400">
                <AlertTriangle className="h-2.5 w-2.5 shrink-0" aria-hidden />
                {speechError ?? '当前浏览器不支持语音识别，请使用 Chrome / Edge'}
              </p>
            ) : null}

            {/* 输入行 */}
            <div className="flex items-end gap-1">
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
                placeholder="描述故障现象，或使用快捷指令…（Enter 发送 / Shift+Enter 换行）"
                aria-label="对话输入框"
                className="min-h-0 min-w-0 flex-1 resize-none rounded border border-slate-700 bg-slate-800/50 px-2 py-1.5 text-[11px] leading-relaxed text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-500/50"
              />

              <div className="flex shrink-0 flex-col gap-1">
                {/* 捕获 3D 视图 */}
                <button
                  type="button"
                  onClick={captureViewport}
                  aria-label="捕获当前 3D 视图"
                  title="📸 捕获当前 3D 视图"
                  className="rounded border border-slate-700 bg-slate-800/50 p-1 text-slate-400 transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
                >
                  <Camera className="h-3 w-3" aria-hidden />
                </button>

                {/* 语音输入 */}
                <button
                  type="button"
                  onClick={toggleListening}
                  aria-label={isListening ? '停止语音输入' : '开始语音输入'}
                  aria-pressed={isListening}
                  title={speechSupported ? '语音输入' : '浏览器不支持语音识别'}
                  className={cn(
                    'relative rounded border p-1 transition-colors',
                    isListening
                      ? 'border-rose-500/60 bg-rose-500/15 text-rose-400'
                      : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300',
                  )}
                >
                  {isListening ? <Mic className="h-3 w-3" aria-hidden /> : <Mic className="h-3 w-3" aria-hidden />}
                  {/* 录音脉冲红点 */}
                  {isListening ? (
                    <span className="absolute -right-0.5 -top-0.5 flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-500" />
                    </span>
                  ) : null}
                </button>

                {/* 发送 */}
                <button
                  type="button"
                  onClick={(): void => void sendMessage(inputValue)}
                  disabled={!canSend}
                  aria-label="发送消息"
                  title="发送"
                  className={cn(
                    'rounded border p-1 transition-colors',
                    canSend
                      ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25'
                      : 'cursor-not-allowed border-slate-700 bg-slate-800/50 text-slate-600',
                  )}
                >
                  {isStreaming ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <Send className="h-3 w-3" aria-hidden />
                  )}
                </button>
              </div>
            </div>

            {/* 快捷指令芯片 */}
            <div className="mt-1.5 flex flex-wrap gap-1">
              {QUICK_PROMPTS.map((chip) => (
                <button
                  key={chip.text}
                  type="button"
                  onClick={(): void => void sendMessage(chip.text)}
                  disabled={isStreaming}
                  className={cn(
                    'rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] transition-colors',
                    isStreaming
                      ? 'cursor-not-allowed border-slate-800 bg-slate-800/30 text-slate-600'
                      : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-cyan-300',
                  )}
                  title={chip.text}
                >
                  <span aria-hidden>{chip.icon}</span>&nbsp;{chip.text}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
