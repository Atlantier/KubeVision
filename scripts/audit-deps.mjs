#!/usr/bin/env node
/**
 * KubeVision AI — 依赖与体积治理（R52 · 追问 3）
 *
 * 产出 `docs/deps-audit.md`：
 *  1. 未使用依赖：扫描 `src/**` + `scripts/**` + 构建配置里的 import/require/配置引用，
 *     与 package.json 的 dependencies / devDependencies 对账；
 *  2. 首屏 JS 预算：读取 `.next/` 生产构建产物（app-build-manifest + build-manifest），
 *     汇总 `/` 首屏 chunk 的 raw / gzip 体积；
 *  3. 3D chunk / AI chunk 体积：在 `.next/static/chunks/**` 中按内容特征识别（three/R3F、
 *     ai-sdk/transformers），取最大包；
 *  4. 超限告警：超过 BUDGETS 时输出 WARN；加 --strict 时以非 0 退出（供 CI 使用）。
 *
 * 用法：
 *   node scripts/audit-deps.mjs            # 生成报告，超限仅告警
 *   node scripts/audit-deps.mjs --strict   # 超限即失败
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = process.cwd();
const NEXT_DIR = join(ROOT, '.next');
const REPORT_PATH = join(ROOT, 'docs/deps-audit.md');
/*
 * Next 的 dev 构建没有 BUILD_ID，且会不断改写 .next/static/chunks。
 * 体积预算只对生产构建（pnpm build）有意义：dev 产物既未压缩也未做路由级拆分，
 * 读它会得出"AI chunk 1MB+"这类误导性结论，因此没有 BUILD_ID 时跳过体积测量。
 */
const IS_PRODUCTION_BUILD = existsSync(join(NEXT_DIR, 'BUILD_ID'));
const STRICT = process.argv.includes('--strict');

/**
 * 体积预算（gzip，KB）。数值按当前产物 + 约 15% 余量设定；
 * 目的是"防止无意识膨胀"，不是"压到极限"。
 */
const BUDGETS = {
  firstLoadGzipKb: 200,
  threeChunkGzipKb: 220,
  aiChunkGzipKb: 240,
};

/** devDependencies 的用途多数在配置/脚本里体现，逐项给出判定依据（集中一处，便于复核） */
const DEV_DEP_USAGE_HINTS = {
  typescript: 'tsc --noEmit / tsconfig.json',
  eslint: '.eslintrc.json + next lint',
  'eslint-config-next': '.eslintrc.json extends next/core-web-vitals',
  prettier: 'pnpm format（prettier --write）',
  tailwindcss: 'tailwind.config.ts + globals.css @tailwind',
  postcss: 'postcss.config.mjs',
  autoprefixer: 'postcss.config.mjs',
  '@types/node': 'tsconfig.json types + Node API 类型',
  '@types/react': 'React 类型',
  '@types/react-dom': 'React DOM 类型',
  '@types/three': 'three 类型',
};

/** 收集扫描文件（源码 + 脚本 + 配置） */
function collectScanFiles() {
  const out = [];
  const roots = [join(ROOT, 'src'), join(ROOT, 'scripts')];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) walk(absolute);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(absolute);
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root);
  for (const name of [
    'next.config.mjs',
    'next.config.js',
    'tailwind.config.ts',
    'postcss.config.mjs',
    'postcss.config.js',
    'tsconfig.json',
    '.eslintrc.json',
    'package.json',
  ]) {
    const absolute = join(ROOT, name);
    if (existsSync(absolute)) out.push(absolute);
  }
  return out;
}

/** 从文本中提取模块说明符（import / export from / require / 动态 import） */
function extractSpecifiers(source) {
  const out = new Set();
  const patterns = [
    /(?:\bfrom\s+)['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match !== null) {
      out.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return out;
}

/** 包名归一化：@scope/pkg/sub → @scope/pkg；pkg/sub → pkg */
function toPackageName(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}

/** 统计依赖使用情况 */
function auditDependencies() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const dependencies = Object.keys(pkg.dependencies ?? {}).sort();
  const devDependencies = Object.keys(pkg.devDependencies ?? {}).sort();

  const files = collectScanFiles();
  const specifiers = new Set();
  for (const file of files) {
    for (const specifier of extractSpecifiers(readFileSync(file, 'utf8'))) specifiers.add(specifier);
  }
  const usedPackages = new Set([...specifiers].filter((specifier) => !specifier.startsWith('.')).map(toPackageName));

  /* 配置文件里的裸字符串（如 tailwind 插件、eslint extends）无法用 import 语法覆盖，做补充匹配 */
  const rawConfigText = files
    .filter((file) => /(tailwind|postcss|eslint|tsconfig|next\.config|package)\.(json|mjs|js|ts)$/.test(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

  const unusedDependencies = dependencies.filter((name) => !usedPackages.has(name));
  const unusedDevDependencies = devDependencies.filter((name) => {
    if (DEV_DEP_USAGE_HINTS[name] !== undefined) return false;
    if (rawConfigText.includes(`"${name}"`)) return false;
    return !usedPackages.has(name);
  });

  return { dependencies, devDependencies, unusedDependencies, unusedDevDependencies };
}

/** 读取 Next 生产构建 manifest */
function readManifest(name) {
  const absolute = join(NEXT_DIR, name);
  if (!existsSync(absolute)) return null;
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    return null;
  }
}

/** 递归收集 chunk 文件（相对 .next、正斜杠） */
function collectChunkFiles() {
  const chunksRoot = join(NEXT_DIR, 'static/chunks');
  if (!existsSync(chunksRoot)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) walk(absolute);
      else if (entry.endsWith('.js')) out.push(relative(NEXT_DIR, absolute).split(sep).join('/'));
    }
  };
  walk(chunksRoot);
  return out;
}

/** 计算文件 raw / gzip 字节数 */
function measure(relativeToNext) {
  const absolute = join(NEXT_DIR, relativeToNext);
  const buffer = readFileSync(absolute);
  return { rawBytes: buffer.length, gzipBytes: gzipSync(buffer, { level: 9 }).length };
}

const KB = 1024;
const formatKb = (bytes) => `${(bytes / KB).toFixed(1)} KB`;

/** 汇总首屏 JS：app-build-manifest 的 / 页面 chunk + build-manifest rootMainFiles */
function auditFirstLoad() {
  const appBuild = readManifest('app-build-manifest.json');
  const buildManifest = readManifest('build-manifest.json');
  if (appBuild === null && buildManifest === null) return null;

  const chunks = new Set();
  if (appBuild !== null) {
    const pages = appBuild.pages ?? {};
    for (const key of ['/page', '/']) {
      const list = pages[key];
      if (Array.isArray(list)) for (const chunk of list) chunks.add(chunk);
    }
  }
  if (buildManifest !== null) {
    const rootMainFiles = buildManifest.rootMainFiles;
    if (Array.isArray(rootMainFiles)) for (const chunk of rootMainFiles) chunks.add(chunk);
  }

  let rawBytes = 0;
  let gzipBytes = 0;
  const missing = [];
  for (const chunk of chunks) {
    /* manifest 里的路径形如 static/chunks/xxx.js；个别版本带 ./ 前缀 */
    const normalized = chunk.replace(/^\.\//, '');
    const absolute = join(NEXT_DIR, normalized);
    if (!existsSync(absolute)) {
      missing.push(normalized);
      continue;
    }
    const measured = measure(normalized);
    rawBytes += measured.rawBytes;
    gzipBytes += measured.gzipBytes;
  }
  return { chunkCount: chunks.size, rawBytes, gzipBytes, missing };
}

/** 按内容特征识别 3D / AI chunk（取最大匹配包） */
function auditSpecialChunks() {
  const chunks = collectChunkFiles();
  const threeMarkers = ['WebGLRenderer', 'react-three', 'THREE', 'three.module'];
  const aiMarkers = ['@ai-sdk', 'ai-sdk', 'openai', 'transformers', 'onnxruntime'];
  let three = null;
  let ai = null;
  let totalRaw = 0;
  let totalGzip = 0;

  for (const chunk of chunks) {
    const measured = measure(chunk);
    totalRaw += measured.rawBytes;
    totalGzip += measured.gzipBytes;
    const content = readFileSync(join(NEXT_DIR, chunk), 'utf8');
    const isThree = threeMarkers.some((marker) => content.includes(marker));
    const isAi = aiMarkers.some((marker) => content.includes(marker));
    if (isThree && (three === null || measured.gzipBytes > three.gzipBytes)) {
      three = { file: chunk, ...measured };
    }
    if (isAi && (ai === null || measured.gzipBytes > ai.gzipBytes)) {
      ai = { file: chunk, ...measured };
    }
  }
  return { chunkCount: chunks.length, totalRaw, totalGzip, three, ai };
}

/** 生成 Markdown 报告 */
function buildReport({ deps, size }) {
  const now = new Date().toISOString();
  const lines = [];

  lines.push('# 依赖与体积审计（deps-audit）');
  lines.push('');
  lines.push('> 由 `node scripts/audit-deps.mjs` 自动生成，请勿手改数字。');
  lines.push(`> 生成时间：${now}；构建产物：${existsSync(NEXT_DIR) ? '`.next/`（生产构建）' : '缺失（先运行 `pnpm build`）'}`);
  lines.push('');

  lines.push('## 1. 未使用依赖');
  lines.push('');
  lines.push(`运行时依赖共 **${deps.dependencies.length}** 个，未发现 import：${deps.unusedDependencies.length} 个。`);
  lines.push('');
  if (deps.unusedDependencies.length === 0) {
    lines.push('| 依赖 | 判定 | 建议 |');
    lines.push('|---|---|---|');
    lines.push('| （无） | 全部运行时依赖在 src/scripts 中均有 import | — |');
  } else {
    lines.push('| 依赖 | 判定 | 建议 |');
    lines.push('|---|---|---|');
    for (const name of deps.unusedDependencies) {
      lines.push(`| \`${name}\` | 未在 src/scripts/config 中发现引用 | 人工复核后从 package.json 移除 |`);
    }
  }
  lines.push('');
  lines.push(`开发依赖共 **${deps.devDependencies.length}** 个；其中未在配置/脚本/import 中发现用途：${deps.unusedDevDependencies.length} 个。`);
  if (deps.unusedDevDependencies.length > 0) {
    lines.push('');
    lines.push('| devDependency | 判定 |');
    lines.push('|---|---|');
    for (const name of deps.unusedDevDependencies) {
      lines.push(`| \`${name}\` | 未在配置/脚本/import 中发现用途，建议复核 |`);
    }
  }
  lines.push('');
  lines.push('> 依赖审计口径：扫描 `src/**`、`scripts/**` 的 import/require/动态 import；');
  lines.push('> 构建/代码质量工具通过配置文件名匹配与 `DEV_DEP_USAGE_HINTS` 判定，避免把 tsc/eslint 类工具误报为未使用。');
  lines.push('');

  lines.push('## 2. 首屏 JS 预算');
  lines.push('');
  if (size.firstLoad === null) {
    lines.push('> 未找到 `.next/app-build-manifest.json` / `build-manifest.json`：请先 `pnpm build`。');
  } else {
    const first = size.firstLoad;
    lines.push(
      `| 指标 | 实测 | 预算 | 状态 |`,
    );
    lines.push('|---|---|---|---|');
    lines.push(
      `| 首屏 JS（${first.chunkCount} chunks）raw | ${formatKb(first.rawBytes)} | — | 记录用 |`,
    );
    lines.push(
      `| 首屏 JS gzip | ${formatKb(first.gzipBytes)} | ≤ ${BUDGETS.firstLoadGzipKb} KB | ${
        first.gzipBytes / KB <= BUDGETS.firstLoadGzipKb ? 'PASS' : 'WARN'
      } |`,
    );
    if (first.missing.length > 0) lines.push(`| manifest 中缺失的 chunk | ${first.missing.join(', ')} | — | 忽略缺失项 |`);
  }
  lines.push('');

  lines.push('## 3. 3D / AI chunk 体积');
  lines.push('');
  if (size.special === null) {
    lines.push('> 未找到 `.next/static/chunks`：请先 `pnpm build`。');
  } else {
    const special = size.special;
    lines.push('| 分类 | 文件 | raw | gzip | 预算 | 状态 |');
    lines.push('|---|---|---|---|---|---|');
    if (special.three === null) {
      lines.push('| 3D（three/R3F） | 未识别 | — | — | — | 需人工检查 chunk 命名 |');
    } else {
      lines.push(
        `| 3D（three/R3F） | \`${special.three.file}\` | ${formatKb(special.three.rawBytes)} | ${formatKb(
          special.three.gzipBytes,
        )} | ≤ ${BUDGETS.threeChunkGzipKb} KB | ${
          special.three.gzipBytes / KB <= BUDGETS.threeChunkGzipKb ? 'PASS' : 'WARN'
        } |`,
      );
    }
    if (special.ai === null) {
      lines.push('| AI（ai-sdk/transformers） | 未识别 | — | — | — | 需人工检查 chunk 命名 |');
    } else {
      lines.push(
        `| AI（ai-sdk/transformers） | \`${special.ai.file}\` | ${formatKb(special.ai.rawBytes)} | ${formatKb(
          special.ai.gzipBytes,
        )} | ≤ ${BUDGETS.aiChunkGzipKb} KB | ${
          special.ai.gzipBytes / KB <= BUDGETS.aiChunkGzipKb ? 'PASS' : 'WARN'
        } |`,
      );
    }
    lines.push(
      `| 全部 client chunks（${special.chunkCount} 个） | — | ${formatKb(special.totalRaw)} | ${formatKb(special.totalGzip)} | — | 记录用 |`,
    );
  }
  lines.push('');
  lines.push('## 4. 口径与限制');
  lines.push('');
  lines.push('1. 体积均为**未压缩 raw / gzip-9** 字节数，读取自 `.next/` 生产构建产物；');
  lines.push('2. 3D/AI chunk 通过**内容标记**识别（`WebGLRenderer`、`react-three`、`@ai-sdk`、`transformers` 等），');
  lines.push('   若打包器把库拆到多个包，本表只报**最大匹配包**，不等于该能力的全部体积；');
  lines.push('3. 首屏 JS = app-build-manifest 的 `/` 页面 chunk ∪ build-manifest 的 rootMainFiles；');
  lines.push('   动态 `next/dynamic` 懒加载块不计入首屏；');
  lines.push('4. 未用依赖仅做静态 import 检查：通过字符串/反射/CLI 间接使用的依赖可能被误报，需人工复核；');
  lines.push('5. 预算值集中在 `scripts/audit-deps.mjs` 的 `BUDGETS`，调整预算必须在 PR 里说明理由。');
  lines.push('');
  lines.push('## 5. 复现');
  lines.push('');
  lines.push('```bash');
  lines.push('pnpm build                      # 生成 .next/ 生产产物');
  lines.push('node scripts/audit-deps.mjs     # 生成本报告（超限 WARN）');
  lines.push('node scripts/audit-deps.mjs --strict   # CI：超限即失败');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

function main() {
  const deps = auditDependencies();
  if (!IS_PRODUCTION_BUILD) {
    console.log('依赖与体积审计（audit-deps）');
    console.log(`  运行时依赖 ${deps.dependencies.length} 个；未使用 ${deps.unusedDependencies.length} 个`);
    if (deps.unusedDependencies.length > 0) console.log(`    未使用：${deps.unusedDependencies.join(', ')}`);
    console.log('  ⚠ 当前 .next 不是生产构建（缺少 BUILD_ID，可能是 dev server 写入的产物）：跳过体积测量，');
    console.log('    也不覆盖 docs/deps-audit.md。请先停止 dev，执行 pnpm build，再运行本脚本。');
    process.exit(0);
  }
  const size = {
    firstLoad: existsSync(join(NEXT_DIR, 'app-build-manifest.json')) ? auditFirstLoad() : null,
    special: existsSync(join(NEXT_DIR, 'static/chunks')) ? auditSpecialChunks() : null,
  };

  const report = buildReport({ deps, size });
  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(REPORT_PATH, report, 'utf8');

  const k = KB;
  const warnings = [];
  if (size.firstLoad !== null && size.firstLoad.gzipBytes / k > BUDGETS.firstLoadGzipKb) {
    warnings.push(`首屏 JS gzip ${(size.firstLoad.gzipBytes / k).toFixed(1)}KB > 预算 ${BUDGETS.firstLoadGzipKb}KB`);
  }
  if (size.special?.three !== null && size.special?.three !== undefined && size.special.three.gzipBytes / k > BUDGETS.threeChunkGzipKb) {
    warnings.push(`3D chunk gzip ${(size.special.three.gzipBytes / k).toFixed(1)}KB > 预算 ${BUDGETS.threeChunkGzipKb}KB`);
  }
  if (size.special?.ai !== null && size.special?.ai !== undefined && size.special.ai.gzipBytes / k > BUDGETS.aiChunkGzipKb) {
    warnings.push(`AI chunk gzip ${(size.special.ai.gzipBytes / k).toFixed(1)}KB > 预算 ${BUDGETS.aiChunkGzipKb}KB`);
  }

  console.log('依赖与体积审计（audit-deps）');
  console.log(`  运行时依赖 ${deps.dependencies.length} 个；未使用 ${deps.unusedDependencies.length} 个`);
  if (deps.unusedDependencies.length > 0) console.log(`    未使用：${deps.unusedDependencies.join(', ')}`);
  if (deps.unusedDevDependencies.length > 0) console.log(`    未判明 devDeps：${deps.unusedDevDependencies.join(', ')}`);
  if (size.firstLoad !== null) {
    console.log(`  首屏 JS gzip：${(size.firstLoad.gzipBytes / k).toFixed(1)}KB（预算 ${BUDGETS.firstLoadGzipKb}KB）`);
  }
  if (size.special !== null) {
    console.log(`  3D chunk gzip：${size.special.three === null ? '未识别' : (size.special.three.gzipBytes / k).toFixed(1) + 'KB'}`);
    console.log(`  AI chunk gzip：${size.special.ai === null ? '未识别' : (size.special.ai.gzipBytes / k).toFixed(1) + 'KB'}`);
    console.log(`  client chunks 总量：${(size.special.totalGzip / k).toFixed(1)}KB gzip / ${size.special.chunkCount} 个`);
  }
  for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  console.log(`  报告：${relative(ROOT, REPORT_PATH)}`);
  if (warnings.length === 0) console.log('  ✓ 全部预算内');
  process.exit(STRICT && warnings.length > 0 ? 1 : 0);
}

main();