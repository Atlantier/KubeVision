# React 18 StrictMode 一致性审计

> 由 `node scripts/strictmode-audit.mjs` 自动生成于 2026-11-10T07:28:05.308Z。
> React StrictMode 在 dev 下会执行"挂载 → 卸载 → 再挂载"，本报告验证各资源的成对创建/释放。

## 首屏资源快照（双挂载之后）

| 指标 | 值 | 期望 |
|---|---|---|
| 存活 EventSource | 1 | 1（不是 2） |
| EventSource 创建/关闭 | 2 / 1 | 创建 2、关闭 1（StrictMode 成对） |
| 存活 Worker | 0 | 0（审计台未打开时） |
| 存活 timer / interval | 0 / 1 | 与单次挂载一致 |

## 面板反复切换（copilot ↔ auditor ×3）

```json
[
  {
    "phase": "auditor",
    "timers": 1,
    "intervals": 1,
    "eventSources": 1,
    "workers": 1
  },
  {
    "phase": "copilot",
    "timers": 0,
    "intervals": 1,
    "eventSources": 1,
    "workers": 0
  },
  {
    "phase": "auditor",
    "timers": 1,
    "intervals": 1,
    "eventSources": 1,
    "workers": 1
  },
  {
    "phase": "copilot",
    "timers": 0,
    "intervals": 1,
    "eventSources": 1,
    "workers": 0
  },
  {
    "phase": "auditor",
    "timers": 1,
    "intervals": 1,
    "eventSources": 1,
    "workers": 1
  },
  {
    "phase": "copilot",
    "timers": 0,
    "intervals": 1,
    "eventSources": 1,
    "workers": 0
  }
]
```

## 判定

| 检查项 | 结果 |
|---|---|
| SSE 双挂载后仅一条连接 | 通过 |
| 反复切换后连接数保持 1 | 通过 |
| timer 不增长 | 通过 |
| interval 不增长 | 通过 |
| 卸载后静置零回调 | 通过 |
| 挂载期不触发 TTS | 通过 |

## 各资源的清理实现（代码级证据）

| 资源 | 实现位置 | 清理方式 |
|---|---|---|
| SSE 订阅 | `useTelemetryStream.ts` Effect 清理 | `eventSource.close()` + `clearInterval(fallbackTimer)` + `disposed` 标记 |
| 骨架屏看门狗 | `CopilotDrawer.tsx` 卸载 Effect | 遍历 `skeletonWatchdogRef` 逐个 `clearTimeout` 并清空 Map |
| TTS 播报 | `useSpeechSynthesis.ts` Effect 清理 | `speechSynthesis.cancel()` + `removeEventListener(voiceschanged)` + 清定时器 |
| 拾音 | `useSpeechInput.ts` 卸载清理 | `AudioContext.close()` + 停止 recognition |
| 端侧 Worker | `useEdgeLogClassifier.ts` 卸载清理 | `worker.terminate()` + 清 watchdog/initBudget 定时器 |
| 自动审计定时器 | `LocalAuditorPanel.tsx` Effect 清理 | `clearInterval(timer)` |
