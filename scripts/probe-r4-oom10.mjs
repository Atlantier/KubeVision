#!/usr/bin/env node
/**
 * KubeVision AI — R4 剧本终态一致性探针（scripts/probe-r4-oom10.mjs）
 *
 * 【验证什么（R4 Main 验收）】连跑 10 次 OOM 全链路剧本，终态必须全部
 * 「闭环校验通过」——阶段不重入的直接证据：旧实现里事件门与到点定时器
 * 竞态会让阶段 4 跑两遍，第二遍的「自愈未验证」覆盖「闭环校验通过」。
 *
 * 【判定口径】
 * · 每轮以 terminalLogs 新增「[DEMO-DIRECTOR] 阶段 4/4 · 闭环校验通过」为准；
 * · 本轮日志中不得出现「自愈未验证」（防御分支仍在，只是不该被触发）；
 * · 收集 console.warn「拦截阶段重入」次数——守卫生效的证据（允许 >0，
 *   说明竞态真实存在且被拦截；终态仍须全绿）。
 *
 * 【节奏】每轮启动后切「紧凑」（约 20s 剧本），10 轮总时长约 6~8 分钟。
 * 【前置】dev server 已运行（pnpm dev）。
 * 【退出码】0 = 10/10；1 = 有失败；2 = 环境不可用
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9385');
const RUNS = Number(process.env.KV_OOM_RUNS ?? '10');
const PER_RUN_TIMEOUT_MS = 150000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (e) {
  console.error(`[FATAL] ${BASE_URL} 不可达（先 pnpm dev）: ${e.message}`);
  process.exit(2);
}

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (EDGE === undefined) { console.error('未找到 Edge'); process.exit(2); }

const browser = spawn(
  EDGE,
  [
    '--headless=new', '--no-first-run', '--window-size=1680,1000',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-r4oom-${Date.now()}`)}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } };
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    target = list.find((t) => t.type === 'page') ?? null;
    if (target !== null) break;
  } catch { /* 等浏览器 */ }
  await sleep(500);
}
if (target === null) { console.error('CDP 未就绪'); cleanup(); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
let reentryWarns = 0;
const consoleErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (msg.params.type === 'warning' && text.includes('拦截阶段重入')) reentryWarns += 1;
    if (msg.params.type === 'error') consoleErrors.push(text);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text));
  }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text) };
  return res.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: BASE_URL });
let ready = false;
for (let i = 0; i < 300; i += 1) {
  ready = (await ev('!!(window.__KUBEVISION_STORE__ && window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.length > 0)')) === true;
  if (ready) break;
  await sleep(300);
}
if (!ready) { console.error('store 90s 未就绪:', consoleErrors.slice(0, 5)); cleanup(); process.exit(2); }
await ev(`window.__KUBEVISION_STORE__.getState().setConnectionMode('demo')`);
await sleep(2000);

console.log('KubeVision AI — R4 OOM 剧本终态一致性（连跑 10 次）');
console.log(`  目标: ${BASE_URL} · 每轮超时 ${PER_RUN_TIMEOUT_MS / 1000}s\n`);

const START_AND_COMPACT = `(async () => {
  const b = Array.from(document.querySelectorAll('button')).find((x) =>
    (x.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'));
  if (!b) return { error: 'start button missing' };
  b.click();
  await new Promise((r) => setTimeout(r, 800));
  const item = Array.from(document.querySelectorAll('[role="menu"][aria-label="选择路演剧本"] button'))
    .find((x) => (x.textContent || '').includes('OOM 全链路自愈'));
  if (!item) return { error: 'menu item missing' };
  item.click();
  await new Promise((r) => setTimeout(r, 600));
  const pacing = Array.from(document.querySelectorAll('button')).find((x) =>
    (x.getAttribute('aria-label') || '').startsWith('切换为紧凑'));
  if (pacing) pacing.click();
  return { ok: true, pacingClicked: !!pacing };
})()`;

const results = [];
for (let run = 1; run <= RUNS; run += 1) {
  /*
   * 【等待上一轮收尾】闭环日志出现后还有 4.2s 稳态展示 + finished 态 8s 自动收起，
   * 期间「启动」按钮不存在。必须等导演回到 idle（按钮重新出现）再开下一轮。
   */
  let buttonBack = false;
  for (let i = 0; i < 60; i += 1) {
    const has = await ev(`Array.from(document.querySelectorAll('button')).some((x) =>
      (x.getAttribute('aria-label') || '').startsWith('启动全自动剧本路演'))`);
    if (has === true) { buttonBack = true; break; }
    await sleep(500);
  }
  if (!buttonBack) {
    results.push({ run, verdict: 'START_FAIL', detail: 'start button not back after 30s' });
    console.log(`  ✗ 第 ${run} 轮：启动按钮 30s 未恢复（上一轮未收尾）`);
    continue;
  }

  /*
   * 【判定基准：末条闭环日志的身份，而非计数】terminalLogs 是 200 行 FIFO，
   * 连跑多轮后旧闭环行会被挤出——计数可能不增甚至减少。
   * 每行带 HH:MM:SS 时间戳，比较「最后一条闭环行是否换了一条」才稳定。
   */
  const baseline = await ev(`(() => {
    const logs = window.__KUBEVISION_STORE__.getState().terminalLogs;
    const passLines = logs.filter((l) => l.includes('闭环校验通过'));
    const unverifiedLines = logs.filter((l) => l.includes('自愈未验证'));
    return {
      lastPass: passLines[passLines.length - 1] ?? null,
      lastUnverified: unverifiedLines[unverifiedLines.length - 1] ?? null,
    };
  })()`);
  const started = await ev(START_AND_COMPACT);
  if (started?.ok !== true) {
    results.push({ run, verdict: 'START_FAIL', detail: started });
    console.log(`  ✗ 第 ${run} 轮启动失败: ${JSON.stringify(started)}`);
    continue;
  }

  const t0 = Date.now();
  let outcome = null;
  while (Date.now() - t0 < PER_RUN_TIMEOUT_MS) {
    await sleep(1000);
    const st = await ev(`(() => {
      const logs = window.__KUBEVISION_STORE__.getState().terminalLogs;
      const dbg = window.__demoDirectorDebug__;
      const passLines = logs.filter((l) => l.includes('闭环校验通过'));
      const unverifiedLines = logs.filter((l) => l.includes('自愈未验证'));
      return {
        lastPass: passLines[passLines.length - 1] ?? null,
        lastUnverified: unverifiedLines[unverifiedLines.length - 1] ?? null,
        status: dbg ? dbg.status : null,
        phase: dbg ? dbg.phaseIndex : null,
      };
    })()`);
    if (st?.__err !== undefined) continue;
    if (st.lastPass !== null && st.lastPass !== baseline.lastPass) {
      outcome = { ...st, elapsedSec: Math.round((Date.now() - t0) / 1000) };
      break;
    }
    /* 未验证终态出现且剧本已收尾 → 本轮失败（不必等超时） */
    if (st.lastUnverified !== null && st.lastUnverified !== baseline.lastUnverified && (st.status === 'finished' || st.status === 'idle')) {
      outcome = { ...st, failed: true, elapsedSec: Math.round((Date.now() - t0) / 1000) };
      break;
    }
  }

  if (outcome === null) {
    results.push({ run, verdict: 'TIMEOUT' });
    console.log(`  ✗ 第 ${run} 轮超时（${PER_RUN_TIMEOUT_MS / 1000}s 未见闭环校验通过）`);
  } else if (outcome.failed === true) {
    results.push({ run, verdict: 'UNVERIFIED', detail: outcome });
    console.log(`  ✗ 第 ${run} 轮终态「自愈未验证」: ${JSON.stringify(outcome)}`);
  } else {
    results.push({ run, verdict: 'PASS', detail: outcome });
    console.log(`  ✓ 第 ${run} 轮 闭环校验通过（${outcome.elapsedSec}s）:: ${outcome.lastPass}`);
  }

  /* 等收尾稳态展示结束再进下一轮（startDemoDirector 内部也会先 stop('switch')） */
  await sleep(2500);
}

const passed = results.filter((r) => r.verdict === 'PASS').length;
console.log(`\n══════ 汇总 ══════`);
console.log(`  终态「闭环校验通过」: ${passed}/${RUNS}`);
console.log(`  阶段重入守卫拦截次数（console.warn）: ${reentryWarns}（>0 说明竞态被守卫拦下，终态仍须全绿）`);
const realErrors = consoleErrors.filter((e) => !/SwiftShader|swiftshader|GPU|WebGL/i.test(e));
console.log(`  运行时错误: ${realErrors.length}`);
if (realErrors.length > 0) console.log('  ', realErrors.slice(0, 5));

ws.close();
cleanup();
process.exit(passed === RUNS && realErrors.length === 0 ? 0 : 1);