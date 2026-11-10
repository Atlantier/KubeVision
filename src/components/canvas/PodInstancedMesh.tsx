'use client';

/**
 * KubeVision AI — 高性能 Pod 容器实例渲染器（PodInstancedMesh）
 *
 * 【设计意图】（AGENTS.md 第 3 条 60FPS 红线 + 第 7 条 InstancedMesh 规范）
 * 全集群 Pod（种子 24、容量上限 48）以**单次 Draw Call** 的 InstancedMesh 渲染：
 * 每帧从瞬态引用池 telemetryTransientRef 读取实时状态与 CPU 负载（零 React
 * 订阅、零组件重渲染），经预分配临时对象原地更新实例矩阵与实例色缓冲，
 * 实现 60FPS 下的实时态势驱动（状态色渐变、负载呼吸、故障抖动、过滤缩放）。
 *
 * 【容量契约：固定 48，严禁 pods.length】
 * R3F 对 <instancedMesh args> 的处理是「args 变化 → 销毁并重建整个
 * InstancedMesh」：GPU instanceMatrix/instanceColor 缓冲全毁、材质重编译，
 * 混沌引擎扩缩 Pod 数量时将造成整帧卡顿。故 args 容量恒为 MAX_PODS(48)，
 * 实际绘制数量经 mesh.count 命令式驱动（count ≤ 容量的前缀绘制，
 * 依旧是单次 Draw Call），Pod 增减零重建、零闪烁。
 *
 * 【空间对齐契约：与机架隔板严丝合缝，零穿模】
 * 实例位姿不逐帧重算三角函数，而是模块加载期一次性预计算 48 个槽位的
 * SLOT_POSES 查表（getPodWorldTransform 是纯函数，确定性输出可安全缓存）；
 * Pod 可视盒高 0.38 小于契约盒高 POD_BOX_HEIGHT(0.92)，落座偏移由
 * 「契约盒底面 = 隔板顶面」关系推导：seatOffset = 0.38/2 − 0.92/2 = −0.27，
 * 与 WorkerRack3D 隔板几何（TIER_DIVIDER_OFFSET 推导）共用同一数学事实源。
 *
 * 【useFrame 零分配纪律】
 * tempObject（Object3D）/ tempColor / tempTargetColor（Color）/ 每实例
 * 缩放状态 Float32Array 均在 useMemo 中一次性预分配；循环体内只有
 * 标量运算与 lerp/copy/set 原地突变，无任何 new（AGENTS.md 第 3 条）。
 *
 * 【指针交互契约：instanceId 精确拾取 + 最小重渲染】
 * R3F 对 InstancedMesh 的射线命中携带 e.instanceId（实例下标），据此 O(1)
 * 反查 PodEntity。防抖纪律：onPointerMove 仅在 instanceId 真正变化时
 * setHoveredInstanceId——指针在同一 Pod 上移动（每帧一个 move 事件）
 * 零 setState、零重渲染；悬停标签是**单个** <Html>（非每实例一个），
 * 挂载于场景根，世界坐标由 SLOT_POSES 查表（与实例渲染同源）。
 *
 * 【命中链让位协议】Pod 位于机架装甲腔体内部，任何命中 Pod 的射线必先
 * 穿过更近的装甲面——R3F 按距离升序派发，WorkerRack3D 的 handlers 检测到
 * intersections 中存在 Pod 实例命中时**静默放行**（不 stopPropagation、
 * 不选中、不高亮），本组件的 handlers 随后接管并 stopPropagation，
 * 保证「更具体的目标优先」且永不误选机架。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { shallow } from 'zustand/shallow';

import { cn } from '@/utils/cn';
import { HoloFrame, MiniBar } from '@/components/canvas/HoloHud';
import { useClusterStore } from '@/store/useClusterStore';
import { MAX_PODS, telemetryTransientRef } from '@/store/useTelemetryRef';
import { PALETTE } from '@/constants/palette';
import type { PodStatus } from '@/types/cluster';
import type { PodHoverLabelData, PodStatusBadgeStyle } from '@/types/canvas';
import type { ClusterState, SelectedEntityType, StatusFilter } from '@/types/store';
import { BASE_PAD_CLEARANCE, POD_BOX_HEIGHT, POD_BOX_SIZE, getPodWorldTransform } from '@/utils/spatialLayout';

/* ========================================================================== */
/* 模块级常量与预计算表（加载期一次求值，SSR 安全——纯数学无 window/three 运行时）   */
/* ========================================================================== */

/* 说明：POD_BOX_SIZE 与 POD_SEAT_OFFSET_Y 已上提至 spatialLayout.ts
   作为渲染契约的单一事实源——SelectionBeacon3D 需要同一组尺寸与偏移
   才能把选中框严丝合缝地套在方块上。严禁在此重新定义局部副本。 */

/**
 * 状态色常量（模块级预分配，useFrame 内只读，零 Color 构造）。
 *
 * 【为何比 Tailwind 语义色更亮】这些值最终会作为 instanceColor 与材质
 * 基色相乘，再经晶体着色器的棱边/菲涅尔倍率放大。若直接用 emerald-500
 * (#10b981) 这类 UI 常用值，在纯黑背景 + toneMapped:false 下会显得发闷。
 * 这三个值刻意取得更高饱和与更高亮度，使晶块在暗场里"自发光"，
 * 同时保留红/绿/琥珀的语义可辨识度（色相不变，仅提亮）。
 */
/*
 * L10：3D 状态色统一到 UI 语义色板（palette.ts 单一事实源）。
 *
 * 【为什么不再是"为黑底提亮的变体"】旧实现把 emerald-500 手工提亮成
 * #10b981，UI 的 HUD 却是 emerald-400——同一"健康"在画面里出现两种绿。
 * 现在 3D 与 UI 共用同一 hex；HDR 所需额外亮度由加色输出时的
 * emitterMultiplier 承担，不改色相。
 *
 * 【只读约定】PALETTE 里的 Color 实例只读；需要可变副本时 clone()。
 */
const COLOR_RUNNING = PALETTE.healthy.color; // emerald-400
const COLOR_PENDING = PALETTE.elevated.color; // amber-400
const COLOR_CRASH = PALETTE.critical.color; // rose-500

/* -------------------------------------------------------------------------- */
/* 自愈充能脉冲（点击自愈 → 3D 腔体瞬间点亮的视觉反馈）                              */
/* -------------------------------------------------------------------------- */

/**
 * 自愈高亮色（青白）。
 *
 * 【配色推导】它必须比 COLOR_RUNNING 更"白"、更亮，才能在翠绿底色上产生
 * 「被能量充满」的观感；同时保留绿相（G 通道最高），避免看起来像选中态青色。
 * #a7f3d0 是 emerald-200，正是"翠绿被白光冲淡"的中间色。
 */
const COLOR_HEAL_FLASH = new THREE.Color('#a7f3d0');

/**
 * 充能脉冲时长（毫秒）——与 healEntity 写入 healedPodIds 的时间戳同一时钟域。
 *
 * 【为何是 2500ms】短于用户回看的时间（点击卡片 → 视线移到 3D 视口约 0.8s），
 * 又长于典型 UI 过渡（300ms），让"点亮→回落"成为一段可被看清的过程而非闪一下。
 */
const HEAL_PULSE_DURATION_MS = 2500;

/** 充能脉冲的弹性缩放振幅（±14%，与用户指定的 1 + 0.14·sin 公式一致） */
const HEAL_SCALE_AMPLITUDE = 0.14;

/**
 * 充能时颜色向 COLOR_HEAL_FLASH 混合的峰值强度。
 *
 * 取 0.82 而非 1.0：保留约 18% 的状态色底子，避免瞬间变成纯白丢失语义
 * （观众需要能看出"这是绿色的 Pod 被点亮了"，而不是"变成了一个白方块"）。
 */
const HEAL_COLOR_STRENGTH = 0.82;

/** 故障态发光增强倍率（契约指定：tempColor.multiplyScalar(1.5)，分量可 >1 产生过曝辉光） */
const CRASH_GLOW_BOOST = 1.5;

/** 颜色过渡阻尼率 k（1/秒）：≈0.17s 完成 63% 渐变，状态切换平滑不粘滞 */
const COLOR_LERP_RATE = 6;

/** 过滤缩放过渡阻尼率 k（1/秒）：比颜色更快，过滤操作要有「即时聚焦」手感 */
const FILTER_SCALE_LERP_RATE = 8;

/** 单帧 Δt 钳制上限（秒）：掉帧时限制插值步长，防颜色/缩放跳变 */
const MAX_FRAME_DELTA = 0.1;

/* ========================================================================== */
/* 近大远小光泽对比（Distance-Based Specular Contrast）                          */
/* ========================================================================== */

/**
 * 刀片发光对比度的距离参数。
 *
 * 【设计意图】同一座机架内，靠近相机一侧的刀片应当有更锐利的高光边缘，
 * 远离的一侧则柔和下沉——这是真实镜头下的景深与光衰减共同作用的结果。
 * 没有这层调制时，24 个刀片无论远近都是同一亮度，机柜读起来像一张平面贴图。
 *
 * 【公式】distanceGain = clamp(1.18 − (instanceCamDist − 8) · 0.045, 0.68, 1.22)
 *
 * 参数依据：
 * · 相机到刀片的典型距离在 18~30 单位之间（机架半径 9.5 + 相机偏移），
 *   但**机架内部各刀片之间**的距离差只有 1~3 单位 —— 调制幅度必须
 *   足够敏感才能在同一机架内看出差异，因此斜率取 0.045（比机架的 0.032 更陡）；
 * · 8 是"理想近距"基准（相机贴近机架时刀片约在此距离）；
 * · 下界 0.68 保证最远的刀片仍然可辨（不会被压成黑块）；
 * · 上界 1.22 防止贴脸时高光过曝。
 */
const POD_DEPTH_BASE = 1.18;
const POD_DEPTH_PIVOT = 8;
const POD_DEPTH_SLOPE = 0.045;
const POD_DEPTH_MIN = 0.68;
const POD_DEPTH_MAX = 1.22;

/**
 * 故障态呼吸频闪的频率与幅度。
 *
 * 【为何故障态需要"呼吸频闪"而非固定亮度】CrashLoopBackOff / OOMKilled
 * 是**持续性**故障——如果只是变红不动，用户看久了会失去警觉。
 * 加一层低频呼吸（1.6 rad/s ≈ 3.9 秒一个周期）配合较深的幅度
 * （0.55~1.35），既保持"它一直在出问题"的持续感，
 * 又用明暗变化抓住余光。
 *
 * 【为何频率不能太高】超过 4 rad/s 在 60FPS 下会接近闪烁融合阈值，
 * 观感变成"屏幕坏了"而不是"容器在崩溃重启"，反而降低专业感。
 */
const FAULT_BREATH_RATE = 1.6;
const FAULT_BREATH_MIN = 0.55;
const FAULT_BREATH_GAIN = 0.8;

/* ---- Running 态：负载驱动的悬浮呼吸参数 ---- */
/** 悬浮振幅基线（世界单位）+ 负载增量系数：cpu 0%→2%、100%→6% */
const RUN_HOVER_BASE = 0.012;
const RUN_HOVER_LOAD_GAIN = 0.024;
/** 悬浮角频率基线（rad/s）+ 负载增量：忙容器呼吸更急促 */
const RUN_HOVER_RATE_BASE = 1.6;
const RUN_HOVER_RATE_GAIN = 0.8;
/** 高度随负载的静态增量：负载每 100% 增高 10% */
const RUN_HEIGHT_LOAD_GAIN = 0.1;

/**
 * CPU 负载平滑的指数阻尼率 k（1/秒），时间常数 ≈ 0.29 秒。
 *
 * 【取值依据】SSE 快照 1Hz；k = 3.5 使阶跃在约 3 帧（50ms 帧率下）内
 * 消化到 16% 以内，肉眼看到的是"负载平滑上浮/回落"，
 * 而不是"每秒跳一格"。k 过大则失去平滑意义，过小则响应迟钝。
 */
const CPU_SMOOTH_RATE = 3.5;

/**
 * 刀片底座托架安全间隙由 spatialLayout 统一导出（BASE_PAD_CLEARANCE），
 * 使渲染器、布局数学与 SelectionBeacon3D 的落座偏移共享同一数值。
 */

/** 2π 常量（相位取模，避免每次求值 Math.PI * 2） */
const TWO_PI = Math.PI * 2;

/**
 * 静态落座偏移：层中心 → 刀片静止时的盒中心（scaleY = 1）。
 *
 * 推导：−POD_BOX_HEIGHT/2（层中心 → 隔板顶面）
 *      + BASE_PAD_CLEARANCE（安全间隙）
 *      + POD_BOX_SIZE[1]/2（半高）
 *      = −0.46 + 0.026 + 0.26 = −0.174
 *
 * 供"挂载首帧矩阵"与"悬停标签高度"复用，保证与 useFrame 内的底面锚定
 * 公式（scaleY = 1、hoverLift = 0 时）完全一致。
 */
const POD_REST_OFFSET_Y = -POD_BOX_HEIGHT / 2 + BASE_PAD_CLEARANCE + POD_BOX_SIZE[1] / 2;

/* ---- Pending/Terminating 态：缓慢明暗脉动参数 ---- */
/** 明暗脉动角频率（rad/s，≈2.6 秒/次「缓慢」）与幅度（0.72~1.0 亮度包络） */
const PENDING_PULSE_RATE = 2.4;
const PENDING_PULSE_MIN = 0.72;

/* ---- Crash/OOM 态：高频抖动 + 尺寸脉冲参数 ---- */

/**
 * 水平抖动振幅（世界单位）与角频率（rad/s）。
 *
 * 【振幅硬约束：≤ 0.025】
 * 抖动沿**机架局部 X 轴**发生，因此与同层邻位刀片的净间距为：
 *   COL_SPACING − 盒宽·scaleX − 抖动振幅
 *   = 0.92 − 0.74×1.15 − 0.025 ≈ 0.094 > 0
 * 取 0.025 是在"看得出在颤抖"与"绝不撞到邻位"之间留足余量的上限值：
 * 旧值 0.04 在脉冲峰值时会吃掉大半间距。
 */
const CRASH_JITTER_AMPLITUDE = 0.025;

const CRASH_JITTER_RATE = 35;

/**
 * 尺寸脉冲振幅与角频率（±15%，≈0.45 秒/次）。
 *
 * 【为何从 ±25% 降到 ±15%】脉冲同时作用于 scaleX，
 * 而相邻刀片中心距 = COL_SPACING = 0.92、盒宽 0.74：
 *   ±25% → 0.74×1.25 = 0.925 > 0.92  ← **邻位刀片直接互相插入**
 *   ±15% → 0.74×1.15 = 0.851 < 0.92  ← 净间距剩余 0.069，安全
 * 15% 仍能表达"剧烈"（抖动 + 高亮 + 红色已承担主要告警语义），
 * 但不会再与邻位相撞。
 */
const CRASH_PULSE_AMPLITUDE = 0.15;

const CRASH_PULSE_RATE = 14;

/**
 * 过滤不匹配实例的目标缩放 —— **仅在场景中确有匹配项时使用**。
 *
 * 【旧值 0.15 为何是缺陷】早期无论有无匹配都一刀切缩到 0.15。
 * 稳态下用户点「调度中」（匹配 0 个），24 个正常容器全部被缩成小碎点，
 * 机架瞬间空荡——用户既没得到"当前无此状态容器"的信息，
 * 还以为是自己误触了某种"清空"操作。这是本轮要修的核心 bug。
 */
const FILTER_DIM_SCALE = 0.22;

/** 匹配实例的高亮放大倍数（让被筛中的容器在机架里明确"跳出来"） */
const FILTER_MATCH_SCALE = 1.12;

/**
 * **零匹配**时的"幽灵巡检尺寸" —— 全部实例保持 1.0（体积完全不缩水）。
 *
 * 【为何不做成 0】0 匹配不代表"这个维度不存在"，而是"当前没有容器处于该状态"。
 * 保持 1.0 的原始体积、仅靠颜色向冷灰蓝收敛表达"幽灵态"，机架依旧是完整的三个机柜，
 * 用户一眼能看出"容器都在，只是当前筛选无命中"，而不是"容器消失了"。
 */
const FILTER_NO_MATCH_SCALE = 1.0;

/** 零匹配时颜色向冷灰蓝收敛的目标色（表达"当前过滤条件下无匹配"） */
const COLOR_FILTER_GHOST = new THREE.Color('#334155');

/** 零匹配时向冷灰蓝收敛的比例（50%：既明显改变色调，又保留状态色的余韵） */
const FILTER_GHOST_COLOR_MIX = 0.5;

/* ---- 过滤切换扫描波（Scanline Wave）---- */

/**
 * 扫描波总时长（毫秒）。
 *
 * 【解决什么】稳态下「全部 24」与「运行中 24」的 3D 画面**完全一致**
 * （都是 24 个绿色容器），用户切换时看不出任何变化 → 以为按钮失效。
 * 扫描波给每次切换一个**明确的时间性反馈**：650ms 内所有匹配实例
 * 自下而上依次跃升 +12% 并泛青翠光泽，点一次就看得见一次。
 */
const FILTER_WAVE_DURATION_MS = 650;

/** 扫描波的高度跃升幅度（+12%，只作用于 Y 轴：表现为"起跳"而非整体变大） */
const FILTER_WAVE_SCALE_AMPLITUDE = 0.12;

/** 扫描波的颜色叠加基色（青翠：#6ee7b7，与自愈脉冲的白青形成区分） */
const COLOR_FILTER_WAVE = new THREE.Color('#6ee7b7');

/** 扫描波颜色叠加强度（峰值时约 60% 混入，足够醒目但不淹没状态色） */
const FILTER_WAVE_COLOR_STRENGTH = 0.6;

/** 扫描波的层间错峰强度：底部实例先响应，顶部实例延后（0.5 = 半个波形） */
const FILTER_WAVE_TIER_SKEW = 0.5;

/**
 * 悬停标签相对槽位中心的抬升量（世界单位）。
 *
 * 【取值依据】Pod 盒顶 ≈ slotY − 0.08（落座偏移 −0.27 + 半高 0.19），
 * 上一层隔板底面 ≈ slotY + 0.535（TIER 间距 1.05 − 偏移 0.4875 − 半厚）；
 * 取 +0.34 使标签悬于 Pod 正上方、隔板之下的层间空档，视线不穿模。
 */
const HOVER_LABEL_OFFSET_Y = 0.34;

/**
 * Pod 状态 → 悬停标签徽标样式映射（深空赛博状态色体系，AGENTS.md 第 5 条）。
 * crash 双态附加 animate-glow-pulse 脉冲类，与 3D 侧的高频抖动语义呼应。
 */
const POD_STATUS_BADGE: Readonly<Record<PodStatus, PodStatusBadgeStyle>> = {
  Running: { label: 'Running', color: '#34d399' },
  Pending: { label: 'Pending', color: '#fbbf24' },
  Terminating: { label: 'Terminating', color: '#fbbf24' },
  CrashLoopBackOff: { label: 'CrashLoopBackOff', color: '#f43f5e', extraClass: 'animate-glow-pulse' },
  OOMKilled: { label: 'OOMKilled', color: '#f43f5e', extraClass: 'animate-glow-pulse' },
};

/** 每机架槽位数（与 spatialLayout 的 SLOTS_PER_RACK 契约一致） */
const SLOTS_PER_RACK = 16;

/** 机架数（三机架环形拓扑） */
const RACK_COUNT = 3;

/**
 * 槽位位姿预计算表（48 项：rack × 16 slot，行主序 index = rack*16 + slot）。
 *
 * 【缓存合法性】getPodWorldTransform 是无状态纯函数（无时间/随机/window 依赖），
 * 同一 (rackIndex, slotIndex) 输入恒得同一输出，故模块加载期一次求值永久有效；
 * useFrame 内查表 O(1)，替代逐帧 48×(sin/cos/hypot) 重算与数组分配（零 GC 压力）。
 */
interface PodSlotPose {
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  /**
   * 层位归一化高度：0 = 机架最低层，1 = 最高层。
   * 扫描波据此做"自下而上"的错峰延时（底部先亮、顶部后亮）。
   */
  readonly tierNorm: number;
}

const SLOT_POSES: readonly PodSlotPose[] = (() => {
  const raw: Array<{ position: readonly [number, number, number]; rotationY: number }> = [];
  for (let rack = 0; rack < RACK_COUNT; rack++) {
    for (let slot = 0; slot < SLOTS_PER_RACK; slot++) {
      const transform = getPodWorldTransform(rack, slot);
      raw.push({ position: transform.position, rotationY: transform.rotationY });
    }
  }
  /* 一次求极值后归一化，供扫描波做层间错峰（模块级求值，运行时零开销） */
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const item of raw) {
    if (item.position[1] < minY) minY = item.position[1];
    if (item.position[1] > maxY) maxY = item.position[1];
  }
  const span = maxY - minY > 0 ? maxY - minY : 1;
  return raw.map((item): PodSlotPose => ({
    position: item.position,
    rotationY: item.rotationY,
    tierNorm: (item.position[1] - minY) / span,
  }));
})();

/**
 * 每实例动画相位表（黄金角序列 i·2.39996 mod 2π，确定性「伪随机」错相）。
 *
 * 【为何不用 Math.random】随机相位会破坏 SSR/CSR 与水合确定性契约，且同一
 * Pod 在刷新前后动画相位跳变；黄金角序列均匀铺开相位（相邻实例差 ≈137.5°），
 * 呼吸/抖动/脉动彼此错开无机械同步感，同时完全可复现（E2E 可断言）。
 */
const POD_PHASES: readonly number[] = (() => {
  const phases: number[] = [];
  for (let i = 0; i < MAX_PODS; i++) {
    phases.push((i * 2.399963229728653) % (Math.PI * 2));
  }
  return phases;
})();

/* ========================================================================== */
/* 晶体材质着色器注入（零新增依赖实现"霓虹晶块"观感）                                */
/* ========================================================================== */

/**
 * injectCrystalShader —— 为 meshStandardMaterial 注入三段视觉增强。
 *
 * 【设计意图】不引入 @react-three/postprocessing（AGENTS.md 第 9 条锁定依赖
 * 世代矩阵，装它易触发 three/R3F 版本冲突）。图二那种"半透明果冻内芯 +
 * 高亮棱边 + 边缘辉光"的质感，可在单次 Draw Call 内用片段着色器实现，
 * 且 48 个实例共享同一材质，性能代价为零。
 *
 * 【核心数学：三段叠加，全部输出到 emissive 通道】
 * 1. **棱边掩码（edgeMask）**：boxGeometry 每个面 UV ∈ [0,1]²，取
 *    `min(u, 1-u, v, 1-v)` 得到"距最近边的距离"，再用 smoothstep 反相——
 *    靠近棱边时趋近 1。乘面法线的"非主视面"权重可让正对相机的面更强。
 * 2. **菲涅尔边缘光（fresnel）**：`pow(1 - dot(N, V), power)`。
 *    视线越掠射（dot 越小）越亮，形成经典的边缘发光，勾勒立体轮廓。
 * 3. **内芯自发光（coreGlow）**：以面中心为圆心的径向衰减，
 *    模拟晶体内部能量从中心透出的感觉。
 *
 * 三者以不同权重叠加到 `totalEmissiveRadiance`——这是 Standard 材质在
 * 光照计算后、色调映射前的最终自发光项，因此不受场景灯光强弱影响，
 * 在纯黑背景下依然稳定发光。
 *
 * 【为何用 onBeforeCompile 而非 ShaderMaterial】改 ShaderMaterial 需从零
 * 重写 PBR 光照（含 InstancedMesh 的 instanceColor 与矩阵变换），
 * 而 onBeforeCompile 只做定点字符串替换，保留原生 PBR 管线与实例化支持。
 *
 * 【注入点的安全性】必须替换 `#include <emissivemap_fragment>` 且
 * **在替换串中原样保留该 include**——若漏掉，emissive 贴图通道会失效；
 * 同时不能误加 `#include <dithering_fragment>`（蓝图示例中重复了该行，
 * 会导致 GLSL 编译期重复定义）。此处只动一处 include，最小侵入。
 *
 * @param shader three 传入的可变 shader 对象（含 vertexShader/fragmentShader）
 */
function injectCrystalShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  /* ---- 顶点着色器：把面 UV、视图空间法线与几何局部坐标传给片元 ---- */
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
       varying vec2 vCrystalUv;
       varying vec3 vViewNormal;
       /* 几何局部坐标（未经实例矩阵变换）：用于纵向能量渐变。
          InstancedMesh 中 position 是盒体本地坐标，y ∈ [-0.28, 0.28]，
          不随机架自转改变，保证整排刀片的渐变方向一致。 */
       varying vec3 vLocalPos;
       /* 几何局部法线：片元据此判定本像素属于哪个面（顶/侧/前后），
          这是"六面差异化着色"的唯一依据。 */
       varying vec3 vLocalNormal;`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vCrystalUv = uv;
       vViewNormal = normalize(normalMatrix * normal);
       vLocalPos = position;
       vLocalNormal = normal;`,
    );

  /* ---- 片元着色器：六面差异化工业结构 ----
   *
   * 【本轮重构动机】旧实现把「霓虹棱边 + 绿色内芯」平铺到全部 6 个面，
   * 于是盒子看起来像廉价的"六面同图积木"——真实刀片服务器的顶面是
   * 暗钛拉丝机箱盖、侧面前后是带 3 排子刀片槽与 LED 阵的发光面板，
   * 两者在**明度、纹理、发光逻辑**上完全不同。
   *
   * 【实现方式】用局部法线判定面朝向：
   *   abs(n.y) > 0.5 → 顶/底面（暗钛金属）
   *   其余（|n.z| / |n.x|）→ 面板与侧面（精密发光刀片）
   * 两条分支的 diffuse 压暗系数、纹理频率、发光结构全部独立。
   */
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
       varying vec2 vCrystalUv;
       varying vec3 vViewNormal;
       varying vec3 vLocalPos;
       varying vec3 vLocalNormal;`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       {
         /* ---- 面朝向判定 ---- */
         vec3 nLocal = normalize(vLocalNormal);
         float isCap = step(0.5, abs(nLocal.y));

         /* 到最近面边缘的归一化距离（0 = 边上，0.5 = 面心） */
         float edgeDist = min(min(vCrystalUv.x, 1.0 - vCrystalUv.x),
                              min(vCrystalUv.y, 1.0 - vCrystalUv.y));

         /*
          * ---- 状态色基准 ----
          * stateColor 是「白基色 × 实例色」后的原始状态色（漫反射 albedo）。
          * 注意：这一步还没被压暗，后续所有"亮度"都从它派生。
          */
         vec3 stateColor = diffuseColor.rgb;

         /* 高亮档：状态色 × 1.35，只给棱线/灯槽/LED 用，绝不铺满整面 */
         vec3 brightState = stateColor * 1.35;
         /* 机身装甲底色：状态色 × 0.28 —— 深翡冷翠 / 玄武灰 */
         vec3 armorBase = stateColor * 0.28;

         /* ============ 分支 A：顶 / 底面（暗钛金属机箱盖，几乎不发光）============ */
         float capEdge = 1.0 - smoothstep(0.0, 0.016, edgeDist);
         float brush   = 0.5 + 0.5 * sin(vCrystalUv.x * 240.0);
         vec3 capGlow = stateColor * capEdge * 0.55;

         /* ============ 分支 B：前后面板 / 侧面（精密刀片）============ */

         /* 1) 三道水平硬盘抽屉分舱凹槽：位于每个分舱的上下边界 */
         float bayLocal = fract(vCrystalUv.y * 3.0);
         float groove = smoothstep(0.0, 0.045, bayLocal) *
                        (1.0 - smoothstep(0.955, 1.0, bayLocal));
         /* groove = 0 处是凹槽（极暗），= 1 处是分舱主体 */

         /* 2) 三条水平发光导光槽：每个分舱中心一道细亮线 */
         float slotDist = abs(bayLocal - 0.5);
         float lightSlot = 1.0 - smoothstep(0.055, 0.085, slotDist);

         /* 3) 正面边框倒角细线：仅最外 3% 面宽 */
         float chamfer = 1.0 - smoothstep(0.0, 0.030, edgeDist);

         /* 4) 右侧 4 颗针尖级 LED：仅 u > 0.86 的窄带，且纵向 4 段等分 */
         float ledBand = smoothstep(0.86, 0.88, vCrystalUv.x) *
                         (1.0 - smoothstep(0.96, 0.98, vCrystalUv.x));
         float ledCell = floor(vCrystalUv.y * 4.0);
         float ledLocal = fract(vCrystalUv.y * 4.0);
         float ledDot = smoothstep(0.30, 0.40, ledLocal) *
                        (1.0 - smoothstep(0.60, 0.70, ledLocal));
         /* 四颗 LED 用不同亮度，像真实的链路指示灯阵列 */
         float ledTier = 0.65 + 0.35 * fract(ledCell * 0.618 + 0.21);
         float ledMask = ledBand * ledDot * ledTier;

         /*
          * ---- 组装自发光 ----
          * 只有三类东西发光：棱线、导光槽、LED。
          * 机身与分舱主体一律不发光——这正是"告别泛白浅绿"的关键：
          * 旧版把 0.40 + 0.28·grille 的内芯也加进 emissive，
          * 整块刀片因此被 Bloom 抬成一团浅绿。
          */
         vec3 panelGlow = brightState * chamfer * 0.95
                        + brightState * lightSlot * groove * 0.85
                        + vec3(1.0, 1.0, 0.96) * ledMask * 1.6;

         /* ============ 合成 ============ */
         vec3 faceGlow = mix(panelGlow, capGlow, isCap);

         /*
          * 压暗固有漫反射：
          *   面板 → 装甲底色（stateColor × 0.28），凹槽处再乘 0.35 做出真正的阴影感
          *   顶面 → 更暗的玄武灰
          */
         vec3 panelArmor = armorBase * mix(0.35, 1.0, groove);
         diffuseColor.rgb = mix(panelArmor, vec3(0.045, 0.055, 0.065) * (0.7 + 0.3 * brush), isCap);

         vec3 viewDir = normalize(-vViewPosition);
         float fresnel = pow(max(1.0 - clamp(dot(normalize(vViewNormal), viewDir), 0.0, 1.0), 1.0e-4), 2.8);

         totalEmissiveRadiance += faceGlow + diffuseColor.rgb * fresnel * 0.22;
       }`,
    );
}

/**
 * resolvePodTargetColor —— 状态 → 基础目标色映射（纯函数，返回模块级只读常量）。
 *
 * 【穷举保证】switch 覆盖 PodStatus 全部五态，TS 编译期强制新增状态必须补分支；
 * 明暗脉动/发光增强等时变调制在 useFrame 内以 multiplyScalar 叠加，
 * 本函数只负责「离散选色」，职责单一。
 */
function resolvePodTargetColor(status: PodStatus): THREE.Color {
  switch (status) {
    case 'Running':
      return COLOR_RUNNING;
    case 'Pending':
    case 'Terminating':
      return COLOR_PENDING;
    case 'CrashLoopBackOff':
    case 'OOMKilled':
      return COLOR_CRASH;
  }
}

/* ========================================================================== */
/* PodInstancedMesh 主体                                                       */
/* ========================================================================== */

/**
 * PodInstancedMesh —— 全集群 Pod 单 Draw Call 实例化渲染器。
 *
 * 【数据流】telemetryTransientRef（轨道一瞬态池）→ useFrame 逐帧读取
 * snapshot.pods[i].status（离散态）与 podCpuFloat32[i]（连续负载，
 * 1Hz 快照同步 + 本组件插值调制）→ 实例矩阵/实例色原地突变。
 * statusFilter 是唯一的响应轨输入：细粒度 selector 订阅（低频重渲染）
 * + ref 镜像喂给 useFrame，渲染循环内零 zustand 访问（.cursorrules 双轨纪律）。
 */
export default function PodInstancedMesh() {
  /* ---- 响应轨细粒度订阅（仅过滤器一个字段）+ ref 镜像 ---- */
  const statusFilter = useClusterStore((s): StatusFilter => s.statusFilter);
  const statusFilterRef = useRef<StatusFilter>(statusFilter);

  /**
   * 过滤切换时刻（performance.now 毫秒时间戳），驱动扫描波。
   *
   * 【为何用 performance.now 而非 Date.now】扫描波是纯渲染期动画，
   * 必须与 `state.clock`（同为 performance 时间域）一致；
   * 用 Date.now 会跨越到墙钟域，与 useFrame 的 clock 存在相位漂移。
   */
  const filterSwitchTimeRef = useRef<number>(Number.NEGATIVE_INFINITY);

  /** 首次挂载不算"用户切换"，避免页面加载时误触发一次全场景扫描波 */
  const filterWaveArmedRef = useRef<boolean>(false);

  useEffect(() => {
    statusFilterRef.current = statusFilter;
    /* 首个 effect 只做镜像，不触发扫描波 */
    if (!filterWaveArmedRef.current) {
      filterWaveArmedRef.current = true;
      return;
    }
    filterSwitchTimeRef.current = performance.now();
  }, [statusFilter]);

  /* ---- 选中动作（点击 Pod → 相机特写聚焦的唯一写入口） ---- */
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );

  /**
   * 悬停实例下标（null = 无悬停）。
   *
   * 【防抖契约】onPointerMove 在指针停留于同一 Pod 期间会以指针事件频率
   * （≈60Hz）连续触发，但 handler 内先比对 e.instanceId !== hoveredInstanceId
   * 才 setState——同一 Pod 上的移动零 setState、零重渲染，只有跨 Pod 边界
   * 的瞬间产生一次状态迁移。这是「精准且不掉帧」的核心手段。
   */
  const [hoveredInstanceId, setHoveredInstanceId] = useState<number | null>(null);

  /**
   * 悬停标签视图模型（低频派生：仅 hoveredInstanceId 或 1Hz 快照变更时重算）。
   *
   * 【数据源选择】刻意取响应轨 snapshotSummary 而非瞬态池：瞬态池的 mutation
   * 不触发 React 更新，标签若从瞬态池取值将永远停留在挂载时的读数；
   * 响应轨快照以 1Hz 整体替换，恰好为标签提供「实时 CPU/MEM%」的刷新节拍，
   * 且与 3D 实例渲染（瞬态池 60FPS）在视觉上同源同值。
   * shallow 比较器保证字段全等时复用旧对象引用，避免无谓重渲染。
   */
  const hoverLabelData = useClusterStore(
    (s: ClusterState): PodHoverLabelData | null => {
      if (hoveredInstanceId === null) return null;
      const pod = s.snapshotSummary.pods[hoveredInstanceId];
      if (pod === undefined) return null;
      return {
        name: pod.name,
        status: pod.status,
        cpuUsage: pod.cpuUsage,
        memoryUsage: pod.memoryUsage,
        rackIndex: pod.rackIndex,
        slotIndex: pod.slotIndex,
      };
    },
    shallow,
  );

  /**
   * 悬停标签的世界坐标（SLOT_POSES 查表，与实例渲染位姿严格同源）。
   * 取槽位中心 + 落座偏移 + 标签抬升量，使标签恒悬于 Pod 正上方的层间空档。
   * useMemo 依赖 label 数据，仅跨 Pod 移动或快照刷新时重算。
   */
  const hoverLabelPosition = useMemo((): [number, number, number] | null => {
    if (hoverLabelData === null) return null;
    const rackIdx = ((hoverLabelData.rackIndex % RACK_COUNT) + RACK_COUNT) % RACK_COUNT;
    const slotIdx =
      ((Math.floor(hoverLabelData.slotIndex) % SLOTS_PER_RACK) + SLOTS_PER_RACK) % SLOTS_PER_RACK;
    const pose = SLOT_POSES[rackIdx * SLOTS_PER_RACK + slotIdx];
    return [
      pose.position[0],
      pose.position[1] + POD_REST_OFFSET_Y + HOVER_LABEL_OFFSET_Y,
      pose.position[2],
    ];
  }, [hoverLabelData]);

  /* 悬停光标：Canvas 覆盖全视口，body 样式是唯一可靠通道（与机架模型同一手法） */
  useEffect(() => {
    if (hoveredInstanceId === null) return undefined;
    const previous = document.body.style.cursor;
    document.body.style.cursor = 'pointer';
    return (): void => {
      document.body.style.cursor = previous;
    };
  }, [hoveredInstanceId]);

  /**
   * handlePointerMove —— 悬停实例追踪（instanceId 变化才 setState）。
   *
   * 【instanceId 语义】R3F 对 InstancedMesh 的射线命中回填 e.instanceId
   * 为实例下标（0-based），直接对应 snapshot.pods[i]，无需 id 查表遍历。
   * 防御性校验：instanceId 越界（undefined 或 ≥ count，例如 count 收窄后
   * 的残留命中）时按「无悬停」处理，避免标签读取到占位实例。
   */
  const handlePointerMove = useCallback((event: ThreeEvent<PointerEvent>): void => {
    const instanceId = event.instanceId;
    const count = telemetryTransientRef.snapshot.pods.length;
    if (instanceId === undefined || instanceId < 0 || instanceId >= count) {
      return;
    }
    setHoveredInstanceId((previous): number | null =>
      previous === instanceId ? previous : instanceId,
    );
  }, []);

  /** handlePointerOut —— 离开实例群即清除悬停（标签与光标同步撤除） */
  const handlePointerOut = useCallback((): void => {
    setHoveredInstanceId((previous): number | null => (previous === null ? previous : null));
  }, []);

  /**
   * handleClick —— 点击 Pod 触发相机特写聚焦。
   *
   * stopPropagation 阻断命中链继续传播（装甲内壁、地面 Grid 等更远的命中
   * 对象不再收到事件），防止一次点击既选中 Pod 又误触发 onPointerMissed
   * 取消选中。选中后 CameraRig 以 getPodWorldTransform().cameraPosition
   * 飞行至该 Pod 的特写机位（与本渲染器同一空间事实源）。
   */
  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>): void => {
      const instanceId = event.instanceId;
      const pods = telemetryTransientRef.snapshot.pods;
      if (instanceId === undefined || instanceId < 0 || instanceId >= pods.length) {
        return;
      }
      event.stopPropagation();
      selectEntity(pods[instanceId].id, 'pod');
    },
    [selectEntity],
  );

  /* ---- 渲染对象与动画通道 ref ---- */
  const meshRef = useRef<THREE.InstancedMesh>(null);

  /**
   * 预分配临时对象（AGENTS.md 第 3 条：useFrame 内禁止 new THREE.*）。
   * useMemo 空依赖 → 组件生命周期内仅分配一次，每帧原地复用：
   * - tempObject：矩阵复合载体（position/rotation/scale → updateMatrix）
   * - tempColor：实例当前色（getColorAt 接收器 + lerp 原地渐变 + setColorAt 回写）
   * - tempTargetColor：本帧目标色（基础色 copy + 时变调制 multiplyScalar）
   */
  const tempObject = useMemo((): THREE.Object3D => new THREE.Object3D(), []);
  const tempColor = useMemo((): THREE.Color => new THREE.Color(), []);
  const tempTargetColor = useMemo((): THREE.Color => new THREE.Color(), []);

  /**
   * 每实例过滤缩放状态缓冲（Float32Array(48)，初始 1）。
   * 缩放是跨帧连续量（lerp 平滑），必须以持久缓冲保存「当前值」，
   * 与颜色的持久化思路一致（instanceColor 缓冲即颜色当前值）。
   * 命名不带 Ref 后缀：它是 useMemo 分配的裸 TypedArray（非 useRef 容器），
   * 直接下标读写，避免 .current 误用。
   */
  const filterScaleBuffer = useMemo((): Float32Array => new Float32Array(MAX_PODS).fill(1), []);

  /**
   * smoothedCpuBuffer —— 逐实例 CPU 负载的**帧率无关指数阻尼**平滑值。
   *
   * 【根治"每秒瞬移"】SSE 快照 1Hz 到达，`cpuArray[i]` 是阶跃量。
   * 旧实现把 c 直接乘进相位 `t·(1.6 + 0.8·c)`：当 t 已经很大（例如 60s）时，
   * c 跳变 0.1 会让相位瞬间变化 0.1 × 0.8 × 60 ≈ 4.8 弧度——
   * 盒子一秒钟"抽搐"一次，正是这个乘法放大了数据阶跃。
   *
   * 现在 c 先经过阻尼平滑（k = 3.5/s，≈0.29s 时间常数），
   * 平滑值再参与**角速度**（而不是直接乘时间 t），见 phaseAccumBuffer。
   */
  const smoothedCpuBuffer = useMemo((): Float32Array => new Float32Array(MAX_PODS), []);

  /**
   * phaseAccumBuffer —— 逐实例呼吸相位累计值（弧度）。
   *
   * 【核心数学：对角速度积分，而不是对绝对时间求值】
   *   ω_i(t) = RUN_HOVER_RATE_BASE + RUN_HOVER_RATE_GAIN · smoothC_i
   *   φ_i(t) = (φ_i(t−dt) + ω_i · dt) mod 2π
   *
   * 【为什么这能根治瞬移】`t·ω(c)` 是"用当前 ω 重算整段时间"，
   * c 一变，整段历史相位被重算 → 跳变。而 `φ += ω·dt` 只把**当前这一帧**
   * 的角增量累加进去：c 变化只影响此后的角速度，历史相位不受影响，
   * 因此相位永远连续，切换数据帧时零跳变。
   *
   * 初值取自 POD_PHASES（黄金角错相），保证首帧各实例相位均匀铺开。
   */
  const phaseAccumBuffer = useMemo((): Float32Array => {
    const buffer = new Float32Array(MAX_PODS);
    for (let i = 0; i < MAX_PODS; i++) buffer[i] = POD_PHASES[i];
    return buffer;
  }, []);

  /**
   * 挂载初始化：写入全部 48 个实例的矩阵（槽位查表 + 落座偏移）与白色实例色。
   *
   * 【核心目的】setColorAt 触发 three 底层惰性创建 instanceColor
   * InstancedBufferAttribute（48×3 float 缓冲）——没有它，后续 getColorAt/
   * setColorAt 与 instanceColor.needsUpdate 全部失效（AGENTS.md 第 7 条：
   * 动态着色前必须确保 instanceColor 缓冲存在）。矩阵按 SLOT_POSES 占位，
   * 首帧 useFrame 即按真实 Pod 数据覆写；mesh.count 同步收窄到实际 Pod 数，
   * 占位实例永不进入绘制。
   */
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;

    tempColor.set('#ffffff');
    for (let i = 0; i < MAX_PODS; i++) {
      const pose = SLOT_POSES[i];
      tempObject.position.set(
        pose.position[0],
        pose.position[1] + POD_REST_OFFSET_Y,
        pose.position[2],
      );
      tempObject.rotation.set(0, pose.rotationY, 0);
      tempObject.scale.setScalar(1);
      tempObject.updateMatrix();
      mesh.setMatrixAt(i, tempObject.matrix);
      mesh.setColorAt(i, tempColor);
    }
    mesh.count = Math.min(telemetryTransientRef.snapshot.pods.length, MAX_PODS);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [tempColor, tempObject]);

  /**
   * useFrame —— 实时态势驱动渲染循环（零分配 / 零 setState / 零 zustand 访问）。
   *
   * 【核心数学与状态流转】（AGENTS.md 第 8 条中文原理注释契约）
   * 对每个在绘实例 i（0 ≤ i < mesh.count）：
   *
   * 1. 位姿查表：rackIdx/slotIdx 归约（模 3 / 模 16，与 getPodWorldTransform
   *    的容错归约同构）→ SLOT_POSES[rack*16+slot] 取世界坐标与朝向；
   *    y 叠加落座偏移 −0.27 使盒底精确落在隔板顶面（零穿模）。
   *
   * 2. 状态调制（离散分支 → 连续参数）：
   *    - Running：负载归一化 c = cpu/100；
   *      悬浮 Δy = (0.02 + 0.04c)·sin(t·(1.6 + 0.8c) + φ_i)（忙容器呼吸更急更高）；
   *      高度 s_y = 1 + 0.10c + 0.02·sin(2t + φ_i)（负载越高容器「越鼓」）；
   *    - Pending/Terminating：几何静止，颜色做缓慢明暗脉动
   *      target ×= 0.72 + 0.28·(0.5 + 0.5·sin(2.4t + φ_i))（琥珀呼吸灯语义）；
   *    - CrashLoopBackOff/OOMKilled：target = 红 ×1.5（分量 >1 过曝辉光）；
   *      水平抖动 Δx = 0.04·sin(35t + φ_i)（契约公式，相位错开）；
   *      尺寸脉冲 s = 1 + 0.25·sin(14t + φ_i)（剧烈收缩膨胀，告警动感）。
   *
   * 3. 过滤聚焦：statusFilter ≠ 'ALL' 且状态不匹配 → 目标缩放 0.15，
   *    当前值以 k=8 指数阻尼 lerp 平滑逼近（filterScaleBuffer 持久缓冲）；
   *    最终缩放 = 状态脉冲 × 过滤系数（三轴同乘，缩小态保持姿态）。
   *
   * 4. 颜色渐变：getColorAt 读当前实例色 → 向目标色 lerp（k=6 帧率无关
   *    指数阻尼 α = 1 − e^(−k·Δt)，Δt 钳 0.1s）→ setColorAt 回写；
   *    instanceColor 缓冲自身即「当前值」持久态，无需额外数组。
   *
   * 5. 提交：tempObject.updateMatrix() 复合 TRS → setMatrixAt；
   *    帧末显式 instanceMatrix.needsUpdate = true 与
   *    instanceColor.needsUpdate = true（AGENTS.md 第 7 条强制契约，
   *    缺任一 GPU 侧将继续绘制上一帧的陈旧缓冲）。
   */
  useFrame((state, delta): void => {
    const mesh = meshRef.current;
    if (mesh === null) return;

    const pods = telemetryTransientRef.snapshot.pods;
    const count = pods.length <= MAX_PODS ? pods.length : MAX_PODS;

    /* 绘制数量命令式驱动（容量恒定 48，count 变化零重建） */
    if (mesh.count !== count) {
      mesh.count = count;
    }
    if (count === 0) return;

    /* 防御性兜底：instanceColor 缓冲缺失时立即补建（正常路径由挂载 effect 创建） */
    if (mesh.instanceColor === null) {
      mesh.setColorAt(0, tempColor.set('#ffffff'));
    }

    const t = state.clock.getElapsedTime();
    const dt = Math.min(delta, MAX_FRAME_DELTA);
    const colorAlpha = 1 - Math.exp(-COLOR_LERP_RATE * dt);
    const scaleAlpha = 1 - Math.exp(-FILTER_SCALE_LERP_RATE * dt);
    const filter = statusFilterRef.current;
    const cpuArray = telemetryTransientRef.podCpuFloat32;

    /**
     * 自愈时间戳表与"当前时刻"。
     *
     * 【为何在这里读 zustand】（AGENTS.md 第 3 条的边界说明）
     * 双轨纪律禁止在渲染循环里做**高频遥测订阅**；而 `healedPodIds` 是
     * 用户点击自愈才写入的低频字典，且 `getState()` 只是一次属性读取、
     * 不建立订阅、不触发重渲染。整帧只调用一次并复用，开销可忽略。
     *
     * 【时钟域必须一致】healEntity 用 `Date.now()` 写入时间戳，
     * 此处同样用 `Date.now()` 求差值，否则跨时钟源会得到负数/偏差。
     */
    const healedPodIds = useClusterStore.getState().healedPodIds;
    const nowMs = Date.now();

    /**
     * ---- 过滤上下文：匹配计数 + 扫描波进度 ----
     *
     * 【每帧统计 matchedCount】容器状态会随混沌演练变化，
     * 因此"当前筛选是否有匹配"必须逐帧判断，不能用订阅值缓存。
     * 24 次字符串比较的开销可忽略（远小于一次 setMatrixAt）。
     *
     * 【零匹配分支】matchedCount === 0 时**绝不能**沿用 0.22 的缩小逻辑：
     * 那会把 24 个正常容器一起缩成小碎点，机架看起来像被清空了。
     */
    let matchedCount = 0;
    if (filter !== 'ALL') {
      for (let i = 0; i < count; i++) {
        if (pods[i].status === filter) matchedCount += 1;
      }
    }
    const hasMatch = filter === 'ALL' || matchedCount > 0;

    /* 扫描波：切换后 650ms 内的归一化进度；窗口外为负值表示"不激活" */
    const waveElapsedMs = performance.now() - filterSwitchTimeRef.current;
    const waveProgress =
      waveElapsedMs >= 0 && waveElapsedMs < FILTER_WAVE_DURATION_MS
        ? waveElapsedMs / FILTER_WAVE_DURATION_MS
        : -1;

    for (let i = 0; i < count; i++) {
      const pod = pods[i];

      /* ---- 1. 槽位查表（归约与 getPodWorldTransform 同构） ---- */
      const rackIdx = ((pod.rackIndex % RACK_COUNT) + RACK_COUNT) % RACK_COUNT;
      const slotIdx =
        ((Math.floor(pod.slotIndex) % SLOTS_PER_RACK) + SLOTS_PER_RACK) % SLOTS_PER_RACK;
      const pose = SLOT_POSES[rackIdx * SLOTS_PER_RACK + slotIdx];
      const phase = POD_PHASES[i];

      /* ---- 2. 状态调制：几何位移/缩放 + 目标色 ---- */
      let posX = pose.position[0];
      let posY = pose.position[1];
      let posZ = pose.position[2];
      let scaleX = 1;
      let scaleY = 1;
      let scaleZ = 1;
      /** 悬浮抬升量（恒 ≥ 0 的全正半波；仅 Running 态参与） */
      let hoverLift = 0;

      tempTargetColor.copy(resolvePodTargetColor(pod.status));

      switch (pod.status) {
        case 'Running': {
          /*
           * ---- 负载平滑 + 相位积分（根治"每秒瞬移"）----
           *
           * 【缺陷复现】旧代码：
           *   posY += (0.02 + 0.04c)·sin(t·(1.6 + 0.8c) + φ)
           *   scaleY = 1 + 0.1c + 0.02·sin(2t + φ)
           * c 每秒阶跃时，`t·(1.6 + 0.8c)` 里的 c 被乘以"已经流逝的整段时间 t"。
           * t = 60s 时 c 跳 0.1 → 相位跳 0.1 × 0.8 × 60 ≈ 4.8 rad ≈ 275°，
           * 盒子位置瞬间跳到几乎相反相位 —— 观感就是一秒抽一次。
           *
           * 【修复两步】
           * 1. c 先做帧率无关指数阻尼 → smoothC 连续变化；
           * 2. 相位改为**对角速度积分** φ += ω(smoothC)·dt（而非 t·ω(c)），
           *    数据帧跳变只改变此后的角速度，历史相位不可变 → 零跳变。
           */
          /*
           * 【C7】按 Pod ID 取稳定槽位读值，而不是按下标：
           * 快照重排/扩缩容时，下标会指向另一个 Pod，表现为水位串台。
           */
          const slotIndex = telemetryTransientRef.podSlotById.get(pods[i].id);
          const cpuRaw = cpuArray[slotIndex === undefined ? i : slotIndex];
          const cRaw = Number.isNaN(cpuRaw) ? 0 : Math.min(1, Math.max(0, cpuRaw / 100));
          const smoothAlpha = 1 - Math.exp(-CPU_SMOOTH_RATE * dt);
          const prevSmooth = smoothedCpuBuffer[i];
          const smoothC = prevSmooth + (cRaw - prevSmooth) * smoothAlpha;
          smoothedCpuBuffer[i] = smoothC;

          const accumulatedPhase = phaseAccumBuffer[i] + (RUN_HOVER_RATE_BASE + RUN_HOVER_RATE_GAIN * smoothC) * dt;
          const wrappedPhase = accumulatedPhase - Math.floor(accumulatedPhase / TWO_PI) * TWO_PI;
          phaseAccumBuffer[i] = wrappedPhase;

          /*
           * ---- 全正半波悬浮（根治"向下穿模"）----
           * hoverWave = 0.5 + 0.5·sin(φ) ∈ [0, 1]，恒非负；
           * 抬升幅度 0.012 + 0.024·smoothC（最忙也仅 3.6cm 的精密微呼吸）。
           * 方位位移不再直接改 posY，而是交给末段的"底面锚定"统一合算。
           */
          const hoverWave = 0.5 + 0.5 * Math.sin(wrappedPhase);
          hoverLift = (RUN_HOVER_BASE + RUN_HOVER_LOAD_GAIN * smoothC) * hoverWave;
          /* 高度只保留随负载的静态鼓胀（呼吸已交给竖直位移，避免双重抖动） */
          scaleY = 1 + RUN_HEIGHT_LOAD_GAIN * smoothC;
          break;
        }
        case 'Pending':
        case 'Terminating': {
          // 缓慢明暗脉动：亮度包络 [0.72, 1.0] 正弦往复（几何静止）
          const pulse =
            PENDING_PULSE_MIN +
            (1 - PENDING_PULSE_MIN) * (0.5 + 0.5 * Math.sin(t * PENDING_PULSE_RATE + phase));
          tempTargetColor.multiplyScalar(pulse);
          break;
        }
        case 'CrashLoopBackOff':
        case 'OOMKilled': {
          // 高亮鲜红：×1.5 过曝增强发光感（契约指定调用）
          tempTargetColor.multiplyScalar(CRASH_GLOW_BOOST);

          /*
           * ---- 水平抖动：沿**机架局部 X 轴**，而非世界 X 轴 ----
           *
           * 【缺陷复现】旧代码写 `posX += A·sin(...)`，只在世界 X 方向位移。
           * 机架被 getRackTransform 旋转了 θ ≈ 30°~150°，因此世界 X 位移在
           * 机架坐标系里会被分解成"局部 X 分量 cos θ + 局部 Z 分量 −sin θ"：
           * 结果刀片是斜着朝邻位刀片蹭过去的，视觉上既晃错了方向，
           * 又额外侵占了纵深空间（可能顶到前排/隔板）。
           *
           * 【正确公式】把标量抖动 j 映射到设备局部 X 单位向量在世界系的投影：
           *   局部 X = (cos θ, 0, −sin θ)
           *   → posX += j·cos θ；posZ −= j·sin θ
           * 这与 getPodWorldTransform 的 R_y(θ) 复合规则完全一致。
           *
           * 【为何用 pose.rotationY 而不是重新算 θ】pose 就是本实例槽位的位姿查表
           * 结果，机架旋转角在构建时已写入，直接复用零成本、且与矩阵复合同源。
           */
          const jitter = CRASH_JITTER_AMPLITUDE * Math.sin(CRASH_JITTER_RATE * t + phase);
          posX += jitter * Math.cos(pose.rotationY);
          posZ -= jitter * Math.sin(pose.rotationY);

          /* 尺寸脉冲（±15%，三轴均匀；不穿透由末段底面锚定保证） */
          const pulse = 1 + CRASH_PULSE_AMPLITUDE * Math.sin(t * CRASH_PULSE_RATE + phase);
          scaleX = pulse;
          scaleY = pulse;
          scaleZ = pulse;
          break;
        }
      }

      /* ---- 3. 过滤聚焦：三态目标缩放（匹配 / 无匹配 / 零匹配幽灵态） ----
       *
       * 【三态设计】
       * a) filter === 'ALL'                     → 全部 1.0（常态）
       * b) filter ≠ ALL 且 matchedCount > 0     → 匹配 1.12 高亮、其余 0.22 退让
       * c) filter ≠ ALL 且 matchedCount === 0   → **全部 1.0** 幽灵参考态（体积不缩水，仅颜色收敛灰蓝），
       *    颜色向冷灰蓝收敛 50%，表达"当前过滤条件下无匹配项"。
       *    这是修复"点异常状态后整排容器消失"的关键分支：
       *    没有匹配 ≠ 容器不存在，机架必须保持完整体积感。
       */
      const matchesFilter = filter === 'ALL' || pod.status === filter;
      let filterTarget: number;
      if (filter === 'ALL') {
        filterTarget = 1;
      } else if (hasMatch) {
        filterTarget = matchesFilter ? FILTER_MATCH_SCALE : FILTER_DIM_SCALE;
      } else {
        filterTarget = FILTER_NO_MATCH_SCALE;
      }
      const currentFilterScale =
        filterScaleBuffer[i] + (filterTarget - filterScaleBuffer[i]) * scaleAlpha;
      filterScaleBuffer[i] = currentFilterScale;
      scaleX *= currentFilterScale;
      scaleY *= currentFilterScale;
      scaleZ *= currentFilterScale;

      /* ---- 3b. 零匹配：全体颜色向冷灰蓝收敛（平滑，由颜色阻尼自然过渡） ---- */
      if (!hasMatch) {
        tempTargetColor.lerp(COLOR_FILTER_GHOST, FILTER_GHOST_COLOR_MIX);
      }

      /* ---- 3c. 扫描波：切换过滤器后 650ms 内的自下而上充能 ---- */
      if (waveProgress >= 0) {
        /*
         * 【层间错峰数学】把全局进度按实例层位延后：
         *   local = clamp(global · 1.5 − tierNorm · 0.5)
         * 底部实例（tierNorm=0）在 global=0 时立刻起跳，
         * 顶部实例（tierNorm=1）要等到 global≈0.33 才开始，
         * 于是整列容器呈现"自下而上扫过"的波浪感，而非齐步跳。
         *
         * 【包络】wave = sin(local·π)：两端为 0、中段为 1，
         * 因此起跳与回落都无阶跃（与自愈脉冲同一包络设计）。
         */
        const localProgress = Math.min(
          1,
          Math.max(0, waveProgress * 1.5 - pose.tierNorm * FILTER_WAVE_TIER_SKEW),
        );
        const wave = Math.sin(localProgress * Math.PI);
        if (wave > 0) {
          /* 只放大 Y：表现为"向上跳一下"，而不是整体膨胀 */
          scaleY *= 1 + FILTER_WAVE_SCALE_AMPLITUDE * wave;
          tempTargetColor.lerp(COLOR_FILTER_WAVE, FILTER_WAVE_COLOR_STRENGTH * wave);
        }
      }

      /*
       * ---- 4. 自愈充能脉冲（点击自愈 → 3D 腔体瞬间点亮）----
       *
       * 【核心数学】设 p = 已过时间 / 2500ms ∈ [0,1)，取包络 w = sin(p·π)：
       *   p=0 → 0（刚写入，与上一帧状态连续，无跳变）
       *   p=0.5 → 1（约 1.25s 时达到峰值：弹性鼓胀 + 最亮青白）
       *   p→1 → 0（平滑回落，动画自然收尾而非硬切）
       * 该包络两端均为 0，因此**开头结尾都不会出现颜色/缩放的阶跃**，
       * 这是"充能"而非"闪烁"的关键。
       *
       * 缩放：三轴同比放 1 + 0.14·w（弹性呼吸，峰值 +14%）。
       * 颜色：目标色向 #a7f3d0 混合 0.82·w —— 峰值时约 82% 白化，
       *       既足够"点亮"，又保留 18% 状态色以维持语义可辨识。
       */
      const healedAt = healedPodIds[pod.id];
      if (healedAt !== undefined) {
        const elapsed = nowMs - healedAt;
        if (elapsed >= 0 && elapsed < HEAL_PULSE_DURATION_MS) {
          const progress = elapsed / HEAL_PULSE_DURATION_MS;
          const wave = Math.sin(progress * Math.PI);
          const chargePulse = 1 + HEAL_SCALE_AMPLITUDE * wave;
          scaleX *= chargePulse;
          scaleY *= chargePulse;
          scaleZ *= chargePulse;
          /* 在「状态调制后的目标色」之上叠加白化，颜色阻尼会自然平滑过渡 */
          tempTargetColor.lerp(COLOR_HEAL_FLASH, HEAL_COLOR_STRENGTH * wave);
        }
      }

      /* ---- 5. 底面锚定（Bottom-Anchored Lift）——根治向下穿模 ----
       *
       * 【问题】旧实现以"盒子中心"为锚点，且悬浮用完整的 sin（负半周使盒子下沉
       * 最多 −0.06），同时 scaleY > 1 会让盒子围绕中心**上下对称**伸长。
       * 两者叠加，盒子底面必然插进隔板——静止时本就零间隙贴死，没有任何余量。
       *
       * 【解法：先算高度，再反推中心】
       *   shelfTopY  = 层中心 − POD_BOX_HEIGHT/2   （= 隔板顶面，与 WorkerRack3D 同源）
       *   当前半高   = POD_BOX_SIZE[1] · scaleY / 2
       *   posY       = shelfTopY + 安全间隙 + 当前半高 + 悬浮抬升
       *
       * 因为 posY 是在**所有缩放因子（状态鼓胀 / 过滤 / 扫描波 / 自愈脉冲）全部
       * 结算之后**才计算的，所以无论盒子怎么放大缩小，底面永远固定在
       * `shelfTopY + 0.026 + hoverLift`，物理上不可能穿过隔板。
       * 而且缩放自然变成"向上生长"而非"向上下同时膨胀"，更符合刀片插拔的直觉。
       *
       * 【覆盖范围：全状态，含故障态】
       * 本赋值是**无条件**的，位于 switch（Running / Pending / Crash）之后，
       * 因此 CrashLoopBackOff / OOMKilled 的 ±15% 尺寸脉冲同样只有两条出路：
       * 盒子变高时顶点上抬、变矮时顶点下降，**底面恒在隔板之上 0.026**。
       * 故障态 hoverLift 恒为 0（只有 Running 会赋值），所以故障刀片是
       * "贴着自己的承托底座剧烈搏动"，绝不会随脉冲扎进隔板。
       *
       * 【水平安全】故障脉冲同时作用于 scaleX：
       * 盒宽 0.74 × 最大 1.15 = 0.851，邻位中心距 0.92 → 净间距 0.069 > 0；
       * 再叠加 0.025 的局部 X 抖动，仍有 0.094 的余量，不会撞击相邻刀片。
       */
      const shelfTopY = pose.position[1] - POD_BOX_HEIGHT / 2;
      const halfCurrentHeight = (POD_BOX_SIZE[1] * scaleY) / 2;
      posY = shelfTopY + BASE_PAD_CLEARANCE + halfCurrentHeight + hoverLift;

      /* ---- 6. 矩阵复合提交（TRS → instanceMatrix） ---- */
      tempObject.position.set(posX, posY, posZ);
      tempObject.rotation.set(0, pose.rotationY, 0);
      tempObject.scale.set(scaleX, scaleY, scaleZ);
      tempObject.updateMatrix();
      mesh.setMatrixAt(i, tempObject.matrix);

      /* ---- 7. 颜色平滑渐变 + 近大远小光泽对比 + 故障呼吸频闪 ---- */
      mesh.getColorAt(i, tempColor);
      tempColor.lerp(tempTargetColor, colorAlpha);

      /*
       * ---- 7a. 相机距离光泽对比（近景更锐利、远景更柔和）----
       *
       * 【为何用本帧刚算出的 posX/posY/posZ 而非实例矩阵反解】
       * 这三个变量就是本帧最终的世界位置，直接拿来算距离比
       * 从矩阵 decompose 更省（矩阵反解要 3 次乘加 + 开方）。
       *
       * 【零分配】纯标量算术，不构造 Vector3。
       */
      const camPos = state.camera.position;
      const pdx = camPos.x - posX;
      const pdy = camPos.y - posY;
      const pdz = camPos.z - posZ;
      const instanceDist = Math.sqrt(pdx * pdx + pdy * pdy + pdz * pdz);
      const distanceGain = Math.min(
        POD_DEPTH_MAX,
        Math.max(POD_DEPTH_MIN, POD_DEPTH_BASE - (instanceDist - POD_DEPTH_PIVOT) * POD_DEPTH_SLOPE),
      );

      /*
       * 【为何用 multiplyScalar 而非 lerp 到白色】
       * 直接乘到颜色向量上是**等比提亮**：保留色相，只改明度。
       * 若 lerp 到白色，近景刀片会褪色成灰白，失去翡翠/青的语义色。
       * 等比提亮后，近景刀片仍是翡翠绿，只是更亮更锐利。
       */
      tempColor.multiplyScalar(distanceGain);

      /*
       * ---- 7b. 故障态呼吸频闪 ----
       *
       * 【为何只对故障态施加】正常运行态已由负载呼吸（悬浮抬升）表达活力，
       * 再叠一层亮度频闪会让整个机柜"一直在抖"，反而干扰阅读。
       * 只有故障态需要"持续报警"的视觉压力。
       *
       * 【相位错开】用 i * 0.7 让 24 个刀片不同步呼吸——
       * 若全部同相，整排刀片会像一根灯管一样整齐闪烁，那是装饰灯不是故障。
       */
      const isFaulty =
        pod.status === 'CrashLoopBackOff' || pod.status === 'OOMKilled' || pod.status === 'Terminating';
      if (isFaulty) {
        const breathPhase = t * FAULT_BREATH_RATE + i * 0.7;
        const faultBreath = FAULT_BREATH_MIN + FAULT_BREATH_GAIN * (0.5 + 0.5 * Math.sin(breathPhase));
        tempColor.multiplyScalar(faultBreath);
      }

      mesh.setColorAt(i, tempColor);
    }

    /* ---- 7. GPU 缓冲提交（AGENTS.md 第 7 条强制契约） ---- */
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh
        ref={meshRef}
      /* 容量恒为 MAX_PODS（args 变化 = 整 mesh 重建灾难，见文件头容量契约）；
         实际绘制数由 useFrame 经 mesh.count 命令式收窄 */
      args={[undefined, undefined, MAX_PODS]}
      /* ---- 阴影参与（目标图二的能量晶体立体感来源） ----
       * castShadow：让每个方块在主光方向投下短促的自身阴影，是"体积感"的关键；
       * receiveShadow：接收隔板与相邻方块的投影，避免整块表面均匀发亮。
       * InstancedMesh 的实例阴影由 three 在阴影通道内自动展开，无需额外逐实例矩阵。 */
      castShadow
      receiveShadow
      /* 实例散布全场景（三机架半径 9.5），而 InstancedMesh 的包围球默认
         按几何体原点计算——不关闭视锥剔除会被整群错误剔除（集体消失）。
         48 实例的绘制成本可忽略，剔除收益为负，故显式禁用。 */
      frustumCulled={false}
      /* ---- 指针交互三件套（精准且不掉帧，见文件头交互契约） ----
         R3F 对 InstancedMesh 的命中回填 e.instanceId（实例下标），
         move 只在跨实例边界时 setState；out 清空悬停；click 选中触发
         CameraRig 特写飞行。命中链上游的 WorkerRack3D 按「Pod 命中
         让位协议」放行，本层 stopPropagation 即可独占事件。 */
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
      onClick={handleClick}
    >
      {/* 契约几何：0.66 × 0.56 × 0.56 容器晶块（尺寸源自 spatialLayout 单一事实源） */}
      <boxGeometry args={[POD_BOX_SIZE[0], POD_BOX_SIZE[1], POD_BOX_SIZE[2]]} />
      {/*
       * AGENTS.md 第 7 条：动态实例着色的基础材质 color 必须 #ffffff
       * （实例色与材质色相乘，白基色保证 instanceColor 原样呈现）
       * 且 toneMapped={false}（状态色绕过色调映射，红/绿/琥珀保持语义纯度）。
       *
       * 【PBR 吞光修复】早先的配置是 metalness={0.5} roughness={0.2}，但当时场景内
       * **没有任何环境贴图**（无 <Environment> / envMap）。按 PBR 能量守恒，
       * 金属度 0.5 会把一半的漫反射固有色替换成"环境反射"，
       * 而环境是 #020617 纯黑背景 → 反射回黑色 → 翠绿被砍成暗沉泥绿。
       * 后续 ClusterCanvas 注入了 RoomEnvironment 生成的 PMREM 环境贴图，
       * 环境反射终于有东西可借；但刀片是**画面主体**，
       * 环境贡献必须比机柜外框更低，否则装甲反光会盖过状态色语义。
       *
       * 【关于 emissive 的重要修正】
       * 曾尝试把 `emissive` 设为 `#ffffff` 并抬高 `emissiveIntensity` 来"更亮"，
       * 结果是**所有容器一起变白**、翠绿/绯红状态色被冲掉。
       * 原因：three.js 的 `instanceColor` 只乘到**漫反射 albedo**，
       * 不参与 `emissive` 项——白色自发光对每个实例都是同样的纯白。
       *
       * 本项目真正的逐实例发光来自下方 `injectCrystalShader`：
       * 它把"霓虹棱边 / 阳极氧化凹槽 / 内芯光"三层结构注入 `emissive` 通道，
       * 并由 `vColor`（实例色）着色，因此天然跟随状态色。
       * 所以这里**保持 emissive 为默认黑**，亮度交给着色器。
       */}
      <meshStandardMaterial
        color="#ffffff"
        roughness={0.18}
        metalness={0.15}
        /*
         * 环境贴图贡献：0.30。
         *
         * 【为何明显低于机柜的 0.65】刀片承载状态语义（绿=Running / 琥珀 / 绯红），
         * 一旦环境反射占比过高，金属高光会在正面形成大片冷白，
         * 把"这排容器是绿的"这一最关键的判读信息冲淡。
         * 0.30 只让边缘切角吃到一点冷金属反光，正面仍然由状态色主导。
         */
        envMapIntensity={0.3}
        toneMapped={false}
        onBeforeCompile={injectCrystalShader}
      />
      </instancedMesh>

      {/* ---- 悬停微型标签（单个 <Html>，仅悬停实例存在时挂载） ----
          【契约】center + distanceFactor=12 + zIndexRange=[10,0] +
          pointer-events-none（AGENTS.md 第 6 条：严禁遮挡抽屉/Modal，
          且不拦截射线——标签若吃指针事件会造成「悬停标签挡住下一个
          Pod 命中」的拾取抖动）。位置查表 SLOT_POSES 与实例渲染同源。 */}
      {hoverLabelData !== null && hoverLabelPosition !== null ? (
        <Html
          position={hoverLabelPosition}
          center
          distanceFactor={12}
          zIndexRange={[10, 0]}
          className="pointer-events-none"
        >
          <div className="pointer-events-none flex flex-col gap-1">
            {/*
             * ---- 精密全息探针卡（与机架铭牌同一套 HUD 语言）----
             *
             * 升级点：四角战术折角框 + 扫描线底纹 + CPU/MEM 微型实时进度条
             * + 所属槽位编码 `RACK-n // SLOT-nn`。
             * 这样悬停任一容器时，弹出的卡片与机架铭牌、控制平面铭牌
             * 共用同一套视觉语法，整个场景才像一个统一的 HUD 系统。
             */}
            <HoloFrame accent={POD_STATUS_BADGE[hoverLabelData.status].color}>
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'inline-block h-1.5 w-1.5 rounded-full',
                    POD_STATUS_BADGE[hoverLabelData.status].extraClass,
                  )}
                  style={{ backgroundColor: POD_STATUS_BADGE[hoverLabelData.status].color }}
                />
                <span className="max-w-[180px] truncate font-mono text-[10px] font-bold tracking-wide text-slate-100">
                  {hoverLabelData.name}
                </span>
                <span
                  className={cn(
                    'ml-1 font-mono text-[10px] uppercase tracking-[0.14em]',
                    POD_STATUS_BADGE[hoverLabelData.status].extraClass,
                  )}
                  style={{ color: POD_STATUS_BADGE[hoverLabelData.status].color }}
                >
                  {POD_STATUS_BADGE[hoverLabelData.status].label}
                </span>
              </span>

              {/* 槽位编码：与 spatialLayout 的 rackIndex / slotIndex 同源 */}
              <span className="mt-0.5 block font-mono text-[10px] tracking-[0.16em] text-slate-500">
                RACK-{hoverLabelData.rackIndex} {'//'} SLOT-{String(hoverLabelData.slotIndex).padStart(2, '0')}
              </span>

              {/* CPU / MEM 微型实时发光进度条 */}
              <span className="mt-1 flex items-center gap-2">
                <MiniBar label="CPU" value={hoverLabelData.cpuUsage} />
                <MiniBar label="MEM" value={hoverLabelData.memoryUsage} tone="#38bdf8" />
              </span>
            </HoloFrame>
          </div>
        </Html>
      ) : null}
    </>
  );
}