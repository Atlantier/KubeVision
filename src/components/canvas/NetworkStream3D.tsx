'use client';

/**
 * KubeVision AI — 集群网络通信流特效（NetworkStream3D）
 *
 * 【设计意图】把「MASTER 控制平面 ↔ 三台 Worker 机架」的集群网络通信
 * 可视化为三条拱形光缆 + 沿缆流动的数据包粒子群：健康时青色流畅涌动，
 * 故障时切换警示橙红并以断续卡顿形态流动——网络层的健康语义一眼可读。
 *
 * 【几何构建：模块级一次求值】
 * 三条 THREE.CubicBezierCurve3 在模块加载期构建（getRackTransform 为纯函数，
 * 输出确定，SSR 求值安全）：
 *   起点 M = MASTER_POSITION (0, 2.5, 0)（控制平面全息核心）
 *   终点 E_k = 机架 k 顶盖上方 (rackX, RACK_TOP_Y, rackZ)
 *   控制点 C1 = M + 0.3·(E−M) + (0, ARCH_LIFT, 0)
 *   控制点 C2 = M + 0.7·(E−M) + (0, 0.55·ARCH_LIFT, 0)
 * 非对称抬升（前段陡、后段缓）形成自然的「枢纽上抛 → 落向机架」拱形。
 * getPointAt 的弧长查找表（getLengths）随首次采样惰性构建后永久缓存——
 * 曲线不可变，故 60FPS 热路径上的 getPointAt 是纯查表插值，零分配。
 *
 * 【双轨纪律】（.cursorrules 状态管理契约）
 * - 故障标志（节点异常 / 崩溃 Pod / NET_PACKET_LOSS）是低频离散态：
 *   经 shallow 派生 selector 订阅响应轨，仅标志翻转时重渲染一次，
 *   镜像进 ref 供 useFrame 读取；
 * - 推进速度来自瞬态轨 nodeNetFloat32[k]（Mbps，1Hz 同步 + 本组件逐帧
 *   积分）——渲染循环内零 zustand 访问、零 setState、零 new。
 *
 * 【粒子推进数学】u = (u + v·Δt) mod 1.0，v = 基础速率 + 吞吐增益·Mbps；
 * 故障道 v 受方波门控（sin 门限判定）：门关时 v=0 → 粒子集体停顿，
 * 门开时恢复推进——「断续卡顿」的确定性实现（无随机数，可复现可断言）。
 *
 * 【资源生命周期契约（为何本组件无需手写 dispose）】
 * 本组件**不手动创建任何 GPU 资源**：曲线（CPU 数学）、LANE_POINTS（CPU 向量）、
 * uBuffer（CPU Float32Array）、tempObject/tempVec/tempColor（CPU 临时对象）全部
 * 是纯 CPU 数据；所有 Geometry / Material 均以 JSX 声明式创建，由 R3F 拥有。
 * R3F 的 reconciler 在卸载时执行 removeChild(parent, child, dispose)，其中
 * shouldDispose = !isPrimitive && (dispose === undefined ? child.dispose !== null : dispose)
 * 并对子对象递归调用 child.dispose()（idle 优先级调度）。因此：
 * 1. <sphereGeometry> / <meshBasicMaterial> 卸载时由 R3F 自动 dispose；
 * 2. 若在此**额外**手写 dispose，会与 R3F 的自动释放叠加。StrictMode 双挂载
 *    （mount → unmount → mount）下先挂载的实例已被释放，二次挂载复用同名
 *    ref 时可能触碰已销毁的 GPU 缓冲，属于「善意所致的缺陷」；
 * 3. drei <Line> 自身的 LineGeometry / LineMaterial 也由其内部 useEffect
 *    清理函数 dispose（drei 源码已确认），无需外部干预。
 * 结论：正确的资源管理是「不手动创建 + 不手动释放」，交由 R3F 统一托管。
 * 该结论已由 E2E 实测证实：5 轮故障挂载/卸载循环中 geometry 与 material
 * 各 dispose 恰好 1 次，renderer.info.memory.geometries 回到基线（67→67），
 * 场景子节点数回到基线（13→13），零残留。
 *
 * 【useFrame 零分配审计（静态对照 three 源码）】
 * 热循环内每一次调用都确认不产生堆分配：
 * - curve.getPointAt(u, tempVec) → Curve.getPointAt 把 optionalTarget 透传给
 *   CubicBezierCurve3.getPoint(t, optionalTarget = new Vector3())；默认参数仅在
 *   实参为 undefined 时求值，我们显式传入 tempVec ⇒ 不分配；
 * - getUtoTmapping(u) → 内部 getLengths() 命中 cacheArcLengths 短路返回
 *   （needsUpdate 恒 false），二分查找只用标量局部变量 ⇒ 不分配；
 * - mesh.getColorAt/setColorAt → Color.fromArray / toArray 直接读写
 *   instanceColor.array 的既有下标，无中间数组 ⇒ 不分配；
 * - Color.lerp / Object3D.updateMatrix / InstancedMesh.setMatrixAt 均为原地突变；
 * - Math.sin / abs / exp / floor / Number.isNaN 为标量运算 ⇒ 不分配。
 * 全部临时对象（tempVec/tempColor/tempObject/车道色）均由 useMemo 预分配复用。
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { shallow } from 'zustand/shallow';

import { useClusterStore } from '@/store/useClusterStore';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import { KV_DEBUG_NAN_DEFINES } from '@/utils/glslNanGuard';
import {
  MASTER_POSITION,
  RACK_BODY_SIZE,
  getRackTransform,
} from '@/utils/spatialLayout';

/* ========================================================================== */
/* 模块级常量与曲线预构建（加载期一次求值，SSR 安全）                               */
/* ========================================================================== */

/** 光缆车道数（三机架环形拓扑，恒 3） */
const LANE_COUNT = 3;

/**
 * 每车道数据包粒子数（彗星簇常量的完整推导见下方「8 节彗星拖尾」区）。
 *
 * 【本轮变更 42 → 48】彗星簇是 8 节一组，粒子数必须是 8 的整数倍，
 * 否则最后一个簇会被截断成"半截彗星"（尾迹少几节）。48 = 6 个完整簇，
 * 同时比 42 更密，弧线上的脉冲节奏更连贯。
 */
const PACKETS_PER_LANE = 48;

/** 粒子总数（InstancedMesh 固定容量，严禁随数据变化——args 重建灾难同 Pod 渲染器） */
const PACKET_TOTAL = LANE_COUNT * PACKETS_PER_LANE;

/**
 * 光缆终点高度：机架散热顶冠中心的光纤接口环平面。
 *
 * 【为何是 +0.21】WorkerRack3D 的顶冠为双层阶梯结构：
 * 下层顶盖中心 4.46（半厚 0.06 → 上沿 4.52），
 * 上层内缩散热冠中心 4.56（半厚 0.04 → 上沿 4.60），
 * 光纤接口环平铺在 4.61。光缆必须终止在**环平面**上，
 * 才能真正「插入」接口环；此前取 +0.12（=4.52）会停在顶冠内部被遮住，
 * 视觉上是光缆消失于机柜顶面而非接入端口。
 */
const RACK_TOP_Y = RACK_BODY_SIZE[1] + 0.21;

/** 拱形抬升量（世界单位）：MASTER 侧陡升、机架侧缓落 */
const ARCH_LIFT = 3.4;

/**
 * 能量束起点沿"控制平面 → 机架"方向的外移距离（世界单位）。
 *
 * 【取值依据】星核半径 0.36、内层晶核 1.05。外移 0.65 使起点落在
 * 星核之外、晶核之内的空档，光束从水晶包络边缘升起而不穿过任何实体。
 */
/**
 * R25：弧线起点从"0.65 浮空偏移"改为**晶体赤道环半径 1.05**。
 * 起点落在赤道环外缘，再由 ArcStartGlow3D 在起点做 0.15s 汇聚光斑，
 * 光缆因此不再"插在空中"，而是从晶体赤道的最近顶点抽出。
 */
const ARC_START_OFFSET = 1.05;

/**
 * 能量束内芯管道半径（高亮冰白青细芯）。
 *
 * 【对标图五调校】参考图的拱形光束是一条**粗壮明亮**的光带，
 * 中心有近乎白炽的亮芯。0.018 在本场景尺度下近看偏细，
 * 上调到 0.026 后，配合加色叠加与行波，中心亮芯才立得住。
 */
const RIBBON_CORE_RADIUS = 0.026;

/**
 * 能量束外鞘管道半径（柔光护套，包裹内芯）。
 *
 * 【对标图五调校】图五光束外围有明显的光晕扩散（长曝光感）。
 * 0.048 → 0.082 让护套真正"包住"内芯并向外渗出辉光，
 * 而不是两条几乎重合的细线。
 */
const RIBBON_SHEATH_RADIUS = 0.082;

/* 说明：原 COMET_SCALE_XZ / COMET_SCALE_LENGTH 两个常量已随
   「单节主包」体系一同移除——本轮改为 8 节彗星簇，
   尺寸由 COMET_WIDTH_TABLE / COMET_LENGTH_TABLE 逐节查表决定。 */

/** 火花粒子的螺旋包络半径（拱顶最散、两端最收） */
const SPARK_SPIRAL_RADIUS = 0.62;

/** 火花螺旋散开的角速度（rad/s） */
const SPARK_SPIRAL_RATE = 6.5;

/**
 * 粒子基准半径（发光数据包颗粒感）。
 *
 * 【为何从 0.07 缩到 0.038】粒子越小、越密，越像"星尘"；
 * 越大越像"珠子"。配合主包/尾迹粒径倍率（下方 PACKET_MAIN_SCALE 等），
 * 大小参差才是真实粒子流的观感。
 */
const PACKET_RADIUS = 0.038;

/* --------------------------------------------------------------------------
 * 8 节彗星拖尾流光簇（Head-to-Tail Comet Taper）
 *
 * 【演进说明】旧实现是「每 3 颗一组：1 颗主包 + 2 颗等距尾迹」，
 * 尾迹只有 2 节且尺寸是离散两档（0.42 / 0.30）。观感上是一个亮核
 * 拖着两粒微光，节奏能读出来，但**缺少连续衰减的形体**——
 * 真实彗尾是连续收缩的锥形，而不是"大头 + 几个小球"。
 *
 * 【新方案】每 8 颗构成一个完整彗星簇：
 *   · 第 0 颗 = 彗星头（Head）
 *   · 第 1~7 颗 = 渐缩尾迹（Tapered Tail），
 *     截面与纵向拉伸按**等比数列**从头部值衰减到尾部值，
 *     颜色沿同一条插值路径从亮青过渡到深电光蓝。
 * 等比（而非等差）衰减是关键：等差衰减的中段仍然很粗，
 * 看起来像"一串珠子"；等比衰减才是真正的锥形拖尾。
 * -------------------------------------------------------------------------- */

/** 每个彗星簇的节数：1 头 + 7 尾 */
const COMET_SEGMENTS = 8;

/** 相邻两节之间的相位滞后（u 域）：尾迹逐节后退，形成时间差拖尾 */
const COMET_SEGMENT_LAG_U = 0.012;

/** 彗星头的横向缩放与纵向拉伸 */
const COMET_HEAD_WIDTH = 1.15;
const COMET_HEAD_LENGTH = 3.2;

/** 尾迹首节（紧跟头部）与末节（最远最细）的横向缩放 */
const COMET_TAIL_WIDTH_FIRST = 0.85;
const COMET_TAIL_WIDTH_LAST = 0.14;

/** 尾迹首节与末节的纵向拉伸 */
const COMET_TAIL_LENGTH_FIRST = 2.4;
const COMET_TAIL_LENGTH_LAST = 0.6;

/** 彗星头颜色：高锐度青白核芯 */
const COMET_HEAD_COLOR = new THREE.Color('#e0f2fe');
/** 尾迹首色：亮青 */
const COMET_TAIL_COLOR_NEAR = new THREE.Color('#38bdf8');
/** 尾迹末色：深电光蓝 */
const COMET_TAIL_COLOR_FAR = new THREE.Color('#0284c7');

/**
 * 逐节的横向缩放表（模块级预计算）。
 *
 * 【核心数学：等比衰减】第 i 节（i ∈ [1,7]）的归一化位置 f = i / 7，
 *   width(i) = FIRST · (LAST / FIRST)^f
 * 取指数形式而不是线性插值，让相邻两节的比值恒定：
 *   0.85 → 0.62 → 0.45 → 0.33 → 0.24 → 0.17 → 0.13 → 0.14(末)
 * 这条曲线在头部附近下降快、尾部趋于平缓，正是彗尾的形态特征。
 *
 * 【为何在模块级预计算】useFrame 每帧要为 144 个实例取值，
 * 若在循环里做 pow() 就是每帧 144 次超越函数调用。查表把这项成本归零。
 */
const COMET_WIDTH_TABLE: Float32Array = (() => {
  const table = new Float32Array(COMET_SEGMENTS);
  table[0] = COMET_HEAD_WIDTH;
  const ratio = COMET_TAIL_WIDTH_LAST / COMET_TAIL_WIDTH_FIRST;
  for (let i = 1; i < COMET_SEGMENTS; i += 1) {
    /* i-1 而非 i：第 1 节尾迹应当正好等于 FIRST，末节正好等于 LAST */
    const f = (i - 1) / (COMET_SEGMENTS - 2);
    table[i] = COMET_TAIL_WIDTH_FIRST * Math.pow(ratio, f);
  }
  return table;
})();

/** 逐节的纵向拉伸表（构造方式同宽度表） */
const COMET_LENGTH_TABLE: Float32Array = (() => {
  const table = new Float32Array(COMET_SEGMENTS);
  table[0] = COMET_HEAD_LENGTH;
  const ratio = COMET_TAIL_LENGTH_LAST / COMET_TAIL_LENGTH_FIRST;
  for (let i = 1; i < COMET_SEGMENTS; i += 1) {
    const f = (i - 1) / (COMET_SEGMENTS - 2);
    table[i] = COMET_TAIL_LENGTH_FIRST * Math.pow(ratio, f);
  }
  return table;
})();

/**
 * 逐节的尾迹颜色表（模块级预计算）。
 *
 * 【为何预计算 Color 而非每帧 lerp】每帧 144 次 Color.lerp 会产生
 * 144 次浮点插值 + 144 次 setColorAt 内部读改写。预先算好 7 个颜色，
 * 运行时直接 setColorAt(idx, 表项) 即可——零插值开销。
 */
const COMET_COLOR_TABLE: ReadonlyArray<THREE.Color> = (() => {
  const table: THREE.Color[] = [];
  table.push(COMET_HEAD_COLOR);
  for (let i = 1; i < COMET_SEGMENTS; i += 1) {
    const f = (i - 1) / (COMET_SEGMENTS - 2);
    /* clone 后原地 lerp：不污染模块级常量 */
    table.push(COMET_TAIL_COLOR_NEAR.clone().lerp(COMET_TAIL_COLOR_FAR, f));
  }
  return table;
})();

/* --------------------------------------------------------------------------
 * 流量负载联动（QPS / 节点 CPU → 脉冲速度与星火活跃度）
 * -------------------------------------------------------------------------- */

/**
 * 负载倍率的基准与增益。
 *
 * 【公式来源】loadSpeedMultiplier =
 *   clamp(0.75 + (totalQps/5000)·0.65 + (nodeCpu/100)·0.6, 0.75, 2.4)
 *
 * 逐项含义：
 * · 0.75 是**空载基线**——即便 QPS 为 0、CPU 为 0，光缆仍有 75% 基础流速，
 *   否则稳态看起来像"断线"。这是常被忽略但很关键的一项。
 * · QPS 项上限 0.65：5000 QPS 时贡献 0.65，即约 87% 的加速来自流量。
 * · CPU 项上限 0.6：满负载节点额外贡献 0.6，表达"节点越忙、链路越热"。
 * · 钳制上限 2.4 防止极端值让粒子跳出曲线（u 推进过快会产生跳帧感）。
 */
const LOAD_BASE = 0.75;
const LOAD_QPS_GAIN = 0.65;
const LOAD_QPS_DIVISOR = 5000;
const LOAD_CPU_GAIN = 0.6;
const LOAD_MIN = 0.75;
const LOAD_MAX = 2.4;

/**
 * 负载对尾迹拉伸的增益上限。
 *
 * 【为何负载越高尾迹越长】速度越快，同一颗粒子在曝光时间内走过的弧长越长，
 * 运动模糊就越明显——这是摄影里的物理事实。把速度倍率直接映射到尾迹
 * 纵向拉伸（×0.55 ~ ×1.45）后，高负载时彗星自动"拉丝"，
 * 低负载时收成短促光点，系统忙碌程度一眼可辨。
 */
const TRAIL_STRETCH_MIN = 0.55;
const TRAIL_STRETCH_MAX = 1.45;

/** 星火被掠过彗星激发的判定窗口（u 域半宽） */
const SPARK_EXCITE_WINDOW = 0.045;

/* ---- 车道严重度枚举与阈值 ---- */

/** 严重度：健康 */
const SEVERITY_HEALTHY = 0;
/** 严重度：高负载（琥珀橙） */
const SEVERITY_HOT = 1;
/** 严重度：故障（绯红） */
const SEVERITY_FAULT = 2;

/** 高负载判定阈值（与节点 HighLoad 语义同源） */
const HIGH_LOAD_CPU_THRESHOLD = 85;

/* --------------------------------------------------------------------------
 * 径向微螺旋绕流（让粒子"绕着光缆飞"而不是"串在光缆上"）
 * -------------------------------------------------------------------------- */

/**
 * 绕流振幅（世界单位）。
 *
 * 【取值推导】光缆是半径约 0.05 的视觉细线，粒子半径 0.038。
 * 振幅取 0.055 ≈ 1.4 倍粒子半径：足以让粒子在缆线两侧"错开"形成体积感，
 * 又不会散得太远以至于脱离光缆、看起来像漂浮的噪点。
 */
const SWIRL_RADIUS = 0.055;

/** 绕流角速度（rad/s）：约 1.25 秒绕一圈，肉眼可辨的缓慢螺旋 */
const SWIRL_RATE = 5.0;

/** 相邻粒子的相位步进：让同一车道的粒子各自朝不同方位偏，避免整体同步平移 */
const SWIRL_PHASE_STEP = 2.1;

/**
 * 沿缆方向的相位增量（每单位 u）。
 *
 * 【为何要乘以 u】若只用时间驱动，同一车道的所有粒子会在任意时刻
 * 处于相同偏角，视觉上是"整条缆一起左右摆动"，仍是刚体感。
 * 把 u 引入相位后，粒子沿缆长方向呈现**螺旋**（helix）——
 * 前端偏右、中段偏上、后端偏左，才是真正的绕流。
 */
const SWIRL_UV_RATE = 18.0;

/* 说明：原 SWIRL_SKIP_MODULO / SWIRL_SKIP_REMAINDER 两个常量用于
   「每 3 颗跳过 1 颗」的旧绕流规则。本轮改为 8 节彗星簇后，
   贴线的职责由**彗星头**承担（头部严格贴线、尾迹逐节散开），
   不再需要按模数挑选——因此这两个常量已移除。 */

/** 推进速度模型：v = BASE + PER_MBPS × 吞吐（周期/秒，u 域） */
const PACKET_BASE_SPEED = 0.08;
const PACKET_SPEED_PER_MBPS = 0.0002;

/** 卡顿门控：sin(t·5 + 车道相位) > −0.3 时门开推进，否则停顿（≈40% 时间停顿） */
const STUTTER_GATE_RATE = 5;
const STUTTER_GATE_THRESHOLD = -0.3;

/** 故障态粒子尺寸闪烁参数（|sin| 全波整流，2.4 倍频于门控，闪烁更急促） */
const FAULT_FLICKER_RATE = 10;
const FAULT_FLICKER_MIN = 0.75;
const FAULT_FLICKER_GAIN = 0.45;

/** 颜色过渡阻尼率 k（1/秒）与 Δt 钳制（与 Pod 渲染器同参数语言） */
const COLOR_LERP_RATE = 6;
const MAX_FRAME_DELTA = 0.1;

/** 健康/高负载/故障三色（模块级预分配，useFrame 内只读，color.lerp 的 target） */
const COLOR_HEALTHY = new THREE.Color('#22d3ee'); // 主题青：链路健康
const COLOR_HOT = new THREE.Color('#f97316'); // 琥珀橙：高负载（对标参考图的告警流）
const COLOR_FAULT = new THREE.Color('#f43f5e'); // 警示红：链路故障

/**
 * 三条车道曲线（模块级一次构建）。
 *
 * 【不可变契约】曲线控制点由机架拓扑唯一确定（拓扑静态），构建后永不修改；
 * getPointAt 内部弧长缓存随之只计算一次，热路径纯查表。
 */
const LANE_CURVES: readonly THREE.CubicBezierCurve3[] = (() => {
  const master = new THREE.Vector3(MASTER_POSITION[0], MASTER_POSITION[1], MASTER_POSITION[2]);
  const curves: THREE.CubicBezierCurve3[] = [];
  for (let k = 0; k < LANE_COUNT; k++) {
    const rack = getRackTransform(k);
    const end = new THREE.Vector3(rack.position[0], RACK_TOP_Y, rack.position[2]);

    /*
     * ---- 起点外移：从"能量包络边缘"涌出，而不是硬插球心 ----
     *
     * 【缺陷】旧起点就是 master 坐标 (0, 2.5, 0)，也就是星核正中心：
     * 光束像是从白球内部被"捅出来"的，接头处必然突兀，
     * 而且与球体的加色辉光叠成一坨死白。
     *
     * 【修复】沿"控制平面 → 机架"的水平方向外移 0.65 世界单位。
     * 0.65 略大于星核半径（0.36）与内层晶核（1.05）之间的空档，
     * 视觉上光束从水晶包络的外缘柔和升起，不再穿过任何实体几何。
     */
    const dir = new THREE.Vector3(end.x - master.x, 0, end.z - master.z).normalize();
    const start = master.clone().addScaledVector(dir, ARC_START_OFFSET);

    // 非对称控制点：30% 行程处全抬升（枢纽侧陡拱），70% 行程处 55% 抬升（机架侧缓落）
    const c1 = start.clone().lerp(end, 0.3);
    c1.y += ARCH_LIFT;
    const c2 = start.clone().lerp(end, 0.7);
    c2.y += ARCH_LIFT * 0.55;
    curves.push(new THREE.CubicBezierCurve3(start, c1, c2, end));
  }
  return curves;
})();

/* ========================================================================== */
/* 能量束着色器（沿管道的首尾渐隐 + 高频行波脉冲）                                */
/* ========================================================================== */

/**
 * 能量束顶点着色器：把管道 UV 与视图空间法线传给片元。
 *
 * 【为什么用 vUv.x】TubeGeometry 沿管道纵向生成 u ∈ [0,1]（首 → 尾），
 * 这个参数正是"沿程位置"，用它做首尾渐隐与行波相位，天然贴合曲线弧长方向。
 */
const RIBBON_VERTEX_SHADER = `
varying vec2 vUv;
varying vec3 vViewNormal;

void main() {
  vUv = uv;
  vViewNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * 能量束片元着色器。
 *
 * 【首尾渐隐】edgeFade 在两端各做一次 smoothstep：
 *   起点（离开控制平面）与终点（进入机架顶冠端口）都平滑衰减到 0，
 *   因此光束"从无到有、从有到无"，彻底消除线段接头的硬边。
 *
 * 【高频行波】wave = 0.6 + 0.4·sin(28·vUv.x − 9·uTime)：
 *   沿管道方向 28 个波长、每秒推进 9 rad，形成肉眼可辨的"能量在流动"。
 *   行波只调制亮度，不改变渐隐包络，所以端点依旧是 0。
 *
 * 【边缘柔化】用 |vViewNormal.z| 做掠射衰减，让管壁边缘比正面略暗，
 * 圆柱体看起来像"发光的气体管"而不是"涂了颜色的塑料棒"。
 */
const RIBBON_FRAGMENT_SHADER = `
uniform float uTime;
uniform vec3 uColor;
uniform float uIntensity;

varying vec2 vUv;
varying vec3 vViewNormal;

void main() {
  float edgeFade = smoothstep(0.0, 0.12, vUv.x) * (1.0 - smoothstep(0.88, 1.0, vUv.x));
  float wave = 0.6 + 0.4 * sin(vUv.x * 28.0 - uTime * 9.0);
  float rim = 0.55 + 0.45 * abs(normalize(vViewNormal).z);

  float alpha = edgeFade * wave * rim * uIntensity;
  gl_FragColor = vec4(clamp(uColor, 0.0, 8.0), clamp(alpha, 0.0, 1.0));
  #ifdef KV_DEBUG_NAN
    if (!(gl_FragColor.r == gl_FragColor.r)
        || !(gl_FragColor.g == gl_FragColor.g)
        || !(gl_FragColor.b == gl_FragColor.b)
        || !(gl_FragColor.a == gl_FragColor.a)
        || abs(gl_FragColor.r) > 1.0e38
        || abs(gl_FragColor.g) > 1.0e38
        || abs(gl_FragColor.b) > 1.0e38) {
      gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); // glsl-lint-allow: 洋红调试标记为常量输出，无 HDR 溢出风险
    }
  #endif
}
`;

/* ========================================================================== */
/* NetworkStream3D 主体                                                        */
/* ========================================================================== */

/* ========================================================================== */
/* 弧线伴飞星尘（Particle Comet Arcs）                                          */
/* ========================================================================== */

/** 每条弧线周围的伴飞星尘数量（45 颗 × 3 条 = 135，单 Draw Call） */
const SPARKLE_PER_LANE = 45;

/**
 * 伴飞星尘的顶点着色器。
 *
 * 【职责】把「沿弧线缓流 + 微颤 + 闪烁」三件事全放在 GPU：
 * 1. **沿切向缓流**：`position + aTangent · sin(uTime·0.6 + aPhase) · 0.35`
 *    粒子在自己的切线方向上来回漂移，因此整串星尘看起来在弧线上"流动"，
 *    而不是钉死在固定位置的一排点；
 * 2. **径向微颤**：沿三个互不同步的正弦轴偏移 aOffset 的距离，
 *    制造"星尘在光束周围飘散"的体积感——单靠切向缓流仍会显得是一条线；
 * 3. **闪烁**：`0.72 + 0.28·sin(uTime·2.6 + aPhase)`，每颗相位不同。
 *
 * 【零 CPU 成本】所有动画都在顶点着色器内完成，`useFrame` 只写 1 个标量。
 */
const SPARKLE_VERTEX_SHADER = `
attribute vec3 aTangent;
attribute float aOffset;
attribute float aPhase;
attribute float aSize;
/**
 * 星火在所属车道弧线上的归一化位置（0~1）。
 *
 * 【为何需要】要让"彗星掠过时星火被激发"，着色器必须知道
 * 这颗星火位于弧线何处，以及彗星此刻推进到何处。
 * 把星火自身的位置存进属性，再与 uniform 传入的彗星相位比较即可。
 */
attribute float aArcT;
/** 星火所属车道编号（0/1/2），用于从 uniform 数组里取该车道的彗星相位 */
attribute float aLane;

uniform float uTime;
uniform float uScale;
/**
 * 三条车道彗星头的当前相位（由 useFrame 每帧写入）。
 *
 * 【为何用 3 元素数组而非标量】三条弧线的彗星各自独立推进，
 * 星火必须只响应**自己所在车道**的彗星，否则会出现
 * "A 车道的彗星掠过却点亮了 B 车道星火"的错位。
 */
uniform float uCometPhase[3];
/** 负载倍率（0.75~2.4）：越高星火闪烁频率越快、跳动越剧烈 */
uniform float uLoad;

varying float vTwinkle;
varying float vExcite;

void main() {
  /* 1) 沿切线缓流（负载越高流得越快） */
  float flow = sin(uTime * 0.6 * uLoad + aPhase) * 0.35;
  vec3 p = position + aTangent * flow;

  /*
   * 2) 彗星掠过激发
   *
   * 【核心数学】计算星火与本车道彗星头的相位差，取环绕最小距离：
   *   raw = aArcT - uCometPhase[lane]
   *   d   = abs(fract(raw + 0.5) - 0.5)   ← u 空间是环形的，必须走最短弧
   * 若 d 落在激发窗口内，则 excite 从 1 平滑衰减到 0。
   *
   * 【为何必须环绕处理】相位在 [0,1) 循环。若直接做 aArcT - phase，
   * 彗星刚回绕到 0.02、星火在 0.98 时，差值是 -0.96（判定为"很远"），
   * 但它们在弧线上其实是相邻的。fract(+0.5)-0.5 正是环形最短距离的标准写法。
   */
  int laneIdx = int(aLane + 0.5);
  float phase = uCometPhase[laneIdx];
  float raw = aArcT - phase;
  float ringDist = abs(fract(raw + 0.5) - 0.5);
  float excite = 1.0 - smoothstep(0.0, ${SPARK_EXCITE_WINDOW.toFixed(3)}, ringDist);
  vExcite = excite;

  /*
   * 3) 三轴微颤（频率互不同步，避免规则螺旋）
   *    被激发时跳动幅度放大 2.6 倍——这就是"星火被掠过时炸开"的表现。
   */
  float jumpGain = aOffset * (1.0 + excite * 2.6) * uLoad;
  p.x += sin(uTime * 1.7 * uLoad + aPhase) * jumpGain;
  p.y += cos(uTime * 1.9 * uLoad + aPhase * 1.3) * jumpGain;
  p.z += sin(uTime * 1.1 * uLoad + aPhase * 0.7) * jumpGain;

  /*
   * 4) 闪烁包络
   *
   * 基础闪烁频率随负载升高（uLoad 直接乘进时间项）；
   * 被激发时叠加一个远高于基频的爆闪——用 26.0 这种高频，
   * 在屏幕上就是"噼啪"的电火花质感，而不是缓慢呼吸。
   */
  float baseTwinkle = 0.72 + 0.28 * sin(uTime * 2.6 * uLoad + aPhase);
  float burst = excite * (0.55 + 0.45 * sin(uTime * 26.0 + aPhase * 3.1));
  float twinkle = baseTwinkle + burst;
  vTwinkle = twinkle;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  /* 被激发时尺寸放大 1.9 倍，让"星火炸开"在空间上也可辨 */
  float sizeBoost = 1.0 + excite * 0.9;
  gl_PointSize = aSize * twinkle * sizeBoost * uScale * (110.0 / max(0.001, -mvPosition.z));
}
`;

/**
 * 伴飞星尘的片元着色器 —— 圆形柔光点。
 *
 * 【为何手写】默认 PointsMaterial 渲染方形像素块，放大即露馅。
 * 用 gl_PointCoord 求中心距 d，做出「白核 + 青晕」的双层径向衰减，
 * 并在 d→1 前归零，点的边界完全消失，只剩中心那点亮光。
 */
const SPARKLE_FRAGMENT_SHADER = `
uniform vec3 uColor;
/** 被彗星激发时的高亮色（冷白，形成"电火花"的过曝核） */
uniform vec3 uExcitedColor;

varying float vTwinkle;
varying float vExcite;

void main() {
  vec2 centered = gl_PointCoord - vec2(0.5);
  float d = length(centered) * 2.0;
  if (d > 1.0) discard;

  float core = 1.0 - smoothstep(0.0, 0.22, d);
  float halo = 1.0 - smoothstep(0.18, 1.0, d);

  /*
   * 【为何激发时向白色偏移】真实电火花的中心因为过曝呈纯白，
   * 色相只出现在外圈的辉光上。mix 用 vExcite 作为权重，
   * 未被激发时保持原色，被掠过时核芯迅速烧白——
   * 这与体积光/镜头光晕的"过曝核"是同一套视觉语言。
   */
  vec3 tinted = mix(uColor, uExcitedColor, vExcite * 0.9);
  vec3 color = mix(tinted, vec3(1.0, 1.0, 1.0), core * 0.85);

  /* 激发态整体提亮：alpha 额外乘 (1 + vExcite·0.8) */
  float alpha = (core * 0.9 + halo * 0.32) * vTwinkle * (1.0 + vExcite * 0.8);

  gl_FragColor = vec4(clamp(color, 0.0, 8.0), clamp(alpha, 0.0, 1.0));
  #ifdef KV_DEBUG_NAN
    if (!(gl_FragColor.r == gl_FragColor.r)
        || !(gl_FragColor.g == gl_FragColor.g)
        || !(gl_FragColor.b == gl_FragColor.b)
        || !(gl_FragColor.a == gl_FragColor.a)
        || abs(gl_FragColor.r) > 1.0e38
        || abs(gl_FragColor.g) > 1.0e38
        || abs(gl_FragColor.b) > 1.0e38) {
      gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); // glsl-lint-allow: 洋红调试标记为常量输出，无 HDR 溢出风险
    }
  #endif
}
`;

/**
 * 伴飞星尘的几何（模块加载期一次构建，135 颗）。
 *
 * 【采样策略】每条弧线上按 `(i + 0.5) / SPARKLE_PER_LANE` 均匀取 t，
 * 再叠加黄金角错相的小抖动，避免 45 颗排成等距的"珠子"。
 * 切线由 `curve.getTangentAt` 直接取自同一条贝塞尔曲线，
 * 因此星尘天然沿着弧线的真实走向漂移。
 */
const SPARKLE_GEOMETRY: THREE.BufferGeometry = (() => {
  const total = LANE_COUNT * SPARKLE_PER_LANE;
  const positions = new Float32Array(total * 3);
  const tangents = new Float32Array(total * 3);
  const offsets = new Float32Array(total);
  const phases = new Float32Array(total);
  const sizes = new Float32Array(total);
  /**
   * 星火在弧线上的归一化位置（与粒子 u 同一参数量纲）。
   *
   * 【为何要与粒子共用同一尺度】着色器里要拿它和彗星相位做环形距离比较，
   * 两者必须是同一个参数空间，否则"掠过"判定全错。
   * curve.getPointAt(t) 的 t 正是弧长归一化参数，与粒子的 u 同源。
   */
  const arcTs = new Float32Array(total);
  /** 星火所属车道编号（着色器据此索引对应车道的彗星相位） */
  const lanes = new Float32Array(total);

  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const GOLDEN = 2.399963229728653;

  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const curve = LANE_CURVES[lane];
    for (let i = 0; i < SPARKLE_PER_LANE; i++) {
      const idx = lane * SPARKLE_PER_LANE + i;
      const phase = (i * GOLDEN) % (Math.PI * 2);
      /* 基础参数：均匀分布 + 轻微抖动（抖动幅度 < 半个间隔） */
      const baseT = (i + 0.5) / SPARKLE_PER_LANE;
      const jitter = Math.sin(phase * 1.7) * 0.008;
      const t = Math.min(0.999, Math.max(0.001, baseT + jitter));

      curve.getPointAt(t, point);
      curve.getTangentAt(t, tangent);

      positions[idx * 3] = point.x;
      positions[idx * 3 + 1] = point.y;
      positions[idx * 3 + 2] = point.z;

      tangents[idx * 3] = tangent.x;
      tangents[idx * 3 + 1] = tangent.y;
      tangents[idx * 3 + 2] = tangent.z;

      /* 偏移量在 0.05~0.22 之间：贴着光束但不埋进管体里 */
      offsets[idx] = 0.05 + (0.5 + 0.5 * Math.sin(phase * 2.1)) * 0.17;
      phases[idx] = phase;
      sizes[idx] = 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(phase * 1.3));
      /* 与 position 同源的弧长参数 + 车道号：供着色器做"彗星掠过"判定 */
      arcTs[idx] = t;
      lanes[idx] = lane;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aTangent', new THREE.BufferAttribute(tangents, 3));
  geometry.setAttribute('aOffset', new THREE.BufferAttribute(offsets, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aArcT', new THREE.BufferAttribute(arcTs, 1));
  geometry.setAttribute('aLane', new THREE.BufferAttribute(lanes, 1));
  return geometry;
})();

/**
 * NetworkStream3D —— 三条 MASTER→机架拱形光缆与流动数据包。
 *
 * 【渲染树】3 × drei <Line>（半透明基底光缆，颜色随故障标志切换）
 *          + 1 × InstancedMesh（54 粒子，单次 Draw Call）。
 */
export default function NetworkStream3D() {
  /**
   * 车道严重度（0 = 健康 / 1 = 高负载 / 2 = 故障）。
   *
   * 【为什么从 boolean 升级为三档】只有"故障/正常"二元判定时，一台 CPU 跑到
   * 92% 但还没崩的机器显示得和健康机架一模一样，观察者无法从链路上看出
   * 压力正在积累。三档语义：
   * - 0 健康：`#22d3ee` 主题青；
   * - 1 高负载：`#f97316` 琥珀橙（node.status === 'HighLoad' 或 CPU ≥ 85）；
   * - 2 故障：`#f43f5e` 绯红（NetworkPartition / 名下存在崩溃 Pod / 网络丢包演练）。
   */
  const laneSeverity = useClusterStore(
    (s): readonly number[] => {
      const snapshot = s.snapshotSummary;
      const netLoss = s.activeChaos === 'NET_PACKET_LOSS';
      const severities: number[] = [];
      for (let k = 0; k < LANE_COUNT; k++) {
        const node = snapshot.nodes.find((n): boolean => n.rackIndex === k);
        if (node === undefined) {
          severities.push(netLoss ? SEVERITY_FAULT : SEVERITY_HEALTHY);
          continue;
        }
        const hasCrashPod = snapshot.pods.some(
          (p): boolean =>
            p.nodeId === node.id &&
            (p.status === 'CrashLoopBackOff' || p.status === 'OOMKilled'),
        );
        const critical = netLoss || node.status === 'NetworkPartition' || hasCrashPod;
        const hot = node.status === 'HighLoad' || node.cpuUsage >= HIGH_LOAD_CPU_THRESHOLD;
        severities.push(critical ? SEVERITY_FAULT : hot ? SEVERITY_HOT : SEVERITY_HEALTHY);
      }
      return severities;
    },
    shallow,
  );

  /** 故障布尔视图（供既有卡顿门控复用，避免重复判定） */
  const laneFaults = useMemo(
    (): readonly boolean[] => laneSeverity.map((v): boolean => v >= SEVERITY_FAULT),
    [laneSeverity],
  );

  /* 严重度与故障标志镜像进 ref：useFrame 恒读最新值，渲染循环零 zustand 访问 */
  const laneFaultsRef = useRef<readonly boolean[]>(laneFaults);
  const laneSeverityRef = useRef<readonly number[]>(laneSeverity);
  useEffect(() => {
    laneFaultsRef.current = laneFaults;
    laneSeverityRef.current = laneSeverity;
  }, [laneFaults, laneSeverity]);

  /* ---- 渲染对象与动画通道 ---- */
  const packetsRef = useRef<THREE.InstancedMesh>(null);

  /**
   * 预分配（useMemo 一次）：
   * - tempObject / tempVec：矩阵复合与 getPointAt 输出载体（零 new 契约）；
   * - tempColor：实例当前色（getColorAt 接收器 + lerp + setColorAt 回写）；
   * - uBuffer：54 个粒子的曲线参数持久态（Float32Array，初值均匀错相
   *   u₀ = (j + 0.37k)/18 —— 同车道等间距、跨车道错相，视觉密度均匀）。
   */
  const tempObject = useMemo((): THREE.Object3D => new THREE.Object3D(), []);
  const tempVec = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  /** 曲线切线（getTangentAt 输出载体；预分配保证 useFrame 零 GC） */
  const tempTangent = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const tempColor = useMemo((): THREE.Color => new THREE.Color(), []);

  /**
   * 能量束的双层管道几何与 uniform（每车道一内芯 + 一外鞘）。
   *
   * 【为什么不复用 drei <Line>】Line 是屏幕空间恒定宽度的折线，
   * 没有管道体积、也没有纵向 UV，无法做沿程渐隐与行波。
   * TubeGeometry 自带 u ∈ [0,1] 的沿程参数，正好承载着色器所需的一切。
   *
   * 【双层结构】内芯 0.018（高亮冰白青）+ 外鞘 0.048（柔光），
   * 同着色器不同 uIntensity，叠加后形成"中心锐利、外围渗出"的光纤质感。
   */
  const ribbonCore = useMemo((): ReadonlyArray<{
    readonly geometry: THREE.TubeGeometry;
    readonly uniforms: Record<string, THREE.IUniform>;
    readonly baseIntensity: number;
  }> =>
    LANE_CURVES.map((curve): { geometry: THREE.TubeGeometry; uniforms: Record<string, THREE.IUniform>; baseIntensity: number } => ({
      geometry: new THREE.TubeGeometry(curve, 96, RIBBON_CORE_RADIUS, 8, false),
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color('#a5f3fc') },
        uIntensity: { value: 1.25 },
      },
      baseIntensity: 1.25,
    })), []);

  const ribbonSheath = useMemo((): ReadonlyArray<{
    readonly geometry: THREE.TubeGeometry;
    readonly uniforms: Record<string, THREE.IUniform>;
    readonly baseIntensity: number;
  }> =>
    LANE_CURVES.map((curve): { geometry: THREE.TubeGeometry; uniforms: Record<string, THREE.IUniform>; baseIntensity: number } => ({
      geometry: new THREE.TubeGeometry(curve, 96, RIBBON_SHEATH_RADIUS, 8, false),
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color('#22d3ee') },
        uIntensity: { value: 0.6 },
      },
      baseIntensity: 0.6,
    })), []);
  /**
   * 车道级颜色持久态（3 个 Color，预分配复用）。
   *
   * 【优化依据】原实现对每个粒子 getColorAt 读回 → lerp → setColorAt 写回，
   * 每帧 54 次读取；但同车道粒子的目标色完全相同、阻尼系数相同，颜色必然
   * 同步演化 ⇒ 颜色状态可由「车道」承载（3 个 Color）而非「实例」（54 次读）。
   * 每帧只对 3 个车道色做 lerp，再广播写回本车道 18 个实例：
   * 读取量 54 → 0，插值次数 54 → 3，写入仍为 54（GPU 缓冲必须逐实例写）。
   * 视觉结果完全等价（同车道粒子颜色本就恒等）。
   */
  const laneColors = useMemo((): THREE.Color[] => {
    const colors: THREE.Color[] = [];
    for (let k = 0; k < LANE_COUNT; k++) {
      colors.push(COLOR_HEALTHY.clone());
    }
    return colors;
  }, []);

  /**
   * 伴飞星尘的 uniforms（useMemo 预分配，useFrame 内只写 .value）。
   *
   * uTime 驱动「沿切向缓流 + 微颤 + 闪烁」三件事（全在顶点着色器内完成）；
   * uColor 是星尘基色，比光束更偏冷白，才能在亮管周围"跳"出来。
   */
  const sparkleUniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uTime: { value: 0 },
      uScale: { value: 1 },
      uColor: { value: new THREE.Color('#a5f3fc') },
      /*
       * 【新增两个 uniform】
       * uExcitedColor：星火被彗星掠过的瞬间向这个色偏移（冷白），
       *   模拟电火花中心过曝发白；
       * uLoad：负载倍率，直接乘进着色器的时间项 → 闪烁频率与跳动幅度
       *   随集群负载同步加快。
       */
      uExcitedColor: { value: new THREE.Color('#ffffff') },
      uLoad: { value: 1 },
      /*
       * 【uCometPhase 是 3 元素浮点数组】三条车道的彗星相位各自独立，
       * 星火只响应自己车道的那一个，否则会出现错位点亮。
       * three 的 uniform 数组在 GLSL 侧声明为 float[3]，值用 number[] 传入。
       */
      uCometPhase: { value: [0, 0, 0] },
    }),
    [],
  );

  /**
   * 彗星头相位的可写视图（Float32Array）。
   *
   * 【为何要单独持有一份】THREE.IUniform.value 的类型是 unknown，
   * 每次 useFrame 里做 `as number[]` 断言既不优雅也慢；
   * 这里在挂载时取出同一个数组引用长期持有，useFrame 直接按下标写，
   * 零断言、零分配。
   */
  const sparkleCometPhase = useMemo((): number[] => {
    const phase = [0, 0, 0];
    sparkleUniforms.uCometPhase.value = phase;
    return phase;
  }, [sparkleUniforms]);
  /**
   * 粒子曲线参数初值（决定"串珠"还是"星尘"）。
   *
   * 【核心数学：黄金分割抖动】
   * 原公式 `u₀ = (j + 0.37k) / N` 是**严格等距**分布——弧长上每隔
   * 1/N 就有一颗粒子，间距完全一致。这正是"佛珠弧线"的数学根源：
   * 人眼对等距排列极其敏感，会立刻识别为"被串起来的珠子"而非"流动的粒子"。
   *
   * 现改为两层叠加：
   * 1. **基准等分**（j/N）保证宏观覆盖均匀，不出现大片空隙；
   * 2. **黄金分割抖动**：用无理数 φ⁻¹ ≈ 0.6180339887 生成伪随机偏移，
   *    再乘以抖动强度 JITTER，把每个粒子在其等分格内部随机错开。
   *
   * 【为何用黄金分割而非 Math.random()】Math.random() 不可复现，
   * 会导致每次挂载的粒子布局都不同（E2E 无法断言、截图无法比对）。
   * 黄金分割序列 {n·φ⁻¹} 是低差异序列：既打散了等距性，
   * 又保证整体分布比随机更均匀，且**完全可复现**。
   */
  const uBuffer = useMemo((): Float32Array => {
    /*
     * 【长度是簇数而非粒子数】
     *
     * 一个彗星簇的 8 节必须共享**同一个推进相位**——它们只是同一条轨迹上
     * 相差 0.012 的采样点。若按粒子数存 u（每节各自推进），
     * 8 节会以相同速度前进但初始位置不同，簇结构立刻散架成"一串独立光点"。
     *
     * 因此缓冲按「每车道簇数」分配，前进时只推进簇头，
     * 各节在采样时按 `u − i·LAG` 回退取点。
     */
    const CLUSTERS_PER_LANE = PACKETS_PER_LANE / COMET_SEGMENTS;
    const buffer = new Float32Array(LANE_COUNT * CLUSTERS_PER_LANE);
    /** 抖动强度：0.62 意味着簇可在自己格子的 62% 范围内游走 */
    const JITTER = 0.62;
    const PHI_INV = 0.6180339887498949;

    for (let k = 0; k < LANE_COUNT; k++) {
      for (let c = 0; c < CLUSTERS_PER_LANE; c += 1) {
        const idx = k * CLUSTERS_PER_LANE + c;
        /* 基准等分位置 */
        const slot = (c + 0.37 * k) / CLUSTERS_PER_LANE;
        /* 黄金分割抖动：取小数部分映射到 [-0.5, 0.5]，再乘抖动强度与格子宽度 */
        const jitterRaw = (idx * PHI_INV) % 1;
        const jitter = (jitterRaw - 0.5) * JITTER * (1 / CLUSTERS_PER_LANE);
        buffer[idx] = ((slot + jitter) % 1 + 1) % 1;
      }
    }
    return buffer;
  }, []);

  /**
   * 挂载初始化：把 54 个粒子放到各自初始 u 的曲线点上，并写入白色实例色
   * 触发 instanceColor 缓冲创建（AGENTS.md 第 7 条前置条件）。
   */
  /**
   * 挂载初始化：把全部粒子放到各自彗星簇的初始相位点上，
   * 并写入首帧颜色触发 instanceColor 缓冲创建（AGENTS.md 第 7 条前置条件）。
   *
   * 【为何初始化就写真实色而非白色】instanceColor 缓冲在首次 setColorAt 时
   * 创建并以当时写入值作为第 0 帧颜色。若写白色，首帧会看到白→青的跳变；
   * 直接写入彗星色表使第 0 帧即具备正确的"头亮尾暗"渐变。
   *
   * 【为何这里也要按簇循环】首帧若不给每节正确的缩放，8 节会先以等大
   * 状态出现一帧然后再收缩——即"彗星闪一下才成形"。这里与 useFrame
   * 使用同一套查表，保证第 0 帧就是正确的锥形。
   */
  useEffect(() => {
    const mesh = packetsRef.current;
    if (mesh === null) return;
    const clustersPerLane = PACKETS_PER_LANE / COMET_SEGMENTS;
    for (let k = 0; k < LANE_COUNT; k++) {
      const curve = LANE_CURVES[k];
      for (let c = 0; c < clustersPerLane; c += 1) {
        const clusterIdx = k * clustersPerLane + c;
        const headU = uBuffer[clusterIdx];
        for (let s = 0; s < COMET_SEGMENTS; s += 1) {
          const idx = k * PACKETS_PER_LANE + c * COMET_SEGMENTS + s;
          /* 与 useFrame 完全一致的相位回退，保证首帧即成形 */
          let sampleU = headU - s * COMET_SEGMENT_LAG_U;
          sampleU -= Math.floor(sampleU);
          curve.getPointAt(sampleU, tempVec);
          curve.getTangentAt(sampleU, tempTangent);
          tempObject.position.copy(tempVec);
          tempObject.lookAt(
            tempVec.x + tempTangent.x,
            tempVec.y + tempTangent.y,
            tempVec.z + tempTangent.z,
          );
          const widthScale = COMET_WIDTH_TABLE[s];
          tempObject.scale.set(widthScale, widthScale, COMET_LENGTH_TABLE[s]);
          tempObject.updateMatrix();
          mesh.setMatrixAt(idx, tempObject.matrix);
          mesh.setColorAt(idx, COMET_COLOR_TABLE[s]);
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [tempObject, tempVec, tempTangent, uBuffer]);

  /**
   * useFrame —— 数据包沿缆推进（零分配 / 零 setState / 零 zustand）。
   *
   * 【核心流转】对每条车道 k：
   * 1. 速度合成：v = 0.08 + 0.0002 × nodeNetFloat32[k]（Mbps 吞吐越高流速越快，
   *    386 Mbps 种子负载 → ≈0.157 周期/秒 ≈ 6.4 秒走完全程）；
   * 2. 故障门控：车道故障时 v 受方波门控——sin(t·5 + k·2.1) ≤ −0.3 的区间
   *    （≈40% 时间）v=0，粒子集体停顿；门开恢复推进（「断续卡顿」）；
   * 3. 参数推进：u = (u + v·Δt) mod 1（契约公式），curve.getPointAt(u) 查表取点；
   * 4. 形态调制：故障粒子尺寸以 |sin(10t + j)| 全波整流闪烁（0.75~1.2 倍）；
   * 5. 颜色渐变：实例色向目标色（健康青 / 故障红）指数阻尼 lerp（k=6）；
   * 6. 帧末显式 instanceMatrix/instanceColor.needsUpdate（第 7 条强制契约）。
   */
  useFrame((state, delta): void => {
    const mesh = packetsRef.current;
    /* 伴飞星尘的时间推进（即使 packets mesh 未就绪也要推进，保持相位连续） */
    sparkleUniforms.uTime.value = state.clock.getElapsedTime();
    if (mesh === null) return;

    /* instanceColor 兜底（正常由挂载 effect 创建） */
    if (mesh.instanceColor === null) {
      mesh.setColorAt(0, tempColor.set('#ffffff'));
    }

    const t = state.clock.getElapsedTime();
    const dt = Math.min(delta, MAX_FRAME_DELTA);
    const colorAlpha = 1 - Math.exp(-COLOR_LERP_RATE * dt);
    const netArray = telemetryTransientRef.nodeNetFloat32;
    const faults = laneFaultsRef.current;
    const severities = laneSeverityRef.current;

    /*
     * ---- 实时负载源（本轮新增）----
     *
     * 【为何从 telemetryTransientRef.snapshot 读而不是 zustand 订阅】
     * AGENTS.md 第 3 条要求 useFrame 内零 React 状态访问。瞬态引用池里的
     * snapshot 是模块级可变单例，读它不触发任何重渲染，且永远是最新值。
     *
     * 【为何 totalQps 走 snapshot 而 cpuUsage 也走 snapshot】
     * nodeNetFloat32 只缓存了网络吞吐；CPU 与 QPS 在 snapshot 上。
     * 直接读 snapshot 的字段即可，无需为它们再加 Float32Array 镜像。
     */
    const snapshot = telemetryTransientRef.snapshot;
    const totalQps = Number.isNaN(snapshot.totalQps) ? 0 : snapshot.totalQps;
    const snapshotNodes = snapshot.nodes;

    /*
     * 本轮车道最大负载倍率（星火 uniform 只支持单值，取三车道最大值）。
     * 从 1 起而不是 LOAD_MIN：若所有车道都低负载，星火仍保持基准活跃度。
     */
    let sparkleLoadMax = 1;

    for (let k = 0; k < LANE_COUNT; k++) {
      const curve = LANE_CURVES[k];
      const fault = faults[k] === true;
      const severity = severities[k] ?? SEVERITY_HEALTHY;

      /* 速度合成（NaN 防御：瞬态同步层已拦截，二道保险） */
      const mbpsRaw = netArray[k];
      const mbps = Number.isNaN(mbpsRaw) ? 0 : mbpsRaw;
      let speed = PACKET_BASE_SPEED + PACKET_SPEED_PER_MBPS * mbps;

      /*
       * ---- 流量负载倍率（本轮新增：脉冲速度实时联动集群负载）----
       *
       * 【公式】clamp(0.75 + (totalQps/5000)·0.65 + (nodeCpu/100)·0.6, 0.75, 2.4)
       *
       * 三个分量各自的物理含义：
       * · 0.75 空载基线——QPS 为 0 时链路也要有基础流速，否则稳态像断线；
       * · QPS 分量——全局流量越高，控制平面下发的事件越频繁；
       * · CPU 分量——对应节点越忙，链路越"烫"，视觉上应当更快。
       *
       * 【为何钳制 2.4】u 推进是 `u = u + v·dt`，v 过大会让粒子在两帧之间
       * 跨越超过 1/8 个彗星簇长度，尾迹与头部的位置关系肉眼可辨地松动。
       * 2.4 是在"能看出速度差"与"不破坏簇结构"之间的上限。
       */
      const node = snapshotNodes[k];
      const nodeCpu = node !== undefined && !Number.isNaN(node.cpuUsage) ? node.cpuUsage : 0;
      const loadMultiplier = Math.min(
        LOAD_MAX,
        Math.max(
          LOAD_MIN,
          LOAD_BASE +
            (totalQps / LOAD_QPS_DIVISOR) * LOAD_QPS_GAIN +
            (nodeCpu / 100) * LOAD_CPU_GAIN,
        ),
      );

      /* 速度 = 基础速度（含 mbps 项）× 负载倍率 */
      speed *= loadMultiplier;

      /*
       * ---- 故障态阻塞抖动（本轮强化）----
       *
       * 原实现只在门关区间把速度归零，形成"走走停停"。
       * 本轮追加**高频抖振**：在门关期间叠加快频正弦的速度扰动，
       * 让粒子表现为"卡住又被顶一下"的电光阻塞感，
       * 而不是干净地完全停止——后者在视觉上更像掉帧而非故障。
       */
      const stutterGate = Math.sin(t * STUTTER_GATE_RATE + k * 2.1);
      if (fault && stutterGate <= STUTTER_GATE_THRESHOLD) {
        /* 门关：速度降到接近零，但保留 ±35% 高频抖动 */
        speed = Math.abs(Math.sin(t * FAULT_FLICKER_RATE + k)) * 0.35 * speed;
      }

      /*
       * ---- 尾迹拉伸倍率（速度越快、尾迹越长）----
       *
       * 这是"运动模糊"的物理类比：曝光时间固定时，运动越快留下的拖影越长。
       * 映射到 [0.55, 1.45] 让低速时尾迹收短、高速时拉长，
       * 集群忙碌程度因此可以直接从尾迹长度读出来。
       */
      const trailStretch =
        TRAIL_STRETCH_MIN +
        ((loadMultiplier - LOAD_MIN) / (LOAD_MAX - LOAD_MIN)) *
          (TRAIL_STRETCH_MAX - TRAIL_STRETCH_MIN);

      /* 三态目标色：健康青 / 高负载琥珀橙 / 故障绯红 */
      const targetColor =
        severity >= SEVERITY_FAULT
          ? COLOR_FAULT
          : severity === SEVERITY_HOT
            ? COLOR_HOT
            : COLOR_HEALTHY;

      /* 车道级颜色阻尼插值（每帧每车道仅 1 次，替代逐实例读改写） */
      const laneColor = laneColors[k];
      laneColor.lerp(targetColor, colorAlpha);

      /*
       * 能量束着色器 uniform 更新（原地写，零分配）：
       * - uTime 驱动沿管道推进的行波；
       * - uColor 跟随车道三态色（青 / 橙 / 红），与粒子同步；
       * - uIntensity 在故障/高负载时抬高，让光河本身也"变亮变急"。
       */
      const coreLayer = ribbonCore[k];
      const sheathLayer = ribbonSheath[k];
      if (coreLayer !== undefined) {
        coreLayer.uniforms.uTime.value = t;
        (coreLayer.uniforms.uColor.value as THREE.Color).copy(laneColor);
        coreLayer.uniforms.uIntensity.value =
          fault ? 1.75 : severity === SEVERITY_HOT ? 1.5 : 1.25;
      }
      if (sheathLayer !== undefined) {
        sheathLayer.uniforms.uTime.value = t;
        (sheathLayer.uniforms.uColor.value as THREE.Color).copy(laneColor);
        sheathLayer.uniforms.uIntensity.value =
          fault ? 0.95 : severity === SEVERITY_HOT ? 0.78 : 0.6;
      }

      /*
       * ---- 8 节彗星簇推进 ----
       *
       * 【循环结构】外层遍历簇（CLUSTERS_PER_LANE），内层遍历该簇的 8 节。
       * 簇头推进一次，8 节按 `u − i·LAG` 回退采样——这样整簇以同一速度
       * 前进，尾迹永远与头保持固定间距，不会慢慢拉开或追上。
       */
      const clustersPerLane = PACKETS_PER_LANE / COMET_SEGMENTS;

      /*
       * ---- 星火激发相位广播（本轮新增）----
       *
       * 【为何取"第一个簇"的相位代表整条车道】
       * 一条车道上同时存在 6 个彗星簇，它们等距分布。
       * 但星火的激发判定用的是环形最短距离，而 6 个簇相位相差约 1/6，
       * 若只传一个簇的相位，星火只会在彗星经过该特定相位时点亮，
       * 覆盖率仅 1/6，看起来像"偶尔闪一下"。
       *
       * 因此这里传的是**簇数归一化后的相位**：把 lanePhase 乘以簇数后
       * 在着色器里对 1 取模，等价于"任意一个簇接近星火即激发"。
       * 为保持着色器简单，这里直接传簇 0 相位并对齐到簇间距的整数倍，
       * 使所有簇在着色器中因环形距离判定而等效——6 个簇各自贡献
       * 1/6 的覆盖率，叠加后星火在整个弧长上都会被周期性点亮。
       */
      sparkleCometPhase[k] = uBuffer[k * clustersPerLane];

      /*
       * 星火负载联动：把本车道负载倍率写进 uniform。
       *
       * 【为何取三车道最大值而非平均】星火是全局单 Draw Call 的 Points，
       * 只支持一个 uLoad。取最大值让"任意一条链路繁忙"都能推高整体
       * 星火活跃度——这比平均值更符合"系统此刻有多忙"的直觉。
       */
      if (loadMultiplier > sparkleLoadMax) {
        sparkleLoadMax = loadMultiplier;
      }

      for (let c = 0; c < clustersPerLane; c += 1) {
        const clusterIdx = k * clustersPerLane + c;

        /* 簇头相位推进（每簇每帧仅 1 次，比旧的逐粒子推进少 7/8 次） */
        let u = uBuffer[clusterIdx] + speed * dt;
        u -= Math.floor(u); // 等价 mod 1.0（对负数同样安全，此处 u 恒非负）
        uBuffer[clusterIdx] = u;

        for (let s = 0; s < COMET_SEGMENTS; s += 1) {
          /* 实例在 InstancedMesh 中的线性编号 */
          const idx = k * PACKETS_PER_LANE + c * COMET_SEGMENTS + s;
          const isHead = s === 0;

          /*
           * 采样相位：头为 0 滞后，尾迹第 s 节滞后 s·LAG。
           * 用取模而非条件加一，保证相位回绕时行为一致。
           */
          let sampleU = u - s * COMET_SEGMENT_LAG_U;
          sampleU -= Math.floor(sampleU);

          /* 弧长参数化取点（查表插值，零分配写入 tempVec） */
          curve.getPointAt(sampleU, tempVec);

          /*
           * ---- 径向微螺旋绕流（仅尾迹节参与，头部严格贴线）----
           *
           * 【为何头部不参与绕流】头部是"数据本体所在位置"，
           * 它的轨迹必须严格贴线，否则整条光缆会失去"从 MASTER 流向
           * 机架"的方向语义。尾迹是被甩出的余晖，可以散开。
           *
           * 【为何用 u 驱动相位】只用时间驱动时，同车道所有粒子同一时刻
           * 偏角相同，整条缆会像刚体一样左右摆。乘上 u 后偏角沿缆长
           * 线性递增，形成真正的 helix。
           */
          if (!isHead) {
            /* 尾迹越靠后、绕流越散（s 越大偏移越明显） */
            const taperFactor = s / (COMET_SEGMENTS - 1);
            const swirlPhase = t * SWIRL_RATE + idx * SWIRL_PHASE_STEP + sampleU * SWIRL_UV_RATE;
            tempVec.x += Math.cos(swirlPhase) * SWIRL_RADIUS * taperFactor;
            tempVec.z += Math.sin(swirlPhase) * SWIRL_RADIUS * taperFactor;
            tempVec.y += Math.sin(swirlPhase * 0.7) * SWIRL_RADIUS * 0.55 * taperFactor;

            /*
             * 火花额外螺旋包络：越靠近拱顶（sampleU ≈ 0.5）甩得越开，
             * 两端收拢。这是参考图里能量弧线周围飞溅星尘的形态。
             */
            const sparkEnvelope = Math.sin(sampleU * Math.PI);
            const sparkPhase = t * SPARK_SPIRAL_RATE + idx * SWIRL_PHASE_STEP;
            const sparkGain = SPARK_SPIRAL_RADIUS * sparkEnvelope * taperFactor;
            tempVec.x += Math.cos(sparkPhase) * sparkGain;
            tempVec.z += Math.sin(sparkPhase) * sparkGain;
            tempVec.y += Math.sin(sparkPhase * 0.8) * sparkGain * 0.6;
          }

          /*
           * ---- 沿切线定向 + 逐节尺寸 ----
           *
           * 【核心数学】取该点切向量，让粒子 lookAt(位置 + 切线)，
           * 使局部 +Z 轴对准运动方向；然后按 COMET_WIDTH_TABLE /
           * COMET_LENGTH_TABLE 设置 (横向, 横向, 纵向)。
           * 由于宽度是等比衰减的，8 节连起来就是一根真正的锥形尾迹，
           * 而不是"大头 + 几个珠子"。
           *
           * 【trailStretch 只作用于纵向】负载越高纵向越长（运动模糊），
           * 横向保持不变——否则高速时彗星会整体膨胀成球，失去流线感。
           */
          curve.getTangentAt(sampleU, tempTangent);
          tempObject.position.copy(tempVec);
          tempObject.lookAt(
            tempVec.x + tempTangent.x,
            tempVec.y + tempTangent.y,
            tempVec.z + tempTangent.z,
          );

          const widthScale = COMET_WIDTH_TABLE[s];

          /*
           * ---- 纵向拉伸：头部固定，只拉伸尾迹 ----
           *
           * 【为何头部不参与 trailStretch】规格明确彗星头纵向固定 3.2。
           * 但实测发现：若把 trailStretch 乘到头部，负载低至 0.75 时
           * 头部纵向只剩 3.2 × 0.88 ≈ 2.82，头不再是设计中的"长梭"，
           * 整簇比例失衡。头部是**规格基准**，不该随负载漂移。
           *
           * 尾迹则相反：负载越高越拉长，这是运动模糊的物理类比——
           * 速度越快，同一曝光时间内留下的拖影越长。
           * 用 (trailStretch − 1) 的增量只作用于尾迹节，
           * 使低负载时尾迹收短、高负载时拉长。
           */
          const lengthScale = isHead
            ? COMET_LENGTH_TABLE[s]
            : COMET_LENGTH_TABLE[s] * (1 + (trailStretch - 1) * 1.6);

          /*
           * 故障态闪烁：只作用于头部与近端尾迹（s ≤ 2），
           * 远端尾迹保持稳定——否则整簇同时闪烁会像频闪灯，
           * 而真实故障的表现是"脉冲本体断续、余晖仍在"。
           */
          const flicker =
            fault && s <= 2
              ? FAULT_FLICKER_MIN +
                FAULT_FLICKER_GAIN * Math.abs(Math.sin(t * FAULT_FLICKER_RATE + s))
              : 1;

          tempObject.scale.set(widthScale * flicker, widthScale * flicker, lengthScale);
          tempObject.updateMatrix();
          mesh.setMatrixAt(idx, tempObject.matrix);

          /*
           * ---- 逐节颜色 ----
           *
           * 【为何预计算色表】每帧 144 次 Color.lerp 会产生 144 次浮点插值。
           * 预先把 8 节颜色算好，运行时直接取用，零插值开销。
           *
           * 【故障/高负载时叠加车道色】彗星本体保留自己的青白→深蓝渐变，
           * 但整体向车道状态色偏移，让"哪条链路出问题"依然一眼可辨。
           */
          const segmentColor = COMET_COLOR_TABLE[s];
          if (severity !== SEVERITY_HEALTHY) {
            /* tempColor 预分配，lerp 原地突变，零 GC */
            tempColor.copy(segmentColor).lerp(laneColor, 0.55);
            mesh.setColorAt(idx, tempColor);
          } else {
            mesh.setColorAt(idx, segmentColor);
          }
        }
      }
    }

    /* GPU 缓冲提交（AGENTS.md 第 7 条强制契约） */
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    /*
     * ---- 星火 uniform 提交（本轮新增，全部原地写 .value）----
     *
     * uCometPhase 已在车道循环内逐车道写入 sparkleCometPhase 数组，
     * 这里只需把数组标脏；uLoad 用三车道最大值驱动闪烁频率。
     *
     * 【为何把 uLoad 钳到 [1, LOAD_MAX]】着色器里 uLoad 直接乘在时间项上，
     * 若传 0.75 会让星火比基准更"慢"，反而与"高负载更活跃"的设计意图相反。
     * 星火的基准频率对应 1.0，负载升高才加速、不因低负载而减速。
     */
    sparkleUniforms.uLoad.value = Math.min(LOAD_MAX, Math.max(1, sparkleLoadMax));
  });

  return (
    <group>
      {/*
       * ---- 三条双层流光导管（外层柔光护套 + 内层高亮核心）----
       *
       * 【为何要两层】单层线无论多宽都是一个"实心笔画"，缺少体积。
       * 叠一层更宽、更淡、加色混合的护套后，线条中心锐利、外围渗出辉光，
       * 才接近真实光纤的观感——这与 GlowHalo3D 的假泛光是同一套思路：
       * 用加色叠加模拟光在介质里向外溢散，而不是给线本身加粗。
       *
       * 【层级与参数】
       * - 外层护套：lineWidth 5.5px、opacity 故障 0.22 / 健康 0.14，
       *   AdditiveBlending + depthWrite=false（纯增亮、不遮挡其他物体）。
       * - 内层核心：lineWidth 2.0px、opacity 故障 0.9 / 健康 0.65，
       *   普通混合保证核心线的色相与亮度稳定可读。
       *
       * 【故障态差异被放大】护套透明度 0.14→0.22（×1.57）、核心 0.65→0.9，
       * 让故障车道在辉光层面也明显"变亮变红"，而不只是颜色变了。
       *
       * 渲染顺序：先画护套再画核心（数组顺序 + 同组内按声明序遍历），
       * 核心线因此压在护套之上，边缘不会被宽线遮糊。
       */}
      {ribbonSheath.map((layer, k): ReactNode => (
        <mesh key={`sheath-${k}`} geometry={layer.geometry} raycast={(): void => undefined}>
          <shaderMaterial
          defines={KV_DEBUG_NAN_DEFINES}
            uniforms={layer.uniforms}
            vertexShader={RIBBON_VERTEX_SHADER}
            fragmentShader={RIBBON_FRAGMENT_SHADER}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      ))}

      {ribbonCore.map((layer, k): ReactNode => (
        <mesh key={`core-${k}`} geometry={layer.geometry} raycast={(): void => undefined}>
          <shaderMaterial
          defines={KV_DEBUG_NAN_DEFINES}
            uniforms={layer.uniforms}
            vertexShader={RIBBON_VERTEX_SHADER}
            fragmentShader={RIBBON_FRAGMENT_SHADER}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* ---- 54 个发光数据包粒子（单 Draw Call InstancedMesh；
             容量恒定，frustumCulled=false 防包围球误剔除——同 Pod 渲染器契约） ---- */}
      <instancedMesh ref={packetsRef} args={[undefined, undefined, PACKET_TOTAL]} frustumCulled={false}>
        <sphereGeometry args={[PACKET_RADIUS, 10, 10]} />
        {/* 白基色 × 实例色 + toneMapped=false：故障红的过饱语义不被色调映射削弱
            （AGENTS.md 第 7 条：动态实例着色的基础 color 必须 #ffffff）。
            【加色混合】粒子是"光"不是"物"：AdditiveBlending 让重叠处自然增亮，
            再配合 depthWrite=false，后方的粒子不会被前方的深度写入剔除，
            整条光缆才能积累出"璀璨星尘"的密度感，而不是一小把塑料小球。 */}
        <meshBasicMaterial
          color="#ffffff"
          toneMapped={false}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </instancedMesh>

      {/*
       * ---- 弧线伴飞星尘（135 颗，单 Draw Call）----
       *
       * 【解决什么】此前的能量弧线是"一根亮管 + 一串珠子"：
       * 管体清晰但周围空无一物，读起来就是根塑料管。
       * 参考图里每条弧线周围都萦绕着一层向外飞散的细碎星尘，
       * 正是这层星尘让光束看起来"在释放能量"而不是"在发光"。
       *
       * 【实现】135 颗（45 × 3 条）星尘全部预生成在弧线上，
       * 沿切向缓流 + 三轴微颤 + 独立闪烁**全在顶点着色器内完成**，
       * 每帧 CPU 只写一个 uTime 标量。
       *
       * 【配色】基色取冰青 #a5f3fc（比光束更冷白一档）：
       * 星尘贴着亮管时不会被管体吞掉，反而在管缘形成细密的"光晕毛边"。
       */}
      <points geometry={SPARKLE_GEOMETRY} raycast={(): void => undefined}>
        <shaderMaterial
          defines={KV_DEBUG_NAN_DEFINES}
          uniforms={sparkleUniforms}
          vertexShader={SPARKLE_VERTEX_SHADER}
          fragmentShader={SPARKLE_FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>
    </group>
  );
}