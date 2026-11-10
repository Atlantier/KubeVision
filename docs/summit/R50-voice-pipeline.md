# R50 · 语音全链路（代码级完成，未硬件验证）

> 追问 2 收口：**逐句流式 TTS 为本轮新增**；打断、结束自动发送、高危语音二次确认、
> 能力检测降级在既有实现中已存在，本轮只核实并记录，不重复造。
> **本环境无麦克风/音频输出，全部未做真机回归。**

---

## 1. 本轮新增：流式 TTS 分句（`useSpeechSynthesis.ts`）

- 新增 `splitIntoSentences()`：
  - 按中文句号/问号/叹号/分号与换行切句；
  - 过短片段与相邻句合并（避免逐字调引擎）；
  - 单句 >120 字时按逗号再切；
- `speak()` 改为**队列式逐句播报**：
  - 第一句立即开口（降低感知延迟）；
  - 每句 `onend` 后播下一句，句间自然停顿；
  - `onend` 只在整个队列读完时回调一次；
  - `stop()` 把 `chunkQueueRef` 置 false 并 cancel，**打断后残留句不再继续读**；
  - `interrupted/canceled` 视为正常取消，不误报 blocked；
  - `not-allowed` 仍保留 `blocked` 状态（自动播放策略拦截如实告知）。

## 2. 既有能力核实（不重复实现）

| 能力 | 证据 |
|---|---|
| 播报中说话打断（barge-in） | `CopilotDrawer` 用 `useVoiceActivity(speakingMessageId !== null && ttsEnabled, …)` 做能量 VAD，触发即 `speechSynthesis.cancel()` |
| 拾音结束自动发送 | `useSpeechInput` 的 `SILENCE_AUTO_STOP_MS = 1800` + `consumeFinalText()`（Q1 一次性消费），CopilotDrawer 消费后发送 |
| 高危操作语音二次确认 | `ActionConfirm.tsx` 监听 `kv-voice-confirm` 事件，语音短句（确认/执行/同意/confirm/yes）由 `CopilotDrawer` 派发 |
| 能力检测降级 | TTS：`isSupported` / `playbackState='unsupported' | 'blocked'`；语音输入：SpeechRecognition 可用时云端识别，失败回退能量 VAD 与本地推断 |

## 3. 验收

```
tsc 0 · next lint 干净
逐句队列代码路径：splitIntoSentences + speakNext 递归（tsc 校验）
```

**未做**：无麦克风与音频输出，无法验证真实打断延迟、句间停顿、语音确认端到端。

## 4. 未验证项与风险

1. **全部语音行为未真机验证**：headless 环境没有音频设备，本轮只做代码级交付。
2. 逐句播报可能让长回答总时长略增（句间停顿），需真机确认是否可接受。
3. `chunkQueueRef` 是布尔闸门：打断后队列停止，但极端情况下浏览器仍可能触发一次
   已入队的 `onend`（已通过 `onend` 中 `speakNext` 前置检查 `chunkQueueRef` 防住）。
4. 语音二次确认依赖自定义事件 `kv-voice-confirm`，只在 ActionConfirm 挂载时生效。
5. 能力检测只覆盖 Web Speech API 的可用/被拦截两种主路径，未覆盖权限被拒的细分提示。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 44cf976     # 回到 r49
git reset --hard v12-baseline
```