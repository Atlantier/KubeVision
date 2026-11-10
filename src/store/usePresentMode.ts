/**
 * KubeVision AI — 演示模式（R32 · 追问 1）
 *
 * 【是什么】?present=1 或顶栏开关进入"路演视图"：
 *   - 隐藏事件流终端；收起性能 HUD（改为只保留健康分/告警/QPS 的胶囊）；
 *   - 抽屉宽度 38% → 34%；
 *   - 其余功能经 Cmd+K 命令面板可达。
 *
 * 【不重建 3D 画布】演示模式只控制 DOM 层的显示/宽度，Canvas 始终挂载，
 * 切换不触发任何 R3F 卸载/重挂载。
 *
 * 【SSR 安全】store 初值恒为 false；客户端在 ShellLayout 的 useEffect 中
 * 从 URL 读取一次，避免 hydration mismatch。
 */

import { create } from 'zustand';

interface PresentModeState {
  /** 是否处于演示模式 */
  readonly present: boolean;
  /** 设置演示模式 */
  setPresent: (present: boolean) => void;
  /** 切换演示模式 */
  toggle: () => void;
}

export const usePresentMode = create<PresentModeState>((set) => ({
  present: false,
  setPresent: (present): void => set({ present }),
  toggle: (): void => set((state): PresentModeState => ({ ...state, present: !state.present })),
}));

/** 演示模式下抽屉宽度（%）；常态宽度由 useDrawerWidth 记忆 */
export const PRESENT_DRAWER_WIDTH_PCT = 34;