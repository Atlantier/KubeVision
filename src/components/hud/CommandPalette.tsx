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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import { cn } from '@/utils/cn';
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

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * CommandPalette —— 全局运维命令面板。
 */
export default function CommandPalette({ onClose }: CommandPaletteProps): React.ReactElement {
  const [query, setQuery] = useState<string>('');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* ---- Store 订阅（仅取构造命令所需的最小字段） ---- */
  const pods = useClusterStore((s) => s.snapshotSummary.pods);
  const nodes = useClusterStore((s) => s.snapshotSummary.nodes);
  const selectEntity = useClusterStore((s) => s.selectEntity);
  const setActiveRightTab = useClusterStore((s) => s.setActiveRightTab);
  const setPerfHudOpen = useClusterStore((s) => s.setPerfHudOpen);
  const setActiveChaos = useClusterStore((s) => s.setActiveChaos);
  const setConnectionMode = useClusterStore((s) => s.setConnectionMode);
  const appendTerminalLog = useClusterStore((s) => s.appendTerminalLog);

  /** 打开即聚焦输入框（含一个微延迟：等 framer-motion 进场后聚焦才不被打断） */
  useEffect(() => {
    const timer = window.setTimeout((): void => {
      inputRef.current?.focus();
    }, 60);
    return (): void => window.clearTimeout(timer);
  }, []);

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
      { scenario: 'POD_OOM_SWARM', label: '注入：Pod OOM 雪崩' },
      { scenario: 'NODE_CPU_SPIKE', label: '注入：节点 CPU 尖峰' },
      { scenario: 'NET_PACKET_LOSS', label: '注入：网络丢包分区' },
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
        label: '打开 AI 运维副驾',
        hint: '切到 Copilot 页签',
        kind: 'nav',
        run: (): void => {
          setActiveRightTab('copilot');
          onClose();
        },
      },
      {
        id: 'nav-auditor',
        label: '打开端侧隐私日志审计',
        hint: '切到 Edge Log Auditor 页签',
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
   * 模糊过滤。
   *
   * 【匹配策略】子串命中主标题 > 子串命中副标题 > 不匹配。
   * 大小写不敏感；查询为空时保留全部（让用户先看到可选项）。
   * 结果上限 40 条，避免输入单个字符时渲染上百条目。
   */
  const filtered = useMemo((): PaletteCommand[] => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return allCommands.slice(0, 40);

    const labelHits: PaletteCommand[] = [];
    const hintHits: PaletteCommand[] = [];
    for (const cmd of allCommands) {
      if (cmd.label.toLowerCase().includes(q)) labelHits.push(cmd);
      else if (cmd.hint.toLowerCase().includes(q)) hintHits.push(cmd);
    }
    return [...labelHits, ...hintHits].slice(0, 40);
  }, [allCommands, query]);

  /* 查询变化时重置高亮到首项（否则会停在一个不存在的索引上） */
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  /** 执行当前高亮项 */
  const runActive = useCallback((): void => {
    const target = filtered[activeIndex];
    if (target !== undefined) target.run();
  }, [filtered, activeIndex]);

  /**
   * 键盘处理。
   *
   * 【为何在输入框而非 window 上监听】面板打开时输入框有焦点，
   * 事件自然冒泡到此处；在 window 上监听会与 ShellLayout 的 Esc 处理
   * 竞争，导致一次按键触发两次关闭。
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev): number => (prev + 1) % Math.max(1, filtered.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((prev): number => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        runActive();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    },
    [filtered.length, runActive, onClose],
  );

  /* 高亮项滚动进视野（键盘导航时不会跑到视口外） */
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const active = list.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      className="fixed inset-0 z-[60] flex items-start justify-center bg-slate-950/70 pt-[12vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="运维命令面板"
      onClick={(event): void => {
        /* 点击遮罩关闭（点击面板本体不关闭） */
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -12, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        className="w-[min(640px,92vw)] overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_24px_64px_-12px_rgba(2,6,23,0.95)]"
      >
        {/* ---- 搜索输入行 ---- */}
        <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-cyan-400" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event): void => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索 Pod / 节点，或输入运维动作…"
            aria-label="命令面板搜索"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-600"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭命令面板"
            className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:text-rose-400"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        {/* ---- 结果列表 ---- */}
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center font-mono text-[11px] text-slate-600">
              未找到匹配的命令
            </p>
          ) : (
            filtered.map((cmd, index): React.ReactNode => {
              const Icon = KIND_ICON[cmd.kind];
              const active = index === activeIndex;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  onClick={cmd.run}
                  onMouseEnter={(): void => setActiveIndex(index)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors',
                    active ? 'bg-cyan-500/10' : 'hover:bg-slate-800/50',
                  )}
                >
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', KIND_COLOR[cmd.kind])} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-slate-200">{cmd.label}</span>
                    {cmd.hint.length > 0 ? (
                      <span className="block truncate font-mono text-[10px] text-slate-500">{cmd.hint}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 rounded border border-slate-700 bg-slate-800/60 px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                    {KIND_LABEL[cmd.kind]}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* ---- 底部快捷键提示 ---- */}
        <div className="flex items-center gap-3 border-t border-slate-800 px-3 py-1.5 font-mono text-[10px] text-slate-600">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-700 bg-slate-800 px-1">↑</kbd>
            <kbd className="rounded border border-slate-700 bg-slate-800 px-1">↓</kbd>
            选择
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-700 bg-slate-800 px-1">Enter</kbd>
            执行
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-700 bg-slate-800 px-1">Esc</kbd>
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