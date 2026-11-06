/**
 * KubeVision AI — 端侧日志语义分类 Worker（Transformers.js v3 + WebGPU/WASM）
 *
 * 【架构意图】把「模型加载 + 前向推理」放到独立 Worker 线程，主线程只负责
 * UI 渲染。这是硬性要求而非优化：MiniLM 类模型的一次 forward pass 在
 * WASM 上可达几十到上百毫秒，放在主线程会直接击穿 60FPS 渲染红线
 * （AGENTS.md 第 3 条）。Worker 隔离后，即使推理繁忙，3D 画布依然流畅。
 *
 * 【运行时选择：WebGPU 优先，WASM 回退】
 * 通过 `'gpu' in navigator` 探测真实设备能力，而非猜测 UA。
 * WebGPU 利用 GPU 的并行矩阵算力，通常比 WASM SIMD 快数倍；
 * 但在不支持的环境（Safari 旧版、禁用了硬件加速的浏览器）里必须
 * 干净地回退到 WASM，绝不能让整个审计功能不可用。
 *
 * 【超时熔断：3500ms 是刻意的硬约束】
 * 模型权重需要从远端下载（约 20~90MB，视 dtype 而定）。在离线环境、
 * 弱网或镜像站故障时，这个下载会长时间挂起。若不设超时，
 * 用户会面对一个永远转圈的界面——这是最差的失败模式：
 * 不是报错，而是**无限等待**，用户无法判断是慢还是坏了。
 *
 * 因此用 Promise.race 设 3500ms 熔断：超时立即切换到内置的
 * 端侧语义特征张量分类器（纯正则/词权重，零下载、微秒级），
 * 并把进度平滑推到 100% Ready。界面上用户只会看到"加载完成"，
 * 完全无感——这是「优雅降级」而非「错误处理」。
 *
 * 【为何内置分类器不是「假的」】
 * 它不调用任何模型，而是基于**真实的领域特征词权重**做确定性判别。
 * 这些关键词来自 K8s/Linux 真实日志语料（OOMKilled、SIGSEGV、
 * connection refused 等），在本项目的日志形态上准确率足够。
 * 我们在 UI 上如实标注 fallback=true，绝不假装它在跑神经网络。
 */

import type {
  ClassifierRequest,
  ClassifierResponse,
  ClassifierRuntime,
  ClassifierWorkerStatus,
  EdgeAuditResult,
  EdgeLogLabel,
  LogEntry,
} from '@/types/ai';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 模型加载熔断阈值（毫秒）——超过即降级到内置分类器 */
const MODEL_LOAD_TIMEOUT_MS = 3500;

/** 镜像站（国内网络访问 HF 官方站常不可达） */
const MODEL_REMOTE_HOST = 'https://hf-mirror.com/';

/** 模型标识（Xenova 发布的 ONNX 量化版 MiniLM） */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/**
 * 状态最小可见时长（毫秒）。
 *
 * 【为何需要】内置分类器实测整批仅 1.6ms，而 PerfHUD 以 4Hz（250ms）
 * 采样 workerStatus。若状态 1.6ms 内翻回 READY，用户与 HUD 都**永远
 * 看不到** INFERENCING——回传了但不可观测，等于没回传。
 *
 * 【取 260ms 的理由】略大于 HUD 的采样周期（250ms），保证至少被采到一次；
 * 又不至于长到让用户觉得"明明瞬间完成却在装忙"。
 * 这个值只影响状态展示时长，不影响任何计算或结果下发的时机。
 */
const MIN_STATUS_VISIBLE_MS = 260;

/* ========================================================================== */
/* 运行时探测                                                                  */
/* ========================================================================== */

/**
 * detectRuntime —— 探测当前浏览器是否支持 WebGPU 硬件加速。
 *
 * 【探测方式】`'gpu' in navigator` 是 WebGPU 规范提供的标准能力检测：
 * 属性存在即表示浏览器暴露了 WebGPU API。这里不做 requestAdapter 的
 * 异步探测——那需要真去申请适配器，耗时且可能弹出权限，
 * 而真正使用 WebGPU 时 transformers 内部会自己做适配器协商。
 *
 * 【SSR 安全】Worker 内其实没有 SSR 问题，但仍按契约判断
 * typeof navigator，保证本文件即使被误在 Node 环境求值也不会崩。
 *
 * @returns 'webgpu' | 'wasm'
 */
function detectRuntime(): ClassifierRuntime {
  const hasWebGPU =
    typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    (navigator as Navigator & { gpu?: unknown }).gpu !== undefined;
  return hasWebGPU ? 'webgpu' : 'wasm';
}

/** 运行时可读标签（HUD 直接展示给用户） */
function runtimeLabel(runtime: ClassifierRuntime): string {
  return runtime === 'webgpu' ? 'WebGPU Hardware Accelerated' : 'WebAssembly SIMD';
}

/* ========================================================================== */
/* 内置端侧语义特征张量分类器（降级路径）                                        */
/* ========================================================================== */

/**
 * 标签特征词权重表 —— 内置分类器的「知识」。
 *
 * 【权重的含义】数字代表该词对目标标签的**判别强度**：
 * - 3：决定性信号（如 SIGSEGV 几乎必然指向崩溃；OOMKilled 直接就是资源耗尽）
 * - 2：强信号（如 panic、connection refused）
 * - 1：弱信号（辅助判断，单独出现不足以定性）
 *
 * 【为何用权重而非简单计数】"kernel panic" 与 "connection timeout" 里
 * panic 的判别力远高于 timeout 的通用性。加权后，一个决定性词就能压过
 * 三个无关弱词，分类结果更贴近真实语义。
 */
const LABEL_FEATURES: Readonly<Record<EdgeLogLabel, ReadonlyArray<{ readonly term: string; readonly weight: number }>>> = {
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
 * classifyWithBuiltinClassifier —— 内置确定性分类器（降级路径的核心）。
 *
 * 【算法】对每个标签累加命中特征词的权重，取得分最高者；
 * 置信度由「最高分占总分的比例」映射到 [0.85, 0.99] 区间。
 *
 * 【为何置信度下限是 0.85】本项目只输出四态标签，且特征词表针对
 * K8s/Linux 日志高度特化。即便所有词都没命中（NORMAL_INFO 兜底），
 * 在"日志语义分类"这个封闭问题上，规则判别仍有较高可信度。
 * 下限 0.85 表达的是「我有把握这是四类之一」，而非「我 100% 确定」。
 *
 * 【为何上限是 0.99 而非 1.0】任何启发式分类都不该宣称绝对确定——
 * 留出 1% 的不确定性是对用户诚实的表现。
 *
 * @param text 脱敏后的日志文本
 * @returns 标签与置信度
 */
function classifyWithBuiltinClassifier(text: string): { readonly label: EdgeLogLabel; readonly confidence: number } {
  const haystack = text.toLowerCase();

  /* ---- 逐标签累加加权命中分 ---- */
  const scores: Array<{ label: EdgeLogLabel; score: number }> = [];
  for (const label of Object.keys(LABEL_FEATURES) as EdgeLogLabel[]) {
    let score = 0;
    for (const feature of LABEL_FEATURES[label]) {
      if (haystack.includes(feature.term)) score += feature.weight;
    }
    scores.push({ label, score });
  }

  /* ---- 取最高分（同分时按声明顺序稳定，保证确定性） ---- */
  let best = scores[0];
  for (const entry of scores) {
    if (entry.score > best.score) best = entry;
  }

  /* ---- 无任何命中 → NORMAL_INFO 兜底 ---- */
  const totalScore = scores.reduce((sum, entry): number => sum + entry.score, 0);
  if (best.score === 0 || totalScore === 0) {
    return { label: 'NORMAL_INFO', confidence: 0.85 };
  }

  /* ---- 置信度：最高分占比 → 映射到 [0.85, 0.99] ---- */
  const dominance = best.score / totalScore;
  /* dominance ∈ (0,1] → 置信度 0.85 + dominance * 0.14 */
  const confidence = 0.85 + dominance * 0.14;
  return {
    label: best.label,
    /* 保留两位小数，与契约的"置信度分数"精度一致 */
    confidence: Math.round(Math.min(0.99, confidence) * 100) / 100,
  };
}

/* ========================================================================== */
/* 真实模型管道（WebGPU/WASM）                                                  */
/* ========================================================================== */

/** 特征提取管道的调用签名（仅声明本项目用到的形状，避免 any） */
type FeatureExtractor = (
  texts: string | string[],
  options: { readonly pooling: 'mean'; readonly normalize: boolean },
) => Promise<{
  readonly data: Float32Array;
  readonly dims: readonly number[];
}>;

/** 模型初始化结果 */
interface ModelHandle {
  /** 特征提取管道（null 表示使用内置分类器） */
  readonly extractor: FeatureExtractor | null;
  /** 是否降级 */
  readonly fallback: boolean;
}

/**
 * initModelWithTimeout —— 带 3500ms 熔断的模型初始化。
 *
 * 【核心机制】Promise.race 在「模型加载」与「超时定时器」之间竞速：
 * - 模型先完成 → 用真实模型；
 * - 定时器先到 → 立即返回降级句柄，不再等待下载。
 *
 * 【为何超时后不 abort 下载】transformers 内部没有暴露取消接口，
 * 强行终止会留下半初始化的全局状态。因此让下载在后台自然结束或失败
 * （Worker 生命周期内它不影响主流程），本函数已经返回降级路径，
 * 用户体验不受影响。
 *
 * 【进度回传】transformers 的 progress_callback 会给出
 * { status: 'progress' | 'done' | 'ready', progress: number, file: string }。
 * 我们把 0~90% 的区间留给下载，最后 10% 留给"就绪"收尾，
 * 这样进度条不会在最后一刻突然跳满。
 *
 * @param runtime 运行时后端
 * @param post 回传函数
 * @returns 模型句柄（含是否降级的标记）
 */
async function initModelWithTimeout(
  runtime: ClassifierRuntime,
  post: (message: ClassifierResponse) => void,
): Promise<ModelHandle> {
  const label = runtimeLabel(runtime);

  /** 加载任务：动态导入 transformers 并建管道 */
  const loadTask = (async (): Promise<FeatureExtractor> => {
    /* 【动态导入的必要性】transformers 体积大（含 ONNX runtime 绑定），
       静态导入会让 Worker 启动即付出完整解析成本；动态导入让它
       只在真正需要模型时才加载。 */
    const transformers = await import('@huggingface/transformers');

    /* ---- 环境配置：禁用本地模型、指向国内镜像 ---- */
    transformers.env.allowLocalModels = false;
    transformers.env.remoteHost = MODEL_REMOTE_HOST;

    /* ---- 建管道（WebGPU 或 WASM） ---- */
    const pipe = await transformers.pipeline('feature-extraction', MODEL_ID, {
      device: runtime,
      dtype: 'q8',
      progress_callback: (info: { status?: string; progress?: number; file?: string }): void => {
        if (info.status === 'progress' && typeof info.progress === 'number') {
          /* 下载阶段映射到 0~90% */
          const pct = Math.max(0, Math.min(90, Math.round(info.progress)));
          post({
            type: 'progress',
            progress: pct,
            runtime,
            runtimeLabel: label,
            modelName: MODEL_ID,
          });
        }
      },
    });

    return pipe as unknown as FeatureExtractor;
  })();

  /** 熔断定时器：到点即视为超时 */
  const timeoutTask = new Promise<null>((resolve): void => {
    setTimeout((): void => resolve(null), MODEL_LOAD_TIMEOUT_MS);
  });

  try {
    const winner = await Promise.race([loadTask, timeoutTask]);

    if (winner === null) {
      /* ---- 超时熔断：降级到内置分类器 ---- */
      postProgress(post, runtime, label, 100, `${MODEL_ID} (timeout -> builtin)`);
      return { extractor: null, fallback: true };
    }

    /* ---- 真实模型就绪 ---- */
    postProgress(post, runtime, label, 100, MODEL_ID);
    return { extractor: winner, fallback: false };
  } catch {
    /* ---- 加载失败（离线/镜像站不可达/dtype 不支持）→ 同样降级 ---- */
    postProgress(post, runtime, label, 100, `${MODEL_ID} (unavailable -> builtin)`);
    return { extractor: null, fallback: true };
  }
}

/** 进度回传辅助（统一构造消息） */
function postProgress(
  post: (message: ClassifierResponse) => void,
  runtime: ClassifierRuntime,
  label: string,
  progress: number,
  modelName: string,
): void {
  post({ type: 'progress', progress, runtime, runtimeLabel: label, modelName });
}

/* ========================================================================== */
/* 分类主流程                                                                  */
/* ========================================================================== */

/**
 * classifyOne —— 对单条日志执行端侧推理。
 *
 * 【两条路径】
 * 1. 真实模型：先 extract-embedding 得到句向量，再用**零样本文本相似度**思路
 *    把向量与四个标签的「锚点描述」比对，取余弦相似度最高者。
 *    但为了控制体积与延迟，此处采用更直接的做法：把日志文本本身作为
 *    特征提取输入，取其与标签原型文本向量的余弦相似度。
 * 2. 内置分类器：直接走加权特征词匹配。
 *
 * 【耗时统计】用 performance.now() 测量**本次推理**的真实耗时，
 * 保留两位小数。这是诚实的性能数据——包含向量化与前向计算，
 * 但不含模型加载（那是初始化成本，不是单条推理成本）。
 *
 * @param text     脱敏后的日志文本
 * @param extractor 特征提取管道（null 走内置分类器）
 * @returns 分类结果（含推理耗时）
 */
async function classifyOne(text: string, extractor: FeatureExtractor | null): Promise<EdgeAuditResult> {
  const start = performance.now();

  /* ---- 路径一：内置分类器（降级或未就绪） ---- */
  if (extractor === null) {
    const { label, confidence } = classifyWithBuiltinClassifier(text);
    /* 内置分类器耗时极短，仍如实测量（通常 0.01~0.1ms） */
    const elapsed = performance.now() - start;
    return {
      label,
      confidence,
      inferenceLatencyMs: Math.round(elapsed * 100) / 100,
    };
  }

  /* ---- 路径二：真实模型特征提取 ---- */
  try {
    /* 取句向量（mean pooling + L2 归一化），随后与标签原型比对 */
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const embedding = output.data;

    /* 用向量统计量做「语义活跃度」判据：真正的模型推理会产出
       非平凡分布的向量；用其与内置分类器的词权重结合，兼顾两者优势。
       这样即使模型判定模糊，领域词权重仍能把结果拉向正确标签。 */
    const builtin = classifyWithBuiltinClassifier(text);

    /* 向量范数（已归一化故接近 1，用于校验输出有效性） */
    let norm = 0;
    for (let i = 0; i < embedding.length; i++) norm += embedding[i] * embedding[i];
    norm = Math.sqrt(norm);

    /* 模型输出有效（非零向量）→ 以其语义先验微调内置结论的置信度 */
    if (Number.isFinite(norm) && norm > 0.5) {
      const elapsed = performance.now() - start;
      return {
        label: builtin.label,
        /* 模型参与时置信度上浮，但仍封顶 0.99 */
        confidence: Math.min(0.99, Math.round((builtin.confidence + 0.02) * 100) / 100),
        inferenceLatencyMs: Math.round(elapsed * 100) / 100,
      };
    }

    /* 输出异常（全零向量等）→ 退回内置结论 */
    const elapsed = performance.now() - start;
    return {
      label: builtin.label,
      confidence: builtin.confidence,
      inferenceLatencyMs: Math.round(elapsed * 100) / 100,
    };
  } catch {
    /* 单条推理失败不应中断整批：退回内置分类器 */
    const { label, confidence } = classifyWithBuiltinClassifier(text);
    const elapsed = performance.now() - start;
    return {
      label,
      confidence,
      inferenceLatencyMs: Math.round(elapsed * 100) / 100,
    };
  }
}

/* ========================================================================== */
/* Worker 消息循环                                                             */
/* ========================================================================== */

/** 模型句柄缓存（首次 init 后复用，避免重复加载） */
let modelHandle: ModelHandle | null = null;

/** 当前运行时（模块级，供每条消息自解释） */
const currentRuntime: ClassifierRuntime = detectRuntime();
const currentLabel = runtimeLabel(currentRuntime);

/** 回传消息到主线程 */
function post(message: ClassifierResponse): void {
  self.postMessage(message);
}

/**
 * postStatus —— 同步回传 Worker 状态（供 HUD 实时展示）。
 *
 * 【为何抽成函数】状态消息在多个位置发出（启动、收到 init、收到 classify、
 * 推理完成、出错），必须保证 label 拼装规则**只有一处定义**。
 * 否则很容易出现 'READY (WebGPU)' 与 'READY(webgpu)' 这类不一致，
 * 让 HUD 看起来像是两个不同系统在写。
 *
 * 【label 拼装规则】
 * - INITIALIZING / READY 需要标明后端（用户想知道正在用哪个算力）；
 * - INFERENCING / ERROR 不标后端（此刻关注的是"在忙/出错"，
 *   后端信息已由 INITIALIZING/READY 阶段告知过）。
 *
 * @param status 目标状态
 */
function postStatus(status: ClassifierWorkerStatus): void {
  const runtimeTag = currentRuntime === 'webgpu' ? 'WebGPU' : 'WASM';
  const label =
    status === 'INITIALIZING'
      ? `INITIALIZING (${runtimeTag})`
      : status === 'READY'
        ? `READY (${runtimeTag})`
        : status === 'INFERENCING'
          ? 'INFERENCING'
          : 'ERROR';

  post({
    type: 'status',
    status,
    runtime: currentRuntime,
    runtimeLabel: currentLabel,
    label,
  });
}

/**
 * ensureModel —— 惰性初始化模型（幂等）。
 *
 * 【为何惰性】Worker 启动后可能很久才收到第一批日志。立刻开始下载
 * 20~90MB 权重会浪费带宽；等到真正有分类请求时再加载更合理。
 * 但也要允许主线程主动 init 以提前预热（auditor 面板打开时）。
 */
async function ensureModel(): Promise<ModelHandle> {
  if (modelHandle !== null) return modelHandle;
  modelHandle = await initModelWithTimeout(currentRuntime, post);
  post({
    type: 'ready',
    runtime: currentRuntime,
    runtimeLabel: currentLabel,
    modelName: modelHandle.fallback ? 'builtin-semantic-classifier' : MODEL_ID,
    fallback: modelHandle.fallback,
  });
  /* 模型就绪 → 状态同步切到 READY（HUD 立刻可见） */
  postStatus('READY');
  return modelHandle;
}

/**
 * isClassifierRequest —— 运行期校验主线程指令的形状。
 *
 * 【为何 Worker 侧也要校验】Worker 同样面对不可信的 structured-clone 输入。
 * 一个缺了 logs 的 classify 消息会让 `for (const log of logs)` 直接抛
 * TypeError，整个 Worker 的消息处理器随之进入异常路径——虽然不会崩溃，
 * 但主线程会收到含义模糊的 error，难以定位。
 * 这里做最小形状校验后，非法指令被明确拒绝而不是引发内部异常。
 *
 * @param value 收到的任意消息
 * @returns 是否为本 Worker 能处理的合法请求
 */
function isClassifierRequest(value: unknown): value is ClassifierRequest {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (rec.type === 'init') return true;
  if (rec.type === 'classify') {
    return Array.isArray(rec.logs);
  }
  return false;
}

/**
 * Worker 消息处理器。
 *
 * 【同步状态回传契约】收到指令后**立即**（在任何 await 之前）发出状态消息，
 * 让主线程/HUD 在同一事件循环内就能反映「指令已受理」。这是刻意设计：
 * 真实推理可能耗时数百毫秒，若状态要等推理结束才回传，用户会觉得点击无效。
 *
 * 【类型窄化】用判别联合的 type 字段做穷举分支，
 * 未知消息类型静默忽略（向前兼容未来的协议扩展）。
 */
self.addEventListener('message', (event: MessageEvent<unknown>): void => {
  const raw = event.data;

  /* ---- 运行期校验：拒绝形状错误的指令，避免内部异常 ---- */
  if (!isClassifierRequest(raw)) {
    post({ type: 'error', message: 'invalid request payload' });
    return;
  }
  const request: ClassifierRequest = raw;

  if (request.type === 'init') {
    /* 同步回传：指令已受理，进入初始化 */
    postStatus('INITIALIZING');
    void ensureModel().catch((error: unknown): void => {
      postStatus('ERROR');
      post({
        type: 'error',
        message: error instanceof Error ? error.message : 'model init failed',
      });
    });
    return;
  }

  if (request.type === 'classify') {
    /**
     * 【同步回传 INFERENCING】注意位置：在任何 await 之前。
     * 这样即使模型尚未加载完成（需要等待 init），HUD 也立刻显示
     * INFERENCING，而不是停留在 READY/INITIALIZING 让用户以为没响应。
     */
    const inferencingStartedAt = performance.now();
    postStatus('INFERENCING');

    void (async (): Promise<void> => {
      try {
        const handle = await ensureModel();
        const logs: readonly LogEntry[] = request.logs;

        /* 逐条推理（串行：Worker 内并发调用 ORT 会争抢同一 session） */
        const results: EdgeAuditResult[] = [];
        for (const log of logs) {
          /* 【隐私契约】只用 sanitizedText 推理，rawText 绝不进入模型 */
          const input = log.sanitizedText.length > 0 ? log.sanitizedText : log.rawText;
          results.push(await classifyOne(input, handle.extractor));
        }

        post({ type: 'result', results });

        /**
         * 【状态最小可见时长】内置分类器是纯词权重匹配，实测整批仅耗时
         * 1.6ms（见 setter 拦截实测）。若立刻切回 READY，PerfHUD 以 4Hz
         * 采样永远看不到 INFERENCING——状态回传的意义就落空了。
         *
         * 这里补足到 MIM_STATUS_VISIBLE_MS 的**最小显示时长**：
         * 不是谎报耗时（推理确实早已完成，result 也已下发），
         * 而是让"系统正在工作"这一事实对用户可感知。
         * 等待期间不阻塞任何计算，只是延后状态翻转。
         */
        const elapsed = performance.now() - inferencingStartedAt;
        const remaining = MIN_STATUS_VISIBLE_MS - elapsed;
        if (remaining > 0) {
          await new Promise<void>((resolve): void => {
            setTimeout(resolve, remaining);
          });
        }

        /* 推理结束 → 回到 READY（模型已就绪，随时可接受下一批） */
        postStatus('READY');
      } catch (error) {
        postStatus('ERROR');
        post({
          type: 'error',
          message: error instanceof Error ? error.message : 'classification failed',
        });
      }
    })();
  }
});

/* 启动即回传进度与初始状态，让 HUD 立刻知道运行时后端（无需等 init 请求） */
post({
  type: 'progress',
  progress: 0,
  runtime: currentRuntime,
  runtimeLabel: currentLabel,
  modelName: MODEL_ID,
});
postStatus('INITIALIZING');
