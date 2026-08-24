# 依赖安全告警：结论与依据

`npm audit --omit=dev` 目前报 **2 条 high**，都来自同一棵依赖树
（`@mariozechner/pi-coding-agent`）。这份文件记录的是**每一条为什么现在不动它**，
以及什么时候必须回来重新看。

> 为什么要有这份文件：`npm audit` 长期红着的项目，最后一定没人看它 ——
> 于是真出现一条该管的告警时，它和这几条一起被划过去。
> 要么修掉，要么写清楚为什么不修，**没有第三种状态**。

**最后核对：2026-08-25**（`@mariozechner/pi-coding-agent@0.73.1`，当时的最新版）

## 为什么不能直接 `npm audit fix --force`

`npm audit fix --force` 会把 pi 降到 **0.49.3** —— 一个破坏性降级，跨了二十多个
小版本。而这几条告警的修复范围是 `<=0.73.1`，**0.73.1 就是当前最新版**：
上游还没有发出修好的版本，降级换来的不是"修好了"，是"换一批别的问题"。

```
$ npm view @mariozechner/pi-coding-agent version
0.73.1          ← 已经是最新
```

所以现在的正确动作是**盯着上游**，不是动版本号。

## 逐条结论

### 1. GHSA-jfgx-wxx8-mp94（high）— 扩展安装的临时路径可预测，共享主机上可提权

> Predictable temporary extension install paths allow local privilege escalation
> on shared Linux hosts · 范围 `>=0.50.0 <=0.73.1`

**不可达。** 这条要求进程去**安装 pi 扩展**。本服务从不安装扩展：
工具集完全由我们自己装配（`src/agent/tools.js` 的 `buildTools()`），
`AgentSession` 一律以 `noTools: 'builtin'` 创建
（`src/agent/run-turn.js:377`、`src/agent/compact-turn.js:145`，两处都标了"不要改"），
仓库里没有任何一处调用 pi 的扩展安装路径。

⚠️ 附带条件：CVSS 向量是 `AV:L`（本地攻击），前提是"共享 Linux 主机上有别的不可信用户"。
agent 容器里只跑我们自己的进程，**模型产出的命令一律下沉沙盒**，
不在 agent 这个容器里执行 —— 这一点由隔离契约 #2 保证。

### 2. GHSA-jmr9-qjv8-65gv（high）— extract-zip 软链接路径穿越

> extract-zip unvalidated symlink path traversal · `extract-zip <=2.0.1`

**不可达。** `extract-zip` 在 pi 里只有一个使用点：
`dist/utils/tools-manager.js` 的 `ensureTool()` —— 它负责**下载并解压 `fd` / `rg`
两个二进制**（从 GitHub Releases），给 pi 内置的 `find` / `grep` 工具用。

而这两个工具我们**都没有注册**：

- `noTools: 'builtin'` 把 pi 的内置工具全关了（上面第 1 条已述）；
- 我们注册的工具是 `bash` / `read` / `write` / `edit` 的**沙盒版**，
  加上 `src/tools/` 下那几个 AP 插件 —— 没有 `find`，没有 `grep`；
- `ensureTool` 是在 `find`/`grep` 的 **execute 里**调的（`core/tools/find.js:158`、
  `core/tools/grep.js:95`），不是模块加载时，所以不注册 = 永不执行。

也就是说：这条路径要被走到，得先有人把 pi 的内置 find/grep 加回来。
真那么做的时候会先撞上隔离契约 #2（那两个工具在 agent 进程本地执行，不走沙盒），
**那才是更严重的问题**，安全告警反而是顺带的。

### 3. GHSA-r95r-rj6r-c39x（low）— auth.json 写入竞态可能泄露凭据

**不可达。** 这条针对 pi 把凭据落到 `auth.json` 的那条路径。
本服务的凭据**从不落盘**：每个 run 用 `AuthStorage.inMemory()` 注入
（`src/agent/run-turn.js:255`、`src/agent/compact-turn.js:111`），
这本身就是隔离契约的一部分 —— 凭据既不进 `process.env`（并发用户会互相覆盖），
也不进任何共享文件。

### 4. GHSA-7v5m-pr3q-6453（low）— HTML 会话导出的 Markdown URL 消毒绕过可致 XSS

**不可达。** 这条针对 pi 的 **HTML 会话导出**功能，我们没有用（全仓库无调用）。
本服务自己的渲染路径是另一套，且有独立的两道防线：预览 iframe 不给
`allow-same-origin` + 文档内 `default-src 'none'` 的 CSP，
`/v1/artifacts/:id/raw` 一律 `text/plain` + `nosniff`
（见 `docs/ARCHITECTURE.md` 第 7 节）。

## 什么时候必须回来重看

- **上游发布 > 0.73.1 时** —— 优先升级，然后重跑 `npm audit --omit=dev` 更新本文件；
- **有人要注册 pi 的内置 `find` / `grep` 时** —— 第 2 条立刻变成可达
  （而且那个改动本身先违反隔离契约 #2）；
- **有人要引入 pi 的扩展安装或 HTML 导出时** —— 第 1、4 条同上；
- **出现一条新告警时** —— 别追加到这份"已知无害"的列表里就完事，
  按上面同样的粒度单独判一次可达性。

## 复核方法

```bash
npm audit --omit=dev            # 只看运行时依赖；devDependencies 不进生产镜像
npm ls extract-zip              # 确认引入路径没变
grep -rn "noTools" src/         # 确认内置工具仍然全关（两处，都该是 'builtin'）
grep -rn "AuthStorage" src/     # 确认凭据仍然只走 inMemory()
```

前两条 high 的共同前提都是"pi 的内置工具被启用"，
而这个前提由隔离契约的静态检查守着（`npm run check:isolation`，进 CI）：

| 规则 | 拦什么 |
|---|---|
| `R2-禁止启用 pi 内置本地执行工具` | 把 pi 的本地执行工具**造出来**（`createBashTool(` / `createCodingTools(`） |
| `R2-AgentSession 必须保持 noTools: builtin` | 把**总闸改掉** —— `noTools` 写成 `'builtin'` 以外的任何值 |

第二条是写这份文件时补的。在此之前那个总闸**只由代码注释守着**
（两处 `noTools: 'builtin'` 旁边写着"不要改"），而它在 diff 里只有一个单词，
改掉之后功能照常工作、没有任何征兆，只是命令不再跑在沙盒里了 ——
恰恰是静态检查最该管的那类改动。

⚠️ 仍然**没有**被自动化守住的一种写法：单独把 pi 的 `find` / `grep`
注册进工具表（它们不经过 `createBashTool`，也不改 `noTools`）。
那会让第 2 条告警变成可达。今天没有这样的代码，
真要加的时候请连同这份文件一起重新判一次。
