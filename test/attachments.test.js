/**
 * 用户附件：校验与"最终喂给模型的是什么"。
 *
 * 这里守的是三件在别处很难发现的事：
 *   1. **图片和正文是分开的两半**。pi 的入口是 `prompt(text, { images })`，
 *      图片绝不能拼进第一个参数 —— 那个位置的类型是 string，数组进去会被
 *      当字符串用掉，模型收到的是一段 `[object Object]`，而且不报错。
 *   2. **模型不支持视觉时，图片不静默消失**。要在正文里说出来，否则模型会
 *      照着文字硬答，而用户以为它看过了那张图。
 *   3. **校验不信任前端**。kind / mimeType / data 全是客户端填的。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { buildPromptContent, describeAttachments, normalizeAttachments } from '../src/agent/attachments.js'
import { buildModel } from '../src/models/model-factory.js'
import { runTurn } from '../src/agent/run-turn.js'
import { createMemorySessionStore as createMemoryStore } from './helpers/memory-session-store.js'
import { parseInlinedAttachments } from '../web/src/lib/attachments.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUg=='
/** 一张真的 1x1 PNG。上面那些纯校验用例不在乎内容，这里要真发给"模型" */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

describe('normalizeAttachments', () => {
  test('没有附件时回空数组，不报错', () => {
    assert.deepEqual(normalizeAttachments(undefined), [])
    assert.deepEqual(normalizeAttachments(null), [])
    assert.deepEqual(normalizeAttachments([]), [])
  })

  test('不是数组就是坏请求', () => {
    assert.throws(() => normalizeAttachments({ name: 'a' }), /attachments 必须是数组/)
  })

  test('图片 mime 走白名单 —— data: URL 的类型决定浏览器/网关怎么解析这段字节', () => {
    assert.throws(
      () => normalizeAttachments([{ kind: 'image', name: 'x.svg', mimeType: 'image/svg+xml', data: PNG }]),
      /不支持/,
    )
  })

  test('base64 里混进别的字符就拒收', () => {
    assert.throws(
      () => normalizeAttachments([{ kind: 'image', name: 'x.png', mimeType: 'image/png', data: 'not base64!!' }]),
      /不是合法 base64/,
    )
  })

  test('kind 只认 image 和 document', () => {
    assert.throws(() => normalizeAttachments([{ kind: 'video', name: 'x.mp4' }]), /只能是 image 或 document/)
  })

  test('个数超上限直接拒', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'document', name: `${i}.txt`, text: 'x' }))
    assert.throws(() => normalizeAttachments(many), /最多带 8 个附件/)
  })

  test('图片总量超上限时报的是"图片太大"，不是"请求体超限"', () => {
    // 单张都在限内，加起来越界 —— 这正是只有单张限制时会漏掉的那种情况
    const big = 'A'.repeat(4_000_000)
    assert.throws(
      () => normalizeAttachments([
        { kind: 'image', name: 'a.png', mimeType: 'image/png', data: big },
        { kind: 'image', name: 'b.png', mimeType: 'image/png', data: big },
        { kind: 'image', name: 'c.png', mimeType: 'image/png', data: big },
      ]),
      /图片加起来超过/,
    )
  })

  test('超长文本截断而不是整条打回，并写明截了', () => {
    const [doc] = normalizeAttachments([{ kind: 'document', name: 'big.log', text: 'x'.repeat(50_000) }])
    assert.equal(doc.text.length, 40_000)
    assert.match(doc.note, /只带了前 40000 个字符/)
  })

  test('文件名里的换行和反引号会被抹掉 —— 它要原样拼进 prompt', () => {
    const [doc] = normalizeAttachments([{ kind: 'document', name: 'a\n```b', text: 'x' }])
    assert.equal(doc.name, 'a b')
  })

  test('空文本附件直接跳过，不占一段 prompt 也不报错', () => {
    assert.deepEqual(normalizeAttachments([{ kind: 'document', name: 'empty.txt', text: '' }]), [])
  })
})

describe('buildPromptContent', () => {
  test('没有附件时正文原样、images 为空 —— 主干流量不改路径', () => {
    assert.deepEqual(buildPromptContent('你好', []), { text: '你好', images: [] })
  })

  test('只有文本附件时不产生 images，内容拼进正文', () => {
    const attachments = normalizeAttachments([{ kind: 'document', name: 'a.log', text: 'ERROR: boom' }])
    const { text, images } = buildPromptContent('这什么问题', attachments)
    assert.deepEqual(images, [])
    assert.match(text, /这什么问题/)
    assert.match(text, /【附件 a\.log】/)
    assert.match(text, /ERROR: boom/)
  })

  test('附件正文里的 ``` 不会把围栏顶破', () => {
    const attachments = normalizeAttachments([{ kind: 'document', name: 'r.md', text: '```js\n1\n```' }])
    const { text } = buildPromptContent('看看', attachments)
    // 用四个反引号包，里面那三个才不会提前收口
    assert.match(text, /````\n```js/)
  })

  test('模型支持视觉时，图片走 images 而不是拼进正文', () => {
    const attachments = normalizeAttachments([
      { kind: 'image', name: 's.png', mimeType: 'image/png', data: PNG },
    ])
    const { text, images } = buildPromptContent('这是什么', attachments, { imageCapable: true })
    // 正文一个字都没多 —— base64 绝不能进 prompt 文本
    assert.equal(text, '这是什么')
    // 形状必须与 pi-ai 的 ImageContent 完全一致，多一个字段都可能被上游拒
    assert.deepEqual(images, [{ type: 'image', data: PNG, mimeType: 'image/png' }])
  })

  test('模型不支持视觉时不发图，但要在正文里说出来', () => {
    const attachments = normalizeAttachments([
      { kind: 'image', name: 's.png', mimeType: 'image/png', data: PNG },
    ])
    const { text, images } = buildPromptContent('这是什么', attachments, { imageCapable: false })
    assert.deepEqual(images, [], '一张图都不该往上游发')
    assert.match(text, /s\.png/)
    assert.match(text, /不支持读图/)
  })

  test('图文混排：文本进正文，图片进 images', () => {
    const attachments = normalizeAttachments([
      { kind: 'document', name: 'a.log', text: 'boom' },
      { kind: 'image', name: 's.png', mimeType: 'image/png', data: PNG },
    ])
    const { text, images } = buildPromptContent('看看', attachments, { imageCapable: true })
    assert.match(text, /boom/)
    assert.equal(images.length, 1)
    assert.equal(images[0].type, 'image')
  })
})

describe('describeAttachments', () => {
  test('只回形状，不回内容 —— 它是给日志用的', () => {
    const shape = describeAttachments(normalizeAttachments([
      { kind: 'image', name: 's.png', mimeType: 'image/png', data: PNG },
      { kind: 'document', name: 'a.log', text: 'boom' },
    ]))
    assert.deepEqual(shape, { count: 2, images: 1, documents: 1, bytes: PNG.length + 4 })
  })

  test('没附件时回 null，调用方据此决定要不要打这条日志', () => {
    assert.equal(describeAttachments([]), null)
  })
})

/**
 * 端到端：用户附件真的到了模型请求体里吗。
 *
 * 上面那些用例证明的是 `buildPromptContent` 算得对，但算得对不等于**发得出去** ——
 * `session.prompt()` 的第二个参数写错、pi 在 provider 层把图丢掉，这两种情况下
 * 上面的用例全绿，而线上模型什么都收不到。所以这里起一个假的 OpenAI 兼容端点，
 * 直接看它收到的请求体。测法与 tool-images.test.js 的对照实验同源。
 */
describe('附件真的进了模型请求体', () => {
  const bodies = []
  let server
  let base

  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        bodies.push(raw)
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(sse({ choices: [{ index: 0, delta: { content: '收到' } }] }))
        res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}/v1`
  })

  after(() => new Promise((resolve) => server.close(resolve)))

  async function send({ input, attachments, prompt = '看看这个' }) {
    bodies.length = 0
    const model = buildModel({ model: 'test-model', server: base, key: 'k', input })
    try {
      await runTurn({
        runId: `att-${input.join('-')}-${Date.now()}`,
        username: 'x',
        sessionKey: `s-${Math.random().toString(36).slice(2)}`,
        prompt,
        attachments: normalizeAttachments(attachments),
        model,
        store: createMemoryStore(),
        apiKey: 'k',
        sandbox: { mode: 'none' },
        logger: silent,
        timeoutMs: 20000,
      })
    } catch {
      // 只关心发出去的请求体长什么样
    }
    return bodies[0] || ''
  }

  test('文本附件的内容出现在请求体里', async () => {
    const body = await send({
      input: ['text'],
      attachments: [{ kind: 'document', name: 'boom.log', text: 'ERROR: connection reset' }],
    })
    assert.ok(body, '没抓到请求')
    assert.ok(body.includes('ERROR: connection reset'), '文本附件的内容没进请求体')
    assert.ok(body.includes('boom.log'), '文件名没进请求体 —— 模型会不知道这段是哪来的')
  })

  test('模型支持视觉时，图片真的发出去了', async () => {
    const body = await send({
      input: ['text', 'image'],
      attachments: [{ kind: 'image', name: 's.png', mimeType: 'image/png', data: PNG_1X1 }],
    })
    // 这一条才是 `prompt(text, { images })` 那个签名的守卫：写成
    // `prompt([{type:'text'},{type:'image'}])` 的话第一个参数会被当字符串，
    // 请求体里连 image_url 都不会有，而代码不报任何错。
    assert.ok(body.includes('image_url'), '图片没发出去 —— 检查 session.prompt 的第二个参数')
    assert.ok(body.includes(PNG_1X1.slice(0, 30)))
  })

  test('模型不支持视觉时不发图，改成在正文里说明', async () => {
    const body = await send({
      input: ['text'],
      attachments: [{ kind: 'image', name: 's.png', mimeType: 'image/png', data: PNG_1X1 }],
    })
    assert.ok(!body.includes('image_url'), '不支持视觉的模型不该收到图')
    assert.ok(body.includes('不支持读图'), '图被丢了却没告诉模型，它会照着文字硬答')
  })

  test('只有附件、一个字没写也能发 —— "看看这份日志"是常见的一轮', async () => {
    const body = await send({
      input: ['text'],
      prompt: '',
      attachments: [{ kind: 'document', name: 'only.log', text: 'just the file' }],
    })
    assert.ok(body.includes('just the file'))
  })
})

/**
 * 服务端拼进 prompt 的格式，前端要能原样折回 chip。
 *
 * 这是一条**跨进程的格式契约**：拼串在 src/agent/attachments.js，反解在
 * web/src/lib/attachments.js。谁单方面改了围栏字符或那句提示语，另一边就会
 * 静默失效 —— 表现不是报错，而是"刷新之后附件变成了一堵几千字的墙"，
 * 而那正是这个项目一直在避免的"刚发完好好的、一刷新就变样"。
 */
describe('拼进 prompt 的附件能被前端折回来', () => {
  test('文本附件：正文回到原样，内容进 chip', () => {
    const attachments = normalizeAttachments([
      { kind: 'document', name: 'app.log', text: 'level=error msg="boom"' },
      { kind: 'document', name: 'note.md', text: '# 标题\n```js\n1\n```' },
    ])
    const { text } = buildPromptContent('这几个附件你收到了吗', attachments)
    const parsed = parseInlinedAttachments(text)

    assert.equal(parsed.text, '这几个附件你收到了吗', '正文里不该再残留附件段落')
    assert.deepEqual(parsed.files.map((f) => f.name), ['app.log', 'note.md'])
    assert.equal(parsed.files[0].text, 'level=error msg="boom"')
    // 附件正文里本来就有三反引号，折回来时不能在那里断掉
    assert.equal(parsed.files[1].text, '# 标题\n```js\n1\n```')
  })

  test('没发出去的图片也折成 chip，并且标着"未发送"', () => {
    const attachments = normalizeAttachments([
      { kind: 'image', name: 'a.png', mimeType: 'image/png', data: PNG },
      { kind: 'image', name: 'b.png', mimeType: 'image/png', data: PNG },
    ])
    const { text } = buildPromptContent('看图', attachments, { imageCapable: false })
    const parsed = parseInlinedAttachments(text)

    assert.equal(parsed.text, '看图')
    assert.deepEqual(parsed.files.map((f) => f.name), ['a.png', 'b.png'])
    // 不标出来的话，用户会以为模型看过了那两张图
    assert.ok(parsed.files.every((f) => f.note.includes('未发送')))
  })

  test('没有附件的普通消息原样返回，不做任何加工', () => {
    const parsed = parseInlinedAttachments('就是一句普通的话')
    assert.equal(parsed.text, '就是一句普通的话')
    assert.deepEqual(parsed.files, [])
  })

  test('正文里出现「【附件」字样但不是我们拼的，不该被吃掉', () => {
    const parsed = parseInlinedAttachments('邮件的【附件 说明】那一栏要怎么填')
    assert.equal(parsed.text, '邮件的【附件 说明】那一栏要怎么填')
    assert.deepEqual(parsed.files, [])
  })
})
