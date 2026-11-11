# 一键总回归 summary

- 开始：2026-11-11T05:25:26.510Z
- 结束：2026-11-11T05:25:39.672Z
- 输出目录：`docs\evidence\verify-all\2026-11-11T05-25-26-508Z`

| # | 步骤 | 结果 | 耗时(s) | 日志 |
|---|---|---|---|---|
| 1 | tsc | PASS | 4.0 | `docs\evidence\verify-all\2026-11-11T05-25-26-508Z\01-tsc.log` |
| 2 | next-lint | PASS | 7.8 | `docs\evidence\verify-all\2026-11-11T05-25-26-508Z\02-next-lint.log` |
| 3 | lint-glsl | PASS | 0.1 | `docs\evidence\verify-all\2026-11-11T05-25-26-508Z\03-lint-glsl.log` |
| 4 | check-a11y | FAIL | 0.9 | `docs\evidence\verify-all\2026-11-11T05-25-26-508Z\04-check-a11y.log` |

> **失败即停**：第 4 步 `check-a11y` exit 1；现场日志 `docs\evidence\verify-all\2026-11-11T05-25-26-508Z\04-check-a11y.log`。

```text
KubeVision AI — 设计系统 / 可访问性检查
  扫描文件: 120 个 · 命中: 3

  [legacy-color] 3 处
    src\components\hud\StartupStatusCapsule.tsx:L135  slate-600
    src\components\hud\StartupStatusCapsule.tsx:L151  slate-600
    src\components\hud\StartupStatusCapsule.tsx:L159  slate-600

  ✗ 存在命中（见上）

```
