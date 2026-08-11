/**
 * 异步执行任务：断开 ≠ 放弃。
 *
 * 同步 exec 在客户端断开时直接杀命令 —— 桌面端那是对的（窗口关了就是没人要了）。
 * B/S 之后不成立：切个标签页、网络抖一下、网关掐一次空闲连接，一条跑了四分钟的
 * `npm install` 就白跑，而且工作区里留下的是**半装完的 node_modules**。
 *
 * 这里不建真 namespace：`run` 是注入进来的，用假的就能把生命周期、seq 连续性、
 * 断线续传、淘汰策略全测到。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createExecJobs } from '../src/exec-jobs.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

function makeJobs(retainJobs = 8) {
  return createExecJobs({ config: { exec: { retainJobs } }, logger: silentLogger })
}

/** 只用到 running / execCount 两个字段 —— exec-jobs 碰的就这些 */
function fakeLease() {
  return { leaseId: 'lease_x', running: new Set(), execCount: 0 }
}

/** 可以由测试逐步驱动的假命令 */
function controllable() {
  let emit
  let finish
  const started = new Promise((resolve) => { emit = resolve })
  return {
    started,
    run({ onFrame, signal }) {
      emit(onFrame)
      return new Promise((resolve) => {
        finish = resolve
        signal.addEventListener('abort', () => {
          resolve({ exitCode: null, signal: 'SIGTERM', aborted: true, durationMs: 1 })
        }, { once: true })
      })
    },
    finish: (result) => finish({ exitCode: 0, durationMs: 5, ...result }),
  }
}

describe('异步执行任务', () => {
  test('立刻拿到句柄，命令在后台继续跑', async () => {
    const jobs = makeJobs()
    const lease = fakeLease()
    const cmd = controllable()

    const job = jobs.start(lease, cmd.run)
    assert.match(job.execId, /^exe_[0-9a-f]{16}$/)
    assert.equal(job.status, 'running')
    assert.equal(lease.running.size, 1, '在跑的任务要登记进租约，否则会被 idle 判定回收')
    assert.equal(lease.execCount, 1)

    const onFrame = await cmd.started
    onFrame({ type: 'stdout', data: 'hello\n' })
    cmd.finish({ exitCode: 0 })
    await job.done

    assert.equal(job.status, 'completed')
    assert.equal(lease.running.size, 0, '结束后要从租约的 running 里摘掉')
  })

  test('帧的 seq 连续，终止帧也在缓冲区里', async () => {
    // 断线的客户端回来靠的就是缓冲区里的 exit 帧才知道命令结束了、退出码是多少。
    // 只把它推给"当前订阅者"的话，断线期间结束的命令永远等不到结果。
    const jobs = makeJobs()
    const lease = fakeLease()
    const cmd = controllable()
    const job = jobs.start(lease, cmd.run)

    const onFrame = await cmd.started
    onFrame({ type: 'stdout', data: 'a' })
    onFrame({ type: 'stderr', data: 'b' })
    cmd.finish({ exitCode: 3 })
    await job.done

    assert.deepEqual(job.frames.map((f) => f.seq), [1, 2, 3])
    const exit = job.frames.at(-1)
    assert.equal(exit.type, 'exit')
    assert.equal(exit.exitCode, 3)
  })

  test('断线续传：从 fromSeq 之后补齐，不重不漏', async () => {
    const jobs = makeJobs()
    const lease = fakeLease()
    const cmd = controllable()
    const job = jobs.start(lease, cmd.run)
    const onFrame = await cmd.started

    // 第一个客户端收了两帧就断了
    const first = []
    const off = jobs.subscribe(job, 0, (f) => first.push(f))
    onFrame({ type: 'stdout', data: '1' })
    onFrame({ type: 'stdout', data: '2' })
    off()

    // 断线期间命令还在产出
    onFrame({ type: 'stdout', data: '3' })

    // 带着最后收到的 seq 回来
    const resumed = []
    jobs.subscribe(job, first.at(-1).seq, (f) => resumed.push(f))
    onFrame({ type: 'stdout', data: '4' })
    cmd.finish({ exitCode: 0 })
    await job.done

    assert.deepEqual(first.map((f) => f.data), ['1', '2'])
    // 3 是断线期间的历史，4 是实时推的，exit 是终止帧
    assert.deepEqual(resumed.filter((f) => f.type === 'stdout').map((f) => f.data), ['3', '4'])
    assert.equal(resumed.at(-1).type, 'exit')
  })

  test('已结束的任务照样能订阅到完整历史', async () => {
    // 客户端断线期间命令跑完了 —— 这是最常见的情形，必须拿得到结果。
    const jobs = makeJobs()
    const lease = fakeLease()
    const cmd = controllable()
    const job = jobs.start(lease, cmd.run)
    const onFrame = await cmd.started
    onFrame({ type: 'stdout', data: 'done\n' })
    cmd.finish({ exitCode: 0 })
    await job.done

    const late = []
    jobs.subscribe(job, 0, (f) => late.push(f))
    assert.equal(late.length, 2)
    assert.equal(late.at(-1).exitCode, 0)
  })

  test('一个订阅者写失败不影响别的订阅者，也不影响命令', async () => {
    const jobs = makeJobs()
    const lease = fakeLease()
    const cmd = controllable()
    const job = jobs.start(lease, cmd.run)
    const onFrame = await cmd.started

    const good = []
    jobs.subscribe(job, 0, () => { throw new Error('连接已断') })
    jobs.subscribe(job, 0, (f) => good.push(f))

    onFrame({ type: 'stdout', data: 'x' })
    cmd.finish({ exitCode: 0 })
    await job.done

    assert.equal(good.length, 2, '另一个订阅者应当照常收到全部帧')
    assert.equal(job.status, 'completed')
  })

  test('显式放弃才杀命令', async () => {
    const jobs = makeJobs()
    const lease = fakeLease()
    const cmd = controllable()
    const job = jobs.start(lease, cmd.run)
    await cmd.started

    assert.equal(jobs.abort(job), true)
    await job.done
    assert.equal(job.status, 'aborted')
    assert.equal(jobs.abort(job), false, '已经结束的任务不该再报"已放弃"')
  })

  test('只淘汰已结束的任务，正在跑的永远留着', async () => {
    // 淘汰一个还在跑的任务，等于让它的输出凭空消失。
    const jobs = makeJobs(1)
    const lease = fakeLease()

    const done = []
    for (let i = 0; i < 3; i += 1) {
      const cmd = controllable()
      const job = jobs.start(lease, cmd.run)
      await cmd.started
      cmd.finish({ exitCode: 0 })
      await job.done
      done.push(job)
    }
    const alive = controllable()
    const running = jobs.start(lease, alive.run)
    await alive.started

    const ids = jobs.list(lease).map((j) => j.execId)
    assert.ok(ids.includes(running.execId), '正在跑的任务被淘汰了')
    assert.equal(ids.filter((id) => done.some((j) => j.execId === id)).length, 1, '应当只留最近 1 个已结束任务')
    assert.equal(ids.includes(done.at(-1).execId), true, '留下的应当是最新的那个')

    jobs.abort(running)
    await running.done
  })

  test('执行本身抛错时给出 error 帧和终止帧，不是静默结束', async () => {
    const jobs = makeJobs()
    const lease = fakeLease()
    const job = jobs.start(lease, () => Promise.reject(Object.assign(new Error('spawn 失败'), { code: 'SPAWN_FAILED' })))
    await job.done

    assert.equal(job.status, 'failed')
    const kinds = job.frames.map((f) => f.type)
    assert.deepEqual(kinds, ['error', 'exit'])
    assert.equal(job.frames[0].code, 'SPAWN_FAILED')
    assert.equal(lease.running.size, 0)
  })
})
