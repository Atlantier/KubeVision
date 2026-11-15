/**
 * KubeVision AI — 系统健康度、全链路降级矩阵与运行时异常诊断类型契约（R13）
 *
 * 【设计意图】
 * 集中定义 `/api/health` 诊断接口、五层降级矩阵、结构化遥测/对话日志以及前端异常环形缓冲区的
 * 严格 TypeScript 接口契约，杜绝任何 `any` 或匿名散落类型，同时隔离密钥与敏感配置。
 */

/**
 * 五层全链路降级矩阵的唯一层级标识符。
 */
export type DegradationTierId =
  | 'llm-fallback'
  | 'webgpu-fallback'
  | 'sse-synthetic'
  | 'webgl-snapshot'
  | 'topology-2d';

/**
 * 单个降级层级的完整规范条目。
 *
 * 每一层均明确规定触发条件、面向用户的诚实提示文案、恢复条件与降级期间严禁越权宣称的能力，
 * 实现代码运行态与对外口径的单一事实源对齐。
 */
export interface DegradationMatrixItem {
  /** 层级唯一 ID */
  readonly id: DegradationTierId;
  /** 层级序号（1~5） */
  readonly tier: 1 | 2 | 3 | 4 | 5;
  /** 中文层级名称 */
  readonly name: string;
  /** 触发降级的条件 */
  readonly triggerCondition: string;
  /** 面向用户展示的诚实提示文案 */
  readonly userFacingPrompt: string;
  /** 从降级态恢复到主路径的条件 */
  readonly recoveryCondition: string;
  /** 处于该降级态期间严禁对外宣称的能力列表 */
  readonly forbiddenClaims: readonly string[];
}

/**
 * 结构化遥测与对话日志事件类型。
 */
export type StructuredLogEventType =
  | 'connect'
  | 'frame'
  | 'fallback'
  | 'abort'
  | 'heartbeat'
  | 'error'
  | 'budget-limit';

/**
 * 服务端单行 JSON 结构化日志契约（用于 `/api/telemetry`、`/api/chat` 与 `/api/health`）。
 */
export interface StructuredTelemetryLogEvent {
  /** 事件类型 */
  readonly event: StructuredLogEventType;
  /** 链路追踪 ID */
  readonly traceId: string;
  /** 所属 API 路由 */
  readonly route: '/api/telemetry' | '/api/chat' | '/api/health';
  /** 当前阶段或请求耗时（毫秒） */
  readonly durationMs: number;
  /** ISO 8601 时间戳 */
  readonly timestamp: string;
  /** 经过清洗的低敏感度附加属性 */
  readonly attrs?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * `/api/health` 只读诊断响应契约（严禁包含任何凭据或环境变量原文）。
 */
export interface HealthApiResponse {
  /** 服务整体状态 */
  readonly status: 'ok' | 'degraded';
  /** 采样时刻 ISO 字符串 */
  readonly timestamp: string;
  /** 进程运行时长（秒） */
  readonly uptimeSec: number;
  /** 应用版本标识 */
  readonly version: string;
  /** 对话引擎当前就绪态与默认型号标识（不含 API Key 原文） */
  readonly engine: {
    readonly mode: 'llm' | 'simulator';
    readonly llmConfigured: boolean;
    readonly modelName: string;
    readonly fallbackReady: true;
  };
  /** SSE 长连接预算与实时采集遥测 */
  readonly sse: {
    readonly activeConnections: number;
    readonly maxConnections: number;
    readonly maxConnectionLifetimeMs: number;
    readonly totalFramesSent: number;
    readonly totalHeartbeatsSent: number;
    readonly budgetRejectedCount: number;
    readonly lifetimeClosedCount: number;
    readonly lastCollectionDurationMs: number;
    readonly hostSamplerSubscribers: number;
    readonly liveConsecutiveFailures: number;
  };
  /** 五层降级矩阵摘要与当前服务端检测到的降级层 */
  readonly degradation: {
    readonly activeTiers: readonly DegradationTierId[];
    readonly matrixSummary: readonly {
      readonly id: DegradationTierId;
      readonly tier: 1 | 2 | 3 | 4 | 5;
      readonly name: string;
      readonly triggerCondition: string;
      readonly userFacingPrompt: string;
      readonly recoveryCondition: string;
      readonly forbiddenClaims: readonly string[];
    }[];
  };
  /** 运行态能力与安全开关诚实性摘要（M04，不含凭据原文） */
  readonly capabilities?: {
    readonly realClusterWriteEnabled: boolean;
    readonly mcpTokenProtected: boolean;
    readonly k8sApiConfigured: boolean;
  };
  /** 构建与版本冻结可追溯元数据（M07，用于四件套同源核验） */
  readonly buildInfo?: {
    readonly gitSha: string;
    readonly buildEnv: string;
    readonly publicDemoUrl: string;
  };
  /** 统一事实口径元数据（M04，显式区分真实观测/派生估算/演练仿真） */
  readonly factMeta?: {
    readonly telemetrySource: 'synthetic-drill' | 'host-os-bridge' | 'k8s-api';
    readonly metricNature: 'observed' | 'derived-estimate' | 'snapshot';
    readonly confidenceCalibration: 'heuristic_evidence_support_score';
  };
}

/**
 * 前端运行时异常类型分类。
 */
export type RuntimeErrorKind = 'error' | 'unhandledrejection' | 'boundary';

/**
 * 前端内存异常环形缓冲区条目契约（仅存于客户端内存，绝不上传第三方）。
 */
export interface RuntimeErrorEntry {
  /** 条目唯一标识（去重键哈希） */
  readonly id: string;
  /** 排障追踪 traceId */
  readonly traceId: string;
  /** 异常捕获渠道 */
  readonly kind: RuntimeErrorKind;
  /** 脱敏/截断后的可读错误消息 */
  readonly message: string;
  /** 来源位置（文件名:行列号 或 组件边界名） */
  readonly source: string;
  /** 去重时间窗内累计发生次数 */
  readonly count: number;
  /** 首次捕获时间（ISO 字符串） */
  readonly firstSeenAt: string;
  /** 最近一次捕获时间（ISO 字符串） */
  readonly lastSeenAt: string;
}

/**
 * 运行时拓扑视图模式（3D WebGL 主视图 vs 2D SVG 兼容降级视图）。
 */
export type TopologyViewMode = '3d' | '2d';
