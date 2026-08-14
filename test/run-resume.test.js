/**
 * 断线重连。
 *
 * 从前 `/v1/chat/stream` 断了就没了：服务端的 run 照样跑到结束（它登记在
 * run-service 的 active 表里），但客户端**没有任何入口**回到那条流上。
 * 而会话正文要等这一轮结束才落库，所以刷新页面也救不回来 ——
 * 合上笔记本、切个网络、进一趟电梯，这一轮的回答就在界面上永久消失了，
 * token 一个不少地烧完。
 *
 * 分两层测：
 *   1. 缓冲本身（run-registry）—— 序号、重放、丢帧、回收；
 *   2. 打到 HTTP 上的那两条接口，重点是**归属校验**和"接不上时要说出来"。
 */
import { test, describe, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { createRunRegistry } from '../src/agent/run-registry.js'
import { createServer } from '../src/http/server.js'
import { createIdentityResolver } from '../src/identity/index.js'
import { createMemorySessionStore } from './helpers/memory-session-store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

describe('run 事件缓冲', () => {
  test('帧按 1 起的序号存下来，重放时只给断点之后的', () => {
    const registry = createRunRegistry()
    registry.open({ runId: 'r1', username: 'alice', sessionKey: 's1' })

    assert.equal(registry.append('r1', 'run_start', { runId: 'r1' }), 1)
    assert.equal(registry.append('r1', 'text', { delta: '你' }), 2)
    assert.equal(registry.append('r1', 'text', { delta: '好' }), 3)

    const sub = registry.subscribe('r1', 1, () => {})
    assert.deepEqual(sub.replay.map((frame) => frame.seq), [2, 3], '只该重放第 1 帧之后的')
    assert.equal(sub.truncated, false)
  })

  test('from=0 时把整段重放出来 —— 刚断在第一帧之前的人要拿到全部', () => {
    const registry = createRunRegistry()
    registry.open({ runId: 'r1', username: 'alice' })
    registry.append('r1', 'run_start', {})
    registry.append('r1', 'text', { delta: 'x' })

    assert.deepEqual(registry.subscribe('r1', 0, () => {}).replay.map((f) => f.seq), [1, 2])
  })

  test('接上之后的新帧会推给听众', () => {
    const registry = createRunRegistry()
    registry.open({ runId: 'r1', username: 'alice' })
    registry.append('r1', 'run_start', {})

    const got = []
    registry.subscribe('r1', 1, (frame) => got.push(frame))

    registry.append('r1', 'text', { delta: 'a' })
    registry.append('r1', 'text', { delta: 'b' })

    assert.deepEqual(got.map((frame) => frame?.data?.delta), ['a', 'b'])
  })

  test('run 结束时听众收到一个 null 当收尾信号', () => {
    const registry = createRunRegistry()
    registry.open({ runId: 'r1', username: 'alice' })

    const got = []
    registry.subscribe('r1', 0, (frame) => got.push(frame))
    registry.append('r1', 'final', { text: '好了' })
    registry.close('r1')

    assert.equal(got.at(-1), null, '最后该收到 null')
  })

  /**
   * 已经跑完的 run 仍然接得上 —— **最容易断线的时刻恰恰是这一轮刚结束**
   * （用户看完就合上盖子）。这时重连要拿到的正是 final 帧里那段答案。
   */
  test('跑完的 run 还能接上，拿到完整的一段并立刻收尾', () => {
    const registry = createRunRegistry()
    registry.open({ runId: 'r1', username: 'alice' })
    registry.append('r1', 'run_start', {})
    registry.append('r1', 'final', { text: '答案' })
    registry.close('r1')

    const sub = registry.subscribe('r1', 0, () => {})
    assert.equal(sub.done, true)
    assert.equal(sub.replay.at(-1).data.text, '答案')
  })

  test('不存在的 run 回 null', () => {
    assert.equal(createRunRegistry().subscribe('nope', 0, () => {}), null)
  })

  /**
   * 缓冲撑爆时**必须说出来**。装作接上了继续发，用户看到的是一段中间缺了
   * 几句的回答，而没有任何迹象表明它缺过 —— 那比"接不上，请重新加载"糟得多。
   */
  test('帧数超上限时丢最老的，并把断点落在丢掉区间里的人标成 truncated', () => {
    const registry = createRunRegistry({ maxFramesPerRun: 5 })
    registry.open({ runId: 'r1', username: 'alice' })
    for (let i = 0; i < 20; i += 1) registry.append('r1', 'text', { delta: String(i) })

    // 断点停在第 2 帧，而缓冲里最早的已经是第 16 帧了 —— 中间接不上
    const gapped = registry.subscribe('r1', 2, () => {})
    assert.equal(gapped.truncated, true)
    assert.equal(gapped.replay.length, 0, '接不上时不该发半截内容出去')

    // 断点足够新的人不受影响
    assert.equal(registry.subscribe('r1', 18, () => {}).truncated, false)
  })

  test('单个 run 的字节数也有闸 —— 帧数不多但每帧很大的那一类', () => {
    const registry = createRunRegistry({ maxBytesPerRun: 500 })
    registry.open({ runId: 'r1', username: 'alice' })
    for (let i = 0; i < 10; i += 1) registry.append('r1', 'tool_result', { blob: 'x'.repeat(200) })

    assert.ok(registry.stats().bytes <= 500 + 220, `字节数应收在上限附近，实际 ${registry.stats().bytes}`)
    assert.equal(registry.subscribe('r1', 0, () => {}).truncated, true)
  })

  test('结束够久的 run 会被忘掉', () => {
    let clock = 1_000_000
    const registry = createRunRegistry({ keepFinishedMs: 1000, now: () => clock })
    registry.open({ runId: 'r1', username: 'alice' })
    registry.close('r1')

    clock += 999
    assert.ok(registry.subscribe('r1', 0, () => {}), '还没到期，该留着')
    clock += 2
    assert.equal(registry.subscribe('r1', 0, () => {}), null, '过期之后该被回收')
  })

  /**
   * 淘汰顺序：已结束的先走。扔掉一个**还在跑**的 run 的缓冲，
   * 等于当场废掉它的重连能力 —— 而那正是这个模块存在的理由。
   */
  test('总数超上限时先扔已结束的，在跑的留着', () => {
    const registry = createRunRegistry({ maxRetainedRuns: 3 });
    // 一个在跑的，和一堆已经结束的
    registry.open({ runId: 'live', username: 'alice' })
    for (let i = 0; i < 10; i += 1) {
      registry.open({ runId: `done${i}`, username: 'alice' })
      registry.close(`done${i}`)
    }
    // sweep 发生在 open/subscribe 上
    registry.open({ runId: 'trigger', username: 'alice' })

    assert.ok(registry.subscribe('live', 0, () => {}), '在跑的那个必须还在')
  })

  test('listFor 只回这个人的，并且能按会话过滤', () => {
    const registry = createRunRegistry()
    registry.open({ runId: 'a', username: 'alice', sessionKey: 's1' })
    registry.open({ runId: 'b', username: 'alice', sessionKey: 's2' })
    registry.open({ runId: 'c', username: 'bob', sessionKey: 's1' })

    assert.deepEqual(registry.listFor('alice').map((r) => r.runId).sort(), ['a', 'b'])
    assert.deepEqual(registry.listFor('alice', { sessionKey: 's1' }).map((r) => r.runId), ['a'])
    assert.deepEqual(registry.listFor('bob').map((r) => r.runId), ['c'])
  })
})

// ── HTTP ───────────────────────────────────────────────────────────────────

function buildConfig() {
  return {
    auth: { mode: 'dev', password: {} },
    llm: { mode: 'faux' },
    sandbox: { mode: 'none' },
    limits: { bodyLimitBytes: 256 * 1024, chatBodyLimitBytes: 1024 * 1024, maxConcurrentRuns: 8, maxRunsPerUser: 2 },
    cron: { enabled: false, scheduler: false, credentialMode: 'none' },
    memory: { enabled: false },
    projects: { enabled: false },
    artifacts: { enabled: false, allowedOrigins: [] },
    devConsole: false,
    webUi: false,
  }
}

let server

/**
 * 起一个只带 registry 的服务端。
 *
 * runService 用替身，但 **attach / listRuns 是真的**（直接接在真 registry 上）——
 * 要测的正是这两条路，替换掉它们等于把被测对象换成了自己写的假货。
 */
async function startServer() {
  const config = buildConfig()
  const registry = createRunRegistry()
  const identity = createIdentityResolver({ config, logger: silentLogger })

  const runService = {
    snapshot: () => ({ activeRuns: 0, budget: 8, perUserLimit: 2, users: [] }),
    listSkills: () => [],
    abort: () => ({ ok: true }),
    execute: async () => ({ runId: 'r', durationMs: 1, finalText: '' }),
    attach({ runId, username, from, listener }) {
      if (!registry.listFor(username).some((run) => run.runId === runId)) {
        const error = new Error('run 不存在、已过期或不属于你')
        error.status = 404
        throw error
      }
      return registry.subscribe(runId, from, listener)
    },
    listRuns: ({ username, sessionKey }) => registry.listFor(username, { sessionKey }),
  }

  const app = createServer({
    config,
    logger: silentLogger,
    identity,
    runService,
    store: createMemorySessionStore(),
    broker: { getLlmAccess: async () => ({ models: [], user: null }), invalidate() {} },
    scheduler: { enabled: false },
    metrics: { snapshot: () => ({}) },
  })
  await app.listen(0)
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, registry }
}

/** 把一段 SSE 正文解析成 [{ id, event, data }] */
function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const frame = {}
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) frame.id = Number(line.slice(4))
      else if (line.startsWith('event: ')) frame.event = line.slice(7)
      else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
    }
    return frame
  })
}

const asUser = (user) => ({ 'X-Username': user })

beforeEach(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
  server = await startServer()
})
after(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
})

describe('GET /v1/runs', () => {
  test('列出自己还在跑的 run', async () => {
    server.registry.open({ runId: 'r1', username: 'alice', sessionKey: 's1' })

    const response = await fetch(`${server.base}/v1/runs`, { headers: asUser('alice') })
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.runs.length, 1)
    assert.equal(body.runs[0].runId, 'r1')
    assert.equal(body.runs[0].done, false)
  })

  test('看不到别人的 run', async () => {
    server.registry.open({ runId: 'r1', username: 'alice', sessionKey: 's1' })

    const response = await fetch(`${server.base}/v1/runs`, { headers: asUser('bob') })
    assert.deepEqual((await response.json()).runs, [])
  })

  test('按 sessionKey 过滤', async () => {
    server.registry.open({ runId: 'r1', username: 'alice', sessionKey: 's1' })
    server.registry.open({ runId: 'r2', username: 'alice', sessionKey: 's2' })

    const response = await fetch(`${server.base}/v1/runs?sessionKey=s2`, { headers: asUser('alice') })
    const body = await response.json()
    assert.deepEqual(body.runs.map((run) => run.runId), ['r2'])
  })
})

describe('GET /v1/runs/:id/events', () => {
  test('把断点之后的帧重放出来，run 结束后收流', async () => {
    server.registry.open({ runId: 'r1', username: 'alice', sessionKey: 's1' })
    server.registry.append('r1', 'run_start', { runId: 'r1' })
    server.registry.append('r1', 'text', { delta: '你' })
    server.registry.append('r1', 'text', { delta: '好' })

    const pending = fetch(`${server.base}/v1/runs/r1/events?from=1`, { headers: asUser('alice') })
      .then((response) => response.text())

    // 连上之后再来的帧也要收到
    await new Promise((resolve) => setTimeout(resolve, 50))
    server.registry.append('r1', 'final', { text: '你好' })
    server.registry.close('r1')

    const frames = parseSse(await pending)
    assert.deepEqual(frames.map((frame) => frame.event), ['text', 'text', 'final'], '第 1 帧不该重发')
    assert.deepEqual(frames.map((frame) => frame.id), [2, 3, 4], 'SSE 的 id 必须是缓冲里的序号')
    assert.equal(frames.at(-1).data.text, '你好')
  })

  test('已经跑完的 run 也接得上，一次性拿到全部然后收流', async () => {
    server.registry.open({ runId: 'r1', username: 'alice' })
    server.registry.append('r1', 'run_start', {})
    server.registry.append('r1', 'final', { text: '答案' })
    server.registry.close('r1')

    const frames = parseSse(await (await fetch(`${server.base}/v1/runs/r1/events?from=0`, { headers: asUser('alice') })).text())
    assert.deepEqual(frames.map((frame) => frame.event), ['run_start', 'final'])
  })

  /**
   * runId 会出现在前端日志和错误上报里。不校验归属的话，
   * 这条接口就成了"知道 runId 的人能看这段对话"。
   */
  test('接不了别人的 run', async () => {
    server.registry.open({ runId: 'r1', username: 'alice' })

    const response = await fetch(`${server.base}/v1/runs/r1/events`, { headers: asUser('bob') })
    assert.equal(response.status, 404)
  })

  test('不存在的 run 回 404，而不是一条挂着的空流', async () => {
    const response = await fetch(`${server.base}/v1/runs/nope/events`, { headers: asUser('alice') })
    assert.equal(response.status, 404)
  })

  test('未登录进不来', async () => {
    server.registry.open({ runId: 'r1', username: 'alice' })
    const response = await fetch(`${server.base}/v1/runs/r1/events`)
    assert.equal(response.status, 401)
  })

  /**
   * 接不上的时候要**明确说出来**，让前端去重新加载会话 ——
   * 而不是发一段中间缺了几句的回答，让用户以为模型就是这么答的。
   */
  test('中间丢过帧时回一条 resync，而不是半截内容', async () => {
    const registry = server.registry
    registry.open({ runId: 'r1', username: 'alice' })
    // 灌到把缓冲撑爆
    for (let i = 0; i < 3000; i += 1) registry.append('r1', 'text', { delta: String(i) })

    const frames = parseSse(await (await fetch(`${server.base}/v1/runs/r1/events?from=1`, { headers: asUser('alice') })).text())
    assert.deepEqual(frames.map((frame) => frame.event), ['resync'])
    assert.equal(frames[0].data.reason, 'buffer-truncated')
  })
})
