# 对话界面（Vue 3 + Vite）

云端 Agent 的 Web 界面。**服务端服务的是构建产物 `dist/`**，不是这里的源码 ——
`src/http/server.js` 的 `WEB_DIR` 指向 `web/dist`。

```bash
npm ci
npm run build     # → web/dist，agent 直接当静态目录服务
npm run dev       # Vite 起在 5273，把 /v1 与 /healthz 代理到 127.0.0.1:8080 的 agent
```

改完前端**必须重新 build**，否则页面还是上一次的产物。日常开发用 `npm run dev`
更省事：热更新，接口打到真的 agent 上。

镜像里这一步由 `Dockerfile` 的构建阶段做（`npm ci && npm run build`，然后把
`node_modules` 删掉）。`dist/` 不进 git —— 构建产物进版本库只会带来"改了前端忘了
跑 build"这类只在线上才暴露的问题。

## 结构

```
src/
  main.js              入口
  App.vue              布局：侧栏 + 对话区 + 右侧抽屉
  stores/app.js        全局状态与动作（reactive 单例，没引状态库）
  lib/
    api.js             接口封装 · SSE 流 · 401 跳 SSO（含防转圈标记）
    route.js           地址 ↔ 界面状态（两个纯函数，没引路由库）
    attachments.js     附件：读文件、判类型、以及把历史里拼进正文的附件折回 chip
    markdown.js        极简 markdown（先整体转义再变换）
    debug-bundle.js    「复制调试信息」——里面绝不放凭据，见文件头
    tools.js           工具卡片与任务清单的展示规则
    format.js          时间与本轮统计的文案
  components/          侧栏 · 会话行 · 对话区 · 消息 · 工具卡片 · 任务清单 · 输入区 · 各抽屉
  assets/
    tokens.css         设计令牌（明暗两套）。组件只用变量，不写死颜色
    base.css           重置 + 共用控件 + markdown 排版（v-html 的内容不能用 scoped）
```

## 地址

界面的每一个去处都有一条真地址，**刷新、收藏、发给别人都落回同一页**：

| 地址 | 是什么 |
| --- | --- |
| `/` | 新对话（还没发出第一条消息，服务端没有它） |
| `/c/<sessionKey>` | 某一条对话 |
| `/artifacts`、`/artifacts/<id>` | 作品库；带 id 的直接摊开那一份 |
| `/market` | 作品市场。**访客也能直接打开**（那时候是不带侧栏的独立页） |
| `/admin/<tab>` | 管理台的某一页：`users` / `models` / `groups` / `usage` |
| `/s/<token>` | 分享页（公开） |

没有引 vue-router：需要的只有"状态变了改地址"和"地址变了改状态"两条，
都在 `lib/route.js`（翻译）和 `stores/app.js` 的「地址栏」一节（同步）里。
抽屉（技能、记忆、定时任务、账号…）**故意不进地址** —— 它们是顺手翻一眼，不是一个去处。

⚠️ **加一条新地址要改两边**：`lib/route.js` 认它，`src/http/server.js` 的 `APP_PATHS`
也要放行它回 `index.html`。只改前端的表现是"应用里点得进去，按 F5 就 404"，
而 `npm run dev` 下看不出来（Vite 自带 history fallback）。`test/web-route.test.js`
与 `test/chat-api.test.js` 的「静态资源」一组守着这件事。

## 几条不要踩的

- **`lib/debug-bundle.js` 被服务端测试引用**（`test/debug-bundle.test.js`），
  也被 `scripts/check-isolation-rules.js` 静态扫描。别在里面读 `document.cookie`——
  SSO 票就在那里，而这份文件是要整包交给别人分析的。
- **附件的正文格式与服务端是一份契约**：拼串在 `src/agent/attachments.js`，
  反解在 `lib/attachments.js` 的 `parseInlinedAttachments`。单方面改围栏字符或那句提示语，
  另一边会静默失效（表现是"刷新之后附件变成一堵墙"）。`test/attachments.test.js` 守着它。
- **`assetsDir` 必须是 `assets`**：服务端只放行 `/assets/*` 这一条通配路由，改名字会让
  所有 JS/CSS 404，而首页 HTML 还正常返回 —— 表现是白屏，且看不到 404 页面。
- **样式只用 `tokens.css` 里的变量**。写死一个 `#fff` 在深色模式下就是一块刺眼的白。
