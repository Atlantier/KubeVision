# verify:all 失败现场

- 步骤：verify-demo
- 退出码：1
- 日志：C:\Users\Dannie\Desktop\AI项目\KubeVision\docs\evidence\verify-all\2026-11-11T06-32-27-307Z\11-verify-demo.log

```text
汇总
==============================================================================
  通过 19 · 失败 3

  失败证据已归档: C:\Users\Dannie\Desktop\AI项目\KubeVision\docs\summit\failures\2026-11-11T06-39-30-689Z
    · store-snapshot.json / console.log / last-frame.png / failures.json

  失败明细（实际值）：
    · J-3 动作卡终态为 executed（无 pending 并存）
      {
        "metricsCard": 1,
        "rootCauseCard": 1,
        "actionCard": 1,
        "actionCardExecuted": false,
        "actionCardPending": false,
        "hostNodeInProse": null
      }
    · J-4 全流程零 console.error / 零未捕获异常
      {
        "consoleErrors": [],
        "pageErrors": [
          "Uncaught"
        ]
      }
    · J-6 恢复后进度单调不回退
      {
        "pausedElapsedSec": null,
        "resumedElapsedSec": null
      }

```
