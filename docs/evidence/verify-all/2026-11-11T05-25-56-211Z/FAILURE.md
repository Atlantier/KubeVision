# verify:all 失败现场

- 步骤：verify-telemetry
- 退出码：1
- 日志：C:\Users\Dannie\Desktop\AI项目\KubeVision\docs\evidence\verify-all\2026-11-11T05-25-56-211Z\10-verify-telemetry.log

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
