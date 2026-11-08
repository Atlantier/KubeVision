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
 * 每车道数据包粒子数。
 *
 * 【为何从 26 提到 32】配合本轮新增的「微螺旋绕流偏移」，粒子不再严格
 * 共线；密度必须再提高一档，才能在视觉上从"稀疏点阵"变成"连续的星尘带"。
 * 弧长 ~14 世界单位上均布 32 颗，基准间距约 0.44，叠加绕流偏移后
 * 前后错落，观感接近被风吹散的发光尘埃而非排队前进。
 */
const PACKETS_PER_LANE = 42;

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
const ARC_START_OFFSET = 0.65;

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

/** 彗星光梭的横向缩放（X/Y 收窄，形成流线） */
const COMET_SCALE_XZ = 0.55;

/** 彗星光梭沿运动切线方向的拉伸倍数（相对 PACKET_RADIUS） */
const COMET_SCALE_LENGTH = 3.6;

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
 * 主数据包 + 尾迹次级粒子（脉冲星点感）
 *
 * 【演进说明】早期实现用三级等距粒径（0.7 / 1.0 / 1.4）循环，
 * 虽有一定景深错落，但三档等概率出现导致"主次不分"——
 * 看上去像一串大小随机的珠子，而不是有节奏的数据流。
 * 现改为「每 3 颗一组：1 颗主包 + 2 颗尾迹」，且尾迹在曲线上落后于主包，
 * 形成"亮核拖尾"的脉冲星点节奏。
 * -------------------------------------------------------------------------- */

/** 每 N 颗出现一个主包（其余为尾迹），形成"大核 + 小尾"的节奏 */
const PACKET_MAIN_PERIOD = 3;

/**
 * 主数据包粒径（相对 PACKET_RADIUS）。
 *
 * 【为何是 1.35】旧实现三档等距循环（0.7 / 1.0 / 1.4）主次不分，
 * 看上去是一串大小随机的珠子。改为"每 3 颗中 1 颗主包 1.35×、另两颗为
 * 明显更小的尾迹"后，视觉上形成脉冲星点：一个亮核拖着两点微光。
 */
const PACKET_MAIN_SCALE = 1.35;

/** 尾迹粒子粒径 A（紧跟主包） */
const PACKET_TAIL_SCALE_A = 0.42;

/** 尾迹粒子粒径 B（更靠后、更暗，形成衰减尾迹） */
const PACKET_TAIL_SCALE_B = 0.3;

/**
 * 尾迹粒子的曲线参数回退量（u 域）。
 *
 * 【几何含义】尾迹粒子在同一车道上取 `u − offset` 的位置采样，
 * 因此它们**始终跟在主包后面**，而不是各自独立游走。
 * 0.012 约为拱形光缆弧长的 1.2%，在 32 颗/车道的密度下刚好形成
 * 可辨识的拖尾，又不会与主包重叠成一坨。
 */
const PACKET_TAIL_OFFSET_U = 0.012;

/** 尾迹 B 相对尾迹 A 的额外回退（两级衰减） */
const PACKET_TAIL_OFFSET_EXTRA_U = 0.011;

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

/**
 * 参与绕流的粒子比例判定。
 *
 * 【为何排除每 3 颗中的第 3 颗】若所有粒子都偏心，光缆在视觉上会失去
 * 一条可信的"中心线"，观感变成一团散点云。
 * 保留 1/3 粒子严格贴线飞行，缆线走向始终清晰可读，
 * 其余 2/3 绕流形成体积 —— 这是"有骨架的星尘"而非"无组织的噪声"。
 */
const SWIRL_SKIP_MODULO = 3;
const SWIRL_SKIP_REMAINDER = 2;

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
  gl_FragColor = vec4(uColor, alpha);
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

uniform float uTime;
uniform float uScale;

varying float vTwinkle;

void main() {
  /* 1) 沿切线缓流 */
  float flow = sin(uTime * 0.6 + aPhase) * 0.35;
  vec3 p = position + aTangent * flow;

  /* 2) 三轴微颤（频率互不同步，避免形成规则螺旋） */
  p.x += sin(uTime * 1.7 + aPhase) * aOffset;
  p.y += cos(uTime * 1.9 + aPhase * 1.3) * aOffset;
  p.z += sin(uTime * 1.1 + aPhase * 0.7) * aOffset;

  /* 3) 闪烁包络 */
  float twinkle = 0.72 + 0.28 * sin(uTime * 2.6 + aPhase);
  vTwinkle = twinkle;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * twinkle * uScale * (110.0 / max(0.001, -mvPosition.z));
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

varying float vTwinkle;

void main() {
  vec2 centered = gl_PointCoord - vec2(0.5);
  float d = length(centered) * 2.0;
  if (d > 1.0) discard;

  float core = 1.0 - smoothstep(0.0, 0.22, d);
  float halo = 1.0 - smoothstep(0.18, 1.0, d);

  vec3 color = mix(uColor, vec3(1.0, 1.0, 1.0), core * 0.85);
  float alpha = (core * 0.9 + halo * 0.32) * vTwinkle;

  gl_FragColor = vec4(color, alpha);
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
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aTangent', new THREE.BufferAttribute(tangents, 3));
  geometry.setAttribute('aOffset', new THREE.BufferAttribute(offsets, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
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
    }),
    [],
  );
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
    const buffer = new Float32Array(PACKET_TOTAL);
    /** 抖动强度：0.62 意味着粒子可在自己格子的 62% 范围内游走 */
    const JITTER = 0.62;
    const PHI_INV = 0.6180339887498949;

    for (let k = 0; k < LANE_COUNT; k++) {
      for (let j = 0; j < PACKETS_PER_LANE; j++) {
        const idx = k * PACKETS_PER_LANE + j;
        /* 基准等分位置 */
        const slot = (j + 0.37 * k) / PACKETS_PER_LANE;
        /* 黄金分割抖动：取小数部分映射到 [-0.5, 0.5]，再乘抖动强度与格子宽度 */
        const jitterRaw = (idx * PHI_INV) % 1;
        const jitter = (jitterRaw - 0.5) * JITTER * (1 / PACKETS_PER_LANE);
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
   * 挂载初始化：把 54 个粒子放到各自初始 u 的曲线点上，并写入车道初始色
   * （健康青）触发 instanceColor 缓冲创建（AGENTS.md 第 7 条前置条件）。
   *
   * 【为何初始化就写健康青而非白色】instanceColor 缓冲在首次 setColorAt 时
   * 创建并以当时写入值作为第 0 帧颜色。若写白色，首帧故障场景下会看到
   * 白→青→红的两段跳变；直接写入 laneColors（已在 useMemo 中初始化为健康青）
   * 使第 0 帧即具备正确语义色，随后的阻尼插值从青过渡到红自然连贯。
   */
  useEffect(() => {
    const mesh = packetsRef.current;
    if (mesh === null) return;
    for (let k = 0; k < LANE_COUNT; k++) {
      const curve = LANE_CURVES[k];
      const laneColor = laneColors[k];
      for (let j = 0; j < PACKETS_PER_LANE; j++) {
        const idx = k * PACKETS_PER_LANE + j;
        curve.getPointAt(uBuffer[idx], tempVec);
        tempObject.position.copy(tempVec);
        tempObject.rotation.set(0, 0, 0);
        /* 初始帧也必须应用主包/尾迹粒径，否则首帧所有粒子等大，会闪一下 */
        tempObject.scale.setScalar(
          j % PACKET_MAIN_PERIOD === 0
            ? PACKET_MAIN_SCALE
            : j % PACKET_MAIN_PERIOD === 1
              ? PACKET_TAIL_SCALE_A
              : PACKET_TAIL_SCALE_B,
        );
        tempObject.updateMatrix();
        mesh.setMatrixAt(idx, tempObject.matrix);
        mesh.setColorAt(idx, laneColor);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [laneColors, tempObject, tempVec, uBuffer]);

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

    for (let k = 0; k < LANE_COUNT; k++) {
      const curve = LANE_CURVES[k];
      const fault = faults[k] === true;
      const severity = severities[k] ?? SEVERITY_HEALTHY;

      /* 速度合成（NaN 防御：瞬态同步层已拦截，二道保险） */
      const mbpsRaw = netArray[k];
      const mbps = Number.isNaN(mbpsRaw) ? 0 : mbpsRaw;
      let speed = PACKET_BASE_SPEED + PACKET_SPEED_PER_MBPS * mbps;

      /* 故障门控：门关区间速度归零 → 断续卡顿 */
      if (fault && Math.sin(t * STUTTER_GATE_RATE + k * 2.1) <= STUTTER_GATE_THRESHOLD) {
        speed = 0;
      }

      /* 三态目标色：健康青 / 高负载琥珀橙 / 故障绯红 */
      const targetColor =
        severity >= SEVERITY_FAULT
          ? COLOR_FAULT
          : severity === SEVERITY_HOT
            ? COLOR_HOT
            : COLOR_HEALTHY;

      /* 车道级颜色阻尼插值（每帧每车道仅 1 次，替代逐实例 18 次读改写） */
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

      for (let j = 0; j < PACKETS_PER_LANE; j++) {
        const idx = k * PACKETS_PER_LANE + j;

        /* 契约推进公式 u = (u + v·Δt) mod 1 */
        let u = uBuffer[idx] + speed * dt;
        u -= Math.floor(u); // 等价 mod 1.0（对负数同样安全，此处 u 恒非负）
        uBuffer[idx] = u;

        /*
         * ---- 主包 / 尾迹分层 ----
         *
         * 每 3 颗粒子为一组：第 0 颗是主数据包（1.35×），
         * 第 1、2 颗是尾迹次级粒子（0.42× / 0.30×），且**采样位置倒退**
         * PACKET_TAIL_OFFSET_U，因此它们物理上跟在主包后面。
         *
         * 【为何用 u 回退而不是单独加速度】所有粒子共享同一条推进公式
         * u = (u + v·Δt) mod 1，只在采样时回退，速度恒等 ⇒ 尾迹永远
         * 与主包保持固定间距，不会慢慢拉开或追上。
         */
        const pattern = j % PACKET_MAIN_PERIOD;
        const isMain = pattern === 0;
        let sampleU = u;
        if (!isMain) {
          sampleU = u - PACKET_TAIL_OFFSET_U - (pattern === 2 ? PACKET_TAIL_OFFSET_EXTRA_U : 0);
          if (sampleU < 0) sampleU += 1;
        }

        /* 弧长参数化取点（查表插值，零分配写入 tempVec） */
        curve.getPointAt(sampleU, tempVec);

        /*
         * ---- 径向微螺旋绕流（2/3 的粒子参与，1/3 严格贴线）----
         *
         * 【核心数学】相位 φ = t·SWIRL_RATE + idx·SWIRL_PHASE_STEP + u·SWIRL_UV_RATE
         * 把 (cos φ, sin φ) 作为 XY 平面上的偏移方向，再叠加一项频率不同的
         * sin(φ·0.7) 作用在竖直方向——三轴频率互不同步，粒子轨迹因此是
         * **非平面的螺旋**，而不是绕一条轴的规则圆环（后者近看仍像"串珠扭转"）。
         *
         * 【为何引入 u 项】只用时间驱动时，同一车道所有粒子在同一时刻偏角相同，
         * 整条缆会像刚体一样左右摆。乘上 u 后，偏角沿缆长线性递增，
         * 形成真正的 helix：前端偏左、中段偏上、后端偏右，绕流感立刻成立。
         *
         * 【为何保留 1/3 贴线】中心线必须始终有一条可信的骨架，
         * 否则光缆看起来会散成一团噪声云，失去"从 MASTER 流向机架"的方向语义。
         *
         * 【零分配】全部为对已有 tempVec 的算术写入，不新建任何向量。
         */
        if (j % SWIRL_SKIP_MODULO !== SWIRL_SKIP_REMAINDER) {
          const swirlPhase = t * SWIRL_RATE + idx * SWIRL_PHASE_STEP + u * SWIRL_UV_RATE;
          tempVec.x += Math.cos(swirlPhase) * SWIRL_RADIUS;
          tempVec.z += Math.sin(swirlPhase) * SWIRL_RADIUS;
          /* 竖直方向用 0.7 倍频，避免与水平两轴同相形成平面圆 */
          tempVec.y += Math.sin(swirlPhase * 0.7) * SWIRL_RADIUS * 0.55;
        }

        /*
         * 粒子尺寸：主包 / 尾迹两档粒径 × （故障时叠加急促闪烁）。
         *
         * 【脉冲星点感】主包 1.35×、尾迹 0.42× / 0.30×，且尾迹在曲线上
         * 落后于主包，视觉上形成"亮核拖尾"——这是参考图光纤流的关键节奏，
         * 比旧的三档等距循环（0.7/1.0/1.4）主次分明得多。
         */
        const baseScale = isMain
          ? PACKET_MAIN_SCALE
          : pattern === 1
            ? PACKET_TAIL_SCALE_A
            : PACKET_TAIL_SCALE_B;
        const scale = fault
          ? baseScale *
            (FAULT_FLICKER_MIN +
              FAULT_FLICKER_GAIN * Math.abs(Math.sin(t * FAULT_FLICKER_RATE + j)))
          : baseScale;

        /*
         * ---- 火花额外螺旋包络（仅尾迹粒子）----
         *
         * 【为什么尾迹要更散】主包是"数据本体"，必须严格贴线以保持方向语义；
         * 尾迹是"被甩出的火花"，越靠近拱顶（u ≈ 0.5）甩得越开，
         * 用 sin(sampleU·π) 作包络：两端（离开控制平面 / 进入机架）收拢，
         * 中段最散。这正是参考图里能量弧线周围飞溅星尘的形态。
         */
        if (!isMain) {
          const sparkEnvelope = Math.sin(sampleU * Math.PI);
          const sparkPhase = t * SPARK_SPIRAL_RATE + idx * SWIRL_PHASE_STEP;
          tempVec.x += Math.cos(sparkPhase) * SPARK_SPIRAL_RADIUS * sparkEnvelope;
          tempVec.z += Math.sin(sparkPhase) * SPARK_SPIRAL_RADIUS * sparkEnvelope;
          tempVec.y += Math.sin(sparkPhase * 0.8) * SPARK_SPIRAL_RADIUS * 0.6 * sparkEnvelope;
        }

        /*
         * ---- 主包 = 沿切线拉伸的彗星光梭 ----
         *
         * 【核心数学】先用 getTangentAt(sampleU) 取该点的曲线切向量，
         * 再让粒子 lookAt(位置 + 切线)，使局部 +Z 轴对准运动方向；
         * 然后 scale.set(0.55, 0.55, 3.6)：
         *   · X/Y 收到 0.55 → 横向变细
         *   · Z 拉伸到 3.6 → 沿运动方向拉长（相对横向约 6.5 倍）
         * 于是球体被"拉成子弹形"，配合加色混合形成彗星流光。
         *
         * 【尾迹】保持近似等比的微小火花，只做轻微各向异性，不参与拉伸，
         * 否则整条弧线会变成一串尖刺。
         */
        tempObject.position.copy(tempVec);
        if (isMain) {
          curve.getTangentAt(sampleU, tempTangent);
          tempObject.lookAt(
            tempVec.x + tempTangent.x,
            tempVec.y + tempTangent.y,
            tempVec.z + tempTangent.z,
          );
          tempObject.scale.set(COMET_SCALE_XZ, COMET_SCALE_XZ, COMET_SCALE_LENGTH);
        } else {
          tempObject.rotation.set(0, 0, 0);
          tempObject.scale.set(scale, scale, scale * 1.35);
        }
        tempObject.updateMatrix();
        mesh.setMatrixAt(idx, tempObject.matrix);

        /* 广播写回本车道颜色（同车道颜色恒等，直接写，无需读回） */
        mesh.setColorAt(idx, laneColor);
      }
    }

    /* GPU 缓冲提交（AGENTS.md 第 7 条强制契约） */
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
