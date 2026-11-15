'use client';

/**
 * KubeVision AI — 视口截图代理（R5 第8步：preserveDrawingBuffer 按需）
 *
 * 【问题】WebGLRenderer 默认在帧合成后清空 drawing buffer，任何**跨任务**
 * 的 canvas.toDataURL() 都会读到黑图。此前的做法是常开
 * preserveDrawingBuffer:true——它让浏览器额外保留一份完整帧缓冲，
 * 在移动 GPU / 高 DPR 屏上既占显存也占合成带宽，而用户真正截图的时刻
 * 只是极少数。这就是手册所指的「白付成本」。
 *
 * 【方案】渲染器改为 preserveDrawingBuffer:false（默认值）；截图请求走本
 * 模块的 Promise 队列，由画布内的 FrameCaptureProvider 在**同一帧渲染完成
 * 之后**（useFrame 优先级 2）同步调用 toDataURL。此刻浏览器还没进入合成
 * 阶段，drawing buffer 仍然有效，无需 preserveDrawingBuffer。
 *
 * 【生命周期】画布挂载时 registerFrameCapture 注册读取器，卸载时注销；
 * 未注册（画布未挂载 / 上下文丢失）时请求立即得到 null，调用方按失败降级。
 */

/** 截图编码选项：mime 与 quality 对齐原调用点（JPEG 0.8 / PNG 无损） */
export interface ViewportCaptureOptions {
  readonly mime: 'image/jpeg' | 'image/png';
  readonly quality?: number;
}

/** 视口截图空间元数据（M13：用于区分多模态截图时间/视口上下文） */
export interface ViewportCaptureMeta {
  readonly capturedAtIso: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly mime: 'image/jpeg' | 'image/png';
}

/** 读取器：在渲染后同帧把当前绘制缓冲导出为 dataURL */
export type FrameCapture = (options: ViewportCaptureOptions) => string | null;

/** 待处理请求（截图频率极低，单帧内即被 flush 清空） */
interface CaptureWaiter {
  readonly options: ViewportCaptureOptions;
  readonly resolve: (dataUrl: string | null) => void;
}

let frameCapture: FrameCapture | null = null;
const waiters: CaptureWaiter[] = [];
let lastCaptureMeta: ViewportCaptureMeta | null = null;

/**
 * 读取最近一次成功截图的空间/时间元数据（M13）。
 */
export function getLastViewportCaptureMeta(): ViewportCaptureMeta | null {
  return lastCaptureMeta;
}

/**
 * 注册当前画布的读取器（由 FrameCaptureProvider 调用）。
 *
 * @param capture 同帧读取回调
 * @returns 注销函数（画布卸载时调用）
 */
export function registerFrameCapture(capture: FrameCapture): () => void {
  frameCapture = capture;
  return (): void => {
    if (frameCapture === capture) frameCapture = null;
  };
}

/**
 * 请求一次视口截图。结果在下一帧渲染完成后兑现。
 *
 * @param options 编码选项
 * @returns dataURL；画布未挂载或导出失败时为 null
 */
export function requestViewportCapture(options: ViewportCaptureOptions): Promise<string | null> {
  return new Promise<string | null>((resolve): void => {
    if (frameCapture === null) {
      resolve(null);
      return;
    }
    waiters.push({ options, resolve });
  });
}

/**
 * 兑现所有待处理请求（由 FrameCaptureProvider 每帧渲染后调用）。
 * 无请求时零分配、零开销。
 */
export function flushViewportCapture(): void {
  if (waiters.length === 0) return;
  const capture = frameCapture;
  if (capture === null) {
    while (waiters.length > 0) waiters.shift()?.resolve(null);
    return;
  }
  while (waiters.length > 0) {
    const waiter = waiters.shift();
    if (waiter === undefined) break;
    let dataUrl: string | null = null;
    try {
      dataUrl = capture(waiter.options);
    } catch {
      dataUrl = null;
    }
    if (dataUrl !== null && typeof window !== 'undefined') {
      lastCaptureMeta = {
        capturedAtIso: new Date().toISOString(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        mime: waiter.options.mime,
      };
    }
    waiter.resolve(dataUrl);
  }
}
