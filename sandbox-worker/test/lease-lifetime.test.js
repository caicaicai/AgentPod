/**
 * 租约的时限模型：到期、滑动续期、硬顶。
 *
 * 这里守的是一个**曾经真实存在的故障**：`expiresAt` 从前是从创建那一刻算死的
 * 绝对墙，一个正干着活的会话跑到第 30 分钟会被 sweep 直接回收，slot 销毁重建，
 * 工作区连同用户还没取走的产物一起消失。现象是"用着用着沙盒就没了"，
 * 而日志里只有一条平平无奇的"回收未主动释放的租约"。
 *
 * 用**假 slot 池**，不建真 namespace：时限是纯粹的时间算术，没有任何一条依赖
 * Linux 内核特性。放进那个需要 CAP_SYS_ADMIN 的 suite 里，等于让这些用例在
 * 开发机上永远跳过 —— 而它们恰恰是最该每次都跑的。
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../src/config.js'
import { createLeaseManager } from '../src/leases.js'
import { createServer } from '../src/server.js'
import { createEgressPolicyStore } from '../src/egress-policy.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

/**
 * 只实现 leases.js / server.js 真正会碰的那几个方法。
 * acquire 回一个形状对得上的 slot，release 记一笔就够 —— 本文件不关心隔离，
 * 只关心"租约什么时候该死、什么时候不该死"。
 */
function fakeSlotPool(total = 2) {
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

const TOKEN = 'lease-test-token-0123456789'

/** 有意用生产默认值的量级：时限之间的**比例**关系本身就是被测对象。 */
function makeConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    SANDBOX_TOKEN: TOKEN,
    SANDBOX_SLOTS: '2',
    SANDBOX_ADVERTISE_BASE: 'http://127.0.0.1:0',
    LEASE_IDLE_TIMEOUT_MS: String(10 * 60 * 1000),
    LEASE_TTL_MS: String(30 * 60 * 1000),
    LEASE_MAX_LIFETIME_MS: String(4 * 60 * 60 * 1000),
    ...overrides,
  })
}

describe('租约时限：配置校验', () => {
  test('滑动窗口比单次续期上限还长 → 拒绝启动', () => {
    // 配反了不会有任何报错，只会让续期接口永远买不到比滑动窗口更多的时间，
    // 表现是"调了 renew 但剩余时间没变"。
    assert.throws(
      () => makeConfig({ LEASE_IDLE_TIMEOUT_MS: '90000', LEASE_TTL_MS: '60000' }),
      /LEASE_IDLE_TIMEOUT_MS/,
    )
  })

  test('硬顶比一次续期还短 → 拒绝启动', () => {
    assert.throws(
      () => makeConfig({ LEASE_TTL_MS: '60000', LEASE_MAX_LIFETIME_MS: '30000' }),
      /LEASE_MAX_LIFETIME_MS/,
    )
  })
})

describe('租约时限：滑动与硬顶', () => {
  let config
  let pool
  let manager

  beforeEach(() => {
    config = makeConfig()
    pool = fakeSlotPool(2)
    manager = createLeaseManager({ config, logger: silentLogger, slotPool: pool })
  })

  afterEach(async () => {
    await manager.releaseAll('test')
    mock.timers.reset()
  })

  /**
   * 只 mock `Date`，**不 mock setTimeout**：release() 在有命令在跑时要等一个
   * kill 宽限期（真的 setTimeout），把它一起 mock 掉的话那个 await 永远等不到，
   * 测试直接挂死。
   */
  function freezeClock() {
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  }

  test('一直在用的租约不会被回收 —— 这是那次线上故障的回归用例', async () => {
    freezeClock()
    const lease = await manager.acquire({ runId: 'r', username: 'e' })

    // 模拟"连续用了两个小时"：每 5 分钟正常发一次请求
    // （server 里每个租约内请求都会先走 get）。旧实现在第 30 分钟就会把它砍掉。
    for (let i = 0; i < 24; i += 1) {
      mock.timers.tick(5 * 60 * 1000)
      assert.ok(manager.get(lease.leaseId), `第 ${i + 1} 次访问时租约已经没了`)
      await manager.sweep()
    }
    assert.equal(manager.count(), 1, '活跃的租约被回收了')
  })

  test('没人再碰的租约过一个 idle 窗口就回收', async () => {
    const lease = await manager.acquire({ runId: 'r', username: 'e' })
    assert.equal(await manager.sweep(lease.expiresAt - 1), 0)
    assert.equal(await manager.sweep(lease.expiresAt + 1), 1)
    assert.equal(manager.count(), 0, '槽位被永久占住了')
    assert.deepEqual(pool.released, [0], 'slot 没有被交还')
  })

  test('正在跑命令的租约不会被 idle 判定杀掉', async () => {
    // exec 是一条长连接请求：从发出到结束期间 get() 一次都不会再被调用，
    // 所以"最后一次活动"永远停在命令开始那一刻。一条 12 分钟的 npm install
    // 会在第 10 分钟被自己的 idle 判定砍掉 —— 那恰恰是最不该判定为"没人了"的时刻。
    const lease = await manager.acquire({ runId: 'r', username: 'e' })
    lease.running.add(new AbortController())

    let now = lease.createdAt
    for (let i = 0; i < 10; i += 1) {
      now += config.lease.idleTimeoutMs * 2
      await manager.sweep(now)
    }
    assert.equal(manager.count(), 1, '正在执行的命令被腰斩了')
  })

  test('硬顶推不过去：跑再久也终有一停', async () => {
    const lease = await manager.acquire({ runId: 'r', username: 'e' })
    lease.running.add(new AbortController())

    const swept = await manager.sweep(lease.createdAt + config.lease.maxLifetimeMs + 1)
    assert.equal(swept, 1)
    assert.equal(manager.count(), 0, '一个不停发请求的调用方能永久占住 slot')
  })

  test('反复续期最终会顶在硬顶上', async () => {
    freezeClock()
    const lease = await manager.acquire({ runId: 'r', username: 'e' })
    // 必须让时间真的往前走 —— 原地连按 100 次续期本来就不该多买到时间，
    // 那不是 bug 而是正确行为（"续到 now+30 分钟"是幂等的）。
    for (let i = 0; i < 20; i += 1) {
      mock.timers.tick(config.lease.ttlMs)
      manager.renew(lease, { extendMs: config.lease.ttlMs })
    }
    assert.equal(lease.expiresAt, lease.hardExpiresAt)
  })

  test('单次续期最多买 LEASE_TTL_MS', async () => {
    const lease = await manager.acquire({ runId: 'r', username: 'e' })
    const view = manager.renew(lease, { extendMs: 999 * 60 * 1000 })
    assert.ok(view.remainingMs <= config.lease.ttlMs, `买到了 ${view.remainingMs}ms，超过上限`)
  })

  test('续期不会把已经更晚的到期时刻往前缩', async () => {
    // 显式续到 +60s 之后，紧接着一个普通请求（滑动窗口只有 10s）不该把它缩回去，
    // 否则"续期"就成了一个用了还不如不用的接口。
    const lease = await manager.acquire({ runId: 'r', username: 'e' })
    const after = manager.renew(lease, { extendMs: config.lease.ttlMs }).expiresAt
    manager.get(lease.leaseId)
    assert.equal(lease.expiresAt, after)
  })

  test('创建时请求的 ttlMs 一样受 LEASE_TTL_MS 约束', async () => {
    const lease = await manager.acquire({ runId: 'r', username: 'e', ttlMs: 999 * 60 * 1000 })
    assert.ok(lease.expiresAt - lease.createdAt <= config.lease.ttlMs)
  })

  test('describe 不带 leaseToken —— 它是执行权限本身', async () => {
    const lease = await manager.acquire({ runId: 'r', username: 'e' })
    const view = manager.describe(lease)
    assert.equal(JSON.stringify(view).includes(lease.leaseToken), false)
    assert.ok(view.remainingMs > 0)
    assert.ok(view.maxRemainingMs >= view.remainingMs)
  })
})

describe('租约时限：HTTP 面', () => {
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

  async function open() {
    const res = await fetch(`${baseUrl}/v1/leases`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ runId: 'r', username: 'e' }),
    })
    return res.json()
  }

  test('创建响应下发滑动窗口长度，调用方不用硬编码保活节奏', async () => {
    const body = await open()
    assert.equal(body.idleTimeoutMs, config.lease.idleTimeoutMs)
    assert.ok(body.hardExpiresAt > body.expiresAt)
  })

  test('GET 查得到剩余时间，且不回 leaseToken', async () => {
    const body = await open()
    const res = await fetch(`${baseUrl}/v1/leases/${body.leaseId}`, { headers: auth() })
    assert.equal(res.status, 200)
    const view = await res.json()
    assert.ok(view.remainingMs > 0)
    assert.equal(view.leaseToken, undefined)
    assert.equal(view.username, 'e')
  })

  test('POST /renew 把到期时刻往后推', async () => {
    const body = await open()
    const before = body.expiresAt
    // 先把它推到快过期，再续 —— 否则创建时就是满窗口，续期看不出差别
    manager.get(body.leaseId).expiresAt = Date.now() + 500
    const res = await fetch(`${baseUrl}/v1/leases/${body.leaseId}/renew`, {
      method: 'POST', headers: auth(), body: JSON.stringify({}),
    })
    const view = await res.json()
    assert.equal(res.status, 200)
    assert.ok(view.expiresAt >= before - 1000, '续期之后到期时刻反而更早了')
    assert.ok(view.remainingMs > 1000)
  })

  test('renew 用别人的凭据会被挡住', async () => {
    const body = await open()
    const res = await fetch(`${baseUrl}/v1/leases/${body.leaseId}/renew`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-the-right-token', 'Content-Type': 'application/json' },
      body: '{}',
    })
    // 静态 token 在测试配置里仍然有效，所以这里用一个两者都不是的值
    assert.equal(res.status, 401)
  })

  test('已回收的租约 renew 返回 404，不是静默成功', async () => {
    const body = await open()
    await manager.release(body.leaseId)
    const res = await fetch(`${baseUrl}/v1/leases/${body.leaseId}/renew`, {
      method: 'POST', headers: auth(), body: '{}',
    })
    assert.equal(res.status, 404)
  })

  test('尾斜杠与不带斜杠是同一个资源', async () => {
    // 不归一的话 `/v1/leases/x/` 会绕过所有 sub === '' 的分支掉进 404，
    // 而调用方很难看出自己只是多打了一个斜杠。
    const body = await open()
    const res = await fetch(`${baseUrl}/v1/leases/${body.leaseId}/`, { headers: auth() })
    assert.equal(res.status, 200)

    const gone = await fetch(`${baseUrl}/v1/leases/lease_deadbeef/`, { method: 'DELETE', headers: auth() })
    assert.equal(gone.status, 200, 'DELETE 应当是幂等的')
  })
})
