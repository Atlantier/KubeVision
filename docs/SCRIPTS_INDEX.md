# KubeVision AI — 工程脚本索引（Scripts Index）

> 本文档对 `scripts/` 目录下保留的核心自动化校验与单元测试脚本进行分类纳管，并在 `package.json` 中提供统一 npm scripts 入口。所有生成临时转译目录（`tmp-*`）的脚本均已注册进程退出钩子自动回收，不会在仓库根目录遗留垃圾文件。

## 一、核心构建与静态质量门禁

| 脚本文件 | `package.json` 入口 | 用途说明 |
|---|---|---|
| `scripts/check-dead-exports.mjs` | `check:dead-exports` | 检查静态导出与未消费模块，防止死代码堆积 |
| `scripts/check-style-contract.mjs` | `check:style-contract` | Tailwind 3 / tokens.ts / CSS 变量与生产 CSS 编译产物校验（`--require-build`） |
| `scripts/lint-glsl.mjs` | `lint:glsl` | Three.js 自定义 GLSL 着色器语法静态校验 |

## 二、单元、算法与流式协议验证

| 脚本文件 | `package.json` 入口 | 用途说明 |
|---|---|---|
| `scripts/run-demo-tests.mjs` | `test:demo` / `test:demo:fast` | 导演状态机单元测试与行覆盖率统计 |
| `scripts/run-chat-stream-tests.mjs` | `test:chat-stream` | `chatStreamConsumer` 与 Schema 流式消费内核单元测试 |
| `scripts/verify-rag.mjs` | `verify:rag` | 客户端纯向量/混合 RAG 检索引擎单元测试 |
| `scripts/verify-mode-parity.mjs` | `verify:parity` | 双模（模拟集群 / 真实连接）数据槽位一致性校验 |
| `scripts/verify-telemetry.mjs` | `verify:telemetry` | 遥测环形缓冲与瞬态槽位读写校验 |
| `scripts/verify-sanitizer.mjs` | `verify:sanitizer` | 日志敏感凭证脱敏器（Token/Key/URL 密码）单元测试 |
| `scripts/verify-receipt-digest.mjs` | `verify:receipt` | MCP 操作回执 SHA-256 摘要两端一致性校验 |

## 三、全量验收回归

| 脚本文件 | `package.json` 入口 | 用途说明 |
|---|---|---|
| `scripts/verify.mjs` | `verify` / `verify:quick` | 主验收套件（静态检查 + 单元测试 + API + CDP 无头浏览器验证） |
