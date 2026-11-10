/**
 * KubeVision AI — 路演导演纯状态机（R04 / 交付项 B）
 *
 * 【为什么要从 demoDirector 里抽出来】`demoDirector.ts` 把三件事揉在一起：
 *   1. **状态与时间**：当前第几阶段、已用多久、暂停/恢复、节奏换算、断点等待；
 *   2. **副作用**：改 Store（注入混沌/选中镜头/触发诊断）、写日志、发 TTS；
 *   3. **异步链路**：等 AI 流、等动作卡、调用 MCP、校验自愈覆盖。
 * 第 2、3 类只能在浏览器里跑（依赖 Store / DOM / fetch），但它们**不该**决定
 * "什么时候进入下一阶段"。把第 1 类抽成纯状态机后：
 *
 *   · 逻辑可以用 `node:test` 直接测——注入假时钟，毫秒级跑完"暂停 4 秒再恢复"
 *     这种真实要等 4 秒的场景；
 *   · 边界条件（跨阶段补触发、超时兜底、effects 抛错）可以在单测里穷举，
 *     不必靠 CDP 反复跑 40 秒的路演去碰运气；
 *   · 真实 UI 的行为仍由 CDP 脚本（scripts/verify-demo.mjs）负责。
 *
 * 【纯度契约】本文件**不 import 任何东西**：
 *   · 不引 React / Store / DOM / three；
 *   · 时间来自注入的 `DemoClock`，而不是 `performance.now()` / `setTimeout`；
 *   · 一切外部动作经 `DemoEffects` 回调出去。
 * 因此它可以在 Node、浏览器、测试三处以完全相同的行为运行。
 *
 * 【与 demoDirector 的关系】demoDirector 是**适配器**：它提供真实 effects 与
 * 真实 clock，并负责异步链路；状态机的唯一职责是"按时间推进阶段并广播事件"。
 */

/* ========================================================================== */
/* 类型                                                                        */
/* ========================================================================== */

/** 状态机状态 */
export type DemoMachineStatus = 'idle' | 'running' | 'paused' | 'finished';

/** 节奏模式（与产品侧 DemoPacingKind 对齐） */
export type DemoMachinePacing = 'standard' | 'compact' | 'narrator';

/** 状态机需要的最小阶段信息 */
export interface DemoMachinePhase {
  readonly index: number;
  readonly atMs: number;
  readonly badge: string;
}

/** 状态机需要的最小剧本信息 */
export interface DemoMachineScript {
  readonly id: string;
  /** 标准节奏总时长（所有 atMs 的时间基准） */
  readonly durationMs: number;
  /** 三种节奏的总时长 */
  readonly pacing: Readonly<Record<DemoMachinePacing, number>>;
  readonly phases: readonly DemoMachinePhase[];
}

/**
 * 可注入时钟。
 *
 * 【为什么要注入而不是直接用 setTimeout】单测里需要一个"可以瞬间拨快"的
 * 时钟；真实运行时用宿主定时器。两者都实现这三个方法即可。
 */
export interface DemoClock {
  /** 单调递增的毫秒时间源 */
  now(): number;
  /**
   * 安排一次回调。
   *
   * @param delayMs 延迟毫秒
   * @param fn 回调
   * @returns 定时器句柄
   */
  schedule(delayMs: number, fn: () => void): number;
  /**
   * 取消定时器。
   *
   * @param handle schedule 返回的句柄
   */
  clear(handle: number): void;
}

/**
 * 外部副作用集合。
 *
 * 【设计原则】状态机只管"该做什么"，不关心"怎么做"。真实实现的
 * `onPhaseEnter` 会去改 Store，测试实现只往数组里 push 一条记录。
 */
export interface DemoEffects {
  /** 进入某阶段（真实实现 = 注入混沌/锁镜头/触发诊断） */
  onPhaseEnter(index: number): void;
  /** 时间轴自然走完 */
  onFinish(): void;
  /** 写一行终端日志 */
  onLog(line: string): void;
  /** 通知订阅方刷新快照 */
  onPublish(): void;
  /**
   * 启动前预检。
   *
   * @returns 通过返回 null；失败返回人类可读原因
   */
  preflight(): string | null;
  /**
   * 事件门超时兜底被触发时调用（可选）。
   *
   * 【为什么需要】阶段 3→4 由"AI 流结束 + 动作卡挂载"驱动。一旦外部事件
   * 迟迟不来，必须有兜底把演示推下去，否则整场卡在 3/4。兜底时必须让上层
   * 能写出"诊断未在预期时间内完成"这类如实说明，所以留这个回调。
   */
  onGateTimeout?(): void;
}

/** 对外快照 */
export interface DemoMachineSnapshot {
  readonly status: DemoMachineStatus;
  readonly phaseIndex: number;
  readonly pacing: DemoMachinePacing;
  readonly elapsedMs: number;
  readonly durationMs: number;
  readonly progress: number;
  readonly awaitingBreakpoint: boolean;
  readonly finishReason: 'natural' | 'stopped' | 'preflight' | 'effects-error' | null;
}

/** 状态机实例 */
export interface DemoMachine {
  /** 启动（含预检） */
  start(): { readonly ok: boolean; readonly reason?: string };
  /** 暂停（冻结时间） */
  pause(): void;
  /** 恢复 */
  resume(): void;
  /** 停止（清全部定时器） */
  stop(): void;
  /** 切换节奏（按比例重算已用时长） */
  setPacing(mode: DemoMachinePacing): void;
  /** 讲解版断点：继续到下一阶段 */
  advanceBreakpoint(): void;
  /**
   * 装上事件门：暂停"自动进入下一阶段"，改为等 resolveGate() 或超时兜底。
   *
   * @param timeoutMs 超时毫秒（到点后触发 onGateTimeout 并兜底推进）
   */
  armGate(timeoutMs: number): void;
  /** 外部事件已满足：立即开门并推进 */
  resolveGate(): void;
  /** 当前快照 */
  snapshot(): DemoMachineSnapshot;
  /** 存活定时器数（调试/断言用） */
  timerCount(): number;
}

/* ========================================================================== */
/* 常量                                                                        */
/* ========================================================================== */

/**
 * 收尾最短宽限期（毫秒）。
 *
 * 事件驱动推进可能让 elapsed 超过总时长；若立刻收尾，最后阶段根本没机会跑。
 */
const MIN_FINISH_GRACE_MS = 6_000;

/** 阶段边界判定容差（毫秒）——避免浮点带来的"差 0.0001ms 不进阶段" */
const BOUNDARY_EPSILON_MS = 1;

/* ========================================================================== */
/* 实现                                                                        */
/* ========================================================================== */

/**
 * createDemoMachine —— 构造一个纯路演状态机。
 *
 * @param script 剧本（阶段 + 三档时长）
 * @param effects 副作用集合
 * @param clock 可注入时钟
 * @returns 状态机实例
 */
export function createDemoMachine(
  script: DemoMachineScript,
  effects: DemoEffects,
  clock: DemoClock,
): DemoMachine {
  let status: DemoMachineStatus = 'idle';
  let pacing: DemoMachinePacing = 'standard';
  let phaseIndex = -1;
  /** 已结算的累计时长（暂停/切节奏时把当前段并入） */
  let accumulatedMs = 0;
  /** 当前运行段的起点（clock.now() 时间系） */
  let segmentStartedAt = 0;
  /** 是否停在讲解版断点 */
  let awaitingBreakpoint = false;
  /** 断点要推进到的阶段下标 */
  let pendingIndex = -1;
  /** 结束原因 */
  let finishReason: DemoMachineSnapshot['finishReason'] = null;

  /** 阶段定时器句柄（按阶段下标索引） */
  const phaseHandles = new Map<number, number>();
  /** 收尾定时器句柄 */
  let finishHandle: number | null = null;
  /** 事件门：是否正在等外部事件 */
  let gateArmed = false;
  /** 事件门句柄 */
  let gateHandle: number | null = null;
  /** 事件门要推进到的阶段下标（-1 表示无） */
  let gateTarget = -1;

  /* ---------------- 内部工具 ---------------- */

  /** 当前节奏下的总时长 */
  const effectiveDuration = (): number => script.pacing[pacing];

  /**
   * 节奏相对标准时间轴的倍数。
   *
   * @returns 倍数（标准节奏为 1）
   */
  const pacingRatio = (): number => {
    if (script.pacing.standard <= 0) return 1;
    return script.pacing[pacing] / script.pacing.standard;
  };

  /**
   * 把标准时间轴位置换算到当前节奏。
   *
   * @param atMs 标准时间轴毫秒位置
   * @returns 当前节奏下的毫秒位置
   */
  const scaledAt = (atMs: number): number => Math.round(atMs * pacingRatio());

  /** 当前已用时长 */
  const elapsed = (): number => {
    if (status !== 'running') return accumulatedMs;
    return accumulatedMs + (clock.now() - segmentStartedAt);
  };

  /** 清空全部定时器 */
  const clearAll = (): void => {
    for (const handle of phaseHandles.values()) clock.clear(handle);
    phaseHandles.clear();
    if (finishHandle !== null) {
      clock.clear(finishHandle);
      finishHandle = null;
    }
    if (gateHandle !== null) {
      clock.clear(gateHandle);
      gateHandle = null;
    }
    gateArmed = false;
    gateTarget = -1;
  };

  /**
   * 安全调用 effects。
   *
   * 【为什么必须兜住异常】effects 是外部实现（改 Store / 写日志）。
   * 一旦它抛错而状态机继续跑，就会出现"阶段推进了但画面没变"的静默错位。
   * 契约是：**effects 抛错 = 立即停止并清理**，让上层能看到停在哪里。
   *
   * @param fn 待调用回调
   * @returns true 表示成功；false 表示已因异常停机
   */
  const safe = (fn: () => void): boolean => {
    try {
      fn();
      return true;
    } catch {
      clearAll();
      status = 'idle';
      finishReason = 'effects-error';
      awaitingBreakpoint = false;
      pendingIndex = -1;
      try {
        effects.onLog('[DEMO-MACHINE] effects 抛错，已停止并清理全部定时器');
      } catch {
        /* 日志本身失败也不能再抛 */
      }
      return false;
    }
  };

  /**
   * 收尾。
   *
   * @param reason 结束原因
   */
  const finish = (reason: NonNullable<DemoMachineSnapshot['finishReason']>): void => {
    clearAll();
    status = 'finished';
    finishReason = reason;
    accumulatedMs = effectiveDuration();
    phaseIndex = script.phases.length - 1;
    safe(() => effects.onFinish());
    safe(() => effects.onPublish());
  };

  /**
   * 进入某阶段（内部）。
   *
   * @param index 阶段下标
   */
  const enterPhase = (index: number): void => {
    phaseIndex = index;
    if (!safe(() => effects.onPhaseEnter(index))) return;
    safe(() => effects.onPublish());
  };

  /**
   * 推进到事件门锁定的目标阶段。
   *
   * @param byTimeout 是否由超时兜底触发
   */
  const openGate = (byTimeout: boolean): void => {
    if (!gateArmed) return;
    const target = gateTarget;
    gateArmed = false;
    gateTarget = -1;
    if (gateHandle !== null) {
      clock.clear(gateHandle);
      gateHandle = null;
    }
    if (byTimeout) safe(() => effects.onGateTimeout?.());
    if (target >= 0 && target < script.phases.length && target > phaseIndex) {
      enterPhase(target);
    }
    /* 开门后按新进度重排剩余阶段与收尾 */
    reschedule();
  };

  /**
   * 按当前已用时长重排所有尚未触发的阶段与收尾。
   *
   * 【跨阶段补触发】若此刻 elapsed 已越过多个阶段（例如从暂停恢复时
   * 时间被切节奏压缩了），必须**按顺序补进**每一个 due 阶段，
   * 而不是只进最后一个——否则中间的副作用（注入混沌/触发诊断）会被跳过。
   */
  const reschedule = (): void => {
    clearAll();
    if (status !== 'running') return;

    const nowElapsed = elapsed();

    for (const phase of script.phases) {
      /*
       * 【effects 抛错后必须立即收手】enterPhase 内部会把状态机停机，
       * 但循环若继续，会把剩余阶段与收尾定时器重新排上——于是"已停机"
       * 的状态机还留着 4 个定时器（单测实测抓到的缺陷）。
       */
      if (status !== 'running') return;

      const at = scaledAt(phase.atMs);

      if (at <= nowElapsed + BOUNDARY_EPSILON_MS) {
        /* 已到点但还没进过 → 立即补触发 */
        if (phase.index > phaseIndex) {
          enterPhase(phase.index);
          if (status !== 'running') return;
        }
        continue;
      }

      /*
       * 【事件门优先】门装上时，下一阶段的自动推进必须让位给门：
       * 门自己会在事件满足或超时时决定何时进入，否则两个推进源会打架。
       */
      if (gateArmed && gateTarget === phase.index) continue;

      const delay = at - nowElapsed;
      const handle = clock.schedule(delay, (): void => {
        phaseHandles.delete(phase.index);
        if (status !== 'running') return;
        if (awaitingBreakpoint) return;

        /*
         * 讲解版：停在断点等主讲人按空格。
         * 关键点：把当前段并入 accumulatedMs 并把状态切到 paused，
         * 否则"暂停"期间 elapsed 会继续增长，进度条自己往前跑。
         */
        if (pacing === 'narrator') {
          accumulatedMs = elapsed();
          segmentStartedAt = clock.now();
          status = 'paused';
          awaitingBreakpoint = true;
          pendingIndex = phase.index;
          clearAll();
          safe(() => effects.onLog('[DEMO-MACHINE] 讲解版断点：等待继续'));
          safe(() => effects.onPublish());
          return;
        }

        enterPhase(phase.index);
      });
      phaseHandles.set(phase.index, handle);
    }

    scheduleFinish();
  };

  /**
   * 安排收尾定时器。
   *
   * 【为什么门未决时要推迟】事件门可能把某阶段压到总时长之后才决断
   * （实测：34s 剧本 + 从阶段 3 起算的 25s 门 = 36s）。若收尾定时器
   * 照常在 34s 触发，整场路演会在门之前结束——门既等不到事件也等不到
   * 超时，事件驱动形同虚设。因此到点时若门仍装着就重新排一次。
   */
  const scheduleFinish = (): void => {
    const nowElapsed = elapsed();
    const remain = Math.max(effectiveDuration() - nowElapsed, MIN_FINISH_GRACE_MS);
    finishHandle = clock.schedule(remain, (): void => {
      finishHandle = null;
      if (status !== 'running') return;
      if (gateArmed) {
        /* 门还没开：重新排一次收尾，等门自己决断（门有超时，不会无限等） */
        scheduleFinish();
        return;
      }
      finish('natural');
    });
  };

  /* ---------------- 对外 API ---------------- */

  const machine: DemoMachine = {
    start(): { readonly ok: boolean; readonly reason?: string } {
      /* 预检失败分支：不启动、不排程、不进任何阶段 */
      const reason = effects.preflight();
      if (reason !== null) {
        status = 'idle';
        finishReason = 'preflight';
        phaseIndex = -1;
        accumulatedMs = 0;
        clearAll();
        safe(() => effects.onLog(`[DEMO-MACHINE] 预检未通过：${reason}`));
        safe(() => effects.onPublish());
        return { ok: false, reason };
      }

      status = 'running';
      finishReason = null;
      phaseIndex = -1;
      accumulatedMs = 0;
      segmentStartedAt = clock.now();
      awaitingBreakpoint = false;
      pendingIndex = -1;
      clearAll();

      reschedule();
      safe(() => effects.onPublish());
      return { ok: true };
    },

    pause(): void {
      if (status !== 'running') return;
      accumulatedMs = elapsed();
      segmentStartedAt = clock.now();
      status = 'paused';
      clearAll();
      safe(() => effects.onPublish());
    },

    resume(): void {
      if (status !== 'paused') return;
      /* 断点态走断点推进，走常规 resume 会立刻又停回同一边界 */
      if (awaitingBreakpoint) {
        machine.advanceBreakpoint();
        return;
      }
      status = 'running';
      segmentStartedAt = clock.now();
      reschedule();
      safe(() => effects.onPublish());
    },

    stop(): void {
      clearAll();
      status = 'idle';
      finishReason = 'stopped';
      phaseIndex = -1;
      accumulatedMs = 0;
      segmentStartedAt = clock.now();
      awaitingBreakpoint = false;
      pendingIndex = -1;
      safe(() => effects.onPublish());
    },

    setPacing(mode: DemoMachinePacing): void {
      if (mode === pacing) return;

      const oldTotal = effectiveDuration();
      const oldElapsed = elapsed();
      const wasRunning = status === 'running';

      pacing = mode;
      const newTotal = effectiveDuration();

      /* 按比例折算已用时长：progress 不变，只换刻度 */
      if (oldTotal > 0 && newTotal > 0 && oldElapsed > 0) {
        accumulatedMs = Math.round(oldElapsed * (newTotal / oldTotal));
      }
      segmentStartedAt = clock.now();
      awaitingBreakpoint = false;
      pendingIndex = -1;

      if (wasRunning) reschedule();
      safe(() => effects.onPublish());
    },

    armGate(timeoutMs: number): void {
      const target = phaseIndex + 1;
      if (target >= script.phases.length) return;

      /* 先撤销该阶段原有的自动推进定时器 */
      const existing = phaseHandles.get(target);
      if (existing !== undefined) {
        clock.clear(existing);
        phaseHandles.delete(target);
      }
      if (gateHandle !== null) {
        clock.clear(gateHandle);
        gateHandle = null;
      }

      gateArmed = true;
      gateTarget = target;
      gateHandle = clock.schedule(Math.max(0, timeoutMs), (): void => {
        gateHandle = null;
        if (status !== 'running') return;
        openGate(true);
      });
      safe(() => effects.onPublish());
    },

    resolveGate(): void {
      if (!gateArmed) return;
      if (status !== 'running') return;
      openGate(false);
    },

    advanceBreakpoint(): void {
      if (!awaitingBreakpoint) return;
      const target = pendingIndex;
      awaitingBreakpoint = false;
      pendingIndex = -1;

      status = 'running';
      segmentStartedAt = clock.now();

      if (target >= 0 && target < script.phases.length && target > phaseIndex) {
        enterPhase(target);
      }
      reschedule();
      safe(() => effects.onPublish());
    },

    snapshot(): DemoMachineSnapshot {
      const total = effectiveDuration();
      const used = Math.min(elapsed(), total);
      return {
        status,
        phaseIndex,
        pacing,
        elapsedMs: Math.round(used),
        durationMs: total,
        progress: total <= 0 ? 0 : Math.min(1, Math.max(0, used / total)),
        awaitingBreakpoint,
        finishReason,
      };
    },

    timerCount(): number {
      return (
        phaseHandles.size +
        (finishHandle === null ? 0 : 1) +
        (gateHandle === null ? 0 : 1)
      );
    },
  };

  return machine;
}