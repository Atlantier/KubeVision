#!/usr/bin/env node
/**
 * KubeVision AI — AI 质量评测（R51 · 20 问，RAG vs 裸模型）
 *
 * 【做什么】对 20 条典型问句各跑两次：
 *   1. RAG：默认 `/api/chat`（检索 + 知识注入）；
 *   2. 裸模型：同一请求加 `disableRag:true`（同一引擎、同一 Prompt 其余部分，不注入知识库）。
 * 统计：关键词正确率、引用命中率（RUNBOOK 引用/正文引用）、动作合理性（动作卡白名单 + 目标真实）、
 * TTFT/总时长、tokens。
 *
 * 【为什么用 disableRag 而不是另起一套模型调用】保证两次对照只有"是否注入 RAG"一个变量，
 * 引擎、模型、Prompt 结构、工具集完全一致。
 *
 * 用法：node scripts/eval-ai-quality.mjs
 * 输出：docs/ai-quality.md / docs/ai-quality.json
 * 预算：20 × 2 = 40 次模型调用（与批准预算一致）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const ROOT = process.cwd();

/** 动作白名单（与 MCP 执行层一致） */
const ACTION_WHITELIST = new Set(['restart_pod', 'scale_deployment', 'drain_node']);

/** 故障上下文（用于需要"动作"的题目） */
const FAULT_CONTEXT = {
  selectedEntityId: null,
  selectedEntityType: null,
  activeChaos: 'POD_OOM_SWARM',
  clusterHealthScore: 46,
  totalQps: 860,
  faultyPods: [
    {
      id: 'pod-worker-beta-6f9c',
      name: 'worker-beta-6f9c',
      namespace: 'default',
      status: 'OOMKilled',
      cpuUsage: 41.2,
      memoryUsage: 97.4,
      restarts: 6,
      nodeId: 'node-worker-beta',
    },
    {
      id: 'pod-worker-beta-7d1e',
      name: 'worker-beta-7d1e',
      namespace: 'default',
      status: 'CrashLoopBackOff',
      cpuUsage: 12.6,
      memoryUsage: 63.1,
      restarts: 11,
      nodeId: 'node-worker-beta',
    },
  ],
  nodes: [
    { id: 'node-worker-alpha', name: 'worker-alpha', status: 'Ready', cpuUsage: 32.4, memUsage: 48.1, rackIndex: 0 },
    { id: 'node-worker-beta', name: 'worker-beta', status: 'HighLoad', cpuUsage: 91.7, memUsage: 88.3, rackIndex: 1 },
    { id: 'node-worker-gamma', name: 'worker-gamma', status: 'Ready', cpuUsage: 27.9, memUsage: 44.6, rackIndex: 2 },
  ],
};

/** 稳态上下文 */
const STEADY_CONTEXT = {
  selectedEntityId: null,
  selectedEntityType: null,
  activeChaos: 'NONE',
  clusterHealthScore: 100,
  totalQps: 1200,
  faultyPods: [],
  nodes: FAULT_CONTEXT.nodes.map((node) => ({ ...node, status: 'Ready', cpuUsage: 31.5, memUsage: 46.2 })),
};

/** 20 条评测问句 */
const QUESTIONS = [
  { id: 'q01', question: 'worker-beta 出现 OOMKilled，根因可能是什么？', context: 'fault', keywords: ['OOM', '内存'], expectsAction: true },
  { id: 'q02', question: 'CrashLoopBackOff 应该怎么排查？', context: 'fault', keywords: ['CrashLoop', '重启', '日志'], expectsAction: false },
  { id: 'q03', question: '节点 CPU 饱和导致调度阻塞，给出处置建议', context: 'fault', keywords: ['CPU', '调度', '节点'], expectsAction: true },
  { id: 'q04', question: 'NetworkPartition 网络分区如何定位？', context: 'fault', keywords: ['网络', '分区', 'CNI'], expectsAction: false },
  { id: 'q05', question: '容器 DNS 解析失败怎么处理？', context: 'fault', keywords: ['DNS', '解析'], expectsAction: true },
  { id: 'q06', question: '镜像拉取失败 ImagePullBackOff 怎么排查？', context: 'fault', keywords: ['镜像', 'ImagePull', '拉取'], expectsAction: false },
  { id: 'q07', question: 'Pod 一直 Pending 可能是什么原因？', context: 'fault', keywords: ['Pending', '调度', '资源'], expectsAction: false },
  { id: 'q08', question: 'etcd 健康度怎么检查？', context: 'steady', keywords: ['etcd', '健康'], expectsAction: false },
  { id: 'q09', question: 'APIServer 出现 429 限流怎么处理？', context: 'steady', keywords: ['429', '限流', 'APF'], expectsAction: false },
  { id: 'q10', question: 'VXLAN 隧道丢包与 MTU 错配如何诊断？', context: 'fault', keywords: ['VXLAN', '丢包', 'MTU'], expectsAction: false },
  { id: 'q11', question: '当前集群整体健康情况怎么样？', context: 'steady', keywords: ['健康', 'QPS', '集群'], expectsAction: false },
  { id: 'q12', question: '稳态下是否需要扩容？', context: 'steady', keywords: ['容量', '扩容', '负载'], expectsAction: false },
  { id: 'q13', question: '针对当前 OOM 故障，建议执行什么自愈动作？', context: 'fault', keywords: ['动作', '重启', '自愈'], expectsAction: true },
  { id: 'q14', question: '你现在能做什么？', context: 'steady', keywords: ['诊断', '排查', '能力'], expectsAction: false },
  { id: 'q15', question: '解释一下 RAG 检索在你的诊断中起什么作用', context: 'steady', keywords: ['检索', '知识', 'RAG'], expectsAction: false },
  { id: 'q16', question: '为什么集群健康分下降了？', context: 'fault', keywords: ['健康分', '下降', '故障'], expectsAction: false },
  { id: 'q17', question: '如何避免 Pod 再次 OOM？', context: 'fault', keywords: ['limit', '内存', 'OOM'], expectsAction: true },
  { id: 'q18', question: '对节点执行 drain 有什么风险？', context: 'steady', keywords: ['drain', '节点', '风险'], expectsAction: false },
  { id: 'q19', question: '怎么验证一次自愈操作是否成功？', context: 'steady', keywords: ['验证', '回执', '健康'], expectsAction: false },
  { id: 'q20', question: '给我演示一次完整的故障排查与自愈流程', context: 'fault', keywords: ['故障', '排查', '自愈'], expectsAction: true },
];

/**
 * runChat —— 跑一次对话并收集事件。
 *
 * @param question 问句
 * @param context 上下文
 * @param disableRag 是否禁用 RAG
 * @returns 事件与文本
 */
async function runChat(question, context, disableRag) {
  const started = Date.now();
  const response = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: question }],
      clusterContext: context,
      ...(disableRag ? { disableRag: true } : {}),
    }),
  });
  if (!response.ok || response.body === null) {
    return { status: response.status, events: [], text: '', elapsedMs: Date.now() - started };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          events.push(JSON.parse(line));
        } catch {
          /* 忽略半行/坏行 */
        }
      }
      newline = buffer.indexOf('\n');
    }
  }
  const text = events.filter((event) => event.type === 'text').map((event) => event.content).join('');
  return { status: response.status, events, text, elapsedMs: Date.now() - started };
}

/**
 * scoreRun —— 对一次运行打分。
 *
 * @param result runChat 结果
 * @param question 题目
 * @returns 分数与证据
 */
function scoreRun(result, question) {
  const engine = result.events.find((event) => event.type === 'engine');
  const summary = result.events.find((event) => event.type === 'trace-summary');
  const toolResults = result.events.filter((event) => event.type === 'tool-result');
  const lower = result.text.toLowerCase();
  const keywordHits = question.keywords.filter((keyword) => lower.includes(keyword.toLowerCase()));
  const citationIds = new Set();
  for (const event of toolResults) {
    const args = event.args;
    if (args !== null && typeof args === 'object' && Array.isArray(args.ragReferences)) {
      for (const ref of args.ragReferences) {
        if (ref !== null && typeof ref === 'object' && typeof ref.id === 'string') citationIds.add(ref.id);
      }
    }
  }
  const textCitations = result.text.match(/RUNBOOK-K8S-\d{3}/g) ?? [];
  for (const id of textCitations) citationIds.add(id);
  const actionCards = toolResults.filter((event) => event.toolName === 'proposeRemediationAction');
  const actionValid = actionCards.some((event) => {
    const args = event.args;
    if (args === null || typeof args !== 'object') return false;
    if (!ACTION_WHITELIST.has(String(args.actionType))) return false;
    const targets = new Set([
      ...question.contextNodeIds,
      ...question.contextPodIds,
    ]);
    return targets.has(String(args.targetId));
  });
  return {
    engine: engine === undefined ? null : engine.engine,
    keywordsHit: keywordHits.length,
    keywordsTotal: question.keywords.length,
    correctness: question.keywords.length === 0 ? 1 : keywordHits.length / question.keywords.length,
    citations: citationIds.size,
    citationHit: citationIds.size > 0,
    actionCards: actionCards.length,
    actionValid: question.expectsAction ? actionValid : null,
    ttftMs: summary === undefined ? null : summary.ttftMs,
    totalMs: summary === undefined ? null : Math.round(summary.totalMs),
    promptTokens: summary === undefined ? null : (summary.promptTokens ?? null),
    completionTokens: summary === undefined ? null : (summary.completionTokens ?? null),
    elapsedMs: result.elapsedMs,
  };
}

/**
 * mean —— 均值。
 *
 * @param values 数值
 * @returns 均值（空数组返回 0）
 */
function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * pct —— 百分比格式。
 *
 * @param value 0~1
 * @returns 字符串
 */
function pct(value) {
  return (value * 100).toFixed(1) + '%';
}

async function main() {
  const rows = [];
  let engineFailures = 0;

  for (const item of QUESTIONS) {
    const context = item.context === 'fault' ? FAULT_CONTEXT : STEADY_CONTEXT;
    const enriched = {
      ...item,
      contextNodeIds: context.nodes.map((node) => node.id),
      contextPodIds: context.faultyPods.map((pod) => pod.id),
    };
    const rag = await runChat(item.question, context, false);
    const bare = await runChat(item.question, context, true);
    const ragScore = scoreRun(rag, enriched);
    const bareScore = scoreRun(bare, enriched);
    if (ragScore.engine !== 'llm' || bareScore.engine !== 'llm') engineFailures += 1;
    rows.push({ id: item.id, question: item.question, expectsAction: item.expectsAction, rag: ragScore, bare: bareScore });
    console.log(
      `${item.id} RAG:${ragScore.engine}/kw=${ragScore.keywordsHit}/${ragScore.keywordsTotal}/cit=${ragScore.citations}/act=${String(ragScore.actionValid)}/${ragScore.totalMs}ms` +
        ` | BARE:${bareScore.engine}/kw=${bareScore.keywordsHit}/${bareScore.keywordsTotal}/cit=${bareScore.citations}/act=${String(bareScore.actionValid)}/${bareScore.totalMs}ms`,
    );
  }

  const validRows = rows.filter((row) => row.rag.engine === 'llm' && row.bare.engine === 'llm');
  const summarize = (side) => {
    const list = validRows.map((row) => row[side]);
    const actionList = validRows.filter((row) => row.expectsAction);
    return {
      count: list.length,
      correctness: mean(list.map((score) => score.correctness)),
      citationRate: mean(list.map((score) => (score.citationHit ? 1 : 0))),
      actionRate: actionList.length === 0 ? null : mean(actionList.map((row) => (row[side].actionValid === true ? 1 : 0))),
      avgDowngraded: mean(list.map((score) => (score.engine === 'llm' ? 0 : 1))),
      avgTotalMs: mean(list.map((score) => score.totalMs ?? 0)),
      avgTtftMs: mean(list.map((score) => score.ttftMs ?? 0)),
      avgPromptTokens: mean(list.map((score) => score.promptTokens ?? 0)),
      avgCompletionTokens: mean(list.map((score) => score.completionTokens ?? 0)),
    };
  };
  const ragSummary = summarize('rag');
  const bareSummary = summarize('bare');
  const payload = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    questions: QUESTIONS.length,
    validRuns: validRows.length,
    engineFailures,
    summary: { rag: ragSummary, bare: bareSummary },
    rows,
  };

  const md = `# AI 质量评测（20 问 · RAG vs 裸模型）

> 由 \'node scripts/eval-ai-quality.mjs\' 调用本地网关生成于 ${new Date().toISOString()}。
> 每条问句跑两次：默认（RAG）与 \'disableRag:true\'（裸模型），共 ${QUESTIONS.length * 2} 次调用。
> 有效配对：**${validRows.length}/${QUESTIONS.length}**；引擎非 llm 的配对数：${engineFailures}。

## 汇总

| 指标 | RAG | 裸模型 | 差值 |
|---|---|---|---|
| 关键词正确率 | ${pct(ragSummary.correctness)} | ${pct(bareSummary.correctness)} | ${((ragSummary.correctness - bareSummary.correctness) * 100).toFixed(1)}pp |
| 引用命中率 | ${pct(ragSummary.citationRate)} | ${pct(bareSummary.citationRate)} | ${((ragSummary.citationRate - bareSummary.citationRate) * 100).toFixed(1)}pp |
| 动作合理性（期望动作题） | ${ragSummary.actionRate === null ? 'n/a' : pct(ragSummary.actionRate)} | ${bareSummary.actionRate === null ? 'n/a' : pct(bareSummary.actionRate)} | — |
| 平均 TTFT | ${ragSummary.avgTtftMs.toFixed(0)}ms | ${bareSummary.avgTtftMs.toFixed(0)}ms | — |
| 平均总时长 | ${ragSummary.avgTotalMs.toFixed(0)}ms | ${bareSummary.avgTotalMs.toFixed(0)}ms | — |
| 平均 tokens（prompt/completion） | ${ragSummary.avgPromptTokens.toFixed(0)} / ${ragSummary.avgCompletionTokens.toFixed(0)} | ${bareSummary.avgPromptTokens.toFixed(0)} / ${bareSummary.avgCompletionTokens.toFixed(0)} | — |

## 逐题

| # | 问句 | RAG 正确率 | RAG 引用 | RAG 动作 | 裸模型正确率 | 裸模型引用 | 裸模型动作 |
|---|---|---|---|---|---|---|---|
${rows
  .map(
    (row) =>
      '| ${row.id} | ${row.question} | ${pct(row.rag.correctness)} | ${row.rag.citations} | ${String(row.rag.actionValid)} | ${pct(row.bare.correctness)} | ${row.bare.citations} | ${String(row.bare.actionValid)} |',
  )
  .join('\n')}

## 口径与限制

1. **正确率是关键词命中率**，不是人工评分：它只能证明"回答覆盖了必要术语"，不能证明推理正确；
2. **引用命中**统计"动作卡/根因卡的 ragReferences 非空或正文出现 RUNBOOK id"；
3. **动作合理性**只校验动作卡的动作类型在白名单内且 target 指向上下文真实实体，
   不评价动作是否最优；
4. 裸模型只是 'disableRag=true'（不注入知识库），其余 Prompt/工具/引擎完全一致；
5. 20 条问句覆盖 OOM/CrashLoop/CPU/网络/DNS/镜像/Pending/etcd/APIServer/VXLAN/巡检/容量/
   能力/流程等典型场景，非随机采样。
`;

  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(join(ROOT, 'docs/ai-quality.md'), md, 'utf8');
  writeFileSync(join(ROOT, 'docs/ai-quality.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log('\n[汇总] RAG', JSON.stringify(ragSummary));
  console.log('[汇总] 裸模型', JSON.stringify(bareSummary));
  console.log('[报告] docs/ai-quality.md / docs/ai-quality.json');
  process.exit(engineFailures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});