/**
 * KubeVision AI — AI 运维副驾与端侧日志审计文案契约（R11）
 *
 * 【设计意图】
 * 1. 统一「AI 运维副驾（短称：副驾）」与「端侧日志审计」名称，结束四套叫法混用。
 * 2. 将结构化错误分类文案收口至此文件（src/types/ai.ts 重导出以保持兼容），
 *    确保每类错误均完整包含「发生什么 + 下一步 + 可否重试」三要素。
 */

/** 错误分类标识（与 ChatErrorCategory 值域一一对应，内部约束用） */
type AgentErrorCategoryKey = 'network' | 'model' | 'tool_args' | 'server' | 'abort';

/** 副驾主名称、短称与端侧审计台规范名称 */
export const AGENT_COPY = {
  copilotTitle: 'AI 运维副驾',
  copilotShortName: '副驾',
  copilotEmptyHeading: 'KubeVision AI 运维副驾',
  auditorTitle: '端侧日志审计',
  auditorSrOnlyAnchor: 'Edge Log Auditor (WASM)',
  traceRegionLabel: '请求链路追踪',
} as const;

/**
 * CHAT_ERROR_COPY —— 结构化错误分类展示文案（三要素完备 + 长度 ≥ 12 字）。
 *
 * 每项均交代：发生了什么、接下来如何处理、是否支持直接重试。
 */
export const CHAT_ERROR_COPY: Readonly<
  Record<AgentErrorCategoryKey, { readonly title: string; readonly hint: string; readonly retryable: boolean }>
> = {
  network: {
    title: '网络连接中断',
    hint: '流式诊断中途断开，已生成内容已为您保留；请检查网络连通性后点击下方按钮继续生成，当前支持重试。',
    retryable: true,
  },
  model: {
    title: '模型服务响应异常',
    hint: '上游推理接口限流或暂时不可用；请稍候几秒点击下方按钮一键重试，或系统将切换本地容灾引擎，支持重试。',
    retryable: true,
  },
  tool_args: {
    title: '工具调用参数校验失败',
    hint: '模型生成的诊断工具参数未通过结构契约校验；请点击下方按钮一键重试，由服务端重新生成合规调用，支持重试。',
    retryable: true,
  },
  server: {
    title: '服务端内部处理异常',
    hint: '后端网关返回服务端处理异常，已输出正文与问题上下文均已保留；请稍后点击继续生成恢复诊断，支持重试。',
    retryable: true,
  },
  abort: {
    title: '已手动停止生成',
    hint: '本次诊断已按您的指令中止，已输出部分完整保留；当前不再自动重试，如需继续请重新发送提问。',
    retryable: false,
  },
};
