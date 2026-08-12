/**
 * 工具运行上下文 —— 进程内工具拿凭据的**唯一**方式。
 *
 * 设计原则只有一条：**工具永远拿不到凭据本身，只能拿到"用凭据做事的能力"。**
 *
 *   ctx.http            → 已经绑好该用户凭据的出站客户端（凭据在闭包里，取不出来）
 *   ctx.credentialFacts → 关于凭据的**非机密事实**（有没有 me_token），够业务判断用
 *   ctx.username / runId     → 身份与追踪
 *
 * 没有 ctx.credential。想加回去之前请先读 docs/ISOLATION-CONTRACT.md。
 */
import { createToolHttp } from './http.js'

/**
 * 把 Cookie 头字符串转成 Playwright 的 cookie 数组。
 *
 * ⚠️ 这是整套设计里凭据**唯一一次**离开 agent service。
 * 不是妥协掉了原则，而是浏览器自动化的本质要求：页面自己要带着登录态发请求，
 * 服务端代发（Cloud Bridge 那条路）替代不了 —— 那样页面里的 XHR 一个都过不去。
 *
 * 换来的约束必须成立，缺一条这个例外就不该开：
 *   1. 只进 BrowserContext 的内存，worker 不落盘
 *   2. 随租约销毁（leases.js 释放时 context.close()）
 *   3. job 与 worker 是不同 uid，被执行的命令读不到 worker 内存
 *   4. 只投给白名单域，不是所有站点
 *   5. 日志只记条数，绝不记内容
 */
export function credentialToBrowserCookies(credential, domains = []) {
  const raw = String(credential || '').trim()
  if (!raw) return []
  const cookies = []
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!name) continue
    for (const domain of domains) {
      cookies.push({ name, value, domain, path: '/' })
    }
  }
  return cookies
}

/** 从凭据里提取业务需要的**非机密事实**。只回布尔值，绝不回内容。 */
export function describeCredential(credential) {
  const raw = String(credential || '')
  return {
    present: raw.length > 0,
    hasMeToken: /(^|;|\s)me_token=/.test(raw),
  }
}

/**
 * @param {object} params
 * @param {string} params.credential 用户登录态。**只进闭包，不挂到返回对象上。**
 */
export function createToolContext({
  runId,
  username,
  credential = '',
  logger,
  signal = null,
  sandboxSession = null,
  workspace = null,
  browserCookieDomains = ['.xiaocaicai.com'],
  memory = null,
  crons = null,
  artifacts = null,
  /** 本轮所属项目。决定 memory 工具写进哪一份 MEMORY.md */
  projectId = '',
  /** 本轮所属会话。决定 artifact 工具产出的作品挂在哪条对话下 */
  sessionKey = '',
}) {
  if (!username) throw new Error('createToolContext 缺少 username —— 隔离契约 #4')

  const facts = describeCredential(credential)
  const http = createToolHttp({ logger, runId, username })

  // 浏览器能力同样把凭据关在闭包里：工具调 ctx.browser.action(...)，
  // cookie 由这里注入，工具自己拿不到，也没法投给别的域。
  const browser = sandboxSession?.browserAction
    ? {
        available: true,
        async action(name, payload = {}) {
          const needsCookies = name === 'open' || name === 'navigate'
          return sandboxSession.browserAction(name, {
            ...payload,
            ...(needsCookies ? { cookies: credentialToBrowserCookies(credential, browserCookieDomains) } : {}),
          })
        },
      }
    : { available: false, async action() { throw new Error('本次运行没有可用的浏览器沙盒') } }

  /**
   * 个人技能的读写能力。
   *
   * 和 `browser` 同一个套路：**username 关在闭包里**，工具只能往"自己这个用户"的
   * 技能目录写。工具拿不到 workspace store 本身，也就没法拼一个别人的路径 ——
   * 与"工具拿不到凭据本身"是同一条原则的延伸。
   */
  const skills = workspace?.enabled && sandboxSession
    ? {
        available: true,
        /** 读 `workspace/<dir>/` 下的全部普通文件（软链接不跟，见 store 的说明） */
        async readWorkspaceDir(dir) {
          const name = String(dir || '').trim().replace(/^\/+|\/+$/g, '')
          if (!name || name.includes('/') || name.includes('..')) {
            throw new Error('目录名必须是 workspace/ 下的一级目录，不带路径分隔符')
          }
          const base = `workspace/${name}`
          const listing = await sandboxSession.listFiles({ path: base, recursive: true, includeHidden: true })
          const entries = (listing.items || []).filter((item) => item.kind === 'file')
          return { base, entries, truncated: Boolean(listing.truncated) }
        },
        async readFiles(paths) {
          return sandboxSession.getFiles(paths)
        },
        async save({ name, files }) {
          return workspace.writeSkillFiles({ username, scope: 'created', name, files, tag: runId })
        },
      }
    : { available: false }

  /**
   * 长期记忆的读写能力。
   *
   * 与 `browser` / `skills` 同一个套路：**作用域关在闭包里**。工具只能读写
   * "这个用户 + 这个项目"的那一份 MEMORY.md，拿不到 store 本身，也就拼不出
   * 别人的作用域 —— 与"工具拿不到凭据本身"是同一条原则的延伸。
   */
  const memoryOps = memory?.enabled
    ? {
        available: true,
        scope: projectId ? 'project' : 'personal',
        read: () => memory.read({ username, projectId }),
        remember: (facts) => memory.capture({ username, projectId }, facts),
        forget: (text) => memory.forget({ username, projectId }, text),
        search: (keyword, limit) => memory.query({ username, projectId }, keyword, limit),
        /** 个人那一份始终可读：项目会话里问"我是谁"也该答得上来 */
        readPersonal: () => memory.read({ username }),
        rememberPersonal: (facts) => memory.capture({ username }, facts),
      }
    : { available: false }

  const cronOps = crons?.enabled
    ? {
        available: true,
        list: () => crons.list({ username }),
        get: (id) => crons.get({ username, id }),
        create: (input) => crons.create({ ...input, username, projectId: input?.projectId ?? projectId }),
        // 逐字段取而不是展开：展开的话模型传一个 username 就能改到别人的任务上
        update: (input) => crons.update({
          username,
          id: input?.id,
          title: input?.title,
          task: input?.task,
          schedule: input?.schedule,
          sessionMode: input?.sessionMode,
          enabled: input?.enabled,
          archived: input?.archived,
        }),
        remove: (id) => crons.remove({ username, id }),
      }
    : { available: false }

  /**
   * 作品的读写能力。
   *
   * 与上面几个同一个套路：**username / sessionKey 关在闭包里**。工具只能往
   * "这个用户 + 这条会话"下产出作品，拿不到 store 本身 —— 所以模型即使把
   * `username` 当参数传进来也改不到别人的东西。逐字段取而不是展开入参，
   * 是同一条纪律的落法（反面教材见 http/server.js 里 PATCH 那段注释）。
   */
  const artifactOps = artifacts?.enabled
    ? {
        available: true,
        create: ({ kind, title, files, entry, language }) =>
          artifacts.create({ username, sessionKey, projectId, kind, title, files, entry, language }),
        read: ({ id, version }) => artifacts.read({ username, id, version }),
        write: ({ id, files, remove, entry, title }) =>
          artifacts.write({ username, id, files, remove, entry, title }),
        replace: ({ id, path, oldStr, newStr }) => artifacts.replace({ username, id, path, oldStr, newStr }),
      }
    : { available: false }

  return {
    runId,
    username,
    projectId,
    sessionKey,
    credentialFacts: facts,
    http,
    browser,
    skills,
    memory: memoryOps,
    crons: cronOps,
    artifacts: artifactOps,
    signal,
    logger: logger.child({ runId, username }),
  }
}
