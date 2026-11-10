#!/usr/bin/env node
/**
 * KubeVision AI — 验收证据采集（scripts/capture-evidence.mjs）
 *
 * 【解决什么问题】README 里"32 项检查全绿"是手写的数字，既没有出处也无法复现：
 * 实际跑了多少项、通过几项、跳过几项，评审无从核对。
 *
 * 【本脚本做三件事】
 * 1. 真实执行 `node scripts/verify.mjs`，完整捕获终端输出并原样回显；
 * 2. 解析汇总行，写出 `docs/verify-summary.json`（供 sync-docs-metrics 使用）
 *    与 `docs/evidence/verify-<时间戳>.log`（可追溯的原始日志）；
 * 3. 把终端输出渲染成深色终端样式页面，用 headless Edge 截图，落盘
 *    `docs/evidence/verify-<时间戳>.png`——即"终端输出截图"这一交付物。
 *
 * 【为什么截图要自己渲染 HTML】CI/无头环境没有真实终端窗口可截；
 * 把文本渲染成终端样式再截图，既保留等宽排版与颜色语义，又完全可复现。
 *
 * 【用法】
 *   node scripts/capture-evidence.mjs              # 跑完整验收并截图
 *   node scripts/capture-evidence.mjs --quick      # 只用 --quick 验收
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const QUICK = process.argv.includes('--quick');
const EVIDENCE_DIR = join(ROOT, 'docs/evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(EVIDENCE_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');

/**
 * 去掉 ANSI 颜色控制符（日志文件里保留可读性，截图时再单独上色）。
 *
 * @param text 原文本
 * @returns 纯文本
 */
function stripAnsi(text) {
  /* eslint-disable-next-line no-control-regex */
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/* ========================================================================== */
/* 1. 执行验收并捕获输出                                                        */
/* ========================================================================== */

console.log('KubeVision AI — 验收证据采集');
console.log(`  命令: node scripts/verify.mjs${QUICK ? ' --quick' : ''}`);
console.log('  （完整验收需要启动 dev server 与浏览器，约 2~4 分钟）\n');

const args = ['scripts/verify.mjs'];
if (QUICK) args.push('--quick');

const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

let rawOutput = '';
child.stdout.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  rawOutput += text;
  process.stdout.write(text);
});
child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  rawOutput += text;
  process.stderr.write(text);
});

const exitCode = await new Promise((resolve) => {
  child.on('exit', (code) => resolve(code ?? 1));
  child.on('error', () => resolve(1));
});

const plain = stripAnsi(rawOutput);

/* ========================================================================== */
/* 2. 解析汇总并落盘                                                            */
/* ========================================================================== */

/**
 * 从验收输出里解析汇总行。
 *
 * 【容错】汇总行格式为
 *   `总计 34 项 · 通过 34 · 失败 0 · 跳过 0`
 * 若因异常未打印汇总，则回退为 exitCode 判定的 0/1，并在 summary 里标注。
 *
 * @param text 纯文本输出
 * @param code 子进程退出码
 * @returns {{total:number,pass:number,fail:number,skip:number,parsed:boolean}}
 */
function parseSummary(text, code) {
  const match = /总计\s*(\d+)\s*项\s*·\s*通过\s*(\d+)\s*·\s*失败\s*(\d+)\s*·\s*跳过\s*(\d+)/.exec(text);
  if (match !== null) {
    return {
      total: Number(match[1]),
      pass: Number(match[2]),
      fail: Number(match[3]),
      skip: Number(match[4]),
      parsed: true,
    };
  }
  return { total: 0, pass: 0, fail: code === 0 ? 0 : 1, skip: 0, parsed: false };
}

const parsed = parseSummary(plain, exitCode);
const logPath = join(EVIDENCE_DIR, `verify-${stamp}.log`);
writeFileSync(logPath, plain, 'utf8');

const summary = {
  generatedAt: new Date().toISOString(),
  command: `node scripts/verify.mjs${QUICK ? ' --quick' : ''}`,
  exitCode,
  ...parsed,
  log: `docs/evidence/verify-${stamp}.log`,
  screenshot: `docs/evidence/verify-${stamp}.png`,
};
writeFileSync(join(ROOT, 'docs/verify-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log(`\n  汇总: 总计 ${summary.total} 项 · 通过 ${summary.pass} · 失败 ${summary.fail} · 跳过 ${summary.skip}`);
console.log(`  日志: ${summary.log}`);

/* ========================================================================== */
/* 3. 渲染终端截图                                                              */
/* ========================================================================== */

/**
 * 把纯文本包装成深色终端样式的 HTML。
 *
 * @param text 纯文本（已去 ANSI）
 * @returns 完整 HTML 文档
 */
function renderHtml(text) {
  /* 只取尾部 70 行：截图要能看清汇总，不需要几百行滚动内容 */
  const lines = text.split('\n').filter((line) => line.trim().length > 0).slice(-70);
  const body = lines
    .map((line) => {
      const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      let cls = 'ok';
      if (/✗|失败|FATAL|异常/.test(line)) cls = 'bad';
      else if (/✓|通过|全部关键能力/.test(line)) cls = 'good';
      else if (/▸|阶段|模式:/.test(line)) cls = 'section';
      return `<div class="${cls}">${escaped}</div>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>KubeVision 验收输出</title>
<style>
  body { margin: 0; background: #0b1120; color: #cbd5e1; font: 13px/1.55 "Cascadia Code", "Consolas", monospace; }
  .frame { padding: 18px 22px 26px; }
  .titlebar { display: flex; gap: 8px; align-items: center; padding-bottom: 12px; border-bottom: 1px solid #1e293b; margin-bottom: 14px; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .r { background: #ef4444; } .y { background: #f59e0b; } .g { background: #22c55e; }
  .name { margin-left: 10px; color: #64748b; font-size: 12px; }
  .ok { color: #cbd5e1; white-space: pre-wrap; }
  .good { color: #34d399; white-space: pre-wrap; }
  .bad { color: #fb7185; white-space: pre-wrap; }
  .section { color: #22d3ee; white-space: pre-wrap; font-weight: 600; }
  .foot { margin-top: 14px; padding-top: 10px; border-top: 1px solid #1e293b; color: #64748b; font-size: 11px; }
</style></head>
<body><div class="frame">
  <div class="titlebar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span class="name">kubevision — node scripts/verify.mjs — ${new Date().toISOString()}</span></div>
  ${body}
  <div class="foot">截图由 scripts/capture-evidence.mjs 自动生成 · 对应日志 ${summary.log} · 退出码 ${exitCode}</div>
</div></body></html>`;
}

const htmlPath = join(EVIDENCE_DIR, `.terminal-${stamp}.html`);
const pngPath = join(EVIDENCE_DIR, `verify-${stamp}.png`);
writeFileSync(htmlPath, renderHtml(plain), 'utf8');

/**
 * 用 headless Edge 打开 HTML 并截图。
 *
 * @returns {Promise<boolean>} 是否成功
 */
async function shoot() {
  const EDGE = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
  if (EDGE === undefined) return false;

  const port = 9360;
  const userDataDir = join(process.env.TEMP ?? '/tmp', `kv-evidence-${Date.now()}`);
  const browser = spawn(
    EDGE,
    [
      '--headless=new',
      '--no-first-run',
      '--hide-scrollbars',
      '--window-size=1280,2200',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    let target = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
        target = list.find((t) => t.type === 'page') ?? null;
        if (target !== null) break;
      } catch {
        /* 等浏览器起来 */
      }
      await sleep(400);
    }
    if (target === null) return false;

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let nextId = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 2200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.navigate', { url: `file:///${htmlPath.replace(/\\/g, '/')}` });
    await sleep(900);
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const base64 = result?.result?.data;
    ws.close();
    if (typeof base64 !== 'string' || base64.length === 0) return false;
    writeFileSync(pngPath, Buffer.from(base64, 'base64'));
    return true;
  } finally {
    try {
      browser.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

const shotOk = await shoot();
console.log(shotOk ? `  截图: ${summary.screenshot}` : '  [warn] 截图失败（日志仍已保存）');

try {
  unlinkSync(htmlPath);
} catch {
  /* 临时 HTML 已被清理 */
}
process.exit(exitCode);