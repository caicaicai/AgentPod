#!/usr/bin/env bash
#
# 把 scripts/deploy.sh 装成一个 systemd timer：每 N 分钟看一眼远端有没有新提交，
# 有就部署，没有就立刻返回。
#
# 为什么是轮询而不是 webhook：轮询不需要在源站开任何入站端口、不需要往
# GitHub 上放服务器凭据、断网恢复后自己会追上。代价是最多晚 N 分钟 ——
# 对一个体验站来说这不是代价。
#
# 用法（在服务器上，仓库目录里）：
#   sudo scripts/install-auto-deploy.sh              # 默认 5 分钟一次
#   sudo scripts/install-auto-deploy.sh --interval 15min
#   sudo scripts/install-auto-deploy.sh --uninstall
#
# 装完之后：
#   systemctl list-timers agentpod-deploy.timer      # 下次什么时候跑
#   journalctl -u agentpod-deploy.service -n 50      # 上次跑成什么样
#   tail -f <仓库>/deploy.log

set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="agentpod-deploy"
INTERVAL="5min"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --interval)  INTERVAL="${2:?--interval 后面要跟 systemd 时间格式，如 5min}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "要 root：sudo $0 $*" >&2
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now "${UNIT_NAME}.timer" 2>/dev/null || true
  rm -f "/etc/systemd/system/${UNIT_NAME}.timer" "/etc/systemd/system/${UNIT_NAME}.service"
  systemctl daemon-reload
  echo "已卸载 ${UNIT_NAME}.timer"
  exit 0
fi

# 以仓库目录的属主身份跑，不是 root —— 这样 git 不会把 .git 里的文件
# 变成 root 所有，之后手工 git 操作才不会撞权限。docker 那部分脚本里走 sudo。
RUN_USER="$(stat -c '%U' "$REPO_DIR")"
chmod +x "$REPO_DIR/scripts/deploy.sh"

cat >"/etc/systemd/system/${UNIT_NAME}.service" <<EOF
[Unit]
Description=AgentPod 自动部署（拉 git 最新代码并重建）
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
User=${RUN_USER}
WorkingDirectory=${REPO_DIR}
ExecStart=${REPO_DIR}/scripts/deploy.sh
# 首次构建（要装 Chromium）可能跑很久，给足时间，不然会被半路杀掉
# 留下一堆构建到一半的层
TimeoutStartSec=3600
EOF

cat >"/etc/systemd/system/${UNIT_NAME}.timer" <<EOF
[Unit]
Description=每 ${INTERVAL} 检查一次 AgentPod 是否有新提交

[Timer]
# 开机后等一会儿再跑第一次：让 docker 和网络先就位
OnBootSec=3min
OnUnitActiveSec=${INTERVAL}
AccuracySec=30s
Unit=${UNIT_NAME}.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "${UNIT_NAME}.timer"

echo "已装好：每 ${INTERVAL} 检查一次，仓库 ${REPO_DIR}，以 ${RUN_USER} 身份运行"
systemctl list-timers "${UNIT_NAME}.timer" --no-pager
