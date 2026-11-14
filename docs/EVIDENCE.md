# 证据链索引（EVIDENCE）

> 所有证据均来自当前仓库脚本的真实运行；图片/日志文件名带日期。
> 结论只写"证据能证明什么"，不写"我们很棒"。

| # | 证据文件 | 证明结论 | 复现命令 |
|---|---|---|---|
| 1 | `docs/verify-summary.json` · `docs/evidence/verify-*.png` / `.log` | 自动化验收 **36/36 通过（0 失败 0 跳过）**，含静态/安全响应头/接口/浏览器四类 | `node scripts/capture-evidence.mjs` |
| 2 | `docs/performance.md` + `docs/performance.json` | 性能基准（draw calls 中位 **235**、三角面 **206,626** 中位、RAG 均值 **8.39ms**、脱敏 **11,264 条/s**、首屏 First Load **194 kB**）；环境 SwiftShader | `node scripts/benchmark.mjs` |
| 3 | `docs/evidence/benchmark-consistency-2026-11-11.log` | R06 双跑一致性：场景对象/实例数/中位三角面/首屏体积等硬件无关字段一致（triangles 仅锁中位，mean 抖动 0.002% 已在脚本注释说明） | `node scripts/benchmark-consistency.mjs` |
| 4 | `docs/evidence/roadshow-phase2-2026-11-11.png` | 路演阶段 2/4 · 故障注入与空间锁定（真实运行截图） | `node scripts/shot.mjs --scene demo-phase2` |
| 5 | `docs/evidence/roadshow-phase4-2026-11-11.png` | 路演阶段 4/4 · MCP 闭环自愈 | `node scripts/shot.mjs --scene demo-phase4` |
| 6 | `docs/evidence/roadshow-preflight-fail-2026-11-11.png` | 路演预检失败态（字幕「DEMO-PREFLIGHT · 未通过」） | `node scripts/shot.mjs --scene demo-preflight-fail` |
| 7 | `docs/evidence/final-overview-2026-11-11.png` | 最终版首屏（三机架 + 晶体 + HUD） | `node scripts/capture-final-evidence.mjs` |
| 8 | `docs/evidence/performance-hud-2026-11-11.png` | Shift+P 性能 HUD 实拍（draw calls 等） | 同上（点顶栏「性能」） |
| 9 | `docs/evidence/rag-three-way-2026-11-11.png` | RAG 三路检索结果：**90% / 76% / 73%**，含 Vector/BM25/Context 占比；负例出现「未命中任何 Runbook」 | 同上（输入「容器内存爆了 exit 137」） |
| 10 | `docs/evidence/auditor-before-after-2026-11-11.png` | 端侧审计脱敏前后对比 + 敏感类型计数（原始凭证零出域的可视证据） | 同上（端侧页签 → 预设「数据库连接串泄露」→「抓取并审计日志流」） |
| 11 | `docs/evidence/blackout-probe-2026-11-11.log` | WebGL 黑屏探针：**0/1 复现，判定绿灯** | `node scripts/probe-blackout.mjs` |
| 12 | `docs/evidence/demo-director-tests-2026-11-11.log` | R04 导演状态机单测**全部通过**（含覆盖率 97.43% 行覆盖） | `node scripts/run-demo-tests.mjs` |
| 12b | `docs/evidence/verify-demo-2026-11-11.log` | **如实记录**：浏览器路演回归本次 4 项未通过（阶段 2 超时、受害者覆盖 0/0、动作卡未 executed、J-5/J-6 空值），属已知时序问题，**不作为通过证据** | `node scripts/verify-demo.mjs`（需 dev server） |
| 13 | `docs/rag-eval.json` / `docs/rag-eval.md` | R17/R14 RAG 评测：49 用例，两路 R@1 88.9%、三路 94.4%（+5.6pp），负例拒答 100% | `pnpm eval:rag` |
| 14 | `docs/summit/artifacts/r53-ui-labels.txt` | 真实 UI 按钮/aria 抓取证据（演示文案与代码一致） | `node scripts/dump-ui-labels.mjs` |
| 15 | `docs/summit/artifacts/r43-*.log`、`docs/summit/R43-*.md` | R16 trace 明细：spans/usage/traceId 真实记录 | 路由内 trace-summary 事件；见 R43 文档 |

## 使用说明

1. 评审现场优先展示 #1/#2/#9/#10 四张（验收、性能、检索、隐私）；
2. 路演三帧（#4/#5/#6）用于证明自动演练与失败态诚实；
3. 任何数字被质疑时，先给 `docs/performance.json`，再给 #2 原始日志；
4. 证据文件不入 `.gitignore`（随仓库提交）；单张 >1MB 的截图共 5 张，总量约 4.2MB，可接受；
5. 若平台限制包体积：保留 #1/#2/#4/#5/#6/#9/#10 + 本索引，其余提供复现命令。