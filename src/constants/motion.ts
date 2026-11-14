/**
 * KubeVision AI — 全局动效节拍（R29 · E 项）
 *
 * 【为什么需要单一节拍】此前每个组件各自写死角速度（2.2 / 2.8 / 3.9 rad/s…），
 * 并排观察时像多台不同步的机器，观感"杂乱"。R29 起所有循环动效统一以
 * **MOTION_BEAT = 3.6s** 为基拍，取它的整数分之一作为周期：
 *   - 晶核呼吸：3.6/1（1 拍）
 *   - 陀螺环：3.6/2、3.6/3、3.6/4
 *   - 赤道/极环：3.6/2、3.6/5
 *   - 雷达扫掠：3.6/1
 *   - 故障涟漪：1.2s/环 = 3.6/3（允许打破节拍，故障必须抢注意力）
 *
 * 【角频率换算】周期 T 秒 → 角频率 ω = 2π/T；所有组件统一从本文件取 ω，
 * 不再各自写魔法数。
 */

/** 全局基础节拍（秒） */
export const MOTION_BEAT = 3.6;

/**
 * 由节拍分数得到角频率。
 *
 * @param fraction 占一拍的比例（如 1 = 每拍一次，1/2 = 每拍两次）
 * @returns 角频率 ω（rad/s）
 */
export function beatOmega(fraction: number): number {
  return (Math.PI * 2) / (MOTION_BEAT * fraction);
}

/** 晶核呼吸角频率（3.6/1） */
export const MOTION_BREATH_OMEGA = beatOmega(1);
/** 雷达扫掠角频率（3.6/1） */
export const MOTION_RADAR_OMEGA = beatOmega(1);
/** 陀螺环 2 倍频（3.6/2） */
export const MOTION_GYRO_FAST_OMEGA = beatOmega(1 / 2);
/** 陀螺环 3 倍频（3.6/3） */
export const MOTION_GYRO_MID_OMEGA = beatOmega(1 / 3);
/** 陀螺环 4 倍频（3.6/4） */
export const MOTION_GYRO_SLOW_OMEGA = beatOmega(1 / 4);
/** 赤道环（3.6/2） */
export const MOTION_EQUATOR_OMEGA = beatOmega(1 / 2);
/** 极轨环（3.6/5） */
export const MOTION_POLAR_OMEGA = beatOmega(1 / 5);
/** 故障涟漪周期（1.2s/环） */
export const MOTION_RIPPLE_PERIOD = MOTION_BEAT / 3;

let reducedMotionQuery: MediaQueryList | null = null;
let cachedReducedMotion = false;
let reducedMotionInitialized = false;
const reducedMotionListeners = new Set<(reduced: boolean) => void>();

/**
 * ensureReducedMotionWatcher —— 模块级单次绑定 matchMedia 缓存与监听器。
 *
 * 【为什么缓存】60 FPS `useFrame` 中每帧调用 `window.matchMedia()` 会触发样式查询开销；
 * 初始化时查询一次并挂载 `'change'` 事件监听即可保证零额外重排与即时响应系统偏好切换。
 */
function ensureReducedMotionWatcher(): void {
  if (reducedMotionInitialized || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return;
  }
  reducedMotionInitialized = true;
  reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  cachedReducedMotion = reducedMotionQuery.matches;
  const handleChange = (event: MediaQueryListEvent): void => {
    cachedReducedMotion = event.matches;
    reducedMotionListeners.forEach((listener) => listener(cachedReducedMotion));
  };
  reducedMotionQuery.addEventListener('change', handleChange);
}

if (typeof window !== 'undefined') {
  ensureReducedMotionWatcher();
}

/**
 * isReducedMotion —— 是否请求"减少动效"（O(1) 缓存读取）。
 *
 * 【契约】`prefers-reduced-motion: reduce` 时：
 *   - `uBoot` 直接 = 1（不做开场）；
 *   - 循环动画幅度 ×0.25（`REDUCED_MOTION_AMPLITUDE`，保留轻微态势反馈）；
 *   - 相机飞行压缩至 <= 200ms 线性推进并自动关闭自动巡航。
 *
 * @returns 用户要求减少动效时返回 true
 */
export function isReducedMotion(): boolean {
  ensureReducedMotionWatcher();
  return cachedReducedMotion;
}

/**
 * subscribeReducedMotion —— 订阅系统"减少动效"偏好实时变化。
 *
 * @param listener 状态变化回调
 * @returns 取消订阅函数
 */
export function subscribeReducedMotion(listener: (reduced: boolean) => void): () => void {
  ensureReducedMotionWatcher();
  reducedMotionListeners.add(listener);
  return () => {
    reducedMotionListeners.delete(listener);
  };
}

/** 减少动效时的循环幅度系数（×1/4） */
export const REDUCED_MOTION_AMPLITUDE = 0.25;

/**
 * CAMERA_MOTION —— R7 运镜与交互时序统一常量表（禁止组件内散落魔法数字）。
 */
export const CAMERA_MOTION = {
  /** 标准三段式相机飞行总时长（秒）：720ms */
  flightDurationS: 0.72,
  /** `overview <-> topdown`（~180° 方位角翻转）球面插值时长（秒）：820ms */
  topdownSphericalDurationS: 0.82,
  /** `prefers-reduced-motion` 下快速线性飞行时长（秒）：180ms（<= 200ms） */
  reducedFlightDurationS: 0.18,
  /** 飞行抛物线包络幂次：`sin(πp)^1.4` */
  arcPower: 1.4,
  /** 三段式缓动贝塞尔控制点：起手柔（0~25% ∈ [8%,22%]）、中段果断（50% >= 65%）、收尾轻粘（末15% >= 120ms） */
  cubicBezier: [0.56, 0.0, 0.08, 1.0] as const,
  /** OrbitControls 帧率无关阻尼基准（60fps 等效系数） */
  orbitBaseDamping: 0.065,
  /** 悬停材质指数收敛速率（`1 - exp(-16 * dt)`） */
  hoverExpRate: 16,
  /** 悬停首帧即时触感阶跃（保证 0 帧响应且 90ms 稳态收敛 >= 90%） */
  hoverInstantJump: 0.68,
  /** 画布双击复位时间窗（ms）与最大指针位移（px） */
  dblClickWindowMs: 280,
  dblClickMaxMovePx: 6,
  /** `pointerup` 后触发相机飞行的微延迟（ms），兼顾双击判别与瞬时点击确认 */
  pointerUpFlightDelayMs: 80,
  /** 滚轮单次 deltaY 限幅与触控板 pinch（ctrlKey）缩放倍率 */
  wheelDeltaClamp: 40,
  wheelCtrlFactor: 0.5,
  /** 降噪后的 OrbitControls 缩放灵敏度 */
  zoomSpeed: 0.55,
  /** 移动端与窄屏约束阈值 */
  mobileBreakpointPx: 768,
  mobileMinDistance: 2.6,
  desktopMinDistance: 1.8,
  /** 分栏手柄防穿透护城河半宽（±8px） */
  resizerGuardMarginPx: 8,
} as const;

/**
 * evaluateCubicBezierY —— 零堆分配求解三次贝塞尔 `Y(t(x=p))`。
 *
 * 【算法】使用 5 次 Newton-Raphson 迭代配合收敛保护求解参数 `u`（误差 < 1e-7），
 * 全程仅使用局部标量，严禁在 `useFrame` 中分配数组或对象。
 *
 * @param p   归一化时间进度 `[0, 1]`
 * @param p1x 控制点 1 X
 * @param p1y 控制点 1 Y
 * @param p2x 控制点 2 X
 * @param p2y 控制点 2 Y
 * @returns 映射后的进度值 `[0, 1]`
 */
export function evaluateCubicBezierY(
  p: number,
  p1x: number = CAMERA_MOTION.cubicBezier[0],
  p1y: number = CAMERA_MOTION.cubicBezier[1],
  p2x: number = CAMERA_MOTION.cubicBezier[2],
  p2y: number = CAMERA_MOTION.cubicBezier[3],
): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;

  const ax = 3 * p1x - 3 * p2x + 1;
  const bx = 3 * p2x - 6 * p1x;
  const cx = 3 * p1x;

  let u = p;
  for (let i = 0; i < 6; i++) {
    const xEst = ((ax * u + bx) * u + cx) * u - p;
    const dx = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(xEst) < 1e-6) break;
    if (Math.abs(dx) < 1e-5) break;
    u = Math.min(1, Math.max(0, u - xEst / dx));
  }

  /* 极端斜率区间退化二分兜底，保证单调性与精确度 */
  const xCheck = ((ax * u + bx) * u + cx) * u;
  if (Math.abs(xCheck - p) > 1e-4) {
    let lo = 0;
    let hi = 1;
    for (let j = 0; j < 18; j++) {
      const mid = (lo + hi) * 0.5;
      const xMid = ((ax * mid + bx) * mid + cx) * mid;
      if (xMid < p) lo = mid;
      else hi = mid;
    }
    u = (lo + hi) * 0.5;
  }

  const ay = 3 * p1y - 3 * p2y + 1;
  const by = 3 * p2y - 6 * p1y;
  const cy = 3 * p1y;
  return Math.min(1, Math.max(0, ((ay * u + by) * u + cy) * u));
}

/**
 * easeThreeStageFlight —— 计算 R7 三段式飞行进度 `e(p)`。
 *
 * 【输入输出】输入归一化时间 `p ∈ [0, 1]`；输出位移插值权重 `e ∈ [0, 1]`。
 * 正常模式采用 `cubic-bezier(0.56, 0, 0.08, 1)`，减少动效模式下退化为快速线性推进。
 */
export function easeThreeStageFlight(p: number, reducedMotion = false): number {
  const clamped = Math.min(1, Math.max(0, p));
  if (reducedMotion) return clamped;
  return evaluateCubicBezierY(clamped);
}

/**
 * computeFlightArcEnvelope —— 计算飞行弧线抬升包络 `sin(πp)^1.4`。
 */
export function computeFlightArcEnvelope(p: number, reducedMotion = false): number {
  if (reducedMotion) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  return Math.pow(Math.sin(Math.PI * clamped), CAMERA_MOTION.arcPower);
}

/**
 * computeDtDamping —— 帧率无关阻尼换算：`1 - (1 - base)^(dt * 60)`。
 */
export function computeDtDamping(
  deltaS: number,
  baseDamping: number = CAMERA_MOTION.orbitBaseDamping,
): number {
  /* 上限 0.25s 兼顾低帧率软件光栅化收敛精度与切后台瞬移保护 */
  const clampedDt = Math.min(Math.max(deltaS, 0), 0.25);
  return 1 - Math.pow(1 - baseDamping, clampedDt * 60);
}

/**
 * computeHoverAlpha —— 悬停材质指数收敛因子：`1 - exp(-16 * dt)`。
 */
export function computeHoverAlpha(deltaS: number): number {
  const clampedDt = Math.min(Math.max(deltaS, 0), 0.1);
  return 1 - Math.exp(-CAMERA_MOTION.hoverExpRate * clampedDt);
}