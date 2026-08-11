/**
 * 出站策略开关：管理端下发、节点执行。
 *
 * 这一组用例的判据始终是同一条：**读不懂的输入必须往"拦"那一侧倒。**
 * 少放行 → 站点打不开，看得见、查得到；多放行 → 沙盒能连到本不该连的地方，
 * 没有任何现象。两种错误的代价不对称，所以下面每一条"缺字段/类型不对/拼错"
 * 的用例都在验同一件事：它有没有变成"不拦"。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { loadConfig } from '../src/config.js'
import { createEgressPolicyStore } from '../src/egress-policy.js'
import { createManagerClient } from '../src/manager/client.js'
import { createLeaseManager } from '../src/leases.js'
import { createServer } from '../src/server.js'
import { normalizeEgressEntries, parseEgressAllow, buildEgressPlan } from '../src/namespace/netns.js'

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

const baseConfig = (overrides = {}) => loadConfig({
  NODE_ENV: 'test',
  ALLOW_ANONYMOUS: '1',
  SANDBOX_ADVERTISE_BASE: 'http://127.0.0.1:0',
  ...overrides,
})

describe('管理端下发条目的归一化', () => {
  test('正常条目原样收下，端口去重排序', () => {
    assert.deepEqual(
      normalizeEgressEntries([{ host: 'a.xiaocaicai.com', ports: [443, 80, 443] }]),
      [{ host: 'a.xiaocaicai.com', ports: [80, 443] }],
    )
  })

  test('端口缺失时整条丢弃，**不补 80+443**', () => {
    // 字符串形式里"不写端口"是运维少打几个字，补默认值是善意的；
    // 这里是对着一条读不懂的下发内容猜它想开哪些端口 —— 猜错的方向是多开，
    // 而多开没有任何现象。
    assert.deepEqual(normalizeEgressEntries([{ host: 'a.xiaocaicai.com' }]), [])
    assert.deepEqual(normalizeEgressEntries([{ host: 'a.xiaocaicai.com', ports: [] }]), [])
    assert.deepEqual(normalizeEgressEntries([{ host: 'a.xiaocaicai.com', ports: 'all' }]), [])
  })

  test('非法端口逐个丢弃，整条端口都非法时丢整条', () => {
    assert.deepEqual(
      normalizeEgressEntries([{ host: 'a.xiaocaicai.com', ports: [443, 0, 70000, -1, 'x'] }]),
      [{ host: 'a.xiaocaicai.com', ports: [443] }],
    )
    assert.deepEqual(normalizeEgressEntries([{ host: 'a.xiaocaicai.com', ports: [0, 99999] }]), [])
  })

  test('主机名字符集不合法就丢掉', () => {
    // 这条校验拦的是"交给 getent 只会静默解析失败"的输入 —— 现象是
    // "下发了却没生效"，而节点的 iptables 里连痕迹都没有。
    // 它**不是** RFC 级的域名校验（`trail-.com` 这种每段是否合法不在管辖范围内，
    // 那种值最多解析不出来，代价是"打不开"，不是"多开了一道门"）。
    for (const host of ['a b.com', 'a.com;rm -rf /', 'a.com/../b', '-lead.com', 'a.com.', 'a.com-', '.a.com', '*.xiaocaicai.com', '']) {
      assert.deepEqual(normalizeEgressEntries([{ host, ports: [443] }]), [], `应丢弃：${JSON.stringify(host)}`)
    }
    // 合法的别误伤：IPv4 字面量、下划线、单字符
    for (const host of ['10.0.0.1', 'a_b.xiaocaicai.com', 'x']) {
      assert.equal(normalizeEgressEntries([{ host, ports: [443] }]).length, 1, `不该丢：${host}`)
    }
  })

  test('不是数组、条目不是对象 → 空清单，不抛', () => {
    for (const bad of [null, undefined, 'a.xiaocaicai.com', 42, {}]) {
      assert.deepEqual(normalizeEgressEntries(bad), [])
    }
    assert.deepEqual(normalizeEgressEntries([null, 'x', 7]), [])
  })

  test('字符串形式也校验主机名，且不退化成放行全部端口', () => {
    assert.deepEqual(parseEgressAllow('a b.com'), [])
    assert.deepEqual(parseEgressAllow('-lead.com'), [])
    assert.deepEqual(parseEgressAllow('ok.xiaocaicai.com'), [{ host: 'ok.xiaocaicai.com', ports: [80, 443] }])
  })
})

describe('规则链的编排顺序', () => {
  // 这里的正确性几乎全在顺序上，而顺序错了的样子和对的样子在 `iptables -S`
  // 里几乎一模一样 —— 所以要逐条断言，不能只看"规则都在"。
  const plan = (opts) => buildEgressPlan(opts).map((args) => args.join(' '))

  test('切到拦截时：先 DROP 再清空，中间那一瞬是全关而不是全开', () => {
    const p = plan({ enforce: true })
    assert.equal(p[0], '-P OUTPUT DROP')
    assert.equal(p[1], '-F OUTPUT')
  })

  test('切到不拦时：先清空再 ACCEPT，中间那一瞬仍是全关', () => {
    // 反过来（先 -P ACCEPT 再 -F）在重编排一个 slot 时就是一个真实的逃逸窗口，
    // 宽度取决于两条命令之间的间隔 —— 不可观测、不可复现。
    assert.deepEqual(plan({ enforce: false }), ['-F OUTPUT', '-P OUTPUT ACCEPT'])
  })

  test('兜底 REJECT 永远是最后一条', () => {
    // 这个文件里已经踩过一次同类的坑：租约级放行当初用 `-A` 追加，
    // 结果落在 REJECT 后面，规则挂上了却一个包也放不过去。
    const p = plan({
      enforce: true,
      nameservers: ['10.0.0.53'],
      bridgeIps: ['10.1.1.1'],
      bridgePort: 8788,
      extra: [{ host: 'oss.xiaocaicai.com', ips: ['1.2.3.4'], ports: [443] }],
    })
    assert.equal(p.at(-1), '-A OUTPUT -j REJECT --reject-with icmp-port-unreachable')
    assert.equal(p.filter((line) => line.includes('REJECT')).length, 1)
    // 每一条放行都必须排在 REJECT 之前，否则等于没挂
    for (const needle of ['10.0.0.53', '10.1.1.1', '1.2.3.4']) {
      assert.ok(p.findIndex((l) => l.includes(needle)) < p.length - 1, `${needle} 的放行落到 REJECT 后面了`)
    }
  })

  test('不拦的时候一条放行都不排 —— 链是空的，插 ACCEPT 没有意义', () => {
    const p = plan({ enforce: false, nameservers: ['10.0.0.53'], bridgeIps: ['10.1.1.1'], extra: [{ host: 'x', ips: ['1.2.3.4'], ports: [443] }] })
    assert.equal(p.length, 2)
  })

  test('DNS 解析不出 nameserver 时才退化成"放行任意主机的 53 端口"', () => {
    // 写死成这样的话它就不只是 DNS 了：既能做 DNS 隧道把数据带出去，
    // 也能连上任何恰好监听 53 的内网服务。所以只在真的没读到时才用。
    const narrow = plan({ enforce: true, nameservers: ['10.0.0.53'] })
    assert.ok(narrow.some((l) => l === '-A OUTPUT -p udp -d 10.0.0.53 --dport 53 -j ACCEPT'))
    assert.ok(!narrow.some((l) => l === '-A OUTPUT -p udp --dport 53 -j ACCEPT'))

    const wide = plan({ enforce: true, nameservers: [] })
    assert.ok(wide.some((l) => l === '-A OUTPUT -p udp --dport 53 -j ACCEPT'))
  })

  test('额外目标的每个 IP × 每个端口都要有一条', () => {
    // 多 IP 的域名只放行第一个，表现是"有时候连得上有时候连不上"。
    const p = plan({ enforce: true, extra: [{ host: 'a.xiaocaicai.com', ips: ['1.1.1.1', '2.2.2.2'], ports: [80, 443] }] })
    for (const ip of ['1.1.1.1', '2.2.2.2']) {
      for (const port of ['80', '443']) {
        assert.ok(p.includes(`-A OUTPUT -p tcp -d ${ip} --dport ${port} -j ACCEPT`), `缺 ${ip}:${port}`)
      }
    }
  })
})

describe('策略存储：默认值与下发', () => {
  test('没接管理端时用本地 env，默认拦', () => {
    const store = createEgressPolicyStore({ config: baseConfig(), logger: silent })
    assert.equal(store.current().enforce, true)
    assert.equal(store.current().source, 'env')
  })

  test('本地 env 可以在开发环境关掉拦截', () => {
    const store = createEgressPolicyStore({ config: baseConfig({ SANDBOX_EGRESS_MODE: 'open' }), logger: silent })
    assert.equal(store.current().enforce, false)
  })

  test('生产环境禁止在节点上写 open —— 这个决定只能来自管理端', () => {
    assert.throws(
      () => baseConfig({
        NODE_ENV: 'production',
        ALLOW_ANONYMOUS: '',
        SANDBOX_TOKEN: 'x'.repeat(20),
        AP_BRIDGE_HOST: 'agent.svc',
        SANDBOX_EGRESS_MODE: 'open',
      }),
      /SANDBOX_EGRESS_MODE=open/,
    )
  })

  test('拼错的模式拒绝启动，不退化成不拦', () => {
    assert.throws(() => baseConfig({ SANDBOX_EGRESS_MODE: 'OPEN' }), /SANDBOX_EGRESS_MODE/)
    assert.throws(() => baseConfig({ SANDBOX_EGRESS_MODE: 'off' }), /SANDBOX_EGRESS_MODE/)
  })

  test('管理端下发 open 时整体覆盖本地 env', () => {
    const store = createEgressPolicyStore({ config: baseConfig(), logger: silent })
    const { changed, policy } = store.update({ mode: 'open', revision: 'r1', allow: [], leaseAllow: [] })
    assert.equal(changed, true)
    assert.equal(policy.enforce, false)
    assert.equal(policy.source, 'manager')
  })

  test('下发的清单整体替换本地 env，不做合并', () => {
    // 合并出来的结果，出了事没人能一眼说清是哪一边贡献的那一条。
    const config = baseConfig({ SANDBOX_EGRESS_ALLOW: 'local.xiaocaicai.com' })
    const store = createEgressPolicyStore({ config, logger: silent })
    assert.deepEqual(store.current().allow, [{ host: 'local.xiaocaicai.com', ports: [80, 443] }])

    store.update({ mode: 'allowlist', revision: 'r1', allow: [{ host: 'remote.xiaocaicai.com', ports: [443] }] })
    assert.deepEqual(store.current().allow, [{ host: 'remote.xiaocaicai.com', ports: [443] }])
  })

  test('mode 字段缺失/类型不对 → 按拦处理', () => {
    for (const incoming of [
      { revision: 'r' },
      { mode: null, revision: 'r' },
      { mode: 'OPEN', revision: 'r' },
      { mode: 'opened', revision: 'r' },
      { mode: true, revision: 'r' },
    ]) {
      const store = createEgressPolicyStore({ config: baseConfig({ SANDBOX_EGRESS_MODE: 'open' }), logger: silent })
      store.update(incoming)
      assert.equal(store.current().enforce, true, `应按拦处理：${JSON.stringify(incoming)}`)
    }
  })

  test('整块字段缺席（老管理端）→ 保持现状，不重置成本地 env', () => {
    // 否则"升级管理端的顺序"会决定节点的隔离强度，而这层因果关系没人会想到。
    const store = createEgressPolicyStore({ config: baseConfig(), logger: silent })
    store.update({ mode: 'open', revision: 'r1' })
    assert.equal(store.current().enforce, false)

    for (const absent of [undefined, null, 'nope', 42]) {
      const res = store.update(absent)
      assert.equal(res.changed, false)
      assert.equal(store.current().enforce, false, '不该被重置回本地 env')
      assert.equal(res.reason, 'absent')
    }
  })

  test('内容没变就不算变更 —— 心跳每 10 秒一次，不该每次都动 iptables', () => {
    const store = createEgressPolicyStore({ config: baseConfig(), logger: silent })
    const payload = { mode: 'allowlist', revision: 'r1', allow: [{ host: 'a.xiaocaicai.com', ports: [443] }] }
    assert.equal(store.update(payload).changed, true)
    assert.equal(store.update(payload).changed, false)
    assert.equal(store.update({ ...payload }).changed, false)
  })

  test('只是书写顺序变了不算变更', () => {
    const store = createEgressPolicyStore({ config: baseConfig(), logger: silent })
    store.update({ mode: 'allowlist', revision: 'r1', allow: [{ host: 'a.xiaocaicai.com', ports: [443] }, { host: 'b.xiaocaicai.com', ports: [443] }] })
    const res = store.update({ mode: 'allowlist', revision: 'r2', allow: [{ host: 'b.xiaocaicai.com', ports: [443] }, { host: 'a.xiaocaicai.com', ports: [443] }] })
    assert.equal(res.changed, false, '重排不该触发全集群重编排')
    assert.equal(store.current().revision, 'r2', '版本号还是要跟上，否则上报对不齐')
  })

  test('内容变了但版本号没变，照样重编排 —— 判据是内容不是版本号', () => {
    // 管理端把版本号算错的情况下，按内容比对只是多做一次幂等的重编排；
    // 按版本号比对则是策略静默不生效。
    const store = createEgressPolicyStore({ config: baseConfig(), logger: silent })
    store.update({ mode: 'allowlist', revision: 'same', allow: [] })
    const res = store.update({ mode: 'open', revision: 'same', allow: [] })
    assert.equal(res.changed, true)
    assert.equal(store.current().enforce, false)
  })

  test('describe() 只报模式与计数，不报放行的主机名', () => {
    const store = createEgressPolicyStore({ config: baseConfig(), logger: silent })
    store.update({ mode: 'allowlist', revision: 'r1', allow: [{ host: 'secret-internal.xiaocaicai.com', ports: [443] }] })
    const described = JSON.stringify(store.describe())
    assert.ok(!described.includes('secret-internal'), `不该带出主机名：${described}`)
    assert.equal(store.describe().allowCount, 1)
  })
})

describe('心跳同步：节点侧', () => {
  let server
  let url
  let responseBody
  let received

  function fakeSlotPool() {
    const calls = []
    return {
      calls,
      status: () => ({ cgroupVersion: 'v2' }),
      egressState: () => ({ mode: 'allowlist', revision: '', pendingSlots: 0, totalSlots: 1 }),
      allowEgressAll: async () => {},
      applyPolicy: async () => { calls.push('applyPolicy'); return { reprogrammed: 1, pending: 0, failed: 0 } },
    }
  }

  beforeEach(async () => {
    received = []
    responseBody = { ok: true, heartbeatIntervalMs: 10000 }
    server = http.createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      received.push({ url: req.url, body: JSON.parse(raw || '{}') })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(responseBody))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}`
  })

  afterEach(async () => { await new Promise((resolve) => server.close(resolve)) })

  function makeClient(slotPool, configOverrides = {}) {
    const config = loadConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: 'manager-test-token-0123',
      SANDBOX_ADVERTISE_BASE: 'http://10.0.0.9:8080',
      SANDBOX_MANAGER_URL: url,
      SANDBOX_MANAGER_CODE: 'node-code',
      SANDBOX_TICKET_SECRET: 'ticket-secret-0123456789',
      ...configOverrides,
    })
    const egressPolicy = createEgressPolicyStore({ config, logger: silent })
    const client = createManagerClient({
      config,
      logger: silent,
      leaseManager: { slots: () => ({ used: 0, total: 1 }), count: () => 0, countByUser: () => ({}) },
      slotPool,
      browserManager: null,
      egressPolicy,
    })
    return { client, egressPolicy }
  }

  test('注册响应里的策略当场生效', async () => {
    responseBody.egress = { mode: 'open', revision: 'r1', allow: [], leaseAllow: [] }
    const pool = fakeSlotPool()
    const { client, egressPolicy } = makeClient(pool)
    await client.registerOnce()
    assert.equal(egressPolicy.current().enforce, false)
    assert.deepEqual(pool.calls, ['applyPolicy'])
  })

  test('策略没变时不重复重编排', async () => {
    responseBody.egress = { mode: 'allowlist', revision: 'r1', allow: [{ host: 'a.xiaocaicai.com', ports: [443] }] }
    const pool = fakeSlotPool()
    const { client } = makeClient(pool)
    await client.registerOnce()
    await client.registerOnce()
    assert.equal(pool.calls.length, 1, '同一份策略不该被反复挂')
  })

  test('管理端不带 egress（老版本）时节点什么都不做', async () => {
    const pool = fakeSlotPool()
    const { client, egressPolicy } = makeClient(pool)
    await client.registerOnce()
    assert.deepEqual(pool.calls, [])
    assert.equal(egressPolicy.current().source, 'env')
    assert.equal(egressPolicy.current().enforce, true)
  })

  test('重编排失败不影响节点服务能力', async () => {
    responseBody.egress = { mode: 'open', revision: 'r1' }
    const pool = {
      status: () => ({ cgroupVersion: 'v2' }),
      egressState: () => ({}),
      allowEgressAll: async () => {},
      applyPolicy: async () => { throw new Error('iptables 挂了') },
    }
    const { client } = makeClient(pool)
    await assert.doesNotReject(() => client.registerOnce())
  })

  test('注册与心跳都上报本节点的实际生效情况', async () => {
    // 两条路径的字段是各自组装的，所以要各自断言 —— 只测注册的话，
    // 心跳漏掉这个字段不会被发现，而管理台是靠心跳判断策略铺开了没的
    // （注册只在启动时发生一次，之后再也不会更新）。
    const expected = { mode: 'allowlist', revision: '', pendingSlots: 0, totalSlots: 1 }
    const pool = fakeSlotPool()
    const { client } = makeClient(pool)

    await client.registerOnce()
    assert.deepEqual(received[0].body.egress, expected, '注册没带上生效情况')

    await client.heartbeatOnce()
    assert.match(received[1].url, /heartbeat/)
    assert.deepEqual(received[1].body.egress, expected, '心跳没带上生效情况')
  })

  test('心跳里的策略变更当场生效 —— 改完管理端不必重启节点', async () => {
    const pool = fakeSlotPool()
    const { client, egressPolicy } = makeClient(pool)
    await client.registerOnce()
    assert.equal(egressPolicy.current().enforce, true)

    responseBody.egress = { mode: 'open', revision: 'r2', allow: [], leaseAllow: [] }
    await client.heartbeatOnce()
    assert.equal(egressPolicy.current().enforce, false, '心跳下发的策略没生效')
    assert.deepEqual(pool.calls, ['applyPolicy'])
  })
})

describe('租约级放行随策略走', () => {
  let app
  let baseUrl
  let manager
  let applied
  let egressPolicy

  const TOKEN = 'egress-policy-token-0123456789'
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  function pool() {
    return {
      acquire: () => ({
        index: 0,
        sentinel: { pid: 1 },
        hostWorkspace: { workDir: '/tmp/fake/work', baseDir: '/tmp/fake', homeDir: '/tmp/fake/home', tmpDir: '/tmp/fake/tmp' },
        guest: { workDir: '/work', homeDir: '/home/job', tmpDir: '/tmp' },
      }),
      async release() {},
      async allowEgress(_slot, entries) { applied.push(entries); return entries },
      status: () => ({ slots: [], egress: { extraAllowed: [] } }),
    }
  }

  beforeEach(async () => {
    applied = []
    const config = loadConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: TOKEN,
      SANDBOX_SLOTS: '1',
      SANDBOX_ADVERTISE_BASE: 'http://127.0.0.1:0',
      SANDBOX_EGRESS_LEASE_ALLOW: 'oss.xiaocaicai.com:443',
    })
    egressPolicy = createEgressPolicyStore({ config, logger: silent })
    const slotPool = pool()
    manager = createLeaseManager({ config, logger: silent, slotPool })
    app = createServer({ config, logger: silent, leaseManager: manager, slotPool, egressPolicy })
    baseUrl = `http://127.0.0.1:${(await app.listen(0)).port}`
  })

  afterEach(async () => {
    await manager.releaseAll('test')
    await app.close()
  })

  const lease = (body) => fetch(`${baseUrl}/v1/leases`, {
    method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r', username: 'e', ...body }),
  })

  test('管理端下发的准入清单取代本地 env', async () => {
    // 本地 env 只允许 oss.xiaocaicai.com，管理端换成 cdn.xiaocaicai.com —— 应当按管理端的来。
    egressPolicy.update({ mode: 'allowlist', revision: 'r1', allow: [], leaseAllow: [{ host: 'cdn.xiaocaicai.com', ports: [443] }] })

    assert.equal((await lease({ egressAllow: ['cdn.xiaocaicai.com:443'] })).status, 200)
    assert.deepEqual(applied, [[{ host: 'cdn.xiaocaicai.com', ports: [443] }]])

    const stale = await lease({ egressAllow: ['oss.xiaocaicai.com:443'] })
    assert.equal(stale.status, 400, '本地 env 里的目标不该还能用')
    assert.equal((await stale.json()).error, 'egress-not-permitted')
  })

  test('不拦的时候不按清单筛 —— 否则"申请被拒但那个地址其实通的"说不通', async () => {
    egressPolicy.update({ mode: 'open', revision: 'r1' })
    const res = await lease({ egressAllow: ['anything.example.com'] })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).egressEnforced, false, '调用方要能知道为什么 egress 是空的')
    assert.deepEqual(applied, [], '链是空的，插 ACCEPT 没有意义')
  })

  test('拦的时候租约响应如实报告 enforced', async () => {
    const res = await lease({})
    assert.equal((await res.json()).egressEnforced, true)
  })
})
