# 沙盒管理端（Sandbox Manager）

把沙盒从"agent 的一个内部组件"变成"平台级的标准能力"：节点自注册、集群判活、
按负载调度、给调用方签发短期票据。

协议契约（三个代码库都要照着改）在 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

## 快速启动（Docker）

```bash
# 在仓库根目录，一键启动全部服务（agent + worker + manager + redis）
docker compose up -d

# 仅启动 manager + redis
docker compose up -d manager redis
```

或在 `sandbox-manager/` 目录单独构建：

```bash
cp .env.example .env    # 编辑 .env，至少配置 CONSOLE_USERS
docker build -t sandbox-manager .
docker run -d --name manager -p 3000:3000 --env-file .env sandbox-manager
```

**本地开发（Node.js）**：

```bash
npm install && npm run dev          # 后端 http://localhost:3000
cd web && npm install && npm run dev  # 前端 http://localhost:5180（mock 数据）
```

### 实现说明

本项目包含两套后端实现：

| 实现 | 位置 | 运行时 | 存储 |
|---|---|---|---|
| **Node.js 独立部署** | `src/` + `Dockerfile` | Fastify + TypeScript | Redis（或内存开发模式） |
| **Legacy 平台 (Lua)** | `workers/` + `modules/` | Lua | Redis / 共享存储 |

Docker 部署使用 Node.js 实现，管理台认证方式为内置用户名密码（JWT）。

---

## 它解决什么

今天 agent 直连沙盒节点，"调度"实际上是 K8s Service 轮询 + 撞上 429 就重试。
三个问题：

1. **调用方持有长期凭据。** `SANDBOX_TOKEN` 能在任意节点执行任意命令且永不过期。
   谁想接入沙盒，就得把这枚 token 发给谁。
2. **没有集群视图。** 哪些节点活着、各自多满、能不能起浏览器，只能一台台去看 `/healthz`。
3. **调度策略散在每个调用方里。** 想加"按负载挑""按能力挑""摘除某个节点"，
   得改所有接入方。

管理端把这三件事收拢成一个标准接口。**它只在控制面** —— exec 流量永远直连节点，
不经过 manager（为什么，见 PROTOCOL §0）。

---

## 目录结构

> **Legacy 说明**：`workers/` 与 `modules/` 为旧版 Lua 实现，按 legacy 平台的 Git 同步约定
> 与 `src/` 分开。**当前 Docker / Node.js 部署不依赖这些目录。**

```
sandbox-manager/
├── src/                   # Node.js 实现（当前主路径）
├── docs/
│   ├── PROTOCOL.md        # 协议契约 —— 改协议先改这里
│   └── llms.txt           # legacy 平台手册
├── workers/               # (legacy) → 平台 Workers
│   ├── api/
│   │   ├── nodes_register.lua     POST /api/v1/sandbox/nodes/register
│   │   ├── nodes_heartbeat.lua    POST /api/v1/sandbox/nodes/heartbeat
│   │   ├── nodes_deregister.lua   POST /api/v1/sandbox/nodes/deregister
│   │   ├── nodes_list.lua         GET  /api/v1/sandbox/nodes
│   │   └── schedule.lua           POST /api/v1/sandbox/schedule
│   ├── ui/                        管理台专用（会话认证，不要安全令牌）
│   │   ├── whoami.lua             GET  /api/v1/sandbox/ui/whoami
│   │   ├── nodes.lua              GET  /api/v1/sandbox/ui/nodes
│   │   ├── config.lua             GET  /api/v1/sandbox/ui/config
│   │   ├── simulate.lua           POST /api/v1/sandbox/ui/simulate
│   │   ├── drain.lua              POST /api/v1/sandbox/ui/drain
│   │   ├── evict.lua              POST /api/v1/sandbox/ui/evict
│   │   ├── occupancy.lua          GET  /api/v1/sandbox/ui/occupancy
│   │   ├── kill.lua               POST /api/v1/sandbox/ui/kill
│   │   ├── sandbox_open.lua       POST /api/v1/sandbox/ui/sandbox/open
│   │   ├── sandbox_call.lua       POST /api/v1/sandbox/ui/sandbox/call
│   │   └── sandbox_close.lua      POST /api/v1/sandbox/ui/sandbox/close
│   └── jobs/
│       └── reconcile.lua          定时任务（on_task）
├── modules/               # (legacy) → 平台 Modules（名称只能含字母数字下划线，故全部平铺）
│   ├── util.lua           配置、响应、校验
│   ├── registry.lua       Redis 节点表 + 摘除标记
│   ├── ticket.lua         短期票据签发/校验
│   ├── scheduler.lua      候选筛选与排序
│   ├── console.lua        管理台的登录用户身份与写权限闸门
│   ├── debugbox.lua       管理台调试沙盒：代管租约、转发到节点
│   ├── nodeadmin.lua      管控台 → 节点的运维通道：看占用、杀占用
│   ├── egress.lua         沙盒出站策略（拦不拦、放行谁），随心跳下发
│   └── memstore.lua       单机开发模式的存储（ctx.cache 顶替 Redis）
├── web/                   # 管理台前端（Vue 3 + Vite，独立部署）
└── test/                  # 本地测试（legacy Lua 用例，不参与 Git 同步）
    ├── harness.lua        ctx 桩
    └── run.lua            106 项测试
```

Worker 名称由相对路径推出：`workers/api/schedule.lua` → `api.schedule`（legacy）。

---

## 本地测试

**Node.js 实现**：

```bash
npm test
```

**Legacy Lua 实现**：

```bash
cd sandbox-manager
lua test/run.lua
```

`test/harness.lua` 用纯 Lua 桩了 `ctx`（Redis 带真实 TTL 语义、cache、utils、req/res），
所以注册 → 心跳 → 调度 → 票据整条链路都能在本地跑，不需要平台。

桩有两处是**有意做得比真实环境更刻薄**的：

- `mget` 乱序返回。真实 Redis SDK 会把跨 slot 的 key 拆开再合并，顺序没有承诺；
  代码里如果偷偷按下标去对 `ids[i]`，测试会当场抓出来。
- 目录里预埋死 nodeId。模拟 K8s 滚动发布后残留的 pod 名。

桩**不覆盖**的：`hmac_sha256` 是确定性伪随机，不是真 SHA-256。所以票据那几项
验的是"签发/校验/防篡改的流程对不对"，不是密码学强度 —— 强度由平台的
`ctx.utils.hmac_sha256` 提供。

---

## 部署

### 1. 环境变量（Node.js 独立部署）

| 变量 | 必填 | 缺省 | 说明 |
|---|---|---|---|
| `REDIS_URL` | ✅ | - | Redis 连接地址。**生产必填**；本地开发可改用 `SANDBOX_DEV_MEMORY_STORE`（见下） |
| `SANDBOX_DEV_MEMORY_STORE` | | `0` | 置 `1` 时，**在没配 `REDIS_URL` 的前提下**用进程内存顶替 Redis。**仅限本地开发** |
| `SANDBOX_TICKET_SECRET` | ✅ | - | 票据 HMAC 密钥，与所有节点共享 |
| `SANDBOX_ENV` | | `default` | Redis 键前缀，多环境隔离 |
| `SANDBOX_HEARTBEAT_MS` | | `10000` | 下发给节点的心跳间隔 |
| `SANDBOX_STALE_MS` | | `30000` | 节点明细键 TTL，**必须 ≥ 3× 心跳间隔** |
| `SANDBOX_TICKET_TTL_MS` | | `60000` | 票据有效期 |
| `SANDBOX_CANDIDATES` | | `3` | 每次调度返回的候选数上限 |
| `SANDBOX_EGRESS_MODE` | | `allowlist` | 沙盒出站拦截总开关：`allowlist`（拦）\| `open`（不拦）。**只有明明白白写着 `open` 才放开**，拼错/大小写不对一律按拦处理 |
| `SANDBOX_EGRESS_ALLOW` | | 空 | 拦截模式下额外常开的目标，`host` 或 `host:port` 逗号分隔，不写端口则放行 80+443 |
| `SANDBOX_EGRESS_LEASE_ALLOW` | | 空 | 租约**可以申请**放行的清单（不是自动放行）。空 = 一条也不能申请 |
| `SANDBOX_CONSOLE_ADMINS` | 想用管理台写操作则必填 | 空 | 逗号分隔的用户名名单。**留空 = 管理台只读** |
| `SANDBOX_CONSOLE_EXEC` | 想用管理台的「测试运行」则必填 | `0` | 置 `1` 才允许管理台在节点上开调试沙盒 |
| `SANDBOX_CONSOLE_SESSION_MS` | | `900000` | 调试沙盒会话时长 |
| `API_SECURITY_CODES` | ✅ | - | 逗号分隔的 API 安全令牌（节点用一枚、调用方用一枚，分开发） |
| `CONSOLE_USERS` | ✅ | - | 管理台登录：`用户名:密码`，逗号分隔 |

`SANDBOX_CONSOLE_ADMINS` 留空时禁止所有写操作，而不是放行所有登录用户：
摘除、强制注销直接改变生产容量，而会话认证只能证明"是当前登录用户"。
默认拒绝会在页面上明确显示原因，是可见的失败；默认放行则是不可见的敞口。

### 看占用与强制释放

管理台的节点抽屉里能看到每个被占用的槽位：**谁**（username）、**哪一次 run**（runId）、
占了多久、几条命令在跑、CPU/内存/进程数。管理员可以强制释放指定的占用。

三个刻意的取舍：

- **按需向节点查，不走心跳。** 占用是秒级变化的，隔一个心跳周期的数据不能作为
  "要不要杀"的依据；而且心跳数据会落进 Redis，那等于把每个用户每次 run 的
  username/runId 都持久化一份，为一个只读界面留下一份本不必存在的数据副本。
- **不显示命令原文。** 那是用户数据，与 worker 的日志遵守同一条规矩（只记形状与
  长度）。要知道"这个人到底在做什么"，拿 `runId` 去 agent 侧查那一次会话。
  而"该不该杀"恰恰只需要形状 —— 跑 8 分钟的 `npm install` 和跑 8 分钟的死循环，
  区别全在空闲时长、CPU、输出量这几个数字上。
- **只读要登录，强杀要在管理员名单里。** 强制释放会把整个 slot 销毁重建，那个用户
  这一轮在沙盒里产出的、还没同步回工作空间的东西全部消失 —— 与摘除节点同级的
  破坏性，所以走同一道闸门。只读挡在名单后面则会逼着值班的人为了看一眼负载去要写权限。

访问节点用的是 `scope=admin` 的短期票据，**不是节点的 `SANDBOX_TOKEN`** ——
管理端不该持有任何节点的长期凭据。这种票据在节点侧换不到租约（见 docs/PROTOCOL.md §1），
所以一个只读入口不会顺带成为"在生产机器上执行代码"的入口。

### 沙盒出站策略为什么配在这儿

出站白名单是整套凭据边界的地基：沙盒里跑的是模型生成的任意代码，它拿得到
用户登录态，只要能连出去，凭据就能被带走。所以"要不要拦"这个开关放在哪里
本身就是一个安全决定 ——

- 放在节点上 → N 台机器 N 份配置，"到底哪几台还开着拦截"没有单一答案，
  改错一台就是一个只在那台机器上成立的洞，而集群从外面看一切正常；
- 放在管理端 → 一处生效、一处可审计，节点只负责执行。

策略随注册/心跳响应下发，节点收到后**整体覆盖**自己的本地默认值（不做合并 ——
合并出来的结果，出了事没人能一眼说清是哪一边贡献的那一条）。改完管理端的
环境变量，一个心跳周期内全集群跟上，**不需要重启任何节点**。

节点侧的 `SANDBOX_EGRESS_*` 因此退化成"还没收到下发之前的启动默认值"，
而且**生产环境的节点禁止写 `open`**（`sandbox-worker/src/config.js` 会拒绝启动）。

两件事在管理台的配置页上分开显示，因为它们真的是两件事：

- **`egress-rollout`** —— 哪些节点还在用旧版本的策略（心跳没通，或刚重启）；
- **`egress-pending`** —— 策略已经收到了，但还有 slot 没换上。正在被租用的
  slot 是**刻意**不中途改的（会冲掉它自己申请的租约级放行），等租约释放、
  slot 重建时自然生效。没有这一条的话，改完之后那几分钟看起来就是"改了没用"。

### 单机开发模式（不装 Redis）

本地做 agent → manager → worker 的端到端联调时，为了一张节点表去起一套 Redis
往往是最麻烦的一步。设 `SANDBOX_DEV_MEMORY_STORE=1` 且**不配** `REDIS_URL`，
存储就降级为进程内内存 —— Node.js 实现直接走内存适配器；legacy Lua 实现则走
`modules/memstore.lua`（架在 `ctx.cache` 上的 Redis 形状适配器）。

用 `ctx.cache`（OpenResty 共享内存）而不是模块级 Lua table，是因为后者**每个 nginx
worker 进程一份**：节点从 A 进程注册进去，调度请求落到 B 进程就查不到，
表现为"节点一会儿在一会儿不在"。

三条限制，都只在单机开发下无所谓：

- **不跨机器。** manager 多副本时每台各有一份节点表，只有 1/N 的请求看得到某个节点。
- **重启即丢。** 不要紧：节点每个心跳周期都会重新报到。
- **并发写入不原子。** 并发注册理论上会丢条目。

> **为什么要显式开关，而不是"没配 Redis 就自动降级"。**
> 自动降级会把生产上一个响亮的配置错误（忘配 `REDIS_URL`，今天是每个请求
> 直接失败）变成一个半死不活的假集群：注册、调度、签票据全都"成功"，
> 只是**只对 1/N 的请求成立**，而自检页一片绿。那比起不来难查得多。
>
> 顺序上也做了保护：**配了 `REDIS_URL` 就一定走 Redis**，
> 开发开关只在没配的时候才有机会生效，所以线上就算混进了这个变量也切不过去。

降级期间管理台自检页会有一条显眼的 warn，`ui.config` 响应里 `config.storeKind`
会是 `memory` —— 不显眼地标出来，很容易被当成正常状态一路用下去。

### 2. Legacy 平台部署（Lua）

> 以下内容仅适用于 legacy 平台的 Lua 实现，**Docker / Node.js 部署可跳过**。

- **Redis 配置**：在部署环境的 Redis 配置页建连接，把连接地址填进 `REDIS_URL`。
- **Git 同步**：Workers 路径填 `sandbox-manager/workers`，Modules 路径填 `sandbox-manager/modules`。
- **接口访问令牌**：在项目设置中建**两枚** API 令牌，分别授权给：
  - 节点用：`api.nodes_register`、`api.nodes_heartbeat`、`api.nodes_deregister`
  - 调用方用：`api.schedule`
  - 服务端脚本查集群用：`api.nodes_list`

  分开发是有意的：调用方那枚泄漏了，也注册不了假节点。

  **`ui.*` 那批不要发令牌** —— 它们靠会话认证，浏览器不该持有任何令牌。
- **前端项目**：`web/` 是独立的前端工程，在部署环境中建前端项目并授权部署令牌。
  详见 [`web/README.md`](web/README.md)。
- **定时任务**：在部署环境中挂 `jobs.reconcile`（类型**单机**、频率 10 分钟起步、重入策略 `drop`）。
  这个任务挂掉不影响可用性 —— 判活靠明细键 TTL，最坏后果是节点目录慢慢变胖。

---

## 快速验证

```bash
MGR=https://manager.example.com
NODE_CODE=your-api-token-nodes      # 节点那枚令牌
CALLER_CODE=your-api-token-callers  # 调用方那枚令牌

# 1) 假装一个节点注册
curl -s -X POST $MGR/api/v1/sandbox/nodes/register \
  -H "X-API-SecurityCode: $NODE_CODE" -H "Content-Type: application/json" \
  -d '{"nodeId":"fake-1","base":"http://10.0.0.1:8080","capacity":{"slots":4},"caps":{"browser":true}}'

# 2) 心跳放开容量（刚注册时按满负载记，不心跳不会被调度到）
curl -s -X POST $MGR/api/v1/sandbox/nodes/heartbeat \
  -H "X-API-SecurityCode: $NODE_CODE" -H "Content-Type: application/json" \
  -d '{"nodeId":"fake-1","slots":{"used":1,"total":4}}'

# 3) 看集群
curl -s $MGR/api/v1/sandbox/nodes -H "X-API-SecurityCode: $CALLER_CODE" | jq .

# 4) 申请调度
curl -s -X POST $MGR/api/v1/sandbox/schedule \
  -H "X-API-SecurityCode: $CALLER_CODE" -H "Content-Type: application/json" \
  -d '{"runId":"r1","username":"alice","need":{"browser":true}}' | jq .
```

第 4 步应该拿到带 `ticket` 的候选列表。这时候还没有任何真实节点能认这张票据 ——
节点侧的校验实现还没写（见下）。

---

## 管理台

`web/`（Vue 3 + Vite，独立的前端项目）：集群总览、节点摘除/恢复、调度试算、
配置自检。详见 [`web/README.md`](web/README.md)。

它**不调** `api.*` 那批接口 —— 那些是 `require_security_code` 的，浏览器要调
就得把安全令牌打进 JS bundle，等于把一枚长期凭据发给每个打开过页面的人。
管理台走 `ui.*`：JWT 会话认证（通过 `CONSOLE_USERS` 配置的用户名密码登录），
前端产物里不含任何秘密。

其中两件事是这个界面**独有**、命令行做不到的：

- **摘除节点**（`ui/drain`）。今天没有任何接口能把 `draining` 置上 ——
  `registry.schedulable` 一直在读它，但心跳每 10 秒会用节点自报的
  `draining=false` 整体覆写节点明细。所以摘除标记存在独立的 hash
  `sbx:{env}:drains` 里，读取时叠加，心跳冲不掉。
- **调度试算**（`ui/simulate`）。`scheduler.pick` 返回的 `rejected` 今天只进
  日志，"没有可用节点"在排查时等于没说。试算跑同一套逻辑并把原因摊开，
  且**有意不签发票据** —— 否则一个只读页面会成为绕过调用方鉴权的后门。
- **测试运行**（`ui/sandbox/*`）。在选定节点上真开一个沙盒跑命令 / 读写文件 /
  操作浏览器，验证它是不是真能干活。**默认关闭**，要 `SANDBOX_CONSOLE_EXEC=1`
  才启用。

  它和上一条的区别正是这套设计的关键：试算若签票据，是把票据**交给浏览器**，
  任何能打开页面的人就此拿到沙盒执行权限；而这里票据在 manager 进程内签发、
  立即使用、不出网，换来的 `leaseToken` 也存在 Redis 里，浏览器只拿到一个不透明的
  `sessionId`，且只有开启者本人能操作自己的会话。身份强制取登录用户，伪造不了。

  浏览器**不能**直连节点（内网地址 + 节点不发 CORS 头），所有操作都由 manager 转发。

- **接口文档**（前端页面）。沙盒全部能力的接口说明，可下载 Markdown。
  源文件是 `web/src/docs/sandbox-api.md`，页面渲染的和下载的是同一份 ——
  分成两份迟早漂移。

## 四边都已实现

| 角色 | 位置 | 状态 |
|---|---|---|
| Manager | `sandbox-manager/` | ✅ 注册/心跳/注销/调度/集群查询/对账 |
| 沙盒节点 | `sandbox-worker/src/manager/` | ✅ 自注册 + 心跳 + 票据校验 + 一次性防重放 |
| 调用方 | `src/sandbox/client.js` | ✅ `SANDBOX_MODE=manager`，候选轮转 |
| 管理台 | `sandbox-manager/web/` | ✅ 总览/节点/试算/自检，JWT 会话认证 + 写权限名单 |

端到端测试在 `test/sandbox-manager-mode.test.js`（agent 客户端 × 假 manager ×
**两个真实 worker**）：调度→票据→租约→exec→释放、候选轮转、密钥不一致、
票据重放、租约级凭据、关掉静态 token 之后的行为，10 项。

## 上线顺序

按 `docs/PROTOCOL.md` §8 走，三步各自可回滚：

1. **节点接上 manager**：节点配 `SANDBOX_MANAGER_URL/CODE/TICKET_SECRET` 重启。
   此时没有任何调用方走新路径，`GET /api/v1/sandbox/nodes` 能看到集群即成功。
   注意**刚注册的节点按满负载记**，要等第一次心跳（10 秒）才会被调度到 ——
   否则 slot 池还没建完就被派活。
2. **agent 切 `SANDBOX_MODE=manager`**：先灰度。节点侧
   `SANDBOX_ACCEPT_STATIC_TOKEN` 保持 `true`，两种凭据都收，随时切回。
3. **关掉静态 token**：节点侧置 `SANDBOX_ACCEPT_STATIC_TOKEN=false`。

**第 3 步之前，"调用方持有长期凭据"这个问题并没有真的解决**，只是多了一条新路径。
生产环境停在第 2 步时，节点启动日志里会有一条对应的 warn 提醒。
