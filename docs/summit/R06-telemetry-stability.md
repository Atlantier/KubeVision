# R06 · 遥测时序稳定性（QPS 锚定 / 节点均值回归 / 时间戳 / live 采集 / 免疫边界）

> 本文记录 r13 的根因定位、修复与实测曲线。
> 所有数字来自本机实跑：`scripts/sim-drift.mjs`（离线 300 tick）+ `scripts/probe-r13.mjs`（真实 SSE 探针）。

---

## 1. 根因复核（全部复现）

| # | 现象 | 根因 | 复现证据 |
|---|---|---|---|
| A | QPS 12850 → 3298 → 1059 → 7629 | `qpsBaseline = prevSnapshot.totalQps`：每 tick 在**上一帧输出**上再乘 `(1+wave+noise)`，是乘性递推（复利漂移） | 300 tick：12850 → 833，曲线指数衰减 |
| B | 三节点 CPU 39/34/30 → 0/0/0，健康分仍 100 | 节点 CPU/MEM 写成 `current + noise*1.8`（随机游走），**没有回归项**；Pod 有 `REVERSION_RATE=0.18`，节点没有 | 300 tick：三节点 min 0 / max 100 |
| B' | 节点长期卡 HighLoad 琥珀态 | 节点 status 在正常态硬编码 `'Ready'`，与真实水位脱钩；故障解除后无人把它恢复 | 旧代码正常分支 `status = 'Ready'` 恒定 |
| C | 跨连接 / 跨模式时间戳跳变 | 时间轴从固定种子时间戳累加，与真实墙钟偏差随时间放大 | 本次改为连接建立即锚定 `Date.now()` |
| D | live+K8s 模式 Pod 内存恒 0 | `usageByPod` 解析了 `mem` 但 `memUsage: null` 写死，解析结果被丢弃 | 代码复核（liveTelemetry L810-819） |
| E | 自愈一个 Pod 会"洗白"无关节点 | `reconcileSnapshot` 遍历**所有**节点，凡名下无异常 Pod 就置 Ready 并改写水位 | 代码复核（节点修正无作用域判断） |

---

## 2. 改动

### A · QPS 锚定（`src/utils/syntheticEngine.ts`）

```ts
/** 不可变基准：从种子快照派生一次 */
export const QPS_BASELINE: number = INITIAL_CLUSTER_SNAPSHOT.totalQps;

// 每 tick：只表达"相对基准的瞬时偏离"，与历史无关
const totalQps = Math.round(QPS_BASELINE * (1 + wave + noise) * penalty);
```

旧写法 `prevSnapshot.totalQps * (1 + ...)` 被移除。中文 JSDoc 说明"复利漂移"的成因
（乘性递推 → 长期均值只要偏离 1 就指数收敛）。

### B · 节点均值回归（同上文件）

```ts
next = current + (baseline − current) · NODE_REVERSION_RATE + noise
```

- `NODE_REVERSION_RATE = 0.18`（与 Pod 同构）；
- baseline 由 `resolveNodeBaseline()` 提供，**不可变先验**：
  1. 种子快照同 rackIndex 的节点值（demo 100% 命中：alpha 44/57、beta 39/62、gamma 35/52）；
  2. live 真实节点名兜底：按 `nodeId` 做 FNV-1a 哈希映射进契约区间
     CPU 24–38、MEM 42–56（确定性、无 `Math.random`）；
- 故障分支保持原有规则（CPU 尖峰推 [92,99]、OOM 内存推 88、分区吞吐降至 12%）；
- 故障解除后走正常分支 → 按回归曲线回基线，**恢复过程可观察**；
- 节点状态改由**实际水位**推导：CPU ≥ 85 或 MEM ≥ 88 → `HighLoad`；
  并且"名下 Pod 全部 Running 且非故障机架" → 强制回 `Ready`。

### C · 时间戳（`src/app/api/telemetry/route.ts`）

- `SEED_TIMESTAMP_MS` **保持不变**，仍是 SSR 初始快照的编译期常量；
- SSE 连接建立时取
  `origin = max(Date.now(), since + 1 tick, 种子时间戳)`：
  1. 锚定真实墙钟；2. 严格大于客户端 `since`；3. 不早于种子时间戳（SSR→首帧不倒退）；
- live 帧时间戳用**采集完成时刻**，再与「上一帧 + 1 tick」取 max，保证严格单调。

### D · live 采集（route + `src/utils/liveTelemetry.ts`）

| 项 | 实现 |
|---|---|
| 在飞互斥 | `liveInFlight` 布尔锁：上一帧未完成就跳过本 tick，杜绝请求堆积与帧乱序 |
| 帧时间戳 | 按采集**完成**时刻单调递增 |
| 失败处理 | 保留上一帧（不更新 `snapshot`）并计数；连续 3 次 → 关闭 live、切到合成数据源、`console.warn` 写审计行 |
| overlay 复利 | 新增 `liveRaw`（未叠加的真实快照）作为下一轮采集基准，叠加只作用于输出 |
| Pod 内存 | 解析出的字节按「节点内存容量 ÷ 该节点 Pod 数」折算成百分比回填，不再恒 0 |

### E · 免疫合并边界（`src/hooks/useTelemetryStream.ts`）

- 节点 Ready 修正**只对免疫目标 Pod 所属节点生效**，其余节点原样保留（不洗白）；
- 窗口到期后被改写的 Pod 做**一帧插值**回落：`display + (server − display) × 0.5`，
  插值标记随即删除，下一帧起完全使用服务端数据（不允许突跳）。

### F · 约束遵守

- 无 `Math.random`：仍只用 `hashNoise` + 新增 `hashStringSeed`（FNV-1a）；
- `syntheticEngine` 仍是纯函数（输入快照 → 新快照，无副作用）；
- `PodEntity` / `WorkerNodeEntity` 字段契约未变；
- 未改任何视觉组件、未改演示台词。

---

## 3. 300 tick 前后曲线（ASCII）

### 3.1 QPS

**修复前**（`docs/summit/artifacts/r13-drift-before-300ticks.log`）

```
  首帧 11350 → 末帧 833 | min 620 max 11350 avg 3394
11350 |*
 9817 |
 8284 |      **                               *
 6751 |     *                                *       **
 5219 | *      *     **       *      **        *    *
 3686 |  ***        *  *     * *       *    *   *      *     **
 2153 |         ****    *  **   *  **   ****     ***    *   *  *
  620 |                  **      **                      ***    ***
```

**修复后**（`r13-drift-after-300ticks.log`）

```
  首帧 11350 → 末帧 14007 | min 11059 max 14635 avg 12779.3
14635 |                     *       *      **
14124 |    **      **      *       *               **      **
13613 |      *       *       *       *    *  *       *       *
13102 |   *       *       *       *               *       *       *
12592 |               *       *       *       *       *       *
12081 |  *    *  *       *       *       *       *
11570 |*        *      *       **      **      **      * *     **
11059 | *      *        *                               *           *
```

有界（±13% ≈ 波动幅度理论值），不再指数衰减。

### 3.2 节点 CPU

| 节点 | 修复前 | 修复后 |
|---|---|---|
| worker-alpha | min 0 / max 100 / avg 53.1 | min 32.8 / max 55.5 / avg **43.3**（基线 44） |
| worker-beta | min 0 / max 100 / avg 52.2 | min 27.8 / max 50.5 / avg **38.2**（基线 39） |
| worker-gamma | min 0 / max 100 / avg 51.7 | min 23.8 / max 46.5 / avg **34.3**（基线 35） |

三节点 300 tick 全程**无状态跳变**。600 tick 复核：QPS 11056–14635（avg 12825），
三节点均值仍为 43.1/38.1/34.1，`statusChanges: []`。

### 3.3 故障恢复曲线（worker-alpha，20 tick 尖峰 + 40 tick 稳态）

```
  tick  0-19: NODE_CPU_SPIKE    tick 20-59: NONE
    1 NODE_CPU_SPIKE cpu=   92% ###############################    HighLoad
   13 NODE_CPU_SPIKE cpu= 95.3% ################################   HighLoad
   20 NODE_CPU_SPIKE cpu= 95.4% ################################   HighLoad
   21 NONE           cpu= 86.1% #############################      Ready
   22 NONE           cpu=   78% ##########################         Ready
   28 NONE           cpu= 52.5% ##################                 Ready
   34 NONE           cpu= 45.1% ###############                    Ready
   40 NONE           cpu= 39.3% #############                      Ready
   58 NONE           cpu=   33% ###########                        Ready
  → 故障解除后首帧 86.1% · 第 10 帧 48.9% · 第 20 帧 39.3% · 终态 Ready
```

尖峰解除后按指数回归曲线平滑回落，并自动摘掉 HighLoad。

---

## 4. 运行时探针（真实 SSE，11/11 通过）

`node scripts/probe-r13.mjs`：

```
▸ A/B · 稳态采样（30 帧）
  → QPS: min=11104 max=14241 avg=12880（基准 12850，允许 ±20%）
  ✓ A · QPS 锚定在基准 ±20% 内（无复利漂移）
  ✓ B · worker-alpha CPU 有界（15~70）  ::  min=44.1 max=47.7
  ✓ B · worker-beta  CPU 有界（15~70）  ::  min=39.3 max=42.6
  ✓ B · worker-gamma CPU 有界（15~70）  ::  min=35.3 max=38.8
  ✓ B · 稳态下无节点状态跳变  ::  0 次

▸ C · 时间戳
  ✓ C · demo 流时间戳严格单调递增  ::  1794287655711 → 1794287686711
  ✓ C · 首帧时间戳贴近墙钟（SSE 后以 Date.now() 为起点）  ::  偏差 922ms
  ✓ C · demo→live 切换不倒退且跳变 <= 1 tick + 网络时延  ::  gap=2000ms

▸ E · 免疫合并边界
  → 免疫期间 alpha=HighLoad(96.6%) beta=Ready(35.5%)
  ✓ E · 无关节点（worker-alpha）未被自愈"洗白"  ::  alpha 仍 HighLoad cpu=96.6
  ✓ E · 免疫目标 Pod 所属节点回到 Ready  ::  beta=Ready cpu=35.5
  → Pod 内存样本: 28.4 → 28.4 → 28.4 → 33 → 33 → 33 → 38.5 → ...
  ✓ E · 窗口到期后一帧插值平滑回落（无突跳）  ::  immune=28.4 mix=33 settled=40.5 比例=0.38
```

> 关于 E 的测试方式：不能用 `healEntity` 驱动探针——它按设计把"修复动作"当作
> 本轮演练的终止信号并清空 chaos，那样 alpha 回 Ready 是正确行为，会被误判成
> "节点被洗白"。探针改为**只写 `healedPodIds`**、保持演练场景不变，
> 才能单独检验节点修正的作用域。

---

## 5. 未验证项与风险

1. **真实 K8s 集群路径未实测**：本机没有 K8s API，D 的"内存回填"只做了代码级验证
   （`parseQuantity` → 字节 → 百分比折算链路），未在真实 metrics-server 上跑过。
   折算分母（节点容量 ÷ Pod 数）是估值，Pod 有 limit 时会与真实占比不一致。
2. **连续 3 次失败降级的触发路径未实测**：需要构造持续采集失败；
   已通过代码复核与 `liveRaw` 基准隔离保证不会复利，但没有端到端证据。
3. **节点 CPU 波动幅度 ±11 个百分点**：由 `噪声幅度 2.2 / 回归率 0.18` 决定，
   比修复前的 0~100 小得多，但仍比真实集群抖。若视觉上嫌晃，可下调
   `NODE_CPU_NOISE_AMPLITUDE`（当前 2.2），但会略微削弱"活数据"观感。
4. **`HighLoad` 阈值（CPU 85 / MEM 88）是新增判定**：稳态下不会触发；
   若未来引入持续高负载场景需要重新校准。

---

## 6. 复现与回滚

```bash
node scripts/sim-drift.mjs --ticks=300      # 离线 300 tick 曲线
node scripts/sim-drift.mjs --ticks=600 --json
node scripts/probe-r13.mjs                  # 真实 SSE 探针（需 pnpm dev）
node scripts/verify-demo.mjs --skip-repeat  # 演示链路回归（19/19 通过）
```

回滚：`git revert --no-edit <r13 commit>`（仅回滚本轮引擎/流层修复）。