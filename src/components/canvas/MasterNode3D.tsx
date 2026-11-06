'use client';

/**
 * KubeVision AI — MASTER 控制平面程序化 3D 模型（MasterNode3D）
 *
 * 【设计意图】集群控制平面（API-SERVER / etcd / scheduler / controller-manager
 * 的抽象化身）的纯程序化建模：零 .glb 外部资产，全部由原生 Three.js 几何体
 * 与材质组合而成（AGENTS.md 交付契约），世界坐标锚定 MASTER_POSITION [0, 2.5, 0]
 * ——三机架环形布局的几何中心正上方，「中心指挥 + 外围阵地」构图的视觉焦点。
 *
 * 【几何构成】（由外及内四层）
 * 1. 外层正八面体线框（octahedronGeometry，青色发光 wireframe）：缓慢正向自转
 *    + 正弦倾角摆动，象征控制面的全局调度扫描；
 * 2. 内层二十面体线框（icosahedronGeometry）：**反向**自转 + 余弦滚转摆动，
 *    双层反向运动产生机械仪差感（真实陀螺仪/反应堆的视觉语言）；
 * 3. 能量核心球体：呼吸缩放（scale = 1 + 0.12·sin(2.2t)）+ 发光强度同频脉动，
 *    心跳隐喻——控制平面存活即集群存活；
 * 4. 底部刻度全息圆环：双环轮廓 + 24 根径向刻度齿，贴地投影（世界 y≈0.08），
 *    缓慢自转；刻度齿呼应 globals.css .bg-cyber-grid 的坐标系质感。
 *
 * 【60FPS 红线合规】useFrame 单回调集中处理全部动画：旋转/呼吸均由
 * clock.elapsedTime 的确定性函数驱动（非增量累积，无浮点漂移），
 * 全部经 ref 原地突变（rotation/scale/material 属性写入），
 * 零 new、零 setState、零 React 重渲染（AGENTS.md 第 3 条）。
 *
 * 【交互契约】hover 高亮（线框增亮 + 光标 pointer）；点击
 * e.stopPropagation() 后 selectEntity(MASTER_ENTITY_ID, 'master')——
 * CameraRig 对 master 类型执行「全景鸟瞰」飞行（MASTER 位于环形中心，
 * 鸟瞰位即其最佳观察机位）。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import { MASTER_ENTITY_ID } from '@/types/canvas';
import { MASTER_POSITION } from '@/utils/spatialLayout';
import type { SelectedEntityType } from '@/types/store';

/* ========================================================================== */
/* 模型几何常量（模块级，集中定义防漂移）                                          */
/* ========================================================================== */

/** 外层正八面体半径（调度扫描包络） */
const OCTA_RADIUS = 1.15;

/** 内层二十面体半径（与外层保持 0.3 间隙，双层线框互不穿插） */
const ICO_RADIUS = 0.85;

/** 能量核心球半径（呼吸峰值 1.12 倍仍与内层线框保持间隙） */
const CORE_RADIUS = 0.34;

/** 外层正向自转角速度（rad/s）：约 25 秒/圈，从容的全局扫描节奏 */
const OUTER_SPIN_RATE = 0.25;

/** 内层反向自转角速度（rad/s）：与外层 1.52:1 速比，产生持续变化的摩尔纹视差 */
const INNER_SPIN_RATE = -0.38;

/** 核心呼吸角频率（rad/s）：≈2.85 秒/次心跳 */
const BREATH_RATE = 2.2;

/** 核心呼吸振幅（±12% 缩放） */
const BREATH_AMPLITUDE = 0.12;

/** 底部全息圆环参数：内/外轮廓半径与刻度齿数量 */
const RING_INNER_RADIUS = 1.85;
const RING_OUTER_RADIUS = 2.35;
const RING_TICK_COUNT = 24;

/** 圆环局部 Y 偏移：MASTER_POSITION.y(2.5) − 2.42 = 世界 y≈0.08（贴地投影） */
const RING_LOCAL_Y = -2.42;

/** 圆环自转角速度（rad/s） */
const RING_SPIN_RATE = 0.1;

/** 线框/核心发光色（主题流光 cyan-400；字符串字面量供 JSX 属性，three 原生接受） */
const GLOW_CYAN = '#22d3ee';

/**
 * 刻度齿预计算表（渲染期一次性求值：24 根齿的平面位置与朝向）。
 * 齿为径向小方块，绕圆环均布；角度 θ_i = 2πi/24，
 * 位置 (R·sinθ, 0, R·cosθ)、朝向 rotationY = θ（长轴指向圆心）。
 */
const RING_TICKS: ReadonlyArray<{
  readonly position: [number, number, number];
  readonly rotationY: number;
}> = Array.from({ length: RING_TICK_COUNT }, (_, i): { position: [number, number, number]; rotationY: number } => {
  const theta = (2 * Math.PI * i) / RING_TICK_COUNT;
  const r = (RING_INNER_RADIUS + RING_OUTER_RADIUS) / 2;
  return {
    position: [r * Math.sin(theta), 0, r * Math.cos(theta)],
    rotationY: theta,
  };
});

/* ========================================================================== */
/* MasterNode3D 主体                                                           */
/* ========================================================================== */

/**
 * MasterNode3D —— 控制平面全息模型（挂载于 ClusterCanvas 场景根）。
 *
 * 【订阅纪律】仅订阅 selectedEntityId（低频 UI 字段）驱动选中高亮；
 * 动画通道全部走 useFrame ref 突变，与 React 渲染完全解耦。
 */
export default function MasterNode3D() {
  /* ---- Store 细粒度订阅 ---- */
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );

  /* ---- 交互态（低频 UI 事件，允许 useState） ---- */
  const [hovered, setHovered] = useState<boolean>(false);

  /* ---- 动画通道 ref（useFrame 内原地突变） ---- */
  const outerRef = useRef<THREE.Mesh>(null);
  const innerRef = useRef<THREE.Mesh>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const coreMaterialRef = useRef<THREE.MeshStandardMaterial>(null);
  const ringGroupRef = useRef<THREE.Group>(null);

  const isSelected = selectedEntityId === MASTER_ENTITY_ID;
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
   * useFrame —— 双层反向自转 + 核心呼吸 + 圆环慢转（单回调集中处理）。
   *
   * 【确定性动画】全部角度/缩放为 elapsedTime 的纯函数（t·ω 与 sin(t)），
   * 非增量累积——无浮点误差漂移，暂停/恢复（如页签切换）后相位自洽。
   */
  useFrame((state): void => {
    const t = state.clock.getElapsedTime();

    // 外层八面体：正向自转 + 正弦倾角摆动（调度扫描感）
    if (outerRef.current !== null) {
      outerRef.current.rotation.y = t * OUTER_SPIN_RATE;
      outerRef.current.rotation.x = Math.sin(t * 0.4) * 0.18;
    }
    // 内层二十面体：反向自转 + 余弦滚转（仪差机械感）
    if (innerRef.current !== null) {
      innerRef.current.rotation.y = t * INNER_SPIN_RATE;
      innerRef.current.rotation.z = Math.cos(t * 0.32) * 0.22;
    }
    // 能量核心：呼吸缩放（±12%）+ 发光强度同频脉动（心跳隐喻）
    if (coreRef.current !== null) {
      const breath = 1 + BREATH_AMPLITUDE * Math.sin(t * BREATH_RATE);
      coreRef.current.scale.setScalar(breath);
    }
    if (coreMaterialRef.current !== null) {
      coreMaterialRef.current.emissiveIntensity = 1.7 + 0.55 * Math.sin(t * BREATH_RATE + Math.PI / 4);
    }
    // 底部全息圆环：缓慢自转（刻度扫过 = 控制面巡检隐喻）
    if (ringGroupRef.current !== null) {
      ringGroupRef.current.rotation.y = t * RING_SPIN_RATE;
    }
  });

  return (
    <group
      position={MASTER_POSITION}
      onClick={(event): void => {
        // 阻止穿透：防止一次点击同时命中 MASTER 与其身后的机架/地面
        event.stopPropagation();
        selectEntity(MASTER_ENTITY_ID, 'master');
      }}
      onPointerOver={(event): void => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(): void => setHovered(false)}
    >
      {/* ---- 外层：正八面体青色发光线框（正向自转） ---- */}
      <mesh ref={outerRef}>
        <octahedronGeometry args={[OCTA_RADIUS, 0]} />
        <meshBasicMaterial
          color={GLOW_CYAN}
          wireframe
          transparent
          opacity={emphasized ? 0.95 : 0.55}
          toneMapped={false}
        />
      </mesh>

      {/* ---- 内层：二十面体青色线框（反向自转，与外层 1.52:1 速比） ---- */}
      <mesh ref={innerRef}>
        <icosahedronGeometry args={[ICO_RADIUS, 1]} />
        <meshBasicMaterial
          color={GLOW_CYAN}
          wireframe
          transparent
          opacity={emphasized ? 0.8 : 0.4}
          toneMapped={false}
        />
      </mesh>

      {/* ---- 能量核心：呼吸缩放的高亮发光球 ---- */}
      <mesh ref={coreRef}>
        <sphereGeometry args={[CORE_RADIUS, 32, 32]} />
        <meshStandardMaterial
          ref={coreMaterialRef}
          color="#a5f3fc"
          emissive={GLOW_CYAN}
          emissiveIntensity={1.7}
          metalness={0.1}
          roughness={0.25}
          toneMapped={false}
        />
      </mesh>

      {/* ---- 底部刻度全息圆环：双环轮廓 + 24 径向刻度齿（贴地投影，缓慢自转）。
         【几何推导】ringGroupRef 只承担绕世界 Y 的慢转（刻度扫过 = 巡检隐喻）；
         「平铺贴地」的 −90°X 旋转下放到各子网格自身——ringGeometry 默认在
         XY 平面，绕自身 X 转 −π/2 后即平铺于世界 XZ 平面；刻度齿为径向小方块
         （boxGeometry 长轴沿 Z），绕自身 Y 转 θ 后长轴指向圆心，恒贴地。
         若把 −90°X 放在 group 上，齿会被连带立起且朝向错乱，故严禁上提。 */}
      <group ref={ringGroupRef} position={[0, RING_LOCAL_Y, 0]}>
        {/* 外轮廓环（自身 −90°X 平铺贴地） */}
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[RING_OUTER_RADIUS - 0.035, RING_OUTER_RADIUS, 96]} />
          <meshBasicMaterial
            color={GLOW_CYAN}
            transparent
            opacity={emphasized ? 0.85 : 0.5}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* 内轮廓环 */}
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[RING_INNER_RADIUS, RING_INNER_RADIUS + 0.03, 96]} />
          <meshBasicMaterial
            color={GLOW_CYAN}
            transparent
            opacity={emphasized ? 0.7 : 0.38}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* 24 根径向刻度齿（渲染期预计算位置/朝向；几何由 R3F 内联托管，
            卸载自动 dispose——规避共享实例在 StrictMode 双挂载下的泄漏风险） */}
        {RING_TICKS.map((tick, index): ReactNode => (
          <mesh key={index} position={tick.position} rotation={[0, tick.rotationY, 0]}>
            <boxGeometry args={[0.05, 0.022, 0.34]} />
            <meshBasicMaterial
              color={GLOW_CYAN}
              transparent
              opacity={emphasized ? 0.75 : 0.42}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>

      {/* ---- 悬浮铭牌（drei Html 契约：center + distanceFactor=15 +
         zIndexRange=[10,0] + pointer-events-none，永不遮挡抽屉/Modal） ---- */}
      <Html position={[0, 1.75, 0]} center distanceFactor={15} zIndexRange={[10, 0]} className="pointer-events-none">
        <div
          className={cn(
            'flex flex-col items-center gap-0.5 rounded border border-cyan-400/40 bg-slate-950/85 px-2.5 py-1 backdrop-blur-sm transition-colors',
            emphasized && 'border-cyan-400/80 shadow-glow-cyan',
          )}
        >
          <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-cyan-300">CONTROL PLANE</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">API-SERVER</span>
        </div>
      </Html>
    </group>
  );
}
