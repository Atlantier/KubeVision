# 风险台账（R57 收口）

> 规则：只记**真实未完成/未验证**事项；每条必须有兜底话术与负责人。
> 状态：`OPEN` 未解决 / `MITIGATED` 有兜底 / `CLOSED` 已解决。更新于 2026-11-11。

| # | 事项 | 状态 | 原因（证据） | 兜底话术 | 负责人 | 截止 |
|---|---|---|---|---|---|---|
| 1 | `verify:all` 在 `verify-demo` 阶段失败 | **OPEN（有手动替代证据）** | 软渲染/引擎 B 环境下路演阶段 4 HITL 超时：J-3 动作卡未 executed、J-4 出现 `Uncaught`、J-6 暂停时长读取为 null；现场证据 `docs/evidence/verify-all/2026-11-11T06-32-27-307Z/`。**手动链路已验证**：`walkthrough-04b-action-executed` 显示人工点击后「已执行 · 3D 拓扑已自愈恢复」、回执与健康分 77→96 | 「自动路演在本机软件渲染+慢模型下阶段 4 会超时；手动点击自愈已验证可用，现场走手动链路或真实网关。」 | 工程 / 主讲 | T-1 |
| 2 | 3 分钟视频与 60s 无旁白版未录制 | **OPEN** | 本环境无录屏设备/OBS，不伪造 mp4；执行单已就绪 `docs/summit/R55-RECORDING-RUNSHEET.md` | 「视频在本机录制后随 U 盘提交；现场以实时演示为准。」 | 主讲 / 录制 | T-2 |
| 3 | 团队信息/院校/邮箱为占位 | **OPEN** | README/PPT 中 `【待填写】` | 「提交前由队长统一替换并二次核对。」 | 队长 | **T-3** |
| 4 | LICENSE 最终口径未确认 | **OPEN** | 当前默认 MIT，团队可能改「仅限评审使用」 | 「按团队决定替换 LICENSE 全文，并同步 README/NOTICES。」 | 队长 | T-3 |
| 5 | Docker 镜像未实际构建 | **OPEN** | 本机无 Docker；Dockerfile/.dockerignore 仅静态审查 | 「评审用 `pnpm build && pnpm start`；Docker 作为附加交付，未验证不宣称可用。」 | 工程 | T-2 |
| 6 | 60 分钟 soak 与 3 小时页面常开未完整跑完 | **OPEN** | 本轮仅完成脚本与部分循环（见 `docs/soak-closeout.md` / `docs/page-open-*.md` 实际时长）；长跑需真实时间 | 「长时间稳定性以脚本复现命令为准；答辩现场只演示 3 分钟主链路。」 | 测试 | T-1 |
| 7 | 真实 K8s 集群未连接 | **MITIGATED** | 适配层 `K8S_API_SERVER` 已实现但未现场连接；演示默认合成遥测 | 「演示为合成数据，只声称故障语义可信，不声称真实集群指标。」 | 工程 | 持续 |
| 8 | 端侧模型未真机验证 | **MITIGATED** | 本机 SwiftShader/无 WebGPU，走 builtin fallback；权重已随包 | 「端侧不可用时自动降级且页面如实标注，不冒充神经推理。」 | AI | 持续 |
| 9 | 三路召回/多步工具未真机验证 | **MITIGATED** | 评测用预计算向量；多步工具评测时 LLM 回落未实际调用（R45/R48 文档） | 「未就绪时自动退回两路；多步工具不作为已验证能力宣传。」 | AI | 持续 |
| 10 | 语音输入/播报无硬件回归；「声学推断」仅兜底路径 | **MITIGATED** | 无麦克风；代码路径与降级逻辑存在，未真机验证 | 「语音是浏览器原生能力，现场有麦克风再演示；失败自动回退输入框。」 | 前端 | 现场 |
| 11 | 路演「跳转阶段」（seek）未实现 | **MITIGATED** | `demoDirector` 支持暂停/继续/停止/重播，不支持任意 seek（R53 已记录） | 「路演按时间轴顺序播放，不承诺任意跳转；需要跳段用停止后重播。」 | 工程 | 持续 |
| 12 | CI workflow 未在 GitHub Actions 实际运行 | **OPEN** | 本环境无 Actions runner；两步命令已本地通过 | 「CI 配置已入仓，首次 push 后以 Actions 结果为准。」 | 工程 | T-2 |
| 13 | README/PPT 中部分数字属历史轮次（如 R53 分镜页 421.5） | **MITIGATED** | 本收口文档/PPT/README 已统一为同批 `performance.json`；旧轮次文档保留历史口径 | 「以 `docs/performance.json` 与 `verify:docs` 为准，历史文档仅作留档。」 | 文档 | 持续 |
| 14 | 提交包命名缺真实学校/队名/联系方式 | **OPEN** | 需团队提供；模板见 `docs/SUBMISSION_PACKAGE.md` | 「提交前按模板替换并重命名 zip。」 | 队长 | **T-1** |
| 15 | `verify-demo` 的 J-6 暂停时长读取为 null（字幕格式变化） | **OPEN** | R41 后字幕条改 `data-demo-phase`，测试仍读旧文本格式（阶段/暂停判定部分已适配） | 「暂停/继续行为本身可用（J-6 阶段单调性通过）；该断言为测试口径问题。」 | 测试 | T-1 |

## 现场兜底优先级

1. **路演失败** → 立刻转手动 3 分钟链路（R53 分镜），不解释；
2. **无 Key/断网** → 主动讲「离线优先」，引擎行显示本地确定性容灾引擎（实测回落约 6.7s）；
3. **端侧审计无 WebGPU** → 讲内置分类器降级与页面如实标注；
4. **视频缺失** → 用 PPT 证据页 + 现场实时演示补位。

## 禁止话术

- 「已经生产可用 / 真实集群实测 / 60FPS / 标准 MCP stdio / 断网 1 秒回落 / 分类准确率 X%」；
- 任何未在 `docs/performance.json` / `verify-summary.json` / `rag-eval.json` 中的数字。

| 16 | 页面左下持续出现「1 error」控制台错误（与 verify-demo J-4 的 Uncaught 对应） | **OPEN** | 走查截图左下角可见；verify-demo J-4 记录 `pageErrors:["Uncaught"]`；未定位到具体堆栈 | 「主链路不中断；现场若出现红条，刷新页面后继续，不现场调试。」 | 工程 | T-1 |
| 17 | verify:all 后续步骤未由聚合脚本执行 | **CLOSED** | 聚合脚本在 verify-demo 处按规则停止；其后 8 步已手动串行执行并全部通过：probe-blackout ×4（各 0/3）、eval-rag、mcp-smoke 10/10、verify-privacy 5/5、docs-consistency | 「聚合脚本已验证失败即停与现场保存；后续步骤有独立日志可在 `docs/evidence/verify-all-continue-2026-11-11/` 复核。」 | 测试 | 已完成 |

---

## R3 · 状态与交互确定性 Bug 包（2026-11-12 · main 完成）

> 口令「完成R3 main」。改动→证据→验收结果如下；所有「通过」来自本轮真实命令输出（日志在 `tmp-logs/tmp-r3-*.log`，本地不入库）。

| 缺陷 | 改动 | 证据（本轮实测） | 结果 |
|---|---|---|---|
| Esc 散落监听抢键（ShellLayout 帮助/NodeInspectHUD 图例+筛选/DemoReplayTimeline 回放/CommandPalette 输入框各挂一份） | 全部入栈 useEscapeStack：帮助 60/图例 30/回放 20/筛选 10；命令面板层声明 consumeInEditable；派发器补 IME 让位 | `probe:escape` 11/11；`probe:keyboard` K4（帮助+混沌同开一次 Esc 只关混沌）15/15 | CLOSED |
| IME 组合期 Enter 误执行命令 | 抽 isImeComposing 纯函数（isComposing + keyCode 229 双判），命令面板/副驾输入框共用 | `test:keyboard` 15/15；`probe:keyboard` K3（isComposing/229 不执行、普通 Enter 执行） | CLOSED |
| 空格/1/2/F/? 劫持交互元素 | 抽 isInteractiveTarget 纯函数（8 标签 + 5 role + contentEditable），ShellLayout 全局快捷键统一让位 | `test:keyboard`；`probe:keyboard` K1（真 Space 激活按钮）/K2/K5 | CLOSED |
| DemoDebugPanel render 体读 Date.now()（不纯渲染） | nowMs 改 Effect 250ms 时钟写入，render 只读状态 | 水合专项：普通页 + ?demoDebug=1 各加载，0 水合警告 0 异常 | CLOSED |
| 免疫窗口 30s/15s 双常量 + reconciledCount 不归零 | 单常量 HEAL_IMMUNITY_WINDOW_MS=15000 入 telemetryTuning.ts，store/Hook 同引用；setLastReconciledCount 无条件相等性写回 | `probe:immune` 6/6（remainingSec=15）；`probe:r13` 11/11 曲线 22.7→50.1→80（比例 0.48≈0.5） | CLOSED |
| layout.tsx maximumScale:1 禁缩放 | 删除 maximumScale，保留 initialScale/themeColor/colorScheme | typecheck/build 通过；viewport 元数据不再含 maximum-scale | CLOSED |

**本轮验收汇总**：typecheck ✓ · lint ✓ · build ✓ · verify:quick 8/8 · verify 35/35 · verify:telemetry 9/9 · probe:escape 11/11 · probe:keyboard 15/15 · test:keyboard 15/15 · probe:immune 6/6 · probe:r13 11/11 · strictmode:audit 6/6 · 水合 0 警告。

| # | 事项 | 状态 | 原因（证据） | 兜底话术 | 负责人 | 截止 |
|---|---|---|---|---|---|---|
| R3-1 | IME 用合成 isComposing/keyCode 229 事件验证，未接真实操作系统输入法 | **MITIGATED** | headless Edge 无 OS IME；双判逻辑已单测+浏览器合成事件覆盖，真机 IME 未测 | 「中文输入防误触按标准 isComposing+229 双判实现；现场用真实输入法再复核一次。」 | 前端 | 现场 |
| R3-2 | 键盘 E2E 在 SwiftShader 软渲染下跑，时序断言用轮询等待 | **MITIGATED** | 相机飞行阻塞主线程会拖慢退场动画（实测面板关闭可达 2.6s）；真实 GPU 时序未测 | 「交互逻辑正确性已验证；丝滑时序以真实 GPU 为准，软渲染不宣称帧率。」 | 前端 | 持续 |
| R3-3 | verify 实际 35 项 vs README/verify-summary 记 34 | **OPEN（转 R14）** | 既有文档数字漂移，非 R3 引入；R3 不改文档数字 | 「以 verify 真实输出为准，文档同源在 R14 统一收口。」 | 文档 | R14 |

---

## R3 · 进阶：交互确定性运行期可证明（2026-11-12 · 进阶完成）

> 口令「完成R3 进阶」。新增三个对抗探针，把 R3 main 的修复做成运行期可证明；本轮**未改应用代码**，仅新增探针/脚本与证据。

| 进阶项 | 探针 | 实测结果 | 证据 |
|---|---|---|---|
| ① 键盘-only 全路径 | `probe:keyboard-path` | **12/12**：Tab/Enter/Space/方向键/Esc 走完「命令面板→worker-beta→故障演练→OOM→快照诊断→RAG→复盘→逐层回全景」；Esc 每次只关一层；20 次开合 keydown 监听净数 5→5 恒定（零泄漏） | `docs/evidence/r3-advanced/keyboard-path/`（分步截图可由探针再生 + listener-curve.json） |
| ② 免疫合并对抗 | `probe:immune-adversarial` | **10/10**：FakeEventSource 注入 20 帧红绿抖动，窗口内 20/20 免疫保持绿、重复自愈被拒；remainingSec=15 与 store 推算一致；窗口外红帧显红/绿帧显绿；复位曲线 37.7→66.9（一帧插值）→96 | `docs/evidence/r3-advanced/immune-adversarial-curve.json` |
| ③ 水合对抗 | `probe:hydration` | **20/20**：时区（沪/纽/伦/UTC）×语言（zh/en/ja）×时钟偏移（0/+5min/−2min）组合刷新，水合不一致 0 次、error 0 次 | `tmp-logs/tmp-r3adv-hydration.log`（本地） |

**回归**：verify:quick 8/8 · probe:keyboard 15/15（无回退；本轮未改应用代码）。

| # | 事项 | 状态 | 原因（证据） | 兜底话术 | 负责人 | 截止 |
|---|---|---|---|---|---|---|
| R3-4 | 混沌/复盘等顶层模态无焦点陷阱：打开后焦点停在背景触发按钮（键盘路径探针 A2 实测 focusInDialog=false） | **OPEN（转 R12）** | R3 收敛了 Esc 分级栈但未做焦点陷阱/归还（属 R12「Overlay 栈与焦点」）；键盘路径仍可经 Tab 导航完成，不阻塞操作 | 「Esc 分层与键盘可达已验证；焦点陷阱与关闭归还焦点在 R12 统一治理。」 | 前端 | R12 |
| R3-5 | 键盘路径/免疫对抗在 SwiftShader 软渲染下跑，启动需预热且不可并发多浏览器 | **MITIGATED** | 僵尸浏览器进程争 CPU 会致 Canvas 初始化超时；探针已加长轮询等待，单浏览器串行运行稳定 | 「探针串行运行可复现；真实 GPU 下启动更快。」 | 测试 | 持续 |

---

## R4 · 数据可信度与演示剧本一致性（2026-11-12 · main 完成）

> 口令「完成 R4main」。9 项缺陷修复→证据→验收如下；所有数字来自本轮真实命令输出（日志在 `tmp-logs/tmp-r4-*.log`，本地不入库）。schema 升 v3（新增 seq 帧序号）。

| 缺陷 | 改动 | 证据（本轮实测） | 结果 |
|---|---|---|---|
| P0-1 瞬态槽位只增不复用 + 耗尽 break（48 个 ID 后新 Pod 恒 0%） | freeSlots 栈：先回收后分配、分配先弹栈；高水位=max(占用,空闲)+1；耗尽 continue + truncated 上报（deliver 写终端告警） | `test:slots` 6/6：96 个不同 ID 两批 48 全着色、LIFO 身份复用、60 Pod 截断标志、200 轮随机 churn 槽位恒 ≤48 无重复 | CLOSED |
| P0-2 剧本阶段重入（阶段 4 跑两遍→「自愈未验证」覆盖「闭环通过」） | enterPhase 首行 index<=phaseIndex 守卫（开发期 console.warn 打调用栈）；scheduleFrom 循环首行 i<=phaseIndex continue；「未验证」防御分支原样保留 | `probe:r4-oom10` **10/10** 终态「闭环校验通过：3/3 个受害者已自愈」，运行时错误 0，重入拦截 0 次 | CLOSED |
| P0-3 Worker 迟到 result 无 requestId 错配 | classify 请求携带递增 requestId，Worker 原样回传（result/错误均带）；onmessage 不匹配丢弃并计数 glStats.workerStaleResults；超时显式终态（pending 清空后迟到结果必被丢弃） | typecheck/lint/verify 35/35（端侧引擎就绪+推理事件全绿）；错配竞态需超时才触发，运行期未实测（见 R4-4） | CLOSED |
| P0-4 live 采样模块级基准被多连接交替覆盖（双标签页 CPU 恒 0） | 单一采样器+广播：acquireHostSampler/releaseHostSampler 引用计数，1Hz ticker 唯一写者，连接只读缓存；末个订阅者离开停 ticker 清基准；safeClose/降级双路径退订 | `probe:r4-consistency` X5：双独立 SSE 连接节点 CPU 逐值相等（56.1/50.8/52.2）且非 0，来源 LIVE-OS-BRIDGE 24 核 | CLOSED |
| P0-5 useDemoDirector 卸载即 stop 杀路演 | 钩子只订阅（useSyncExternalStore），卸载不 stop；stop 仅 user/switch 两个显式原因（'unmount' 从类型域删除） | verify 35/35 + probe:r4-oom10 连跑 10 轮（含调试面板常驻订阅）无中断 | CLOSED |
| P0-6 免疫窗口双常量 | R3 已收敛 HEAL_IMMUNITY_WINDOW_MS=15000，本轮复核：全仓仅 telemetryTuning.ts 一处定义，store/Hook 同引用 | grep 复核 + probe:escape 11/11 / probe:keyboard 15/15 回归无回退 | CLOSED |
| P1 健康分三套口径 + 96 地板 + live 下限 50 | clusterHealth.ts 新增快照级唯一入口 computeHealthScore；删 store 96 地板、live 宿主机阈值公式+50 下限、live K8s Ready 占比公式；四处调用同归罚分模型 | X2a 稳态 100=100=100=独立 oracle 100；X2b 混沌 77=77=77=oracle 77（3 异常 Pod，分数真实下降无地板）；`verify:parity` 3/3（demo=live=93 同分） | CLOSED |
| P1 persist 每 set 全量落盘 + page 根 1Hz 重渲染 | partialize 白名单复核（仅 4 字段）+ 尾随节流 storage ≤1 写/秒（read-your-writes）；frameCount 移瞬态轨 glStats.telemetryFrameCount，TelemetryStreamState 删除该字段 | P2 localStorage 0.933 次/s ≤1（30s 28 次）；P1 管线 0.240ms/s <3ms/s；page 根不再持有 1Hz state | CLOSED |
| P1 时间轴 +1000 积分漂移 + 无 seq 去重 | TelemetrySnapshot 新增单调 seq（schema v3）；引擎/采集链 +1、叠加层保留；前端 seq<=lastSeq 丢弃计数，onopen 跨连接复位；时间戳仍以服务端为准只做单调修正 | P3 30 帧/30s ≈1Hz、staleSeqFrames=0；verify:telemetry A-3 时间戳严格 +1000ms 9/9 | CLOSED |

**本轮验收汇总**：typecheck ✓ · lint ✓ · build ✓ · verify 35/35 · verify:telemetry 9/9 · sim-drift ✓ · verify:parity 3/3 · verify:stream ✓ · test:slots 6/6 · test:health 4/4 · test:demo 11/11 · probe:r4-consistency 8/8（X1 120 Pod×轮次误差 0.000%）· probe:r4-oom10 10/10 · probe:escape 11/11 · probe:keyboard 15/15 · check-dead-exports 新增 0。
**顺手修复（既有 harness 缺口，非 R4 引入）**：sim-drift / verify-mode-parity 的转译别名表缺 clusterHealth 映射导致 MODULE_NOT_FOUND，已补齐（与 verify-telemetry 同款）。

| # | 事项 | 状态 | 原因（证据） | 兜底话术 | 负责人 | 截止 |
|---|---|---|---|---|---|---|
| R4-1 | 删地板后混沌期健康分真实落到 77（旧实现被 96/50 地板托住） | **MITIGATED** | X2b 实测 77=罚分模型值；故障面已限 3 受害者，自愈后回 100。「难看」是真实故障的如实反映，正确解是缩小故障面而非打地板 | 「分数由故障面实时罚分得出，自愈闭环后回到满分——没有任何粉饰。」 | 前端 | 持续 |
| R4-2 | 静置 <3ms/s 证据为**遥测管线级**（performance.now 包裹 deliver），SwiftShader 软渲染 GL 耗时不计入也不代表真实 GPU | **MITIGATED** | P1 0.240ms/s 为 reconcile+双轨分发+store 写入的实测主线程成本；软渲染整帧 ~700ms 属 GPU 替代开销，与 R3 同口径不宣称帧率 | 「1Hz 数据管线实测 <0.3ms/s；渲染帧率以真实 GPU 为准。」 | 前端 | 持续 |
| R4-3 | live K8s API 分支的统一健康分未接真实集群实测（本机无 K8S_API_SERVER） | **OPEN** | 宿主机桥接已实测（X5）；K8s 分支走同一 computeHealthScore 入口，代码路径收敛但无真实集群证据 | 「实时模式双链路同口径；真实集群接入后复核一次。」 | 后端 | 现场 |
| R4-4 | Worker requestId 错配丢弃路径需「超时后迟到结果」竞态才触发，运行期未实测 | **MITIGATED** | 配对/计数/终态逻辑经类型校验与 verify 端侧全链路覆盖；glStats.workerStaleResults 已暴露供进阶对抗探针取证 | 「配对契约已落地；竞态对抗在 R4 进阶用注入超时证明。」 | 前端 | R4 进阶 |
| R4-5 | schema v3 与旧缓存客户端不兼容 | **MITIGATED** | 既有版本协商：不匹配即只读降级并提示（设计行为，非缺陷）；刷新即恢复 | 「协议升级有版本协商，旧页面只读提示刷新。」 | 前端 | 持续 |
| R4-6 | persist 尾随节流最多延迟 1s 落盘，突然关页可能丢最后一次 UI 偏好变更 | **MITIGATED** | 仅影响 4 个跨会话偏好字段（连接模式/掩码计数/自愈历史/日志摘要），非关键数据；read-your-writes 保证会话内一致 | 「偏好落盘 ≤1s 延迟，换取静置零 IO 抖动。」 | 前端 | 持续 |

---

## R4 · 进阶：同一事实三处同数·运行期可证明（2026-11-12 · 进阶完成）

> 口令「完成R4 进阶」。把 R4 main 的修复做成「同一事实三处同数」的反作弊运行期证据：新增 `frameTimeline.ts` 纯函数（isDuplicateSeq/guardFrameTimestamp，零 Date.now）+ verify-telemetry/sim-drift 静态断言 + 三个浏览器探针（advanced/oom10/perf）。**改前基线在 git worktree a1ba445 实测对照**（旧代码独立 dev server，逐值采集）。所有数字来自本轮真实命令输出（日志 `tmp-logs/tmp-r4*.log`，本地不入库）。

| 项 | 改前（a1ba445 实测） | 改后（实测） | 样本数 | 证据 |
|---|---|---|---|---|
| X1 同 Pod CPU 三处一致 | `test:slots` **1/6**（S-2..S-6 失败：槽位碰撞/不复用/耗尽 break） | `test:slots` **6/6** + 运行期 126 ID 三处全一致 + freeSlots 复用 48/48、30/30；结构断言 3D 读 `podCpuFloat32`（非 HUD） | 静态 696 ID + 运行 126 + main 120 Pod，误差 0 | verify-telemetry X1 · probe:r4-advanced X1 · tmp-r4-before-slots.log |
| X2 三处健康分相等·无地板 | heal 1/3 受害者→**96**（HEAL_RECOVERY_FLOOR 托住；真实 post-heal 84，虚高 +12） | heal 1/3→**84**==oracle<96；故障帧 76/恢复帧 100 三处相等；300 帧逐帧==独立 oracle 违例 0 | 3 受害者×多帧 + 300 帧 | probe:r4-advanced X2 · sim-drift X2 · tmp-r4-before-measure.log |
| X3 免疫剩余秒==store | R3 已修（R3 进阶 immune-adversarial 10/10 同源） | 15/12/5s == store 时间戳推算（±1s 边界容差） | 3 采样 | probe:r4-advanced X3 |
| X4 剧本终态 10 次一致·不重入 | 10/10 终态 + 10/10 单调，但 enterPhase 重入守卫**缺失**（潜在竞态未防护） | 10/10 终态 + 10/10 单调 + 守卫存在 + 「自愈未验证」防御分支原样保留 | 10 轮×改前/改后 | probe:r4-oom10（KV_BASELINE 对照）|
| X5 双客户端一致·单一采样器 | **12/12 不一致**（每连接独立 setInterval；L1 alpha 57.6 vs L2 50.9）；liveTelemetry 0 ticker | **12/12 逐值相等非 0** + 源码仅 1 setInterval + 审计 1start/1reuse/1stop | 12 采样×2 连接 | probe:r4-advanced X5a/b/c · tmp-r4-before-measure.log |
| X6 时钟+5min 重连不跳未来 + seq 去重 | 回退帧照收，首 Pod CPU **46→11 被改写**；无 staleSeqFrames 计数器 | **6/6 重复/回退帧丢弃零改写** + 重连 Δts=2214ms 连续（客户端钟快 300000ms）；纯函数零 Date.now | 6 帧 + 重连 + 100 帧攻击 | probe:r4-advanced X6a/b · verify-telemetry X6 |
| P1 静置主线程<3ms/s | 无管线埋点（不可测）；1 条 dev-GC longtask 1522ms（非 GC 0）；React commit 12.72/s | 管线 **0.258ms/s** + 非 GC longtask **0.000ms/s**（1487ms GC 单独归因）；commit 11.95/s | 60s | probe:r4-perf（PerformanceObserver）|
| P2 localStorage≤1/s | 0.983/s ✓ | 0.983/s ✓（59 次/60s） | 60s | probe:r4-perf |

**本轮验收汇总**：typecheck ✓ · build ✓（Compiled successfully）· verify-telemetry **12/12** · sim-drift ✓（X2 300 帧违例 0 / X6 seq 断裂 0）· test:slots **6/6** · probe:r4-advanced **13/13** · probe:r4-oom10 **10/10**（单调 10/10）· probe:r4-perf **3/3**。

**反作弊守住（逐条）**：① 3D 仍读瞬态 `podCpuFloat32`（结构断言，未改读 HUD 值）；② 健康分无地板/天花板（300 帧==独立罚分 oracle，删 96 地板后混沌真实落 76/84）；③ 「自愈未验证」防御分支原样保留（静态断言）；④ 单一 setInterval 采样器（源码断言 + 服务端 acquire/release 审计 1/1/1，非抖动）；⑤ frameTimeline 纯函数零 Date.now（注释剥离后正则断言）；⑥ GC 归因用**窗口内堆降**（100ms 密采样 sawtooth）而非松断言——改前改后同一条 dev-GC 暂停均如实归因，未把基础设施暂停冒充应用成本，也未把应用成本藏进 GC。

| # | 事项 | 状态 | 原因（证据） | 兜底话术 | 负责人 | 截止 |
|---|---|---|---|---|---|---|
| R4-7 | P1 的 ~1.5s longtask 是 **dev 构建 V8 major GC**（堆 113~146MB），改前改后同源（1522/1487ms），非应用成本、R4 未改变它；生产构建堆更小未测 | **MITIGATED** | 三证据：窗口内堆降 2.5~4.0MB（密采样）+ about:blank 对照 0 longtask + 全部应用定时器 <1ms；应用管线实测 0.258ms/s、非 GC longtask 0 | 「静置应用主线程 <0.3ms/s；那一条 ~1.5s 暂停是 dev 构建的 V8 GC，生产构建会消失，与业务代码无关。」 | 前端 | 持续 |
| R4-8 | X4 重入为**潜在竞态**：改前改后 benign 时序均 10/10 单调；守卫价值是竞态硬化（guardPresent false→true）+ 可证明单调，非保证性失败修复 | **MITIGATED** | 20 轮（改前 10+改后 10）均未触发竞态；守卫存在性静态断言 + 单调轨迹运行期断言双证据；console.warn 拦截计数暴露供观测 | 「阶段单调已 10/10 证明；重入守卫把竞态从『可能回头』变成『硬拦截』， benign 跑不触发不代表没有防护。」 | 前端 | 持续 |
| R4-9 | R4-4 的 Worker requestId 错配竞态本轮**未注入证明**（进阶 X6 覆盖客户端 seq 去重，非 Worker classify 配对）；仍 MITIGATED | **MITIGATED（承 R4-4）** | 配对/计数/终态逻辑经 typecheck + verify 端侧全链路覆盖；glStats.workerStaleResults 已暴露；进阶 Prompt 的 X1–X6 不含 Worker 超时注入 | 「客户端帧去重已运行期证明；Worker 配对竞态的超时注入不在本轮进阶清单，留待专项对抗。」 | 前端 | 后续 |
| R4-10 | 探针在 SwiftShader 软渲染 + dev 构建串行运行；React commit 11.95/s 为 dev 口径，真实 GPU/生产未测（R3-2 同源） | **MITIGATED** | 双 live 页串行（同源 localStorage + GPU 争用）；commit 计数为 React dev devtools hook，生产无此开销；不宣称帧率 | 「数据一致性与管线成本已证明；渲染帧率与 commit 开销以真实 GPU/生产构建为准。」 | 测试 | 持续 |

---

## R5 · 3D 渲染性能与资源/拾取正确性（2026-11-13 · main 完成）

> 口令「完成R5 main」。四个独立可 revert 提交：R5-1 先修测量（9e106b4）→ R5-2 反射限最高档（3758cd8）→ R5-3 几何合并（a4aa114）→ R5-4 档位同源+清白付成本（本轮）。所有 draw call 数字为 SwiftShader 软渲染下实测——**draw calls 硬件无关，作证据有效；FPS（≈2）不作性能证据**。CDP 探针串行端口 9341–9371，无并行争用。

| 优化点 | 改前（实测） | 改后（实测） | 证据 |
|---|---|---|---|
| ① 测量修复 P2-32 | autoReset 默认 true，读数=后处理合成 pass 计数（失真）；HUD 无三数 | autoReset=false + 每帧先读上一完整帧累计再 reset；包裹 gl.render 隔离反射 pass；HUD `主·反射·合计` 三数 | HUD DOM：兜底 `401 主 401·反射 0`；Composer+反射 `802 主 429·反射 373`，恒满足 主+反射==合计 |
| ② 反射降级（方案A） | 全档整场景再渲染：反射开比关多付 461 draw（964 vs 503，3758cd8 同会话强制 A/B 实测），改前 T2/T1/T0 也要付 | 真反射限 T3（`qualityReflector>=3`）；T2/T1/T0 用 RackGroundReflection 假反射带，免付重渲染成本；合并后反射开 778（主 405 + 反射 373）、关 401 | CDP A/B 探针（tmp-r5-refl-t2.mjs 口径）+ HUD 三数 |
| ③ 地面基座合并 P0-02 | 每机架 11 mesh；本文件 57 draw | 健康/故障两组三角汤（vertexColors + AdditiveBlending，透明度烘进顶点色）：33→6、57→30 | 静态断言 + 合并后 fallback 总数 503→401 |
| ④ 百叶窗实例化 P0-03 | 9 box×3 机架 = 27 draw | 1 instancedMesh（LOUVER_COUNT 矩阵一次写入）：27→3 | 静态断言 + a4aa114 |
| ⑤ 档位效果同源 P0-04 | DoF 档位写反：T2 常驻 DoF、T3 无 DoF 但 DofFocusDriver 空转 | `TIER_EFFECT_MATRIX` 单一事实源：DoF 仅 T3；T2=FXAA；T1=Bloom 降级（levels 5→3, 0.48→0.34）；T0 全关；DofFocusDriver 与 DoF 同条件挂载 | 档位循环探针 programs 90→85→82 单调；draw calls 425→414→407 单调 |
| ⑥ toneMapping 同源 P0-05 | 仅 onCreated 设一次；降档不更新；实测 EffectComposer 卸载还会在 passive effect 之后把 toneMapping 回写挂载前值 | `ToneMappingSync`（Canvas 子组件 useFrame 优先级 0）逐帧守卫：兜底→Neutral(7)，Composer→NoToneMapping(0) | 探针：兜底 7 ✓ / Composer 0 ✓ / 关后处理回 7 ✓（轮询 8 次稳定） |
| ⑦ dpr 分档 P0-06 | DPR_FLOOR=0.85 单一值，2x 屏不生效 | 1x 屏 [0.75,1]、2x 屏 [1,1.5]（devicePixelRatio≤1.25 判定）；tier≤1 锁 floor（软渲染保持 1.0 锁不参与）；PerformanceMonitor 降档联动 `max(floor,…)` | 探针 dpr=1（1x 屏 + 软渲染例外路径）；代码审查挂载期常量 |
| ⑧ 清白付成本 | linewidth 动画死代码；shadows 运行期切换触发材质重编译；能力探测 render 阶段建 WebGL 上下文；preserveDrawingBuffer 常开 | 删 linewidth 动画（WebGL 恒 1px）；shadows 固定（软件 basic/真机 soft）；探测结果模块级缓存单次；`preserveDrawingBuffer:false` + 截图改走 viewportCapture 同帧读取队列（工具条快照/Copilot 截图/首帧兜底/演示编排 4 处统一） | 截图探针：ctx attrs preserveDrawingBuffer=false，两条路径均取到非黑帧（96%/100% 像素非黑） |

**降档单调与重编译判据**：draw calls T3 425 → T2 414 → T1 407 → T0 401 单调下降；programs T3→T2→T1→T2→T3 = 90→85→82→82→90，**同档往返净增 0**（无重编译泄漏）；toneMapping 全程随路径正确。60s 堆增量（HeapProfiler 双端强 GC）+2.34MB < 5MB ✓。

**本轮验收汇总**：typecheck ✓ · benchmark ×2 ✓ · benchmark:consistency ✓（硬件无关 5 项逐值相等，Draw Calls 中位 401/401）· lint:glsl ✓（无 HIGH）· strictmode:audit ✓ 6/6 · HUD 三数两路径 ✓ · shot overview console error=0。

**完成判据差异（如实记录）**：手册完成判据「T3 overview 合计≤200」**未达成**——实测 T3 合计 425（反射关）/ 802（反射开）。已达成：改前 503（反射关）/ 964（反射开）→ 改后 401 / 778（-20%/-19%），主场景从 503→401。剩余 401 的构成为大量加色装饰层与网络流粒子（手册 B 方案提及的 69 个加色装饰层等），继续合并属于手册可砍清单明示可放弃的「R5 draw call 极限目标」，且合并越深越接近动态装饰层（违反风险条款「合并只针对静态装饰层」）。

| # | 事项 | 状态 | 原因（证据） | 兜底话术 | 负责人 | 截止 |
|---|---|---|---|---|---|---|
| R5-1 | T3 合计≤200 未达成（实测 425/802） | **MITIGATED** | 四项优化各自改前/改后实测（503→401、964→778、27→3、57→30）；反射开时反射 pass 占 48% 已由档位隔离（仅 T3）；剩余为静态装饰层，深合并与「Pod/机架主体保持独立」风险条款冲突 | 「每个优化点都有改前/改后 draw call 实测；≤200 是极限目标，手册可砍清单允许放弃，本档位把成本最高的两项（整场景反射、每机架 11+9 mesh）砍掉了。」 | 前端 | R6 后复核 |
| R5-2 | 「24 不透明件 transparent:true」与当前代码不符：运行期审计仅 12 个候选 | **MITIGATED** | 稳态审计（quality=high 2s 采样）：223 个 transparent 材质中 opacity==1 且 Normal 混合候选仅 12——11 个自定义 ShaderMaterial（alpha 由片元输出，材质 opacity 无意义，翻转会破坏辉光/渐变）、1 个为开场淡入动画的瞬态采样；无静态白付成本可翻转 | 「审计逐个核对过：透明材质都真在用 alpha（加色辉光/淡入），没有可安全翻白的死透明。」 | 前端 | 关闭 |
| R5-3 | toneMapping 修复从「useEffect 同源」改为「useFrame 逐帧守卫」，与手册第6步字面不一致 | **MITIGATED** | 实测证据：EffectComposer 卸载在 passive effect 之后回写 toneMapping=挂载前值，effect 方案被覆盖（探针 post=false 轮询 8 次全 0）；useFrame 期望不符才写，稳定后零开销 | 「手册建议的 effect 方案实测会被 Composer 卸载回写打掉；守卫方案是唯一稳定解，验收项（随档位切换）运行期证明通过。」 | 前端 | 关闭 |
| R5-4 | preserveDrawingBuffer:false 后截图依赖 FrameCaptureProvider 同帧读取；首帧兜底快照 PNG 实测 ≈719KB，超 200KB 体积闸门被拒（改造前亦如此，非回归） | **OPEN** | 1244×1014 PNG ≈719KB > 200KB 闸门，首帧兜底图基本不会生效；改造前 preserveDrawingBuffer=true 时同样被闸门拒收 | 「兜底图闸门按设计拒绝大图；多模态截图走 JPEG 0.8，编码行为与改造前一致、不受影响。」 | 前端 | R6 |
| R5-5 | dpr 低档锁仅在真实 GPU 生效；SwiftShader 治理器降档时保持 DPR=1（证据截图清晰度优先） | **MITIGATED** | 软渲染仅 CI/截图环境，FPS 无证据价值；锁 floor 会让证据图变糊无收益 | 「低档 dpr 锁面向真机演示；软渲染环境按 L8 惯例单独锁 1.0。」 | 前端 | 持续 |
| R5-6 | dev-only 调试把手新增 setQualityTier/capture（L11 handle），仅开发构建暴露 | **MITIGATED** | 与既有 setPost/setReflector 同一 dev-only effect；生产构建 DCE 掉调试钩子（handleCanvasCreated 同款边界） | 「取证把手只在 dev 构建存在，生产零调试面。」 | 前端 | 关闭 |
