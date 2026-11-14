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

import { useEffect, useState, type ReactElement } from 'react';
import dynamic from 'next/dynamic';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { Radar, X } from 'lucide-react';

import ShellLayout from '@/components/layout/ShellLayout';
import StartupStatusCapsule from '@/components/hud/StartupStatusCapsule';
import { MOTION } from '@/constants/tokens';
import { Z_CLASS } from '@/constants/zIndex';
import { useTelemetryStream } from '@/hooks/useTelemetryStream';
import { useEscapeDispatcher, useEscapeHint, useEscapeLayer } from '@/hooks/useEscapeStack';
import { rehydratePersistedClusterState, useClusterStore } from '@/store/useClusterStore';
import { dispatchViewPreset } from '@/utils/viewPresetBus';
import { cn } from '@/utils/cn';

/**
 * CopilotDrawer 懒加载（右侧智能运维副驾驶主面板）。
 *
 * 【为何用 dynamic 而非静态 import】
 * 1. 首屏体积：Copilot 内含 5 个 GenUI 组件、framer-motion 动画、
 *    NDJSON 流解析与 Web Speech 集成，属重资产；SSR 阶段它不产生任何
 *    可见内容（消息列表初始为空），延后加载可让 3D 画布更快可交互；
 * 2. SSR 安全：组件大量使用 window（fetch 流、speechSynthesis、
 *    SpeechRecognition、canvas.toDataURL），ssr:false 彻底规避服务端求值；
 * 3. loading 返回 DrawerSkeleton：此前返回 null，导致首屏右侧 35% 是
 *    一块毫无内容的纯黑空洞（审查报告 §2.2 判定的 P0 视觉割裂）。
 *    改为与 CanvasSkeleton 同语言的轻量骨架，让左右两栏在加载期就对称。
 */
const CopilotDrawer = dynamic(() => import('@/components/ai/CopilotDrawer'), {
  ssr: false,
  loading: (): ReactElement => <DrawerSkeleton />,
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
 * PerfTelemetryHUD 懒加载（开发者性能遥测浮层）。
 *
 * 【为何 dynamic】这是一个**按需开发者工具**：绝大多数用户永远不会按
 * Shift+P。它的代码（2Hz 采样器、FPS 迷你折线图、framer-motion 动画）
 * 不应该进入首屏 bundle。ssr:false 同时规避 window 依赖。
 *
 * 【loading 返回 null】HUD 是浮层，加载期间不占位；chunk 通常几十毫秒就绪，
 * 闪现骨架只会造成视觉噪音。
 */
const PerfTelemetryHUD = dynamic(() => import('@/components/hud/PerfTelemetryHUD'), {
  ssr: false,
  loading: (): null => null,
});

/**
 * CommandPalette 懒加载（全局运维命令面板）。
 *
 * 【为何 lazy】命令面板包含完整的 Pod/Node 列表渲染与搜索逻辑，
 * 但只在用户按 Cmd/Ctrl+K 时才需要。绝大多数会话根本不会打开它，
 * 让它进首屏 bundle 是纯浪费。与 Perf HUD 同理，loading 返回 null。
 */
const CommandPalette = dynamic(() => import('@/components/hud/CommandPalette'), {
  ssr: false,
  loading: (): null => null,
});

/**
 * DrawerSkeleton —— 右侧 AI 抽屉加载占位。
 *
 * 【职责】Copilot 的 chunk 下载/编译期间占据右栏空间。此前 loading 返回
 * null，首屏右侧 35% 是一块纯黑空洞，与左侧带描边的 3D 视口严重不对称。
 * 本骨架提供与面板一致的头部/正文/输入区分层轮廓 + 流光扫描，
 * 让加载期也有"面板存在感"，衔接过程零割裂。
 */
function DrawerSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="AI 副驾加载中">
      {/* 顶部页签骨架 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/[0.07] px-3">
        <span className="h-2 w-20 animate-pulse rounded-sm bg-slate-800" />
        <span className="h-2 w-16 animate-pulse rounded-sm bg-slate-800/60 [animation-delay:150ms]" />
      </div>

      {/* 正文骨架：模拟消息气泡轮廓 */}
      <div className="relative min-h-0 flex-1 space-y-3 overflow-hidden p-3">
        <span className="block h-2 w-3/5 animate-pulse rounded-sm bg-slate-800/70" />
        <span className="block h-16 w-full animate-pulse rounded-md bg-slate-800/40 [animation-delay:100ms]" />
        <span className="block h-2 w-4/5 animate-pulse rounded-sm bg-slate-800/60 [animation-delay:200ms]" />
        <span className="block h-24 w-full animate-pulse rounded-md bg-slate-800/30 [animation-delay:300ms]" />

        {/* 青色流光扫描：与 CanvasSkeleton 同语言的往复光带 */}
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-cyan-400/[0.07] to-transparent"
          animate={{ x: ['-100%', '300%'] }}
          transition={{ duration: 2.2, ease: 'easeInOut', repeat: Infinity }}
        />
      </div>

      {/* 底部输入区骨架 */}
      <div className="shrink-0 border-t border-white/[0.07] p-2">
        <span className="block h-9 w-full animate-pulse rounded border border-white/[0.07] bg-slate-800/30" />
      </div>
    </div>
  );
}

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
        <p className="font-mono text-[11px] tracking-[0.2em] text-cyan-400/80">
          正在初始化 WebGL 3D 拓扑引擎
        </p>
        <p className="font-mono text-[11px] tracking-wider text-slate-400">
          加载 Three.js 场景图 · 空间布局矩阵 · 实例着色器
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
   * 不会重建连接；返回值（传输形态等）本页暂不消费。
   * 【R4】帧计数已移入瞬态轨（glStats.telemetryFrameCount），
   * 本 Hook 不再持有 1Hz state——page 根不会每帧重渲染。 */
  useTelemetryStream();

  /* 混沌模态框开关（订阅 store，由 TopBar 的 Inject Chaos 按钮写入）。
   * 仅此一个布尔值参与本页重渲染，开销可忽略。 */
  const isChaosModalOpen = useClusterStore((s): boolean => s.isChaosModalOpen);

  /* 性能遥测 HUD 开关（Shift+P 或 TopBar 按钮写入）。
   * HUD 组件本身通过 dynamic 懒加载，关闭状态下完全不加载其 chunk。 */
  const isPerfHudOpen = useClusterStore((s): boolean => s.isPerfHudOpen);
  const setPerfHudOpen = useClusterStore((s): ((open: boolean) => void) => s.setPerfHudOpen);

  /* 命令面板开关（由 Store 持有，确保与 TopBar 触发器单源同步） */
  const isCommandOpen = useClusterStore((s): boolean => s.isCommandPaletteOpen);
  const setCommandOpen = useClusterStore((s): ((open: boolean) => void) => s.setCommandPaletteOpen);

  /**
   * 【全局快捷键】（审查报告 §4.4 / §4.5）
   *
   * - `Cmd/Ctrl + K` 唤起命令面板（Linear / Vercel / Raycast 的标志性交互）；
   * - `Esc` 逐级退出栈：命令面板 → 混沌模态框 → 性能 HUD →
   *   取消 3D 选中并复位视角。
   *
   * 【为何 Esc 要建"栈"而非各组件自理】多组件同时监听 Esc 会一次按键关掉
   * 多个面板（用户按一次 Esc 期待只退一层）。这里集中在一处按优先级处理，
   * 保证「Esc 只退最上面那一层」的直觉。
   *
   * 【输入焦点让位】在输入框/文本域内按 Esc 不应触发全局退出——
   * 那是用户想取消输入，不是想关面板。
   */
  /*
   * 【C1 页面兜底层】优先级 0：只有没有任何弹层打开时才会轮到它。
   * 行为：先关性能 HUD，再清 3D 选中——分两次 Esc 完成，绝不与弹窗同一次发生。
   */
  useEscapeLayer({
    id: 'page-core',
    priority: 0,
    label: '退出选中',
    onEscape: (): void => {
      const state = useClusterStore.getState();
      if (state.isPerfHudOpen) {
        state.setPerfHudOpen(false);
        return;
      }
      if (state.selectedEntityId !== null) {
        state.selectEntity(null);
        dispatchViewPreset('overview');
      }
    },
  });

  useEscapeDispatcher();

  /* Q3：底部提示当前 Esc 会关闭哪一层（null 表示没有可关闭弹层） */
  const escapeHint = useEscapeHint();
  /* R12 单一全局状态提示条手动关闭记录：同一提示可被用户关闭，层变化时自动恢复可见 */
  const [dismissedHint, setDismissedHint] = useState<string | null>(null);

  useEffect((): void => {
    setDismissedHint(null);
  }, [escapeHint]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      /* ---- Cmd/Ctrl + K：唤起命令面板（输入框内也允许，便于随时跳转）---- */
      if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        const nextOpen = !useClusterStore.getState().isCommandPaletteOpen;
        setCommandOpen(nextOpen);
        return;
      }

      /*
       * 【C1】Esc 已迁移到 useEscapeStack 的分级退出栈（本文件只保留一个派发器）。
       * 这里不再处理 Escape，避免"多个监听器抢同一个键、一次退多层"。
       */
    };

    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [setCommandOpen]);

  const showGlobalStatus = escapeHint !== null && dismissedHint !== escapeHint;

  return (
    <MotionConfig reducedMotion="user">
      <ShellLayout
        viewport={<ClusterCanvas />}
        drawer={<CopilotDrawer />}
        perfHud={
          isPerfHudOpen ? (
            <PerfTelemetryHUD key="perf-hud" onClose={(): void => setPerfHudOpen(false)} />
          ) : null
        }
      />

      {/* R41：WebGL / Copilot chunk / 遥测三条启动状态合并为一个可折叠胶囊 */}
      <StartupStatusCapsule />

      {/*
       * 顶层混沌演练模态框（z-50，全站最顶层，高于 PerfHUD z-40）。
       * 独立 AnimatePresence 包裹以启用其内部 exit 动画。
       */}
      <AnimatePresence initial={false}>
        {isChaosModalOpen ? <ChaosControlModal key="chaos-modal" /> : null}
      </AnimatePresence>

      {/*
       * Q3 / R12：全站唯一全局状态/Esc 提示条（同时最多展示 1 条）。
       * 不遮挡底部输入坞、顶部工具栏或 Modal，带 aria-live="polite" 与手动关闭钮。
       */}
      <AnimatePresence initial={false}>
        {showGlobalStatus ? (
          <motion.div
            key={`global-status-${escapeHint}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: MOTION.overlayFadeSec, ease: MOTION.easeOut }}
            className={cn(
              'pointer-events-none fixed left-1/2 top-[3.75rem] -translate-x-1/2 md:bottom-[6.75rem] md:top-auto',
              Z_CLASS.HUD_OVERLAY,
            )}
          >
            <div
              className="kv-chip flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-slate-950/[0.85] py-1 pl-2.5 pr-1.5 font-mono text-[10px] tracking-wider text-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.18)]"
              role="status"
              aria-live="polite"
              aria-label={`Esc 关闭：${escapeHint}`}
              data-escape-hint={escapeHint}
              data-global-status-toast="true"
            >
              <kbd className="rounded border border-white/[0.07] bg-slate-800 px-1 text-[10px] text-slate-300">Esc</kbd>
              <span>关闭：{escapeHint}</span>
              <button
                type="button"
                onClick={(): void => setDismissedHint(escapeHint)}
                aria-label="关闭全局状态提示"
                className="kv-touch-target pointer-events-auto ml-0.5 flex h-6 w-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/*
       * 全局运维命令面板（Cmd/Ctrl+K 唤起，z-60 位于最顶层之上）。
       *
       * 【为何 z-60 而非 z-50】命令面板是**跨所有面板的全局跳转器**，
       * 即使用户正开着混沌演练模态框（z-50）也应能唤起它并直接跳去某个 Pod。
       * 若低于模态框，用户在模态框内按 Cmd+K 会看到面板被遮住，形同虚设。
       */}
      <AnimatePresence initial={false}>
        {isCommandOpen ? (
          <CommandPalette key="command-palette" onClose={(): void => setCommandOpen(false)} />
        ) : null}
      </AnimatePresence>
    </MotionConfig>
  );
}
