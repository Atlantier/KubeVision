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
const ALL_TOOLS = ['renderPodMetrics', 'renderRootCauseAnalysis', 'proposeRemediationAction'];

/* ========================================================================== */
/* 执行                                                                        */
/* ========================================================================== */

let failures = 0;

for (const scenario of SCENARIOS) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(scenario.name);
  console.log('='.repeat(72));

  const { status, events, engine } = await collectEvents(scenario.prompt, scenario.context);
  console.log(`  HTTP ${status} · engine=${engine ?? '(none)'}`);

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