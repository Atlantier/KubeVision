# 一键总回归 summary

- 开始：2026-11-11T06:32:27.309Z
- 结束：2026-11-11T06:39:33.462Z
- 输出目录：`docs\evidence\verify-all\2026-11-11T06-32-27-307Z`

| # | 步骤 | 结果 | 耗时(s) | 日志 |
|---|---|---|---|---|
| 1 | tsc | PASS | 5.7 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\01-tsc.log` |
| 2 | next-lint | PASS | 4.6 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\02-next-lint.log` |
| 3 | lint-glsl | PASS | 0.2 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\03-lint-glsl.log` |
| 4 | check-a11y | PASS | 0.2 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\04-check-a11y.log` |
| 5 | check-emoji | PASS | 0.2 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\05-check-emoji.log` |
| 6 | check-layering | PASS | 0.2 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\06-check-layering.log` |
| 7 | check-dead-exports | PASS | 0.4 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\07-check-dead-exports.log` |
| 8 | verify | PASS | 91.9 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\08-verify.log` |
| 9 | verify-stream-integrity | PASS | 76.4 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\09-verify-stream-integrity.log` |
| 10 | verify-telemetry | PASS | 0.5 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\10-verify-telemetry.log` |
| 11 | verify-demo | FAIL | 245.8 | `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\11-verify-demo.log` |

> **失败即停**：第 11 步 `verify-demo` exit 1；现场日志 `docs\evidence\verify-all\2026-11-11T06-32-27-307Z\11-verify-demo.log`。

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
