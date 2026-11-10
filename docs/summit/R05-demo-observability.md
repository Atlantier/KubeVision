# R05 · 路演可观测性与随机演练

> 本文记录三项能力的落地与实测：`verify.mjs --full` 串联与失败证据归档、
> 可复现的随机化演练、排练用可观测性自检面板。
> 所有数字均来自本机实跑（Windows + Edge headless + SwiftShader）。

---

## 1. `verify.mjs --full` 与失败证据归档

### 1.1 串联方式

`scripts/verify.mjs` 新增 `--full`：在「静态 → 单元 → 接口 → 浏览器」四个阶段之后，
以**子进程**方式串跑 `scripts/verify-demo.mjs`，并把其退出码计入汇总。

为什么用子进程而不是 import：

- `verify-demo` 自带独立 CDP 会话、自己的断言计数与退出码；
- 子进程能完整切断状态（浏览器实例、全局变量），失败不污染主进程统计；
- 必须在 `killDev()` 之前运行（它需要活着的 dev server 与 dev-only 的 Store 钩子）。

```
$ node scripts/verify.mjs --full
  模式: --full（追加路演回归 verify-demo）
  ▸ 路演回归（verify-demo）
  ...
  ✓ 路演回归 verify-demo (退出码 0)
  总计 34 项 · 通过 34 · 失败 0 · 跳过 0
  ✓ 全部关键能力验证通过
```

### 1.2 失败证据归档

`verify-demo` 在 `failCount > 0` 时、关闭页面之前自动归档到
`docs/summit/failures/<ISO 时间戳>/`：

| 文件 | 内容 | 为什么需要 |
|---|---|---|
| `store-snapshot.json` | 混沌/选中/自愈表/待执行队列/告警/节点/异常 Pod、`window.__demoDirectorDebug__`、终端日志尾 80 行 | 判断"当时引擎以为自己在做什么" |
| `console.log` | **全量** console（不只 error）+ 未捕获异常 | 很多卡顿是 warn 先出现（React 警告、资源 404） |
| `last-frame.png` | 最后一帧截图 | 画面黑没黑、卡片在不在、字幕写的什么 |
| `failures.json` | 失败断言清单 + 实际值 + 时间 + 目标 URL | 复现线索 |

**验证方式**：`verify-demo` 支持**环境变量** `KV_VERIFY_INJECT_FAILURE=1`（刻意注入一条失败），
用来证明归档链路真的会落盘。

> 为什么只认环境变量、不认命令行参数：这是测试装置的"自伤开关"，
> 一旦被误敲进 CI 或别人的验收命令，会把一次正常的全绿跑成红色。
> 环境变量必须显式导出才生效，不会留在命令历史里被顺手复用。

```powershell
$env:KV_VERIFY_INJECT_FAILURE='1'; node scripts/verify-demo.mjs --skip-repeat
Remove-Item Env:KV_VERIFY_INJECT_FAILURE
```

实测产物：

```
docs/summit/failures/2026-11-10T04-20-01-883Z/
  store-snapshot.json   22.8 KB
  console.log            0.4 KB
  last-frame.png       987.8 KB
  failures.json          0.4 KB
```

实测（两条对照）：

```
A) 传 --inject-failure 参数（应被忽略）     → 通过 19 · 失败 0 · exit 0
B) 导出 KV_VERIFY_INJECT_FAILURE=1          → 通过 19 · 失败 1 · exit 1
   ✗ INJECTED 测试装置自检（KV_VERIFY_INJECT_FAILURE=1）
   失败证据已归档: docs/summit/failures/<时间戳>/
     console.log  failures.json  last-frame.png  store-snapshot.json
```

样本已复制到 `docs/summit/artifacts/r11-failure-archive-sample/`；
运行时目录 `docs/summit/failures/` 已加入 `.gitignore`（不入库）。

---

## 2. 随机化演练（`scripts/verify-demo-drill.mjs`）

### 2.1 设计

维度：**场景顺序**（三套剧本先洗牌）× **节奏**（standard/compact/narrator）×
**网络**（none/slow300/slow800），默认 12 组。

- **确定性 PRNG**：`mulberry32(seed)`，同一 seed 在任何平台产出同一序列；
- **种子契约**：启动打印 `SEED=<n>`；任何一组失败都打印该值与复现命令
  `node scripts/verify-demo-drill.mjs --seed=<n>`；
- **narrator 自动化**：脚本检测 `__demoDirectorDebug__.awaitingNarratorAdvance`，
  自动派发空格键，等效于主讲人按空格；
- **网络条件**：CDP `Network.emulateNetworkConditions`，每组结束恢复。

每组**跑完整场**（跑到引擎自然进入 `finished`，再等 3 秒让自愈链静定），
而不是"看到阶段 4 就停演"。校验项：

| 校验 | 判据 |
|---|---|
| 启动 / 节奏 | 剧本启动成功、节奏按钮生效 |
| 阶段 2 | 出现，且锁定节点名 == 引擎事实推导出的节点 |
| 混沌 | `activeChaos` == 本组剧本场景 |
| 异常 Pod | 崩溃型场景要求 ≥1；CPU 争抢型按设计无异常 Pod（见 §2.2） |
| 阶段 4 | 出现 |
| **完整收尾** | 引擎进入 `finished`（不等同于"进入阶段 4"） |
| **自愈闭环** | `healedPodIds` 非空（所有场景都应有受害者被修复） |
| **MCP 回执** | actionType == 场景映射（NET 的 `drain_node` 降级为 `restart_pod` 也算通过） |
| console | 本组新增 error 为 0 |

单组上限由 `--trial-timeout`（默认 150000ms）控制；早期版本是 75s 且一看到
阶段 4 就 break，等于只验证前半程——"完整演练"必须包含自然收尾与自愈闭环。

### 2.2 首轮暴露的真实问题（不是产品缺陷，是断言写错）

首轮 `--seed=20261110` 结果 **4/12 失败**，且 4 组全是 `NODE_CPU_SPIKE`：

```
| 1 | NODE_CPU_SPIKE | narrator | none   | 失败 | selectedName=worker-alpha abnormalCount=0
| 4 | NODE_CPU_SPIKE | narrator | slow300| 失败 | ...
| 7 | NODE_CPU_SPIKE | narrator | slow300| 失败 | ...
|10 | NODE_CPU_SPIKE | narrator | none   | 失败 | ...
```

根因：`syntheticEngine.evolvePodCpuSpike` **刻意让 Pod 保持 Running**
（`syntheticEngine.ts:437`「Pod 本身没崩，只是被挤占资源」），
因此 CPU 争抢场景**没有异常 Pod**——"异常 Pod ≥1"这条断言对它根本不成立。

修法：断言按场景差异化（崩溃型要求有异常 Pod；争抢型改校验
`activeChaos` 已生效）。这属于**测试预期纠正**，不是产品行为修改。

### 2.3 修正后结果（同一种子）

```
| # | 场景 | 节奏 | 网络 | 结果 | 时长 |
|---|---|---|---|---|---|
| 1 | NODE_CPU_SPIKE | narrator | none | 通过 | 45s |
| 2 | POD_OOM_SWARM | compact | none | 通过 | 27s |
| 3 | NET_PACKET_LOSS | standard | none | 通过 | 38s |
| 4 | NODE_CPU_SPIKE | narrator | slow300 | 通过 | 43s |
| 5 | POD_OOM_SWARM | standard | slow300 | 通过 | 41s |
| 6 | NET_PACKET_LOSS | compact | slow800 | 通过 | 26s |
| 7 | NODE_CPU_SPIKE | narrator | slow300 | 通过 | 41s |
| 8 | POD_OOM_SWARM | standard | none | 通过 | 40s |
| 9 | NET_PACKET_LOSS | compact | slow300 | 通过 | 27s |
| 10 | NODE_CPU_SPIKE | narrator | none | 通过 | 43s |
| 11 | POD_OOM_SWARM | compact | none | 通过 | 27s |
| 12 | NET_PACKET_LOSS | standard | none | 通过 | 39s |

总时长: 437s（12 组，平均 36s/组，每组上限 150s）
结论：12 / 12 组全部通过  ✓   SEED=20261110
```

完整日志：`docs/summit/artifacts/r11-drill-full-20261110.log`。

12 组的场景/节奏/网络组合与首轮**完全一致**（种子确定性成立），
每组锁定节点分别为 worker-alpha / worker-beta / worker-gamma，全部正确。

完整日志：`docs/summit/artifacts/r10-drill-seed-20261110.log`。

---

## 3. 可观测性自检面板（`?demoDebug=1`）

### 3.1 它解决什么

排练时最常见的问题不是报错，而是**沉默的卡顿**：字幕停了、进度条不动，
但不知道卡在"等 AI 流"还是"等动作卡"。面板把引擎内部状态直接摊在屏幕上：

- 状态 / 阶段 / 节奏 / 进度 / 阶段已过秒数；
- **deadline 剩余秒数**（事件驱动阶段才有；≤5s 变琥珀色）；
- 是否停在讲解版断点；
- 预检失败原因；
- **effects 调用序列（新→旧，最近 12 条）**：`preflight → onPhaseEnter →
  effect → triggerDiagnosis → armGate → advanceGate → awaitCard → onFinish`。
  排练者看到最后一条是 `awaitCard`，立刻知道卡在等动作卡。

### 3.2 为什么仅 `?demoDebug=1`

1. 展示的是引擎内部字段，对评委无意义且干扰画面；
2. effects 序列会泄露编排细节；
3. 默认关闭即零视觉/性能影响（组件内部判断参数，非调试模式返回 `null`）。

### 3.3 实测

```
withoutParam       : false          # 无参数时不渲染
withParam          : true           # ?demoDebug=1 时渲染
panelAt16s         : "... 阶段3/4 ... deadline 剩 21s
                      effects 调用序列 ... 12.4s armGate target=#3 timeout=25000ms
                      12.4s triggerDiagnosis 阶段 3/4 · node=worker-beta ..."
hasDeadlineField   : true
traceGrew          : true           # 序列随路演推进增长
```

原始数据：`docs/summit/artifacts/r10-debug-panel-probe.json`。

实现要点：追踪数据是导演模块内的**环形缓冲**（上限 80 条），不进 Store——
若每条 effects 都写 Store，会触发全量订阅者重渲染。面板跟随导演快照（约 8Hz）
刷新并直接读缓冲。

---

## 4. 复现

```bash
pnpm dev                              # 必须 dev 构建
node scripts/verify.mjs --full        # 全量 + 路演回归（失败自动归档证据）
pnpm verify:demo-drill                # 随机 12 组（打印种子）
node scripts/verify-demo-drill.mjs --seed=20261110   # 复现某一轮
# 浏览器打开 http://127.0.0.1:3000/?demoDebug=1 查看自检面板
```