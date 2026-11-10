'use client';

/**
 * KubeVision AI — 选中实体的空间锁定标记（SelectionBeacon3D）
 *
 * 【解决什么问题】审查报告 §2.4 指出的核心短板：点击 Worker 机架时
 * WorkerRack3D 有青色呼吸描边与底座环，但点击**单个 Pod** 推近特写后，
 * PodInstancedMesh 根本不读 selectedEntityId——同层 4 个相邻槽位的 Pod
 * 方块挤在画面中心，用户完全分不清左上角探针面板指的是哪一颗。
 *
 * 【方案】挂载一个独立的轻量锁定标记，订阅 selectedEntityId 定位到对应槽位。
 * 这不是「给 Pod 加特效」，而是在空间里画一个**准星**——
 * 与巡检面板形成「数据 <-> 空间」的闭环指认。
 *
 * 【为何 Pod 本身已经很精致，标记必须克制】
 * Pod 现由四层光学着色器渲染（霓虹棱边 + 暗色凹槽 + 纵向渐变 + 菲涅尔），
 * 表面本身已具备密集的视觉信息。若锁定标记也用粗线、高不透明度，
 * 会直接压住刀片纹理，反而让用户看不清被选中的东西长什么样。
 * 因此本轮把标记统一改为**细线 + 半透明 + #38bdf8（天蓝）**：
 * 天蓝与 Pod 的青翠/琥珀/绯红三态色都能拉开色相差，不会被误认成状态色。
 *
 * 【性能契约（AGENTS.md 第 3 条）】
 * - useFrame 内零 useState、零 React 更新；
 * - 所有 THREE 几何体在 useMemo 中预分配，useFrame 只做原地 .set() / 赋值；
 * - 呼吸与自转由 useFrame 直接写 ref.current.rotation / scale，不触发重渲染。
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { useClusterStore } from '@/store/useClusterStore';
import { POD_BOX_SIZE, POD_SEAT_OFFSET_Y, getPodWorldTransform } from '@/utils/spatialLayout';
import type { PodEntity } from '@/types/cluster';
import type { SelectedEntityType } from '@/types/store';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/**
 * 锁定主色（天蓝 sky-400）。
 *
 * 【为何不用主题青 #22d3ee】Pod 的 Running 态是青翠 #10f5a0、选中机架是青 #22d3ee；
 * 标记若也用青色系，用户无法区分「这个 Pod 是选中态」还是「这个 Pod 恰好是正常态」。
 * #38bdf8 的色相更偏蓝，与三种状态色都保持可辨识的距离。
 */
const BEACON_COLOR = '#38bdf8';

/** 线框包围盒相对 Pod 可视盒的外扩量（世界单位） */
const BOX_PADDING = 0.1;

/** 线框不透明度：低到不压住刀片纹理，又能看清轮廓 */
const BOX_OPACITY = 0.55;

/** 呼吸周期（秒）——与机架选中态的呼吸节奏保持一致 */
const BREATH_PERIOD_S = 1.6;

/** 呼吸缩放幅度（±5%，比早期版本的 8% 更克制） */
const BREATH_AMPLITUDE = 0.05;

/** 自转速度（弧度/秒）——缓慢扫过，暗示"正在锁定" */
const SPIN_SPEED = 0.9;

/* ---- 底部刻度环 ---- */
const RING_RADIUS = 0.34;
const RING_SEGMENTS = 8;
const RING_OPACITY = 0.7;

/* ---- 顶部指示杆 ---- */
const BEAM_HEIGHT = 0.34;
const BEAM_OPACITY = 0.45;

/* ---- 四角短刻度线 ---- */

/**
 * 四角刻度线的长度与粗细（世界单位）。
 *
 * 【设计意图】早期版本只有包围盒+底环，锁定感偏"笼统"。
 * 在包围盒的**四根竖棱**两端各加一小段外伸刻度，形成类似
 * 「取景框对角标记」的精密观感——这是相机对焦框的经典语言，
 * 既强化"锁定"语义，又因为短促纤细而完全不遮挡盒内的 Pod。
 */
const CORNER_TICK_LENGTH = 0.07;
const CORNER_TICK_THICKNESS = 0.008;

/**
 * 四角刻度线的位置与朝向（模块级预计算，渲染期只做映射）。
 *
 * 【几何推导】包围盒半宽 = (POD_BOX_SIZE[0] + 2·BOX_PADDING) / 2，
 * 半高同理由 POD_BOX_SIZE[1] 推出。四个角在 XZ 平面上呈 (±hx, ±hz) 分布，
 * 每个角放置两根相互垂直的短杆（沿 +X 与 +Z 方向外伸），
 * 用单位立方体缩放而非新建几何体——四个角共 8 根，全部复用同一个 boxGeometry。
 */
const HALF_W = (POD_BOX_SIZE[0] + BOX_PADDING * 2) / 2;
const HALF_H = (POD_BOX_SIZE[1] + BOX_PADDING * 2) / 2;
const HALF_D = (POD_BOX_SIZE[2] + BOX_PADDING * 2) / 2;

/** 单根刻度杆的位姿（位置 + 沿哪个轴拉伸） */
interface CornerTick {
  readonly position: readonly [number, number, number];
  readonly axis: 'x' | 'z';
}

/**
 * 8 根四角刻度杆：4 个 XZ 角 × 2 个方向（沿 X 外伸、沿 Z 外伸），
 * 均置于盒体上下棱的中点高度（此处取上棱，视觉上更靠近观察者默认俯视机位）。
 *
 * 顺序固定（先 4 个 X 向、再 4 个 Z 向），保证渲染次序稳定无闪烁。
 */
const CORNER_TICKS: readonly CornerTick[] = (() => {
  const xs = [HALF_W, -HALF_W];
  const zs = [HALF_D, -HALF_D];
  const ticks: CornerTick[] = [];
  /* 沿 X 外伸的 4 根：位于四角的 Z 边界上，从盒边向外延 CORNER_TICK_LENGTH/2 */
  for (const x of xs) {
    for (const z of zs) {
      const dir = x > 0 ? 1 : -1;
      ticks.push({ position: [x + (dir * CORNER_TICK_LENGTH) / 2, HALF_H, z], axis: 'x' });
    }
  }
  /* 沿 Z 外伸的 4 根 */
  for (const x of xs) {
    for (const z of zs) {
      const dir = z > 0 ? 1 : -1;
      ticks.push({ position: [x, HALF_H, z + (dir * CORNER_TICK_LENGTH) / 2], axis: 'z' });
    }
  }
  return ticks;
})();

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * SelectionBeacon3D —— 选中 Pod 的空间锁定标记。
 *
 * 【为何只处理 Pod】机架与 Master 已有自己的选中视觉（WorkerRack3D 的
 * 描边 + 底座环、MasterNode3D 的 emphasized 状态），重复叠加反而杂乱。
 * 本组件专门补 Pod 这一层的缺失。
 *
 * 【渲染条件】仅当 selectedEntityType === 'pod' 且能在快照中找到该 Pod 时渲染。
 */
export default function SelectionBeacon3D(): React.ReactElement | null {
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectedEntityType = useClusterStore((s): SelectedEntityType | null => s.selectedEntityType);
  const pods = useClusterStore((s): readonly PodEntity[] => s.snapshotSummary.pods);

  /**
   * 【定位目标 Pod 并解算其槽位世界坐标】
   *
   * 【关键：必须叠加 POD_SEAT_OFFSET_Y】transform.position 是**槽位中心**，
   * 而渲染器为「让方块底面贴合隔板」又施加了下沉偏移
   * （POD_SEAT_OFFSET_Y = 可视盒高/2 − 契约盒高/2，当前为 −0.18）。
   * 若漏掉它，选中框会悬在方块正上方约 0.18 世界单位处，肉眼可见地错位。
   *
   * 依赖只放 selectedEntityId / selectedEntityType / pods 三者，
   * 避免遥测高频字段（cpu/mem）变化触发重算。
   */
  const anchor = useMemo((): { position: [number, number, number]; rotationY: number } | null => {
    if (selectedEntityType !== 'pod' || selectedEntityId === null) return null;
    const pod = pods.find((p): boolean => p.id === selectedEntityId);
    if (pod === undefined) return null;

    const transform = getPodWorldTransform(pod.rackIndex, pod.slotIndex);
    return {
      position: [
        transform.position[0],
        transform.position[1] + POD_SEAT_OFFSET_Y,
        transform.position[2],
      ],
      rotationY: transform.rotationY,
    };
  }, [selectedEntityType, selectedEntityId, pods]);

  /* ---- 预分配动画对象引用 ---- */
  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const boxRef = useRef<THREE.LineSegments>(null);

  /**
   * 【几何体预分配 + 卸载释放】
   *
   * 历史缺陷：此前写作 `<edgesGeometry args={[new THREE.BoxGeometry(...)]} />`——
   * `new` 位于 JSX 渲染体内，每次重渲染都会在堆上创建一个新 BoxGeometry，
   * 且从不 dispose。本组件订阅 snapshotSummary.pods（1Hz 快照流），
   * 因此**每秒泄漏一个 BoxGeometry**，长时间运行会持续累积 GPU 缓冲。
   *
   * 修复：在 useMemo 中一次性创建（空依赖 → 生命周期内仅一份），
   * 并在卸载时显式 dispose（BoxGeometry 与由其派生的 EdgesGeometry 各自持有缓冲）。
   * 尺寸跟随 POD_BOX_SIZE 外扩 BOX_PADDING，让包围框恰好包住方块。
   */
  const { boxGeometry, edgesGeometry, tickGeometry } = useMemo((): {
    boxGeometry: THREE.BoxGeometry;
    edgesGeometry: THREE.EdgesGeometry;
    tickGeometry: THREE.BoxGeometry;
  } => {
    const box = new THREE.BoxGeometry(
      POD_BOX_SIZE[0] + BOX_PADDING * 2,
      POD_BOX_SIZE[1] + BOX_PADDING * 2,
      POD_BOX_SIZE[2] + BOX_PADDING * 2,
    );
    /* 四角刻度杆复用的单位立方体（8 根共享，靠 scale 拉伸成细杆） */
    const tick = new THREE.BoxGeometry(1, 1, 1);
    return { boxGeometry: box, edgesGeometry: new THREE.EdgesGeometry(box), tickGeometry: tick };
  }, []);

  /* 卸载时释放 GPU 资源（三个几何体各自持有缓冲，缺一即泄漏） */
  useEffect((): (() => void) => {
    return (): void => {
      edgesGeometry.dispose();
      boxGeometry.dispose();
      tickGeometry.dispose();
    };
  }, [boxGeometry, edgesGeometry, tickGeometry]);

  useFrame((state): void => {
    if (anchor === null) return;

    /* 用场景时钟驱动动画：单一时间源，标签页切回时不会累积跳变 */
    const t = state.clock.elapsedTime;

    /* ---- 呼吸缩放：sin 波在 1±AMPLITUDE 之间往复 ---- */
    const group = groupRef.current;
    if (group !== null) {
      const breath = 1 + Math.sin((t / BREATH_PERIOD_S) * Math.PI * 2) * BREATH_AMPLITUDE;
      group.scale.setScalar(breath);
    }

    /* ---- 刻度环自转（仅改 rotation.z，零分配） ---- */
    const ring = ringRef.current;
    if (ring !== null) {
      ring.rotation.z = t * SPIN_SPEED;
    }

    /*
     * ---- 包围盒：锁定 0°，绝不旋转 ----
     *
     * 【缺陷复现】旧代码在此写 `box.rotation.y = -t * SPIN_SPEED * 0.5`，
     * 让长方形线框绕自身 Y 轴慢转，而盒内的刀片是静止的。
     * 于是一秒内线框会转过一个角度、露出"框与盒严重错位"的破面观感——
     * 选中框的语义是「这个盒子被锁定了」，一个正在自转的框恰恰在表达流动，
     * 与"锁定"语义相反。
     *
     * 现在彻底删除该行：线框与刀片保持 0° 绝对平行（组继承 anchor.rotationY，
     * 与刀片朝向同源），只由外层 group 的呼吸缩放提供"活着"的信号。
     * 若将来需要动态感，应动刻度环（ring）而非包围盒本体。
     */
  });

  /* 无 Pod 选中 → 不渲染任何场景节点（零开销） */
  if (anchor === null) return null;

  return (
    <group
      ref={groupRef}
      position={anchor.position}
      rotation={[0, anchor.rotationY, 0]}
      /* 锁定标记不参与射线拾取，避免遮挡真实的 Pod 点击 */
      raycast={(): void => undefined}
    >
      {/*
       * ---- 线框包围盒 ----
       * EdgesGeometry 只保留 12 条棱，比实体半透明包围盒更"仪表化"，
       * 三角形数个位数。不透明度压到 0.55 且用 lineBasicMaterial（不吃光照），
       * 保证它只是一层薄薄的天蓝轮廓，绝不盖住 Pod 的刀片纹理。
       */}
      <lineSegments ref={boxRef} geometry={edgesGeometry} raycast={(): void => undefined}>
        <lineBasicMaterial color={BEACON_COLOR} transparent opacity={BOX_OPACITY} toneMapped={false} />
      </lineSegments>

      {/*
       * ---- 四角短刻度线（8 根，共享同一个单位立方体几何） ----
       * 相机对焦框的经典语言：四角各一对短促外伸细杆。
       * 全部位于盒体**上棱**高度，俯视机位下最贴近视线，且不与盒内的 Pod 重叠。
       */}
      {CORNER_TICKS.map((tick, index): React.ReactElement => {
        const isX = tick.axis === 'x';
        return (
          <mesh
            key={`tick-${index}`}
            geometry={tickGeometry}
            position={[tick.position[0], tick.position[1], tick.position[2]]}
            scale={[
              isX ? CORNER_TICK_LENGTH : CORNER_TICK_THICKNESS,
              CORNER_TICK_THICKNESS,
              isX ? CORNER_TICK_THICKNESS : CORNER_TICK_LENGTH,
            ]}
            raycast={(): void => undefined}
          >
            <meshBasicMaterial color={BEACON_COLOR} transparent opacity={BOX_OPACITY} toneMapped={false} />
          </mesh>
        );
      })}

      {/*
       * 刻度环：躺平在 Pod 底部（绕 X 轴 −90° 平铺 XZ 平面），
       * 用 8 边形线框表达"扫描锁定"。
       */}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, -HALF_H, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[RING_RADIUS - 0.02, RING_RADIUS, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={BEACON_COLOR}
          transparent
          opacity={RING_OPACITY}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>

      {/* 内圈：更小更淡，形成双环层次 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -HALF_H, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[RING_RADIUS * 0.55, RING_RADIUS * 0.62, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={BEACON_COLOR}
          transparent
          opacity={0.35}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>

      {/*
       * 顶部指示杆：从盒顶向上的短细杆，在俯视角下帮助定位。
       * 顶端恰探出一个"头"的高度（HALF_H + BEAM_HEIGHT），不喧宾夺主。
       */}
      <mesh position={[0, HALF_H + BEAM_HEIGHT / 2, 0]} raycast={(): void => undefined}>
        <boxGeometry args={[0.008, BEAM_HEIGHT, 0.008]} />
        <meshBasicMaterial color={BEACON_COLOR} transparent opacity={BEAM_OPACITY} toneMapped={false} />
      </mesh>
    </group>
  );
}