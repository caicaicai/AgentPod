# 隔离契约

这个服务在**同一个进程里同时服务多个租户**。所以"这段代码正确"是不够的 ——
它还必须"在别人的数据也在这个进程里时正确"。下面九条是那个更强的要求，
它们不是建议：每一条要么有静态检查挡着，要么有运行时用例守着，
多数两者都有。

改动碰到会话、凭据、存储路径、工具装配、沙盒文件接口这几处之前，先读这一份。

- 静态检查：`npm run check:isolation`（`scripts/check-isolation-rules.js`，进 CI）
- 运行时回归：`test/isolation.test.js`
- 一次跑全：`npm run check`

---

## 为什么是"契约"而不是"最佳实践"

多租户泄漏的共同特征是**失效的时候一声不响**：功能照常工作，测试照常全绿，
只有当两个用户恰好同时在线、恰好落在同一个副本上时才出错，
而那时错的表现是"A 看到了 B 的东西"——已经来不及了。

所以这九条的判据统一是「**别人的东西根本不在这儿**」，
而不是「代码会记得过滤掉别人的东西」。前者是结构性的，后者依赖每个人每次都写对。

---

## 九条

### #1 凭据只在内存，且只属于这一个 run

**要求**：凭据（llmToken / SSO 票 / 模型 key）只经 `AuthStorage.inMemory()` 注入，
**绝不写 `process.env`**，绝不进模块级变量、全局对象或任何跨 run 存活的地方。

**为什么**：`process.env` 是进程级的。两个用户的 run 并发时，后写的那个把前一个
覆盖掉 —— 表现是**用 A 的凭据去跑 B 的请求**，而且完全静默。

**在哪**：`src/agent/run-turn.js:255`、`src/agent/compact-turn.js:111`、
`src/models/model-factory.js`。

**守它的**：
- 静态 `R1-凭据禁止进 process.env`、`R1-禁止把凭据塞进全局`
- 静态 `移植的工具禁止直接读凭据环境变量`（scope: `src/tools/`）
- 运行时 `test/isolation.test.js`「凭据不进 process.env」

### #2 pi 的内置本地执行工具全关，执行一律下沉沙盒

**要求**：`createAgentSession` 一律带 `noTools: 'builtin'`；
工具集完全由 `src/agent/tools.js` 的 `buildTools()` 装配，
`bash`/`read`/`write`/`edit` 用**注入了沙盒 operations 的版本**。

**为什么**：pi 的内置工具在**服务进程内**执行命令。那个进程是所有租户共用的、
持有数据库连接和其他人的会话 —— 在里面执行模型产出的命令，隔离就没有了。

**在哪**：`src/agent/run-turn.js:377`、`src/agent/compact-turn.js:145`、
`src/agent/tools.js`、`src/agent/sandbox-files.js`。

**守它的**：
- 静态 `R2-禁止启用 pi 内置本地执行工具`（拦 `createBashTool(` / `createCodingTools(`）
- 静态 `R2-AgentSession 必须保持 noTools: builtin`（拦总闸被改掉）
- 运行时 `test/isolation.test.js`「工具执行下沉沙盒，且带正确的 username」

⚠️ 这条同时是两条依赖安全告警"当前不可达"的前提，见 [SECURITY-NOTES.md](SECURITY-NOTES.md)。

### #3 每个 run 一套独立临时目录，`finally` 里删掉

**要求**：`cwd` / `agentDir` / `sessionDir` 每 run 现建（`mkdtemp`），
无论成功失败都在 `finally` 里 `rm -rf`。

**为什么**：会话要水合到磁盘才能跑。共用目录 = 上一个用户的会话文件还在那儿，
下一个用户的 pi 进程能读到。

**在哪**：`src/agent/run-turn.js:472`（第 6 步「清场」）。

**守它的**：运行时 `test/isolation.test.js`「run 结束后临时目录被清理」。

### #4 存储的每一次读写都带 username

**要求**：会话、项目、记忆、作品、定时任务、用量 —— 所有按人分的数据，
读写接口**必须**收 username，缺了就抛错，而不是"查全部"。
username 进主键首列。

**为什么**：这是隔离的**主承重墙**。一个忘了带 username 的查询，
回的就是所有人的数据，而它看起来和正确的代码一模一样。

**在哪**：`src/persistence/storage.js:92`（owner 关在闭包里，
调用方**拿不到**一个能读全表的 map）、`src/persistence/schema.sql:9`、
`src/agent/run-turn.js:212` 与 `compact-turn.js:84` 的入口断言。

**守它的**：运行时 `test/isolation.test.js`
「store 接口强制按 username 隔离（缺 username 直接抛错）」、
「并发多用户：上下文互不可见，存储互不串」，
以及**反向用例**「破坏 username 隔离时，测试必须能抓到」——
没有它，一条全绿只能说明检测器本身还活着。

唯一的例外是定时任务调度器的 `crons.due()`：它必须跨用户找到期任务。
那个口回的每条都带 username，下游据此拿到正确作用域（`src/cron/store.js:55`）。

### #5 `finally` 里必须 `session.dispose()`

**要求**：`AgentSession` 用完即销毁，异常路径也要。

**为什么**：不 dispose 会留下监听器、定时器和引用，
既是内存泄漏，也让"这一轮的东西"跨轮活下去。

**在哪**：`src/agent/run-turn.js:472`（与 #3 同一个 `finally`）。

### #6 移植进来的工具禁止模块级凭据缓存

**要求**：`src/tools/` 下不许出现 `let ssoToken = …` 这类模块级可变状态。
工具的用户上下文只经 `ctx` 传递，`ctx` 是 run 级的。

**为什么**：模块级变量跨 run 保留。桌面端搬过来的代码最容易踩这个 ——
那边一个进程只服务一个人，缓存是优化；这边一个进程服务所有人，缓存是串号。
（反面教材：`jme-auth.ts` 的 `export let ssoToken`。）

**在哪**：`src/tools/index.js` 文件头、`src/tools/context.js`。
每个 run 现造一套工具，`execute` 闭包里带的是**这一个用户**的上下文。

**守它的**：静态 `R6-禁止模块级凭据缓存`。

### #7 沙盒与技能只拿 run 级短票据

**要求**：下沉到沙盒的东西只带**这一次**的短期票据，拿不到用户的长期凭据。

**为什么**：沙盒里跑的是模型产出的代码。它拿到长期凭据 = 那个凭据泄漏了。

**在哪**：`src/agent/sandbox-credentials.js`、`src/tools/context.js`
（工具只能看到 `ctx.credentialFacts` 这三个**布尔值**，看不到凭据本身）。

### #8 凭据不下发给浏览器，日志里也不出现

**要求**：接口回给前端的是"有没有凭据"（布尔），不是凭据。
日志只打长度或 fingerprint。前端不读 `document.cookie`。

**为什么**：「复制调试信息」会把界面状态整包交出去给人分析 ——
一旦顺手带上 cookie，用户每次贴调试信息就等于贴自己的登录态。

**在哪**：`/v1/auth/me` 的 `credentialFacts`、`src/logger.js` 的脱敏、
`web/src/lib/debug-bundle.js`。

**守它的**：
- 静态 `日志禁止打印凭据内容`
- 静态 `前端禁止读 document.cookie`（scope: `web/`）
- `test/debug-bundle.test.js`

### #9 worker 的文件接口必须逐段收口，不能只做词法检查

**要求**：`sandbox-worker/src/server.js` 里**不许**直接对调用方给的路径做
`readFile` / `writeFile` / `mkdir` / `rm` / `chown` / `createReadStream` / `realpath`，
一律经 `workspace-fs.js` 的 `*Confined` 系列。

**为什么**：这个进程是 **root**、跑在宿主的 mount namespace 里。
只做词法检查（resolve 后判前缀）挡得住 `../`，**挡不住软链接**：
job 在自己工作区里 `ln -s / esc`，一个 `GET /files?path=esc/…`
就成了以 root 读整台节点。收口做法是逐段 `O_NOFOLLOW` + 钉住父目录。

**在哪**：`sandbox-worker/src/workspace-fs.js`。

**守它的**：静态 `R9-worker 的 HTTP 面禁止直接对路径做 fs 操作`
（scope 精确到 `sandbox-worker/src/server.js`）。
`readdir`/`lstat` 不在拦截列表里 —— `listWorkspace` 用它们，
且拿到的已经是收口过的路径。

---

## 边界之外（诚实说明）

这九条管的是**软件层面的租户隔离**。它们不覆盖：

- **内核级逃逸**。沙盒是同一个宿主内核上的 namespace + cgroup，
  不是 microVM / gVisor。见 `sandbox-worker/README.md`「诚实的隔离边界」。
- **额度不是安全边界**。分组配额是"别让跑飞的任务烧光预算"，
  把人挪出分组就没了限制（`src/telemetry/quota.js`）。
- **agent 侧的出站**。进程内工具现在能连任意主机，
  白名单与 SSRF 防护在 agent 这边是空的（沙盒侧另有一套）。
  原先有一条静态规则守它，随 Cloud Bridge 一起移除了 ——
  理由和后果都写在 `scripts/check-isolation-rules.js` 里那段注释中。

---

## 加规则时

静态检查的价值取决于**它的输出为零**。一条永远红着、又没人修得了的规则，
会把 `npm run check:isolation` 的输出从"零告警 = 干净"退化成"有几条是老样子"，
于是真正的新违规混在里面没人看见。所以：

1. 加规则前先确认**当前代码是零命中**的；
2. 加完**两个方向都验一遍** —— 正确的写法不能被误报，
   故意写错一处必须被抓到（正则里的 `\s*` 回溯很容易让否定环视失效，
   `R2-AgentSession 必须保持 noTools: builtin` 第一版就栽在这上面，
   把两处写对的地方全判红了）；
3. 规则 id 里带上契约编号，让报错能对回本文件的某一节。
