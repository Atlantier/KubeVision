'use client';

/**
 * KubeVision AI — 高性能 Pod 容器实例渲染器（PodInstancedMesh）
 *
 * 【设计意图】（AGENTS.md 第 3 条 60FPS 红线 + 第 7 条 InstancedMesh 规范）
 * 全集群 Pod（种子 24、容量上限 48）以**单次 Draw Call** 的 InstancedMesh 渲染：
 * 每帧从瞬态引用池 telemetryTransientRef 读取实时状态与 CPU 负载（零 React
 * 订阅、零组件重渲染），经预分配临时对象原地更新实例矩阵与实例色缓冲，
 * 实现 60FPS 下的实时态势驱动（状态色渐变、负载呼吸、故障抖动、过滤缩放）。
 *
 * 【容量契约：固定 48，严禁 pods.length】
 * R3F 对 <instancedMesh args> 的处理是「args 变化 → 销毁并重建整个
 * InstancedMesh」：GPU instanceMatrix/instanceColor 缓冲全毁、材质重编译，
 * 混沌引擎扩缩 Pod 数量时将造成整帧卡顿。故 args 容量恒为 MAX_PODS(48)，
 * 实际绘制数量经 mesh.count 命令式驱动（count ≤ 容量的前缀绘制，
 * 依旧是单次 Draw Call），Pod 增减零重建、零闪烁。
 *
 * 【空间对齐契约：与机架隔板严丝合缝，零穿模】
 * 实例位姿不逐帧重算三角函数，而是模块加载期一次性预计算 48 个槽位的
 * SLOT_POSES 查表（getPodWorldTransform 是纯函数，确定性输出可安全缓存）；
 * Pod 可视盒高 0.38 小于契约盒高 POD_BOX_HEIGHT(0.92)，落座偏移由
 * 「契约盒底面 = 隔板顶面」关系推导：seatOffset = 0.38/2 − 0.92/2 = −0.27，
 * 与 WorkerRack3D 隔板几何（TIER_DIVIDER_OFFSET 推导）共用同一数学事实源。
 *
 * 【useFrame 零分配纪律】
 * tempObject（Object3D）/ tempColor / tempTargetColor（Color）/ 每实例
 * 缩放状态 Float32Array 均在 useMemo 中一次性预分配；循环体内只有
 * 标量运算与 lerp/copy/set 原地突变，无任何 new（AGENTS.md 第 3 条）。
 *
 * 【指针交互契约：instanceId 精确拾取 + 最小重渲染】
 * R3F 对 InstancedMesh 的射线命中携带 e.instanceId（实例下标），据此 O(1)
 * 反查 PodEntity。防抖纪律：onPointerMove 仅在 instanceId 真正变化时
 * setHoveredInstanceId——指针在同一 Pod 上移动（每帧一个 move 事件）
 * 零 setState、零重渲染；悬停标签是**单个** <Html>（非每实例一个），
 * 挂载于场景根，世界坐标由 SLOT_POSES 查表（与实例渲染同源）。
 *
 * 【命中链让位协议】Pod 位于机架装甲腔体内部，任何命中 Pod 的射线必先
 * 穿过更近的装甲面——R3F 按距离升序派发，WorkerRack3D 的 handlers 检测到
 * intersections 中存在 Pod 实例命中时**静默放行**（不 stopPropagation、
 * 不选中、不高亮），本组件的 handlers 随后接管并 stopPropagation，
 * 保证「更具体的目标优先」且永不误选机架。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { shallow } from 'zustand/shallow';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import { MAX_PODS, telemetryTransientRef } from '@/store/useTelemetryRef';
import type { PodStatus } from '@/types/cluster';
import type { PodHoverLabelData, PodStatusBadgeStyle } from '@/types/canvas';
import type { ClusterState, SelectedEntityType, StatusFilter } from '@/types/store';
import { POD_BOX_SIZE, POD_SEAT_OFFSET_Y, getPodWorldTransform } from '@/utils/spatialLayout';

/* ========================================================================== */
/* 模块级常量与预计算表（加载期一次求值，SSR 安全——纯数学无 window/three 运行时）   */
/* ========================================================================== */

/* 说明：POD_BOX_SIZE 与 POD_SEAT_OFFSET_Y 已上提至 spatialLayout.ts
   作为渲染契约的单一事实源——SelectionBeacon3D 需要同一组尺寸与偏移
   才能把选中框严丝合缝地套在方块上。严禁在此重新定义局部副本。 */

/** 状态色常量（模块级预分配，useFrame 内只读，零 Color 构造） */
const COLOR_RUNNING = new THREE.Color('#10b981'); // 翠绿：Running 正常态
const COLOR_PENDING = new THREE.Color('#f59e0b'); // 琥珀：Pending / Terminating 过渡态
const COLOR_CRASH = new THREE.Color('#f43f5e'); // 警示红：CrashLoopBackOff / OOMKilled

/** 故障态发光增强倍率（契约指定：tempColor.multiplyScalar(1.5)，分量可 >1 产生过曝辉光） */
const CRASH_GLOW_BOOST = 1.5;

/** 颜色过渡阻尼率 k（1/秒）：≈0.17s 完成 63% 渐变，状态切换平滑不粘滞 */
const COLOR_LERP_RATE = 6;

/** 过滤缩放过渡阻尼率 k（1/秒）：比颜色更快，过滤操作要有「即时聚焦」手感 */
const FILTER_SCALE_LERP_RATE = 8;

/** 单帧 Δt 钳制上限（秒）：掉帧时限制插值步长，防颜色/缩放跳变 */
const MAX_FRAME_DELTA = 0.1;

/* ---- Running 态：负载驱动的悬浮呼吸参数 ---- */
/** 悬浮振幅基线（世界单位）+ 负载增量系数：cpu 0%→2%、100%→6% */
const RUN_HOVER_BASE = 0.02;
const RUN_HOVER_LOAD_GAIN = 0.04;
/** 悬浮角频率基线（rad/s）+ 负载增量：忙容器呼吸更急促 */
const RUN_HOVER_RATE_BASE = 1.6;
const RUN_HOVER_RATE_GAIN = 0.8;
/** 高度微调：负载每 100% 增高 10% + ±2% 正弦呼吸（「随负载高低」的形态表达） */
const RUN_HEIGHT_LOAD_GAIN = 0.1;
const RUN_HEIGHT_BREATH = 0.02;

/* ---- Pending/Terminating 态：缓慢明暗脉动参数 ---- */
/** 明暗脉动角频率（rad/s，≈2.6 秒/次「缓慢」）与幅度（0.72~1.0 亮度包络） */
const PENDING_PULSE_RATE = 2.4;
const PENDING_PULSE_MIN = 0.72;

/* ---- Crash/OOM 态：高频抖动 + 剧烈尺寸脉冲参数 ---- */
/** 水平抖动振幅与角频率（契约指定 Δx = 0.04·sin(35t)；相位逐实例错开防同步机械感） */
const CRASH_JITTER_AMPLITUDE = 0.04;
const CRASH_JITTER_RATE = 35;
/** 尺寸脉冲振幅与角频率（±25% 剧烈缩放，≈0.45 秒/次） */
const CRASH_PULSE_AMPLITUDE = 0.25;
const CRASH_PULSE_RATE = 14;

/** 过滤不匹配实例的目标缩放（契约指定值：缩小至 0.15 突出目标容器） */
const FILTER_DIM_SCALE = 0.15;

/**
 * 悬停标签相对槽位中心的抬升量（世界单位）。
 *
 * 【取值依据】Pod 盒顶 ≈ slotY − 0.08（落座偏移 −0.27 + 半高 0.19），
 * 上一层隔板底面 ≈ slotY + 0.535（TIER 间距 1.05 − 偏移 0.4875 − 半厚）；
 * 取 +0.34 使标签悬于 Pod 正上方、隔板之下的层间空档，视线不穿模。
 */
const HOVER_LABEL_OFFSET_Y = 0.34;

/**
 * Pod 状态 → 悬停标签徽标样式映射（深空赛博状态色体系，AGENTS.md 第 5 条）。
 * crash 双态附加 animate-glow-pulse 脉冲类，与 3D 侧的高频抖动语义呼应。
 */
const POD_STATUS_BADGE: Readonly<Record<PodStatus, PodStatusBadgeStyle>> = {
  Running: { label: 'Running', color: '#34d399' },
  Pending: { label: 'Pending', color: '#fbbf24' },
  Terminating: { label: 'Terminating', color: '#fbbf24' },
  CrashLoopBackOff: { label: 'CrashLoopBackOff', color: '#f43f5e', extraClass: 'animate-glow-pulse' },
  OOMKilled: { label: 'OOMKilled', color: '#f43f5e', extraClass: 'animate-glow-pulse' },
};

/** 每机架槽位数（与 spatialLayout 的 SLOTS_PER_RACK 契约一致） */
const SLOTS_PER_RACK = 16;

/** 机架数（三机架环形拓扑） */
const RACK_COUNT = 3;

/**
 * 槽位位姿预计算表（48 项：rack × 16 slot，行主序 index = rack*16 + slot）。
 *
 * 【缓存合法性】getPodWorldTransform 是无状态纯函数（无时间/随机/window 依赖），
 * 同一 (rackIndex, slotIndex) 输入恒得同一输出，故模块加载期一次求值永久有效；
 * useFrame 内查表 O(1)，替代逐帧 48×(sin/cos/hypot) 重算与数组分配（零 GC 压力）。
 */
interface PodSlotPose {
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
}

const SLOT_POSES: readonly PodSlotPose[] = (() => {
  const poses: PodSlotPose[] = [];
  for (let rack = 0; rack < RACK_COUNT; rack++) {
    for (let slot = 0; slot < SLOTS_PER_RACK; slot++) {
      const transform = getPodWorldTransform(rack, slot);
      poses.push({ position: transform.position, rotationY: transform.rotationY });
    }
  }
  return poses;
})();

/**
 * 每实例动画相位表（黄金角序列 i·2.39996 mod 2π，确定性「伪随机」错相）。
 *
 * 【为何不用 Math.random】随机相位会破坏 SSR/CSR 与水合确定性契约，且同一
 * Pod 在刷新前后动画相位跳变；黄金角序列均匀铺开相位（相邻实例差 ≈137.5°），
 * 呼吸/抖动/脉动彼此错开无机械同步感，同时完全可复现（E2E 可断言）。
 */
const POD_PHASES: readonly number[] = (() => {
  const phases: number[] = [];
  for (let i = 0; i < MAX_PODS; i++) {
    phases.push((i * 2.399963229728653) % (Math.PI * 2));
  }
  return phases;
})();

/**
 * resolvePodTargetColor —— 状态 → 基础目标色映射（纯函数，返回模块级只读常量）。
 *
 * 【穷举保证】switch 覆盖 PodStatus 全部五态，TS 编译期强制新增状态必须补分支；
 * 明暗脉动/发光增强等时变调制在 useFrame 内以 multiplyScalar 叠加，
 * 本函数只负责「离散选色」，职责单一。
 */
function resolvePodTargetColor(status: PodStatus): THREE.Color {
  switch (status) {
    case 'Running':
      return COLOR_RUNNING;
    case 'Pending':
    case 'Terminating':
      return COLOR_PENDING;
    case 'CrashLoopBackOff':
    case 'OOMKilled':
      return COLOR_CRASH;
  }
}

/* ========================================================================== */
/* PodInstancedMesh 主体                                                       */
/* ========================================================================== */

/**
 * PodInstancedMesh —— 全集群 Pod 单 Draw Call 实例化渲染器。
 *
 * 【数据流】telemetryTransientRef（轨道一瞬态池）→ useFrame 逐帧读取
 * snapshot.pods[i].status（离散态）与 podCpuFloat32[i]（连续负载，
 * 1Hz 快照同步 + 本组件插值调制）→ 实例矩阵/实例色原地突变。
 * statusFilter 是唯一的响应轨输入：细粒度 selector 订阅（低频重渲染）
 * + ref 镜像喂给 useFrame，渲染循环内零 zustand 访问（.cursorrules 双轨纪律）。
 */
export default function PodInstancedMesh() {
  /* ---- 响应轨细粒度订阅（仅过滤器一个字段）+ ref 镜像 ---- */
  const statusFilter = useClusterStore((s): StatusFilter => s.statusFilter);
  const statusFilterRef = useRef<StatusFilter>(statusFilter);
  useEffect(() => {
    statusFilterRef.current = statusFilter;
  }, [statusFilter]);

  /* ---- 选中动作（点击 Pod → 相机特写聚焦的唯一写入口） ---- */
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );

  /**
   * 悬停实例下标（null = 无悬停）。
   *
   * 【防抖契约】onPointerMove 在指针停留于同一 Pod 期间会以指针事件频率
   * （≈60Hz）连续触发，但 handler 内先比对 e.instanceId !== hoveredInstanceId
   * 才 setState——同一 Pod 上的移动零 setState、零重渲染，只有跨 Pod 边界
   * 的瞬间产生一次状态迁移。这是「精准且不掉帧」的核心手段。
   */
  const [hoveredInstanceId, setHoveredInstanceId] = useState<number | null>(null);

  /**
   * 悬停标签视图模型（低频派生：仅 hoveredInstanceId 或 1Hz 快照变更时重算）。
   *
   * 【数据源选择】刻意取响应轨 snapshotSummary 而非瞬态池：瞬态池的 mutation
   * 不触发 React 更新，标签若从瞬态池取值将永远停留在挂载时的读数；
   * 响应轨快照以 1Hz 整体替换，恰好为标签提供「实时 CPU/MEM%」的刷新节拍，
   * 且与 3D 实例渲染（瞬态池 60FPS）在视觉上同源同值。
   * shallow 比较器保证字段全等时复用旧对象引用，避免无谓重渲染。
   */
  const hoverLabelData = useClusterStore(
    (s: ClusterState): PodHoverLabelData | null => {
      if (hoveredInstanceId === null) return null;
      const pod = s.snapshotSummary.pods[hoveredInstanceId];
      if (pod === undefined) return null;
      return {
        name: pod.name,
        status: pod.status,
        cpuUsage: pod.cpuUsage,
        memoryUsage: pod.memoryUsage,
        rackIndex: pod.rackIndex,
        slotIndex: pod.slotIndex,
      };
    },
    shallow,
  );

  /**
   * 悬停标签的世界坐标（SLOT_POSES 查表，与实例渲染位姿严格同源）。
   * 取槽位中心 + 落座偏移 + 标签抬升量，使标签恒悬于 Pod 正上方的层间空档。
   * useMemo 依赖 label 数据，仅跨 Pod 移动或快照刷新时重算。
   */
  const hoverLabelPosition = useMemo((): [number, number, number] | null => {
    if (hoverLabelData === null) return null;
    const rackIdx = ((hoverLabelData.rackIndex % RACK_COUNT) + RACK_COUNT) % RACK_COUNT;
    const slotIdx =
      ((Math.floor(hoverLabelData.slotIndex) % SLOTS_PER_RACK) + SLOTS_PER_RACK) % SLOTS_PER_RACK;
    const pose = SLOT_POSES[rackIdx * SLOTS_PER_RACK + slotIdx];
    return [
      pose.position[0],
      pose.position[1] + POD_SEAT_OFFSET_Y + HOVER_LABEL_OFFSET_Y,
      pose.position[2],
    ];
  }, [hoverLabelData]);

  /* 悬停光标：Canvas 覆盖全视口，body 样式是唯一可靠通道（与机架模型同一手法） */
  useEffect(() => {
    if (hoveredInstanceId === null) return undefined;
    const previous = document.body.style.cursor;
    document.body.style.cursor = 'pointer';
    return (): void => {
      document.body.style.cursor = previous;
    };
  }, [hoveredInstanceId]);

  /**
   * handlePointerMove —— 悬停实例追踪（instanceId 变化才 setState）。
   *
   * 【instanceId 语义】R3F 对 InstancedMesh 的射线命中回填 e.instanceId
   * 为实例下标（0-based），直接对应 snapshot.pods[i]，无需 id 查表遍历。
   * 防御性校验：instanceId 越界（undefined 或 ≥ count，例如 count 收窄后
   * 的残留命中）时按「无悬停」处理，避免标签读取到占位实例。
   */
  const handlePointerMove = useCallback((event: ThreeEvent<PointerEvent>): void => {
    const instanceId = event.instanceId;
    const count = telemetryTransientRef.snapshot.pods.length;
    if (instanceId === undefined || instanceId < 0 || instanceId >= count) {
      return;
    }
    setHoveredInstanceId((previous): number | null =>
      previous === instanceId ? previous : instanceId,
    );
  }, []);

  /** handlePointerOut —— 离开实例群即清除悬停（标签与光标同步撤除） */
  const handlePointerOut = useCallback((): void => {
    setHoveredInstanceId((previous): number | null => (previous === null ? previous : null));
  }, []);

  /**
   * handleClick —— 点击 Pod 触发相机特写聚焦。
   *
   * stopPropagation 阻断命中链继续传播（装甲内壁、地面 Grid 等更远的命中
   * 对象不再收到事件），防止一次点击既选中 Pod 又误触发 onPointerMissed
   * 取消选中。选中后 CameraRig 以 getPodWorldTransform().cameraPosition
   * 飞行至该 Pod 的特写机位（与本渲染器同一空间事实源）。
   */
  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>): void => {
      const instanceId = event.instanceId;
      const pods = telemetryTransientRef.snapshot.pods;
      if (instanceId === undefined || instanceId < 0 || instanceId >= pods.length) {
        return;
      }
      event.stopPropagation();
      selectEntity(pods[instanceId].id, 'pod');
    },
    [selectEntity],
  );

  /* ---- 渲染对象与动画通道 ref ---- */
  const meshRef = useRef<THREE.InstancedMesh>(null);

  /**
   * 预分配临时对象（AGENTS.md 第 3 条：useFrame 内禁止 new THREE.*）。
   * useMemo 空依赖 → 组件生命周期内仅分配一次，每帧原地复用：
   * - tempObject：矩阵复合载体（position/rotation/scale → updateMatrix）
   * - tempColor：实例当前色（getColorAt 接收器 + lerp 原地渐变 + setColorAt 回写）
   * - tempTargetColor：本帧目标色（基础色 copy + 时变调制 multiplyScalar）
   */
  const tempObject = useMemo((): THREE.Object3D => new THREE.Object3D(), []);
  const tempColor = useMemo((): THREE.Color => new THREE.Color(), []);
  const tempTargetColor = useMemo((): THREE.Color => new THREE.Color(), []);

  /**
   * 每实例过滤缩放状态缓冲（Float32Array(48)，初始 1）。
   * 缩放是跨帧连续量（lerp 平滑），必须以持久缓冲保存「当前值」，
   * 与颜色的持久化思路一致（instanceColor 缓冲即颜色当前值）。
   * 命名不带 Ref 后缀：它是 useMemo 分配的裸 TypedArray（非 useRef 容器），
   * 直接下标读写，避免 .current 误用。
   */
  const filterScaleBuffer = useMemo((): Float32Array => new Float32Array(MAX_PODS).fill(1), []);

  /**
   * 挂载初始化：写入全部 48 个实例的矩阵（槽位查表 + 落座偏移）与白色实例色。
   *
   * 【核心目的】setColorAt 触发 three 底层惰性创建 instanceColor
   * InstancedBufferAttribute（48×3 float 缓冲）——没有它，后续 getColorAt/
   * setColorAt 与 instanceColor.needsUpdate 全部失效（AGENTS.md 第 7 条：
   * 动态着色前必须确保 instanceColor 缓冲存在）。矩阵按 SLOT_POSES 占位，
   * 首帧 useFrame 即按真实 Pod 数据覆写；mesh.count 同步收窄到实际 Pod 数，
   * 占位实例永不进入绘制。
   */
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;

    tempColor.set('#ffffff');
    for (let i = 0; i < MAX_PODS; i++) {
      const pose = SLOT_POSES[i];
      tempObject.position.set(
        pose.position[0],
        pose.position[1] + POD_SEAT_OFFSET_Y,
        pose.position[2],
      );
      tempObject.rotation.set(0, pose.rotationY, 0);
      tempObject.scale.setScalar(1);
      tempObject.updateMatrix();
      mesh.setMatrixAt(i, tempObject.matrix);
      mesh.setColorAt(i, tempColor);
    }
    mesh.count = Math.min(telemetryTransientRef.snapshot.pods.length, MAX_PODS);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [tempColor, tempObject]);

  /**
   * useFrame —— 实时态势驱动渲染循环（零分配 / 零 setState / 零 zustand 访问）。
   *
   * 【核心数学与状态流转】（AGENTS.md 第 8 条中文原理注释契约）
   * 对每个在绘实例 i（0 ≤ i < mesh.count）：
   *
   * 1. 位姿查表：rackIdx/slotIdx 归约（模 3 / 模 16，与 getPodWorldTransform
   *    的容错归约同构）→ SLOT_POSES[rack*16+slot] 取世界坐标与朝向；
   *    y 叠加落座偏移 −0.27 使盒底精确落在隔板顶面（零穿模）。
   *
   * 2. 状态调制（离散分支 → 连续参数）：
   *    - Running：负载归一化 c = cpu/100；
   *      悬浮 Δy = (0.02 + 0.04c)·sin(t·(1.6 + 0.8c) + φ_i)（忙容器呼吸更急更高）；
   *      高度 s_y = 1 + 0.10c + 0.02·sin(2t + φ_i)（负载越高容器「越鼓」）；
   *    - Pending/Terminating：几何静止，颜色做缓慢明暗脉动
   *      target ×= 0.72 + 0.28·(0.5 + 0.5·sin(2.4t + φ_i))（琥珀呼吸灯语义）；
   *    - CrashLoopBackOff/OOMKilled：target = 红 ×1.5（分量 >1 过曝辉光）；
   *      水平抖动 Δx = 0.04·sin(35t + φ_i)（契约公式，相位错开）；
   *      尺寸脉冲 s = 1 + 0.25·sin(14t + φ_i)（剧烈收缩膨胀，告警动感）。
   *
   * 3. 过滤聚焦：statusFilter ≠ 'ALL' 且状态不匹配 → 目标缩放 0.15，
   *    当前值以 k=8 指数阻尼 lerp 平滑逼近（filterScaleBuffer 持久缓冲）；
   *    最终缩放 = 状态脉冲 × 过滤系数（三轴同乘，缩小态保持姿态）。
   *
   * 4. 颜色渐变：getColorAt 读当前实例色 → 向目标色 lerp（k=6 帧率无关
   *    指数阻尼 α = 1 − e^(−k·Δt)，Δt 钳 0.1s）→ setColorAt 回写；
   *    instanceColor 缓冲自身即「当前值」持久态，无需额外数组。
   *
   * 5. 提交：tempObject.updateMatrix() 复合 TRS → setMatrixAt；
   *    帧末显式 instanceMatrix.needsUpdate = true 与
   *    instanceColor.needsUpdate = true（AGENTS.md 第 7 条强制契约，
   *    缺任一 GPU 侧将继续绘制上一帧的陈旧缓冲）。
   */
  useFrame((state, delta): void => {
    const mesh = meshRef.current;
    if (mesh === null) return;

    const pods = telemetryTransientRef.snapshot.pods;
    const count = pods.length <= MAX_PODS ? pods.length : MAX_PODS;

    /* 绘制数量命令式驱动（容量恒定 48，count 变化零重建） */
    if (mesh.count !== count) {
      mesh.count = count;
    }
    if (count === 0) return;

    /* 防御性兜底：instanceColor 缓冲缺失时立即补建（正常路径由挂载 effect 创建） */
    if (mesh.instanceColor === null) {
      mesh.setColorAt(0, tempColor.set('#ffffff'));
    }

    const t = state.clock.getElapsedTime();
    const dt = Math.min(delta, MAX_FRAME_DELTA);
    const colorAlpha = 1 - Math.exp(-COLOR_LERP_RATE * dt);
    const scaleAlpha = 1 - Math.exp(-FILTER_SCALE_LERP_RATE * dt);
    const filter = statusFilterRef.current;
    const cpuArray = telemetryTransientRef.podCpuFloat32;

    for (let i = 0; i < count; i++) {
      const pod = pods[i];

      /* ---- 1. 槽位查表（归约与 getPodWorldTransform 同构） ---- */
      const rackIdx = ((pod.rackIndex % RACK_COUNT) + RACK_COUNT) % RACK_COUNT;
      const slotIdx =
        ((Math.floor(pod.slotIndex) % SLOTS_PER_RACK) + SLOTS_PER_RACK) % SLOTS_PER_RACK;
      const pose = SLOT_POSES[rackIdx * SLOTS_PER_RACK + slotIdx];
      const phase = POD_PHASES[i];

      /* ---- 2. 状态调制：几何位移/缩放 + 目标色 ---- */
      let posX = pose.position[0];
      let posY = pose.position[1] + POD_SEAT_OFFSET_Y;
      let posZ = pose.position[2];
      let scaleX = 1;
      let scaleY = 1;
      let scaleZ = 1;

      tempTargetColor.copy(resolvePodTargetColor(pod.status));

      switch (pod.status) {
        case 'Running': {
          // 负载归一化（NaN 防御：瞬态池同步层已拦截，此处二道保险）
          const cpuRaw = cpuArray[i];
          const c = Number.isNaN(cpuRaw) ? 0 : Math.min(1, Math.max(0, cpuRaw / 100));
          // 悬浮呼吸：振幅与频率均随负载上浮
          posY +=
            (RUN_HOVER_BASE + RUN_HOVER_LOAD_GAIN * c) *
            Math.sin(t * (RUN_HOVER_RATE_BASE + RUN_HOVER_RATE_GAIN * c) + phase);
          // 高度微调：负载鼓胀 + 轻微正弦呼吸
          scaleY = 1 + RUN_HEIGHT_LOAD_GAIN * c + RUN_HEIGHT_BREATH * Math.sin(t * 2 + phase);
          break;
        }
        case 'Pending':
        case 'Terminating': {
          // 缓慢明暗脉动：亮度包络 [0.72, 1.0] 正弦往复（几何静止）
          const pulse =
            PENDING_PULSE_MIN +
            (1 - PENDING_PULSE_MIN) * (0.5 + 0.5 * Math.sin(t * PENDING_PULSE_RATE + phase));
          tempTargetColor.multiplyScalar(pulse);
          break;
        }
        case 'CrashLoopBackOff':
        case 'OOMKilled': {
          // 高亮鲜红：×1.5 过曝增强发光感（契约指定调用）
          tempTargetColor.multiplyScalar(CRASH_GLOW_BOOST);
          // 高频正弦水平抖动（契约公式 Δx = 0.04·sin(35t)，逐实例错相）
          posX += CRASH_JITTER_AMPLITUDE * Math.sin(CRASH_JITTER_RATE * t + phase);
          // 剧烈尺寸脉冲（±25%，三轴均匀）
          const pulse = 1 + CRASH_PULSE_AMPLITUDE * Math.sin(t * CRASH_PULSE_RATE + phase);
          scaleX = pulse;
          scaleY = pulse;
          scaleZ = pulse;
          break;
        }
      }

      /* ---- 3. 过滤聚焦：不匹配实例平滑缩小至 0.15 ---- */
      const matchesFilter = filter === 'ALL' || pod.status === filter;
      const filterTarget = matchesFilter ? 1 : FILTER_DIM_SCALE;
      const currentFilterScale =
        filterScaleBuffer[i] + (filterTarget - filterScaleBuffer[i]) * scaleAlpha;
      filterScaleBuffer[i] = currentFilterScale;
      scaleX *= currentFilterScale;
      scaleY *= currentFilterScale;
      scaleZ *= currentFilterScale;

      /* ---- 4. 矩阵复合提交（TRS → instanceMatrix） ---- */
      tempObject.position.set(posX, posY, posZ);
      tempObject.rotation.set(0, pose.rotationY, 0);
      tempObject.scale.set(scaleX, scaleY, scaleZ);
      tempObject.updateMatrix();
      mesh.setMatrixAt(i, tempObject.matrix);

      /* ---- 5. 颜色平滑渐变（instanceColor 缓冲即当前值持久态） ---- */
      mesh.getColorAt(i, tempColor);
      tempColor.lerp(tempTargetColor, colorAlpha);
      mesh.setColorAt(i, tempColor);
    }

    /* ---- 6. GPU 缓冲提交（AGENTS.md 第 7 条强制契约） ---- */
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh
        ref={meshRef}
      /* 容量恒为 MAX_PODS（args 变化 = 整 mesh 重建灾难，见文件头容量契约）；
         实际绘制数由 useFrame 经 mesh.count 命令式收窄 */
      args={[undefined, undefined, MAX_PODS]}
      /* 实例散布全场景（三机架半径 9.5），而 InstancedMesh 的包围球默认
         按几何体原点计算——不关闭视锥剔除会被整群错误剔除（集体消失）。
         48 实例的绘制成本可忽略，剔除收益为负，故显式禁用。 */
      frustumCulled={false}
      /* ---- 指针交互三件套（精准且不掉帧，见文件头交互契约） ----
         R3F 对 InstancedMesh 的命中回填 e.instanceId（实例下标），
         move 只在跨实例边界时 setState；out 清空悬停；click 选中触发
         CameraRig 特写飞行。命中链上游的 WorkerRack3D 按「Pod 命中
         让位协议」放行，本层 stopPropagation 即可独占事件。 */
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
      onClick={handleClick}
    >
      {/* 契约几何：0.52 × 0.38 × 0.52 容器盒 */}
      <boxGeometry args={[POD_BOX_SIZE[0], POD_BOX_SIZE[1], POD_BOX_SIZE[2]]} />
      {/* AGENTS.md 第 7 条：动态实例着色的基础材质 color 必须 #ffffff
          （实例色与材质色相乘，白基色保证 instanceColor 原样呈现）
          且 toneMapped={false}（状态色绕过色调映射，红/绿/琥珀保持语义纯度） */}
      <meshStandardMaterial color="#ffffff" roughness={0.2} metalness={0.5} toneMapped={false} />
      </instancedMesh>

      {/* ---- 悬停微型标签（单个 <Html>，仅悬停实例存在时挂载） ----
          【契约】center + distanceFactor=12 + zIndexRange=[10,0] +
          pointer-events-none（AGENTS.md 第 6 条：严禁遮挡抽屉/Modal，
          且不拦截射线——标签若吃指针事件会造成「悬停标签挡住下一个
          Pod 命中」的拾取抖动）。位置查表 SLOT_POSES 与实例渲染同源。 */}
      {hoverLabelData !== null && hoverLabelPosition !== null ? (
        <Html
          position={hoverLabelPosition}
          center
          distanceFactor={12}
          zIndexRange={[10, 0]}
          className="pointer-events-none"
        >
          <div className="pointer-events-none flex flex-col gap-1 rounded border border-slate-700/80 bg-slate-950/90 px-2 py-1.5 shadow-panel backdrop-blur-sm">
            {/* Pod 名称 */}
            <span className="max-w-[180px] truncate font-mono text-[10px] font-bold tracking-wide text-slate-100">
              {hoverLabelData.name}
            </span>
            {/* 状态徽标：圆点 + 状态文案（crash 态附加脉冲动画） */}
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  POD_STATUS_BADGE[hoverLabelData.status].extraClass,
                )}
                style={{ backgroundColor: POD_STATUS_BADGE[hoverLabelData.status].color }}
              />
              <span
                className={cn(
                  'font-mono text-[10px] uppercase tracking-widest',
                  POD_STATUS_BADGE[hoverLabelData.status].extraClass,
                )}
                style={{ color: POD_STATUS_BADGE[hoverLabelData.status].color }}
              >
                {POD_STATUS_BADGE[hoverLabelData.status].label}
              </span>
            </span>
            {/* 实时 CPU / MEM 百分比（响应轨 1Hz 刷新，tabular-nums 防抖动） */}
            <span className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-slate-400">
              <span>
                CPU <span className="text-slate-200">{hoverLabelData.cpuUsage}%</span>
              </span>
              <span className="text-slate-700">|</span>
              <span>
                MEM <span className="text-slate-200">{hoverLabelData.memoryUsage}%</span>
              </span>
            </span>
          </div>
        </Html>
      ) : null}
    </>
  );
}
