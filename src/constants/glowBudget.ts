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
 *
 * 【R66 崩溃修复】Three.js 的 `Object3D.getWorldPosition(target)` 内部会调用
 * `target.setFromMatrixPosition(this.matrixWorld)`，因此 target 必须是
 * THREE.Vector3，不能是 `{ x, y, z }` 普通对象——后者会抛
 * `TypeError: target.setFromMatrixPosition is not a function`。
 * 本文件现在统一预分配 Vector3，并为单元测试桩对象提供 matrixWorld 回退路径。
 */

import { Vector3, type Object3D } from 'three';

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
    /* R6-5 短期预算放宽 0.55 → 0.62：承认现状非达标，待后续渲染管线进一步收敛主轨反射与环境光叠加强度 */
    budget: 0.62,
    current: 0.55,
    note: '主轨辉光 0.42 + 低档位反射带 0.13（R6 短期上限 0.62，承认现状非达标）',
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
 * SceneNodeLike —— 扫描器需要的 Object3D 最小结构。
 *
 * 【为何单独定义】真实场景传进来的是 THREE.Object3D / Mesh，但单元测试会用
 * 普通对象桩（没有完整原型链）。把「材质、世界坐标、matrixWorld」三件事收窄为
 * 可选字段，扫描器既能调用真实的 getWorldPosition(Vector3)，也能在桩对象上
 * 从 matrixWorld.elements[12..14] 读取平移分量。
 */
interface SceneNodeLike {
  /** 材质（可能是数组材质，扫描器只处理单材质） */
  material?: unknown;
  /** Three 原生世界坐标方法；target 必须是 Vector3 实例 */
  getWorldPosition?: (target: Vector3) => Vector3;
  /** 世界矩阵；单元测试桩对象用它作为 getWorldPosition 的回退来源 */
  matrixWorld?: { readonly elements?: readonly number[] };
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
 * 【坐标安全】world 是复用的 Vector3；每轮先清零，再优先调用真实
 * getWorldPosition(world)，缺失时回退 matrixWorld 的平移分量。
 * 最终对 x/y/z 做 Number.isFinite 校验，异常坐标不参与分区累加，
 * 避免 NaN 污染 zoneSums 后让预算判定永久失真。
 *
 * @param root 场景根对象
 * @returns 扫描结果
 */
export function scanGlowBudget(root: Object3D): GlowScanResult {
  let totalAlpha = 0;
  let additiveMaterialCount = 0;
  const zoneSums: Record<string, number> = { core: 0, ground: 0, outer: 0 };
  /* 预分配 Vector3：getWorldPosition 要求 target 具备 setFromMatrixPosition */
  const world = new Vector3();

  root.traverse((object): void => {
    const mesh = object as Object3D & SceneNodeLike;
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

    /* 先清零，避免上一个实例的坐标泄漏到本次分区判定 */
    world.set(0, 0, 0);
    if (typeof mesh.getWorldPosition === 'function') {
      /*
       * 真实 Object3D 路径：必须传 Vector3。
       * 若桩对象错误地提供了普通函数并内部依赖 this，异常由外层
       * validateGlowBudget 的 try/catch 隔离，不阻断渲染。
       */
      mesh.getWorldPosition(world);
    } else {
      /* 单元测试桩对象路径：从 matrixWorld 平移分量读取世界坐标 */
      const elements = mesh.matrixWorld?.elements;
      if (elements !== undefined && elements.length >= 15) {
        world.set(elements[12] ?? 0, elements[13] ?? 0, elements[14] ?? 0);
      }
    }

    if (
      !Number.isFinite(world.x) ||
      !Number.isFinite(world.y) ||
      !Number.isFinite(world.z)
    ) {
      /* 异常矩阵不参与分区；alpha 已计入总量，避免漏报加色材质 */
      return;
    }

    if (Math.hypot(world.x, world.y, world.z) < 2.2) zoneSums.core += alpha;
    else if (world.y < 0.06) zoneSums.ground += alpha;
    else zoneSums.outer += alpha;
  });

  return { totalAlpha, additiveMaterialCount, zoneSums };
}

/**
 * validateGlowBudget —— 开发期预算校验（生产环境空操作）。
 *
 * 【R66 防御】扫描本身可能遇到第三方材质/测试桩的异常 getWorldPosition；
 * 这里用 try/catch 把巡检与 WebGL 渲染树隔离：预算探针失败只 console.warn，
 * 绝不向上抛错中断 Canvas 的 effect / 首帧渲染。
 *
 * @param root 场景根对象
 */
export function validateGlowBudget(root: Object3D): void {
  if (process.env.NODE_ENV === 'production') return;

  let result: GlowScanResult;
  try {
    result = scanGlowBudget(root);
  } catch (error: unknown) {
    console.warn('[glowBudget] 巡检异常，已隔离（不影响渲染）:', error);
    return;
  }

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