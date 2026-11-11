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

## 2. 关键数字（同一次 benchmark：`docs/performance.json` @ 2026-11-11T05:03:26.775Z）

| 指标 | 值 | 备注 |
|---|---|---|
| Draw Calls 中位 | **423**（采样 420~423） | SwiftShader，硬件无关可作证据 |
| Triangles 中位 | **206,028** | 同上 |
| 场景对象 | 322 Mesh / 25 InstancedMesh / 1,026 实例 | 同上 |
| RAG 检索延迟 | 均值 **8.27ms** / P95 **9.97ms** | 真实耗时 |
| 脱敏吞吐 | **12,880 条/秒**（100 条/批） | 真实耗时 |
| 端侧推理 | 0.09ms，`builtin (fallback)` | **不是**神经网络延迟 |
| 首屏体积 | 路由 88.9kB / First Load 176kB | next build |
| FPS（软渲染） | 2.7 | **不作为性能证据** |
| 自动化验收 | **34/34** | `docs/verify-summary.json` |
| RAG 评测（49 例） | 两路 R@1 66.7% → 三路 **69.4%**（+2.8pp）；负例拒答 87.5%；误拒 0% | `docs/rag-eval.json` |
| AI 质量（20 问） | 引用命中 **95% vs 50%**；正确率 91.7% vs 91.7% | `docs/ai-quality.json` |
| 断网回落 | TTFT **6,688.66ms**（含重试）→ simulator | 不是 1 秒 |
| 黑屏探针 | demo/chaos-oom/chaos-net/dpr-drop 各 **0/3** | 独立会话探针 |

## 3. 验收状态（`pnpm verify:all` 真实结果）

- 聚合脚本：`scripts/verify-all.mjs`（19 步，失败即停、日志落盘、汇总表）；
- 第 1–10 步 **全部通过**：tsc / next lint / lint:glsl / check:a11y / check:emoji / check:layering / check:dead-exports / verify（**34/34**）/ verify-stream-integrity / verify-telemetry（9/9）；
- 第 11 步 `verify-demo` **失败即停**：通过 19 · 失败 3（J-3 自动路演动作卡未 executed、J-4 `Uncaught`、J-6 暂停时长读取 null）；现场已归档 `docs/summit/failures/2026-11-11T06-39-30-689Z/` 与 `docs/evidence/verify-all/2026-11-11T06-32-27-307Z/`；
- 其后 8 步按规则未被聚合脚本执行，已**手动串行补跑并全部通过**：`probe-blackout` ×4（各 0/3）、`eval-rag`、`mcp-smoke`（10/10）、`verify-privacy`（5/5）、`check-docs-consistency`；日志在 `docs/evidence/verify-all-continue-2026-11-11/`；
- **手动链路补证**：走查中人工点击「立即执行自愈方案」成功，显示「已执行 · 3D 拓扑已自愈恢复」、MCP 回执、健康分 77→96（`walkthrough-04b-action-executed-2026-11-11.png`）。

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