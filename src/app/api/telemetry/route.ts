/**
 * KubeVision AI — 遥测推流端点（SSE · Server-Sent Events）
 *
 * 【职责】把合成遥测引擎的状态机演进以 SSE 形式实时推送给浏览器：
 * 每 1000ms 推一帧 `data: {snapshot JSON}\n\n`，客户端（SSE 解析器）
 * 用 ReadableStreamDefaultReader 增量解析帧并写入双轨状态。
 *
 * 【R13 生产健壮性加固】
 * 1. 每 15 秒推送 `: heartbeat <ts>\n\n` 保活注释帧（支持 `?heartbeatMs=` 验证），防止反代空闲断流；
 * 2. 连接预算守卫（默认并发上限 24，单连接最大存活 30 分钟），超限或期满发送中文提示后优雅关闭；
 * 3. `request.signal` 仅在入口注册一次 `abort` 监听，并在 `safeClose()` 中显式 `removeEventListener` 与清理全部定时器；
 * 4. live 模式单次/两次瞬时采集失败（未达阈值 3）仍保持推帧（携带单调时间戳的上一稳定帧），消除断流空窗；
 * 5. 输出统一单行 JSON 结构化事件日志（connect / frame / fallback / abort / heartbeat / error / budget-limit）。
 */

import type { ChaosScenario, TelemetrySnapshot } from '@/types/cluster';
import { INITIAL_CLUSTER_SNAPSHOT } from '@/types/cluster';
import {
  TICK_INTERVAL_MS,
  applyLiveChaosOverlay,
  stepTelemetrySimulation,
} from '@/utils/syntheticEngine';
import {
  acquireHostSampler,
  collectLiveTelemetrySnapshot,
  releaseHostSampler,
} from '@/utils/liveTelemetry';
import {
  DEFAULT_MAX_SSE_LIFETIME_MS,
  DEFAULT_SSE_HEARTBEAT_MS,
  createTraceId,
  logStructuredEvent,
  recordDegradedToDemo,
  recordLiveCollectionResult,
  recordSseFrame,
  recordSseHeartbeat,
  recordSseLifetimeClose,
  releaseSseSlot,
  tryAcquireSseSlot,
} from '@/utils/telemetryMetrics';

/* ---- Next.js Route Segment 配置（必须位于模块顶层且为字面量导出） ---- */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 推流间隔（毫秒）：与引擎 TICK_INTERVAL_MS 严格一致，避免快照时间戳与墙钟漂移 */
const STREAM_INTERVAL_MS = TICK_INTERVAL_MS;

/** live 采集连续失败阈值：连续 3 次不可用再退化合成源，未达阈值前维持上一稳定帧输出 */
const LIVE_FAILURE_LIMIT = 3;

/** 合法的混沌场景全集（用于把不可信的查询参数收敛到类型域内） */
const VALID_CHAOS: readonly ChaosScenario[] = [
  'NONE',
  'POD_OOM_SWARM',
  'NODE_CPU_SPIKE',
  'NET_PACKET_LOSS',
];

/**
 * parseChaos —— 把查询参数解析为受信的 ChaosScenario。
 */
function parseChaos(raw: string | null): ChaosScenario {
  if (raw === null) return 'NONE';
  for (const scenario of VALID_CHAOS) {
    if (scenario === raw) return scenario;
  }
  return 'NONE';
}

/**
 * parseClampedIntParam —— 读取并夹逼正向整型查询参数（仅收紧、不越界）。
 */
function parseClampedIntParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * GET —— SSE 推流入口。
 */
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
  const chaos = parseChaos(url.searchParams.get('chaos'));
  const traceId = createTraceId('sse');
  const connectedAtMs = Date.now();

  const requestedMaxConn = url.searchParams.get('maxConn');
  const customMaxConn =
    requestedMaxConn !== null ? Number.parseInt(requestedMaxConn, 10) : undefined;
  const heartbeatMs = parseClampedIntParam(
    url.searchParams.get('heartbeatMs'),
    DEFAULT_SSE_HEARTBEAT_MS,
    200,
    60_000,
  );
  const maxLifetimeMs = parseClampedIntParam(
    url.searchParams.get('maxLifeMs'),
    DEFAULT_MAX_SSE_LIFETIME_MS,
    250,
    DEFAULT_MAX_SSE_LIFETIME_MS,
  );

  const encoder = new TextEncoder();

  /* ---- 连接预算闸门：超限时发送明确中文提示后优雅关闭，拒绝无声截断或 500 ---- */
  const budget = tryAcquireSseSlot(
    traceId,
    customMaxConn !== undefined && Number.isFinite(customMaxConn) ? customMaxConn : undefined,
  );

  if (!budget.acquired) {
    logStructuredEvent({
      event: 'budget-limit',
      route: '/api/telemetry',
      traceId,
      durationMs: 0,
      timestamp: new Date().toISOString(),
      attrs: {
        activeConnections: budget.activeConnections,
        maxConnections: budget.maxConnections,
      },
    });

    const notice = `当前遥测 SSE 并发连接已达上限（${budget.activeConnections}/${budget.maxConnections}），本连接已优雅关闭并建议切换本地合成推演兜底。`;
    const budgetStream = new ReadableStream<Uint8Array>({
      start(controller): void {
        try {
          controller.enqueue(encoder.encode(`: ${notice}\n\n`));
          controller.enqueue(
            encoder.encode(
              `event: budget-exceeded\ndata: ${JSON.stringify({
                code: 'SSE_BUDGET_EXCEEDED',
                notice,
                activeConnections: budget.activeConnections,
                maxConnections: budget.maxConnections,
              })}\n\n`,
            ),
          );
          controller.close();
        } catch {
          /* ignore */
        }
      },
    });

    return new Response(budgetStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw === null ? Number.NaN : Number.parseInt(sinceRaw, 10);
  const sinceFloor = Number.isFinite(since) ? since + TICK_INTERVAL_MS : 0;
  const connectionOriginTs = Math.max(
    Date.now(),
    sinceFloor,
    INITIAL_CLUSTER_SNAPSHOT.timestamp,
  );

  let snapshot: TelemetrySnapshot = {
    ...INITIAL_CLUSTER_SNAPSHOT,
    timestamp: connectionOriginTs,
  };

  let isClosed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let liveSamplerAcquired = false;

  const releaseLiveSampler = (): void => {
    if (!liveSamplerAcquired) return;
    liveSamplerAcquired = false;
    releaseHostSampler();
  };

  const onAbort = (): void => {
    logStructuredEvent({
      event: 'abort',
      route: '/api/telemetry',
      traceId,
      durationMs: Date.now() - connectedAtMs,
      timestamp: new Date().toISOString(),
      attrs: { reason: 'request-signal-abort', mode },
    });
    safeClose();
  };

  /**
   * safeClose —— 幂等的连接清理汇聚点（清理全部定时器、退订采样器、解绑 abort 监听并归还连接槽位）。
   */
  function safeClose(): void {
    if (isClosed) return;
    isClosed = true;

    request.signal.removeEventListener('abort', onAbort);
    releaseLiveSampler();
    releaseSseSlot(traceId);

    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (lifetimeTimer !== null) {
      clearTimeout(lifetimeTimer);
      lifetimeTimer = null;
    }
    if (controllerRef !== null) {
      try {
        controllerRef.close();
      } catch {
        /* 流已被消费端取消或提前结束，属预期竞态 */
      }
      controllerRef = null;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      controllerRef = controller;
      request.signal.addEventListener('abort', onAbort, { once: true });

      const safeEnqueue = (chunk: string): boolean => {
        if (isClosed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          safeClose();
          return false;
        }
      };

      logStructuredEvent({
        event: 'connect',
        route: '/api/telemetry',
        traceId,
        durationMs: 0,
        timestamp: new Date().toISOString(),
        attrs: {
          mode,
          chaos,
          activeConnections: budget.activeConnections,
          maxConnections: budget.maxConnections,
        },
      });

      /* 1. 立即发送首行注释帧与连接 traceId，防止反代缓冲阻塞连接就绪 */
      safeEnqueue(`: kubevision telemetry stream established (mode=${mode}, chaos=${chaos}, traceId=${traceId})\n\n`);

      /* 2. 15s SSE 心跳注释帧（定时保活，防负载均衡静默掐断长连接） */
      heartbeatTimer = setInterval((): void => {
        if (isClosed) return;
        const ok = safeEnqueue(`: heartbeat ${Date.now()} traceId=${traceId}\n\n`);
        if (ok) {
          recordSseHeartbeat();
          logStructuredEvent({
            event: 'heartbeat',
            route: '/api/telemetry',
            traceId,
            durationMs: Date.now() - connectedAtMs,
            timestamp: new Date().toISOString(),
          });
        }
      }, heartbeatMs);

      /* 3. 单连接最大存活时长守卫：到期优雅提示并回收句柄 */
      lifetimeTimer = setTimeout((): void => {
        if (isClosed) return;
        const notice = '遥测 SSE 连接已达最大存活窗口，即将平滑重连。';
        safeEnqueue(`: ${notice}\n\n`);
        safeEnqueue(
          `event: lifetime-expired\ndata: ${JSON.stringify({
            code: 'SSE_LIFETIME_EXPIRED',
            notice,
          })}\n\n`,
        );
        recordSseLifetimeClose();
        logStructuredEvent({
          event: 'abort',
          route: '/api/telemetry',
          traceId,
          durationMs: Date.now() - connectedAtMs,
          timestamp: new Date().toISOString(),
          attrs: { reason: 'max-lifetime-expired' },
        });
        safeClose();
      }, maxLifetimeMs);

      const startDemoTicker = (): void => {
        if (isClosed || timer !== null) return;
        timer = setInterval((): void => {
          if (isClosed) {
            if (timer !== null) {
              clearInterval(timer);
              timer = null;
            }
            return;
          }
          try {
            snapshot = stepTelemetrySimulation(snapshot, chaos);
            const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
            if (safeEnqueue(frame)) {
              recordSseFrame();
              logStructuredEvent({
                event: 'frame',
                route: '/api/telemetry',
                traceId,
                durationMs: Date.now() - connectedAtMs,
                timestamp: new Date().toISOString(),
                attrs: { mode: 'demo', seq: snapshot.seq },
              });
            }
          } catch (error) {
            logStructuredEvent({
              event: 'error',
              route: '/api/telemetry',
              traceId,
              durationMs: Date.now() - connectedAtMs,
              timestamp: new Date().toISOString(),
              attrs: {
                reason: error instanceof Error ? error.message : 'demo-step-failed',
              },
            });
            safeClose();
          }
        }, STREAM_INTERVAL_MS);
      };

      /* ---- live 模式分支 ---- */
      if (mode === 'live') {
        let liveEnabled = true;
        let liveInFlight = false;
        let liveFailures = 0;
        let liveRaw: TelemetrySnapshot = snapshot;

        const pushLiveFrame = async (): Promise<void> => {
          if (isClosed || !liveEnabled) return;
          if (liveInFlight) return;
          liveInFlight = true;
          const tickStartMs = Date.now();
          try {
            const collected = await collectLiveTelemetrySnapshot(liveRaw);
            if (isClosed) return;

            liveRaw = collected.snapshot;
            liveFailures = 0;

            const overlaid =
              chaos === 'NONE' ? liveRaw : applyLiveChaosOverlay(liveRaw, chaos);

            const frameTs = Math.max(Date.now(), snapshot.timestamp + TICK_INTERVAL_MS);
            snapshot = { ...overlaid, timestamp: frameTs };

            const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
            if (safeEnqueue(frame)) {
              recordSseFrame();
              logStructuredEvent({
                event: 'frame',
                route: '/api/telemetry',
                traceId,
                durationMs: Date.now() - tickStartMs,
                timestamp: new Date().toISOString(),
                attrs: { mode: 'live', source: collected.source, seq: snapshot.seq },
              });
            }
          } catch (error) {
            liveFailures += 1;
            const errMsg = error instanceof Error ? error.message : 'live-collect-error';
            recordLiveCollectionResult(Date.now() - tickStartMs, false);

            if (liveFailures >= LIVE_FAILURE_LIMIT) {
              liveEnabled = false;
              releaseLiveSampler();
              recordDegradedToDemo();
              logStructuredEvent({
                event: 'fallback',
                route: '/api/telemetry',
                traceId,
                durationMs: Date.now() - tickStartMs,
                timestamp: new Date().toISOString(),
                attrs: {
                  reason: 'live-consecutive-failures',
                  failures: liveFailures,
                  error: errMsg,
                },
              });
              if (timer !== null) {
                clearInterval(timer);
                timer = null;
              }
              startDemoTicker();
            } else {
              /*
               * 【R13 保活续传】未达连续失败降级阈值前，仍推送一帧携带最新有效底盘与
               * 严格单调时间戳的延续帧，彻底消除代理空闲断流或前端时间轴停滞空窗。
               */
              const carryBase = chaos === 'NONE' ? liveRaw : applyLiveChaosOverlay(liveRaw, chaos);
              const frameTs = Math.max(Date.now(), snapshot.timestamp + TICK_INTERVAL_MS);
              snapshot = { ...carryBase, timestamp: frameTs, seq: snapshot.seq + 1 };
              if (safeEnqueue(`data: ${JSON.stringify(snapshot)}\n\n`)) {
                recordSseFrame();
              }
              logStructuredEvent({
                event: 'error',
                route: '/api/telemetry',
                traceId,
                durationMs: Date.now() - tickStartMs,
                timestamp: new Date().toISOString(),
                attrs: {
                  reason: 'live-transient-failure-keepalive',
                  failures: liveFailures,
                  error: errMsg,
                },
              });
            }
          } finally {
            liveInFlight = false;
          }
        };

        liveSamplerAcquired = true;
        acquireHostSampler();
        if (isClosed) {
          releaseLiveSampler();
          return;
        }
        void pushLiveFrame().then((): void => {
          if (isClosed || !liveEnabled) return;
          timer = setInterval((): void => {
            if (isClosed) {
              liveEnabled = false;
              if (timer !== null) {
                clearInterval(timer);
                timer = null;
              }
              return;
            }
            void pushLiveFrame();
          }, STREAM_INTERVAL_MS);
        });
        return;
      }

      /* ---- demo 模式分支 ---- */
      startDemoTicker();
    },

    cancel(): void {
      logStructuredEvent({
        event: 'abort',
        route: '/api/telemetry',
        traceId,
        durationMs: Date.now() - connectedAtMs,
        timestamp: new Date().toISOString(),
        attrs: { reason: 'reader-cancel', mode },
      });
      safeClose();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
