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

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, CircleAlert, Loader2, ShieldAlert, Terminal, Wrench } from 'lucide-react';

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
  readonly error: { readonly code: number; readonly message: string; readonly data?: string };
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
  return typeof candidate.result === 'object' && candidate.result !== null;
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

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 执行流光动画时长（毫秒）——契约指定值，作为不可中断的确认窗 */
const EXECUTION_ANIMATION_MS = 600;

/** 动作类型 → 中文可读名 */
const ACTION_LABEL: Readonly<Record<RemediationActionType, string>> = {
  restart_pod: '重启 Pod',
  scale_deployment: '扩缩容 Deployment',
  drain_node: '驱逐节点',
};

/* ========================================================================== */
/* 执行阶段三态                                                                */
/* ========================================================================== */

/**
 * ExecutionPhase —— 卡片执行状态机。
 *
 * - 'idle'      → 待用户确认
 * - 'executing' → 请求 MCP 执行端点 + 流光动画进行中（按钮禁用，防重复触发）
 * - 'done'      → 已执行完毕（展示成功态与服务端回执）
 * - 'failed'    → 服务端明确拒绝/失败（展示错误原因，允许重试）
 *
 * 【为何新增 failed 态】引入真实 MCP 调用后，"失败"成为一种必须表达的状态：
 * 真实集群可能因权限不足、资源不存在、网络不通而拒绝执行。
 * 若沿用旧的二元态，失败会被显示成"已执行"——那是在生产环境里
 * 告诉用户自愈成功了，而实际什么都没做。这个假象比不提供功能更危险。
 */
type ExecutionPhase = 'idle' | 'executing' | 'done' | 'failed';

/** MCP 执行端点路径 */
const MCP_EXECUTE_ENDPOINT = '/api/mcp/execute';

/** 执行请求超时（毫秒）：略大于服务端 8s 的 K8s 请求超时，留出传输余量 */
const MCP_REQUEST_TIMEOUT_MS = 12_000;

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * ActionConfirm —— 自愈动作二次确认面板。
 *
 * @param props 见 ActionConfirmProps（actionType/targetId/targetName/paramDescription/mcpEndpoint/isHighRisk）
 */
export default function ActionConfirm({
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
   * 【细粒度订阅自愈对比】只订阅 lastRemediationDiff 这一个字段，
   * 避免整个 store 变更都触发卡片重渲染。
   *
   * 【为何要校验 targetId 匹配】多个动作卡可能同时存在于对话流中。
   * 如果 A 卡片执行后写入的 diff 被 B 卡片读到并展示，就会出现
   * 「B 卡片显示了 A 的修复数据」——张冠李戴的对比比没有对比更糟。
   * 因此只在 diff.targetId 与本卡目标一致时才展示。
   */
  const lastDiff = useClusterStore((s): RemediationDiff | null => s.lastRemediationDiff);
  const diff = lastDiff !== null && lastDiff.targetId === targetId ? lastDiff : null;

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
  const lastAssistantMessageId = useClusterStore(
    (s): string | null => s.lastAssistantMessageId,
  );

  /*
   * ===== C 项：自动演示标识与降级已执行 =====
   *
   * 【为什么要有可见标识】自动勾选 + 自动点击若没有任何标记，评委看到的
   * 是"卡片自己动了一下"，很像绕过护栏的作弊。带上 data-demo-auto 与
   * aria 说明后，它就是一个**被声明的编排行为**：可查、可读屏，属透明自动化。
   */
  const demoAutoConfirm = useClusterStore((s): boolean => s.demoAutoConfirm);
  const demoFallbackExecuted = useClusterStore((s): boolean => s.demoFallbackExecuted);


  /** 高危确认勾选态（非高危动作恒为 true，无需勾选） */
  const [acknowledged, setAcknowledged] = useState<boolean>(!isHighRisk);

  /** 执行阶段状态机 */
  const [phase, setPhase] = useState<ExecutionPhase>('idle');

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

  /** 失败原因（failed 态展示） */
  const [failureReason, setFailureReason] = useState<string>('');
/**
   * C 项：统一「已执行」判定。
   *
   * 【解决什么矛盾】8 秒内卡片未挂载时导演已直调 healEntity，旁白也在讲
   * "自愈完成"。若卡片随后才挂载，它内部仍是 idle（待执行），同一屏就会
   * 出现「字幕说已完成 / 卡片说请点击执行」——规格明令禁止的矛盾。
   * 只要导演置位了降级标记，本卡立即按已执行态渲染。
   */
  const effectivePhase: ExecutionPhase =
    demoFallbackExecuted && phase === 'idle' ? 'done' : phase;

  /** 执行动画定时器句柄（卸载时必须清理，否则会对已卸载组件 setState） */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 在途请求中止器（卸载时取消，避免泄漏与幽灵回调） */
  const abortRef = useRef<AbortController | null>(null);

  /**
   * A 项：动作卡 mount / unmount 上报。
   *
   * 【写入放在 useEffect 而非渲染体】渲染体可能因 StrictMode 执行两次，
   * 在其中写 store 会触发"渲染期更新外部状态"的告警与重复提交。
   */
  useEffect((): (() => void) => {
    setActionCardMountedId(targetId);
    return (): void => {
      setActionCardMountedId(null);
    };
  }, [setActionCardMountedId, targetId]);

  /** 卸载清理：杜绝定时器/请求泄漏与「对已卸载组件 setState」警告 */
  useEffect(() => {
    return (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  /**
   * handleExecute —— 执行自愈动作。
   *
   * 【核心流转】
   * 1. 前置校验：高危未勾选 / 已在执行 / 已执行 → 直接返回；
   * 2. 进入 executing 态，启动 600ms 流光动画（不可中断的确认窗）；
   * 3. 动画结束后调用 healEntity(targetId, actionType)：
   *    store 内部执行免疫去重 → 派生愈合快照 → 双轨分发 → 终端审计；
   * 4. 追加 [MCP-ROUTER] 审计行——记录本次「经 MCP 路由调用工具」的
   *    协议级事实（与步骤 3 中 store 写的 [KUBE-CONTROLLER] 控制器行互补：
   *    前者说「谁调用了什么工具」，后者说「控制器执行结果如何」）；
   * 5. **selectEntity 引导 3D 相机聚焦到被修复实体**——这是「对话 → 空间」
   *    的反向联动：用户在聊天流里修好了一个 Pod，左侧画布立刻飞过去展示
   *    修复结果。若不聚焦，用户可能完全不知道"我修的是哪一台"，
   *    自愈就变成了一个抽象的按钮，而非可验证的空间事件；
   * 6. 转入 done 态，最后回调 onActionExecuted 向上冒泡。
   *
   * 【为何延迟 600ms 再调用 healEntity】这不是无意义的等待：
   * 它给用户一个「操作已受理、正在执行」的确定反馈，且在此期间按钮禁用，
   * 彻底杜绝连点造成的重复自愈与免疫窗口误触发。
   *
   * 【回调顺序保证】onActionExecuted 放在 healEntity、日志与 selectEntity
   * 之后调用，确保父级收到回调时 store 与终端已是最新状态，避免「回调读到旧值」。
   */
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
   *
   * 【失败静默回退键盘】条件不满足时这里**什么都不做、也不报错**：
   * 用户仍然可以点击按钮或勾选复选框完成确认，不会因为语音失败而卡住。
   */
  useEffect((): (() => void) => {
    const onVoiceConfirm = (): void => {
      if (phase !== 'idle' && phase !== 'failed') return;
      if (isHighRisk && !acknowledged) return;
      executeRef.current?.();
    };
    window.addEventListener('kv-voice-confirm', onVoiceConfirm);
    return (): void => window.removeEventListener('kv-voice-confirm', onVoiceConfirm);
  }, [phase, isHighRisk, acknowledged]);

  /** 最新 handleExecute 引用（语音确认监听通过它调用，避免闭包过期） */
  const executeRef = useRef<(() => void) | null>(null);

  const handleExecute = useCallback((): void => {
    if (phase !== 'idle' && phase !== 'failed') return;
    if (isHighRisk && !acknowledged) return;

    setPhase('executing');
    setFailureReason('');

    /**
     * 【执行前解析真实目标】卡片是流式渲染期创建的，targetId 可能已失效：
     * 1. 旧版本持久化的会话历史（里面可能存着 'n/a'）；
     * 2. 集群状态在卡片生成后发生变化（目标 Pod 已被删除）。
     * 这两种情况下 healEntity / selectEntity 拿到不存在的 ID 会产生
     * "修复空气"的假动作：3D 无变化、相机找不到目标、终端却打印成功回执。
     *
     * 【B3 修复：**禁止静默替换目标**】
     *
     * 旧实现找不到 targetId 时会回退到 `snapshot.pods[0]`：用户确认的是
     * "重启 payment-gateway"，实际被重启的却是列表里第一个 Pod。这是
     * 比"操作失败"严重得多的缺陷——确认对象与执行对象不一致，属越权副作用。
     *
     * 正确行为：目标不存在就**停在确认态**并明确提示"目标已不存在，
     * 请重新诊断"，让用户重新拿到一张目标正确的卡，而不是替他猜一个。
     */
    const snapshot = useClusterStore.getState().snapshotSummary;
    const targetExists =
      snapshot.pods.some((pod): boolean => pod.id === targetId) ||
      snapshot.nodes.some((node): boolean => node.id === targetId);

    if (!targetExists) {
      appendTerminalLog(
        `[MCP-ROUTER] ABORTED ${actionType} -> target ${targetId} not in current snapshot`,
      );
      setFailureReason('目标已不存在于当前快照，请重新诊断后确认');
      setPhase('failed');
      return;
    }

    /* 走到这里 targetId 一定存在：确认对象 === 执行对象 */
    const effectiveTargetId: string = targetId;

    /** 实体类型按**实际目标**重新推导，而非沿用动作卡的原始假设 */
    const effectiveEntityType: SelectedEntityType =
      snapshot.nodes.some((node): boolean => node.id === effectiveTargetId) ? 'node' : 'pod';

    /** 当前快照中的目标 Pod（Node 场景为 undefined） */
    const targetPod = snapshot.pods.find((pod): boolean => pod.id === effectiveTargetId);

    /** 展示名：优先用卡片已知的名字，否则剥前缀作为近似 */
    const effectiveTargetName =
      targetPod?.name ??
      snapshot.nodes.find((node): boolean => node.id === effectiveTargetId)?.name ??
      targetName;

    /**
     * ================= 步骤 1：真实调用服务端 MCP 执行端点 =================
     *
     * 【顺序为何是「先请求服务端，再改本地状态」】
     * 反过来的话（先 healEntity 再请求），一旦服务端返回失败，
     * 本地 3D 场景已经变绿、终端已经打印成功行——这时再去纠正，
     * 用户看到的是"先成功后失败"的闪烁，且无法判断到底成没成。
     *
     * 正确顺序是：**服务端确认受理 → 本地才宣布成功**。
     * 这样"已执行"这个状态永远是服务端背书的，而不是客户端自说自话。
     *
     * 【为何保留 600ms 动画】服务端模拟路径有 220ms、真实集群可能更久，
     * 动画在此期间持续播放，让"正在执行"有确定的可感知时长。
     * 动画与服务端请求是并行的，不额外增加总耗时。
     */
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const animationDone = new Promise<void>((resolve): void => {
      timerRef.current = setTimeout((): void => {
        timerRef.current = null;
        resolve();
      }, EXECUTION_ANIMATION_MS);
    });

    const requestDone = (async (): Promise<McpExecuteReceipt> => {
      const timeout = setTimeout((): void => controller.abort(), MCP_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(MCP_EXECUTE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actionType,
            targetId: effectiveTargetId,
            targetName: effectiveTargetName,
            /*
             * 【B2 修复：命名空间由前端带过去】
             * 目标 Pod 的 namespace 只有前端快照知道；服务端若写死 'default'，
             * live 集群会删错命名空间或 404。这里从当前快照解析真实 namespace。
             */
            ...(targetPod !== undefined ? { namespace: targetPod.namespace } : {}),
            clusterMode: useClusterStore.getState().connectionMode,
          }),
          signal: controller.signal,
        });

        const payload: unknown = await response.json();

        if (isRpcSuccess(payload)) return payload.result;

        if (isRpcFailure(payload)) {
          throw new Error(
            payload.error.data !== undefined
              ? `${payload.error.message}: ${payload.error.data}`
              : payload.error.message,
          );
        }
        throw new Error(`unexpected response shape (HTTP ${response.status})`);
      } finally {
        clearTimeout(timeout);
      }
    })();

    void (async (): Promise<void> => {
      try {
        /* 动画与服务端请求并行等待：两者都完成才进入结果态 */
        const [result] = await Promise.all([requestDone, animationDone]);
        if (controller.signal.aborted) return;

        abortRef.current = null;
        setReceipt(result);

        /* ---- 步骤 2：服务端已受理 → 落地本地自愈 ---- *
         * healEntity 内部完成：免疫去重 → 派生愈合快照 → 计算前后对比
         * → 双轨分发 → 终端审计。 */
        /*
         * 【C2：免疫窗口内必须**明确拒绝**并展示剩余秒数】
         * healEntity 现在返回 HealOutcome；窗口内重复自愈返回 ok:false，
         * 卡片必须停在失败态并显示"剩余 N 秒"，而不是假装执行成功。
         */
        const healOutcome = healEntity(effectiveTargetId, actionType);
        if (!healOutcome.ok) {
          abortRef.current = null;
          setFailureReason(healOutcome.message);
          setPhase('failed');
          return;
        }

        /* ---- 步骤 3：MCP 协议级审计回显 ---- *
         * 与 store 写的 [KUBE-CONTROLLER] 控制器行互补：
         * 前者说「谁通过什么通道调用了什么工具」，后者说「执行结果如何」。 */
        appendTerminalLog(
          `[MCP-ROUTER] ${result.executionId} invoked ${result.toolUri} -> ${result.targetName} healed in ${result.latencyMs}ms (${result.mode})`,
        );
        appendTerminalLog(`[MCP-ROUTER] equivalent: ${result.kubectlCommand}`);

        /* ---- 步骤 4：引导 3D 相机聚焦被修复实体 ---- *
         * 必须在 healEntity 之后：CameraRig 的 focus effect 依赖
         * selectedEntityId 变化，此时快照已是愈合态，
         * 相机飞过去看到的就是"已修复"的绿色实例——时序上因果正确。 */
        selectEntity(effectiveTargetId, effectiveEntityType);

        /* ---- 步骤 5：切换成功态并向上冒泡 ---- */
        setPhase('done');
        onActionExecuted?.(targetId, actionType);
      } catch (error) {
        if (controller.signal.aborted) return;
        abortRef.current = null;

        /**
         * 【失败必须如实显示】服务端拒绝（权限/资源不存在/网络）时，
         * 不修改本地状态、不打印成功行，只记录失败原因并回到可重试态。
         * 让用户看到"执行失败 + 为什么"，而不是一个假的成功动画。
         */
        const message = error instanceof Error ? error.message : String(error);
        setFailureReason(message);
        setPhase('failed');
        appendTerminalLog(`[MCP-ROUTER] FAILED ${actionType} on ${effectiveTargetId} -> ${message}`);
      }
    })();
  }, [

    acknowledged,
    actionType,
    appendTerminalLog,
    healEntity,
    isHighRisk,
    onActionExecuted,
    phase,
    selectEntity,
    targetId,
    targetName,
  ]);

  /* 捕获最新 handleExecute（effect 中同步，避免渲染期副作用） */
  useEffect((): void => {
    executeRef.current = handleExecute;
  }, [handleExecute]);

  /*
   * 【渲染一律读 effectivePhase】直接用 phase 会让"导演已降级执行"的卡片
   * 停留在待执行态，与字幕的"自愈完成"同屏矛盾。
   */
  const isExecuting = effectivePhase === 'executing';
  const isDone = effectivePhase === 'done';
  const isFailed = effectivePhase === 'failed';

  /** 按钮是否禁用：执行中 / 已完成 / 高危未勾选 */
  const buttonDisabled = isExecuting || isDone || (isHighRisk && !acknowledged);

  return (
    <div
      className={cn(
        'w-full overflow-hidden rounded-md border bg-slate-900/70',
        isHighRisk ? 'border-rose-500/60 shadow-glow-rose' : 'border-cyan-500/40',
      )}
      aria-label={`自愈操作确认：${ACTION_LABEL[actionType]} ${targetName}${
        demoAutoConfirm ? '（自动演示模式：导演将代为勾选并执行）' : ''
      }`}
      /*
       * C 项：自动演示标识。
       *
       * 【为什么必须显式标记】自动勾选 + 自动点击若不声明，评委看到的是
       * "卡片自己动了一下"，很像绕过护栏的作弊。带 data-demo-auto 后它是
       * 一个可查、可读屏的被声明编排行为。
       */
      data-demo-auto={demoAutoConfirm ? 'true' : 'false'}
      /*
       * 【导演引擎读取口】自动路演需要知道"这张卡要修的是哪个实体"。
       * aria-label 只含可读名（redis-cluster-shard-0），不含 pod-xxx 的实体 ID，
       * 从文本反解不稳定；故把真实 ID 作为 data 属性暴露出去。
       * 仅作机器读取，不影响任何视觉与可访问性语义。
       */
      data-target-id={targetId}
    >
      {/* ============ 头部：动作徽标 + 目标 ============ */}
      <div className="flex items-start gap-2 p-2.5 pb-2">
        <span
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border',
            isHighRisk
              ? 'border-rose-500/60 bg-rose-500/15'
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
              <span className="rounded border border-rose-500/50 bg-rose-500/15 px-1 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-rose-300">
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
        <div className="flex items-center gap-1 rounded border border-white/[0.07]/70 bg-slate-800/50 px-1.5 py-1">
          <Terminal className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
          <code className="truncate font-mono text-[11px] text-slate-400">{mcpEndpoint}</code>
        </div>
      </div>

      {/* ============ 参数说明 ============ *
       * 【为何改为 MarkdownLite 渲染】paramDescription 由大模型生成，
       * 实测会输出「当前**建议暂缓执行**」与「`kubectl cordon --grace-period=300`」
       * 这类带标记的说明。直接 `<p>{paramDescription}</p>` 会把 ** 与反引号
       * 原样暴露给用户——在一个"要求用户确认高危操作"的卡片上出现语法噪音，
       * 会直接削弱这个安全闸门的严肃性。
       */}
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
            disabled={isExecuting || isDone}
            className="mt-[2px] h-3 w-3 shrink-0 cursor-pointer accent-rose-500"
            aria-label="确认已知晓高危操作风险"
          />
          <span className="min-w-0 text-[12px] leading-relaxed text-rose-200/90">
            我已知晓该操作将影响生产环境，确认立即执行（此操作会记录审计日志）
          </span>
        </label>
      ) : null}

      {/* ============ 执行按钮（含 600ms 流光动画） ============ */}
      <div className="px-2.5 pb-2.5">
        <button
          type="button"
          data-demo-auto={demoAutoConfirm ? 'true' : 'false'}
          /*
           * 用 title 而非 aria-description：button 角色不支持
           * aria-description（jsx-a11y/role-supports-aria-props），
           * 而 title 既能被辅助技术读出、也会悬停显示，正好承担
           * "这是自动演示"的说明职责。卡片根元素的 aria-label 已声明整体模式。
           */
          title={
            demoAutoConfirm ? '自动演示模式：本按钮将由导演引擎代为点击' : '执行自愈方案'
          }
          onClick={handleExecute}
          disabled={buttonDisabled}
          className={cn(
            'relative w-full overflow-hidden rounded border px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all',
            isDone
              ? 'cursor-default border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
              : isExecuting
                ? 'cursor-wait border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                : buttonDisabled
                  ? 'cursor-not-allowed border-white/[0.07] bg-slate-800/50 text-slate-500'
                  : isHighRisk
                    ? 'border-rose-500/60 bg-rose-500/15 text-rose-200 hover:border-rose-400 hover:bg-rose-500/25 active:scale-[0.985]'
                    : 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200 hover:border-cyan-400 hover:bg-cyan-500/25 active:scale-[0.985]',
          )}
        >
          {/* 600ms 流光扫过（执行中可见，方向左→右，与骨架屏动画语言一致）。
              用 framer-motion 而非自定义 CSS keyframes：本组件已依赖 motion，
              运行时注入动画可避免依赖 globals.css 中未必存在的 kv-exec-sweep 类，
              保证组件自包含、可独立复用。 */}
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
            ) : isFailed ? (
              <>
                <CircleAlert className="h-3 w-3" aria-hidden />
                执行失败 · 点击重试
              </>
            ) : (
              <>
                <Wrench className="h-3 w-3" aria-hidden />
                {isHighRisk && !acknowledged ? '需二次确认' : '立即执行自愈方案'}
              </>
            )}
          </span>
        </button>
      </div>

      {/* ============ 失败态：如实展示服务端拒绝原因 ============ */}
      {isFailed ? (
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

          {/*
           * ---- 服务端执行回执 ----
           *
           * 【为何要展示这些字段】在引入真实 MCP 调用之前，"已执行"是客户端
           * 自己宣布的——没有任何外部证据。现在服务端返回了 executionId /
           * latencyMs / auditDigest，把这三项摆出来，用户才能：
           * 1. 拿 executionId 去服务端日志对账；
           * 2. 用 latencyMs 判断执行是否异常缓慢；
           * 3. 用 kubectlCommand 复核实际做了什么（懂 K8s 的人一眼看出影响范围）。
           */}
          {receipt !== null ? (
            <div className="mt-1.5 rounded border border-emerald-500/20 bg-emerald-500/[0.04] p-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-emerald-300/70">
                <span className="text-emerald-400">[MCP RECEIPT]</span>
                <span>{receipt.executionId}</span>
                <span className="text-slate-500">·</span>
                <span>{receipt.latencyMs}ms</span>
                <span className="text-slate-500">·</span>
                <span className={receipt.mode === 'real' ? 'text-emerald-400' : 'text-amber-300/80'}>
                  {receipt.mode === 'real' ? 'LIVE CLUSTER' : 'SIMULATED'}
                </span>
              </div>

              {/* 等价 kubectl 命令条：运维人员可直接复制复核 */}
              <pre className="mt-1 overflow-x-auto rounded bg-slate-950/70 px-1.5 py-1 font-mono text-[10px] leading-relaxed text-cyan-300/90">
                <code>$ {receipt.kubectlCommand}</code>
              </pre>

              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <p className="font-mono text-[10px] text-slate-500">audit digest: {receipt.auditDigest}</p>
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

          {/* ---- 自愈前后指标对比面板 ---- */}
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
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-400">
        {before.toFixed(unit === '' ? 0 : 1)}
        {unit}
      </span>
      <span className="text-slate-500">→</span>
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
      <span className="text-slate-500">状态</span>
      <span className="text-slate-400">{before}</span>
      <span className="text-slate-500">→</span>
      <span className={toneClass}>{after}</span>
    </span>
  );
}