import { cn } from '@/utils/cn';
import type { BootstrapChecklistItem } from '@/types/cluster';

/**
 * KubeVision AI — 首页占位（App Router / Server Component）
 *
 * 【当前轮次职责】仅验证主题底座：深空网格背景 .bg-cyber-grid、
 * 运维面板 .kv-panel、状态徽标（emerald/amber/rose）与发光阴影令牌全部生效。
 * 3D 集群画布与 Copilot 抽屉将在后续轮次以 next/dynamic 客户端组件接入，
 * 本文件保持纯 SSR 安全（无 window / three 引用，零水合风险）。
 *
 * 【类型契约】状态模型统一引用 src/types/cluster.ts，禁止本地重复定义。
 */

/** 初始化清单：底座能力自检项（静态数据，SSR 直出） */
const BOOTSTRAP_CHECKLIST: readonly BootstrapChecklistItem[] = [
  { label: 'Next.js 14.2.18 · App Router', status: 'healthy' },
  { label: 'Tailwind CSS v3 · 深空赛博主题底座', status: 'healthy' },
  { label: 'Three.js r169 + R3F 8.17.10 依赖矩阵', status: 'healthy' },
  { label: '3D 集群态势画布（待接入）', status: 'warning' },
  { label: 'SRE Copilot 端侧 RAG（待接入）', status: 'warning' },
];

export default function HomePage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-slate-950 px-6 py-16">
      {/* 深空网格背景层：微弱青色透明线性渐变网格 + 径向暗角，pointer-events-none 防遮挡 */}
      <div aria-hidden className="bg-cyber-grid pointer-events-none absolute inset-0" />
      {/* 顶部主题流光晕染：cyan-400 低透明度径向渐变 */}
      <div aria-hidden className="bg-radial-fade pointer-events-none absolute inset-x-0 top-0 h-96" />

      <section className="relative z-10 flex w-full max-w-2xl flex-col items-center text-center">
        {/* 徽标：等宽字体 + 青色辉光 */}
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.5em] text-cyan-400 text-glow-cyan">
          KubeVision&nbsp;AI
        </p>

        <h1 className="text-balance text-4xl font-bold leading-tight tracking-tight text-slate-50 sm:text-5xl">
          Cloud-Native{' '}
          <span className="bg-gradient-to-r from-cyan-400 via-sky-400 to-emerald-400 bg-clip-text text-transparent">
            3D Situational Awareness
          </span>{' '}
          &amp; Copilot
        </h1>

        <p className="mt-6 max-w-xl text-pretty text-sm leading-relaxed text-slate-400 sm:text-base">
          面向 Kubernetes 集群的 WebGL 实时态势感知平台：瞬态遥测驱动的 InstancedMesh
          拓扑渲染、浏览器端侧 Transformers.js RAG 推理，以及为 SRE 而生的智能副驾。
          工程底座初始化完成，等待第一轮 3D 画布接入。
        </p>

        {/* 自检面板：验证面板/状态徽标/发光阴影令牌 */}
        <div className="kv-panel mt-12 w-full p-6 text-left">
          <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
            <h2 className="font-mono text-xs uppercase tracking-widest text-slate-500">
              bootstrap&nbsp;checklist
            </h2>
            <span className="kv-status-dot kv-status-dot--healthy" aria-label="系统正常" />
          </div>

          <ul className="space-y-3">
            {BOOTSTRAP_CHECKLIST.map((item) => (
              <li key={item.label} className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={cn('kv-status-dot', {
                    'kv-status-dot--healthy': item.status === 'healthy',
                    'kv-status-dot--warning': item.status === 'warning',
                    'kv-status-dot--critical': item.status === 'critical',
                  })}
                />
                <span className="text-sm text-slate-300">{item.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-8 font-mono text-[11px] text-slate-600">
          v0.1.0 · react 18.3.1 · three ~0.169.0 · @react-three/fiber 8.17.10
        </p>
      </section>
    </main>
  );
}
