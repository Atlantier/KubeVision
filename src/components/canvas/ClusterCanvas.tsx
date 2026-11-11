'use client';

/**
 * KubeVision AI — 3D 集群拓扑根画布（ClusterCanvas）
 *
 * 【职责边界】本组件是 R3F 渲染树根：<Canvas> 配置（dpr/相机/WebGL 上下文）+
 * 场景氛围层（雾效/灯光/双层网格/悬浮粒子）+ 程序化集群模型
 * （MasterNode3D 控制平面 + WorkerRack3D × 3 计算机架）+ CameraRig 运镜系统。
 *
 * 【SSR 边界】首行 'use client'；实际挂载由 page.tsx 经 next/dynamic(ssr:false)
 * 懒加载完成——three/R3F 代码永不进入服务端 bundle（AGENTS.md 第 4 条）。
 *
 * 【preserveDrawingBuffer 契约】gl.preserveDrawingBuffer = true 使 WebGL
 * 绘制缓冲在帧合成后仍可读取，支撑「多模态视觉快照」——Copilot 的
 * VLM 通道经 canvas.toDataURL() 截取 3D 视口写入 capturedViewportDataUrl
 * （AGENTS.md 多模态视觉分析的取数前提；性能代价仅在此画布，可接受）。
 *
 * 【层级契约】drei <Html> 标注一律 zIndexRange=[10,0] + 容器 pointer-events-none，
 * 永不遮挡 Copilot 抽屉（z-30+）与顶层 Modal（z-50）（AGENTS.md 第 6 条）。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, type RootState } from '@react-three/fiber';
import { ContactShadows, Grid, MeshReflectorMaterial, PerformanceMonitor, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { NeutralToneMapping, NoToneMapping } from 'three';
import { ExposureDriver, ExposureEffect, type ExposureEffectHandle } from '@/components/canvas/ExposureDriver';
import { Bloom, DepthOfField, EffectComposer, FXAA, Noise, ToneMapping, Vignette } from '@react-three/postprocessing';
import type { DepthOfFieldEffect } from 'postprocessing';
import { ToneMappingMode } from 'postprocessing';

import { useClusterStore } from '@/store/useClusterStore';
import CyberMatrixRain3D from '@/components/canvas/CyberMatrixRain3D';
import ProceduralPbrEnvironment from '@/components/canvas/ProceduralPbrEnvironment';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import { MASTER_POSITION, getRackTransform } from '@/utils/spatialLayout';
import { useInViewPause } from '@/hooks/useInViewPause';
import { dispatchViewPreset, subscribeViewPreset } from '@/utils/viewPresetBus';
import type { WorkerNodeEntity } from '@/types/cluster';
import type { ViewPresetKey } from '@/types/canvas';
import type { SelectedEntityType } from '@/types/store';

import CameraRig from '@/components/canvas/CameraRig';
import ErrorRippleRing from '@/components/canvas/ErrorRippleRing';
import GlStatsCollector from '@/components/canvas/GlStatsCollector';
import MasterNode3D from '@/components/canvas/MasterNode3D';
import NetworkStream3D from '@/components/canvas/NetworkStream3D';
import GroundHorizonFade from '@/components/canvas/GroundHorizonFade';
import ArcStartGlow3D from '@/components/canvas/ArcStartGlow3D';
import ReturnStream3D from '@/components/canvas/ReturnStream3D';
import RackGroundReflection from '@/components/canvas/RackGroundReflection';
import BootController from '@/components/canvas/BootController';
import GlowDebugOverlay from '@/components/canvas/GlowDebugOverlay';
import { useQualityStore } from '@/store/useQualityStore';
import { useQualityGovernor } from '@/hooks/useQualityGovernor';
import PodInstancedMesh from '@/components/canvas/PodInstancedMesh';
import ClusterTopologyFloor3D from '@/components/canvas/ClusterTopologyFloor3D';
import { HalfFloatType } from 'three';
import { getDemoDirectorSnapshot } from '@/utils/demoDirector';
import SelectionBeacon3D from '@/components/canvas/SelectionBeacon3D';
import ViewportToolbar from '@/components/canvas/ViewportToolbar';
import WorkerRack3D from '@/components/canvas/WorkerRack3D';
import NodeInspectHUD from '@/components/hud/NodeInspectHUD';

/* ========================================================================== */
/* 场景常量（深空赛博氛围参数，集中定义）                                          */
/* ========================================================================== */

/**
 * 深空背景/雾效基色（深空冷蓝）。
 *
 * 【本轮从 #020617 改为 #020815】原值与背景几乎同色，雾化后的物体
 * 只是"变暗"而没有被染上一层冷蓝色调。新值在蓝通道上抬高一点，
 * 使远处机架在雾中呈现**冷蓝的空气透视**，而不是单纯的黑化——
 * 这是真实大气透视的关键：远处的物体不是变黑，而是被大气的散射色取代。
 */
/* R25：背景色 / 雾色 / 地面中心色统一到 #020611，消除地平线色差 */
const VOID_COLOR = '#020611';

/**
 * 雾效近端距离（15 单位内完全清晰）。
 *
 * 【重要：本值经实测校准，与最初设想的 13.5 不同】
 *
 * three.js 的线性雾并不按欧氏距离工作，而是：
 *   fogFactor = smoothstep(fogNear, fogFar, vFogDepth)
 * 其中 vFogDepth = -mvPosition.z 是**视空间深度**（相机前方投影距离）。
 * smoothstep 在区间两端导数趋零、中段陡峭，因此同样的一对 (near, far)
 * 产生的雾量比线性插值大得多。
 *
 * 实测三座机架的视深（相机 [7.8,14,22] 看向 [0,2.5,0]）：
 *   worker-alpha 19.09 · worker-beta 28.68 · worker-gamma 33.61
 *
 * 若按最初设想的 (13.5, 36) 代入 smoothstep：
 *   15.5% / 75.1% / **96.8%** —— 远端机架几乎完全被雾吞掉，
 * 与"远端约 30% 大气雾化、近端保持极高锐度"的目标严重不符。
 *
 * 经穷举搜索校准，(15, 64) 给出：
 *   2.0% / 18.7% / **31.9%** —— 精确命中"远端约 30%"的设计意图，
 * 且三层梯度均匀，中间机架也有清晰的距离感。
 *
 * 【为何 fogFar 反而比原值 48 更大】smoothstep 的缓变区在区间中段；
 * 要让"最近机架几乎无雾"同时"最远机架只雾 30%"，必须把区间拉宽，
 * 使三座机架都落在 smoothstep 的**平缓上升段**而非陡峭段。
 * 窄区间（如 22~36）会把三座机架挤在陡峭段上，任何微小距离差
 * 都对应巨大的雾量差，反而是"要么全清要么全糊"的两极效果。
 */
const FOG_NEAR = 15;

/**
 * 雾效远端距离（64 单位处完全没入深空）。
 *
 * 【推导详见 FOG_NEAR 注释】与近端 15 共同构成 49 单位的缓变区间，
 * 使三座机架分别落在 2% / 19% / 32% 的位置。
 *
 * 这个值看起来比原 48 更远，但实际雾化更强——
 * 因为近端从 18 提到了 15，整体区间被"拉开"，smoothstep 的形状
 * 让近端更清晰、远端仍有足够雾量。
 */
const FOG_FAR = 64;

/** 初始相机机位（全景鸟瞰，与 OVERVIEW_CAMERA_POSITION 契约一致） */
/**
 * 初始相机机位（世界坐标）。
 *
 * 【为何从正后方 [0, 14, 22] 改为斜轴 [7.8, 14, 22]】
 * 正后方机位让三个机架严格对称排布，构图呆板且**互相遮挡**——
 * 中间机架被 Master 挡住，两侧机架又靠近边缘。图二采用的是经典
 * "斜轴三角构图"：相机偏向一侧，使三个机架在画面上呈现前中后三个层次，
 * 深度关系立刻清晰，也让地面拓扑星环的椭圆形状可见（正后会看成一条线）。
 *
 * 【为何 y 保持 14】`scripts/verify.mjs` L606 用 `|pos[1] - 14| > 1`
 * 判断"相机已离开全景机位"，y 值是该断言的锚点，不可改动。
 * X 偏移不影响该断言（选中机架后相机飞到 y=4.0，差值为 10，稳过）。
 */
const INITIAL_CAMERA_POSITION: [number, number, number] = [7.8, 14, 22];

/**
 * 垂直视场角（度）。
 *
 * 【为何从 45° 收到 40°】长焦压缩透视，让远处的机架不会因近大远小
 * 过度缩小，整体更接近"微缩模型"的精密感（图二正是这种观感）。
 * 收得太狠（如 36°）会让 19 世界单位宽的场景贴近视口边界，
 * 40° 是在"压缩感"与"完整构图"之间实测取得的安全值。
 */
const CAMERA_FOV = 40;

/* ========================================================================== */
/* ClusterCanvas 主体                                                          */
/* ========================================================================== */

/**
 * DofFocusDriver —— T3 景深焦点阻尼跟随（R27 B3）。
 *
 * 焦点目标 = 相机到"关注实体"的距离：选中节点→机架中心；
 * 选中 Pod→其所属机架中心；否则→控制平面中心。
 * 每 250ms 更新目标、每帧指数阻尼（k=5），镜头飞行时焦点平滑跟随、无跳变。
 *
 * @param props.effectRef 指向 DepthOfFieldEffect 的 ref
 */
function DofFocusDriver({
  effectRef,
}: {
  readonly effectRef: React.MutableRefObject<DepthOfFieldEffect | null>;
}): null {
  const targetRef = useRef<number>(12);
  const currentRef = useRef<number>(12);
  const lastReadRef = useRef<number>(0);
  const centerRef = useRef(new THREE.Vector3(MASTER_POSITION[0], MASTER_POSITION[1], MASTER_POSITION[2]));

  useFrame(({ camera }, delta): void => {
    const now = performance.now();
    if (now - lastReadRef.current >= 250) {
      lastReadRef.current = now;
      const state = useClusterStore.getState();
      const selectedId = state.selectedEntityId;
      centerRef.current.set(MASTER_POSITION[0], MASTER_POSITION[1], MASTER_POSITION[2]);
      if (selectedId !== null) {
        const node = state.snapshotSummary.nodes.find((item): boolean => item.id === selectedId);
        const pod = state.snapshotSummary.pods.find((item): boolean => item.id === selectedId);
        const rackIndex =
          node?.rackIndex ??
          (pod === undefined
            ? undefined
            : state.snapshotSummary.nodes.find((item): boolean => item.id === pod.nodeId)?.rackIndex);
        if (rackIndex !== undefined) {
          const rack = getRackTransform(rackIndex);
          centerRef.current.set(rack.position[0], rack.position[1] + 1.2, rack.position[2]);
        }
      }
      targetRef.current = camera.position.distanceTo(centerRef.current);
    }
    const alpha = 1 - Math.exp(-5 * Math.min(delta, 0.1));
    currentRef.current += (targetRef.current - currentRef.current) * alpha;
    const effect = effectRef.current;
    if (effect !== null) {
      effect.circleOfConfusionMaterial.focusDistance = currentRef.current;
    }
  });
  return null;
}

/**
 * ClusterCanvas —— R3F 根画布（page.tsx 经 dynamic(ssr:false) 懒加载挂载）。
 *
 * 【渲染树结构】
 * Canvas
 *  ├─ color/fog（深空氛围）
 *  ├─ 灯光（环境光 + 主方向光 + 中心青色点光源）
 *  ├─ 双层 Grid（细格近景 + 粗格远景，赛博极客地面）
 *  ├─ Sparkles（100 颗青色微光悬浮粒子）
 *  ├─ MasterNode3D（控制平面全息模型，锚定 MASTER_POSITION，可点击选中）
 *  ├─ WorkerRack3D × 3（程序化机架：磨砂装甲/托盘隔板/霓虹导光柱/全息铭牌）
 *  ├─ PodInstancedMesh（单 Draw Call 容器实例渲染器，48 容量，四态实时动画）
 *  ├─ NetworkStream3D（MASTER→机架拱形光缆 + 54 流动数据包，故障卡顿变红）
 *  ├─ ErrorRippleRing（故障机架地面警示涟漪，自定义 Shader 三环扩散）
 *  └─ CameraRig（OrbitControls + 防锁死运镜）
 *
 * 【DOM 浮层】（Canvas 之外、包装 div 之内）
 *  ├─ NodeInspectHUD（左上角：拓扑图例 / 实体巡检探针卡片）
 *  └─ ViewportToolbar（右下角：相机预设 / 环绕巡检 / 多模态快照）
 *
 * 【onPointerMissed】点击空白（射线未命中任何实体）→ selectEntity(null) →
 * 相机平滑飞回全景鸟瞰 [0, 14, 22]（取消选中语义的画布侧入口）。
 *
 * 【onCreated 调试钩子】仅开发构建把 R3F root store 暴露到 window 全局，
 * 供 E2E 断言与 React DevTools 之外的自动化内省读取相机/场景真实状态；
 * 生产构建中 process.env.NODE_ENV 被静态替换为 'production'，
 * 整个分支被 webpack 常量折叠 + DCE 移除（产物零调试面、零体积开销）。
 */

/* ========================================================================== */
/* 渲染质量档位（挂载期常量 · 运行期不可变）                                       */
/* ========================================================================== */

/**
 * 质量档位。
 *
 * 【为什么必须是挂载期常量】`MeshReflectorMaterial` 的 resolution 决定它内部
 * RenderTarget 的尺寸。运行期改这个值会让 drei 销毁并重建 FBO，并触发后处理链
 * 尺寸重算；这条重建路径在部分驱动上会留下未释放的纹理，表现为"越跑越卡，
 * 最后一次黑屏"。因此档位在首次渲染前一次定死，换档只能靠 key 整体重挂载。
 */
type RenderQualityTier = 'high' | 'balanced' | 'low';

/** 质量档位 → 后处理 AA 策略（L4）：T3 用 MSAA×2；T2 用 FXAA；T1 不加 AA */
type RenderTier = 'T3' | 'T2' | 'T1';

/** 反射 RT 分辨率（像素）——按档位固定，与 DPR 完全解耦 */
const REFLECTOR_RESOLUTION: Readonly<Record<RenderQualityTier, number>> = {
  high: 512,
  balanced: 256,
  low: 128,
};

/**
 * resolveQualityTier —— 首次渲染前解析质量档位。
 *
 * 【解析顺序】URL `?quality=high|balanced` 显式覆盖 → 否则默认 high。
 * 不在此处读 GPU：模块加载期还没有 WebGL 上下文；软件光栅化探测在 onCreated
 * 里做，它只决定"是否启用重后处理链"，不影响本函数的返回值。
 *
 * @returns 质量档位
 */
function resolveQualityTier(): RenderQualityTier {
  if (typeof window === 'undefined') return 'high';
  try {
    const param = new URLSearchParams(window.location.search).get('quality');
    if (param === 'low') return 'low';
    if (param === 'balanced') return 'balanced';
  } catch {
    /* URL 解析异常不影响默认档位 */
  }
  return 'high';
}

/** 【模块级单例】档位只解析一次，保证反射 RT 尺寸恒为同一个数 */
const RENDER_QUALITY_TIER: RenderQualityTier = resolveQualityTier();

/** 后处理 AA 策略（L4）：T3 = Composer 内 MSAA×2；T2 = FXAA；T1 = 不加 AA */
const RENDER_TIER: RenderTier =
  RENDER_QUALITY_TIER === 'high' ? 'T3' : RENDER_QUALITY_TIER === 'balanced' ? 'T2' : 'T1';

/**
 * DPR 上下限（L5）。
 *
 * 【为什么上限 1.75】DPR 从 2.0 降到 1.75 只损失约 12% 的线性分辨率，
 * 但像素数减少 23%——这是 Retina 屏上性价比最高的一刀。下限 0.85 保证
 * 弱 GPU 降级后仍不至于糊到读不清状态色；降级链只允许向下（R01 约束）。
 */
const DPR_MAX = 1.75;
const DPR_FLOOR = 0.85;

/**
 * 固定曝光（L1 / R62）。
 *
 * 稳态必须保持 1.0：ExposureDriver 的自定义 ExposureEffect 已经承担曝光系数，
 * 若这里再设 >1 会与后处理乘性曝光叠加成双重曝光（旧值 1.05 与 1.18 相乘）。
 */
const TONEMAP_EXPOSURE = 1.0;

/**
 * detectRenderCapabilities —— 挂载期能力探测（L8）。
 *
 * 【三个判据】软渲染判定不能只看 renderer 字符串：部分虚拟化环境会把
 * 字符串伪装成正常 GPU。这里叠加 WebGL2 可用性与
 * EXT_color_buffer_half_float（HDR 后处理 RT 的前提）：
 * - 无 WebGL2 或 无 half-float → 不能承载 HDR Bloom 链，按软渲染处理；
 * - renderer 字符串命中 swiftshader / software / llvmpipe 等 → 软渲染。
 *
 * @returns 是否软渲染 + 两项能力位
 */
function detectRenderCapabilities(): { software: boolean; webgl2: boolean; halfFloat: boolean } {
  if (typeof document === 'undefined') return { software: false, webgl2: true, halfFloat: true };
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl === null) return { software: true, webgl2: false, halfFloat: false };
    const halfFloat = gl.getExtension('EXT_color_buffer_half_float') !== null;
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName =
      debugInfo === null ? '' : String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '');
    const isSoftware =
      /swiftshader|software|llvmpipe|mesa offscreen|basic render/i.test(rendererName) || !halfFloat;
    /* 立即释放探测上下文，避免占用一个 WebGL slot */
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
    return { software: isSoftware, webgl2: true, halfFloat };
  } catch {
    return { software: true, webgl2: false, halfFloat: false };
  }
}

/** DPR 下调的最小间隔（毫秒） */
const DPR_ADJUST_COOLDOWN_MS = 8_000;

/** 会话内允许的 DPR 下调次数上限 */
const DPR_ADJUST_MAX_TIMES = 2;

/** 上下文丢失后等待自动恢复的上限（毫秒） */
const CONTEXT_RESTORE_TIMEOUT_MS = 15_000;

/** 档位重挂载遮罩时长（毫秒） */
const TIER_REMOUNT_MASK_MS = 200;

/** `?glDebug=1` 黑屏哨兵的采样间隔（毫秒） */
const GL_DEBUG_SAMPLE_MS = 500;

/** 黑屏哨兵：连续多少次接近 0 才告警 */
const GL_DEBUG_BLACK_LIMIT = 3;

/**
 * 兜底背景色（与 3D 场景 VOID_COLOR 同色系但略深）。
 *
 * 【为什么需要它】WebGL 上下文丢失后，canvas 的绘制缓冲变为空白。
 * 若容器本身没有背景色，用户看到的是**页面底下的纯黑**——与"渲染卡死"
 * 无法区分。垫一层同色 CSS 背景，至少让画面看起来仍是那个深空场景。
 */
const VOID_FALLBACK_COLOR = '#020611';

/** 首帧静态快照的体积上限（字节）。超过则放弃缓存，避免占用内存 */
const SNAPSHOT_MAX_BYTES = 200 * 1024;

/** 抓取首帧快照前等待的帧数（等场景稳定，避免拍到相机飞行中） */
const SNAPSHOT_SETTLE_FRAMES = 12;

/** 黑屏哨兵亮度阈值（0~255） */
const GL_DEBUG_LUMA_THRESHOLD = 2.0;

/** window 全局调试句柄的形状声明（避免污染全局 Window 接口，用局部索引签名窄化） */
type DebuggableWindow = Window & {
  __KUBEVISION_R3F__?: unknown;
  __KUBEVISION_STORE__?: unknown;
  __KUBEVISION_TRANSIENT__?: unknown;
};

/**
 * handleCanvasCreated —— R3F 根 store 创建完成回调（dev-only 调试暴露）。
 *
 * 【暴露内容】R3F RootState（gl/camera/scene/controls）+ 双轨 Store 句柄：
 * 响应轨 useClusterStore 与瞬态轨 telemetryTransientRef。后者使 E2E/开发期
 * 可直接注入故障快照（如批量 OOMKilled）验证实例化渲染器的四态动画，
 * 无需等待混沌引擎接线。
 *
 * @param state R3F RootState（含 gl/camera/scene/controls，onCreated 时机
 *              CameraRig 已挂载且 makeDefault 已生效，state.controls 非空）
 */
function handleCanvasCreated(state: RootState): void {
  if (process.env.NODE_ENV === 'development') {
    const debugWindow = window as DebuggableWindow;
    debugWindow.__KUBEVISION_R3F__ = state;
    debugWindow.__KUBEVISION_STORE__ = useClusterStore;
    debugWindow.__KUBEVISION_TRANSIENT__ = telemetryTransientRef;
  }
}
/**
 * 多模态快照诊断的固定 Prompt（triggerQuickPrompt 载荷）。
 * 中文指令与 Copilot 系统提示词协同：明确要求「视觉快照 × 遥测指标」联合诊断，
 * 后续轮次的 Copilot 消费端据此走 VLM 通道（capturedViewportDataUrl 作为图像输入）。
 */
const MULTIMODAL_DIAGNOSIS_PROMPT =
  '请结合当前 3D 集群拓扑快照与实时遥测指标，执行多模态空间异常联合诊断。';

/** JPEG 快照编码质量（0.8：视觉保真与 Base64 体积的平衡点，契约指定值） */
const SNAPSHOT_JPEG_QUALITY = 0.8;

export default function ClusterCanvas() {
  /* ---- Store 细粒度订阅（工具条受控状态四元组） ---- */
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );
  const isOrbitPatrolActive = useClusterStore((s): boolean => s.isOrbitPatrolActive);
  const hasCapturedViewport = useClusterStore(
    (s): boolean => s.capturedViewportDataUrl !== null,
  );
  const setOrbitPatrolActive = useClusterStore((s): ((active: boolean) => void) => s.setOrbitPatrolActive);
  const setCapturedViewport = useClusterStore((s): ((dataUrl: string | null) => void) => s.setCapturedViewport);
  const triggerQuickPrompt = useClusterStore((s): ((prompt: string) => void) => s.triggerQuickPrompt);
  const appendTerminalLog = useClusterStore((s): ((line: string) => void) => s.appendTerminalLog);

  /* ========================================================================== */
  /* 性能优化：视口休眠与自适应 dpr                                                */
  /* ========================================================================== */

  /** 画布容器引用（供 IntersectionObserver 观察可见性） */
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * 【视口休眠】监听页面可见性 + 元素视口可见性。
   *
   * 页面切到后台标签页，或画布滚出/被隐藏时 isActive 变 false，
   * Canvas 的 frameloop 随即切到 'demand'，每帧 draw call 彻底停止。
   * 这是全屏 3D 看板最大的省电杠杆——不可见时的渲染是纯粹的浪费。
   */
  const { isActive: isSceneActive } = useInViewPause(containerRef);

  /**
   * 自适应 dpr（1.0 ~ 2.0）。
   *
   * 【降级策略】由 drei 的 PerformanceMonitor 驱动：
   * - 帧率持续走低（onDecline）→ 逐步下调至 1.0；
   * - 帧率恢复良好（onIncline）→ 逐步回升至 2.0。
   *
   * 【为何用区间步进而非二值切换】直接 2.0 <-> 1.0 硬切会让整屏
   * 清晰度突变，用户会感到明显的"分辨率跳变"。按 0.25 步进平滑过渡，
   * 视觉上几乎察觉不到，但性能收益是逐步累积的。
   */
  const [adaptiveDpr, setAdaptiveDpr] = useState<number>(() => {
    /*
     * L5：挂载期常量（R01 约束）。软件渲染直接锁 1.0；
     * 真机取 min(devicePixelRatio, 1.75) 并 clamp 到下限 0.85。
     * 这是"挂载期一次定死"的初始值，后续只允许单向下调。
     */
    if (typeof window === 'undefined') return 1.75;
    if (detectRenderCapabilities().software) return 1;
    return Math.min(DPR_MAX, Math.max(DPR_FLOOR, window.devicePixelRatio));
  });

  /**
   * 自适应 dpr 的稳定性约束。
   *
   * dpr 改变会改变整个绘制缓冲的像素数，牵动 MeshReflectorMaterial 与
   * EffectComposer 的 RT 尺寸。频繁抖动是"跑着跑着黑屏"的高发原因，
   * 因此降级链被严格限制为：
   *   1. 只降不升（回升会再次重建 RT，收益远小于风险）；
   *   2. 会话内最多降 DPR_ADJUST_MAX_TIMES 次；
   *   3. 每次间隔 >= DPR_ADJUST_COOLDOWN_MS；
   *   4. 路演期间冻结（demoDirector 非 idle 时绝不调整）。
   */
  const dprAdjustRef = useRef<{ count: number; lastAt: number }>({ count: 0, lastAt: 0 });

  /**
   * 装饰层开关（非 FBO 参数）。
   *
   * 关闭星尘/矩阵雨这类不影响 RenderTarget 尺寸的装饰物，能实打实省下
   * draw call 与透明混合带宽，且不触发任何 GPU 资源重建——这是安全的降级。
   */
  const [decorativeEnabled, setDecorativeEnabled] = useState<boolean>(true);

  /** 档位重挂载遮罩：把重建期间的空白藏进一次"呼吸" */
  const [tierMaskVisible, setTierMaskVisible] = useState<boolean>(false);

  /** WebGL 上下文是否已丢失 */
  const [contextLost, setContextLost] = useState<boolean>(false);

  /** 上下文丢失后 15s 仍未恢复 */
  const [contextRestoreFailed, setContextRestoreFailed] = useState<boolean>(false);

  /** 上下文恢复计数：自增作为 Canvas 的 key 触发重挂载 */
  const [canvasRemountKey, setCanvasRemountKey] = useState<number>(0);

  /** 上下文丢失超时计时器 */
  const contextLostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 上下文丢失/恢复事件处理器（供卸载时精确移除） */
  const glContextHandlersRef = useRef<{
    canvas: HTMLCanvasElement | null;
    onLost: ((event: Event) => void) | null;
    onRestored: (() => void) | null;
  }>({ canvas: null, onLost: null, onRestored: null });

  /** glDebug 哨兵定时器 */
  const glDebugTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * 首帧静态快照（dataURL）。
   *
   * 【用途】上下文丢失时把这张图贴在 canvas 位置，让评委看到的是
   * "冻结的最后一帧 + 提示条"，而不是一块空白。
   *
   * 【只存内存、不落盘】它是纯展示兜底：刷新页面即失效，也不该进
   * localStorage —— 一张 200KB 的 base64 塞进持久化会撑爆配额，
   * 且它没有跨会话价值。
   */
  const [snapshotDataUrl, setSnapshotDataUrl] = useState<string | null>(null);

  /** 快照是否已尝试抓取（只抓一次，避免每次 onCreated 重复开销） */
  const snapshotCapturedRef = useRef<boolean>(false);


  /**
   * 是否启用「重后处理链路」（EffectComposer Bloom + 镜面反射地面）。
   *
   * 【为什么必须做能力探测】实测在软件光栅化（SwiftShader / llvmpipe）环境下，
   * 「Bloom 的多级 mip 链 + MeshReflectorMaterial 的独立 RT + 新增地面几何」
   * 三者叠加会让整帧静默输出**全黑**——不抛异常、不打日志，
   * 只是画不出来。这类失败在真机 GPU 上通常不存在，
   * 但对无 GPU 的 CI / 远程桌面 / 虚拟化环境是必现的。
   *
   * 【策略】探测 unmasked renderer 字符串：命中 SwiftShader / Software /
   * llvmpipe / Mesa OffScreen 等关键字时，降级为"直接渲染"，
   * 保留全部几何与材质（场景内容不减），只关掉后处理链与实时反射。
   * 这样任何环境下都能看到画面，真实 GPU 上仍是完整电影感。
   */
  /**
   * L8：把原单一开关拆成两条独立链路。
   *
   * - postEnabled：Bloom + ToneMapping + Vignette 后处理链；
   * - reflectorEnabled：镜面反射地面（整场景再渲染一遍）。
   * 软渲染下两者都关（HDR Bloom 的 halffloat RT 在 SwiftShader 上会静默黑屏），
   * 但几何/材质/灯光保持不变——画面内容不减，只是去掉重后处理。
   */
  const [envCaps] = useState(detectRenderCapabilities);
  const [postEnabled, setPostEnabled] = useState<boolean>(!envCaps.software);
  const [reflectorEnabled, setReflectorEnabled] = useState<boolean>(!envCaps.software);

  /** R24：自适应曝光 Effect 实例（Composer 路径下由 ExposureDriver 驱动） */
  const exposureEffectRef = useRef<ExposureEffectHandle | null>(null);

  /** R27：T3 景深 Effect 实例（T2/T1/T0 不挂载、不分配） */
  const dofEffectRef = useRef<DepthOfFieldEffect | null>(null);

  /* R29 F：质量档位（非持久化）+ 自动治理（2Hz 采样、带迟滞与冷却） */
  const qualityTier = useQualityStore((state): number => state.tier);
  useQualityGovernor();

  /*
   * R30：质量档位 → 渲染开关（手动 ?quality= 或治理器自动）。
   * 降档顺序（先反射 → 再阴影 → 再 Bloom → 最后后处理全关）：
   *   T3：全开；T2：关 DoF；T1：再关阴影/反射、Bloom 降级；
   *   T0：后处理全关。
   * 【R01】只改开关与参数，绝不改 DPR / RenderTarget 尺寸。
   */
  const qualityPost = postEnabled && qualityTier > 0;
  const qualityReflector = reflectorEnabled && qualityTier >= 2;
  const qualitySoftShadows = envCaps.software ? 'basic' : qualityTier >= 2 ? 'soft' : false;
  const qualityBloomLevels = qualityTier >= 3 ? 6 : qualityTier === 2 ? 5 : 4;
  const qualityBloomIntensity = qualityTier >= 3 ? 0.72 : qualityTier === 2 ? 0.66 : 0.6;

  /**
   * R24 追问 3：把"当前渲染路径 + 原因"写入瞬态轨。
   *
   * HUD（Shift+P）以 250ms 轮询 DOM 直写方式显示，零重渲染；
   * 评委因此能直接看到是否发生降级、为什么降级，而不是靠猜。
   */
  useEffect((): void => {
    const tier = !qualityPost ? 'T0' : RENDER_TIER;
    const reason = envCaps.software
      ? '软件光栅化（WebGL2 + half-float + renderer 探测命中）：后处理与反射均关闭'
      : !envCaps.webgl2
        ? 'WebGL2 不可用：降级为兜底路径'
        : !envCaps.halfFloat
          ? '缺少 EXT_color_buffer_half_float：HDR 后处理 RT 不可用'
          : postEnabled
            ? `Composer 路径（${RENDER_QUALITY_TIER} 档，${RENDER_TIER}）`
            : '兜底路径：运行时关闭后处理链';
    telemetryTransientRef.glStats.renderTier = tier;
    telemetryTransientRef.glStats.renderReason = reason;
  }, [qualityPost, postEnabled, envCaps, qualityTier]);

  /**
   * L11：渲染路径一致性对比钩子（仅开发构建暴露）。
   *
   * 不做任何产品 UI：A/B 脚本通过它把同一条管线切成
   * "Composer 路径 / 兜底路径"，逐帧读取像素统计亮度/对比度/色相偏移，
   * 从而量化两条路径的观感差异，而不是靠肉眼说"差不多"。
   */
  useEffect((): (() => void) | undefined => {
    if (process.env.NODE_ENV === 'production') return undefined;
    const handle = {
      setPost: (enabled: boolean): void => setPostEnabled(enabled),
      getPost: (): boolean => postEnabled,
      getEnvCaps: (): { software: boolean; webgl2: boolean; halfFloat: boolean } => envCaps,
      getTier: (): RenderTier => RENDER_TIER,
    };
    (window as unknown as Record<string, unknown>).__KUBEVISION_RENDER__ = handle;
    return (): void => {
      delete (window as unknown as Record<string, unknown>).__KUBEVISION_RENDER__;
    };
  }, [qualityPost, postEnabled, envCaps, qualityTier]);

  /**
   * 帧率走低：只关装饰层，不动 dpr。
   *
   * dpr 变化会重建 RT；关装饰层不会。在还不确定是否持续性问题之前，
   * 优先选代价最小的手段。
   */
  const handlePerfDecline = useCallback((): void => {
    setDecorativeEnabled(false);
  }, []);

  /**
   * 帧率恢复：只恢复装饰层。
   *
   * 刻意不回升 dpr——回升意味着又一次 RT 重建，且"刚降就升"会在性能临界点
   * 形成每分钟两次的抖动，正是本轮要消灭的稳定性问题。
   */
  const handlePerfIncline = useCallback((): void => {
    setDecorativeEnabled(true);
  }, []);

  /**
   * 设备能力兜底：把 dpr 锁到 1.0（只降一次）。
   *
   * 【三重闸门】路演期间冻结 / 次数上限 / 冷却窗口。
   *
   * 【为何用 getDemoDirectorSnapshot 而非 useDemoDirector】这里只需要"当下这一刻"
   * 的值。订阅会让画布在每次路演进度心跳（约 8Hz）时重渲染，带来真实的 R3F
   * 树比对开销。取值而非订阅，是性能与正确性的正确取舍。
   */
  const handlePerfFallback = useCallback((): void => {
    if (getDemoDirectorSnapshot().status !== 'idle') return;

    const now = Date.now();
    const state = dprAdjustRef.current;
    if (state.count >= DPR_ADJUST_MAX_TIMES) return;
    if (now - state.lastAt < DPR_ADJUST_COOLDOWN_MS) return;

    dprAdjustRef.current = { count: state.count + 1, lastAt: now };
    setAdaptiveDpr((prev): number => {
      const next = Math.max(DPR_FLOOR, Math.round((prev - 0.25) * 100) / 100);
      return next;
    });
  }, []);

  /**
   * 档位重挂载遮罩。
   *
   * 重挂载会销毁并重建 WebGL 资源，中间有 1~2 帧空白；200ms 淡入淡出把它
   * 藏成一次"呼吸"，而不是一次可见的闪烁。
   */
  useEffect((): (() => void) => {
    setTierMaskVisible(true);
    const timer = setTimeout((): void => {
      setTierMaskVisible(false);
    }, TIER_REMOUNT_MASK_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [qualityPost, postEnabled, qualityReflector, qualityTier]);


  /**
   * 当前视角预设高亮跟踪（本地 UI 状态）。
   *
   * 【订阅总线而非自记】工具条按钮与 viewPresetBus 的其他派发方
   * （未来的快捷键/顶栏按钮）共享同一状态源：订阅总线回写 activePreset，
   * 保证无论从哪个入口触发预设，两枚按钮的高亮永远与相机实际飞行目标一致。
   * 选中实体（机架/Pod 特写）会使预设高亮失效——特写机位不属于任何预设，
   * 故订阅选中态变更时清空高亮。
   */
  const [activePreset, setActivePreset] = useState<ViewPresetKey | null>('overview');
  useEffect(() => {
    return subscribeViewPreset((preset): void => {
      setActivePreset(preset);
    });
  }, []);
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  useEffect(() => {
    // 选中任意实体 → 相机飞向实体特写，预设高亮熄灭
    if (selectedEntityId !== null) setActivePreset(null);
  }, [selectedEntityId]);

  /* ---- 工具条回调 ---- */
  const handleOverview = useCallback((): void => {
    dispatchViewPreset('overview');
  }, []);

  const handleTopDown = useCallback((): void => {
    dispatchViewPreset('topdown');
  }, []);

  const handleTogglePatrol = useCallback((): void => {
    setOrbitPatrolActive(!isOrbitPatrolActive);
  }, [isOrbitPatrolActive, setOrbitPatrolActive]);

  /**
   * handleCaptureDiagnose —— 3D 视口多模态快照诊断（契约链路）。
   *
   * 【核心流转】
   * 1. document.querySelector('canvas')?.toDataURL('image/jpeg', 0.8)
   *    读取当前 3D 帧（gl.preserveDrawingBuffer=true 是本调用的生效前提）；
   * 2. setCapturedViewport(dataUrl) 存入 Store（非持久化字段——DataURL 可达
   *    数 MB，partialize 白名单刻意排除，防 localStorage 配额击穿）；
   * 3. triggerQuickPrompt(固定诊断指令) 唤醒 Copilot：桌面端切页签、
   *    移动端联动切视图（Store 双联动契约）；
   * 4. 终端审计行记录快照体积（KB），供答辩演示「取图→送诊」链路可追溯。
   *
   * 【防御】canvas 不存在或 toDataURL 抛错（极端 WebGL 上下文丢失场景）时
   * 写 WARN 日志并中止，绝不让异常打断工具条交互。
   */
  const handleCaptureDiagnose = useCallback((): void => {
    try {
      const canvas = document.querySelector('canvas');
      const dataUrl = canvas?.toDataURL('image/jpeg', SNAPSHOT_JPEG_QUALITY);
      if (dataUrl === undefined || dataUrl.length === 0) {
        appendTerminalLog('[WARN] viewport snapshot failed: canvas unavailable');
        return;
      }
      setCapturedViewport(dataUrl);
      triggerQuickPrompt(MULTIMODAL_DIAGNOSIS_PROMPT);
      const sizeKb = Math.round((dataUrl.length * 0.75) / 1024);
      appendTerminalLog(
        `[EDGE-WASM] viewport snapshot captured -> jpeg@0.8 (${sizeKb} KB base64) -> multimodal diagnosis dispatched to Copilot`,
      );
    } catch {
      appendTerminalLog('[ERR] viewport snapshot failed: WebGL context unavailable');
    }
  }, [appendTerminalLog, setCapturedViewport, triggerQuickPrompt]);

  /* ---- 机架模型数据源：低频轨订阅节点实体数组（快照整体替换才重渲染；
     WorkerRack3D 是纯展示层，数据获取职责收敛在本父级，保持单向数据流） ---- */
  const nodes = useClusterStore((s): readonly WorkerNodeEntity[] => s.snapshotSummary.nodes);

  /**
   * 卸载清理：移除 WebGL 上下文监听与所有探针定时器。
   *
   * 【为什么必须显式移除】canvas 元素可能被子组件复用于新挂载；若旧监听
   * 仍在，重挂载后会同时存在两套处理器，contextrestored 会触发两次
   * canvasRemountKey 自增，导致无限重挂载。
   */
  useEffect((): (() => void) => {
    return (): void => {
      const handlers = glContextHandlersRef.current;
      if (handlers.canvas !== null && handlers.onLost !== null) {
        handlers.canvas.removeEventListener('webglcontextlost', handlers.onLost, false);
      }
      if (handlers.canvas !== null && handlers.onRestored !== null) {
        handlers.canvas.removeEventListener('webglcontextrestored', handlers.onRestored, false);
      }
      glContextHandlersRef.current = { canvas: null, onLost: null, onRestored: null };
      if (contextLostTimerRef.current !== null) {
        clearTimeout(contextLostTimerRef.current);
        contextLostTimerRef.current = null;
      }
      if (glDebugTimerRef.current !== null) {
        clearInterval(glDebugTimerRef.current);
        glDebugTimerRef.current = null;
      }
    };
  }, []);

  return (
    /*
     * 【兜底背景】容器自带一层与场景同色的 CSS 背景。
     * canvas 透明/丢失/首帧未到时，用户看到的是深空色而不是纯黑。
     */
    <div
      /*
       * 【aria-label 的双重用途】
       * 1. 无障碍：屏幕阅读器把整块 3D 拓扑识别为"3D 集群拓扑视口"；
       * 2. 组件寻址：顶栏字幕条要"居中于视口而非全屏"，它靠这个选择器量
       *    getBoundingClientRect；导演引擎的启动预检（G 项）也靠它判断视口
       *    是否已挂载。缺了它字幕条定位与预检会双重失效。
       */
      aria-label="3D 集群拓扑视口"
      className="absolute inset-0"
      ref={containerRef}
      style={{ background: VOID_FALLBACK_COLOR }}
    >
      <Canvas
        key={`canvas-${canvasRemountKey}`}
        /**
         * 【自适应 DPR 契约】dpr 由状态驱动而非写死：
         * - 正常态 [1, 2]：高分屏享受 2x 清晰度；
         * - 持续低帧率（<40FPS）时被 PerformanceMonitor 下调至 1.0，
         *   牺牲清晰度换回流畅度——掉帧对交互的伤害远大于分辨率下降。
         * 这个降级是**单向保守**的：一旦降下来，只有帧率稳定回升才会恢复，
         * 避免在临界点反复横跳造成视觉抖动。
         */
        dpr={[DPR_FLOOR, adaptiveDpr]}
        /**
         * 【实时软阴影】`shadows="soft"` 让 three 使用 PCFSoft 阴影贴图过滤：
         * 硬边阴影在机柜这种大面积几何上会显出锯齿与"剪纸感"，
         * 软边才能让机架真正"压"在地面上。代价是每帧一次阴影贴图渲染，
         * 但场景只有 3 座机架 + 48 个实例，绝对开销可控。
         */
        shadows={qualitySoftShadows}
        camera={{ position: INITIAL_CAMERA_POSITION, fov: CAMERA_FOV }}
        gl={{
          /* L4：Composer 路径下 canvas MSAA 无效（离屏 RT 才是最终画面），关掉省带宽 */
          antialias: !qualityPost,
          powerPreference: 'high-performance',
          // 多模态视觉快照前提：帧合成后仍可 toDataURL 读取绘制缓冲
          preserveDrawingBuffer: true,
        }}
        /**
         * 【视口休眠契约】页面切到后台或画布滚出视口时，
         * frameloop 切到 'demand'（仅在需要时渲染），
         * 彻底停止每帧 draw call——这是最大的省电杠杆。
         * 切回时立即恢复 'always'，用户无感。
         */
        frameloop={isSceneActive ? 'always' : 'demand'}
        onCreated={(state): void => {
          /*
           * 能力探测：识别软件光栅化并关掉重后处理链。
           *
           * 【为何在 onCreated 里做】此时 WebGL 上下文已就绪，可读到
           * unmasked renderer 字符串；R3F 的 state.gl 即真实上下文。
           * 探测失败（无 debug 扩展）时保持默认开启，不做误降级。
           */
          const context = state.gl.getContext();
          const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
          const rendererName =
            debugInfo === null
              ? ''
              : String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '');
          const isSoftware =
            /swiftshader|software|llvmpipe|mesa offscreen|basic render/i.test(rendererName);
          if (isSoftware || !envCaps.webgl2 || !envCaps.halfFloat) {
            setPostEnabled(false);
            setReflectorEnabled(false);
          }
          /*
           * ---- WebGL 上下文丢失恢复 ----
           *
           * 【为什么不只是显示提示】上下文丢失后 three 的所有 GPU 资源（纹理、
           * FBO、program）都已失效，即便 contextrestored 事件到来，R3F 内部的
           * 资源缓存也不会自动重建。可靠做法是**整体重挂载** Canvas：
           * 通过 canvasRemountKey 自增改变 key，让 React 抛掉整棵 3D 树重建。
           *
           * 【为什么必须 preventDefault】默认行为下浏览器不会尝试恢复上下文。
           * 只有显式 preventDefault，才会在后续派发 webglcontextrestored。
           */
          /* L1：固定曝光；后处理链负责 Neutral ToneMapping，渲染器本身关闭 tone mapping */
          if (postEnabled) {
            state.gl.toneMapping = NoToneMapping;
          } else {
            /* L11：兜底路径用渲染器内置 Neutral tone mapping 对齐色相 */
            state.gl.toneMapping = NeutralToneMapping;
          }
          state.gl.toneMappingExposure = TONEMAP_EXPOSURE;
          /* L8：软渲染锁 DPR=1.0（只降一次，且不参与后续自适应升回） */
          if (isSoftware) {
            setAdaptiveDpr(1);
          }
          const canvasEl = state.gl.domElement;
          const onContextLost = (event: Event): void => {
            event.preventDefault();
            setContextLost(true);
            setContextRestoreFailed(false);
            /* G 项：把 GL 上下文状态同步进 store，供启动预检读取 */
            useClusterStore.getState().setGlContextLost(true);
            if (contextLostTimerRef.current !== null) {
              clearTimeout(contextLostTimerRef.current);
            }
            contextLostTimerRef.current = setTimeout((): void => {
              setContextRestoreFailed(true);
            }, CONTEXT_RESTORE_TIMEOUT_MS);
          };
          const onContextRestored = (): void => {
            if (contextLostTimerRef.current !== null) {
              clearTimeout(contextLostTimerRef.current);
              contextLostTimerRef.current = null;
            }
            setContextLost(false);
            setContextRestoreFailed(false);
            useClusterStore.getState().setGlContextLost(false);
            setCanvasRemountKey((prev): number => prev + 1);
            useClusterStore.getState().appendTerminalLog('[GL] context restored');
          };
          canvasEl.addEventListener('webglcontextlost', onContextLost, false);
          canvasEl.addEventListener('webglcontextrestored', onContextRestored, false);
          glContextHandlersRef.current = { canvas: canvasEl, onLost: onContextLost, onRestored: onContextRestored };

          /*
           * ---- ?glDebug=1 NaN / 黑屏哨兵（开发探针，不进生产默认路径）----
           *
           * 【为什么放在 setInterval 而不是 useFrame】useFrame 内做 readPixels
           * 会强制同步等待 GPU 管线刷新，等于把帧率打回个位数。500ms 一次
           * 的旁路采样对渲染几乎无影响，且足以捕获"稳定黑屏"这种持续性故障。
           *
           * 【为什么只有 1×1】readPixels 是 GPU→CPU 同步读取，面积越大越慢。
           * 取画布中心 1 像素：那里是控制平面晶体，正常情况下必然有亮度，
           * 一旦长期为 0 就说明整条渲染链已经失效。
           */
          if (typeof window !== 'undefined') {
            const glDebugOn = new URLSearchParams(window.location.search).get('glDebug') === '1';
            if (glDebugOn && glDebugTimerRef.current === null) {
              let blackStreak = 0;
              const probeGl = state.gl;
              glDebugTimerRef.current = setInterval((): void => {
                try {
                  const ctx = probeGl.getContext();
                  if (ctx.isContextLost()) return;
                  const w = probeGl.domElement.width;
                  const h = probeGl.domElement.height;
                  if (w === 0 || h === 0) return;
                  const px = new Uint8Array(4);
                  ctx.readPixels(
                    Math.floor(w / 2),
                    Math.floor(h / 2),
                    1,
                    1,
                    ctx.RGBA,
                    ctx.UNSIGNED_BYTE,
                    px,
                  );
                  const luma = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
                  if (luma < GL_DEBUG_LUMA_THRESHOLD) {
                    blackStreak += 1;
                    if (blackStreak >= GL_DEBUG_BLACK_LIMIT) {
                      const snapshot = useClusterStore.getState();
                      console.error('[GL-BLACKOUT]', {
                        luma,
                        streak: blackStreak,
                        activeChaos: snapshot.activeChaos,
                        selectedEntityId: snapshot.selectedEntityId,
                        connectionMode: snapshot.connectionMode,
                        health: snapshot.snapshotSummary.clusterHealthScore,
                        ctxLost: ctx.isContextLost(),
                      });
                      blackStreak = 0;
                    }
                  } else {
                    blackStreak = 0;
                  }
                } catch {
                  /* 探针自身异常不应影响渲染 */
                }
              }, GL_DEBUG_SAMPLE_MS);
            }
          }

          /*
           * ---- 首帧静态快照（兜底展示）----
           *
           * 【为什么延迟 12 帧】onCreated 触发时场景刚装配完，相机可能还在
           * 初始飞行动画里。此时 toDataURL 会拍到一张"斜的/空的"画面，
           * 作为兜底反而更糟。等 12 帧后画面基本稳定。
           *
           * 【为什么能 toDataURL】Canvas 的 gl 配置里已有
           * preserveDrawingBuffer: true（多模态快照的前提），因此任何时刻
           * 都能读到绘制缓冲。
           *
           * 【体积闸门】超过 200KB 直接放弃：兜底图不值得为它冒内存风险。
           */
          if (!snapshotCapturedRef.current) {
            snapshotCapturedRef.current = true;
            let framesLeft = SNAPSHOT_SETTLE_FRAMES;
            const captureOnFrame = (): void => {
              framesLeft -= 1;
              if (framesLeft > 0) {
                requestAnimationFrame(captureOnFrame);
                return;
              }
              try {
                const dataUrl = state.gl.domElement.toDataURL('image/png');
                /* base64 膨胀约 4/3，用长度反推原始字节数 */
                const approxBytes = Math.floor((dataUrl.length * 3) / 4);
                if (dataUrl.startsWith('data:image/png') && approxBytes <= SNAPSHOT_MAX_BYTES) {
                  setSnapshotDataUrl(dataUrl);
                }
              } catch {
                /* toDataURL 失败不影响渲染，只是没有兜底图 */
              }
            };
            requestAnimationFrame(captureOnFrame);
          }

          handleCanvasCreated(state);

        }}
        onPointerMissed={(): void => {
          selectEntity(null);
        }}
      >
        {/* ---- 性能监控：帧率持续低于 40FPS 时下调 dpr 至 1.0 ---- */}
        <PerformanceMonitor
          onDecline={handlePerfDecline}
          onIncline={handlePerfIncline}
          flipflops={3}
          onFallback={handlePerfFallback}
        />

        {/* ---- WebGL 指标采集探针（无渲染，每 500ms 写入瞬态轨） ---- */}
        <GlStatsCollector />

        {/* R29 B：开场编排唯一推进者（uBoot 0→1，1.2s） */}
        <BootController />

        {/* ---- R24：自适应曝光驱动（≤4Hz 估计亮度、每帧阻尼插值） ---- */}
        <ExposureDriver effectRef={exposureEffectRef} />

        {/* ---- R27：T3 景深焦点阻尼跟随（T2/T1/T0 完全不渲染） ---- */}
        {postEnabled && RENDER_TIER === 'T3' && qualityTier >= 3 ? (
          <DofFocusDriver effectRef={dofEffectRef} />
        ) : null}

        {/* ---- 深空氛围：背景色 + 线性雾 ---- */}
        <color attach="background" args={[VOID_COLOR]} />
        <fog attach="fog" args={[VOID_COLOR, FOG_NEAR, FOG_FAR]} />

        {/* ---- 赛博影棚三点布光（R62 能量预算校准） ----
         *
         * 【为何整体下调】R62 地面反射过曝的根因之一是"PBR 环境贴图 + 三盏灯"
         * 能量叠加：RoomEnvironment 的亮白顶棚与 8 根 3.2x HDR 灯带已经提供了
         * 基础照明，旧值 2.3 / 0.95 / 28 属于"没有环境贴图时代"的补光量级，
         * 叠在一起会把金属地面推成惨白。现在按深空黑曜石场景重新配比：
         *   环境 0.28：保证暗部不死黑；
         *   半球 0.45：保留顶盖的青蓝天光方向性；
         *   主光 1.10：仍可投出清晰阴影，但不再压过状态色；
         *   轮廓光 0.45：只勾背光侧金属棱角；
         *   中心点光 6.5 / distance 22：控制平面附近局部提亮，不再照亮整片地面。
         */}
        <ambientLight intensity={0.28} color="#94a3b8" />
        <hemisphereLight args={['#38bdf8', '#020617', 0.45]} />
        <directionalLight
          castShadow
          position={[12, 24, 14]}
          intensity={1.1}
          color="#eaf4ff"
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-13}
          shadow-camera-right={13}
          shadow-camera-top={13}
          shadow-camera-bottom={-13}
          shadow-bias={-0.0005}
          shadow-normalBias={0.02}
        />
        {/* 侧逆轮廓光：只勾勒背光侧金属棱角，不参与阴影计算（省一次阴影渲染） */}
        <directionalLight position={[-14, 12, -10]} intensity={0.45} color="#22d3ee" />
        {/* 控制平面中心点光：R62 由 28 降到 6.5，distance 收到 22，避免整片地面被点亮 */}
        <pointLight position={[0, 3.0, 0]} intensity={6.5} distance={22} decay={2} color="#22d3ee" />

        {/*
         * ---- 地面接触阴影（Contact Shadows）----
         *
         * 【为什么需要它】实时阴影贴图在"物体与地面贴合处"分辨率不足，
         * 机架底部会漏出一道亮缝，看起来像悬浮在空中——这是 3D 场景
         * 最廉价的一种失真。ContactShadows 用一张独立的正交深度图专门
         * 烘焙贴合处，把接地点压黑，物体瞬间"站稳"。
         *
         * 【frames={1} 是性能关键】只在首帧烘焙一次，之后零每帧开销。
         * 机架与中心晶体都是静态几何，只有 Pod 会动——而它们离地很远，
         * 不会影响接地阴影的正确性。这是"静态阴影资产"而非动态阴影。
        * 【Y 轴层级契约（本轮修正）】
         * 地面现在叠了四层半透明结构，必须严格定序，否则透明面片会
         * z-fighting 闪烁、且接触阴影会把发光数码环压暗：
         *   −0.025  MeshReflectorMaterial 反射地面（最底，承托一切）
         *   −0.020  外层大网格（远景坐标网，infiniteGrid）
         *    0.004  内层细网格（近景坐标网，蚀刻在镜面上的质感）
         *    0.008  ContactShadows 接触阴影面片
         *    0.014  ClusterTopologyFloor3D 数码阵环（发光层，最高）
         *
         * 关键修正：ContactShadows 原在 0.02，**高于**拓扑环的 0.014，
         * 于是阴影面片反过来盖在发光环上——既与环共面造成 z-fighting 闪烁，
         * 又用黑色半透明把环压暗。下移到 0.008 后，阴影永远在环之下，
         * 只压暗网格与地面，发光环保持通透。
         *
         * 同时把 opacity 从 0.68 降到 0.5：镜面地面上阴影过重会形成一块
         * 死黑泥斑，反而破坏"通透的反射感"。
         */}
        {envCaps.software ? null : (
          <ContactShadows
            position={[0, 0.008, 0]}
            opacity={0.55}
            scale={34}
            blur={1.6}
            far={8}
            resolution={768}
            frames={1}
            color="#000000"
          />
        )}

        {/* ---- 黑曜石镜面反射地面（图五空间纵深感的核心）----
         *
         * 【解决什么】此前地面只有网格、没有任何反射，场景是"悬在虚空里"的：
         * 缺少上下镜像关系，纵深立刻扁平。参考图的深邃感来自
         * **地面把机架、八面体与星环柔和地倒映下去**。
         *
         * 【参数依据（R62 黑曜石配比）】
         * - blur [360, 120]：长轴大幅模糊 → 倒影是柔和渗影而非镜面复刻；
         * - mixStrength 0.42 / mirror 0.28：反射克制，过强会抢戏；
         * - roughness 0.72 + metalness 0.45：黑曜石半哑光金属釉面；
         * - envMapIntensity=0：切断 RoomEnvironment 亮白顶棚反射（过曝根因）；
         * - depthScale + min/maxDepthThreshold：按深度衰减，
         *   近处清晰、远处迅速沉入深色，避免远处倒影堆叠成噪点。
         *
         * 【Y = −0.025】低于两层 Grid（−0.02 / +0.01），
         * 于是网格像蚀刻在镜面上层的坐标网，而非浮在反射之上。
         */}
        {/* L8：镜面反射地面独立开关（软渲染下整段关闭，省一次全场景重渲染） */}
        {qualityReflector ? (
        <mesh
          key={`reflector-${canvasRemountKey}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -0.025, 0]}
          receiveShadow
        >
          {/* R25：地面圆盘半径 32 → 22；边缘由 GroundHorizonFade 在 r∈[13,22] 吞没 */}
          <circleGeometry args={[22, 96]} />
          <MeshReflectorMaterial
            blur={[360, 120]}
            resolution={512}
            mixBlur={0.9}
            mixStrength={0.42}
            roughness={0.72}
            depthScale={1.1}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.4}
            color="#030712"
            metalness={0.45}
            mirror={0.28}
            /*
             * R62 关键修复：显式切断对 scene.environment 的采样。
             * ProceduralPbrEnvironment 把环境设为 RoomEnvironment（亮白顶棚 +
             * 8 根 3.2x HDR 灯带）；金属地面若继续采样 envMap，会把白棚
             * 直接反射成相机左下方（worker-beta 脚下）的一片惨白高光。
             * envMapIntensity=0 后地面只显示真实的 3D 集群倒影（tDiffuseBlur）
             * 与 #030712 黑曜石底色。
             */
            envMapIntensity={0}
          />
        </mesh>
        ) : null}

        {/* ---- 赛博极客双层地面网格（蚀刻在镜面上的坐标网）----
          下层（y=-0.020）：大尺度粗格延伸至雾效远端，构建深空坐标系纵深；
          上层（y=+0.004）：小尺度细格聚焦中心作战区。
          两者与反射地面（−0.025）、接触阴影（0.008）、拓扑环（0.014）
          共同构成 5 级非重叠 Y 顺序（详见上方层级契约注释）。
          【本轮调整】线宽与对比度双双调低——地面已是反光材质，
          网格若太亮会与倒影争视觉权重，变成"两张网"的噪音。 */}
        {/* R25：删除延伸到 r≈86 的外层大网格（地平线的主要来源） */}
        {/*
       * R25：内层细网格收窄到 r≈13 内（fadeDistance 13），
       * 超过 14 单位不再有可见地面装饰——地平线由 GroundHorizonFade 吞没。
       */}
      <Grid
        position={[0, 0.004, 0]}
        args={[26, 26]}
        cellSize={1.4}
        cellThickness={0.22}
        cellColor="#0b272f"
        sectionSize={6}
        sectionThickness={0.5}
        sectionColor="#115564"
        fadeDistance={13}
        fadeStrength={1.6}
      />

        {/* R25：地面径向渐隐（r∈[13,22] 与背景 #020611 无缝衔接） */}
        <GroundHorizonFade />

        {/* ---- 双层深空飞散光粒子场（Dual-Layer Sparkles）----
          第一层贴地环绕（粗亮、快）复刻光圈周围飞散的星尘；
          第二层中空光束区（细小、慢、绿）表现能量逸散。
          两层尺度/速度/颜色都不同，才有"近亮远淡"的景深层次。 */}
        {decorativeEnabled ? (
          <Sparkles count={140} scale={[24, 2.5, 24]} size={1.6} speed={0.35} color="#38bdf8" position={[0, 1.2, 0]} opacity={0.75} />
        ) : null}
        {decorativeEnabled ? (
          <Sparkles count={90} scale={[22, 10, 22]} size={1.1} speed={0.2} color="#10b981" position={[0, 5.0, 0]} opacity={0.45} />
        ) : null}

        {/*
         * ---- 远景深空数字矩阵雨光幕 ----
         *
         * 半径 28 的背向圆柱内壁，完全包裹整个场景的远景天际线。
         * 它填补的是"上半部死黑"：在没有它之前，机柜与晶核之上什么都没有，
         * 画面纵深被硬生生截断；有了这层若隐若现的垂直光滴，
         * 背景才读得出"机器背后是一整套数据洪流"。
         *
         * 【层级】挂载在场景根、所有前景物体外侧，且 depthWrite=false
         * + 加色混合，因此它只往天空加光，绝不遮挡任何主体。
         * 【不透明度】着色器末端统一乘 uOpacity（常态 0.075 / 故障态 0.115），
         * 保证它永远是氛围层而不是与主体争视觉权重的第二主角。
         */}
        {decorativeEnabled ? <CyberMatrixRain3D /> : null}

        {/*
         * ---- 程序化 PBR 环境反射（零外链 HDR）----
         *
         * RoomEnvironment 是 three 自带的程序化"摄影棚"场景，
         * 经 PMREMGenerator 预滤波后注入 scene.environment。
         * 机架立柱、刀片装甲、晶核切角因此获得真实的冷金属镜面高光，
         * 且**不发起任何 .hdr 网络请求**（离线可跑、零 CDN 依赖）。
         * 组件自身返回 null，不产生绘制对象，只做一次性资源装配与释放。
         */}
        <ProceduralPbrEnvironment />

        {/* ---- MASTER 控制平面全息模型（锚定 [0,2.5,0]，可点击选中 → 鸟瞰复位） ---- */}
        <MasterNode3D />

        {/* ---- 三台 Worker 机架程序化模型（磨砂装甲/托盘隔板/霓虹导光柱/全息铭牌；
           位姿由 getRackTransform(node.rackIndex) 解算，与 Pod 槽位坐标同源） ---- */}
        {nodes.map((node): ReactNode => (
          <WorkerRack3D key={node.id} node={node} />
        ))}

        {/* ---- Pod 容器实例渲染器（单 Draw Call InstancedMesh ×48 容量；
           每帧从瞬态池读取状态/CPU 负载驱动四态动画，落座隔板插槽零穿模） ---- */}
        <PodInstancedMesh />

        {/* ---- 地面拓扑星环：主轨道 + 控制平面内环 + 三道径向电路 ----
           让机架"站在轨道上"而非漂浮在无限网格里（蓝图 §1.6）。
           故障机架对应的那道径向电路会切为绯红，形成空间级告警。 */}
        <ClusterTopologyFloor3D />

        {/* ---- 集群网络通信流（MASTER→三机架拱形贝塞尔光缆 + 54 个流动数据包；
           吞吐驱动推进速率，故障车道切换警示红并断续卡顿） ---- */}
        <NetworkStream3D />
        {/* R28：回程粒子（机架→控制平面，淡蓝；Pod 异常时缺失，传达"响应回不来"） */}
        <ReturnStream3D />
        {/* R25：三条弧线起点的 0.15s 汇聚光斑（能量从晶体赤道抽出，而非插在空中） */}
        <ArcStartGlow3D />

        {/* R28：低档位（无镜面反射）时的机架底部近场反射带，替代真实反射 pass */}
        {qualityReflector ? null : <RackGroundReflection />}

        {/* ---- 机架故障警示涟漪（仅故障机架激活：崩溃 Pod 或节点非 Ready；
           自定义 ShaderMaterial 三环由内向外扩散，加色混合贴地辉光） ---- */}
        <ErrorRippleRing />

        {/* ---- 选中 Pod 的空间锁定光环（审查报告 §2.4）----
           机架与 Master 各有自己的选中视觉，但单个 Pod 此前完全没有——
           推近特写后同层 4 个方块挤在画面中心，用户分不清探针面板指的是哪颗。
           该标记绘制包围框 + 刻度环 + 指示杆，与巡检面板形成「数据 <-> 空间」指认闭环。 */}
        <SelectionBeacon3D />

        {/* ---- 相机运镜系统 ---- */}
        <CameraRig />

        {/*
         * ---- 后处理：Bloom 泛光 + Vignette 暗角 ----
         *
         * 【解决什么】场景里大量发光体（等离子星核、能量束、光斑、光纤脉冲）
         * 用的是 AdditiveBlending + toneMapped=false，它们的亮度值**超过 1**，
         * 但没有后处理时这些超亮像素只是在屏幕上直接截断成纯色，
         * 缺少"光溢出到邻近像素"的物理现象——这正是图五那种电影感的核心。
         * Bloom 把超过阈值的能量取样模糊后加回画面，光才真正"溢"出来。
         *
         * 【参数依据（R62 校准）】
         * - luminanceThreshold 0.92：只有真正高光（星核顶点 / 能量束核心 /
         *   星尘粒子）才溢出，浅色 UI 线与地面反射不再触发辉光；
         * - luminanceSmoothing 0.28：阈值边缘柔和过渡，消灭硬切边界；
         * - mipmapBlur + radius 0.45 + levels 5：光晕更紧、更克制，不吞细节；
         * - intensity 0.48：保住状态色语义（红/绿/琥珀可分辨），
         *   又不会把暗部整体提亮成灰雾。
         *
         * 【Vignette】暗角 0.35 让视线自然收拢到画面中心的三环布局，
         * 这是参考图构图感的来源之一。
         *
         * 【性能】multisampling=0 + disableNormalPass：本场景已用
         * canvas 的 antialias 与 DPR 控制画质，后处理链不重复 MSAA；
         * 本版本 EffectComposer 无 disableNormalPass 选项，法线通道关闭由上游 npm 版本决定。
         */}
        {/*
         * ---- 后处理链（L1–L4）----
         *
         * 【顺序固定】Bloom → ToneMapping → AA → Vignette → Noise。
         *  - Bloom 必须在 ToneMapping 之前：它处理的是**线性 HDR 能量**，
         *    先压到 LDR 再泛光会把高光信息截断；
         *  - AA 放在 ToneMapping 之后：对最终显示亮度做边缘检测更接近感知；
         *  - Vignette / Noise 放最后，只做屏幕空间修饰。
         *
         * 【ToneMappingMode.NEUTRAL】ACES 会把高饱和的绿/琥珀/绯红压灰，
         * 而运维语义色必须保色相（绿=健康、琥珀=高负载、绯红=故障）。
         * Neutral 只做线性到 sRGB 的中性映射，色相偏移最小。
         *
         * 【AA 策略】T3 = MSAA×2（禁止 ×8：HDR 8× RT > 200MB）；
         * T2 = FXAA；T1 = 不加 AA（最低端路径，DPR 已降）。
         */}
        {qualityPost ? (
          RENDER_TIER === 'T2' ? (
            <EffectComposer
              key={`composer-${canvasRemountKey}`}
              multisampling={0}
              frameBufferType={HalfFloatType}
            >
              {/*
               * R27：DoF 在 Bloom **之前**（物理顺序：失焦发生在成像面，
               * Bloom 是镜头后的光溢出）。focusRange 取大值保证前排机架与
               * 晶核都在焦内，只虚化最远节点与背景粒子。
               */}
              <DepthOfField
                ref={dofEffectRef}
                focusDistance={12}
                focalLength={0.02}
                focusRange={26}
                bokehScale={1.2}
              />
              <Bloom
                intensity={0.48}
                luminanceThreshold={0.92}
                luminanceSmoothing={0.28}
                mipmapBlur
                radius={0.45}
                levels={5}
              />
              <ExposureEffect ref={exposureEffectRef} />
              <ToneMapping mode={ToneMappingMode.NEUTRAL} />
              <FXAA />
              <Vignette eskil={false} offset={0.22} darkness={0.28} />
              <Noise opacity={0.03} />
            </EffectComposer>
          ) : (
            <EffectComposer
              key={`composer-${canvasRemountKey}`}
              multisampling={RENDER_TIER === 'T3' ? 2 : 0}
              frameBufferType={HalfFloatType}
            >
              <Bloom
                intensity={0.48}
                luminanceThreshold={0.92}
                luminanceSmoothing={0.28}
                mipmapBlur
                radius={0.45}
                levels={5}
              />
              <ExposureEffect ref={exposureEffectRef} />
              <ToneMapping mode={ToneMappingMode.NEUTRAL} />
              <Vignette eskil={false} offset={0.22} darkness={0.28} />
              <Noise opacity={0.03} />
            </EffectComposer>
          )
        ) : null}
      </Canvas>

      {/* R29 D：?glowDebug=1 时的发光预算调试浮层（开发/答辩用） */}
      <GlowDebugOverlay />

      {/*
       * ---- 上下文丢失提示条 ----
       *
       * 【层级】z-[5]：在 Canvas（z-0）之上、巡检 HUD / 抽屉（z-20 起）之下，
       * 与光学暗角同层。pointer-events-none 保证不拦截任何交互——
       * 上下文丢了也要能继续操作 2D HUD 与右侧抽屉，这是演示兜底的前提。
       */}
      {/*
       * ---- 上下文丢失时的静态快照 ----
       *
       * z-[3]：在兜底背景之上、提示条（z-[5]）与遮罩（z-[4]）之下。
       * 用 object-cover 铺满容器，视觉上等同于"画面冻结"。
       */}
      {contextLost && snapshotDataUrl !== null ? (
        /* eslint-disable-next-line @next/next/no-img-element -- 运行时内存中的 dataURL 兜底图，无需也無法经 next/image 优化 */
        <img
          src={snapshotDataUrl}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[3] h-full w-full object-cover"
          style={{ opacity: 0.9 }}
        />
      ) : null}

      {contextLost ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-3 z-[5] flex justify-center"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 rounded px-3 py-1.5 font-mono text-[11px] tracking-tight"
            style={{
              background: contextRestoreFailed ? 'rgba(76,5,25,0.86)' : 'rgba(69,26,3,0.86)',
              border: `1px solid ${contextRestoreFailed ? 'rgba(244,63,94,0.5)' : 'rgba(251,191,36,0.45)'}`,
              color: contextRestoreFailed ? '#fecdd3' : '#fde68a',
            }}
          >
            <span
              className="block h-1.5 w-1.5 rounded-full"
              style={{ background: contextRestoreFailed ? '#f43f5e' : '#fbbf24' }}
              aria-hidden
            />
            {contextRestoreFailed
              ? '图形上下文已丢失且未能自动恢复，请刷新页面（2D 面板仍可用）'
              : '图形上下文已丢失，正在恢复…'}
          </div>
        </div>
      ) : null}

      {/* ---- 档位重挂载遮罩：200ms 淡入淡出，把 FBO 重建的空白藏起来 ---- */}
      <div
        className="pointer-events-none absolute inset-0 z-[4] transition-opacity duration-200"
        style={{
          background: '#020815',
          opacity: tierMaskVisible ? 1 : 0,
        }}
        aria-hidden
      />

      {/*
       * ---- 电影级光学暗角遮罩（DOM 层，Canvas 之上、HUD 之下）----
       *
       * 【解决什么】3D 视口与深空背景之间此前是"硬切边"：画面边缘的网格、
       * 粒子会突然终止在 DOM 容器的矩形边界上，廉价感就来自这个直角。
       * 叠加一层径向暗角后，四周亮度自然衰减、融入页面背景，
       * 视觉上形成"无限延伸的深空"而非"一个装着 3D 的矩形框"。
       *
       * 【为何用 CSS 而非后处理】Vignette 后处理只作用于 WebGL 内容本身，
       * 管不到画布与页面背景的接缝；这一层是 DOM 覆盖，正好补上那个边界。
       *
       * 【层级与穿透】pointer-events-none + z-[1]：
       * 在 Canvas（z-0）之上、巡检 HUD / 抽屉（z-20 起）之下，绝不拦截指针。
       */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(circle_at_center,transparent_62%,rgba(2,6,23,0.42)_100%)]"
      />

      {/* ---- 左上角实体巡检 HUD（DOM 层浮层，非 R3F 场景内）：
         未选中实体 → 拓扑图例 + 相机手势提示；选中 pod/node/master →
         玻璃态探针卡片（身份/状态/重启/CPU-MEM 波形/AI 诊断/隔离重启）。
         外层 pointer-events-none 保证不遮挡画布拖拽旋转，内层卡片
         pointer-events-auto 保证按钮可点（AGENTS.md 第 6 条同源原则）。 ---- */}
      <NodeInspectHUD />

      {/* ---- 右下角玻璃态相机/多模态控制工具条（DOM 层，非 R3F 场景内；
         pointer-events-auto + z-20：高于画布 Html 标注，低于 HUD/Modal） ---- */}
      <ViewportToolbar
        isOverviewActive={activePreset === 'overview'}
        isTopDownActive={activePreset === 'topdown'}
        isPatrolActive={isOrbitPatrolActive}
        hasCapturedViewport={hasCapturedViewport}
        onOverview={handleOverview}
        onTopDown={handleTopDown}
        onTogglePatrol={handleTogglePatrol}
        onCaptureDiagnose={handleCaptureDiagnose}
      />
    </div>
  );
}