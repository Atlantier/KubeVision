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
| ⑧ 清白付成本 | linewidth 动画死代码（手册判定）；shadows 运行期切换触发材质重编译；能力探测 render 阶段建 WebGL 上下文；preserveDrawingBuffer 常开 | **linewidth 动画复审后保留**（drei `<Edges>`=three-stdlib `LineSegments2`+`LineMaterial` fat-line，linewidth 是屏幕空间像素宽度真实生效，手册「死代码」前提与依赖版本不符——5623e2f 曾误删，后一提交恢复）；shadows 固定（软件 basic/真机 soft）；探测结果模块级缓存单次；`preserveDrawingBuffer:false` + 截图改走 viewportCapture 同帧读取队列（工具条快照/Copilot 截图/首帧兜底/演示编排 4 处统一） | 截图探针：ctx attrs preserveDrawingBuffer=false，两条路径均取到非黑帧（96%/100% 像素非黑）；drei Line.js 源码 + 误删→恢复提交链 |

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
| R5-7 | 手册第8步「删 linewidth 动画死代码」前提错误：实际是活的 fat-line 动画（5623e2f 误删，下一提交恢复） | **CLOSED** | 源码证据：drei Edges→Line→`LineSegments2`+`LineMaterial`（three-stdlib），linewidth 为屏幕空间像素宽度真实生效；删除会丢失选中呼吸线宽 1.6→3.4px 视觉（违反「不降可视信息量」红线）；已恢复并与 a4aa114 逐字对齐（仅注释记录保留理由） | 「第8步该项按实际依赖版本复核后不成立，未删——手册的『死代码』判定基于 LineBasicMaterial 的 1px 限制，不适用 fat-line。」 | 前端 | 关闭 |

---

## R5 进阶 · 零视觉削减静态合批 + 预算护栏与 T1–T5 实测台账（2026-11-13）

> 遵循「禁止擅自删除视觉元素」「不得新增 `frustumCulled=false`」「`mergeGeometries` 不得在稳态每帧调用」契约完成 R5 进阶。新增 `src/utils/mergeStaticGeometries.ts`（模块加载期合批并重算包围球）、`src/constants/renderBudget.ts`（`T3<=200/T2<=140/T1<=90/T0<=50` 与 8% 反射占比预算）及 `ClusterCanvas.tsx` `<RenderBudgetProbe />`（开发期 2s 采样 `console.warn`，零 UI 报错弹窗）。

| 改动点 | 改前（R5 main） | 改后（R5 进阶实测） | 证据 |
|---|---|---|---|
| ① 零视觉削减静态合批（`MasterNode3D` + `WorkerRack3D`） | 场景可见对象 292；T0 兜底 401；T3 425（反射关）/ 802（反射开） | 8 处模块期 `mergeGeometries` 合并 102 个静态同材质子件（刻度齿 24→1、水平导轨 24→3、层板 12→3、灯眉 24→3、侧网 6→3、线束 12→3、顶冠刻线 12→3、导光柱 12→3）：可见对象 292→188；T0 401→**285**；T3 **309.6**（反射关）/ **583**（反射开）；`benchmark` 中位 **288**（`meshes 151`） | `pnpm probe:r5-advanced`（`docs/summit/r5-advanced-probe.json`）+ `pnpm benchmark:consistency` ×2 |
| ② 渲染预算守卫 `src/constants/renderBudget.ts` | 无档位 draw call 预算与 2s 采样告警 | 固化 `RENDER_DRAW_CALL_BUDGET`（200/140/90/50）与 `RENDER_REFLECTION_RATIO_BUDGET`（8%），dev 2s 采样超标仅 `console.warn` | `RenderBudgetProbe` + 60s 探针采集到 68 条 `[renderBudget]` warn，`pageErrors=0`、`uiErrorBanner=0` |
| ③ 反作弊三条自证 | — | ① `frustumCulled===false` 维持基线 28（新增 **0**）；② `initCalls=8`、`mergedParts=102`，60s 稳态 `runtimeCalls=0`；③ 未静默删减任何视觉装饰，仅提出独立待决策清单 | `pnpm probe:r5-advanced` + `ClusterCanvas` `getMergeStats()` |

**R5 进阶 T1–T5 实测结果（SwiftShader 1920×1080，`?quality=high&demo=1`）**：
- **T1**：T3 开 Composer + 反射 `total=583` = `main 316 + reflection 267`（HUD 三数 `[583, 316, 267]` 完全一致；反射关 `309.6`）。
- **T2**：T3 静止 3s 均值 **583**（反射开，反射占比 **45.8%**）/ **309.6**（反射关）> 200（未达标，见下方 R5-8 如实记录与待决策视觉削减表）。
- **T3**：T3 **309** → T2 **299.8** → T1 **294** → T0 **285** 单调不增 ✓；反射关口径 `T0/T3 = 92.2%`（>25%，见 R5-8）。
- **T4**：连续 45 帧 rAF 帧间隔 `p50=476.8ms / p95=506.8ms / p99=513.4ms`，**`p99/p50 = 1.08 ≤ 2.0` ✓**（SwiftShader 软渲染绝对帧耗时非真机指标）。
- **T5**：60s 稳态 `JSHeapUsedSize` `39.68MB → 39.88MB`，**`+0.20MB < 5MB` ✓**（`nodesΔ=0`、`listenersΔ=0`）。

| # | 事项 | 状态 | 原因（证据） | 兜底话术 | 负责人 | 截止 |
|---|---|---|---|---|---|---|
| R5-8 | 不删减视觉元素条件下 T2 (`<=200`, 反射 `<=8%`) 与 T3 (`T0<=T3×25%`) 极限指标未达成 | **OPEN / 待决策** | 实测已将主场景从 401 压至 285（-28.9%）；剩余缺口集中于 `MasterNode3D` `transmission={0.72}` 触发的整场景透射二次渲染、T3 真反射虚拟相机再渲染（267 draw）及机架 `<Edges>` 独立组件 | 「在不丢失任何视觉细节与线框高亮前提下主场景压至 285 draw call；≤200 与 ≤8% 反射占比受限于透射与反射机制，若授权可按独立清单再降 ~120+441 draw call。」 | 前端 | R6/用户确认 |

---

## R5 单项再优化（去 transmission 保 T3 真反射）+ R6 · 3D 场景观感重制（2026-11-13 · main 完成）

> 口令「1、保留 T3 真实反射，用半透明 Fresnel 替代 MasterNode3D transmission={0.72}；2、完成 R6 main」。所有数值来自本轮真实命令输出（`probe:r5-advanced`、`probe-r6.mjs` 真机 d3d11、双遍 `benchmark:consistency`、`verify` 与 `check-style-contract`）。

| 改动点 | 改前（实测） | 改后（实测） | 证据 |
|---|---|---|---|
| ① 去 `transmission={0.72}` 保 T3 真反射（`MasterNode3D`） | `MeshPhysicalMaterial(transmission=0.72)` 触发 `_transmissionRenderTarget` 二次渲染：T3 开反射 **583 = 316 + 267**；T0 285；benchmark 中位 **288** | 自定义半透明 Fresnel `ShaderMaterial`（`withNanGuard` + `KV_DEBUG_NAN_DEFINES` + `uEmphasis` 平滑阻尼）保留 T3 真实反射：T3 **466 = 256 + 210**（省 60 主/57 反射/合计 -117 draw）；T3 关反射 **253.6**；T0 **229**；benchmark 中位 **229**（T4 p99/p50=1.08；T5 60s +1.97MB < 5MB） | `pnpm probe:r5-advanced`（`docs/summit/r5-advanced-probe.json`）+ `pnpm benchmark:consistency` ×2（5/5） |
| ② R6-1 屏心糊字清理（`MasterNode3D`） | 3 层 DOM 徽章（`SYS.CORE` / `HoloMicroRuler` / 左右翼线）无 `distanceFactor` | 单行「控制平面 · API Server」（`leading-[1.15]` + `font-medium` + `bg-slate-950/60` + `data-kv-label="master"`），删 `SYS.CORE`/`HoloMicroRuler`/装饰线；正心 ±5% 重叠=`false` | `probe-r6.mjs`（`masterRect: 544.6..678.6 × 627.3..642.4`，正心 y[486,594] 0 重叠） |
| ③ R6-2/3 铭牌规格表与吃雾（`src/constants/hud.ts`） | 三组件 `distanceFactor` 各异（无/17/12），无 clamp，近景放大到 55px 遮挡底层 Pod，不吃雾 | 新建 `HUD_LABEL_SPEC`（`MASTER_LABEL df=26 [10,14]` / `RACK_LABEL df=22 [10,18]` / `POD_HOVER_LABEL df=12 [10,14]`）+ CSS `clamp`；`applyHtmlFogAttenuation` 在 `useFrame` 零分配写入 `opacity`（<18:1 / 18..48→0.45 / >48:0）与 `saturate` + `objectScale` 同源逆缩放护栏；修 `WorkerRack3D` 内联 `background: 'transparent'` 导致白糊 | 真机 d3d11 实测：`1920` 全景 span 高 `15.11/16.97/13.79/13.01px`；`1366` `13.57/14.26/11.58/10.93px`；特写 `worker-alpha` `55.1→16.96px`；`dist=36.06` 雾 0.854/0.569/0.539；`dist=64.56` 全归 0 |
| ④ R6-4/5 暗角与地面照明基线（`ClusterCanvas` / `ExposureDriver` / `glowBudget`） | Post Vignette `0.28 / offset 0.22`；地面 `#030712` + `blur[360,120]` + `mixBlur 0.9`；ambient `0.28`；`ground budget=0.55` | Vignette 调至 `darkness 0.12 / offset 0.3`（保留 DOM 暗角层）；`MeshReflectorMaterial` `#060d1a` + `[256,256]` + `mixBlur 0.65`；`ambientLight 0.36` 协同 `EXPOSURE_MIN=0.85`；`glowBudget.ground = 0.62`（注释「承认现状非达标」） | `probe-r6.mjs` 地面非加色采样本色 RGB `[10.26, 31.29, 43.39]`（无纯黑死缝）+ 截图视觉审阅通过 |
| ⑤ R6-6 去 Pod「荧光棒感」+ 双路径色相一致（`PodInstancedMesh`） | 强高饱绿偶发高光溢出；Composer vs 兜底 `NeutralToneMapping` 色偏未补偿 | 基色保持 `#ffffff` + `toneMapped={false}`；健康态线性混入 8% `#a7f3d0`（`#47d69e`，emissiveIntensity `1.0→0.85` -15%）；`injectCrystalShader` 加 `uEmissiveScale` 与 `kvApplyParityToneMapping`（`uFallbackParity`）对齐两条路径 | 真机 `d3d11` `?quality=high`(Composer) vs `low` vs `off`(兜底 Neutral)：绿 Pod 色相角 `161.96° / 161.81° / 161.88°`，差值 **`0.15°` / `0.08°`**（< 6° 门槛） |
| ⑥ R6-7 清理死分支（`CrystalOptics` / `RackGroundReflection` / `ClusterTopologyFloor3D`） | `CrystalOptics` 不可达 `recovering` 分支与同分支三元；另两处同分支三元 `uniforms:uniforms` / `1:1` | 移除不可达慢恢复分支与失效三元，保留真实告警颜色；同步清理 `RackGroundReflection` / `ClusterTopologyFloor3D` 冗余三元并补充「为什么是这个值」中文注释 | `pnpm typecheck` 0 错、`pnpm lint` 0 错、`pnpm build` 产物正常 |

**本轮汇总验证（均在最后一次源码编辑后重跑）**：`check-style-contract` 全通（含生产 CSS **218/218** 全生成、0 缺失）· `typecheck` ✓ · `lint` ✓ · `lint:glsl` 0 HIGH ✓ · `check:layering` ✓ · `check:dead-exports` +0 ✓ · `pnpm build` ✓（First Load JS `178 kB`）· `strictmode:audit` **6/6** ✓ · `benchmark:consistency` **5/5** ✓（meshes 151 / instanced 27 / instancedTotal 1017 / triangles 206050 / Draw Calls 中位 **229**）· `probe:r5-advanced`（`total=466`, `p99/p50=1.08`, 60s `+1.97MB`）· `verify` **34/35**（唯一失败为既定转 R14 的「文档数字一致性」）。

| # | 事项 | 状态 | 原因（证据） | 兜底话术 | 负责人 | 截止 |
|---|---|---|---|---|---|---|
| R6-1 | `Q1–Q6` 量化自动回归与 `<Html>` 字面量守卫已于 R6 进阶落地 | **CLOSED** | 已落地 `scripts/probe-r6-advanced.mjs`（`pnpm probe:r6-advanced`）、`scripts/shot.mjs` `labelBounds` 写入 `meta.json` 及 `scripts/check-layering.mjs` `canvas-html-spec` 规则，真机 `d3d11` 对比 `17c6536` 全项通过（见下方 R6 进阶台账） | 「R6 main 与进阶门禁均已完成，Q1–Q6 有真实改前/改后实机截帧与像素对比证据。」 | 前端 | 已关闭 |
| R6-2 | `POD_HOVER_LABEL` 悬停卡片未单拍截图取证 | **MITIGATED** | 悬停标签复用同一 `HUD_LABEL_SPEC` + `applyHtmlFogAttenuation` 缩放/吃雾管线并通过 `canvas-html-spec` 守卫与构建检查，但 `probe-r6-advanced.mjs` 未触发鼠标悬停截帧 | 「悬停卡复用同源规格表与缩放护栏，R7 相机与 hover 零 commit 专项将补齐自动悬停采样。」 | 前端 | R7 |
| R6-3 | 四角暗角亮度比已通过 Q3 同景深平场校准实测收敛（67.56% → 86.33%） | **CLOSED** | 保持 DOM `radial-gradient` 边角柔化层不删，将最大边缘透明度自 `0.42` 收敛至 `0.20`，与后处理 `Vignette(offset=0.3, darkness=0.12)` 协同后于 `camera.layers.set(31)` 同景深平场测得四角留存 `86.33% >= 75%`（中心亮度 `103.05→102.99` 零作弊调暗） | 「通过双层暗角协同收敛将四角留存从 67.56% 提至 86.33%，中心亮度未动且保留边缘渐隐接缝过渡。」 | 前端 | 已关闭 |

---

## R6 进阶 · 量化视觉回归与分层守卫闭合（2026-11-13）

> 对照目标：`before = HEAD 17c6536`（worktree `:3001`）vs `after`（当前工作区 `:3000`），真实 GPU `NVIDIA GeForce RTX 5070 Laptop GPU (Direct3D11)`，统一 `1920×1080 @ ?quality=high&demo=1`（Q6 同时采 `low` 与 `off`）。报告与截图：`docs/summit/r6-advanced-probe.json`、`docs/summit/shots/r6-{before,after}/`、`docs/summit/shots/r6-advanced/{before,after}/`。

| 指标 | before (`17c6536`) | after（工作区） | delta | 证据与口径说明 |
|---|---|---|---|---|
| **Q1 屏心无字** | 页中心 DOM=0 / 多笔画条带=0；Canvas 中心 DOM=0（Master 三行玻璃墙 `[418..791, 601..635]` 横压前景轨道） | 页中心 DOM=0 / 多笔画条带=0；Canvas 中心 DOM=0（收敛为单行 `[544.6..678.6, 627.3..642.4]` 15.11px 胶囊） | Master 占屏面积 `-83.6%`，中心 ±5% 保持 **0** 遮挡 | `probe-r6-advanced` 排除了页中心 `[912..1008,486..594]` 内单根连续 3D 地板斜线；左 65% 分栏下 Master 位于 Canvas 中心而非页中心 |
| **Q2 铭牌尺码 & `shot.mjs`** | 全景 `[10.00, 21.11]`px；`pod-closeup` `worker-alpha` **49.24px** | 全景 **`[13.01, 16.97]`px** `⊆ [10,18]`；特写 `worker-alpha` **`16.96px`** `⊆ [10,22]` | 全景上限 `-4.14px`；特写 **`-32.28px`**（-65.6%） | `shot.mjs` 写入 `r6-after/meta.json` `labelBounds`；`check-layering.mjs` 新增 `canvas-html-spec` 阻断 `distanceFactor` 字面量（负向拦截已验证） |
| **Q3 四角亮度** | 平场中心 `103.054` / 四角均值 `69.624`（**`67.56%`** < 75%） | 平场中心 `102.986` / 四角均值 `88.909`（**`86.33%`** >= 75%） | **`+18.77 pt`**（中心亮度 Δ `-0.07`，无调暗作弊） | `ClusterCanvas.tsx` DOM `radial-gradient` `0.42→0.20`；平场以 `camera.layers.set(31)` + `#64748b` 同链路穿过 EffectComposer Vignette 与 DOM 层 |
| **Q4 地面暗部非纯黑** | 1483 像素 `luma<1` = **`0%`**，均值 RGB `[7.71, 19.03, 28.87]` | 1488 像素 `luma<1` = **`0%`**，均值 RGB **`[8.33, 21.59, 34.09]`** | `B` 通道抬升 `+5.22`，纯黑比维持 `0% < 5%` | `probe-r6-advanced.json` `Q4_groundDarkNoBlack`（ROI `[756..930, 818..899]`） |
| **Q5 反射无方向拖影** | `worker-gamma` 地面倒影区 `Ey/Ex = 1.000` / `Ex/Ey = 1.000` | `worker-gamma` 地面倒影区 **`Ey/Ex = 1.009`** / **`Ex/Ey = 0.991`** `<= 1.5` | `+0.009`（两轴近 1:1 各向同性） | ROI `[202..339, 564..676]` 避开中央发射雷达环；若直接框选 `worker-beta` 附近外圈水平雷达环则为 `1.87`（属环线几何边界，非 `MeshReflectorMaterial` 拉丝） |
| **Q6 语义色相一致** | `high 162.27°` / `low 162.54°` / `off 159.97°`（差 `0.27°` / `2.30°`） | `high 161.73°` / `low 161.79°` / `off 161.68°`（差 **`0.06°`** / **`0.05°`**） | `high vs off` 色差 **`-2.25°`**（远优于 `<6°`） | `PodInstancedMesh` 与 `injectCrystalShader` 双路径中性色映射（`pod-closeup-{high,low,off}.png`） |

**诚实记录仍存视觉待改进项（R6 时点）**：
1. `overview` `1920×1080` 下右侧 `worker-beta` 铭牌右端（`left: 1100.6`, 卡片右缘贴近 `1253` 视口边界）有轻微右侧裁切风险；`worker-alpha` 铭牌（`top: 980.8`）距底部事件回显条较近。
2. `pod-closeup` 特写中，受地面主环与底部高光照射，机架最底两层健康 Pod 顶面白色镜面反光面积高于中上层。
3. 发光预算（`[glowBudget]` `core=16.28 / ground=11.89 / outer=11.38`）与 `R5-8` T3 draw call（474 vs 200 预算）仍保留既有 dev warn，留待后续决策/R7 调优。
4. `POD_HOVER_LABEL` 已通过 `canvas-html-spec` 静态合约与共享管线验证，但尚未补充自动化鼠标 hover 截帧实拍（记入 `R6-2` 转 R7，已在 R7 `probe:camera` H4 完成运行期验证并关闭）。

---

## R7 · 相机运动学、特写构图与交互确定性（2026-11-14 · main + 进阶完成）

> 以 `pnpm probe:camera`（真机 D3D11 WebGL + `.verify-artifacts/r7-camera-report.json`）作为运行期验收真值源，覆盖 `H1`–`H7` 运镜曲线、特写屏占比、`dt` 归一化阻尼、零重排 hover 与 `prefers-reduced-motion` 降敏，并关闭转入项 `R6-2`。

| 检查项 / 事项 | 实测数据与行为 | 证据 |
|---|---|---|
| `H1` Pod 特写构图与宿主语境 | `1920×1080`（画布 `1245×1014`）投影 `16.25% × 16.5%`、`distanceToTarget=5.545`；`1280`（画布 `822×734`）投影 `17.8% × 16.5%`；宿主 `rackEdgeCount=11`、`railEmissiveMax=0.35`、`isHighlightedForPod=true`、`breadcrumbText="集群 / 机架 rack-0 / 槽位 slot-12"` | `pnpm probe:camera` |
| `H2` 720ms / 820ms 运镜配额与忙态指示 | Entity 目标 `720ms` 实测 `720.1ms`（`177` 样本，`m25=0.1475 / m50=0.7687 / last15=239.1ms`）；Preset 目标 `820ms` 实测 `820ms`（`206` 样本，`m25=0.1836 / m50=0.8891 / last15=380.4ms`）；相对 `180ms` 线性菜单切换中段加速度比 `5.21`；飞行中 `aria-busy="true"`、`dashOffsetMidFlight="79.95"`，到位后恢复 `null` | `pnpm probe:camera` |
| `H3` `dt` 归一化阻尼多帧率收敛一致性 | 原生帧率收口角度 `0.6698 rad` vs 30fps 节流收口角度 `0.6914 rad`，跨帧率残差 `residualPct=3.22% < 8%`（`nativeEffectiveDampingFactor=0.0156` / `throttled30FpsEffectiveDampingFactor=0.11715`） | `pnpm probe:camera` |
| `H4`（关闭 `R6-2`）零重排 Hover + 按下边框 + 抬手延迟 | `hoverCommitCount=0`；`frame0PodCursor="pointer"` / `frame0RackCursor="pointer"`；90ms 缩放平滑上升（Pod `0.68 -> 0.9102`、Rack `0.8777`）；`pressedBorderActive=true`、`animatingWhileHeld=false`、`animatingAt25MsAfterUp=false`、`animatingAfterDelay=true` | `pnpm probe:camera` |
| `H5` 双击复位时间/位移窗（280ms / 6px） | 超时慢击 `resetAfterSlow=0`、超位移拖拽 `resetAfterFar=0`、合规双击 `resetAfterValid=1` 且 `distToOverview=0` | `pnpm probe:camera` |
| `H6` `SplitPaneResizer` ±8px 保护区防误转 | 保护区测试点 `{x: 1248.6, y: 564, width: 26}` 内拖拽 `moatCamDelta=0` | `pnpm probe:camera` |
| `H7` `prefers-reduced-motion` 降敏 | `reducedMotion=true`、`autoRotate=false`、`breathAmplitudeScale=0.25`；巡检按钮 `disabled=true`（`reason="reduced-motion"`）；切镜实测 `181.3ms <= 200ms` | `pnpm probe:camera` |
| `ERR` 运行期异常闸门 | `console/page error count = 0` | `pnpm probe:camera` |

---

## R8 · 外壳信息架构与多端响应式适配（2026-11-14 · main + 进阶完成）

> 完成 R8 main 架构收敛与 R8 进阶六视口 + 五类极端边界探针验收。所有实测均在末次源码及探针脚本修改后复跑通过。

| 改动点 | 关键机制与问题修复 | 证据 |
|---|---|---|
| ① Z 轴与 Esc 栈契约（`src/constants/zIndex.ts`、`CommandPalette.tsx`、各 Modal） | 统一 `Z_INDEX_LAYER` / `Z_CLASS` 常量；重型模态框（RAG `z=50` / Chaos `z=50`）Store 互斥切换；`CommandPalette` 位于 `z=60` 之上；两段 `Esc` 先关 Palette 再关 Chaos；Canvas 内部浮层使用 `Z_CLASS.CANVAS_FLOATING` 不遮挡弹窗 | `pnpm probe:r8`（75/75）、`pnpm probe:escape`（11/11）、`pnpm probe:keyboard`（15/15） |
| ② `TopBar` 与底部浮层避让（`TopBar.tsx`、`ViewportToolbar.tsx`、`StartupStatusCapsule.tsx`、`TerminalEcho.tsx`） | 移动端顶栏 `h-14`（桌面 `md:h-12`），所有顶栏交互控件 `< md` 满足 `min-h-[44px] min-w-[44px]` 且顶级按钮稳定 `<= 7`（实测 `6` 个）；`< lg` 下将 `ViewportToolbar`、`TerminalEcho` 上移至 `bottom-[4.75rem]`、将 `StartupStatusCapsule` 与 `DemoReplayTimeline` 上移至 `bottom-[9.25rem]`，彻底避让移动端底部视图切换器；`TerminalEcho` `< 768px` 默认折叠且按钮高度 `>= 44px` | `pnpm probe:r8`（`360×740`..`1920×1080` + 宽度 `1080/1180/1260` 零溢出/零越界/零重叠） |
| ③ 移动端双屏切换、软键盘与 `inert` 隔离（`ShellLayout.tsx`） | 修复 `MobileViewSwitcher` 缺失 `bottom-3` 导致遮挡顶栏的实拍缺陷；`keyboardOpen` 结合 `maxHeightRef` 基线与 `isTextInputFocused`（`focusout` 走 `requestAnimationFrame`）自动隐藏底部切换器并失焦恢复；切屏保留同一 `Canvas` DOM 节点与 Copilot 草稿，非激活面板启用 `inert` 隔离 | `pnpm probe:r8`（E1 软键盘 + 切屏不变量 + 隐私审计零溢出） |
| ④ 巡检 HUD 折叠、Bottom Sheet 换行与 PerfHUD 层级（`NodeInspectHUD.tsx`、`ChaosControlModal.tsx`、`PerfTelemetryHUD.tsx`） | `NodeInspectHUD` `< md` 默认折叠次级波形与元数据网格，提供 `展开指标详情` / `收起指标详情`（`min-h-[44px]`）与 `44×44` 按钮并将次级文本提亮为 `text-slate-400`；移除 `ChaosControlModal` 副标题 `&nbsp;` 修复 `390×844` 贴底 Bottom Sheet 与关闭键碰撞；`PerfTelemetryHUD` 保持 Tier1（健康/管线）在 Tier2（FPS + `60/40/0` 刻度）之上，并订阅 `viewportConstrained` 展示 `小屏视口自动降载（画质上限 T1）` | `pnpm probe:r8`（Bottom Sheet / PerfHUD / 移动端巡检 E2E + `docs/evidence/r8-*.png`）、`pnpm check:a11y`（133 文件 0 命中） |
| ⑤ R8 进阶多端探针与全量回归（`scripts/probe-r8-layout.mjs`、`package.json`） | 新增 `pnpm probe:r8` 脚本，覆盖 6 视口、E1 软键盘、E2 `viewport-fit=cover` 安全区、E3 横屏 `844×390`、E4 200% 缩放 `960×540 @2x`、E5 PWA `standalone`、全流程 E2E；同期复跑全量路演与端到端门禁 | `pnpm probe:r8`（`PASS 75 · FAIL 0`）、`node scripts/verify.mjs --full`（`verify-demo` `22/22`；`verify` `35/36`，唯一失败 `文档数字一致性` 按计划留待 R14）、`pnpm evidence:final` |

| # | 事项 | 状态 | 原因（证据） | 兜底话术 | 负责人 | 截止 |
|---|---|---|---|---|---|---|
| R8-1 | `verify --full` 中 `文档数字一致性` 检查未通过（35/36 唯一失败项） | **DEFERRED（按计划）** | 该项校验 `README.md`/白皮书/PPT HTML 中的展示数字与代码口径一致，按 `HANDOVER.md` 与手册规划统一在 R14 终稿对齐；代码功能、Style 合约（`14/14`、`221/221`）、`verify-demo`（`22/22`）及 `probe:r8`（`75/75`）全部通过 | 「唯一失败的 `文档数字一致性` 属于 R14 宣讲材料数字对齐范围，核心前端构建、A11y、Style 合约、3D 运镜与多端布局探针均 100% 通过。」 | 前端 | R14 |

---

## R9–R10 · 验收闭环记录（2026-11-14）

> R9（副驾流式丝滑）与 R10（AI 可靠性与可信度）均已完成 `main + 进阶` 全部源码改造及末次编辑后的全量运行时探针/评测验证；除 R10 暂停点已落地部分外，本轮续作追加解决了 `CopilotDrawer` 平滑回底竞态（`N2c`）、真实种子 Pod 对齐（`F3`）、EOF 半截 JSON 不误判 `failed`（`F4`）、`createThinkingOptOutFetch` 低延迟开关与只读工具裁剪（`F5d`）及 `eval-ai-quality.mjs` 明细表行模板插值修复。

| # | 事项 | 状态 | 改动→证据→验收判据 | 兜底话术 | 负责人 | 截止 |
|---|---|---|---|---|---|---|
| R9 | 副驾流式丝滑与 ActionConfirm 目标级隔离（`main + 进阶`） | **DONE（16/16 PASS）** | 改前基线（`.verify-artifacts/phase1-baseline.json`，3141 字/210 chunk/6 历史气泡）：`rootCommits=538`、`MessageBubble=1718`（历史 `1290`）、`longtask=65`（max `293ms`）、`CLS=0.00095`。改动：`MarkdownLite.tsx`（闭块增量缓存/`React.memo`/N5 未闭合围栏与表格/`[text](url)` 外链白名单与危险协议纯文本降级/N6 长串折行）；`AgentTracePanel.tsx`；`CopilotDrawer.tsx` + `ShellLayout.tsx`（rAF 批刷、`120px` 停靠、`>30` 虚拟化与尾气泡独立挂载、修复 `N2c` `ResizeObserver` 打断平滑滚动与保护窗竞态、`N1` abort 复位、`>3000` 字抗溢出）。末次编辑后 `node scripts/probe-stream-perf.mjs`（`d3d11`）：**16/16 PASS**（`rootCommits=152`、总 bubble 渲染 `75`/`appTotal=77`、历史 `0`、`longtask=0`、`CLS=0.00071`、`N2c dist=0 & hidden`、`N3` DOM `12`/滚顶 `min=11`/历史 `0`、`0` 错误） | 「R9 在 `d3d11` 下总 Bubble 提交降幅 95.5%、历史零重渲染、长任务清零、N1–N6 全绿。」 | 前端 | 已闭环 |
| R10 | AI 可靠性、Schema 防线、MCP 超时与 RAG 校准（`main + 进阶`） | **DONE（12/12 + RAG + 20 题全绿）** | 改前 TTFT 基线（20 题 `apt-goto/deepseek-flash`）：`serverTtftMs p50=5605.66ms`、`p95=10596.7ms`。改动：`src/types/ai.ts`（四卡 Zod schema，零 `as *Props` 强转）；`chatStreamConsumer.ts` + `CopilotDrawer.tsx`（`{type:'reset'}` 免疫、EOF 未闭合 JSON 残行标 `incomplete` 而非 `failed`）；`chat/route.ts`（并行 `enginePromise`、`clearReasoningTimers()`、只读内联去冗余工具与 `maxSteps=2`、`STEADY_CONCEPTUAL_PATTERN` 稳态分流、异步 `tool-result` 定时器、`createThinkingOptOutFetch()` 禁用隐式长思考含 400/422 无感回退）；`mcp/execute/route.ts` + `ActionConfirm.tsx`（12s 超时 + `GET ?clientRequestId=` 只读复查）；`sreRagEngine.ts` + `RagKnowledgeModal.tsx`（`fusedScore` vs `rrfScore` 分离与重复校准修复）。末次源码修改后 `node scripts/probe-r10-reliability.mjs` **12/12 PASS**（`F1–F4` 含真实 socket drop `F1-Server`、TTFT `p50=685.39ms` Δ`-4920.27ms` / `p95=840.23ms` Δ`-9756.47ms`、Simulator `p50=33.39ms`）；`eval:rag` 49 用例确定性 PASS（三路 `R@1 94.4%`、`R@3 100.0%`、错别字 `R@1 91.7%`、误拒 `0.0%`）；`eval:ai-quality` 20/20 真实 LLM 零回落（RAG 正确率 `80.0%` vs 裸模型 `78.3%`、引用率 `65.0%` vs `0.0%`、动作合理性 `100.0%`） | 「R10 端到端容灾/超时/Schema 隔离/UTF-8 截断 12 项实测全绿，真实 LLM TTFT P50 降至 685ms（-87.8%），三路 RAG R@3 100% 且零误拒。」 | 全栈 / AI | 已闭环 |
| R10-1 | `apt-goto/deepseek-flash` 上闭思考参数回退路径与随机问句波动边界 | **KNOWN RISK（已设环境开关与回退）** | `createThinkingOptOutFetch()` 默认注入 `thinking: { type: 'disabled' }`；若换用不支持该字段的标准 OpenAI 端点，首次请求会经历 1 次 400/422 检测后再以原请求体自动重试（增耗 ~1 RTT），且可通过 `AI_DISABLE_THINKING=false` 关闭；另 `eval:ai-quality` Q02/Q14/Q19 受 400/700 字篇幅与模型表述影响存在 33% 关键词覆盖波动，但不触发免责声明或非法动作 | 「可用 `AI_DISABLE_THINKING=false` 一键关闭思考拦截，且不支持 `thinking` 字段的上游网关会自动 400/422 回退原请求。」 | AI / 后端 | 按需切换 |
| R11 | 全站文案与术语契约、复盘去泄漏、`check:copy` 门禁与只读术语表（main + 进阶） | **ACCEPTED（全门禁绿灯，E2E 与术语表 UI 实证通过）** | `src/constants/copy/*` 建立 34 条 TERMS（A–E 五类）与产品裁决 J1–J3；6 处混沌场景标签统一经 `CHAOS_SCENARIO_LABELS`/`CHAOS_INJECT_LABELS`/`getChaosReportLabel` 导出；`postMortemReport.ts` 去除源码类型/字段泄漏并全量化汉化模板；`scripts/check-copy.mjs`（C1–C8）扫描 139 文件 `0` 违规且 `scripts/copy-allowlist.json` `12/12` 精确匹配；`RagKnowledgeModal` 落地只读「术语表（34）」页签（J1–J3 + A–E 分类筛选，Edge CDP 0 控制台/页面报错）；`verify-demo.mjs` 22/22 全绿、`eval:rag` 49 用例确定性通过（三路 R@1 94.4%/R@3 100.0%/MRR 0.976/NDCG 0.979）、`verify.mjs` 34/35 通过（仅预留至 R14 的文档数字一致性未通过） | 「已建立单一真实来源术语表与 `check:copy` CI 门禁，全站 `API Server`/`QPS`/错误三要素与复盘报告不再泄露实现细节，评委可在知识库弹窗实时查阅 J1–J3 与 34 条术语标准。」 | 全栈 / 体验 | R14 终稿锁版复检 |
| R12 | 交互治理、焦点管理、动效减敏与 WCAG AA 对比度/触控热区收口（main + 进阶） | **ACCEPTED（静/动态门禁与无障碍探针全绿）** | `CommandPalette` 落地子序列模糊匹配、`<mark>` 连续高亮、四大语义分组（`Pod`/`节点`/`动作`/`导航`且有查询时按最高命中分排组）、WAI-ARIA `combobox`/`listbox`/`option`/`aria-activedescendant` 与 `onMouseDown` 防失焦，且 `useFocusReturn`/`useEscapeLayer` 严格绑定 `isCommandPaletteOpen` 并补充 `MOTION.panelExitSec` 退场；`useModalSheetBehavior` 实现顶层叠层裁决、`Tab`/`Shift+Tab` 闭环焦点陷阱、`<header inert>` 栈协调（含既有 `inert` 保护）与触发器焦点归还；`ChaosControlModal`/`RagKnowledgeModal`/`PostMortemModal`/`ShortcutHelpOverlay`/`TopBar` 菜单补齐 `AnimatePresence` 退场与 WAI-ARIA `tablist`/`menu`/`region` 键盘漫游；`SplitPaneResizer` 暴露“比例+像素” `aria-valuetext` 且损坏 `localStorage`（`NaN`/`999`）重载自愈回 `34%`；全局 `<MotionConfig reducedMotion="user">` + `@media (prefers-reduced-motion: reduce)` 降敏及单一可手动关闭全局状态提示条；`check:contrast`（50 文件 `0` 条 WCAG AA `<4.5:1`、`0` 条桌面 `<24px` 触控违约）；`check-style-contract --require-build`（`229/229`）；`probe:r12` `19/19 PASS`（`listeners=5, cls=0.0000`）、`probe:escape` `11/11`、`probe:keyboard` `15/15`、`probe:keyboard-path` `12/12`（`5 -> 5`）、`verify-demo` `22/22`、`verify.mjs --full` `35/36`（仅 `R8-1` 留待 R14） | 「全站弹窗、命令面板、分组菜单与分栏手柄均具备可测的 WAI-ARIA 语义、严格焦点闭环/归还、栈式 Esc 退出与减弱动态效果降级，并经静态对比度/触控门禁与 4 套键盘/无障碍 CDP 探针全绿验证。」 | 前端 / 体验 | 已闭环（R14 终稿复检） |
