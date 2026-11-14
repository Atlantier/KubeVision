/**
 * KubeVision AI — 混沌故障演练场景统一名称源（R11）
 *
 * 【设计意图】全站所有显示 POD_OOM_SWARM / NODE_CPU_SPIKE / NET_PACKET_LOSS 的
 * 界面入口（顶栏胶囊、混沌控制台、命令面板、回放时间轴、复盘报告、稳态自报能力）
 * 一律从本文件读取展示名，彻底消除「OOM 风暴 / OOM 雪崩 / CPU 尖峰 / CPU 尖刺」
 * 等同义异形词漂移。
 *
 * 【与剧本名的区分】本文件规范「混沌场景（ChaosScenario）」的展示名；
 * 顶部全自动路演剧本（如「OOM 全链路自愈」「CNI 网络延迟追踪」）属于独立剧本标题，
 * 二者概念分离，互不混用。
 */

import type { ChaosScenario } from '@/types/cluster';

/** 非稳态混沌场景联合类型（仅模块内部映射使用） */
type ActiveChaosScenario = Exclude<ChaosScenario, 'NONE'>;

/** 混沌场景唯一规范中文短名（UI 徽章、胶囊、标题统一消费） */
export const CHAOS_SCENARIO_LABELS: Readonly<Record<ChaosScenario, string>> = {
  NONE: '集群稳态',
  POD_OOM_SWARM: 'OOM 内存溢出',
  NODE_CPU_SPIKE: '节点 CPU 饱和',
  NET_PACKET_LOSS: 'CNI 网络分区丢包',
};

/** 命令面板与快速注入动作前缀标签 */
export const CHAOS_INJECT_LABELS: Readonly<Record<ActiveChaosScenario, string>> = {
  POD_OOM_SWARM: `注入：${CHAOS_SCENARIO_LABELS.POD_OOM_SWARM}`,
  NODE_CPU_SPIKE: `注入：${CHAOS_SCENARIO_LABELS.NODE_CPU_SPIKE}`,
  NET_PACKET_LOSS: `注入：${CHAOS_SCENARIO_LABELS.NET_PACKET_LOSS}`,
};

/** 复盘报告与审计文本使用的场景详细说明 */
const CHAOS_REPORT_LABELS: Readonly<Record<ChaosScenario, string>> = {
  NONE: 'NONE（集群稳态，无故障注入）',
  POD_OOM_SWARM: `POD_OOM_SWARM（${CHAOS_SCENARIO_LABELS.POD_OOM_SWARM}）`,
  NODE_CPU_SPIKE: `NODE_CPU_SPIKE（${CHAOS_SCENARIO_LABELS.NODE_CPU_SPIKE}）`,
  NET_PACKET_LOSS: `NET_PACKET_LOSS（${CHAOS_SCENARIO_LABELS.NET_PACKET_LOSS}）`,
};

/**
 * getChaosReportLabel —— 返回复盘报告专用的混沌场景规范中文标签。
 *
 * @param scenario 混沌场景标识
 * @returns 规范中文场景描述
 */
export function getChaosReportLabel(scenario: string): string {
  switch (scenario) {
    case 'NONE':
      return CHAOS_REPORT_LABELS.NONE;
    case 'POD_OOM_SWARM':
      return CHAOS_REPORT_LABELS.POD_OOM_SWARM;
    case 'NODE_CPU_SPIKE':
      return CHAOS_REPORT_LABELS.NODE_CPU_SPIKE;
    case 'NET_PACKET_LOSS':
      return CHAOS_REPORT_LABELS.NET_PACKET_LOSS;
    default:
      return scenario;
  }
}
