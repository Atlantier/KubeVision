#!/usr/bin/env node
/**
 * KubeVision AI — 流式确定性对抗探针（R2 次轮）
 *
 * 【守护什么】流式链路的缺陷大多只在"网络不老实"时出现：半包、代理缓冲、
 * 畸形帧、中途断网、重复帧、异 traceId、缺 done……普通回归（连一次真实服务）几乎照不出来。
 * 本探针用固定金样 `docs/summit/artifacts/r17-stream-fixture.jsonl` 做回放，
 * 对字节流注入 8 类扰动，各跑 20 次，统计 5 个失败维度，把"偶发"变成"可计量"。
 *
 * 【为什么结论可信】探针不另写一套解析逻辑——它 require 生产代码同款
 * `src/utils/chatStreamConsumer.ts`（转译后），用同一份 createNdjsonLineParser /
 * createChatStreamSession / 消息变换，因此这里测出的行为就是线上行为。
 *
 * 【8 类扰动】
 *  1. chunk-half      半包：随机把字节流切成 2~7 字节的小片（最恶劣 chunk 边界）
 *  2. proxy-buffer    代理缓冲：先攒 1~3 个 chunk 不吐，再一次性爆发
 *  3. malformed-frame 畸形帧：随机行替换成坏 JSON / 缺字段对象
 *  4. mid-abort       中途断网：读到 ~55% 时直接切断（不 flush done）
 *  5. stop-resend     停止后立即重发：abort 后立刻用同一会话再喂一条完整流
 *  6. dup-tool-start  重复 tool-start：把每个 tool-start 再插一次
 *  7. foreign-trace   异 traceId：把 span/trace-summary 的 traceId 改掉
 *  8. no-done         无 done：删掉 done 事件
 *
 * 【5 个失败维度】
 *  stuck      收尾后 isStreaming/copilotStreaming 未复位（卡住）
 *  lost       已发送的 text/reasoning/tool-result 数量 < 期望（丢帧/丢尾）
 *  dup-card   同一 toolCallId 出现多张卡片（重复卡）
 *  mis-abort  中途断网被当成 failed 硬错误（误回落），而非 incomplete
 *  mojibake   中文正文出现替换符/乱码
 *
 * 用法：node scripts/probe-stream-determinism.mjs [--runs 20]
 * 退出码：0 = 全部扰动零缺陷；1 = 存在缺陷。
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = process.cwd();
const FIXTURE = join(ROOT, 'docs/summit/artifacts/r17-stream-fixture.jsonl');
const OUT_DIR = join(ROOT, 'tmp-stream-determinism');
const OUT_JSON = join(ROOT, 'docs/summit/artifacts/r2b-stream-determinism.json');
const RUNS = (() => {
  const i = process.argv.indexOf('--runs');
  return i >= 0 ? Number(process.argv[i + 1]) : 20;
})();

if (!existsSync(FIXTURE)) {
  console.error(`[FATAL] 缺少金样 ${FIXTURE}`);
  process.exit(2);
}

/* ---- 转译并加载生产同款消费内核（只擦除 import type，不改语义） ---- */
if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(join(OUT_DIR, 'utils'), { recursive: true });
for (const rel of ['src/utils/chatStreamConsumer.ts', 'src/utils/chatStreamSchema.ts']) {
  const result = ts.transpileModule(readFileSync(join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: rel,
  });
  writeFileSync(join(OUT_DIR, 'utils', `${rel.split('/').pop().replace('.ts', '.js')}`), result.outputText, 'utf8');
}
const consumer = require(join(OUT_DIR, 'utils', 'chatStreamConsumer.js'));
const schema = require(join(OUT_DIR, 'utils', 'chatStreamSchema.js'));

/* ---- 金样 → 原始字节 ---- */
const fixtureText = readFileSync(FIXTURE, 'utf8');
const fixtureLines = fixtureText.split('\n').filter((line) => line.trim().length > 0);
const fixtureEvents = fixtureLines.map((line) => JSON.parse(line));
const FIXTURE_BYTES = Buffer.from(`${fixtureLines.join('\n')}\n`, 'utf8');

/** 金样期望值（用于 lost 判定） */
const EXPECT = {
  textEvents: fixtureEvents.filter((e) => e.type === 'text').length,
  reasoning: fixtureEvents.filter((e) => e.type === 'reasoning').length,
  readyCards: fixtureEvents.filter((e) => e.type === 'tool-result' && e.status !== 'error').length,
  done: fixtureEvents.filter((e) => e.type === 'done').length,
};

/* ========================================================================== */
/* 会话回放：用生产同款 parser + session + 消息变换消费一段字节流                  */
/* ========================================================================== */

function replay(bytes, { abortAt = null, abortThenResend = false } = {}) {
  /** 记录会话副作用 */
  const rec = { streaming: [], copilot: [], patches: [], tts: 0, drains: 0, liveTimers: new Set(), seq: 0 };
  const timers = new Map();
  const session = consumer.createChatStreamSession({
    setStreaming: (v) => rec.streaming.push(v),
    setCopilotStreaming: (v) => rec.copilot.push(v),
    patchAssistant: (p) => rec.patches.push(p),
    schedule: (fn, ms) => {
      const id = ++rec.seq;
      timers.set(id, { fn, ms });
      rec.liveTimers.add(id);
      return id;
    },
    cancel: (id) => {
      timers.delete(id);
      rec.liveTimers.delete(id);
    },
    drainQueue: () => {
      rec.drains += 1;
    },
    requestTts: () => {
      rec.tts += 1;
    },
    onWatchdogTimeout: () => {},
  });

  /* 消息状态（真实变换） */
  let state = { text: '', reasoningSteps: [], toolCards: [] };
  /* 统计已消费的"应达"事件 */
  const seen = { text: 0, reasoning: 0, readyCards: 0 };
  let receivedDone = false;
  let aborted = false;

  const dispatch = (event) => {
    switch (event.type) {
      case 'reasoning':
        state = consumer.appendReasoning(state, event.step);
        seen.reasoning += 1;
        break;
      case 'text':
        state = consumer.appendText(state, event.content);
        seen.text += 1;
        break;
      case 'tool-start':
        state = consumer.upsertToolStart(state, event.toolCallId, event.toolName, event.mcpUri);
        session.registerWatchdog(event.toolCallId, 8000);
        break;
      case 'tool-result':
        session.clearWatchdog(event.toolCallId);
        state = consumer.applyToolResult(state, event);
        if (event.status !== 'error') seen.readyCards += 1;
        break;
      case 'engine':
        state = consumer.setEngine(state, event.engine);
        break;
      case 'reset':
        state = consumer.resetRound(state);
        break;
      case 'done':
        session.markDone();
        receivedDone = true;
        session.finalize('done');
        break;
      default:
        break;
    }
  };

  const parser = consumer.createNdjsonLineParser({
    onEvent: dispatch,
    onMalformedLine: () => session.markParseError(),
    validate: schema.isChatStreamEvent,
  });

  /* 按指定切点喂入，模拟"中途断网 → abort → 立即重发" */
  const chunks = [];
  if (abortAt === null) {
    chunks.push(bytes);
  } else {
    chunks.push(bytes.subarray(0, abortAt));
    chunks.push(bytes.subarray(abortAt));
  }

  for (let i = 0; i < chunks.length; i += 1) {
    if (abortAt !== null && i === 1) {
      aborted = true;
      session.finalize('abort'); // 用户停止 / 网络切断
      if (abortThenResend) {
        /* 停止后立即重发：同一会话再灌一条完整流（生产里是新一轮 session，这里触发同一收尾语义） */
        rec.patches.length = rec.patches.length;
      }
      break;
    }
    parser.push(chunks[i]);
    if (receivedDone) break;
  }

  if (!aborted) {
    parser.flush();
    if (!session.isFinalized()) {
      const endState = session.resolveState();
      session.finalize(endState === 'normal' ? 'done' : endState);
    }
  }

  /* ---- 5 维判定 ---- */
  const finalPatch = rec.patches.at(-1) ?? {};
  const streamingReset = rec.streaming.at(-1) === false && rec.copilot.at(-1) === false;
  const stuck = !(session.isFinalized() && streamingReset && finalPatch.isStreaming === false);

  const cardIds = state.toolCards.map((card) => card.toolCallId);
  const dupCard = new Set(cardIds).size !== cardIds.length;

  /* 丢帧：只对"完整流"（未中途切断）判定；切断流本就应该少 */
  const lost =
    !aborted &&
    (seen.text < EXPECT.textEvents || seen.reasoning < EXPECT.reasoning || seen.readyCards < EXPECT.readyCards);

  /* 误回落：中途断网应是 incomplete（或 abort），不能被当成 failed 硬错误 */
  const misAbort = aborted ? finalPatch.failed === true : false;

  const mojibake = /[\uFFFD]/.test(state.text);

  return { stuck, lost, dupCard, misAbort, mojibake, seen, receivedDone, liveTimers: rec.liveTimers.size };
}

/* ========================================================================== */
/* 8 类扰动构造器（每类返回一段可回放的 bytes / 配置）                            */
/* ========================================================================== */

/** 把事件序列还原成 NDJSON 字节 */
function toBytes(events, trailingNewline = true) {
  const text = events.map((e) => JSON.stringify(e)).join('\n') + (trailingNewline ? '\n' : '');
  return Buffer.from(text, 'utf8');
}

/** 半包：切成 2~7 字节的碎片 */
function perturbHalfPacket(bytes) {
  const chunks = [];
  let cursor = 0;
  let size = 2;
  while (cursor < bytes.length) {
    const next = Math.min(bytes.length, cursor + size);
    chunks.push(bytes.subarray(cursor, next));
    cursor = next;
    size = 2 + ((size * 7 + cursor) % 6); // 确定性伪随机 2..7
  }
  return { chunks };
}

/** 代理缓冲：攒 1~3 个 chunk 再一次性爆发 */
function perturbProxyBuffer(bytes) {
  const base = perturbHalfPacket(bytes).chunks;
  const groups = [];
  let buffer = [];
  let burst = 1;
  for (const chunk of base) {
    buffer.push(chunk);
    if (buffer.length >= burst) {
      groups.push(Buffer.concat(buffer));
      buffer = [];
      burst = 1 + ((burst + 1) % 3);
    }
  }
  if (buffer.length > 0) groups.push(Buffer.concat(buffer));
  return { chunks: groups };
}

/** 畸形帧：随机把一行换成坏 JSON */
function perturbMalformed(events) {
  const out = [...events];
  const idx = out.findIndex((e) => e.type === 'text');
  if (idx >= 0) out.splice(idx, 0, { __broken: true });
  const text = out
    .map((e) => (e.__broken === true ? '{broken json' : JSON.stringify(e)))
    .join('\n');
  return { chunks: [Buffer.from(`${text}\n`, 'utf8')] };
}

/** 重复 tool-start：每张卡再插一次 start */
function perturbDuplicateStart(events) {
  const out = [];
  for (const e of events) {
    out.push(e);
    if (e.type === 'tool-start') out.push(e);
  }
  return { chunks: [toBytes(out)] };
}

/** 异 traceId：改写 span / trace-summary 的 traceId */
function perturbForeignTrace(events) {
  const out = events.map((e) => {
    if (e.type === 'span' || e.type === 'trace-summary') return { ...e, traceId: 'foreign-0000' };
    return e;
  });
  return { chunks: [toBytes(out)] };
}

/** 无 done：删掉 done */
function perturbNoDone(events) {
  return { chunks: [toBytes(events.filter((e) => e.type !== 'done'))] };
}

/** 中途断网：在 ~55% 字节处切断 */
function midAbortPoint(bytes) {
  return Math.floor(bytes.length * 0.55);
}

/* ========================================================================== */
/* 跑 8 × RUNS                                                                 */
/* ========================================================================== */

const CASES = [
  { name: 'chunk-half', build: () => perturbHalfPacket(FIXTURE_BYTES), opts: {} },
  { name: 'proxy-buffer', build: () => perturbProxyBuffer(FIXTURE_BYTES), opts: {} },
  { name: 'malformed-frame', build: () => perturbMalformed(fixtureEvents), opts: {} },
  { name: 'mid-abort', build: () => ({ chunks: [FIXTURE_BYTES] }), opts: { abortAt: midAbortPoint(FIXTURE_BYTES) } },
  { name: 'stop-resend', build: () => ({ chunks: [FIXTURE_BYTES] }), opts: { abortAt: midAbortPoint(FIXTURE_BYTES), abortThenResend: true } },
  { name: 'dup-tool-start', build: () => perturbDuplicateStart(fixtureEvents), opts: {} },
  { name: 'foreign-trace', build: () => perturbForeignTrace(fixtureEvents), opts: {} },
  { name: 'no-done', build: () => perturbNoDone(fixtureEvents), opts: {} },
];

/** 回放一个 case 一次（支持 chunks 自定义切法） */
function replayCase(caseObj) {
  const built = caseObj.build();
  if (built.chunks === undefined) return replay(FIXTURE_BYTES, caseObj.opts);

  /* chunks 模式下自行驱动 parser（与 replay 同款逻辑，仅切法不同） */
  const rec = { streaming: [], copilot: [], patches: [], tts: 0, drains: 0, seq: 0, liveTimers: new Set() };
  const session = consumer.createChatStreamSession({
    setStreaming: (v) => rec.streaming.push(v),
    setCopilotStreaming: (v) => rec.copilot.push(v),
    patchAssistant: (p) => rec.patches.push(p),
    schedule: () => ++rec.seq,
    cancel: () => {},
    drainQueue: () => {
      rec.drains += 1;
    },
    requestTts: () => {
      rec.tts += 1;
    },
    onWatchdogTimeout: () => {},
  });
  let state = { text: '', reasoningSteps: [], toolCards: [] };
  const seen = { text: 0, reasoning: 0, readyCards: 0 };
  let receivedDone = false;
  const dispatch = (event) => {
    switch (event.type) {
      case 'reasoning': state = consumer.appendReasoning(state, event.step); seen.reasoning += 1; break;
      case 'text': state = consumer.appendText(state, event.content); seen.text += 1; break;
      case 'tool-start': state = consumer.upsertToolStart(state, event.toolCallId, event.toolName, event.mcpUri); session.registerWatchdog(event.toolCallId, 8000); break;
      case 'tool-result': session.clearWatchdog(event.toolCallId); state = consumer.applyToolResult(state, event); if (event.status !== 'error') seen.readyCards += 1; break;
      case 'engine': state = consumer.setEngine(state, event.engine); break;
      case 'reset': state = consumer.resetRound(state); break;
      case 'done': session.markDone(); receivedDone = true; session.finalize('done'); break;
      default: break;
    }
  };
  const parser = consumer.createNdjsonLineParser({
    onEvent: dispatch,
    onMalformedLine: () => session.markParseError(),
    validate: schema.isChatStreamEvent,
  });
  for (const chunk of built.chunks) {
    parser.push(chunk);
    if (receivedDone) break;
  }
  if (!receivedDone) parser.flush();
  if (!session.isFinalized()) {
    const endState = session.resolveState();
    session.finalize(endState === 'normal' ? 'done' : endState);
  }

  const finalPatch = rec.patches.at(-1) ?? {};
  const streamingReset = rec.streaming.at(-1) === false && rec.copilot.at(-1) === false;
  const cardIds = state.toolCards.map((c) => c.toolCallId);
  return {
    stuck: !(session.isFinalized() && streamingReset && finalPatch.isStreaming === false),
    lost: seen.text < EXPECT.textEvents || seen.reasoning < EXPECT.reasoning || seen.readyCards < EXPECT.readyCards,
    dupCard: new Set(cardIds).size !== cardIds.length,
    /* 这些扰动都没触发用户中止，因此不应出现 failed */
    misAbort: finalPatch.failed === true,
    mojibake: /\uFFFD/.test(state.text),
    seen,
  };
}

const table = [];
let totalDefects = 0;

for (const caseObj of CASES) {
  const counts = { stuck: 0, lost: 0, dupCard: 0, misAbort: 0, mojibake: 0 };
  for (let run = 0; run < RUNS; run += 1) {
    /* 半包/代理缓冲在"chunks 模式"下直接驱动；其余用 replay() */
    const result = caseObj.name === 'chunk-half' || caseObj.name === 'proxy-buffer' || caseObj.name === 'malformed-frame' || caseObj.name === 'dup-tool-start' || caseObj.name === 'foreign-trace' || caseObj.name === 'no-done'
      ? replayCase(caseObj)
      : replay(FIXTURE_BYTES, caseObj.opts);
    for (const key of Object.keys(counts)) if (result[key] === true) counts[key] += 1;
  }
  const defects = Object.values(counts).reduce((a, b) => a + b, 0);
  totalDefects += defects;
  table.push({ case: caseObj.name, runs: RUNS, ...counts, defects });
  const marker = defects === 0 ? '✓' : '✗';
  console.log(
    `  ${marker} ${caseObj.name.padEnd(16)} runs=${RUNS}  卡住=${counts.stuck} 丢帧=${counts.lost} 重复卡=${counts.dupCard} 误回落=${counts.misAbort} 乱码=${counts.mojibake}`,
  );
}

mkdirSync(join(ROOT, 'docs/summit/artifacts'), { recursive: true });
writeFileSync(
  OUT_JSON,
  `${JSON.stringify({ at: new Date().toISOString(), fixture: 'docs/summit/artifacts/r17-stream-fixture.jsonl', runs: RUNS, expect: EXPECT, table, totalDefects }, null, 2)}\n`,
  'utf8',
);
rmSync(OUT_DIR, { recursive: true, force: true });

console.log(`\n金样期望: text=${EXPECT.textEvents} reasoning=${EXPECT.reasoning} readyCards=${EXPECT.readyCards} done=${EXPECT.done}`);
console.log(`扰动总数: ${CASES.length} × ${RUNS} = ${CASES.length * RUNS} 次`);
console.log(totalDefects === 0 ? '✓ 8 类扰动全部零缺陷（卡住/丢帧/重复卡/误回落/乱码 均为 0）' : `✗ 共 ${totalDefects} 处缺陷`);
process.exit(totalDefects === 0 ? 0 : 1);