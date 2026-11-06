'use client';

/**
 * KubeVision AI — 混沌工程故障演练模态框（ChaosControlModal）
 *
 * 【设计意图】把「故障注入」从一次隐蔽的状态变更升级为一场有仪式感的
 * 战术演练：四张分区明确的场景卡片（三注入 + 一恢复），每张都讲清
 * 「打哪台机架、用什么机制、会看到什么」，点击即启动完整联动链路。
 *
 * 【视觉契约：半透明暗黑警示风格 + 红黑斜纹战术边框】
 * - 背景遮罩：slate-950/85 + backdrop-blur（比常规 Modal 更暗，强化警示）；
 * - 面板：深黑底 + 红色警示描边 + 红色外辉光；
 * - 斜纹战术边框：由 CSS `repeating-linear-gradient` 绘制的 45° 红黑条纹，
 *   上下两条作为「警戒线」装饰（不使用图片，纯 CSS，零资源开销）；
 * - 三个故障卡悬停时边框转红并轻微放大，恢复卡为翠绿（语义反转）。
 *
 * 【层级契约】z-50 顶层（AGENTS.md 第 6 条）：高于 PerfHUD(z-40)、
 * TopBar(z-30)、画布内 drei <Html>(zIndexRange=[0,10])，
 * 任何情况下都不会被 3D 标注遮挡。
 *
 * 【点击联动的四步链路】（核心业务逻辑，按序不可颠倒）
 * 1. **注入场景**：setActiveChaos(scenario) 写入响应轨 → useTelemetryStream
 *    的 Effect 因 activeChaos 变化而重建 SSE 连接 → 遥测流立即进入故障演进；
 * 2. **清空免疫表**：把 healedPodIds 置空——否则上一轮自愈过的 Pod 仍带
 *    免疫时间戳，新一轮演练中它们会被 reconcileSnapshot 强制保持健康，
 *    导致「注入 OOM 风暴但几个 Pod 死活不崩」的诡异现象；
 * 3. **相机聚焦受灾机架**：selectEntity(nodeId, 'node') → CameraRig 平滑
 *    飞向该机架特写；同时该机架底部的 ErrorRippleRing 因崩溃 Pod 出现而
 *    自动激活红色脉冲（无需额外调用，涟漪环订阅快照状态）；
 * 4. **关闭并广播**：setChaosModalOpen(false) + 终端打印醒目的
 *    `[CHAOS-MESH] Fault scenario injected` 战术广播。
 *
 * 【为何 scene D（NONE）不聚焦机架】
 * 恢复稳态是「拉远看全局」的语义，把镜头锁在某个机架上反而看不到
 * 全集群恢复的过程。因此 NONE 只清空选中（selectEntity(null)），
 * 让相机飞回全景鸟瞰。
 */

import { useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Cpu, Network, ShieldCheck, Skull, X } from 'lucide-react';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import type { SelectedEntityType } from '@/types/store';
import type { ChaosControlModalProps, ChaosDrillCard } from '@/types/chaos';
import type { ChaosScenario } from '@/types/cluster';

/* ========================================================================== */
/* 静态卡片表（新增场景只改此表，不改 JSX）                                        */
/* ========================================================================== */

/**
 * 四张演练场景卡片（代号 A/B/C/D）。
 *
 * 【内容契约】每张卡的 description 都明确写出「受灾机架 + 故障机制 +
 * 可观测后果」，让运维在点击之前就准确知道会发生什么——
 * 混沌工程的第一原则是「知情同意」，而不是「盲按按钮看烟花」。
 */
const CHAOS_DRILL_CARDS: readonly ChaosDrillCard[] = [
  {
    scenario: 'POD_OOM_SWARM',
    code: 'A',
    codename: 'POD_OOM_SWARM',
    title: '内存溢出雪崩',
    description:
      '模拟 worker-beta 机架上的支付网关与缓存服务突发内存泄漏，内存水位冲至 96~99% 触发 OOMKilled 崩溃循环，Pod 反复重启并产生 P0 告警风暴。',
    targetRackIndex: 1,
    targetEntityId: 'node-worker-beta',
    accentTextClass: 'text-rose-300',
    accentBorderClass: 'hover:border-rose-500/70 hover:bg-rose-500/10',
    isRecovery: false,
  },
  {
    scenario: 'NODE_CPU_SPIKE',
    code: 'B',
    codename: 'NODE_CPU_SPIKE',
    title: '计算节点算力打满',
    description:
      '模拟突发流量洪峰导致 worker-alpha 机架 CPU 飙升至 92~99%，节点进入 HighLoad 状态并触发调度阻塞，其上全部 Pod 争抢算力、响应延迟陡增。',
    targetRackIndex: 0,
    targetEntityId: 'node-worker-alpha',
    accentTextClass: 'text-amber-300',
    accentBorderClass: 'hover:border-amber-500/70 hover:bg-amber-500/10',
    isRecovery: false,
  },
  {
    scenario: 'NET_PACKET_LOSS',
    code: 'C',
    codename: 'NET_PACKET_LOSS',
    title: 'CNI 网络插件分区丢包',
    description:
      '模拟 worker-gamma 机架跨节点 VXLAN 隧道丢包，网络吞吐骤降至基准的 12%，节点判定为 NetworkPartition，下属部分 Pod 失联转为 Pending。',
    targetRackIndex: 2,
    targetEntityId: 'node-worker-gamma',
    accentTextClass: 'text-fuchsia-300',
    accentBorderClass: 'hover:border-fuchsia-500/70 hover:bg-fuchsia-500/10',
    isRecovery: false,
  },
  {
    scenario: 'NONE',
    code: 'D',
    codename: 'NONE',
    title: '一键恢复集群稳态',
    description:
      '清除全部混沌注入，停止故障演进，全集群回归健康基线：Pod 复位 Running、节点回归 Ready、健康分恢复满分、告警清空。',
    targetRackIndex: null,
    targetEntityId: null,
    accentTextClass: 'text-emerald-300',
    accentBorderClass: 'hover:border-emerald-500/70 hover:bg-emerald-500/10',
    isRecovery: true,
  },
];

/** 场景 → 战术图标的映射（每张卡有独立视觉符号，便于快速辨识） */
const DRILL_ICONS: Readonly<Record<ChaosScenario, typeof Skull>> = {
  POD_OOM_SWARM: Skull,
  NODE_CPU_SPIKE: Cpu,
  NET_PACKET_LOSS: Network,
  NONE: ShieldCheck,
};

/**
 * 红黑 45° 斜纹（CSS repeating-linear-gradient 绘制，零资源开销）。
 *
 * 【为何用 border-image 而非背景】斜纹要作为「警戒线」贴在面板上下边缘，
 * 用独立元素铺背景更可控；此处以 8px 高的条带承载，45° 条纹每 12px 一个周期，
 * 红色（rose-600/60）与近黑交替，形成经典的危险区域标识。
 */
const HAZARD_STRIPE_STYLE: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, rgba(244,63,94,0.55) 0px, rgba(244,63,94,0.55) 6px, rgba(2,6,23,0.85) 6px, rgba(2,6,23,0.85) 12px)',
};

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * ChaosControlModal —— 混沌工程故障演练模态框（顶层 z-50）。
 *
 * 由 page.tsx 经 next/dynamic 按需懒加载挂载（首屏零开销），
 * 仅当 isChaosModalOpen 为 true 时渲染。
 */
export default function ChaosControlModal({ className }: ChaosControlModalProps) {
  /* ---- Store 订阅（细粒度：仅所需字段） ---- */
  const setActiveChaos = useClusterStore((s): ((scenario: ChaosScenario) => void) => s.setActiveChaos);
  const setChaosModalOpen = useClusterStore((s): ((open: boolean) => void) => s.setChaosModalOpen);
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );
  const appendTerminalLog = useClusterStore((s): ((line: string) => void) => s.appendTerminalLog);

  /* Escape 关闭（对键盘用户与「我后悔了」场景的必要出口） */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setChaosModalOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [setChaosModalOpen]);

  /**
   * handleCardClick —— 卡片点击的四步联动链路（详见文件头 JSDoc）。
   *
   * 【顺序为何不可颠倒】
   * - 必须先清免疫表再注入场景：若先注入、后清表，中间这一瞬间到达的
   *   一帧仍会按旧免疫表把 Pod 强制保持健康（虽然只有一帧，但会让
   *   「注入后首个视觉反馈」出现矛盾）；
   * - 必须先注入场景再聚焦相机：CameraRig 的聚焦依据是 selectEntity 的
   *   实体 ID，与 chaos 无关，但先注入能让镜头飞行期间故障已经开始演进，
   *   到达特写时画面已经是故障态（而不是飞到一半才开始变红）；
   * - 关闭模态框放最后：保证前三步的状态提交完成后再卸载 UI，
   *   避免卸载与状态更新交错引发的一帧空窗。
   */
  const handleCardClick = useCallback(
    (card: ChaosDrillCard): void => {
      /* ---- 步骤 1：清空免疫表（防止旧自愈把新故障 Pod 强制保持健康） ---- */
      /* healedPodIds 无专用 action，直接经 setState 提交（zustand 官方允许）。
         注意：只清该字段，其余状态（日志/历史/连接模式）保持不变。 */
      useClusterStore.setState({ healedPodIds: {} });

      /* ---- 步骤 2：注入场景（驱动 SSE 重建 + 引擎进入故障演进） ---- */
      setActiveChaos(card.scenario);

      /* ---- 步骤 3：相机聚焦受灾机架 / 恢复时拉回全景 ---- */
      if (card.isRecovery) {
        /* 恢复稳态：清空选中 → CameraRig 飞回全景鸟瞰 */
        selectEntity(null);
      } else if (card.targetEntityId !== null) {
        /* 注入故障：选中受灾机架 → 平滑推近特写 + ErrorRippleRing 自动激活 */
        selectEntity(card.targetEntityId, 'node');
      }

      /* ---- 步骤 4：战术广播日志（醒目的 [CHAOS-MESH] 前缀） ---- */
      if (card.isRecovery) {
        appendTerminalLog(
          '[CHAOS-MESH] Recovery executed -> all injections cleared, cluster restoring to healthy baseline',
        );
      } else {
        appendTerminalLog(
          `[CHAOS-MESH] Fault scenario injected -> ${card.scenario} on rack-${card.targetRackIndex} (${card.targetEntityId ?? 'n/a'}) - camera locked on affected rack, expect anomaly telemetry within 1s`,
        );
      }

      /* ---- 步骤 5：关闭模态框 ---- */
      setChaosModalOpen(false);
    },
    [appendTerminalLog, selectEntity, setActiveChaos, setChaosModalOpen],
  );

  return (
    <div
      className={cn('fixed inset-0 z-50 flex items-center justify-center p-4', className)}
      role="dialog"
      aria-modal="true"
      aria-label="混沌工程故障演练控制台"
    >
      {/* ============ 半透明暗黑警示遮罩（点击关闭） ============ */}
      <button
        type="button"
        aria-label="关闭混沌演练控制台"
        className="absolute inset-0 cursor-default bg-slate-950/85 backdrop-blur-sm"
        onClick={(): void => setChaosModalOpen(false)}
      />

      {/* ============ 控制台面板 ============ */}
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 16 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        className="relative w-full max-w-2xl overflow-hidden rounded-lg border border-rose-500/40 bg-slate-950/95 shadow-[0_0_40px_-8px_rgba(244,63,94,0.55)]"
      >
        {/* ---- 顶部红黑斜纹警戒条 ---- */}
        <div className="h-2 w-full" style={HAZARD_STRIPE_STYLE} aria-hidden />

        <div className="p-5">
          {/* ======== 头部：警示图标 + 标题 + 关闭 ======== */}
          <div className="mb-1 flex items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-rose-500/50 bg-rose-500/15">
              <AlertTriangle className="h-4 w-4 animate-glow-pulse text-rose-400" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-mono text-xs font-bold uppercase tracking-[0.25em] text-rose-300">
                chaos&nbsp;engineering&nbsp;console
              </h2>
              <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
                fault&nbsp;injection&nbsp;·&nbsp;drill&nbsp;authorization&nbsp;required
              </p>
            </div>
            <button
              type="button"
              onClick={(): void => setChaosModalOpen(false)}
              aria-label="关闭混沌演练控制台"
              className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200 active:scale-95"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          {/* ======== 说明文案 ======== */}
          <p className="mb-4 mt-3 border-l-2 border-rose-500/40 pl-2.5 text-[11px] leading-relaxed text-slate-400">
            选择演练场景后，遥测流将立即进入对应故障演进，3D 相机自动锁定受灾 Worker
            机架并激活地面红色警示脉冲。演练期间顶栏显示 CHAOS ACTIVE
            横幅，可随时一键终止，或在巡检 HUD 中执行自愈动作复位。
          </p>

          {/* ======== 四张场景卡片（双列网格） ======== */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {CHAOS_DRILL_CARDS.map((card) => {
              const Icon = DRILL_ICONS[card.scenario];
              return (
                <button
                  key={card.scenario}
                  type="button"
                  onClick={(): void => handleCardClick(card)}
                  aria-label={`${card.code} · ${card.codename} · ${card.title}`}
                  className={cn(
                    'group relative flex flex-col gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 p-3 text-left transition-all duration-150 active:scale-[0.985]',
                    card.accentBorderClass,
                  )}
                >
                  {/* 卡片头部：代号 + 图标 */}
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded border font-mono text-[10px] font-bold',
                        card.isRecovery
                          ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                          : 'border-rose-500/40 bg-rose-500/10 text-rose-300',
                      )}
                    >
                      {card.code}
                    </span>
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', card.accentTextClass)} aria-hidden />
                    <span
                      className={cn(
                        'min-w-0 truncate font-mono text-[10px] font-bold uppercase tracking-wider',
                        card.accentTextClass,
                      )}
                    >
                      {card.codename}
                    </span>
                  </span>

                  {/* 中文标题 */}
                  <span className="font-sans text-[12px] font-bold text-slate-100 group-hover:text-white">
                    {card.title}
                  </span>

                  {/* 详细说明 */}
                  <span className="text-[10.5px] leading-relaxed text-slate-500 group-hover:text-slate-400">
                    {card.description}
                  </span>

                  {/* 受灾机架徽标（恢复卡不显示） */}
                  {card.targetRackIndex !== null ? (
                    <span className="mt-0.5 inline-flex w-fit items-center gap-1 rounded border border-slate-700/70 bg-slate-800/60 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                      target&nbsp;·&nbsp;rack-{card.targetRackIndex}
                    </span>
                  ) : (
                    <span className="mt-0.5 inline-flex w-fit items-center gap-1 rounded border border-emerald-700/60 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-emerald-300">
                      restore&nbsp;·&nbsp;all&nbsp;racks
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* ======== 底部提示 ======== */}
          <p className="mt-3.5 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-slate-600">
            <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
            drills run against the simulated engine · no real cluster is harmed · ESC to abort
          </p>
        </div>

        {/* ---- 底部红黑斜纹警戒条 ---- */}
        <div className="h-2 w-full" style={HAZARD_STRIPE_STYLE} aria-hidden />
      </motion.div>
    </div>
  );
}
