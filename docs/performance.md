# KubeVision AI — 性能实测数据

> 采集时间：2026-11-14T11:09:52.166Z
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
| FPS | 4.75 | 5 | 6 | 1 | 6 |
| Frame Time (ms) | 280.78 | 188.5 | 892.4 | 172.1 | 892.4 |
| Draw Calls (合计) | 236.35 | 235 | 238 | 235 | 238 |
| Draw Calls (主场景) | 236.35 | 235 | 238 | 235 | 238 |
| Draw Calls (反射 pass) | 0 | 0 | 0 | 0 | 0 |
| Triangles | 206669.2 | 206626 | 206722 | 206626 | 206722 |

**视口休眠**：前台 `frameloop=always` → 后台 `frameloop=demand` 已生效

## 批量渲染优化效果

| 项目 | 数量 |
|---|---|
| 普通 Mesh | 154 |
| InstancedMesh | 27 |
| 实例总数 | 1017 |
| Points | 3 |
| Lines | 4 |
| **实际 Draw Calls** | **235** |

> 1017 个实例通过 27 个 InstancedMesh 批量提交，
> 若逐个 Mesh 渲染需 1171 次 draw call，实际仅 235 次。

## 端侧推理性能

运行时：**builtin (fallback)** · 状态：READY (WebGPU)

采样 21 条日志分类。

| 指标 | 均值 | 中位数 | P95 | 最小 | 最大 |
|---|---|---|---|---|---|
| 单条分类延迟 (ms) | 0.12 | 0.1 | 0.2 | 0 | 0.2 |

## API 延迟

| 项目 | 均值 | 中位数 | P95 |
|---|---|---|---|
| RAG 混合检索 (ms) | 8.39 | 8.07 | 12.05 |

## 隐私脱敏吞吐

批量 100 条，实测吞吐 **11264 条/秒**
（均值延迟 8.88 ms）。

## 构建产物与包体积

```
Route (app)                              Size     First Load JS
┌ ○ /                                    107 kB          194 kB
├ ○ /_not-found                          873 B          88.4 kB
├ ƒ /api/chat                            0 B                0 B
├ ƒ /api/dev/corpus                      0 B                0 B
├ ƒ /api/dev/rag-eval                    0 B                0 B
├ ƒ /api/health                          0 B                0 B
├ ƒ /api/logs/live                       0 B                0 B
├ ƒ /api/mcp                             0 B                0 B
├ ƒ /api/mcp/execute                     0 B                0 B
├ ƒ /api/telemetry                       0 B                0 B
├ ƒ /api/verify/rag                      0 B                0 B
└ ƒ /api/verify/sanitize                 0 B                0 B
+ First Load JS shared by all            87.5 kB
├ chunks/671-01c206979135332e.js       31.6 kB
├ chunks/c070312d-db6a82a68582d39e.js  53.6 kB
└ other shared chunks (total)          2.27 kB
```

## 采集说明

- FPS / Frame Time 采集于 SwiftShader 软件光栅化环境（无 GPU 加速），数值显著低于真实显卡。**Draw Calls 与 Triangles 不受影响**，仍可作为批量渲染优化的有效证据。
- 端侧推理运行在内置确定性分类器（外部模型权重未加载：离线/镜像不可达/或超过 3500ms 熔断）。延迟数据反映的是内置分类器，不是神经网络推理。

---

> 本文件为 `2026-11-14T11:09:52.166Z` 采集的历史受控基准报告（对应原始数据 [`docs/performance.json`](performance.json)；原采样辅助脚本未保留在当前精简提交仓中，当前代码验收请运行 `node scripts/verify.mjs`）。