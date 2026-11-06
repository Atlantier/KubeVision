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
import { Line } from '@react-three/drei';
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
 * 【为何从 18 提到 26】原值 18 在弧长 ~14 世界单位上均匀分布，
 * 间距约 0.78——每颗粒子半径 0.07，视觉上形成一串**等距的珠子**，
 * 这就是图一"佛珠弧线"观感的直接来源。
 * 提到 26 后配合下方的不等距相位偏移与三级粒径，形成"星尘流"而非串珠。
 */
const PACKETS_PER_LANE = 26;

/** 粒子总数（InstancedMesh 固定容量，严禁随数据变化——args 重建灾难同 Pod 渲染器） */
const PACKET_TOTAL = LANE_COUNT * PACKETS_PER_LANE;

/** 光缆终点高度：机架顶盖上沿（顶盖中心 4.46 + 半厚 0.06） */
const RACK_TOP_Y = RACK_BODY_SIZE[1] + 0.12;

/** 拱形抬升量（世界单位）：MASTER 侧陡升、机架侧缓落 */
const ARCH_LIFT = 3.4;

/**
 * 粒子基准半径（发光数据包颗粒感）。
 *
 * 【为何从 0.07 缩到 0.038】粒子越小、越密，越像"星尘"；
 * 越大越像"珠子"。配合三级粒径倍率（下方 PACKET_SIZE_TIERS），
 * 大小参差才是真实粒子流的观感。
 */
const PACKET_RADIUS = 0.038;

/**
 * 三级粒径倍率：按粒子在车道内的序号循环取值。
 *
 * 【设计意图】统一大小的粒子无论多密都会呈现"规则阵列"；
 * 引入 0.7 / 1.0 / 1.4 三档差异后，视觉上形成前后景深错落，
 * 这是图二那种"星尘"质感的核心技巧之一。
 */
const PACKET_SIZE_TIERS: readonly number[] = [0.7, 1.0, 1.4];

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

/** 健康/故障双色（模块级预分配，useFrame 内只读，color.lerp 的 target） */
const COLOR_HEALTHY = new THREE.Color('#22d3ee'); // 主题青：链路健康
const COLOR_FAULT = new THREE.Color('#f43f5e'); // 警示红：链路故障（契约指定 #f43f5e）

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
    // 非对称控制点：30% 行程处全抬升（枢纽侧陡拱），70% 行程处 55% 抬升（机架侧缓落）
    const c1 = master.clone().lerp(end, 0.3);
    c1.y += ARCH_LIFT;
    const c2 = master.clone().lerp(end, 0.7);
    c2.y += ARCH_LIFT * 0.55;
    curves.push(new THREE.CubicBezierCurve3(master.clone(), c1, c2, end));
  }
  return curves;
})();

/** 基底光缆折线采样（drei <Line> 的 points prop，64 段足够平滑，一次求值） */
const LANE_POINTS: readonly (readonly THREE.Vector3[])[] = LANE_CURVES.map(
  (curve): THREE.Vector3[] => curve.getPoints(64),
);

/* ========================================================================== */
/* NetworkStream3D 主体                                                        */
/* ========================================================================== */

/**
 * NetworkStream3D —— 三条 MASTER→机架拱形光缆与 54 个流动数据包。
 *
 * 【渲染树】3 × drei <Line>（半透明基底光缆，颜色随故障标志切换）
 *          + 1 × InstancedMesh（54 粒子，单次 Draw Call）。
 */
export default function NetworkStream3D() {
  /**
   * 车道故障标志（低频派生 selector + shallow）。
   *
   * 【判定契约】车道 k 故障 ⇔ 以下任一成立：
   * 1. 节点状态非 'Ready'（HighLoad / NetworkPartition）；
   * 2. 节点名下存在 CrashLoopBackOff / OOMKilled 的 Pod；
   * 3. 全局混沌场景为 NET_PACKET_LOSS（网络层演练 → 三车道全部告警）。
   */
  const laneFaults = useClusterStore(
    (s): readonly boolean[] => {
      const snapshot = s.snapshotSummary;
      const netLoss = s.activeChaos === 'NET_PACKET_LOSS';
      const faults: boolean[] = [];
      for (let k = 0; k < LANE_COUNT; k++) {
        const node = snapshot.nodes.find((n): boolean => n.rackIndex === k);
        if (node === undefined) {
          faults.push(netLoss);
        } else {
          const hasCrashPod = snapshot.pods.some(
            (p): boolean =>
              p.nodeId === node.id &&
              (p.status === 'CrashLoopBackOff' || p.status === 'OOMKilled'),
          );
          faults.push(node.status !== 'Ready' || hasCrashPod || netLoss);
        }
      }
      return faults;
    },
    shallow,
  );

  /* 故障标志镜像进 ref：useFrame 恒读最新值，渲染循环零 zustand 访问 */
  const laneFaultsRef = useRef<readonly boolean[]>(laneFaults);
  useEffect(() => {
    laneFaultsRef.current = laneFaults;
  }, [laneFaults]);

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
  const tempColor = useMemo((): THREE.Color => new THREE.Color(), []);
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
        /* 初始帧也必须应用三级粒径，否则首帧所有粒子等大，会闪一下 */
        tempObject.scale.setScalar(PACKET_SIZE_TIERS[j % PACKET_SIZE_TIERS.length]);
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

    for (let k = 0; k < LANE_COUNT; k++) {
      const curve = LANE_CURVES[k];
      const fault = faults[k] === true;

      /* 速度合成（NaN 防御：瞬态同步层已拦截，二道保险） */
      const mbpsRaw = netArray[k];
      const mbps = Number.isNaN(mbpsRaw) ? 0 : mbpsRaw;
      let speed = PACKET_BASE_SPEED + PACKET_SPEED_PER_MBPS * mbps;

      /* 故障门控：门关区间速度归零 → 断续卡顿 */
      if (fault && Math.sin(t * STUTTER_GATE_RATE + k * 2.1) <= STUTTER_GATE_THRESHOLD) {
        speed = 0;
      }

      const targetColor = fault ? COLOR_FAULT : COLOR_HEALTHY;

      /* 车道级颜色阻尼插值（每帧每车道仅 1 次，替代逐实例 18 次读改写） */
      const laneColor = laneColors[k];
      laneColor.lerp(targetColor, colorAlpha);

      for (let j = 0; j < PACKETS_PER_LANE; j++) {
        const idx = k * PACKETS_PER_LANE + j;

        /* 契约推进公式 u = (u + v·Δt) mod 1 */
        let u = uBuffer[idx] + speed * dt;
        u -= Math.floor(u); // 等价 mod 1.0（对负数同样安全，此处 u 恒非负）
        uBuffer[idx] = u;

        /* 弧长参数化取点（查表插值，零分配写入 tempVec） */
        curve.getPointAt(u, tempVec);

        /*
         * 粒子尺寸：三级基准粒径 × （故障时叠加闪烁）。
         *
         * 【为何要分三级】统一大小的粒子即使打散了间距，仍会呈现"规则感"；
         * 引入 0.7 / 1.0 / 1.4 三档大小差异后，视觉上产生前后景深错落，
         * 这才是图二那种"星尘粒子流"的观感（而非一串等大的珠子）。
         * 档位按粒子序号取模循环，天然可复现。
         */
        const tier = PACKET_SIZE_TIERS[j % PACKET_SIZE_TIERS.length];
        const scale = fault
          ? tier *
            (FAULT_FLICKER_MIN +
              FAULT_FLICKER_GAIN * Math.abs(Math.sin(t * FAULT_FLICKER_RATE + j)))
          : tier;

        tempObject.position.copy(tempVec);
        tempObject.scale.setScalar(scale);
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
      {/* ---- 三条半透明基底光缆（drei Line：故障标志切换颜色与透明度，
             低频 React prop 重渲染，与粒子高频通道解耦） ---- */}
      {LANE_POINTS.map((points, k): ReactNode => (
        <Line
          key={k}
          points={points}
          color={laneFaults[k] ? '#f43f5e' : '#22d3ee'}
          transparent
          opacity={laneFaults[k] ? 0.5 : 0.3}
          lineWidth={laneFaults[k] ? 1.8 : 1.4}
        />
      ))}

      {/* ---- 54 个发光数据包粒子（单 Draw Call InstancedMesh；
             容量恒定，frustumCulled=false 防包围球误剔除——同 Pod 渲染器契约） ---- */}
      <instancedMesh ref={packetsRef} args={[undefined, undefined, PACKET_TOTAL]} frustumCulled={false}>
        <sphereGeometry args={[PACKET_RADIUS, 10, 10]} />
        {/* 白基色 × 实例色 + toneMapped=false：故障红的过饱语义不被色调映射削弱 */}
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>
    </group>
  );
}
