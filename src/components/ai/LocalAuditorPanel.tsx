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
import { CheckCircle2, Cpu, Eye, EyeOff, FileSearch, Loader2, ShieldCheck, Sparkles, Zap } from 'lucide-react';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import { useEdgeLogClassifier } from '@/hooks/useEdgeLogClassifier';
import { sanitizeRawLog } from '@/utils/logSanitizer';
import type { EdgeAuditResult, EdgeLogLabel, LogEntry } from '@/types/ai';

/* ========================================================================== */
/* 脱敏：统一委托给 src/utils/logSanitizer.ts                                    */
/* ========================================================================== */

/* 说明：本面板原本内联维护一份 SENSITIVE_PATTERNS 正则表，现已移除。
   脱敏规则必须**单点定义**——若面板与真正的外发路径各维护一份，
   迟早出现「面板显示已脱敏、外发时却漏掉某类凭证」的致命不一致。
   唯一权威源是 logSanitizer.ts，它覆盖 IPv4（含端口）、JWT/Bearer、
   云厂商 AccessKey（AWS/阿里云/腾讯云）与邮箱，并提供幂等性保证。 */

/* ========================================================================== */
/* 端侧分类规则（Worker 未就绪时的逐行预览兜底）                                  */
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

  /**
   * 端侧推理 Worker（Transformers.js v3 + WebGPU/WASM）。
   *
   * 【架构】模型加载与推理全部在独立 Worker 线程内完成，主线程零阻塞。
   * Hook 回传 runtime / progress / runtimeLabel，本面板据此渲染
   * 「此刻用的是 WebGPU 还是 WASM」——性能数字脱离后端标识没有意义。
   *
   * 【降级】Worker 内建 3500ms 熔断：离线或镜像站不可达时自动切换到
   * 内置确定性分类器，进度直接推至 100% Ready，界面绝不卡死。
   */
  const classifier = useEdgeLogClassifier(true);

  /** Worker 推理结果（null 表示尚未运行） */
  const [auditResults, setAuditResults] = useState<readonly EdgeAuditResult[] | null>(null);

  const [rawInput, setRawInput] = useState<string>(SAMPLE_LOGS.join('\n'));
  const [showRaw, setShowRaw] = useState<boolean>(false);
  const [audited, setAudited] = useState<boolean>(false);
  const [isAuditing, setIsAuditing] = useState<boolean>(false);

  /**
   * sanitized —— 对输入执行全量脱敏（调用统一脱敏器）。
   *
   * 【为何改用 sanitizeRawLog】脱敏规则必须**单点定义**：如果面板里再维护
   * 一份自己的规则表，就会出现「面板认为已脱敏、而真正外发路径漏掉某项」
   * 的致命不一致。logSanitizer.ts 是唯一权威源，此处只做逐行拆分与汇总。
   */
  const sanitized = useMemo((): { readonly text: string; readonly maskedCount: number } => {
    const lines = rawInput.split('\n');
    let maskedCount = 0;
    const outLines: string[] = [];
    for (const line of lines) {
      const result = sanitizeRawLog(line);
      maskedCount += result.maskedCount;
      outLines.push(result.sanitized);
    }
    return { text: outLines.join('\n'), maskedCount };
  }, [rawInput]);

  /** 本地规则分类结果（仅在 Worker 未返回时作为逐行预览兜底） */
  const classification = useMemo(
    (): { readonly label: EdgeLogLabel; readonly confidence: number } => classifyLog(sanitized.text),
    [sanitized.text],
  );

  /**
   * displayedClassification —— 优先展示 Worker 的端侧推理结果。
   *
   * 【优先级】Worker 结果 > 本地规则预览。
   * Worker 结果来自真实模型（或超时后的内置分类器），是本功能的正式产出；
   * 本地规则只用于在推理完成前给用户一个即时预览，避免空白。
   */
  const displayedClassification = useMemo((): {
    readonly label: EdgeLogLabel;
    readonly confidence: number;
    readonly latencyMs: number | null;
  } => {
    if (auditResults !== null && auditResults.length > 0) {
      /* 取所有行的最高风险标签作为整批结论 */
      const priority: Record<EdgeLogLabel, number> = {
        CRITICAL_PANIC: 3,
        RESOURCE_EXHAUSTED: 2,
        NETWORK_TIMEOUT: 1,
        NORMAL_INFO: 0,
      };
      let top = auditResults[0];
      for (const r of auditResults) {
        if (priority[r.label] > priority[top.label]) top = r;
      }
      return { label: top.label, confidence: top.confidence, latencyMs: top.inferenceLatencyMs };
    }
    return { label: classification.label, confidence: classification.confidence, latencyMs: null };
  }, [auditResults, classification]);

  /**
   * runAudit —— 执行端侧审计（真实 Worker 推理）。
   *
   * 【核心流转】
   * 1. 把脱敏后的每一行构造为 LogEntry（rawText 留本地、sanitizedText 送模型）；
   * 2. 投递给 Worker 分类；
   * 3. 拿到逐条结果后汇总展示，并把 maskedCount 累加进隐私审计角标。
   *
   * 【为何构造 LogEntry 而不是直接传字符串】Worker 的协议契约就是
   * LogEntry[]，且该结构强制携带 sanitizedText 字段——这个类型设计本身
   * 就在提醒调用方：**送进模型的必须是脱敏文本**。
   */
  const runAudit = useCallback((): void => {
    setIsAuditing(true);

    const rawLines = rawInput.split('\n').filter((l): boolean => l.trim().length > 0);
    const logEntries: LogEntry[] = rawLines.map((rawLine, index): LogEntry => {
      const { sanitized: clean, maskedCount } = sanitizeRawLog(rawLine);
      return {
        id: `edge-log-${index}`,
        rawText: rawLine,
        sanitizedText: clean,
        maskedCount,
        timestamp: Date.now(),
        podName: 'local-audit',
        namespace: 'edge',
      };
    });

    void (async (): Promise<void> => {
      const results = await classifier.classify(logEntries);
      if (results !== null) {
        setAuditResults(results);
      }
      incrementMaskedSecrets(sanitized.maskedCount);
      setAudited(true);
      setIsAuditing(false);
    })();
  }, [classifier, incrementMaskedSecrets, rawInput, sanitized.maskedCount]);

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

        {/* ---- 运行时后端 + 模型加载进度（真实回传，非猜测） ---- */}
        <div className="mt-1.5 flex items-center gap-1 rounded border border-slate-700/70 bg-slate-800/40 px-1.5 py-1">
          {classifier.runtime === 'webgpu' ? (
            <Zap className="h-2.5 w-2.5 shrink-0 text-amber-400" aria-hidden />
          ) : (
            <Cpu className="h-2.5 w-2.5 shrink-0 text-cyan-400" aria-hidden />
          )}
          <span
            className="min-w-0 flex-1 truncate font-mono text-[8px] uppercase tracking-wider text-slate-300"
            title={classifier.modelName}
          >
            {classifier.runtimeLabel}
          </span>
          {classifier.isFallback ? (
            <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/15 px-1 py-0.5 font-mono text-[7.5px] font-bold uppercase text-amber-300">
              builtin
            </span>
          ) : null}
          <span className="shrink-0 font-mono text-[8px] tabular-nums text-slate-500">
            {classifier.progress}%
          </span>
        </div>
        {/* 加载进度条（仅在未就绪时显示，避免就绪后占位） */}
        {!classifier.isReady ? (
          <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-[width] duration-300"
              style={{ width: `${classifier.progress}%` }}
              role="progressbar"
              aria-valuenow={classifier.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="端侧模型加载进度"
            />
          </div>
        ) : null}
        {/* Worker 错误提示 */}
        {classifier.error !== null ? (
          <p className="mt-1 font-mono text-[7.5px] text-rose-400">{classifier.error}</p>
        ) : null}
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

        {/* ---- 分类结果（端侧推理产出） ---- */}
        {audited ? (
          <div className="shrink-0 rounded border border-slate-800 bg-slate-900/60 p-1.5">
            <p className="font-mono text-[8px] uppercase tracking-wider text-slate-600">
              classification
            </p>
            <div className="mt-1 flex items-center gap-1.5">
              <span
                className={cn(
                  'rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold',
                  LABEL_META[displayedClassification.label].className,
                )}
              >
                {LABEL_META[displayedClassification.label].text}
              </span>
              <span className="font-mono text-[9px] tabular-nums text-slate-400">
                {(displayedClassification.confidence * 100).toFixed(0)}%
              </span>
              {/* 端侧推理耗时（保留两位小数，契约要求） */}
              {displayedClassification.latencyMs !== null ? (
                <span className="font-mono text-[8.5px] tabular-nums text-cyan-400/80">
                  {displayedClassification.latencyMs.toFixed(2)}ms
                </span>
              ) : null}
              <CheckCircle2 className="ml-auto h-3 w-3 text-emerald-400" aria-hidden />
            </div>
            <p className="mt-1 font-mono text-[8px] uppercase tracking-wider text-slate-600">
              {/* 必须与上方徽标同源：否则会出现「徽标显示资源耗尽、
                  label 行却写 CRITICAL_PANIC」的自相矛盾（实测发现） */}
              label:&nbsp;{displayedClassification.label}
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
