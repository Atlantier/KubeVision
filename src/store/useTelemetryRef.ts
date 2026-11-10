/**
 * KubeVision AI — 遥测瞬态引用池（双轨状态管理 · 轨道一：零重绘高频轨）
 *
 * 【设计意图】（AGENTS.md 第 3 条 60FPS 渲染性能红线）
 * R3F 的 useFrame 以 60FPS 频率读取遥测数值驱动 InstancedMesh 矩阵与
 * 材质 Uniform。若这些数据进入 React 状态（useState / zustand 订阅），
 * 每帧将触发组件树重渲染与协调，帧预算（16.6ms）被 React 开销吞噬。
 *
 * 因此本模块提供一个**模块级可变单例 + 定长 Float32Array** 的瞬态引用池：
 * - 数据写入是 O(1) 原地突变（in-place mutation），不产生新对象、不触发 GC；
 * - useFrame 内直接按下标读写 Float32Array，绕过 React 协调器；
 * - 与响应式 Store（轨道二）完全解耦，二者仅以「快照引用」交汇。
 *
 * 【为何是"非 Hook"却命名为 use*】保留 use 前缀以对齐团队既有的调用语义
 * （useTelemetryRef() 返回瞬态引用池），但本模块**不含任何 React Hook 调用**，
 * 是纯粹的模块级单例访问器，可在任意位置（含 useFrame、Worker 回调、
 * SSE 解析器）安全调用，不受 Hook 规则约束。
 *
 * 【SSR 边界安全】本模块不引用 window / three / Worker，模块顶层仅做
 * 定长 TypedArray 分配，服务端 import 求值安全（AGENTS.md 第 4 条）。
 * Float32Array 在 Node 与浏览器均为标准内置，无环境分支。
 */

import type { TelemetrySnapshot } from '@/types/cluster';
import { INITIAL_CLUSTER_SNAPSHOT } from '@/types/cluster';
import type { TelemetryTransientRef } from '@/types/store';

/* ========================================================================== */
/* 容量常量（定长预分配的物理上限契约）                                          */
/* ========================================================================== */

/**
 * Pod 瞬态槽位最大容量。
 *
 * 【取值依据】48 = 3 机架 × 每机架 16 槽位（见 spatialLayout.ts 槽位契约：
 * 4 层托盘 × 2×2 网格）。当前种子快照为 24 Pod，预留 2 倍扩容余量以容纳
 * 混沌演练（POD_OOM_SWARM 批量扩容）与真实 live 集群规模。
 */
export const MAX_PODS = 48;

/**
 * 节点瞬态槽位最大容量。
 *
 * 【取值依据】3 = worker-alpha/beta/gamma 三机架环形拓扑的固定机架数
 * （rackIndex 字面量联合 0|1|2 的基数）。
 */
export const MAX_NODES = 3;

/* ========================================================================== */
/* 全局单例瞬态引用池                                                           */
/* ========================================================================== */

/**
 * telemetryTransientRef —— 全局单例可变瞬态引用池（模块级，非 React 状态）。
 *
 * 【初始化契约】snapshot 以 INITIAL_CLUSTER_SNAPSHOT 初始化（确定性字面量，
 * SSR/CSR 逐字节一致）；四个 Float32Array 均以定长零值分配，并立即执行一次
 * syncSnapshotToTransientRef 用种子数据填充，保证「首帧即有有效遥测」——
 * R3F 画布挂载后的第一次 useFrame 就能读到 24 个 Pod 的真实水位，
 * 而非全零导致的「全场灰暗」视觉闪烁。
 *
 * 【消费契约】
 * - 写方：SSE/NDJSON 解析器、模拟引擎 Worker 回调 → syncSnapshotToTransientRef()
 * - 读方：useFrame 内按下标读 podSmoothCpuFloat32 / podCpuFloat32 等，
 *   并原地回写平滑插值结果与 glStats 指标。
 * - 严禁：将该对象放入 useState / zustand / useContext（会重新引入重渲染）。
 */
export const telemetryTransientRef: TelemetryTransientRef = {
  snapshot: INITIAL_CLUSTER_SNAPSHOT,

  /** Pod CPU 实时目标值（1Hz 阶跃写入），@range 每项 [0,100] */
  podCpuFloat32: new Float32Array(MAX_PODS),
  /** Pod 内存实时目标值（1Hz 阶跃写入），@range 每项 [0,100] */
  podMemFloat32: new Float32Array(MAX_PODS),
  /** Pod CPU 平滑插值当前值（60FPS 由 useFrame 逼近目标值并回写） */
  podSmoothCpuFloat32: new Float32Array(MAX_PODS),
  /** 节点网络吞吐目标值（Mbps），驱动机架间流量粒子带密度 */
  nodeNetFloat32: new Float32Array(MAX_NODES),

  /** C7：Pod ID → 稳定槽位（首次出现时分配，卸载后回收） */
  podSlotById: new Map<string, number>(),

  /** 性能 HUD 瞬态指标（渲染循环每帧写入，HUD 以 rAF 节流读取） */
  glStats: {
    fps: 0,
    frameTimeMs: 0,
    drawCalls: 0,
    triangles: 0,
    sseLatencyMs: 0,
    workerStatus: 'idle',
    renderTier: 'T0',
    renderReason: '初始化中',
    toneMappingExposure: 1.18,
    sceneLuminanceEstimate: 0,
  },
};

/* ========================================================================== */
/* 同步函数                                                                    */
/* ========================================================================== */

/**
 * syncSnapshotToTransientRef —— 将一份完整遥测快照安全同步进瞬态引用池。
 *
 * 【核心逻辑】
 * 1. 整体替换 snapshot 引用（不可变值语义：绝不原地修改传入快照的字段，
 *    避免与 zustand 轨道二的 snapshotSummary 共享可变引用导致状态漂移）。
 * 2. 按下标 i 将 pods[i] / nodes[i] 的数值写入对应 Float32Array 槽位。
 *    索引映射采用「快照数组顺序」而非 Pod.id 查表：O(n) 单次遍历，
 *    与 InstancedMesh 的 instanceId 下标天然对齐（渲染层按同一顺序构建矩阵）。
 * 3. **越界清零**：实际数量 < 容量时，将 [count, MAX) 区间显式置 0，
 *    杜绝上一轮快照残留的「幽灵 Pod」在缩容后仍被渲染。
 *    （Float32Array.fill(0, begin, end) 为原生定长填充，零分配。）
 * 4. **容量截断**：实际数量 > 容量时仅同步前 MAX 个并返回 false，
 *    由调用方（引擎层）记录告警；绝不越界写入（TypedArray 越界写会被静默忽略，
 *    但显式截断可让 HUD 暴露配置错误）。
 *
 * 【输入输出】
 * @param snapshot 待同步的完整遥测快照（不可变值对象）
 * @returns true 表示全部实体均在容量内同步成功；false 表示发生容量截断
 *
 * 【调用频率】1Hz（每份快照一次）。本函数自身为 O(MAX_PODS + MAX_NODES)
 * 定长开销，不含任何对象分配，可安全在 Worker 消息回调中调用。
 */
/**
 * getPodSlotIndex —— 按 Pod ID 取瞬态槽位（C7：读方唯一入口）。
 *
 * @param podId Pod 实体 ID
 * @returns 槽位下标；未分配返回 -1
 */
export function getPodSlotIndex(podId: string): number {
  return telemetryTransientRef.podSlotById.get(podId) ?? -1;
}

export function syncSnapshotToTransientRef(snapshot: TelemetrySnapshot): boolean {
  // ---- 1. 整体替换快照引用（轨道交汇点） ----
  telemetryTransientRef.snapshot = snapshot;

  const pods = snapshot.pods;
  const nodes = snapshot.nodes;

  // ---- 2. 容量截断判定（超出 MAX 的部分本轮丢弃并上报 false） ----
  const podCount = pods.length <= MAX_PODS ? pods.length : MAX_PODS;
  const nodeCount = nodes.length <= MAX_NODES ? nodes.length : MAX_NODES;
  const truncated = pods.length > MAX_PODS || nodes.length > MAX_NODES;

  // ---- 3. Pod 数值按**稳定槽位**写入（C7：按 id 映射而非按下标） ----
  // 契约：cpuUsage / memoryUsage ∈ [0,100]（cluster.ts @range 标注）。
  // 槽位在 Pod 首次出现时分配，此后即使快照重排也保持不变；
  // 仅对 NaN 做防御（NaN 会污染后续所有插值运算，必须拦截为 0）。
  const slotMap = telemetryTransientRef.podSlotById;
  const activeSlots = new Set<number>();
  let nextSlot = 0;
  for (const slot of slotMap.values()) {
    if (slot >= nextSlot) nextSlot = slot + 1;
  }

  for (let i = 0; i < podCount; i += 1) {
    const pod = pods[i];
    let slot = slotMap.get(pod.id);
    if (slot === undefined) {
      slot = nextSlot;
      nextSlot += 1;
      if (slot >= MAX_PODS) break;
      slotMap.set(pod.id, slot);
    }
    activeSlots.add(slot);
    const cpu = pod.cpuUsage;
    const mem = pod.memoryUsage;
    telemetryTransientRef.podCpuFloat32[slot] = Number.isNaN(cpu) ? 0 : cpu;
    telemetryTransientRef.podMemFloat32[slot] = Number.isNaN(mem) ? 0 : mem;
  }

  // ---- 4. 回收已消失 Pod 的槽位并清零（防幽灵数据） ----
  for (const [podId, slot] of slotMap) {
    if (activeSlots.has(slot)) continue;
    slotMap.delete(podId);
    telemetryTransientRef.podCpuFloat32[slot] = 0;
    telemetryTransientRef.podMemFloat32[slot] = 0;
    telemetryTransientRef.podSmoothCpuFloat32[slot] = 0;
  }

  // ---- 5. 节点网络吞吐按下标写入 + 越界清零 ----
  for (let i = 0; i < nodeCount; i++) {
    const mbps = nodes[i].networkMbps;
    telemetryTransientRef.nodeNetFloat32[i] = Number.isNaN(mbps) ? 0 : mbps;
  }
  if (nodeCount < MAX_NODES) {
    telemetryTransientRef.nodeNetFloat32.fill(0, nodeCount, MAX_NODES);
  }

  return !truncated;
}

/* ========================================================================== */
/* 便捷访问器（保持 use* 调用语义，非 React Hook）                               */
/* ========================================================================== */

/**
 * useTelemetryRef —— 瞬态引用池访问器（**非 React Hook**，无 Hook 规则约束）。
 *
 * 【设计意图】为消费方提供与团队既有语义一致的调用形式：
 *   const telemetry = useTelemetryRef();
 *   useFrame(() => { const cpu = telemetry.podSmoothCpuFloat32[i]; ... });
 * 返回的恒为同一模块级单例引用（引用相等性稳定），因此不会像 useState
 * 那样因返回新对象而触发下游重渲染。
 *
 * 【命名取舍】保留 use 前缀是为对齐需求命名与调用直觉；实现上是纯函数访问器，
 * 可在 useFrame / Worker 回调 / SSE 解析器等任意非组件上下文安全调用。
 * 若后续需要消除「疑似 Hook」的 lint 误解，可平滑改名为 getTelemetryRef()。
 *
 * @returns 全局单例瞬态引用池（每次调用返回同一引用）
 */
export function useTelemetryRef(): TelemetryTransientRef {
  return telemetryTransientRef;
}

/* ---- 模块加载即用种子数据填充，保证首帧遥测有效（见 telemetryTransientRef JSDoc） ---- */
syncSnapshotToTransientRef(INITIAL_CLUSTER_SNAPSHOT);
