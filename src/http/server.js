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
}) {
  const webDir = config.webDir || DEFAULT_WEB_DIR

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
        },
      })
    }
    if (url.pathname === '/metrics.json') {
      return sendJson(res, 200, metrics.snapshot())
    }

    // ---------- 账号密码登录（AUTH_MODE=password 时生效）----------
    if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
      if (config.auth.mode !== 'password') {
        return sendJson(res, 404, { error: 'NOT_FOUND', message: '当前 AUTH_MODE 不支持密码登录' })
      }
      const body = await readJsonBody(req, config.limits.bodyLimitBytes)
      const { username, password } = body || {}
      if (typeof username !== 'string' || !username) {
        throw Errors.badRequest('用户名必填')
      }
      if (typeof password !== 'string' || !password) {
        throw Errors.badRequest('密码必填')
      }
      if (!identity.passwordUsers || identity.passwordUsers.size === 0) {
        return sendJson(res, 503, { error: 'NO_USERS', message: '未配置 CONSOLE_USERS 环境变量，无法登录' })
      }
      if (!validateCredentials(identity.passwordUsers, username, password)) {
        reqLogger.warn('密码登录失败', { username })
        throw Errors.unauthenticated('用户名或密码错误')
      }
      const ttlSec = config.auth.password.sessionTtlHours * 3600
      const { token, expiresAt } = signToken(username, identity.passwordSecret, ttlSec)
      reqLogger.info('密码登录成功', { username })
      return sendJson(res, 200, { ok: true, token, expiresAt, username })
    }

    // ---------- 静态页面 ----------
    // 页面本身不含任何用户数据，数据一律由下面那些要身份的接口提供，所以静态资源不鉴权。
    if (req.method === 'GET') {
      if (config.webUi) {
        if (url.pathname === '/' || url.pathname === '/index.html') {
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
      }
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
      })
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
