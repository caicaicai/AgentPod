# 架构

## 一句话

**控制面 + 无状态 agent 服务（本项目，固定副本）+ 固定沙盒池。**
每个请求起一个 pi `AgentSession`，跑完即销毁；状态全部外置；工具执行下沉沙盒。
运行时**不创建任何 per-user 资源、不调用 K8s API**，扩容就是改 replicas。

## 分层

```
接入面   Web SPA / 定时任务 / OpenAPI
           │
接入层   src/http/server.js      路由 · SSE · 请求体限流 · 优雅停机
身份     src/identity/           认证 → 可信 username
           │
编排     src/agent/run-service.js  并发预算 · 每用户配额 · 活跃 run · 台账/指标钩子
执行     src/agent/run-turn.js     无状态单轮：水合 → 跑 → 回写 → 清场
           │
能力     src/agent/tools.js       工具装配（沙盒版 bash + 移植过来的 AP 工具）
         src/agent/skills.js      SKILL.md 装载（pi 原生支持）
           │
资源     src/models/              /ap/llminfo → pi Model（含按登录态缓存）
         src/credentials/         Credential Broker（现为透传，将来代持）
         src/sessions/            会话存储（memory / file / mysql，按 username 强隔离）
         src/persistence/         无数据库时的落地层（路径收口 + 原子写 + 串行队列）
         src/memory/              长期记忆 MEMORY.md（个人 / 项目两个作用域）
         src/projects/            项目：会话分组 + 项目级指令与记忆
         src/cron/                定时任务：排期解析 · 存储 · 调度（单副本）
         src/sandbox/             执行下沉（http / local / none）
           │
外部     模型网关 · 沙盒 worker · MySQL
```

## 关键设计

### 1. 引擎是 pi，不是 openclaw

openclaw 内部就是用 pi 跑 agent 循环的（`createAgentSession()`）。云端直接用 pi 的好处是：
所有依赖都可注入（`AuthStorage` / `ModelRegistry` / `SettingsManager` / `SessionManager` / `customTools`），
没有隐式全局，因此同一进程能并存多个用户的 session。openclaw 的 gateway 层（通道、cron、配置体系）
在云端本来就该由控制面承担，不需要它。

代价：失去 openclaw 在 pi 之上那层补丁（compaction safeguard、context pruning、model failover、
provider 边角修复）。openclaw 是 MIT，计划挑出来做成 `pi-hardening/`，见 MIGRATION.md。

### 2. 无状态：状态在 store，不在进程

会话是 pi 的 append-only JSONL 树。每轮：从 store 按 `username` 水合到临时目录 → 跑一轮 →
把增量写回 store → 删掉临时目录。因此：

- 任意副本都能接任意请求，不需要会话亲和
- 副本重启不丢会话
- 扩容就是加副本

### 3. 身份由服务端认定

`AUTH_MODE=password` 时，身份由 JWT 会话令牌认定，**客户端说了不算**。
`AUTH_MODE=dev` 才信任 `X-Username`，且 `NODE_ENV=production` 下直接拒绝启动。

### 4. 凭据：现在透传，将来代持

`src/credentials/broker.js` 定义了接口，现在的实现是「用调用方带来的登录态去换模型访问权」。
这条路有天花板：**只在人坐在浏览器前面时成立**。定时任务没有浏览器 —— 所以必须换成服务端代持
（tokenGrant/refreshToken 续期）。接口先定好，换实现时上层不动。

定时任务上线后，这个天花板从"将来要解决"变成了"现在就挡着"。过渡方案是
`src/cron/credentials.js`：`CRON_CREDENTIAL_MODE=stored` 把用户创建任务那一刻的登录态
以 0600 落到他自己的数据目录，触发时取出来用。**默认关闭**，性质与 `SANDBOX_INJECT_ME_TOKEN`
同级（拿到盘 = 拿到这些人的登录态），启动时用 error 级别宣告一次。它是一个带明确退出条件的
临时方案：平台支持代持之后，换掉的是这一个文件的实现，调度器一行不动。

### 5. 沙盒：固定池 + 租约独占

工具执行下沉到 `sandbox-worker/`（独立容器部署）。命令行与浏览器共用同一个租约。四个关键选择：

**不做"每次执行起一个容器"。** 业界共识是 agent 循环里每轮新建沙盒会把冷启动税收到
每一次迭代上；而我们更早还有一条约束：不做动态资源编排。所以形态是**固定实例池，像 CI runner 池**
—— 执行 = 在已经跑着的实例里 spawn 进程，冷启动为零。

**租约而不是无状态 exec。** 技能的第二条命令常要读第一条写的文件，而经负载均衡的
第二次请求可能落到别的实例。解法：先要租约，实例在响应里**回报自己的地址**，之后直连它。
与 Bridge 的回连是同一个套路 —— 要状态亲和，就让持有状态的一方报出自己。

**`SANDBOX_SLOTS=N`：预建 N 个独立隔离的槽位。** 每个槽位有自己的
**PID/mount/network/uts/ipc namespace** + 独立 cgroup（`sandbox-worker/src/namespace/`），
在 worker 启动时就建好（保持零冷启动），`N` 就是这个副本能同时安全服务的用户数。
槽位归还时**整体销毁重建**而不是"杀进程+抹目录"——内核强制回收该 namespace 内的一切
（进程、IPC 对象、网络状态），不存在"清理漏了什么"这个选项。没有按 uid+目录分离的旧模式
可退——那种模式在多用户并发时隔离名存实亡，索性不留这条退路，逼着部署环境必须满足前提
条件：容器具备 `CAP_SYS_ADMIN` + `CAP_NET_ADMIN`，上线前用
`sandbox-worker/bin/check-namespace-caps.sh` 验证。

**浏览器与命令行同一个租约。** 一个租约一个 BrowserContext（cookie/storage 全独立），
释放时一起关；宿主 Chromium 进程是 slot 私有的，常驻在该 slot 的 namespace 里。
这样截图可以被同一次 run 里的命令直接处理，不必绕回 agent service。

沙盒的出站策略通过每个槽位独立的 network namespace + veth 实现
（`sandbox-worker/src/namespace/netns.js`），不依赖 uid 匹配。
默认允许自由出网（`egressMode=open`），可按需配置白名单。

详见 [sandbox-worker/README.md](../sandbox-worker/README.md)「隔离：每个槽位独立的 namespace」。

### 6. 模型清单缓存按凭据主体

模型清单按凭据指纹缓存。
外加 stale-while-error：上游抖动时退回过期缓存，避免用户对话到一半被踢成「未登录」。

## 请求时序（一次对话）

```
浏览器 ──POST /v1/chat/stream (SSE)──> http/server
                                        ├─ identity.resolve  → 认证 → username
                                        ├─ runService.execute → 并发预算/配额
                                        │    ├─ broker.getLlmAccess → 模型清单（缓存）
                                        │    ├─ buildModel → pi Model（用户的 llmToken）
                                        │    └─ runTurn
                                        │         ├─ store.load({username})  水合会话
                                        │         ├─ AgentSession.prompt()   事件流 → SSE
                                        │         │     └─ bash 工具 → 沙盒 worker
                                        │         ├─ store.save({username})  回写增量
                                        │         └─ dispose + rm -rf        清场
                                        └─ metrics.recordRun
```

## 部署形态

| 组件 | 形态 | 扩容方式 |
|---|---|---|
| Agent Service（本项目） | 容器 × N（1C2G），端口 8787 | 改 replicas |
| Sandbox Worker（`sandbox-worker/`） | 特权容器 × M（2C4G），`SLOTS=1`；命令行与浏览器同一实例 | 改实例数 |
| 存储 | MySQL（会话）+ 共享存储（工作空间） | — |

容量按**峰值并发 run** 定，不按人数：`副本数 = 峰值并发 run / 每副本并发预算`。

## 还没做的（诚实清单）

见 MIGRATION.md 的进度表。当前骨架**没有**：知识库、
断线续接、真实凭据代持、浏览器的人工接管（VNC）。

沙盒的隔离边界要看清楚：靠每个槽位独立的 namespace（PID/mount/network/uts/ipc），
"前后两个 job 之间"靠的是内核强制的 namespace 销毁重建，不是"杀进程+抹目录"那种代码
正确性层面的纪律。但仍是**同一个宿主内核**，不防内核级 0-day 逃逸，不是 microVM / gVisor。
诚实清单见 `sandbox-worker/README.md`「诚实的隔离边界」。

沙盒出站默认开放（`egressMode=open`），可按需配置白名单。
