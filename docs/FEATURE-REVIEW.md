# 功能盘点：还缺什么、还能加强什么

> 一次外部视角的通读结论（代码为准，不看 README 的自述）。
> 基线：`npm run check` 全绿 —— 隔离契约 + 1325 条用例 + lint 全过，前端能构建。
> 下面列的**不是 bug 报告**，是"这个项目要往下走，缺的那几块"。

盘完的整体判断：**内核比外壳成熟得多**。多租户隔离、沙盒 namespace、作品的
安全边界、用量台账这几处的设计密度明显高于同类项目 —— 该想到的边界情况都在
注释里写着为什么。真正的缺口集中在三个方向：

1. **闭环缺一段** —— 有些能力做到"能跑"就停了，没做到"用户知道它跑了"（定时任务、配额）；
2. **只能被人用，不能被程序用** —— 全服务唯一的身份是浏览器 JWT，没有对外集成面；
3. **单租户假设的尾巴** —— 公开面（市场 / 分享）缺治理，长期运行缺回收。

---

## P0 · 说了但没做到的 —— ✅ 已完成

这几条的共同点：**文档或配置已经承诺了，代码里是空的**。留着比没有更糟 ——
读的人会按承诺去用。

> **状态：六条全部处理完毕**，另外顺手补掉了执行过程中发现的三个同类问题
> （见本节末尾「过程中发现的」）。改动清单：
>
> | # | 结论 |
> |---|---|
> | 1 | 补 `LICENSE`（MIT）+ `package.json` 的 `license` 字段；新增 `test/docs-links.test.js` 守住 |
> | 2 | `MIGRATION.md` 的三处引用全部消解 —— 进度表**内联**进 ARCHITECTURE.md，不再外包给不存在的文件 |
> | 3 | `web_search` 死配置整条删除（config.js / run-service.js / .env.example），并在 `src/tools/index.js` 写明为什么不留 |
> | 4 | ARCHITECTURE.md 的"诚实清单"重写为表格并纠正"断线续接"；两份 README 补上 `/v1/runs` 与 `/v1/runs/:runId/events` |
> | 5 | CI 挂上 `mysql:8.0` service 并设 `AP_TEST_MYSQL_URL` —— 存储契约的真库那一遍第一次真的会跑。⚠️ **改动在 [`docs/patches/ci-mysql-service.patch`](patches/ci-mysql-service.patch)，需要有权限的人手工应用**（GitHub App 没有 `workflows` 权限，带着这类改动推分支会被服务端拒绝） |
> | 6 | 4 条依赖告警逐条判可达性，结论写进 `docs/SECURITY-NOTES.md`；并补了一条静态规则把结论的前提**固化** |

### 1. `LICENSE` 文件不存在

两个 README 的结尾都写着 `[MIT](LICENSE)`，`package.json` 里也**没有 `license` 字段**。
一个对外开源、README 写了 Contributing 流程的项目，仓库里没有许可证文本，
法律上等于"保留所有权利"—— 任何人都不能合法使用它。

- 证据：`README.md:740`、`README.zh-CN.md:709` 链接到不存在的 `LICENSE`；`package.json` 无 `license`

### 2. `docs/MIGRATION.md` 不存在，但被引用了三次

`docs/` 下只有 `ARCHITECTURE.md`。而：

- `ARCHITECTURE.md:49` —— "openclaw 是 MIT，计划挑出来做成 `pi-hardening/`，见 MIGRATION.md"
- `ARCHITECTURE.md:200` —— "见 MIGRATION.md 的**进度表**"
- `managed-skills/README.md:15` —— "完整推理见 `docs/MIGRATION.md`「技能要跑起来还差什么」"

第二条尤其要命：架构文档把"还没做什么"这个问题**整个外包**给了一个不存在的文件。
要么补上，要么把进度表挪进 ARCHITECTURE.md。

### 3. `web_search` 是一条完整的死配置

`WEB_SEARCH_HOST` / `WEB_SEARCH_TENANT_CODE` 被解析（`src/config.js:625`）、
被一路传进工具上下文（`src/agent/run-service.js:338`），**然后没有任何东西读它** ——
全仓库没有名为 `web_search` 的工具。`.env.example:489` 还给它写了一节
"联网搜索（web_search 工具）"。

于是部署方照着 `.env.example` 配好搜索网关，重启，什么都不会发生，也没有任何日志说不对。
两个出口二选一：**把工具实现掉**（见 P1-①），或者**把配置删干净**。

### 4. 架构文档的"诚实清单"已经不诚实了

`ARCHITECTURE.md:200-201` 说当前骨架没有：知识库、**断线续接**、真实凭据代持、VNC。

但断线续接**已经做完了**：`src/agent/run-registry.js` 是事件缓冲，
`runService.attach()` 在 `run-service.js:594`，HTTP 面是 `/v1/runs/:runId/events`
（`server.js:1243`），`/healthz` 还宣告了 `runResume` 能力位，
`test/run-resume.test.js` 专门测了序号、重放、丢帧、归属校验。

顺带：**`/v1/runs` 和 `/v1/runs/:runId/events` 两条接口在两个 README 里都没有** ——
API 表只列了 `/v1/runs/:runId/abort`。做完了的功能对外不可见。

### 5. CI 从来没跑过 MySQL 存储契约

README 明确写着：

> Point `AP_TEST_MYSQL_URL` at a scratch database to additionally run the storage
> contract against real MySQL — **CI should do that, since it is what catches the
> double drifting from the real backend.**

而 `.github/workflows/ci.yml` 里**没有 mysql service**，也没设这个变量。
`test/storage-drivers.test.js:21` 的注释同样假定 CI 会跑。

也就是说：唯一能发现 `test/helpers/memory-storage.js` 与真实 MySQL 行为漂移的那道闸，
一次都没关过。补法很短 —— 给 test job 加一个 `services: mysql` 和一行环境变量。

### 6. 依赖链上的安全告警一直红着，没有结论

`npm audit --omit=dev` 报 **2 条 high**（外加同一棵树上的 2 条 low，共 4 条 advisory），
全部来自 `@mariozechner/pi-coding-agent`。`npm audit fix --force` 会把 pi 降到 0.49.3 ——
破坏性降级，且**修不了**：这几条的影响范围是 `<=0.73.1`，而 0.73.1 就是当前最新版，
上游还没发出修好的版本。

> 📝 **修正**：我在第一版报告里把这条写成"两条 high，来自 extract-zip，大概率经 playwright"。
> 逐条查下来两处都不准 —— 实际是 4 条 advisory（2 high + 2 low），
> 且 `extract-zip` 是 pi 自己用来下载解压 `fd`/`rg` 二进制的，与 playwright 无关。

逐条判完的结论：**四条全部不可达**，依据写进了
[SECURITY-NOTES.md](SECURITY-NOTES.md)（含复核方法和"什么时候必须回来重看"）。
两条 high 不可达的共同前提是"pi 的内置工具没被启用" —— 而这个前提在此之前
**只由代码注释守着**（`noTools: 'builtin'` 旁边写着"不要改"），
所以顺手补了一条静态规则 `R2-AgentSession 必须保持 noTools: builtin` 把它固化。

值得单独说一句的是**为什么要写这份文件而不是让它继续红着**：
一个 `npm audit` 长期红着的项目，最后一定没人看它 ——
于是真出现一条该管的告警时，它和这几条一起被划过去。
要么修掉，要么写清楚为什么不修，没有第三种状态。

### 过程中发现的（同一类问题，一并修了）

第 1 条那个"README 链接到不存在的 LICENSE"，一开始是靠人眼看出来的。
既然要修，就顺手写了 `test/docs-links.test.js` 去扫**全仓库所有 markdown 的相对链接**
—— 结果它当场又抓出两条我没看见的：

- `managed-skills/README.md` → `../skill-libs/README.md`（**不存在**）
  → 补上了那份 README（说清 `skill-libs/` 与 `managed-skills/` 的分工：
  一个进 worker 镜像、一个进 agent 镜像，搞混的表现是"模型说有这个技能、进去却找不到脚本"）
- `sandbox-manager/README.md` → `docs/PROTOCOL.md`（**不存在**，被引用 3 次）
  → 那份协议文档没有随仓库开源；把三处引用改指到真实存在的
  `sandbox-worker/PROTOCOL.md` 与代码，并删掉了一整块**描述不存在目录**的目录树
  （`workers/`、`modules/`、`docs/` —— 照着找的人会以为自己 clone 少了东西）

第三条是修第 6 条时撞见的：`scripts/check-isolation-rules.js` 在检查失败时
打印"详见 docs/ISOLATION-CONTRACT.md"，`src/agent/run-turn.js` 开头写着
"改这个文件前先读 docs/ISOLATION-CONTRACT.md"，另有两处引用 ——
**而这个文件不存在**。这比断个链接严重：它是这个项目全部安全前提的落点，
四处引用里有一处还是人看到报错时的第一指引。

已按代码实况补齐（`docs/ISOLATION-CONTRACT.md`）：九条规则逐条写明
*要求 / 为什么 / 在哪 / 谁守着*，并标注了边界之外的东西（内核逃逸、
额度不是安全边界、agent 侧出站白名单是空的）。

**这三条都不是我一开始列出来的** —— 值得记一笔：断链这种问题人眼扫不干净，
但一条二十行的测试可以，而且以后不会再犯。

---

## P1 · 功能缺口（有明确用户价值，成本可控）

### ① 知识库 / 文档检索 —— 最大的一块空白

架构文档自己把"知识库"列在第一位。而 `test/builtin-skills.test.js:85` 的工具名正则里
躺着 `knowledge_search`、`list_knowledge_bases`、`file_upload` —— 桌面端 AP 扩展有这些，
云端一个都没有。

现状的替代品是**附件**，但那是一次性的：`src/agent/attachments.js` 把文本拼进 prompt，
本轮用完即弃，下一轮模型就不记得了。用户想"让它记住这 20 份规范文档"，
今天只能每次重传，且受 `MAX_TOTAL_DOCUMENT_CHARS = 100_000` 顶着。

这块最重，但也是"AI agent 服务"与"能跑命令的聊天框"的分水岭。
好消息是**落点已经现成**：`src/tools/plugin-api.js` 的插件形态 + `PLUGIN_REGISTRY`
的能力闸门（`src/tools/index.js:25`）就是为这种东西准备的 —— 后端没配就不注册，
模型压根不知道有这个能力，不会反复试错。

### ② 二进制文档附件（PDF / docx / xlsx）

`web/src/modules/chat/attachments.js:6` 的注释说得很直接：
"二进制文档（pdf/docx…）没有可拼的文本"，于是直接拒掉。

但用户手上最常见的就是 PDF。而这个项目**已经有一个能跑任意命令的沙盒** ——
把文件丢进 slot、在里面 `pdftotext` / `python-docx` 抽文本，比在 agent 进程里
引一堆解析库干净得多，也符合"重活下沉沙盒"的既有分工。

### ③ 用户看不到自己的用量和配额

这条的性价比最高，因为**数据和方法都已经写好了**。

`src/telemetry/quota.js:111` 的注释原文：

> 分成两个方法是为了让"要不要拦"这件事**可以被读出来**：将来界面上要画
> 一条"本月已用 82%"的进度条，用的就是这里回的 used/limit

`quota.check()` 已经返回 `{ totalLimit, dailyLimit, usedTotal, usedToday }`，
`usage-store` 也有 per-user 的 `trend()` / `summary()`。但对外只有
`/v1/admin/usage`（管理员专用），**没有 `/v1/usage` 这种自助口**。

结果就是：用户跑着跑着突然吃一个 403（总额度用尽）或 429（当日用尽），
在此之前**界面上没有任何征兆**，事后也查不到自己用了多少。
403 那条还特别难受 —— 文档说"waiting won't help"，得找管理员，
而用户完全不知道自己撞的是哪堵墙。

补一条 `GET /v1/usage` + 账号面板里一条进度条，服务端几乎零新逻辑。

### ④ 定时任务跑完，没有任何人被告知

`src/cron/scheduler.js` 会执行任务、把结果写进 `fireLog`（`store.js:182`），
然后……就没了。凌晨三点跑完的那份周报，静静躺在一个会话里等人自己想起来去看。
失败同理：`scheduler.js:154` 只是 `logger.warn`。

而这个项目**已经有一个可用的 SMTP 客户端**（`src/mail/smtp.js`，两百行，
`src/mail/mailer.js` 封装），今天只服务于一件事 —— 发注册验证码。
账号表里也存着 email（`user-store.js:344`）。

加一个"任务完成/失败后发信 or 打 webhook"的开关，是**复用现成件**，不是新建子系统。
没有它，定时任务这个功能其实是半个 —— 它解决了"我不在的时候也要跑",
但没解决"跑完了我怎么知道"。

### ⑤ 定时任务的历史只显示最后一条

`fireLog` 保留最近 **20** 条（`FIRE_LOG_MAX = 20`），每条带截断到 1000 字的回复。
而 `CronPanel.vue:19` 只取 `fireLog[fireLog.length - 1]`。

19 条已经落库、已经随接口下发、前端拿在手里的数据，界面上看不到。
一个"展开历史"的折叠区，纯前端改动。

### ⑥ `/metrics.json` 没有任何监控系统能读

`src/telemetry/metrics.js:2` 的开篇：

> 极简指标聚合。**生产接 Prometheus** / 内部监控时把 recordX 换成打点即可

但对外只有一个自定义 JSON（`server.js:399`）。Prometheus / VictoriaMetrics /
Grafana Agent 都不认这个形状，接的时候要么写 exporter，要么改代码。

加一条 `GET /metrics`（text exposition format）大约五十行，
`snapshot()` 里的数据结构现成。同时建议把 `runs.byStatus`、`durationMs` 的分位数
换成真直方图 —— 现在是留最近 1000 条排序取分位（`metrics.js:26`），多副本下不可聚合。

### ⑦ `/healthz` 不检查任何依赖，也没有 `/readyz`

`server.js:345` 的 `/healthz` 无条件 `ok: true` —— 它报的是并发数、开了哪些功能、
认证模式，**唯独不碰 MySQL 和沙盒 manager**。

后果很具体：一个连不上数据库的副本，`/healthz` 照样 200，
k8s / 负载均衡照样往里送流量，用户拿到的是每一条请求都 500。

要分两个口：`/healthz`（进程活着，保持现状）+ `/readyz`（依赖可用，ping 一下库和 manager）。
这是"三个容器 + compose 交付"的项目的标配。

---

## P2 · 平台化缺的那几块

### ⑧ 没有对外的程序化访问（API Key / 服务令牌）

**全服务唯一的身份是浏览器 JWT**（`src/identity/index.js`，`Authorization: Bearer`，
默认 24 小时过期，改密即失效）。没有 API Key，没有 PAT，没有 service account。

这一条卡住的东西比看上去多：

- 无法从 CI / 脚本 / 别的服务调用 agent —— 这类自托管 agent 服务最常见的用法之一；
- `sandbox-manager` 有 `X-API-SecurityCode`（`middleware/api-key.ts`），
  agent 服务反而没有对等物，两边不一致；
- **它和定时任务的凭据难题是同一个问题**。`ARCHITECTURE.md` 第 4 节把
  `CRON_CREDENTIAL_MODE=stored`（把用户登录态 0600 落盘）称为"带明确退出条件的临时方案"，
  条件是"平台支持代持"。一套服务端签发、可吊销、可限权限、不绑浏览器会话的令牌体系，
  正好就是那个退出条件。

### ⑨ 没有审计日志

全仓库 `grep -i audit` **零命中**。而管理台能做的事包括：创建/禁用账号、
改角色、改分组配额、增删模型、**改模型 API key**。这些操作过后，
没有任何地方记着"谁、什么时候、改了什么"。

对一个把隔离契约做到静态检查 + 正反两向测试的项目来说，这块空得有点反常。
一张 append-only 的 `ap_audit` 表 + 管理台一个只读页面就够，
不需要做成完整的合规系统。

### ⑩ 公开面（市场 / 分享）没有治理，也没有限流

`/market` 和 `/s/:token` 是**服务里仅有的两条免鉴权路径**，设计上很克制
（token-only、一律 404、永远 `text/plain`、iframe 不给 `allow-same-origin`）。
但那些防的是**内容执行**，不是**内容滥用**：

- `shares.setMarket()`（`shares.js:263`）只校验作者本人，**没有任何管理员通道** ——
  管理员无法下架任何东西。`listMarket()` 里也没有过滤位。
- 没有举报入口，没有人均上架数上限（只有一个全局 `MARKET_LIMIT` 截断）。
- **限流只加在登录上**（`server.js:233/239` 是全仓库仅有的两个 `createRateLimiter`）。
  `/v1/public/*` 完全不限速 —— 而它免鉴权、要读库、还要吐全部文件内容。

一旦 `AUTH_ALLOW_REGISTER=1`，"任何人注册 → 往公开 URL 上挂东西 → 管理员没有铲子"
就成立了。至少要有：管理员强制下架 + 公开面按 IP 限速。

### ⑪ 没有数据保留策略，长期运行只增不减

作品有单版文件数/字节/版本数上限（`ARTIFACT_MAX_*`），工作空间有配额
（默认 200MB，`workspace/store.js:130`）。但是：

- **会话没有任何上限**，也没有过期清理。MySQL 里只涨不落。
- **每人的作品总数没有上限** —— 限的是"单个作品多大"，不是"能有多少个"。
- 没有任何后台 GC / 归档任务，管理台也没有"这个人占了多少存储"这种视图。

对一个明确面向多租户长期部署的服务，这是个会在第 18 个月才发作的问题。

### ⑫ 模型没有故障转移

`src/models/retry.js` 做得很细致 —— 专门教会 pi 认我们网关那些非标准错误文案。
但它重试的是**同一个模型**。上游某个模型整个挂掉时，没有"退到备用模型"这条路。

`ARCHITECTURE.md:48` 自己点了名：迁移到 pi 时丢掉的 openclaw 补丁里就包括
**model failover**。`LLM_MODE=db` 下模型列表带 `sort` 和 `enabled`，
"顺位下一个可用模型"的数据基础是有的。

---

## P3 · 更大的工程（要先立项再动手）

### ⑬ 界面只有中文，且是硬编码

`web/index.html` 写死 `<html lang="zh-CN">`，所有文案内联在 `.vue` 里，
没有 i18n 层、没有语言开关。而 README 是**双语**的，明显在招国际用户 ——
英文 README 领进来的人，打开界面看到的是全中文。

这是个纯体力活但面积大（54 个前端文件）。真要做，建议先抽 `web/src/locales/`
再逐页替换，而不是一次性大改。

### ⑭ 对话本身不能编辑、重发、分叉、导出

- 消息发出去就定死了 —— 没有"改一下再发一遍"，没有"重新生成"。
  写错一个字只能新开一轮，而上一轮的 token 已经烧了。
- 没有分支（同一个提问试两种走向）。
- **会话无法导出**。作品能下载，对话不能 —— 连 Markdown 导出都没有。
  `src/sessions/transcript.js` 已经把 JSONL 归一成了可渲染的消息列表，
  再落一个 Markdown 序列化器不难。

pi 的会话是 append-only 树，**结构上本来就支持分叉** —— 这是少见的
"底层已经具备、只差上层"的情况。

### ⑮ 压缩和起标题的开销不进台账

文档很诚实地承认了（`ARCHITECTURE` / README「Cost accounting」）：
压缩走 `completeSimple`，绕过会话事件流，**不进 `ap_usage`**。
`src/sessions/title.js:22` 的自动起标题同样是 `completeSimple`，同样不记账。

于是管理台的成本数字**系统性偏低**，且偏低多少无法估计。
在 `completeSimple` 外面包一层记账（带 `source: 'compaction' | 'title'` 维度）
能把这个洞补上，顺带让"压缩到底花了多少钱"变成一个可回答的问题。

---

## 建议的下手顺序

| 批次 | 内容 | 量级 | 为什么排这儿 |
|---|---|---|---|
| **第一批** | P0 全部（1–6） | 半天 | 都是"承诺了没做到"，成本极低，且第 1 条是法律问题 |
| **第二批** | ③ 用量自助口 · ⑤ 定时任务历史 · ⑥ Prometheus · ⑦ readyz | 2–3 天 | 全是"数据已经在手里，只差一个出口"，几乎不新增逻辑 |
| **第三批** | ④ 定时任务通知 · ⑩ 公开面治理 + 限流 · ⑨ 审计日志 | 1 周 | 复用现成件（SMTP / 限流原语 / KV 表），补的是闭环和治理 |
| **第四批** | ⑧ API Key 体系 | 1–2 周 | 它同时是 cron 凭据方案的退出条件，做完能拆掉一个临时方案 |
| **再往后** | ① 知识库 · ② 文档解析 · ⑫ 模型故障转移 | 各自立项 | 都是独立子系统，值得单独设计 |
| **看定位** | ⑬ i18n · ⑭ 对话编辑/分叉/导出 | 大 | 取决于是否真的要面向国际 / 对标通用 chat 产品 |

---

## 最后一句

这个项目**不缺设计能力** —— 隔离契约的正反双向测试、作品渲染的两道独立防线、
配额"最后一轮必然超发"的取舍说明，这些都是想透了才写得出来的东西。

它缺的是**把已经做完的东西暴露出来**（用量、任务历史、指标、断线续接的文档），
以及**从"一个人用得很好"走到"一群人长期用"**所需要的那几件枯燥设施
（审计、治理、保留策略、程序化入口）。

P0 和第二批加起来不到一周，能显著改变项目给人的"完成度"观感 ——
因为它们修的全是"看起来没做"而其实"做了没说"的地方。
