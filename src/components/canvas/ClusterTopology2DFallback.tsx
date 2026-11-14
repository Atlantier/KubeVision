'use client';

/**
 * KubeVision AI — 第 5 层降级：2D 轻量级 SVG 集群拓扑视图（R13 Main #2 / #3）
 *
 * 【设计意图】
 * 当出现 WebGL 不受支持、图形上下文彻底丢失或 3D `<Canvas>` 异常边界触发，
 * 或用户通过工具条 / URL (`?topology=2d`) 主动切换至 2D 模式时：
 * 1. 基于 `useClusterStore` 当前权威快照，渲染零 GPU 依赖的 Control Plane → 3 Worker Rack → 24 Pod 交互拓扑；
 * 2. 完整保留节点/Pod 选中态联动（点击后同步更新左上角 `NodeInspectHUD` 与右侧 AI 诊断上下文）；
 * 3. 明确覆盖 Loading/Slow、Empty、Error 三态兜底，遵循五层降级矩阵的诚实提示契约。
 */

import { useMemo, type ReactElement } from 'react';
import {
  Activity,
  AlertTriangle,
  Box,
  Cpu,
  Layers,
  Network,
  Rotate3d,
  Server,
} from 'lucide-react';

import { CHAOS_SCENARIO_LABELS } from '@/constants/copy';
import { getDegradationTier } from '@/constants/degradationMatrix';
import { Z_CLASS } from '@/constants/zIndex';
import { useClusterStore } from '@/store/useClusterStore';
import { MASTER_ENTITY_ID } from '@/types/canvas';
import type { NodeStatus, PodEntity, PodStatus, WorkerNodeEntity } from '@/types/cluster';
import type { SelectedEntityType } from '@/types/store';
import { cn } from '@/utils/cn';
import { telemetryHealthRef } from '@/utils/telemetryHealth';

export interface ClusterTopology2DFallbackProps {
  /** 降级触发原因说明（缺省使用降级矩阵默认诚实文案） */
  readonly fallbackReason?: string | null;
  /** 是否允许尝试切回 3D WebGL 拓扑（上下文永久失败时置 false） */
  readonly canReturnTo3D?: boolean;
  /** 切回 3D 拓扑回调 */
  readonly onReturnTo3D?: () => void;
}

const NODE_STATUS_STYLE: Readonly<
  Record<
    NodeStatus,
    {
      readonly label: string;
      readonly stroke: string;
      readonly badge: string;
      readonly dot: string;
    }
  >
> = {
  Ready: {
    label: '就绪',
    stroke: '#34d399',
    badge: 'border-emerald-400/40 bg-emerald-500/20 text-emerald-300',
    dot: 'bg-emerald-400',
  },
  HighLoad: {
    label: '高负载',
    stroke: '#fbbf24',
    badge: 'border-amber-400/40 bg-amber-500/20 text-amber-300',
    dot: 'bg-amber-400',
  },
  NetworkPartition: {
    label: '网络分区',
    stroke: '#f43f5e',
    badge: 'border-rose-500/50 bg-rose-500/20 text-rose-300',
    dot: 'bg-rose-500',
  },
};

const POD_STATUS_STYLE: Readonly<
  Record<
    PodStatus,
    {
      readonly label: string;
      readonly fill: string;
      readonly card: string;
      readonly badge: string;
    }
  >
> = {
  Running: {
    label: '运行中',
    fill: '#34d399',
    card: 'border-emerald-400/30 bg-slate-900/80 hover:border-emerald-400/70',
    badge: 'text-emerald-300',
  },
  Pending: {
    label: '调度中',
    fill: '#22d3ee',
    card: 'border-cyan-400/40 bg-cyan-950/25 hover:border-cyan-400/80',
    badge: 'text-cyan-300',
  },
  CrashLoopBackOff: {
    label: '崩溃重启',
    fill: '#f43f5e',
    card: 'border-rose-500/60 bg-rose-950/30 hover:border-rose-400',
    badge: 'text-rose-300',
  },
  OOMKilled: {
    label: '内存溢出',
    fill: '#f43f5e',
    card: 'border-rose-500/60 bg-rose-950/30 hover:border-rose-400',
    badge: 'text-rose-300',
  },
  Terminating: {
    label: '终止中',
    fill: '#94a3b8',
    card: 'border-slate-500/40 bg-slate-900/60 hover:border-slate-400',
    badge: 'text-slate-300',
  },
};

const RACK_X_ANCHORS: readonly number[] = [160, 450, 740];

export default function ClusterTopology2DFallback({
  fallbackReason = null,
  canReturnTo3D = true,
  onReturnTo3D,
}: ClusterTopology2DFallbackProps): ReactElement {
  const snapshotSummary = useClusterStore((s) => s.snapshotSummary);
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const activeChaos = useClusterStore((s) => s.activeChaos);
  const statusFilter = useClusterStore((s) => s.statusFilter);
  const telemetryReadOnly = useClusterStore((s): boolean => s.telemetryReadOnly);
  const telemetrySchemaNotice = useClusterStore((s): string | null => s.telemetrySchemaNotice);
  const selectEntity = useClusterStore(
    (s): ((entityId: string | null, entityType?: SelectedEntityType | null) => void) =>
      s.selectEntity,
  );

  const tierSpec = getDegradationTier('topology-2d');

  const podsByNode = useMemo((): ReadonlyMap<string, readonly PodEntity[]> => {
    const map = new Map<string, PodEntity[]>();
    for (const node of snapshotSummary.nodes) {
      map.set(node.id, []);
    }
    for (const pod of snapshotSummary.pods) {
      const bucket = map.get(pod.nodeId);
      if (bucket) {
        bucket.push(pod);
      }
    }
    return map;
  }, [snapshotSummary.nodes, snapshotSummary.pods]);

  const sortedNodes = useMemo(
    (): readonly WorkerNodeEntity[] =>
      [...snapshotSummary.nodes].sort((a, b) => a.rackIndex - b.rackIndex),
    [snapshotSummary.nodes],
  );

  const hasMalformedSnapshot =
    !snapshotSummary ||
    !Array.isArray(snapshotSummary.nodes) ||
    !Array.isArray(snapshotSummary.pods) ||
    !Number.isFinite(snapshotSummary.clusterHealthScore);

  const isEmptySnapshot =
    !hasMalformedSnapshot &&
    snapshotSummary.nodes.length === 0 &&
    snapshotSummary.pods.length === 0;

  const healthState = telemetryHealthRef.current;
  const isSlowTelemetry =
    telemetryReadOnly ||
    healthState.readOnly ||
    healthState.frameJitterMs > 2500 ||
    (healthState.lastFrameAtMs > 0 && Date.now() - healthState.lastFrameAtMs > 3500);

  const healthToneClass =
    snapshotSummary.clusterHealthScore >= 85
      ? 'text-emerald-300'
      : snapshotSummary.clusterHealthScore >= 60
        ? 'text-amber-300'
        : 'text-rose-300';

  const masterSelected = selectedEntityId === MASTER_ENTITY_ID;

  return (
    <section
      aria-label="2D 集群拓扑降级面板"
      data-testid="topology-2d-fallback"
      className={cn(
        'relative h-full w-full overflow-y-auto bg-slate-950/95 pb-24 pl-3 pr-16 pt-28 lg:pb-16 lg:pl-[19.5rem] lg:pt-4',
        Z_CLASS.CANVAS_BASE,
      )}
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
        {/* 第 5 层降级诚实状态条 */}
        <header
          role="status"
          aria-live="polite"
          className="kv-blur-panel flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/40 bg-slate-900/90 px-3.5 py-2.5"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <Layers className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-amber-400/40 bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-200">
                  T5 · {tierSpec.name}
                </span>
                {isSlowTelemetry ? (
                  <span className="rounded border border-cyan-400/40 bg-cyan-500/20 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200">
                    {telemetrySchemaNotice ?? '遥测节流或本地兜底运行中'}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-slate-200">
                {fallbackReason || tierSpec.userFacingPrompt}
              </p>
            </div>
          </div>

          {canReturnTo3D && onReturnTo3D ? (
            <button
              type="button"
              onClick={onReturnTo3D}
              data-testid="switch-to-3d-button"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-400/50 bg-cyan-500/20 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              <Rotate3d className="h-3.5 w-3.5" aria-hidden="true" />
              <span>切回 3D 拓扑</span>
            </button>
          ) : null}
        </header>

        {/* 集群健康 KPI 摘要条 */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="kv-blur-panel rounded-lg border border-slate-800 bg-slate-900/75 px-3 py-2">
            <div className="flex items-center gap-1 font-mono text-[10px] text-slate-400">
              <Activity className="h-3 w-3 text-cyan-300" aria-hidden="true" />
              <span>健康分</span>
            </div>
            <div className={cn('mt-0.5 font-mono text-base font-bold tabular-nums', healthToneClass)}>
              {hasMalformedSnapshot ? '--' : `${snapshotSummary.clusterHealthScore.toFixed(0)}%`}
            </div>
          </div>

          <div className="kv-blur-panel rounded-lg border border-slate-800 bg-slate-900/75 px-3 py-2">
            <div className="flex items-center gap-1 font-mono text-[10px] text-slate-400">
              <Network className="h-3 w-3 text-cyan-300" aria-hidden="true" />
              <span>入口吞吐</span>
            </div>
            <div className="mt-0.5 font-mono text-base font-bold tabular-nums text-slate-100">
              {hasMalformedSnapshot ? '--' : `${snapshotSummary.totalQps} QPS`}
            </div>
          </div>

          <div className="kv-blur-panel rounded-lg border border-slate-800 bg-slate-900/75 px-3 py-2">
            <div className="flex items-center gap-1 font-mono text-[10px] text-slate-400">
              <AlertTriangle className="h-3 w-3 text-amber-300" aria-hidden="true" />
              <span>活跃告警</span>
            </div>
            <div className="mt-0.5 font-mono text-base font-bold tabular-nums text-slate-100">
              {hasMalformedSnapshot ? '--' : `${snapshotSummary.activeAlerts.length} 条`}
            </div>
          </div>

          <div className="kv-blur-panel rounded-lg border border-slate-800 bg-slate-900/75 px-3 py-2">
            <div className="flex items-center gap-1 font-mono text-[10px] text-slate-400">
              <Cpu className="h-3 w-3 text-emerald-300" aria-hidden="true" />
              <span>演练场景</span>
            </div>
            <div className="mt-0.5 truncate font-mono text-xs font-semibold text-cyan-300">
              {CHAOS_SCENARIO_LABELS[activeChaos]}
            </div>
          </div>
        </div>

        {/* 异常态与空态兜底 */}
        {hasMalformedSnapshot ? (
          <div
            role="alert"
            className="flex flex-col items-center justify-center rounded-xl border border-rose-500/40 bg-slate-900/80 px-4 py-10 text-center"
          >
            <AlertTriangle className="h-8 w-8 text-rose-400" aria-hidden="true" />
            <h2 className="mt-2 text-sm font-semibold text-slate-100">
              当前快照结构异常，无法绘制 2D 集群拓扑
            </h2>
            <p className="mt-1 text-xs text-slate-300">
              等待下一帧有效遥测快照覆盖异常数据，或尝试切换回 3D 视口。
            </p>
          </div>
        ) : isEmptySnapshot ? (
          <div
            role="status"
            className="flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-slate-900/75 px-4 py-10 text-center"
          >
            <Server className="h-8 w-8 text-cyan-300" aria-hidden="true" />
            <h2 className="mt-2 text-sm font-semibold text-slate-100">
              暂无集群节点与 Pod 拓扑数据
            </h2>
            <p className="mt-1 text-xs text-slate-300">
              正在等待遥测引擎推送首个完整快照…
            </p>
          </div>
        ) : (
          <>
            {/* SVG 拓扑连线总览图 */}
            <div className="kv-blur-panel rounded-xl border border-slate-800 bg-slate-900/75 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => selectEntity(MASTER_ENTITY_ID, 'master')}
                  aria-pressed={masterSelected}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
                    masterSelected
                      ? 'border-cyan-400 bg-cyan-500/20 text-cyan-100'
                      : 'border-white/[0.12] bg-slate-950/70 text-slate-200 hover:border-cyan-400/60',
                  )}
                >
                  <span className="h-2 w-2 rounded-full bg-cyan-400" aria-hidden="true" />
                  <span>控制平面 (API Server · Scheduler)</span>
                </button>
                <span className="font-mono text-[11px] text-slate-400">
                  点击任意节点或 Pod 卡片可同步巡检与 AI 诊断上下文
                </span>
              </div>

              <svg
                role="img"
                aria-label="2D 集群拓扑降级视图"
                viewBox="0 0 900 170"
                className="h-auto w-full rounded-lg border border-slate-800/80 bg-slate-950/80"
              >
                {/* 控制平面连接线 */}
                {sortedNodes.map((node, index) => {
                  const targetX = RACK_X_ANCHORS[node.rackIndex] ?? RACK_X_ANCHORS[index] ?? 450;
                  const meta = NODE_STATUS_STYLE[node.status];
                  return (
                    <path
                      key={`link-${node.id}`}
                      d={`M 450 42 C 450 86, ${targetX} 72, ${targetX} 112`}
                      fill="none"
                      stroke={meta.stroke}
                      strokeWidth={node.status === 'NetworkPartition' ? 2.5 : 2}
                      strokeDasharray={node.status === 'NetworkPartition' ? '6 4' : undefined}
                      opacity={0.8}
                    />
                  );
                })}

                {/* 控制平面节点 */}
                <g transform="translate(360, 12)">
                  <rect
                    width="180"
                    height="32"
                    rx="8"
                    fill="#0f172a"
                    stroke={masterSelected ? '#22d3ee' : '#38bdf8'}
                    strokeWidth={masterSelected ? 2.2 : 1.5}
                  />
                  <text
                    x="90"
                    y="20"
                    textAnchor="middle"
                    fill="#e2e8f0"
                    fontSize="12"
                    fontFamily="ui-monospace, monospace"
                  >
                    控制平面 Core
                  </text>
                </g>

                {/* 三个 Worker 机架汇总框 */}
                {sortedNodes.map((node, index) => {
                  const cx = RACK_X_ANCHORS[node.rackIndex] ?? RACK_X_ANCHORS[index] ?? 450;
                  const meta = NODE_STATUS_STYLE[node.status];
                  const rackPods = podsByNode.get(node.id) ?? [];
                  const isNodeSel = selectedEntityId === node.id;

                  return (
                    <g key={`svg-node-${node.id}`} transform={`translate(${cx - 115}, 112)`}>
                      <rect
                        width="230"
                        height="48"
                        rx="8"
                        fill="#0f172a"
                        stroke={isNodeSel ? '#22d3ee' : meta.stroke}
                        strokeWidth={isNodeSel ? 2.4 : 1.4}
                      />
                      <text
                        x="12"
                        y="18"
                        fill="#f8fafc"
                        fontSize="11"
                        fontWeight="600"
                        fontFamily="ui-monospace, monospace"
                      >
                        {node.name} ({meta.label})
                      </text>
                      <text
                        x="12"
                        y="35"
                        fill="#cbd5e1"
                        fontSize="10"
                        fontFamily="ui-monospace, monospace"
                      >
                        CPU {node.cpuUsage.toFixed(0)}% · 内存 {node.memUsage.toFixed(0)}% ·{' '}
                        {rackPods.length} Pod
                      </text>
                      {/* 右侧状态点阵预览 */}
                      {rackPods.slice(0, 8).map((pod, pIdx) => {
                        const col = pIdx % 4;
                        const row = Math.floor(pIdx / 4);
                        return (
                          <circle
                            key={`dot-${pod.id}`}
                            cx={182 + col * 11}
                            cy={17 + row * 13}
                            r="3.6"
                            fill={POD_STATUS_STYLE[pod.status].fill}
                          />
                        );
                      })}
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* 三机架与 24 Pod 交互网格 */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              {sortedNodes.map((node) => {
                const nodeMeta = NODE_STATUS_STYLE[node.status];
                const rackPods = podsByNode.get(node.id) ?? [];
                const isNodeSelected = selectedEntityId === node.id;

                return (
                  <article
                    key={node.id}
                    className={cn(
                      'kv-blur-panel flex flex-col rounded-xl border bg-slate-900/75 p-3 transition-colors',
                      isNodeSelected ? 'border-cyan-400/80 ring-1 ring-cyan-400/50' : 'border-slate-800',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectEntity(node.id, 'node')}
                      aria-pressed={isNodeSelected}
                      aria-label={`选择节点 ${node.name}`}
                      className="flex w-full items-start justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2 text-left transition-colors hover:border-cyan-400/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn('h-2 w-2 shrink-0 rounded-full', nodeMeta.dot)}
                            aria-hidden="true"
                          />
                          <span className="truncate font-mono text-xs font-semibold text-slate-100">
                            {node.name}
                          </span>
                        </div>
                        <p className="mt-0.5 font-mono text-[10px] text-slate-400">
                          {node.ip} · {node.networkMbps.toFixed(0)} Mbps
                        </p>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px]',
                          nodeMeta.badge,
                        )}
                      >
                        {nodeMeta.label}
                      </span>
                    </button>

                    <div className="mt-2 grid grid-cols-2 gap-1.5 font-mono text-[10px] text-slate-300">
                      <div className="rounded bg-slate-950/60 px-2 py-1">
                        CPU <span className="font-semibold text-cyan-300">{node.cpuUsage.toFixed(0)}%</span>
                      </div>
                      <div className="rounded bg-slate-950/60 px-2 py-1">
                        内存 <span className="font-semibold text-slate-100">{node.memUsage.toFixed(0)}%</span>
                      </div>
                    </div>

                    <div className="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                      {rackPods.map((pod) => {
                        const podMeta = POD_STATUS_STYLE[pod.status];
                        const isPodSelected = selectedEntityId === pod.id;
                        const isFilteredOut =
                          statusFilter !== 'ALL' && pod.status !== statusFilter;

                        return (
                          <button
                            key={pod.id}
                            type="button"
                            onClick={() => selectEntity(pod.id, 'pod')}
                            aria-pressed={isPodSelected}
                            aria-label={`选择 Pod ${pod.name}`}
                            className={cn(
                              'flex flex-col justify-between rounded-lg border px-2 py-1.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
                              podMeta.card,
                              isPodSelected && 'border-cyan-400 ring-1 ring-cyan-400/70',
                              isFilteredOut && 'opacity-35',
                            )}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="inline-flex min-w-0 items-center gap-1">
                                <Box
                                  className={cn('h-3 w-3 shrink-0', podMeta.badge)}
                                  aria-hidden="true"
                                />
                                <span className="truncate font-mono text-[11px] font-medium text-slate-100">
                                  {pod.name}
                                </span>
                              </span>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-1 font-mono text-[10px]">
                              <span className={podMeta.badge}>{podMeta.label}</span>
                              <span className="text-slate-300 tabular-nums">
                                {pod.cpuUsage.toFixed(0)}% / {pod.memoryUsage.toFixed(0)}%
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
