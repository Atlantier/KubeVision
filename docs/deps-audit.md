# 依赖与体积审计（deps-audit）

> 由 `node scripts/audit-deps.mjs` 自动生成，请勿手改数字。
> 生成时间：2026-11-10T14:16:36.764Z；构建产物：`.next/`（生产构建）

## 1. 未使用依赖

运行时依赖共 **17** 个，未发现 import：0 个。

| 依赖 | 判定 | 建议 |
|---|---|---|
| （无） | 全部运行时依赖在 src/scripts 中均有 import | — |

开发依赖共 **11** 个；其中未在配置/脚本/import 中发现用途：0 个。

> 依赖审计口径：扫描 `src/**`、`scripts/**` 的 import/require/动态 import；
> 构建/代码质量工具通过配置文件名匹配与 `DEV_DEP_USAGE_HINTS` 判定，避免把 tsc/eslint 类工具误报为未使用。

## 2. 首屏 JS 预算

| 指标 | 实测 | 预算 | 状态 |
|---|---|---|---|
| 首屏 JS（6 chunks）raw | 565.5 KB | — | 记录用 |
| 首屏 JS gzip | 172.2 KB | ≤ 200 KB | PASS |

## 3. 3D / AI chunk 体积

| 分类 | 文件 | raw | gzip | 预算 | 状态 |
|---|---|---|---|---|---|
| 3D（three/R3F） | `static/chunks/2c7bdfb3.c21c524cf07a297d.js` | 675.4 KB | 166.3 KB | ≤ 220 KB | PASS |
| AI（ai-sdk/transformers） | `static/chunks/aa2cd42b.c5e1c7fa45049a81.js` | 779.6 KB | 199.6 KB | ≤ 240 KB | PASS |
| 全部 client chunks（29 个） | — | 3220.5 KB | 916.8 KB | — | 记录用 |

## 4. 口径与限制

1. 体积均为**未压缩 raw / gzip-9** 字节数，读取自 `.next/` 生产构建产物；
2. 3D/AI chunk 通过**内容标记**识别（`WebGLRenderer`、`react-three`、`@ai-sdk`、`transformers` 等），
   若打包器把库拆到多个包，本表只报**最大匹配包**，不等于该能力的全部体积；
3. 首屏 JS = app-build-manifest 的 `/` 页面 chunk ∪ build-manifest 的 rootMainFiles；
   动态 `next/dynamic` 懒加载块不计入首屏；
4. 未用依赖仅做静态 import 检查：通过字符串/反射/CLI 间接使用的依赖可能被误报，需人工复核；
5. 预算值集中在 `scripts/audit-deps.mjs` 的 `BUDGETS`，调整预算必须在 PR 里说明理由。

## 5. 复现

```bash
pnpm build                      # 生成 .next/ 生产产物
node scripts/audit-deps.mjs     # 生成本报告（超限 WARN）
node scripts/audit-deps.mjs --strict   # CI：超限即失败
```
