#!/bin/bash
# Worker 停止脚本。标准容器部署下通常不需要——docker stop 已通过 tini 发 SIGTERM。
# 用于手动启动场景下的优雅停止。
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
GRACE_SECONDS="${STOP_GRACE_SECONDS:-30}"

pids="$(pgrep -f "node ${APP_DIR}/src/index.js" 2>/dev/null || true)"
if [ -z "${pids}" ]; then
  echo "===== worker 未在运行 ====="
  exit 0
fi

echo "===== 停止 worker（SIGTERM，等待租约清理）====="
# shellcheck disable=SC2086
kill -TERM ${pids} 2>/dev/null || true

for _ in $(seq 1 "${GRACE_SECONDS}"); do
  sleep 1
  if ! pgrep -f "node ${APP_DIR}/src/index.js" >/dev/null 2>&1; then
    echo "===== 已优雅停止 ====="
    exit 0
  fi
done

echo "===== 超过 ${GRACE_SECONDS}s 未退出，强制 KILL ====="
pkill -9 -f "node ${APP_DIR}/src/index.js" 2>/dev/null || true
echo "===== 已停止 ====="
