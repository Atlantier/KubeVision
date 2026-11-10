#!/usr/bin/env node
/**
 * KubeVision AI — 离线演示打包（R54 · 双机预案）
 *
 * 【做什么】把"能离线跑起来的最小集合"打成一个 zip：
 *   .next/（生产构建产物，含 BUILD_ID）+ public/（含端侧 ONNX 权重）+ src/ +
 *   package.json / pnpm-lock.yaml / 构建配置 + .env.local（可选）+ RUN_ME.txt
 *
 * 【为什么要 .next 而不只给源码】现场不能等 `pnpm build`（2–3 分钟 + 可能触发安装/网络），
 * 预置构建产物才能"解压即启动"。若有 node_modules（另一台机器预装或同机拷贝），
 * `pnpm start` 即可；没有 node_modules 时用 `pnpm install --offline --frozen-lockfile`
 * 从 pnpm store 恢复，不访问网络。
 *
 * 【不打包什么】
 *  - node_modules（体积大且与平台相关；由双机预案保证预装）；
 *  - recording/ 与 .git/（媒体与版本库另行备份）；
 *  - docs/summit/shots（截图证据体积大，非运行必需）。
 *
 * 用法：
 *   node scripts/package-demo.mjs            # 输出 release/kubevision-demo-<commit>-<time>.zip
 *   node scripts/package-demo.mjs --include-env   # 连同 .env.local 一起打包（现场网关配置）
 *   node scripts/package-demo.mjs --out D:\demo  # 指定输出目录
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const readArg = (flag) => {
  const inline = args.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
};
const OUT_DIR = readArg('--out') ?? join(ROOT, 'release');
const INCLUDE_ENV = args.includes('--include-env');

/** 必需文件/目录（缺一不可） */
const REQUIRED = [
  '.next',
  'public',
  'src',
  'package.json',
  'pnpm-lock.yaml',
  'next.config.mjs',
  'tsconfig.json',
  'postcss.config.mjs',
  'tailwind.config.ts',
];

/** 需要跳过的大目录（相对仓库根） */
const EXCLUDES = new Set([
  'node_modules',
  '.git',
  'release',
  'recording',
  'docs/summit/shots',
  '.next/cache',
]);

function fail(message) {
  console.error(`[FATAL] ${message}`);
  process.exit(1);
}

function assertBuild() {
  for (const item of REQUIRED) {
    if (!existsSync(join(ROOT, item))) {
      fail(`缺少 ${item}。请先执行 \`pnpm build\`（生产构建）再打包。`);
    }
  }
  const buildId = readFileSync(join(ROOT, '.next/BUILD_ID'), 'utf8').trim();
  if (buildId.length === 0) fail('.next/BUILD_ID 为空，构建不完整。');
  return buildId;
}

function git(argsList) {
  try {
    return execFileSync('git', argsList, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** 递归统计文件数与字节数（跳过 EXCLUDES） */
function measure(dir, base = dir, acc = { files: 0, bytes: 0 }) {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    const rel = relative(ROOT, absolute).split('\\').join('/');
    if (rel === '.next/cache') continue;
    const stats = statSync(absolute);
    if (stats.isDirectory()) measure(absolute, base, acc);
    else {
      acc.files += 1;
      acc.bytes += stats.size;
    }
  }
  return acc;
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

function main() {
  const buildId = assertBuild();
  const commit = git(['rev-parse', '--short', 'HEAD']);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `kubevision-demo-${commit}-${stamp}`;
  const staging = join(OUT_DIR, name);
  const zipPath = join(OUT_DIR, `${name}.zip`);

  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  for (const item of REQUIRED) {
    const src = join(ROOT, item);
    const dst = join(staging, item);
    mkdirSync(join(dst, '..'), { recursive: true });
    if (statSync(src).isDirectory()) {
      cpSync(src, dst, {
        recursive: true,
        filter: (source) => {
          const rel = relative(ROOT, source).split('\\').join('/');
          return !EXCLUDES.has(rel) && !rel.startsWith('.next/cache');
        },
      });
    } else {
      copyFileSync(src, dst);
    }
  }

  if (INCLUDE_ENV && existsSync(join(ROOT, '.env.local'))) {
    copyFileSync(join(ROOT, '.env.local'), join(staging, '.env.local'));
  }

  const measureResult = measure(staging);
  const runMe = [
    'KubeVision AI — 离线演示包',
    `commit: ${commit}`,
    `buildId: ${buildId}`,
    `打包时间: ${new Date().toISOString()}`,
    '',
    '【快速启动】',
    '1) 本机需已安装 Node.js（与开发机同大版本）与 pnpm；',
    '2) 若已带 node_modules（同机拷贝/另一台预装）：',
    '     pnpm start',
    '3) 若没有 node_modules（离线）：',
    '     pnpm install --offline --frozen-lockfile',
    '     pnpm start',
    '4) 浏览器打开 http://127.0.0.1:3000',
    '',
    '【离线说明】',
    '- 页面、RAG、端侧脱敏/分类、自检清单均不依赖外网；',
    '- 未配置 LLM 网关时，Copilot 自动使用「本地确定性容灾引擎」（离线优先设计）；',
    '- 若包内没有 .env.local，请从主讲机拷贝一份（含本地网关地址与模型名）。',
    '',
    '【校验】',
    `本包 zip 的 SHA256：见同名 .sha256 文件；解压后文件数 ${measureResult.files}，字节 ${measureResult.bytes}。`,
    '',
  ].join('\n');
  writeFileSync(join(staging, 'RUN_ME.txt'), runMe, 'utf8');
  writeFileSync(join(staging, 'MANIFEST.json'), JSON.stringify({
    commit,
    buildId,
    createdAt: new Date().toISOString(),
    includeEnv: INCLUDE_ENV,
    files: measureResult.files,
    bytes: measureResult.bytes,
    required: REQUIRED,
  }, null, 2) + '\n', 'utf8');

  /* Windows 用 PowerShell Compress-Archive；其他平台回退到 tar（保留 zip 语义由调用方决定） */
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${staging}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`],
      { stdio: 'inherit' },
    );
  } else {
    fail('当前脚本仅实现了 Windows 打包（Compress-Archive）；其他平台请用 zip -r 手动打包。');
  }

  const digest = sha256(zipPath);
  writeFileSync(`${zipPath}.sha256`, `${digest}  ${name}.zip\n`, 'utf8');

  const zipSize = statSync(zipPath).size;
  console.log('离线演示包已生成');
  console.log(`  commit   : ${commit}`);
  console.log(`  buildId  : ${buildId}`);
  console.log(`  文件数   : ${measureResult.files}（解压后 ${(measureResult.bytes / 1024 / 1024).toFixed(1)} MB）`);
  console.log(`  zip      : ${zipPath}`);
  console.log(`  zip 大小 : ${(zipSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  SHA256   : ${digest}`);
  console.log('  提示：把 zip + 同名 .sha256 一起拷入 U 盘；现场解压后按 RUN_ME.txt 启动。');
}

main();