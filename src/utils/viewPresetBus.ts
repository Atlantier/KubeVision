/**
 * KubeVision AI — 视角预设事件总线（零依赖 · SSR 安全）
 *
 * 【设计意图】解耦「UI 层触发视角预设」与「CameraRig 执行相机飞行」：
 * UI 组件（顶栏、快捷键、Copilot 卡片按钮）只需 dispatchViewPreset('overview')，
 * 无需 import three / R3F / CameraRig，也不持有相机引用。CameraRig 挂载时
 * 订阅、卸载时退订，生命周期完全自治。
 *
 * 【为何用 CustomEvent 而非 zustand】视角预设是**瞬时指令**（fire-and-forget
 * 语义），不是需要被订阅渲染的状态；若进 zustand，每次广播都会触发全体
 * 订阅者重渲染比对，且「复位到全景」这类幂等指令连按两次时，状态不变 →
 * 订阅者收不到通知（zustand 以值相等跳过更新）。CustomEvent 天生「每次都派发」，
 * 完美匹配指令语义，且浏览器原生实现零依赖。
 *
 * 【SSR 安全】所有 window 访问都在函数体内惰性求值，模块顶层无 window 引用，
 * 服务端 import 求值安全（AGENTS.md 第 4 条）。
 */

import type { ViewPresetKey } from '@/types/canvas';

/** 视角预设事件名（全局唯一命名空间，防与第三方库事件冲突） */
const VIEW_PRESET_EVENT = 'kubevision:view-preset';

/** 预设事件回调签名 */
export type ViewPresetListener = (preset: ViewPresetKey) => void;

/**
 * dispatchViewPreset —— 广播一次视角预设指令。
 *
 * @param preset 预设键（当前仅 'overview'）
 * @returns 是否成功派发（SSR 环境无 window 时返回 false，调用方无需感知）
 */
export function dispatchViewPreset(preset: ViewPresetKey): boolean {
  if (typeof window === 'undefined') return false;
  window.dispatchEvent(
    new CustomEvent<ViewPresetKey>(VIEW_PRESET_EVENT, { detail: preset }),
  );
  return true;
}

/**
 * subscribeViewPreset —— 订阅视角预设指令（返回退订函数）。
 *
 * 【调用契约】仅供 CameraRig 在 useEffect 中使用；返回值必须在 cleanup 中调用，
 * 否则组件卸载后监听器泄漏会持续触发已销毁相机的插值逻辑。
 *
 * @param listener 预设回调
 * @returns 退订函数（幂等，可安全多次调用）
 */
export function subscribeViewPreset(listener: ViewPresetListener): () => void {
  if (typeof window === 'undefined') {
    // SSR 环境返回空退订函数，保持调用方 cleanup 代码无需分支
    return (): void => undefined;
  }

  const handler = (event: Event): void => {
    // CustomEvent.detail 类型在 addEventListener 回调中被收窄为 unknown，
    // 此处做一次窄化校验，杜绝非本总线派发的同名事件污染相机逻辑
    const custom = event as CustomEvent<ViewPresetKey>;
    if (typeof custom.detail === 'string') {
      listener(custom.detail);
    }
  };

  window.addEventListener(VIEW_PRESET_EVENT, handler);
  return (): void => {
    window.removeEventListener(VIEW_PRESET_EVENT, handler);
  };
}
