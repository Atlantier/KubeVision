# 源码包构建与校验规范（SOURCE PACKAGE）

> 本文档说明如何从干净的 Git 提交导出可独立编译运行的 **KubeVision AI** 开源源码压缩包（MIT License）。

## 1. 包内容清单

| 类型 | 包含内容 | 说明 |
|---|---|---|
| 源码 | `src/`、`public/`（含 ONNX 权重）、配置文件、`package.json`、`pnpm-lock.yaml` | 生产构建与离线运行所需核心源码与静态模型资产 |
| 文档 | `README.md`、`启动说明.md`、`docs/EVIDENCE.md`、`docs/SECURITY_ADVISORY.md`、`docs/BUSINESS_CASE.md`、`docs/SUBMISSION_CHECKLIST.md`、`THIRD_PARTY_NOTICES.md`、`LICENSE` | 工程文档、可观测证据与合规声明 |
| 部署配置 | `.gitignore`、`.dockerignore`、`Dockerfile`、`vercel.json`、`docs/DEPLOYMENT.md` | 容器化、Vercel 与本地离线部署说明 |

## 2. 排除清单（不打入纯净源码包）

```text
node_modules/     依赖目录（体积大、平台相关，安装阶段由 pnpm 生成）
.next/            Next.js 构建缓存与产物
.git/             Git 历史仓库元数据
release/          本地打包输出归档目录
recording/        外部演示录屏文件
.env.local        本地 API Key / 网关密钥配置（绝不打包分发）
tmp-*.log / *.tsbuildinfo / .DS_Store
```

## 3. 生成源码压缩包（Windows PowerShell，仓库根目录执行）

```powershell
# 1) 使用 git archive 导出已跟踪的干净源码树（自动排除未跟踪文件与忽略目录）
git archive --format=zip -o "..\KubeVision_AI_src.zip" HEAD

# 2) 检查包体积与内容（确认无 node_modules/.next/.env.local）
Get-Item "..\KubeVision_AI_src.zip" | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
tar -tf "..\KubeVision_AI_src.zip" | Select-String -Pattern 'node_modules|^\.next/|\.env\.local' | Select-Object -First 5

# 3) 计算 SHA-256 校验摘要
Get-FileHash "..\KubeVision_AI_src.zip" -Algorithm SHA256
```

## 4. 打包前检查

- [ ] 包内**不含** `.env.local`、真实 API Key、Kubernetes Token；
- [ ] 包内**不含** `node_modules/`、`.next/`、`.git/`；
- [ ] 解压后按 [`启动说明.md`](../启动说明.md) 可执行 `pnpm install --frozen-lockfile && pnpm build && pnpm start`；
- [ ] SHA-256 与文件大小已核对；
- [ ] 静态门禁与端到端回归通过（`node scripts/verify.mjs` 35/35 与 `pnpm build && pnpm check:style-contract -- --require-build`）。
