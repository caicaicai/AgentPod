/**
 * 令牌回收。
 *
 * 从前 JWT 在这里是**纯无状态**的：签出去就收不回来。于是有三件事只是看起来
 * 成功了 ——
 *
 *   1. 管理员禁用某人 —— 只挡住了新登录，那个人手里的令牌照样能用到过期（默认 24h）；
 *   2. 用户改密码     —— 同上，密码泄露后改密并不能把已经拿到令牌的人踢下去；
 *   3. 管理员重置密码 —— 同上。
 *
 * 现在账号记录里带一个 tokenVersion，签发时写进令牌、每个请求比对一次。
 * 下面每一条用例都对应上面某一个"看起来成功了"。
 */
import { test, describe, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { createServer } from '../src/http/server.js'
import { createIdentityResolver } from '../src/identity/index.js'
import { createUserStore } from '../src/identity/user-store.js'
import { signToken, verifyToken } from '../src/identity/password-auth.js'
import { createMemoryStorage } from './helpers/memory-storage.js'
import { createMemorySessionStore } from './helpers/memory-session-store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

function buildConfig() {
  return {
    auth: {
      mode: 'password',
      password: {
        users: 'admin:changeme,bob:bobs-password',
        sessionSecret: 'test-secret-for-revocation',
        sessionTtlHours: 24,
        allowRegister: false,
        // 这一组用例要反复用错密码登录，限流会碍事 —— 它自己有专门的测试文件
        rateLimit: { enabled: false },
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

async function startServer() {
  const config = buildConfig()
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
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, users, identity, config }
}

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
const whoami = (token) => call('GET', '/v1/auth/me', { token })

async function tokenFor(username, password) {
  const { body } = await login(username, password)
  assert.ok(body?.token, `${username} 应该能登录`)
  return body.token
}

beforeEach(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
  server = await startServer()
  call = client(server.base)
})
after(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
})

describe('令牌里带代数', () => {
  test('签发时写进 ver，校验时读得出来', () => {
    const { token } = signToken('alice', 'secret', 3600, 7)
    assert.deepEqual(verifyToken(token, 'secret'), { username: 'alice', tokenVersion: 7 })
  })

  /**
   * 这一条钉住的是**升级当天不会把所有人踢下线**：功能上线前签出去的令牌
   * 没有 ver 字段，而库里的老账号记录也没有 tokenVersion —— 两边都当 0，正好对上。
   */
  test('老令牌没有 ver 字段时当 0，与老账号记录对得上', () => {
    const { token } = signToken('alice', 'secret', 3600) // 不传版本，模拟老代码签的
    assert.equal(verifyToken(token, 'secret').tokenVersion, 0)
  })

  test('改不动 —— 改了 ver 就等于改了 payload，签名对不上', () => {
    const { token } = signToken('alice', 'secret', 3600, 0)
    const [header, payload, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
      ver: 99,
    })).toString('base64url')
    assert.equal(verifyToken(`${header}.${forged}.${sig}`, 'secret'), null)
  })
})

describe('禁用账号', () => {
  test('禁用之后，那个人手里的令牌当场失效 —— 不是等到过期', async () => {
    const bobToken = await tokenFor('bob', 'bobs-password')
    assert.equal((await whoami(bobToken)).status, 200, '禁用前该是正常的')

    const adminToken = await tokenFor('admin', 'changeme')
    const patched = await call('PATCH', '/v1/admin/users/bob', {
      token: adminToken,
      body: { disabled: true },
    })
    assert.equal(patched.status, 200)

    const after = await whoami(bobToken)
    assert.equal(after.status, 401, '禁用之后旧令牌必须立刻不好使')
  })

  test('重新启用不会把别处的登录一起踢掉 —— 他什么也没做错', async () => {
    const adminToken = await tokenFor('admin', 'changeme')
    await call('PATCH', '/v1/admin/users/bob', { token: adminToken, body: { disabled: true } })
    await call('PATCH', '/v1/admin/users/bob', { token: adminToken, body: { disabled: false } })

    // 启用之后重新登录拿的令牌，不该因为"启用"这个动作本身又被作废
    const fresh = await tokenFor('bob', 'bobs-password')
    assert.equal((await whoami(fresh)).status, 200)
  })
})

describe('改密码', () => {
  test('改密之后，别处的登录全部失效', async () => {
    const onPhone = await tokenFor('bob', 'bobs-password')
    const onLaptop = await tokenFor('bob', 'bobs-password')

    const changed = await call('POST', '/v1/auth/password', {
      token: onLaptop,
      body: { oldPassword: 'bobs-password', newPassword: 'a-much-better-one' },
    })
    assert.equal(changed.status, 200)
    assert.equal(changed.body.tokensRevoked, true, '这个字段从前一直是 false，现在该是真的了')

    assert.equal((await whoami(onPhone)).status, 401, '手机上那张令牌必须失效')
  })

  /**
   * 改密码的人刚刚证明过自己知道旧密码，是这台设备上最不该被怀疑的那个人。
   * 要作废的是**别处**那些令牌，不是眼前这一张 —— 所以接口回一张新的。
   */
  test('发起改密的这条会话拿到新令牌，不会把自己踢下线', async () => {
    const onLaptop = await tokenFor('bob', 'bobs-password')
    const changed = await call('POST', '/v1/auth/password', {
      token: onLaptop,
      body: { oldPassword: 'bobs-password', newPassword: 'a-much-better-one' },
    })

    assert.ok(changed.body.token, '该回一张新令牌')
    assert.notEqual(changed.body.token, onLaptop)
    assert.equal((await whoami(changed.body.token)).status, 200, '新令牌该能直接接着用')
    assert.equal((await whoami(onLaptop)).status, 401, '旧的那张同样失效')
  })

  test('新密码能登录，旧密码不能', async () => {
    const onLaptop = await tokenFor('bob', 'bobs-password')
    await call('POST', '/v1/auth/password', {
      token: onLaptop,
      body: { oldPassword: 'bobs-password', newPassword: 'a-much-better-one' },
    })

    assert.equal((await login('bob', 'bobs-password')).status, 401)
    assert.equal((await login('bob', 'a-much-better-one')).status, 200)
  })
})

describe('管理员重置密码', () => {
  test('重置之后那个人手里的令牌失效', async () => {
    const bobToken = await tokenFor('bob', 'bobs-password')
    const adminToken = await tokenFor('admin', 'changeme')

    const reset = await call('PATCH', '/v1/admin/users/bob', {
      token: adminToken,
      body: { newPassword: 'reset-by-admin' },
    })
    assert.equal(reset.status, 200)

    assert.equal((await whoami(bobToken)).status, 401, '被重置密码的人该被踢下线')
    assert.equal((await login('bob', 'reset-by-admin')).status, 200)
  })

  test('重置别人的密码不影响管理员自己的会话', async () => {
    const adminToken = await tokenFor('admin', 'changeme')
    await call('PATCH', '/v1/admin/users/bob', { token: adminToken, body: { newPassword: 'reset-by-admin' } })
    assert.equal((await whoami(adminToken)).status, 200)
  })
})

describe('账号不存在', () => {
  /**
   * 今天没有"删账号"的 HTTP 入口（禁用不删数据，见 user-store.setDisabled），
   * 但账号记录仍然可能凭空消失 —— 一次手工的库操作、一次不完整的数据迁移。
   * 那时令牌该认不出主人，而不是变成一张谁也管不着的通行证：签名是自洽的，
   * 没有这条判断的话，服务端会老老实实按令牌里写的用户名给他建工作区、跑模型。
   */
  test('库里查无此人时，签名再对的令牌也不算数', async () => {
    // 用服务端自己的密钥签一张"幽灵"令牌：签名完全合法，只是这个人不存在
    const ghost = signToken('ghost', server.config.auth.password.sessionSecret, 3600, 0)
    assert.deepEqual(verifyToken(ghost.token, server.config.auth.password.sessionSecret), {
      username: 'ghost', tokenVersion: 0,
    }, '前提：这张令牌本身是验得过签的')

    assert.equal(await server.users.authState('ghost'), null, '前提：库里确实没有这个人')
    assert.equal((await whoami(ghost.token)).status, 401, '验得过签也得挡下来')
  })
})

describe('未受影响的部分', () => {
  test('别人改密码不会踢掉我', async () => {
    const bobToken = await tokenFor('bob', 'bobs-password')
    const adminToken = await tokenFor('admin', 'changeme')

    await call('POST', '/v1/auth/password', {
      token: adminToken,
      body: { oldPassword: 'changeme', newPassword: 'admin-new-password' },
    })

    assert.equal((await whoami(bobToken)).status, 200, 'bob 与这件事无关')
  })

  test('改角色会让新权限立刻生效，而不是等一个缓存周期', async () => {
    const adminToken = await tokenFor('admin', 'changeme')
    const bobToken = await tokenFor('bob', 'bobs-password')

    // 升成管理员之前，管理接口该拒绝他
    assert.equal((await call('GET', '/v1/admin/users', { token: bobToken })).status, 403)

    await call('PATCH', '/v1/admin/users/bob', { token: adminToken, body: { role: 'admin' } })
    assert.equal((await call('GET', '/v1/admin/users', { token: bobToken })).status, 200, '提权该立刻生效')

    await call('PATCH', '/v1/admin/users/bob', { token: adminToken, body: { role: 'user' } })
    assert.equal((await call('GET', '/v1/admin/users', { token: bobToken })).status, 403, '降权同样该立刻生效')
  })
})
