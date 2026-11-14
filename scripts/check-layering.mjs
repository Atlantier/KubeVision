#!/usr/bin/env node
/**
 * KubeVision AI — 分层依赖守卫（R52 · 追问 1）
 *
 * 【守卫规则】
 *  1. `src/utils/**` 不得 import `src/components/**`（工具层不能反向依赖视图层）；
 *  2. `src/components/canvas/**` 不得 import `src/components/ai/**`（3D 场景不得依赖 AI 面板）；
 *  3. `src/app/api/**` 不得 import React / React DOM（服务端路由不得依赖客户端渲染运行时）。
 *
 * 【白名单集中一处】所有例外只写在下面的 `LAYER_ALLOWLIST`，每条例外必须写原因与到期复核轮次。
 * 白名单之外出现任何新违规 → exit 1（CI 失败）。
 *
 * 【实现口径】静态扫描 `src/**` 的静态 import / 动态 import() / require 字符串；
 * 支持 `@/` 别名与相对路径；解析后按真实目录判断，避免"路径写法不同绕过规则"。
 *
 * 用法：
 *   node scripts/check-layering.mjs
 *   node scripts/check-layering.mjs --json
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const JSON_OUT = process.argv.includes('--json');

/**
 * 集中白名单：例外的唯一来源。
 *
 * 字段：
 *  - file：相对仓库根的文件路径（正斜杠）
 *  - rule：规则 id
 *  - specifier：被 import 的原始模块字符串
 *  - reason：为什么允许（必须具体，不能写"历史原因"）
 *  - reviewRound：必须重新评估的轮次（到期未复核视为技术债）
 */
const LAYER_ALLOWLIST = [
  /*
   * 示例（当前为空）：
   * {
   *   file: 'src/utils/example.ts',
   *   rule: 'utils-no-components',
   *   specifier: '@/components/layout/Example',
   *   reason: '该工具函数仅被布局层调用的纯展示映射，拆分成本高于收益',
   *   reviewRound: 'r60',
   * },
   */
];

/**
 * 规则定义：按文件路径匹配，forbid 支持模块前缀与解析后目录两种口径。
 */
const RULES = [
  {
    id: 'utils-no-components',
    description: '工具层（src/utils）不得依赖视图层（src/components）',
    includes: (relPath) => relPath.startsWith('src/utils/'),
    forbid: [{ kind: 'dir', target: 'src/components' }],
  },
  {
    id: 'canvas-no-ai',
    description: '3D 场景（src/components/canvas）不得依赖 AI 面板（src/components/ai）',
    includes: (relPath) => relPath.startsWith('src/components/canvas/'),
    forbid: [{ kind: 'dir', target: 'src/components/ai' }],
  },
  {
    id: 'api-no-react-dom',
    description: 'API 路由（src/app/api）不得依赖 React / React DOM（服务端运行时）',
    includes: (relPath) => relPath.startsWith('src/app/api/'),
    forbid: [
      {
        kind: 'module',
        modules: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      },
    ],
  },
];

/** 递归收集 src 下所有 .ts/.tsx 文件（相对仓库根、正斜杠） */
function collectSourceFiles(dir = SRC) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      out.push(...collectSourceFiles(absolute));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(relative(ROOT, absolute).split(sep).join('/'));
    }
  }
  return out;
}

/**
 * 提取模块字符串：静态 import / export ... from / 动态 import() / require()。
 *
 * @param source 文件内容
 * @returns { specifiers: string[], line: number } 每项带首次出现的行号
 */
function extractSpecifiers(source) {
  const results = [];
  const patterns = [
    /(?:\bfrom\s+)['"]([^'"]+)['"]/g, // import ... from 'x' / export ... from 'x'
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g, // import 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('x')
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[1];
      const line = source.slice(0, match.index).split('\n').length;
      results.push({ specifier, line });
      match = pattern.exec(source);
    }
  }
  return results;
}

/**
 * 把 import 字符串解析为仓库内相对路径（仅对仓库内模块）。
 *
 * @param specifier 原始模块字符串
 * @param fromFile 相对仓库根的文件路径
 * @returns 相对仓库根的目标路径（不带扩展名也可能），仓库外返回 null
 */
function resolveSpecifier(specifier, fromFile) {
  if (specifier.startsWith('@/')) return 'src/' + specifier.slice(2);
  if (specifier.startsWith('.')) {
    const resolved = resolve(ROOT, fromFile, '..', specifier);
    const rel = relative(ROOT, resolved).split(sep).join('/');
    return rel.startsWith('..') ? null : rel;
  }
  return null;
}

/** 判断目标是否落在某目录下（含目录本身） */
function isUnder(targetPath, dirPath) {
  return targetPath === dirPath || targetPath.startsWith(dirPath + '/');
}

/**
 * 剥离 JS/TS 注释但保留全部换行符，避免注释文本误命中 `<Html>` 契约且保持报错行号精确一致。
 *
 * @param source 文件源码
 * @returns 等行数的去注释源码
 */
function stripCommentsPreserveLines(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 校验 `src/components/canvas/**` 下 `<Html>` 铭牌契约（R6 进阶）：
 * 所有 `<Html>` 必须显式传入 `distanceFactor` 属性，且值必须来自 `HUD_LABEL_SPEC.<KEY>.distanceFactor`
 * （同时文件内需从 `constants/hud` 导入 `HUD_LABEL_SPEC`），严禁字面量或其他未受控表达式。
 *
 * @param file 相对仓库根路径
 * @param source 文件源码
 * @param specifiers 已提取的模块引用列表
 * @returns 违规记录列表
 */
function checkCanvasHtmlLabelContract(file, source, specifiers) {
  if (!file.startsWith('src/components/canvas/')) return [];
  const clean = stripCommentsPreserveLines(source);
  const htmlTagRegex = /<Html(?=\s|>|\/)/g;
  const issues = [];

  const importsHudSpec =
    /\bHUD_LABEL_SPEC\b/.test(clean) &&
    specifiers.some((item) => {
      const target = resolveSpecifier(item.specifier, file);
      return target === 'src/constants/hud';
    });

  let match = htmlTagRegex.exec(clean);
  while (match !== null) {
    const tagStart = match.index;
    const line = clean.slice(0, tagStart).split('\n').length;
    /* 从 `<Html` 扫到开标签闭合 `>`（追踪 `{...}` 深度和引号，避免 `=>` 或 `raycast={() => undefined}` 提前截断） */
    let cursor = tagStart + 5;
    let braceDepth = 0;
    let quote = null;
    while (cursor < clean.length) {
      const ch = clean[cursor];
      if (quote !== null) {
        if (ch === '\\' && cursor + 1 < clean.length) {
          cursor += 2;
          continue;
        }
        if (ch === quote) quote = null;
        cursor += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        cursor += 1;
        continue;
      }
      if (ch === '{') braceDepth += 1;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === '>' && braceDepth === 0) break;
      cursor += 1;
    }

    const openTagAttrs = clean.slice(tagStart, cursor + 1);
    const dfMatch = /\bdistanceFactor\b\s*=\s*/.exec(openTagAttrs);
    if (dfMatch === null) {
      issues.push({
        file,
        line,
        rule: 'canvas-html-spec',
        specifier: '<Html> 缺少显式 distanceFactor={HUD_LABEL_SPEC.<KEY>.distanceFactor}',
        allowlisted: false,
        allowReason: null,
      });
    } else {
      const afterEq = openTagAttrs.slice(dfMatch.index + dfMatch[0].length);
      let expr = '';
      if (afterEq.startsWith('{')) {
        let depth = 0;
        let q = null;
        for (let k = 0; k < afterEq.length; k += 1) {
          const c = afterEq[k];
          if (q !== null) {
            if (c === '\\') {
              k += 1;
              continue;
            }
            if (c === q) q = null;
            continue;
          }
          if (c === "'" || c === '"' || c === '`') {
            q = c;
            continue;
          }
          if (c === '{') depth += 1;
          else if (c === '}') {
            depth -= 1;
            if (depth === 0) {
              expr = afterEq.slice(1, k).trim();
              break;
            }
          }
        }
      } else {
        expr = afterEq.split(/[\s/>]/)[0];
      }

      const validExpr = /^HUD_LABEL_SPEC\.[A-Z0-9_]+\.distanceFactor$/.test(expr);
      if (!validExpr || !importsHudSpec) {
        issues.push({
          file,
          line,
          rule: 'canvas-html-spec',
          specifier: `distanceFactor={${expr || '?'}}（必须导入并引用 HUD_LABEL_SPEC.<KEY>.distanceFactor，禁字面量）`,
          allowlisted: false,
          allowReason: null,
        });
      }
    }

    match = htmlTagRegex.exec(clean);
  }
  return issues;
}

/** 检查一条 import 是否命中某规则的 forbid 项 */
function matchesForbid(specifier, resolvedPath, forbid) {
  if (forbid.kind === 'module') {
    return forbid.modules.includes(specifier);
  }
  if (forbid.kind === 'dir') {
    return resolvedPath !== null && isUnder(resolvedPath, forbid.target);
  }
  return false;
}

/** 白名单查找 */
function isAllowlisted(file, ruleId, specifier) {
  return LAYER_ALLOWLIST.find(
    (entry) => entry.file === file && entry.rule === ruleId && entry.specifier === specifier,
  );
}

function main() {
  const files = collectSourceFiles();
  const violations = [];
  let checkedImports = 0;

  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const specifiers = extractSpecifiers(source);
    checkedImports += specifiers.length;
    violations.push(...checkCanvasHtmlLabelContract(file, source, specifiers));
    for (const rule of RULES) {
      if (!rule.includes(file)) continue;
      for (const item of specifiers) {
        const resolved = resolveSpecifier(item.specifier, file);
        for (const forbid of rule.forbid) {
          if (!matchesForbid(item.specifier, resolved, forbid)) continue;
          const allowed = isAllowlisted(file, rule.id, item.specifier);
          violations.push({
            file,
            line: item.line,
            rule: rule.id,
            specifier: item.specifier,
            allowlisted: allowed !== undefined,
            allowReason: allowed?.reason ?? null,
          });
        }
      }
    }
  }

  const blocking = violations.filter((violation) => !violation.allowlisted);

  if (JSON_OUT) {
    console.log(JSON.stringify({ checkedFiles: files.length, checkedImports, violations }, null, 2));
  } else {
    console.log('分层依赖守卫（check-layering）');
    console.log(`  扫描 ${files.length} 个文件 / ${checkedImports} 条模块引用`);
    for (const rule of RULES) {
      const count = blocking.filter((violation) => violation.rule === rule.id).length;
      console.log(`  ${count === 0 ? '✓' : '✗'} ${rule.id} — ${rule.description}（白名单 ${
        LAYER_ALLOWLIST.filter((entry) => entry.rule === rule.id).length
      } 条）`);
    }
    const htmlContractCount = blocking.filter((violation) => violation.rule === 'canvas-html-spec').length;
    console.log(
      `  ${htmlContractCount === 0 ? '✓' : '✗'} canvas-html-spec — canvas 下所有 <Html> 显式引用 HUD_LABEL_SPEC.distanceFactor（禁字面量）`,
    );
    if (violations.length > 0) {
      console.log('\n  明细（含已白名单）：');
      for (const violation of violations) {
        console.log(
          `    ${violation.allowlisted ? '·' : '✗'} ${violation.file}:${violation.line}  [${violation.rule}]  '${violation.specifier}'` +
            (violation.allowlisted ? `  （白名单：${violation.allowReason}）` : ''),
        );
      }
    }
    if (blocking.length > 0) {
      console.log(`\n  ✗ 发现 ${blocking.length} 条未白名单的分层违规：请修正依赖方向，或在 LAYER_ALLOWLIST 登记原因。`);
    } else {
      console.log('\n  ✓ 分层规则全部通过');
    }
  }

  process.exit(blocking.length === 0 ? 0 : 1);
}

main();