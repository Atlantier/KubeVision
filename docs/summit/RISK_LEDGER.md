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
