#!/usr/bin/env node
/**
 * KubeVision AI — 技术白皮书 PDF 构建脚本
 *
 * 【为何需要这个脚本】白皮书 Markdown 会随项目演进更新。若只提交一份 PDF
 * 而不留下生成方式，下次改完 Markdown 后 PDF 会**静默过期**——读者拿到的是
 * 旧内容，且没人知道怎么重新生成。产物与生成方式必须一起进仓库。
 *
 * 【管线】Markdown → pandoc HTML5 → Chrome 无头打印 → PDF
 *
 * 为何不走 pandoc 直接出 PDF：本机没有 LaTeX 引擎（pdflatex / xelatex /
 * tectonic 均未安装），pandoc 的 PDF 输出强依赖 LaTeX。改用浏览器打印的好处是
 * 中文字体与 MathML 都由 Chrome 原生处理，不依赖系统 TeX 发行版。
 *
 * 【公式：用 MathML 而非 MathJax】
 * pandoc 的 `--mathml` 直接输出 `<math>` 元素，Chrome 113+ 原生渲染。
 * 这比引入 MathJax 更稳：无 CDN 依赖、无需等待异步排版，
 * 打印时不会出现"公式还没排版好就被截图"的空缺。
 * （曾试过 MathJax：pandoc 输出的公式被包在 span 里，MathJax 只扫描
 *  文本节点的定界符，导致 88 个公式仅 43 个被渲染。）
 *
 * 【图：Mermaid 走 CDN】12 张架构图需要 mermaid.js 在浏览器里渲染成 SVG。
 * 这一步依赖网络；离线环境下图会退化为源码文本块（脚本会输出失败计数）。
 *
 * 用法：
 *   node scripts/build-whitepaper-pdf.mjs
 * 产物：
 *   docs/COMPETITION_TECHNICAL_WHITEPAPER.pdf
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = 'docs/COMPETITION_TECHNICAL_WHITEPAPER.md';
const OUTPUT = join(process.cwd(), 'docs/COMPETITION_TECHNICAL_WHITEPAPER.pdf');

/** 临时工作目录（构建结束即清理，不污染仓库） */
const workDir = mkdtempSync(join(tmpdir(), 'kv-whitepaper-'));
const fragmentPath = join(workDir, 'fragment.html');
const printPath = join(workDir, 'print.html');

/** 依次探测可用的 Chromium 内核浏览器 */
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const browser = BROWSER_CANDIDATES.find((p) => existsSync(p));
if (browser === undefined) {
  console.error('未找到 Chrome / Edge，无法打印 PDF');
  process.exit(1);
}

/* ---- 1. pandoc：Markdown → HTML5 片段（公式转 MathML） ---- */
console.log('[1/3] pandoc 转换 Markdown → HTML5');
execFileSync(
  'pandoc',
  [
    SRC,
    '-f', 'gfm+tex_math_dollars',
    '-t', 'html5',
    '--mathml',
    '--wrap=none',
    '--no-highlight',
    '-o', fragmentPath,
  ],
  { stdio: 'inherit' },
);

const fragment = readFileSync(fragmentPath, 'utf8');

/* ---- 2. 包一层 A4 打印模板 ---- */
console.log('[2/3] 套用 A4 打印模板');
const template = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>KubeVision AI 技术白皮书</title>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    themeVariables: { fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif', fontSize: '13px' },
    flowchart: { useMaxWidth: true, htmlLabels: true },
    sequence: { useMaxWidth: true },
  });
  window.__mermaidReady = false;
  window.__mermaidFailed = 0;
  window.addEventListener('DOMContentLoaded', async () => {
    const blocks = Array.from(document.querySelectorAll('pre.mermaid'));
    for (const el of blocks) {
      try {
        const code = el.textContent || '';
        const { svg } = await mermaid.render('m' + Math.random().toString(36).slice(2), code);
        const wrap = document.createElement('div');
        wrap.className = 'mermaid-rendered';
        wrap.innerHTML = svg;
        el.replaceWith(wrap);
      } catch (e) {
        el.textContent = '[Mermaid 渲染失败] ' + (e && e.message ? e.message : '');
        window.__mermaidFailed += 1;
      }
    }
    window.__mermaidReady = true;
  });
</script>
<style>
  @page { size: A4; margin: 18mm 16mm 16mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif;
    font-size: 10.5pt;
    line-height: 1.65;
    color: #1a1a1a;
    margin: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4 { font-weight: 700; line-height: 1.3; page-break-after: avoid; }
  h1 { font-size: 22pt; margin: 0 0 10pt; border-bottom: 2pt solid #0e7490; padding-bottom: 6pt; color: #0e7490; }
  h2 { font-size: 15pt; margin: 20pt 0 8pt; padding-left: 8pt; border-left: 4pt solid #0891b2; color: #0c4a6e; }
  h3 { font-size: 12.5pt; margin: 14pt 0 6pt; color: #155e75; }
  h4 { font-size: 11pt; margin: 10pt 0 4pt; color: #334155; }
  p { margin: 5pt 0; }
  ul, ol { margin: 5pt 0; padding-left: 18pt; }
  li { margin: 2pt 0; }
  strong { font-weight: 700; color: #0f172a; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 9pt; page-break-inside: auto; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th, td { border: 0.5pt solid #cbd5e1; padding: 3.5pt 5pt; text-align: left; vertical-align: top; }
  th { background: #e0f2fe; font-weight: 700; color: #0c4a6e; }
  code {
    font-family: "Cascadia Mono", "Consolas", monospace;
    font-size: 0.9em;
    background: #f1f5f9;
    padding: 0.5pt 3pt;
    border-radius: 2pt;
    color: #be123c;
  }
  pre {
    background: #f8fafc;
    border: 0.5pt solid #e2e8f0;
    border-left: 3pt solid #0891b2;
    padding: 7pt 9pt;
    overflow-x: auto;
    font-size: 8.5pt;
    line-height: 1.5;
    page-break-inside: avoid;
  }
  pre code { background: none; padding: 0; color: #1e293b; }
  blockquote {
    margin: 8pt 0;
    padding: 6pt 10pt;
    background: #f0f9ff;
    border-left: 3pt solid #0ea5e9;
    color: #0c4a6e;
    page-break-inside: avoid;
  }
  blockquote p { margin: 3pt 0; }
  hr { border: none; border-top: 0.5pt solid #cbd5e1; margin: 12pt 0; }
  .mermaid-rendered { margin: 10pt 0; text-align: center; page-break-inside: avoid; }
  .mermaid-rendered svg { max-width: 100%; height: auto; }
  pre.mermaid { display: none; }
  math { font-size: 1.02em; font-family: "Cambria Math", "Latin Modern Math", serif; }
  math[display="block"] { display: block; margin: 8pt auto; text-align: center; page-break-inside: avoid; }
  p > math, li > math { vertical-align: baseline; }
  a { color: #0369a1; text-decoration: none; }
</style>
</head>
<body>
${fragment}
</body>
</html>`;

writeFileSync(printPath, template, 'utf8');

/* ---- 3. Chrome 无头打印 ---- */
console.log('[3/3] Chrome 无头打印 PDF');
const profileDir = mkdtempSync(join(tmpdir(), 'kv-pdf-profile-'));
const fileUrl = `file:///${printPath.replace(/\\/g, '/')}`;

try {
  execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      `--user-data-dir=${profileDir}`,
      /* 给 Mermaid CDN 渲染留足时间；太小会导致图为空 */
      '--virtual-time-budget=40000',
      '--run-all-compositor-stages-before-draw',
      '--no-pdf-header-footer',
      `--print-to-pdf=${OUTPUT}`,
      fileUrl,
    ],
    { stdio: 'inherit' },
  );
} catch {
  /* Chrome 打印成功时仍可能以非零码退出（扩展加载告警），产物存在即视为成功 */
}

if (!existsSync(OUTPUT)) {
  console.error('PDF 生成失败：产物不存在');
  rmSync(workDir, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
  process.exit(1);
}

const pdfBytes = readFileSync(OUTPUT);
const pages = (pdfBytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
console.log(`\n生成完成：${OUTPUT}`);
console.log(`  大小 ${Math.round(pdfBytes.length / 1024)} KB · ${pages} 页`);

rmSync(workDir, { recursive: true, force: true });
rmSync(profileDir, { recursive: true, force: true });

if (pages > 30) {
  console.warn(`  警告：${pages} 页超出赛道要求的 30 页上限`);
}
