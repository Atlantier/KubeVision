'use client';

/**
 * KubeVision AI — SRE 领域知识库弹窗（RAG Runbook Explorer）
 *
 * 【设计意图】把「后端检索器里那 12 篇看不见的手册」变成一块可触摸、可质疑、
 * 可现场扩充的知识底座控制台。它回答评委与运维最常问的三个问题：
 * 1. **AI 到底依据哪些手册在回答**（左侧语料全量清单，内置与自定义分色标记）；
 * 2. **为什么是这几篇**（顶部混合检索沙盒：输入任意故障描述，实时展示三路
 *    证据拆解 —— Vector 余弦 / BM25 稀疏 / Context 增益 —— 与命中的核心特征词）；
 * 3. **我能不能加一条自己的经验**（底部表单写入 localStorage，立即进入检索池）。
 *
 * 【三块功能与数据流】
 * A. 左侧语料列表：`getAllRunbookCorpus()` 的内置 + 自定义全量视图，点击选中；
 *    自定义条目可经 `removeCustomRunbook(id)` 删除，删除后重新拉取语料池。
 * B. 右侧详情：选中 Runbook 的症状 / 根因机理 / 标准 SOP / 特征词全量展开，
 *    让「结论」回到「可核验的证据」。
 * C. 顶部检索沙盒：查询受控，`retrieveSreRunbooks(query, 'NONE', [], 3)` 实时
 *    跑一遍真实引擎（不是前端伪造的高亮），因此展示的置信度与真实 Copilot
 *    检索完全同源。
 * D. 底部表单：构造合法 `RagRunbookDoc` 后 `addCustomRunbook(doc)` 持久化，
 *    并立即刷新列表、选中新条目 —— 形成「新增即可检索」的闭环。
 *
 * 【SSR / Hydration 安全】
 * `getAllRunbookCorpus()` 会读取 localStorage，服务端拿不到任何自定义语料。
 * 若直接用它在渲染期初始化 `useState`，客户端首次水合会多出 N 条自定义条目，
 * 导致 DOM 结构不一致。因此初始状态只取**确定性的内置语料**常量
 * `SRE_RUNBOOK_CORPUS`，自定义条目统一在 `useEffect`（仅客户端）里合并。
 *
 * 【进出场契约】
 * `open === false` 时组件直接返回 null（关闭即卸载，不残留任何遮罩节点）；
 * 面板入场由 `initial` / `animate` 变体驱动，退场 `exit` 变体同样声明并包裹在
 * `AnimatePresence` 中 —— 当父级选择「保持挂载 + AnimatePresence 包裹」时，
 * 退场动画同样可以平滑播放，两种挂载方式都不丢过渡。
 *
 * 【层级与视觉】z-50 顶层遮罩 + 深空毛玻璃面板（AGENTS.md 第 5、6 条），
 * 面板内不再出现二级浮层，避免与 Copilot 抽屉 / 3D 标注抢层级。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState } from 'react';
import { useEscapeLayer } from '@/hooks/useEscapeStack';
import { createPortal } from 'react-dom';
import { AnimatePresence,
  motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Plus,
  Search,
  Trash2,
  X,
  Radar,
} from 'lucide-react';

import { cn } from '@/utils/cn';
import {
  SRE_RUNBOOK_CORPUS,
  addCustomRunbook,
  getAllRunbookCorpus,
  removeCustomRunbook,
  retrieveSreRunbooks,
} from '@/utils/sreRagEngine';
import type { RagRunbookDoc } from '@/types/ai';
import type { ChaosScenario } from '@/types/cluster';

/* ========================================================================== */
/* 常量契约                                                                     */
/* ========================================================================== */

/**
 * 沙盒检索固定使用的混沌场景。
 *
 * 【为何是 NONE】沙盒的目标是验证「纯文本查询」的检索质量。若传入当前演练
 * 场景，contextBoost 会把演练先验混进结果（例如 OOM 演练下所有 memory 类
 * 手册都自动加分），沙盒就不再是「查询驱动」而是「环境驱动」，
 * 无法证明文本检索本身有效。NONE 让三路证据中的 context 一栏如实地展示为 0。
 */
const SANDBOX_CHAOS: ChaosScenario = 'NONE';

/** 沙盒固定返回的 Top-K 条数（与契约「展示 Top-3」一致） */
const SANDBOX_TOP_K = 3;

/** 详情面板特征词胶囊的最大展示数量（超出部分截断，避免撑破面板） */
const MAX_VISIBLE_FEATURE_TERMS = 12;

/** 自定义条目 tags 的截取数量（契约：从特征词取前 3 个） */
const CUSTOM_TAGS_LIMIT = 3;

/** 表单输入框通用样式（input / textarea 共用，保证视觉一致） */
const FIELD_CLASS =
  'w-full rounded-md border border-white/[0.07] bg-slate-950/80 px-2.5 py-1.5 text-xs text-slate-200 outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-400/60 focus:ring-1 focus:ring-cyan-400/30';

/**
 * 知识分类 → 胶囊配色映射。
 *
 * 【色彩语义】只用 AGENTS.md 第 5 条允许的四种状态色：
 * memory / scheduling 属资源压力 → amber（告警）；runtime 属崩溃类 → rose；
 * network / control-plane 属链路与主题域 → cyan；stateful 与其余 → emerald（正常基线）。
 * 未知分类走 fallback 的 slate，不引入新的色彩语义。
 */
const CATEGORY_TONE: Readonly<Record<string, string>> = {
  memory: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  scheduling: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  runtime: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  network: 'border-cyan-400/40 bg-cyan-400/10 text-cyan-300',
  'control-plane': 'border-cyan-400/40 bg-cyan-400/10 text-cyan-300',
  stateful: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
};

/** 未登记分类的兜底胶囊样式（中性 slate，不臆断语义） */
const CATEGORY_TONE_FALLBACK = 'border-white/[0.07] bg-slate-800/60 text-slate-400';

/* ========================================================================== */
/* 表单状态与示例模板                                                            */
/* ========================================================================== */

/**
 * CustomRunbookFormState —— 新增自定义 Runbook 表单的全部受控字段。
 *
 * 【为何用「一个对象 state」而非 6 个独立 state】6 个字段在提交时是**原子读取**
 * 的整体：分字段 setState 会让提交回调闭包可能读到部分旧值（同一事件里
 * 连续 setState 的批处理语义虽能保证一致，但读起来需要推理）；
 * 单对象 + 函数式更新让「读取当前值」与「更新某字段」都只经过一次 setForm，
 * 状态流转只有一条路径。
 */
interface CustomRunbookFormState {
  /** 标题（必填，构成 doc.title） */
  readonly title: string;
  /** 分类（可空，空则落为 custom；构成 doc.category） */
  readonly category: string;
  /** 故障症状（必填，构成 doc.symptom） */
  readonly symptom: string;
  /** 底层根因机理（可空，构成 doc.rootCauseMechanism） */
  readonly rootCauseMechanism: string;
  /** 特征词（逗号分隔原文，提交时解析为 doc.featureVocabulary / doc.tags） */
  readonly featureVocabulary: string;
  /** 修复步骤（按换行分割为 doc.remediationSteps） */
  readonly remediationSteps: string;
}

/** 空表单（提交成功后复位，保证下一次录入从干净状态开始） */
const EMPTY_FORM: CustomRunbookFormState = {
  title: '',
  category: '',
  symptom: '',
  rootCauseMechanism: '',
  featureVocabulary: '',
  remediationSteps: '',
};

/**
 * EXAMPLE_CUSTOM_RUNBOOK —— 「填入示例」一键填充的预设模板。
 *
 * 【内容为何选 Redis 脑裂】内置 12 篇语料已覆盖 OOM / CrashLoop / 调度 / CNI /
 * etcd / APIServer 限流，缺的是「有状态中间件」这一类。Redis Sentinel 脑裂
 * 是真实生产事故，且其机理（SDOWN/ODOWN 判定、quorum、min-replicas-to-write、
 * failover 后的数据回退）足够专业可信 —— 展示时能证明「自定义语料不是随便
 * 编的一段话」，也让检索沙盒能立刻命中一篇高区分度文档。
 */
const EXAMPLE_CUSTOM_RUNBOOK: CustomRunbookFormState = {
  title: 'Redis 集群脑裂与 Sentinel 切换失败排障手册',
  category: 'stateful',
  symptom:
    '主节点所在宿主机网络抖动后，哨兵完成过一次故障转移（failover），但旧主恢复后仍以 master 身份接受写入；客户端报 READONLY 只读错误，或写入成功后数据在数秒内回退。执行 redis-cli info replication 可见两台实例的 role 同为 master。',
  rootCauseMechanism:
    'Sentinel 每秒 PING 一次主节点，超过 down-after-milliseconds 未响应记为主观下线（SDOWN）；quorum 个哨兵达成一致后升级为客观下线（ODOWN），再由被选举出的 Leader 哨兵执行 failover 并提升某个从节点。若网络分区持续时间长于哨兵判定窗口，且分区两侧各自凑齐 quorum（例如哨兵分布在两个可用区且各占多数），两个分区就会各自选出一个主节点，形成脑裂。旧主恢复网络后不会自动降级，继续接受写入；当它最终被降级为从库时会执行全量重同步，master_repl_offset 之后尚未复制到新主的写入被直接丢弃，这就是业务侧观察到的数据回退。若 min-replicas-to-write 与 min-replicas-max-lag 未配置，写节点在失去从节点确认时仍接受写入，会进一步放大回退范围。',
  featureVocabulary:
    'redis, sentinel, split-brain, sdown, odown, failover, readonly, master_replid, min-replicas-to-write, quorum',
  remediationSteps: [
    '确认双主：对每台实例执行 redis-cli -h <ip> -p <port> info replication，比对 role、master_replid 与 master_repl_offset',
    '摘除流量：在入口层下线旧主，阻止其继续接受写入，避免回退范围扩大',
    '核对哨兵视图：redis-cli -p 26379 sentinel masters 检查 ODOWN 状态、votes 计数与 failover-timeout 是否合理',
    '固化新主：在旧主执行 REPLICAOF <new-master-ip> <port>，确认全量同步完成后 master_replid 与新主一致',
    '开启写保护：配置 min-replicas-to-write 1 与 min-replicas-max-lag 10，禁止客户端绕过哨兵直连旧节点',
    '加固部署：哨兵保持奇数个并跨可用区分布，quorum 取多数派，down-after-milliseconds 大于一次完整 GC 停顿',
  ].join('\n'),
};

/* ========================================================================== */
/* 纯函数工具                                                                   */
/* ========================================================================== */

/**
 * splitVocabulary —— 把逗号分隔的特征词原文解析为规范化词元数组。
 *
 * 【设计意图】特征词是检索通道二的输入，格式必须可预期：统一转小写
 * （与引擎 tokenize 的小写口径对齐）、去空白、去重且保持用户输入顺序
 * （顺序有意义：tags 取前 3 个，用户可以把最重要的词写在前面）。
 *
 * @param raw 用户输入原文（支持英文逗号与中文逗号混用）
 * @returns 去重后的特征词数组（可能为空）
 */
function splitVocabulary(raw: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const segment of raw.split(/[,，]/)) {
    const term = segment.trim().toLowerCase();
    if (term === '' || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

/**
 * splitSteps —— 把 textarea 的多行文本解析为有序修复步骤。
 *
 * 【核心逻辑】按换行切分后逐行 trim，并**丢弃空行**：用户在步骤之间多敲
 * 空行是排版习惯，不应变成空白的 SOP 条目（详情面板会渲染出空心序号圆点）。
 *
 * @param raw textarea 原文（每行一条）
 * @returns 非空步骤数组（保持输入顺序）
 */
function splitSteps(raw: string): string[] {
  return raw
    .split('\n')
    .map((line: string): string => line.trim())
    .filter((line: string): boolean => line.length > 0);
}

/**
 * clampPercent —— 把 [0,1] 的三路得分换算为进度条宽度百分比。
 *
 * 【为何要显式夹取】scoreBreakdown 的取值为四舍五入后的浮点，理论上界 1，
 * 但浮点累加可能产出 1.0001。直接拼进 `width: 100.01%` 会让进度条溢出
 * 圆角容器；同时 NaN / Infinity 会被换算成 `NaN%`（CSS 无效值，宽度回落为
 * auto）—— 这两种边界都必须在这里收敛成合法整数。
 *
 * @param value 引擎给出的单路得分（通常是 [0,1]）
 * @returns 0~100 的整数百分比
 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

/**
 * formatPercent —— 置信度得分 → 百分比展示串。
 *
 * @param score similarityScore（可能为 undefined：入库态文档没有检索语境）
 * @returns 形如 '96%' 的展示串；无值时为 '--'
 */
function formatPercent(score: number | undefined): string {
  if (score === undefined || !Number.isFinite(score)) return '--';
  return `${Math.round(score * 100)}%`;
}

/**
 * confidenceToneClass —— 置信度分档配色。
 *
 * 【分档依据】引擎的置信度经分段 Sigmoid 校准，实测有效命中落在
 * 0.35~0.97：0.8 以上是强匹配（emerald）、0.55~0.8 是中等匹配（cyan）、
 * 更低的是弱命中（amber）。用颜色提示「这条结果的证据强度」，
 * 而不是清一色绿色制造虚假确定感。
 *
 * @param score similarityScore
 * @returns Tailwind 胶囊类名
 */
function confidenceToneClass(score: number | undefined): string {
  if (score === undefined || !Number.isFinite(score)) {
    return 'border-white/[0.07] bg-slate-800/60 text-slate-400';
  }
  if (score >= 0.8) return 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300';
  if (score >= 0.55) return 'border-cyan-400/50 bg-cyan-400/10 text-cyan-300';
  return 'border-amber-400/50 bg-amber-400/10 text-amber-300';
}

/* ========================================================================== */
/* 展示原子组件                                                                 */
/* ========================================================================== */

/**
 * CategoryTag —— 知识分类胶囊（列表项与详情头共用）。
 *
 * 【设计与意图】分类是读者筛选语料的第一维度，必须在 280px 侧栏里
 * 一眼可辨；因此用等宽字体 + 极小的字号 + 分类专属色调，
 * 与标题的常规字体形成层级差，不抢标题的视觉权重。
 *
 * @param props.category 文档分类原文（如 memory / network / control-plane）
 */
function CategoryTag({ category }: { readonly category: string }): React.ReactElement {
  const tone = CATEGORY_TONE[category] ?? CATEGORY_TONE_FALLBACK;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1.5 py-px font-mono text-[10px] tracking-[0.06em]',
        tone,
      )}
    >
      {category}
    </span>
  );
}

/**
 * ScoreBarProps —— 单路检索信号进度条的入参契约。
 *
 * 【为何把颜色拆成两个 prop】同一条信号在「进度条填充」与「文字标签」上
 * 需要不同透明度（填充要饱和、文字要可读），把两者拆开可以让调用点
 * 一次性决定整条信号的色系，组件内部不做任何语义判断。
 */
interface ScoreBarProps {
  /** 信号短名（Vector / BM25 / Context） */
  readonly label: string;
  /** 悬停提示（中文全称，解释这一路衡量的是什么） */
  readonly hint: string;
  /** 信号原始得分 [0,1] */
  readonly value: number;
  /** 进度条填充色类名 */
  readonly barClassName: string;
  /** 标签文字色类名 */
  readonly labelClassName: string;
}

/**
 * ScoreBar —— 三路检索证据的水平进度条。
 *
 * 【设计意图】RAG 最容易被质疑的是「凭什么是这几篇」。一个裸的最终分无法
 * 自证；把三路证据拆开画成三条独立进度条后，读者能立即看出本次命中
 * 「主要靠 BM25 精确术语」还是「主要靠词袋余弦的整体语义」——
 * 这就是把黑盒检索变成可解释证据链的最小可视化单元。
 *
 * 【核心逻辑】宽度 = 得分 × 100%（夹取到 0~100 的整数），并同步以
 * `role="progressbar"` 暴露 aria-valuenow，读屏用户也能获得同一信息。
 *
 * @param props 见 ScoreBarProps
 */
function ScoreBar({
  label,
  hint,
  value,
  barClassName,
  labelClassName,
}: ScoreBarProps): React.ReactElement {
  const percent = clampPercent(value);
  return (
    <div className="flex items-center gap-2" title={hint}>
      <span
        className={cn(
          'w-14 shrink-0 font-mono text-[10px] uppercase tracking-[0.06em]',
          labelClassName,
        )}
      >
        {label}
      </span>
      <div
        role="progressbar"
        aria-label={hint}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-800"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300 ease-out',
            barClassName,
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-500">
        {percent}%
      </span>
    </div>
  );
}

/**
 * DetailSection —— 详情区的小节骨架（标题 + 左侧主题短线 + 内容插槽）。
 *
 * 【设计意图】右侧详情由四段并列信息组成（症状 / 根因 / SOP / 特征词）。
 * 若每段各写一遍标题结构与分隔线，四处的字号、间距、描边迟早漂移；
 * 收敛为一个骨架后，新增小节只需提供 title 与 children。
 *
 * @param props.title    小节中文标题
 * @param props.children 小节内容
 */
function DetailSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="mt-4 border-t border-white/[0.07]/80 pt-3">
      <h4 className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] tracking-[0.2em] text-cyan-400/80">
        <span className="h-2.5 w-0.5 shrink-0 rounded-full bg-cyan-400/60" aria-hidden />
        {title}
      </h4>
      {children}
    </section>
  );
}

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * RagKnowledgeModal —— SRE 领域知识库弹窗（z-50 顶层）。
 *
 * 【职责边界】本组件只做三件事：展示语料、跑检索沙盒、写自定义语料。
 * 它**不**修改集群状态、不触发混沌演练、不发送网络请求 —— 所有能力都来自
 * `@/utils/sreRagEngine` 的纯函数接口，因此可以在任意页面安全挂载。
 *
 * 【状态流转】
 * - `corpus`：当前完整语料池（内置 + 自定义）。初始为内置常量（SSR 安全），
 *   挂载 / 每次打开时用 `getAllRunbookCorpus()` 同步一次（含 localStorage 自定义）；
 * - `selectedId`：左侧选中项。语料池变化后若旧选中项已不存在（被删除），
 *   自动回落到第一条，避免详情区停在悬空引用上；
 * - `query` / `retrievalResults`：沙盒查询与实时检索结果（useMemo 派生，不落 state）；
 * - `form` / `formError` / `formNotice`：底部表单三态。
 *
 * @param props.open    是否打开。false 时直接返回 null（卸载整个遮罩）
 * @param props.onClose 关闭回调（关闭按钮、遮罩点击、Escape 三处共用）
 * @returns 打开时返回 AnimatePresence 包裹的弹窗元素，关闭时返回 null
 */
export default function RagKnowledgeModal({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): React.ReactElement | null {
  /* ---- 语料池与选中项 ---- */
  const [corpus, setCorpus] = useState<RagRunbookDoc[]>(() => [...SRE_RUNBOOK_CORPUS]);
  const [selectedId, setSelectedId] = useState<string>(() =>
    SRE_RUNBOOK_CORPUS.length > 0 ? SRE_RUNBOOK_CORPUS[0].id : '',
  );

  /* ---- 检索沙盒 ---- */
  const [query, setQuery] = useState<string>('');

  /* ---- 自定义 Runbook 表单 ---- */
  const [isFormOpen, setIsFormOpen] = useState<boolean>(false);
  const [form, setForm] = useState<CustomRunbookFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string>('');
  const [formNotice, setFormNotice] = useState<string>('');

  /**
   * 语料池同步（仅客户端）。
   *
   * 【为何放在 useEffect 而非 useState 初始化】localStorage 在服务端不存在。
   * 若在初始化里合并自定义条目，服务端渲染 12 条、客户端水合 14 条，
   * 直接触发 hydration mismatch（AGENTS.md 第 4 条）。
   * 依赖 [open]：父级若只在打开时才挂载本组件，首次打开同样会走到这里，
   * 保证「刚在别处新增的语料」也能被看到。
   */
  useEffect(() => {
    if (!open) return;
    const nextCorpus = getAllRunbookCorpus();
    setCorpus(nextCorpus);
    setSelectedId((previousId: string): string => {
      if (
        previousId !== '' &&
        nextCorpus.some((doc: RagRunbookDoc): boolean => doc.id === previousId)
      ) {
        return previousId;
      }
      return nextCorpus.length > 0 ? nextCorpus[0].id : '';
    });
  }, [open]);

  /*
   * 【C1】Esc 统一由页面级分级退出栈处理：本组件只注册一层，
   * 不再向 window 挂自己的 keydown（旧实现多个弹层会同时抢 Esc）。
   */
  useEscapeLayer(open ? { id: 'rag-knowledge', priority: 80, label: 'SRE 领域知识库', onEscape: onClose } : null);

  /** 当前选中的 Runbook（null 表示语料池为空或尚无选中项） */
  const selectedDoc = useMemo<RagRunbookDoc | null>(
    () => corpus.find((doc: RagRunbookDoc): boolean => doc.id === selectedId) ?? null,
    [corpus, selectedId],
  );

  /** 自定义条目数量（标题栏徽章用，与内置条目分开计数） */
  const customCount = useMemo<number>(
    () => corpus.filter((doc: RagRunbookDoc): boolean => doc.isCustom === true).length,
    [corpus],
  );

  /**
   * 实时混合检索结果（Top-3）。
   *
   * 【为何用 useMemo 派生而不落 state】检索是纯函数：输出完全由
   * `query` 与语料池决定，存进 state 只会引入「输入与结果不同步」的
   * 中间态（例如 setQuery 后结果晚一帧更新，进度条闪一下旧值）。
   * 直接派生保证「输入框里的字」与「下方三条结果」永远来自同一次计算。
   *
   * 【为何依赖 corpus】自定义条目增删后检索池变化，引擎内部会重新读取
   * `getAllRunbookCorpus()`；这里显式引用 corpus 让视图与语料池同帧刷新。
   */
  const retrievalResults = useMemo<RagRunbookDoc[]>(() => {
    const trimmedQuery = query.trim();
    if (trimmedQuery === '') return [];
    if (corpus.length === 0) return [];
    return retrieveSreRunbooks(trimmedQuery, SANDBOX_CHAOS, [], SANDBOX_TOP_K);
  }, [query, corpus]);

  /**
   * handleSelect —— 选中左侧语料条目。
   *
   * @param id 目标 Runbook id
   */
  const handleSelect = useCallback((id: string): void => {
    setSelectedId(id);
  }, []);

  /**
   * handleRemoveCustom —— 删除一条自定义 Runbook 并刷新视图。
   *
   * 【核心流转】`removeCustomRunbook` 只返回**自定义**子集，不能直接拿来
   * 覆盖完整语料池（会把内置 12 篇冲掉），因此删除后必须重新调用
   * `getAllRunbookCorpus()` 取「内置 + 自定义」全量。
   * 若被删的正是当前选中项，选中回落第一条，避免详情区指向已删除对象。
   *
   * @param id 目标自定义 Runbook id
   */
  const handleRemoveCustom = useCallback((id: string): void => {
    removeCustomRunbook(id);
    const nextCorpus = getAllRunbookCorpus();
    setCorpus(nextCorpus);
    setSelectedId((previousId: string): string => {
      if (previousId !== id) return previousId;
      return nextCorpus.length > 0 ? nextCorpus[0].id : '';
    });
    setFormError('');
    setFormNotice('');
  }, []);

  /**
   * updateForm —— 表单字段局部更新 + 清除旧错误提示。
   *
   * 【为何用补丁对象】六个字段共用一条更新路径，调用点只声明「哪个字段变了」，
   * 避免在 JSX 里散落六个几乎相同的 setForm 闭包。
   *
   * @param patch 待合并的字段补丁（Partial 保证只改传入的键）
   */
  const updateForm = useCallback((patch: Partial<CustomRunbookFormState>): void => {
    setForm((previous: CustomRunbookFormState): CustomRunbookFormState => ({
      ...previous,
      ...patch,
    }));
    setFormError('');
    setFormNotice('');
  }, []);

  /**
   * handleToggleForm —— 展开 / 收起底部新增表单。
   */
  const handleToggleForm = useCallback((): void => {
    setIsFormOpen((previous: boolean): boolean => !previous);
  }, []);

  /**
   * handleFillExample —— 一键填入 Redis 脑裂示例模板。
   *
   * 【为何同时展开表单】用户点击后如果表单仍是收起的，填进去的内容不可见，
   * 会让人误以为按钮无效。先展开再填充，反馈是即时的。
   */
  const handleFillExample = useCallback((): void => {
    setForm(EXAMPLE_CUSTOM_RUNBOOK);
    setFormError('');
    setFormNotice('');
    setIsFormOpen(true);
  }, []);

  /**
   * handleSubmit —— 校验并写入自定义 Runbook（表单 submit 事件）。
   *
   * 【核心流转】
   * 1. 基础校验：标题与症状是检索的关键锚点，任一为空则拒绝（保留表单内容，
   *    仅在页脚显示错误，不弹 alert）；
   * 2. 构造合法 `RagRunbookDoc`：id 用 `Date.now().toString(36)` 保证同一毫秒内
   *    也具备足够熵；tags 取特征词前 3 个；relatedChaos 置空（自定义语料不应
   *    擅自绑定混沌演练先验，否则会污染 contextBoost）；
   * 3. `addCustomRunbook` 持久化到 localStorage（内部按 id 去重），
   *    随后重新拉取完整语料池、选中新条目、复位表单并收起。
   *
   * 【为何提交后仍提示 id】让用户能立刻在左侧列表里定位到刚写的那一条
   * （自定义条目追加在语料池末尾，列表可能需要滚动）。
   *
   * @param event 表单提交事件（用于阻止浏览器默认的整页刷新）
   */
  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();

      const title = form.title.trim();
      const symptom = form.symptom.trim();
      if (title === '' || symptom === '') {
        setFormNotice('');
        setFormError('提交失败：标题与故障症状为必填项，请补全后再入库。');
        setIsFormOpen(true);
        return;
      }

      const vocabulary = splitVocabulary(form.featureVocabulary);
      const category = form.category.trim();

      const doc: RagRunbookDoc = {
        id: `CUSTOM-RB-${Date.now().toString(36).toUpperCase()}`,
        title,
        category: category === '' ? 'custom' : category,
        tags: vocabulary.slice(0, CUSTOM_TAGS_LIMIT),
        symptom,
        remediationSteps: splitSteps(form.remediationSteps),
        featureVocabulary: vocabulary,
        rootCauseMechanism: form.rootCauseMechanism.trim(),
        relatedChaos: [],
        customCreatedAt: new Date().toISOString(),
        isCustom: true,
      };

      addCustomRunbook(doc);
      const nextCorpus = getAllRunbookCorpus();
      setCorpus(nextCorpus);
      setSelectedId(doc.id);
      setForm(EMPTY_FORM);
      setFormError('');
      setFormNotice(`已写入语料池并选中：${doc.id}`);
      setIsFormOpen(false);
    },
    [form],
  );

  /* ---- 契约：关闭态直接返回 null（卸载整个遮罩，不留任何残留节点） ---- */
  if (!open) return null;

  const isQueryEmpty = query.trim() === '';
  const hasResults = retrievalResults.length > 0;

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="rag-knowledge-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-3 kv-blur-panel sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label="SRE 领域知识库"
      >
        {/* ============ 遮罩点击关闭（独立按钮，位于面板之下，不与面板交互冲突） ============ */}
        <button
          type="button"
          aria-label="点击遮罩关闭知识库弹窗"
          onClick={(): void => onClose()}
          className="absolute inset-0 cursor-default"
        />

        {/* ============ 主面板：深空毛玻璃 ============ */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 14 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          className="relative flex h-[80vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-cyan-400/30 bg-slate-950/95 shadow-[0_24px_80px_rgba(2,6,23,0.9)] kv-blur-panel"
        >
          {/* ---- 顶部主题流光细线 ---- */}
          <div
            className="h-px w-full shrink-0 bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent"
            aria-hidden
          />

          {/* ============ 标题栏 ============ */}
          <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.07] px-4 py-3 sm:px-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-400/10">
              <Database className="h-4 w-4 text-cyan-400" aria-hidden />
            </span>

            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold tracking-wide text-slate-100">
                SRE 领域知识库
              </h2>
              <p className="mt-0.5 truncate font-mono text-[10px] tracking-[0.16em] text-slate-500">
                sre runbook corpus · hybrid retrieval sandbox
              </p>
            </div>

            {/* 条目计数徽章：总量 + 自定义分量，两者分开计数避免混淆权威性 */}
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-0.5 font-mono text-[10px] text-cyan-300">
                {corpus.length} 条
              </span>
              {customCount > 0 ? (
                <span className="hidden rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-0.5 font-mono text-[10px] text-emerald-300 sm:inline-flex">
                  自定义 {customCount}
                </span>
              ) : null}
            </div>

            <button
              type="button"
              onClick={(): void => onClose()}
              aria-label="关闭知识库弹窗"
              className="shrink-0 rounded-md border border-white/[0.07] p-1.5 text-slate-500 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-300 active:scale-95"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

          {/* ============ 主体：沙盒 / 列表+详情 / 新增表单 ============ */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 sm:p-4">
            {/* ---------------- C. 顶部实时混合检索沙盒 ---------------- */}
            <section
              aria-label="实时混合检索沙盒"
              className="shrink-0 rounded-lg border border-white/[0.07] bg-slate-900/60 px-3.5 py-3"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Search className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
                  retrieval sandbox
                </span>
                <span className="rounded border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-px font-mono text-[10px] text-cyan-300">
                  vector + bm25 + context
                </span>
                <span className="ml-auto font-mono text-[10px] text-slate-500">
                  top-{SANDBOX_TOP_K}
                </span>
              </div>

              <input
                type="text"
                value={query}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  setQuery(event.target.value);
                }}
                placeholder="输入任意故障描述，如：容器内存爆了 exit 137 / 跨节点丢包"
                aria-label="故障描述检索输入"
                spellCheck={false}
                className={cn(FIELD_CLASS, 'mt-2 font-mono')}
              />

              <div className="mt-2.5">
                {isQueryEmpty ? (
                  <p className="rounded border border-dashed border-white/[0.07] px-3 py-4 text-center text-[11px] text-slate-500">
                    输入故障描述开始检索
                  </p>
                ) : !hasResults ? (
                  <p className="rounded border border-dashed border-amber-400/30 bg-amber-400/5 px-3 py-4 text-center text-[11px] text-amber-300/80">
                    未命中任何 Runbook（查询缺乏区分度）
                  </p>
                ) : (
                  <ul className="grid max-h-[184px] grid-cols-1 gap-2 overflow-y-auto pr-1 md:grid-cols-3">
                    {retrievalResults.map((doc: RagRunbookDoc): React.ReactElement => {
                      const breakdown = doc.scoreBreakdown;
                      return (
                        <li
                          key={doc.id}
                          className="rounded-md border border-white/[0.07] bg-slate-950/80 p-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate font-mono text-[10px] uppercase tracking-[0.1em] text-slate-500">
                                {doc.id}
                              </p>
                              <p
                                className="mt-0.5 truncate text-[11px] leading-snug text-slate-200"
                                title={doc.title}
                              >
                                {doc.title}
                              </p>
                            </div>
                            <span
                              className={cn(
                                'shrink-0 rounded border px-1.5 py-px font-mono text-[10px] tabular-nums',
                                confidenceToneClass(doc.similarityScore),
                              )}
                              title="置信度：三路证据经 RRF 融合与 Sigmoid 校准后的展示值"
                            >
                              {formatPercent(doc.similarityScore)}
                            </span>
                          </div>

                          {/* 三路证据拆解：Vector 余弦 / BM25 稀疏 / Context 增益 */}
                          <div className="mt-2 space-y-1">
                            <ScoreBar
                              label="Vector"
                              hint="Vector 余弦相似度：TF-IDF 加权词向量夹角，衡量整体语义方向"
                              value={breakdown?.vectorScore ?? 0}
                              barClassName="bg-emerald-400"
                              labelClassName="text-emerald-300/80"
                            />
                            <ScoreBar
                              label="BM25"
                              hint="BM25 稀疏得分：关键术语精确命中且具备区分度时得分高"
                              value={breakdown?.bm25Score ?? 0}
                              barClassName="bg-cyan-400"
                              labelClassName="text-cyan-300/80"
                            />
                            <ScoreBar
                              label="Context"
                              hint="Context 增益：混沌场景 / 受影响 Pod / 分类呼应的上下文先验"
                              value={breakdown?.contextBoost ?? 0}
                              barClassName="bg-amber-400"
                              labelClassName="text-amber-300/80"
                            />
                          </div>

                          {/* 命中特征词（高区分度术语，按 IDF 降序） */}
                          {doc.matchedTerms !== undefined && doc.matchedTerms.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {doc.matchedTerms.map((term: string): React.ReactElement => (
                                <span
                                  key={`${doc.id}-term-${term}`}
                                  className="rounded border border-cyan-400/60 bg-cyan-400/10 px-1.5 py-px font-mono text-[10px] text-cyan-300"
                                >
                                  {term}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>

            {/* ---------------- A + B. 语料列表 与 详情 ---------------- */}
            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
              {/* ---- A. 左侧语料列表（桌面 280px 固定宽，移动端定高横置） ---- */}
              <aside className="flex h-[190px] min-h-0 w-full shrink-0 flex-col rounded-lg border border-white/[0.07] bg-slate-900/50 lg:h-auto lg:w-[280px]">
                <div className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-3 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
                    corpus index
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-slate-500">
                    {corpus.length}
                  </span>
                </div>

                <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
                  {corpus.map((doc: RagRunbookDoc): React.ReactElement => {
                    const isSelected = doc.id === selectedId;
                    const isCustom = doc.isCustom === true;
                    return (
                      <li key={doc.id} className="relative">
                        <button
                          type="button"
                          onClick={(): void => handleSelect(doc.id)}
                          aria-pressed={isSelected}
                          className={cn(
                            'w-full rounded-md border px-2.5 py-2 text-left transition-colors',
                            isCustom ? 'pr-8' : '',
                            isSelected
                              ? 'border-cyan-400/60 bg-cyan-400/10'
                              : 'border-white/[0.07] bg-slate-950/50 hover:border-white/[0.07] hover:bg-slate-900/70',
                          )}
                        >
                          <p className="truncate font-mono text-[10px] uppercase tracking-[0.1em] text-slate-500">
                            {doc.id}
                          </p>
                          <p
                            className={cn(
                              'mt-1 truncate text-[11px] leading-snug',
                              isSelected ? 'text-cyan-100' : 'text-slate-300',
                            )}
                            title={doc.title}
                          >
                            {doc.title}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            <CategoryTag category={doc.category} />
                            {isCustom ? (
                              <span className="inline-flex shrink-0 items-center rounded border border-cyan-400/50 bg-cyan-400/15 px-1.5 py-px font-mono text-[10px] text-cyan-300">
                                自定义
                              </span>
                            ) : null}
                          </div>
                        </button>

                        {/* 删除按钮与条目按钮为兄弟节点（避免按钮嵌套 button 的非法 DOM） */}
                        {isCustom ? (
                          <button
                            type="button"
                            onClick={(): void => handleRemoveCustom(doc.id)}
                            aria-label="删除该自定义 Runbook"
                            title="删除该自定义 Runbook"
                            className="absolute right-1 top-1 rounded border border-transparent p-1 text-slate-500 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-300"
                          >
                            <Trash2 className="h-3 w-3" aria-hidden />
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </aside>

              {/* ---- B. 右侧详情（选中项的完整内容） ---- */}
              <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-white/[0.07] bg-slate-900/50">
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3.5">
                  {selectedDoc === null ? (
                    <div className="flex flex-1 items-center justify-center px-4 text-center">
                      <p className="text-[11px] leading-relaxed text-slate-500">
                        从左侧语料列表中选择一条 Runbook，查看其故障症状、底层根因机理与标准修复
                        SOP。
                      </p>
                    </div>
                  ) : (
                    <article>
                      {/* 标题 + id + 分类 */}
                      <div className="flex flex-wrap items-start gap-2">
                        <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug text-slate-100">
                          {selectedDoc.title}
                        </h3>
                        {selectedDoc.isCustom === true ? (
                          <span className="inline-flex shrink-0 items-center rounded border border-cyan-400/50 bg-cyan-400/15 px-1.5 py-px font-mono text-[10px] text-cyan-300">
                            自定义
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10px] text-slate-500">
                          {selectedDoc.id}
                        </span>
                        <CategoryTag category={selectedDoc.category} />
                        {selectedDoc.customCreatedAt !== undefined ? (
                          <span className="font-mono text-[10px] text-slate-500">
                            写入于 {selectedDoc.customCreatedAt.slice(0, 19).replace('T', ' ')}
                          </span>
                        ) : null}
                        {selectedDoc.relatedChaos !== undefined &&
                        selectedDoc.relatedChaos.length > 0 ? (
                          <span className="font-mono text-[10px] text-slate-500">
                            关联演练 {selectedDoc.relatedChaos.join(' / ')}
                          </span>
                        ) : null}
                      </div>

                      {/* 故障症状 */}
                      <DetailSection title="故障症状">
                        <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-300">
                          {selectedDoc.symptom}
                        </p>
                      </DetailSection>

                      {/* 底层根因机理（等宽小字：这是“原理摘录”，与叙述性症状区分） */}
                      <DetailSection title="底层根因机理">
                        {selectedDoc.rootCauseMechanism.trim() === '' ? (
                          <p className="text-[11px] text-slate-500">该条目尚未填写底层根因机理。</p>
                        ) : (
                          <p className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-slate-400">
                            {selectedDoc.rootCauseMechanism}
                          </p>
                        )}
                      </DetailSection>

                      {/* 标准修复 SOP（有序列表 + 序号圆点） */}
                      <DetailSection title="标准修复 SOP">
                        {selectedDoc.remediationSteps.length === 0 ? (
                          <p className="text-[11px] text-slate-500">该条目尚未提供处置步骤。</p>
                        ) : (
                          <ol className="space-y-1.5">
                            {selectedDoc.remediationSteps.map(
                              (step: string, index: number): React.ReactElement => (
                                <li key={`${selectedDoc.id}-step-${index}`} className="flex gap-2">
                                  <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-400/10 font-mono text-[10px] tabular-nums text-cyan-300">
                                    {index + 1}
                                  </span>
                                  <span className="min-w-0 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-300">
                                    {step}
                                  </span>
                                </li>
                              ),
                            )}
                          </ol>
                        )}
                      </DetailSection>

                      {/* 特征词（前 12 个，小胶囊） */}
                      <DetailSection title="特征词">
                        {selectedDoc.featureVocabulary.length === 0 ? (
                          <p className="text-[11px] text-slate-500">该条目未提供特征词。</p>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {selectedDoc.featureVocabulary
                              .slice(0, MAX_VISIBLE_FEATURE_TERMS)
                              .map((term: string, index: number): React.ReactElement => (
                                <span
                                  key={`${selectedDoc.id}-feature-${index}`}
                                  className="rounded border border-white/[0.07] bg-slate-800/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-300"
                                >
                                  {term}
                                </span>
                              ))}
                          </div>
                        )}
                        {selectedDoc.featureVocabulary.length > MAX_VISIBLE_FEATURE_TERMS ? (
                          <p className="mt-1 font-mono text-[10px] text-slate-500">
                            另有 {selectedDoc.featureVocabulary.length - MAX_VISIBLE_FEATURE_TERMS}{' '}
                            个特征词参与检索
                          </p>
                        ) : null}
                      </DetailSection>
                    </article>
                  )}
                </div>
              </section>
            </div>

            {/* ---------------- D. 底部新增自定义 Runbook 表单 ---------------- */}
            <section className="shrink-0 rounded-lg border border-white/[0.07] bg-slate-900/60">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2">
                <button
                  type="button"
                  onClick={handleToggleForm}
                  aria-expanded={isFormOpen}
                  className="flex items-center gap-1.5 rounded-md border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1.5 font-mono text-[10px] tracking-[0.08em] text-cyan-300 transition-colors hover:bg-cyan-400/20"
                >
                  <Plus
                    className={cn(
                      'h-3.5 w-3.5 transition-transform duration-200',
                      isFormOpen ? 'rotate-45' : '',
                    )}
                    aria-hidden
                  />
                  新增自定义 Runbook
                </button>

                <span className="min-w-0 truncate font-mono text-[10px] text-slate-500">
                  localStorage 持久化 · 入库后立即参与混合检索
                </span>

                {formNotice !== '' ? (
                  <span className="ml-auto flex min-w-0 items-center gap-1 font-mono text-[10px] text-emerald-300">
                    <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden />
                    <span className="truncate">{formNotice}</span>
                  </span>
                ) : null}
              </div>

              {/* 表单展开/收起（高度动画由 AnimatePresence + motion 驱动） */}
              <AnimatePresence initial={false}>
                {isFormOpen ? (
                  <motion.div
                    key="rag-knowledge-form"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: 'easeOut' }}
                    className="overflow-hidden"
                  >
                    <form
                      onSubmit={handleSubmit}
                      className="max-h-[32vh] overflow-y-auto border-t border-white/[0.07] px-3.5 py-3"
                    >
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        <label className="block">
                          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                            标题
                          </span>
                          <input
                            type="text"
                            value={form.title}
                            onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                              updateForm({ title: event.target.value });
                            }}
                            placeholder="如：Redis 集群脑裂与 Sentinel 切换失败排障手册"
                            className={FIELD_CLASS}
                          />
                        </label>

                        <label className="block">
                          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                            分类
                          </span>
                          <input
                            type="text"
                            value={form.category}
                            onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                              updateForm({ category: event.target.value });
                            }}
                            placeholder="memory / runtime / network / stateful"
                            className={cn(FIELD_CLASS, 'font-mono')}
                          />
                        </label>

                        <label className="block">
                          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                            故障症状
                          </span>
                          <textarea
                            value={form.symptom}
                            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void => {
                              updateForm({ symptom: event.target.value });
                            }}
                            rows={2}
                            placeholder="对象当前的可观测表象：报错原文、Pod 状态、指标水位"
                            className={cn(FIELD_CLASS, 'resize-none')}
                          />
                        </label>

                        <label className="block">
                          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                            根因机理
                          </span>
                          <textarea
                            value={form.rootCauseMechanism}
                            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void => {
                              updateForm({ rootCauseMechanism: event.target.value });
                            }}
                            rows={2}
                            placeholder="内核 / 运行时 / 协议层的真实机制，而不是「重启一下」"
                            className={cn(FIELD_CLASS, 'resize-none font-mono')}
                          />
                        </label>

                        <label className="block md:col-span-2">
                          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                            特征词（逗号分隔，前 3 个将成为检索标签）
                          </span>
                          <input
                            type="text"
                            value={form.featureVocabulary}
                            onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                              updateForm({ featureVocabulary: event.target.value });
                            }}
                            placeholder="如：oom, exit code 137, cgroup, memory limit"
                            className={cn(FIELD_CLASS, 'font-mono')}
                          />
                        </label>

                        <label className="block md:col-span-2">
                          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                            修复步骤（每行一条，按换行分割为有序 SOP）
                          </span>
                          <textarea
                            value={form.remediationSteps}
                            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void => {
                              updateForm({ remediationSteps: event.target.value });
                            }}
                            rows={3}
                            placeholder={
                              'kubectl describe pod <pod> 确认退出码\nkubectl top pod <pod> 观察峰值\n（每行一条）'
                            }
                            className={cn(FIELD_CLASS, 'resize-none')}
                          />
                        </label>
                      </div>

                      {formError !== '' ? (
                        <p
                          role="alert"
                          className="mt-2 flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-rose-300"
                        >
                          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span className="min-w-0">{formError}</span>
                        </p>
                      ) : null}

                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                          type="submit"
                          className="flex items-center gap-1.5 rounded-md border border-cyan-400/50 bg-cyan-400/15 px-3 py-1.5 font-mono text-[10px] tracking-[0.08em] text-cyan-200 transition-colors hover:bg-cyan-400/25 active:scale-[0.98]"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                          提交入库
                        </button>
                        <button
                          type="button"
                          onClick={handleFillExample}
                          className="flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-slate-800/60 px-3 py-1.5 font-mono text-[10px] tracking-[0.08em] text-slate-300 transition-colors hover:border-white/[0.07] hover:bg-slate-800"
                        >
                          <Radar className="h-3.5 w-3.5" aria-hidden />
                          填入示例
                        </button>
                        <button
                          type="button"
                          onClick={(): void => {
                            setIsFormOpen(false);
                          }}
                          className="rounded-md border border-transparent px-2 py-1.5 font-mono text-[10px] text-slate-500 transition-colors hover:text-slate-300"
                        >
                          收起表单
                        </button>
                        <span className="ml-auto font-mono text-[10px] text-slate-500">
                          数据仅存于本地浏览器 localStorage
                        </span>
                      </div>
                    </form>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </section>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
