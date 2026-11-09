'use client';

/**
 * KubeVision AI — 地面拓扑星环（ClusterTopologyFloor3D）
 *
 * 【解决什么问题】三个 Worker 机架 + Master 若只悬浮在无限网格上、彼此仅靠
 * 顶部拱形光缆相连，地面就是空的——四个实体读起来像「各自漂浮的孤岛」。
 * 参考图那种「机架站在精密数码阵法上」的构图，才是把散点聚成系统的关键。
 *
 * 【本轮升级：从"两圈环 + 三根直线"到"多层动态数码阵法"】
 * 旧实现是静态的双圈 + 单根平面条，远看是几条线，缺少"仪器在运转"的层次。
 * 现结构：
 * 1. **四重主轨道**（RACK_RADIUS 处）：主发光轨 + 外侧 64 段虚线刻度环 +
 *    内侧双细导轨 + 沿轨道游走的脉冲流光弧（useFrame 缓慢旋转）；
 * 2. **控制平面内环**：Master 周围的双环，呼应其底座刻度环；
 * 3. **三线并行径向总线**（每机架一道）：1 根主干道 + 2 根细护线，
 *    沿线有向机架输送的地面光脉冲（useFrame 推进）；
 * 4. **每机架四层复合数码基座**：
 *    · 半径 2.45：8 段断开的战术锁定括弧环；
 *    · 半径 2.18：高亮主环 + 36 枚径向刻度齿（反向自转）；
 *    · 半径 1.82：三层衰减能量底盘（模拟径向渐变柔光）；
 *    · 前方两侧对称的精密导流短轨。
 *
 * 【为什么统一用 AdditiveBlending】
 * 这些都是「光」而非「面」。加色混合下环与环、环与机架的重叠处自然增亮，
 * 且不会出现不透明混合特有的「灰蒙蒙压暗」——主轨道会从机架底座下方穿过，
 * 若用普通混合会把机架底部压暗一块。
 *
 * 【性能契约】
 * - 所有位置/弧段/齿位**在模块加载期一次求值**，渲染期只查表；
 * - useFrame 内只做标量赋值与 rotation 写入，**零 new、零数组分配**；
 * - 不使用 useState，不订阅高频遥测（仅节点/Pod 状态位变化时重渲染）。
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { useClusterStore } from '@/store/useClusterStore';
import { RACK_RADIUS, getRackTransform } from '@/utils/spatialLayout';
import type { PodEntity, WorkerNodeEntity } from '@/types/cluster';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 主轨道环的环宽（世界单位） */
const ORBIT_THICKNESS = 0.055;

/** 主轨道外侧虚线刻度环的半径与段数 */
const ORBIT_TICK_RADIUS = RACK_RADIUS + 0.30;
const ORBIT_TICK_COUNT = 64;
const ORBIT_TICK_THICKNESS = 0.16;
/** 每段刻度占该扇区的比例（0.55 → 段与段之间留空，形成"虚线"） */
const ORBIT_TICK_DUTY = 0.55;

/** 主轨道内侧双细导轨的半径（两道，制造扫描轨道层次） */
const ORBIT_RAIL_INNER = RACK_RADIUS - 0.30;
const ORBIT_RAIL_OUTER = RACK_RADIUS - 0.26;

/** 沿轨道游走的脉冲流光弧：张角与环宽 */
const ORBIT_PULSE_ARC = Math.PI / 7;
const ORBIT_PULSE_THICKNESS = 0.14;

/** 控制平面内环半径 */
const INNER_RING_RADIUS = 3.1;

/** 内环环宽 */
const INNER_THICKNESS = 0.035;

/** 径向总线的宽度与长度 */
const RADIAL_WIDTH = 0.045;
/** 主干道两侧细护线的宽度与横向偏移 */
const RADIAL_GUARD_WIDTH = 0.17;
/** 总线起点：向内贯穿到雷达核心环（r=1.55），终点接机架轨道 */
const RADIAL_START_RADIUS = 1.55;
const RADIAL_LENGTH = RACK_RADIUS - RADIAL_START_RADIUS;

/** 地面光脉冲的尺寸与推进速度（周期/秒） */
const LANE_PULSE_LENGTH = 0.85;
const LANE_PULSE_WIDTH = 0.10;
const LANE_PULSE_SPEED = 0.22;

/* ---- 机架基座复合数码阵（四层）---- */

/** 最外层：8 段断开的战术锁定括弧环 */
const PEDESTAL_BRACKET_RADIUS = 2.45;
const PEDESTAL_BRACKET_THICKNESS = 0.06;
const PEDESTAL_BRACKET_COUNT = 4;
const PEDESTAL_BRACKET_DUTY = 0.62;

/** 第二层：高亮主发光环 */
const PEDESTAL_MAIN_RADIUS = 2.25;
const PEDESTAL_MAIN_THICKNESS = 0.07;

/** 第二层的 36 枚径向刻度齿 */
const PEDESTAL_TEETH_COUNT = 36;
const PEDESTAL_TEETH_RADIUS = 2.30;
const PEDESTAL_TEETH_WIDTH = 0.05;
const PEDESTAL_TEETH_LENGTH = 0.20;

/**
 * 第三层：三层同心底座光环（r = 1.85 / 2.25 / 2.68，由内向外递减高度与亮度）。
 *
 * 【为何是三层环而不是三层实心圆盘】参考图里机架脚下是**多道细环叠加**的
 * 精密底座，实心圆盘会糊成一块发光圆饼，反而丢失"仪器刻度"的层次。
 */
const PEDESTAL_DISK_RADII: readonly number[] = [1.85, 2.25, 2.68];
const PEDESTAL_DISK_WIDTHS: readonly number[] = [0.030, 0.045, 0.024];
const PEDESTAL_DISK_OPACITIES: readonly number[] = [0.52, 0.68, 0.42];

/** 第四层：前方两侧导流短轨 */
const GUIDE_RAIL_WIDTH = 0.06;

/* ========================================================================== */
/* 加密罗盘微刻度与双层量子点阵（Compass Micro-Ticks & Quantum Lattice）          */
/* ========================================================================== */

/**
 * 罗盘微刻度的数量与几何。
 *
 * 【为何要加密到 128 枚】原有 64 枚刻度是"每 5.6° 一格"，
 * 在默认机位下每个刻度约 9 像素宽，读起来像"稀疏的虚线"。
 * 加密到 128 枚（每 2.8° 一格）后，环带变成一条**连续细密的刻度带**——
 * 这正是精密罗盘与科幻全息沙盘的区别：刻度越密，"精密感"越强。
 *
 * 【为何用实例化】128 段若逐个 mesh，在反射地面会被二次渲染成 256 次
 * draw call。实例化后仅 1 次。
 */
const COMPASS_TICK_COUNT = 128;
const COMPASS_TICK_INNER = RACK_RADIUS - 0.62;
const COMPASS_TICK_OUTER = RACK_RADIUS - 0.52;

/**
 * 双层错位量子点阵的半径、数量与尺寸。
 *
 * 【为何"双层错位"】单层点阵无论多密，都是一圈规则排列的圆点，
 * 眼睛立刻识别出"周期性图案"。两层**半径不同、相位错开半格**后，
 * 相邻点的间距不再恒定，产生类似莫尔条纹的微扰——
 * 视觉上就成了"随机分布的量子泡沫"而非"刻好的点阵"。
 *
 * 数量取 96 与 120（互质程度较高），使两层的最小公倍数很大，
 * 叠加后的图案周期极长，看不出重复。
 */
const QUANTUM_LAYER_A_COUNT = 96;
const QUANTUM_LAYER_A_RADIUS = RACK_RADIUS - 1.42;
const QUANTUM_LAYER_B_COUNT = 120;
const QUANTUM_LAYER_B_RADIUS = RACK_RADIUS - 1.68;

/** 单个量子点的边长（正方形薄片，比圆更省三角面且远景无差别） */
const QUANTUM_DOT_SIZE = 0.052;

/**
 * 量子点阵的浮动参数。
 *
 * 【为何要浮动】静止的点阵是"贴纸"；只有轻微上下浮动 + 明暗呼吸，
 * 才像悬浮在地面上的量子泡沫。浮动幅度 0.012 极小（约点尺寸的 1/4），
 * 不会破坏"贴地"的空间定位，但足以在近景看出层次。
 */
const QUANTUM_FLOAT_AMPLITUDE = 0.012;
const QUANTUM_FLOAT_RATE = 0.9;
const QUANTUM_PULSE_RATE = 1.4;

/* ========================================================================== */
/* 60° 全息数字雷达扫描扇区（Digital Radar Sweep Sector）                        */
/* ========================================================================== */

/**
 * 雷达扫描扇区的角速度（rad/s）。
 *
 * 【为何是 0.38】一圈约 16.5 秒。真实军用雷达通常是 2~6 秒/圈，
 * 但那种速度在视觉上会变成"闪烁"而非"扫描"——人眼来不及跟踪前沿
 * 扫过地面网格的过程。0.38 让扫描线以肉眼可跟随的速度匀速推移，
 * 既保留"雷达感"，又能看清扫过之处激发的回波。
 */
const RADAR_SWEEP_SPEED = 0.38;

/**
 * 扫描扇区的总张角（弧度）。
 *
 * 60° = π/3。这是军用雷达 PPI 显示器的经典扇形张角：
 * 足够宽以形成"扇面"的体积感，又足够窄以保持"指向性"——
 * 张角超过 120° 就退化成一圈旋转的发光环，失去扫描的方向语义。
 */
const RADAR_SECTOR_ANGLE = Math.PI / 3;

/** 扇区内半径与外半径（覆盖主能量环内部，不越出机架轨道） */
const RADAR_SECTOR_INNER = 0.55;
const RADAR_SECTOR_OUTER = RACK_RADIUS - 0.55;

/**
 * 扫描扇区的顶点着色器。
 *
 * 【只传 uv】扇形的全部视觉逻辑都在片元里（角向梯度 + 径向衰减），
 * 顶点阶段只需要把平面 uv 透传下去，任何多余计算都是浪费。
 */
const RADAR_SECTOR_VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * 扫描扇区的片元着色器 —— 前沿锐利激光线 + 指数衰减尾迹。
 *
 * 【极坐标重建】扇区是一个 PlaneGeometry，在片元里用 uv 反推极坐标：
 *   · 直角坐标 p = (uv − 0.5)·2     → 归一化到 [−1,1]
 *   · 极角 θ = atan(p.y, p.x)       → 扇形的角向位置
 *   · 极径 r = length(p)            → 距圆心的远近
 *
 * 【角向梯度（核心）】扇区的总张角是 60°，其中：
 *   · 前沿（θ 最接近 0 处）= 一根锐利的青色激光扫描线
 *   · 后沿（θ 向 60° 展开）= 亮度按 e^(−k·θ) 指数衰减的半透明尾迹
 * 这个"前亮后暗"的非对称是雷达扫描最本质的特征——
 * 若做成对称渐变，看起来就只是一块旋转的扇形光斑，不是扫描。
 *
 * 【径向边缘软化】扇形的内外半径处必须 smoothstep 归零，
 * 否则会看到两个硬圆形边界。
 */
const RADAR_SECTOR_FRAGMENT_SHADER = `
  uniform vec3 uColor;
  uniform vec3 uEdgeColor;
  uniform float uSweepAngle;
  uniform float uSectorAngle;
  uniform float uInner;
  uniform float uOuter;
  uniform float uIntensity;

  varying vec2 vUv;

  void main() {
    /* 极坐标重建 */
    vec2 p = (vUv - 0.5) * 2.0;
    float radius = length(p);
    float theta = atan(p.y, p.x);

    /*
     * 把片元角度换算成"相对扫描前沿的角向偏移"。
     * uSweepAngle 是当前扫描前沿的角度，用 fract 保证跨 ±π 回绕正确。
     */
    float rel = theta - uSweepAngle;
    /* 归一到 [−π, π)：这是环形角差的标准写法 */
    rel = mod(rel + 3.14159265, 6.28318531) - 3.14159265;

    /*
     * 【方位掩码】只有落在 [0, uSectorAngle] 区间内的片元才属于扇区。
     * rel = 0 是前沿（最亮），rel 增大则向后沿展开。
     * 用负值区（rel < 0）完全剔除——雷达扫描只朝一个方向拖尾。
     */
    float inSector = step(0.0, rel) * step(rel, uSectorAngle);

    /*
     * 【角向衰减】
     * · 前沿：exp(−rel·14) 形成极窄的高亮线（rel=0 处为 1，rel=0.05 处降到 0.5）
     * · 后沿：整体按 exp(−rel·2.2) 缓慢衰减，形成可见的扇形尾迹
     * 两者相乘 → 前沿锐利、尾部渐隐，正是雷达 PPI 的经典形态。
     */
    float frontLine = exp(-rel * 14.0);
    float trailFade = exp(-rel * 2.2);
    float angular = (frontLine * 1.0 + trailFade * 0.32) * inSector;

    /*
     * 【径向衰减】距圆心越远越淡（能量从中心向外扩散）
     * 同时内外边界各留 12% 软化带，避免硬圆边。
     */
    float radialNorm = (radius - uInner) / (uOuter - uInner);
    float radialMask = smoothstep(0.0, 0.12, radialNorm) * smoothstep(1.0, 0.88, radialNorm);
    /* 沿半径方向再叠一层由内向外递减的强度 */
    float radialFade = 1.0 - 0.45 * clamp(radialNorm, 0.0, 1.0);

    /*
     * 【网格回波】在扫描面上叠一层细密同心环，模拟"扫过地面网格时
     * 激发出的回波纹路"。用 r 的高频正弦，密度随半径略变。
     */
    float echoRings = 0.55 + 0.45 * sin(radius * 46.0);
    float echoGain = 0.75 + 0.25 * echoRings;

    /*
     * 【颜色】前沿偏白青（激光），尾迹偏深青蓝（扩散的光）
     */
    vec3 color = mix(uColor, uEdgeColor, clamp(frontLine, 0.0, 1.0));

    float alpha = angular * radialMask * radialFade * echoGain * uIntensity;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;
const GUIDE_RAIL_LENGTH = 0.62;
const GUIDE_RAIL_OFFSET_X = 0.92;
const GUIDE_RAIL_OFFSET_Z = 2.05;

/** 环的线段数：96 段足以在近距离观察下看不出多边形棱角 */
const RING_SEGMENTS = 96;

/** 主色：轨道常态（低饱和青，作为背景结构不抢主体） */
const COLOR_ORBIT = '#1e4d5c';

/** 主色：内环 / 径向电路 / 刻度（略亮，呼应控制平面） */
const COLOR_INNER = '#22d3ee';

/** 高危色：故障链路 */
const COLOR_FAULT = '#f43f5e';

/** 正常色：机架基座环（青绿，与 Pod Running 语义同源） */
const COLOR_BASE_HEALTHY = '#10b981';

/** 机架基座环透明度：正常态克制、故障态醒目 */
const OPACITY_BASE_HEALTHY = 0.42;
const OPACITY_BASE_FAULT = 0.85;

/** 贴地高度：略高于 Grid 与反射地面，避免 z-fighting */
const FLOOR_Y = 0.014;

/** 各动画角速度 / 推进速度（rad/s 与 周期/s） */
const ORBIT_PULSE_SPIN_RATE = 0.28;
const PEDESTAL_TEETH_SPIN_RATE = -0.20;

/* ========================================================================== */
/* 预计算表（模块加载期一次求值）                                                */
/* ========================================================================== */

/** 弧段参数：thetaStart / thetaLength */
interface ArcSpec {
  readonly thetaStart: number;
  readonly thetaLength: number;
}

/**
 * 生成均分的断弧表（用于虚线刻度、括弧环）。
 *
 * 【为何预计算】这些弧段的 thetaStart 只依赖常量与序号，可在模块加载期
 * 一次算好；若写在 JSX 里逐帧求值会产生大量临时对象，且每帧结果相同。
 *
 * @param count 段数
 * @param duty  每段占扇区比例（<1 则形成间隙）
 */
function buildArcs(count: number, duty: number): readonly ArcSpec[] {
  const sector = (Math.PI * 2) / count;
  const arcs: ArcSpec[] = [];
  for (let i = 0; i < count; i++) {
    arcs.push({ thetaStart: i * sector, thetaLength: sector * duty });
  }
  return arcs;
}

/** 主轨道外侧 64 段虚线刻度 */
const ORBIT_TICKS: readonly ArcSpec[] = buildArcs(ORBIT_TICK_COUNT, ORBIT_TICK_DUTY);

/** 基座最外圈 8 段锁定括弧 */
const PEDESTAL_BRACKETS: readonly ArcSpec[] = buildArcs(
  PEDESTAL_BRACKET_COUNT,
  PEDESTAL_BRACKET_DUTY,
);

/**
 * 基座 36 枚径向刻度齿的位置与朝向。
 *
 * 【几何】齿为长轴沿 Z 的小方块，位置 (R·sinθ, 0, R·cosθ)，
 * 绕 Y 旋转 θ 后长轴指向圆心——与主轨道刻度同一构造语言。
 */
const PEDESTAL_TEETH: ReadonlyArray<{
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
}> = (() => {
  const teeth: Array<{ position: readonly [number, number, number]; rotationY: number }> = [];
  for (let i = 0; i < PEDESTAL_TEETH_COUNT; i++) {
    const theta = (Math.PI * 2 * i) / PEDESTAL_TEETH_COUNT;
    teeth.push({
      position: [
        PEDESTAL_TEETH_RADIUS * Math.sin(theta),
        0,
        PEDESTAL_TEETH_RADIUS * Math.cos(theta),
      ],
      rotationY: theta,
    });
  }
  return teeth;
})();

/* ========================================================================== */
/* 故障机架判定                                                               */
/* ========================================================================== */

/**
 * isRackFaulted —— 判断某个机架是否处于故障态。
 *
 * 【口径】与 ErrorRippleRing / WorkerRack3D 的状态语义保持一致：
 * 节点自身非 Ready（NetworkPartition），**或其名下存在崩溃 Pod**。
 * 后者更重要——机架本身健康但里面的容器在崩溃，也是需要高亮的事实。
 *
 * @param node 机架节点实体
 * @param pods 当前集群快照的 Pod 列表（用于查状态）
 * @returns 是否需要以故障色渲染
 */
function isRackFaulted(node: WorkerNodeEntity, pods: readonly PodEntity[]): boolean {
  if (node.status === 'NetworkPartition') return true;
  return pods.some(
    (pod): boolean =>
      pod.nodeId === node.id && (pod.status === 'CrashLoopBackOff' || pod.status === 'OOMKilled'),
  );
}

/* ========================================================================== */
/* 机架落脚点数据契约                                                            */
/* ========================================================================== */

/**
 * 单个机架的落脚点渲染数据。
 *
 * 【为何从 getRackTransform 取坐标而非按数组下标算角度】
 * 机架真实位置由 spatialLayout 的 getRackTransform(rackIndex) 唯一决定。
 * 若这里用数组下标推导，一旦节点顺序与 rackIndex 不一致，基座环与径向总线
 * 就会偏到别的机架上。直接读 node.rackIndex 并调用同一函数，
 * 保证与 WorkerRack3D / PodInstancedMesh 共用单一事实源。
 */
interface RackFooting {
  /** React key（节点 id） */
  readonly key: string;
  /** 世界 XZ 平面坐标（Y 恒为 0，统一由父 group 抬到 FLOOR_Y） */
  readonly x: number;
  readonly z: number;
  /** 该机架的极角（用于把径向总线旋转到正确朝向） */
  readonly angle: number;
  /** 是否处于故障态（决定基座与总线的颜色/透明度） */
  readonly faulted: boolean;
}

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/* ========================================================================== */
/* 中央 6 级全息雷达底座 + 地面数据星城（合并批次，严格控制 Draw Call）              */
/* ========================================================================== */

/**
 * SoupBuffers —— 顶点色「三角汤」累加器。
 *
 * 【为什么不用 BufferGeometryUtils】合并现成几何要处理 index / normal / uv
 * 的对齐，代码量大且易错；而雷达环带本质是**极坐标参数面**，
 * 直接在构建期按 `(半径, 角度)` 算三角形顶点，输出两组平行的
 * position / color 数组即可。没有 index、没有 uv、没有法线
 * （材质用 Basic + 加色混合，不参与光照），构建完一次性上传 GPU。
 *
 * 【加色混合下的"透明"】加色混合中黑色 == 不可见，
 * 因此径向淡出只需把顶点色乘系数趋近 0，无需逐顶点 alpha。
 */
interface SoupBuffers {
  readonly positions: number[];
  readonly colors: number[];
}

/** 新建空累加器 */
function createSoup(): SoupBuffers {
  return { positions: [], colors: [] };
}

/**
 * hexToRgb01 —— 十六进制色串 → 归一化 RGB（构建期一次求值）。
 *
 * @param hex 形如 '#38bdf8'
 * @returns [r, g, b]，各分量 ∈ [0, 1]
 */
function hexToRgb01(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/**
 * pushAnnulus —— 把一段极坐标环带压入三角汤。
 *
 * 【几何】对每个角度步进生成一个四边形（两个三角形），
 * 内/外半径各一圈顶点。`fadeOutward` 为真时，顶点色按半径线性衰减到 0，
 * 在加色混合下形成「向外羽化消失」的辉光带——这正是雷达底盘的柔光边缘。
 */
function pushAnnulus(
  soup: SoupBuffers,
  rInner: number,
  rOuter: number,
  thetaStart: number,
  thetaLength: number,
  segments: number,
  colorHex: string,
  fadeOutward: boolean,
): void {
  const rgb = hexToRgb01(colorHex);
  for (let i = 0; i < segments; i++) {
    const a0 = thetaStart + (thetaLength * i) / segments;
    const a1 = thetaStart + (thetaLength * (i + 1)) / segments;
    const cos0 = Math.cos(a0);
    const sin0 = Math.sin(a0);
    const cos1 = Math.cos(a1);
    const sin1 = Math.sin(a1);

    const innerScale = fadeOutward ? 1 : 1;
    const outerScale = fadeOutward ? 0.18 : 1;

    /* 两个三角形：(内0, 外0, 外1) 与 (内0, 外1, 内1) */
    soup.positions.push(
      rInner * cos0, 0, rInner * sin0,
      rOuter * cos0, 0, rOuter * sin0,
      rOuter * cos1, 0, rOuter * sin1,
      rInner * cos0, 0, rInner * sin0,
      rOuter * cos1, 0, rOuter * sin1,
      rInner * cos1, 0, rInner * sin1,
    );
    const pushColor = (scale: number): void => {
      soup.colors.push(rgb[0] * scale, rgb[1] * scale, rgb[2] * scale);
    };
    pushColor(innerScale);
    pushColor(outerScale);
    pushColor(outerScale);
    pushColor(innerScale);
    pushColor(outerScale);
    pushColor(innerScale);
  }
}

/**
 * pushTick —— 把一枚径向刻度齿（极细长条）压入三角汤。
 *
 * @param radius 齿中心的轨道半径
 * @param theta 齿所在角度
 * @param angularWidth 角宽度（弧度，极小时呈细线）
 * @param radialLength 径向长度
 */
function pushTick(
  soup: SoupBuffers,
  radius: number,
  theta: number,
  angularWidth: number,
  radialLength: number,
  colorHex: string,
): void {
  const rgb = hexToRgb01(colorHex);
  const rIn = radius - radialLength / 2;
  const rOut = radius + radialLength / 2;
  const a0 = theta - angularWidth / 2;
  const a1 = theta + angularWidth / 2;
  soup.positions.push(
    rIn * Math.cos(a0), 0, rIn * Math.sin(a0),
    rOut * Math.cos(a0), 0, rOut * Math.sin(a0),
    rOut * Math.cos(a1), 0, rOut * Math.sin(a1),
    rIn * Math.cos(a0), 0, rIn * Math.sin(a0),
    rOut * Math.cos(a1), 0, rOut * Math.sin(a1),
    rIn * Math.cos(a1), 0, rIn * Math.sin(a1),
  );
  for (let k = 0; k < 6; k++) soup.colors.push(rgb[0], rgb[1], rgb[2]);
}

/** 把三角汤装成 BufferGeometry（position + color 两组属性） */
function soupToGeometry(soup: SoupBuffers): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(soup.positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(soup.colors, 3));
  return geometry;
}

/* ---- 6 级雷达底座的半径规格 ---- */

/** 核心亮环带（双道高亮青） */
const RADAR_CORE_RINGS: ReadonlyArray<{ r: number; w: number; hex: string }> = [
  { r: 1.55, w: 0.055, hex: '#38bdf8' },
  { r: 2.25, w: 0.042, hex: '#38bdf8' },
];

/** 外扩能量围栏（双轨细线 + 24 枚锚点） */
const RADAR_FENCE_RINGS: ReadonlyArray<{ r: number; w: number; hex: string }> = [
  { r: 4.15, w: 0.020, hex: '#22d3ee' },
  { r: 4.95, w: 0.016, hex: '#22d3ee' },
];

/** 阶梯断续扇形装甲弧的两道半径 */
const RADAR_ARC_RADII: readonly number[] = [2.65, 3.35];

/** 每道装甲弧的段数（12 段不对称弧）与雷达刻度数（72 道） */
const RADAR_ARC_SEGMENTS = 12;
const RADAR_TICK_COUNT = 72;

/**
 * pushBand —— 把一条沿坐标轴的直线光带压入三角汤（用于十字基准激光）。
 *
 * 【为何并入雷达静态几何】若单独做 mesh，十字激光要多 2 次 Draw Call；
 * 它与雷达环带用的是**同一套材质**（顶点色 + 加色混合），
 * 直接写进同一份三角汤即可零额外开销。
 *
 * @param alongX true 沿 X 轴铺开，false 沿 Z 轴铺开
 * @param fade 端点是否淡出（加色下淡出即颜色趋 0）
 */
function pushBand(
  soup: SoupBuffers,
  length: number,
  width: number,
  alongX: boolean,
  colorHex: string,
  fade: boolean,
): void {
  const rgb = hexToRgb01(colorHex);
  const halfL = length / 2;
  const halfW = width / 2;
  const steps = 48;

  for (let i = 0; i < steps; i++) {
    const t0 = -halfL + (length * i) / steps;
    const t1 = -halfL + (length * (i + 1)) / steps;
    /* 端点淡出系数：中心 1、两端 0 */
    const fadeAt = (value: number): number =>
      fade ? Math.max(0, 1 - Math.abs(value) / halfL) : 1;

    const s0 = fadeAt(t0);
    const s1 = fadeAt(t1);

    /**
     * 中央静默区衰减（本轮新增）。
     *
     * 【解决什么】水平发光总线横贯整个地面，包括原点正上方。而中央主控铭牌
     * 就悬浮在 r ≈ 1.48 处、正对着这条亮线——地面强光会从文字背后穿过去，
     * 把铭牌压得看不清。
     *
     * 【数学】按顶点到原点的平面距离做 smoothstep：
     *   d = hypot(x, z)
     *   scale = smoothstep(CENTER_QUIET_INNER, CENTER_QUIET_OUTER, d)
     * r < 1.05 完全熄灭、1.05~1.6 平滑爬升、r > 1.6 恢复原亮度。
     * 用 smoothstep 而非线性 clamp：线性会在过渡区留下可见的亮度折角，
     * S 形曲线让光看起来是"被中心吞掉"而不是"被切掉一段"。
     */
    const centerQuietAt = (x: number, z: number): number => {
      const d = Math.hypot(x, z);
      const t = Math.min(
        1,
        Math.max(0, (d - CENTER_QUIET_INNER) / (CENTER_QUIET_OUTER - CENTER_QUIET_INNER)),
      );
      return t * t * (3 - 2 * t);
    };

    const quad: ReadonlyArray<readonly [number, number]> = alongX
      ? [
          [t0, -halfW],
          [t1, -halfW],
          [t1, halfW],
          [t0, -halfW],
          [t1, halfW],
          [t0, halfW],
        ]
      : [
          [-halfW, t0],
          [-halfW, t1],
          [halfW, t1],
          [-halfW, t0],
          [halfW, t1],
          [halfW, t0],
        ];
    const scales: ReadonlyArray<number> = alongX
      ? [s0, s1, s1, s0, s1, s0]
      : [s0, s1, s1, s0, s1, s0];

    for (let k = 0; k < quad.length; k++) {
      /* 顶点色 = 端点淡出 × 中央静默区衰减 */
      const scale = scales[k] * centerQuietAt(quad[k][0], quad[k][1]);
      soup.positions.push(quad[k][0], 0, quad[k][1]);
      soup.colors.push(rgb[0] * scale, rgb[1] * scale, rgb[2] * scale);
    }
  }
}

/**
 * 中央静默区半径（水平发光总线的透明度衰减区间）。
 *
 * 【取值依据】内半径 1.05 = 内层晶核在世界地面的投影半径；
 * 外半径 1.6 ≈ 中央主控铭牌所在的 r≈1.48 之外一点。
 * 两者之间是"光被吞掉"的过渡带，确保铭牌文字背后不再有强光穿过。
 */
const CENTER_QUIET_INNER = 1.05;
const CENTER_QUIET_OUTER = 1.6;

/** 围栏锚点数量 */
const RADAR_ANCHOR_COUNT = 24;

/** 雷达装甲弧批次的自转角速度（rad/s，约 21 秒一圈，从容的巡检节奏） */
const RADAR_ARC_SPIN_RATE = 0.30;

/**
 * 雷达底座「静态部分」几何（构建期一次）：羽化底盘 + 4 道环 + 24 锚点。
 *
 * 羽化底盘用 fadeOutward 环带实现：内缘亮、外缘衰减到黑，
 * 加色混合下自然形成柔和径向辉光，无需额外贴图。
 */
const RADAR_STATIC_GEOMETRY: THREE.BufferGeometry = (() => {
  const soup = createSoup();

  /* 羽化辉光底盘：从 r=0.85 铺到 r=1.55，向外淡出 */
  pushAnnulus(soup, 0.85, 1.55, 0, Math.PI * 2, 96, '#0ea5e9', true);

  /* 核心双环 */
  for (const ring of RADAR_CORE_RINGS) {
    pushAnnulus(soup, ring.r - ring.w, ring.r, 0, Math.PI * 2, 160, ring.hex, false);
  }
  /* 围栏双轨 */
  for (const ring of RADAR_FENCE_RINGS) {
    pushAnnulus(soup, ring.r - ring.w, ring.r, 0, Math.PI * 2, 160, ring.hex, false);
  }
  /* 24 枚环上亮锚点（极短弧段，视觉上是亮钉） */
  for (let i = 0; i < RADAR_ANCHOR_COUNT; i++) {
    const theta = (Math.PI * 2 * i) / RADAR_ANCHOR_COUNT;
    pushTick(soup, 4.55, theta, 0.030, 0.16, '#e0f2fe');
  }

  /*
   * 十字基准激光：横贯左右 / 前后视野的两条细光带，端点淡出。
   * 它对应参考图里那条极有张力的横向青色激光束——
   * 单独一条环环相扣的同心环是"静态仪表"，加上十字轴线才有"扫描场"的空间感。
   */
  pushBand(soup, 26, 0.055, true, '#38bdf8', true);
  pushBand(soup, 26, 0.055, false, '#0ea5e9', true);

  return soupToGeometry(soup);
})();

/**
 * 雷达底座「旋转部分」几何：12 段不对称装甲弧 × 2 道 + 72 道刻度。
 *
 * 单独成批是为了让它在 useFrame 里整体自转（静态部分不动），
 * 且仍然只占 1 次 Draw Call。
 */
const RADAR_ARC_GEOMETRY: THREE.BufferGeometry = (() => {
  const soup = createSoup();
  for (let ri = 0; ri < RADAR_ARC_RADII.length; ri++) {
    const radius = RADAR_ARC_RADII[ri];
    const sector = (Math.PI * 2) / RADAR_ARC_SEGMENTS;
    for (let i = 0; i < RADAR_ARC_SEGMENTS; i++) {
      /* 不对称：奇数段长 0.62 扇区、偶数段长 0.34 扇区，形成阶梯节奏 */
      const duty = i % 2 === 0 ? 0.62 : 0.34;
      const start = i * sector + (ri === 1 ? sector * 0.5 : 0);
      pushAnnulus(soup, radius, radius + 0.05, start, sector * duty, 10, ri === 0 ? '#38bdf8' : '#22d3ee', false);
    }
  }
  for (let i = 0; i < RADAR_TICK_COUNT; i++) {
    const theta = (Math.PI * 2 * i) / RADAR_TICK_COUNT;
    pushTick(soup, 3.78, theta, 0.008, 0.30, '#67e8f9');
  }
  return soupToGeometry(soup);
})();

/* -------------------------------------------------------------------------- */
/* 地面数据星城（1,400 颗粒子 + 极坐标电路连线）                                  */
/* -------------------------------------------------------------------------- */

/** 数据星城节点总数 */
const DATA_CITY_COUNT = 1400;

/** 同心数据环轨数量与半径范围 */
const DATA_CITY_TRACKS = 18;
const DATA_CITY_R_MIN = 3.4;
const DATA_CITY_R_MAX = 12.4;

/** 通往三台机架的径向主干道走廊角宽（走廊内不放节点，保持通道干净） */
const CORRIDOR_HALF_WIDTH = 0.11;

/**
 * 数据星城节点数据（构建期一次求值）。
 *
 * 【排布算法：同心轨道簇 + 径向扇区走廊】
 * 1. 把 r ∈ [3.4, 12.4] 均分为 18 条隐式同心环轨；
 * 2. 每条轨道上按角度推进，成簇投放 5~12 颗紧密排列的节点
 *    （模拟主板芯片电容群/机房微单元，而不是均匀撒点）；
 * 3. 若簇中心落在三条机架走廊内则整簇跳过——留出通往 Worker 的干净主干道。
 *
 * 【确定性】用固定种子 LCG，保证每次挂载/热更新得到同一张星图。
 */
const DATA_CITY_DATA: {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly sizes: Float32Array;
  readonly phases: Float32Array;
  readonly count: number;
} = (() => {
  let seed = 20260817;
  const nextRandom = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const positions: number[] = [];
  const colors: number[] = [];
  const sizes: number[] = [];
  const phases: number[] = [];

  /* 三条走廊的中心角：与 getRackTransform 的机架角一致（0 / 2π/3 / 4π/3） */
  const corridorAngles: readonly number[] = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3];
  const inCorridor = (theta: number): boolean => {
    for (const center of corridorAngles) {
      let delta = Math.abs(theta - center);
      while (delta > Math.PI) delta = Math.abs(delta - Math.PI * 2);
      if (delta < CORRIDOR_HALF_WIDTH) return true;
    }
    return false;
  };

  let placed = 0;
  while (placed < DATA_CITY_COUNT) {
    /* 随机挑一条轨道 */
    const trackIndex = Math.floor(nextRandom() * DATA_CITY_TRACKS);
    const radius =
      DATA_CITY_R_MIN +
      ((DATA_CITY_R_MAX - DATA_CITY_R_MIN) * trackIndex) / (DATA_CITY_TRACKS - 1);

    /* 簇中心角 + 簇内 5~12 颗紧密排列 */
    const clusterCenter = nextRandom() * Math.PI * 2;
    if (inCorridor(clusterCenter)) continue;

    const clusterSize = 5 + Math.floor(nextRandom() * 8);
    const step = 0.012 + nextRandom() * 0.01;
    for (let k = 0; k < clusterSize && placed < DATA_CITY_COUNT; k++) {
      const theta = clusterCenter + (k - clusterSize / 2) * step;
      const jitter = (nextRandom() - 0.5) * 0.06;
      const r = radius + jitter;
      positions.push(r * Math.cos(theta), 0, r * Math.sin(theta));

      /* 色彩分布：70% 冰青 / 20% 翠绿 / 10% 星白或暖金 */
      const roll = nextRandom();
      let hex = '#38bdf8';
      if (roll < 0.55) hex = '#38bdf8';
      else if (roll < 0.7) hex = '#0ea5e9';
      else if (roll < 0.9) hex = '#10b981';
      else hex = nextRandom() < 0.5 ? '#e0f2fe' : '#fbbf24';
      const rgb = hexToRgb01(hex);
      colors.push(rgb[0], rgb[1], rgb[2]);

      sizes.push(0.9 + nextRandom() * 0.9);
      phases.push(nextRandom() * Math.PI * 2);
      placed++;
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    sizes: new Float32Array(sizes),
    phases: new Float32Array(phases),
    count: DATA_CITY_COUNT,
  };
})();

/** 数据星城 Points 几何 */
const DATA_CITY_GEOMETRY: THREE.BufferGeometry = (() => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(DATA_CITY_DATA.positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(DATA_CITY_DATA.colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(DATA_CITY_DATA.sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(DATA_CITY_DATA.phases, 1));
  return geometry;
})();

/**
 * 数据星城的顶点着色器。
 *
 * 【径向数据波】`wave = 0.5 + 0.5·sin(uTime·1.6 − radius·0.9 + aPhase)`
 * 相位随**半径**递减（负号）意味着同一波峰出现在更大的半径上需要更晚时刻，
 * 于是整片地面呈现"数据波从中心 API-Server 向外圈扩散"的动势。
 * aPhase 让每颗点再错开一点，避免形成过于机械的同心环波纹。
 */
const DATA_CITY_VERTEX_SHADER = `
attribute vec3 aColor;
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;
uniform vec3 uFaultAngles;
uniform vec3 uFaultLevels;
uniform float uFaultSectorHalf;

varying vec3 vColor;
varying float vGlow;

/*
 * ---- 故障扇区传染（Fault Contagion）----
 *
 * 【核心数学】把节点的极角与该机架的极角求最小角距：
 *   d = min(|ang − angle_i|, 2π − |ang − angle_i|)
 * 若 d < 扇区半角（±35°，即 0.611 rad），说明该节点落在故障机架的扇区内。
 * 再乘一个 smoothstep 边缘衰减（0.6~1.0 半角之间渐弱），
 * 避免扇区边界出现一刀切的硬边。
 *
 * 【为何 useFrame 里 lerp 而不是直接传布尔】故障是突变事件，
 * 但地面染红应当是"扩散过去"的过程；电平 uFaultLevels 在 CPU 侧逐帧
 * 指数阻尼逼近目标值，因此颜色过渡自然，且不需要在着色器里做时间积分。
 */
float sectorFault(float ang) {
  float maxLevel = 0.0;
  for (int i = 0; i < 3; i++) {
    float target = uFaultAngles[i];
    float delta = abs(ang - target);
    float dist = min(delta, 6.2831853 - delta);
    float falloff = 1.0 - smoothstep(uFaultSectorHalf * 0.6, uFaultSectorHalf, dist);
    maxLevel = max(maxLevel, falloff * uFaultLevels[i]);
  }
  return maxLevel;
}

void main() {
  float radius = length(position.xz);
  float wave = 0.5 + 0.5 * sin(uTime * 1.6 - radius * 0.9 + aPhase);
  vGlow = 0.35 + 0.75 * wave;

  /* 故障扇区染红：状态色向绯红 #f43f5e 混合，并叠加 6Hz 告警脉冲 */
  float ang = atan(position.z, position.x);
  float fault = sectorFault(ang);
  if (fault > 0.001) {
    vec3 alertColor = vec3(0.957, 0.247, 0.369);
    float pulse = 0.72 + 0.28 * sin(uTime * 6.0 + radius * 1.4);
    vColor = mix(aColor, alertColor, clamp(fault, 0.0, 1.0) * 0.85 * pulse);
    vGlow = max(vGlow, fault * 1.15 * pulse);
  } else {
    vColor = aColor;
  }

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  /*
   * 【点尺寸】gl_PointSize = aSize · 波动 · uScale · (90 / −mv.z)
   * 90 是经验缩放常数：主相机距原点约 22 单位时得到 ~4px 的点，
   * 既能看清「中心亮核 + 柔光」，又不会糊成一片光斑。
   * 若取 26（最初的取值），该距离下只有 1.2px，星城几乎不可见。
   */
  gl_PointSize = aSize * (0.85 + 0.35 * wave) * uScale * (90.0 / max(0.001, -mvPosition.z));
}
`;

/**
 * 数据星城的片元着色器 —— 「中心锐利亮核 + 外圈柔和光晕」。
 *
 * 【为何不用默认 PointsMaterial】默认点是方形像素块，且无逐点色相。
 * 这里用 gl_PointCoord 求到中心距离 d：
 *   core = 1 − smoothstep(0, 0.18, d)   → 极小的锐利亮核
 *   halo = 1 − smoothstep(0.15, 1, d)   → 宽广柔光
 * alpha = (core·0.95 + halo·0.35)·vGlow，并在 d→1 前归零，边界完全消失。
 * 颜色在亮核处向白色靠拢 80%，因此无论底色是青是绿是金，中心都"过曝发亮"。
 */
const DATA_CITY_FRAGMENT_SHADER = `
varying vec3 vColor;
varying float vGlow;

void main() {
  vec2 centered = gl_PointCoord - vec2(0.5);
  float d = length(centered) * 2.0;
  if (d > 1.0) discard;

  float core = 1.0 - smoothstep(0.0, 0.18, d);
  float halo = 1.0 - smoothstep(0.15, 1.0, d);

  vec3 color = mix(vColor, vec3(1.0), core * 0.8);
  float alpha = (core * 0.95 + halo * 0.35) * vGlow;

  gl_FragColor = vec4(color, alpha);
}
`;

/** 电路连线数量（160 段短弧 + 径向跳线） */
const TRACE_SEGMENT_COUNT = 160;

/**
 * 地面极坐标微电路连线几何（单 LineSegments，1 次 Draw Call）。
 *
 * 【设计意图】1,400 颗孤立亮点只是"撒了一把光尘"；沿环轨画出断续短弧后，
 * 它们才连成一张**发光的数字母板**。因此短弧的半径与数据星城的轨道一致，
 * 视觉上像"点被电路串起来"，而不是两套无关的装饰。
 */
const TRACE_GEOMETRY: THREE.BufferGeometry = (() => {
  let seed = 20260818;
  const nextRandom = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const vertices: number[] = [];
  const arcSteps = 4;
  for (let i = 0; i < TRACE_SEGMENT_COUNT; i++) {
    const trackIndex = Math.floor(nextRandom() * DATA_CITY_TRACKS);
    const radius =
      DATA_CITY_R_MIN +
      ((DATA_CITY_R_MAX - DATA_CITY_R_MIN) * trackIndex) / (DATA_CITY_TRACKS - 1);
    const startAngle = nextRandom() * Math.PI * 2;
    const span = 0.05 + nextRandom() * 0.16;

    for (let s = 0; s < arcSteps; s++) {
      const a0 = startAngle + (span * s) / arcSteps;
      const a1 = startAngle + (span * (s + 1)) / arcSteps;
      vertices.push(radius * Math.cos(a0), 0, radius * Math.sin(a0));
      vertices.push(radius * Math.cos(a1), 0, radius * Math.sin(a1));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  return geometry;
})();

/**
 * ClusterTopologyFloor3D —— 多层动态数码光圈 + 刻度扫描环 + 脉冲流动电路。
 *
 * 仅依赖节点的 id / status / rackIndex 与 Pod 的 nodeId / status，
 * 不订阅高频遥测，因此只在快照状态位变化时重渲染（低频）。
 */
export default function ClusterTopologyFloor3D(): React.ReactElement {
  const nodes = useClusterStore((s): readonly WorkerNodeEntity[] => s.snapshotSummary.nodes);
  const pods = useClusterStore((s): readonly PodEntity[] => s.snapshotSummary.pods);

  /**
   * 每个机架的落脚点（位置 / 朝向 / 故障态）。
   *
   * 仅在节点或 Pod 状态位变化时重算（低频），不在 useFrame 热路径上。
   */
  const racks = useMemo((): readonly RackFooting[] => {
    return nodes.map((node): RackFooting => {
      const transform = getRackTransform(node.rackIndex);
      const x = transform.position[0];
      const z = transform.position[2];
      return {
        key: node.id,
        x,
        z,
        /* 极角：由实际坐标反解，天然与 getRackTransform 同源且符号安全 */
        angle: Math.atan2(x, z),
        faulted: isRackFaulted(node, pods),
      };
    });
  }, [nodes, pods]);

  /* ---- 动画通道 ref（useFrame 内原地写入，零分配） ---- */
  const orbitPulseRef = useRef<THREE.Group>(null);
  /** 每机架的刻度齿实例网格（反向自转：整体旋转该 mesh 即可） */
  const teethRefs = useRef<Array<THREE.InstancedMesh | null>>([]);
  /** 每机架径向总线上的流动光脉冲 */
  const lanePulseRefs = useRef<Array<THREE.Mesh | null>>([]);
  /** 主轨道 64 段虚线刻度的单实例网格（1 次 Draw Call） */
  const orbitTicksRef = useRef<THREE.InstancedMesh>(null);

  /** 加密罗盘微刻度（128 枚，1 次 Draw Call） */
  const compassTicksRef = useRef<THREE.InstancedMesh>(null);
  /** 双层错位量子点阵 A（96 枚） */
  const quantumLayerARef = useRef<THREE.InstancedMesh>(null);
  /** 双层错位量子点阵 B（120 枚） */
  const quantumLayerBRef = useRef<THREE.InstancedMesh>(null);

  /**
   * 中央雷达「旋转批次」(12 段装甲弧 × 2 道 + 72 道刻度)ref。
   *
   * 静态部分(羽化底盘 + 4 道环 + 24 锚点)不需要 ref;
   * 只有这一批需要在 useFrame 里整体自转,因此单独成 mesh。
   */
  const radarArcRef = useRef<THREE.Mesh>(null);

  /**
   * 数据星城的 uniforms(useMemo 预分配,useFrame 内只写 .value)。
   *
   * uTime 驱动径向数据波;uScale 是点尺寸整体缩放(相机距离兜底调节)。
   */
  const dataCityUniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uTime: { value: 0 },
      uScale: { value: 1 },
      /* 三个机架的极角（与 getRackTransform 同源，由 racks 派生） */
      uFaultAngles: { value: new THREE.Vector3(0, 0, 0) },
      /* 三个扇区当前的故障电平 0~1（useFrame 内指数阻尼逼近目标） */
      uFaultLevels: { value: new THREE.Vector3(0, 0, 0) },
      /* 扇区半角：±35° = 0.6109 rad */
      uFaultSectorHalf: { value: (35 * Math.PI) / 180 },
    }),
    [],
  );

  /**
   * 60° 雷达扫描扇区的 uniforms（useMemo 预分配，useFrame 内只写 .value）。
   *
   * 【为何 uSweepAngle 用标量而非时间】着色器里若用 `uTime * speed` 算角度，
   * 长时间运行后浮点精度会下降（t 到几千秒时角度精度不足，前沿会抖动）。
   * 由 CPU 侧维护 angle 并做 mod 2π 归约，传给着色器的永远是 [0, 2π) 的小数，
   * 精度恒定。
   */
  const radarSweepUniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uColor: { value: new THREE.Color('#0e7490') },
      uEdgeColor: { value: new THREE.Color('#a5f3fc') },
      uSweepAngle: { value: 0 },
      uSectorAngle: { value: RADAR_SECTOR_ANGLE },
      uInner: { value: RADAR_SECTOR_INNER / RADAR_SECTOR_OUTER },
      uOuter: { value: 1 },
      uIntensity: { value: 1 },
    }),
    [],
  );

  /**
   * 雷达扫描当前角度（跨帧累积的持久态）。
   *
   * 【为何用 ref 而非在 uniforms 里累加】uniform 的 .value 是渲染侧读的，
   * 在里面做 mod 会引入浮点累积误差且语义混乱。用独立的 ref 承载
   * "纯角度"，每帧归约后再写入 uniform，职责清晰。
   */
  const radarSweepAngleRef = useRef<number>(0);

  /**
   * 故障扇区目标电平（由 racks 派生，低频）。
   *
   * 【角度口径必须与着色器一致】着色器用 `atan(position.z, position.x)`，
   * 因此这里也用 `Math.atan2(z, x)`——若一端用 atan2(x,z)，
   * 扇区会整体旋转 90°，故障染红会跑到错误的机架方向上去。
   */
  const faultTargets = useMemo((): THREE.Vector3 => {
    const levels = new THREE.Vector3(0, 0, 0);
    racks.forEach((rack, index): void => {
      if (index >= 3) return;
      levels.setComponent(index, rack.faulted ? 1 : 0);
    });
    return levels;
  }, [racks]);

  /**
   * 三个机架的极角（与 getRackTransform 同源）。
   *
   * 【角度口径必须与着色器一致】着色器用 `atan(z, x)`，
   * 因此这里也用 `Math.atan2(z, x)`——若一端用 atan2(x,z)，
   * 扇区会整体旋转 90°，故障染红会跑到错误的机架方向上。
   */
  const faultAngles = useMemo((): THREE.Vector3 => {
    const angles = new THREE.Vector3(0, 0, 0);
    racks.forEach((rack, index): void => {
      if (index >= 3) return;
      angles.setComponent(index, Math.atan2(rack.z, rack.x));
    });
    return angles;
  }, [racks]);

  /** 当前故障电平持久态（跨帧 lerp 的"当前值"） */
  const faultLevelsCurrent = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);

  teethRefs.current.length = racks.length;
  lanePulseRefs.current.length = racks.length;

  /**
   * 刻度齿实例矩阵（每机架 36 枚）与轨道刻度实例矩阵（64 段）。
   *
   * 【为何必须实例化】本文件最初把刻度齿写成 36 个独立 boxGeometry mesh、
   * 轨道刻度写成 64 个独立 ringGeometry mesh：单帧新增 ~172 次 Draw Call，
   * 再叠加 MeshReflectorMaterial 的二次场景渲染（×2），
   * 直接把软件光栅化与低端 GPU 打到**整屏黑**（不报错，只是画不出来）。
   * 改为 InstancedMesh 后这两类降为 2 次 Draw Call。
   */
  const toothMatrices = useMemo((): ReadonlyArray<THREE.Matrix4> => {
    const list: THREE.Matrix4[] = [];
    const object = new THREE.Object3D();
    for (const tooth of PEDESTAL_TEETH) {
      object.position.set(tooth.position[0], tooth.position[1], tooth.position[2]);
      object.rotation.set(0, tooth.rotationY, 0);
      object.updateMatrix();
      list.push(object.matrix.clone());
    }
    return list;
  }, []);

  const orbitTickMatrices = useMemo((): ReadonlyArray<THREE.Matrix4> => {
    const list: THREE.Matrix4[] = [];
    const object = new THREE.Object3D();
    for (const arc of ORBIT_TICKS) {
      /* 平面几何用本地 Z 旋转：mesh 已绕 X 转了 −90°，本地 Z 即世界 Y */
      object.position.set(0, 0, 0);
      object.rotation.set(0, 0, arc.thetaStart);
      object.updateMatrix();
      list.push(object.matrix.clone());
    }
    return list;
  }, []);

  /** 写入轨道刻度实例矩阵（挂载一次；StrictMode 双挂载安全） */
  useEffect((): void => {
    const mesh = orbitTicksRef.current;
    if (mesh === null) return;
    for (let i = 0; i < orbitTickMatrices.length; i++) {
      mesh.setMatrixAt(i, orbitTickMatrices[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [orbitTickMatrices]);

  /**
   * 加密罗盘微刻度的实例矩阵（挂载一次）。
   *
   * 【矩阵构造】与轨道刻度同一套手法：mesh 整体绕 X 转 −90° 平铺到地面，
   * 因此实例只需在**本地 Z 轴**上旋转即可摆到各自角度。
   * 几何是一段 arc（thetaStart=0），旋转 θ 后即落在 θ 位置。
   *
   * 【为何预计算而非每帧算】刻度是完全静态的装饰，
   * 每帧重算 128 次矩阵是纯浪费。挂载时写一次，之后只读。
   */
  const compassTickMatrices = useMemo((): THREE.Matrix4[] => {
    const list: THREE.Matrix4[] = [];
    /* 临时 Object3D 仅在 useMemo 内使用，不进入渲染循环 */
    const object = new THREE.Object3D();
    for (let i = 0; i < COMPASS_TICK_COUNT; i += 1) {
      const theta = (i / COMPASS_TICK_COUNT) * Math.PI * 2;
      object.position.set(0, 0, 0);
      object.rotation.set(0, 0, theta);
      object.scale.set(1, 1, 1);
      object.updateMatrix();
      list.push(object.matrix.clone());
    }
    return list;
  }, []);

  useEffect((): void => {
    const mesh = compassTicksRef.current;
    if (mesh === null) return;
    for (let i = 0; i < compassTickMatrices.length; i++) {
      mesh.setMatrixAt(i, compassTickMatrices[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [compassTickMatrices]);

  /**
   * 双层量子点阵的实例矩阵（挂载一次）。
   *
   * 【核心数学：两层错位】A 层 96 枚沿半径 rA 均匀分布；
   * B 层 120 枚沿半径 rB 分布，且初始角**额外偏移半格**
   * （π / QUANTUM_LAYER_B_COUNT）。因为两层格距不同，
   * 半格偏移使相邻点的实际间距不再是常数，
   * 叠加后形成接近随机的分布——这是打破"规则点阵感"的关键。
   *
   * 【位置在本地 XY 平面】mesh 绕 X 转 −90° 后本地 XY 即世界 XZ 地面，
   * 因此这里直接用 (cos·r, sin·r, 0) 构造即可，无需再做坐标变换。
   */
  const quantumMatrices = useMemo(
    (): { readonly layerA: THREE.Matrix4[]; readonly layerB: THREE.Matrix4[] } => {
      const object = new THREE.Object3D();
      const build = (count: number, radius: number, phaseOffset: number): THREE.Matrix4[] => {
        const list: THREE.Matrix4[] = [];
        for (let i = 0; i < count; i += 1) {
          const theta = (i / count) * Math.PI * 2 + phaseOffset;
          object.position.set(Math.cos(theta) * radius, Math.sin(theta) * radius, 0);
          /*
           * 每个点轻微自转一个小角度：正方形薄片若全部同向，
           * 远看会形成一致的方向纹理；随机微旋后更像悬浮的碎晶。
           * 角度用 i 的确定性函数（不用 Math.random），保证可复现。
           */
          object.rotation.set(0, 0, (i * 0.618) % (Math.PI / 2));
          object.scale.set(1, 1, 1);
          object.updateMatrix();
          list.push(object.matrix.clone());
        }
        return list;
      };
      return {
        layerA: build(QUANTUM_LAYER_A_COUNT, QUANTUM_LAYER_A_RADIUS, 0),
        layerB: build(QUANTUM_LAYER_B_COUNT, QUANTUM_LAYER_B_RADIUS, Math.PI / QUANTUM_LAYER_B_COUNT),
      };
    },
    [],
  );

  useEffect((): void => {
    const a = quantumLayerARef.current;
    if (a !== null) {
      for (let i = 0; i < quantumMatrices.layerA.length; i += 1) {
        a.setMatrixAt(i, quantumMatrices.layerA[i]);
      }
      a.instanceMatrix.needsUpdate = true;
    }
    const b = quantumLayerBRef.current;
    if (b !== null) {
      for (let i = 0; i < quantumMatrices.layerB.length; i += 1) {
        b.setMatrixAt(i, quantumMatrices.layerB[i]);
      }
      b.instanceMatrix.needsUpdate = true;
    }
  }, [quantumMatrices]);

  /** 写入各机架刻度齿实例矩阵（挂载一次；随机架数组长度变化重建） */
  useEffect((): void => {
    for (let i = 0; i < teethRefs.current.length; i++) {
      const mesh = teethRefs.current[i];
      if (mesh === null || mesh === undefined) continue;
      for (let k = 0; k < toothMatrices.length; k++) {
        mesh.setMatrixAt(k, toothMatrices[k]);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }, [toothMatrices, racks.length]);

  /**
   * useFrame —— 三类低频动画。
   *
   * 【零分配】只写 rotation.y / position.z 两个标量通道，
   * 不 new 任何 Object3D / Vector3 / Color；颜色与透明度全部来自低频渲染期。
   *
   * 【为何脉冲用 fract 而不是 sin】sin 会在两端折返（看起来像来回滑动），
   * fract 让脉冲沿总线**单向循环**输送，语义正确且无回程。
   */
  useFrame((state, delta): void => {
    const t = state.clock.getElapsedTime();

    /* 0) 数据星城推进径向数据波 + 雷达装甲弧批次自转（原地写，零分配） */
    dataCityUniforms.uTime.value = t;
    if (radarArcRef.current !== null) {
      radarArcRef.current.rotation.y = t * RADAR_ARC_SPIN_RATE;
    }

    /*
     * 0b) 故障扇区电平：向目标值做帧率无关指数阻尼。
     *
     * 【为何在 CPU 侧插值而非着色器】故障是突变事件，地面染红应"扩散过去"；
     * 在这里把电平从当前值平滑推向目标值（α = 1 − e^(−4·Δt)），
     * 着色器只需读一个连续标量，逻辑最简且零额外 GPU 分支。
     * 三个分量逐个更新后整体 copy 进 uniform（Vector3 原地写，零分配）。
     */
    const clampedDelta = Math.min(delta, 0.1);
    const faultAlpha = 1 - Math.exp(-4 * clampedDelta);
    faultLevelsCurrent.x += (faultTargets.x - faultLevelsCurrent.x) * faultAlpha;
    faultLevelsCurrent.y += (faultTargets.y - faultLevelsCurrent.y) * faultAlpha;
    faultLevelsCurrent.z += (faultTargets.z - faultLevelsCurrent.z) * faultAlpha;
    (dataCityUniforms.uFaultLevels.value as THREE.Vector3).copy(faultLevelsCurrent);
    (dataCityUniforms.uFaultAngles.value as THREE.Vector3).copy(faultAngles);

    /*
     * 0c) 60° 雷达扫描扇区推进（放在 clampedDelta 之后，依赖它）。
     *
     * 【为何用增量累积而非 t·ω】与装甲弧的 `t * RATE` 不同，这里用
     * angle += ω·Δt 再 mod 2π：
     * · 增量累积天然支持"暂停后继续"——若用绝对时间，页签切回时
     *   角度会一次性跳变到新位置，扫描看起来像瞬移；
     * · mod 2π 保证角度始终落在 [0, 6.28)，着色器收到的始终是小数，
     *   长时间运行不丢精度。
     *
     * 【零分配】纯标量算术，仅写 uniform 的 .value。
     */
    let sweep = radarSweepAngleRef.current + RADAR_SWEEP_SPEED * clampedDelta;
    /* 手动 mod 2π（比 % 更快且对负数安全，虽然此处的值恒为正） */
    if (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
    radarSweepAngleRef.current = sweep;
    radarSweepUniforms.uSweepAngle.value = sweep;

    /*
     * 0d) 双层量子点阵：整体浮动 + 呼吸明暗。
     *
     * 【为何整组统一浮动而非逐点】逐点浮动需要每帧重写 216 个实例矩阵，
     * 是这一层唯一的性能敏感点。改为**整体 Y 偏移 + 透明度呼吸**后，
     * 每帧只写 2 个 position.y 与 2 个 material.opacity，
     * 视觉上仍是"整片点阵在起伏呼吸"，成本却降了两个数量级。
     *
     * 【两层相位错开 π/3】若同相浮动，两层会像一块板一起上下；
     * 错相后两层交替起伏，产生"量子泡沫翻涌"的层次感。
     */
    const quantumFloatA = Math.sin(t * QUANTUM_FLOAT_RATE) * QUANTUM_FLOAT_AMPLITUDE;
    const quantumFloatB = Math.sin(t * QUANTUM_FLOAT_RATE + Math.PI / 3) * QUANTUM_FLOAT_AMPLITUDE;
    const layerA = quantumLayerARef.current;
    if (layerA !== null) {
      layerA.position.y = 0.009 + quantumFloatA;
      const matA = layerA.material;
      if (matA instanceof THREE.MeshBasicMaterial) {
        matA.opacity = 0.38 + 0.2 * (0.5 + 0.5 * Math.sin(t * QUANTUM_PULSE_RATE));
      }
    }
    const layerB = quantumLayerBRef.current;
    if (layerB !== null) {
      layerB.position.y = 0.011 + quantumFloatB;
      const matB = layerB.material;
      if (matB instanceof THREE.MeshBasicMaterial) {
        matB.opacity = 0.26 + 0.16 * (0.5 + 0.5 * Math.sin(t * QUANTUM_PULSE_RATE + Math.PI / 2));
      }
    }

    /* 1) 主轨道脉冲流光弧：缓慢绕环扫过 */
    if (orbitPulseRef.current !== null) {
      orbitPulseRef.current.rotation.z = t * ORBIT_PULSE_SPIN_RATE;
    }

    /* 2) 每机架刻度齿：反向自转（与主轨道互为反向 → 视差感） */
    const teeth = teethRefs.current;
    for (let i = 0; i < teeth.length; i++) {
      const group = teeth[i];
      if (group !== null && group !== undefined) {
        group.rotation.y = t * PEDESTAL_TEETH_SPIN_RATE;
      }
    }

    /* 3) 每机架径向总线上的地面流动光脉冲 */
    const pulses = lanePulseRefs.current;
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      if (pulse !== null && pulse !== undefined) {
        /* 相位错开：三个机架的脉冲不同步，避免整体齐步像机械 */
        const cycle = (t * LANE_PULSE_SPEED + i * 0.33) % 1;
        pulse.position.z = RADIAL_START_RADIUS + cycle * RADIAL_LENGTH;
        /* 两端淡入淡出：靠近控制平面与到达机架时不硬切 */
        const fade = Math.sin(cycle * Math.PI);
        const material = pulse.material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.opacity = 0.25 + 0.65 * fade;
        }
      }
    }
  });

  return (
    <group position={[0, FLOOR_Y, 0]}>
      {/*
       * ═══ 第 R 重：60° 全息数字雷达扫描扇区（Digital Radar Sweep）═══
       *
       * 【为何放在最底层（先渲染）】雷达扫描是"地面上的光"，
       * 它应当**叠加在网格与圆环之下**，而不是盖住它们。
       * 用加色混合 + depthWrite:false 后，扫描扇区会像一层
       * 贴地的光幕，透过它仍能看见地面刻度与总线——
       * 这正是真实雷达 PPI 屏上"扫描线扫过网格"的叠层关系。
       *
       * 【为何用 plane 而非环形几何】扇形的角向梯度（前亮后暗）
       * 必须在片元里用极坐标算，环形几何没有连续的角向 uv。
       * 用一个覆盖整个扫描区域的方平面 + 片元内极坐标掩码，
       * 几何成本最低（2 个三角形），且角向渐变完全连续无接缝。
       *
       * 【尺寸】直径 = 2 × RADAR_SECTOR_OUTER，恰好覆盖主能量环内部。
       */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]} raycast={(): void => undefined}>
        <planeGeometry args={[RADAR_SECTOR_OUTER * 2, RADAR_SECTOR_OUTER * 2]} />
        <shaderMaterial
          uniforms={radarSweepUniforms}
          vertexShader={RADAR_SECTOR_VERTEX_SHADER}
          fragmentShader={RADAR_SECTOR_FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/*
       * ═══ 第 C 重：加密罗盘微刻度（128 枚，单 Draw Call）═══
       *
       * 【为何叠在主轨道刻度之内】原有 64 枚刻度在 r = RACK_RADIUS + 0.30
       * （机架圈外侧），本组在其内侧 r = RACK_RADIUS − 0.62 ~ −0.52，
       * 形成"外粗内细"的双层刻度带——这正是真实罗盘/度盘的分层方式：
       * 外圈主刻度标注整十度，内圈细刻度提供 1° 精度。
       *
       * 【几何】用一段极窄的 ringGeometry 弧段（thetaLength 只占整圈的
       * 1/128 × 0.42），实例靠本地 Z 旋转摆到各角度位置。
       * 这样 128 个刻度共用一份几何，仅 1 次 draw call。
       */}
      <instancedMesh
        ref={compassTicksRef}
        args={[undefined, undefined, COMPASS_TICK_COUNT]}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.007, 0]}
        frustumCulled={false}
        raycast={(): void => undefined}
      >
        <ringGeometry
          args={[
            COMPASS_TICK_INNER,
            COMPASS_TICK_OUTER,
            RING_SEGMENTS,
            1,
            0,
            ((Math.PI * 2) / COMPASS_TICK_COUNT) * 0.42,
          ]}
        />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.26}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </instancedMesh>

      {/*
       * ═══ 第 Q 重：双层错位量子点阵（96 + 120 枚，各 1 Draw Call）═══
       *
       * 两层半径不同、数量不同（因此相位自然错开），叠加后打破单层的
       * 周期性，看起来像随机分布的量子泡沫。浮动与呼吸由 useFrame
       * 写入 y 偏移与材质透明度，零逐点矩阵重写（整组统一动）。
       */}
      <instancedMesh
        ref={quantumLayerARef}
        args={[undefined, undefined, QUANTUM_LAYER_A_COUNT]}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.009, 0]}
        frustumCulled={false}
        raycast={(): void => undefined}
      >
        <planeGeometry args={[QUANTUM_DOT_SIZE, QUANTUM_DOT_SIZE]} />
        <meshBasicMaterial
          color="#67e8f9"
          transparent
          opacity={0.5}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </instancedMesh>

      <instancedMesh
        ref={quantumLayerBRef}
        args={[undefined, undefined, QUANTUM_LAYER_B_COUNT]}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.011, 0]}
        frustumCulled={false}
        raycast={(): void => undefined}
      >
        <planeGeometry args={[QUANTUM_DOT_SIZE * 0.78, QUANTUM_DOT_SIZE * 0.78]} />
        <meshBasicMaterial
          color="#a5f3fc"
          transparent
          opacity={0.36}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </instancedMesh>

      {/*
       *
       * 【解决什么】此前 r∈[3.1, 9.5] 之间是一大片空旷死黑：
       * 只有几道细环，中间什么都没有，地面读起来像"黑纸上的几个圈"。
       * 铺满 1,400 颗按轨道成簇分布的数据节点后，整片地面变成
       * 一张发光的数字母板。
       *
       * 【单 Draw Call】全部节点在一个 Points 里，逐点颜色/粒径/相位
       * 由 aColor / aSize / aPhase 三个属性承载，着色器渲染成
       * 「中心锐利亮核 + 外圈柔光」，并随 uTime 传播径向数据波。
       */}
      <points
        geometry={DATA_CITY_GEOMETRY}
        position={[0, 0.004, 0]}
        raycast={(): void => undefined}
      >
        <shaderMaterial
          uniforms={dataCityUniforms}
          vertexShader={DATA_CITY_VERTEX_SHADER}
          fragmentShader={DATA_CITY_FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>

      {/*
       * ═══ 第 0b 重：地面极坐标微电路连线（160 段短弧，单 Draw Call）═══
       *
       * 【设计意图】1,400 颗孤立亮点只是"撒了一把光尘"；
       * 沿环轨画出断续短弧后，它们才连成一张发光的数字母板。
       * 短弧半径与数据星城的轨道同源，视觉上像"点被电路串起来"，
       * 而不是两套互不相关的装饰。
       */}
      <lineSegments geometry={TRACE_GEOMETRY} position={[0, 0.002, 0]} raycast={(): void => undefined}>
        <lineBasicMaterial
          color="#0284c7"
          transparent
          opacity={0.36}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </lineSegments>

      {/*
       * ═══ 第 0c 重：中央 6 级全息雷达底座 ═══
       *
       * 静态批次（羽化底盘 + 双核心环 + 双围栏环 + 24 锚点 + 十字基准激光）
       * 与旋转批次（12 段不对称装甲弧 × 2 道 + 72 道刻度）各占 1 次 Draw Call。
       *
       * 【为何用顶点色三角汤而非多个 ringGeometry】原实现为每道环、
       * 每枚锚点各建一个 mesh，单是底座就吃掉几十次 Draw Call；
       * 合并成一份 position+color 缓冲后，整个 6 级底座只剩 2 次。
       * 加色混合下顶点色趋黑即等于透明，因此径向羽化无需 alpha 通道。
       */}
      <mesh geometry={RADAR_STATIC_GEOMETRY} position={[0, 0.001, 0]} raycast={(): void => undefined}>
        <meshBasicMaterial
          vertexColors
          transparent
          opacity={0.92}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh
        ref={radarArcRef}
        geometry={RADAR_ARC_GEOMETRY}
        position={[0, 0.003, 0]}
        raycast={(): void => undefined}
      >
        <meshBasicMaterial
          vertexColors
          transparent
          opacity={0.85}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/*
       * ═══ 第一重：主发光轨（机架站立的闭合圆环）═══
       * ringGeometry 默认在 XY 平面，绕 X 轴 −90° 后平铺于世界 XZ 平面。
       */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[RACK_RADIUS - ORBIT_THICKNESS, RACK_RADIUS, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_ORBIT}
          transparent
          opacity={0.85}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/*
       * ═══ 第二重：外侧 64 段虚线刻度环 ═══
       * 每段是一次独立 ringGeometry（thetaStart / thetaLength），
       * 64 段 × 3 机架共享同一批几何参数，用 map 展开即可。
       * 视觉上形成"精密仪器刻度盘"的断续节奏，与连续主轨形成对比。
       */}
      {/*
       * ═══ 第二重：外侧 64 段虚线刻度环（单实例网格，1 次 Draw Call）═══
       *
       * 【为何实例化】64 段独立 mesh × 每帧被反射地面二次渲染 = 128 次
       * Draw Call，仅这一组就能把低端 GPU 打垮。实例化后降为 1 次。
       * 几何只建"一段弧"（thetaStart=0），各实例靠本地 Z 旋转摆到扇区位置。
       */}
      <instancedMesh
        ref={orbitTicksRef}
        args={[undefined, undefined, ORBIT_TICK_COUNT]}
        rotation={[-Math.PI / 2, 0, 0]}
        frustumCulled={false}
        raycast={(): void => undefined}
      >
        <ringGeometry
          args={[
            ORBIT_TICK_RADIUS,
            ORBIT_TICK_RADIUS + ORBIT_TICK_THICKNESS,
            RING_SEGMENTS,
            1,
            0,
            ((Math.PI * 2) / ORBIT_TICK_COUNT) * ORBIT_TICK_DUTY,
          ]}
        />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.34}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </instancedMesh>

      {/* ═══ 第三重：内侧双细导轨 ═══ */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[ORBIT_RAIL_INNER, ORBIT_RAIL_INNER + 0.015, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.30}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[ORBIT_RAIL_OUTER, ORBIT_RAIL_OUTER + 0.015, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.22}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/*
       * ═══ 第四重：沿轨道游走的脉冲流光弧 ═══
       * 一段较宽的短弧，由 useFrame 绕环缓慢旋转 → "扫描线在巡检"的隐喻。
       * 单独一个 group 承载旋转，便于只写一个 rotation.z。
       */}
      <group ref={orbitPulseRef} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh raycast={(): void => undefined}>
          <ringGeometry
            args={[
              RACK_RADIUS - ORBIT_PULSE_THICKNESS,
              RACK_RADIUS + ORBIT_PULSE_THICKNESS,
              RING_SEGMENTS,
              1,
              0,
              ORBIT_PULSE_ARC,
            ]}
          />
          <meshBasicMaterial
            color="#a5f3fc"
            transparent
            opacity={0.55}
            side={THREE.DoubleSide}
            toneMapped={false}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>

      {/* ── 控制平面内环：双环呼应 Master 底座的刻度环 ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[INNER_RING_RADIUS - INNER_THICKNESS, INNER_RING_RADIUS, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.55}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[INNER_RING_RADIUS * 0.62, INNER_RING_RADIUS * 0.62 + 0.022, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={COLOR_INNER}
          transparent
          opacity={0.30}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/*
       * ═══ 三线并行径向总线（每机架一道）═══
       *
       * 【几何构造】用 planeGeometry 画细长矩形，中心置于两环之间中点
       * （沿 +Z 平移 (起点+终点)/2），再用 group 绕 Y 旋转该机架极角，
       * 即可让总线精确指向机架。
       *
       * 【三线】主干道宽 0.075 + 两侧护线各 0.022（横向偏移 ±0.105），
       * 从"一根杆子"升级为有保护线束的总线结构。
       *
       * 【流动光脉冲】一条细长发光片，由 useFrame 沿 z 单向循环推进
       * （fract 而非 sin，避免来回折返），并在两端淡入淡出。
       */}
      {racks.map((rack, index): React.ReactElement => {
        const midOffset = (RADIAL_START_RADIUS + RACK_RADIUS) / 2;
        const laneColor = rack.faulted ? COLOR_FAULT : COLOR_INNER;
        return (
          <group key={`radial-${rack.key}`} rotation={[0, rack.angle, 0]}>
            {/* 主干道：中心炽白激光芯线（最亮、最细，从雷达核心环贯通到机架） */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, midOffset]} raycast={(): void => undefined}>
              <planeGeometry args={[RADIAL_WIDTH, RADIAL_LENGTH]} />
              <meshBasicMaterial
                color={rack.faulted ? '#ffe4e6' : '#f0f9ff'}
                transparent
                opacity={rack.faulted ? 0.95 : 0.85}
                side={THREE.DoubleSide}
                toneMapped={false}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>

            {/*
             * 宽幅青辉光带：与芯线同轴、宽 0.17（约 3.8 倍芯线宽）、
             * 低透明度叠在下方，形成"激光束周围一圈柔光"的体积感。
             * 加色混合下它顺带把芯线边缘晕开，无需额外模糊 pass。
             */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, midOffset]} raycast={(): void => undefined}>
              <planeGeometry args={[RADIAL_GUARD_WIDTH, RADIAL_LENGTH]} />
              <meshBasicMaterial
                color={laneColor}
                transparent
                opacity={rack.faulted ? 0.5 : 0.2}
                side={THREE.DoubleSide}
                toneMapped={false}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>

            {/* 沿总线输送的地面光脉冲（useFrame 推进 position.z） */}
            <mesh
              ref={(node): void => {
                lanePulseRefs.current[index] = node;
              }}
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, 0.002, midOffset]}
              raycast={(): void => undefined}
            >
              <planeGeometry args={[LANE_PULSE_WIDTH, LANE_PULSE_LENGTH]} />
              <meshBasicMaterial
                color={rack.faulted ? '#fda4af' : '#a5f3fc'}
                transparent
                opacity={0.6}
                side={THREE.DoubleSide}
                toneMapped={false}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
          </group>
        );
      })}

      {/*
       * ═══ 每机架四层复合数码基座 ═══
       *
       * 图五里最抓眼的细节之一：机架脚下不是一个圆圈，而是多圈层叠的
       * 精密数码阵——断弧括弧、刻度齿、能量底盘、导流短轨各司其职。
       * 下面按"由外向内"四层展开，故障机架整体切换绯红。
       */}
      {racks.map((rack, index): React.ReactElement => {
        const ringColor = rack.faulted ? COLOR_FAULT : COLOR_BASE_HEALTHY;
        const ringOpacity = rack.faulted ? OPACITY_BASE_FAULT : OPACITY_BASE_HEALTHY;
        return (
          <group key={`base-${rack.key}`} position={[rack.x, 0, rack.z]}>
            {/* ── 第 1 层：8 段断开的战术锁定括弧环（半径 2.45）── */}
            {PEDESTAL_BRACKETS.map((arc, arcIndex): React.ReactElement => (
              <mesh
                key={`bracket-${arcIndex}`}
                rotation={[-Math.PI / 2, 0, 0]}
                raycast={(): void => undefined}
              >
                <ringGeometry
                  args={[
                    PEDESTAL_BRACKET_RADIUS - PEDESTAL_BRACKET_THICKNESS,
                    PEDESTAL_BRACKET_RADIUS,
                    RING_SEGMENTS,
                    1,
                    arc.thetaStart,
                    arc.thetaLength,
                  ]}
                />
                <meshBasicMaterial
                  color={ringColor}
                  transparent
                  opacity={ringOpacity * 0.75}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            ))}

            {/* ── 第 2 层：高亮主发光环（半径 2.18）── */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
              <ringGeometry
                args={[
                  PEDESTAL_MAIN_RADIUS - PEDESTAL_MAIN_THICKNESS,
                  PEDESTAL_MAIN_RADIUS,
                  RING_SEGMENTS,
                ]}
              />
              <meshBasicMaterial
                color={ringColor}
                transparent
                opacity={ringOpacity}
                side={THREE.DoubleSide}
                toneMapped={false}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>

            {/* ── 第 2b 层：36 枚径向刻度齿（单实例网格，反向自转）──
                 *
                 * 【实例化理由】36 齿 × 3 机架 = 108 个独立 mesh，
                 * 再被反射地面二次渲染 = 216 次 Draw Call。
                 * 改为每机架 1 个 InstancedMesh（36 实例）后降为 3 次；
                 * 反向自转直接旋转该 mesh 对象，实例矩阵无需每帧重写。
                 */}
            <instancedMesh
              ref={(node): void => {
                teethRefs.current[index] = node;
              }}
              args={[undefined, undefined, PEDESTAL_TEETH_COUNT]}
              frustumCulled={false}
              raycast={(): void => undefined}
            >
              <boxGeometry args={[PEDESTAL_TEETH_WIDTH, 0.004, PEDESTAL_TEETH_LENGTH]} />
              <meshBasicMaterial
                color={ringColor}
                transparent
                opacity={ringOpacity * 0.55}
                toneMapped={false}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </instancedMesh>

            {/* ── 第 3 层：三层递减能量底盘（模拟径向渐变柔光）── */}
            {PEDESTAL_DISK_RADII.map((radius, diskIndex): React.ReactElement => (
              <mesh
                key={`disk-${diskIndex}`}
                rotation={[-Math.PI / 2, 0, 0]}
                raycast={(): void => undefined}
              >
                <ringGeometry args={[radius - PEDESTAL_DISK_WIDTHS[diskIndex], radius, RING_SEGMENTS]} />
                <meshBasicMaterial
                  color={ringColor}
                  transparent
                  opacity={PEDESTAL_DISK_OPACITIES[diskIndex]}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            ))}

            {/* ── 第 4 层：机架前方两侧对称伸出的精密导流短轨 ── */}
            {[-1, 1].map((sideSign): React.ReactElement => (
              <mesh
                key={`guide-rail-${sideSign > 0 ? 'right' : 'left'}`}
                rotation={[-Math.PI / 2, 0, 0]}
                position={[sideSign * GUIDE_RAIL_OFFSET_X, 0, GUIDE_RAIL_OFFSET_Z]}
                raycast={(): void => undefined}
              >
                <planeGeometry args={[GUIDE_RAIL_LENGTH, GUIDE_RAIL_WIDTH]} />
                <meshBasicMaterial
                  color={ringColor}
                  transparent
                  opacity={ringOpacity * 0.6}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            ))}

            {/*
             * ── 故障态第三环 + 外扩辉光环（三环绯红能量波纹）──
             * 仅故障机架挂载：正常态下这两个 mesh 不存在，零 draw call。
             */}
            {rack.faulted ? (
              <group position={[0, 0.002, 0]}>
                <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
                  <ringGeometry args={[1.38, 1.5, RING_SEGMENTS]} />
                  <meshBasicMaterial
                    color={COLOR_FAULT}
                    transparent
                    opacity={0.72}
                    side={THREE.DoubleSide}
                    toneMapped={false}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                  />
                </mesh>
                <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={(): void => undefined}>
                  <ringGeometry args={[1.86, 1.92, RING_SEGMENTS]} />
                  <meshBasicMaterial
                    color={COLOR_FAULT}
                    transparent
                    opacity={0.34}
                    side={THREE.DoubleSide}
                    toneMapped={false}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                  />
                </mesh>
              </group>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}