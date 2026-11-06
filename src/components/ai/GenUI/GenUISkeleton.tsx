'use client';

/**
 * KubeVision AI — 生成式 UI 骨架屏（GenUISkeleton）
 *
 * 【设计意图】NDJSON 流收到 tool-start 事件后，到 tool-result 到达之间有一段
 * 空窗（LLM 正在组织参数 / 工具正在执行）。若什么都不显示，用户会以为卡住了；
 * 本骨架屏把这段等待变成**可感知的进度**——展示「AI 正在调用什么工具、
 * 走的是哪个 MCP 端点」，并配以青色流光扫描动画。
 *
 * 【可感知的进度 = 可信的智能】这是 AI 产品体验的关键细节：
 * 用户看到 mcp://k8s-cluster/tools/renderPodMetrics 这样的具体端点，
 * 会理解系统真的在做事，而不是在空转。
 *
 * 【动画契约】青色流光扫描由 framer-motion 的 x 位移动画实现
 * （-100% → 300% 往复），而非 CSS keyframes 依赖的全局类，
 * 保证组件自带全部依赖、可独立复用。骨架块本身用
 * animate-pulse（Tailwind 内置）营造加载呼吸感。
 */

import { motion } from 'framer-motion';
import { Plug, Wrench } from 'lucide-react';

import { cn } from '@/utils/cn';
import type { GenUISkeletonProps } from '@/types/ai';

/**
 * GenUISkeleton —— 工具调用进行中的占位骨架屏。
 *
 * @param props 见 GenUISkeletonProps（toolName / mcpUri / className）
 */
export default function GenUISkeleton({ toolName, mcpUri, className }: GenUISkeletonProps) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md border border-cyan-500/30 bg-slate-900/60 p-2.5 backdrop-blur-sm',
        className,
      )}
      aria-label="AI 正在调用工具"
      aria-busy="true"
    >
      {/* ============ 青色流光扫描（覆盖整卡的往返光带） ============ */}
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-cyan-400/20 to-transparent"
        animate={{ x: ['-100%', '300%'] }}
        transition={{ duration: 1.5, ease: 'easeInOut', repeat: Infinity }}
      />

      {/* ============ 头部：工具图标 + 工具名 ============ */}
      <div className="relative flex items-center gap-1.5">
        <span className="flex h-5 w-5 shrink-0 animate-pulse items-center justify-center rounded border border-cyan-500/40 bg-cyan-500/10">
          <Wrench className="h-3 w-3 text-cyan-300" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-bold uppercase tracking-wider text-cyan-300">
          {toolName}
        </span>
        {/* 三点加载指示 */}
        <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="h-1 w-1 rounded-full bg-cyan-400"
              animate={{ opacity: [0.25, 1, 0.25] }}
              transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
        </span>
      </div>

      {/* ============ MCP URI 提示 ============ */}
      <div className="relative mt-1.5 flex items-center gap-1 rounded border border-slate-700/70 bg-slate-800/50 px-1.5 py-1">
        <Plug className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
        <code className="truncate font-mono text-[11px] text-slate-400">{mcpUri}</code>
      </div>

      {/* ============ 骨架块（模拟即将出现的卡片结构） ============ */}
      <div className="relative mt-2 space-y-1.5">
        <div className="h-2 w-3/5 animate-pulse rounded-sm bg-slate-700/60" />
        <div className="h-2 w-4/5 animate-pulse rounded-sm bg-slate-700/40 [animation-delay:150ms]" />
        <div className="h-8 w-full animate-pulse rounded-sm bg-slate-700/25 [animation-delay:300ms]" />
      </div>

      {/* ============ 底部提示 ============ */}
      <p className="relative mt-2 font-mono text-[11px] uppercase tracking-wider text-slate-600">
        正在调用 MCP 工具 · 等待结果…
      </p>
    </div>
  );
}
