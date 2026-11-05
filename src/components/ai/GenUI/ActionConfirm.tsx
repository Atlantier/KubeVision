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
import { CheckCircle2, Loader2, ShieldAlert, Terminal, Wrench } from 'lucide-react';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import type { ActionConfirmProps, RemediationActionType } from '@/types/ai';

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
 * - 'executing' → 600ms 流光动画进行中（按钮禁用，防重复触发）
 * - 'done'      → 已执行完毕（展示成功态，可再次执行的入口不提供）
 */
type ExecutionPhase = 'idle' | 'executing' | 'done';

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
  const healEntity = useClusterStore((s): ((targetId: string, actionType: string) => void) => s.healEntity);
  const appendTerminalLog = useClusterStore((s): ((line: string) => void) => s.appendTerminalLog);

  /** 高危确认勾选态（非高危动作恒为 true，无需勾选） */
  const [acknowledged, setAcknowledged] = useState<boolean>(!isHighRisk);

  /** 执行阶段状态机 */
  const [phase, setPhase] = useState<ExecutionPhase>('idle');

  /** 600ms 定时器句柄（卸载时必须清理，否则会对已卸载组件 setState） */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 卸载清理：杜绝定时器泄漏与「对已卸载组件 setState」警告 */
  useEffect(() => {
    return (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
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
   * 5. 转入 done 态，最后回调 onActionExecuted 向上冒泡。
   *
   * 【为何延迟 600ms 再调用 healEntity】这不是无意义的等待：
   * 它给用户一个「操作已受理、正在执行」的确定反馈，且在此期间按钮禁用，
   * 彻底杜绝连点造成的重复自愈与免疫窗口误触发。
   *
   * 【回调顺序保证】onActionExecuted 放在 healEntity 与日志之后调用，
   * 确保父级收到回调时 store 与终端已是最新状态，避免「回调读到旧值」。
   */
  const handleExecute = useCallback((): void => {
    if (phase !== 'idle') return;
    if (isHighRisk && !acknowledged) return;

    setPhase('executing');

    timerRef.current = setTimeout((): void => {
      timerRef.current = null;

      /* ---- 步骤 3：执行自愈（3D 场景中的故障实体当场转绿） ---- */
      healEntity(targetId, actionType);

      /* ---- 步骤 4：MCP 路由审计回显 ---- *
       * 前缀 [MCP-ROUTER] 已被 TerminalEcho 的 TONE_RULES 映射为 router 色调
       * （sky-300 天蓝），与控制器行（cyan-300）在视觉上明确区分：
       * 天蓝代表「协议层调用」，青色代表「K8s 控制器动作」。 */
      appendTerminalLog(
        `[MCP-ROUTER] Invoked mcp://k8s-cluster/tools/${actionType} -> Target ${targetId} healed`,
      );

      /* ---- 步骤 5：切换成功态并向上冒泡回调 ---- */
      setPhase('done');
      onActionExecuted?.(targetId, actionType);
    }, EXECUTION_ANIMATION_MS);
  }, [acknowledged, actionType, appendTerminalLog, healEntity, isHighRisk, onActionExecuted, phase, targetId]);

  const isExecuting = phase === 'executing';
  const isDone = phase === 'done';

  /** 按钮是否禁用：执行中 / 已完成 / 高危未勾选 */
  const buttonDisabled = isExecuting || isDone || (isHighRisk && !acknowledged);

  return (
    <div
      className={cn(
        'w-full overflow-hidden rounded-md border bg-slate-900/70 backdrop-blur-sm',
        isHighRisk ? 'border-rose-500/60 shadow-glow-rose' : 'border-cyan-500/40',
      )}
      aria-label={`自愈操作确认：${ACTION_LABEL[actionType]} ${targetName}`}
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
              <span className="rounded border border-rose-500/50 bg-rose-500/15 px-1 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-rose-300">
                high&nbsp;risk
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-slate-300" title={targetName}>
            target&nbsp;·&nbsp;{targetName}
          </p>
        </div>
      </div>

      {/* ============ MCP 协议端点标识 ============ */}
      <div className="px-2.5 pb-2">
        <div className="flex items-center gap-1 rounded border border-slate-700/70 bg-slate-800/50 px-1.5 py-1">
          <Terminal className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
          <code className="truncate font-mono text-[9px] text-slate-400">{mcpEndpoint}</code>
        </div>
      </div>

      {/* ============ 参数说明 ============ */}
      <div className="px-2.5 pb-2">
        <p className="text-[10px] leading-relaxed text-slate-400">{paramDescription}</p>
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
          <span className="min-w-0 text-[9.5px] leading-relaxed text-rose-200/90">
            我已知晓该操作将影响生产环境，确认立即执行（此操作会记录审计日志）
          </span>
        </label>
      ) : null}

      {/* ============ 执行按钮（含 600ms 流光动画） ============ */}
      <div className="px-2.5 pb-2.5">
        <button
          type="button"
          onClick={handleExecute}
          disabled={buttonDisabled}
          className={cn(
            'relative w-full overflow-hidden rounded border px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all',
            isDone
              ? 'cursor-default border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
              : isExecuting
                ? 'cursor-wait border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                : buttonDisabled
                  ? 'cursor-not-allowed border-slate-700 bg-slate-800/50 text-slate-600'
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
                executed&nbsp;·&nbsp;3d&nbsp;state&nbsp;recovered
              </>
            ) : isExecuting ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                executing…
              </>
            ) : (
              <>
                <Wrench className="h-3 w-3" aria-hidden />
                {/* 注意：这里必须用真实空格而非 &nbsp; 实体——
                    三元表达式返回的是 JS 字符串，不会经过 JSX 的 HTML 实体解析，
                    写成 'confirm&nbsp;required' 会原样渲染出字面量 "&nbsp;"。 */}
                {isHighRisk && !acknowledged ? 'confirm required' : 'execute remediation'}
              </>
            )}
          </span>
        </button>
      </div>

      {/* ============ 执行完成后的回执 ============ */}
      {isDone ? (
        <p className="border-t border-slate-800 px-2.5 py-1.5 font-mono text-[8.5px] uppercase tracking-wider text-emerald-400/80">
          ✓ heal dispatched → immunity window registered → 3d viewport updated
        </p>
      ) : null}
    </div>
  );
}
