/**
 * KubeVision AI — 五层全链路降级矩阵（单一权威常量源，R13）
 *
 * 【设计意图】
 * 把“云端大模型 / 端侧 WebGPU / SSE 实时流 / WebGL 上下文 / 3D 拓扑渲染”五个核心能力面的
 * 退化路径全部显式工程化：每层都有确定的触发阈值、诚实的用户提示、清晰的恢复条件以及
 * 降级期间严禁对外越权宣称的口径限制。`/api/health`、UI 降级横幅与验收文档统一引用本表。
 */

import type { DegradationMatrixItem, DegradationTierId } from '@/types/health';

/**
 * 五层全链路降级矩阵常量表（按能力依赖链从上到下排序）。
 */
export const DEGRADATION_MATRIX: readonly DegradationMatrixItem[] = [
  {
    id: 'llm-fallback',
    tier: 1,
    name: '对话引擎降级（引擎 A → 引擎 B 确定性容灾）',
    triggerCondition: '未配置云端 API Key、上游超时/返回非 2xx、或工具参数连续未通过 Schema 校验',
    userFacingPrompt: '已重置当前轮并切换至本地确定性 SRE 引擎（基于真实遥测与 Runbook 推演）',
    recoveryCondition: '下一轮对话请求恢复有效 API Key 且云端流式响应通过首字与 Schema 校验',
    forbiddenClaims: ['由云端大语言模型实时生成', '多模态云端视觉直接识别当前截图'],
  },
  {
    id: 'webgpu-fallback',
    tier: 2,
    name: '端侧日志审计降级（WebGPU / WASM → 内置确定性规则）',
    triggerCondition: '浏览器不支持 WebGPU/WASM、权重加载失败、或端侧 Worker 初始化超时',
    userFacingPrompt: '端侧模型未就绪，已切换 builtin（内置规则）审计模式（日志仍 100% 本地处理）',
    recoveryCondition: '浏览器启用 WebGPU/WASM 并成功完成 ONNX 模型初始化与 READY 握手',
    forbiddenClaims: ['WebGPU 神经网络模型实时推理完成'],
  },
  {
    id: 'sse-synthetic',
    tier: 3,
    name: '遥测传输降级（SSE 实时流 → 本地合成推演 + 自动重连）',
    triggerCondition: 'EventSource 连续错误达到阈值（>= 2 次）、连接被预算拒绝或服务端 live 模式连续 3 次采集失败',
    userFacingPrompt: '实时遥测流已降级为本地确定性合成推演引擎（支持自动重连恢复）',
    recoveryCondition: '模式或混沌场景重连成功并收到有效 schemaVersion 遥测帧',
    forbiddenClaims: ['当前数字来自远端 Kubernetes 实时 API 采样'],
  },
  {
    id: 'webgl-snapshot',
    tier: 4,
    name: 'WebGL 上下文丢失兜底（3D 动态渲染 → 静态快照冻结）',
    triggerCondition: '浏览器 GPU 进程重置或驱动抢占触发 canvas webglcontextlost 事件',
    userFacingPrompt: '图形上下文已丢失，正在恢复…（静态快照与 2D 巡检面板仍可交互）',
    recoveryCondition: '收到 webglcontextrestored 事件后自增 remountKey 重建 3D 画布并清空丢失状态',
    forbiddenClaims: ['60FPS 实时 WebGL 三维渲染运行中'],
  },
  {
    id: 'topology-2d',
    tier: 5,
    name: '拓扑视图降级（3D WebGL 异常 → 2D 轻量 SVG 集群拓扑）',
    triggerCondition: 'Canvas 渲染边界捕获异常、环境不支持 WebGL、上下文恢复超时或用户手动切至 2D 兼容视图',
    userFacingPrompt: '已切换至 2D 轻量 SVG 集群拓扑兼容视图（支持节点/Pod 巡检与 Copilot 诊断闭环）',
    recoveryCondition: '点击「切回 3D 拓扑」或 WebGL 环境恢复并重置画布错误边界',
    forbiddenClaims: ['三维空间光影、WebGL 实例粒子与镜头运镜特效处于激活态'],
  },
] as const;

/**
 * 按降级层级 ID 查找对应矩阵规范条目。
 *
 * @param id 降级层级标识符
 * @returns 对应的矩阵条目（找不到时回退首项以保持全覆盖）
 */
export function getDegradationTier(id: DegradationTierId): DegradationMatrixItem {
  return DEGRADATION_MATRIX.find((item): boolean => item.id === id) ?? DEGRADATION_MATRIX[0];
}
