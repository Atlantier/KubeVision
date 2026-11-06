'use client';

/**
 * KubeVision AI — 开发者性能遥测浮层（PerfTelemetryHUD）
 *
 * 【职责】以 2Hz 从瞬态轨 telemetryTransientRef.glStats 采样，展示真实的
 * WebGL 渲染指标，为性能优化提供可观测依据：
 * - **FPS**：带迷你折线图（近 24 个采样点），趋势比单点数值更有意义；
 * - **Frame Time**：窗口平均单帧耗时（ms）；
 * - **Draw Calls**：WebGL 实际绘制调用数——这是「InstancedMesh 批量渲染
 *   优化」最直接的证据：48 个 Pod 若逐个 Mesh 渲染需 48+ 次调用，
 *   用 InstancedMesh 后应稳定在个位数；
 * - **Triangles**：提交的三角形面数；
 * - **SSE Latency**：遥测帧到达间隔（说明见下）；
 * - **Edge Worker**：端侧推理 Worker 的状态机当前态。
 *
 * 【零重渲染契约】数据源是模块级可变单例，本组件用 setInterval 定时
 * **读取并 setState**（2Hz 是低频，可接受），而写入端（GlStatsCollector）
 * 在 useFrame 内直接赋值，绝不触发 React 更新。二者分离是本项目
 * 「双轨状态」架构的体现：高频采集零重渲染，低频展示才进 React。
 *
 * 【为何 2Hz 采样而非每帧】HUD 只是给人看的，人眼对 2Hz 的数字刷新
 * 已经足够；每帧 setState 会让 React 协调器占用宝贵的帧预算，
 * 反而拖累它要测量的对象（观察者效应）。
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Activity, Cpu, Gauge, Layers, Radio, Triangle, X } from 'lucide-react';

import { cn } from '@/utils/cn';
import { telemetryTransientRef } from '@/store/useTelemetryRef';
import { useClusterStore } from '@/store/useClusterStore';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** HUD 采样间隔（毫秒）——2Hz 足够人眼阅读，又不会占用帧预算 */
const HUD_SAMPLE_INTERVAL_MS = 500;

/** FPS 迷你折线保留的采样点数 */
const FPS_HISTORY_LENGTH = 24;

/** 迷你折线图 SVG 视口（无单位，配合 preserveAspectRatio="none" 拉伸） */
const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 22;

/** 帧率健康阈值（与全局健康分档口径一致：60 优秀 / 40 及格） */
const FPS_GOOD = 55;
const FPS_WARN = 40;

/* ========================================================================== */
/* 子组件：FPS 迷你折线图                                                       */
/* ========================================================================== */

/**
 * FpsSparkline —— FPS 迷你面积折线图。
 *
 * 【核心数学】把 FPS 序列线性映射到 SVG 高度：
 *   y = H − (value / maxFps) · H
 * 其中 maxFps 取 60（目标帧率）作为纵轴上限，超出部分会被 clamp——
 * 这样 60FPS 永远贴顶，一眼就能看出是否掉帧。
 *
 * 横轴按索引等距分布；序列不足时左对齐（右端留空），
 * 避免启动初期把 2 个点拉伸成满屏曲线造成"帧率剧烈波动"的错觉。
 *
 * @param values 历史 FPS 值（最多 FPS_HISTORY_LENGTH 个）
 */
function FpsSparkline({ values }: { readonly values: readonly number[] }) {
  if (values.length < 2) {
    return (
      <div className="flex h-[22px] items-center justify-center font-mono text-[10px] text-slate-700">
        采样预热中…
      </div>
    );
  }

  const maxFps = 60;
  const stepX = SPARK_WIDTH / (FPS_HISTORY_LENGTH - 1);

  /* 构造折线与面积路径 */
  const points: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const clamped = Math.max(0, Math.min(maxFps, values[i]));
    const x = i * stepX;
    const y = SPARK_HEIGHT - (clamped / maxFps) * SPARK_HEIGHT;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const line = points.join(' ');
  const firstX = 0;
  const lastX = (values.length - 1) * stepX;
  const area = `M ${firstX},${SPARK_HEIGHT} L ${points.join(' L ')} L ${lastX.toFixed(2)},${SPARK_HEIGHT} Z`;

  /* 曲线颜色随当前帧率分档（最后一点代表当前） */
  const current = values[values.length - 1];
  const stroke = current >= FPS_GOOD ? '#34d399' : current >= FPS_WARN ? '#fbbf24' : '#f43f5e';
  const fill = current >= FPS_GOOD ? '#34d399' : current >= FPS_WARN ? '#fbbf24' : '#f43f5e';

  return (
    <svg
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      width="100%"
      height={SPARK_HEIGHT}
      preserveAspectRatio="none"
      role="img"
      aria-label={`FPS 趋势，当前 ${current}`}
      className="overflow-visible"
    >
      <path d={area} fill={fill} fillOpacity={0.18} stroke="none" />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 60FPS 参考线（贴顶虚线，便于判断是否掉帧） */}
      <line x1={0} y1={0.5} x2={SPARK_WIDTH} y2={0.5} stroke="#334155" strokeWidth={0.5} strokeDasharray="2 3" />
      {/* 40FPS 警戒线 */}
      <line
        x1={0}
        y1={SPARK_HEIGHT - (FPS_WARN / maxFps) * SPARK_HEIGHT}
        x2={SPARK_WIDTH}
        y2={SPARK_HEIGHT - (FPS_WARN / maxFps) * SPARK_HEIGHT}
        stroke="#7f1d1d"
        strokeWidth={0.5}
        strokeDasharray="2 3"
      />
    </svg>
  );
}

/* ========================================================================== */
/* 主组件                                                                      */
/* ========================================================================== */

/** HUD 单次采样快照（一次性把所有字段取出，避免多次读单例） */
interface PerfSample {
  readonly fps: number;
  readonly frameTimeMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly sseLatencyMs: number;
  readonly workerStatus: string;
  readonly nodeCount: number;
  readonly podCount: number;
  readonly alertCount: number;
}

/** PerfTelemetryHUD 的 Props */
export interface PerfTelemetryHUDProps {
  /** 关闭回调（点击右上角 × 或再次按 Shift+P） */
  readonly onClose: () => void;
}

/**
 * PerfTelemetryHUD —— 开发者性能遥测浮层。
 */
export default function PerfTelemetryHUD({ onClose }: PerfTelemetryHUDProps) {
  const [sample, setSample] = useState<PerfSample | null>(null);
  const [fpsHistory, setFpsHistory] = useState<readonly number[]>([]);
  const [hasData, setHasData] = useState<boolean>(false);

  /* 实体计数来自响应轨（低频快照摘要），与瞬态轨的高频指标合并展示 */
  const nodeCount = useClusterStore((s): number => s.snapshotSummary.nodes.length);
  const podCount = useClusterStore((s): number => s.snapshotSummary.pods.length);
  const alertCount = useClusterStore((s): number => s.snapshotSummary.activeAlerts.length);

  /** 保存最新的实体计数，供定时器闭包读取（避免重建定时器） */
  const countsRef = useRef<{ nodes: number; pods: number; alerts: number }>({
    nodes: 0,
    pods: 0,
    alerts: 0,
  });
  countsRef.current = { nodes: nodeCount, pods: podCount, alerts: alertCount };

  /* ---- 2Hz 采样 ---- */
  useEffect(() => {
    const sampleOnce = (): void => {
      const stats = telemetryTransientRef.glStats;
      const counts = countsRef.current;

      /* 尚未收到任何有效采样（fps=0 且 frameTime=0）→ 保持 loading 态 */
      const valid = stats.fps > 0 || stats.frameTimeMs > 0;
      if (valid) setHasData(true);

      setSample({
        fps: stats.fps,
        frameTimeMs: stats.frameTimeMs,
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        sseLatencyMs: stats.sseLatencyMs,
        workerStatus: stats.workerStatus,
        nodeCount: counts.nodes,
        podCount: counts.pods,
        alertCount: counts.alerts,
      });

      /* FPS 历史：仅在有效值（>0）时入列，避免启动初期的 0 把曲线压平 */
      if (stats.fps > 0) {
        setFpsHistory((prev) => {
          const next = [...prev, stats.fps];
          return next.length > FPS_HISTORY_LENGTH ? next.slice(-FPS_HISTORY_LENGTH) : next;
        });
      }
    };

    /* 立即采一次，避免开面板空等 500ms */
    sampleOnce();
    const timer = window.setInterval(sampleOnce, HUD_SAMPLE_INTERVAL_MS);
    return (): void => {
      window.clearInterval(timer);
    };
  }, []);

  /** FPS 分档色 */
  const fpsTone =
    sample === null || sample.fps === 0
      ? 'text-slate-600'
      : sample.fps >= FPS_GOOD
        ? 'text-emerald-400'
        : sample.fps >= FPS_WARN
          ? 'text-amber-400'
          : 'text-rose-400';

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18 }}
      className="kv-panel pointer-events-auto absolute right-3 top-16 z-40 w-[268px] p-2.5"
      role="region"
      aria-label="性能遥测 HUD"
    >
      {/* ============ 头部 ============ */}
      <div className="flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-300">
          WebGL 渲染与遥测性能
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-slate-600">2hz</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭性能遥测"
          className="shrink-0 rounded p-0.5 text-slate-500 transition-colors hover:text-rose-400"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>

      {/* ============ FPS 区块（数值 + 迷你折线） ============ */}
      <div className="mt-2 rounded border border-slate-800 bg-slate-950/50 p-1.5">
        <div className="flex items-baseline gap-1.5">
          <Gauge className={cn('h-3 w-3 shrink-0', fpsTone)} aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">fps</span>
          <span className={cn('ml-auto font-mono text-[15px] font-bold leading-none tabular-nums', fpsTone)}>
            {sample !== null && sample.fps > 0 ? sample.fps : hasData ? '0' : '--'}
          </span>
        </div>
        {/* 迷你折线趋势图 */}
        <div className="mt-1">
          <FpsSparkline values={fpsHistory} />
        </div>
      </div>

      {/* ============ 指标网格 ============ */}
      <div className="mt-1.5 grid grid-cols-2 gap-1">
        {/* Frame Time */}
        <div className="rounded border border-slate-800 bg-slate-950/40 px-1.5 py-1">
          <p className="flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-600">
            <Cpu className="h-2 w-2" aria-hidden />
            帧耗时
          </p>
          <p className="font-mono text-[11px] font-bold tabular-nums text-slate-200">
            {sample !== null && sample.frameTimeMs > 0 ? `${sample.frameTimeMs.toFixed(1)}` : '--'}
            <span className="ml-0.5 text-[10px] font-normal text-slate-600">ms</span>
          </p>
        </div>

        {/* Draw Calls */}
        <div className="rounded border border-slate-800 bg-slate-950/40 px-1.5 py-1">
          <p className="flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-600">
            <Layers className="h-2 w-2" aria-hidden />
            draws
          </p>
          <p className="font-mono text-[11px] font-bold tabular-nums text-cyan-300">
            {sample !== null && sample.drawCalls > 0 ? sample.drawCalls : '--'}
          </p>
        </div>

        {/* Triangles */}
        <div className="rounded border border-slate-800 bg-slate-950/40 px-1.5 py-1">
          <p className="flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-600">
            <Triangle className="h-2 w-2" aria-hidden />
            三角面
          </p>
          <p className="font-mono text-[11px] font-bold tabular-nums text-slate-200">
            {sample !== null && sample.triangles > 0 ? sample.triangles.toLocaleString('en-US') : '--'}
          </p>
        </div>

        {/* SSE Latency */}
        <div className="rounded border border-slate-800 bg-slate-950/40 px-1.5 py-1">
          <p className="flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-600">
            <Radio className="h-2 w-2" aria-hidden />
            遥测流
          </p>
          <p className="font-mono text-[11px] font-bold tabular-nums text-slate-200">
            {sample !== null && sample.sseLatencyMs > 0 ? `${sample.sseLatencyMs}` : '--'}
            <span className="ml-0.5 text-[10px] font-normal text-slate-600">ms</span>
          </p>
        </div>
      </div>

      {/* ============ 端侧 Worker 状态 ============ */}
      <div className="mt-1.5 flex items-center gap-1 rounded border border-slate-800 bg-slate-950/40 px-1.5 py-1">
        <span className="font-mono text-[10px] tracking-wider text-slate-600">端侧</span>
        <span
          className={cn(
            'ml-auto truncate font-mono text-[11px] font-bold tabular-nums',
            /\bREADY\b/.test(sample?.workerStatus ?? '')
              ? 'text-emerald-400'
              : sample?.workerStatus === 'INFERENCING'
                ? 'text-cyan-400'
                : sample?.workerStatus === 'ERROR'
                  ? 'text-rose-400'
                  : 'text-slate-400',
          )}
          title={sample?.workerStatus}
        >
          {sample?.workerStatus ?? '--'}
        </span>
      </div>

      {/* ============ 实体计数 ============ */}
      <div className="mt-1.5 border-t border-slate-800 pt-1 font-mono text-[10px] uppercase tracking-wider text-slate-600">
        {sample !== null
          ? `${sample.nodeCount} 节点 / ${sample.podCount} Pod / ${sample.alertCount} 告警`
          : '--'}
      </div>

      {/* ============ 数据来源说明 ============ */}
      <p className="mt-1 font-mono text-[10px] leading-relaxed text-slate-700">
        数据源：telemetryTransientRef.glStats（瞬态轨 · 零重渲染采样）
      </p>
    </motion.div>
  );
}
