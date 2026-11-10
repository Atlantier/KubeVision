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