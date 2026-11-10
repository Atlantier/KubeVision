'use client';

/**
 * KubeVision AI — Pod 指标卡片（生成式 UI · PodMetricsCard）
 *
 * 【设计意图】当 LLM 调用 renderPodMetrics 工具时，把目标 Pod 的实时遥测
 * 渲染成一张可交互卡片：既是数据展示，也是**导航入口**——点击 Pod 名称
 * 即可让 3D 相机飞过去特写巡检。这打通了「对话流 ↔ 3D 视口」的双向联动：
 * 用户在对话里看到异常指标，一键就能在空间里定位到那台 Pod。
 *
 * 【核心元素】
 * 1. 实时遥测快照：CPU / MEM 当前值、重启次数、命名空间；
 * 2. CPU/Memory 双轨渐变进度条：CPU 青色渐变、MEM 紫罗兰渐变，
 *    水位越界时（≥85%）转为琥珀/红色警示；
 * 3. 近 6 个周期的 SVG 面积折线图（与项目既有 Sparkline 手法一致，
 *    但此处为双序列叠加对比，故独立实现）；
 * 4. 点击名称 → selectEntity(podId, 'pod') → CameraRig 飞向特写。
 *
 * 【数据契约】Props 严格引用 ai.ts 的 PodMetricsCardProps，
 * 与 PodEntity 的 cpuHistory/memHistory 同构（长度恒为 6）。
 */

import { useCallback, useId, useMemo } from 'react';
import { Activity, Cpu, MemoryStick, RefreshCw, Server } from 'lucide-react';

import { cn } from '@/utils/cn';
import { useClusterStore } from '@/store/useClusterStore';
import type { PodMetricsCardProps } from '@/types/ai';
import type { SelectedEntityType } from '@/types/store';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** CPU 系列主色（主题青，与全局性能指标语义一致） */
const CPU_COLOR = '#22d3ee';

/** 内存系列主色（紫罗兰，与 CPU 明确区分） */
const MEM_COLOR = '#a78bfa';

/** 水位告警阈值（≥85% 视为高负载，与引擎 HighLoad 判定口径一致） */
const HIGH_WATERMARK = 85;

/** 面积折线图 SVG 视口（用户单位，preserveAspectRatio=none 自适应拉伸） */
const CHART_WIDTH = 260;
const CHART_HEIGHT = 44;

/** 图表垂直内边距：防峰值削顶与触底 */
const CHART_PAD_Y = 5;

/* ========================================================================== */
/* 纯函数：水位色分级                                                          */
/* ========================================================================== */

/**
 * watermarkTextClass —— 按水位返回语义文本色 Class。
 *
 * 【分级契约】<60 正常（翠绿/主题色）、60–84 警告（琥珀）、≥85 高危（红色）。
 * 与 TopBar 健康分档（85/60）保持一致，全项目同一套阈值。
 */
function watermarkTextClass(value: number): string {
  if (value >= HIGH_WATERMARK) return 'text-rose-400';
  if (value >= 60) return 'text-amber-400';
  return 'text-emerald-400';
}

/**
 * buildAreaPath —— 把 6 点序列转换为闭合面积路径（用于渐变填充）。
 *
 * 【核心数学】值域 [0,100] 线性映射到 SVG 高度：
 *   y = H − PAD − (v/100)·(H − 2·PAD)
 * 横轴等距分布：x_i = i·W/(n−1)。
 * 路径 = 折线 + 右下角 + 左下角，闭合形成填充区域。
 *
 * @returns 折线点串与闭合路径串
 */
function buildAreaPath(values: readonly number[]): { readonly line: string; readonly area: string } {
  const count = values.length;
  if (count === 0) return { line: '', area: '' };

  const usableHeight = CHART_HEIGHT - CHART_PAD_Y * 2;
  const stepX = count > 1 ? CHART_WIDTH / (count - 1) : CHART_WIDTH;

  const points: string[] = [];
  for (let i = 0; i < count; i++) {
    const value = Math.max(0, Math.min(100, values[i]));
    const x = i * stepX;
    const y = CHART_HEIGHT - CHART_PAD_Y - (value / 100) * usableHeight;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }

  const area = `M ${points[0]} L ${points.slice(1).join(' L ')} L ${CHART_WIDTH.toFixed(2)},${CHART_HEIGHT} L 0,${CHART_HEIGHT} Z`;
  return { line: points.join(' '), area };
}

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * PodMetricsCard —— Pod/节点实时指标卡（生成式 UI）。
 *
 * @param props 见 PodMetricsCardProps（podId/podName/namespace/cpuUsage/memoryUsage/restarts/cpuHistory/memHistory）
 */
export default function PodMetricsCard({
  podId,
  podName,
  namespace,
  cpuUsage,
  memoryUsage,
  restarts,
  cpuHistory,
  memHistory,
}: PodMetricsCardProps) {
  /* 唯一渐变 id：SVG id 是文档全局命名空间，多卡片必须避免串色 */
  const rawId = useId();
  const gradientBase = `kv-podmetric-${rawId.replace(/:/g, '')}`;

  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) => s.selectEntity,
  );

  /** CPU / MEM 面积路径（序列引用变化才重算） */
  const cpuGeom = useMemo(() => buildAreaPath(cpuHistory), [cpuHistory]);
  const memGeom = useMemo(() => buildAreaPath(memHistory), [memHistory]);

  /**
   * handleFocus —— 点击名称联动 3D 相机聚焦。
   *
   * 【链路】selectEntity(podId, 'pod') → CameraRig 的 selectedEntityId
   * Effect 触发 → resolveCameraFocus 解算特写机位 → 相机平滑飞行。
   * 与巡检 HUD、PodInstancedMesh 点击走完全相同的通路，保证行为一致。
   */
  const handleFocus = useCallback((): void => {
    selectEntity(podId, 'pod');
  }, [podId, selectEntity]);

  return (
    <div
      className="w-full overflow-hidden rounded-md border border-white/[0.07] bg-slate-900/60 p-2.5"
      aria-label={`Pod 指标卡：${podName}`}
    >
      {/* ============ 头部：图标 + 可点击名称 + 命名空间 ============ */}
      <div className="flex items-start gap-1.5">
        <Server className="mt-[3px] h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={handleFocus}
            title="点击在 3D 视口中聚焦该 Pod"
            className="block max-w-full truncate text-left font-mono text-[11px] font-bold tracking-wide text-slate-100 underline-offset-2 transition-colors hover:text-cyan-300 hover:underline active:scale-[0.99]"
          >
            {podName}
          </button>
          <p className="mt-0.5 flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            <span className="truncate">{namespace}</span>
            <span className="text-slate-500">·</span>
            <RefreshCw className="h-2.5 w-2.5 shrink-0" aria-hidden />
            <span className={cn('tabular-nums', restarts > 0 ? 'text-amber-400' : 'text-slate-500')}>
              {restarts} 次重启
            </span>
          </p>
        </div>
        {/* 双序列图例 */}
        <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[10px] uppercase tracking-wider">
          <span className="flex items-center gap-1" style={{ color: CPU_COLOR }}>
            <span className="h-1 w-2.5 rounded-sm" style={{ backgroundColor: CPU_COLOR }} aria-hidden />
            cpu
          </span>
          <span className="flex items-center gap-1" style={{ color: MEM_COLOR }}>
            <span className="h-1 w-2.5 rounded-sm" style={{ backgroundColor: MEM_COLOR }} aria-hidden />
            mem
          </span>
        </span>
      </div>

      {/* ============ 双轨渐变进度条 ============ */}
      <div className="mt-2 space-y-1.5">
        {/* CPU 轨 */}
        <div className="flex items-center gap-1.5">
          <Cpu className="h-2.5 w-2.5 shrink-0" style={{ color: CPU_COLOR }} aria-hidden />
          <span className="w-8 shrink-0 font-mono text-[11px] uppercase tracking-wider text-slate-500">CPU</span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full transition-[width] duration-500 ease-out"
              style={{
                width: `${Math.max(0, Math.min(100, cpuUsage))}%`,
                backgroundImage:
                  cpuUsage >= HIGH_WATERMARK
                    ? 'linear-gradient(90deg, #f59e0b 0%, #f43f5e 100%)'
                    : `linear-gradient(90deg, ${CPU_COLOR}80 0%, ${CPU_COLOR} 100%)`,
              }}
              role="progressbar"
              aria-valuenow={Math.round(cpuUsage)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="CPU 使用率"
            />
          </div>
          <span className={cn('w-10 shrink-0 text-right font-mono text-[10px] font-bold tabular-nums', watermarkTextClass(cpuUsage))}>
            {cpuUsage.toFixed(1)}%
          </span>
        </div>

        {/* MEM 轨 */}
        <div className="flex items-center gap-1.5">
          <MemoryStick className="h-2.5 w-2.5 shrink-0" style={{ color: MEM_COLOR }} aria-hidden />
          <span className="w-8 shrink-0 font-mono text-[11px] uppercase tracking-wider text-slate-500">MEM</span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full transition-[width] duration-500 ease-out"
              style={{
                width: `${Math.max(0, Math.min(100, memoryUsage))}%`,
                backgroundImage:
                  memoryUsage >= HIGH_WATERMARK
                    ? 'linear-gradient(90deg, #f59e0b 0%, #f43f5e 100%)'
                    : `linear-gradient(90deg, ${MEM_COLOR}80 0%, ${MEM_COLOR} 100%)`,
              }}
              role="progressbar"
              aria-valuenow={Math.round(memoryUsage)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="内存使用率"
            />
          </div>
          <span className={cn('w-10 shrink-0 text-right font-mono text-[10px] font-bold tabular-nums', watermarkTextClass(memoryUsage))}>
            {memoryUsage.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* ============ 近 6 周期 SVG 面积折线图（双序列叠加） ============ */}
      <div className="mt-2 rounded border border-white/[0.07]/80 bg-slate-950/40 p-1">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          width="100%"
          height={CHART_HEIGHT}
          preserveAspectRatio="none"
          role="img"
          aria-label={`CPU 与内存近 6 周期走势，当前 CPU ${cpuUsage.toFixed(1)}%、内存 ${memoryUsage.toFixed(1)}%`}
          className="overflow-visible"
        >
          <defs>
            <linearGradient id={`${gradientBase}-cpu`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CPU_COLOR} stopOpacity={0.42} />
              <stop offset="100%" stopColor={CPU_COLOR} stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${gradientBase}-mem`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={MEM_COLOR} stopOpacity={0.34} />
              <stop offset="100%" stopColor={MEM_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* 水平参考线（25 / 50 / 75），弱对比不抢主体 */}
          {[25, 50, 75].map((pct) => {
            const y = CHART_HEIGHT - CHART_PAD_Y - (pct / 100) * (CHART_HEIGHT - CHART_PAD_Y * 2);
            return (
              <line
                key={pct}
                x1={0}
                y1={y}
                x2={CHART_WIDTH}
                y2={y}
                stroke="#1e293b"
                strokeWidth={0.5}
                strokeDasharray="2 3"
      />
            );
          })}

          {/* MEM 面积 + 折线（先画，压在 CPU 下方） */}
          <path d={memGeom.area} fill={`url(#${gradientBase}-mem)`} stroke="none" />
          <polyline
            points={memGeom.line}
            fill="none"
            stroke={MEM_COLOR}
            strokeWidth={1.3}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.9}
          />

          {/* CPU 面积 + 折线（后画，视觉上更靠前强调） */}
          <path d={cpuGeom.area} fill={`url(#${gradientBase}-cpu)`} stroke="none" />
          <polyline
            points={cpuGeom.line}
            fill="none"
            stroke={CPU_COLOR}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* ============ 底部：数据周期提示 + 聚焦按钮 ============ */}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
          <Activity className="h-2.5 w-2.5" aria-hidden />
          近 6 轮采样趋势
        </span>
        <button
          type="button"
          onClick={handleFocus}
          className="shrink-0 rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-cyan-300 transition-all hover:border-cyan-400/70 hover:bg-cyan-500/20 active:scale-95"
        >
          3D 视角聚焦
        </button>
      </div>
    </div>
  );
}
