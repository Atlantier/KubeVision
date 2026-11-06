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
 * Markdown 子集非常小（标题/加粗/行内代码/引用/列表）。
 * 自己写约 200 行状态机，**零新增依赖、零 SSR 风险、完全可控**。
 *
 * 【安全契约：绝不使用 dangerouslySetInnerHTML】
 * LLM 输出是**不可信的外部输入**。任何把模型文本塞进 HTML 字符串的做法
 * 都会打开 XSS 通道（模型可能被提示注入诱导输出 `<img onerror=...>`）。
 * 本实现把文本解析为**数据结构**，再由 React 渲染为元素——
 * React 会自动转义所有文本节点，天然免疫注入。
 *
 * 【解析策略：逐行状态机】
 * 按行扫描，识别块级元素（标题/引用/列表），块内再按行内标记切分。
 * 这是 Markdown 的最小可行实现，覆盖 AI 回答的绝大多数形态。
 */

import { Fragment, useMemo, type ReactNode } from 'react';

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

/* ========================================================================== */
/* 行内解析                                                                    */
/* ========================================================================== */

/** 行内片段类型 */
type InlineKind = 'text' | 'bold' | 'code';

/** 行内片段 */
interface InlineSegment {
  readonly kind: InlineKind;
  readonly text: string;
}

/**
 * parseInline —— 把一行文本切分为「普通 / 加粗 / 行内代码」片段。
 *
 * 【核心逻辑】用一个组合正则一次性扫描三种标记，避免多次遍历：
 *   `\*\*(.+?)\*\*`  加粗（非贪婪，防止跨段误吞）
 *   `` `(.+?)` ``    行内代码
 * 正则带 g 标志逐段推进，未命中部分归入 text。
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
  /* 一次扫描匹配加粗与行内代码两种标记 */
  const pattern = /\*\*(.+?)\*\*|`([^`]+?)`/g;
  let lastIndex = 0;
  let match = pattern.exec(line);

  while (match !== null) {
    /* 标记前的普通文本 */
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: line.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      segments.push({ kind: 'bold', text: match[1] });
    } else if (match[2] !== undefined) {
      segments.push({ kind: 'code', text: match[2] });
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
 * - bold → 接近纯白的字体加重（`text-slate-50 font-semibold`），
 *   在深色背景上形成清晰的视觉强调但不刺眼；
 * - code → 深色胶囊 + 等宽 + 青色文字（K8s 实体名/命令的统一表达），
 *   与全站的 `.font-mono` 遥测数字语言一致。
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
          {seg.text}
        </strong>
      );
    }
    if (seg.kind === 'code') {
      return (
        <code
          key={key}
          className="rounded border border-slate-700/60 bg-slate-800/90 px-1 py-0.5 font-mono text-[0.92em] text-cyan-300"
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
type BlockKind = 'h2' | 'h3' | 'quote' | 'ul' | 'ol' | 'hr' | 'codeblock' | 'p';

/** 块结构 */
interface Block {
  readonly kind: BlockKind;
  /** 标题/引用/段落的文本；列表项为各条内容；代码块为各行原文 */
  readonly lines: readonly string[];
  /** 代码块的语言标识（如 bash / yaml），无则为空串 */
  readonly lang?: string;
}

/**
 * parseBlocks —— 把 Markdown 源文本解析为块级结构。
 *
 * 【状态机逻辑】逐行扫描并维护「当前块」：
 * - `## ` / `### ` 开启新的标题块；
 * - `> ` 连续行合并为一个引用块（多行引用保持段落连续）；
 * - `- ` / `* ` 连续行合并为无序列表；
 * - `1. ` 等数字序号连续行合并为有序列表；
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
  let current: { kind: BlockKind; lines: string[] } | null = null;

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
      blocks.push({ kind: current.kind, lines: current.lines });
    }
    current = null;
  };

  /** 追加一行到指定类型的块；若类型不同则先收尾 */
  const push = (kind: BlockKind, text: string): void => {
    if (current === null || current.kind !== kind) {
      flush();
      current = { kind, lines: [text] };
    } else {
      current.lines.push(text);
    }
  };

  for (const rawLine of rawLines) {
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

    /* ---- 三级标题（先匹配更长的前缀，避免 ### 被 ## 吞掉） ---- */
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3 !== null) {
      flush();
      blocks.push({ kind: 'h3', lines: [h3[1]] });
      continue;
    }

    /* ---- 二级标题 ---- */
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2 !== null) {
      flush();
      blocks.push({ kind: 'h2', lines: [h2[1]] });
      continue;
    }

    /* ---- 引用 ---- */
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      push('quote', quote[1]);
      continue;
    }

    /* ---- 无序列表 ---- */
    const ul = /^[-*]\s+(.+)$/.exec(line);
    if (ul !== null) {
      push('ul', ul[1]);
      continue;
    }

    /* ---- 有序列表 ---- */
    const ol = /^\d+[.)]\s+(.+)$/.exec(line);
    if (ol !== null) {
      push('ol', ol[1]);
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
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * MarkdownLite —— 零依赖、XSS 安全的轻量 Markdown 渲染器。
 *
 * 支持：`## / ###` 标题、`**加粗**`、`` `行内代码` ``、`> 引用`、
 * 有序/无序列表、`---` 分隔线，以及流式呼吸光标。
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

          /* ---- 无序列表 ---- */
          case 'ul':
            return (
              <ul key={key} className="space-y-0.5 pl-3.5">
                {block.lines.map((line, i): ReactNode => (
                  <li key={`${key}-li-${i}`} className="relative leading-relaxed">
                    {/* 自定义圆点：默认 list-disc 在深色背景下偏暗 */}
                    <span
                      className="absolute -left-2.5 top-[0.55em] h-1 w-1 rounded-full bg-cyan-400/70"
                      aria-hidden
                    />
                    {renderInline(parseInline(line), `${key}-li-${i}`)}
                  </li>
                ))}
              </ul>
            );

          /* ---- 有序列表：保留模型给出的序号语义 ---- */
          case 'ol':
            return (
              <ol key={key} className="space-y-0.5 pl-1">
                {block.lines.map((line, i): ReactNode => (
                  <li key={`${key}-li-${i}`} className="flex gap-1.5 leading-relaxed">
                    <span className="shrink-0 font-mono text-[11px] font-bold tabular-nums text-cyan-400/80">
                      {i + 1}.
                    </span>
                    <span className="min-w-0 flex-1">{renderInline(parseInline(line), `${key}-li-${i}`)}</span>
                  </li>
                ))}
              </ol>
            );

          /* ---- 分隔线 ---- */
          case 'hr':
            return <hr key={key} className="my-2 border-slate-800" />;

          /* ---- 围栏代码块：等宽 + 深底 + 可横向滚动 ---- *
           * 命令块在 SRE 场景里非常常见（kubectl / journalctl 输出），
           * 必须保持每行独立换行（whitespace-pre）与等宽对齐，
           * 否则 YAML 缩进和多行命令会被折叠成一行，完全无法阅读。 */
          case 'codeblock':
            return (
              <div
                key={key}
                className="my-1.5 overflow-hidden rounded border border-slate-700/70 bg-slate-950/80"
              >
                {(block.lang ?? '').length > 0 ? (
                  <div className="border-b border-slate-800 bg-slate-900/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                    {block.lang}
                  </div>
                ) : null}
                <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-relaxed text-slate-300">
                  <code>{block.lines.join('\n')}</code>
                </pre>
              </div>
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
