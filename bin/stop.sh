#!/bin/bash
# Agent 停止脚本。标准容器部署下通常不需要——docker stop 已通过 tini 发 SIGTERM。
# 用于手动启动场景下的优雅停止。
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENTRY="${APP_DIR}/src/index.js"
GRACE_SECONDS="${STOP_GRACE_SECONDS:-45}"
PROC_PATTERN="node .*${ENTRY}"

pids="$(pgrep -f "${PROC_PATTERN}" 2>/dev/null || true)"
if [ -z "${pids}" ]; then
  echo "===== agent 未在运行 ====="
  exit 0
fi

echo "===== 停止 agent（SIGTERM，等待排空 run）====="
echo "pid: $(echo "${pids}" | tr '\n' ' ')"
# shellcheck disable=SC2086
kill -TERM ${pids} 2>/dev/null || true

for _ in $(seq 1 "${GRACE_SECONDS}"); do
  sleep 1
  if ! pgrep -f "${PROC_PATTERN}" >/dev/null 2>&1; then
    echo "===== 已优雅停止 ====="
    exit 0
  fi
done

echo "===== 超过 ${GRACE_SECONDS}s 未退出，强制 KILL ====="
# shellcheck disable=SC2086
kill -9 $(pgrep -f "${PROC_PATTERN}" 2>/dev/null | tr '\n' ' ') 2>/dev/null || true
echo "===== 已停止 ====="
