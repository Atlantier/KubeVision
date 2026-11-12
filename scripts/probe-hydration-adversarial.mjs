#!/usr/bin/env node
/**
 * KubeVision AI — 水合对抗探针（scripts/probe-hydration-adversarial.mjs · R3 进阶）
 *
 * 【验证什么】R3 main 把 DemoDebugPanel 的 render 体 Date.now() 移进 Effect 后，
 * 客户端时钟/语言/时区与服务端不一致时，刷新 20 次不得出现 hydration 文本不一致。
 *
 * 【对抗手段】
 * - Emulation.setTimezoneOverride：切换 IANA 时区（影响 Date 展示与 Intl）；
 * - Emulation.setLocaleOverride：切换 locale（影响 navigator.language / Intl）；
 * - Page.addScriptToEvaluateOnNewDocument：在页面脚本前偏移 Date（模拟客户端时钟快/慢），
 *   并覆写 navigator.language（部分浏览器 setLocaleOverride 不改 navigator）。
 *
 * 【判定】每次刷新后采集 console，hydration / did-not-match / server-HTML 类警告必须为 0。
 * 20 次组合循环全绿才算通过；任何一次出现水合警告即非零退出并打印原文。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9382');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (EDGE === undefined) {
  console.error('未找到 Edge');
  process.exit(2);
}

const browser = spawn(
  EDGE,
  [
    '--headless=new', '--no-first-run', '--window-size=1680,1000',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-hydadv-${Date.now()}`)}`,
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
let consoleMsgs = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push({ type: msg.params.type, text: (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleMsgs.push({ type: 'exception', text: msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text });
  }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

const TIMEZONES = ['Asia/Shanghai', 'America/New_York', 'Europe/London', 'UTC'];
const LOCALES = ['zh-CN', 'en-US', 'ja-JP'];
const CLOCK_OFFSETS = [0, 300000, -120000]; // 客户端时钟：正常 / 快 5 分钟 / 慢 2 分钟
const RUNS = 20;

const hydrationOf = (msgs) => msgs.filter((m) => /hydrat|did not match|didn't match|server HTML|text content does not match|prop.*did not match/i.test(m.text));

console.log('KubeVision AI — 水合对抗探针（R3 进阶）');
console.log(`  目标: ${BASE_URL} · ${RUNS} 次刷新\n`);

let scriptId = null;
const rows = [];
let failures = 0;

for (let run = 0; run < RUNS; run += 1) {
  const tz = TIMEZONES[run % TIMEZONES.length];
  const locale = LOCALES[run % LOCALES.length];
  const offset = CLOCK_OFFSETS[run % CLOCK_OFFSETS.length];

  await send('Emulation.setTimezoneOverride', { timezoneId: tz });
  await send('Emulation.setLocaleOverride', { locale });

  /* 时钟偏移 + navigator.language 覆写（在页面脚本执行前注入） */
  if (scriptId !== null) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
  const inject = `(() => {
    const OFFSET = ${offset};
    const RealDate = Date;
    const OrigNow = RealDate.now.bind(RealDate);
    class SkewDate extends RealDate {
      constructor(...args) { if (args.length === 0) { super(OrigNow() + OFFSET); } else { super(...args); } }
      static now() { return OrigNow() + OFFSET; }
    }
    window.Date = SkewDate;
    try { Object.defineProperty(navigator, 'language', { get: () => '${locale}', configurable: true }); } catch {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['${locale}'], configurable: true }); } catch {}
  })();`;
  const added = await send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
  scriptId = added.result?.identifier ?? null;

  consoleMsgs = [];
  /* 交替普通页与 demoDebug 页（后者挂载 R3 修复的 DemoDebugPanel） */
  const url = run % 2 === 0 ? `${BASE_URL}/` : `${BASE_URL}/?demoDebug=1`;
  await send('Page.navigate', { url });
  for (let i = 0; i < 240; i += 1) { if ((await ev('document.querySelector("canvas") !== null')) === true) break; await sleep(300); }
  await sleep(4500);

  const hyd = hydrationOf(consoleMsgs);
  const errs = consoleMsgs.filter((m) => m.type === 'error' || m.type === 'exception');
  const okRun = hyd.length === 0;
  if (!okRun) failures += 1;
  rows.push({ run: run + 1, tz, locale, offset, hydration: hyd.length, errors: errs.length, ok: okRun });
  console.log(`  ${okRun ? '✓' : '✗'} #${String(run + 1).padStart(2)} tz=${tz.padEnd(16)} locale=${locale.padEnd(6)} clock=${String(offset).padStart(7)}ms · 水合警告=${hyd.length} · error=${errs.length}`);
  if (!okRun) for (const h of hyd.slice(0, 3)) console.log(`      HYDRATION: ${h.text.slice(0, 240)}`);
}

console.log(`\n汇总: ${RUNS} 次刷新 · 水合不一致 ${failures} 次 · ${failures === 0 ? '全绿' : '存在失败'}`);
ws.close();
cleanup();
process.exit(failures === 0 ? 0 : 1);