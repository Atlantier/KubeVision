# v12-summit 发布说明（RELEASE NOTES）

> Tag：`v12-summit`（指向本轮收口提交） · 日期：2026-11-11 · 分支：`chore/dead-code-cleanup`（含全部 v12 交付）
> 本说明只记录**已验证**内容；未完成项见 `docs/summit/RISK_LEDGER.md`。

## 1. 本版交付摘要

| 领域 | 内容 |
|---|---|
| 演示与答辩 | 真实 UI 分镜（R53）、录屏工程化与执行单（R54/R55）、双机与离线包（R54，离线启动/ MCP / RAG 实测） |
| 文档 | README 重构（唯一 3 分钟路径 + 自动演练 + 数据边界）、白皮书升级（R02–R18、12 处口径、PDF 26 页/1.75MB）、PPT 12 页（3.78MB） |
| 工程收口 | `verify:all` 聚合回归（失败即停 + 现场保存）、文档数字一致性门禁 + 交叉矛盾核对 + CI workflow、a11y 低对比修复、`verify-telemetry`/`verify-demo` 适配 R41/R52 变更 |
| 稳定性 | `soak-closeout`（60 分钟循环）与 `page-open-monitor`（3 小时页面常开）脚本；本轮已启动 60 分钟循环（实际完成轮次见 `docs/soak-closeout.md`） |
| 证据 | `docs/evidence/` 全量截图与日志；`docs/EVIDENCE.md` 索引；走查截图 `docs/evidence/walkthrough/` |

## 2. 关键数字（同步最新 benchmark：`docs/performance.json` @ 2026-11-14）

| 指标 | 值 | 备注 |
|---|---|---|
| Draw Calls 中位 | **235**（采样 235~238） | SwiftShader，硬件无关可作证据 |
| Triangles 中位 | **206,626** | 同上 |
| 场景对象 | 154 Mesh / 27 InstancedMesh / 1,017 实例 | 同上 |
| RAG 检索延迟 | 均值 **8.39ms** / P95 **12.05ms** | 真实耗时 |
| 脱敏吞吐 | **11,264 条/秒**（100 条/批） | 真实耗时 |
| 端侧推理 | 0.12ms，`builtin (fallback)` | **不是**神经网络延迟 |
| 首屏体积 | 路由 107 kB / First Load 194 kB | next build |
| FPS（软渲染） | 4.75（均值）/ 5（中位） | **不作为性能证据** |
| 自动化验收 | **36/36** | `docs/verify-summary.json` |
| RAG 评测（49 例） | 两路 R@1 88.9% → 三路 **94.4%**（+5.6pp）；负例拒答 100%；误拒 0% | `docs/rag-eval.json` |
| AI 质量（20 问） | 引用命中 **95% vs 50%**；正确率 91.7% vs 91.7% | `docs/ai-quality.json` |
| 断网回落 | TTFT **6,688.66ms**（含重试）→ simulator | 不是 1 秒 |
| 黑屏探针 | demo/chaos-oom/chaos-net/dpr-drop 各 **0/3** | 独立会话探针 |

## 3. 验收状态（`pnpm verify:all` 历史收口与当前基线）

- 聚合脚本：`scripts/verify-all.mjs`（完整串行跑完全部步骤并汇总）；
- R12 历史记录（2026-11-11）：第 1–10 步曾全绿、第 11 步 `verify-demo` 记录当时未通过 3 项（现已于 R13/R14 闭环）；
- R14 最新基线：`verify` **36/36**（新增 HTTP 安全响应头门禁）、`verify-demo` 连续 3 轮全绿、`adversarial-walkthrough` 8×20（160 次）全绿，详见证据 `docs/summit/R14-FINAL-RELEASE-REPORT.md`。

## 4. 已知局限（与风险台账一致）

1. 自动路演在软渲染 + 慢模型环境阶段 4 HITL 会超时；手动链路可用（#1）；
2. 页面左下持续 1 个控制台 error（`Uncaught`），未定位（#16）；
3. 3 分钟视频 / 60s 无旁白版未录制（#2）；团队信息占位（#3）；LICENSE 待确认（#4）；
4. Docker 未实际构建验证（#5）；CI workflow 未在 GitHub Actions 实跑（#12）；
5. 真实 K8s 集群、浏览器端侧模型、三路召回、多步工具未真机验证（#7–#9）；
6. 60 分钟 soak 仅完成部分轮次、3 小时页面常开未执行（#6）；
7. 路演 seek 阶段跳转未实现（#11）。

## 5. 产物清单

```
docs/COMPETITION_TECHNICAL_WHITEPAPER.pdf   26 页 / 1.75MB / 2026-11-11 13:16
docs/KubeVision_PITCH.pdf                   12 页 / 3.78MB / 2026-11-11
docs/EVIDENCE.md                            证据索引（证据→结论→复现命令）
docs/evidence/                              verify/benchmark/走查/路演/黑屏日志
docs/summit/RISK_LEDGER.md                  风险台账（16+ 项）
docs/summit/MANUAL_WALKTHROUGH.md           全量手动走查（14 项，含 ⚠ 项）
docs/summit/R55-RECORDING-RUNSHEET.md       录屏执行单
docs/SUBMISSION_CHECKLIST.md                15 项提交物 + 24h 检查表
启动说明.md / Dockerfile / docs/DEPLOYMENT.md
scripts/verify-all.mjs / scripts/soak-closeout.mjs / scripts/page-open-monitor.mjs
```

## 6. 回滚点

- 本版 tag：`v12-summit`（当前 HEAD）；
- 回到收口前：`git reset --hard v12-summit^`（即 R56 提交）；
- 回到 v12 基线：`git reset --hard v12-baseline`（若存在）；
- 单轮回滚：按各 `docs/summit/R4x-*.md` 中的 `git revert` 记录。

> 提醒：`release/` 离线包与 `recording/` 视频均不入 git（已 `.gitignore`）；它们与 tag 不绑定，需单独随 U 盘提交。