/**
 * KubeVision AI — 发光能量预算（R29 · D 项）
 *
 * 【为什么需要预算】加色混合（AdditiveBlending）没有"遮挡"概念，同屏叠加的
 * alpha 会无限累加。此前只有零散的经验值（Bloom 0.72、雾球 0.30…），
 * 无法回答"晶核区域总共允许多亮"。本文件把每个视觉区域的加色预算固化为
 * 常量，并提供开发期扫描：运行时把实际材质的加色 alpha 汇总，超预算 console.warn。
 *
 * 【分区与目标】
 *   - 晶核（屏幕半径 120px 内）：总加色 alpha ≤ 1.15
 *   - 地面主轨：≤ 0.55
 *   - 外围（星云/大气/星芒外溢）：≤ 0.40
 *   - 机架顶冠：≤ 0.45
 */

import type { Object3D } from 'three';

/** 一个发光分区的预算与当前设计值 */
export interface GlowZoneBudget {
  /** 分区 id（用于调试面板与日志） */
  readonly id: string;
  /** 中文标签 */
  readonly label: string;
  /** 分区加色 alpha 总预算 */
  readonly budget: number;
  /** 当前设计值（来自各层常量，见 note） */
  readonly current: number;
  /** 构成说明 */
  readonly note: string;
}

/** 各发光分区的预算表（current 为各层 alpha 的设计叠加值） */
export const GLOW_BUDGET_ZONES: readonly GlowZoneBudget[] = [
  {
    id: 'core',
    label: '晶核（屏幕半径 120px 内）',
    budget: 1.15,
    current: 1.02,
    note: '内核 0.22 + 雾球 0.30 + 晶体 0.28 + 星芒 0.22',
  },
  {
    id: 'ground',
    label: '地面主轨',
    budget: 0.55,
    current: 0.55,
    note: '主轨辉光 0.42 + 低档位反射带 0.13',
  },
  {
    id: 'outer',
    label: '外围（星云 / 大气）',
    budget: 0.4,
    current: 0.32,
    note: '星云 0.12 + 大气 0.20',
  },
  {
    id: 'crown',
    label: '机架顶冠',
    budget: 0.45,
    current: 0.35,
    note: '顶冠光斑 0.20 + 棱边倒角高光 0.15',
  },
];

/** 开发期扫描结果 */
export interface GlowScanResult {
  /** 场景中所有加色材质的 alpha 总和 */
  readonly totalAlpha: number;
  /** 加色材质数量 */
  readonly additiveMaterialCount: number;
  /** 分区累计（按材质所属 mesh 的世界半径/高度近似分区） */
  readonly zoneSums: Readonly<Record<string, number>>;
}

/**
 * scanGlowBudget —— 遍历场景统计加色材质的实际 alpha 总和。
 *
 * 【分区近似】以世界坐标粗分：
 *   - 距原点 < 2.2 → core；
 *   - y < 0.06 → ground；
 *   - 其余 → outer。
 * 扫描在开发期挂载后 4s 执行一次，不进入渲染循环。
 *
 * @param root 场景根对象
 * @returns 扫描结果
 */
export function scanGlowBudget(root: Object3D): GlowScanResult {
  let totalAlpha = 0;
  let additiveMaterialCount = 0;
  const zoneSums: Record<string, number> = { core: 0, ground: 0, outer: 0 };
  const world = { x: 0, y: 0, z: 0 };

  root.traverse((object): void => {
    const mesh = object as Object3D & {
      material?: unknown;
      getWorldPosition?: (target: { x: number; y: number; z: number }) => void;
    };
    if (mesh.material === undefined) return;
    const material = mesh.material as {
      blending?: number;
      transparent?: boolean;
      opacity?: number;
    };
    if (material.blending !== 2 || material.transparent !== true) return;
    const alpha = typeof material.opacity === 'number' ? material.opacity : 0;
    totalAlpha += alpha;
    additiveMaterialCount += 1;
    mesh.getWorldPosition?.(world);
    if (Math.hypot(world.x, world.y, world.z) < 2.2) zoneSums.core += alpha;
    else if (world.y < 0.06) zoneSums.ground += alpha;
    else zoneSums.outer += alpha;
  });

  return { totalAlpha, additiveMaterialCount, zoneSums };
}

/**
 * validateGlowBudget —— 开发期预算校验（生产环境空操作）。
 *
 * @param root 场景根对象
 */
export function validateGlowBudget(root: Object3D): void {
  if (process.env.NODE_ENV === 'production') return;
  const result = scanGlowBudget(root);
  const over = GLOW_BUDGET_ZONES.filter((zone): boolean => {
    const actual = result.zoneSums[zone.id] ?? 0;
    return actual > zone.budget;
  });
  if (over.length > 0) {
    for (const zone of over) {
      console.warn(
        `[glowBudget] ${zone.label} 超预算：实际 ${(result.zoneSums[zone.id] ?? 0).toFixed(2)} > 目标 ${zone.budget}`,
      );
    }
  } else {
    console.info(
      `[glowBudget] 通过：加色材质 ${result.additiveMaterialCount} 个，总 alpha ${result.totalAlpha.toFixed(2)}，分区 ${JSON.stringify(result.zoneSums)}`,
    );
  }
}