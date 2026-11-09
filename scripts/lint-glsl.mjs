#!/usr/bin/env node
/**
 * KubeVision AI — GLSL 静态高危模式检查（scripts/lint-glsl.mjs）
 *
 * 【为什么需要静态检查而不是靠跑起来看】下面这些写法在多数输入下都"看起来正常"：
 * 画面不会黑，只是某些角度/某些帧出现一个 NaN 像素。WebGL 对 NaN 的传播极其
 * 隐蔽——一个片元算出 NaN 后，后处理链的 bloom 会把它扩散成一整块黑或一整块白，
 * 而且**不同 GPU 行为不同**（软渲染可能吞掉，独显可能整屏爆掉）。
 * 等到现场才发现的成本远高于静态扫一遍。
 *
 * 【检查项与判据（对应本轮 A.2 的固定改写规则）】
 *  1. inverted-smoothstep：`smoothstep(a, b, x)` 且字面量 a > b。
 *     GLSL 规范对 edge0 >= edge1 的结果是 undefined，必须改写为
 *     `1.0 - smoothstep(b, a, x)`。
 *  2. unguarded-pow：`pow(x, y)` 的首参不是 `max(` / `clamp(` 包裹。
 *     GLSL 的 pow(x,y) 在 x < 0 时为 undefined，是 NaN 的第一大来源。
 *     紧接的 `max(0.0, ...)` 或 `clamp(..., 0.0, ...)` 视为已保护。
 *  3. integer-pow：`pow(x, 2.0|3.0)`。整数次幂用乘法既更快又无 NaN 风险。
 *  4. unguarded-atan：双参 `atan(y, x)` 前 6 行内没有 `abs(` 保护。
 *     atan(0,0) 为 undefined。
 *  5. unclamped-fragcolor：`gl_FragColor` / `gl_FragColor =` 未经过
 *     `clamp(...)`。HDR 溢出会得到 Inf，Inf 参与 bloom 会污染整帧。
 *
 * 【豁免机制】行尾写 `// glsl-lint-allow: <理由>` 即跳过该行。
 * 要求写理由而不是简单 `// lint-ignore`：豁免必须可被答辩追问。
 *
 * 【用法】
 *   node scripts/lint-glsl.mjs            # 扫 src/，有 HIGH 级命中则退出码 1
 *   node scripts/lint-glsl.mjs --json     # 输出机器可读结果
 *   node scripts/lint-glsl.mjs --table    # 只输出审计表（markdown）
 *
 * 【退出码】0 = 无 HIGH 级命中；1 = 有 HIGH 级命中；2 = 扫描失败
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/* ========================================================================== */
/* 参数                                                                        */
/* ========================================================================== */

const wantJson = process.argv.includes('--json');
const wantTable = process.argv.includes('--table');

/** 扫描根目录 */
const SRC_ROOT = 'src';

/** 只扫这些扩展名 */
const EXTENSIONS = new Set(['.ts', '.tsx']);

/** 豁免标记（行尾） */
const ALLOW_MARK = 'glsl-lint-allow';

/* ========================================================================== */
/* 规则                                                                        */
/* ========================================================================== */

/**
 * 规则定义。
 *
 * `severity: 'high'` 会参与退出码判定；`'info'` 只做提示（例如需要人工判断
 * 上下文才能确定是否真的有风险）。
 */
const RULES = [
  {
    id: 'inverted-smoothstep',
    severity: 'high',
    title: '倒置 smoothstep（edge0 > edge1，GLSL 结果未定义）',
    rewrite: '改为 1.0 - smoothstep(b, a, x)',
    /**
     * 匹配两个字面量参数且 a > b 的 smoothstep 调用。
     *
     * 【为什么不匹配 uniform】`smoothstep(uA, uB, x)` 的运行时大小关系
     * 静态不可知，误报率极高；这种情况交给规则 `dynamic-smoothstep` 做 info 提示，
     * 由人工按"是否可能倒置"决定是否加 min/max 夹取。
     */
    match: (line) => {
      const re = /smoothstep\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,/g;
      const hits = [];
      let m = re.exec(line);
      while (m !== null) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (a > b) hits.push({ matched: m[0].trim(), a, b });
        m = re.exec(line);
      }
      return hits;
    },
  },
  {
    id: 'dynamic-smoothstep',
    severity: 'info',
    title: 'smoothstep 边界含运行时值（静态不可判是否倒置）',
    rewrite: '若边界可能倒置，用 smoothstep(min(a,b-1e-4), max(b,a+1e-4), x)',
    match: (line) => {
      /* 至少一个参数不是纯数字，且整体是 smoothstep 调用 */
      const re = /smoothstep\s*\(([^)]*)\)/g;
      const hits = [];
      let m = re.exec(line);
      while (m !== null) {
        const args = m[1];
        if (args !== undefined && !/^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*,\s*[\w.]+\s*$/.test(args)) {
          hits.push({ matched: m[0].trim().slice(0, 60) });
        }
        m = re.exec(line);
      }
      return hits;
    },
  },
  {
    id: 'integer-pow',
    severity: 'high',
    title: '整数次幂 pow(x, 2.0/3.0)（可用乘法代替，且无 NaN 风险）',
    rewrite: 'd*d（2 次）/ d*d*d（3 次）',
    match: (line) => {
      /* 排除 JS 侧的 Math.pow：它不是 GLSL，不适用本规则 */
      if (/Math\.pow\s*\(/.test(line)) return [];
      const re = /pow\s*\(\s*([^,]+?)\s*,\s*(2\.0|3\.0|2|3)\s*\)/g;
      const hits = [];
      let m = re.exec(line);
      while (m !== null) {
        hits.push({ matched: m[0].trim().slice(0, 60) });
        m = re.exec(line);
      }
      return hits;
    },
  },
  {
    id: 'unguarded-pow',
    severity: 'high',
    title: 'pow 首参未做非负保护（x<0 时 GLSL 结果未定义 → NaN）',
    rewrite: 'pow(max(x, 1e-4), y)',
    match: (line) => {
      /* 排除 JS 侧的 Math.pow：Math.pow 对负数完全合法，无 NaN 风险 */
      if (/Math\.pow\s*\(/.test(line)) return [];
      const re = /pow\s*\(\s*([^,]+?)\s*,/g;
      const hits = [];
      let m = re.exec(line);
      while (m !== null) {
        const base = (m[1] ?? '').trim();
        const guarded = /^max\s*\(/.test(base) || /^clamp\s*\(/.test(base) || /^abs\s*\(/.test(base);
        /* 纯数字常量或已知非负量（clamp/max 结果、smoothstep 结果差分前的 1.0-…）另行判断 */
        const isLiteral = /^\d+(\.\d+)?$/.test(base);
        if (!guarded && !isLiteral) {
          hits.push({ matched: m[0].trim().slice(0, 60), base: base.slice(0, 40) });
        }
        m = re.exec(line);
      }
      return hits;
    },
  },
  {
    id: 'unguarded-atan',
    severity: 'high',
    title: '双参 atan 未见 abs 保护（atan(0,0) 结果为 undefined）',
    rewrite: '先判 abs(x)+abs(y) > 1e-4 再算，否则 0.0',
    /**
     * 需要看上下文：保护语句通常写在调用前几行。因此 match 返回
     * "本行是否出现 atan("，由主循环带着前后文窗口做二次判定。
     */
    match: (line) => {
      if (!/(^|[^a-zA-Z_])atan\s*\(\s*[^)]*,\s*[^)]*\)/g.test(line)) return [];
      if (/atan\s*\(\s*[^,)]+\)/g.test(line) && !/,/.test(line)) return [];
      return [{ matched: (line.match(/atan\s*\([^)]*\)/) ?? [''])[0].slice(0, 60) }];
    },
  },
  {
    id: 'unclamped-fragcolor',
    severity: 'high',
    title: '片元输出未 clamp（HDR 溢出会产生 Inf 并污染后处理）',
    rewrite: 'gl_FragColor = vec4(clamp(rgb, 0.0, 8.0), clamp(a, 0.0, 1.0));',
    match: (line) => {
      if (!/gl_FragColor\s*=/.test(line)) return [];
      if (/clamp\s*\(/.test(line)) return [];
      return [{ matched: line.trim().slice(0, 80) }];
    },
  },
];

/* ========================================================================== */
/* 文件遍历                                                                    */
/* ========================================================================== */

/**
 * 递归列出待扫描文件。
 *
 * @param {string} dir 目录
 * @param {string[]} acc 累加器
 * @returns {string[]} 文件路径列表
 */
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, acc);
      continue;
    }
    if (EXTENSIONS.has(extname(name))) acc.push(full);
  }
  return acc;
}

/* ========================================================================== */
/* 扫描                                                                        */
/* ========================================================================== */

/**
 * 判断某一行是否处于"着色器字符串"上下文。
 *
 * 【为何要判上下文】`Math.pow` / `Math.sqrt` 等 JS 调用与 GLSL 语法相近，
 * 若不加区分会把 JS 侧的正常代码也报出来，噪声会淹没真正的问题。
 * 这里用文件级判定：文件内任一行含 GLSL 特征（varying/uniform/gl_FragColor/
 * gl_Position/precision 等），则该文件内的规则命中才计入。
 *
 * @param {string} content 文件全文
 * @returns {boolean} 是否包含 GLSL
 */
function hasGlslContent(content) {
  return /varying\s+vec|\buniform\s+vec|\buniform\s+float|gl_FragColor|gl_Position|precision\s+(highp|mediump|lowp)|\bvoid\s+main\s*\(\s*\)/.test(
    content,
  );
}

/**
 * 扫描单个文件。
 *
 * @param {string} filePath 路径
 * @returns {object[]} 命中列表
 */
function scanFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  if (!hasGlslContent(content)) return [];

  const lines = content.split(/\r?\n/);
  const findings = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.includes(ALLOW_MARK)) continue;
    /* 纯注释行跳过：注释里的示例代码不是真实调用 */
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;

    let lineHasHigh = false;
    for (const rule of RULES) {
      /*
       * 【去重规则】同一行若已被 HIGH 级规则命中，就不再输出 INFO。
       * 否则 `smoothstep(0.38, 0.12, ...)` 会同时出现在
       * "倒置 smoothstep"（HIGH）与"边界含运行时值"（INFO）里，
       * 自相矛盾且稀释重点。
       */
      if (rule.severity === 'info' && lineHasHigh) continue;
      const hits = rule.match(line);
      if (hits.length === 0) continue;
      if (rule.severity === 'high') lineHasHigh = true;

      /* atan 需要看前文是否已有保护 */
      if (rule.id === 'unguarded-atan') {
        const windowStart = Math.max(0, i - 6);
        const windowText = lines.slice(windowStart, i + 1).join('\n');
        if (/abs\s*\(/.test(windowText) && /1\.0e-4|1e-4|0\.0001/.test(windowText)) continue;
      }

      for (const hit of hits) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          title: rule.title,
          rewrite: rule.rewrite,
          file: relative(process.cwd(), filePath),
          line: i + 1,
          code: line.trim().slice(0, 120),
          matched: hit.matched ?? '',
        });
      }
    }
  }

  return findings;
}

/* ========================================================================== */
/* 主流程                                                                      */
/* ========================================================================== */

function main() {
  let files = [];
  try {
    files = walk(SRC_ROOT);
  } catch (err) {
    console.error(`[FATAL] 无法遍历 ${SRC_ROOT}: ${String(err)}`);
    process.exit(2);
  }

  const all = [];
  let scanned = 0;
  let glslFiles = 0;
  for (const file of files) {
    scanned += 1;
    const found = scanFile(file);
    if (found.length > 0) {
      glslFiles += 1;
      all.push(...found);
    }
  }

  const highs = all.filter((f) => f.severity === 'high');
  const infos = all.filter((f) => f.severity === 'info');

  /* ---- JSON 模式 ---- */
  if (wantJson) {
    console.log(JSON.stringify({ scanned, glslFiles, high: highs, info: infos }, null, 2));
    process.exit(highs.length > 0 ? 1 : 0);
  }

  /* ---- 审计表模式 ---- */
  if (wantTable) {
    console.log('| 文件 | 行 | 规则 | 原写法 | 建议改法 |');
    console.log('|---|---|---|---|---|');
    for (const f of highs) {
      const code = f.code.replace(/\|/g, '\\|').slice(0, 88);
      console.log(`| \`${f.file}\` | ${f.line} | ${f.rule} | \`${code}\` | ${f.rewrite} |`);
    }
    process.exit(highs.length > 0 ? 1 : 0);
  }

  /* ---- 人类可读输出 ---- */
  console.log('KubeVision AI — GLSL 静态高危检查（lint-glsl）');
  console.log(`  扫描文件: ${scanned} 个（含 GLSL 特征 ${glslFiles} 个）`);
  console.log(`  HIGH 命中: ${highs.length} · INFO 提示: ${infos.length}`);
  console.log('');

  if (highs.length > 0) {
    console.log('  HIGH —— 必须修复：');
    const byFile = new Map();
    for (const f of highs) {
      const list = byFile.get(f.file) ?? [];
      list.push(f);
      byFile.set(f.file, list);
    }
    for (const [file, list] of byFile) {
      console.log(`  ${file}`);
      for (const f of list) {
        console.log(`    L${f.line}  [${f.rule}]`);
        console.log(`      原写法: ${f.code}`);
        console.log(`      改法  : ${f.rewrite}`);
      }
    }
    console.log('');
  }

  if (infos.length > 0) {
    console.log(`  INFO —— 需人工判断（${infos.length} 条，不影响退出码）：`);
    for (const f of infos.slice(0, 12)) {
      console.log(`    ${f.file}:${f.line}  ${f.code}`);
    }
    if (infos.length > 12) console.log(`    … 其余 ${infos.length - 12} 条省略`);
    console.log('');
  }

  if (highs.length === 0) {
    console.log('  ✓ 无 HIGH 级命中');
    process.exit(0);
  }

  console.log(`  ✗ 存在 ${highs.length} 处 HIGH 级风险，见上。`);
  process.exit(1);
}

main();
