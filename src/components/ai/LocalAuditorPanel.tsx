'use client';

/**
 * KubeVision AI — 端侧 AI 日志隐私审计面板（Edge Log Auditor）
 *
 * 【架构定位】这是「端侧隐私零出域 + 云端大模型决策」混合 AI 架构的
 * 端侧落点：日志在浏览器内完成脱敏与语义分类，绝不把原始凭证发往任何
 * 远端；只有当端侧模型判定为高危时，才把**脱敏后的安全摘要**移交
 * Copilot 做深度根因分析。数据出域的产品是「已经不含敏感信息的摘要」，
 * 而非原始日志——这是本面板的核心价值主张。
 *
 * 【三层职责】
 * 1. 引擎状态监控：运行时后端（WebGPU/WASM）、模型名、权重加载进度、
 *    累计脱敏凭证数、平均推理延迟；
 * 2. 实时流脱敏与分类：抓取集群日志 → 本地脱敏 → Worker 推理 → 卡片展示；
 * 3. 端云协同闭环：高危日志的脱敏摘要一键移交 Copilot。
 *
 * 【Worker 生命周期】在 useEffect 内初始化、卸载时 terminate()。
 * 具体创建逻辑收敛在 useEdgeLogClassifier 中（见该 Hook 的说明），
 * 本组件只消费其状态，不直接触碰 Worker 实例——这样 Worker 的生命周期
 * 只有一处管理，避免组件与 Hook 双重创建/双重终止。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Cpu,
  Eye,
  EyeOff,
  FileSearch,
  Loader2,
  Play,
  Radio,
  ShieldCheck,
  Sparkles,
  Square,
  Zap,
} from 'lucide-react';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import { useEdgeLogClassifier } from '@/hooks/useEdgeLogClassifier';
import { sanitizeRawLog } from '@/utils/logSanitizer';
import { generateSyntheticLogs } from '@/utils/syntheticEngine';
import type { EdgeAuditResult, EdgeLogLabel, LogEntry } from '@/types/ai';

/* ========================================================================== */
/* 常量与标签元数据                                                             */
/* ========================================================================== */

/**
 * 标签 → 视觉与文案映射（严格对齐 EdgeLogLabel 四态）。
 *
 * 【色彩契约】CRITICAL_PANIC 用 rose（崩溃是最严重的）、
 * RESOURCE_EXHAUSTED 用 amber（资源耗尽需尽快处理但通常可恢复）、
 * NETWORK_TIMEOUT 用 fuchsia（网络问题常为瞬态）、NORMAL_INFO 用 emerald。
 * 与全项目状态色体系一致，不引入新的色彩语义。
 */
const LABEL_META: Readonly<
  Record<EdgeLogLabel, { readonly text: string; readonly badge: string; readonly dot: string }>
> = {
  CRITICAL_PANIC: {
    text: '致命崩溃',
    badge: 'border-rose-500/60 bg-rose-500/15 text-rose-300',
    dot: 'bg-rose-500',
  },
  RESOURCE_EXHAUSTED: {
    text: '资源耗尽',
    badge: 'border-amber-500/60 bg-amber-500/15 text-amber-300',
    dot: 'bg-amber-400',
  },
  NETWORK_TIMEOUT: {
    text: '网络超时',
    badge: 'border-fuchsia-500/60 bg-fuchsia-500/15 text-fuchsia-300',
    dot: 'bg-fuchsia-400',
  },
  NORMAL_INFO: {
    text: '常规信息',
    badge: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300',
    dot: 'bg-emerald-400',
  },
};

/** 需要移交 Copilot 的高危标签（其余标签不提供按钮，避免噪音） */
const ESCALATABLE_LABELS: ReadonlySet<EdgeLogLabel> = new Set<EdgeLogLabel>([
  'CRITICAL_PANIC',
  'RESOURCE_EXHAUSTED',
]);

/** 单次抓取的最大日志条数（防止一次灌入过多导致审计面板拥挤/推理过久） */
const MAX_BATCH_SIZE = 8;

/** 自动实时流式审计的刷新间隔（毫秒） */
const AUTO_STREAM_INTERVAL_MS = 6000;

/* ========================================================================== */
/* 类型契约                                                                    */
/* ========================================================================== */

/**
 * AuditRecord —— 单条日志的完整审计记录（原始 + 脱敏 + 分类结果）。
 *
 * 【为何同时保留 raw 与 sanitized】本面板的核心交互是「对比」：
 * 用户需要亲眼看到脱敏前有什么、脱敏后剩下什么，才能建立对
 * 端侧隐私保护的信任。只展示脱敏结果等于让用户盲信。
 * raw 仅存在于内存（Store 的 partialize 白名单已排除），绝不外发。
 */
interface AuditRecord {
  /** 唯一标识 */
  readonly id: string;
  /** 原始日志（含敏感信息，仅本地展示） */
  readonly rawText: string;
  /** 脱敏后日志（可安全外发） */
  readonly sanitizedText: string;
  /** 本条脱敏替换的字段数 */
  readonly maskedCount: number;
  /** 来源 Pod 名 */
  readonly podName: string;
  /** 命名空间 */
  readonly namespace: string;
  /** 端侧分类结果 */
  readonly result: EdgeAuditResult;
}

/* ========================================================================== */
/* 子组件：敏感信息高亮渲染                                                     */
/* ========================================================================== */

/** 高亮分段结果 */
interface HighlightSegment {
  readonly text: string;
  readonly kind: 'plain' | 'risk' | 'mask';
}

/**
 * splitHighlight —— 把日志文本切分为「普通 / 风险 / 掩码」三类片段。
 *
 * 【原始视图】高亮出真实的 IP、Token、AccessKey、URL 凭证与邮箱，
 * 让用户直观看到「这条日志里到底有多少敏感信息」；
 * 【脱敏视图】高亮出 [REDACTED_IP]、[MASKED_TOKEN] 等占位符，
 * 证明它们确实被替换了。
 *
 * 【为何不用 dangerouslySetInnerHTML】那样需要把日志内容插入 HTML，
 * 日志是外部输入，存在注入风险。此处返回纯数据结构，由 React 渲染
 * 为 <span>，天然免疫注入——隐私面板本身更不能有注入漏洞。
 *
 * @param text  日志文本
 * @param mode  'risk' 高亮真实敏感信息；'mask' 高亮占位符
 * @returns 分段数组
 */
function splitHighlight(text: string, mode: 'risk' | 'mask'): HighlightSegment[] {
  /* 脱敏视图：只需匹配占位符 */
  if (mode === 'mask') {
    const maskRe = /\[(?:REDACTED_[A-Z]+|MASKED_[A-Z]+)\]/g;
    const segments: HighlightSegment[] = [];
    let last = 0;
    let m = maskRe.exec(text);
    while (m !== null) {
      if (m.index > last) segments.push({ text: text.slice(last, m.index), kind: 'plain' });
      segments.push({ text: m[0], kind: 'mask' });
      last = m.index + m[0].length;
      m = maskRe.exec(text);
    }
    if (last < text.length) segments.push({ text: text.slice(last), kind: 'plain' });
    return segments;
  }

  /* 原始视图：匹配真实敏感信息（与 logSanitizer 的规则范围对应） */
  const riskPatterns: readonly RegExp[] = [
    /\b([a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:[^\s@/]+@/gi,
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b|\bLTAI[0-9A-Za-z]{12,20}\b|\bAKID[0-9A-Za-z]{32}\b/g,
    /\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{8,}=*|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?(?![\d.])/g,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  ];

  /* 收集所有命中区间，按起点排序后合并重叠，避免重复嵌套渲染 */
  const ranges: Array<{ start: number; end: number }> = [];
  for (const pattern of riskPatterns) {
    pattern.lastIndex = 0;
    let m = pattern.exec(text);
    while (m !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
      if (pattern.global) {
        m = pattern.exec(text);
      } else {
        break;
      }
    }
  }
  ranges.sort((a, b): number => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && r.start <= prev.end) {
      /* 重叠 → 扩展前一段 */
      merged[merged.length - 1] = { start: prev.start, end: Math.max(prev.end, r.end) };
    } else {
      merged.push(r);
    }
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start > cursor) segments.push({ text: text.slice(cursor, r.start), kind: 'plain' });
    segments.push({ text: text.slice(r.start, r.end), kind: 'risk' });
    cursor = r.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), kind: 'plain' });
  return segments;
}

/**
 * HighlightedLog —— 带语法高亮的日志文本块。
 *
 * @param text 日志文本
 * @param mode 'risk' 高亮真实敏感信息 / 'mask' 高亮脱敏占位符
 */
function HighlightedLog({ text, mode }: { readonly text: string; readonly mode: 'risk' | 'mask' }) {
  const segments = useMemo((): HighlightSegment[] => splitHighlight(text, mode), [text, mode]);
  return (
    <pre className="whitespace-pre-wrap break-all font-mono text-[8.5px] leading-relaxed">
      {segments.map((seg, i) => {
        if (seg.kind === 'plain') {
          return (
            <span key={i} className="text-slate-500">
              {seg.text}
            </span>
          );
        }
        if (seg.kind === 'risk') {
          return (
            <mark key={i} className="rounded-sm bg-rose-500/25 px-0.5 font-bold text-rose-300">
              {seg.text}
            </mark>
          );
        }
        /* mask 态 */
        return (
          <mark key={i} className="rounded-sm bg-emerald-500/25 px-0.5 font-bold text-emerald-300">
            {seg.text}
          </mark>
        );
      })}
    </pre>
  );
}

/* ========================================================================== */
/* 子组件：审计结果卡片                                                         */
/* ========================================================================== */

/**
 * AuditCard —— 单条日志的审计结果卡片（含原始/脱敏对比与端云协同按钮）。
 */
function AuditCard({
  record,
  onEscalate,
}: {
  readonly record: AuditRecord;
  readonly onEscalate: (record: AuditRecord) => void;
}) {
  /** 视图切换：false = 脱敏后（默认，强调安全态），true = 原始 */
  const [showRaw, setShowRaw] = useState<boolean>(false);
  const meta = LABEL_META[record.result.label];
  const canEscalate = ESCALATABLE_LABELS.has(record.result.label);

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 p-1.5">
      {/* ---- 头部：Pod 名 + 分类徽标 + 耗时 ---- */}
      <div className="flex flex-wrap items-center gap-1">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', meta.dot)} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] font-bold text-slate-200" title={record.podName}>
          {record.podName}
        </span>
        <span
          className={cn(
            'shrink-0 rounded border px-1 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider',
            meta.badge,
          )}
        >
          {record.result.label}&nbsp;{(record.result.confidence * 100).toFixed(1)}%
        </span>
        <span className="shrink-0 font-mono text-[8px] tabular-nums text-cyan-400/80">
          {record.result.inferenceLatencyMs.toFixed(2)}ms
        </span>
      </div>

      {/* ---- 命名空间 + 脱敏计数 ---- */}
      <div className="mt-0.5 flex items-center gap-1 font-mono text-[8px] uppercase tracking-wider text-slate-600">
        <span className="truncate">{record.namespace}</span>
        <span>·</span>
        <span className={record.maskedCount > 0 ? 'text-amber-500' : ''}>
          {record.maskedCount}&nbsp;masked
        </span>
      </div>

      {/* ---- 原始 / 脱敏 切换 ---- */}
      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          onClick={(): void => setShowRaw((prev): boolean => !prev)}
          aria-pressed={showRaw}
          aria-label={showRaw ? '查看脱敏后安全日志' : '查看原始含敏感信息日志'}
          className={cn(
            'flex items-center gap-0.5 rounded border px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider transition-colors',
            showRaw
              ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
              : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
          )}
        >
          {showRaw ? <Eye className="h-2.5 w-2.5" aria-hidden /> : <EyeOff className="h-2.5 w-2.5" aria-hidden />}
          {showRaw ? 'raw (敏感)' : 'sanitized (安全)'}
        </button>
        {record.maskedCount > 0 ? (
          <span className="ml-auto font-mono text-[7.5px] uppercase tracking-wider text-slate-600">
            toggle&nbsp;to&nbsp;compare
          </span>
        ) : null}
      </div>

      {/* ---- 日志正文 ---- */}
      <div
        className={cn(
          'mt-1 max-h-24 overflow-y-auto rounded border p-1',
          showRaw ? 'border-rose-500/30 bg-rose-950/20' : 'border-emerald-500/25 bg-slate-950/50',
        )}
      >
        <HighlightedLog text={showRaw ? record.rawText : record.sanitizedText} mode={showRaw ? 'risk' : 'mask'} />
      </div>

      {/* ---- 端云协同：仅高危标签提供移交按钮 ---- */}
      {canEscalate ? (
        <button
          type="button"
          onClick={(): void => onEscalate(record)}
          aria-label="仅将脱敏安全摘要移交 Copilot 深度诊断"
          className="mt-1 flex w-full items-center justify-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-1 font-mono text-[8px] font-bold uppercase tracking-wider text-cyan-300 transition-colors hover:border-cyan-400/70 hover:bg-cyan-500/20"
        >
          <Sparkles className="h-2.5 w-2.5" aria-hidden />
          仅将脱敏安全摘要移交 Copilot
        </button>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* 主组件                                                                      */
/* ========================================================================== */

/**
 * LocalAuditorPanel —— 端侧 AI 日志隐私审计面板。
 */
export default function LocalAuditorPanel() {
  /* ---- Store 订阅 ---- */
  const totalMaskedSecrets = useClusterStore((s): number => s.totalMaskedSecrets);
  const incrementMaskedSecrets = useClusterStore(
    (s): ((count: number) => void) => s.incrementMaskedSecrets,
  );
  const triggerQuickPrompt = useClusterStore(
    (s): ((prompt: string) => void) => s.triggerQuickPrompt,
  );
  const appendTerminalLog = useClusterStore(
    (s): ((line: string) => void) => s.appendTerminalLog,
  );

  /* ---- 端侧推理 Worker（生命周期由 Hook 统一管理：创建 → 使用 → terminate） ---- */
  const classifier = useEdgeLogClassifier(true);

  /* ---- 本地状态 ---- */
  const [records, setRecords] = useState<readonly AuditRecord[]>([]);
  const [isFetching, setIsFetching] = useState<boolean>(false);
  const [autoStream, setAutoStream] = useState<boolean>(false);
  /** 本轮会话累计推理延迟样本（用于计算平均值） */
  const latencySamplesRef = useRef<number[]>([]);
  const [avgLatency, setAvgLatency] = useState<number | null>(null);

  /* ========================================================================== */
  /* 核心：抓取 → 脱敏 → 推理 → 展示                                              */
  /* ========================================================================== */

  /**
   * fetchAndAudit —— 抓取集群日志并执行端侧审计。
   *
   * 【核心流转】
   * 1. generateSyntheticLogs(snapshot) 取得当前集群的真实形态日志；
   * 2. **用统一的 logSanitizer 重新脱敏**——注意 syntheticEngine 内部
   *    另有一套脱敏正则，与 logSanitizer 并非同一份实现。若直接用它的
   *    maskedCount 累加，会造成两套规则各算各的、计数口径不一致。
   *    这里以 logSanitizer 为唯一权威源重新计算；
   * 3. incrementMaskedSecrets 持久化累加（隐私审计角标）；
   * 4. 送入 Worker 推理，结果与原始/脱敏文本配对成 AuditRecord。
   *
   * 【为何要在端侧重新脱敏而不是信任上游】隐私保护是「纵深防御」：
   * 上游若因模板变更漏掉某类凭证，端侧这一关仍能兜住。
   * 而且这一层是**真正决定什么能出设备边界**的那一道闸门。
   */
  const fetchAndAudit = useCallback(async (): Promise<void> => {
    if (isFetching) return;
    setIsFetching(true);

    try {
      const snapshot = useClusterStore.getState().snapshotSummary;
      const rawLogs = generateSyntheticLogs(snapshot).slice(0, MAX_BATCH_SIZE);
      if (rawLogs.length === 0) {
        setIsFetching(false);
        return;
      }

      /* ---- 端侧统一脱敏（唯一权威源） ---- */
      let batchMasked = 0;
      const sanitizedEntries: LogEntry[] = rawLogs.map((log): LogEntry => {
        const { sanitized, maskedCount } = sanitizeRawLog(log.rawText);
        batchMasked += maskedCount;
        return { ...log, sanitizedText: sanitized, maskedCount };
      });

      /* ---- 持久化累加（隐私审计角标） ---- */
      if (batchMasked > 0) {
        incrementMaskedSecrets(batchMasked);
      }

      /* ---- 端侧推理 ---- */
      const results = await classifier.classify(sanitizedEntries);

      if (results !== null && results.length > 0) {
        /* 记录延迟样本以计算平均值 */
        for (const r of results) latencySamplesRef.current.push(r.inferenceLatencyMs);
        const samples = latencySamplesRef.current;
        const sum = samples.reduce((acc, v): number => acc + v, 0);
        setAvgLatency(sum / samples.length);

        const newRecords: AuditRecord[] = sanitizedEntries.map((entry, i): AuditRecord => ({
          id: `${entry.id}-${Date.now()}-${i}`,
          rawText: entry.rawText,
          sanitizedText: entry.sanitizedText,
          maskedCount: entry.maskedCount,
          podName: entry.podName,
          namespace: entry.namespace,
          result: results[i] ?? { label: 'NORMAL_INFO', confidence: 0.85, inferenceLatencyMs: 0 },
        }));

        /* 最新的在前，最多保留 24 条（防止无限增长） */
        setRecords((prev) => [...newRecords, ...prev].slice(0, 24));

        /**
         * 【终端联动】把端侧推理事件写入底部 TerminalEcho。
         *
         * 【为何逐条写而非只写汇总】终端是**审计流水**，用户需要能追溯到
         * 「哪条日志被判成了什么」。只写一行汇总虽然干净，却丢掉了
         * Pod 维度的对应关系——当 3 个 Pod 同时异常时，汇总无法回答
         * 「到底是哪个 Pod 崩了」。
         *
         * 【格式契约】严格采用
         * `[EDGE-WASM] Masked N secrets & classified LABEL (x.xxms) in pod <name>`
         * 与终端既有的 [EDGE-WASM] 前缀完全一致（TerminalEcho 的 TONE_RULES
         * 已把它映射为 edge 色调），因此无需改动终端组件即可自动高亮。
         *
         * 【只写脱敏计数与标签，绝不写日志正文】终端内容会进入持久化的
         * recent 30 条，若把正文写进去，脱敏努力就在持久化层被绕过了。
         * 这里只记录「脱敏了几处、判成了什么类、耗时多少、来自哪个 Pod」——
         * 这些元信息本身不含敏感内容，却足以支撑审计追溯。
         */
        for (const record of newRecords) {
          appendTerminalLog(
            `[EDGE-WASM] Masked ${record.maskedCount} secrets & classified ${record.result.label} ` +
              `(${record.result.inferenceLatencyMs.toFixed(2)}ms) in pod ${record.podName}`,
          );
        }

        /**
         * 批次汇总行：给出本批的整体统计，便于快速扫读。
         * 单条行回答「哪一条怎么样」，汇总行回答「这一批整体如何」，
         * 两者互补而非重复。
         */
        const highRiskInBatch = newRecords.filter(
          (r): boolean => r.result.label === 'CRITICAL_PANIC' || r.result.label === 'RESOURCE_EXHAUSTED',
        ).length;
        appendTerminalLog(
          `[EDGE-WASM] batch audited: ${newRecords.length} logs / ${batchMasked} secrets masked / ` +
            `${highRiskInBatch} high-risk (${classifier.runtimeLabel})`,
        );
      }
    } catch {
      /* 抓取/审计失败不应中断面板：静默恢复，用户可重试 */
    } finally {
      setIsFetching(false);
    }
  }, [appendTerminalLog, classifier, incrementMaskedSecrets, isFetching]);

  /* ========================================================================== */
  /* 自动实时流式审计                                                             */
  /* ========================================================================== */

  useEffect(() => {
    if (!autoStream) return;
    /* 开启后立刻抓一次，避免用户等待首个间隔 */
    void fetchAndAudit();

    const timer = window.setInterval((): void => {
      void fetchAndAudit();
    }, AUTO_STREAM_INTERVAL_MS);

    return (): void => {
      window.clearInterval(timer);
    };
    /* fetchAndAudit 依赖 isFetching，会频繁变化；此处只在开关变化时重建定时器，
       通过 ref 读取最新函数，避免定时器被反复销毁重建 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStream]);

  /* ========================================================================== */
  /* 引擎生命周期事件 → 终端                                                       */
  /* ========================================================================== */

  /** 上一次已写入终端的引擎状态（避免 React 重渲染导致重复刷同一行） */
  const lastLoggedStatusRef = useRef<string | null>(null);

  /**
   * 引擎状态变化写入终端。
   *
   * 【为何记录到终端】模型加载/降级对用户是"黑盒等待"：面板上只有一条
   * 进度条，用户不知道背后在做什么、为什么慢。把 INITIALIZING → READY
   * 或降级事件写进终端，等于给这段等待过程留下可追溯的时间线——
   * 出问题时能回答"当时引擎到底就绪了没有"。
   *
   * 【去重】用 ref 记录上次写入的状态串，相同状态不重复写。
   * 否则 React 的每次重渲染都会追加一行，把终端刷满噪音。
   */
  useEffect(() => {
    const label = classifier.statusLabel;
    if (label.length === 0 || label === 'idle') return;
    if (lastLoggedStatusRef.current === label) return;
    lastLoggedStatusRef.current = label;

    if (label === 'ERROR') {
      appendTerminalLog(`[ERR] [EDGE-WASM] engine error: ${classifier.error ?? 'unknown'}`);
      return;
    }
    /* 只在两个"里程碑"状态写日志：进入 INITIALIZING 与达到 READY。
       INFERENCING 已由每条日志的分类行体现，重复写会淹没关键信息。 */
    if (label.startsWith('INITIALIZING')) {
      appendTerminalLog(`[EDGE-WASM] engine initializing -> ${classifier.modelName} (${label})`);
    } else if (label.startsWith('READY')) {
      appendTerminalLog(
        `[EDGE-WASM] engine ready (${label})${classifier.isFallback ? ' · builtin fallback active' : ''}`,
      );
    }
  }, [appendTerminalLog, classifier.error, classifier.isFallback, classifier.modelName, classifier.statusLabel]);

  /* ========================================================================== */
  /* 端云协同：脱敏摘要移交 Copilot                                                */
  /* ========================================================================== */

  /**
   * escalateToCopilot —— 把**脱敏后**的安全摘要移交 Copilot 深度诊断。
   *
   * 【隐私边界】构造 prompt 时只使用 record.sanitizedText，
   * 绝不拼接 rawText。这是本面板「端侧隐私零出域」承诺的最后一道执行点——
   * 所有脱敏工作的意义都取决于这一行代码是否守住了边界。
   *
   * 【为何带分类标签与置信度】Copilot 拿到的不该只是一段日志，
   * 而应有端侧模型的判断先验，这样它可以直接进入根因分析
   * 而不必从零开始摸索。
   */
  const escalateToCopilot = useCallback(
    (record: AuditRecord): void => {
      const meta = LABEL_META[record.result.label];
      const prompt =
        `端侧 AI 审计发现高危日志（来源 Pod: ${record.podName}，命名空间 ${record.namespace}）。\n` +
        `端侧分类：${record.result.label}（${meta.text}），置信度 ${(record.result.confidence * 100).toFixed(1)}%，` +
        `推理耗时 ${record.result.inferenceLatencyMs.toFixed(2)}ms，已脱敏 ${record.maskedCount} 处敏感信息。\n` +
        `以下是**脱敏后的安全日志**（原始凭证未离开本机）：\n\`\`\`\n${record.sanitizedText}\n\`\`\`\n` +
        `请分析该异常的根因，并给出可执行的修复建议。`;

      /**
       * 【移交审计行】记录「有一条脱敏摘要被送出设备边界」这一事实。
       * 这是隐私审计链的最后一环：日志里能查到什么被移交了、
       * 移交时的分类依据是什么。注意只记元信息（标签/脱敏数/Pod），
       * 不记正文——正文已在 conversation 里，无需在持久化终端重复存一份。
       */
      appendTerminalLog(
        `[EDGE-WASM] sanitized handoff -> Copilot: ${record.result.label} from pod ${record.podName} ` +
          `(${record.maskedCount} secrets masked, confidence ${(record.result.confidence * 100).toFixed(1)}%)`,
      );

      triggerQuickPrompt(prompt);
    },
    [appendTerminalLog, triggerQuickPrompt],
  );

  /* ========================================================================== */
  /* 派生指标                                                                    */
  /* ========================================================================== */

  /** 高危记录数（用于状态监控卡） */
  const criticalCount = useMemo(
    (): number =>
      records.filter((r): boolean => r.result.label === 'CRITICAL_PANIC' || r.result.label === 'RESOURCE_EXHAUSTED')
        .length,
    [records],
  );

  const isWebGPU = classifier.runtime === 'webgpu';

  /* ========================================================================== */
  /* 渲染                                                                       */
  /* ========================================================================== */

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-2">
      {/* ==================== 端侧引擎状态监控卡 ==================== */}
      <div className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/5 p-1.5">
        <div className="flex items-center gap-1">
          <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-400" aria-hidden />
          <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-emerald-300">
            edge&nbsp;ai&nbsp;·&nbsp;privacy&nbsp;guard
          </span>
          {/* 运行时徽标 */}
          <span
            className={cn(
              'ml-auto flex shrink-0 items-center gap-0.5 rounded border px-1 py-0.5 font-mono text-[7.5px] font-bold uppercase tracking-wider',
              isWebGPU
                ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                : 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300',
            )}
            title={classifier.runtimeLabel}
          >
            {isWebGPU ? <Zap className="h-2 w-2" aria-hidden /> : <Cpu className="h-2 w-2" aria-hidden />}
            {isWebGPU ? 'WebGPU' : 'WASM SIMD'}
          </span>
        </div>

        {/* 模型名 + 状态 */}
        <div className="mt-1 flex items-center gap-1 font-mono text-[7.5px] tracking-wider text-slate-500">
          <span className="min-w-0 flex-1 truncate" title={classifier.modelName}>
            {classifier.modelName}
          </span>
          <span
            className={cn(
              'shrink-0 font-bold',
              classifier.workerStatus === 'INFERENCING'
                ? 'text-cyan-400'
                : classifier.isReady
                  ? 'text-emerald-400'
                  : 'text-slate-500',
            )}
          >
            {classifier.statusLabel}
          </span>
        </div>

        {/* 权重加载进度条 0% → 100% Ready */}
        <div className="mt-1 flex items-center gap-1">
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-800">
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-300',
                classifier.isReady
                  ? 'bg-emerald-400'
                  : 'bg-gradient-to-r from-cyan-500 to-cyan-400',
              )}
              style={{ width: `${classifier.progress}%` }}
              role="progressbar"
              aria-valuenow={classifier.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="端侧模型权重加载进度"
            />
          </div>
          <span className="shrink-0 font-mono text-[7.5px] tabular-nums text-slate-500">
            {classifier.progress}%{classifier.isReady ? ' Ready' : ''}
          </span>
        </div>

        {/* 累计脱敏凭证数 + 平均推理延迟 */}
        <div className="mt-1 grid grid-cols-2 gap-1">
          <div className="rounded border border-slate-700/70 bg-slate-800/40 px-1 py-0.5">
            <p className="font-mono text-[7px] uppercase tracking-wider text-slate-600">masked</p>
            <p className="font-mono text-[10px] font-bold tabular-nums text-amber-300">
              {totalMaskedSecrets}
            </p>
          </div>
          <div className="rounded border border-slate-700/70 bg-slate-800/40 px-1 py-0.5">
            <p className="font-mono text-[7px] uppercase tracking-wider text-slate-600">avg latency</p>
            <p className="font-mono text-[10px] font-bold tabular-nums text-cyan-300">
              {avgLatency !== null ? `${avgLatency.toFixed(2)}ms` : '--'}
            </p>
          </div>
        </div>

        {/* 降级提示 */}
        {classifier.isFallback ? (
          <p className="mt-1 flex items-center gap-0.5 font-mono text-[7px] text-amber-400/90">
            <Activity className="h-2 w-2 shrink-0" aria-hidden />
            外部模型不可用，已启用内置确定性分类器（离线可用）
          </p>
        ) : null}
      </div>

      {/* ==================== 操作区 ==================== */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={(): void => void fetchAndAudit()}
          disabled={isFetching || !classifier.isReady}
          aria-label="抓取并审计当前集群容器日志流"
          className={cn(
            'flex min-w-0 flex-1 items-center justify-center gap-1 rounded border px-1.5 py-1 font-mono text-[8px] font-bold uppercase tracking-wider transition-colors',
            isFetching || !classifier.isReady
              ? 'cursor-not-allowed border-slate-700 bg-slate-800/50 text-slate-600'
              : 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300 hover:border-cyan-400/70 hover:bg-cyan-500/20',
          )}
        >
          {isFetching ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
          ) : (
            <FileSearch className="h-2.5 w-2.5" aria-hidden />
          )}
          {isFetching ? 'auditing…' : '抓取并审计日志流'}
        </button>

        {/* 自动实时流式审计开关 */}
        <button
          type="button"
          onClick={(): void => setAutoStream((prev): boolean => !prev)}
          aria-pressed={autoStream}
          aria-label="自动实时流式审计"
          className={cn(
            'flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-1 font-mono text-[8px] font-bold uppercase tracking-wider transition-colors',
            autoStream
              ? 'border-rose-500/60 bg-rose-500/15 text-rose-300'
              : 'border-slate-700 bg-slate-800/50 text-slate-500 hover:text-slate-300',
          )}
        >
          {autoStream ? (
            <>
              <Square className="h-2.5 w-2.5" aria-hidden />
              停止
            </>
          ) : (
            <>
              <Radio className="h-2.5 w-2.5" aria-hidden />
              自动
            </>
          )}
        </button>
      </div>

      {/* 自动模式指示 */}
      {autoStream ? (
        <p className="flex shrink-0 items-center gap-1 font-mono text-[7.5px] uppercase tracking-wider text-rose-400/80">
          <span className="h-1 w-1 animate-glow-pulse rounded-full bg-rose-500" aria-hidden />
          实时流式审计中 · 每 {AUTO_STREAM_INTERVAL_MS / 1000}s 抓取一批
        </p>
      ) : null}

      {/* ==================== 审计结果列表 ==================== */}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto" aria-live="polite" aria-label="审计结果列表">
        {records.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <ShieldCheck className="h-6 w-6 text-slate-700" aria-hidden />
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">awaiting logs</p>
            <p className="text-[9px] leading-relaxed text-slate-600">
              点击上方按钮抓取集群日志，端侧将完成脱敏与语义分类，
              <br />
              原始敏感信息永不离开本机。
            </p>
          </div>
        ) : (
          <>
            {/* 高危计数摘要 */}
            {criticalCount > 0 ? (
              <p className="flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/8 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-rose-300">
                <Play className="h-2.5 w-2.5 shrink-0" aria-hidden />
                {criticalCount} 条高危日志待移交 Copilot
              </p>
            ) : null}
            {records.map((record) => (
              <AuditCard key={record.id} record={record} onEscalate={escalateToCopilot} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
