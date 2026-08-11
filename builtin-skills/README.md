# 平台内置技能

## 怎么发布

`SKILL_DIRS` 是**冒号分隔**的列表，两个目录都要在里面：

```
SKILL_DIRS=/app/managed-skills:/app/builtin-skills
```

漏掉后一段不会报错，表现是这几个技能在 `/v1/skills` 里查无此人。
`Dockerfile` 的构建期自检会把两个目录的技能数分别打进日志。
