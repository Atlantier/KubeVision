#!/usr/bin/env node
/**
 * KubeVision AI — 样式契约静态守卫（R1 视觉地基 · R2 CI 可校验）
 *
 * 【设计意图】玻璃四层与 Tailwind 透明度档位是"写了但可能静默失效"的重灾区：
 *   - CSS 里残留 `--:` / `var(--)` / 空选择器 `. {}` 会让整段规则失效；
 *   - Tailwind v3 只生成默认 opacity 刻度（0/5/10/20/25/30/40/50/60/70/75/80/90/95/100），
 *     裸写 /8、/12、/88、/92、/15、/55 等会被静默丢弃；
 *   - 双重透明度 `white/[0.07]/60` 是非法语法，整条类不生成；
 *   - 半像素 / <10px 字号违反可读性契约。
 * 这些缺陷肉眼极难发现（画面"看起来正常"），必须静态扫描 + 构建产物比对。
 *
 * 【R2 · 全量透明度比对】提取 src 全部含透明度修饰符的类（裸刻度值 + 括号任意值），
 * 逐个与生产 CSS 选择器比对，输出「源码类总数 / 已生成数 / 缺失清单」。
 * 缺失即静默失效，必须阻断 verify；不设白名单掩盖。
 *
 * 【R3 · 补齐验证边界】
 *   - 动态拼接闸门：颜色/透明度类里出现 ${…} 插值即 fail（Tailwind 无法静态生成），
 *     把"动态类名"从无能为力的边界变成可拦截的违约；
 *   - --require-build：CI 硬闸门，缺生产 CSS 时全量比对不再 skip 而是 fail，
 *     确保"类是否真实生成"永远被验证（配合先 pnpm build 使用）。
 *
 * 【输入】src/app/globals.css、src/constants/tokens.ts、src/**\/*.{ts,tsx}、
 *         以及（若存在）.next/static/css/*.css 构建产物。
 * 【输出】--json 时输出 { ok, opacityReport, results:[{name,status,detail}] }；否则人类可读。
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
/* --require-build：CI 硬闸门。未提供生产 CSS 时，全量透明度比对不再 skip 而是 fail，
 * 确保"类是否真实生成"这一项永远被验证，不会因缺构建而静默跳过。 */
const REQUIRE_BUILD = process.argv.includes('--require-build');

/** Tailwind v3 默认 opacity 刻度（裸值只有这些会生成） */
const VALID_OPACITY = new Set([0, 5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95, 100]);

/** 颜色工具类前缀（可带透明度修饰符） */
const COLOR_PREFIX = '(?:bg|text|border|ring|from|to|via|fill|stroke|divide|placeholder|decoration|outline|accent|caret|shadow)';

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
}

function walkSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(full));
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 剥离块注释：中文 JSDoc 里可能引用 `/8、/12`、`bg-x/50` 等字样作说明，
 *  不应被当作真实类名参与提取/比对。只留真正的代码。 */
function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
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
  const files = walkSources(join(ROOT, 'src'));
  const doubleHits = [];
  const bareHits = [];
  const fontHits = [];
  const dynamicHits = [];
  const bracketClasses = new Set();
  /* 全部含透明度修饰符的类（裸刻度值 + 括号任意值），供与生产 CSS 逐一比对 */
  const opacityClasses = new Set();

  const doubleRe = /\/\[0\.\d+\]\/\d+/g;
  const bareRe = new RegExp('\\b(' + COLOR_PREFIX + '-(?:[a-zA-Z]+(?:-[a-zA-Z0-9]+)*))\\/(\\d{1,3})\\b', 'g');
  const bracketRe = new RegExp('\\b(' + COLOR_PREFIX + '-[a-zA-Z0-9-]+\\/\\[0\\.\\d+\\])', 'g');
  /* 统一提取：颜色工具类 + /裸数字 或 /[0.xxx]，一次抓全 */
  const opacityRe = new RegExp('\\b(' + COLOR_PREFIX + '-[a-zA-Z]+(?:-[a-zA-Z0-9]+)*\\/(?:\\d{1,3}|\\[0?\\.\\d+\\]))', 'g');
  /* 动态拼接检测：颜色工具类 / 透明度修饰符里出现 ${…} 插值 → Tailwind 无法静态生成，
   * 属静默失效。此闸门把"动态类名"从"无能为力的边界"变成"可被拦截的违约"。 */
  const dynamicRe = new RegExp('\\b' + COLOR_PREFIX + '-[a-zA-Z0-9-]*(?:/)?\\$\\{', 'g');
  const fontRe = /text-\[(\d+(?:\.\d+)?)px\]/g;

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const original = readFileSync(file, 'utf8');
    const src = stripBlockComments(original);
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
    let om;
    opacityRe.lastIndex = 0;
    while ((om = opacityRe.exec(src)) !== null) opacityClasses.add(om[1]);
    /* 动态拼接只可能出现在 className 里，而 className 只存在于 React 组件（.tsx）。
     * .ts（API 路由 / 工具 / 常量）无 className——例如 route.ts 的 `fill-${toolName}`
     * 是 toolCallId 前缀，不是颜色类，不应误报。故仅对 .tsx 扫描，且按原始文本定位行号。 */
    if (file.endsWith('.tsx')) {
      let dm;
      dynamicRe.lastIndex = 0;
      while ((dm = dynamicRe.exec(src)) !== null) {
        const origIdx = original.indexOf(dm[0]);
        const lineNo = origIdx >= 0 ? original.slice(0, origIdx).split('\n').length : '?';
        dynamicHits.push(`${rel}:${lineNo} ${dm[0]}…}`);
      }
    }
  }

  if (doubleHits.length === 0) record('无双重透明度', 'pass', '0 处');
  else record('无双重透明度', 'fail', `${doubleHits.length} 处，例: ${doubleHits[0]}`);

  if (bareHits.length === 0) record('无非刻度裸透明度', 'pass', '0 处');
  else record('无非刻度裸透明度', 'fail', `${bareHits.length} 处，例: ${bareHits[0]}`);

  if (fontHits.length === 0) record('字号 ≥10px 且无半像素', 'pass', '0 处违规');
  else record('字号 ≥10px 且无半像素', 'fail', `${fontHits.length} 处，例: ${fontHits[0]}`);

  if (dynamicHits.length === 0) record('无动态拼接颜色/透明度类', 'pass', '0 处（全部为静态字面量，可被 Tailwind 生成）');
  else record('无动态拼接颜色/透明度类', 'fail', `${dynamicHits.length} 处，例: ${dynamicHits[0]}`);

  return { bracketClasses, opacityClasses };
}

/* ========================================================================== */
/* 4. 构建产物 CSS：无坏标记 + 玻璃类 + 全部透明度类逐一比对（缺失即阻断）       */
/* ========================================================================== */

/** 供主流程输出「源码类总数 / 已生成数 / 缺失清单」 */
let opacityReport = { total: 0, generated: 0, missing: [], cssFile: null };

function checkBuiltCss(classes) {
  const { opacityClasses } = classes;
  opacityReport.total = opacityClasses.size;

  const cssDir = join(ROOT, '.next/static/css');
  if (!existsSync(cssDir)) {
    if (REQUIRE_BUILD) record('构建 CSS 校验', 'fail', '--require-build：未找到 .next/static/css，必须先 pnpm build');
    else record('构建 CSS 校验', 'skip', '未找到 .next/static/css（先运行 pnpm build）');
    return;
  }
  const cssFiles = readdirSync(cssDir).filter((f) => f.endsWith('.css'));
  if (cssFiles.length === 0) {
    if (REQUIRE_BUILD) record('构建 CSS 校验', 'fail', '--require-build：.next/static/css 为空，必须先 pnpm build');
    else record('构建 CSS 校验', 'skip', '目录为空（先运行 pnpm build）');
    return;
  }
  /* 取体积最大的构建产物（主样式 bundle） */
  let newest = cssFiles[0];
  let newestSize = 0;
  for (const f of cssFiles) {
    const st = readFileSync(join(cssDir, f));
    if (st.length > newestSize) { newestSize = st.length; newest = f; }
  }
  opacityReport.cssFile = newest;
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

  /*
   * 全量透明度类比对：src 里每一个含透明度修饰符的类，都必须在生产 CSS 里
   * 有对应选择器。缺失 = 静默失效，必须阻断 verify；不设白名单掩盖。
   * 比对前去掉 CSS 转义反斜杠，variant 前缀（hover: 等）不影响核心类名命中。
   */
  const missing = [...opacityClasses].filter((cls) => !css.includes(cls)).sort();
  opacityReport.missing = missing;
  opacityReport.generated = opacityClasses.size - missing.length;

  if (missing.length === 0) {
    record(
      '透明度类全量生成比对',
      'pass',
      `源码 ${opacityReport.total} 类 / 已生成 ${opacityReport.generated} / 缺失 0`,
    );
  } else {
    record(
      '透明度类全量生成比对',
      'fail',
      `源码 ${opacityReport.total} 类 / 已生成 ${opacityReport.generated} / 缺失 ${missing.length}: ${missing.join(', ')}`,
    );
  }
}

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */
try {
  const css = checkGlobals();
  checkTokenConsistency(css);
  const classes = checkTsx();
  checkBuiltCss(classes);

  const failed = results.filter((r) => r.status === 'fail');
  const ok = failed.length === 0;

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok, opacityReport, results }, null, 2));
  } else {
    console.log('KubeVision AI — 样式契约守卫（R2 · CI 可校验）');
    for (const r of results) {
      const icon = r.status === 'pass' ? '✓' : r.status === 'skip' ? '·' : '✗';
      console.log(`  ${icon} ${r.name}  (${r.detail})`);
    }
    /* 明确的「源码类总数 / 已生成数 / 缺失清单」报告 */
    console.log('\n  透明度类比对（生产 CSS: ' + (opacityReport.cssFile ?? '无构建') + '）');
    console.log(`    源码类总数: ${opacityReport.total} · 已生成: ${opacityReport.generated} · 缺失: ${opacityReport.missing.length}`);
    if (opacityReport.missing.length > 0) {
      console.log('    缺失清单:');
      for (const cls of opacityReport.missing) console.log('      ✗ ' + cls);
    }
    console.log(ok ? '\n✓ 样式契约全部通过' : `\n✗ ${failed.length} 项违约`);
  }
  process.exit(ok ? 0 : 1);
} catch (error) {
  if (JSON_MODE) console.log(JSON.stringify({ ok: false, error: String(error) }));
  else console.error('[style-contract] 扫描失败:', error);
  process.exit(2);
}