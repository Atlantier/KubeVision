# 部署说明（DEPLOYMENT）

> 三种部署形态：本机演示（默认）、Docker、Vercel/自建 Node。离线要求见 `docs/summit/DUAL_MACHINE_CHECKLIST.md`。
> 当前环境无 Docker，Dockerfile 未实际构建验证（已标注）；Vercel 部署按官方免费额度说明书写。

## 0. 通用前置

```bash
pnpm install --frozen-lockfile
pnpm build
```

- Node ≥ 18.17（推荐 20/24）；
- 生产启动：`pnpm start`（Next.js `next start`，端口 3000）；
- `.env.local` 只在服务端读取；**不得提交/打入镜像**（`.dockerignore` 已排除）；
- 端侧模型权重在 `public/models/Xenova/all-MiniLM-L6-v2/`，需随部署产物一起发布（约 86 MB）。

## 1. 本机/内网服务器

```bash
pnpm build
PORT=3000 pnpm start
# 反向代理（可选）
```

Nginx 关键配置（SSE / NDJSON 最容易被缓冲破坏）：

```nginx
location /api/telemetry {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 3600s;
  add_header Cache-Control "no-cache, no-transform" always;
  add_header X-Accel-Buffering "no" always;
}
location /api/chat {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 120s;
  add_header Cache-Control "no-cache, no-transform" always;
  add_header X-Accel-Buffering "no" always;
}
```

> 路由自身已返回 `Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`；
> 反向代理/CDN 若二次压缩或缓冲，会让 NDJSON/SSE 变成"整段到达"，前端表现为长时间空白。**不要关闭这些头**。

## 2. Docker（多阶段）

```bash
docker build -t kubevision:local .
docker run --rm -p 3000:3000 --env-file .env.local kubevision:local
# 无 Key 演示：不传 --env-file 即可（引擎 B）
```

- 镜像内不包含 `.env.local`；通过 `--env-file` 或 `-e` 注入；
- 端口固定 3000；如需改端口，重新构建或覆盖 `PORT`（Dockerfile 的 CMD 以显式参数启动，需同步改）；
- 镜像体积以实际构建为准，未在本仓库 CI 验证（本机无 Docker）。

## 3. Vercel

1. 导入 Git 仓库，Framework 选择 Next.js；
2. `vercel.json` 仅保留 `regions` 与 API `maxDuration`（chat/telemetry 各 60s）；流式头由路由返回；
3. 环境变量：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `AI_MODEL_NAME`（可选）；
4. 端侧 ONNX 权重约 86 MB：Vercel 静态资源可托管，但冷启动与流量成本需自测；**离线要求场景优先自建服务器**；
5. 免费额度下函数时长有限，长回答可能被截断；`maxDuration` 已设 60s，仍受平台套餐约束。

## 4. 公网不可用时的离线运行

1. 用预构建包（`pnpm package:demo` 产物）拷贝到目标机；
2. 目标机解压后 `pnpm install --offline --frozen-lockfile`（依赖本机 pnpm store）→ `pnpm start`；
3. 若连 pnpm store 都没有：直接拷贝整份 `node_modules`（同 OS/架构）与 `.next`、`public`；
4. 离线时云端 LLM 不可用 → 引擎 B；RAG、端侧脱敏、审计、复盘、自检本地可用；
5. 浏览器与 Node 安装包一并放 U 盘（见 `docs/summit/DUAL_MACHINE_CHECKLIST.md`）。

## 5. 安全检查清单

- [ ] 未把 `.env.local`、真实 Key、K8s Token 打进源码包/镜像；
- [ ] `K8S_API_SERVER` 使用只读凭据；写操作仍走 HITL 确认；
- [ ] 反向代理未缓冲流式响应（§1）；
- [ ] 公网暴露时加认证/网关（本作品演示版未内置登录鉴权，属已知边界）。