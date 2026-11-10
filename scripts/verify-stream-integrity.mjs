#!/usr/bin/env node
/**
 * KubeVision AI — NDJSON 事件流完整性回归测试
 *
 * 【守护的不变量】
 *   每一个 `tool-start` 事件都必须有同 `toolCallId` 的 `tool-result` 事件。
 *
 * 【为何这个不变量如此重要】前端的工具卡是两段式水合的：
 *   - 收到 tool-start → 挂载骨架屏（state: 'skeleton'）
 *   - 收到 tool-result → 原地升级为真实卡片（state: 'ready'）
 * 一旦某个 tool-start 没有配对的 tool-result，那张卡会**永久停在骨架屏**，
 * 且因为服务端补全逻辑把该工具记为"已产出"，连兜底补齐也不会发生。
 * 用户看到的是一个永远转圈、无法交互的卡片。
 *
 * 这个 P0 曾经真实发生过：旧实现先发 tool-start 再校验参数，校验失败就
 * `continue` 跳过 tool-result。修复方式是把顺序反过来——先算出载荷，
 * 确认非空后才发 start。本脚本就是防止该顺序被后人改回去。
 *
 * 【验证的是充要条件而非表象】"卡片卡住"是表象；"start 无配对 result"
 * 是骨架屏悬空的充要条件。检查后者更接近根因，也不需要渲染 UI。
 *
 * 用法：
 *   node scripts/verify-stream-integrity.mjs          # 需先 pnpm dev
 * 退出码：
 *   0 = 全部场景通过；1 = 存在孤儿 tool-start 或缺卡
 */
const BASE = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';

/* ========================================================================== */
/* 协议模块（TS 单文件转译，供金样 / mock 断言共用）                             */
/* ========================================================================== */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const PROTOCOL_OUT = join(ROOT, 'tmp-stream-protocol');

if (existsSync(PROTOCOL_OUT)) rmSync(PROTOCOL_OUT, { recursive: true, force: true });
mkdirSync(PROTOCOL_OUT, { recursive: true });
{
  const source = readFileSync(join(ROOT, 'src/utils/chatStreamProtocol.ts'), 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: 'chatStreamProtocol.ts',
  });
  writeFileSync(join(PROTOCOL_OUT, 'chatStreamProtocol.cjs'), result.outputText, 'utf8');
}
const protocol = require(join(PROTOCOL_OUT, 'chatStreamProtocol.cjs'));

/** 是否录制金样（--record 写入 tests/fixtures/engine-b-stream.jsonl） */
const RECORD = process.argv.includes('--record');
/** 复现模式：只验证"旧行为确实会破坏不变量"（红），用于缺陷复现证据 */
const REPRO = process.argv.includes('--repro');

/** 探针：先确认服务在线，避免把"连不上"误报成"流有问题" */
try {
  const probe = await fetch(BASE, { method: 'HEAD' });
  if (!probe.ok && probe.status !== 405) {
    console.error(`服务返回 ${probe.status}，请先启动 pnpm dev`);
    process.exit(1);
  }
} catch {
  console.error(`无法连接 ${BASE}，请先启动 pnpm dev`);
  process.exit(1);
}

/* ========================================================================== */
/* 测试场景                                                                    */
/* ========================================================================== */

/** 稳态上下文：无异常 Pod、无混沌（原始 P0 最易触发的场景） */
const STEADY_CONTEXT = {
  selectedEntityId: null,
  selectedEntityType: 'master',
  activeChaos: 'NONE',
  clusterHealthScore: 96,
  totalQps: 2400,
  faultyPods: [],
  nodes: [
    { id: 'node-worker-alpha', name: 'worker-alpha', status: 'Ready', cpuUsage: 38, memUsage: 46, rackIndex: 0 },
    { id: 'node-worker-beta', name: 'worker-beta', status: 'Ready', cpuUsage: 42, memUsage: 51, rackIndex: 1 },
    { id: 'node-worker-gamma', name: 'worker-gamma', status: 'Ready', cpuUsage: 40, memUsage: 49, rackIndex: 2 },
  ],
};

/** 故障上下文：存在 OOM 崩溃的 Pod */
const FAULT_CONTEXT = {
  ...STEADY_CONTEXT,
  activeChaos: 'POD_OOM_SWARM',
  clusterHealthScore: 58,
  faultyPods: [
    {
      id: 'pod-payment-gateway-7f8b9-x2k',
      name: 'payment-gateway-7f8b9-x2k',
      namespace: 'kv-prod',
      status: 'OOMKilled',
      cpuUsage: 66,
      memoryUsage: 97,
      restarts: 9,
      nodeId: 'node-worker-beta',
      cpuHistory: [58, 62, 65, 66, 66, 66],
      memHistory: [80, 86, 91, 95, 96, 97],
    },
  ],
};

/** 空上下文：faultyPods 与 nodes 均为空，最极端的兜底路径 */
const EMPTY_CONTEXT = {
  selectedEntityId: null,
  selectedEntityType: 'master',
  activeChaos: 'NONE',
  clusterHealthScore: 100,
  totalQps: 0,
  faultyPods: [],
  nodes: [],
};

const SCENARIOS = [
  {
    name: '故障诊断（OOM 混沌 + 明确要求处置）',
    prompt: '集群里有 Pod 在 OOM 崩溃，请诊断并给出处置动作',
    context: FAULT_CONTEXT,
    expectAllCards: true,
  },
  {
    name: '稳态巡检（无异常 Pod，白名单仅指标卡）',
    prompt: '集群当前状态如何？请做一次健康巡检',
    context: STEADY_CONTEXT,
    expectAllCards: false,
  },
  {
    name: '空上下文（无任何实体，走兜底目标链）',
    prompt: '请给出一个处置动作来恢复集群服务',
    context: EMPTY_CONTEXT,
    expectAllCards: false,
  },
];

/* ========================================================================== */
/* 工具函数                                                                    */
/* ========================================================================== */

/** 解析 NDJSON 流为事件数组（与前端消费逻辑一致：按 \n 切行） */
async function collectEvents(prompt, context) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      clusterContext: context,
    }),
  });

  if (res.status !== 200) {
    return { status: res.status, events: [], engine: null };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          events.push(JSON.parse(line));
        } catch {
          /* 非 JSON 行（空行 / 心跳）忽略 */
        }
      }
      idx = buffer.indexOf('\n');
    }
  }
  if (buffer.trim().length > 0) {
    try {
      events.push(JSON.parse(buffer.trim()));
    } catch {
      /* 尾部残行忽略 */
    }
  }

  return { status: res.status, events, engine: res.headers.get('x-kubevision-engine') };
}

/** 判断是否为占位串（动作卡绝不允许下发这类目标） */
function isPlaceholder(value) {
  return /^(n\/a|na|null|undefined|unknown|-|)$/i.test(String(value ?? '').trim());
}

const VALID_ACTIONS = ['restart_pod', 'scale_deployment', 'drain_node'];
/* ========================================================================== */
/* 执行                                                                        */
/* ========================================================================== */

const ALL_TOOLS = ['renderPodMetrics', 'renderRootCauseAnalysis', 'proposeRemediationAction'];

let failures = 0;

for (const scenario of SCENARIOS) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(scenario.name);
  console.log('='.repeat(72));

  const { status, events, engine } = await collectEvents(scenario.prompt, scenario.context);
  console.log(`  HTTP ${status} · engine=${engine ?? '(none)'}`);

  /* ---- 金样录制：只在故障场景、且显式 --record 时写入 ---- */
  if (RECORD && scenario.expectAllCards && status === 200) {
    const fixtureDir = join(ROOT, 'tests/fixtures');
    mkdirSync(fixtureDir, { recursive: true });
    const lines = events.map((event) => JSON.stringify(event)).join(String.fromCharCode(10));
    writeFileSync(join(fixtureDir, 'engine-b-stream.jsonl'), lines + String.fromCharCode(10), 'utf8');
    console.log('  → 已录制金样 tests/fixtures/engine-b-stream.jsonl');
  }

  if (status !== 200) {
    console.log('  ✗ 请求失败');
    failures += 1;
    continue;
  }

  const starts = events.filter((e) => e.type === 'tool-start');
  const results = events.filter((e) => e.type === 'tool-result');
  const resultIds = new Set(results.map((e) => e.toolCallId));
  const orphanStarts = starts.filter((e) => !resultIds.has(e.toolCallId));

  console.log(`  tool-start=${starts.length}  tool-result=${results.length}  孤儿=${orphanStarts.length}`);

  /* ---- 断言 0（新增）：全局协议校验 ---- */
  const violations = protocol.validateStreamEvents(events);
  if (violations.length === 0) {
    console.log('  ✓ 协议全局校验通过（无重复 id / 无孤儿 result / 无未配对 start / 流末有终止）');
  } else {
    failures += 1;
    console.log(`  ✗ 协议校验发现 ${violations.length} 处违例`);
    for (const v of violations.slice(0, 5)) console.log(`      [${v.kind}] ${v.detail}`);
  }

  /* ---- 断言 0b（R35）：trace-summary 必达且 engine 与实际一致 ---- */
  const traceSummaries = events.filter((e) => e.type === 'trace-summary');
  const spans = events.filter((e) => e.type === 'span');
  if (traceSummaries.length >= 1 && traceSummaries.some((e) => e.engine === engine)) {
    const sample = traceSummaries[traceSummaries.length - 1];
    console.log(`  ✓ trace-summary 必达且 engine 一致（engine=${sample.engine} ttft=${sample.ttftMs}ms total=${sample.totalMs}ms spans=${spans.length}）`);
    console.log(`    [trace-summary 样例] ${JSON.stringify(sample)}`);
    for (const span of spans.slice(0, 4)) console.log(`    [span 样例] ${JSON.stringify(span)}`);
  } else {
    failures += 1;
    console.log(`  ✗ trace-summary 缺失或 engine 不一致（实际 engine=${engine ?? '(none)'} summaries=${traceSummaries.length}）`);
  }

  /* ---- 断言 1（核心）：无孤儿 tool-start ---- */
  if (orphanStarts.length === 0) {
    console.log('  ✓ 无孤儿 tool-start（每个 start 都有配对 result）');
  } else {
    failures += 1;
    console.log(`  ✗ 发现 ${orphanStarts.length} 个孤儿 tool-start（会导致骨架屏永久悬空）`);
    for (const o of orphanStarts) console.log(`      toolName=${o.toolName} toolCallId=${o.toolCallId}`);
  }

  /* ---- 断言 2：result 不得指向未声明的 start ---- */
  const startIds = new Set(starts.map((e) => e.toolCallId));
  const orphanResults = results.filter((e) => !startIds.has(e.toolCallId));
  if (orphanResults.length === 0) {
    console.log('  ✓ 无孤儿 tool-result');
  } else {
    failures += 1;
    console.log(`  ✗ 发现 ${orphanResults.length} 个无 start 的 tool-result`);
  }

  /* ---- 断言 3：故障场景必须三卡齐全 ---- */
  const emitted = new Set(results.map((e) => e.toolName));
  if (scenario.expectAllCards) {
    const missing = ALL_TOOLS.filter((t) => !emitted.has(t));
    if (missing.length === 0) {
      console.log('  ✓ 三张卡齐全');
    } else {
      failures += 1;
      console.log(`  ✗ 缺少卡片: ${missing.join(', ')}`);
    }
  } else {
    /* 非故障场景只要求产出的卡都在白名单内 */
    const unknown = [...emitted].filter((t) => !ALL_TOOLS.includes(t));
    if (unknown.length === 0) {
      console.log(`  ✓ 产出的卡均在白名单内（${[...emitted].join(', ') || '无'}）`);
    } else {
      failures += 1;
      console.log(`  ✗ 出现未知工具卡: ${unknown.join(', ')}`);
    }
  }

  /* ---- 断言 4：动作卡载荷合法性 ---- */
  const action = results.find((e) => e.toolName === 'proposeRemediationAction');
  if (action !== undefined) {
    const a = action.args ?? {};
    const problems = [];
    if (!VALID_ACTIONS.includes(a.actionType)) problems.push(`actionType 非法: ${a.actionType}`);
    if (isPlaceholder(a.targetId)) problems.push(`targetId 为空或占位: ${a.targetId}`);
    if (isPlaceholder(a.targetName)) problems.push(`targetName 为空或占位: ${a.targetName}`);
    if (typeof a.isHighRisk !== 'boolean') problems.push('isHighRisk 非布尔');
    if (a.mcpEndpoint !== `mcp://k8s-cluster/tools/${a.actionType}`) problems.push('mcpEndpoint 与动作不匹配');
    if (typeof a.paramDescription !== 'string' || a.paramDescription.length === 0) {
      problems.push('paramDescription 为空');
    }
    if (a.actionType === 'drain_node' && a.isHighRisk !== true) problems.push('drain_node 未标记高危');

    console.log(`  动作卡: ${a.actionType} → ${a.targetName}(${a.targetId}) highRisk=${a.isHighRisk}`);
    if (problems.length === 0) {
      console.log('  ✓ 动作卡载荷合法');
    } else {
      failures += 1;
      for (const p of problems) console.log(`  ✗ ${p}`);
    }
  }
}


/* ========================================================================== */
/* A8-1 · 引擎 B 事件契约金样（只读 fixture）                                    */
/* ========================================================================== */

const FIXTURE_PATH = join(ROOT, 'tests/fixtures/engine-b-stream.jsonl');
/* 金样契约：三卡必须有 start/result 各 3；reasoning 至少 3 步（意图/RAG/MCP） */
const FIXTURE_EXPECT = { minReasoning: 3, starts: 3, results: 3 };

if (!REPRO) {
  console.log(`\n${'='.repeat(72)}`);
  console.log('A8-1 引擎 B 事件契约金样（只读 fixture，禁止手改）');
  console.log('='.repeat(72));

  if (!existsSync(FIXTURE_PATH)) {
    failures += 1;
    console.log('  ✗ 缺少 tests/fixtures/engine-b-stream.jsonl（先运行 --record 录制）');
  } else {
    const fixtureEvents = readFileSync(FIXTURE_PATH, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const counts = {
      reasoning: fixtureEvents.filter((e) => e.type === 'reasoning').length,
      starts: fixtureEvents.filter((e) => e.type === 'tool-start').length,
      results: fixtureEvents.filter((e) => e.type === 'tool-result').length,
      done: fixtureEvents.filter((e) => e.type === 'done').length,
      engine: fixtureEvents.filter((e) => e.type === 'engine').length,
      text: fixtureEvents.filter((e) => e.type === 'text').length,
    };
    console.log(`  事件构成: reasoning=${counts.reasoning} start=${counts.starts} result=${counts.results} text=${counts.text} engine=${counts.engine} done=${counts.done}`);

    const violations = protocol.validateStreamEvents(fixtureEvents);
    if (violations.length === 0) {
      console.log('  ✓ 顺序合法 / 无孤儿 result / 无重复 toolCallId / 流末有终止事件');
    } else {
      failures += 1;
      console.log(`  ✗ 金样协议校验失败 ${violations.length} 处`);
      for (const v of violations.slice(0, 5)) console.log(`      [${v.kind}] ${v.detail}`);
    }

    if (counts.starts === FIXTURE_EXPECT.starts && counts.results === FIXTURE_EXPECT.results) {
      console.log(`  ✓ 三卡齐全（start=${counts.starts} result=${counts.results}）`);
    } else {
      failures += 1;
      console.log(`  ✗ 卡数不符：期望 ${FIXTURE_EXPECT.starts}/${FIXTURE_EXPECT.results}，实际 ${counts.starts}/${counts.results}`);
    }

    if (counts.reasoning >= FIXTURE_EXPECT.minReasoning) {
      console.log(`  ✓ reasoning 步骤数达标（${counts.reasoning} >= ${FIXTURE_EXPECT.minReasoning}）`);
    } else {
      failures += 1;
      console.log(`  ✗ reasoning 步骤过少：${counts.reasoning} < ${FIXTURE_EXPECT.minReasoning}`);
    }

    if (counts.done === 1) {
      console.log('  ✓ 流末必达 done（终止事件唯一）');
    } else {
      failures += 1;
      console.log(`  ✗ done 事件数量异常：${counts.done}`);
    }
  }
}

/* ========================================================================== */
/* A8-2 · 引擎 A mock：中途失败 → 回落只补缺失卡                                 */
/* ========================================================================== */

console.log(`\n${'='.repeat(72)}`);
console.log(REPRO ? 'A1/A2 缺陷复现（旧行为，预期失败）' : 'A8-2 引擎 A mock：中途失败回落（修复后行为）');
console.log('='.repeat(72));

/** 构造一条事件并记录 */
const emitInto = (bucket, event) => {
  bucket.push(event);
};


if (REPRO) {
  /*
   * 【复现旧行为】引擎 A 已发指标卡 → 根因卡 tool-start 后失败 →
   * 回落引擎 B 无条件重发三张卡。断言：确实出现重复卡片与孤儿 start。
   * 该分支用于证明"缺陷真实存在"，修复后正常模式必须全绿。
   */
  const legacy = [];
  emitInto(legacy, { type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: 't', detail: 'd', latencyMs: 1 } });
  emitInto(legacy, { type: 'tool-start', toolCallId: 'a-metrics', toolName: 'renderPodMetrics', mcpUri: 'mcp://x' });
  emitInto(legacy, { type: 'tool-result', toolCallId: 'a-metrics', toolName: 'renderPodMetrics', args: { podId: 'p' } });
  emitInto(legacy, { type: 'tool-start', toolCallId: 'a-rca', toolName: 'renderRootCauseAnalysis', mcpUri: 'mcp://x' });
  /* 引擎 A 在此失败，tool-start a-rca 悬空 */
  /* 旧引擎 B 无条件重发三张 */
  for (const toolName of ALL_TOOLS) {
    emitInto(legacy, { type: 'tool-start', toolCallId: `sim-${toolName}`, toolName, mcpUri: 'mcp://x' });
    emitInto(legacy, { type: 'tool-result', toolCallId: `sim-${toolName}`, toolName, args: { ok: true } });
  }

  const legacyViolations = protocol.validateStreamEvents(legacy);
  const duplicateNames = protocol.countDuplicateCardNames(legacy);
  const hasUnpaired = legacyViolations.some((v) => v.kind === 'unpaired-tool-start');
  const hasDuplicateCards = duplicateNames.length > 0;

  console.log(`  旧行为事件流: ${legacy.length} 条`);
  console.log(`  未配对 tool-start: ${hasUnpaired ? '存在（应为存在=缺陷复现）' : '无'}`);
  console.log(`  重复卡片: ${hasDuplicateCards ? duplicateNames.join(', ') : '无'}`);

  if (hasUnpaired && hasDuplicateCards) {
    console.log('  ✓ 缺陷已复现（红）：孤儿 start + 重复卡片，正是 A1/A2 的现象');
    process.exit(0);
  }
  console.log('  ✗ 未能复现缺陷（TestCase 失效，请检查构造）');
  process.exit(1);
}

{
  const events = [];
  const ledger = protocol.createToolCallLedger();
  const emit = (event) => emitInto(events, event);

  /* 引擎 A：成功产出指标卡 */
  emit({ type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: 't', detail: 'd', latencyMs: 1 } });
  emit({ type: 'engine', engine: 'llm', reason: 'model=mock' });
  emit({ type: 'tool-start', toolCallId: 'a-metrics', toolName: 'renderPodMetrics', mcpUri: 'mcp://x' });
  protocol.recordToolStart(ledger, 'a-metrics', 'renderPodMetrics');
  emit({ type: 'tool-result', toolCallId: 'a-metrics', toolName: 'renderPodMetrics', args: { podId: 'p' } });
  protocol.recordToolResult(ledger, 'a-metrics', true);

  /* 引擎 A：根因卡 tool-start 后失败（悬空） */
  emit({ type: 'tool-start', toolCallId: 'a-rca', toolName: 'renderRootCauseAnalysis', mcpUri: 'mcp://x' });
  protocol.recordToolStart(ledger, 'a-rca', 'renderRootCauseAnalysis');

  /* 回落：先修孤儿（A2），再让引擎 B 只补缺失（A1） */
  const repaired = protocol.repairPendingToolCalls(ledger, emit, 'engine A failed');
  emit({ type: 'engine', engine: 'simulator', reason: 'fallback' });
  const missing = protocol.missingToolNames(ledger, ALL_TOOLS);
  for (const toolName of missing) {
    const toolCallId = `sim-${toolName}`;
    emit({ type: 'tool-start', toolCallId, toolName, mcpUri: 'mcp://x' });
    protocol.recordToolStart(ledger, toolCallId, toolName);
    emit({ type: 'tool-result', toolCallId, toolName, args: { ok: true } });
    protocol.recordToolResult(ledger, toolCallId, true);
  }
  emit({ type: 'done', requestId: 'req-mock', engine: 'simulator' });

  const violations = protocol.validateStreamEvents(events);
  const duplicateNames = protocol.countDuplicateCardNames(events);
  const okCards = events.filter((e) => e.type === 'tool-result' && e.status !== 'error');

  console.log(`  修复后事件流: ${events.length} 条 · 孤儿修复 ${repaired} 条 · 引擎 B 补卡 ${missing.length} 张`);
  console.log(`  成功卡片: ${okCards.map((e) => e.toolName).join(', ')}`);
  console.log(`  重复卡片: ${duplicateNames.length === 0 ? '无' : duplicateNames.join(', ')}`);

  if (violations.length === 0) {
    console.log('  ✓ 协议校验全绿（无重复 id / 无孤儿 result / 无未配对 start / 流末有 done）');
  } else {
    failures += 1;
    console.log(`  ✗ 协议校验失败 ${violations.length} 处`);
    for (const v of violations.slice(0, 5)) console.log(`      [${v.kind}] ${v.detail}`);
  }

  if (duplicateNames.length === 0) {
    console.log('  ✓ 无重复卡片（回落只补缺失，A1 修复生效）');
  } else {
    failures += 1;
    console.log(`  ✗ 出现重复卡片：${duplicateNames.join(', ')}`);
  }

  const unpaired = violations.filter((v) => v.kind === 'unpaired-tool-start');
  if (unpaired.length === 0) {
    console.log('  ✓ 无未配对 tool-start（A2 修复生效）');
  } else {
    failures += 1;
    console.log(`  ✗ 仍有 ${unpaired.length} 个未配对 tool-start`);
  }
}

/* 清理转译产物 */
rmSync(PROTOCOL_OUT, { recursive: true, force: true });

/* ========================================================================== */
/* 汇总                                                                        */
/* ========================================================================== */

console.log(`\n${'='.repeat(72)}`);
if (failures === 0) {
  console.log('事件流完整性: 全部通过（无骨架屏悬空风险）');
  console.log('='.repeat(72));
  process.exit(0);
}
console.log(`事件流完整性: ${failures} 项失败`);
console.log('='.repeat(72));
process.exit(1);