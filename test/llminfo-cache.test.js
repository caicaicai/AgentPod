/**
 * 模型清单缓存行为回归。
 *
 * 这两条都来自真实故障：
 *   1. 缓存必须按**凭据主体**，不能按业务用户名 —— 否则会出现
 *      "一个对话框正常、另一个提示需要登录"的不对称（另一个 username 每次都要重打上游）。
 *   2. 上游失败时要退回过期缓存 —— 否则用户会在对话中途被踢成"未登录"。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createLlmInfoClient } from '../src/models/llminfo-client.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

function makeConfig(ttlMs = 60000) {
  return { llm: { cacheTtlMs: ttlMs }, platform: { speedApiBase: 'http://x', referer: 'http://y' } }
}

function makePlatform(responses) {
  let calls = 0
  return {
    calls: () => calls,
    async getJson() {
      calls += 1
      const next = responses[Math.min(calls - 1, responses.length - 1)]
      return typeof next === 'function' ? next(calls) : next
    },
  }
}

const okResponse = {
  ok: true,
  data: { user: { username: 'someone' }, llms: [{ model: 'M1', server: 'http://gw/v1', key: 'TOKEN' }] },
}

describe('llminfo 缓存', () => {
  test('同一登录态的不同业务用户名共用缓存，只打一次上游', async () => {
    const platform = makePlatform([okResponse])
    const client = createLlmInfoClient({ config: makeConfig(), platform, logger: silentLogger })

    const first = await client.get({ credential: 'cookie-abc' })
    const second = await client.get({ credential: 'cookie-abc' })

    assert.equal(platform.calls(), 1, '同一登录态不该重复打上游')
    assert.equal(second.cached, true)
    assert.equal(first.llms[0].model, 'M1')
  })

  test('不同登录态各自缓存', async () => {
    const platform = makePlatform([okResponse])
    const client = createLlmInfoClient({ config: makeConfig(), platform, logger: silentLogger })

    await client.get({ credential: 'cookie-a' })
    await client.get({ credential: 'cookie-b' })
    assert.equal(platform.calls(), 2)
  })

  test('上游失败但有缓存时退回过期数据，不把用户踢成未登录', async () => {
    const platform = makePlatform([
      okResponse,
      { ok: false, status: 401, error: '此路由需要登录访问，请先登录', unauthenticated: true },
    ])
    const client = createLlmInfoClient({ config: makeConfig(0), platform, logger: silentLogger }) // ttl=0 强制过期

    await client.get({ credential: 'cookie-abc' })
    const stale = await client.get({ credential: 'cookie-abc' })

    assert.equal(stale.stale, true, '应退回过期缓存')
    assert.equal(stale.llms[0].model, 'M1')
    assert.match(stale.warning, /退回/)
  })

  test('上游失败且无缓存时抛 UNAUTHENTICATED，让调用方去引导重新授权', async () => {
    const platform = makePlatform([{ ok: false, status: 401, error: '需要登录', unauthenticated: true }])
    const client = createLlmInfoClient({ config: makeConfig(), platform, logger: silentLogger })

    await assert.rejects(
      () => client.get({ credential: 'cookie-x' }),
      (error) => error.code === 'UNAUTHENTICATED',
    )
  })

  test('模型清单对外不含 llmToken', async () => {
    const { toPublicModels } = await import('../src/models/llminfo-client.js')
    const publicView = toPublicModels([{ model: 'M1', server: 'http://gw/v1', key: 'SECRET_TOKEN', contextWindow: 1, maxTokens: 2 }])
    assert.equal(JSON.stringify(publicView).includes('SECRET_TOKEN'), false, 'llmToken 泄漏到了对外视图')
  })
})
