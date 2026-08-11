/**
 * 沙盒驻留与接管：让同一个会话的下一轮回到**同一个沙盒**。
 *
 * ── 守的是什么 ──────────────────────────────────────────────────────
 *
 * 租约释放不是删文件，是整个 slot 销毁重建。浏览器登录态、已装的依赖、后台进程
 * 每轮都要重来 —— "打开系统 → 翻到第二页 → 导出"这类连续任务在云端等于每轮
 * 从登录页开始。驻留（park）让 slot 活到下一轮，`resume()` 把它接回来。
 *
 * 这里的用例分两类，第二类才是重点：
 *   1. 顺路径能用（park → attach 拿回同一个租约、凭据跟着轮换）；
 *   2. **每一条失败路径都安静地退回今天的行为**。驻留是加速，不是依赖：
 *      worker 拒绝、租约被抢占、老版本没这个路由、并发撞车 —— 任何一种都不该
 *      让一轮对话失败，最多是这一轮要重新登录。
 *
 * 用假 worker，与 sandbox-keepalive.test.js 同一个路子。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createHttpSandbox } from '../src/sandbox/client.js'
import { createStickyLeases } from '../src/sandbox/sticky.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

const STATIC_TOKEN = 'park-static-token'

/**
 * 有状态的假 worker：租约表 + park/attach 状态机。
 * `parkMode` 模拟三种节点：正常 / 拒绝驻留（配额满）/ 老版本（没这个路由）。
 */
function createFakeWorker({ parkMode = 'ok' } = {}) {
  const leases = new Map()
  const calls = { created: 0, parked: 0, attached: 0, released: 0 }
  let seq = 0
  let base = ''

  const server = http.createServer(async (req, res) => {
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    // 计的是**尝试次数**，必须在租约查找之前 —— 租约已经没了正是最该数清楚的
    // 那种情况（"同一个作废句柄被反复拿去撞"就是靠这个数字发现的）
    if (req.url.endsWith('/attach')) calls.attached += 1
    const body = await new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch {
          resolve({})
        }
      })
    })

    if (req.method === 'POST' && req.url === '/v1/leases') {
      seq += 1
      calls.created += 1
      const lease = {
        leaseId: `lease_${seq}`,
        token: `tok-${seq}-a`,
        username: body.username || '',
        parked: false,
        browser: false,
      }
      leases.set(lease.leaseId, lease)
      return json(200, {
        ok: true,
        leaseId: lease.leaseId,
        leaseToken: lease.token,
        workerBase: base,
        idleTimeoutMs: 600000,
        features: { execAsync: false, leaseRenew: true },
        slots: { used: 1, total: 2 },
      })
    }

    const match = req.url.match(/^\/v1\/leases\/([a-z0-9_]+)(\/.*)?$/)
    if (!match) return json(404, { ok: false, error: 'not-found' })
    const lease = leases.get(match[1])
    const sub = match[2] || ''

    if (req.method === 'DELETE' && !sub) {
      calls.released += 1
      if (lease) leases.delete(lease.leaseId)
      return json(200, { ok: true, released: Boolean(lease) })
    }
    if (!lease) return json(404, { ok: false, error: 'lease-not-found-or-expired' })
    // 凭据必须对得上：轮换之后拿旧的来就该被挡住
    if (bearer !== lease.token && bearer !== STATIC_TOKEN) return json(401, { ok: false, error: 'unauthorized' })

    if (req.method === 'POST' && sub === '/park') {
      calls.parked += 1
      if (parkMode === 'no-route') return json(404, { ok: false, error: 'not-found', path: req.url })
      if (parkMode === 'refuse') return json(200, { ok: true, parked: false, reason: 'park-disabled' })
      lease.parked = true
      return json(200, { ok: true, parked: true, expiresAt: Date.now() + 600000 })
    }
    if (req.method === 'POST' && sub === '/attach') {
      if (body.username && lease.username && body.username !== lease.username) return json(403, { ok: false, error: 'username-mismatch' })
      if (!lease.parked) return json(409, { ok: false, error: 'lease-busy' })
      lease.parked = false
      lease.token = `${lease.token}-rotated`
      return json(200, {
        ok: true,
        leaseId: lease.leaseId,
        leaseToken: lease.token,
        workerBase: base,
        idleTimeoutMs: 600000,
        features: { execAsync: false, leaseRenew: true },
        browser: lease.browser,
        maxRemainingMs: 3 * 3600_000,
        parked: false,
      })
    }
    if (req.method === 'POST' && sub.startsWith('/browser/')) {
      // 只认真实存在的动作。别的一律 501 —— 模拟"这个节点没开浏览器能力"，
      // 那种情况下压根没有浏览器上下文，不该被算成"用过浏览器"。
      if (sub !== '/browser/open') return json(501, { ok: false, error: 'browser-disabled' })
      lease.browser = true
      return json(200, { ok: true })
    }
    if (req.method === 'POST' && sub === '/files') {
      return json(200, { ok: true, path: 'a.txt', bytes: 1 })
    }
    return json(404, { ok: false, error: 'not-found', path: req.url })
  })

  return {
    calls,
    leases,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      base = `http://127.0.0.1:${server.address().port}`
      return base
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function makeSandbox(url, overrides = {}) {
  return createHttpSandbox({
    config: {
      sandbox: { mode: 'http', url, token: STATIC_TOKEN, timeoutMs: 5000, keepalive: false, park: 'auto', ...overrides },
    },
    logger: silentLogger,
  })
}

describe('沙盒驻留：顺路径', () => {
  let worker
  let url
  let sandbox

  beforeEach(async () => {
    worker = createFakeWorker()
    url = await worker.listen()
    sandbox = makeSandbox(url)
  })

  afterEach(async () => {
    await worker.close()
  })

  /** 走一轮"用过浏览器"的 run */
  async function browserTurn(runId, sessionKey = 'main') {
    const session = sandbox.createSession({ runId, username: 'zhangsan', sessionKey })
    const resumed = await session.resume()
    await session.browserAction('open', { url: 'https://example.com' })
    return { session, resumed }
  }

  test('用过浏览器的一轮驻留下来，下一轮接回同一个租约', async () => {
    const first = await browserTurn('r1')
    assert.equal(first.resumed, null, '第一轮没有可接管的，应当照常懒申请')
    assert.equal(first.session.browserLive, true)
    assert.deepEqual(await first.session.finish({ park: true }), { parked: true })

    const second = await browserTurn('r2')
    assert.equal(second.resumed.attached, true)
    assert.equal(second.resumed.browser, true, '接管时必须报出浏览器还开着，否则模型会重新登录一遍')
    assert.ok(second.resumed.maxRemainingMs > 0)
    assert.equal(second.session.attached, true)
    await second.session.finish({ park: true })

    assert.equal(worker.calls.created, 1, '第二轮又新开了一个租约，驻留没有生效')
    assert.equal(worker.calls.attached, 1)
    assert.equal(worker.calls.released, 0)
  })

  test('接管之后凭据跟着轮换，第三轮用的是新的那一枚', async () => {
    // 粘性句柄在进程里躺着等下一轮，旧 token 的泄漏窗口比普通租约长得多。
    // 存回去的必须是 attach 之后那一枚，否则第三轮会拿一枚作废的凭据去打。
    const first = await browserTurn('r1')
    await first.session.finish({ park: true })
    const second = await browserTurn('r2')
    await second.session.finish({ park: true })

    const third = await browserTurn('r3')
    assert.equal(third.resumed.attached, true, '第三轮拿旧凭据被 401 了')
    await third.session.finish({ park: true })
    assert.equal(worker.calls.created, 1)
  })

  test('没用过浏览器的一轮照常释放（auto 的判据只有这一个）', async () => {
    const session = sandbox.createSession({ runId: 'r1', username: 'zhangsan', sessionKey: 'main' })
    await session.resume()
    await session.putFile({ path: 'a.txt', content: 'x' })
    assert.equal(session.browserLive, false)

    // run-turn 依据 browserLive 决定 park 与否；这里模拟它的判断结果
    await session.finish({ park: false })
    assert.equal(worker.calls.parked, 0)
    assert.equal(worker.calls.released, 1)
  })

  test('接管来的浏览器算数：这一轮只跑脚本也不会把它销毁', async () => {
    // 少了这一条，一个接管了浏览器却只跑了段脚本的轮次会把上一轮辛苦登好的
    // 浏览器直接关掉 —— 用户第三轮又要重新登录。
    const first = await browserTurn('r1')
    await first.session.finish({ park: true })

    const second = sandbox.createSession({ runId: 'r2', username: 'zhangsan', sessionKey: 'main' })
    const resumed = await second.resume()
    assert.equal(resumed.attached, true)
    await second.putFile({ path: 'a.txt', content: 'x' })
    assert.equal(second.browserLive, true, '接管过来时就开着的浏览器没被算进驻留判据')
  })

  test('不同会话各驻留各的，互不串号', async () => {
    const a = await browserTurn('r1', 'sess-a')
    await a.session.finish({ park: true })
    const b = await browserTurn('r2', 'sess-b')
    assert.equal(b.resumed, null, 'B 会话接管到了 A 会话的沙盒')
    await b.session.finish({ park: true })

    const a2 = await browserTurn('r3', 'sess-a')
    assert.equal(a2.resumed.attached, true)
    await a2.session.finish({ park: true })
    assert.equal(worker.calls.created, 2, '两个会话应该各有一个租约')
  })

  test('SANDBOX_PARK=off 时这条路径整个不存在', async () => {
    const off = makeSandbox(url, { park: 'off' })
    const session = off.createSession({ runId: 'r1', username: 'zhangsan', sessionKey: 'main' })
    assert.equal(await session.resume(), null)
    await session.browserAction('open', { url: 'https://example.com' })
    await session.finish({ park: true })
    assert.equal(worker.calls.parked, 0, '关掉了还在发驻留请求')
    assert.equal(worker.calls.released, 1)
  })
})

describe('沙盒驻留：失败路径一律退回今天的行为', () => {
  let worker
  let sandbox

  afterEach(async () => {
    if (worker) await worker.close()
    worker = null
  })

  async function setup(options) {
    worker = createFakeWorker(options)
    const url = await worker.listen()
    sandbox = makeSandbox(url)
    return url
  }

  test('worker 拒绝驻留（配额满）→ 退回释放，下一轮正常新建', async () => {
    await setup({ parkMode: 'refuse' })
    const first = sandbox.createSession({ runId: 'r1', username: 'zhangsan', sessionKey: 'main' })
    await first.resume()
    await first.browserAction('open', {})
    assert.deepEqual(await first.finish({ park: true }), { parked: false })
    assert.equal(worker.calls.released, 1, '驻留被拒了却没释放 —— 槽位泄漏')

    const second = sandbox.createSession({ runId: 'r2', username: 'zhangsan', sessionKey: 'main' })
    assert.equal(await second.resume(), null, '被拒之后不该还留着句柄')
  })

  test('老版本 worker 没有 /park 路由 → 安静退回释放', async () => {
    // 滚动发布期间新旧节点同时在线，这是**正常**路径，不该报错也不该丢槽位。
    await setup({ parkMode: 'no-route' })
    const session = sandbox.createSession({ runId: 'r1', username: 'zhangsan', sessionKey: 'main' })
    await session.resume()
    await session.browserAction('open', {})
    assert.deepEqual(await session.finish({ park: true }), { parked: false })
    assert.equal(worker.calls.released, 1)
  })

  test('驻留的租约被抢占（attach 404）→ 报 lost，本轮用新沙盒', async () => {
    await setup()
    const first = sandbox.createSession({ runId: 'r1', username: 'zhangsan', sessionKey: 'main' })
    await first.resume()
    await first.browserAction('open', {})
    await first.finish({ park: true })

    // 模拟被抢占 / 驻留超时：worker 侧那个租约已经不在了
    worker.leases.clear()

    const second = sandbox.createSession({ runId: 'r2', username: 'zhangsan', sessionKey: 'main' })
    const resumed = await second.resume()
    assert.deepEqual(resumed, { attached: false, lost: true }, '必须把"登录态没了"这件事讲出来')
    assert.equal(second.attached, false)

    // 而且本轮照常能干活：退回新建租约
    await second.putFile({ path: 'a.txt', content: 'x' })
    assert.equal(worker.calls.created, 2)
    await second.finish({ park: false })
  })

  test('接管失败之后句柄被清掉，第三轮不会再拿它去撞一次', async () => {
    await setup()
    const first = sandbox.createSession({ runId: 'r1', username: 'zhangsan', sessionKey: 'main' })
    await first.resume()
    await first.browserAction('open', {})
    await first.finish({ park: true })
    worker.leases.clear()

    const second = sandbox.createSession({ runId: 'r2', username: 'zhangsan', sessionKey: 'main' })
    await second.resume()
    await second.finish({ park: false })

    const third = sandbox.createSession({ runId: 'r3', username: 'zhangsan', sessionKey: 'main' })
    assert.equal(await third.resume(), null)
    assert.equal(worker.calls.attached, 1, '同一个已经没了的句柄被反复拿去 attach')
  })

  test('同会话两个 run 并发：第二个不驻留，也不覆盖第一个的句柄', async () => {
    // MAX_RUNS_PER_USER=2 允许同一用户并发两个 run，sessionKey 相同也可能。
    // 两个 run 进同一个 BrowserContext，表现是页面莫名其妙被另一边导航走。
    await setup()
    const a = sandbox.createSession({ runId: 'rA', username: 'zhangsan', sessionKey: 'main' })
    const b = sandbox.createSession({ runId: 'rB', username: 'zhangsan', sessionKey: 'main' })

    assert.equal(await b.resume(), null, '第二个 run 不该拿到认领权')
    await a.resume()
    await a.browserAction('open', {})
    await b.browserAction('open', {})

    await b.finish({ park: true })
    assert.equal(worker.calls.parked, 0, '没有认领权的 run 驻留了，会覆盖掉另一个 run 的句柄')
    await a.finish({ park: true })
    assert.equal(worker.calls.parked, 1)

    const next = sandbox.createSession({ runId: 'rC', username: 'zhangsan', sessionKey: 'main' })
    const resumed = await next.resume()
    assert.equal(resumed.attached, true, '接回来的应该是 A 驻留的那个')
    await next.finish({ park: false })
  })

  test('纯聊天的一轮不会误删上一轮驻留下来的句柄', async () => {
    // 这一条最容易漏：纯聊天的 run 压根没占过槽位，收尾时如果顺手把句柄
    // 清掉，worker 那边那个驻留的沙盒就变成没人认领的孤儿，白占一个 slot
    // 直到超时，而用户第三轮还是要重新登录。
    await setup()
    const first = sandbox.createSession({ runId: 'r1', username: 'zhangsan', sessionKey: 'main' })
    await first.resume()
    await first.browserAction('open', {})
    await first.finish({ park: true })

    // 第二轮：一个字都没让沙盒干（租约是懒申请的，这里连 resume 都不调，
    // 模拟调用方在拿到 hasSandbox=false 之类的分支时的行为）
    const chat = sandbox.createSession({ runId: 'r2', username: 'zhangsan', sessionKey: 'main' })
    const result = await chat.finish({ park: false })
    assert.equal(result.untouched, true)
    assert.equal(worker.calls.released, 0, '把上一轮驻留的沙盒释放掉了')

    const third = sandbox.createSession({ runId: 'r3', username: 'zhangsan', sessionKey: 'main' })
    const resumed = await third.resume()
    assert.equal(resumed.attached, true, '句柄被那一轮纯聊天顺手删掉了')
    await third.finish({ park: false })
  })

  test('浏览器动作失败时不算"用过浏览器"', async () => {
    // 501（节点没开浏览器）和 404（租约没了）都不该让这一轮去申请驻留：
    // 那种情况下压根没有浏览器上下文可留。
    await setup()
    const session = sandbox.createSession({ runId: 'r1', username: 'zhangsan', sessionKey: 'main' })
    await session.resume()
    await assert.rejects(() => session.browserAction('nope.not-a-route', {}))
    assert.equal(session.browserLive, false)
    await session.finish({ park: false })
  })

  test('release() 也会还回认领权，不然这个会话之后再也驻留不了', async () => {
    // 旧调用方走的是 release()。漏了还认领权的话，键永久锁死，
    // 驻留对这个会话悄悄失效，而日志里什么都看不到。
    await setup()
    const first = sandbox.createSession({ runId: 'r1', username: 'zhangsan', sessionKey: 'main' })
    await first.resume()
    await first.putFile({ path: 'a.txt', content: 'x' })
    await first.release()

    const second = sandbox.createSession({ runId: 'r2', username: 'zhangsan', sessionKey: 'main' })
    await second.resume()
    await second.browserAction('open', {})
    assert.deepEqual(await second.finish({ park: true }), { parked: true })
  })
})

describe('粘性句柄表', () => {
  test('第一个 run 拿到认领权，并发的第二个拿不到', () => {
    const sticky = createStickyLeases({ logger: silentLogger })
    const a = sticky.claim({ username: 'u1', sessionKey: 'main', runId: 'rA' })
    const b = sticky.claim({ username: 'u1', sessionKey: 'main', runId: 'rB' })
    assert.equal(a.owner, true)
    assert.equal(b.owner, false)
  })

  test('没有认领权就写不进去，覆盖不了别人的句柄', () => {
    const sticky = createStickyLeases({ logger: silentLogger })
    sticky.claim({ username: 'u1', sessionKey: 'main', runId: 'rA' })
    sticky.keep({ username: 'u1', sessionKey: 'main', runId: 'rA', handle: { leaseId: 'mine' } })

    // rB 从来没拿到过认领权
    sticky.keep({ username: 'u1', sessionKey: 'main', runId: 'rB', handle: { leaseId: 'theirs' } })
    const next = sticky.claim({ username: 'u1', sessionKey: 'main', runId: 'rC' })
    assert.equal(next.handle.leaseId, 'mine')
  })

  test('过期的句柄直接丢掉，不拿去换一个必然的 404', () => {
    const sticky = createStickyLeases({ logger: silentLogger })
    sticky.claim({ username: 'u1', sessionKey: 'main', runId: 'rA' })
    sticky.keep({ username: 'u1', sessionKey: 'main', runId: 'rA', handle: { leaseId: 'x', expiresAt: Date.now() - 1 } })

    const next = sticky.claim({ username: 'u1', sessionKey: 'main', runId: 'rB' })
    assert.equal(next.owner, true)
    assert.equal(next.handle, null)
  })

  test('username 与 sessionKey 拼键不会撞车', () => {
    // `a:b` + `c` 和 `a` + `b:c` 撞在一起就是串号 —— 两个人共用一个沙盒。
    const sticky = createStickyLeases({ logger: silentLogger })
    sticky.claim({ username: 'a', sessionKey: 'b c', runId: 'r1' })
    sticky.keep({ username: 'a', sessionKey: 'b c', runId: 'r1', handle: { leaseId: 'one' } })
    const other = sticky.claim({ username: 'a b', sessionKey: 'c', runId: 'r2' })
    assert.equal(other.handle, null)
  })

  test('表满了淘汰最老的，不无界增长', () => {
    const sticky = createStickyLeases({ logger: silentLogger, maxEntries: 2 })
    for (const key of ['s1', 's2', 's3']) {
      sticky.claim({ username: 'u1', sessionKey: key, runId: 'r' })
      sticky.keep({ username: 'u1', sessionKey: key, runId: 'r', handle: { leaseId: key } })
    }
    assert.ok(sticky.size() <= 2)
  })
})
