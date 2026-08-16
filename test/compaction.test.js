/**
 * 上下文压缩的**可见性**。
 *
 * ── 这一组要守住的是什么 ────────────────────────────────────────────────
 *
 * 压缩不是这次新加的能力 —— pi 的 `DEFAULT_COMPACTION_SETTINGS.enabled` 一直是
 * true，也就是说它**一直在发生**。缺的是"说出来"。缺席的代价是两个用户一定会
 * 注意到、却没有任何地方解释的现象：
 *
 *   1. 长会话里某一轮忽然十几秒不出字（压缩要另外调一次模型写摘要）；
 *   2. 模型对前面聊过的细节记不清了（更早的对话只剩一段摘要）。
 *
 * 两个都真实，两个都没解释 —— 于是它们被归因成"这个模型变笨了"。
 *
 * 所以下面测的不是"压缩算得对不对"（那是 pi 的事），而是**每一条通往用户的路
 * 上，这件事有没有被说出来**：事件流里有没有帧、历史里有没有分隔线、
 * 开关传下去了没有。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { toClientFrames, CLIENT_EVENTS } from '../src/agent/events.js'
import { parseTranscript } from '../src/sessions/transcript.js'
import { loadConfig } from '../src/config.js'

/** 收集 emit 出来的帧，断言时直接看这个数组 */
function collect(event) {
  const frames = []
  toClientFrames(event, (type, data) => frames.push({ type, data }))
  return frames
}

describe('事件帧', () => {
  test('compaction 在对外事件清单里 —— 不在的话客户端没有理由去解析它', () => {
    assert.ok(CLIENT_EVENTS.includes('compaction'))
  })

  test('开始压缩转成一帧，带上是哪一种触发', () => {
    const [frame] = collect({ type: 'compaction_start', reason: 'threshold' })
    assert.equal(frame.type, 'compaction')
    assert.equal(frame.data.state, 'start')
    assert.equal(frame.data.reason, 'threshold')
  })

  /**
   * `overflow` 与另外两种意义不同：那是**已经撞上**了，压缩是在救这一轮。
   * 界面对它的说法该不一样（"这条会话该收尾了"），所以 reason 必须原样带出去。
   */
  test('三种触发原因都原样带出去', () => {
    for (const reason of ['manual', 'threshold', 'overflow']) {
      const [frame] = collect({ type: 'compaction_start', reason })
      assert.equal(frame.data.reason, reason)
    }
  })

  test('结束帧带上压缩前的上下文有多大', () => {
    const [frame] = collect({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: '……', tokensBefore: 123456 },
      aborted: false,
      willRetry: false,
    })
    assert.equal(frame.data.state, 'end')
    assert.equal(frame.data.tokensBefore, 123456)
  })

  /**
   * **摘要正文不出去。**
   *
   * 它是这个用户自己的对话内容（不跨用户，所以不是泄漏面），但推给界面没有意义：
   * 用户要知道的是"发生了压缩、上下文降下来了"，不是去读一份自己对话的复述。
   * 一段几千字的摘要塞进事件流，只会把真正的回答挤下去。
   */
  test('摘要正文不进事件流', () => {
    const [frame] = collect({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: '这是一段很长的会话摘要', tokensBefore: 100 },
    })
    assert.equal(frame.data.summary, undefined)
    assert.equal(JSON.stringify(frame.data).includes('很长的会话摘要'), false)
  })

  /**
   * `willRetry` 不带出去的话，一次失败的压缩之后紧跟着又一次 compaction_start，
   * 界面上看起来像是压缩卡在无限循环里。
   */
  test('还会再试一次这件事要带出去', () => {
    const [frame] = collect({
      type: 'compaction_end',
      reason: 'threshold',
      result: undefined,
      aborted: false,
      willRetry: true,
      errorMessage: '上游超时',
    })
    assert.equal(frame.data.willRetry, true)
    assert.equal(frame.data.errorMessage, '上游超时')
    // 压缩没成，没有 tokensBefore 可言 —— 不要拿 0 冒充一个真实的数
    assert.equal(frame.data.tokensBefore, 0)
  })
})

describe('历史里的压缩点', () => {
  /**
   * pi 的会话是 append-only 的：压缩**不删任何一行**，只追加一条 compaction 条目，
   * 说明"从这里往前，模型看到的是摘要"。所以历史本身是完整的，
   * 而那条分隔线是屏幕上唯一说得清"模型为什么忘了上面的事"的东西。
   */
  const jsonl = [
    JSON.stringify({ type: 'session', id: 's1' }),
    JSON.stringify({ type: 'message', timestamp: 1000, message: { role: 'user', content: '第一个问题' } }),
    JSON.stringify({
      type: 'message',
      timestamp: 2000,
      message: { role: 'assistant', content: [{ type: 'text', text: '第一个回答' }] },
    }),
    JSON.stringify({ type: 'compaction', timestamp: 3000, summary: '前面聊了一些事', tokensBefore: 120000 }),
    JSON.stringify({ type: 'message', timestamp: 4000, message: { role: 'user', content: '第二个问题' } }),
  ].join('\n')

  test('压缩点进消息流，带上压缩前的规模', () => {
    const { messages } = parseTranscript(jsonl)
    const mark = messages.find((message) => message.role === 'compaction')
    assert.ok(mark, '历史里必须看得见压缩发生过')
    assert.equal(mark.tokensBefore, 120000)
    assert.equal(mark.timestamp, 3000)
  })

  test('它落在正确的位置上 —— 前后各是哪一轮不能错', () => {
    const { messages } = parseTranscript(jsonl)
    const roles = messages.map((message) => message.role)
    assert.deepEqual(roles, ['user', 'assistant', 'compaction', 'user'])
  })

  /** 摘要正文同样不出去，理由与事件帧那条一样 */
  test('摘要正文不进历史', () => {
    const { messages } = parseTranscript(jsonl)
    const mark = messages.find((message) => message.role === 'compaction')
    assert.equal(mark.summary, undefined)
  })

  /**
   * `attachTurnStats` 按 user/assistant 分轮。压缩条目夹在中间时它必须被跳过，
   * 否则那一轮的耗时会从"用户提问到助手答完"变成一个混进了压缩点的数。
   */
  test('不打乱每一轮的耗时统计', () => {
    const { messages } = parseTranscript(jsonl)
    const assistant = messages.find((message) => message.role === 'assistant')
    assert.equal(assistant.turnStats.durationMs, 1000) // 2000 - 1000
  })

  test('没压缩过的会话里一条都不会多出来', () => {
    const plain = [
      JSON.stringify({ type: 'session', id: 's2' }),
      JSON.stringify({ type: 'message', timestamp: 1, message: { role: 'user', content: '问' } }),
    ].join('\n')
    const { messages } = parseTranscript(plain)
    assert.equal(messages.some((message) => message.role === 'compaction'), false)
  })
})

describe('开关', () => {
  const BASE = {
    SANDBOX_MODE: 'none', AUTH_MODE: 'dev', LLM_MODE: 'faux',
    MYSQL_HOST: 'db.example', MYSQL_USER: 'ap', MYSQL_DATABASE: 'ap',
  }
  // cwd 指向一个不存在的目录：否则 loadConfig 会读到仓库根目录下真实的 .env
  const load = (extra = {}) => loadConfig({ env: { ...BASE, ...extra }, cwd: '/nonexistent' })

  /**
   * 默认必须**开着**，而且必须与 pi 的默认值一致。
   *
   * 这一条守的是"接开关这件事没有改掉行为"：默认值一旦不一样，
   * 所有既有部署会在升级的那一刻悄悄换掉"模型能记多久"。
   */
  test('默认开着 —— 与 pi 的默认值一致，接开关不改变行为', () => {
    const config = load()
    assert.equal(config.llm.compaction.enabled, true)
  })

  /**
   * 两个尺寸默认 0，含义是"不覆盖，用 pi 的默认值"。
   * 编一个我们自己的数字，等于在没有依据的情况下改掉摘要的粒度。
   */
  test('两个尺寸默认 0 = 不覆盖 pi 的默认值', () => {
    const config = load()
    assert.equal(config.llm.compaction.reserveTokens, 0)
    assert.equal(config.llm.compaction.keepRecentTokens, 0)
  })

  test('可以关，也可以调尺寸', () => {
    const config = load({
      COMPACTION_ENABLED: '0',
      COMPACTION_RESERVE_TOKENS: '8192',
      COMPACTION_KEEP_RECENT_TOKENS: '30000',
    })
    assert.equal(config.llm.compaction.enabled, false)
    assert.equal(config.llm.compaction.reserveTokens, 8192)
    assert.equal(config.llm.compaction.keepRecentTokens, 30000)
  })
})
