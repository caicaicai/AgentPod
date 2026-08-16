#!/usr/bin/env bash
#
# 从 git 拉最新代码 → 重建镜像 → 滚动起来 → 验健康；不健康就滚回去。
#
# ── 这个脚本的立场 ──────────────────────────────────────────────────────
#
# 部署机上的仓库是远端的**镜像**，不是工作副本：本地改动一律丢弃
# （`git reset --hard`）。这一条是故意的 —— 允许在服务器上留改动，
# 就等于允许出现一份没人 review 过、也没人知道它存在的线上代码。
# 服务器上真正独有的东西只有一样：`.env`。它在 .gitignore 里，
# reset 与 clean 都碰不到它，所以这份"镜像"立场不会误伤配置。
#
# 没有新提交时**什么都不做**（一次 git fetch 就返回），所以可以放心让
# 定时器每几分钟跑一次。
#
# 用法：
#   scripts/deploy.sh              有新提交才部署
#   scripts/deploy.sh --force      不管有没有新提交，重建一遍
#   scripts/deploy.sh --ref v1.2   部署到指定分支/标签/提交
#
# 装成自动更新（systemd timer）：scripts/install-auto-deploy.sh

set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BRANCH="${DEPLOY_BRANCH:-main}"
REMOTE="${DEPLOY_REMOTE:-origin}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:8787/healthz}"
HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-120}"
LOG_FILE="${DEPLOY_LOG:-$REPO_DIR/deploy.log}"
LOCK_FILE="${DEPLOY_LOCK:-$REPO_DIR/.deploy.lock}"

FORCE=0
REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --ref)   REF="${2:?--ref 后面要跟一个分支/标签/提交}"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }

# docker 要 root。以 root 身份跑时 sudo 也是通的，所以不分支处理。
dc() { sudo docker compose "$@"; }

# ── 同一时刻只允许一次部署 ──────────────────────────────────────────────
# 没有它，定时器与手工执行撞在一起会让两个 `docker compose up` 同时改同一组容器。
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "另一次部署还在跑（$LOCK_FILE 被占用），这次跳过"
  exit 0
fi

log "───── 部署开始（ref=${REF:-$REMOTE/$BRANCH} force=$FORCE）─────"

git fetch --prune "$REMOTE" "$BRANCH" --tags
TARGET_REF="${REF:-$REMOTE/$BRANCH}"
TARGET="$(git rev-parse --verify "${TARGET_REF}^{commit}")"
CURRENT="$(git rev-parse HEAD)"

if [ "$TARGET" = "$CURRENT" ] && [ "$FORCE" -eq 0 ]; then
  log "已经是最新（${CURRENT:0:8}），无事可做"
  exit 0
fi

log "更新：${CURRENT:0:8} → ${TARGET:0:8}"
git --no-pager log --oneline "$CURRENT..$TARGET" 2>/dev/null | head -20 | tee -a "$LOG_FILE" || true

# 把这次之前的位置记下来，健康检查不过时要滚回去
PREVIOUS="$CURRENT"

# ── 起来之后验一验 ─────────────────────────────────────────────────────
# 只认 `ok:true`。容器"Up"不等于服务能用：配置写错时进程照样在，
# 只是每个请求都 500 —— 那种情况必须算部署失败，否则回滚永远不会触发。
health_ok() {
  local deadline=$(( SECONDS + HEALTH_TIMEOUT ))
  while [ $SECONDS -lt $deadline ]; do
    if curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

build_and_up() {
  dc build
  dc up -d --remove-orphans
}

checkout() {
  git reset --hard "$1"
  # 删掉已从仓库里移除的文件留下的残骸。不带 -x，所以 .gitignore 里的
  # .env / node_modules 一概不动。
  git clean -fd
}

checkout "$TARGET"

if build_and_up && health_ok; then
  log "部署成功：$(git rev-parse --short HEAD)"
  dc ps --format '{{.Name}}\t{{.Status}}' | tee -a "$LOG_FILE"
  # 每次重建都会留下一层旧镜像，不清的话磁盘是单调增长的
  sudo docker image prune -f >/dev/null 2>&1 || true
  log "───── 部署结束 ─────"
  exit 0
fi

# ── 回滚 ───────────────────────────────────────────────────────────────
log "!! 新版本没能通过健康检查，回滚到 ${PREVIOUS:0:8}"
checkout "$PREVIOUS"
if build_and_up && health_ok; then
  log "已回滚到 ${PREVIOUS:0:8}，服务恢复。请查 deploy.log 与 \`docker compose logs agent\`"
else
  log "!! 回滚之后仍然不健康 —— 需要人工介入。docker compose logs --tail=100"
fi
log "───── 部署失败 ─────"
exit 1
