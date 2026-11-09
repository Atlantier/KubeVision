/**
 * KubeVision AI — 一键全自动剧本路演导演引擎（Auto-Play Demo Director）
 *
 * 【解决什么问题】答辩现场最怕两件事：评委等不及你手动操作，或者你在讲解时
 * 忘了下一步该点哪里。本引擎把「重置稳态 → 注入混沌 → 镜头锁定 → AI 诊断 →
 * MCP 自愈」这条黄金演示链路固化成时间轴剧本，一键启动后全自动跑完，
 * 讲解者只需要讲，不需要操作。
 *
 * 【为什么放在 utils 而不是组件里】状态机必须是**单例**：顶栏按钮、导演字幕条、
 * 甚至未来的快捷键都要读同一份状态。若把状态放进某个组件的 useState，
 * 多个消费方会各自持有一份副本，暂停/停止立刻不一致。
 * 因此这里用模块级单例 + 订阅表，组件侧通过 `useSyncExternalStore` 接入。
 *
 * 【暂停/恢复的时间学】不能用「累计 setTimeout 链」实现——
 * 那样暂停时无法知道某阶段还剩多少时间。这里用**绝对时间轴**：
 *   elapsedMs = accumulatedMs + (running ? now − startedAt : 0)
 * 暂停时把本段已过时间并入 accumulatedMs，恢复时重置 startedAt 并
 * 只为「尚未到点」的阶段重新排定时器。这样暂停 10 秒再恢复，
 * 时间轴从原处继续，不会跳段也不会补跑。
 *
 * 【定时器清理契约（AGENTS.md 第 3 条的资源纪律）】
 * 停止 / 组件卸载 / 卸载页面三条路径都必须清空全部 setTimeout 与 setInterval；
 * 另有一个 AbortController 用于取消进行中的 MCP 请求，避免请求回调
 * 在停止之后仍去写 store。
 *
 * 【与规格命名的偏差（重要，如实记录）】
 * 需求里写的 `setActiveChaos('OOM_KILL')` 与 `'NETWORK_LATENCY'` 在
 * `ChaosScenario` 枚举中**并不存在**（真实取值为
 * 'NONE' | 'POD_OOM_SWARM' | 'NODE_CPU_SPIKE' | 'NET_PACKET_LOSS'）。
 * 这里映射到语义最近的 `POD_OOM_SWARM` 与 `NET_PACKET_LOSS`。
 * 需求里的 `node-alpha` / `node-beta` 实际实体 ID 是
 * `node-worker-alpha` / `node-worker-beta`。
 */

import { useEffect, useSyncExternalStore } from 'react';

import type { ChaosScenario } from '@/types/cluster';
import { useClusterStore } from '@/store/useClusterStore';

/* ========================================================================== */
/* 类型契约                                                                    */
/* ========================================================================== */

/** 路演状态机的四态 */
export type DemoDirectorStatus = 'idle' | 'running' | 'paused' | 'finished';

/** 内置剧本标识 */
export type DemoScriptId = 'oom-autofix' | 'network-latency-trace';

/**
 * 单个剧本阶段（纯数据）。
 *
 * 【刻意不含动作函数】把「展示数据」与「副作用动作」分开：
 * 快照要能被 React 直接渲染、能被测试断言，若混入闭包则既不可序列化
 * 也难以在测试里替换。动作集中在 PHASE_ACTIONS 里按 scriptId + 下标对齐。
 */
export interface DemoPhase {
  /** 阶段序号（0-based） */
  readonly index: number;
  /** 相对剧本起点的触发时刻（毫秒） */
  readonly atMs: number;
  /** 阶段徽标，如「阶段 1/4 · 全景稳态巡航」 */
  readonly badge: string;
  /** 导演字幕正文 */
  readonly narration: string;
}

/** 剧本定义 */
export interface DemoScript {
  readonly id: DemoScriptId;
  /** 按钮/菜单里的短名 */
  readonly label: string;
  /** 完整标题 */
  readonly title: string;
  /** 总时长（毫秒） */
  readonly durationMs: number;
  readonly phases: readonly DemoPhase[];
}

/** 对外快照（订阅方读取的唯一结构） */
export interface DemoDirectorSnapshot {
  readonly status: DemoDirectorStatus;
  readonly scriptId: DemoScriptId | null;
  readonly scriptTitle: string;
  readonly phases: readonly DemoPhase[];
  /** 当前阶段下标；idle 时为 -1 */
  readonly phaseIndex: number;
  readonly elapsedMs: number;
  readonly durationMs: number;
  /** 总进度 0~1 */
  readonly progress: number;
  /** 当前阶段徽标；idle 时为空串 */
  readonly badge: string;
  /** 当前导演字幕；idle 时为空串 */
  readonly narration: string;
}

/* ========================================================================== */
/* 常量                                                                        */
/* ========================================================================== */

/** 进度心跳间隔（毫秒）——约 8Hz，进度条平滑且不给 React 造成压力 */
const TICK_INTERVAL_MS = 120;

/** MCP 执行端点（与 ActionConfirm 使用的同一路由） */
const MCP_EXECUTE_ENDPOINT = '/api/mcp/execute';

/**
 * 阶段动作的目标实体 ID。
 *
 * 【为何不用规格里的 node-alpha】实体 ID 的真实取值是 `node-worker-alpha`；
 * 写错会导致 selectEntity 命中不到目标而静默失败（store 会记一条
 * [AUDIT-SECURITY] rejection 日志），演示当场"镜头不动"。
 */
const OOM_TARGET_NODE_ID = 'node-worker-alpha';
const NETWORK_TARGET_NODE_ID = 'node-worker-beta';

/** 自愈动作类型（与 NodeInspectHUD 的合法取值对齐） */
const ACTION_DRAIN_NODE = 'drain_node';
const ACTION_RESTART_POD = 'restart_pod';

/* ========================================================================== */
/* 剧本定义                                                                    */
/* ========================================================================== */

/**
 * 剧本 1：OOM 内存溢出全链路诊断与 MCP 自愈闭环（约 34 秒）。
 *
 * 四段节奏刻意做成 5s / 6s / 15s / 8s 的非均匀分布：
 * · 前两段快（5s、6s）：让评委先看到"系统活着"和"故障发生"的事实；
 * · 第三段最长（15s）：RAG 检索与 4 步推理链流式生成需要真实时间，
 *   催不得——压短会让 AI 看起来是假的；
 * · 第四段 8s：自愈回执 + 镜头飞回全景，留出"结果已生效"的观感余量。
 */
const OOM_PHASES: readonly DemoPhase[] = [
  {
    index: 0,
    atMs: 0,
    badge: '阶段 1/4 · 全景稳态巡航',
    narration:
      'KubeVision AI 正在实时监控 3 台刀片机柜与 24 个容器实例，集群健康度 100。',
  },
  {
    index: 1,
    atMs: 5_000,
    badge: '阶段 2/4 · 故障注入与空间锁定',
    narration:
      '检测到 payment-gateway 触发 Cgroup Exit 137 内存溢出，3D 镜头已自动锁定告警机架！',
  },
  {
    index: 2,
    atMs: 11_000,
    badge: '阶段 3/4 · RAG 混合检索与多卡诊断',
    narration:
      'AI 运维副驾正在检索 SRE Runbook 知识库并生成 3 张交互式诊断卡片...',
  },
  {
    index: 3,
    atMs: 26_000,
    badge: '阶段 4/4 · MCP 闭环自愈完成',
    narration:
      '已下发控制器调谐指令，异常容器恢复 Running，集群健康分回升至 100！',
  },
];

/**
 * 剧本 2：CNI 跨节点网络延迟追踪与自愈闭环（约 32 秒）。
 *
 * 与剧本 1 的差异点在于「问题类型」：剧本 1 是单点资源耗尽（OOM），
 * 剧本 2 是跨节点连通性劣化（丢包/延迟）。同一条演示骨架下换一个故障域，
 * 用来证明产品不是只对 OOM 做了特调。
 */
const NETWORK_PHASES: readonly DemoPhase[] = [
  {
    index: 0,
    atMs: 0,
    badge: '阶段 1/4 · 全景稳态巡航',
    narration:
      '三节点拓扑基线建立中：MASTER 控制平面与三台刀片机柜的链路全部畅通。',
  },
  {
    index: 1,
    atMs: 5_000,
    badge: '阶段 2/4 · 网络混沌注入与阻塞可视化',
    narration:
      'CNI 丢包注入生效：跨节点弧线切换为红色阻塞抖动脉冲，镜头已锁定 node-worker-beta。',
  },
  {
    index: 2,
    atMs: 11_000,
    badge: '阶段 3/4 · CNI VXLAN 隧道瓶颈定位',
    narration:
      '副驾正在比对 VXLAN 隧道丢包率与 IPVS 连接超时，定位跨节点转发瓶颈...',
  },
  {
    index: 3,
    atMs: 24_000,
    badge: '阶段 4/4 · 网络自愈与拓扑恢复',
    narration:
      '已下发节点隔离与隧道重建指令，跨节点延迟回落基线，弧线恢复青绿流光。',
  },
];

/** 内置剧本清单（顺序即菜单顺序） */
export const DEMO_SCRIPTS: readonly DemoScript[] = [
  {
    id: 'oom-autofix',
    label: 'OOM 全链路自愈',
    title: 'OOM 内存溢出全链路诊断与 MCP 自愈闭环',
    durationMs: 34_000,
    phases: OOM_PHASES,
  },
  {
    id: 'network-latency-trace',
    label: 'CNI 网络延迟追踪',
    title: 'CNI 跨节点网络延迟追踪与自愈闭环',
    durationMs: 32_000,
    phases: NETWORK_PHASES,
  },
];

/* ========================================================================== */
/* 模块级单例状态                                                              */
/* ========================================================================== */

/** 当前状态机状态 */
let status: DemoDirectorStatus = 'idle';

/** 当前剧本（idle 时为 null） */
let currentScript: DemoScript | null = null;

/** 已经触达的阶段下标（-1 表示尚未进入任何阶段） */
let phaseIndex = -1;

/** 本轮「running 段」的起算点（performance.now） */
let segmentStartedAt = 0;

/** 之前所有 running 段累计的已用时长（暂停期间不增长） */
let accumulatedMs = 0;

/** 全部待触发的阶段定时器句柄 */
let phaseTimers: Array<ReturnType<typeof setTimeout>> = [];

/** 进度心跳定时器句柄 */
let tickTimer: ReturnType<typeof setInterval> | null = null;

/** MCP 请求取消器（停止时 abort，避免回调在停止后写 store） */
let mcpAbort: AbortController | null = null;

/** 订阅表 */
const listeners = new Set<() => void>();

/** 缓存的快照对象（useSyncExternalStore 要求引用稳定） */
let cachedSnapshot: DemoDirectorSnapshot = {
  status: 'idle',
  scriptId: null,
  scriptTitle: '',
  phases: [],
  phaseIndex: -1,
  elapsedMs: 0,
  durationMs: 0,
  progress: 0,
  badge: '',
  narration: '',
};

/**
 * 可选解说员（TTS 注入点）。
 *
 * 【为何用注册而非直接 import 语音钩子】语音合成是 React Hook，
 * 只能在组件树内实例化；utils 层不该反向依赖组件。让顶栏在挂载时
 * 注册一个解说函数，引擎只负责在阶段切换时把字幕交给它。
 * 传入 null 即关闭语音解说。
 */
let narrator: ((text: string) => void) | null = null;

/**
 * registerDemoNarrator —— 注册/注销语音解说回调。
 *
 * @param fn 解说回调；传 null 表示关闭语音解说
 * @returns 注销函数（供 useEffect 清理）
 */
export function registerDemoNarrator(fn: ((text: string) => void) | null): () => void {
  narrator = fn;
  return (): void => {
    if (narrator === fn) narrator = null;
  };
}

/* ========================================================================== */
/* 内部工具                                                                    */
/* ========================================================================== */

/** 读取 store 的当前动作集合（每次现取，避免持有已过期的 action 引用） */
function actions(): ReturnType<typeof useClusterStore.getState> {
  return useClusterStore.getState();
}

/** 清空所有定时器（幂等） */
function clearAllTimers(): void {
  for (const handle of phaseTimers) clearTimeout(handle);
  phaseTimers = [];
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** 取消进行中的 MCP 请求（幂等） */
function abortMcp(): void {
  if (mcpAbort !== null) {
    mcpAbort.abort();
    mcpAbort = null;
  }
}

/** 当前已用时长（毫秒） */
function currentElapsedMs(): number {
  if (status !== 'running') return accumulatedMs;
  return accumulatedMs + (performance.now() - segmentStartedAt);
}

/** 重新计算并广播快照 */
function publish(): void {
  const script = currentScript;
  const elapsed = script === null ? 0 : Math.min(currentElapsedMs(), script.durationMs);
  const activePhase =
    script !== null && phaseIndex >= 0 && phaseIndex < script.phases.length
      ? script.phases[phaseIndex]
      : null;

  cachedSnapshot = {
    status,
    scriptId: script?.id ?? null,
    scriptTitle: script?.title ?? '',
    phases: script?.phases ?? [],
    phaseIndex,
    elapsedMs: Math.round(elapsed),
    durationMs: script?.durationMs ?? 0,
    progress:
      script === null || script.durationMs <= 0
        ? 0
        : Math.min(1, Math.max(0, elapsed / script.durationMs)),
    badge: activePhase?.badge ?? '',
    narration: activePhase?.narration ?? '',
  };

  for (const listener of listeners) listener();
}

/**
 * 把集群恢复到「演示起点」稳态。
 *
 * 【为何不写 resetCluster()】store 里没有这个动作。恢复稳态的正确组合是：
 * 解除混沌 + 取消选中（镜头回全景）+ 关闭环绕（避免下一秒自己转起来）
 * + 清空待执行的自愈队列（否则上一轮的路演残留会在新剧本里"诈尸"）。
 */
function resetToBaseline(): void {
  const api = actions();
  api.setActiveChaos('NONE');
  api.selectEntity(null);
  api.setOrbitPatrolActive(false);
  api.clearPendingRemediations();
}

/* ========================================================================== */
/* 阶段动作                                                                    */
/* ========================================================================== */

/**
 * 阶段 1：全景稳态巡航。
 *
 * 打开环绕巡检——这是"系统活着"的最强信号：静止的 3D 场景容易被误认为
 * 一张渲染图，缓慢自转立刻证明它是实时渲染的。
 */
function enterCruise(): void {
  const api = actions();
  resetToBaseline();
  api.setOrbitPatrolActive(true);
  api.appendTerminalLog('[DEMO-DIRECTOR] 阶段 1/4 · 已重置集群稳态并开启 3D 环绕巡检');
}

/**
 * 通用「注入混沌并锁定镜头」阶段。
 *
 * @param chaos  要注入的混沌场景
 * @param nodeId 需要聚焦的节点实体 ID
 * @param label  终端日志前缀
 */
function enterFaultAndLock(chaos: ChaosScenario, nodeId: string, label: string): void {
  const api = actions();
  /* 关闭环绕：镜头要交给 CameraRig 的聚焦飞行，两者同时跑会互相拉扯 */
  api.setOrbitPatrolActive(false);
  api.setActiveChaos(chaos);
  api.selectEntity(nodeId, 'node');
  api.appendTerminalLog(`[DEMO-DIRECTOR] ${label} · 已注入 ${chaos} 并锁定 ${nodeId}`);
}

/**
 * 通用「唤醒 AI 副驾」阶段。
 *
 * @param prompt 送入副驾的诊断提示词
 * @param label  终端日志前缀
 */
function enterAiDiagnosis(prompt: string, label: string): void {
  const api = actions();
  api.triggerQuickPrompt(prompt);
  api.appendTerminalLog(`[DEMO-DIRECTOR] ${label} · 已唤醒 AI 运维副驾`);
}

/**
 * 从快照里挑出「值得自愈」的目标。
 *
 * 【为何要动态挑选而不是写死 ID】Pod ID 由合成引擎生成，硬编码会随
 * 引擎改动失效；而且真实故障态下哪几个 Pod 崩了是运行时决定的。
 * 这里按"目标节点名下 → 状态异常 → 最多 3 个"的口径现场挑选，
 * 挑不到就退化为自愈该节点本身（drain_node），保证阶段 4 永远有动作。
 *
 * @param nodeId 受影响节点 ID
 * @returns 待自愈目标列表（含 actionType）
 */
function resolveHealTargets(nodeId: string): Array<{ id: string; actionType: string }> {
  const snapshot = actions().snapshotSummary;
  const victims = snapshot.pods
    .filter(
      (pod): boolean =>
        pod.nodeId === nodeId &&
        (pod.status === 'OOMKilled' ||
          pod.status === 'CrashLoopBackOff' ||
          pod.status === 'Pending'),
    )
    .slice(0, 3)
    .map((pod) => ({ id: pod.id, actionType: ACTION_RESTART_POD }));

  if (victims.length > 0) return victims;
  /* 兜底：没有异常 Pod 时自愈节点自身，保证演示链路完整 */
  return [{ id: nodeId, actionType: ACTION_DRAIN_NODE }];
}

/**
 * 阶段 4：MCP 闭环自愈。
 *
 * 两步走，缺一不可：
 * 1. **healEntity** 是"控制器已验证的修复"——它真正改 store 里的状态水位，
 *    3D 里的刀片会打出自愈充能脉冲，HUD 健康分回升。
 * 2. **POST /api/mcp/execute** 是"对外出示调用回执"——答辩时服务端返回的
 *    JSON-RPC receipt 是"我们真的走了 MCP 协议"的证据，写进终端日志后
 *    评委可以直接看到 actionType / targetId / 执行耗时。
 *
 * 【请求失败不阻断剧本】自愈的真实状态由 healEntity 保证；MCP 回执只是
 * 证据链。网络异常时降级为一条告警日志，剧本继续走完——总比卡在阶段 3
 * 强。失败也绝不伪造成功回执。
 *
 * @param nodeId 受影响节点 ID
 * @param label  终端日志前缀
 */
function enterHeal(nodeId: string, label: string): void {
  const api = actions();
  const targets = resolveHealTargets(nodeId);

  for (const target of targets) {
    api.healEntity(target.id, target.actionType);
  }
  api.appendTerminalLog(
    `[DEMO-DIRECTOR] ${label} · 已对 ${targets.length} 个目标下发自愈（${targets
      .map((t) => t.id)
      .join(', ')}）`,
  );

  /* 镜头与混沌复位：让画面回到"一切正常"的全景，收束整场演示 */
  api.setActiveChaos('NONE');
  api.selectEntity(null);
  api.setOrbitPatrolActive(true);

  /* ---- MCP 执行回执（异步，不阻塞时间轴）---- */
  abortMcp();
  const controller = new AbortController();
  mcpAbort = controller;
  const primary = targets[0];

  void fetch(MCP_EXECUTE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      actionType: primary.actionType,
      targetId: primary.id,
      targetName: primary.id,
      clusterMode: api.connectionMode,
    }),
    signal: controller.signal,
  })
    .then(async (response): Promise<string> => {
      if (!response.ok) {
        return `MCP 执行返回 HTTP ${response.status}（未伪造成功回执）`;
      }
      const payload: unknown = await response.json();
      /* 只读取已知字段，不做 as any 断言 */
      if (typeof payload === 'object' && payload !== null && 'result' in payload) {
        const receipt = (payload as { result?: unknown }).result;
        if (typeof receipt === 'object' && receipt !== null) {
          const r = receipt as { executionId?: unknown; actionType?: unknown };
          const id = typeof r.executionId === 'string' ? r.executionId : '(unknown)';
          const act = typeof r.actionType === 'string' ? r.actionType : primary.actionType;
          return `MCP 回执 ${id} · ${act} 已完成控制器调谐`;
        }
      }
      return 'MCP 响应结构不符合 JSON-RPC 回执契约';
    })
    .then((line: string): void => {
      if (controller.signal.aborted) return;
      actions().appendTerminalLog(`[DEMO-DIRECTOR] ${line}`);
    })
    .catch((): void => {
      /* abort 与网络失败都走这里：不伪造成功，只诚实记一条 */
      if (controller.signal.aborted) return;
      actions().appendTerminalLog('[DEMO-DIRECTOR] MCP 执行请求失败（自愈已由 store 侧完成）');
    })
    .finally((): void => {
      if (mcpAbort === controller) mcpAbort = null;
    });
}

/**
 * 阶段动作表：scriptId → 按下标对齐的动作序列。
 *
 * 【为何按 scriptId + 下标而不是挂在 DemoPhase 上】见 DemoPhase 的注释：
 * 展示数据保持纯净，动作集中一处便于对照阅读与替换。
 */
const PHASE_ACTIONS: Readonly<Record<DemoScriptId, readonly (() => void)[]>> = {
  'oom-autofix': [
    enterCruise,
    (): void =>
      enterFaultAndLock('POD_OOM_SWARM', OOM_TARGET_NODE_ID, '阶段 2/4'),
    (): void =>
      enterAiDiagnosis(
        '检测到集群发生 OOMKilled 内存溢出告警，请结合 RAG 知识库定位根因并生成 MCP 自愈方案。',
        '阶段 3/4',
      ),
    (): void => enterHeal(OOM_TARGET_NODE_ID, '阶段 4/4'),
  ],
  'network-latency-trace': [
    enterCruise,
    (): void =>
      enterFaultAndLock('NET_PACKET_LOSS', NETWORK_TARGET_NODE_ID, '阶段 2/4'),
    (): void =>
      enterAiDiagnosis(
        '检测到跨节点网络延迟与丢包，请结合 RAG 知识库定位 CNI VXLAN 隧道瓶颈并生成 MCP 自愈方案。',
        '阶段 3/4',
      ),
    (): void => enterHeal(NETWORK_TARGET_NODE_ID, '阶段 4/4'),
  ],
};

/* ========================================================================== */
/* 定时器排程                                                                  */
/* ========================================================================== */

/**
 * 进入某个阶段（触发该阶段动作 + 说话）。
 *
 * @param index 阶段下标
 */
function enterPhase(index: number): void {
  const script = currentScript;
  if (script === null) return;
  phaseIndex = index;

  const phase = script.phases[index];
  const actionList = PHASE_ACTIONS[script.id];
  const action = actionList[index];
  if (action !== undefined) action();

  /* 语音解说：字幕与 TTS 同源，避免"念的和写的不一样" */
  if (phase !== undefined && narrator !== null) narrator(phase.narration);

  publish();
}

/**
 * 为 elapsedMs 之后仍会到点的阶段排定时器，并补触发已错过的阶段。
 *
 * 【为何要"补触发"】恢复时 accumulatedMs 可能已经越过某个阶段的天花板
 * （例如在 10.9s 暂停、11.5s 恢复）：那时该阶段早已该执行。
 * 若不补触发，画面会永远停在上一阶段的字幕上。
 *
 * @param elapsed 当前已用时长（毫秒）
 */
function scheduleFrom(elapsed: number): void {
  const script = currentScript;
  if (script === null) return;

  for (let i = 0; i < script.phases.length; i += 1) {
    const phase = script.phases[i];
    if (phase === undefined) continue;

    if (phase.atMs <= elapsed) {
      /* 已到点但还没进过 → 立即补触发 */
      if (i > phaseIndex) enterPhase(i);
      continue;
    }

    const delay = phase.atMs - elapsed;
    const handle = setTimeout((): void => {
      if (status !== 'running') return;
      enterPhase(i);
    }, delay);
    phaseTimers.push(handle);
  }

  /* 收尾定时器：到总时长后标记完成 */
  const remain = script.durationMs - elapsed;
  if (remain > 0) {
    const finishHandle = setTimeout((): void => {
      if (status !== 'running') return;
      finishDemoDirector();
    }, remain);
    phaseTimers.push(finishHandle);
  }
}

/** 启动进度心跳 */
function startTick(): void {
  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = setInterval((): void => {
    if (status !== 'running') return;
    publish();
  }, TICK_INTERVAL_MS);
}

/* ========================================================================== */
/* 公开 API                                                                    */
/* ========================================================================== */

/** 按 id 取剧本定义 */
export function getDemoScript(id: DemoScriptId): DemoScript | null {
  for (const script of DEMO_SCRIPTS) {
    if (script.id === id) return script;
  }
  return null;
}

/**
 * startDemoDirector —— 启动指定剧本。
 *
 * 若已有剧本在跑，会先完整停止（清定时器 + 复位集群），再启动新剧本。
 * 这样「切换剧本」不需要调用方自己考虑清理顺序。
 *
 * @param id 剧本标识
 */
export function startDemoDirector(id: DemoScriptId): void {
  const script = getDemoScript(id);
  if (script === null) return;

  /* 先彻底停掉上一轮，避免两套定时器同时向 store 写动作 */
  stopDemoDirector('switch');

  currentScript = script;
  status = 'running';
  phaseIndex = -1;
  accumulatedMs = 0;
  segmentStartedAt = performance.now();

  actions().appendTerminalLog(
    `[DEMO-DIRECTOR] ▶ 启动剧本「${script.title}」（约 ${Math.round(script.durationMs / 1000)} 秒）`,
  );

  /* 阶段 0 的 atMs 为 0 → scheduleFrom(0) 会立即补触发 */
  scheduleFrom(0);
  startTick();
  publish();
}

/**
 * pauseDemoDirector —— 暂停当前剧本（保留进度，可恢复）。
 *
 * 只对 running 生效；idle/finished 下调用是空操作。
 */
export function pauseDemoDirector(): void {
  if (status !== 'running') return;
  /* 冻结本段已用时间 */
  accumulatedMs += performance.now() - segmentStartedAt;
  status = 'paused';
  clearAllTimers();
  abortMcp();
  actions().appendTerminalLog('[DEMO-DIRECTOR] ⏸ 已暂停（进度保留，可继续）');
  publish();
}

/**
 * resumeDemoDirector —— 从暂停处继续。
 *
 * 只对 paused 生效。
 */
export function resumeDemoDirector(): void {
  if (status !== 'paused' || currentScript === null) return;
  status = 'running';
  segmentStartedAt = performance.now();
  /* 以当前累计时长为基准重新排程（含补触发已错过的阶段） */
  scheduleFrom(accumulatedMs);
  startTick();
  actions().appendTerminalLog('[DEMO-DIRECTOR] ▶ 已恢复');
  publish();
}

/** togglePauseDemoDirector —— running ↔ paused 一键切换 */
export function togglePauseDemoDirector(): void {
  if (status === 'running') {
    pauseDemoDirector();
    return;
  }
  if (status === 'paused') resumeDemoDirector();
}

/**
 * finishDemoDirector —— 时间轴自然走完时的收尾。
 *
 * 与 stop 的区别：完成后**保留**当前阶段的字幕与进度（进度条满格），
 * 让"刚刚跑完"这件事在界面上残留几秒，而不是瞬间消失。
 */
function finishDemoDirector(): void {
  clearAllTimers();
  abortMcp();
  status = 'finished';
  if (currentScript !== null) {
    phaseIndex = currentScript.phases.length - 1;
  }
  accumulatedMs = currentScript?.durationMs ?? 0;
  actions().appendTerminalLog('[DEMO-DIRECTOR] ■ 剧本已完整跑完');
  publish();
}

/**
 * stopDemoDirector —— 立即停止并复位。
 *
 * 【清理清单（缺一不可）】
 * · 全部 setTimeout / setInterval；
 * · 进行中的 MCP 请求（abort）；
 * · 集群混沌状态 / 镜头选中 / 环绕巡检 / 待执行自愈队列。
 *
 * @param reason 'user' 用户点击停止 / 'unmount' 组件卸载 / 'switch' 切换剧本
 */
export function stopDemoDirector(reason: 'user' | 'unmount' | 'switch' = 'user'): void {
  const wasActive = status === 'running' || status === 'paused';

  clearAllTimers();
  abortMcp();

  status = 'idle';
  currentScript = null;
  phaseIndex = -1;
  accumulatedMs = 0;
  segmentStartedAt = 0;

  /* 复位集群：只在真正跑过剧本时做，避免"停止"在 idle 下误清用户的手动操作 */
  if (wasActive) {
    resetToBaseline();
    if (reason === 'user') {
      actions().appendTerminalLog('[DEMO-DIRECTOR] ⏹ 已停止并复位集群稳态');
    } else if (reason === 'unmount') {
      actions().appendTerminalLog('[DEMO-DIRECTOR] ⏹ 组件卸载，已清理全部路演定时器');
    }
  }

  publish();
}

/**
 * subscribeDemoDirector —— 订阅状态变化。
 *
 * @param listener 变化回调
 * @returns 退订函数
 */
export function subscribeDemoDirector(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** getDemoDirectorSnapshot —— 读取当前快照（引用稳定，可直接给 useSyncExternalStore） */
export function getDemoDirectorSnapshot(): DemoDirectorSnapshot {
  return cachedSnapshot;
}

/* ========================================================================== */
/* React 接入                                                                  */
/* ========================================================================== */

/**
 * useDemoDirector —— 组件侧订阅钩子。
 *
 * 【为何用 useSyncExternalStore 而非 useState + useEffect】
 * 它天然处理 SSR（需提供 getServerSnapshot）与并发渲染下的撕裂问题，
 * 且订阅的是模块级单例，多个消费方（顶栏按钮、字幕条）永远读到同一份状态。
 *
 * 【卸载即停】钩子内部在卸载时调用 stopDemoDirector('unmount')：
 * 顶栏若因路由切换被卸载，后台绝不能还剩一串 setTimeout 在改 store。
 * stopDemoDirector 是幂等的，重复调用安全。
 */
export function useDemoDirector(): DemoDirectorSnapshot {
  const snapshot = useSyncExternalStore(
    subscribeDemoDirector,
    getDemoDirectorSnapshot,
    getDemoDirectorSnapshot,
  );

  useEffect((): (() => void) => {
    return (): void => {
      stopDemoDirector('unmount');
    };
  }, []);

  return snapshot;
}
