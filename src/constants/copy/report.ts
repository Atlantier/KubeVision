/**
 * KubeVision AI — 生产事故复盘报告人类可读文案契约（R11）
 *
 * 【设计意图】面向值班工程师与评审导出的 Markdown 复盘报告属于用户可见文档，
 * 不得裸露 TypeScript 类型名或内部变量路径（例如 clusterContext.faultyPods、
 * synthesized=true、RootCauseAlertProps、ActionConfirmProps、localStorage 等）。
 * 本文件集中管理所有报告固定说明与状态文案。
 */

export const REPORT_COPY = {
  dataSourceQuote:
    '> 数据来源：端侧实时集群快照（集群健康分、入口 QPS、异常 Pod 与节点水位）+ AI 运维副驾推理链（五态推理阶段与单步耗时）+ 生成式诊断卡片（指标卡、根因卡与自愈审批卡）。全部内容均由本机浏览器内的会话事实自动推导，不含手工补写数据。',
  emptyFaultyPodsSymptom: '本次会话没有记录到故障 Pod，请先注入故障演练或选中异常实例后再复盘',
  failedMessageNote: '因连接或服务端中断而未完整生成，其残缺内容未纳入本次定论。',
  emptyImpactScope: '本次会话未产出根因分析卡片，没有可引用的影响范围描述；请先在 AI 运维副驾中发起故障根因诊断。',
  impactScopeHeading: '**AI 运维副驾评估的影响范围**',
  faultyPodsSubheading: '### 2.1 异常 Pod 明细（实时集群快照）',
  emptyFaultyPodsSection: '当前快照中没有记录异常 Pod。故障可能已自愈；如需生成故障复盘，请先在顶部开启故障演练或选中目标实例。',
  podMetricsSubheading: '### 2.2 容器指标卡实测快照',
  timelineQuote:
    '> 时间口径：会话记录按每轮问答的推理阶段耗时顺序累加推算相对时刻（用户提问不推进时钟），格式为 `+mm:ss`。该时间线用于还原因果先后顺序，不作为内核级精确时间戳。',
  noRootCauseNotice:
    '> 说明：本次会话尚未生成根因分析卡片，因此本报告不对根因作主观推测。若故障确实存在，请先选中异常 Pod 并向 AI 运维副驾发起一次完整诊断请求。',
  synthesizedCardSource: '由服务端自动补全',
  nativeCardSource: '由模型原生调用生成',
  missingRagRefsNotice: '本次会话的根因分析卡片未附带知识库引用，暂无匹配手册；请前往知识库检索或补充同类案例。',
  customCorpusSource: '自定义语料（本机浏览器存储）',
  builtinCorpusSource: '内置权威语料',
  actionStateQuote:
    '> 状态判定口径：本表仅以会话中记录的「MCP 执行验证回执」作为动作已执行的唯一客观依据；未收到验证回执的审批卡一律标记为「待审批」。',
  highRiskConfirmLabel: '是（请先勾选确认）',
  lessonsLeadTemplate:
    '以下改进清单依据本次会话的真实诊断卡片与集群运行快照自动生成',
  timelineFormulaDisclaimer:
    '- 时间线时刻为各推理阶段耗时顺序累加的推算值，用于还原因果先后顺序，不等同于内核或告警系统的精确时间戳。',
  highRiskActionDisclaimer:
    '- 本报告仅作为复盘证据与改进清单，不构成生产变更指令。任何高危操作（尤其是节点驱逐操作）必须经过人工二次确认与变更审批后方可执行。',
} as const;
