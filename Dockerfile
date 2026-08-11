# ══════════════════════════════════════════════════════════════════════
# AgentPod —— Agent Service 标准 Docker 镜像
#
# 多阶段构建：
#   build   安装依赖 + 构建前端
#   runtime 精简运行时镜像，进程以非 root 用户运行
#
# 构建：
#   docker build -t agentpod-agent .
#
# 运行：
#   docker run -d --name agent -p 8787:8787 --env-file .env agentpod-agent
# ══════════════════════════════════════════════════════════════════════

# ── 构建阶段 ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /build

# 先拷 package.json 利用缓存层
COPY package.json package-lock.json* ./

# 有 lockfile 走 ci（可复现），没有走 install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# 前端依赖（构建期用完即删）
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && \
    if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi

# 拷入源码并构建前端
COPY src/ ./src/
COPY web/ ./web/
RUN cd web && npm run build && rm -rf node_modules
RUN test -f web/dist/index.html

# 构建期自检：pi 引擎与源码可按 ESM 加载
RUN node --input-type=module -e "\
  const ai = await import('@mariozechner/pi-ai'); \
  const coding = await import('@mariozechner/pi-coding-agent'); \
  if (!ai || !coding) throw new Error('pi 引擎导入结果为空'); \
  console.log('✅ pi 引擎可按 ESM 加载');"
RUN node --input-type=module -e "\
  const cfg = await import('./src/config.js'); \
  if (typeof cfg.loadConfig !== 'function') throw new Error('config.js 没导出 loadConfig'); \
  console.log('✅ 源码可按 ESM 解析');"

# ── 运行时阶段 ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

ENV TZ=Asia/Shanghai \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates tini tzdata \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 非 root 用户。agent 不执行用户代码，没有任何理由以 root 运行，
# 而它的内存里是所有在跑用户的登录态与 llmToken。
RUN useradd -m -s /bin/bash agent

WORKDIR /app

# 运行时依赖
COPY --from=build /build/node_modules/ ./node_modules/
COPY --from=build /build/package.json ./

# 源码 + 前端产物
COPY --from=build /build/src/ ./src/
COPY --from=build /build/web/dist/ ./web/dist/

# 技能资产
COPY managed-skills/ ./managed-skills/
COPY builtin-skills/ ./builtin-skills/

# 启动脚本
COPY bin/ ./bin/
RUN chmod a+x bin/*.sh 2>/dev/null || true

# 技能计数（构建日志可见）
RUN set -eu; \
    managed=$(find managed-skills -name SKILL.md 2>/dev/null | wc -l | tr -d ' '); \
    builtin=$(find builtin-skills -name SKILL.md 2>/dev/null | wc -l | tr -d ' '); \
    echo "打进镜像的技能：managed ${managed} 个 + builtin ${builtin} 个"

RUN mkdir -p /app/log && chown -R agent:agent /app

USER agent

EXPOSE 8787

# tini 处理僵尸进程回收与信号转发
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/index.js"]
