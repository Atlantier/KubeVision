# KubeVision AI — v12 基线冻结（Baseline Freeze）

> 本文件是 summit 工作流的**证据起点**。后续每一轮的证据都必须能与这里记录的
> commit / 环境 / 分辨率对照，否则"改好了"无法被证明。

---

## 1. Git 基线

| 项 | 值 |
|---|---|
| 基线 commit | `5b109e2` — `docs(summit): add the race-prep prompt handbook (round map R1-R9)` |
| 分支 | `summit/v12` |
| 标签 | `v12-baseline`（含说明：KubeVision AI v12 baseline，summit workstream start） |
| 冻结时工作区 | 干净（`git status --short` 空输出） |
| 冻结时刻 | 2026-11-09（Asia/Shanghai） |

### 为什么基线里带着一个"红灯"

基线 commit `5b109e2` 之前是 `33aa0bd`（R01 自动路演 P0 修复）。该提交**故意是红的**：
`scripts/verify-demo.mjs` 的 6 条验收里只有 4 条通过。这不是疏忽，而是把
"当前真实状态"如实冻结下来——本轮黑屏探针同样要在**未修复代码**上复现问题，
如果基线被粉饰成绿色，后续所有"已修复"的声称都失去对照组。

基线红灯明细（`node scripts/verify-demo.mjs --skip-repeat` 实测）：

```
J-1 阶段 2 锁定真受灾机架 ............ PASS（node-worker-beta，名下 3 个异常 Pod）
J-1 activeAlerts 非空 ............... PASS（3 条）
J-2 三张 GenUI 卡片齐全 .............. FAIL（0/0/0）
J-3 自愈覆盖全部受害 Pod ............. FAIL（0/3，healedIds 为空）
J-3 MCP 回执 actionType ............. FAIL（null）
J-3 动作卡终态 executed ............. FAIL
J-4 结束态环绕巡检开启 ............... FAIL（false）
J-6 stop / pause / resume ........... PASS（4/4）
```

红灯根因（一句话）：本地 AI 流需约 28 秒才挂载动作卡，而阶段 4 在 26 秒开场、
8 秒卡片超时、剧本 34 秒结束——三者刚好错位，卡片等待到期时时间轴已收尾，
代次自增使降级自愈被判过期，于是"什么都没修"。

---

## 2. 运行时环境

| 项 | 值 |
|---|---|
| Node.js | `v24.16.0` |
| pnpm | `11.8.0` |
| npm | `11.13.0` |
| 操作系统 | Microsoft Windows NT 10.0.26200.0（Windows 11） |
| 浏览器（自动化用） | Microsoft Edge `157.0.4341.42` |
| 自动化模式 | `--headless=new` + CDP（`Runtime.evaluate` / `Page.captureScreenshot`） |

### 依赖世代（未改动，仅记录）

Next.js `14.2.18` · React `18.3.1` · TypeScript `5.6.3`(strict) · three `r169` ·
`@react-three/fiber` `8.17.10` · `@react-three/drei` `9.114.3` ·
`@react-three/postprocessing` `2.16.3` · zustand `4.5.5` · Vercel AI SDK `3.4.33` ·
`@huggingface/transformers` `3.1.2` · Tailwind CSS `3.4.17`。

---

## 3. 显示器与分辨率

| 项 | 值 |
|---|---|
| 物理分辨率 | **2560 × 1600** |
| 逻辑分辨率（OS 有效） | **1707 × 1067** |
| 缩放比例 | **150%**（2560 / 1707 ≈ 1.5） |
| DPI | 96（非 DPI-aware 查询返回值；实际有效缩放见上一行） |

### 为什么截图不受宿主缩放影响

`scripts/shot.mjs` 通过 CDP `Emulation.setDeviceMetricsOverride` 强制
`deviceScaleFactor: 1` 并显式指定视口尺寸（默认 1920×1080），
因此**截图像素尺寸与宿主 DPI 缩放无关**，跨机器可复现。
本文件记录宿主分辨率只是为了标注"当时人眼看到的是什么"。

---

## 4. GPU

| 项 | 值 |
|---|---|
| 主 GPU | **NVIDIA GeForce RTX 5070 Laptop GPU** |
| 驱动版本 | `32.0.16.1088` |
| 显存（WMI AdapterRAM） | 4 GB（WMI 对 >4GB 显存存在截断，真实值可能更高） |
| 当前显示模式 | 2560 × 1600 |
| 副 GPU | AMD Radeon(TM) 610M（核显，驱动 `32.0.13034.7001`） |

### chrome://gpu 摘要：未采集

无头模式下 `chrome://gpu` 页面需要额外导航与特权读取，且其内容为浏览器
内部诊断页而非稳定 API，脚本化解析脆弱。**故按任务要求标注为「未采集」**，
不以推测值填充。

需要精确 GL 后端信息时，可用页面内 `WEBGL_debug_renderer_info` 扩展读取
（`scripts/shot.mjs` 的 `meta.json` 会附带该项，见下）：

- 自动化渲染后端：`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`
  → **软件光栅化（SwiftShader）**，因此帧率数字**不代表真机 GPU 性能**，
  但 draw call / 三角形数等与硬件无关的指标仍然有效。

---

## 5. 本基线配套的证据工具

| 工具 | 用途 | 命令 |
|---|---|---|
| `scripts/shot.mjs` | 确定性场景截图 + 渲染指标采集 | `pnpm shot --scene overview --size 1920x1080` |
| `scripts/probe-blackout.mjs` | WebGL 黑屏探针（16×16 采样点亮度轮询） | `pnpm probe:blackout --action demo --duration 60` |
| `scripts/verify-demo.mjs` | 自动路演 6 条验收（需 dev 构建） | `node scripts/verify-demo.mjs --skip-repeat` |
| `scripts/verify.mjs` | 全站 32 项冒烟 | `pnpm verify` |

---

## 6. 基线证据清单

| 证据 | 位置 |
|---|---|
| 黑屏探针 · demo 场景 | `docs/summit/logs/probe-blackout-demo.log` |
| 黑屏探针 · chaos-oom 场景 | `docs/summit/logs/probe-blackout-chaos-oom.log` |
| 黑屏探针 · dpr-drop 场景（附加） | `docs/summit/logs/probe-blackout-dpr-drop.log` |
| 基线截图（3 张） | `docs/summit/shots/v12-baseline/` |
| 截图元数据 | `docs/summit/shots/v12-baseline/meta.json` |
| 路演红灯明细 | 本文件 §1 |

---

## 7. 黑屏探针结论：**未复现**（重要，属负面结果）

三个场景在基线上都**没有**出现 WebGL 黑屏。这是如实记录，不为了凑一个"红灯"
而调高阈值或放宽判定条件。

| 场景 | 采样次数 | 基线亮度 | 探测期亮度范围 | 黑屏事件 |
|---|---|---|---|---|
| `demo`（完整路演 60s） | 19 | 30.110 | 27.09 ~ 68.74 | **0** |
| `chaos-oom`（OOM 注入 45s） | 23 | 29.805 | 28.41 ~ 33.72 | **0** |
| `dpr-drop`（DPR 压到 0.5，30s） | 18 | 29.543 | 28.52 ~ 31.43 | **0** |

判定阈值 2.0/255。基线亮度约 30、峰值亮度 172~255，与"全黑"（均匀 0）差距极大，
说明探针本身**有足够分辨力**，0 次命中不是"探针看不见"，而是"确实没黑"。

### 7.1 探针自身的两个真实缺陷（已修，记录在此避免复发）

1. **`gl.readPixels is not a function`**：`st.gl` 是 `THREE.WebGLRenderer`，
   没有 `readPixels`；必须 `st.gl.getContext()` 取原始 WebGL 上下文。
   首次运行因此 3/3 基线全部抛异常，日志见时间戳副本。
2. **把"采样报错"误报成"黑屏"**：早期自检只用 `avg <= threshold` 判断，
   而异常样本的 `avg` 缺省值为 0，会被当成全黑。现已把
   **实现错误 / 回读不可用 / 真的黑** 三种情形分开报，实现错误直接 `exit 1`。

### 7.2 探针的能力边界（不可忽略的测量事实）

- **实际采样周期是 2~3.5 秒，不是参数要求的 500ms。**
  每次采样要 `readPixels` 整个帧缓冲（探针视口 1680×1000 → canvas 1086×934 ≈ 4.1 MB）
  再经 CDP 回传，在 SwiftShader 软件光栅化下单次耗时约 2~3 秒。这意味着
  **短于约 3 秒的瞬时黑屏会被漏采**。若后续需要捕捉瞬时黑屏，
  应改为在页面内自循环采样、只回传汇总值（本次受"零业务代码改动"约束未做）。
- 仅覆盖 headless + SwiftShader 环境。真机 GPU 上的上下文丢失
  （TDR / 显存耗尽）是本探针**无法触及**的场景。

---

## 8. 基线渲染指标（来自 `meta.json`）

| 场景 | drawCalls | triangles | frameTimeMs | fps | canvas | DPR | ctxLost |
|---|---|---|---|---|---|---|---|
| `overview` | 403 | 188,738 | 568.3 | 2 | 1244×1014 | 1 | false |
| `oom` | 155 | 131,600 | 623.5 | 2 | 1244×1014 | 1 | false |
| `pod-closeup` | 146 | 130,634 | 1,154.8 | 1 | 1244×1014 | 1 | false |

解读与注意事项：

- **`drawCalls` 差异是视锥剔除的真实结果**，不是性能回归：`overview` 全景时
  三机架 + 控制平面 + 地面拓扑全部在视野内（403）；`oom` / `pod-closeup`
  镜头推近后大量几何被剔除（155 / 146）。
- **`fps` 与 `frameTimeMs` 不能用于评价真机性能**：渲染后端是
  `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`，
  纯 CPU 软件光栅化。这两个数字只用于"同环境前后对比"。
- **canvas 是 1244×1014 而非 1920×1080**：`<canvas>` 只覆盖左侧 3D 视口，
  不含顶栏（48px）与右侧 AI 抽屉。截图本身是整页 1920×1080。
- `DPR = 1` 来自 `renderer.getPixelRatio()`，是本构建下唯一可观测的
  "自适应画质档位"代理（`glStats` 契约里没有 dpr/档位字段）。

---

## 9. 基线已存在的控制台告警（非本轮引入）

3 张截图采集时均记录到 **error = 0 / warn = 1**，唯一告警是：

```
[DEPRECATED] Use `createWithEqualityFn` instead of `create` or use
`useStoreWithEqualityFn` instead of `useStore`. They can be imported
from 'zustand/traditional'.
```

来源：zustand 4.5.5 对 legacy `create` API 的弃用提示。属**既有依赖世代下的
预期告警**，与 AGENTS.md 第 9 条"依赖世代锁"一致，本轮不动它（改成
`zustand/traditional` 属于 API 迁移，超出本轮范围）。

