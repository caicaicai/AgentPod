/**
 * 额外出站放行配置的解析。
 *
 * 这个配置是在承重墙上开门，解析错一条的后果不对称：
 *   - 少放行 → 那个站点打不开，看得见、查得到；
 *   - **多放行 → 沙盒能连到本不该连的地方，没有任何现象**。
 * 所以宁可丢弃看不懂的条目，也不要猜。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseEgressAllow, screenEgressRequest } from '../src/namespace/netns.js'
import { loadConfig } from '../src/config.js'
import { createLeaseManager } from '../src/leases.js'
import { createServer } from '../src/server.js'
import { createEgressPolicyStore } from '../src/egress-policy.js'

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

describe('出站额外放行的解析', () => {
  test('默认为空 —— 不配就是今天的行为', () => {
    assert.deepEqual(parseEgressAllow(''), [])
    assert.deepEqual(parseEgressAllow(undefined), [])
    assert.deepEqual(parseEgressAllow(null), [])
  })

  test('写了端口就只放行那一个', () => {
    assert.deepEqual(parseEgressAllow('internal.example.com:8080'), [
      { host: 'internal.example.com', ports: [8080] },
    ])
  })

  test('多条用逗号分隔，允许有空格', () => {
    assert.deepEqual(parseEgressAllow(' a.example.com , b.example.com:8443 '), [
      { host: 'a.example.com', ports: [80, 443] },
      { host: 'b.example.com', ports: [8443] },
    ])
  })

  test('非法端口整条丢弃，不退化成放行全部端口', () => {
    // 关键：`host:abc` 如果被解析成"只有 host"，就等于把 80/443 都开了 ——
    // 一个笔误换来一道没人打算开的门。
    for (const bad of ['h.example.com:abc', 'h.example.com:0', 'h.example.com:70000', 'h.example.com:-1']) {
      assert.deepEqual(parseEgressAllow(bad), [], `应整条丢弃：${bad}`)
    }
  })

  test('空条目被忽略', () => {
    assert.deepEqual(parseEgressAllow(',,  ,'), [])
    assert.deepEqual(parseEgressAllow('a.example.com,,'), [
      { host: 'a.example.com', ports: [80, 443] },
    ])
  })
})

describe('租约级出站放行：准入清单', () => {
  const menu = (raw) => parseEgressAllow(raw)

  test('清单为空时任何申请都被拒 —— 默认不给开', () => {
    const { allowed, rejected } = screenEgressRequest(parseEgressAllow('a.xiaocaicai.com'), menu(''))
    assert.deepEqual(allowed, [])
    assert.deepEqual(rejected, ['a.xiaocaicai.com:80/443'])
  })

  test('主机名必须完全相同，不做后缀匹配', () => {
    // 若 `xiaocaicai.com` 能匹配 `evil-xiaocaicai.com` 或 `a.xiaocaicai.com`，这份清单就形同虚设，
    // 而写清单的人多半意识不到自己开的是一整个后缀。
    const list = menu('xiaocaicai.com')
    for (const host of ['evil-xiaocaicai.com', 'a.xiaocaicai.com', 'xiaocaicai.com.evil.net', 'xiaocaicai.COM']) {
      const { allowed, rejected } = screenEgressRequest(parseEgressAllow(host), list)
      assert.deepEqual(allowed, [], `${host} 不该被放行`)
      assert.equal(rejected.length, 1)
    }
    assert.equal(screenEgressRequest(parseEgressAllow('xiaocaicai.com'), list).allowed.length, 1)
  })

  test('端口必须是清单允许端口的子集', () => {
    const list = menu('oss.xiaocaicai.com:443')
    assert.deepEqual(screenEgressRequest(parseEgressAllow('oss.xiaocaicai.com:443'), list).allowed,
      [{ host: 'oss.xiaocaicai.com', ports: [443] }])
    // 只允许 443 时，不写端口（要 80+443）只能拿到 443，拿不到 80
    assert.deepEqual(screenEgressRequest(parseEgressAllow('oss.xiaocaicai.com'), list).allowed,
      [{ host: 'oss.xiaocaicai.com', ports: [443] }])
    assert.deepEqual(screenEgressRequest(parseEgressAllow('oss.xiaocaicai.com:8080'), list).rejected,
      ['oss.xiaocaicai.com:8080'])
  })

  test('同一主机在清单里出现多次时端口取并集', () => {
    const list = menu('a.xiaocaicai.com:80,a.xiaocaicai.com:8443')
    assert.deepEqual(screenEgressRequest(parseEgressAllow('a.xiaocaicai.com:8443'), list).allowed,
      [{ host: 'a.xiaocaicai.com', ports: [8443] }])
  })

  test('部分命中时，被拒的原样报出来而不是静默丢弃', () => {
    // 静默丢弃的话调用方以为开了，然后对着 Connection refused
    // 一路往技能自己身上找原因。
    const { allowed, rejected } = screenEgressRequest(
      parseEgressAllow('ok.xiaocaicai.com,bad.example.com'), menu('ok.xiaocaicai.com'))
    assert.equal(allowed.length, 1)
    assert.deepEqual(rejected, ['bad.example.com:80/443'])
  })
})

describe('租约级出站放行：HTTP 面', () => {
  let app
  let baseUrl
  let manager
  let applied

  const TOKEN = 'egress-http-token-0123456789'
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  /** 假 slot 池：只记录"被要求开了什么"，不真碰 iptables（那需要 Linux + 特权） */
  function pool() {
    return {
      acquire() {
        return {
          index: 0,
          sentinel: { pid: 1 },
          hostWorkspace: { workDir: '/tmp/fake/work', baseDir: '/tmp/fake', homeDir: '/tmp/fake/home', tmpDir: '/tmp/fake/tmp' },
          guest: { workDir: '/work', homeDir: '/home/job', tmpDir: '/tmp' },
        }
      },
      async release() {},
      async allowEgress(slot, entries) { applied.push(entries); return entries.map((e) => ({ ...e, ips: ['1.2.3.4'] })) },
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
    const slotPool = pool()
    manager = createLeaseManager({ config, logger: silent, slotPool })
    app = createServer({
      config, logger: silent, leaseManager: manager, slotPool,
      egressPolicy: createEgressPolicyStore({ config, logger: silent }),
    })
    baseUrl = `http://127.0.0.1:${(await app.listen(0)).port}`
  })

  afterEach(async () => {
    await manager.releaseAll('test')
    await app.close()
  })

  const lease = (body) => fetch(`${baseUrl}/v1/leases`, {
    method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r', username: 'e', ...body }),
  })

  test('清单内的目标：规则挂上去，并在租约详情里可见', async () => {
    const res = await lease({ egressAllow: ['oss.xiaocaicai.com:443'] })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(applied, [[{ host: 'oss.xiaocaicai.com', ports: [443] }]])

    const view = await (await fetch(`${baseUrl}/v1/leases/${body.leaseId}`, { headers: auth })).json()
    assert.deepEqual(view.egress, ['oss.xiaocaicai.com:443'])
  })

  test('清单外的目标：400，而且槽位不能被占掉', async () => {
    // 先校验再占槽位 —— 反过来的话一个参数写错的调用方会白白占掉一个 slot，
    // 还要等 idle 才收回来。
    const res = await lease({ egressAllow: ['evil.example.com'] })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'egress-not-permitted')
    assert.equal(manager.count(), 0, '被拒的请求占掉了槽位')
    assert.deepEqual(applied, [])
  })

  test('不申请就一条都不开 —— 默认行为不变', async () => {
    assert.equal((await lease({})).status, 200)
    assert.deepEqual(applied, [])
  })
})
