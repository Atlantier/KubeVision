#!/usr/bin/env node
/**
 * KubeVision AI — 路演事实层断言（scripts/verify-demo-facts.mjs）
 *
 * 【它验证什么，不验证什么】
 * 只验证**事实是否自洽**，不验证视觉与文案措辞（那是 R15 的事）：
 *   1. 阶段 2 的 `selectedEntityId` 指向的节点名下，确实存在异常 Pod；
 *   2. 阶段 4 的 `healedPodIds` 覆盖了 `resolveVictims` 解析出的全部受害者；
 *   3. MCP 回执里的 actionType 与 `CHAOS_TARGETS` 的映射值一致。
 *
 * 【为什么必须跑在 dev 构建】状态断言依赖 `window.__KUBEVISION_STORE__`，
 * 该类调试钩子按项目契约在生产构建被 DCE 移除。生产构建下脚本明确报错退出，
 * 不会静默产出"看起来通过"的假证据。
 *
 * 【用法】
 *   node scripts/verify-demo-facts.mjs
 *   node scripts/verify-demo-facts.mjs --script network-latency-trace
 *   node scripts/verify-demo-facts.mjs --base http://127.0.0.1:3000
 *
 * 【退出码】0 = 全部通过；1 = 有失败项；2 = 环境不可用
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const baseUrl = readArg('--base') ?? 'http://127.0.0.1:3000';
const scriptId = readArg('--script') ?? 'oom-autofix';
const CDP_PORT = 9340;

/** 剧本 → 期望的混沌场景 */
const SCRIPT_SCENARIO = {
  'oom-autofix': 'POD_OOM_SWARM',
  'network-latency-trace': 'NET_PACKET_LOSS',
};

/** 剧本菜单里的可读前缀 */
const SCRIPT_LABEL = {
  'oom-autofix': 'OOM 全链路自愈',
  'network-latency-trace': 'CNI 网络延迟追踪',
};

function readArg(flag) {
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/* CDP                                                                         */
/* ========================================================================== */

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push(
        String((msg.params.args ?? [])[0]?.value ?? '').slice(0, 200),
      );
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`CDP 超时: ${method}`)), 30000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close(), consoleErrors };
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const details = res.result?.exceptionDetails;
  if (details !== undefined) {
    return { __err: String(details.exception?.description ?? details.text ?? 'unknown') };
  }
  return res.result?.result?.value;
}

/* ========================================================================== */
/* 断言                                                                        */
/* ========================================================================== */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail = '') {
  pass += 1;
  console.log(`  \u2713 ${name}${detail ? `  ::  ${detail}` : ''}`);
}

function bad(name, actual, hint = '') {
  fail += 1;
  console.log(`  \u2717 ${name}  ::  ${hint}`);
  console.log(`     实际值: ${JSON.stringify(actual)}`);
  failures.push({ name, actual, hint });
}

function section(t) {
  console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
}

/** 读取完整状态（含 CHAOS_TARGETS 派生信息） */
const READ_STATE = `(() => {
  const store = window.__KUBEVISION_STORE__;
  if (!store) return { __noStore: true };
  const s = store.getState();
  const snap = s.snapshotSummary;
  const bar = document.querySelector('[aria-label^="剧本路演进行中"]');
  const logs = s.terminalLogs ?? [];

  const mcpLine = logs.filter((l) => typeof l === 'string' && /MCP 回执/.test(l)).slice(-1)[0];
  let mcpAction = null;
  if (mcpLine !== undefined) {
    const hit = mcpLine.match(/·\\s*([a-z_]+)\\s*已完成/);
    mcpAction = hit === null ? null : hit[1];
  }

  return {
    phase: bar === null ? null : bar.getAttribute('aria-label'),
    chaos: s.activeChaos,
    selected: s.selectedEntityId,
    selectedType: s.selectedEntityType,
    orbit: s.isOrbitPatrolActive,
    health: snap.clusterHealthScore,
    healedIds: Object.keys(s.healedPodIds ?? {}),
    pods: snap.pods.map((p) => ({ id: p.id, name: p.name, nodeId: p.nodeId, status: p.status })),
    nodes: snap.nodes.map((n) => ({ id: n.id, name: n.name, rackIndex: n.rackIndex })),
    mcpAction,
    lastDirectorLog: logs.filter((l) => typeof l === 'string' && l.includes('DEMO-DIRECTOR')).slice(-1)[0] ?? null,
  };
})()`;

/** 读取 CHAOS_TARGETS（通过页面内已加载的模块不可行，改由脚本内硬编码期望值） */
const TARGET_LABEL = {
  POD_OOM_SWARM: 'OOM 内存溢出',
  NODE_CPU_SPIKE: '节点 CPU 尖刺',
  NET_PACKET_LOSS: 'CNI 网络丢包',
};

const EXPECTED_ACTION = {
  POD_OOM_SWARM: 'restart_pod',
  NODE_CPU_SPIKE: 'scale_deployment',
  NET_PACKET_LOSS: 'drain_node',
};

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

async function main() {
  const scenario = SCRIPT_SCENARIO[scriptId];
  if (scenario === undefined) {
    console.error(`[FATAL] 未知剧本 '${scriptId}'，可选: ${Object.keys(SCRIPT_SCENARIO).join(', ')}`);
    process.exit(2);
  }

  console.log('KubeVision AI — 路演事实层断言（verify-demo-facts）');
  console.log(`  目标   : ${baseUrl}`);
  console.log(`  剧本   : ${scriptId} → ${scenario}（${TARGET_LABEL[scenario]}）`);
  console.log(`  期望动作: ${EXPECTED_ACTION[scenario]}`);
  console.log(`  commit : ${readCommit()}`);

  /* ---- 前置 ---- */
  let serverReady = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        serverReady = true;
        break;
      }
    } catch {
      /* 等 */
    }
    await sleep(1000);
  }
  if (!serverReady) {
    console.error(`[FATAL] ${baseUrl} 不可达，请先 pnpm dev`);
    process.exit(2);
  }

  /* ---- 浏览器 ---- */
  const EDGE_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edgePath = EDGE_PATHS.find((p) => existsSync(p));
  if (edgePath === undefined) {
    console.error('[FATAL] 未找到 Edge');
    process.exit(2);
  }

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-facts-${Date.now()}`);
  const browser = spawn(
    edgePath,
    [
      '--headless=new',
      '--no-first-run',
      '--window-size=1680,1000',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { detached: false, stdio: 'ignore' },
  );
  const cleanup = () => {
    try {
      browser.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      const list = await res.json();
      target = list.find((t) => t.type === 'page') ?? null;
      if (target !== null) break;
    } catch {
      /* 等 */
    }
    await sleep(500);
  }
  if (target === null) {
    console.error('[FATAL] CDP 未就绪');
    cleanup();
    process.exit(2);
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: baseUrl });

  for (let i = 0; i < 300; i += 1) {
    if ((await evaluate(cdp, 'document.querySelector("canvas") !== null')) === true) break;
    await sleep(400);
  }
  await sleep(10000);

  const hasStore = await evaluate(cdp, 'typeof window.__KUBEVISION_STORE__ !== "undefined"');
  if (hasStore !== true) {
    console.error(
      '[FATAL] 未检测到 window.__KUBEVISION_STORE__。' +
        '\n        调试钩子按设计仅在 dev 构建存在，请用 `pnpm dev` 启动后重跑。',
    );
    cleanup();
    process.exit(2);
  }

  /* ---- 启动剧本 ---- */
  section('启动剧本');
  const started = await evaluate(
    cdp,
    `(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
      if (!btn) return { error: 'start button missing' };
      btn.click();
      await new Promise((r) => setTimeout(r, 800));
      const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
        .find((b) => (b.textContent || '').includes(${JSON.stringify(SCRIPT_LABEL[scriptId])}));
      if (!item) return { error: 'menu item missing' };
      item.click();
      return { ok: true };
    })()`,
  );
  if (started?.ok !== true) {
    console.error(`[FATAL] 无法启动剧本: ${JSON.stringify(started)}`);
    cleanup();
    process.exit(2);
  }
  console.log('  剧本已启动');

  /* ---- 等待阶段 2 ---- */
  section('断言 1 · 阶段 2 镜头锁定真受灾机架');
  let phase2 = null;
  for (let i = 0; i < 100; i += 1) {
    await sleep(300);
    const s = await evaluate(cdp, READ_STATE);
    if (s && typeof s.phase === 'string' && s.phase.includes('阶段 2/4')) {
      /* 再等校验轮询完成（最多 2s） */
      await sleep(2600);
      phase2 = await evaluate(cdp, READ_STATE);
      break;
    }
  }

  if (phase2 === null) {
    bad('阶段 2 可观察', null, '超时未进入阶段 2');
  } else {
    console.log(`  阶段 2 状态: chaos=${phase2.chaos} selected=${phase2.selected}`);
    console.log(`  字幕: ${phase2.phase}`);

    /* 1a. 混沌场景正确 */
    if (phase2.chaos === scenario) {
      ok('1a 注入的混沌场景与剧本一致', phase2.chaos);
    } else {
      bad('1a 注入的混沌场景与剧本一致', { actual: phase2.chaos, expected: scenario });
    }

    /* 1b. 选中的是节点类型 */
    if (phase2.selectedType === 'node') {
      ok('1b 选中实体为 node 类型', phase2.selectedType);
    } else {
      bad('1b 选中实体为 node 类型', { actual: phase2.selectedType, expected: 'node' });
    }

    /* 1c. 选中节点名下确实有异常 Pod —— 核心断言 */
    const abnormalOnSelected = (phase2.pods ?? []).filter(
      (p) => p.nodeId === phase2.selected && p.status !== 'Running',
    );
    const selectedNode = (phase2.nodes ?? []).find((n) => n.id === phase2.selected) ?? null;
    if (abnormalOnSelected.length > 0) {
      ok(
        '1c 选中节点名下存在异常 Pod（P0-1 核心）',
        `${selectedNode?.name ?? phase2.selected} 名下 ${abnormalOnSelected.length} 个: ${abnormalOnSelected
          .map((p) => `${p.name}(${p.status})`)
          .join(', ')}`,
      );
    } else {
      bad(
        '1c 选中节点名下存在异常 Pod（P0-1 核心）',
        {
          selected: phase2.selected,
          selectedNode,
          abnormalOnSelected: abnormalOnSelected.length,
          allAbnormal: (phase2.pods ?? []).filter((p) => p.status !== 'Running').map((p) => ({
            id: p.id,
            nodeId: p.nodeId,
            status: p.status,
          })),
        },
        '镜头锁定的节点名下没有任何异常 Pod —— 这正是 P0-1 的症状',
      );
    }

    /* 1d. 受害 Pod 全部落在选中节点上（允许有跨节点，但至少该节点为主体） */
    const allAbnormal = (phase2.pods ?? []).filter((p) => p.status !== 'Running');
    const onSelectedRatio =
      allAbnormal.length === 0 ? 0 : abnormalOnSelected.length / allAbnormal.length;
    if (onSelectedRatio >= 0.5) {
      ok(
        '1d 异常 Pod 以选中节点为主',
        `${abnormalOnSelected.length}/${allAbnormal.length} = ${(onSelectedRatio * 100).toFixed(0)}%`,
      );
    } else {
      bad(
        '1d 异常 Pod 以选中节点为主',
        { ratio: onSelectedRatio, onSelected: abnormalOnSelected.length, total: allAbnormal.length },
        '异常 Pod 分散在其他节点，镜头可能锁错了',
      );
    }
  }

  /* ---- 等待阶段 4 完成 ---- */
  section('断言 2 · 阶段 4 自愈覆盖全部受害者');
  section('断言 3 · MCP 回执 actionType 与映射一致');

  /*
   * 【等待条件必须看"自愈已落库"，而不是"时间轴已结束"】
   *
   * 时间轴（34s）与业务闭环（动作卡 ~44s 才水合）是两条不同步的线：
   * 字幕说"剧本已完整跑完"时，阶段 4 的异步链往往还没走到 healEntity。
   * 早期版本以 `剧本已完整跑完` 作为退出条件，会在自愈发生**之前**就采样，
   * 于是永远读到 healedIds=[] —— 那是断言写错，不是功能缺陷。
   *
   * 现在的退出条件（任一满足即停）：
   *   1. healedPodIds 非空且 MCP 回执已出现 → 闭环完成；
   *   2. 出现"闭环校验/部分覆盖/自愈未完全验证"任一等价日志 → 引擎已给结论；
   *   3. 硬超时 90s → 如实按空结果失败。
   */
  let final = null;
  const settleStart = Date.now();
  for (let i = 0; i < 180; i += 1) {
    await sleep(500);
    const s = await evaluate(cdp, READ_STATE);
    const healedCount = (s?.healedIds ?? []).length;
    const hasReceipt = s?.mcpAction !== null && s?.mcpAction !== undefined;
    const hasVerdict =
      typeof s?.lastDirectorLog === 'string' &&
      (s.lastDirectorLog.includes('闭环校验') ||
        s.lastDirectorLog.includes('部分覆盖') ||
        s.lastDirectorLog.includes('自愈未完全验证'));

    if ((healedCount > 0 && hasReceipt) || hasVerdict) {
      await sleep(1500);
      final = await evaluate(cdp, READ_STATE);
      break;
    }
    if (Date.now() - settleStart > 90000) {
      final = await evaluate(cdp, READ_STATE);
      break;
    }
  }
  if (final === null) final = await evaluate(cdp, READ_STATE);

  /* 2a. 受害者全部被自愈 */
  const victimIds = (phase2?.pods ?? [])
    .filter((p) => p.nodeId === phase2?.selected && p.status !== 'Running')
    .map((p) => p.id)
    .sort();
  const healedIds = final?.healedIds ?? [];
  const covered = victimIds.filter((id) => healedIds.includes(id));

  console.log(`  受害者 (${victimIds.length}): ${victimIds.join(', ')}`);
  console.log(`  已自愈 (${healedIds.length}): ${healedIds.join(', ')}`);
  console.log(`  终端末行: ${final?.lastDirectorLog}`);

  if (victimIds.length === 0) {
    bad('2a 自愈覆盖全部受害者', { victimIds, healedIds }, '阶段 2 未捕获受害者，无法验证覆盖');
  } else if (covered.length === victimIds.length) {
    ok('2a 自愈覆盖全部受害者（P0-2 核心）', `${covered.length}/${victimIds.length}`);
  } else {
    bad(
      '2a 自愈覆盖全部受害者（P0-2 核心）',
      { victimIds, healedIds, covered: covered.length, total: victimIds.length },
      '存在未自愈的受害者 —— 这是 P0-2 的症状',
    );
  }

  /* 2b. 不得对节点执行 drain_node 兜底（旧缺陷特征） */
  const healedNodeIds = healedIds.filter((id) => id.startsWith('node-'));
  if (healedNodeIds.length === 0) {
    ok('2b 未把节点 ID 当作自愈目标（无 drain 兜底）');
  } else {
    bad('2b 未把节点 ID 当作自愈目标（无 drain 兜底）', healedNodeIds, '旧实现的 drain_node 兜底特征');
  }

  /* 3a. MCP 回执动作与映射一致 */
  const expectedAction = EXPECTED_ACTION[scenario];
  /* 网络场景 drain_node 不适用于 Pod，会降级为 restart_pod —— 两者都接受 */
  const acceptableActions =
    expectedAction === 'drain_node' ? ['drain_node', 'restart_pod'] : [expectedAction];
  if (final?.mcpAction !== null && acceptableActions.includes(final.mcpAction)) {
    ok('3a MCP 回执 actionType 与 CHAOS_TARGETS 映射一致', `${final.mcpAction}（期望 ${expectedAction}）`);
  } else {
    bad(
      '3a MCP 回执 actionType 与 CHAOS_TARGETS 映射一致',
      { actual: final?.mcpAction ?? null, expected: expectedAction },
      '回执动作与场景映射不符',
    );
  }

  /* ---- 收尾 ---- */
  await evaluate(
    cdp,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').includes('停止剧本路演'));
      if (btn) btn.click();
      return true;
    })()`,
  );
  await sleep(1200);

  section('零控制台错误');
  if (cdp.consoleErrors.length === 0) {
    ok('全流程零 console.error');
  } else {
    bad('全流程零 console.error', cdp.consoleErrors.slice(0, 5));
  }

  cdp.close();
  cleanup();

  section('汇总');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  if (fail > 0) {
    console.log('\n  失败明细：');
    for (const f of failures) {
      console.log(`    · ${f.name}`);
      console.log(`      ${f.hint}`);
      console.log(`      ${JSON.stringify(f.actual, null, 2).split('\n').join('\n      ')}`);
    }
    process.exit(1);
  }
  console.log('\n  全部通过 ✓');
  process.exit(0);
}

function readCommit() {
  try {
    return String(execSync('git rev-parse --short HEAD', { encoding: 'utf8' })).trim();
  } catch {
    return 'unknown';
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(2);
});
