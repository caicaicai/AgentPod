/**
 * 账号相关的 HTTP 接口：登录 / 注册 / 改密码 / 管理员管人。
 *
 * 这一层测的不是密码怎么哈希（那在 storage-drivers.test.js 的「账号」一组里），
 * 而是**只有经过 HTTP 才会犯的错**：
 *
 *   1. **路由被提前吃掉** —— 真发生过：`/v1/auth/password` 需要登录，处理器在
 *      鉴权之后；而鉴权之前有一块 `startsWith('/v1/auth/')` 的匿名路由，
 *      它把这条请求当成"未知的 auth 接口"回了 404。接口写好了、代码看着也对，
 *      就是永远调不通。所以下面每一条 auth 路由都要有一条**真的打过去**的用例。
 *   2. **越权** —— 普通用户能不能调管理接口、能不能改到别人的东西。
 *   3. **把自己锁在门外** —— 唯一的管理员禁用自己/降级自己之后，就再没人能改回来。
 *   4. **枚举** —— 失败信息不该让人问出"这个用户名存不存在"。
 */
import { test, describe, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { createServer } from '../src/http/server.js'
import { createIdentityResolver } from '../src/identity/index.js'
import { createUserStore } from '../src/identity/user-store.js'
import { createUsageStore } from '../src/telemetry/usage-store.js'
import { createMemoryStorage } from './helpers/memory-storage.js'
import { createMemorySessionStore } from './helpers/memory-session-store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

function buildConfig(over = {}) {
  return {
    auth: {
      mode: 'password',
      password: {
        users: 'admin:changeme',
        sessionSecret: 'test-secret-for-accounts',
        sessionTtlHours: 24,
        allowRegister: false,
        ...over.password,
      },
    },
    llm: { mode: 'faux' },
    sandbox: { mode: 'none' },
    limits: { bodyLimitBytes: 256 * 1024, maxConcurrentRuns: 8, maxRunsPerUser: 2 },
    cron: { enabled: false, scheduler: false, credentialMode: 'none' },
    memory: { enabled: false },
    projects: { enabled: false },
    artifacts: { enabled: false, allowedOrigins: [] },
    devConsole: false,
    webUi: false,
    ...over,
  }
}

let server
let storage

async function startServer(config = buildConfig()) {
  storage = createMemoryStorage()
  const users = createUserStore({ config, storage, logger: silentLogger })
  await users.seedFromEnv()
  const identity = createIdentityResolver({ config, logger: silentLogger, users })

  const app = createServer({
    config,
    logger: silentLogger,
    identity,
    users,
    store: createMemorySessionStore(),
    broker: { getLlmAccess: async () => ({ models: [], user: null }), invalidate() {} },
    runService: {
      snapshot: () => ({ activeRuns: 0, budget: 8, perUserLimit: 2, users: [] }),
      listSkills: () => [], abort: () => ({ ok: true }), execute: async () => ({ runId: 'r', durationMs: 1, finalText: '' }),
    },
    scheduler: { enabled: false, runNow: async () => ({ ok: true }) },
    llmInfoClient: null,
    metrics: { snapshot: () => ({}) },
    // 用量台账走同一个存储替身：接口那一层要测的是鉴权与拼装，不是 SQL
    usage: createUsageStore({ storage, logger: silentLogger }),
  })
  await app.listen(0)
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, users }
}

/** 带 token 的薄封装。token 为空 = 完全匿名 */
function client(base) {
  return async (method, path, { token = '', body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    return { status: response.status, body: parsed }
  }
}

let call
const login = (username, password) => call('POST', '/v1/auth/login', { body: { username, password } })

beforeEach(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
  server = await startServer()
  call = client(server.base)
})
after(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
})

/** 播种出来的管理员，登录拿 token */
async function asAdmin() {
  const { body } = await login('admin', 'changeme')
  return body.token
}

describe('登录', () => {
  test('CONSOLE_USERS 播种的账号能登录，第一个是管理员', async () => {
    const { status, body } = await login('admin', 'changeme')
    assert.equal(status, 200)
    assert.ok(body.token)

    const me = await call('GET', '/v1/auth/me', { token: body.token })
    assert.equal(me.body.account.username, 'admin')
    assert.equal(me.body.account.role, 'admin')
  })

  /**
   * 失败信息**一律同一句**。区分开就等于告诉撞库的人"这个用户名是对的，
   * 继续猜密码"—— 而枚举出有效用户名正是撞库的第一步。
   */
  test('密码错与查无此人回同一句话', async () => {
    const wrongPassword = await login('admin', 'not-the-password')
    const noSuchUser = await login('nobody-at-all', 'whatever')
    assert.equal(wrongPassword.status, 401)
    assert.equal(noSuchUser.status, 401)
    assert.equal(wrongPassword.body.message, noSuchUser.body.message)
  })
})

/**
 * ── 这一组是那次事故的回归 ──────────────────────────────────────────────
 *
 * `/v1/auth/password` 要登录，处理器在鉴权之后；而鉴权之前那块匿名 auth 路由
 * 曾经用 `startsWith('/v1/auth/')` 匹配，把它当成未知接口回了 404。
 * 所以这里必须**真的把请求打过去**，而不是直接调 user-store 的方法。
 */
describe('改自己的密码', () => {
  test('这条路由存在（不是 404）—— 前缀匹配曾经把它整条吃掉', async () => {
    const token = await asAdmin()
    const { status } = await call('POST', '/v1/auth/password', {
      token, body: { oldPassword: 'changeme', newPassword: 'a-new-password' },
    })
    assert.notEqual(status, 404, '/v1/auth/password 被鉴权之前的路由劫走了')
    assert.equal(status, 200)
  })

  test('改完旧密码失效、新密码生效', async () => {
    const token = await asAdmin()
    await call('POST', '/v1/auth/password', { token, body: { oldPassword: 'changeme', newPassword: 'a-new-password' } })

    assert.equal((await login('admin', 'changeme')).status, 401)
    assert.equal((await login('admin', 'a-new-password')).status, 200)
  })

  /**
   * 令牌可能是从别人电脑上、从一次共享屏幕里拿到的。只凭令牌就能改密，
   * 等于把"临时借用"变成"永久接管"，而真正的主人连登录都做不到了。
   */
  test('必须带旧密码', async () => {
    const token = await asAdmin()
    const { status, body } = await call('POST', '/v1/auth/password', {
      token, body: { oldPassword: 'wrong', newPassword: 'a-new-password' },
    })
    assert.equal(status, 400)
    assert.match(body.message, /原密码不正确/)
    assert.equal((await login('admin', 'changeme')).status, 200, '验失败时不该改动任何东西')
  })

  test('新密码太短要拒绝', async () => {
    const token = await asAdmin()
    const { status, body } = await call('POST', '/v1/auth/password', {
      token, body: { oldPassword: 'changeme', newPassword: 'short' },
    })
    assert.equal(status, 400)
    assert.match(body.message, /至少 8 位/)
  })

  test('不登录改不了', async () => {
    const { status } = await call('POST', '/v1/auth/password', {
      body: { oldPassword: 'changeme', newPassword: 'a-new-password' },
    })
    assert.equal(status, 401)
  })
})

describe('注册', () => {
  test('默认关着 —— 账号等于"能跑模型、能开沙盒"，得显式打开', async () => {
    const { status, body } = await call('POST', '/v1/auth/register', {
      body: { username: 'stranger', password: 'stranger-password' },
    })
    assert.equal(status, 403)
    assert.match(body.message, /未开放注册/)
  })

  test('打开之后能注册，且直接拿到令牌', async () => {
    await server.app.close({ timeoutMs: 500 })
    server = await startServer(buildConfig({ password: { allowRegister: true } }))
    call = client(server.base)

    const { status, body } = await call('POST', '/v1/auth/register', {
      body: { username: 'carol', password: 'carol-password' },
    })
    assert.equal(status, 201)
    assert.equal(body.user.role, 'user', '已经有管理员了，新人就是普通用户')
    assert.ok(body.token)
    assert.equal((await login('carol', 'carol-password')).status, 200)
  })

  test('用户名重复注册不了', async () => {
    await server.app.close({ timeoutMs: 500 })
    server = await startServer(buildConfig({ password: { allowRegister: true } }))
    call = client(server.base)

    const { status, body } = await call('POST', '/v1/auth/register', {
      body: { username: 'admin', password: 'trying-to-take-over' },
    })
    assert.equal(status, 400)
    assert.match(body.message, /已被占用/)
    assert.equal((await login('admin', 'changeme')).status, 200, '原账号必须不受影响')
  })
})

describe('管理员接口', () => {
  /** 建一个普通用户并登录，返回他的 token */
  async function makeUser(username = 'bob', password = 'bob-password') {
    const admin = await asAdmin()
    await call('POST', '/v1/admin/users', { token: admin, body: { username, password } })
    const { body } = await login(username, password)
    return { admin, token: body.token }
  }

  test('管理员能列、能建', async () => {
    const { admin } = await makeUser()
    const { status, body } = await call('GET', '/v1/admin/users', { token: admin })
    assert.equal(status, 200)
    assert.deepEqual(body.users.map((user) => user.username).sort(), ['admin', 'bob'])
    // 清单里**不能有哈希和盐**：管理员也没有理由拿到它们
    assert.equal(JSON.stringify(body.users).includes('passwordHash'), false)
    assert.equal(JSON.stringify(body.users).includes('salt'), false)
  })

  test('普通用户碰不了管理接口', async () => {
    const { token } = await makeUser()
    assert.equal((await call('GET', '/v1/admin/users', { token })).status, 403)
    assert.equal((await call('POST', '/v1/admin/users', { token, body: { username: 'x', password: 'xxxxxxxx' } })).status, 403)
    assert.equal((await call('PATCH', '/v1/admin/users/admin', { token, body: { disabled: true } })).status, 403)
  })

  test('不登录更碰不了', async () => {
    assert.equal((await call('GET', '/v1/admin/users')).status, 401)
  })

  test('禁用之后登不进来，数据还在；启用回来又能登', async () => {
    const { admin } = await makeUser()

    await call('PATCH', '/v1/admin/users/bob', { token: admin, body: { disabled: true } })
    const blocked = await login('bob', 'bob-password')
    assert.equal(blocked.status, 401)
    // 密码是对的，拒绝的原因是禁用 —— 这句只对**已经证明自己知道密码**的人显示，
    // 所以不构成枚举（猜错密码时回的仍是那句通用的）
    assert.match(blocked.body.message, /已被禁用/)
    assert.equal((await login('bob', 'wrong-password')).body.message, '用户名或密码错误')

    assert.ok((await call('GET', '/v1/admin/users', { token: admin })).body.users.find((u) => u.username === 'bob'))

    await call('PATCH', '/v1/admin/users/bob', { token: admin, body: { disabled: false } })
    assert.equal((await login('bob', 'bob-password')).status, 200)
  })

  test('改角色：升上去就能用管理接口，降下来就不能', async () => {
    const { admin, token } = await makeUser()

    await call('PATCH', '/v1/admin/users/bob', { token: admin, body: { role: 'admin' } })
    assert.equal((await call('GET', '/v1/admin/users', { token })).status, 200, '升级之后旧令牌就该有权限了')

    await call('PATCH', '/v1/admin/users/bob', { token: admin, body: { role: 'user' } })
    assert.equal((await call('GET', '/v1/admin/users', { token })).status, 403)
  })

  test('管理员重置别人的密码', async () => {
    const { admin } = await makeUser()
    const { status } = await call('PATCH', '/v1/admin/users/bob', { token: admin, body: { newPassword: 'reset-by-admin' } })
    assert.equal(status, 200)
    assert.equal((await login('bob', 'bob-password')).status, 401)
    assert.equal((await login('bob', 'reset-by-admin')).status, 200)
  })

  /**
   * 唯一的管理员禁掉自己之后，**没有任何人**能再把它打开 —— 只能去数据库里手工改。
   * 挡在这一步比事后补救便宜得多。
   */
  test('不能禁用自己，也不能撤销自己的管理员身份', async () => {
    const admin = await asAdmin()

    const disabled = await call('PATCH', '/v1/admin/users/admin', { token: admin, body: { disabled: true } })
    assert.equal(disabled.status, 400)
    assert.match(disabled.body.message, /不能禁用自己/)

    const demoted = await call('PATCH', '/v1/admin/users/admin', { token: admin, body: { role: 'user' } })
    assert.equal(demoted.status, 400)
    assert.match(demoted.body.message, /不能撤销自己的管理员身份/)

    assert.equal((await login('admin', 'changeme')).status, 200, '两次失败都不该动到自己的账号')
  })

  test('改不存在的人回 404，且没有可更新字段时说清楚', async () => {
    const admin = await asAdmin()
    assert.equal((await call('PATCH', '/v1/admin/users/ghost', { token: admin, body: { newPassword: 'whatever-8' } })).status, 404)
    assert.match((await call('PATCH', '/v1/admin/users/admin', { token: admin, body: {} })).body.message, /没有可更新的字段/)
  })
})

/**
 * ── Token 用量 ──────────────────────────────────────────────────────────
 *
 * 这一组关心三件事，都是"只经过 HTTP 才犯得到"的错：
 *
 *   1. **越权** —— 用量是按人名列出来的，普通用户看得到就等于看得到别人在干多少活；
 *   2. **拼装** —— 没跑过 run 的账号也要有一行（0），否则"没用过"和"不存在"
 *      在界面上长得一样；
 *   3. **不该出去的不出去** —— 这个接口一个字的对话内容都不该带。
 */
describe('Token 用量', () => {
  const DAY = 24 * 60 * 60 * 1000

  /** 直接往存储替身里塞账，不必真跑一轮模型 */
  const seed = (over) => storage.usage.record({
    username: 'admin', runId: `run_${Math.random().toString(36).slice(2)}`,
    source: 'web', modelId: 'gpt-4o', input: 100, output: 20, cacheRead: 5, durationMs: 900,
    ...over,
  })

  test('管理员能看到总表：每个账号一行，没用过的是 0', async () => {
    const admin = await asAdmin()
    await call('POST', '/v1/admin/users', { token: admin, body: { username: 'bob', password: 'bob-password' } })
    await seed({ input: 1000, output: 200 })

    const { status, body } = await call('GET', '/v1/admin/usage', { token: admin })
    assert.equal(status, 200)
    assert.equal(body.enabled, true)
    assert.equal(body.group, 'user', '默认按用户看')
    assert.equal(body.total.tokens, 1200, 'tokens = 输入 + 输出，缓存读入单列')
    assert.equal(body.total.cacheRead, 5)

    const rows = new Map(body.users.map((row) => [row.username, row]))
    assert.equal(rows.get('admin').tokens, 1200)
    assert.equal(rows.get('admin').role, 'admin', '角色一起带上，省得前端再连一次表')
    assert.ok(rows.has('bob'), '一次都没跑过的账号也要在表里')
    assert.equal(rows.get('bob').tokens, 0)
    assert.equal(rows.get('bob').runs, 0)
    assert.equal(rows.get('bob').lastAt, null)

    assert.deepEqual(body.users.map((row) => row.username), ['admin', 'bob'], '按用量降序')
  })

  /**
   * ── 模型这一维 ──
   * 用量必须能按模型看：模型单价差一个数量级，"这个人用了 800 万 token"
   * 不带模型是笔糊涂账，将来要计费更是直接算不出来。
   */
  test('每个用户行都带着他用过的模型 —— 不用点开就看得到', async () => {
    const admin = await asAdmin()
    await seed({ modelId: 'claude-opus-5', input: 1000, output: 200 })
    await seed({ modelId: 'claude-haiku-4-5', input: 40, output: 10 })

    const { body } = await call('GET', '/v1/admin/usage', { token: admin })
    const mine = body.users.find((row) => row.username === 'admin')
    assert.deepEqual(
      mine.models.map((row) => [row.modelId, row.tokens]),
      [['claude-opus-5', 1200], ['claude-haiku-4-5', 50]],
      '大的在前',
    )
    assert.equal(mine.models.reduce((sum, row) => sum + row.tokens, 0), mine.tokens, '拆分要加得回这一行的总数')
  })

  test('group=model 换成按模型看，合计与按用户看**完全一致**', async () => {
    const admin = await asAdmin()
    await call('POST', '/v1/admin/users', { token: admin, body: { username: 'bob', password: 'bob-password' } })
    await seed({ modelId: 'claude-opus-5', input: 1000, output: 200 })
    await seed({ username: 'bob', modelId: 'claude-opus-5', input: 300, output: 60 })
    await seed({ username: 'bob', modelId: 'claude-haiku-4-5', input: 40, output: 10 })

    const asUser = await call('GET', '/v1/admin/usage?days=30', { token: admin })
    const asModel = await call('GET', '/v1/admin/usage?days=30&group=model', { token: admin })

    assert.equal(asModel.body.group, 'model')
    assert.deepEqual(
      asModel.body.models.map((row) => [row.modelId, row.tokens]),
      [['claude-opus-5', 1560], ['claude-haiku-4-5', 50]],
    )
    assert.deepEqual(asModel.body.models[0].users.map((row) => row.username), ['admin', 'bob'], '谁在用这个模型')
    // 换个维度总数就变了是这个功能最难查的错：两页都在，谁也说不清哪页是对的
    assert.deepEqual(asModel.body.total, asUser.body.total)
  })

  test('乱填的 group 退回按用户，不报错', async () => {
    const admin = await asAdmin()
    await seed({})
    const { status, body } = await call('GET', '/v1/admin/usage?group=whatever', { token: admin })
    assert.equal(status, 200)
    assert.equal(body.group, 'user')
  })

  test('days 是时间窗，0 表示全部；乱填退回默认 30 天而不是报错', async () => {
    const admin = await asAdmin()
    await seed({ input: 10, output: 1, createdAt: new Date(Date.now() - 40 * DAY) })
    await seed({ input: 500, output: 50, createdAt: new Date(Date.now() - 2 * DAY) })

    const week = await call('GET', '/v1/admin/usage?days=7', { token: admin })
    assert.equal(week.body.total.tokens, 550)
    assert.ok(week.body.since, '有窗就要把起点回出去，界面要显示"统计自"')

    const all = await call('GET', '/v1/admin/usage?days=0', { token: admin })
    assert.equal(all.body.total.tokens, 561)
    assert.equal(all.body.since, null, 'days=0 = 不限时间')

    const junk = await call('GET', '/v1/admin/usage?days=abc', { token: admin })
    assert.equal(junk.status, 200, '一个查询参数填错不值得回 400')
    assert.equal(junk.body.total.tokens, 550, '退回默认的 30 天')
  })

  test('展开一个人：按天曲线，可以只看某一个模型', async () => {
    const admin = await asAdmin()
    await seed({ modelId: 'gpt-4o', input: 100, output: 10, createdAt: new Date('2026-03-01T06:00:00Z') })
    await seed({ modelId: 'tiny', input: 5, output: 1, createdAt: new Date('2026-03-02T06:00:00Z') })

    const all = await call('GET', '/v1/admin/usage/user/admin?days=0', { token: admin })
    assert.equal(all.status, 200)
    assert.deepEqual(all.body.daily.map((row) => row.day), ['2026-03-01', '2026-03-02'])
    assert.equal(all.body.total.tokens, 116)

    const onlyBig = await call('GET', '/v1/admin/usage/user/admin?days=0&modelId=gpt-4o', { token: admin })
    assert.deepEqual(onlyBig.body.daily.map((row) => [row.day, row.tokens]), [['2026-03-01', 110]])
    assert.equal(onlyBig.body.modelId, 'gpt-4o', '把筛的是哪个模型回出去，界面照着写标题')
  })

  test('展开一个模型：全体用户合起来的按天曲线', async () => {
    const admin = await asAdmin()
    await call('POST', '/v1/admin/users', { token: admin, body: { username: 'bob', password: 'bob-password' } })
    await seed({ modelId: 'claude-opus-5', input: 100, output: 10, createdAt: new Date('2026-03-01T06:00:00Z') })
    await seed({ username: 'bob', modelId: 'claude-opus-5', input: 20, output: 2, createdAt: new Date('2026-03-01T06:00:00Z') })

    const { status, body } = await call('GET', '/v1/admin/usage/model/claude-opus-5?days=0', { token: admin })
    assert.equal(status, 200)
    assert.deepEqual(body.daily.map((row) => [row.day, row.runs, row.tokens]), [['2026-03-01', 2, 132]])
  })

  /**
   * 模型 id 是网关给的字符串，`vendor/name:tag` 这种写法完全合法 ——
   * 它**不能**过用户名那道字符集检查（那是给路径段用的）。
   */
  test('模型 id 里有斜杠和冒号也查得动', async () => {
    const admin = await asAdmin()
    const weird = 'vendor/claude-opus-5:thinking'
    await seed({ modelId: weird, input: 100, output: 10 })

    const { status, body } = await call(
      `GET`, `/v1/admin/usage/model/${encodeURIComponent(weird)}?days=0`, { token: admin },
    )
    assert.equal(status, 200)
    assert.equal(body.modelId, weird)
    assert.equal(body.total.tokens, 110)
  })

  test('普通用户看不到任何人的用量（包括自己那一行）', async () => {
    const admin = await asAdmin()
    await call('POST', '/v1/admin/users', { token: admin, body: { username: 'bob', password: 'bob-password' } })
    const token = (await login('bob', 'bob-password')).body.token

    assert.equal((await call('GET', '/v1/admin/usage', { token })).status, 403)
    assert.equal((await call('GET', '/v1/admin/usage?group=model', { token })).status, 403)
    assert.equal((await call('GET', '/v1/admin/usage/user/bob', { token })).status, 403)
    assert.equal((await call('GET', '/v1/admin/usage/model/gpt-4o', { token })).status, 403)
    assert.equal((await call('GET', '/v1/admin/usage')).status, 401, '不登录更不行')
  })

  test('查一个不存在的人回 404，用户名不合法回 400（不是 500）', async () => {
    const admin = await asAdmin()
    assert.equal((await call('GET', '/v1/admin/usage/user/ghost', { token: admin })).status, 404)
    /**
     * 名字不合法要落在 400 上。**不能用 `..` 来测这条** —— URL 解析器会把
     * `%2e%2e` 当成上一级目录直接折掉（路径变成 /v1/admin/usage/），于是那次请求
     * 根本到不了这个处理器，测的其实是 404 那条兜底。带空格的名字才真的走到这里。
     */
    const bad = await call('GET', '/v1/admin/usage/user/bad%20name', { token: admin })
    assert.equal(bad.status, 400)
    assert.match(bad.body.message, /用户名/)
  })

  /**
   * 用户名和模型 id **不住在同一层**（`/usage/user/x` 与 `/usage/model/x`）。
   * 住同一层的话，一个叫 `model` 的账号就能把另一条路由整条遮掉 ——
   * 而那种坏法取决于谁先注册了这个用户名，排查时完全看不出与路由有关。
   */
  test('叫 model / user 的账号不会把路由遮掉', async () => {
    const admin = await asAdmin()
    await call('POST', '/v1/admin/users', { token: admin, body: { username: 'model', password: 'model-password' } })
    await seed({ username: 'model', modelId: 'gpt-4o', input: 100, output: 10 })

    const asUser = await call('GET', '/v1/admin/usage/user/model?days=0', { token: admin })
    assert.equal(asUser.status, 200)
    assert.equal(asUser.body.username, 'model')
    assert.equal(asUser.body.total.tokens, 110)

    const asModel = await call('GET', '/v1/admin/usage/model/gpt-4o?days=0', { token: admin })
    assert.equal(asModel.status, 200)
    assert.equal(asModel.body.modelId, 'gpt-4o')
  })

  test('查一个没有用量的模型回 404，不是一张空表', async () => {
    const admin = await asAdmin()
    await seed({ modelId: 'gpt-4o', input: 100, output: 10 })
    assert.equal((await call('GET', '/v1/admin/usage/model/never-used?days=0', { token: admin })).status, 404)
  })

  /**
   * 管理员该看得见成本，不该顺带看见别人写了什么。"顺带能看见"迟早会有人真的去看，
   * 所以这条断言钉的是**字段清单本身**：将来谁往这个接口上加字段，会先撞到它。
   */
  test('只回聚合数，不带任何对话内容', async () => {
    const admin = await asAdmin()
    await seed({ input: 100, output: 20 })
    const { body } = await call('GET', '/v1/admin/usage', { token: admin })
    assert.deepEqual(
      Object.keys(body.users[0]).sort(),
      ['cacheRead', 'disabled', 'input', 'lastAt', 'models', 'output', 'role', 'runs', 'tokens', 'username'],
    )
    // 嵌进去的那一层同样只有数：模型名 + 用量，没有 sessionKey、没有正文
    assert.deepEqual(
      Object.keys(body.users[0].models[0]).sort(),
      ['cacheRead', 'input', 'lastAt', 'modelId', 'output', 'runs', 'tokens'],
    )
  })
})

describe('能力宣告', () => {
  test('healthz 告诉界面画不画账号入口', async () => {
    const { body } = await call('GET', '/healthz')
    assert.equal(body.features.accounts, true)
    assert.equal(body.features.register, false, '默认不开放注册')
    assert.equal(body.features.usage, true, '接了台账才画「Token 用量」那一页')
  })
})
