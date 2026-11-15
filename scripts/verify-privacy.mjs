#!/usr/bin/env node
/**
 * KubeVision AI — 原始凭证零出域证明（scripts/verify-privacy.mjs）
 *
 * 【证明什么】
 * 端侧审计全流程中，浏览器发出的**每一个** HTTP 请求体里都不包含预置的
 * "凭证金丝雀"字符串：
 *   - AWS AccessKey：AKIAIOSFODNN7EXAMPLE
 *   - URL 内嵌凭证：postgres://admin:S3cr3t!@db.internal:5432/payments
 *   - 邮箱 PII：oncall@kubevision.io
 *   - 内网 IP：10.244.3.17
 *   - Bearer Token：Bearer canary-token-9f3a
 *
 * 【怎么证明】
 * 1. CDP `Network` 域抓取全部出站请求（URL / headers / postData，postData 上限 10MB）；
 * 2. 把金丝雀日志注入端侧审计面板并执行"脱敏 + 语义分类"（全程本地）；
 * 3. 抓一批集群日志生成审计记录，再点击「移交 Copilot」——这是唯一可能外发的路径；
 * 4. 对全部抓包做金丝雀扫描，并检查本地审计阶段是否零对话外发。
 *
 * 【输出】docs/privacy-egress.md（R21 证据页素材）。
 *
 * 【用法】node scripts/verify-privacy.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9366');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, detail) => {
  pass += 1;
  console.log('  ✓ ' + name + (detail ? '  ::  ' + detail : ''));
};
const bad = (name, actual, why) => {
  fail += 1;
  console.log('  ✗ ' + name + '  ::  ' + why + '  实际=' + JSON.stringify(actual));
};

const CANARIES = [
  'AKIAIOSFODNN7EXAMPLE',
  'S3cr3t!',
  'postgres://admin:',
  'oncall@kubevision.io',
  '10.244.3.17',
  'canary-token-9f3a',
  'db.internal',
];

const CANARY_LOG =
  '2026-11-10 ERROR db connect postgres://admin:S3cr3t!@db.internal:5432/payments failed; ' +
  'aws_access_key_id=AKIAIOSFODNN7EXAMPLE; contact oncall@kubevision.io from 10.244.3.17; ' +
  'Authorization: Bearer canary-token-9f3a';

try {
  const healthRes = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(4000) });
  if (!healthRes.ok) {
    console.error(`[verify-privacy] 预检失败：${BASE_URL}/api/health 返回 HTTP ${healthRes.status}，请先启动服务后再运行本脚本。`);
    process.exit(2);
  }
} catch (err) {
  console.error(`[verify-privacy] 预检失败：无法连接 ${BASE_URL}/api/health (${err instanceof Error ? err.message : String(err)})，拒绝生成残缺的 docs/privacy-egress.md。`);
  process.exit(2);
}

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
    '--headless=new',
    '--no-first-run',
    '--window-size=1680,1000',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + join(process.env.TEMP ?? '/tmp', 'kv-privacy-' + Date.now()),
    'about:blank',
  ],
  { stdio: 'ignore' },
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
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list', { signal: AbortSignal.timeout(3000) })).json();
    target = list.find((t) => t.type === 'page') ?? null;
    if (target !== null) break;
  } catch {
    /* 等浏览器 */
  }
  await sleep(500);
}
if (target === null) {
  console.error('CDP 未就绪');
  cleanup();
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
const captured = [];
let captureEnabled = false;

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (captureEnabled && msg.method === 'Network.requestWillBeSent') {
    const req = msg.params.request;
    captured.push({
      url: String(req.url ?? ''),
      method: String(req.method ?? ''),
      headers: req.headers ?? {},
      postData: typeof req.postData === 'string' ? req.postData : null,
    });
  }
};

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) {
    return { __err: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text) };
  }
  return res.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable', { maxPostDataSize: 10 * 1024 * 1024 });
captureEnabled = true;

await send('Page.navigate', { url: BASE_URL });
for (let i = 0; i < 240; i += 1) {
  if ((await evaluate('document.querySelector("canvas") !== null')) === true) break;
  await sleep(400);
}
await sleep(9000);

console.log('KubeVision AI — 原始凭证零出域证明');
console.log('  目标: ' + BASE_URL + '\n');

/* ---- 1. 打开审计台 ---- */
await evaluate(`(() => {
  const store = window.__KUBEVISION_STORE__;
  if (typeof store.getState().setActiveRightTab === 'function') store.getState().setActiveRightTab('auditor');
  return true;
})()`);
await sleep(5000);

/* ---- 2. 注入金丝雀日志并跑本地脱敏 + 分类 ---- */
const injected = await evaluate(`(() => {
  const textarea = document.querySelector('textarea[aria-label="粘贴待测试的原始日志（含敏感信息）"]');
  if (textarea === null) return { ok: false, reason: 'textarea missing' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, ${JSON.stringify(CANARY_LOG)});
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  const button = document.querySelector('button[aria-label="在端侧执行脱敏与语义分类推理测试"]');
  if (button === null) return { ok: false, reason: 'run button missing' };
  button.click();
  return { ok: true };
})()`);
if (injected?.ok === true) ok('金丝雀日志已注入并触发端侧脱敏 + 分类');
else bad('金丝雀日志已注入并触发端侧脱敏 + 分类', injected, '注入失败');
await sleep(7000);

/* 本地审计阶段：不应出现任何 /api/chat 请求 */
const chatDuringLocal = captured.filter((r) => r.url.includes('/api/chat')).length;
if (chatDuringLocal === 0) ok('端侧脱敏 + 分类阶段零对话外发');
else bad('端侧脱敏 + 分类阶段零对话外发', { chatDuringLocal }, '本地审计阶段出现了 /api/chat 请求');

/* 读取现场推理结果，确认脱敏占位符已经出现在页面上 */
const probeText = await evaluate(`(() => {
  const probe = document.querySelector('[aria-label="现场推理测试结果"]');
  return probe === null ? null : probe.innerText.slice(0, 800);
})()`);
const probeHasPlaceholder =
  typeof probeText === 'string' && /\[(?:REDACTED|MASKED)_[A-Z_]+\]/.test(probeText);
if (probeHasPlaceholder === true) ok('页面展示的推理输入已含脱敏占位符');
else bad('页面展示的推理输入已含脱敏占位符', probeText === null ? null : probeText.slice(0, 160), '未找到占位符');

/* ---- 3. 抓一批真实日志 → 生成审计记录 → 移交 Copilot ---- */
/*
 * 【为什么先注入混沌】移交按钮只出现在高危记录（CRITICAL_PANIC /
 * RESOURCE_EXHAUSTED）上；合成日志由当前快照生成，必须让快照里真的有
 * 崩溃 Pod，才会产出高危记录，进而出现"移交 Copilot"路径。
 */
await evaluate('window.__KUBEVISION_STORE__.getState().setActiveChaos("POD_OOM_SWARM"); true');
await sleep(4000);

const audited = await evaluate(`(() => {
  const button = document.querySelector('button[aria-label="抓取并审计当前集群容器日志流"]');
  if (button === null) return { ok: false, reason: 'fetch-audit button missing' };
  button.click();
  return { ok: true };
})()`);
console.log('  抓取并审计集群日志: ' + JSON.stringify(audited));
await sleep(12000);

/* 兜底：合成日志仍无高危时，再拉一次实时运行日志 */
const highRiskProbe = await evaluate(`(() => {
  const list = document.querySelector('[aria-label="审计结果列表"]');
  const text = list === null ? '' : list.innerText;
  return { hasHighRisk: /RESOURCE_EXHAUSTED|CRITICAL_PANIC/.test(text) };
})()`);
if (highRiskProbe?.hasHighRisk !== true) {
  await evaluate('(() => { const b = document.querySelector(\'button[aria-label="拉取服务端实时运行日志并端侧审计"]\'); if (b) b.click(); return true; })()');
  await sleep(6000);
}

let escalated = await evaluate(`(() => {
  const recordEscalate = document.querySelector('button[aria-label="仅将脱敏安全摘要移交 Copilot 深度诊断"]');
  if (recordEscalate !== null) { recordEscalate.click(); return { ok: true, via: 'record' }; }
  const reportEscalate = document.querySelector('button[aria-label="将脱敏异常摘要移交 Copilot 排障"]');
  if (reportEscalate !== null) { reportEscalate.click(); return { ok: true, via: 'report' }; }
  return { ok: false, reason: 'escalate button missing' };
})()`);

/* 记录可能延后渲染：再等 5 秒重试一次 */
if (escalated?.ok !== true) {
  await sleep(5000);
  escalated = await evaluate(`(() => {
    const recordEscalate = document.querySelector('button[aria-label="仅将脱敏安全摘要移交 Copilot 深度诊断"]');
    if (recordEscalate !== null) { recordEscalate.click(); return { ok: true, via: 'record-retry' }; }
    const reportEscalate = document.querySelector('button[aria-label="将脱敏异常摘要移交 Copilot 排障"]');
    if (reportEscalate !== null) { reportEscalate.click(); return { ok: true, via: 'report-retry' }; }
    return { ok: false, reason: 'escalate button still missing' };
  })()`);
}
console.log('  移交 Copilot: ' + JSON.stringify(escalated));
await sleep(8000);

/* ---- 4. 扫描全部出站请求 ---- */
const apiRequests = captured.filter((r) => r.url.includes('/api/'));
const chatRequests = captured.filter((r) => r.url.includes('/api/chat'));
const poster = captured.filter((r) => r.method === 'POST');

const flatten = (r) => [r.url, r.method, JSON.stringify(r.headers ?? {}), r.postData ?? ''].join('\n');
const leaks = [];
for (const request of captured) {
  const haystack = flatten(request);
  for (const canary of CANARIES) {
    if (haystack.includes(canary)) leaks.push({ url: request.url, method: request.method, canary });
  }
}

console.log('\n  抓包总数: ' + captured.length + ' · /api: ' + apiRequests.length + ' · /api/chat: ' + chatRequests.length + ' · POST: ' + poster.length);
console.log('  金丝雀命中: ' + leaks.length);

if (chatRequests.length > 0) ok('抓到真实外发请求（/api/chat 移交链路）', chatRequests.length + ' 条');
else bad('抓到真实外发请求', { chat: 0 }, '未观察到 /api/chat 请求，证据不成立');

if (leaks.length === 0) ok('所有出站请求均不含凭证金丝雀', captured.length + ' 条请求 × ' + CANARIES.length + ' 个金丝雀');
else bad('所有出站请求均不含凭证金丝雀', leaks.slice(0, 5), '发现原始凭证外泄');

/* ---- 5. 报告 ---- */
const lines = [];
lines.push('# 原始凭证零出域证明（Privacy Egress Report）');
lines.push('');
lines.push('> 由 `node scripts/verify-privacy.mjs` 自动生成于 ' + new Date().toISOString() + '。');
lines.push('> 目标：' + BASE_URL + '。');
lines.push('');
lines.push('## 方法');
lines.push('');
lines.push('1. 用 CDP `Network` 域抓取页面全部出站请求（URL / headers / postData，postData 上限 10MB）；');
lines.push('2. 向端侧审计面板注入一条包含 5 类凭证金丝雀的原始日志；');
lines.push('3. 执行端侧脱敏 + 语义分类（全程本地）；');
lines.push('4. 抓取一批集群日志生成审计记录，点击「移交 Copilot」——这是整个流程中唯一可能外发数据的路径；');
lines.push('5. 对全部抓包做金丝雀字符串扫描。');
lines.push('');
lines.push('## 金丝雀清单');
lines.push('');
lines.push('| # | 金丝雀 | 类型 |');
lines.push('|---|---|---|');
const kinds = ['AWS AccessKey', 'URL 内嵌密码', 'URL 用户名', '邮箱 PII', '内网 IP', 'Bearer Token', '内部主机名'];
CANARIES.forEach((canary, index) => {
  lines.push('| ' + (index + 1) + ' | `' + canary + '` | ' + (kinds[index] ?? '其他') + ' |');
});
lines.push('');
lines.push('## 结果');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('|---|---|');
lines.push('| 抓包总数 | ' + captured.length + ' |');
lines.push('| /api 请求数 | ' + apiRequests.length + ' |');
lines.push('| /api/chat 请求数 | ' + chatRequests.length + ' |');
lines.push('| POST 请求数 | ' + poster.length + ' |');
lines.push('| 本地审计阶段 /api/chat | ' + chatDuringLocal + ' |');
lines.push('| 金丝雀命中数 | ' + leaks.length + ' |');
lines.push('');
lines.push('**结论：' + (leaks.length === 0 ? '未观察到任何原始凭证进入出站请求。' : '发现凭证外泄（详见失败明细）。') + '**');
lines.push('');
lines.push('## 外发请求清单（/api/**）');
lines.push('');
lines.push('| 方法 | URL | 请求体大小 |');
lines.push('|---|---|---|');
for (const r of captured.filter((r) => r.url.includes('/api/')).slice(0, 40)) {
  lines.push('| ' + r.method + ' | `' + r.url.replace(BASE_URL, '') + '` | ' + (r.postData === null ? '—' : r.postData.length + ' B') + ' |');
}
lines.push('');
lines.push('## 边界与诚实声明');
lines.push('');
lines.push('- 本报告只证明**本次观测到的请求**不含金丝雀；它不能证明未来代码变更不会引入外泄，因此该脚本应进入回归集；');
lines.push('- Header 抓包是请求头快照（CDP 提供），浏览器自动附加的 `cookie` 等头也在扫描范围内；');
lines.push('- 端侧分类若走 WebGPU，模型权重来自远程下载（一次性、非凭证数据），不在本次金丝雀范围内。');
lines.push('');

if (fail === 0 && chatRequests.length > 0) {
  writeFileSync(join(process.cwd(), 'docs/privacy-egress.md'), lines.join('\n'), 'utf8');
  console.log('\n  报告已写入 docs/privacy-egress.md');
} else {
  console.warn(
    '\n  [warn] 未满足零失败（fail=' + fail + '）且含真实对话抓包（chatRequests=' + chatRequests.length + '）条件，保留既有 docs/privacy-egress.md 不覆写。',
  );
}

console.log('\n汇总: 通过 ' + pass + ' · 失败 ' + fail);
captureEnabled = false;
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);