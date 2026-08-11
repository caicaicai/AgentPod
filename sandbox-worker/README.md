# AP沙盒 Worker

技能、模型生成的命令、以及浏览器自动化都在这里执行。
**固定实例池**，租约独占，跑完即抹。

- 协议：[PROTOCOL.md](PROTOCOL.md)（agent service 与 worker 的共同契约）
- 部署：标准 Docker 镜像 `sandbox-worker/Dockerfile`，
  **容器必须具备 `CAP_SYS_ADMIN` + `CAP_NET_ADMIN`（或 `--privileged`），不是加固项而是能不能跑起来的前提**

```bash
npm run dev      # ALLOW_ANONYMOUS=1，工作区在 ./.work；仍然需要 CAP_SYS_ADMIN/CAP_NET_ADMIN，
                 # 所以本地开发要在 Linux 容器/虚拟机里跑，macOS 直接跑不了
npm test         # 含真实 Chromium 的浏览器用例 + namespace 隔离用例
                 # （在不具备 CAP_SYS_ADMIN/CAP_NET_ADMIN 的机器上会跳过，
                 #   跳过会打印明确原因，不是静默通过）
bin/check-namespace-caps.sh   # 部署到新环境前必须先跑这个，确认前提条件都满足
```

## 两种沙盒，一个租约

| 能力 | 端点 | 用途 |
|---|---|---|
| 命令行 | `/v1/leases/:id/exec` | bash / python / node，技能脚本 |
| 浏览器 | `/v1/leases/:id/browser/:action` | 网页操作，`workstation_browser` 工具 |
| 文件 | `/v1/leases/:id/files` | 产物上下行 |

三者共享**同一个租约**，所以浏览器截的图可以被同一次 run 里的命令处理，
而不必先绕一圈传回 agent service。

## 为什么不是"每次执行起一个容器"

业界做沙盒的普遍结论是：**agent 循环里每轮新建沙盒，会把冷启动税收到每一次迭代上**
（E2B / Daytona 的核心 KPI 就是冷启动，主打 30–90ms 也仍然是税）。而我们更早还有一条约束：
不做动态资源编排 —— 那要跨部门协调配额与调度，会把项目周期拖进不确定性里。

所以形态是：**几个固定副本的普通 Deployment，像 CI runner 池**。
执行 = 在已经跑着的 pod 里 spawn 一个进程，冷启动为零；扩容 = 改 replicas。

## 隔离：每个槽位独立的 namespace

**只有一种隔离模式，没有按 uid+目录分离的旧模式可退。** 那种模式在 `SLOTS>1`
时隔离性名存实亡（所有并发 job 共用一个 uid、一个 PID/网络 namespace），
与其留一条容易被误用的退路，不如直接不留——逼着部署环境必须满足
namespace 隔离的前提条件（`CAP_SYS_ADMIN` + `CAP_NET_ADMIN`），
上线前用 `bin/check-namespace-caps.sh` 验证。

`SANDBOX_SLOTS=N` 时，worker 启动会预建 N 个 slot——每个 slot 拥有独立的
**PID / mount / network / uts / ipc namespace** + 独立 cgroup，`N` 就是这个
副本能同时安全服务的用户数。核心实现在 [`src/namespace/`](src/namespace/)：

| 文件 | 作用 |
|---|---|
| `sentinel.js` | 每个 slot 的"占位进程"：`unshare` 建好五种 namespace，`sleep infinity` 焊住不让内核回收 |
| `netns.js` | host 侧网桥 + 每 slot veth pair + netns 内的出站白名单（iptables） |
| `cgroup.js` | 按 slot 建 cgroup（v1/v2 自动探测），限 CPU/内存/进程数 |
| `slot-pool.js` | 编排以上三者：启动时预建 N 个 slot，acquire/release 只是认领/归还，release 时整体销毁重建 |

slot 在 worker 启动时就建好（保持"零冷启动"承诺，不是每次 exec 现建）：

| 维度 | 手段 |
|---|---|
| 用户之间 | 每个 slot 独立 PID/mount/network/uts/ipc namespace，`SLOTS>1` 时每个并发用户仍然各自独立——这是内核给的边界，不是排队排出来的 |
| 前后两个 job（同一个 slot 被下一个租约复用） | **整个 slot 销毁重建**：杀 sentinel，内核**强制**回收该 namespace 内的一切（进程、IPC 对象、网络状态），架构上不存在"忘了清"这个选项 |
| 网络出站 | 每个 slot 独立 network namespace + veth，白名单（**resolv.conf 里的 DNS + Cloud Bridge 的 host:port**）直接挂在这个 netns 的 `OUTPUT` 链上，不依赖 uid 匹配 |
| 资源限额 | 每 slot 独立 cgroup（v1/v2 自动探测）：`cpu.max`/`memory.max`/`pids.max`，一个用户吃满资源不拖垮其他并发用户 |
| 文件 | 每个 slot 的工作区 bind-mount 进它私有的 mount namespace，其他 slot 里这个路径根本不存在（不是"挡住"而是"看不见"） |
| `/tmp`、`/dev/shm` | 每个 slot 挂自己的 tmpfs。mount namespace 是**克隆**容器挂载表、不是 chroot，所以这两个 1777 目录默认是所有 slot 共享的——那是一条现成的跨 slot 通道，也是符号链接攻击面 |
| 浏览器 | 每个 slot 预热一个 Chromium 进程，常驻在该 slot 的 namespace 里，降权到 slot 的 uid |
| job 与 worker | job 降权到 slot 的专属 uid（`SANDBOX_NS_JOB_UID_BASE + slot 序号`），worker 以 root 跑，job 读不到 worker 的文件与内存 |

命令执行经 `nsenter --target <sentinelPid> --pid --mount --net --uts --ipc [--fork] --setuid <uid> --setgid <gid> -- <shell> -lc '<命令>'`
注入到目标 slot；`--setuid/--setgid` 必须是 nsenter 自己做（而不是 Node 的
`spawn({uid})`），否则降权发生在 `setns()` 之前，setns 需要的特权已经没了——
这个顺序坑详见 `executor.js` 里 `buildNsenterInvocation` 的注释。

**cwd 不能用 `nsenter --wd`。** 这个选项看名字像是为跨 namespace 设 cwd 准备的，
实际不是：它在 `setns()` **之前**就把目录 open 好，也就是在 worker 自己的 mount
namespace 里解析路径，而 `/sandbox-root/work` 只存在于 slot 的 mount namespace 里。
在特权容器里实测的结果是 `nsenter: cannot open /sandbox-root/work: No such file
or directory`——而且症状很有迷惑性：**不是明着报错，而是每一条命令都没有输出**。
所以 cwd 是作为 `cd <目录> || exit 1` 拼在 `shell -lc` 的命令串开头的，
由目标 namespace 里的 shell 自己完成。`test/sandbox.test.js` 里有用例守着
argv 里不会再出现 `--wd`。

`--fork` 打了方括号是因为**这个 flag 在 util-linux 版本之间语义不一致，不能硬编码**——
实测在生产节点上踩过：老版本要显式传 `--fork` 才会 fork（不 fork 就不会真正
成为新 PID namespace 的成员）；新版本带 `-p` 时默认就会 fork，`--fork` 反而是
"未识别的选项"，整条命令直接失败退出。[`namespace/nsenter-compat.js`](src/namespace/nsenter-compat.js)
在启动时探测 `nsenter --help` 决定要不要传，`executor.js`/`browser/index.js` 都走这一份判断。

网桥转发踩过一个坑：**在已经跑着 Docker/K8s 的机器上，veth/netns/IP 全配置成功，
slot 却连不出去**——那类机器通常把 `iptables FORWARD` 链默认策略设成 `DROP`，
只放行 `docker0`/`cni0` 这类"认识的"网桥，网桥一旦挂了 `br_netfilter`，
我们新建的网桥转发的包也要过这条链，不在白名单里就被丢了，且没有任何报错。
`ensureBridge()` 现在会显式给自己的网桥插入 `FORWARD` 放行规则
（`iptables -I FORWARD -i/-o <bridge> -j ACCEPT`），不能假设网桥转发默认就通。

**排查网络时不要用 `ping` 判断通不通**，这个坑代价很大：在生产节点上实测过一次
"slot 连网桥地址都 ping 不通"，据此一度判定平台不支持自建网桥、准备推翻整个
netns 方案；换成 TCP 复测后发现**第一跳和全链路出网都完全正常**，是那台机器不给
ICMP（`CAP_NET_RAW` 被 drop 或 `icmp_echo_ignore_all=1`）。slot 的真实流量全是 TCP，
ping 测的是产品一次都不会走的协议。另外要分清两条路径：`ping 网桥IP` 是**本机投递**
（走 `INPUT`），而 slot 出网走的是 `FORWARD` + `MASQUERADE`——前者不通时去调
`FORWARD` 规则是白费力气。`check-namespace-caps.sh` 现在两条路径分别用 TCP 判定，
ICMP 只作为附加信息打印。

### `HOME` 必须是 job 级的（真实的泄漏路径，不是理论风险）

`managed-skills/bot-send/scripts/message-store.mjs` 会往 `homedir()` 下写消息记录。
`HOME` 若是全局的，**A 用户发过的消息 B 用户就能读到**。
所以 `HOME` 指向 slot 工作区里的 `home/`，有用例守着这条。

### 出站锁定为什么是承重墙

没有它，Cloud Bridge 的出口白名单就是摆设 —— 技能不必经过桥，直接
`curl http://内网服务/...` 就行。桥能管住的只是"带凭据的请求"，管不住"目标本身不校验"的请求。

所以沙盒的出站**只允许 DNS 和 Bridge**。技能要访问任何内网系统只能经桥，
于是自然落进白名单 + 逐跳校验 + 审计。

没有 K8s NetworkPolicy 时，在容器内用每个 slot 独立的 network namespace + veth
来做（`src/namespace/netns.js`），白名单直接挂在该 netns 内部，不依赖 uid 匹配。
**这条规则配不上，slot 初始化就直接失败**——`slot-pool.js` 会让整个 `init()`
抛出异常，worker 直接启动不起来，而不是带着一个不完整的隔离边界跑起来。
悄悄降级比明着失败危险得多，所以上线前必须先跑 `bin/check-namespace-caps.sh`
把"拿不到权限"这件事提前到部署前发现。

> 某个技能确实需要直连某内网系统时，正确做法是**给桥的白名单加一条**，
> 不是在 iptables 上开口子。前者留下审计记录，后者什么都不留。

### 环境变量为什么可能"配了不生效"

worker 以 root 跑，但启动脚本被平台以 `admin` 调起，中间要过一次 sudo，
而 sudo 的 `env_reset` 会擦掉所有自定义变量。`bin/start.sh` 的做法是在 sudo
**之后**的 root shell 里把变量重新 `export`（不能用 `sudo --preserve-env`，
那条路依赖 sudoers 的 SETENV 标签，旧底包上会直接拒绝执行整条命令）。

这里从前是一份**白名单**，`config.js` 每加一个 `env.XXX` 就得同步加一行。
漏加的现象是"应用配置里明明配了，进程里读到的却是默认值"，而且毫无报错。
**这个坑踩了三次**（`PLAYWRIGHT_BROWSERS_PATH`、`SANDBOX_MANAGER_*` 一整个系列、
`SANDBOX_EGRESS_ALLOW`），所以现在改成**默认全传、只挡少数几个**。

挡掉的不是"敏感变量"（`SANDBOX_TOKEN` 这些恰恰必须传过去），而是两类会引发
**别的**故障的：

| 类别 | 变量 | 为什么 |
|---|---|---|
| 改变 shell / 链接器行为 | `LD_*`、`BASH_ENV`、`ENV`、`SHELLOPTS`、`BASHOPTS`、`IFS`、`PS*`、`BASH_FUNC_*` | 会影响 sudo 之后那个 shell 及其所有子进程（iptables / ip / nsenter…），几乎不可能是有意的应用配置，故障现象却完全不会让人联想到环境变量 |
| 该用 root 自己的值 | `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`PWD`、`OLDPWD`、`SHLVL`、`SUDO_*` | 尤其是 `PATH`：admin 的 `PATH` 常常没有 `/sbin` 与 `/usr/sbin`，而 worker 要调 iptables/ip，带过去会变成"命令找不到" |

`NODE_OPTIONS` 有意放行。启动日志里会打印**透传了哪些变量的名字**（绝不打值），
所以"配了没生效"现在可以直接从日志确认变量到没到。

### 沙盒里 `curl` 报 `Connection refused` 是白名单在生效

```
curl: (7) Failed to connect to xxx port 80 after 31 ms: Connection refused
```

这不是对端拒绝，是 slot netns 里最后那条兜底规则回的 ICMP port unreachable
（`netns.js` 的 `-j REJECT --reject-with icmp-port-unreachable`）。

几个可以自查的特征：

- **是 `Connection refused` 而不是超时。** 用 REJECT 而不是靠 `-P DROP` 兜底是
  有意的：DROP 会让连接一直挂到超时，技能表现为"卡住"，看不出是被墙了还是对端慢。
- **DNS 却是通的**（能解析出 IP 再连），因为白名单显式放行了 53 端口。
  所以"域名解析得出来但连不上"正是这道墙的典型现象。
- **在节点宿主机上 `curl` 同一个地址是通的** —— 规则只存在于每个 slot 自己的
  network namespace 里，宿主机不受影响。这条最容易让人以为是网络配置问题。

默认放行的只有两项：DNS，和 `AP_BRIDGE_HOST:AP_BRIDGE_PORT`。
**`AP_BRIDGE_HOST` 没配时，白名单里一个业务目标都没有** —— 出站锁得很成功，
但锁的是一扇没有门的墙。`/healthz` 的 `egress.bridgeConfigured` / `allowedBridgeIps`
就是为看出这种状态而存在的。

### 运维面：看占用 / 杀占用

```bash
curl -H "Authorization: Bearer $SANDBOX_TOKEN" localhost:8080/v1/admin/occupancy
curl -X DELETE -H "Authorization: Bearer $SANDBOX_TOKEN" localhost:8080/v1/admin/leases/<leaseId>
```

回的是**身份 + 形状**：谁（username）、哪一次 run、占了多久、几条命令在跑、
每条跑了多久产出多少字节、以及这个 slot 的 CPU/内存/进程数（读 cgroup）。
**没有命令原文，也没有输出内容** —— 那是用户数据，与本 worker 的日志遵守同一条
规矩。要知道"这个人到底在做什么"，拿 `runId` 去 agent 侧查那一次会话。

鉴权认两种：静态 `SANDBOX_TOKEN`（运维直连），或管理端签发的 `scp:"admin"` 票据
（管理台）。前者**有意不受 `SANDBOX_ACCEPT_STATIC_TOKEN` 约束** —— 那个开关管的是
"业务调用方还能不能拿长期凭据换租约"，把运维接口也捆上去，会让迁移完成的那一刻
排查手段一起失效。

强制释放不是"停掉命令"：它走的是正常的 release 路径，**整个 slot 销毁重建**。
那个用户这一轮在沙盒里产出的、还没同步回工作空间的东西会全部消失。

### 拦不拦、放行谁，由**管理端**说了算

接了 `SANDBOX_MANAGER_URL` 之后，出站策略跟着注册/心跳响应下发，**节点侧的
`SANDBOX_EGRESS_*` 全部失效**。改管理端上的一个环境变量，一个心跳周期内全集群
跟上，不用重启任何节点：

```bash
# 配在 manager 上
SANDBOX_EGRESS_MODE=allowlist          # allowlist(默认，拦) | open(不拦)
SANDBOX_EGRESS_ALLOW=api.example.com,internal.example.com:8080
SANDBOX_EGRESS_LEASE_ALLOW=oss.example.com:443
```

为什么这个开关必须在控制面：放在节点上就是 N 台机器 N 份配置，"到底哪几台
还开着拦截"没有单一答案，改错一台就是一个只在那台机器上成立的洞，而集群从
外面看一切正常。所以**生产环境的节点禁止写 `SANDBOX_EGRESS_MODE=open`**
（`config.js` 会拒绝启动），要关只能从管理端关。

节点侧的 `SANDBOX_EGRESS_*` 退化成两个作用：不接管理端的单机/本地部署；
以及接了管理端但**还没收到第一次下发之前**的启动默认值。那份默认值是"拦"，
所以管理端不可达时节点停在收紧的一侧。拿到过下发之后就**不会回退** ——
管理端抖一下不该让正在跑的技能集体断网。

两件事要分开看：

- **策略下发了** ≠ **全集群生效了**。正在被租用的 slot 是**刻意**不中途改的
  （会冲掉它自己申请的租约级放行），等租约释放、slot 重建时才换上。
  节点在心跳里回报 `egress.pendingSlots`，管理台的配置页会把还没跟上的节点点名。
- **`/healthz` 的 `namespace.egress.mode`** 是这台机器**此刻**的实际状态。
  排查"为什么连得上/连不上"先看这里，别看配置。

节点级的 `SANDBOX_EGRESS_ALLOW` 对**所有 slot 永远**生效。只有某类任务才需要的
域名，更好的做法是放进 `SANDBOX_EGRESS_LEASE_ALLOW`（准入清单）——
调用方申请租约时带 `egressAllow` 点它，只对那一个租约开，租约一释放就没了。
清单默认空，申请清单外的目标会被 400 挡回去并列出被拒项。
`SANDBOX_EGRESS_MODE=open` 时不按清单筛（那些地址本来就通着），
租约响应里的 `egressEnforced: false` 就是在说这件事。

对象存储的放行**不用配**：管理端在注册/心跳响应里下发 `artifactHost`，节点
自动挂上，slot 重建后也会重新挂（否则表现是"用了几次之后产物上传突然连不上"）。
OSS 的凭据与桶配置只在管理端，节点一概不碰。

**这是在承重墙上开门。** 出站白名单是整套凭据边界的基础：技能能拿到用户登录态，
只要它能连出去，凭据就能被带走。默认只有 DNS + Cloud Bridge 两个目标，
正是为了让"带不走"成为结构性保证而不是约定。加进去的每个域名都要问一句：
让沙盒里的任意代码都能连它，可以接受吗？

两条实际限制：

- **解析只在建 slot 时做一次。** 目标换 IP 之后白名单就过期了，worker 不重启不会
  自愈，表现是那个站点突然打不开。IP 经常变的目标（CDN、多活）不适合走这里。
- 放行的是**解析出来的 IP**，不是域名。同 IP 上的其他站点会一并放通。

放行了什么可以从 `/healthz` 的 `egress.extraAllowed` 看到，启动日志里也有一条 warn。

### playwright"装了却找不到"

底包用 `npm install -g playwright` 装，并设 `NODE_PATH=/usr/local/lib/node_modules`。
但 **`NODE_PATH` 只对 CommonJS 的 `require()` 生效，ESM 的 `import` 完全不看它** ——
而本项目是 `"type": "module"`。于是浏览器能力整块不可用，报的却是：

```
Cannot find package 'playwright' imported from /export/App/src/browser/index.js
Did you mean to import ".../node_modules/playwright/index.js"?
```

那句 `Did you mean` 指向的正是 `NODE_PATH` 里的路径 —— Node **找到了**这个包，
只是拒绝用它满足 ESM 导入。这就是"包明明装着却说找不到"的由来，
很容易被误判成底包没装成功，然后花时间去重建一个本来没问题的镜像。

两边都堵上了：

- **应用侧**：`src/browser/load-playwright.js` 先试 ESM，失败退到
  `createRequire`（playwright 本身是 CJS 包，走 CJS 解析链就认 `NODE_PATH`）。
  **不需要重建底包就生效。**
- **镜像侧**：`sandbox-worker/Dockerfile` 软链 `/node_modules/playwright`。
  `/node_modules` 是任意路径向上查找的最后一站，对 `/app` 下任何文件都有效。
  构建期还会按 ESM 语义 import 一次自检，
  装漏了让**构建**失败，而不是等到线上点浏览器才发现。

只软链 `playwright` 一个就够：Node 默认把软链解析成真实路径，从
`/usr/local/lib/node_modules/playwright/` 往上找正好命中同目录下的 `playwright-core`。

### 浏览器为什么能拿到 cookie

这是整套设计里凭据**唯一一次**离开 agent service。不是原则被妥协了，
而是浏览器自动化的本质要求：页面里的 XHR 走浏览器自己的网络栈，服务端代发替代不了。

换来的约束必须全部成立，缺一条这个例外就不该开：只进 BrowserContext 内存、
worker 不落盘、随租约销毁、只投白名单域（`BROWSER_COOKIE_DOMAINS`，默认 `.example.com`）、
日志只记条数。agent 侧由 `src/tools/context.js` 统一注入，**工具代码依然拿不到凭据**。

## 诚实的隔离边界

**这不是 microVM，也不是 gVisor。** 隔离强度依次是：

1. **用户之间**：靠 **PID/mount/network/uts/ipc namespace**，`SLOTS>1` 时每个并发用户仍然各自独立。这一层是内核给的。
2. **job 与 worker 之间**：job 降权到 slot 的专属 uid，worker 以 root 跑，job 读不到 worker 的文件与内存，也看不到 worker 进程本身（各自独立 PID namespace）。这一层也是内核给的。
3. **前后两个 job 之间（同一个 slot 被复用）**：靠销毁整个 namespace（杀 sentinel）——**内核强制回收**该 namespace 内的进程、IPC 对象、网络状态。这一层也是硬的，不是"杀进程+删目录"那种代码正确性层面的纪律。

不防的：**容器逃逸（宿主内核 0-day）、同容器内的侧信道、被 prompt injection 诱导去做它本来有权限做的事**——
这是同一个宿主内核带来的天花板，namespace 隔离只是把粒度从"整个容器"下沉到"每个 slot"，
并不改变"同一个内核"这个前提。需要防内核级逃逸就得上 gVisor / microVM，那是基础设施决策，
不是这个仓库能单独定的。

worker 以 root 运行是有意的取舍：不 root 就既无法建 namespace（`CAP_SYS_ADMIN`/`CAP_NET_ADMIN`
本质上也是特权）、也无法降权执行、也无法跨 uid 杀进程组。
沙盒类系统的常规形态就是**监督进程特权、被执行的负载无特权**。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `SANDBOX_TOKEN` | — | 与 agent service 共享。生产必填 |
| `SANDBOX_ADVERTISE_BASE` | — | 本副本地址，生产必填（K8s 用 pod IP） |
| `SANDBOX_SLOTS` | `1` | 预建的 slot 数量，也就是这个副本能同时安全服务的用户数 |
| `SANDBOX_WORK_ROOT` | `/var/tmp/ap-sandbox` | 必须是绝对路径 |
| `EXEC_MAX_OUTPUT_BYTES` | `1048576` | 超了截断。一条 `yes` 就能撑爆调用方 |
| `EXEC_MAX_FILE_SIZE_KB` | `524288` | `ulimit -f`。进程数上限交给 cgroup 的 `SANDBOX_NS_PIDS_MAX`，不再用 `ulimit -u` |
| `LEASE_IDLE_TIMEOUT_MS` | `600000` | 租约滑动窗口：最后一次活动之后还能活多久。agent 崩了不来释放时靠它兜底回收 |
| `LEASE_TTL_MS` | `1800000` | 一次续期最多买多久。**必须 ≥ 滑动窗口**，否则续期接口买不到比窗口更多的时间 |
| `LEASE_MAX_LIFETIME_MS` | `14400000` | 从创建算起的硬顶，续期推不过去。没有它，"活跃即续"等于"一直发请求就能永久占住一个 slot" |
| `LEASE_PARK_TTL_MS` | `600000` | **驻留**窗口：一轮结束后不释放、等下一轮 attach 回来的最长时间（见 PROTOCOL.md）。**必须 ≤ 滑动窗口** —— 没人在用的租约不该比正在用的活得久 |
| `LEASE_PARK_GRACE_MS` | `60000` | 抢占保护窗。池子满时最老的驻留租约会被顶掉，但刚驻留下来这段时间内不动它：用户按了发送就发现登录态没了，比不做驻留更难解释 |
| `MAX_PARKED_PER_USER` | `1` | 每人最多驻留几个租约。超了顶掉他**自己**最老的那个。设 `0` = 在本节点关闭驻留 |
| `EXEC_RETAIN_JOBS` | `8` | 每租约保留多少个**已结束**异步任务的输出，供断线的调用方回来取。内存上界 = 本值 × `EXEC_MAX_OUTPUT_BYTES` |
| `JOB_PATH` | `/opt/ap/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` | **技能脚本的 PATH**，与容器自己的 PATH 无关。`/opt/ap/venv/bin` 必须留在最前面：`requests` 只装在那个 venv 里，而技能写的是裸 `python3`，漏了就一律 `ModuleNotFoundError` |
| `MAX_FILE_BATCH` | `100` | 批量读写一次最多几个文件 |
| `MAX_LIST_ENTRIES` | `2000` | 列目录一次最多回多少条；到顶回 `truncated`，**不要忽略这个字段** |
| `AP_BRIDGE_HOST` / `AP_BRIDGE_PORT` | — / `8788` | slot 出站白名单里**唯一**的业务放行目标（另一项只有 DNS）。生产必填，缺了技能一律出不了网 |
| `BROWSER_ENABLED` | `1` | 关掉则不注册浏览器能力，agent 侧的 `workstation_browser` 也不会注册 |
| `BROWSER_COOKIE_DOMAINS`（agent 侧） | `.example.com` | 允许注入登录态的域白名单 |
| `ALLOW_ANONYMOUS` | `0` | 跳过 token 校验，仅本地开发；生产拒绝启动（namespace 隔离本身仍然需要，跳不过） |
| `SANDBOX_NS_JOB_UID_BASE` | `20000` | 每个 slot 的 job uid = 这个值 + slot 序号，每个 slot 独占一个 uid |
| `SANDBOX_NS_BRIDGE` | `sandbr0` | host 侧网桥名，所有 slot 的 veth 接在这上面 |
| `SANDBOX_NS_SUBNET` | `10.250.0.0/16` | 分给各 slot 的私有网段，与宿主/集群网段不冲突即可 |
| `SANDBOX_NS_CGROUP_ROOT` | `/sys/fs/cgroup/ap-sandbox` | cgroup v2 时的根路径；v1 会自动改用各 controller 的独立挂载点 |
| `SANDBOX_NS_CPU_MAX_CORES` | `1` | 单 slot CPU 上限（核） |
| `SANDBOX_NS_MEMORY_MAX_MB` | `1024` | 单 slot 内存上限，超了直接 OOM kill |
| `SANDBOX_NS_PIDS_MAX` | `256` | 单 slot 进程数上限，按 slot 而非按 uid 统计 |
| `SANDBOX_NS_TMPFS_SIZE_MB` | `512` | 每个 slot 私有 `/tmp` 的大小。占内存，但记在该 slot 的 memory cgroup 账上 |
| `SANDBOX_NS_SHM_SIZE_MB` | `64` | 每个 slot 私有 `/dev/shm` 的大小。Chromium 带了 `--disable-dev-shm-usage`，不用给大 |
| `SANDBOX_EGRESS_MODE` | `allowlist` | `allowlist`（拦）\| `open`（不拦）。**接了管理端之后本变量失效**，只是收到第一次下发之前的启动默认值。生产环境写 `open` 拒绝启动 —— 要关只能从管理端关 |
| `SANDBOX_EGRESS_ALLOW` | 空 | 额外放行的出站目标，`host` 或 `host:port` 逗号分隔，不写端口则放行 80+443。**每加一条都是在承重墙上开门**，见下。同样，接了管理端之后以下发为准 |
| `SANDBOX_EGRESS_LEASE_ALLOW` | 空 | 租约**可以申请**放行的清单（不是自动放行）。空 = 一条也不能申请。同样以管理端下发为准 |
| `BROWSER_INNER_SANDBOX` | `0` | slot 私有 Chromium 是否重新启用自己的沙盒（默认仍 `--no-sandbox`，需先实测嵌套兼容性） |

生产死线（`NODE_ENV=production` 不满足就退出码 2）：
必须有 `SANDBOX_TOKEN`、必须能确定 `SANDBOX_ADVERTISE_BASE`（可自动探测）、
必须有 `AP_BRIDGE_HOST`、禁止 `ALLOW_ANONYMOUS=1`、禁止 `SANDBOX_EGRESS_MODE=open`。

> `AP_BRIDGE_HOST` 是后补上的一条死线：它从前由 `netns.js` 直接读 `process.env`，
> 没配时只留一条 error 日志就继续跑——worker 起得来、`/healthz` 全绿、slot 列表正常，
> 但白名单里可用的目标是零，每个技能的网络请求都会失败。出站确实"锁"住了，
> 锁的却是一扇没有门的墙。`/healthz` 的 `namespace.egress` 现在会如实报告
> `bridgeConfigured` 与 `allowedBridgeIps`，"锁上了"和"还能用"是两回事。
另外，容器不具备 `CAP_SYS_ADMIN`/`CAP_NET_ADMIN` 时 `slotPool.init()` 会直接抛异常，
worker 启动失败退出——这不是校验规则，是 namespace 隔离的硬前提，参见下面的上线检查清单。

## 上线前必须实测的几件事

文档写了不等于生效，这些都要在目标环境上真跑一遍：

1. **先跑 `bin/check-namespace-caps.sh`**，确认 `CAP_SYS_ADMIN`/`CAP_NET_ADMIN`/cgroup 可写/`unshare`/`nsenter`/`ip`/`iptables` 全部具备——这不是可选的预检查，缺一项 worker 直接起不来。
2. **`npm test` 里牵涉真实 exec/浏览器的用例（`sandbox.test.js`/`browser.test.js`/`namespace-isolation.test.js`）**——本地/CI 大概率会跳过（打印跳过原因），只有在目标环境（或具备同等权限的机器）上跑才有意义，跑之前确认输出里**没有** `# SKIP`。
3. **出站锁定真的生效**：起一个租约，从 job 里验证：
   ```bash
   curl -m 3 https://www.baidu.com        # 必须失败
   curl -m 3 http://169.254.169.254/      # 必须失败（云元数据）
   curl -m 3 http://<某内网服务>/         # 必须失败
   curl -m 3 http://$AP_BRIDGE_HOST:8788/healthz   # 必须成功
   ```
   前三条只要有一条通，整套凭据边界就不成立，**不能放业务流量进来**。
4. **cgroup 限额真的生效**：起一个 slot，从内存里分配超过 `SANDBOX_NS_MEMORY_MAX_MB` 的数据，应该被 OOM kill 而不是拖垮整个节点。
5. **网络 NAT 通不通**：`ensureBridge` 会给 slot 子网配 MASQUERADE，如果找不到默认路由网卡（`ip route show default` 为空，常见于某些自定义网络插件的容器），slot 会变成能建但连不出去的孤岛——上线前实测 slot 内 `curl $AP_BRIDGE_HOST:8788/healthz` 必须成功。
6. **Chromium 真能起来。** 容器里缺字体、缺 `/dev/shm` 空间都会让它随机崩：
   ```bash
   curl -s localhost:8080/healthz | grep browser   # running 会在第一次用到时变 true
   ```
   还要确认 **playwright 能被 ESM 解析到**（这一条踩过）：
   ```bash
   mkdir -p /tmp/pw/a/b && cd /tmp/pw/a/b
   node --input-type=module -e 'const p = await import("playwright"); console.log(!!p.chromium)'
   ```
   报 `Cannot find package 'playwright'` 但底包明明装了，见下面那条。
   中文站点还要确认装了中文字体，否则截图全是方块。

## 技能资产从哪来

镜像里需要 `skill-libs`（`ap_http.mjs` / `.py` / `.sh`），现在从宿主仓库
`modules/ap/skill-libs/` 拷进来。本项目移出宿主仓库后要改成从制品库拉取 ——
它与 worker 代码的更新频率完全不同，不该绑在一次发布里。
