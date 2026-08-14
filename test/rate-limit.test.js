/**
 * 登录限流。
 *
 * 分两层测：
 *   1. 限流原语本身（滑动窗口、指数退避、清扫）—— 用注入的假时钟，
 *      不然测"封 30 秒"就得真等 30 秒。
 *   2. 打到 HTTP 上的那两道闸，重点是**顺序**：按 IP 那道必须挡在 scrypt 之前，
 *      否则被拒的请求也已经把 100ms CPU 付掉了，闸门等于没有（见 rate-limit.js 文件头）。
 */
import { test, describe, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { createRateLimiter, clientIp } from '../src/http/rate-limit.js'
import { createServer } from '../src/http/server.js'
import { createIdentityResolver } from '../src/identity/index.js'
import { createUserStore } from '../src/identity/user-store.js'
import { createMemoryStorage } from './helpers/memory-storage.js'
import { createMemorySessionStore } from './helpers/memory-session-store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

describe('限流原语', () => {
  /** 假时钟：让"过了多久"变成一个可以直接写出来的数 */
  function fakeClock(start = 1_000_000) {
    let current = start
    return { now: () => current, advance(ms) { current += ms } }
  }

  test('窗口内放行到上限，超一次就封', () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({
      windowMs: 60_000, max: 3, baseBlockMs: 30_000, maxBlockMs: 900_000, now: clock.now,
    })

    for (let i = 0; i < 3; i += 1) assert.equal(limiter.consume('k').ok, true, `第 ${i + 1} 次该放行`)

    const blocked = limiter.consume('k')
    assert.equal(blocked.ok, false)
    assert.equal(blocked.retryAfterMs, 30_000)
  })

  test('窗口滑走之后额度自己长回来 —— 不是每 60 秒清一次的固定窗口', () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({
      windowMs: 60_000, max: 2, baseBlockMs: 30_000, maxBlockMs: 900_000, now: clock.now,
    })

    assert.equal(limiter.consume('k').ok, true)
    clock.advance(40_000)
    assert.equal(limiter.consume('k').ok, true)
    // 再走 30s：第一次那个时间戳已经滑出窗口，所以这次不该被判超限
    clock.advance(30_000)
    assert.equal(limiter.consume('k').ok, true)
  })

  test('封禁到点自动解开', () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({
      windowMs: 60_000, max: 1, baseBlockMs: 30_000, maxBlockMs: 900_000, now: clock.now,
    })

    assert.equal(limiter.consume('k').ok, true)
    assert.equal(limiter.consume('k').ok, false)

    clock.advance(29_999)
    assert.equal(limiter.peek('k').ok, false, '还差 1ms，不该放行')
    clock.advance(2)
    assert.equal(limiter.peek('k').ok, true)
    assert.equal(limiter.consume('k').ok, true, '解封后额度是干净的')
  })

  test('反复触发时封禁时长翻倍，并在上限处停住', () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({
      windowMs: 1000, max: 1, baseBlockMs: 100, maxBlockMs: 400, now: clock.now,
    })

    /** 触发一次超限，返回这次被判的封禁时长 */
    const trip = () => {
      assert.equal(limiter.consume('k').ok, true)
      const blocked = limiter.consume('k')
      assert.equal(blocked.ok, false)
      return blocked.retryAfterMs
    }

    assert.equal(trip(), 100)
    clock.advance(100)
    assert.equal(trip(), 200)
    clock.advance(200)
    assert.equal(trip(), 400)
    clock.advance(400)
    // 翻倍会到 800，但 maxBlockMs=400 压住 —— 不设上限的话，
    // 一个手滑的正常用户被封几次之后就要等到天荒地老
    assert.equal(trip(), 400)
  })

  test('peek 不计数 —— 否则"问一下还能不能登"这个动作本身就把额度吃了', () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({
      windowMs: 60_000, max: 2, baseBlockMs: 30_000, maxBlockMs: 900_000, now: clock.now,
    })

    for (let i = 0; i < 10; i += 1) assert.equal(limiter.peek('k').ok, true)
    assert.equal(limiter.consume('k').ok, true)
    assert.equal(limiter.consume('k').ok, true)
    assert.equal(limiter.consume('k').ok, false)
  })

  test('reset 清零', () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({
      windowMs: 60_000, max: 2, baseBlockMs: 30_000, maxBlockMs: 900_000, now: clock.now,
    })

    assert.equal(limiter.consume('k').ok, true)
    assert.equal(limiter.consume('k').ok, true)
    limiter.reset('k')
    assert.equal(limiter.consume('k').ok, true, '清零之后额度该是满的')
  })

  /**
   * 这一条测的是限流器**自己不能变成 DoS 工具**：换着 key 打过来，
   * 每个都在 Map 里留一条的话，内存就这么涨上去。
   */
  test('key 数量有上限，过期的先被忘掉', () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({
      windowMs: 1000, max: 5, baseBlockMs: 100, maxBlockMs: 400, maxKeys: 10, now: clock.now,
    })

    for (let i = 0; i < 10; i += 1) limiter.consume(`k${i}`)
    assert.equal(limiter.size(), 10)

    // 让这 10 个全部过期，再灌新的：老的该被清掉，而不是一直堆着
    clock.advance(5000)
    for (let i = 10; i < 20; i += 1) limiter.consume(`k${i}`)
    assert.ok(limiter.size() <= 10, `key 数应收在 10 以内，实际 ${limiter.size()}`)
  })

  /**
   * 淘汰顺序是"到期早的先走"，所以正在封禁中的 key 排在最后。
   * 反过来的话，灌够多的新 key 就能把自己的封禁冲掉 —— 那道闸就白设了。
   */
  test('灌新 key 冲不掉正在生效的封禁', () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({
      windowMs: 1000, max: 1, baseBlockMs: 600_000, maxBlockMs: 600_000, maxKeys: 5, now: clock.now,
    })

    assert.equal(limiter.consume('victim').ok, true)
    assert.equal(limiter.consume('victim').ok, false, '先把 victim 打进封禁')

    for (let i = 0; i < 50; i += 1) limiter.consume(`flood${i}`)

    assert.equal(limiter.peek('victim').ok, false, 'victim 的封禁必须还在')
  })
})

describe('clientIp', () => {
  const reqWith = (headers, remote = '10.0.0.1') => ({ headers, socket: { remoteAddress: remote } })

  test('默认不认 X-Forwarded-For —— 认了的话改个头就是一份新额度', () => {
    const req = reqWith({ 'x-forwarded-for': '1.2.3.4' })
    assert.equal(clientIp(req), '10.0.0.1')
  })

  test('TRUST_PROXY 打开时取最左边那个', () => {
    const req = reqWith({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
    assert.equal(clientIp(req, { trustProxy: true }), '1.2.3.4')
  })

  test('打开了但头是空的，退回 socket 地址', () => {
    assert.equal(clientIp(reqWith({}), { trustProxy: true }), '10.0.0.1')
  })
})

// ── HTTP 层 ────────────────────────────────────────────────────────────────

function buildConfig(rateLimit) {
  return {
    auth: {
      mode: 'password',
      password: {
        users: 'alice:correct-horse',
        sessionSecret: 'test-secret-for-rate-limit',
        sessionTtlHours: 24,
        allowRegister: false,
        /**
         * 窗口和封禁时长给足，让用例只靠"次数"说话 —— 用真时钟测时间维度
         * 就得真等那么久。时间维度已经在上面的假时钟里测过了。
         */
        rateLimit: {
          enabled: true,
          ipWindowMs: 60_000,
          ipMax: 20,
          userWindowMs: 15 * 60_000,
          userMax: 5,
          baseBlockMs: 30_000,
          maxBlockMs: 900_000,
          ...rateLimit,
        },
      },
    },
    trustProxy: false,
    llm: { mode: 'faux' },
    sandbox: { mode: 'none' },
    limits: { bodyLimitBytes: 256 * 1024, maxConcurrentRuns: 8, maxRunsPerUser: 2 },
    cron: { enabled: false, scheduler: false, credentialMode: 'none' },
    memory: { enabled: false },
    projects: { enabled: false },
    artifacts: { enabled: false, allowedOrigins: [] },
    devConsole: false,
    webUi: false,
  }
}

let server

async function startServer(config) {
  const storage = createMemoryStorage()
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
  })
  await app.listen(0)
  return { app, base: `http://127.0.0.1:${app.server.address().port}` }
}

async function login(base, username, password) {
  const response = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { status: response.status, body, retryAfter: response.headers.get('retry-after') }
}

beforeEach(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
  server = null
})
after(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
})

describe('登录限流（HTTP）', () => {
  test('同一个 IP 打太多次就 429，并带 Retry-After', async () => {
    // ipMax=3：前 3 次按正常流程走（密码错，401），第 4 次才该被闸挡下
    server = await startServer(buildConfig({ ipMax: 3, userMax: 100 }))

    for (let i = 0; i < 3; i += 1) {
      const { status } = await login(server.base, 'alice', 'wrong')
      assert.equal(status, 401, `第 ${i + 1} 次该是正常的密码错`)
    }

    const limited = await login(server.base, 'alice', 'wrong')
    assert.equal(limited.status, 429)
    assert.equal(limited.body.error, 'RATE_LIMITED')
    assert.ok(Number(limited.retryAfter) > 0, `Retry-After 该是正数，实际 ${limited.retryAfter}`)
    assert.ok(limited.body.details.retryAfterMs > 0)
  })

  /**
   * 这是那道闸真正的意义：**密码对不对都进不来**。
   * 只挡失败请求的话，攻击者拿一个自己的合法账号就能绕过去接着灌 scrypt。
   */
  test('IP 被封之后，连密码正确的登录也一并挡在外面', async () => {
    server = await startServer(buildConfig({ ipMax: 2, userMax: 100 }))

    await login(server.base, 'alice', 'wrong')
    await login(server.base, 'alice', 'wrong')

    const { status } = await login(server.base, 'alice', 'correct-horse')
    assert.equal(status, 429, '闸在鉴权之前，正确密码也该被挡')
  })

  test('同一个账号连续失败到上限就锁定，报的是 429 不是 401', async () => {
    server = await startServer(buildConfig({ ipMax: 1000, userMax: 3 }))

    for (let i = 0; i < 3; i += 1) {
      const { status } = await login(server.base, 'alice', 'wrong')
      assert.equal(status, 401)
    }

    const locked = await login(server.base, 'alice', 'wrong')
    assert.equal(locked.status, 429)
    assert.equal(locked.body.error, 'RATE_LIMITED')

    // 锁的是这个账号，正确密码同样进不来 —— 否则"锁定"只是个说法
    const withRightPassword = await login(server.base, 'alice', 'correct-horse')
    assert.equal(withRightPassword.status, 429)
  })

  test('大小写换着写也是同一个账号，绕不过去', async () => {
    server = await startServer(buildConfig({ ipMax: 1000, userMax: 2 }))

    await login(server.base, 'alice', 'wrong')
    await login(server.base, 'ALICE', 'wrong')

    const locked = await login(server.base, 'AlIcE', 'wrong')
    assert.equal(locked.status, 429)
  })

  test('登录成功会把失败计数清零', async () => {
    server = await startServer(buildConfig({ ipMax: 1000, userMax: 3 }))

    await login(server.base, 'alice', 'wrong')
    await login(server.base, 'alice', 'wrong')

    const ok = await login(server.base, 'alice', 'correct-horse')
    assert.equal(ok.status, 200)

    // 清零了，所以下面两次还该是正常的 401 而不是被锁
    for (let i = 0; i < 2; i += 1) {
      const { status } = await login(server.base, 'alice', 'wrong')
      assert.equal(status, 401, '成功之后计数该是从头开始的')
    }
  })

  test('不存在的用户名同样受按账号的闸约束 —— 撞库的用户名是猜出来的', async () => {
    server = await startServer(buildConfig({ ipMax: 1000, userMax: 2 }))

    await login(server.base, 'nobody', 'x')
    await login(server.base, 'nobody', 'x')

    const locked = await login(server.base, 'nobody', 'x')
    assert.equal(locked.status, 429)
  })

  test('关掉限流开关之后行为与从前一致', async () => {
    const config = buildConfig({})
    config.auth.password.rateLimit.enabled = false
    server = await startServer(config)

    for (let i = 0; i < 30; i += 1) {
      const { status } = await login(server.base, 'alice', 'wrong')
      assert.equal(status, 401)
    }
  })
})
