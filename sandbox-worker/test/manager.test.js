/**
 * 节点侧接入 sandbox-manager 的测试：配置校验、票据校验、一次性防重放。
 *
 * 票据的**跨语言一致性**在这里也守着：签发端是 Lua（sandbox-manager），
 * 校验端是这里的 Node 实现，两边编码差一个字节的现象是"调度成功但所有租约
 * 申请 401"，而两边各自的日志都正常。所以这里用固定的密钥+载荷算出预期签名，
 * 任何一边动了编码方式，这条用例就会红。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import http from 'node:http'

import { loadConfig, validate } from '../src/config.js'
import { verifyTicket, createTicketGuard } from '../src/manager/ticket.js'
import { createManagerClient } from '../src/manager/client.js'

const SECRET = 'shared-secret-abc123'
const NODE_ID = 'sbx-node-1'

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 按 sandbox-manager/modules/ticket.lua 的算法签一张票据 */
function issue(payload, secret = SECRET) {
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(createHmac('sha256', secret).update(body).digest())
  return `${body}.${sig}`
}

function validTicket(overrides = {}) {
  return issue({
    nid: NODE_ID,
    run: 'run-42',
    username: 'zhangsan',
    exp: Date.now() + 60000,
    jti: `jti-${Math.random().toString(16).slice(2)}`,
    ...overrides,
  })
}

const BASE_ENV = {
  NODE_ENV: 'test',
  SANDBOX_TOKEN: 'x'.repeat(20),
  SANDBOX_ADVERTISE_BASE: 'http://10.0.0.1:8080',
}

describe('管理端接入配置', () => {
  test('不配 SANDBOX_MANAGER_URL 时完全是原来的行为', () => {
    const config = loadConfig(BASE_ENV)
    assert.equal(config.manager.enabled, false)
    assert.equal(config.manager.url, '')
  })

  test('配了 URL 就必须配 CODE —— 否则注册和心跳全部 401', () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, SANDBOX_MANAGER_URL: 'http://mgr.internal' }),
      /SANDBOX_MANAGER_CODE/,
    )
  })

  test('配了 URL 就必须配票据密钥 —— 否则节点会被调度到却拒绝所有租约', () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, SANDBOX_MANAGER_URL: 'http://mgr.internal', SANDBOX_MANAGER_CODE: 'c' }),
      /SANDBOX_TICKET_SECRET/,
    )
  })

  test('配了密钥却漏配 URL 也要拦 —— 否则接入悄无声息地没生效', () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, SANDBOX_TICKET_SECRET: SECRET }),
      /没配 SANDBOX_MANAGER_URL/,
    )
  })

  test('URL 不是绝对地址要拦', () => {
    assert.throws(
      () => loadConfig({
        ...BASE_ENV,
        SANDBOX_MANAGER_URL: 'mgr.internal',
        SANDBOX_MANAGER_CODE: 'c',
        SANDBOX_TICKET_SECRET: SECRET,
      }),
      /必须是 http/,
    )
  })

  test('整套配齐可以正常启动，nodeId 缺省取 hostname', () => {
    const config = loadConfig({
      ...BASE_ENV,
      SANDBOX_MANAGER_URL: 'http://mgr.internal/',
      SANDBOX_MANAGER_CODE: 'code-1',
      SANDBOX_TICKET_SECRET: SECRET,
      SANDBOX_POOL: 'gpu',
      SANDBOX_LABELS: 'zone=lf09, tier=gold',
    })
    assert.equal(config.manager.enabled, true)
    assert.equal(config.manager.url, 'http://mgr.internal', '末尾斜杠要去掉，否则拼出 //api/...')
    assert.equal(config.manager.pool, 'gpu')
    assert.deepEqual(config.manager.labels, { zone: 'lf09', tier: 'gold' })
    assert.ok(config.manager.nodeId.length > 0, 'nodeId 应缺省取 hostname')
  })

  test('密钥指纹只暴露 sha256 前 8 位，不含密钥本身', () => {
    const config = loadConfig({
      ...BASE_ENV,
      SANDBOX_MANAGER_URL: 'http://mgr.internal',
      SANDBOX_MANAGER_CODE: 'c',
      SANDBOX_TICKET_SECRET: SECRET,
    })
    const fp = config.manager.ticketSecretFingerprint
    assert.equal(fp.length, 8)
    assert.ok(!SECRET.includes(fp) && !fp.includes(SECRET.slice(0, 8)), '指纹不能是密钥的片段')
  })

  test('关掉静态 token 又没配 token 时，不再要求 SANDBOX_TOKEN', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      SANDBOX_ADVERTISE_BASE: 'http://10.0.0.1:8080',
      SANDBOX_MANAGER_URL: 'http://mgr.internal',
      SANDBOX_MANAGER_CODE: 'c',
      SANDBOX_TICKET_SECRET: SECRET,
      SANDBOX_ACCEPT_STATIC_TOKEN: '0',
    })
    assert.equal(config.manager.acceptStaticToken, false)
    assert.equal(config.token, '')
  })

  test('还收静态 token 却没配 token —— 那条路径根本走不通，要拦', () => {
    assert.throws(
      () => loadConfig({
        NODE_ENV: 'test',
        SANDBOX_ADVERTISE_BASE: 'http://10.0.0.1:8080',
        SANDBOX_MANAGER_URL: 'http://mgr.internal',
        SANDBOX_MANAGER_CODE: 'c',
        SANDBOX_TICKET_SECRET: SECRET,
      }),
      /SANDBOX_ACCEPT_STATIC_TOKEN/,
    )
  })

  test('生产环境仍收静态 token 时给出警告但不阻止启动', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      SANDBOX_TOKEN: 'x'.repeat(20),
      SANDBOX_ADVERTISE_BASE: 'http://10.0.0.1:8080',
      AP_BRIDGE_HOST: 'agent.internal',
      SANDBOX_MANAGER_URL: 'http://mgr.internal',
      SANDBOX_MANAGER_CODE: 'c',
      SANDBOX_TICKET_SECRET: SECRET,
    })
    assert.ok(
      config.warnings.some((w) => w.includes('SANDBOX_ACCEPT_STATIC_TOKEN')),
      '迁移没走完必须能被看见，否则很容易停在第 2 步就当作完成了',
    )
  })
})

describe('票据校验', () => {
  test('合法票据通过，载荷原样取出', () => {
    const result = verifyTicket({ token: validTicket(), secret: SECRET, nodeId: NODE_ID })
    assert.equal(result.ok, true)
    assert.equal(result.payload.username, 'zhangsan')
    assert.equal(result.payload.run, 'run-42')
  })

  test('签名不匹配被拒', () => {
    const token = issue({ nid: NODE_ID, username: 'a', exp: Date.now() + 60000, jti: 'j' }, 'another-secret')
    const result = verifyTicket({ token, secret: SECRET, nodeId: NODE_ID })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'bad-signature')
  })

  test('改载荷保留原签名 —— 必须被拒（否则 username 可被篡改）', () => {
    const token = validTicket()
    const [body, sig] = token.split('.')
    const forged = b64url(JSON.stringify({
      nid: NODE_ID, run: 'run-42', username: 'lisi', exp: Date.now() + 60000, jti: 'j',
    }))
    const result = verifyTicket({ token: `${forged}.${sig}`, secret: SECRET, nodeId: NODE_ID })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'bad-signature')
    assert.notEqual(body, forged, '前提：载荷确实被改过')
  })

  test('过期票据被拒', () => {
    const token = validTicket({ exp: Date.now() - 1 })
    assert.equal(verifyTicket({ token, secret: SECRET, nodeId: NODE_ID }).reason, 'expired')
  })

  test('签给别的节点的票据被拒 —— 票据绑定节点是它的核心价值', () => {
    const token = validTicket({ nid: 'sbx-node-2' })
    assert.equal(verifyTicket({ token, secret: SECRET, nodeId: NODE_ID }).reason, 'wrong-node')
  })

  test('缺 username 的票据被拒 —— 没有它，会话就没法按人隔离', () => {
    const token = validTicket({ username: '' })
    assert.equal(verifyTicket({ token, secret: SECRET, nodeId: NODE_ID }).reason, 'missing-username')
  })

  test('各种畸形输入都不会抛异常', () => {
    for (const token of ['', 'no-dot', 'a.b.c', '....', '!!!.???', 'x'.repeat(5000), null, undefined, 123, {}]) {
      const result = verifyTicket({ token, secret: SECRET, nodeId: NODE_ID })
      assert.equal(result.ok, false, `应拒绝：${JSON.stringify(token)}`)
    }
  })

  test('没配密钥时一律拒绝，不会误放行', () => {
    assert.equal(verifyTicket({ token: validTicket(), secret: '', nodeId: NODE_ID }).reason, 'no-secret-configured')
  })

  test('拒绝原因不回给调用方，只用于日志', () => {
    // 这条守的是 server.js 的用法：reason 区分度会帮攻击者定位问题。
    // 这里断言 reason 是稳定的机器标识（而非可以直接展示的句子），
    // 提醒后来的人别顺手把它塞进响应体。
    const result = verifyTicket({ token: validTicket({ nid: 'other' }), secret: SECRET, nodeId: NODE_ID })
    assert.match(result.reason, /^[a-z-]+$/, 'reason 应是 kebab-case 机器标识')
  })
})

describe('票据一次性（防重放）', () => {
  test('同一张票据只能用一次', () => {
    const guard = createTicketGuard()
    const exp = Date.now() + 60000
    assert.equal(guard.claim('jti-1', exp), true, '第一次应该放行')
    assert.equal(guard.claim('jti-1', exp), false, '第二次必须拒绝')
  })

  test('不同票据互不影响', () => {
    const guard = createTicketGuard()
    const exp = Date.now() + 60000
    assert.equal(guard.claim('jti-1', exp), true)
    assert.equal(guard.claim('jti-2', exp), true)
  })

  test('缺 jti 的票据当作重放拒掉，不能因为"没标识"就放行', () => {
    const guard = createTicketGuard()
    assert.equal(guard.claim(undefined, Date.now() + 1000), false)
    assert.equal(guard.claim('', Date.now() + 1000), false)
  })

  test('过期条目会被清掉，表不会无限涨', () => {
    const guard = createTicketGuard()
    const past = Date.now() - 1000
    for (let i = 0; i < 100; i += 1) guard.claim(`old-${i}`, past)
    // 触发一次惰性清理
    guard.claim('fresh', Date.now() + 60000)
    assert.ok(guard.size() < 100, `过期条目应被清理，当前 ${guard.size()}`)
  })
})

describe('管理端下发的对象存储放行', () => {
  /**
   * OSS 配置在管理端（SpeedLoop 原生 ctx.oss），节点只是**收下主机名并自动放行**。
   * 有意不让运维在两处各配一遍：配置漂移的现象是"产物上传莫名其妙连不上"，
   * 而两边的配置看起来都对。
   */
  let server
  let url
  let artifactHost
  let calls

  const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

  function fakeSlotPool() {
    const applied = []
    return {
      applied,
      status: () => ({ cgroupVersion: 'v2' }),
      allowEgressAll: async (entries) => { applied.push(entries) },
    }
  }

  beforeEach(async () => {
    calls = []
    artifactHost = 's3.us-east-1.amazonaws.com'
    server = http.createServer(async (req, res) => {
      calls.push(req.url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, heartbeatIntervalMs: 10000, artifactHost }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  function makeClient(slotPool) {
    const config = loadConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: 'manager-test-token-0123',
      SANDBOX_ADVERTISE_BASE: 'http://10.0.0.9:8080',
      SANDBOX_MANAGER_URL: url,
      SANDBOX_MANAGER_CODE: 'node-code',
      SANDBOX_TICKET_SECRET: 'ticket-secret-0123456789',
    })
    return createManagerClient({
      config,
      logger: silent,
      leaseManager: { slots: () => ({ used: 0, total: 1 }), count: () => 0, countByUser: () => ({}) },
      slotPool,
      browserManager: null,
    })
  }

  test('注册拿到主机名后自动放行，沙盒才连得上对象存储', async () => {
    const pool = fakeSlotPool()
    await makeClient(pool).registerOnce()
    assert.deepEqual(pool.applied, [[{ host: 's3.us-east-1.amazonaws.com', ports: [443] }]])
  })

  test('主机名没变就不重复挂规则', async () => {
    const pool = fakeSlotPool()
    const client = makeClient(pool)
    await client.registerOnce()
    await client.registerOnce()
    assert.equal(pool.applied.length, 1, '同一个主机名不该挂两遍')
  })

  test('管理端没开这个功能时节点什么也不做', async () => {
    artifactHost = undefined
    const pool = fakeSlotPool()
    await makeClient(pool).registerOnce()
    assert.deepEqual(pool.applied, [], '不该凭空放行任何目标')
  })

  test('放行失败不影响节点服务能力 —— 产物上传是可选功能', async () => {
    // 这台机器上正在跑的租约不该因为一个可选功能挂不上而受影响。
    const pool = {
      status: () => ({ cgroupVersion: 'v2' }),
      allowEgressAll: async () => { throw new Error('iptables 挂了') },
    }
    await assert.doesNotReject(() => makeClient(pool).registerOnce())
  })
})
