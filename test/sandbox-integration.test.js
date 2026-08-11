/**
 * agent service 的沙盒客户端 × 真实的 sandbox worker。
 *
 * 前面 sandbox-worker/test 测的是 worker 自己，这里测的是**两端拼起来**：
 * 租约怎么申请、槽位满了怎么退、工作区在多次 exec 之间还在不在、run 结束有没有真的释放。
 * 协议是两个进程之间的约定，只测一端等于没测。
 *
 * namespace 隔离是 worker 唯一的执行路径，所以这组用例需要 Linux + CAP_SYS_ADMIN +
 * CAP_NET_ADMIN，不具备条件的机器上会清楚地跳过（见 sandbox-worker/test/support.js）。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, mkdtemp } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadConfig as loadWorkerConfig } from '../sandbox-worker/src/config.js'
import { createLeaseManager } from '../sandbox-worker/src/leases.js'
import { createSlotPool } from '../sandbox-worker/src/namespace/slot-pool.js'
import { createServer as createWorkerServer } from '../sandbox-worker/src/server.js'
import { probeNamespaceSupport } from '../sandbox-worker/test/support.js'
import { createHttpSandbox } from '../src/sandbox/client.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }
const TOKEN = 'integration-token-abcdef'

/** agent 侧看到的配置 */
function agentConfig(workerBase, overrides = {}) {
  return {
    sandbox: { mode: 'http', url: workerBase, token: TOKEN, timeoutMs: 8000, ...overrides },
  }
}

const support = await probeNamespaceSupport()

describe('沙盒端到端（agent 客户端 × 真实 worker）', { skip: support.ok ? false : `跳过：${support.reason}` }, () => {
  let workerConfig
  let slotPool
  let leaseManager
  let workerApp
  let workerBase
  let workRoot

  before(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), 'sbx-int-'))
    workerConfig = loadWorkerConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: TOKEN,
      SANDBOX_SLOTS: '1', // 故意设 1，好测"槽位满"
      SANDBOX_WORK_ROOT: workRoot,
      SANDBOX_NS_BRIDGE: 'sbxintbr0',
      SANDBOX_NS_SUBNET: '10.254.0.0/16',
      EXEC_DEFAULT_TIMEOUT_MS: '5000',
      EXEC_MAX_OUTPUT_BYTES: '4096',
      EXEC_KILL_GRACE_MS: '300',
    })
    slotPool = createSlotPool({ config: workerConfig, logger: silentLogger })
    await slotPool.init()
    leaseManager = createLeaseManager({ config: workerConfig, logger: silentLogger, slotPool })
    workerApp = createWorkerServer({ config: workerConfig, logger: silentLogger, leaseManager, slotPool })
    const address = await workerApp.listen(0)
    workerBase = `http://127.0.0.1:${address.port}`
    workerConfig.advertiseBase = workerBase
  })

  after(async () => {
    await leaseManager.releaseAll('test')
    await workerApp.close()
    await slotPool.shutdown()
    await rm(workRoot, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await leaseManager.releaseAll('reset')
  })

  /** 收集 exec 的输出 */
  function collector() {
    const chunks = []
    return { onData: (chunk) => chunks.push(chunk), text: () => Buffer.concat(chunks).toString('utf8') }
  }

  /** 当前租约的工作区根目录。槽位设成 1，所以 workRoot 下最多只有一个 slot 目录，不会有歧义。 */
  function currentWorkspaceDir() {
    const entries = readdirSync(workRoot).filter((name) => name.startsWith('slot'))
    return path.join(workRoot, entries[0] || '__none__')
  }

  test('不调 bash 就不占槽位 —— 租约是懒申请的', async () => {
    const sandbox = createHttpSandbox({ config: agentConfig(workerBase), logger: silentLogger })
    const session = sandbox.createSession({ runId: 'r1', username: 'zhangsan' })

    assert.equal(leaseManager.count(), 0, '仅仅建立 session 就占了槽位 —— 绝大多数轮次根本不执行命令，池子会被白白耗光')
    await session.release()
  })

  test('第一次 exec 才申请租约，之后工作区保持', async () => {
    const sandbox = createHttpSandbox({ config: agentConfig(workerBase), logger: silentLogger })
    const session = sandbox.createSession({ runId: 'r2', username: 'zhangsan' })

    const first = collector()
    const r1 = await session.exec({ command: 'echo step1 > f.txt && echo done', onData: first.onData })
    assert.equal(r1.exitCode, 0)
    assert.match(first.text(), /done/)
    assert.equal(leaseManager.count(), 1)

    const second = collector()
    await session.exec({ command: 'cat f.txt', onData: second.onData })
    assert.match(second.text(), /step1/, '第二次 exec 读不到第一次写的文件 —— 租约没起作用')

    await session.release()
    assert.equal(leaseManager.count(), 0, 'release 之后槽位没放开')
  })

  test('agent 侧的绝对 cwd 被剥掉，不会让 worker 拒绝执行', async () => {
    const sandbox = createHttpSandbox({ config: agentConfig(workerBase), logger: silentLogger })
    const session = sandbox.createSession({ runId: 'r3', username: 'lisi' })
    const out = collector()

    // pi 的 bash 工具传的是 agent 进程里的绝对路径，worker 容器里根本不存在
    const result = await session.exec({ command: 'pwd', cwd: '/Users/someone/tmp/ap-run-xxx/workspace', onData: out.onData })
    assert.equal(result.exitCode, 0, '绝对 cwd 没被剥掉，命令直接失败了')
    assert.match(out.text(), /\/sandbox-root\/work/, 'job 视角的 cwd 应该落在 slot 的 guest 挂载点下')

    await session.release()
  })

  test('槽位满时抛 BUSY（可重试），而不是静默失败', async () => {
    const sandbox = createHttpSandbox({ config: agentConfig(workerBase), logger: silentLogger })
    const held = sandbox.createSession({ runId: 'r4', username: 'a' })
    await held.exec({ command: 'echo hold', onData: () => {} })
    assert.equal(leaseManager.count(), 1)

    const blocked = sandbox.createSession({ runId: 'r5', username: 'b' })
    await assert.rejects(
      () => blocked.exec({ command: 'echo nope', onData: () => {} }),
      (error) => {
        assert.equal(error.code, 'BUSY')
        assert.equal(error.retryable, true, '调用方要能据此决定重试')
        return true
      },
    )
    await held.release()
  })

  test('两个用户的工作区互不可见（顺序占用同一个副本）', async () => {
    const sandbox = createHttpSandbox({ config: agentConfig(workerBase), logger: silentLogger })

    const a = sandbox.createSession({ runId: 'ra', username: 'userA' })
    await a.exec({ command: 'echo SECRET_OF_A > mine.txt', onData: () => {} })
    await a.release()

    const b = sandbox.createSession({ runId: 'rb', username: 'userB' })
    const out = collector()
    await b.exec({ command: 'cat mine.txt 2>&1 || true', onData: out.onData })
    assert.ok(!out.text().includes('SECRET_OF_A'), '后一个用户读到了前一个用户的文件')
    await b.release()
  })

  test('release 之后工作区从磁盘消失', async () => {
    const sandbox = createHttpSandbox({ config: agentConfig(workerBase), logger: silentLogger })
    const session = sandbox.createSession({ runId: 'r6', username: 'zhaoliu' })
    await session.exec({ command: 'echo data > f.txt', onData: () => {} })

    const baseDir = currentWorkspaceDir()
    assert.ok(existsSync(baseDir), '没找到工作区目录，这条用例就没在测东西')
    await session.release()
    assert.ok(!existsSync(baseDir), '工作区没删掉，磁盘上残留用户数据')
  })

  test('文件上下行：塞进去 → 命令处理 → 取回来', async () => {
    const sandbox = createHttpSandbox({ config: agentConfig(workerBase), logger: silentLogger })
    const session = sandbox.createSession({ runId: 'r7', username: 'wangwu' })

    await session.exec({ command: 'true', onData: () => {} }) // 先拿到租约
    await session.putFile({ path: 'in.txt', content: Buffer.from('hello sandbox') })
    await session.exec({ command: 'tr a-z A-Z < in.txt > out.txt', onData: () => {} })

    const got = await session.getFile({ path: 'out.txt' })
    assert.equal(got.content.toString('utf8').trim(), 'HELLO SANDBOX')
    await session.release()
  })

  test('执行期的错误以 error 帧送达模型，而不是把连接干断', async () => {
    const sandbox = createHttpSandbox({ config: agentConfig(workerBase), logger: silentLogger })
    const session = sandbox.createSession({ runId: 'r8', username: 'a' })
    const out = collector()

    const result = await session.exec({ command: 'sleep 30', timeout: 700, onData: out.onData })
    assert.equal(result.error?.code, 'TIMEOUT')
    assert.match(out.text(), /\[sandbox\]/, '模型看不到失败原因，就没法决定改命令还是换路子')
    await session.release()
  })

  test('worker 不可达时给出可重试的错误', async () => {
    const sandbox = createHttpSandbox({
      config: agentConfig(workerBase, { url: 'http://127.0.0.1:1' }),
      logger: silentLogger,
    })
    const session = sandbox.createSession({ runId: 'r9', username: 'a' })
    await assert.rejects(() => session.exec({ command: 'echo hi', onData: () => {} }), (error) => {
      assert.equal(error.retryable, true)
      return true
    })
  })
})
