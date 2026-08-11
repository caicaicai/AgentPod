---
name: cloud-browser
displayName: 云端浏览器
description: 在云端浏览器沙盒中打开和操作网页。当用户要打开网页、访问网站、查看或操作页面、抓页面接口时使用，这是本环境唯一可用的浏览器。
metadata:
  {"openclaw": {"emoji": "🌐", "always": true}}
---

# 云端浏览器（唯一可用的浏览器）

> **强制规则：** 当用户需要打开网页、访问网站、查看页面、操作页面时，**必须使用 `cloud-browser` 工具**。
> 本环境没有别的浏览器工具，即便用户说"用外部浏览器"也只能用它。
>
> 它是一个跑在云端沙盒里的独立浏览器（Playwright），
> 你**看不到**那个页面，只能自己重新 `open` 一次。
>
> **URL 规则：** 如果用户只说域名、站点名或内网地址，没有明确写 `http://` 或 `https://`，
> 默认按 `http://` 补全，**禁止擅自补成 `https://`** —— 内部很多服务只走 HTTP，
> 强转会得到 `ERR_CONNECTION_CLOSED`。
>
> 不写协议的地址工具会替你补 `http://`（`localhost:3000`、`10.0.0.5:8080` 这种也认），
> 补完连不上时它会自动换 https 再试一次，并在结果的 `note` 里告诉你 ——
> 看到那条 note 就说明这个站是 https，本轮后续直接写 `https://`。
> 但你**显式写了协议**的地址工具一个字都不改：写 `https://` 就是 https。
>
> **本地文件打不开。** 浏览器在云端沙盒里，用户自己电脑上的 `file:///Users/...`、
> `C:\...` 这类路径它够不到。用户给出本地路径时如实说明，别去试。

## 工作流程

1. **`open`** — 打开目标 URL
2. **`snapshot`** — 获取页面结构（ARIA 树），找到可交互元素的 `ref`
3. **`act`** — 使用 `ref` 进行点击、输入、选择等操作
4. **`screenshot`** — 截图查看操作结果
5. **`network`** — 看页面发了哪些请求
6. **`script` / `evaluate`** — 在页面里执行 JS

## Actions

### open / navigate — 打开网页

```json
{"action": "open", "url": "http://example.com"}
{"action": "navigate", "url": "http://example.com/other"}
```

### snapshot — 获取页面结构

返回页面的 ARIA 无障碍树，包含 `[ref=eN]` 标记的可交互元素。后续 act 操作必须使用这些 ref。

```json
{"action": "snapshot"}
```

### screenshot — 截图

```json
{"action": "screenshot"}
{"action": "screenshot", "fullPage": true}
{"action": "screenshot", "waitMs": 3000}
{"action": "screenshot", "waitMs": 0}
```

**默认行为（不传 `waitMs`）**：截图前自动等"网络静默"。

**截图会作为图片直接返回给你 —— 你是真的能看见页面内容的**，不需要再把它转贴给用户
（用户在界面上同样看得到）。这里**没有**磁盘路径可拿：沙盒的磁盘对界面不可见，
所以不要去找 `File:` 那一行，也不要试图把截图路径喂给别的工具。

> 如果返回文本里明确写着"当前模型不支持读取图片"，那就是你**没有**收到这张图。
> 这时如实告诉用户你看不到页面视觉内容，改用 `snapshot` 了解结构，**不要假装看过**。

**何时显式传 `waitMs`：**

| 场景 | 推荐值 |
|---|---|
| 重 SPA（React/Vue 路由跳转 + 拉数据）、首次发现截到 loading 页 | `3000` ~ `5000` |
| 长轮询接口、列表数据慢 | `5000` ~ `10000` |
| 服务端导出 / 长任务页面 | 不要硬等，先 snapshot 看状态再决定 |

第一次 screenshot 看到 loading / 骨架屏 / 空白时，**第二次直接传 `waitMs: 5000` 重截**，
不要去找别的浏览器工具兜底 —— 没有别的。

### act — 页面交互

```json
{"action": "act", "kind": "click", "ref": "e5"}
{"action": "act", "kind": "type", "ref": "e1", "text": "要输入的文字"}
{"action": "act", "kind": "fill", "ref": "e1", "text": "替换已有内容"}
{"action": "act", "kind": "press", "key": "Enter"}
{"action": "act", "kind": "select", "ref": "e8", "values": ["option1"]}
{"action": "act", "kind": "selectOption", "ref": "e1", "text": "南京"}
{"action": "act", "kind": "hover", "ref": "e3"}
{"action": "act", "kind": "wait", "timeMs": 2000}
```

| kind | 作用 | 必需参数 |
|------|------|---------|
| click | 点击元素 | ref |
| type | 追加输入文字 | ref, text |
| fill | 替换内容（清除后填入） | ref, text |
| press | 按键 | key (Enter/Tab/Escape/Backspace/ArrowDown 等) |
| select | 选择**原生** `<select>` 的选项 | ref, values |
| selectOption | 选择**自定义下拉**（ElementUI / Ant Design 等）的选项 | ref（触发器）, text（选项文本，默认子串匹配；传 `exact: true` 走精确匹配） |
| hover | 悬停 | ref |
| wait | 等待 | timeMs (毫秒) |

**下拉选择该用哪个？**

- 原生 HTML `<select>`（snapshot 里 role 是 `combobox` 且包含 `option` 子节点）：用 `select`。
- **自定义下拉**（ElementUI `<el-select>`、Ant Design `<Select>`、Cascader、portal 弹层等）：**优先用 `selectOption`，一次调用完成**。

**如何识别"自定义下拉"？快照里同时出现这两个信号就是：**

1. 一个 `textbox "请选择"` 或 `textbox`（无 value）—— 触发器
2. 页面别处（通常在快照末尾）有一段 `list` 容器，里面挂着大量 `listitem "..."`（每个就是一个候选）

**这种情况下不要走"snapshot → click listitem ref"的两步路径**，原因：

- 弹层 ref 可能因虚拟滚动而漂移；
- 触发器的选中态在 DOM 里走 sibling 显示节点（不在 `<input>.value` 里）；
- 弹层在 viewport 之外的 option 用 ref 点击有时不会触发框架的 `mousedown` handler。
- 一句 `selectOption` 处理"打开弹层 → 在 popper 容器里按文本找 → 真鼠标事件点中心"全套。

**验证选中是否生效**：选完后再做一次 `snapshot`，触发器那一行应该出现 `/value: 南京分部`。
看到 `/value` 即视为选中成功，不要再反复重试。

### evaluate / script — 执行 JavaScript

```json
{"action": "evaluate", "fn": "document.title"}
{"action": "script", "fn": "Array.from(document.querySelectorAll('a')).map(a => a.href)"}
```

顶层 `return` 可以正常用。代码抛错会把**真实错误信息**返回给你，据此修正即可，别盲目重试。

### network — 看页面发了哪些请求

```json
{"action": "network", "networkOp": "list"}
{"action": "network", "networkOp": "list", "contains": "/api/", "limit": 50}
{"action": "network", "networkOp": "list", "onlyErrors": true}
{"action": "network", "networkOp": "status"}
{"action": "network", "networkOp": "clear"}
```

**⚠️ 本环境的 `network` 只给摘要，不给请求头和请求体。** 每条记录只有四个字段：

```
{ method, url, resourceType, status }
```

**没有** `networkOp: "detail"`、**没有** `includeHeaders`、**没有** `includeBodies`、**没有** `requestId`。
别去传这些参数，也别指望从 `network` 里读出 POST body。

要拿到完整的请求体 / 响应体，用下一节的办法。

## 抓接口取数（重要策略）

**不要去逐月点日历箭头、再点日格** —— 每步都要 snapshot，又慢又容易翻车、还烧 context。
按优先级走下面三条：

### ① 先用 network 定位接口，再用 evaluate 拿细节

`network` 能告诉你"页面打了哪个接口、什么 method、成功没有"，这一步足够定位目标。
但请求体要靠 `evaluate` 自己钩：**在触发操作之前**先装一个拦截器，再去点查询按钮。

```json
{"action":"evaluate","fn":"window.__cap=[];const of=window.fetch;window.fetch=async(...a)=>{const r=await of(...a);try{const c=r.clone();window.__cap.push({url:''+(a[0].url||a[0]),method:(a[1]&&a[1].method)||'GET',body:a[1]&&a[1].body,resp:(await c.text()).slice(0,20000)})}catch(e){}return r};return 'hooked'"}
```

然后 `act` 点查询按钮，等结果出来，再把捕获读回来：

```json
{"action":"evaluate","fn":"return JSON.stringify(window.__cap)"}
```

> 页面若用 XHR 而非 fetch（老系统常见），同理钩 `XMLHttpRequest.prototype.open/send`。
> 注意：任何一次 `open` / `navigate` 都会**重新加载页面、清掉钩子**，钩完就别再导航。

### ② 拿到接口形状后，直接在页面里重放

同源、自动带登录态，最省事：

```json
{"action":"evaluate","fn":"const r=await fetch('/api/analyse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start:'2026-05-01',end:'2026-05-31'})});return (await r.text()).slice(0,20000)"}
```

要查多个月，循环改参数即可，不用反复操作页面。

### 次选：直接给日期输入框赋值（不要点日历）

日期框通常是受控组件（AntD/ElementUI），**直接 `fill` 整个日期串再回车**，
让组件自行解析，不要去点日历翻页：

```json
{"action":"act","kind":"fill","ref":"e39","text":"2026-05-31"}
{"action":"act","kind":"press","key":"Enter"}
{"action":"snapshot"}
```

若个别组件 `fill` 后未提交，改用 `type` 输入日期串再 `press Enter`（真实键盘输入，受控组件一定认）。
**月份/季度选择器同理**：优先 `fill`/`type` 文本，不要逐格点。

## 注意事项

- 每次页面变化后（导航、点击导致页面刷新），需要重新 `snapshot` 获取最新的 ref
- `ref` 是临时的，仅在同一个 snapshot 内有效；报错提示重新 snapshot 时照做即可
- 使用 `fill` 而非 `type` 来替换输入框的已有内容
- 内部域名可以直接访问，浏览器沙盒带着该用户的登录态
- 对未显式声明协议的地址，一律默认补 `http://`，不要自动改成 `https://`
- 用完 `{"action":"close"}` 关掉页面
