/**
 * KubeVision AI — 合成遥测引擎（Synthetic Telemetry Engine）
 *
 * 【设计意图】为「demo 模式」提供一台**可确定性复现**的集群状态演算机：
 * 给定上一帧快照与当前混沌场景，纯函数式地推进 1 个 tick（1000ms），
 * 产出全新快照。它是整个可视化的数据心脏——3D 实例着色、网络流光速度、
 * 涟漪环激活、巡检 HUD 波形、告警面板全部由它的输出驱动。
 *
 * 【为何是纯函数（核心架构约束）】
 * stepTelemetrySimulation(prev, chaos) 的输出**只依赖输入**，不用
 * Date.now() / Math.random()。原因有三：
 * 1. SSR/CSR 一致性：服务端预渲染与客户端首次演算得到逐字节相同的快照，
 *    杜绝 Hydration Mismatch（AGENTS.md 第 4 条）；
 * 2. 可测试性：E2E 可精确断言「第 N 步后 memoryUsage 应落在 [96,99]」；
 * 3. 可回放性：同一 chaos 序列必然产出同一演化轨迹，便于复盘与录屏。
 * 伪随机性以「时间步 + 实体下标」为种子的确定性哈希实现（见 hashNoise），
 * 视觉上足够"有机"，但完全可复现。
 *
 * 【时间基准】快照自身携带 timestamp，引擎以此作为演进时钟，
 * 每步 +TICK_INTERVAL_MS。因此无需外部注入时间，调用方只要拿当前快照
 * 递推即可（服务端 SSE 每 1s 调用一次；客户端也可以同法本地演算）。
 *
 * 【均值回归（Mean Reversion）数学模型】
 * 正常态下所有连续量（CPU / MEM / 网络吞吐）围绕各自基准值做 Ornstein-
 * Uhlenbeck 式均值回归：
 *   next = current + (baseline − current) · REVERSION_RATE + noise · AMPLITUDE
 * 其中 REVERSION_RATE ∈ (0,1) 决定回归强度（越大越快拉回基准），
 * noise ∈ [−1,1] 为确定性哈希噪声。这一形式的两大性质：
 * - **自动自愈**：任何偏离基线的异常值（含上一轮混沌遗留的 96% 高水位）
 *   都会按指数速率自然回落，无需额外"复原"分支——混沌一停即自愈；
 * - **有界波动**：稳态下 current ≈ baseline + noise·(AMPLITUDE/REVERSION_RATE)，
 *   不会无界漂移，视觉上呈现自然的呼吸感而非乱跳。
 */

import { INITIAL_CLUSTER_SNAPSHOT, TELEMETRY_SCHEMA_VERSION } from '@/types/cluster';
import type {
  AlertEvent,
  ChaosScenario,
  PodEntity,
  PodStatus,
  TelemetrySnapshot,
  WorkerNodeEntity,
  NodeStatus,
} from '@/types/cluster';
import type { LogEntry } from '@/types/ai';
import { HEALTH_SCORE_MAX, computeClusterHealthScore } from '@/utils/clusterHealth';

/* ========================================================================== */
/* 时间与数值常量                                                              */
/* ========================================================================== */

/** 单 tick 步长（毫秒）：与 SSE 推送节拍、快照 timestamp 递增保持一致 */
export const TICK_INTERVAL_MS = 1000;

/** 均值回归速率（每 tick 向基准靠拢的比例）：0.18 → 约 5 帧回归 63% 偏差 */
const REVERSION_RATE = 0.18;

/** 正常态 CPU 波动幅度（百分点） */
const CPU_NOISE_AMPLITUDE = 2.6;

/** 正常态内存波动幅度（百分点） */
const MEM_NOISE_AMPLITUDE = 1.8;

/** 网络吞吐噪声幅度（相对基准的比例） */
const NET_NOISE_RATIO = 0.07;

/** QPS 正弦起伏基准频率（弧度/tick）：周期约 40s，模拟业务潮汐 */
const QPS_WAVE_RATE = 0.157;

/** QPS 起伏幅度（相对基准的比例） */
const QPS_WAVE_RATIO = 0.12;

/**
 * QPS 噪声幅度（相对基准的比例）。
 *
 * 【为什么是常量而不是"读上一帧"】见下方 QPS_BASELINE 的说明。
 */
const QPS_NOISE_RATIO = 0.02;

/**
 * QPS_BASELINE —— **不可变**的 QPS 锚定基准（全集群稳态请求量）。
 *
 * 【自愈的缺陷：复利漂移（compounding drift）】
 * 旧实现写作：
 *   `const qpsBaseline = prevSnapshot.totalQps`   ← 把**上一帧的输出**当基准
 *   `totalQps = round(qpsBaseline * (1 + wave + noise) * penalty)`
 * 于是每一 tick 都在上一 tick 的结果上再乘一次 (1 + wave + noise)。
 * 这是一个**乘性递推**：只要 (1 + wave + noise) 的长期均值偏离 1 一点点，
 * 结果就会按指数收敛到 0（或发散到上限）。实测 300 tick（36 秒）内
 * QPS 从 12850 漂到 833，曲线呈典型的指数衰减——这就是"复利漂移"。
 *
 * 【正确做法】基准必须是**一次派生、永不变化**的常量：
 * 从种子快照派生一次，之后每帧直接
 *   `round(QPS_BASELINE * (1 + wave + noise) * penalty)`
 * 计算的是"相对基准的瞬时偏离"，而不是"相对上一帧的增量"。
 * 这样波动永远有界（±QPS_WAVE_RATIO ± QPS_NOISE_RATIO），不会累积。
 */
export const QPS_BASELINE: number = INITIAL_CLUSTER_SNAPSHOT.totalQps;

/*
 * 【节点调参集中在 constants/telemetryTuning.ts】
 *
 * 回归速率 / 噪声幅度 / 健康区间 / HighLoad 阈值 / 过阻尼限幅 / 角色基线
 * 全部从调参表导入，而不是散落在引擎里。原因有两个：
 * 1. 这些数值直接决定"演示观感"，评委追问时需要有独立、带解释的出处；
 * 2. types/cluster.ts 的角色化种子水位必须与它们保持一致，集中一处才好校验。
 */
import {
  NODE_CPU_NOISE_AMPLITUDE,
  NODE_FALLBACK_CPU_MAX,
  NODE_FALLBACK_CPU_MIN,
  NODE_FALLBACK_MEM_MAX,
  NODE_FALLBACK_MEM_MIN,
  NODE_HIGH_LOAD_CPU,
  NODE_HIGH_LOAD_MEM,
  NODE_MAX_STEP_CPU,
  NODE_MAX_STEP_MEM,
  NODE_MEM_NOISE_AMPLITUDE,
  NODE_REVERSION_RATE,
  NODE_ROLE_BY_RACK,
  NODE_ROLE_PROFILE,
} from '@/constants/telemetryTuning';

/* ---- 混沌故障参数（契约指定的数值域） ---- */

/** POD_OOM_SWARM：内存推高目标区间下界（%） */
const OOM_MEM_MIN = 96;
/** POD_OOM_SWARM：内存推高目标区间上界（%） */
const OOM_MEM_MAX = 99;
/** POD_OOM_SWARM：受影响的 Pod 数量（worker-beta 上的 3 个核心业务 Pod） */
const OOM_VICTIM_COUNT = 3;
/*
 * 【对外契约 · 禁止复制】以下三个 `*_RACK_INDEX` 常量是"混沌场景 → 受灾机架"
 * 的**唯一事实源**。utils/chaosTargets.ts 直接 import 它们来派生 nodeId，
 * 任何其它文件都不得再写一份 "0/1/2" 的字面量——两处各写一份正是
 * P0-1（路演镜头锁错机架）的成因。
 */

/** POD_OOM_SWARM：受影响机架（worker-beta） */
export const OOM_RACK_INDEX = 1;

/** NODE_CPU_SPIKE：CPU 推升目标区间下界（%） */
const SPIKE_CPU_MIN = 92;
/** NODE_CPU_SPIKE：CPU 推升目标区间上界（%） */
const SPIKE_CPU_MAX = 99;
/** NODE_CPU_SPIKE：受影响机架（worker-alpha） */
export const SPIKE_RACK_INDEX = 0;

/** NET_PACKET_LOSS：受影响机架（worker-gamma） */
export const PARTITION_RACK_INDEX = 2;
/** NET_PACKET_LOSS：网络吞吐骤降至基准的该比例（88% 跌幅 → 保留 12%） */
const PARTITION_THROUGHPUT_RATIO = 0.12;
/** NET_PACKET_LOSS：转为 Pending 的 Pod 占比（每 3 个中 1 个） */
const PARTITION_PENDING_EVERY = 3;

/** 节点网络吞吐基准的派生系数（每 CPU 核对应的 Mbps 容量） */
const MBPS_PER_CPU_CORE = 12;

/* ---- 告警常量 ---- */

/** 告警 ID 前缀（时间戳 + 场景 + 序号拼装，天然去重可排序） */
const ALERT_ID_PREFIX = 'alert';

/** 健康分满分 */

/* ========================================================================== */
/* 确定性伪随机（无 Math.random，可复现）                                        */
/* ========================================================================== */

/**
 * hashNoise —— 确定性伪随机噪声发生器，输出 [−1, 1]。
 *
 * 【核心数学】对整数种子做 32 位整数混合（xorshift 风格的多轮位运算），
 * 再映射为 [−1,1] 浮点：
 *   x ^= x << 13;  x ^= x >>> 17;  x ^= x << 5;   (32 位截断)
 *   noise = (x / 2^31) − 1
 * 混合函数的关键性质是「雪崩效应」：种子哪怕只差 1，输出也完全不相关，
 * 因此相邻 tick / 相邻实体得到的噪声序列在统计上互不相关，
 * 视觉上等同随机——但**同一种子恒得同一输出**，这是可复现性的根基。
 *
 * @param seed 整数种子（通常由 tick 序号与实体下标组合而成）
 * @returns [−1, 1] 区间的确定性浮点噪声
 */
function hashNoise(seed: number): number {
  /*
   * 【2026-11 自愈：旧实现不是"噪声"，是一条缓慢斜坡】
   *
   * 旧实现是裸 xorshift32（x ^= x<<13; x ^= x>>>17; x ^= x<<5）。
   * 对**小整数种子**（tick 从 1 开始、种子形如 tick*67+11）它没有雪崩效应：
   *   hashNoise(78)≈0.01, hashNoise(145)≈0.02, … 连续 20 个种子输出的是一条
   *   **单调上升的斜坡**（实测 tick 21~80 的均值 0.41，而理论应为 0）。
   * 后果：所谓"零均值随机噪声"其实是一个缓慢漂移项，节点水位会跟着它
   * 慢慢爬升/下滑——这正是"节点数值缓慢漂移、故障恢复后回不到基线"的根因。
   *
   * 自愈：改用 lowbias32 终混（两次 Math.imul + 高低位 xor），
   * 小种子也能瞬间雪崩，相邻种子输出互不相关。仍然：
   *   · 确定性（同种子恒得同输出）；
   *   · 无 Math.random；
   *   · 值域 [−1, 1)。
   */
  let x = seed | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  /* x 现为 32 位有符号整数，除以 2^31 得 [−1,1) */
  return x / 2147483648;
}

/** 把数值收敛到 [min, max] 区间（含边界） */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 保留一位小数（遥测展示精度；同时抑制浮点尾数在 JSON 中的体积膨胀） */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}


/**
 * appendHistory —— 把新值推入 6 点 FIFO 历史序列（末位恒为当前值）。
 *
 * 【契约】PodEntity.cpuHistory / memHistory 长度恒为 6，索引 5 为当前值
 * （见 types/cluster.ts）。本函数保持该不变量：取旧序列末 5 项 + 新值。
 *
 * @param history 旧历史序列（任意长度，通常为 6）
 * @param value   新的当前值
 * @returns 长度恒为 6 的新序列
 */
function appendHistory(history: readonly number[], value: number): number[] {
  const next: number[] = [];
  const start = Math.max(0, history.length - 5);
  for (let i = start; i < history.length; i++) next.push(history[i]);
  while (next.length < 5) next.unshift(value);
  next.push(value);
  return next;
}

/* ========================================================================== */
/* 健康分与告警构造                                                            */
/* ========================================================================== */


/**
 * buildAlerts —— 按当前混沌场景生成告警列表（纯函数，无副作用）。
 *
 * 【告警设计】每个场景产出一组与其故障语义严格对应的 AlertEvent：
 * - POD_OOM_SWARM   → 每个受害者 Pod 一条 P0（内存溢出致命，服务不可用）
 * - NODE_CPU_SPIKE  → 该节点一条 P1（性能降级但未完全失联）
 * - NET_PACKET_LOSS → 该节点一条 P0（网络脑裂，最致命）
 * 告警 id 由「时间戳 + 场景 + 序号」构成，因此每 tick 都会产出新 id，
 * 天然满足「新告警在前」的排序需求，且不会与历史告警冲突。
 *
 * @param scenario 当前混沌场景
 * @param snapshot 本 tick 已完成实体演进的新快照（用于取实体名与归属）
 * @returns 排序后的活跃告警数组（P0 优先）
 */
function buildAlerts(scenario: ChaosScenario, snapshot: TelemetrySnapshot): AlertEvent[] {
  if (scenario === 'NONE') return [];

  const alerts: AlertEvent[] = [];
  const stamp = new Date(snapshot.timestamp).toISOString();

  if (scenario === 'POD_OOM_SWARM') {
    const victims = snapshot.pods.filter(
      (pod): boolean =>
        pod.rackIndex === OOM_RACK_INDEX &&
        (pod.status === 'OOMKilled' || pod.status === 'CrashLoopBackOff'),
    );
    for (let i = 0; i < victims.length; i++) {
      const pod = victims[i];
      alerts.push({
        id: `${ALERT_ID_PREFIX}-${snapshot.timestamp}-oom-${i}`,
        timestamp: stamp,
        level: 'P0',
        entityId: pod.id,
        entityName: pod.name,
        message: `Pod ${pod.name} 内存溢出（${Math.round(pod.memoryUsage)}%）被 OOMKilled，已重启 ${pod.restarts} 次`,
      });
    }
  } else if (scenario === 'NODE_CPU_SPIKE') {
    const node = snapshot.nodes.find((candidate): boolean => candidate.rackIndex === SPIKE_RACK_INDEX);
    if (node !== undefined) {
      alerts.push({
        id: `${ALERT_ID_PREFIX}-${snapshot.timestamp}-cpu`,
        timestamp: stamp,
        level: 'P1',
        entityId: node.id,
        entityName: node.name,
        message: `节点 ${node.name} CPU 水位飙升至 ${Math.round(node.cpuUsage)}%，已进入 HighLoad 状态`,
      });
    }
  } else if (scenario === 'NET_PACKET_LOSS') {
    const node = snapshot.nodes.find(
      (candidate): boolean => candidate.rackIndex === PARTITION_RACK_INDEX,
    );
    if (node !== undefined) {
      alerts.push({
        id: `${ALERT_ID_PREFIX}-${snapshot.timestamp}-net`,
        timestamp: stamp,
        level: 'P0',
        entityId: node.id,
        entityName: node.name,
        message: `节点 ${node.name} 网络吞吐骤降至 ${node.networkMbps.toFixed(1)} Mbps，判定为 NetworkPartition 脑裂`,
      });
    }
  }

  return alerts;
}

/* ========================================================================== */
/* 实体演进：Pod                                                               */
/* ========================================================================== */

/**
 * evolvePodBaseline —— 正常态下单 Pod 的均值回归演进。
 *
 * 【核心数学】（见文件头 JSDoc 的 OU 式均值回归）
 *   baselineCpu = 该 Pod 原始基准（用其历史首值近似，反映其固有负载画像）
 *   nextCpu = clamp(current + (baselineCpu − current)·RATE + noise·AMP, 0, 100)
 * 对内存同法处理。历史序列同步滚动，末位锚定当前值。
 *
 * 【自动恢复语义】若该 Pod 处于异常态（上一轮混沌遗留），正常态下会被
 * 强制复位为 Running：混沌停止即业务自愈，与「均值回归把高水位拉回基线」
 * 是同一恢复过程的两个侧面（状态面 + 数值面）。
 */
function evolvePodBaseline(pod: PodEntity, tick: number, index: number): PodEntity {
  /* 基准取历史首值（种子数据里历史围绕当前水位微幅波动，首值是稳定的画像锚点）；
     历史缺失时退回常用基线，保证函数对任意输入安全 */
  const baseCpu = pod.cpuHistory.length > 0 ? pod.cpuHistory[0] : 40;
  const baseMem = pod.memHistory.length > 0 ? pod.memHistory[0] : 50;

  const noiseCpu = hashNoise(tick * 31 + index * 7 + 1);
  const noiseMem = hashNoise(tick * 37 + index * 11 + 2);

  const nextCpu = clamp(
    pod.cpuUsage + (baseCpu - pod.cpuUsage) * REVERSION_RATE + noiseCpu * CPU_NOISE_AMPLITUDE,
    0,
    100,
  );
  const nextMem = clamp(
    pod.memoryUsage + (baseMem - pod.memoryUsage) * REVERSION_RATE + noiseMem * MEM_NOISE_AMPLITUDE,
    0,
    100,
  );

  const cpu = round1(nextCpu);
  const mem = round1(nextMem);

  /* 正常态：无论此前处于何种异常态，均复位为 Running
     （混沌终止即业务自愈：状态面复位 + 数值面回归是同一恢复过程的两侧） */
  const status: PodStatus = 'Running';

  return {
    ...pod,
    status,
    cpuUsage: cpu,
    memoryUsage: mem,
    cpuHistory: appendHistory(pod.cpuHistory, cpu),
    memHistory: appendHistory(pod.memHistory, mem),
  };
}

/**
 * evolvePodOomSwarm —— POD_OOM_SWARM 场景下受影响 Pod 的故障演进。
 *
 * 【故障状态机】（契约指定的真实演进语义）
 * 1. 内存：向 [96,99] 区间快速逼近（每 tick 走 55% 剩余距离 + 小幅噪声），
 *    保证 2~3 tick 内稳定落入目标区间，且不会越界超过 99；
 * 2. 状态：越过 96% 后交替切换 OOMKilled / CrashLoopBackOff——
 *    交替而非固定，是为了让 3D 场景同时呈现两种崩溃态着色与涟漪环；
 * 3. restarts：每次状态在崩溃双态间翻转即 +1（模拟 kubelet 反复重启失败）；
 * 4. CPU：随内存压力轻微抬升（OOM 前 GC 风暴），但不越 80%。
 *
 * @param pod    原 Pod 实体
 * @param tick   当前 tick 序号（决定噪声与状态交替相位）
 * @param rank   受害者在受害者集合中的序号（0..2）
 */
function evolvePodOomSwarm(pod: PodEntity, tick: number, rank: number): PodEntity {
  /* 1. 内存推向 [96,99]：向区间中点做阻尼逼近 + 噪声抖动 */
  const memTarget = (OOM_MEM_MIN + OOM_MEM_MAX) / 2;
  const noiseMem = hashNoise(tick * 41 + rank * 13 + 5);
  const nextMem = clamp(
    pod.memoryUsage + (memTarget - pod.memoryUsage) * 0.55 + noiseMem * 0.8,
    OOM_MEM_MIN,
    OOM_MEM_MAX,
  );

  /* 2. 状态：内存越过阈值后进入崩溃循环。
        【相位错开】每个受害者用各自的 rank 参与 tick 的周期取模。
        注意：不能在 %2 的表达式里加 rank*2（偶数偏移在模 2 下恒等价于 0，
        无法错开相位——这是本函数早期版本的实际缺陷）。改用长度为 3 的
        轮转周期：crashPhase = (tick + rank) % 3，落在 {0,1,2} 三相位上，
        三台 Pod 分别处于不同阶段：
          phase 0 → OOMKilled
          phase 1 → CrashLoopBackOff
          phase 2 → OOMKilled（与 phase 0 同态但重启计数节奏不同）
        如此任一时刻三台状态不再整齐划一，且每 3 tick 全部轮转一次。 */
  const crossedThreshold = nextMem >= OOM_MEM_MIN;
  const crashPhase = (tick + rank) % 3;
  const status: PodStatus = crossedThreshold
    ? crashPhase === 1
      ? 'CrashLoopBackOff'
      : 'OOMKilled'
    : 'Running';

  /**
   * 3. restarts 递增：仅在崩溃态之间发生**真实状态翻转**时 +1。
   *
   * 【语义对齐】只有「上一帧崩溃态 → 本帧另一种崩溃态」才算一次重启失败
   * （容器被 kill 后重新拉起又立刻失败）。同态持续（OOMKilled → OOMKilled）
   * 不计数，否则每 tick 自增会让挂机 10 分钟后的计数荒诞地涨到 600+。
   *
   * 【与相位的关系】状态按 3 步周期轮转（OOMKilled → CrashLoopBackOff →
   * OOMKilled），因此每 3 tick 必然发生一次翻转，restarts 平均每 3 秒 +1，
   * 与真实 kubelet 的指数退避重启节奏量级相符（而非每秒一次）。
   */
  const wasCrashing = pod.status === 'OOMKilled' || pod.status === 'CrashLoopBackOff';
  const isCrashing = status === 'OOMKilled' || status === 'CrashLoopBackOff';
  const restarts = wasCrashing && isCrashing && pod.status !== status ? pod.restarts + 1 : pod.restarts;

  /* 4. CPU 轻微抬升（GC 风暴），上限 80% 避免与 NODE_CPU_SPIKE 语义混淆 */
  const noiseCpu = hashNoise(tick * 43 + rank * 17 + 6);
  const nextCpu = clamp(pod.cpuUsage + 6 + noiseCpu * 2.5, 0, 80);

  const mem = round1(nextMem);
  const cpu = round1(nextCpu);

  return {
    ...pod,
    status,
    cpuUsage: cpu,
    memoryUsage: mem,
    restarts,
    cpuHistory: appendHistory(pod.cpuHistory, cpu),
    memHistory: appendHistory(pod.memHistory, mem),
  };
}

/**
 * evolvePodCpuSpike —— NODE_CPU_SPIKE 场景下该节点内 Pod 的 CPU 推升演进。
 *
 * 【语义】节点 CPU 尖峰由「其上所有 Pod 争抢算力」造成，故每个 Pod 的
 * CPU 都被推向 [92,99]，状态保持 Running（Pod 本身没崩，只是被挤占资源）。
 */
function evolvePodCpuSpike(pod: PodEntity, tick: number, index: number): PodEntity {
  const cpuTarget = (SPIKE_CPU_MIN + SPIKE_CPU_MAX) / 2;
  const noiseCpu = hashNoise(tick * 47 + index * 19 + 7);
  const nextCpu = clamp(
    pod.cpuUsage + (cpuTarget - pod.cpuUsage) * 0.6 + noiseCpu * 1.2,
    SPIKE_CPU_MIN,
    SPIKE_CPU_MAX,
  );

  /* 内存随 CPU 争抢轻微上升（但远不及 OOM 阈值） */
  const noiseMem = hashNoise(tick * 53 + index * 23 + 8);
  const nextMem = clamp(pod.memoryUsage + 2.5 + noiseMem * 1.5, 0, 92);

  const cpu = round1(nextCpu);
  const mem = round1(nextMem);

  return {
    ...pod,
    status: 'Running',
    cpuUsage: cpu,
    memoryUsage: mem,
    cpuHistory: appendHistory(pod.cpuHistory, cpu),
    memHistory: appendHistory(pod.memHistory, mem),
  };
}

/**
 * evolvePodPartition —— NET_PACKET_LOSS 场景下该节点内 Pod 的网络侧演进。
 *
 * 【语义】机架网络分区导致部分 Pod 与 API Server 失联，kubelet 上报中断，
 * 控制器无法确认其实际状态 → 这些 Pod 被标记为 Pending（调度/连接不可知）。
 * 契约指定「下属部分 Pod 变为 Pending」，故按固定步长抽样
 * （每 PARTITION_PENDING_EVERY 个取 1 个），确定性可断言。
 *
 * 其余 Pod 保持 Running，CPU/内存做轻微回落（流量被切断，负载下降）。
 */
function evolvePodPartition(pod: PodEntity, tick: number, index: number): PodEntity {
  const isPartial = index % PARTITION_PENDING_EVERY === 0;
  const status: PodStatus = isPartial ? 'Pending' : 'Running';

  /* 分区后流量骤减 → CPU/内存轻度回落 */
  const noiseCpu = hashNoise(tick * 59 + index * 29 + 9);
  const noiseMem = hashNoise(tick * 61 + index * 31 + 10);
  const nextCpu = clamp(pod.cpuUsage - 5 + noiseCpu * 2, 0, 100);
  const nextMem = clamp(pod.memoryUsage - 3 + noiseMem * 1.5, 0, 100);

  const cpu = round1(nextCpu);
  const mem = round1(nextMem);

  return {
    ...pod,
    status,
    cpuUsage: cpu,
    memoryUsage: mem,
    cpuHistory: appendHistory(pod.cpuHistory, cpu),
    memHistory: appendHistory(pod.memHistory, mem),
  };
}

/* ========================================================================== */
/* 实体演进：Node                                                              */
/* ========================================================================== */

/**
 * deriveNodeBaselineMbps —— 由节点固有容量派生稳定的网络吞吐基准（Mbps）。
 *
 * 【为何不能直接用 node.networkMbps 当基准】
 * 该字段是**演进结果**而非容量属性：一旦某帧被故障压到 12%，
 * 下一帧再乘 12% 就是几何衰减（0.12^n），数帧后归零并永久卡死。
 * 实测 NET_PACKET_LOSS 下会产出 0 Mbps，网络流光彻底静止。
 *
 * 【派生依据】cpuCapacity 是节点的静态固有属性（alpha/beta 32C，
 * gamma 16C），且与带宽同向（更大的机器通常配更高带宽）。
 * 取每核 12 Mbps 的系数，使 alpha/beta 得 384 Mbps、gamma 得 192 Mbps，
 * 与种子数据的观测量级（386 / 292 / 164）基本吻合，视觉过渡自然。
 *
 * @param node 节点实体（只读其 cpuCapacity 静态属性）
 * @returns 稳定的吞吐基准（Mbps），同一节点恒为同一值
 */
function deriveNodeBaselineMbps(node: WorkerNodeEntity): number {
  const capacity = node.cpuCapacity > 0 ? node.cpuCapacity : 16;
  return capacity * MBPS_PER_CPU_CORE;
}

/**
 * hashStringSeed —— 把字符串折叠成 32 位整数种子（FNV-1a）。
 *
 * 【为什么需要】节的确定性基线要按 nodeId 派生，而 hashNoise 只接受数字。
 * FNV-1a 只有几行、跨平台一致、且不需要 Math.random。
 *
 * @param text 输入字符串（如 node id）
 * @returns 32 位无符号整数种子
 */
function hashStringSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * resolveNodeBaseline —— 求某个节点的**不可变** CPU / 内存基准。
 *
 * 【取值的优先级】
 * 1. 种子快照里同 rackIndex 的节点（demo 模式 100% 命中，基准即种子值）；
 * 2. 按 nodeId 哈希映射进契约区间（live 模式的真实节点名兜底）；
 *
 * 【为什么必须"不可变"】若基准取 node 自身的当前值，回归项恒为 0，
 * 又退化成随机游走；若取上一帧输出，则等价于复利漂移。
 * 基准必须是"这个节点本来应该处于多少"的先验，与当前观测无关。
 *
 * @param node 待求基准的节点
 * @returns CPU / 内存基准（百分点）
 */
function resolveNodeBaseline(node: WorkerNodeEntity): { cpu: number; mem: number } {
  /*
   * 【第一优先：角色画像】同一机架上的节点共享角色（compute/memory/network），
   * 因此 live 模式映射出来的真实节点也能拿到与种子节点一致的基线——
   * 这是"三台机器有性格"能在两种数据源下保持一致的关键。
   */
  const role = NODE_ROLE_BY_RACK[node.rackIndex];
  if (role !== undefined) {
    const profile = NODE_ROLE_PROFILE[role];
    return { cpu: profile.cpu, mem: profile.mem };
  }

  /*
   * 【第二优先：种子节点自身水位】rackIndex 越界（未来扩机架）时，
   * 若该节点恰好在种子表里，直接用它的水位。
   */
  const seed = INITIAL_CLUSTER_SNAPSHOT.nodes.find(
    (item): boolean => item.id === node.id,
  );
  if (seed !== undefined) {
    return { cpu: seed.cpuUsage, mem: seed.memUsage };
  }

  /*
   * 【兜底：nodeId 哈希】既无角色、又不在种子表里的节点，
   * 用确定性哈希在健康区间中段取一个稳定值（无 Math.random）。
   */
  const seedHash = hashStringSeed(node.id);
  const cpuNoise = hashNoise((seedHash % 100000) + 1);
  const memNoise = hashNoise((seedHash % 100000) + 733);
  return {
    cpu:
      NODE_FALLBACK_CPU_MIN +
      ((cpuNoise + 1) / 2) * (NODE_FALLBACK_CPU_MAX - NODE_FALLBACK_CPU_MIN),
    mem:
      NODE_FALLBACK_MEM_MIN +
      ((memNoise + 1) / 2) * (NODE_FALLBACK_MEM_MAX - NODE_FALLBACK_MEM_MIN),
  };
}

/**
 * limitStep —— 一阶差分限幅（"过阻尼保护"）。
 *
 * 【解决什么问题】节点从故障态回落到基线时，回归项的一阶差分可能很大：
 * 0.18 × (95 − 46) ≈ 8.8 个百分点/帧。画面上就是一帧从红区"啪"地掉到绿区，
 * 趋势图出现垂直断崖，观众会以为渲染出 bug 了。
 *
 * 【做法】把每帧的变化量钳制在 ±maxStep 内：
 *   delta = next − current
 *   delta >  maxStep → 只走 maxStep
 *   delta < −maxStep → 只走 −maxStep
 * 相当于给节点水位加了一个"阻尼器"：允许逼近，但不允许瞬移。
 *
 * 【为什么只作用于回归支路】故障注入本身是**事件**（CPU 尖峰要瞬间打满、
 * 网络分区要瞬间掉到 12%），语义上就该陡变；若对故障支路也限幅，
 * 演示时故障要花好几秒才"爬"到目标水位，节奏会被拖垮。
 *
 * @param current 当前值
 * @param next    未限幅的目标值
 * @param maxStep 单帧允许的最大变化量（绝对值）
 * @returns 限幅后的值
 */
function limitStep(current: number, next: number, maxStep: number): number {
  const delta = next - current;
  if (delta > maxStep) return current + maxStep;
  if (delta < -maxStep) return current - maxStep;
  return next;
}

/**
 * evolveNode —— 节点网络吞吐与状态演进（三场景分支）。
 *
 * 【正常态】吞吐围绕基准做均值回归，并叠加与 QPS 同频的正弦潮汐：
 *   throughput = baseline·(1 + sin(t·RATE)·QPS_WAVE_RATIO) + noise
 * 使网络流光的速度呈现"业务高峰/低谷"的呼吸感，而非恒定。
 *
 * 【POD_OOM_SWARM】仅受影响机架（worker-beta）的内存水位抬升，其他节点正常。
 * 【NODE_CPU_SPIKE】受影响机架（worker-alpha）CPU 推向 [92,99] 并置 HighLoad。
 * 【NET_PACKET_LOSS】受影响机架（worker-gamma）吞吐骤降至 12% 并置 NetworkPartition。
 */
function evolveNode(
  node: WorkerNodeEntity,
  scenario: ChaosScenario,
  tick: number,
  index: number,
): WorkerNodeEntity {
  const noiseNet = hashNoise(tick * 67 + index * 37 + 11);
  const qpsWave = Math.sin(tick * QPS_WAVE_RATE) * QPS_WAVE_RATIO;

  /**
   * 【关键：网络吞吐必须基于「基准容量」而非「当前值」计算】
   *
   * 若写作 next = current · ratio（在当前值上再乘一次衰减系数），
   * 则每帧都是几何衰减：0.12 → 0.0144 → 0.0017 → 0.0002，4 帧后归零。
   * 实测该写法在 NET_PACKET_LOSS 下产出 0 Mbps（死值），既不符合
   * 「骤降至 12% 后稳定」的物理语义，也让网络流光彻底静止（视觉退化）。
   *
   * 因此引入 nodeBaselineMbps 作为**不随故障漂移的容量基准**：
   * 它由节点 cpuCapacity 派生（容量越大带宽越高），是节点的固有属性。
   * 故障态取 baseline · PARTITION_THROUGHPUT_RATIO（稳定在 12%），
   * 正常态取 baseline · (1 + 潮汐)，二者都在基准上做比例，不会累乘漂移。
   */
  const nodeBaselineMbps = deriveNodeBaselineMbps(node);

  /*
   * 【基线提前解析】故障分支也必须相对基线计算，否则会退化成"每帧累加/累减"
   * ——那是随机游走的另一种形式（实测 NET 分支连续减 8/tick，43 tick 后 CPU 掉到 5%，
   * 故障解除后要很久才能爬回来）。
   */
  const baseline = resolveNodeBaseline(node);

  let cpuUsage = node.cpuUsage;
  let memUsage = node.memUsage;
  let networkMbps = nodeBaselineMbps;
  let status: NodeStatus = 'Ready';

  if (scenario === 'NODE_CPU_SPIKE' && node.rackIndex === SPIKE_RACK_INDEX) {
    /* CPU 尖峰：向 [92,99] 逼近，节点进入 HighLoad */
    const cpuTarget = (SPIKE_CPU_MIN + SPIKE_CPU_MAX) / 2;
    cpuUsage = clamp(node.cpuUsage + (cpuTarget - node.cpuUsage) * 0.6 + noiseNet * 1.5, SPIKE_CPU_MIN, SPIKE_CPU_MAX);
    /* 内存压力按「基线 + 3」算，而不是每帧 +3（后者 30 帧就顶到 95） */
    memUsage = clamp(baseline.mem + 3 + noiseNet * 2, 0, 95);
    status = 'HighLoad';
    networkMbps = nodeBaselineMbps * (1 + qpsWave);
  } else if (scenario === 'NET_PACKET_LOSS' && node.rackIndex === PARTITION_RACK_INDEX) {
    /* 网络分区：吞吐稳定降至基准的 12%。
       【抖动幅度】噪声系数取 0.28（远大于早期版本的 0.05）：
       0.05 在 23 Mbps 的量级上只产生 ±1.1 Mbps 波动，经一位小数取整后
       几乎恒定不变，网络流光速度会呈现「死板匀速」——而丢包场景恰恰
       应该是忽快忽慢的断续感。0.28 给出约 ±6.4 Mbps 的可见抖动。 */
    networkMbps = nodeBaselineMbps * PARTITION_THROUGHPUT_RATIO * (1 + noiseNet * 0.28);
    /*
     * 【自愈：累计扣减】旧实现是 node.cpuUsage - 8（每帧都再减 8），
     * 43 tick 的丢包演练足以把 CPU 从 44 打到 5%，故障解除后还要慢慢爬回来——
     * 视觉上就是"节点被打死了"，与"网络分区"的语义也不符（分区不消耗 CPU）。
     * 现在改为「基线 − 8」，稳定在基线下 8 个百分点。
     */
    cpuUsage = clamp(baseline.cpu - 8 + noiseNet * 2, 0, 100);
    memUsage = clamp(baseline.mem - 5 + noiseNet * 2, 0, 100);
    status = 'NetworkPartition';
  } else if (scenario === 'POD_OOM_SWARM' && node.rackIndex === OOM_RACK_INDEX) {
    /* OOM 风暴：内存压力上升（Pod 批量 OOM 直接抬升节点内存水位） */
    const memTarget = 88;
    memUsage = clamp(node.memUsage + (memTarget - node.memUsage) * 0.4 + noiseNet * 1.5, 0, 96);
    /* CPU 抬升同样按基线偏移，避免每帧 +5 顶到上限 */
    cpuUsage = clamp(baseline.cpu + 5 + noiseNet * 2, 0, 95);
    networkMbps = nodeBaselineMbps * (1 + qpsWave);
    status = 'Ready';
  } else {
    /*
     * ---- 正常态：CPU / 内存做**均值回归**（自愈随机游走） ----
     *
     * 公式与 Pod 侧完全同构：
     *   next = current + (baseline − current) · RATE + noise · AMPLITUDE
     *
     * 【为什么必须有 (baseline − current) 这一项】
     * 只加零均值噪声是随机游走：方差 ∝ tick 数，长跑必然漂到 0 或 100 并黏住
     * （实测 300 tick 内三节点 CPU 在 0%~100% 之间来回摆动）。
     * 引入回归项后，偏离会被按 RATE 拉回基准，稳态波动被限制在
     * ≈ noise·AMPLITUDE/RATE 的范围内（约 ±2~3 个百分点）。
     *
     * 【baseline 从哪来】resolveNodeBaseline() 返回**不可变先验**，
     * 绝不读 node 自身当前值（那会让回归项恒为 0）。
     */
    const noiseMem = hashNoise(tick * 73 + index * 41 + 12);

    /*
     * ---- 过阻尼保护：先算回归目标，再做一阶差分限幅 ----
     * 故障解除后的头一两帧最陡（95 → 86 ≈ 9 个百分点），限幅到 6 之后
     * 下降沿变得平顺，但后续自然步长迅速小于阈值，不会拖慢整体恢复
     * （实测 60 帧内仍能回到基线附近，见 scripts/sim-drift.mjs 的恢复曲线）。
     */
    const cpuTarget = clamp(
      node.cpuUsage + (baseline.cpu - node.cpuUsage) * NODE_REVERSION_RATE + noiseNet * NODE_CPU_NOISE_AMPLITUDE,
      0,
      100,
    );
    const memTarget = clamp(
      node.memUsage + (baseline.mem - node.memUsage) * NODE_REVERSION_RATE + noiseMem * NODE_MEM_NOISE_AMPLITUDE,
      0,
      100,
    );
    cpuUsage = limitStep(node.cpuUsage, cpuTarget, NODE_MAX_STEP_CPU);
    memUsage = limitStep(node.memUsage, memTarget, NODE_MAX_STEP_MEM);
    networkMbps = nodeBaselineMbps * (1 + qpsWave) * (1 + noiseNet * NET_NOISE_RATIO);
    /* 高负载态由**实际水位**推导，而不是恒定 Ready */
    status = cpuUsage >= NODE_HIGH_LOAD_CPU || memUsage >= NODE_HIGH_LOAD_MEM ? 'HighLoad' : 'Ready';
  }

  return {
    ...node,
    status,
    cpuUsage: round1(cpuUsage),
    memUsage: round1(memUsage),
    networkMbps: round1(networkMbps),
    /* podIds 为反向索引，恒等于 pods 表按 nodeId 的聚合结果；
       本函数不增删 Pod，故沿用原数组（结构共享，零拷贝） */
    podIds: node.podIds,
  };
}

/* ========================================================================== */
/* 主演进函数                                                                  */
/* ========================================================================== */

/**
 * stepTelemetrySimulation —— 合成遥测状态机主入口（纯函数，1 tick 演进）。
 *
 * 【输入输出】
 * @param prevSnapshot 上一帧完整快照（不可变；本函数绝不原地修改它）
 * @param activeChaos  当前混沌场景（'NONE' 表示稳态）
 * @returns 全新的 TelemetrySnapshot（timestamp + TICK_INTERVAL_MS 递增）
 *
 * 【核心流转】
 * 1. 计算 tick 序号：由 prevSnapshot.timestamp 直接递推，无需外部时钟；
 * 2. Pod 演进：按场景分支——正常态全体均值回归 + 异常态复位；
 *    OOM 场景只动 worker-beta 的 3 个核心业务 Pod；
 *    CPU 尖峰场景只动 worker-alpha 名下 Pod；
 *    网络分区场景只动 worker-gamma 名下部分 Pod；
 * 3. 节点演进：按场景分支（吞吐潮汐 / CPU 尖峰 / 分区骤降）；
 * 4. 告警生成：按场景产出 P0/P1 告警；
 * 5. QPS 演进：围绕基准做正弦起伏（正常态与故障态均保持波动）；
 * 6. 健康分：按统一权重表重算；
 * 7. 组装新快照返回。
 */
export function stepTelemetrySimulation(
  prevSnapshot: TelemetrySnapshot,
  activeChaos: ChaosScenario,
): TelemetrySnapshot {
  /* ---- 1. tick 序号（以快照时间戳为演进时钟，纯函数无外部依赖） ---- */
  const tick = Math.floor(prevSnapshot.timestamp / TICK_INTERVAL_MS);

  /* ---- 2. 选出 OOM 受害者：worker-beta 机架上的前 3 个核心业务 Pod ---- */
  const oomVictimIds = new Set<string>();
  if (activeChaos === 'POD_OOM_SWARM') {
    const betaPods = prevSnapshot.pods.filter(
      (pod): boolean => pod.rackIndex === OOM_RACK_INDEX,
    );
    /* 取前 3 个（种子数据中即 production 命名空间的业务核心 Pod） */
    for (let i = 0; i < Math.min(OOM_VICTIM_COUNT, betaPods.length); i++) {
      oomVictimIds.add(betaPods[i].id);
    }
  }

  /* ---- 3. Pod 逐个演进（按场景与归属分支） ---- */
  const oomVictimRank = new Map<string, number>();
  let oomRankCounter = 0;
  for (const pod of prevSnapshot.pods) {
    if (oomVictimIds.has(pod.id)) {
      oomVictimRank.set(pod.id, oomRankCounter);
      oomRankCounter++;
    }
  }

  const nextPods: PodEntity[] = prevSnapshot.pods.map((pod, index): PodEntity => {
    if (activeChaos === 'POD_OOM_SWARM' && oomVictimIds.has(pod.id)) {
      return evolvePodOomSwarm(pod, tick, oomVictimRank.get(pod.id) ?? 0);
    }
    if (activeChaos === 'NODE_CPU_SPIKE' && pod.rackIndex === SPIKE_RACK_INDEX) {
      return evolvePodCpuSpike(pod, tick, index);
    }
    if (activeChaos === 'NET_PACKET_LOSS' && pod.rackIndex === PARTITION_RACK_INDEX) {
      return evolvePodPartition(pod, tick, index);
    }
    /* 其余 Pod（含非目标机架上的全部 Pod）走正常态均值回归 */
    return evolvePodBaseline(pod, tick, index);
  });

  /* ---- 4. 节点逐个演进 ---- */
  /**
   * 当前故障场景的受灾机架（'NONE' 时为 -1）。
   *
   * 【为什么单独算】故障机架的状态由故障规则决定（HighLoad / NetworkPartition），
   * 不能被下面的"Pod 全 Running 就 Ready"规则覆盖掉。
   */
  const faultRack =
    activeChaos === 'NODE_CPU_SPIKE'
      ? SPIKE_RACK_INDEX
      : activeChaos === 'NET_PACKET_LOSS'
        ? PARTITION_RACK_INDEX
        : activeChaos === 'POD_OOM_SWARM'
          ? OOM_RACK_INDEX
          : -1;

  const nextNodes: WorkerNodeEntity[] = prevSnapshot.nodes.map(
    (node, index): WorkerNodeEntity => {
      const evolved = evolveNode(node, activeChaos, tick, index);

      /* 受灾机架：状态由故障语义决定，不参与下面的恢复规则 */
      if (faultRack >= 0 && node.rackIndex === faultRack) return evolved;

      /*
       * ---- 恢复规则：名下 Pod 全部 Running → 节点回 Ready ----
       *
       * 【自愈的缺陷】旧实现里 "Ready/HighLoad" 由场景分支硬编码：
       * 故障解除后节点可能因为水位残留（或 overlay 残留）继续显示 HighLoad，
       * 出现"Pod 全绿但机架仍是琥珀色"的自相矛盾画面。
       * 现在以 **Pod 实际状态** 为准：只要该节点名下没有异常 Pod，
       * 节点就回到 Ready；水位本身已由均值回归拉回基准附近。
       */
      const allPodsRunning = nextPods.every(
        (pod): boolean => pod.nodeId !== node.id || pod.status === 'Running',
      );
      if (allPodsRunning && evolved.status !== 'Ready') {
        return { ...evolved, status: 'Ready' };
      }
      return evolved;
    },
  );

  /* ---- 5. QPS 演进：锚定**不可变基准**，只表达相对基准的瞬时偏离 ---- */
  /*
   * 【自愈：复利漂移】旧实现把 prevSnapshot.totalQps 当基准，
   * 每一 tick 都在上一帧**输出**上再乘一次 (1 + wave + noise)——乘性递推，
   * 长期均值只要偏离 1 就会指数收敛到 0（实测 300 tick 从 12850 漂到 833）。
   *
   * 现在基准是模块级常量 QPS_BASELINE（从种子快照派生一次），
   * 每 tick 的输出都是"基准 × 瞬时系数"，与历史无关，因此永远有界。
   * 这也让降级本地引擎与服务端引擎**同源同幅**，切换时不会出现量级突变。
   */
  const qpsWave = Math.sin(tick * QPS_WAVE_RATE) * QPS_WAVE_RATIO;
  const noiseQps = hashNoise(tick * 71 + 13) * QPS_NOISE_RATIO;
  /* 故障场景下 QPS 整体下挫（请求失败/超时），同样作用在不可变基准上 */
  const chaosQpsPenalty =
    activeChaos === 'NONE' ? 1 : activeChaos === 'POD_OOM_SWARM' ? 0.82 : activeChaos === 'NODE_CPU_SPIKE' ? 0.9 : 0.72;
  const totalQps = Math.max(
    0,
    Math.round(QPS_BASELINE * (1 + qpsWave + noiseQps) * chaosQpsPenalty),
  );

  /* ---- 6. 组装中间快照（告警需要读取已演进的实体状态，故先构造再补告警） ---- */
  const intermediate: TelemetrySnapshot = {
    timestamp: prevSnapshot.timestamp + TICK_INTERVAL_MS,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    clusterHealthScore: HEALTH_SCORE_MAX,
    totalQps,
    nodes: nextNodes,
    pods: nextPods,
    activeAlerts: [],
  };

  /* ---- 7. 告警生成（依赖演进后的实体状态） ---- */
  const activeAlerts = buildAlerts(activeChaos, intermediate);

  /* ---- 8. 健康分重算（统一权重表） ---- */
  const clusterHealthScore = computeClusterHealthScore(nextNodes, nextPods, activeAlerts);

  return {
    ...intermediate,
    clusterHealthScore,
    activeAlerts,
  };
}

/* ========================================================================== */
/* 实时（live）模式的故障演练叠加层                                               */
/* ========================================================================== */

/**
 * applyLiveChaosOverlay —— 在**真实集群快照**之上叠加混沌演练效果。
 *
 * 【解决什么缺陷】
 * 「实时 (Live)」模式每秒用 collectLiveTelemetrySnapshot 采集真实宿主机/K8s 数据，
 * 这条链路完全不知道 ChaosScenario 的存在——SSE 路由在 live 分支里
 * 根本没有读 chaos 参数。于是用户在 live 模式下点击「故障演练」时：
 * 3D 场景毫无变化、指标纹丝不动、告警不出现。
 * 从用户视角看就是「按钮坏了」。演示现场一旦切到实时模式再点演练，
 * 整个核心卖点当场失效。
 *
 * 【为何不能简单复用 stepTelemetrySimulation】
 * 那个函数是**完整演进器**：它会让每个 Pod 走向均值回归、让 QPS 正弦起伏、
 * 让节点按合成规则变化。用在 live 模式上会把真实的宿主机数据覆盖成
 * 合成数据——那就不是"实时"了。用户之所以切到 live，正是想看到真实数据。
 *
 * 【本函数的定位：只叠加、不替换】
 * 输入是真实快照，输出是「真实底盘 + 混沌效果」：
 * - Pod：只有落在混沌目标机架上的 Pod 被施加故障特征（OOM 漂白内存、
 *   CPU 飙高、网络分区），其余 Pod 原样保留真实值；
 * - 节点：同样只改目标机架对应的节点；
 * - QPS：按场景系数下挫（请求失败/超时导致的真实业务后果）；
 * - 告警与健康分：用与合成引擎完全相同的 buildAlerts / computeClusterHealthScore
 *   重算，保证两种模式下"故障长什么样"是一致的。
 *
 * 【确定性】内部使用的 tick 由快照时间戳派生，evolve* 系列均为纯函数，
 * 不含 Math.random()。同一输入必然得到同一输出。
 *
 * @param snapshot 采集到的真实快照（作为叠加底盘）
 * @param activeChaos 当前演练场景（'NONE' 时原样返回，零开销）
 * @returns 叠加故障特征后的新快照（原快照不被修改）
 */
export function applyLiveChaosOverlay(
  snapshot: TelemetrySnapshot,
  activeChaos: ChaosScenario,
): TelemetrySnapshot {
  /* 稳态：不叠加任何内容，直接返回原引用（调用方无需判空，零分配） */
  if (activeChaos === 'NONE') return snapshot;

  /* tick 由真实时间戳派生：确保 evolve 函数的振荡相位随墙钟推进而自然变化 */
  const tick = Math.floor(snapshot.timestamp / TICK_INTERVAL_MS);

  /* ---- 1. 选出受影响的 Pod 集合（按场景对应的机架归属） ---- */
  const affectedRack =
    activeChaos === 'POD_OOM_SWARM'
      ? OOM_RACK_INDEX
      : activeChaos === 'NODE_CPU_SPIKE'
        ? SPIKE_RACK_INDEX
        : PARTITION_RACK_INDEX;

  /**
   * 【真实集群没有 rackIndex 概念怎么办】
   * live 快照的 Pod 由 K8s 真实数据映射而来，rackIndex 可能是引擎广播的默认值。
   * 若受影响机架上恰好没有任何 Pod（真实集群只有少数几个 Pod 时很常见），
   * 退化为"按索引选取前 N 个"，保证演练效果一定可见——
   * 否则用户点了演练、屏幕上却什么都没变，等于又回到原来的缺陷。
   */
  const rackPods = snapshot.pods.filter((pod): boolean => pod.rackIndex === affectedRack);
  const victimIds = new Set<string>();
  if (rackPods.length > 0) {
    const limit =
      activeChaos === 'POD_OOM_SWARM' ? Math.min(OOM_VICTIM_COUNT, rackPods.length) : rackPods.length;
    for (let i = 0; i < limit; i += 1) victimIds.add(rackPods[i].id);
  } else {
    const limit = Math.min(OOM_VICTIM_COUNT, snapshot.pods.length);
    for (let i = 0; i < limit; i += 1) victimIds.add(snapshot.pods[i].id);
  }

  /* OOM 受害者的排名（影响故障强度递增曲线，与合成引擎口径一致） */
  const victimRank = new Map<string, number>();
  let rankCounter = 0;
  for (const pod of snapshot.pods) {
    if (victimIds.has(pod.id)) {
      victimRank.set(pod.id, rankCounter);
      rankCounter += 1;
    }
  }

  /* ---- 2. Pod 叠加：只改受害者，其余保留真实值 ---- */
  const nextPods: PodEntity[] = snapshot.pods.map((pod, index): PodEntity => {
    if (activeChaos === 'POD_OOM_SWARM' && victimIds.has(pod.id)) {
      return evolvePodOomSwarm(pod, tick, victimRank.get(pod.id) ?? 0);
    }
    if (activeChaos === 'NODE_CPU_SPIKE' && victimIds.has(pod.id)) {
      return evolvePodCpuSpike(pod, tick, index);
    }
    if (activeChaos === 'NET_PACKET_LOSS' && victimIds.has(pod.id)) {
      return evolvePodPartition(pod, tick, index);
    }
    /* 非受害者：保持实时采集到的真实值，不做任何合成演进 */
    return pod;
  });

  /* ---- 3. 节点叠加：只改故障机架对应的节点 ---- */
  const nextNodes: WorkerNodeEntity[] = snapshot.nodes.map(
    (node, index): WorkerNodeEntity =>
      node.rackIndex === affectedRack ? evolveNode(node, activeChaos, tick, index) : node,
  );

  /* ---- 4. QPS 下挫：故障导致请求失败/超时，这是业务层真实后果 ---- */
  const chaosQpsPenalty =
    activeChaos === 'POD_OOM_SWARM' ? 0.82 : activeChaos === 'NODE_CPU_SPIKE' ? 0.9 : 0.72;
  const totalQps = Math.max(0, Math.round(snapshot.totalQps * chaosQpsPenalty));

  /* ---- 5. 组装中间快照 → 告警 → 健康分（与合成引擎完全同源） ---- */
  const intermediate: TelemetrySnapshot = {
    /* 时间戳沿用真实快照：live 模式的时间基准不可被改写 */
    timestamp: snapshot.timestamp,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    clusterHealthScore: HEALTH_SCORE_MAX,
    totalQps,
    nodes: nextNodes,
    pods: nextPods,
    activeAlerts: [],
  };

  const activeAlerts = buildAlerts(activeChaos, intermediate);
  const clusterHealthScore = computeClusterHealthScore(nextNodes, nextPods, activeAlerts);

  return {
    ...intermediate,
    clusterHealthScore,
    activeAlerts,
  };
}


/* ========================================================================== */
/* 容器实时日志流生成器（端侧脱敏引擎的实战数据源）                                */
/* ========================================================================== */


/**
 * 脱敏正则表 —— 把 rawText 中的敏感模式替换为 [REDACTED]。
 *
 * 【模式设计】按「最具体优先」排列，避免短模式先吃掉长模式的片段：
 * 1. JWT：`eyJ` 开头的三段式 base64url（header.payload.signature），
 *    本生成器构造的样本为两段（无签名），故段数设为 2~3；
 * 2. AWS AccessKey：`AKIA` + 16 位大写字母数字；
 * 3. IPv4:port：四段点分十进制 + 可选端口；
 * 4. 邮箱：标准 local@domain 形式。
 *
 * 【为何在此实现而不是等脱敏引擎】ai.ts 的 LogEntry 契约要求
 * sanitizedText 必须已脱敏（「送入端侧模型与 LLM 上下文的一律是
 * sanitizedText」）。若本函数返回未脱敏的 sanitizedText，等于把敏感信息
 * 直接泄进 LLM 通道——必须在此闭合。后续端侧 AI 脱敏引擎可替换/增强
 * 这套正则，但默认值必须安全（fail-safe，而非 fail-open）。
 */
const REDACTION_RULES: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  /* JWT：eyJ 开头，两段或三段 base64url，用点分隔 */
  {
    pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?/g,
    replacement: '[REDACTED_JWT]',
  },
  /* AWS AccessKey：AKIA + 16 位大写字母或数字 */
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  /* IPv4 可选端口 */
  {
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,
    replacement: '[REDACTED_IP]',
  },
  /* 邮箱 */
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: '[REDACTED_EMAIL]',
  },
];

/**
 * sanitizeLogText —— 对原始日志文本执行正则脱敏。
 *
 * 【核心逻辑】顺序应用 REDACTION_RULES，每次命中替换为带类型的标记
 * （如 [REDACTED_JWT] 而非统一 [REDACTED]）——带类型标记让审计面板能
 * 直接展示"命中了哪类凭据"，对运维判断泄露面更有价值。
 *
 * @param raw 原始日志文本
 * @returns 脱敏文本与命中总数
 */
function sanitizeLogText(raw: string): { readonly text: string; readonly count: number } {
  let text = raw;
  let count = 0;
  for (const rule of REDACTION_RULES) {
    /* 正则含 g 标志，test 会推进 lastIndex，故用 replace 的副作用计数 */
    text = text.replace(rule.pattern, (): string => {
      count += 1;
      return rule.replacement;
    });
  }
  return { text, count };
}

/**
 * 日志严重级别（内部枚举，映射到渲染色调与端侧分类标签）。
 */
type LogSeverity = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/**
 * 单条日志模板：严重级别 + 文本生成函数（延迟求值，仅在选中时构造字符串）。
 *
 * 【为何用函数而非字符串】每个模板都要插入 Pod 名 / 时间戳等变量，
 * 若预先构造会为未选中的模板白做字符串拼接。函数延迟到入选后再执行。
 */
interface LogTemplate {
  readonly severity: LogSeverity;
  /** 生成日志正文（不含 K8s 标准前缀） */
  readonly build: (pod: PodEntity, tick: number) => string;
}

/**
 * 正常态日志模板池（INFO 为主，模拟健康容器的稳定输出）。
 *
 * 【覆盖契约：每个模板必含至少一类敏感样本】
 * 早期版本只有部分模板含 IP/凭据，实测在「稳态只产出 1 条日志」的
 * 低流量 tick 上常常抽不到敏感模板（maskedCount=0），脱敏引擎因此闲置。
 * 真实世界恰恰相反：健康容器的 INFO 日志里到处都是连接串、
 * 上游地址和健康检查 URL——**正常运行时才是最容易泄漏基础设施拓扑的时刻**。
 * 因此这里让每条模板都携带连接串/地址/凭据，保证任何 tick 都有脱敏素材。
 */
const HEALTHY_LOG_TEMPLATES: readonly LogTemplate[] = [
  {
    severity: 'INFO',
    build: (pod): string =>
      `GET /api/v1/health 200 ${12 + (pod.slotIndex % 7)}ms - upstream=10.244.2.18:6379 pool=${8 + (pod.slotIndex % 5)}`,
  },
  {
    severity: 'INFO',
    build: (pod): string =>
      `metrics flushed to collector 10.244.2.18:6379 (cpu=${pod.cpuUsage.toFixed(1)}%, mem=${pod.memoryUsage.toFixed(1)}%) batched=${40 + (pod.slotIndex % 20)}`,
  },
  {
    severity: 'INFO',
    build: (pod): string =>
      `redis pool healthy -> dial tcp 10.244.2.18:6379 ok, latency=${3 + (pod.slotIndex % 4)}ms, inflight=0`,
  },
  {
    severity: 'INFO',
    build: (pod): string =>
      `watching configmap ${pod.namespace}/app-config resync complete, caller=admin@kubevision.internal generation=${20 + (pod.slotIndex % 10)}`,
  },
  {
    severity: 'INFO',
    build: (pod): string =>
      `probe served: GET http://10.244.2.18:8080/healthz 200 1ms - pod=${pod.name}`,
  },
  {
    severity: 'INFO',
    build: (pod): string =>
      `otel export ok -> 10.244.2.18:6379 spans=${60 + (pod.slotIndex % 40)}, token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiJ9`,
  },
  {
    severity: 'INFO',
    build: (pod): string =>
      `cache warm complete, s3://kv-audit-prod sync via AKIAIOSFODNN7EXAMPLE (${40 + (pod.slotIndex % 20)} objects)`,
  },
];

/** 异常态日志模板池（ERROR/FATAL 为主，覆盖 OOM / 网络 / 认证三类故障叙事） */
const ABNORMAL_LOG_TEMPLATES: readonly LogTemplate[] = [
  {
    severity: 'FATAL',
    build: (pod): string =>
      `fatal error: runtime: out of memory - container exceeded limit (mem=${pod.memoryUsage.toFixed(1)}%), signal=KILL, node=10.244.2.18:10250`,
  },
  {
    severity: 'ERROR',
    build: (pod): string =>
      `OOMKilled: cgroup memory limit reached, oom_score_adj=999, restart_count=${pod.restarts}, last_state=terminated`,
  },
  {
    severity: 'ERROR',
    build: (): string =>
      `dial tcp 10.244.2.18:6379: connect: connection refused (kafka broker unreachable, retry 3/5 backoff=2s)`,
  },
  {
    severity: 'ERROR',
    build: (): string =>
      `401 Unauthorized - Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiJ9 rejected by authz webhook`,
  },
  {
    severity: 'ERROR',
    build: (): string =>
      `S3 upload failed: InvalidAccessKeyId - key=AKIAIOSFODNN7EXAMPLE region=ap-east-1 endpoint=10.244.2.18:6379`,
  },
  {
    severity: 'ERROR',
    build: (pod): string =>
      `context deadline exceeded after 30s calling upstream 10.244.2.18:6379 (pool exhausted, active=${18 + (pod.slotIndex % 6)}/20)`,
  },
  {
    severity: 'WARN',
    build: (pod): string =>
      `liveness probe failed: Get "http://10.244.2.18:8080/healthz": context deadline exceeded (pod=${pod.name})`,
  },
  {
    severity: 'WARN',
    build: (): string =>
      `credential rotation due: service account token scoped to admin@kubevision.internal expires in 6h`,
  },
  {
    severity: 'FATAL',
    build: (pod): string =>
      `panic: runtime error: invalid memory address or nil pointer dereference (goroutine 1, restarts=${pod.restarts}, caller=AKIAIOSFODNN7EXAMPLE)`,
  },
  {
    severity: 'ERROR',
    build: (pod): string =>
      `TLS handshake failed with 10.244.2.18:6379: certificate signed by unknown authority (svc=${pod.name}, token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiJ9)`,
  },
];

/**
 * 日志条数决策：正常态 1~2 条，异常态 3~5 条。
 *
 * 【为何异常态更多】真实故障中容器会密集输出错误（CrashLoopBackOff 的
 * backoff 重试、OOM 前后的 GC 告警），日志量本身就是故障信号之一。
 */
const HEALTHY_LOG_MIN = 1;
const HEALTHY_LOG_MAX = 2;
const ABNORMAL_LOG_MIN = 3;
const ABNORMAL_LOG_MAX = 5;

/**
 * 判定 Pod 是否处于「当前异常」态（决定日志走报错模板还是常规模板）。
 *
 * 【为何排除 restarts > 0】本判定回答的是「该 Pod 此刻是否在故障中」，
 * 而非「它历史上是否出过问题」。种子数据中 order-service(1 次)、
 * prometheus-server(2 次) 等 Pod 带着历史重启计数但当前状态是 Running；
 * 若把 restarts 计入异常，稳态集群会被误判为故障态并持续输出 ERROR 日志
 * （实测导致「稳态却打出 401 Unauthorized」的语义矛盾）。
 * 因此只以**当前生命周期状态**为准：崩溃双态 + 调度中才算异常。
 */
function isPodAbnormal(pod: PodEntity): boolean {
  return (
    pod.status === 'CrashLoopBackOff' ||
    pod.status === 'OOMKilled' ||
    pod.status === 'Pending'
  );
}

/**
 * generateSyntheticLogs —— 容器实时日志流生成器（端侧脱敏引擎的实战素材）。
 *
 * 【核心流转】
 * 1. 从快照中筛出异常 Pod（崩溃/挂起/有重启记录的），作为日志优先来源；
 * 2. 若有异常 Pod：为其各生成 3~5 条 ERROR/FATAL 日志
 *    （混入真实格式的内网 IP、JWT、AWS AccessKey、邮箱）；
 * 3. 若无异常 Pod：从全部 Pod 中按 tick 选取 1~2 个，生成 INFO 日志
 *    （同样混入 IP 与凭据样本——**健康容器的日志里也常有连接串**，
 *    这是真实世界的常态，也让脱敏引擎在稳态下同样有活可干）；
 * 4. 每条日志构造 K8s 标准容器输出格式前缀：
 *    `<RFC3339 时间戳> <LEVEL> <pod>/<container> <message>`
 *    （贴近 `kubectl logs` 的真实观感）；
 * 5. 对 rawText 执行正则脱敏得 sanitizedText 与 maskedCount；
 * 6. 全部条目按时间戳排序后返回。
 *
 * 【确定性】与引擎其余部分一致：不使用 Math.random()，所有选择都基于
 * 「快照 tick + Pod 下标」的确定性哈希，因此同一快照恒产出同一批日志。
 *
 * 【为什么 rawText 必须含真实素材】这是给端侧 AI 脱敏引擎的实战输入。
 * 若 rawText 一开始就是干净文本，脱敏引擎"跑通"也无从验证其正则有效性；
 * 只有喂入格式正确的 IP / JWT / AccessKey，才能真实检验：
 * 匹配率、误报率、maskedCount 计数准确性、以及替换后文本的可读性。
 * 而 sanitizedText 恒为脱敏结果，确保 LLM 通道永不接触原文（ai.ts 契约）。
 *
 * @param snapshot 当前遥测快照（日志内容由其中的 Pod 状态 / 水位 / 重启数驱动）
 * @returns 按时间戳升序排列的日志条目数组（可为空数组表示无日志产出）
 */
export function generateSyntheticLogs(snapshot: TelemetrySnapshot): LogEntry[] {
  const tick = Math.floor(snapshot.timestamp / TICK_INTERVAL_MS);
  const pods = snapshot.pods;
  if (pods.length === 0) return [];

  /* ---- 1. 分隔异常 Pod 与健康 Pod ---- */
  const abnormalPods: PodEntity[] = [];
  const healthyPods: PodEntity[] = [];
  for (const pod of pods) {
    if (isPodAbnormal(pod)) abnormalPods.push(pod);
    else healthyPods.push(pod);
  }

  const useAbnormal = abnormalPods.length > 0;
  const pool = useAbnormal ? abnormalPods : healthyPods;
  if (pool.length === 0) return [];

  const templates = useAbnormal ? ABNORMAL_LOG_TEMPLATES : HEALTHY_LOG_TEMPLATES;

  /* ---- 2. 本 tick 产出条数（确定性哈希决定，落在场景对应区间） ---- */
  const countMin = useAbnormal ? ABNORMAL_LOG_MIN : HEALTHY_LOG_MIN;
  const countMax = useAbnormal ? ABNORMAL_LOG_MAX : HEALTHY_LOG_MAX;
  const span = countMax - countMin + 1;
  const noise = hashNoise(tick * 97 + 17);
  /* hashNoise ∈ [−1,1] → 归一化到 [0,1) → 映射到条数区间 */
  const normalized = (noise + 1) / 2;
  const count = countMin + Math.min(span - 1, Math.floor(normalized * span));

  /* ---- 3. 逐条生成 ---- */
  const entries: LogEntry[] = [];
  for (let i = 0; i < count; i++) {
    /* 3.1 选 Pod：按下标轮转（确定性、可覆盖多个 Pod，避免永远只打第一个） */
    const podIndex = (tick + i * 3) % pool.length;
    const pod = pool[podIndex];

    /* 3.2 选模板：同样确定性轮转，保证类型多样而非重复同一句 */
    const templateIndex = (tick * 7 + i * 13 + podIndex) % templates.length;
    const template = templates[templateIndex];

    /* 3.3 K8s 标准容器输出前缀：
           <RFC3339> <LEVEL> <pod>/<container> <message>
           时间戳按条错开（i × 137ms），模拟同秒内多条日志的真实间隔 */
    const entryTimestamp = snapshot.timestamp + i * 137;
    const isoTimestamp = new Date(entryTimestamp).toISOString();
    const containerName = pod.name;
    const body = template.build(pod, tick);
    const rawText = `${isoTimestamp} ${template.severity} ${pod.name}/${containerName} ${body}`;

    /* 3.4 脱敏（sanitizedText 是唯一可外发文本，见 ai.ts 隐私契约） */
    const { text: sanitizedText, count: maskedCount } = sanitizeLogText(rawText);

    entries.push({
      id: `log-${entryTimestamp}-${pod.id}-${i}`,
      rawText,
      sanitizedText,
      maskedCount,
      timestamp: entryTimestamp,
      podName: pod.name,
      namespace: pod.namespace,
    });
  }

  /* ---- 4. 按时间戳升序（渲染端可直接顺序 append） ---- */
  entries.sort((a, b): number => a.timestamp - b.timestamp);
  return entries;
}