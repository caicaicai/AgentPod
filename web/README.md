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
