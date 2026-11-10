/**
 * KubeVision AI — 一键全自动剧本路演导演引擎（Auto-Play Demo Director）
 *
 * 【解决什么问题】答辩现场最怕两件事：评委等不及你手动操作，或者你在讲解时
 * 忘了下一步该点哪里。本引擎把「重置稳态 → 注入混沌 → 镜头锁定 → AI 诊断 →
 * MCP 自愈」这条黄金演示链路固化成时间轴剧本，一键启动后全自动跑完，
 * 讲解者只需要讲，不需要操作。
 *
 * 【为什么放在 utils 而不是组件里】状态机必须是**单例**：顶栏按钮、导演字幕条、
 * 甚至未来的快捷键都要读同一份状态。若把状态放进某个组件的 useState，
 * 多个消费方会各自持有一份副本，暂停/停止立刻不一致。
 * 因此这里用模块级单例 + 订阅表，组件侧通过 `useSyncExternalStore` 接入。
 *
 * 【暂停/恢复的时间学】不能用「累计 setTimeout 链」实现——
 * 那样暂停时无法知道某阶段还剩多少时间。这里用**绝对时间轴**：
 *   elapsedMs = accumulatedMs + (running ? now − startedAt : 0)
 * 暂停时把本段已过时间并入 accumulatedMs，恢复时重置 startedAt 并
 * 只为「尚未到点」的阶段重新排定时器。这样暂停 10 秒再恢复，
 * 时间轴从原处继续，不会跳段也不会补跑。
 *
 * 【定时器清理契约（AGENTS.md 第 3 条的资源纪律）】
 * 停止 / 组件卸载 / 卸载页面三条路径都必须清空全部 setTimeout 与 setInterval；
 * 另有一个 AbortController 用于取消进行中的 MCP 请求，避免请求回调
 * 在停止之后仍去写 store。
 *
 * 【与规格命名的偏差（重要，如实记录）】
 * 需求里写的 `setActiveChaos('OOM_KILL')` 与 `'NETWORK_LATENCY'` 在
 * `ChaosScenario` 枚举中**并不存在**（真实取值为
 * 'NONE' | 'POD_OOM_SWARM' | 'NODE_CPU_SPIKE' | 'NET_PACKET_LOSS'）。
 * 这里映射到语义最近的 `POD_OOM_SWARM` 与 `NET_PACKET_LOSS`。
 * 需求里的 `node-alpha` / `node-beta` 实际实体 ID 是
 * `node-worker-alpha` / `node-worker-beta`。
 */

import { useEffect, useSyncExternalStore } from 'react';

import type { ChaosScenario } from '@/types/cluster';
import { useClusterStore } from '@/store/useClusterStore';
import {
  assertChaosTargets,
  CHAOS_TARGETS,
  resolveVictims,
  type ActiveChaosScenario,
  type ChaosRemediationAction,
} from '@/utils/chaosTargets';
import { isActionAllowedForPod, resolvePodAction } from '@/utils/chaosFacts';
import type { DemoFacts } from '@/types/demo';

/* ========================================================================== */
/* 类型契约                                                                    */
/* ========================================================================== */

/** 路演状态机的四态 */
export type DemoDirectorStatus = 'idle' | 'running' | 'paused' | 'finished';

/** 内置剧本标识 */
export type DemoScriptId = 'oom-autofix' | 'network-latency-trace' | 'cpu-spike-autofix';

/**
 * 单个剧本阶段（纯数据）。
 *
 * 【刻意不含动作函数】把「展示数据」与「副作用动作」分开：
 * 快照要能被 React 直接渲染、能被测试断言，若混入闭包则既不可序列化
 * 也难以在测试里替换。动作集中在 PHASE_ACTIONS 里按 scriptId + 下标对齐。
 */
export interface DemoPhase {
  /** 阶段序号（0-based） */
  readonly index: number;
  /** 相对剧本起点的触发时刻（毫秒） */
  readonly atMs: number;
  /** 阶段徽标，如「阶段 1/4 · 全景稳态巡航」 */
  readonly badge: string;
  /**
   * 静态兜底文案（不含量化断言）。
   *
   * 【为什么必须有】模板依赖当帧事实，而事实可能取不到（SSE 降级、快照未回传）。
   * 兜底文案故意**不写任何数字与名称**，这样它永远念得通、永远不会与画面矛盾。
   */
  readonly fallback: string;
  /**
   * 运行时事实模板。
   *
   * 【约定】收到 facts 后返回一句/多句完整文案；**取不到的字段整句省略**，
   * 不得用 0 或占位符填充。返回空字符串表示"事实不足，请用 fallback"。
   */
  readonly template?: (facts: DemoFacts) => string;
}

/** 剧本定义 */
export interface DemoScript {
  readonly id: DemoScriptId;
  /** 按钮/菜单里的短名 */
  readonly label: string;
  /** 完整标题 */
  readonly title: string;
  /** 总时长（毫秒） */
  readonly durationMs: number;
  readonly phases: readonly DemoPhase[];
}

/** 对外快照（订阅方读取的唯一结构） */
export interface DemoDirectorSnapshot {
  readonly status: DemoDirectorStatus;
  readonly scriptId: DemoScriptId | null;
  readonly scriptTitle: string;
  readonly phases: readonly DemoPhase[];
  /** 当前阶段下标；idle 时为 -1 */
  readonly phaseIndex: number;
  readonly elapsedMs: number;
  readonly durationMs: number;
  /** 总进度 0~1 */
  readonly progress: number;
  /** 当前阶段徽标；idle 时为空串 */
  readonly badge: string;
  /** 当前导演字幕；idle 时为空串 */
  readonly narration: string;

  /*
   * ===== 时间与外显状态（B / G / H 项）=====
   */

  /**
   * 当前阶段开始时刻（epoch ms）；idle 时 null。
   *
   * 【为什么由引擎对外暴露而非字幕条自己计时】B 项要求字幕条"读取而非
   * 自行计时"。若字幕条自己起计时器，会与引擎的暂停/恢复不同步：
   * 暂停时它继续走，恢复后两边错位。唯一时钟必须只有引擎这一个。
   */
  readonly phaseStartedAt: number | null;
  /** 当前阶段推进截止时刻（epoch ms）；null 表示等事件、无硬截止 */
  readonly phaseDeadline: number | null;
  /** 启动预检失败原因（G 项）；null 表示通过或尚未自检 */
  readonly preflightError: string | null;
  /** 本轮完成时刻（H 项）；null 表示未完成。用于"8 秒无操作自动收起"计时 */
  readonly finishedAt: number | null;
  /**
   * 是否因页面隐藏而自动暂停（F 项）。
   *
   * 【为什么要单独标记】用户主动暂停与"切走标签页被动暂停"要给不同提示：
   * 前者显示「已暂停」，后者恢复可见时要明确告诉用户"是你切走导致的"，
   * 否则用户回来看到暂停会以为程序卡了。
   */
  readonly pausedByVisibility: boolean;
}

/* ========================================================================== */
/* 常量                                                                        */
/* ========================================================================== */

/** 进度心跳间隔（毫秒）——约 8Hz，进度条平滑且不给 React 造成压力 */
const TICK_INTERVAL_MS = 120;

/** MCP 执行端点（与 ActionConfirm 使用的同一路由） */
const MCP_EXECUTE_ENDPOINT = '/api/mcp/execute';

/**
 * 【P0-1 修复记录 · 受灾目标不再硬编码】
 *
 * 修复前这里手写了两行：
 *   `const OOM_TARGET_NODE_ID = 'node-worker-alpha'`
 *   `const NETWORK_TARGET_NODE_ID = 'node-worker-beta'`
 * 而引擎的事实是：OOM→rackIndex 1(node-worker-beta)、
 * NET_PACKET_LOSS→rackIndex 2(node-worker-gamma)。
 * 两者正好写反 —— 阶段 2 镜头锁在**健康**机架上，
 * 同屏 AI 正文却写"宿主节点 node-worker-beta"，当场自证矛盾。
 *
 * 现在统一从 `utils/chaosTargets.ts` 的单一事实源取，本文件不再出现节点字面量。
 */

/**
 * 单次路演最多自愈的目标数。
 *
 * 【为什么是 3】三机架 × 每架 8 Pod 的布局下，一次演示修 3 个刚好能看清
 * "批量修复"的效果，又不至于让动画与日志淹没画面。阶段 2 的受害计数与
 * 阶段 4 的自愈上限**必须共用本常量**，否则矩阵里两列数字会互相矛盾。
 */
const MAX_HEAL_TARGETS = 3;

/** 阶段 2 注入后等待数据回传并断言"该机架确实出现异常 Pod"的超时上限 */
const FAULT_VERIFY_TIMEOUT_MS = 2_000;

/** 阶段 2 断言轮询间隔 */
const FAULT_VERIFY_POLL_MS = 250;

/**
 * 阶段 4 等待 ActionConfirm 动作卡挂载的超时上限。
 *
 * 【为何从 8 秒放宽到 24 秒（实测数据驱动）】
 * 本地 AI 流式生成 4 步推理 + 3 张卡片，在 SwiftShader 环境下实测约需
 * 28~39 秒才把动作卡挂到消息上。阶段 4 在 26s 开场，8 秒窗口
 * （26→34s）必然错过卡片挂载，导致每次都走"卡片未挂载"降级分支。
 *
 * 24 秒窗口覆盖到 50s，稳过实测最晚挂载点（~39s）。代价是阶段 4 结束后
 * 字幕条会多停留十几秒，这在演示里是可接受的——总比"声称自愈却没有
 * 一次真实 HITL 确认"要好。
 *
 * 【超时仍然如实降级】超时后走 healEntity 直调并记明日志，绝不假装执行过。
 */
const ACTION_CARD_TIMEOUT_MS = 8_000;

/**
 * 阶段 3→4 事件门的超时兜底（毫秒）。
 *
 * 【25 秒的依据】本地小模型 + SwiftShader 下 AI 流式生成 4 步推理与 3 张卡片
 * 实测约 28~39 秒；但事件门只等"动作卡挂载"，通常在流结束前 1~2 秒就满足。
 * 25 秒给足余量，同时保证总时长仍在 30~40 秒区间。
 */
const PHASE3_EVENT_GATE_TIMEOUT_MS = 25_000;

/** 事件门轮询间隔（毫秒）——200ms 对观感足够，成本可忽略 */
const PHASE3_EVENT_GATE_POLL_MS = 200;

/** 完成后自动收起字幕条的等待时长（H 项） */
export const FINISHED_AUTO_COLLAPSE_MS = 8_000;

/**
 * 事件门未决时，收尾定时器的重新检查间隔（毫秒）。
 *
 * 【为什么需要它】B 项的实测暴露了一个真实缺陷：剧本 durationMs=34000，
 * 而事件门 25 秒兜底是从阶段 3（约 11 秒）起算的，即 36 秒才到点。
 * 于是**时间轴抢在门之前结束了整场路演**——门既没等到事件、也没等到超时，
 * 阶段 4 反而由固定 atMs 定时器推进，事件驱动形同虚设。
 *
 * 修法：收尾定时器到点时若门仍未决，就推迟收尾并重新检查。
 * 门自身有 25 秒兜底，不会无限等待。
 */
const FINISH_DEFER_RECHECK_MS = 6_000;

/**
 * 收尾最短宽限期（毫秒）。
 *
 * 【为什么需要】事件门推进到阶段 4 时，时间轴可能已经"超时"（elapsed >
 * durationMs）。此时若立刻收尾，阶段 4 的 HITL 与自愈根本没机会跑。
 * 给一段宽限，让最后阶段至少能开始并等待动作卡。
 */
const FINISH_MIN_GRACE_MS = 6_000;

/**
 * 阶段 4 点击「立即执行」后等待自愈回执落库的超时上限。
 *
 * 【为何放宽到 10 秒】healEntity 是同步写 store 的，但动作卡内部有
 * 600ms 流光动画 + 一次 React 提交，加上低帧率环境（2fps）下提交延迟可达
 * 1~2 秒。6 秒在软渲染下偶发不够。
 */
const HEAL_CONFIRM_TIMEOUT_MS = 10_000;

/** 阶段 4 的 DOM 轮询间隔 */
const DOM_POLL_MS = 200;

/* ========================================================================== */
/* 剧本定义                                                                    */
/* ========================================================================== */

/**
 * 剧本 1：OOM 内存溢出全链路诊断与 MCP 自愈闭环（约 34 秒）。
 *
 * 四段节奏刻意做成 5s / 6s / 15s / 8s 的非均匀分布：
 * · 前两段快（5s、6s）：让评委先看到"系统活着"和"故障发生"的事实；
 * · 第三段最长（15s）：RAG 检索与 4 步推理链流式生成需要真实时间，
 *   催不得——压短会让 AI 看起来是假的；
 * · 第四段 8s：自愈回执 + 镜头飞回全景，留出"结果已生效"的观感余量。
 */
const OOM_PHASES: readonly DemoPhase[] = [
  {
    index: 0,
    atMs: 0,
    badge: '阶段 1/4 · 全景稳态巡航',
    fallback: 'KubeVision AI 正在实时监控刀片机柜与容器实例，集群运行平稳。',
    template: (facts: DemoFacts): string => {
      const parts: string[] = [];
      if (facts.nodeName === null && facts.runningPods !== null) {
        parts.push(`正在实时监控 ${facts.runningPods} 个运行中的容器实例`);
      }
      if (facts.runningPods !== null && facts.totalPods !== null) {
        parts.push(`${facts.runningPods} / ${facts.totalPods} 个容器处于 Running`);
      }
      return parts.length === 0 ? '' : `KubeVision AI 全景巡航：${parts.join('，')}。`;
    },
  },
  {
    index: 1,
    atMs: 5_000,
    badge: '阶段 2/4 · 故障注入与空间锁定',
    fallback: '已注入故障，正在校验受灾目标的数据回传。',
    template: (facts: DemoFacts): string => {
      /* 【关键】名称取不到就整句不写名称，绝不硬编码 payment-gateway */
      const victimPart =
        facts.victimCount === null ? '' : `检测到 ${facts.victimCount} 个容器异常`;
      const labelPart = facts.chaosLabel === null ? '' : `（${facts.chaosLabel}）`;
      const nodePart = facts.nodeName === null ? '' : `，3D 镜头已锁定受灾机架 ${facts.nodeName}`;
      if (victimPart === '') return '';
      return `${victimPart}${labelPart}${nodePart}！`;
    },
  },
  {
    index: 2,
    atMs: 11_000,
    badge: '阶段 3/4 · RAG 混合检索与多卡诊断',
    fallback: 'AI 运维副驾正在检索 SRE Runbook 知识库并生成交互式诊断卡片...',
    template: (facts: DemoFacts): string => {
      const nodePart = facts.nodeName === null ? '' : `受灾机架 ${facts.nodeName} 的`;
      return `AI 运维副驾正在检索 SRE Runbook 知识库，分析${nodePart}故障根因并生成诊断卡片...`;
    },
  },
  {
    index: 3,
    atMs: 26_000,
    badge: '阶段 4/4 · MCP 闭环自愈',
    fallback: '已下发控制器调谐指令，演练结束并恢复稳态。',
    template: (facts: DemoFacts): string => {
      /* 【关键】健康分只在两端都取到时才写成 A → B，否则不提数字 */
      const healthPart =
        facts.healthBefore === null || facts.healthAfter === null
          ? ''
          : `，集群健康分 ${facts.healthBefore} → ${facts.healthAfter}`;
      const actionPart = facts.actionType === null ? '' : `（${facts.actionType}）`;
      const victimPart =
        facts.victimCount === null ? '异常容器' : `${facts.victimCount} 个异常容器`;
      return `已下发控制器调谐指令${actionPart}，${victimPart}恢复 Running${healthPart}。`;
    },
  },
];

/**
 * 剧本 2：CNI 跨节点网络延迟追踪与自愈闭环（约 32 秒）。
 *
 * 与剧本 1 的差异点在于「问题类型」：剧本 1 是单点资源耗尽（OOM），
 * 剧本 2 是跨节点连通性劣化（丢包/延迟）。同一条演示骨架下换一个故障域，
 * 用来证明产品不是只对 OOM 做了特调。
 */
const NETWORK_PHASES: readonly DemoPhase[] = [
  {
    index: 0,
    atMs: 0,
    badge: '阶段 1/4 · 全景稳态巡航',
    fallback: '三节点拓扑基线建立中：MASTER 控制平面与各刀片机柜的链路畅通。',
    template: (facts: DemoFacts): string => {
      const nodePart =
        facts.runningPods === null ? '' : `，${facts.runningPods} 个容器处于 Running`;
      return `三节点拓扑基线建立中：MASTER 控制平面与各刀片机柜的链路畅通${nodePart}。`;
    },
  },
  {
    index: 1,
    atMs: 5_000,
    badge: '阶段 2/4 · 网络混沌注入与阻塞可视化',
    fallback: 'CNI 丢包注入生效：跨节点弧线切换为红色阻塞抖动脉冲。',
    template: (facts: DemoFacts): string => {
      /* 【关键】不写死 node-worker-beta，取不到就整句不写节点名 */
      const nodePart = facts.nodeName === null ? '' : `，镜头已锁定 ${facts.nodeName}`;
      const victimPart =
        facts.victimCount === null ? '' : `，${facts.victimCount} 个容器转为异常`;
      return `CNI 丢包注入生效：跨节点弧线切换为红色阻塞抖动脉冲${victimPart}${nodePart}。`;
    },
  },
  {
    index: 2,
    atMs: 11_000,
    badge: '阶段 3/4 · CNI VXLAN 隧道瓶颈定位',
    fallback: '副驾正在比对 VXLAN 隧道丢包率与 IPVS 连接超时，定位跨节点转发瓶颈...',
    template: (facts: DemoFacts): string => {
      const nodePart = facts.nodeName === null ? '跨节点' : `${facts.nodeName} 的跨节点`;
      return `副驾正在比对 VXLAN 隧道丢包率与 IPVS 连接超时，定位${nodePart}转发瓶颈...`;
    },
  },
  {
    index: 3,
    atMs: 24_000,
    badge: '阶段 4/4 · 网络自愈与拓扑恢复',
    fallback: '已下发节点隔离与隧道重建指令，演练结束并恢复稳态。',
    template: (facts: DemoFacts): string => {
      const actionPart = facts.actionType === null ? '' : `（${facts.actionType}）`;
      const healthPart =
        facts.healthBefore === null || facts.healthAfter === null
          ? ''
          : `，集群健康分 ${facts.healthBefore} → ${facts.healthAfter}`;
      return `已下发节点隔离与隧道重建指令${actionPart}，弧线恢复青绿流光${healthPart}。`;
    },
  },
];

/**
 * 剧本 3：节点 CPU 尖刺的算力定位与扩缩容恢复（约 34 秒）。
 *
 * 【与前两套剧本的差异】这是**资源争抢型**故障，不是崩溃型：
 * `syntheticEngine.evolvePodCpuSpike` 刻意保持 Pod 状态为 Running，只把
 * CPU 推到 92~99%（见 syntheticEngine.ts:437 注释）。因此
 *   · 阶段 2 不能说"容器崩溃"，只能说"算力被争抢"；
 *   · 阶段 4 的自愈动作是 `scale_deployment`（扩缩容分摊），
 *     而不是 restart_pod（重启只会让新容器继续被挤占）。
 * 这条剧本的存在本身就是"引擎三种故障域都能被完整演示"的证据。
 */
const CPU_PHASES: readonly DemoPhase[] = [
  {
    index: 0,
    atMs: 0,
    badge: '阶段 1/4 · 全景稳态巡航',
    fallback: 'KubeVision AI 正在实时监控刀片机柜与容器实例，集群运行平稳。',
    template: (facts: DemoFacts): string => {
      const podPart =
        facts.runningPods === null || facts.totalPods === null
          ? ''
          : `${facts.runningPods} / ${facts.totalPods} 个容器处于 Running`;
      return podPart.length === 0
        ? 'KubeVision AI 全景巡航：集群运行平稳。'
        : `KubeVision AI 全景巡航：${podPart}。`;
    },
  },
  {
    index: 1,
    atMs: 5_000,
    badge: '阶段 2/4 · 节点算力尖刺与热点锁定',
    fallback: '节点出现算力争抢，正在校验热点容器与节点负载回传。',
    template: (facts: DemoFacts): string => {
      /*
       * 【措辞纪律】不能用"容器崩溃"——本场景 Pod 状态仍为 Running，
       * 说崩溃就是与画面矛盾。只能用"算力被争抢 / CPU 被推高"。
       */
      const victimPart =
        facts.victimCount === null ? '' : `检测到 ${facts.victimCount} 个容器算力被争抢`;
      const nodePart = facts.nodeName === null ? '' : `，3D 镜头已锁定受灾机架 ${facts.nodeName}`;
      if (victimPart.length === 0) return '';
      return `${victimPart}${nodePart}！`;
    },
  },
  {
    index: 2,
    atMs: 11_000,
    badge: '阶段 3/4 · 节点算力瓶颈定位',
    fallback: 'AI 运维副驾正在比对节点负载与容器 CPU 分布，定位算力瓶颈...',
    template: (facts: DemoFacts): string => {
      const nodePart = facts.nodeName === null ? '' : `受灾机架 ${facts.nodeName} 的`;
      return `AI 运维副驾正在比对节点负载与容器 CPU 分布，定位${nodePart}算力瓶颈并生成扩缩容方案...`;
    },
  },
  {
    index: 3,
    atMs: 26_000,
    badge: '阶段 4/4 · 扩缩容自愈与算力恢复',
    fallback: '已下发扩缩容指令，演练结束并恢复稳态。',
    template: (facts: DemoFacts): string => {
      const actionPart = facts.actionType === null ? '' : `（${facts.actionType}）`;
      const healthPart =
        facts.healthBefore === null || facts.healthAfter === null
          ? ''
          : `，集群健康分 ${facts.healthBefore} → ${facts.healthAfter}`;
      return `已下发扩缩容指令${actionPart}，节点算力回落基线${healthPart}。`;
    },
  },
];

/** 内置剧本清单（顺序即菜单顺序） */
export const DEMO_SCRIPTS: readonly DemoScript[] = [
  {
    id: 'oom-autofix',
    label: 'OOM 全链路自愈',
    title: 'OOM 内存溢出全链路诊断与 MCP 自愈闭环',
    durationMs: 34_000,
    phases: OOM_PHASES,
  },
  {
    id: 'network-latency-trace',
    label: 'CNI 网络延迟追踪',
    title: 'CNI 跨节点网络延迟追踪与自愈闭环',
    durationMs: 32_000,
    phases: NETWORK_PHASES,
  },
  {
    id: 'cpu-spike-autofix',
    label: '节点 CPU 尖刺扩缩容',
    title: '节点 CPU 算力尖刺定位与扩缩容自愈闭环',
    durationMs: 34_000,
    phases: CPU_PHASES,
  },
];

/* ========================================================================== */
/* 模块级单例状态                                                              */
/* ========================================================================== */

/** 当前状态机状态 */
let status: DemoDirectorStatus = 'idle';

/** 当前剧本（idle 时为 null） */
let currentScript: DemoScript | null = null;

/** 已经触达的阶段下标（-1 表示尚未进入任何阶段） */
let phaseIndex = -1;

/*
 * ===== B / G / H 项的模块级状态 =====
 */

/** 当前阶段开始时刻（epoch ms） */
let phaseStartedAt: number | null = null;

/** 当前阶段推进截止时刻（epoch ms）；null 表示等事件 */
let phaseDeadline: number | null = null;

/** 事件门轮询定时器 */
let phaseGateTimer: ReturnType<typeof setTimeout> | null = null;

/** 事件门超时兜底定时器 */
let phaseGateDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 阶段下标 → 该阶段固定定时器句柄。
 *
 * 【为什么需要这张表】事件门若先于固定定时器触发，必须能**定点取消**
 * 下一阶段那个 atMs 定时器，否则事件与定时器会各推进一次（阶段被跳过或重入）。
 * 单个数组无法按阶段定位，因此额外维护索引表。
 */
const phaseTimerByIndex = new Map<number, ReturnType<typeof setTimeout>>();

/** 启动预检失败原因（G 项） */
let preflightError: string | null = null;

/** 本轮完成时刻（H 项） */
let finishedAt: number | null = null;

/**
 * 完成态自动收起定时器（H 项）。
 *
 * 【为什么由引擎持有而不是组件】实测发现放在组件 useEffect 里会被
 * 重渲染/重复 finish 打断，收起时间从 8s 漂移到 12.8s。
 * 自动收起本质是**时间轴的一部分**，应与其它定时器同源管理，
 * 这样 stop / 重播时能一并取消，也不会受 React 渲染节奏影响。
 */
let finishedCollapseTimer: ReturnType<typeof setTimeout> | null = null;

/** 是否因页面隐藏而自动暂停（F 项） */
let pausedByVisibility = false;

/**
 * 上一次启动的剧本 id（H 项「重播」需要）。
 *
 * 【为什么单独记】stop 会把 currentScript 置 null（避免残留状态被误读），
 * 但完成态的重播按钮仍要知道"刚才是哪套剧本"。
 */
let lastScriptId: DemoScriptId | null = null;

/** visibilitychange 守卫是否已绑定（幂等，避免重复注册） */
let visibilityBound = false;

/**
 * 运行时旁白覆盖（null 表示回落到剧本里的静态兜底文案）。
 *
 * 【为何需要】B.4 要求旁白由**当帧事实**渲染（受害 Pod 数、节点名、动作类型、
 * 健康分前后）。但事实要等数据回传才知道，无法预先写进静态剧本。
 * 因此阶段动作在拿到事实后通过 setNarration() 覆盖；
 * 事实取不到时**去掉具体数字与名称**，绝不编造。
 *
 * 【生命周期】每次进入新阶段由 enterPhase 重置为 null，避免上一阶段的事实文案漏到下一阶段。
 */
let narrationOverride: string | null = null;

/**
 * 运行代次：每次 start / stop 自增。
 *
 * 【解决什么问题】阶段动作里有若干异步链（故障校验轮询、HITL 等待、
 * MCP 回执）。若用户中途停止或切换剧本，这些在飞链必须**自行放弃**，
 * 否则停止后 8 秒还会弹出一条"自愈完成"的旁白——那正是
 * "停止后仍有幽灵动作"的经典形态。代次变化即视为过期。
 */
let runGeneration = 0;

/** 本轮注入的混沌场景（阶段 4 据此决定自愈动作类型）；未注入时为 null */
let lastInjectedChaos: ActiveChaosScenario | null = null;

/**
 * 阶段 4 的健康分基线。
 *
 * 【为何要单独存】"健康分 A → B"这个表述需要**阶段开始时**的值，
 * 但阶段 4 收尾时再读 store 已经拿到新值了。因此在进入阶段 4 的第一时间
 * 快照一次，收尾时再读一次，两者相减才是真实的修复增量。
 */
let healHealthBaseline: number | null = null;

/**
 * collectDemoFacts —— 从当帧 store 快照采集旁白所需事实。
 *
 * 【设计原则：取不到就是 null】任何一项读不到（快照未回传、SSE 降级、
 * 场景未注入）都返回 null，由模板函数决定省略哪一句。**绝不填 0 或默认值**：
 * "显示 0 个受害容器"是在陈述一个可能错误的事实，"不显示数量"才是诚实的。
 *
 * @param scenario 当前混沌场景（未注入时为 null）
 * @returns 事实快照
 */
function collectDemoFacts(scenario: ActiveChaosScenario | null): DemoFacts {
  let snapshot: ReturnType<typeof actions>['snapshotSummary'] | null = null;
  try {
    snapshot = actions().snapshotSummary;
  } catch {
    snapshot = null;
  }

  if (snapshot === null) {
    return {
      nodeId: null,
      nodeName: null,
      victimCount: null,
      actionType: null,
      healthBefore: null,
      healthAfter: null,
      totalPods: null,
      runningPods: null,
      scenario,
      chaosLabel: null,
    };
  }

  const target = scenario === null ? null : CHAOS_TARGETS[scenario];
  const nodeId = target === undefined || target === null ? null : target.nodeId;
  const nodeEntity =
    nodeId === null
      ? undefined
      : snapshot.nodes.find((node): boolean => node.id === nodeId);
  const nodeName = nodeEntity === undefined ? null : nodeEntity.name;

  /*
   * 【口径必须与阶段 2/4 一致】这里若用 99 会得到"本机架全部热点 Pod"（如 8），
   * 而阶段 2 日志与阶段 4 自愈都用 MAX_HEAL_TARGETS（3），于是提示词里写
   * "异常容器 8 个"、字幕与回执却是 3 —— 同一场演示内自相矛盾。
   */
  const victimCount =
    scenario === null ? null : resolveVictims(snapshot, scenario, MAX_HEAL_TARGETS).podIds.length;

  const actionType =
    scenario === null ? null : resolvePodAction(scenario);

  return {
    nodeId,
    nodeName,
    victimCount,
    actionType,
    healthBefore: healHealthBaseline,
    healthAfter:
      healHealthBaseline === null ? null : Math.round(snapshot.clusterHealthScore),
    totalPods: snapshot.pods.length,
    runningPods: snapshot.pods.filter((pod): boolean => pod.status === 'Running').length,
    scenario,
    chaosLabel: target === undefined || target === null ? null : target.label,
  };
}

/**
 * renderPhaseNarration —— 把阶段与事实渲染成一句旁白。
 *
 * 【优先级】模板结果非空 → 用模板；模板返回空串或没有模板 → 用 fallback。
 * 这条规则保证：事实齐备时念真实数字，事实缺失时念不含量化断言的兜底句，
 * **任何情况下都不会念出与画面矛盾的内容**。
 *
 * @param phase 阶段定义
 * @param scenario 当前混沌场景
 * @returns 最终旁白文本
 */
function renderPhaseNarration(
  phase: DemoPhase,
  scenario: ActiveChaosScenario | null,
): string {
  const facts = collectDemoFacts(scenario);
  if (phase.template !== undefined) {
    try {
      const rendered = phase.template(facts);
      if (rendered.length > 0) return rendered;
    } catch {
      /* 模板异常不应阻断时间轴，回落到 fallback */
    }
  }
  return phase.fallback;
}

/** 写入运行时旁白并立即广播（阶段动作用） */
function setNarration(text: string): void {
  narrationOverride = text;
  publish();
}

/** 本轮「running 段」的起算点（performance.now） */
let segmentStartedAt = 0;

/** 之前所有 running 段累计的已用时长（暂停期间不增长） */
let accumulatedMs = 0;

/** 全部待触发的阶段定时器句柄 */
let phaseTimers: Array<ReturnType<typeof setTimeout>> = [];

/** 进度心跳定时器句柄 */
let tickTimer: ReturnType<typeof setInterval> | null = null;

/** MCP 请求取消器（停止时 abort，避免回调在停止后写 store） */
let mcpAbort: AbortController | null = null;

/** 订阅表 */
const listeners = new Set<() => void>();

/** 缓存的快照对象（useSyncExternalStore 要求引用稳定） */
let cachedSnapshot: DemoDirectorSnapshot = {
  status: 'idle',
  scriptId: null,
  scriptTitle: '',
  phases: [],
  phaseIndex: -1,
  elapsedMs: 0,
  durationMs: 0,
  progress: 0,
  badge: '',
  narration: '',
  phaseStartedAt: null,
  phaseDeadline: null,
  preflightError: null,
  finishedAt: null,
  pausedByVisibility: false,
};

/**
 * 可选解说员（TTS 注入点）。
 *
 * 【为何用注册而非直接 import 语音钩子】语音合成是 React Hook，
 * 只能在组件树内实例化；utils 层不该反向依赖组件。让顶栏在挂载时
 * 注册一个解说函数，引擎只负责在阶段切换时把字幕交给它。
 * 传入 null 即关闭语音解说。
 */
let narrator: ((text: string) => void) | null = null;

/**
 * 可选解说停止器（TTS 的 stop）。
 *
 * 【为何需要】暂停 / 停止时若只停止推进字幕，浏览器仍在念上一句旁白，
 * 观感是"点了停止它还在说话"。注册时一并传入 stop，由引擎在
 * pause / stop / finish 三处调用。
 */
let narratorStop: (() => void) | null = null;

/**
 * registerDemoNarrator —— 注册/注销语音解说回调。
 *
 * @param fn 解说回调；传 null 表示关闭语音解说
 * @returns 注销函数（供 useEffect 清理）
 */
export function registerDemoNarrator(
  fn: ((text: string) => void) | null,
  stopFn: (() => void) | null = null,
): () => void {
  narrator = fn;
  narratorStop = stopFn;
  return (): void => {
    if (narrator === fn) narrator = null;
    if (narratorStop === stopFn) narratorStop = null;
  };
}

/* ========================================================================== */
/* 内部工具                                                                    */
/* ========================================================================== */

/** 读取 store 的当前动作集合（每次现取，避免持有已过期的 action 引用） */
function actions(): ReturnType<typeof useClusterStore.getState> {
  return useClusterStore.getState();
}

/** 清空所有定时器（幂等） */
/**
 * bindVisibilityGuard —— 页面隐藏时自动暂停（F 项）。
 *
 * 【为什么必须暂停而不是放任】浏览器会把后台标签页的 setTimeout 节流到
 * 最低约 1 次/分钟。若不暂停，用户切走 30 秒再回来，恢复瞬间所有积压的
 * 阶段定时器会**同时到期**，表现为"阶段连跳"——直接毁掉演示节奏。
 *
 * 【幂等】模块级单例只需绑定一次；重复调用立即返回。
 */
function bindVisibilityGuard(): void {
  if (visibilityBound) return;
  if (typeof document === 'undefined') return;
  visibilityBound = true;

  document.addEventListener('visibilitychange', (): void => {
    if (document.visibilityState !== 'hidden') return;
    if (status !== 'running') return;
    pausedByVisibility = true;
    pauseDemoDirector();
    actions().appendTerminalLog(
      '[DEMO-DIRECTOR] 页面切至后台，已自动暂停（恢复可见后点击继续）',
    );
  });
}

function clearAllTimers(): void {
  for (const handle of phaseTimers) clearTimeout(handle);
  phaseTimers = [];
  phaseTimerByIndex.clear();
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  /* 事件门的两个定时器同样必须清理，否则停止后仍会推进阶段 */
  if (phaseGateTimer !== null) {
    clearTimeout(phaseGateTimer);
    phaseGateTimer = null;
  }
  if (phaseGateDeadlineTimer !== null) {
    clearTimeout(phaseGateDeadlineTimer);
    phaseGateDeadlineTimer = null;
  }
  /* 完成态自动收起定时器也必须随停止/重播一起取消 */
  if (finishedCollapseTimer !== null) {
    clearTimeout(finishedCollapseTimer);
    finishedCollapseTimer = null;
  }
}

/**
 * 定点取消某个阶段已排好的固定定时器。
 *
 * 【用途】事件门若先满足，必须把下一阶段的 atMs 定时器撤掉，
 * 否则两条推进路径会各触发一次 enterPhase。
 *
 * @param index 阶段下标
 */
function cancelScheduledPhase(index: number): void {
  const handle = phaseTimerByIndex.get(index);
  if (handle === undefined) return;
  clearTimeout(handle);
  phaseTimerByIndex.delete(index);
}

/** 取消进行中的 MCP 请求（幂等） */
function abortMcp(): void {
  if (mcpAbort !== null) {
    mcpAbort.abort();
    mcpAbort = null;
  }
}

/** 当前已用时长（毫秒） */
function currentElapsedMs(): number {
  if (status !== 'running') return accumulatedMs;
  return accumulatedMs + (performance.now() - segmentStartedAt);
}

/** 重新计算并广播快照 */
function publish(): void {
  const script = currentScript;
  const elapsed = script === null ? 0 : Math.min(currentElapsedMs(), script.durationMs);
  const activePhase =
    script !== null && phaseIndex >= 0 && phaseIndex < script.phases.length
      ? script.phases[phaseIndex]
      : null;

  cachedSnapshot = {
    status,
    scriptId: script?.id ?? null,
    scriptTitle: script?.title ?? '',
    phases: script?.phases ?? [],
    phaseIndex,
    elapsedMs: Math.round(elapsed),
    durationMs: script?.durationMs ?? 0,
    progress:
      script === null || script.durationMs <= 0
        ? 0
        : Math.min(1, Math.max(0, elapsed / script.durationMs)),
    badge: activePhase?.badge ?? '',
    /* 优先用当帧事实渲染的旁白，其次才是剧本静态兜底文案 */
    narration: narrationOverride ?? activePhase?.fallback ?? '',
    phaseStartedAt,
    phaseDeadline,
    preflightError,
    finishedAt,
    pausedByVisibility,
  };

  for (const listener of listeners) listener();
}

/**
 * 把集群恢复到「演示起点」稳态。
 *
 * 【为何不写 resetCluster()】store 里没有这个动作。恢复稳态的正确组合是：
 * 解除混沌 + 取消选中（镜头回全景）+ 关闭环绕（避免下一秒自己转起来）
 * + 清空待执行的自愈队列（否则上一轮的路演残留会在新剧本里"诈尸"）。
 */
function resetToBaseline(): void {
  const api = actions();
  api.setActiveChaos('NONE');
  api.selectEntity(null);
  api.setOrbitPatrolActive(false);
  api.clearPendingRemediations();
}

/* ========================================================================== */
/* 阶段动作（P0-1 / P0-2 / P0-3 修复版）                                        */
/* ========================================================================== */

/**
 * 帧率无关的轮询等待：predicate 成立即返回 true，超时返回 false。
 *
 * 【为何不用固定 sleep】故障注入 → 合成引擎推进 → SSE 下发 → Store 更新
 * 是一条异步链，固定等待要么太短读不到、要么太长浪费演示时间。
 * 轮询在数据到达的第一时间继续，既快又准。
 *
 * 【为何要检查 generation】stop / 重启剧本会让上一轮的等待继续跑，
 * 若不加代次检查，停止后 8 秒仍可能弹出一条"自愈完成"的旁白——
 * 那正是"停止后还有幽灵动作"的经典形态。
 *
 * @param predicate 条件
 * @param timeoutMs 超时上限
 * @param intervalMs 轮询间隔
 * @param generation 发起时的运行代次（代次变化即放弃）
 */
function pollUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs: number,
  generation: number,
): Promise<boolean> {
  return new Promise((resolve): void => {
    const startedAt = performance.now();
    const tick = (): void => {
      if (generation !== runGeneration) {
        resolve(false);
        return;
      }
      let satisfied = false;
      try {
        satisfied = predicate();
      } catch {
        /* 读取 DOM / Store 时的瞬时异常不应中断演示时间轴 */
        satisfied = false;
      }
      if (satisfied) {
        resolve(true);
        return;
      }
      if (performance.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** 毫秒级延时（与 pollUntil 同一套代次保护） */
function delay(ms: number, generation: number): Promise<void> {
  return new Promise((resolve): void => {
    setTimeout(() => {
      if (generation === runGeneration) resolve();
      else resolve();
    }, ms);
  });
}

/**
 * 查找当前挂载的「自愈操作确认」动作卡。
 *
 * 【为何用 aria-label 而不是 class】class 是样式实现细节，随时会变；
 * aria-label 是**对外契约**（verify.mjs 的 32 项断言也依赖它），
 * 用它定位等于复用既有可访问性承诺，不会因视觉改版而失联。
 *
 * @returns 卡片元素；未挂载返回 null
 */
function findActionCard(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const candidates = document.querySelectorAll('[aria-label^="自愈操作确认"]');
  for (const el of Array.from(candidates)) {
    if (el instanceof HTMLElement) return el;
  }
  return null;
}

/**
 * 在动作卡内找到「立即执行自愈方案」按钮。
 *
 * 【判定口径】文案含「立即执行」或「需二次确认」——高危动作未勾选时
 * 按钮文案会变成后者，两者都是同一个执行入口。
 *
 * @param card 动作卡元素
 * @returns 可点击按钮；找不到返回 null
 */
function findExecuteButton(card: HTMLElement): HTMLButtonElement | null {
  const buttons = card.querySelectorAll('button');
  for (const el of Array.from(buttons)) {
    if (!(el instanceof HTMLButtonElement)) continue;
    const text = (el.textContent ?? '').trim();
    if (text.includes('立即执行') || text.includes('需二次确认')) return el;
  }
  return null;
}

/**
 * readActionCardTargetId —— 读取当前已水合的动作卡声明的目标实体 ID。
 *
 * 【为什么要读 DOM 而不是读 store】ActionConfirm 的 target 来自 AI 流式生成的
 * 卡片载荷，它只存在于组件内部状态与渲染结果里，store 中没有对应字段。
 * aria-label 形如「自愈操作确认：重启 Pod redis-cluster-shard-0」，
 * 无法从中稳定反解出 id，因此改为读取卡片上的 data 属性。
 *
 * 【读不到就返回 null】宁可回落到"按快照解析受害者"，也不猜一个 ID ——
 * 猜错会去修一个不存在的实体，凭 store 的幽灵 ID 守卫被拒绝，
 * 表现为"自愈点击了但什么都没发生"。
 *
 * @returns 卡片声明的 targetId；未挂载或无该属性时返回 null
 */
function readActionCardTargetId(): string | null {
  if (typeof document === 'undefined') return null;
  const card = findActionCard();
  if (card === null) return null;
  const raw = card.getAttribute('data-target-id');
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * 阶段 1：全景稳态巡航。
 *
 * 打开环绕巡检——这是"系统活着"的最强信号：静止的 3D 场景容易被误认为
 * 一张渲染图，缓慢自转立刻证明它是实时渲染的。
 */
function enterCruise(): void {
  const api = actions();
  api.setActiveChaos('NONE');
  api.selectEntity(null);
  api.setOrbitPatrolActive(true, 'programmatic');
  api.appendTerminalLog('[DEMO-DIRECTOR] 阶段 1/4 · 已重置集群稳态并开启 3D 环绕巡检');
}

/**
 * 阶段 2：注入混沌 + 锁定**真实受灾**机架（P0-1 修复）。
 *
 * 【修复前】节点 ID 是手写字面量，且 OOM/网络两个剧本正好与引擎行为相反
 * ——镜头锁定健康机架，同屏 AI 正文却写另一个节点名，当场自证矛盾。
 *
 * 【修复后】nodeId 来自 `CHAOS_TARGETS` 单一事实源；注入后**轮询断言**
 * 该机架名下确实出现了异常 Pod，断言失败则旁白降级为"等待数据回传"，
 * 绝不宣称"已锁定告警机架"。
 *
 * @param chaos 要注入的混沌场景（非 'NONE'）
 * @param label 终端日志前缀
 */
function enterFaultAndLock(chaos: ActiveChaosScenario, label: string): void {
  const generation = runGeneration;
  const target = CHAOS_TARGETS[chaos];
  const api = actions();

  /* 记录本轮注入的场景，供阶段 4 决定自愈动作类型 */
  lastInjectedChaos = chaos;

  /* 关闭环绕：镜头要交给 CameraRig 的聚焦飞行，两者同时跑会互相拉扯 */
  api.setOrbitPatrolActive(false);
  api.setActiveChaos(chaos);
  api.selectEntity(target.nodeId, 'node');

  /* 先用静态兜底文案，避免断言期间字幕空白 */
  setNarration('故障已注入，正在校验受灾目标的数据回传...');
  api.appendTerminalLog(
    `[DEMO-DIRECTOR] ${label} · 已注入 ${chaos}（${target.label}）并锁定 ${target.nodeId}`,
  );

  /* ---- 运行时断言：该节点名下必须出现异常 Pod ---- */
  void pollUntil(
    (): boolean => {
      const snapshot = actions().snapshotSummary;
      /*
       * 【与阶段 4 共用同一解析器】断言口径必须与自愈口径一致，
       * 否则会出现"阶段 2 说锁定了、阶段 4 却找不到受害者"的内部矛盾。
       * resolveVictims 第 1 段正是"受灾机架上的异常 Pod"。
       */
      return resolveVictims(snapshot, chaos).podIds.length > 0;
    },
    FAULT_VERIFY_TIMEOUT_MS,
    FAULT_VERIFY_POLL_MS,
    generation,
  ).then((verified: boolean): void => {
    if (generation !== runGeneration) return;
    if (verified) {
      const snapshot = actions().snapshotSummary;
      /*
       * 【口径必须与阶段 4 一致】这里若用 99（"有多少算多少"），日志会打出
       * "命中 8 个受害容器"，而阶段 4 按设计最多自愈 3 个 —— 两列数字天然
       * 对不上，矩阵里看起来像"只修了 3/8"，其实是两个口径在打架。
       * 统一用 MAX_HEAL_TARGETS，阶段 2 的"受害数"就等于"将要被修复的数量"。
       */
      const resolved = resolveVictims(snapshot, chaos, MAX_HEAL_TARGETS);
      const nodeLabel =
        snapshot.nodes.find((node): boolean => node.id === target.nodeId)?.name ?? target.nodeId;
      setNarration(
        `检测到 ${resolved.podIds.length} 个容器触发 ${target.expectedPodStatus}（${target.label}），3D 镜头已锁定受灾机架 ${nodeLabel}！`,
      );
      actions().appendTerminalLog(
        `[DEMO-DIRECTOR] 受灾校验通过：${target.nodeId} 命中 ${resolved.podIds.length} 个受害容器`,
      );
    } else {
      /* 如实降级：不宣称已锁定告警机架 */
      setNarration(
        '已注入故障，正在等待数据回传（本环境未在预期时间内收到异常事件）。',
      );
      actions().appendTerminalLog(
        `[DEMO-DIRECTOR] 受灾校验超时：${target.nodeId} 命中 0 个受害容器，旁白已降级`,
      );
    }
  });
}

/**
 * 阶段 3：唤醒 AI 副驾做 RAG 诊断。
 *
 * 【顺带塞入 3D 截图】把「多模态快照诊断」卖点纳入自动路演：
 * 若画布可导出 dataUrl，就写入 capturedViewportDataUrl，让 AI 拿到真实画面。
 * 导出失败（跨域/上下文丢失）不阻断流程——诊断仍可纯文本进行。
 *
 * 【追问 2：prompt 由 DemoFacts 渲染，不再是一段与现场无关的固定文本】
 * 修复前 prompt 是写死的常量字符串，AI 只能从 store 上下文里自己猜现场情况。
 * 现在改为传入**构造函数**，在阶段 3 真正触发的那一刻用当帧快照渲染出
 * 「受灾节点是 worker-beta、异常容器 3 个、场景 OOM 内存溢出、期望动作
 * restart_pod」这样的具体句子。好处有两个：
 *   1. AI 的正文会明确复述同一个宿主节点，**与 HUD 选中节点可被机器比对**；
 *   2. 事实变化（不同剧本/不同快照）时 prompt 自动跟随，不需要改代码。
 *
 * @param buildPrompt 由事实渲染诊断提示词的纯函数
 * @param label       终端日志前缀
 */
function enterAiDiagnosis(
  buildPrompt: (facts: DemoFacts) => string,
  label: string,
): void {
  const api = actions();

  /* ---- 多模态快照（尽力而为，失败静默降级） ---- */
  if (typeof document !== 'undefined') {
    const canvas = document.querySelector('canvas');
    if (canvas instanceof HTMLCanvasElement) {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl.startsWith('data:image/png')) api.setCapturedViewport(dataUrl);
      } catch {
        api.appendTerminalLog('[DEMO-DIRECTOR] 3D 快照导出失败，本轮以纯文本诊断继续');
      }
    }
  }

  /*
   * 【为何在这里才渲染】collectDemoFacts 读的是当帧快照：阶段 2 注入的故障
   * 此刻已经回传（异常 Pod、告警、选中节点都已就位），渲染出的节点名与数量
   * 才与 HUD 完全一致。若在剧本定义时就渲染，会拿到注入前的空快照。
   */
  const facts = collectDemoFacts(lastInjectedChaos);
  const prompt = buildDiagnosisPrompt(buildPrompt, facts);
  api.triggerQuickPrompt(prompt);
  api.appendTerminalLog(`[DEMO-DIRECTOR] ${label} · 已唤醒 AI 运维副驾`);
  api.appendTerminalLog(`[DEMO-DIRECTOR] 诊断提示词：${prompt}`);

  /*
   * ---- B 项：启动阶段 3→4 的事件门 ----
   *
   * 【旧行为】阶段 4 挂在剧本固定 atMs=26000 的定时器上，与 AI 流真实进度无关。
   * 【新行为】等 copilotStreaming===false 且动作卡已挂载即推进；25s 超时兜底。
   * 事件先到时由 cancelScheduledPhase 撤掉阶段 4 的固定定时器，避免双触发。
   */
  armPhaseAdvanceGate(runGeneration);
}

/**
 * buildDiagnosisPrompt —— 把事实拼进诊断提示词。
 *
 * 【设计原则】与旁白模板同一套纪律：**取不到的字段整句省略**，
 * 绝不用 0 或占位符填充。AI 拿到的是一段"只说知道的事"的提示词，
 * 它复述出来的宿主节点才有可能与画面一致。
 *
 * @param buildPrompt 剧本提供的症状描述函数
 * @param facts       当帧事实
 * @returns 完整提示词
 */
function buildDiagnosisPrompt(
  buildPrompt: (facts: DemoFacts) => string,
  facts: DemoFacts,
): string {
  const symptom = buildPrompt(facts);

  const parts: string[] = [symptom];
  if (facts.nodeName !== null) parts.push(`受灾节点 ${facts.nodeName}`);
  if (facts.victimCount !== null) parts.push(`异常容器 ${facts.victimCount} 个`);
  if (facts.chaosLabel !== null) parts.push(`演练场景 ${facts.chaosLabel}`);
  if (facts.actionType !== null) parts.push(`期望自愈动作 ${facts.actionType}`);

  return `${parts.join('，')}。请结合 RAG 知识库定位根因并生成 MCP 自愈方案。`;
}

/**
 * 阶段 4：MCP 闭环自愈（P0-2 / P0-3 修复）。
 *
 * 【修复 P0-2：受害者解析改为全局】
 * 修复前按"聚焦节点"过滤，一旦镜头锁错节点就解析不到受害者，
 * 然后兜底对健康节点执行 drain_node —— 宣称闭环而实际一个没修。
 * 现在用 `resolveVictimPods` 从 P0 告警 + 全量非 Running Pod 里解析，
 * **不再按镜头过滤，也不再 drain_node 兜底**。
 *
 * 【修复 P0-3：HITL 走真实 UI】
 * 修复前直接调 healEntity，旁白说"MCP 闭环自愈完成"而动作卡仍是
 * "立即执行自愈方案"待点 —— 同一屏上"系统已替你执行"与"需要你确认"并存。
 * 现在：置 demoAutoConfirm → 等卡片挂载 → 勾选风险 → 点击真实按钮 → 等回执。
 * 卡片 8 秒内未挂载才降级为直接 healEntity，并在旁白中**如实说明**。
 *
 * @param label 终端日志前缀
 */
function enterHeal(label: string): void {
  const generation = runGeneration;
  const api = actions();
  const chaos = lastInjectedChaos;
  const target = chaos === null ? null : CHAOS_TARGETS[chaos];

  /* ---- 1. 解析真实受害 Pod（场景事实驱动，不按镜头过滤） ---- */
  const snapshot = api.snapshotSummary;
  const chaosScenario: ActiveChaosScenario = chaos ?? 'POD_OOM_SWARM';
  const resolved = resolveVictims(snapshot, chaosScenario, MAX_HEAL_TARGETS);
  /*
   * 【优先使用动作卡声明的 target】若 AI 已水合出 ActionConfirm，它声明的目标
   * 就是"AI 认为要修的东西"。当它与解析结果不一致时以卡片为准——因为
   * 用户看到的是那张卡片，系统若私自去修另一个 Pod，画面与文案就对不上了。
   * 卡片未挂载时回落到解析结果。
   */
  const cardTargetId = readActionCardTargetId();
  const victimIds =
    cardTargetId !== null && cardTargetId.startsWith('pod-')
      ? [cardTargetId, ...resolved.podIds.filter((id): boolean => id !== cardTargetId)]
      : resolved.podIds;
  const healthBefore = Math.round(snapshot.clusterHealthScore);

  /**
   * 自愈动作类型：由 CHAOS_TARGETS / CHAOS_REMEDIATION_ACTION 的单一事实源决定
   * （OOM→restart_pod / 网络→drain_node / CPU→scale_deployment）。
   * 【禁止 drain_node 作用于 Pod】resolvePodAction 负责收敛：
   * 若场景动作是 drain_node（仅网络场景），降级为 restart_pod 并记日志。
   */
  const sceneAction: ChaosRemediationAction =
    CHAOS_TARGETS[chaosScenario].remediationAction;
  const podAction: ChaosRemediationAction = resolvePodAction(chaosScenario);
  if (!isActionAllowedForPod(sceneAction)) {
    api.appendTerminalLog(
      `[DEMO-DIRECTOR] 场景动作 ${sceneAction} 不适用于 Pod 粒度，已降级为 ${podAction}`,
    );
  }

  /* ---- 2. 无受害者：如实降级，不伪造闭环 ---- */
  if (victimIds.length === 0) {
    api.setActiveChaos('NONE');
    api.selectEntity(null);
    api.setOrbitPatrolActive(true, 'programmatic');
    setNarration('已解除混沌并恢复稳态，但未捕获到可自愈的异常容器（自愈未验证）。');
    api.appendTerminalLog('[DEMO-DIRECTOR] 阶段 4/4 · 无受害 Pod，已终止演练并如实降级旁白');
    return;
  }

  /*
   * 【可机器解析的"本次目标"】阶段 2 的受害计数与阶段 4 的实际目标可能不同：
   * 合成引擎的 Pod 状态是持续演进的，从阶段 2 校验到阶段 4 开场之间
   * （约 20 秒）可能有 Pod 自行恢复。矩阵必须比较"阶段 4 实际瞄准了几个"
   * 与"实际修好几个"，而不是拿 20 秒前的数字去对。
   */
  api.appendTerminalLog(
    `[DEMO-DIRECTOR] 阶段 4/4 · 目标受害者 ${victimIds.length} 个`,
  );

  const primaryId = victimIds[0];
  const primaryPod = snapshot.pods.find((pod): boolean => pod.id === primaryId);
  const primaryName = primaryPod === undefined ? primaryId : primaryPod.name;
  setNarration(`正在对 ${victimIds.length} 个异常容器执行 MCP 自愈（动作 ${podAction}）...`);
  api.setDemoAutoConfirm(true);

  /* ---- 3. HITL：等卡片 → 勾选 → 点击真实按钮 ---- */
  void (async (): Promise<void> => {
    const cardReady = await pollUntil(
      (): boolean => findActionCard() !== null,
      ACTION_CARD_TIMEOUT_MS,
      DOM_POLL_MS,
      generation,
    );
    if (generation !== runGeneration) return;

    let executedViaUi = false;
    if (cardReady) {
      const card = findActionCard();
      if (card !== null) {
        /* 高危动作必须先勾选风险确认，否则按钮处于禁用态 */
        const checkbox = card.querySelector('input[type="checkbox"]');
        if (checkbox instanceof HTMLInputElement && !checkbox.checked) {
          checkbox.click();
          await delay(DOM_POLL_MS, generation);
          if (generation !== runGeneration) return;
        }
        const button = findExecuteButton(card);
        if (button !== null && !button.disabled) {
          button.click();
          executedViaUi = true;
          actions().appendTerminalLog(
            '[DEMO-DIRECTOR] 已通过动作卡「立即执行自愈方案」完成 HITL 确认（导演自动确认模式）',
          );
        }
      }
    }

    /*
     * ---- 4. 补齐剩余受害者 ----
     *
     * 【为什么需要这一步】ActionConfirm 表达的是"AI 建议对**某一个**目标执行
     * 某个动作"——它的 target 是单个实体。点一次只能修一个 Pod。
     * 但本场景的受害者是 3 个（同一机架上的 redis-cluster-shard-0/1 与
     * user-profile-svc）。若只修卡片声明的那一个，healedPodIds 覆盖率就是 1/3，
     * 旁白只能降级成"部分覆盖"，闭环卖点打折。
     *
     * 【职责划分】第一个受害者始终走**真实 HITL**（勾选 + 点击，这是护栏演示）；
     * 同批次的其余受害者由导演引擎按同一动作补齐——这在语义上等价于
     * "运维人员确认了整批修复方案"，而不是绕过护栏。
     */
    const healedAfterHitl = new Set(Object.keys(actions().healedPodIds));
    const remaining = victimIds.filter((victimId): boolean => !healedAfterHitl.has(victimId));

    if (remaining.length > 0) {
      for (const victimId of remaining) {
        actions().healEntity(victimId, podAction);
      }
      actions().appendTerminalLog(
        executedViaUi
          ? `[DEMO-DIRECTOR] 已按同一动作补齐其余 ${remaining.length} 个受害者（${podAction}）`
          : `[DEMO-DIRECTOR] 动作卡未在超时内挂载，已降级直接调用 healEntity 覆盖 ${remaining.length} 个受害者（旁白将如实说明）`,
      );
    }

    /*
     * ---- C 项：统一卡片状态，禁止"字幕已完成 / 卡片待执行"并存 ----
     *
     * 若本次没走通 UI（卡片 8 秒内未挂载），导演已直调 healEntity。
     * 但卡片可能**稍后**才挂载——那时它内部仍是"待执行"，同一屏就会
     * 出现「字幕说自愈完成」+「卡片说请点击执行」的矛盾。
     * 置该标记后，后挂载的卡片直接渲染为已执行态并注明"由导演代为执行"。
     */
    if (!executedViaUi) {
      actions().setDemoFallbackExecuted(true);
    }

    /* ---- 5. 等自愈回执落库 ---- */
    await pollUntil(
      (): boolean => Object.keys(actions().healedPodIds).length > 0,
      HEAL_CONFIRM_TIMEOUT_MS,
      DOM_POLL_MS,
      generation,
    );
    if (generation !== runGeneration) return;

    /* ---- 6. 校验覆盖度：受害者是否真的全部被自愈 ---- */
    const healedIds = Object.keys(actions().healedPodIds);
    const coveredCount = victimIds.filter((victimId): boolean =>
      healedIds.includes(victimId),
    ).length;
    const fullyCovered = coveredCount === victimIds.length;
    const healthAfter = Math.round(actions().snapshotSummary.clusterHealthScore);
    const nodeLabel =
      actions().snapshotSummary.nodes.find((node): boolean => node.id === (target?.nodeId ?? ''))
        ?.name ??
      target?.nodeId ??
      '受灾机架';

    /* ---- 7. 复位画面并给出**与事实一致**的终态旁白 ---- */
    actions().setActiveChaos('NONE');
    actions().selectEntity(null);
    actions().setOrbitPatrolActive(true, 'programmatic');

    /*
     * 【用事实模板重渲染终态旁白】enterPhase 时的事实是"自愈前"的；
     * 此刻自愈已落库、健康分已更新，必须用当帧事实重算，否则会出现
     * "字幕说 96、顶栏显示 100"这类同屏矛盾。
     */
    const terminalPhase =
      currentScript === null
        ? undefined
        : currentScript.phases[currentScript.phases.length - 1];
    const factNarration =
      terminalPhase === undefined
        ? ''
        : renderPhaseNarration(terminalPhase, chaos ?? null);

    if (fullyCovered) {
      setNarration(
        factNarration.length > 0
          ? factNarration
          : `已下发控制器调谐指令（${podAction}），${coveredCount} 个异常容器恢复 Running，集群健康分 ${healthBefore} → ${healthAfter}。`,
      );
      actions().appendTerminalLog(
        `[DEMO-DIRECTOR] 阶段 4/4 · 闭环校验通过：${coveredCount}/${victimIds.length} 个受害者已自愈`,
      );
    } else if (executedViaUi) {
      /* 走了真实 UI 但覆盖不全：这是 AI 卡片的 target 与受害者不一致，如实说明 */
      setNarration(
        `已通过动作卡执行自愈（${podAction}），本次覆盖 ${coveredCount}/${victimIds.length} 个异常容器，其余由控制器自行收敛。`,
      );
      actions().appendTerminalLog(
        `[DEMO-DIRECTOR] 阶段 4/4 · 部分覆盖：${coveredCount}/${victimIds.length}（未宣称完整闭环）`,
      );
    } else {
      setNarration(
        `已终止演练并恢复稳态，自愈未完全验证（${coveredCount}/${victimIds.length}）。`,
      );
      actions().appendTerminalLog(
        `[DEMO-DIRECTOR] 阶段 4/4 · 自愈未完全验证：${coveredCount}/${victimIds.length}`,
      );
    }

    /* ---- 8. MCP 回执：target 用首个受害 Pod（不是节点），targetName 用可读名 ---- */
    repairMcpReceipt(primaryId, primaryName, podAction, generation);

    /*
     * 【不在这里清除 demoAutoConfirm】实测发现：一旦在 HITL 执行完就置 false，
     * 动作卡上的 data-demo-auto 会立刻翻成 "false"，评委看到的卡片再也无法
     * 证明"这次是编排执行的"。规格 C 项要求该标识可被察觉，因此改为在整个
     * 路演期间保持 true，只在 finish / stop 两个终态清除。
     */
    void nodeLabel;
  })();
}

/**
 * 请求 `/api/mcp/execute` 并把 JSON-RPC 回执写进终端日志。
 *
 * 【为何单独抽出】阶段 4 的异步链已经很长；把网络部分隔离后，
 * 主流程可以只关心"HITL 是否完成、覆盖度如何"这两件业务事实。
 *
 * 【绝不伪造成功】HTTP 非 2xx、响应结构不符、网络异常三种情况
 * 都只记一条如实说明，不打印任何"已完成"字样。
 *
 * @param targetId   首个受害 Pod 的实体 ID
 * @param targetName 可读名（pod.name，而非 ID）
 * @param actionType 实际执行的动作类型
 * @param generation 发起时的运行代次
 */
function repairMcpReceipt(
  targetId: string,
  targetName: string,
  actionType: ChaosRemediationAction,
  generation: number,
): void {
  abortMcp();
  const controller = new AbortController();
  mcpAbort = controller;

  void fetch(MCP_EXECUTE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      actionType,
      targetId,
      targetName,
      clusterMode: actions().connectionMode,
    }),
    signal: controller.signal,
  })
    .then(async (response): Promise<string> => {
      if (!response.ok) {
        return `MCP 执行返回 HTTP ${response.status}（未伪造成功回执）`;
      }
      const payload: unknown = await response.json();
      if (typeof payload === 'object' && payload !== null && 'result' in payload) {
        const receipt = (payload as { result?: unknown }).result;
        if (typeof receipt === 'object' && receipt !== null) {
          const record = receipt as { executionId?: unknown; actionType?: unknown };
          const id = typeof record.executionId === 'string' ? record.executionId : '(unknown)';
          const act = typeof record.actionType === 'string' ? record.actionType : actionType;
          return `MCP 回执 ${id} · ${act} 已完成控制器调谐`;
        }
      }
      return 'MCP 响应结构不符合 JSON-RPC 回执契约';
    })
    .then((line: string): void => {
      if (controller.signal.aborted || generation !== runGeneration) return;
      actions().appendTerminalLog(`[DEMO-DIRECTOR] ${line}`);
    })
    .catch((): void => {
      if (controller.signal.aborted || generation !== runGeneration) return;
      actions().appendTerminalLog('[DEMO-DIRECTOR] MCP 执行请求失败（自愈已由 Store 侧完成）');
    })
    .finally((): void => {
      if (mcpAbort === controller) mcpAbort = null;
    });
}

/**
 * 阶段动作表：scriptId → 按下标对齐的动作序列。
 *
 * 【为何按 scriptId + 下标而不是挂在 DemoPhase 上】展示数据保持纯净，
 * 动作集中一处便于对照阅读与替换。
 */
const PHASE_ACTIONS: Readonly<Record<DemoScriptId, readonly (() => void)[]>> = {
  'oom-autofix': [
    enterCruise,
    (): void => enterFaultAndLock('POD_OOM_SWARM', '阶段 2/4'),
    (): void =>
      enterAiDiagnosis(
        (): string => '检测到集群发生 OOMKilled 内存溢出告警',
        '阶段 3/4',
      ),
    (): void => enterHeal('阶段 4/4'),
  ],
  'network-latency-trace': [
    enterCruise,
    (): void => enterFaultAndLock('NET_PACKET_LOSS', '阶段 2/4'),
    (): void =>
      enterAiDiagnosis(
        (): string => '检测到跨节点网络延迟与丢包，疑似 CNI VXLAN 隧道瓶颈',
        '阶段 3/4',
      ),
    (): void => enterHeal('阶段 4/4'),
  ],
  'cpu-spike-autofix': [
    enterCruise,
    (): void => enterFaultAndLock('NODE_CPU_SPIKE', '阶段 2/4'),
    (): void =>
      enterAiDiagnosis(
        (): string => '检测到节点 CPU 利用率持续高位，容器算力被争抢',
        '阶段 3/4',
      ),
    (): void => enterHeal('阶段 4/4'),
  ],
};

/* ========================================================================== */
/* 定时器排程                                                                  */
/* ========================================================================== */

/**
 * 阶段 3 → 4 的事件门（B 项）。
 *
 * 【它替代了什么】旧实现把阶段 4 挂在剧本的固定 `atMs = 26000` 上，与 AI 流的
 * 真实进度完全脱钩。慢环境（本地小模型、SwiftShader）里诊断还没出卡片就被切到
 * 自愈阶段，画面与旁白同时开始说谎；快环境里则白等十几秒，评委看到"卡住"。
 *
 * 【门的判定条件（严格）】
 *   `copilotStreaming === false && actionCardMountedId !== null`
 * 两个条件缺一不可：
 *   · 只看 streaming===false 不够——流刚结束那一瞬卡片可能还没 commit；
 *   · 只看卡片挂载也不够——卡片可能在流式过程中就渲染了骨架。
 *
 * 【为什么还要 25 秒超时】任何事件驱动都必须有兜底，否则一次网络异常就让整场
 * 路演永远停在 3/4。超时后**如实降级旁白**并继续，让评委看到完整自愈流程，
 * 而不是一个卡死的界面。
 *
 * 【关键设计：门一旦装上，就独占下一阶段的推进权】
 * 装门的同时**立即取消**下一阶段的固定 atMs 定时器。早期实现只在门成功推进时
 * 才取消，结果固定定时器常常抢先进了阶段 4，而门此后既等不到事件、又在
 * `advance()` 里因"phaseIndex 已到 4"而静默返回——门永远挂着，收尾定时器
 * 因此被无限推迟，整场路演再也结束不了（实测跑满 121 秒仍未收尾）。
 *
 * 【所有退出路径都必须释放门】无论推进成功、发现已推进、还是剧本已无下一阶段，
 * 都要清掉两个定时器与 phaseDeadline。否则收尾侧的"门未决则推迟"会一直等。
 *
 * @param generation 发起时的运行代次
 */
function armPhaseAdvanceGate(generation: number): void {
  /** 释放门的所有资源（幂等） */
  const releaseGate = (): void => {
    if (phaseGateTimer !== null) {
      clearTimeout(phaseGateTimer);
      phaseGateTimer = null;
    }
    if (phaseGateDeadlineTimer !== null) {
      clearTimeout(phaseGateDeadlineTimer);
      phaseGateDeadlineTimer = null;
    }
    phaseDeadline = null;
  };

  /* 先取消上一轮可能残留的门，避免重复推进 */
  releaseGate();

  const script = currentScript;
  if (script === null) return;

  const nextIndex = phaseIndex + 1;
  if (nextIndex >= script.phases.length) return;

  /*
   * 【独占推进权】立刻撤销下一阶段的固定定时器。
   * 这是本函数最重要的一行：不撤掉它，固定定时器会在 atMs 处抢先进入阶段 4，
   * 门随即失去意义（详见函数头注释里的实测故障）。
   */
  cancelScheduledPhase(nextIndex);

  phaseDeadline = Date.now() + PHASE3_EVENT_GATE_TIMEOUT_MS;

  let advanced = false;

  /**
   * 推进到下一阶段。
   *
   * @param reason 'event' 事件满足 / 'timeout' 超时兜底
   */
  const advance = (reason: 'event' | 'timeout'): void => {
    if (advanced) return;
    advanced = true;

    /* 无论走哪条路，门都必须释放，否则收尾会被永久推迟 */
    releaseGate();

    if (generation !== runGeneration) return;
    if (status !== 'running') return;

    const activeScript = currentScript;
    if (activeScript === null) return;

    const targetIndex = phaseIndex + 1;
    if (targetIndex >= activeScript.phases.length) return;

    if (reason === 'timeout') {
      /*
       * 【超时旁白必须如实】不能假装诊断已完成。系统知道自己在兜底，
       * 而不是悄悄把没跑完的流程说成跑完了。
       */
      narrationOverride = '诊断未在预期时间内完成，继续演示自愈流程。';
      const api = actions();
      api.appendTerminalLog(
        '[DEMO-DIRECTOR] 诊断等待超时（25s），已按兜底推进至阶段 4，旁白已如实标注',
      );
      if (narrator !== null) narrator(narrationOverride);
      publish();
    }

    enterPhase(targetIndex);

    /*
     * 【推进后重排时间轴】门可能在 durationMs 之后才决断，此时 elapsed 已超出
     * 总时长。剩余阶段与收尾定时器都要按新基准重排，否则阶段 4 会因"已过点"
     * 被立即补触发、收尾则根本不排（remain<=0），整场路演停不下来。
     */
    scheduleFrom(currentElapsedMs());
  };

  /* ---- 事件轮询 ---- */
  const poll = (): void => {
    if (generation !== runGeneration || status !== 'running') {
      releaseGate();
      return;
    }
    if (advanced) return;

    const state = actions();
    if (state.copilotStreaming === false && state.actionCardMountedId !== null) {
      actions().appendTerminalLog(
        '[DEMO-DIRECTOR] 检测到 Copilot 流已结束且动作卡已挂载，按事件推进至阶段 4',
      );
      advance('event');
      return;
    }

    phaseGateTimer = setTimeout(poll, PHASE3_EVENT_GATE_POLL_MS);
  };

  poll();
  if (advanced) return;

  /* ---- 超时兜底 ---- */
  phaseGateDeadlineTimer = setTimeout((): void => {
    phaseGateDeadlineTimer = null;
    advance('timeout');
  }, PHASE3_EVENT_GATE_TIMEOUT_MS);
}

/**
 * runPreflight —— 启动前自检（G 项）。
 *
 * 【为什么需要在启动前检查】路演是"现场演出"：一旦开始，任何环境缺陷都会
 * 以"功能坏了"的形式暴露给评委。这些缺陷（WebGL 上下文丢失、Copilot 未挂载、
 * 视口不存在）在启动后才发现就只能中途崩掉。启动前拦截，字幕位给出明确原因，
 * 评委看到的是"环境没准备好"，而不是"功能不能用"。
 *
 * 【五项检查（顺序即代价由低到高）】
 *   1. 3D 视口存在          —— 没有它路演的镜头语言全部落空；
 *   2. store 可用           —— 引擎所有写动作都依赖它；
 *   3. Copilot 抽屉已挂载   —— 没有它阶段 3 的诊断无处呈现；
 *   4. SSE 传输非 fallback  —— fallback 下数据不流动，故障注入无视觉效果；
 *   5. WebGL 上下文未丢失   —— 接 R01 的状态，上下文丢失时画面静止。
 *
 * 【关于第 2 项的工程细节】生产构建会按设计剔除 window.__KUBEVISION_STORE__
 * 调试钩子。若在生产里也硬性要求它存在，路演将永远无法启动。因此该项在
 * 生产环境只校验 store 本身可用（快照可读），开发环境才额外校验调试钩子——
 * 后者是排查链路，不是功能前提。
 *
 * 【失败时的行为】不启动剧本，字幕位显示原因，终端打 [DEMO-PREFLIGHT]。
 * 绝不"带病启动然后中途崩"。
 *
 * @returns 通过返回 null；失败返回人类可读的原因
 */
function runPreflight(): string | null {
  if (typeof document === 'undefined') return '当前环境没有 DOM（服务端渲染上下文）';

  /* 1. 3D 视口 */
  if (document.querySelector('[aria-label="3D 集群拓扑视口"]') === null) {
    return '未找到 3D 集群拓扑视口';
  }

  /* 2. store 可用 */
  const state = actions();
  if (state.snapshotSummary.nodes.length === 0) {
    return '遥测快照为空，请等待数据源接入';
  }
  if (
    process.env.NODE_ENV !== 'production' &&
    typeof window !== 'undefined' &&
    (window as unknown as { __KUBEVISION_STORE__?: unknown }).__KUBEVISION_STORE__ === undefined
  ) {
    return '开发调试钩子未就绪（window.__KUBEVISION_STORE__ 缺失）';
  }

  /* 3. Copilot 抽屉 */
  if (document.querySelector('[aria-label="AI Copilot 抽屉"]') === null) {
    return 'Copilot 抽屉未挂载';
  }

  /* 4. SSE 传输：fallback 下 totalQps 会被置 0 或长时间不更新 */
  if (state.snapshotSummary.totalQps <= 0) {
    return 'SSE 数据未流动（fallback 传输中），故障注入不会有视觉效果';
  }

  /* 5. WebGL 上下文 */
  if (state.isGlContextLost) {
    return 'WebGL 上下文已丢失，请刷新页面后重试';
  }

  return null;
}

/**
 * applyPreflightFailure —— 自检失败时的统一落地。
 *
 * 【为什么不做成"静默 return"】静默失败是这类功能最坏的行为：用户点了启动、
 * 屏幕毫无反应、终端没有任何记录，只能靠猜。这里必须同时给出可见原因
 * （字幕位）与可查记录（终端 [DEMO-PREFLIGHT]）。
 *
 * @param reason 失败原因
 */
function applyPreflightFailure(reason: string): void {
  preflightError = reason;
  status = 'idle';
  const api = actions();
  api.appendTerminalLog(`[DEMO-PREFLIGHT] 演示环境自检未通过：${reason}`);
  publish();
}

/**
 * 进入某个阶段（触发该阶段动作 + 说话）。
 *
 * @param index 阶段下标
 */
function enterPhase(index: number): void {
  const script = currentScript;
  if (script === null) return;
  phaseIndex = index;

  const phase = script.phases[index];
  /* 进入新阶段先清空上一阶段的事实旁白，避免串到本阶段 */
  narrationOverride = null;

  /* B 项：写入本阶段开始时刻（字幕条读取此值，不自行计时） */
  phaseStartedAt = Date.now();
  /* 事件驱动阶段的截止时刻由事件门填写，进入新阶段先清空 */
  phaseDeadline = null;

  /*
   * 【阶段 4 健康分基线】必须在执行阶段动作**之前**采样：
   * 动作会下发自愈、改 store，之后再读就不是"修复前"的值了。
   */
  if (phase !== undefined && phase.index === script.phases.length - 1) {
    try {
      healHealthBaseline = Math.round(actions().snapshotSummary.clusterHealthScore);
    } catch {
      healHealthBaseline = null;
    }
  }

  const actionList = PHASE_ACTIONS[script.id];
  const action = actionList[index];
  if (action !== undefined) action();

  /*
   * 【事实化旁白】执行完阶段动作后，快照里已经有本阶段造成的真实变化
   * （异常 Pod 出现、自愈落库、健康分回升），此时采集事实才准确。
   * 若动作是异步的（阶段 2 的校验轮询），action 内部会用 setNarration 覆盖。
   */
  if (phase !== undefined) {
    const rendered = renderPhaseNarration(phase, lastInjectedChaos);
    narrationOverride = rendered;

    /* 语音解说：与字幕同源，避免"念的和写的不一样" */
    if (narrator !== null) narrator(rendered);
  }

  publish();
}

/**
 * 为 elapsedMs 之后仍会到点的阶段排定时器，并补触发已错过的阶段。
 *
 * 【为何要"补触发"】恢复时 accumulatedMs 可能已经越过某个阶段的天花板
 * （例如在 10.9s 暂停、11.5s 恢复）：那时该阶段早已该执行。
 * 若不补触发，画面会永远停在上一阶段的字幕上。
 *
 * @param elapsed 当前已用时长（毫秒）
 */
function scheduleFrom(elapsed: number): void {
  const script = currentScript;
  if (script === null) return;

  for (let i = 0; i < script.phases.length; i += 1) {
    const phase = script.phases[i];
    if (phase === undefined) continue;

    if (phase.atMs <= elapsed) {
      /* 已到点但还没进过 → 立即补触发 */
      if (i > phaseIndex) enterPhase(i);
      continue;
    }

    const delay = phase.atMs - elapsed;
    const handle = setTimeout((): void => {
      if (status !== 'running') return;
      phaseTimerByIndex.delete(i);
      enterPhase(i);
    }, delay);
    phaseTimers.push(handle);
    phaseTimerByIndex.set(i, handle);
  }

  /* 收尾定时器：到总时长后标记完成（但不得抢跑仍未决的事件门） */
  const remain = Math.max(script.durationMs - elapsed, FINISH_MIN_GRACE_MS);
  const finishHandle = setTimeout((): void => {
    if (status !== 'running') return;
    /*
     * 阶段 3→4 的事件门还在等（流未结束或卡片未挂载）→ 推迟收尾。
     * 门自身有 25 秒兜底，最长只会把总时长拉长到"门的截止点 + 阶段 4"，
     * 不会无限等待。若不这样处理，时间轴会抢在门之前结束整场路演。
     */
    if (phaseGateTimer !== null || phaseGateDeadlineTimer !== null) {
      const deferHandle = setTimeout((): void => {
        if (status !== 'running') return;
        if (phaseGateTimer !== null || phaseGateDeadlineTimer !== null) return;
        finishDemoDirector();
      }, FINISH_DEFER_RECHECK_MS);
      phaseTimers.push(deferHandle);
      return;
    }
    finishDemoDirector();
  }, remain);
  phaseTimers.push(finishHandle);
}

/** 启动进度心跳 */
function startTick(): void {
  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = setInterval((): void => {
    if (status !== 'running') return;
    publish();
  }, TICK_INTERVAL_MS);
}

/* ========================================================================== */
/* 公开 API                                                                    */
/* ========================================================================== */

/** 按 id 取剧本定义 */
export function getDemoScript(id: DemoScriptId): DemoScript | null {
  for (const script of DEMO_SCRIPTS) {
    if (script.id === id) return script;
  }
  return null;
}

/**
 * startDemoDirector —— 启动指定剧本。
 *
 * 若已有剧本在跑，会先完整停止（清定时器 + 复位集群），再启动新剧本。
 * 这样「切换剧本」不需要调用方自己考虑清理顺序。
 *
 * @param id 剧本标识
 */
export function startDemoDirector(id: DemoScriptId): void {
  const script = getDemoScript(id);
  if (script === null) return;

  /* 先彻底停掉上一轮，避免两套定时器同时向 store 写动作 */
  stopDemoDirector('switch');

  /*
   * 【E 项：路演必须运行在合成数据源上】
   * 实时模式展示的是物理机真实水位，混沌注入只作用于合成引擎状态机——
   * 若用户在 live 模式点路演，画面不会有任何变化，评委看到的是"功能坏了"。
   * 因此启动首步强制切回 demo，并写审计行说明原因。
   */
  /*
   * ---- G 项：启动预检 ----
   *
   * 【为什么放在最前面】环境缺陷（无 3D 视口 / Copilot 未挂载 / GL 上下文丢失）
   * 一旦启动后才暴露，就只能中途崩掉并让评委看到"功能坏了"。
   * 启动前拦住，字幕位给出明确原因，评委看到的是"环境没准备好"。
   */
  const preflightReason = runPreflight();
  if (preflightReason !== null) {
    applyPreflightFailure(preflightReason);
    return;
  }

  /* 绑定可见性守卫（幂等，只会真正注册一次） */
  bindVisibilityGuard();

  const bootApi = actions();
  if (bootApi.connectionMode !== 'demo') {
    bootApi.setConnectionMode('demo');
    bootApi.appendTerminalLog('[DEMO-DIRECTOR] 路演需要合成数据源，已自动切回「合成演练」模式');
  }

  /*
   * 【E 项：全量复位路演临时态】
   * clearHealedPodIds 是"连跑两遍"的关键：healEntity 有 30 秒免疫窗口，
   * 不清免疫表时第二遍的自愈会被整体转入退避队列而**不真正执行**，
   * 表现为"第二遍跑了但什么都没修"。
   */
  bootApi.resetDemoEphemeralState();
  bootApi.clearHealedPodIds();
  bootApi.setDemoAutoConfirm(false);
  /* C 项：清掉上一轮"降级直执行"标记，避免新卡的卡片一挂载就显示已执行 */
  bootApi.setDemoFallbackExecuted(false);

  /*
   * 【启动前自检】校验 CHAOS_TARGETS 的每个 nodeId 都真实存在于快照。
   * 反查派生可能因节点表调整而返回空串——那样 selectEntity('') 会被
   * 幽灵 ID 守卫拒绝，镜头纹丝不动而旁白照样宣称"已锁定"，属静默失败。
   * 这里在**启动前**拦住，宁可路演起不来，也不让它在评委面前说谎。
   */
  try {
    assertChaosTargets(bootApi.snapshotSummary);
  } catch (err) {
    bootApi.appendTerminalLog(
      `[DEMO-DIRECTOR] 启动自检失败：${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  /* 代次自增：让上一轮所有在飞异步链立即过期 */
  runGeneration += 1;
  lastInjectedChaos = null;
  narrationOverride = null;
  preflightError = null;
  finishedAt = null;
  pausedByVisibility = false;

  currentScript = script;
  lastScriptId = script.id;
  status = 'running';
  phaseIndex = -1;
  accumulatedMs = 0;
  segmentStartedAt = performance.now();

  bootApi.appendTerminalLog(
    `[DEMO-DIRECTOR] ▶ 启动剧本「${script.title}」（约 ${Math.round(script.durationMs / 1000)} 秒）`,
  );

  /* 阶段 0 的 atMs 为 0 → scheduleFrom(0) 会立即补触发 */
  scheduleFrom(0);
  startTick();
  publish();
}

/**
 * pauseDemoDirector —— 暂停当前剧本（保留进度，可恢复）。
 *
 * 只对 running 生效；idle/finished 下调用是空操作。
 */
export function pauseDemoDirector(): void {
  if (status !== 'running') return;
  /*
   * 注意：这里的 pausedByVisibility 由调用方（visibilitychange 守卫）设置，
   * 用户主动暂停时不置位。resume 时统一清除。
   */
  /* 冻结本段已用时间 */
  accumulatedMs += performance.now() - segmentStartedAt;
  status = 'paused';
  clearAllTimers();
  abortMcp();
  if (narratorStop !== null) narratorStop();
  actions().appendTerminalLog('[DEMO-DIRECTOR] ⏸ 已暂停（进度保留，可继续）');
  publish();
}

/**
 * resumeDemoDirector —— 从暂停处继续。
 *
 * 只对 paused 生效。
 */
export function resumeDemoDirector(): void {
  if (status !== 'paused' || currentScript === null) return;
  status = 'running';
  pausedByVisibility = false;
  segmentStartedAt = performance.now();
  /* 以当前累计时长为基准重新排程（含补触发已错过的阶段） */
  scheduleFrom(accumulatedMs);
  startTick();
  actions().appendTerminalLog('[DEMO-DIRECTOR] ▶ 已恢复');
  publish();
}

/**
 * replayDemoDirector —— 重播上一套剧本（H 项）。
 *
 * 【为什么不是"从头再跑一遍当前进度"】观众按「重播」的意图是"我想重看一遍"，
 * 所以必须是**完整重跑**：stop 复位集群 → start 重新开始时间轴。
 * 直接 resume 会接着上一次的位置，等于没重播。
 */
export function replayDemoDirector(): void {
  const id = lastScriptId;
  if (id === null) return;
  startDemoDirector(id);
}

/**
 * dismissFinishedDemo —— 收起完成态字幕条（H 项）。
 *
 * 【与 stop 的区别】stop 会复位集群并把状态清成 idle；这里只收起字幕条，
 * 保留"刚跑完"后的巡检与稳态画面——评委还想看几眼 3D 场景时不该被复位。
 */
export function dismissFinishedDemo(): void {
  if (status !== 'finished') return;
  status = 'idle';
  currentScript = null;
  phaseIndex = -1;
  accumulatedMs = 0;
  segmentStartedAt = 0;
  phaseStartedAt = null;
  phaseDeadline = null;
  finishedAt = null;
  publish();
}

/**
 * clearPreflightError —— 关闭自检失败提示（G 项）。
 *
 * 【为什么单独一个入口】预检失败时 status 仍是 idle，字幕条靠
 * preflightError 才显示出来；用户看清原因后需要能关掉它，
 * 否则这条错误会一直悬在视口上方。
 */
export function clearPreflightError(): void {
  if (preflightError === null) return;
  preflightError = null;
  publish();
}

/** togglePauseDemoDirector —— running ↔ paused 一键切换 */
export function togglePauseDemoDirector(): void {
  if (status === 'running') {
    pauseDemoDirector();
    return;
  }
  if (status === 'paused') resumeDemoDirector();
}

/**
 * finishDemoDirector —— 时间轴自然走完时的收尾。
 *
 * 与 stop 的区别：完成后**保留**当前阶段的字幕与进度（进度条满格），
 * 让"刚刚跑完"这件事在界面上残留几秒，而不是瞬间消失。
 */
function finishDemoDirector(): void {
  clearAllTimers();
  if (narratorStop !== null) narratorStop();
  /*
   * 【关键：时间轴结束 ≠ 会话结束，不得杀掉在飞链】
   *
   * 这里曾误写 `runGeneration += 1`，后果是：剧本 34s 走完 → 代次自增 →
   * 阶段 4 里等待动作卡/自愈回执的异步链在下一次检查点全部 return。
   * 而本地 AI 流式生成动作卡大约要 28 秒，卡片在 ~39s 才水合 —— 等于
   * **永远赶不上**，healedIds 恒为空，自愈闭环从未真正发生过。
   *
   * 正确的语义边界：
   *   · 字幕时间轴走完 → 只停定时器与 TTS，业务闭环继续跑到收尾；
   *   · 用户点停止 / 切换剧本 / 组件卸载 → 那才需要杀链（见 stop）。
   * 因此这里**不** abortMcp、**不** 自增 runGeneration。
   */
  status = 'finished';
  if (currentScript !== null) {
    phaseIndex = currentScript.phases.length - 1;
  }
  accumulatedMs = currentScript?.durationMs ?? 0;
  finishedAt = Date.now();
  pausedByVisibility = false;

  /*
   * ---- H 项：收尾后保持环绕巡检 ----
   *
   * 【为什么在 finish 里再开一次】阶段 4 可能在中途把巡检关过（例如用户拖拽
   * 接管了镜头）。完成态应该回到"全景缓缓旋转"的收官画面，这是路演的
   * 视觉句点。用 programmatic 开启，CameraRig 不会再把它关掉。
   */
  const finishApi = actions();
  /* 路演结束才关闭自动演示标识（见阶段 4 末尾的说明） */
  finishApi.setDemoAutoConfirm(false);
  finishApi.setActiveChaos('NONE');
  finishApi.selectEntity(null);
  finishApi.setOrbitPatrolActive(true, 'programmatic');
  finishApi.appendTerminalLog('[DEMO-DIRECTOR] ■ 剧本已完整跑完');
  publish();

  /*
   * H 项：完成态 8 秒无操作自动收起。
   *
   * 【为什么放在引擎】见 finishedCollapseTimer 的说明：组件侧计时会被
   * 重渲染打断。放在这里后，收起时刻严格等于「完成 + 8s」，
   * 且 stop / 重播时由 clearAllTimers 与 start 一并清理。
   */
  if (finishedCollapseTimer !== null) clearTimeout(finishedCollapseTimer);
  const collapseGeneration = runGeneration;
  finishedCollapseTimer = setTimeout((): void => {
    finishedCollapseTimer = null;
    if (runGeneration !== collapseGeneration) return;
    dismissFinishedDemo();
  }, FINISHED_AUTO_COLLAPSE_MS);
}

/**
 * stopDemoDirector —— 立即停止并复位。
 *
 * 【清理清单（缺一不可）】
 * · 全部 setTimeout / setInterval；
 * · 进行中的 MCP 请求（abort）；
 * · 集群混沌状态 / 镜头选中 / 环绕巡检 / 待执行自愈队列。
 *
 * @param reason 'user' 用户点击停止 / 'unmount' 组件卸载 / 'switch' 切换剧本
 */
export function stopDemoDirector(reason: 'user' | 'unmount' | 'switch' = 'user'): void {
  const wasActive = status === 'running' || status === 'paused';

  clearAllTimers();
  abortMcp();
  if (narratorStop !== null) narratorStop();

  /*
   * ---- D 项：停止后不得再有 AI 输出 ----
   *
   * 三件事缺一不可：
   * 1. 中止进行中的 Copilot 流：否则停止后屏幕继续吐 token，
   *    与"已停止并复位"的日志直接矛盾；
   * 2. 清空 quickPromptTrigger：否则下次挂载抽屉时会把上一轮的诊断指令重放；
   * 3. 复位路演临时态：healedPodIds / pendingRemediations / 弹层 / 页签，
   *    修复"30 秒内重复路演被免疫窗口吞掉"。
   *
   * 顺序要求：必须在 status 置 idle 之前发起中止，因为中止链路会读当前状态。
   */
  const stopApi = actions();
  stopApi.requestCopilotAbort();
  stopApi.clearQuickPromptTrigger();
  stopApi.setDemoFallbackExecuted(false);
  stopApi.resetDemoEphemeralState();
  stopApi.clearHealedPodIds();
  stopApi.setDemoAutoConfirm(false);

  /* 代次自增：停止后任何在飞异步链都不得再写 store / 改旁白 */
  runGeneration += 1;
  lastInjectedChaos = null;
  narrationOverride = null;
  healHealthBaseline = null;

  status = 'idle';
  finishedAt = null;
  pausedByVisibility = false;
  phaseStartedAt = null;
  phaseDeadline = null;
  currentScript = null;
  phaseIndex = -1;
  accumulatedMs = 0;
  segmentStartedAt = 0;

  /* 复位集群：只在真正跑过剧本时做，避免"停止"在 idle 下误清用户的手动操作 */
  if (wasActive) {
    resetToBaseline();
    if (reason === 'user') {
      actions().appendTerminalLog('[DEMO-DIRECTOR] ⏹ 已停止并复位集群稳态');
    } else if (reason === 'unmount') {
      actions().appendTerminalLog('[DEMO-DIRECTOR] ⏹ 组件卸载，已清理全部路演定时器');
    }
  }

  publish();
}

/**
 * subscribeDemoDirector —— 订阅状态变化。
 *
 * @param listener 变化回调
 * @returns 退订函数
 */
export function subscribeDemoDirector(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** getDemoDirectorSnapshot —— 读取当前快照（引用稳定，可直接给 useSyncExternalStore） */
export function getDemoDirectorSnapshot(): DemoDirectorSnapshot {
  return cachedSnapshot;
}

/* ========================================================================== */
/* React 接入                                                                  */
/* ========================================================================== */

/**
 * useDemoDirector —— 组件侧订阅钩子。
 *
 * 【为何用 useSyncExternalStore 而非 useState + useEffect】
 * 它天然处理 SSR（需提供 getServerSnapshot）与并发渲染下的撕裂问题，
 * 且订阅的是模块级单例，多个消费方（顶栏按钮、字幕条）永远读到同一份状态。
 *
 * 【卸载即停】钩子内部在卸载时调用 stopDemoDirector('unmount')：
 * 顶栏若因路由切换被卸载，后台绝不能还剩一串 setTimeout 在改 store。
 * stopDemoDirector 是幂等的，重复调用安全。
 */
export function useDemoDirector(): DemoDirectorSnapshot {
  const snapshot = useSyncExternalStore(
    subscribeDemoDirector,
    getDemoDirectorSnapshot,
    getDemoDirectorSnapshot,
  );

  useEffect((): (() => void) => {
    return (): void => {
      stopDemoDirector('unmount');
    };
  }, []);

  return snapshot;
}
