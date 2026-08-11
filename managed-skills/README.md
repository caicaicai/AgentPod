# 平台技能

这个目录随 **agent 镜像**发布，`SKILL_DIRS` 指向它（容器内 `/app/managed-skills`）。

## 为什么在这儿，而不是在沙盒镜像里

技能不是一段提示词，是**一个目录**：`SKILL.md` 讲怎么用，旁边 `scripts/` 里放着真正干活的脚本。
清单要进系统提示（agent 侧），脚本要能执行（沙盒侧）。两边各存一份就会漂移 ——
改了技能得同时重发 agent 和 worker 两个镜像，漏一个的表现是"模型说有这个技能、
进去却找不到脚本"，而且**不报错**，只表现为一路 `No such file or directory`。

所以只保留一个真源：放在 agent 这边，每轮按需铺进沙盒工作区
（`src/agent/skill-materializer.js`）。worker 镜像与技能更新彻底解耦。

完整推理见 `docs/MIGRATION.md`「技能要跑起来还差什么」。

## 怎么填

```bash
bin/sync-skills.sh --dry-run   # 先看会同步什么
bin/sync-skills.sh             # 同时同步 skill-libs/（那个进 worker 镜像）
git add managed-skills skill-libs && git commit -m "chore: 同步技能资产"
```

`skill-libs/` 是技能**用到的库**、进的是 worker 镜像，别和技能本体搞混 ——
分工见 [../skill-libs/README.md](../skill-libs/README.md)。

**必须提交并重新构建镜像。**

## 空着会怎样

不会构建失败，也不会启动失败 —— 空目录是合法状态（灰度期，或者只用工具不用技能）。
表现是三条：

1. 应用构建日志里 `打进镜像的技能：0 个`
2. 启动日志一条 warn：`配置了 SKILL_DIRS 但没读到任何技能`
3. `/v1/skills` 只返回用户的个人技能

## 格式

pi 原生支持 Agent Skills 标准：子目录里有 `SKILL.md` 就当作一个技能根。
frontmatter 只认 `name` / `description` / `disable-model-invocation`。
