/**
 * KubeVision AI — 开场 uBoot 实例（R29 · B 项）
 *
 * 模块级单例：BootController 每帧推进，所有需要开场渐入的层读取同一个值。
 * 不放进 React state，因此不会触发任何重渲染。
 */

export { bootUniform } from '@/utils/bootUniform';