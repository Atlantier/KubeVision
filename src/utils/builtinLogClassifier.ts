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
    { term: 'stackoverflowerror', weight: 3 },
    { term: 'uncaught typeerror', weight: 3 },
    { term: 'typeerror', weight: 2 },
    { term: 'nullpointerexception', weight: 3 },
    { term: 'unhandledrejection', weight: 2 },
  ],
  RESOURCE_EXHAUSTED: [
    { term: 'oomkilled', weight: 3 },
    { term: 'out of memory', weight: 3 },
    { term: 'outofmemoryerror', weight: 3 },
    { term: 'java heap space', weight: 3 },
    { term: 'heap space', weight: 2 },
    { term: 'memory limit', weight: 2 },
    { term: 'no space left', weight: 3 },
    { term: 'disk full', weight: 3 },
    { term: 'too many open files', weight: 3 },
    { term: 'evicted', weight: 2 },
    { term: 'quota exceeded', weight: 3 },
    { term: 'cpu throttl', weight: 2 },
    { term: 'threads saturated', weight: 2 },
    { term: 'scheduler lag', weight: 2 },
    { term: 'ephemeral-storage', weight: 2 },
    { term: 'resource exhausted', weight: 3 },
    { term: 'cannot allocate memory', weight: 3 },
    { term: 'memory pressure', weight: 2 },
  ],
  NETWORK_TIMEOUT: [
    { term: 'timeout', weight: 2 },
    { term: 'timed out', weight: 2 },
    { term: 'context deadline exceeded', weight: 3 },
    { term: 'deadline exceeded', weight: 3 },
    { term: 'socket hang up', weight: 3 },
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
  /* M16：先清除“0 errors / no panic / without timeouts”等否定词短语，避免正常巡检日志被误判为故障 */
  const haystack = text
    .toLowerCase()
    .replace(/\b(?:0|no|zero|without)\s+(?:errors?|panics?|exceptions?|timeouts?|failures?|oom)\b/g, ' ');

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
    /* M16：零特征词命中时仅给出低证据先验（0.45），禁止虚报 0.85 高置信度 */
    return { label: 'NORMAL_INFO', confidence: 0.45 };
  }

  const dominance = best.score / totalScore;
  const confidence = 0.85 + dominance * 0.14;
  return {
    label: best.label,
    confidence: Math.round(Math.min(0.99, confidence) * 100) / 100,
  };
}

/**
 * 自适应微突发计时窗口下限（毫秒）。
 *
 * 【为何需要窗口校准】
 * 非 crossOriginIsolated 页面中，浏览器会对 performance.now() 做抗侧信道量化
 * （Chrome/Edge 约 0.1ms，Firefox 约 1ms）。内置分类器单次执行通常仅需 0.01~0.05ms，
 * 直接单次相减会高频落入同一时钟滴答而返回 0.00ms。跨过该最小窗口后按次数均摊，
 * 即可在不注入任何假延迟的前提下测出真实的单次 CPU 耗时。
 */
const MIN_CALIBRATION_WINDOW_MS = 0.6;
/** 单次耗时测量校准循环的硬迭代上限（防止极端环境阻塞主线程或 Worker） */
const MAX_CALIBRATION_ITERS = 256;
/** 校准窗口内至少执行的实测次数，保证平均估算具备统计稳定性 */
const MIN_CALIBRATION_RUNS = 8;

/**
 * getClockNow —— 安全获取单调高精度时间戳（毫秒）。
 */
function getClockNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * classifyWithBuiltinTimed —— 执行内置确定性分类并真实测量亚毫秒级推理耗时。
 *
 * 【设计意图 / 输入输出 / 核心逻辑】
 * - 输入：脱敏后的日志文本 `text`。
 * - 输出：`EdgeAuditResult`（`label`、`confidence`、真实非零 `inferenceLatencyMs`）。
 * - 核心逻辑：先执行一次真实判别得出结论；若单次 `performance.now()` 差值受浏览器
 *   时钟量化影响等于 `0`（或为非正值），则对同文本执行有限次真实重算直到跨过
 *   `MIN_CALIBRATION_WINDOW_MS`（且至少 `MIN_CALIBRATION_RUNS` 次、不超过 `MAX_CALIBRATION_ITERS` 次），
 *   以 `实际总耗时 / 实际次数` 得到真实单条执行耗时（保留两位小数，下限 `0.01ms` 仅作
 *   极快 JIT 场景的最小精度下界），彻底消除 `0.00ms` 失真读数且绝不造假耗时。
 *
 * @param text 脱敏后的日志文本
 * @returns 与 Worker 同构的 EdgeAuditResult
 */
export function classifyWithBuiltinTimed(text: string): EdgeAuditResult {
  const startedAt = getClockNow();
  const { label, confidence } = classifyWithBuiltinClassifier(text);
  let measuredMs = getClockNow() - startedAt;

  if (measuredMs <= 0) {
    const burstStart = getClockNow();
    let runs = 0;
    let burstElapsed = 0;
    while (runs < MAX_CALIBRATION_ITERS) {
      classifyWithBuiltinClassifier(text);
      runs += 1;
      burstElapsed = getClockNow() - burstStart;
      if (burstElapsed >= MIN_CALIBRATION_WINDOW_MS && runs >= MIN_CALIBRATION_RUNS) {
        break;
      }
    }
    if (runs > 0 && burstElapsed > 0) {
      measuredMs = burstElapsed / runs;
    }
  }

  const rounded = Math.round(measuredMs * 100) / 100;
  return {
    label,
    confidence,
    inferenceLatencyMs: Math.max(0.01, rounded),
  };
}

/**
 * classifyLogsWithBuiltin —— 批量内置分类（主线程兜底与并发占位回退共用）。
 *
 * @param logs 待分类日志（已脱敏）
 * @param _startedAtMs 保留签名兼容（统一采用每条实测微突发计时）
 * @returns 与 Worker 同构的 EdgeAuditResult[]
 */
export function classifyLogsWithBuiltin(
  logs: readonly LogEntry[],
  _startedAtMs?: number,
): readonly EdgeAuditResult[] {
  void _startedAtMs;
  if (logs.length === 0) return [];
  return logs.map((log): EdgeAuditResult => {
    const input = log.sanitizedText.length > 0 ? log.sanitizedText : log.rawText;
    return classifyWithBuiltinTimed(input);
  });
}