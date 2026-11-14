/**
 * KubeVision AI — `?debug=camera` 运镜与微交互实时诊断桥（cameraDebugBridge）
 *
 * 【设计意图】仅当 URL 查询参数包含 `debug=camera` 时记录采样与挂接
 * `window.__KUBEVISION_CAMERA_DEBUG__` 诊断只读接口，供 R7 进阶探针
 * （`scripts/probe-camera.mjs`）采集真实浏览器内 3D 包围盒投影、飞行位移曲线、
 * 帧率无关阻尼残差、悬停收敛耗时与 React Profiler Commit 计数。
 * 未开启 `?debug=camera` 时全部记录函数以布尔守卫 O(1) 早退，零额外开销。
 */

export interface Box3ScreenProjection {
  readonly entityId: string;
  readonly widthPct: number;
  readonly heightPct: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly distanceToTarget: number;
}

export interface FlightSamplePoint {
  readonly tMs: number;
  readonly p: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface FlightTraceRecord {
  readonly kind: string;
  readonly durationTargetMs: number;
  readonly startPos: readonly [number, number, number];
  readonly endPos: readonly [number, number, number];
  readonly samples: FlightSamplePoint[];
  readonly arrived: boolean;
  readonly completedAtMs: number | null;
}

export interface HoverSamplePoint {
  readonly dtMs: number;
  readonly value: number;
}

export interface HoverTraceRecord {
  readonly entityId: string;
  readonly entityType: 'node' | 'master' | 'pod';
  readonly startedAtMs: number;
  readonly initialValue: number;
  readonly targetValue: number;
  readonly samples: HoverSamplePoint[];
}

export interface CameraStateSnapshot {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly dampingFactor: number;
  readonly isAnimating: boolean;
  readonly autoRotate: boolean;
  readonly reducedMotion: boolean;
  readonly minDistance: number;
  readonly enablePan: boolean;
  readonly zoomSpeed: number;
  readonly wheelDeltaClamp: number;
  readonly breathAmplitudeScale: number;
  readonly lastDblClickResetCount: number;
}

export interface RackEdgesDiagnostic {
  readonly rackId: string;
  readonly edgeCount: number;
  readonly activeEdgeOpacities: number[];
  readonly railEmissiveMax: number;
  readonly isHighlightedForPod: boolean;
  readonly pressedBorderActive: boolean;
}

export interface ProbeScreenPoint {
  readonly x: number;
  readonly y: number;
  readonly id: string;
  readonly rackId?: string;
}

export interface ProbeScreenAnchors {
  readonly master: ProbeScreenPoint;
  readonly rack: ProbeScreenPoint;
  readonly pod: ProbeScreenPoint | null;
}

export interface CameraDebugApi {
  readonly getState: () => CameraStateSnapshot;
  readonly getSceneCommitCount: () => number;
  readonly resetSceneCommitCount: () => void;
  readonly getLatestFlightTrace: () => FlightTraceRecord | null;
  readonly getHoverTraces: () => readonly HoverTraceRecord[];
  readonly clearHoverTraces: () => void;
  readonly getSelectedPodBoxProjection: () => Box3ScreenProjection | null;
  readonly getRackEdgesDiagnostic: (rackId: string) => RackEdgesDiagnostic | null;
  readonly getProbeAnchors: () => ProbeScreenAnchors | null;
}

interface DebugActionProviders {
  getSelectedPodBoxProjection?: () => Box3ScreenProjection | null;
  getRackEdgesDiagnostic?: (rackId: string) => RackEdgesDiagnostic | null;
  getProbeAnchors?: () => ProbeScreenAnchors | null;
}

let cachedDebugFlag: boolean | null = null;
let sceneCommitCount = 0;
let dblClickResetCount = 0;
let latestFlightTrace: FlightTraceRecord | null = null;
let hoverTraces: HoverTraceRecord[] = [];
const activeHoverStartMs = new Map<string, number>();
const providers: DebugActionProviders = {};

let latestCameraState: CameraStateSnapshot = {
  position: [7.8, 14, 22],
  target: [0, 1.2, 0],
  dampingFactor: 0.065,
  isAnimating: false,
  autoRotate: false,
  reducedMotion: false,
  minDistance: 1.8,
  enablePan: true,
  zoomSpeed: 0.55,
  wheelDeltaClamp: 40,
  breathAmplitudeScale: 1,
  lastDblClickResetCount: 0,
};

/**
 * isCameraDebugEnabled —— 检查当前页是否携带 `?debug=camera`。
 */
export function isCameraDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (cachedDebugFlag !== null) return cachedDebugFlag;
  cachedDebugFlag = new URLSearchParams(window.location.search).get('debug') === 'camera';
  if (cachedDebugFlag) {
    installWindowCameraDebugApi();
  }
  return cachedDebugFlag;
}

/**
 * resetCameraDebugCache —— 供 SPA 路由切换后重新判定 `?debug=camera`。
 */
export function refreshCameraDebugFlag(): boolean {
  if (typeof window === 'undefined') return false;
  cachedDebugFlag = new URLSearchParams(window.location.search).get('debug') === 'camera';
  if (cachedDebugFlag) {
    installWindowCameraDebugApi();
  }
  return cachedDebugFlag;
}

export function incrementSceneCommitCount(): void {
  if (!isCameraDebugEnabled()) return;
  sceneCommitCount += 1;
}

export function incrementDblClickResetCount(): void {
  if (!isCameraDebugEnabled()) return;
  dblClickResetCount += 1;
}

export function updateDebugCameraState(partial: Omit<CameraStateSnapshot, 'lastDblClickResetCount'>): void {
  if (!isCameraDebugEnabled()) return;
  latestCameraState = {
    ...partial,
    lastDblClickResetCount: dblClickResetCount,
  };
}

export function beginDebugFlightTrace(
  kind: string,
  durationTargetMs: number,
  startPos: readonly [number, number, number],
  endPos: readonly [number, number, number],
): void {
  if (!isCameraDebugEnabled()) return;
  latestFlightTrace = {
    kind,
    durationTargetMs,
    startPos,
    endPos,
    samples: [
      {
        tMs: 0,
        p: 0,
        x: startPos[0],
        y: startPos[1],
        z: startPos[2],
      },
    ],
    arrived: false,
    completedAtMs: null,
  };
}

export function pushDebugFlightSample(
  tMs: number,
  p: number,
  x: number,
  y: number,
  z: number,
): void {
  if (!isCameraDebugEnabled() || latestFlightTrace === null) return;
  latestFlightTrace.samples.push({ tMs, p, x, y, z });
}

export function endDebugFlightTrace(arrived: boolean, completedAtMs: number): void {
  if (!isCameraDebugEnabled() || latestFlightTrace === null) return;
  latestFlightTrace = {
    ...latestFlightTrace,
    arrived,
    completedAtMs,
  };
}

export function recordDebugHoverStart(
  entityId: string,
  entityType: 'node' | 'master' | 'pod',
  initialValue: number,
  targetValue: number,
): void {
  if (!isCameraDebugEnabled()) return;
  const now = performance.now();
  activeHoverStartMs.set(entityId, now);
  hoverTraces.push({
    entityId,
    entityType,
    startedAtMs: now,
    initialValue,
    targetValue,
    samples: [{ dtMs: 0, value: initialValue }],
  });
  if (hoverTraces.length > 24) {
    hoverTraces = hoverTraces.slice(-24);
  }
}

export function recordDebugHoverSample(entityId: string, value: number): void {
  if (!isCameraDebugEnabled()) return;
  const startedAt = activeHoverStartMs.get(entityId);
  if (startedAt === undefined) return;
  const dtMs = performance.now() - startedAt;
  const trace = [...hoverTraces].reverse().find((item) => item.entityId === entityId);
  if (trace === undefined) return;
  if (dtMs <= 260 && trace.samples.length < 40) {
    trace.samples.push({ dtMs, value });
  }
}

export function registerCameraDebugProvider(next: DebugActionProviders): void {
  Object.assign(providers, next);
}

declare global {
  interface Window {
    __KUBEVISION_CAMERA_DEBUG__?: CameraDebugApi;
  }
}

function installWindowCameraDebugApi(): void {
  if (typeof window === 'undefined') return;
  window.__KUBEVISION_CAMERA_DEBUG__ = {
    getState: () => ({
      ...latestCameraState,
      lastDblClickResetCount: dblClickResetCount,
    }),
    getSceneCommitCount: () => sceneCommitCount,
    resetSceneCommitCount: () => {
      sceneCommitCount = 0;
    },
    getLatestFlightTrace: () => latestFlightTrace,
    getHoverTraces: () => hoverTraces,
    clearHoverTraces: () => {
      hoverTraces = [];
      activeHoverStartMs.clear();
    },
    getSelectedPodBoxProjection: () => providers.getSelectedPodBoxProjection?.() ?? null,
    getRackEdgesDiagnostic: (rackId: string) => providers.getRackEdgesDiagnostic?.(rackId) ?? null,
    getProbeAnchors: () => providers.getProbeAnchors?.() ?? null,
  };
}
