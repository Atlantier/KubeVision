/**
 * KubeVision AI — 文案与术语契约统一入口（R11）
 *
 * 汇总导出混沌场景名、AI 运维副驾文案、复盘报告文案、UI 通用文案与术语表。
 */

export {
  GLOSSARY_CATEGORY_META,
  PRODUCT_DECISIONS,
  TERMS,
  type GlossaryCategory,
  type GlossaryTermEntry,
  type ProductDecisionEntry,
} from './glossary';
export { CHAOS_INJECT_LABELS, CHAOS_SCENARIO_LABELS, getChaosReportLabel } from './chaos';
export { AGENT_COPY, CHAT_ERROR_COPY } from './agent';
export { REPORT_COPY } from './report';
export { UI_COPY } from './ui';
