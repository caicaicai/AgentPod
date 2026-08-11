/**
 * 对话界面依赖的那几件事：历史能还原、标题不会被冲掉、会话接口按 username 隔离、
 * 静态资源只服务前端构建产物目录里的东西。
 *
 * 最要紧的两条：
 *   1. **历史还原**。刷新页面之后看到的必须和刚才流式看到的是同一回事，
 *      包括中间那些工具调用 —— 否则用户没法判断"它到底干了什么"。
 *   2. **接口按 username 过滤**。会话 key 是客户端自选的，知道别人的 key
 *      也绝不能读到别人的会话。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { parseTranscript, deriveTitle } from '../src/sessions/transcript.js'
import { toClientFrames, createFrameEncoder } from '../src/agent/events.js'
import { createMemoryStore } from '../src/sessions/store.js'
import { createServer } from '../src/http/server.js'

/* ─────────── 造一段真实形状的 pi 会话 ─────────── */

const line = (obj) => `${JSON.stringify(obj)}\n`

function messageEntry(id, message, timestamp = '2026-08-02T03:00:00.000Z') {
  return line({ type: 'message', id, parentId: null, timestamp, message })
}

const SAMPLE_JSONL =
  line({ type: 'session', version: 3, id: 'sess-1', timestamp: '2026-08-02T03:00:00.000Z', cwd: '/w' }) +
  messageEntry('e1', { role: 'user', content: '查一下我今天的会议', timestamp: 1 }) +
  messageEntry('e2', {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '要用 meeting 技能' },
      { type: 'text', text: '我查一下。' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls skills' } },
    ],
    model: 'JoyAI-LLM-Pro',
    usage: { input: 100, output: 20, cacheRead: 0 },
    stopReason: 'toolUse',
    timestamp: 2,
  }) +
  messageEntry('e3', {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'meeting\njoymail-search' }],
    isError: false,
    timestamp: 3,
  }) +
  messageEntry('e4', {
    role: 'assistant',
    content: [{ type: 'text', text: '你今天有 2 个会。' }],
    model: 'JoyAI-LLM-Pro',
    usage: { input: 200, output: 30, cacheRead: 0 },
    stopReason: 'stop',
    timestamp: 4,
  })

describe('会话历史还原', () => {
  test('用户/助手/工具结果各归各位，工具结果挂回发起它的那次调用', () => {
    const { sessionId, messages } = parseTranscript(SAMPLE_JSONL)
    assert.equal(sessionId, 'sess-1')
    assert.equal(messages.length, 3)

    assert.deepEqual(
      messages.map((m) => m.role),
      ['user', 'assistant', 'assistant'],
    )
    assert.equal(messages[0].text, '查一下我今天的会议')

    const first = messages[1]
    assert.equal(first.text, '我查一下。')
    assert.equal(first.thinking, '要用 meeting 技能')
    assert.equal(first.model, 'JoyAI-LLM-Pro')
    assert.equal(first.toolCalls.length, 1)

    const call = first.toolCalls[0]
    assert.equal(call.toolName, 'bash')
    assert.deepEqual(call.args, { command: 'ls skills' })
    assert.equal(call.pending, false)
    assert.equal(call.isError, false)
    // 结果预览是判断"技能到底跑出了什么"的唯一依据，必须原样带回来
    assert.equal(call.preview, 'meeting\njoymail-search')
  })

  test('没等到结果的工具调用留在 pending —— 那轮是断在半路的，不能装作成功', () => {
    const jsonl =
      messageEntry('e1', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'sleep 999' } }],
        stopReason: 'toolUse',
      })
    const { messages } = parseTranscript(jsonl)
    assert.equal(messages[0].toolCalls[0].pending, true)
    assert.equal(messages[0].toolCalls[0].preview, undefined)
  })

  test('孤儿工具结果直接丢掉，不凭空造一条消息', () => {
    const jsonl = messageEntry('e1', {
      role: 'toolResult',
      toolCallId: 'nobody',
      toolName: 'bash',
      content: [{ type: 'text', text: 'x' }],
      isError: false,
    })
    assert.equal(parseTranscript(jsonl).messages.length, 0)
  })

  test('坏掉的一行不该让整段历史打不开', () => {
    const jsonl = `${SAMPLE_JSONL}{"type":"message" 这行是坏的\n`
    assert.equal(parseTranscript(jsonl).messages.length, 3)
  })

  test('工具出错时 isError 要传下去 —— 前端靠它把卡片标红', () => {
    const jsonl =
      messageEntry('e1', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }],
        stopReason: 'toolUse',
      }) +
      messageEntry('e2', {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'command not found' }],
        isError: true,
      })
    const call = parseTranscript(jsonl).messages[0].toolCalls[0]
    assert.equal(call.isError, true)
    assert.equal(call.preview, 'command not found')
  })

  test('空会话返回空列表而不是抛异常', () => {
    assert.deepEqual(parseTranscript('').messages, [])
    assert.deepEqual(parseTranscript(undefined).messages, [])
  })
})

describe('会话标题', () => {
  test('长提问截断，短的原样', () => {
    assert.equal(deriveTitle('查会议'), '查会议')
    assert.equal(deriveTitle('  多余的   空白\n要压掉  '), '多余的 空白 要压掉')
    assert.equal(deriveTitle('一'.repeat(50)).length, 25) // 24 字 + 省略号
  })

  test('用户改过的名字，不会被下一轮对话的自动标题冲掉', async () => {
    const store = createMemoryStore()
    await store.save({ username: 'u1', sessionKey: 'k', sessionId: 's', jsonl: '', entryCount: 1, title: '第一次提问' })
    assert.equal((await store.list({ username: 'u1' }))[0].title, '第一次提问')

    await store.rename({ username: 'u1', sessionKey: 'k', title: '我自己起的名字' })
    // 又聊了一轮，save 会再带一个候选标题过来
    await store.save({ username: 'u1', sessionKey: 'k', sessionId: 's', jsonl: '', entryCount: 2, title: '第二次提问' })
    assert.equal((await store.list({ username: 'u1' }))[0].title, '我自己起的名字')
  })

  test('重命名不存在的会话返回 false，而不是凭空建一条', async () => {
    const store = createMemoryStore()
    assert.equal(await store.rename({ username: 'u1', sessionKey: 'nope', title: 'x' }), false)
  })
})

describe('流式帧', () => {
  const collect = (event) => {
    const frames = []
    toClientFrames(event, (type, data) => frames.push({ type, data }))
    return frames
  }

  /** 一条流的编码器 + 收集器：模拟真实的 run（多个 message_update 攒在一起） */
  const stream = () => {
    const encode = createFrameEncoder()
    const frames = []
    return {
      frames,
      feed: (event) => encode(event, (type, data) => frames.push({ type, data })),
    }
  }

  const assistant = (text, thinking = '') => ({
    role: 'assistant',
    content: [
      ...(thinking ? [{ type: 'thinking', thinking }] : []),
      ...(text ? [{ type: 'text', text }] : []),
    ],
  })

  test('每条助手消息结束时给一个边界，否则前一句会被后一句盖掉', () => {
    // 一轮里常有两条助手消息：先说"我查一下"并调工具，拿到结果再说结论。
    // text 帧带的是各自的全文，客户端没有边界就只能整体替换 —— 第一句就没了。
    const frames = collect({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '我查一下' }], stopReason: 'toolUse' },
    })
    assert.deepEqual(frames.map((f) => f.type), ['text', 'text_end'])
    assert.equal(frames[1].data.errorMessage, '')
  })

  test('模型/网关出错时必须带出错误文案 —— pi 不抛异常，只是结束一条 error 消息', () => {
    const frames = collect({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '502 网关炸了' },
    })
    const end = frames.find((f) => f.type === 'text_end')
    // 不带出去的话，界面上就是一个空空的回复气泡，用户完全看不出发生了什么
    assert.equal(end.data.errorMessage, '502 网关炸了')
  })

  test('用户主动中止不算错误', () => {
    const frames = collect({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '写了一半' }], stopReason: 'aborted' },
    })
    assert.equal(frames.find((f) => f.type === 'text_end').data.errorMessage, '')
  })

  test('思考内容单独成帧，不和正文混在一起', () => {
    const frames = collect({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '先看看有什么技能' }, { type: 'text', text: '好的' }],
      },
    })
    assert.deepEqual(frames.map((f) => f.type), ['thinking', 'text'])
    assert.equal(frames[0].data.text, '先看看有什么技能')
    assert.equal(frames[1].data.text, '好的')
  })

  /**
   * 增量编码。从前每帧都发到目前为止的全文，传输量是 O(n²) ——
   * 实测 1.6KB 的回复发了 491KB，用户看到的就是"开头顺畅、后面越来越卡、
   * 最后一大段一起蹦出来"。见 src/agent/events.js 的 createChunker。
   */
  test('首帧发全文，之后只发增量', () => {
    const s = stream()
    s.feed({ type: 'message_update', message: assistant('你好') })
    s.feed({ type: 'message_update', message: assistant('你好，我是') })
    s.feed({ type: 'message_update', message: assistant('你好，我是助手') })

    assert.deepEqual(s.frames.map((f) => f.data), [
      { text: '你好' },       // 首帧：客户端整体替换
      { delta: '，我是' },     // 之后：追加
      { delta: '助手' },
    ])
  })

  test('思考结束后不再重发 —— 那是全文写法里最大的一块纯浪费', () => {
    // 思考早就结束了，后面每来一个正文 token 都把整段思考原样再发一遍。
    // 实测 489 个 thinking 帧里有 414 个是完全相同的重复。
    const s = stream()
    s.feed({ type: 'message_update', message: assistant('', '想一下') })
    s.feed({ type: 'message_update', message: assistant('好', '想一下') })
    s.feed({ type: 'message_update', message: assistant('好的', '想一下') })

    assert.equal(s.frames.filter((f) => f.type === 'thinking').length, 1)
  })

  test('内容不是纯追加时退回全文替换 —— 拼错正文比多发一帧严重得多', () => {
    // 重试会把失败的那条助手消息摘掉重发，于是新内容和已发出去的对不上前缀。
    const s = stream()
    s.feed({ type: 'message_update', message: assistant('第一版') })
    s.feed({ type: 'message_update', message: assistant('完全不同的第二版') })

    assert.deepEqual(s.frames.map((f) => f.data), [
      { text: '第一版' },
      { text: '完全不同的第二版' },
    ])
  })

  test('边界之后重新计数：下一条助手消息的首帧仍是全文', () => {
    const s = stream()
    s.feed({ type: 'message_update', message: assistant('我查一下') })
    s.feed({ type: 'message_end', message: { ...assistant('我查一下'), stopReason: 'toolUse' } })
    s.feed({ type: 'message_update', message: assistant('查到了') })

    const texts = s.frames.filter((f) => f.type === 'text').map((f) => f.data)
    // 不重置的话第二条会被编码成一段无处可追加的 delta，界面上就是接在前一句后面
    assert.deepEqual(texts, [{ text: '我查一下' }, { text: '查到了' }])
  })

  test('工具结果消息不发 text_end —— 那个边界会把编码状态重置到错的地方', () => {
    const s = stream()
    s.feed({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] } })
    assert.deepEqual(s.frames, [])
  })
})

/* ─────────── HTTP 接口 ─────────── */

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

function buildConfig(overrides = {}) {
  return {
    auth: { mode: 'dev' },
    llm: { mode: 'faux' },
    sandbox: { mode: 'manager' },
    bridge: { enabled: false },
    limits: { bodyLimitBytes: 65536 },
    devConsole: true,
    webUi: true,
    ...overrides,
  }
}

async function startServer({ store, config = buildConfig(), skills = [] } = {}) {
  const runService = {
    snapshot: () => ({ activeRuns: 0, budget: 8, perUserLimit: 2, users: [] }),
    listSkills: () => skills,
    abort: () => ({ ok: true }),
    execute: async () => {},
  }
  const app = createServer({
    config,
    logger: silentLogger,
    // username 从 X-Username 头来（等价于 AUTH_MODE=dev），测试要靠它模拟两个不同用户
    identity: { resolve: async (req) => ({ username: req.headers['x-username'] || 'u1', credential: '' }) },
    broker: { getLlmAccess: async () => ({ models: [], user: null }), invalidate() {} },
    runService,
    store,
    llmInfoClient: null,
    metrics: { snapshot: () => ({}) },
  })
  await app.listen(0)
  const { port } = app.server.address()
  return { app, base: `http://127.0.0.1:${port}` }
}

describe('会话接口', () => {
  let store
  let server

  before(async () => {
    store = createMemoryStore()
    await store.save({ username: 'u1', sessionKey: 'k1', sessionId: 'sess-1', jsonl: SAMPLE_JSONL, entryCount: 4, title: '会议查询' })
    await store.save({ username: 'u2', sessionKey: 'k2', sessionId: 'sess-2', jsonl: SAMPLE_JSONL, entryCount: 4, title: '别人的会话' })
    server = await startServer({ store })
  })
  after(async () => { await server.app.close({ timeoutMs: 1000 }) })

  const get = (path, username = 'u1') => fetch(`${server.base}${path}`, { headers: { 'X-Username': username } })

  test('会话详情把 JSONL 转成可渲染的消息', async () => {
    const response = await get('/v1/sessions/k1')
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.title, '会议查询')
    assert.equal(body.messages.length, 3)
    assert.equal(body.messages[1].toolCalls[0].preview, 'meeting\njoymail-search')
  })

  test('知道别人的 sessionKey 也读不到别人的会话', async () => {
    // u1 拿着 u2 的 key 来读 —— 必须 404，而不是把 u2 的对话端出来
    const response = await get('/v1/sessions/k2', 'u1')
    assert.equal(response.status, 404)
  })

  test('列表只回自己的', async () => {
    const body = await (await get('/v1/sessions', 'u2')).json()
    assert.deepEqual(body.sessions.map((s) => s.sessionKey), ['k2'])
    assert.equal(body.sessions[0].title, '别人的会话')
    assert.equal(body.sessions[0].jsonl, undefined) // 列表不带正文
  })

  test('重命名与删除', async () => {
    const renamed = await fetch(`${server.base}/v1/sessions/k1`, {
      method: 'PATCH',
      headers: { 'X-Username': 'u1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '改过的名字' }),
    })
    assert.equal(renamed.status, 200)
    assert.equal((await (await get('/v1/sessions/k1')).json()).title, '改过的名字')

    const deleted = await fetch(`${server.base}/v1/sessions/k1`, { method: 'DELETE', headers: { 'X-Username': 'u1' } })
    assert.equal(deleted.status, 200)
    assert.equal((await get('/v1/sessions/k1')).status, 404)
  })

  test('sessionKey 字符集收口：它会进存储主键，不能由客户端随便写', async () => {
    for (const bad of ['a::b', '../x', 'a b', 'a/b']) {
      const response = await get(`/v1/sessions/${encodeURIComponent(bad)}`)
      assert.equal(response.status, 400, `${bad} 应当被拒`)
    }
  })

  test('技能清单带上"现在能不能用"', async () => {
    const body = await (await get('/v1/skills')).json()
    assert.equal(body.usable, true)
    assert.equal(body.sandboxMode, 'manager')
  })
})

describe('技能清单在没有执行端时标记为不可用', () => {
  test('SANDBOX_MODE=none 时 usable=false —— 界面要照此提示，别让用户以为技能能跑', async () => {
    const server = await startServer({
      store: createMemoryStore(),
      config: buildConfig({ sandbox: { mode: 'none' } }),
      skills: [{ name: 'demo', displayName: '演示', emoji: '🧪', description: 'd' }],
    })
    const body = await (await fetch(`${server.base}/v1/skills`, { headers: { 'X-Username': 'u1' } })).json()
    assert.equal(body.usable, false)
    assert.equal(body.skills[0].displayName, '演示')
    await server.app.close({ timeoutMs: 1000 })
  })
})

/**
 * 静态资源服务的是 web/ 的**构建产物**（web/dist）。
 *
 * 用例里不打真产物，而是现搭一个同构的临时目录塞进 `config.webDir` ——
 * 否则这些用例就等于要求"先 npm install && vite build 才能跑测试"，
 * 一个刚 clone 下来的仓库跑 `npm test` 会直接红，而红的原因跟改动毫无关系。
 * 形状（index.html + assets/）由 vite.config.js 的 assetsDir 保证。
 */
describe('静态资源', () => {
  let server
  let webDir

  before(async () => {
    webDir = await mkdtemp(path.join(tmpdir(), 'ap-webdist-'))
    await mkdir(path.join(webDir, 'assets'), { recursive: true })
    await writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>t</title><div id="app"></div>')
    await writeFile(path.join(webDir, 'assets', 'index-abc123.js'), 'export default 1\n')
    // 产物目录之外的东西：穿越用例要拿它当"取到了就算漏"的靶子
    await writeFile(path.join(webDir, '..', 'ap-webdist-secret.js'), 'secret\n')
    server = await startServer({ store: createMemoryStore(), config: buildConfig({ webDir }) })
  })
  after(async () => {
    await server.app.close({ timeoutMs: 1000 })
    await rm(webDir, { recursive: true, force: true })
    await rm(path.join(webDir, '..', 'ap-webdist-secret.js'), { force: true })
  })

  test('对话界面与它的资源可以直接取到（不需要身份）', async () => {
    const page = await fetch(`${server.base}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)

    // Vite 产出的文件名带哈希，路由靠的是 /assets/ 这个前缀，不是具体文件名
    const script = await fetch(`${server.base}/assets/index-abc123.js`)
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type'), /javascript/)
  })

  test('目录穿越取不到 assets/ 以外的文件', async () => {
    /**
     * 用例要能真的打到那道边界检查，需要同时躲开前面两层：
     *
     *   1. **斜杠必须编码成 %2f**。WHATWG URL 会把 `..` 和 `%2e%2e/` 这类
     *      点段直接规范化掉，`url.pathname` 里根本不会留下 `..` —— 拿它们试，
     *      测的是 URL 解析器，不是我们的代码。`%2f` 不会被当成分隔符，
     *      于是 `..` 一路活到我们自己 decodeURIComponent 那一步。
     *   2. **目标后缀要在白名单里**。拿 package.json 试会先被后缀白名单挡掉，
     *      边界检查被删了也照样绿 —— 那是在测另一道门。
     */
    const attempts = [
      '/assets/%2e%2e%2findex.html', // 退回产物根目录：assets/ 那层的边界
      '/assets/%2e%2e%2f%2e%2e%2fap-webdist-secret.js', // 退到产物目录之外
    ]
    for (const attempt of attempts) {
      const response = await fetch(`${server.base}${attempt}`, { redirect: 'manual' })
      assert.ok(response.status >= 400, `${attempt} 不该取到内容，实际 ${response.status}`)
    }
  })

  test('开发控制台页面已经移除，/console 不再是一个路由', async () => {
    // 以前它由 DEV_CONSOLE 开关控制，现在页面本身没有了 —— 开着调试开关也一样 404，
    // 免得有人以为"把 DEV_CONSOLE 打开就还能进那个页面"。
    assert.equal(buildConfig().devConsole, true, '这条用例要在 devConsole=true 下才有意义')
    assert.equal((await fetch(`${server.base}/console`)).status, 404)
    assert.equal((await fetch(`${server.base}/console.html`)).status, 404)
  })

  test('WEB_UI=0 时首页不挂载，但接口照常', async () => {
    const closed = await startServer({
      store: createMemoryStore(),
      config: buildConfig({ webUi: false, webDir }),
    })
    assert.equal((await fetch(`${closed.base}/`)).status, 404)
    // 关的只是那张页面：这个服务同时也是给别的调用方用的 API，接口不该跟着消失
    assert.equal((await fetch(`${closed.base}/v1/sessions`, { headers: { 'X-Username': 'u1' } })).status, 200)
    await closed.app.close({ timeoutMs: 1000 })
  })
})
