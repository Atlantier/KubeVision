/**
 * KubeVision AI — 数据健康瞬态指标（telemetryHealth）
 *
 * 【为什么要监控"我们自己的数据"】
 * 3D 场景再漂亮，如果底层遥测悄悄漂移/断流/被改写，观众看到的是一幅**不可信**的画面。
 * 本项目已经踩过这类坑：QPS 复利漂移、节点随机游走、免疫改写后数值不动、
 * SSE 重连导致时间戳跳变。这些问题的共同点是——**画面上看不出来**，
 * 只能靠"数据自身的健康度"来暴露。
 *
 * 因此这里对 5 个维度做持续度量，由 Shift+P 性能 HUD 直读展示：
 *   1. QPS 相对基线偏差（%）
 *   2. 节点水位偏离角色基线（百分点，取三节点最大值）
 *   3. 快照到达间隔抖动（ms，指数滑动平均）
 *   4. SSE 重连次数（自页面加载起累计）
 *   5. 免疫改写条数（最近一次自愈窗口内的累计改写）
 *
 * 【零重渲染契约】
 * 本模块是**模块级可变单例**，与 telemetryTransientRef 同源同风格：
 * 写入方（SSE deliver 钩子）直接赋值，不触发任何 React 更新；
 * 读取方（HUD）用 rAF 定时器直接写 DOM 文本与 class，**不调用 setState**。
 * 这是"连自己的数据都要监控"又不违反 60FPS 红线的唯一做法。
 */

import { INITIAL_CLUSTER_SNAPSHOT, TELEMETRY_SCHEMA_VERSION } from '@/types/cluster';
import type { TelemetrySnapshot } from '@/types/cluster';
import { NODE_ROLE_BY_RACK, NODE_ROLE_PROFILE } from '@/constants/telemetryTuning';

/* ========================================================================== */
/* 阈值（HUD 用它们决定是否标琥珀/玫红）                                          */
/* ========================================================================== */

/** QPS 相对基线偏差告警阈值（超过则琥珀） */
export const HEALTH_QPS_DEVIATION_WARN = 0.15;

/** 节点水位偏离基线告警阈值（百分点，超过则琥珀） */
export const HEALTH_NODE_DRIFT_WARN = 10;

/** 快照间隔抖动告警阈值（毫秒，超过则琥珀） */
export const HEALTH_JITTER_WARN_MS = 400;

/** 遥测帧名义间隔（与引擎 TICK_INTERVAL_MS 一致，这里独立写一份避免循环依赖） */
const NOMINAL_FRAME_INTERVAL_MS = 1000;

/** 抖动指数滑动平均系数：越小越平滑（0.3 在 1Hz 采样下约 3 帧收敛） */
const JITTER_EWMA_ALPHA = 0.3;

/* ========================================================================== */
/* 数据结构                                                                    */
/* ========================================================================== */

/** 数据健康快照（HUD 每帧读取的字段集合） */
export interface TelemetryHealthState {
  /** QPS 相对基线的偏差比例（0.12 = 比基线高 12%） */
  readonly qpsDeviationRatio: number;
  /** 节点水位偏离角色基线的最大百分点（CPU 与内存取较大者） */
  readonly nodeDriftPct: number;
  /** 快照到达间隔抖动（ms，指数滑动平均的绝对偏差） */
  readonly frameJitterMs: number;
  /** 自页面加载起的 SSE 重连次数 */
  readonly sseReconnects: number;
  /** 免疫改写累计条数（自最近一次清零起） */
  readonly immuneRewrites: number;
  /** 最近一帧的 schemaVersion（0 表示尚未收到合法帧） */
  readonly schemaVersion: number;
  /** 是否因未知 schema 版本进入只读降级 */
  readonly readOnly: boolean;
  /** 最近一帧到达时刻（Date.now，0 表示尚未收到） */
  readonly lastFrameAtMs: number;
}

/** 全局单例（可读不可替换字段，写入统一走下方 record* 函数） */
export const telemetryHealthRef: { current: TelemetryHealthState } = {
  current: {
    qpsDeviationRatio: 0,
    nodeDriftPct: 0,
    frameJitterMs: 0,
    sseReconnects: 0,
    immuneRewrites: 0,
    schemaVersion: 0,
    readOnly: false,
    lastFrameAtMs: 0,
  },
};

/** 上一帧到达时刻（内部状态，用于算间隔抖动） */
let lastArrivalMs = 0;

/* ========================================================================== */
/* 写入端                                                                      */
/* ========================================================================== */

/**
 * 计算节点水位偏离（相对角色基线，取三节点最大值）。
 *
 * 【为什么相对“角色基线”而不是相对上一帧】相对上一帧只能看到"变化"，
 * 看不到"已经偏了多远"。角色基线是节点的应然水位（compute 44/36、
 * memory 36/48、network 40/40），偏离它才说明数据真的不健康。
 *
 * @param snapshot 最新快照
 * @returns 最大偏离（百分点）
 */
function computeNodeDrift(snapshot: TelemetrySnapshot): number {
  let maxDrift = 0;
  for (const node of snapshot.nodes) {
    const role = NODE_ROLE_BY_RACK[node.rackIndex];
    if (role === undefined) continue;
    const profile = NODE_ROLE_PROFILE[role];
    const cpuDrift = Math.abs(node.cpuUsage - profile.cpu);
    const memDrift = Math.abs(node.memUsage - profile.mem);
    maxDrift = Math.max(maxDrift, cpuDrift, memDrift);
  }
  return Math.round(maxDrift * 10) / 10;
}

/**
 * 记录一帧合法遥测（由 SSE deliver 调用）。
 *
 * 【纯度量、零副作用外溢】只更新模块内数值，不写 Store、不触发渲染。
 *
 * @param snapshot 已通过 schema 校验的快照
 */
export function recordTelemetryFrame(snapshot: TelemetrySnapshot): void {
  const now = Date.now();
  const baseline = INITIAL_CLUSTER_SNAPSHOT.totalQps;

  /* ---- QPS 相对基线偏差 ---- */
  const qpsDeviationRatio = baseline > 0 ? (snapshot.totalQps - baseline) / baseline : 0;

  /* ---- 快照间隔抖动（EWMA 的绝对偏差） ---- */
  let frameJitterMs = telemetryHealthRef.current.frameJitterMs;
  if (lastArrivalMs > 0) {
    const interval = now - lastArrivalMs;
    /* 连续两帧都到才有间隔可言；首帧不参与抖动统计 */
    const deviation = Math.abs(interval - NOMINAL_FRAME_INTERVAL_MS);
    frameJitterMs = Math.round(
      (JITTER_EWMA_ALPHA * deviation + (1 - JITTER_EWMA_ALPHA) * frameJitterMs) * 10,
    ) / 10;
  }
  lastArrivalMs = now;

  telemetryHealthRef.current = {
    ...telemetryHealthRef.current,
    qpsDeviationRatio,
    nodeDriftPct: computeNodeDrift(snapshot),
    frameJitterMs,
    schemaVersion: snapshot.schemaVersion,
    lastFrameAtMs: now,
  };
}

/**
 * 记录一次 SSE 重连。
 *
 * 【口径】每次主 Effect 重新建立 EventSource 都算一次（含 chaos 切换、
 * 连接降级后的重建）。它不代表"网络差"，但一定代表"客户端换了条流"，
 * 而换流正是时间戳跳变的高风险时刻——所以在 HUD 上必须可见。
 */
export function recordSseReconnect(): void {
  telemetryHealthRef.current = {
    ...telemetryHealthRef.current,
    sseReconnects: telemetryHealthRef.current.sseReconnects + 1,
  };
}

/**
 * 累加免疫改写条数。
 *
 * @param count 本帧被免疫改写（或被平滑回落）的 Pod 数
 */
export function recordImmuneRewrites(count: number): void {
  if (count <= 0) return;
  telemetryHealthRef.current = {
    ...telemetryHealthRef.current,
    immuneRewrites: telemetryHealthRef.current.immuneRewrites + count,
  };
}

/**
 * 记录 schema 版本与只读状态。
 *
 * @param version 收到的帧版本（缺失/非法传 0）
 * @param readOnly 是否已进入只读降级
 */
export function recordSchemaStatus(version: number, readOnly: boolean): void {
  telemetryHealthRef.current = {
    ...telemetryHealthRef.current,
    schemaVersion: version,
    readOnly,
  };
}

/** 重置（连接重建时清空抖动与重连基线，但保留累计重连次数） */
export function resetTelemetryHealthBaseline(): void {
  lastArrivalMs = 0;
  telemetryHealthRef.current = {
    ...telemetryHealthRef.current,
    frameJitterMs: 0,
  };
}

/** 当前支持的 schema 版本（再导出便于 HUD/测试引用单一来源） */
export const SUPPORTED_SCHEMA_VERSION = TELEMETRY_SCHEMA_VERSION;