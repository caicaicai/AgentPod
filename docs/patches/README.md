# 待手工应用的补丁

这个目录里的补丁**没有随提交进主干**，因为它们改的是
`.github/workflows/` —— GitHub App 默认没有 `workflows` 权限，
带着这类改动推分支会被服务端直接拒绝：

```
! [remote rejected] refusing to allow a GitHub App to create or update
  workflow `.github/workflows/ci.yml` without `workflows` permission
```

所以内容放在这儿，由**有权限的人**本地应用一次。

---

## `ci-mysql-service.patch` —— 让 CI 真的跑 MySQL 存储契约

### 它解决什么

README 里写着（英文版原话）：

> Point `AP_TEST_MYSQL_URL` at a scratch database to additionally run the storage
> contract against real MySQL — **CI should do that, since it is what catches the
> double drifting from the real backend.**

而 `.github/workflows/ci.yml` 里**没有 mysql service，也没设这个变量**。

后果不是"少跑了一些用例"，而是：生产只有 MySQL 一种后端，测试却全跑在
`test/helpers/memory-storage.js` 这个内存替身上。替身最大的风险不是"它错了"，
而是**"它自己对了，但跟真的不一样"** —— 几百条用例全绿，生产照样出问题。
最容易漂的都是边角：

- 记录不存在时，一个回 `null` 一个抛；
- `merge` 传 `undefined`，一个删字段一个存了个 `null`；
- 删掉一版之后，一个连元信息一起没了、一个还留着。

`test/storage-drivers.test.js` 早就把每条断言**跑两遍**（替身一遍、真库一遍）
来挡这个，但真库那一遍在没有 `AP_TEST_MYSQL_URL` 时**整块跳过**。
也就是说：唯一能发现替身漂移的那道闸，**一次都没关过**。

### 补丁做了什么

1. 给 `test` job 挂一个 `mysql:8.0` service（版本与 `docker-compose.yml` 对齐 ——
   CI 跑的库和部署的库不是一个大版本的话，这一遍验的就不是同一件事了）；
2. 配健康检查。没有它，后续步骤会在 mysqld 还在初始化时就去连，
   表现是随机 `ECONNREFUSED` —— **比没有这个 job 更糟**，
   因为它教会大家"红了就重跑一次"；
3. 给测试步骤设 `AP_TEST_MYSQL_URL`；
4. 加一步显式确认 `mysql2` 装上了（它在 `package.json` 里是 `optionalDependencies`），
   免得"真库那一遍其实又被静默跳过了"这件事再一次悄悄发生。

### 怎么应用

```bash
git apply docs/patches/ci-mysql-service.patch
git add .github/workflows/ci.yml
git commit -m "ci: 挂 MySQL service，让存储契约的真库那一遍真的会跑"
```

应用后可以本地验一遍同样的组合（需要一个能连的库）：

```bash
AP_TEST_MYSQL_URL=mysql://aptest:aptest@127.0.0.1:3306/agentpod_test npm test
```

### 应用完记得

两份 README 已经改成"**CI 就是这么跑的**"了（`README.md` / `README.zh-CN.md`
的 Testing 一节）。补丁一天不应用，那句话就一天是**新的一处不准确描述** ——
和它当初修掉的那条毛病同一个性质。要么应用补丁，要么把那两句话改回"应当这么做"。
