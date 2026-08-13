/**
 * 每轮回复的「耗时 / 工具调用次数」。
 *
 * 最要紧的一条不是数值对不对，而是**实时那一轮和刷新之后的历史必须一模一样**。
 * 两边各算各的话，用户会看到"刚发完 12.3 秒、一刷新 11.8 秒"，当成 bug 报上来
 * 而且没法解释。所以服务端跑完也走 parseTranscript 这条路（run-turn.js 的
 * lastTurnStats），这组用例钉的就是这个同源关系。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { registerFauxProvider, fauxAssistantMessage } from '@mariozechner/pi-ai'

import { parseTranscript, attachTurnStats } from '../src/sessions/transcript.js'
import { runTurn } from '../src/agent/run-turn.js'
import { createMemorySessionStore as createMemoryStore } from './helpers/memory-session-store.js'
import { buildModel } from '../src/models/model-factory.js'

/** 拼一行 pi 的 JSONL */
const line = (obj) => `${JSON.stringify(obj)}\n`

const userMsg = (text, ts) => line({ type: 'message', timestamp: ts, message: { role: 'user', content: text } })

const assistantMsg = (ts, { text = '', toolCalls = [] } = {}) => line({
  type: 'message',
  timestamp: ts,
  message: {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...toolCalls.map((id) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'ls' } })),
    ],
  },
})

const toolResult = (id, ts) => line({
  type: 'message',
  timestamp: ts,
  message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: 'ok' }] },
})

const T0 = Date.parse('2026-08-05T10:00:00.000Z')
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString()

/** 取最后一条带统计的 assistant 消息 */
const statsOf = (messages) => [...messages].reverse().find((m) => m.turnStats)?.turnStats

describe('每轮统计', () => {
  test('耗时 = 用户消息到本轮最后一条助手消息', () => {
    const jsonl = userMsg('你好', at(0)) + assistantMsg(at(3200), { text: '你好' })
    const { messages } = parseTranscript(jsonl)
    assert.deepEqual(statsOf(messages), { durationMs: 3200, toolCalls: 0 })
  })

  test('一轮里的多条助手消息算作同一轮，工具次数累加', () => {
    // "先说我查一下 → 调工具 → 再说结论"是**一条**回复的三段，不是三轮
    const jsonl =
      userMsg('查一下', at(0)) +
      assistantMsg(at(1000), { text: '我查一下', toolCalls: ['c1', 'c2'] }) +
      toolResult('c1', at(2000)) +
      toolResult('c2', at(2500)) +
      assistantMsg(at(9000), { text: '结论是…', toolCalls: ['c3'] }) +
      toolResult('c3', at(9500)) +
      assistantMsg(at(12000), { text: '好了' })
    const { messages } = parseTranscript(jsonl)
    assert.deepEqual(statsOf(messages), { durationMs: 12000, toolCalls: 3 })
  })

  test('统计挂在本轮**最后一条**助手消息上，中间那些没有', () => {
    // 前端按同样的规则分组，挂错位置会导致上一轮的数字显示到下一轮头上
    const jsonl =
      userMsg('a', at(0)) + assistantMsg(at(1000), { text: '一' }) + assistantMsg(at(2000), { text: '二' })
    const { messages } = parseTranscript(jsonl)
    const assistants = messages.filter((m) => m.role === 'assistant')
    assert.equal(assistants.length, 2)
    assert.equal(assistants[0].turnStats, undefined, '中间那条不该带统计')
    assert.deepEqual(assistants[1].turnStats, { durationMs: 2000, toolCalls: 0 })
  })

  test('多轮各算各的，不会把上一轮的工具数带过来', () => {
    const jsonl =
      userMsg('第一问', at(0)) + assistantMsg(at(5000), { text: 'A', toolCalls: ['c1'] }) + toolResult('c1', at(4000)) +
      userMsg('第二问', at(10000)) + assistantMsg(at(13000), { text: 'B' })
    const { messages } = parseTranscript(jsonl)
    const withStats = messages.filter((m) => m.turnStats)
    assert.equal(withStats.length, 2)
    assert.deepEqual(withStats[0].turnStats, { durationMs: 5000, toolCalls: 1 })
    assert.deepEqual(withStats[1].turnStats, { durationMs: 3000, toolCalls: 0 }, '第二轮把第一轮的工具数带过来了')
  })

  test('没有时间戳的老会话：耗时给 null，不拿 0 冒充', () => {
    // 显示"耗时 0.0 秒"比不显示更糟 —— 它看着像个测量结果，其实是没测到
    const jsonl =
      line({ type: 'message', message: { role: 'user', content: 'a' } }) +
      line({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } })
    const { messages } = parseTranscript(jsonl)
    assert.deepEqual(statsOf(messages), { durationMs: null, toolCalls: 0 })
  })

  test('时钟倒挂时也给 null —— 不显示负的耗时', () => {
    // 多副本之间有时钟偏差时真的会出现
    const jsonl = userMsg('a', at(5000)) + assistantMsg(at(1000), { text: 'b' })
    const { messages } = parseTranscript(jsonl)
    assert.equal(statsOf(messages).durationMs, null)
  })

  test('历史开头就是助手消息（被截断过）时不炸，耗时给 null', () => {
    const jsonl = assistantMsg(at(1000), { text: '半截历史' })
    const { messages } = parseTranscript(jsonl)
    assert.deepEqual(statsOf(messages), { durationMs: null, toolCalls: 0 })
  })

  test('toolResult 行不算一次工具调用', () => {
    // 一次调用会产生 toolCall + toolResult 两行，两头都数就翻倍了
    const jsonl = userMsg('a', at(0)) + assistantMsg(at(1000), { toolCalls: ['c1'] }) + toolResult('c1', at(500))
    const { messages } = parseTranscript(jsonl)
    assert.equal(statsOf(messages).toolCalls, 1)
  })

  test('attachTurnStats 是纯粹按消息列表算的，不依赖 JSONL', () => {
    // run-turn.js 与前端都靠它，形状必须稳定
    const messages = attachTurnStats([
      { role: 'user', timestamp: 100 },
      { role: 'assistant', timestamp: 700, toolCalls: [{}, {}] },
    ])
    assert.deepEqual(messages[1].turnStats, { durationMs: 600, toolCalls: 2 })
  })
})

/**
 * 跑一轮**真的** runTurn（faux 模型顶掉真实模型，不发网络请求、不烧 token），
 * 拿它回的 turnStats 跟"从存下来的会话重新解析"对拍。
 *
 * 这是唯一能钉住核心约束的测法：只要有人把 turnStats 换成
 * `Date.now() - startedAt`，那个数就会**多出建临时目录、铺技能、创建 agent session
 * 的时间**（几十毫秒量级），而从时间戳算出来的不会 —— 于是这里不相等。
 *
 * 单靠"两个纯函数对拍"钉不住这件事：它证明不了 run-turn.js 真的走了这条路。
 * 界面上也钉不住 —— 几十毫秒的差在"耗时 0.4 秒"这个粒度上看不出来，
 * 实测过一次，变异跑出来是绿的。
 */
describe('实时与历史必须同源（跑真的一轮）', () => {
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

  const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

  test('final 帧里的 turnStats == 从存下来的会话重新算出来的', async () => {
    const responder = () => fauxAssistantMessage('好的')
    faux.setResponses([responder])

    const store = createMemoryStore()
    const result = await runTurn({
      runId: 'r1',
      username: 'someone',
      sessionKey: 'main',
      prompt: '你好',
      model,
      store,
      sandbox: { mode: 'none' },
      logger: silentLogger,
      timeoutMs: 30000,
    })

    assert.ok(result.turnStats, 'runTurn 没回 turnStats')

    // 刷新之后走的就是这条：从存储里读回 jsonl 再解析
    const saved = await store.load({ username: 'someone', sessionKey: 'main' })
    const history = statsOf(parseTranscript(saved.jsonl).messages)

    assert.deepEqual(
      result.turnStats,
      history,
      '实时那一轮和刷新后的历史算出来不一样 —— 用户会看到数字在刷新后跳变',
    )
  })
})
