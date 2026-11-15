# 全量手动走查清单（R57 收口）

> 截图目录：`docs/evidence/walkthrough/`；截图时间 2026-11-11，页面为当前 HEAD 构建（dev 模式，仅调试钩子用于"选中实体"这一等价操作）。
> 状态：✅ 已走查并截图；⚠ 部分/需人工；❌ 未完成。**不把未验证项写成通过。**

| # | 走查项 | 状态 | 截图 / 证据 | 说明 |
|---|---|---|---|---|
| 1 | 首屏 3 秒 | ✅ | `walkthrough-01-first-screen-2026-11-11.png` | 三机架 + 中央晶体 + HUD 在 3 秒内出现；无白屏 |
| 2 | 选中 Pod（相机锁定 + 探针卡） | ✅ | `walkthrough-02-pod-selected-2026-11-11.png` | 锁定 worker-beta，探针卡显示节点/Pod 水位 |
| 3 | 故障注入 | ✅ | `walkthrough-03-chaos-injected-2026-11-11.png` | 顶栏「演练中：OOM 风暴」+ 机架红色脉冲 |
| 4 | 快照诊断三卡（含第三张 MCP 卡最终态） | ✅ | `walkthrough-04-three-cards-2026-11-11.png`、`walkthrough-04b-action-executed-2026-11-11.png` | 三卡齐；**人工点击「立即执行自愈方案」后**显示「已执行 · 3D 拓扑已自愈恢复」、MCP 回执、健康分 77→96 |
| 5 | 勾选自愈（高危动作） | ⚠ | 代码路径：`GenUI/ActionConfirm.tsx` 复选框与 `需二次确认` 禁用态 | 本轮 OOM 为 **非高危 restart**，按真实 UI **没有复选框**；高危 drain 的勾选未在截图中验证，现场按代码路径说明 |
| 6 | RAG 知识库检索 | ✅ | `rag-three-way-2026-11-14.png` | 真实输入「容器内存爆了 exit 137」→ 90% / 76% / 73%，含 Vector/BM25/Context 占比；负例显示「未命中任何 Runbook」 |
| 7 | 端侧日志审计 | ✅ | `auditor-before-after-2026-11-14.png` | 预设「数据库连接串泄露」→ 脱敏前后对照 + 敏感类型计数 |
| 8 | 复盘报告 | ✅ | `walkthrough-05-postmortem-2026-11-11.png` | 「SRE 故障复盘报告」弹窗，预览/源码/复制/下载 |
| 9 | 路演全流程（暂停/跳转/终止） | ⚠ | `roadshow-phase2/phase4/preflight-fail-2026-11-11.png`；`docs/evidence/verify-demo-2026-11-11.log` | 暂停/继续/停止：J-6 通过（阶段单调、停止后无新增导演日志）；**跳转 seek 未实现**；软渲染+慢模型下阶段 4 HITL 会超时（见风险台账 #1） |
| 10 | 断网演示 | ⚠ | `docs/summit/failures/*/last-frame.png`（引擎行「本地确定性容灾引擎」）；实测 ttft 6688.66ms | 本轮未做物理断网走查；此前实测回落约 6.7s，不是 1 秒；现场按兜底话术 |
| 11 | 无 API Key | ⚠ | 同上（引擎 B 行） | 本机当前配置了本地网关；未在走查中移除 Key 重启验证，现场可停网关复现 |
| 12 | 窗口缩放 1366×768 | ✅ | `walkthrough-06-1366x768-2026-11-11.png` | 布局不溢出、抽屉可读 |
| 13 | 抽屉拖拽宽度 | ⚠ | 组件：`SplitPaneResizer` | 需真实鼠标拖拽；自动化未覆盖，现场人工确认一次 |
| 14 | 语音输入/播报（含"声学推断"标注） | ⚠ | `walkthrough-07-voice-input-2026-11-11.png` | 入口可点；headless 无麦克风，未验证识别/播报；代码含 `[声学推断]` 兜底与「端侧声学」标签，真机才可宣称可用 |

## 走查中发现的问题（已进风险台账）

1. 页面左下持续出现 **1 error** 提示（与 `verify-demo` 的 `pageErrors: ["Uncaught"]` 对应），原因未定位；不影响主链路，但需要在真机复现（风险台账 #16）；
2. 自动路演在慢环境阶段 4 HITL 超时（风险台账 #1）；**手动点击自愈可成功**（04b 证据），因此演示兜底以手动链路为准；
3. 高危动作复选框未在真实高危动作上截图（风险台账 #5 相关）。

## 复现命令

```bash
# 需 dev server（node_modules 已安装）
pnpm dev
node scripts/capture-walkthrough.mjs
node scripts/capture-final-evidence.mjs
node scripts/probe-blackout.mjs --action demo --repeat 3 --duration 10
node scripts/verify-demo.mjs        # 自动路演回归（当前 19 通过 / 3 失败，见风险台账）
```

> 截图不是"设计稿"：全部由 headless Edge 打开真实页面后截取；相机等待 5.2s 后才截图，避免飞行中黑帧。