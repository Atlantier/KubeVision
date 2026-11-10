# R21 · Esc 分级退出、免疫拒绝语义、语音链路与 RAG 校准

> 本轮 C1–C7。每条缺陷给出：根因 → 修复 → 验证方式 → 实际证据。
> 交付物包含 **Esc 行为矩阵**与 **RAG 校准前后对比表**。

---

## 0. 缺陷总览

| # | 缺陷 | 根因（一句话） | 修复位置 | 验证 |
|---|---|---|---|---|
| C1 | Esc 一次退多层 / 关弹窗顺带清选中 | 每个弹层各自挂 window keydown，page 又有一套逐级链，互不知情 | 新增 `src/hooks/useEscapeStack.ts`；`page.tsx:247` 只留一个派发器 | `probe-escape-stack` 11/11 |
| C2 | 免疫窗口排队无消费者 | `pendingRemediations` 只写不读，终端却承诺"N 秒后重试" | `useClusterStore.ts` healEntity 改返回 `HealOutcome`（`types/store.ts:190`） | `probe-immune-reject` 6/6 |
| C3 | 拾音每帧 setState / 静音不收尾 / 并发起火 / 声学冒充识别 | rAF 内直接 setSnapshot；静音分支只改文案；start 无互斥；兜底文本无标注 | `useSpeechInput.ts:235,396` 等 | tsc/lint + 代码级（见风险） |
| C4 | blocked 态永不复位；TTS 偏好不持久 | `not-allowed` 写入 blocked 后无任何复位路径；rate 写死 | `useSpeechSynthesis.ts:216` 起 | tsc/lint + 代码级（见风险） |
| C5 | RAG 校准分段跳变、排序用舍入值 | 两处边界直接跳变（0.25 / 0.15）；按 4 位小数置信度排序 | `sreRagEngine.ts:831` 校准；排序改 fused 降序 | `verify-rag` 12/12 |
| C6 | IDF 缓存指纹不含正文 | 指纹只取「文档数 + 首末 id」，编辑中间文档不失效 | `sreRagEngine.ts:636` FNV-1a 全量内容指纹 | `verify-rag` 4.1–4.3 |
| C7 | 瞬态池按下标映射；verify/rag 元素无校验 | 快照重排 → 数值串台；非法元素在 map 内 TypeError 返回 500 | `useTelemetryRef.ts:81,128`；`verify/rag/route.ts:52` | 路由 HTTP 400/200 实测 |

---

## 1. C1 · Esc 分级退出栈

### 设计

`useEscapeStack` 维护注册表，弹层打开时注册 `{ id, priority, onEscape }`；
**全局只在 `page.tsx` 安装一个 keydown**（`page.tsx:247`）。
按下 Esc：先判输入框让位 → 取最高优先级层 → **只调用它一个**并终止。

优先级：命令面板 100 > 混沌弹窗 90 > RAG 知识库 80 > 复盘弹窗 70 > 页面兜底 0。
同一次 Esc 结构上不可能关闭两层，也不可能同时清选中。

### Esc 行为矩阵（真实探针输出）

| 场景 | 层栈（自上而下） | 第 1 次 Esc | 第 2 次 Esc | 第 3 次 Esc |
|---|---|---|---|---|
| 三层同存：chaos + HUD + 选中 | 0: chaos(90) / 1: page-core(0) | 关 chaos；HUD 仍开、选中保留 | 关 HUD；选中保留 | 清选中 |
| 命令面板 | 0: command(100) / 1: page-core(0) | 关命令面板 | — | — |
| RAG 知识库（焦点在检索框） | 0: rag(80) | **让位**：不关闭 | （焦点移出后）关闭 | — |
| 混沌弹窗 + 焦点在 Copilot 输入框 | 0: chaos(90) | **让位**：不关闭 | — | — |

```
$ node scripts/probe-escape-stack.mjs
▸ 用例 1：chaos + HUD + 选中 同时存在
  ✓ 1.1 初始三层同时成立  ::  [true,true,true]
  ✓ 1.2 第一次 Esc 只关混沌弹窗  ::  [false,true,true]
  ✓ 1.3 第二次 Esc 只关性能 HUD  ::  [false,false,true]
  ✓ 1.4 第三次 Esc 才清选中  ::  [false,false,false]
▸ 用例 2：命令面板
  ✓ 2.1 命令面板已打开
  ✓ 2.2 Esc 关闭命令面板  ::  true
▸ 用例 3：RAG 知识库
  ✓ 3.1 RAG 知识库已打开
  ✓ 3.2 输入框内 Esc 让位（RAG 不关闭）  ::  true
  ✓ 3.3 焦点离开输入框后 Esc 关闭 RAG  ::  false
▸ 用例 4：弹窗打开时输入框内 Esc 让位
  ✓ 4.1 焦点在输入框时 Esc 不关闭弹窗  ::  true
汇总: 通过 11 · 失败 0
```

> PostMortemModal 同样注册了优先级 70 的层（代码级一致），但当前 UI 没有可在
> 探针中稳定打开的入口，未纳入运行时矩阵——如实标注。

---

## 2. C2 · 免疫窗口：从"假排队"到"明确拒绝"

### 根因

`healEntity` 在免疫窗口内把请求写入 `pendingRemediations`，终端打印
"retry #N scheduled in Ns"；但全项目没有任何调度器消费该队列 —— 用户被承诺
一个**永远不会发生的重试**。这比直接拒绝更糟：用户会一直等。

### 修复（二选一 → 选"明确拒绝"）

- `healEntity` 返回 `HealOutcome`：窗口内 `{ ok:false, code:'immunity', remainingSec, message }`；
- 终端写 `REJECTED ... immunity window active (Ns remaining): duplicate heal suppressed, no automatic retry`；
- 不再写入队列（`pendingRemediations` 保留为历史类型，healEntity 不再产生条目）；
- `ActionConfirm` 检查返回值：`ok:false` → 停在失败态展示"免疫窗口内不可重复自愈，剩余 N 秒"。

### 验证

```
$ node scripts/probe-immune-reject.mjs
  目标 Pod: pod-payment-gateway-7f8b9-x2k
  第一次: {"ok":true}
  第二次: {"ok":false,"code":"immunity","remainingSec":30,"message":"免疫窗口内不可重复自愈，剩余 30 秒"}
  ✓ 第一次自愈成功（ok:true）
  ✓ 窗口内重复自愈被明确拒绝  ::  code=immunity
  ✓ 拒绝结果携带剩余秒数  ::  remainingSec=30
  ✓ 拒绝文案明确  ::  免疫窗口内不可重复自愈，剩余 30 秒
  ✓ 终端写入 REJECTED 审计行  ::  [KUBE-CONTROLLER] REJECTED restart_pod on ... (30s remaining)
  ✓ 未新增任何"排队重试"条目（不存在假承诺）  ::  pending=0
汇总: 通过 6 · 失败 0
```

---

## 3. C3 · 语音输入

| 子项 | 根因 | 修复 |
|---|---|---|
| rAF 每帧 setState | `runSpectrumLoop` 内每帧 `setSnapshot`，60FPS 触发 CopilotDrawer 整树重渲染 | 每帧只写 ref，**≤8Hz（125ms）**才发布一次视图快照（`useSpeechInput.ts:396`） |
| 静音 1.8s 不收尾 | 只把提示文案改成"可点击完成录音"，从不真正结束 | 静音达标 → `setNotice` + 调用最新 `stop()`，`silenceStopRequestedRef` 保证只触发一次 |
| start 并发 | 连点两次开两条 getUserMedia 管线 | `startingRef` 互斥，早退路径全部复位 |
| 声学兜底冒充识别 | `buildAcousticFallbackPrompt` 结果直接当识别文本返回 | 返回 `[声学推断] ...`，输入框明确标注来源 |
| 能力说明 | UI 未说明原生 Web Speech、无 Key、不支持浏览器怎么办 | 输入区常驻说明 + 能力探测（`CopilotDrawer.tsx:1035,1249`） |

> **未运行时验证**：8Hz 节流与静音收尾需要真实麦克风音频输入，无头环境无法
> 稳定构造。已验证 tsc/lint，并保留为代码级修复。

---

## 4. C4 · TTS

- **blocked 不复位**：`not-allowed` → `blocked` 后新增一次用户手势监听
  （pointerdown / keydown），触发即复位 idle 并给出可操作提示。
- **偏好持久化**：`kv-tts-rate-v1` / `kv-tts-voice-v1` 写入 localStorage；
  懒初始化读取（`typeof window` 守卫，SSR 安全）；音色按 `voiceURI` 精确匹配，
  未指定则走原有中文优选。

> **未运行时验证**：无头环境无音频输出，无法验证真实发声与 blocked 的浏览器行为；
> 结论为代码级 + `tsc`/`lint` 通过。

---

## 5. C5 · RAG 校准（前后对比表）

### 根因（实测跳变）

| 边界 | 旧实现（边界左 → 右） | 跳变 |
|---|---|---|
| s=0.28 | 0.4453 → 0.2999 | **0.1454** |
| s=0.55 | 0.5696 → 0.8199（s=0.55⁻ 取值） | **0.2503** |

——"证据略强一点，置信度反而更低"，且三段值域重叠。排序还用四舍五入后的
`similarityScore`，不同证据强度可能并列退化为 id 字典序。

### 修复

端点约束重解系数，三段在边界取同一目标值（连续）、段内 Sigmoid 单调：
- 强段 s∈[0.55,1] → 0.80~0.97
- 中段 s∈[0.28,0.55] → 0.50~0.80
- 弱段 s∈[0.10,0.28] → 0.30~0.50

排序改为 **fused 降序**，再以校准分、id 作确定性 tie-break。

### 校准前后对照（同一融合分）

| 融合分 | 修复前 | 修复后 |
|---|---|---|
| 0.10 | 0.2462 | 0.3000 |
| 0.20 | 0.3500 | 0.4070 |
| 0.28 | 0.2999 | 0.5000 |
| 0.40 | 0.4143 | 0.6493 |
| 0.55 | 0.8199 | 0.8000 |
| 0.70 | 0.8975 | 0.8892 |
| 0.90 | 0.9544 | 0.9531 |

### 真实接口前后对比（/api/verify/rag，4 类故障 + 2 个无关键）

| 用例 | topId | 修复前 | 修复后 |
|---|---|---|---|
| OOM 故障 | RUNBOOK-K8S-042 | 0.9405 | 0.9377 |
| CPU 故障 | RUNBOOK-K8S-051 | 0.9413 | 0.9386 |
| 网络故障 | RUNBOOK-K8S-062 | 0.9378 | 0.9347 |
| 磁盘故障 | RUNBOOK-K8S-091 | 0.8931 | 0.8842 |
| 无关键 1 | — | 0 | 0 |
| 无关键 2 | — | 0 | 0 |

**连续性与单调性实测**（`node scripts/verify-rag.mjs`，12/12）：

```
s=0.28: 旧 0.4453 → 0.2999（跳变 0.1454） | 新 0.4999 → 0.5（跳变 0.0001）
s=0.55: 旧 0.5696 → 0.8199（跳变 0.2503） | 新 0.7999 → 0.8（跳变 0.0001）
✓ 全区间单调不减  ✓ 值域 0.2111 ~ 0.97
✓ 各查询结果按 fused 降序（检查 8 对相邻结果）
✓ 强证据查询置信度高于无关键查询 :: 强 0.9403 > 弱 0
```

---

## 6. C6 · IDF 缓存指纹

| 项 | 旧 | 新 |
|---|---|---|
| 指纹输入 | `文档数 | 首id | 末id` | `文档数 | FNV-1a(全部文档 id/标题/症状/分类/根因机理/标签/特征词)` |
| 编辑中间文档正文 | **不失效**（缓存继续用旧 IDF） | 指纹变化 → 重建 |
| 实测 | `3|rb-a|rb-c`（编辑前后相同） | `3|a33c17a9` → `3|4c565e20` |

`verify-rag` 4.1–4.3 全绿（含"旧指纹确实无法感知该编辑"的对照）。

---

## 7. C7 · 瞬态池 id 映射 + 路由元素校验

- 瞬态池新增 `podSlotById`（`useTelemetryRef.ts:81`）：Pod 首次出现分配稳定槽位，
  快照重排不再把数值映射到另一台 Pod；消失的 Pod 槽位回收并清零。
  读方（`PodInstancedMesh`）改为按 `pod.id` 取槽位（`getPodSlotIndex`）。
- `/api/verify/rag` 增加元素级校验（`route.ts:52`）：`cases[i]` 必须是对象、
  `query` 必须是非空字符串；`cases` 上限 20。

实测：

```
cases=[null]                → HTTP 400（修复前会 500）
cases=[{query:123}]         → HTTP 400
cases 合法                   → HTTP 200
```

---

## 8. 回归

| 项目 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错误 |
| `next lint` | 干净 |
| `verify-rag` | 12/12 |
| `probe-escape-stack` | 11/11 |
| `probe-immune-reject` | 6/6 |
| C7 路由校验 | 400/400/200 |

---

## 9. 未验证项与风险

1. **C3 的 8Hz 节流与静音收尾**：无头环境无麦克风，只有代码级与 tsc/lint 保证；
   需真机（带麦克风）验证每秒 setState 次数与 1.8s 自动结束。
2. **C4 的 blocked 复位与真实音色切换**：无音频输出环境无法验证；逻辑与持久化键
   已就位，需真机验证。
3. **C1 的 PostMortemModal 层**只在代码级注册（优先级 70），未进入运行时矩阵
   （没有稳定打开入口）。
4. **C7 的 id 槽位映射**：类型/编译与读方改造完成，但无运行时"重排后不串台"的
   自动化断言（需要可控快照重排注入）。
5. **RAG 分数分布**：强故障查询仍集中在 0.88–0.94（因为融合分本身高），本轮
   只保证连续/单调/排序正确，不声称"三类分值有显著区分度"。

---

## 10. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 434ba18     # 回到 r20
git reset --hard v12-baseline
```