'use client';

/**
 * KubeVision AI — 遥测流订阅 Hook（useTelemetryStream）
 *
 * 【职责】把服务端 SSE 推流（或本地降级演进）接入双轨状态系统，
 * 并在投递前执行「自愈免疫合并（State Reconciliation）」，使用户的自愈
 * 操作在 3D 视口中稳定保持翠绿健康态，不被下一帧服务端数据立即推翻。
 *
 * 【三块核心机制】
 *
 * 1. 连接生命周期（Effect 依赖严格锁定 [connectionMode, activeChaos]）
 *    每次混沌场景或数据源模式变化都重建连接（查询参数变了，旧连无用）；
 *    其余任何状态（快照、选中、日志）变化都**不会**重建连接——
 *    这是避免「每帧断开重连」的关键。
 *
 * 2. 自愈免疫合并器（State Reconciliation）
 *    服务端不知道用户刚点了「隔离并重启」，它仍在推 OOMKilled 的帧。
 *    若直接采用，3D 视口会「刚修好又立刻变红」——用户会认为按钮没生效。
 *    因此在投递前读取 healedPodIds，对**免疫窗口内**的 Pod 强制改写为
 *    Running + CPU∈[20,35] + MEM∈[35,45]，并据此重算健康分。
 *    这是「本地用户意图」覆盖「远端客观数据」的受控例外，窗口到期即失效。
 *
 * 3. 双轨分发（高频瞬态轨 / 低频响应轨）
 *    - syncSnapshotToTransientRef：写入 Float32Array 瞬态池，供 useFrame
 *      下一帧 Lerp，零 React 重渲染（AGENTS.md 第 3 条）；
 *    - setSnapshotSummary：写入 zustand 响应轨，驱动 HUD/告警面板等低频 UI。
 *    两轨以同一份（已合并的）快照为唯一交汇点，绝不各写一份。
 *
 * 【高可用降级】
 * EventSource 在断网、服务端未起、反代掐断等场景下会反复 onerror。
 * 连续错误达阈值（默认 2）后：关闭 EventSource，改由客户端 setInterval
 * 调用 stepTelemetrySimulation 本地推进——同一套纯函数引擎，
 * 因此降级后画面风格、数据形态与服务端完全一致（用户无感知）。
 * 本地帧同样走免疫合并与双轨分发，逻辑不分叉。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useClusterStore } from '@/store/useClusterStore';
import { HEAL_IMMUNITY_WINDOW_MS } from '@/constants/telemetryTuning';
import { syncSnapshotToTransientRef, telemetryTransientRef } from '@/store/useTelemetryRef';
import { TICK_INTERVAL_MS, stepTelemetrySimulation } from '@/utils/syntheticEngine';
import { computeClusterHealthScore } from '@/utils/clusterHealth';
import { guardFrameTimestamp, isDuplicateSeq } from '@/utils/frameTimeline';
import {
  recordImmuneRewrites,
  recordSchemaStatus,
  recordSseReconnect,
  recordTelemetryFrame,
  resetTelemetryHealthBaseline,
} from '@/utils/telemetryHealth';
import { pushSnapshotFrame } from '@/utils/snapshotRingBuffer';
import { TELEMETRY_SCHEMA_VERSION } from '@/types/cluster';
import type { PodEntity, TelemetrySnapshot } from '@/types/cluster';
import type { ConnectionMode } from '@/types/store';
import type { TelemetryStreamState, TelemetryTransport, UseTelemetryStreamOptions } from '@/types/hooks';

/* ========================================================================== */
/* 契约常量                                                                    */
/* ========================================================================== */

/** 连续 SSE 错误阈值：达到即降级本地演进（需求契约：超过 2 次接管） */
const DEFAULT_ERROR_THRESHOLD = 2;

/** 本地降级演进间隔（毫秒）：与服务端 tick 对齐，降级无视觉差异 */
const DEFAULT_FALLBACK_INTERVAL_MS = TICK_INTERVAL_MS;

/**
 * 自愈免疫窗口（毫秒）—— 唯一事实源在 constants/telemetryTuning.ts。
 *
 * 【R3 单常量契约】store.healEntity 的「重复自愈去重」与本 Hook 的
 * 「免疫期视觉保持」共用 HEAL_IMMUNITY_WINDOW_MS（15s）：动作卡提示的
 * 「剩余 N 秒」与 3D 视口的翠绿保持期严格一致，不再出现 30s/15s 两套口径
 * 「画面已回落故障态、卡片仍说免疫中」的同屏矛盾。
 */
const DEFAULT_IMMUNITY_WINDOW_MS = HEAL_IMMUNITY_WINDOW_MS;

/** 免疫期 Pod 的 CPU 钳制区间（%，需求契约 20~35） */
const IMMUNE_CPU_MIN = 20;
const IMMUNE_CPU_MAX = 35;

/** 免疫期 Pod 的 MEM 钳制区间（%，需求契约 35~45） */
const IMMUNE_MEM_MIN = 35;
const IMMUNE_MEM_MAX = 45;

/** 免疫期 Pod 的历史序列长度（与 PodEntity 契约一致） */
const HISTORY_POINTS = 6;

/** 最近帧日志去重：仅在这些条件变化时推日志，避免每秒刷屏 */
const ALERT_LOG_LIMIT = 3;

/* ========================================================================== */
/* 收帧间隔耗时统计（滚动窗口，零分配）                                          */
/* ========================================================================== */

/**
 * 延迟统计滚动窗口容量。
 *
 * 【取值依据】8 帧 ≈ 8 秒的采样窗口：足够平滑掉单帧抖动（如某帧被
 * 浏览器主线程阻塞），又能让 HUD 在 2~3 秒内反映链路真实变化。
 * 容量为 2 的幂，用位掩码取模（比 % 快，且无负数问题）。
 */
const LATENCY_WINDOW_SIZE = 8;

/**
 * LatencyTracker —— 收帧间隔耗时的滚动统计器（模块级单例，零分配）。
 *
 * 【为何是模块级而非 Hook 内 ref】`glStats.sseLatencyMs` 是**全局单值**
 * （瞬态池只有一个），多组件/Hook 实例共享同一物理观测面；
 * 且性能 HUD 与画布读的是同一个数。若每个 Hook 实例各持一份统计，
 * 数据来源将取决于「谁最后写」，语义混乱。
 *
 * 【为何用环形缓冲而非每次都新建数组】本统计器每秒被调用一次，
 * 若每次新建数组/求和会产生持续的 GC 压力（虽小，但违反项目零分配纪律）。
 * 环形缓冲预分配 Float32Array，写入 O(1)、求均值 O(窗口大小)=8。
 */
const latencyTracker = {
  /** 环形缓冲：最近 N 个收帧间隔（毫秒） */
  buffer: new Float32Array(LATENCY_WINDOW_SIZE),
  /** 写入游标（0..WINDOW_SIZE-1） */
  cursor: 0,
  /** 已写入样本数（上限 WINDOW_SIZE，用于求均值时确定有效长度） */
  filled: 0,
  /** 最近一次收帧时刻（epoch 毫秒；首次为 0 表示尚未收到过帧） */
  lastFrameAt: 0,
};

/**
 * recordFrameLatency —— 记录一次收帧并更新 glStats.sseLatencyMs。
 *
 * 【核心逻辑】
 * 1. 若上次收帧时刻为 0（本 Hook 实例的首帧），只记录时刻不产生样本
 *    ——首帧间隔无意义（可能距页面加载已过去很久）；
 * 2. 否则 delta = now − lastFrameAt 即「相邻两帧到达的时间间隔」，
 *    理想值应≈1000ms（服务端 1Hz 推送）；
 * 3. delta 写入环形缓冲并推进游标；
 * 4. 求窗口内算术平均写入 glStats.sseLatencyMs。
 *
 * 【语义澄清：这里测的是「帧间隔」而非「网络 RTT」】
 * 真正的端到端网络延迟需要服务端在帧内打发送时间戳、客户端收到后相减，
 * 当前 SSE 协议未携带该字段。因此本指标的含义是「**收帧间隔抖动**」：
 * - ≈1000ms → 链路稳定，1Hz 推送准时到达；
 * - 明显 >1000ms → 推送延迟累积（网络拥塞 / 主线程阻塞 / 服务端卡顿）；
 * - 明显 <1000ms → 客户端本地降级接管（本地定时器无网络开销，间隔更稳定）。
 * 这一语义已在 glStats 的消费端（PerfHUD 标签）如实呈现，不做「假 RTT」。
 *
 * 【为何写瞬态池而非 React 状态】1Hz 写入 + 每帧读取是典型高频遥测场景，
 * 走 setState 会造成每秒重渲染；写入 telemetryTransientRef.glStats 是
 * 原地标量赋值，零分配、零重渲染（AGENTS.md 第 3 条）。
 *
 * @param now 当前时刻（epoch 毫秒，由调用方注入，便于测试）
 */
function recordFrameLatency(now: number): void {
  const previous = latencyTracker.lastFrameAt;
  latencyTracker.lastFrameAt = now;

  /* 首帧：无相邻间隔可比，仅登记时刻 */
  if (previous === 0) {
    return;
  }

  const delta = now - previous;

  /* 写入环形缓冲（位与取模，容量为 2 的幂） */
  latencyTracker.buffer[latencyTracker.cursor] = delta;
  latencyTracker.cursor = (latencyTracker.cursor + 1) & (LATENCY_WINDOW_SIZE - 1);
  if (latencyTracker.filled < LATENCY_WINDOW_SIZE) {
    latencyTracker.filled += 1;
  }

  /* 窗口算术平均（有效长度 = filled，避免未填满时被零值拉低） */
  let sum = 0;
  for (let i = 0; i < latencyTracker.filled; i++) {
    sum += latencyTracker.buffer[i];
  }
  const average = sum / latencyTracker.filled;

  /* 原地写入瞬态池（唯一写入口，消费端为 PerfHUD 的 4Hz 采样） */
  telemetryTransientRef.glStats.sseLatencyMs = Math.round(average);
}

/**
 * resetFrameLatency —— 连接重建时重置统计基线。
 *
 * 【为何需要】切换 chaos / 重连后，首帧与「上一次旧连接的末帧」之间的
 * 间隔毫无意义（可能长达数秒），若不清零会污染窗口均值长达 8 帧。
 * 该函数只清 lastFrameAt，保留历史样本（历史链路质量仍有参考价值）。
 */
function resetFrameLatency(): void {
  latencyTracker.lastFrameAt = 0;
}

/* ========================================================================== */
/* 纯函数：确定性区间钳制与历史构造                                              */
/* ========================================================================== */

/**
 * clampToBand —— 把一个数值确定性映射到 [min, max] 区间内。
 *
 * 【为何不用随机】免疫期的数值需要**稳定**：若每帧随机，CPU 读数会
 * 在 20~35 之间乱跳，波形图呈现锯齿噪声，反而不像"健康稳定"。
 * 这里用值本身的小数部分作确定性抖动源，使同一 Pod 在同一帧得到
 * 稳定的读数，且相邻帧之间仅有源自输入值的轻微变化。
 *
 * @param seed 抖动种子（通常取 Pod 在列表中的下标，保证不同 Pod 取值不同）
 * @param min  区间下界
 * @param max  区间上界
 * @returns [min, max] 内的确定性数值（保留一位小数）
 */
function clampToBand(seed: number, min: number, max: number): number {
  /* 用黄金比例散列把整数种子打散到 [0,1) */
  const scrambled = (seed * 0.6180339887498949) % 1;
  const value = min + Math.abs(scrambled) * (max - min);
  return Math.round(value * 10) / 10;
}

/**
 * buildCalmHistory —— 构造免疫期的 6 点恢复历史（末位锚定当前值）。
 *
 * 【语义】Pod 刚被重启恢复，资源占用自低位平滑爬升至稳态：
 * 前几点略低，末点精确等于当前值（满足 PodEntity「索引 5 = 当前值」契约）。
 *
 * @param current 当前稳定值（序列末位）
 * @returns 长度恒为 6 的整数序列
 */
function buildCalmHistory(current: number): number[] {
  const history: number[] = [];
  for (let i = 0; i < HISTORY_POINTS - 1; i++) {
    /* 自 current 的 85% 线性爬升到 current（模拟冷启动后的水位恢复） */
    const ratio = 0.85 + (0.15 * i) / (HISTORY_POINTS - 2);
    history.push(Math.round(current * ratio));
  }
  history.push(Math.round(current));
  return history;
}

/* ========================================================================== */
/* 纯函数：自愈免疫合并器                                                       */
/* ========================================================================== */

/** 免疫合并的结果（快照 + 修正计数，供日志与观测使用） */
interface ReconciliationResult {
  readonly snapshot: TelemetrySnapshot;
  readonly reconciledCount: number;
}

/**
 * ImmutablePodLevel —— 免疫期内被强制改写到的展示值（用于窗口到期后的平滑回落）。
 *
 * 【为什么需要记住它】免疫窗口一旦到期，Pod 的展示值会从"被改写的健康值"
 * 切回服务端真实值（可能仍是 96% 内存）。若直接切换就是一帧突跳。
 * 记住最后一帧的免疫值，到期那一帧做一次插值，视觉上就是"平滑回落"。
 */
export interface ImmuneSmoothingEntry {
  readonly cpuUsage: number;
  readonly memoryUsage: number;
}

/**
 * IMMUNE_EXIT_SMOOTH_FACTOR —— 窗口到期后首帧向真实值靠拢的比例。
 *
 * 0.5 的含义：到期第一帧先走一半，第二帧起完全交给服务端真实值。
 * 取 0.5 而不是 1.0 是为了"不允许突跳"；也不取更小的值，是因为
 * 免疫窗口本身只有十几秒，拖太久会让人怀疑自愈没有生效。
 */
const IMMUNE_EXIT_SMOOTH_FACTOR = 0.5;

/**
 * reconcileSnapshot —— 自愈免疫合并器（State Reconciliation）。
 *
 * 【核心流转】
 * 1. 读取 healedPodIds（targetId → 最近自愈 epoch 毫秒）；
 * 2. 逐 Pod 判定：若 now − healedAt < immunityWindowMs，则该 Pod 处于
 *    「用户刚修好、需要视觉稳定」的窗口内；
 * 3. 对窗口内 Pod 强制改写：
 *    - status = 'Running'（3D 实例即刻转翠绿）
 *    - cpuUsage ∈ [20,35]、memoryUsage ∈ [35,45]（确定性取值，见 clampToBand）
 *    - cpuHistory / memHistory 重构为平滑爬升曲线（波形图呈现健康恢复）
 *    - restarts 归零（已重启成功，计数器应复位）
 * 4. 受影响节点同步修正：若该节点名下仍有崩溃 Pod 则保持原状态，
 *    否则置 Ready 并把水位拉回健康区间——避免「Pod 全绿但机架仍高负载」
 *    的视觉矛盾；
 * 5. 清空 activeAlerts（自愈后无活跃告警），重算 clusterHealthScore。
 *
 * 【为何必须派生新对象】TelemetrySnapshot 全字段 readonly，且传入的
 * 很可能是 zustand/瞬态池内的共享引用；原地 mutate 会污染调用方状态，
 * 导致后续比对逻辑全部失效。
 *
 * @param snapshot       收到的原始快照（服务端 SSE 帧或本地降级帧）
 * @param healedPodIds   免疫表（自愈目标 ID → epoch 毫秒）
 * @param windowMs       免疫窗口长度（毫秒）
 * @param now            当前时刻（由调用方注入，便于测试与纯函数化）
 * @returns 合并后的快照与修正计数
 */
export function reconcileSnapshot(
  snapshot: TelemetrySnapshot,
  healedPodIds: Readonly<Record<string, number>>,
  windowMs: number,
  now: number,
  smoothState?: Map<string, ImmuneSmoothingEntry>,
): ReconciliationResult {
  const entries = Object.keys(healedPodIds);

  /* ---- 1. 建立「仍处于免疫窗口内」的 Pod ID 集合 ---- */
  const immunePodIds = new Set<string>();
  for (const targetId of entries) {
    const healedAt = healedPodIds[targetId];
    if (typeof healedAt !== 'number') continue;
    const elapsed = now - healedAt;
    /* elapsed >= 0 防御时钟回拨；窗口到期自动退出免疫 */
    if (elapsed >= 0 && elapsed < windowMs) {
      immunePodIds.add(targetId);
    }
  }

  /*
   * ---- 快路径 ----
   * 既没有免疫 Pod、也没有待平滑条目时原样返回（零分配）。
   * 【为什么不能只判断 immunePodIds.size === 0】窗口到期后的那一帧
   * 仍需要走平滑逻辑：此时 immunePodIds 已为空，但 smoothState 里还留着
   * 上一帧的展示值，必须再做一次插值才能避免突跳。
   */
  if (immunePodIds.size === 0 && (smoothState === undefined || smoothState.size === 0)) {
    return { snapshot, reconciledCount: 0 };
  }

  /* ---- 2. 逐 Pod：免疫改写 + 窗口到期后的一帧平滑回落 ---- */
  let reconciledCount = 0;
  const pods: PodEntity[] = snapshot.pods.map((pod, index): PodEntity => {
    if (immunePodIds.has(pod.id)) {
      reconciledCount += 1;

      const cpu = clampToBand(index + 1, IMMUNE_CPU_MIN, IMMUNE_CPU_MAX);
      const mem = clampToBand(index + 7, IMMUNE_MEM_MIN, IMMUNE_MEM_MAX);

      /* 记住本帧展示值：窗口到期后要用它做插值起点 */
      smoothState?.set(pod.id, { cpuUsage: cpu, memoryUsage: mem });

      return {
        ...pod,
        status: 'Running',
        cpuUsage: cpu,
        memoryUsage: mem,
        restarts: 0,
        cpuHistory: buildCalmHistory(cpu),
        memHistory: buildCalmHistory(mem),
      };
    }

    /*
     * ---- 窗口刚到期：一帧插值平滑回服务端真实值 ----
     *
     * 【为什么必须插值】免疫期内展示值被强制改成健康区间（如内存 41%），
     * 而服务端真实值可能仍是 96%。窗口一到就直接切换，画面上就是一帧突跳
     * （趋势图出现垂直跳变、3D 柱体高度瞬间翻倍）。
     * 这里取「上一帧展示值 → 本帧真实值」的中点，只插一帧：
     * 标记随插值一起删除，下一帧起完全使用服务端数据，不会长期篡改。
     */
    const last = smoothState?.get(pod.id);
    if (last !== undefined) {
      smoothState?.delete(pod.id);

      const cpu =
        Math.round(
          (last.cpuUsage + (pod.cpuUsage - last.cpuUsage) * IMMUNE_EXIT_SMOOTH_FACTOR) * 10,
        ) / 10;
      const mem =
        Math.round(
          (last.memoryUsage + (pod.memoryUsage - last.memoryUsage) * IMMUNE_EXIT_SMOOTH_FACTOR) * 10,
        ) / 10;

      return {
        ...pod,
        cpuUsage: cpu,
        memoryUsage: mem,
        /* 历史序列末位必须等于当前值（PodEntity 契约），故替换末位而不是整段重写 */
        cpuHistory: [...pod.cpuHistory.slice(0, HISTORY_POINTS - 1), cpu],
        memHistory: [...pod.memHistory.slice(0, HISTORY_POINTS - 1), mem],
      };
    }

    return pod;
  });

  /* ---- 3. 节点状态同步修正：只对「免疫目标 Pod 所属节点」生效 ---- */
  /*
   * 【自愈的缺陷】旧实现遍历**所有**节点：只要某节点名下没有异常 Pod，
   * 就把它的状态改成 Ready、水位改写成健康区间。
   * 后果是自愈一个 Pod 会顺带"洗白"与本次自愈毫无关系的节点——
   * 例如用户只修了 worker-beta 上的 Pod，worker-alpha 的 CPU 尖峰
   * （HighLoad）也会被改成 Ready，健康分被动拉高，演练语义被抹掉。
   * 现在只修正免疫目标 Pod 真正所属的节点，其余节点保持服务端真实状态。
   */
  const immuneNodeIds = new Set<string>();
  for (const pod of snapshot.pods) {
    if (immunePodIds.has(pod.id)) {
      immuneNodeIds.add(pod.nodeId);
    }
  }

  const nodes = snapshot.nodes.map((node) => {
    /* 与本次自愈无关的节点：原样保留（不洗白） */
    if (!immuneNodeIds.has(node.id)) return node;

    /* 该节点名下是否仍有异常 Pod（崩溃/调度中） */
    let hasAbnormal = false;
    for (const pod of pods) {
      if (pod.nodeId !== node.id) continue;
      if (pod.status === 'CrashLoopBackOff' || pod.status === 'OOMKilled' || pod.status === 'Pending') {
        hasAbnormal = true;
        break;
      }
    }
    if (hasAbnormal) return node;

    /* 无异常 Pod：节点回归 Ready，水位拉回健康区间 */
    const cpu = clampToBand(node.rackIndex + 11, 28, 46);
    const mem = clampToBand(node.rackIndex + 17, 38, 58);
    return {
      ...node,
      status: 'Ready' as const,
      cpuUsage: cpu,
      memUsage: mem,
    };
  });

  /* ---- 4. 清空告警并重算健康分（自愈后不应残留活跃告警） ---- */
  const activeAlerts = snapshot.activeAlerts.filter(
    (alert): boolean => !immunePodIds.has(alert.entityId),
  );
  const clusterHealthScore = computeClusterHealthScore(nodes, pods, activeAlerts);

  return {
    snapshot: {
      ...snapshot,
      pods,
      nodes,
      activeAlerts,
      clusterHealthScore,
    },
    reconciledCount,
  };
}
/* ========================================================================== */
/* Hook 主体                                                                   */
/* ========================================================================== */

/**
 * useTelemetryStream —— 遥测流订阅 + 自愈免疫合并 + 双轨分发 + 降级兜底。
 *
 * @param options 可选配置（阈值/间隔/窗口/开关/观测回调），生产用默认值
 * @returns 只读的传输层观测面（TelemetryStreamState）
 */
export function useTelemetryStream(options: UseTelemetryStreamOptions = {}): TelemetryStreamState {
  const errorThreshold = options.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;
  const fallbackIntervalMs = options.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS;
  const immunityWindowMs = options.immunityWindowMs ?? DEFAULT_IMMUNITY_WINDOW_MS;
  const enabled = options.enabled ?? true;
  const onTransportChange = options.onTransportChange;

  /* ---- 响应轨订阅（仅这两个字段变化才重建连接） ---- */
  const connectionMode = useClusterStore((s): ConnectionMode => s.connectionMode);
  const activeChaos = useClusterStore((s) => s.activeChaos);

  /* ---- 暴露给 UI 的观测状态（低频：仅在通道变化时更新） ---- */
  const [transport, setTransport] = useState<TelemetryTransport>('connecting');
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);
  const [lastReconciledCount, setLastReconciledCount] = useState(0);

  /**
   * 【R4 · 1Hz 成本】帧计数移入瞬态轨（glStats.telemetryFrameCount）。
   * 旧实现是 useState：page 根调用本 Hook，每帧 +1 都重渲染整棵页面树。
   * 计数只供 HUD 心跳展示，rAF 直读瞬态池即可，无需 React 参与。
   */

  /** 错误计数镜像（供回调内同步读写，避免闭包陈旧） */
  const errorCountRef = useRef(0);
  /** 是否已降级（一旦降级不再尝试 SSE 直到下次 Effect 重建） */
  const fallbackActiveRef = useRef(false);
  /** 最近一次告警签名（用于日志去重：仅告警集合变化才推日志） */
  const lastAlertSignatureRef = useRef<string>('');
  /** 最近一次混沌场景（用于检测场景切换并推日志） */
  const lastChaosRef = useRef<string>(activeChaos);
  /** 传输形态镜像（供回调读取最新值，避免在回调里闭包旧状态） */
  const transportRef = useRef<TelemetryTransport>('connecting');

  /**
   * lastSeqRef —— 最近已接受帧的 seq（R4：时间轴去重）。
   * seq <= lastSeq 的帧直接丢弃：重复帧若放行，会再走一遍时间戳单调修正
   * （+1 tick），时间轴被重复帧一步步推离服务端真实时钟（+1000 积分漂移）。
   * 【重连复位】新 SSE 连接从种子 seq=0 起步，onopen 时复位为 -1；
   * 本地降级引擎从 evolutionBaseRef 续接（seq 连续），不复位。
   */
  const lastSeqRef = useRef(-1);

  /** 容量截断告警是否已上报（每连接只报一次，避免每秒刷屏） */
  const truncationReportedRef = useRef(false);

  /**
   * evolutionBaseRef —— 演进基准快照（连续性核心）。
   *
   * 【解决的问题】降级/重连时本地引擎必须从「最新的真实数据」继续演进，
   * 但**不能**从 telemetryTransientRef.snapshot 取——因为 deliver 写入
   * 瞬态池的是**免疫合并后**的快照：若用户刚自愈并按住了 15 秒免疫窗口，
   * 池中该 Pod 的 memoryUsage 已被强制改为 37.7，而服务端原始值是 96。
   * 从池中续接会让本地演进沿着「被改写的状态」走，免疫窗口一到期，
   * 数值会突然从 37.7 跳回 96 附近——视觉上就是一次无解释的突跳。
   *
   * 【本 ref 的语义】恒指向**最近一帧未经合并的原始数据**，
   * 是「客观世界的最新已知状态」。免疫只是展示层滤镜，不改变这个基准。
   *
   * 【初始化】以瞬态池初始快照为起点（页面加载时二者相同）。
   */
  const evolutionBaseRef = useRef<TelemetrySnapshot>(telemetryTransientRef.snapshot);

  /**
   * immuneSmoothingRef —— 免疫展示值的平滑回落缓存（Pod ID → 最后一帧免疫值）。
   *
   * 【为什么是 ref 而不是 state】它只在帧投递管线里读写，不驱动渲染；
   * 放进 state 会让每个 tick 触发一次重渲染，直接违反 60 FPS 红线。
   *
   * 【生命周期】
   * - Pod 处于免疫窗口内：每帧写入当前展示值；
   * - 窗口到期后的第一帧：读出该值做一次插值，随后删除条目；
   * - 因此任何时刻表里最多只有"仍在免疫中"的 Pod，规模与自愈目标数量同阶。
   */
  const immuneSmoothingRef = useRef<Map<string, ImmuneSmoothingEntry>>(new Map());

  /**
   * hasReceivedFrameRef —— 是否已收到过至少一帧有效数据。
   *
   * 【用途】区分「从未连上过」与「连上后断开」两种降级起点：
   * 前者无历史可续接，应以瞬态池种子快照起步；
   * 后者必须从 evolutionBaseRef 的原始帧无缝续接。
   * 该标志在 Hook 生命周期内单调（一旦为 true 不再复位），
   * 因为「曾经收到过帧」这件事不会因重连而改变。
   */
  const hasReceivedFrameRef = useRef(false);

  /**
   * 配置项镜像 ref —— 让主 Effect 的依赖数组得以严格锁定为
   * [connectionMode, activeChaos]。
   *
   * 【为何必须这样做】若把 errorThreshold / fallbackIntervalMs / enabled /
   * deliver / 回调等写入依赖数组，它们任一变化（如父组件重渲染导致
   * onTransportChange 重新创建）都会**销毁并重建 SSE 连接**，
   * 造成「每帧断开重连」的灾难性行为。把这些值放进 ref 后，
   * Effect 只对「真正需要换连接」的两个字段（模式、混沌场景）敏感，
   * 其余配置在 Effect 内部通过 ref.current 读取最新值。
   */
  const configRef = useRef({
    errorThreshold,
    fallbackIntervalMs,
    immunityWindowMs,
    enabled,
    onTransportChange,
  });
  configRef.current = {
    errorThreshold,
    fallbackIntervalMs,
    immunityWindowMs,
    enabled,
    onTransportChange,
  };

  /** 混沌场景镜像（Effect 的 closure 需要它，但不作为依赖项） */
  const chaosRef = useRef(activeChaos);
  chaosRef.current = activeChaos;

  /** connectionMode 镜像（供 setTransportBoth 的回调使用） */
  const modeRef = useRef(connectionMode);
  modeRef.current = connectionMode;

  /**
   * setTransportBoth —— 统一的传输形态切换入口（同步 ref + state + 外部回调）。
   *
   * 【依赖数组为空】函数体只访问 ref 与 setState（均为稳定引用），
   * 因此身份恒定——这也是它能安全地被主 Effect 通过 ref 调用的前提。
   */
  const setTransportBoth = useCallback((next: TelemetryTransport): void => {
    if (transportRef.current === next) return;
    transportRef.current = next;
    setTransport(next);
    configRef.current.onTransportChange?.(next, modeRef.current);
  }, []);

  /** setTransportBoth 镜像（Effect 内调用，不占依赖位） */
  const setTransportBothRef = useRef(setTransportBoth);
  setTransportBothRef.current = setTransportBoth;

  /**
   * deliver —— 帧投递管线（SSE 帧与本地降级帧的**唯一**汇合点）。
   *
   * 【核心流转】
   * 1. 读取最新免疫表（getState() 而非闭包，保证拿到用户最新一次自愈）；
   * 2. reconcileSnapshot 执行免疫合并；
   * 3. 双轨分发：瞬态池（R3F 零重渲染）+ 响应轨（低频 UI）；
   * 4. 告警/混沌变化时推终端日志（去重，避免每秒刷屏）；
   * 5. 记录收帧间隔耗时到 glStats.sseLatencyMs（性能 HUD 的数据源）。
   */
  const deliver = useCallback(
    (rawSnapshot: TelemetrySnapshot): void => {
      /* ---- 0. seq 去重（R4：重复帧是时间轴漂移的根源，先于一切处理丢弃） ---- */
      if (isDuplicateSeq(rawSnapshot.seq, lastSeqRef.current)) {
        telemetryTransientRef.glStats.staleSeqFrames += 1;
        return;
      }
      lastSeqRef.current = rawSnapshot.seq;

      /* R4：管线主线程成本实测（累加到瞬态轨，探针差分取证） */
      const pipelineT0 = performance.now();

      const store = useClusterStore.getState();

      /* ---- 1+2. 免疫合并（读最新免疫表，窗口外自动放行原始数据） ---- */
      /**
       * 【客户端时间戳单调保护（第二道防线）】
       *
       * 服务端已通过 since 参数保证重连后时钟不回退，但防御性编程要求
       * 客户端也不信任入站数据：若某帧的时间戳早于当前已知进度
       * （服务端重启、代理缓存旧帧、多实例负载不均等），则把该帧的
       * 时间戳钳制到「已知进度 + 一个 tick」，保持单调递增。
       *
       * 只改 timestamp 不改数据内容：数据本身仍是新鲜到达的，
       * 仅是时间轴需要一个合理的落点。
       */
      const knownTs = evolutionBaseRef.current.timestamp;
      const guardedTs = guardFrameTimestamp(rawSnapshot.timestamp, knownTs, TICK_INTERVAL_MS);
      const guarded: TelemetrySnapshot =
        guardedTs === rawSnapshot.timestamp ? rawSnapshot : { ...rawSnapshot, timestamp: guardedTs };

      /* ---- 0. 演进基准留存（连续性核心，详见 evolutionBaseRef 契约） ---- */
      /* 保存的是**未合并的原始帧**：免疫是「展示层修正」，不应污染演进基准，
         否则免疫期内的本地降级会从被改写的状态继续，窗口一到期就出现数值跳变 */
      evolutionBaseRef.current = guarded;
      hasReceivedFrameRef.current = true;

      const { snapshot: reconciled, reconciledCount } = reconcileSnapshot(
        guarded,
        store.healedPodIds,
        immunityWindowMs,
        Date.now(),
        /* 平滑缓存：窗口到期后用它把展示值平滑回服务端真实值（一帧插值） */
        immuneSmoothingRef.current,
      );

      /*
       * ---- 数据健康度量（瞬态轨，零重渲染） ----
       * 这里把「QPS 偏差 / 节点水位偏离 / 帧间隔抖动」等指标写入模块单例，
       * Shift+P 的 HUD 用 rAF 直读、不走 React 状态。
       * 免疫改写条数单独累计：它是"我们改过数据"的自我审计，必须可见。
       */
      recordTelemetryFrame(reconciled);
      if (reconciledCount > 0) recordImmuneRewrites(reconciledCount);

      /*
       * ---- 环形缓冲：保留最近 120 帧（约 2 分钟）供复盘报告使用 ----
       * 存的是**免疫合并后**的展示帧：复盘报告的叙事应当与观众当时看到的一致。
       */
      pushSnapshotFrame(reconciled);

      /* ---- 3. 双轨分发 ---- */
      /* 轨一：瞬态池（Float32Array 原地写入，useFrame 下一帧 Lerp，零重渲染） */
      const fullySynced = syncSnapshotToTransientRef(reconciled);
      /* 容量截断上报（R4：truncated 标志必须可见，每连接只报一次） */
      if (!fullySynced && !truncationReportedRef.current) {
        truncationReportedRef.current = true;
        store.appendTerminalLog(
          '[WARN] 遥测实体超出瞬态容量（MAX_PODS=48），超出部分本帧未着色，槽位复用已启用',
        );
      }
      /* 轨二：响应轨快照摘要（驱动 HUD / 告警面板等低频 UI） */
      store.setSnapshotSummary(reconciled);

      /* ---- 3b. 收帧间隔耗时埋点（写入瞬态池，零 React 参与） ---- */
      recordFrameLatency(Date.now());

      /* ---- 4. 终端日志（仅告警集合或混沌场景变化时推送，严格去重） ---- */
      const alertSignature = reconciled.activeAlerts
        .map((alert): string => `${alert.level}:${alert.entityId}`)
        .slice(0, ALERT_LOG_LIMIT)
        .join('|');
      if (alertSignature !== lastAlertSignatureRef.current) {
        lastAlertSignatureRef.current = alertSignature;
        if (reconciled.activeAlerts.length > 0) {
          for (const alert of reconciled.activeAlerts.slice(0, ALERT_LOG_LIMIT)) {
            store.appendTerminalLog(`[${alert.level}] ${alert.message}`);
          }
        } else {
          store.appendTerminalLog('[INFO] all alerts cleared - cluster nominal');
        }
      }
      if (lastChaosRef.current !== activeChaos) {
        lastChaosRef.current = activeChaos;
        store.appendTerminalLog(
          activeChaos === 'NONE'
            ? '[CHAOS-MESH] chaos scenario terminated - rolling back to steady state'
            : `[CHAOS-MESH] chaos scenario injected -> ${activeChaos}`,
        );
      }

      /* ---- 5. 观测状态更新（免疫计数变化才 setState，避免每帧重渲染） ----
       * 【R3】窗口结束 reconciledCount=0 也必须写回：旧实现只在 >0 时更新，
       * 免疫到期后 lastReconciledCount 永远停在旧值，观测面谎报「仍在免疫」。
       * 相等性守卫保证稳态（恒 0）不触发任何重渲染。 */
      setLastReconciledCount((prev): number => (prev === reconciledCount ? prev : reconciledCount));

      /* R4：帧计数写瞬态轨（零 React 参与），HUD 以 rAF 直读 */
      telemetryTransientRef.glStats.telemetryFrameCount += 1;
      telemetryTransientRef.glStats.telemetryPipelineMs += performance.now() - pipelineT0;
    },
    [activeChaos, immunityWindowMs],
  );

  /**
   * deliver 镜像 ref —— 让主 Effect 通过 ref 调用最新版 deliver，
   * 从而不必把函数身份写进依赖数组（否则每次 deliver 重建都会重连 SSE）。
   * 声明在此处（deliver 之后）以满足 TDZ 与类型检查。
   */
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;

  /* ====================================================================== */
  /* 主 Effect：连接生命周期（依赖严格锁定 connectionMode + activeChaos）      */
  /* ====================================================================== */
  useEffect(() => {
    /* ---- 从 ref 读取最新配置（这些值不参与依赖，避免无谓重建连接） ---- */
    const config = configRef.current;
    if (!config.enabled) return undefined;

    /* 每次重建连接都重置降级与错误状态 */
    fallbackActiveRef.current = false;
    errorCountRef.current = 0;
    setConsecutiveErrors(0);
    setTransportBothRef.current('connecting');

    /*
     * ---- 数据健康：重连计数 + 抖动基线重置 ----
     * 每次建立新连接都记一次重连（切 chaos、降级重建都算），并把帧间隔基线清零——
     * 否则"断流 8 秒后的首帧间隔"会被当成一次巨大抖动，污染 HUD。
     */
    recordSseReconnect();
    resetTelemetryHealthBaseline();

    /**
     * 重置延迟统计基线：旧连接末帧与新连接首帧之间的间隔无意义
     * （可能长达数秒），若不清零会污染滚动均值长达 8 帧。
     */
    resetFrameLatency();

    /**
     * 【重连连续性契约】重建连接前确保演进基准可用。
     *
     * 场景：用户切换 activeChaos → 本 Effect 重跑 → 新连接建立需要时间
     * （握手 + 首帧至少 1 秒）。这段空窗期内若发生降级，本地引擎需要起点。
     *
     * 判定依据是「是否曾经收到过帧」：deliver 每次都会把 evolutionBaseRef
     * 指向收到的原始帧，因此只有当它仍严格等于瞬态池初始快照
     * （即从未收到过任何帧）时，才需要从瞬态池兜底同步一次。
     * 反之则保留它——因为它持有的是未合并的原始数据，比（可能被免疫
     * 改写过的）瞬态池更干净，这正是连续性的关键。
     */
    if (!hasReceivedFrameRef.current) {
      evolutionBaseRef.current = telemetryTransientRef.snapshot;
    }

    /* SSR 边界：EventSource 与 setInterval 仅在浏览器可用 */
    if (typeof window === 'undefined') return undefined;

    /** 本地降级定时器句柄 */
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    /** EventSource 句柄（null 表示已关闭或从未建立） */
    let eventSource: EventSource | null = null;
    /** 连接是否已被本 Effect 的清理函数销毁（防止 onerror 在 cleanup 后仍降级） */
    let disposed = false;

    /**
     * startFallback —— 降级接管：关闭 SSE，改由本地引擎推进。
     *
     * 【为何复用同一套 stepTelemetrySimulation】降级后的数据形态必须与
     * 服务端完全一致（同样的状态机、同样的字段、同样的量级），
     * 否则用户会察觉「画面风格突变」。同源引擎是唯一能做到无感降级的方案。
     */
    const startFallback = (): void => {
      if (disposed || fallbackActiveRef.current) return;
      fallbackActiveRef.current = true;

      /* 关闭 SSE（避免继续触发 onerror 刷屏） */
      if (eventSource !== null) {
        eventSource.close();
        eventSource = null;
      }

      setTransportBothRef.current('fallback');
      useClusterStore
        .getState()
        .appendTerminalLog('[WARN] telemetry stream degraded -> local simulation engine engaged');

      fallbackTimer = setInterval((): void => {
        if (disposed) return;
        /**
         * 【演进连续性契约：从「最新原始帧」续接，而非从瞬态池】
         *
         * 取 evolutionBaseRef（最近一帧未合并的真实数据）作基准：
         * 1. 免疫期内不会沿着被改写的展示态演进（避免窗口到期数值突跳）；
         * 2. 切换 chaos 后重建的降级定时器能从旧连接收到的最后一帧无缝续接，
         *    时间戳保持单调递增（stepTelemetrySimulation 内部 +1000ms），
         *    画面不会出现时间倒退或跳帧；
         * 3. 若从未收到过任何帧（极端：打开即断网），ref 持有初始种子快照，
         *    本地引擎仍可从稳态起步，画面依旧鲜活。
         */
        const next = stepTelemetrySimulation(
          evolutionBaseRef.current,
          chaosRef.current,
        );
        deliverRef.current(next);
      }, config.fallbackIntervalMs);
    };

    /* ---- 路径一：建立 EventSource ---- */
    /**
     * 【重连续接】把「最后已知时间戳」随连接传给服务端（since 参数）。
     *
     * 服务端每次新连接都从固定种子快照起步，若不告知进度就会出现
     * 「切换 chaos 后时钟倒退 12 秒」的跳变（实测 gaps 出现 −12000ms）。
     * 携带 since 后服务端把起始时间戳抬到该值，保证跨连接单调。
     */
    const lastKnownTs = evolutionBaseRef.current.timestamp;
    const url = `/api/telemetry?mode=${connectionMode}&chaos=${activeChaos}&since=${lastKnownTs}`;
    try {
      eventSource = new EventSource(url);
    } catch {
      /* 构造即抛错（极少数环境）：直接降级，保证画面不停 */
      startFallback();
      return (): void => {
        disposed = true;
        if (fallbackTimer !== null) {
          clearInterval(fallbackTimer);
          fallbackTimer = null;
        }
      };
    }

    /* 连接建立：收到 open 时暂不清空 errorCountRef（待 onmessage 收到真实遥测帧再清零，避免服务端 HTTP 200 下发 budget-exceeded 立即关流造成重连死循环） */
    eventSource.onopen = (): void => {
      if (disposed) return;
      setTransportBothRef.current('sse');
      /*
       * 【R4 · seq 跨连接复位】每条新连接（含 EventSource 自动重连）
       * 服务端都从种子 seq=0 重新起步，这里复位去重基准；
       * 连接内仍严格单调，重复帧照丢。截断告警也按连接重新允许一次。
       */
      lastSeqRef.current = -1;
      truncationReportedRef.current = false;
    };

    /* 服务端并发连接预算耗尽：立即优雅切换本地合成推演，不再无效重连 */
    eventSource.addEventListener('budget-exceeded', (): void => {
      if (disposed) return;
      startFallback();
    });

    /* 服务端到达最大单连接存活周期（如 Vercel 50s 窗口）：清零错误计数并允许 EventSource 平滑续连 */
    eventSource.addEventListener('lifetime-expired', (): void => {
      if (disposed) return;
      errorCountRef.current = 0;
      setConsecutiveErrors(0);
    });

    /* 收到数据帧：正常投递管线 */
    eventSource.onmessage = (event: MessageEvent<string>): void => {
      if (disposed) return;
      try {
        const parsed = JSON.parse(event.data) as TelemetrySnapshot;
        /* 轻量结构校验：拒收畸形帧（如服务端异常返回 HTML） */
        if (!Array.isArray(parsed.pods) || !Array.isArray(parsed.nodes)) {
          return;
        }

        /*
         * ---- schema 版本协商（未知版本 → 只读降级）----
         *
         * 只接受与客户端完全一致的版本：
         * · 缺失（undefined）说明对端是旧协议，字段语义无法保证；
         * · 高于支持版本说明服务端已升级，新字段/新语义客户端不认识。
         * 两种情况都**不再应用新帧**，保留最后一帧合法画面，并由 HUD/顶栏提示。
         * "尽力解析"在这里是错误策略——画面对但数据错比停更更危险。
         */
        const version = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 0;
        if (version !== TELEMETRY_SCHEMA_VERSION) {
          recordSchemaStatus(version, true);
          useClusterStore.getState().setTelemetrySchemaState(
            true,
            `遥测协议版本不匹配（服务端 v${version === 0 ? '未知' : version}，客户端 v${TELEMETRY_SCHEMA_VERSION}）· 已切换只读`,
          );
          return;
        }
        /* 版本合法：清除可能残留的只读提示 */
        if (useClusterStore.getState().telemetryReadOnly) {
          useClusterStore.getState().setTelemetrySchemaState(false, null);
        }
        recordSchemaStatus(version, false);

        /* 成功收到有效帧：清零错误计数并确认 SSE 通道 */
        errorCountRef.current = 0;
        setConsecutiveErrors(0);
        setTransportBothRef.current('sse');
        deliverRef.current(parsed);
      } catch {
        /* 解析失败不计入错误阈值（可能是 SSE 注释帧等非 JSON 载荷），
           但也不投递——静默跳过，等下一帧 */
      }
    };

    /* 错误：累计计数，达阈值即降级 */
    eventSource.onerror = (): void => {
      if (disposed) return;
      errorCountRef.current += 1;
      const current = errorCountRef.current;
      setConsecutiveErrors(current);

      /**
       * 【关键判定：readyState === CLOSED 说明连接已彻底死亡】
       *
       * EventSource 的错误分两类，行为截然不同：
       * a) readyState === CONNECTING(0)：浏览器正在自动重连（瞬时网络抖动），
       *    此时应耐心等待，**不应**立刻降级；
       * b) readyState === CLOSED(2)：连接已终结，浏览器**放弃了重连**
       *    （服务端返回非 2xx / 4xx-5xx、CORS 拒绝、URL 无效、
       *    或反代明确断开）。这类情况下 onerror **只会触发一次**——
       *    实测（CDP 断网 12 秒采样）errors 恒为 1、readyState 恒为 2，
       *    若仍按「连续 2 次错误才降级」判定，阈值永远达不到，
       *    画面将永久冻结在最后一帧。
       *
       * 因此 CLOSED 态必须立即降级，不能等待第二次错误。
       * 这也是「任何演示网络环境下 3D 大屏始终鲜活」的必要条件。
       */
      const closedPermanently =
        typeof eventSource?.readyState === 'number' &&
        eventSource.readyState === EventSource.CLOSED;

      if (current >= config.errorThreshold || closedPermanently) {
        startFallback();
      } else {
        /* 未达阈值且仍可重连：保持 connecting，等待浏览器重连 */
        setTransportBothRef.current('connecting');
      }
    };

    /* ---- 清理：关闭连接与定时器（组件卸载 / 依赖变化时执行） ---- */
    return (): void => {
      disposed = true;
      if (eventSource !== null) {
        eventSource.close();
        eventSource = null;
      }
      if (fallbackTimer !== null) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };
    /* ================================================================
     * 【依赖数组严格锁定】仅 connectionMode 与 activeChaos 变化才重建连接。
     * 其余所有配置（阈值/间隔/窗口/开关/回调）与 deliver 函数均经 ref 读取，
     * 因此父组件重渲染、store 其他字段变化都不会导致 SSE 连接被销毁重建。
     * ================================================================ */
  }, [connectionMode, activeChaos]);

  return {
    transport,
    consecutiveErrors,
    isFallbackActive: transport === 'fallback',
    lastReconciledCount,
  };
}

export default useTelemetryStream;
