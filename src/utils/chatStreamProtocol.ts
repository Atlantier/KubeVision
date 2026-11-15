/**
 * KubeVision AI — NDJSON 双引擎流式协议（chatStreamProtocol）
 *
 * 【为什么需要这个模块】
 * 双引擎（A 真实 LLM / B 确定性仿真器）+ 一次请求内可能发生的回落，
 * 让事件流出现了三类只有"看全局"才能发现的缺陷：
 *   1. 引擎 A 已发出 tool-start 后失败 → 回落引擎 B 重发三卡
 *      → **同一条消息里出现重复卡片**（用户看到两张指标卡）；
 *   2. 引擎 A 的 tool-start 没有配对 tool-result → 卡片骨架屏**永久悬空**；
 *   3. 流末没有任何"完成"标记 → 前端只能靠 socket 关闭判断结束。
 *
 * 这些问题都是**事件流全局性质**，不是某个函数局部的 bug。
 * 因此把"谁发出去了、谁还欠result、流是否收尾"抽成纯逻辑放进本模块，
 * 路由层只负责调用；测试可以直接对这一层断言（无需起服务、无需真实模型）。
 *
 * 【约定】
 * - 本模块零依赖（仅类型），可在 Node 测试中直接转译运行；
 * - 所有函数是纯函数或显式账本变更，不读 Date.now()、不碰 DOM；
 * - 未知事件 type 一律忽略（向前兼容）。
 */

import type { ChatStreamEvent } from '@/types/ai';

/* ========================================================================== */
/* 工具调用账本                                                                 */
/* ========================================================================== */

/** 一次工具调用的生命周期状态 */
export type ToolCallState = 'pending' | 'completed' | 'failed';

/** 工具调用账本条目 */
export interface ToolCallEntry {
  readonly toolCallId: string;
  readonly toolName: string;
  state: ToolCallState;
}

/**
 * ToolCallLedger —— 单次请求内所有工具调用的全局账本。
 *
 * 【为什么服务端必须持有它】回落时引擎 B 不知道引擎 A 已经发过哪几张卡；
 * 若不共享账本，B 会把三张卡全部重发一遍。有了账本，B 只补缺失的卡。
 */
export interface ToolCallLedger {
  /** toolCallId → 条目（保持插入顺序，便于按序补发） */
  readonly entries: Map<string, ToolCallEntry>;
  /** 已成功产出 result 的工具名集合（用于回落补差集） */
  readonly completedToolNames: Set<string>;
}

/** 创建空账本 */
export function createToolCallLedger(): ToolCallLedger {
  return { entries: new Map(), completedToolNames: new Set() };
}

/**
 * 登记一次 tool-start。
 *
 * 【幂等】同一 toolCallId 重复登记直接忽略（重复 tool-start 是缺陷，
 * 但用重复登记来"报错"只会让流更难恢复；这里保持一致、由断言脚本抓）。
 *
 * @param ledger 账本
 * @param toolCallId 调用 id
 * @param toolName 工具名
 * @returns 是否为首次登记
 */
export function recordToolStart(ledger: ToolCallLedger, toolCallId: string, toolName: string): boolean {
  if (ledger.entries.has(toolCallId)) return false;
  ledger.entries.set(toolCallId, { toolCallId, toolName, state: 'pending' });
  return true;
}

/**
 * 登记一次 tool-result。
 *
 * @param ledger 账本
 * @param toolCallId 调用 id
 * @param ok 是否为成功载荷（错误/取消时 false）
 * @returns 本次登记是否有效（未知 id 返回 false，表示孤儿 result）
 */
export function recordToolResult(ledger: ToolCallLedger, toolCallId: string, ok: boolean): boolean {
  const entry = ledger.entries.get(toolCallId);
  if (entry === undefined) return false;
  entry.state = ok ? 'completed' : 'failed';
  if (ok) ledger.completedToolNames.add(entry.toolName);
  return true;
}

/** 仍在等待 result 的调用（按发出顺序） */
export function pendingToolCalls(ledger: ToolCallLedger): readonly ToolCallEntry[] {
  return [...ledger.entries.values()].filter((entry): boolean => entry.state === 'pending');
}

/**
 * 计算引擎 B 回落时"还应该补哪些卡"。
 *
 * @param ledger 账本（引擎 A 已登记）
 * @param allowedTools 当前意图允许的工具（保持展示顺序）
 * @returns 需要补的工具名
 */
export function missingToolNames(
  ledger: ToolCallLedger,
  allowedTools: readonly string[],
): readonly string[] {
  return allowedTools.filter((name): boolean => !ledger.completedToolNames.has(name));
}

/* ========================================================================== */
/* 孤儿自愈                                                                     */
/* ========================================================================== */

/**
 * repairPendingToolCalls —— 为所有悬空 tool-start 补发终止事件。
 *
 * 【自愈什么】引擎 A 中途失败时，已发出的 tool-start 没有配对 result，
 * 前端卡片会永远显示骨架屏。这里统一补发 `status:'error'` 的 tool-result，
 * 前端据此渲染"生成失败，点击重试"，而不是无限转圈。
 *
 * 【为什么补 tool-result 而不是删除】删除会让卡片凭空消失（用户困惑）；
 * 补一条明确的失败态，用户知道"这次没成功"，也知道可以重试。
 *
 * @param ledger 账本
 * @param emit 事件发射器
 * @param reason 失败原因（写入 result 便于排查）
 * @returns 补发的条数
 */
export function repairPendingToolCalls(
  ledger: ToolCallLedger,
  emit: (event: ChatStreamEvent) => void,
  reason: string,
): number {
  const pending = pendingToolCalls(ledger);
  for (const entry of pending) {
    emit({
      type: 'tool-result',
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      args: null,
      status: 'error',
      errorMessage: reason,
    });
    entry.state = 'failed';
  }
  return pending.length;
}

/* ========================================================================== */
/* 事件流校验（金样 / 单测 / 录屏回放共用）                                       */
/* ========================================================================== */

/** 一条校验违例 */
export interface StreamViolation {
  /** 违规事件的下标（-1 表示流末性质） */
  readonly index: number;
  /** 违规类型 */
  readonly kind:
    | 'duplicate-tool-call-id'
    | 'orphan-tool-result'
    | 'unpaired-tool-start'
    | 'missing-terminal'
    | 'duplicate-terminal'
    | 'reasoning-out-of-order';
  /** 人类可读说明 */
  readonly detail: string;
}

/**
 * validateStreamEvents —— 校验一条完整事件流的全局性质。
 *
 * 校验项（与任务书 A1/A2/A8 对应）：
 * 1. toolCallId 不得重复（重复 start = 卡片重复挂载）；
 * 2. 不得出现孤儿 tool-result（result 必须能配到 start）；
 * 3. 流结束时不得有未配对的 tool-start（骨架屏悬空）；
 * 4. 流末必须且有且仅有一个终止事件 done（R2：doneCount!==1 为唯一判据，engine 不算终止）；
 * 5. reasoning 步骤的 stepIndex 必须严格递增（思考链乱序）。
 *
 * @param events 事件序列
 * @returns 违例列表（空数组表示合法）
 */
export function validateStreamEvents(events: readonly ChatStreamEvent[]): StreamViolation[] {
  const violations: StreamViolation[] = [];
  const started = new Map<string, string>();
  const results = new Set<string>();
  let lastStepIndex = -1;

  events.forEach((event, index) => {
    if (event.type === 'tool-start') {
      if (started.has(event.toolCallId)) {
        violations.push({
          index,
          kind: 'duplicate-tool-call-id',
          detail: `tool-start 重复 toolCallId=${event.toolCallId}（${event.toolName}）`,
        });
      } else {
        started.set(event.toolCallId, event.toolName);
      }
      return;
    }

    if (event.type === 'tool-result') {
      if (!started.has(event.toolCallId)) {
        violations.push({
          index,
          kind: 'orphan-tool-result',
          detail: `tool-result 找不到对应 tool-start：${event.toolCallId}`,
        });
      } else if (results.has(event.toolCallId)) {
        violations.push({
          index,
          kind: 'duplicate-terminal',
          detail: `同一 toolCallId 收到重复 result：${event.toolCallId}`,
        });
      }
      results.add(event.toolCallId);
      return;
    }

    if (event.type === 'reasoning') {
      const stepIndex = event.step.stepIndex;
      if (stepIndex <= lastStepIndex) {
        violations.push({
          index,
          kind: 'reasoning-out-of-order',
          detail: `reasoning stepIndex 未严格递增：${lastStepIndex} → ${stepIndex}`,
        });
      }
      lastStepIndex = stepIndex;
      return;
    }

    /*
     * 【终止事件口径 · R2】done 是**唯一**终止标记，收尾判定只看 done（见下方 doneCount）。
     * engine 只是"实际引擎声明"，回落场景天然会出现两条（先 llm 后 simulator），
     * 它不是终止标记，不参与计数；reset 是轮换复位声明，同样不是终止标记。
     * 这里不再维护只写不读的 terminalKinds / terminalCount。
     */
  });

  for (const [toolCallId, toolName] of started) {
    if (!results.has(toolCallId)) {
      violations.push({
        index: events.length,
        kind: 'unpaired-tool-start',
        detail: `tool-start 没有配对 result：${toolName}（${toolCallId}）`,
      });
    }
  }

  /*
   * 【R2 · done 唯一判据】收尾只看 done：doneCount !== 1 即违例。
   * 0 条 = 流末缺终止（截断）；>1 条 = 重复终止。engine / reset 不参与计数。
   * 不再保留只写不读的 terminalKinds。
   */
  const doneCount = events.filter((event) => event.type === 'done').length;
  if (doneCount === 0) {
    violations.push({
      index: events.length,
      kind: 'missing-terminal',
      detail: '流末缺少终止事件 done',
    });
  } else if (doneCount > 1) {
    violations.push({
      index: events.length,
      kind: 'duplicate-terminal',
      detail: `终止事件 done 出现 ${doneCount} 次（应唯一）`,
    });
  }

  return violations;
}