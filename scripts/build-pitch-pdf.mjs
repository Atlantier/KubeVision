#!/usr/bin/env node
/**
 * KubeVision AI — 路演 PPT 导出 PDF（R55）
 *
 * 源文件：docs/pitch/index.html（12 页，1280×720 逻辑尺寸，@page 已设）
 * 产物：docs/KubeVision_PITCH.pdf
 * 校验：文件存在、体积 ≤10MB。
 *
 * 用法：node scripts/build-pitch-pdf.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SRC = join(ROOT, 'docs/pitch/index.html');
const OUT = join(ROOT, 'docs/KubeVision_PITCH.pdf');
const MAX_BYTES = 10 * 1024 * 1024;

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (browser === undefined) {
  console.error('[FATAL] 未找到 Chrome / Edge，无法打印 PDF');
  process.exit(1);
}
if (!existsSync(SRC)) {
  console.error('[FATAL] 缺少 docs/pitch/index.html');
  process.exit(1);
}

const url = pathToFileURL(SRC).href;
console.log('KubeVision AI — 路演 PPT 导出');
console.log('  源文件:', SRC);
console.log('  产物  :', OUT);

const result = spawnSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--allow-file-access-from-files',
    '--virtual-time-budget=12000',
    `--print-to-pdf=${OUT}`,
    url,
  ],
  { stdio: 'inherit' },
);

if (result.status !== 0 || !existsSync(OUT)) {
  console.error('[FATAL] PDF 生成失败，exit=', result.status);
  process.exit(1);
}

const size = statSync(OUT).size;
const sizeMb = size / 1024 / 1024;
console.log(`  PDF 体积: ${sizeMb.toFixed(2)} MB`);
if (size > MAX_BYTES) {
  console.error('[FATAL] PDF 超过 10MB 限制');
  process.exit(1);
}
console.log('  ✓ 已生成（12 页：封面 → 价值 → 痛点 → 架构 → 三大亮点 → 空间绑定 → 端侧 → 工程数据 → 证据×2 → 商业 → 团队）');