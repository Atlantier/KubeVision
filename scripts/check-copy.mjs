#!/usr/bin/env node
/**
 * KubeVision AI — R11 文案、术语表与本地化门禁（scripts/check-copy.mjs）
 *
 * 【门禁口径（C1–C8）】
 *  - C1：同屏 AI 角色名统一（禁止混用 SRE Copilot / AI Copilot / 智能副驾 / Edge Log Auditor，
 *        仅允许 scripts/copy-allowlist.json 中经审批的 sr-only/aria 测试选择器例外）
 *  - C2：全站禁词与异形拼写清零（Cgroup / APIServer / API-Server / ApiServer / 裸控制面 / req/s / 脑裂 / 全大写 POD / 裸 apiserver）
 *  - C3：生硬英文仪表装饰与按钮标签清零（STAGE-00 / MOCK MODE / LIVE CLUSTER / SIMULATED / MCP RECEIPT / SYS // 等）
 *  - C4：面向用户的复盘报告零内部类型与变量名泄漏（ClusterContext / RootCauseAlertProps / synthesized=true / localStorage 等）
 *  - C5：中英文标点与引导型空态质检（禁止中文后接 ASCII `...`、中文语境 `->`、坏空态 `'查询缺乏区分度'`、`(Incident Summary)` 半角括号）
 *  - C6：混沌故障场景名称统一源核验（禁止同义异形词漂移，且验证 6 处消费入口全部接入 `@/constants/copy`）
 *  - C7：错因三要素完备性与术语表 A–E + J1–J3 权威契约核验
 *  - C8：白名单双向一致核验（scripts/copy-allowlist.json 每条例外必须真实命中对应行，零僵尸条目）
 *
 * 用法：
 *   node scripts/check-copy.mjs
 *   node scripts/check-copy.mjs --json
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, 'src');
const JSON_OUT = process.argv.includes('--json');

/** 递归收集 src 下全部 .ts / .tsx 文件 */
function walkTsFiles(dir) {
  const collected = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...walkTsFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      collected.push(fullPath);
    }
  }
  return collected;
}

/**
 * 在保留精确行号（保留所有换行符）的前提下剥离 TS/JS 注释（// 与 /* * /）。
 * 正确跳过单引号、双引号与反引号字符串内部，避免把 `https://` 或 UI 文案误判为注释。
 */
function stripCommentsPreserveLines(source) {
  const out = [];
  let i = 0;
  const len = source.length;
  let quote = null;

  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : '';

    if (quote !== null) {
      out.push(ch);
      if (ch === '\\' && i + 1 < len) {
        out.push(source[i + 1]);
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out.push(ch);
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < len && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len) {
        if (source[i] === '*' && i + 1 < len && source[i + 1] === '/') {
          i += 2;
          break;
        }
        if (source[i] === '\n') out.push('\n');
        i += 1;
      }
      continue;
    }

    out.push(ch);
    i += 1;
  }

  return out.join('');
}

/**
 * 提取文件中的字符串字面量与模板静态文本片段（跳过 `${...}` 代码插值表达式），
 * 返回 `{ line, text }[]`，用于 C4 精确审计导出文本与面向用户的模板文案。
 */
function extractStringSegments(sourceNoComments) {
  const segments = [];
  let line = 1;
  let i = 0;
  const len = sourceNoComments.length;

  while (i < len) {
    const ch = sourceNoComments[i];
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const startLine = line;
      const q = ch;
      i += 1;
      let buf = '';
      while (i < len) {
        const c = sourceNoComments[i];
        if (c === '\n') line += 1;
        if (c === '\\' && i + 1 < len) {
          buf += c + sourceNoComments[i + 1];
          i += 2;
          continue;
        }
        if (c === q) {
          i += 1;
          break;
        }
        buf += c;
        i += 1;
      }
      segments.push({ line: startLine, text: buf });
      continue;
    }

    if (ch === '`') {
      let startLine = line;
      let buf = '';
      i += 1;
      while (i < len) {
        const c = sourceNoComments[i];
        if (c === '\n') line += 1;
        if (c === '\\' && i + 1 < len) {
          buf += c + sourceNoComments[i + 1];
          i += 2;
          continue;
        }
        if (c === '$' && i + 1 < len && sourceNoComments[i + 1] === '{') {
          if (buf.length > 0) segments.push({ line: startLine, text: buf });
          buf = '';
          i += 2;
          const exprStartLine = line;
          const exprStart = i;
          let depth = 1;
          while (i < len && depth > 0) {
            const ic = sourceNoComments[i];
            if (ic === '\n') line += 1;
            if (ic === '{') depth += 1;
            else if (ic === '}') depth -= 1;
            i += 1;
          }
          const innerCode = sourceNoComments.slice(exprStart, Math.max(exprStart, i - 1));
          const innerSegments = extractStringSegments(innerCode);
          for (const seg of innerSegments) {
            segments.push({ line: exprStartLine + seg.line - 1, text: seg.text });
          }
          startLine = line;
          continue;
        }
        if (c === '`') {
          if (buf.length > 0) segments.push({ line: startLine, text: buf });
          i += 1;
          break;
        }
        buf += c;
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return segments;
}

const allowlistPath = join(ROOT, 'scripts/copy-allowlist.json');
const allowlistRaw = existsSync(allowlistPath)
  ? JSON.parse(readFileSync(allowlistPath, 'utf8'))
  : { entries: [] };
const allowEntries = Array.isArray(allowlistRaw.entries) ? allowlistRaw.entries : [];
const matchedAllowKeys = new Set();

function allowKey(entry) {
  return `${entry.file}:${entry.line}:${entry.rule}:${entry.pattern}`;
}

function isAllowlisted(relPath, lineNum, rule, lineText) {
  for (const entry of allowEntries) {
    if (
      entry.file === relPath &&
      entry.line === lineNum &&
      entry.rule === rule &&
      typeof entry.pattern === 'string' &&
      lineText.includes(entry.pattern)
    ) {
      matchedAllowKeys.add(allowKey(entry));
      return true;
    }
  }
  return false;
}

const allFiles = walkTsFiles(SRC_DIR);
const violations = [];
const ruleStats = {
  C1: 0,
  C2: 0,
  C3: 0,
  C4: 0,
  C5: 0,
  C6: 0,
  C7: 0,
  C8: 0,
};

function recordViolation(rule, file, line, detail) {
  ruleStats[rule] = (ruleStats[rule] ?? 0) + 1;
  violations.push({ rule, file, line, detail });
}

/* ========================================================================== */
/* C1 / C2 / C3 / C5 / C6：逐行静态扫描                                         */
/* ========================================================================== */

const C1_PATTERNS = [
  /\bSRE\s+Copilot\b/g,
  /\bAI\s+Copilot\b/g,
  /智能副驾/g,
  /\bEdge\s+Log\s+Auditor\b/g,
];

const C2_PATTERNS = [
  { re: /\bCgroup\b/g, label: '禁止大写 Cgroup，请统一写为 cgroup' },
  { re: /\b(?:APIServer|API-Server|API-SERVER|ApiServer)\b/g, label: '禁止 API Server 异形拼写，请写 API Server' },
  { re: /(?<![a-zA-Z0-9_/-])apiserver(?![a-zA-Z0-9_-])/g, label: '禁止非日志上下文裸写 apiserver，请写 API Server' },
  { re: /\breq\/s\b/gi, label: '禁止使用 req/s，请统一写 QPS' },
  { re: /脑裂/g, label: '禁用黑话「脑裂」，请写「网络分区」或「双主冲突」' },
  { re: /控制面(?!平)/g, label: '禁止简写「控制面」，请统一写「控制平面」' },
  { re: /(?<![A-Za-z0-9_.'"/])POD(?![A-Za-z0-9_.'"/=])/g, label: '禁止全大写 POD，请写 Pod' },
];

const C3_PATTERNS = [
  /\bSTAGE-0[0-9]\b/g,
  /\bMOCK MODE\b/g,
  /\bLIVE CLUSTER\b/g,
  /\bSIMULATED\b/g,
  /\[MCP RECEIPT\]/g,
  /chaos engineering console/gi,
  /sre runbook corpus/gi,
  /hybrid retrieval sandbox/gi,
  /\bretrieval sandbox\b/g,
  /\bcorpus index\b/g,
  /vector \+ bm25/gi,
  /SYS\s*\/\/\s*(?:TELEMETRY|INSPECT)/g,
  />\s*(?:TTFT|TOTAL|TOKENS|COST)\b/g,
  /['"`](?:TTFT|TOTAL|TOKENS|COST)\s/g,
  /\(ESC\)/g,
];

const C5_LINE_PATTERNS = [
  { re: /[\u4e00-\u9fa5][^\n'"`]*\.\.\./g, label: '中文句子末尾禁止使用 ASCII `...`，请改用中文省略号 `…`' },
  { re: /未命中任何 Runbook（查询缺乏区分度）/g, label: '禁止无效空态提示「查询缺乏区分度」，请给出可行动下一步指引' },
  { re: /join\(\s*['"`]\s*->\s*['"`]\s*\)/g, label: '用户可见序列连接符禁止使用 ASCII `->`，请改用 `→`' },
  { re: /[\u4e00-\u9fa5]\s*\((?:Incident Summary|Impact|Timeline|Root Cause Analysis|Knowledge Base References|Remediation Actions|Lessons Learned[^)]*)\)/g, label: '中文章节英文副标请使用全角括号 `（...）`' },
];

const C6_DRIFT_PATTERNS = [
  /OOM\s*风暴/g,
  /OOM\s*雪崩/g,
  /Pod\s*OOM\s*集群性爆发/g,
  /CPU\s*尖峰/g,
];

for (const absPath of allFiles) {
  const relPath = relative(ROOT, absPath).replaceAll('\\', '/');
  const raw = readFileSync(absPath, 'utf8');
  const stripped = stripCommentsPreserveLines(raw);
  const lines = stripped.split('\n');

  /* 术语表自身用于登记 forbiddenVariants / rationale，不作违禁词误报 */
  const isGlossaryDef = relPath === 'src/constants/copy/glossary.ts';
  /* ragEvalSet 中测试拼写容错用例、sreRagEngine tags 数组属于检索匹配词条 */
  lines.forEach((lineText, idx) => {
    const lineNum = idx + 1;
    const trimmed = lineText.trim();
    if (trimmed === '' || trimmed.startsWith('import ') || trimmed.startsWith('export type ')) {
      return;
    }

    if (!isGlossaryDef) {
      for (const re of C1_PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(lineText);
        if (m !== null && !isAllowlisted(relPath, lineNum, 'C1', lineText)) {
          recordViolation('C1', relPath, lineNum, `发现未收敛 AI 称谓 "${m[0]}"`);
        }
      }

      /* TypeScript 接口/类型声明行中的属性名（如 type NodeSummary）不计 C2 prose，但保留字符串字面量 */
      for (const rule of C2_PATTERNS) {
        rule.re.lastIndex = 0;
        const m = rule.re.exec(lineText);
        if (m === null) continue;
        if (rule.re.source.includes('apiserver') && /^\s*tags\s*:/.test(lineText)) continue;
        if (!isAllowlisted(relPath, lineNum, 'C2', lineText)) {
          recordViolation('C2', relPath, lineNum, `${rule.label}（命中 "${m[0]}"）`);
        }
      }

      for (const re of C3_PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(lineText);
        if (m !== null && !isAllowlisted(relPath, lineNum, 'C3', lineText)) {
          recordViolation('C3', relPath, lineNum, `发现未汉化界面字符 "${m[0]}"`);
        }
      }

      for (const rule of C5_LINE_PATTERNS) {
        rule.re.lastIndex = 0;
        const m = rule.re.exec(lineText);
        if (m !== null && !isAllowlisted(relPath, lineNum, 'C5', lineText)) {
          recordViolation('C5', relPath, lineNum, `${rule.label}`);
        }
      }

      for (const re of C6_DRIFT_PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(lineText);
        if (m !== null && !isAllowlisted(relPath, lineNum, 'C6', lineText)) {
          recordViolation('C6', relPath, lineNum, `发现混沌场景异形名称 "${m[0]}"，请引用 CHAOS_SCENARIO_LABELS`);
        }
      }
    }
  });
}

/* ========================================================================== */
/* C4：复盘报告字符串段静态检查（禁止泄漏内部类型名与变量路径）                   */
/* ========================================================================== */

const C4_LEAK_RE =
  /\b(?:ClusterContext|clusterContext|RootCauseAlertProps|ActionConfirmProps|PodMetricsCardProps|CopilotMessage|reasoningSteps|synthesized=true|failed=true|faultyPods|ragReferences|onActionExecuted|renderPodMetrics|renderRootCauseAnalysis|reportRootCause|impactScope|selectedPodSnapshot|healedPodIds|drain_node|localStorage)\b/;

for (const targetRel of ['src/utils/postMortemReport.ts', 'src/constants/copy/report.ts']) {
  const absPath = join(ROOT, targetRel);
  if (!existsSync(absPath)) {
    recordViolation('C4', targetRel, 1, '缺少复盘报告模块');
    continue;
  }
  const stripped = stripCommentsPreserveLines(readFileSync(absPath, 'utf8'));
  const rawLines = stripped.split('\n');
  const segments = extractStringSegments(stripped);
  for (const seg of segments) {
    const lineContent = rawLines[seg.line - 1] ?? '';
    /* 跳过 switch case / === / !== 中的内部枚举比较分支（非输出文案） */
    if (/^\s*case\s+['"`]|(?:===|!==)\s*['"`]drain_node['"`]/.test(lineContent)) {
      continue;
    }
    const m = C4_LEAK_RE.exec(seg.text);
    if (m !== null && !isAllowlisted(targetRel, seg.line, 'C4', seg.text)) {
      recordViolation('C4', targetRel, seg.line, `复盘输出文本不得泄漏内部标识 "${m[0]}"`);
    }
  }
}

/* ========================================================================== */
/* C6：验证 6 处混沌场景消费者已统一接线到 @/constants/copy                      */
/* ========================================================================== */

const CHAOS_CONSUMERS = [
  'src/components/layout/TopBar.tsx',
  'src/components/hud/ChaosControlModal.tsx',
  'src/components/hud/CommandPalette.tsx',
  'src/components/hud/DemoReplayTimeline.tsx',
  'src/utils/postMortemReport.ts',
  'src/app/api/chat/route.ts',
];

for (const consumerRel of CHAOS_CONSUMERS) {
  const absPath = join(ROOT, consumerRel);
  const src = readFileSync(absPath, 'utf8');
  if (!src.includes('@/constants/copy') || (!src.includes('CHAOS_SCENARIO_LABELS') && !src.includes('CHAOS_INJECT_LABELS') && !src.includes('getChaosReportLabel'))) {
    recordViolation('C6', consumerRel, 1, '未从 @/constants/copy 引入混沌场景规范名');
  }
}

/* ========================================================================== */
/* C7：错因三要素完备性与术语表结构契约核验                                     */
/* ========================================================================== */

{
  const agentPath = 'src/constants/copy/agent.ts';
  const agentSrc = readFileSync(join(ROOT, agentPath), 'utf8');
  for (const key of ['network', 'model', 'tool_args', 'server', 'abort']) {
    const hintMatch = new RegExp(`${key}:\\s*\\{[\\s\\S]*?hint:\\s*'([^']+)'`, 'm').exec(agentSrc);
    if (hintMatch === null) {
      recordViolation('C7', agentPath, 1, `CHAT_ERROR_COPY 缺少分类 ${key} 的 hint`);
    } else if (hintMatch[1].length < 12 || !hintMatch[1].includes('重试')) {
      recordViolation('C7', agentPath, 1, `CHAT_ERROR_COPY.${key}.hint 未满足三要素与长度 ≥ 12 字要求`);
    }
  }

  const glossaryPath = 'src/constants/copy/glossary.ts';
  const glossarySrc = readFileSync(join(ROOT, glossaryPath), 'utf8');
  const termKeys = [...glossarySrc.matchAll(/^\s*key:\s*'([^']+)'/gm)].map((m) => m[1]);
  if (termKeys.length < 30) {
    recordViolation('C7', glossaryPath, 1, `TERMS 数量仅 ${termKeys.length}，要求至少 30 条`);
  }
  for (const cat of ['A', 'B', 'C', 'D', 'E']) {
    if (!new RegExp(`category:\\s*'${cat}'`).test(glossarySrc)) {
      recordViolation('C7', glossaryPath, 1, `TERMS 缺少五分法类别 ${cat}`);
    }
  }
  for (const jid of ['J1', 'J2', 'J3']) {
    if (!new RegExp(`id:\\s*'${jid}'`).test(glossarySrc)) {
      recordViolation('C7', glossaryPath, 1, `PRODUCT_DECISIONS 缺少裁决 ${jid}`);
    }
  }

  const ragModalPath = 'src/components/ai/RagKnowledgeModal.tsx';
  const ragModalSrc = readFileSync(join(ROOT, ragModalPath), 'utf8');
  if (!ragModalSrc.includes('TERMS') || !ragModalSrc.includes('PRODUCT_DECISIONS') || !ragModalSrc.includes('术语表')) {
    recordViolation('C7', ragModalPath, 1, 'RagKnowledgeModal 尚未接入只读「术语表」视图');
  }
}

/* ========================================================================== */
/* C8：Allowlist 双向一致性检查                                                */
/* ========================================================================== */

for (const entry of allowEntries) {
  if (!entry.file || !entry.line || !entry.pattern || !entry.rule || !entry.reason || entry.reason.length < 6) {
    recordViolation('C8', 'scripts/copy-allowlist.json', 1, `白名单条目字段不完整: ${JSON.stringify(entry)}`);
    continue;
  }
  const absTarget = join(ROOT, entry.file);
  if (!existsSync(absTarget)) {
    recordViolation('C8', 'scripts/copy-allowlist.json', 1, `白名单指向不存在的文件: ${entry.file}`);
    continue;
  }
  if (!matchedAllowKeys.has(allowKey(entry))) {
    recordViolation(
      'C8',
      'scripts/copy-allowlist.json',
      entry.line,
      `僵尸/过时白名单条目未在实际扫描中命中 (${entry.file}:${entry.line} [${entry.rule}] "${entry.pattern}")`,
    );
  }
}

/* ========================================================================== */
/* 汇总输出                                                                    */
/* ========================================================================== */

const passed = violations.length === 0;

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        passed,
        scannedFiles: allFiles.length,
        allowlistCount: allowEntries.length,
        matchedAllowlistCount: matchedAllowKeys.size,
        ruleStats,
        violationCount: violations.length,
        violations,
      },
      null,
      2,
    ),
  );
} else {
  console.log('KubeVision AI — 文案、术语表与本地化门禁（C1–C8）');
  console.log(
    `  扫描文件: ${allFiles.length} 个 · 白名单命中: ${matchedAllowKeys.size}/${allowEntries.length} · 违规总数: ${violations.length}`,
  );
  console.log(
    `  分项计数: C1=${ruleStats.C1} C2=${ruleStats.C2} C3=${ruleStats.C3} C4=${ruleStats.C4} C5=${ruleStats.C5} C6=${ruleStats.C6} C7=${ruleStats.C7} C8=${ruleStats.C8}`,
  );
  for (const v of violations.slice(0, 50)) {
    console.log(`    [${v.rule}] ${v.file}:L${v.line}  ${v.detail}`);
  }
}

process.exit(passed ? 0 : 1);
