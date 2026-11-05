/**
 * KubeVision AI — 遥测流 Hook 类型契约（唯一类型源）
 *
 * 【契约】依据 AGENTS.md 第 2 条：Hook 返回值与内部状态机必须严格引用
 * src/types/ 下的接口定义，禁止 any / @ts-ignore。
 *
 * 【设计意图】把「传输层健康度」从集群健康度中显式分离出来：
 * 前者回答「数据是怎么来的」（SSE / 本地降级 / 重连中），
 * 后者回答「集群本身好不好」（clusterHealthScore）。
 * 二者混为一谈会让运维在断网时误判集群已崩，因此这里单独立契约。
 */

import type { ConnectionMode } from '@/types/store';

/**
 * TelemetryTransport —— 当前数据通道的三种形态。
 *
 * - 'sse'       → 原生 EventSource 正常接收服务端帧（首选路径）
 * - 'fallback'  → SSE 连续失败 ≥ 阈值后，由客户端本地定时器接管演进
 *                 （stepTelemetrySimulation 本地推进，保证画面不停）
 * - 'connecting'→ 初始/重连中，尚未收到任何有效通道确认
 */
export type TelemetryTransport = 'connecting' | 'sse' | 'fallback';

/**
 * TelemetryStreamState —— Hook 暴露给 UI 的只读观测面。
 *
 * 【用途】顶栏/HUD 可据此显示一个「数据源」小徽标：
 * SSE 正常 → 青色；降级到本地 → 琥珀色并提示「LOCAL SIM」。
 * 这比静默降级更诚实：用户应当知道眼前的数据是真实的还是本地演算的。
 */
export interface TelemetryStreamState {
  /** 当前生效的数据通道形态 */
  readonly transport: TelemetryTransport;
  /** 累计接收到的有效帧数（含本地降级帧，单调递增，可作心跳指示） */
  readonly frameCount: number;
  /** 连续 SSE 错误次数（成功收到消息后清零；达到阈值触发降级） */
  readonly consecutiveErrors: number;
  /** 是否已发生过降级接管（一旦降级保持到下次连接重建） */
  readonly isFallbackActive: boolean;
  /** 最近一次免疫合并修正的 Pod 数量（0 表示本帧无需修正） */
  readonly lastReconciledCount: number;
}

/**
 * UseTelemetryStreamOptions —— Hook 可调参数（测试与调试用，生产用默认值）。
 */
export interface UseTelemetryStreamOptions {
  /**
   * SSE 连续错误阈值：达到即降级为本地定时器演进。
   * @default 2（需求契约值：超过 2 次即接管）
   */
  readonly errorThreshold?: number;
  /**
   * 客户端本地降级的演进间隔（毫秒）。
   * @default 1000（与服务端 TICK_INTERVAL_MS 对齐，降级无感知）
   */
  readonly fallbackIntervalMs?: number;
  /**
   * 自愈免疫窗口（毫秒）：窗口内被强制保持健康的 Pod。
   * @default 15000（需求契约值）
   */
  readonly immunityWindowMs?: number;
  /**
   * 是否启用流连接。
   * @default true
   * 【用途】单元测试或 SSR 预渲染阶段可置 false 完全静默。
   */
  readonly enabled?: boolean;
  /** 传输形态变化时的观测回调（用于日志/埋点，可省略） */
  readonly onTransportChange?: (transport: TelemetryTransport, mode: ConnectionMode) => void;
}
