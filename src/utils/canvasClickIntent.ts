/**
 * KubeVision AI — 3D 画布点击意图与防误触延迟调度（canvasClickIntent）
 *
 * 【设计意图】
 * 1. `pointerdown` 立即点亮实体 1px 高亮边框（零帧触感响应）；
 * 2. `pointerup` 后延迟 `CAMERA_MOTION.pointerUpFlightDelayMs`（80ms）再派发选中飞行：
 *    若用户在 `80ms` 内发起第二次点击准备双击复位，可直接取消待飞任务，避免镜头抖动。
 */

import { CAMERA_MOTION } from '@/constants/motion';

let pendingSelectionTimer: ReturnType<typeof setTimeout> | null = null;
let lastTapResetAtMs = 0;

/**
 * scheduleSelectionFlight —— 取消旧的待定选中并延迟 80ms 执行新选中飞行。
 *
 * @param commitSelection 真正写入 Store `selectEntity` 的回调
 */
export function scheduleSelectionFlight(commitSelection: () => void): void {
  /* 若刚刚触发了双击复位（<= 280ms），忽略紧随其后的尾随 click 事件，防止复位被重选覆盖 */
  if (performance.now() - lastTapResetAtMs < CAMERA_MOTION.dblClickWindowMs) {
    return;
  }
  cancelPendingSelectionFlight();
  pendingSelectionTimer = setTimeout(() => {
    pendingSelectionTimer = null;
    commitSelection();
  }, CAMERA_MOTION.pointerUpFlightDelayMs);
}

/**
 * cancelPendingSelectionFlight —— 立即取消尚未起飞的 80ms 延迟选中任务。
 */
export function cancelPendingSelectionFlight(): void {
  if (pendingSelectionTimer !== null) {
    clearTimeout(pendingSelectionTimer);
    pendingSelectionTimer = null;
  }
}

/**
 * markDoubleClickResetTriggered —— 标记画布刚刚触发双击复位，抑制同手势尾随单机选中。
 */
export function markDoubleClickResetTriggered(): void {
  lastTapResetAtMs = performance.now();
  cancelPendingSelectionFlight();
}
