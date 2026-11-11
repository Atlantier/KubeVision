# 一键总回归 summary

- 开始：2026-11-11T05:25:56.212Z
- 结束：2026-11-11T05:29:07.790Z
- 输出目录：`docs\evidence\verify-all\2026-11-11T05-25-56-211Z`

| # | 步骤 | 结果 | 耗时(s) | 日志 |
|---|---|---|---|---|
| 1 | tsc | PASS | 3.1 | `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\01-tsc.log` |
| 2 | next-lint | PASS | 2.8 | `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\02-next-lint.log` |
| 3 | lint-glsl | PASS | 0.1 | `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\03-lint-glsl.log` |
| 4 | check-a11y | PASS | 0.2 | `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\04-check-a11y.log` |
| 5 | check-emoji | PASS | 0.2 | `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\05-check-emoji.log` |
| 6 | check-layering | PASS | 0.1 | `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\06-check-layering.log` |
| 7 | check-dead-exports | PASS | 0.3 | `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\07-check-dead-exports.log` |
| 8 | verify | PASS | 91.8 | `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\08-verify.log` |
| 9 | verify-stream-integrity | PASS | 92.4 | `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\09-verify-stream-integrity.log` |
| 10 | verify-telemetry | FAIL | 0.3 | `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\10-verify-telemetry.log` |

> **失败即停**：第 10 步 `verify-telemetry` exit 1；现场日志 `docs\evidence\verify-all\2026-11-11T05-25-56-211Z\10-verify-telemetry.log`。

```text
node:internal/modules/cjs/loader:1500
  const err = new Error(message);
              ^

Error: Cannot find module '@/utils/clusterHealth'
Require stack:
- C:\Users\Dannie\Desktop\AI项目\KubeVision\tmp-telemetry\syntheticEngine.cjs
- C:\Users\Dannie\Desktop\AI项目\KubeVision\scripts\verify-telemetry.mjs
    at Module._resolveFilename (node:internal/modules/cjs/loader:1500:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1071:27)
    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1095:10)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1116:12)
    at Module._load (node:internal/modules/cjs/loader:1285:25)
    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)
    at Module.require (node:internal/modules/cjs/loader:1600:12)
    at require (node:internal/modules/helpers:153:16)
    at Object.<anonymous> (C:\Users\Dannie\Desktop\AI项目\KubeVision\tmp-telemetry\syntheticEngine.cjs:41:25)
    at Module._compile (node:internal/modules/cjs/loader:1854:14) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    'C:\\Users\\Dannie\\Desktop\\AI项目\\KubeVision\\tmp-telemetry\\syntheticEngine.cjs',
    'C:\\Users\\Dannie\\Desktop\\AI项目\\KubeVision\\scripts\\verify-telemetry.mjs'
  ]
}

Node.js v24.16.0

```
