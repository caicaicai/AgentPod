#!/bin/bash
# Worker 启动脚本。标准容器部署下通常不需要直接调用——
# Dockerfile 的 ENTRYPOINT 已经直接运行 node src/index.js。
# 用于手动启动或调试场景。
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_DIR="${APP_DIR}/log"
mkdir -p "${LOG_DIR}"

echo "===== sandbox-worker 启动 ====="
echo "APP_DIR=${APP_DIR}"
echo "SANDBOX_SLOTS=${SANDBOX_SLOTS:-1}"
echo "BROWSER_ENABLED=${BROWSER_ENABLED:-1}"

cd "${APP_DIR}" || exit 1

nohup /usr/local/bin/node "${APP_DIR}/src/index.js" >> "${LOG_DIR}/worker.log" 2>&1 &

echo "===== 已拉起，日志：${LOG_DIR}/worker.log ====="
