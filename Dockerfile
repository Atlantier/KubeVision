# KubeVision AI — 多阶段生产镜像
#
# 构建：docker build -t kubevision:local .
# 运行：docker run --rm -p 3000:3000 --env-file .env.local kubevision:local
#
# 说明：
# - 基础镜像固定 Node 20 LTS（Next 14 官方支持范围）；本机开发为 Node 24，二者均可。
# - .env.local 不进入镜像（.dockerignore 已排除），运行时通过 --env-file/环境变量注入。
# - 未在本仓库 CI 中实际构建过（当前环境无 Docker），提交前请在有 Docker 的机器上验证。

# ---------- deps：仅安装依赖（利用层缓存） ----------
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
RUN pnpm install --frozen-lockfile

# ---------- builder：生产构建 ----------
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------- runner：最小运行镜像 ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 非 root 运行
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/node_modules ./node_modules

RUN chown -R nextjs:nodejs /app
USER nextjs

EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]