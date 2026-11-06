'use client';

/**
 * KubeVision AI — 首页（中控台 Router 客户端入口）
 *
 * 【职责】中控台页面仅做两件事：
 * 1. 挂载补水：useEffect 中调用 rehydratePersistedClusterState()——
 *    其内部第一步即执行 useClusterStore.persist.rehydrate()（幂等守卫包裹，
 *    抵御 StrictMode 双调用），从 localStorage 安全恢复持久化状态。
 *    因 Store 配置 skipHydration: true，首帧 SSR/CSR 均为确定性初始值，
 *    补水发生在首帧提交之后，彻底杜绝 Hydration Mismatch（AGENTS.md 第 4 条）。
 * 2. 渲染 ShellLayout 全屏外壳，viewport 插槽挂载 dynamic(ssr:false) 的
 *    ClusterCanvas——three/R3F 代码永不进入服务端 bundle，chunk 按需加载
 *    期间展示赛博风加载 Skeleton（扫描线 + 脉冲徽标，主题氛围零割裂）。
 * 3. 激活 useTelemetryStream：建立 SSE 遥测订阅（含自愈免疫合并、双轨分发
 *    与本地降级兜底）。Hook 在此挂载而非画布内，保证即使 3D chunk 尚未
 *    加载完成、或用户切到 Copilot 视图（画布隐藏但常驻 DOM），
 *    遥测流依然持续工作，HUD/终端/告警面板始终有数据。
 *
 * 【'use client' 边界说明】本文件是客户端组件，metadata 不可从此导出——
 * 页面标题等元数据已由 src/app/layout.tsx（服务端根布局）统一承载。
 */

import { useEffect, type ReactElement } from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import { Radar } from 'lucide-react';

import ShellLayout from '@/components/layout/ShellLayout';
import { useTelemetryStream } from '@/hooks/useTelemetryStream';
import { rehydratePersistedClusterState, useClusterStore } from '@/store/useClusterStore';

/**
 * CopilotDrawer 懒加载（右侧智能运维副驾驶主面板）。
 *
 * 【为何用 dynamic 而非静态 import】
 * 1. 首屏体积：Copilot 内含 5 个 GenUI 组件、framer-motion 动画、
 *    NDJSON 流解析与 Web Speech 集成，属重资产；SSR 阶段它不产生任何
 *    可见内容（消息列表初始为空），延后加载可让 3D 画布更快可交互；
 * 2. SSR 安全：组件大量使用 window（fetch 流、speechSynthesis、
 *    SpeechRecognition、canvas.toDataURL），ssr:false 彻底规避服务端求值；
 * 3. loading 返回 null：抽屉位置由右侧栏的边框与背景承载，
 *    chunk 就绪前不显示骨架，避免切换瞬间的布局跳动。
 */
const CopilotDrawer = dynamic(() => import('@/components/ai/CopilotDrawer'), {
  ssr: false,
  loading: (): null => null,
});

/**
 * ClusterCanvas 懒加载（SSR 边界核心配置）。
 *
 * 【ssr: false 契约】three / @react-three/fiber / drei 深度依赖 window、
 * WebGL 上下文与 ResizeObserver，服务端求值必然崩溃；dynamic ssr:false
 * 使其仅在浏览器端解析，且自动代码分割为独立 chunk（首屏 HTML 零 three 体积）。
 * loading 回调返回赛博风 Skeleton，chunk 下载/编译期间维持主题氛围。
 */
const ClusterCanvas = dynamic(() => import('@/components/canvas/ClusterCanvas'), {
  ssr: false,
  loading: (): ReactElement => <CanvasSkeleton />,
});

/**
 * ChaosControlModal 懒加载（混沌演练模态框）。
 *
 * 【为何用 dynamic 而非静态 import】
 * 1. 首屏零开销：模态框默认关闭，其代码（含 framer-motion 动画、四张卡片
 *    文案、图标）不应进入首屏 bundle——按需 chunk 加载后才付这笔体积；
 * 2. SSR 安全：组件使用 window 事件监听（Escape）与 Portal 级 fixed 定位，
 *    ssr:false 彻底规避服务端求值；
 * 3. 视觉连续：loading 返回 null 而非骨架屏——模态框的加载发生在用户点击
 *    「Inject Chaos」的瞬间，chunk 通常在 50ms 内就绪，闪现骨架反而更糟。
 */
const ChaosControlModal = dynamic(() => import('@/components/hud/ChaosControlModal'), {
  ssr: false,
  loading: (): null => null,
});

/**
 * CanvasSkeleton —— 3D 画布加载占位（赛博风）。
 *
 * 深空网格背景 + 中心雷达徽标脉冲 + 底部扫描线往复（animate-scan-line 令牌），
 * 与正式画布的视觉语言无缝衔接，避免「白屏 → 突变 3D」的割裂感。
 */
function CanvasSkeleton() {
  return (
    <div className="bg-cyber-grid absolute inset-0 flex items-center justify-center overflow-hidden bg-slate-950">
      {/* 中心脉冲徽标 */}
      <div className="relative flex flex-col items-center gap-3">
        <span className="flex h-14 w-14 animate-glow-pulse items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 shadow-glow-cyan">
          <Radar className="h-7 w-7 text-cyan-400" aria-hidden />
        </span>
        <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-cyan-400/80">
          initializing&nbsp;webgl&nbsp;engine
        </p>
        <p className="font-mono text-[9px] tracking-wider text-slate-600">
          loading three.js r169 · r3f scene graph · spatial layout
        </p>
        {/* 进度条：不确定态流光扫描（framer-motion 往复位移，不依赖自定义 keyframes） */}
        <span className="relative mt-1 block h-px w-48 overflow-hidden bg-slate-800">
          <motion.span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-cyan-400 to-transparent"
            animate={{ x: ['-100%', '300%'] }}
            transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity }}
          />
        </span>
      </div>
      {/* 全屏扫描线（自上而下往复，CRT 监控质感） */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="h-16 w-full animate-scan-line bg-gradient-to-b from-transparent via-cyan-400/5 to-transparent" />
      </div>
    </div>
  );
}

export default function HomePage() {
  /* 挂载后手动补水：内部首先调用 useClusterStore.persist.rehydrate()，
   * 幂等守卫保证 StrictMode 双挂载 / 多组件重复调用只真正补水一次 */
  useEffect(() => {
    rehydratePersistedClusterState();
  }, []);

  /* 遥测流激活：SSE 订阅 + 自愈免疫合并 + 双轨分发 + 本地降级兜底。
   * Hook 内部依赖严格锁定 [connectionMode, activeChaos]，其余字段变化
   * 不会重建连接；返回值（传输形态/帧计数）本页暂不消费，
   * 后续可由 TopBar 的「数据源徽标」接入展示。 */
  useTelemetryStream();

  /* 混沌模态框开关（订阅 store，由 TopBar 的 Inject Chaos 按钮写入）。
   * 仅此一个布尔值参与本页重渲染，开销可忽略。 */
  const isChaosModalOpen = useClusterStore((s): boolean => s.isChaosModalOpen);

  return (
    <>
      <ShellLayout viewport={<ClusterCanvas />} drawer={<CopilotDrawer />} />
      {/* 顶层混沌演练模态框：仅在开启时挂载，关闭即卸载（配合 dynamic 实现
          chunk 按需加载 + 卸载释放）。组件内部自带 AnimatePresence 入场动画，
          且 z-50 位于全站最顶层（高于 PerfHUD z-40 与画布 Html 标注）。 */}
      {isChaosModalOpen ? <ChaosControlModal /> : null}
    </>
  );
}
