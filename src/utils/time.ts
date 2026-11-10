/**
 * KubeVision AI — 时间格式化唯一实现（R52 · B4 收敛）
 *
 * 【为什么收敛】复盘报告里曾同时存在 formatDateTime / formatTimestampCompact /
 * formatTimezoneOffset 三份本地实现，另有一些路由用内联 ISO 串。格式口径一旦
 * 漂移（例如时区、补零），同一份事故记录会出现两种时间写法。此处集中为纯函数，
 * 所有调用方只引用这里。
 *
 * 【时区契约】除 formatIsoTimestamp 外，均使用**运行环境本地时区**；报告会同时
 * 打印 UTC 偏移标签（formatTimezoneOffset），保证跨时区评审可对齐。
 */

/** 数字左补零到两位 */
function pad2(value: number): string {
  return Math.abs(Math.trunc(value)).toString().padStart(2, '0');
}

/** 把可能非法的时间戳收敛为合法 Date（NaN/Infinity → epoch 0） */
export function toSafeDate(epochMs: number): Date {
  return new Date(Number.isFinite(epochMs) ? epochMs : 0);
}

/**
 * formatIsoTimestamp —— 标准 ISO-8601（UTC）时间串。
 *
 * @param epochMs 毫秒时间戳（也接受 Date）
 * @returns 形如 `2026-11-10T13:30:45.000Z`
 */
export function formatIsoTimestamp(epochMs: number | Date): string {
  return (epochMs instanceof Date ? epochMs : toSafeDate(epochMs)).toISOString();
}

/**
 * formatDateTime —— 本地时区 `YYYY-MM-DD HH:mm:ss`。
 *
 * @param epochMs 毫秒时间戳
 * @returns 固定宽度可排序时间串
 */
export function formatDateTime(epochMs: number): string {
  const date = toSafeDate(epochMs);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/**
 * formatTimestampCompact —— `YYYYMMDD-HHmmss`（文件名 / 报告编号专用）。
 *
 * @param epochMs 毫秒时间戳
 * @returns 无分隔符紧凑时间串
 */
export function formatTimestampCompact(epochMs: number): string {
  const date = toSafeDate(epochMs);
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

/**
 * formatTimezoneOffset —— 运行环境本地时区的 UTC 偏移标签。
 *
 * @param epochMs 毫秒时间戳
 * @returns 形如 `UTC+08:00` / `UTC-05:00`
 */
export function formatTimezoneOffset(epochMs: number): string {
  const offsetMinutes = -toSafeDate(epochMs).getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}