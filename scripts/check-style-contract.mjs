#!/usr/bin/env node
/**
 * KubeVision AI — 样式契约静态守卫（R1 · 视觉地基）
 *
 * 【设计意图】玻璃四层与 Tailwind 透明度档位是"写了但可能静默失效"的重灾区：
 *   - CSS 里残留 `--:` / `var(--)` / 空选择器 `. {}` 会让整段规则失效；
 *   - Tailwind v3 只生成默认 opacity 刻度（0/5/10/20/25/30/40/50/60/70/75/80/90/95/100），
 *     裸写 /8、/12、/88、/92、/15、/55 等会被静默丢弃；
 *   - 双重透明度 `white/[0.07]/60` 是非法语法，整条类不生成；
 *   - 半像素 / <10px 字号违反可读性契约。
 * 这些缺陷肉眼极难发现（画面"看起来正常"），必须静态扫描 + 构建产物比对。
 *
 * 【输入】src/app/globals.css、src/constants/tokens.ts、src/**\/*.tsx、
 *         以及（若存在）.next/static/css/*.css 构建产物。
 * 【输出】--json 时输出 { ok, results:[{name,status,detail}] }；否则人类可读。
 * 【退出码】0 = 全部通过；1 = 存在违约；2 = 扫描本身失败。
 *
 * 【为何接入 verify:quick / verify:all】只读源码与构建产物，不启浏览器，
 * 单次 < 300ms，是提交前最低成本的样式守门员。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const JSON_MODE = process.argv.includes('--json');

/** Tailwind v3 默认 opacity 刻度（裸值只有这些会生成） */
const VALID_OPACITY = new Set([0, 5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95, 100]);

/** 颜色工具类前缀（可带透明度修饰符） */
const COLOR_PREFIX = '(?:bg|text|border|ring|from|to|via|fill|stroke|divide|placeholder|decoration|outline|accent|caret)';

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
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

/* ========================================================================== */
/* 1. globals.css：禁止坏变量 / 空选择器 / 重复 .kv-panel                       */
/* ========================================================================== */
function checkGlobals() {
  const file = join(ROOT, 'src/app/globals.css');
  const css = readFileSync(file, 'utf8');
  /* 先剥离注释：中文注释里可能引用 `. {}` / `var(--)` 等字样作说明，
   * 不应被当作真实违约；只扫描真正的 CSS 规则。 */
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const brokenVarName = stripped.match(/--\s*:/g) ?? [];
  const brokenVarRef = stripped.match(/var\(--\)/g) ?? [];
  const emptySelector = stripped.match(/\.\s*\{\s*\}/g) ?? [];

  if (brokenVarName.length === 0 && brokenVarRef.length === 0 && emptySelector.length === 0) {
    record('globals.css 无坏变量/空选择器', 'pass', '无 --: / var(--) / . {}');
  } else {
    record(
      'globals.css 无坏变量/空选择器',
      'fail',
      `--:×${brokenVarName.length} var(--)×${brokenVarRef.length} 空选择器×${emptySelector.length}`,
    );
  }

  /* 玻璃四层 + 两个可组合 blur 工具类都必须真实定义（非空） */
  const required = ['.kv-panel', '.kv-chip', '.kv-overlay', '.kv-blur-panel', '.kv-blur-chip'];
  const missing = required.filter((cls) => {
    const re = new RegExp(cls.replace('.', '\\.') + '\\s*\\{[^}]+\\}');
    return !re.test(css);
  });
  if (missing.length === 0) {
    record('玻璃五类均有非空规则', 'pass', required.join(' '));
  } else {
    record('玻璃五类均有非空规则', 'fail', `缺失/空: ${missing.join(' ')}`);
  }

  /* .kv-panel 基础规则只允许一条（@supports 降级里的不算"互相覆盖"） */
  const withoutSupports = css.replace(/@supports[^{]*\{[\s\S]*?\n\}/g, '');
  const panelRules = withoutSupports.match(/\.kv-panel\s*\{/g) ?? [];
  if (panelRules.length === 1) {
    record('.kv-panel 单一基础规则', 'pass', '1 条（另含 @supports 降级）');
  } else {
    record('.kv-panel 单一基础规则', 'fail', `${panelRules.length} 条基础规则（应仅 1 条）`);
  }

  /* 焦点环必须用 outline，不用全局 box-shadow */
  const focusBlock = css.match(/\*:focus-visible\s*\{[^}]*\}/);
  if (focusBlock && /outline:/.test(focusBlock[0]) && !/box-shadow:/.test(focusBlock[0])) {
    record('焦点环用 outline', 'pass', 'outline + outline-offset');
  } else {
    record('焦点环用 outline', 'fail', '全局焦点环仍用 box-shadow 或缺 outline');
  }

  /* 必须有 backdrop-filter 降级 */
  if (/@supports\s+not\s*\(\s*\(?\s*backdrop-filter/.test(css)) {
    record('backdrop-filter 降级存在', 'pass', '@supports not');
  } else {
    record('backdrop-filter 降级存在', 'fail', '缺少 @supports not 降级');
  }

  return css;
}

/* ========================================================================== */
/* 2. tokens.ts GLASS 与 globals.css blur 变量一致                              */
/* ========================================================================== */
function checkTokenConsistency(css) {
  const tokens = readFileSync(join(ROOT, 'src/constants/tokens.ts'), 'utf8');
  const glassBlock = tokens.match(/export const GLASS\s*=\s*\{[\s\S]*?\}\s*as const/);
  if (!glassBlock) {
    record('tokens.GLASS 与 globals 一致', 'fail', '未找到 GLASS 定义');
    return;
  }
  const grab = (key) => {
    const m = glassBlock[0].match(new RegExp(key + '\\s*:\\s*\\{[^}]*blurPx\\s*:\\s*(\\d+)'));
    return m ? Number(m[1]) : null;
  };
  const expected = { panel: grab('panel'), chip: grab('chip'), overlay: grab('overlay') };

  const cssVal = (name) => {
    const m = css.match(new RegExp('--kv-blur-' + name + '\\s*:\\s*(\\d+)px'));
    return m ? Number(m[1]) : null;
  };
  const actual = { panel: cssVal('panel'), chip: cssVal('chip'), overlay: cssVal('overlay') };

  const mismatches = [];
  for (const key of ['panel', 'chip', 'overlay']) {
    if (expected[key] === null || actual[key] === null || expected[key] !== actual[key]) {
      mismatches.push(`${key}: tokens=${expected[key]} css=${actual[key]}`);
    }
  }
  if (mismatches.length === 0) {
    record('tokens.GLASS 与 globals 一致', 'pass', `panel=${actual.panel} chip=${actual.chip} overlay=${actual.overlay}`);
  } else {
    record('tokens.GLASS 与 globals 一致', 'fail', mismatches.join('；'));
  }

  /* getTokenCssVariables 若保留必须接线；这里要求已删除（未接线函数不留） */
  if (/export function getTokenCssVariables/.test(tokens)) {
    record('无未接线的 getTokenCssVariables', 'fail', '函数仍存在但未在根布局注入');
  } else {
    record('无未接线的 getTokenCssVariables', 'pass', '已删除，改由本脚本校验一致');
  }
}

/* ========================================================================== */
/* 3. src tsx：禁止双重透明度 / 非刻度裸透明度 / 半像素与 <10px 字号             */
/* ========================================================================== */
function checkTsx() {
  const files = walkTsx(join(ROOT, 'src'));
  const doubleHits = [];
  const bareHits = [];
  const fontHits = [];
  const bracketClasses = new Set();

  const doubleRe = /\/\[0\.\d+\]\/\d+/g;
  const bareRe = new RegExp('\\b(' + COLOR_PREFIX + '-(?:[a-zA-Z]+(?:-[a-zA-Z0-9]+)*))\\/(\\d{1,3})\\b', 'g');
  const bracketRe = new RegExp('\\b(' + COLOR_PREFIX + '-[a-zA-Z0-9-]+\\/\\[0\\.\\d+\\])', 'g');
  const fontRe = /text-\[(\d+(?:\.\d+)?)px\]/g;

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      let m;
      doubleRe.lastIndex = 0;
      while ((m = doubleRe.exec(line)) !== null) doubleHits.push(`${rel}:${idx + 1} ${m[0]}`);
      bareRe.lastIndex = 0;
      while ((m = bareRe.exec(line)) !== null) {
        if (!VALID_OPACITY.has(Number(m[2]))) bareHits.push(`${rel}:${idx + 1} ${m[1]}/${m[2]}`);
      }
      fontRe.lastIndex = 0;
      while ((m = fontRe.exec(line)) !== null) {
        const v = Number(m[1]);
        if (v < 10 || v !== Math.floor(v)) fontHits.push(`${rel}:${idx + 1} text-[${m[1]}px]`);
      }
    });
    let bm;
    bracketRe.lastIndex = 0;
    while ((bm = bracketRe.exec(src)) !== null) bracketClasses.add(bm[1]);
  }

  if (doubleHits.length === 0) record('无双重透明度', 'pass', '0 处');
  else record('无双重透明度', 'fail', `${doubleHits.length} 处，例: ${doubleHits[0]}`);

  if (bareHits.length === 0) record('无非刻度裸透明度', 'pass', '0 处');
  else record('无非刻度裸透明度', 'fail', `${bareHits.length} 处，例: ${bareHits[0]}`);

  if (fontHits.length === 0) record('字号 ≥10px 且无半像素', 'pass', '0 处违规');
  else record('字号 ≥10px 且无半像素', 'fail', `${fontHits.length} 处，例: ${fontHits[0]}`);

  return bracketClasses;
}

/* ========================================================================== */
/* 4. 构建产物 CSS：无坏标记 + 玻璃类与本轮修复的透明度类都有生成规则            */
/* ========================================================================== */
function checkBuiltCss(bracketClasses) {
  const cssDir = join(ROOT, '.next/static/css');
  if (!existsSync(cssDir)) {
    record('构建 CSS 校验', 'skip', '未找到 .next/static/css（先运行 pnpm build）');
    return;
  }
  const cssFiles = readdirSync(cssDir).filter((f) => f.endsWith('.css'));
  if (cssFiles.length === 0) {
    record('构建 CSS 校验', 'skip', '目录为空（先运行 pnpm build）');
    return;
  }
  /* 取最新构建产物 */
  let newest = cssFiles[0];
  let newestMtime = 0;
  for (const f of cssFiles) {
    const st = readFileSync(join(cssDir, f));
    if (st.length > newestMtime) { newestMtime = st.length; newest = f; }
  }
  const raw = readFileSync(join(cssDir, newest), 'utf8');
  const css = raw.replace(/\\/g, ''); /* 去掉 CSS 转义反斜杠，便于按类名子串匹配 */

  const badMarkers = [];
  if (/--\s*:/.test(raw)) badMarkers.push('--:');
  if (/var\(--\)/.test(raw)) badMarkers.push('var(--)');
  if (/\.\s*\{\s*\}/.test(raw)) badMarkers.push('. {}');
  if (badMarkers.length === 0) record('构建 CSS 无坏标记', 'pass', newest);
  else record('构建 CSS 无坏标记', 'fail', `${newest}: ${badMarkers.join(' ')}`);

  /* 玻璃五类 + blur 变量值 */
  const glassOk = ['.kv-panel', '.kv-chip', '.kv-overlay', '.kv-blur-panel', '.kv-blur-chip'].every((c) => css.includes(c));
  const blurOk = /--kv-blur-panel:\s*20px/.test(css) && /--kv-blur-chip:\s*8px/.test(css) && /--kv-blur-overlay:\s*30px/.test(css);
  if (glassOk && blurOk) record('构建 CSS 玻璃类与 blur 令牌', 'pass', '5 类 + 20/8/30');
  else record('构建 CSS 玻璃类与 blur 令牌', 'fail', `glass=${glassOk} blur=${blurOk}`);

  /* 本轮修复的每个括号透明度类都必须在构建 CSS 里生成 */
  const missing = [...bracketClasses].filter((cls) => !css.includes(cls));
  if (missing.length === 0) {
    record('修复的透明度类均已生成', 'pass', `${bracketClasses.size} 个括号透明度类全部命中`);
  } else {
    record('修复的透明度类均已生成', 'fail', `${missing.length} 个未生成，例: ${missing[0]}`);
  }
}

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */
try {
  const css = checkGlobals();
  checkTokenConsistency(css);
  const bracketClasses = checkTsx();
  checkBuiltCss(bracketClasses);

  const failed = results.filter((r) => r.status === 'fail');
  const ok = failed.length === 0;

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok, results }, null, 2));
  } else {
    console.log('KubeVision AI — 样式契约守卫（R1）');
    for (const r of results) {
      const icon = r.status === 'pass' ? '✓' : r.status === 'skip' ? '·' : '✗';
      console.log(`  ${icon} ${r.name}  (${r.detail})`);
    }
    console.log(ok ? '\n✓ 样式契约全部通过' : `\n✗ ${failed.length} 项违约`);
  }
  process.exit(ok ? 0 : 1);
} catch (error) {
  if (JSON_MODE) console.log(JSON.stringify({ ok: false, error: String(error) }));
  else console.error('[style-contract] 扫描失败:', error);
  process.exit(2);
}