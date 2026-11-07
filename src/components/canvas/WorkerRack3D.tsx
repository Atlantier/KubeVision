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
 * 【几何构成】（由外及内）
 * 1. **半透明磨砂装甲外框**：meshStandardMaterial + drei <Edges> 棱线，
 *    useFrame 驱动「选中态青色呼吸描边 / hover 提亮 / 常态低对比」三态；
 * 2. **四根重工承重角柱**：贴四角内侧的细长方柱，给出机柜的「重工骨架」，
 *    而非薄薄一层火柴盒外壳；
 * 3. **4 层水平托盘隔板**：Y = RACK_TIER_BASE_Y + i·RACK_TIER_HEIGHT − 偏移，
 *    与 getPodWorldTransform 的 Pod 槽位层位严格同源（Pod 正好立于隔板之上）；
 * 4. **16 个刀片插槽幽灵框**：每层 4 槽（2 行 × 2 列），在隔板顶面平铺
 *    正方形细环，让后排未占用的槽位也呈现整齐的工业插槽阵列，
 *    消除「后排一片黑洞」的空洞感；
 * 5. **双层阶梯顶冠**：下层顶盖 + 上层内缩散热冠（青色棱线），
 *    顶冠中心再平铺一枚**水平光纤接口环**，正好承接上方飞来的网络光缆终点；
 * 6. **两侧垂直霓虹导光柱**：useFrame 按节点状态/负载在翠绿→琥珀→警示红间平滑变色；
 * 7. **腔体氛围点光源**：机架内部一盏跟随状态色变化的点光，
 *    真实照亮每层隔板与立柱内壁，让「状态色」不只是几根灯条的颜色；
 * 8. **贴地全息铭牌**：drei <Html>，落在机柜前方地面上，完全避开第一层 Pod。
 *
 * 【60FPS 红线合规 · 零 GC】（AGENTS.md 第 3 条）
 * - 三态目标色（COLOR_HEALTHY/WARNING/CRITICAL/SELECTED）在**模块级一次性预分配**，
 *   useFrame 内仅做 `material.color.lerp(targetConst, α)`——原地突变、零 new THREE.Color；
 * - 16 个插槽幽灵框的局部坐标、4 根立柱的 XZ 坐标全部在**模块顶层预计算**，
 *   渲染期只做数组映射，不进热路径；
 * - 幽灵框以单个 InstancedMesh 承载 16 个实例（1 次 Draw Call），
 *   矩阵在挂载 useEffect 中一次性写入，useFrame 完全不触碰；
 * - 帧率无关阻尼 α = 1 − e^(−k·Δt)，Δt 钳制 0.1s（掉帧不突变）；
 * - 最新 node 数据经 nodeRef 喂入渲染循环（useEffect 1Hz 刷新），
 *   useFrame 零 setState / 零 React 重渲染。
 *
 * 【射线让位契约】（AGENTS.md 第 6 条射线安全的延伸）
 * Pod 实例位于本机架装甲腔体内部，任何命中 Pod 的射线必先穿过更近的装甲面。
 * R3F 按距离升序派发事件且 stopPropagation 会 break 整个命中循环——若机架
 * 无条件抢占，Pod 的 onClick 将永远收不到事件。故 handleSelect / onPointerOver
 * 都先调用 isPodHitInRack()，命中本机架名下 Pod 时静默 return 放行。
 * 另：**新增的插槽幽灵框与腔体点光一律不参与射线拾取**（raycast 置空），
 * 它们是纯装饰，若可拾取会在视觉上"贴在" Pod 之上抢先命中，直接破坏让位协议。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Edges, Html, RoundedBox, type EdgesRef } from '@react-three/drei';
import * as THREE from 'three';

import { cn } from '@/utils/cn';
import { useOptionalGltfModel } from '@/hooks/useOptionalGltfModel';
import { useClusterStore } from '@/store/useClusterStore';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import {
  COL_SPACING,
  POD_BOX_SIZE,
  RACK_BODY_CENTER_Y,
  RACK_BODY_SIZE,
  RACK_LIGHT_GUIDE_X,
  RACK_TIER_BASE_Y,
  RACK_TIER_COUNT,
  RACK_TIER_HEIGHT,
  ROW_DEPTH,
  SLOTS_PER_TIER,
  getRackSlotLocalPose,
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

/* ========================================================================== */
/* 硬件材质契约（修复「死黑顶盖 / 吞光底座」）                                       */
/* ========================================================================== */

/**
 * 底座与顶盖的暗金属材质参数。
 *
 * 【为何必须改】原配置 metalness 0.7 / roughness 0.35 且无环境贴图——
 * 按 PBR 能量守恒，金属度 0.7 会把 70% 的漫反射固有色替换成「环境反射」，
 * 而本项目场景没有 <Environment>/envMap，环境即 #020617 纯黑背景，
 * 于是这些结构件把「反射到的黑」直接画到屏幕上，成为两坨死黑。
 *
 * 修复策略（三重保险，缺一不可）：
 * 1. **降金属度到绝缘体区间**（0.2）：保留绝大部份固有色漫反射，
 *    由场景的三盏灯真实照亮；
 * 2. **补微弱自发光**（emissive #083344 / 0.25）：即使处在灯光照不到的
 *    背光面，也能透出深邃的青蓝底光，呈现「暗金属」而非「纯黑」；
 * 3. **加 <Edges> 棱线**（#1e3a5f）：用结构线把体积轮廓勾出来。
 *    纯色块在深空背景下没有边界，棱线是「看懂这是个立方体」的最后保障。
 */
const HARDWARE_COLOR = '#1e293b';
const HARDWARE_METALNESS = 0.45;
const HARDWARE_ROUGHNESS = 0.32;
const HARDWARE_EMISSIVE = '#0e7490';
const HARDWARE_EMISSIVE_INTENSITY = 0.22;
const HARDWARE_EDGE_COLOR = '#1e3a5f';

/* ========================================================================== */
/* 四角承重立柱                                                                 */
/* ========================================================================== */

/** 立柱截面边长与内缩量（使柱体外缘恰在机架壳体之内，不刺出外壳） */
const PILLAR_SIZE = 0.1;
const PILLAR_INSET = 0.06;

/** 立柱的局部 X / Z 偏移（由机架壳体外包尺寸减去内缩量推导） */
const PILLAR_X = RACK_BODY_SIZE[0] / 2 - PILLAR_INSET;
const PILLAR_Z = RACK_BODY_SIZE[2] / 2 - PILLAR_INSET;

/** 立柱材质（暗钢蓝 + 极弱青色自发光，属于「结构」而非「发光体」） */
const PILLAR_COLOR = '#1e293b';
const PILLAR_EMISSIVE = '#0e7490';
const PILLAR_EMISSIVE_INTENSITY = 0.18;

/**
 * 四根立柱的局部 XZ 坐标（模块顶层预计算，渲染期只做映射）。
 * 顺序固定 XZ 四象限，保证渲染次序稳定、无帧间闪烁。
 */
const PILLAR_POSITIONS: ReadonlyArray<{ readonly x: number; readonly z: number }> = [
  { x: PILLAR_X, z: PILLAR_Z },
  { x: PILLAR_X, z: -PILLAR_Z },
  { x: -PILLAR_X, z: PILLAR_Z },
  { x: -PILLAR_X, z: -PILLAR_Z },
];

/* ========================================================================== */
/* 双层阶梯顶冠 + 光纤接口环                                                      */
/* ========================================================================== */

/**
 * 顶冠各层的高度基准（全部相对机架局部原点，即底座中心地面）。
 *
 * 【数值推导】
 * - 下层顶盖：中心 RACK_BODY_SIZE[1] + 0.06 = 4.46，厚 0.12 → 上沿 4.52；
 * - 上层散热冠：中心 RACK_BODY_SIZE[1] + 0.16 = 4.56，厚 0.08 →
 *   下沿 4.52（正好压在下层顶盖上）、上沿 4.60；
 * - 光纤接口环：RACK_BODY_SIZE[1] + 0.21 = 4.61，比冠顶高 0.01（避免共面闪烁）。
 * 与 NetworkStream3D 的 RACK_TOP_Y = +0.21 严格同值——光缆终点正落在环上。
 */
const COVER_Y = RACK_BODY_SIZE[1] + 0.06;
const COVER_HEIGHT = 0.12;
const CROWN_Y = RACK_BODY_SIZE[1] + 0.16;
const CROWN_HEIGHT = 0.08;

/** 散热顶冠相对下层顶盖的内缩量（两侧合计，视觉上形成「阶梯」） */
const CROWN_INSET = 0.36;
const CROWN_WIDTH = RACK_BODY_SIZE[0] - CROWN_INSET;
const CROWN_DEPTH = RACK_BODY_SIZE[2] - CROWN_INSET;

/** 光纤接口环（平铺在冠顶中心，承接网络光缆终点） */
const FIBER_RING_Y = RACK_BODY_SIZE[1] + 0.21;
const FIBER_RING_INNER = 0.12;
const FIBER_RING_OUTER = 0.22;
const FIBER_RING_SEGMENTS = 32;

/* --------------------------------------------------------------------------
 * 顶部落束光斑（Beam Landing Bloom）
 * -------------------------------------------------------------------------- */

/**
 * 落束光斑的尺寸（世界单位，正方形平面边长）。
 *
 * 【取值依据】光纤接口环外径 0.22，光斑直径取 1.28（约 5.8 倍环径）：
 * 中心亮斑覆盖整个接口环，边缘在环外 0.5 处完全衰减为 0，
 * 从任何机位看都是"一团从环心向外散开的光"，而不是一片方形贴纸。
 */
const BEAM_BLOOM_SIZE = 1.9;

/** 落束光斑的脉动角速度（rad/s，约 1.6 秒一次，与导光柱呼吸同一节奏档位） */
const BEAM_BLOOM_PULSE_RATE = 3.9;

/**
 * 落束光斑的顶点着色器：传递平面 UV。
 *
 * 【为何用 planeGeometry 而不是 circleGeometry】平面的 UV 是规整的 [0,1]²，
 * 可以直接用 `length(uv - 0.5)` 求到中心的归一化距离，径向衰减公式最简洁；
 * circleGeometry 的 UV 是圆盘内切，边缘处距离并非单调。
 */
const BEAM_BLOOM_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * 落束光斑的片元着色器：径向柔光 + 双圈脉冲环。
 *
 * 【核心数学】设 r = length(vUv − 0.5) × 2（中心 0、边缘 1），则
 *   · 径向柔光   glow = pow(1 − smoothstep(0, 1, r), 2.2)   ← 中心最亮、边缘为 0
 *   · 内圈脉冲环 ringA = 以 r ≈ 0.34 为中心的高斯带
 *   · 外圈扩散环 ringB = 以 r ≈ 0.62 为中心、随 uPulse 外扩的高斯带
 * alpha = (glow · 0.85 + ringA · 0.5 + ringB · 0.35) · uPulse
 *
 * 【为什么这样就"无缝"】光束从上方注入、落点就在环心；
 * 光斑在环心处恰为最大亮度（glow → 1），与光束末端的渐隐终点重合，
 * 两者以同一状态色叠加后自然融合，不存在"光束结束 + 光斑开始"的接缝。
 */
const BEAM_BLOOM_FRAGMENT_SHADER = `
uniform vec3 uColor;
uniform float uPulse;

varying vec2 vUv;

void main() {
  float r = length(vUv - vec2(0.5)) * 2.0;
  float glow = pow(1.0 - smoothstep(0.0, 1.0, r), 2.2);
  float ringA = exp(-pow((r - 0.34) / 0.075, 2.0));
  float ringB = exp(-pow((r - (0.62 * uPulse)) / 0.055, 2.0));

  float alpha = (glow * 1.05 + ringA * 0.62 + ringB * 0.42) * uPulse;
  gl_FragColor = vec4(uColor, alpha);
}
`;

/* ========================================================================== */
/* 刀片插槽幽灵框                                                                */
/* ========================================================================== */

/** 幽灵框平铺在隔板顶面之上 0.032（顶层留 0.0045 间隙，避免与隔板共面闪烁） */
const SLOT_GHOST_LIFT = 0.032;

/** 幽灵框几何：极薄的正方形细环（半径 0.24~0.28） */
const SLOT_GHOST_INNER = 0.24;
const SLOT_GHOST_OUTER = 0.28;

/**
 * 正方形环的径向分段数。
 *
 * ringGeometry 在 4 段时顶点位于 0°/90°/180°/270°，连成的多边形是一个
 * **菱形**（对角朝 ±X / ±Z）。要让它看起来是与机架轴向对齐的正方形，
 * 需再绕环自身法线旋转 π/4——详见下方矩阵构建处的推导。
 */
const SLOT_GHOST_SEGMENTS = 4;

/** 承托底座厚度（极薄发光导轨：视觉上是一圈精密边框，不占体积） */
const SLOT_PAD_HEIGHT = 0.016;

/** 幽灵框透明度（仅作承托导轨提示，不得抢走刀片的视觉主体） */
const SLOT_GHOST_OPACITY = 0.42;

/**
 * 幽灵框总数：4 层 × 每层 2 个主力刀片 = 8（承托底座，与刀片 1:1 对应）
 */
const SLOT_GHOST_COUNT = RACK_TIER_COUNT * 2;

/** 单个幽灵框的局部坐标 */
interface SlotGhostPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 隔板相对 Pod 槽位中心的下移量（精确推导：Pod 半高 0.46 + 隔板半厚 0.0275 = 0.4875） */
const TIER_DIVIDER_OFFSET = 0.4875;

/**
 * 4 层托盘隔板的局部 Y 坐标（渲染期一次求值，与 Pod 槽位层位严格同源）。
 *
 * 【几何推导】Pod 槽位中心 y_t = RACK_TIER_BASE_Y + t·RACK_TIER_HEIGHT，
 * Pod 盒高 POD_BOX_HEIGHT = 0.92 → Pod 底面 = y_t − 0.46。
 * 隔板是「Pod 坐落的层板」，故隔板顶面必须恰在 Pod 底面之下：
 *   隔板中心 = y_t − 0.46 − 隔板半厚(0.0275) = y_t − 0.4875（精确值，
 *   任何取整都会让 Pod 陷入或悬空）。
 * 逐层验证：t=0 → 0.0625、t=3 → 3.2125，均落在机柜内且互不重叠。
 */
const TIER_DIVIDER_YS: readonly number[] = Array.from(
  { length: RACK_TIER_COUNT },
  (_, i): number => RACK_TIER_BASE_Y + i * RACK_TIER_HEIGHT - TIER_DIVIDER_OFFSET,
);

/**
 * 16 个刀片插槽幽灵框的局部坐标（模块顶层一次性预计算）。
 *
 * 【坐标公式 · 与 getPodWorldTransform 严格同构】
 * 槽位在一层内的混合进制分解为 (row, col)：
 *   row = ⌊slot / 2⌋ ∈ {0 前排, 1 后排}
 *   col = slot % 2   ∈ {0 左列, 1 右列}
 * 于是
 *   localX = (col − 0.5) · COL_SPACING = ±0.43   （COL_SPACING = 0.86）
 *   localZ = (0.5 − row) · ROW_DEPTH  = ±0.31   （ROW_DEPTH = 0.62）
 *   localY = 隔板中心 + 0.032（即隔板顶面再抬高一点点）
 *
 * 【为何复用导入常量而不写字面量】COL_SPACING / ROW_DEPTH / SLOTS_PER_TIER
 * 直接从 spatialLayout 导入，与 Pod 真身共用同一事实源。若这里复制 0.86/0.62，
 * 一旦布局契约调整，幽灵框会与 Pod 悄悄错位——这类漂移极难在截图中察觉。
 */
const SLOT_GHOSTS: readonly SlotGhostPose[] = (() => {
  const poses: SlotGhostPose[] = [];
  for (let tier = 0; tier < RACK_TIER_COUNT; tier++) {
    const y = TIER_DIVIDER_YS[tier] + SLOT_GHOST_LIFT;
    /*
     * 只安置"主力双联刀片"槽位（层内 j ∈ {0,1}），共 4 层 × 2 = 8 个。
     *
     * 【为什么从 16 个方环减到 8 个承托底座】旧实现画满 16 个缩水小方环
     * （边长仅 0.396），而稳态下每层只有 2 台刀片、且被放在后排，
     * 于是机架前半截空着两个青框、后半截挤着绿色盒子 —— 观感就是"错位"。
     * 现在每个底座都与对应刀片的 (x, z) **同源**（调用 getRackSlotLocalPose），
     * 尺寸比刀片外扩 0.04，形成一圈精密导轨边框。
     */
    for (let mainSlot = 0; mainSlot < 2; mainSlot++) {
      const slotIndex = tier * SLOTS_PER_TIER + mainSlot;
      const local = getRackSlotLocalPose(slotIndex);
      poses.push({ x: local.x, y, z: local.z });
    }
  }
  return poses;
})();

/* ========================================================================== */
/* 半透明蜂窝散热网侧板 / 层间弯曲光纤线束 / 顶冠蚀刻                             */
/* ========================================================================== */

/**
 * 侧板蜂窝网孔着色器（顶点）。
 *
 * 传递平面 UV：x ∈ [0,1] 对应机架纵深，y ∈ [0,1] 对应机架高度。
 */
const MESH_PANEL_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * 侧板蜂窝网孔着色器（片元）。
 *
 * 【核心数学】用两个正交的高频正弦相乘生成网孔矩阵：
 *   cell = sin(u·110) · sin(v·220)
 * 乘积 > 0 的区域是**网骨**（实心金属），< 0 的区域是**网孔**（透明通透），
 * 边界处用 smoothstep 做柔和过渡，避免锯齿。
 *
 * 【为什么这样就有质感】真实机柜侧板是冲孔钢板：远看是一整片半透明金属，
 * 近看是规整的密集孔阵；网骨要有一点金属光泽、孔洞要真的透光。
 * 单纯用一张半透明平面做不到这个层次，必须靠程序化孔阵。
 *
 * alpha：网骨 0.62、孔洞 0.08，因此整体是"半透明"的，能看到内部刀片。
 */
const MESH_PANEL_FRAGMENT_SHADER = `
uniform vec3 uColor;
uniform float uOpacity;

varying vec2 vUv;

void main() {
  float cell = sin(vUv.x * 110.0) * sin(vUv.y * 220.0);
  float bone = smoothstep(-0.18, 0.18, cell);
  float edgeGlow = smoothstep(0.0, 0.06, vUv.x) * (1.0 - smoothstep(0.94, 1.0, vUv.x));

  vec3 color = mix(uColor * 0.55, uColor, bone);
  float alpha = mix(0.08, uOpacity, bone) * edgeGlow;

  gl_FragColor = vec4(color, alpha);
}
`;

/**
 * 把一组 TubeGeometry 合并成单个 BufferGeometry（手工拼装，无额外依赖）。
 *
 * 【为什么必须合并】每层 2 个槽位 × 3 根光纤 = 6 根管；若不合并，
 * 单机架 4 层共 24 次 Draw Call × 3 机架 = 72 次，直接吃掉整帧预算。
 * 合并后每层 1 次、单机架 4 次、全局 12 次。
 *
 * @param tubes 待合并的管几何体（合并后原始几何体被 dispose）
 */
function mergeTubeGeometries(tubes: readonly THREE.TubeGeometry[]): THREE.BufferGeometry {
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const tube of tubes) {
    vertexTotal += tube.attributes.position.count;
    indexTotal += tube.index === null ? 0 : tube.index.count;
  }

  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const uvs = new Float32Array(vertexTotal * 2);
  const indices = new Uint32Array(indexTotal);

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const tube of tubes) {
    const positionAttr = tube.attributes.position;
    const normalAttr = tube.attributes.normal;
    const uvAttr = tube.attributes.uv;
    positions.set(positionAttr.array as Float32Array, vertexOffset * 3);
    normals.set(normalAttr.array as Float32Array, vertexOffset * 3);
    uvs.set(uvAttr.array as Float32Array, vertexOffset * 2);
    if (tube.index !== null) {
      for (let k = 0; k < tube.index.count; k++) {
        indices[indexOffset + k] = tube.index.getX(k) + vertexOffset;
      }
      indexOffset += tube.index.count;
    }
    vertexOffset += positionAttr.count;
    tube.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

/** 层间光纤线束的管半径与每束根数 */
const HARNESS_TUBE_RADIUS = 0.012;
const HARNESS_PER_BUNDLE = 3;
const HARNESS_CURVE_SEGMENTS = 14;

/**
 * 每层的弯曲光纤线束几何（模块加载期一次构建，4 个几何体）。
 *
 * 【路径设计】从刀片底面**前缘**出发，先向内下方弯垂，再收到机架侧柱背面：
 *   起点 slotX, tierY + 0.10, frontZ(−0.42)
 *   控制点依次向下、向内、向后收束
 *   终点 侧柱内侧, tierY − 0.52, +0.10
 * 这正是图五里"每台刀片下方垂着一束发光线"的形态：从设备后下方垂下、
 * 贴着隔板边缘收进侧轨，而不是居中的直线垂挂。
 *
 * 【3 根错落】同一槽位的 3 根管用微小的 X/Z 偏移错开成"束"，
 * 远看是一股线，近看能分辨根数。
 */
const HARNESS_GEOMETRIES: readonly THREE.BufferGeometry[] = (() => {
  const sideInnerX = RACK_BODY_SIZE[0] / 2 - 0.20;
  const frontZ = -(RACK_BODY_SIZE[2] / 2 - 0.12);
  const result: THREE.BufferGeometry[] = [];

  for (let tier = 0; tier < RACK_TIER_COUNT; tier++) {
    const tierY = RACK_TIER_BASE_Y + tier * RACK_TIER_HEIGHT;
    const tubes: THREE.TubeGeometry[] = [];

    for (let mainSlot = 0; mainSlot < 2; mainSlot++) {
      const slotIndex = tier * SLOTS_PER_TIER + mainSlot;
      const local = getRackSlotLocalPose(slotIndex);
      const sideSign = local.x >= 0 ? 1 : -1;

      for (let strand = 0; strand < HARNESS_PER_BUNDLE; strand++) {
        const drift = (strand - 1) * 0.055;
        const start = new THREE.Vector3(local.x, tierY + 0.10, frontZ + drift * 0.4);
        const c1 = new THREE.Vector3(local.x + sideSign * 0.16 + drift, tierY - 0.16, frontZ - 0.06);
        const c2 = new THREE.Vector3(sideSign * sideInnerX * 0.72 + drift, tierY - 0.34, frontZ + 0.22);
        const end = new THREE.Vector3(sideSign * sideInnerX, tierY - 0.52, RACK_BODY_SIZE[2] / 2 - 0.30);
        const curve = new THREE.CubicBezierCurve3(start, c1, c2, end);
        tubes.push(new THREE.TubeGeometry(curve, HARNESS_CURVE_SEGMENTS, HARNESS_TUBE_RADIUS, 5, false));
      }
    }

    result.push(mergeTubeGeometries(tubes));
  }
  return result;
})();

/* ========================================================================== */
/* 底座底板 / 导光柱 / 腔体光源                                                  */
/* ========================================================================== */

/**
 * 底座底板厚度与中心高度。
 *
 * 【取值依据】tier-0 隔板中心在 y=0.0625、底面在 y=0.035，故底板顶面必须
 * ≤ 0.035 才不吞没隔板——取厚度 0.03（中心 0.015，顶面 0.03），
 * 隔板恰好「坐」在底板之上并留 0.005 间隙，视觉上是层板承于机柜地板，零穿插。
 */
const BASE_PLATE_HEIGHT = 0.03;
const BASE_PLATE_CENTER_Y = BASE_PLATE_HEIGHT / 2;

/** 导光柱局部 Z（机架正面内侧，正面朝世界中心，观察侧可见） */
const LIGHT_GUIDE_Z = RACK_BODY_SIZE[2] / 2 - 0.1;

/** 导光柱几何：细长竖直方柱（高度略短于机柜，留出顶盖与底座） */
const LIGHT_GUIDE_HEIGHT = RACK_BODY_SIZE[1] - 0.5;

/**
 * 腔体氛围点光源参数。
 *
 * 【设计意图】状态色此前只体现在两根导光柱上，机柜内部仍是均匀的暗色，
 * 「故障」与「健康」在腔体层面毫无区别。在机架中心挂一盏跟随状态色
 * 平滑过渡的点光后，绿/琥珀/绯红会真实洒在每层隔板与立柱内壁，
 * 让「整座机柜在发光」而不只是「两根灯条在变色」。
 *
 * 【取值依据】decay = 2 为物理正确衰减，distance = 4.8 略大于机架体高（4.4），
 * 保证光能覆盖到最顶层而不溢出到相邻机架（相邻机架间距 ≈16.45）；
 * intensity 2.2 在 r≈1 处仍有可见照度，且不会把深色材质打爆成白。
 */
const CAVITY_LIGHT_POSITION: readonly [number, number, number] = [0, RACK_BODY_CENTER_Y + 0.35, 0];
const CAVITY_LIGHT_INTENSITY = 1.2;
const CAVITY_LIGHT_DISTANCE = 4.2;
const CAVITY_LIGHT_DECAY = 2;

/* ========================================================================== */
/* 射线让位判定                                                                 */
/* ========================================================================== */

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
 * 时视线深处另一机架的 Pod 也在 intersections 里，会导致本机架被错误跳过。
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

/** 装饰件共享的空射线实现（模块级单例，避免每次渲染新建闭包） */
function noRaycast(): void {
  return undefined;
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
 * 【指针事件契约】结构件（装甲外框 / 底座 / 顶盖）各自挂载显式 onClick，
 * 其余内部件经事件冒泡由根 group 的 onClick 兜底。stopPropagation 阻断
 * R3F 射线命中链上更远的对象（如背后的另一机架），杜绝一次点击多选。
 *
 * 【棱线 ref 类型】采用 drei 官方导出的 EdgesRef（内部即 three-stdlib 的
 * LineSegments2 + LineMaterial），不自造结构化类型也不深链 three-stdlib。
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
  /** 腔体点光源：useFrame 内与导光柱同源 lerp，保证状态色绝对一致 */
  const cavityLightRef = useRef<THREE.PointLight>(null);

  /**
   * 顶部落束光斑的 uniforms（useMemo 预分配，useFrame 内只写 .value）。
   *
   * 【为何与导光柱共用同一状态色】光斑位于光束落点，若颜色与机架状态色
   * 不同源，故障时机架变红而落点仍是青的，光学衔接立刻断裂。
   * 因此 useFrame 里直接 copy 导光柱已 lerp 过的颜色，天然同源同相。
   */
  const beamBloomUniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uColor: { value: new THREE.Color('#22d3ee') },
      uPulse: { value: 1 },
    }),
    [],
  );

  /**
   * 侧板蜂窝网 uniforms：颜色同样由导光柱状态色驱动（useFrame 内 copy）。
   *
   * 【uOpacity 0.62】网骨不透明度。孔洞固定 0.08（见片元着色器），
   * 因此整体是"半透明冲孔钢板"：既挡住内部杂乱，又透出刀片绿光。
   */
  const meshPanelUniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uColor: { value: new THREE.Color('#0e7490') },
      uOpacity: { value: 0.62 },
    }),
    [],
  );
  /** 插槽幽灵框实例网格：矩阵在挂载 effect 一次性写入，此后只读 */
  const slotGhostsRef = useRef<THREE.InstancedMesh>(null);
  /** 装甲棱线（drei Edges，官方 EdgesRef 类型）ref：useFrame 驱动选中态呼吸描边 */
  const armorEdgesRef = useRef<EdgesRef | null>(null);
  /** 最新 node 快照引用：useFrame 读取，避免把 node 塞进渲染循环依赖 */
  const nodeRef = useRef<WorkerRack3DProps['node']>(node);

  /**
   * ---- Blender 混合渲染挂载槽 ----
   *
   * 【契约】美术把 `public/models/worker-rack.glb` 放进去即自动切换为高精度模型；
   * 文件不存在时钩子返回 `scene === null`，本组件照常渲染程序化重工机柜。
   *
   * 【替换范围】只替换**静态外壳骨架**（装甲外框 / 角柱 / 底座 / 顶盖 / 顶冠 /
   * 散热格栅）。以下动态部件**始终保留**，因此 Blender 模型同样能随节点健康度
   * 实时变色发光：
   *   · 12 条插槽底座环（SLOT_GHOSTS，单实例网格）
   *   · 两根垂直霓虹导光柱（statusColor 驱动）
   *   · 腔体状态点光源（cavityLight）
   *   · 4 层托盘隔板（Pod 落座基准）
   *   · 底部 <Html> 铭牌（名字 / 状态点 / CPU / MEM）
   *   · 顶部光纤接口环（NetworkStream3D 光缆落点）
   *
   * 【为何用 visible 而非条件渲染】外壳由 6 处分散的网格组成，且与动态部件
   * 交错声明。用 `visible` 关闭时 three 的渲染列表会直接跳过这些对象
   * （零 draw call），同时保留原有 JSX 结构，避免为条件渲染做大规模结构调整
   * 而引入布局/射线回归风险。
   */
  const { scene: gltfRack, isAvailable: isGltfRackAvailable } = useOptionalGltfModel(
    '/models/worker-rack.glb',
  );

  /* node props 变更（1Hz）时刷新 ref；useFrame 恒读最新值，零重订阅 */
  useEffect(() => {
    nodeRef.current = node;
  }, [node]);

  /* 机架世界位姿：与 Pod 槽位/相机机位同源（spatialLayout 单一事实源） */
  const rackTransform = useMemo(() => getRackTransform(node.rackIndex), [node.rackIndex]);

  /** 矩阵合成用的临时对象（组件生命周期内复用，绝不进 useFrame） */
  const ghostTempObject = useMemo((): THREE.Object3D => new THREE.Object3D(), []);

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
   * @description 承托底座矩阵初始化（挂载时一次，含 StrictMode 双挂载安全）。
   *
   * 【几何变更：方环 → 重工金属承托底座】
   * 旧实现是 16 个 ringGeometry 方环（边长仅 0.396），与刀片仅"位置相近"；
   * 现在是 8 个 boxGeometry 承托底座，尺寸 = 刀片尺寸外扩 0.04，
   * 位置 = getRackSlotLocalPose 的 (x, z)，与刀片**绝对同源**。
   *
   * 【为何不再需要 −π/2 与 π/4 旋转】方环必须靠两次旋转才能摆平并轴向对齐；
   * 而 boxGeometry 天生就是轴对齐的长方体，只需正放（无旋转），
   * 天然消除"旋转角写错就错位"的一整类隐患。
   *
   * 【为何用 InstancedMesh】8 个底座 × 3 机架 = 24 次额外 Draw Call；
   * 单实例网格后每机架仅 1 次，且矩阵一次写入、useFrame 完全不触碰。
   */
  useEffect((): void => {
    const mesh = slotGhostsRef.current;
    if (mesh === null) return;

    for (let i = 0; i < SLOT_GHOSTS.length; i++) {
      const slot = SLOT_GHOSTS[i];
      ghostTempObject.position.set(slot.x, slot.y, slot.z);
      ghostTempObject.rotation.set(0, 0, 0);
      ghostTempObject.scale.set(1, 1, 1);
      ghostTempObject.updateMatrix();
      mesh.setMatrixAt(i, ghostTempObject.matrix);
    }
    mesh.count = SLOT_GHOSTS.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [ghostTempObject]);

  /**
   * handleSelect —— 机架选中统一入口（装甲框/底座/顶盖的显式 onClick 复用）。
   *
   * stopPropagation 阻断射线命中链继续向后传播：既防止一次点击同时选中
   * 前后两个重叠机架，也防止命中穿透到地面 Grid 触发 onPointerMissed 取消选中。
   * 命中本机架名下 Pod 时静默 return 放行（让位协议，详见 isPodHitInRack）。
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
   * useFrame —— 导光柱 / 腔体点光按状态平滑变色 + 装甲棱线三态描边。
   *
   * 【核心流转】
   * 1. 读 nodeRef.current 最新遥测；
   * 2. 离散选目标色：选中→青；NetworkPartition→红；
   *    HighLoad 或 CPU/MEM ≥ 85%→琥珀；否则→翠绿；
   * 3. 连续过渡：color.lerp(targetConst, α)，α = 1 − e^(−3.5·Δt)；
   * 4. 分区态叠加透明度脉冲（sin 呼吸），其余状态恒定 GUIDE_BASE_OPACITY。
   *
   * 【为何腔体点光与导光柱共用同一个 target】二者若各自取色，
   * 选中态会出现「灯条变青而腔内仍绿」的割裂；共用同一 Color 常量后，
   * 整座机柜的色温永远同步。
   *
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
    /* 腔体点光：与导光柱同 target 同 alpha，色温永不脱节 */
    if (cavityLightRef.current !== null) {
      cavityLightRef.current.color.lerp(target, alpha);
    }

    /*
     * 顶部落束光斑：颜色直接继承导光柱当前色（同源同相），
     * 脉动用 sin 归一化到 [0.82, 1.18]，与星核心跳同频段。
     * 全部为原地 .value 写入 —— useFrame 零分配。
     */
    if (leftGuideMat.current !== null) {
      (beamBloomUniforms.uColor.value as THREE.Color).copy(leftGuideMat.current.color);
      /* 侧板网孔同源取色：故障时整片侧板也跟着泛红，语义一致 */
      (meshPanelUniforms.uColor.value as THREE.Color).copy(leftGuideMat.current.color);
    }
    beamBloomUniforms.uPulse.value =
      1 + 0.18 * Math.sin(state.clock.getElapsedTime() * BEAM_BLOOM_PULSE_RATE);

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
        if (isPodHitInRack(event, node.id)) return;
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(): void => setHovered(false)}
    >
      {/* ---- Blender 高精度模型（存在 .glb 时挂载；否则回落到下方程序化外壳）----
          模型已由钩子统一开启 castShadow/receiveShadow，因此与场景布光一致。 */}
      {gltfRack !== null ? <primitive object={gltfRack} /> : null}

      {/* ---- 半透明磨砂装甲外框（+ 棱线勾勒机柜轮廓；显式点击选中）。
         【Edges 控制权契约】color/opacity/linewidth 三个动画属性的初始值仅作
         首帧种子，此后由 useFrame 独占驱动；React prop 保持恒定字面量，
         1Hz 重渲染经 R3F props diff 不会重放，动画值零跳变。 ---- */}
      <mesh position={[0, RACK_BODY_CENTER_Y, 0]} onClick={handleSelect} visible={!isGltfRackAvailable}>
        <boxGeometry args={[RACK_BODY_SIZE[0], RACK_BODY_SIZE[1], RACK_BODY_SIZE[2]]} />
        <meshStandardMaterial
          color={HARDWARE_COLOR}
          metalness={0.35}
          roughness={0.72}
          transparent
          opacity={emphasized ? ARMOR_OPACITY_EMPHASIZED : ARMOR_OPACITY_IDLE}
          emissive={isSelected ? '#22d3ee' : '#0e7490'}
          emissiveIntensity={isSelected ? 0.22 : emphasized ? 0.12 : 0.05}
        />
        <Edges
          ref={armorEdgesRef}
          threshold={15}
          color={HARDWARE_EDGE_COLOR}
          transparent
          opacity={EDGE_IDLE_OPACITY}
          linewidth={EDGE_IDLE_WIDTH}
        />
      </mesh>

      {/*
       * ---- 四根重工承重角柱 ----
       *
       * 【设计意图】此前机架只有一层半透明外壳，侧面看是「一张纸片」，
       * 缺少机柜应有的骨架重量。四角立柱补上纵向承重结构，
       * 透过磨砂外壳可见，立刻有了「重工机柜」的实体感。
       * 高度取满机架体高（0 → RACK_BODY_SIZE[1]），中心在 RACK_BODY_CENTER_Y。
       *
       * 【raycast 关闭】立柱是纯结构装饰，不承担选中职责：关闭后射线会
       * 直接穿透到后方的装甲面（由 handleSelect + isPodHitInRack 接管选中），
       * 或在 Pod 位于柱体视线后方时直达 Pod——两处结果都正确，
       * 且避免柱体在命中列表里多插一层、干扰让位判定。
       */}
      {PILLAR_POSITIONS.map((pillar, index): ReactNode => (
        <mesh
          key={`pillar-${index}`}
          position={[pillar.x, RACK_BODY_CENTER_Y, pillar.z]}
          raycast={noRaycast}
          visible={!isGltfRackAvailable}
        >
          <boxGeometry args={[PILLAR_SIZE, RACK_BODY_SIZE[1], PILLAR_SIZE]} />
          <meshStandardMaterial
            color={PILLAR_COLOR}
            metalness={0.3}
            roughness={0.5}
            emissive={PILLAR_EMISSIVE}
            emissiveIntensity={PILLAR_EMISSIVE_INTENSITY}
          />
        </mesh>
      ))}

      {/* ---- 底座底板（薄承板：顶面 0.03 恰在 tier-0 隔板底面 0.035 之下，零穿插；
         显式点击选中——底座是用户点选机架的高频落点）。
         材质修复：metalness 0.7 → 0.2、补自发光与棱线，杜绝深空背景下的死黑。 ---- */}
      <RoundedBox
        position={[0, BASE_PLATE_CENTER_Y, 0]}
        args={[RACK_BODY_SIZE[0] + 0.16, BASE_PLATE_HEIGHT, RACK_BODY_SIZE[2] + 0.16]}
        /* 圆角重工底座：直角方盒在近景下像一块"贴片"，0.035 倒角让它有铸件厚度 */
        radius={0.035}
        smoothness={4}
        castShadow
        receiveShadow
        onClick={handleSelect}
        visible={!isGltfRackAvailable}
      >
        <meshStandardMaterial
          color={HARDWARE_COLOR}
          metalness={HARDWARE_METALNESS}
          roughness={HARDWARE_ROUGHNESS}
          emissive={HARDWARE_EMISSIVE}
          emissiveIntensity={HARDWARE_EMISSIVE_INTENSITY}
        />
        <Edges threshold={15} color="#38bdf8" />
      </RoundedBox>

      {/* ---- 4 层水平服务器托盘隔板（Y 坐标与 Pod 槽位层位同源，推导见常量 JSDoc）。
         metalness 0.55 → 0.2：让腔体点光能以漫反射真实照亮层板，
         否则金属度过高会把光全部转成环境反射而再次吞光。
         【raycast 关闭】层板横贯整个腔体，是「挡住 Pod 拾取」风险最高的部件：
         斜视时射线常先命中 Pod 下方的隔板边缘。关闭后 Pod 直接被拾取，
         不必再依赖让位协议从命中列表里"翻"出 Pod。 ---- */}
      {TIER_DIVIDER_YS.map((tierY, index): ReactNode => (
        <group key={`divider-${index}`}>
          <mesh position={[0, tierY, 0]} receiveShadow raycast={noRaycast}>
            <boxGeometry args={[RACK_BODY_SIZE[0] - 0.16, 0.055, RACK_BODY_SIZE[2] - 0.14]} />
            <meshStandardMaterial
              color="#1e293b"
              metalness={0.2}
              roughness={0.5}
              emissive="#0e7490"
              emissiveIntensity={0.06}
            />
          </mesh>
          {/*
           * ---- 层板正面发光灯眉（4 层科技抽屉的视觉分界线）----
           *
           * 【解决什么】没有这条灯带时，四层隔板在暗场里几乎是同一块深色，
           * 机架正面读不出"分层"结构，Pod 看起来悬浮在虚空里。
           * 加一条跟随节点状态色的细长灯眉后，正面呈现出清晰的 4 层横向切片，
           * 每层容器都被明确地"托"在自己的抽屉里——这是参考图最关键的层次感。
           *
           * 【位置】局部 −Z 是机柜正面（rotationY = α + π，+Z 朝向圆心），
           * 因此灯眉贴在隔板前缘外侧，位于机架正面的最外层，不被装甲遮挡。
           */}
          <mesh position={[0, tierY, -(RACK_BODY_SIZE[2] / 2 - 0.05)]} raycast={noRaycast}>
            <boxGeometry args={[RACK_BODY_SIZE[0] - 0.42, 0.016, 0.016]} />
            <meshBasicMaterial
              color={statusColor}
              toneMapped={false}
              transparent
              opacity={emphasized ? 0.95 : 0.62}
              depthWrite={false}
            />
          </mesh>
        </group>
      ))}

      {/*
       * ---- 16 个刀片插槽幽灵框（单实例网格，1 次 Draw Call）----
       *
       * 【解决什么】初始快照只填满前排槽位，后排 8 个位置是纯黑洞——
       * 观感上机柜「后面是空的」。在每个槽位铺一枚极淡的正方形细环后，
       * 即使空槽也呈现出整齐的工业插槽阵列，机柜立刻「装满了」。
       *
       * 【为何必须禁用射线拾取】这些环平铺在 Pod 正下方的隔板表面，
       * 若可拾取会抢先命中并吃掉了本该属于 Pod 的点击/悬停，
       * 直接破坏本文件头部声明的射线让位契约。
       *
       * 【为何 frustumCulled=false】实例散布在机架内部（Y 跨 0.09~3.24），
       * 而 InstancedMesh 的包围球默认按几何体原点（半径 0.28）计算，
       * 不关闭视锥剔除会在斜视角下被整群错误剔除（集体消失）。
       */}
      <instancedMesh
        ref={slotGhostsRef}
        args={[undefined, undefined, SLOT_GHOST_COUNT]}
        frustumCulled={false}
        raycast={noRaycast}
      >
        <boxGeometry args={[POD_BOX_SIZE[0] + 0.08, SLOT_PAD_HEIGHT, POD_BOX_SIZE[2] + 0.08]} />
        <meshBasicMaterial
          color="#22d3ee"
          transparent
          opacity={SLOT_GHOST_OPACITY}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </instancedMesh>

      {/* ---- 下层顶盖（圆角重工台阶，投影 + 接收阴影；显式点击选中）---- */}
      <RoundedBox
        position={[0, COVER_Y, 0]}
        args={[RACK_BODY_SIZE[0] + 0.14, COVER_HEIGHT, RACK_BODY_SIZE[2] + 0.14]}
        radius={0.035}
        smoothness={4}
        castShadow
        receiveShadow
        onClick={handleSelect}
        visible={!isGltfRackAvailable}
      >
        <meshStandardMaterial
          color={HARDWARE_COLOR}
          metalness={HARDWARE_METALNESS}
          roughness={HARDWARE_ROUGHNESS}
          emissive={HARDWARE_EMISSIVE}
          emissiveIntensity={HARDWARE_EMISSIVE_INTENSITY}
        />
        <Edges threshold={15} color="#38bdf8" />
      </RoundedBox>

      {/*
       * ---- 上层内缩散热顶冠（阶梯第二级）----
       * 尺寸比下层每侧内缩 0.18，形成「先宽后窄」的阶梯轮廓；
       * 棱线改用主题青（#22d3ee）而非暗蓝——它是整座机柜的最高点，
       * 用青色勾勒让顶部在俯瞰机位下能从深色背景里跳出来。
       *
       * 【raycast 关闭】顶冠压在下层顶盖正上方。若保留拾取，俯瞰点击机柜顶部
       * 会先命中顶冠（无 onClick → 冒泡到根 group），而顶盖自身的 handleSelect
       * 反而被跳过；关闭后射线直达顶盖，由 handleSelect 走完整让位判定，
       * 选中语义更明确、也少一次冒泡。
       */}
      <RoundedBox
        position={[0, CROWN_Y, 0]}
        args={[CROWN_WIDTH, CROWN_HEIGHT, CROWN_DEPTH]}
        radius={0.035}
        smoothness={4}
        castShadow
        receiveShadow
        raycast={noRaycast}
        visible={!isGltfRackAvailable}
      >
        <meshStandardMaterial
          color={HARDWARE_COLOR}
          metalness={HARDWARE_METALNESS}
          roughness={HARDWARE_ROUGHNESS}
          emissive={HARDWARE_EMISSIVE}
          emissiveIntensity={HARDWARE_EMISSIVE_INTENSITY}
        />
        <Edges threshold={15} color="#38bdf8" />
      </RoundedBox>

      {/*
       * ---- 顶冠内嵌青色散热格栅芯 ----
       *
       * 【为什么加这一块】参考图二的机柜顶部不是一块死板金属，
       * 而是一条**内凹的发光格栅**——它承担了"这个柜子在散热/在运转"的叙事，
       * 也是整个机柜唯一向上的发光面，让俯瞰机位有东西可看。
       * 用极薄的发光薄片（0.02 高）嵌进顶冠上表面，不做几何雕刻，
       * 成本仅一次 draw call，却让它从"黑色塑料盖"变成"散热模组"。
       */}
      <mesh position={[0, CROWN_Y + CROWN_HEIGHT / 2 + 0.012, 0]} raycast={noRaycast} visible={!isGltfRackAvailable}>
        <boxGeometry args={[CROWN_WIDTH - 0.42, 0.02, CROWN_DEPTH - 0.42]} />
        <meshBasicMaterial color="#22d3ee" toneMapped={false} transparent opacity={0.5} />
      </mesh>

      {/*
       * ---- 半透明蜂窝散热网侧板（左右各一片）----
       *
       * 【解决什么】机柜两侧此前只有四根角柱与透视内部，侧向看是"空架子"。
       * 图五的机柜是冲孔钢板侧板：远看是一整片半透明金属，近看是密集孔阵，
       * 内部刀片的绿光透过孔洞渗出。程序化孔阵（见 MESH_PANEL_FRAGMENT_SHADER）
       * 用一个平面就能做到，成本仅 2 次 Draw Call。
       *
       * 【位置】x = ±(机架半宽 − 0.02)，略内收避免与角柱 Z 向穿插；
       * 面片尺寸取机架宽高的 90%，留出顶/底框边。
       * 【朝向】rotation.y = ±π/2 使平面法线指向 ±X，正对机柜侧面。
       */}
      {[1, -1].map((sideSign): ReactNode => (
        <mesh
          key={`mesh-panel-${sideSign > 0 ? 'right' : 'left'}`}
          position={[sideSign * (RACK_BODY_SIZE[0] / 2 - 0.02), RACK_BODY_CENTER_Y, 0]}
          rotation={[0, sideSign * (Math.PI / 2), 0]}
          raycast={noRaycast}
        >
          <planeGeometry args={[RACK_BODY_SIZE[2] * 0.9, RACK_BODY_SIZE[1] * 0.9]} />
          <shaderMaterial
            uniforms={meshPanelUniforms}
            vertexShader={MESH_PANEL_VERTEX_SHADER}
            fragmentShader={MESH_PANEL_FRAGMENT_SHADER}
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/*
       * ---- 层间弯曲数字光纤线束（每层一束，共 4 束）----
       *
       * 【解决什么】图五最有辨识度的细节之一：每台刀片下方垂着一束
       * 弯曲的发光光纤，收进侧轨。有了它机柜内部立刻"通电了"，
       * 而不是几个悬空的盒子。
       *
       * 【几何】每层的 6 根 TubeGeometry 已在模块加载期合并为 1 个
       * BufferGeometry（见 HARNESS_GEOMETRIES），因此每层仅 1 次 Draw Call。
       * 材质用 meshBasicMaterial + 状态色 + 加色混合：光纤本身不参与光照，
       * 亮度恒定，像真正的导光线缆。
       */}
      {HARNESS_GEOMETRIES.map((harness, tierIndex): ReactNode => (
        <mesh
          key={`harness-${tierIndex}`}
          geometry={harness}
          raycast={noRaycast}
        >
          <meshBasicMaterial
            color={statusColor}
            transparent
            opacity={0.72}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      ))}

      {/*
       * ---- 顶冠全息蚀刻电路面板 ----
       *
       * 【解决什么】顶盖此前是一整块干净的金属，缺少图五那种"精密设备顶部
       * 布满刻线与刻度"的细节。这里在接口环外围铺 4 条细长刻度框 +
       * 2 条侧向散热灯条，用极低高度的 boxGeometry 贴面，成本仅 6 次 Draw Call。
       */}
      {[
        { key: 'crown-etch-a', x: 0, z: -0.42, w: CROWN_WIDTH - 0.18, d: 0.012 },
        { key: 'crown-etch-b', x: 0, z: 0.42, w: CROWN_WIDTH - 0.18, d: 0.012 },
        { key: 'crown-etch-c', x: -(CROWN_WIDTH / 2 - 0.12), z: 0, w: 0.012, d: CROWN_DEPTH - 0.18 },
        { key: 'crown-etch-d', x: CROWN_WIDTH / 2 - 0.12, z: 0, w: 0.012, d: CROWN_DEPTH - 0.18 },
      ].map((bar): ReactNode => (
        <mesh
          key={bar.key}
          position={[bar.x, CROWN_Y + CROWN_HEIGHT / 2 + 0.004, bar.z]}
          raycast={noRaycast}
        >
          <boxGeometry args={[bar.w, 0.004, bar.d]} />
          <meshBasicMaterial color="#38bdf8" toneMapped={false} transparent opacity={0.42} />
        </mesh>
      ))}

      {/*
       * ---- 光纤接口环（顶冠中心的水平发光端口）----
       * 平铺在冠顶上方 0.01，是 NetworkStream3D 拱形光缆的落点：
       * 网络流量的终点 Y 与 FIBER_RING_Y 同值（+0.21），
       * 因此光缆看起来是**插进这个端口**，而不是消失在机柜顶面上。
       */}
      <mesh position={[0, FIBER_RING_Y, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
        <ringGeometry args={[FIBER_RING_INNER, FIBER_RING_OUTER, FIBER_RING_SEGMENTS]} />
        <meshBasicMaterial
          color="#22d3ee"
          toneMapped={false}
          transparent
          opacity={0.85}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/*
       * ---- 顶部落束光斑（Beam Landing Bloom）----
       *
       * 【解决什么】光纤接口环是 NetworkStream3D 光束的落点，但此前只有
       * 一枚细环：光束在环处渐隐为 0，环又只是一圈硬边线，
       * 两者之间没有"光真的落下来了"的过渡，观感是光束悬停在机柜顶面上方。
       *
       * 【做法】在环心平铺一枚径向衰减的柔光斑（着色器见文件头的
       * BEAM_BLOOM_FRAGMENT_SHADER）：中心最亮、边缘完全透明，
       * 并叠加内外两道脉冲环。它把"光束落点"变成一个真实的发光汇聚点。
       *
       * 【位置】Y = FIBER_RING_Y + 0.006，紧贴接口环上方但高于顶冠面，
       * 与环共面又不会 z-fighting；水平贴放（−π/2）朝上发光。
       *
       * 【颜色与节拍】uColor 每帧 copy 自导光柱已 lerp 的颜色 → 与节点
       * 健康度同源；uPulse 提供 0.82~1.18 的呼吸，与星核脉动同频段。
       */}
      <mesh position={[0, FIBER_RING_Y + 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
        <planeGeometry args={[BEAM_BLOOM_SIZE, BEAM_BLOOM_SIZE]} />
        <shaderMaterial
          uniforms={beamBloomUniforms}
          vertexShader={BEAM_BLOOM_VERTEX_SHADER}
          fragmentShader={BEAM_BLOOM_FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      {/* ---- 两侧垂直霓虹导光柱（useFrame 平滑变色：翠绿/琥珀/警示红）。
          【raycast 关闭】导光柱贴在机架正面内侧，是纯发光装饰；
          关闭后点击会穿透到装甲面，由装甲的 handleSelect 负责选中。 ---- */}
      <mesh position={[-RACK_LIGHT_GUIDE_X, RACK_BODY_CENTER_Y, LIGHT_GUIDE_Z]} raycast={noRaycast}>
        <boxGeometry args={[0.11, LIGHT_GUIDE_HEIGHT, 0.11]} />
        <meshBasicMaterial
          ref={leftGuideMat}
          color="#10b981"
          toneMapped={false}
          transparent
          opacity={GUIDE_BASE_OPACITY}
        />
      </mesh>
      <mesh position={[RACK_LIGHT_GUIDE_X, RACK_BODY_CENTER_Y, LIGHT_GUIDE_Z]} raycast={noRaycast}>
        <boxGeometry args={[0.11, LIGHT_GUIDE_HEIGHT, 0.11]} />
        <meshBasicMaterial
          ref={rightGuideMat}
          color="#10b981"
          toneMapped={false}
          transparent
          opacity={GUIDE_BASE_OPACITY}
        />
      </mesh>

      {/* ---- 腔体氛围点光源（状态色真实照亮隔板与立柱内壁；useFrame lerp 同步）---- */}
      <pointLight
        ref={cavityLightRef}
        position={[CAVITY_LIGHT_POSITION[0], CAVITY_LIGHT_POSITION[1], CAVITY_LIGHT_POSITION[2]]}
        color={statusColor}
        intensity={CAVITY_LIGHT_INTENSITY}
        distance={CAVITY_LIGHT_DISTANCE}
        decay={CAVITY_LIGHT_DECAY}
      />

      {/* ---- 底座选中/hover 光环（青色辉光圆环贴地） ---- */}
      {emphasized ? (
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
          <ringGeometry args={[1.9, 2.15, 48]} />
          <meshBasicMaterial
            color="#22d3ee"
            toneMapped={false}
            transparent
            opacity={isSelected ? 0.9 : 0.45}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ) : null}

      {/*
       * ---- 贴地全息铭牌 ----
       *
       * 【位置修复 · Y 轴】从 0.34 下移到 **0.06**：
       * tier-0 的 Pod 槽位中心 0.55，叠加落座偏移 −0.18 后中心在 0.37，
       * 可视盒高 0.56 → 底面 = 0.37 − 0.28 = **0.09**。
       * 铭牌压到 0.06 即完全低于第一层 Pod 的底面，从此不再遮挡任何 Pod。
       *
       * 【位置修复 · Z 轴为何取负值（−1.62 而非 +1.62）】
       * 机架的 rotationY = α + π，使**局部 +Z 指向集群圆心**（见 spatialLayout
       * 的 getRackTransform 注释：「正面（局部 +Z）朝向世界中心」）。
       * 相机位于环外，因此局部 +Z 是背对观察者的一侧：
       *   · +1.62 → 距圆心 9.5 − 1.62 = **7.88**，落在轨道**内侧**、
       *     且从机位看位于机柜**背后**，铭牌会叠在机柜本体上；
       *   · −1.62 → 距圆心 9.5 + 1.62 = **11.12**，落在轨道**外侧**、
       *     位于机柜与相机之间，是真正的「机柜正前方地面」。
       * 用户描述的「前推至…地面轨道外侧」对应的是后者，故取负号。
       *
       * 【样式】去掉厚重深色边框，改为无底色的全息微发光文字 +
       * 自带同色辉光的状态圆点。暗场中像地面上的投影标牌，
       * 而不是一块压在画面上的 UI 卡片。
       *
       * 【drei Html 契约】zIndexRange=[10,0] + pointer-events-none，
       * 永不遮挡右侧 Copilot 抽屉与顶层 Modal（AGENTS.md 第 6 条）。
       */}
      <Html
        position={[0, 0.06, -(RACK_BODY_SIZE[2] / 2 + 0.72)]}
        center
        distanceFactor={14}
        zIndexRange={[10, 0]}
        className="pointer-events-none"
      >
        <div
          className={cn(
            'flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-0.5 font-mono text-[10px] tracking-[0.14em] transition-colors',
            /* 半透明深空毛玻璃底衬：即使压在网格线上也保证文字锐利 */
            'border-white/[0.08] bg-slate-950/70 backdrop-blur-md',
            emphasized
              ? 'text-cyan-100 shadow-[0_0_10px_rgba(34,211,238,0.35)]'
              : 'text-slate-300/90',
          )}
        >
          {/* 状态呼吸灯点：常态下唯一的色彩信号，自带同色辉光 */}
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: statusColor, boxShadow: `0 0 6px ${statusColor}` }}
          />
          <span className="font-bold">{node.name}</span>
          {/*
           * 【常驻单行微标】此前 CPU/MEM 只在交互态展开，常态只剩一个名字，
           * 信息密度不足、也不像"仪表"。改为常驻紧凑单行：
           * 名字 + 状态点 + `CPU xx% | MEM xx%`，全部等宽对齐。
           * 位置仍在机柜正前方地面（Y=0.06，低于第一层 Pod 底面 0.09），
           * 因此绝不会遮挡任何 Pod。
           */}
          <span className="text-slate-500">|</span>
          <span className="tabular-nums" style={{ color: statusColor }}>
            CPU {Math.round(node.cpuUsage)}%
          </span>
          <span className="text-slate-600">·</span>
          <span className="tabular-nums text-slate-400">MEM {Math.round(node.memUsage)}%</span>
        </div>
      </Html>
    </group>
  );
}
