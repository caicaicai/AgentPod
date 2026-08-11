/**
 * 租约保活：agent 持有租约期间周期性续期。
 *
 * worker 侧已经做到"活跃即续"（每个租约内请求都把到期时刻往后滑），但那只覆盖
 * 得住**一直在发请求**的情况。一轮里模型长思考、或本地在跑不经沙盒的逻辑时，
 * 沙盒会安静十几分钟，正好撞上 idle 回收 —— 用户回来时工作区已经没了。
 *
 * 用**假 worker**，不建真 namespace：这里测的是客户端的保活行为，
 * 与隔离无关，不该跟着那些 Linux-only 的用例一起被跳过。
 *
 * setInterval 是 mock 的，否则最短续期周期是 30 秒，一条用例就要跑半分钟。
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createHttpSandbox } from '../src/sandbox/client.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

const STATIC_TOKEN = 'keepalive-static-token'

/**
 * 只实现保活这条路径要用到的端点。
 * `renewMode` 模拟三种 worker：正常 / 老版本（没有这个路由）/ 租约已被回收。
 */
function createFakeWorker({ idleTimeoutMs = 600000, renewMode = 'ok' } = {}) {
  const renews = []
  let base = ''

  /**
   * 等一次真实的续期请求落地。
   *
   * 不能用"空转若干个 setImmediate"当同步原语 —— 那取决于事件循环里恰好排了
   * 多少个任务，在 macOS 上凑巧够、在 Linux 上就不够，表现是同一份代码换台机器
   * 就红。这里由服务端在**处理完请求之后**主动通知，与平台无关。
   */
  let waiters = []
  function notifyRenew() {
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve()
  }
  function nextRenew(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等续期请求超时')), timeoutMs)
      waiters.push(() => { clearTimeout(timer); resolve() })
    })
  }

  const server = http.createServer((req, res) => {
    const json = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body)
    }
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')

    if (req.method === 'POST' && req.url === '/v1/leases') {
      return json(200, {
        ok: true,
        leaseId: 'lease_fake0000',
        leaseToken: 'lease-scoped-token-xyz',
        workerBase: base,
        expiresAt: Date.now() + idleTimeoutMs,
        hardExpiresAt: Date.now() + 4 * 3600_000,
        idleTimeoutMs,
        slots: { used: 1, total: 2 },
      })
    }
    if (req.method === 'POST' && req.url === '/v1/leases/lease_fake0000/renew') {
      renews.push({ auth })
      if (renewMode === 'no-route') json(404, { ok: false, error: 'not-found', path: req.url })
      else if (renewMode === 'gone') json(404, { ok: false, error: 'lease-not-found-or-expired' })
      else json(200, { ok: true, leaseId: 'lease_fake0000', expiresAt: Date.now() + idleTimeoutMs, remainingMs: idleTimeoutMs })
      // 客户端拿到响应后还要处理（可能要停掉保活），给它一个微任务周期落地
      return setImmediate(notifyRenew)
    }
    if (req.method === 'POST' && req.url === '/v1/leases/lease_fake0000/files') {
      return json(200, { ok: true, path: 'a.txt', bytes: 1 })
    }
    if (req.method === 'DELETE' && req.url === '/v1/leases/lease_fake0000') {
      return json(200, { ok: true, released: true })
    }
    return json(404, { ok: false, error: 'not-found', path: req.url })
  })

  return {
    renews,
    nextRenew,
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
      sandbox: {
        mode: 'http',
        url,
        token: STATIC_TOKEN,
        timeoutMs: 5000,
        keepalive: true,
        ...overrides,
      },
    },
    logger: silentLogger,
  })
}

/**
 * 真实等待一小段时间。
 *
 * 只用在**否定断言**上（"接下来不该再有续期"）—— 那种断言没有可等的事件，
 * 只能等一会儿再看。setInterval 是 mock 的，setTimeout 不是，所以这里是真的等。
 */
const quiet = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

describe('沙盒租约保活', () => {
  let worker
  let url

  beforeEach(async () => {
    // 只 mock setInterval：fetch 内部依赖真实的 setTimeout，一起 mock 掉会让请求永远超时
    mock.timers.enable({ apis: ['setInterval'] })
  })

  afterEach(async () => {
    mock.timers.reset()
    if (worker) await worker.close()
    worker = null
  })

  async function openSession(workerOptions = {}, sandboxOverrides = {}) {
    worker = createFakeWorker(workerOptions)
    url = await worker.listen()
    const session = makeSandbox(url, sandboxOverrides).createSession({ runId: 'r1', username: 'zhangsan' })
    // 租约是懒申请的：先做一次真实操作把它拿到手
    await session.putFile({ path: 'a.txt', content: 'x' })
    return session
  }

  test('持有租约期间会周期性续期', async () => {
    const session = await openSession({ idleTimeoutMs: 600000 })
    assert.equal(worker.renews.length, 0, '刚拿到租约就续期是多余的')

    // 周期 = 下发窗口的三分之一 = 200s
    let seen = worker.nextRenew()
    mock.timers.tick(200_000)
    await seen
    assert.equal(worker.renews.length, 1)

    seen = worker.nextRenew()
    mock.timers.tick(200_000)
    await seen
    assert.equal(worker.renews.length, 2)

    await session.release()
  })

  test('续期节奏跟着 worker 下发的窗口走，不是硬编码', async () => {
    // 窗口缩到 90s，周期就该是 30s。两边各存一份的话，worker 改了配置而 agent
    // 没改，现象是租约在 agent 眼里"莫名其妙提前没了"，两边日志都正常。
    const session = await openSession({ idleTimeoutMs: 90_000 })
    const seen = worker.nextRenew()
    mock.timers.tick(30_000)
    await seen
    assert.equal(worker.renews.length, 1)
    await session.release()
  })

  test('续期用的是租约级凭据，不是长期静态 token', async () => {
    const session = await openSession()
    const seen = worker.nextRenew()
    mock.timers.tick(200_000)
    await seen
    assert.equal(worker.renews[0].auth, 'lease-scoped-token-xyz')
    assert.notEqual(worker.renews[0].auth, STATIC_TOKEN)
    await session.release()
  })

  test('release 之后不再续期 —— 否则槽位永远收不回来', async () => {
    const session = await openSession()
    await session.release()
    mock.timers.tick(200_000 * 5)
    await quiet()
    assert.equal(worker.renews.length, 0)
  })

  test('老版本 worker 没有续期路由：只停掉保活，不当成"租约没了"反复重试', async () => {
    // 滚动发布期间两种 worker 会同时在线。不区分路由级 404 和租约级 404 的话，
    // 日志里会每分钟刷一条误导性的"租约被回收了"。
    const session = await openSession({ renewMode: 'no-route' })
    const seen = worker.nextRenew()
    mock.timers.tick(200_000)
    await seen
    await quiet()
    assert.equal(worker.renews.length, 1)

    mock.timers.tick(200_000 * 5)
    await quiet()
    assert.equal(worker.renews.length, 1, '应当已经停止保活')
    await session.release()
  })

  test('租约确实被回收后停止保活', async () => {
    const session = await openSession({ renewMode: 'gone' })
    const seen = worker.nextRenew()
    mock.timers.tick(200_000)
    await seen
    await quiet()
    assert.equal(worker.renews.length, 1)

    mock.timers.tick(200_000 * 5)
    await quiet()
    assert.equal(worker.renews.length, 1)
    await session.release()
  })

  test('SANDBOX_KEEPALIVE=0 时完全不发续期', async () => {
    const session = await openSession({}, { keepalive: false })
    mock.timers.tick(200_000 * 5)
    await quiet()
    assert.equal(worker.renews.length, 0)
    await session.release()
  })
})
