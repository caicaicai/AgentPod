/**
 * manager 模式端到端：agent 客户端 × 假 manager × **两个真实 worker**。
 *
 * 这条链路横跨三个代码库（agent / sandbox-manager / sandbox-worker），只测一端
 * 等于没测：票据的编码、username 的传递方向、候选轮转、租约级凭据，每一处两边理解
 * 不一致的现象都是"调度成功但换不到租约"或"exec 401"，而各自的日志都正常。
 *
 * 假 manager 用 Node crypto 按 `sandbox-manager/modules/ticket.lua` 的算法签票据。
 * 那个算法与真实 Lua 实现的一致性，在 sandbox-worker/test/manager.test.js 和
 * 一次 Lua↔Node 的实签实验里已经验过；这里复用它来测**协议流程**。
 *
 * 需要 Linux + CAP_SYS_ADMIN + CAP_NET_ADMIN（worker 唯一的执行路径是 namespace 隔离）。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadConfig as loadWorkerConfig } from '../sandbox-worker/src/config.js'
import { createLeaseManager } from '../sandbox-worker/src/leases.js'
import { createSlotPool } from '../sandbox-worker/src/namespace/slot-pool.js'
import { createServer as createWorkerServer } from '../sandbox-worker/src/server.js'
import { probeNamespaceSupport } from '../sandbox-worker/test/support.js'
import { createHttpSandbox } from '../src/sandbox/client.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

const SECRET = 'e2e-ticket-secret-0123456789'
const STATIC_TOKEN = 'e2e-static-token-abcdef'

// ── 票据签发：与 sandbox-manager/modules/ticket.lua 同算法 ──────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function issueTicket({ nodeId, runId, username, secret = SECRET, ttlMs = 60000 }) {
  const body = b64url(JSON.stringify({
    nid: nodeId,
    run: runId,
    username,
    exp: Date.now() + ttlMs,
    jti: `jti-${Math.random().toString(16).slice(2)}-${Date.now()}`,
  }))
  return `${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
}

/**
 * 假 manager。行为对齐 sandbox-manager/workers/api/schedule.lua：
 * 返回一组候选，每个候选带一张只对它有效的票据。
 */
function createFakeManager() {
  let nodes = []            // { nodeId, base }
  let ticketSecret = SECRET
  let forceNoCapacity = false
  const scheduleCalls = []

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v1/sandbox/schedule') {
      res.writeHead(404).end('{}')
      return
    }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      scheduleCalls.push({ body, code: req.headers['x-api-securitycode'] })

      if (forceNoCapacity || nodes.length === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'no-capacity' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        ticketTtlMs: 60000,
        candidates: nodes.map((n) => ({
          nodeId: n.nodeId,
          base: n.base,
          ticket: issueTicket({ nodeId: n.nodeId, runId: body.runId, username: body.username, secret: ticketSecret }),
          free: 1,
        })),
      }))
    })
  })

  return {
    server,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      return `http://127.0.0.1:${server.address().port}`
    },
    async close() { await new Promise((resolve) => server.close(resolve)) },
    setNodes(list) { nodes = list },
    setTicketSecret(s) { ticketSecret = s },
    setNoCapacity(v) { forceNoCapacity = v },
    get calls() { return scheduleCalls },
    reset() { forceNoCapacity = false; ticketSecret = SECRET; scheduleCalls.length = 0 },
  }
}

const support = await probeNamespaceSupport()

describe('沙盒 manager 模式端到端', { skip: support.ok ? false : `跳过：${support.reason}` }, () => {
  const workers = []
  let manager
  let managerUrl

  /** 起一个真实 worker。每个用独立的网桥/网段/cgroup 根/uid 段，免得互相踩。 */
  async function startWorker({ index, nodeId, acceptStaticToken = true, slots = 1 }) {
    const workRoot = await mkdtemp(path.join('/var/tmp', `mgr-e2e-${index}-`))
    const config = loadWorkerConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: STATIC_TOKEN,
      SANDBOX_SLOTS: String(slots),
      SANDBOX_WORK_ROOT: workRoot,
      SANDBOX_ADVERTISE_BASE: 'http://127.0.0.1:1',   // listen 之后用真实端口覆盖
      SANDBOX_NS_BRIDGE: `mgre2e${index}`,
      SANDBOX_NS_SUBNET: `10.24${index}.0.0/16`,
      SANDBOX_NS_CGROUP_ROOT: `/sys/fs/cgroup/ap-mgre2e-${index}`,
      SANDBOX_NS_JOB_UID_BASE: String(30000 + index * 100),
      EXEC_DEFAULT_TIMEOUT_MS: '15000',
      EXEC_MAX_TIMEOUT_MS: '20000',
      SANDBOX_MANAGER_URL: 'http://127.0.0.1:1',      // 只为开启票据校验，不真的注册
      SANDBOX_MANAGER_CODE: 'unused',
      SANDBOX_TICKET_SECRET: SECRET,
      SANDBOX_NODE_ID: nodeId,
      SANDBOX_ACCEPT_STATIC_TOKEN: acceptStaticToken ? '1' : '0',
    })

    const slotPool = createSlotPool({ config, logger: silentLogger })
    await slotPool.init()
    const leaseManager = createLeaseManager({ config, logger: silentLogger, slotPool })
    const app = createWorkerServer({ config, logger: silentLogger, leaseManager, slotPool })
    const address = await app.listen(0)
    const base = `http://127.0.0.1:${address.port}`
    config.advertiseBase = base

    const worker = { nodeId, base, config, slotPool, leaseManager, app, workRoot }
    workers.push(worker)
    return worker
  }

  function agentSandbox(overrides = {}) {
    return createHttpSandbox({
      config: {
        sandbox: {
          mode: 'manager',
          managerUrl,
          managerCode: 'caller-code',
          pool: 'default',
          needBrowser: false,
          token: '',                 // manager 模式下 agent 不持有长期凭据
          timeoutMs: 8000,
          ...overrides,
        },
      },
      logger: silentLogger,
    })
  }

  before(async () => {
    manager = createFakeManager()
    managerUrl = await manager.listen()
    await startWorker({ index: 1, nodeId: 'e2e-node-1' })
    await startWorker({ index: 2, nodeId: 'e2e-node-2' })
    manager.setNodes(workers.map((w) => ({ nodeId: w.nodeId, base: w.base })))
  })

  after(async () => {
    for (const w of workers) {
      await w.leaseManager.releaseAll('teardown').catch(() => {})
      await w.app.close().catch(() => {})
      await w.slotPool.shutdown().catch(() => {})
      await rm(w.workRoot, { recursive: true, force: true }).catch(() => {})
    }
    await manager?.close()
  })

  beforeEach(async () => {
    manager.reset()
    manager.setNodes(workers.map((w) => ({ nodeId: w.nodeId, base: w.base })))
    for (const w of workers) await w.leaseManager.releaseAll('reset')
  })

  test('调度 → 票据换租约 → exec → 释放，整条链路走通', async () => {
    const sandbox = agentSandbox()
    const session = sandbox.createSession({ runId: 'run-1', username: 'zhangsan' })

    let out = ''
    const result = await session.exec({ command: 'echo manager-mode-ok', onData: (chunk) => { out += chunk } })
    assert.equal(result.exitCode, 0)
    assert.match(out, /manager-mode-ok/)

    assert.equal(manager.calls.length, 1, '只该调度一次')
    assert.equal(manager.calls[0].code, 'caller-code', '调度请求要带调用方令牌')
    await session.release()
  })

  test('username 取自票据载荷，不取自请求体 —— 调用方伪造不了身份', async () => {
    const worker = workers[0]

    // 不带 username 的请求体也能成功：说明 username 确实是从票据里读的
    const fromTicket = await fetch(`${worker.base}/v1/leases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issueTicket({ nodeId: worker.nodeId, runId: 'r', username: 'zhangsan' })}`,
      },
      body: JSON.stringify({ runId: 'r' }),
    })
    assert.equal(fromTicket.status, 200)
    const lease = await fromTicket.json()
    assert.equal(worker.leaseManager.get(lease.leaseId).username, 'zhangsan', '租约上的 username 应来自票据')
    await worker.leaseManager.release(lease.leaseId)

    // 请求体里塞一个不同的 username 要被明确拒绝，而不是静默以票据为准 ——
    // 静默会把调用方的 bug 藏到"会话数据串到别人名下"才暴露
    const mismatch = await fetch(`${worker.base}/v1/leases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issueTicket({ nodeId: worker.nodeId, runId: 'r', username: 'zhangsan' })}`,
      },
      body: JSON.stringify({ runId: 'r', username: 'lisi' }),
    })
    assert.equal(mismatch.status, 400)
    assert.equal((await mismatch.json()).error, 'username-mismatch')
  })

  test('agent 客户端不往请求体里放 username', async () => {
    const sandbox = agentSandbox()
    const session = sandbox.createSession({ runId: 'run-2', username: 'lisi' })
    await session.exec({ command: 'true' })

    const holder = workers.find((w) => w.leaseManager.count() > 0)
    assert.ok(holder, '应该有一个 worker 持有租约')
    // 能建立租约本身就证明 agent 没有传一个与票据冲突的 username（传了会 400）
    assert.equal(holder.leaseManager.count(), 1)
    await session.release()
  })

  test('第一个候选满了会自动试下一个', async () => {
    // 先把 node-1 占满（它只有 1 个槽位）
    const occupied = await workers[0].leaseManager.acquire({ runId: 'squatter', username: 'other' })
    assert.ok(occupied, '前提：先占住 node-1')

    const sandbox = agentSandbox()
    const session = sandbox.createSession({ runId: 'run-3', username: 'zhangsan' })
    await session.exec({ command: 'true' })

    assert.equal(workers[1].leaseManager.count(), 1, '应该落到 node-2')
    assert.equal(manager.calls.length, 1, '候选轮转发生在本地，不该回头再问 manager')

    await session.release()
    await workers[0].leaseManager.release(occupied.leaseId)
  })

  test('所有候选都满时报"没有空闲槽位"，而不是笼统失败', async () => {
    const held = []
    for (const w of workers) {
      const lease = await w.leaseManager.acquire({ runId: 'squatter', username: 'other' })
      assert.ok(lease)
      held.push([w, lease.leaseId])
    }

    const sandbox = agentSandbox()
    const session = sandbox.createSession({ runId: 'run-4', username: 'zhangsan' })
    await assert.rejects(
      () => session.exec({ command: 'true' }),
      (error) => {
        assert.match(String(error.message), /没有空闲槽位/)
        return true
      },
    )
    // 试满了才放弃：每一轮都会重新调度一次
    assert.ok(manager.calls.length > 1, `应该重试若干轮，实际 ${manager.calls.length}`)

    for (const [w, id] of held) await w.leaseManager.release(id)
  })

  test('manager 说没有可调度节点时给出可区分的提示', async () => {
    manager.setNoCapacity(true)
    const sandbox = agentSandbox()
    const session = sandbox.createSession({ runId: 'run-5', username: 'zhangsan' })
    await assert.rejects(
      () => session.exec({ command: 'true' }),
      (error) => {
        assert.match(String(error.message), /没有可调度节点|调度不可用/)
        return true
      },
    )
  })

  test('票据密钥两边不一致时所有候选都拒，不会悄悄退回静态 token', async () => {
    manager.setTicketSecret('a-completely-different-secret')
    const sandbox = agentSandbox()
    const session = sandbox.createSession({ runId: 'run-6', username: 'zhangsan' })

    await assert.rejects(() => session.exec({ command: 'true' }), /没有空闲槽位|不可用/)
    for (const w of workers) {
      assert.equal(w.leaseManager.count(), 0, `${w.nodeId} 不该建立任何租约`)
    }
  })

  test('同一张票据不能换第二次租约（防重放）', async () => {
    const worker = workers[0]
    const ticket = issueTicket({ nodeId: worker.nodeId, runId: 'replay', username: 'zhangsan' })

    const once = await fetch(`${worker.base}/v1/leases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticket}` },
      body: JSON.stringify({ runId: 'replay' }),
    })
    assert.equal(once.status, 200)
    const body = await once.json()

    const twice = await fetch(`${worker.base}/v1/leases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticket}` },
      body: JSON.stringify({ runId: 'replay' }),
    })
    assert.equal(twice.status, 401, '同一张票据第二次必须被拒')

    await worker.leaseManager.release(body.leaseId)
  })

  test('租约响应带 leaseToken，且它就是后续操作的凭据', async () => {
    const worker = workers[0]
    const ticket = issueTicket({ nodeId: worker.nodeId, runId: 'scoped', username: 'zhangsan' })
    const res = await fetch(`${worker.base}/v1/leases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticket}` },
      body: JSON.stringify({ runId: 'scoped' }),
    })
    const lease = await res.json()
    assert.ok(lease.leaseToken && lease.leaseToken.length >= 32, '应下发租约级凭据')

    // 用它可以 exec
    const ok = await fetch(`${worker.base}/v1/leases/${lease.leaseId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lease.leaseToken}` },
      body: JSON.stringify({ command: 'true' }),
    })
    assert.equal(ok.status, 200)

    // 换一个租约的凭据就不行 —— 这是"只能操作自己那个租约"的核心
    const other = await fetch(`${worker.base}/v1/leases/${lease.leaseId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'f'.repeat(48) },
      body: JSON.stringify({ command: 'true' }),
    })
    assert.equal(other.status, 401, '别的凭据不该能操作这个租约')

    await worker.leaseManager.release(lease.leaseId)
  })

  test('关掉静态 token 之后，长期凭据彻底换不到租约', async () => {
    const strict = await startWorker({ index: 3, nodeId: 'e2e-node-strict', acceptStaticToken: false })

    const withStatic = await fetch(`${strict.base}/v1/leases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STATIC_TOKEN}` },
      body: JSON.stringify({ runId: 'r', username: 'zhangsan' }),
    })
    assert.equal(withStatic.status, 401, '迁移第 3 步之后静态 token 必须失效')

    const withTicket = await fetch(`${strict.base}/v1/leases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issueTicket({ nodeId: strict.nodeId, runId: 'r', username: 'zhangsan' })}`,
      },
      body: JSON.stringify({ runId: 'r' }),
    })
    assert.equal(withTicket.status, 200, '票据仍然要能用')
    const lease = await withTicket.json()
    await strict.leaseManager.release(lease.leaseId)
  })
})
