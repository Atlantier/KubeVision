# R04 · 路演自动化验证

> 本文说明"单测管逻辑、CDP 管真实 UI"的分工，并记录本轮实测输出。
> 所有数字均来自本机实跑（Windows + Edge headless + SwiftShader 软渲染）。

---

## 1. 两层验证的分工

路演链路有三类问题，它们的验证成本与手段完全不同：

| 层次 | 典型问题 | 验证手段 | 为什么不能混用 |
|---|---|---|---|
| **纯逻辑** | 暂停 4 秒后进度是否回退、切节奏后进度比例是否保持、跨阶段补触发顺序、effects 抛错后定时器是否清干净、事件门超时是否兜底 | `node:test` + 注入假时钟（`pnpm test:demo`） | 这些不需要浏览器；用 CDP 每次要等 40 秒真实时间，跑 10 个用例就是 7 分钟 |
| **真实 UI** | 镜头锁的是不是真受灾机架、卡片是否三张齐全、MCP 回执动作是否与映射一致、动作卡是否真的 executed、canvas 是否黑屏 | CDP 脚本（`pnpm verify:demo`） | 单测无法证明"屏幕上真的出现了那张卡" |
| **异常/压力** | 慢网 300ms、上游 500、WebGL 上下文丢失、连点 5 次、演示中停止 | CDP 脚本 `--stress`（Network/Fetch/CDP 模拟） | 只有真实浏览器 + 真实网络栈才能复现 |

**一句话**：单测保证"状态机在时间维度上不出错"，CDP 保证"这些状态真的落到了屏幕上"。
两者都绿才算完成；任一缺失都会出现"逻辑对但画面错"或"画面对但边界逻辑错"。

---

## 2. 纯状态机（交付项 B）

### 2.1 文件与契约

`src/utils/demoMachine.ts` 导出 `createDemoMachine(script, effects, clock)`：

- **零依赖**：不 import React / Store / DOM / three，因此可在 Node 与浏览器同构运行；
- **时间可注入**：`DemoClock { now(); schedule(delay, fn); clear(handle) }`。
  测试用假时钟，`advance(4000)` 一次走完 4 秒；
- **副作用经 `DemoEffects` 回调出去**：`onPhaseEnter / onFinish / onLog / onPublish /
  preflight / onGateTimeout?`。真实实现走 Store，测试实现只往数组里 push。

覆盖的核心行为：阶段按 `atMs` 推进、暂停/恢复冻结时间、节奏按比例换算、
跨阶段补触发、讲解版断点、事件门（`armGate` / `resolveGate`）与超时兜底、
effects 抛错后的清理、预检失败分支、幂等守卫。

### 2.2 单测与覆盖率

方法：`tsc` 单文件编译 → `node --experimental-test-coverage --test`。
覆盖率统计限定到 `**/demoMachine.js`（Node 内置能力，零第三方依赖）。

```
$ pnpm test:demo
✔ 预检失败：不启动、不进任何阶段、定时器为 0
✔ 正常推进：阶段按 atMs 依次进入，到总时长自然收尾
✔ 暂停期间时间冻结、阶段不推进；恢复后从原处继续
✔ 跨阶段补触发：时间越过多个阶段时按顺序全部补进
✔ 切换节奏：进度比例保持不变，总时长按新模式重算
✔ effects 抛错：立即停机、清空定时器、留日志
✔ 事件门：超时兜底推进并回调 onGateTimeout
✔ 事件门：外部事件先到则立即推进且不触发超时
✔ 讲解版断点：阶段边界暂停等待，推进后才进入下一阶段
✔ 停止：清空定时器、回到 idle、不再有任何推进
✔ 幂等守卫：非法时机调用均为无操作且不产生副作用

ℹ tests 11 · pass 11 · fail 0

ℹ file            | line % | branch % | funcs %
ℹ demoMachine.js  |  97.43 |    82.35 |  100.00
```

**状态机文件行覆盖率 97.43% ≥ 90% 达成。** 分支 82.35%，未覆盖的是
`effects.onLog` 自身抛错的极端兜底分支与少数防御性 return。

### 2.3 单测抓到的两个真实缺陷

抽取过程中单测直接抓到两处逻辑错误（都不是测试写错）：

1. **effects 抛错后仍继续排程** —— `enterPhase` 内部已停机，但
   `reschedule()` 的循环没有检查状态，继续把剩余阶段与收尾定时器排上，
   于是"已停机"的状态机还留着 4 个定时器。
   修法：循环每轮与 `enterPhase` 之后都检查 `status !== 'running'` 即返回。
2. **收尾定时器抢在事件门之前结束整场** —— 34 秒剧本 + 从阶段 3 起算的 25 秒门
   意味着门要到 36 秒才决断，而收尾定时器在 34 秒就把状态打成 finished，
   门随后因 `status !== 'running'` 静默返回，事件驱动形同虚设。
   修法：收尾到点时若门仍装着，就重新排一次，等门自己决断。

---

## 3. CDP 验证（交付项 A）

### 3.1 断言清单

| 编号 | 断言 | 关键判据 |
|---|---|---|
| J-1 | 阶段 2 锁定真受灾机架 | `selectedEntityId` 节点名下异常 Pod ≥1 且 `activeAlerts` 非空；截图存档 |
| J-2 | 三张卡片齐全 + AI 正文宿主节点一致 | `metrics/rootCause/action = 1/1/1`；`hostNodeInProse == 选中节点名` |
| J-3 | 自愈覆盖 + 回执动作 + 卡片终态 | `healedPodIds ⊇ victims`；`mcpAction == CHAOS_TARGETS 映射`；卡片 executed 且无 pending |
| J-4 | 结束态一致性 + 黑屏回归 | 旁白健康分 == 顶栏健康分；`orbit === true`；console error 0；**canvas 亮度全程 > 2.0** |
| J-5 | 连跑两遍 | 受害者数量一致；QUEUED 免疫日志**增量**为 0 |
| J-6 | pause/resume/stop | 阶段序号与进度单调不回退；stop 后 5 秒无新增导演日志、无 AI 流 |

亮度探针复用 R01 的 `readPixels` 方案（`st.gl.getContext()` + rAF 内读取 +
16×16 等距采样 + Rec.709 加权），阈值 2.0/255。

### 3.2 本轮踩到的三个测量缺陷（已修）

1. **冷启动预检拦截** —— R08 给启动加了预检（抽屉已挂载 / SSE 数据流动）。
   `.next` 刚重建时 10 秒内抽屉懒加载 chunk 还没到，预检直接拒绝启动，
   所有断言读到 null。修法：开跑前显式轮询"抽屉 + 视口 + qps>0"就绪。
2. **page 端正则被模板字面量吞掉反斜杠** —— 新增的 `barElapsedSec` 解析写成
   单反斜杠 `\s`，在 JS 模板字符串里退化成 `s`，导致页面侧整段
   `READ_STATE` 语法错误、返回异常对象。修法：改为 `\\s`。
3. **两处采样时点错误** —— QUEUED 统计读的是跨轮累积总数（把第一遍算到第二遍）；
   第二遍受害者在注入生效前就采样（得到空数组）。修法：比增量 + 注入后等 2.6s。

### 3.3 压力场景（`--stress`）

| 场景 | 手段 | 判据 |
|---|---|---|
| 慢网 300ms | `Network.emulateNetworkConditions` | 卡片仍恰好各一份、画面不黑 |
| 上游 500 | `Fetch.fulfillRequest` 强制首个 `/api/chat` 返回 500 | 不崩、暴露「一键重试」、重试后卡片不重复 |
| WebGL 上下文丢失 | 向 canvas 派发 `webglcontextlost` | 页面不崩、`isGlContextLost` 被记录、无未捕获异常 |
| 连点 5 次 | 同一菜单项同步 `click()` ×5 | 启动日志 1 条、`timerCount` 与单次启动一致 |
| 停止清理 | 点停止后观察 5 秒 | `timerCount` 归零、导演日志不再新增、无 AI 流 |

### 3.4 关于"演示中卸载 TopBar"

真正的 React 组件卸载无法从 CDP 直接触发。但 `useDemoDirector` 的卸载清理
调用的正是同一个 `stopDemoDirector('unmount')`，因此脚本断言的是 stop 之后的
**可观测契约**（定时器归零 / 日志不再新增 / 无 Store 写入 / 无 AI 流）。
这一点在此如实标注，不假称已做过真实组件卸载。

---

## 4. 复现

```bash
pnpm dev                 # 必须 dev 构建（读 Store 调试钩子）
pnpm test:demo           # 单测 + 覆盖率（约 2 秒）
pnpm verify:demo         # CDP 全量（两遍连跑，约 3 分钟）
pnpm verify:demo -- --stress    # 追加压力矩阵（约 6 分钟）
```

退出码：0 = 全绿；1 = 有失败（失败项会打印全部实际值，禁止只打印 PASS/FAIL）。

产物：
- 截图 `docs/summit/shots/r10-verify/{phase2-lock,finished}.png`
- 本轮完整输出 `docs/summit/artifacts/r10-verify-demo.log`、`r10-verify-demo-stress.log`、`r10-demo-tests.log`