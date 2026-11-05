'use client';

/**
 * KubeVision AI — 首页（中控台 Router 客户端入口）
 *
 * 【职责】中控台页面仅做两件事：
 * 1. 挂载补水：useEffect 中调用 rehydratePersistedClusterState()——
 *    其内部第一步即执行 useClusterStore.persist.rehydrate()（幂等守卫包裹，
 *    抵御 StrictMode 双调用），从 localStorage 安全恢复持久化状态。
 *    因 Store 配置 skipHydration: true，首帧 SSR/CSR 均为确定性初始值，
 *    补水发生在首帧提交之后，彻底杜绝 Hydration Mismatch（AGENTS.md 第 4 条）。
 * 2. 渲染 ShellLayout 全屏外壳（TopBar + 65/35 双栏 + 移动端切换栏）。
 *
 * 【'use client' 边界说明】本文件是客户端组件，metadata 不可从此导出——
 * 页面标题等元数据已由 src/app/layout.tsx（服务端根布局）统一承载。
 */

import { useEffect } from 'react';

import ShellLayout from '@/components/layout/ShellLayout';
import { rehydratePersistedClusterState } from '@/store/useClusterStore';

export default function HomePage() {
  /* 挂载后手动补水：内部首先调用 useClusterStore.persist.rehydrate()，
   * 幂等守卫保证 StrictMode 双挂载 / 多组件重复调用只真正补水一次 */
  useEffect(() => {
    rehydratePersistedClusterState();
  }, []);

  return <ShellLayout />;
}
