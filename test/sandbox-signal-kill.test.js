/**
 * 被信号打死的命令必须报成失败，不能报成"成功且没有输出"。
 *
 * ── 这条守的是一次 76 次工具调用、302 秒的会话 ──────────────────────
 *
 * 沙盒里的进程被 SIGKILL 后，worker 回 `exitCode: null, signal: 'SIGKILL'`。
 * 我们这边只取 exitCode、丢掉 signal，而 pi 的 bash 工具是这么判失败的：
 *
 *     if (exitCode !== 0 && exitCode !== null) throw ...      // pi bash.js:294
 *
 * `null` 被**显式当成成功**。于是硬杀在模型眼里 = 命令成功、没有输出。
 *
 * 危害不是"少一条错误信息"。模型会去解释一个不存在的现象：那一轮里它依次猜过
 * stdout 缓冲、加 `-u`、重定向到文件、改用 stderr、换 curl、"沙盒禁网了"，
 * 写了七八版脚本 —— 每一步推理都合理，因为唯一能证伪它们的事实被我们藏起来了。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createHttpSandbox } from '../src/sandbox/client.js'

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

/**
 * 假 worker：按用例给定的 exit 帧回一段 NDJSON。
 * 只实现 exec 这一条路径 —— 租约那套在 sandbox-integration.test.js 里覆盖。
 */
function startFakeWorker(framesFor) {
  const server = http.createServer((req, res) => {
    if (req.url.includes('/leases') && req.method === 'POST' && !req.url.includes('/exec')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        ok: true, leaseId: 'L1', leaseToken: 'T', workerBase: `http://127.0.0.1:${server.address().port}`,
        expiresAt: Date.now() + 60000, idleTimeoutMs: 60000, features: {},
      }))
    }
    if (req.url.includes('/exec')) {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        for (const frame of framesFor(JSON.parse(raw || '{}'))) {
          res.write(`${JSON.stringify(frame)}\n`)
        }
        res.end()
      })
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  return server
}

async function execWith(frames) {
  const server = startFakeWorker(() => frames)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const sandbox = createHttpSandbox({
    logger: silent,
    config: {
      sandbox: {
        mode: 'http', url: `http://127.0.0.1:${port}`, token: 'tok',
        timeoutMs: 5000, execAsync: false, keepalive: false,
      },
    },
  })
  const session = sandbox.createSession({ runId: 'r1', username: 'me' })
  let output = ''
  try {
    const result = await session.exec({
      runId: 'r1', username: 'me', command: 'x', onData: (chunk) => { output += chunk.toString() },
    })
    return { result, output }
  } finally {
    await session.release?.().catch(() => {})
    await new Promise((resolve) => server.close(resolve))
  }
}

describe('被信号打死的命令', () => {
  test('SIGKILL → 非零退出码（137），不能是 null', async () => {
    const { result } = await execWith([
      { type: 'exit', exitCode: null, signal: 'SIGKILL', truncated: false, durationMs: 12 },
    ])
    // null 会被 pi 当成成功 —— 这正是这条测试存在的原因
    assert.notEqual(result.exitCode, null, '被杀的命令又变成"成功"了')
    assert.equal(result.exitCode, 137, 'SIGKILL 按 shell 惯例是 128+9')
  })

  test('SIGTERM → 143', async () => {
    const { result } = await execWith([
      { type: 'exit', exitCode: null, signal: 'SIGTERM', truncated: false, durationMs: 1 },
    ])
    assert.equal(result.exitCode, 143)
  })

  test('输出里要说清是被杀的，别让模型去猜缓冲问题', async () => {
    const { output } = await execWith([
      { type: 'stdout', data: 'partial' },
      { type: 'exit', exitCode: null, signal: 'SIGKILL', truncated: false, durationMs: 3 },
    ])
    assert.match(output, /SIGKILL/)
    assert.match(output, /终止/)
    // "副作用可能没发生"是关键提示：那一轮模型反复困惑于"文件为什么没写出来"
    assert.match(output, /副作用|不完整/)
  })

  test('正常退出不受影响', async () => {
    const { result, output } = await execWith([
      { type: 'stdout', data: 'hello\n' },
      { type: 'exit', exitCode: 0, signal: null, truncated: false, durationMs: 2 },
    ])
    assert.equal(result.exitCode, 0)
    assert.equal(output, 'hello\n', '正常输出里混进了额外的话')
  })

  test('非零退出码原样保留，不被信号逻辑改写', async () => {
    const { result } = await execWith([
      { type: 'exit', exitCode: 1, signal: null, truncated: false, durationMs: 2 },
    ])
    assert.equal(result.exitCode, 1)
  })

  test('exitCode 0 且带 signal 时以 exitCode 为准', async () => {
    // 正常退出就是正常退出，signal 字段脏了也不该翻译成失败
    const { result } = await execWith([
      { type: 'exit', exitCode: 0, signal: 'SIGPIPE', truncated: false, durationMs: 2 },
    ])
    assert.equal(result.exitCode, 0)
  })
})

describe('超时与中止也要说出来', () => {
  test('timedOut 在输出里可见', async () => {
    const { output } = await execWith([
      { type: 'exit', exitCode: null, signal: 'SIGKILL', timedOut: true, truncated: false, durationMs: 9 },
    ])
    assert.match(output, /超过时间上限/)
  })

  test('aborted 在输出里可见', async () => {
    const { output } = await execWith([
      { type: 'exit', exitCode: null, signal: 'SIGTERM', aborted: true, truncated: false, durationMs: 9 },
    ])
    assert.match(output, /中止/)
  })

  test('老版本 worker 不发 timedOut/aborted 也不出错', async () => {
    // 滚动发布期间新 agent 会对上旧 worker
    const { result, output } = await execWith([
      { type: 'exit', exitCode: null, signal: 'SIGKILL', truncated: false, durationMs: 9 },
    ])
    assert.equal(result.exitCode, 137, '缺字段时主路径仍要成立')
    assert.ok(!/超过时间上限/.test(output))
    assert.ok(!/调用方放弃/.test(output))
  })
})

describe('没收到 exit 帧时不要瞎翻译', () => {
  test('流断在半路 → exitCode 保持 null，交给续传', async () => {
    // 这时命令多半还在跑。翻译成 137 等于凭空宣布它失败了。
    const { result, output } = await execWith([{ type: 'stdout', data: '跑了一半' }])
    assert.equal(result.sawExit, false)
    assert.equal(result.exitCode, null)
    assert.ok(!/终止/.test(output), '半路断流被误报成被杀')
  })
})
