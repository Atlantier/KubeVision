/**
 * KubeVision AI — 流式消费内核单测（R2）
 *
 * 【守护的不变量】
 *  1. 收尾三态：收到 done=normal / 未收到=incomplete / 解析出错=error；
 *  2. finalize 幂等：重复调用不重复出队、不重复补丁（无重复 assistant 气泡来源）；
 *  3. 中止不回落：abort 收尾不打 failed/incomplete、不播报；
 *  4. 看门狗：重复登记不泄漏旧定时器、finalize 清空、tool-result 撤销；
 *  5. 排队 FIFO：连发不丢、按序出队；
 *  6. 截断流：UTF-8 跨 chunk 不乱码、无 '\n' 残行不丢尾、缺 done 提示 incomplete。
 *
 * 【测法】内核是纯逻辑（注入副作用），无需 React / 无需起服务。定时器用可控假时钟，
 * 断言"无遗留 setTimeout"时直接看假时钟的 pending 数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const OUT_DIR = process.env.KV_STREAM_TEST_DIR ?? join(process.cwd(), 'tmp-chat-stream-test');
const consumer = require(join(OUT_DIR, 'utils', 'chatStreamConsumer.js'));
const schema = require(join(OUT_DIR, 'utils', 'chatStreamSchema.js'));

/* ---- 可控假时钟：断言遗留定时器 / 手动推进 ---- */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    schedule(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    pending() {
      return timers.size;
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

/* ---- 会话测试替身：记录所有副作用 ---- */
function makeSession(overrides = {}) {
  const calls = { streaming: [], copilot: [], patches: [], tts: 0, drains: 0, watchdogTimeouts: [] };
  const clock = overrides.clock ?? makeClock();
  const session = consumer.createChatStreamSession({
    setStreaming: (v) => calls.streaming.push(v),
    setCopilotStreaming: (v) => calls.copilot.push(v),
    patchAssistant: (p) => calls.patches.push(p),
    schedule: clock.schedule,
    cancel: clock.cancel,
    drainQueue: () => {
      calls.drains += 1;
      if (typeof overrides.onDrain === 'function') overrides.onDrain();
    },
    requestTts: () => {
      calls.tts += 1;
    },
    onWatchdogTimeout: (id) => calls.watchdogTimeouts.push(id),
  });
  return { session, calls, clock };
}

/** 收尾原因映射（与组件里 `finalize(endState === 'normal' ? 'done' : endState)` 同口径） */
function reasonFromState(state) {
  return state === 'normal' ? 'done' : state;
}

/* ========================================================================== */
/* 1. 收尾三态                                                                  */
/* ========================================================================== */

test('收到 done → normal：复位 streaming/copilot，播报一次，出队一次', () => {
  const { session, calls } = makeSession();
  session.markDone();
  session.finalize('done');
  assert.equal(session.resolveState(), 'normal');
  assert.deepEqual(calls.streaming, [false]);
  assert.deepEqual(calls.copilot, [false]);
  assert.equal(calls.patches.length, 1);
  assert.equal(calls.patches[0].isStreaming, false);
  assert.equal(calls.patches[0].incomplete, undefined);
  assert.equal(calls.patches[0].failed, undefined);
  assert.equal(calls.tts, 1);
  assert.equal(calls.drains, 1);
});

test('未收到 done → incomplete：打 incomplete 标记，不冒充正常结束', () => {
  const { session, calls } = makeSession();
  const state = session.resolveState();
  assert.equal(state, 'incomplete');
  session.finalize(reasonFromState(state));
  assert.equal(calls.patches[0].isStreaming, false);
  assert.equal(calls.patches[0].incomplete, true);
  assert.equal(calls.patches[0].failed, undefined);
  assert.equal(calls.tts, 1);
});

test('解析出错 → error：优先于 done，打 failed 标记且不播报', () => {
  const { session, calls } = makeSession();
  session.markDone();
  session.markParseError();
  assert.equal(session.resolveState(), 'error');
  session.finalize('error');
  assert.equal(calls.patches[0].failed, true);
  assert.equal(calls.patches[0].incomplete, undefined);
  assert.equal(calls.tts, 0);
});

test('finalize 幂等：重复调用不重复补丁 / 不重复出队（无重复 assistant 气泡来源）', () => {
  const { session, calls } = makeSession();
  session.markDone();
  session.finalize('done');
  session.finalize('done');
  session.finalize('error');
  assert.equal(session.isFinalized(), true);
  assert.equal(calls.patches.length, 1, '消息级补丁只应执行一次');
  assert.equal(calls.drains, 1, '排队只应出队一次');
  assert.deepEqual(calls.streaming, [false]);
});

/* ========================================================================== */
/* 2. 中止不回落                                                                */
/* ========================================================================== */

test('停止生成（abort）：不打 failed/incomplete、不播报、复位 streaming', () => {
  const { session, calls } = makeSession();
  session.finalize('abort');
  assert.equal(calls.patches[0].isStreaming, false);
  assert.equal(calls.patches[0].failed, undefined);
  assert.equal(calls.patches[0].incomplete, undefined);
  assert.equal(calls.tts, 0);
  assert.deepEqual(calls.streaming, [false]);
  assert.deepEqual(calls.copilot, [false]);
});

test('停止后立即清空：无遗留定时器、无重复出队、队列可清空', () => {
  const clock = makeClock();
  const queue = consumer.createPromptQueue();
  queue.enqueue('排队中的请求');
  const { session, calls } = makeSession({ clock });
  session.registerWatchdog('card-1', 8000);
  assert.equal(clock.pending(), 1);

  session.finalize('abort'); // 停止
  const drainsAfterStop = calls.drains;
  session.clearAllWatchdogs(); // 清空会话
  queue.clear();

  assert.equal(clock.pending(), 0, '停止后不得有遗留 setTimeout');
  assert.equal(queue.length(), 0);
  session.finalize('abort'); // 再次收尾：幂等
  assert.equal(calls.drains, drainsAfterStop, '不得重复发排队消息');
});

/* ========================================================================== */
/* 3. 生命周期收尾：fetch 前失败 / 端侧向量抛错                                   */
/* ========================================================================== */

/**
 * simulateSend —— 复刻组件 sendMessage 的收尾骨架：会话在第一个 await 之前创建，
 * 失败走 catch→finalize('error')，最后 finally 兜底。用于证明"任何 await 前失败都能复位"。
 */
function simulateSend(failAt) {
  const { session, calls, clock } = makeSession();
  session.registerWatchdog('pending-card', 8000); // 模拟此前已挂骨架
  try {
    if (failAt === 'pixel') throw new Error('端侧像素特征计算失败');
    if (failAt === 'embed') throw new Error('端侧向量推理失败');
    if (failAt === 'fetch') throw new Error('fetch 网络异常');
  } catch {
    session.finalize('error');
  } finally {
    session.finalize(reasonFromState(session.resolveState()));
  }
  return { calls, clock };
}

for (const failAt of ['pixel', 'embed', 'fetch']) {
  test(`fetch/端侧在收尾前失败（${failAt}）：输入区恢复可用、copilotStreaming=false、无遗留定时器`, () => {
    const { calls, clock } = simulateSend(failAt);
    assert.equal(calls.streaming.at(-1), false, 'isStreaming 必须复位（输入区恢复可用）');
    assert.equal(calls.copilot.at(-1), false, 'copilotStreaming 必须复位');
    assert.equal(calls.patches[0].isStreaming, false);
    assert.equal(calls.patches[0].failed, true);
    assert.equal(clock.pending(), 0, '不得遗留 setTimeout');
  });
}

/* ========================================================================== */
/* 4. 看门狗（不泄漏 / 撤销 / 收尾清空）                                          */
/* ========================================================================== */

test('重复 tool-start 登记同一 id：先清旧定时器，不泄漏', () => {
  const { session, clock } = makeSession();
  session.registerWatchdog('dup-id', 8000);
  assert.equal(clock.pending(), 1);
  session.registerWatchdog('dup-id', 8000);
  assert.equal(clock.pending(), 1, '旧定时器必须被 clearTimeout，不得累积');
  assert.equal(session.pendingWatchdogs(), 1);
});

test('tool-result 撤销看门狗；finalize 清空全部看门狗', () => {
  const { session, clock } = makeSession();
  session.registerWatchdog('a', 8000);
  session.registerWatchdog('b', 8000);
  assert.equal(clock.pending(), 2);
  session.clearWatchdog('a');
  assert.equal(clock.pending(), 1);
  session.finalize('done');
  assert.equal(clock.pending(), 0);
  assert.equal(session.pendingWatchdogs(), 0);
});

/* ========================================================================== */
/* 5. FIFO 排队                                                                */
/* ========================================================================== */

test('FIFO 队列：连发不丢、严格按序出队', () => {
  const queue = consumer.createPromptQueue();
  queue.enqueue('第一条');
  queue.enqueue('第二条');
  queue.enqueue('第三条');
  assert.equal(queue.length(), 3);
  assert.equal(queue.shift(), '第一条');
  assert.equal(queue.shift(), '第二条');
  assert.equal(queue.shift(), '第三条');
  assert.equal(queue.shift(), undefined);
  assert.equal(queue.length(), 0);
});

/* ========================================================================== */
/* 6. 截断流：UTF-8 跨 chunk 不乱码 + 残行不丢尾 + 缺 done → incomplete            */
/* ========================================================================== */

/** 把 NDJSON 文本按"落在某个中文字符内部"的字节偏移切开，模拟最恶劣的 chunk 边界 */
function splitInsideChinese(text, ch) {
  const charIndex = text.indexOf(ch);
  assert.notEqual(charIndex, -1, `测试前提：文本应含中文字符 ${ch}`);
  const bytes = Buffer.from(text, 'utf8');
  const split = Buffer.byteLength(text.slice(0, charIndex), 'utf8') + 1; // 切进该字符第 2 个字节
  return [new Uint8Array(bytes.subarray(0, split)), new Uint8Array(bytes.subarray(split))];
}

test('截断流：去 done + 末尾无换行 + 中文被切断 → 不丢尾、不乱码、提示 incomplete', () => {
  const events = [
    { type: 'text', content: '正在' },
    { type: 'text', content: '诊断集群' },
  ];
  /* 无 done、无末尾换行（模拟连接被截断在最后一条事件之后） */
  const ndjson = events.map((event) => JSON.stringify(event)).join('\n');

  const got = [];
  let malformed = 0;
  const parser = consumer.createNdjsonLineParser({
    onEvent: (event) => got.push(event),
    onMalformedLine: () => {
      malformed += 1;
    },
    validate: schema.isChatStreamEvent,
  });

  /* 在最恶劣的位置切两刀：中文多字节序列被 chunk 边界劈开 */
  const parts = splitInsideChinese(ndjson, '诊');
  for (const part of parts) parser.push(part);
  parser.flush();

  assert.equal(malformed, 0, '跨 chunk 的中文不应被判为畸形帧');
  assert.equal(got.length, 2, '无换行结尾的残行必须被 flush 消费，不得丢尾');
  assert.equal(got[0].content, '正在');
  assert.equal(got[1].content, '诊断集群', '中文不得乱码');

  /* 缺 done → 收尾态必须为 incomplete（不能冒充 normal） */
  const { session, calls } = makeSession();
  for (const event of got) {
    if (event.type === 'done') {
      session.markDone();
      session.finalize('done');
    }
  }
  assert.equal(session.resolveState(), 'incomplete');
  session.finalize(reasonFromState(session.resolveState()));
  assert.equal(calls.patches[0].incomplete, true);
});

test('完整流（含 done + 末尾换行）：解析 normal 并立即 finalize', () => {
  const ndjson =
    [
      { type: 'text', content: '诊断完成' },
      { type: 'done', requestId: 'req-1', engine: 'simulator' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n';

  const { session, calls } = makeSession();
  let receivedDone = false;
  const parser = consumer.createNdjsonLineParser({
    onEvent: (event) => {
      if (event.type === 'done') {
        session.markDone();
        receivedDone = true;
        session.finalize('done');
      }
    },
    onMalformedLine: () => session.markParseError(),
    validate: schema.isChatStreamEvent,
  });
  parser.push(new Uint8Array(Buffer.from(ndjson, 'utf8')));
  parser.flush();

  assert.equal(receivedDone, true);
  assert.equal(session.resolveState(), 'normal');
  assert.equal(calls.streaming.at(-1), false);
  assert.equal(calls.tts, 1);
});

test('畸形帧降级：非法 JSON / 形状不符都走 onMalformedLine，不崩溃', () => {
  let malformed = 0;
  const got = [];
  const parser = consumer.createNdjsonLineParser({
    onEvent: (event) => got.push(event),
    onMalformedLine: () => {
      malformed += 1;
    },
    validate: schema.isChatStreamEvent,
  });

  const lines = [
    '{"type":"text","content":"ok"}',
    '{not valid json', // 损坏 JSON
    '{"type":"text"}', // 缺 content，形状不符
    '{"type":"unknown-event"}', // 未知 type
    '{"type":"done","requestId":"r","engine":"llm"}',
  ];
  parser.push(new Uint8Array(Buffer.from(lines.join('\n') + '\n', 'utf8')));
  parser.flush();

  assert.equal(got.length, 2, '合法帧照常分派');
  assert.equal(malformed, 3, '三帧畸形/未知都降级而非崩溃');
  assert.equal(got[1].type, 'done');
});

/* ========================================================================== */
/* 7. 消息状态纯变换（抽屉与探针共用）                                           */
/* ========================================================================== */

const EMPTY = { text: '', reasoningSteps: [], toolCards: [] };

test('upsertToolStart 幂等：同 toolCallId 只挂一张骨架卡', () => {
  const once = consumer.upsertToolStart(EMPTY, 'call-1', 'renderPodMetrics', 'mcp://x');
  assert.equal(once.toolCards.length, 1);
  assert.equal(once.toolCards[0].state, 'skeleton');
  const twice = consumer.upsertToolStart(once, 'call-1', 'renderPodMetrics', 'mcp://x');
  assert.equal(twice, once, '重复 start 返回原状态（引用不变，便于跳过渲染）');
  assert.equal(twice.toolCards.length, 1);
});

test('applyToolResult 升级 / 孤儿补齐 / 重复幂等', () => {
  const started = consumer.upsertToolStart(EMPTY, 'call-1', 'renderPodMetrics', 'mcp://x');
  const args = { podId: 'p', podName: 'n', namespace: 'ns', cpuUsage: 1, memoryUsage: 2, restarts: 0, cpuHistory: [1, 2, 3, 4, 5, 6], memHistory: [1, 2, 3, 4, 5, 6] };
  const upgraded = consumer.applyToolResult(started, { type: 'tool-result', toolCallId: 'call-1', toolName: 'renderPodMetrics', args });
  assert.equal(upgraded.toolCards[0].state, 'ready');
  /* 重复 result：已 ready 的卡不再变动 */
  assert.equal(consumer.applyToolResult(upgraded, { type: 'tool-result', toolCallId: 'call-1', toolName: 'renderPodMetrics', args }), upgraded);
  /* 孤儿 result：补一张卡而非丢弃 */
  const orphan = consumer.applyToolResult(EMPTY, { type: 'tool-result', toolCallId: 'ghost', toolName: 'renderRootCauseAnalysis', args: null, status: 'error' });
  assert.equal(orphan.toolCards.length, 1);
  assert.equal(orphan.toolCards[0].state, 'error');
});

test('resetRound 只清正文/思考链，保留工具卡片（反作弊硬约束）', () => {
  const withCard = consumer.applyToolResult(
    consumer.upsertToolStart(consumer.appendText(EMPTY, '已生成正文'), 'call-1', 'renderPodMetrics', 'mcp://x'),
    { type: 'tool-result', toolCallId: 'call-1', toolName: 'renderPodMetrics', args: { podId: 'p' } },
  );
  assert.equal(withCard.toolCards.length, 1);
  const reset = consumer.resetRound(withCard);
  assert.equal(reset.text, '', '正文被复位');
  assert.equal(reset.reasoningSteps.length, 0, '思考链被复位');
  assert.equal(reset.toolCards.length, 1, '工具卡片必须保留（不被 reset 清空）');
  assert.equal(reset.toolCards[0].state, 'ready');
});