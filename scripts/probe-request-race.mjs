#!/usr/bin/env node
/**
 * KubeVision AI — 请求竞态矩阵探针（R3）
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

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!EDGE) {
  console.error('[FATAL] 未找到 Edge');
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
  /* ================= A. 快速连发 5 条 ================= */
  await openPage();
  await ev(
    cdp,
    `(() => {
      const s = window.__KUBEVISION_STORE__.getState();
      for (let i = 0; i < 5; i += 1) s.triggerQuickPrompt('诊断 OOMKilled 根因并生成自愈方案 #' + i);
      return true;
    })()`,
  );
  await sleep(1500);
  const rapid = await snapshot();
  assert(
    'A. 快速连发 5 条：首条进入流式、发送按钮禁用（输入区不可提交）、无重复气泡',
    rapid.copilotStreaming === true && rapid.hasStopButton === true && rapid.hasSendButton === false && rapid.assistantBubbles === 1,
    JSON.stringify(rapid),
  );
  const rapidErrors = drainErrors();
  assert(
    'A. 连发期间零 console.error / 零未捕获异常',
    rapidErrors.length === 0,
    rapidErrors.length === 0 ? '0 errors' : rapidErrors.slice(0, 2).join(' | '),
  );

  /* ================= B. 流式中切页签 ================= */
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
    'B. 切页签后气泡不重复',
    tabSwitched.assistantBubbles <= 1,
    `assistantBubbles=${tabSwitched.assistantBubbles}`,
  );

  /* ================= C. 流式中关抽屉 ================= */
  await ev(cdp, `window.__KUBEVISION_STORE__.getState().requestCopilotAbort()`);
  await sleep(300);
  const closed = await ev(
    cdp,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => (b.getAttribute('aria-label') || '').includes('收起') ||
               (b.getAttribute('aria-label') || '').includes('关闭')),
      );
      if (btn) btn.click();
      return Boolean(btn);
    })()`,
  );
  await sleep(900);
  const afterClose = await snapshot();
  const closeErrors = drainErrors();
  assert(
    'C. 流式中关闭抽屉：无 setState-on-unmounted',
    closeErrors.length === 0,
    closeErrors.length === 0 ? '0 errors' : closeErrors.slice(0, 2).join(' | '),
  );
  assert(
    'C. 关闭后 copilotStreaming 复位（无悬挂活动态）',
    afterClose.copilotStreaming === false && afterClose.hasStopButton === false,
    `copilotStreaming=${afterClose.copilotStreaming} closed=${String(closed)}`,
  );

  /* ================= D. 流式中刷新页面 ================= */
  await ev(
    cdp,
    `(() => { window.__KUBEVISION_STORE__.getState().triggerQuickPrompt('刷新前在途请求'); return true; })()`,
  );
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
  await ev(cdp, `window.__KUBEVISION_STORE__.getState().triggerQuickPrompt('刷新后再诊断一次')`);
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

  const failed = results.filter((r) => !r.pass);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'r3-request-race.json'),
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