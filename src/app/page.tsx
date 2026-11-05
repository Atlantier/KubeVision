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
 *
 * 【'use client' 边界说明】本文件是客户端组件，metadata 不可从此导出——
 * 页面标题等元数据已由 src/app/layout.tsx（服务端根布局）统一承载。
 */

import { useEffect, type ReactElement } from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import { Radar } from 'lucide-react';

import ShellLayout from '@/components/layout/ShellLayout';
import { rehydratePersistedClusterState } from '@/store/useClusterStore';

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

  return <ShellLayout viewport={<ClusterCanvas />} />;
}
