/**
 * 异步执行 + 断线续传（agent 客户端一侧）。
 *
 * 同步流中途断了这条命令就没了。B/S 之后网络抖一下、网关掐一次空闲连接，一条跑了
 * 四分钟的 `npm install` 就白跑，而且工作区里留下的是**半装完的 node_modules** ——
 * 比彻底没跑还糟。
 *
 * 用假 worker：这里测的是客户端的重连与去重，与隔离、与真的能不能跑命令无关，
 * 不该跟着 Linux-only 的用例一起跳过。节点侧的对应用例在
 * sandbox-worker/test/sandbox.test.js「异步执行：断开 ≠ 放弃」。
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createHttpSandbox } from '../src/sandbox/client.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }
const STATIC_TOKEN = 'resume-static-token'
const EXEC_ID = 'exe_0123456789abcdef'

/** 节点会产出的帧。seq 连续，最后一帧是 exit。 */
const SCRIPT = [
  { seq: 1, type: 'stdout', data: 'aaa' },
  { seq: 2, type: 'stdout', data: 'bbb' },
  { seq: 3, type: 'stdout', data: 'ccc' },
  { seq: 4, type: 'exit', exitCode: 0, signal: null, truncated: false, durationMs: 12, status: 'completed' },
]

/**
 * @param cutAfter 每次事件流写几帧就中断（模拟网关/网络）。`Infinity` = 正常写完。
 * @param cutTimes 前几次连接会被中断；之后的连接正常完成。
 * @param cutMode  `destroy` = 连接被粗暴掐掉（客户端读到网络错误）；
 *                 `end`     = **干净地关闭响应但不发终止帧**。后者是反向代理和
 *                 网关最常见的行为，而且在客户端看来与"命令跑完了"长得一模一样 ——
 *                 只有"收没收到 exit 帧"能区分。不测这一种的话，"把流结束当成
 *                 命令结束"这个 bug 可以毫发无损地活下来。
 */
function createFakeWorker({ execAsync = true, cutAfter = Infinity, cutTimes = 0, cutMode = 'destroy' } = {}) {
  const calls = { exec: [], events: [], deletes: [] }
  let base = ''
  let attempts = 0

  const server = http.createServer(async (req, res) => {
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const url = new URL(req.url, 'http://x')

    if (req.method === 'POST' && url.pathname === '/v1/leases') {
      return json(200, {
        ok: true,
        leaseId: 'lease_fake0000',
        leaseToken: 'lease-scoped-token',
        workerBase: base,
        expiresAt: Date.now() + 600000,
        idleTimeoutMs: 600000,
        features: execAsync ? { execAsync: true } : {},
        slots: { used: 1, total: 2 },
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/leases/lease_fake0000/exec') {
      const raw = await new Promise((resolve) => {
        let buf = ''
        req.on('data', (c) => { buf += c })
        req.on('end', () => resolve(buf))
      })
      const body = JSON.parse(raw || '{}')
      calls.exec.push(body)
      if (body.async) return json(200, { ok: true, execId: EXEC_ID, startedAt: Date.now() })
      // 同步流：一次性写完
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      for (const frame of SCRIPT) res.write(`${JSON.stringify(frame)}\n`)
      return res.end()
    }

    if (req.method === 'GET' && url.pathname === `/v1/leases/lease_fake0000/execs/${EXEC_ID}/events`) {
      const fromSeq = Number(url.searchParams.get('fromSeq')) || 0
      calls.events.push(fromSeq)
      attempts += 1
      const willCut = attempts <= cutTimes

      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      let written = 0
      let cut = false
      for (const frame of SCRIPT) {
        if (frame.seq <= fromSeq) continue
        if (willCut && written >= cutAfter) { cut = true; break }
        res.write(`${JSON.stringify(frame)}\n`)
        written += 1
      }
      if (!cut) return res.end()
      // 干净地关掉：客户端那边 reader 正常 done，与"命令跑完了"无法从传输层区分
      if (cutMode === 'end') return res.end()
      // 掐断：不是优雅结束，是连接直接没了。
      // **必须先让已写的帧真的发出去再 destroy** —— 紧挨着 write 调 destroy 会把
      // 还在缓冲区里的数据一起丢掉，客户端一帧都收不到，那模拟的就不是"断在半路"
      // 而是"什么都没发"，续传自然无从谈起（这条用例第一版就是这么假绿的）。
      return setTimeout(() => res.destroy(), 30)
    }

    if (req.method === 'DELETE' && url.pathname === `/v1/leases/lease_fake0000/execs/${EXEC_ID}`) {
      calls.deletes.push(Date.now())
      return json(200, { ok: true, aborted: true })
    }

    if (req.method === 'DELETE' && url.pathname === '/v1/leases/lease_fake0000') {
      return json(200, { ok: true, released: true })
    }
    return json(404, { ok: false, error: 'not-found', path: url.pathname })
  })

  return {
    calls,
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

function makeSession(url, overrides = {}) {
  return createHttpSandbox({
    config: {
      sandbox: {
        mode: 'http', url, token: STATIC_TOKEN, timeoutMs: 5000,
        keepalive: false, execAsync: true, ...overrides,
      },
    },
    logger: silentLogger,
  }).createSession({ runId: 'r1', username: 'zhangsan' })
}

describe('沙盒异步执行与断线续传', () => {
  let worker

  afterEach(async () => {
    if (worker) await worker.close()
    worker = null
  })

  async function run(workerOptions = {}, sandboxOverrides = {}) {
    worker = createFakeWorker(workerOptions)
    const url = await worker.listen()
    const session = makeSession(url, sandboxOverrides)
    const chunks = []
    const result = await session.exec({
      command: 'echo hi',
      onData: (buf) => chunks.push(buf.toString()),
    })
    return { result, output: chunks.join(''), session }
  }

  test('节点声明支持时走异步任务', async () => {
    const { result, output } = await run()
    assert.equal(worker.calls.exec[0].async, true)
    assert.equal(output, 'aaabbbccc')
    assert.equal(result.exitCode, 0)
  })

  test('流被掐断后带 fromSeq 续传，输出不重不漏', async () => {
    // 第一次连接写 2 帧就被掐；客户端应当带着 seq=2 回来，只取 3、4。
    const { result, output } = await run({ cutAfter: 2, cutTimes: 1 })
    assert.deepEqual(worker.calls.events, [0, 2], '续传没有带上断点')
    assert.equal(output, 'aaabbbccc', '输出重了或漏了')
    assert.equal(result.exitCode, 0)
    assert.equal(worker.calls.deletes.length, 0, '正常完成不该通知节点放弃')
  })

  test('流被干净地关掉但没有终止帧时照样续传 —— 流结束 ≠ 命令跑完', async () => {
    // 反向代理/网关掐空闲连接时往往是**优雅关闭**，客户端读到的是正常的流结束。
    // 只看"流结束了"就收工的话，会把一条还在跑的命令当成"退出码 null 且成功"，
    // 模型据此往下走，错得毫无线索。
    const { result, output } = await run({ cutAfter: 2, cutTimes: 1, cutMode: 'end' })
    assert.deepEqual(worker.calls.events, [0, 2], '没有续传，多半是把流结束当成命令结束了')
    assert.equal(output, 'aaabbbccc')
    assert.equal(result.exitCode, 0)
  })

  test('连断多次也能续上，每次都从新断点接着取', async () => {
    const { output, result } = await run({ cutAfter: 1, cutTimes: 2 })
    assert.deepEqual(worker.calls.events, [0, 1, 2])
    assert.equal(output, 'aaabbbccc')
    assert.equal(result.exitCode, 0)
  })

  test('重试用完仍拿不到终止帧：明确报错，并通知节点放弃', async () => {
    // 不通知的话，那条命令会一直在节点上跑到自己超时，白占着这个租约的资源。
    //
    // cutAfter: 0 = 每次连上都立刻断，一帧也送不出去。用 1 是不行的：
    // 重试有 4 次、脚本只有 4 帧，"每次送一帧"正好把它送完，反而会成功。
    worker = createFakeWorker({ cutAfter: 0, cutTimes: 99 })
    const url = await worker.listen()
    const session = makeSession(url)

    await assert.rejects(
      () => session.exec({ command: 'x', onData: () => {} }),
      /反复中断/,
    )
    assert.equal(worker.calls.deletes.length, 1, '放弃时必须通知节点杀掉命令')
  })

  test('调用方中止时通知节点放弃 —— 这才是"放弃"', async () => {
    worker = createFakeWorker({ cutAfter: 0, cutTimes: 99 })
    const url = await worker.listen()
    const session = makeSession(url)

    const controller = new AbortController()
    const running = session.exec({ command: 'x', signal: controller.signal, onData: () => {} })
    setTimeout(() => controller.abort(), 50)

    await assert.rejects(() => running, /超时或被中止/)
    assert.equal(worker.calls.deletes.length, 1)
  })

  test('老版本节点不声明能力时退回同步流', async () => {
    // 靠节点自报能力，不是"试一下看会不会 404" —— 后者在滚动发布期间
    // 会在正常路径上刷一片吓人的错误日志。
    const { result, output } = await run({ execAsync: false })
    assert.equal(worker.calls.exec[0].async, undefined)
    assert.equal(worker.calls.events.length, 0)
    assert.equal(output, 'aaabbbccc')
    assert.equal(result.exitCode, 0)
  })

  test('SANDBOX_EXEC_ASYNC=0 时即使节点支持也走同步流', async () => {
    const { output } = await run({}, { execAsync: false })
    assert.equal(worker.calls.exec[0].async, undefined)
    assert.equal(output, 'aaabbbccc')
  })
  /**
   * onData 是可选的。
   *
   * 它从前是个**隐式必填**：不传也能建请求、也能拿到 exit，直到命令真的往
   * stdout/stderr 写了一个字节，才在 readNdjson 里炸成 "onData is not a function"。
   * 于是"只关心退没退成功、不关心输出"的调用方（技能搬运时建 skills/.venv
   * 就是一个）在命令安静时一切正常，一旦命令报了句错就连错误本身都拿不到 ——
   * 失败被换成了一个面目全非的 TypeError。
   */
  test('不传 onData 也能跑完，输出直接丢弃', async () => {
    worker = createFakeWorker()
    const url = await worker.listen()
    const session = makeSession(url)

    const result = await session.exec({ command: 'echo hi' })
    assert.equal(result.exitCode, 0)
  })

  test('不传 onData 时同步流一样不炸', async () => {
    worker = createFakeWorker({ execAsync: false })
    const url = await worker.listen()
    const session = makeSession(url, { execAsync: false })

    const result = await session.exec({ command: 'echo hi' })
    assert.equal(result.exitCode, 0)
  })

})
