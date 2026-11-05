/**
 * KubeVision AI — 集群领域类型定义（唯一类型源）
 *
 * 【契约】依据 AGENTS.md 第 2 条：所有组件 Props、Zustand Store、API Route
 * 载荷必须严格引用 src/types/ 下的接口定义，禁止 any / @ts-ignore。
 * 本文件自第 1 轮起承载集群健康状态等核心领域模型，后续遥测接口、
 * 3D 节点渲染状态映射均从此处派生。
 */

/**
 * 节点健康状态三态模型（与视觉规范一一对应）：
 * - healthy  → emerald-400 正常态
 * - warning  → amber-400 高负载态
 * - critical → rose-500 崩溃态
 *
 * 该联合类型同时驱动：状态徽标 CSS 类映射、InstancedMesh 实例着色、
 * Copilot 告警文案分级。集中定义保证三处消费永不漂移。
 */
export type NodeHealthStatus = 'healthy' | 'warning' | 'critical';

/** 初始化自检清单条目：label 展示文案 + status 徽标状态 */
export interface BootstrapChecklistItem {
  readonly label: string;
  readonly status: NodeHealthStatus;
}
