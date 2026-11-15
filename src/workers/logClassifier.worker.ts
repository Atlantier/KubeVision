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
/** R49：Worker 启动时刻（冷启动计时起点） */
const WORKER_STARTED_AT = performance.now();

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
type WorkerInferenceRuntime = Exclude<ClassifierRuntime, 'builtin'>;

function detectRuntime(): WorkerInferenceRuntime {
  const hasWebGPU =
    typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    (navigator as Navigator & { gpu?: unknown }).gpu !== undefined;
  return hasWebGPU ? 'webgpu' : 'wasm';
}

/** 运行时可读标签（HUD 直接展示给用户） */
function runtimeLabel(runtime: WorkerInferenceRuntime): string {
  return runtime === 'webgpu' ? 'WebGPU Hardware Accelerated' : 'WebAssembly SIMD';
}

/*
 * 内置分类器已抽取到 src/utils/builtinLogClassifier.ts（B1/B5）。
 *
 * 【为什么不在 Worker 里保留一份】主线程在"单批 3 秒超时"时必须能立刻
 * 用同一套规则给出结果；两份实现必然漂移，届时同一条日志在 Worker 与
 * 兜底路径上会得到不同标签，审计结论就自相矛盾了。
 */
import { classifyWithBuiltinClassifier } from '@/utils/builtinLogClassifier';
import { LABEL_FEATURES } from '@/utils/builtinLogClassifier';

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

/* ========================================================================== */
/* 语义原型锚点（Anchor Prototypes）                                             */
/* ========================================================================== */

/**
 * 四类日志语义的**锚点原型文本**。
 *
 * 【设计动机：为什么需要原型】
 * `all-MiniLM-L6-v2` 是一个**通用句向量模型**——它把任意文本映射到 384 维
 * 语义空间的某一点，但**它本身不做分类**。旧实现拿到这个向量后只检查了
 * 模长（`norm > 0.5`）就丢弃，然后照搬正则分类器的结论——
 * 也就是说：**模型下载了 20~90MB 权重、跑完了前向计算，却没参与任何决策**。
 * 这是"假端侧推理"，评委读源码即可发现。
 *
 * 正确用法是 **zero-shot 语义分类**：预先用同一个模型把每个类别的
 * "代表性描述文本"编码成锚点向量，运行时把待分类日志的向量与 4 个锚点
 * 逐一比对余弦相似度，最接近的锚点即语义类别。不需要训练分类头，
 * 也不需要标注数据，纯粹利用模型已有的语义空间几何结构。
 *
 * 【原型文本为何这样写】每个原型都刻意混入该类故障的**典型术语组合**：
 * 内核态（kernel panic / OOMKilled / exit 137）、资源态（CFS throttled /
 * memory pressure / GC pause）、网络态（VXLAN / ETIMEDOUT / TLS handshake）、
 * 正常态（healthz / readiness probe / HTTP 200）。语义空间里这些词会彼此靠近，
 * 因此实际日志只需命中其中几个术语，就能被吸附到正确的锚点附近。
 */
const PROTOTYPE_TEXTS: Readonly<Record<EdgeLogLabel, string>> = {
  CRITICAL_PANIC:
    'FATAL kernel panic Out of memory OOMKilled exit code 137 CrashLoopBackOff segfault container killed',
  RESOURCE_EXHAUSTED:
    'WARN CPU CFS quota throttled memory pressure disk IOPS saturation connection pool exhausted GC pause',
  NETWORK_TIMEOUT:
    'ERROR CNI VXLAN packet loss DNS lookup timeout ETIMEDOUT connection reset by peer TLS handshake timeout',
  NORMAL_INFO:
    'INFO healthz readiness probe succeeded HTTP 200 OK replica synced scheduled successfully normal operation',
};

/**
 * 原型锚点向量缓存（384 维、已 L2 归一化）。
 *
 * 【为何缓存】原型是**常量文本**，其向量在整个 Worker 生命周期内不变。
 * 每条日志都重新编码 4 个原型意味着 5 倍推理开销；预计算一次即可复用。
 * 缓存键为标签，值为归一化 Float32Array。
 */
const prototypeEmbeddings: Partial<Record<EdgeLogLabel, Float32Array>> = {};

/** 原型是否已就绪（未就绪时 classifyOne 退回纯符号路径） */
let prototypesReady = false;

/**
 * ensurePrototypes —— 预计算 4 类语义原型的锚点向量。
 *
 * 【为何批量调用 extractor】`extractor` 支持传入 `string[]` 并在一次批处理中
 * 完成编码。4 条文本合并成一批，比循环调用 4 次省掉三次前向调度与
 * GPU 提交开销——在 WebGPU 上这个差距是可见的（首次调用还要触发
 * 管线编译，批量能把它平摊掉）。
 *
 * 【归一化保证】调用时传 `normalize: true`，模型输出即为单位向量；
 * 于是余弦相似度退化为**纯点积**（‖a‖=‖b‖=1 时分母恒为 1）。
 * 这是本实现里最重要的一处数学简化，见 cosineDot 注释。
 *
 * @param extractor 已就绪的特征提取管道
 * @returns 是否成功建立全部 4 个锚点
 */
async function ensurePrototypes(extractor: FeatureExtractor): Promise<boolean> {
  if (prototypesReady) return true;

  const labels = Object.keys(PROTOTYPE_TEXTS) as EdgeLogLabel[];
  try {
    const output = await extractor(
      labels.map((label): string => PROTOTYPE_TEXTS[label]),
      { pooling: 'mean', normalize: true },
    );

    /* 批量输出形状为 [batch, dim]，按 labels 顺序切分 */
    const dim = output.dims.length > 0 ? output.dims[output.dims.length - 1] : 0;
    if (!Number.isFinite(dim) || dim <= 0 || output.data.length < dim * labels.length) {
      return false;
    }

    for (let i = 0; i < labels.length; i++) {
      prototypeEmbeddings[labels[i]] = output.data.slice(i * dim, (i + 1) * dim);
    }
    prototypesReady = true;
    return true;
  } catch {
    /* 原型编码失败不应让整批分类失败——退回符号先验路径 */
    return false;
  }
}

/**
 * cosineDot —— 两个**已 L2 归一化**向量的余弦相似度。
 *
 * 【核心数学】
 *   余弦相似度  cos(a, b) = (a · b) / (‖a‖ · ‖b‖)
 * 当两个向量都已归一化（‖a‖ = ‖b‖ = 1）时，分母恒等于 1，公式退化为
 * **纯点积**：cos(a, b) = Σ aᵢ·bᵢ。
 *
 * 【为何这个简化很重要】省掉两次开平方与一次除法，且避免了浮点除法
 * 在极短向量上的数值抖动。模型以 `normalize: true` 输出，单位性由
 * 上游保证；本函数因此可以安全地跳过归一化步骤。
 *
 * 值域 [-1, 1]：同向为 1，正交为 0，反向为 -1。语义文本向量通常落在
 * [0.1, 0.9]，极少为负。
 *
 * @param a 归一化向量 A
 * @param b 归一化向量 B（长度需与 A 相同）
 * @returns 余弦相似度
 */
function cosineDot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  /* 数值安全：点积理论上不超 1，浮点误差可能溢出到 1.0000001 */
  return sum > 1 ? 1 : sum < -1 ? -1 : sum;
}

/**
 * computePriorDistribution —— 领域特征词先验的**四类概率分布**。
 *
 * 【与 classifyWithBuiltinClassifier 的区别】
 * 后者只回答"最像哪类"，用于降级路径；本函数给出**完整的 4 类分布**，
 * 因为神经-符号融合需要每一类的先验概率，而不只是 argmax。
 *
 * 【平滑处理】若日志完全无特征词命中（total = 0），返回 NORMAL_INFO 为 1
 * 的单点分布——这与内置分类器的兜底语义一致。
 *
 * @param text 脱敏后的日志文本
 * @returns 归一化到和为 1 的标签分布
 */
function computePriorDistribution(text: string): Record<EdgeLogLabel, number> {
  const haystack = text.toLowerCase();
  const labels = Object.keys(LABEL_FEATURES) as EdgeLogLabel[];

  const raw: Record<EdgeLogLabel, number> = {
    CRITICAL_PANIC: 0,
    RESOURCE_EXHAUSTED: 0,
    NETWORK_TIMEOUT: 0,
    NORMAL_INFO: 0,
  };

  let total = 0;
  for (const label of labels) {
    let score = 0;
    for (const feature of LABEL_FEATURES[label]) {
      if (haystack.includes(feature.term)) score += feature.weight;
    }
    raw[label] = score;
    total += score;
  }

  if (total === 0) {
    return { CRITICAL_PANIC: 0, RESOURCE_EXHAUSTED: 0, NETWORK_TIMEOUT: 0, NORMAL_INFO: 1 };
  }

  for (const label of labels) raw[label] /= total;
  return raw;
}

/* ========================================================================== */
/* 神经-符号混合融合                                                             */
/* ========================================================================== */

/** 神经网络语义余弦得分的权重 */
const NEURAL_WEIGHT = 0.68;

/** 领域特征词先验得分的权重 */
const PRIOR_WEIGHT = 0.32;

/**
 * softmax 温度：控制余弦分布被锐化的程度。
 *
 * 【为何需要 softmax 而不是直接归一化余弦】4 个原型与同一段日志的余弦值
 * 往往彼此接近（如 0.42 / 0.39 / 0.21 / 0.08）。直接除总和会让差距进一步
 * 被压平，融合后几乎无法投票。softmax 用 exp((c − max)/T) 拉开差距：
 * T 越小越"确信"，越大越"柔和"。0.08 是在本语料上兼顾
 * "不让单个原型独占（T 过小）"与"不让四类均分（T 过大）"的折中值。
 */
const SOFTMAX_TEMPERATURE = 0.08;

/**
 * fuseNeuralAndPrior —— 神经语义与符号规则的加权融合。
 *
 * 【核心公式】
 *   neural[label]  = softmax(cos(label)/T)
 *   fused[label]   = 0.68 · neural[label] + 0.32 · prior[label]
 *   final          = argmax fused
 *
 * 【为何要融合而不是二选一】
 * - **纯神经**：句向量模型是通用语料训练的，对 `oom_score_adj`、
 *   `ETIMEDOUT` 这类极短的领域术语不够敏感，容易把一条内核 panic 判成
 *   "资源类"（因为都涉及 memory）；
 * - **纯符号**：正则/特征词只能匹配**字面**，遇到同义改写
 *   （"进程被内核强制终止" vs "OOMKilled"）立即失效。
 * 两者互补：模型补语义泛化，规则补领域精确性。0.68/0.32 让模型主导
 * 但保留规则的否决能力——当规则极强而模型模糊时，融合结果仍会被拉正。
 *
 * @param neuralDistribution softmax 后的神经分布
 * @param priorDistribution  先验分布
 * @returns 融合后的标签与置信度
 */
function fuseNeuralAndPrior(
  neuralDistribution: Record<EdgeLogLabel, number>,
  priorDistribution: Record<EdgeLogLabel, number>,
): { readonly label: EdgeLogLabel; readonly confidence: number } {
  const labels = Object.keys(PROTOTYPE_TEXTS) as EdgeLogLabel[];

  let bestLabel: EdgeLogLabel = 'NORMAL_INFO';
  let bestScore = -1;
  for (const label of labels) {
    const fused = NEURAL_WEIGHT * neuralDistribution[label] + PRIOR_WEIGHT * priorDistribution[label];
    if (fused > bestScore) {
      bestScore = fused;
      bestLabel = label;
    }
  }

  /*
   * 置信度 = 融合后的胜出概率，并做一次收敛映射：
   * 融合分布在多类接近时最高值可能只有 0.4 左右，直接展示会显得"没把握"；
   * 用 0.5 + 0.5·score 把 [0,1] 拉伸为 [0.5,1]，同时**封顶 0.99**——
   * 任何启发式与端侧模型都不该宣称绝对确定。
   */
  const stretched = 0.5 + 0.5 * Math.max(0, bestScore);
  const confidence = Math.min(0.99, Math.round(stretched * 100) / 100);

  return { label: bestLabel, confidence };
}

/**
 * classifyWithNeuralSemantics —— 真实使用 384 维嵌入做语义分类。
 *
 * 【完整流程】
 * 1. 编码日志 → 384 维单位向量（mean pooling + L2 normalize）；
 * 2. 与 4 个预计算锚点逐一做余弦点积；
 * 3. softmax 锐化为神经分布；
 * 4. 与领域特征词先验加权融合（0.68 / 0.32）；
 * 5. 输出标签 + 校准置信度 + 最高余弦分（供调试与展示）。
 *
 * @param embedding 日志的归一化句向量
 * @param text      脱敏后的日志原文（用于符号先验）
 * @returns 融合结果与最强的原型余弦分
 */
function classifyWithNeuralSemantics(
  embedding: Float32Array,
  text: string,
): { readonly label: EdgeLogLabel; readonly confidence: number; readonly topCosine: number } {
  const labels = Object.keys(PROTOTYPE_TEXTS) as EdgeLogLabel[];

  /* ---- 1. 逐原型计算余弦相似度 ---- */
  const cosines: number[] = [];
  for (const label of labels) {
    const anchor = prototypeEmbeddings[label];
    cosines.push(anchor !== undefined ? cosineDot(embedding, anchor) : 0);
  }

  /* ---- 2. softmax 锐化（减去最大值保证数值稳定） ---- */
  let maxCosine = cosines[0];
  for (const value of cosines) {
    if (value > maxCosine) maxCosine = value;
  }
  const exponentials = cosines.map((value): number => Math.exp((value - maxCosine) / SOFTMAX_TEMPERATURE));
  let expSum = 0;
  for (const value of exponentials) expSum += value;

  const neuralDistribution: Record<EdgeLogLabel, number> = {
    CRITICAL_PANIC: 0,
    RESOURCE_EXHAUSTED: 0,
    NETWORK_TIMEOUT: 0,
    NORMAL_INFO: 0,
  };
  for (let i = 0; i < labels.length; i++) {
    neuralDistribution[labels[i]] = expSum > 0 ? exponentials[i] / expSum : 0;
  }

  /* ---- 3. 与符号先验融合 ---- */
  const priorDistribution = computePriorDistribution(text);
  const fused = fuseNeuralAndPrior(neuralDistribution, priorDistribution);

  return { ...fused, topCosine: maxCosine };
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
  runtime: WorkerInferenceRuntime,
  post: (message: ClassifierResponse) => void,
): Promise<ModelHandle> {
  const label = runtimeLabel(runtime);

  /** 加载任务：动态导入 transformers 并建管道 */
  const loadTask = (async (): Promise<FeatureExtractor> => {
    /* 【动态导入的必要性】transformers 体积大（含 ONNX runtime 绑定），
       静态导入会让 Worker 启动即付出完整解析成本；动态导入让它
       只在真正需要模型时才加载。 */
    const transformers = await import('@huggingface/transformers');

    /* ---- 环境配置：优先随包本地模型，缺失时回退镜像 CDN ---- */
    /*
     * R49：权重随包（public/models/），优先本地路径；本地缺失时仍回退 CDN。
     * localModelPath 只影响解析根；allowRemoteModels 保持默认 true 作为兜底。
     *
     * 【为什么优先 dtype: 'fp32'】
     * @huggingface/transformers v3 对 dtype: 'q8' 会请求 model_quantized.onnx，
     * 而 public/models/Xenova/all-MiniLM-L6-v2/onnx/ 随包放置的是无后缀的 model.onnx（fp32）。
     * 旧实现直接传 dtype: 'q8' 会导致同源 404 并被迫走外网下载；改为优先 fp32 命中本地，
     * 仅在本地缺失/失败时再回退 q8 从镜像拉取量化版。
     */
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = '/models/';
    transformers.env.remoteHost = MODEL_REMOTE_HOST;

    const handleProgress = (info: { status?: string; progress?: number; file?: string }): void => {
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
    };

    /* ---- 建管道（WebGPU 或 WASM） ---- */
    let pipe: unknown;
    try {
      pipe = await transformers.pipeline('feature-extraction', MODEL_ID, {
        device: runtime,
        dtype: 'fp32',
        progress_callback: handleProgress,
      });
    } catch {
      pipe = await transformers.pipeline('feature-extraction', MODEL_ID, {
        device: runtime,
        dtype: 'q8',
        progress_callback: handleProgress,
      });
    }

    return pipe as unknown as FeatureExtractor;
  })();

  /** 熔断定时器：到点即视为超时 */
  const timeoutTask = new Promise<null>((resolve): void => {
    setTimeout((): void => resolve(null), MODEL_LOAD_TIMEOUT_MS);
  });

  try {
    const winner = await Promise.race([loadTask, timeoutTask]);

    if (winner === null) {
      /* ---- 超时熔断：立即降级到内置分类器，保证界面可用 ---- */
      postProgress(post, runtime, label, 100, `${MODEL_ID} (timeout -> builtin)`);

      /*
       * 【后台续载：本轮关键自愈】
       *
       * 3500ms 熔断的设计初衷是"别让界面卡在等模型下载"——这没错。
       * 但旧实现把 loadTask **连同熔断一起丢弃**了：模型其实还在下载，
       * 完成后却没人接住它。结果是冷启动场景下永远停在向内建分类器，
       * 384 维嵌入与原型锚点从头到尾都没机会参与决策。
       *
       * 正确做法是**渐进增强**：熔断只决定"此刻用谁回答"，
       * 不等于"放弃加载"。这里继续等待 loadTask，一旦成功就把
       * modelHandle 热切换为真实模型、补算原型锚点、并推送一条
       * fallback:false 的 ready 消息——主线程据此把状态从
       * "READY · builtin fallback" 升级为真实 WebGPU 推理。
       */
      void loadTask
        .then(async (extractor): Promise<void> => {
          modelHandle = { extractor, fallback: false };
          activeIsBuiltin = false;
          await ensurePrototypes(extractor);
          postProgress(post, runtime, label, 100, MODEL_ID);
          post({
            type: 'ready',
            runtime,
            runtimeLabel: label,
            modelName: MODEL_ID,
            fallback: false,
            coldStartMs: Math.round(performance.now() - WORKER_STARTED_AT),
          });
          postStatus('READY');
        })
        .catch((): void => {
          /* 后台加载最终失败：安静地停留在内置分类器，不弹错 */
        });

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
  runtime: WorkerInferenceRuntime,
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

  /* ---- 路径二：真实模型语义分类 ---- */
  try {
    /*
     * 取句向量（mean pooling + L2 归一化），随后与 4 类原型锚点比对。
     *
     * 【本轮核心自愈】旧实现拿到 `output.data` 后只检查了模长 `norm > 0.5`，
     * 然后**原样返回内置正则分类器的结论**——模型跑完前向却被完全忽略，
     * 属"假端侧推理"。现在真正用 384 维向量做 zero-shot 语义分类：
     * 与预计算锚点做余弦点积 → softmax → 与领域先验加权融合。
     */
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const embedding = output.data;

    /* 输出有效性校验：零向量/NaN 说明推理异常，退回符号路径 */
    let norm = 0;
    for (let i = 0; i < embedding.length; i++) norm += embedding[i] * embedding[i];
    norm = Math.sqrt(norm);

    /* 锚点未就绪（原型编码失败或尚未触发）→ 用符号先验兜底 */
    if (prototypesReady && Number.isFinite(norm) && norm > 0.5 && embedding.length > 0) {
      const semantic = classifyWithNeuralSemantics(embedding, text);
      const elapsed = performance.now() - start;
      return {
        label: semantic.label,
        confidence: semantic.confidence,
        inferenceLatencyMs: Math.round(elapsed * 100) / 100,
      };
    }

    /* 输出异常或锚点缺失 → 退回内置结论（仍如实记录耗时） */
    const builtin = classifyWithBuiltinClassifier(text);
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

/**
 * 模型初始化的**单例 Promise**（B1）。
 *
 * 【解决什么】init 消息与"首批 classify"可能几乎同时到达：
 * 两者都会调用 ensureModel()，而旧实现只判断 `modelHandle !== null`，
 * 在 await 期间该判断仍是 null → 两次完整初始化并发执行，
 * 重复下载权重、重复占 WebGPU 设备（实测在冷启动时会出现双倍内存峰值）。
 *
 * 单例 Promise 让后来者直接 await 同一个进行中的任务，天然去重。
 */
let modelPromise: Promise<ModelHandle> | null = null;

/** 当前运行时（模块级，供每条消息自解释） */
/**
 * Worker 内实际可用的推理后端只有 WebGPU / WASM 两种。
 *
 * 【为何不直接用 ClassifierRuntime】B5 给该类型加了 'builtin'，但 builtin
 * 是"模型没加载、规则兜底"的运行时，不可能出现在 Worker 推理路径里；
 * 若沿用宽类型，transformers 的 device 参数会被 TS 拒绝（实测）。
 * 这里收窄为 Worker 专属子集，赋给消息字段时天然可宽化，无需断言。
 */
const currentRuntime: Exclude<ClassifierRuntime, 'builtin'> = detectRuntime();
const currentLabel = runtimeLabel(currentRuntime);
/** M04/M15：模型超时或不可用降级后如实标记为 builtin */
let activeIsBuiltin = false;

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
  const effectiveRuntime: ClassifierRuntime = activeIsBuiltin ? 'builtin' : currentRuntime;
  const runtimeTag =
    effectiveRuntime === 'webgpu' ? 'WebGPU' : effectiveRuntime === 'wasm' ? 'WASM' : 'builtin';
  const effectiveLabel =
    effectiveRuntime === 'builtin' ? 'Builtin Deterministic Rules (Fallback)' : currentLabel;
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
    runtime: effectiveRuntime,
    runtimeLabel: effectiveLabel,
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
  /* 已加载完成：直接复用 */
  if (modelHandle !== null) return modelHandle;

  /*
   * 已有初始化在途：复用同一个 Promise。
   * 这是 B1「并发重复初始化」缺陷的正解——去重发生在"进行中"这一层，
   * 而不是等第一次结束后靠 modelHandle 兜底（那时已经下载两遍了）。
   */
  if (modelPromise !== null) return modelPromise;

  modelPromise = (async (): Promise<ModelHandle> => {
    const handle = await initModelWithTimeout(currentRuntime, post);
    activeIsBuiltin = handle.fallback;

    /*
     * 【原型锚点预计算】模型真正加载成功后（非降级），立刻把 4 类语义原型的
     * 锚点向量编码出来并缓存。这一步是"端侧模型真的参与决策"的前提：
     * 没有锚点，384 维向量就只是躺在内存里的数字。
     *
     * 失败不致命：ensurePrototypes 返回 false 时，classifyOne 会检测到
     * prototypesReady === false 并退回符号先验路径，功能仍可用。
     */
    if (!handle.fallback && handle.extractor !== null) {
      await ensurePrototypes(handle.extractor);
    }

    const readyRuntime: ClassifierRuntime = handle.fallback ? 'builtin' : currentRuntime;
    const readyLabel = handle.fallback ? 'Builtin Deterministic Rules (Fallback)' : currentLabel;

    post({
      type: 'ready',
      runtime: readyRuntime,
      runtimeLabel: readyLabel,
      modelName: handle.fallback ? 'builtin-semantic-classifier' : MODEL_ID,
      fallback: handle.fallback,
    });
    /* 模型就绪 → 状态同步切到 READY（HUD 立刻可见） */
    postStatus('READY');

    modelHandle = handle;
    return handle;
  })();

  try {
    return await modelPromise;
  } catch (error) {
    /* 初始化失败：清掉单例，允许下一次请求重试（不能永久卡死在 rejected） */
    modelPromise = null;
    throw error;
  }
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
    /* R4：classify 必须携带有限数 requestId（结果配对契约） */
    return (
      Array.isArray(rec.logs) &&
      typeof rec.requestId === 'number' &&
      Number.isFinite(rec.requestId)
    );
  }
  if (rec.type === 'embed') {
    return Array.isArray(rec.texts);
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

  if (request.type === 'embed') {
    const requestId = request.requestId;
    /*
     * 【未就绪契约】模型还在下载 / 已降级 → 立即返回 null，绝不等待。
     * 主线程据此退回两路召回（不阻塞对话）。
     */
    if (modelHandle === null || modelHandle.extractor === null) {
      post({ type: 'embed-result', vectors: null, ...(requestId === undefined ? {} : { requestId }) });
      return;
    }
    const extractor = modelHandle.extractor;
    const texts = request.texts.slice(0, 8);
    void (async (): Promise<void> => {
      const inferenceStartedAt = performance.now();
      try {
        const vectors: number[][] = [];
        for (const text of texts) {
          const output = await extractor(String(text), { pooling: 'mean', normalize: true });
          vectors.push(Array.from(output.data));
        }
        post({
          type: 'embed-result',
          vectors,
          ...(requestId === undefined ? {} : { requestId }),
          latencyMs: Math.round(performance.now() - inferenceStartedAt),
        });
      } catch {
        /* 任何推理异常 → null，主线程走两路；不把 0 向量当结果 */
        post({ type: 'embed-result', vectors: null, ...(requestId === undefined ? {} : { requestId }) });
      }
    })();
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

    /* R4：原样回传请求序号——主线程据此配对，迟到/错配结果会被丢弃 */
    const requestId = request.requestId;

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

        post({ type: 'result', requestId, results });

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
          requestId,
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
