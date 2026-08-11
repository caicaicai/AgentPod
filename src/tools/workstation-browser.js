/**
 * workstation_browser —— 移植自 `modules/ap/extensions/ap-skills/index.mjs`。
 *
 * 工具的**名字、参数 schema、action 语义、返回文本格式**都与桌面端保持一致。
 * 这不是为了省事：模型对这个工具的用法（先 snapshot 拿 ref、再 act 操作、
 * 下拉优先用 selectOption、日期框直接 fill 完整串）是从 SKILL.md 与大量实际对话里学到的。
 * 云端换一套契约，等于把这些经验全部作废。
 *
 * 差异只有一处：截图的回传方式。桌面端把图片写到磁盘、回一个本地路径给渲染端读，
 * 云端沙盒的磁盘对渲染端不可见，改成用 pi 的 image content part 回传 ——
 * 这样模型是**真的看到了图**，而不是收到一串它读不懂的 base64。
 */
import { jsonResult, textResult } from './plugin-api.js'

const ACT_KINDS = ['click', 'type', 'press', 'hover', 'select', 'selectOption', 'fill', 'wait', 'evaluate']
const ACTIONS = ['open', 'snapshot', 'screenshot', 'act', 'navigate', 'evaluate', 'script', 'network', 'close']

/**
 * ── 没写协议时补 `http://`，不是 `https://` ──────────────────────────
 *
 * 模型的先验是 https：训练语料里绝大多数 URL 都是。而我们实际服务的内网系统
 * **多数只开 80**，于是"帮我打开某某系统"十次有九次先撞一个
 * `net::ERR_CONNECTION_REFUSED`，然后模型开始猜是不是要登录、是不是域名写错了。
 *
 * 这条规则原本只写在 `builtin-skills/cloud-browser/SKILL.md` 里，不够：
 * 技能是**按需加载**的，模型不一定读到那一段；而工具的 description 永远在
 * 上下文里。所以三处都要有，而且优先级是反的 ——
 *
 *   提示词（SKILL.md + description）提高命中率，**只有代码能保证**。
 *
 * 判据只认 `://`，**不认裸冒号**：`localhost:3000` / `10.0.0.5:8080` 这类写法
 * 拿 `new URL()` 去判会把 `localhost:` 当成协议名，判成"已有协议"原样送进
 * goto，报一个没人看得懂的 Invalid URL。这是这段代码唯一容易写错的地方。
 */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
/** 这几个协议本来就不带 `//`，别给它们前面拼 http:// */
const BARE_SCHEME = /^(about|data|mailto|javascript|blob):/i

export function normalizeUrl(raw) {
  const url = String(raw || '').trim()
  if (!url) return { url, assumed: false }
  if (HAS_SCHEME.test(url) || BARE_SCHEME.test(url)) return { url, assumed: false }
  // 协议相对地址（`//host/path`）只缺协议名，别再补一遍 `//`
  if (url.startsWith('//')) return { url: `http:${url}`, assumed: true }
  return { url: `http://${url}`, assumed: true }
}

/**
 * 这个失败是不是"协议猜错了"。
 *
 * 只认**连不上**这一类。DNS 解析不了（`ERR_NAME_NOT_RESOLVED`）换协议也没用，
 * 页面加载超时说明 80 端口其实通着 —— 那两种重试一遍只是白等一次超时，
 * 还会把真正的原因盖掉。
 */
const CONNECT_FAILED = /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_ADDRESS_UNREACHABLE|ERR_SOCKET_NOT_CONNECTED/

const DESCRIPTION = [
  '在云端浏览器沙盒中打开和操作网页。**这是当前环境唯一可用的浏览器工具**。',
  '沙盒会带上你的登录态（cookie），适合内网系统。',
  '**URL 协议：本环境的站点绝大多数只走 HTTP。** 用户只给了域名/站点名/内网地址时，一律按 `http://` 补全，不要擅自改成 `https://`；确知是 https 站点才显式写。（不写协议的地址工具会自动补 `http://`。）',
  'Actions: open（打开URL）, snapshot（获取页面结构，返回ARIA树和可交互元素ref）, screenshot（截图）, act（页面交互：click/type/fill/press/select/selectOption/hover）, navigate（导航）, evaluate/script（执行JS）, network（查看网络请求）, close（关闭）',
  '使用 snapshot 获取页面结构后，用返回的 ref（如 e1, e2）配合 act 操作页面元素。ref 会随页面变化失效，报错提示重新 snapshot 时照做即可。',
  '**下拉/日期筛选优先用专用 kind，别手搓 JS 逐项点：** 自定义下拉（AntD/ElementUI/级联/portal 弹层）用 `act kind=selectOption`（传触发器 ref + 选项文本）；原生 `<select>` 用 `kind=select`；日期/月份框直接 `kind=fill` 写完整日期串（如 `2026-05`）再 `kind=press key=Enter`，不要逐月点日历箭头。',
  '要查多分部/多月报表，最稳的是点一次查询后用 `network` 抓数据接口、改参数重放，绕开 UI。',
  'evaluate/script 执行 JS 时：顶层 `return` 可以正常用；代码抛错会把**真实错误信息**返回给你，据此修正即可，别盲目重试。',
  'screenshot 会把截图作为图片直接返回给你（你能看见页面内容），不需要你再把图片转贴给用户。',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS, description: '要执行的操作' },
    url: { type: 'string', description: 'open/navigate 时必填。**不写协议时默认按 http:// 打开**（本环境站点多数只开 80），确知是 https 才显式写 https://' },
    kind: { type: 'string', enum: ACT_KINDS, description: 'act 时必填。交互类型' },
    ref: { type: 'string', description: 'act 时用于定位元素，来自 snapshot 返回的 ref（如 e1）。selectOption 的 ref 是下拉触发器' },
    text: { type: 'string', description: 'type/fill/selectOption 时必填' },
    exact: { type: 'boolean', description: 'selectOption 可选。true=精确匹配选项文本' },
    openDelayMs: { type: 'number', description: 'selectOption 可选。点触发器后等弹层渲染的毫秒数，默认 250，最大 5000' },
    key: { type: 'string', description: 'press 时必填，如 Enter / Tab / Escape / ArrowDown' },
    values: { type: 'array', items: { type: 'string' }, description: 'select 时必填。要选择的值列表' },
    fn: { type: 'string', description: 'evaluate 时必填。要执行的 JavaScript 代码' },
    doubleClick: { type: 'boolean', description: 'click 可选。是否双击' },
    timeMs: { type: 'number', description: 'wait 可选。等待毫秒数，默认 1000，最大 30000' },
    waitMs: { type: 'number', description: 'screenshot 可选。截图前等待毫秒数。不传=自动等网络静默；传 0=立刻截' },
    fullPage: { type: 'boolean', description: 'screenshot 可选。true=整页截图' },
    networkOp: { type: 'string', enum: ['list', 'clear', 'status'], description: 'network 可选，默认 list' },
    limit: { type: 'number', description: 'network 可选。最多返回多少条，默认 20' },
    onlyErrors: { type: 'boolean', description: 'network 可选。仅返回失败或 HTTP>=400 的请求' },
    contains: { type: 'string', description: 'network 可选。只返回 URL 含该关键字的请求' },
  },
  required: ['action'],
}

export function registerWorkstationBrowserTool(api) {
  api.registerTool({
    name: 'workstation_browser',
    label: '云端浏览器',
    description: DESCRIPTION,
    parameters: SCHEMA,
    async execute(_toolCallId, params) {
      const action = String(params?.action || '')
      const browser = api.ctx.browser

      try {
        switch (action) {
          case 'open':
          case 'navigate': {
            if (!params.url) return jsonResult({ status: 'error', error: `${action} 需要 url 参数` })
            const { url, assumed } = normalizeUrl(params.url)
            const result = await browser.action(action, { url })
            if (result.ok) return jsonResult({ status: 'ok', url: result.url, title: result.title })

            /**
             * 我们替它补的是 http，但这个站点只开了 https。**自己换一次再试**，
             * 而不是把一个 `ERR_CONNECTION_REFUSED` 丢回去让模型猜 ——
             * 那种情况下它通常会去猜"是不是要先登录""域名是不是写错了"，
             * 猜的方向全错，而唯一能证伪的那个事实（80 端口没开）它看不见。
             *
             * 只在**协议是我们补的**时候换：用户/模型显式写了 http://，
             * 那是一个明确的意图，替它改掉等于把它的判断悄悄推翻。
             */
            if (assumed && CONNECT_FAILED.test(String(result.error || ''))) {
              const httpsUrl = url.replace(/^http:\/\//, 'https://')
              const retry = await browser.action(action, { url: httpsUrl })
              if (retry.ok) {
                return jsonResult({
                  status: 'ok',
                  url: retry.url,
                  title: retry.title,
                  // 讲出来，模型这一轮里再开这个站就直接写 https 了
                  note: `${url} 连不上（${result.error}），已自动改用 https 打开。这个站点后续请显式写 https://。`,
                })
              }
            }

            return jsonResult({
              status: 'error',
              error: result.error,
              ...(assumed
                ? { hint: `地址没写协议，已按默认规则补成 ${url}（内网系统多数只开 80）。若该站点是 https，请显式写 https:// 重试。` }
                : {}),
            })
          }

          case 'snapshot': {
            const result = await browser.action('snapshot')
            if (!result.ok) return jsonResult({ status: 'error', error: result.error })
            const header = `[Page: ${result.title || 'Untitled'}] [URL: ${result.url}] [${result.refCount} interactive elements]\n---\n`
            return textResult(header + result.snapshot)
          }

          case 'screenshot': {
            const result = await browser.action('screenshot', {
              waitMs: Number.isFinite(params.waitMs) ? params.waitMs : undefined,
              fullPage: Boolean(params.fullPage),
            })
            if (!result.ok) return jsonResult({ status: 'error', error: result.error })
            // 桌面端把图片写到磁盘、回一个本地路径给渲染端读；云端沙盒的磁盘渲染端看不见。
            //
            // 但也**不能**把 base64 塞进文本里：一张 16KB 的截图就是 2 万多字符 ≈ 5k token，
            // 而且模型只会把它当成一串乱码 —— 它根本"看不见"这张图。
            // pi 的 AgentToolResult.content 支持 image part，走这条路模型才是真的在看图。
            //
            // image part **无论如何都带上**：界面上的截图是从工具结果里取的
            // （agent/events.js 的 collectImages），跟模型认不认图无关。
            // 模型看不了的时候，用户仍然该看得到那张图。
            const lines = [
              `Screenshot captured: ${result.title || 'Untitled'} (${result.url})`,
              `Mode: ${result.dimensions?.mode || 'viewport'}`,
              `Size: ${result.sizeBytes} bytes`,
            ]
            /**
             * 当前模型不支持读图时，**必须明说**。
             *
             * pi 在 openai-completions 层遇到 `model.input` 不含 image 会把图片
             * 静默丢掉，模型只收到上面那三行。它于是要么说"截图拿到了但我看不见"，
             * 要么干脆假装看过 —— 两种都很糟，而且从日志里完全看不出发生了什么。
             * 把这件事写进它能收到的文本里，它至少能如实告诉用户、并改用 snapshot。
             */
            if (api.config?.imageCapable === false) {
              lines.push(
                '',
                '注意：当前模型不支持读取图片，这张截图**没有**发送给你（用户在界面上能看到它）。',
                '你看不到页面视觉内容。要了解页面结构请改用 action=snapshot。',
              )
            }
            return {
              content: [
                { type: 'text', text: lines.join('\n') },
                { type: 'image', data: result.contentBase64, mimeType: 'image/png' },
              ],
              details: { url: result.url, title: result.title, sizeBytes: result.sizeBytes },
            }
          }

          case 'act': {
            if (!params.kind) return jsonResult({ status: 'error', error: 'act 需要 kind 参数' })
            const result = await browser.action('act', {
              kind: params.kind,
              ref: params.ref,
              text: params.text,
              key: params.key,
              values: params.values,
              fn: params.fn,
              doubleClick: params.doubleClick,
              timeMs: params.timeMs,
              exact: params.exact,
              openDelayMs: params.openDelayMs,
            })
            if (!result.ok) return jsonResult({ status: 'error', error: result.error })
            return jsonResult({ status: 'ok', ...stripEnvelope(result) })
          }

          case 'evaluate':
          case 'script': {
            if (!params.fn) return jsonResult({ status: 'error', error: `${action} 需要 fn 参数` })
            const result = await browser.action('evaluate', { fn: params.fn })
            if (!result.ok) return jsonResult({ status: 'error', error: result.error })
            return jsonResult({ status: 'ok', value: result.value })
          }

          case 'network': {
            const op = params.networkOp || 'list'
            if (op === 'clear') {
              const result = await browser.action('network.clear')
              return jsonResult({ status: 'ok', ...stripEnvelope(result) })
            }
            const result = await browser.action('network', {
              limit: params.limit,
              onlyErrors: params.onlyErrors,
              contains: params.contains,
            })
            if (!result.ok) return jsonResult({ status: 'error', error: result.error })
            if (op === 'status') {
              return jsonResult({
                status: 'ok',
                count: result.count,
                totalTracked: result.totalTracked,
                items: (result.items || []).slice(-5),
              })
            }
            return jsonResult({ status: 'ok', ...stripEnvelope(result) })
          }

          case 'close': {
            const result = await browser.action('close')
            return jsonResult({ status: 'ok', ...stripEnvelope(result) })
          }

          default:
            return jsonResult({ status: 'error', error: `未知 action: ${action}；可用：${ACTIONS.join(' / ')}` })
        }
      } catch (error) {
        api.logger.warn?.('workstation_browser 失败', { action, err: error?.message })
        return jsonResult({ status: 'error', error: error?.message || String(error) })
      }
    },
  })
}

/** 去掉 worker 回包的信封字段，只把业务结果给模型 */
function stripEnvelope(result) {
  const { ok, action, ...rest } = result
  return rest
}

export const workstationBrowserPlugin = {
  id: 'ap-workstation-browser',
  register: registerWorkstationBrowserTool,
}
