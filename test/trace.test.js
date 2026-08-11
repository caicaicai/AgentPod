/**
 * 请求标识与链路追踪。
 *
 * 我们让模型在沙盒里跑任意代码，**"这条出网请求是谁发的"必须答得出来**。
 * 没有跨进程的 id，每一跳的日志都自成一体，事后只能靠时间戳猜。
 *
 * 约定：`runId` 就是这条链的 traceId —— 它本来就贯穿 agent 的一次运行、
 * 票据载荷和桥的调用，让节点也记上同一个值即可，不必再造一个平行的标识。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { resolveTraceId, newId } from '../src/trace.js'
import { loadConfig } from '../sandbox-worker/src/config.js'
import { createLeaseManager } from '../sandbox-worker/src/leases.js'
import { createServer } from '../sandbox-worker/src/server.js'

describe('traceId 的解析', () => {
  test('认上游的 x-trace-id', () => {
    assert.equal(resolveTraceId({ 'x-trace-id': 'abc-123' }), 'abc-123')
  })

  test('没有就退到 x-request-id，再没有就自己生成', () => {
    assert.equal(resolveTraceId({ 'x-request-id': 'req-9' }), 'req-9')
    assert.match(resolveTraceId({}), /^trace_[0-9a-f]{24}$/)
  })

  test('格式非法的一律不用 —— 它会进结构化日志', () => {
    // 带换行的头能往 JSON 行日志里注入伪造的行。日志注入是真实手法，
    // 而"日志里多了几行看着正常的记录"几乎不可能被发现。
    for (const bad of ['a\nb', 'a b', '{"x":1}', 'x'.repeat(200), '../../etc']) {
      assert.match(resolveTraceId({ 'x-trace-id': bad }), /^trace_/, `${JSON.stringify(bad)} 不该被采用`)
    }
  })

  test('生成的 id 不重复', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('req')))
    assert.equal(ids.size, 500)
  })
})

describe('沙盒节点的响应标识', () => {
  let app
  let manager
  let baseUrl
  let lines

  const TOKEN = 'trace-test-token-0123456789'
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  /** 收日志行，用来验"日志里真的带上了那两个 id" */
  function capturingLogger(sink) {
    const make = (base) => ({
      info: (msg, f) => sink.push({ msg, ...base, ...f }),
      warn: (msg, f) => sink.push({ msg, ...base, ...f }),
      error: (msg, f) => sink.push({ msg, ...base, ...f }),
      debug() {},
      child: (extra) => make({ ...base, ...extra }),
    })
    return make({})
  }

  beforeEach(async () => {
    lines = []
    const config = loadConfig({
      NODE_ENV: 'test', SANDBOX_TOKEN: TOKEN, SANDBOX_SLOTS: '1',
      SANDBOX_ADVERTISE_BASE: 'http://127.0.0.1:0',
    })
    const slotPool = {
      acquire: () => ({
        index: 0,
        sentinel: { pid: 1 },
        hostWorkspace: { workDir: '/tmp/fake/work', baseDir: '/tmp/fake', homeDir: '/tmp/fake/home', tmpDir: '/tmp/fake/tmp' },
        guest: { workDir: '/work', homeDir: '/home/job', tmpDir: '/tmp' },
      }),
      release: async () => {},
      status: () => ({ slots: [], egress: { extraAllowed: [] } }),
    }
    manager = createLeaseManager({ config, logger: capturingLogger(lines), slotPool })
    app = createServer({ config, logger: capturingLogger(lines), leaseManager: manager, slotPool })
    baseUrl = `http://127.0.0.1:${(await app.listen(0)).port}`
  })

  afterEach(async () => {
    await manager.releaseAll('test')
    await app.close()
  })

  test('每个响应都带 requestId，头和体各一份', async () => {
    const res = await fetch(`${baseUrl}/v1/leases`, {
      method: 'POST', headers: auth, body: JSON.stringify({ runId: 'run_1', username: 'e' }),
    })
    const body = await res.json()
    assert.match(res.headers.get('x-request-id'), /^req_[0-9a-f]{24}$/)
    assert.equal(body.requestId, res.headers.get('x-request-id'))
  })

  test('出错的响应同样带 requestId —— 那才是最需要它的时候', async () => {
    const res = await fetch(`${baseUrl}/v1/leases`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token-here', 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(res.status, 401)
    assert.ok((await res.json()).requestId)
  })

  test('上游带来的 traceId 进了日志，把两端串起来', async () => {
    await fetch(`${baseUrl}/v1/leases`, {
      method: 'POST',
      headers: { ...auth, 'x-trace-id': 'run_from_agent' },
      body: JSON.stringify({ runId: 'run_from_agent', username: 'zhangsan' }),
    })
    const withTrace = lines.filter((l) => l.traceId === 'run_from_agent')
    assert.ok(withTrace.length > 0, `没有一条日志带上 traceId：${JSON.stringify(lines)}`)
    assert.ok(withTrace.every((l) => l.requestId), '带 traceId 的行也该带 requestId')
  })

  test('不带 traceId 的请求自己生成一个，日志不会没有链路标识', async () => {
    await fetch(`${baseUrl}/v1/leases`, {
      method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r', username: 'e' }),
    })
    const tagged = lines.filter((l) => typeof l.traceId === 'string')
    assert.ok(tagged.length > 0, '一条带链路标识的日志都没有')
    // 上游没给就本地生成，格式统一
    assert.ok(tagged.every((l) => /^trace_[0-9a-f]{24}$/.test(l.traceId)))
  })
})

describe('agent 向节点发起请求时带上 traceId', () => {
  let server
  let seen
  let base

  beforeEach(async () => {
    seen = []
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, trace: req.headers['x-trace-id'] || null })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.url === '/v1/leases') {
        return res.end(JSON.stringify({
          ok: true, leaseId: 'lease_a', leaseToken: 't', workerBase: base,
          expiresAt: Date.now() + 600000, idleTimeoutMs: 600000, features: {},
        }))
      }
      return res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  test('申请租约和租约内操作都带 x-trace-id = runId', async () => {
    const { createHttpSandbox } = await import('../src/sandbox/client.js')
    const sandbox = createHttpSandbox({
      config: { sandbox: { mode: 'http', url: base, token: 'tok', timeoutMs: 5000, keepalive: false, execAsync: false } },
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this } },
    })
    const session = sandbox.createSession({ runId: 'run_abc', username: 'e' })
    await session.putFile({ path: 'a.txt', content: 'x' })

    assert.ok(seen.length >= 2)
    for (const call of seen) {
      assert.equal(call.trace, 'run_abc', `${call.url} 没带 traceId`)
    }
  })
})
