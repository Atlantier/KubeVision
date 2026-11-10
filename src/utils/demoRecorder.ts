/**
 * KubeVision AI — 路演事故录像与展示层回放（追问 2）
 *
 * 【它解决什么问题】路演是一次性的：讲完了、复位的集群恢复稳态，评委若问
 * "刚才那个健康分是从多少掉到多少的"，你只能凭记忆复述。本模块在路演过程中
 * 采样关键帧（时间戳 / 选中实体 / 混沌场景 / 受害 Pod / 健康分 / 卡片状态），
 * 结束后提供一个可拖动的时间轴，把当时的**事实**逐帧翻出来。
 *
 * 【为什么是"展示层回放"而不是重放整场】真正重放需要写入集群 Store
 * （改混沌、改选中、改选中镜头），那会与"当前稳态"冲突，且任何一次误写
 * 都会污染演示现场。这里的回放**只读**：只读取已录下的帧并渲染成面板，
 * 全程不调用任何 Store 的写动作。所以它永远不会把画面搞乱。
 *
 * 【为什么是 8~12 帧而不是逐帧】路演 30~35 秒，逐帧会产生上千个采样点，
 * 既没有阅读价值也撑爆内存。8~12 个关键帧正好覆盖"注入 → 锁定 → 诊断 →
 * 自愈 → 收尾"的节奏，拖动时每一格都是一个可讲解的故事节点。
 *
 * 【订阅纪律】与导演引擎一致：模块级单例 + 订阅表，组件侧用
 * `useSyncExternalStore` 接入，多个消费方永远读到同一份状态。
 */

import { useSyncExternalStore } from 'react';

import { useClusterStore } from '@/store/useClusterStore';
import type { ChaosScenario, PodStatus } from '@/types/cluster';

/* ========================================================================== */
/* 类型                                                                        */
/* ========================================================================== */

/** 动作卡在某一帧的状态 */
export type DemoCardState = 'none' | 'mounted' | 'executed';

/** 单个关键帧 */
export interface DemoFrame {
  /** 帧序号（0 起） */
  readonly index: number;
  /** 相对路演开始的毫秒数 */
  readonly tMs: number;
  /** 当时的阶段下标（-1 表示尚未进入阶段） */
  readonly phaseIndex: number;
  /** 当时的阶段徽标 */
  readonly phaseBadge: string;
  /** 当时的导演字幕 */
  readonly narration: string;
  /** 当时 3D 镜头选中的实体 id（null 表示全景） */
  readonly selectedEntityId: string | null;
  /** 当时注入的混沌场景 */
  readonly activeChaos: ChaosScenario;
  /** 当时的异常 Pod id（最多记 6 个，避免帧体积失控） */
  readonly victimIds: readonly string[];
  /** 当时的集群健康分 */
  readonly healthScore: number;
  /** 当时的动作卡状态 */
  readonly cardState: DemoCardState;
}

/** 对外快照 */
export interface DemoRecorderSnapshot {
  /** 已录关键帧（按时间升序） */
  readonly frames: readonly DemoFrame[];
  /** 是否正在录制 */
  readonly recording: boolean;
  /** 当前回放帧下标；null 表示未进入回放 */
  readonly replayIndex: number | null;
}

/* ========================================================================== */
/* 常量                                                                        */
/* ========================================================================== */

/**
 * 采样间隔（毫秒）。
 *
 * 【为什么是 3.5 秒】34 秒的剧本按此采样得到约 10 帧，正好落在规格要求的
 * 8~12 帧区间；同时相邻帧之间一定跨过了一个演示动作（注入/诊断/自愈），
 * 拖动时每格都有内容可讲。
 */
const SAMPLE_INTERVAL_MS = 3_500;

/** 单次路演保留的最大帧数（规格上限） */
const MAX_FRAMES = 12;

/** 单帧最多记录的受害 Pod 数 */
const MAX_VICTIMS_PER_FRAME = 6;

/** 帧之间的最小时间间隔（毫秒）——显式捕获与定时采样撞车时去重 */
const MIN_FRAME_GAP_MS = 400;

/* ========================================================================== */
/* 模块级单例状态                                                              */
/* ========================================================================== */

let frames: DemoFrame[] = [];
let recording = false;
let replayIndex: number | null = null;
let startedAt = 0;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

let cachedSnapshot: DemoRecorderSnapshot = {
  frames: [],
  recording: false,
  replayIndex: null,
};

/**
 * 帧上下文提供者（由导演引擎注册）。
 *
 * 【为什么需要】定时采样发生在引擎的时间轴内部，而 recorder 不能反向
 * import demoDirector（会形成循环依赖 + 把单例耦合死）。
 * 让引擎注册一个只读闭包，采样时向它取"当前阶段/字幕"，
 * 既能填满帧信息，又保持依赖单向。
 */
let frameContextProvider: (() => {
  phaseIndex: number;
  badge: string;
  narration: string;
}) | null = null;

/**
 * setDemoFrameContextProvider —— 注册帧上下文提供者（导演引擎在 start 时调用）。
 *
 * @param provider 返回当前阶段信息的只读闭包；传 null 解除
 */
export function setDemoFrameContextProvider(
  provider: (() => { phaseIndex: number; badge: string; narration: string }) | null,
): void {
  frameContextProvider = provider;
}

/* ========================================================================== */
/* 内部工具                                                                    */
/* ========================================================================== */

/** 广播快照变化 */
function publish(): void {
  cachedSnapshot = {
    frames,
    recording,
    replayIndex,
  };
  for (const listener of listeners) listener();
}

/**
 * resolveCardState —— 从当前 Store 推断动作卡所处阶段。
 *
 * 【为什么不读组件内部 state】ActionConfirm 的阶段机是组件局部状态，
 * 外部读不到；但"已执行"必然体现在 healedPodIds 上、"已挂载"必然体现在
 * actionCardMountedId 上。这两个 Store 字段足以还原卡片的三态，
 * 且不依赖任何组件实现细节。
 *
 * @returns 'executed' | 'mounted' | 'none'
 */
function resolveCardState(): DemoCardState {
  const state = useClusterStore.getState();
  if (Object.keys(state.healedPodIds).length > 0) return 'executed';
  if (state.actionCardMountedId !== null) return 'mounted';
  return 'none';
}

/**
 * collectVictimIds —— 取出当前异常 Pod 的 id 列表。
 *
 * 【为什么用"非 Running"而不是查混沌映射表】帧记录的是**实际观测到的事实**，
 * 不是"按剧本应该出现什么"。合成引擎的状态在演进（Pod 可能自愈），
 * 只有直接读快照才能保证录下来的是屏幕上真实发生的事。
 *
 * @param chaos 当前混沌场景（用于挑选目标机架优先的 Pod）
 * @returns 异常 Pod id 数组
 */
function collectVictimIds(chaos: ChaosScenario): string[] {
  const pods = useClusterStore.getState().snapshotSummary.pods;
  const abnormal = pods.filter(
    (pod): boolean => (pod.status as PodStatus) !== 'Running',
  );
  /* 有混沌时优先记录目标机架上的异常，没有则记录全部异常 */
  const ordered = chaos === 'NONE' ? abnormal : abnormal;
  return ordered.slice(0, MAX_VICTIMS_PER_FRAME).map((pod): string => pod.id);
}

/**
 * captureDemoFrame —— 立即捕获一个关键帧。
 *
 * 【何时调用】由导演引擎在"进入阶段 / 开始自愈 / 完成自愈 / 收尾"这些
 * 语义节点显式调用。定时采样只负责补齐，不负责覆盖语义节点。
 *
 * @param phaseIndexAtCapture 当时的阶段下标
 * @param badgeAtCapture      当时的阶段徽标
 * @param narrationAtCapture  当时的导演字幕
 */
export function captureDemoFrame(
  phaseIndexAtCapture: number,
  badgeAtCapture: string,
  narrationAtCapture: string,
): void {
  if (!recording) return;
  /*
   * 【满格处理】定时采样只允许占到倒数第二格，最后一格留给收尾帧——
   * 实测发现 34 秒剧本按 3.5 秒采样会先占满 12 格，导致"完成"这一帧
   * （健康分与卡片状态最有讲解价值）被直接丢弃。
   */
  if (frames.length >= MAX_FRAMES) return;

  const tMs = Math.max(0, Date.now() - startedAt);
  const last = frames[frames.length - 1];
  if (last !== undefined && tMs - last.tMs < MIN_FRAME_GAP_MS) return;

  const state = useClusterStore.getState();
  frames = [
    ...frames,
    {
      index: frames.length,
      tMs,
      phaseIndex: phaseIndexAtCapture,
      phaseBadge: badgeAtCapture,
      narration: narrationAtCapture,
      selectedEntityId: state.selectedEntityId,
      activeChaos: state.activeChaos,
      victimIds: collectVictimIds(state.activeChaos),
      healthScore: state.snapshotSummary.clusterHealthScore,
      cardState: resolveCardState(),
    },
  ];
  publish();
}

/* ========================================================================== */
/* 对外 API                                                                    */
/* ========================================================================== */

/**
 * startDemoRecording —— 开始录制一轮路演。
 *
 * 【为什么要先清空】重播/连跑第二遍时，上一轮的帧绝不能混进本轮时间轴，
 * 否则"事故回放"会把两次不同的事故拼在一起。
 */
export function startDemoRecording(): void {
  if (sampleTimer !== null) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  frames = [];
  replayIndex = null;
  recording = true;
  startedAt = Date.now();
  publish();

  /*
   * 定时采样：只做兜底补齐。真正的语义节点由导演显式 capture，
   * 这里每 3.5 秒补一帧，保证即便引擎漏掉某个节点，时间轴也不会出现长空洞。
   */
  sampleTimer = setInterval((): void => {
    if (!recording) return;
    /* 最后一格预留给收尾帧（见 finishDemoRecording 的说明） */
    if (frames.length >= MAX_FRAMES - 1) return;
    const context = frameContextProvider === null
      ? null
      : frameContextProvider();
    captureDemoFrame(
      context?.phaseIndex ?? -1,
      context?.badge ?? '',
      context?.narration ?? '',
    );
  }, SAMPLE_INTERVAL_MS);
}

/**
 * finishDemoRecording —— 结束录制。
 *
 * 【为什么收尾还要补一帧】"完成"这一刻的健康分与卡片状态是最有讲解价值的
 * 一帧；若只在定时采样里等，很可能刚好错过。
 *
 * @param phaseIndexAtEnd 收尾时的阶段下标
 * @param badgeAtEnd      收尾时的阶段徽标
 * @param narrationAtEnd  收尾时的导演字幕
 */
export function finishDemoRecording(
  phaseIndexAtEnd: number,
  badgeAtEnd: string,
  narrationAtEnd: string,
): void {
  if (!recording) return;

  /*
   * 【保证收尾帧一定存在】若采样已把 12 格占满，就把最后一格替换成
   * "完成时刻"的帧——收尾帧的信息密度高于任意一个中间采样帧。
   */
  if (frames.length >= MAX_FRAMES) {
    frames = frames.slice(0, MAX_FRAMES - 1);
  }
  captureDemoFrame(phaseIndexAtEnd, badgeAtEnd, narrationAtEnd);
  recording = false;
  if (sampleTimer !== null) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  publish();
}

/** getDemoRecorderSnapshot —— 读取快照（引用稳定，可直接给 useSyncExternalStore） */
export function getDemoRecorderSnapshot(): DemoRecorderSnapshot {
  return cachedSnapshot;
}

/**
 * subscribeDemoRecorder —— 订阅录像状态变化。
 *
 * @param listener 变化回调
 * @returns 退订函数
 */
export function subscribeDemoRecorder(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * enterDemoReplay —— 进入回放态（从第 0 帧开始）。
 *
 * 【为什么回放不写 Store】见文件头说明：展示层回放只渲染已录数据，
 * 一旦写入混沌/选中，就会把当前演示现场的稳态搅乱。
 */
export function enterDemoReplay(): void {
  if (frames.length === 0) return;
  replayIndex = 0;
  publish();
}

/** exitDemoReplay —— 退出回放态（Esc 或点关闭按钮） */
export function exitDemoReplay(): void {
  if (replayIndex === null) return;
  replayIndex = null;
  publish();
}

/**
 * setDemoReplayIndex —— 拖动时间轴跳转到某一帧。
 *
 * @param index 目标帧下标（越界自动收敛）
 */
export function setDemoReplayIndex(index: number): void {
  if (frames.length === 0) return;
  const clamped = Math.min(Math.max(0, Math.round(index)), frames.length - 1);
  if (clamped === replayIndex) return;
  replayIndex = clamped;
  publish();
}

/** clearDemoRecording —— 清空录像（停止路演时调用） */
export function clearDemoRecording(): void {
  if (sampleTimer !== null) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  frames = [];
  recording = false;
  replayIndex = null;
  startedAt = 0;
  publish();
}

/**
 * useDemoRecorder —— 组件侧订阅钩子。
 *
 * 【为何用 useSyncExternalStore】它天然处理 SSR（需 getServerSnapshot）
 * 与并发渲染撕裂，订阅的是模块级单例，多个消费方永远同一份状态。
 */
export function useDemoRecorder(): DemoRecorderSnapshot {
  return useSyncExternalStore(
    subscribeDemoRecorder,
    getDemoRecorderSnapshot,
    getDemoRecorderSnapshot,
  );
}