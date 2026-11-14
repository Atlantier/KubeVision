/**
 * KubeVision AI — 全站高频 UI 标签、微标尺与状态徽章中文常量（R11）
 *
 * 【设计意图】收口 H01–H22 中原本散落的生硬全大写英文装饰串
 * （如 TRACE、TOKENS、COST、STAGE-00 / IDLE、MCP RECEIPT、LIVE CLUSTER、SIMULATED、
 * chaos engineering console、SYS // TELEMETRY），统一由可控中文常量提供。
 */

export const UI_COPY = {
  /** 链路追踪瀑布面板（AgentTracePanel） */
  traceHeader: '链路追踪',
  traceWaitingSummary: '正在汇总链路耗时指标…',
  traceTtftLabel: '首字节',
  traceTotalLabel: '总耗时',
  traceTokensUnconfigured: '词元 未统计',
  traceTokensPrefix: '词元',
  traceCostUnconfigured: '估算成本 未统计',
  traceCostPrefix: '估算成本',
  /** 高危操作与 MCP 执行回执（ActionConfirm） */
  actionNeedConfirm: '请先勾选确认',
  actionExecuteNow: '立即执行自愈方案',
  mcpReceiptTag: '[MCP 执行回执]',
  mcpModeReal: '真实集群',
  mcpModeSimulated: '沙箱推演',
  /** 顶栏剧本路演状态（TopBar） */
  demoIdleStage: '阶段 00 · 待命',
  /** 全息微标尺（HoloHud / NodeInspectHUD） */
  holoRulerTelemetry: '系统遥测',
  holoRulerInspect: '系统巡检',
  /** 混沌故障演练控制台（ChaosControlModal） */
  chaosModalTitle: '混沌工程故障演练控制台',
  chaosModalSubtitle: '故障注入 · 演练前请确认目标机架与影响范围',
  chaosModalRestoreAll: '全集群机架恢复',
  chaosModalTargetRackPrefix: '目标机架',
  chaosModalFooterHint: '演练仅作用于本地推演引擎 · 不会影响真实集群 · 按 Esc 退出',
  /** 知识库弹窗（RagKnowledgeModal） */
  ragModalSubtitle: 'SRE 故障处置知识库 · 混合检索沙盒与术语表',
  ragSandboxTitle: '混合检索沙盒',
  ragSandboxPipeline: '向量 + BM25 + 上下文先验',
  ragCorpusIndexTitle: '知识库索引',
  ragLocalPersistHint: '本机浏览器持久化 · 入库后立即参与混合检索',
  ragFooterPersistHint: '数据仅存于本机浏览器存储',
  ragEmptySearchResult: '未命中匹配的 Runbook 手册，请尝试输入具体报错关键字（如 Exit 137、429）或点击下方手册列表浏览。',
  /** 根因分析卡（RootCauseAlert） */
  rootCauseImpactTitle: '故障影响范围',
  rootCauseMechanismTitle: '内核 / cgroup / CNI 层机理',
} as const;
