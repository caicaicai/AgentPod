/**
 * HTTP 接入层：路由、鉴权、SSE、优雅停机。
 *
 * 约定：
 *   - 业务错误一律用 AppError，状态码与 code 由 errors.js 统一定义
 *   - 每个请求带 requestId，贯穿日志
 *   - 调试端点（隔离自检）只在 DEV_CONSOLE=1 时挂载
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeAttachments } from '../agent/attachments.js'
import { artifactFileName, artifactDisposition } from '../artifacts/store.js'
import { AppError, Errors, toAppError } from '../errors.js'
import { validateCredentials, signToken } from '../identity/password-auth.js'
import { assertSegment } from '../persistence/paths.js'
import { toPublicModels } from '../models/llminfo-client.js'
import { parseTranscript } from '../sessions/transcript.js'
import { describeCredential } from '../tools/context.js'
import { resolveTraceId } from '../trace.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/**
 * 界面是 web/ 下的 Vue + Vite 工程，这里服务的是它的**构建产物**。
 *
 * 指向 dist/ 而不是 web/：源码目录里有 src/*.vue、vite.config.js、node_modules，
 * 浏览器一个都跑不了；把源码目录当静态根，等于把不该出去的东西摆在门口，
 * 还得靠白名单后缀挡着。产物目录里只有 index.html + assets/，本来就该全部可读。
 *
 * 本地开发另有一条路：`npm --prefix web run dev`，Vite 自己起 5273 端口并把
 * /v1 与 /healthz 代理到这个进程（见 web/vite.config.js）。
 *
 * `config.webDir` 可以覆盖它，今天只有测试在用：静态服务的用例不该要求
 * "先把前端构建出来"，那会让一个刚 clone 下来的仓库跑 `npm test` 就红。
 * 生产不设这个字段，走下面这个默认值。
 */
const DEFAULT_WEB_DIR = path.resolve(__dirname, '../../web/dist')

/**
 * 界面自己的那几条地址。**它们全都回同一个 index.html**，由前端按路径决定画什么
 * （见 web/src/lib/route.js）。
 *
 * 为什么不做成"凡是不认识的 GET 都回 index.html"：那样 `/v1/sessons/x`（打错一个字母）
 * 会得到一个 200 的 HTML 而不是 404，调接口的人只能对着一段 `<!doctype html>` 猜哪儿错了。
 * 白名单是多一行维护换一次说得清的失败 —— 前端加一条新地址时这里要跟着加，
 * 忘了的话表现很明确：应用里点得进去，刷新就 404。
 */
const APP_PATHS = [/^\/c\/[^/]+$/, /^\/artifacts(\/[^/]+)?$/, /^\/admin(\/[^/]+)?$/]

function isAppPath(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/'
  return APP_PATHS.some((pattern) => pattern.test(path))
}

/**
 * sessionKey 是客户端自选的。它会成为存储主键的一部分（内存里是
 * `${username}::${sessionKey}`，MySQL 里是 VARCHAR(128)），所以先收口成一个
 * 安全字符集，免得靠"username 里应该不会有分隔符"这种假设来保证不串号。
 */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/

function assertSessionKey(sessionKey) {
  if (!SESSION_KEY_RE.test(sessionKey)) {
    throw Errors.badRequest('sessionKey 只能是字母、数字、下划线或连字符，且不超过 128 字符')
  }
  return sessionKey
}

/** 只服务这几类静态资源。没列进来的后缀一律 404，省得哪天 web/ 里落了个 .env 就被读走 */
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

/**
 * 响应统一带 `requestId`：用户拿一条报错来问时，凭它就能在日志里定位到那次请求。
 * 头和体各放一份 —— 头方便代理/抓包看到，体方便调用方原样记进自己的日志。
 */
function sendJson(res, status, payload) {
  const requestId = res.__requestId || ''
  const body = JSON.stringify(requestId && payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload, requestId }
    : payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(requestId ? { 'x-request-id': requestId } : {}),
  })
  res.end(body)
}

async function readJsonBody(req, limitBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw Errors.badRequest(`请求体超过 ${limitBytes} 字节上限`)
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Errors.badRequest('请求体不是合法 JSON')
  }
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  let seq = 0
  let closed = false
  return {
    send(type, data) {
      // 收尾之后再来的帧直接丢掉，而不是往已经 end 的响应上写（那会抛
      // ERR_STREAM_WRITE_AFTER_END，把一次已经成功的对话变成一条错误日志）
      if (closed) return
      seq += 1
      res.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    /** 幂等：正常路径上会被调用两次（收到末帧一次、外层 finally 一次） */
    end() {
      if (closed) return
      closed = true
      res.end()
    },
  }
}

/**
 * 静态资源。
 *
 * 目录穿越防护做在**解析之后**：`path.resolve` 把 `..` 和各种编码都摊平了，
 * 再检查结果是否仍落在允许的目录里 —— 比在原始串上找 `..` 可靠得多。
 *
 * `confineTo` 默认是整个 dist/，但 `/assets/*` 这类通配路由仍然收窄到自己那层：
 * 那条路由的参数完全由请求控制，把它圈在 assets/ 里，`%2e%2e` 之类的花样就
 * 连产物目录的其余部分都碰不到，更不用说 dist/ 以外。
 *
 * @returns {Promise<boolean>} 是否已经把响应写完
 */
async function serveStatic(res, pathname, { webDir, confineTo = webDir } = {}) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return false // 不合法的百分号编码，当没这个文件
  }
  const file = path.resolve(webDir, `.${decoded}`)
  if (file !== confineTo && !file.startsWith(confineTo + path.sep)) return false

  const type = STATIC_TYPES[path.extname(file).toLowerCase()]
  if (!type) return false

  let body
  try {
    body = await readFile(file)
  } catch {
    return false
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    // 开发期改完刷新就要看到新的；这点体积不值得为它调缓存
    'Cache-Control': 'no-cache',
  })
  res.end(body)
  return true
}

export function createServer({
  config, logger, identity, broker, runService, store, llmInfoClient, metrics, workspace = null,
  skillManager = null, memory = null, projects = null, crons = null, scheduler = null, cronVault = null,
  artifacts = null, shares = null, users = null, usage = null, modelStore = null, groups = null,
}) {
  const webDir = config.webDir || DEFAULT_WEB_DIR

  /**
   * 读一份作品的正文，把 store 抛出来的两类失败翻译成对应的 HTTP 语义。
   *
   * store 对"没有这个作品"（回 null）和"没有这一版 / 这一版被清理了"（抛错）
   * 是分开表达的，这里必须跟着分开：全都糊成 404 的话，用户看到的是"作品不存在"
   * ——而他明明在列表里看得见它，只是点了一个太老的版本。
   */
  async function readArtifactOr404({ username, id, version }) {
    let current
    try {
      current = await artifacts.read({ username, id, version: Number(version) || 0 })
    } catch (error) {
      throw Errors.badRequest(error.message)
    }
    if (!current) throw Errors.notFound('作品不存在')
    return current
  }

  /**
   * 下发作品里的**单个文件的原文**。登录态那条路和分享那条路共用这一份。
   *
   * ⚠️ **无论什么后缀，一律 `text/plain`。** 这里躺着的是模型生成的 HTML：
   * 用 `text/html` 回，这个 URL 就成了一个**同源**的、内容由模型（也就可能由
   * 一封诱导邮件）决定的页面 —— 它能读走 localStorage 里的登录令牌。
   * 预览走的是另一条路：文件进 JSON，由前端拼好后塞进不带 allow-same-origin 的
   * sandbox iframe（见 web/src/modules/artifacts/artifact-view.js）。
   * 所以这条不变量很值钱：**本服务从不以 HTML 的身份吐出任何模型生成的内容。**
   *
   * 抽成一个函数正是为了守住它：分享功能上线时这段逻辑差点被复制一份，
   * 而复制出来的那份迟早只改了其中一边 —— 那种漏洞从日志里一点也看不出来。
   */
  function sendArtifactFile(res, { current, wanted, download }) {
    const target = wanted || current.meta.entry
    const file = current.files.find((item) => item.path === target)
    if (!file) throw Errors.notFound(`第 ${current.version} 版没有 ${target}`)

    const body = Buffer.from(file.content, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      // 没有它，浏览器会去嗅探内容，一段 HTML 照样能被当页面渲染 ——
      // 上面那条不变量就白写了
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': artifactDisposition({
        fileName: artifactFileName({ title: current.meta.title, entry: file.path }),
        download: Boolean(download),
      }),
      'Cache-Control': 'no-store',
    })
    return res.end(body)
  }

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID().slice(0, 8)
    const url = new URL(req.url, 'http://localhost')
    // traceId 由上游带来（有分布式追踪时）或本地生成，逐跳透传下去，
    // 把 agent 的一次请求、沙盒上的执行、桥的一次出网串成一条链。
    const traceId = resolveTraceId(req.headers)
    res.__requestId = requestId
    res.setHeader('x-trace-id', traceId)
    const reqLogger = logger.child({ requestId, traceId })

    try {
      await route({ req, res, url, reqLogger })
    } catch (error) {
      const appError = toAppError(error)
      if (appError.status >= 500) reqLogger.error('请求失败', { path: url.pathname, code: appError.code, message: appError.message })
      else reqLogger.warn('请求被拒', { path: url.pathname, code: appError.code, message: appError.message })
      if (!res.headersSent) sendJson(res, appError.status, appError.toJSON())
      else res.end()
    }
  })

  async function route({ req, res, url, reqLogger }) {
    // ---------- 无需身份 ----------
    if (url.pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        ...runService.snapshot(),
        authMode: config.auth.mode,
        llmMode: config.llm.mode,
        sandbox: config.sandbox.mode,
        // 界面据此决定要不要显示"开发控制台"入口和 dev 身份输入框
        devConsole: config.devConsole,
        webUi: config.webUi,
        // 界面据此决定要不要画「项目 / 记忆 / 定时任务」这几块。
        // 没有它，关掉的能力会以"点了没反应"的形式出现，而不是干脆不显示。
        features: {
          sessionStore: store.driver,
          // memory 这一层要么整体在、要么整体不在：`file` 之外的驱动也能用，
          // 因为它落的是 DATA_DIR，与会话驱动无关
          memory: Boolean(memory?.enabled),
          projects: Boolean(projects?.enabled),
          cron: Boolean(crons?.enabled),
          cronScheduler: Boolean(scheduler?.enabled),
          cronCredentialMode: config.cron.credentialMode,
          artifacts: Boolean(artifacts?.enabled),
          // 分开两个开关：能不能生成链接、能不能上广场，是两个决定（见 shares.js）
          artifactShare: Boolean(shares?.enabled),
          artifactMarket: Boolean(shares?.marketEnabled),
          // 界面据此决定画不画「注册」「改密」「用户管理」
          accounts: Boolean(users),
          register: Boolean(users) && Boolean(config.auth.password?.allowRegister),
          // 管理台的「Token 用量」那一页。只有管理员看得到那一页，但这个宣告是公开的：
          // 它说的是"这个部署记不记账"，不是"谁用了多少"
          usage: Boolean(usage?.enabled),
        },
        // 只有 mysql 一种，报出来是给运维确认"我确实连着库"
        storage: 'mysql',
      })
    }
    if (url.pathname === '/metrics.json') {
      return sendJson(res, 200, metrics.snapshot())
    }

    // ---------- 账号密码登录（AUTH_MODE=password 时生效）----------
    /**
     * ⚠️ 这里必须是**明确列出的两条**，不能写成 `startsWith('/v1/auth/')` 加例外。
     *
     * 第一版就是那么写的（前缀匹配 + 排除 `/v1/auth/me`），于是后来加的
     * `/v1/auth/password`（改密码，**需要登录**）被这一块提前吃掉、回了一句
     * "没有这个接口" —— 它在鉴权之前，而改密码的处理器在鉴权之后，根本走不到。
     * 现象是接口 404，而路由代码看起来完全正常。
     *
     * 前缀 + 例外清单的问题在于：新增一条同前缀的路由时，**没有任何东西提醒你
     * 去补例外**。列举法反过来 —— 忘了加就是压根匹配不上，而不是被静默劫走。
     */
    if (url.pathname === '/v1/auth/login' || url.pathname === '/v1/auth/register') {
      if (config.auth.mode !== 'password') {
        return sendJson(res, 404, { error: 'NOT_FOUND', message: '当前 AUTH_MODE 不支持密码登录' })
      }

      /** 用户名和密码两个字段的取法一模一样，别写三遍 */
      async function readCredentials() {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        const username = typeof body?.username === 'string' ? body.username.trim() : ''
        if (!username) throw Errors.badRequest('用户名必填')
        return { body: body || {}, username }
      }

      const ttlSec = config.auth.password.sessionTtlHours * 3600

      if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
        const { body, username } = await readCredentials()
        if (typeof body.password !== 'string' || !body.password) throw Errors.badRequest('密码必填')

        /**
         * 账号来自存储（见 src/identity/user-store.js）。没接 users 时才退回
         * CONSOLE_USERS 的明文比对 —— 那条路只剩下不带账号体系的部署在走。
         */
        let ok = false
        let reason = ''
        if (users) {
          const result = await users.verify(username, body.password)
          ok = result.ok
          reason = result.reason || ''
          if (!ok && reason === 'no-such-user' && (await users.count()) === 0) {
            return sendJson(res, 503, {
              error: 'NO_USERS',
              message: '还没有任何账号：配置 CONSOLE_USERS 后重启，或开启 AUTH_ALLOW_REGISTER 让第一个人自己注册',
            })
          }
        } else {
          if (!identity.passwordUsers || identity.passwordUsers.size === 0) {
            return sendJson(res, 503, { error: 'NO_USERS', message: '未配置 CONSOLE_USERS 环境变量，无法登录' })
          }
          ok = validateCredentials(identity.passwordUsers, username, body.password)
        }

        if (!ok) {
          // 日志里记下真实原因（禁用 / 密码错 / 无此人），**响应里一律同一句** ——
          // 区分开就等于告诉撞库的人"这个用户名是对的，继续猜密码"
          reqLogger.warn('密码登录失败', { username, reason })
          if (reason === 'disabled') throw Errors.unauthenticated('该账号已被禁用')
          throw Errors.unauthenticated('用户名或密码错误')
        }

        const { token, expiresAt } = signToken(username, identity.passwordSecret, ttlSec)
        reqLogger.info('密码登录成功', { username })
        return sendJson(res, 200, { ok: true, token, expiresAt, username })
      }

      /**
       * 注册。**默认关**（AUTH_ALLOW_REGISTER=0）。
       *
       * 开放注册意味着任何能访问到这个地址的人都能拿到一个账号，
       * 而账号在这里等于"能跑模型、能开沙盒"。所以它是一个必须显式打开的开关，
       * 不是一个默认能力。内网部署想让同事自助开号时才打开。
       */
      if (req.method === 'POST' && url.pathname === '/v1/auth/register') {
        if (!users) throw Errors.notFound('本部署未启用账号存储')
        if (!config.auth.password.allowRegister) {
          throw Errors.forbidden('本部署未开放注册（AUTH_ALLOW_REGISTER=0），请让管理员创建账号')
        }
        const { body, username } = await readCredentials()
        try {
          // 第一个注册进来的人是管理员：全新部署里总得有人能管别人，
          // 而那时还没有任何管理员可以来授权
          const first = (await users.count()) === 0
          const user = await users.create({ username, password: body.password, role: first ? 'admin' : 'user' })
          const { token, expiresAt } = signToken(username, identity.passwordSecret, ttlSec)
          reqLogger.info('注册成功', { username, role: user.role })
          return sendJson(res, 201, { ok: true, user, token, expiresAt, username })
        } catch (error) {
          throw Errors.badRequest(error.message)
        }
      }

      throw Errors.notFound('没有这个接口')
    }

    // ---------- 静态页面 ----------
    // 页面本身不含任何用户数据，数据一律由下面那些要身份的接口提供，所以静态资源不鉴权。
    if (req.method === 'GET') {
      if (config.webUi) {
        if (url.pathname === '/' || url.pathname === '/index.html' || isAppPath(url.pathname)) {
          const redirect = identity.navigationRedirect?.({ req, url }) || ''
          if (redirect) {
            reqLogger.info('未登录，跳转登录页', { path: url.pathname })
            res.writeHead(302, { Location: redirect, 'Cache-Control': 'no-store' })
            return res.end()
          }
          if (await serveStatic(res, '/index.html', { webDir })) return
        }
        // Vite 把带哈希的 JS/CSS 都放在 assets/ 下，也就是首屏必需的那几个文件
        const assetsDir = path.join(webDir, 'assets')
        if (url.pathname.startsWith('/assets/')
          && (await serveStatic(res, url.pathname, { webDir, confineTo: assetsDir }))) return
        // favicon 这类 Vite 放在产物根目录的静态文件
        if (url.pathname === '/favicon.svg' && (await serveStatic(res, url.pathname, { webDir }))) return

        /**
         * 分享页与市场页：把**我们自己的** index.html 回过去，由前端按路径决定画什么。
         *
         * 注意这里回的始终是同一个 SPA 骨架，**不是**那份作品的 HTML ——
         * 作品正文只走 /v1/public/shares/:token 的 JSON，再由前端塞进
         * 不带 allow-same-origin 的沙箱 iframe。同源的那一层永远是我们的代码。
         *
         * token 的合法性不在这里查：查了也只是把 404 提前，而"这个 token 存不存在"
         * 该由前端拿数据接口的结果来说（那样错误提示是一个人看得懂的页面，
         * 而不是浏览器默认的空白 404）。
         */
        if (shares?.enabled && (url.pathname.startsWith('/s/') || url.pathname === '/market')) {
          if (await serveStatic(res, '/index.html', { webDir })) return
        }
      }
    }

    /* ─────────────── 公开分享（**不需要身份**）─────────────── */

    /**
     * ⚠️ 整个服务里只有这一块在 identity.resolve 之前。加路由到这儿之前先想清楚：
     * 它回的每一个字节都会被没有账号的人看到。
     *
     * 三条约束，任何新增的公开路由都要照做：
     *   1. **只认 token**，绝不接受 username / artifactId 之类由调用方指定的定位参数 ——
     *      否则这就成了一个"报上 id 就能读任意人作品"的接口；
     *   2. 失败一律 404，不区分"没这个链接"和"链接被撤销了"——
     *      区分开就等于给了一个探测 token 是否存在过的口子；
     *   3. 正文一律 text/plain（见 sendArtifactFile 上面那段）。
     */
    if (url.pathname.startsWith('/v1/public/')) {
      if (!shares?.enabled) throw Errors.notFound('本部署未启用作品分享（ARTIFACT_SHARING_ENABLED=0）')

      if (req.method === 'GET' && url.pathname === '/v1/public/market') {
        if (!shares.marketEnabled) throw Errors.notFound('本部署未启用作品市场（ARTIFACT_MARKET_ENABLED=0）')
        return sendJson(res, 200, {
          items: await shares.listMarket({
            q: url.searchParams.get('q') || '',
            kind: url.searchParams.get('kind') || '',
          }),
        })
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/public/shares/')) {
        let rest = ''
        try {
          rest = decodeURIComponent(url.pathname.slice('/v1/public/shares/'.length))
        } catch {
          throw Errors.notFound('没有这个接口') // 百分号编码都不合法，当没这条路由
        }
        const isRaw = rest.endsWith('/raw')
        const token = isRaw ? rest.slice(0, -'/raw'.length) : rest
        if (!token || token.includes('/')) throw Errors.notFound('没有这个接口')

        const current = await shares.open(token)
        // 撤销了、作品删了、token 是编的 —— 对外都是同一句话，见上面第 2 条
        if (!current) throw Errors.notFound('这个分享链接不存在或已被取消')

        if (isRaw) {
          return sendArtifactFile(res, {
            current,
            wanted: url.searchParams.get('path'),
            download: url.searchParams.get('download') === '1',
          })
        }

        // 计数放在真的要回内容的这一支里，且不 await：它是"顺便"的东西，
        // 一次写盘失败不该让访客看不成作品（见 shares.js 的 countView）
        shares.countView(current.share.token)
        return sendJson(res, 200, {
          ...current,
          // 与登录态那条清单接口同一个理由：前端拿它拼预览 iframe 的 CSP，
          // 自己硬编一份的话，改了服务端配置而前端没跟上，两边谁也看不出来
          preview: { allowedOrigins: config.artifacts.allowedOrigins },
          // 分享页据此决定画不画"去作品市场"那个入口。访客没有 /healthz 那份能力宣告
          // （他也不该为了看一份作品去打一遍平台的自检接口），所以在这儿一并给
          features: { market: Boolean(shares.marketEnabled) },
        })
      }

      throw Errors.notFound('没有这个接口')
    }

    // ---------- 以下都需要服务端校验过的身份 ----------
    const subject = await identity.resolve(req)
    reqLogger.debug('请求', { path: url.pathname, username: subject.username, credentialSource: subject.credentialSource })

    /**
     * 「服务端认为我是谁」。
     *
     * 未登录时走的是统一错误出口：401 + `details.loginUrl`，前端据此跳转。
     * 这个端点存在的意义主要是**部署自检** —— 有它就能一眼看清"到底收到了什么"，
     * 不用去翻日志猜。
     *
     * `credentialFacts` 回的是 `describeCredential()` 那三个**布尔值**，不是凭据内容
     * （隔离契约：凭据不下发给浏览器）。它回答的是一个具体问题：
     * `api.m.xiaocaicai.com`），云端能不能零改动接住它们，第一步就是看这个字段。
     * 为 false 时才需要服务端去铸 token（JoySpace 链路 / tokenGrant 代持）。
     */
    if (req.method === 'GET' && url.pathname === '/v1/auth/me') {
      return sendJson(res, 200, {
        ok: true,
        authMode: config.auth.mode,
        username: subject.username,
        user: subject.user || { username: subject.username },
        credentialSource: subject.credentialSource,
        credentialFacts: describeCredential(subject.credential),
        verified: Boolean(subject.verified),
        cached: Boolean(subject.cached),
        // 界面据此决定画不画「管理员」那一块。没接账号存储时为 null
        account: users ? await users.get(subject.username) : null,
      })
    }

    /* ─────────────── 账号（改密 / 管理）─────────────── */

    /**
     * `/v1/admin/` 整个前缀都收在这一块里（管人、看用量）。
     *
     * 前缀匹配在这儿是安全的，而在鉴权**之前**那块 auth 路由里不行 ——
     * 区别在于：那边前缀一宽就会把需要登录的路由当成匿名的未知接口吃掉（真发生过，
     * 见下面 /v1/auth/password 那段的注释）；这边前缀一宽只会让新的 /v1/admin/*
     * 自动继承"必须是管理员"这条判定，而那正是我们要的默认值。
     */
    if (url.pathname === '/v1/auth/password' || url.pathname.startsWith('/v1/admin/')) {
      if (!users) throw Errors.notFound('本部署未启用账号存储（AUTH_MODE 不是 password）')

      /**
       * 改自己的密码。**必须带旧密码**。
       *
       * 令牌可能是从别人电脑上、从一次共享屏幕里拿到的；只凭令牌就能改密，
       * 等于把"临时借用"直接变成"永久接管"，而真正的主人连登录都做不到了。
       */
      if (req.method === 'POST' && url.pathname === '/v1/auth/password') {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          const result = await users.changePassword({
            username: subject.username,
            oldPassword: body.oldPassword,
            newPassword: body.newPassword,
          })
          if (!result.ok) throw Errors.badRequest(result.error || '改密失败')
          reqLogger.info('用户改密成功', { username: subject.username })
          /**
           * 已签发的令牌**不会失效** —— 签名密钥没变，旧令牌到期前照样能用。
           * 如实告诉调用方，别让人以为改完密码就把别处的登录踢掉了。
           */
          return sendJson(res, 200, { ok: true, tokensRevoked: false })
        } catch (error) {
          if (error instanceof AppError) throw error
          throw Errors.badRequest(error.message)
        }
      }

      /* ── 以下要管理员 ── */
      const me = await users.get(subject.username)
      if (me?.role !== 'admin') throw Errors.forbidden('需要管理员权限')

      if (req.method === 'GET' && url.pathname === '/v1/admin/users') {
        return sendJson(res, 200, { users: await users.list() })
      }

      if (req.method === 'POST' && url.pathname === '/v1/admin/users') {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          // groupId 不传 = 进默认分组（user-store 去查）；传空串 = 明确不进任何分组
          if (typeof body.groupId === 'string' && body.groupId && !(await groups?.get(body.groupId))) {
            throw Errors.badRequest('分组不存在')
          }
          const created = await users.create({
            username: body.username,
            password: body.password,
            role: body.role,
            ...(typeof body.groupId === 'string' ? { groupId: body.groupId } : {}),
          })
          reqLogger.info('管理员创建账号', { by: subject.username, username: created.username, group: created.groupId })
          return sendJson(res, 201, { ok: true, user: created })
        } catch (error) {
          throw Errors.badRequest(error.message)
        }
      }

      /* ── Token 用量 ── */

      /**
       * 谁在用多少 token、花在哪个模型上。
       *
       * 只回聚合数：次数、输入/输出/缓存读入的 token、最近一次的时间。
       * **一个字的对话内容都不经过这里** —— 管理员该看得见成本，不该顺带看见
       * 别人写了什么，而"顺带能看见"迟早会有人真的去看。
       *
       *   days   时间窗（默认 30，0 = 全部）
       *   group  `user`（默认）每个账号一行、带他用过的模型；`model` 每个模型一行、
       *          带用了它的人。同一份交叉表的两种转置，所以两页合计相等。
       *
       * 台账里没有的账号也会出现在 `group=user` 的清单里（一行 0），否则"没用过"
       * 和"不存在"在界面上长得一样。模型那一维没有这层补零：服务端没有"本部署有
       * 哪些模型"的权威清单（每个用户的可用模型是各自从 llminfo 拿的）。
       */
      if (req.method === 'GET' && url.pathname === '/v1/admin/usage') {
        if (!usage?.enabled) return sendJson(res, 200, { enabled: false, users: [], models: [], total: null })
        return sendJson(res, 200, await usage.summary({
          accounts: await users.list(),
          days: url.searchParams.get('days'),
          group: url.searchParams.get('group') || 'user',
        }))
      }

      /**
       * 展开一行看趋势（按天）。
       *
       * 路径分成 `.../usage/user/<名字>` 与 `.../usage/model/<模型>` 两条，而不是
       * 共用一个 `.../usage/<谁>`：模型 id 和用户名住在同一层的话，一个叫 `model`
       * 的账号就能把另一条路由遮掉。多一段前缀换掉这类**取决于命名巧合**的歧义。
       *
       * 汇总不在这两条路由上 —— 它已经在总表每一行里带下来了，展开时不再打一次，
       * 也就不会出现"表里 450,092、展开后 450,091"这种对不上。
       */
      if (req.method === 'GET' && url.pathname.startsWith('/v1/admin/usage/user/')) {
        /**
         * 名字先过一遍字符集再往下传。
         *
         * 用的是**存储层那一个** assertSegment，不是账号那一个 assertUsername：
         * 后者允许 `..`（当用户名它没问题），而存储层会拒绝它并抛一个普通 Error ——
         * 于是一个打错的名字会表现成 500。两处用同一个判据，过了这里就一定过那边。
         */
        let who
        try {
          who = assertSegment(decodeURIComponent(url.pathname.slice('/v1/admin/usage/user/'.length) || ''), '用户名')
        } catch (error) {
          throw Errors.badRequest(error.message)
        }
        if (!usage?.enabled) return sendJson(res, 200, { enabled: false, username: who, daily: [] })
        const trend = await usage.trend({
          username: who,
          // 带上模型就只看他在这个模型上的曲线（换模型前后的对比）
          modelId: url.searchParams.get('modelId') || '',
          days: url.searchParams.get('days'),
        })
        /**
         * 名字既不是一个账号、台账里也一行都没有 → 404。
         *
         * 不能只判"是不是账号"：账号删掉之后它的账还在台账里（总表上那一行标着
         * orphan），点开来该看得到明细。也不能不判：那样一个打错的名字会回一张
         * 全是 0 的表，看起来像"这个人没用过"。
         */
        if (!trend.total.runs && !(await users.get(who))) throw Errors.notFound('用户不存在')
        return sendJson(res, 200, trend)
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/admin/usage/model/')) {
        /**
         * 模型 id **不过 assertSegment**：那是给路径段用的（≤64 字符、不许有 `/`），
         * 而模型 id 是网关给的一个字符串，`vendor/name:tag` 这种写法完全合法。
         * 它在这里只当查询参数用（参数化 SQL，不拼路径），所以只收口长度。
         */
        const modelId = decodeURIComponent(url.pathname.slice('/v1/admin/usage/model/'.length) || '')
        if (!modelId || modelId.length > 128) throw Errors.badRequest('模型 id 不合法')
        if (!usage?.enabled) return sendJson(res, 200, { enabled: false, modelId, daily: [] })
        const trend = await usage.trend({ modelId, days: url.searchParams.get('days') })
        // 模型没有"账号表"可以对照，所以判据只有一条：台账里有没有它
        if (!trend.total.runs) throw Errors.notFound('这个模型在该时间窗内没有用量')
        return sendJson(res, 200, trend)
      }

      /* ══════════ 模型配置（LLM_MODE=db 的那份清单）══════════ */

      /**
       * 这一组接口在**任何 LLM_MODE 下都开着**，但只有 db 模式下配的东西才生效。
       *
       * 反过来（非 db 模式就 404）会逼出一个没必要的停机：管理员得先把 LLM_MODE
       * 切到 db、重启、发现一个模型都没有、所有人的对话一起断，然后才能开始配。
       * 现在是先配好、再切模式。`effective` 这个字段就是给界面写那句提示用的。
       */
      if (url.pathname === '/v1/admin/models' || url.pathname.startsWith('/v1/admin/models/')) {
        if (!modelStore) throw Errors.notFound('本部署没有启用模型配置')
        const modelId = url.pathname.startsWith('/v1/admin/models/')
          ? decodeURIComponent(url.pathname.slice('/v1/admin/models/'.length))
          : ''

        if (req.method === 'GET' && !modelId) {
          return sendJson(res, 200, {
            models: await modelStore.list(),
            // 现在这份清单起不起作用。界面据此在顶部写一条提示，而不是让管理员
            // 配完之后才发现 LLM_MODE 还指着别处
            effective: config.llm.mode === 'db',
            llmMode: config.llm.mode,
            // key 是不是加密入库的。没加密时界面上要说一句，别让人以为它天然安全
            encrypted: Boolean(config.llm.configSecret),
          })
        }

        if (req.method === 'POST' && !modelId) {
          const body = await readJsonBody(req, config.limits.bodyLimitBytes)
          try {
            const created = await modelStore.create(body)
            reqLogger.info('管理员新增模型', { by: subject.username, model: created.model })
            return sendJson(res, 201, { ok: true, model: created })
          } catch (error) {
            throw Errors.badRequest(error.message)
          }
        }

        if (req.method === 'PATCH' && modelId) {
          const body = await readJsonBody(req, config.limits.bodyLimitBytes)
          try {
            const updated = await modelStore.update(modelId, body)
            if (!updated) throw Errors.notFound('模型配置不存在')
            reqLogger.info('管理员修改模型', { by: subject.username, model: updated.model })
            return sendJson(res, 200, { ok: true, model: updated })
          } catch (error) {
            if (error instanceof AppError) throw error
            throw Errors.badRequest(error.message)
          }
        }

        if (req.method === 'DELETE' && modelId) {
          if (!(await modelStore.remove(modelId))) throw Errors.notFound('模型配置不存在')
          reqLogger.info('管理员删除模型', { by: subject.username, id: modelId })
          /**
           * **用量台账不动。** 那些行按 model_id 记着，模型配置删了不代表历史用量
           * 不存在了 —— 账单还要对。管理台的用量页照样列得出它（与"账号已删除"
           * 那一行同一个道理）。
           */
          return sendJson(res, 200, { ok: true })
        }

        throw Errors.notFound('没有这个接口')
      }

      /* ══════════ 用户分组 ══════════ */

      if (url.pathname === '/v1/admin/groups' || url.pathname.startsWith('/v1/admin/groups/')) {
        if (!groups) throw Errors.notFound('本部署没有启用用户分组')
        const groupId = url.pathname.startsWith('/v1/admin/groups/')
          ? decodeURIComponent(url.pathname.slice('/v1/admin/groups/'.length))
          : ''

        if (req.method === 'GET' && !groupId) {
          const list = await groups.list()
          /**
           * 顺带回每个分组**有多少人、能用几个模型**。
           *
           * 这两个数是管理员看这一页时真正要问的问题（"这个分组是空的吗"、
           * "这个分组的人有模型可用吗"），而它们各自要遍历另外两个集合 ——
           * 让界面自己去算的话，那两份清单得在前端各拉一次再对齐，
           * 而分组页本来不需要知道模型和账号长什么样。
           */
          const accounts = users ? await users.list() : []
          const models = modelStore ? await modelStore.list() : []
          return sendJson(res, 200, {
            groups: list.map((group) => ({
              ...group,
              userCount: accounts.filter((account) => account.groupId === group.id).length,
              modelCount: models.filter(
                (model) => model.enabled && (!model.groups.length || model.groups.includes(group.id)),
              ).length,
            })),
            // 无分组的人也要有个地方看得见 —— 否则"人数加起来对不上"没法解释
            ungrouped: accounts.filter((account) => !account.groupId).length,
          })
        }

        if (req.method === 'POST' && !groupId) {
          const body = await readJsonBody(req, config.limits.bodyLimitBytes)
          try {
            const created = await groups.create(body)
            reqLogger.info('管理员新建分组', { by: subject.username, group: created.name })
            return sendJson(res, 201, { ok: true, group: created })
          } catch (error) {
            throw Errors.badRequest(error.message)
          }
        }

        if (req.method === 'PATCH' && groupId) {
          const body = await readJsonBody(req, config.limits.bodyLimitBytes)
          try {
            const updated = await groups.update(groupId, body)
            if (!updated) throw Errors.notFound('分组不存在')
            return sendJson(res, 200, { ok: true, group: updated })
          } catch (error) {
            if (error instanceof AppError) throw error
            throw Errors.badRequest(error.message)
          }
        }

        if (req.method === 'DELETE' && groupId) {
          if (!(await groups.get(groupId))) throw Errors.notFound('分组不存在')
          /**
           * 删分组要**把引用一起摘干净**，顺序是先摘引用再删本体。
           *
           * 反过来（先删本体）中间那一刻里，模型和账号指着一个已经不存在的 id：
           * 那些人能用的模型会**突然从"分组内可见"退化成"只剩公开的"**，
           * 而如果这时候摘引用的那几步失败了，库里就永久留着一批悬空 id。
           * 先摘引用的话，最坏情况是分组还在、引用没了 —— 一个能重试的状态。
           */
          const detachedUsers = users ? await users.clearGroup(groupId) : 0
          const detachedModels = modelStore ? await modelStore.dropGroup(groupId) : 0
          await groups.remove(groupId)
          reqLogger.info('管理员删除分组', { by: subject.username, id: groupId, detachedUsers, detachedModels })
          return sendJson(res, 200, { ok: true, detachedUsers, detachedModels })
        }

        throw Errors.notFound('没有这个接口')
      }

      /* ── 单个账号（改角色 / 禁用 / 重置密码 / 改分组）── */

      const target = url.pathname.startsWith('/v1/admin/users/')
        ? decodeURIComponent(url.pathname.slice('/v1/admin/users/'.length))
        : ''
      if (req.method === 'PATCH' && target && !target.includes('/')) {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          let updated = null
          if (typeof body.disabled === 'boolean') {
            /**
             * 不许把自己禁掉。
             *
             * 这不是洁癖：唯一的管理员一旦禁了自己，就**没有任何人**能再进来把它打开 ——
             * 只能去数据库里手工改一行。挡住这一步比事后补救便宜得多。
             */
            if (body.disabled && target === subject.username) {
              throw Errors.badRequest('不能禁用自己 —— 那样就再没人能把它打开了')
            }
            updated = await users.setDisabled({ username: target, disabled: body.disabled })
          }
          if (typeof body.role === 'string') {
            if (target === subject.username && body.role !== 'admin') {
              throw Errors.badRequest('不能撤销自己的管理员身份')
            }
            updated = await users.setRole({ username: target, role: body.role })
          }
          if (typeof body.newPassword === 'string') {
            if (!(await users.resetPassword({ username: target, newPassword: body.newPassword }))) {
              throw Errors.notFound('用户不存在')
            }
            updated = await users.get(target)
            reqLogger.info('管理员重置密码', { by: subject.username, username: target })
          }
          if (typeof body.groupId === 'string') {
            /**
             * 空串是合法的（退出分组），非空则**必须真的存在**。
             *
             * 不校验的话，一个手滑打错的 id 会安静地写进去，而现象是那个人
             * 能用的模型变少了 —— 界面上他有个分组名显示不出来，
             * 但谁也不会立刻把这两件事联系起来。
             */
            if (body.groupId && !(await groups?.get(body.groupId))) throw Errors.badRequest('分组不存在')
            updated = await users.setGroup({ username: target, groupId: body.groupId })
            if (!updated) throw Errors.notFound('用户不存在')
          }
          if (!updated) throw Errors.badRequest('没有可更新的字段（disabled / role / newPassword / groupId）')
          return sendJson(res, 200, { ok: true, user: updated })
        } catch (error) {
          if (error instanceof AppError) throw error
          throw Errors.badRequest(error.message)
        }
      }

      throw Errors.notFound('没有这个接口')
    }

    // 模型清单：只回可公开字段，llmToken 永不下发
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (url.searchParams.get('refresh') === '1') broker.invalidate(subject)
      const access = await broker.getLlmAccess(subject)
      return sendJson(res, 200, {
        models: toPublicModels(access.models),
        user: access.user ? { username: access.user.username, fullname: access.user.fullname } : { username: subject.username },
        stale: Boolean(access.stale),
        credentialSource: subject.credentialSource,
      })
    }

    /**
     * 技能清单。
     *
     * 一并回 `usable`：技能全靠沙盒执行，没有执行端时 runTurn 根本不会把它们
     * 宣告给模型。界面要据此提示，否则用户会看着一排技能问"为什么它说不会"。
     */
    if (req.method === 'GET' && url.pathname === '/v1/skills') {
      const skills = await runService.listSkills({ username: subject.username })
      return sendJson(res, 200, {
        skills,
        sandboxMode: config.sandbox.mode,
        usable: config.sandbox.mode !== 'none',
        // 能不能"自己造技能"取决于有没有用户工作空间：没有它，模型在沙盒里
        // 写出来的东西会随 slot 一起销毁，根本存不下来
        canCreate: Boolean(workspace?.enabled),
        // 能不能改/删/停用。与 canCreate 分开报：没有工作空间时两者都是 false，
        // 但将来共享库技能可能"能装不能改"，前端需要分别判断
        canManage: Boolean(skillManager?.enabled),
      })
    }

    /**
     * 技能管理。对应桌面端 `extensions/chat` 里那 14 个
     * `api.registerGatewayMethod("skill.*")` —— 云端没有 gateway，对应物就是这些路由。
     * 映射关系与没做的四个方法，见 src/workspace/skill-manager.js 的开头。
     */
    if (url.pathname.startsWith('/v1/skills/')) {
      let name
      try {
        name = decodeURIComponent(url.pathname.slice('/v1/skills/'.length))
      } catch {
        throw Errors.badRequest('技能名编码不合法')
      }
      // 子路径只有 /files 一个，别的一律当成拼错了 —— 静默落到"技能名带斜杠"
      // 会得到一句莫名其妙的"技能名不合法"
      const isFiles = name.endsWith('/files')
      if (isFiles) name = name.slice(0, -'/files'.length)
      if (name.includes('/')) throw Errors.notFound('没有这个接口')

      if (req.method === 'GET' && !isFiles) {
        return sendJson(res, 200, await skillManager.read({ username: subject.username, name }))
      }
      if (req.method === 'PUT' && isFiles) {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        return sendJson(res, 200, await skillManager.writeFiles({ username: subject.username, name, files: body.files }))
      }
      if (req.method === 'PATCH' && !isFiles) {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        // 启停与改展示信息走同一个 PATCH，但落在两个不同的存储上：
        // 启停记在 state.json（平台技能也能关），展示信息写进 SKILL.md 的 frontmatter。
        const out = {}
        if (typeof body.enabled === 'boolean') {
          Object.assign(out, await skillManager.setEnabled({ username: subject.username, name, enabled: body.enabled }))
        }
        if (['displayName', 'description', 'emoji'].some((key) => typeof body[key] === 'string')) {
          /**
           * **逐个取字段，不要 `...body`。** 展开写在 `username` 后面的话，
           * 请求体里的 `username` 会把登录态解析出来的那个覆盖掉 —— 也就是
           * "PATCH 别人的技能"。这不是假想：第一版就是 `{ username: subject.username, name, ...body }`，
           * 被 test/skill-api.test.js「请求体里塞 username 也没用」当场抓出来。
           */
          Object.assign(out, await skillManager.updateInfo({
            username: subject.username,
            name,
            displayName: body.displayName,
            description: body.description,
            emoji: body.emoji,
          }))
        }
        if (!Object.keys(out).length) throw Errors.badRequest('没有可更新的字段（enabled / displayName / description / emoji）')
        return sendJson(res, 200, { ok: true, ...out })
      }
      if (req.method === 'DELETE' && !isFiles) {
        return sendJson(res, 200, { ok: true, ...(await skillManager.remove({ username: subject.username, name })) })
      }
    }

    // 工作空间用量。配额是 agent 自己算的，用户得能看到自己占了多少
    if (req.method === 'GET' && url.pathname === '/v1/workspace') {
      if (!workspace?.enabled) return sendJson(res, 200, { enabled: false })
      return sendJson(res, 200, { enabled: true, ...(await workspace.usage(subject.username)) })
    }

    // 会话列表（强制按 username 过滤）
    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
      const projectId = url.searchParams.get('projectId')
      const sessions = await store.list({
        username: subject.username,
        // 不传 = 全部；传空串 = 只要"未归入项目"的那些。两者是不同的意思，
        // 用 `??` 会把空串也吃掉，所以显式判 null
        ...(projectId === null ? {} : { projectId }),
        includeArchived: url.searchParams.get('includeArchived') === '1',
      })
      return sendJson(res, 200, { sessions })
    }

    /**
     * 会话搜索（标题 + 正文）。
     *
     * 单独一条路径而不是 `/v1/sessions?q=`，是因为下面那个 `/v1/sessions/` 前缀
     * 把剩下的一段当 sessionKey 解析 —— 叫 `/v1/sessions/search` 的话，
     * 谁把会话命名成 search 就会撞车。
     */
    if (req.method === 'GET' && url.pathname === '/v1/search') {
      const hits = await store.search({ username: subject.username, q: url.searchParams.get('q') || '' })
      return sendJson(res, 200, { sessions: hits })
    }

    if (url.pathname.startsWith('/v1/sessions/')) {
      let sessionKey
      try {
        sessionKey = decodeURIComponent(url.pathname.slice('/v1/sessions/'.length))
      } catch {
        throw Errors.badRequest('sessionKey 编码不合法')
      }
      sessionKey = assertSessionKey(sessionKey || 'main')

      // 会话详情：把 pi 的 JSONL 转成可渲染的消息，刷新页面后历史才回得来
      if (req.method === 'GET') {
        const row = await store.load({ username: subject.username, sessionKey })
        if (!row) throw Errors.notFound('会话不存在')
        const { sessionId, messages } = parseTranscript(row.jsonl)
        return sendJson(res, 200, {
          sessionKey,
          sessionId: row.sessionId || sessionId,
          title: row.title || '',
          entryCount: row.entryCount || 0,
          messages,
        })
      }

      /**
       * 重命名 / 置顶 / 归档 / 改项目归属，统一走 PATCH。
       *
       * **逐个字段取，不要 `...body`** —— 展开写在 username 后面的话，请求体里的 `username`
       * 会把登录态解析出来的那个覆盖掉，也就是"改别人的会话"。同一个坑在技能的
       * PATCH 上真实发生过，被 test/skill-api.test.js 当场抓出来。
       */
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        const patch = { username: subject.username, sessionKey }
        if (body.title !== undefined) {
          if (typeof body.title !== 'string') throw Errors.badRequest('title 必须是字符串')
          patch.title = body.title
        }
        if (body.pinned !== undefined) patch.pinned = Boolean(body.pinned)
        if (body.archived !== undefined) patch.archived = Boolean(body.archived)
        if (body.projectId !== undefined) {
          const projectId = String(body.projectId || '')
          // 归到一个不存在的项目上，等于给这条会话挂一个悬空引用：它会从
          // "未分组"里消失，又不出现在任何项目下 —— 用户会以为会话丢了
          if (projectId && !(await projects?.get({ username: subject.username, projectId }))) {
            throw Errors.notFound(`项目不存在：${projectId}`)
          }
          patch.projectId = projectId
        }
        if (Object.keys(patch).length === 2) {
          throw Errors.badRequest('没有可更新的字段（title / pinned / archived / projectId）')
        }
        const updated = await store.patch(patch)
        if (!updated) throw Errors.notFound('会话不存在')
        return sendJson(res, 200, { ok: true, session: updated })
      }

      if (req.method === 'DELETE') {
        await store.remove({ username: subject.username, sessionKey })
        // 会话的工作区跟着删。不删的话孤儿目录会一直堆在共享盘上占配额，
        // 而用户在界面上已经看不到这个会话了，也就永远不会想起来去清。
        await workspace?.removeSession?.({ username: subject.username, sessionKey }).catch((error) => {
          reqLogger.warn('会话工作区清理失败', { sessionKey, err: error?.message })
        })
        // 分享指针要在作品还查得到的时候清 —— 顺序反了就只能等读路径去自愈
        await shares?.revokeForSession?.({ username: subject.username, sessionKey }).catch((error) => {
          reqLogger.warn('会话作品分享清理失败', { sessionKey, err: error?.message })
        })
        // 作品同理：它们只在这条会话的面板里露面，会话没了就再也点不到了
        await artifacts?.removeSession?.({ username: subject.username, sessionKey }).catch((error) => {
          reqLogger.warn('会话作品清理失败', { sessionKey, err: error?.message })
        })
        return sendJson(res, 200, { ok: true })
      }
    }

    /* ─────────────── 作品 ─────────────── */

    if (url.pathname === '/v1/artifacts' || url.pathname.startsWith('/v1/artifacts/')) {
      if (!artifacts?.enabled) throw Errors.notFound('本部署未启用作品功能（ARTIFACTS_ENABLED=0）')

      if (req.method === 'GET' && url.pathname === '/v1/artifacts') {
        return sendJson(res, 200, {
          artifacts: await artifacts.list({
            username: subject.username,
            // 不传 sessionKey = 这个人的全部作品。界面默认只看当前会话的，
            // 但"我上周做的那个报表在哪"要有地方能翻
            sessionKey: url.searchParams.get('sessionKey') || '',
          }),
          /**
           * 预览环境的约束一并回给前端。
           *
           * 它得拿这个拼预览 iframe 的 CSP —— 前端自己硬编一份的话，改了服务端
           * 配置而前端没跟上，表现是"配了 CDN 却还是加载不到"，两边谁也看不出来。
           */
          preview: { allowedOrigins: config.artifacts.allowedOrigins },
        })
      }

      const rest = decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length) || '')
      const isRaw = rest.endsWith('/raw')
      const isShare = rest.endsWith('/share')
      const artifactId = isRaw ? rest.slice(0, -'/raw'.length)
        : isShare ? rest.slice(0, -'/share'.length)
          : rest
      if (!artifactId || artifactId.includes('/')) throw Errors.notFound('没有这个接口')

      /**
       * ── 作者侧的分享开关 ──
       *
       * 三个动词分得很开，因为它们是三件不同的事：
       *   POST   生成分享链接（幂等，已有就回已有的 —— 见 shares.create）
       *   PATCH  上/下市场、改简介
       *   DELETE 撤销，链接立刻失效
       *
       * 注意 **username 一律取自 subject**，请求体里那个（如果有）看都不看。
       * 反面教材见下面 PATCH /v1/sessions 那段：`{...body}` 把登录态解析出来的
       * username 覆盖掉，于是"改自己的东西"变成了"改任何人的东西"。
       */
      if (isShare) {
        if (!shares?.enabled) throw Errors.notFound('本部署未启用作品分享（ARTIFACT_SHARING_ENABLED=0）')

        if (req.method === 'POST') {
          const meta = await shares.create({ username: subject.username, artifactId })
          if (!meta) throw Errors.notFound('作品不存在')
          reqLogger.info('生成作品分享链接', { username: subject.username, id: artifactId })
          return sendJson(res, 200, { ok: true, artifact: meta })
        }

        if (req.method === 'PATCH') {
          const body = await readJsonBody(req, config.limits.bodyLimitBytes)
          let meta
          try {
            meta = await shares.setMarket({
              username: subject.username,
              artifactId,
              market: body.market,
              summary: body.summary,
            })
          } catch (error) {
            throw Errors.badRequest(error.message)
          }
          if (!meta) throw Errors.notFound('作品不存在')
          return sendJson(res, 200, { ok: true, artifact: meta })
        }

        if (req.method === 'DELETE') {
          const revoked = await shares.revoke({ username: subject.username, artifactId })
          if (!revoked) throw Errors.notFound('这份作品没有在分享')
          reqLogger.info('撤销作品分享', { username: subject.username, id: artifactId })
          return sendJson(res, 200, { ok: true })
        }

        throw Errors.notFound('没有这个接口')
      }

      /** 单个文件的原文。`?path=` 指定哪一个，不传取入口文件。头的讲究见 sendArtifactFile */
      if (req.method === 'GET' && isRaw) {
        return sendArtifactFile(res, {
          current: await readArtifactOr404({
            username: subject.username, id: artifactId, version: url.searchParams.get('v'),
          }),
          wanted: url.searchParams.get('path'),
          download: url.searchParams.get('download') === '1',
        })
      }

      if (req.method === 'GET') {
        const current = await readArtifactOr404({
          username: subject.username, id: artifactId, version: url.searchParams.get('v'),
        })
        return sendJson(res, 200, current)
      }

      if (req.method === 'DELETE') {
        // 分享指针在**删之前**清掉 —— 删完就查不到 share.token 了。
        // 漏了也不会漏数据（公开读那一关会核对作品还在不在），只是盘上多一个孤儿
        await shares?.revokeForArtifact?.({ username: subject.username, artifactId }).catch((error) => {
          reqLogger.warn('作品分享指针清理失败', { id: artifactId, err: error?.message })
        })
        const removed = await artifacts.remove({ username: subject.username, id: artifactId })
        if (!removed) throw Errors.notFound('作品不存在')
        return sendJson(res, 200, { ok: true })
      }
    }

    /* ─────────────── 项目 ─────────────── */

    if (url.pathname === '/v1/projects' || url.pathname.startsWith('/v1/projects/')) {
      if (!projects?.enabled) throw Errors.notFound('本部署未启用项目功能（PROJECTS_ENABLED=0）')

      if (req.method === 'GET' && url.pathname === '/v1/projects') {
        return sendJson(res, 200, {
          projects: await projects.list({
            username: subject.username,
            includeArchived: url.searchParams.get('includeArchived') === '1',
          }),
        })
      }

      if (req.method === 'POST' && url.pathname === '/v1/projects') {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          const project = await projects.create({
            username: subject.username,
            name: body.name,
            description: body.description,
            instructions: body.instructions,
          })
          return sendJson(res, 201, { ok: true, project })
        } catch (error) {
          throw Errors.badRequest(error.message)
        }
      }

      const projectId = decodeURIComponent(url.pathname.slice('/v1/projects/'.length) || '')
      if (projectId.includes('/')) throw Errors.notFound('没有这个接口')

      if (req.method === 'GET') {
        const project = await projects.get({ username: subject.username, projectId })
        if (!project) throw Errors.notFound('项目不存在')
        return sendJson(res, 200, { project })
      }

      if (req.method === 'PATCH') {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          // 逐字段取，理由同会话的 PATCH
          const project = await projects.update({
            username: subject.username,
            projectId,
            name: body.name,
            description: body.description,
            instructions: body.instructions,
            archived: body.archived,
          })
          if (!project) throw Errors.notFound('项目不存在')
          return sendJson(res, 200, { ok: true, project })
        } catch (error) {
          if (error.status) throw error
          throw Errors.badRequest(error.message)
        }
      }

      if (req.method === 'DELETE') {
        const removed = await projects.remove({ username: subject.username, projectId })
        if (!removed) throw Errors.notFound('项目不存在')
        /**
         * 把它下面的会话退回"未分组"，而不是跟着删。
         *
         * 用户删项目想删的是这个分组；连着几十轮对话一起删是不可逆的，
         * 而且没有任何提示能让人预料到。
         */
        let released = 0
        for (const session of await store.list({ username: subject.username, projectId, includeArchived: true })) {
          await store.patch({ username: subject.username, sessionKey: session.sessionKey, projectId: '' }).catch(() => {})
          released += 1
        }
        return sendJson(res, 200, { ok: true, releasedSessions: released })
      }
    }

    /* ─────────────── 长期记忆 ─────────────── */

    if (url.pathname === '/v1/memory') {
      if (!memory?.enabled) throw Errors.notFound('本部署未启用长期记忆（MEMORY_ENABLED=0）')
      const projectId = url.searchParams.get('projectId') || ''

      if (req.method === 'GET') {
        return sendJson(res, 200, { scope: projectId ? 'project' : 'personal', projectId, ...(await memory.read({ username: subject.username, projectId })) })
      }

      /**
       * 整段替换，必须带上读到时的 revision。
       *
       * 没有它的话，"用户正在网页上删一条"和"模型正在这一轮追加一条"撞在一起时，
       * 后写的会把对方整段抹掉 —— 而记忆恰恰是那种丢了不会有人立刻发现的数据。
       */
      if (req.method === 'PUT') {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        if (typeof body.content !== 'string') throw Errors.badRequest('content 必须是字符串')
        const ok = await memory.replace({ username: subject.username, projectId }, body.content, body.revision)
        if (!ok) throw Errors.conflict('记忆已被另一处修改，请重新加载后再保存')
        // 形状与 GET 保持一致（含 scope/projectId）：前端保存完直接拿它刷新本地状态，
        // 不用为"保存的返回"和"读取的返回"各写一套解析
        return sendJson(res, 200, {
          ok: true,
          scope: projectId ? 'project' : 'personal',
          projectId,
          ...(await memory.read({ username: subject.username, projectId })),
        })
      }
    }

    /* ─────────────── 定时任务 ─────────────── */

    if (url.pathname === '/v1/crons' || url.pathname.startsWith('/v1/crons/')) {
      if (!crons?.enabled) throw Errors.notFound('本部署未启用定时任务（CRON_ENABLED=0）')

      /**
       * 每次写操作都刷新一次留存的登录态。
       *
       * 时机是有讲究的：用户此刻**正在浏览器里**（我们确实拿着他的登录态），而且
       * 刚刚表达了"我要这个任务在我不在的时候跑"的意图。放在别处（比如每个请求都刷）
       * 会让"到底存了谁的凭据、什么时候存的"变成一件说不清的事。
       * CRON_CREDENTIAL_MODE=none 时这里是个空操作。
       */
      const rememberCredential = () => cronVault?.remember({ username: subject.username, credential: subject.credential || '' })
        .catch((error) => reqLogger.warn('定时任务凭据留存失败', { err: error?.message }))

      if (req.method === 'GET' && url.pathname === '/v1/crons') {
        return sendJson(res, 200, {
          crons: await crons.list({ username: subject.username, includeArchived: url.searchParams.get('includeArchived') === '1' }),
          scheduler: { running: Boolean(scheduler?.enabled), credentialMode: config.cron.credentialMode },
        })
      }

      if (req.method === 'POST' && url.pathname === '/v1/crons') {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          const cron = await crons.create({
            username: subject.username,
            title: body.title,
            task: body.task,
            schedule: body.schedule,
            sessionMode: body.sessionMode,
            projectId: body.projectId,
            enabled: body.enabled,
          })
          await rememberCredential()
          return sendJson(res, 201, { ok: true, cron })
        } catch (error) {
          throw Errors.badRequest(error.message)
        }
      }

      const rest = decodeURIComponent(url.pathname.slice('/v1/crons/'.length) || '')
      const isRun = rest.endsWith('/run')
      const cronId = isRun ? rest.slice(0, -'/run'.length) : rest
      if (cronId.includes('/')) throw Errors.notFound('没有这个接口')

      // 立即执行一次。不占排期格，也不影响 nextFireAt —— 它是"试一下对不对"，
      // 不是"提前触发这一拍"
      if (req.method === 'POST' && isRun) {
        if (!scheduler) throw Errors.notFound('本副本没有调度能力')
        await rememberCredential()
        const outcome = await scheduler.runNow({ username: subject.username, id: cronId })
        return sendJson(res, 200, { ok: outcome.ok, status: outcome.status || 'ok' })
      }

      if (req.method === 'GET') {
        const cron = await crons.get({ username: subject.username, id: cronId })
        if (!cron) throw Errors.notFound('定时任务不存在')
        return sendJson(res, 200, { cron })
      }

      if (req.method === 'PATCH') {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          const cron = await crons.update({
            username: subject.username,
            id: cronId,
            title: body.title,
            task: body.task,
            schedule: body.schedule,
            sessionMode: body.sessionMode,
            projectId: body.projectId,
            enabled: body.enabled,
            archived: body.archived,
          })
          if (!cron) throw Errors.notFound('定时任务不存在')
          await rememberCredential()
          return sendJson(res, 200, { ok: true, cron })
        } catch (error) {
          if (error.status) throw error
          throw Errors.badRequest(error.message)
        }
      }

      if (req.method === 'DELETE') {
        await crons.remove({ username: subject.username, id: cronId })
        // 最后一条任务被删掉之后，留着的登录态就没有任何用途了 —— 顺手清掉，
        // 别让它在盘上一直躺到过期
        const left = await crons.list({ username: subject.username, includeArchived: true })
        if (!left.length) await cronVault?.forget({ username: subject.username }).catch(() => {})
        return sendJson(res, 200, { ok: true })
      }
    }

    // 中止
    if (req.method === 'POST' && /^\/v1\/runs\/[^/]+\/abort$/.test(url.pathname)) {
      const runId = url.pathname.split('/')[3]
      return sendJson(res, 200, runService.abort({ runId, username: subject.username }))
    }

    // 对话（SSE）
    if (req.method === 'POST' && url.pathname === '/v1/chat/stream') {
      // 只有这个端点收附件，所以它单独一档更大的额度（见 config.js 的说明）
      const body = await readJsonBody(req, config.limits.chatBodyLimitBytes || config.limits.bodyLimitBytes)
      /**
       * 附件在**进 SSE 之前**校验。
       *
       * 一旦 openSse 写下 200 和响应头，就再也回不了 4xx 了 —— 这时候格式错误
       * 只能作为一条 error 帧发出去，而调用方（尤其是 curl / 脚本）看到的是
       * "请求成功、内容里有段错误"。校验放在这里，坏请求就还是一个正正经经的 400。
       */
      const attachments = normalizeAttachments(body.attachments)
      // 只带附件、一个字都不写是合理的一轮（"看看这份日志"）
      if (!body.prompt && !attachments.length) throw Errors.badRequest('prompt 不能为空')

      const sessionKey = assertSessionKey(body.sessionKey || 'main')

      const stream = openSse(res)
      try {
        await runService.execute({
          subject,
          sessionKey,
          prompt: body.prompt || '',
          attachments,
          modelId: body.model,
          // 只对**新会话**生效：已有会话的归属以存储为准（见 run-service 的 buildContext）
          projectId: String(body.projectId || ''),
          source: body.source || 'web',
          /**
           * `final` / `error` 是**最后一帧**，收到就把流收掉，不等 execute 返回。
           *
           * 因为 execute 在发完 final 之后还有活要干 —— 主要是抓记忆，那是**另一次
           * 模型调用**（run-service.js 里刻意排在 final 之后，好让用户不必等它）。
           * 但客户端判断"这一轮结束了"靠的是流关闭，于是那份好意没兑现：
           * 实测正文早就停了、final 帧也到了，界面还要再转 4.3 秒
           * （关掉 MEMORY_CAPTURE 就归零）。
           *
           * 收尾之后不会再有帧：final 之后只剩 store.patch 和抓记忆，两个都自带
           * `.catch`，走不到会发 error 帧的那条路。
           */
          onFrame: (type, data) => {
            stream.send(type, data)
            if (type === 'final' || type === 'error') stream.end()
          },
        })
      } catch (error) {
        // 错误帧已在 runService 里发过，这里只保证连接收尾
        const appError = toAppError(error)
        reqLogger.debug('对话流以错误结束', { code: appError.code })
      } finally {
        stream.end()
      }
      return
    }

    // 隔离自检（调试端点，生产不挂载）
    if (config.devConsole && req.method === 'POST' && url.pathname === '/v1/isolation-check') {
      const body = await readJsonBody(req, config.limits.bodyLimitBytes)
      const peers = (Array.isArray(body.peers) ? body.peers : []).filter((peer) => peer?.username)
      const findings = []
      for (const peer of peers) {
        const row = await store.load({ username: peer.username, sessionKey: peer.sessionKey || 'main' })
        const foreign = peers.filter((other) => other.username !== peer.username).map((other) => other.secret).filter(Boolean)
        findings.push({
          username: peer.username,
          sessionId: row?.sessionId || null,
          entryCount: row?.entryCount || 0,
          hasOwnSecret: Boolean(row?.jsonl && peer.secret && row.jsonl.includes(peer.secret)),
          foreignSecretsFound: foreign.filter((secret) => row?.jsonl?.includes(secret)),
        })
      }
      const ids = findings.map((f) => f.sessionId).filter(Boolean)
      return sendJson(res, 200, {
        storageLeaked: findings.some((f) => f.foreignSecretsFound.length > 0),
        sessionIdsDistinct: new Set(ids).size === ids.length,
        findings,
      })
    }

    throw Errors.notFound(`未知路由 ${req.method} ${url.pathname}`)
  }

  return {
    server,
    listen(port) {
      return new Promise((resolve) => server.listen(port, '0.0.0.0', resolve))
    },
    /** 优雅停机：停止收新连接，等在跑的 run 自己结束 */
    async close({ timeoutMs = 30000 } = {}) {
      await new Promise((resolve) => server.close(resolve))
      const deadline = Date.now() + timeoutMs
      while (runService.snapshot().activeRuns > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      const left = runService.snapshot().activeRuns
      if (left > 0) logger.warn('停机时仍有未完成的 run', { activeRuns: left })
    },
  }
}

export { AppError }
