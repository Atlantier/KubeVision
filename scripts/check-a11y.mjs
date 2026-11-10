#!/usr/bin/env node
/**
 * KubeVision AI — 设计系统 / 可访问性静态检查（R31 · G）
 *
 * 扫描 src/：
 *  1. 小于 10px 的任意字号（`text-[Npx]` 与 `fontSize: N`）；
 *  2. icon-only `<button>` 缺少 aria-label（按钮内无可见文本且无 aria-label/aria-labelledby）；
 *  3. 已禁用的 slate-600 / slate-700 颜色用法；
 *  4. 手写 `backdrop-blur-*`（应改用 kv-blur-panel / kv-blur-chip 令牌）。
 *
 * 退出码：0 = 无命中；1 = 有命中（可纳入 verify）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx|ts)$/.test(entry.name)) files.push(full);
  }
}
walk(ROOT);

const hits = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const relative = file.replace(process.cwd() + '\\', '').replace(process.cwd() + '/', '');

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    /* 1. 小字号 */
    for (const match of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
      if (Number(match[1]) < 10) {
        hits.push({ kind: 'small-font', file: relative, line: lineNo, detail: match[0] });
      }
    }
    for (const match of line.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)) {
      if (Number(match[1]) < 10) {
        hits.push({ kind: 'small-font', file: relative, line: lineNo, detail: match[0] });
      }
    }

    /* 2. slate-600/700 */
    for (const match of line.matchAll(/slate-(600|700)/g)) {
      hits.push({ kind: 'legacy-color', file: relative, line: lineNo, detail: match[0] });
    }

    /* 3. 手写 backdrop-blur */
    for (const match of line.matchAll(/backdrop-blur-[a-z0-9[\]-]*/g)) {
      hits.push({ kind: 'blur-raw', file: relative, line: lineNo, detail: match[0] });
    }
  });

  /* 4. icon-only 按钮缺 aria-label（跨行标签配对） */
  const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  for (const match of source.matchAll(buttonRe)) {
    const attrs = match[1];
    const body = match[2];
    if (/aria-label\s*=/.test(attrs) || /aria-labelledby\s*=/.test(attrs)) continue;
    const visibleText = body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const hasIcon = /<(svg|Icon|HiOutline|Fi|Lucide)/.test(body);
    if (visibleText.length === 0 && hasIcon) {
      const lineNo = source.slice(0, match.index).split('\n').length;
      hits.push({ kind: 'a11y-icon-button', file: relative, line: lineNo, detail: '<button> 有图标但无 aria-label' });
    }
  }
}

const grouped = new Map();
for (const hit of hits) {
  const key = hit.kind;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(hit);
}

console.log('KubeVision AI — 设计系统 / 可访问性检查');
console.log(`  扫描文件: ${files.length} 个 · 命中: ${hits.length}`);
for (const [kind, list] of grouped) {
  console.log(`\n  [${kind}] ${list.length} 处`);
  for (const hit of list.slice(0, 20)) {
    console.log(`    ${hit.file}:L${hit.line}  ${hit.detail}`);
  }
  if (list.length > 20) console.log(`    … 其余 ${list.length - 20} 处省略`);
}
if (hits.length === 0) console.log('\n  ✓ 0 命中，通过');
else console.log('\n  ✗ 存在命中（见上）');
process.exit(hits.length === 0 ? 0 : 1);