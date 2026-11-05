import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * cn() —— 条件式 className 合并与冲突消解函数（全项目唯一样式合并入口）
 *
 * 【设计意图】
 * 遵循 shadcn/ui 业界标准范式，将 clsx（条件拼接）与 tailwind-merge（同维度冲突消解）
 * 封装为单一入口，供所有组件 Props 合并 className 使用，杜绝手写字符串拼接导致的
 * 类顺序不确定与 Tailwind 冲突（如同时出现 px-2 与 px-4）问题。
 *
 * 【核心逻辑】
 * 1. clsx(inputs)：从字符串 / 对象 / 数组 / falsy（false、null、undefined、''）等
 *    多种形态入参中过滤无效值，拼接为原始 className 字符串。
 * 2. twMerge(...)：基于 Tailwind 类维度智能消解冲突，同一维度仅保留最后出现的声明，
 *    使「基础类 + 覆盖类」的合并结果确定且可预测。
 *
 * 【扩展性】tailwind-merge 默认仅识别标准 Tailwind 类；本项目自定义的
 * shadow-glow-cyan / bg-cyber-grid 等令牌类若不参与冲突消解会被原样透传，
 * 如需纳入消解可后续用 extendTailwindMerge 注入自定义 classGroup，当前保持零配置。
 *
 * @param inputs - ClassValue 变长参数（string | number | object | array | falsy）
 * @returns 合并且消解冲突后的 className 字符串
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
