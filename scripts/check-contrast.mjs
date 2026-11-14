#!/usr/bin/env node
/**
 * KubeVision AI — WCAG AA 对比度与触控热区静态门禁（R12 进阶）
 *
 * 【检查范围】
 * 1. 文本对比度门禁：扫描 `src/app` 与 `src/components` 下 JSX 中的静态前景色与背景色组合，
 *    依据 WCAG 2.1 相对亮度公式计算对比度（支持 /opacity 与暗底 alpha 合成）。
 *    要求非禁用态 10~13px 文案、辅助说明与状态徽标对比度 >= 4.5:1
 *    （例如禁止在深灰/slate-800/slate-900 面板上使用低对比度的 `text-slate-500`/`text-slate-600`）。
 * 2. 触控热区门禁：检查显式设置固定宽高（`h-5`、`w-5` 等 < 24px）的交互按钮，
 *    要求桌面端物理命中 >= 24px（`h-6`/`w-6` 或 `min-h-[24px]`/`min-w-[24px]`）。
 *
 * 退出码：0 = 全部合规；1 = 存在违约。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/** Tailwind v3 标准调色板十六进制表（用于 WCAG 亮度求值） */
const PALETTE = {
  'slate-50': '#f8fafc',
  'slate-100': '#f1f5f9',
  'slate-200': '#e2e8f0',
  'slate-300': '#cbd5e1',
  'slate-400': '#94a3b8',
  'slate-500': '#64748b',
  'slate-600': '#475569',
  'slate-700': '#334155',
  'slate-800': '#1e293b',
  'slate-900': '#0f172a',
  'slate-950': '#020617',
  'zinc-400': '#a1a1aa',
  'zinc-500': '#71717a',
  'zinc-600': '#52525b',
  'gray-400': '#9ca3af',
  'gray-500': '#6b7280',
  'gray-600': '#4b5563',
  'cyan-100': '#cffafe',
  'cyan-200': '#a5f3fc',
  'cyan-300': '#67e8f9',
  'cyan-400': '#22d3ee',
  'cyan-500': '#06b6d4',
  'emerald-100': '#d1fae5',
  'emerald-200': '#a7f3d0',
  'emerald-300': '#6ee7b7',
  'emerald-400': '#34d399',
  'emerald-500': '#10b981',
  'amber-100': '#fef3c7',
  'amber-200': '#fde68a',
  'amber-300': '#fcd34d',
  'amber-400': '#fbbf24',
  'amber-500': '#f59e0b',
  'rose-100': '#ffe4e6',
  'rose-200': '#fecdd3',
  'rose-300': '#fda4af',
  'rose-400': '#fb7185',
  'rose-500': '#f43f5e',
  white: '#ffffff',
  black: '#000000',
};

const DARK_SURFACES = {
  void: '#020617',
  panel: '#0f172a',
  card: '#1e293b',
};

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function composite(fgRgb, alpha, bgRgb) {
  return [
    fgRgb[0] * alpha + bgRgb[0] * (1 - alpha),
    fgRgb[1] * alpha + bgRgb[1] * (1 - alpha),
    fgRgb[2] * alpha + bgRgb[2] * (1 - alpha),
  ];
}

function relativeLuminance([r, g, b]) {
  const channel = (v) => {
    const srgb = v / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fgRgb, bgRgb) {
  const l1 = relativeLuminance(fgRgb);
  const l2 = relativeLuminance(bgRgb);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function parseColorToken(token) {
  const m = token.match(
    /^text-(slate-\d+|zinc-\d+|gray-\d+|cyan-\d+|emerald-\d+|amber-\d+|rose-\d+|white|black)(?:\/(?:\[([0-9.]+)\]|(\d+)))?$/,
  );
  if (!m) return null;
  const hex = PALETTE[m[1]];
  if (!hex) return null;
  let alpha = 1;
  if (m[2] !== undefined) alpha = Number.parseFloat(m[2]);
  else if (m[3] !== undefined) alpha = Number.parseInt(m[3], 10) / 100;
  return { hex, alpha, raw: token };
}

function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

function walkTsx(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsx(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const files = [
  ...walkTsx(join(ROOT, 'src/app')),
  ...walkTsx(join(ROOT, 'src/components')),
];

const contrastViolations = [];
const touchViolations = [];

const FG_TOKEN_RE =
  /\btext-(?:slate-\d+|zinc-\d+|gray-\d+|cyan-\d+|emerald-\d+|amber-\d+|rose-\d+|white|black)(?:\/(?:\[[0-9.]+\]|\d+))?\b/g;

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const raw = readFileSync(file, 'utf8');
  const clean = stripBlockComments(raw);
  const lines = clean.split('\n');

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    /* 禁用态允许降对比度；纯 aria-hidden 装饰图标与渐变/R3F 色彩字符串除外 */
    if (
      trimmed.includes('cursor-not-allowed') ||
      trimmed.includes('disabled:') ||
      trimmed.includes('aria-hidden')
    ) {
      return;
    }

    const nearbyContext = lines
      .slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 14))
      .join('\n');
    const isBrightActivePill =
      /\bactive\b/.test(line) &&
      /\btext-slate-9(?:00|50)\b/.test(line) &&
      /\bbg-(?:cyan|emerald|amber)-400\b/.test(nearbyContext);

    const surfaceHex = /\bbg-slate-800\b/.test(line)
      ? DARK_SURFACES.card
      : /\bbg-slate-950\b/.test(line)
        ? DARK_SURFACES.void
        : DARK_SURFACES.panel;

    const matches = line.match(FG_TOKEN_RE);
    if (matches) {
      for (const token of matches) {
        if (line.includes(`group-hover:${token}`) || line.includes(`hover:${token}`)) continue;
        /* placeholder 文本按惯例可稍淡，正文/辅助/标签/按钮均须达标 */
        if (line.includes(`placeholder:${token}`)) continue;
        const parsed = parseColorToken(token);
        if (!parsed) continue;
        const tokenBgHex =
          isBrightActivePill && /^text-slate-9(?:00|50)$/.test(token)
            ? PALETTE['cyan-400']
            : surfaceHex;
        const tokenBgRgb = hexToRgb(tokenBgHex);
        const blendedFg = composite(hexToRgb(parsed.hex), parsed.alpha, tokenBgRgb);
        const ratio = contrastRatio(blendedFg, tokenBgRgb);
        if (ratio < 4.5) {
          contrastViolations.push({
            file: rel,
            line: lineNo,
            token,
            bg: tokenBgHex,
            ratio: ratio.toFixed(2),
          });
        }
      }
    }
  });

  /* 触控热区检查：扫描完整 <button ...> 开始标签（跳过 JSX {...} 与引号中的 `>`） */
  for (let idx = clean.indexOf('<button'); idx !== -1; idx = clean.indexOf('<button', idx + 7)) {
    const nextChar = clean[idx + 7];
    if (nextChar && !/[\s/>]/.test(nextChar)) continue;
    let cursor = idx + 7;
    let braceDepth = 0;
    let quote = null;
    while (cursor < clean.length) {
      const ch = clean[cursor];
      if (quote) {
        if (ch === '\\') cursor += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '{') {
        braceDepth += 1;
      } else if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
      } else if (ch === '>' && braceDepth === 0) {
        break;
      }
      cursor += 1;
    }
    const tag = clean.slice(idx, cursor + 1);
    if (tag.includes('inset-0') || tag.includes('sr-only')) continue;
    const before = clean.slice(0, idx);
    const lineNo = before.split('\n').length;
    const hasTinyH = /\bh-[1-5]\b/.test(tag) && !/\bmin-h-/.test(tag);
    const hasTinyW = /\bw-[1-5]\b/.test(tag) && !/\bmin-w-/.test(tag);
    if (hasTinyH || hasTinyW) {
      touchViolations.push({
        file: rel,
        line: lineNo,
        snippet: tag.replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  }
}

console.log('KubeVision R12 对比度与触控热区扫描结果');
console.log(`- 扫描文件数: ${files.length}`);
console.log(`- WCAG AA (< 4.5:1) 文本违约: ${contrastViolations.length}`);
for (const v of contrastViolations.slice(0, 40)) {
  console.log(`  [CONTRAST] ${v.file}:${v.line} ${v.token} on ${v.bg} -> ${v.ratio}:1`);
}
if (contrastViolations.length > 40) {
  console.log(`  ... 其余 ${contrastViolations.length - 40} 处已省略`);
}

console.log(`- 桌面 < 24px 触控热区违约: ${touchViolations.length}`);
for (const v of touchViolations) {
  console.log(`  [TOUCH] ${v.file}:${v.line} ${v.snippet}`);
}

process.exit(contrastViolations.length === 0 && touchViolations.length === 0 ? 0 : 1);
