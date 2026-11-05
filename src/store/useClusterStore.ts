'use client';

/**
 * KubeVision AI — 集群响应式 UI 状态 Store（双轨状态管理 · 轨道二：低频响应轨）
 *
 * 【设计意图】（AGENTS.md 第 3 条 + 第 4 条）
 * 本 Store 只承载**低频 UI 状态**（选中态、面板开关、终端日志、审计累计等），
 * 高频遥测数值一律走轨道一瞬态引用池（useTelemetryRef.ts），二者以
 * snapshotSummary（≥1s 节流整体替换）为唯一交汇点，互不越界：
 *   - 60FPS 渲染数据 → Float32Array 原地突变，零 React 重渲染；
 *   - 用户交互状态 → zustand 细粒度订阅，按需重渲染。
 *
 * 【SSR 水合安全三重防护】
 * 1. 文件首行 'use client'：锁定客户端边界，服务端仅生成预渲染壳；
 * 2. persist 配置 skipHydration: true：**禁用 zustand 的自动水合**。
 *    自动水合会在 store 创建时同步读取 localStorage，而服务端渲染与
 *    客户端首次渲染的初始状态因此产生差异 → React Hydration Mismatch。
 *    改为「服务端与客户端首帧都使用确定性字面量初始值，挂载后再补水」；
 * 3. 客户端根组件 useEffect 中手动调用 rehydratePersistedClusterState()
 *    （本文件导出），此时首帧已提交，状态更新走正常 React 更新通道。
 *
 * 【持久化白名单】partialize 仅落盘 4 个跨会话字段：
 *   connectionMode / totalMaskedSecrets / remediationHistory / terminalLogs(最近30条)。
 *   快照、选中态、capturedViewportDataUrl（DataURL 可达数 MB）一律不持久化，
 *   既防 localStorage 5MB 配额膨胀，也避免把易失运行时状态误当用户偏好。
 */

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ChaosScenario, TelemetrySnapshot } from '@/types/cluster';
import { INITIAL_CLUSTER_SNAPSHOT } from '@/types/cluster';
import type {
  ClusterState,
  ClusterStore,
  PersistedClusterState,
  RemediationRecord,
  SelectedEntityType,
  StatusFilter,
} from '@/types/store';

/* ========================================================================== */
/* 模块级常量（容量上限与持久化键，集中定义防漂移）                               */
/* ========================================================================== */

/** localStorage 持久化键名（带项目前缀，防与同域其他应用冲突） */
const PERSIST_STORAGE_KEY = 'kubevision-cluster-store';

/** 持久化 Schema 版本（字段结构变更时递增，配合 migrate 做向前兼容） */
const PERSIST_VERSION = 1;

/** 终端日志运行期 FIFO 上限（超出丢弃最旧行，防长会话内存无界增长） */
const TERMINAL_LOG_RUNTIME_LIMIT = 200;

/** 终端日志持久化条数上限（仅最近 30 条落盘，防 localStorage 配额膨胀） */
const TERMINAL_LOG_PERSIST_LIMIT = 30;

/** 自愈免疫窗口（毫秒）：同一 targetId 在此窗口内的重复自愈请求将被去重 */
const HEAL_IMMUNITY_WINDOW_MS = 30_000;

/**
 * 自愈记录 ID 单调计数器（模块级，非持久化）。
 *
 * 【设计意图】与 Date.now() 组合生成 `heal-<epoch>-<seq>` 形态的唯一 ID：
 * epoch 保证跨会话单调，seq 保证同毫秒内多条动作不碰撞，
 * 且完全不依赖 crypto.randomUUID（Safari 15 以下与部分内网环境缺失）。
 */
let remediationSeq = 0;

/**
 * 初始状态工厂 —— 返回全部确定性字面量（SSR/CSR 首帧逐字节一致）。
 *
 * 【契约】严禁在此调用 Date.now() / Math.random() / localStorage 读取，
 * 否则服务端预渲染与客户端首帧状态不一致，触发 Hydration Mismatch。
 * 提取为工厂函数而非共享常量对象，保证 clearPersistedHistory() 每次
 * 拿到全新数组/字典引用，杜绝「重置后仍与旧状态共享可变引用」的隐蔽 bug。
 *
 * 【类型说明】仅返回状态切片 ClusterState；Action 实现由 create 回调内联提供，
 * create<ClusterStore> 的泛型约束会在编译期强制二者合并后完整覆盖
 * ClusterState & ClusterActions，漏实现任何 Action 都会 tsc 报错。
 */
function createInitialClusterState(): ClusterState {
  return {
    snapshotSummary: INITIAL_CLUSTER_SNAPSHOT,
    selectedEntityId: null,
    selectedEntityType: null,
    connectionMode: 'demo',
    activeChaos: 'NONE',
    statusFilter: 'ALL',
    activeRightTab: 'copilot',
    isChaosModalOpen: false,
    isPerfHudOpen: false,
    terminalLogs: [],
    quickPromptTrigger: null,
    capturedViewportDataUrl: null,
    healedPodIds: {},
    totalMaskedSecrets: 0,
    remediationHistory: [],
  };
}

/* ========================================================================== */
/* Store 定义                                                                  */
/* ========================================================================== */

/**
 * useClusterStore —— 集群 UI 响应式状态 Store（zustand + persist）。
 *
 * 【类型参数说明】persist<ClusterStore, [], [], PersistedClusterState> 中
 * 第 4 个类型参数显式声明「落盘形状」，使 partialize 的返回值受
 * PersistedClusterState 严格约束——任何多写/漏写字段都会在 tsc 阶段报错，
 * 持久化白名单因此成为编译期契约而非运行时约定。
 *
 * 【订阅最佳实践】组件应按字段细粒度订阅以避免无关重渲染：
 *   const isHudOpen = useClusterStore((s) => s.isPerfHudOpen);
 * 严禁 useClusterStore() 无选择器全量订阅（任一字段变更都会重渲染）。
 */
export const useClusterStore = create<ClusterStore>()(
  persist(
    (set, get) => ({
      ...createInitialClusterState(),

      /**
       * selectEntity —— 选中/取消选中实体。
       *
       * 【不变式维护】entityId 与 entityType 必须同生共死：
       * 传入 entityId=null 时二者一并清空，防止出现「有类型无 ID」的悬挂选中态
       * 导致详情面板渲染空白卡片。entityType 为 undefined 或 null 时按 ID 前缀
       * 推断（node-* → node，pod-* → pod，其余 → master），
       * 便利射线拾取调用方省略类型参数，同时保证 id 非空时 type 必非空。
       */
      selectEntity: (entityId, entityType) => {
        if (entityId === null) {
          set({ selectedEntityId: null, selectedEntityType: null });
          return;
        }
        const resolvedType: SelectedEntityType =
          entityType ??
          (entityId.startsWith('node-')
            ? 'node'
            : entityId.startsWith('pod-')
              ? 'pod'
              : 'master');
        set({ selectedEntityId: entityId, selectedEntityType: resolvedType });
      },

      /** setConnectionMode —— 切换 demo/live 数据源（持久化字段） */
      setConnectionMode: (mode) => {
        set({ connectionMode: mode });
        get().appendTerminalLog(
          `[system] connection mode switched → ${mode === 'live' ? 'LIVE cluster SSE' : 'DEMO simulated engine'}`,
        );
      },

      /**
       * setActiveChaos —— 触发/解除混沌工程场景。
       *
       * 【职责边界】本 Action 只做状态迁移与审计日志，**不执行故障注入**：
       * 模拟引擎（后续轮次）订阅 activeChaos 变更后自行演算受影响的
       * Pod/Node 状态，保持 Store 为纯状态容器的可测试性。
       */
      setActiveChaos: (scenario) => {
        set({ activeChaos: scenario });
        get().appendTerminalLog(
          scenario === 'NONE'
            ? '[chaos] drill cleared → steady state'
            : `[chaos] scenario injected → ${scenario}`,
        );
      },

      /**
       * healEntity —— 执行自愈动作回写（免疫登记 + 历史留痕 + 终端审计）。
       *
       * 【核心逻辑】
       * 1. 免疫去重：查 healedPodIds[targetId]，若距上次自愈 < 30s 免疫窗口，
       *    直接拒绝并写终端日志——防止 Agent 在告警风暴期对同一 Pod 反复重启
       *    形成「自愈抖动」（真实 SRE 事故模式）。
       * 2. 通过则登记当前 epoch 时间戳（Date.now() 仅在客户端 Action 内调用，
       *    不参与 SSR 首帧求值，故不违反确定性契约）。
       * 3. 追加 RemediationRecord 到历史（新记录置顶，便于面板倒序展示）。
       * 4. 写一行终端审计日志，形成人在回路的可追溯链路。
       *
       * 【输入输出】
       * @param targetId 目标实体 ID（Pod/Node 弱引用）
       * @param actionType 动作类型（通常取值为 RemediationActionType）
       */
      healEntity: (targetId, actionType) => {
        const now = Date.now();
        const previous = get().healedPodIds[targetId];

        if (previous !== undefined && now - previous < HEAL_IMMUNITY_WINDOW_MS) {
          get().appendTerminalLog(
            `[heal] BLOCKED ${actionType} on ${targetId} — immunity window active (${Math.ceil((HEAL_IMMUNITY_WINDOW_MS - (now - previous)) / 1000)}s left)`,
          );
          return;
        }

        const record: RemediationRecord = {
          id: `heal-${now}-${remediationSeq++}`,
          timestamp: new Date(now).toISOString(),
          targetId,
          actionType,
        };

        set((state) => ({
          healedPodIds: { ...state.healedPodIds, [targetId]: now },
          remediationHistory: [record, ...state.remediationHistory],
        }));

        get().appendTerminalLog(`[heal] ${actionType} executed on ${targetId} → success`);
      },

      /** setCapturedViewport —— 设置/清除 3D 视口多模态截图（非持久化，体积敏感） */
      setCapturedViewport: (dataUrl) => {
        set({ capturedViewportDataUrl: dataUrl });
      },

      /**
       * incrementMaskedSecrets —— 累加端侧脱敏凭证计数（隐私审计角标）。
       *
       * 【防御】负数与小数无审计意义：先 Math.floor 取整，再 clamp 到 ≥0，
       * 保证累计值单调不减，角标永不出现负数或 NaN。
       */
      incrementMaskedSecrets: (count) => {
        const delta = Math.max(0, Math.floor(Number.isNaN(count) ? 0 : count));
        if (delta === 0) return;
        set((state) => ({ totalMaskedSecrets: state.totalMaskedSecrets + delta }));
      },

      /**
       * appendTerminalLog —— 追加底部终端日志（运行期 FIFO 上限 200 条）。
       *
       * 【时间戳策略】行内容前缀统一注入 HH:mm:ss 本地时刻，
       * 使终端呈现真实运维控制台观感；调用方传入纯消息体即可。
       */
      appendTerminalLog: (line) => {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const stamped = `${hh}:${mm}:${ss} ${line}`;

        set((state) => {
          const next = [...state.terminalLogs, stamped];
          // 超出运行期上限时丢弃最旧行（slice 而非 shift，避免原地突变持久化数组）
          return next.length > TERMINAL_LOG_RUNTIME_LIMIT
            ? { terminalLogs: next.slice(next.length - TERMINAL_LOG_RUNTIME_LIMIT) }
            : { terminalLogs: next };
        });
      },

      /**
       * triggerQuickPrompt —— 触发 AI 快捷诊断指令。
       *
       * 【联动契约】写入载荷的同时强制将 activeRightTab 切至 'copilot'：
       * 用户点击任意快捷诊断按钮（如「分析 OOM 根因」）时，右侧抽屉若停留在
       * auditor 页签会导致「指令已发出但界面无反馈」的割裂体验，故一并切换。
       */
      triggerQuickPrompt: (prompt) => {
        set({ quickPromptTrigger: prompt, activeRightTab: 'copilot' });
      },

      /** clearQuickPrompt —— 消费侧复位指令载荷（Copilot 读取后调用，防重复触发） */
      clearQuickPrompt: () => {
        set({ quickPromptTrigger: null });
      },

      /**
       * clearPersistedHistory —— 一键重置本地持久化缓存。
       *
       * 【核心逻辑】两步走：
       * 1. useClusterStore.persist.clearStorage()：物理删除 localStorage 条目，
       *    确保刷新后不会从旧缓存重新水合出「已清除」的历史；
       * 2. set(...) 将 4 个持久化字段回归初始值，使当前会话 UI 立即反映清除结果
       *    （无需等待刷新）。
       * 非持久化字段（快照、选中态、截图）刻意保留，重置审计缓存不应打断
       * 用户当前的 3D 观察上下文。
       */
      clearPersistedHistory: () => {
        useClusterStore.persist.clearStorage();
        set({
          connectionMode: 'demo',
          totalMaskedSecrets: 0,
          remediationHistory: [],
          terminalLogs: [],
        });
      },

      /**
       * setSnapshotSummary —— 低频快照摘要写入口（轨道二唯一遥测入口）。
       *
       * 【调用契约】由模拟引擎/SSE 层以 ≥1s 节流调用，整体替换引用。
       * 高频轨（每帧插值）严禁走此入口，必须调用
       * syncSnapshotToTransientRef（轨道一），否则 1Hz 快照将驱动
       * HUD 之外的整棵订阅树重渲染，击穿 60FPS 红线。
       */
      setSnapshotSummary: (snapshot: TelemetrySnapshot) => {
        set({ snapshotSummary: snapshot });
      },

      /** setStatusFilter —— 设置 Pod 状态过滤器（'ALL' = 不过滤） */
      setStatusFilter: (filter: StatusFilter) => {
        set({ statusFilter: filter });
      },

      /** setChaosModalOpen —— 混沌控制台模态框开关 */
      setChaosModalOpen: (open) => {
        set({ isChaosModalOpen: open });
      },

      /** setPerfHudOpen —— 性能 HUD 面板开关 */
      setPerfHudOpen: (open) => {
        set({ isPerfHudOpen: open });
      },
    }),
    {
      name: PERSIST_STORAGE_KEY,
      version: PERSIST_VERSION,

      /**
       * createJSONStorage(() => localStorage)
       *
       * 【SSR 安全】zustand 的 createJSONStorage 内部以 try/catch 惰性求值
       * getStorage()：服务端 localStorage 未定义会抛 ReferenceError 并被捕获，
       * 返回 undefined 使 persist 退化为无操作，不会导致模块 import 崩溃。
       */
      storage: createJSONStorage(() => localStorage),

      /**
       * skipHydration: true —— 禁用自动水合（Hydration Mismatch 根治手段）。
       *
       * 详见文件头「SSR 水合安全三重防护」第 2 条：首帧统一使用确定性初始值，
       * 挂载后由客户端根组件调用 rehydratePersistedClusterState() 手动补水。
       */
      skipHydration: true,

      /**
       * partialize —— 持久化白名单（编译期受 PersistedClusterState 约束）。
       *
       * terminalLogs 在此处二次裁剪到最近 30 条：运行期缓冲 200 条用于
       * 当前会话的完整回溯，落盘只留最近 30 条作为跨会话摘要，
       * 兼顾调试体验与 localStorage 配额安全。
       */
      partialize: (state): PersistedClusterState => ({
        connectionMode: state.connectionMode,
        totalMaskedSecrets: state.totalMaskedSecrets,
        remediationHistory: state.remediationHistory,
        terminalLogs: state.terminalLogs.slice(-TERMINAL_LOG_PERSIST_LIMIT),
      }),
    },
  ),
);

/* ========================================================================== */
/* 水合辅助（客户端根组件调用）                                                  */
/* ========================================================================== */

/**
 * rehydratePersistedClusterState —— 客户端手动水合入口（幂等）。
 *
 * 【调用契约】必须在客户端根组件的 useEffect 中调用一次：
 *   useEffect(() => { rehydratePersistedClusterState(); }, []);
 * 此时首帧 HTML 已提交，从 localStorage 读出的持久化字段以正常 React
 * 更新通道合并进 Store，不会产生水合不匹配。
 *
 * 【幂等性】内部以模块级标志位守卫，StrictMode 双调用 / 多组件重复调用
 * 均只会真正补水一次，避免重复触发订阅者重渲染。
 * rehydrate() 返回 Promise<void | unknown>（旧缓存解析失败时 resolve undefined），
 * 失败分支写一行终端日志便于排查，绝不抛出以免中断根组件挂载。
 */
let hasRehydrated = false;

export function rehydratePersistedClusterState(): void {
  if (hasRehydrated) return;
  hasRehydrated = true;

  void useClusterStore
    .persist
    .rehydrate()
    ?.then(() => {
      const { terminalLogs } = useClusterStore.getState();
      if (terminalLogs.length > 0) {
        useClusterStore
          .getState()
          .appendTerminalLog('[system] persisted session state rehydrated from localStorage');
      }
    })
    .catch(() => {
      useClusterStore
        .getState()
        .appendTerminalLog('[system] WARN persisted state rehydration failed → using defaults');
    });
}

/**
 * useHasHydratedClusterStore —— 水合完成标志的响应式读取 Hook。
 *
 * 【设计意图】部分 UI（如「历史自愈记录」面板）需要在补水完成后才渲染真实数据，
 * 否则会闪现一帧空态。本 Hook 订阅 persist.onFinishHydration 事件，
 * 返回布尔标志供组件条件渲染。skipHydration 模式下若无缓存可补，
 * rehydrate() 不触发 finish 事件，故初始值直接取 hasRehydrated 模块标志兜底。
 */
export function useHasHydratedClusterStore(): boolean {
  const [hydrated, setHydrated] = useState<boolean>(hasRehydrated);

  useEffect(() => {
    const unsubscribe = useClusterStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    // 订阅建立前水合可能已完成（竞态），此处二次校正
    setHydrated(hasRehydrated);
    return unsubscribe;
  }, []);

  return hydrated;
}
