# 沙盒集群管理台

Vue 3 + Vite。给 `sandbox-manager` 配的运维界面：看集群、摘节点、试算调度、查配置。

```bash
npm install
npm run dev        # → http://localhost:5180，内置 mock 数据，不需要任何后端
npm run dev:live   # → 连本地后端（需先启动 manager 后端 http://localhost:3000）
npm run build      # → dist/
```

## 连真实后端

```bash
# 1. 启动 manager 后端
cd .. && npm run dev

# 2. 起前端
npm run dev:live

# 3. 用 http://localhost:5180 打开，使用 CONSOLE_USERS 中配置的账号密码登录
```

认证方式是 JWT Bearer token：前端通过 `/api/v1/sandbox/ui/login` 接口获取
token，存入 `localStorage`，后续所有请求通过 `Authorization: Bearer` 头发送。

---

## 为什么单独一套接口

管理台**不调**已有的 `/api/v1/sandbox/nodes` 那批接口。它们是
`require_security_code` 的，浏览器要调就得把安全令牌打进 JS bundle ——
等于把一枚长期、不过期、能操作整个集群的凭据发给每个打开过页面的人。
这正是整套 manager 设计要消灭的东西（见上级 README「它解决什么」第 1 条）。

所以管理台走 `/api/v1/sandbox/ui/*`：需要 JWT 会话认证，不要安全令牌。
**这个前端产物里不含任何秘密**，构建后可以自行 grep 验证：

```bash
grep -io "securitycode\|secret_token" dist/assets/*.js   # 应该没有任何输出
```

写权限另有一道闸门：`SANDBOX_CONSOLE_ADMINS`（manager 侧环境变量，逗号分隔
的用户名名单）。**没配置时所有写操作禁用**，而不是放行所有登录用户 ——
摘除、注销直接改变生产容量。页面会把禁用原因显示出来，是可见的失败；
默认放行则是不可见的敞口。

---

## 四个页面

| 页面 | 解决什么 |
|---|---|
| **总览** | 水位、按池聚合、以及一块「需要注意」—— 把配置自检失败、节点掉队、摘除中、自报不健康、水位超阈值收拢到一处，按会不会导致请求失败排序 |
| **节点** | 表格 + 详情抽屉。摘除 / 恢复 / 强制注销都在抽屉里 |
| **调度试算** | 输入 pool + 能力要求，看**会挑中谁、以及每个节点被排除的原因** |
| **测试运行** | 选一个节点真开一个沙盒，跑命令 / 读写文件 / 操作浏览器。**默认关闭** |
| **配置自检** | manager 配置 + 一致性判定 + 票据密钥指纹横向比对 |
| **接口文档** | 沙盒全部能力的接口说明，可下载 Markdown |

### 测试运行

在选定节点上真开一个沙盒。**浏览器不直连节点** —— 节点 `base` 是内网地址，
而且它不发 CORS 头，所有操作都由 manager 转发。

这条路径能在生产机器上执行代码，所以在管理员名单之外还有一道独立开关
`SANDBOX_CONSOLE_EXEC=1`（manager 侧），默认关闭。

### 调度试算

它**不签发票据**（响应里有 `ticketIssued: false`，后端也有测试盯着）——
否则一个只读的运维页面会变成绕过调用方鉴权拿沙盒执行权限的后门。

---

## 部署

### Docker 部署（推荐）

前后端同源，在 Dockerfile 中自动构建前端：

```bash
docker build -t sandbox-manager .
docker run -d --name manager -p 3000:3000 --env-file .env sandbox-manager
```

或者使用根目录的 `docker-compose`：

```bash
# 在仓库根目录
docker compose up -d manager
```

### 反向代理子路径部署

如果需要挂在子路径下，构建时设置：

```bash
VITE_BASE_PATH=/sandbox-manager VITE_API_PREFIX=/api/sandbox-manager npm run build
```

---

## 开发

`npm run dev` 用的是 `src/api/mock.js`，一个完整的假后端：注册/摘除/试算全都
能跑，负载还会自己晃动。mock 通过动态 `import()` 引入，**不会进生产产物**。

`npm run dev:live` 连真实后端。日常改 UI 用 mock 更快。

---

## 结构

```
web/
├── src/
│   ├── api/
│   │   ├── client.js      fetch 封装 + JWT 认证
│   │   └── mock.js        离线假后端（仅 dev）
│   ├── store/cluster.js   轮询 + 共享状态（普通 composable）
│   ├── components/        导航、登录、槽位条、状态标、节点抽屉、Toast
│   ├── views/             总览 / 节点 / 调度试算 / 配置自检
│   └── utils/format.js    时间、百分比、排除原因的中文翻译
└── vite.config.js
```

轮询 5 秒一次，**页面切到后台自动暂停**，失败按 5s→60s 退避，且失败时保留
上一份数据只挂横幅 —— 清空成空状态会让一次网络抖动看起来像"集群全没了"。
