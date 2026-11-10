/**
 * KubeVision AI — 内置确定性日志分类器（builtin runtime）
 *
 * 【为什么把它从 Worker 里抽出来】
 * 端侧分类有三种运行时：WebGPU / WASM / 内置分类器。前两种依赖模型权重，
 * 第三种是纯规则兜底。B1 缺陷里"看门狗超时后 classify 仍需返回结果"
 * 要求**主线程**也能立刻给出分类——如果规则表只存在于 Worker 文件里，
 * 主线程就没法复用，只能再抄一份，两份必然漂移。
 *
 * 因此把特征词表与判别函数抽成本模块：
 *   - Worker 导入它做模型不可用时的降级；
 *   - 主线程 Hook 导入它做"单批 3 秒超时"的兜底。
 * 同一份权重 → 同一条日志在两条路径上得到同一个标签（可断言）。
 *
 * 【算法】对每个标签累加命中特征词的权重，取得分最高者；
 * 置信度 = 0.85 + (最高分/总分) * 0.14，收敛在 [0.85, 0.99]。
 * 不做任何 I/O，纯同步，可在渲染主线程直接调用。
 */

import type { EdgeAuditResult, EdgeLogLabel, LogEntry } from '@/types/ai';

/**
 * 标签特征词权重表 —— 内置分类器的「知识」。
 *
 * 【权重含义】3 = 决定性信号（SIGSEGV / OOMKilled）；2 = 强信号；1 = 弱信号。
 * 加权而非计数：一个决定性词应压过三个无关弱词。
 */
export const LABEL_FEATURES: Readonly<
  Record<EdgeLogLabel, ReadonlyArray<{ readonly term: string; readonly weight: number }>>
> = {
  CRITICAL_PANIC: [
    { term: 'sigsegv', weight: 3 },
    { term: 'segmentation fault', weight: 3 },
    { term: 'kernel panic', weight: 3 },
    { term: 'fatal error', weight: 3 },
    { term: 'panic', weight: 2 },
    { term: 'fatal', weight: 2 },
    { term: 'core dumped', weight: 3 },
    { term: 'crash', weight: 2 },
    { term: 'abort', weight: 2 },
    { term: 'unhandled exception', weight: 2 },
    { term: 'nil pointer', weight: 2 },
    { term: 'stack overflow', weight: 2 },
  ],
  RESOURCE_EXHAUSTED: [
    { term: 'oomkilled', weight: 3 },
    { term: 'out of memory', weight: 3 },
    { term: 'memory limit', weight: 2 },
    { term: 'no space left', weight: 3 },
    { term: 'disk full', weight: 3 },
    { term: 'too many open files', weight: 3 },
    { term: 'evicted', weight: 2 },
    { term: 'quota exceeded', weight: 3 },
    { term: 'cpu throttl', weight: 2 },
    { term: 'resource exhausted', weight: 3 },
    { term: 'cannot allocate memory', weight: 3 },
    { term: 'memory pressure', weight: 2 },
  ],
  NETWORK_TIMEOUT: [
    { term: 'timeout', weight: 2 },
    { term: 'timed out', weight: 2 },
    { term: 'connection refused', weight: 3 },
    { term: 'connection reset', weight: 3 },
    { term: 'econnrefused', weight: 3 },
    { term: 'econnreset', weight: 3 },
    { term: 'no such host', weight: 3 },
    { term: 'dns resolution', weight: 2 },
    { term: 'unreachable', weight: 2 },
    { term: 'packet loss', weight: 2 },
    { term: 'i/o timeout', weight: 3 },
    { term: 'broken pipe', weight: 3 },
    { term: 'tls handshake', weight: 2 },
  ],
  NORMAL_INFO: [
    { term: 'successfully', weight: 1 },
    { term: 'started', weight: 1 },
    { term: 'ready', weight: 1 },
    { term: 'healthy', weight: 1 },
    { term: 'assigned', weight: 1 },
    { term: 'completed', weight: 1 },
    { term: 'info', weight: 1 },
  ],
};

/**
 * classifyWithBuiltinClassifier —— 内置确定性分类器。
 *
 * @param text 脱敏后的日志文本
 * @returns 标签与置信度
 */
export function classifyWithBuiltinClassifier(text: string): {
  readonly label: EdgeLogLabel;
  readonly confidence: number;
} {
  const haystack = text.toLowerCase();

  const scores: Array<{ label: EdgeLogLabel; score: number }> = [];
  for (const label of Object.keys(LABEL_FEATURES) as EdgeLogLabel[]) {
    let score = 0;
    for (const feature of LABEL_FEATURES[label]) {
      if (haystack.includes(feature.term)) score += feature.weight;
    }
    scores.push({ label, score });
  }

  let best = scores[0];
  for (const entry of scores) {
    if (entry.score > best.score) best = entry;
  }

  const totalScore = scores.reduce((sum, entry): number => sum + entry.score, 0);
  if (best.score === 0 || totalScore === 0) {
    return { label: 'NORMAL_INFO', confidence: 0.85 };
  }

  const dominance = best.score / totalScore;
  const confidence = 0.85 + dominance * 0.14;
  return {
    label: best.label,
    confidence: Math.round(Math.min(0.99, confidence) * 100) / 100,
  };
}

/**
 * classifyLogsWithBuiltin —— 批量内置分类（主线程兜底使用）。
 *
 * @param logs 待分类日志（已脱敏）
 * @param startedAtMs 本批开始时刻，用于计算单条耗时
 * @returns 与 Worker 同构的 EdgeAuditResult[]
 */
export function classifyLogsWithBuiltin(
  logs: readonly LogEntry[],
  startedAtMs: number,
): readonly EdgeAuditResult[] {
  const perItemMs = logs.length === 0 ? 0 : Math.max(1, Math.round((Date.now() - startedAtMs) / logs.length));
  return logs.map((log): EdgeAuditResult => {
    const result = classifyWithBuiltinClassifier(log.sanitizedText);
    return {
      label: result.label,
      confidence: result.confidence,
      inferenceLatencyMs: perItemMs,
    };
  });
}