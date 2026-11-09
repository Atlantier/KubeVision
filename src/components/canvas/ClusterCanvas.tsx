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
import { Canvas, type RootState } from '@react-three/fiber';
import { ContactShadows, Grid, MeshReflectorMaterial, PerformanceMonitor, Sparkles } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';

import { useClusterStore } from '@/store/useClusterStore';
import CyberMatrixRain3D from '@/components/canvas/CyberMatrixRain3D';
import ProceduralPbrEnvironment from '@/components/canvas/ProceduralPbrEnvironment';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
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
import PodInstancedMesh from '@/components/canvas/PodInstancedMesh';
import ClusterTopologyFloor3D from '@/components/canvas/ClusterTopologyFloor3D';
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
const VOID_COLOR = '#020815';

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
   * 【为何用区间步进而非二值切换】直接 2.0 ↔ 1.0 硬切会让整屏
   * 清晰度突变，用户会感到明显的"分辨率跳变"。按 0.25 步进平滑过渡，
   * 视觉上几乎察觉不到，但性能收益是逐步累积的。
   */
  const [adaptiveDpr, setAdaptiveDpr] = useState<number>(2);

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
  const [heavyRenderEnabled, setHeavyRenderEnabled] = useState<boolean>(true);

  /** 帧率走低：下调 dpr（下限 1.0） */
  const handlePerfDecline = useCallback((): void => {
    setAdaptiveDpr((prev): number => {
      const next = Math.max(1, Math.round((prev - 0.25) * 100) / 100);
      return next;
    });
  }, []);

  /** 帧率恢复：上调 dpr（上限 2.0） */
  const handlePerfIncline = useCallback((): void => {
    setAdaptiveDpr((prev): number => {
      const next = Math.min(2, Math.round((prev + 0.25) * 100) / 100);
      return next;
    });
  }, []);

  /**
   * 设备能力兜底：明显撑不住高分屏的设备（如低端集显）直接锁到 1.0。
   * drei 会在设备性能评级过低时调用本回调。
   */
  const handlePerfFallback = useCallback((): void => {
    setAdaptiveDpr(1);
  }, []);

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

  return (
    <div className="absolute inset-0" ref={containerRef}>
      <Canvas
        /**
         * 【自适应 DPR 契约】dpr 由状态驱动而非写死：
         * - 正常态 [1, 2]：高分屏享受 2x 清晰度；
         * - 持续低帧率（<40FPS）时被 PerformanceMonitor 下调至 1.0，
         *   牺牲清晰度换回流畅度——掉帧对交互的伤害远大于分辨率下降。
         * 这个降级是**单向保守**的：一旦降下来，只有帧率稳定回升才会恢复，
         * 避免在临界点反复横跳造成视觉抖动。
         */
        dpr={[1, adaptiveDpr]}
        /**
         * 【实时软阴影】`shadows="soft"` 让 three 使用 PCFSoft 阴影贴图过滤：
         * 硬边阴影在机柜这种大面积几何上会显出锯齿与"剪纸感"，
         * 软边才能让机架真正"压"在地面上。代价是每帧一次阴影贴图渲染，
         * 但场景只有 3 座机架 + 48 个实例，绝对开销可控。
         */
        shadows="soft"
        camera={{ position: INITIAL_CAMERA_POSITION, fov: CAMERA_FOV }}
        gl={{
          antialias: true,
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
          if (isSoftware) {
            setHeavyRenderEnabled(false);
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

        {/* ---- 深空氛围：背景色 + 线性雾 ---- */}
        <color attach="background" args={[VOID_COLOR]} />
        <fog attach="fog" args={[VOID_COLOR, FOG_NEAR, FOG_FAR]} />

        {/* ---- 赛博影棚三点布光（Three-Point Studio Lighting） ----
         *
         * 旧实现只有一盏环境光 + 一盏方向光 + 中心点光，结果是通体均匀照亮、
         * 没有任何明暗面——这是"塑料感"的根源：塑料正是因为缺乏方向性高光
         * 与接地阴影才显得廉价。
         *
         * 现按电影布光逻辑分三层：
         *  1) 环境基底（ambient 0.42）：保证暗部不死黑，但压得很低；
         *  2) 半球天光：天空色 #38bdf8 / 地面色 #020617——
         *     金属顶盖朝上反射深邃青蓝天光、朝下反射深空暗色，
         *     单这一盏就让顶冠从"黑塑料盖"变成"阳极氧化铝"；
         *  3) 主光（key light，投射阴影）+ 侧逆轮廓光（rim light，青蓝）
         *     + 控制平面中心点光（青色），勾出背光侧金属棱角与中心能量感。
         */}
        <ambientLight intensity={0.42} color="#94a3b8" />
        <hemisphereLight args={['#38bdf8', '#020617', 0.55]} />
        <directionalLight
          castShadow
          position={[14, 24, 14]}
          intensity={1.85}
          color="#f8fafc"
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-16}
          shadow-camera-right={16}
          shadow-camera-top={16}
          shadow-camera-bottom={-16}
          shadow-bias={-0.0005}
        />
        {/* 侧逆轮廓光：只勾勒背光侧金属棱角，不参与阴影计算（省一次阴影渲染） */}
        <directionalLight position={[-14, 12, -10]} intensity={0.65} color="#22d3ee" />
        {/* 控制平面中心点光：距离 28 / 衰减 2，覆盖三座机架环域 */}
        <pointLight position={[0, 3.0, 0]} intensity={36} distance={28} decay={2} color="#22d3ee" />

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
        <ContactShadows
          position={[0, 0.008, 0]}
          opacity={0.5}
          scale={34}
          blur={2.2}
          far={8}
          resolution={512}
          frames={1}
          color="#000000"
        />

        {/* ---- 黑曜石镜面反射地面（图五空间纵深感的核心）----
         *
         * 【解决什么】此前地面只有网格、没有任何反射，场景是"悬在虚空里"的：
         * 缺少上下镜像关系，纵深立刻扁平。参考图的深邃感来自
         * **地面把机架、八面体与星环柔和地倒映下去**。
         *
         * 【参数依据】
         * - blur [320, 90]：长轴大幅模糊 → 倒影是柔和渗影而非镜面复刻；
         * - mixStrength 15 / mirror 0.55：反射克制，过强会抢戏；
         * - roughness 0.62 + metalness 0.65：黑曜石半哑光金属釉面；
         * - depthScale + min/maxDepthThreshold：按深度衰减，
         *   近处清晰、远处迅速沉入深色，避免远处倒影堆叠成噪点。
         *
         * 【Y = −0.025】低于两层 Grid（−0.02 / +0.01），
         * 于是网格像蚀刻在镜面上层的坐标网，而非浮在反射之上。
         */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.025, 0]} receiveShadow>
          <circleGeometry args={[32, 64]} />
          <MeshReflectorMaterial
            blur={[320, 90]}
            /*
             * ---- 反射贴图分辨率随自适应 DPR 分级 ----
             *
             * 【为什么必须分级】MeshReflectorMaterial 会把整个场景**再渲染一遍**
             * 到一张 512² 的 RT，这是本场景最重的一笔固定开销。
             * 在集显/低端设备上，它往往就是压垮 60FPS 的最后一根稻草——
             * 而恰恰是这类设备最先触发 PerformanceMonitor 的降级。
             *
             * 【分级策略】以 adaptiveDpr 为信号（它是现有降级链的真实输出）：
             *   ≥ 1.5 → 512（正常/高分屏）
             *   < 1.5 → 256（已降级设备，反射面积减到 1/4，肉眼几乎无感）
             * 反射本来就是模糊柔化的（blur 320×90），降采样后观感损失极小，
             * 但填充率开销直接降到四分之一。
             */
            resolution={adaptiveDpr >= 1.5 ? 512 : 256}
            mixBlur={0.85}
            mixStrength={15}
            roughness={0.62}
            depthScale={1.1}
            minDepthThreshold={0.35}
            maxDepthThreshold={1.4}
            color="#030816"
            metalness={0.65}
            mirror={0.55}
          />
        </mesh>

        {/* ---- 赛博极客双层地面网格（蚀刻在镜面上的坐标网）----
          下层（y=-0.020）：大尺度粗格延伸至雾效远端，构建深空坐标系纵深；
          上层（y=+0.004）：小尺度细格聚焦中心作战区。
          两者与反射地面（−0.025）、接触阴影（0.008）、拓扑环（0.014）
          共同构成 5 级非重叠 Y 顺序（详见上方层级契约注释）。
          【本轮调整】线宽与对比度双双调低——地面已是反光材质，
          网格若太亮会与倒影争视觉权重，变成"两张网"的噪音。 */}
        <Grid
          position={[0, -0.02, 0]}
          args={[140, 140]}
          cellSize={6}
          cellThickness={0.25}
          cellColor="#07333b"
          sectionSize={30}
          sectionThickness={0.55}
          sectionColor="#084656"
          fadeDistance={86}
          fadeStrength={1.6}
          infiniteGrid
        />
        <Grid
          position={[0, 0.004, 0]}
          args={[44, 44]}
          cellSize={1.6}
          cellThickness={0.25}
          cellColor="#0b272f"
          sectionSize={8}
          sectionThickness={0.55}
          sectionColor="#115564"
          fadeDistance={40}
          fadeStrength={1.4}
        />

        {/* ---- 双层深空飞散光粒子场（Dual-Layer Sparkles）----
          第一层贴地环绕（粗亮、快）复刻光圈周围飞散的星尘；
          第二层中空光束区（细小、慢、绿）表现能量逸散。
          两层尺度/速度/颜色都不同，才有"近亮远淡"的景深层次。 */}
        <Sparkles count={140} scale={[24, 2.5, 24]} size={1.6} speed={0.35} color="#38bdf8" position={[0, 1.2, 0]} opacity={0.75} />
        <Sparkles count={90} scale={[22, 10, 22]} size={1.1} speed={0.2} color="#10b981" position={[0, 5.0, 0]} opacity={0.45} />

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
        <CyberMatrixRain3D />

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

        {/* ---- 机架故障警示涟漪（仅故障机架激活：崩溃 Pod 或节点非 Ready；
           自定义 ShaderMaterial 三环由内向外扩散，加色混合贴地辉光） ---- */}
        <ErrorRippleRing />

        {/* ---- 选中 Pod 的空间锁定光环（审查报告 §2.4）----
           机架与 Master 各有自己的选中视觉，但单个 Pod 此前完全没有——
           推近特写后同层 4 个方块挤在画面中心，用户分不清探针面板指的是哪颗。
           该标记绘制包围框 + 刻度环 + 指示杆，与巡检面板形成「数据 ↔ 空间」指认闭环。 */}
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
         * 【参数依据（本轮校准）】
         * - luminanceThreshold **0.62**：旧值 0.22 太低，把八面体面片、
         *   机柜顶盖这类"中等亮度"表面也纳入泛光，导致控制平面糊成一团
         *   死白的棉花糖、机柜盖泛白雾。抬到 0.62 后只有真正高光
         *   （星核顶点 / 能量束核心 / 星尘粒子）才溢出，泛光回归点状细腻；
         * - luminanceSmoothing 0.24：阈值边缘柔和过渡，消灭硬切边界；
         * - mipmapBlur + radius 0.56：光晕更紧、更克制，不吞掉细节；
         * - intensity 0.55：既保住状态色语义（红/绿/琥珀可分辨），
         *   又不会把暗部整体提亮成灰雾。
         *
         * 【Vignette】暗角 0.35 让视线自然收拢到画面中心的三环布局，
         * 这是参考图构图感的来源之一。
         *
         * 【性能】multisampling=0 + disableNormalPass：本场景已用
         * canvas 的 antialias 与 DPR 控制画质，后处理链不重复 MSAA；
         * 本版本 EffectComposer 无 disableNormalPass 选项，法线通道关闭由上游 npm 版本决定。
         */}
        {heavyRenderEnabled ? (<EffectComposer multisampling={0}>
          <Bloom
            intensity={0.55}
            luminanceThreshold={0.62}
            luminanceSmoothing={0.24}
            mipmapBlur
            radius={0.56}
          />
          <Vignette eskil={false} offset={0.18} darkness={0.35} />
        </EffectComposer>) : null}
      </Canvas>

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
        className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(circle_at_center,transparent_55%,rgba(2,6,23,0.65)_100%)]"
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