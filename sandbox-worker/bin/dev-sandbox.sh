#!/usr/bin/env bash
#
# 本地开发用的沙盒 worker：起 / 停 / 重启 / 看状态。
#
# ── 为什么要有这个脚本 ────────────────────────────────────────────────
#
# 这条 docker 命令有四个记错了就会浪费半小时的参数，而它们全都不会明着报错：
#
#   --privileged          缺了 → slot 池建不起来，worker 直接启动失败
#   -v 仓库:/work         缺了 → 跑的是镜像里的旧代码，改了源码没反应
#   SANDBOX_NS_BRIDGE     与别的容器重名 → 两个 worker 抢同一个网桥
#   SANDBOX_NS_SUBNET     与宿主/其它容器网段冲突 → slot 出不了网
#
# ── 一个关键性质：代码是 live-mount 的 ────────────────────────────────
#
# 仓库整个挂进容器，worker 直接跑 /work/sandbox-worker/src。**改完代码不用重新
# 构建镜像，`restart` 就够了。** 镜像只提供运行时（node / chromium / python venv /
# iproute2 / iptables），不含业务代码。
#
# 用法：
#   bin/dev-sandbox.sh up        起（已存在则重建）
#   bin/dev-sandbox.sh restart   重启，吃到最新代码 ← 改完代码用这个
#   bin/dev-sandbox.sh build     重新构建镜像 ← 改了 Dockerfile 用这个
#   bin/dev-sandbox.sh rebuild   build + up（构建完直接起）
#   bin/dev-sandbox.sh status    健康状态 + 出站策略 + 槽位占用
#   bin/dev-sandbox.sh logs      跟日志
#   bin/dev-sandbox.sh down      停掉并删除
set -euo pipefail

# 本机私有配置（凭据放这儿，**不进 git**）。
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env.dev"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

NAME=${SANDBOX_DEV_NAME:-ap-e2e-worker}
PORT=${SANDBOX_DEV_PORT:-8081}
IMAGE=${SANDBOX_DEV_IMAGE:-agentpod-worker-dev:latest}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

SANDBOX_TOKEN=${SANDBOX_TOKEN:-local-dev-token-0123456789}

build() {
  echo "构建本地开发镜像 ${IMAGE}"
  echo "  Dockerfile: sandbox-worker/Dockerfile"
  echo "  构建上下文: ${REPO}"
  echo
  docker build -t "$IMAGE" -f "$REPO/sandbox-worker/Dockerfile" "$REPO"
  echo
  echo "✓ 镜像已构建：$IMAGE"
}

up() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "起 ${NAME}（镜像 ${IMAGE}，代码挂 ${REPO}）"
  docker run -d --name "$NAME" --privileged -p "$PORT:$PORT" \
    -v "$REPO:/work" \
    -w /work/sandbox-worker \
    -e NODE_ENV=development \
    -e PORT="$PORT" \
    -e SANDBOX_SLOTS="${SANDBOX_SLOTS:-2}" \
    -e SANDBOX_TOKEN="$SANDBOX_TOKEN" \
    -e SANDBOX_WORK_ROOT=/var/tmp/ap-sandbox \
    -e SANDBOX_ADVERTISE_BASE="http://127.0.0.1:$PORT" \
    -e PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    -e SANDBOX_NS_BRIDGE="${SANDBOX_NS_BRIDGE:-sbxe2ebr0}" \
    -e SANDBOX_NS_SUBNET="${SANDBOX_NS_SUBNET:-10.248.0.0/16}" \
    "$IMAGE" node src/index.js >/dev/null
  wait_ready
}

wait_ready() {
  printf '等待 slot 池建好'
  for _ in $(seq 1 40); do
    if curl -sf --max-time 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
      echo " ✓"
      status
      return 0
    fi
    printf '.'
    sleep 1
  done
  echo " ✗"
  echo "起不来。多半是缺 CAP_SYS_ADMIN/CAP_NET_ADMIN（--privileged），看日志："
  docker logs --tail 30 "$NAME"
  return 1
}

status() {
  curl -s --max-time 5 "http://localhost:$PORT/healthz" | python3 -c '
import sys, json
d = json.load(sys.stdin)
eg = d.get("namespace", {}).get("egress", {})
s = d["slots"]
print("  槽位      {}/{}   已跑 {} 分钟".format(s["used"], s["total"], round(d["uptimeMs"] / 60000)))
print("  出站      {}（来源 {}，版本 {}）".format(
    eg.get("mode", "?"), eg.get("source", "?"), eg.get("revision") or "-"))
print("  浏览器    {}".format("在跑" if d.get("browser", {}).get("running") else "未启动"))
' 2>/dev/null || { echo "  连不上 http://localhost:$PORT/healthz"; return 1; }

  echo "  占用："
  curl -s --max-time 5 -H "Authorization: Bearer $SANDBOX_TOKEN" \
    "http://localhost:$PORT/v1/admin/occupancy" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("            取不到 —— 这个 worker 还是旧代码？先 restart")
    raise SystemExit
if not d.get("ok"):
    print("            401 —— SANDBOX_TOKEN 与容器里的不一致")
    raise SystemExit
rows = d.get("occupancy") or []
if not rows:
    print("            无（空闲槽位 {}）".format(d.get("freeSlots")))
for r in rows:
    print("            #{} {} run={} 占用{}s 空闲{}s 跑着{}条".format(
        r["slotIndex"], r["username"], r["runId"],
        round(r["ageMs"] / 1000), round(r["idleMs"] / 1000), r["running"]))
' 2>/dev/null
}

case "${1:-status}" in
  up|start)  up ;;
  restart)   docker restart "$NAME" >/dev/null; echo "已重启（代码是挂载的，会吃到最新改动）"; wait_ready ;;
  build)     build ;;
  rebuild)   build && up ;;
  down|stop) docker rm -f "$NAME" >/dev/null 2>&1 && echo "已停掉并删除" ;;
  logs)      docker logs -f --tail 50 "$NAME" ;;
  status)    status ;;
  *)         sed -n '/^# 用法/,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//;$d'; exit 1 ;;
esac
