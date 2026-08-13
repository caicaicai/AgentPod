/**
 * 项目指令与长期记忆**真的进了系统提示**吗。
 *
 * 单测 `memoryPrompt()` / `projectPrompt()` 的返回值证明不了什么 —— 那只说明函数会拼字符串。
 * 整条链上任何一处断了（run-service 没组装、runTurn 没往下传、resourceLoader 没接），
 * 表现都是同一件事：**功能看着有、模型完全不知道**，而且没有任何报错。
 *
 * 所以这里跑真的一轮，把模型实际收到的 systemPrompt 抓出来断言 ——
 * 与 workspace-prompt.test.js 同一个套路，同一个理由。
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { registerFauxProvider, fauxAssistantMessage } from '@mariozechner/pi-ai'

import { runTurn } from '../src/agent/run-turn.js'
import { createRunService } from '../src/agent/run-service.js'
import { TITLE_PROMPT } from '../src/sessions/title.js'
import { createMemorySessionStore as createSessionMemoryStore } from './helpers/memory-session-store.js'
import { createMemoryStore } from '../src/memory/store.js'
import { createProjectStore } from '../src/projects/store.js'
import { buildModel } from '../src/models/model-factory.js'
import { createMemoryStorage } from './helpers/memory-storage.js'

/** 存储后端的测试替身。生产只有 MySQL，见 test/helpers/memory-storage.js */
const testStorage = createMemoryStorage()

/**
 * 替身是这个文件共用的一个实例，每条用例前清干净。
 * 不清的话，上一条留下的记录会让"列出全部"这类断言得到一个跟自己无关的数字，
 * 而报错看起来像是被测代码有问题。
 */
beforeEach(() => testStorage.reset())

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

let faux
let model
before(() => {
  faux = registerFauxProvider({
    api: 'openai-completions',
    provider: 'ap-gateway',
    models: [{ id: 'test-model', name: 'test', contextWindow: 100000, maxTokens: 2048 }],
    tokensPerSecond: 100000,
  })
  model = buildModel({ model: 'test-model', server: faux.getModel().baseUrl, key: 'k' })
  model.provider = faux.getModel().provider
  model.api = faux.getModel().api
})
after(() => faux?.unregister())

/** 跑一轮，回收模型真正收到的系统提示 */
function captureSystemPrompt() {
  const captured = { systemPrompt: '', titleCalls: 0 }
  /**
   * **responder 每次用完要自己续上。**
   *
   * 这一轮之外还会有第二次模型调用：run-service 给新会话起标题
   * （见 src/sessions/title.js）。只放一个 responder 的话，它会被先发出的
   * 标题调用消耗掉，真正那一轮反而没人应答 —— 现象是"捕获到的系统提示
   * 变成了标题提示词"，而这跟本次改动看起来毫无关系。
   */
  const responder = (context) => {
    faux.appendResponses([responder])
    if (context.systemPrompt === TITLE_PROMPT) {
      captured.titleCalls += 1
      return fauxAssistantMessage('测试标题')
    }
    captured.systemPrompt = context.systemPrompt || captured.systemPrompt
    return fauxAssistantMessage('好的')
  }
  faux.setResponses([responder])
  return captured
}

describe('runTurn 把 contextPrompts 追加进系统提示', () => {
  test('传进去的段落出现在模型收到的提示里', async () => {
    const captured = captureSystemPrompt()
    await runTurn({
      runId: 'r1', username: 'zhangsan', sessionKey: 'main', prompt: '你好', model,
      store: createSessionMemoryStore(), sandbox: { mode: 'none' },
      contextPrompts: ['## 当前项目：结算中台', '## 关于这位用户（长期记忆）'],
      logger: silent, timeoutMs: 30000,
    })
    assert.match(captured.systemPrompt, /## 当前项目：结算中台/)
    assert.match(captured.systemPrompt, /## 关于这位用户（长期记忆）/)
  })

  test('空段落被滤掉，不留空行占位', async () => {
    const captured = captureSystemPrompt()
    await runTurn({
      runId: 'r2', username: 'zhangsan', sessionKey: 'main', prompt: '你好', model,
      store: createSessionMemoryStore(), sandbox: { mode: 'none' },
      contextPrompts: ['', null, undefined, '## 有内容'],
      logger: silent, timeoutMs: 30000,
    })
    assert.match(captured.systemPrompt, /## 有内容/)
  })
})

describe('run-service 装配的上下文（整条链）', () => {
  let root
  let sessions
  let memory
  let projects
  let runService
  let config

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ap-ctx-'))
    config = {
      dataDir: root,
      memory: { enabled: true, capture: false },
      projects: { enabled: true },
      cron: { enabled: false },
      limits: { maxConcurrentRuns: 8, maxRunsPerUser: 2, runTimeoutMs: 30000 },
      skills: { dirs: [], libsDir: '' },
      sandbox: { mode: 'none' },
      bridge: { browserCookieDomains: [] },
      llm: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1, extraPatterns: [] } },
    }
    sessions = createSessionMemoryStore()
    memory = createMemoryStore({ storage: testStorage, config, logger: silent })
    projects = createProjectStore({ storage: testStorage, config, logger: silent })
    runService = createRunService({
      config,
      logger: silent,
      store: sessions,
      sandbox: { mode: 'none' },
      broker: {
        getLlmAccess: async () => ({ models: [{ model: 'test-model', server: faux.getModel().baseUrl, key: 'k' }], apiKey: 'k' }),
        issueRunTicket: () => ({ ticket: 't', expiresAt: Date.now() + 60000 }),
        revokeRunTicket() {},
      },
      metrics: { recordRun() {} },
      memory,
      projects,
    })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const run = (overrides = {}) => runService.execute({
    subject: { username: 'zhangsan', credential: '' },
    sessionKey: 'main',
    prompt: '你好',
    ...overrides,
  })

  test('个人记忆进了系统提示', async () => {
    await memory.capture({ username: 'zhangsan' }, ['负责结算中台的稳定性', '偏好简短直接的回答'])
    const captured = captureSystemPrompt()
    await run()

    assert.match(captured.systemPrompt, /负责结算中台的稳定性/)
    assert.match(captured.systemPrompt, /偏好简短直接的回答/)
    // 措辞必须在场：少了这两句，模型会把记忆当本轮任务，或拿旧偏好反驳用户此刻的要求
    assert.match(captured.systemPrompt, /背景参考/)
    assert.match(captured.systemPrompt, /以用户当前说的为准/)
  })

  test('别人的记忆一个字都不会进来', async () => {
    await memory.capture({ username: 'lisi' }, ['李四的机密事项'])
    const captured = captureSystemPrompt()
    await run()
    assert.doesNotMatch(captured.systemPrompt, /李四的机密事项/)
  })

  /**
   * 默认不开自动抓取，写记忆全靠模型自己调 memory 工具 —— 那就必须**告诉它**
   * 这件事归它管，而且**一条记忆都没有的时候尤其要说**：新用户的第一轮
   * 恰恰是最该记点什么的时候，那时 personal/project 都是空的。
   *
   * 少了这一段，"关掉自动抓取"就等于"把记忆写入整个关掉"，而且是静悄悄地关掉。
   */
  test('没开自动抓取时，即使一条记忆都没有也要告诉模型「记忆归你管」', async () => {
    const captured = captureSystemPrompt()
    await run()
    assert.match(captured.systemPrompt, /长期记忆/)
    assert.match(captured.systemPrompt, /没有任何东西会被自动记住/)
    assert.match(captured.systemPrompt, /memory/, '得指名道姓说用哪个工具')
    assert.match(captured.systemPrompt, /不要只是口头答应/, '光说"你可以记"不管用')
  })

  test('开了自动抓取、又确实没有记忆时，不塞空段落', async () => {
    // 有自动抓取兜底就不必再叮嘱模型，空记忆时这一段整个不出现
    runService = createRunService({
      config,
      logger: silent,
      store: sessions,
      sandbox: { mode: 'none' },
      broker: {
        getLlmAccess: async () => ({ models: [{ model: 'test-model', server: faux.getModel().baseUrl, key: 'k' }], apiKey: 'k' }),
        issueRunTicket: () => ({ ticket: 't', expiresAt: Date.now() + 60000 }),
        revokeRunTicket() {},
      },
      metrics: { recordRun() {} },
      memory,
      projects,
      memoryCapture: { enabled: true, onTurnEnd() {} },
    })
    const captured = captureSystemPrompt()
    await run()
    assert.doesNotMatch(captured.systemPrompt, /长期记忆/)
  })

  test('项目指令 + 项目记忆一起进来，且个人记忆仍在', async () => {
    const project = await projects.create({
      username: 'zhangsan', name: '结算中台', instructions: '回答涉及改动时必须列出风险点。',
    })
    await memory.capture({ username: 'zhangsan' }, ['我是张三'])
    await memory.capture({ username: 'zhangsan', projectId: project.id }, ['本项目下周三上线'])

    const captured = captureSystemPrompt()
    await run({ projectId: project.id })

    assert.match(captured.systemPrompt, /## 当前项目：结算中台/)
    assert.match(captured.systemPrompt, /必须列出风险点/)
    assert.match(captured.systemPrompt, /本项目下周三上线/)
    assert.match(captured.systemPrompt, /我是张三/)
  })

  test('别的项目的记忆不会串进来', async () => {
    const mine = await projects.create({ username: 'zhangsan', name: 'A' })
    const other = await projects.create({ username: 'zhangsan', name: 'B' })
    await memory.capture({ username: 'zhangsan', projectId: other.id }, ['B 项目的事情'])

    const captured = captureSystemPrompt()
    await run({ projectId: mine.id })
    assert.doesNotMatch(captured.systemPrompt, /B 项目的事情/)
  })

  /**
   * 会话归属以**存储**为准，只有新会话才认请求里带的 projectId。
   * 否则前端一个参数就能把一条老会话搬进别的项目，而那会连带改变它每轮看到的指令。
   */
  test('已有会话的归属不被请求参数改写', async () => {
    const a = await projects.create({ username: 'zhangsan', name: 'A', instructions: 'A 的规矩' })
    const b = await projects.create({ username: 'zhangsan', name: 'B', instructions: 'B 的规矩' })

    captureSystemPrompt()
    await run({ projectId: a.id }) // 第一轮：落进 A
    assert.equal((await sessions.load({ username: 'zhangsan', sessionKey: 'main' })).projectId, a.id)

    const captured = captureSystemPrompt()
    await run({ projectId: b.id }) // 第二轮：谎称属于 B
    assert.match(captured.systemPrompt, /A 的规矩/)
    assert.doesNotMatch(captured.systemPrompt, /B 的规矩/)
    assert.equal((await sessions.load({ username: 'zhangsan', sessionKey: 'main' })).projectId, a.id)
  })

  /**
   * 项目被删之后，会话上的 projectId 就成了悬空引用。
   * 这时候必须当作"没有项目"继续跑，而不是让整轮对话失败 ——
   * 用户删的是一个分组，不该因此再也发不出消息。
   */
  test('项目被删后，老会话降级成无项目而不是报错', async () => {
    const project = await projects.create({ username: 'zhangsan', name: 'A', instructions: 'A 的规矩' })
    captureSystemPrompt()
    await run({ projectId: project.id })

    await projects.remove({ username: 'zhangsan', projectId: project.id })

    const captured = captureSystemPrompt()
    await run()
    assert.doesNotMatch(captured.systemPrompt, /A 的规矩/)
  })

  test('记忆读不出来也不该让对话跑不起来', async () => {
    const broken = createRunService({
      config: {
        dataDir: root, memory: { enabled: true }, projects: { enabled: true }, cron: { enabled: false },
        limits: { maxConcurrentRuns: 8, maxRunsPerUser: 2, runTimeoutMs: 30000 },
        skills: { dirs: [], libsDir: '' }, sandbox: { mode: 'none' }, bridge: { browserCookieDomains: [] },
        llm: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1, extraPatterns: [] } },
      },
      logger: silent,
      store: sessions,
      sandbox: { mode: 'none' },
      broker: {
        getLlmAccess: async () => ({ models: [{ model: 'test-model', server: faux.getModel().baseUrl, key: 'k' }], apiKey: 'k' }),
        issueRunTicket: () => ({ ticket: 't', expiresAt: Date.now() + 60000 }),
        revokeRunTicket() {},
      },
      metrics: { recordRun() {} },
      memory: { enabled: true, recall: async () => { throw new Error('盘挂了') } },
      projects,
    })
    const captured = captureSystemPrompt()
    const result = await broken.execute({
      subject: { username: 'zhangsan', credential: '' }, sessionKey: 'degraded', prompt: '你好',
    })
    assert.ok(result.runId, '读记忆失败时这一轮仍然要跑完')
    assert.doesNotMatch(captured.systemPrompt, /长期记忆/)
  })

  /**
   * 起标题只在**会话第一轮**做一次。
   *
   * 判据必须在跑之前取（跑完那条会话一定存在了）。判错的后果有两个，
   * 而且都不会立刻被发现：每轮多花一次模型调用，以及把用户手动改的名字
   * 在下一轮覆盖掉。
   */
  test('新会话起一次标题，第二轮不再起', async () => {
    const captured = captureSystemPrompt()

    await runService.execute({
      subject: { username: 'zhangsan', credential: '' },
      sessionKey: 's_title', prompt: '帮我看看结算中台的报错', source: 'test',
    })
    assert.equal(captured.titleCalls, 1, '第一轮该起一次')
    assert.equal((await sessions.load({ username: 'zhangsan', sessionKey: 's_title' })).title, '测试标题')

    await runService.execute({
      subject: { username: 'zhangsan', credential: '' },
      sessionKey: 's_title', prompt: '再看看别的', source: 'test',
    })
    assert.equal(captured.titleCalls, 1, '第二轮不该再起 —— 否则用户改过的名字会被覆盖')
  })

  test('关掉开关就完全不调用', async () => {
    const captured = captureSystemPrompt()
    config.sessions = { autoTitle: false }
    await runService.execute({
      subject: { username: 'zhangsan', credential: '' },
      sessionKey: 's_off', prompt: '帮我看看报错', source: 'test',
    })
    assert.equal(captured.titleCalls, 0)
    // 退回截断标题，仍然有个能认的名字
    assert.equal((await sessions.load({ username: 'zhangsan', sessionKey: 's_off' })).title, '帮我看看报错')
  })
})
