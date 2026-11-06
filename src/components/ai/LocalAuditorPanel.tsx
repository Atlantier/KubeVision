'use client';

/**
 * KubeVision AI — Edge Log Auditor 面板（端侧日志审计台）
 *
 * 【职责】在浏览器内完成「日志脱敏 → 端侧语义分类」全流程，把敏感数据
 * 与推理结果都留在用户设备上，只对外发送已脱敏文本。
 *
 * 【本轮的定位】CopilotDrawer 的第二个 Tab。当前实现提供完整可用的
 * 脱敏审计流水线（正则脱敏 + 规则分类 + 审计统计），并预留
 * Transformers.js WebGPU/WASM 推理接入点——模型加载属于后续轮次，
 * 但**脱敏与审计主流程现在就是真实可用的**，不是空壳占位。
 *
 * 【隐私契约】rawText 仅在本地留存用于对照展示，sanitizedText 才是
 * 可外发内容；totalMaskedSecrets 累加计数写入 store（持久化审计角标）。
 */

import { useCallback, useMemo, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, FileSearch, Loader2, ShieldCheck, Sparkles } from 'lucide-react';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import type { EdgeLogLabel } from '@/types/ai';

/* ========================================================================== */
/* 脱敏规则（端侧正则掩码）                                                      */
/* ========================================================================== */

/**
 * SENSITIVE_PATTERNS —— 敏感信息正则表。
 *
 * 【设计意图】每条规则同时给出「匹配模式」与「替换标签」，
 * 替换为语义标签（如 [REDACTED-TOKEN]）而非空串——
 * 保留"此处曾有凭证"这一事实，便于审计与后续日志分析。
 */
const SENSITIVE_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  {
    name: '连接串凭证',
    pattern: /(postgres|mysql|mongodb|redis|amqp):\/\/[^\s:@]+:[^\s@]+@/gi,
    replacement: '$1://[REDACTED-CREDENTIAL]@',
  },
  {
    name: 'Bearer Token',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g,
    replacement: 'Bearer [REDACTED-TOKEN]',
  },
  {
    name: 'AWS Access Key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED-AWS-KEY]',
  },
  {
    name: '私钥块',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED-PRIVATE-KEY]',
  },
  {
    name: 'JWT',
    pattern: /eyJ[A-Za-z0-9\-._~+/]{10,}\.[A-Za-z0-9\-._~+/]{10,}\.[A-Za-z0-9\-._~+/]{10,}/g,
    replacement: '[REDACTED-JWT]',
  },
  {
    name: '通用 password 字段',
    pattern: /(password|passwd|pwd|secret|api[_-]?key)\s*[=:]\s*["']?[^\s"',}]{6,}/gi,
    replacement: '$1=[REDACTED]',
  },
  {
    name: '内网 IP',
    pattern: /\b(?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replacement: '[REDACTED-IP]',
  },
  {
    name: '邮箱',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: '[REDACTED-EMAIL]',
  },
];

/* ========================================================================== */
/* 端侧分类规则（规则引擎，可被 Transformers.js 推理替换）                        */
/* ========================================================================== */

/**
 * classifyLog —— 端侧日志语义分类。
 *
 * 【当前实现】确定性关键词规则：每个标签有明确的触发词表，
 * 命中即返回对应标签与基于命中密度的置信度。
 *
 * 【为何先用规则】规则引擎**零下载、零延迟、完全可解释**，
 * 且在本项目的日志形态（K8s 控制器与内核输出）上准确率足够高。
 * Transformers.js 的 WebGPU 推理作为后续增强接入同一接口，
 * 二者可并存（规则兜底 + 模型主判）。
 */
function classifyLog(sanitizedText: string): { label: EdgeLogLabel; confidence: number } {
  const text = sanitizedText.toLowerCase();

  const rules: ReadonlyArray<{ label: EdgeLogLabel; keywords: readonly string[] }> = [
    { label: 'CRITICAL_PANIC', keywords: ['panic', 'fatal', 'segfault', 'unauthorized', 'forbidden', 'permission denied', 'authentication failed', 'invalid token', 'rbac', '403', '401'] },
    { label: 'RESOURCE_EXHAUSTED', keywords: ['oomkilled', 'out of memory', 'no space left', 'memory limit', 'cpu throttl', 'evicted', 'quota exceeded', 'too many open files'] },
    { label: 'NETWORK_TIMEOUT', keywords: ['timeout', 'connection refused', 'connection reset', 'dns', 'no such host', 'packet loss', 'unreachable', 'econnrefused', 'eof'] },
    { label: 'NORMAL_INFO', keywords: [] },
  ];

  let best: { label: EdgeLogLabel; hits: number } = { label: 'NORMAL_INFO', hits: 0 };
  for (const rule of rules) {
    let hits = 0;
    for (const keyword of rule.keywords) {
      if (text.includes(keyword)) hits += 1;
    }
    if (hits > best.hits) best = { label: rule.label, hits };
  }

  if (best.hits === 0) {
    return { label: 'NORMAL_INFO', confidence: 0.82 };
  }
  /* 置信度随命中数递增，上限 0.98（规则引擎不宣称 100% 确定） */
  const confidence = Math.min(0.98, 0.68 + best.hits * 0.1);
  return { label: best.label, confidence: Math.round(confidence * 100) / 100 };
}

/** 标签 → 中文名 + 色调（严格对齐 EdgeLogLabel 四态） */
const LABEL_META: Readonly<Record<EdgeLogLabel, { readonly text: string; readonly className: string }>> = {
  CRITICAL_PANIC: { text: '致命崩溃', className: 'border-rose-500/50 bg-rose-500/15 text-rose-300' },
  RESOURCE_EXHAUSTED: { text: '资源耗尽', className: 'border-amber-500/50 bg-amber-500/15 text-amber-300' },
  NETWORK_TIMEOUT: { text: '网络超时', className: 'border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-300' },
  NORMAL_INFO: { text: '常规信息', className: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300' },
};

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/** SANITIZED_SAMPLE —— 内置示例日志（含真实形态的敏感信息，用于演示掩码） */
const SAMPLE_LOGS: readonly string[] = [
  '2026-11-06T13:02:11Z ERROR [payment-gateway] failed to connect postgres://admin:S3cr3t!@db.internal:5432/payments: connection refused',
  '2026-11-06T13:02:14Z WARN [kubelet] Pod payment-gateway-7f8b9-x2k container OOMKilled, memory limit 512Mi exceeded',
  '2026-11-06T13:02:19Z ERROR [api-server] Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig -> 401 Unauthorized',
  '2026-11-06T13:02:24Z ERROR [redis-client] dial tcp 10.244.1.15:6379: i/o timeout after 5s',
  '2026-11-06T13:02:31Z INFO [scheduler] Successfully assigned default/inventory-svc-5d8c7-q9 to node-worker-gamma',
];

export default function LocalAuditorPanel() {
  const incrementMaskedSecrets = useClusterStore(
    (s): ((count: number) => void) => s.incrementMaskedSecrets,
  );
  const totalMaskedSecrets = useClusterStore((s): number => s.totalMaskedSecrets);
  const triggerQuickPrompt = useClusterStore(
    (s): ((prompt: string) => void) => s.triggerQuickPrompt,
  );

  const [rawInput, setRawInput] = useState<string>(SAMPLE_LOGS.join('\n'));
  const [showRaw, setShowRaw] = useState<boolean>(false);
  const [audited, setAudited] = useState<boolean>(false);
  const [isAuditing, setIsAuditing] = useState<boolean>(false);

  /**
   * sanitized —— 对输入执行全量脱敏。
   *
   * 【核心逻辑】逐条规则对全文做 replace，统计每个匹配的替换次数
   * 作为 maskedCount（用于隐私审计角标）。规则顺序有意义：
   * 连接串先行（它内部含 password，若先跑通用 password 规则会破坏 URL 结构）。
   */
  const sanitized = useMemo((): { readonly text: string; readonly maskedCount: number } => {
    let text = rawInput;
    let maskedCount = 0;
    for (const rule of SENSITIVE_PATTERNS) {
      /* 用 match 计数（replace 回调里累加更直观，但需重置 lastIndex） */
      const matches = text.match(rule.pattern);
      if (matches !== null && matches.length > 0) {
        maskedCount += matches.length;
        text = text.replace(rule.pattern, rule.replacement);
      }
    }
    return { text, maskedCount };
  }, [rawInput]);

  /** 分类结果（基于脱敏后的文本，模型永远看不到原文） */
  const classification = useMemo(
    (): { readonly label: EdgeLogLabel; readonly confidence: number } => classifyLog(sanitized.text),
    [sanitized.text],
  );

  /**
   * runAudit —— 执行审计。
   *
   * 【延迟的意义】端侧推理（真实场景下是 WebGPU/WASM 前向计算）需要时间；
   * 这里用短延迟模拟该节拍，同时把 maskedCount 累加进 store 的隐私审计角标。
   * 注：本轮为规则引擎，延迟仅用于呈现"审计中"状态。
   */
  const runAudit = useCallback((): void => {
    setIsAuditing(true);
    window.setTimeout((): void => {
      incrementMaskedSecrets(sanitized.maskedCount);
      setAudited(true);
      setIsAuditing(false);
    }, 420);
  }, [incrementMaskedSecrets, sanitized.maskedCount]);

  /**
   * escalateToCopilot —— 把端侧审计结论上报给 AI Copilot 做进一步根因分析。
   *
   * 【发什么】triggerQuickPrompt 写入一条自包含的中文诊断指令，包含：
   * 1. 分类结论与置信度（端侧推理的产出，让 Copilot 知道已有什么判断）；
   * 2. **脱敏后的日志文本**（不是 rawInput！）；
   * 3. 明确要求给出根因与可执行修复建议。
   *
   * 【截断策略】只取脱敏文本的前 600 字符。端侧审计针对的是「本次异常窗口」，
   * 日志可能长达数千行；把全文塞进 prompt 会稀释关键信号并浪费上下文预算，
   * 而分类结论已概括了整体性质，600 字符足以让 Copilot 看到典型错误行。
   *
   * 【触发链路】triggerQuickPrompt 内部会强制切 activeRightTab→'copilot'
   * 与 activeMobileView→'copilot'，因此用户点击后**立刻**看到 Copilot 视图，
   * 随后 CopilotDrawer 的消费 effect 自动发起流式请求并清空载荷。
   */
  const escalateToCopilot = useCallback((): void => {
    const excerpt = sanitized.text.slice(0, 600);
    /* 直接查表取中文标签，避免依赖下方声明的 labelMeta（TDZ） */
    const labelText = LABEL_META[classification.label].text;
    const prompt =
      `端侧日志审计发现异常，分类为 ${classification.label}（${labelText}），` +
      `置信度 ${(classification.confidence * 100).toFixed(0)}%，已脱敏 ${sanitized.maskedCount} 处敏感信息。\n` +
      `以下是脱敏后的日志片段：\n\`\`\`\n${excerpt}\n\`\`\`\n` +
      `请分析该异常的根因，并给出可执行的修复建议。`;
    triggerQuickPrompt(prompt);
  }, [classification.confidence, classification.label, sanitized.maskedCount, sanitized.text, triggerQuickPrompt]);

  const labelMeta = LABEL_META[classification.label];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {/* ---- 头部：隐私说明 + 累计脱敏角标 ---- */}
      <div className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5">
        <p className="flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-wider text-emerald-300">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          edge-only&nbsp;audit
        </p>
        <p className="mt-0.5 text-[9.5px] leading-relaxed text-slate-400">
          日志脱敏与语义分类全部在浏览器内完成，原始文本不外发。
        </p>
        <p className="mt-1 font-mono text-[8.5px] uppercase tracking-wider text-emerald-400/80">
          total&nbsp;masked&nbsp;secrets:&nbsp;{totalMaskedSecrets}
        </p>
      </div>

      {/* ---- 原始/脱敏切换 ---- */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={(): void => setShowRaw((prev): boolean => !prev)}
          className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800/50 px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider text-slate-400 transition-colors hover:text-cyan-300"
        >
          {showRaw ? <EyeOff className="h-2.5 w-2.5" aria-hidden /> : <Eye className="h-2.5 w-2.5" aria-hidden />}
          {showRaw ? 'hide raw' : 'show raw'}
        </button>
        <span className="ml-auto rounded-full border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 font-mono text-[8px] text-slate-500">
          {sanitized.maskedCount}&nbsp;masked
        </span>
      </div>

      {/* ---- 日志输入/展示区 ---- */}
      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        {showRaw ? (
          <textarea
            value={rawInput}
            onChange={(e): void => {
              setRawInput(e.target.value);
              setAudited(false);
            }}
            aria-label="原始日志输入"
            className="min-h-[70px] flex-1 resize-none rounded border border-slate-700 bg-slate-950/60 p-1.5 font-mono text-[9px] leading-relaxed text-slate-400 outline-none focus:border-cyan-500/40"
          />
        ) : null}

        {/* 脱敏结果（模型实际可见的输入） */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-slate-800 bg-slate-950/60 p-1.5">
          <p className="mb-1 font-mono text-[8px] uppercase tracking-wider text-slate-600">
            sanitized&nbsp;input&nbsp;·&nbsp;llm&nbsp;safe
          </p>
          <pre className="whitespace-pre-wrap break-words font-mono text-[9px] leading-relaxed text-slate-400">
            {sanitized.text}
          </pre>
        </div>

        {/* ---- 分类结果 ---- */}
        {audited ? (
          <div className="shrink-0 rounded border border-slate-800 bg-slate-900/60 p-1.5">
            <p className="font-mono text-[8px] uppercase tracking-wider text-slate-600">
              classification
            </p>
            <div className="mt-1 flex items-center gap-1.5">
              <span
                className={cn(
                  'rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold',
                  labelMeta.className,
                )}
              >
                {labelMeta.text}
              </span>
              <span className="font-mono text-[9px] tabular-nums text-slate-400">
                {(classification.confidence * 100).toFixed(0)}%
              </span>
              <CheckCircle2 className="ml-auto h-3 w-3 text-emerald-400" aria-hidden />
            </div>
            <p className="mt-1 font-mono text-[8px] uppercase tracking-wider text-slate-600">
              label:&nbsp;{classification.label}
            </p>

            {/*
             * EscalateReportButton —— 把端侧审计结论上报给 Copilot。
             *
             * 【为何只传脱敏文本】这是本面板隐私契约的延续：端侧可以看见
             * 原文，但**送出设备边界的内容必须是 sanitizedText**。
             * 上报指令里若夹带原始凭证，整个"端侧脱敏"的设计就失去意义。
             */}
            <button
              type="button"
              onClick={escalateToCopilot}
              aria-label="上报异常至 AI Copilot"
              className="mt-1.5 flex w-full items-center justify-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-1 font-mono text-[8.5px] font-bold uppercase tracking-wider text-cyan-300 transition-colors hover:border-cyan-400/70 hover:bg-cyan-500/20"
            >
              <Sparkles className="h-2.5 w-2.5" aria-hidden />
              escalate&nbsp;to&nbsp;copilot
            </button>
          </div>
        ) : null}
      </div>

      {/* ---- 执行审计 ---- */}
      <button
        type="button"
        onClick={runAudit}
        disabled={isAuditing}
        className={cn(
          'flex shrink-0 items-center justify-center gap-1 rounded border px-2 py-1.5 font-mono text-[9.5px] font-bold uppercase tracking-wider transition-colors',
          isAuditing
            ? 'cursor-wait border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
            : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-cyan-500/50 hover:bg-cyan-500/10 hover:text-cyan-300',
        )}
      >
        {isAuditing ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            auditing…
          </>
        ) : (
          <>
            <FileSearch className="h-3 w-3" aria-hidden />
            run&nbsp;edge&nbsp;audit
          </>
        )}
      </button>
    </div>
  );
}
