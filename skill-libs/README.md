# skill-libs —— 技能脚本用的客户端库

这个目录里的东西**随 worker 镜像发布**，烤进沙盒的 `/opt/ap/skill-libs`。
技能脚本在沙盒里跑起来之后，从那个路径 import 它们。

## 和 `managed-skills/` 的分工

两个目录都在仓库根下，名字也像，但**去向完全不同** —— 搞混的代价是
"模型说有这个技能、进去却找不到脚本"，而且不报错：

| 目录 | 装的是 | 进哪个镜像 | 谁把它送进沙盒 |
|---|---|---|---|
| `managed-skills/` | 技能本体（`SKILL.md` + `scripts/`） | **agent** | agent 每轮铺进沙盒工作区（`src/agent/skill-materializer.js`） |
| `skill-libs/`（这里） | 技能脚本调用的客户端库 | **worker** | 没人搬 —— 构建时就在镜像里 |

分工的依据是"**谁把它送到沙盒里**"：

- 技能本体的清单要进系统提示（agent 侧），而脚本每轮由 agent 现铺，
  所以只要 agent 镜像里有就够了，改技能不用重发 worker；
- 这里的库**没有任何人搬运**。agent 只注入一个字符串路径
  （`AP_SKILL_LIBS_DIR=/opt/ap/skill-libs`，见 `src/agent/tools.js:75`），
  所以文件必须**事先烤在 worker 镜像里**（`sandbox-worker/Dockerfile:86`）。

换句话说：**改了这个目录，必须重新构建并发布 worker 镜像**，
只重发 agent 不会有任何效果。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SKILL_LIBS_DIR` | `/opt/ap/skill-libs` | 沙盒内的路径。agent 原样注入给技能脚本，**不校验存在性** —— 它描述的是 worker 镜像的布局，agent 这边看不到那个文件系统 |

路径写错不会有任何启动期报错，表现是技能脚本 import 失败
（`No such file or directory`）。改这个值时记得同步改 `sandbox-worker/Dockerfile`。

## 怎么更新

```bash
bin/sync-skills.sh --dry-run   # 先看会同步什么
bin/sync-skills.sh             # 同时同步 managed-skills/（那个进 agent 镜像）
git add managed-skills skill-libs && git commit -m "chore: 同步技能资产"
```

然后**重新构建 worker 镜像**。完整推理见 [`bin/sync-skills.sh`](../bin/sync-skills.sh) 的文件头
和 [`../managed-skills/README.md`](../managed-skills/README.md)。
