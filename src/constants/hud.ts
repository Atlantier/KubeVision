/**
 * KubeVision AI — 3D 全息铭牌规格与距离吃雾映射（R6 · 单一事实源）
 *
 * 【设计意图】（AGENTS.md 第 8 条 + R6-2/R6-3 契约）
 * 将场景内所有 drei `<Html>` 铭牌的透视缩放基准（`distanceFactor`）、
 * 字号区间（CSS `clamp()`）与随相机距离变化的吃雾衰减（opacity / saturate）
 * 收敛到单一事实源，杜绝各 3D 组件各自硬编码魔法数导致的字号畸变与雾穿透。
 */

/* ========================================================================== */
/* 铭牌几何与字号规格表（R6-2）                                                 */
/* ========================================================================== */

/** 单个 3D 铭牌类别的设计规格 */
export interface HudLabelSpecItem {
  /** drei <Html> distanceFactor（相机距离与 DOM 像素缩放比例系数） */
  readonly distanceFactor: number;
  /** 允许的最小字体像素值（px） */
  readonly minPx: number;
  /** 允许的最大字体像素值（px） */
  readonly maxPx: number;
  /**
   * 透视缩放倍率安全下界与上界（drei `<Html distanceFactor>` 原始 scale = df / (2*tan(fov/2)*dist)）。
   * 用途：在近景/特写机位或超远机位抑制纯 CSS scale 的极端放大/缩小，使渲染后真实屏幕像素
   * 在全景 `[10, 18]px`、特写 `[10, 22]px` 区间内同时保持远小近大的空间纵深感。
   */
  readonly minScale: number;
  readonly maxScale: number;
  /** 主标题 CSS clamp() 字号表达式 */
  readonly clampFontSize: string;
  /** 次级数值 / 辅助标签 CSS clamp() 字号表达式 */
  readonly metaClampFontSize: string;
}

/**
 * HUD_LABEL_SPEC —— 全场 3D `<Html>` 铭牌尺寸与透视基准表。
 *
 * 【为什么是这组数值】
 * - `MASTER_LABEL`: 全景相机距中心约 26.8 单位，`distanceFactor: 26` 使屏上字体与设计基准
 *   接近 1:1；`clamp(10px, 0.58vw, 14px)` 在 1920px 宽屏收敛于 ~11.1px、1366px 笔记本保底 10px；
 *   `minScale: 0.90 / maxScale: 1.18` 保证屏上真实高度稳定落于 ~11.5–15.1px。
 * - `RACK_LABEL`: 三座机架距相机横跨 11~34 单位，将 `distanceFactor` 从旧值 17 抬至 22，
 *   配合 `clamp(10px, 0.62vw, 18px)`（1080p 下 ~11.9px / 1366 下 10px）与 `[minScale 0.95, maxScale 1.24]`：
 *   最远 `worker-gamma` 屏上 ~13px（>=10px 清晰可读），特写 `worker-alpha` 不再 3.54x 炸到 55px 遮挡底层 Pod，
 *   而是柔和收敛在 ~17px（<=18px 全景 / <=22px 特写）。
 * - `POD_HOVER_LABEL`: 悬停探针贴近单颗刀片触发，维持 `distanceFactor: 12` 保证信息紧凑不遮邻槽，
 *   `clamp(10px, 0.62vw, 14px)` 与 `[minScale 0.90, maxScale 1.18]` 锁死安全框。
 */
export const HUD_LABEL_SPEC = {
  MASTER_LABEL: {
    distanceFactor: 26,
    minPx: 10,
    maxPx: 14,
    minScale: 0.90,
    maxScale: 1.18,
    clampFontSize: 'clamp(10px, 0.58vw, 14px)',
    metaClampFontSize: 'clamp(10px, 0.52vw, 12px)',
  },
  RACK_LABEL: {
    distanceFactor: 22,
    minPx: 10,
    maxPx: 18,
    minScale: 0.95,
    maxScale: 1.24,
    clampFontSize: 'clamp(10px, 0.62vw, 18px)',
    metaClampFontSize: 'clamp(10px, 0.52vw, 13px)',
  },
  POD_HOVER_LABEL: {
    distanceFactor: 12,
    minPx: 10,
    maxPx: 14,
    minScale: 0.90,
    maxScale: 1.18,
    clampFontSize: 'clamp(10px, 0.62vw, 14px)',
    metaClampFontSize: 'clamp(10px, 0.54vw, 12px)',
  },
} as const satisfies Record<'MASTER_LABEL' | 'RACK_LABEL' | 'POD_HOVER_LABEL', HudLabelSpecItem>;

/* ========================================================================== */
/* 铭牌距离吃雾驱动（R6-3，useFrame 热路径零分配 / 零 setState）               */
/* ========================================================================== */

/** 为什么是这几个值（R6-3 / 拉远清晰度调优）：28 单位内（含全景机位及常规拉远）全亮全饱和不吃雾；28→64 随镜头超远推拉温和过渡，避免拉远后铭牌变暗发灰 */
const HUD_FOG_NEAR_DISTANCE = 28;
const HUD_FOG_FAR_DISTANCE = 64;
const HUD_FOG_MID_OPACITY = 0.72;
const HUD_FOG_MIN_SATURATE = 0.85;

/** 最小相机位置向量接口（与 THREE.Vector3 结构兼容，避免常量模块重度耦合 three） */
export interface WorldPointLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 透视缩放护栏参数（与 HUD_LABEL_SPEC 条目结构兼容） */
export type HtmlScaleGuardSpec = Pick<HudLabelSpecItem, 'distanceFactor' | 'minScale' | 'maxScale'>;

/** DOM 样式脏检查缓存（避免每帧重复赋值引发浏览器无效样式重算） */
export interface HtmlFogStyleCache {
  lastOpacity: string;
  lastFilter: string;
  lastTransform: string;
}

/**
 * createHtmlFogStyleCache —— 初始化单个 `<Html>` 容器的吃雾缓存对象。
 *
 * @returns 可复用的可变缓存记录（组件挂载期创建一次，useFrame 内原地复用）
 */
export function createHtmlFogStyleCache(): HtmlFogStyleCache {
  return {
    lastOpacity: '',
    lastFilter: '',
    lastTransform: '',
  };
}

/**
 * applyHtmlFogAttenuation —— 按相机到铭牌世界坐标距离实时调制铭牌透光、饱和度与近/远端缩放护栏。
 *
 * 【核心数学与状态流转】（AGENTS.md 第 3 / 8 条）
 * - 距离计算纯标量 `Math.hypot(camPos.x - wx, ...)`，零 `new THREE.Vector3()`、零 `setState`；
 * - 吃雾区间分段：
 *   - `dist < 28`：`opacity = 1`，`saturate = 1`（取消 filter 层）；
 *   - `28 ≤ dist ≤ 64`：线性过渡 `opacity: 1 → 0.72`、`saturate: 1 → 0.85`，确保拉远仍清晰高对比；
 *   - `dist > 64`：`opacity = 0` 完全融入深空雾效。
 * - 近/远透视缩放护栏（`scaleGuard` 可选）：按照 drei `objectScale` 同源公式
 *   `rawScale = distanceFactor / (2 * tan(fov/2) * dist)` 计算外层 wrapper 当前透视倍率，
 *   越出 `[minScale, maxScale]` 时于内层节点施加 `scale(clampedScale / rawScale)` 逆补偿，
 *   区间内恒输出 `'none'` 保留原始透视纵深，同时彻底杜绝特写机位铭牌 3.5x 膨胀遮挡 Pod。
 * - 通过 `HtmlFogStyleCache` 做字符串比对后才写 DOM `.style`，60FPS 下镜头静止时零样式写开销。
 *
 * @param element 目标 `<Html>` 内部包裹节点引用
 * @param camPos 当前相机世界坐标
 * @param worldX 铭牌锚点世界 X
 * @param worldY 铭牌锚点世界 Y
 * @param worldZ 铭牌锚点世界 Z
 * @param cache 单铭牌样式脏检查缓存
 * @param scaleGuard 可选透视缩放安全护栏（通常直接传 HUD_LABEL_SPEC 条目）
 * @param fovDeg 透视相机垂直视场角（度），默认 45
 */
export function applyHtmlFogAttenuation(
  element: HTMLDivElement | null,
  camPos: WorldPointLike,
  worldX: number,
  worldY: number,
  worldZ: number,
  cache: HtmlFogStyleCache,
  scaleGuard?: HtmlScaleGuardSpec,
  fovDeg = 45,
): void {
  if (element === null) return;

  const dx = camPos.x - worldX;
  const dy = camPos.y - worldY;
  const dz = camPos.z - worldZ;
  const dist = Math.hypot(dx, dy, dz);

  let opacity: number;
  let saturate: number;
  if (dist < HUD_FOG_NEAR_DISTANCE) {
    opacity = 1;
    saturate = 1;
  } else if (dist <= HUD_FOG_FAR_DISTANCE) {
    const ratio = (dist - HUD_FOG_NEAR_DISTANCE) / (HUD_FOG_FAR_DISTANCE - HUD_FOG_NEAR_DISTANCE);
    opacity = 1 - ratio * (1 - HUD_FOG_MID_OPACITY);
    saturate = 1 - ratio * (1 - HUD_FOG_MIN_SATURATE);
  } else {
    opacity = 0;
    saturate = HUD_FOG_MIN_SATURATE;
  }

  const opacityStr = opacity.toFixed(3);
  const filterStr = saturate >= 0.995 ? 'none' : `saturate(${saturate.toFixed(2)})`;

  if (cache.lastOpacity !== opacityStr) {
    element.style.opacity = opacityStr;
    cache.lastOpacity = opacityStr;
  }
  if (cache.lastFilter !== filterStr) {
    element.style.filter = filterStr;
    cache.lastFilter = filterStr;
  }

  if (scaleGuard !== undefined) {
    const halfFovRad = ((fovDeg * Math.PI) / 180) * 0.5;
    const rawScale =
      scaleGuard.distanceFactor / (2 * Math.tan(halfFovRad) * Math.max(dist, 0.5));
    const clampedScale = Math.min(scaleGuard.maxScale, Math.max(scaleGuard.minScale, rawScale));
    const compensation = clampedScale / Math.max(rawScale, 1e-4);
    const transformStr =
      Math.abs(compensation - 1) < 0.01 ? 'none' : `scale(${compensation.toFixed(3)})`;
    if (cache.lastTransform !== transformStr) {
      element.style.transform = transformStr;
      cache.lastTransform = transformStr;
    }
  }
}
