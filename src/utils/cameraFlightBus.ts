/**
 * KubeVision AI — 相机飞行状态总线（cameraFlightBus）
 *
 * 【设计意图】将 `CameraRig`（Canvas 内 60FPS `useFrame`）与 DOM UI（如
 * `ViewportToolbar` 的 `aria-busy` 状态与浅进度环）解耦，避免每帧触发 React 状态更新。
 *
 * 【双轨订阅】
 * 1. `subscribeFlightStatus`：仅在 `isFlying` 或 `activePreset` 离散跃迁时回调（每次飞行最多 2 次）；
 * 2. `subscribeFlightProgress`：飞行期间每帧推送归一化时间 `p ∈ [0, 1]`，供 SVG 进度环
 *    直接操作 DOM ref（`strokeDashoffset`），全程零 React 重渲染。
 */

import type { ViewPresetKey } from '@/types/canvas';

export type CameraFlightKind = 'preset' | 'entity' | 'opening' | null;

export interface CameraFlightStatus {
  readonly isFlying: boolean;
  readonly activePreset: ViewPresetKey | null;
  readonly kind: CameraFlightKind;
}

type StatusListener = (status: CameraFlightStatus) => void;
type ProgressListener = (progress: number, status: CameraFlightStatus) => void;

const statusListeners = new Set<StatusListener>();
const progressListeners = new Set<ProgressListener>();

let currentStatus: CameraFlightStatus = {
  isFlying: false,
  activePreset: null,
  kind: null,
};
let currentProgress = 1;

/**
 * publishFlightStatus —— 发布飞行起止/目标切换（仅在状态变化时通知 UI）。
 */
export function publishFlightStatus(next: CameraFlightStatus): void {
  if (
    currentStatus.isFlying === next.isFlying &&
    currentStatus.activePreset === next.activePreset &&
    currentStatus.kind === next.kind
  ) {
    return;
  }
  currentStatus = next;
  statusListeners.forEach((listener) => listener(currentStatus));
}

/**
 * publishFlightProgress —— 飞行帧率同步推送归一化进度 `p ∈ [0, 1]`。
 */
export function publishFlightProgress(progress: number): void {
  currentProgress = Math.min(1, Math.max(0, progress));
  progressListeners.forEach((listener) => listener(currentProgress, currentStatus));
}

/**
 * getFlightStatus —— 读取当前飞行离散状态快照。
 */
export function getFlightStatus(): CameraFlightStatus {
  return currentStatus;
}

/**
 * subscribeFlightStatus —— 订阅飞行起止离散状态。
 */
export function subscribeFlightStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/**
 * subscribeFlightProgress —— 订阅 60FPS 飞行进度流（DOM ref 瞬态通道）。
 */
export function subscribeFlightProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}
