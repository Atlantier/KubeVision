#!/usr/bin/env node
/**
 * KubeVision AI — 死导出守卫（R52 · 追问 2）
 *
 * 【只对"新增死代码"失败】清点 `src/**` 中所有具名导出，统计每个名字在
 * `src/**` 内的引用数；引用数 <= 1（只有定义本身）视为"死导出"。
 * 现有死导出记录在 `docs/dead-exports-baseline.json`，作为存量基线：
 *  - 新增死导出（不在基线里）→ exit 1；
 *  - 基线里已被修掉的（stale）→ 只提示，建议执行 --update-baseline；
 *  - `--update-baseline` 重写基线（人工确认后使用，不要在 CI 里自动跑）。
 *
 * 【为何要基线而不是"必须 0 死导出"】大型项目里总会有框架约定/动态引用导致的
 * 静态不可见残留；一刀切 0 会逼着开发者加各种假引用。基线的语义是
 * "存量可解释、增量零容忍"。
 *
 * 【引用统计的覆盖范围】导出从 `src/**` 清点，但**引用**还统计
 * `scripts/**` 与 `tailwind.config.ts`——验证脚本（如 verify-telemetry 调
 * clearFrameBuffer）与构建配置（如 tailwind.config 用 TYPE_SCALE）是这些导出的
 * 合法消费者。只数 src 会把"被脚本/配置真实使用"的导出误判成死代码。
 *
 * 【静态分析的已知边界】
 *  - 只做单词边界文本匹配；文档/注释里的同名字样也会被计入（已知误差）；
 *  - 通过字符串/反射/动态 import 变量名的引用无法识别（会在报告中注明）；
 *  - 框架入口（route.ts 的 GET/POST 等、page.tsx 的 default）自动豁免。
 *
 * 用法：
 *   node scripts/check-dead-exports.mjs
 *   node scripts/check-dead-exports.mjs --update-baseline
 *   node scripts/check-dead-exports.mjs --json
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const BASELINE_PATH = join(ROOT, 'docs/dead-exports-baseline.json');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const JSON_OUT = process.argv.includes('--json');

/** 框架入口自动豁免（Next.js 会按文件名/导出名调用） */
const FRAMEWORK_EXPORTS = new Set([
  'default',
  'metadata',
  'viewport',
  'generateMetadata',
  'generateStaticParams',
  'dynamic',
  'revalidate',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'fetchCache',
  'dynamicParams',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

/** 递归收集 src 下 .ts/.tsx 文件（相对仓库根、正斜杠） */
function collectSourceFiles(dir = SRC) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) out.push(...collectSourceFiles(absolute));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relative(ROOT, absolute).split(sep).join('/'));
  }
  return out;
}

/** 从源码里提取具名导出（含 export { a, b as c }，不含 default） */
function extractExports(file, source) {
  const exports = [];
  const patterns = [
    { regex: /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, kind: 'function' },
    { regex: /export\s+class\s+([A-Za-z_$][\w$]*)/g, kind: 'class' },
    { regex: /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, kind: 'variable' },
    { regex: /export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, kind: 'type' },
  ];
  for (const { regex, kind } of patterns) {
    let match = regex.exec(source);
    while (match !== null) {
      const line = source.slice(0, match.index).split('\n').length;
      exports.push({ file, name: match[1], kind, line });
      match = regex.exec(source);
    }
  }
  /* export { a, b as c }; —— 这种写法常用于集中导出，解析真实导出名 */
  const listPattern = /export\s*\{([^}]+)\}/g;
  let listMatch = listPattern.exec(source);
  while (listMatch !== null) {
    const line = source.slice(0, listMatch.index).split('\n').length;
    for (const piece of listMatch[1].split(',')) {
      const trimmed = piece.trim();
      if (trimmed.length === 0) continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
      const name = asMatch !== null ? asMatch[1] : trimmed;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exports.push({ file, name, kind: 'export-list', line });
    }
    listMatch = listPattern.exec(source);
  }
  return exports;
}

/** 统计某名字在整个 src 里的单词边界出现次数 */
function countReferences(name, corpus, cache) {
  if (cache.has(name)) return cache.get(name);
  const regex = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g');
  let count = 0;
  for (const source of corpus.values()) {
    const matches = source.match(regex);
    if (matches !== null) count += matches.length;
  }
  cache.set(name, count);
  return count;
}

/** 递归收集 scripts 下的 .mjs/.js 文件（作为引用语料，不参与导出清点） */
function collectScriptFiles(dir = join(ROOT, 'scripts')) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) out.push(...collectScriptFiles(absolute));
    else if (/\.(mjs|js)$/.test(entry)) out.push(relative(ROOT, absolute).split(sep).join('/'));
  }
  return out;
}

/**
 * collectReferenceCorpus —— 引用统计语料：src 全量 + scripts 全量 + 构建配置。
 *
 * 【为什么包含后两者】验证脚本与 tailwind.config 是真实消费者（如
 * verify-telemetry.mjs → clearFrameBuffer、probe-glass-contract.mjs → GLASS/COLORS、
 * tailwind.config.ts → TYPE_SCALE）。只数 src 会把它们误报成死导出。
 */
function collectReferenceCorpus() {
  const files = [...collectSourceFiles(), ...collectScriptFiles()];
  if (existsSync(join(ROOT, 'tailwind.config.ts'))) files.push('tailwind.config.ts');
  return [...new Set(files)];
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function main() {
  const files = collectSourceFiles();
  const corpus = new Map();
  /* 导出清点只看 src；引用统计额外覆盖 scripts 与 tailwind.config（合法消费者） */
  for (const file of collectReferenceCorpus()) corpus.set(file, readFileSync(join(ROOT, file), 'utf8'));

  const allExports = [];
  for (const file of files) allExports.push(...extractExports(file, corpus.get(file)));

  const referenceCache = new Map();
  const dead = [];
  for (const item of allExports) {
    if (FRAMEWORK_EXPORTS.has(item.name)) continue;
    if (/\/(page|layout|loading|error|not-found|template)\.(tsx|ts)$/.test(item.file)) continue;
    if (/\/(route)\.ts$/.test(item.file) && FRAMEWORK_EXPORTS.has(item.name)) continue;
    const references = countReferences(item.name, corpus, referenceCache);
    if (references <= 1) dead.push(item);
  }

  dead.sort((a, b) => (a.file + ':' + a.name).localeCompare(b.file + ':' + b.name));

  const baseline = readBaseline();
  const baselineKeys = new Set(baseline.entries.map((entry) => `${entry.file}::${entry.name}`));
  const deadKeys = new Set(dead.map((entry) => `${entry.file}::${entry.name}`));
  const newDead = dead.filter((entry) => !baselineKeys.has(`${entry.file}::${entry.name}`));
  const stale = baseline.entries.filter((entry) => !deadKeys.has(`${entry.file}::${entry.name}`));

  if (UPDATE_BASELINE) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      note:
        '死导出基线：仅记录当前静态分析可见的存量死导出；新增死导出由 scripts/check-dead-exports.mjs 拦截。' +
        '通过 --update-baseline 重写此文件（需人工确认）。',
      count: dead.length,
      entries: dead.map((entry) => ({ file: entry.file, name: entry.name, kind: entry.kind })),
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[dead-exports] 基线已写入 ${relative(ROOT, BASELINE_PATH)}：${dead.length} 条存量死导出`);
    process.exit(0);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ scannedExports: allExports.length, dead: dead.length, newDead, stale }, null, 2));
    process.exit(newDead.length === 0 ? 0 : 1);
  }

  console.log('死导出守卫（check-dead-exports）');
  console.log(`  扫描 ${files.length} 个文件 / ${allExports.length} 个具名导出`);
  console.log(`  基线存量：${baseline.entries.length} 条 · 当前死导出：${dead.length} 条 · 新增：${newDead.length} 条`);
  if (newDead.length > 0) {
    console.log('\n  ✗ 新增死导出（必须处理：删除、改为内部符号，或补真实引用）：');
    for (const entry of newDead) console.log(`    ${entry.file}:${entry.line}  ${entry.name} (${entry.kind})`);
  }
  if (stale.length > 0) {
    console.log(`\n  · 基线中已有 ${stale.length} 条不再出现（已修复）；建议执行 --update-baseline 收缩基线：`);
    for (const entry of stale.slice(0, 10)) console.log(`    ${entry.file}  ${entry.name}`);
    if (stale.length > 10) console.log(`    … 其余 ${stale.length - 10} 条`);
  }
  if (newDead.length === 0) console.log('\n  ✓ 没有新增死导出');
  else console.log('\n  ✗ 存在新增死导出，CI 失败');

  process.exit(newDead.length === 0 ? 0 : 1);
}

main();