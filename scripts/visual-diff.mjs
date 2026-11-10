#!/usr/bin/env node
/**
 * KubeVision AI — 视觉回归基线比对（R32 · 追问 4）
 *
 * 对比 docs/summit/visual-baseline/ 与当前截图目录（同名 PNG），
 * 按像素差异比阈值判定（默认 1.5%），输出 markdown/JSON 报告。
 *
 * 【差异口径】与 scripts/shot.mjs 的 diff 模式一致：逐像素 RGBA 差值和 > 30
 * 记为差异像素；ratio = 差异像素 / 总像素。阈值默认 1.5%。
 *
 * 用法：
 *   node scripts/visual-diff.mjs --current docs/summit/shots/r32-visual
 *   node scripts/visual-diff.mjs --baseline <dir> --current <dir> --threshold 1.5
 *
 * 退出码：0 = 全部通过；1 = 有场景超阈值；2 = 运行失败。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
function readArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}
const BASELINE_DIR = readArg('--baseline', 'docs/summit/visual-baseline');
const CURRENT_DIR = readArg('--current', 'docs/summit/visual-current');
const THRESHOLD = Number(readArg('--threshold', '1.5'));
const REPORT_DIR = readArg('--out', 'docs/summit');

/** 解码 8-bit RGB/RGBA 非隔行 PNG（零依赖） */
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error('unsupported PNG color type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    for (let x = 0; x < stride; x += 1) cur[x] = raw[pos + x];
    pos += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = cur[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      pixels[di] = cur[si];
      pixels[di + 1] = cur[si + 1];
      pixels[di + 2] = cur[si + 2];
      pixels[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, pixels };
}

/** 计算两张图的差异像素比例 */
function diffRatio(a, b) {
  if (a.width !== b.width || a.height !== b.height) return null;
  let changed = 0;
  const total = a.width * a.height;
  for (let i = 0; i < a.pixels.length; i += 4) {
    const d =
      Math.abs(a.pixels[i] - b.pixels[i]) +
      Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) +
      Math.abs(a.pixels[i + 2] - b.pixels[i + 2]) +
      Math.abs(a.pixels[i + 3] - b.pixels[i + 3]);
    if (d > 30) changed += 1;
  }
  return { ratio: (changed / total) * 100, changed, total };
}

if (!existsSync(BASELINE_DIR)) {
  console.error(`[FATAL] 基线目录不存在: ${BASELINE_DIR}`);
  process.exit(2);
}
if (!existsSync(CURRENT_DIR)) {
  console.error(`[FATAL] 当前截图目录不存在: ${CURRENT_DIR}`);
  process.exit(2);
}

const baselineFiles = readdirSync(BASELINE_DIR).filter((name) => name.endsWith('.png'));
const results = [];
for (const name of baselineFiles) {
  const currentPath = join(CURRENT_DIR, name);
  if (!existsSync(currentPath)) {
    results.push({ name, status: 'missing', ratio: null, detail: '当前目录缺少同名截图' });
    continue;
  }
  try {
    const ratio = diffRatio(decodePng(readFileSync(join(BASELINE_DIR, name))), decodePng(readFileSync(currentPath)));
    if (ratio === null) {
      results.push({ name, status: 'size-mismatch', ratio: null, detail: '尺寸不一致' });
    } else {
      results.push({
        name,
        status: ratio.ratio <= THRESHOLD ? 'pass' : 'fail',
        ratio: ratio.ratio,
        changed: ratio.changed,
        total: ratio.total,
        detail: `${ratio.changed}/${ratio.total} px`,
      });
    }
  } catch (error) {
    results.push({ name, status: 'error', ratio: null, detail: String(error) });
  }
}

mkdirSync(REPORT_DIR, { recursive: true });
const failed = results.filter((result) => result.status === 'fail' || result.status === 'size-mismatch');
const missing = results.filter((result) => result.status === 'missing');

const lines = [
  '# 视觉回归比对报告',
  '',
  `> 基线目录：\`${BASELINE_DIR}\`　当前目录：\`${CURRENT_DIR}\``,
  `> 阈值：**${THRESHOLD}%**（逐像素 RGBA 差值和 >30 记为差异）`,
  '',
  '| 截图 | 差异比例 | 判定 | 说明 |',
  '|---|---|---|---|',
  ...results.map(
    (result) =>
      `| ${result.name} | ${result.ratio === null ? 'n/a' : result.ratio.toFixed(3) + '%'} | ${
        result.status === 'pass' ? '✅ 通过' : result.status === 'fail' ? '❌ 超阈值' : '⚠️ ' + result.status
      } | ${result.detail} |`,
  ),
  '',
  failed.length === 0 && missing.length === 0 ? '**结论：全部通过**' : '**结论：存在未通过/缺失项**',
  '',
];
writeFileSync(join(REPORT_DIR, 'visual-diff.md'), lines.join('\n'), 'utf8');
writeFileSync(
  join(REPORT_DIR, 'visual-diff.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), baseline: BASELINE_DIR, current: CURRENT_DIR, threshold: THRESHOLD, results }, null, 2)}\n`,
  'utf8',
);

console.log('KubeVision AI — 视觉回归比对');
console.log(`  基线: ${BASELINE_DIR}`);
console.log(`  当前: ${CURRENT_DIR}`);
console.log(`  阈值: ${THRESHOLD}%`);
for (const result of results) {
  console.log(
    `  ${result.name.padEnd(28)} ${result.ratio === null ? 'n/a' : result.ratio.toFixed(3) + '%'}  ${result.status}`,
  );
}
console.log(`\n[报告] ${join(REPORT_DIR, 'visual-diff.md')}`);
process.exit(failed.length > 0 || missing.length > 0 ? 1 : 0);