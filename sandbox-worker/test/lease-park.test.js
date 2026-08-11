/**
 * 租约的第三种结局：驻留（park）与接管（attach）。
 *
 * 守的是这么一件事：连续型任务（浏览器是典型）里，释放不是"删掉临时文件"，
 * 而是整个 slot 销毁重建 —— 登录态、已装依赖、后台进程全没，用户下一轮只能
 * 从登录页重来。驻留让 slot 活到下一轮，代价是它在那期间**占着容量不干活**。
 *
 * 所以这里一半的用例守的不是"驻留能用"，而是**驻留不会伤到容量**：
 * 可被抢占、有每人上限、窗口比 idle 短、推不过硬顶。这四条任何一条破了，
 * 现象都是"池子莫名其妙满了"，而占着的那些看上去全都健康。
 *
 * 与 lease-lifetime.test.js 同样用**假 slot 池**：这些全是时间算术与状态机，
 * 没有一条依赖 Linux 内核特性，不该被关进需要 CAP_SYS_ADMIN 的 suite 里。
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../src/config.js'
import { createLeaseManager } from '../src/leases.js'
import { createServer } from '../src/server.js'
import { createEgressPolicyStore } from '../src/egress-policy.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

/** 记下日志，用来断言"回收原因"这类只在日志里可见的事实 */
function recordingLogger() {
  const lines = []
  const logger = {
    lines,
    info: (msg, meta) => lines.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => lines.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => lines.push({ level: 'error', msg, meta }),
    debug() {},
    child() { return logger },
  }
  return logger
}

function fakeSlotPool(total = 1) {
  const free = Array.from({ length: total }, (_, index) => index)
  const released = []
  return {
    released,
    acquire() {
      const index = free.shift()
      if (index === undefined) return null
      return {
        index,
        hostWorkspace: { workDir: `/tmp/fake/${index}/work`, baseDir: `/tmp/fake/${index}`, homeDir: `/tmp/fake/${index}/home`, tmpDir: `/tmp/fake/${index}/tmp` },
        guest: { workDir: '/work', homeDir: '/home/job', tmpDir: '/tmp' },
      }
    },
    async release(index) {
      released.push(index)
      free.push(index)
    },
    status: () => ({ slots: [], egress: { extraAllowed: [] } }),
  }
}

const TOKEN = 'park-test-token-0123456789'

function makeConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    SANDBOX_TOKEN: TOKEN,
    SANDBOX_SLOTS: '1',
    SANDBOX_ADVERTISE_BASE: 'http://127.0.0.1:0',
    LEASE_IDLE_TIMEOUT_MS: String(10 * 60 * 1000),
    LEASE_TTL_MS: String(30 * 60 * 1000),
    LEASE_MAX_LIFETIME_MS: String(4 * 60 * 60 * 1000),
    LEASE_PARK_TTL_MS: String(10 * 60 * 1000),
    LEASE_PARK_GRACE_MS: String(60 * 1000),
    ...overrides,
  })
}

describe('驻留：配置校验', () => {
  test('驻留窗口比 idle 还长 → 拒绝启动', () => {
    // 一个**没人在用**的租约不该比正在用的活得久。配反了不会报错，
    // 只会让驻留变成"占着 slot 又收不回来"，而那正是这个功能唯一不能出的事故。
    assert.throws(
      () => makeConfig({ LEASE_PARK_TTL_MS: String(11 * 60 * 1000) }),
      /LEASE_PARK_TTL_MS/,
    )
  })

  test('抢占保护窗盖满整个驻留窗口 → 拒绝启动', () => {
    // 保护窗 ≥ 驻留窗口时，驻留租约在它活着的每一刻都受保护、永远抢不动，
    // 池子满了就只能干等 —— 抢占这条兜底等于不存在。
    assert.throws(
      () => makeConfig({ LEASE_PARK_TTL_MS: '60000', LEASE_PARK_GRACE_MS: '60000' }),
      /LEASE_PARK_GRACE_MS/,
    )
  })

  test('MAX_PARKED_PER_USER=0 是合法的：等于在这个节点上关掉驻留', () => {
    const config = makeConfig({ MAX_PARKED_PER_USER: '0' })
    assert.equal(config.lease.maxParkedPerUser, 0)
  })
})

describe('驻留：状态机', () => {
  const built = []

  function makeManager({ slots = 1, logger = silentLogger, overrides = {} } = {}) {
    const config = makeConfig(overrides)
    const pool = fakeSlotPool(slots)
    const manager = createLeaseManager({ config, logger, slotPool: pool })
    built.push(manager)
    return { config, pool, manager }
  }

  /** 只 mock Date：release 在有命令在跑时要等一个真的 kill 宽限期 */
  function freezeClock() {
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  }

  afterEach(async () => {
    for (const manager of built.splice(0)) await manager.releaseAll('test')
    mock.timers.reset()
  })

  test('驻留把到期时刻**缩短**到驻留窗口，而不是延长', async () => {
    // 这里有个容易写错的地方：extend() 只会把到期时刻往后推，用它来设驻留窗口
    // 的话，上一轮活动滑出来的那个更晚的 expiresAt 会继续生效 ——
    // 驻留就成了"白送 30 分钟"。必须直接赋值。
    freezeClock()
    const { manager, config } = makeManager()
    const lease = await manager.acquire({ runId: 'r', username: 'u1' })
    const before = lease.expiresAt

    const result = await manager.park(lease)
    assert.equal(result.parked, true)
    assert.ok(lease.expiresAt < before, '驻留之后到期时刻反而更晚了')
    assert.equal(lease.expiresAt, Date.now() + config.lease.parkTtlMs)
  })

  test('驻留不回收 slot，也不关浏览器 —— 这正是它存在的理由', async () => {
    const { manager, pool } = makeManager()
    const lease = await manager.acquire({ runId: 'r', username: 'u1' })
    let browserClosed = false
    lease.browser = { close: async () => { browserClosed = true } }

    await manager.park(lease)
    assert.deepEqual(pool.released, [], 'slot 被回收了，驻留就没有意义了')
    assert.equal(browserClosed, false, '浏览器被关了，下一轮还是要重新登录')
    assert.equal(manager.get(lease.leaseId)?.browser != null, true)

    // 真正释放时照旧要关
    await manager.release(lease.leaseId)
    assert.equal(browserClosed, true, '释放时浏览器上下文必须关掉：里面有用户登录态')
    assert.deepEqual(pool.released, [0])
  })

  test('驻留会中止本轮还在跑的命令', async () => {
    // 一轮已经结束了，不该有命令继续往一个没人在看的流里写。
    // 这一条与 release 保持一致，不是新语义。
    const { manager } = makeManager()
    const lease = await manager.acquire({ runId: 'r', username: 'u1' })
    const controller = new AbortController()
    lease.running.add(controller)

    await manager.park(lease)
    assert.equal(controller.signal.aborted, true)
    lease.running.clear() // 免得 afterEach 的 release 去等 kill 宽限期
  })

  test('驻留超时被清扫回收，日志里与 idle / 硬顶分得开', async () => {
    // 三种到期说的是三件不同的事。混在一起就调不动 TTL —— 分不清 parked-idle
    // 的比例，改窗口就是瞎猜。
    const logger = recordingLogger()
    const { manager, config, pool } = makeManager({ logger })
    const lease = await manager.acquire({ runId: 'r', username: 'u1' })
    await manager.park(lease)

    assert.equal(await manager.sweep(lease.expiresAt - 1), 0)
    assert.equal(await manager.sweep(lease.expiresAt + 1), 1)
    assert.equal(manager.count(), 0, '驻留的租约永远收不回来 = 槽位泄漏')
    assert.deepEqual(pool.released, [0])

    const recycled = logger.lines.find((line) => line.meta?.reason === 'parked-idle')
    assert.ok(recycled, '回收原因不是 parked-idle，运维分不清是谁没回来还是 agent 崩了')
    // 用户没在窗口内回来是**预期内**的结局，不是事故
    assert.equal(recycled.level, 'info')
    assert.ok(config.lease.parkTtlMs <= config.lease.idleTimeoutMs)
  })

  test('驻留中的租约，零星请求只滑驻留窗口，滑不到 idle 窗口', async () => {
    // 崩掉的 agent 留下的重试、走岔的保活请求都会经过 get()。按 idle 续的话，
    // 一个没人用的 slot 能靠噪声一直续下去，"驻留比 idle 短"当场作废。
    freezeClock()
    const { manager, config } = makeManager()
    const lease = await manager.acquire({ runId: 'r', username: 'u1' })
    await manager.park(lease)

    mock.timers.tick(60 * 1000)
    manager.get(lease.leaseId)
    assert.equal(lease.expiresAt, Date.now() + config.lease.parkTtlMs)
    assert.ok(lease.expiresAt < Date.now() + config.lease.idleTimeoutMs + 1)
  })

  test('驻留中显式续期也封在驻留窗口里', async () => {
    freezeClock()
    const { manager, config } = makeManager()
    const lease = await manager.acquire({ runId: 'r', username: 'u1' })
    await manager.park(lease)

    manager.renew(lease, { extendMs: config.lease.ttlMs })
    assert.ok(
      lease.expiresAt <= Date.now() + config.lease.parkTtlMs,
      '一个已经结束的 run 买到了在用租约的续期额度',
    )
  })

  test('快撞硬顶时拒绝驻留 —— 留下来也活不到下一轮', async () => {
    freezeClock()
    const { manager } = makeManager({
      overrides: {
        LEASE_TTL_MS: '60000',
        LEASE_IDLE_TIMEOUT_MS: '60000',
        LEASE_MAX_LIFETIME_MS: '60000',
        LEASE_PARK_TTL_MS: '30000',
        LEASE_PARK_GRACE_MS: '20000',
      },
    })
    const lease = await manager.acquire({ runId: 'r', username: 'u1' })
    mock.timers.tick(45_000) // 距硬顶只剩 15s，比保护窗还短

    const result = await manager.park(lease)
    assert.equal(result.parked, false)
    assert.equal(result.reason, 'max-lifetime-near')
  })

  test('MAX_PARKED_PER_USER=0 时直接拒绝驻留', async () => {
    const { manager } = makeManager({ overrides: { MAX_PARKED_PER_USER: '0' } })
    const lease = await manager.acquire({ runId: 'r', username: 'u1' })
    const result = await manager.park(lease)
    assert.equal(result.parked, false)
    assert.equal(result.reason, 'park-disabled')
  })

  test('每人驻留上限：第二个会话顶掉自己最老的那个', async () => {
    // 没有这条，一个人开五个会话就能长期占住五个 slot。
    const { manager } = makeManager({ slots: 2 })
    const first = await manager.acquire({ runId: 'r1', username: 'u1' })
    await manager.park(first)
    const second = await manager.acquire({ runId: 'r2', username: 'u1' })
    await manager.park(second)

    assert.equal(manager.get(first.leaseId), null, '同一个人驻留了两个租约')
    assert.ok(manager.get(second.leaseId), '顶掉的应该是最老的那个')
    assert.equal(manager.parkedCount(), 1)
  })

  test('顶的是自己最老的，不动别人的', async () => {
    const { manager } = makeManager({ slots: 2 })
    const other = await manager.acquire({ runId: 'r1', username: 'u2' })
    await manager.park(other)
    const mine = await manager.acquire({ runId: 'r2', username: 'u1' })
    await manager.park(mine)

    assert.ok(manager.get(other.leaseId), '一个人的连续会话不该以别人的槽位为代价')
    assert.ok(manager.get(mine.leaseId))
  })
})

describe('驻留：抢占', () => {
  const built = []

  function makeManager({ slots = 1, logger = silentLogger } = {}) {
    const config = makeConfig()
    const pool = fakeSlotPool(slots)
    const manager = createLeaseManager({ config, logger, slotPool: pool })
    built.push(manager)
    return { config, pool, manager }
  }

  afterEach(async () => {
    for (const manager of built.splice(0)) await manager.releaseAll('test')
    mock.timers.reset()
  })

  test('池子满了就顶掉最老的驻留租约 —— 驻留对容量是零伤害的前提', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
    const { manager, config } = makeManager({ slots: 1 })
    const parked = await manager.acquire({ runId: 'r1', username: 'u1' })
    await manager.park(parked)
    mock.timers.tick(config.lease.parkGraceMs + 1)

    const fresh = await manager.acquire({ runId: 'r2', username: 'u2' })
    assert.ok(fresh, '有驻留租约可以顶掉时，新申请不该被拒 —— 那等于让人排队等一个没人用的 slot')
    assert.equal(manager.get(parked.leaseId), null)
    assert.equal(manager.count(), 1)
  })

  test('保护窗内不抢占：刚驻留下来就被顶掉，比不做驻留更难解释', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
    const { manager, config } = makeManager({ slots: 1 })
    const parked = await manager.acquire({ runId: 'r1', username: 'u1' })
    await manager.park(parked)
    mock.timers.tick(config.lease.parkGraceMs - 1000)

    const fresh = await manager.acquire({ runId: 'r2', username: 'u2' })
    assert.equal(fresh, null, '保护窗内的驻留租约被抢走了')
    assert.ok(manager.get(parked.leaseId))
  })

  test('没有驻留租约时行为完全不变：满了就是满了', async () => {
    const { manager } = makeManager({ slots: 1 })
    await manager.acquire({ runId: 'r1', username: 'u1' })
    assert.equal(await manager.acquire({ runId: 'r2', username: 'u2' }), null)
  })

  test('先顶最老的那个', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
    const { manager, config } = makeManager({ slots: 2 })
    const older = await manager.acquire({ runId: 'r1', username: 'u1' })
    await manager.park(older)
    mock.timers.tick(1000)
    const newer = await manager.acquire({ runId: 'r2', username: 'u2' })
    await manager.park(newer)
    mock.timers.tick(config.lease.parkGraceMs + 1)

    await manager.acquire({ runId: 'r3', username: 'u3' })
    assert.equal(manager.get(older.leaseId), null)
    assert.ok(manager.get(newer.leaseId), '抢占顺序不是 LRU')
  })

  test('驻留的租约照常计入 per-user 配额', async () => {
    // 不算进去等于开了个口子：一个人可以一边驻留一边申请，占满池子还不超配额。
    const { manager } = makeManager({ slots: 2 })
    const lease = await manager.acquire({ runId: 'r1', username: 'u1' })
    await manager.park(lease)
    assert.equal(manager.countByUser().u1, 1)
    assert.equal(manager.parkedCount(), 1)
  })
})

describe('驻留：接管', () => {
  const built = []

  function makeManager({ slots = 1 } = {}) {
    const config = makeConfig()
    const pool = fakeSlotPool(slots)
    const manager = createLeaseManager({ config, logger: silentLogger, slotPool: pool })
    built.push(manager)
    return { config, pool, manager }
  }

  afterEach(async () => {
    for (const manager of built.splice(0)) await manager.releaseAll('test')
    mock.timers.reset()
  })

  test('接管清掉驻留状态，窗口回到 idle', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
    const { manager, config } = makeManager()
    const lease = await manager.acquire({ runId: 'r1', username: 'u1' })
    await manager.park(lease)

    const view = manager.attach(lease, { runId: 'r2' })
    assert.equal(view.parked, false)
    assert.equal(lease.runId, 'r2', 'runId 没换，trace 会指向一次已经结束的 run')
    assert.equal(lease.expiresAt, Date.now() + config.lease.idleTimeoutMs)
    assert.equal(manager.parkedCount(), 0)
  })

  test('接管轮换凭据：旧的立刻作废', async () => {
    // 粘性句柄在调用方那儿躺十几分钟等下一轮，旧 token 的泄漏窗口比普通租约
    // 长得多。attach 是唯一一个能顺手换掉它的时刻，代价是零。
    const { manager } = makeManager()
    const lease = await manager.acquire({ runId: 'r1', username: 'u1' })
    const old = lease.leaseToken
    await manager.park(lease)

    const view = manager.attach(lease, { runId: 'r2' })
    assert.notEqual(view.leaseToken, old)
    assert.equal(view.leaseToken, lease.leaseToken)
  })

  test('接管保住浏览器上下文，并把这件事讲给调用方', async () => {
    // 调用方要靠这个字段决定系统提示里写"登录态还在"还是"已经没了"。
    const { manager } = makeManager()
    const lease = await manager.acquire({ runId: 'r1', username: 'u1' })
    lease.browser = { close: async () => {} }
    await manager.park(lease)

    const view = manager.attach(lease, { runId: 'r2' })
    assert.equal(view.browser, true)
    assert.ok(view.maxRemainingMs > 0)
  })
})

describe('驻留：HTTP 面', () => {
  let config
  let manager
  let app
  let baseUrl

  const auth = () => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' })

  beforeEach(async () => {
    config = makeConfig()
    manager = createLeaseManager({ config, logger: silentLogger, slotPool: fakeSlotPool(2) })
    app = createServer({
      config, logger: silentLogger, leaseManager: manager, slotPool: fakeSlotPool(2),
      egressPolicy: createEgressPolicyStore({ config, logger: silentLogger }),
    })
    const address = await app.listen(0)
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await manager.releaseAll('test')
    await app.close()
  })

  async function open(username = 'u1') {
    const res = await fetch(`${baseUrl}/v1/leases`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ runId: 'r1', username }),
    })
    return res.json()
  }

  const park = (leaseId, token) => fetch(`${baseUrl}/v1/leases/${leaseId}/park`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

  const attach = (leaseId, token, body = {}) => fetch(`${baseUrl}/v1/leases/${leaseId}/attach`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  test('park → attach 一个来回，拿回同一个租约', async () => {
    const lease = await open()
    const parked = await park(lease.leaseId, lease.leaseToken).then((r) => r.json())
    assert.equal(parked.parked, true)

    const res = await attach(lease.leaseId, lease.leaseToken, { runId: 'r2', username: 'u1' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.leaseId, lease.leaseId)
    assert.equal(body.parked, false)
    assert.equal(body.idleTimeoutMs, config.lease.idleTimeoutMs)
    // 能力声明必须一起回：少一个字段，调用方会退回同步流，而它其实支持续传
    assert.equal(body.features.execAsync, true)
  })

  test('接管之后旧凭据立刻失效', async () => {
    const lease = await open()
    await park(lease.leaseId, lease.leaseToken)
    await attach(lease.leaseId, lease.leaseToken, { runId: 'r2', username: 'u1' })

    const res = await attach(lease.leaseId, lease.leaseToken, { runId: 'r3', username: 'u1' })
    assert.equal(res.status, 401)
  })

  test('username 对不上一律拒绝 —— 别人的沙盒里有别人的登录态', async () => {
    const lease = await open('u1')
    await park(lease.leaseId, lease.leaseToken)

    const res = await attach(lease.leaseId, lease.leaseToken, { runId: 'r2', username: 'someone-else' })
    assert.equal(res.status, 403)
  })

  test('没在驻留的租约不能被接管：另一个 run 正用着它', async () => {
    // 同一用户允许并发两个 run，sessionKey 相同也可能。两个 run 进同一个
    // BrowserContext，表现是页面莫名其妙被另一边导航走。
    const lease = await open()
    const res = await attach(lease.leaseId, lease.leaseToken, { runId: 'r2', username: 'u1' })
    assert.equal(res.status, 409)
  })

  test('已经被回收的租约接管回 404，调用方据此退回新建', async () => {
    const lease = await open()
    await park(lease.leaseId, lease.leaseToken)
    await manager.release(lease.leaseId)

    const res = await attach(lease.leaseId, lease.leaseToken, { runId: 'r2', username: 'u1' })
    assert.equal(res.status, 404)
  })

  test('驻留被拒时回 200 + parked:false，不是 4xx', async () => {
    // 调用方对"被拒"的处理是**退回释放**，那是正常分支不是错误。
    // 回 4xx 只会让它去重试一件不该重试的事。
    const denied = createLeaseManager({
      config: makeConfig({ MAX_PARKED_PER_USER: '0' }),
      logger: silentLogger,
      slotPool: fakeSlotPool(1),
    })
    const server = createServer({
      config, logger: silentLogger, leaseManager: denied, slotPool: fakeSlotPool(1),
      egressPolicy: createEgressPolicyStore({ config, logger: silentLogger }),
    })
    const address = await server.listen(0)
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/leases`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ runId: 'r1', username: 'u1' }),
      })
      const lease = await res.json()
      const parked = await fetch(`http://127.0.0.1:${address.port}/v1/leases/${lease.leaseId}/park`, {
        method: 'POST', headers: auth(), body: '{}',
      })
      assert.equal(parked.status, 200)
      assert.equal((await parked.json()).parked, false)
    } finally {
      await denied.releaseAll('test')
      await server.close()
    }
  })

  test('占用表把驻留标出来：等用户回来和 agent 崩了是两种处置', async () => {
    const lease = await open()
    await park(lease.leaseId, lease.leaseToken)

    const res = await fetch(`${baseUrl}/v1/admin/occupancy`, { headers: auth() })
    const body = await res.json()
    const row = body.occupancy.find((item) => item.leaseId === lease.leaseId)
    assert.equal(row.parked, true)
    assert.ok(row.parkedAt > 0)
  })

  test('探针报出驻留数：池子"满了"是都在跑还是一半在等人', async () => {
    const lease = await open()
    await park(lease.leaseId, lease.leaseToken)

    const body = await fetch(`${baseUrl}/healthz`).then((r) => r.json())
    assert.equal(body.leases, 1)
    assert.equal(body.parkedLeases, 1)
  })
})
