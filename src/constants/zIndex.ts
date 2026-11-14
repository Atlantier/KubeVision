/**
 * 全局视觉层级（z-index）单一真源定义
 *
 * 【设计意图】
 * 统一规范 3D 画布、画布内 HUD、导航栏弹出层、底部状态胶囊、互斥模态框与全局命令面板的堆叠次序，
 * 避免各组件硬编码随意递增 z-index 导致的遮挡冲突与“幽灵焦点”。
 * 注意：所有 Tailwind 类名均采用静态完整字面量，禁止运行时字符串拼接，以保证 Tailwind JIT 与样式契约校验通过。
 */

/**
 * 分层数值常量表，用于非 Tailwind 样式场景（如 Portal / Drei Html zIndexRange 等）的数值对照
 */
export const Z_INDEX_LAYER = {
  /** 3D WebGL 画布底层 */
  CANVAS_BASE: 0,
  /** 画布内常驻 HUD（终端回显、底部工具条等） */
  CANVAS_HUD: 10,
  /** 画布浮动状态提示（演示模式左上状态徽标等） */
  CANVAS_FLOATING: 20,
  /** 顶部栏、抽屉粘性头部与局部弹出菜单 */
  CHROME_POPOVER: 30,
  /** 底部全局浮层（启动状态胶囊、演示回放时间轴、调试面板、节点检视卡、性能 HUD） */
  HUD_OVERLAY: 40,
  /** 全局互斥模态框（混沌演练台、RAG 知识库、事故复盘报告、快捷键帮助） */
  MODAL: 50,
  /** 最高优先级全局命令面板（可在模态框之上唤醒，按 Esc 优先逐层退出） */
  COMMAND_PALETTE: 60,
} as const;

/**
 * 视觉层级键名类型
 */
export type ZIndexLayerKey = keyof typeof Z_INDEX_LAYER;

/**
 * Tailwind 静态层级类名映射表
 */
export const Z_CLASS: Readonly<Record<ZIndexLayerKey, string>> = {
  CANVAS_BASE: 'z-0',
  CANVAS_HUD: 'z-10',
  CANVAS_FLOATING: 'z-20',
  CHROME_POPOVER: 'z-30',
  HUD_OVERLAY: 'z-40',
  MODAL: 'z-50',
  COMMAND_PALETTE: 'z-[60]',
};
