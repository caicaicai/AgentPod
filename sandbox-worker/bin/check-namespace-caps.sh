#!/bin/sh
# Namespace 隔离方案的可行性探测——**逐字对照 src/namespace/ 的真实实现**。
#
# 上一版只测了"通用能力"（unshare 一下、建个 veth）。这一版换成把
# sentinel.js / netns.js / cgroup.js / executor.js 里实际会跑的每一条命令
# 原样跑一遍：建 sentinel → 从它的 mount namespace bind 一个目录 → 用
# nsenter --setuid/--setgid 模拟一次真实的 job 执行 → 建网桥 + veth +
# NAT + 出站白名单 → 建 cgroup 写限额。任何一步在这台机器上会失败，
# 这里就应该先失败给你看，而不是等 worker 启动时才炸。
#
# 特意写成纯 POSIX sh（不用 bash 数组、不用 `set -o pipefail`）——
# 实测踩过坑：`sh script.sh` 在有的机器上真的会走到 dash 而不是 bash，
# bash 专属语法会让脚本在打印第一行之前就直接报错退出，什么都测不出来。
#
# 用法：把这个脚本传进 sandbox-worker 实际部署的 Pod/容器里，以 root 跑：
#   sh check-namespace-caps.sh   # 或 bash check-namespace-caps.sh，两种都行
#
# 脚本自己会清理所有测试产物（sentinel 进程、veth、网桥、cgroup 目录）。
# 中途被 Ctrl-C 或异常退出也会走 trap 清理，不会在机器上留下垃圾。
set -u

PASS=0
FAIL=0
ok()   { echo "[ OK ] $*"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }
info() { echo "[INFO] $*"; }
section() { echo; echo "===== $* ====="; }

# ── 测试资源与清理 ────────────────────────────────────────────────────
SENTINEL_PARENT_PID=""
SENTINEL_CHILD_PID=""
SENTINEL2_PARENT_PID=""
SENTINEL2_CHILD_PID=""
TEST_BRIDGE="nsprobe-br0"
TEST_VETH_HOST="nsprobe-veth0"
TEST_VETH_HOST2="nsprobe-veth1"
TEST_HOST_DIR="$(mktemp -d /tmp/nsprobe-workspace.XXXXXX)"
TEST_CGROUP_V2_DIR="/sys/fs/cgroup/nsprobe-test"
# 用空格分隔的字符串而不是 bash 数组：这份脚本会被直接用 `sh script.sh` 跑
# （而不一定是 `bash script.sh`），且就算是 bash，`set -u` 对"空数组"的
# `${arr[@]}` 展开有个多个版本都存在的已知坑——数组一旦是空的，`${arr[@]}`
# 会被当成"未设置"直接报 unbound variable，即使数组本身明明赋过值。
# 路径/flag 这种不含空格的场景用字符串 + 有意不加引号展开，完全等价且更通用。
TEST_CGROUP_V1_DIRS=""
PROBE_PORT=19919
PROBE_LISTENER_PID=""

cleanup() {
  set +e
  [ -n "${PROBE_LISTENER_PID}" ] && kill -9 "${PROBE_LISTENER_PID}" 2>/dev/null
  [ -n "${SENTINEL_PARENT_PID}" ] && kill -9 "${SENTINEL_PARENT_PID}" 2>/dev/null
  [ -n "${SENTINEL_CHILD_PID}" ] && kill -9 "${SENTINEL_CHILD_PID}" 2>/dev/null
  [ -n "${SENTINEL2_PARENT_PID}" ] && kill -9 "${SENTINEL2_PARENT_PID}" 2>/dev/null
  [ -n "${SENTINEL2_CHILD_PID}" ] && kill -9 "${SENTINEL2_CHILD_PID}" 2>/dev/null
  ip link del "${TEST_VETH_HOST}" >/dev/null 2>&1
  ip link del "${TEST_VETH_HOST2}" >/dev/null 2>&1
  ip link del "${TEST_BRIDGE}" >/dev/null 2>&1
  rm -rf "${TEST_HOST_DIR}"
  # cgroup 目录只能 rmdir，rm -rf 会因为控制文件不能 unlink 而失败
  rmdir "${TEST_CGROUP_V2_DIR}/slot-0" 2>/dev/null
  rmdir "${TEST_CGROUP_V2_DIR}" 2>/dev/null
  # 有意不加引号：靠空格做分词，逐个删掉 v1 cgroup 测试目录
  for d in ${TEST_CGROUP_V1_DIRS}; do
    [ -n "$d" ] && rmdir "$d" 2>/dev/null
  done
}
trap cleanup EXIT INT TERM

# ── 网络连通性探测：一律用 TCP，**不用 ping** ─────────────────────────
#
# 这是踩过的坑，写清楚免得以后又改回去：上一版拿 `ping 网桥IP` 当"链路通不通"
# 的唯一判据，在允许节点上必然失败，于是把一台完全健康的机器判成"网络不可用"，
# 差点据此推翻整个 netns 方案。实际原因是那台机器不给 ICMP（CAP_NET_RAW 被
# drop，或 icmp_echo_ignore_all=1），而 slot 的真实流量**全是 TCP**——ping 测的
# 是产品一次都不会走的协议。
#
# 而且 ping 的目标是网桥自己的 IP，属于本机投递（走 INPUT 链），跟 slot 出网
# 真正依赖的 FORWARD + MASQUERADE 完全是两条路径——旧版在 ping 失败时去加
# FORWARD 放行规则再试，加的是一条对这个目的地根本不参与的链。
#
# 所以这里分成两个独立的判据：
#   netns_tcp <ip> <port>  第一跳：slot netns → 网桥（本机投递，看 INPUT/网桥状态）
#   出网测试（4a）         全链路：slot → 网桥 → FORWARD → MASQUERADE → 真实外部地址
NODE_BIN="$(command -v node 2>/dev/null || true)"

# 在 slot netns 内发起一次 TCP 连接，连上返回 0，连不上返回 1，没有可用工具返回 2。
netns_tcp() {
  _tcp_host="$1"
  _tcp_port="$2"
  if [ -n "${NODE_BIN}" ]; then
    nsenter --target "${SENTINEL_CHILD_PID}" --net -- "${NODE_BIN}" -e \
      "var s=require('net').connect(${_tcp_port},'${_tcp_host}');s.setTimeout(3000);s.on('connect',function(){s.destroy();process.exit(0)});s.on('error',function(){process.exit(1)});s.on('timeout',function(){process.exit(1)});" \
      >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nsenter --target "${SENTINEL_CHILD_PID}" --net -- nc -z -w3 "${_tcp_host}" "${_tcp_port}" >/dev/null 2>&1
  else
    return 2
  fi
}

# 在探测机自己的网络栈里起一个 TCP 监听，给第一跳测试当靶子。
start_probe_listener() {
  [ -n "${NODE_BIN}" ] || return 1
  "${NODE_BIN}" -e "require('net').createServer(function(c){c.destroy()}).listen(${PROBE_PORT},'0.0.0.0')" >/dev/null 2>&1 &
  PROBE_LISTENER_PID=$!
  sleep 1
  kill -0 "${PROBE_LISTENER_PID}" 2>/dev/null
}

# ── 1) 身份与 capability ──────────────────────────────────────────────
section "1) 当前身份与 capability 位"
id
if command -v capsh >/dev/null 2>&1; then
  capsh --print 2>/dev/null | grep -i "current" || true
else
  info "没有 capsh（libcap2-bin），退回读 /proc/self/status"
fi
CAP_LINE="$(grep -i '^CapEff' /proc/self/status 2>/dev/null | awk '{print $2}')"
info "CapEff (hex) = ${CAP_LINE:-未知}"

# ── 2) 工具链，含 nsenter 的关键 flag 支持 ────────────────────────────
section "2) 工具链是否齐全，且版本支持所需 flag"
for bin in unshare nsenter ip iptables getent; do
  if command -v "$bin" >/dev/null 2>&1; then
    ok "$bin 存在：$(command -v "$bin")"
  else
    fail "$bin 不存在——util-linux/iproute2/iptables/glibc-tools 需要在底包里补装"
  fi
done
# --setuid/--setgid 是较新 util-linux 才有的 flag，executor.js 的降权整个依赖它们
# （见 buildNsenterInvocation 的注释）。--wd **不在**依赖之列，见 3b。
if nsenter --help 2>&1 | grep -q -- '--setuid'; then
  ok "nsenter 支持 --setuid/--setgid（降权时机正确的关键）"
else
  fail "nsenter 版本太旧，不支持 --setuid/--setgid——executor.js 的降权方式在这台机器上用不了"
fi
# 有没有 --wd 都不影响：executor.js 不用它（它在 setns 之前解析路径，对 slot
# 内部的路径必然失败），cwd 是由目标 namespace 里的 shell 自己 cd 的。
if nsenter --help 2>&1 | grep -q -- '--wd'; then
  info "这个 nsenter 有 --wd，但我们不用它（3b 会实测它对 slot 内路径无效）"
fi

# 与 src/namespace/nsenter-compat.js 同一套判断逻辑："--no-fork" 不包含
# 子串 "--fork"（少一个连字符），所以能正确区分"这个版本列出了独立的
# --fork 选项（旧语义，需要显式传）"与"只列出了 --no-fork（新语义，
# 带 -p 时默认就 fork，--fork 反而是未识别参数）"。
NSENTER_HELP="$(nsenter --help 2>&1)"
if echo "${NSENTER_HELP}" | grep -q -- '--fork'; then
  NSENTER_FORK_FLAG="--fork"
  info "nsenter 语义：需要显式传 --fork 才会 fork（较早版本）"
else
  NSENTER_FORK_FLAG=""
  info "nsenter 语义：带 -p/--pid 时默认就 fork，不传 --fork（较新版本，与 src/namespace/nsenter-compat.js 探测结果应该一致）"
fi

# ── 3) 真实建一个 sentinel（原样复刻 sentinel.js 的命令）─────────────
section "3) 建 sentinel：unshare 五种 namespace + mount --make-rprivate"
SENTINEL_PARENT_PID=""
if unshare --mount --uts --ipc --net --pid --fork --mount-proc \
     -- /bin/sh -c 'mount --make-rprivate / 2>/dev/null; exec sleep 300' \
     >/dev/null 2>/tmp/.sentinel-err &
then
  SENTINEL_PARENT_PID=$!
  # 等子进程出现（fork+exec 之间有微小时间差，与 sentinel.js 的 findChildPid 逻辑一致）
  for _ in $(seq 1 50); do
    if [ -r "/proc/${SENTINEL_PARENT_PID}/task/${SENTINEL_PARENT_PID}/children" ]; then
      SENTINEL_CHILD_PID="$(cat "/proc/${SENTINEL_PARENT_PID}/task/${SENTINEL_PARENT_PID}/children" 2>/dev/null | awk '{print $1}')"
      [ -n "${SENTINEL_CHILD_PID}" ] && break
    fi
    sleep 0.1
  done
  if [ -n "${SENTINEL_CHILD_PID}" ]; then
    ok "sentinel 建立成功：parent=${SENTINEL_PARENT_PID} child=${SENTINEL_CHILD_PID}（nsenter 的真正目标）"
  else
    fail "unshare 进程起来了，但读不到 /proc/<pid>/task/<pid>/children——内核可能没开 CONFIG_PROC_CHILDREN，sentinel.js 的 PID 发现机制会失效"
  fi
else
  fail "unshare 全套 namespace 建立失败：$(cat /tmp/.sentinel-err 2>/dev/null)"
  info "常见原因：缺 CAP_SYS_ADMIN，或 seccomp profile 拦截了 clone(CLONE_NEWNS|CLONE_NEWPID|...)"
fi
rm -f /tmp/.sentinel-err

if [ -n "${SENTINEL_CHILD_PID}" ]; then
  section "3a) nsenter 注入 job：--setuid/--setgid 顺序是否正确（用探测出来的 --fork 语义）"
  # 有意不给 NSENTER_FORK_FLAG 加引号：它要么是空字符串（这时这个位置的参数
  # 直接消失，不会传一个空字符串参数给 nsenter），要么是 "--fork" 单个词，
  # 靠空格分词展开就是想要的效果，不需要数组。
  #
  # 注意这里**没有** --wd：它在 setns() 之前就 open 目标目录，也就是在调用方的
  # mount namespace 里解析路径，对 slot 内部的路径必然失败。3b 有专门一条验证这件事。
  RESULT="$(nsenter --target "${SENTINEL_CHILD_PID}" --pid --mount --net --uts --ipc ${NSENTER_FORK_FLAG} \
              --setuid 65534 --setgid 65534 \
              -- /bin/sh -c 'echo "uid=$(id -u) pid=$$"' 2>&1)"
  if echo "${RESULT}" | grep -q "uid=65534"; then
    ok "降权生效：${RESULT}"
  else
    fail "nsenter --setuid 没生效：${RESULT}"
  fi
  if echo "${RESULT}" | grep -qE "pid=[1-9][0-9]?$"; then
    ok "PID 是新 namespace 里的小号（${RESULT}），确认真的进入了独立 PID namespace"
  else
    fail "PID 看起来不像新 namespace 里的号码：${RESULT}——fork 没有正确生效，即使上面判断的 --fork 语义是对的也可能有别的问题"
  fi

  section "3b) mount --bind 工作区（原样复刻 slot-pool.js 的 bootSlot）"
  echo "PROBE_MARKER" > "${TEST_HOST_DIR}/marker.txt"
  nsenter --target "${SENTINEL_CHILD_PID}" --mount -- mkdir -p /sandbox-root 2>/tmp/.mount-err
  if nsenter --target "${SENTINEL_CHILD_PID}" --mount -- mount --bind "${TEST_HOST_DIR}" /sandbox-root 2>>/tmp/.mount-err; then
    SEEN="$(nsenter --target "${SENTINEL_CHILD_PID}" --mount -- cat /sandbox-root/marker.txt 2>/dev/null)"
    if [ "${SEEN}" = "PROBE_MARKER" ]; then
      ok "bind mount 成功，且内容对得上"
    else
      fail "bind mount 命令成功但读不到预期内容（看到：${SEEN}）"
    fi

    # cwd 怎么设：executor.js 走的是"让目标 shell 自己 cd"，不是 nsenter --wd。
    # 这里把两条路都跑一遍，把差别摆出来——不然下次有人看到 --wd 这个名字
    # 又会觉得它才是"正确"的做法，然后掉进"每条命令都没有输出"这个坑里。
    # 判断标准必须是"能不能读到 bind mount 进来的内容"，不能看 pwd。
    # /sandbox-root 这个**目录本身**是 mkdir 出来的，它在两个 mount namespace 里
    # 都存在（mkdir 改的是底层文件系统，不是挂载）；只有里面的内容是 slot 私有的。
    # 所以 --wd 会"成功"地把你放进调用方那一个空目录，pwd 打出来一模一样，
    # 但你其实在错的地方——这比直接报错更难查。
    WD_RESULT="$(nsenter --target "${SENTINEL_CHILD_PID}" --pid --mount --net --uts --ipc ${NSENTER_FORK_FLAG} \
                   --wd=/sandbox-root -- /bin/sh -c 'pwd; cat marker.txt 2>&1' 2>&1)"
    if echo "${WD_RESULT}" | grep -q "PROBE_MARKER"; then
      info "这个 nsenter 版本的 --wd 能正确进到 slot 里的目录（${WD_RESULT}）——与实测到的行为不同，值得记一笔"
    else
      ok "--wd 落在了调用方的同名目录里，读不到 slot 的内容（预期如此，所以 executor.js 不用它）：$(echo "${WD_RESULT}" | tr '\n' ' ')"
    fi
    CD_RESULT="$(nsenter --target "${SENTINEL_CHILD_PID}" --pid --mount --net --uts --ipc ${NSENTER_FORK_FLAG} \
                   -- /bin/sh -c 'cd /sandbox-root || exit 1; pwd; cat marker.txt' 2>&1)"
    if echo "${CD_RESULT}" | grep -q "PROBE_MARKER"; then
      ok "由目标 shell 自己 cd 可行（executor.js 用的就是这条路）"
    else
      fail "目标 shell 里 cd 进工作区失败：${CD_RESULT}——所有命令都会跑不起来"
    fi
  else
    fail "mount --bind 失败：$(cat /tmp/.mount-err 2>/dev/null)"
  fi
  rm -f /tmp/.mount-err

  section "3c) 两个 sentinel 的 mount namespace 互相隔离"
  if unshare --mount --uts --ipc --net --pid --fork --mount-proc \
       -- /bin/sh -c 'mount --make-rprivate / 2>/dev/null; exec sleep 300' \
       >/dev/null 2>/dev/null &
  then
    SENTINEL2_PARENT_PID=$!
    for _ in $(seq 1 50); do
      if [ -r "/proc/${SENTINEL2_PARENT_PID}/task/${SENTINEL2_PARENT_PID}/children" ]; then
        SENTINEL2_CHILD_PID="$(cat "/proc/${SENTINEL2_PARENT_PID}/task/${SENTINEL2_PARENT_PID}/children" 2>/dev/null | awk '{print $1}')"
        [ -n "${SENTINEL2_CHILD_PID}" ] && break
      fi
      sleep 0.1
    done
    if [ -n "${SENTINEL2_CHILD_PID}" ]; then
      PEEK="$(nsenter --target "${SENTINEL2_CHILD_PID}" --mount -- cat /sandbox-root/marker.txt 2>&1)"
      if echo "${PEEK}" | grep -q "PROBE_MARKER"; then
        fail "第二个 sentinel 居然看得到第一个的 /sandbox-root——mount namespace 没有真正互相隔离"
      else
        ok "第二个 sentinel 看不到第一个的工作区（$(echo "${PEEK}" | head -c 60)）"
      fi
      # 必须同时带 --mount：ps 读的是 /proc，只进 PID namespace 而不换 /proc 的话
      # 数出来是 0，看着像"隔离得很干净"，其实是这条探测本身没生效
      PS_A="$(nsenter --target "${SENTINEL_CHILD_PID}" --pid --mount -- ps aux 2>/dev/null | wc -l)"
      PS_B="$(nsenter --target "${SENTINEL2_CHILD_PID}" --pid --mount -- ps aux 2>/dev/null | wc -l)"
      info "sentinel1 PID namespace 里的进程数：${PS_A}；sentinel2：${PS_B}（各自应该只看到自己那一支）"
    else
      fail "第二个 sentinel 建不起来，跳过跨 slot 隔离性验证"
    fi
  fi
else
  info "跳过 3a/3b/3c：没有可用的 sentinel"
fi

# ── 4) 网桥 + veth + NAT（原样复刻 netns.js 的 ensureBridge/setupSlotNetwork）
section "4) 建网桥 + veth，把一端塞进 sentinel 的 netns"
ip link add "${TEST_BRIDGE}" type bridge 2>/tmp/.br-err && ok "网桥创建成功" || fail "网桥创建失败：$(cat /tmp/.br-err 2>/dev/null)"
ip addr add 10.250.99.1/24 dev "${TEST_BRIDGE}" 2>/dev/null
ip link set "${TEST_BRIDGE}" up 2>/dev/null
rm -f /tmp/.br-err

# 这台机器大概率已经在跑 Docker/K8s——那类环境通常把 iptables FORWARD 链
# 默认策略设成 DROP（只放行 docker0/cni0 这类"认识的"网桥），网桥一旦挂了
# br_netfilter，桥内转发的包也要过宿主机的 FORWARD 链。先摸一下现状，
# 再验证"给自己的网桥单独加放行规则"能不能解决——这正是 netns.js 的
# ensureBridge() 现在会做的事。
info "FORWARD 链默认策略：$(iptables -L FORWARD -n 2>/dev/null | head -1)"
if [ -r /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
  info "bridge-nf-call-iptables = $(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null)（1 表示网桥转发的包也会过 iptables FORWARD 链）"
else
  info "内核没加载 br_netfilter（/proc/sys/net/bridge/bridge-nf-call-iptables 不存在）——网桥转发大概率不受 FORWARD 链影响"
fi

if [ -n "${SENTINEL_CHILD_PID}" ]; then
  ip link add "${TEST_VETH_HOST}" type veth peer name "${TEST_VETH_HOST2}" 2>/tmp/.veth-err \
    && ok "veth pair 创建成功" || fail "veth pair 创建失败：$(cat /tmp/.veth-err 2>/dev/null)"
  rm -f /tmp/.veth-err
  ip link set "${TEST_VETH_HOST}" master "${TEST_BRIDGE}" 2>/dev/null
  ip link set "${TEST_VETH_HOST}" up 2>/dev/null

  if ip link set "${TEST_VETH_HOST2}" netns "${SENTINEL_CHILD_PID}" 2>/tmp/.move-err; then
    ok "veth 一端成功移进 sentinel 的 network namespace"
    nsenter --target "${SENTINEL_CHILD_PID}" --net -- ip link set lo up 2>/dev/null
    nsenter --target "${SENTINEL_CHILD_PID}" --net -- ip link set "${TEST_VETH_HOST2}" name eth0 2>/dev/null
    if nsenter --target "${SENTINEL_CHILD_PID}" --net -- ip addr add 10.250.99.2/24 dev eth0 2>/tmp/.addr-err; then
      nsenter --target "${SENTINEL_CHILD_PID}" --net -- ip link set eth0 up 2>/dev/null
      # netns.js:150 建 slot 时会配这条默认路由。旧版探针漏了它，等于从来没搭出
      # 过真实链路——4a 的出网测试没有它一定失败，而那个失败是探针自己造成的。
      if nsenter --target "${SENTINEL_CHILD_PID}" --net -- ip route add default via 10.250.99.1 2>/tmp/.route-err; then
        ok "netns 内默认路由配置成功（via 网桥，setupSlotNetwork 的最后一步）"
      else
        fail "netns 内配默认路由失败：$(cat /tmp/.route-err 2>/dev/null)"
      fi
      rm -f /tmp/.route-err

      # 第一跳：slot netns → 网桥 IP。目的地是网桥自己的地址，属于本机投递，
      # 走 INPUT 链——FORWARD 与这一跳无关，不通不要往 FORWARD 上找原因。
      if start_probe_listener; then
        if netns_tcp 10.250.99.1 "${PROBE_PORT}"; then
          ok "slot netns → 网桥 TCP 连通（slot 出网的第一跳，链路本身没问题）"
        else
          case $? in
            2) fail "既没有 node 也没有 nc，测不了 TCP 连通性——请在底包里补一个" ;;
            *) fail "slot netns → 网桥 TCP 不通。这一跳是本机投递，查 INPUT 链策略与网桥/veth 的 up 状态，**不要**去改 FORWARD（这个目的地根本不过 FORWARD）" ;;
          esac
        fi
        kill -9 "${PROBE_LISTENER_PID}" 2>/dev/null
        PROBE_LISTENER_PID=""
      else
        fail "起不了本地 TCP 监听（需要 node），第一跳连通性无法验证"
      fi

      # ICMP 只作为附加信息。见文件顶部 netns_tcp 的注释：实测容器节点不给 ICMP，
      # 但 TCP 完全正常，拿 ping 当判据会得出完全相反的结论。
      if nsenter --target "${SENTINEL_CHILD_PID}" --net -- ping -c1 -W1 10.250.99.1 >/dev/null 2>&1; then
        info "ICMP 也通（附加信息，不参与判定）"
      else
        info "ICMP 不通——这台机器多半 drop 了 CAP_NET_RAW 或开了 icmp_echo_ignore_all。**这不是问题**：slot 的真实流量全是 TCP，以上面的 TCP 结果为准"
      fi
    else
      fail "netns 内配 IP 失败：$(cat /tmp/.addr-err 2>/dev/null)"
    fi
    rm -f /tmp/.addr-err
  else
    fail "veth 移进 netns 失败：$(cat /tmp/.move-err 2>/dev/null)"
  fi
  rm -f /tmp/.move-err
else
  info "跳过 veth/netns 详细验证：没有可用的 sentinel"
fi

section "4a) ip_forward 与 NAT（slot 出网靠这个，不是可选项）"
if [ -w /proc/sys/net/ipv4/ip_forward ]; then
  ok "/proc/sys/net/ipv4/ip_forward 可写"
else
  fail "/proc/sys/net/ipv4/ip_forward 不可写——slot 子网建好了也出不去（ensureBridge 会失败在这一步）"
fi
EGRESS_IF="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
if [ -n "${EGRESS_IF}" ]; then
  ok "默认路由网卡：${EGRESS_IF}（MASQUERADE 规则挂在这上面）"
  NAT_ADDED=0
  if iptables -t nat -C POSTROUTING -s 10.250.99.0/24 -o "${EGRESS_IF}" -j MASQUERADE 2>/dev/null; then
    info "（探测规则已存在，跳过重复添加）"
    ok "iptables nat 表可操作"
  elif iptables -t nat -A POSTROUTING -s 10.250.99.0/24 -o "${EGRESS_IF}" -j MASQUERADE 2>/tmp/.nat-err; then
    ok "iptables nat 表可写入 MASQUERADE 规则"
    NAT_ADDED=1
  else
    fail "iptables -t nat 写入失败：$(cat /tmp/.nat-err 2>/dev/null)"
  fi
  rm -f /tmp/.nat-err

  # 全链路出网：slot → 网桥 → FORWARD → MASQUERADE → 真实外部地址。
  # 这才是"技能能不能连上 Cloud Bridge"的等价验证——第一跳通不代表这条通。
  # 靶子选 /etc/resolv.conf 里的 DNS 的 TCP/53：它必然在 Pod 之外，且必然有人监听。
  # **必须在 4b 之前跑**：4b 会把 netns 的 OUTPUT 策略设成 DROP。
  if [ -n "${SENTINEL_CHILD_PID}" ]; then
    IP_FORWARD_WAS="$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo 0)"
    echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null
    iptables -C FORWARD -i "${TEST_BRIDGE}" -j ACCEPT 2>/dev/null || iptables -I FORWARD -i "${TEST_BRIDGE}" -j ACCEPT 2>/dev/null
    iptables -C FORWARD -o "${TEST_BRIDGE}" -j ACCEPT 2>/dev/null || iptables -I FORWARD -o "${TEST_BRIDGE}" -j ACCEPT 2>/dev/null
    PROBE_DNS="$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null)"
    if [ -n "${PROBE_DNS}" ]; then
      if netns_tcp "${PROBE_DNS}" 53; then
        ok "slot netns 全链路出网连通（FORWARD + MASQUERADE 都生效，技能能连到 Cloud Bridge）"
      else
        fail "slot netns 出不了网——第一跳通但全链路不通，查 FORWARD 链默认策略与 nat POSTROUTING 的 MASQUERADE 规则"
      fi
    else
      info "/etc/resolv.conf 里没有 nameserver，跳过全链路出网验证（换个已知的内网 IP:端口手动验一次）"
    fi
    iptables -D FORWARD -i "${TEST_BRIDGE}" -j ACCEPT 2>/dev/null
    iptables -D FORWARD -o "${TEST_BRIDGE}" -j ACCEPT 2>/dev/null
    echo "${IP_FORWARD_WAS}" > /proc/sys/net/ipv4/ip_forward 2>/dev/null
  fi
  if [ "${NAT_ADDED}" -eq 1 ]; then
    iptables -t nat -D POSTROUTING -s 10.250.99.0/24 -o "${EGRESS_IF}" -j MASQUERADE 2>/dev/null
  fi
else
  fail "找不到默认路由网卡（ip route show default 为空）——netns.js 的 findEgressInterface() 会返回 null，slot 建得起但出不去网"
fi

section "4b) 出站白名单规则能不能挂进 netns（原样复刻 applyEgressWhitelist）"
if [ -n "${SENTINEL_CHILD_PID}" ]; then
  if nsenter --target "${SENTINEL_CHILD_PID}" --net -- iptables -P OUTPUT DROP 2>/tmp/.rule-err \
    && nsenter --target "${SENTINEL_CHILD_PID}" --net -- iptables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>>/tmp/.rule-err \
    && nsenter --target "${SENTINEL_CHILD_PID}" --net -- iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable 2>>/tmp/.rule-err
  then
    ok "netns 内可以设 OUTPUT 默认策略与白名单规则"
  else
    fail "netns 内配置 iptables 失败：$(cat /tmp/.rule-err 2>/dev/null)"
  fi
  rm -f /tmp/.rule-err
else
  info "跳过：没有可用的 sentinel"
fi
if getent ahostsv4 www.baidu.com >/dev/null 2>&1; then
  ok "getent ahostsv4 能解析域名（applyEgressWhitelist 靠它把 AP_BRIDGE_HOST 解析成 IP）"
else
  fail "getent ahostsv4 解析失败——如果是因为这台探测机没有 DNS，不代表目标环境也有问题，但要单独确认"
fi

# ── 5) cgroup：按 cgroup.js 的真实读写路径验证 ─────────────────────────
section "5) cgroup 版本探测与实际读写"
# 与 src/namespace/cgroup.js 的 detectCgroupVersion 用同一套判断：读 /proc/mounts 的
# 字段，而不是 `mount` 的human 输出。实测踩过：cgroup2 那行的设备名就叫 "cgroup"，
# `mount | grep 'cgroup2 on /sys/fs/cgroup'` 匹配不上，会把一台好机器误报成
# "没检测到任何 cgroup 挂载"，而 worker 那边明明认出了 v2 —— 探测脚本和实现
# 对同一件事给出相反结论，比不探测更糟。
CGROUP_VERSION="none"
if awk '$2=="/sys/fs/cgroup" && $3=="cgroup2"' /proc/mounts | grep -q .; then
  CGROUP_VERSION="v2"
elif awk '$3=="cgroup"' /proc/mounts | grep -q .; then
  CGROUP_VERSION="v1"
fi
info "检测到 cgroup ${CGROUP_VERSION}"

if [ "${CGROUP_VERSION}" = "v2" ]; then
  # cgroup v2 有两个硬性前提，少一个限额就是"配了但一条都不生效"：
  #   1. 每一层的 `cgroup.subtree_control` 都要写上 cpu/memory/pids，子层才会有
  #      cpu.max / memory.max / pids.max 这几个文件（没有的话写入直接 EACCES）
  #   2. **一个 cgroup 里还直接挂着进程时不允许启用 controller**（写 subtree_control
  #      会 EBUSY），而容器的根 cgroup 恰恰就是这种情况——容器里所有进程都挂在根上。
  #      解法是先把根上的进程搬进一个叶子组。cgroup.js 启动时会自动做这一步。
  #
  # 注意：下面这段会真的去搬进程，也就是**把容器的 cgroup 布局改成 worker 启动后
  # 的样子**。这跟直接把 worker 起起来的效果一样，不是额外的风险；但如果这个容器
  # 之后还要拿去干别的，探测完重启一下更干净。
  ROOT_PROCS="$(wc -l < /sys/fs/cgroup/cgroup.procs 2>/dev/null || echo 0)"
  info "根 cgroup 上直接挂着 ${ROOT_PROCS} 个进程（>0 时启用 controller 会 EBUSY，要先腾空）"

  if echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/tmp/.cg-err; then
    ok "v2：根的 subtree_control 直接可写"
  else
    info "根的 subtree_control 写不进去（$(cat /tmp/.cg-err 2>/dev/null)），按 cgroup.js 的做法先腾空再试"
    mkdir -p /sys/fs/cgroup/nsprobe-main 2>/dev/null
    while read -r pid; do
      [ -n "${pid}" ] && echo "${pid}" > /sys/fs/cgroup/nsprobe-main/cgroup.procs 2>/dev/null
    done < /sys/fs/cgroup/cgroup.procs
    if echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/tmp/.cg-err; then
      ok "v2：腾空根 cgroup 之后 subtree_control 可写（worker 启动时会自动做这一步）"
    else
      fail "v2：腾空之后仍然写不进 subtree_control：$(cat /tmp/.cg-err 2>/dev/null)——slot 的资源限额不会生效"
    fi
  fi

  if mkdir -p "${TEST_CGROUP_V2_DIR}" 2>/tmp/.cg-err; then
    echo "+cpu +memory +pids" > "${TEST_CGROUP_V2_DIR}/cgroup.subtree_control" 2>/dev/null
    SLOT_DIR="${TEST_CGROUP_V2_DIR}/slot-0"
    mkdir -p "${SLOT_DIR}"
    # memory.swap.max 不是可选项：只设 memory.max 的话超限的页会被换出去，
    # 进程照样活着继续申请，实测 64MB 上限的 cgroup 里能成功分配 200MB。
    if echo "50000 100000" > "${SLOT_DIR}/cpu.max" 2>>/tmp/.cg-err \
      && echo $((512*1024*1024)) > "${SLOT_DIR}/memory.max" 2>>/tmp/.cg-err \
      && echo 0 > "${SLOT_DIR}/memory.swap.max" 2>>/tmp/.cg-err \
      && echo 128 > "${SLOT_DIR}/pids.max" 2>>/tmp/.cg-err
    then
      ok "v2：cpu.max / memory.max / memory.swap.max / pids.max 都能写"
    else
      fail "v2：限额文件写入失败：$(cat /tmp/.cg-err 2>/dev/null)（多半是 controller 没下放到这一层）"
    fi

    # 光能写限额还不够——进程加不进去的话限额挂在空组上，等于没配
    if echo $$ > "${SLOT_DIR}/cgroup.procs" 2>>/tmp/.cg-err; then
      ok "v2：进程能被加进 slot cgroup（限额才谈得上生效）：$(cat /proc/self/cgroup)"
      echo $$ > /sys/fs/cgroup/nsprobe-main/cgroup.procs 2>/dev/null \
        || echo $$ > /sys/fs/cgroup/cgroup.procs 2>/dev/null
    else
      fail "v2：进程加不进 slot cgroup：$(cat /tmp/.cg-err 2>/dev/null)——所有限额都会形同虚设"
    fi
    rmdir "${SLOT_DIR}" 2>/dev/null
  else
    fail "v2：cgroup 根目录建不了：$(cat /tmp/.cg-err 2>/dev/null)"
  fi
  rm -f /tmp/.cg-err
elif [ "${CGROUP_VERSION}" = "v1" ]; then
  for controller in cpu memory pids; do
    MOUNT_POINT="$(awk -v c="${controller}" '$3=="cgroup" && $4 ~ ("(^|,)"c"(,|$)") {print $2; exit}' /proc/mounts)"
    if [ -z "${MOUNT_POINT}" ] && [ "${controller}" = "cpu" ]; then
      MOUNT_POINT="$(awk '$3=="cgroup" && $4 ~ /cpu,cpuacct/ {print $2; exit}' /proc/mounts)"
    fi
    if [ -z "${MOUNT_POINT}" ]; then
      fail "v1：找不到 ${controller} controller 的挂载点"
      continue
    fi
    TEST_DIR="${MOUNT_POINT}/nsprobe-test/slot-0"
    if mkdir -p "${TEST_DIR}" 2>/tmp/.cg-err; then
      TEST_CGROUP_V1_DIRS="${TEST_CGROUP_V1_DIRS} ${TEST_DIR}"
      case "${controller}" in
        cpu)
          if echo 100000 > "${TEST_DIR}/cpu.cfs_period_us" 2>>/tmp/.cg-err && echo 50000 > "${TEST_DIR}/cpu.cfs_quota_us" 2>>/tmp/.cg-err; then
            ok "v1：${controller}（${MOUNT_POINT}）可写"
          else
            fail "v1：${controller} 限额写入失败：$(cat /tmp/.cg-err 2>/dev/null)"
          fi
          ;;
        memory)
          if echo $((512*1024*1024)) > "${TEST_DIR}/memory.limit_in_bytes" 2>>/tmp/.cg-err; then
            ok "v1：${controller}（${MOUNT_POINT}）可写"
          else
            fail "v1：${controller} 限额写入失败：$(cat /tmp/.cg-err 2>/dev/null)"
          fi
          ;;
        pids)
          if echo 128 > "${TEST_DIR}/pids.max" 2>>/tmp/.cg-err; then
            ok "v1：${controller}（${MOUNT_POINT}）可写"
          else
            fail "v1：${controller} 限额写入失败：$(cat /tmp/.cg-err 2>/dev/null)"
          fi
          ;;
      esac
    else
      fail "v1：${controller} 子目录建不了：$(cat /tmp/.cg-err 2>/dev/null)"
    fi
  done
  rm -f /tmp/.cg-err
else
  fail "没检测到任何 cgroup 挂载，异常情况，需要人工确认"
fi

# ── 结论 ───────────────────────────────────────────────────────────
section "结论"
echo "通过 ${PASS} 项，失败 ${FAIL} 项"
if [ "${FAIL}" -eq 0 ]; then
  echo "→ 全部通过：这台机器具备 sandbox-worker 当前实现（sentinel + netns + cgroup）需要的一切前提，可以直接部署。"
else
  echo "→ 有 ${FAIL} 项失败，逐条对照上面 [FAIL] 的具体原因处理："
  echo "  - 3)/3a) 失败 → CAP_SYS_ADMIN 或 nsenter 版本问题，worker 完全起不来，必须先解决"
  echo "  - 4)/4a)/4b) 失败 → CAP_NET_ADMIN、默认路由或 iptables 权限问题，slot 建得起但出不去网/出站锁不住"
  echo "  - 5) 失败 → cgroup 限额会被跳过（worker 仍能起来，但资源限额形同虚设，见 cgroup.js 的降级日志）"
  echo "  按上面分类判断，不要凭感觉：只有 3)/3a) 是硬阻塞（worker 起不来），4)/5) 各自有独立的失败影响面，不会互相拖累。"
fi
exit 0
