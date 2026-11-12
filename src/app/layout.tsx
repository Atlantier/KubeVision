import type { Metadata, Viewport } from 'next';
import './globals.css';

/**
 * KubeVision AI — 根布局（App Router / Server Component）
 *
 * 【SSR 边界安全】本文件保持纯服务端组件：不引入 three / @react-three/fiber /
 * window 相关逻辑；3D 根画布将在后续轮次通过 next/dynamic 在客户端边界懒加载。
 *
 * 【深色根容器契约】bg-slate-950 + text-slate-100 + antialiased +
 * selection:bg-cyan-500/30，与 globals.css @layer base 双重保险，
 * 确保任何挂载点（含 drei <Html> 传送门）继承统一深空底色。
 */

export const metadata: Metadata = {
  title: 'KubeVision AI | 云原生集群 3D 态势感知与智能运维副驾',
  description:
    'KubeVision AI —— 面向 Kubernetes 集群的云原生 3D 态势感知与智能副驾：WebGL 实时拓扑渲染、瞬态遥测流、浏览器端侧 RAG 推理与 SRE Copilot 一体化作战平台。',
  applicationName: 'KubeVision AI',
  keywords: [
    'Kubernetes',
    'Cloud Native',
    'Observability',
    '3D Situational Awareness',
    'React Three Fiber',
    'SRE Copilot',
    'RAG',
    'Transformers.js',
  ],
  authors: [{ name: 'KubeVision AI Team' }],
  openGraph: {
    title: 'KubeVision AI | 云原生集群 3D 态势感知与智能运维副驾',
    description: 'WebGL 实时集群拓扑 × 瞬态遥测 × 端侧 RAG 智能副驾',
    type: 'website',
    locale: 'zh_CN',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /* 【R3】不设 maximumScale：旧值 1 禁用浏览器缩放，低视力用户无法放大界面。
     保留 initialScale=1 保证首屏布局确定，缩放主权交还用户（WCAG 1.4.4）。 */
  themeColor: '#020617', // slate-950：浏览器地址栏与深空底色融合
  colorScheme: 'dark',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark">
      <body className="min-h-screen bg-slate-950 font-sans text-slate-100 antialiased selection:bg-cyan-500/30 selection:text-slate-50">
        {children}
      </body>
    </html>
  );
}
