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
import { AppError, Errors, toAppError } from '../errors.js'
import { validateCredentials, signToken } from '../identity/password-auth.js'
import { toPublicModels } from '../models/llminfo-client.js'
import { createRateLimiter, clientIp } from './rate-limit.js'
import { createAccountRoutes } from './routes/accounts.js'
import { sendArtifactFile } from './routes/artifact-io.js'
import { createArtifactRoutes } from './routes/artifacts.js'
import { createProjectRoutes } from './routes/projects.js'
import { createCronRoutes } from './routes/crons.js'
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

/**
 * 邮箱打码：`zhangsan@example.com` → `z*******@example.com`。
 *
 * 注册和激活那几条响应**不需要登录就能拿到**，而完整邮箱是个能拿去别处撞库的东西。
 * 但又不能什么都不回 —— 用户得看得出"信发到哪个邮箱了"，尤其是他有好几个邮箱时。
 * 域名保持原样：它本来就是从他自己填的那一步回显回去的，遮住只会让人认不出。
 */
function maskEmail(email) {
  const text = String(email || '')
  const at = text.indexOf('@')
  if (at <= 0) return ''
  const local = text.slice(0, at)
  // 一个字符的 local part 没有可遮的：遮了就是全遮，回显也就没意义了
  const head = local.slice(0, 1)
  return `${head}${'*'.repeat(Math.max(1, local.length - 1))}${text.slice(at)}`
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
  let fallbackSeq = 0
  let closed = false
  return {
    /**
     * @param {number} [seq] 这一帧在 run 缓冲里的序号。
     *
     * 传了就用它当 SSE 的 `id:` —— 这才是客户端断线重连时能带回来的断点
     * （见 src/agent/run-registry.js）。不传就退回本连接内的自增计数，
     * 那对不带缓冲的流（没有重连需求的）够用。
     *
     * ⚠️ 两者不能混：一条流上一会儿发缓冲序号、一会儿发本地计数，
     * 客户端拿回来的断点就指不到任何真实的帧上。
     */
    send(type, data, seq) {
      // 收尾之后再来的帧直接丢掉，而不是往已经 end 的响应上写（那会抛
      // ERR_STREAM_WRITE_AFTER_END，把一次已经成功的对话变成一条错误日志）
      if (closed) return
      fallbackSeq += 1
      const id = Number(seq) > 0 ? Number(seq) : fallbackSeq
      res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
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
  config, logger, identity, broker, runService, store, metrics, workspace = null,
  skillManager = null, memory = null, projects = null, crons = null, scheduler = null, cronVault = null,
  artifacts = null, shares = null, users = null, usage = null, modelStore = null, groups = null,
  mailer = null,
}) {
  const webDir = config.webDir || DEFAULT_WEB_DIR

  /**
   * 登录限流的两道闸。两者的计数口径不同，理由见 src/http/rate-limit.js 文件头：
   * 按 IP 的每次尝试都记（挡 DoS，必须在 scrypt 之前），按用户名的只记失败（挡爆破）。
   *
   * `enabled=false` 时建成 null 而不是建一个"额度无限"的限流器：后者仍然会为
   * 每个 key 在 Map 里留一条，关掉限流反而多出一片可以被灌的内存。
   */
  const rateLimitConfig = config.auth.password?.rateLimit
  const loginLimits = rateLimitConfig?.enabled
    ? {
      ip: createRateLimiter({
        windowMs: rateLimitConfig.ipWindowMs,
        max: rateLimitConfig.ipMax,
        baseBlockMs: rateLimitConfig.baseBlockMs,
        maxBlockMs: rateLimitConfig.maxBlockMs,
      }),
      user: createRateLimiter({
        windowMs: rateLimitConfig.userWindowMs,
        max: rateLimitConfig.userMax,
        baseBlockMs: rateLimitConfig.baseBlockMs,
        maxBlockMs: rateLimitConfig.maxBlockMs,
      }),
    }
    : null

  /**
   * 账号与管理台那一整块（见 ./routes/accounts.js）。
   * 在这里建一次而不是每个请求建一次 —— 它只是把依赖闭包起来，没有 per-request 状态。
   */
  const accountRoutes = createAccountRoutes({ config, identity, users, groups, modelStore, usage })
  /**
   * 按领域拆出来的其余几块（见 ./routes/）。
   *
   * ⚠️ **调用顺序就是从前 if 链的顺序，不许重排。** 那条链里有几处是靠前后关系
   * 成立的（前缀匹配谁先谁后、鉴权在哪一行之后），重排不会报错，
   * 只会让某条路由被别人提前吃掉 —— 而现象是"接口写好了却永远调不通"。
   */
  const artifactRoutes = createArtifactRoutes({ artifacts, shares, config })
  const projectRoutes = createProjectRoutes({ projects, store, config })
  const cronRoutes = createCronRoutes({ crons, scheduler, cronVault, config })

  /**
   * 429 要带 `Retry-After` 头 —— 不带的话客户端只能靠猜，而猜出来的多半是
   * "立刻再试一次"，正好是我们要挡的行为。
   *
   * 头在这里 setHeader，body 里的 details 再带一份秒数：头是给代理和 curl 看的，
   * body 是给前端拿去渲染"请 N 秒后重试"的（与 sendJson 里 requestId 两处都放
   * 同一个道理）。writeHead 会把先前 setHeader 的合并进去，所以这里设了就带得上。
   */
  /**
   * 注册细则。单测构造的 config 未必带这一段，给一份与 config.js 默认值一致的兜底 ——
   * 少了它，`config.auth.password.register.verifyEmail` 会在老用例里读到 undefined 上的属性。
   */
  const registerPolicy = {
    requireEmail: false,
    verifyEmail: false,
    codeTtlMinutes: 15,
    resendIntervalSeconds: 60,
    emailDomains: [],
    ...(config.auth.password?.register || {}),
  }

  /**
   * 这个部署到底走不走"验证码激活"这条路。
   *
   * 开关开着但没有发信能力时**退回不验证**，而不是让注册整个失败：
   * 后者意味着一次发信配置疏忽会把注册页面变成一个只会报 500 的按钮。
   * 生产上这个组合已经在配置校验那里被拦掉了（见 config.js），
   * 所以这条退路只会在开发和单测里被走到。
   */
  function registerVerifyEmail() {
    return Boolean(registerPolicy.verifyEmail && mailer?.enabled)
  }

  function rejectRateLimited(res, message, retryAfterMs) {
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
    res.setHeader('Retry-After', String(retryAfterSec))
    throw Errors.rateLimited(message, { retryAfterMs, retryAfterSec })
  }

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
          /**
           * 注册表单要不要画邮箱那一栏、提交之后是不是还有一步验证码。
           *
           * 必须由服务端说：前端自己猜的话，两边配置一错位的表现是
           * "注册完就卡在一个不存在的输入框上"，或者"填完提交才被告知邮箱必填"。
           *
           * `registerVerifyEmail` 还要求发信真的可用 —— 开关开着但没配发信账号时，
           * 界面不该把人领到一个注定收不到信的流程里（配置校验也会拦这种组合，
           * 见 config.js；这里再判一次是因为 mailer 可以不注入）。
           */
          registerEmail: Boolean(registerPolicy.requireEmail || registerPolicy.verifyEmail),
          registerVerifyEmail: registerVerifyEmail(),
          // 管理台的「Token 用量」那一页。只有管理员看得到那一页，但这个宣告是公开的：
          // 它说的是"这个部署记不记账"，不是"谁用了多少"
          usage: Boolean(usage?.enabled),
          /**
           * 断线之后能不能接回还在跑的那一轮。前端据此决定要不要在流断掉时
           * 去试重连 —— 没有这个宣告的话，它只能盲试一次注定 404 的请求，
           * 而那次失败会盖掉真正该显示的"连接断了"。
           */
          runResume: typeof runService.attach === 'function',
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
    if (url.pathname === '/v1/auth/login'
      || url.pathname === '/v1/auth/register'
      || url.pathname === '/v1/auth/activate'
      || url.pathname === '/v1/auth/activation/resend') {
      if (config.auth.mode !== 'password') {
        return sendJson(res, 404, { error: 'NOT_FOUND', message: '当前 AUTH_MODE 不支持密码登录' })
      }

      /**
       * ⚠️ 按 IP 的闸必须是这一块的**第一件事** —— 早于读请求体，更早于 scrypt。
       *
       * 顺序在这里就是全部意义所在：密码校验一次要烧 100ms CPU 和 16MB 内存
       * （见 rate-limit.js 文件头），放到校验之后再限流，等于每个被拒的请求
       * 也已经把那份代价付掉了，闸门形同虚设。
       */
      if (loginLimits) {
        const ip = clientIp(req, { trustProxy: config.trustProxy })
        const gate = loginLimits.ip.consume(`${ip}|${url.pathname}`)
        if (!gate.ok) {
          reqLogger.warn('登录请求过于频繁，按 IP 拒绝', { ip, path: url.pathname, retryAfterMs: gate.retryAfterMs })
          rejectRateLimited(res, '请求过于频繁，请稍后再试', gate.retryAfterMs)
        }
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
         * 按用户名的闸。key 统一小写：大小写换着写就换一个额度桶的话，
         * 这道闸绕起来太便宜了。
         *
         * 这里是 peek（只问在不在封禁中，不计数）—— 计数要留到**知道成没成功
         * 之后**再做，见下面。放在 scrypt 之前是同一个理由：被封的用户名不该
         * 还能让我们去跑一次密钥派生。
         */
        const userKey = username.toLowerCase()
        if (loginLimits) {
          const gate = loginLimits.user.peek(userKey)
          if (!gate.ok) {
            reqLogger.warn('该账号失败次数过多，暂时锁定', { username, retryAfterMs: gate.retryAfterMs })
            rejectRateLimited(res, '登录失败次数过多，该账号已被暂时锁定，请稍后再试', gate.retryAfterMs)
          }
        }

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

          /**
           * 密码对了，但账号还没激活。
           *
           * **不计进失败次数、并且把计数清零** —— 计数那道闸挡的是"猜密码的人"，
           * 而这个人刚刚证明了他知道密码。不清的话，一个还没收到验证码的新用户
           * 试几次就会把自己的账号锁上，然后连激活都做不成。
           *
           * 回 403 而不是 401：凭据是有效的，缺的是一步激活 —— 前端据
           * `details.activationRequired` 直接把界面切到填验证码那一步，
           * 而不是让他对着"用户名或密码错误"反复重试一个正确的密码。
           */
          if (reason === 'inactive') {
            loginLimits?.user.reset(userKey)
            reqLogger.info('登录被拒：账号未激活', { username })
            throw Errors.forbidden('账号还没有激活，请填写邮箱收到的验证码', {
              activationRequired: true,
              username,
              // 邮箱要打码：这条响应不需要证明身份就能拿到，
              // 而完整邮箱是个可以拿去别处撞库的东西
              email: maskEmail(result.user?.email || ''),
            })
          }

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
          /**
           * 失败才计数。用"尝试数"计会误伤 —— 一个人在几个标签页里同时登录是
           * 正常的，而连续失败五次不是（见 rate-limit.js 文件头）。
           *
           * `disabled` 也照记：被禁用的账号更是不该被人拿来反复试密码。
           */
          if (loginLimits) {
            const gate = loginLimits.user.consume(userKey)
            if (!gate.ok) {
              reqLogger.warn('密码登录失败次数达到上限，锁定该账号', { username, reason, retryAfterMs: gate.retryAfterMs })
              rejectRateLimited(res, '登录失败次数过多，该账号已被暂时锁定，请稍后再试', gate.retryAfterMs)
            }
          }
          // 日志里记下真实原因（禁用 / 密码错 / 无此人），**响应里一律同一句** ——
          // 区分开就等于告诉撞库的人"这个用户名是对的，继续猜密码"
          reqLogger.warn('密码登录失败', { username, reason })
          if (reason === 'disabled') throw Errors.unauthenticated('该账号已被禁用')
          throw Errors.unauthenticated('用户名或密码错误')
        }

        // 成功就清零：之前那几次手滑不该留在账上，否则"错三次再输对"的人
        // 下一次登录会莫名其妙地更接近被锁
        loginLimits?.user.reset(userKey)

        // 令牌里要带上当前代数，之后每个请求据此判断它还算不算数
        // （见 src/identity/index.js）。没接账号存储时是 0，行为与从前一致。
        const version = users ? (await users.authState(username))?.tokenVersion || 0 : 0
        const { token, expiresAt } = signToken(username, identity.passwordSecret, ttlSec, version)
        reqLogger.info('密码登录成功', { username })
        return sendJson(res, 200, { ok: true, token, expiresAt, username })
      }

      /** 注册这三条都要求账号存储 + 注册开关。判据一样，别在三个地方各写一遍 */
      function assertRegisterOpen() {
        if (!users) throw Errors.notFound('本部署未启用账号存储')
        if (!config.auth.password.allowRegister) {
          throw Errors.forbidden('本部署未开放注册（AUTH_ALLOW_REGISTER=0），请让管理员创建账号')
        }
      }

      /**
       * 把验证码发出去。
       *
       * **发信失败不回滚账号**：那条待激活的记录留着，用户可以走"重发"再来一次。
       * 删掉的话，一次 SMTP 抖动就等于让他把用户名和密码重填一遍，而账号那边
       * 什么痕迹都没留下 —— 他甚至说不清刚才那次到底算不算注册过了。
       */
      async function issueAndSend({ username, first }) {
        const issued = await users.issueActivationCode({ username })
        if (!issued.ok) {
          if (issued.reason === 'too-soon') {
            rejectRateLimited(res, '验证码刚发过，请稍后再试', issued.retryAfterMs)
          }
          if (issued.reason === 'already-active') throw Errors.badRequest('这个账号已经激活了，直接登录即可')
          if (issued.reason === 'no-email') throw Errors.badRequest('这个账号没有留邮箱，无法发送验证码')
          throw Errors.notFound('没有这个待激活的账号')
        }
        try {
          await mailer.sendActivationCode({
            to: issued.email,
            username,
            code: issued.code,
            ttlMinutes: issued.ttlMinutes,
          })
        } catch (error) {
          // ⚠️ 日志里只留失败原因，**绝不能带上 issued.code**
          reqLogger.error('验证码邮件发送失败', { username, err: error?.message })
          throw Errors.upstream('验证码邮件发不出去，请稍后重试或联系管理员', { retryable: true })
        }
        reqLogger.info('已发送注册验证码', { username, first: Boolean(first) })
        return { expiresAt: issued.expiresAt, email: maskEmail(issued.email) }
      }

      /**
       * 注册。**默认关**（AUTH_ALLOW_REGISTER=0）。
       *
       * 开放注册意味着任何能访问到这个地址的人都能拿到一个账号，
       * 而账号在这里等于"能跑模型、能开沙盒"。所以它是一个必须显式打开的开关，
       * 不是一个默认能力。内网部署想让同事自助开号时才打开。
       *
       * 开了 REGISTER_VERIFY_EMAIL 之后这条接口**不再发令牌**：账号建出来是
       * 未激活的，得先拿邮箱里的验证码去换（/v1/auth/activate）。不这么做的话，
       * "验证"就只是顺手发了封信，而人早就进来了 —— 那道验证等于不存在。
       */
      if (req.method === 'POST' && url.pathname === '/v1/auth/register') {
        assertRegisterOpen()
        const { body, username } = await readCredentials()

        const verifying = registerVerifyEmail()
        const email = typeof body.email === 'string' ? body.email.trim() : ''
        // 要验证码就必然要邮箱 —— 没有邮箱就没有地方发信
        if ((registerPolicy.requireEmail || verifying) && !email) throw Errors.badRequest('邮箱必填')

        try {
          // 第一个注册进来的人是管理员：全新部署里总得有人能管别人，
          // 而那时还没有任何管理员可以来授权
          const first = (await users.count()) === 0
          const user = await users.create({
            username,
            password: body.password,
            email,
            role: first ? 'admin' : 'user',
            activated: !verifying,
            // 用户名被一个从来没激活过的账号占着时，允许这次注册顶掉它。
            // 理由见 user-store.create()：那种账号没有主人
            replacePending: true,
          })

          if (verifying) {
            const sent = await issueAndSend({ username, first })
            /**
             * 202 而不是 201：账号确实建出来了，但这次交互**还没完成** ——
             * 少了最后一步（填验证码）。前端据此把界面切到验证码那一屏。
             * 这里一个字节的令牌都不发。
             */
            return sendJson(res, 202, {
              ok: true,
              pendingActivation: true,
              username,
              email: sent.email,
              expiresAt: sent.expiresAt,
              message: '验证码已发送到你的邮箱，填写后即可激活账号',
            })
          }

          // 新账号的代数就是 0，但还是从存储里取 —— 免得将来 create 改了初值，
          // 这里签出一张一进门就对不上号的令牌
          const version = (await users.authState(username))?.tokenVersion || 0
          const { token, expiresAt } = signToken(username, identity.passwordSecret, ttlSec, version)
          reqLogger.info('注册成功', { username, role: user.role })
          return sendJson(res, 201, { ok: true, user, token, expiresAt, username })
        } catch (error) {
          if (error instanceof AppError) throw error
          throw Errors.badRequest(error.message)
        }
      }

      /**
       * 拿验证码换激活，顺带把人登进去。
       *
       * 激活成功就直接发令牌：他刚刚同时证明了"知道这个账号的密码"（注册时设的）
       * 和"收得到那个邮箱的信"。再让他回登录页填一遍密码，不多验证任何东西，
       * 只是多一步。
       */
      if (req.method === 'POST' && url.pathname === '/v1/auth/activate') {
        assertRegisterOpen()
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        const username = typeof body?.username === 'string' ? body.username.trim() : ''
        const code = typeof body?.code === 'string' ? body.code.trim() : ''
        if (!username) throw Errors.badRequest('用户名必填')
        if (!code) throw Errors.badRequest('验证码必填')

        const result = await users.verifyActivationCode({ username, code })
        if (!result.ok) {
          reqLogger.warn('激活失败', { username, reason: result.reason })
          /**
           * 这几种失败**分开说**，与登录那边"一律回同一句"的做法相反。
           *
           * 那边不能分，是因为回答的是"这个用户名存不存在"；这边回答的是
           * "你手里这份验证码怎么了"，而验证码本来就在他自己邮箱里 ——
           * 含糊其辞并不能少泄露什么，只会让人对着"激活失败"四个字反复重试
           * 一个已经过期的码。
           */
          if (result.reason === 'already-active') throw Errors.badRequest('这个账号已经激活了，直接登录即可')
          if (result.reason === 'expired') throw Errors.badRequest('验证码已过期，请重新获取')
          if (result.reason === 'too-many-attempts') throw Errors.badRequest('验证码错误次数过多，这份验证码已作废，请重新获取')
          /**
           * `no-code` 有两种来路：从来没发过，和**上一份被试满作废了**。
           * 措辞要同时说得通这两种，所以是"重新获取"而不是"先获取" ——
           * 后者对刚把验证码试作废的人来说像在说"你根本没申请过"。
           */
          if (result.reason === 'no-code') throw Errors.badRequest('当前没有可用的验证码，请重新获取')
          if (result.reason === 'bad-code') {
            throw Errors.badRequest(`验证码不正确，还可以再试 ${result.attemptsLeft} 次`, { attemptsLeft: result.attemptsLeft })
          }
          throw Errors.notFound('没有这个待激活的账号')
        }

        const version = (await users.authState(username))?.tokenVersion || 0
        const { token, expiresAt } = signToken(username, identity.passwordSecret, ttlSec, version)
        reqLogger.info('账号激活成功', { username, role: result.user.role })
        return sendJson(res, 200, { ok: true, user: result.user, token, expiresAt, username })
      }

      /**
       * 重发验证码。
       *
       * 账号不存在 / 已经激活时**照样回 200**，不说破 —— 否则这条接口就成了一个
       * 免费的用户名探测器（而且不需要密码）。发信间隔那一档仍然回 429：
       * 它只对"确实存在且待激活"的账号出现，也就是说它确实泄露了一点点。
       * 认这笔账，是因为把它也糊成 200 的话，正在等验证码的人会以为信发出去了
       * 而其实没有，然后一直等下去。
       */
      if (req.method === 'POST' && url.pathname === '/v1/auth/activation/resend') {
        assertRegisterOpen()
        if (!registerVerifyEmail()) throw Errors.badRequest('本部署没有开启邮箱验证码注册')
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        const username = typeof body?.username === 'string' ? body.username.trim() : ''
        if (!username) throw Errors.badRequest('用户名必填')

        const state = await users.get(username)
        if (!state || state.activated) {
          reqLogger.info('重发验证码：无此待激活账号，按成功回复', { username })
          return sendJson(res, 200, { ok: true, message: '如果这个账号存在且尚未激活，验证码已经重新发送' })
        }
        const sent = await issueAndSend({ username })
        return sendJson(res, 200, {
          ok: true,
          email: sent.email,
          expiresAt: sent.expiresAt,
          message: '验证码已重新发送',
        })
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
     * 这一整块（改密 + `/v1/admin/*`）搬到了 ./routes/accounts.js。
     * **位置不能动**：它要在鉴权之后（每条都要 subject），
     * 而 `/v1/admin/` 的前缀匹配又要早于下面那些具体路径。
     */
    if (await accountRoutes({ req, res, url, reqLogger, subject, sendJson, readJsonBody })) return

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
      const page = await store.list({
        username: subject.username,
        // 不传 = 全部；传空串 = 只要"未归入项目"的那些。两者是不同的意思，
        // 用 `??` 会把空串也吃掉，所以显式判 null
        ...(projectId === null ? {} : { projectId }),
        includeArchived: url.searchParams.get('includeArchived') === '1',
        limit: url.searchParams.get('limit'),
        cursor: url.searchParams.get('cursor') || '',
      })
      /**
       * `sessions` 这个字段名保持不变（前端和 OpenAPI 调用方都在读它），
       * 翻页信息作为**并列的新字段**加上去 —— 换成 `{ items }` 会是一次
       * 没有必要的破坏性改动，而它换不来任何东西。
       */
      return sendJson(res, 200, {
        sessions: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      })
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
    // 这一块搬到了 ./routes/artifacts.js（顺序保持不变）
    if (await artifactRoutes({ req, res, url, reqLogger, subject, sendJson, readJsonBody, readArtifactOr404 })) return

    /* ─────────────── 项目 ─────────────── */
    // 这一块搬到了 ./routes/projects.js（顺序保持不变）
    if (await projectRoutes({ req, res, url, subject, sendJson, readJsonBody })) return

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
    // 这一块搬到了 ./routes/crons.js（顺序保持不变）
    if (await cronRoutes({ req, res, url, reqLogger, subject, sendJson, readJsonBody })) return

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
          // seq 来自 run 缓冲，写成 SSE 的 id —— 断线的人带着它回来接着听
          onFrame: (type, data, seq) => {
            stream.send(type, data, seq)
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

    /* ─────────────── 断线重连 ─────────────── */

    /**
     * 这个人手上还有哪些 run 在跑。
     *
     * 界面刷新之后靠它把断掉的那条找回来：会话正文要等这一轮**结束**才落库，
     * 所以刷新后的历史里根本没有正在生成的这一轮 —— 不问一句的话，
     * 用户看到的是"我刚才那句话发出去之后就没了"。
     */
    if (req.method === 'GET' && url.pathname === '/v1/runs') {
      const sessionKey = url.searchParams.get('sessionKey') || ''
      if (sessionKey) assertSessionKey(sessionKey)
      return sendJson(res, 200, { runs: runService.listRuns({ username: subject.username, sessionKey }) })
    }

    /**
     * 接回一条流。`from` 是客户端收到的最后一帧序号（SSE 的 `id:`）。
     *
     * GET + SSE 而不是复用 `/v1/chat/stream`：那条是 POST，语义是"跑一轮新的"。
     * 拿同一个端点做重连，一次网络抖动导致的重发就会变成又跑一轮、又烧一份 token。
     */
    if (req.method === 'GET' && url.pathname.startsWith('/v1/runs/') && url.pathname.endsWith('/events')) {
      const runId = decodeURIComponent(url.pathname.slice('/v1/runs/'.length, -'/events'.length))
      if (!runId || runId.includes('/')) throw Errors.badRequest('runId 不合法')
      const from = Number(url.searchParams.get('from')) || 0

      /**
       * 订阅要在 openSse **之前**完成 —— 一旦写下 200，就再也回不了 404 了。
       * run 不存在（或不是你的）时，这里还能是一条正正经经的错误响应。
       */
      const stream = { current: null }
      const pending = []
      const subscription = runService.attach({
        runId,
        username: subject.username,
        from,
        listener: (frame) => {
          // 订阅成功到 openSse 之间可能已经来了新帧，先攒着，别丢
          if (!stream.current) { pending.push(frame); return }
          if (frame === null) { stream.current.end(); return }
          stream.current.send(frame.type, frame.data, frame.seq)
        },
      })
      if (!subscription) throw Errors.notFound('run 不存在或已过期')

      stream.current = openSse(res)

      /**
       * 中间有帧被丢掉了（缓冲撑爆过），接不回来。
       *
       * 这时**必须说出来**：少掉的那几帧里可能有整段文本，装作接上了继续发，
       * 用户看到的是一段中间缺了几句的回答，而没有任何迹象表明它缺过。
       * 前端收到这一帧就去重新加载会话。
       */
      if (subscription.truncated) {
        stream.current.send('resync', { runId, reason: 'buffer-truncated' })
        stream.current.end()
        subscription.unsubscribe()
        return
      }

      for (const frame of subscription.replay) stream.current.send(frame.type, frame.data, frame.seq)
      for (const frame of pending) {
        if (frame === null) { stream.current.end(); break }
        stream.current.send(frame.type, frame.data, frame.seq)
      }

      if (subscription.done) {
        stream.current.end()
        subscription.unsubscribe()
        return
      }

      // 客户端又断了就别再往一个没人听的连接上写
      req.on('close', () => {
        subscription.unsubscribe()
        stream.current?.end()
      })
      // 这条请求到这里就"挂着"了 —— 后续由 listener 推帧，直到 run 结束或客户端断开
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
