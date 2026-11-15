'use client';

/**
 * KubeVision AI — 可执行自愈操作确认面板（生成式 UI · ActionConfirm）
 *
 * 【设计意图】这是「人在回路（Human-in-the-loop）」安全闸门的 UI 落点：
 * LLM 决定执行运维动作时**不直接执行**，而是下发本卡片等待用户显式确认。
 * 自愈动作能瞬间改变生产状态，自动化越强，越需要一道人类确认的最后关口。
 *
 * 【两次安全闸门】
 * 1. 高危动作（isHighRisk：如 drain_node 驱逐节点）强制勾选「我已知晓风险」
 *    复选框才能点击执行 —— 防误触，也留下「用户已知情」的审计痕迹；
 * 2. 执行时展示 600ms 流光动画作为**不可中断的确认窗**：动画期间按钮禁用，
 *    给用户最后一次「反悔」的视觉提示，同时避免重复点击引发幂等风险。
 *
 * 【执行链路】确认 → 600ms 流光 → healEntity(targetId, actionType)
 * → store 登记免疫时间戳 + 派生愈合快照 + 双轨分发 + [KUBE-CONTROLLER] 终端回显
 * → 追加 [MCP-ROUTER] 协议级审计行 → 3D 视口中故障 Pod 当场恢复翠绿
 * → 回调 onActionExecuted(targetId, actionType) 向上冒泡。
 *
 * 【两条终端日志为何都要有】
 * - `[KUBE-CONTROLLER]`（由 store 的 healEntity 写入，cyan-300）：
 *   描述「K8s 控制器视角的执行结果」（Status verified: Running）；
 * - `[MCP-ROUTER]`（由本组件写入，sky-300）：
 *   描述「Agent 经 MCP 协议路由调用了哪个工具工具端点」。
 * 前者是编排层的落地事实，后者是协议层的调用凭证——审计时二者互补，
 * 缺了后者就无法回答「这个自愈动作是谁、通过什么通道发起的」。
 *
 * 【props.onActionExecuted 的职责边界】
 * 卡片只负责「确认 → 执行 → 显示已执行」，执行后的外部副作用
 * （刷新对话流、上报埋点、触发下一步推理、关闭父面板）通过回调交给调用方，
 * 卡片因此保持纯展示 + 单一自愈动作，不硬编码父级业务逻辑。
 *
 * 【MCP 协议标识】卡片头展示 mcpEndpoint（如 mcp://k8s-cluster/tools/restartPod），
 * 让用户清楚「这次点击会调用哪个工具」，而不是盲目的一个按钮。
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { UI_COPY } from '@/constants/copy';
import { motion } from 'framer-motion';
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  ClockAlert,
  Loader2,
  RotateCw,
  ShieldAlert,
  Terminal,
  Wrench,
} from 'lucide-react';

import { cn } from '@/utils/cn';
import { verifyReceiptDigest } from '@/utils/mcpReceiptDigest';
import type { McpExecuteReceipt } from '@/types/mcp';
import type { HealOutcome } from '@/types/store';
import { useClusterStore } from '@/store/useClusterStore';
import MarkdownLite from '@/components/ai/MarkdownLite';
import type { ActionConfirmProps, RemediationActionType } from '@/types/ai';
import type { RemediationDiff, SelectedEntityType } from '@/types/store';

/* ========================================================================== */
/* 类型                                                                       */
/* ========================================================================== */

/*
 * McpExecuteReceipt 从 src/types/mcp.ts 导入（唯一类型源）。
 *
 * 【为什么改】Q5 的"校验回执"要求前端按与服务端**完全相同的字段顺序**
 * 复算 auditDigest；两边各写一份 interface 时，字段增删只会在运行时
 * 表现为"校验总是失败"，很难定位。现在类型集中在 types/mcp.ts。
 */

/** JSON-RPC 2.0 成功响应 */
interface McpRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly result: McpExecuteReceipt;
}

/** JSON-RPC 2.0 失败响应 */
interface McpRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** R10-D：`GET /api/mcp/execute?clientRequestId=...` 只读回查结果 */
interface McpExecuteStatusPayload {
  readonly found: boolean;
  readonly status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  readonly receipt?: McpExecuteReceipt;
  readonly errorMessage?: string;
}

interface McpExecuteStatusResponse {
  readonly jsonrpc: '2.0';
  readonly result: McpExecuteStatusPayload;
}

/**
 * isRpcSuccess —— 运行期守卫：区分成功回执与错误包。
 *
 * 【为何不用类型断言】响应来自网络，形状不可信。断言 `as McpRpcSuccess`
 * 会把错误包也当成成功读取，随后 `result.executionId` 得到 undefined，
 * 界面显示一个空白的执行 ID——比直接报错更难排查。
 *
 * @param value 待判定的响应体
 * @returns 是否为成功包
 */
function isRpcSuccess(value: unknown): value is McpRpcSuccess {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { result?: unknown };
  if (typeof candidate.result !== 'object' || candidate.result === null) return false;
  return 'executionId' in candidate.result;
}

/**
 * isRpcFailure —— 运行期守卫：识别 JSON-RPC 错误包。
 *
 * @param value 待判定的响应体
 * @returns 是否为错误包
 */
function isRpcFailure(value: unknown): value is McpRpcFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { error?: unknown };
  return typeof candidate.error === 'object' && candidate.error !== null;
}

/**
 * isExecuteStatusResponse —— 校验 `GET /api/mcp/execute?clientRequestId=...` 响应结构。
 */
function isExecuteStatusResponse(value: unknown): value is McpExecuteStatusResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { result?: unknown };
  if (typeof candidate.result !== 'object' || candidate.result === null) return false;
  const result = candidate.result as { status?: unknown; found?: unknown };
  return (
    typeof result.found === 'boolean' &&
    (result.status === 'pending' ||
      result.status === 'succeeded' ||
      result.status === 'failed' ||
      result.status === 'unknown')
  );
}

/**
 * formatRpcError —— 提取服务端 JSON-RPC error 载荷的可读原因（兼容字符串与 { detail } 对象）。
 */
function formatRpcError(error: { readonly message: string; readonly data?: unknown }): string {
  if (typeof error.data === 'string' && error.data.trim().length > 0) {
    return `${error.message}: ${error.data.trim()}`;
  }
  if (
    typeof error.data === 'object' &&
    error.data !== null &&
    'detail' in error.data &&
    typeof error.data.detail === 'string' &&
    error.data.detail.trim().length > 0
  ) {
    return `${error.message}: ${error.data.detail.trim()}`;
  }
  return error.message;
}

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 执行流光动画时长（毫秒）——契约指定值，作为不可中断的确认窗 */
const EXECUTION_ANIMATION_MS = 600;

/** 动作类型 → 中文可读名 */
const ACTION_LABEL: Readonly<Record<RemediationActionType, string>> = {
  restart_pod: '重启 Pod',
  scale_deployment: '扩缩容 Deployment',
  drain_node: '隔离节点 (Cordon)',
};

/**
 * 已挂载动作卡注册表（按挂载实例 Token 跟踪 targetId）。
 *
 * 【设计意图】当列表开启虚拟滚动或多卡片共存时，旧卡片卸载（unmount）
 * 不得覆盖新卡片在 store 中的 `actionCardMountedId`，仅当所有动作卡
 * 全部卸载时才回写 `null`。
 */
const activeMountedCardTokens = new Map<symbol, string>();

/** 全局单调递增执行尝试序号（隔离同一卡片多次尝试的异步竞态） */
let nextExecutionAttemptSeq = 0;

/* ========================================================================== */
/* 执行阶段六态（targetId + executionId 隔离）                                 */
/* ========================================================================== */

/**
 * ExecutionPhase —— 卡片执行状态机（按卡片实例 + executionId 严格隔离）。
 *
 * - 'idle'      → 待用户确认
 * - 'executing' → 请求 MCP 执行端点 + 流光动画进行中（按钮禁用，防重复触发）
 * - 'done'      → 已执行完毕（展示成功态与服务端回执）
 * - 'timeout'   → 超过 12s 超时窗口且结果未知（禁止直接重试执行，防双次变更）
 * - 'cancelled' → 用户或外部中断取消本次执行
 * - 'error'     → 服务端明确拒绝或前置校验失败（允许重试）
 */
type ExecutionPhase = 'idle' | 'executing' | 'done' | 'timeout' | 'cancelled' | 'error';

/** 中止触发源分类：避免 12s 超时被当作普通 unmount 静默吞掉 */
type AbortReason = 'timeout' | 'cancel' | 'unmount';

/** MCP 执行端点路径 */
const MCP_EXECUTE_ENDPOINT = '/api/mcp/execute';

/** 执行请求超时（毫秒）：略大于服务端 8s 的 K8s 请求超时，留出传输余量 */
const MCP_REQUEST_TIMEOUT_MS = 12_000;

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * ActionConfirm —— 自愈动作二次确认面板。
 * 使用 React.memo 与细粒度 targetId 选择器隔离多卡片并发渲染与状态串扰。
 *
 * @param props 见 ActionConfirmProps（actionType/targetId/targetName/paramDescription/mcpEndpoint/isHighRisk）
 */
function ActionConfirmImpl({
  actionType,
  targetId,
  targetName,
  paramDescription,
  mcpEndpoint,
  isHighRisk,
  onActionExecuted,
}: ActionConfirmProps) {
  const healEntity = useClusterStore((s): ((targetId: string, actionType: string) => HealOutcome) => s.healEntity);
  const appendTerminalLog = useClusterStore((s): ((line: string) => void) => s.appendTerminalLog);
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );

  /**
   * 【细粒度订阅自愈对比】仅当 `lastRemediationDiff.targetId === targetId` 时才返回对比对象，
   * 否则恒返回 `null`，彻底杜绝其它 Pod 自愈时触发本卡片重渲染或跨目标展示错乱。
   */
  const diff = useClusterStore(
    (s): RemediationDiff | null =>
      s.lastRemediationDiff !== null && s.lastRemediationDiff.targetId === targetId
        ? s.lastRemediationDiff
        : null,
  );

  /*
   * ===== A 项：动作卡水合上报 =====
   *
   * 【为什么由卡片自己上报】导演引擎需要知道"动作卡已经挂到 DOM 上了"
   * 才能安全推进阶段 4。若由外部轮询 aria-label 探测，会引入选择器耦合；
   * 卡片在 mount/unmount 时写 store 是最可靠的事件源。
   */
  const setActionCardMountedId = useClusterStore(
    (s): ((v: string | null) => void) => s.setActionCardMountedId,
  );

  /*
   * ===== C 项：目标级导演降级同步（替代全局 demoFallbackExecuted 串扰） =====
   *
   * 仅当导演启用了降级标志且 `healedPodIds` 中已存在**当前 targetId** 的自愈记录时，
   * 本卡片才视为已由导演代执行完毕；其它 targetId 的待确认卡片绝不被连带置为 done。
   */
  const demoAutoConfirm = useClusterStore((s): boolean => s.demoAutoConfirm);
  const isFallbackHealedForTarget = useClusterStore(
    (s): boolean => s.demoFallbackExecuted && typeof s.healedPodIds[targetId] === 'number',
  );

  /** 高危确认勾选态（非高危动作恒为 true，无需勾选） */
  const [acknowledged, setAcknowledged] = useState<boolean>(!isHighRisk);

  /** 执行阶段状态机 */
  const [phase, setPhase] = useState<ExecutionPhase>('idle');

  /** 当前执行尝试 ID（用于隔离多次尝试间的竞态回调） */
  const [executionAttemptId, setExecutionAttemptId] = useState<string | null>(null);

  /** 服务端执行回执（拿到后才允许进入 done 态） */
  const [receipt, setReceipt] = useState<McpExecuteReceipt | null>(null);

  /**
   * 回执摘要校验状态（Q5）。
   *
   * 【为什么需要它】auditDigest 只是一个字符串，用户无法判断它是否与回执
   * 字段一致；"校验回执"按钮现场用同一公式复算，不一致即红色报警——
   * 这才让"防篡改"从口号变成可点击的动作。
   */
  const [digestCheck, setDigestCheck] = useState<
    | { readonly state: 'idle' }
    | { readonly state: 'checking' }
    | { readonly state: 'ok'; readonly expected: string }
    | { readonly state: 'fail'; readonly expected: string; readonly actual: string }
  >({ state: 'idle' });

  /** 失败 / 超时 / 取消原因说明 */
  const [failureReason, setFailureReason] = useState<string>('');

  /** R10-D：超时后「重新查询」执行状态（仅只读 GET 对账 + 快照核验，绝不重发 POST 执行） */
  const [isRequerying, setIsRequerying] = useState<boolean>(false);
  const [requeryNotice, setRequeryNotice] = useState<string>('');

  /**
   * 目标级「已执行」判定：若导演已针对本 targetId 降级执行，立即呈现 done 态并在 Effect 中锁存，
   * 避免导演流程结束后清除全局标志导致卡片状态回退闪烁。
   */
  const effectivePhase: ExecutionPhase =
    isFallbackHealedForTarget && phase === 'idle' ? 'done' : phase;

  useEffect((): void => {
    if (isFallbackHealedForTarget && phase === 'idle') {
      setPhase('done');
    }
  }, [isFallbackHealedForTarget, phase]);

  /** 执行动画定时器句柄（卸载时必须清理，否则会对已卸载组件 setState） */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 在途请求中止器（卸载或取消时触发） */
  const abortRef = useRef<AbortController | null>(null);

  /** R10-D：重新查询请求中止器与并发互斥哨兵 */
  const requeryAbortRef = useRef<AbortController | null>(null);
  const requeryInFlightRef = useRef<boolean>(false);

  /** 中止触发原因（按 attempt 写入，区分 12s timeout 与用户取消/组件卸载） */
  const abortReasonRef = useRef<AbortReason | null>(null);

  /** 当前活跃执行尝试 ID（用于丢弃已过期或已被新尝试取代的异步结果） */
  const activeAttemptIdRef = useRef<string | null>(null);

  /** 组件挂载存活哨兵（React 18 StrictMode 兼容） */
  const isMountedRef = useRef<boolean>(true);

  /** 若复用实例的 targetId 发生变化，复位局部尝试状态防止跨目标污染 */
  const prevTargetIdRef = useRef<string>(targetId);
  useEffect((): void => {
    if (prevTargetIdRef.current !== targetId) {
      prevTargetIdRef.current = targetId;
      activeAttemptIdRef.current = null;
      abortReasonRef.current = 'cancel';
      abortRef.current?.abort();
      abortRef.current = null;
      requeryAbortRef.current?.abort();
      requeryAbortRef.current = null;
      requeryInFlightRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setPhase('idle');
      setExecutionAttemptId(null);
      setReceipt(null);
      setDigestCheck({ state: 'idle' });
      setFailureReason('');
      setIsRequerying(false);
      setRequeryNotice('');
      setAcknowledged(!isHighRisk);
    }
  }, [targetId, isHighRisk]);

  /**
   * A 项：动作卡 mount / unmount 上报（虚拟化安全，多卡片互不踩踏）。
   */
  useEffect((): (() => void) => {
    const mountToken = Symbol('action-card-mount');
    activeMountedCardTokens.set(mountToken, targetId);
    setActionCardMountedId(targetId);
    return (): void => {
      activeMountedCardTokens.delete(mountToken);
      const remaining = Array.from(activeMountedCardTokens.values());
      setActionCardMountedId(remaining.length > 0 ? remaining[remaining.length - 1] : null);
    };
  }, [setActionCardMountedId, targetId]);

  /** 卸载清理：杜绝定时器/请求泄漏与「对已卸载组件 setState」警告 */
  useEffect(() => {
    isMountedRef.current = true;
    return (): void => {
      isMountedRef.current = false;
      activeAttemptIdRef.current = null;
      abortReasonRef.current = 'unmount';
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      abortRef.current?.abort();
      abortRef.current = null;
      requeryAbortRef.current?.abort();
      requeryAbortRef.current = null;
      requeryInFlightRef.current = false;
    };
  }, []);

  /**
   * handleVerifyReceipt —— 复算 auditDigest 并与回执值比对。
   *
   * 校验失败不改变回执本身（不回滚已执行事实），只把"摘要与字段不一致"
   * 作为红色安全告警呈现——审计工具应有的姿态：不掩盖，只暴露。
   */
  const handleVerifyReceipt = useCallback(async (): Promise<void> => {
    if (receipt === null) return;
    setDigestCheck({ state: 'checking' });
    const result = await verifyReceiptDigest(receipt);
    if (!isMountedRef.current) return;
    setDigestCheck(
      result.ok
        ? { state: 'ok', expected: result.expected }
        : { state: 'fail', expected: result.expected, actual: result.actual },
    );
  }, [receipt]);

  /**
   * Q1：语音确认的"显式二次确认"语义。
   *
   * 【为什么不能直接执行】高危动作（isHighRisk）必须与复选框同语义：
   * 用户必须在卡片上显式勾选"我已确认影响面"后才能执行。
   * 语音说"确认"不能替代这个复选框——否则语音通道就成了绕过安全护栏的后门。
   */
  useEffect((): (() => void) => {
    const onVoiceConfirm = (): void => {
      if (effectivePhase !== 'idle' && effectivePhase !== 'error' && effectivePhase !== 'cancelled') return;
      if (isHighRisk && !acknowledged) return;
      executeRef.current?.();
    };
    window.addEventListener('kv-voice-confirm', onVoiceConfirm);
    return (): void => window.removeEventListener('kv-voice-confirm', onVoiceConfirm);
  }, [effectivePhase, isHighRisk, acknowledged]);

  /** 最新 handleExecute 引用（语音确认监听通过它调用，避免闭包过期） */
  const executeRef = useRef<(() => void) | null>(null);

  /** 用户手动取消进行中的执行（从 executing 转入 cancelled） */
  const handleCancelExecution = useCallback((): void => {
    if (effectivePhase !== 'executing') return;
    const attemptId = activeAttemptIdRef.current;
    activeAttemptIdRef.current = null;
    abortReasonRef.current = 'cancel';
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setFailureReason('已手动取消本次自愈请求（未等待服务端回执）');
    setPhase('cancelled');
    if (attemptId !== null) {
      appendTerminalLog(`[MCP-ROUTER] CANCELLED ${attemptId} (${actionType} -> ${targetId})`);
    }
  }, [actionType, appendTerminalLog, effectivePhase, targetId]);

  /**
   * handleRequeryExecution —— 超时未知态下的只读对账（「重新查询」）。
   *
   * 【安全约束】绝不重复 POST /api/mcp/execute；仅向 GET /api/mcp/execute?clientRequestId=...
   * 查询服务端近期回执账本，并结合当前 store.snapshotSummary 状态向运维如实汇报。
   */
  const handleRequeryExecution = useCallback(async (): Promise<void> => {
    if (effectivePhase !== 'timeout' || requeryInFlightRef.current) return;
    requeryInFlightRef.current = true;
    setIsRequerying(true);

    const expectedTargetId = targetId;
    const attemptKey = executionAttemptId;

    const inspectSnapshot = (): string => {
      const state = useClusterStore.getState();
      const snapshot = state.snapshotSummary;
      const pod = snapshot.pods.find((p): boolean => p.id === expectedTargetId);
      if (pod !== undefined) {
        const healedMark = typeof state.healedPodIds[expectedTargetId] === 'number';
        return `当前快照：Pod ${pod.name} 状态为 ${pod.status}（CPU ${pod.cpuUsage.toFixed(0)}% / 内存 ${pod.memoryUsage.toFixed(0)}%）${healedMark ? '，已有自愈免疫记录' : ''}。`;
      }
      const node = snapshot.nodes.find((n): boolean => n.id === expectedTargetId);
      if (node !== undefined) {
        return `当前快照：Node ${node.name} 状态为 ${node.status}（CPU ${node.cpuUsage.toFixed(0)}% / 内存 ${node.memUsage.toFixed(0)}%）。`;
      }
      return '当前快照未包含该目标实体，建议重新发起诊断确认。';
    };

    if (attemptKey === null || attemptKey.trim().length === 0) {
      requeryInFlightRef.current = false;
      setIsRequerying(false);
      setRequeryNotice(`缺少客户端请求标识，无法查询服务端账本。${inspectSnapshot()}`);
      return;
    }

    requeryAbortRef.current?.abort();
    const controller = new AbortController();
    requeryAbortRef.current = controller;
    const requeryTimeout = setTimeout((): void => {
      controller.abort();
    }, 5_000);

    try {
      const response = await fetch(
        `${MCP_EXECUTE_ENDPOINT}?clientRequestId=${encodeURIComponent(attemptKey)}`,
        { method: 'GET', signal: controller.signal },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (!isMountedRef.current || prevTargetIdRef.current !== expectedTargetId) return;

      if (!isExecuteStatusResponse(payload)) {
        setRequeryNotice(`回查响应格式异常；${inspectSnapshot()}`);
        return;
      }

      const { status, receipt: queriedReceipt, errorMessage } = payload.result;
      if (status === 'succeeded' && queriedReceipt !== undefined) {
        setReceipt(queriedReceipt);
        if (typeof useClusterStore.getState().healedPodIds[expectedTargetId] !== 'number') {
          const healOutcome = healEntity(expectedTargetId, actionType);
          if (!healOutcome.ok) {
            setRequeryNotice('');
            setFailureReason(healOutcome.message);
            setPhase('error');
            return;
          }
        }
        appendTerminalLog(
          `[MCP-ROUTER] RECONCILED ${queriedReceipt.executionId} ${queriedReceipt.toolUri} -> ${queriedReceipt.targetName} (${queriedReceipt.mode})`,
        );
        appendTerminalLog(`[MCP-ROUTER] equivalent: ${queriedReceipt.kubectlCommand}`);
        setRequeryNotice('');
        setPhase('done');
        onActionExecuted?.(expectedTargetId, actionType);
        return;
      }

      if (status === 'failed') {
        setRequeryNotice('');
        setFailureReason(errorMessage ?? '服务端执行账本显示该动作失败');
        setPhase('error');
        return;
      }

      if (status === 'pending') {
        setRequeryNotice(`服务端回执账本显示仍在处理中（pending），请稍后再查。${inspectSnapshot()}`);
        return;
      }

      setRequeryNotice(`服务端暂未查到本次执行记录（unknown）。${inspectSnapshot()}`);
    } catch (error) {
      if (controller.signal.aborted && !isMountedRef.current) return;
      if (!isMountedRef.current || prevTargetIdRef.current !== expectedTargetId) return;
      const msg =
        controller.signal.aborted
          ? '状态查询超时（> 5000ms）'
          : error instanceof Error
            ? error.message
            : String(error);
      setRequeryNotice(`回查失败（${msg}）。${inspectSnapshot()}`);
    } finally {
      clearTimeout(requeryTimeout);
      if (requeryAbortRef.current === controller) {
        requeryAbortRef.current = null;
      }
      requeryInFlightRef.current = false;
      if (isMountedRef.current) {
        setIsRequerying(false);
      }
    }
  }, [
    actionType,
    appendTerminalLog,
    effectivePhase,
    executionAttemptId,
    healEntity,
    onActionExecuted,
    targetId,
  ]);

  /**
   * handleExecute —— 按 targetId + executionId 隔离触发自愈请求与流光动画。
   *
   * 【设计意图】
   * 1. 仅允许从 idle / error / cancelled 发起（done 与 timeout 禁止重复下单，防二次变更）；
   * 2. 为每次点击分配唯一 attemptId 作为 clientRequestId 随 POST 上送服务端账本，并绑定 AbortReason，
   *    彻底区分 12s 超时、用户取消与卸载；
   * 3. 全程受 `isMountedRef` 与 `activeAttemptIdRef` 保护，避免异步回包更新过期状态或已卸载节点。
   */
  const handleExecute = useCallback((): void => {
    if (effectivePhase !== 'idle' && effectivePhase !== 'error' && effectivePhase !== 'cancelled') return;
    if (isHighRisk && !acknowledged) return;

    nextExecutionAttemptSeq += 1;
    const attemptId = `exec-${targetId}-${nextExecutionAttemptSeq}`;
    activeAttemptIdRef.current = attemptId;
    abortReasonRef.current = null;

    requeryAbortRef.current?.abort();
    requeryAbortRef.current = null;
    requeryInFlightRef.current = false;

    setExecutionAttemptId(attemptId);
    setPhase('executing');
    setFailureReason('');
    setIsRequerying(false);
    setRequeryNotice('');

    /**
     * 【执行前解析真实目标】目标不存在就停在 error 态并明确提示，
     * 严禁静默回退到 snapshot.pods[0]。
     */
    const snapshot = useClusterStore.getState().snapshotSummary;
    const targetExists =
      snapshot.pods.some((pod): boolean => pod.id === targetId) ||
      snapshot.nodes.some((node): boolean => node.id === targetId);

    if (!targetExists) {
      activeAttemptIdRef.current = null;
      appendTerminalLog(
        `[MCP-ROUTER] ABORTED ${actionType} -> target ${targetId} not in current snapshot`,
      );
      setFailureReason('目标已不存在于当前快照，请重新诊断后确认');
      setPhase('error');
      return;
    }

    const effectiveTargetId: string = targetId;
    const effectiveEntityType: SelectedEntityType =
      snapshot.nodes.some((node): boolean => node.id === effectiveTargetId) ? 'node' : 'pod';
    const targetPod = snapshot.pods.find((pod): boolean => pod.id === effectiveTargetId);
    const effectiveTargetName =
      targetPod?.name ??
      snapshot.nodes.find((node): boolean => node.id === effectiveTargetId)?.name ??
      targetName;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const animationDone = new Promise<void>((resolve): void => {
      timerRef.current = setTimeout((): void => {
        timerRef.current = null;
        resolve();
      }, EXECUTION_ANIMATION_MS);
    });

    const requestDone = (async (): Promise<McpExecuteReceipt> => {
      const timeout = setTimeout((): void => {
        if (activeAttemptIdRef.current === attemptId) {
          abortReasonRef.current = 'timeout';
        }
        controller.abort();
      }, MCP_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(MCP_EXECUTE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientRequestId: attemptId,
            actionType,
            targetId: effectiveTargetId,
            targetName: effectiveTargetName,
            ...(targetPod !== undefined ? { namespace: targetPod.namespace } : {}),
            clusterMode: useClusterStore.getState().connectionMode,
            confirmation: {
              confirmed: true,
              targetId: effectiveTargetId,
              actionType,
              issuedAt: new Date().toISOString(),
              highRiskAcknowledged: !isHighRisk || acknowledged,
            },
          }),
          signal: controller.signal,
        });

        const payload: unknown = await response.json();

        if (isRpcSuccess(payload)) return payload.result;

        if (isRpcFailure(payload)) {
          throw new Error(formatRpcError(payload.error));
        }
        throw new Error(`响应结构异常（HTTP ${response.status}）`);
      } finally {
        clearTimeout(timeout);
      }
    })();

    void (async (): Promise<void> => {
      try {
        /* 动画与服务端请求并行等待：两者都完成才进入结果态 */
        const [result] = await Promise.all([requestDone, animationDone]);
        if (!isMountedRef.current || activeAttemptIdRef.current !== attemptId) return;
        if (controller.signal.aborted) {
          const reason = abortReasonRef.current;
          abortRef.current = null;
          activeAttemptIdRef.current = null;
          if (reason === 'timeout') {
            setFailureReason('MCP 执行请求超过 12 秒未响应，执行结果未知；请勿盲目重复执行。');
            setPhase('timeout');
          } else if (reason === 'cancel') {
            setFailureReason('已取消本次自愈执行');
            setPhase('cancelled');
          }
          return;
        }

        abortRef.current = null;
        activeAttemptIdRef.current = null;
        setReceipt(result);

        /* ---- 步骤 2：服务端已受理 → 落地本地自愈 ---- */
        const healOutcome = healEntity(effectiveTargetId, actionType);
        if (!healOutcome.ok) {
          setFailureReason(healOutcome.message);
          setPhase('error');
          return;
        }

        /* ---- 步骤 3：MCP 协议级审计回显 ---- */
        appendTerminalLog(
          `[MCP-ROUTER] ${result.executionId} invoked ${result.toolUri} -> ${result.targetName} healed in ${result.latencyMs}ms (${result.mode})`,
        );
        appendTerminalLog(`[MCP-ROUTER] equivalent: ${result.kubectlCommand}`);

        /* ---- 步骤 4：手动执行时引导 3D 相机聚焦被自愈实体 ---- */
        if (!useClusterStore.getState().demoAutoConfirm) {
          selectEntity(effectiveTargetId, effectiveEntityType);
        }

        /* ---- 步骤 5：切换成功态并向上冒泡 ---- */
        setPhase('done');
        onActionExecuted?.(targetId, actionType);
      } catch (error) {
        if (!isMountedRef.current || activeAttemptIdRef.current !== attemptId) return;
        const reason = abortReasonRef.current;
        abortRef.current = null;
        activeAttemptIdRef.current = null;

        if (controller.signal.aborted) {
          if (reason === 'unmount') return;
          if (reason === 'cancel') {
            setFailureReason('已取消本次自愈执行');
            setPhase('cancelled');
            return;
          }
          if (reason === 'timeout') {
            setFailureReason('MCP 执行请求超过 12 秒未响应，执行结果未知；请勿盲目重复执行。');
            setPhase('timeout');
            appendTerminalLog(
              `[MCP-ROUTER] TIMEOUT ${actionType} on ${effectiveTargetId} (> ${MCP_REQUEST_TIMEOUT_MS}ms)`,
            );
            return;
          }
        }

        const message = error instanceof Error ? error.message : String(error);
        setFailureReason(message);
        setPhase('error');
        appendTerminalLog(`[MCP-ROUTER] FAILED ${actionType} on ${effectiveTargetId} -> ${message}`);
      }
    })();
  }, [
    acknowledged,
    actionType,
    appendTerminalLog,
    effectivePhase,
    healEntity,
    isHighRisk,
    onActionExecuted,
    selectEntity,
    targetId,
    targetName,
  ]);

  /* 捕获最新 handleExecute（effect 中同步，避免渲染期副作用） */
  useEffect((): void => {
    executeRef.current = handleExecute;
  }, [handleExecute]);

  const isExecuting = effectivePhase === 'executing';
  const isDone = effectivePhase === 'done';
  const isTimeout = effectivePhase === 'timeout';
  const isCancelled = effectivePhase === 'cancelled';
  const isError = effectivePhase === 'error';

  /** 按钮是否禁用：执行中 / 已完成 / 超时未知态 / 高危未勾选 */
  const buttonDisabled = isExecuting || isDone || isTimeout || (isHighRisk && !acknowledged);

  return (
    <div
      className={cn(
        'w-full overflow-hidden rounded-md border bg-slate-900/70',
        isHighRisk ? 'border-rose-500/60 shadow-glow-rose' : 'border-cyan-500/40',
      )}
      aria-label={`自愈操作确认：${ACTION_LABEL[actionType]} ${targetName}${
        demoAutoConfirm ? '（自动演示模式：导演将代为勾选并执行）' : ''
      }`}
      data-demo-auto={demoAutoConfirm ? 'true' : 'false'}
      data-target-id={targetId}
      data-phase={effectivePhase}
      data-execution-id={executionAttemptId ?? ''}
    >
      {/* ============ 头部：动作徽标 + 目标 ============ */}
      <div className="flex items-start gap-2 p-2.5 pb-2">
        <span
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border',
            isHighRisk
              ? 'border-rose-500/60 bg-rose-500/[0.15]'
              : 'border-cyan-500/40 bg-cyan-500/10',
          )}
        >
          {isHighRisk ? (
            <ShieldAlert className="h-3 w-3 animate-glow-pulse text-rose-400" aria-hidden />
          ) : (
            <Wrench className="h-3 w-3 text-cyan-300" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                'font-mono text-[10px] font-bold uppercase tracking-wider',
                isHighRisk ? 'text-rose-300' : 'text-cyan-300',
              )}
            >
              {ACTION_LABEL[actionType]}
            </span>
            {isHighRisk ? (
              <span className="rounded border border-rose-500/50 bg-rose-500/[0.15] px-1 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-rose-300">
                高危变更
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-slate-300" title={targetName}>
            作用目标 · {targetName}
          </p>
        </div>
      </div>

      {/* ============ MCP 协议端点标识 ============ */}
      <div className="px-2.5 pb-2">
        <div className="flex items-center gap-1 rounded border border-white/[0.05] bg-slate-800/50 px-1.5 py-1">
          <Terminal className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
          <code className="truncate font-mono text-[11px] text-slate-400">{mcpEndpoint}</code>
        </div>
      </div>

      {/* ============ 参数说明 ============ */}
      <div className="px-2.5 pb-2">
        <MarkdownLite markdown={paramDescription} className="text-[11px] leading-relaxed text-slate-300" />
      </div>

      {/* ============ 高危二次确认复选框（仅 isHighRisk 渲染） ============ */}
      {isHighRisk ? (
        <label className="mx-2.5 mb-2 flex cursor-pointer items-start gap-1.5 rounded border border-rose-500/30 bg-rose-500/5 p-1.5 transition-colors hover:bg-rose-500/10">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event): void => setAcknowledged(event.target.checked)}
            disabled={isExecuting || isDone || isTimeout}
            className="mt-[2px] h-3 w-3 shrink-0 cursor-pointer accent-rose-500"
            aria-label="确认已知晓高危操作风险"
          />
          <span className="min-w-0 text-[12px] leading-relaxed text-rose-200/90">
            我已知晓该操作将影响生产环境，确认立即执行（此操作会记录审计日志）
          </span>
        </label>
      ) : null}

      {/* ============ 执行按钮（idle 态始终保持为卡片内最后一个 button） ============ */}
      <div className="px-2.5 pb-2.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-demo-auto={demoAutoConfirm ? 'true' : 'false'}
            title={
              demoAutoConfirm ? '自动演示模式：本按钮将由导演引擎代为点击' : '执行自愈方案'
            }
            onClick={handleExecute}
            disabled={buttonDisabled}
            className={cn(
              'relative w-full overflow-hidden rounded border px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all',
              isDone
                ? 'cursor-default border-emerald-500/50 bg-emerald-500/[0.15] text-emerald-300'
                : isExecuting
                  ? 'cursor-wait border-cyan-500/50 bg-cyan-500/[0.15] text-cyan-200'
                  : isTimeout
                    ? 'cursor-not-allowed border-amber-500/50 bg-amber-500/[0.15] text-amber-200'
                    : buttonDisabled
                      ? 'cursor-not-allowed border-white/[0.07] bg-slate-800/50 text-slate-500'
                      : isHighRisk
                        ? 'border-rose-500/60 bg-rose-500/[0.15] text-rose-200 hover:border-rose-400 hover:bg-rose-500/25 active:scale-[0.985]'
                        : 'border-cyan-500/50 bg-cyan-500/[0.15] text-cyan-200 hover:border-cyan-400 hover:bg-cyan-500/25 active:scale-[0.985]',
            )}
          >
            {isExecuting ? (
              <motion.span
                className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                initial={{ x: '-100%' }}
                animate={{ x: '300%' }}
                transition={{ duration: EXECUTION_ANIMATION_MS / 1000, ease: 'linear' }}
                aria-hidden
              />
            ) : null}

            <span className="relative flex items-center justify-center gap-1.5">
              {isDone ? (
                <>
                  <CheckCircle2 className="h-3 w-3" aria-hidden />
                  已执行 · 3D 拓扑已自愈恢复
                </>
              ) : isExecuting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  执行中…
                </>
              ) : isTimeout ? (
                <>
                  <ClockAlert className="h-3 w-3" aria-hidden />
                  执行超时，结果未知
                </>
              ) : isCancelled ? (
                <>
                  <Ban className="h-3 w-3" aria-hidden />
                  已取消 · 点击重新执行
                </>
              ) : isError ? (
                <>
                  <CircleAlert className="h-3 w-3" aria-hidden />
                  执行失败 · 点击重试
                </>
              ) : (
                <>
                  <Wrench className="h-3 w-3" aria-hidden />
                  {isHighRisk && !acknowledged
                    ? UI_COPY.actionNeedConfirm
                    : UI_COPY.actionExecuteNow}
                </>
              )}
            </span>
          </button>

          {isExecuting ? (
            <button
              type="button"
              onClick={handleCancelExecution}
              aria-label="取消本次执行"
              className="shrink-0 rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-amber-200 transition-colors hover:border-amber-400 hover:bg-amber-500/20 active:scale-95"
            >
              取消
            </button>
          ) : null}
        </div>
      </div>

      {/* ============ 超时态：禁止重复下发执行，提供只读「重新查询」账本与快照核验 ============ */}
      {isTimeout ? (
        <div className="border-t border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[11px] leading-relaxed text-amber-200">
                [MCP-TIMEOUT] 执行超时，结果未知
              </p>
              <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-amber-200/80">
                {failureReason.length > 0
                  ? failureReason
                  : '超过 12 秒未收到服务端回执；为防重复自愈变更，已禁用重复执行。'}
              </p>
            </div>
            <button
              type="button"
              onClick={(): void => void handleRequeryExecution()}
              disabled={isRequerying}
              aria-label="重新查询执行结果"
              className={cn(
                'flex shrink-0 items-center gap-1 rounded border px-2 py-1 font-mono text-[10px] font-bold tracking-wider transition-colors',
                isRequerying
                  ? 'cursor-wait border-amber-400/30 bg-amber-500/10 text-amber-200/60'
                  : 'border-amber-400/60 bg-amber-500/20 text-amber-100 hover:border-amber-300 hover:bg-amber-500/30 active:scale-95',
              )}
            >
              {isRequerying ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <RotateCw className="h-3 w-3" aria-hidden />
              )}
              {isRequerying ? '查询中…' : '重新查询'}
            </button>
          </div>
          {requeryNotice.length > 0 ? (
            <p
              role="status"
              className="mt-1.5 rounded border border-amber-400/30 bg-slate-950/50 px-2 py-1 font-mono text-[10px] leading-relaxed text-amber-100"
            >
              {requeryNotice}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ============ 已取消态 ============ */}
      {isCancelled ? (
        <div className="border-t border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5">
          <p className="font-mono text-[11px] leading-relaxed text-amber-200">
            [MCP-CANCELLED] 本次操作已取消
          </p>
          <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-amber-200/75">
            {failureReason.length > 0 ? failureReason : '用户中断了本次执行，未确认服务端状态变更。'}
          </p>
        </div>
      ) : null}

      {/* ============ 失败态：如实展示服务端拒绝原因 ============ */}
      {isError ? (
        <div className="border-t border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5">
          <p className="font-mono text-[11px] leading-relaxed text-rose-300">
            [MCP-ERROR] 服务端未受理本次动作
          </p>
          <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-rose-300/70">
            {failureReason.length > 0 ? failureReason : '未知错误'}
          </p>
          {failureReason.includes('目标已不存在') ? (
            <p className="mt-1 text-[10px] leading-relaxed text-amber-300/80">
              本地不会回退到其它 Pod 执行。请重新发起诊断，拿到指向当前快照的目标后再确认。
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ============ 已执行态：服务端回执 + 自愈前后指标对比 ============ */}
      {isDone ? (
        <div className="border-t border-white/[0.07] px-2.5 py-1.5">
          <p className="font-mono text-[11px] tracking-wider text-emerald-400/80">
            [OK] 自愈指令已下发 → 免疫窗口已登记 → 3D 视口已同步更新
          </p>

          {receipt !== null ? (
            <div className="mt-1.5 rounded border border-emerald-500/20 bg-emerald-500/[0.04] p-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-emerald-300/70">
                <span className="text-emerald-400">{UI_COPY.mcpReceiptTag}</span>
                <span>{receipt.executionId}</span>
                <span className="text-slate-400">·</span>
                <span>{receipt.latencyMs}ms</span>
                <span className="text-slate-400">·</span>
                <span className={receipt.mode === 'real' ? 'text-emerald-400' : 'text-amber-300/80'}>
                  {receipt.mode === 'real' ? UI_COPY.mcpModeReal : UI_COPY.mcpModeSimulated}
                </span>
                {receipt.executionStage !== undefined ? (
                  <>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-300">
                      {receipt.executionStage === 'accepted' ? 'stage:accepted' : 'stage:verified'}
                    </span>
                  </>
                ) : null}
              </div>

              <pre className="mt-1 overflow-x-auto rounded bg-slate-950/70 px-1.5 py-1 font-mono text-[10px] leading-relaxed text-cyan-300/90">
                <code>$ {receipt.kubectlCommand}</code>
              </pre>

              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <p className="font-mono text-[10px] text-slate-400">audit digest: {receipt.auditDigest}</p>
                <button
                  type="button"
                  onClick={(): void => void handleVerifyReceipt()}
                  disabled={digestCheck.state === 'checking'}
                  aria-label="校验回执摘要是否与字段一致"
                  className={cn(
                    'ml-auto rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors',
                    'border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:border-cyan-400/70 hover:bg-cyan-500/20',
                    digestCheck.state === 'checking' ? 'cursor-wait opacity-60' : '',
                  )}
                >
                  {digestCheck.state === 'checking' ? '校验中…' : '校验回执'}
                </button>
              </div>

              {digestCheck.state === 'ok' ? (
                <p
                  data-digest-check="ok"
                  className="mt-1 font-mono text-[10px] text-emerald-400"
                  aria-label="回执摘要校验通过"
                >
                  ✓ 校验通过：摘要与字段一致（{digestCheck.expected}）
                </p>
              ) : null}
              {digestCheck.state === 'fail' ? (
                <p
                  data-digest-check="fail"
                  className="mt-1 font-mono text-[10px] font-bold text-rose-400"
                  aria-label="回执摘要校验失败"
                >
                  ✗ 校验失败：回执字段被改动（期望 {digestCheck.expected} / 实际 {digestCheck.actual}）
                </p>
              ) : null}
            </div>
          ) : null}

          {diff !== null ? (
            <div className="mt-1.5 rounded border border-cyan-500/20 bg-cyan-500/[0.04] p-1.5">
              <p className="font-mono text-[10px] font-bold tracking-wider text-cyan-300">
                自愈前后指标对比 · {diff.targetName}
              </p>
              <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px]">
                <MetricDelta label="CPU" before={diff.beforeCpu} after={diff.afterCpu} unit="%" />
                <MetricDelta label="内存" before={diff.beforeMem} after={diff.afterMem} unit="%" />
                <MetricDelta
                  label="健康分"
                  before={diff.beforeHealth}
                  after={diff.afterHealth}
                  unit=""
                  improveWhen="up"
                />
                <StatusDelta before={diff.beforeStatus} after={diff.afterStatus} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const ActionConfirm = memo(ActionConfirmImpl);
export default ActionConfirm;

/* ========================================================================== */
/* 子组件：单行指标对比                                                        */
/* ========================================================================== */

/**
 * MetricDelta —— 「前值 → 后值」单行指标对比。
 *
 * 【配色方向为何不能写死】这里有个容易搞错的地方：CPU / 内存 / 健康分
 * 三个指标的"好"方向并不一致——前两者下降是好事，健康分上升才是好事。
 * 若统一用"数值变化为正则绿色"，就会出现"CPU 从 40% 涨到 96% 显示为绿色"
 * 这种严重误导。因此用 improveWhen 参数显式声明该指标的好坏方向。
 *
 * @param props 标签、前值、后值、单位、好方向
 */
function MetricDelta({
  label,
  before,
  after,
  unit,
  improveWhen = 'down',
}: {
  readonly label: string;
  readonly before: number;
  readonly after: number;
  readonly unit: string;
  readonly improveWhen?: 'up' | 'down';
}) {
  const delta = after - before;
  const improved = improveWhen === 'down' ? delta < -0.05 : delta > 0.05;
  const worsened = improveWhen === 'down' ? delta > 0.05 : delta < -0.05;

  const toneClass = improved ? 'text-emerald-300' : worsened ? 'text-rose-300' : 'text-slate-400';
  const arrow = delta > 0.05 ? '↑' : delta < -0.05 ? '↓' : '→';

  return (
    <span className="flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-300">
        {before.toFixed(unit === '' ? 0 : 1)}
        {unit}
      </span>
      <span className="text-slate-400">→</span>
      <span className={toneClass}>
        {after.toFixed(unit === '' ? 0 : 1)}
        {unit} {arrow}
      </span>
    </span>
  );
}

/**
 * StatusDelta —— 实体状态的前后对比（Pod 生命周期态 / Node 就绪态）。
 *
 * 【为何单独一个组件而非塞进 MetricDelta】状态是枚举而非数值，
 * 没有"上升/下降"语义，只有"好转/恶化/不变"。硬套数值比较会得出荒谬结论
 * （比如把 CrashLoopBackOff → Running 判定为"字符串变长"）。
 * 这里用明确的成功态白名单判断。
 *
 * @param props 前状态、后状态
 */
function StatusDelta({ before, after }: { readonly before: string; readonly after: string }) {
  /** 视为"健康"的状态集合（Pod 与 Node 的成功态） */
  const healthyStates = new Set<string>(['Running', 'Ready']);
  const improved = !healthyStates.has(before) && healthyStates.has(after);
  const worsened = healthyStates.has(before) && !healthyStates.has(after);

  const toneClass = improved ? 'text-emerald-300' : worsened ? 'text-rose-300' : 'text-slate-400';

  return (
    <span className="flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-slate-400">状态</span>
      <span className="text-slate-300">{before}</span>
      <span className="text-slate-400">→</span>
      <span className={toneClass}>{after}</span>
    </span>
  );
}