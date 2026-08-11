# 沙盒平台接口文档

沙盒是一项平台级能力：调用方通过标准接口向管理端申请，管理端按负载调度并签发短期凭据，
调用方拿凭据直连节点执行。本文覆盖三类调用者的**全部**接口。

| 你是谁 | 看哪几节 |
|---|---|
| 接入沙盒的业务方 | [认证模型](#1-认证模型)、[调度](#31-申请调度)、[节点接口](#5-节点接口) |
| 沙盒节点开发者 | [节点生命周期](#2-节点--管理端) |
| 运维 / 管理台 | [管理台接口](#4-管理台接口) |

---

## 0. 架构

```
                    ┌──────────────┐
   ①申请调度 ───────▶│   Manager    │  控制面：注册表、调度、签票据
   ②候选+票据 ◀──────└──────────────┘
                            ▲
调用方                       │ 注册 / 心跳
  │                         │
  │  ③票据换租约      ┌──────┴───────┐
  └─────────────────▶│  沙盒节点     │  数据面：执行、文件、浏览器
     ④执行/文件/浏览器 │ (sandbox-    │
                     │   worker)    │
                     └──────────────┘
```

**数据面不经过 Manager。** 执行流量在调用方与节点之间直连，Manager 只做控制面。
两个理由：一是命令输出是长连接流，穿一层代理会把管理端变成带宽瓶颈；
二是 Manager 挂掉时**已有的执行不受任何影响**，只是暂时申请不了新沙盒。

调度是**乐观**的：Manager 手里的容量是最多一个心跳周期之前的快照，真相在节点手里。
所以 `/schedule` 返回一组候选而不是一个，调用方撞上 `429` 就试下一个，重试在本地闭环。

---

## 1. 认证模型

系统里有四种凭据，用途和寿命各不相同。**不要混用。**

| 凭据 | 谁持有 | 寿命 | 能做什么 |
|---|---|---|---|
| 节点安全令牌 | 沙盒节点 | 长期 | 注册、心跳、注销 |
| 调用方安全令牌 | agent 等业务方 | 长期 | 申请调度（**不能**注册假节点） |
| 票据 ticket | 调用方，用完即弃 | 60 秒、一次性 | 在**指定的那一个节点**上换一个租约 |
| 租约凭据 leaseToken | 调用方 | 与租约同寿 | 操作**自己那一个**租约 |

安全令牌走请求头 `X-API-SecurityCode`，票据和租约凭据走 `Authorization: Bearer`。

管理台是第五种：走会话认证（JWT Bearer token），通过内置用户名密码登录获取。

### 为什么票据是一次性且绑定节点的

票据里签了 `nid`（目标节点）、`username`（调用方身份）、`exp`（60 秒）、`jti`（唯一 id）。
节点校验 HMAC → 未过期 → `nid` 是自己 → `jti` 没用过，四条缺一不可。

这样即使票据在传输中泄漏，攻击者拿到的也只是"60 秒内在某一台指定机器上开一个沙盒"，
而不是"随时在任意机器上执行任意命令"。

节点对外只回笼统的 `unauthorized`，真实原因（签名不对 / 过期 / 不是签给本节点 / 重放）
只进节点日志 —— 区分开会帮攻击者定位问题。

### 票据格式

```
base64url(payload).base64url(HMAC-SHA256(secret, base64url(payload)))
```

payload 字段：

| 字段 | 说明 |
|---|---|
| `nid` | 目标节点 id |
| `username` | 调用方身份，节点据此隔离会话数据 |
| `run` | runId，便于串联日志 |
| `exp` | 过期时间戳（毫秒） |
| `jti` | 唯一 id，节点用它防重放 |
| `scp` | **用途**。缺省（老管理端没这个字段）= `lease`（换租约）；`admin` 只能调节点的 `/v1/admin/*`（看占用、杀占用） |

`scp` 的两个值**互斥，不是包含关系**：管理台的"看和杀"凭据换不到租约 —— 否则一个
只读入口就顺带成了"在生产机器上执行代码"的入口；反过来调用方的租约凭据也调不了
运维接口，否则任何能申请到租约的人都能杀掉别人的租约。

---

## 2. 节点 → 管理端

节点启动时自注册，之后周期心跳。**管理端不可达不影响节点自身的服务能力** ——
已建立的租约照常执行，只是暂时不会被调度到。

### 2.1 注册

```http
POST /api/v1/sandbox/nodes/register
X-API-SecurityCode: <节点令牌>
Content-Type: application/json
```

```json
{
  "nodeId": "front-automation-executor-202-59447",
  "base": "http://192.168.200.101:8080",
  "pool": "default",
  "capacity": { "slots": 4 },
  "labels": { "zone": "lf09" },
  "caps": { "browser": true, "cgroup": "v1", "python": true },
  "version": "1.4.0",
  "ticketSecretFp": "a1b2c3d4"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `nodeId` | ✅ | 只能含字母、数字、点、下划线、连字符，≤128 字符。取 hostname（K8s 里是 pod 名） |
| `base` | ✅ | **调用方能访问到的地址**，必须是 `http(s)://` 绝对地址 |
| `capacity.slots` | ✅ | 并发槽位数，必须 > 0 |
| `pool` | | 资源池，缺省 `default` |
| `caps` | | 能力声明，调度按它筛选 |
| `ticketSecretFp` | | 票据密钥的 sha256 前 8 位（**不是密钥**），管理台用它排查密钥错配 |

响应：

```json
{ "ok": true, "nodeId": "...", "heartbeatIntervalMs": 10000, "staleAfterMs": 30000,
  "artifactHost": "s3.us-east-1.example.com",
  "egress": { "mode": "allowlist", "revision": "3f9a1c22",
              "allow": [{ "host": "a.example.com", "ports": [80, 443] }],
              "leaseAllow": [{ "host": "oss.example.com", "ports": [443] }] } }
```

`egress` 是**沙盒出站策略**，由管理端一处配置、随注册与心跳下发，节点收到后整体
覆盖自己的本地默认值。改管理端的环境变量，一个心跳周期内全集群跟上，不用重启节点。
详见 [5.10](#510-租约级出站放行)。

心跳间隔由管理端下发，**节点不要硬编码** —— 两边配置漂移会让节点被误判成死的。

> ⚠️ **刚注册的节点按满负载记**，要等第一次心跳才会被调度到。
> 反过来（默认全空闲）的话，一个 slot 池还没建完的节点会立刻被派进一堆请求。

### 2.2 心跳

```http
POST /api/v1/sandbox/nodes/heartbeat
X-API-SecurityCode: <节点令牌>
```

```json
{
  "nodeId": "...",
  "slots": { "used": 1, "total": 4 },
  "leases": 1,
  "healthy": true,
  "draining": false,
  "caps": { "browser": true, "cgroup": "v1" },
  "ticketSecretFp": "a1b2c3d4",
  "leaseUsers": { "alice": 2, "bob": 1 }
}
```

`leaseUsers` 是**按人**的当前租约数，管理端汇总后做单人并发配额。
真相只在节点手里 —— 管理端签出去的票据不一定被换成租约，租约何时释放它也不知道，
自己记数一定会越记越多。

- **心跳同时承担注册的续期。** 节点明细键有 TTL，不心跳就自动从注册表消失，
  不需要任何清理任务来判活。
- 可省略 `base`/`capacity`/`labels`，管理端会合并上一次注册的静态字段。
  但节点若发现自己的 `base` 变了（重新拿到 IP），应重新走注册。
- 返回 `409 not-registered` 表示明细键已过期（心跳断过 30 秒以上），**重新注册即可**，
  这不是错误。

### 2.3 注销

```http
POST /api/v1/sandbox/nodes/deregister
X-API-SecurityCode: <节点令牌>
```
```json
{ "nodeId": "..." }
```

不是必须的（不心跳 30 秒后自动消失），但优雅退出时调一下能让流量立刻切走。

---

## 3. 调用方 → 管理端

### 3.1 申请调度

```http
POST /api/v1/sandbox/schedule
X-API-SecurityCode: <调用方令牌>
```

```json
{ "runId": "run_01H...", "username": "alice", "pool": "default",
  "need": { "browser": true }, "limit": 3 }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `runId` | ✅ | 本次运行的 id |
| `username` | ✅ | 调用方身份，**会被签进票据**，节点据此隔离会话数据 |
| `pool` | | 资源池，缺省 `default` |
| `need` | | 能力要求。只检查显式写了 `true` 的项 |
| `limit` | | 候选数上限，1–10，缺省取管理端配置 |

响应：

```json
{
  "ok": true,
  "ticketTtlMs": 60000,
  "candidates": [
    { "nodeId": "sbx-a", "base": "http://10.0.0.1:8080", "ticket": "eyJ...", "free": 3 }
  ]
}
```

**每个候选带的是各自绑定的票据**，不能拿 A 的票据去 B 上用。
候选按空闲槽位降序，完全相同时随机打散 —— 不打散的话多个调用方在同一秒
会拿到同一份排序，一起冲向同一个节点，把负载均衡变成负载共振。

无可用节点时返回 `503 no-capacity`。

**单人并发配额**（`SANDBOX_MAX_LEASES_PER_USER`，缺省 `0` = 不限）：
同一用户在全集群持有的租约数达到上限时返回

```json
{ "ok": false, "error": "per-user-quota-exceeded",
  "message": "当前身份已占用 2 个沙盒，达到上限 2，请先释放" }
```

**是 429 不是 503。** 503 表示"整个池子没容量"，调用方该退避重试；
这里是"你自己占满了"，重试解决不了，得先把手里的放掉 —— 两者混用会让调用方空转。

依据是节点心跳里的 `leaseUsers`，跨节点求和（一个人的租约会散落在多个节点上，
只看单节点等于形同虚设）。**已知边界**：心跳最长滞后一个周期（默认 10 秒），
所以挡不住 10 秒内的突发，挡的是"持续占着不放"—— 而"一个失控的 agent 吃光池子"
本来就是持续状态。

### 3.2 查询集群

```http
GET /api/v1/sandbox/nodes?pool=default
X-API-SecurityCode: <调用方令牌>
```

返回集群汇总与节点列表。**有意不返回任何凭据字段。**

---

## 4. 管理台接口

`/api/v1/sandbox/ui/*` 是给浏览器用的，鉴权方式与上面几节**完全不同**：

| | `api.*` | `ui.*` |
|---|---|---|
| 调用者 | 服务端进程 | 浏览器 |
| 鉴权 | 安全令牌 | JWT 会话认证 |
| 凭据寿命 | 长期 | 会话级，可撤销、会过期 |
| 能追溯到人 | 否 | 是 |

分成两套的理由：浏览器要调 `api.*` 就得把安全令牌打进 JS bundle，
等于把一枚长期、能操作整个集群的凭据发给每个打开过页面的人。

**写操作另有一道闸门**：`SANDBOX_CONSOLE_ADMINS`（逗号分隔的用户名名单），
**留空时禁止所有写操作**。

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/ui/whoami` | GET | 登录 | 当前登录用户 + 是否有写权限 |
| `/ui/nodes` | GET | 登录 | 集群总览 + 节点列表 + 按池聚合 |
| `/ui/config` | GET | 登录 | 管理端配置 + 自检 + 密钥指纹比对 |
| `/ui/simulate` | POST | 登录 | 调度试算，**不签发票据** |
| `/ui/drain` | POST | 管理员 | 摘除 / 恢复节点 |
| `/ui/evict` | POST | 管理员 | 从注册表移除节点 |
| `/ui/occupancy` | GET | 登录 | 某个节点的槽位被谁占着、正在跑什么 |
| `/ui/kill` | POST | 管理员 | 强制释放指定租约，把槽位抢回来 |
| `/ui/sandbox/open` | POST | 管理员 + 开关 | 在指定节点开一个调试沙盒 |
| `/ui/sandbox/call` | POST | 管理员 + 开关 | 在调试沙盒里执行操作 |
| `/ui/sandbox/close` | POST | 管理员 + 开关 | 关闭调试沙盒 |

### 摘除与强制注销的区别

**摘除**（`/ui/drain`）= 不再被调度到，**已有租约继续跑完**。
下线机器的正确顺序是：摘除 → 等租约归零 → 关机。
摘除标记存在独立的存储里，不随心跳被冲掉、不随节点重启消失，只能手动恢复。

**强制注销**（`/ui/evict`）**不是下线手段**。节点只要还活着，下一次心跳会拿到
`409` 并立刻重新注册回来，净效果只是把负载读数重置一遍。它唯一有用的场景是
清理**已经死了但还没到 TTL** 的节点。

### 槽位占用与强制释放

`/ui/occupancy?nodeId=x` **按需向节点直接查**，不走心跳。三个理由：占用是秒级变化的，
隔一个心跳周期的数据不能作为"要不要杀"的依据；心跳数据会落进 Redis，那等于把每个
用户每次 run 的 username/runId 都持久化一份；而且这是打开抽屉才看的详情，没人看的时候
不该每 10 秒在全集群刷一遍。

每个占用给的是**身份 + 形状**：

```json
{ "slotIndex": 0, "leaseId": "lease_…", "username": "alice", "runId": "run_01H…",
  "ageMs": 92000, "idleMs": 1200, "execCount": 4, "running": 1, "browser": true,
  "execs": [{ "execId": "exe_…", "durationMs": 41000, "outputBytes": 18422 }],
  "resources": { "cpuUsageUsec": 37000000, "memoryBytes": 431423488, "pids": 23 } }
```

**没有命令原文，也没有输出内容。** 那是用户数据，与节点的日志遵守同一条规矩
（只记形状与长度）—— 管理台的管理员不是这个租约的用户。要知道"这个人到底在做什么"，
拿 `runId` 去 agent 侧查那一次会话（那里本来就按 username 隔离）。

而"该不该杀"恰恰只需要形状：跑了 8 分钟的 `npm install` 和跑 8 分钟的死循环，
命令原文帮不上忙，`idleMs` / `cpuUsageUsec` / `outputBytes` 才分得开。

`/ui/kill` 要管理员权限，与摘除节点同级 —— 而且**破坏得比摘除彻底**：节点侧的释放
是把整个 slot 销毁重建，那个用户这一轮在沙盒里产出的、还没同步回工作空间的东西
全部消失。杀一个已经不在的租约回 `killed:false` 而不是报错（运维要的结果是"槽位
空出来"，那已经达成）。

两者访问节点都用 `scp=admin` 的短期票据，**不是节点的 `SANDBOX_TOKEN`** ——
管理端不持有任何节点的长期凭据。

### 调试沙盒（`/ui/sandbox/*`）

管理台可以在指定节点上开一个沙盒，用来验证节点是否真的能干活。这条路径能执行代码，
因此比其他写操作多两道限制：

1. 需要 `SANDBOX_CONSOLE_EXEC=1`，**默认关闭**；
2. 需要在 `SANDBOX_CONSOLE_ADMINS` 名单里。

身份强制取自登录会话中的用户名，伪造不了。
**租约凭据全程留在管理端**（存于共享缓存），浏览器只拿到一个不透明的 `sessionId`，
且只有开启者本人能操作自己的会话。

```http
POST /api/v1/sandbox/ui/sandbox/open
```
```json
{ "nodeId": "sbx-a" }
```
```json
{ "ok": true, "sessionId": "...", "leaseId": "lease_...", "nodeId": "sbx-a",
  "base": "http://...", "expiresAt": 0 }
```

```http
POST /api/v1/sandbox/ui/sandbox/call
```
```json
{ "sessionId": "...", "op": "exec", "payload": { "command": "uname -a" } }
```

`op` 取值见下一节的节点接口，一一对应：
`exec`、`file.write`、`file.read`、`lease.status`、`lease.renew`、`browser.<动作>`。

> 页面会用 `lease.renew` **自动保活**：人对着一个 snapshot 看两分钟、或者去开个会，
> 租约就到 idle 被回收了。关掉标签页保活随之停止，槽位照常回收。
> 管理端这一份会话记录也在每次操作时续命，否则它会先于租约消失，
> 现象是"点着点着按钮就全报会话不存在"，而节点那边槽位还占着。

---

## 5. 节点接口

调用方拿到票据后直连节点。基址是调度返回的 `base`。

### 5.1 健康探针

```http
GET /healthz
```

**不鉴权**，也不泄露任何用户信息。

```json
{
  "ok": true,
  "slots": { "used": 1, "total": 4 },
  "leases": 1,
  "uptimeMs": 3600000,
  "browser": { "enabled": true, "running": true },
  "namespace": { "cgroupVersion": "v1", "slots": [...] }
}
```

### 5.2 申请租约

```http
POST /v1/leases
Authorization: Bearer <ticket>
```
```json
{ "runId": "run_01H...", "ttlMs": 600000, "egressAllow": ["oss.example.com:443"] }
```

- `egressAllow` 是**租约级出站放行**：只对这一个租约生效，租约释放时 slot
  整体销毁重建，规则跟着消失。见 [5.10](#510-租约级出站放行)。
- **`username` 不从请求体读**，从票据载荷读。请求体里带了且与票据不符返回
  `400 username-mismatch` —— 静默以票据为准会把调用方的 bug 藏到"会话数据串到别人名下"
  才暴露。

```json
{
  "ok": true,
  "leaseId": "lease_...",
  "leaseToken": "…48 hex…",
  "workerBase": "http://...",
  "expiresAt": 1785470000000,
  "hardExpiresAt": 1785484400000,
  "idleTimeoutMs": 600000,
  "features": { "execAsync": true, "leaseRenew": true },
  "slots": { "used": 2, "total": 4 }
}
```

`leaseToken` **只在这里返回这一次**。之后所有租约内操作都用它。

`idleTimeoutMs` 是滑动窗口长度，下发给调用方决定保活节奏用 —— 与心跳间隔同理，
**不要硬编码**。两边各存一份、其中一边改了配置，现象是租约在调用方眼里
"莫名其妙提前没了"，而两边日志都正常。

| 状态码 | 含义 | 调用方该怎么做 |
|---|---|---|
| `200` | 拿到租约 | 继续 |
| `401 unauthorized` | 票据无效 | 重新 `/schedule` |
| `429 no-free-slot` | 节点满了 | **换下一个候选** |

### 5.3 租约能活多久

三个时限，各回答一个不同的问题。**顺序不能乱：滑动窗口 ≤ 单次续期上限 ≤ 硬顶。**

| 时限 | 回答的问题 | 缺省 |
|---|---|---|
| `LEASE_IDLE_TIMEOUT_MS` | 调用方还在吗？（既没请求、也没有命令在跑） | 10 分钟 |
| `LEASE_TTL_MS` | 一次续期最多能买多久？ | 30 分钟 |
| `LEASE_MAX_LIFETIME_MS` | 一个租约最长能占多久？**续期推不过去** | 4 小时 |

到期时刻 **随活动往后滑**：

- 每一个带凭据的租约内请求都会把它往后推一个滑动窗口；
- **正在跑的命令也算活动** —— exec 是一条长连接请求，从发出到结束期间不会再有
  别的请求，一条 12 分钟的 `npm install` 否则会在第 10 分钟被自己的 idle 判定砍掉；
- 续期**不会把已经更晚的到期时刻往前缩**，所以显式续期不会被随后的普通请求抵消。

> ⚠️ 早期版本里 `expiresAt` 是**从创建那一刻算死的绝对墙**，一个正干着活的会话
> 会在第 30 分钟被回收，slot 销毁重建，工作区连同没取走的产物一起消失。
> 如果你在对接老节点，用 `GET /v1/leases/{leaseId}` 是否存在来判断。

### 5.4 查询与续期租约

```http
GET /v1/leases/{leaseId}
Authorization: Bearer <leaseToken>
```

```json
{
  "ok": true, "leaseId": "lease_...", "runId": "run_01H...", "username": "alice",
  "createdAt": 1785470000000, "expiresAt": 1785470600000, "hardExpiresAt": 1785484400000,
  "remainingMs": 600000, "maxRemainingMs": 14400000,
  "execCount": 3, "running": 0, "browser": true
}
```

**不返回 `leaseToken`** —— 它是执行权限本身。

```http
POST /v1/leases/{leaseId}/renew
Authorization: Bearer <leaseToken>
```
```json
{ "extendMs": 1800000 }
```

`extendMs` 可省略（取 `LEASE_TTL_MS`），单次买到的时间不超过 `LEASE_TTL_MS`，
且一样推不过硬顶。响应结构与上面的查询相同。

什么时候需要它：调用方**明知**接下来一段时间不会碰沙盒（模型在长思考、
或本地在跑不经沙盒的逻辑），那段静默期正好会撞上 idle 回收。

> 老节点没有这两个路由，返回的是路由级 `{"error":"not-found"}`，
> 而租约真的没了返回 `{"error":"lease-not-found-or-expired"}`。
> **滚动发布期间要区分这两者**，否则日志里会刷一片误导性的"租约被回收了"。

### 5.5 释放租约

```http
DELETE /v1/leases/{leaseId}
Authorization: Bearer <leaseToken>
```

**幂等**：租约不存在时也返回 `200 {"released": false}`，不泄漏"这个 id 存不存在"。

### 5.6 执行命令

```http
POST /v1/leases/{leaseId}/exec
Authorization: Bearer <leaseToken>
```
```json
{ "command": "ls -la", "cwd": "sub/dir", "env": { "FOO": "bar" }, "timeoutMs": 60000 }
```

响应是 **NDJSON 流**（`application/x-ndjson`），一行一帧：

```json
{"type":"stdout","data":"total 8\n"}
{"type":"stderr","data":"warning\n"}
{"type":"exit","exitCode":0,"signal":null,"truncated":false,"durationMs":42}
```

| 帧类型 | 字段 |
|---|---|
| `stdout` / `stderr` | `data` |
| `error` | `code`（`TIMEOUT` / `EXEC_FAILED` / …）、`message` |
| `exit` | `exitCode`、`signal`、`truncated`、`durationMs` |

> ⚠️ **流一旦开始就不能再改 HTTP 状态码。** 所以执行期间出的错走 `error` 帧，
> 而不是 5xx —— 否则调用方会看到"HTTP 200 + 半截输出 + 连接莫名断开"。

同步模式下客户端断开连接会**直接把命令杀掉** —— 调用方本来就在等这条响应，
连接没了就是没人要结果了。**要"断开不算放弃"请用下面的异步模式。**

命令运行在隔离环境里：独立的 PID / mount / network / uts / ipc 命名空间，
cgroup 限制 CPU、内存、进程数，出站流量按白名单锁定。

### 5.7 异步执行与断线续传

请求体加 `"async": true`，立刻拿到句柄，命令在节点上后台跑：

```json
{ "ok": true, "execId": "exe_a1b2c3d4e5f67890", "startedAt": 1785470000000 }
```

| 接口 | 方法 | 说明 |
|---|---|---|
| `/v1/leases/{leaseId}/execs` | GET | 列出本租约的任务 |
| `/v1/leases/{leaseId}/execs/{execId}` | GET | 任务状态与 `lastSeq` |
| `/v1/leases/{leaseId}/execs/{execId}/events` | GET | 事件流，**可续传** |
| `/v1/leases/{leaseId}/execs/{execId}` | DELETE | **放弃**（这才杀命令） |

事件流仍是 NDJSON，但每帧多一个单调递增的 `seq`：

```json
{"type":"stdout","data":"total 8\n","seq":1}
{"type":"heartbeat","at":1785470001000}
{"type":"exit","exitCode":0,"durationMs":42,"status":"completed","seq":2}
```

| 查询参数 / 头 | 说明 |
|---|---|
| `fromSeq` | 从这个 seq **之后**开始取。断线重连时传最后收到的 seq |
| `Last-Event-ID` | 同上，浏览器 `EventSource` 的习惯写法，两者认其一 |
| `heartbeatMs` | 心跳间隔，1000–60000，缺省 15000 |

`heartbeat` 帧**不占 seq**，也不进缓冲区 —— 它是传输层的事，用来区分
"命令在安静地跑"和"连接半开了"。

> **断开 ≠ 放弃。** 断开事件流什么也不会发生，命令继续跑，输出攒着等人回来取；
> 只有显式 `DELETE .../execs/{execId}` 才杀。这正是异步模式存在的理由：
> 切个标签页、网关掐一次空闲连接，一条跑了四分钟的 `npm install` 不该白跑，
> 何况它在工作区里留下的是**半装完的 node_modules**，比彻底没跑还糟。

> ⚠️ **流正常结束不等于命令跑完了。** 代理优雅关闭连接时，调用方看到的与
> "命令结束"一模一样。判据只有一个：**收没收到 `exit` 帧**。没收到就带着
> `fromSeq` 重连。

已结束任务的输出按 `EXEC_RETAIN_JOBS`（缺省 8 个）保留，供断线的调用方回来取；
超出后淘汰最早结束的，**正在跑的永远不淘汰**。被淘汰或从未存在的 `execId`
一律 `404 exec-not-found-or-evicted`。

调用方靠租约创建响应里的 `features.execAsync` 判断节点支不支持，
而不是"试一下看会不会 404" —— 后者在滚动发布期间会在正常路径上刷一片错误日志。

### 5.8 文件

**写入**

```http
POST /v1/leases/{leaseId}/files
Authorization: Bearer <leaseToken>
```
```json
{ "path": "data/input.csv", "contentBase64": "aGVsbG8=" }
```

**读取**

```http
GET /v1/leases/{leaseId}/files?path=out/result.json
Authorization: Bearer <leaseToken>
```
```json
{ "ok": true, "path": "...", "bytes": 128, "contentBase64": "..." }
```

`path` 必须是**相对工作区**的路径，绝对路径和 `../` 逃逸都会被拒。
超出大小上限返回 `413 file-too-large`。

**工作区管理**

| 接口 | 方法 | 说明 |
|---|---|---|
| `/files/list?path=&recursive=&includeHidden=` | GET | 列目录，回结构化条目 |
| `/files/stat?path=` | GET | 类型 / 大小 / 修改时间 |
| `/files/raw?path=` | GET | **裸流下载**，不经 base64 |
| `/files/mkdir` | POST | `{ path }`，递归建 |
| `/files?path=&recursive=` | DELETE | 删文件或目录 |
| `/files/batch` | POST | `{ files: [{ path, contentBase64 }] }` 批量写 |
| `/files/read` | POST | `{ paths: [...] }` 批量读 |

列目录的返回：

```json
{ "ok": true, "root": ".", "count": 2, "truncated": false,
  "items": [ { "path": "out/a.png", "name": "a.png", "kind": "file",
               "size": 10240, "mtimeMs": 1785470000000 } ] }
```

`kind` 取 `file` / `directory` / `symlink` / `other`。**symlink 单独标出来**：
它是逃逸面，调用方该知道自己碰到了什么。条目按名字排序，同一个目录两次列出来
结果稳定，可以直接做 diff。

几条容易踩的：

- **列目录一定有上限**（`MAX_LIST_ENTRIES`，缺省 2000）。`node_modules` 递归下来
  轻松十万条。到顶返回 `truncated: true` —— **不要忽略这个字段**，
  否则你会以为自己看到了全部。
- **删目录必须显式 `recursive=1`**，否则 `400 directory-needs-recursive`。
  默认递归的话一个手误就能删掉命令跑了十分钟的产物。
- **删不掉工作区根**（`400 cannot-delete-workspace-root`）。要"全清"请释放租约，
  那条路会把整个 slot 销毁重建。
- **批量写是全有或全无**：任何一条路径非法都整体拒绝，一个字节都不落盘。
  部分成功的工作区比整体失败难排查得多。
- **批量读是逐条的**：缺一个只让那一条 `ok: false`，其余照常返回 ——
  批量读常用来"把这几个可能存在的产物取回来"。

大产物用 `/files/raw`：base64 那条路要把整个文件在两端各变成三份内存
（Buffer + base64 串 + JSON 串），30 MB 的产物就是 90 MB。裸流是流式的，
带 `Content-Type`（认不出就是 `application/octet-stream`，不瞎猜）与
`Content-Disposition`。

### 5.10 租约级出站放行

沙盒的出站默认只放行两样：DNS 和 Cloud Bridge。要让某个租约（尤其是它的浏览器）
访问别的地址，申请租约时带上 `egressAllow`：

```json
{ "runId": "...", "egressAllow": ["oss.example.com:443", "internal.example.com"] }
```

不写端口按 80 + 443 放行（浏览器两个都要，只开 443 的话 http 站点是白页）。

**调用方不能想开什么就开什么。** 能申请的范围由节点的
`SANDBOX_EGRESS_LEASE_ALLOW` 划定，**默认空 = 一条也不能申请**。
申请清单之外的目标返回：

```json
{ "ok": false, "error": "egress-not-permitted", "rejected": ["evil.example.com:80/443"] }
```

被拒的项**原样报出来**而不是静默丢弃 —— 静默的话调用方会以为开了，
然后对着 `Connection refused` 一路往技能自己身上找原因。

| | `SANDBOX_EGRESS_ALLOW`（节点级） | `SANDBOX_EGRESS_LEASE_ALLOW`（准入清单） |
|---|---|---|
| 作用范围 | 所有 slot，**永远** | 只对申请了的那个租约 |
| 谁决定 | 运维改配置 + 重新发布 | 运维划范围，调用方按需点 |
| 何时消失 | 改配置重新发布 | 租约释放，slot 销毁重建 |

**准入清单其实比节点级更严**：一个只有某类任务才需要的域名，与其为它给全节点
常开一道门，不如放进清单让需要的租约自己申请。

主机名匹配是**完全相同**，不做通配、不做后缀 —— 若 `example.com` 能匹配
`evil-example.com` 或 `a.example.com`，这份清单就形同虚设，而写清单的人多半意识不到
自己开的是一整个后缀。

> ⚠️ 这仍然是在承重墙上开门。出站白名单是整套凭据边界的基础：技能拿得到用户
> 登录态，只要它能连出去，凭据就能被带走。每加一条都要问一句：
> 让沙盒里的**任意代码**都能连它，可以接受吗？

#### 总开关：拦还是不拦

以上都是"拦截模式"下的事。拦不拦本身由**管理端**的 `SANDBOX_EGRESS_MODE` 决定：

| 值 | 含义 |
|---|---|
| `allowlist`（默认） | 拦。只放行 DNS + Cloud Bridge + 上面两份清单 |
| `open` | 不拦。沙盒可访问节点本身能访问的任意网络目标 |

**只有明明白白写着 `open` 才放开** —— 缺字段、拼错、大小写不对一律按拦处理。
读不懂的输入必须往收紧那一侧倒：少放行是"站点打不开"，看得见、查得到；
多放行是"沙盒能连到本不该连的地方"，没有任何现象。

`open` 时不再按准入清单筛租约申请（那些地址本来就通着），租约响应里的
`egressEnforced: false` 就是在说这件事 —— 没有它，"申请了 `egressAllow` 却拿回
一个空的 `egress`"看起来和"申请被静默丢掉了"一模一样。

关掉拦截的代价要说清楚：**出站白名单是整套凭据边界的地基。** 沙盒里跑的是模型
生成的任意代码，它拿得到用户登录态，只要能连出去凭据就能被带走。所以这个开关
只配在管理端（一处生效、一处可审计），且**生产环境的节点禁止就地写 `open`**。
管理台的配置页会在关掉期间一直挂一条警告 —— 临时排障开的口子最常见的结局
就是忘了关。

租约详情（`GET /v1/leases/{leaseId}`）里的 `egress` 字段会回实际开了什么。

### 5.11 产物直传对象存储

沙盒里有个内置命令：

```bash
upload-to-oss outputs/report.pdf                    # 打印下载链接
upload-to-oss outputs/report.pdf --json | jq -r .downloadUrl
```

链路：

```
沙盒 ──①换地址──▶ Cloud Bridge ──②转发──▶ Manager ──签名──▶ (ctx.oss)
  └──────────────────③字节直传───────────────────────▶ 对象存储
```

**OSS 配置与凭据只在 Manager。** 三个理由：manager 后端原生提供 `ctx.oss`，签名由
平台实现（不必自己写 SigV4）；管理端本来就是控制面，票据密钥、注册表都在那儿；
凭据的持有者越少越好 —— agent 与节点都不碰 AK/SK。

沙盒够不到管理端（它的出站白名单里只有 DNS、Cloud Bridge 和对象存储本身），
所以由桥代转一次。**字节不经过 agent**，大产物不会吃掉它的内存和带宽。

沙盒拿到的只是：

| | 有效范围 | 寿命 |
|---|---|---|
| `uploadUrl` | **单个 object key**，只能 PUT | 15 分钟 |
| `downloadUrl` | 同一个 key，只能 GET | 7 天 |

**object key 由管理端决定，沙盒只能报一个文件名。**
形如 `{前缀}/{username}/{日期}/{runId}/{随机}/{文件名}`。`username`/`runId` 取自 run 票据，
**沙盒在请求体里指定的一律不认** —— 否则它能把产物写进别人的命名空间。
随机段让别人即便知道 username 和 runId 也拼不出路径；纯点的段（`.` / `..`）会被换掉，
否则中途一次 URL 路径规范化就会把 `p/../x` 解析成 `p/x`。

#### 服务间接口

```http
POST /api/v1/sandbox/artifacts/upload-url
X-API-SecurityCode: <调用方令牌>
```
```json
{ "username": "alice", "runId": "run_1", "fileName": "report.pdf", "sizeBytes": 10240 }
```
```json
{ "ok": true, "key": "...", "uploadUrl": "...", "downloadUrl": "...",
  "expiresIn": 900, "maxBytes": 209715200 }
```

**不给浏览器用**：`uploadUrl` 就是一把能往那个 key 写东西的钥匙。

#### 部署

只在管理端配这三样，**节点和 agent 都不用配**：

| 变量 | 缺省 | 说明 |
|---|---|---|
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | - | 缺一样整块功能关闭（返回 501） |
| `SANDBOX_ARTIFACTS_OSS_BUCKET` | `fs-public` | |
| `SANDBOX_ARTIFACTS_OSS_REGION` | `cn-north-1` | |
| `SANDBOX_ARTIFACTS_PREFIX` | `fod/sandbox-artifacts` | key 前缀 |

**对象存储的主机名由管理端在注册/心跳响应里下发给节点**（`artifactHost`），
节点收到后自动放行 slot 出站 —— 有意不让运维在两处各配一遍：
配置漂移的现象是"产物上传莫名其妙连不上"，而两边的配置看起来都对。
节点在 slot 销毁重建后会重新挂上这条规则，否则表现是"用了几次之后突然连不上"。

### 5.9 浏览器

```http
POST /v1/leases/{leaseId}/browser/{action}
Authorization: Bearer <leaseToken>
```

首次调用任意动作时会自动创建浏览器会话，可在该次请求里带上：

```json
{ "cookies": [...], "userAgent": "..." }
```

> cookies 在这里进入节点 —— 这是整套设计里凭据唯一一次离开调用方，
> 因为浏览器自动化本质上就需要浏览器**自己**持有登录态，代发请求替代不了。
> 约束：只进浏览器上下文的内存、不落盘、随租约销毁、日志只记条数。

节点未启用浏览器时返回 `501 browser-not-enabled`。

| 动作 | 入参 | 返回 |
|---|---|---|
| `open` / `navigate` | `{ url }` | `{ url, title }` |
| `snapshot` | — | `{ snapshot, refCount, url, title }` |
| `screenshot` | `{ waitMs?, fullPage? }` | `{ contentBase64, sizeBytes, dimensions, url, title }` |
| `content` | — | `{ url, title, html }` |
| `evaluate` | `{ fn }` | `{ value, url }` |
| `act` | 见下表 | 因 kind 而异 |
| `network` | `{ limit?, onlyErrors?, contains? }` | `{ count, totalTracked, items }` |
| `network.clear` | — | `{ cleared }` |
| `close` | — | `{ closed: true }`，**幂等** |

`snapshot` 返回的是 ARIA 无障碍树，每个可交互元素带一个 `ref`；
后续 `act` 用 `ref` 定位元素。**页面变化后 ref 会失效，需要重新 snapshot。**

#### `act` 的 kind

| kind | 入参 | 说明 |
|---|---|---|
| `click` | `{ ref, doubleClick? }` | 点击 |
| `type` | `{ ref, text }` | 逐字输入 |
| `fill` | `{ ref, text }` | 整体填充。走原生 setter，AntD / ElementUI 这类受控组件才感知得到 |
| `press` | `{ key }` | 按键，如 `Enter`、`Escape` |
| `select` | `{ ref, values }` | **原生** `<select>`。目标不是 select 会明确报错，不会假成功 |
| `selectOption` | `{ ref, text, exact?, openDelayMs? }` | **自定义下拉**（AntD / ElementUI / 级联 / portal 弹层）：点触发器 → 等弹层 → 按文本点选项 |
| `hover` | `{ ref }` | 悬停 |
| `wait` | `{ timeMs }` | 等待，上限 30 秒 |
| `evaluate` | `{ fn }` | 同上面的 `evaluate` |

> **`select` 与 `selectOption` 不能混用。** 前者只对原生 `<select>` 有效，
> 后者用于自定义下拉。用错时会得到明确的错误提示，而不是静默无效果。

浏览器动作失败返回的是 **HTTP 200 + `{"ok": false, "error": "..."}`**，
带着真实原因。动作失败（ref 失效、元素找不到）是常态，
笼统的 500 只会让调用方盲目重试。

---

## 5.12 请求标识与链路追踪

| | 谁生成 | 用途 |
|---|---|---|
| `requestId` | 每个服务自己，每请求一个 | 把"这条响应"和日志里那几行对上 |
| `traceId` | 最上游，逐跳透传 | 把 agent 的一次运行、节点上的执行、桥的一次出网串成一条链 |

- 所有 JSON 响应都带 `requestId`，同时出现在响应体和 `x-request-id` 响应头里。
  **出错的响应也带** —— 那才是最需要它的时候。
- 节点认上游的 `x-trace-id`（没有就退到 `x-request-id`，再没有就本地生成）。
  agent 调用节点时把 `runId` 当作 `x-trace-id` 传过去：它本来就贯穿一次运行、
  票据载荷和桥的调用，不必再造一个平行标识。
- **格式非法的 traceId 一律丢弃**（只收 `[A-Za-z0-9._-]{1,128}`）。它会进结构化
  日志，一个带换行的头就能往 JSON 行日志里注入伪造的记录。

为什么必须有：我们让模型在沙盒里跑任意代码，**"这条出网请求是谁发的"必须答得出来**。
没有跨进程的 id，每一跳的日志都自成一体，事后只能靠时间戳猜。

---

## 6. 错误语义

| 情况 | 行为 |
|---|---|
| Manager 全挂 | 调度不可用，**已有租约不受影响**。调用方走"稍后重试" |
| 共享缓存挂 | 同上。管理端不做本地降级 —— 用一份读不到的注册表去调度，比明确失败更糟 |
| 节点心跳失败 | 节点**继续正常服务已有租约**，只是 30 秒后不再被调度到 |
| 票据过期 | 节点 `401`，调用方重新 `/schedule`。不做自动续期 —— 票据短就是它的价值 |
| 所有候选都 `429` | 调用方返回"沙盒池当前没有空闲槽位" |
| 两端票据密钥不一致 | **所有租约申请 401**，现象是"调度成功但换不到租约"，两边日志都正常。管理台的密钥指纹比对就是为这个场景准备的 |

---

## 7. 环境变量

### 管理端

| 变量 | 必填 | 缺省 | 说明 |
|---|---|---|---|
| `REDIS_URL` | ✅ | - | 共享缓存连接地址 |
| `SANDBOX_TICKET_SECRET` | ✅ | - | 票据 HMAC 密钥，与所有节点共享 |
| `SANDBOX_ENV` | | `default` | 键前缀，多环境隔离 |
| `SANDBOX_HEARTBEAT_MS` | | `10000` | 下发给节点的心跳间隔 |
| `SANDBOX_STALE_MS` | | `30000` | 节点 TTL，**必须 ≥ 3× 心跳间隔** |
| `SANDBOX_TICKET_TTL_MS` | | `60000` | 票据有效期 |
| `SANDBOX_CANDIDATES` | | `3` | 每次调度返回的候选数上限 |
| `SANDBOX_CONSOLE_ADMINS` | | 空 | 管理台写权限名单，**留空 = 只读** |
| `SANDBOX_CONSOLE_EXEC` | | `0` | 是否允许管理台开调试沙盒 |
| `SANDBOX_MAX_LEASES_PER_USER` | | `0` | 单用户全集群并发租约上限，`0` = 不限 |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | | - | 产物直传的对象存储凭据，缺一样整块关闭 |
| `SANDBOX_ARTIFACTS_OSS_BUCKET` | | `fs-public` | 产物桶 |
| `SANDBOX_ARTIFACTS_OSS_REGION` | | `cn-north-1` | |
| `SANDBOX_ARTIFACTS_PREFIX` | | `fod/sandbox-artifacts` | object key 前缀 |

### 节点

| 变量 | 必填 | 缺省 | 说明 |
|---|---|---|---|
| `SANDBOX_MANAGER_URL` | | 空 | 配了才自注册 |
| `SANDBOX_MANAGER_CODE` | 配了 URL 则必填 | - | 节点安全令牌 |
| `SANDBOX_TICKET_SECRET` | 配了 URL 则必填 | - | 校验票据用 |
| `SANDBOX_NODE_ID` | | hostname | 节点标识 |
| `SANDBOX_POOL` | | `default` | 资源池 |
| `SANDBOX_ACCEPT_STATIC_TOKEN` | | `true` | 迁移期兼容开关 |
| `LEASE_IDLE_TIMEOUT_MS` | | `600000` | 租约滑动窗口，见 [5.3](#53-租约能活多久) |
| `LEASE_TTL_MS` | | `1800000` | 单次续期上限，**必须 ≥ 滑动窗口** |
| `LEASE_MAX_LIFETIME_MS` | | `14400000` | 租约硬顶，**必须 ≥ 单次续期上限** |
| `EXEC_RETAIN_JOBS` | | `8` | 每租约保留多少个已结束异步任务的输出（供断线重连取回） |
| `MAX_FILE_BYTES` | | `33554432` | 单文件上下行上限 |
| `MAX_FILE_BATCH` | | `100` | 批量读写一次最多几个文件 |
| `MAX_LIST_ENTRIES` | | `2000` | 列目录一次最多回多少条，到顶报 `truncated` |
| `SANDBOX_EGRESS_MODE` | | `allowlist` | 出站拦截开关。**接了管理端之后失效**（以下发为准），生产环境写 `open` 拒绝启动 |
| `SANDBOX_EGRESS_ALLOW` | | 空 | 节点级额外放行，对所有 slot 永远生效。同样以管理端下发为准 |
| `SANDBOX_EGRESS_LEASE_ALLOW` | | 空 | 租约**可以申请**放行的清单，空 = 一条也不能申请。同样以管理端下发为准 |

### 调用方

| 变量 | 必填 | 缺省 | 说明 |
|---|---|---|---|
| `SANDBOX_MODE` | | `http` | `manager` 走管理端调度 |
| `SANDBOX_MANAGER_URL` | `mode=manager` | - | 管理端基址 |
| `SANDBOX_MANAGER_CODE` | `mode=manager` | - | 调用方安全令牌 |
| `SANDBOX_POOL` | | `default` | 只调度到这个资源池 |
| `SANDBOX_NEED_BROWSER` | | `false` | 是否要求节点具备浏览器能力 |
| `SANDBOX_KEEPALIVE` | | `true` | 持有租约期间周期性续期，周期取节点下发的滑动窗口 ÷ 3 |
| `SANDBOX_EXEC_ASYNC` | | `true` | 节点支持时走异步任务 + 断线续传；关掉退回同步流 |
| `SANDBOX_PARK` | | `auto` | 一轮结束后**驻留**沙盒让下一轮接着用。`auto` = 只在这一轮真的用过浏览器时驻留；`always` / `off`。窗口与容量上限在节点侧配（`LEASE_PARK_*`、`MAX_PARKED_PER_USER`）|

`mode=manager` 时**不再需要长期的沙盒令牌** —— 执行权限完全来自管理端签发的票据，
这正是这套设计的目的。
