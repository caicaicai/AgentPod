/**
 * 输出被截断（stopReason='length'）必须看得见。
 *
 * ── 背景 ────────────────────────────────────────────────────────────
 *
 * 以前只有 `stopReason === 'error'` 被特殊对待，`'length'` 原样透传、无人处理，
 * 界面上和正常回答**长得一模一样**。线上实测的样子：模型写的 python 文件停在
 * `print("接口返回`，接着 SyntaxError → edit 少传 edits → edit 撞重复文本 → read → edit，
 * 7 次工具调用里 5 次在给这一次截断擦屁股；最后给用户的结论还是编的
 * （脚本没打印 body，它说"body 为空，建议检查接口文档"）。
 *
 * 表现是"模型变笨了"，根因是被我们掐了 —— 这正是必须显式报出来的理由。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { describeStop, isAbnormalStop } from '../src/stop-reason.js'
import { buildModel } from '../src/models/model-factory.js'
import { parseTranscript } from '../src/sessions/transcript.js'
import { toClientFrames } from '../src/agent/events.js'

describe('结束原因的翻译', () => {
  test('length 出告警，且说清后果', () => {
    const { error, warning } = describeStop({ stopReason: 'length' })
    assert.equal(error, '', '截断不是 error —— 这一轮有输出、还会继续调工具')
    assert.match(warning, /截断/)
    // 只说"被截断了"不够：用户得知道该怀疑什么
    assert.match(warning, /max_tokens/)
    assert.match(warning, /工具参数|不完整/)
  })

  test('error 仍然走 error，文案不丢', () => {
    const { error, warning } = describeStop({ stopReason: 'error', errorMessage: '网关炸了' })
    assert.equal(error, '网关炸了')
    assert.equal(warning, '')
  })

  test('error 没带文案时给个兜底 —— 空气泡最难查', () => {
    assert.equal(describeStop({ stopReason: 'error' }).error, '模型调用失败')
  })

  test('正常结束不产生任何提示', () => {
    for (const stopReason of ['stop', 'toolUse', '', undefined]) {
      const { error, warning } = describeStop({ stopReason })
      assert.equal(error, '', `${stopReason} 不该报错`)
      assert.equal(warning, '', `${stopReason} 不该告警`)
    }
  })

  test('isAbnormalStop 只挑异常的，正常的不刷日志', () => {
    assert.equal(isAbnormalStop('length'), true)
    assert.equal(isAbnormalStop('error'), true)
    assert.equal(isAbnormalStop('aborted'), true)
    assert.equal(isAbnormalStop('stop'), false)
    assert.equal(isAbnormalStop('toolUse'), false)
    assert.equal(isAbnormalStop(''), false)
  })
})

/**
 * 实时与历史必须同源 —— 与 turnStats 同一个教训：
 * 两条路各写一份，同一轮对话刷新前后显示的东西就会不一样。
 */
describe('实时与历史给出同一句话', () => {
  const truncatedMessage = {
    role: 'assistant',
    stopReason: 'length',
    content: [{ type: 'text', text: '我来写个脚本' }],
    timestamp: '2026-08-06T09:00:00.000Z',
  }

  /** 会话文件是每行一条 `{type:'message', message, timestamp}` */
  const entry = (message) => JSON.stringify({
    type: 'message', message, timestamp: '2026-08-06T09:00:00.000Z',
  })

  test('历史：parseTranscript 把告警挂在消息上', () => {
    const { messages } = parseTranscript(entry(truncatedMessage))
    const assistant = messages.find((m) => m.role === 'assistant')
    assert.ok(assistant, '没解析出助手消息')
    // 先钉住"非空"，再比对同源 —— 只比对的话，两边一起变空也能过。
    assert.ok(assistant.warning, '历史里没有截断告警')
    assert.equal(assistant.warning, describeStop(truncatedMessage).warning)
  })

  test('实时：text_end 帧带上同一句话', () => {
    const frames = []
    toClientFrames(
      { type: 'message_end', message: truncatedMessage },
      (type, data) => frames.push({ type, data }),
    )
    const textEnd = frames.find((f) => f.type === 'text_end')
    assert.ok(textEnd, '没有 text_end 帧')
    assert.ok(textEnd.data.warning, '实时帧里没有截断告警')
    assert.equal(textEnd.data.warning, describeStop(truncatedMessage).warning)
    assert.equal(textEnd.data.stopReason, 'length')
  })

  test('只有告警、没有正文的消息也要保留 —— 否则截断在历史里彻底消失', () => {
    // 截断可能发生在模型还没吐出任何文本的时候（比如正在拼工具参数）。
    // 旧的过滤条件只看 text/thinking/toolCalls/error，这种消息会被整条丢掉。
    const { messages } = parseTranscript(entry({ role: 'assistant', stopReason: 'length', content: [] }))
    assert.equal(messages.filter((m) => m.role === 'assistant').length, 1, '空正文的截断消息被丢掉了')
  })
})

/**
 * max_tokens 的来源。
 *
 * 平台确实会给（workers/llminfo.lua → modules/llm_models.lua 的
 * `entry.maxTokens or DEFAULT_MAX_TOKENS(8192)`），实测三个模型都是 8192。
 * 所以重点不是"补一个兜底"，而是**别自己编一个更小的**：
 * 以前这里是 `Number(llm.maxTokens) || 4096`，一旦平台哪天没给这个字段，
 * 我们就会悄悄把上限压到 4096，而撞上限的表现是工具参数断在一半 —— 极难认。
 */
describe('max_tokens 只跟平台走，不自己编', () => {
  test('平台给了就用平台的', () => {
    assert.equal(buildModel({ model: 'm', server: 'http://gw/v1', key: 'k', maxTokens: 8192 }).maxTokens, 8192)
  })

  test('平台没给就**整个字段不出现** —— 交给网关的默认值', () => {
    for (const llm of [
      { model: 'm', server: 'http://gw/v1', key: 'k' },
      { model: 'm', server: 'http://gw/v1', key: 'k', maxTokens: 0 },
      { model: 'm', server: 'http://gw/v1', key: 'k', maxTokens: 'abc' },
    ]) {
      const model = buildModel(llm)
      assert.ok(!('maxTokens' in model), `不该凭空造 maxTokens：${JSON.stringify(llm)}`)
    }
  })

  test('不能写成 0 —— pi 的 model-registry 对 maxTokens<=0 直接抛 invalid maxTokens', () => {
    const model = buildModel({ model: 'm', server: 'http://gw/v1', key: 'k' })
    assert.notEqual(model.maxTokens, 0)
  })
})
