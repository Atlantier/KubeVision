/**
 * KubeVision AI — NDJSON 流式消费确定性内核（R2 · 可单测的纯逻辑）
 *
 * 【为什么抽成独立模块】流式收尾的缺陷（半行丢尾、UTF-8 跨 chunk 乱码、finalize 悬空、
 * 排队覆盖、看门狗泄漏）都是"状态流转"问题，散落在 React 组件里无法单测。这里把
 * 行解析、收尾三态、会话生命周期抽成纯逻辑：不读 DOM、不依赖 React，注入副作用回调，
 * 测试可以直接对这一层断言（无需起服务、无需渲染组件）。
 *
 * 【UTF-8 跨 chunk 与半行状态流转】
 * TextDecoder 以 { stream: true } 解码时，会把"落在 chunk 边界的不完整多字节序列"
 * 缓存在解码器内部，等下一个 chunk 补齐——因此中文被切成两半也不会乱码。行缓冲 buffer
 * 只保留"最后一个 '\n' 之后的半行"，等下一 chunk 拼齐。流末必须调用 flush()：
 * 先 decoder.decode()（stream:false）把解码器里残留的字节冲刷成字符，再把 buffer 里
 * 最后一条没有 '\n' 结尾的残行当作完整行消费——否则"去掉 done 的截断流"会丢尾。
 */

import type { ChatStreamEvent } from '@/types/ai';

/* ========================================================================== */
/* 收尾三态                                                                     */
/* ========================================================================== */

/** 流收尾三态：正常 / 不完整 / 出错 */
export type StreamFinalization = 'normal' | 'incomplete' | 'error';

/**
 * resolveFinalizationState —— 由"是否收到 done / 是否解析出错"推导收尾三态。
 *
 * 【判据优先级】解析出错 → error（最高，内容不可信）；否则收到唯一 done → normal；
 * 否则（连接关闭却没等到 done，多为代理截断）→ incomplete。incomplete 不冒充正常结束，
 * 前端据此渲染「回答可能不完整」+ 重新生成。
 *
 * @param doneReceived 是否收到过 done 事件
 * @param parseError 是否出现过畸形帧 / 解析错误
 * @returns 收尾三态
 */
export function resolveFinalizationState(doneReceived: boolean, parseError: boolean): StreamFinalization {
  if (parseError) return 'error';
  return doneReceived ? 'normal' : 'incomplete';
}

/* ========================================================================== */
/* NDJSON 行解析器（UTF-8 跨 chunk 安全 + 半行缓冲 + 流末 flush）                 */
/* ========================================================================== */

/** 行解析器回调集 */
export interface NdjsonLineParserHandlers {
  /** 消费一条已通过形状校验的合法事件 */
  readonly onEvent: (event: ChatStreamEvent) => void;
  /** 畸形行（JSON 损坏 / 形状不合法）回调；缺省则静默跳过，不中断整条流 */
  readonly onMalformedLine?: (line: string) => void;
  /** 运行时形状守卫（注入 zod 的 isChatStreamEvent）；把校验与解析解耦 */
  readonly validate: (value: unknown) => value is ChatStreamEvent;
}

/** 行解析器句柄 */
export interface NdjsonLineParser {
  /** 喂入一个原始字节 chunk（内部处理 UTF-8 跨 chunk 与半行缓冲） */
  readonly push: (chunk: Uint8Array) => void;
  /** 流末冲刷：decoder.decode()(stream:false) + 消费最后一条残行，保证不丢尾 */
  readonly flush: () => void;
}

/**
 * createNdjsonLineParser —— 构造 UTF-8 安全的 NDJSON 行解析器。
 *
 * 【状态流转】buffer 恒为"尚未遇到 '\n' 的半行"。push 时把解码文本追加进 buffer，
 * 循环切出每个完整行交给 consumeLine；flush 时先冲刷解码器残留字节，再把剩余 buffer
 * 作为最后一行消费。consumeLine 内部：trim → 空行跳过 → JSON.parse（损坏则降级回调）
 * → validate 形状校验（不合法则降级回调）→ onEvent 分派。任何一步失败都不抛错、
 * 不中断整条流，畸形帧走降级而非崩溃。
 *
 * @param handlers 回调集（onEvent / onMalformedLine / validate）
 * @returns 行解析器句柄
 */
export function createNdjsonLineParser(handlers: NdjsonLineParserHandlers): NdjsonLineParser {
  const decoder = new TextDecoder();
  let buffer = '';

  /**
   * consumeLine —— 消费单行：解析 + 形状校验 + 分派。
   *
   * 【为什么不抛错】流式链路里一条坏行不该让整条诊断流陪葬；损坏行 / 畸形帧
   * 交给 onMalformedLine 降级处理，其余行继续消费。
   *
   * @param rawLine 去掉 '\n' 的原始行（可能含首尾空白）
   */
  const consumeLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      handlers.onMalformedLine?.(line);
      return;
    }
    if (!handlers.validate(parsed)) {
      handlers.onMalformedLine?.(line);
      return;
    }
    handlers.onEvent(parsed);
  };

  return {
    push(chunk: Uint8Array): void {
      /* stream:true 让解码器缓存跨 chunk 的不完整多字节序列（中文不乱码） */
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        consumeLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    },
    flush(): void {
      /* stream:false 冲刷解码器内部残留字节，再消费最后一条无 '\n' 的残行（不丢尾） */
      buffer += decoder.decode();
      if (buffer.trim().length > 0) consumeLine(buffer);
      buffer = '';
    },
  };
}

/* ========================================================================== */
/* 会话生命周期（finalize 幂等 + FIFO 排队 + 看门狗）                             */
/* ========================================================================== */

/** 会话收尾触发原因 */
export type SessionEndReason = 'done' | 'incomplete' | 'error' | 'abort';

/** 会话副作用回调集（由组件注入真实 setState / 定时器；测试注入记录型替身） */
export interface ChatStreamSessionEffects {
  /** 组件级 isStreaming（驱动输入框可用性） */
  readonly setStreaming: (value: boolean) => void;
  /** 全局 copilotStreaming（驱动导演事件门） */
  readonly setCopilotStreaming: (value: boolean) => void;
  /** 消息级收尾补丁（isStreaming / incomplete / failed） */
  readonly patchAssistant: (patch: { isStreaming: boolean; incomplete?: boolean; failed?: boolean }) => void;
  /** 定时器抽象（真实 window.setTimeout / 测试替身） */
  readonly schedule: (fn: () => void, ms: number) => number;
  /** 取消定时器抽象 */
  readonly cancel: (id: number) => void;
  /** FIFO 出队一条并发送（队列由组件跨会话共享，见 createPromptQueue）；幂等只调一次 */
  readonly drainQueue: () => void;
  /** 请求 TTS 播报（仅正常 / 不完整收尾，abort/error 不播报） */
  readonly requestTts: () => void;
  /** 骨架看门狗超时回调（把对应卡片转失败态） */
  readonly onWatchdogTimeout?: (toolCallId: string) => void;
}

/** 会话句柄 */
export interface ChatStreamSession {
  readonly markDone: () => void;
  readonly markParseError: () => void;
  readonly registerWatchdog: (toolCallId: string, ms: number) => void;
  readonly clearWatchdog: (toolCallId: string) => void;
  readonly clearAllWatchdogs: () => void;
  readonly pendingWatchdogs: () => number;
  readonly isFinalized: () => boolean;
  readonly resolveState: () => StreamFinalization;
  readonly finalize: (reason: SessionEndReason) => void;
}

/**
 * createChatStreamSession —— 构造一次请求的流式会话生命周期控制器。
 *
 * 【为什么必须在任何 await 之前创建】旧实现把 finalize 先赋空函数、等 fetch 成功后
 * 才赋真值；于是 embedQueryText / fetch 在赋值前抛错时，catch/finally 调到的是空函数，
 * isStreaming / copilotStreaming 永不复位，输入框永久锁死。现在会话在 sendMessage 开头
 * 就创建，finalize 从第一行起就是真实实现，任何失败路径都能收尾。
 *
 * 【幂等】finalize 用 finalized 标记保证只执行一次：catch 与 finally 都调用也安全，
 * 排队消息只出队一次（不重复发送）。
 *
 * 【FIFO 排队】enqueue 追加到数组尾部（不再单槽覆盖），finalize 时 shift 出队首发送，
 * 流式期间连发不丢上下文。
 *
 * @param effects 副作用回调集
 * @returns 会话句柄
 */
export function createChatStreamSession(effects: ChatStreamSessionEffects): ChatStreamSession {
  let finalized = false;
  let doneReceived = false;
  let parseError = false;
  const watchdogs = new Map<string, number>();

  const clearAllWatchdogs = (): void => {
    for (const id of watchdogs.values()) effects.cancel(id);
    watchdogs.clear();
  };

  return {
    markDone(): void {
      doneReceived = true;
    },
    markParseError(): void {
      parseError = true;
    },
    registerWatchdog(toolCallId: string, ms: number): void {
      /* 先清旧定时器再建新的：重复 tool-start 不会泄漏上一个看门狗 */
      const prev = watchdogs.get(toolCallId);
      if (prev !== undefined) effects.cancel(prev);
      const id = effects.schedule((): void => {
        watchdogs.delete(toolCallId);
        effects.onWatchdogTimeout?.(toolCallId);
      }, ms);
      watchdogs.set(toolCallId, id);
    },
    clearWatchdog(toolCallId: string): void {
      const id = watchdogs.get(toolCallId);
      if (id !== undefined) {
        effects.cancel(id);
        watchdogs.delete(toolCallId);
      }
    },
    clearAllWatchdogs,
    pendingWatchdogs(): number {
      return watchdogs.size;
    },
    isFinalized(): boolean {
      return finalized;
    },
    resolveState(): StreamFinalization {
      return resolveFinalizationState(doneReceived, parseError);
    },
    finalize(reason: SessionEndReason): void {
      if (finalized) return;
      finalized = true;

      clearAllWatchdogs();

      /* 消息级复位：abort 保留内容不打失败/不完整标记；incomplete/error 各自打标 */
      effects.patchAssistant({
        isStreaming: false,
        ...(reason === 'incomplete' ? { incomplete: true } : {}),
        ...(reason === 'error' ? { failed: true } : {}),
      });
      effects.setStreaming(false);
      effects.setCopilotStreaming(false);

      /* FIFO 出队一条（队列跨会话共享）；幂等保证只出队一次，不重复发排队消息 */
      effects.drainQueue();

      /* 仅正常 / 不完整收尾播报；用户主动停止与出错不播报 */
      if (reason === 'done' || reason === 'incomplete') {
        effects.requestTts();
      }
    },
  };
}

/* ========================================================================== */
/* FIFO 排队队列（跨会话共享，流式期间连发不丢上下文）                            */
/* ========================================================================== */

/** FIFO 队列句柄 */
export interface PromptQueue {
  readonly enqueue: (prompt: string) => void;
  readonly shift: () => string | undefined;
  readonly length: () => number;
  readonly clear: () => void;
}

/**
 * createPromptQueue —— 先进先出排队队列。
 *
 * 【为什么是数组而不是单槽】旧实现用单个 ref 存排队 prompt，流式期间连发两条，
 * 后一条直接覆盖前一条——第一条请求被静默丢弃。改为 FIFO 数组：enqueue 追加尾部，
 * 每次流收尾 shift 出队首发送，连发不丢上下文。队列由组件持有、跨会话共享，
 * 保证"流 A 期间排队的请求，在流 A 结束后发送；其后续请求继续排队"。
 *
 * @returns FIFO 队列句柄
 */
export function createPromptQueue(): PromptQueue {
  const items: string[] = [];
  return {
    enqueue(prompt: string): void {
      items.push(prompt);
    },
    shift(): string | undefined {
      return items.shift();
    },
    length(): number {
      return items.length;
    },
    clear(): void {
      items.length = 0;
    },
  };
}