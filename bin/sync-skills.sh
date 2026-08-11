#!/bin/bash
#
# 把技能资产从桌面端仓库同步进本仓库。**两个目录，去向完全不同**：
#
#   managed-skills/  技能本体（SKILL.md + scripts/）→ 随 **agent** 镜像发布
#   skill-libs/      技能用的客户端库 ap_http.*    → 随 **worker** 镜像发布
#
# **`builtin-skills/` 不在此列，永远不要加进来。** 那里的技能改写自桌面端扩展包
# （`extensions/ap-skills/skills`、`extensions/joyme/skills`），真源就在本仓库。
# 下面 sync_dir 用的是 `rsync --delete` 镜像同步，把它纳进来会做两件坏事：
# 源目录不存在 → 整个目录被清空；源目录存在 → 云端改写被桌面端原文覆盖回去。
# 两种都不报错，只表现为技能忽然不见了、或者又开始讲 Electron。
#
# 分工的依据是"谁把它送到沙盒里"：
#   - 技能本体由 agent 每轮铺进沙盒工作区（src/agent/skill-materializer.js），
#     所以只要 agent 镜像里有就够了；
#   - skill-libs 没人搬 —— agent 只注入一个**字符串**路径
#     （AP_SKILL_LIBS_DIR=/opt/ap/skill-libs，见 src/agent/tools.js），
#     所以文件必须事先烤在 worker 镜像里。
#
# 两个目录都放在**仓库根**下：构建上下文本来就是仓库根，两个服务的镜像共用一份。
#
# 用法：
#   bin/sync-skills.sh              从默认位置同步
#   bin/sync-skills.sh --dry-run    只看会同步什么，不动文件
#   AP_HOST_REPO=/path/to/fod bin/sync-skills.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 本仓库当前安置在 <桌面端仓库>/tmp/ap-cloud-agent 下（见 README 开头）。
# 迁移完成、目录移出去之后这个默认值就不成立了 —— 那时用 AP_HOST_REPO 指过去，
# 或者干脆把这个脚本删掉（技能已经在本仓库里了，不再需要同步）。
HOST_REPO="${AP_HOST_REPO:-$(cd "${REPO}/../.." 2>/dev/null && pwd || echo "")}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ ! -d "${HOST_REPO}/modules/ap" ]; then
  echo "找不到桌面端仓库：${HOST_REPO}/modules/ap" >&2
  echo "用 AP_HOST_REPO 指向它的仓库根（那个有 modules/ap/ 的目录），例如：" >&2
  echo "    AP_HOST_REPO=~/workspace/fod bin/sync-skills.sh" >&2
  exit 1
fi

# 镜像式同步：源里删掉的东西这边也要消失。否则会留下一个"已经下线、但模型还在
# 系统提示里看得到"的技能，用起来一路失败。README.md 是本仓库自己写的说明，
# 不能被 --delete 带走。
# 排除项在 dry-run 与真同步之间**必须一致**，否则预览会多报一批实际不会同步的文件
# （__pycache__ 就是典型：桌面端跑过 python 就有，我们一个都不该带走）。
prune() { find "$1" -type f ! -name '.DS_Store' ! -path '*/__pycache__/*'; }

sync_dir() {
  local name="$1" src="${HOST_REPO}/modules/ap/$1" dest="${REPO}/$1"
  if [ ! -d "${src}" ]; then
    echo "  跳过 ${name}：源目录不存在（${src}）"
    return 0
  fi
  local src_files
  src_files=$(prune "${src}" | wc -l | tr -d ' ')
  if [ "${src_files}" -eq 0 ]; then
    echo "  跳过 ${name}：源目录是空的（同步过去只会把目标清空）" >&2
    return 0
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "  ${name}/  ← ${src_files} 个文件"
    prune "${src}" | sed "s#^${src}/#      #" | sort | head -40
    return 0
  fi

  mkdir -p "${dest}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude 'README.md' --exclude '.DS_Store' --exclude '__pycache__' "${src}/" "${dest}/"
  else
    find "${dest}" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
    cp -R "${src}/." "${dest}/"
    find "${dest}" \( -name '.DS_Store' -o -name '__pycache__' \) -exec rm -rf {} + 2>/dev/null || true
  fi
  echo "  ${name}/  ✓ $(find "${dest}" -type f | wc -l | tr -d ' ') 个文件"
}

echo "源  ${HOST_REPO}/modules/ap"
echo "目标 ${REPO}"
echo
[ "${DRY_RUN}" -eq 1 ] && echo "--- dry-run：会同步这些 ---"

# managed-skills → agent 镜像；skill-libs → worker 镜像。理由见文件开头。
sync_dir managed-skills
sync_dir skill-libs

[ "${DRY_RUN}" -eq 1 ] && exit 0

# 桌面端专属写法的提醒。**不是门禁**，只是让人知道自己发出去的是什么。
echo
suspects=$(grep -rl 'whoami' "${REPO}/managed-skills" 2>/dev/null | sed "s#${REPO}/#  #" || true)
if [ -n "${suspects}" ]; then
  echo "⚠️ 这几个文件里有 \$(whoami) —— 桌面端靠它取 username，云端沙盒里 uid 是槽位序号不是人："
  echo "${suspects}"
fi
# 更要紧的一类：直接读凭据 + 直连内网。凭据不进沙盒（隔离契约），
# 这类技能装得进镜像、模型也看得见，但一跑就失败，所以必须在同步这一步就说清楚。
direct=$(grep -rl 'ME_TOKEN\|SSO_TOKEN' "${REPO}/managed-skills" 2>/dev/null | sed "s#${REPO}/#  #" || true)
if [ -n "${direct}" ]; then
  echo
  echo "⚠️ 这几个文件从环境变量读凭据、多半还直连内网域名 —— **凭据不会进沙盒（隔离契约）**："
  echo "${direct}"
fi

echo
echo "（builtin-skills/ 不参与同步：那是本仓库自己维护的平台技能，见它的 README）"
echo
echo "别忘了提交并重新构建镜像："
echo "    git add managed-skills skill-libs && git commit -m 'chore: 同步技能资产'"
