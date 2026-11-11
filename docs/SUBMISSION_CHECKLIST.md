# 提交物检查清单（SUBMISSION CHECKLIST）

> 赛事页面：https://www.boxuegu.com/matchTrack/detail/?id=10037
> 所有"待填/待录/待打包"项必须在提交前完成；不确定信息标「待确认」，不伪造。
> 时间标记：T = 提交截止时刻。

## 1. 15 项提交物清单

| # | 提交物 | 状态 | 位置 | 负责人 | 截止 |
|---|---|---|---|---|---|
| 1 | README 重构（赛事/团队/唯一 3 分钟/路演/局限/死链） | **已补（R55）** | `README.md` | 队长 | T-7 |
| 2 | 赛事全称/赛道/官网/团队信息表 | **已补**（团队信息占位待填） | README §1 | 队长 | **T-3** |
| 3 | 技术白皮书升级（R02–R18、12 处口径、数字对齐） | **已补（R55）** | `docs/COMPETITION_TECHNICAL_WHITEPAPER.md` | 文档 | T-3 |
| 4 | 白皮书 PDF（生成时间晚于最后代码提交、≤10MB） | **已生成：1.75MB / 26 页 / 2026-11-11 13:16** | `docs/COMPETITION_TECHNICAL_WHITEPAPER.pdf` | 文档 | T-1 |
| 5 | 路演 PPT（12 页，PDF ≤10MB） | **已生成：3.80MB / 2026-11-11 13:16** | `docs/KubeVision_PITCH.pdf` | 队长 | T-3 |
| 6 | 3 分钟视频（1080p30、≤3:00） | **仍缺：待录制** | `recording/KubeVision_3min_FINAL_1080p30.mp4` | 主讲/录制 | **T-2** |
| 7 | 60s 无旁白版 | **仍缺：待剪辑** | `recording/KubeVision_60s_silent_1080p30.mp4` | 录制 | T-2 |
| 8 | 源码包（排除 node_modules/.next/.git/大文件，含命名规则） | **仍缺：待打包命名** | `docs/SUBMISSION_PACKAGE.md` | 队长 | **T-1** |
| 9 | 启动说明（Node≥18.17、pnpm、无 Key 可跑） | **已补** | `启动说明.md` | 文档 | T-7 |
| 10 | Dockerfile/.dockerignore/部署步骤（SSE 注意） | **已补（未 docker build）** | `Dockerfile`、`.dockerignore`、`docs/DEPLOYMENT.md` | 工程 | T-3 |
| 11 | 证据链（`docs/evidence/` + 索引） | **已补** | `docs/EVIDENCE.md` | 测试 | T-2 |
| 12 | 合规（LICENSE/NOTICES/模型/语料来源） | **已补；LICENSE 决策待确认** | `LICENSE`、`THIRD_PARTY_NOTICES.md` | 队长 | **T-3** |
| 13 | 商业价值页（客户/竞品/模式/单位经济/PoC） | **已补（数字均标假设）** | `docs/BUSINESS_CASE.md` | 产品 | T-3 |
| 14 | 文档数字一致性脚本 + verify + CI 门禁 + 交叉矛盾核对 | **已补**：`verify --quick` 7/7；CI 见 `.github/workflows/verify.yml` | `scripts/check-docs-consistency.mjs`、`.github/workflows/verify.yml` | 测试 | T-3 |
| 15 | 现场预案（双机/录屏执行单/彩排/兜底） | **已有** | `docs/summit/RECORDING_KIT.md`、`R55-RECORDING-RUNSHEET.md`、`DUAL_MACHINE_CHECKLIST.md`、`JUDGE_REHEARSAL.md`、`DEMO_DIRECTOR_PLAYBOOK.md` | 队长 | T-2 |

## 2. 提交前 24 小时检查表

| 时间 | 检查 | 通过标准 | 失败处理 |
|---|---|---|---|
| T-24h | 全量回归 | `node scripts/verify.mjs` 34/34；`node scripts/verify-demo.mjs` 通过 | 修复或降级演示链路 |
| T-24h | 文档一致性 | `node scripts/check-docs-consistency.mjs` 通过 | 重跑 benchmark + sync-docs-metrics |
| T-23h | PDF 重新生成 | 白皮书/PPT PDF 的生成时间晚于最后一次代码提交；各 ≤10MB | 重新生成，不手改 PDF |
| T-22h | 视频母版 | 3:00 内、1080p30、无通知/无画圈；60s 版就绪 | 重录指定段 |
| T-20h | 双机演练 | 主讲机+备份机同 BUILD_ID；断网可跑；≤60s 切换 | 重做离线包 |
| T-18h | 源码包 | 命名含学校+队名+队长联系方式；解压可 build/start；无 `.env.local` | 重新打包 |
| T-14h | 团队信息 | README 中 `【待填写】` 全部替换 | 立即补齐 |
| T-12h | 合规 | LICENSE 决策确认；NOTICES 与模型/语料声明齐全 | 团队确认后替换 |
| T-8h | 现场物料 | U 盘（zip/mp4/安装包/线材/电源）、打印分镜卡与检查表 | 补买/拷贝 |
| T-4h | 现场彩排 | 投影 > 网络 > 音量 > 鼠标 全过；3 分钟误差 ≤10s | 按兜底矩阵处理 |
| T-2h | 最后冻结 | 不再改代码/依赖；只允许改演示顺序 | 记录风险，不再提交 |
| T-1h | 备份 | 两个 mp4 + 源码包 + 离线包各三处副本；校验和核对 | 现场重拷 |

## 3. 待团队确认项（不伪造）

1. 团队名称/学校/院系/成员/指导教师/队长联系方式（README §1 占位）；
2. 是否向大赛官网完成报名与作品提交（本仓库不记录报名状态）；
3. LICENSE 最终选择：MIT（当前默认）或「仅限竞赛评审使用」；
4. 是否提供真实 K8s 集群用于 PoC（当前无）；
5. 视频是否上传 B 站（非必需，仅额外副本）。

## 4. 一键复核命令

```bash
node scripts/check-docs-consistency.mjs
node scripts/verify.mjs --quick
node scripts/verify.mjs            # 需 dev server + 浏览器
node scripts/benchmark.mjs         # 刷新 performance.json（会改变数字，需随后 sync）
node scripts/sync-docs-metrics.mjs
node scripts/build-whitepaper-pdf.mjs
node scripts/build-pitch-pdf.mjs
```