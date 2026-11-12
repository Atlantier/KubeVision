#!/usr/bin/env node
/**
 * KubeVision AI — 请求竞态矩阵探针（R2 次轮）
 *
 * 【为什么需要】流式链路的竞态（连发覆盖 / 组件卸载后 setState / 排队丢上下文）
 * 只在"人手快速乱点"时出现，普通回归连一次请求永远测不到。本探针用真实浏览器
 * 制造 5 种竞态，断言 React 不报"卸载后更新"、气泡不重复、排队语义正确。
 *
 * 【矩阵】
 *   A. 快速连发 5 条（首次触发流，其余 4 条应进 FIFO 队列，不覆盖）
 *   B. 连发中切页签（Copilot ↔ 拓扑）
 *   C. 流式中关闭抽屉（卸载热点子组件）
 *   D. 流式中刷新页面（硬卸载）
 *   E. 刷新后恢复：无残留 copilotStreaming / 无重复气泡
 *
 * 【断言】
 *   - 0 次 console.error / 未捕获异常（"setState on unmounted" 会走这里）
 *   - assistant 气泡数 ≤ 1（同一次发送不得出现重复气泡）
 *   - 停止/刷新后 copilotStreaming === false 且输入框可用
 *   - 排队提示出现即证明 FIFO 生效（未覆盖）
 *
 * 用法：node scripts/probe-request-race.mjs（需先 pnpm dev）
 * 退出码：0 = 全部通过；1 = 存在竞态缺陷。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASE = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const OUT_DIR = join(ROOT, 'docs/summit/artifacts');
const PORT = 9399;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --browser edge|chrome：本机两个 Blink 载体，用同一套矩阵交叉验证，
 * 避免"结论只在某一款浏览器成立"。Firefox/Safari 在 Windows 本机不可得（见 R2 次轮报告）。 */
const BROWSER = (() => {
  const i = process.argv.indexOf('--browser');
  const value = i >= 0 ? process.argv[i + 1] : 'edge';
  return value === 'chrome' ? 'chrome' : 'edge';
})();
const BROWSER_PATHS = {
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};
const EDGE = BROWSER_PATHS[BROWSER].find((p) => existsSync(p));
if (!EDGE) {
  console.error(`[FATAL] 未找到 ${BROWSER}`);
  process.exit(2);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method !== undefined) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      const t = setTimeout(() => rej(new Error(`CDP timeout ${method}`)), 30000);
      pending.set(n, (m) => {
        clearTimeout(t);
        res(m);
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { send, events, close: () => ws.close() };
}

const ev = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    return { __err: String(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text) };
  }
  return r.result?.result?.value;
};

const browser = spawn(
  EDGE,
  [
    '--headless=new',
    '--no-first-run',
    '--hide-scrollbars',
    '--use-gl=angle',
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--window-size=1366,768',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-race-${Date.now()}`)}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => {
  try {
    browser.kill('SIGKILL');
  } catch {
    /* ignore */
  }
});

let target = null;
for (let i = 0; i < 80; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
    const list = await res.json();
    target = list.find((x) => x.type === 'page') ?? null;
    if (target) break;
  } catch {
    /* retry */
  }
  await sleep(400);
}
if (!target) {
  console.error('[FATAL] 无 CDP 目标');
  process.exit(2);
}

const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

const consoleErrors = [];
const pageExceptions = [];

const openPage = async () => {
  await cdp.send('Page.navigate', { url: BASE });
  for (let i = 0; i < 200; i += 1) {
    if ((await ev(cdp, 'document.querySelector("canvas") !== null')) === true) break;
    await sleep(350);
  }
  await sleep(2600);
};

const snapshot = () =>
  ev(
    cdp,
    `(() => {
      const s = window.__KUBEVISION_STORE__?.getState?.() ?? {};
      const textarea = document.querySelector('textarea[aria-label="对话输入框"]');
      /* 发送能力的三态真实契约（见 CopilotDrawer 输入区）：
       *  - 流式中：发送按钮被「停止」按钮替换（条件渲染，不是 disabled）；
       *  - 非流式且有内容：出现 aria-label="发送消息" 的可用按钮；
       *  - 非流式且空：发送按钮存在但 disabled。
       * 因此"输入区可用"= 不存在「停止」按钮，且发送按钮存在或可编辑。 */
      const stopBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => (b.getAttribute('title') || '').includes('停止生成'),
      );
      const sendBtn = document.querySelector('button[aria-label="发送消息"]');
      return {
        copilotStreaming: s.copilotStreaming ?? null,
        hasTextarea: Boolean(textarea),
        textareaDisabled: textarea ? textarea.disabled : null,
        hasStopButton: Boolean(stopBtn),
        hasSendButton: Boolean(sendBtn),
        sendDisabled: sendBtn ? sendBtn.disabled : null,
        assistantBubbles: document.querySelectorAll('[data-copilot-msg="assistant"]').length,
        userBubbles: document.querySelectorAll('[data-copilot-msg="user"]').length,
        queueNotice: (document.body.textContent || '').match(/已排队\\s*(\\d+)\\s*条/)?.[1] ?? null,
      };
    })()`,
  );

/* 收集浏览器控制台错误与未捕获异常 */
const drainErrors = () => {
  const errors = [];
  for (const event of cdp.events) {
    if (event.method === 'Runtime.exceptionThrown') {
      errors.push(`exception: ${event.params?.exceptionDetails?.exception?.description ?? 'unknown'}`);
    }
    if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') {
      const text = (event.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      errors.push(`console.error: ${text}`);
    }
  }
  cdp.events.length = 0;
  return errors;
};

const results = [];
function assert(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}  (${detail})`);
}

try {
  /* ================= A. 快速连发 5 条（真实发送路径 + 逐条送达核对） ================= */
  await openPage();

  /*
   * 【为什么走 Enter 而不是点发送按钮】产品契约：流式期间发送按钮被「停止」按钮
   * **条件替换**（send/stop 双态，见 CopilotDrawer 输入区），此时按钮不可用；
   * 用户仍可通过 Enter 发送，sendMessage 会把请求转入内部 FIFO 排队。
   * 因此"连发"的真实可达路径是 Enter —— 探针必须测这条路径，而不是点一个不存在的按钮。
   */
  const SEND_ONE = (text) => `(() => {
    const ta = document.querySelector('textarea[aria-label="对话输入框"]');
    if (!ta) return { ok: false, reason: 'no textarea' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return { ok: true };
  })()`;

  const sendResults = [];
  for (let i = 0; i < 5; i += 1) {
    /* 每条之间只等一个微任务/一帧，制造"用户在流式期间连点"的竞态 */
    const r = await ev(cdp, SEND_ONE(`诊断 OOMKilled 根因并生成自愈方案 #${i}`));
    sendResults.push(r);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  const accepted = sendResults.filter((r) => r && r.ok === true).length;

  /* 观察 FIFO 排队证据：流式期间连发的后 4 条应出现在「已排队 N 条」提示里 */
  let maxQueued = 0;
  for (let i = 0; i < 16; i += 1) {
    await sleep(120);
    const n = await ev(
      cdp,
      `(() => { const m = (document.body.textContent || '').match(/已排队\\s*(\\d+)\\s*条/); return m ? Number(m[1]) : 0; })()`,
    );
    if (typeof n === 'number' && n > maxQueued) maxQueued = n;
  }
  const rapid = await snapshot();
  assert(
    'A. 真实发送路径连点 5 次：首条进流式、发送键被停止键替换、无重复气泡',
    accepted === 5 &&
      rapid.copilotStreaming === true &&
      rapid.hasStopButton === true &&
      rapid.hasSendButton === false &&
      rapid.assistantBubbles === 1,
    `accepted=${accepted}/5 ${JSON.stringify(rapid)}`,
  );

  /* FIFO 语义：后 4 条必须进队列（提示最大 4 条），而不是被单槽覆盖 */
  assert(
    'A. FIFO 排队语义：连发后 4 条全部进入队列（提示达 4 条，未覆盖）',
    maxQueued === 4,
    `maxQueued=${maxQueued}`,
  );

  /* 逐条核对 5 条是否最终都送达（用户气泡数 = 5）；LLM 串行约需 1~2 分钟 */
  let delivered = 0;
  let finalSnap = rapid;
  for (let i = 0; i < 360; i += 1) {
    await sleep(500);
    finalSnap = await snapshot();
    delivered = finalSnap.userBubbles;
    if (delivered >= 5) break;
  }
  assert(
    'A. FIFO 逐条送达：5 次连点最终产出 5 条用户消息（不覆盖、不丢）',
    delivered === 5,
    `userBubbles=${delivered}/5`,
  );
  assert(
    'A. 无重复气泡：assistant 气泡数 === user 气泡数（每次发送恰好一条回复）',
    finalSnap.assistantBubbles === finalSnap.userBubbles && finalSnap.userBubbles === 5,
    `assistant=${finalSnap.assistantBubbles} user=${finalSnap.userBubbles}`,
  );

  const rapidErrors = drainErrors();
  assert(
    'A. 连发期间零 console.error / 零未捕获异常',
    rapidErrors.length === 0,
    rapidErrors.length === 0 ? '0 errors' : rapidErrors.slice(0, 2).join(' | '),
  );

  /*
   * 【场景隔离】A 段结束后 FIFO 里仍有排队请求在跑。若不先排空就进 B/C，
   * 下一条流会在"切页签/关抽屉"期间仍在进行，断言就会把"场景 B 的行为"
   * 和"场景 A 未排空的残留"混在一起，测出假失败。这里等 copilotStreaming
   * 回落到 false 且队列提示消失，确保每个场景从干净起点开始。
   */
  const waitIdle = async (label, timeoutMs = 90000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const s = await ev(cdp, `window.__KUBEVISION_STORE__.getState().copilotStreaming`);
      const notice = await ev(
        cdp,
        `(document.body.textContent || '').match(/已排队\\s*\\d+\\s*条/) ? true : false`,
      );
      if (s === false && notice === false) return true;
      await sleep(400);
    }
    console.log(`    (waitIdle timeout for ${label})`);
    return false;
  };
  await waitIdle('after A');
  await sleep(300);

  /* ================= B. 流式中切页签 ================= */
  /* 重新触发一条流，确保 B 测的是"流式中"而非残留 */
  await ev(cdp, SEND_ONE('切页签期间的诊断请求'));
  for (let i = 0; i < 30; i += 1) {
    await sleep(200);
    if ((await ev(cdp, `window.__KUBEVISION_STORE__.getState().copilotStreaming`)) === true) break;
  }
  await ev(
    cdp,
    `(() => {
      const s = window.__KUBEVISION_STORE__.getState();
      s.setActiveRightTab('topology');
      return true;
    })()`,
  );
  await sleep(400);
  await ev(cdp, `window.__KUBEVISION_STORE__.getState().setActiveRightTab('audit')`);
  await sleep(600);
  const tabSwitched = await snapshot();
  const tabErrors = drainErrors();
  assert(
    'B. 流式中切页签：无卸载后更新、无异常',
    tabErrors.length === 0,
    tabErrors.length === 0 ? '0 errors' : tabErrors.slice(0, 2).join(' | '),
  );
  assert(
    'B. 切页签后无重复气泡：assistant 气泡数 === user 气泡数',
    tabSwitched.assistantBubbles === tabSwitched.userBubbles,
    `assistant=${tabSwitched.assistantBubbles} user=${tabSwitched.userBubbles}`,
  );

  /* ================= C. 流式中关抽屉 ================= */
  /* 先停掉 B 的在途流，确保 C 从"有一条在途流"的干净起点进入 */
  await ev(cdp, `window.__KUBEVISION_STORE__.getState().requestCopilotAbort()`);
  await sleep(1200);
  await ev(cdp, SEND_ONE('关闭抽屉期间的诊断请求'));
  for (let i = 0; i < 40; i += 1) {
    await sleep(200);
    if ((await ev(cdp, `window.__KUBEVISION_STORE__.getState().copilotStreaming`)) === true) break;
  }
  const closed = await ev(
    cdp,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => (b.getAttribute('aria-label') || '').includes('收起') ||
               (b.getAttribute('aria-label') || '').includes('关闭'),
      );
      if (btn) btn.click();
      return Boolean(btn);
    })()`,
  );
  /* 关抽屉不会自动 abort；显式停止，模拟"用户停下并收起抽屉" */
  await ev(cdp, `window.__KUBEVISION_STORE__.getState().requestCopilotAbort()`);
  let closeStreaming = true;
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    closeStreaming = await ev(cdp, `window.__KUBEVISION_STORE__.getState().copilotStreaming`);
    if (closeStreaming === false) break;
  }
  const afterClose = await snapshot();
  const closeErrors = drainErrors();
  assert(
    'C. 流式中关闭抽屉：无 setState-on-unmounted',
    closeErrors.length === 0,
    closeErrors.length === 0 ? '0 errors' : closeErrors.slice(0, 2).join(' | '),
  );
  assert(
    'C. 关闭后 copilotStreaming 复位（无悬挂活动态）',
    afterClose.copilotStreaming === false && closeStreaming === false,
    `copilotStreaming=${afterClose.copilotStreaming} closed=${String(closed)}`,
  );

  /* ================= D. 流式中刷新页面 ================= */
  await ev(cdp, SEND_ONE('刷新前在途请求'));
  await sleep(900);
  await openPage(); // 硬刷新（重新 navigate）
  const afterReload = await snapshot();
  const reloadErrors = drainErrors();
  assert(
    'D. 流式中刷新：无卸载后更新、无异常',
    reloadErrors.length === 0,
    reloadErrors.length === 0 ? '0 errors' : reloadErrors.slice(0, 2).join(' | '),
  );
  assert(
    'D. 刷新后 copilotStreaming=false、textarea 可用、无残留气泡',
    afterReload.copilotStreaming === false && afterReload.hasTextarea === true && afterReload.hasStopButton === false && afterReload.assistantBubbles === 0,
    JSON.stringify(afterReload),
  );

  /* ================= E. 刷新后重新发送仍正常 ================= */
  await ev(cdp, SEND_ONE('刷新后再诊断一次'));
  let streamingSeen = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    const s = await ev(cdp, `window.__KUBEVISION_STORE__.getState().copilotStreaming`);
    if (s === true) {
      streamingSeen = true;
      break;
    }
  }
  assert('E. 刷新后重新发送能正常进入流式（链路未卡死）', streamingSeen === true, `streaming=${streamingSeen}`);

  const finalErrors = drainErrors();
  assert(
    'E. 全矩阵零 console.error / 零未捕获异常',
    finalErrors.length === 0,
    finalErrors.length === 0 ? '0 errors' : finalErrors.slice(0, 3).join(' | '),
  );

  /* ================= F. 截断流 → incomplete 视觉提示（截图） ================= */
  await openPage();
  /* 页内拦截 /api/chat：返回一条"合法但被截断"的 NDJSON —— 有正文/卡片、没有 done。
   * 这是最诚实的复现方式：不碰服务端、不改产品代码，只在浏览器侧模拟网络截断。 */
  await ev(
    cdp,
    `(() => {
      const truncatedEvents = [
        { type: 'reset', requestId: 'req-trunc', reason: 'new-round' },
        { type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: '解析意图', detail: '演示截断流', latencyMs: 5 } },
        { type: 'text', content: '正在分析集群状态，已采集到关键指标…' },
        { type: 'tool-start', toolCallId: 'trunc-metrics', toolName: 'renderPodMetrics', mcpUri: 'mcp://k8s-cluster/tools/renderPodMetrics' },
        { type: 'tool-result', toolCallId: 'trunc-metrics', toolName: 'renderPodMetrics', args: {
            podId: 'pod-trunc', podName: 'payment-gateway-7f8b9-x2k', namespace: 'kv-prod',
            cpuUsage: 66, memoryUsage: 97, restarts: 9,
            cpuHistory: [58, 62, 65, 66, 66, 66], memHistory: [80, 86, 91, 95, 96, 97],
          } },
        /* 故意不发 done —— 模拟连接在收尾前被切断 */
      ];
      const body = truncatedEvents.map((e) => JSON.stringify(e)).join('\\n') + '\\n';
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/chat') !== -1) {
          return Promise.resolve(new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
          }));
        }
        return origFetch.call(window, input, init);
      };
      return true;
    })()`,
  );

  await ev(cdp, SEND_ONE('截断流复现请求'));
  let incompleteSeen = false;
  let hasRegenerate = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    const state = await ev(
      cdp,
      `(() => {
        const text = document.body.textContent || '';
        const bubble = document.querySelector('[data-copilot-msg="assistant"]');
        const buttons = Array.from(document.querySelectorAll('button')).map((b) => b.textContent || '');
        return {
          hasIncompleteText: text.includes('回答可能不完整'),
          hasRegenerate: buttons.some((t) => t.includes('重新生成')),
          hasBubble: Boolean(bubble),
        };
      })()`,
    );
    incompleteSeen = state.hasIncompleteText === true;
    hasRegenerate = state.hasRegenerate === true;
    if (incompleteSeen && hasRegenerate) break;
  }
  const afterTrunc = await snapshot();
  const truncErrors = drainErrors();
  assert(
    'F. 截断流（无 done）→ 气泡底部显示「回答可能不完整」',
    incompleteSeen === true,
    `hasIncompleteText=${incompleteSeen}`,
  );
  assert(
    'F. 截断流 → 提供「重新生成」动作',
    hasRegenerate === true,
    `hasRegenerate=${hasRegenerate}`,
  );
  assert(
    'F. 截断流的已生成内容与工具卡片被保留（reset 不清卡片）',
    afterTrunc.assistantBubbles === 1,
    `assistantBubbles=${afterTrunc.assistantBubbles}`,
  );
  assert(
    'F. 截断流不被误判为硬错误（无 console.error / copilotStreaming 复位）',
    truncErrors.length === 0 && afterTrunc.copilotStreaming === false,
    `errors=${truncErrors.length} copilotStreaming=${afterTrunc.copilotStreaming}`,
  );

  /* 截图证据 */
  const truncShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  mkdirSync(OUT_DIR, { recursive: true });
  if (typeof truncShot.result?.data === 'string') {
    writeFileSync(join(OUT_DIR, `incomplete-truncated-${BROWSER}-1366x768.png`), Buffer.from(truncShot.result.data, 'base64'));
  }

  const failed = results.filter((r) => !r.pass);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, `r2b-request-race-${BROWSER}.json`),
    `${JSON.stringify({ at: new Date().toISOString(), base: BASE, results, passed: results.length - failed.length, failed: failed.length }, null, 2)}\n`,
    'utf8',
  );

  console.log(`\n竞态矩阵: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length === 0) {
    console.log('✓ 竞态矩阵全绿（无卸载后更新 / 无重复气泡 / 排队语义正确）');
  } else {
    console.log(`✗ ${failed.length} 项未通过`);
  }

  cdp.close();
  browser.kill('SIGKILL');
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error('[probe-request-race] 探针错误:', error);
  try {
    cdp.close();
    browser.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  process.exit(2);
}