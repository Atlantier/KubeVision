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

import { HoloFrame, MiniBar } from '@/components/canvas/HoloHud';
import { getBrushedMetalTextures } from '@/components/canvas/ProceduralPbrEnvironment';
import { useOptionalGltfModel } from '@/hooks/useOptionalGltfModel';
import { useClusterStore } from '@/store/useClusterStore';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import {
  POD_BOX_SIZE,
  RACK_BODY_CENTER_Y,
  RACK_BODY_SIZE,
  RACK_LIGHT_GUIDE_X,
  RACK_TIER_BASE_Y,
  RACK_TIER_COUNT,
  RACK_TIER_HEIGHT,
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
/* 相机距离景深衰减（Camera-Distance Aerial Perspective）                         */
/* ========================================================================== */

/**
 * 景深衰减的基准距离与斜率。
 *
 * 【公式】depthFactor = clamp(1.22 − (camDist − 12)·0.032, 0.62, 1.18)
 *
 * 逐项含义：
 * · 1.22 是 camDist = 12 时的基准值（略高于 1，近景可以"过亮"一点点，
 *   因为近处机架的锐度与高光对比应当最强）；
 * · 0.032 / 单位 是衰减斜率 —— 每远离 10 单位，亮度降 32%；
 * · camDist = 12 是"理想近景距离"，此时 factor = 1.22。
 *
 * 【关键实测校准】三座机架半径 9.5，相机默认 (7.8, 14, 22)：
 * · 近端 worker-alpha 到相机约 20 单位 → factor ≈ 1.22 − 8×0.032 = 0.964
 * · 中端约 24 单位                  → factor ≈ 1.22 − 12×0.032 = 0.836
 * · 远端 worker-gamma 约 28 单位    → factor ≈ 1.22 − 16×0.032 = 0.708
 * 三层 0.964 / 0.836 / 0.708 形成 1 : 0.87 : 0.73 的清晰梯度，
 * 配合雾效叠加后纵深立刻拉开。
 *
 * 【下界 0.62 的意义】防止极远景（如用户拉远到 40+ 单位）时机架完全黑掉。
 * 0.62 仍能辨认轮廓与状态色，只是"退到背景里"。
 *
 * 【上界 1.18 的意义】双击聚焦拉近时 factor 会超过 1.22 的基准——
 * 但钳制在 1.18 防止贴脸时过曝。聚焦到 12 单位以内即恢复满锐度高亮。
 */
const DEPTH_BASE = 1.22;
const DEPTH_PIVOT_DISTANCE = 12;
const DEPTH_SLOPE = 0.032;
const DEPTH_MIN = 0.62;
const DEPTH_MAX = 1.18;

/**
 * 景深对暗棱线与光带的差异化影响系数。
 *
 * 【为何不完全同倍率缩放】远景机架如果连导光柱也一起变暗，
 * 会失去"状态遥测仍可读"的功能性——用户拉远仍需一眼看出
 * 哪台机架在告警（琥珀）、哪台正常（翠绿）。
 *
 * 因此：
 * · 结构件（棱线、AO、铆钉）按完整 depthFactor 衰减 → 远景自然退场；
 * · 状态发光件（导光柱、腔体光、灯眉）只按 55% 的衰减幅度缩放
 *   → 远景变暗但仍保留足够亮度传达状态色。
 */
const DEPTH_EMISSIVE_DAMPING = 0.55;

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

/* 说明：原 ARMOR_OPACITY_IDLE（0.16）/ ARMOR_OPACITY_EMPHASIZED（0.3）
   两个常量已随「半透明磨砂装甲外框」一同移除——那层外框正是机架
   "暗色塑料感 / 雾蒙蒙"的直接来源（它把内部金属细节全部散射掉了）。
   轮廓与强调职责现由 OPTIC_RAIL_* 光学导轨承担。 */

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

/**
 * 机柜外框的金属度（本轮 0.45 → 0.72）。
 *
 * 【为何在引入 RoomEnvironment 之后要提高】metalness 的本质是
 * "该像素的漫反射占比有多低、镜面反射占比有多高"。没有环境贴图时，
 * 高 metalness 只会让物体变黑（没有可反射的环境）；一旦注入 PMREM 环境，
 * 高 metalness 才开始真正"借"环境的形状来表现金属。
 * 0.72 属于拉丝阳极氧化铝的典型区间：够亮到能看出切角反光，
 * 又保留 28% 的漫反射，不至于把内部刀片的绿色完全压掉。
 */
const HARDWARE_METALNESS = 0.72;

/**
 * 机柜外框的粗糙度（本轮 0.32 → 0.22）。
 *
 * 【与 metalness 的配合】粗糙度决定反射的"锐利程度"。
 * 0.22 让环境面板在立柱切角上形成**清晰的长条高光**（工业金属的关键特征）；
 * 再低会像镜子（舞台感），再高就糊成一团柔光（塑料感）。
 */
const HARDWARE_ROUGHNESS = 0.22;

/**
 * 环境贴图贡献强度。
 *
 * 【为何不拉到 1.0】0.65 是"我借了环境的形状，但不被环境照亮"的平衡点：
 * 机柜立面获得冷金属反光，同时不会亮过内部的绿色刀片——
 * 那才是这个画面的信息主体。超过 0.8 时机柜会开始"抢戏"。
 */
const HARDWARE_ENV_MAP_INTENSITY = 0.65;

const HARDWARE_EMISSIVE = '#0e7490';
const HARDWARE_EMISSIVE_INTENSITY = 0.22;
const HARDWARE_EDGE_COLOR = '#1e3a5f';

/* ========================================================================== */
/* 重工业拉丝钛合金材质参数                                                      */
/* ========================================================================== */

/**
 * 机柜金属基材的 PBR 参数（本轮全面升级）。
 *
 * 【从"暗色塑料感"到"拉丝钛合金"的关键三项】
 * 1. **metalness 0.88**：接近纯金属。前几轮为了防"吞光"把它压到 0.35~0.72，
 *    但那是**没有环境贴图时的权宜之计**——高 metalness 无环境可反射只会变黑。
 *    本轮 ProcedurePbrEnvironment 已提供带工业灯带的 PMREM 环境，
 *    可以放心把金属度拉到 0.88，让机架真正"借"环境形状表现金属。
 * 2. **roughness 0.24**：配合 roughnessMap 使用。基础粗糙度给 0.24，
 *    贴图在其上下起伏（0.16~0.34），产生**沿拉丝方向的各向异性高光**。
 * 3. **envMapIntensity 2.2**：这是让倒角"亮"起来的直接杠杆。
 *    材质级 envMapIntensity 会与 scene.environmentIntensity 相乘，
 *    2.2 × 0.78 ≈ 1.7 的净强度，足以在细窄的倒角面上聚出可见亮线。
 */
const TI_METALNESS = 0.88;
const TI_ROUGHNESS = 0.24;
const TI_ENV_INTENSITY = 2.2;

/**
 * 拉丝凹凸强度。
 *
 * 【为何是 0.015 这样的小值】bumpScale 是"法线扰动相对于几何尺寸的比例"。
 * 机柜立柱宽仅 0.1 单位，0.05 以上的扰动会让棱边看起来像被锉刀刮花；
 * 0.015 恰好让丝纹在近景可见、远景自然消失，且不破坏机柜的直线轮廓。
 */
const BRUSH_BUMP_SCALE = 0.015;

/**
 * 倒角高光棱边的材质参数。
 *
 * 【为何比主体更亮更光】倒角（chamfer）在真实金属件上是**机加工的最后一道工序**
 * ——切削刀走过留下的窄斜面，其表面比主体更平整，因此反射更锐利。
 * metalness 0.96 + roughness 0.12 让它几乎像小镜子，
 * 在工业灯带环境下必然反射出银青色细亮线，从而消除生硬的直角暗边。
 */
const CHAMFER_METALNESS = 0.96;
const CHAMFER_ROUGHNESS = 0.12;
const CHAMFER_ENV_INTENSITY = 3.0;
const CHAMFER_COLOR = '#c8e8f5';
const CHAMFER_EMISSIVE = '#164e63';
const CHAMFER_EMISSIVE_INTENSITY = 0.35;

/**
 * 倒角亮边的几何尺寸。
 *
 * 【为何是 0.012】机柜立柱截面 0.1 单位，倒角占其 12%——
 * 视觉上是一条"细亮线"而非"另一块面板"。再粗会让机柜看起来有塑料包边。
 */
const CHAMFER_SIZE = 0.012;

/**
 * 接缝接触式 AO 暗部的颜色与强度。
 *
 * 【为何用纯黑半透明而非 emissive 负值】three 的标准材质没有"负发光"，
 * AO 只能靠压暗实现：一层极薄的黑色半透明面片贴在接缝处，
 * 模拟"光线进不去缝隙"的效果。比真正的 SSAO 便宜几个数量级
 * （零后处理、零额外 Draw Call 之外的几何）。
 */
const CREVICE_AO_COLOR = '#000000';
const CREVICE_AO_OPACITY = 0.55;

/** 铆钉/卡扣的重型机械件参数 */
const RIVET_COLOR = '#334155';
const RIVET_METALNESS = 0.92;
const RIVET_ROUGHNESS = 0.28;
const RIVET_ENV_INTENSITY = 1.8;
/** 铆钉半径与高度（扁圆柱，像压在钢板上的实心铆接件） */
const RIVET_RADIUS = 0.018;
const RIVET_HEIGHT = 0.014;

/* ========================================================================== */
/* 光学导轨（替换原半透明装甲外框）                                              */
/* ========================================================================== */

/**
 * 光学导轨截面边长。
 *
 * 【为何是 0.022】原装甲外框是一个 2.0×2.4×1.6 的实体盒子，视觉上"包裹"整机；
 * 导轨只用来描出体积轮廓，必须细到**看起来是一条光边**而不是一块面板。
 * 0.022 约为机架宽度的 1.5%，在正常视距下呈 1~2 像素的亮线——
 * 既足以构成线框，又完全不遮挡内部的刀片与层板细节。
 */
const OPTIC_RAIL_SIZE = 0.022;

/**
 * 光学导轨的基色。
 *
 * 【为何用浅钛灰而非深色】原外框用 #1e293b（近黑），在深空背景里
 * 本身就是一团暗色。导轨改用浅钛灰后，它在拉丝金属质感上呈现为
 * "被抛光过的导光条"，与内部深色层板形成明暗层次，
 * 机架轮廓从"一坨黑"变成"一圈亮线"。
 */
const OPTIC_RAIL_COLOR = '#a8c4d4';

/**
 * 光学导轨的自发光色与强度。
 *
 * 【作用】导轨是机柜的轮廓线，必须在暗场中**始终可辨**——
 * 否则侧光不足时整座机架会重新糊成剪影。
 * 用青调自发光（与主题 cyan 呼应）给一条恒定的微光，
 * 强度随选中/强调态提升（0.28 → 0.5 → 0.85），
 * 使"选中"在视觉上表现为**轮廓整圈亮起**，比换一个半透明色块更清晰。
 */
const OPTIC_RAIL_EMISSIVE = '#0e7490';

/* ========================================================================== */
/* 顶冠激光蚀刻散热百叶窗                                                        */
/* ========================================================================== */

/** 百叶窗叶片数量（9：见渲染处注释中的取值依据） */
const LOUVER_COUNT = 9;

/** 单片叶片的厚度 */
const LOUVER_THICKNESS = 0.008;

/**
 * 叶片材质参数。
 *
 * 【为何用偏亮的金属而非暗色】叶片的作用是"在凹槽里制造明暗条纹"，
 * 若本身是暗色，缝隙与叶片都会是黑的，条纹消失。
 * 用浅灰金属（metalness 0.9 / roughness 0.3）后，叶片顶面会反射天顶灯带，
 * 缝隙保持暗——条纹对比度正是这样产生的。
 */
const LOUVER_COLOR = '#7d93a6';
const LOUVER_METALNESS = 0.9;
const LOUVER_ROUGHNESS = 0.3;
const LOUVER_ENV_INTENSITY = 2.4;

/* ========================================================================== */
/* 实例化装饰件的容量上限                                                        */
/* ========================================================================== */

/**
 * 三类装饰件的 InstancedMesh 容量。
 *
 * 【为何要显式给上限】InstancedMesh 的实例缓冲区在创建时按 args[2] 分配，
 * 容量固定。给足上限后，即便未来微调布局（多一层层板、多加一圈倒角）
 * 也不需要重建缓冲区——只需改写入循环并在 count 里体现。
 *
 * 【容量核算】
 * - CHAMFER：立柱 4 柱 × 4 棱 = 16，层板 4 层 × 2 = 8，
 *   底座 2，顶冠 2 圈 × 4 = 8 → 共 34。留到 40 作为余量。
 * - CREVICE_AO：层板 4 层 × 4 角 = 16，立柱根部 4 → 共 20。留到 24。
 * - RIVET：底座 4 角 + 立柱根部 4 → 共 8。留到 12。
 */
const CHAMFER_INSTANCE_MAX = 40;
const CREVICE_AO_INSTANCE_MAX = 24;
const RIVET_INSTANCE_MAX = 12;

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
const PILLAR_COLOR = '#0f172a';
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
const BEAM_BLOOM_SIZE = 0.85;

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

/**
 * 正方形环的径向分段数。
 *
 * ringGeometry 在 4 段时顶点位于 0°/90°/180°/270°，连成的多边形是一个
 * **菱形**（对角朝 ±X / ±Z）。要让它看起来是与机架轴向对齐的正方形，
 * 需再绕环自身法线旋转 π/4——详见下方矩阵构建处的推导。
 */

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

/*
 * ---- 六边形蜂窝孔距场 ----
 *
 * 【核心数学】经典 hex tiling：把平面按六边形错行铺开，再取到最近六边形中心的
 * 归一化距离 d。蜂窝网格的关键是**相邻行横向错开半格**，所以用
 *   y 方向按 cell 高度分行，奇数行 x 偏移 0.5 格
 * 若不这样做，直接 sin(x)·sin(y) 只能得到方格/菱形，成不了"蜂窝"。
 *
 * 返回值：0 = 落在孔洞中心，1 = 落在六边形网骨上。
 */
float hexField(vec2 p) {
  /* 六边形纵横比：高度 = 宽度的 0.866 倍（正六边形的几何常数） */
  const vec2 cellSize = vec2(0.14, 0.14 * 0.866);

  vec2 q = p / cellSize;
  /* 错行：把 y 取整后判断奇偶，奇数行整体右移半格 */
  float row = floor(q.y);
  q.x += mod(row, 2.0) * 0.5;

  /* 六边形到中心的距离：用折叠坐标的 L∞ 组合近似（视觉上足够精确） */
  vec2 local = fract(q) - 0.5;
  float d = max(abs(local.x), abs(local.y) * 0.866 + abs(local.x) * 0.5);

  /* d 小 → 孔洞；d 大 → 网骨。用两次 smoothstep 得到锐利孔壁 */
  return smoothstep(0.24, 0.40, d);
}

void main() {
  /*
   * 【孔阵密度】vUv 是 0~1 的面片参数，实际世界尺寸约 1.62 × 3.96；
   * 乘 (12, 28) 后单块面板上约有 12 列 × 28 行六边形，
   * 远看是密集冲孔网，近看能数清孔洞，与参考图的比例一致。
   */
  vec2 hexUv = vec2(vUv.x * 12.0, vUv.y * 28.0);
  float bone = hexField(hexUv);

  /*
   * 【纵向边缘辉光】两侧内壁的孔洞在靠近立柱的位置被柱体遮挡形成暗角，
   * 而中央区域被内部刀片照亮最亮；用一段 smoothstep 做出"中间透光、两边收暗"
   * 的渐变，侧板因此有纵向的层次，而不是一块均匀亮度的网。
   */
  float verticalFade = smoothstep(0.0, 0.22, vUv.y) * (1.0 - smoothstep(0.78, 1.0, vUv.y));

  /*
   * 【冷暖对比】网骨本身是深灰金属（uColor × 0.35），
   * 孔洞里透出的是内部刀片的翠绿光（uColor 原色 × 1.15 提亮）。
   * 这正是"深灰外框 + 翠绿内透"的冷暖层次来源。
   */
  vec3 boneColor = uColor * 0.35;
  vec3 holeColor = uColor * 1.15;
  vec3 color = mix(holeColor, boneColor, bone);

  /* 孔洞通透（0.10）、网骨半透明（uOpacity）——网格既挡住杂乱又不遮死内部 */
  float alpha = mix(0.10, uOpacity, bone) * verticalFade;

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
 * 光纤线束的流动脉冲着色器（顶点）。
 *
 * 传递管道 UV：TubeGeometry 的 uv.x 沿管长方向（0 = 起点，1 = 终点），
 * uv.y 绕管周向。沿程流动必须用 uv.x。
 */
const HARNESS_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * 光纤线束的流动脉冲着色器（片元）。
 *
 * 【核心数学】在沿程参数上叠加一个随时间推进的锯齿波：
 *   flow  = fract(uv.x · FLOW_CYCLES − uTime · FLOW_SPEED)
 *   pulse = smoothstep(0, 0.12, flow) · (1 − smoothstep(0.12, 0.35, flow))
 *
 * `fract` 让脉冲沿管线循环出现，`uTime` 的负号决定流动方向（从起点流向终点）；
 * 两个 smoothstep 夹出一个**前陡后缓的光头**——这正是数据包在光纤里
 * 推进时前端亮、尾部拖出余晖的形态，而不是均匀的整条亮线。
 *
 * 【为何不用纯 sin】sin 的波峰是平滑对称的，看起来像"呼吸"；而 fract +
 * 非对称 smoothstep 得到的是一段持续单向移动的亮点，观感才是"在流动"。
 */
const HARNESS_FRAGMENT_SHADER = `
uniform float uTime;
uniform vec3 uColor;
uniform float uIntensity;

varying vec2 vUv;

void main() {
  float flow = fract(vUv.x * 3.0 - uTime * 0.55);
  float pulse = smoothstep(0.0, 0.12, flow) * (1.0 - smoothstep(0.12, 0.35, flow));

  float base = 0.30 + 0.10 * sin(vUv.x * 18.0 + uTime * 2.0);
  float alpha = (base + pulse * 0.95) * uIntensity;

  gl_FragColor = vec4(uColor, alpha);
}
`;

/** 光纤脉冲的基础不透明度（网骨级别，脉冲在其上叠加） */
const HARNESS_BASE_INTENSITY = 0.72;

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
  const halfDepth = RACK_BODY_SIZE[2] / 2;
  const result: THREE.BufferGeometry[] = [];

  for (let tier = 0; tier < RACK_TIER_COUNT; tier++) {
    const tierY = RACK_TIER_BASE_Y + tier * RACK_TIER_HEIGHT;
    const tubes: THREE.TubeGeometry[] = [];

    /*
     * 【前后双面对称】三座机架的 rotationY = α + π，导致局部 ±Z 面交替朝向相机：
     * rackIndex 0（位置 z = +9.5，angle = 0）→ 局部 −Z 面朝向主相机；
     * rackIndex 1/2（angle = 120°/240°）→ 局部 +Z 面朝向主相机。
     * 若只装单面，总有一座机架的正面是"空白背板"。
     * 因此这里对 zSign ∈ {+1, −1} 各生成一套线束，两者镜像对称。
     */
    for (const zSign of [1, -1] as const) {
      const frontZ = zSign * (halfDepth - 0.12);

      for (let mainSlot = 0; mainSlot < 2; mainSlot++) {
        const slotIndex = tier * SLOTS_PER_TIER + mainSlot;
        const local = getRackSlotLocalPose(slotIndex);
        const sideSign = local.x >= 0 ? 1 : -1;

        for (let strand = 0; strand < HARNESS_PER_BUNDLE; strand++) {
          const drift = (strand - 1) * 0.055;
          const start = new THREE.Vector3(local.x, tierY + 0.10, frontZ + zSign * drift * 0.4);
          const c1 = new THREE.Vector3(
            local.x + sideSign * 0.16 + drift,
            tierY - 0.16,
            frontZ + zSign * 0.06,
          );
          const c2 = new THREE.Vector3(
            sideSign * sideInnerX * 0.72 + drift,
            tierY - 0.34,
            frontZ - zSign * 0.22,
          );
          const end = new THREE.Vector3(
            sideSign * sideInnerX,
            tierY - 0.52,
            -(halfDepth - 0.30) * zSign,
          );
          const curve = new THREE.CubicBezierCurve3(start, c1, c2, end);
          tubes.push(new THREE.TubeGeometry(curve, HARNESS_CURVE_SEGMENTS, HARNESS_TUBE_RADIUS, 5, false));
        }
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

  /**
   * 程序化拉丝金属纹理（模块级单例，三座机架共享同一份 GPU 纹理）。
   *
   * 【为何用 useMemo 而非 useState/useEffect】纹理生成是**同步一次的纯计算**
   * （256×256×2 约 1~3ms），不需要副作用，也不该触发额外渲染。
   * useMemo 保证：首次渲染前拿到纹理（首帧就有拉丝效果，不会闪一下素模），
   * 且后续重渲染直接复用缓存引用。
   *
   * 【SSR 安全性】getBrushedMetalTextures 在 window 未定义时返回 null，
   * 因此服务端渲染阶段这里就是 null，材质以无贴图方式降级；
   * 客户端首次渲染才生成真实纹理。这与项目的 SSR 契约一致。
   */
  const brushedMetal = useMemo(() => getBrushedMetalTextures(), []);

  /* ---- 动画通道 ref ---- */
  const leftGuideMat = useRef<THREE.MeshBasicMaterial>(null);
  const rightGuideMat = useRef<THREE.MeshBasicMaterial>(null);
  /**
   * 背面（局部 −Z 侧）两根导光柱的材质 ref。
   *
   * 【为何需要】机架正面朝相机的那一侧随 rackIndex 在 ±Z 间交替，
   * 只装 +Z 侧的导光柱会让 alpha（−Z 朝相机）整座机架看不到垂直光柱。
   * 因此背面也各装一根，并由 useFrame 用与正面完全相同的
   * target/alpha 同步 lerp，两面的色温与呼吸相位严格一致。
   */
  const backGuideMatLeft = useRef<THREE.MeshBasicMaterial>(null);
  const backGuideMatRight = useRef<THREE.MeshBasicMaterial>(null);
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

  /**
   * 光纤线束的流动脉冲 uniforms。
   *
   * 【为何一个机架共用一份】4 层的线束同属一台节点，状态色与流动相位
   * 本就应当一致；共用一份 uniform 意味着 useFrame 只需写 2 个标量，
   * 而不是 4×2 次，且 4 个 mesh 共享同一个 shader program（少 3 次编译）。
   */
  const harnessUniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uTime: { value: 0 },
      uColor: { value: new THREE.Color('#22d3ee') },
      uIntensity: { value: HARNESS_BASE_INTENSITY },
    }),
    [],
  );
  /** 插槽幽灵框实例网格：矩阵在挂载 effect 一次性写入，此后只读 */
  const slotGhostsRef = useRef<THREE.InstancedMesh>(null);

  /**
   * 倒角亮边实例网格（InstancedMesh 合并）。
   *
   * 【为何必须实例化】本轮为消除"生硬直角暗边"而加入的倒角棱边共有：
   * 立柱 16 + 层板 8 + 顶冠 8 + 底座 2 = 每机架 34 条。
   * 若每条一个 mesh，三座机架就是 102 次 draw call——足以让整场景
   * 的 draw call 从 307 飙到 600+，违背 60FPS 红线。
   *
   * 这些棱边**材质完全相同**（都是 CHAMFER_* 参数），
   * 只是位置与尺寸不同，正是 InstancedMesh 的典型适用场景：
   * 34 个实例 → 1 次 draw call（每机架），三座共 3 次。
   *
   * 【尺寸差异如何处理】立柱棱、层板棱、顶冠棱的**长度不同**，
   * 靠 instanceMatrix 的缩放分量表达（基础几何取单位立方体）。
   * 因此几何用 BoxGeometry(1,1,1)，每个实例缩放成目标尺寸。
   */
  const chamferInstancesRef = useRef<THREE.InstancedMesh>(null);

  /**
   * 接缝 AO 暗环实例网格。
   *
   * 【为何实例化】层板 4 角 × 4 层 + 立柱根部 4 处 = 每机架 20 个 AO 环。
   * 它们共享同一个圆环几何与半透明黑材质，实例化后每机架仅 1 次 draw call。
   */
  const creviceAoInstancesRef = useRef<THREE.InstancedMesh>(null);

  /**
   * 铆钉实例网格（底座 4 角 + 立柱根部 4 处 = 每机架 8 枚）。
   * 同样是"相同材质、不同位置"的批量场景。
   */
  const rivetInstancesRef = useRef<THREE.InstancedMesh>(null);

  /** 装甲棱线（drei Edges，官方 EdgesRef 类型）ref：useFrame 驱动选中态呼吸描边 */
  const armorEdgesRef = useRef<EdgesRef | null>(null);

  /* ---- 景深衰减：需要被统一调节亮度的发光件 ref ---- */

  /**
   * 底座光圈 / 底部承载板的发光材质。
   *
   * 【为何单独收集】底座的亮度是"机架整体存在感"的锚点：
   * 远景机架若底座仍全亮，会与近景机架争夺注意力，纵深被打平。
   * 把它的亮度纳入 depthFactor 缩放后，远端机架的"地基"自然沉入雾中。
   */
  const plinthGlowRef = useRef<THREE.MeshBasicMaterial>(null);

  /**
   * 四层灯眉材质的集合（8 条：4 层 × 前后双面）。
   *
   * 【为何用数组】灯眉是按 TIER_DIVIDER_YS 映射生成的，无法用单个 ref。
   * 在 useFrame 里遍历这个数组统一缩放 opacity 即可——
   * 数组长度固定为 8，遍历开销可忽略且零分配。
   */
  const tierBandMatsRef = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  tierBandMatsRef.current.length = TIER_DIVIDER_YS.length * 2;

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
   * 倒角棱边 / AO 暗环 / 铆钉 的实例矩阵批量写入。
   *
   * 【一次 effect 写满三类实例网格】它们的矩阵全部是**静态常量**
   * （位置由机架几何尺寸推导，不随状态变化），因此在挂载时写一次即可，
   * useFrame 完全不触碰——这既是性能要求（60FPS 红线），
   * 也是正确性要求（静态装饰件不该每帧重算矩阵）。
   *
   * 【零 GC】所有临时计算复用同一个 module-scope 的 Object3D，
   * 循环内只做 set/updateMatrix，不分配任何新对象。
   */
  useEffect((): void => {
    /* ---- 1. 倒角亮边实例 ---- */
    const chamfers = chamferInstancesRef.current;
    if (chamfers !== null) {
      let instanceIndex = 0;

      /** 写入单个实例：位置 + 缩放（几何是单位立方体，尺寸全靠 scale） */
      const pushChamfer = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
        ghostTempObject.position.set(x, y, z);
        ghostTempObject.rotation.set(0, 0, 0);
        ghostTempObject.scale.set(sx, sy, sz);
        ghostTempObject.updateMatrix();
        chamfers.setMatrixAt(instanceIndex, ghostTempObject.matrix);
        instanceIndex += 1;
      };

      /* 立柱四条竖直棱（每根立柱 4 条，共 16） */
      for (const pillar of PILLAR_POSITIONS) {
        const halfPillar = PILLAR_SIZE / 2;
        /* 沿 X 面与 Z 面各自的棱线：细长条，长度取机架高 */
        pushChamfer(pillar.x + halfPillar, RACK_BODY_CENTER_Y, pillar.z, CHAMFER_SIZE, RACK_BODY_SIZE[1] * 0.995, PILLAR_SIZE * 0.55);
        pushChamfer(pillar.x - halfPillar, RACK_BODY_CENTER_Y, pillar.z, CHAMFER_SIZE, RACK_BODY_SIZE[1] * 0.995, PILLAR_SIZE * 0.55);
        pushChamfer(pillar.x, RACK_BODY_CENTER_Y, pillar.z + halfPillar, PILLAR_SIZE * 0.55, RACK_BODY_SIZE[1] * 0.995, CHAMFER_SIZE);
        pushChamfer(pillar.x, RACK_BODY_CENTER_Y, pillar.z - halfPillar, PILLAR_SIZE * 0.55, RACK_BODY_SIZE[1] * 0.995, CHAMFER_SIZE);
      }

      /* 层板前后沿（4 层 × 2 条 = 8） */
      for (const tierY of TIER_DIVIDER_YS) {
        for (const zSign of [1, -1]) {
          pushChamfer(
            0,
            tierY,
            (zSign * (RACK_BODY_SIZE[2] - 0.14)) / 2,
            RACK_BODY_SIZE[0] - 0.16,
            CHAMFER_SIZE,
            CHAMFER_SIZE,
          );
        }
      }

      /* 底座前后沿（2 条） */
      for (const zSign of [1, -1]) {
        pushChamfer(
          0,
          BASE_PLATE_CENTER_Y + BASE_PLATE_HEIGHT / 2,
          (zSign * (RACK_BODY_SIZE[2] + 0.16)) / 2,
          RACK_BODY_SIZE[0] + 0.16,
          CHAMFER_SIZE,
          CHAMFER_SIZE,
        );
      }

      /* 顶冠上下四周（2 层 × 4 边 = 8） */
      for (const ySign of [1, -1]) {
        const chamferY = CROWN_Y + (ySign * CROWN_HEIGHT) / 2;
        for (const zSign of [1, -1]) {
          pushChamfer(0, chamferY, (zSign * CROWN_DEPTH) / 2, CROWN_WIDTH, CHAMFER_SIZE, CHAMFER_SIZE);
        }
        for (const xSign of [1, -1]) {
          pushChamfer((xSign * CROWN_WIDTH) / 2, chamferY, 0, CHAMFER_SIZE, CHAMFER_SIZE, CROWN_DEPTH);
        }
      }

      chamfers.count = instanceIndex;
      chamfers.instanceMatrix.needsUpdate = true;
    }

    /* ---- 2. 接缝 AO 暗环实例 ---- */
    const aoRings = creviceAoInstancesRef.current;
    if (aoRings !== null) {
      let aoIndex = 0;

      const pushAo = (x: number, y: number, z: number, scale: number): void => {
        ghostTempObject.position.set(x, y, z);
        /* 圆环默认在 XY 平面，需绕 X 转 90° 才能贴在水平面上 */
        ghostTempObject.rotation.set(-Math.PI / 2, 0, 0);
        ghostTempObject.scale.set(scale, scale, 1);
        ghostTempObject.updateMatrix();
        aoRings.setMatrixAt(aoIndex, ghostTempObject.matrix);
        aoIndex += 1;
      };

      /* 层板与立柱交界（4 角 × 4 层） */
      for (const tierY of TIER_DIVIDER_YS) {
        for (const pillar of PILLAR_POSITIONS) {
          pushAo(pillar.x, tierY + 0.030, pillar.z, 1);
        }
      }

      /* 立柱根部与底座交界（4 处） */
      for (const pillar of PILLAR_POSITIONS) {
        pushAo(pillar.x, -RACK_BODY_SIZE[1] / 2 + 0.002, pillar.z, 1);
      }

      aoRings.count = aoIndex;
      aoRings.instanceMatrix.needsUpdate = true;
    }

    /* ---- 3. 铆钉实例 ---- */
    const rivets = rivetInstancesRef.current;
    if (rivets !== null) {
      let rivetIndex = 0;

      const pushRivet = (x: number, y: number, z: number, scale: number): void => {
        ghostTempObject.position.set(x, y, z);
        ghostTempObject.rotation.set(0, 0, 0);
        ghostTempObject.scale.set(scale, scale, scale);
        ghostTempObject.updateMatrix();
        rivets.setMatrixAt(rivetIndex, ghostTempObject.matrix);
        rivetIndex += 1;
      };

      /* 底座四角地脚螺栓 */
      for (const corner of PILLAR_POSITIONS) {
        pushRivet(
          corner.x,
          BASE_PLATE_CENTER_Y + BASE_PLATE_HEIGHT / 2 + RIVET_HEIGHT / 2,
          corner.z,
          1.2,
        );
      }

      /* 立柱根部卡扣（与立柱同 XZ，贴在柱底） */
      for (const pillar of PILLAR_POSITIONS) {
        pushRivet(pillar.x, -RACK_BODY_SIZE[1] / 2 + RIVET_HEIGHT / 2 + 0.006, pillar.z, 1);
      }

      rivets.count = rivetIndex;
      rivets.instanceMatrix.needsUpdate = true;
    }
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

    /*
     * ==================================================================
     * 相机距离景深衰减（本轮新增 · Camera-Distance Aerial Perspective）
     *
     * 【核心数学】depthFactor = clamp(1.22 − (camDist − 12)·0.032, 0.62, 1.18)
     *
     * camDist 是**机架中心到相机**的直线距离。rackTransform.position 已是
     * 世界坐标（机架直接挂在场景根 group 下，无中间父级缩放），
     * 因此无需 getWorldPosition（那会触发矩阵更新，是 useFrame 里的浪费）。
     *
     * 【为何用机架中心而非逐个构件】景深是"整机远近"的宏观表现，
     * 同一座机架内部所有构件到相机距离差不到 3 单位，逐构件计算既不必要
     * 也会让机架内部出现亮度断层（近侧亮、远侧暗），破坏硬件整体感。
     *
     * 【零分配】全部为标量算术，不 new 任何 Vector3 —— 距离公式直接展开。
     * ==================================================================
     */
    const rackX = rackTransform.position[0];
    const rackY = rackTransform.position[1];
    const rackZ = rackTransform.position[2];
    const camPos = state.camera.position;
    const dx = camPos.x - rackX;
    const dy = camPos.y - rackY;
    const dz = camPos.z - rackZ;
    const camDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const depthFactor = Math.min(
      DEPTH_MAX,
      Math.max(DEPTH_MIN, DEPTH_BASE - (camDist - DEPTH_PIVOT_DISTANCE) * DEPTH_SLOPE),
    );

    /**
     * 状态发光件的景深亮度（衰减幅度只需结构件的 55%）。
     * 远景机架仍要能读出状态色（琥珀告警 / 翠绿正常），否则遥测不可用。
     */
    const emissiveDepth = 1 - (1 - depthFactor) * DEPTH_EMISSIVE_DAMPING;

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
    const baseOpacity =
      current.status === 'NetworkPartition' && !isSelected
        ? CRITICAL_PULSE_MIN +
          (CRITICAL_PULSE_MAX - CRITICAL_PULSE_MIN) *
            (0.5 + 0.5 * Math.sin(state.clock.getElapsedTime() * CRITICAL_PULSE_RATE))
        : GUIDE_BASE_OPACITY;

    /*
     * 导光柱是状态发光件：按 emissiveDepth 缩放（衰减幅度仅为结构件的 55%）。
     * 远景时它变暗但不会消失 —— 用户拉远仍能一眼分辨哪台机架在告警。
     */
    const opacity = baseOpacity * emissiveDepth;

    if (leftGuideMat.current !== null) {
      leftGuideMat.current.color.lerp(target, alpha);
      leftGuideMat.current.opacity = opacity;
    }
    if (rightGuideMat.current !== null) {
      rightGuideMat.current.color.lerp(target, alpha);
      rightGuideMat.current.opacity = opacity;
    }
    /* 背面导光柱：同一 target / 同一 alpha，保证前后两面色温与呼吸完全同步 */
    if (backGuideMatLeft.current !== null) {
      backGuideMatLeft.current.color.lerp(target, alpha);
      backGuideMatLeft.current.opacity = opacity;
    }
    if (backGuideMatRight.current !== null) {
      backGuideMatRight.current.color.lerp(target, alpha);
      backGuideMatRight.current.opacity = opacity;
    }
    /* 腔体点光：与导光柱同 target 同 alpha，色温永不脱节。
       强度也按 emissiveDepth 缩放 —— 远景机架的腔内不应再"照亮"周围地面。 */
    if (cavityLightRef.current !== null) {
      cavityLightRef.current.color.lerp(target, alpha);
      cavityLightRef.current.intensity = CAVITY_LIGHT_INTENSITY * emissiveDepth;
    }

    /*
     * ---- 四层灯眉（8 条）随距离衰减 ----
     *
     * 灯眉是机架正面最显眼的分层标识。远景若不衰减，8 条亮线会与
     * 近景机架的灯眉在同一亮度水平上竞争，纵深立刻被拉平。
     * 这里用同一个 emissiveDepth 统一缩放，保持 8 条同步。
     */
    const tierBands = tierBandMatsRef.current;
    const baseTierOpacity = emphasized ? 0.95 : 0.62;
    const scaledTierOpacity = baseTierOpacity * emissiveDepth;
    for (let i = 0; i < tierBands.length; i += 1) {
      const bandMat = tierBands[i];
      if (bandMat !== null && bandMat !== undefined) {
        bandMat.opacity = scaledTierOpacity;
      }
    }

    /* ---- 底座光圈随距离衰减（结构件全幅度）---- */
    if (plinthGlowRef.current !== null) {
      plinthGlowRef.current.opacity = (isSelected ? 0.9 : 0.45) * depthFactor;
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
      /* 光纤线束同源取色 + 推进流动脉冲相位（原地写，零分配） */
      (harnessUniforms.uColor.value as THREE.Color).copy(leftGuideMat.current.color);
    }
    harnessUniforms.uTime.value = state.clock.getElapsedTime();
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

  /**
   * 状态徽标文案（HUD 铭牌第一行右侧）。
   *
   * 【为什么用短码而非中文】铭牌是"仪表标牌"而非说明文字：
   * READY / HIGH_LOAD / PART_ERR 是运维界面通用的状态短码，
   * 等宽字体下宽度稳定、不随语言变化跳动，也更像真实机柜上的铭牌。
   */
  const statusBadgeLabel =
    node.status === 'NetworkPartition'
      ? 'PART_ERR'
      : node.status === 'HighLoad'
        ? 'HIGH_LOAD'
        : 'READY';

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

      {/* ---- 通透光学导轨框架（替换原半透明磨砂装甲外框）。
         【本轮为何替换】原外框是一个 opacity 0.16、roughness 0.72 的暗色大盒子，
         包裹整个机架。它的副作用是**把内部所有金属细节都蒙上了一层雾**：
         立柱的倒角高光、层板的拉丝纹理、顶冠的锐利反射全部被这层
         "塑料薄膜"散射掉，这正是"暗色塑料感"最直接的来源。
         移除后内部结构若直接裸露，机架又会失去整体轮廓——
         因此改为**只保留边框的窄幅光学导轨**：
         - 四条竖直导轨（贴四角内侧，极细，宽 0.022）；
         - 上下各一圈水平导轨（贴顶/底内缘）；
         用它们围出机架体积，但不遮挡任何内部细节。
         【点击选中职责】原外框是 handleSelect 的主要落点。现在改由
         四条竖直导轨承担（每条都有 onClick + 足够长的可点区域），
         底座与顶盖也保留 onClick，选中路径完全不减少。
         【Edges 控制权契约】color/opacity/linewidth 三个动画属性的初始值仅作
         首帧种子，此后由 useFrame 独占驱动；React prop 保持恒定字面量，
         1Hz 重渲染经 R3F props diff 不会重放，动画值零跳变。 ---- */}

      {/* ---- 四根竖直光学导轨（承担点击选中 + 勾勒机架纵向轮廓）---- */}
      {PILLAR_POSITIONS.map((corner, cornerIndex): ReactNode => (
        <mesh
          key={`optic-rail-v-${cornerIndex}`}
          position={[corner.x, RACK_BODY_CENTER_Y, corner.z]}
          onClick={handleSelect}
          visible={!isGltfRackAvailable}
        >
          {/*
           * 导轨截面 0.022×0.022 —— 极细，视觉上是一条"光边"而非一块面板。
           * 长度取满机架高度，确保纵向轮廓连续。
           */}
          <boxGeometry args={[OPTIC_RAIL_SIZE, RACK_BODY_SIZE[1], OPTIC_RAIL_SIZE]} />
          <meshStandardMaterial
            color={OPTIC_RAIL_COLOR}
            metalness={0.92}
            roughness={0.16}
            envMapIntensity={3.2}
            emissive={OPTIC_RAIL_EMISSIVE}
            emissiveIntensity={isSelected ? 0.85 : emphasized ? 0.5 : 0.28}
            transparent
            opacity={0.92}
          />
          <Edges
            ref={cornerIndex === 0 ? armorEdgesRef : undefined}
            threshold={15}
            color={isSelected ? '#22d3ee' : HARDWARE_EDGE_COLOR}
            transparent
            opacity={EDGE_IDLE_OPACITY}
            linewidth={EDGE_IDLE_WIDTH}
          />
        </mesh>
      ))}

      {/*
       * ---- 上下水平光学导轨（各一圈：前/后/左/右四条细棱）----
       *
       * 与竖直导轨拼合成一个完整的"线框体"，机架的体积感来自这个框，
       * 而不是来自一面遮住内部的半透明板。
       */}
      {[0, 1].map((levelIndex): ReactNode => {
        /* 下层贴机架底部、上层贴机架顶部（各内缩半个导轨宽避免与外框重叠） */
        const y =
          levelIndex === 0
            ? OPTIC_RAIL_SIZE / 2 + 0.01
            : RACK_BODY_SIZE[1] - OPTIC_RAIL_SIZE / 2 - 0.01;
        return (
          <group key={`optic-rail-h-${levelIndex}`}>
            {[1, -1].map((zSign): ReactNode => (
              <mesh
                key={`optic-h-z-${zSign}`}
                position={[0, y, zSign * (RACK_BODY_SIZE[2] / 2 - OPTIC_RAIL_SIZE / 2)]}
                onClick={handleSelect}
                visible={!isGltfRackAvailable}
              >
                <boxGeometry args={[RACK_BODY_SIZE[0], OPTIC_RAIL_SIZE, OPTIC_RAIL_SIZE]} />
                <meshStandardMaterial
                  color={OPTIC_RAIL_COLOR}
                  metalness={0.92}
                  roughness={0.16}
                  envMapIntensity={3.2}
                  emissive={OPTIC_RAIL_EMISSIVE}
                  emissiveIntensity={isSelected ? 0.85 : emphasized ? 0.5 : 0.28}
                  transparent
                  opacity={0.92}
                />
              </mesh>
            ))}
            {[1, -1].map((xSign): ReactNode => (
              <mesh
                key={`optic-h-x-${xSign}`}
                position={[xSign * (RACK_BODY_SIZE[0] / 2 - OPTIC_RAIL_SIZE / 2), y, 0]}
                onClick={handleSelect}
                visible={!isGltfRackAvailable}
              >
                <boxGeometry args={[OPTIC_RAIL_SIZE, OPTIC_RAIL_SIZE, RACK_BODY_SIZE[2]]} />
                <meshStandardMaterial
                  color={OPTIC_RAIL_COLOR}
                  metalness={0.92}
                  roughness={0.16}
                  envMapIntensity={3.2}
                  emissive={OPTIC_RAIL_EMISSIVE}
                  emissiveIntensity={isSelected ? 0.85 : emphasized ? 0.5 : 0.28}
                  transparent
                  opacity={0.92}
                />
              </mesh>
            ))}
          </group>
        );
      })}

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
        <group key={`pillar-${index}`} position={[pillar.x, RACK_BODY_CENTER_Y, pillar.z]}>
          {/* ---- 立柱主体：拉丝钛合金 ---- */}
          <mesh raycast={noRaycast} visible={!isGltfRackAvailable}>
            <boxGeometry args={[PILLAR_SIZE, RACK_BODY_SIZE[1], PILLAR_SIZE]} />
            <meshStandardMaterial
              color={PILLAR_COLOR}
              metalness={TI_METALNESS}
              roughness={TI_ROUGHNESS}
              /*
               * 【拉丝金属贴图】roughnessMap 让粗糙度沿纵向丝纹起伏
               * （各向异性高光），bumpMap 让高光沿丝纹断裂成细碎亮点。
               * 两者缺一都会退化成"均匀磨砂塑料"。
               * 服务端渲染阶段 brushedMetal 为 null，此时这两个 prop 为
               * undefined，three 会按无贴图的纯参数渲染——自然降级。
               */
              roughnessMap={brushedMetal?.roughnessMap ?? null}
              bumpMap={brushedMetal?.bumpMap ?? null}
              bumpScale={BRUSH_BUMP_SCALE}
              envMapIntensity={TI_ENV_INTENSITY}
              emissive={PILLAR_EMISSIVE}
              emissiveIntensity={PILLAR_EMISSIVE_INTENSITY}
            />
            <Edges threshold={15} color="#334155" />
          </mesh>

          {/*
           * 【倒角棱边 / 铆钉 / AO 环已改为实例化渲染】
           * 它们原本是每根立柱 4 条棱 + 1 铆钉 + 1 AO 环的独立 mesh，
           * 三座机架合计超 100 次 draw call。现统一由文件末尾的三个
           * InstancedMesh 承载（倒角 34 实例 / AO 20 实例 / 铆钉 8 实例，
           * 各自仅 1 次 draw call）。矩阵在挂载 effect 中一次性写入。
           */}
        </group>
      ))}

      {/*
       * ============ 实例化渲染：倒角亮边 / 接缝 AO / 铆钉 ============
       *
       * 【为何集中到一处而非散落在各构件旁】三者都是"相同材质、不同位置"
       * 的静态装饰件，只有用 InstancedMesh 批量提交才能把 draw call
       * 从 100+ 压到 3。集中到一个 group 里也让"这批几何是性能敏感区"
       * 这件事在代码结构上可见，后人新增装饰件时会知道要往这里加实例。
       *
       * 【为何几何用单位立方体/单位圆环 + scale】
       * 倒角棱的长度差异很大（立柱棱 2.4 米、层板棱 1.8 米、顶冠棱 1.4 米），
       * 若为每种长度建独立几何就失去实例化意义。统一用 1×1×1 基础几何，
       * 由 instanceMatrix 的缩放分量表达实际尺寸——这是 InstancedMesh 的
       * 标准用法，且矩阵写入只发生在挂载时，运行期零开销。
       *
       * 【raycast 关闭】全部是纯装饰，不参与拾取（与项目既有装饰件一致）。
       */}
      <group visible={!isGltfRackAvailable}>
        {/* ---- 倒角亮边（34 实例）---- */}
        <instancedMesh
          ref={chamferInstancesRef}
          args={[undefined, undefined, CHAMFER_INSTANCE_MAX]}
          raycast={noRaycast}
          frustumCulled={false}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial
            color={CHAMFER_COLOR}
            metalness={CHAMFER_METALNESS}
            roughness={CHAMFER_ROUGHNESS}
            envMapIntensity={CHAMFER_ENV_INTENSITY}
            emissive={CHAMFER_EMISSIVE}
            emissiveIntensity={CHAMFER_EMISSIVE_INTENSITY}
          />
        </instancedMesh>

        {/* ---- 接缝接触式 AO 暗环（20 实例）---- */}
        <instancedMesh
          ref={creviceAoInstancesRef}
          args={[undefined, undefined, CREVICE_AO_INSTANCE_MAX]}
          raycast={noRaycast}
          frustumCulled={false}
        >
          {/* 单位圆环（外半径 1），实际大小由矩阵缩放控制 */}
          <ringGeometry args={[PILLAR_SIZE * 0.45, PILLAR_SIZE * 0.95, 4]} />
          <meshBasicMaterial
            color={CREVICE_AO_COLOR}
            transparent
            opacity={CREVICE_AO_OPACITY * 0.8}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </instancedMesh>

        {/* ---- 重型机械铆钉（8 实例）---- */}
        <instancedMesh
          ref={rivetInstancesRef}
          args={[undefined, undefined, RIVET_INSTANCE_MAX]}
          raycast={noRaycast}
          frustumCulled={false}
        >
          <cylinderGeometry args={[RIVET_RADIUS, RIVET_RADIUS * 1.35, RIVET_HEIGHT, 8]} />
          <meshStandardMaterial
            color={RIVET_COLOR}
            metalness={RIVET_METALNESS}
            roughness={RIVET_ROUGHNESS}
            envMapIntensity={RIVET_ENV_INTENSITY}
          />
        </instancedMesh>
      </group>

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
          metalness={TI_METALNESS}
          roughness={TI_ROUGHNESS}
          roughnessMap={brushedMetal?.roughnessMap ?? null}
          bumpMap={brushedMetal?.bumpMap ?? null}
          bumpScale={BRUSH_BUMP_SCALE}
          envMapIntensity={TI_ENV_INTENSITY}
          emissive={HARDWARE_EMISSIVE}
          emissiveIntensity={HARDWARE_EMISSIVE_INTENSITY}
        />
        <Edges threshold={15} color="#38bdf8" />
      </RoundedBox>

      {/*
       * 说明：底座倒角与四角铆钉已改为实例化渲染，
       * 见下方 chamferInstancesRef / rivetInstancesRef。
       */}


      {/* ---- 4 层水平服务器托盘隔板（Y 坐标与 Pod 槽位层位同源，推导见常量 JSDoc）。
          【本轮升级】层板改为拉丝钛合金 + 前沿倒角亮边 + 与立柱交界处接缝 AO。
          隔板从"暗色薄片"变为"承重金属托架"，是机架内部结构感的主要来源。
          【raycast 关闭】层板横贯整个腔体，是「挡住 Pod 拾取」风险最高的部件：
          斜视时射线常先命中 Pod 下方的隔板边缘。关闭后 Pod 直接被拾取，
          不必再依赖让位协议从命中列表里"翻"出 Pod。 ---- */}
      {TIER_DIVIDER_YS.map((tierY, index): ReactNode => (
        <group key={`divider-${index}`}>
          <mesh position={[0, tierY, 0]} receiveShadow raycast={noRaycast}>
            <boxGeometry args={[RACK_BODY_SIZE[0] - 0.16, 0.055, RACK_BODY_SIZE[2] - 0.14]} />
            <meshStandardMaterial
              color="#1e293b"
              metalness={TI_METALNESS}
              roughness={TI_ROUGHNESS}
              roughnessMap={brushedMetal?.roughnessMap ?? null}
              bumpMap={brushedMetal?.bumpMap ?? null}
              bumpScale={BRUSH_BUMP_SCALE}
              envMapIntensity={TI_ENV_INTENSITY}
              emissive="#0e7490"
              emissiveIntensity={0.06}
            />
          </mesh>

          {/*
           * 说明：层板前沿倒角与层板-立柱接缝 AO 已改为实例化渲染，
           * 见文件下方的 chamferInstancesRef / creviceAoInstancesRef。
           */}

          {/*
           * ---- 层板正面发光灯眉（4 层科技抽屉的视觉分界线，**前后双面各一条**）----
           *
           * 【解决什么】没有灯带时四层隔板在暗场里几乎是同一块深色，
           * 机架正面读不出"分层"结构，Pod 看起来悬浮在虚空里。
           *
           * 【为何必须前后双面】机架 rotationY = α + π，三座机架朝向相机的那一面
           * 在局部 +Z 与 −Z 之间交替：rackIndex 0（angle 0）的 −Z 面朝相机，
           * rackIndex 1/2（120°/240°）的 +Z 面朝相机。只装单面时，
           * 总有一座机架的正面是"没有灯眉的空白背板"。
           * 前后各一条后，任何机位看到的每座机架都拥有完整的 4 层横向灯带。
           */}
          <mesh position={[0, tierY, RACK_BODY_SIZE[2] / 2 - 0.05]} raycast={noRaycast}>
            <boxGeometry args={[RACK_BODY_SIZE[0] - 0.42, 0.016, 0.016]} />
            <meshBasicMaterial
              ref={(mat): void => {
                tierBandMatsRef.current[index * 2] = mat;
              }}
              color={statusColor}
              toneMapped={false}
              transparent
              opacity={emphasized ? 0.95 : 0.62}
              depthWrite={false}
            />
          </mesh>
          <mesh position={[0, tierY, -(RACK_BODY_SIZE[2] / 2 - 0.05)]} raycast={noRaycast}>
            <boxGeometry args={[RACK_BODY_SIZE[0] - 0.42, 0.016, 0.016]} />
            <meshBasicMaterial
              ref={(mat): void => {
                tierBandMatsRef.current[index * 2 + 1] = mat;
              }}
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
          metalness={TI_METALNESS}
          roughness={TI_ROUGHNESS}
          roughnessMap={brushedMetal?.roughnessMap ?? null}
          bumpMap={brushedMetal?.bumpMap ?? null}
          bumpScale={BRUSH_BUMP_SCALE}
          envMapIntensity={TI_ENV_INTENSITY}
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
          metalness={TI_METALNESS}
          roughness={TI_ROUGHNESS}
          roughnessMap={brushedMetal?.roughnessMap ?? null}
          bumpMap={brushedMetal?.bumpMap ?? null}
          bumpScale={BRUSH_BUMP_SCALE}
          envMapIntensity={TI_ENV_INTENSITY}
          emissive={HARDWARE_EMISSIVE}
          emissiveIntensity={HARDWARE_EMISSIVE_INTENSITY}
        />
        <Edges threshold={15} color="#38bdf8" />
      </RoundedBox>

      {/*
       * ---- 顶冠内嵌散热格栅（本轮由"青色发光板"改为"暗金灰凹槽"）----
       *
       * 【修复什么】此前这里是一块 opacity 0.5 的 #22d3ee 发光板，
       * 经 Bloom 放大后成了一整片刺眼的亮青色"游泳池"——顶盖完全过曝，
       * 机柜看起来像顶着一块塑料板。
       *
       * 【改为】深邃重工暗金灰凹槽顶盖：基本不发光，只靠金属度与粗糙度
       * 在场景光下形成沉稳哑光面；该有的高光交给顶冠中心的光纤接口细环
       * 与收敛后的落束光斑（BEAM_BLOOM_SIZE 1.9 → 0.85）。
       * 顶盖因此读起来是"厚重的金属散热模组"，而不是"一块发光贴片"。
       */}
      <mesh position={[0, CROWN_Y + CROWN_HEIGHT / 2 + 0.012, 0]} raycast={noRaycast} visible={!isGltfRackAvailable}>
        <boxGeometry args={[CROWN_WIDTH - 0.42, 0.02, CROWN_DEPTH - 0.42]} />
        <meshStandardMaterial
          color="#091326"
          metalness={HARDWARE_METALNESS}
          roughness={HARDWARE_ROUGHNESS}
          envMapIntensity={HARDWARE_ENV_MAP_INTENSITY}
          emissive="#0e7490"
          emissiveIntensity={0.06}
        />
      </mesh>

      {/*
       * ---- 顶冠激光蚀刻散热百叶窗（替代原来的"整块发光板"）----
       *
       * 【解决什么】顶冠凹槽此前是一整块暗色平面，俯瞰时看起来像"贴了一块黑胶布"，
       * 既没有工业感也读不出"这是散热口"。
       *
       * 【做法】用 9 条等距细长薄片（百叶窗叶片）铺在凹槽内，
       * 每条都有独立的高光棱边——斜视时叶片与缝隙形成交替的明暗条纹，
       * 这正是真实机柜散热格栅在光照下的样子。
       * 数量取 9：小于 7 会显得稀疏像栅栏，大于 11 在远视距会糊成一片灰。
       *
       * 【为何不用纹理贴图】这 9 条叶片是**真实几何**，能真正接收环境反射
       * 与阴影；贴图在俯瞰近距离下会被看穿是平的。9 个 box = 9 次 draw call，
       * 对当前场景预算完全可接受。
       */}
      {Array.from({ length: LOUVER_COUNT }, (_, louverIndex): ReactNode => {
        const louverWidth = CROWN_WIDTH - 0.5;
        const louverDepth = (CROWN_DEPTH - 0.5) / LOUVER_COUNT;
        /* 居中排布：让整组叶片对称占据凹槽宽度 */
        const offsetZ = (louverIndex - (LOUVER_COUNT - 1) / 2) * louverDepth;
        return (
          <mesh
            key={`crown-louver-${louverIndex}`}
            position={[0, CROWN_Y + CROWN_HEIGHT / 2 + 0.026, offsetZ]}
            raycast={noRaycast}
            visible={!isGltfRackAvailable}
          >
            <boxGeometry args={[louverWidth, LOUVER_THICKNESS, louverDepth * 0.62]} />
            <meshStandardMaterial
              color={LOUVER_COLOR}
              metalness={LOUVER_METALNESS}
              roughness={LOUVER_ROUGHNESS}
              envMapIntensity={LOUVER_ENV_INTENSITY}
            />
          </mesh>
        );
      })}

      {/*
       * 说明：顶冠上下四周边框倒角已改为实例化渲染，
       * 见下方 chamferInstancesRef。
       */}


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
          <shaderMaterial
            uniforms={harnessUniforms}
            vertexShader={HARNESS_VERTEX_SHADER}
            fragmentShader={HARNESS_FRAGMENT_SHADER}
            transparent
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
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

      {/*
       * ---- 背面导光柱（局部 −Z 侧，与正面镜像对称）----
       *
       * 【解决什么】rackIndex 0 的 rotationY = π，其局部 −Z 面朝向主相机；
       * 若只在 +Z 侧装导光柱，alpha 整座机架从默认机位看完全没有垂直光柱。
       * 这里补上 −Z 侧的一对，使三座机架无论哪面朝相机都拥有完整光柱。
       * 颜色由 useFrame 用与正面相同的 target/alpha 同步 lerp，前后不会脱节。
       */}
      <mesh position={[-RACK_LIGHT_GUIDE_X, RACK_BODY_CENTER_Y, -LIGHT_GUIDE_Z]} raycast={noRaycast}>
        <boxGeometry args={[0.11, LIGHT_GUIDE_HEIGHT, 0.11]} />
        <meshBasicMaterial
          ref={backGuideMatLeft}
          color="#10b981"
          toneMapped={false}
          transparent
          opacity={GUIDE_BASE_OPACITY}
        />
      </mesh>
      <mesh position={[RACK_LIGHT_GUIDE_X, RACK_BODY_CENTER_Y, -LIGHT_GUIDE_Z]} raycast={noRaycast}>
        <boxGeometry args={[0.11, LIGHT_GUIDE_HEIGHT, 0.11]} />
        <meshBasicMaterial
          ref={backGuideMatRight}
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
            ref={plinthGlowRef}
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
        /*
         * 【位置：机柜侧前方暗区】x 偏到机架右侧（局部 +X 1.18），Z 略向前。
         *
         * 旧的 [0, 0.06, -(深度/2 + 0.72)] 正压在机柜中轴正前方：
         * 铭牌与机柜正面的刀片槽位在同一视觉轴线上，互相抢视线，
         * 且三台机架绕环分布时，正前方铭牌会朝不同方向、构图很乱。
         * 移到侧前方后：它落在机柜与环外之间的"暗区"里，
         * 既不遮挡刀片，也不会与相邻机架的铭牌在屏幕上重叠。
         *
         * Y = 0.06 仍低于第一层刀片底面（0.09），绝不遮挡任何 Pod。
         */
        position={[1.18, 0.06, -(RACK_BODY_SIZE[2] / 2 + 0.58)]}
        center
        distanceFactor={17}
        zIndexRange={[10, 0]}
        className="pointer-events-none"
      >
        {/*
         * ---- 光学玻璃拟态节点 HUD（本轮重构）----
         *
         * 【排版升级的三个要点】
         * 1. **顶部微标尺** `NODE // RACK-0X`——把面板从"信息卡片"
         *    变成"测量仪表"。rackIndex + 1 补零成两位数，
         *    与真实机柜的 01/02/03 编号习惯一致。
         * 2. **节点名改用现代无衬线**：`font-semibold tracking-wider text-white`。
         *    上一版用 font-mono 加粗，等宽字体在标题位置会显得"机器打字机"，
         *    缺少展陈级设备那种克制的现代感。等宽只留给**数字**。
         * 3. **数值严格等宽**：MiniBar 内部已是 `font-mono tabular-nums`，
         *    外层不再包 font-mono（否则会污染标题的正文字体）。
         *
         * 【在线呼吸点】紧贴节点名左侧——它是"活着的系统"最轻量的信号，
         * 比任何文字都更快被余光捕捉到；放在名字左侧而非标尺行，
         * 是为了让它与"这个节点"语义绑定，而不是与"这块面板"绑定。
         */}
        <HoloFrame
          accent={statusColor}
          glow={emphasized}
          rulerLabel={`NODE // RACK-${String(node.rackIndex + 1).padStart(2, '0')}`}
        >
          {/* 第一行：身份 + 状态徽标 + 容器数 */}
          <div className="flex items-center gap-1 whitespace-nowrap">
            {/* 在线呼吸点：紧贴节点名左侧，颜色 = 状态色 */}
            <span
              className="h-1 w-1 shrink-0 rounded-full animate-glow-pulse"
              style={{ backgroundColor: statusColor, boxShadow: `0 0 5px ${statusColor}` }}
            />
            <span className="text-[9.5px] font-semibold tracking-wider text-white">
              {node.name}
            </span>
            <span
              className="ml-auto rounded-[1px] border px-1 text-[7px] font-semibold tracking-[0.10em]"
              style={{ borderColor: `${statusColor}66`, color: statusColor }}
            >
              {statusBadgeLabel}
            </span>
            <span className="font-mono text-[7px] tabular-nums tracking-[0.10em] text-slate-500">
              {node.podIds.length} PODS
            </span>
          </div>

          {/* 第二行：CPU / MEM 分段微米级进度条（含发光游标） */}
          <div className="mt-1 flex items-center gap-2">
            <MiniBar label="CPU" value={node.cpuUsage} />
            <MiniBar label="MEM" value={node.memUsage} tone="#38bdf8" />
          </div>
        </HoloFrame>
      </Html>
    </group>
  );
}