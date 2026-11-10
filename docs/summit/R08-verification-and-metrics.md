# R08 · 遥测长跑测试、指标口径统一与验收证据

> 本轮四件事：① 新增 `verify-telemetry`（node:test 纯函数长跑 + 属性测试）；
> ② 指标口径统一（benchmark 双跑一致性 + 文档数字脚本生成）；
> ③ 验收证据落盘（终端日志 + 截图）；④ 脚本登记。
>
> **本轮附带修掉三个真实缺陷**（由新测试直接发现），见 §1.3。

---

## 1. `scripts/verify-telemetry.mjs`

### 1.1 为什么直接 import 引擎、不起服务

引擎是纯函数（快照进 → 快照出，无 `Date.now()` / `Math.random()`）。
用 CDP 跑 300 tick 要等真实时间 5 分钟，纯函数版 **130ms** 跑完 7 用例 +
200 组属性测试。失败是确定性的，不依赖 GPU / 网络 / 时序。

实现方式：用仓库自带的 `typescript` 把三个无外部依赖的 TS 文件转译成
CommonJS（`@/` 别名改写为相对 require），再动态 require。

### 1.2 用例与结果

```
✔ A-1 300 tick 混沌轮换：QPS / CPU / 健康分全部在有界区间内 (8.09ms)
✔ A-2 同种子同输入 ⇒ 输出逐字节一致；不同 tick 必不同 (7.56ms)
✔ A-3 时间戳严格 +1000ms；重连 since 场景单调 (1.25ms)
✔ A-4 cpuHistory/memHistory 恒为 6 且末位等于当前值；podIds ↔ nodeId 双向一致 (7.88ms)
✔ A-5 chaos 复位后 60 tick 内节点回到基线 ±8% (0.94ms)
✔ A-6 新增 P0 告警后健康分不升（单调性） (0.13ms)
✔ B 属性测试：200 组随机种子 × 60 tick 全程不变量成立 (88.79ms)
ℹ tests 7 · pass 7 · fail 0 · duration_ms 124.76
```

**A-1 的口径说明（必须如实标注）**：

| 指标 | 断言 | 说明 |
|---|---|---|
| QPS | 稳态帧 ∈ [0.85, 1.15]×基线；故障帧 ∈ 惩罚系数 ±15% | 故障场景按设计下挫（OOM 0.82 / SPIKE 0.9 / NET 0.72），"300 tick 全程 0.85~1.15"只有在**排除故障帧**后成立 |
| 节点 CPU | 非受灾节点 ∈ [10, 90]；受灾节点按故障语义豁免 | CPU 尖峰目标区间是 92~99，严格 [10,90] 会与设计冲突 |
| 健康分 | ∈ [0, 100] | 全程成立 |

### 1.3 新测试抓到的三个真实缺陷（已修）

**缺陷 1：`hashNoise` 不是噪声，是一条缓慢斜坡**

旧实现是裸 xorshift32。对**小整数种子**（tick 从 1 开始，种子形如 `tick*67+11`）
没有雪崩效应，连续的种子输出近乎单调：

```
hashNoise(78)≈0.01, hashNoise(145)≈0.02, hashNoise(212)≈0.03 …
tick 21~80 的均值 = 0.41（理论应为 0）
```

后果：所谓"零均值噪声"其实是一个缓慢漂移项——节点水位会跟着它爬升/下滑。
这也解释了上一轮"故障恢复后节点回不到基线"的现象。

修复：改用 lowbias32 终混（两次 `Math.imul` + 高低位 xor），小种子也能瞬间雪崩。
修复后 300 tick 稳态均值：44.1 / 35.9 / 39.9（基线 44 / 36 / 40），基本无偏移。

**缺陷 2：历史序列末位 ≠ 当前值**

`PodEntity` 契约写明「cpuHistory 索引 5 为当前值」，但引擎写入的是
`round0(cpu)`（整数），而 `cpuUsage = round1(cpu)`（一位小数）：
`cpuHistory[5]=46` 而 `cpuUsage=45.5`。契约被违反。修复为写入同一变量。

**缺陷 3：故障分支仍在"每帧累加/累减"**

NET 分支 `cpuUsage = node.cpuUsage - 8`、OOM 分支 `cpuUsage + 5`、SPIKE 分支
`node.memUsage + 3` 都是累计运算：43 tick 的丢包演练能把 CPU 从 44 打到 5%，
故障解除后要很久才爬回来。修复为相对**基线**的偏移（`baseline.cpu - 8` 等）。

---

## 2. 指标口径统一

### 2.1 benchmark 双跑一致性

问题：`benchmark.mjs` 收尾会执行 `next build` 写 `.next`，**打坏仍在运行的
dev server**（实测：build 后再访问返回 500）。若第二遍复用这个 server，
benchmark 会判定"未就绪"，110 秒后拿不到渲染数据（实测第二遍
`rendering` / `batching` 全为空）。

新增 `scripts/benchmark-consistency.mjs`：每遍开始前释放 3000 端口，
让 benchmark 按自身设计独占 dev server 与 `.next`。

```
══════════ 两遍采集对比 ══════════
  差异字段总数: 24
  必须一致（硬件无关）:
    ✓ 场景对象 meshes: 311 / 311
    ✓ InstancedMesh: 24 / 24
    ✓ 实例总数: 972 / 972
    ✓ Triangles 中位: 188738 / 188738
    ✓ 首屏路由体积: "┌ ○ /  84.8 kB  172 kB" / 同左
  允许波动（运行时相关）:
    · FPS 中位: 2 → 2
    · 帧时间均值: 626.03 → 655.02
    · Draw Calls 中位: 403 → 403
    · RAG 均值: 7.02 → 6.33
    · 脱敏吞吐: 16418 → 19232
    · 端侧延迟均值: 0.07 → 0.18
✓ 硬件无关指标两遍完全一致（5 项）
```

**结论口径**：硬件无关指标（场景几何、构建产物）两遍**逐字节一致**；
时间类指标（FPS/帧时间/延迟/吞吐）受调度与软件光栅化影响，**不承诺一致**，
文档中也标注为"不作为性能证据"。

### 2.2 文档数字脚本生成

新增 `scripts/sync-docs-metrics.mjs`：从 `docs/performance.json`（benchmark 产出）
与 `docs/verify-summary.json`（验收产出）重新生成标记区块：

```
<!-- METRICS:BEGIN --> … <!-- METRICS:END -->
<!-- VERIFY:BEGIN --> … <!-- VERIFY:END -->
```

- 支持**块级**（表格，内容前后换行）与**行内**（表格单元格/句子中间，不换行）两种形态；
- 支持同一文档**多处**同名区块（README 既有评分表行内计数，又有验收章节句子）；
- `--check` 模式：文档与实测不一致时退出码 1（可入 CI）。

本轮从文档中清掉的矛盾数字：

| 位置 | 旧值（手写） | 新值（生成） |
|---|---|---|
| README 工程质量表 | Draw Calls 307（10 个 InstancedMesh / 352 实例） | 403（20 次采样 400~403）/ 24 个 InstancedMesh / 972 实例 |
| README 实测快照 | RAG 11.14ms · 吞吐 9,573 条/秒 | RAG 7.02ms · 16,418 条/秒 |
| README 实测快照 | 场景对象 237 Mesh / 6 Points / 2 Lines | 311 Mesh / 4 Points / 3 Lines |
| README ×3 / 白皮书 ×2 | "32 项检查全绿" | **通过 33 · 失败 0 · 跳过 0（共 33 项）** |
| 白皮书 6.3/6.4 | RAG 11.14ms、吞吐 9,573 条/秒 | 指向同一张生成表 |

### 2.3 README 增加数据采集环境声明

```
> 数据采集环境与时间：每个数字都由 node scripts/benchmark.mjs 在同一台机器一次性采集
> （采集时间见表格首行），由 sync-docs-metrics.mjs 自动写入——不接受手抄。
> FPS 与帧时间严格不作为性能证据：场景在 SwiftShader 软件光栅化（无 GPU）下运行。
> 可作证据的是：① 硬件无关指标（Draw Calls / Triangles / 场景对象数）；
> ② 真实耗时（RAG / 脱敏 / 端侧分类）；③ 构建产物（首屏 JS）。
```

### 2.4 验收证据

新增 `scripts/capture-evidence.mjs`：真实执行 `node scripts/verify.mjs`，
捕获完整输出 → 解析汇总 → 写 `docs/verify-summary.json` 与
`docs/evidence/verify-<时间戳>.log`；再把输出渲染成终端样式页面，
用 headless Edge 截图落盘 `docs/evidence/verify-<时间戳>.png`。

本轮实测：**总计 33 项 · 通过 33 · 失败 0 · 跳过 0**（退出码 0）。

---

## 3. 脚本登记

| pnpm 脚本 | 命令 |
|---|---|
| `verify:telemetry` | `node scripts/verify-telemetry.mjs` |
| `docs:metrics` | `node scripts/sync-docs-metrics.mjs` |
| `docs:evidence` | `node scripts/capture-evidence.mjs` |
| `benchmark:consistency` | `node scripts/benchmark-consistency.mjs` |

---

## 4. "仍无法自证的指标"清单与演示话术

| 指标 | 为什么无法自证 | 演示话术（照读即可） |
|---|---|---|
| **真机 FPS / 帧时间** | 采集环境是 SwiftShader 软件光栅化（无 GPU），数值被压低 30~50 倍 | "我们**不把 FPS 当性能证据**。真正能证明渲染优化的是硬件无关指标：Draw Calls 403、Triangles 18.8 万、972 个实例压进 24 个 InstancedMesh。真机 FPS 需要在评委的 GPU 上跑，我们提供 `pnpm benchmark` 一条命令复现。" |
| **GPU 显存占用** | WebGL 无标准显存查询接口；`WEBGL_debug_renderer_info` 只暴露渲染器名 | "显存无法从 WebGL 标准接口读取，我们不编造这个数字。可替代证据是实例化后的绘制批次与三角形预算。" |
| **真实 LLM 端到端延迟** | 演示环境按需降级为确定性仿真引擎（离线/无 API Key） | "流式链路与真实 LLM 完全一致（NDJSON 协议、逐 token 渲染、断流降级），延迟取决于评委网络；我们用**确定性引擎**保证现场不依赖外网。" |
| **TTS 语音合成质量** | 无头环境无法验证音频输出 | "语音播报走浏览器 SpeechSynthesis，现场有音响才能验收；仓库内只验证了调用链与失败降级。" |
| **真实 K8s 集群指标** | 本机无 K8s API / metrics-server | "live 模式对接真实 API，代码路径已实现并做类型校验；当前演示环境走宿主机真实采样（CPU/内存/网卡/进程），**不伪造 K8s 数据**。" |
| **多并发用户下的 SSE 表现** | 单机单浏览器采集 | "SSE 每连接独立演进状态、服务端无共享可变状态，理论上可水平扩展；压测数据暂无。" |
| **端侧神经推理延迟** | 模型权重下载不到，降级为内置确定性分类器（0.07ms） | "这个 0.07ms 是**内置分类器降级路径**，不是神经网络推理；真实模型延迟取决于设备 GPU，不在表内。" |

---

## 5. 复现

```bash
pnpm verify:telemetry             # 7 用例 + 200 组属性测试（≈0.2s，无需服务）
pnpm benchmark:consistency        # 两遍 benchmark + 硬件无关指标一致性校验
pnpm docs:evidence                # 跑完整验收 → 汇总 JSON + 日志 + 终端截图
pnpm docs:metrics                 # 用 JSON 重新生成 README/白皮书数字
pnpm docs:metrics -- --check      # CI：文档与实测不一致则退出码 1
```

证据文件：`docs/evidence/`、`docs/verify-summary.json`、`docs/performance.json`。