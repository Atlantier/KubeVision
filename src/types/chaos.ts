/**
 * KubeVision AI — 混沌工程演练模态框类型契约（唯一类型源）
 *
 * 【契约】依据 AGENTS.md 第 2 条：组件 Props 必须严格引用 src/types/
 * 下的接口定义，禁止 any / @ts-ignore。
 */

import type { ChaosScenario, RackIndex } from '@/types/cluster';

/**
 * ChaosDrillCard —— 单张演练场景卡片的展示载荷。
 *
 * 【设计意图】把「场景枚举值」与「战术卡片文案 + 受灾定位」绑定为
 * 静态数据表：新增演练场景只改表、不改 JSX（开放-封闭原则）。
 * 每张卡片都有自己的视觉语义（配色/图标/受灾机架），
 * 因此必须逐字段声明而非靠 scenario 字符串在 JSX 里做三元分支。
 */
export interface ChaosDrillCard {
  /** 场景枚举值（同时是 store 的 activeChaos 取值） */
  readonly scenario: ChaosScenario;
  /** 卡片代号（A/B/C/D，战术面板风格） */
  readonly code: string;
  /** 场景英文代号（等宽大字，技术感） */
  readonly codename: string;
  /** 中文场景名（一句话说明演练主题） */
  readonly title: string;
  /** 详细说明（描述受灾机架、故障机制与可观测后果） */
  readonly description: string;
  /**
   * 受灾机架索引（用于镜头聚焦与涟漪激活）。
   *
   * - POD_OOM_SWARM   → 1（worker-beta）
   * - NODE_CPU_SPIKE  → 0（worker-alpha）
   * - NET_PACKET_LOSS → 2（worker-gamma）
   * - NONE            → null（无受灾机架，恢复稳态时不聚焦任何机架）
   */
  readonly targetRackIndex: RackIndex | null;
  /** 受灾实体 ID（传入 selectEntity 触发相机特写；NONE 为 null） */
  readonly targetEntityId: string | null;
  /** 卡片主题色（Tailwind 文本色类，如 'text-rose-300'） */
  readonly accentTextClass: string;
  /** 卡片悬停边框色类 */
  readonly accentBorderClass: string;
  /** 是否为一键恢复（视觉上区别于三个故障注入卡） */
  readonly isRecovery: boolean;
}

/**
 * ChaosControlModalProps —— 模态框组件 Props。
 *
 * 【无状态设计】开关状态经 useClusterStore.isChaosModalOpen 订阅，
 * 关闭经 setChaosModalOpen(false)；Props 仅为挂载点样式微调预留。
 */
export interface ChaosControlModalProps {
  /** 附加容器类名 */
  readonly className?: string;
}
