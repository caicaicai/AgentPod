<p align="center">
  <h1 align="center">AgentPod</h1>
  <p align="center">
    可自托管的多租户 AI Agent 服务，支持沙盒隔离执行
  </p>
  <p align="center">
    <a href="#快速开始">快速开始</a> •
    <a href="#架构">架构</a> •
    <a href="#部署">部署</a> •
    <a href="#配置">配置</a> •
    <a href="#接口文档">接口文档</a> •
    <a href="docs/ARCHITECTURE.md">设计文档</a>
  </p>
  <p align="center">
    <a href="README.md">English</a> | 中文
  </p>
</p>

---

AgentPod 是一个**服务端多租户 AI Agent 服务**，基于 [pi](https://github.com/nicholasgasior/pi-coding-agent) 编程智能体引擎构建。单个 Node.js 进程可并发服务多个用户——每次请求创建一个 `AgentSession`，执行完毕即销毁，所有状态外置到可插拔的存储后端。

**核心特性：**

- **多租户隔离** — 会话、记忆、工作空间按用户强隔离，存储层强制分区，并通过静态分析规则和运行时隔离测试持续验证。
- **沙盒代码执行** — 命令运行在隔离的 Linux 命名空间中（PID/mount/network/uts/ipc），每个槽位独立 cgroup，租户间零共享。
- **对话界面** — 内置 Vue 3 聊天界面，支持 SSE 流式输出、项目管理、会话历史、斜杠命令。
- **作品（Artifact）** — 助手产出的成品**作为一组文件**单独存，不贴在对话里：多文件网页、Vue 3 单文件组件项目、Markdown 文档（支持 mermaid 图）、SVG、代码。**独立的作品库**（跨会话、可搜索筛选、带创建指引）+ 对话内的侧栏抽屉，实时预览、按文件读源码、切版本、下载；改一行走定点替换，不必整份重发。Vue 在浏览器里现编译、mermaid 自托管，**预览默认完全离线**，跑在不带 `allow-same-origin` 的沙箱 iframe + `default-src 'none'` 的 CSP 里 —— 模型生成的脚本既读不到登录态也出不了网。
- **分享与作品市场** — 一份作品可以变成一条 `/s/<token>` 的链接，**拿到的人不需要账号**就能打开，看到的始终是最新版；随时可撤销，撤了立刻失效。再点一次「发布到市场」才会出现在公开的广场 `/market` 上 —— 私发一条链接和"我愿意让所有人看见"是两个决定，不合成一个开关。访客那一页仍然只经手 JSON，作品跑在同一套沙箱 iframe 里：**服务端从不以 HTML 的身份吐出模型生成的内容**。整套可用 `ARTIFACT_SHARING_ENABLED=0` 关掉。
- **长期记忆** — 跨会话事实存储为人类可读的 `MEMORY.md`，用户和模型均可编辑。
- **项目管理** — 按项目分组会话，支持持久化的项目级指令和项目专属记忆。
- **定时任务** — 5 段 cron 表达式 + IANA 时区。模型可以在对话中直接创建定时任务。
- **可扩展技能** — 目录式技能系统（`SKILL.md` + `scripts/`），运行时自动注入沙盒。
- **用户工作空间** — 持久化共享存储，会话工作区和用户自建技能在沙盒销毁后仍然保留。
- **零冷启动** — 固定沙盒槽位池，命名空间预建。执行 = 在已运行的槽位中 spawn，无需等待。
- **Docker 就绪** — 三个镜像（Agent + Worker + Manager），`docker compose` 一键编排。

## 快速开始

### 本地开发（零外部依赖）

```bash
# 安装并构建前端（只需执行一次，修改 web/ 后需要重新构建）
npm run web:install
npm run web:build

# 启动：假模型 + 信任身份 + 本机执行
npm run dev

# 打开 http://127.0.0.1:8787
```

此模式使用 `LLM_MODE=faux`（假模型）、`AUTH_MODE=dev`（信任 `X-Username` 请求头）、`SANDBOX_MODE=local`（进程内执行）。无需 API 密钥、数据库或网络访问。

### 本地开发 + 沙盒集群

使用真正的命名空间隔离沙盒进行本地开发：

```bash
# 启动沙盒基础设施（worker + manager + redis）
docker compose -f docker-compose.sandbox.yml up -d

# 启动 agent 并连接沙盒集群
cp .env.sandbox.template .env.sandbox
npm run dev:sandbox

# 打开 http://127.0.0.1:8787（默认账号：admin / changeme）
```

### 全栈部署

```bash
# 一条命令启动所有服务（agent + worker + manager + redis）
cp .env.example .env    # 按需修改
docker compose up -d
```

### 前端开发

```bash
# Vite 开发服务器运行在 5273 端口，接口代理到 agent 进程
npm --prefix web run dev
```

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                          客户端                                  │
│                (对话界面 / API / 定时任务)                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Agent 主服务 (src/)                            │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌───────┐  ┌───────┐ │
│  │ 身份认证  │  │ 运行编排  │  │ 会话   │  │ 记忆  │  │ 定时  │ │
│  │ (Auth)   │  │(RunSvc)  │  │ 存储   │  │ 存储  │  │ 调度  │ │
│  └──────────┘  └────┬─────┘  └────────┘  └───────┘  └───────┘ │
│                     │                                           │
│                     ▼                                           │
│              ┌────────────┐     ┌──────────┐                    │
│              │  单轮执行   │────▶│  大模型   │                    │
│              │ (pi 引擎)  │     │  提供者   │                    │
│              └──────┬─────┘     └──────────┘                    │
│                     │                                           │
└─────────────────────┼───────────────────────────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼                       ▼
┌──────────────────┐    ┌──────────────────┐
│   沙盒 Worker    │    │  沙盒 Manager    │
│                  │    │                  │
│  ┌────────────┐  │    │   节点注册        │
│  │  槽位池     │  │    │   负载均衡        │
│  │(NS+cgroup) │  │    │   票据签发        │
│  └────────────┘  │    │                  │
│  命令行 / 浏览器  │    │    (Redis)       │
│  文件读写        │    │                  │
└──────────────────┘    └──────────────────┘
```

| 服务 | 镜像 | 运行身份 | 前置要求 |
|------|------|----------|----------|
| **Agent** | `Dockerfile` | 非 root（`agent` 用户） | — |
| **Worker** | `sandbox-worker/Dockerfile` | root | `--privileged` 或 `CAP_SYS_ADMIN` + `CAP_NET_ADMIN` |
| **Manager** | `sandbox-manager/Dockerfile` | 非 root（`manager` 用户） | Redis |

**Agent** 负责对话编排、会话/记忆/项目/定时任务管理和技能装载。**Worker** 提供命名空间隔离的命令执行环境。**Manager** 负责 Worker 节点注册、健康检查、负载均衡调度和短期票据签发。执行流量直连 Worker，不经过 Manager——Manager 只做控制面。

## 部署

### Docker Compose（推荐）

```bash
# 构建并启动所有服务
docker compose up -d

# 查看日志
docker compose logs -f agent
docker compose logs -f worker
docker compose logs -f manager
```

### 单独构建镜像

```bash
docker build -t agentpod-agent .
docker build -t agentpod-worker -f sandbox-worker/Dockerfile .
docker build -t agentpod-manager ./sandbox-manager
```

### Worker 部署前检查

沙盒 Worker 需要特权能力来建立命名空间隔离。部署前请先验证环境：

```bash
sandbox-worker/bin/check-namespace-caps.sh
```

### 生产环境检查清单

`NODE_ENV=production` 时，以下条件**在启动时强制校验**（不满足则拒绝启动）：

- `AUTH_MODE=password`（禁止 dev 身份信任）
- `SANDBOX_MODE` ≠ `local`（禁止进程内执行）
- `LLM_MODE` ∉ `{faux, direct}`（禁止假模型和直连模式）
- `DEV_CONSOLE=0`（禁止暴露调试端点）
- `FALLBACK_COOKIE` 必须为空

## 配置

所有配置通过环境变量传入，启动时校验。配置错误会导致进程以退出码 2 退出。

也可以使用 `.env` 文件（默认读取 `<cwd>/.env`，或通过 `ENV_FILE=<路径>` 指定）。**真实环境变量始终优先于文件。**

完整的带注释配置参考见 [`.env.example`](.env.example)。

### 核心配置

| 变量 | 取值 | 说明 |
|------|------|------|
| `AUTH_MODE` | `password` \| `dev` | `password`：内置账号密码 + JWT 会话。`dev`：信任 `X-Username` 头（仅本地开发） |
| `LLM_MODE` | `platform` \| `direct` \| `faux` | 模型提供方式。`platform`：从平台后端获取。`direct`：直连 OpenAI 兼容端点。`faux`：假模型 |
| `SANDBOX_MODE` | `manager` \| `http` \| `local` \| `none` | 执行后端。`manager`：集群模式 + 票据鉴权（推荐）。`http`：直连 Worker。`local`：进程内执行（仅开发） |
| `SESSION_STORE` | `memory` \| `file` \| `mysql` | 会话持久化。`file` 落盘到 `DATA_DIR`。`mysql` 适合多副本部署 |
| `DATA_DIR` | 路径 | 会话、记忆、项目、定时任务的存储根目录。默认：`~/.agentpod` |

### 功能开关

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMORY_ENABLED` | `1` | 跨会话长期记忆 |
| `PROJECTS_ENABLED` | `1` | 项目分组 + 项目级指令 |
| `SESSION_AUTO_TITLE` | `1` | 第一轮让模型给会话起标题（一个会话一次） |
| `ARTIFACTS_ENABLED` | `1` | 作品：带版本的成品，独立于对话正文 |
| `ARTIFACT_ALLOWED_ORIGINS` | 空 | 作品预览允许加载的外部源（逗号分隔）。**默认完全离线**（Vue / mermaid 运行时自带，无需 CDN） |
| `ARTIFACT_MAX_FILES` | `40` | 一份作品最多几个文件 |
| `ARTIFACT_SHARING_ENABLED` | `1` | 作品分享链接（`/s/<token>`，**免登录可访问**）。这是唯一一条不要求身份的数据通道 |
| `ARTIFACT_MARKET_ENABLED` | `1` | 公开的作品市场（`/market`）。只收录作者**显式发布**的作品 |
| `CRON_ENABLED` | `1` | 定时任务 |
| `WEB_UI` | `1` | 在 `/` 提供内置对话界面 |
| `DEV_CONSOLE` | `0` | 调试端点（生产环境必须为 `0`） |

### 认证配置（Password 模式）

| 变量 | 说明 |
|------|------|
| `CONSOLE_USERS` | `用户名:密码,用户名:密码` — 逗号分隔的凭据列表 |
| `SESSION_SECRET` | JWT 签名密钥（不配则自动生成，进程重启后所有会话失效） |
| `SESSION_TTL_HOURS` | 会话令牌有效期，默认 24 小时 |

### 直连模型（Direct 模式）

本地开发时直连真实模型（无需平台后端）：

| 变量 | 示例 | 说明 |
|------|------|------|
| `LLM_DIRECT_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容端点 |
| `LLM_DIRECT_API_KEY` | `sk-xxx` | API 密钥 |
| `LLM_DIRECT_MODEL` | `gpt-4o-mini,gpt-4o` | 逗号分隔，第一个为默认模型 |
| `LLM_DIRECT_INPUT` | `text,image` | 支持的输入模态 |

### 沙盒配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_SLOTS` | `2` | 每个 Worker 的并发隔离槽位数 |
| `SANDBOX_TIMEOUT_MS` | `120000` | 命令执行超时（毫秒） |
| `SANDBOX_KEEPALIVE` | `1` | 长时间模型思考时周期性续期租约 |
| `SANDBOX_EXEC_ASYNC` | `1` | 异步执行 + 断线续传 |

### 并发与限制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_CONCURRENT_RUNS` | `8` | 全局并发运行上限 |
| `MAX_RUNS_PER_USER` | `2` | 每用户并发运行上限 |
| `RUN_TIMEOUT_MS` | `600000` | 单次运行最长时间（10 分钟） |

## 接口文档

### 健康与诊断

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz` | 存活探针 + 并发水位 + 已开启的功能 |
| GET | `/metrics.json` | 运行时长分位、失败分布、token 用量 |
| GET | `/v1/auth/me` | 当前认定的身份（未登录返回 401） |

### 对话

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/stream` | 发起对话（SSE 流式响应） |
| POST | `/v1/runs/:runId/abort` | 中止运行中的对话（仅限自己的） |
| GET | `/v1/models` | 可用模型列表 |

**SSE 事件类型：** `run_start` · `model` · `thinking` · `text` · `text_end` · `tool_call` · `tool_result` · `usage` · `final` · `error`

### 会话

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/sessions` | 会话列表。`?projectId=` 按项目筛选，`?includeArchived=1` 含已归档 |
| GET | `/v1/sessions/:key` | 会话历史（已转为可渲染消息） |
| PATCH | `/v1/sessions/:key` | 修改标题 / 置顶 / 归档 / 项目归属 |
| DELETE | `/v1/sessions/:key` | 删除会话 |
| GET | `/v1/search?q=` | 搜索会话（标题 + 正文，命中正文时返回摘要片段） |

### 项目

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/projects` | 项目列表 |
| POST | `/v1/projects` | 新建项目 |
| GET | `/v1/projects/:id` | 项目详情 |
| PATCH | `/v1/projects/:id` | 修改名称 / 描述 / 指令 / 归档状态 |
| DELETE | `/v1/projects/:id` | 删除项目（会话退回未分组，不删除） |

### 作品

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/artifacts?sessionKey=` | 作品清单（**不含正文**）+ 预览允许的外部源 |
| GET | `/v1/artifacts/:id?v=` | 详情，含该版**全部文件的内容**。不传 `v` 取最新版 |
| GET | `/v1/artifacts/:id/raw?path=&v=&download=1` | 单个文件的原文（`path` 不传取入口文件）。**一律 `text/plain` + `nosniff`** —— 本服务从不以 HTML 的身份吐出模型生成的内容 |
| DELETE | `/v1/artifacts/:id` | 删除作品（所有版本一起删） |
| POST | `/v1/artifacts/:id/share` | 生成分享链接。**幂等** —— 已分享过就回原来那条，不会把已发出去的作废 |
| PATCH | `/v1/artifacts/:id/share` | `{ market, summary }`：上/下作品市场、改那句简介 |
| DELETE | `/v1/artifacts/:id/share` | 撤销分享，链接立刻失效 |

### 公开分享（**不需要身份**）

整个服务里只有这一组接口在鉴权之前。三条约束：**只认 token**（没有任何"报上 id 就能读"的入口）；
失败一律 404（不区分"没这个链接"和"被撤销了"，否则就成了探测 token 是否存在的口子）；
正文一律 `text/plain`。分享**始终跟随最新版**，作者出新版本，访客刷新就能看到。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/public/shares/:token` | 元信息 + **最新版全部文件的内容**。不含 `sessionKey` / `projectId` / 版本全表 |
| GET | `/v1/public/shares/:token/raw?path=&download=1` | 单个文件的原文。与登录态那条共用同一个下发函数，一样是 `text/plain` + `nosniff` |
| GET | `/v1/public/market?q=&kind=` | 作品市场清单（**不含正文**），按发布时间倒序 |
| GET | `/s/:token`、`/market` | 页面本身。回的是**本服务自己的** SPA 骨架，不是那份作品的 HTML |

写入只能由模型经 `artifact` 工具完成，没有对外的写接口。

### 记忆

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/memory?projectId=` | 读取记忆（个人或项目级） |
| PUT | `/v1/memory?projectId=` | 更新记忆（需携带 `revision` 做乐观锁，冲突返回 409） |

### 定时任务

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/crons` | 任务列表 |
| POST | `/v1/crons` | 新建任务 |
| GET | `/v1/crons/:id` | 任务详情 |
| PATCH | `/v1/crons/:id` | 修改任务（含启停） |
| DELETE | `/v1/crons/:id` | 删除任务 |
| POST | `/v1/crons/:id/run` | 立即执行一次 |

### 技能与工作空间

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/skills` | 技能列表（含可用性状态） |
| GET | `/v1/workspace` | 用户工作空间用量与配额 |

## 技能系统

技能以目录为单位——每个技能是一个包含 `SKILL.md`（使用说明）和 `scripts/`（可执行代码）的文件夹：

```
my-skill/
├── SKILL.md           # 模型的使用说明
└── scripts/
    ├── run.sh         # 入口脚本
    └── ...
```

技能从 `SKILL_DIRS`（冒号分隔的目录列表）加载。运行时，技能目录会被自动注入到沙盒工作区中供模型执行。

模型也可以在对话中通过 `skill_save` 工具**自行创建技能**，持久化到用户工作空间以便后续会话使用。

**能力闸门**：没有沙盒后端时，技能不会被宣告给模型——与其注册后让模型反复尝试失败，不如让它完全不知道有这个能力。

## 用户工作空间

配置 `USER_WORKSPACE_ROOT` 后，每个用户获得独立的持久化存储，沙盒销毁后内容依然保留：

```
<root>/users/<username>/
  skills/created/<name>/        用户自建技能（沙盒内只读）
  skills/installed/<name>/      已安装技能（沙盒内只读）
  sessions/<key>/workspace/     会话工作区（读写，会回写同步）
```

只有 `workspace/` 的内容会从沙盒同步回来。这可以防止失控的脚本修改已安装的技能。

## 开发

### 项目结构

```
src/                    Agent 主服务
├── agent/              运行编排、工具装配、技能装载
├── http/               路由、SSE 流、优雅停机
├── identity/           身份认证（密码 JWT / dev 头信任）
├── models/             大模型客户端、模型工厂、重试逻辑
├── sessions/           会话存储（memory / file / mysql）
├── memory/             长期记忆（MEMORY.md + 乐观锁）
├── projects/           项目管理（分组 + 指令）
├── cron/               定时任务（5 段 cron + 时区）
├── sandbox/            沙盒客户端（manager / http / local / none）
├── workspace/          用户工作空间（共享存储）
├── tools/              扩展工具（任务规划、浏览器、记忆、定时任务）
├── persistence/        文件存储原语
├── credentials/        凭据代理
└── telemetry/          指标采集

web/                    对话界面（Vue 3 + Vite）
├── src/stores/         全局状态（reactive 单例，无状态库）
├── src/lib/            接口封装、SSE、Markdown、调试信息
└── src/components/     侧栏、对话区、工具卡片、抽屉面板

sandbox-worker/         沙盒执行器（独立容器）
├── src/namespace/      PID/mount/network 命名空间 + cgroup
├── src/browser/        Playwright 浏览器自动化
└── src/manager/        Manager 注册 + 票据校验

sandbox-manager/        沙盒管理台（集群控制面）
├── src/lib/            节点注册、调度器、票据签发
└── web/                管理控制台（Vue 3）

managed-skills/         平台技能（从外部仓库同步）
builtin-skills/         内置技能（云端浏览器、技能创作）
scripts/                隔离契约静态检查（CI 必跑）
test/                   隔离回归 + 集成测试
```

### 测试

```bash
# 运行全部检查（静态隔离规则 + 单元/集成测试）
npm run check

# 仅测试
npm test

# 仅隔离契约静态分析
npm run check:isolation
```

隔离测试同时包含**正向**（并发多用户互不可见）和**反向**（故意破坏 username 过滤，断言测试必须失败）两种用例。反向用例确保检测器本身是工作的——没有它，测试通过可能只是因为检测器坏了。

### 隔离契约

多租户隔离通过多个层次强制保障：

1. **静态分析**（`scripts/check-isolation-rules.js`）— 扫描源码中的凭据泄漏和禁止模式
2. **运行时守卫**（`src/agent/run-turn.js`）— 每次运行严格限定在单个 username 范围内
3. **存储隔离** — 所有数据路径以 username 作为分区键
4. **沙盒隔离** — 每个槽位拥有独立的 Linux 命名空间，租户数据绝不共置

运行 `npm run check:isolation` 验证静态规则。此检查在 CI 中运行，合并前必须通过。

## 技术栈

- **运行时**：Node.js ≥ 20.11（ESM）
- **Agent 引擎**：[@mariozechner/pi-coding-agent](https://github.com/nicholasgasior/pi-coding-agent)
- **前端**：Vue 3 + Vite
- **沙盒**：Linux namespaces + cgroups（PID/mount/network/uts/ipc 隔离）
- **管理台**：Fastify + TypeScript + Redis
- **数据库**：MySQL（可选，多副本会话存储）
- **容器化**：Docker + Docker Compose

## 参与贡献

欢迎贡献！在修改任何涉及用户数据或凭据的代码之前，请先阅读隔离契约文档：

1. Fork 本仓库
2. 创建功能分支（`git checkout -b feature/amazing-feature`）
3. 运行全部检查（`npm run check`）
4. 提交更改
5. 推送分支并创建 Pull Request

**提交前请确保** `npm run check` 通过。静态隔离规则和测试的存在是为了防止多租户数据泄漏——破坏它们的 PR 不会被合并。

## 许可证

[MIT](LICENSE)
