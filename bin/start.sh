#!/bin/bash
# Agent 启动脚本。标准容器部署下通常不需要直接调用此脚本——
# Dockerfile 的 ENTRYPOINT 已经直接运行 node src/index.js。
# 这个脚本用于：手动启动、docker-compose exec 内调试、或非容器环境运行。
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_DIR="${APP_DIR}/log"
LOG_FILE="${LOG_DIR}/agent.log"
ENTRY="${APP_DIR}/src/index.js"
NODE_BIN="${AP_NODE_BIN:-$(command -v node)}"
READY_TIMEOUT="${AGENT_READY_TIMEOUT:-25}"

PROC_PATTERN="node .*${ENTRY}"

echo "===== ap-cloud-agent 启动 ====="
echo "APP_DIR=${APP_DIR}"
echo "NODE_ENV=${NODE_ENV:-<未设置，会被当成 development>}"
echo "PORT=${PORT:-8787}"

die() { echo "启动前检查未通过：$*" >&2; exit 1; }
[ -f "${ENTRY}" ]                  || die "找不到 ${ENTRY}"
[ -f "${APP_DIR}/package.json" ]   || die "找不到 ${APP_DIR}/package.json（少了它 ESM 源码会被按 CJS 解析）"
[ -x "${NODE_BIN}" ]               || die "找不到 node：${NODE_BIN}"

if pgrep -f "${PROC_PATTERN}" >/dev/null 2>&1; then
  echo "已经在跑了（pid: $(pgrep -f "${PROC_PATTERN}" | tr '\n' ' ')），不重复拉起。"
  exit 0
fi

mkdir -p "${LOG_DIR}"

cd "${APP_DIR}" || exit 1
nohup "${NODE_BIN}" "${ENTRY}" >> "${LOG_FILE}" 2>&1 &

port="${PORT:-8787}"
printf '等待 /healthz'
for _ in $(seq 1 "${READY_TIMEOUT}"); do
  if body=$(curl -sf --max-time 2 "http://127.0.0.1:${port}/healthz" 2>/dev/null); then
    echo " ✓"
    echo "${body}" | "${NODE_BIN}" -e '
      let raw = ""
      process.stdin.on("data", (c) => (raw += c)).on("end", () => {
        try {
          const d = JSON.parse(raw)
          console.log(`  身份 ${d.authMode}  模型 ${d.llmMode}  沙盒 ${d.sandbox}`)
          if (d.devConsole) console.log("  ⚠️ devConsole=true —— 如果这是生产环境，说明 NODE_ENV=production 没送到进程里")
        } catch { console.log("  /healthz 返回的不是 JSON") }
      })'
    echo "===== 已拉起，日志：${LOG_FILE} ====="
    exit 0
  fi
  printf '.'
  sleep 1
done

echo " ✗"
echo "===== ${READY_TIMEOUT}s 内没等到 /healthz，日志最后 40 行 ====="
tail -n 40 "${LOG_FILE}" 2>/dev/null
echo "===== 常见原因：配置校验失败（退出码 2），或端口 ${port} 被占 ====="
exit 1
