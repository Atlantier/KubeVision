'use client';

/**
 * KubeVision AI — 轻量级安全 Markdown 渲染器（MarkdownLite）
 *
 * 【为什么需要它】后端（真实大模型与仿真器都会）输出结构化 Markdown：
 * `## 诊断结论`、`**重点**`、`` `kubectl 命令` ``、`> 告警摘要`、有序列表、链接与 GFM 表格。
 * 本组件将文本解析为结构化 AST 后通过 React 元素安全渲染，**绝不使用 dangerouslySetInnerHTML**。
 *
 * 【为什么不引入 react-markdown / marked】
 * AGENTS.md 第 9 条锁定了依赖世代矩阵。自研状态机实现**零新增依赖、零 SSR 风险、完全可控**。
 *
 * 【安全契约：绝不使用 dangerouslySetInnerHTML + 链接协议白名单】
 * LLM 输出属于**不可信外部输入**。文本节点由 React 自动转义；`[text](url)` 链接必须经
 * `sanitizeLinkUrl` 校验（严格白名单 `http:` / `https:` / `mailto:`，拦截控制字符与
 * `javascript:` / `data:` / `vbscript:` / 相对路径），未通过校验的链接一律降级为纯文本。
 *
 * 【流式增量缓存架构】
 * 流式输出时每次文本追加若从头重解析全部块并对全部历史块做 `parseInline` + DOM 比对，
 * 会形成 O(n²) 开销与主线程长任务。本实现维护 `IncrementalBlockCache`：
 * 1. 仅在围栏闭合、空行、完整单行块（标题/分隔线）或完整表格结束等安全行尾边界推进 `closedLength`；
 * 2. 后续追加命中 `closedPrefix` 时仅解析 `markdown.slice(closedLength)` 尾部未闭合片段；
 * 3. 已闭合块保留原始 `Block` 对象引用，并由 `MemoMarkdownBlock`（`React.memo`）跳过重渲染；
 * 4. 未闭合代码围栏与未闭合行内标记仍即时输出为尾部可见内容，保证流式首字与尾部文字不丢失。
 */

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Check, Copy } from 'lucide-react';

import { cn } from '@/utils/cn';

/* ========================================================================== */
/* 类型契约                                                                    */
/* ========================================================================== */

/** MarkdownLite 的 Props */
export interface MarkdownLiteProps {
  /** 原始 Markdown 文本（可含流式未闭合标记） */
  readonly markdown: string;
  /** 是否处于流式输出中（true 时在末尾渲染呼吸光标） */
  readonly isStreaming?: boolean;
  /** 附加容器类名 */
  readonly className?: string;
}

/** InlineMarkdown 的 Props */
export interface InlineMarkdownProps {
  /** 单段文本（仅做行内解析，不产生块级元素） */
  readonly text: string;
  /** 附加类名（字号/颜色由调用方按上下文决定） */
  readonly className?: string;
  /**
   * 是否把**裸 Runbook 编号**（如 `RUNBOOK-K8S-042`）自动提升为行内代码胶囊。
   *
   * 【为何做成开关而非默认】在正文/卡片里，Runbook 编号本来就该由模型用
   * 反引号包裹；但推理链、系统回执这类**由我方模板拼装**的文本不会带反引号，
   * 编号混在中文句子里会显得平淡。该开关只在这些场景启用，
   * 避免改变通用 Markdown 语义（普通文本里出现该字样不应被强制改样式）。
   */
  readonly highlightRunbookIds?: boolean;
}

/* ========================================================================== */
/* 行内解析与链接白名单                                                         */
/* ========================================================================== */

/** 行内片段类型 */
type InlineKind = 'text' | 'bold' | 'italic' | 'code' | 'link';

/** 行内片段 */
interface InlineSegment {
  readonly kind: InlineKind;
  readonly text: string;
  /** 经协议白名单校验的安全链接地址（仅 `kind === 'link'` 时存在） */
  readonly href?: string;
  /**
   * 加粗或链接内部的子片段。
   *
   * 【为何需要】模型会输出「**当前（`kubectl cordon` 建议暂缓）**」或
   * 「[`kubectl`](https://kubernetes.io)」，递归解析子片段可同时保留内嵌代码/斜体/加粗，
   * 并通过 `allowBold` / `allowLink` 开关保证不会出现无限递归或嵌套 `<a>`。
   */
  readonly children?: readonly InlineSegment[];
}

/** 链接解析命中结果 */
interface MatchedLink {
  /** 链接显示文案 */
  readonly label: string;
  /** 通过安全白名单校验后的目标地址；不安全或非法时为 null */
  readonly safeHref: string | null;
  /** 整个 `[label](url)` 结束后的下一字符下标 */
  readonly nextIndex: number;
}

/**
 * sanitizeLinkUrl —— 严格校验 Markdown 链接协议白名单（仅允许 http / https / mailto）。
 *
 * 【设计意图】防御提示注入构造 `javascript:`、`data:`、`vbscript:`、`file:`、
 * 控制字符混淆（如 `java\tscript:`）及协议相对跳转（`//evil.com`）。
 * 【输入输出】输入原始 URL 字符串；仅当通过控制字符过滤、显式协议前缀与 `URL` 构造器校验时
 * 返回规范化 `href`，否则返回 `null` 由调用方降级为纯文本。
 *
 * @param rawUrl 链接括号内的原始地址字符串
 * @returns 安全的规范化 URL；未通过白名单则返回 null
 */
function sanitizeLinkUrl(rawUrl: string): string | null {
  let candidate = rawUrl.trim();
  if (candidate.startsWith('<') && candidate.endsWith('>') && candidate.length >= 2) {
    candidate = candidate.slice(1, -1).trim();
  }
  if (candidate.length === 0) return null;
  // 拦截任何 ASCII 控制字符（如 \t / \n / \r / \0），防止浏览器 URL 归一化绕过协议检查
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(candidate)) return null;
  if (!/^(https?:\/\/|mailto:)/i.test(candidate)) return null;

  try {
    const parsed = new URL(candidate);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:') {
      if (parsed.hostname.length === 0) return null;
      return parsed.href;
    }
    if (protocol === 'mailto:') {
      const recipient = candidate.slice('mailto:'.length).split('?')[0].trim();
      if (recipient.length === 0 || !recipient.includes('@')) return null;
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * matchLinkAt —— 从 `text[startIndex] === '['` 起匹配单行 `[label](url)`。
 *
 * 【核心逻辑】
 * 1. 扫描 `[...]` 时感知行内反引号与成对中括号，避免 `[`...`]` 内出现 `]` 时提前截断；
 * 2. 紧接 `(` 后按括号嵌套深度匹配 `)`，支持带括号的合法 URL（如维基百科词条）；
 * 3. 剥离可选标题 `"title"` 后交由 `sanitizeLinkUrl` 校验；流式未闭合时返回 null。
 *
 * @param text 行内文本
 * @param startIndex `[` 所在下标
 * @returns 匹配结果；未闭合或不符合链接语法时返回 null
 */
function matchLinkAt(text: string, startIndex: number): MatchedLink | null {
  if (text[startIndex] !== '[') return null;

  let pos = startIndex + 1;
  let bracketDepth = 1;
  let inCode = false;
  let closeBracket = -1;

  while (pos < text.length) {
    const ch = text[pos];
    if (ch === '\n') return null;
    if (ch === '`') {
      inCode = !inCode;
    } else if (!inCode) {
      if (ch === '\\' && pos + 1 < text.length) {
        pos += 2;
        continue;
      }
      if (ch === '[') {
        bracketDepth += 1;
      } else if (ch === ']') {
        bracketDepth -= 1;
        if (bracketDepth === 0) {
          closeBracket = pos;
          break;
        }
      }
    }
    pos += 1;
  }

  if (closeBracket <= startIndex + 1) return null;
  if (text[closeBracket + 1] !== '(') return null;

  let urlCursor = closeBracket + 2;
  let parenDepth = 1;
  let closeParen = -1;

  while (urlCursor < text.length) {
    const ch = text[urlCursor];
    if (ch === '\n') return null;
    if (ch === '\\' && urlCursor + 1 < text.length) {
      urlCursor += 2;
      continue;
    }
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        closeParen = urlCursor;
        break;
      }
    }
    urlCursor += 1;
  }

  if (closeParen === -1) return null;

  const label = text.slice(startIndex + 1, closeBracket);
  const rawInner = text.slice(closeBracket + 2, closeParen).trim();
  const titleMatch = /^(\S+)\s+(?:"[^"]*"|'[^']*')$/.exec(rawInner);
  const rawUrl = titleMatch !== null ? titleMatch[1] : rawInner;

  return {
    label,
    safeHref: sanitizeLinkUrl(rawUrl),
    nextIndex: closeParen + 1,
  };
}

/**
 * findClosingBold —— 从 `startIndex` 起查找闭合的 `**`，跳过成对行内反引号。
 *
 * @param text 待扫描文本
 * @param startIndex 开标签 `**` 之后的起始下标
 * @returns 闭合 `**` 的起始下标；未找到返回 -1
 */
function findClosingBold(text: string, startIndex: number): number {
  let pos = startIndex;
  while (pos < text.length - 1) {
    if (text[pos] === '`') {
      const codeEnd = text.indexOf('`', pos + 1);
      if (codeEnd !== -1) {
        pos = codeEnd + 1;
        continue;
      }
    }
    if (text[pos] === '*' && text[pos + 1] === '*' && pos > startIndex) {
      return pos;
    }
    pos += 1;
  }
  return -1;
}

/**
 * matchItalicAt —— 从 `text[startIndex] === '*'` 起匹配单行 `*italic*`。
 *
 * 要求内容首尾均非空白且不含嵌套 `*`（与原正则行为一致，避开 `2 * 3 * 4` 误判）。
 *
 * @param text 行内文本
 * @param startIndex `*` 所在下标
 * @returns 闭合 `*` 的下标；未匹配返回 -1
 */
function matchItalicAt(text: string, startIndex: number): number {
  if (startIndex + 2 >= text.length) return -1;
  const firstInner = text[startIndex + 1];
  if (firstInner === '*' || /\s/.test(firstInner)) return -1;

  for (let pos = startIndex + 2; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (ch === '\n') return -1;
    if (ch === '*') {
      if (/\s/.test(text[pos - 1])) return -1;
      return pos;
    }
  }
  return -1;
}

/**
 * parseInlineSegments —— 单遍状态机扫描行内标记（代码 / 加粗 / 链接 / 斜体）。
 *
 * 【优先级顺序】行内代码 `` `…` `` > 加粗 `**…**` > 链接 `[text](url)` > 斜体 `*…*`。
 * 反引号内一切符号均视为字面量；未闭合的标记直接按纯文本输出，保证流式阅读不阻塞。
 *
 * @param text 待解析文本
 * @param allowBold 是否允许解析 `**加粗**`
 * @param allowLink 是否允许解析 `[text](url)`
 * @returns 行内片段数组
 */
function parseInlineSegments(
  text: string,
  allowBold: boolean,
  allowLink: boolean,
): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let plainStart = 0;
  let i = 0;

  const flushPlain = (endIndex: number): void => {
    if (endIndex > plainStart) {
      segments.push({ kind: 'text', text: text.slice(plainStart, endIndex) });
    }
  };

  while (i < text.length) {
    const ch = text[i];

    /* 1. 行内代码：优先级最高，反引号内保留字面量 */
    if (ch === '`') {
      const codeEnd = text.indexOf('`', i + 1);
      if (codeEnd > i + 1) {
        flushPlain(i);
        segments.push({ kind: 'code', text: text.slice(i + 1, codeEnd) });
        i = codeEnd + 1;
        plainStart = i;
        continue;
      }
    }

    /* 2. 加粗：允许内部嵌套行内代码、链接与斜体，禁止嵌套加粗 */
    if (allowBold && ch === '*' && text[i + 1] === '*') {
      const boldEnd = findClosingBold(text, i + 2);
      if (boldEnd > i + 2) {
        const inner = text.slice(i + 2, boldEnd);
        flushPlain(i);
        segments.push({
          kind: 'bold',
          text: inner,
          children: parseInlineSegments(inner, false, allowLink),
        });
        i = boldEnd + 2;
        plainStart = i;
        continue;
      }
    }

    /* 3. 链接：严格白名单校验，未通过则降级为纯文本（不渲染 <a>） */
    if (allowLink && ch === '[') {
      const link = matchLinkAt(text, i);
      if (link !== null) {
        flushPlain(i);
        const labelChildren = parseInlineSegments(link.label, allowBold, false);
        if (link.safeHref !== null) {
          segments.push({
            kind: 'link',
            text: link.label,
            href: link.safeHref,
            children: labelChildren,
          });
        } else {
          /* 非白名单协议（如 javascript: / data:）降级为纯文本标签，剥离危险 URI */
          for (const child of labelChildren) {
            segments.push(child);
          }
        }
        i = link.nextIndex;
        plainStart = i;
        continue;
      }
    }

    /* 4. 斜体（单星号，跳过双星号起点） */
    if (ch === '*' && text[i + 1] !== '*') {
      const italicEnd = matchItalicAt(text, i);
      if (italicEnd !== -1) {
        flushPlain(i);
        segments.push({ kind: 'italic', text: text.slice(i + 1, italicEnd) });
        i = italicEnd + 1;
        plainStart = i;
        continue;
      }
    }

    i += 1;
  }

  flushPlain(text.length);
  return segments.length > 0 ? segments : [{ kind: 'text', text }];
}

/**
 * parseInline —— 把单行文本解析为行内片段（支持代码/加粗/链接/斜体）。
 *
 * @param line 单行文本
 * @returns 片段数组
 */
function parseInline(line: string): InlineSegment[] {
  return parseInlineSegments(line, true, true);
}

/**
 * renderInline —— 把行内片段渲染为 React 节点。
 *
 * 【样式契约】
 * - bold   → `text-slate-50 font-semibold`，递归渲染内部子片段；
 * - italic → 轻微倾斜 + `text-slate-200/90`；
 * - code   → 深色等宽胶囊 + 青色字，配 `break-all` 防止长路径撑破气泡；
 * - link   → `<a target="_blank" rel="noopener noreferrer">`，青色下划线 + 焦点环。
 *
 * @param segments 片段数组
 * @param keyPrefix 用于生成稳定 key 的前缀
 */
function renderInline(segments: readonly InlineSegment[], keyPrefix: string): ReactNode[] {
  return segments.map((seg, i): ReactNode => {
    const key = `${keyPrefix}-${i}`;
    if (seg.kind === 'bold') {
      return (
        <strong key={key} className="font-semibold text-slate-50">
          {seg.children !== undefined ? renderInline(seg.children, `${key}-b`) : seg.text}
        </strong>
      );
    }
    if (seg.kind === 'italic') {
      return (
        <em key={key} className="italic text-slate-200/90">
          {seg.text}
        </em>
      );
    }
    if (seg.kind === 'code') {
      return (
        <code
          key={key}
          className="max-w-full break-all [overflow-wrap:anywhere] rounded border border-white/[0.04] bg-slate-800/90 px-1 py-0.5 font-mono text-[0.92em] text-cyan-300"
        >
          {seg.text}
        </code>
      );
    }
    if (seg.kind === 'link' && seg.href !== undefined) {
      return (
        <a
          key={key}
          href={seg.href}
          target="_blank"
          rel="noopener noreferrer"
          className="max-w-full [overflow-wrap:anywhere] rounded-sm text-cyan-300 underline decoration-cyan-400/50 underline-offset-2 transition-colors hover:text-cyan-200 hover:decoration-cyan-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
        >
          {seg.children !== undefined ? renderInline(seg.children, `${key}-a`) : seg.text}
        </a>
      );
    }
    return <Fragment key={key}>{seg.text}</Fragment>;
  });
}

/* ========================================================================== */
/* 块级解析与流式增量缓存                                                      */
/* ========================================================================== */

/** 块类型 */
type BlockKind =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'quote'
  | 'ul'
  | 'ol'
  | 'hr'
  | 'codeblock'
  | 'table'
  | 'p';

/** 表格列对齐方式 */
type TableAlignment = 'left' | 'center' | 'right';

/** 块结构 */
interface Block {
  readonly kind: BlockKind;
  /** 标题/引用/段落的文本；列表项为各条内容；代码块为各行原文 */
  readonly lines: readonly string[];
  /** 代码块的语言标识（如 bash / yaml），无则为空串 */
  readonly lang?: string;
  /** 列表项缩进层级（0 为顶层，1 为一级子项），与 lines 一一对应 */
  readonly depths?: readonly number[];
  /** 引用块内部递归解析出的子块（支持嵌套引用、列表与多段） */
  readonly children?: readonly Block[];
  /** 表格表头 */
  readonly headers?: readonly string[];
  /** 表格列对齐 */
  readonly alignments?: readonly TableAlignment[];
  /** 表格数据行 */
  readonly rows?: readonly (readonly string[])[];
}

/** 增量块解析缓存结构 */
interface IncrementalBlockCache {
  /** 上次解析的完整源文本 */
  readonly source: string;
  /** 已永久闭合块的源文本前缀（始终落在完整 `\n` 边界且无未闭合围栏） */
  readonly closedPrefix: string;
  /** closedPrefix 字符长度 */
  readonly closedLength: number;
  /** 已闭合块列表（后续流式追加时保持对象引用不变） */
  readonly closedBlocks: readonly Block[];
  /** 本次完整块列表（closedBlocks + 尾部活跃块） */
  readonly allBlocks: readonly Block[];
}

/** 单次块解析输出（含可安全闭合偏移） */
interface ParseBlocksOutcome {
  readonly blocks: Block[];
  readonly closedCharOffset: number;
  readonly closedBlockCount: number;
}

/** 引用递归最大嵌套深度（防止极端恶意连续 `>>>>...` 导致栈溢出） */
const MAX_QUOTE_DEPTH = 4;

/**
 * splitTableRow —— 拆表格行并支持转义竖线 `\|` 还原。
 *
 * 与 `src/utils/postMortemReport.ts` 的 `escapeTableCell` 对齐：遇到 `\|` 时
 * 视作单元格字面量 `|` 而非列分隔符，其余未转义 `|` 切分后逐格 trim。
 *
 * @param line 形如 `| 节点 | CPU |` 或 `节点 | CPU` 的行
 * @returns 单元格数组
 */
function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) {
    trimmed = trimmed.slice(0, -1);
  }

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '\\' && i + 1 < trimmed.length && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (trimmed[i] === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += trimmed[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * parseTableSeparator —— 校验 GFM 表格分隔行并提取列对齐方式。
 *
 * 【修复缺陷】旧正则 `^\|?[\s:|-]+\|[\s:|-]+\|?$` 会误放行无连字符的 `|   |   |`，
 * 同时拒绝单列表格 `| --- |` 与省略外侧竖线的 `--- | ---`。本函数逐列校验
 * `/^:?-+:?$/`，同时支持单列/多列、有无外侧竖线及 `:---` / `:---:` / `---:` 对齐。
 *
 * @param line 候选分隔行文本
 * @returns 对齐数组；不符合分隔行格式则返回 null
 */
function parseTableSeparator(line: string): TableAlignment[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;

  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return null;

  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':')) {
      alignments.push('center');
    } else if (cell.endsWith(':')) {
      alignments.push('right');
    } else {
      alignments.push('left');
    }
  }
  return alignments;
}

/**
 * normalizeTableRow —— 把数据行列数对齐到表头列数，缺列补空串。
 *
 * @param cells 原始单元格
 * @param columnCount 表头列数
 * @returns 归一化后的行数据
 */
function normalizeTableRow(cells: readonly string[], columnCount: number): string[] {
  if (cells.length === columnCount) return [...cells];
  if (cells.length > columnCount) return cells.slice(0, columnCount);
  const padded = [...cells];
  while (padded.length < columnCount) {
    padded.push('');
  }
  return padded;
}

/**
 * parseBlocksCore —— 把 Markdown 源文本解析为块级结构，并计算安全闭合边界。
 *
 * 【状态机与闭合边界设计】
 * 1. 逐行扫描并记录每行起止字符偏移（仅含完整 `\n` 的行允许作为闭合边界）；
 * 2. 仅当 `quoteDepth === 0` 且 `fence === null && current === null`（例如空行、
 *    已闭合围栏、已换行完结的标题/分隔线，或后继完整非表格行终结的表格）时推进
 *    `closedCharOffset` 与 `closedBlockCount`；
 * 3. 引用块把每行剥离首层 `>` 后递归交由 `parseBlocksCore(..., quoteDepth + 1)`
 *    处理，原生支持 `> >` / `>>` 嵌套引用与引用内列表/多段；
 * 4. 若到达末尾时围栏代码块仍未闭合且已有正文行，仍输出为 `codeblock` 块，
 *    确保流式未闭合代码块及其后续文本即时可见。
 *
 * @param source 待解析 Markdown 文本
 * @param quoteDepth 当前引用递归深度（顶层为 0）
 * @returns 块数组及顶层安全闭合偏移
 */
function parseBlocksCore(source: string, quoteDepth = 0): ParseBlocksOutcome {
  const blocks: Block[] = [];
  const rawLines = source.split('\n');

  /* 计算每行的字符起始偏移，用于精确定位顶层可缓存闭合边界 */
  const lineStarts: number[] = new Array<number>(rawLines.length);
  let runningOffset = 0;
  for (let i = 0; i < rawLines.length; i += 1) {
    lineStarts[i] = runningOffset;
    runningOffset += rawLines[i].length + 1;
  }

  let closedCharOffset = 0;
  let closedBlockCount = 0;

  let current: { kind: BlockKind; lines: string[]; depths: number[] } | null = null;
  let fence: { lang: string; lines: string[] } | null = null;

  const commitClosed = (blockCount: number, charOffset: number): void => {
    if (quoteDepth !== 0) return;
    if (charOffset > closedCharOffset) {
      closedCharOffset = charOffset;
      closedBlockCount = blockCount;
    }
  };

  /** 收尾当前累积块并入列；若为引用块则递归解析嵌套子块 */
  const flush = (): void => {
    if (current !== null && current.lines.length > 0) {
      if (current.kind === 'quote') {
        const innerSource = current.lines.join('\n');
        const innerOutcome = parseBlocksCore(innerSource, quoteDepth + 1);
        blocks.push({
          kind: 'quote',
          lines: current.lines,
          children: innerOutcome.blocks,
        });
      } else {
        blocks.push({
          kind: current.kind,
          lines: current.lines,
          ...(current.kind === 'ul' || current.kind === 'ol' ? { depths: current.depths } : {}),
        });
      }
    }
    current = null;
  };

  /** 追加一行到指定类型块；类型切换时先收尾上一块 */
  const push = (kind: BlockKind, text: string, depth = 0): void => {
    if (current === null || current.kind !== kind) {
      flush();
      current = { kind, lines: [text], depths: [depth] };
    } else {
      current.lines.push(text);
      current.depths.push(depth);
    }
  };

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index];
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    const hasTrailingNewline = index < rawLines.length - 1;
    const afterLineOffset = lineStarts[index] + rawLine.length + 1;

    /* ---- 围栏代码块：开启 / 关闭 ---- */
    const fenceMatch = /^```(.*)$/.exec(trimmed);
    if (fenceMatch !== null) {
      if (fence === null) {
        flush();
        if (index > 0) {
          commitClosed(blocks.length, lineStarts[index]);
        }
        fence = { lang: fenceMatch[1].trim(), lines: [] };
      } else {
        blocks.push({ kind: 'codeblock', lines: fence.lines, lang: fence.lang });
        fence = null;
        if (hasTrailingNewline) {
          commitClosed(blocks.length, afterLineOffset);
        }
      }
      continue;
    }

    /* ---- 围栏内部：原样收集，跳过行内与块级解析 ---- */
    if (fence !== null) {
      fence.lines.push(rawLine);
      continue;
    }

    /* ---- 空行：结束当前块并推进闭合边界 ---- */
    if (trimmed.length === 0) {
      flush();
      if (hasTrailingNewline) {
        commitClosed(blocks.length, afterLineOffset);
      }
      continue;
    }

    /* ---- 水平分隔线 ---- */
    if (/^---+$/.test(trimmed)) {
      flush();
      blocks.push({ kind: 'hr', lines: [] });
      if (hasTrailingNewline) {
        commitClosed(blocks.length, afterLineOffset);
      }
      continue;
    }

    /* ---- GFM 表格：含 | 且下一行通过分隔行校验且列数一致 ---- */
    if (
      trimmed.includes('|') &&
      !/^(?:#{1,4}\s|>)/.test(trimmed) &&
      index + 1 < rawLines.length
    ) {
      const separatorLine = rawLines[index + 1].trim();
      const alignments = parseTableSeparator(separatorLine);
      if (alignments !== null) {
        const headers = splitTableRow(line);
        if (headers.length === alignments.length) {
          flush();
          const headerHasOuterPipe = trimmed.startsWith('|');
          const rows: string[][] = [];
          let cursor = index + 2;
          while (cursor < rawLines.length) {
            const rowTrimmed = rawLines[cursor].trim();
            if (
              rowTrimmed.length === 0 ||
              rowTrimmed.startsWith('```') ||
              /^#{1,4}\s/.test(rowTrimmed) ||
              /^---+$/.test(rowTrimmed) ||
              rowTrimmed.startsWith('>')
            ) {
              break;
            }
            const isTableRow = headerHasOuterPipe
              ? rowTrimmed.startsWith('|')
              : rowTrimmed.includes('|');
            if (!isTableRow) break;
            rows.push(normalizeTableRow(splitTableRow(rawLines[cursor]), headers.length));
            cursor += 1;
          }
          blocks.push({ kind: 'table', lines: [], headers, alignments, rows });
          if (cursor < rawLines.length - 1) {
            commitClosed(blocks.length, lineStarts[cursor]);
          }
          index = cursor - 1;
          continue;
        }
      }
    }

    /* ---- 标题：从四级到一级匹配 ---- */
    const h4 = /^####\s+(.+)$/.exec(line);
    if (h4 !== null) {
      flush();
      blocks.push({ kind: 'h4', lines: [h4[1]] });
      if (hasTrailingNewline) {
        commitClosed(blocks.length, afterLineOffset);
      }
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3 !== null) {
      flush();
      blocks.push({ kind: 'h3', lines: [h3[1]] });
      if (hasTrailingNewline) {
        commitClosed(blocks.length, afterLineOffset);
      }
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2 !== null) {
      flush();
      blocks.push({ kind: 'h2', lines: [h2[1]] });
      if (hasTrailingNewline) {
        commitClosed(blocks.length, afterLineOffset);
      }
      continue;
    }
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1 !== null) {
      flush();
      blocks.push({ kind: 'h1', lines: [h1[1]] });
      if (hasTrailingNewline) {
        commitClosed(blocks.length, afterLineOffset);
      }
      continue;
    }

    /* ---- 引用（受最大深度保护） ---- */
    if (quoteDepth < MAX_QUOTE_DEPTH) {
      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote !== null) {
        push('quote', quote[1]);
        continue;
      }
    }

    /* ---- 无序列表（允许前导缩进形成子列表） ---- */
    const ul = /^(\s*)[-*•]\s+(.+)$/.exec(line);
    if (ul !== null) {
      push('ul', ul[2], Math.floor(ul[1].length / 2));
      continue;
    }

    /* ---- 有序列表（允许前导缩进；支持 `1.` / `1)` / `1、`） ---- */
    const ol = /^(\s*)\d+[.)、]\s+(.+)$/.exec(line);
    if (ol !== null) {
      push('ol', ol[2], Math.floor(ol[1].length / 2));
      continue;
    }

    /* ---- 普通段落 ---- */
    push('p', trimmed);
  }

  flush();

  /* 流式容错：围栏未闭合时仍把已收集正文输出为代码块，避免后续文字消失 */
  if (fence !== null && fence.lines.length > 0) {
    blocks.push({ kind: 'codeblock', lines: fence.lines, lang: fence.lang });
  }

  return { blocks, closedCharOffset, closedBlockCount };
}

/* ========================================================================== */
/* 领域高亮：裸 Runbook 编号 → 行内代码胶囊                                      */
/* ========================================================================== */

/**
 * Runbook 编号识别正则（支持含数字的段名如 `RUNBOOK-K8S-042`）。
 */
const RUNBOOK_ID_PATTERN = /RUNBOOK-[A-Z0-9]+-\d+/g;

/**
 * promoteRunbookIds —— 把 text 片段中出现的 Runbook 编号切分为 code 片段。
 *
 * 仅对 `text` 节点切分，加粗与链接节点则递归处理其 `children`，
 * 避免与既有的行内 code 胶囊产生嵌套。
 *
 * @param segments 行内片段数组
 * @returns 处理后的片段数组
 */
function promoteRunbookIds(segments: readonly InlineSegment[]): InlineSegment[] {
  const result: InlineSegment[] = [];

  for (const segment of segments) {
    if (segment.kind !== 'text') {
      result.push(
        segment.children !== undefined
          ? { ...segment, children: promoteRunbookIds(segment.children) }
          : segment,
      );
      continue;
    }

    const text = segment.text;
    const matches = [...text.matchAll(RUNBOOK_ID_PATTERN)];
    if (matches.length === 0) {
      result.push(segment);
      continue;
    }

    let cursor = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      if (index > cursor) {
        result.push({ kind: 'text', text: text.slice(cursor, index) });
      }
      result.push({ kind: 'code', text: match[0] });
      cursor = index + match[0].length;
    }
    if (cursor < text.length) {
      result.push({ kind: 'text', text: text.slice(cursor) });
    }
  }

  return result;
}

/* ========================================================================== */
/* 行内渲染组件                                                                */
/* ========================================================================== */

/**
 * InlineMarkdown —— 单段文本的行内 Markdown 渲染（不产生块级元素）。
 *
 * @param props 见 InlineMarkdownProps
 */
function InlineMarkdownComponent({
  text,
  className,
  highlightRunbookIds = false,
}: InlineMarkdownProps): ReactElement {
  const uid = useId();
  const segments = useMemo((): InlineSegment[] => {
    const parsed = parseInline(text);
    return highlightRunbookIds ? promoteRunbookIds(parsed) : parsed;
  }, [text, highlightRunbookIds]);
  return (
    <span className={cn('min-w-0 max-w-full [overflow-wrap:anywhere]', className)}>
      {renderInline(segments, `im-${uid}`)}
    </span>
  );
}

export const InlineMarkdown = memo(InlineMarkdownComponent);

/* ========================================================================== */
/* 代码块（含一键复制）                                                          */
/* ========================================================================== */

/** 复制成功提示的展示时长（毫秒） */
const COPY_FEEDBACK_MS = 1500;

/**
 * CodeBlock —— 围栏代码块渲染（等宽 + 深底 + 右上角一键复制）。
 *
 * 支持 `navigator.clipboard` 安全上下文与 `textarea + execCommand('copy')` 内网 HTTP 降级，
 * 并在组件卸载时清理反馈定时器。
 *
 * @param props code 代码正文；lang 语言标识（可为空）
 */
const CodeBlock = memo(function CodeBlock({
  code,
  lang,
}: {
  readonly code: string;
  readonly lang?: string;
}): ReactElement {
  const [copied, setCopied] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect((): (() => void) => {
    return (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const writeToClipboard = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 继续尝试降级方案 */
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }, []);

  const handleCopy = useCallback((): void => {
    void writeToClipboard(code).then((ok): void => {
      if (!ok) return;
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout((): void => {
        setCopied(false);
        timerRef.current = null;
      }, COPY_FEEDBACK_MS);
    });
  }, [code, writeToClipboard]);

  return (
    <div className="my-1.5 min-w-0 max-w-full overflow-hidden rounded border border-white/[0.05] bg-slate-950/80">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-white/[0.07] bg-slate-900/60 px-2 py-0.5">
        <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-wider text-slate-500">
          {(lang ?? '').length > 0 ? lang : 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="复制代码命令"
          title="复制命令"
          className={cn(
            'flex shrink-0 items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px] transition-colors',
            copied ? 'text-emerald-400' : 'text-slate-500 hover:bg-white/[0.06] hover:text-cyan-300',
          )}
        >
          {copied ? (
            <>
              <Check className="h-2.5 w-2.5" aria-hidden />
              已复制
            </>
          ) : (
            <Copy className="h-2.5 w-2.5" aria-hidden />
          )}
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto p-2 font-mono text-[11px] leading-relaxed text-slate-300">
        <code>{code}</code>
      </pre>
    </div>
  );
});

/* ========================================================================== */
/* 单块记忆化渲染组件                                                            */
/* ========================================================================== */

/** 列对齐方式 → Tailwind 文本对齐类名映射 */
const TABLE_ALIGN_CLASS: Readonly<Record<TableAlignment, string>> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/**
 * MarkdownBlockView —— 单个块级节点的记忆化渲染视图。
 *
 * 【性能意图】配合 `IncrementalBlockCache` 保持已闭合 `Block` 的对象引用不变，
 * 流式输出时只有尾部未闭合块（通常仅 1~2 块）会随新字符重新渲染并运行 `parseInline`，
 * 其余历史已闭合块在 `React.memo` 层直接命中跳过。
 */
const MemoMarkdownBlock = memo(function MarkdownBlockView({
  block,
  keyPrefix,
  quoteDepth = 0,
}: {
  readonly block: Block;
  readonly keyPrefix: string;
  readonly quoteDepth?: number;
}): ReactElement {
  switch (block.kind) {
    case 'h1':
      return (
        <h2 className="mt-3 flex min-w-0 max-w-full items-center gap-1.5 border-l-[3px] border-cyan-400 pl-2 text-sm font-bold text-slate-50 first:mt-0">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {renderInline(parseInline(block.lines[0]), `${keyPrefix}-h`)}
          </span>
        </h2>
      );

    case 'h2':
      return (
        <h3 className="mt-2 flex min-w-0 max-w-full items-center gap-1.5 border-l-2 border-cyan-400/70 pl-2 text-[13px] font-bold text-slate-100 first:mt-0">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {renderInline(parseInline(block.lines[0]), `${keyPrefix}-h`)}
          </span>
        </h3>
      );

    case 'h3':
      return (
        <h4 className="mt-1.5 min-w-0 max-w-full text-xs font-semibold text-slate-200 [overflow-wrap:anywhere] first:mt-0">
          {renderInline(parseInline(block.lines[0]), `${keyPrefix}-h`)}
        </h4>
      );

    case 'h4':
      return (
        <h5 className="mt-1 flex min-w-0 max-w-full items-center gap-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-slate-400 first:mt-0">
          <span className="h-2.5 w-px shrink-0 bg-slate-500" aria-hidden />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {renderInline(parseInline(block.lines[0]), `${keyPrefix}-h`)}
          </span>
        </h5>
      );

    case 'quote': {
      const childBlocks = block.children ?? [];
      return (
        <blockquote
          className={cn(
            'min-w-0 max-w-full rounded-r border-l-2 leading-relaxed [overflow-wrap:anywhere]',
            quoteDepth === 0
              ? 'border-amber-500/70 bg-amber-500/[0.07] px-2 py-1 text-body text-amber-200/90'
              : 'my-1 border-amber-400/50 bg-amber-500/10 py-0.5 pl-2 pr-1.5 text-amber-100/90',
          )}
        >
          {childBlocks.length > 0 ? (
            <div className="min-w-0 max-w-full space-y-1">
              {childBlocks.map((child, i): ReactElement => (
                <MemoMarkdownBlock
                  key={`${keyPrefix}-qc-${i}`}
                  block={child}
                  keyPrefix={`${keyPrefix}-qc-${i}`}
                  quoteDepth={quoteDepth + 1}
                />
              ))}
            </div>
          ) : (
            block.lines.map((line, i): ReactNode => (
              <p key={`${keyPrefix}-q-${i}`} className="min-w-0 max-w-full [overflow-wrap:anywhere]">
                {renderInline(parseInline(line), `${keyPrefix}-q-${i}`)}
              </p>
            ))
          )}
        </blockquote>
      );
    }

    case 'ul':
      return (
        <ul className="min-w-0 max-w-full space-y-0.5">
          {block.lines.map((line, i): ReactNode => {
            const depth = block.depths?.[i] ?? 0;
            return (
              <li
                key={`${keyPrefix}-li-${i}`}
                className="relative min-w-0 max-w-full leading-relaxed [overflow-wrap:anywhere]"
                style={{ paddingLeft: `${14 + depth * 12}px` }}
              >
                <span
                  className={cn(
                    'absolute top-[0.55em] h-1 w-1 rounded-full',
                    depth > 0 ? 'bg-slate-500' : 'bg-cyan-400/70',
                  )}
                  style={{ left: `${4.5 + depth * 12}px` }}
                  aria-hidden
                />
                {renderInline(parseInline(line), `${keyPrefix}-li-${i}`)}
              </li>
            );
          })}
        </ul>
      );

    case 'ol':
      return (
        <ol className="min-w-0 max-w-full space-y-0.5">
          {block.lines.map((line, i): ReactNode => {
            const depth = block.depths?.[i] ?? 0;
            return (
              <li
                key={`${keyPrefix}-li-${i}`}
                className="flex min-w-0 max-w-full gap-1.5 leading-relaxed"
                style={{ paddingLeft: `${depth * 12}px` }}
              >
                <span className="shrink-0 font-mono text-[11px] font-bold tabular-nums text-cyan-400/80">
                  {i + 1}.
                </span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {renderInline(parseInline(line), `${keyPrefix}-li-${i}`)}
                </span>
              </li>
            );
          })}
        </ol>
      );

    case 'table':
      return (
        <div className="my-1.5 min-w-0 max-w-full overflow-x-auto rounded border border-white/[0.07] bg-slate-950/60">
          <table className="min-w-full border-collapse text-left">
            <thead>
              <tr className="bg-slate-900/90">
                {(block.headers ?? []).map((header, i): ReactNode => {
                  const align = block.alignments?.[i] ?? 'left';
                  return (
                    <th
                      key={`${keyPrefix}-th-${i}`}
                      className={cn(
                        'whitespace-nowrap border-b border-white/[0.07] px-2 py-1 font-mono text-[11px] font-bold text-slate-300',
                        TABLE_ALIGN_CLASS[align],
                      )}
                    >
                      {renderInline(parseInline(header), `${keyPrefix}-th-${i}`)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {(block.rows ?? []).map((row, rowIndex): ReactNode => (
                <tr
                  key={`${keyPrefix}-tr-${rowIndex}`}
                  className="border-b border-white/[0.04] last:border-b-0"
                >
                  {row.map((cell, cellIndex): ReactNode => {
                    const align = block.alignments?.[cellIndex] ?? 'left';
                    return (
                      <td
                        key={`${keyPrefix}-td-${rowIndex}-${cellIndex}`}
                        className={cn(
                          'px-2 py-1 align-top text-[11px] leading-relaxed text-slate-300 [overflow-wrap:anywhere]',
                          TABLE_ALIGN_CLASS[align],
                        )}
                      >
                        {renderInline(
                          parseInline(cell),
                          `${keyPrefix}-td-${rowIndex}-${cellIndex}`,
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'hr':
      return <hr className="my-2 border-white/[0.07]" />;

    case 'codeblock':
      return <CodeBlock code={block.lines.join('\n')} lang={block.lang} />;

    default:
      return (
        <p className="min-w-0 max-w-full leading-relaxed [overflow-wrap:anywhere]">
          {block.lines.map((line, i): ReactNode => (
            <Fragment key={`${keyPrefix}-p-${i}`}>
              {i > 0 ? ' ' : null}
              {renderInline(parseInline(line), `${keyPrefix}-p-${i}`)}
            </Fragment>
          ))}
        </p>
      );
  }
});

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * MarkdownLite —— 零依赖、XSS 安全的轻量增量 Markdown 渲染器。
 *
 * 支持：`#` ~ `####` 四级标题、`**加粗**`、`*斜体*`、`` `行内代码` ``、
 * `[text](url)` 白名单外链、`> 引用`（支持多层嵌套）、有序/无序列表、
 * GFM 表格（含单列/对齐/转义竖线）、`---` 分隔线、围栏代码块及流式呼吸光标。
 *
 * @param props 见 MarkdownLiteProps
 */
function MarkdownLiteComponent({
  markdown,
  isStreaming = false,
  className,
}: MarkdownLiteProps): ReactElement | null {
  const blockCacheRef = useRef<IncrementalBlockCache | null>(null);

  const blocks = useMemo((): readonly Block[] => {
    const prev = blockCacheRef.current;
    if (prev !== null && prev.source === markdown) {
      return prev.allBlocks;
    }

    let baseClosedBlocks: readonly Block[] = [];
    let tailStart = 0;

    if (
      prev !== null &&
      prev.closedLength > 0 &&
      markdown.length >= prev.closedLength &&
      markdown.startsWith(prev.closedPrefix)
    ) {
      baseClosedBlocks = prev.closedBlocks;
      tailStart = prev.closedLength;
    }

    const tail = tailStart === 0 ? markdown : markdown.slice(tailStart);
    const parsed =
      tail.length === 0
        ? { blocks: [] as Block[], closedCharOffset: 0, closedBlockCount: 0 }
        : parseBlocksCore(tail, 0);

    const newlyClosed =
      parsed.closedBlockCount > 0 ? parsed.blocks.slice(0, parsed.closedBlockCount) : [];
    const nextClosedBlocks =
      newlyClosed.length === 0 ? baseClosedBlocks : [...baseClosedBlocks, ...newlyClosed];
    const nextClosedLength = tailStart + parsed.closedCharOffset;
    const nextAllBlocks =
      baseClosedBlocks.length === 0 ? parsed.blocks : [...baseClosedBlocks, ...parsed.blocks];

    blockCacheRef.current = {
      source: markdown,
      closedPrefix: nextClosedLength === 0 ? '' : markdown.slice(0, nextClosedLength),
      closedLength: nextClosedLength,
      closedBlocks: nextClosedBlocks,
      allBlocks: nextAllBlocks,
    };

    return nextAllBlocks;
  }, [markdown]);

  if (markdown.trim().length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'min-w-0 max-w-full space-y-1.5 text-xs leading-relaxed text-slate-300 [overflow-wrap:anywhere]',
        className,
      )}
    >
      {blocks.map((block, blockIndex): ReactElement => {
        const key = `b-${blockIndex}`;
        return <MemoMarkdownBlock key={key} block={block} keyPrefix={key} />;
      })}

      {/* 流式呼吸光标：接在最后一个块之后，暗示还在生成 */}
      {isStreaming ? (
        <span
          className="inline-block h-3 w-1 animate-glow-pulse rounded-sm bg-cyan-400 align-middle"
          aria-hidden
        />
      ) : null}
    </div>
  );
}

export default memo(MarkdownLiteComponent);
