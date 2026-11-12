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
