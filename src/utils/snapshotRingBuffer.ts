/**
 * KubeVision AI — 遥测帧环形缓冲（snapshotRingBuffer）
 *
 * 【解决什么问题】3D 画面只呈现"当下"，但复盘报告需要"刚才发生了什么"：
 * 故障是第几秒出现的？告警是何时升级到 P0 的？自愈之后健康分怎么走的？
 * 这些都需要最近的帧序列。SSE 每秒一帧，保留最近 120 帧 = **2 分钟**时间窗，
 * 恰好覆盖一次完整路演（34 秒）加诊断对话（30~60 秒）。
 *
 * 【为什么是环形缓冲】
 * 1. 定长：内存上界确定（120 × 一帧快照引用），不会随运行时长增长；
 * 2. 旧帧整体丢弃（引用出队），由 GC 回收——不做逐帧字段拷贝；
 * 3. 帧本身是不可变值对象，多个消费者（HUD/复盘/调试）可安全共享同一引用。
 *
 * 【为什么不放进 Store】Store 每次写入都会触发订阅者重渲染；120 帧滚动
 * 会在每秒触发一次全量 diff。这里是纯模块单例，业务按需读取。
 */

import type { AlertEvent, TelemetrySnapshot } from '@/types/cluster';

/* ========================================================================== */
/* 常量与状态                                                                  */
/* ========================================================================== */

/** 环形缓冲容量（帧）。120 帧 = 2 分钟 @1Hz，覆盖一次完整演练窗口 */
export const FRAME_BUFFER_CAPACITY = 120;

/** 帧缓冲（模块级单例，只读消费） */
const frames: TelemetrySnapshot[] = [];

/* ========================================================================== */
/* 写入与读取                                                                  */
/* ========================================================================== */

/**
 * 推入一帧。超过容量时丢弃最旧的一帧。
 *
 * @param snapshot 已通过 schema 校验的快照（调用方保证不可变）
 */
export function pushSnapshotFrame(snapshot: TelemetrySnapshot): void {
  frames.push(snapshot);
  if (frames.length > FRAME_BUFFER_CAPACITY) {
    frames.splice(0, frames.length - FRAME_BUFFER_CAPACITY);
  }
}

/**
 * 读取最近 N 帧（按时间升序，最后一项是最新帧）。
 *
 * @param limit 最多返回多少帧（默认全部）
 * @returns 帧数组（浅拷贝，调用方可安全遍历）
 */
export function getRecentFrames(limit = FRAME_BUFFER_CAPACITY): readonly TelemetrySnapshot[] {
  if (limit >= frames.length) return frames.slice();
  return frames.slice(frames.length - limit);
}

/** 当前缓冲帧数（HUD/测试用） */
export function getFrameBufferSize(): number {
  return frames.length;
}

/** 清空缓冲（停止演练/切换模式时调用） */
export function clearFrameBuffer(): void {
  frames.length = 0;
}

/* ========================================================================== */
/* 事故时间线                                                                  */
/* ========================================================================== */

/** 时间线条目类型：告警出现/清除、健康分变化 */
export type IncidentKind = 'alert-raised' | 'alert-cleared' | 'health-drop' | 'health-recover';

/** 单条时间线条目 */
export interface IncidentTimelineEntry {
  /** 该帧时间戳（epoch ms） */
  readonly at: number;
  /** 在缓冲中的相对秒数（0 = 缓冲内第一帧） */
  readonly offsetSec: number;
  /** 类型 */
  readonly kind: IncidentKind;
  /** 人类可读描述 */
  readonly detail: string;
  /** 告警等级（仅告警类条目） */
  readonly level?: string;
}

/**
 * 从环形缓冲推导事故时间线（供复盘报告使用）。
 *
 * 【算法】逐帧比较相邻两帧：
 * 1. 告警集合按 `level:entityId` 做签名 diff → 新增/消失各记一条；
 * 2. 健康分相邻帧下降 ≥ 5 记 health-drop，回升 ≥ 5 记 health-recover。
 * 只记录"变化点"而不是每帧，时间线才能读。
 *
 * @returns 时间线条目（按时间升序）
 */
export function buildIncidentTimeline(): IncidentTimelineEntry[] {
  if (frames.length === 0) return [];
  const firstTs = frames[0].timestamp;
  const entries: IncidentTimelineEntry[] = [];

  /** 告警签名集合 */
  const signature = (alerts: readonly AlertEvent[]): Set<string> =>
    new Set(alerts.map((alert): string => `${alert.level}:${alert.entityId}`));

  let prevAlerts = signature(frames[0].activeAlerts);
  let prevHealth = frames[0].clusterHealthScore;

  for (let i = 1; i < frames.length; i += 1) {
    const frame = frames[i];
    const current = signature(frame.activeAlerts);
    const offsetSec = Math.round(((frame.timestamp - firstTs) / 1000) * 10) / 10;

    for (const key of current) {
      if (!prevAlerts.has(key)) {
        const [level, entityId] = key.split(':');
        entries.push({
          at: frame.timestamp,
          offsetSec,
          kind: 'alert-raised',
          detail: `${level} 告警出现 · ${entityId}`,
          level,
        });
      }
    }
    for (const key of prevAlerts) {
      if (!current.has(key)) {
        const [level, entityId] = key.split(':');
        entries.push({
          at: frame.timestamp,
          offsetSec,
          kind: 'alert-cleared',
          detail: `${level} 告警解除 · ${entityId}`,
          level,
        });
      }
    }

    const delta = frame.clusterHealthScore - prevHealth;
    if (delta <= -5) {
      entries.push({
        at: frame.timestamp,
        offsetSec,
        kind: 'health-drop',
        detail: `健康分下降 ${prevHealth} → ${frame.clusterHealthScore}`,
      });
    } else if (delta >= 5) {
      entries.push({
        at: frame.timestamp,
        offsetSec,
        kind: 'health-recover',
        detail: `健康分回升 ${prevHealth} → ${frame.clusterHealthScore}`,
      });
    }

    prevAlerts = current;
    prevHealth = frame.clusterHealthScore;
  }

  return entries;
}

/**
 * 把时间线渲染成 Markdown 表格（复盘报告直接插入即可）。
 *
 * @returns Markdown 文本；无数据时返回空字符串
 */
export function renderIncidentTimelineMarkdown(): string {
  const entries = buildIncidentTimeline();
  if (entries.length === 0) return '';
  const lines = [
    '| 相对时间 | 事件 | 详情 |',
    '|---|---|---|',
    ...entries.map(
      (entry): string => `| +${entry.offsetSec.toFixed(1)}s | ${entry.kind} | ${entry.detail} |`,
    ),
  ];
  return lines.join('\n');
}