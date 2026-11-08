/**
 * KubeVision AI — 遥测推流端点（SSE · Server-Sent Events）
 *
 * 【职责】把合成遥测引擎的状态机演进以 SSE 形式实时推送给浏览器：
 * 每 1000ms 推一帧 `data: {snapshot JSON}\n\n`，客户端（SSE 解析器）
 * 用 ReadableStreamDefaultReader 增量解析帧并写入双轨状态。
 *
 * 【为何强制 dynamic + nodejs runtime】
 * - `dynamic = 'force-dynamic'`：SSE 是无限长响应，绝不能被 Next.js 的
 *   静态优化/缓存预渲染捕获（否则构建期就会挂住或产出静态空流）；
 * - `runtime = 'nodejs'`：需要 Node 的 ReadableStream + setInterval 长驻能力，
 *   Edge runtime 有执行时长限制且不支持长时间的定时推送。
 *
 * 【防缓冲响应头（每一项都不可省）】
 * - `Content-Type: text/event-stream; charset=utf-8`
 *     SSE 的 MIME 契约；显式声明 charset 避免非 ASCII 实体名（如中文告警）乱码。
 * - `Cache-Control: no-cache, no-transform`
 *     no-cache 禁止中间层缓存帧；**no-transform 尤其关键**——它会阻止
 *     代理/压缩中间件对响应做 gzip 或缓冲改写（压缩会攒满缓冲区才输出，
 *     直接摧毁实时性）。
 * - `Connection: keep-alive`
 *     保持长连接语义（HTTP/1.1 下属显式提示，部分代理据此不主动断开）。
 * - `X-Accel-Buffering: no`
 *     nginx 专用指令：关闭 proxy_buffering。这是 SSE 在反代后"一帧不推"
 *     的最常见元凶，缺了它线上环境会表现为「连上了但永远没数据」。
 *
 * 【连接生命周期与状态锁（本端点的核心安全机制）】
 * `isClosed` 被**提升到 ReadableStream 构造器外层作用域**，使其同时被
 * `start` 内部的 interval 回调与 `cancel` 方法共享（这是关键设计：
 * 若把它放在 start 内部，cancel 就够不到它，只能依赖 abort 兜底，
 * 而部分客户端在 reader.cancel() 时并不保证触发 request.signal abort，
 * 定时器会成为游离句柄持续演进，造成 CPU/内存泄漏）。
 *
 * 清理路径共三条，全部汇聚到幂等的 `safeClose()`：
 * 1. `request.signal` 的 abort（浏览器关闭标签页 / 网络中断）；
 * 2. `ReadableStream.cancel()`（消费端 reader.cancel()，与 abort 互为补充）；
 * 3. interval 回调内的写入异常 / enqueue 抛 ERR_INVALID_STATE。
 * 每次 tick 先查 isClosed 再写入，因此**绝不可能向已关闭的流写入数据**
 * （否则 Node 进程会因未捕获的 ERR_INVALID_STATE 崩溃）。
 *
 * 【mode=demo|live 的语义】
 * - demo：由合成引擎 stepTelemetrySimulation 演进（本轮实现，含 chaos）；
 * - live：**真实遥测**。每秒调用 collectLiveTelemetrySnapshot 采集真实数据：
 *   配置了 K8S_API_SERVER/BEARER_TOKEN 时走真实 K8s API（nodes/pods/metrics），
 *   否则走 Node.js 宿主机真实硬件桥接（逐核 CPU delta / 物理内存 / 进程 RSS /
 *   Linux 网卡增量）。两条链路都**不含 Math.random()**，绝不用随机数冒充实时。
 */

import type { ChaosScenario, TelemetrySnapshot } from '@/types/cluster';
import { INITIAL_CLUSTER_SNAPSHOT } from '@/types/cluster';
import {
  TICK_INTERVAL_MS,
  applyLiveChaosOverlay,
  stepTelemetrySimulation,
} from '@/utils/syntheticEngine';
import { collectLiveTelemetrySnapshot } from '@/utils/liveTelemetry';

/* ---- Next.js Route Segment 配置（必须位于模块顶层且为字面量导出） ---- */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 推流间隔（毫秒）：与引擎 TICK_INTERVAL_MS 严格一致，避免快照时间戳与墙钟漂移 */
const STREAM_INTERVAL_MS = TICK_INTERVAL_MS;

/** 合法的混沌场景全集（用于把不可信的查询参数收敛到类型域内） */
const VALID_CHAOS: readonly ChaosScenario[] = [
  'NONE',
  'POD_OOM_SWARM',
  'NODE_CPU_SPIKE',
  'NET_PACKET_LOSS',
];

/**
 * parseChaos —— 把查询参数解析为受信的 ChaosScenario。
 *
 * 【安全契约】查询参数来自不可信输入，绝不能直接 cast 成 ChaosScenario
 * （否则非法值会流入引擎分支导致状态机行为不可预期）。
 * 此处做白名单校验，任何非法/缺失值一律回落 'NONE'（稳态）。
 *
 * @param raw URL 查询参数 chaos 的原始值
 * @returns 白名单内的合法场景，或 'NONE'
 */
function parseChaos(raw: string | null): ChaosScenario {
  if (raw === null) return 'NONE';
  for (const scenario of VALID_CHAOS) {
    if (scenario === raw) return scenario;
  }
  return 'NONE';
}

/**
 * GET —— SSE 推流入口。
 *
 * @param request 标准 Request；其 signal 用于感知客户端断开
 * @returns 永不结束的 text/event-stream 响应
 */
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
  const chaos = parseChaos(url.searchParams.get('chaos'));

  /**
   * since —— 客户端上一次收到的快照时间戳（epoch 毫秒），用于**重连续接**。
   *
   * 【解决的问题：切换 chaos 导致时钟倒退】
   * SSE 每次重建连接都从 INITIAL_CLUSTER_SNAPSHOT 起步，而该种子快照的
   * timestamp 是编译期固定常量。若客户端已推进到 T+12s，重连后服务端从
   * T+0s 重新开始，快照时间戳就会**倒退 12 秒**——实测在 chaos 切换瞬间
   * 观察到 −12000ms 的跳变。后果：
   * 1. 依赖时间戳排序的下游（告警时序、日志、趋势图）会出现乱序；
   * 2. 本地降级引擎以时间戳为演进时钟，倒退会导致重复 tick。
   *
   * 因此服务端接受 since 参数，把种子快照的 timestamp 抬升到
   * max(种子时间戳, since)，保证时钟单调不回退。
   */
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw === null ? Number.NaN : Number.parseInt(sinceRaw, 10);

  /* 每个连接独立的演进状态：多客户端互不干扰 */
  let snapshot: TelemetrySnapshot = INITIAL_CLUSTER_SNAPSHOT;

  /* 重连续接：把起始时间戳抬到客户端已见过的位置之后（期间的数据形态仍取种子稳态） */
  if (Number.isFinite(since) && since > snapshot.timestamp) {
    snapshot = { ...snapshot, timestamp: since };
  }

  /** 文本编码器：SSE 必须以 UTF-8 字节流写入（含中文告警消息） */
  const encoder = new TextEncoder();

  /* ====================================================================== */
  /* 共享连接状态（提升到外层作用域，使 start 与 cancel 都能访问）             */
  /* ====================================================================== */

  /** 连接状态锁：true 表示流已关闭（abort / 消费端 cancel / 写入异常） */
  let isClosed = false;

  /** 定时器句柄（环境无关类型：Node 与浏览器均可由 clearInterval 清理） */
  let timer: ReturnType<typeof setInterval> | null = null;

  /** controller 引用：供 cancel 路径关闭流（start 时注入） */
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  /**
   * safeClose —— 幂等的连接清理函数（三条清理路径的唯一汇聚点）。
   *
   * 【三重安全】
   * 1. isClosed 守卫：重复调用直接返回，杜绝重复 clearInterval；
   * 2. clearInterval 前置：先停定时器再关 controller，防止关闭瞬间
   *    仍有 tick 在队列中尝试 enqueue；
   * 3. controller.close() 包 try/catch：流可能已因客户端断开而处于
   *    closed/errored 态，此时 close() 会抛错，属预期竞态，静默吞掉。
   */
  const safeClose = (): void => {
    if (isClosed) return;
    isClosed = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (controllerRef !== null) {
      try {
        controllerRef.close();
      } catch {
        /* 流已被取消/已关闭：无需处理，属正常竞态 */
      }
      controllerRef = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      controllerRef = controller;

      /**
       * safeEnqueue —— 带状态锁与异常兜底的帧写入。
       *
       * @param chunk 待写入的完整 SSE 帧文本（含结尾 \n\n 分帧符）
       * @returns 写入成功 true；流已关闭或写入异常 false
       */
      const safeEnqueue = (chunk: string): boolean => {
        if (isClosed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          /* controller 已关闭（客户端抢跑断开）：转入安全清理并回报失败 */
          safeClose();
          return false;
        }
      };

      /* ---- 1. 立即推送注释帧：冲刷响应头，让客户端立刻进入 CONNECTED ---- */
      /* SSE 注释行以 ':' 开头，浏览器 EventSource 与自研解析器都必须忽略；
         它的真实作用是「立刻产生第一次 flush」，避免反代/浏览器攒缓冲导致
         客户端长时间处于"连接中"状态。 */
      safeEnqueue(`: kubevision telemetry stream established (mode=${mode}, chaos=${chaos})\n\n`);

      /* ---- 2. live 模式：真实遥测（宿主机硬件桥接 / 真实 K8s API） ---- */
      if (mode === 'live') {
        /**
         * 【为什么这里曾经是"空壳"】旧实现推一行 "connector is not wired"
         * 注释就 return 挂起——用户切到「实时」后 3D 场景彻底静止，
         * 从观感上看与死机无异。把"没有连接器"如实说明本身是对的，
         * 但**停住画面**不是一个可接受的实现。
         *
         * 【现在】每秒调用 collectLiveTelemetrySnapshot 采集**真实**数据：
         * - 配了 K8S_API_SERVER/BEARER_TOKEN → 真实集群 nodes/pods(/metrics)；
         * - 没配 → 本机真实 CPU 逐核 delta、物理内存、进程 RSS、网卡增量。
         * 无论走哪一层，帧里都不含 Math.random()。
         *
         * 【首帧立即推送】先采一次再进定时器，避免等待 1 秒的空白期——
         * 客户端切到 live 的瞬间就能看到真实水面。
         */
        let liveEnabled = true;

        const pushLiveFrame = async (): Promise<void> => {
          if (isClosed || !liveEnabled) return;
          try {
            const collected = await collectLiveTelemetrySnapshot(snapshot);
            if (isClosed) return;

            /**
             * ---- 关键修复：live 模式下的故障演练叠加 ----
             *
             * 【原缺陷】此分支此前直接推送 `collected.snapshot`，
             * 完全忽略上面解析出来的 chaos 参数。于是用户在「实时」模式点
             * 「故障演练」时，服务端仍只推真实数据：3D 场景毫无变化、
             * 指标纹丝不动、告警不出现，观感等同于按钮失效。
             *
             * 【现在】在真实快照之上叠加混沌效果：
             * - 保留真实底盘（真实集群/宿主机的 pod/node 数据不被伪造）；
             * - 只对混沌目标机架施加故障特征（OOM 内存漂白、CPU 飙升、网络分区）；
             * - 告警与健康分用与 demo 模式完全相同的规则重算。
             *
             * 这样两种模式下"故障长什么样"是一致的，而 live 模式仍然
             * 是**真实数据驱动**的——叠加层只改故障语义，不改数据来源。
             */
            snapshot =
              chaos === 'NONE' ? collected.snapshot : applyLiveChaosOverlay(collected.snapshot, chaos);

            const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
            if (!safeEnqueue(frame) && timer !== null) {
              clearInterval(timer);
              timer = null;
            }
          } catch {
            /* 采集异常不能拖垮连接：本轮跳过，下一秒继续重试真实采样 */
          }
        };

        /*
         * 首帧：同步等待一次采集（采集内部有 4s 超时护栏，不会无限挂）。
         * 采完再启动定时器，保证后续帧间隔严格 = STREAM_INTERVAL_MS。
         */
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

        request.signal.addEventListener('abort', safeClose, { once: true });
        return;
      }

      /* ---- 3. demo 模式：每 1000ms 演进一帧并推送 ---- */
      timer = setInterval((): void => {
        /* 状态锁首检：连接已关则停止（清理已在 safeClose 完成，此处仅兜底） */
        if (isClosed) {
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
          return;
        }

        try {
          /* 推进状态机（纯函数：上一帧 + 混沌场景 → 新帧） */
          snapshot = stepTelemetrySimulation(snapshot, chaos);

          /* 标准 SSE 分帧：'data: ' + JSON + '\n\n'（双换行表示帧结束） */
          const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
          if (!safeEnqueue(frame) && timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        } catch {
          /* 演进或序列化异常：终止推流，避免向客户端发送损坏帧后继续空转 */
          safeClose();
        }
      }, STREAM_INTERVAL_MS);

      /* ---- 4. 客户端断开监听（关闭标签页 / 网络中断） ---- */
      request.signal.addEventListener('abort', safeClose, { once: true });
    },

    /**
     * cancel —— 消费端主动取消（reader.cancel()）。
     *
     * 【为何必须实现】cancel 与 request.signal 的 abort 是两条独立路径，
     * 部分客户端（Node 侧 fetch().body.cancel()）只触发 cancel 而不触发
     * abort。若此处不清定时器，它将成为游离句柄持续演进，造成 CPU/内存泄漏。
     * 因 isClosed 与 timer 已提升到外层作用域，此处可直接完成清理。
     */
    cancel(): void {
      safeClose();
    },
  });

  return new Response(stream, {
    headers: {
      /* SSE MIME 契约（显式 charset 保证中文实体名不乱码） */
      'Content-Type': 'text/event-stream; charset=utf-8',
      /* no-cache 禁缓存；no-transform 禁止中间层压缩/改写（保实时性） */
      'Cache-Control': 'no-cache, no-transform',
      /* 长连接语义 */
      Connection: 'keep-alive',
      /* nginx 专用：关闭 proxy_buffering，否则反代后"连上但无数据" */
      'X-Accel-Buffering': 'no',
    },
  });
}
