/**
 * 发给网关的请求体必须用**这个上游认识的形状**。
 *
 * ── 抓到的实例 ──────────────────────────────────────────────────────
 *
 * 上游原话（追平台日志才拿到的，我们这边只看到 `400 模型服务调用失败`）：
 *
 *   messages[0] has invalid role: developer, must be one of [user, assistant, system, tool]
 *
 * 成因是两个条件相乘：
 *   1. llminfo 把三个模型全标了 `reasoning: true`
 *   2. pi 的 `detectCompat` 按 baseUrl / provider **白名单**认"非标准"实现，
 *      我们这个网关不在任何名单里 → 被当成标准 OpenAI → `supportsDeveloperRole: true`
 * 于是 `useDeveloperRole = model.reasoning && compat.supportsDeveloperRole` 成立，
 * 系统提示被发成 `role: "developer"`。
 *
 * 迷惑性在于网关把它包成 `400 模型服务调用失败` —— 看着像"服务不稳定"，
 * 实际上**每一条请求都发错了**，重试多少次都一样。
 *
 * ── 为什么不断言 model.compat 就完事 ────────────────────────────────
 *
 * 那只能证明我们**填了**一个字段，证明不了 pi 会用它。这里把请求真的发出去，
 * 用一个假网关接住，直接看 messages[0].role。pi 哪天改了 compat 的用法，这里会红。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { streamOpenAICompletions } from '@mariozechner/pi-ai'

import { buildModel } from '../src/models/model-factory.js'

/** 假网关：接住请求体，回一个最小的合法 SSE 流 */
function startFakeGateway() {
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { seen.push(JSON.parse(raw)) } catch { seen.push({ __unparsed: raw }) }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n')
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return { server, seen }
}

describe('请求体的兼容口味', () => {
  let server
  let seen
  let baseUrl

  before(async () => {
    ({ server, seen } = startFakeGateway())
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}/ap/v1`
  })
  after(() => new Promise((resolve) => server.close(resolve)))

  /** 走一次真的 pi provider，回收网关收到的请求体 */
  async function requestBodyFor(llm, options = {}) {
    seen.length = 0
    const model = buildModel({ server: baseUrl, key: 'k', ...llm }, options)
    const stream = streamOpenAICompletions(model, {
      systemPrompt: '你是助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    }, { apiKey: 'k' })
    // 把流走完，否则请求可能还没发完
    for await (const _event of stream) { /* drain */ }
    assert.equal(seen.length, 1, '网关没收到请求')
    return seen[0]
  }

  test('reasoning 模型的系统提示也必须是 system，不能是 developer', async () => {
    // reasoning: true 正是 llminfo 对三个模型的真实声明
    const body = await requestBodyFor({ model: 'GLM-5.1', reasoning: true })
    assert.equal(
      body.messages[0].role,
      'system',
      '系统提示又发成 developer 了 —— 这个上游只认 [user, assistant, system, tool]',
    )
  })

  test('非 reasoning 模型同样是 system（这条本来就对，别改坏了）', async () => {
    const body = await requestBodyFor({ model: 'plain', reasoning: false })
    assert.equal(body.messages[0].role, 'system')
  })

  test('请求体里根本不该出现 developer 这个角色', async () => {
    const body = await requestBodyFor({ model: 'GLM-5.1', reasoning: true })
    const roles = body.messages.map((m) => m.role)
    assert.ok(!roles.includes('developer'), `出现了 developer：${JSON.stringify(roles)}`)
    // 顺带钉住上游允许的集合
    for (const role of roles) {
      assert.ok(['user', 'assistant', 'system', 'tool'].includes(role), `上游不认的角色：${role}`)
    }
  })
})

describe('上限字段名可切换（下一个嫌疑人）', () => {
  let server
  let seen
  let baseUrl

  before(async () => {
    ({ server, seen } = startFakeGateway())
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}/ap/v1`
  })
  after(() => new Promise((resolve) => server.close(resolve)))

  async function bodyWith(maxTokensField) {
    seen.length = 0
    const model = buildModel(
      { model: 'GLM-5.1', server: baseUrl, key: 'k', reasoning: true, maxTokens: 8192 },
      { maxTokensField },
    )
    const stream = streamOpenAICompletions(model, {
      systemPrompt: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }, { apiKey: 'k', maxTokens: 8192 })
    for await (const _event of stream) { /* drain */ }
    return seen[0]
  }

  test('默认不干预 —— 用 pi 探测出来的字段名', async () => {
    const body = await bodyWith('')
    assert.ok(
      'max_completion_tokens' in body || 'max_tokens' in body,
      `两个都没发：${JSON.stringify(Object.keys(body))}`,
    )
  })

  test('设成 max_tokens 就真的发 max_tokens', async () => {
    // 上游是老版 schema（连 developer 都不认），真报错时靠这个开关一行配置解决
    const body = await bodyWith('max_tokens')
    assert.equal(body.max_tokens, 8192)
    assert.ok(!('max_completion_tokens' in body))
  })
})
