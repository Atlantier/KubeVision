'use client';

/**
 * KubeVision AI — 静态几何模块期合批工具（R5 进阶 · 零视觉削减合批）
 *
 * 【设计意图】在不删减任何视觉装饰元素的前提下，把同材质、同渲染状态的
 * 静态子几何在模块加载期或 `useMemo` 内通过 Three.js `mergeGeometries` 一次合批，
 * 消减无谓的 Draw Call，并自动计算真实包围盒与包围球——严禁借助
 * `frustumCulled={false}` 规避视锥裁剪。
 *
 * 【反作弊生命周期契约】
 * - 静态合批只允许在模块初始化（`readyMarked=false`）阶段调用；
 * - 场景首帧挂载完成后调用 `markStaticMergePhaseReady()` 切换为稳态期；
 * - 稳态期（60s soak）内 `runtimeCalls` 必须严格为 0，绝不允许在 `useFrame`
 *   或每次 render 内重建数组与重新合并几何。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** 单个静态立方体子件的空间变换参数 */
export interface StaticBoxPart {
  readonly size: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
}

/** 单个静态平面子件的空间变换参数 */
export interface StaticPlanePart {
  readonly size: readonly [number, number];
  readonly position: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
}

/** 静态合批调用审计快照（用于验证稳态期间 mergeGeometries 调用次数为 0） */
export interface MergeGeometryRuntimeStats {
  readonly initCalls: number;
  readonly runtimeCalls: number;
  readonly mergedParts: number;
  readonly readyMarked: boolean;
}

/* 模块级预分配变换 scratch，避免合批循环内重复创建矩阵对象 */
const MERGE_TEMP_POS = new THREE.Vector3();
const MERGE_TEMP_EULER = new THREE.Euler();
const MERGE_TEMP_QUAT = new THREE.Quaternion();
const MERGE_TEMP_SCALE = new THREE.Vector3(1, 1, 1);
const MERGE_TEMP_MATRIX = new THREE.Matrix4();

const mergeStats = {
  initCalls: 0,
  runtimeCalls: 0,
  mergedParts: 0,
  readyMarked: false,
};

function applyTransformAndMerge(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (mergeStats.readyMarked) {
    mergeStats.runtimeCalls += 1;
  } else {
    mergeStats.initCalls += 1;
  }
  mergeStats.mergedParts += geometries.length;

  const merged: THREE.BufferGeometry | null = mergeGeometries(geometries, false);
  for (const geom of geometries) {
    geom.dispose();
  }
  if (merged === null) {
    throw new Error('[mergeStaticGeometries] mergeGeometries 返回 null，请检查属性布局一致性');
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * mergeStaticBoxes —— 在加载期把多个同材质静态长方体合并为单份 BufferGeometry。
 *
 * 【输入/输出】接收若干盒子尺寸与局部偏移/欧拉角，构建对应 BoxGeometry，
 * 原地应用变换矩阵后调用 `mergeGeometries`，计算真实包围盒/包围球并释放临时几何。
 */
export function mergeStaticBoxes(parts: readonly StaticBoxPart[]): THREE.BufferGeometry {
  const prepared: THREE.BufferGeometry[] = [];
  for (const part of parts) {
    const geom = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
    MERGE_TEMP_POS.set(part.position[0], part.position[1], part.position[2]);
    if (part.rotation !== undefined) {
      MERGE_TEMP_EULER.set(part.rotation[0], part.rotation[1], part.rotation[2]);
      MERGE_TEMP_QUAT.setFromEuler(MERGE_TEMP_EULER);
    } else {
      MERGE_TEMP_QUAT.identity();
    }
    MERGE_TEMP_SCALE.set(1, 1, 1);
    MERGE_TEMP_MATRIX.compose(MERGE_TEMP_POS, MERGE_TEMP_QUAT, MERGE_TEMP_SCALE);
    geom.applyMatrix4(MERGE_TEMP_MATRIX);
    prepared.push(geom);
  }
  return applyTransformAndMerge(prepared);
}

/**
 * mergeStaticPlanes —— 在加载期把多个同材质静态矩形面片合并为单份 BufferGeometry。
 *
 * 【UV 保真】每个面片保留各自原始 `[0, 1]^2` UV，确保片段着色器（如蜂窝孔阵）效果不变。
 */
export function mergeStaticPlanes(parts: readonly StaticPlanePart[]): THREE.BufferGeometry {
  const prepared: THREE.BufferGeometry[] = [];
  for (const part of parts) {
    const geom = new THREE.PlaneGeometry(part.size[0], part.size[1]);
    MERGE_TEMP_POS.set(part.position[0], part.position[1], part.position[2]);
    if (part.rotation !== undefined) {
      MERGE_TEMP_EULER.set(part.rotation[0], part.rotation[1], part.rotation[2]);
      MERGE_TEMP_QUAT.setFromEuler(MERGE_TEMP_EULER);
    } else {
      MERGE_TEMP_QUAT.identity();
    }
    MERGE_TEMP_SCALE.set(1, 1, 1);
    MERGE_TEMP_MATRIX.compose(MERGE_TEMP_POS, MERGE_TEMP_QUAT, MERGE_TEMP_SCALE);
    geom.applyMatrix4(MERGE_TEMP_MATRIX);
    prepared.push(geom);
  }
  return applyTransformAndMerge(prepared);
}

/**
 * mergeStaticRawGeometries —— 在加载期合并已带有空间坐标的一组 BufferGeometry（如 TubeGeometry 束）。
 *
 * 合并后自动释放所有输入子几何，并重算完整包围盒与包围球。
 */
export function mergeStaticRawGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return applyTransformAndMerge(geometries);
}

/**
 * markStaticMergePhaseReady —— 标记场景首帧已进入稳态，此后若再调用合并即记为 runtimeCalls。
 */
export function markStaticMergePhaseReady(): void {
  mergeStats.readyMarked = true;
}

/**
 * getMergeGeometryStats —— 读取模块初始化与稳态期间静态合批的审计计数快照。
 */
export function getMergeGeometryStats(): MergeGeometryRuntimeStats {
  return {
    initCalls: mergeStats.initCalls,
    runtimeCalls: mergeStats.runtimeCalls,
    mergedParts: mergeStats.mergedParts,
    readyMarked: mergeStats.readyMarked,
  };
}
