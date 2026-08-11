# 沙盒执行协议（agent service ↔ sandbox worker）

两端共同的契约。改这里要同时改 `sandbox-worker/src/server.js` 与 `src/sandbox/client.js`，
并且两边的测试都要跟着改 —— 所以先想清楚再改。

## 为什么是「租约」而不是「一次 exec 一次请求」

技能不是一条命令跑完就结束的。典型形态是：

```
bash: python3 fetch.py > data.json     ← 第 1 次 exec
bash: python3 analyze.py data.json     ← 第 2 次 exec，要读上一次写的文件
```

如果两次 exec 经 K8s Service 轮询落到不同副本，第二次就找不到 `data.json`。
解决办法只有三条，我们选第三条：

| 方案 | 为什么不选 |
|---|---|
| 共享 RWX 卷 | 要申请存储资源（组织成本），且所有用户的工作区落在同一个卷上 |
| 会话亲和（Ingress sticky） | 依赖接入层配置，且 agent service 是内部调用，没有 Ingress |
| **租约 + 直连副本** ✅ | 无额外基础设施：先向 Service 要一个租约，副本在响应里回报**自己的地址**，之后直连它 |

**要状态亲和，就让持有状态的那一方把自己的地址报回来。**

## 时序

```
agent service                          sandbox worker（经 Service 负载均衡）
     │                                          │
     ├─ POST /v1/leases ───────────────────────>│ 占一个槽位，建工作区
     │<── {leaseId, workerBase, expiresAt} ─────┤ workerBase = 本副本的 pod 地址
     │                                          │
     ├─ POST {workerBase}/v1/leases/:id/exec ──>│ 直连本副本
     │<── NDJSON 流 ────────────────────────────┤
     │                                          │
     ├─ POST {workerBase}/v1/leases/:id/files ─>│ 上传文件进工作区
     ├─ GET  {workerBase}/v1/leases/:id/files ─>│ 取回产物
     │                                          │
     └─ DELETE {workerBase}/v1/leases/:id ─────>│ 杀进程组、抹工作区、放开槽位
```

租约有 idle TTL：agent service 崩了也不会把槽位永久占住，清扫器会回收。

> **协议对 worker 内部怎么实现槽位不关心。** 每个槽位背后是一个独立的 Linux
> namespace 集合（PID/mount/network/uts/ipc），release 时整体销毁重建而不是
> "杀进程+抹目录"（见 [README.md](README.md)「隔离：每个槽位独立的 namespace」）——
> 但这一切对 agent service 完全透明：请求/响应格式、`leaseId`/`workerBase` 语义
> 一个字节都没变，只是"这个 workerBase 背后到底是怎么保证隔离的"这件事变了。

## 鉴权

所有请求带 `Authorization: Bearer <SANDBOX_TOKEN>`，两端共享同一个密钥。
worker 只该被 agent service 访问，网络层另有 NetworkPolicy 兜底（见 k8s/）。

**被执行的命令拿不到这个 token** —— job 的环境变量是从零构造的，不继承 worker 进程的 env。

## 端点

### `POST /v1/leases`

请求：`{ runId, username, ttlMs?, egressAllow? }`

`egressAllow` 是**租约级出站放行**（`["host", "host:port"]`），只对这一个租约生效，
释放时随 slot 销毁重建一起消失。能申请的范围由节点的 `SANDBOX_EGRESS_LEASE_ALLOW`
划定（**默认空 = 一条也不能申请**），清单外的目标返回
`400 egress-not-permitted` 并把被拒项原样列出来。

主机名匹配是完全相同，不做后缀 —— `example.com` 若能匹配 `a.example.com` / `evil-example.com`，
清单就形同虚设。规则用 `iptables -I OUTPUT 1` **插到链首**：兜底 REJECT 是建 slot
时 `-A` 追加的最后一条，租约期再 `-A` 会落在它后面，规则挂上了却一个包也放不过去，
而 `iptables -S` 看起来完全正常。

响应 `200`：
```json
{ "leaseId": "lease_...", "workerBase": "http://10.1.2.3:8080",
  "expiresAt": 1730000000000, "hardExpiresAt": 1730014400000,
  "idleTimeoutMs": 600000, "slots": { "used": 1, "total": 1 } }
```
响应 `429`：槽位满。调用方应重试（会被 Service 分到别的副本）。

`idleTimeoutMs` 是滑动窗口，下发给调用方定保活节奏用，**不要在调用方硬编码**。

注册/心跳的响应可能带 `artifactHost`：对象存储的主机名，由管理端下发，
节点收到后自动加进所有 slot 的出站白名单（slot 重建后重新挂）。
**OSS 凭据不在节点侧** —— 沙盒向管理端换短期预签名 URL。

### `GET /v1/leases/:leaseId` / `POST /v1/leases/:leaseId/renew`

查询剩余时间 / 续期。响应含 `expiresAt`、`hardExpiresAt`、`remainingMs`、
`maxRemainingMs`、`execCount`、`running`，**不含 `leaseToken`**。
`renew` 可带 `{ extendMs }`，单次不超过 `LEASE_TTL_MS`，也推不过硬顶。

租约的到期时刻**随活动往后滑**：每个带凭据的租约内请求都会把它推后一个滑动窗口，
**正在跑的命令也算活动**（exec 是长连接，期间不会再有别的请求，否则一条 12 分钟的
`npm install` 会在第 10 分钟被自己的 idle 判定砍掉）。三个时限的关系：
`LEASE_IDLE_TIMEOUT_MS` ≤ `LEASE_TTL_MS` ≤ `LEASE_MAX_LIFETIME_MS`，配反了启动就报错。

续期接口存在的意义是覆盖"调用方明知接下来一段时间不会碰沙盒"的静默期
（模型长思考、本地跑不经沙盒的逻辑），那正是滑动窗口保不住的场景。

### `POST /v1/leases/:leaseId/park` / `POST /v1/leases/:leaseId/attach`

租约的第三种结局：**驻留**。释放不是删文件，是整个 slot 销毁重建 —— 浏览器登录态、
已装的依赖、后台进程全没。对一次性脚本无所谓，对连续型任务等于每轮从头再来。
park 让 slot 活到下一轮，attach 把它接回来。设计见 `docs/SANDBOX-LIFECYCLE.md`。

```
park   请求 { reason? }  →  200 { parked: true|false, expiresAt?, reason? }
attach 请求 { runId, username } →  200 { leaseId, leaseToken, workerBase, browser,
                                   idleTimeoutMs, features, maxRemainingMs, parked: false }
```

- **park 被拒也回 `200`**，用 `parked: false` 表达（配额满 / 快撞硬顶 /
  `MAX_PARKED_PER_USER=0`）。调用方的处理是**退回 `DELETE`**，那是正常分支不是错误；
  回 4xx 只会让它去重试一件不该重试的事。老版本节点没有这个路由，回的是路由级
  `404`，调用方同样退回释放 —— 滚动发布期间这是正常路径。
- park 会**中止本轮还在跑的命令**（与释放一致），但不碰 slot：浏览器不关、
  后台进程不杀、依赖不删。
- park 之后到期时刻**改用驻留窗口**（`LEASE_PARK_TTL_MS`，比 idle 短），
  驻留期间的零星请求与显式 `renew` 都封在这个窗口里，推不过硬顶。
  超时回收的日志 `reason` 是 `parked-idle`，与 `idle`、`max-lifetime` 分开。
- attach 要求租约**正处于驻留状态**：不在驻留 = 另一个 run 正用着它，回 `409`
  （同一用户允许并发两个 run，两个 run 进同一个 BrowserContext 会互相导航）。
  `username` 对不上回 `403`。租约已被回收回 `404`。
- **attach 会轮换 `leaseToken`**，旧的立刻失效。所以 attach **不可重试**：
  重试用的是作废的凭据，而第一次可能其实已经成功了。
- `browser` 字段告诉调用方浏览器上下文还开着 —— 它必须把这件事讲给模型听，
  否则模型会照着"全新沙盒"的默认假设重新登录一遍，驻留的代价就白付了。

**池子满时驻留租约会被抢占**（`acquire` 里按 `parkedAt` 顶掉最老的，
`LEASE_PARK_GRACE_MS` 内的除外，回收 `reason` 是 `preempted`）。
这条是驻留能开着的前提：没有它，一个在等用户回来的 slot 会让真正要干活的人排队。
驻留中的租约照常计入 `leaseUsers` 配额与 `slots.used`，心跳与 `/healthz` 另报一个
`parkedLeases`，占用表按 `parked` / `parkedAt` 标出来。

### `POST /v1/leases/:leaseId/exec`

请求：
```json
{ "command": "python3 x.py", "cwd": "sub/dir", "env": { "FOO": "1" }, "timeoutMs": 120000 }
```

- `cwd` **必须是相对路径**，相对于工作区根。绝对路径会被拒 —— agent 侧的绝对路径在 worker 里没有意义。
- `env` 是**追加**到基础环境上的键值对，键名受白名单约束（见下）。

响应：`200` + `application/x-ndjson`，每行一个帧：

```json
{"type":"stdout","data":"..."}
{"type":"stderr","data":"..."}
{"type":"exit","exitCode":0,"signal":null,"truncated":false,"durationMs":812}
```

失败时最后一帧是 `{"type":"error","message":"...","code":"TIMEOUT"}`。
**流已经开始后不能再改 HTTP 状态码**，所以执行期的错误一律走 `error` 帧，不是 5xx。

### 异步执行：`POST /v1/leases/:leaseId/exec` + `"async": true`

回 `{ execId, startedAt }`，命令在后台跑。之后：

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/leases/:leaseId/execs` | GET | 列出本租约的任务 |
| `/v1/leases/:leaseId/execs/:execId` | GET | 状态与 `lastSeq` |
| `/v1/leases/:leaseId/execs/:execId/events` | GET | 事件流，`?fromSeq=N` 续传 |
| `/v1/leases/:leaseId/execs/:execId` | DELETE | **放弃**（这才杀命令） |

事件流仍是 NDJSON，每帧多一个单调递增的 `seq`；另有不占 seq 的 `heartbeat` 帧
（间隔 `?heartbeatMs=`，1000–60000，缺省 15000），用来区分"命令在安静地跑"
和"连接半开了"。`Last-Event-ID` 请求头与 `fromSeq` 等价。

**断开 ≠ 放弃。** 断开事件流什么也不做，命令继续跑，输出攒在缓冲区里等人回来取。
同步模式保持原样（断开即杀）—— 那条路径下调用方本来就在等响应。

两个容易写错的地方：

1. **流正常结束不等于命令跑完了。** 代理优雅关闭连接时，调用方看到的与命令结束
   一模一样，判据只有"收没收到 `exit` 帧"。
2. 输出能全留在内存里，是因为 `EXEC_MAX_OUTPUT_BYTES` 已经把单任务的帧总量封死了，
   所以续传不需要环形缓冲，也没有"要的那段被冲掉了"这条分支。已结束任务按
   `EXEC_RETAIN_JOBS`（缺省 8）保留，正在跑的永远不淘汰。

### `POST /v1/leases/:leaseId/browser/:action`

浏览器沙盒。动作与桌面端 `/tools/workstation.*` 同名同义 ——
`open` · `navigate` · `snapshot` · `screenshot` · `content` · `evaluate` · `act` · `network` · `network.clear` · `close`。

响应 `{ ok: true, action, ...结果 }`；动作层面的失败回 `{ ok: false, action, error }` 而**不是** 5xx：
ref 失效、元素找不到是浏览器自动化的常态，模型需要拿到真实原因去改策略，
把它变成 HTTP 错误只会让上层当成故障重试。

`open` / `navigate` 可带 `cookies`（Playwright cookie 数组）与 `userAgent`，
在首次调用时用来创建 BrowserContext。

> **凭据边界的唯一例外。** 浏览器自动化本质上要求浏览器**自己**持有登录态 ——
> 页面里的 XHR 走的是浏览器自己的网络栈，服务端代发替代不了。所以 cookie 会进到 worker。
> 换来的约束必须全部成立：只进 BrowserContext 内存、不落盘、随租约销毁、
> 只投白名单域（`BROWSER_COOKIE_DOMAINS`）、日志只记条数。
> agent 侧由 `src/tools/context.js` 统一注入，工具代码依然拿不到凭据。

### `POST /v1/leases/:leaseId/files`

请求：`{ "path": "data/in.csv", "contentBase64": "..." }` → `{ ok, path, bytes }`

### `GET /v1/leases/:leaseId/files?path=out.png`

响应：`{ ok, path, bytes, contentBase64 }`。超过 `MAX_FILE_BYTES` 返回 413。

路径一律相对工作区根，且解析后必须仍在根内（挡 `../` 逃逸）。

**软链接一律不跟随，包括指回工作区内部的。** 路径里任何一段是软链接都回 400
（`path 里有软链接…`）。这不是洁癖：这组接口跑在 **worker 进程（root）的宿主视角**下，
而工作区是 bind mount 进 slot 的 —— job 在自己工作区里 `ln -s / esc` 之后，
一个 `GET /files?path=esc/任意路径` 就是"以 root 读整台 worker"，同节点其他用户的
slot 工作区、`/proc/self/environ` 里的 SANDBOX_TOKEN 全在射程内。
实现见 [src/workspace-fs.js](src/workspace-fs.js)：从工作区根**逐段** `open(O_NOFOLLOW)`，
Linux 上每一段还通过 `/proc/self/fd/<父fd>/<名字>` 打开（openat 的等价物），
父目录的 inode 被 fd 钉住 —— 于是连"后台进程反复把目录换成软链接"的竞态也不成立。
`/healthz` 的 `pinnedWalk` 报告这一层在不在。

要跨目录取东西请在命令里做（`cp`/`tar` 走的是 slot 自己的 mount namespace 与 uid，
由内核判权限），不要指望文件接口替你穿过软链接。

### 工作区管理

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/leases/:id/files/list?path=&recursive=&includeHidden=` | GET | 列目录，回结构化条目 |
| `/v1/leases/:id/files/stat?path=` | GET | 类型 / 大小 / 修改时间 |
| `/v1/leases/:id/files/raw?path=` | GET | **裸流下载**，不经 base64 |
| `/v1/leases/:id/files/mkdir` | POST | `{ path }` |
| `/v1/leases/:id/files?path=&recursive=` | DELETE | 删文件或目录 |
| `/v1/leases/:id/files/batch` | POST | `{ files: [{ path, contentBase64 }] }` |
| `/v1/leases/:id/files/read` | POST | `{ paths: [...] }` |

五条不显然的语义：

- **写进去的东西属主是 job，不是 worker。** worker 以 root 跑、job 降权到 slot 专属
  uid 跑，`mkdir`/`writeFile` 默认造出 root 属主的文件与目录 —— job **读得到、
  执行得了，就是写不了**。于是"技能脚本往自己目录里写缓存""建 `skills/.venv`
  软链接"一律 EACCES，而 `ls`/`cat`/`python` 全都正常，症状极具迷惑性。
  所以接口新建的文件与目录都 chown 给 `slot.uid`（**只 chown 自己新建的那几层**，
  已存在的目录可能是 job 自己造的，属主本来就对）。
  `slot-pool.js` 建工作区时早就这么做了，接口这条路径从前漏了。
- 列目录**一定有上限**（`MAX_LIST_ENTRIES`，缺省 2000），到顶回 `truncated: true`。
  静默截断会让调用方以为看到了全部，而 `node_modules` 递归下来轻松十万条。
- 删目录**必须显式 `recursive=1`**；删工作区根一律拒绝（要全清就释放租约，
  那条路会把整个 slot 销毁重建）。
- 批量写是**全有或全无**：任何一条路径非法都整体拒绝，一个字节都不落盘。
  批量读则是**逐条**的，缺一个只让那一条 `ok: false`。
- `raw` 是流式的。base64 那条路要把整个文件在两端各变成三份内存
  （Buffer + base64 串 + JSON 串）。

### `DELETE /v1/leases/:leaseId`

销毁该租约绑定的 slot（整个 namespace 一起回收）、重建一个全新的 slot 供下次认领、释放槽位计数。幂等。

### `GET /healthz`

`{ ok, slots: { used, total }, leases: n, uptimeMs, namespace: { cgroupVersion, slots: [{ index, busy, uid, ip }] } }`。不要鉴权，给探针用。

## 环境变量白名单

job 的环境**从零构造**，不继承 worker 的 env（worker 的 env 里有 `SANDBOX_TOKEN`）。
基础环境由 worker 提供（`PATH` / `HOME` / `LANG` / `AP_NODE_BIN` / `AP_SKILL_LIBS_DIR` / …），
调用方追加的键必须匹配 `ENV_KEY_ALLOW`（默认 `^AP_[A-Z0-9_]+$`）。

理由：调用链上任何一环被诱导，都不该能往 job 里塞 `LD_PRELOAD`、`NODE_OPTIONS`、`PATH`
这类能改变执行语义的变量。

`JOB_PATH` 的默认值把 `/opt/ap/venv/bin` 排在**最前面**，这是必需的：底包故意只把
`requests` 装进那个 venv（不污染系统 python），而 `managed-skills/meeting/SKILL.md`
从头到尾写的都是 `python3 scripts/huiji_cli.py`。venv 不在 PATH 上，`python3` 就解析成
`/usr/bin/python3`，技能第一句就 `ModuleNotFoundError: No module named 'requests'`。
覆盖 `JOB_PATH` 时别把它漏掉。

## `HOME` 必须是 job 级的

`managed-skills/bot-send/scripts/message-store.mjs` 会往
`homedir()/…/chaoxing-workstation` 里写消息记录。若 `HOME` 是 worker 全局的，
A 用户写的消息记录会被 B 用户读到 —— 这是**真实存在的跨用户泄漏路径**，不是理论风险。

所以 `HOME` 指向工作区里的 `home/` 子目录，随租约一起抹掉。

## job 的 uid 在 `/etc/passwd` 里没有条目

每个 slot 的 job uid 是 `SANDBOX_NS_JOB_UID_BASE + slot 序号`（缺省从 20000 起），
**故意不建对应的系统账号** —— slot 数量是配置项，为它们预先 `useradd` 一批
会把镜像和 `SANDBOX_SLOTS` 绑死。内核只认数字 uid，隔离本身完全不依赖用户名。

后果是 uid→用户名的查询会失败：

```
$ whoami
whoami: cannot find name for user ID 20000     # 退出码 1
```

**这条是预期的，不影响隔离与执行**。实测（uid 20000、无 passwd 条目）：

| 调用 | 结果 |
| --- | --- |
| `id` / `id -u` | ✅ 正常，纯数字不需要查名字 |
| `$HOME`、Node `os.homedir()`、Python `os.path.expanduser("~")` | ✅ 正常，都优先读 `HOME`，而 worker 一定注入了它 |
| `whoami`、`logname` | ❌ 报错退出 1 |
| Node `os.userInfo()` | ❌ 抛 `ERR_SYSTEM_ERROR` |
| Python `getpass.getuser()` | ❌ 抛 `KeyError: getpwuid(): uid not found` |

后三行没有任何 `managed-skills` 用到，所以现状无影响。

**不打算靠注入 `USER`/`LOGNAME` 去"修"它**（那能让 `getpass.getuser()` 不抛，
但修不了 `whoami` 与 `os.userInfo()`，因为这两个一定走 `getpwuid`）。更要紧的是
方向不对：沙盒里的操作系统用户**本来就不是用户身份**。谁在用这个租约，唯一的真源
是服务端签发的 run 票据（`/tools/http.identity`）。注入一个看起来像模像样的 `USER`，
等于给技能作者递一个**会静默给出错误答案**的身份来源；让它响亮地失败反而是对的。

> ⚠️ `managed-skills/bot-send/SKILL.md` 的自测片段里有
> `--target "user:$(whoami)"`。那是**桌面端的写法**（进程就跑在本人账号下），
> 搬到云端沙盒必然不对：这里的 OS 用户是 slot uid，跟 username 没有任何关系 ——
> 就算 `/etc/passwd` 里有条目，拿到的也是 slot 的名字而不是谁在用。
> 那一行该改成从环境变量取 username。
