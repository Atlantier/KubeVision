'use client';

/**
 * KubeVision AI — 全局运维命令面板（CommandPalette）
 *
 * 【为什么值得做】这是 Linear / Vercel / Raycast 的标志性交互：
 * 一个 `Cmd/Ctrl + K` 唤起的模糊搜索框，能秒级定位任何实体、触发任何动作。
 * 对运维场景它的价值更高——故障发生时，值班人员最需要的是"用键盘直达目标"，
 * 而不是在 3D 场景里用鼠标找那颗变红的方块。
 *
 * 【三类命令】
 * 1. **实体跳转**：搜索并选中任意 Pod / Node，立即触发 3D 相机飞跃 +
 *    左上角巡检面板展开（复用既有 selectEntity 通路，零新增状态）；
 * 2. **运维动作**：切换数据源、触发/终止混沌演练、重置视角等；
 * 3. **面板导航**：切到端侧审计台、开关性能 HUD 等。
 *
 * 【键盘契约】↑/↓ 移动高亮、Enter 执行、Esc 关闭。
 * 全部通过原生事件处理，不引入任何快捷键库。
 *
 * 【性能】仅当面板打开时才挂载（父级条件渲染），关闭即卸载；
 * 搜索在 useMemo 中做，输入变化才重算，条目上限 40 条避免长列表卡顿。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useEscapeLayer } from '@/hooks/useEscapeStack';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Boxes,
  Command,
  Search,
  Server,
  X,
  Zap,
} from 'lucide-react';

import { AGENT_COPY, CHAOS_INJECT_LABELS } from '@/constants/copy';
import { MOTION } from '@/constants/tokens';
import { Z_CLASS } from '@/constants/zIndex';
import { useFocusReturn } from '@/hooks/useModalSheetBehavior';
import { cn } from '@/utils/cn';
import { isImeComposing } from '@/utils/keyboardTargets';
import { useClusterStore } from '@/store/useClusterStore';
import { dispatchViewPreset } from '@/utils/viewPresetBus';
import type { ChaosScenario } from '@/types/cluster';

/* ========================================================================== */
/* 类型                                                                       */
/* ========================================================================== */

/** 命令类别（决定图标与配色） */
type CommandKind = 'pod' | 'node' | 'action' | 'nav';

/** 单条命令 */
interface PaletteCommand {
  /** 唯一键 */
  readonly id: string;
  /** 主标题（用户看到的文案） */
  readonly label: string;
  /** 副标题（补充说明，可为空） */
  readonly hint: string;
  /** 类别 */
  readonly kind: CommandKind;
  /** 执行回调 */
  readonly run: () => void;
}

/** CommandPalette 的 Props */
export interface CommandPaletteProps {
  /** 关闭回调 */
  readonly onClose: () => void;
}

/* ========================================================================== */
/* 类别视觉映射                                                                */
/* ========================================================================== */

/** 类别 → 图标组件 */
const KIND_ICON: Readonly<Record<CommandKind, typeof Boxes>> = {
  pod: Boxes,
  node: Server,
  action: Zap,
  nav: ArrowRight,
};

/** 类别 → 图标配色 */
const KIND_COLOR: Readonly<Record<CommandKind, string>> = {
  pod: 'text-cyan-400',
  node: 'text-amber-400',
  action: 'text-rose-400',
  nav: 'text-slate-400',
};

/** 类别 → 中文标签 */
const KIND_LABEL: Readonly<Record<CommandKind, string>> = {
  pod: 'Pod',
  node: '节点',
  action: '动作',
  nav: '导航',
};

/** 分组渲染固定顺序 */
const GROUP_ORDER: readonly CommandKind[] = ['pod', 'node', 'action', 'nav'];

/** 会话级最近使用命令队列（最多保留 3 条） */
let recentCommandIdsSession: string[] = [];

function recordRecentCommandId(id: string): void {
  recentCommandIdsSession = [id, ...recentCommandIdsSession.filter((item): boolean => item !== id)].slice(0, 3);
}

/** 单个字符串的子序列模糊匹配结果 */
interface SubsequenceMatchResult {
  readonly score: number;
  readonly indices: readonly number[];
}

/** 排序后的命令匹配项（含高亮索引与最近标记） */
interface RankedCommandItem {
  readonly cmd: PaletteCommand;
  readonly score: number;
  readonly labelMatches: readonly number[];
  readonly hintMatches: readonly number[];
  readonly isRecent: boolean;
}

/** 分组条目结构 */
interface CommandGroupSection {
  readonly key: string;
  readonly title: string;
  readonly items: readonly { readonly ranked: RankedCommandItem; readonly flatIndex: number }[];
}

/**
 * scoreSubsequenceMatch —— 子序列模糊匹配打分与字符索引提取。
 *
 * 【设计意图】让用户在只记得片段（如 `wbeta` 匹配 `worker-beta`、`oom` 匹配 `注入 OOM 风暴`）时，
 * 也能一次命中并按语义精确度排序，同时返回命中下标数组用于渲染高亮片段。
 * 【输入输出】输入目标文本 `text` 与小写检索串 `needle`；返回匹配分数与下标数组，未命中返回 null。
 * 【数学/评分逻辑】连续子串命中获得基础高分（220）+ 前缀加权（80）；非连续子序列按顺序扫描，
 * 词首边界（`-`/`_`/` `/`·` 后）加分 32、连续字符加分 26，并用间隔跨度做轻微惩罚，保证短精确词优先。
 */
function scoreSubsequenceMatch(text: string, needle: string): SubsequenceMatchResult | null {
  if (needle.length === 0) return { score: 0, indices: [] };
  const hay = text.toLowerCase();

  const directIdx = hay.indexOf(needle);
  if (directIdx !== -1) {
    const indices: number[] = [];
    for (let i = 0; i < needle.length; i += 1) {
      indices.push(directIdx + i);
    }
    const prefixBonus = directIdx === 0 ? 80 : 0;
    const prevChar = directIdx > 0 ? hay.charAt(directIdx - 1) : '';
    const boundaryBonus = prevChar === '-' || prevChar === '_' || prevChar === ' ' || prevChar === '·' ? 40 : 0;
    return {
      score: 220 + prefixBonus + boundaryBonus - directIdx * 2,
      indices,
    };
  }

  const indices: number[] = [];
  let searchPos = 0;
  let score = 0;
  let lastMatched = -2;

  for (let i = 0; i < needle.length; i += 1) {
    const ch = needle.charAt(i);
    if (ch === ' ') continue;
    const found = hay.indexOf(ch, searchPos);
    if (found === -1) return null;

    indices.push(found);
    score += 18;
    if (found === 0) {
      score += 42;
    } else {
      const prevChar = hay.charAt(found - 1);
      if (prevChar === '-' || prevChar === '_' || prevChar === ' ' || prevChar === '·') {
        score += 32;
      }
    }
    if (found === lastMatched + 1) {
      score += 26;
    } else if (lastMatched >= 0) {
      score -= Math.min(12, found - lastMatched - 1);
    }
    lastMatched = found;
    searchPos = found + 1;
  }

  if (indices.length === 0) return null;
  return { score: Math.max(1, score), indices };
}

/**
 * renderHighlightedText —— 将模糊命中的字符索引合并为连续 `<mark>` 高亮，保持原 `textContent` 不变。
 */
function renderHighlightedText(text: string, indices: readonly number[]): ReactNode {
  if (indices.length === 0) return text;
  const hitSet = new Set<number>(indices);
  const parts: ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const isHit = hitSet.has(cursor);
    let end = cursor + 1;
    while (end < text.length && hitSet.has(end) === isHit) {
      end += 1;
    }
    const slice = text.slice(cursor, end);
    if (isHit) {
      parts.push(
        <mark
          key={`m-${cursor}`}
          className="rounded-[2px] bg-cyan-500/25 px-0.5 text-cyan-200"
        >
          {slice}
        </mark>,
      );
    } else {
      parts.push(<span key={`t-${cursor}`}>{slice}</span>);
    }
    cursor = end;
  }
  return parts;
}

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * CommandPalette —— 全局运维命令面板。
 */
export default function CommandPalette({ onClose }: CommandPaletteProps): React.ReactElement {
  const [query, setQuery] = useState<string>('');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [recentVersion, setRecentVersion] = useState<number>(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* ---- Store 订阅（仅取构造命令所需的最小字段与开关态） ---- */
  const isOpen = useClusterStore((s): boolean => s.isCommandPaletteOpen);
  const pods = useClusterStore((s) => s.snapshotSummary.pods);
  const nodes = useClusterStore((s) => s.snapshotSummary.nodes);
  const selectEntity = useClusterStore((s) => s.selectEntity);
  const setActiveRightTab = useClusterStore((s) => s.setActiveRightTab);
  const setPerfHudOpen = useClusterStore((s) => s.setPerfHudOpen);
  const setActiveChaos = useClusterStore((s) => s.setActiveChaos);
  const setConnectionMode = useClusterStore((s) => s.setConnectionMode);
  const appendTerminalLog = useClusterStore((s) => s.appendTerminalLog);

  /** 仅在打开态聚焦输入框 + 激活全容器 Tab 焦点陷阱；退场动画期立即解除栈占位并归还焦点 */
  useFocusReturn(isOpen, inputRef, dialogRef);

  /**
   * 构造全部可用命令。
   *
   * 【为何全量构造再过滤而非按需生成】命令总数 = 24 Pod + 3 Node + 8 动作
   * ≈ 35 条，构造成本可忽略；全量构造后统一做模糊匹配，逻辑更简单，
   * 且用户能看到"不输入时有哪些可选项"。
   */
  const allCommands = useMemo((): PaletteCommand[] => {
    const cmds: PaletteCommand[] = [];

    /* ---- 1. 实体跳转：Pod ---- */
    for (const pod of pods) {
      cmds.push({
        id: `pod-${pod.id}`,
        label: pod.name,
        hint: `${pod.namespace} · ${pod.status} · CPU ${pod.cpuUsage.toFixed(0)}%`,
        kind: 'pod',
        run: (): void => {
          selectEntity(pod.id, 'pod');
          onClose();
        },
      });
    }

    /* ---- 2. 实体跳转：Node ---- */
    for (const node of nodes) {
      cmds.push({
        id: `node-${node.id}`,
        label: node.name,
        hint: `${node.status} · CPU ${node.cpuUsage.toFixed(0)}% · MEM ${node.memUsage.toFixed(0)}%`,
        kind: 'node',
        run: (): void => {
          selectEntity(node.id, 'node');
          onClose();
        },
      });
    }

    /* ---- 3. 运维动作：混沌演练 ---- */
    const chaosOptions: ReadonlyArray<{ scenario: ChaosScenario; label: string }> = [
      { scenario: 'POD_OOM_SWARM', label: CHAOS_INJECT_LABELS.POD_OOM_SWARM },
      { scenario: 'NODE_CPU_SPIKE', label: CHAOS_INJECT_LABELS.NODE_CPU_SPIKE },
      { scenario: 'NET_PACKET_LOSS', label: CHAOS_INJECT_LABELS.NET_PACKET_LOSS },
    ];
    for (const opt of chaosOptions) {
      cmds.push({
        id: `chaos-${opt.scenario}`,
        label: opt.label,
        hint: '故障演练',
        kind: 'action',
        run: (): void => {
          setActiveChaos(opt.scenario);
          appendTerminalLog(`[CHAOS-MESH] 命令面板注入演练场景 ${opt.scenario}`);
          onClose();
        },
      });
    }
    cmds.push({
      id: 'chaos-terminate',
      label: '终止全部混沌演练',
      hint: '恢复到稳态',
      kind: 'action',
      run: (): void => {
        setActiveChaos('NONE');
        appendTerminalLog('[CHAOS-MESH] 命令面板终止演练，集群恢复稳态');
        onClose();
      },
    });

    /* ---- 4. 运维动作：数据源 / 视角 ---- */
    cmds.push(
      {
        id: 'mode-demo',
        label: '切换到合成演练流',
        hint: '本地模拟引擎持续产出遥测',
        kind: 'action',
        run: (): void => {
          setConnectionMode('demo');
          onClose();
        },
      },
      {
        id: 'mode-live',
        label: '切换到实时集群隧道',
        hint: '需外部集群 Agent 推送（当前构建未接入）',
        kind: 'action',
        run: (): void => {
          setConnectionMode('live');
          onClose();
        },
      },
      {
        id: 'view-overview',
        label: '重置全景视角',
        hint: '相机回到俯瞰机位并取消选中',
        kind: 'action',
        run: (): void => {
          selectEntity(null);
          dispatchViewPreset('overview');
          onClose();
        },
      },
      {
        id: 'view-topdown',
        label: '切换俯视视角',
        hint: '自上而下观察机架布局',
        kind: 'action',
        run: (): void => {
          dispatchViewPreset('topdown');
          onClose();
        },
      },
    );

    /* ---- 5. 导航：面板切换 ---- */
    cmds.push(
      {
        id: 'nav-copilot',
        label: `打开 ${AGENT_COPY.copilotTitle}`,
        hint: `切到${AGENT_COPY.copilotTitle}页签`,
        kind: 'nav',
        run: (): void => {
          setActiveRightTab('copilot');
          onClose();
        },
      },
      {
        id: 'nav-auditor',
        label: `打开${AGENT_COPY.auditorTitle}`,
        hint: `切到${AGENT_COPY.auditorTitle}页签`,
        kind: 'nav',
        run: (): void => {
          setActiveRightTab('auditor');
          onClose();
        },
      },
      {
        id: 'nav-perf',
        label: '打开性能遥测面板',
        hint: 'WebGL 渲染与遥测指标',
        kind: 'nav',
        run: (): void => {
          setPerfHudOpen(true);
          onClose();
        },
      },
    );

    return cmds;
  }, [pods, nodes, selectEntity, setActiveRightTab, setPerfHudOpen, setActiveChaos, setConnectionMode, appendTerminalLog, onClose]);

  /**
   * 模糊过滤与分组聚合。
   *
   * 【匹配策略】子序列模糊打分（主标题权重×2 + 副标题权重×1 + 最近执行加分）；
   * 查询为空时按「最近使用（若有）」→ Pod → 节点 → 动作 → 导航分组保留前 40 条。
   */
  const { rankedItems, groupSections } = useMemo((): {
    readonly rankedItems: readonly RankedCommandItem[];
    readonly groupSections: readonly CommandGroupSection[];
  } => {
    void recentVersion;
    const recentSet = new Set<string>(recentCommandIdsSession);
    const trimmed = query.trim().toLowerCase();

    let selected: RankedCommandItem[];
    if (trimmed.length === 0) {
      selected = allCommands.slice(0, 40).map((cmd): RankedCommandItem => ({
        cmd,
        score: recentSet.has(cmd.id) ? 10 : 0,
        labelMatches: [],
        hintMatches: [],
        isRecent: recentSet.has(cmd.id),
      }));
    } else {
      const scored: RankedCommandItem[] = [];
      for (const cmd of allCommands) {
        const labelHit = scoreSubsequenceMatch(cmd.label, trimmed);
        const hintHit = cmd.hint.length > 0 ? scoreSubsequenceMatch(cmd.hint, trimmed) : null;
        if (labelHit === null && hintHit === null) continue;
        const totalScore =
          (labelHit?.score ?? 0) * 2 +
          (hintHit?.score ?? 0) +
          (recentSet.has(cmd.id) ? 25 : 0);
        scored.push({
          cmd,
          score: totalScore,
          labelMatches: labelHit?.indices ?? [],
          hintMatches: hintHit?.indices ?? [],
          isRecent: recentSet.has(cmd.id),
        });
      }
      scored.sort((a, b): number => b.score - a.score);
      selected = scored.slice(0, 40);
    }

    const sections: CommandGroupSection[] = [];
    const flatRanked: RankedCommandItem[] = [];
    const consumedIds = new Set<string>();

    if (trimmed.length === 0 && recentCommandIdsSession.length > 0) {
      const recentBucket: { ranked: RankedCommandItem; flatIndex: number }[] = [];
      for (const recentId of recentCommandIdsSession) {
        const found = selected.find((item): boolean => item.cmd.id === recentId);
        if (found !== undefined) {
          recentBucket.push({ ranked: found, flatIndex: flatRanked.length });
          flatRanked.push(found);
          consumedIds.add(found.cmd.id);
        }
      }
      if (recentBucket.length > 0) {
        sections.push({
          key: 'recent',
          title: '最近使用',
          items: recentBucket,
        });
      }
    }

    /* 当存在输入查询时，按各组最高分降序排组，确保最优命中（如节点名直接命中）居于首行 */
    const orderedKinds: readonly CommandKind[] =
      trimmed.length > 0
        ? [...GROUP_ORDER].sort((kindA, kindB): number => {
            const maxA = selected.reduce(
              (acc, item): number =>
                item.cmd.kind === kindA && !consumedIds.has(item.cmd.id) ? Math.max(acc, item.score) : acc,
              -1,
            );
            const maxB = selected.reduce(
              (acc, item): number =>
                item.cmd.kind === kindB && !consumedIds.has(item.cmd.id) ? Math.max(acc, item.score) : acc,
              -1,
            );
            if (maxB !== maxA) return maxB - maxA;
            return GROUP_ORDER.indexOf(kindA) - GROUP_ORDER.indexOf(kindB);
          })
        : GROUP_ORDER;

    for (const kind of orderedKinds) {
      const bucket: { ranked: RankedCommandItem; flatIndex: number }[] = [];
      for (const item of selected) {
        if (item.cmd.kind !== kind || consumedIds.has(item.cmd.id)) continue;
        bucket.push({ ranked: item, flatIndex: flatRanked.length });
        flatRanked.push(item);
        consumedIds.add(item.cmd.id);
      }
      if (bucket.length > 0) {
        sections.push({
          key: kind,
          title: KIND_LABEL[kind],
          items: bucket,
        });
      }
    }

    return {
      rankedItems: flatRanked,
      groupSections: sections,
    };
  }, [allCommands, query, recentVersion]);

  /* 查询变化时重置高亮到首项（否则会停在一个不存在的索引上） */
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  /** 执行某条命令并记录至最近队列 */
  const executeCommand = useCallback((cmd: PaletteCommand): void => {
    recordRecentCommandId(cmd.id);
    setRecentVersion((v): number => v + 1);
    cmd.run();
  }, []);

  /** 执行当前高亮项 */
  const runActive = useCallback((): void => {
    const target = rankedItems[activeIndex];
    if (target !== undefined) executeCommand(target.cmd);
  }, [rankedItems, activeIndex, executeCommand]);

  /**
   * 键盘处理。
   *
   * 【为何在输入框而非 window 上监听】面板打开时输入框有焦点，
   * 事件自然冒泡到此处；方向键/Enter 只属于面板，不上 window 与全局快捷键抢键。
   * Esc 是唯一例外：由 useEscapeStack 在 window 统一派发（本层优先级 100）。
   */
  /* 【C1】命令面板由父级按需挂载（打开时才存在），因此注册即代表打开；
     优先级 100：从页面任意位置按 Esc 都先关它。
     【R3】consumeInEditable：面板打开时焦点恒在搜索框，Esc 的语义是关面板
     而非清空输入——声明后由分级栈统一消费，输入框上不再另挂 Esc 分支。 */
  /* 【C1】退场动画期仍可能短暂留在 DOM，仅在 isOpen 为真时注册 Esc 层与焦点陷阱，
     避免关闭瞬间连按两次 Esc 仍被退场中的命令面板重复截获。 */
  useEscapeLayer(
    isOpen
      ? {
          id: 'command-palette',
          priority: 100,
          label: '运维命令面板',
          onEscape: onClose,
          consumeInEditable: true,
        }
      : null,
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      /*
       * 【R3 · IME 让位】中文输入组合期间（compositionstart~compositionend），
       * Enter 只上屏候选、↑↓ 只移动候选——全部让位给输入法，绝不执行命令。
       * isComposing 主判 + keyCode 229 兜底（旧 IME 确认帧 isComposing 已 false）。
       */
      if (isImeComposing(event.nativeEvent)) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev): number => (prev + 1) % Math.max(1, rankedItems.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((prev): number => (prev - 1 + rankedItems.length) % Math.max(1, rankedItems.length));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        runActive();
        return;
      }
      /* Esc 由 useEscapeStack 统一派发（本层 consumeInEditable），此处不再处理 */
    },
    [rankedItems.length, runActive],
  );

  /* 高亮项滚动进视野（按真实 option DOM 定位，兼容分组标题节点） */
  useEffect(() => {
    const activeItem = rankedItems[activeIndex];
    if (activeItem === undefined || typeof document === 'undefined') return;
    const activeEl = document.getElementById(`cmd-option-${activeItem.cmd.id}`);
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, rankedItems]);

  const activeOptionId =
    rankedItems[activeIndex] !== undefined ? `cmd-option-${rankedItems[activeIndex].cmd.id}` : undefined;

  return (
    <motion.div
      ref={dialogRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: MOTION.overlayFadeSec, ease: MOTION.easeOut }}
      className={cn(
        'fixed inset-0 flex items-start justify-center bg-slate-950/70 px-2 pt-[10dvh] kv-blur-panel md:pt-[12vh]',
        Z_CLASS.COMMAND_PALETTE,
      )}
      role="dialog"
      aria-modal="true"
      aria-label="运维命令面板"
      tabIndex={-1}
      onClick={(event): void => {
        /* 点击遮罩关闭（点击面板本体不关闭） */
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{
          opacity: 0,
          y: -10,
          scale: 0.98,
          transition: { duration: MOTION.panelExitSec, ease: MOTION.easeOut },
        }}
        transition={{ type: 'spring', ...MOTION.spring }}
        className="flex max-h-[82dvh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-slate-900/95 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_24px_64px_-12px_rgba(2,6,23,0.95)]"
      >
        {/* ---- 搜索输入行 ---- */}
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-cyan-400" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="command-palette-listbox"
            aria-activedescendant={activeOptionId}
            value={query}
            onChange={(event): void => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索 Pod / 节点，或输入运维动作（支持子序列如 wbeta / oom）…"
            aria-label="命令面板搜索"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-400"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭命令面板"
            className="kv-touch-target flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded p-1 text-slate-400 transition-colors hover:text-rose-400 md:min-h-0 md:min-w-0"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        {/* ---- 结果列表（WAI-ARIA Listbox + 分类分组） ---- */}
        <div
          ref={listRef}
          id="command-palette-listbox"
          role="listbox"
          aria-label="命令结果列表"
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {query.trim().length === 0 && recentCommandIdsSession.length === 0 ? (
            <p className="border-b border-white/[0.05] px-3 py-1.5 font-mono text-[10px] text-slate-400">
              推荐快捷键跳转：按 Pod / 节点 / 动作 / 导航分组检索，支持子序列模糊匹配
            </p>
          ) : null}
          {rankedItems.length === 0 ? (
            <p className="px-3 py-6 text-center font-mono text-[11px] text-slate-400">
              未找到匹配的命令
            </p>
          ) : (
            groupSections.map((section): ReactNode => (
              <div key={section.key} role="group" aria-label={section.title}>
                <div className="flex items-center justify-between px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-slate-400">
                  <span>{section.title}</span>
                  <span>{section.items.length}</span>
                </div>
                {section.items.map(({ ranked, flatIndex }): ReactNode => {
                  const { cmd, labelMatches, hintMatches } = ranked;
                  const Icon = KIND_ICON[cmd.kind];
                  const active = flatIndex === activeIndex;
                  const optionId = `cmd-option-${cmd.id}`;
                  return (
                    <button
                      key={cmd.id}
                      id={optionId}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>): void => {
                        /* 鼠标按压/悬停更新高亮或触发执行，但不抢走输入框焦点 */
                        event.preventDefault();
                      }}
                      onClick={(): void => executeCommand(cmd)}
                      onMouseEnter={(): void => setActiveIndex(flatIndex)}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors',
                        active ? 'bg-cyan-500/10' : 'hover:bg-slate-800/50',
                      )}
                    >
                      <Icon className={cn('h-3.5 w-3.5 shrink-0', KIND_COLOR[cmd.kind])} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-slate-200">
                          {renderHighlightedText(cmd.label, labelMatches)}
                        </span>
                        {cmd.hint.length > 0 ? (
                          <span className="block truncate font-mono text-[10px] text-slate-400">
                            {renderHighlightedText(cmd.hint, hintMatches)}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 rounded border border-white/[0.07] bg-slate-800/60 px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-300">
                        {KIND_LABEL[cmd.kind]}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* ---- 底部快捷键提示 ---- */}
        <div className="flex items-center gap-3 border-t border-white/[0.07] px-3 py-1.5 font-mono text-[10px] text-slate-400">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-white/[0.07] bg-slate-800 px-1 text-slate-300">↑</kbd>
            <kbd className="rounded border border-white/[0.07] bg-slate-800 px-1 text-slate-300">↓</kbd>
            选择
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-white/[0.07] bg-slate-800 px-1 text-slate-300">Enter</kbd>
            执行
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-white/[0.07] bg-slate-800 px-1 text-slate-300">Esc</kbd>
            关闭
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Command className="h-2.5 w-2.5" aria-hidden />K 唤起
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}