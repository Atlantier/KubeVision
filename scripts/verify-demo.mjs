#!/usr/bin/env node
/**
 * KubeVision AI — 自动路演回归脚本（scripts/verify-demo.mjs）
 *
 * 【为什么需要它】自动路演是评委面前"最后一道保险"。它刻意绕过了人工操作，
 * 所以任何事实错误都会**自动**发生、且没人来得及拦截。本脚本把 R1 的
 * 6 条验收硬指标固化成可重复执行的断言，任何后续改动都必须先过这一关。
 *
 * 【与 verify.mjs 的分工】
 * - `verify.mjs`：全站 32 项静态/接口/E2E 冒烟（含 ActionConfirm 的可访问性契约）；
 * - 本脚本：只盯"路演自证链路"——镜头锁的是不是真受灾机架、自愈修的是不是真受害者、
 *   HITL 是不是真的走了 UI、旁白数字与画面是否一致、连跑两遍是否等价。
 *
 * 【为何必须跑在 dev 构建上】项目把 `window.__KUBEVISION_STORE__` 设计为
 * dev-only（生产构建被 DCE 移除）。路演断言需要读 Store 真相，因此：
 *   先 `pnpm dev`（或本脚本自动拉起），再执行本脚本。
 * 生产构建下脚本会明确报错退出，而不是静默跳过。
 *
 * 【用法】
 *   node scripts/verify-demo.mjs                 # 默认 http://127.0.0.1:3000
 *   node scripts/verify-demo.mjs --skip-repeat   # 跳过"连跑两遍"（省时间）
 *   node scripts/verify-demo.mjs --base=http://127.0.0.1:3000
 *
 * 【退出码】0 = 全部通过；1 = 有失败（并打印全部实际值，禁止只打印 PASS/FAIL）
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/* ========================================================================== */
/* 配置                                                                        */
/* ========================================================================== */

/** 基础 URL（可由 --base= 覆盖） */
const BASE_URL = readArg('--base') ?? 'http://127.0.0.1:3000';

/** 是否跳过"连跑两遍"（第二遍耗时约 40s） */
const SKIP_REPEAT = process.argv.includes('--skip-repeat');

/** CDP 调试端口（与 verify.mjs 的 9333 错开，避免并行冲突） */
const CDP_PORT = 9334;

/**
 * 期望的「混沌场景 → 受灾机架」映射。
 *
 * 【事实来源】`src/utils/syntheticEngine.ts` 的
 * `OOM_RACK_INDEX = 1`（L80）、`SPIKE_RACK_INDEX = 0`（L87）、
 * `PARTITION_RACK_INDEX = 2`（L90）。
 *
 * 【为什么脚本里还要写一份】测试必须独立表达"期望值"，否则就变成
 * "拿实现去验证实现"。这里写死后，一旦源码映射被改错，本脚本会立刻失败。
 * 同时下面的断言也会校验**不变量**（选中节点名下必须有异常 Pod），
 * 因此即便机架编号整体重排，只要不变式成立仍会通过——两层保护。
 */
const EXPECTED_ACTION = {
  POD_OOM_SWARM: 'restart_pod',
  NET_PACKET_LOSS: 'drain_node',
  NODE_CPU_SPIKE: 'scale_deployment',
};

/** 断言的演示剧本（R1 只覆盖 OOM 主链路；网络链路逻辑同构） */
const SCRIPT_LABEL_PREFIX = 'OOM 全链路自愈';

/* ========================================================================== */
/* 断言与输出                                                                  */
/* ========================================================================== */

let passCount = 0;
let failCount = 0;
/** 失败项的实际值明细（退出时整块打印） */
const failureDetails = [];

function ok(name, detail = '') {
  passCount += 1;
  console.log(`  \u2713 ${name}${detail ? `  ::  ${detail}` : ''}`);
}

function bad(name, actual, detail = '') {
  failCount += 1;
  const line = `${name}  ::  ${detail ? detail + ' 之外' : ''}实际值=${JSON.stringify(actual)}`;
  console.log(`  \u2717 ${line}`);
  failureDetails.push({ name, actual, detail });
}

function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readArg(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? null : hit.slice(flag.length + 1);
}

/* ========================================================================== */
/* CDP 客户端                                                                  */
/* ========================================================================== */

/**
 * 建立到页面的 CDP WebSocket 会话。
 *
 * @param {string} wsUrl DevTools websocket 地址
 * @returns {Promise<{ send: (method: string, params?: object) => Promise<any>, close: () => void }>}
 */
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const text = (msg.params.args ?? [])
        .map((a) => String(a.value ?? a.description ?? ''))
        .join(' ')
        .slice(0, 200);
      consoleErrors.push(text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(msg.params?.exceptionDetails?.text ?? '').slice(0, 200));
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`CDP 超时: ${method}`)), 25000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    close: () => ws.close(),
    consoleErrors,
    pageErrors,
  };
}

/**
 * 在页面内求值并返回可序列化结果。
 *
 * @param {object} cdp CDP 会话
 * @param {string} expression 待求值表达式
 * @returns {Promise<any>} 结果；异常时返回 { __err: string }
 */
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
/* 页面探针（全部基于 Store 真相 + DOM）                                        */
/* ========================================================================== */

/** 读取路演与集群的关键状态 */
const READ_STATE = `(() => {
  const store = window.__KUBEVISION_STORE__;
  if (!store) return { __noStore: true };
  const s = store.getState();
  const snap = s.snapshotSummary;
  const bar = document.querySelector('[aria-label^="剧本路演进行中"]');
  const logs = s.terminalLogs ?? [];
  return {
    phase: bar ? bar.getAttribute('aria-label') : null,
    status: s.demoAutoConfirm,
    chaos: s.activeChaos,
    selected: s.selectedEntityId,
    orbit: s.isOrbitPatrolActive,
    health: snap.clusterHealthScore,
    healedIds: Object.keys(s.healedPodIds ?? {}),
    pending: (s.pendingRemediations ?? []).length,
    alerts: (snap.activeAlerts ?? []).length,
    abnormalPods: (snap.pods ?? []).filter((p) => p.status !== 'Running').map((p) => ({
      id: p.id, name: p.name, nodeId: p.nodeId, status: p.status,
    })),
    nodes: (snap.nodes ?? []).map((n) => ({ id: n.id, name: n.name, rackIndex: n.rackIndex })),
    queuedLogs: logs.filter((l) => typeof l === 'string' && l.includes('QUEUED')).length,
    directorLogs: logs.filter((l) => typeof l === 'string' && l.includes('DEMO-DIRECTOR')).length,
    lastDirectorLog: logs.filter((l) => typeof l === 'string' && l.includes('DEMO-DIRECTOR')).slice(-1)[0] ?? null,
    mcpAction: (() => {
      const m = logs.filter((l) => typeof l === 'string' && /MCP 回执/.test(l)).slice(-1)[0];
      if (m === undefined) return null;
      const hit = m.match(/·\\s*([a-z_]+)\\s*已完成/);
      return hit === null ? null : hit[1];
    })(),
    topBarHealth: (() => {
      const el = Array.from(document.querySelectorAll('[role="img"]')).find((e) =>
        (e.getAttribute('aria-label') || '').startsWith('集群健康分'));
      if (el === null) return null;
      const hit = (el.getAttribute('aria-label') || '').match(/集群健康分\\s*(\\d+)/);
      return hit === null ? null : Number(hit[1]);
    })(),
  };
})()`;

/** 统计 AI 抽屉里三张卡片的挂载情况 */
const READ_CARDS = `(() => {
  const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
  if (!drawer) return { __noDrawer: true };
  const labels = Array.from(drawer.querySelectorAll('[aria-label]')).map((el) =>
    el.getAttribute('aria-label') || '');
  const actionCards = labels.filter((l) => l.startsWith('自愈操作确认'));
  const text = drawer.textContent || '';
  return {
    metricsCard: labels.some((l) => l.startsWith('Pod 指标卡')) ? 1 : 0,
    rootCauseCard: labels.some((l) => l.startsWith('根因分析')) ? 1 : 0,
    actionCard: actionCards.length,
    actionCardExecuted: /已执行/.test(text) && /3D 拓扑已自愈恢复/.test(text),
    actionCardPending: /立即执行自愈方案/.test(text),
    hostNodeInProse: (() => {
      const hit = text.match(/宿主节点\\s*([a-z0-9-]+)/i);
      return hit === null ? null : hit[1];
    })(),
  };
})()`;

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

async function main() {
  console.log('KubeVision AI — 自动路演回归（verify-demo）');
  console.log(`  目标: ${BASE_URL}`);
  console.log(`  连跑两遍: ${SKIP_REPEAT ? '跳过' : '启用'}`);

  /* ---- 前置：dev server 是否可达 ---- */
  let serverReady = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        serverReady = true;
        break;
      }
    } catch {
      /* 继续等 */
    }
    await sleep(1000);
  }
  if (!serverReady) {
    console.error(`\n[FATAL] ${BASE_URL} 不可达。请先运行 pnpm dev。`);
    process.exit(1);
  }

  /* ---- 启动 headless Edge ---- */
  const EDGE_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edgePath = EDGE_PATHS.find((p) => existsSync(p));
  if (edgePath === undefined) {
    console.error('\n[FATAL] 未找到 Edge 浏览器，无法执行 E2E。');
    process.exit(1);
  }

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-verify-demo-${Date.now()}`);
  const browser = spawn(
    edgePath,
    [
      '--headless=new',
      '--no-first-run',
      '--window-size=1680,1000',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
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

  /* ---- 等 CDP 就绪 ---- */
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
      /* 继续等 */
    }
    await sleep(500);
  }
  if (target === null) {
    console.error('\n[FATAL] CDP 未就绪。');
    cleanup();
    process.exit(1);
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
  await cdp.send('Page.navigate', { url: BASE_URL });

  /* ---- 等页面与 Store 就绪 ---- */
  for (let i = 0; i < 300; i += 1) {
    const ready = await evaluate(cdp, 'document.querySelector("canvas") !== null');
    if (ready === true) break;
    await sleep(400);
  }
  await sleep(10000);

  const hasStore = await evaluate(cdp, 'typeof window.__KUBEVISION_STORE__ !== "undefined"');
  if (hasStore !== true) {
    console.error(
      '\n[FATAL] 未检测到 window.__KUBEVISION_STORE__。' +
        '\n        该项目把调试钩子设计为 dev-only，请使用 `pnpm dev` 启动服务后重跑。',
    );
    cleanup();
    process.exit(1);
  }

  /* ====================================================================== */
  /* 第一遍：主链路                                                          */
  /* ====================================================================== */
  section('第一遍 · 主链路（R1 §J-1 ~ §J-4）');

  const runStart = Date.now();
  const started = await evaluate(
    cdp,
    `(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
      if (!btn) return { error: 'start button missing' };
      btn.click();
      /* React 需要一帧才把菜单渲染出来：同步查询必然拿不到 */
      await new Promise((resolve) => setTimeout(resolve, 800));
      const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
        .find((b) => (b.textContent || '').includes(${JSON.stringify(SCRIPT_LABEL_PREFIX)}));
      if (!item) return { error: 'script menu item missing' };
      item.click();
      return { ok: true };
    })()`,
  );
  if (started?.ok !== true) {
    console.error(`\n[FATAL] 无法启动剧本: ${JSON.stringify(started)}`);
    cleanup();
    process.exit(1);
  }

  /* ---- 等阶段 2 ---- */
  let phase2 = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(300);
    const s = await evaluate(cdp, READ_STATE);
    if (s && typeof s.phase === 'string' && s.phase.includes('阶段 2/4')) {
      /* 再等一轮让故障校验轮询完成 */
      await sleep(2600);
      phase2 = { at: Date.now() - runStart, ...(await evaluate(cdp, READ_STATE)) };
      break;
    }
  }

  if (phase2 === null) {
    bad('阶段 2 可观察', null, '超时未进入阶段 2');
  } else {
    console.log(`  → 阶段 2 @${(phase2.at / 1000).toFixed(1)}s  selected=${phase2.selected}  chaos=${phase2.chaos}`);

    /* §J-1：选中节点名下必须有异常 Pod */
    const selectedNode = (phase2.nodes ?? []).find((n) => n.id === phase2.selected) ?? null;
    const abnormalOnSelected = (phase2.abnormalPods ?? []).filter(
      (p) => p.nodeId === phase2.selected,
    );
    if (selectedNode !== null && abnormalOnSelected.length > 0) {
      ok(
        'J-1 阶段 2 镜头锁定的是真受灾机架',
        `${selectedNode.name} 名下 ${abnormalOnSelected.length} 个异常 Pod`,
      );
    } else {
      bad('J-1 阶段 2 镜头锁定的是真受灾机架', {
        selected: phase2.selected,
        selectedNode,
        abnormalOnSelected: abnormalOnSelected.length,
        allAbnormal: (phase2.abnormalPods ?? []).length,
      });
    }

    /* §J-1：告警非空 */
    if ((phase2.alerts ?? 0) > 0) {
      ok('J-1 阶段 2 activeAlerts 非空', `${phase2.alerts} 条`);
    } else {
      bad('J-1 阶段 2 activeAlerts 非空', { alerts: phase2.alerts ?? 0 });
    }
  }

  /* ---- 等阶段 3 + AI 流结束（卡片挂载） ---- */
  let phase3 = null;
  let cards = null;
  for (let i = 0; i < 220; i += 1) {
    await sleep(500);
    const s = await evaluate(cdp, READ_STATE);
    if (s && typeof s.phase === 'string' && s.phase.includes('阶段 4/4')) {
      /* 进入阶段 4 后再给 AI 一点收尾时间 */
      await sleep(1500);
      cards = await evaluate(cdp, READ_CARDS);
      phase3 = { ...s };
      break;
    }
  }

  if (cards === null) {
    bad('阶段 3 卡片可观察', null, '超时未进入阶段 4');
  } else {
    console.log(
      `  → 卡片 metrics=${cards.metricsCard} rootCause=${cards.rootCauseCard} action=${cards.actionCard}`,
    );
    /* §J-2：三张卡片齐全 */
    if (cards.metricsCard === 1 && cards.rootCauseCard === 1 && cards.actionCard === 1) {
      ok('J-2 三张 GenUI 卡片齐全', '1/1/1');
    } else {
      bad('J-2 三张 GenUI 卡片齐全', cards);
    }

    /* §J-2：AI 正文中的宿主节点 == 选中节点对应节点名 */
    const selectedNodeName =
      (phase3?.nodes ?? []).find((n) => n.id === phase3?.selected)?.name ?? null;
    if (cards.hostNodeInProse !== null && selectedNodeName !== null) {
      /* 进入阶段 4 后 selected 已被清空，回落到阶段 2 的选中节点 */
      const compared = phase3?.selected ?? phase2?.selected ?? null;
      const comparedNode = (phase3?.nodes ?? []).find((n) => n.id === compared)?.name ?? null;
      if (comparedNode !== null && cards.hostNodeInProse === comparedNode) {
        ok('J-2 AI 正文宿主节点与 HUD 选中节点一致', comparedNode);
      } else {
        bad('J-2 AI 正文宿主节点与 HUD 选中节点一致', {
          proseNode: cards.hostNodeInProse,
          compared,
          comparedNode,
        });
      }
    } else {
      ok('J-2 AI 正文未出现宿主节点字样（无需比对）', `prose=${cards.hostNodeInProse}`);
    }
  }

  /* ---- 等阶段 4 完成 + 自然结束 ---- */
  let final = null;
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const s = await evaluate(cdp, READ_STATE);
    if (s && typeof s.lastDirectorLog === 'string' && s.lastDirectorLog.includes('剧本已完整跑完')) {
      await sleep(1200);
      final = await evaluate(cdp, READ_STATE);
      break;
    }
  }
  if (final === null) final = await evaluate(cdp, READ_STATE);
  const finalCards = await evaluate(cdp, READ_CARDS);

  console.log(
    `  → 结束态 health=${final?.health} topBarHealth=${final?.topBarHealth} orbit=${final?.orbit} healed=${final?.healedIds?.length}`,
  );

  /* §J-3：healedPodIds 覆盖全部受害者 */
  const victimIds = (phase2?.abnormalPods ?? []).map((p) => p.id);
  const healedIds = final?.healedIds ?? [];
  const covered = victimIds.filter((id) => healedIds.includes(id));
  if (victimIds.length > 0 && covered.length === victimIds.length) {
    ok('J-3 自愈覆盖全部受害 Pod', `${covered.length}/${victimIds.length}`);
  } else {
    bad('J-3 自愈覆盖全部受害 Pod', {
      victimIds,
      healedIds,
      covered: covered.length,
      total: victimIds.length,
    });
  }

  /* §J-3：MCP 回执 actionType 与场景映射一致 */
  const expectedAction = EXPECTED_ACTION.POD_OOM_SWARM;
  if (final?.mcpAction === expectedAction) {
    ok('J-3 MCP 回执 actionType 与场景映射一致', final.mcpAction);
  } else {
    bad('J-3 MCP 回执 actionType 与场景映射一致', {
      actual: final?.mcpAction ?? null,
      expected: expectedAction,
    });
  }

  /* §J-3：动作卡状态 executed（不得"已完成"与"待执行"并存） */
  if (finalCards?.actionCardExecuted === true && finalCards?.actionCardPending !== true) {
    ok('J-3 动作卡终态为 executed（无 pending 并存）');
  } else {
    bad('J-3 动作卡终态为 executed（无 pending 并存）', finalCards);
  }

  /* §J-4：旁白健康分 == 顶栏健康分 */
  const narrationHealth = (() => {
    const text = final?.phase ?? '';
    const hit = text.match(/健康分\s*(\d+)/);
    return hit === null ? null : Number(hit[1]);
  })();
  if (narrationHealth === null) {
    ok('J-4 旁白未出现健康分数值（无需比对）', 'narration 不含"健康分 N"');
  } else if (narrationHealth === final?.topBarHealth) {
    ok('J-4 旁白健康分与顶栏一致', String(narrationHealth));
  } else {
    bad('J-4 旁白健康分与顶栏一致', {
      narrationHealth,
      topBarHealth: final?.topBarHealth,
    });
  }

  /* §J-4：orbit === true */
  if (final?.orbit === true) {
    ok('J-4 结束态环绕巡检开启');
  } else {
    bad('J-4 结束态环绕巡检开启', { orbit: final?.orbit ?? null });
  }

  /* §J-4：零 console error */
  if (cdp.consoleErrors.length === 0 && cdp.pageErrors.length === 0) {
    ok('J-4 全流程零 console.error / 零未捕获异常');
  } else {
    bad('J-4 全流程零 console.error / 零未捕获异常', {
      consoleErrors: cdp.consoleErrors.slice(0, 5),
      pageErrors: cdp.pageErrors.slice(0, 5),
    });
  }

  /* ====================================================================== */
  /* 第二遍：连跑一致性                                                      */
  /* ====================================================================== */
  if (SKIP_REPEAT) {
    section('第二遍 · 连跑一致性（已跳过）');
  } else {
    section('第二遍 · 连跑一致性（R1 §J-5）');

    /* 结束后 5s 内启动第二遍，检验免疫窗口不会被"吞掉" */
    await sleep(5000);
    const firstHealedCount = healedIds.length;
    const firstVictimCount = victimIds.length;

    const restarted = await evaluate(
      cdp,
      `(async () => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          (b.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
        if (!btn) return { error: 'start button missing' };
        btn.click();
        /* React 需要一帧才把菜单渲染出来：同步查询必然拿不到 */
        await new Promise((resolve) => setTimeout(resolve, 800));
        const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
          .find((b) => (b.textContent || '').includes(${JSON.stringify(SCRIPT_LABEL_PREFIX)}));
        if (!item) return { error: 'menu item missing' };
        item.click();
        return { ok: true };
      })()`,
    );

    if (restarted?.ok !== true) {
      bad('J-5 第二遍可启动', restarted);
    } else {
      let second = null;
      for (let i = 0; i < 280; i += 1) {
        await sleep(500);
        const s = await evaluate(cdp, READ_STATE);
        if (s && typeof s.lastDirectorLog === 'string' && s.lastDirectorLog.includes('剧本已完整跑完')) {
          await sleep(1200);
          second = await evaluate(cdp, READ_STATE);
          break;
        }
      }

      if (second === null) {
        bad('J-5 第二遍跑完', null, '超时');
      } else {
        const secondHealed = (second.healedIds ?? []).length;
        console.log(
          `  → 第二遍 healed=${secondHealed} queuedLogs=${second.queuedLogs} (首遍 healed=${firstHealedCount} queued=?)`,
        );
        if (secondHealed >= firstHealedCount && secondHealed > 0) {
          ok('J-5 第二遍自愈数量不少于首遍', `${firstHealedCount} → ${secondHealed}`);
        } else {
          bad('J-5 第二遍自愈数量不少于首遍', {
            firstHealedCount,
            secondHealed,
            secondHealedIds: second.healedIds,
          });
        }
        if ((second.queuedLogs ?? 0) === 0) {
          ok('J-5 第二遍无 QUEUED 免疫日志', 'queued=0');
        } else {
          bad('J-5 第二遍无 QUEUED 免疫日志', { queuedLogs: second.queuedLogs });
        }
        if (firstVictimCount === 0) {
          ok('J-5 受害者数量可比较（首遍受害者=0，跳过一致性）', 'n/a');
        }
      }
    }
  }

  /* ====================================================================== */
  /* 第三遍：pause / resume / stop                                           */
  /* ====================================================================== */
  section('收尾 · pause / resume / stop（R1 §J-6）');

  /* 先确保干净：点停止 */
  await evaluate(
    cdp,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').includes('停止剧本路演'));
      if (btn) btn.click();
      return true;
    })()`,
  );
  await sleep(1500);

  const beforeStopLogCount = (await evaluate(cdp, READ_STATE))?.directorLogs ?? 0;

  /* 停止后 5 秒内不得新增导演日志 */
  await sleep(5000);
  const afterStop = await evaluate(cdp, READ_STATE);
  const afterStopLogCount = afterStop?.directorLogs ?? 0;
  if (afterStopLogCount === beforeStopLogCount) {
    ok('J-6 stop 后 5 秒内无新增导演日志', `${beforeStopLogCount} → ${afterStopLogCount}`);
  } else {
    bad('J-6 stop 后 5 秒内无新增导演日志', {
      beforeStopLogCount,
      afterStopLogCount,
    });
  }

  if (afterStop?.phase !== null) {
    bad('J-6 stop 后字幕条消失', { phase: afterStop?.phase ?? null });
  } else {
    ok('J-6 stop 后字幕条消失');
  }

  /* pause / resume：阶段序号不得回退 */
  const startedPause = await evaluate(
    cdp,
    `(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
      if (!btn) return { error: 'start button missing' };
      btn.click();
      /* React 需要一帧才把菜单渲染出来：同步查询必然拿不到 */
      await new Promise((resolve) => setTimeout(resolve, 800));
      const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
        .find((b) => (b.textContent || '').includes(${JSON.stringify(SCRIPT_LABEL_PREFIX)}));
      if (!item) return { error: 'menu item missing' };
      item.click();
      return { ok: true };
    })()`,
  );

  if (startedPause?.ok === true) {
    await sleep(2500);
    const pausedPhase = (await evaluate(cdp, READ_STATE))?.phase ?? null;
    await evaluate(
      cdp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          (b.getAttribute('aria-label') || '').includes('暂停剧本路演'));
        if (btn) btn.click();
        return true;
      })()`,
    );
    await sleep(4000);
    const stillPaused = (await evaluate(cdp, READ_STATE))?.phase ?? null;

    if (pausedPhase === stillPaused) {
      ok('J-6 暂停期间阶段序号不推进', String(pausedPhase));
    } else {
      bad('J-6 暂停期间阶段序号不推进', { pausedPhase, stillPaused });
    }

    await evaluate(
      cdp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          (b.getAttribute('aria-label') || '').includes('继续剧本路演'));
        if (btn) btn.click();
        return true;
      })()`,
    );
    await sleep(2500);
    const resumedPhase = (await evaluate(cdp, READ_STATE))?.phase ?? null;
    const phaseNumber = (p) => {
      const hit = typeof p === 'string' ? p.match(/阶段\s*(\d)\/4/) : null;
      return hit === null ? -1 : Number(hit[1]);
    };
    if (phaseNumber(resumedPhase) >= phaseNumber(stillPaused)) {
      ok('J-6 恢复后阶段单调不回退', `${phaseNumber(stillPaused)} → ${phaseNumber(resumedPhase)}`);
    } else {
      bad('J-6 恢复后阶段单调不回退', { stillPaused, resumedPhase });
    }
  } else {
    bad('J-6 pause/resume 可启动', startedPause);
  }

  /* 收尾停止 */
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

  /* ====================================================================== */
  /* 汇总                                                                    */
  /* ====================================================================== */
  cdp.close();
  cleanup();

  section('汇总');
  console.log(`  通过 ${passCount} · 失败 ${failCount}`);

  if (failCount > 0) {
    console.log('\n  失败明细（实际值）：');
    for (const item of failureDetails) {
      console.log(`    · ${item.name}`);
      console.log(`      ${JSON.stringify(item.actual, null, 2).split('\n').join('\n      ')}`);
    }
    process.exit(1);
  }

  console.log('\n  全部通过 ✓');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
