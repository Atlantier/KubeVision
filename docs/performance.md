# KubeVision AI — 性能实测数据

> 采集时间：2026-11-11T05:04:38.416Z
> 所有数字均为实测值，未做理论填充。

## 运行环境

| 项目 | 值 |
|---|---|
| 操作系统 | win32 x64 · AMD Ryzen 9 7845HX with Radeon Graphics · 31GB RAM |
| Node | v24.16.0 |
| WebGL 渲染器 | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) |
| WebGL 厂商 | Google Inc. (Google) |
| 稳态 DPR | 1 |

## 渲染性能（1920×1080 稳态）

> **本数据采集于 SwiftShader 软件光栅化环境（无 GPU 加速）**。
> FPS 与 Frame Time 显著低于真实显卡，仅供参考渲染循环是否健康；
> **Draw Calls 与 Triangles 为硬件无关指标，可作批量渲染优化的有效证据**。

采样 20 次，间隔 600ms。

| 指标 | 均值 | 中位数 | P95 | 最小 | 最大 |
|---|---|---|---|---|---|
| FPS | 3 | 3 | 6 | 1 | 6 |
| Frame Time (ms) | 507.2 | 302.1 | 1717.1 | 178 | 1717.1 |
| Draw Calls | 421.65 | 423 | 423 | 420 | 423 |
| Triangles | 205984.8 | 206028 | 206028 | 205932 | 206028 |

**视口休眠**：前台 `frameloop=always` → 后台 `frameloop=demand` 已生效

## 批量渲染优化效果

| 项目 | 数量 |
|---|---|
| 普通 Mesh | 322 |
| InstancedMesh | 25 |
| 实例总数 | 1026 |
| Points | 6 |
| Lines | 5 |
| **实际 Draw Calls** | **420** |

> 1026 个实例通过 25 个 InstancedMesh 批量提交，
> 若逐个 Mesh 渲染需 1348 次 draw call，实际仅 420 次。

## 端侧推理性能

运行时：**builtin (fallback)** · 状态：READY (WebGPU)

采样 25 条日志分类。

| 指标 | 均值 | 中位数 | P95 | 最小 | 最大 |
|---|---|---|---|---|---|
| 单条分类延迟 (ms) | 0.1 | 0.08 | 0.3 | 0 | 0.3 |

## API 延迟

| 项目 | 均值 | 中位数 | P95 |
|---|---|---|---|
| RAG 混合检索 (ms) | 8.75 | 8.63 | 10.91 |

## 隐私脱敏吞吐

批量 100 条，实测吞吐 **12830 条/秒**
（均值延迟 7.79 ms）。

## 构建产物与包体积

```
Route (app)                              Size     First Load JS
┌ ○ /                                    88.9 kB         176 kB
├ ○ /_not-found                          873 B          88.4 kB
├ ƒ /api/chat                            0 B                0 B
├ ƒ /api/dev/corpus                      0 B                0 B
├ ƒ /api/dev/rag-eval                    0 B                0 B
├ ƒ /api/logs/live                       0 B                0 B
├ ƒ /api/mcp                             0 B                0 B
├ ƒ /api/mcp/execute                     0 B                0 B
├ ƒ /api/telemetry                       0 B                0 B
├ ƒ /api/verify/rag                      0 B                0 B
└ ƒ /api/verify/sanitize                 0 B                0 B
+ First Load JS shared by all            87.5 kB
├ chunks/671-4d40437f8264c8b6.js       31.6 kB
├ chunks/c070312d-5aa631408e1f09fd.js  53.6 kB
└ other shared chunks (total)          2.27 kB
```

## 采集说明

- FPS / Frame Time 采集于 SwiftShader 软件光栅化环境（无 GPU 加速），数值显著低于真实显卡。**Draw Calls 与 Triangles 不受影响**，仍可作为批量渲染优化的有效证据。
- 端侧推理运行在内置确定性分类器（外部模型权重未加载：离线/镜像不可达/或超过 3500ms 熔断）。延迟数据反映的是内置分类器，不是神经网络推理。

---

*本文件由 `scripts/benchmark.mjs` 自动生成，重新运行可刷新数据。*