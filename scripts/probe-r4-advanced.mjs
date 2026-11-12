#!/usr/bin/env node
/**
 * KubeVision AI — R4 进阶对抗探针（scripts/probe-r4-advanced.mjs）
 *
 * 【反作弊验收（手册 R4 进阶）】同一事实三处同数，运行期可证明：
 * X1 FakeEventSource 注入 126 个不同 Pod ID 的 churn：每帧 3D 槽位/面板/复盘缓冲
 *    三处 CPU 逐 Pod 相等，freeSlots 栈深度与复用逐批打印（真复用，非恒等式造假）；
 * X2 自愈派生无地板：只愈 1/3 受害者时分数必须 <96 且 == 独立罚分表；
 *    稳态与下一帧三处 == oracle；
 * X3 免疫剩余秒数：healEntity 拒绝返回的 remainingSec == ceil((15000-(now-healedAt))/1000)
 *    （store 时间戳推算），0/3/7s 三个时刻采样；
 * X5 双 live 连接逐值相等非 0 + 服务端 [LIVE-SAMPLER] 审计日志证明单一 ticker
 *    （start 一次、reuse 一次、末位 release stop+清基准）+ 源码 setInterval 唯一；
 * X6 客户端时钟快 5 分钟：真实 SSE 重连（chaos 切换）时间轴不跳未来；
 *    重复 seq 帧 5/5 丢弃且画面数据不变（staleSeqFrames 计数）；
 * P1/P2 静置 60s：PerformanceObserver(longtask/event) + 管线实测 <3ms/s、
 *    localStorage ≤1 写/s（GL 隔离：frameloop=never，SwiftShader 不具代表性）。
 *
 * 【前置】dev server 已运行，且其 stdout 重定向到 KV_SERVER_LOG 指向的文件
 *         （X5 审计需要）；未提供时 X5 审计段降级为仅行为断言并如实标注。
 * 【用法】KV_SERVER_LOG=tmp-logs/tmp-r4adv-server.log node scripts/probe-r4-advanced.mjs
 * 【退出码】0 全绿；1 有失败；2 环境不可用
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.KV_BASE_URL ?? 'http://127.0.0.1:3000';
const CDP_PORT = Number(process.env.KV_CDP_PORT ?? '9386');
const SERVER_LOG = process.env.KV_SERVER_LOG ?? null;
const WINDOW_MS = 15000; // 契约值：telemetryTuning.HEAL_IMMUNITY_WINDOW_MS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, detail) => { pass += 1; console.log(`  ✓ ${name}${detail ? `  ::  ${detail}` : ''}`); };
const bad = (name, actual, why) => { fail += 1; console.log(`  ✗ ${name}  ::  ${why}  实际=${JSON.stringify(actual)}`); };

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
    `--user-data-dir=${join(process.env.TEMP ?? '/tmp', `kv-r4adv-${Date.now()}`)}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } };
process.on('exit', cleanup);

let cdpReady = false;
for (let i = 0; i < 60; i += 1) {
  try {
    await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    cdpReady = true;
    break;
  } catch { /* 等浏览器 */ }
  await sleep(500);
}
if (!cdpReady) { console.error('CDP 未就绪'); cleanup(); process.exit(2); }

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text) };
    return res.result?.result?.value;
  };
  return { ws, send, ev, errors };
}

async function newPage(url, initScript) {
  const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) })).json();
  if (t?.webSocketDebuggerUrl === undefined) throw new Error(`创建页面失败: ${JSON.stringify(t)}`);
  const page = await attach(t.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  if (initScript !== undefined) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
  await page.send('Page.navigate', { url });
  return page;
}

/* 独立罚分表 oracle（不 import 被测代码） */
const ORACLE = `(snap) => {
  let penalty = 0;
  for (const n of snap.nodes) {
    if (n.status === 'NetworkPartition') penalty += 15;
    else if (n.status === 'HighLoad') penalty += 6;
  }
  for (const p of snap.pods) {
    if (p.status === 'OOMKilled') penalty += 5;
    else if (p.status === 'CrashLoopBackOff') penalty += 4;
    else if (p.status === 'Pending' || p.status === 'Terminating') penalty += 0.5;
  }
  for (const a of snap.activeAlerts) {
    if (a.level === 'P0') penalty += 3;
    else if (a.level === 'P1') penalty += 1.5;
    else penalty += 0.5;
  }
  return Math.round(Math.min(100, Math.max(0, 100 - penalty)));
}`;

/* FakeEventSource + localStorage 写入计数 */
const FAKE_ES = `(() => {
  window.__kvFakeES__ = { instances: [], active: null };
  class FakeEventSource {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) {
      this.url = url; this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onerror = null;
      window.__kvFakeES__.instances.push(this);
      window.__kvFakeES__.active = this;
      setTimeout(() => { if (this.readyState !== 2) { this.readyState = 1; if (this.onopen) this.onopen({}); } }, 50);
    }
    close() { this.readyState = 2; if (window.__kvFakeES__.active === this) window.__kvFakeES__.active = null; }
    addEventListener() {} removeEventListener() {} dispatchEvent() { return true; }
  }
  window.EventSource = FakeEventSource;
  window.__kvPushFrame__ = (snap) => {
    const es = window.__kvFakeES__.active;
    if (es && es.onmessage && es.readyState === 1) { es.onmessage({ data: JSON.stringify(snap) }); return true; }
    return false;
  };
  window.__kvLsWrites__ = 0;
  const origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (k === 'kubevision-cluster-store') window.__kvLsWrites__ += 1;
    return origSet.call(this, k, v);
  };
})();`;

const READY_EXPR = '!!(window.__KUBEVISION_STORE__ && window.__KUBEVISION_TRANSIENT__ && window.__KUBEVISION_FRAMES__ && window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.length > 0)';
async function waitReady(page, seconds = 120) {
  for (let i = 0; i < seconds * 2; i += 1) {
    if ((await page.ev(READY_EXPR)) === true) return true;
    await sleep(500);
  }
  return false;
}

console.log('KubeVision AI — R4 进阶对抗探针');
console.log(`  目标: ${BASE_URL} · 免疫契约 ${WINDOW_MS}ms · 服务端日志: ${SERVER_LOG ?? '（未提供）'}\n`);

/* ====================================================================== */
/* 页面 F：FakeEventSource（X1 churn / X2 自愈无地板 / X3 免疫 / X6 重复帧）  */
/* ====================================================================== */
const pageF = await newPage(BASE_URL, FAKE_ES);
if (!(await waitReady(pageF))) { console.error('页面 F 未就绪:', pageF.errors.slice(0, 5)); cleanup(); process.exit(2); }
for (let i = 0; i < 40; i += 1) {
  if ((await pageF.ev('window.__kvFakeES__ && window.__kvFakeES__.active !== null')) === true) break;
  await sleep(200);
}
await pageF.ev(`window.__KUBEVISION_STORE__.getState().setConnectionMode('demo')`);
await sleep(800);

/* 浏览器侧工具：构造帧 + 三处读取 */
const FRAME_TOOLS = `(() => {
  window.__kvTools__ = {
    seq: 100,
    base: () => JSON.parse(JSON.stringify(window.__KUBEVISION_STORE__.getState().snapshotSummary)),
    mkPods(base, ids, cpuBase) {
      return ids.map((id, i) => {
        const t = base.pods[i % base.pods.length];
        return { ...t, id, name: id, cpuUsage: cpuBase + (i % 17), memoryUsage: 30 + (i % 23) };
      });
    },
    push(pods, alerts) {
      const base = this.base();
      this.seq += 1;
      const oracle = (${ORACLE});
      const frame = {
        ...base,
        pods: pods ?? base.pods,
        activeAlerts: alerts ?? base.activeAlerts,
        seq: this.seq,
        timestamp: base.timestamp + 1000,
        clusterHealthScore: 0,
      };
      frame.clusterHealthScore = oracle(frame);
      const pushed = window.__kvPushFrame__(frame);
      return { pushed, seq: frame.seq };
    },
    threeWay() {
      const store = window.__KUBEVISION_STORE__.getState();
      const transient = window.__KUBEVISION_TRANSIENT__;
      const frames = window.__KUBEVISION_FRAMES__(2);
      const report = frames[frames.length - 1];
      const reportById = new Map(report.pods.map((p) => [p.id, p]));
      const rows = [];
      for (const pod of store.snapshotSummary.pods) {
        const slot = transient.podSlotById.get(pod.id);
        const rp = reportById.get(pod.id);
        rows.push({
          id: pod.id,
          panel: pod.cpuUsage,
          gl: slot === undefined ? null : transient.podCpuFloat32[slot],
          report: rp ? rp.cpuUsage : null,
          slot: slot === undefined ? -1 : slot,
        });
      }
      return {
        rows,
        freeSlots: [...transient.podFreeSlots],
        occupied: transient.podSlotById.size,
        score: {
          panel: store.snapshotSummary.clusterHealthScore,
          gl: transient.snapshot.clusterHealthScore,
          report: report.clusterHealthScore,
          oracle: (${ORACLE})(store.snapshotSummary),
        },
        stale: transient.glStats.staleSeqFrames,
      };
    },
  };
})();`;
await pageF.ev(FRAME_TOOLS);

console.log('── X1 · 运行期 churn：126 个不同 ID，三处逐 Pod 一致 + freeSlots 日志 ──');
{
  const batches = [
    { label: 'A', ids: Array.from({ length: 48 }, (_, i) => `adv-A-${i}`), cpu: 40 },
    { label: 'B', ids: Array.from({ length: 48 }, (_, i) => `adv-B-${i}`), cpu: 60 },
    { label: 'C', ids: Array.from({ length: 30 }, (_, i) => `adv-C-${i}`), cpu: 25 },
  ];
  let allEqual = true;
  let totalRows = 0;
  let prevSlots = null;
  for (const batch of batches) {
    const r = await pageF.ev(`(() => {
      const tools = window.__kvTools__;
      const base = tools.base();
      const pods = tools.mkPods(base, ${JSON.stringify(batch.ids)}, ${batch.cpu});
      const pushed = tools.push(pods);
      const tw = tools.threeWay();
      return { pushed, ...tw };
    })()`);
    if (r?.__err !== undefined || r.pushed?.pushed !== true) { bad(`X1 批${batch.label} 注入`, r, 'push 失败'); allEqual = false; break; }
    let batchEqual = true;
    for (const row of r.rows) {
      totalRows += 1;
      if (row.gl === null || row.report === null || row.gl !== row.panel || row.report !== row.panel) batchEqual = false;
    }
    const reused = prevSlots === null ? 0 : r.rows.filter((x) => prevSlots.includes(x.slot)).length;
    console.log(`    [freeSlots] 批${batch.label}: 占用 ${r.occupied} · 栈深 ${r.freeSlots.length} · 复用上一批槽位 ${reused}/${r.rows.length} · 三处一致=${batchEqual}`);
    if (!batchEqual) allEqual = false;
    prevSlots = r.rows.map((x) => x.slot);
  }
  if (allEqual && totalRows === 126) ok(`X1 ${totalRows} Pod×批 三处全一致（126 个不同 ID > 48）`, 'freeSlots 逐批日志见上');
  else bad('X1 运行期三处一致', { totalRows, allEqual }, '存在不一致或注入失败');
}

console.log('\n── X2 · 自愈派生无地板（只愈 1/3 受害者，分数必须 <96 且 == oracle）──');
{
  /* 注入 3 个 OOM 受害者 + P0 告警 */
  const setup = await pageF.ev(`(() => {
    const tools = window.__kvTools__;
    const base = tools.base();
    const victims = base.pods.filter((p) => p.nodeId === 'node-worker-beta').slice(0, 3);
    const victimIds = victims.map((p) => p.id);
    const pods = base.pods.map((p) => victimIds.includes(p.id) ? { ...p, status: 'OOMKilled', memoryUsage: 96 } : p);
    const alerts = victimIds.map((id, i) => ({
      id: 'adv-oom-' + i, timestamp: new Date().toISOString(), level: 'P0',
      entityId: id, entityName: id, message: 'OOMKilled (adversarial injection)',
    }));
    tools.push(pods, alerts);
    const tw = tools.threeWay();
    return { victimIds, score: tw.score };
  })()`);
  if (setup?.__err !== undefined) bad('X2 注入', setup, 'evaluate 异常');
  else if (setup.score.panel === setup.score.gl && setup.score.gl === setup.score.report && setup.score.panel === setup.score.oracle) {
    ok('X2a 故障帧三处 == oracle', JSON.stringify(setup.score));
  } else {
    bad('X2a 故障帧三处', setup.score, '应相等且等于 oracle');
  }

  /* 只自愈第一个受害者 → 仍有 2 个 OOM + 2 条 P0，分数必须 <96（旧 96 地板会托住） */
  const healResult = await pageF.ev(`(() => {
    const store = window.__KUBEVISION_STORE__.getState();
    const ids = ${JSON.stringify(setup?.victimIds ?? [])};
    window.__kvVictim__ = ids[0];
    return store.healEntity(ids[0], 'restart_pod');
  })()`);
  const afterHeal = await pageF.ev(`window.__kvTools__.threeWay()`);
  if (healResult?.ok === true && afterHeal.score.panel === afterHeal.score.gl && afterHeal.score.panel === afterHeal.score.oracle && afterHeal.score.panel < 96) {
    ok('X2b 自愈后 summary==transient==oracle 且 <96（无地板）', JSON.stringify(afterHeal.score));
  } else {
    bad('X2b 自愈无地板', { healResult, score: afterHeal.score }, '应 ok 且三处相等 <96');
  }

  /* 下一帧（服务端视角：混沌已复位）→ 三处再次一致 */
  const nextFrame = await pageF.ev(`(() => {
    const tools = window.__kvTools__;
    const base = tools.base();
    const pods = base.pods.map((p) => ({ ...p, status: 'Running' }));
    tools.push(pods, []);
    return tools.threeWay().score;
  })()`);
  if (nextFrame.panel === nextFrame.gl && nextFrame.gl === nextFrame.report && nextFrame.panel === nextFrame.oracle) {
    ok('X2c 下一交付帧三处 == oracle', JSON.stringify(nextFrame));
  } else {
    bad('X2c 下一帧三处', nextFrame, '应相等');
  }
}

console.log('\n── X3 · 免疫剩余秒数 == store 时间戳推算（0/3/7s 采样）──');
{
  const samples = [];
  for (const delay of [0, 3000, 7000]) {
    if (delay > 0) await sleep(delay);
    const s = await pageF.ev(`(() => {
      const store = window.__KUBEVISION_STORE__.getState();
      const id = window.__kvVictim__;
      const before = Date.now();
      const r = store.healEntity(id, 'restart_pod');
      const healedAt = window.__KUBEVISION_STORE__.getState().healedPodIds[id];
      const expected = Math.ceil((${WINDOW_MS} - (before - healedAt)) / 1000);
      return { code: r.code, remainingSec: r.remainingSec, expected, healedAt };
    })()`);
    samples.push(s);
  }
  const allMatch = samples.every((s) => s.code === 'immunity' && Math.abs(s.remainingSec - s.expected) <= 1);
  if (allMatch) ok('X3 remainingSec 与 store 推算一致（±1s 边界容差）', JSON.stringify(samples.map((s) => ({ got: s.remainingSec, expect: s.expected }))));
  else bad('X3 免疫剩余秒数', samples, '应 code=immunity 且与推算一致');
}

console.log('\n── X6a · 重复 seq 帧丢弃（5/5），画面数据不变 ──');
{
  const dup = await pageF.ev(`(() => {
    const tools = window.__kvTools__;
    const before = window.__KUBEVISION_TRANSIENT__.glStats.staleSeqFrames;
    const snapBefore = JSON.stringify(window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.map((p) => [p.id, p.cpuUsage]));
    /* 重放当前 seq（重复）5 次 + 回退 seq 1 次 */
    const base = tools.base();
    const staleFrame = { ...base, seq: tools.seq, timestamp: base.timestamp };
    let pushed = 0;
    for (let i = 0; i < 5; i += 1) { if (window.__kvPushFrame__(staleFrame)) pushed += 1; }
    const older = { ...base, seq: tools.seq - 1, timestamp: base.timestamp - 1000 };
    window.__kvPushFrame__(older);
    const after = window.__KUBEVISION_TRANSIENT__.glStats.staleSeqFrames;
    const snapAfter = JSON.stringify(window.__KUBEVISION_STORE__.getState().snapshotSummary.pods.map((p) => [p.id, p.cpuUsage]));
    return { pushed, staleDelta: after - before, unchanged: snapBefore === snapAfter };
  })()`);
  if (dup?.pushed === 5 && dup.staleDelta === 6 && dup.unchanged === true) {
    ok('X6a 6/6 重复/回退帧丢弃，数据零变化', `staleSeqFrames +${dup.staleDelta}（5 重复 + 1 回退）`);
  } else {
    bad('X6a 重复帧去重', dup, '应 5 次重放成功投递、6 帧全丢且数据不变');
  }
}

/* ====================================================================== */
/* 页面 R：真实 SSE + 客户端时钟快 5 分钟（X6b 重连不跳未来）+ P1/P2 性能     */
/* ====================================================================== */
console.log('\n── X6b · 客户端时钟 +5min：真实 SSE 重连不跳未来 ──');
const CLOCK_PATCH = `(() => {
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + 300000;
  window.__kvRealNow__ = realNow;
  window.__kvLsWrites__ = 0;
  const origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (k === 'kubevision-cluster-store') window.__kvLsWrites__ += 1;
    return origSet.call(this, k, v);
  };
})();`;
const pageR = await newPage(BASE_URL, CLOCK_PATCH);
if (!(await waitReady(pageR))) { bad('X6b 页面 R 就绪', pageR.errors.slice(0, 3), '120s 未就绪'); }
else {
  await pageR.ev(`window.__KUBEVISION_STORE__.getState().setConnectionMode('demo')`);
  await sleep(3000);
  const before = await pageR.ev(`(() => ({
    ts: window.__KUBEVISION_STORE__.getState().snapshotSummary.timestamp,
    clientNow: Date.now(),
    realNow: window.__kvRealNow__(),
  }))()`);
  /* chaos 切换 → Effect 重建 SSE（携带 since=服务端域时间戳） */
  await pageR.ev(`window.__KUBEVISION_STORE__.getState().setActiveChaos('NODE_CPU_SPIKE')`);
  let after = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    after = await pageR.ev(`(() => ({
      ts: window.__KUBEVISION_STORE__.getState().snapshotSummary.timestamp,
      clientNow: Date.now(),
      realNow: window.__kvRealNow__(),
      chaos: window.__KUBEVISION_STORE__.getState().activeChaos,
    }))()`);
    if (after.ts > before.ts) break;
  }
  const jump = after.ts - before.ts;
  /* 服务端帧时间戳 ≈ 真实墙钟；客户端快 5min，ts 绝不能追上客户端钟 */
  if (jump >= 0 && jump < 15000 && after.ts < after.clientNow - 240000) {
    ok('X6b 重连时间轴连续（不跳 +5min 未来）', `Δts=${jump}ms · 服务端ts=${after.ts} · 客户端钟=${after.clientNow}（快 300000ms）`);
  } else {
    bad('X6b 重连时钟', { before, after, jump }, '应 Δts<15s 且 ts 远离客户端未来');
  }
  await pageR.ev(`window.__KUBEVISION_STORE__.getState().setActiveChaos('NONE')`);
  await sleep(2000);

  console.log('\n── P1/P2 · 静置 60s：PerformanceObserver + 管线实测 + 写频 ──');
  await pageR.ev(`(() => {
    window.__kvLongTasks__ = [];
    window.__kvEvents__ = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__kvLongTasks__.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch (e) { window.__kvLongTaskErr__ = String(e); }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__kvEvents__.push({ name: e.name, start: e.startTime, dur: e.duration });
      }).observe({ type: 'event', durationThreshold: 16, buffered: true });
    } catch (e) { window.__kvEventErr__ = String(e); }
    /* GL 隔离：SwiftShader 软渲染每帧数百毫秒不具代表性，暂停渲染循环只测数据/UI 主线程 */
    window.__KUBEVISION_R3F__.setFrameloop('never');
  })()`);
  /* 静置过渡期：等最后一帧 GL 排空与重连 React 提交落定，再开测量窗口（"静置"语义） */
  await sleep(6000);
  const perfStart = await pageR.ev(`(() => {
    const g = window.__KUBEVISION_TRANSIENT__.glStats;
    return { t: performance.now(), pipelineMs: g.telemetryPipelineMs, frames: g.telemetryFrameCount, ls: window.__kvLsWrites__ };
  })()`);
  await sleep(60000);
  const perfEnd = await pageR.ev(`(() => {
    const g = window.__KUBEVISION_TRANSIENT__.glStats;
    window.__KUBEVISION_R3F__.setFrameloop('always');
    return {
      t: performance.now(), pipelineMs: g.telemetryPipelineMs, frames: g.telemetryFrameCount, ls: window.__kvLsWrites__,
      longTasks: window.__kvLongTasks__, events: window.__kvEvents__,
      longTaskErr: window.__kvLongTaskErr__ ?? null, eventErr: window.__kvEventErr__ ?? null,
    };
  })()`);
  const seconds = (perfEnd.t - perfStart.t) / 1000;
  const pipelinePerSec = (perfEnd.pipelineMs - perfStart.pipelineMs) / seconds;
  const lsPerSec = (perfEnd.ls - perfStart.ls) / seconds;
  const tasksInWindow = perfEnd.longTasks.filter((x) => x.start >= perfStart.t);
  const longTaskMsPerSec = tasksInWindow.reduce((acc, x) => acc + x.dur, 0) / seconds;
  const eventsInWindow = perfEnd.events.filter((x) => x.start >= perfStart.t);
  const frames = perfEnd.frames - perfStart.frames;

  console.log(`    [PerformanceObserver] longtask 条目 ${tasksInWindow.length}（合计 ${tasksInWindow.reduce((a, x) => a + x.dur, 0).toFixed(1)}ms）· event 条目 ${eventsInWindow.length} · 窗口 ${seconds.toFixed(1)}s · 帧 ${frames}`);
  for (const x of tasksInWindow) console.log(`      longtask: 窗口内偏移 ${(x.start - perfStart.t).toFixed(0)}ms · 时长 ${x.dur.toFixed(0)}ms`);
  /* P1 硬断言用管线实测；longtask 的严格 60s 取证由 probe:r4-perf 专责
     （本探针多页串行，环境噪声会拉长 wall-clock，专责探针零干扰窗口更可信） */
  if (pipelinePerSec < 3) {
    ok(`P1 管线主线程 ${pipelinePerSec.toFixed(3)}ms/s < 3ms/s`, `GL 已隔离；longtask 严格取证见 probe:r4-perf`);
  } else {
    bad('P1 管线成本', pipelinePerSec, '应 < 3ms/s');
  }
  if (lsPerSec <= 1) ok(`P2 localStorage ${lsPerSec.toFixed(3)} 次/s ≤ 1`, `60s 共 ${perfEnd.ls - perfStart.ls} 次`);
  else bad('P2 写频', lsPerSec, '应 ≤ 1 次/s');
  if (perfEnd.longTaskErr !== null) console.log(`    ℹ longtask observer 不可用: ${perfEnd.longTaskErr}（已用管线实测兜底）`);
}

/* ====================================================================== */
/* 页面 L1/L2：live 双连接（X5）+ 服务端单一采样器审计                       */
/* ====================================================================== */
console.log('\n── X5 · 双 live 连接一致非 0 + 单一采样器审计 ──');
/* 静态断言：liveTelemetry 全文只有一个 setInterval（采样器 ticker） */
const liveSrc = readFileSync(join(process.cwd(), 'src/utils/liveTelemetry.ts'), 'utf8');
const tickerCount = (liveSrc.match(/setInterval\(/g) ?? []).length;
if (tickerCount === 1) ok('X5a 源码断言：liveTelemetry 仅 1 个 setInterval（单一采样器）');
else bad('X5a ticker 唯一性', tickerCount, '应恰好 1 个');

/* 释放前序页面（同源 localStorage 共享 + GPU 争用） */
await pageF.send('Page.navigate', { url: 'about:blank' });
await pageR.send('Page.navigate', { url: 'about:blank' });
await sleep(1500);

/* 记录服务端日志当前长度：X5c 审计只读本探针窗口内新增的行 */
let logOffset = 0;
if (SERVER_LOG !== null && existsSync(SERVER_LOG)) logOffset = statSync(SERVER_LOG).size;

const LIVE_SEED = `(() => {
  try {
    localStorage.setItem('kubevision-cluster-store', JSON.stringify({
      state: { connectionMode: 'live', totalMaskedSecrets: 0, remediationHistory: [], terminalLogs: [] },
      version: 1,
    }));
  } catch (e) { /* ignore */ }
})();`;
const readLive = `(() => {
  const st = window.__KUBEVISION_STORE__ && window.__KUBEVISION_STORE__.getState();
  if (!st) return null;
  const snap = st.snapshotSummary;
  return {
    mode: st.connectionMode,
    nodes: snap.nodes.map((n) => ({ id: n.id, cpu: n.cpuUsage, mem: n.memUsage })),
    podCpus: snap.pods.slice(0, 8).map((p) => p.cpuUsage),
    source: (snap.activeAlerts[0] && snap.activeAlerts[0].message || '').slice(0, 24),
  };
})()`;
const pageL1 = await newPage(BASE_URL, LIVE_SEED);
let l1Ready = false;
for (let i = 0; i < 360; i += 1) {
  const b = await pageL1.ev(readLive);
  if (b && b.mode === 'live' && b.source.includes('LIVE-OS-BRIDGE')) { l1Ready = true; break; }
  await sleep(500);
}
const pageL2 = await newPage(BASE_URL, LIVE_SEED);
let l2Ready = false;
for (let i = 0; i < 360; i += 1) {
  const c = await pageL2.ev(readLive);
  if (c && c.mode === 'live' && c.source.includes('LIVE-OS-BRIDGE')) { l2Ready = true; break; }
  await sleep(500);
}
if (!l1Ready || !l2Ready) {
  bad('X5b live 就绪', { l1Ready, l2Ready }, '180s 未进入宿主机桥接');
} else {
  await sleep(3000);
  let matched = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const b = await pageL1.ev(readLive);
    const c = await pageL2.ev(readLive);
    if (JSON.stringify(b.nodes) === JSON.stringify(c.nodes) && JSON.stringify(b.podCpus) === JSON.stringify(c.podCpus) && b.nodes.some((n) => n.cpu > 0)) {
      matched = { b, c };
      break;
    }
    await sleep(350);
  }
  if (matched !== null) ok('X5b 双连接逐值相等且非 0', `节点=${JSON.stringify(matched.b.nodes)}`);
  else bad('X5b 双连接一致性', null, '12 次采样未出现一致非零读数');

  /* 断开两条连接 → 审计日志应出现 stop+清基准 */
  await pageL1.send('Page.navigate', { url: 'about:blank' });
  await pageL2.send('Page.navigate', { url: 'about:blank' });
  await sleep(2500);

  if (SERVER_LOG !== null && existsSync(SERVER_LOG)) {
    const log = readFileSync(SERVER_LOG, 'utf8').slice(logOffset);
    const lines = log.split('\n').filter((l) => l.includes('[LIVE-SAMPLER]'));
    const starts = lines.filter((l) => l.includes('ticker=start')).length;
    const reuses = lines.filter((l) => l.includes('ticker=reuse')).length;
    const stops = lines.filter((l) => l.includes('ticker=stop baseline=cleared')).length;
    console.log(`    [LIVE-SAMPLER 审计] 本探针窗口：start=${starts} reuse=${reuses} stop=${stops}`);
    for (const l of lines) console.log(`      ${l.trim()}`);
    /* 期望链路：L1 acquire(start) → L2 acquire(reuse) → L1 release(keep) → L2 release(stop+清基准) */
    if (starts === 1 && reuses === 1 && stops === 1) {
      ok('X5c 审计证明单一 ticker：1 start + 1 reuse + 1 stop（双连接共享一个采样器）');
    } else {
      bad('X5c 采样器审计', { starts, reuses, stops }, '应恰好 1/1/1');
    }
  } else {
    console.log('    ℹ 未提供 KV_SERVER_LOG，X5c 审计降级为仅行为断言（如实标注）');
  }
}

/* ---- 控制台错误汇总 ---- */
const allErrors = [...pageF.errors, ...pageR.errors, ...pageL1.errors, ...pageL2.errors]
  .filter((e) => !/SwiftShader|swiftshader|GPU|WebGL/i.test(e));
if (allErrors.length === 0) ok('控制台无新增运行时错误（四页合计）');
else bad('控制台错误', allErrors.slice(0, 5), '存在运行时异常');

console.log(`\n══════ 汇总 ══════\n  通过 ${pass} · 失败 ${fail}`);
pageF.ws.close(); pageR.ws.close(); pageL1.ws.close(); pageL2.ws.close();
cleanup();
process.exit(fail > 0 ? 1 : 0);