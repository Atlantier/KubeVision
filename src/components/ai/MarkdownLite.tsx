'use client';

/**
 * KubeVision AI — 轻量级安全 Markdown 渲染器（MarkdownLite）
 *
 * 【为什么需要它】后端（真实大模型与仿真器都会）输出结构化 Markdown：
 * `## 诊断结论`、`**重点**`、`` `kubectl 命令` ``、`> 告警摘要`、有序列表。
 * 而前端此前用 `<p className="whitespace-pre-wrap">{text}</p>` 直接渲染纯文本，
 * 用户看到的是满屏 `##`、`**` 与反引号——这是审查报告判定的 **P0 级观感缺陷**：
 * 一个 AI 产品的回答裸露 Markdown 语法，专业感荡然无存。
 *
 * 【为什么不引入 react-markdown / marked】
 * AGENTS.md 第 9 条锁定了依赖世代矩阵。引入新依赖需要连带评估 ESM/CJS
 * 互操作、tree-shaking 与 SSR 行为，成本远高于收益；而本项目实际用到的
 * Markdown 子集非常小（标题/加粗/斜体/行内代码/引用/列表/表格）。
 * 自己写约 400 行状态机，**零新增依赖、零 SSR 风险、完全可控**。
 *
 * 【安全契约：绝不使用 dangerouslySetInnerHTML】
 * LLM 输出是**不可信的外部输入**。任何把模型文本塞进 HTML 字符串的做法
 * 都会打开 XSS 通道（模型可能被提示注入诱导输出 `<img onerror=...>`）。
 * 本实现把文本解析为**数据结构**，再由 React 渲染为元素——
 * React 会自动转义所有文本节点，天然免疫注入。
 *
 * 【解析策略：逐行状态机 + 行内扫描】
 * 按行扫描识别块级元素（标题/引用/列表/表格/代码块），块内再按行内标记切分。
 *
 * 【本轮升级（实测缺陷修复）】
 * 1. 新增 `InlineMarkdown` 组件——生成式 UI 卡片里的单段说明/证据条目
 *    只需行内渲染，不该套一层块级 `<div className="space-y-1.5">`；
 * 2. 标题支持 `#` ~ `####` 四级（此前只认 `##`/`###`，一级标题会裸露 `#`）；
 * 3. 行内支持 `*斜体*`（区分单星与双星）与「加粗内嵌行内代码」；
 * 4. 新增 GFM 表格解析与渲染（大模型最爱输出的形态）；
 * 5. 列表项允许前导空格（模型常输出 2~4 空格的子列表，
 *    此前这些行会掉进段落分支，把 `- ` 与 `2. ` 原样渲染出来）。
 */

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
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
/* 行内解析                                                                    */
/* ========================================================================== */

/** 行内片段类型 */
type InlineKind = 'text' | 'bold' | 'italic' | 'code';

/** 行内片段 */
interface InlineSegment {
  readonly kind: InlineKind;
  readonly text: string;
  /**
   * 加粗片段内部的子片段。
   *
   * 【为何需要】实测模型会输出「**当前（`kubectl cordon` 建议暂缓）**」——
   * 加粗内部还嵌着行内代码。若把整段粗体当纯文本直接渲染，
   * 反引号就会裸露出来（这正是本轮要修的缺陷之一）。
   * 因此加粗片段会递归解析内部，只允许 code / italic 子类型（禁止嵌套 bold，
   * 避免 `**a **b** c**` 这类畸形输入造成无限递归）。
   */
  readonly children?: readonly InlineSegment[];
}

/**
 * parseInlineNoBold —— 只解析「行内代码 + 斜体」，不解析加粗。
 *
 * 供加粗片段的内部内容使用：加粗内部再出现 `**` 属于畸形输入，
 * 在此层不再处理，从而保证递归一定会终止。
 *
 * @param text 待解析文本
 * @returns 片段数组
 */
function parseInlineNoBold(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  /* code 优先于 italic：反引号里的 * 是字面量，不该被当成斜体标记 */
  const pattern = /`([^`]+?)`|\*([^\s*](?:[^*\n]*[^\s*])?)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(text);

  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      segments.push({ kind: 'code', text: match[1] });
    } else if (match[2] !== undefined) {
      segments.push({ kind: 'italic', text: match[2] });
    }
    lastIndex = match.index + match[0].length;
    match = pattern.exec(text);
  }

  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: 'text', text }];
}

/**
 * parseInline —— 把一行文本切分为「普通 / 加粗 / 斜体 / 行内代码」片段。
 *
 * 【核心逻辑】用一个组合正则一次性扫描三种标记，避免多次遍历：
 *   `\*\*(.+?)\*\*`        加粗（非贪婪，防止跨段误吞）
 *   `` `([^`]+?)` ``       行内代码
 *   `\*([^\s*]…)\*`        斜体（要求内容首尾非空白，避开 `2 * 3 * 4` 这类误判）
 *
 * 【为何加粗必须排在斜体之前】正则的交替分支是**从左到右**尝试的。
 * 若斜体在前，`**重点**` 会被拆成「空斜体 + 重点 + 空斜体」或直接错位；
 * 把双星放前面可保证 `**…**` 优先整体匹配。
 *
 * 【流式容错】流式输出时标记可能尚未闭合（如只收到 `**重点`）。
 * 由于正则要求成对出现，未闭合的标记会被当作普通文本渲染——
 * 这比"等闭合再显示"更好：用户能先看到内容，闭合后自动变样式。
 *
 * @param line 单行文本
 * @returns 片段数组（按原文顺序）
 */
function parseInline(line: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  /* 交替顺序：加粗 → 行内代码 → 斜体 */
  const pattern = /\*\*([\s\S]+?)\*\*|`([^`]+?)`|\*([^\s*](?:[^*\n]*[^\s*])?)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(line);

  while (match !== null) {
    /* 标记前的普通文本 */
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: line.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      /* 加粗：内部递归解析行内代码与斜体 */
      const inner = match[1];
      segments.push({ kind: 'bold', text: inner, children: parseInlineNoBold(inner) });
    } else if (match[2] !== undefined) {
      segments.push({ kind: 'code', text: match[2] });
    } else if (match[3] !== undefined) {
      segments.push({ kind: 'italic', text: match[3] });
    }
    lastIndex = match.index + match[0].length;
    match = pattern.exec(line);
  }

  /* 末尾剩余普通文本 */
  if (lastIndex < line.length) {
    segments.push({ kind: 'text', text: line.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: 'text', text: line }];
}

/**
 * renderInline —— 把行内片段渲染为 React 节点。
 *
 * 【样式契约】
 * - bold   → 接近纯白的字体加重（`text-slate-50 font-semibold`），
 *            在深色背景上形成清晰强调但不刺眼；内部子片段继续按 code/italic 渲染；
 * - italic → 轻微倾斜 + 略亮的字色，不做夸张处理；
 * - code   → 深色胶囊 + 等宽 + 青色文字（K8s 实体名/命令的统一表达），
 *            与全站的 `.font-mono` 遥测数字语言一致。
 *
 * @param segments 片段数组
 * @param keyPrefix 用于生成稳定 key 的前缀（避免 React 警告）
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
          /*
           * 【为何需要 break-all】行内代码胶囊此前只设了等宽字体与底色，
           * 没有断行规则。像 `oom_score_adj` 这类短标识符没问题，但遇到
           * 长 base64、长 URL、完整文件路径（`/var/lib/kubelet/pods/...`）
           * 时，这个 code 元素会以**最小内容宽度**撑开父容器，
           * 在窄屏上直接把对话气泡顶出边界——页面级 scrollWidth 不会超，
           * 但气泡内部会出现一条横向滚动条或文字被裁掉。
           * break-all 允许在任意字符处断行，代价是极短标识符偶尔会从中间折行；
           * 两个坏处相权，溢出比中间折行严重得多。
           * 配合 break-words 兜底（长英文单词场景），保证任何输入都不溢出。
           */
          className="break-all rounded border border-slate-700/60 bg-slate-800/90 px-1 py-0.5 font-mono text-[0.92em] text-cyan-300"
        >
          {seg.text}
        </code>
      );
    }
    return <Fragment key={key}>{seg.text}</Fragment>;
  });
}

/* ========================================================================== */
/* 块级解析                                                                    */
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

/** 块结构 */
interface Block {
  readonly kind: BlockKind;
  /** 标题/引用/段落的文本；列表项为各条内容；代码块为各行原文 */
  readonly lines: readonly string[];
  /** 代码块的语言标识（如 bash / yaml），无则为空串 */
  readonly lang?: string;
  /** 列表项缩进层级（0 为顶层，1 为一级子项），与 lines 一一对应 */
  readonly depths?: readonly number[];
  /** 表格表头 */
  readonly headers?: readonly string[];
  /** 表格数据行 */
  readonly rows?: readonly (readonly string[])[];
}

/**
 * 表格分隔行判定。
 *
 * 形如 `| --- | :---: | ---: |`，只允许竖线、连字符、冒号与空白。
 * 这是 GFM 表格的必要条件：没有分隔行就只是一堆带竖线的普通文本。
 */
const TABLE_SEPARATOR_PATTERN = /^\|?[\s:|-]+\|[\s:|-]+\|?$/;

/**
 * 拆表格行 —— 去掉首尾竖线后按竖线切分，逐格 trim。
 *
 * @param line 形如 `| 节点 | CPU |` 的行
 * @returns 单元格数组
 */
function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell): string => cell.trim());
}

/**
 * parseBlocks —— 把 Markdown 源文本解析为块级结构。
 *
 * 【状态机逻辑】逐行扫描并维护「当前块」：
 * - `# ` / `## ` / `### ` / `#### ` 开启标题块（从长到短匹配，防止 `####` 被 `#` 吞掉）；
 * - `> ` 连续行合并为引用块；
 * - `- ` / `* ` / `• ` 连续行合并为无序列表（允许前导空格做子列表）；
 * - `1. ` / `1)` / `1、` 连续行合并为有序列表（同样允许前导空格）；
 * - 连续 `| … |` 且第二行是分隔行 → 表格；
 * - `---` 分隔线；
 * - 其余非空行作为段落（连续行合并，保留换行语义为空格）；
 * - 空行结束当前块。
 *
 * 【为何合并连续段落行】Markdown 中单个换行不产生新段落。若逐行渲染，
 * 模型换行输出的长句会被切碎成一堆独立 `<p>`，行距过大、阅读断裂。
 *
 * @param source Markdown 源文本
 * @returns 块数组
 */
function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const rawLines = source.split('\n');

  /** 当前正在累积的块（null 表示无） */
  let current: { kind: BlockKind; lines: string[]; depths: number[] } | null = null;

  /**
   * 【围栏代码块状态】模型经常输出 ```bash … ``` 形式的命令块。
   * 若不当成整体处理，围栏标记（```）会被当作普通文本渲染出来，
   * 用户就会看到满屏反引号——这正是实测发现的 B4 缺陷。
   * 这里用一个独立状态收集围栏内的所有行，**不做任何行内解析**
   * （代码里的 * 和 ` 都是字面量，解析会破坏内容）。
   */
  let fence: { lang: string; lines: string[] } | null = null;

  /** 收尾当前块并入列 */
  const flush = (): void => {
    if (current !== null && current.lines.length > 0) {
      blocks.push({
        kind: current.kind,
        lines: current.lines,
        ...(current.kind === 'ul' || current.kind === 'ol' ? { depths: current.depths } : {}),
      });
    }
    current = null;
  };

  /** 追加一行到指定类型的块；若类型不同则先收尾 */
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

    /* ---- 围栏代码块：开启 / 结束 ---- */
    const fenceMatch = /^```(.*)$/.exec(line.trim());
    if (fenceMatch !== null) {
      if (fence === null) {
        /* 开启围栏：先结束上文块 */
        flush();
        fence = { lang: fenceMatch[1].trim(), lines: [] };
      } else {
        /* 关闭围栏：整体入列，内容原样保留 */
        blocks.push({ kind: 'codeblock', lines: fence.lines, lang: fence.lang });
        fence = null;
      }
      continue;
    }

    /* ---- 围栏内部：原样收集，跳过一切行内解析 ---- */
    if (fence !== null) {
      fence.lines.push(rawLine);
      continue;
    }

    /* ---- 空行：结束当前块 ---- */
    if (line.trim().length === 0) {
      flush();
      continue;
    }

    /* ---- 水平分隔线 ---- */
    if (/^---+$/.test(line.trim())) {
      flush();
      blocks.push({ kind: 'hr', lines: [] });
      continue;
    }

    /* ---- 表格：当前行以 | 开头，且下一行是分隔行 ---- */
    if (line.trim().startsWith('|') && index + 1 < rawLines.length) {
      const separator = rawLines[index + 1].trim();
      if (separator.startsWith('|') && TABLE_SEPARATOR_PATTERN.test(separator)) {
        flush();
        const headers = splitTableRow(line);
        const rows: string[][] = [];
        /* 跳过表头与分隔行，收集后续所有表格行 */
        let cursor = index + 2;
        while (cursor < rawLines.length && rawLines[cursor].trim().startsWith('|')) {
          rows.push(splitTableRow(rawLines[cursor]));
          cursor += 1;
        }
        blocks.push({ kind: 'table', lines: [], headers, rows });
        /* 游标停在第一条非表格行之前（循环自增会跳过它，故回退一位） */
        index = cursor - 1;
        continue;
      }
    }

    /* ---- 标题：从四级到一级依次尝试（长前缀优先，防止 # 吞掉 ####） ---- */
    const h4 = /^####\s+(.+)$/.exec(line);
    if (h4 !== null) {
      flush();
      blocks.push({ kind: 'h4', lines: [h4[1]] });
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3 !== null) {
      flush();
      blocks.push({ kind: 'h3', lines: [h3[1]] });
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2 !== null) {
      flush();
      blocks.push({ kind: 'h2', lines: [h2[1]] });
      continue;
    }
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1 !== null) {
      flush();
      blocks.push({ kind: 'h1', lines: [h1[1]] });
      continue;
    }

    /* ---- 引用 ---- */
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      push('quote', quote[1]);
      continue;
    }

    /**
     * ---- 无序列表（允许前导空格） ----
     *
     * 【为何要接受前导空格】模型极爱输出两层子列表：
     * `  - 子项 A`。旧正则 `^[-*]\s+` 锚定行首，带空格的子项匹配失败后
     * 掉进段落分支，结果是界面上原样渲染出「- 子项 A」——比不缩进更糟。
     * 这里把前导空白纳入匹配，并把缩进量换算成层级深度用于视觉缩进。
     */
    const ul = /^(\s*)[-*•]\s+(.+)$/.exec(line);
    if (ul !== null) {
      push('ul', ul[2], Math.floor(ul[1].length / 2));
      continue;
    }

    /* ---- 有序列表（允许前导空格；支持 `1.` / `1)` / `1、`） ---- */
    const ol = /^(\s*)\d+[.)、]\s+(.+)$/.exec(line);
    if (ol !== null) {
      push('ol', ol[2], Math.floor(ol[1].length / 2));
      continue;
    }

    /* ---- 普通段落 ---- */
    push('p', line.trim());
  }

  flush();

  /**
   * 【流式容错】流中途结束时围栏可能尚未闭合（只收到开头的 ```）。
   * 此时把已收集的内容作为一个代码块输出，而不是丢弃——
   * 用户能先看到已到达的代码，闭合后样式才完整，不会出现空窗。
   */
  if (fence !== null && fence.lines.length > 0) {
    blocks.push({ kind: 'codeblock', lines: fence.lines, lang: fence.lang });
  }

  return blocks;
}

/* ========================================================================== */
/* 行内渲染组件                                                                */
/* ========================================================================== */

/**
 * InlineMarkdown —— 单段文本的行内 Markdown 渲染（不产生块级元素）。
 *
 * 【为什么单独导出】生成式 UI 卡片里的 `paramDescription`、`impactScope`、
 * 证据链每一条 `evidence` 都是**单段文本**。若强行套 `MarkdownLite`
 * （最外层是 `<div className="space-y-1.5">`），会在卡片内部引入块级间距，
 * 把紧凑的卡片撑散。`InlineMarkdown` 只用 `<span>` 包裹，可以安全地嵌在
 * `<p>` / `<li>` / `<code>` 原来的位置。
 *
 * @param props 见 InlineMarkdownProps
 */
export function InlineMarkdown({ text, className, highlightRunbookIds = false }: InlineMarkdownProps) {
  const uid = useId();
  const segments = useMemo((): InlineSegment[] => {
    const parsed = parseInline(text);
    return highlightRunbookIds ? promoteRunbookIds(parsed) : parsed;
  }, [text, highlightRunbookIds]);
  return <span className={className}>{renderInline(segments, `im-${uid}`)}</span>;
}

/* ========================================================================== */
/* 领域高亮：裸 Runbook 编号 → 行内代码胶囊                                      */
/* ========================================================================== */

/**
 * Runbook 编号识别正则。
 *
 * `RUNBOOK-K8S-042` / `RUNBOOK-K8S-061` 这类编号是知识库溯源的关键锚点，
 * 在推理链与系统回执里会以裸文本出现（由我方模板拼装，天然不带反引号）。
 * 把它提升为代码胶囊后，用户一眼就能定位"这条结论引自哪本手册"。
 *
 * 【字符类必须含数字】中段是 `K8S` 而非纯字母——若写成 `[A-Z]+`
 * 会匹配不到（`K` 之后是 `8`，回溯也失败），实测正是这里先踩了坑。
 */
const RUNBOOK_ID_PATTERN = /RUNBOOK-[A-Z0-9]+-\d+/g;

/**
 * promoteRunbookIds —— 把 text 片段中出现的 Runbook 编号切分为 code 片段。
 *
 * 【为何在片段层做而不是再跑一遍正则解析】行内解析已经把文本切成
 * text / bold / code / italic 四类片段；若对整行再套一次高亮，
 * 会与已生成的 code 片段重复包围，产生嵌套胶囊。
 * 因此只对 `text` 类型片段做二次切分，其余片段原样保留。
 *
 * @param segments 行内片段数组
 * @returns 处理后的片段数组（text 中命中的编号变为 code）
 */
function promoteRunbookIds(segments: readonly InlineSegment[]): InlineSegment[] {
  const result: InlineSegment[] = [];

  for (const segment of segments) {
    /* 加粗/代码/斜体片段：内部若有加粗子片段也一并递归处理 */
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
    /* 无命中：原样保留，避免把整段拆成无意义的单片段 */
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
/* 代码块（含一键复制）                                                          */
/* ========================================================================== */

/** 复制成功提示的展示时长（毫秒） */
const COPY_FEEDBACK_MS = 1500;

/**
 * CodeBlock —— 围栏代码块渲染（等宽 + 深底 + 右上角一键复制）。
 *
 * 【为什么要复制按钮】AI 给出的 SRE 处置命令（`kubectl cordon`、
 * `kubectl top pod`、`journalctl -u kubelet`）本来就是**要被执行**的。
 * 让工程师手动拖选一段跨行代码，既慢又容易漏行或带上前导缩进——
 * 一个复制按钮直接消除了这类低级失误，这是排障工具的基本素养。
 *
 * 【状态机】idle →（点击）→ copied（绿色勾 + 「已复制」）→ 1500ms 后回到 idle。
 * 定时器在卸载时清理，避免在已卸载组件上 setState。
 *
 * 【剪贴板降级】`navigator.clipboard` 只在安全上下文（HTTPS / localhost）
 * 可用。不可用时回退到「临时 textarea + execCommand('copy')」的老办法，
 * 保证在内网 HTTP 部署下按钮依然有效，而不是静默失效。
 *
 * @param props code 代码正文；lang 语言标识（可为空）
 */
function CodeBlock({ code, lang }: { readonly code: string; readonly lang?: string }) {
  const [copied, setCopied] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* 卸载清理：防止定时器在组件已销毁后触发 setState */
  useEffect((): (() => void) => {
    return (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  /** 把代码写入剪贴板（含非安全上下文降级） */
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
    <div className="my-1.5 overflow-hidden rounded border border-slate-700/70 bg-slate-950/80">
      {/* 头部：左侧语言标识，右侧一键复制 */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/60 px-2 py-0.5">
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
      <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-relaxed text-slate-300">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * MarkdownLite —— 零依赖、XSS 安全的轻量 Markdown 渲染器。
 *
 * 支持：`#` ~ `####` 四级标题、`**加粗**`（可内嵌行内代码）、`*斜体*`、
 * `` `行内代码` ``、`> 引用`、有序/无序列表（含缩进子项）、GFM 表格、
 * `---` 分隔线，以及流式呼吸光标。
 *
 * @param props 见 MarkdownLiteProps
 */
export default function MarkdownLite({
  markdown,
  isStreaming = false,
  className,
}: MarkdownLiteProps) {
  /* 解析结果缓存：流式时 markdown 每次变化都会重算，这是必要的 */
  const blocks = useMemo((): Block[] => parseBlocks(markdown), [markdown]);

  if (markdown.trim().length === 0) {
    return null;
  }

  return (
    <div className={cn('space-y-1.5 text-xs leading-relaxed text-slate-300', className)}>
      {blocks.map((block, blockIndex): ReactNode => {
        const key = `b-${blockIndex}`;

        switch (block.kind) {
          /* ---- 一级标题：最重的章节锚点（左侧粗青条 + 更大字号） ---- */
          case 'h1':
            return (
              <h2
                key={key}
                className="mt-3 flex items-center gap-1.5 border-l-[3px] border-cyan-400 pl-2 text-sm font-bold text-slate-50 first:mt-0"
              >
                {renderInline(parseInline(block.lines[0]), `${key}-h`)}
              </h2>
            );

          /* ---- 二级标题：左侧青色竖线 + 加粗，形成章节锚点 ---- */
          case 'h2':
            return (
              <h3
                key={key}
                className="mt-2 flex items-center gap-1.5 border-l-2 border-cyan-400/70 pl-2 text-[13px] font-bold text-slate-100 first:mt-0"
              >
                {renderInline(parseInline(block.lines[0]), `${key}-h`)}
              </h3>
            );

          /* ---- 三级标题：更轻的层级 ---- */
          case 'h3':
            return (
              <h4 key={key} className="mt-1.5 text-xs font-semibold text-slate-200 first:mt-0">
                {renderInline(parseInline(block.lines[0]), `${key}-h`)}
              </h4>
            );

          /**
           * ---- 四级标题：最轻的一级 ----
           * 用等宽小字 + 前缀细条表达"这是一个更细的段落标签"，
           * 与三级标题形成明确的层级落差，而不是仅仅小 1px。
           */
          case 'h4':
            return (
              <h5
                key={key}
                className="mt-1 flex items-center gap-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-slate-400 first:mt-0"
              >
                <span className="h-2.5 w-px shrink-0 bg-slate-600" aria-hidden />
                {renderInline(parseInline(block.lines[0]), `${key}-h`)}
              </h5>
            );

          /* ---- 引用块：琥珀色左描边 + 半透明底，用于告警摘要 ---- */
          case 'quote':
            return (
              <blockquote
                key={key}
                className="rounded-r border-l-2 border-amber-500/70 bg-amber-500/[0.07] px-2 py-1 text-[11.5px] leading-relaxed text-amber-200/90"
              >
                {block.lines.map((line, i): ReactNode => (
                  <p key={`${key}-q-${i}`}>{renderInline(parseInline(line), `${key}-q-${i}`)}</p>
                ))}
              </blockquote>
            );

          /* ---- 无序列表（支持缩进子项） ---- */
          case 'ul':
            return (
              <ul key={key} className="space-y-0.5">
                {block.lines.map((line, i): ReactNode => {
                  const depth = block.depths?.[i] ?? 0;
                  return (
                    <li
                      key={`${key}-li-${i}`}
                      className="relative leading-relaxed"
                      style={{ paddingLeft: `${14 + depth * 12}px` }}
                    >
                      {/* 自定义圆点：默认 list-disc 在深色背景下偏暗 */}
                      <span
                        className={cn(
                          'absolute top-[0.55em] h-1 w-1 rounded-full',
                          depth > 0 ? 'bg-slate-500' : 'bg-cyan-400/70',
                        )}
                        style={{ left: `${4.5 + depth * 12}px` }}
                        aria-hidden
                      />
                      {renderInline(parseInline(line), `${key}-li-${i}`)}
                    </li>
                  );
                })}
              </ul>
            );

          /* ---- 有序列表：保留模型给出的序号语义 ---- */
          case 'ol':
            return (
              <ol key={key} className="space-y-0.5">
                {block.lines.map((line, i): ReactNode => {
                  const depth = block.depths?.[i] ?? 0;
                  return (
                    <li
                      key={`${key}-li-${i}`}
                      className="flex gap-1.5 leading-relaxed"
                      style={{ paddingLeft: `${depth * 12}px` }}
                    >
                      <span className="shrink-0 font-mono text-[11px] font-bold tabular-nums text-cyan-400/80">
                        {i + 1}.
                      </span>
                      <span className="min-w-0 flex-1">{renderInline(parseInline(line), `${key}-li-${i}`)}</span>
                    </li>
                  );
                })}
              </ol>
            );

          /**
           * ---- GFM 表格 ----
           *
           * 【为何必须支持】大模型在 SRE 报告里极度偏爱表格（节点水位对比、
           * 五问排查矩阵）。不支持时整张表会退化成段落，
           * 用户看到的是一行行 `| 节点 | CPU |` 的裸竖线。
           *
           * 单元格内同样走 parseInline，因此 `**88.1%**` 与 `` `memory.max` ``
           * 在表格里也能获得加粗与胶囊高亮，而不是裸露原始标记。
           */
          case 'table':
            return (
              <div
                key={key}
                /*
                 * 【窄屏策略】外层保持 overflow-x-auto：表格天然可能比容器宽，
                 * 强行压窄会把每一列都挤成竖排单字。宁可让用户横向滚动，
                 * 也不要把表格压到不可读。
                 *
                 * 同时给 table 一个 min-w-full 而不是 w-full：
                 * `w-full` 在内容更宽时会被内容顶开（浏览器对 table 的
                 * 自动布局特性），导致容器虽然设了 overflow-x-auto 却
                 * 看不到滚动条——因为容器自己也被撑宽了。
                 * `min-w-full + w-auto` 才能让"容器窄于内容时出现滚动"生效。
                 */
                className="my-1.5 overflow-x-auto rounded border border-slate-800 bg-slate-950/60"
              >
                <table className="min-w-full border-collapse text-left">
                  <thead>
                    <tr className="bg-slate-900/90">
                      {(block.headers ?? []).map((header, i): ReactNode => (
                        <th
                          key={`${key}-th-${i}`}
                          /*
                           * 表头保留 whitespace-nowrap：表头是短标签
                           * （"编号" / "标题" / "匹配度"），换行会让表头变成
                           * 两行高、破坏对齐。数据单元格则允许换行。
                           */
                          className="whitespace-nowrap border-b border-slate-800 px-2 py-1 font-mono text-[11px] font-bold text-slate-300"
                        >
                          {renderInline(parseInline(header), `${key}-th-${i}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(block.rows ?? []).map((row, rowIndex): ReactNode => (
                      <tr key={`${key}-tr-${rowIndex}`} className="border-b border-slate-800/60 last:border-b-0">
                        {row.map((cell, cellIndex): ReactNode => (
                          <td
                            key={`${key}-td-${rowIndex}-${cellIndex}`}
                            className="px-2 py-1 align-top text-[11px] leading-relaxed text-slate-300"
                          >
                            {renderInline(parseInline(cell), `${key}-td-${rowIndex}-${cellIndex}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          /* ---- 分隔线 ---- */
          case 'hr':
            return <hr key={key} className="my-2 border-slate-800" />;

          /* ---- 围栏代码块：等宽 + 深底 + 一键复制 ---- */
          case 'codeblock':
            return (
              <CodeBlock key={key} code={block.lines.join('\n')} lang={block.lang} />
            );

          /* ---- 普通段落 ---- */
          default:
            return (
              <p key={key} className="leading-relaxed">
                {block.lines.map((line, i): ReactNode => (
                  <Fragment key={`${key}-p-${i}`}>
                    {i > 0 ? ' ' : null}
                    {renderInline(parseInline(line), `${key}-p-${i}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}

      {/* ---- 流式呼吸光标：接在最后一个块之后，暗示"还在写" ---- */}
      {isStreaming ? (
        <span
          className="inline-block h-3 w-1 animate-glow-pulse rounded-sm bg-cyan-400 align-middle"
          aria-hidden
        />
      ) : null}
    </div>
  );
}