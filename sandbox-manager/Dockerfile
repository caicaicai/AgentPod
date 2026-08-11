# ══════════════════════════════════════════════════════════════════════
# sandbox-manager —— 沙盒集群管理服务标准 Docker 镜像
#
# 多阶段构建：
#   deps     安装后端生产依赖
#   build    编译 TypeScript + 构建 Vue 前端
#   runtime  精简运行时镜像
#
# 构建：
#   docker build -t sandbox-manager .
#
# 运行：
#   docker run -d --name manager -p 3000:3000 --env-file .env sandbox-manager
# ══════════════════════════════════════════════════════════════════════

# ── 依赖阶段 ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps

WORKDIR /build
COPY package.json package-lock.json* ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# ── 构建阶段 ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /build

# 后端 — 需要 devDependencies（typescript）来编译
COPY package.json package-lock.json* tsconfig.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi
COPY src/ ./src/
RUN npx tsc

# 前端
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && \
    if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi
COPY web/ ./web/
RUN cd web && npm run build
RUN test -f web/dist/index.html

# ── 运行时阶段 ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim

ENV TZ=Asia/Shanghai \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates tini tzdata \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash manager

WORKDIR /app

COPY --from=deps /build/node_modules/ ./node_modules/
COPY --from=deps /build/package.json ./

COPY --from=build /build/dist/ ./dist/
COPY --from=build /build/web/dist/ ./web/dist/

RUN mkdir -p /app/log && chown -R manager:manager /app

USER manager

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
