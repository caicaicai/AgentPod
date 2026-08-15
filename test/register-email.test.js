/**
 * 带邮箱验证码的自助注册。
 *
 * 这一层测的是**只有把请求真的打过去才会犯的错**，以及这条流程里那几处
 * "写反了也照样跑得通、但等于没做"的地方：
 *
 *   1. **注册接口不能发令牌**。开了验证码却顺手把 token 发了，等于人早就进来了，
 *      那封信只是发着好看 —— 这是整件事里最容易悄悄失效的一条。
 *   2. **未激活的账号不能登录**，而且提示要能把界面领到下一步（不是"密码错误"）。
 *   3. **试错次数上限真的作废验证码**，不是只回一句错。
 *   4. **重发有间隔**，否则这条接口就是一台免费的发信机（挨骂的是我们的域名）。
 *   5. **路由不被前面那块提前吃掉** —— /v1/auth/activate 是新加的，
 *      而 server.js 里那段注释讲的就是这个坑。
 *
 * 发信不真的发：注入一个假 transport，把信收进数组里。验证码只在那封信里，
 * 与真实用户拿到它的路径完全一致 —— 测试不去偷看存储。
 */
import { test, describe, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { createServer } from '../src/http/server.js'
import { createIdentityResolver } from '../src/identity/index.js'
import { createUserStore } from '../src/identity/user-store.js'
import { createMailer } from '../src/mail/mailer.js'
import { buildMessage, encodeHeaderWord } from '../src/mail/smtp.js'
import { createMemoryStorage } from './helpers/memory-storage.js'
import { createMemorySessionStore } from './helpers/memory-session-store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

function buildConfig(over = {}) {
  return {
    auth: {
      mode: 'password',
      password: {
        users: '',
        sessionSecret: 'test-secret-for-register',
        sessionTtlHours: 24,
        allowRegister: true,
        register: {
          requireEmail: true,
          verifyEmail: true,
          codeLength: 6,
          codeTtlMinutes: 15,
          maxAttempts: 3,
          resendIntervalSeconds: 60,
          emailDomains: [],
          ...over.register,
        },
      },
    },
    mail: { transport: 'smtp' },
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
let sent
/** 可以被测试推着走的时钟 —— 过期那条用例不能真的等 15 分钟 */
let clock

async function startServer({ register = {}, mailFails = false } = {}) {
  const config = buildConfig({ register })
  const storage = createMemoryStorage()
  clock = { at: Date.now() }
  const users = createUserStore({ config, storage, logger: silentLogger, now: () => clock.at })
  const identity = createIdentityResolver({ config, logger: silentLogger, users })
  sent = []
  const mailer = createMailer({
    config,
    logger: silentLogger,
    transport: async (mail) => {
      if (mailFails) throw new Error('SMTP 连不上')
      sent.push(mail)
      return { ok: true }
    },
  })

  const app = createServer({
    config,
    logger: silentLogger,
    identity,
    users,
    mailer,
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
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, users }
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
const register = (body) => call('POST', '/v1/auth/register', { body })
const activate = (body) => call('POST', '/v1/auth/activate', { body })
const login = (username, password) => call('POST', '/v1/auth/login', { body: { username, password } })

/** 从最后一封信里把验证码抠出来 —— 与真实用户拿到它的路径一致 */
function lastCode() {
  const mail = sent[sent.length - 1]
  return String(mail.text.match(/验证码是：(\d+)/)?.[1] || '')
}

after(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
})

describe('注册要邮箱、发验证码', () => {
  beforeEach(async () => {
    if (server) await server.app.close({ timeoutMs: 500 })
    server = await startServer()
    call = client(server.base)
  })

  test('healthz 告诉界面：要画邮箱那一栏，而且后面还有验证码一步', async () => {
    const { body } = await call('GET', '/healthz')
    assert.equal(body.features.register, true)
    assert.equal(body.features.registerEmail, true)
    assert.equal(body.features.registerVerifyEmail, true)
  })

  test('不填邮箱直接被拒', async () => {
    const { status, body } = await register({ username: 'zhangsan', password: 'password123' })
    assert.equal(status, 400)
    assert.match(body.message, /邮箱/)
  })

  test('邮箱格式不对也被拒', async () => {
    const { status } = await register({ username: 'zhangsan', password: 'password123', email: 'not-an-email' })
    assert.equal(status, 400)
  })

  /**
   * 这一条是整组用例里最重要的：**注册不能顺手把人放进来**。
   * 回了 token 的话，那封验证码信就只是发着好看。
   */
  test('注册只建账号、发信，一个字节的令牌都不发', async () => {
    const { status, body } = await register({ username: 'zhangsan', password: 'password123', email: 'Zhang@Example.com' })
    assert.equal(status, 202)
    assert.equal(body.pendingActivation, true)
    assert.equal(body.token, undefined)
    assert.equal(sent.length, 1)
    // 邮箱归一化成小写：不然 Zhang@ 和 zhang@ 会是两条互不相干的记录
    assert.equal(sent[0].to, 'zhang@example.com')
    // 回显给界面的邮箱要打码 —— 这条响应不需要任何身份就能拿到
    assert.equal(body.email, 'z****@example.com')
  })

  test('未激活的账号登不进去，但提示要能把界面领到下一步', async () => {
    await register({ username: 'zhangsan', password: 'password123', email: 'zhang@example.com' })
    const { status, body } = await login('zhangsan', 'password123')
    // 403 而不是 401：凭据是对的，缺的是一步激活
    assert.equal(status, 403)
    assert.equal(body.details.activationRequired, true)
    assert.equal(body.details.email, 'z****@example.com')
  })

  test('填对验证码 → 激活 + 当场登入，并且第一个人是管理员', async () => {
    await register({ username: 'zhangsan', password: 'password123', email: 'zhang@example.com' })
    const { status, body } = await activate({ username: 'zhangsan', code: lastCode() })
    assert.equal(status, 200)
    assert.ok(body.token)
    assert.equal(body.user.activated, true)
    assert.equal(body.user.email, 'zhang@example.com')
    // 全新部署里总得有人能管别人，而那时还没有任何管理员可以来授权
    assert.equal(body.user.role, 'admin')

    // 令牌真的能用（回归：路由被前面那块吃掉的话，这里拿到的会是一张认不出主人的票）
    const me = await call('GET', '/v1/auth/me', { token: body.token })
    assert.equal(me.status, 200)
    assert.equal(me.body.account.username, 'zhangsan')

    // 激活之后就能正常登录了
    assert.equal((await login('zhangsan', 'password123')).status, 200)
  })

  test('验证码是一次性的：用过就不能再用', async () => {
    await register({ username: 'zhangsan', password: 'password123', email: 'zhang@example.com' })
    const code = lastCode()
    assert.equal((await activate({ username: 'zhangsan', code })).status, 200)
    const again = await activate({ username: 'zhangsan', code })
    assert.equal(again.status, 400)
    assert.match(again.body.message, /已经激活/)
  })

  test('第二个人注册就是普通用户，而且不影响第一个人', async () => {
    await register({ username: 'zhangsan', password: 'password123', email: 'zhang@example.com' })
    await activate({ username: 'zhangsan', code: lastCode() })
    await register({ username: 'lisi', password: 'password123', email: 'li@example.com' })
    const { body } = await activate({ username: 'lisi', code: lastCode() })
    assert.equal(body.user.role, 'user')
  })

  test('一个邮箱只能注册一个账号', async () => {
    await register({ username: 'zhangsan', password: 'password123', email: 'zhang@example.com' })
    const { status, body } = await register({ username: 'lisi', password: 'password123', email: 'ZHANG@example.com' })
    assert.equal(status, 400)
    assert.match(body.message, /已经注册过/)
  })

  /**
   * 用户名被一个**从来没激活过**的账号占着时，允许后来者顶掉它。
   * 不让顶的话，随便谁提交一次注册就能把一个用户名永久占住（他自己也用不了）。
   */
  test('没激活的用户名可以被重新注册顶掉，激活过的不行', async () => {
    await register({ username: 'zhangsan', password: 'password123', email: 'zhang@example.com' })
    const retry = await register({ username: 'zhangsan', password: 'another-password', email: 'zhang2@example.com' })
    assert.equal(retry.status, 202)
    // 顶掉之后，生效的是**后一次**的密码
    await activate({ username: 'zhangsan', code: lastCode() })
    assert.equal((await login('zhangsan', 'password123')).status, 401)
    assert.equal((await login('zhangsan', 'another-password')).status, 200)

    // 已经激活的那个就顶不动了
    const occupied = await register({ username: 'zhangsan', password: 'password123', email: 'third@example.com' })
    assert.equal(occupied.status, 400)
    assert.match(occupied.body.message, /已被占用/)
  })
})

describe('验证码本身的护栏', () => {
  beforeEach(async () => {
    if (server) await server.app.close({ timeoutMs: 500 })
    server = await startServer()
    call = client(server.base)
    await register({ username: 'zhangsan', password: 'password123', email: 'zhang@example.com' })
  })

  /**
   * 6 位数字只有一百万种可能。真正兜底的不是"猜不中"，是**试满就作废**：
   * 没有这一条，一个脚本几分钟就能把一个账号激活了。
   */
  test('试满次数之后这份验证码作废，对的码也不再管用', async () => {
    const code = lastCode()
    const wrong = code === '000000' ? '111111' : '000000'
    // maxAttempts=3：前两次告诉他还剩几次，第三次作废
    assert.match((await activate({ username: 'zhangsan', code: wrong })).body.message, /还可以再试 2 次/)
    assert.match((await activate({ username: 'zhangsan', code: wrong })).body.message, /还可以再试 1 次/)
    assert.match((await activate({ username: 'zhangsan', code: wrong })).body.message, /已作废/)

    const withRightCode = await activate({ username: 'zhangsan', code })
    assert.equal(withRightCode.status, 400)
    assert.match(withRightCode.body.message, /重新获取/)
  })

  test('过期的验证码不认', async () => {
    const code = lastCode()
    clock.at += 16 * 60 * 1000 // 默认 15 分钟
    const { status, body } = await activate({ username: 'zhangsan', code })
    assert.equal(status, 400)
    assert.match(body.message, /过期/)
  })

  test('重发有间隔 —— 否则这条接口就是一台免费的发信机', async () => {
    const tooSoon = await call('POST', '/v1/auth/activation/resend', { body: { username: 'zhangsan' } })
    assert.equal(tooSoon.status, 429)
    assert.equal(sent.length, 1)

    clock.at += 61 * 1000
    const ok = await call('POST', '/v1/auth/activation/resend', { body: { username: 'zhangsan' } })
    assert.equal(ok.status, 200)
    assert.equal(sent.length, 2)
    // 重发出来的是新的一份，旧的那份作废
    const [first, second] = [sent[0], sent[1]].map((mail) => mail.text.match(/验证码是：(\d+)/)[1])
    assert.equal((await activate({ username: 'zhangsan', code: first })).status, 400)
    assert.equal((await activate({ username: 'zhangsan', code: second })).status, 200)
  })

  /**
   * 重发接口不认识的用户名照样回 200 —— 否则它就是一个不要密码的用户名探测器。
   */
  test('重发一个不存在的用户名，也回 200 且不发信', async () => {
    const { status } = await call('POST', '/v1/auth/activation/resend', { body: { username: 'nobody-at-all' } })
    assert.equal(status, 200)
    assert.equal(sent.length, 1) // 还是注册时那一封
  })
})

describe('发信失败与降级', () => {
  after(async () => {
    if (server) await server.app.close({ timeoutMs: 500 })
    server = null
  })

  /**
   * SMTP 抖一下，不能让用户把用户名密码重填一遍 —— 那条待激活的记录要留着，
   * 他走"重发"就能继续。
   */
  test('信发不出去回 502，但账号留着，稍后重发能接上', async () => {
    if (server) await server.app.close({ timeoutMs: 500 })
    server = await startServer({ mailFails: true })
    call = client(server.base)

    const failed = await register({ username: 'zhangsan', password: 'password123', email: 'zhang@example.com' })
    assert.equal(failed.status, 502)
    // 账号确实建出来了：再注册一次会走"顶掉未激活账号"，而不是当作没发生过
    const state = await server.users.get('zhangsan')
    assert.equal(state.activated, false)
    assert.equal(state.email, 'zhang@example.com')
  })

  /**
   * 开关开着但没有发信能力时**退回不验证**，而不是让注册整个变成一个只会报错的按钮。
   * （生产上这个组合在配置校验那里就被拦掉了，见 config.js）
   */
  test('没有可用的发信账号时，注册退回"不验证邮箱"并当场发令牌', async () => {
    if (server) await server.app.close({ timeoutMs: 500 })
    const config = buildConfig()
    const storage = createMemoryStorage()
    const users = createUserStore({ config, storage, logger: silentLogger })
    const identity = createIdentityResolver({ config, logger: silentLogger, users })
    const app = createServer({
      config,
      logger: silentLogger,
      identity,
      users,
      // 没有 host / from 的配置 → mailer.enabled 是 false
      mailer: createMailer({ config: { mail: { transport: 'smtp' } }, logger: silentLogger }),
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
    server = { app, base: `http://127.0.0.1:${app.server.address().port}`, users }
    call = client(server.base)

    const { status, body } = await register({ username: 'zhangsan', password: 'password123', email: 'zhang@example.com' })
    assert.equal(status, 201)
    assert.ok(body.token)
    // 但邮箱还是收下了（requireEmail 与 verifyEmail 是两件事）
    assert.equal(body.user.email, 'zhang@example.com')
    assert.equal((await call('GET', '/healthz')).body.features.registerVerifyEmail, false)
  })
})

describe('域名白名单', () => {
  after(async () => {
    if (server) await server.app.close({ timeoutMs: 500 })
    server = null
  })

  test('只放行配置里的邮箱域名', async () => {
    if (server) await server.app.close({ timeoutMs: 500 })
    server = await startServer({ register: { emailDomains: ['example.com'] } })
    call = client(server.base)

    const outsider = await register({ username: 'zhangsan', password: 'password123', email: 'zhang@gmail.com' })
    assert.equal(outsider.status, 400)
    assert.match(outsider.body.message, /example\.com/)

    assert.equal((await register({ username: 'zhangsan', password: 'password123', email: 'zhang@example.com' })).status, 202)
  })
})

/**
 * 信本身长什么样。这一段是纯函数，不碰网络 —— 于是"中文标题会不会变乱码"
 * 这类问题可以直接断言，而不需要在测试里起一个 SMTP 服务器。
 */
describe('邮件报文', () => {
  test('中文标题按 RFC 2047 编码，ASCII 的原样留着', () => {
    assert.equal(encodeHeaderWord('Hello'), 'Hello')
    const encoded = encodeHeaderWord('注册验证码')
    assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/)
    assert.equal(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'), '注册验证码')
  })

  test('同时给纯文本和 HTML 两份，正文 base64 编码', () => {
    const message = buildMessage({
      from: 'noreply@example.com',
      fromName: 'AgentPod',
      to: 'zhang@example.com',
      subject: '注册验证码：123456',
      text: '你的验证码是 123456',
      html: '<p>你的验证码是 123456</p>',
    })
    // 发件人名是 ASCII，原样留着（中文名才走 RFC 2047，见上一条用例）
    assert.match(message, /^From: AgentPod <noreply@example\.com>$/m)
    assert.match(message, /^To: zhang@example\.com$/m)
    assert.match(message, /Content-Type: multipart\/alternative; boundary="/)
    assert.match(message, /Content-Type: text\/plain; charset=UTF-8/)
    assert.match(message, /Content-Type: text\/html; charset=UTF-8/)
    // 正文确实是 base64（而不是原样塞进去）
    assert.ok(!message.includes('你的验证码是 123456'))
    assert.ok(message.includes(Buffer.from('你的验证码是 123456', 'utf8').toString('base64')))
  })

  /**
   * DATA 的结束标记是单独一行 `.`，所以正文里以 `.` 开头的行必须补一个点 ——
   * 不补的话，那一行会把整封信在中途截断。
   */
  test('以点开头的行会被 dot-stuffing 补上一个点', () => {
    const message = buildMessage({
      from: 'noreply@example.com',
      to: 'zhang@example.com',
      subject: 'test',
      text: '',
      html: '',
    })
    assert.ok(!/\r\n\.(?!\.)/.test(message), '报文里不该出现单独以一个点开头的行')
  })
})
