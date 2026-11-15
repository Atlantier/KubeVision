# 依赖安全审计与风险缓解说明（Security Advisory & Mitigation）

> 对应修改项：`M02` 依赖锁版本说明与高危 CVE 工程缓解策略

## 1. 核心框架锁版本说明

本项目在 `package.json` 中显式锁定以下核心依赖组合：
- `next`: `14.2.18`
- `react` / `react-dom`: `18.3.1`
- `three`: `0.169.0` / `@react-three/fiber`: `8.17.10` / `@react-three/drei`: `9.114.3`
- `@huggingface/transformers`: `3.1.2` / `ai`: `3.4.33`

原因：`@react-three/fiber@8.x` 与 `React 18` 深度绑定，而升级至 `Next.js 15+` 会触发 `React 19` PeerDependency 冲突、异步 `headers()/params` Breaking Change，以及 `Transformers.js v3` ONNX Worker 在 Webpack 5 下的打包行为变化。为保证赛事评审环境 100% 可复现（`--frozen-lockfile`），现阶段保持 `next@14.2.18`。

## 2. `pnpm audit --audit-level=high` 漏洞面逐项缓解矩阵

下表说明 `pnpm audit` 报告的高危/严重告警在本项目中的真实可达性与工程缓解措施（已在代码中强制落地，不依赖外部升级即阻断利用路径）：

| 涉及包 / 漏洞类别 | 本项目暴露面评估 | 已落地的工程缓解措施 |
|---|---|---|
| `next@14.2.18`（Middleware / Server Actions / `next/image` 相关 CVE） | 未使用 `next/image` 远程域名优化；未使用 Next.js Server Actions；已配置 CSP 与安全响应头 | 1. 全项目所有动态 API 路由（`/api/*`）显式声明 `dynamic = 'force-dynamic'` 与 `Cache-Control: no-store`；<br>2. `next.config.mjs` 中关闭远程图片域名通配（`images: { unoptimized: true }`）；<br>3. `POST /api/mcp/execute` 强制二次确认凭据 + 可选 `MCP_ADMIN_TOKEN` + 同源 `Origin` 校验 + `K8S_ALLOW_REAL_WRITE=true` 开关隔离，阻断未授权 CSRF/SSRF 触发集群写操作 |
| `@huggingface/transformers` 传递依赖（`sharp` / `tar` 等模型下载链路） | 客户端端侧推理模型权重托管于本地 `public/models/Xenova/all-MiniLM-L6-v2/`，生产运行禁止任意远程模型 URL 下载 | `env.allowRemoteModels = false` 与 `env.allowLocalModels = true`，杜绝运行时从不可信远端拉取任意模型包 |
| 构建期 `devDependencies`（`glob` / `minimatch` / `flatted` 等 ESLint/Playwright 链路） | 仅在本地 CI/开发验证阶段执行，**不进入** Next.js 生产运行时产物与容器镜像 `runner` 层 | 仅受控运行 `scripts/` 校验脚本，不对外暴露执行入口 |

## 3. 持续跟进计划

- 赛后版本迭代中，随 `@react-three/fiber@9` 与 `Next.js 15/16` LTS 生态稳定，将统一规划 `React 19 + Next 15.5+` 大版本迁移并通过 `node scripts/verify.mjs` 全量 35 项回归验证。
