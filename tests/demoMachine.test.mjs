/**
 * KubeVision AI — 导演纯状态机单测（R04 / 交付项 B）
 *
 * 【分工】单测管**逻辑**：时间推进、暂停恢复、跨阶段补触发、节奏换算、
 * effects 抛错清理、事件门超时兜底、预检失败。这些都不需要浏览器。
 * 真实 UI（3D 画面、卡片挂载、MCP 回执）由 scripts/verify-demo.mjs 用 CDP 覆盖。
 *
 * 【为什么能毫秒级跑完"暂停 4 秒"】状态机的时间来自注入的假时钟，
 * `clock.advance(4000)` 一次就把 4 秒走完，不需要真的等待。
 *
 * 【运行方式】`pnpm test:demo`（会先用 tsc 把 TS 编译成 CJS 再跑）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDemoMachine } = require('../tmp-demo-test/demoMachine.js');

/* ========================================================================== */
/* 测试替身                                                                    */
/* ========================================================================== */

/**
 * 假时钟。
 *
 * 【能力】now / schedule / clear + advance(ms)：把所有到期定时器按时间顺序
 * 依次触发，并同步推进 now，保证状态机看到的时序是真实的。
 *
 * @param {number} start 起始时间
 * @returns {object} 时钟 + 测试辅助
 */
function makeClock(start = 0) {
  let now = start;
  let seq = 0;
  const timers = new Map();

  return {
    now: () => now,
    schedule(delay, fn) {
      const handle = (seq += 1);
      timers.set(handle, { at: now + delay, fn });
      return handle;
    },
    clear(handle) {
      timers.delete(handle);
    },
    /**
     * 推进时间并触发所有到期回调。
     *
     * @param {number} ms 推进毫秒
     */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let pick = null;
        for (const [handle, timer] of timers) {
          if (timer.at > target) continue;
          if (
            pick === null ||
            timer.at < pick.timer.at ||
            (timer.at === pick.timer.at && handle < pick.handle)
          ) {
            pick = { handle, timer };
          }
        }
        if (pick === null) break;
        timers.delete(pick.handle);
        now = pick.timer.at;
        pick.timer.fn();
      }
      now = target;
    },
    /** 剩余定时器数（用于断言"清理干净"） */
    pending: () => timers.size,
  };
}

/** 测试剧本：4 阶段，标准 34s / 紧凑 20s / 讲解版 34s */
const SCRIPT = {
  id: 'test-script',
  durationMs: 34_000,
  pacing: { standard: 34_000, compact: 20_000, narrator: 34_000 },
  phases: [
    { index: 0, atMs: 0, badge: 'P0' },
    { index: 1, atMs: 5_000, badge: 'P1' },
    { index: 2, atMs: 11_000, badge: 'P2' },
    { index: 3, atMs: 26_000, badge: 'P3' },
  ],
};

/**
 * 造一组记录型 effects。
 *
 * @param {object} overrides 覆盖任意 effects 方法
 * @returns {{effects: object, rec: object}}
 */
function makeEffects(overrides = {}) {
  const rec = {
    enters: [],
    logs: [],
    finishes: 0,
    publishes: 0,
    timeouts: 0,
  };
  const effects = {
    onPhaseEnter(index) {
      rec.enters.push(index);
    },
    onFinish() {
      rec.finishes += 1;
    },
    onLog(line) {
      rec.logs.push(line);
    },
    onPublish() {
      rec.publishes += 1;
    },
    preflight() {
      return null;
    },
    onGateTimeout() {
      rec.timeouts += 1;
    },
    ...overrides,
  };
  return { effects, rec };
}

/**
 * 造一个已就绪的状态机。
 *
 * @param {object} overrides effects 覆盖
 * @returns {{machine: object, clock: object, rec: object}}
 */
function makeMachine(overrides = {}) {
  const clock = makeClock();
  const { effects, rec } = makeEffects(overrides);
  const machine = createDemoMachine(SCRIPT, effects, clock);
  return { machine, clock, rec };
}

/* ========================================================================== */
/* 预检失败分支                                                                */
/* ========================================================================== */

test('预检失败：不启动、不进任何阶段、定时器为 0', () => {
  const clock = makeClock();
  const { effects, rec } = makeEffects({
    preflight() {
      return '未找到 3D 集群拓扑视口';
    },
  });
  const machine = createDemoMachine(SCRIPT, effects, clock);

  const started = machine.start();

  assert.equal(started.ok, false);
  assert.equal(started.reason, '未找到 3D 集群拓扑视口');
  assert.deepEqual(rec.enters, [], '预检失败时不得进入任何阶段');
  assert.equal(rec.finishes, 0);
  assert.equal(machine.snapshot().status, 'idle');
  assert.equal(machine.timerCount(), 0, '预检失败不得留下定时器');
  assert.ok(
    rec.logs.some((l) => l.includes('预检未通过')),
    '必须留下可查日志',
  );
  assert.equal(machine.snapshot().finishReason, 'preflight');
});

/* ========================================================================== */
/* 正常推进与自然收尾                                                          */
/* ========================================================================== */

test('正常推进：阶段按 atMs 依次进入，到总时长自然收尾', () => {
  const { machine, clock, rec } = makeMachine();
  machine.start();

  assert.deepEqual(rec.enters, [0], '阶段 0（atMs=0）应在 start 时立即进入');

  clock.advance(5_000);
  assert.deepEqual(rec.enters, [0, 1]);

  clock.advance(6_000);
  assert.deepEqual(rec.enters, [0, 1, 2]);

  clock.advance(15_000);
  assert.deepEqual(rec.enters, [0, 1, 2, 3]);

  clock.advance(8_000);
  assert.equal(rec.finishes, 1);
  const snap = machine.snapshot();
  assert.equal(snap.status, 'finished');
  assert.equal(snap.finishReason, 'natural');
  assert.equal(snap.progress, 1);
  assert.equal(machine.timerCount(), 0, '收尾后不得残留定时器');
});

/* ========================================================================== */
/* 暂停 / 恢复                                                                 */
/* ========================================================================== */

test('暂停期间时间冻结、阶段不推进；恢复后从原处继续', () => {
  const { machine, clock, rec } = makeMachine();
  machine.start();
  clock.advance(3_000);

  machine.pause();
  assert.equal(machine.snapshot().status, 'paused');
  assert.equal(machine.snapshot().elapsedMs, 3_000);

  /* 暂停 10 秒：时间不得前进，也不得进入阶段 1（atMs=5000） */
  clock.advance(10_000);
  assert.equal(machine.snapshot().elapsedMs, 3_000, '暂停期间已用时长必须冻结');
  assert.deepEqual(rec.enters, [0], '暂停期间不得推进阶段');

  machine.resume();
  assert.equal(machine.snapshot().status, 'running');

  clock.advance(2_500);
  assert.equal(machine.snapshot().elapsedMs, 5_500, '恢复后从暂停点继续累计');
  assert.deepEqual(rec.enters, [0, 1]);
});

/* ========================================================================== */
/* 跨阶段补触发                                                                */
/* ========================================================================== */

test('跨阶段补触发：时间越过多个阶段时按顺序全部补进', () => {
  const { machine, clock, rec } = makeMachine();
  machine.start();
  clock.advance(3_000);
  machine.pause();

  /*
   * 暂停时切紧凑：已用时长按比例折算成 round(3000*20000/34000)=1765ms。
   * 恢复后再走 5 秒 → 6771ms，此时紧凑时间轴上阶段 1(2941) 与阶段 2(6471)
   * 都已到期，必须**按序**补进，不能只进最后一个。
   */
  machine.setPacing('compact');
  assert.equal(machine.snapshot().elapsedMs, 1_765);

  machine.resume();
  clock.advance(5_000);

  assert.deepEqual(rec.enters, [0, 1, 2], '两个逾期阶段都要补进且顺序正确');
  assert.equal(machine.snapshot().phaseIndex, 2);
});

/* ========================================================================== */
/* 节奏切换                                                                    */
/* ========================================================================== */

test('切换节奏：进度比例保持不变，总时长按新模式重算', () => {
  const { machine, clock } = makeMachine();
  machine.start();
  clock.advance(10_000);

  const before = machine.snapshot();
  assert.equal(before.durationMs, 34_000);
  assert.equal(before.elapsedMs, 10_000);
  const progressBefore = before.progress;

  machine.setPacing('compact');
  const after = machine.snapshot();

  assert.equal(after.pacing, 'compact');
  assert.equal(after.durationMs, 20_000, '紧凑节奏总时长应为 20s');
  assert.equal(after.elapsedMs, Math.round(10_000 * (20_000 / 34_000)));
  assert.ok(
    Math.abs(after.progress - progressBefore) < 0.01,
    `进度比例应保持：${progressBefore} vs ${after.progress}`,
  );
  assert.equal(after.phaseIndex, before.phaseIndex, '切节奏不得重置已完成的阶段');
});

/* ========================================================================== */
/* effects 抛错时的清理                                                        */
/* ========================================================================== */

test('effects 抛错：立即停机、清空定时器、留日志', () => {
  let thrown = 0;
  const clock = makeClock();
  const { effects, rec } = makeEffects({
    onPhaseEnter() {
      thrown += 1;
      throw new Error('store write failed');
    },
  });
  const machine = createDemoMachine(SCRIPT, effects, clock);

  machine.start();

  assert.equal(thrown, 1);
  assert.equal(machine.snapshot().status, 'idle', 'effects 抛错后必须停机');
  assert.equal(machine.timerCount(), 0, '必须清理全部定时器');
  assert.equal(clock.pending(), 0, '底层时钟上也不得有残留');
  assert.ok(
    rec.logs.some((l) => l.includes('effects 抛错')),
    '必须留下可查日志',
  );
  assert.equal(machine.snapshot().finishReason, 'effects-error');

  /* 停机后继续拨时间也不得有副作用 */
  const entersBefore = rec.enters.length;
  clock.advance(60_000);
  assert.equal(rec.enters.length, entersBefore);
  assert.equal(rec.finishes, 0);
});

/* ========================================================================== */
/* 事件门：超时兜底与事件满足                                                   */
/* ========================================================================== */

test('事件门：超时兜底推进并回调 onGateTimeout', () => {
  const { machine, clock, rec } = makeMachine();
  machine.start();
  clock.advance(11_000);
  assert.deepEqual(rec.enters, [0, 1, 2]);

  machine.armGate(25_000);
  /* 门装上后，阶段 3（atMs=26000）的自动推进被接管 */
  clock.advance(24_000);
  assert.deepEqual(rec.enters, [0, 1, 2], '门未决期间不得自动进入阶段 3');

  clock.advance(1_000);
  assert.equal(rec.timeouts, 1, '超时必须触发 onGateTimeout（上层据此写如实旁白）');
  assert.ok(rec.enters.includes(3), '超时兜底后必须推进到阶段 3');
});

test('事件门：外部事件先到则立即推进且不触发超时', () => {
  const { machine, clock, rec } = makeMachine();
  machine.start();
  clock.advance(11_000);

  machine.armGate(25_000);
  machine.resolveGate();

  assert.ok(rec.enters.includes(3), '事件满足应立即推进');
  assert.equal(rec.timeouts, 0, '事件先到时不得触发超时回调');
  assert.equal(clock.pending() >= 0, true);
});

/* ========================================================================== */
/* 讲解版断点                                                                  */
/* ========================================================================== */

test('讲解版断点：阶段边界暂停等待，推进后才进入下一阶段', () => {
  const { machine, clock, rec } = makeMachine();
  machine.setPacing('narrator');
  machine.start();

  clock.advance(5_000);
  const paused = machine.snapshot();
  assert.equal(paused.status, 'paused', '讲解版断点应表现为暂停（时间要真的停）');
  assert.equal(paused.awaitingBreakpoint, true);
  assert.deepEqual(rec.enters, [0], '断点处不得自动进入阶段 1');

  /* 断点期间时间不得前进 */
  const elapsedAtBreak = paused.elapsedMs;
  clock.advance(8_000);
  assert.equal(machine.snapshot().elapsedMs, elapsedAtBreak);

  machine.advanceBreakpoint();
  assert.equal(machine.snapshot().status, 'running');
  assert.equal(machine.snapshot().awaitingBreakpoint, false);
  assert.deepEqual(rec.enters, [0, 1], '按继续后才进入阶段 1');
});

/* ========================================================================== */
/* 停止                                                                        */
/* ========================================================================== */

test('停止：清空定时器、回到 idle、不再有任何推进', () => {
  const { machine, clock, rec } = makeMachine();
  machine.start();
  clock.advance(6_000);
  assert.deepEqual(rec.enters, [0, 1]);

  machine.stop();
  assert.equal(machine.snapshot().status, 'idle');
  assert.equal(machine.timerCount(), 0);
  assert.equal(clock.pending(), 0);
  assert.equal(machine.snapshot().finishReason, 'stopped');

  const entersBefore = rec.enters.length;
  clock.advance(60_000);
  assert.equal(rec.enters.length, entersBefore, '停止后不得再推进');
  assert.equal(rec.finishes, 0);
});

/* ========================================================================== */
/* 幂等守卫（无操作分支）                                                      */
/* ========================================================================== */

test('幂等守卫：非法时机调用均为无操作且不产生副作用', () => {
  const { machine, clock, rec } = makeMachine();

  /* idle 下暂停/恢复/断点推进都不应改变状态 */
  machine.pause();
  machine.resume();
  machine.advanceBreakpoint();
  machine.resolveGate();
  assert.equal(machine.snapshot().status, 'idle');
  assert.deepEqual(rec.enters, []);

  machine.start();
  clock.advance(1_000);

  /* 同节奏切换应直接返回（不重排、不改时长） */
  const elapsedBefore = machine.snapshot().elapsedMs;
  machine.setPacing('standard');
  assert.equal(machine.snapshot().elapsedMs, elapsedBefore);

  /* 未装门时 resolveGate 无操作 */
  const entersBefore = rec.enters.length;
  machine.resolveGate();
  assert.equal(rec.enters.length, entersBefore);

  /* 重复 start 会重置到阶段 0 之前，但不应把定时器翻倍 */
  const timersBefore = machine.timerCount();
  machine.start();
  assert.ok(machine.timerCount() <= timersBefore, '重复 start 不得累积定时器');

  machine.stop();
  machine.stop();
  assert.equal(machine.snapshot().status, 'idle');
  assert.equal(machine.timerCount(), 0);
});
