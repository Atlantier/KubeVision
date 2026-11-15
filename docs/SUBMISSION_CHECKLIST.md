# 提交物检查清单（SUBMISSION CHECKLIST）

> 赛事页面：https://www.boxuegu.com/matchTrack/detail/?id=10037
> 所有"待填/待录/待打包"项必须在提交前完成；不确定信息标「待确认」，不伪造。
> 时间标记：T = 提交截止时刻。

## 1. 15 项提交物清单

| # | 提交物 | 状态 | 位置 | 负责人 | 截止 |
|---|---|---|---|---|---|
| 1 | README 重构（赛事/团队/唯一 3 分钟/30s 评审入口/虚实边界/死链修复） | **已同步最新工程改造** | `README.md` | 队长 | T-7 |
| 2 | 赛事全称/赛道/官网/团队信息表 | **已补**（团队信息占位待填） | README §1 | 队长 | **T-3** |
| 3 | 技术文档与安全合规宣言（含安全基线、部署说明与受控基准说明） | **已就绪** | [`docs/SECURITY_ADVISORY.md`](SECURITY_ADVISORY.md) · [`docs/EVIDENCE.md`](EVIDENCE.md) | 文档 | T-3 |
| 4 | 参赛材料归档（白皮书 / PPT PDF 等离线交付物，随正式提交单独上传，不冗余塞入代码仓） | **提交时随官网包附带** | 竞赛提交压缩包（单独制备） | 文档 | T-1 |
| 5 | 路演 PPT（10–12 页，PDF ≤10MB） | **提交时随官网包附带** | 竞赛提交压缩包（单独制备） | 队长 | T-3 |
| 6 | **官网提交演示视频（5–8 分钟，建议 6:00，MP4 ≥1080p30，普通话）** | **提交前现场录制** | `KubeVision_6min_FINAL_1080p30.mp4`（独立提交） | 主讲/录制 | **T-2** |
| 7 | 答辩快闪版（≤3:00）与 60s 无旁白预览版（可选辅助物料） | **按需录制剪辑** | 竞赛演示包（独立提交） | 录制 | T-2 |
| 8 | 源码包（排除 node_modules/.next/.git/大文件，含命名规则） | **按 `SUBMISSION_PACKAGE.md` 打包** | [`docs/SUBMISSION_PACKAGE.md`](SUBMISSION_PACKAGE.md) | 队长 | **T-1** |
| 9 | 启动说明（Node ≥ 22.13.0 / 推荐 24 LTS、pnpm、无 Key 可跑） | **已同步** | [`启动说明.md`](../启动说明.md) | 文档 | T-7 |
| 10 | Dockerfile/.dockerignore/vercel.json/部署步骤（Node 24 + SSE 头保障） | **已同步** | [`Dockerfile`](../Dockerfile) · [`vercel.json`](../vercel.json) · [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) | 工程 | T-3 |
| 11 | 证据链（35/35 全自动 E2E + 受控基准归档索引） | **已同步（35/35 + 安全/消融单测）** | [`docs/EVIDENCE.md`](EVIDENCE.md) | 测试 | T-2 |
| 12 | 合规（LICENSE/NOTICES/模型/语料来源 + CVE 安全声明） | **已补；LICENSE 决策待人工确认** | `LICENSE` · `THIRD_PARTY_NOTICES.md` · [`docs/SECURITY_ADVISORY.md`](SECURITY_ADVISORY.md) | 队长 | **T-3** |
| 13 | 商业价值页（客户/竞品/模式/单位经济/PoC） | **已补（数字均标假设）** | [`docs/BUSINESS_CASE.md`](BUSINESS_CASE.md) | 产品 | T-3 |
| 14 | 静态门禁与单元测试套件 + CI 工作流（Node 24） | **已闭环（0 新增死导出 + 样式契约）** | [`docs/SCRIPTS_INDEX.md`](SCRIPTS_INDEX.md) · [`.github/workflows/verify.yml`](../.github/workflows/verify.yml) | 测试 | T-3 |
| 15 | 现场预案（系统内一键自动剧本路演 + 双引擎离线兜底） | **已内置于前端 UI** | 顶栏「剧本路演」+ 离线引擎 B | 队长 | T-2 |

## 2. 提交前 24 小时检查表

| 时间 | 检查 | 通过标准 | 失败处理 |
|---|---|---|---|
| T-24h | 全量回归 | `node scripts/verify.mjs` **35/35 全通过**；单元测试与单脚本校验全绿 | 修复后重新跑全量验收 |
| T-24h | 静态与风格门禁 | `pnpm typecheck && pnpm lint && pnpm lint:glsl && pnpm check:dead-exports && pnpm build && node scripts/check-style-contract.mjs --require-build` 全通过 | 修复违规项再重建 |
| T-23h | 文档与演示物料对齐 | README/启动说明/安全声明数字无漂移；白皮书与 PPT PDF（独立交付）在最终代码后定稿导出 | 更新导出后再提交 |
| T-22h | 视频母版 | **官网提交主视频 5:30–6:30（严格落于官网 5–8 分钟区间）**、MP4 ≥1080p30、普通话讲解、无通知/无弹窗干扰 | 重录指定段 |
| T-20h | 双机/在线演练 | 若部署 Vercel 确认流式 API 头正常；主讲机 + 备份机均能按 `启动说明.md` 启动且无 Key 正常跑通 | 核对 `.nvmrc` (Node 24) 与离线构建包 |
| T-18h | 源码包 / 仓库 | Public 仓库含完整历史与 `.env.example`；命名含学校+队名+队长联系方式；解压可 `build/start`；无 `.env.local` | 重新 `git archive` 打包 |
| T-14h | 团队信息 | README 中团队信息与公网 Vercel 演示地址已全部核对就绪（**严格 1–3 名同校学生，≤2 名指导老师，严禁降组**） | 立即补齐 |
| T-12h | 合规 | LICENSE 决策确认；NOTICES 与 [`docs/SECURITY_ADVISORY.md`](SECURITY_ADVISORY.md) 核验无误 | 团队确认后替换 |
| T-8h | 现场物料 | U 盘（源码/离线构建包/mp4/Node 24 安装包）多份备份 | 补齐拷贝 |
| T-4h | 现场彩排 | 投影 > 浏览器 WebGL > 音量 > 快捷键全过；3 分钟讲解误差 ≤10s | 切换顶栏自动剧本路演兜底 |
| T-2h | 最后冻结 | 不再改代码/依赖；只允许检查演示顺序 | 记录风险，不再改动 |
| T-1h | 备份 | 视频、PDF 与源码包多介质备份并核对 SHA256 | 重新校验 |

## 3. 待团队确认项（不伪造）

1. 团队名称/学校/院系/成员/指导教师/队长联系方式（README §1 占位）；
2. 是否向大赛官网完成报名与作品提交（本仓库不记录报名状态）；
3. LICENSE 最终选择：MIT（当前默认）或「仅限竞赛评审使用」；
4. 是否提供真实 K8s 集群用于现场 PoC（当前默认走安全仿真，`K8S_ALLOW_REAL_WRITE=false`）；
5. 视频是否额外上传云盘/B 站作为备份。

## 4. 一键复核命令

```bash
pnpm typecheck
pnpm lint && pnpm lint:glsl
node scripts/check-dead-exports.mjs
pnpm build
node scripts/check-style-contract.mjs --require-build
node scripts/verify.mjs            # 完整 35 项（自动启停 dev server + 浏览器）
```