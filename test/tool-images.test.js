/**
 * 截图能不能被**看到** —— 两条互不相干的链路，都出过问题：
 *
 *   模型看不看得到  → 取决于 model.input 有没有 'image'。没有的话 pi 在
 *                     openai-completions 层把 image part **静默丢掉**，
 *                     模型只收到"Screenshot captured: 11622 bytes"，
 *                     然后说"截图拿到了但我看不见"。
 *   用户看不看得到  → 取决于 toolResultPreview 有没有把图片转发给浏览器。
 *                     从前一律换成 `[image]` 占位，于是界面上什么都没有。
 *
 * 两条各修各的，也各测各的。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { toolResultPreview } from '../src/agent/events.js'
import { buildModel } from '../src/models/model-factory.js'
import { runTurn } from '../src/agent/run-turn.js'
import { createMemoryStore } from '../src/sessions/store.js'
import { parseTranscript } from '../src/sessions/transcript.js'

/** 一张 1x1 的 PNG */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

describe('图片送到浏览器', () => {
  test('图片单独走 images 字段，preview 里不留 base64', () => {
    const out = toolResultPreview({
      content: [{ type: 'text', text: '截图完成' }, { type: 'image', data: PNG, mimeType: 'image/png' }],
    })
    assert.equal(out.preview, '截图完成')
    assert.equal(out.images.length, 1)
    assert.equal(out.images[0].data, PNG)
  })

  test('没有图片时不带 images 字段 —— 别给每条工具结果都塞个空数组', () => {
    assert.equal(toolResultPreview({ content: [{ type: 'text', text: 'ok' }] }).images, undefined)
  })

  test('mimeType 收白名单 —— 它决定浏览器怎么解析这段字节', () => {
    // data:<mime>;base64,… 里的 mime 由工具返回值决定。原样透传等于让工具
    // 决定"这段 base64 按什么执行"。
    const out = toolResultPreview({
      content: [{ type: 'image', data: PNG, mimeType: 'text/html' }],
    })
    assert.equal(out.images, undefined, '非图片 mime 被放行了')
    assert.match(out.preview, /未在界面上显示/)
  })

  test('data 不是干净的 base64 就不往浏览器送', () => {
    const out = toolResultPreview({ content: [{ type: 'image', data: '<script>x</script>', mimeType: 'image/png' }] })
    assert.equal(out.images, undefined)
  })

  test('过大的图退回提示，不是静默丢掉', () => {
    const out = toolResultPreview({
      content: [{ type: 'text', text: '整页截图' }, { type: 'image', data: 'A'.repeat(2_000_000), mimeType: 'image/png' }],
    })
    assert.equal(out.images, undefined)
    assert.match(out.preview, /另有 1 张图片过大/)
  })

  test('超过数量上限的部分也要说明', () => {
    const parts = [{ type: 'text', text: 'x' }]
    for (let i = 0; i < 6; i += 1) parts.push({ type: 'image', data: PNG, mimeType: 'image/png' })
    const out = toolResultPreview({ content: parts })
    assert.equal(out.images.length, 4)
    assert.match(out.preview, /另有 2 张图片/)
  })

  test('其它类型仍然只留占位', () => {
    const out = toolResultPreview({ content: [{ type: 'audio', data: 'zzz' }] })
    assert.equal(out.preview, '[audio]')
  })

  test('刷新之后历史里也有图 —— 图本来就存在会话 JSONL 里', () => {
    // 这一条决定了"要不要另建存储"：不用，pi 已经把 image part 写进去了
    const jsonl = [
      JSON.stringify({ type: 'message', timestamp: '2026-08-05T10:00:00.000Z', message: { role: 'user', content: '截图' } }),
      JSON.stringify({
        type: 'message', timestamp: '2026-08-05T10:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'workstation_browser', arguments: {} }] },
      }),
      JSON.stringify({
        type: 'message', timestamp: '2026-08-05T10:00:02.000Z',
        message: {
          role: 'toolResult', toolCallId: 'c1',
          content: [{ type: 'text', text: '截图完成' }, { type: 'image', data: PNG, mimeType: 'image/png' }],
        },
      }),
    ].join('\n')

    const { messages } = parseTranscript(jsonl)
    const call = messages.find((m) => m.role === 'assistant').toolCalls[0]
    assert.equal(call.images.length, 1)
    assert.equal(call.images[0].data, PNG)
  })
})

describe('图片送到模型', () => {
  test('平台没声明 image 时，input 默认只有 text', () => {
    assert.deepEqual(buildModel({ model: 'GLM-5.1', server: 'http://x' }).input, ['text'])
  })

  test('平台声明了就按平台的来', () => {
    assert.deepEqual(buildModel({ model: 'M', server: 'http://x', input: ['text', 'image'] }).input, ['text', 'image'])
  })

  test('LLM_IMAGE_MODELS 能兜底补上 —— 平台元数据缺失时不必等它改', () => {
    const model = buildModel({ model: 'GLM-5.1', server: 'http://x' }, { imageCapableModels: ['GLM-5.1'] })
    assert.deepEqual(model.input, ['text', 'image'])
  })

  test('兜底只作用于点名的模型，且不重复添加', () => {
    assert.deepEqual(buildModel({ model: 'other', server: 'http://x' }, { imageCapableModels: ['GLM-5.1'] }).input, ['text'])
    assert.deepEqual(
      buildModel({ model: 'GLM-5.1', server: 'http://x', input: ['text', 'image'] }, { imageCapableModels: ['GLM-5.1'] }).input,
      ['text', 'image'],
    )
  })
})

/**
 * 真的把请求发出去，看**线上真正收到的请求体**里有没有图片。
 *
 * 这是唯一能证明根因的测法：faux provider 绕过 provider 层的转换，
 * 而丢图正好发生在那一层（`if (hasImages && model.input.includes("image"))`）。
 */
describe('丢图发生在哪一层（对照实验）', () => {
  const bodies = []
  let turn = 0
  let server
  let base

  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        bodies.push(raw)
        turn += 1
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (turn === 1) {
          res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name: 'shot', arguments: '{}' } }] } }] }))
          res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
        } else {
          res.write(sse({ choices: [{ index: 0, delta: { content: '看完了' } }] }))
          res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}/v1`
  })

  after(() => new Promise((resolve) => server.close(resolve)))

  async function sendWith(input) {
    bodies.length = 0
    turn = 0
    const model = buildModel({ model: 'test-model', server: base, key: 'k', input })
    try {
      await runTurn({
        runId: `r-${input.join('-')}`, username: 'x', sessionKey: 'main', prompt: '截图',
        model, store: createMemoryStore(), apiKey: 'k', sandbox: { mode: 'none' }, logger: silent, timeoutMs: 20000,
        apTools: [{
          name: 'shot', description: '返回一张图',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({
            content: [{ type: 'text', text: 'Screenshot captured' }, { type: 'image', data: PNG, mimeType: 'image/png' }],
          }),
        }],
      })
    } catch {
      // 这里只关心发出去的请求体长什么样，run 本身成不成功无所谓
    }
    return bodies[1] || ''
  }

  test('input 不含 image → 请求体里没有图（这就是"我看不见"的来源）', async () => {
    const body = await sendWith(['text'])
    assert.ok(body, '没抓到第二轮请求')
    assert.ok(!body.includes('image_url'), '按 pi 的实现这里不该有图')
    assert.ok(!body.includes(PNG.slice(0, 30)))
  })

  test('input 含 image → 请求体里有图', async () => {
    const body = await sendWith(['text', 'image'])
    assert.ok(body.includes('image_url'), '加了 image 之后图还是没发出去')
    assert.ok(body.includes(PNG.slice(0, 30)))
  })
})
