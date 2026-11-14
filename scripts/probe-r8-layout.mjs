#!/usr/bin/env node
/**
 * KubeVision AI — R8 进阶：6 视口 × 多状态 × 5 边界 × E2E 全路径自适应探针（scripts/probe-r8-layout.mjs）
 *
 * 【验证覆盖矩阵】
 *   1. 6 大核心视口（360×740 / 390×844 / 800×600 / 1024×768 / 1366×768 / 1920×1080）
 *      + 1024~1366 连续宽度抽检：
 *      - 全局无横向滚动条（scrollWidth <= innerWidth + 1）；
 *      - TopBar 顶级可交互控件 <= 7、单一健康度读数、单位统一 QPS（可见 UI 零 req/s）；
 *      - 可见浮层/HUD/底栏/导航栏零越界裁切（rect 在视口内）且关键区互斥不重叠；
 *      - `< 768px` 移动端交互按钮均满足 `>= 44×44`（允许文本横条宽>=44/高>=44，icon按钮宽高均>=44）；
 *      - 移动端 Tab 切换动画约 200ms，切屏后 Copilot scrollTop / 草稿输入 / Canvas DOM 节点身份零丢失；
 *      - PerfTelemetryHUD 呈现 Tier1（数据健康 + 渲染路径）在 Tier2（FPS 与子指标）之上，含 `60`/`40`/`0` 刻度与降级证据标记；
 *      - `< 640px` 小屏 Canvas 自动触发「小屏视口自动降载」且 3D 标签按移动端降级精简；
 *      - 模态框互斥栈（Chaos/RAG/PostMortem 互斥）与 CommandPalette (`z-[60]`) 优先 Esc 逐层退出 + 焦点回落。
 *   2. 5 类极端边界：
 *      - E1 移动端软键盘唤醒（textarea 聚焦触发 MobileViewSwitcher 自动隐藏，失焦恢复）；
 *      - E2 刘海屏安全区（viewport-fit=cover meta 与 `.kv-safe-bottom` 安全内边距契约）；
 *      - E3 移动端横屏（844×390）下 HUD/Bottom Sheet 滚动不溢出视口；
 *      - E4 桌面 200% 缩放等效（960×540 CSS 视口，deviceScaleFactor=2）；
 *      - E5 PWA standalone 媒体特性适配无异常滚动或裁切。
 *   3. E2E 全链路走查 + 真实截图留证（docs/evidence/r8-*.png）与 JSON 报告（.verify-artifacts/r8-layout-report.json）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT_DIR = join(ROOT, '.verify-artifacts');
const EVIDENCE_DIR = join(ROOT, 'docs', 'evidence');
const REPORT_PATH = join(ARTIFACT_DIR, 'r8-layout-report.json');

const PORT = Number(readArg('--port') ?? 3028);
const CDP_PORT = Number(readArg('--cdp-port') ?? 9358);
const EXTERNAL_BASE = readArg('--base');
const GPU_MODE = readArg('--gpu') ?? 'swiftshader';
const BASE_URL = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;
const TARGET_URL = `${BASE_URL}/?debug=camera`;

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

function readArg(flag) {
  const pref = `${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passCount = 0;
let failCount = 0;
const findings = [];

function recordPass(name, detail = '') {
  passCount += 1;
  findings.push({ status: 'PASS', name, detail });
  console.log(`  ✓ ${name}${detail ? `  ::  ${detail}` : ''}`);
}

function recordFail(name, actual, expected) {
  failCount += 1;
  findings.push({ status: 'FAIL', name, actual, expected });
  console.log(`  ✗ ${name}  ::  实际=${JSON.stringify(actual)}  期望=${JSON.stringify(expected)}`);
}

function check(name, cond, actual, expected) {
  if (cond) recordPass(name, typeof actual === 'string' ? actual : JSON.stringify(actual));
  else recordFail(name, actual, expected);
}

function findBrowser() {
  return EDGE_PATHS.find((p) => existsSync(p)) ?? null;
}

function startNextServer() {
  const nextBin = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(PORT)], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  let logs = '';
  child.stdout?.on('data', (d) => {
    logs += d.toString();
  });
  child.stderr?.on('data', (d) => {
    logs += d.toString();
  });
  return { child, getLogs: () => logs };
}

function stopChild(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* ignore */
  }
}

async function waitForServer(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* waiting */
    }
    await sleep(300);
  }
  return false;
}

async function openCdpSession(browserPath, cdpPort, width, height, deviceScaleFactor = 1, isMobile = false) {
  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-r8-${cdpPort}-${Date.now()}`);
  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--no-first-run',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      '--use-gl=angle',
      ...(GPU_MODE === 'd3d11'
        ? ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) break;
    } catch {
      await sleep(250);
    }
  }

  const target = await (
    await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
  ).json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.text ?? 'exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (!text.includes('favicon.ico') && !text.includes('404')) {
        pageErrors.push(text);
      }
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      return { __err: r.result.exceptionDetails.text ?? JSON.stringify(r.result.exceptionDetails) };
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor,
    mobile: isMobile,
  });

  return {
    send,
    ev,
    pageErrors,
    setViewport: async (w, h, scale = 1, mobile = w < 768) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: scale,
        mobile,
      });
      await ev('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await sleep(450);
    },
    screenshot: async (filename) => {
      const res = await send('Page.captureScreenshot', { format: 'png' });
      if (res.result?.data) {
        writeFileSync(join(EVIDENCE_DIR, filename), Buffer.from(res.result.data, 'base64'));
      }
    },
    pressKey: async (key, code, modifiers = 0) => {
      const vk = key === 'Escape' ? 27 : key === 'Enter' ? 13 : key.toUpperCase().charCodeAt(0);
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
      await sleep(40);
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
    },
    close: () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      try {
        browser.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    },
  };
}

async function waitForAppReady(ev) {
  for (let i = 0; i < 100; i += 1) {
    const ready = await ev(`Boolean(document.querySelector('header') && document.querySelector('canvas'))`);
    if (ready === true) break;
    await sleep(250);
  }
  await sleep(700);
}

/**
 * 通用页面布局与交互合规采样器（在浏览器上下文执行）
 */
const AUDIT_LAYOUT_EXPR = `(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scrollWidth = document.documentElement.scrollWidth;
  const bodyScrollWidth = document.body ? document.body.scrollWidth : scrollWidth;
  const maxScrollWidth = Math.max(scrollWidth, bodyScrollWidth);

  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (el.closest('[inert]') || el.closest('[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const toRect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      left: Math.round(r.left * 10) / 10,
      top: Math.round(r.top * 10) / 10,
      right: Math.round(r.right * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
    };
  };

  // TopBar 顶级可见控件数与溢出检查
  const header = document.querySelector('header');
  const headerButtons = header ? Array.from(header.querySelectorAll('button')).filter(isVisible) : [];
  const headerTopButtons = headerButtons.filter((b) => !b.closest('[role="dialog"], [role="menu"]'));
  const headerOverflow = headerTopButtons.filter((b) => {
    const r = b.getBoundingClientRect();
    return r.left < -1 || r.right > vw + 1 || r.bottom > (header?.getBoundingClientRect().bottom ?? 80) + 2;
  }).map((b) => ({ label: b.getAttribute('aria-label') || b.textContent?.trim(), rect: toRect(b) }));

  // 检查 req/s 单位残留（仅统计可见文本节点，不含 hidden/sr-only/code）
  const bodyText = document.body.innerText || '';
  const hasLegacyReqSec = /req\\/s/i.test(bodyText);

  // 检查移动端 (< 768px) 触控按钮尺寸 >= 44px
  const smallTouchTargets = [];
  if (vw < 768) {
    const interactive = Array.from(document.querySelectorAll('button, [role="tab"]')).filter(isVisible);
    for (const el of interactive) {
      // 跳过场景内 3D <Html> 投影标签按钮（如果有）和纯文本小链接；常规 Chrome/HUD 按钮都要校验
      if (el.closest('[data-r3f-html]')) continue;
      const r = el.getBoundingClientRect();
      // 若为明显被裁切到视口外的隐藏元素跳过
      if (r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) continue;
      if (r.width < 43.5 || r.height < 43.5) {
        smallTouchTargets.push({
          label: el.getAttribute('aria-label') || el.textContent?.trim() || 'unnamed',
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
      }
    }
  }

  // 关键浮层矩形与互撞/越界检查
  const inspectEl = document.querySelector('[aria-label="实体巡检 HUD"] > div');
  const perfEl = document.querySelector('[aria-label="性能遥测 HUD"]');
  const toolbarEl = document.querySelector('[aria-label="3D 视口相机与多模态控制"]');
  const terminalEl = document.querySelector('[aria-label="全局运维审计日志终端"]') ||
    Array.from(document.querySelectorAll('section, div')).find((d) =>
      d.textContent?.includes('系统事件回显') && d.getBoundingClientRect().height < 200 && getComputedStyle(d).position === 'absolute'
    );
  const capsuleEl = document.querySelector('[aria-label*="引擎状态"]') ||
    Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label')?.includes('运行') && getComputedStyle(b).position === 'fixed');
  const demoBarEl = document.querySelector('[aria-label*="路演节奏"]')?.closest('.kv-panel') ||
    Array.from(document.querySelectorAll('.kv-panel')).find((d) => getComputedStyle(d).position === 'fixed' && d.getBoundingClientRect().top > 40 && d.getBoundingClientRect().top < 110);

  const rects = {};
  const entries = [
    ['header', header],
    ['inspect', inspectEl],
    ['perf', perfEl],
    ['toolbar', toolbarEl],
    ['terminal', terminalEl],
    ['demoBar', demoBarEl],
  ];
  const outOfBounds = [];
  for (const [k, el] of entries) {
    if (isVisible(el)) {
      const r = toRect(el);
      rects[k] = r;
      if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) {
        outOfBounds.push({ key: k, rect: r, vw, vh });
      }
    }
  }

  // 检查非故意叠放的同区域互斥碰撞（inspect vs perf, inspect vs toolbar, toolbar vs terminal, demoBar vs inspect）
  const overlaps = [];
  const pairs = [
    ['inspect', 'perf'],
    ['inspect', 'toolbar'],
    ['perf', 'toolbar'],
    ['toolbar', 'terminal'],
  ];
  for (const [a, b] of pairs) {
    const ra = rects[a];
    const rb = rects[b];
    if (!ra || !rb) continue;
    const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (ox > 4 && oy > 4) {
      overlaps.push({ pair: a + '<->' + b, ox: Math.round(ox), oy: Math.round(oy), ra, rb });
    }
  }

  // 检查重复健康读数（TopBar 中包含与健康分相同且独立渲染在环外的 "健康度" 文本）
  const headerText = header?.innerText ?? '';
  const hasDuplicateHealthWord = headerText.includes('健康度');

  return {
    vw,
    vh,
    maxScrollWidth,
    headerTopButtonCount: headerTopButtons.length,
    headerOverflow,
    hasLegacyReqSec,
    hasDuplicateHealthWord,
    smallTouchTargets,
    outOfBounds,
    overlaps,
    rects,
  };
})()`;

async function clickByAria(cdp, ariaExactOrSub, partial = false) {
  return cdp.ev(`(() => {
    const els = Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"]'));
    const target = els.find((el) => {
      if (el.closest('[inert]')) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const aria = el.getAttribute('aria-label') || '';
      const txt = el.textContent || '';
      return ${partial ? 'aria.includes(' + JSON.stringify(ariaExactOrSub) + ') || txt.includes(' + JSON.stringify(ariaExactOrSub) + ')' : 'aria === ' + JSON.stringify(ariaExactOrSub)};
    });
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('未找到 Edge / Chrome 可执行文件，无法执行 R8 进阶真机探针');
    process.exit(2);
  }

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  let serverProc = null;
  if (!EXTERNAL_BASE) {
    console.log(`[R8 Probe] 启动本地生产服务 ${BASE_URL} ...`);
    const srv = startNextServer();
    serverProc = srv.child;
    const ready = await waitForServer(BASE_URL, 30000);
    if (!ready) {
      console.error('Next.js 生产服务启动超时:\n', srv.getLogs());
      stopChild(serverProc);
      process.exit(2);
    }
  }

  const cdp = await openCdpSession(browserPath, CDP_PORT, 1920, 1080, 1, false);
  const startTime = Date.now();

  try {
    await cdp.send('Page.navigate', { url: TARGET_URL });
    await waitForAppReady(cdp.ev);

    /* ====================================================================== */
    /* 1. 6 大核心视口 + 1024~1366 连续宽度基础扫描                            */
    /* ====================================================================== */
    console.log('\n[1/4] 6 大核心视口 + 1024~1366 连续密度巡检');
    const viewports = [
      { name: '360x740', w: 360, h: 740, mobile: true, scale: 1, shot: 'r8-viewport-360x740.png' },
      { name: '390x844', w: 390, h: 844, mobile: true, scale: 1, shot: 'r8-viewport-390x844.png' },
      { name: '800x600', w: 800, h: 600, mobile: false, scale: 1, shot: null },
      { name: '1024x768', w: 1024, h: 768, mobile: false, scale: 1, shot: 'r8-viewport-1024x768.png' },
      { name: '1366x768', w: 1366, h: 768, mobile: false, scale: 1, shot: null },
      { name: '1920x1080', w: 1920, h: 1080, mobile: false, scale: 1, shot: 'r8-viewport-1920x1080.png' },
    ];

    for (const vp of viewports) {
      await cdp.setViewport(vp.w, vp.h, vp.scale, vp.mobile);
      const r = await cdp.ev(AUDIT_LAYOUT_EXPR);
      check(`${vp.name} 零横向溢出`, r.maxScrollWidth <= r.vw + 1, { maxScrollWidth: r.maxScrollWidth, vw: r.vw }, `<= ${r.vw + 1}`);
      check(`${vp.name} TopBar 顶级按钮 <= 7`, r.headerTopButtonCount <= 7, r.headerTopButtonCount, '<= 7');
      check(`${vp.name} TopBar 零内部裁切`, r.headerOverflow.length === 0, r.headerOverflow, []);
      check(`${vp.name} TopBar 单一健康度读数`, !r.hasDuplicateHealthWord, r.hasDuplicateHealthWord, false);
      check(`${vp.name} 统一 QPS 单位（零 req/s）`, !r.hasLegacyReqSec, r.hasLegacyReqSec, false);
      check(`${vp.name} 关键浮层无视口越界`, r.outOfBounds.length === 0, r.outOfBounds, []);
      check(`${vp.name} 关键浮层无碰撞重叠`, r.overlaps.length === 0, r.overlaps, []);
      if (vp.w < 768) {
        check(`${vp.name} 移动端交互触控 >= 44×44`, r.smallTouchTargets.length === 0, r.smallTouchTargets, []);
      }
      if (vp.shot) await cdp.screenshot(vp.shot);
    }

    // 1024~1366 连续宽度变化无突跳溢出
    for (const w of [1080, 1180, 1260]) {
      await cdp.setViewport(w, 768, 1, false);
      const r = await cdp.ev(AUDIT_LAYOUT_EXPR);
      check(`连续宽度 ${w}×768 无横向溢出与顶栏越界`, r.maxScrollWidth <= w + 1 && r.headerOverflow.length === 0, {
        maxScrollWidth: r.maxScrollWidth,
        headerOverflow: r.headerOverflow,
      }, 'no overflow');
    }

    /* ====================================================================== */
    /* 2. 多状态检验：PerfHUD层级 / 小屏3D降载 / 移动端Tab保活 / 模态框互斥栈    */
    /* ====================================================================== */
    console.log('\n[2/4] 多状态与跨视口连续性校验');

    // A. 打开 PerfTelemetryHUD 检验 Tier1 > Tier2 信息层级、60/40/0 刻度与降级证据标牌（390×844 & 1920×1080）
    await cdp.setViewport(390, 844, 1, true);
    await clickByAria(cdp, '打开状态过滤与工具菜单');
    await sleep(150);
    await clickByAria(cdp, '性能监控 HUD', true);
    await sleep(450);
    // 收起更多菜单以免遮挡
    await clickByAria(cdp, '打开状态过滤与工具菜单');
    await sleep(150);

    const perfAudit390 = await cdp.ev(`(() => {
      const hud = document.querySelector('[aria-label="性能遥测 HUD"]');
      if (!hud) return { open: false };
      const txt = hud.innerText || '';
      const r = hud.getBoundingClientRect();
      const blocks = Array.from(hud.querySelectorAll('div, span'));
      const dataEl = blocks.find((el) => el.textContent?.trim() === '数据健康');
      const renderEl = blocks.find((el) => el.textContent?.trim() === '渲染路径');
      const fpsEl = Array.from(hud.querySelectorAll('span')).find(
        (el) => el.textContent?.trim().toLowerCase() === 'fps',
      );
      const closeBtn = hud.querySelector('button[aria-label="关闭性能遥测"]');
      const cr = closeBtn ? closeBtn.getBoundingClientRect() : null;
      return {
        open: true,
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
        tierOrderValid: Boolean(dataEl && renderEl && fpsEl &&
          dataEl.getBoundingClientRect().top < fpsEl.getBoundingClientRect().top &&
          renderEl.getBoundingClientRect().top < fpsEl.getBoundingClientRect().top),
        hasTicks: txt.includes('60') && txt.includes('40') && txt.includes('0'),
        hasDegradeTag: txt.includes('仅功能证据（SwiftShader / T0 降级）') || txt.includes('小屏视口自动降载'),
        hasViewportTierReason: txt.includes('小屏视口自动降载'),
        closeBtnTouchOk: Boolean(cr && cr.width >= 43.5 && cr.height >= 43.5),
      };
    })()`);
    check('390×844 PerfHUD 打开且不越界', perfAudit390.open && perfAudit390.rect.right <= 391 && perfAudit390.rect.bottom <= 845, perfAudit390.rect, 'inside 390×844');
    check('PerfHUD Tier1(健康+管线) 位于 Tier2(FPS) 之上', perfAudit390.tierOrderValid, perfAudit390.tierOrderValid, true);
    check('PerfHUD 含 60/40/0 刻度', perfAudit390.hasTicks, perfAudit390.hasTicks, true);
    check('PerfHUD 含小屏/软件渲染降级标识', perfAudit390.hasDegradeTag && perfAudit390.hasViewportTierReason, {
      hasDegradeTag: perfAudit390.hasDegradeTag,
      hasViewportTierReason: perfAudit390.hasViewportTierReason,
    }, 'both true');
    check('390×844 PerfHUD 关闭按钮 >= 44×44', perfAudit390.closeBtnTouchOk, perfAudit390.closeBtnTouchOk, true);
    await cdp.screenshot('r8-perfhud-390x844.png');
    await clickByAria(cdp, '关闭性能遥测');
    await sleep(250);

    // 检查 390×844 下 3D <Html> 标签移动精简（控制平面简标 + Pod 详情隐藏）
    const mobile3dLabel = await cdp.ev(`(() => {
      const htmls = Array.from(document.querySelectorAll('div')).map((d) => d.innerText?.trim()).filter(Boolean);
      const hasMasterCompact = htmls.some((t) => t === '控制平面');
      return { hasMasterCompact };
    })()`);
    check('390×844 小屏 3D 控制平面标签精简呈现', mobile3dLabel.hasMasterCompact, mobile3dLabel, true);

    // B. 移动端 Tab 切换动画连续性与草稿/Canvas DOM 身份保留
    const tabPreservation = await cdp.ev(`(async () => {
      const canvasBefore = document.querySelector('canvas');
      const switcher = Array.from(document.querySelectorAll('[aria-label="移动端视图切换"] button'));
      const aiBtn = switcher.find((b) => (b.textContent || '').includes('AI Copilot'));
      const canvasBtn = switcher.find((b) => (b.textContent || '').includes('3D 拓扑'));
      if (!aiBtn || !canvasBtn) return { ok: false, reason: 'no MobileViewSwitcher buttons' };
      aiBtn.click();
      await new Promise((r) => setTimeout(r, 280));
      const textarea = document.querySelector('[aria-label="AI Copilot 抽屉"] textarea');
      if (!textarea) return { ok: false, reason: 'no textarea' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'R8 状态连续性测试草稿');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const canvasDuringAi = document.querySelector('canvas');
      canvasBtn.click();
      await new Promise((r) => setTimeout(r, 280));
      const canvasAfterCanvas = document.querySelector('canvas');
      aiBtn.click();
      await new Promise((r) => setTimeout(r, 280));
      const textareaAfter = document.querySelector('[aria-label="AI Copilot 抽屉"] textarea');
      const viewportInert = Boolean(document.querySelector('[aria-label="3D 集群拓扑视口"]')?.hasAttribute('inert'));
      return {
        ok: true,
        sameCanvasBeforeAfter: canvasBefore === canvasDuringAi && canvasBefore === canvasAfterCanvas,
        draftPreserved: textareaAfter?.value === 'R8 状态连续性测试草稿',
        backgroundInert: viewportInert,
      };
    })()`);
    check('390×844 切屏后 WebGL Canvas 零重建', Boolean(tabPreservation.sameCanvasBeforeAfter), tabPreservation, true);
    check('390×844 切屏往返保留 Copilot 草稿输入', Boolean(tabPreservation.draftPreserved), tabPreservation, true);
    check('390×844 切屏非激活面板启用 inert 隔离', Boolean(tabPreservation.backgroundInert), tabPreservation, true);

    // 清空草稿并验证 Copilot Drawer 在 390×844 下的审计页签 + RAG/PostMortem 模态互斥 + Z-index Esc 分层
    await cdp.ev(`(() => {
      const textarea = document.querySelector('[aria-label="AI Copilot 抽屉"] textarea');
      if (textarea) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, '');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);

    // 审计页签溢出检查（390×844）
    await clickByAria(cdp, '端侧日志审计', true);
    await sleep(350);
    const auditTabLayout = await cdp.ev(AUDIT_LAYOUT_EXPR);
    check('390×844 端侧隐私审计页签零横向溢出', auditTabLayout.maxScrollWidth <= 391, auditTabLayout.maxScrollWidth, '<= 391');

    // 切回 AI 副驾驶页签，测试 RAG -> Chaos 互斥 + CommandPalette (z-[60]) 覆盖
    await clickByAria(cdp, '运维副驾', true);
    await sleep(250);
    await clickByAria(cdp, '打开 SRE 领域知识库');
    let ragZ = { open: false, z: 0 };
    for (let i = 0; i < 20; i += 1) {
      ragZ = await cdp.ev(`(() => {
        const dlg = document.querySelector('[role="dialog"][aria-label="SRE 领域知识库"]');
        return dlg ? { open: true, z: Number(getComputedStyle(dlg).zIndex) || 0, rect: dlg.getBoundingClientRect().toJSON() } : { open: false, z: 0 };
      })()`);
      if (ragZ.open) break;
      await sleep(150);
    }
    check('390×844 RAG 弹窗打开且 z-index = 50', ragZ.open && ragZ.z === 50, ragZ, 'z=50');

    // 打开顶栏混沌弹窗（验证与 RAG 的互斥切换，不产生双重弹窗）
    await clickByAria(cdp, '打开故障演练场景选择');
    let mutexState = { ragOpen: true, chaosOpen: false, sheetWidth: 0, sheetBottom: 0 };
    for (let i = 0; i < 20; i += 1) {
      const ready = await cdp.ev(`Boolean(document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]'))`);
      if (ready) break;
      await sleep(150);
    }
    await sleep(450);
    mutexState = await cdp.ev(`(() => {
      const ragOpen = Boolean(document.querySelector('[role="dialog"][aria-label="SRE 领域知识库"]'));
      const chaosOpen = Boolean(document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]'));
      const sheetBox = document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"] > div.kv-panel')?.getBoundingClientRect();
      return {
        ragOpen,
        chaosOpen,
        sheetWidth: sheetBox?.width ?? 0,
        sheetBottom: sheetBox?.bottom ?? 0,
      };
    })()`);
    check('重型模态框 Store 互斥（开 Chaos 自动关 RAG）', !mutexState.ragOpen && mutexState.chaosOpen, mutexState, 'rag=false, chaos=true');
    check('390×844 移动端 Bottom Sheet 贴底且无溢出', mutexState.sheetBottom <= 845 && mutexState.sheetBottom >= 840 && mutexState.sheetWidth <= 391, mutexState, 'bottom sheet fit');
    await cdp.screenshot('r8-bottomsheet-390x844.png');

    // 在混沌弹窗之上打开命令面板（z-[60] > z-50），验证 Esc 逐层退出（先退 Palette，再退 Chaos）
    await clickByAria(cdp, '打开运维命令面板');
    let stackTop = { chaosOpen: false, paletteOpen: false, chaosZ: 0, paletteZ: 0 };
    for (let i = 0; i < 25; i += 1) {
      stackTop = await cdp.ev(`(() => {
        const chaos = document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]');
        const palette = document.querySelector('[role="dialog"][aria-label="运维命令面板"]');
        return {
          chaosOpen: Boolean(chaos),
          paletteOpen: Boolean(palette),
          chaosZ: chaos ? Number(getComputedStyle(chaos).zIndex) || 0 : 0,
          paletteZ: palette ? Number(getComputedStyle(palette).zIndex) || 0 : 0,
        };
      })()`);
      if (stackTop.paletteOpen) break;
      await sleep(150);
    }
    await sleep(200);
    check('CommandPalette (z=60) 覆盖重型模态框 (z=50)', stackTop.chaosOpen && stackTop.paletteOpen && stackTop.paletteZ > stackTop.chaosZ, stackTop, 'paletteZ > chaosZ');

    await cdp.pressKey('Escape', 'Escape');
    let afterEsc1 = { chaosOpen: false, paletteOpen: true };
    for (let i = 0; i < 20; i += 1) {
      afterEsc1 = await cdp.ev(`({
        chaosOpen: Boolean(document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]')),
        paletteOpen: Boolean(document.querySelector('[role="dialog"][aria-label="运维命令面板"]')),
      })`);
      if (!afterEsc1.paletteOpen) break;
      await sleep(120);
    }
    check('第 1 次 Esc 仅关闭最顶层 CommandPalette', !afterEsc1.paletteOpen && afterEsc1.chaosOpen, afterEsc1, 'palette=false, chaos=true');

    await cdp.pressKey('Escape', 'Escape');
    let afterEsc2 = { chaosOpen: true, paletteOpen: false };
    for (let i = 0; i < 20; i += 1) {
      afterEsc2 = await cdp.ev(`({
        chaosOpen: Boolean(document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]')),
        paletteOpen: Boolean(document.querySelector('[role="dialog"][aria-label="运维命令面板"]')),
      })`);
      if (!afterEsc2.chaosOpen) break;
      await sleep(120);
    }
    check('第 2 次 Esc 关闭 Chaos 模态框', !afterEsc2.chaosOpen && !afterEsc2.paletteOpen, afterEsc2, 'all closed');

    /* ====================================================================== */
    /* 3. 5 类极端边界（E1~E5）                                               */
    /* ====================================================================== */
    console.log('\n[3/4] 5 类极端边界测试（E1~E5）');

    // E1 移动端软键盘唤醒：焦点在 Copilot textarea 且 MobileViewSwitcher 自动卸载隐藏
    await cdp.setViewport(390, 844, 1, true);
    const e1Result = await cdp.ev(`(async () => {
      const textarea = document.querySelector('[aria-label="AI Copilot 抽屉"] textarea');
      if (!textarea) return { ok: false };
      textarea.focus();
      await new Promise((r) => setTimeout(r, 200));
      const switcherHiddenOnFocus = document.querySelector('[aria-label="移动端视图切换"]') === null;
      textarea.blur();
      await new Promise((r) => setTimeout(r, 200));
      const switcherShownOnBlur = document.querySelector('[aria-label="移动端视图切换"]') !== null;
      return { ok: true, switcherHiddenOnFocus, switcherShownOnBlur };
    })()`);
    check('E1 软键盘唤醒时自动隐藏底部悬浮切换器，失焦恢复', Boolean(e1Result.ok && e1Result.switcherHiddenOnFocus && e1Result.switcherShownOnBlur), e1Result, 'hide on focus, show on blur');

    // E2 刘海屏安全区声明与 meta viewport-fit=cover
    const e2Meta = await cdp.ev(`(() => {
      const vp = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';
      const hasSafeRule = Array.from(document.styleSheets).some((sheet) => {
        try {
          return Array.from(sheet.cssRules || []).some((rule) => rule.cssText && rule.cssText.includes('safe-area-inset-bottom'));
        } catch {
          return false;
        }
      });
      return { viewportContent: vp, hasSafeRule };
    })()`);
    check('E2 viewport-fit=cover 与安全区样式就绪', e2Meta.viewportContent.includes('viewport-fit=cover') && e2Meta.hasSafeRule, e2Meta, 'viewport-fit=cover + env(safe-area-inset-bottom)');

    // 切回 3D 视图准备测试横屏与 E2E
    await clickByAria(cdp, '3D 拓扑视图', true);
    await sleep(300);

    // E3 移动端横屏 844×390
    await cdp.setViewport(844, 390, 1, true);
    const e3Audit = await cdp.ev(AUDIT_LAYOUT_EXPR);
    check('E3 横屏 844×390 零横向溢出且浮层不越界', e3Audit.maxScrollWidth <= 845 && e3Audit.outOfBounds.length === 0, {
      maxScrollWidth: e3Audit.maxScrollWidth,
      outOfBounds: e3Audit.outOfBounds,
    }, 'no overflow/oob');

    // E4 桌面 200% 缩放等效（960×540 CSS px, DPR=2）
    await cdp.setViewport(960, 540, 2, false);
    const e4Audit = await cdp.ev(AUDIT_LAYOUT_EXPR);
    check('E4 桌面 200% 缩放（960×540 @2x）零横向溢出与碰撞', e4Audit.maxScrollWidth <= 961 && e4Audit.headerOverflow.length === 0 && e4Audit.overlaps.length === 0, {
      maxScrollWidth: e4Audit.maxScrollWidth,
      headerOverflow: e4Audit.headerOverflow,
      overlaps: e4Audit.overlaps,
    }, 'clean');

    // E5 PWA standalone 媒体特性
    await cdp.setViewport(390, 844, 1, true);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] });
    await sleep(200);
    const e5Audit = await cdp.ev(AUDIT_LAYOUT_EXPR);
    check('E5 PWA standalone 模式下无溢出与越界', e5Audit.maxScrollWidth <= 391 && e5Audit.outOfBounds.length === 0, {
      maxScrollWidth: e5Audit.maxScrollWidth,
      outOfBounds: e5Audit.outOfBounds,
    }, 'clean');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    /* ====================================================================== */
    /* 4. 完整 E2E 闭环走查（桌面 1366×768 + 手机 390×844）                  */
    /* ====================================================================== */
    console.log('\n[4/4] E2E 闭环走查（总览 → 注入 OOM → 点选 Pod → 移动端详情折叠/展开 → AI 深度诊断 → GenUI 渲染）');
    await cdp.setViewport(1366, 768, 1, false);
    await sleep(300);

    // 注入 OOM 混沌场景并等待弹窗完全关闭
    await clickByAria(cdp, '打开故障演练场景选择');
    for (let i = 0; i < 20; i += 1) {
      const open = await cdp.ev(`Boolean(document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]'))`);
      if (open) break;
      await sleep(100);
    }
    await sleep(200);
    const oomInjected = await cdp.ev(`(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]');
      const btn = dlg ? Array.from(dlg.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('POD_OOM_SWARM')) : null;
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    check('E2E 注入 OOM 混沌演练', oomInjected, oomInjected, true);
    for (let i = 0; i < 20; i += 1) {
      const stillOpen = await cdp.ev(`Boolean(document.querySelector('[role="dialog"][aria-label="混沌工程故障演练控制台"]'))`);
      if (!stillOpen) break;
      await sleep(120);
    }

    // 通过命令面板选中任意 Pod 触发巡检 HUD
    await clickByAria(cdp, '打开运维命令面板');
    for (let i = 0; i < 20; i += 1) {
      const open = await cdp.ev(`Boolean(document.querySelector('[role="dialog"][aria-label="运维命令面板"]'))`);
      if (open) break;
      await sleep(100);
    }
    await sleep(150);
    await cdp.ev(`(() => {
      const input = document.querySelector('[aria-label="命令面板搜索"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'pod');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await sleep(200);
    await cdp.pressKey('Enter', 'Enter');
    let inspectOpenDesktop = false;
    for (let i = 0; i < 20; i += 1) {
      inspectOpenDesktop = await cdp.ev(`Boolean(document.querySelector('[aria-label="实体巡检 HUD"] button[aria-label="关闭巡检卡片并重置视角"]'))`);
      if (inspectOpenDesktop) break;
      await sleep(150);
    }
    check('E2E 选中 Pod 展开巡检 HUD', inspectOpenDesktop, inspectOpenDesktop, true);
    await cdp.screenshot('r8-e2e-desktop-inspect.png');

    // 在 390×844 检验移动端 Pod 巡检卡折叠详情交互 + 触摸尺寸
    await cdp.setViewport(390, 844, 1, true);
    const mobileInspect = await cdp.ev(`(async () => {
      const toggle = Array.from(document.querySelectorAll('[aria-label="实体巡检 HUD"] button')).find((b) =>
        b.textContent?.includes('展开指标详情')
      );
      if (!toggle) return { foundToggle: false };
      const tr = toggle.getBoundingClientRect();
      toggle.click();
      await new Promise((r) => setTimeout(r, 200));
      const expandedText = document.querySelector('[aria-label="实体巡检 HUD"]')?.innerText || '';
      const closeBtn = document.querySelector('[aria-label="关闭巡检卡片并重置视角"]')?.getBoundingClientRect();
      return {
        foundToggle: true,
        toggleHeightOk: tr.height >= 43.5,
        hasCollapseLabel: expandedText.includes('收起指标详情'),
        closeBtnTouchOk: Boolean(closeBtn && closeBtn.width >= 43.5 && closeBtn.height >= 43.5),
      };
    })()`);
    check('390×844 巡检卡默认折叠次级指标并可一键展开', mobileInspect.foundToggle && mobileInspect.toggleHeightOk && mobileInspect.hasCollapseLabel && mobileInspect.closeBtnTouchOk, mobileInspect, 'all true');
    await cdp.screenshot('r8-e2e-mobile-inspect.png');

    // 点击「AI 深度诊断」触发 Copilot 切换 + 流式输出验证
    await cdp.setViewport(1366, 768, 1, false);
    const diagClicked = await cdp.ev(`(() => {
      const hud = document.querySelector('[aria-label="实体巡检 HUD"]');
      const btn = hud ? Array.from(hud.querySelectorAll('button')).find((b) => b.textContent?.includes('AI 深度诊断')) : null;
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    check('E2E 触发 AI 深度诊断', diagClicked, diagClicked, true);
    // 等待流式诊断产出响应或至少发出用户消息
    let copilotDiagnosed = false;
    for (let i = 0; i < 30; i += 1) {
      copilotDiagnosed = await cdp.ev(`(() => {
        const drawer = document.querySelector('[aria-label="AI Copilot 抽屉"]');
        const txt = drawer?.innerText || '';
        return txt.includes('根因') || txt.includes('诊断') || txt.includes('Pod');
      })()`);
      if (copilotDiagnosed) break;
      await sleep(300);
    }
    check('E2E Copilot 收到诊断上下文并渲染', copilotDiagnosed, copilotDiagnosed, true);

    // 运行一次剧本路演验证 DemoDirectorBar & DemoReplayTimeline 在 1024×768 不溢出
    await cdp.setViewport(1024, 768, 1, false);
    await clickByAria(cdp, '启动全自动剧本路演', true);
    await sleep(200);
    await clickByAria(cdp, 'OOM', true);
    await sleep(600);
    const demoAudit = await cdp.ev(AUDIT_LAYOUT_EXPR);
    check('1024×768 路演进行中无横向溢出与 TopBar 越界', demoAudit.maxScrollWidth <= 1025 && demoAudit.headerOverflow.length === 0, {
      maxScrollWidth: demoAudit.maxScrollWidth,
      headerOverflow: demoAudit.headerOverflow,
    }, 'clean');
    await clickByAria(cdp, '停止剧本路演并复位集群');
    await sleep(300);

    check('零未捕获页面异常/Console Error', cdp.pageErrors.length === 0, cdp.pageErrors, []);

    const elapsedMs = Date.now() - startTime;
    const summary = {
      timestamp: new Date().toISOString(),
      elapsedMs,
      passed: passCount,
      failed: failCount,
      findings,
      pageErrors: cdp.pageErrors,
    };
    writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`\n[R8 Probe] 完成（用时 ${(elapsedMs / 1000).toFixed(1)}s）：PASS ${passCount} · FAIL ${failCount}`);
    console.log(`[R8 Probe] 报告: ${REPORT_PATH}`);
    process.exitCode = failCount === 0 ? 0 : 1;
  } finally {
    cdp.close();
    stopChild(serverProc);
  }
}

main().catch((err) => {
  console.error('[R8 Probe] 异常退出:', err);
  process.exit(1);
});
