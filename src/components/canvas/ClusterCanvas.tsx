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
import { Grid, PerformanceMonitor, Sparkles } from '@react-three/drei';

import { useClusterStore } from '@/store/useClusterStore';
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

/** 深空背景/雾效基色（= slate-950 的 HEX，与 globals.css --kv-bg-void 一致） */
const VOID_COLOR = '#020617';

/** 雾效近端距离：18 单位内完全清晰（三机架半径 9.5，机架本体不受雾蚀） */
const FOG_NEAR = 18;

/** 雾效远端距离：48 单位处完全没入深空（背景粒子在远处自然消隐） */
const FOG_FAR = 48;

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
        onCreated={handleCanvasCreated}
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

        {/* ---- 灯光：环境基底 + 主方向光 + MASTER 中心青色辉光 ---- */}
        <ambientLight intensity={0.5} color="#cbd5e1" />
        <directionalLight position={[12, 20, 10]} intensity={1.4} color="#e2e8f0" />
        <pointLight position={[0, 3.2, 0]} intensity={26} distance={26} decay={2} color="#22d3ee" />

        {/* ---- 赛博极客双层地面网格 ----
          下层（y=-0.02）：大尺度粗格延伸至雾效远端，构建深空坐标系纵深；
          上层（y=+0.01）：小尺度细格聚焦中心作战区，与 .bg-cyber-grid 的
          48px 网格质感呼应。双层 Y 向错位 0.03 杜绝 z-fighting。 */}
        <Grid
          position={[0, -0.02, 0]}
          args={[140, 140]}
          cellSize={6}
          cellThickness={0.5}
          cellColor="#0e7490"
          sectionSize={30}
          sectionThickness={1.1}
          sectionColor="#155e75"
          fadeDistance={86}
          fadeStrength={1.6}
          infiniteGrid
        />
        <Grid
          position={[0, 0.01, 0]}
          args={[44, 44]}
          cellSize={1.6}
          cellThickness={0.55}
          cellColor="#164e63"
          sectionSize={8}
          sectionThickness={1}
          sectionColor="#22d3ee"
          fadeDistance={40}
          fadeStrength={1.4}
        />

        {/* ---- 背景微光悬浮粒子（深空尘埃感） ---- */}
        <Sparkles count={100} scale={30} size={1.2} speed={0.2} color="#22d3ee" position={[0, 5, 0]} opacity={0.55} />

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
      </Canvas>

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
