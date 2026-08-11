# ══════════════════════════════════════════════════════════════════════
# AgentPod —— Sandbox Worker 标准 Docker 镜像
#
# Worker 以 root 运行（必须：建 namespace、降权、跨 uid 杀进程组）。
# 容器需要 --privileged 或 CAP_SYS_ADMIN + CAP_NET_ADMIN。
#
# 构建上下文是**仓库根目录**（skill-libs 在仓库根下）：
#   docker build -t agentpod-worker -f sandbox-worker/Dockerfile .
#
# 运行：
#   docker run -d --name worker --privileged \
#     -p 8080:8080 --env-file sandbox-worker/.env agentpod-worker
# ══════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai

ARG PLAYWRIGHT_VERSION=1.58.2

# ── 系统依赖 ──────────────────────────────────────────────────────────
# util-linux（unshare/nsenter）+ iproute2（ip）+ iptables 是 namespace 隔离的
# 硬依赖：整套多用户隔离靠它们建 PID/mount/net/uts/ipc namespace
# 与每 slot 的 veth+出站规则。
# fonts-noto-cjk：没有中文字体，内网系统截图全是方块。
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git \
      bash coreutils procps tini \
      util-linux iproute2 iptables \
      sudo \
      python3 python3-venv python3-pip \
      fonts-noto-cjk fonts-liberation \
      tzdata \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Python 运行时 ─────────────────────────────────────────────────────
# 独立 venv，不污染系统 python。
# requests —— 技能出网；cryptography —— joymail 登录 RSA 加密
RUN python3 -m venv /opt/ap/venv \
    && /opt/ap/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/ap/venv/bin/pip install --no-cache-dir requests cryptography

# ── Playwright + Chromium ─────────────────────────────────────────────
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g playwright@${PLAYWRIGHT_VERSION} \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /opt/ms-playwright

# ESM import 解析：全局的 playwright 通过 /node_modules 软链让任意路径下都能 import
ENV NODE_PATH=/usr/local/lib/node_modules
RUN mkdir -p /node_modules \
    && ln -sfn /usr/local/lib/node_modules/playwright /node_modules/playwright \
    && mkdir -p /tmp/pwcheck/a/b/c && cd /tmp/pwcheck/a/b/c \
    && node --input-type=module -e "const pw = await import('playwright'); if (!pw.chromium) throw new Error('playwright 加载了但没有 chromium'); console.log('✅ ESM 可解析 playwright')" \
    && rm -rf /tmp/pwcheck

# ── 技能运行时环境 ─────────────────────────────────────────────────────
ENV AP_PYTHON_BIN=/opt/ap/venv/bin/python3 \
    AP_NODE_BIN=/usr/local/bin/node \
    JOB_PATH=/opt/ap/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# 构建期验证 JOB_PATH 与 venv 对齐
RUN set -eu; \
    export PATH="$JOB_PATH"; \
    resolved="$(command -v python3 || true)"; \
    [ "$resolved" = "$AP_PYTHON_BIN" ] || { \
        echo "JOB_PATH 解析出的 python3 是 [$resolved]，期望 [$AP_PYTHON_BIN]" >&2; exit 1; }; \
    python3 -c 'import requests' || { \
        echo "venv 里没有 requests" >&2; exit 1; }; \
    python3 -c 'from cryptography.hazmat.primitives.serialization import load_pem_public_key' || { \
        echo "venv 里没有 cryptography" >&2; exit 1; }; \
    echo "✅ 技能 python 环境自检通过：$resolved"

# ── 工作区 ──────────────────────────────────────────────────────────
RUN mkdir -p /var/tmp/ap-sandbox && chmod 755 /var/tmp/ap-sandbox

# ── 应用代码 ──────────────────────────────────────────────────────────
# 构建上下文是仓库根，路径带子目录名
WORKDIR /app
COPY sandbox-worker/package.json ./
COPY sandbox-worker/src/ ./src/
COPY sandbox-worker/bin/ ./bin/
RUN chmod a+x bin/*.sh 2>/dev/null || true

# 技能客户端库（跟 worker 走，agent 只注入路径字符串）
COPY skill-libs/ /opt/ap/skill-libs/
RUN chmod -R a+rX /opt/ap/skill-libs

EXPOSE 8080

# tini 处理僵尸进程回收与信号转发；worker 以 root 运行
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/index.js"]
