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

**验证方式**：`verify-demo` 提供 `--inject-failure` 开关（刻意注入一条失败），
用来证明归档链路真的会落盘。实测产物：

```
docs/summit/failures/2026-11-10T04-20-01-883Z/
  store-snapshot.json   22.8 KB
  console.log            0.4 KB
  last-frame.png       987.8 KB
  failures.json          0.4 KB
```

样本已复制到 `docs/summit/artifacts/r10-failure-archive-sample/`；
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

每组校验：启动成功、节奏生效、阶段 2 出现、锁定节点名符合引擎事实、
`activeChaos` 与剧本一致、阶段 4 出现、本组新增 console error 为 0。

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
结论：12 / 12 组全部通过  ✓   SEED=20261110
```

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