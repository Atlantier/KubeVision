'use client';

/**
 * KubeVision AI — 计算节点机架程序化 3D 模型（WorkerRack3D）
 *
 * 【设计意图】单个 Worker 节点机架的纯程序化建模：零 .glb 外部资产，
 * 全部由原生 Three.js 几何体/材质组合（AGENTS.md 交付契约）。根 group 位姿
 * 直接由 getRackTransform(node.rackIndex) 解算——与 Pod 槽位坐标、相机机位
 * 共用 spatialLayout 单一事实源，保证「机架外壳、内部 Pod、观察相机」三者
 * 空间关系永不漂移。
 *
 * 【几何构成】
 * 1. 半透明磨砂装甲外框：meshStandardMaterial（transparent + 高 roughness）
 *    叠加 drei <Edges> 棱线，冷冽的金属机柜质感；
 * 2. 4 层水平服务器托盘隔板：Y 坐标 = RACK_TIER_BASE_Y + i·RACK_TIER_HEIGHT，
 *    与 getPodWorldTransform 的 Pod 槽位层位严格同源（下一轮 Pod 实例正好落在隔板上）；
 * 3. 两侧垂直霓虹导光柱：meshBasicMaterial（toneMapped=false 纯霓虹），
 *    useFrame 中按节点状态/负载在翠绿→琥珀→警示红间**平滑变色**；
 * 4. 顶部全息铭牌：drei <Html> 显示节点名 + 实时 CPU/MEM 百分比
 *    （zIndexRange=[10,0] + pointer-events-none 契约）。
 *
 * 【60FPS 红线合规 · 平滑变色核心】（AGENTS.md 第 3 条）
 * - 三色常量（COLOR_HEALTHY/WARNING/CRITICAL）与选中色在**模块级一次性预分配**，
 *   useFrame 内仅做 `material.color.lerp(targetConst, α)`——原地突变、零 new THREE.Color；
 * - lerp 的 target 是只读共享常量，多个机架实例并发 lerp 互不干扰；
 * - 帧率无关阻尼 α = 1 − e^(−k·Δt)，Δt 钳制 0.1s（掉帧不突变）；
 * - 最新 node 数据经 nodeRef 喂入渲染循环（useEffect 1Hz 刷新），
 *   useFrame 零 setState / 零 React 重渲染，变色动画与遥测频率解耦。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Edges, Html, type EdgesRef } from '@react-three/drei';
import * as THREE from 'three';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import {
  RACK_BODY_CENTER_Y,
  RACK_BODY_SIZE,
  RACK_LIGHT_GUIDE_X,
  RACK_TIER_BASE_Y,
  RACK_TIER_COUNT,
  RACK_TIER_HEIGHT,
  getRackTransform,
} from '@/utils/spatialLayout';
import type { NodeStatus } from '@/types/cluster';
import type { WorkerRack3DProps } from '@/types/canvas';
import type { SelectedEntityType } from '@/types/store';

/* ========================================================================== */
/* 模块级预分配常量（useFrame 热路径零 GC 的关键）                                */
/* ========================================================================== */

/** 导光柱三态目标色（模块级单例，useFrame 内只读，color.lerp 的 target） */
const COLOR_HEALTHY = new THREE.Color('#10b981'); // 翠绿：Ready 正常态
const COLOR_WARNING = new THREE.Color('#f59e0b'); // 琥珀：HighLoad 高负载
const COLOR_CRITICAL = new THREE.Color('#f43f5e'); // 警示红：NetworkPartition 分区/崩溃
const COLOR_SELECTED = new THREE.Color('#22d3ee'); // 主题青：选中态覆盖色

/** 高负载判定阈值（%）：CPU 或 MEM 越限即转琥珀，即使 status 仍为 Ready */
const HIGH_LOAD_THRESHOLD = 85;

/** 变色阻尼率 k（1/秒）：≈0.3s 完成 63% 色彩过渡，平滑而不迟滞 */
const COLOR_LERP_RATE = 3.5;

/** 单帧 Δt 钳制上限（秒）：掉帧时限制变色步长，防颜色跳变 */
const MAX_FRAME_DELTA = 0.1;

/** 警示红呼吸脉冲参数（NetworkPartition 时导光柱透明度脉动，告警呼吸感） */
const CRITICAL_PULSE_RATE = 4.0;
const CRITICAL_PULSE_MIN = 0.55;
const CRITICAL_PULSE_MAX = 1.0;

/** 导光柱常态透明度 */
const GUIDE_BASE_OPACITY = 0.95;

/* ========================================================================== */
/* 装甲线框（Edges）描边参数                                                     */
/* ========================================================================== */

/**
 * 装甲棱线常态色（深空板岩蓝）与选中/hover 态目标色（主题青）。
 *
 * 【单一来源】COLOR_SELECTED 与导光柱选中色共用同一模块级 Color 常量——
 * 「选中即青色」的语义在机架的两处发光元素上保持绝对一致，且 useFrame 内
 * 只做只读引用 + lerp 原地突变，零 Color 分配（AGENTS.md 第 3 条）。
 */
const COLOR_EDGE_IDLE = new THREE.Color('#1e3a5f');

/** 棱线常态透明度（低对比，仅作机柜轮廓提示） */
const EDGE_IDLE_OPACITY = 0.4;

/** 棱线 hover 透明度（未选中但指针悬停时的中间态） */
const EDGE_HOVER_OPACITY = 0.72;

/** 装甲体 hover/选中时的不透明度（磨砂玻璃增亮，与棱线同步强调） */
const ARMOR_OPACITY_IDLE = 0.16;
const ARMOR_OPACITY_EMPHASIZED = 0.3;

/**
 * 选中态呼吸描边参数（青色高亮 + 正弦脉动）。
 *
 * 【视觉推导】opacity 在 [0.62, 1.0] 间以 2.8 rad/s（≈2.24 秒/次）正弦呼吸，
 * linewidth 同步在 [1.6, 3.4] px 间脉动——fat-line 的像素级线宽随呼吸增粗，
 * 形成「装甲轮廓被能量充盈」的高亮描边观感；呼吸频率刻意慢于导光柱的
 * 告警脉冲（4.0 rad/s），二者在视觉上可区分：慢呼吸 = 已选中的稳定强调，
 * 快脉冲 = 分区故障的紧急告警。
 */
const EDGE_BREATH_RATE = 2.8;
const EDGE_BREATH_OPACITY_MIN = 0.62;
const EDGE_BREATH_OPACITY_MAX = 1.0;
const EDGE_BREATH_WIDTH_MIN = 1.6;
const EDGE_BREATH_WIDTH_MAX = 3.4;

/** 棱线常态线宽（px，fat-line 屏幕空间宽度） */
const EDGE_IDLE_WIDTH = 1.0;

/** 节点状态 → 铭牌文字色（与导光柱色语义一致，HTML 层用 HEX 字符串） */
const STATUS_TEXT_COLOR: Readonly<Record<NodeStatus, string>> = {
  Ready: '#10b981',
  HighLoad: '#f59e0b',
  NetworkPartition: '#f43f5e',
};

/** 隔板相对 Pod 槽位中心的下移量（精确推导：Pod 半高 0.46 + 隔板半厚 0.0275 = 0.4875） */
const TIER_DIVIDER_OFFSET = 0.4875;

/**
 * 4 层托盘隔板的局部 Y 坐标（渲染期一次求值，与 Pod 槽位层位严格同源）。
 *
 * 【几何推导】Pod 槽位中心 y_t = RACK_TIER_BASE_Y + t·RACK_TIER_HEIGHT，
 * Pod 盒高 POD_BOX_HEIGHT = 0.92 → Pod 底面 = y_t − 0.46。
 * 隔板是「Pod 坐落的层板」，故隔板顶面必须恰在 Pod 底面之下：
 *   隔板中心 = y_t − 0.46 − 隔板半厚(0.0275) = y_t − 0.4875（精确值，
 *   任何取整都会让 Pod 陷入或悬空，运行期几何回归断言逐层校验 gap ∈ [0, 0.03)）。
 * 逐层验证：t=0 → 0.0625、t=3 → 3.2125，均落在机柜内且互不重叠；
 * 下一轮 Pod InstancedMesh 按同一公式摆放时正好立于隔板之上，零穿插。
 */
const TIER_DIVIDER_YS: readonly number[] = Array.from(
  { length: RACK_TIER_COUNT },
  (_, i): number => RACK_TIER_BASE_Y + i * RACK_TIER_HEIGHT - TIER_DIVIDER_OFFSET,
);

/**
 * 底座底板厚度与中心高度。
 *
 * 【取值依据】tier-0 隔板中心在 y=0.0625、底面在 y=0.035，故底板顶面必须
 * ≤ 0.035 才不吞没隔板——取厚度 0.03（中心 0.015，顶面 0.03），
 * 隔板恰好「坐」在底板之上并留 0.005 间隙，视觉上是层板承于机柜地板，零几何穿插。
 */
const BASE_PLATE_HEIGHT = 0.03;
const BASE_PLATE_CENTER_Y = BASE_PLATE_HEIGHT / 2;

/** 导光柱局部 Z（机架正面内侧，正面朝世界中心，观察侧可见） */
const LIGHT_GUIDE_Z = RACK_BODY_SIZE[2] / 2 - 0.1;

/** 导光柱几何：细长竖直方柱（高度略短于机柜，留出顶盖与底座） */
const LIGHT_GUIDE_HEIGHT = RACK_BODY_SIZE[1] - 0.5;

/**
 * isPodHitInRack —— 判定一次射线命中链中是否包含「指定机架名下」的 Pod 实例。
 *
 * 【Pod 命中让位协议 · 判定核心】（AGENTS.md 第 6 条射线安全的延伸）
 * R3F 的 ThreeEvent.intersections 携带本次指针事件的**完整命中列表**
 * （按距离升序）。其中 instanceId 字段仅 InstancedMesh 命中才会出现——
 * 本项目唯一的 InstancedMesh 即 PodInstancedMesh，故「命中项带 instanceId」
 * 等价于「射线穿过了某个 Pod 实例」，无需 instanceof / 类型断言即可判别。
 *
 * 【归属校验】进一步以瞬态池快照核对 pods[instanceId].nodeId === rackNodeId：
 * 只有命中**本机架腔体内**的 Pod 才让位。若不加此校验，点击本机架装甲缝隙
 * 时视线深处另一机架的 Pod 也在 intersections 里，会导致本机架被错误跳过
 * （用户明明点的是装甲却选中了远处 Pod）。归属校验把让位范围精确限定在
 * 「Pod 确实位于本机架内」的几何事实上。
 *
 * @param event       R3F 指针/鼠标事件（读取其 intersections 命中列表）
 * @param rackNodeId  本机架节点 ID（WorkerNodeEntity.id）
 * @returns 命中链中存在本机架名下 Pod 实例时返回 true（应让位）
 */
function isPodHitInRack(
  event: ThreeEvent<MouseEvent> | ThreeEvent<PointerEvent>,
  rackNodeId: string,
): boolean {
  const pods = telemetryTransientRef.snapshot.pods;
  for (const hit of event.intersections) {
    const instanceId = hit.instanceId;
    if (instanceId === undefined) continue;
    const pod = pods[instanceId];
    if (pod !== undefined && pod.nodeId === rackNodeId) return true;
  }
  return false;
}

/* ========================================================================== */
/* WorkerRack3D 主体                                                           */
/* ========================================================================== */

/**
 * WorkerRack3D —— 单机架程序化模型（接收完整 WorkerNodeEntity，纯展示层）。
 *
 * 【订阅纪律】仅订阅 selectedEntityId（低频）驱动选中高亮；节点遥测经 props
 * 传入（父级 ClusterCanvas 1Hz 细粒度订阅），导光柱变色与装甲呼吸描边走
 * useFrame ref 通道，与 React 渲染完全解耦。
 *
 * 【指针事件契约】装甲外框、底座底板、顶盖三处「结构件」各自挂载显式
 * onClick（stopPropagation + selectEntity），保证点击机柜任意金属部位都能选中；
 * 隔板/导光柱等内部件经事件冒泡由根 group 的 onClick 兜底。stopPropagation
 * 阻断 R3F 射线命中链上更远的对象（如背后的另一机架），杜绝一次点击多选。
 *
 * 【棱线 ref 类型】采用 drei 官方导出的 EdgesRef（内部即 three-stdlib 的
 * LineSegments2 + LineMaterial），不自造结构化类型也不深链 three-stdlib
 * （后者未被提升到根 node_modules，pnpm 隔离树下直接 import 是脆弱依赖）。
 */
export default function WorkerRack3D({ node }: WorkerRack3DProps) {
  /* ---- Store 细粒度订阅 ---- */
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );

  /* ---- 交互态（低频 UI 事件，允许 useState） ---- */
  const [hovered, setHovered] = useState<boolean>(false);

  /* ---- 动画通道 ref ---- */
  const leftGuideMat = useRef<THREE.MeshBasicMaterial>(null);
  const rightGuideMat = useRef<THREE.MeshBasicMaterial>(null);
  /** 装甲棱线（drei Edges，官方 EdgesRef 类型）ref：useFrame 驱动选中态呼吸描边 */
  const armorEdgesRef = useRef<EdgesRef | null>(null);
  /** 最新 node 快照引用：useFrame 读取，避免把 node 塞进渲染循环依赖 */
  const nodeRef = useRef<WorkerRack3DProps['node']>(node);

  /* node props 变更（1Hz）时刷新 ref；useFrame 恒读最新值，零重订阅 */
  useEffect(() => {
    nodeRef.current = node;
  }, [node]);

  /* 机架世界位姿：与 Pod 槽位/相机机位同源（spatialLayout 单一事实源） */
  const rackTransform = useMemo(() => getRackTransform(node.rackIndex), [node.rackIndex]);

  const isSelected = selectedEntityId === node.id;
  const emphasized = isSelected || hovered;

  /* hover 光标：Canvas 覆盖全视口，body 样式是唯一可靠通道 */
  useEffect(() => {
    if (!hovered) return undefined;
    const previous = document.body.style.cursor;
    document.body.style.cursor = 'pointer';
    return (): void => {
      document.body.style.cursor = previous;
    };
  }, [hovered]);

  /**
   * handleSelect —— 机架选中统一入口（装甲框/底座/顶盖的显式 onClick 复用）。
   *
   * stopPropagation 阻断射线命中链继续向后传播：既防止一次点击同时选中
   * 前后两个重叠机架，也防止命中穿透到地面 Grid 触发 onPointerMissed 取消选中。
   *
   * 【Pod 命中让位协议】（见文件头指针事件契约）Pod 实例位于本机架装甲腔体
   * 内部，任何命中 Pod 的射线必先穿过更近的装甲面；R3F 按距离升序派发且
   * stopPropagation 会 break 整个命中循环——若此处无条件抢占，Pod 的 onClick
   * 将永远收不到事件。故先检查 event.intersections 中是否存在**本机架名下**
   * 的 Pod 实例命中（instanceId 仅 InstancedMesh 命中才有，且经 nodeId 归属
   * 校验，杜绝「点击本机架缝隙却误选远处机架 Pod」的跨机架错选）；命中则
   * 静默 return 放行，由 PodInstancedMesh 接管该次交互。
   */
  const handleSelect = useCallback(
    (event: ThreeEvent<MouseEvent>): void => {
      if (isPodHitInRack(event, node.id)) return;
      event.stopPropagation();
      selectEntity(node.id, 'node');
    },
    [node.id, selectEntity],
  );

  /**
   * useFrame —— 导光柱按状态/负载平滑变色（+ 分区态告警呼吸脉冲）
   *            + 装甲棱线选中态青色呼吸描边。
   *
   * 【核心流转 · 导光柱】
   * 1. 读 nodeRef.current 最新遥测；
   * 2. 离散选目标色：选中→青；NetworkPartition→红；
   *    HighLoad 或 CPU/MEM ≥ 85%→琥珀；否则→翠绿；
   * 3. 连续过渡：material.color.lerp(targetConst, α)，α = 1 − e^(−3.5·Δt)；
   * 4. 分区态叠加透明度脉冲（sin 呼吸），其余状态恒定 GUIDE_BASE_OPACITY。
   *
   * 【核心流转 · 装甲棱线呼吸描边】
   * 选中态：opacity 与 linewidth 以 2.8 rad/s 正弦脉动（[0.62,1.0] / [1.6,3.4]px），
   * 颜色锁定主题青——「高亮青色呼吸描边」的完整表达；
   * hover 未选中：棱线提亮到 0.72 恒定透明度（静态强调，不呼吸）；
   * 常态：深板岩蓝 0.4 透明度、1px 线宽（仅作轮廓提示）。
   * 三态切换均由 useFrame 独占驱动（React prop 不参与 opacity/linewidth），
   * 杜绝 1Hz 重渲染把动画值重置回 JSX 初始值造成的「呼吸跳变」。
   * 全程零 new、零 setState；target 为只读模块常量，多实例并发安全。
   */
  useFrame((state, delta): void => {
    const current = nodeRef.current;

    let target: THREE.Color;
    if (isSelected) {
      target = COLOR_SELECTED;
    } else if (current.status === 'NetworkPartition') {
      target = COLOR_CRITICAL;
    } else if (
      current.status === 'HighLoad' ||
      current.cpuUsage >= HIGH_LOAD_THRESHOLD ||
      current.memUsage >= HIGH_LOAD_THRESHOLD
    ) {
      target = COLOR_WARNING;
    } else {
      target = COLOR_HEALTHY;
    }

    const alpha = 1 - Math.exp(-COLOR_LERP_RATE * Math.min(delta, MAX_FRAME_DELTA));

    // 分区态告警呼吸脉冲；其余状态恒定透明度
    const opacity =
      current.status === 'NetworkPartition' && !isSelected
        ? CRITICAL_PULSE_MIN +
          (CRITICAL_PULSE_MAX - CRITICAL_PULSE_MIN) *
            (0.5 + 0.5 * Math.sin(state.clock.getElapsedTime() * CRITICAL_PULSE_RATE))
        : GUIDE_BASE_OPACITY;

    if (leftGuideMat.current !== null) {
      leftGuideMat.current.color.lerp(target, alpha);
      leftGuideMat.current.opacity = opacity;
    }
    if (rightGuideMat.current !== null) {
      rightGuideMat.current.color.lerp(target, alpha);
      rightGuideMat.current.opacity = opacity;
    }

    /* ---- 装甲棱线：选中态青色呼吸描边 / hover 静态提亮 / 常态低对比 ---- */
    const edges = armorEdgesRef.current;
    if (edges !== null) {
      const edgeMat = edges.material;
      if (isSelected) {
        // 正弦归一化到 [0,1] 后映射到透明度/线宽区间（慢呼吸 = 稳定选中强调）
        const breath = 0.5 + 0.5 * Math.sin(state.clock.getElapsedTime() * EDGE_BREATH_RATE);
        edgeMat.color.copy(COLOR_SELECTED);
        edgeMat.opacity = EDGE_BREATH_OPACITY_MIN + (EDGE_BREATH_OPACITY_MAX - EDGE_BREATH_OPACITY_MIN) * breath;
        edgeMat.linewidth = EDGE_BREATH_WIDTH_MIN + (EDGE_BREATH_WIDTH_MAX - EDGE_BREATH_WIDTH_MIN) * breath;
      } else {
        // 非选中：颜色平滑回归常态深蓝，透明度/线宽按 hover 与否二值切换
        edgeMat.color.lerp(COLOR_EDGE_IDLE, alpha);
        edgeMat.opacity = hovered ? EDGE_HOVER_OPACITY : EDGE_IDLE_OPACITY;
        edgeMat.linewidth = EDGE_IDLE_WIDTH;
      }
    }
  });

  const statusColor = STATUS_TEXT_COLOR[node.status];

  return (
    <group
      position={rackTransform.position}
      rotation={[0, rackTransform.rotationY, 0]}
      onClick={handleSelect}
      onPointerOver={(event): void => {
        // Pod 命中让位：本机架腔体内有 Pod 被命中时不抢占 hover——
        // onPointerOver 的 stopPropagation 会 break 距离升序派发链，
        // 阻断更远处 Pod 实例的 onPointerMove（悬停标签将永不出现）。
        // 在 stopPropagation 之前 return，localState.stopped 保持 false，
        // 派发继续抵达 PodInstancedMesh。
        if (isPodHitInRack(event, node.id)) return;
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(): void => setHovered(false)}
    >
      {/* ---- 半透明磨砂装甲外框（+ 棱线勾勒机柜轮廓；显式点击选中）。
         【Edges 控制权契约】color/opacity/linewidth 三个动画属性的初始值仅作
         首帧种子，此后由 useFrame 独占驱动（选中态青色呼吸 / hover 提亮 /
         常态低对比）；React prop 保持恒定字面量，1Hz 重渲染经 R3F props
         diff 不会重放，动画值零跳变。 ---- */}
      <mesh position={[0, RACK_BODY_CENTER_Y, 0]} onClick={handleSelect}>
        <boxGeometry args={[RACK_BODY_SIZE[0], RACK_BODY_SIZE[1], RACK_BODY_SIZE[2]]} />
        <meshStandardMaterial
          color="#0f172a"
          metalness={0.35}
          roughness={0.72}
          transparent
          opacity={emphasized ? ARMOR_OPACITY_EMPHASIZED : ARMOR_OPACITY_IDLE}
          emissive={isSelected ? '#22d3ee' : '#0e7490'}
          emissiveIntensity={isSelected ? 0.22 : emphasized ? 0.12 : 0.05}
        />
        <Edges
          ref={armorEdgesRef}
          color="#1e3a5f"
          transparent
          opacity={EDGE_IDLE_OPACITY}
          linewidth={EDGE_IDLE_WIDTH}
        />
      </mesh>

      {/* ---- 底座底板（薄承板：顶面 0.03 恰在 tier-0 隔板底面 0.035 之下，零穿插；
         显式点击选中——底座是用户点选机架的高频落点） ---- */}
      <mesh position={[0, BASE_PLATE_CENTER_Y, 0]} onClick={handleSelect}>
        <boxGeometry args={[RACK_BODY_SIZE[0] + 0.16, BASE_PLATE_HEIGHT, RACK_BODY_SIZE[2] + 0.16]} />
        <meshStandardMaterial color="#1e293b" metalness={0.7} roughness={0.35} />
      </mesh>

      {/* ---- 顶盖（层次细节 + 铭牌基座；显式点击选中——顶盖与铭牌同视线，
         是鸟瞰视角下最易命中的部位） ---- */}
      <mesh position={[0, RACK_BODY_SIZE[1] + 0.06, 0]} onClick={handleSelect}>
        <boxGeometry args={[RACK_BODY_SIZE[0] + 0.14, 0.12, RACK_BODY_SIZE[2] + 0.14]} />
        <meshStandardMaterial color="#1e293b" metalness={0.7} roughness={0.35} />
      </mesh>

      {/* ---- 4 层水平服务器托盘隔板（Y 坐标与 Pod 槽位层位同源，推导见常量 JSDoc） ---- */}
      {TIER_DIVIDER_YS.map((tierY, index): ReactNode => (
        <mesh key={index} position={[0, tierY, 0]}>
          <boxGeometry args={[RACK_BODY_SIZE[0] - 0.16, 0.055, RACK_BODY_SIZE[2] - 0.14]} />
          <meshStandardMaterial
            color="#1e293b"
            metalness={0.55}
            roughness={0.5}
            emissive="#0e7490"
            emissiveIntensity={0.06}
          />
        </mesh>
      ))}

      {/* ---- 两侧垂直霓虹导光柱（useFrame 平滑变色：翠绿/琥珀/警示红） ---- */}
      <mesh position={[-RACK_LIGHT_GUIDE_X, RACK_BODY_CENTER_Y, LIGHT_GUIDE_Z]}>
        <boxGeometry args={[0.11, LIGHT_GUIDE_HEIGHT, 0.11]} />
        <meshBasicMaterial
          ref={leftGuideMat}
          color="#10b981"
          toneMapped={false}
          transparent
          opacity={GUIDE_BASE_OPACITY}
        />
      </mesh>
      <mesh position={[RACK_LIGHT_GUIDE_X, RACK_BODY_CENTER_Y, LIGHT_GUIDE_Z]}>
        <boxGeometry args={[0.11, LIGHT_GUIDE_HEIGHT, 0.11]} />
        <meshBasicMaterial
          ref={rightGuideMat}
          color="#10b981"
          toneMapped={false}
          transparent
          opacity={GUIDE_BASE_OPACITY}
        />
      </mesh>

      {/* ---- 底座选中/hover 光环（青色辉光圆环贴地） ---- */}
      {emphasized ? (
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.9, 2.15, 48]} />
          <meshBasicMaterial
            color="#22d3ee"
            toneMapped={false}
            transparent
            opacity={isSelected ? 0.9 : 0.45}
            side={THREE.DoubleSide}
          />
        </mesh>
      ) : null}

      {/*
       * 铭牌：从"机柜顶部的三行大卡片"改为"贴地紧凑标签"（对标图二）。
       *
       * 【为何必须改】原位置 [0, RACK_BODY_SIZE[1] + 0.72, 0] = y 5.12，
       * 三行深色卡片正好横在拱形网络光缆的中段——实拍确认它把弧线切断了，
       * 是"画面杂乱"的主要来源之一（蓝图 §1.4）。
       *
       * 【新形态】贴地单行 `● worker-alpha`，数值仅在 hover/选中时展开。
       * 常态下只占一行极小面积，不侵入 3D 构图主体；需要数值时鼠标一放上去
       * 就展开，信息不丢失。
       */}
      <Html
        position={[0, 0.34, RACK_BODY_SIZE[2] / 2 + 0.35]}
        center
        distanceFactor={14}
        zIndexRange={[10, 0]}
        className="pointer-events-none"
      >
        <div
          className={cn(
            'flex items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-0.5 backdrop-blur-sm transition-colors',
            isSelected || hovered
              ? 'border-cyan-400/70 bg-slate-950/90'
              : 'border-slate-700/50 bg-slate-950/70',
          )}
        >
          {/* 状态圆点：常态下唯一的色彩信号，一眼扫过即可判断健康度 */}
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: statusColor }} />
          <span className="font-mono text-[10px] font-bold tracking-wide text-slate-200">{node.name}</span>
          {/* 数值仅在交互态展开，避免常态遮挡画面 */}
          {isSelected || hovered ? (
            <>
              <span className="font-mono text-[10px] tabular-nums" style={{ color: statusColor }}>
                CPU {node.cpuUsage}%
              </span>
              <span className="font-mono text-[10px] tabular-nums text-slate-500">MEM {node.memUsage}%</span>
            </>
          ) : null}
        </div>
      </Html>
    </group>
  );
}
