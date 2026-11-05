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

/** 每车道数据包粒子数（契约指定：共 54 = 3 × 18） */
const PACKETS_PER_LANE = 18;

/** 粒子总数（InstancedMesh 固定容量，严禁随数据变化——args 重建灾难同 Pod 渲染器） */
const PACKET_TOTAL = LANE_COUNT * PACKETS_PER_LANE;

/** 光缆终点高度：机架顶盖上沿（顶盖中心 4.46 + 半厚 0.06） */
const RACK_TOP_Y = RACK_BODY_SIZE[1] + 0.12;

/** 拱形抬升量（世界单位）：MASTER 侧陡升、机架侧缓落 */
const ARCH_LIFT = 3.4;

/** 粒子球半径（发光数据包颗粒感） */
const PACKET_RADIUS = 0.07;

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
  const uBuffer = useMemo((): Float32Array => {
    const buffer = new Float32Array(PACKET_TOTAL);
    for (let k = 0; k < LANE_COUNT; k++) {
      for (let j = 0; j < PACKETS_PER_LANE; j++) {
        buffer[k * PACKETS_PER_LANE + j] = ((j + 0.37 * k) / PACKETS_PER_LANE) % 1;
      }
    }
    return buffer;
  }, []);

  /**
   * 挂载初始化：把 54 个粒子放到各自初始 u 的曲线点上，并写入白色实例色
   * 触发 instanceColor 缓冲创建（AGENTS.md 第 7 条前置条件）。
   */
  useEffect(() => {
    const mesh = packetsRef.current;
    if (mesh === null) return;
    tempColor.set('#ffffff');
    for (let k = 0; k < LANE_COUNT; k++) {
      const curve = LANE_CURVES[k];
      for (let j = 0; j < PACKETS_PER_LANE; j++) {
        const idx = k * PACKETS_PER_LANE + j;
        curve.getPointAt(uBuffer[idx], tempVec);
        tempObject.position.copy(tempVec);
        tempObject.rotation.set(0, 0, 0);
        tempObject.scale.setScalar(1);
        tempObject.updateMatrix();
        mesh.setMatrixAt(idx, tempObject.matrix);
        mesh.setColorAt(idx, tempColor);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [tempColor, tempObject, tempVec, uBuffer]);

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

      for (let j = 0; j < PACKETS_PER_LANE; j++) {
        const idx = k * PACKETS_PER_LANE + j;

        /* 契约推进公式 u = (u + v·Δt) mod 1 */
        let u = uBuffer[idx] + speed * dt;
        u -= Math.floor(u); // 等价 mod 1.0（对负数同样安全，此处 u 恒非负）
        uBuffer[idx] = u;

        /* 弧长参数化取点（查表插值，零分配写入 tempVec） */
        curve.getPointAt(u, tempVec);

        /* 故障粒子尺寸闪烁；健康粒子恒定 */
        const scale = fault
          ? FAULT_FLICKER_MIN +
            FAULT_FLICKER_GAIN * Math.abs(Math.sin(t * FAULT_FLICKER_RATE + j))
          : 1;

        tempObject.position.copy(tempVec);
        tempObject.scale.setScalar(scale);
        tempObject.updateMatrix();
        mesh.setMatrixAt(idx, tempObject.matrix);

        /* 实例色平滑渐变（instanceColor 缓冲即当前值持久态） */
        mesh.getColorAt(idx, tempColor);
        tempColor.lerp(targetColor, colorAlpha);
        mesh.setColorAt(idx, tempColor);
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
