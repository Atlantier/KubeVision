#!/usr/bin/env node
/**
 * KubeVision AI — R9 进阶：流式渲染性能与 5 项鲁棒性探针（scripts/probe-stream-perf.mjs）
 *
 * 【覆盖指标与验收红线（R9 Main + R9 进阶 N1–N5）】
 *   - M1 渲染计数：3000+ 字（210 chunk）流式期间，MessageBubble 总 commit <= 90、
 *        历史消息 Bubble 重渲染 === 0，且必须存在渐进帧渲染（>=5 次可见增量更新且最大帧间隔 < 500ms），
 *        严防“整段完结后一次性吐出”作弊；
 *   - M2 长任务：PerformanceObserver('longtask') 观测 >50ms 长任务数 === 0；
 *   - M3 布局抖动：CLS < 0.02；
 *   - N1 卸载体检：流式进行中切 Tab / 清空会话，取消 rAF 与定时器，0 卸载后 setState / console 错误；
 *   - N2 滚动锚定：上滑 300px 暂停跟随 2000ms，显示「回到最新诊断」且不遮挡输入区，点击回到底部；
 *   - N3 虚拟列表：>=50 条消息时 DOM 中渲染的 [data-copilot-msg] <= 15，急速滚顶无白屏闪烁；
 *   - N4 链接白名单：javascript:/data:/vbscript: 降级为纯文本，https: 具备 target="_blank" rel="noopener noreferrer"；
 *   - N5 半截 Markdown：未闭合围栏代码块尾部文本在流式期即时可见，表格对齐与嵌套引用正常渲染。
 *
 * 【用法】
 *   node scripts/probe-stream-perf.mjs
 *   node scripts/probe-stream-perf.mjs --base http://127.0.0.1:3000
 *   node scripts/probe-stream-perf.mjs --port=3000 --cdp-port=9371 --gpu=d3d11
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT_DIR = join(ROOT, '.verify-artifacts');
const REPORT_PATH = join(ARTIFACT_DIR, 'r9-stream-perf-report.json');

function readArg(flag, fallback = null) {
  const pref = `${flag}=`;
  const inline = process.argv.find((a) => a.startsWith(pref));
  if (inline !== undefined) return inline.slice(pref.length);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

const EXTERNAL_BASE = readArg('--base');
const PORT = Number(readArg('--port', '3000'));
const CDP_PORT = Number(readArg('--cdp-port', '9371'));
const GPU_MODE = readArg('--gpu', process.platform === 'win32' ? 'd3d11' : 'swiftshader');
if (GPU_MODE !== 'd3d11' && GPU_MODE !== 'swiftshader') {
  throw new Error(`不支持的 --gpu 模式: ${GPU_MODE}（仅支持 d3d11 | swiftshader）`);
}
const BASE_URL = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;
const TARGET_URL = `${BASE_URL}/?debug=stream`;

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(ARTIFACT_DIR, { recursive: true });

let passCount = 0;
let failCount = 0;
const findings = [];

function check(name, cond, actual, expected) {
  if (cond) {
    passCount += 1;
    findings.push({ status: 'PASS', name, actual, expected });
    console.log(`  ✓ ${name}  ::  实际=${JSON.stringify(actual)}`);
  } else {
    failCount += 1;
    findings.push({ status: 'FAIL', name, actual, expected });
    console.log(`  ✗ ${name}  ::  实际=${JSON.stringify(actual)}  期望=${JSON.stringify(expected)}`);
  }
}

function killTree(proc) {
  if (!proc || proc.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {
    /* ignore already exited */
  }
}

async function isUrlReachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUrlReachable(url)) return true;
    await sleep(800);
  }
  return false;
}

function build3000CharMarkdown() {
  const sample = [
    '## 根因诊断结论：payment-gateway 内存泄漏触发 cgroup OOMKilled (Exit 137)\n\n',
    '根据实时遥测与 **RUNBOOK-K8S-042** 交叉比对，容器 `payment-gateway-7f8b9-x2k` 内存使用率持续单调攀升至 **97.2%**，最终触及 `memory.max` 硬限制。\n\n',
    '### 核心证据链\n\n',
    '| 指标项 | 观测值 | 安全基线 | 状态 |\n',
    '|---|---|---|---|\n',
    '| Memory RSS | 97.2% | < 80% | CRITICAL |\n',
    '| Restart Count | 9 次 | 0 次 | 异常退避 |\n',
    '| Node CPU | 42.0% | < 85% | 充裕 |\n\n',
    '### 排查与验证命令\n\n',
    '```bash\n',
    'kubectl describe pod payment-gateway-7f8b9-x2k -n kv-prod\n',
    'kubectl top pod payment-gateway-7f8b9-x2k -n kv-prod --containers\n',
    'kubectl logs payment-gateway-7f8b9-x2k -n kv-prod --previous --tail=120\n',
    '```\n\n',
    '> [!WARNING] 注意事项：当前节点 `worker-beta` 整体内存水位仅 51%，属于单 Pod 堆内存增长问题，不应执行节点驱逐。\n\n',
    '- **直接触发因素**：订单缓存队列未设上限导致 Go/JVM 老年代持续膨胀，Page Cache 回收不足触发内核 OOM Killer（`SIGKILL`）。\n',
    '- **关联风险评估**：支付入口 QPS 当前为 `2,400 req/s`，重启窗口内的在途连接将被强制复位。\n',
    '- **推荐参考手册**：详见 [Kubernetes Pod OOM 排障指南](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/) 与 `RUNBOOK-K8S-042`。\n\n',
    '### 分阶段处置建议\n\n',
    '1. **立即止血**：通过下方 MCP 自愈动作卡片安全重启 `payment-gateway-7f8b9-x2k` 并恢复健康水位。\n',
    '2. **抓取堆快照**：保留 `/debug/pprof/heap` 与最近 30 分钟请求链路样本以定位泄漏对象分配热点。\n',
    '3. **容量与护栏调优**：将 `resources.limits.memory` 临时上调至峰值的 1.3 倍，并启用内存使用率 85% 预警规则。\n\n',
  ].join('');
  let text = sample;
  while (text.length < 3100) {
    text += `\n#### 补充观测批次：第 ${Math.floor(text.length / 400)} 段历史关联分析\n\n` +
      '当前副本组在过去 6 个采样周期内呈现线性增长斜率，建议核查下游连接池复用率与大对象序列化缓冲区生命周期。参见 RUNBOOK-K8S-042 与 RUNBOOK-K8S-043。\n';
  }
  const chunks = [];
  for (let i = 0; i < text.length; i += 15) {
    chunks.push(text.slice(i, i + 15));
  }
  return { fullMarkdown: text, chunks };
}

let devProc = null;
let browserProc = null;

function cleanupProcesses() {
  killTree(browserProc);
  browserProc = null;
  killTree(devProc);
  devProc = null;
}

process.on('exit', cleanupProcesses);
process.on('SIGINT', () => {
  cleanupProcesses();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanupProcesses();
  process.exit(143);
});

async function launchCdpSession() {
  const edgePath = EDGE_PATHS.find((p) => existsSync(p));
  if (!edgePath) throw new Error('未找到可用 Edge / Chrome 浏览器');

  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-r9-perf-${Date.now()}`);
  browserProc = spawn(edgePath, [
    '--headless=new',
    '--no-first-run',
    '--hide-scrollbars',
    '--use-gl=angle',
    ...(GPU_MODE === 'd3d11'
      ? ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
      : ['--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--window-size=1680,1000',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
      target = list.find((t) => t.type === 'page') ?? null;
      if (target) break;
    } catch {
      /* waiting */
    }
    await sleep(400);
  }
  if (!target) throw new Error('Edge CDP page target 未就绪');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params?.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300);
      if (msg.params?.type === 'error') consoleErrors.push(text);
      else if (msg.params?.type === 'warning') consoleWarnings.push(text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(msg.params?.exceptionDetails?.text ?? 'exception').slice(0, 300));
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  };

  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    const t = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`CDP timeout: ${method}`));
    }, 30000);
    pending.set(id, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });

  return { ws, send, ev, consoleErrors, consoleWarnings, pageErrors };
}

async function installPerfProbeAndFetchMock(cdp, fixtureChunks) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const nextIds = { id: 0 };
      const state = {
        recording: false,
        historyIds: {},
        rootCommits: 0,
        drawerRenders: 0,
        bubbleRendersTotal: 0,
        activeAssistantBubbleRenders: 0,
        historyBubbleRenders: 0,
        newUserBubbleRenders: 0,
        rendersByMsgId: {},
        roleByMsgId: {},
        activeRenderTimestamps: [],
        longtasks: [],
        layoutShifts: [],
        cls: 0,
        lastFiberByKey: new Map(),
      };
      window.__KV_PERF_PROBE__ = state;

      const getFnName = (fiber) => {
        const fn = fiber.type;
        if (fiber.tag === 0 && typeof fn === 'function') return fn.name || '';
        if (fiber.tag === 14 || fiber.tag === 15) {
          if (typeof fn === 'function') return fn.name || '';
          if (fn && typeof fn.type === 'function') return fn.type.name || '';
        }
        return '';
      };

      const hook = {
        renderers: new Map(),
        supportsFiber: true,
        inject(internals) {
          const id = ++nextIds.id;
          hook.renderers.set(id, internals);
          return id;
        },
        onScheduleFiberRoot() {},
        onCommitFiberUnmount() {},
        onCommitFiberRoot(id, root) {
          if (!root || !root.current) return;
          if (state.recording) state.rootCommits += 1;
          const stack = [root.current];
          const seenKeysThisCommit = new Set();
          while (stack.length > 0) {
            const fiber = stack.pop();
            if (!fiber) continue;
            if (fiber.sibling) stack.push(fiber.sibling);
            if (fiber.child) stack.push(fiber.child);

            const fnName = getFnName(fiber);
            if (!fnName) continue;
            const performedWork = (fiber.flags & 1) !== 0;
            if (!performedWork) continue;

            if (fnName === 'MessageBubble') {
              const msg = fiber.memoizedProps && fiber.memoizedProps.message;
              const msgId = msg && msg.id ? String(msg.id) : null;
              if (!msgId || seenKeysThisCommit.has(msgId)) continue;
              seenKeysThisCommit.add(msgId);
              const prevFiber = state.lastFiberByKey.get(msgId);
              state.lastFiberByKey.set(msgId, fiber);
              if (prevFiber === fiber) continue;
              state.roleByMsgId[msgId] = msg.role || 'unknown';
              if (!state.recording) continue;
              state.bubbleRendersTotal += 1;
              state.rendersByMsgId[msgId] = (state.rendersByMsgId[msgId] || 0) + 1;
              if (state.historyIds[msgId]) {
                state.historyBubbleRenders += 1;
              } else if (msg.role === 'user') {
                state.newUserBubbleRenders += 1;
              } else {
                state.activeAssistantBubbleRenders += 1;
                state.activeRenderTimestamps.push(performance.now());
              }
            } else if (state.recording && fnName === 'CopilotDrawer') {
              const prev = state.lastFiberByKey.get('__CopilotDrawer__');
              state.lastFiberByKey.set('__CopilotDrawer__', fiber);
              if (prev !== fiber) state.drawerRenders += 1;
            }
          }
        },
      };
      if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
      }

      try {
        const ltObs = new PerformanceObserver((list) => {
          if (!state.recording) return;
          for (const entry of list.getEntries()) {
            if (entry.duration > 50) {
              state.longtasks.push({ startTime: Math.round(entry.startTime), duration: Math.round(entry.duration * 100) / 100 });
            }
          }
        });
        ltObs.observe({ type: 'longtask', buffered: false });
      } catch (e) { state.ltError = String(e); }

      try {
        const lsObs = new PerformanceObserver((list) => {
          if (!state.recording) return;
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              state.cls += entry.value;
              state.layoutShifts.push({ value: entry.value, startTime: Math.round(entry.startTime) });
            }
          }
        });
        lsObs.observe({ type: 'layout-shift', buffered: false });
      } catch (e) { state.clsError = String(e); }
    })()`,
  });

  await cdp.send('Page.navigate', { url: TARGET_URL });
  for (let i = 0; i < 240; i += 1) {
    const ready = await cdp.ev(`Boolean(window.__KUBEVISION_STORE__ && document.querySelector('[aria-label="AI Copilot 抽屉"]') && document.querySelector('textarea[aria-label="对话输入框"]'))`);
    if (ready === true) break;
    await sleep(500);
  }
  await sleep(2000);

  await cdp.ev(`(() => {
    window.__KUBEVISION_STORE__.getState().setActiveRightTab('copilot');
    const chunks3000 = ${JSON.stringify(fixtureChunks)};
    const origFetch = window.fetch;
    let scenario = 'history';
    let histCounter = 0;
    window.__SET_R9_SCENARIO__ = (s) => { scenario = s; };

    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/chat') === -1) {
        return origFetch.call(window, input, init);
      }
      if (scenario === 'history') {
        histCounter += 1;
        const n = histCounter;
        const events = [
          { type: 'reset', requestId: 'req-hist-' + n, reason: 'new-round' },
          { type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: '识别历史巡检', detail: '第 ' + n + ' 轮基线', latencyMs: 3 } },
          { type: 'text', content: '历史诊断 #' + n + '：节点运行稳态，未发现异常退出。\\n\\n建议动作：维持当前观测周期。' },
          { type: 'engine', engine: 'simulator', reason: 'r9-history' },
          { type: 'done', requestId: 'req-hist-' + n, engine: 'simulator' },
        ];
        const body = events.map((e) => JSON.stringify(e)).join('\\n') + '\\n';
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }));
      }

      const enc = new TextEncoder();
      const makeStream = (fn) => new ReadableStream({
        async start(controller) {
          const push = (obj) => {
            try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\\n')); } catch {}
          };
          await fn(push, controller);
          try { controller.close(); } catch {}
        }
      });

      if (scenario === 'perf3000') {
        const stream = makeStream(async (push) => {
          push({ type: 'reset', requestId: 'req-perf-3000', reason: 'new-round' });
          push({ type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: '解析故障诊断意图', detail: '3000字性能验证', latencyMs: 8 } });
          push({ type: 'reasoning', step: { stepIndex: 1, phase: 'RAG_RETRIEVAL', title: '检索 SRE 知识库', detail: '命中 RUNBOOK-K8S-042', latencyMs: 10 } });
          push({ type: 'engine', engine: 'simulator', reason: 'r9-perf3000' });
          const streamStart = performance.now();
          for (let i = 0; i < chunks3000.length; i += 1) {
            push({ type: 'text', content: chunks3000[i] });
            const targetElapsedMs = ((i + 1) / chunks3000.length) * 1050;
            const lagMs = targetElapsedMs - (performance.now() - streamStart);
            if (lagMs >= 8) {
              await new Promise((r) => setTimeout(r, Math.round(lagMs)));
            }
          }
          push({ type: 'tool-start', toolCallId: 'perf-m1', toolName: 'renderPodMetrics', mcpUri: 'mcp://k8s-cluster/tools/renderPodMetrics' });
          push({ type: 'tool-result', toolCallId: 'perf-m1', toolName: 'renderPodMetrics', args: {
            podId: 'pod-payment-gateway-7f8b9-x2k', podName: 'payment-gateway-7f8b9-x2k', namespace: 'kv-prod',
            cpuUsage: 66, memoryUsage: 97.2, restarts: 9,
            cpuHistory: [58, 62, 65, 66, 66, 66], memHistory: [80, 86, 91, 95, 96, 97.2],
          }});
          push({ type: 'trace-summary', traceId: 'tr-perf-3000', engine: 'simulator', ttftMs: 20, totalMs: 1600 });
          push({ type: 'done', requestId: 'req-perf-3000', engine: 'simulator' });
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }));
      }

      if (scenario === 'slowScroll') {
        const stream = makeStream(async (push) => {
          push({ type: 'reset', requestId: 'req-slow-scroll', reason: 'new-round' });
          push({ type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: '持续流式输出验证', detail: '滚动跟随暂停检查', latencyMs: 5 } });
          push({ type: 'engine', engine: 'simulator', reason: 'r9-scroll' });
          for (let i = 0; i < 95; i += 1) {
            if (init && init.signal && init.signal.aborted) return;
            push({ type: 'text', content: '- 第 ' + (i + 1) + ' 条渐进诊断观测记录：内存分配速率平稳攀升，等待确认恢复水位。\\n' });
            await new Promise((r) => setTimeout(r, 32));
          }
          push({ type: 'trace-summary', traceId: 'tr-slow-scroll', engine: 'simulator', ttftMs: 15, totalMs: 3100 });
          push({ type: 'done', requestId: 'req-slow-scroll', engine: 'simulator' });
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }));
      }

      if (scenario === 'n4links') {
        const md = [
          '### N4 链接白名单与安全校验\\n\\n',
          '- 合法手册：[K8s OOM 官方文档](https://kubernetes.io/docs/concepts/overview/)\\n',
          '- 值班联系：[SRE 值班邮箱](mailto:sre@kubevision.local)\\n',
          '- 拦截测试 1：[危险脚本调用](javascript:alert(1))\\n',
          '- 拦截测试 2：[诱导数据协议](data:text/html,<script>alert(1)</script>)\\n',
          '- 拦截测试 3：[VBScript 尝试](vbscript:msgbox(1))\\n\\n',
          '建议动作：仅允许受信任的 HTTPS 运维文档外链。',
        ].join('');
        const body = [
          { type: 'reset', requestId: 'req-n4', reason: 'new-round' },
          { type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: '检验安全外链过滤', detail: 'N4', latencyMs: 5 } },
          { type: 'engine', engine: 'simulator', reason: 'n4' },
          { type: 'text', content: md },
          { type: 'done', requestId: 'req-n4', engine: 'simulator' },
        ].map((e) => JSON.stringify(e)).join('\\n') + '\\n';
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }));
      }

      if (scenario === 'n5unclosed') {
        const stream = makeStream(async (push) => {
          push({ type: 'reset', requestId: 'req-n5', reason: 'new-round' });
          push({ type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: '检验半截 Markdown 渲染', detail: 'N5', latencyMs: 5 } });
          push({ type: 'engine', engine: 'simulator', reason: 'n5' });
          push({ type: 'text', content: '| 维度 | 状态 |\\n|:---|---:|\\n| 节点 | Ready |\\n\\n> 一级引用\\n> > 嵌套二级引用\\n\\n' });
          await new Promise((r) => setTimeout(r, 60));
          push({ type: 'text', content: '\`\`\`yaml\\napiVersion: v1\\nkind: Pod\\n# UNCLOSED_FENCE_VISIBLE_MARKER' });
          await new Promise((r) => setTimeout(r, 900));
          push({ type: 'text', content: '\\n\`\`\`\\n\\n建议动作：确认围栏闭合后继续排查。' });
          push({ type: 'done', requestId: 'req-n5', engine: 'simulator' });
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }));
      }

      if (scenario === 'n6unbroken') {
        const longHex = '0123456789abcdef'.repeat(20);
        const longUrl = 'https://kubernetes.io/docs/concepts/' + 'segment-'.repeat(24) + 'overview';
        const stream = makeStream(async (push) => {
          push({ type: 'reset', requestId: 'req-n6', reason: 'new-round' });
          push({ type: 'reasoning', step: { stepIndex: 0, phase: 'INTENT_PLANNING', title: '验证超长无空格 Token 宽度免疫', detail: 'N6', latencyMs: 4 } });
          push({ type: 'engine', engine: 'simulator', reason: 'n6' });
          push({ type: 'text', content: '### 超长连续哈希与外链回归检测\\n\\n摘要：\`sha256:' + longHex + '\`\\n\\n参考文档：[' + longUrl + '](' + longUrl + ')\\n\\n' });
          for (let i = 0; i < 6; i += 1) {
            push({ type: 'text', content: '- 第 ' + (i + 1) + ' 步连续字符串：' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(6) + '\\n' });
            await new Promise((r) => setTimeout(r, 12));
          }
          push({ type: 'text', content: '\\n建议动作：确认 3D 视口与抽屉宽度稳固。' });
          push({ type: 'done', requestId: 'req-n6', engine: 'simulator' });
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }));
      }

      return origFetch.call(window, input, init);
    };
    return true;
  })()`);
}

async function sendPrompt(cdp, text) {
  return cdp.ev(`(() => {
    const ta = document.querySelector('textarea[aria-label="对话输入框"]');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
}

async function waitIdle(cdp, maxWaitMs = 20000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(120);
    const streaming = await cdp.ev(`window.__KUBEVISION_STORE__.getState().copilotStreaming`);
    if (streaming === false) return true;
  }
  return false;
}

async function clearSession(cdp) {
  await cdp.ev(`(() => {
    const btn = document.querySelector('button[aria-label="清空会话"]');
    if (btn && !btn.disabled) btn.click();
    return true;
  })()`);
  await sleep(250);
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[R9 Probe] 启动 R9 进阶全链路探针 (target=${TARGET_URL}, gpu=${GPU_MODE})`);

  if (!EXTERNAL_BASE) {
    if (await isUrlReachable(BASE_URL)) {
      throw new Error(`端口 ${PORT} 已被占用，请先清理旧服务或传入 --base`);
    }
    console.log(`[R9 Probe] 启动临时 Next dev server (port=${PORT})...`);
    devProc = spawn('cmd.exe', ['/d', '/s', '/c', 'pnpm', 'dev', '-p', String(PORT)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const ok = await waitForServer(BASE_URL, 120000);
    if (!ok) throw new Error('dev server 启动超时 (120s)');
  }

  const cdp = await launchCdpSession();
  const report = { startedAt, targetUrl: TARGET_URL, gpuMode: GPU_MODE, m1m3: null, n1: null, n2: null, n3: null, n4: null, n5: null, n6: null, appHookDetected: null };

  try {
    const { fullMarkdown, chunks } = build3000CharMarkdown();
    await installPerfProbeAndFetchMock(cdp, chunks);
    await clearSession(cdp);

    /* ========== M1–M3: 3000 字流式性能与渲染隔离 ========== */
    console.log('\n[Phase 1] M1–M3 · 3000 字流式渲染与长任务/CLS 测量');
    await cdp.ev(`window.__SET_R9_SCENARIO__('history')`);
    for (let i = 1; i <= 3; i += 1) {
      await sendPrompt(cdp, `历史巡检基线 #${i}`);
      await sleep(100);
      await waitIdle(cdp, 10000);
    }

    await cdp.ev(`(() => {
      window.__SET_R9_SCENARIO__('perf3000');
      const p = window.__KV_PERF_PROBE__;
      p.historyIds = {};
      for (const k of Object.keys(p.roleByMsgId)) p.historyIds[k] = true;
      p.rootCommits = 0;
      p.drawerRenders = 0;
      p.bubbleRendersTotal = 0;
      p.activeAssistantBubbleRenders = 0;
      p.historyBubbleRenders = 0;
      p.newUserBubbleRenders = 0;
      p.rendersByMsgId = {};
      p.activeRenderTimestamps = [];
      p.longtasks = [];
      p.layoutShifts = [];
      p.cls = 0;
      p.recording = true;
      if (window.__KUBEVISION_STREAM_DEBUG__) {
        window.__KUBEVISION_STREAM_DEBUG__.reset();
      }

      /* 记录渐进 DOM 文本增长时间点以验证非“整段一次性吐出” */
      window.__KV_STREAM_PAINTS__ = [];
      const streamBox = document.querySelector('[aria-label="对话消息流"]');
      if (streamBox) {
        window.__KV_PAINT_OBS__ = new MutationObserver(() => {
          const assistants = streamBox.querySelectorAll('[data-copilot-msg="assistant"]');
          const last = assistants[assistants.length - 1];
          const len = last ? (last.textContent || '').length : 0;
          const prev = window.__KV_STREAM_PAINTS__[window.__KV_STREAM_PAINTS__.length - 1];
          if (!prev || len > prev.len) {
            window.__KV_STREAM_PAINTS__.push({ t: performance.now(), len });
          }
        });
        window.__KV_PAINT_OBS__.observe(streamBox, { childList: true, subtree: true, characterData: true });
      }
      return Object.keys(p.historyIds).length;
    })()`);

    const tStream0 = Date.now();
    await sendPrompt(cdp, '请对 payment-gateway 执行 3000 字深度根因分析');
    await sleep(300);
    await waitIdle(cdp, 30000);
    await sleep(300);

    const m1m3 = await cdp.ev(`(() => {
      const p = window.__KV_PERF_PROBE__;
      p.recording = false;
      if (window.__KV_PAINT_OBS__) {
        window.__KV_PAINT_OBS__.disconnect();
        window.__KV_PAINT_OBS__ = null;
      }
      const paints = window.__KV_STREAM_PAINTS__ || [];
      let maxPaintGapMs = 0;
      for (let i = 1; i < paints.length; i += 1) {
        maxPaintGapMs = Math.max(maxPaintGapMs, paints[i].t - paints[i - 1].t);
      }
      /* 读取应用内暴露的 __KUBEVISION_STREAM_DEBUG__ 调试计数器并与 React Fiber 探针互验 */
      const appHook = window.__KUBEVISION_STREAM_DEBUG__ ? window.__KUBEVISION_STREAM_DEBUG__.getSnapshot() : null;
      const lastLen = Array.from(document.querySelectorAll('[data-copilot-msg="assistant"]')).slice(-1)[0]?.textContent?.length ?? 0;
      return {
        historyTrackedCount: Object.keys(p.historyIds).length,
        rootCommits: p.rootCommits,
        drawerRenders: p.drawerRenders,
        bubbleRendersTotal: p.bubbleRendersTotal,
        activeAssistantBubbleRenders: p.activeAssistantBubbleRenders,
        historyBubbleRenders: p.historyBubbleRenders,
        newUserBubbleRenders: p.newUserBubbleRenders,
        streamPaintCount: paints.length,
        maxPaintGapMs: Math.round(maxPaintGapMs * 100) / 100,
        longtaskCount: p.longtasks.length,
        maxLongtaskMs: p.longtasks.reduce((m, x) => Math.max(m, x.duration), 0),
        cls: Math.round(p.cls * 100000) / 100000,
        lastAssistantDomTextLen: lastLen,
        appHook,
      };
    })()`);
    m1m3.elapsedMs = Date.now() - tStream0;
    m1m3.fixtureChars = fullMarkdown.length;
    m1m3.fixtureTextChunks = chunks.length;
    report.m1m3 = m1m3;
    report.appHookDetected = m1m3.appHook ?? null;

    const effectiveTotalCommits = m1m3.appHook ? m1m3.appHook.totalBubbleCommits : m1m3.bubbleRendersTotal;
    const effectiveHistoryCommits = m1m3.appHook ? m1m3.appHook.historyBubbleCommits : m1m3.historyBubbleRenders;
    const effectiveRafFlushes = m1m3.appHook ? m1m3.appHook.rafFlushes : m1m3.streamPaintCount;
    const fiberAgreeM1 = m1m3.bubbleRendersTotal >= 1 && m1m3.bubbleRendersTotal <= 90 && m1m3.historyBubbleRenders === 0;

    check('M1a MessageBubble 总渲染 <= 90（应用钩子 & Fiber 互验）', Boolean(m1m3.appHook) && effectiveTotalCommits <= 90 && effectiveTotalCommits >= 1 && fiberAgreeM1, { appTotal: m1m3.appHook?.totalBubbleCommits ?? null, fiberTotal: m1m3.bubbleRendersTotal, rafFlushes: m1m3.appHook?.rafFlushes ?? null }, '1..90');
    check('M1b 历史非活跃 MessageBubble 重渲染 === 0', effectiveHistoryCommits === 0 && m1m3.historyBubbleRenders === 0 && m1m3.historyTrackedCount >= 6, { appHistory: m1m3.appHook?.historyBubbleCommits ?? null, fiberHistory: m1m3.historyBubbleRenders, historyTracked: m1m3.historyTrackedCount }, '0');
    check('M1c 流式渐进输出生效（非末尾整段吐出）', m1m3.streamPaintCount >= 5 && effectiveRafFlushes >= 5 && m1m3.maxPaintGapMs < 500, { paints: m1m3.streamPaintCount, rafFlushes: effectiveRafFlushes, maxGapMs: m1m3.maxPaintGapMs }, 'paints>=5 & rafFlushes>=5 & maxGap<500ms');
    check('M2 长任务 (>50ms) === 0', m1m3.longtaskCount === 0, { count: m1m3.longtaskCount, maxMs: m1m3.maxLongtaskMs }, 0);
    check('M3 流式期间 CLS < 0.02', m1m3.cls < 0.02, m1m3.cls, '< 0.02');

    /* ========== N2: 上滑 300px 暂停跟随 2s + 回到最新诊断不重叠 ========== */
    console.log('\n[Phase 2] N2 · 上滑 300px 暂停跟随 2000ms + 悬浮胶囊无遮挡校验');
    await cdp.ev(`window.__SET_R9_SCENARIO__('slowScroll')`);
    await sendPrompt(cdp, '开始持续流式诊断以验证上滑暂停');
    await sleep(350);

    const scrollPauseStart = await cdp.ev(`(() => {
      const box = document.querySelector('[aria-label="对话消息流"]');
      if (!box) return { ok: false, reason: 'no scroll box' };
      const maxTop = box.scrollHeight - box.clientHeight;
      if (maxTop <= 320) return { ok: false, reason: 'scrollHeight not tall enough', maxTop };
      box.scrollTop = Math.max(0, maxTop - 300);
      box.dispatchEvent(new Event('scroll', { bubbles: true }));
      const assistants = box.querySelectorAll('[data-copilot-msg="assistant"]');
      const lenStart = assistants[assistants.length - 1]?.textContent?.length ?? 0;
      return { ok: true, scrollTopSet: box.scrollTop, maxTop, lenStart };
    })()`);

    await sleep(2000);
    const scrollPauseEnd = await cdp.ev(`(() => {
      const box = document.querySelector('[aria-label="对话消息流"]');
      const jumpBtn = document.querySelector('button[aria-label="回到最新诊断"]');
      const textarea = document.querySelector('textarea[aria-label="对话输入框"]');
      const queueHint = document.querySelector('[role="status"][aria-label="排队提示"]');
      const assistants = box ? box.querySelectorAll('[data-copilot-msg="assistant"]') : [];
      const lenEnd = assistants.length ? (assistants[assistants.length - 1].textContent || '').length : 0;

      const distanceFromBottom = box ? (box.scrollHeight - box.scrollTop - box.clientHeight) : 0;
      const jr = jumpBtn ? jumpBtn.getBoundingClientRect() : null;
      const tr = textarea ? textarea.getBoundingClientRect() : null;
      const overlaps = (a, b) => Boolean(a && b && a.width > 0 && b.width > 0 && !(a.right <= b.left + 1 || a.left >= b.right - 1 || a.bottom <= b.top + 1 || a.top >= b.bottom - 1));

      return {
        lenEnd,
        distanceFromBottom: Math.round(distanceFromBottom),
        jumpBtnVisible: Boolean(jr && jr.width > 0 && jr.height > 0 && (jumpBtn.textContent || '').includes('回到最新诊断')),
        jumpOverlapsInput: overlaps(jr, tr),
        jumpOverlapsQueue: overlaps(jr, queueHint ? queueHint.getBoundingClientRect() : null),
        jumpRect: jr ? { top: Math.round(jr.top), bottom: Math.round(jr.bottom) } : null,
        textareaRect: tr ? { top: Math.round(tr.top), bottom: Math.round(tr.bottom) } : null,
      };
    })()`);

    await cdp.ev(`(() => {
      const jumpBtn = document.querySelector('button[aria-label="回到最新诊断"]');
      if (jumpBtn) jumpBtn.click();
      return Boolean(jumpBtn);
    })()`);
    await sleep(750);
    const afterJump = await cdp.ev(`(() => {
      const box = document.querySelector('[aria-label="对话消息流"]');
      const jumpBtn = document.querySelector('button[aria-label="回到最新诊断"]');
      const dist = box ? (box.scrollHeight - box.scrollTop - box.clientHeight) : 9999;
      return {
        distanceFromBottom: Math.round(dist),
        jumpBtnStillVisible: Boolean(jumpBtn && jumpBtn.getBoundingClientRect().height > 0),
      };
    })()`);
    await waitIdle(cdp, 15000);
    report.n2 = { scrollPauseStart, scrollPauseEnd, afterJump };

    const streamGrewDuringPause = scrollPauseStart.ok && (scrollPauseEnd.lenEnd - scrollPauseStart.lenStart > 60);
    check('N2a 上滑 300px 后 2000ms 流式增长且未强制贴底', streamGrewDuringPause && scrollPauseEnd.distanceFromBottom > 120, { grew: scrollPauseEnd.lenEnd - (scrollPauseStart.lenStart || 0), dist: scrollPauseEnd.distanceFromBottom }, 'grew>60 & dist>120');
    check('N2b 回到最新诊断按钮可见且零遮挡输入区', scrollPauseEnd.jumpBtnVisible && !scrollPauseEnd.jumpOverlapsInput && !scrollPauseEnd.jumpOverlapsQueue, scrollPauseEnd, 'visible & no overlap');
    check('N2c 点击回到最新诊断平滑回到底部', afterJump.distanceFromBottom <= 24 && !afterJump.jumpBtnStillVisible, afterJump, 'dist<=24 & hidden');

    /* ========== N1: 流式期间切 Tab / 清空会话取消 rAF ========== */
    console.log('\n[Phase 3] N1 · 流式途中切 Tab 与清空会话生命周期取消校验');
    const n1ErrBefore = cdp.consoleErrors.length + cdp.pageErrors.length;
    await cdp.ev(`window.__SET_R9_SCENARIO__('slowScroll')`);
    await sendPrompt(cdp, '验证切换标签与卸载清理');
    await sleep(250);
    await cdp.ev(`(() => {
      const tabs = Array.from(document.querySelectorAll('[aria-label="AI 抽屉视图切换"] [role="tab"]'));
      const auditor = tabs.find((t) => /Edge Log Auditor/i.test(t.textContent || ''));
      if (auditor) auditor.click();
      return Boolean(auditor);
    })()`);
    await sleep(450);
    await cdp.ev(`(() => {
      const tabs = Array.from(document.querySelectorAll('[aria-label="AI 抽屉视图切换"] [role="tab"]'));
      const copilot = tabs.find((t) => !/Edge Log Auditor/i.test(t.textContent || ''));
      if (copilot) copilot.click();
      return Boolean(copilot);
    })()`);
    await sleep(150);

    await clearSession(cdp);
    await sleep(600);
    const n1AfterClear = await cdp.ev(`({
      streaming: window.__KUBEVISION_STORE__.getState().copilotStreaming,
      msgNodes: document.querySelectorAll('[aria-label="对话消息流"] [data-copilot-msg]').length,
    })`);
    /* 再发一条正常消息验证状态未污染 */
    await cdp.ev(`window.__SET_R9_SCENARIO__('history')`);
    await sendPrompt(cdp, '清空后恢复首轮对话');
    const recoveredIdle = await waitIdle(cdp, 10000);
    const n1ErrDelta = (cdp.consoleErrors.length + cdp.pageErrors.length) - n1ErrBefore;
    report.n1 = { n1AfterClear, recoveredIdle, n1ErrDelta };

    check('N1 流式途中切 Tab + 清空会话后复位且 0 错误', n1AfterClear.streaming === false && recoveredIdle && n1ErrDelta === 0, report.n1, 'streaming=false & err=0');

    /* ========== N3: >=50 条消息虚拟列表与急速滚顶 ========== */
    console.log('\n[Phase 4] N3 · >=50 条消息虚拟化上限与急速滚顶零白屏');
    await clearSession(cdp);
    await cdp.ev(`window.__SET_R9_SCENARIO__('history')`);
    for (let i = 1; i <= 26; i += 1) {
      await sendPrompt(cdp, `第 ${i} 轮虚拟列表巡检`);
      await waitIdle(cdp, 5000);
    }
    const n3State = await cdp.ev(`(async () => {
      const box = document.querySelector('[aria-label="对话消息流"]');
      const domCountBottom = box ? box.querySelectorAll('[data-copilot-msg]').length : 0;
      const scrollHeight = box ? box.scrollHeight : 0;

      /* 急速分步滚到顶部并连续采样 6 帧 DOM 节点数，检测是否出现白屏帧（0 节点） */
      const samples = [];
      if (box) {
        const steps = [Math.floor(box.scrollHeight * 0.55), Math.floor(box.scrollHeight * 0.2), 0];
        for (const top of steps) {
          box.scrollTop = top;
          box.dispatchEvent(new Event('scroll', { bubbles: true }));
          samples.push(box.querySelectorAll('[data-copilot-msg]').length);
        }
        for (let f = 0; f < 6; f += 1) {
          await new Promise((r) => requestAnimationFrame(r));
          samples.push(box.querySelectorAll('[data-copilot-msg]').length);
        }
      }
      const minSamples = samples.length ? Math.min(...samples) : 0;
      const topText = box ? (box.querySelector('[data-copilot-msg]')?.textContent || '') : '';
      const appSnap = window.__KUBEVISION_STREAM_DEBUG__ ? window.__KUBEVISION_STREAM_DEBUG__.getSnapshot() : null;
      return { domCountBottom, scrollHeight, samples, minSamples, hasTopTurnText: topText.includes('第 1 轮') || topText.includes('第'), appSnap };
    })()`);

    /* 在 >=50 条状态下再流式输出一条，校验新消息在窗外仍正常增量且历史 bubble=0 */
    await cdp.ev(`(() => {
      const box = document.querySelector('[aria-label="对话消息流"]');
      if (box) {
        box.scrollTop = box.scrollHeight;
        box.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      const p = window.__KV_PERF_PROBE__;
      p.historyIds = {};
      for (const k of Object.keys(p.roleByMsgId)) p.historyIds[k] = true;
      p.historyBubbleRenders = 0;
      p.activeAssistantBubbleRenders = 0;
      p.recording = true;
      if (window.__KUBEVISION_STREAM_DEBUG__) {
        window.__KUBEVISION_STREAM_DEBUG__.reset();
      }
      window.__SET_R9_SCENARIO__('perf3000');
      return true;
    })()`);
    await sendPrompt(cdp, '52 条历史之上新增流式诊断');
    await sleep(300);
    await waitIdle(cdp, 25000);
    const n3StreamCheck = await cdp.ev(`(() => {
      const p = window.__KV_PERF_PROBE__;
      p.recording = false;
      const appSnap = window.__KUBEVISION_STREAM_DEBUG__ ? window.__KUBEVISION_STREAM_DEBUG__.getSnapshot() : null;
      const assistants = document.querySelectorAll('[data-copilot-msg="assistant"]');
      const last = assistants[assistants.length - 1];
      return {
        historyBubbleRenders: p.historyBubbleRenders,
        activeAssistantBubbleRenders: p.activeAssistantBubbleRenders,
        appHistoryBubbleCommits: appSnap?.historyBubbleCommits ?? null,
        appVirtualized: appSnap?.virtualized ?? null,
        lastLen: last ? (last.textContent || '').length : 0,
      };
    })()`);
    report.n3 = { n3State, n3StreamCheck };

    check('N3a >=50 消息窗口 DOM 渲染节点数 <= 15（虚拟化启用）', n3State.domCountBottom >= 1 && n3State.domCountBottom <= 15 && Boolean(n3State.appSnap?.virtualized), { domCountBottom: n3State.domCountBottom, appSnap: n3State.appSnap }, '1..15 & virtualized=true');
    check('N3b 急速滚顶过程无白屏闪烁（每帧节点 >= 2）', n3State.minSamples >= 2, { samples: n3State.samples, min: n3State.minSamples }, '>= 2');
    check('N3c 长历史末尾流式消息独立挂载且历史重渲染 === 0', n3StreamCheck.lastLen > 1000 && n3StreamCheck.historyBubbleRenders === 0 && (n3StreamCheck.appHistoryBubbleCommits ?? 0) === 0, n3StreamCheck, 'lastLen>1000 & history=0');

    /* ========== N4 & N5: 链接 XSS 降级与未闭合 Markdown 围栏 ========== */
    console.log('\n[Phase 5] N4–N5 · 危险链接降级与未闭合 Markdown 围栏实时可见');
    await clearSession(cdp);
    await cdp.ev(`window.__SET_R9_SCENARIO__('n4links')`);
    await sendPrompt(cdp, '验证 N4 链接白名单');
    await waitIdle(cdp, 10000);
    const n4Result = await cdp.ev(`(() => {
      const last = Array.from(document.querySelectorAll('[data-copilot-msg="assistant"]')).slice(-1)[0];
      if (!last) return { found: false };
      const anchors = Array.from(last.querySelectorAll('a'));
      const httpsLink = anchors.find((a) => (a.getAttribute('href') || '').startsWith('https://kubernetes.io/'));
      const badAnchor = anchors.find((a) => /^\\s*(javascript|data|vbscript):/i.test(a.getAttribute('href') || ''));
      const text = last.textContent || '';
      return {
        found: true,
        httpsOk: Boolean(httpsLink && httpsLink.getAttribute('target') === '_blank' && (httpsLink.getAttribute('rel') || '').includes('noopener') && (httpsLink.getAttribute('rel') || '').includes('noreferrer')),
        badAnchorCount: badAnchor ? 1 : 0,
        plainTextPreserved: text.includes('危险脚本调用') && text.includes('诱导数据协议') && text.includes('VBScript 尝试'),
      };
    })()`);
    report.n4 = n4Result;
    check('N4 https 安全外链可点击且危险协议降级纯文本', n4Result.found && n4Result.httpsOk && n4Result.badAnchorCount === 0 && n4Result.plainTextPreserved, n4Result, 'httpsOk & badAnchor=0 & plainText');

    await cdp.ev(`window.__SET_R9_SCENARIO__('n5unclosed')`);
    await sendPrompt(cdp, '验证 N5 未闭合代码块与表格对齐');
    await sleep(300);
    const n5MidStream = await cdp.ev(`(() => {
      const last = Array.from(document.querySelectorAll('[data-copilot-msg="assistant"]')).slice(-1)[0];
      const text = last ? (last.textContent || '') : '';
      return {
        streaming: window.__KUBEVISION_STORE__.getState().copilotStreaming,
        trailingVisibleMidStream: text.includes('UNCLOSED_FENCE_VISIBLE_MARKER'),
        hasTable: Boolean(last && last.querySelector('table')),
        hasNestedQuote: Boolean(last && last.querySelector('blockquote blockquote')),
      };
    })()`);
    await waitIdle(cdp, 10000);
    report.n5 = n5MidStream;
    check('N5 流式半截未闭合代码块尾部可见且支持对齐表格/嵌套引用', n5MidStream.trailingVisibleMidStream && n5MidStream.hasTable && n5MidStream.hasNestedQuote, n5MidStream, 'all true');

    /* ========== N6: 超长无空格 Token 不得撑爆抽屉宽度或引发 Canvas 横向循环重排 ========== */
    const n6Baseline = await cdp.ev(`(() => {
      const p = window.__KV_PERF_PROBE__;
      p.longtasks = [];
      p.recording = true;
      const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
      const canvas = document.querySelector('canvas');
      return {
        innerWidth: window.innerWidth,
        drawerWidth: drawer ? Math.round(drawer.getBoundingClientRect().width) : 0,
        canvasWidth: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
      };
    })()`);
    await cdp.ev(`window.__SET_R9_SCENARIO__('n6unbroken')`);
    await sendPrompt(cdp, '验证 N6 超长连续字符串横向防爆');
    await waitIdle(cdp, 10000);
    await sleep(250);
    const n6After = await cdp.ev(`(() => {
      const p = window.__KV_PERF_PROBE__;
      p.recording = false;
      const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
      const canvas = document.querySelector('canvas');
      return {
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        drawerWidth: drawer ? Math.round(drawer.getBoundingClientRect().width) : 0,
        canvasWidth: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
        longtaskCount: p.longtasks.length,
        maxLongtaskMs: p.longtasks.reduce((m, x) => Math.max(m, x.duration), 0),
      };
    })()`);
    const n6Result = { baseline: n6Baseline, after: n6After };
    report.n6 = n6Result;
    const widthDelta = Math.abs(n6After.drawerWidth - n6Baseline.drawerWidth);
    check(
      'N6 超长连续字符串不撑宽抽屉/Canvas 且无长任务卡顿',
      n6After.docScrollWidth <= n6After.innerWidth &&
        widthDelta <= 8 &&
        n6After.canvasWidth >= n6After.innerWidth * 0.55 &&
        n6After.longtaskCount === 0,
      n6Result,
      'docScrollWidth<=innerWidth & drawerWidth delta<=8 & longtask=0',
    );

    check('零 Console/Page Error', cdp.consoleErrors.length === 0 && cdp.pageErrors.length === 0, { consoleErrors: cdp.consoleErrors, pageErrors: cdp.pageErrors }, 'empty');

    writeFileSync(REPORT_PATH, `${JSON.stringify({ ...report, passed: passCount, failed: failCount, findings }, null, 2)}\n`, 'utf8');
    console.log(`\n[R9 Probe] 总结：PASS ${passCount} · FAIL ${failCount} -> ${REPORT_PATH}`);
    process.exitCode = failCount === 0 ? 0 : 1;
  } finally {
    try { cdp.ws.close(); } catch {}
    cleanupProcesses();
  }
}

main().catch((err) => {
  console.error('[R9 Probe] 致命错误:', err);
  cleanupProcesses();
  process.exit(1);
});
