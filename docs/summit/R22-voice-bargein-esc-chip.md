# R22 · 语音可打断、麦克风状态可视化、Esc 提示 chip

> 三条追问（Q1/Q2/Q3）。给出：缺陷定位 → 修复 → 验证方式 → 实际证据。
> Q1 的打断与 TTS 需真实麦克风/音频设备，本环境无法端到端验证，已单列风险。

---

## 0. 总览

| # | 主题 | 关键改动 | 验证 |
|---|---|---|---|
| Q1 | 播报中开口即打断；拾音结束自动发送；高危语音确认=显式二次确认 | `src/hooks/useVoiceActivity.ts`；`CopilotDrawer` 自动发送 effect；`ActionConfirm` `kv-voice-confirm` 监听 | 代码级 + tsc/lint（无麦克风环境） |
| Q2 | 麦克风电平 CSS 变量（零重渲染）；错误具体原因 + 重试 | `useSpeechInput.ts:399` 写 `--kv-mic-level`；`errorKind: permission/unsupported/network`；按钮 `重试语音输入` | `probe-voice-esc-ui` 8/8 |
| Q3 | 底部 `.kv-chip` 显示"Esc 关闭：<最上层弹层名>" | `useEscapeHint`（`useEscapeStack.ts:177`）；chip `page.tsx:316` | `probe-voice-esc-ui` 3.0–3.4 |

---

## 1. Q1 · 语音可打断与会话收尾

### 实现

1. **打断（barge-in）**
   - 新增 `useVoiceActivity(enabled, onVoice)`：WebAudio `AnalyserNode` 算时域 RMS，
     连续 3 帧（≈50ms）超过 0.05 才判定"开口"，触发一次后立刻释放麦克风。
   - `CopilotDrawer`：`useVoiceActivity(speakingMessageId !== null && ttsEnabled, …)`
     → 命中即 `stopSpeaking()` + `speechInput.start()`。
   - **不依赖语音识别**：断网/隐私模式下识别不可用时，打断依然有效；
     无麦克风权限时 **静默降级**（不弹窗、不报错），退回手动停止。

2. **拾音结束自动发送**
   - `useSpeechInput.stop()` 产出 `finalText`；`consumeFinalText()` 一次性消费，避免重复发送。
   - 规则：
     | 文本类型 | 行为 |
     |---|---|
     | 正常识别文本 | **自动发送**（"说完就说"） |
     | `[声学推断]` 兜底文本 | **只填充输入框，不自动发送**（推断可能不准，最终决定权交用户） |
     | 确认类短句（确认/执行/同意/confirm/yes） | 派发 `kv-voice-confirm` 事件，由动作卡决策 |

3. **高危动作的语音确认 = 显式二次确认**
   - `ActionConfirm` 监听 `kv-voice-confirm`：仅当 `phase` 可执行且
     **`isHighRisk` 时 `acknowledged`（复选框）必须已勾选**才执行；
   - 条件不满足时 **什么都不做、也不报错**——静默回退键盘/按钮路径，
     语音通道不可能绕过安全护栏。

> 代码位置：`useVoiceActivity.ts`、`CopilotDrawer.tsx:2160-2200`、
> `ActionConfirm.tsx:320-340`。

### 验证现状

- `tsc` 0、`next lint` 干净；
- **打断与自动发送未做端到端验证**：无头 Edge 无麦克风，无法制造真实语音能量。
  真机验证方法：播报中说话，观察播报停止且频谱条亮起；停止说话 1.8s 后
  自动发送（或确认类短句触发动作卡）。

---

## 2. Q2 · 麦克风状态一目了然

### 电平：CSS 变量驱动，零重渲染

`useSpeechInput` 的 rAF 循环每 125ms 计算一次 `level ∈ [0,1]`，写入：

```ts
document.documentElement.style.setProperty('--kv-mic-level', level.toFixed(3))
```

麦克风图标用 CSS 表达式消费该变量：

```
filter: drop-shadow(0 0 calc(var(--kv-mic-level, 0) * 6px) rgba(244,63,94,0.9));
opacity: calc(0.75 + var(--kv-mic-level, 0) * 0.25);
```

——频谱变化完全不触发任何 React `setState`，对话树不被拖入 60FPS 重渲染。

### 错误原因 + 重试

`errorKind` 三分：

| 值 | 触发 | 文案 |
|---|---|---|
| `permission` | `NotAllowedError` / `SecurityError` | 麦克风权限被拒绝：请在地址栏允许后重试 |
| `unsupported` | 无 `navigator.mediaDevices` / `NotFoundError` | 当前浏览器不支持语音：请改用 Chrome / Edge |
| `network` | 其他采集/识别异常 | 语音网络异常：请检查网络后重试 |

错误条旁提供 `重试语音输入` 按钮（重新调用 `start()`）。

### 验证（真实探针）

```
$ node scripts/probe-voice-esc-ui.mjs
▸ Q2：语音错误态
  语音状态: {"hasError":true,"errorText":"麦克风权限被拒绝：请在地址栏允许后重试重试",
             "hasRetry":true,"listening":false}
  ✓ 2.1 无麦克风时显示具体错误原因
  ✓ 2.2 错误态提供"重试"按钮
  ✓ 2.3 错误原因属于权限/不支持/网络三类
```

> 无头环境 `getUserMedia` 返回权限错误，恰好覆盖"权限"分支；
> 有麦克风环境会进入拾音分支（探针自动跳过错误态断言）。

---

## 3. Q3 · Esc 栈可视化提示

- `useEscapeStack` 为每个层增加 `label`，并暴露 `useEscapeHint()`：
  订阅注册表变化，返回**当前最上层**可关闭弹层的可读名（优先级 > 0 才算）。
- `page.tsx:316` 渲染底部 `.kv-chip`：
  ```
  [Esc] 关闭：混沌演练控制台
  ```
  带 `role="status" aria-live="polite"`、`data-escape-hint`、`pointer-events-none`。

### 验证（真实探针输出）

```
$ node scripts/probe-voice-esc-ui.mjs
▸ Q3：Esc 提示 chip
  ✓ 3.0 初始无弹层时 chip 不显示
  ✓ 3.1 打开混沌弹窗后 chip 出现
  ✓ 3.2 chip 文案指向最上层弹层  ::  "Esc 关闭：混沌演练控制台"
  ✓ 3.3 Esc 关闭后 chip 消失
  ✓ 3.4 命令面板打开时 chip 指向命令面板  ::  "Esc 关闭：运维命令面板"
汇总: 通过 8 · 失败 0
```

Esc 行为矩阵回归（r21 的 11 项）：**11/11 通过**，说明新增 chip 订阅没有破坏
"一次 Esc 只退一层 / 输入框内让位"的既有语义。

---

## 4. 回归

| 项目 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错误 |
| `next lint` | 干净 |
| `probe-voice-esc-ui`（Q2/Q3） | 8/8 |
| `probe-escape-stack`（r21 矩阵回归） | 11/11 |

---

## 5. 未验证项与风险

1. **Q1 打断（barge-in）**：无真实麦克风/音频设备，未端到端验证；VAD 阈值 0.05、
   连续 3 帧为经验值，嘈杂环境可能需要调高阈值（集中在 `useVoiceActivity.ts` 常量）。
2. **Q1 自动发送**：依赖真实识别的 `finalText`，无头环境无法产生；`[声学推断]`
   兜底只填输入框是**故意的保守选择**，与"不冒充识别结果"的既有约束一致。
3. **Q1 高危语音确认**：无麦克风，无法验证真实语音触发；逻辑上复选框仍是唯一
   放行条件（`isHighRisk && !acknowledged` 直接 return，不报错）。
4. **Q2 电平可视化**：CSS 变量写入路径已实现并 lint/tsc 通过，但"图标随音量变化"
   需要真麦克风输入才能肉眼验证。
5. **Q3 chip**：PostMortemModal 的 chip 文案（"复盘报告"）未进入运行时探针
   （无稳定打开入口），与 r21 的限制一致。

---

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 72f476b     # 回到 r21
git reset --hard v12-baseline
```