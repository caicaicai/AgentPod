/**
 * 断线重连在**浏览器那一侧**的两条硬约定。
 *
 *   1. SSE 的 `id:` 要被解析出来并交给上层 —— 它是断点。从前这一行是被忽略的
 *      （没有任何东西需要它），忽略着也完全看不出问题：流照常渲染，只是断线
 *      之后没有任何东西能说明"我看到第几帧了"。
 *   2. 重连走的是 **GET /v1/runs/:id/events**，不是再 POST 一次 /v1/chat/stream。
 *      写错的代价很具体：一次网络抖动 = 又跑一轮 = 又烧一份 token，
 *      而且用户会看到同一个问题被回答两遍。
 *
 * 这两条服务端全对也照样会坏，所以钉在这儿。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const webSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/src')
const api = await import(pathToFileURL(path.join(webSrc, 'lib/api.js')).href)

/** 把若干帧拼成一段 SSE 正文，并包成一个能被 fetch 返回的响应 */
function sseResponse(frames, { ok = true, status = 200 } = {}) {
  const text = frames.map(({ id, event, data }) => (
    `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  )).join('')
  const bytes = new TextEncoder().encode(text)
  return {
    ok,
    status,
    body: {
      getReader() {
        let sent = false
        return {
          async read() {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: bytes }
          },
        }
      },
    },
    text: async () => text,
  }
}

let calls
let originalFetch
let originalLocalStorage
let originalPerformance

beforeEach(() => {
  calls = []
  originalFetch = globalThis.fetch
  originalLocalStorage = globalThis.localStorage
  originalPerformance = globalThis.performance
  // api.js 只在**调用**时碰这两个，所以替身可以很薄
  globalThis.localStorage = { getItem: () => '', setItem() {}, removeItem() {} }
  if (!globalThis.performance) globalThis.performance = { now: () => 0 }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.localStorage = originalLocalStorage
  globalThis.performance = originalPerformance
})

describe('SSE 断点', () => {
  test('id: 那一行会被解析出来，作为第三个参数交给上层', async () => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, method: init?.method })
      return sseResponse([
        { id: 7, event: 'run_start', data: { runId: 'r1' } },
        { id: 8, event: 'text', data: { delta: '你' } },
        { id: 9, event: 'final', data: { text: '你好' } },
      ])
    }

    const seen = []
    await api.streamChat({ prompt: 'hi', sessionKey: 's1' }, (type, data, seq) => seen.push([type, seq]))

    assert.deepEqual(seen, [['run_start', 7], ['text', 8], ['final', 9]])
  })

  test('没有 id: 的帧回 0，而不是 NaN —— 上层拿它当断点会一路传到服务端', async () => {
    globalThis.fetch = async () => sseResponse([{ event: 'text', data: { delta: 'x' } }])

    const seen = []
    await api.streamChat({ prompt: 'hi', sessionKey: 's1' }, (type, data, seq) => seen.push(seq))

    assert.deepEqual(seen, [0])
  })
})

describe('resumeRun', () => {
  test('走 GET /v1/runs/:id/events，并把断点带在 from 上', async () => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, method: init?.method })
      return sseResponse([{ id: 12, event: 'final', data: { text: '接上了' } }])
    }

    await api.resumeRun({ runId: 'run_abc', from: 11 }, () => {})

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'GET', '必须是 GET —— POST 会变成又跑一轮')
    assert.equal(calls[0].url, '/v1/runs/run_abc/events?from=11')
  })

  test('runId 会被转义 —— 别让它拼出一条别的路径', async () => {
    globalThis.fetch = async (url) => {
      calls.push({ url })
      return sseResponse([])
    }

    await api.resumeRun({ runId: 'a/../b', from: 0 }, () => {})
    assert.equal(calls[0].url, '/v1/runs/a%2F..%2Fb/events?from=0')
  })

  test('接回来的帧与新发起的走同一套解析（含 id）', async () => {
    globalThis.fetch = async () => sseResponse([
      { id: 5, event: 'text', data: { delta: 'a' } },
      { id: 6, event: 'final', data: { text: 'a' } },
    ])

    const seen = []
    await api.resumeRun({ runId: 'r1', from: 4 }, (type, data, seq) => seen.push([type, seq]))
    assert.deepEqual(seen, [['text', 5], ['final', 6]])
  })

  test('run 没了时抛的是带 status 的 ApiError —— 上层据此决定别再重试', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      body: null,
      // toApiError 会读 x-request-id / x-trace-id，真实的 Response 一定有 headers
      headers: { get: () => '' },
      text: async () => JSON.stringify({ error: 'NOT_FOUND', message: 'run 不存在或已过期' }),
    })

    await assert.rejects(
      () => api.resumeRun({ runId: 'gone', from: 0 }, () => {}),
      (error) => {
        assert.ok(error instanceof api.ApiError)
        assert.equal(error.status, 404)
        return true
      },
    )
  })
})
