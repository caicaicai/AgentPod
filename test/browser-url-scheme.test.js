/**
 * 没写协议的地址按 `http://` 打开，不是 `https://`。
 *
 * ── 为什么这条要有代码兜底 ──────────────────────────────────────────
 *
 * 模型的先验是 https（训练语料里绝大多数 URL 都是），而本环境实际服务的内网系统
 * **多数只开 80**。规则原本只写在 `builtin-skills/cloud-browser/SKILL.md` 里，
 * 但技能是按需加载的 —— 模型不一定读到那一段，于是"打开某某系统"照样先撞一个
 * `ERR_CONNECTION_REFUSED`，然后开始猜是不是要登录、域名是不是写错了。
 *
 * 提示词提高命中率，只有代码能保证。这一组用例守的就是那个"保证"。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeUrl, registerWorkstationBrowserTool } from '../src/tools/workstation-browser.js'

/** 建一个只有 browser 的工具环境，把 open/navigate 的实际请求记下来 */
function makeTool({ responses = [] } = {}) {
  const calls = []
  let tool = null
  const api = {
    ctx: {
      browser: {
        async action(action, payload = {}) {
          calls.push({ action, url: payload.url })
          return responses.shift() || { ok: true, url: payload.url, title: 'T' }
        },
      },
    },
    registerTool(definition) { tool = definition },
  }
  registerWorkstationBrowserTool(api)
  return { tool, calls }
}

const run = (tool, params) => tool.execute('call-1', params)

describe('补协议', () => {
  test('裸域名补 http://', () => {
    assert.deepEqual(normalizeUrl('example.xiaocaicai.com'), { url: 'http://example.xiaocaicai.com', assumed: true })
  })

  test('带路径与查询串一样补', () => {
    assert.equal(normalizeUrl('a.xiaocaicai.com/report?month=2026-05').url, 'http://a.xiaocaicai.com/report?month=2026-05')
  })

  test('`localhost:3000` 不能被当成已有协议', () => {
    // 这是这段代码唯一容易写错的地方：拿 new URL() 去判会把 `localhost:` 当成
    // 协议名，判成"已有协议"原样送进 goto，报一个没人看得懂的 Invalid URL。
    assert.deepEqual(normalizeUrl('localhost:3000'), { url: 'http://localhost:3000', assumed: true })
  })

  test('`10.0.0.5:8080` 同理 —— 内网地址十有八九长这样', () => {
    assert.equal(normalizeUrl('10.0.0.5:8080/admin').url, 'http://10.0.0.5:8080/admin')
  })

  test('协议相对地址只补协议名，不再补一遍 //', () => {
    assert.equal(normalizeUrl('//a.xiaocaicai.com/x').url, 'http://a.xiaocaicai.com/x')
  })

  test('显式写了协议就一个字都不改', () => {
    assert.deepEqual(normalizeUrl('https://a.xiaocaicai.com'), { url: 'https://a.xiaocaicai.com', assumed: false })
    assert.deepEqual(normalizeUrl('http://a.xiaocaicai.com'), { url: 'http://a.xiaocaicai.com', assumed: false })
  })

  test('about:/data: 这类不带 // 的协议不受影响', () => {
    assert.equal(normalizeUrl('about:blank').url, 'about:blank')
    assert.equal(normalizeUrl('data:text/html,<p>x</p>').url, 'data:text/html,<p>x</p>')
  })

  test('前后空格不影响判断', () => {
    assert.equal(normalizeUrl('  a.xiaocaicai.com  ').url, 'http://a.xiaocaicai.com')
  })
})

describe('open / navigate 走的是补过的地址', () => {
  test('open 裸域名 → 实际请求是 http://', async () => {
    const { tool, calls } = makeTool()
    await run(tool, { action: 'open', url: 'a.xiaocaicai.com' })
    assert.deepEqual(calls, [{ action: 'open', url: 'http://a.xiaocaicai.com' }])
  })

  test('navigate 同样归一', async () => {
    const { tool, calls } = makeTool()
    await run(tool, { action: 'navigate', url: 'a.xiaocaicai.com/next' })
    assert.equal(calls[0].url, 'http://a.xiaocaicai.com/next')
  })

  test('显式 https 不会被改成 http', async () => {
    // 用户/模型显式写了协议是一个明确的意图，替它改掉等于把它的判断悄悄推翻。
    const { tool, calls } = makeTool()
    await run(tool, { action: 'open', url: 'https://a.xiaocaicai.com' })
    assert.equal(calls[0].url, 'https://a.xiaocaicai.com')
  })
})

describe('补错了自己换一次', () => {
  test('http 连不上 → 自动换 https，并把这件事讲出来', async () => {
    // 丢一个 ERR_CONNECTION_REFUSED 回去，模型通常会去猜"是不是要先登录"
    // "域名是不是写错了" —— 方向全错，而唯一能证伪的事实（80 没开）它看不见。
    const { tool, calls } = makeTool({
      responses: [
        { ok: false, error: 'page.goto: net::ERR_CONNECTION_REFUSED at http://a.xiaocaicai.com' },
        { ok: true, url: 'https://a.xiaocaicai.com/', title: '报表' },
      ],
    })
    const out = await run(tool, { action: 'open', url: 'a.xiaocaicai.com' })
    assert.deepEqual(calls.map((c) => c.url), ['http://a.xiaocaicai.com', 'https://a.xiaocaicai.com'])
    assert.equal(out.details.status, 'ok')
    assert.equal(out.details.url, 'https://a.xiaocaicai.com/')
    assert.match(out.details.note, /https/)
  })

  test('显式写了 http:// 就不替它换 —— 那是明确意图', async () => {
    const { tool, calls } = makeTool({
      responses: [{ ok: false, error: 'net::ERR_CONNECTION_REFUSED' }],
    })
    const out = await run(tool, { action: 'open', url: 'http://a.xiaocaicai.com' })
    assert.equal(calls.length, 1)
    assert.equal(out.details.status, 'error')
    assert.equal(out.details.hint, undefined, '协议不是我们补的，不该给"已补成…"的提示')
  })

  test('DNS 解析不了不重试 —— 换协议也没用，白等一次超时', async () => {
    const { tool, calls } = makeTool({
      responses: [{ ok: false, error: 'net::ERR_NAME_NOT_RESOLVED' }],
    })
    const out = await run(tool, { action: 'open', url: 'nope.xiaocaicai.com' })
    assert.equal(calls.length, 1)
    assert.equal(out.details.status, 'error')
  })

  test('页面加载超时不重试：80 端口其实是通的', async () => {
    const { tool, calls } = makeTool({
      responses: [{ ok: false, error: 'page.goto: Timeout 30000ms exceeded' }],
    })
    await run(tool, { action: 'open', url: 'slow.xiaocaicai.com' })
    assert.equal(calls.length, 1)
  })

  test('两个协议都连不上 → 回原始错误，并说明补过什么', async () => {
    const { tool } = makeTool({
      responses: [
        { ok: false, error: 'net::ERR_CONNECTION_REFUSED' },
        { ok: false, error: 'net::ERR_CONNECTION_REFUSED' },
      ],
    })
    const out = await run(tool, { action: 'open', url: 'gone.xiaocaicai.com' })
    assert.equal(out.details.status, 'error')
    assert.match(out.details.hint, /http:\/\/gone\.jd\.com/)
  })
})

describe('规则要出现在模型永远看得见的地方', () => {
  test('工具 description 里写着默认 http', () => {
    // SKILL.md 是**按需加载**的，模型不一定读到；description 永远在上下文里。
    // 只写在技能里是这个问题最初没被解决的原因。
    const { tool } = makeTool()
    assert.match(tool.description, /http:\/\//)
    assert.match(tool.description, /HTTP/)
  })

  test('url 参数自己也带着这条规则', () => {
    const { tool } = makeTool()
    assert.match(tool.parameters.properties.url.description, /http:\/\//)
  })
})
