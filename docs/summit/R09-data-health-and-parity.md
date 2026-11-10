# R09 · 数据健康自监控、协议版本与模式等价性

> 本轮三件事：① Shift+P HUD 增加「数据健康」区块（瞬态轨直写 DOM，零重渲染）；
> ② 遥测快照引入 `schemaVersion` + 未知版本只读降级 + 120 帧环形缓冲
> （供复盘报告生成事故时间线）；③ demo / live 故障语义等价性校验，
> 结果写入白皮书新增的「第七章：数据边界声明」。
>
> 一句话立场：**"我们连自己的数据都要监控。"**

---

## 1. 数据健康 HUD（追问 1）

### 1.1 展示内容

在 Shift+P 性能 HUD 内新增「数据健康」区块，6 项指标：

| 指标 | 含义 | 琥珀阈值 |
|---|---|---|
| QPS 偏差 | 相对不可变基线 12850 的偏差比例 | > ±15% |
| 节点水位偏离 | 三节点相对角色基线的最大偏离（百分点） | > 10pp |
| 快照间隔抖动 | 收帧间隔相对 1s 的绝对偏差（EWMA） | > 400ms |
| SSE 重连 | 自页面加载起的建连次数 | > 0 |
| 免疫改写 | 自愈窗口内被改写的 Pod 条数 | > 0 |
| 协议版本 | 当前帧 schemaVersion（期望 v2） | 不匹配转玫红 |

### 1.2 零重渲染实现

- 写入端：`src/utils/telemetryHealth.ts` 模块级单例，由 SSE `deliver()` 直接赋值；
- 读取端：HUD 子组件用 `setInterval(250ms)` **直接写 DOM 的 textContent / className**，
  **不调用任何 setState**——因此 4Hz 刷新也不会触发 React 渲染；
- 与主 HUD 的 2Hz `setState` 采样形成对照：主 HUD 字段少、可接受低频渲染；
  数据健康区块证明"监控自身数据"不等于"给自己增加渲染负担"。

### 1.3 运行时验证（7/7）

```
✓ Shift+P 打开性能 HUD
✓ HUD 内存在「数据健康」区块
✓ 数据健康区块渲染 6 项指标  ::  ["-11.1%","1.8pp","964ms","2","0","v2"]
✓ 指标随遥测流持续刷新（读瞬态轨而非静态占位）
   ::  ["-11.1%","1.8pp","964ms","2","0","v2"] → ["-11.6%","2.1pp","476ms","2","0","v2"]
✓ HUD 展示 SSE 重连计数（来自 telemetryHealthRef）
✓ 协议不匹配时 HUD 显示只读提示
✓ 恢复后只读提示自动消失
```

> 抖动 964ms 偏高是 SwiftShader 无头环境下的真实收帧抖动（首屏编译期），
> 会由琥珀色如实暴露——这正是这个区块存在的意义。

---

## 2. 协议版本与帧缓冲（追问 2）

### 2.1 schemaVersion 契约

- `TelemetrySnapshot` 新增只读 `schemaVersion`（当前 `TELEMETRY_SCHEMA_VERSION = 2`）；
- 引擎（demo 演进 + live 叠加层）与两套 live 采集器（宿主机 / K8s）产出的每一帧都带版本；
- 客户端在 `useTelemetryStream.onmessage` 做**严格版本协商**：

| 收到版本 | 行为 |
|---|---|
| === 2 | 正常应用，清除只读提示 |
| 缺失（0/undefined） | **只读降级**：不应用新帧，保留最后一帧合法画面 |
| > 2 | 同上（服务端已升级） |

只读状态写入 Store（低频），HUD 显示提示条（`aria-label="遥测只读提示"`）。
不做"尽力解析"：字段语义不确定时继续画，会得到"画面在动但数字不对"的状态，比停更危险。

### 2.2 120 帧环形缓冲

`src/utils/snapshotRingBuffer.ts`：

- 容量 120 帧（1Hz × 2 分钟），定长、超限丢最旧；
- 存**免疫合并后**的展示帧（与观众当时看到的一致）；
- `buildIncidentTimeline()` 逐帧 diff 推导变化点：告警出现/解除、健康分骤降/回升；
- `renderIncidentTimelineMarkdown()` 直接产出复盘报告可插入的表格。

复盘报告接入方式（保持主函数纯函数）：

- `PostMortemInput` 新增可选 `incidentTimelineMarkdown`；
- 新增导出 `buildPostMortemMarkdownWithLiveTimeline(input)`：
  唯一有副作用的入口，自动从环形缓冲填充时间线。

### 2.3 单测（9/9）

```
✔ A-1 300 tick 混沌轮换：QPS / CPU / 健康分全部在有界区间内
✔ A-2 同种子同输入 ⇒ 输出逐字节一致；不同 tick 必不同
✔ A-3 时间戳严格 +1000ms；重连 since 场景单调
✔ A-4 cpuHistory/memHistory 恒为 6 且末位等于当前值；podIds ↔ nodeId 双向一致
✔ A-5 chaos 复位后 60 tick 内节点回到基线 ±8%
✔ A-6 新增 P0 告警后健康分不升（单调性）
✔ A-7 每一帧都携带当前 schemaVersion
✔ B 属性测试：200 组随机种子 × 60 tick 全程不变量成立
✔ B-2 环形缓冲保留最近 120 帧，并可从告警变化推导事故时间线
ℹ tests 9 · pass 9 · fail 0
```

---

## 3. demo / live 故障语义等价性（追问 3）

### 3.1 校验方法

`scripts/verify-mode-parity.mjs`：

1. demo 侧：种子快照连续演进 40 tick；
2. live 侧：构造**宿主桥接 mock**（与种子同拓扑、CPU/内存数值完全不同），
   再走 `applyLiveChaosOverlay` —— 这样比较的是"叠加层语义"，而不是数值本身；
3. 提取与数值无关的语义：受害者数/集合、节点状态、告警级别分布、健康分。

### 3.2 结果（3/3 场景语义一致）

| 混沌场景 | 受害者数（demo / live） | 节点状态（demo / live） | 告警级别（demo / live） | 一致性 |
|---|---|---|---|---|
| OOM 风暴 | 3 / 3 | [Ready, Ready, Ready] / 同 | P0:3 / P0:3 | 一致 |
| 网络丢包 | 2 / 2 | [Ready, Ready, NetworkPartition] / 同 | P0:1 / P0:1 | 一致 |
| CPU 尖峰 | 0 / 0 | [HighLoad, Ready, Ready] / 同 | P0:0·P1:1 / 同 | 一致 |

连健康分都相同（77 / 81 / 93）。说明 live 叠加层复用的
`evolvePod*` / `evolveNode` / `buildAlerts` / `computeClusterHealthScore`
与 demo 引擎完全同源，切换数据源不会改变"故障长什么样"。

### 3.3 白皮书落地

白皮书新增 **第七章：数据边界声明**，含：

- 7.1 demo / live 数据来源边界（哪些数值是合成、哪些是实测）；
- 7.2 协议版本与降级边界；
- 7.3 故障语义等价性（**由脚本生成**的 PARITY 表格区块，禁止手抄）；
- 7.4 帧缓冲与复盘边界（2 分钟窗口、刷新即清空）；
- 7.5 明确不声称的指标清单。

---

## 4. 脚本登记

| pnpm 脚本 | 命令 |
|---|---|
| `verify:telemetry` | `node scripts/verify-telemetry.mjs`（9 用例 + 200 组属性测试） |
| `verify:parity` | `node scripts/verify-mode-parity.mjs`（demo/live 语义对照） |
| `probe:health` | `node scripts/probe-data-health.mjs`（HUD 运行时探针） |

---

## 5. 回归

| 项目 | 结果 |
|---|---|
| `verify-telemetry` | 9/9 |
| `verify-mode-parity` | 3/3 场景一致 |
| `probe-data-health` | 7/7 |
| `verify-demo --skip-repeat` | 19/19 |
| `tsc` / `next lint` | 0 错误 / 干净 |
| `docs:metrics --check` | 干净（PARITY 区块幂等） |

---

## 6. 未验证项与风险

1. **只读降级的真实触发未端到端验证**：目前通过直接驱动 Store 验证 UI 绑定，
   未构造"服务端推 v3 帧"的场景（需要改服务端或用代理注入）；
2. **环形缓冲只存展示帧**：若免疫窗口内发生告警，时间线记录的是"被改写后"的状态，
   复盘时需要结合终端日志交叉验证；
3. **等价性只覆盖 3 个场景 × 1 个 mock 底盘**：真实 K8s 集群的 Pod 数量/拓扑不同，
   `applyLiveChaosOverlay` 的"机架无 Pod 时退化按索引选取"分支未纳入语义对照；
4. **数据健康阈值是经验值**（±15% / 10pp / 400ms）：无头环境下抖动经常超 400ms，
   现场真机可能偏保守，需要按环境调 `telemetryHealth.ts` 常量。