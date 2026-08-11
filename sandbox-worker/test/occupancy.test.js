/**
 * 运维面：看槽位被谁占着、杀掉指定占用。
 *
 * 两条判据贯穿全文件：
 *
 *   1. **权限不能串。** 管控台的"看和杀"票据不能拿去占槽位（那是在生产机器上
 *      执行代码的能力），调用方的租约票据也不能拿去杀别人的租约。
 *   2. **不能带出用户数据。** 命令原文和输出内容是用户的东西。这个接口给的是
 *      身份（谁、哪一次 run）和形状（多久、多少字节、多少资源），到此为止。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import { loadConfig } from '../src/config.js'
import { createLeaseManager } from '../src/leases.js'
import { createServer } from '../src/server.js'
import { createEgressPolicyStore } from '../src/egress-policy.js'
import { ticketScope } from '../src/manager/ticket.js'

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

const NODE_ID = 'sbx-occ-1'
const SECRET = 'ticket-secret-0123456789'
const TOKEN = 'occ-static-token-0123456789'

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** 按 sandbox-manager/modules/ticket.lua 的算法签一张票据 */
function issue(payload) {
  const body = b64url(JSON.stringify({
    nid: NODE_ID,
    username: 'zhangsan',
    exp: Date.now() + 60000,
    jti: `jti-${Math.random().toString(16).slice(2)}`,
    ...payload,
  }))
  return `${body}.${b64url(createHmac('sha256', SECRET).update(body).digest())}`
}

describe('票据用途', () => {
  test('缺字段按换租约处理 —— 老 manager 签出来的就是这个样子', () => {
    assert.equal(ticketScope({}), 'lease')
    assert.equal(ticketScope({ scp: 'lease' }), 'lease')
    assert.equal(ticketScope(null), 'lease')
  })

  test('只有 admin 这个字面值才是运维票据', () => {
    assert.equal(ticketScope({ scp: 'admin' }), 'admin')
    for (const bad of ['ADMIN', 'Admin', 'administrator', true, 1, ['admin']]) {
      assert.equal(ticketScope({ scp: bad }), 'lease', `不该当成运维票据：${JSON.stringify(bad)}`)
    }
  })
})

describe('运维面：占用与强杀', () => {
  let app
  let baseUrl
  let manager
  let released

  /** 假 slot 池：记录 release 调用，并给出可预测的资源读数 */
  function pool() {
    const slots = [0, 1].map((index) => ({
      index,
      busy: false,
      uid: 20000 + index,
      sentinel: { pid: 1 },
      cgroup: { stats: async () => ({ cpuUsageUsec: 1234000, memoryBytes: 5242880, pids: 7 }) },
      hostWorkspace: { workDir: '/tmp/f/work', baseDir: '/tmp/f', homeDir: '/tmp/f/home', tmpDir: '/tmp/f/tmp' },
      guest: { workDir: '/work', homeDir: '/home/job', tmpDir: '/tmp' },
    }))
    return {
      acquire(leaseId) {
        const slot = slots.find((s) => !s.busy)
        if (!slot) return null
        slot.busy = true
        slot.leaseId = leaseId
        return slot
      },
      async release(index) {
        released.push(index)
        const slot = slots.find((s) => s.index === index)
        if (slot) { slot.busy = false; slot.leaseId = null }
      },
      status: () => ({ slots: slots.map((s) => ({ index: s.index, busy: s.busy })), egress: { extraAllowed: [] } }),
      egressState: () => ({ mode: 'allowlist', revision: 'r1', pendingSlots: 0, totalSlots: 2 }),
    }
  }

  function boot({ acceptStaticToken = 'true' } = {}) {
    const config = loadConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: TOKEN,
      SANDBOX_SLOTS: '2',
      SANDBOX_ADVERTISE_BASE: 'http://127.0.0.1:0',
      SANDBOX_MANAGER_URL: 'http://manager.local',
      SANDBOX_MANAGER_CODE: 'code',
      SANDBOX_TICKET_SECRET: SECRET,
      SANDBOX_NODE_ID: NODE_ID,
      SANDBOX_ACCEPT_STATIC_TOKEN: acceptStaticToken,
    })
    const slotPool = pool()
    manager = createLeaseManager({ config, logger: silent, slotPool })
    return createServer({
      config, logger: silent, leaseManager: manager, slotPool,
      egressPolicy: createEgressPolicyStore({ config, logger: silent }),
    })
  }

  beforeEach(async () => {
    released = []
    app = boot()
    baseUrl = `http://127.0.0.1:${(await app.listen(0)).port}`
  })

  afterEach(async () => {
    await manager.releaseAll('test')
    await app.close()
  })

  const asStatic = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  const occupancy = (headers = asStatic) => fetch(`${baseUrl}/v1/admin/occupancy`, { headers })
  const takeLease = (body = {}) => fetch(`${baseUrl}/v1/leases`, {
    method: 'POST', headers: asStatic, body: JSON.stringify({ runId: 'run_1', username: 'alice', ...body }),
  })

  // ── 权限 ──

  test('无凭据一律 401', async () => {
    assert.equal((await fetch(`${baseUrl}/v1/admin/occupancy`)).status, 401)
  })

  test('运维票据可以看占用', async () => {
    const res = await occupancy({ Authorization: `Bearer ${issue({ scp: 'admin' })}` })
    assert.equal(res.status, 200)
  })

  test('调用方的租约票据**不能**看占用，更不能杀', async () => {
    // 否则任何能申请到租约的人都能杀掉别人的租约。
    const lease = { Authorization: `Bearer ${issue({ run: 'r' })}` }
    assert.equal((await occupancy(lease)).status, 401)
    const kill = await fetch(`${baseUrl}/v1/admin/leases/lease_x`, { method: 'DELETE', headers: lease })
    assert.equal(kill.status, 401)
  })

  test('运维票据**不能**换租约 —— 只该"看和杀"，不该顺手拿到执行权限', async () => {
    const res = await fetch(`${baseUrl}/v1/leases`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${issue({ scp: 'admin' })}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'r' }),
    })
    assert.equal(res.status, 401)
    assert.equal(manager.count(), 0, '运维票据换到了槽位')
  })

  test('迁移完成（不再收静态 token 换租约）之后，运维直连仍然可用', async () => {
    // SANDBOX_ACCEPT_STATIC_TOKEN 回答的是"业务调用方还能不能拿长期凭据换租约"。
    // 把运维接口也捆在那个开关上，会让迁移完成的那一刻排查手段一起失效 ——
    // 而那恰恰是最需要它的时候。
    await app.close()
    app = boot({ acceptStaticToken: 'false' })
    baseUrl = `http://127.0.0.1:${(await app.listen(0)).port}`

    assert.equal((await takeLease()).status, 401, '静态 token 不该还能换租约')
    assert.equal((await occupancy()).status, 200, '运维直连不该被一起关掉')
  })

  // ── 内容 ──

  test('占用列表给出"谁在占"和"占了多久"', async () => {
    await takeLease({ runId: 'run_abc', username: 'alice' })
    const body = await (await occupancy()).json()

    assert.equal(body.slots.used, 1)
    assert.equal(body.occupancy.length, 1)
    const row = body.occupancy[0]
    assert.equal(row.username, 'alice')
    assert.equal(row.runId, 'run_abc')
    assert.equal(row.slotIndex, 0)
    assert.ok(row.leaseId.startsWith('lease_'))
    assert.ok(row.ageMs >= 0 && row.idleMs >= 0)
    // 空闲槽位也要能看出来：只有占用列表的话，"1/2 在用"里空的是哪一个看不出来
    assert.deepEqual(body.freeSlots, [1])
  })

  test('带上资源读数 —— "该不该杀"靠的是这几个数字', async () => {
    await takeLease()
    const row = (await (await occupancy()).json()).occupancy[0]
    assert.deepEqual(row.resources, { cpuUsageUsec: 1234000, memoryBytes: 5242880, pids: 7 })
  })

  test('cgroup 读不出来时那一行仍然要在，只是资源为 null', async () => {
    // 一个 slot 的 cgroup 有问题时，运维**更**需要看到占用（尤其是别的那些），
    // 而不是看到一个 500 —— 整张表打不开的时候，人是没法做决定的。
    const broken = await (await takeLease({ username: 'alice' })).json()
    await takeLease({ username: 'bob' })
    manager.get(broken.leaseId).slot.cgroup.stats = async () => { throw new Error('cgroup 读失败') }

    const res = await occupancy()
    assert.equal(res.status, 200, '一个 slot 读不出资源就整张表 500 了')
    const rows = (await res.json()).occupancy
    assert.equal(rows.length, 2)
    assert.equal(rows.find((r) => r.username === 'alice').resources, null)
    assert.ok(rows.find((r) => r.username === 'bob').resources, '别的占用不该被牵连')
  })

  test('**不带命令原文，也不带输出内容**', async () => {
    const created = await (await takeLease()).json()
    // 把命令与输出**种在 job 对象上** —— 一个图省事的实现正是从这里取字段的，
    // 所以泄漏要在这里才验得到。真跑一条命令在 macOS 上起不来（要 nsenter），
    // 而且那样 execs 会是空的，测了个寂寞。
    const lease = manager.get(created.leaseId)
    lease.execs = new Map([['exe_1', {
      execId: 'exe_1',
      status: 'running',
      startedAt: Date.now() - 1000,
      outputBytes: 42,
      command: 'curl -H "Authorization: Bearer SECRET_MARKER_12345" https://x',
      frames: [{ type: 'stdout', data: 'OUTPUT_MARKER_67890' }],
    }]])

    const text = await (await occupancy()).text()
    assert.ok(text.includes('exe_1'), '前提没成立：这条 exec 压根没出现在结果里')
    assert.ok(!text.includes('SECRET_MARKER_12345'), `带出了命令原文：${text.slice(0, 500)}`)
    assert.ok(!text.includes('OUTPUT_MARKER_67890'), `带出了输出内容：${text.slice(0, 500)}`)
    assert.ok(!/"command"/.test(text), '不该有 command 字段')
    assert.ok(!/"frames"/.test(text), '不该有 frames 字段')
    // 形状仍然要在 —— 否则这条测试可以靠"什么都不回"通过
    assert.ok(/"outputBytes":42/.test(text), '形状（字节数）应该保留')
  })

  // ── 杀 ──

  test('杀掉指定占用：租约没了，槽位被销毁重建', async () => {
    const created = await (await takeLease({ username: 'bob', runId: 'run_kill' })).json()
    assert.equal(manager.count(), 1)

    const res = await fetch(`${baseUrl}/v1/admin/leases/${created.leaseId}`, { method: 'DELETE', headers: asStatic })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.killed, true)
    // victim 由**节点**回，管理端的审计记录才不是操作者的自述
    assert.equal(body.victim.username, 'bob')
    assert.equal(body.victim.runId, 'run_kill')

    assert.equal(manager.count(), 0, '租约还在')
    assert.deepEqual(released, [0], '槽位没有被销毁重建')
  })

  test('杀一个已经不在的租约 → 成功而不是 404', async () => {
    // 运维要的结果是"这个槽位空出来"，那个结果已经达成了。
    // 报错只会让人以为还得再做点什么。
    const res = await fetch(`${baseUrl}/v1/admin/leases/lease_gone`, { method: 'DELETE', headers: asStatic })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.killed, false)
    assert.equal(body.reason, 'not-found')
  })

  test('杀掉一个之后另一个不受影响', async () => {
    const a = await (await takeLease({ username: 'alice' })).json()
    await takeLease({ username: 'bob' })
    assert.equal(manager.count(), 2)

    await fetch(`${baseUrl}/v1/admin/leases/${a.leaseId}`, { method: 'DELETE', headers: asStatic })
    const rows = (await (await occupancy()).json()).occupancy
    assert.equal(rows.length, 1)
    assert.equal(rows[0].username, 'bob')
  })

  test('非法 leaseId 不进路由', async () => {
    const res = await fetch(`${baseUrl}/v1/admin/leases/..%2Fetc`, { method: 'DELETE', headers: asStatic })
    assert.equal(res.status, 404)
  })
})
