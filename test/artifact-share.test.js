/**
 * 作品分享：`/s/<token>` 免登录直达一份作品，以及公开的作品市场。
 *
 * 这一套测的重点全在**边界**上，因为它是整个服务里唯一一条不要求身份的数据通道：
 *   1. 免鉴权能读到的，只能是作者**显式**分享出来的那一份
 *   2. 撤销 / 删作品 / 删会话之后，链接当场失效（而不是等谁去跑清理）
 *   3. 上市场是第二个动作 —— 生成链接不等于挂到广场上
 *   4. 别人的作品分享不了，token 也拼不出越界路径
 *   5. 那条"从不以 HTML 身份吐出模型生成内容"的不变量，在公开这条路上同样成立
 */
import { test, describe, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createServer } from '../src/http/server.js'
import { createMemorySessionStore } from './helpers/memory-session-store.js'
import { createArtifactStore } from '../src/artifacts/store.js'
import { createShareStore, assertShareToken, newShareToken } from '../src/artifacts/shares.js'
import { createMemoryStorage } from './helpers/memory-storage.js'

/** 存储后端的测试替身。生产只有 MySQL，见 test/helpers/memory-storage.js */
const testStorage = createMemoryStorage()

/**
 * 替身是这个文件共用的一个实例，每条用例前清干净。
 * 不清的话，上一条留下的记录会让"列出全部"这类断言得到一个跟自己无关的数字，
 * 而报错看起来像是被测代码有问题。
 */
beforeEach(() => testStorage.reset())

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

function buildConfig(dataDir, artifactOverrides = {}) {
  return {
    dataDir,
    auth: { mode: 'dev' },
    llm: { mode: 'faux' },
    sandbox: { mode: 'none' },
    bridge: { enabled: false, browserCookieDomains: [] },
    limits: { bodyLimitBytes: 256 * 1024, maxConcurrentRuns: 8, maxRunsPerUser: 2 },
    cron: { enabled: false, scheduler: false, tickMs: 30000, credentialMode: 'none' },
    memory: { enabled: false, capture: false },
    projects: { enabled: false },
    artifacts: {
      enabled: true, maxBytes: 256 * 1024, maxVersions: 20, allowedOrigins: [], ...artifactOverrides,
    },
    devConsole: false,
    webUi: false,
  }
}

async function startServer(dataDir, config = buildConfig(dataDir)) {
  const store = createMemorySessionStore()
  const artifacts = createArtifactStore({ storage: testStorage, config, logger: silentLogger })
  const shares = createShareStore({ storage: testStorage, config, logger: silentLogger, artifacts })

  const app = createServer({
    config,
    logger: silentLogger,
    identity: { resolve: async (req) => ({ username: req.headers['x-username'] || 'u1', credential: '' }) },
    broker: { getLlmAccess: async () => ({ models: [], user: null }), invalidate() {} },
    runService: {
      snapshot: () => ({ activeRuns: 0, budget: 8, perUserLimit: 2, users: [] }),
      listSkills: () => [], abort: () => ({ ok: true }), execute: async () => ({ runId: 'r', durationMs: 1, finalText: '' }),
    },
    store,
    artifacts,
    shares,
    scheduler: { enabled: false, runNow: async () => ({ ok: true }) },
    llmInfoClient: null,
    metrics: { snapshot: () => ({}) },
  })
  await app.listen(0)
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, artifacts, shares }
}

/**
 * 两个客户端，刻意分开。
 *
 * `api` 带 X-Username（登录态），`anon` **一个身份头都不带** —— 后者是这套功能的
 * 全部意义所在，所以它必须是一个连"忘了带头"都做不到的独立封装：
 * 共用一个 client 再靠调用方记得传空，迟早有一条用例悄悄带着身份跑绿了。
 */
function client(base) {
  const call = async (method, url, body, username = 'u1') => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { X: '1', ...(username ? { 'X-Username': username } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    return { status: response.status, body: parsed, text, headers: response.headers }
  }
  return {
    get: (url, username) => call('GET', url, null, username),
    post: (url, body, username) => call('POST', url, body, username),
    patch: (url, body, username) => call('PATCH', url, body, username),
    del: (url, username) => call('DELETE', url, null, username),
    /** 完全匿名：没有 X-Username，也没有 Authorization */
    anon: (url) => call('GET', url, null, ''),
  }
}

let dataDir
let server
let api

/**
 * 访问计数是**故意不 await** 的（见 shares.js 的 countView）：它是"顺便"的东西，
 * 不该挡在访客和作品之间。代价落在这里 —— 用例跑完之后那次写盘可能还在路上，
 * 而 Windows 上"正在被写的目录删不掉"是硬错误（ENOTEMPTY / EPERM）。
 * 重试几次就过去了；改成 await 反而是让测试的方便去改坏线上的行为。
 */
const cleanup = (dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })

const FILES = [
  { path: 'index.html', content: '<h1>季度看板</h1>\n<script src="app.js"></script>' },
  { path: 'app.js', content: 'console.log("hi")' },
]

/** 建一份作品并开好分享链接，返回 { id, token } */
async function shared(over = {}) {
  const meta = await server.artifacts.create({
    username: 'u1', sessionKey: 's_1', kind: 'web', title: '季度看板', files: FILES, ...over,
  })
  const { body } = await api.post(`/v1/artifacts/${meta.id}/share`)
  return { id: meta.id, token: body.artifact.share.token }
}

beforeEach(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
  if (dataDir) await cleanup(dataDir)
  dataDir = await mkdtemp(path.join(tmpdir(), 'ap-share-'))
  server = await startServer(dataDir)
  api = client(server.base)
})
after(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
  if (dataDir) await cleanup(dataDir)
})

describe('token', () => {
  test('96 bit 随机，形状固定 —— 它就是访问凭据，能猜到就等于能看到', () => {
    const token = newShareToken()
    assert.match(token, /^s_[0-9a-f]{24}$/)
    assert.notEqual(newShareToken(), token)
    assert.equal(assertShareToken(token), token)
  })

  test('拼不出越界路径，也不接受别的形状', () => {
    assert.throws(() => assertShareToken('../../etc/passwd'), /不合法/)
    assert.throws(() => assertShareToken('s_短'), /不合法/)
    assert.throws(() => assertShareToken(''), /不合法/)
    assert.throws(() => assertShareToken('a_112233445566778899aabbcc'), /不合法/, '前缀也是形状的一部分')
  })
})

describe('生成与撤销', () => {
  test('默认不分享 —— 作者不点，作品就没有任何对外的入口', async () => {
    const meta = await server.artifacts.create({
      username: 'u1', sessionKey: 's_1', kind: 'web', title: 't', files: FILES,
    })
    assert.equal(meta.share, null)
    const { body } = await api.get('/v1/artifacts')
    assert.equal(body.artifacts[0].share, null)
  })

  test('分享之后，不带任何身份就能读到正文', async () => {
    const { token } = await shared()
    const { status, body } = await api.anon(`/v1/public/shares/${token}`)

    assert.equal(status, 200)
    assert.equal(body.meta.title, '季度看板')
    assert.equal(body.share.author, 'u1')
    assert.deepEqual(body.files.map((file) => file.path).sort(), ['app.js', 'index.html'])
    assert.match(body.files.find((file) => file.path === 'index.html').content, /季度看板/)
    // 前端拿它拼预览 iframe 的 CSP，公开这条路同样要下发
    assert.deepEqual(body.preview, { allowedOrigins: [] })
  })

  test('给访客的那份元信息里没有 sessionKey / projectId / 版本全表', async () => {
    const { id, token } = await shared()
    await server.artifacts.write({ username: 'u1', id, files: [{ path: 'app.js', content: 'console.log(2)' }] })

    const { body } = await api.anon(`/v1/public/shares/${token}`)
    assert.equal(body.meta.sessionKey, undefined, '作者自己的组织方式，访客用不上也不该知道')
    assert.equal(body.meta.projectId, undefined)
    assert.deepEqual(body.meta.versions, [], '分享跟随最新版，没有"切到第 1 版"这回事')
    assert.equal(body.meta.version, 2)
  })

  test('分享跟随最新版：作者出新版本，访客刷新就是新的', async () => {
    const { id, token } = await shared()
    await server.artifacts.replace({
      username: 'u1', id, path: 'index.html', oldStr: '季度看板', newStr: '年度看板',
    })
    const { body } = await api.anon(`/v1/public/shares/${token}`)
    assert.match(body.files.find((file) => file.path === 'index.html').content, /年度看板/)
    assert.equal(body.version, 2)
  })

  test('幂等：再点一次"分享"回的是同一条链接，不会把已发出去的那条作废', async () => {
    const { id, token } = await shared()
    const again = await api.post(`/v1/artifacts/${id}/share`)
    assert.equal(again.body.artifact.share.token, token)
  })

  test('撤销之后链接当场 404', async () => {
    const { id, token } = await shared()
    assert.equal((await api.del(`/v1/artifacts/${id}/share`)).status, 200)

    assert.equal((await api.anon(`/v1/public/shares/${token}`)).status, 404)
    // 作者自己那份记录上也干净了，不留一个 `{}` 让界面以为还开着
    assert.equal((await api.get(`/v1/artifacts/${id}`)).body.meta.share, null)
  })

  test('作品删了，链接跟着失效', async () => {
    const { id, token } = await shared()
    await api.del(`/v1/artifacts/${id}`)
    assert.equal((await api.anon(`/v1/public/shares/${token}`)).status, 404)
  })

  test('会话删了，它名下作品的链接一起失效', async () => {
    const { token } = await shared()
    await api.del('/v1/sessions/s_1')
    assert.equal((await api.anon(`/v1/public/shares/${token}`)).status, 404)
  })

  /**
   * 指针表只是索引，权威在作品记录上（见 shares.js 文件头）。
   * 所以就算指针文件因为任何原因残留下来，它也读不出任何东西 —— 而不是
   * "只要没人去跑清理，撤销过的链接就还活着"。
   */
  test('指针残留也读不出东西：权威是作品记录上的 share 字段', async () => {
    const { id, token } = await shared()
    // 只清权威、不动指针，模拟"撤销撤到一半进程挂了"
    await server.artifacts.setShare({ username: 'u1', id, share: null })
    assert.equal((await api.anon(`/v1/public/shares/${token}`)).status, 404)
    // 读一次之后指针自愈，作者重新分享拿到的是一个新 token
    const again = await api.post(`/v1/artifacts/${id}/share`)
    assert.notEqual(again.body.artifact.share.token, token)
  })

  test('编的 token、怪形状的 token 一律 404，不区分"没有"和"撤销了"', async () => {
    assert.equal((await api.anon('/v1/public/shares/s_000000000000000000000000')).status, 404)
    assert.equal((await api.anon('/v1/public/shares/nope')).status, 404)
    assert.equal((await api.anon('/v1/public/shares/..%2F..%2Fetc%2Fpasswd')).status, 404)
    assert.equal((await api.anon('/v1/public/shares/')).status, 404)
    assert.equal((await api.anon('/v1/public/nothing')).status, 404)
  })
})

describe('隔离', () => {
  test('分享不了别人的作品，也读不到别人分享的私有作品', async () => {
    const meta = await server.artifacts.create({
      username: 'u1', sessionKey: 's_1', kind: 'web', title: 't', files: FILES,
    })
    // u2 报上 u1 的作品 id
    assert.equal((await api.post(`/v1/artifacts/${meta.id}/share`, null, 'u2')).status, 404)
    assert.equal((await api.del(`/v1/artifacts/${meta.id}/share`, 'u2')).status, 404)
    // 分享是 u1 的动作，u2 那次调用没有留下任何痕迹
    assert.equal((await api.get(`/v1/artifacts/${meta.id}`)).body.meta.share, null)
  })

  test('公开接口只认 token —— 没有任何"报上 id 就能读"的入口', async () => {
    const meta = await server.artifacts.create({
      username: 'u1', sessionKey: 's_1', kind: 'web', title: 't', files: FILES,
    })
    // 作品 id 本身不是分享凭据
    assert.equal((await api.anon(`/v1/public/shares/${meta.id}`)).status, 404)
    // 公开命名空间下没有任何按 id / username 定位的入口，编也编不出来
    assert.equal((await api.anon(`/v1/public/artifacts/${meta.id}`)).status, 404)
    assert.equal((await api.anon('/v1/public/users/u1/artifacts')).status, 404)

    // 分享过的作品也一样：token 能开的只有 token 那一份，换成作品 id 就不认
    const { id, token } = await shared()
    assert.equal((await api.anon(`/v1/public/shares/${id}`)).status, 404)
    assert.equal((await api.anon(`/v1/public/shares/${token}`)).status, 200)
  })

  test('撤销别人的分享撤不掉', async () => {
    const { id, token } = await shared()
    assert.equal((await api.del(`/v1/artifacts/${id}/share`, 'u2')).status, 404)
    assert.equal((await api.anon(`/v1/public/shares/${token}`)).status, 200, '还好好地开着')
  })
})

describe('市场', () => {
  test('生成链接 ≠ 上广场：不点第二下，市场里就没有它', async () => {
    await shared()
    assert.deepEqual((await api.anon('/v1/public/market')).body.items, [])
  })

  test('显式发布之后才出现在市场，带上作者和那句简介', async () => {
    const { id, token } = await shared()
    const { status, body } = await api.patch(`/v1/artifacts/${id}/share`, { market: true, summary: '一张按季度拆的销售看板' })
    assert.equal(status, 200)
    assert.equal(body.artifact.share.market, true)
    assert.ok(body.artifact.share.marketAt > 0)

    const { items } = (await api.anon('/v1/public/market')).body
    assert.equal(items.length, 1)
    assert.equal(items[0].token, token)
    assert.equal(items[0].author, 'u1')
    assert.equal(items[0].title, '季度看板')
    assert.equal(items[0].summary, '一张按季度拆的销售看板')
    assert.equal(items[0].fileCount, 2)
    // 广场一次列几十条，带上正文就是几 MB
    assert.equal(items[0].files, undefined)
  })

  test('下架之后市场里没有了，但分享链接还在 —— 两个开关互相独立', async () => {
    const { id, token } = await shared()
    await api.patch(`/v1/artifacts/${id}/share`, { market: true })
    await api.patch(`/v1/artifacts/${id}/share`, { market: false })

    assert.deepEqual((await api.anon('/v1/public/market')).body.items, [])
    assert.equal((await api.anon(`/v1/public/shares/${token}`)).status, 200)
  })

  test('撤销分享的同时也从市场上下来', async () => {
    const { id } = await shared()
    await api.patch(`/v1/artifacts/${id}/share`, { market: true })
    await api.del(`/v1/artifacts/${id}/share`)
    assert.deepEqual((await api.anon('/v1/public/market')).body.items, [])
  })

  test('没生成链接就发布不了 —— 市场条目点开就是分享页', async () => {
    const meta = await server.artifacts.create({
      username: 'u1', sessionKey: 's_1', kind: 'web', title: 't', files: FILES,
    })
    const { status, body } = await api.patch(`/v1/artifacts/${meta.id}/share`, { market: true })
    assert.equal(status, 400)
    assert.match(body.message, /请先生成分享链接/)
  })

  test('市场标题跟着作品走，不是发布那一刻的副本', async () => {
    const { id } = await shared()
    await api.patch(`/v1/artifacts/${id}/share`, { market: true })
    await server.artifacts.write({ username: 'u1', id, title: '年度看板', files: [{ path: 'app.js', content: 'x' }] })

    assert.equal((await api.anon('/v1/public/market')).body.items[0].title, '年度看板')
  })

  test('按关键词和类型筛', async () => {
    const a = await shared()
    const b = await shared({ kind: 'markdown', title: '交接文档', files: [{ path: 'README.md', content: '# x' }] })
    await api.patch(`/v1/artifacts/${a.id}/share`, { market: true })
    await api.patch(`/v1/artifacts/${b.id}/share`, { market: true })

    assert.equal((await api.anon('/v1/public/market')).body.items.length, 2)
    assert.equal((await api.anon('/v1/public/market?kind=markdown')).body.items.length, 1)
    assert.equal((await api.anon('/v1/public/market?q=交接')).body.items[0].title, '交接文档')
    assert.equal((await api.anon('/v1/public/market?q=不存在的词')).body.items.length, 0)
  })

  test('简介超长截断，多余空白归一', async () => {
    const { id } = await shared()
    const { body } = await api.patch(`/v1/artifacts/${id}/share`, { market: true, summary: `a  b\n\nc${'x'.repeat(300)}` })
    assert.equal(body.artifact.share.summary.length, 140)
    assert.match(body.artifact.share.summary, /^a b c/)
  })
})

/**
 * 那条贯穿全局的规矩在公开这条路上同样成立：
 * **本服务从不以 HTML 的身份吐出任何模型生成的内容。**
 * 破了它，`/v1/public/shares/<token>/raw` 就成了一个同源的、内容由模型决定的页面。
 */
describe('原文下发', () => {
  test('无论什么后缀都是 text/plain + nosniff', async () => {
    const { token } = await shared()
    const { status, headers, text } = await api.anon(`/v1/public/shares/${token}/raw`)

    assert.equal(status, 200)
    assert.equal(headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(headers.get('x-content-type-options'), 'nosniff')
    assert.match(text, /<h1>季度看板<\/h1>/)
  })

  test('?path= 取别的文件，不存在的 404', async () => {
    const { token } = await shared()
    assert.match((await api.anon(`/v1/public/shares/${token}/raw?path=app.js`)).text, /console\.log/)
    assert.equal((await api.anon(`/v1/public/shares/${token}/raw?path=nope.js`)).status, 404)
  })

  test('中文标题不会把下载头搞成一条 500（RFC 6266 两份都给）', async () => {
    const { token } = await shared({ kind: 'markdown', files: [{ path: '方案.md', content: '# 方案' }] })
    const { status, headers } = await api.anon(`/v1/public/shares/${token}/raw?download=1`)
    assert.equal(status, 200)
    assert.match(headers.get('content-disposition'), /^attachment; filename="_+\.md"; filename\*=UTF-8''/)
  })
})

describe('能力闸门', () => {
  test('ARTIFACT_SHARING_ENABLED=0：公开接口整块 404，作者也开不了新链接', async () => {
    const off = await startServer(dataDir, buildConfig(dataDir, { sharing: false }))
    const offApi = client(off.base)
    const meta = await off.artifacts.create({
      username: 'u1', sessionKey: 's_1', kind: 'web', title: 't', files: FILES,
    })

    assert.equal((await offApi.anon('/v1/public/market')).status, 404)
    assert.equal((await offApi.anon('/v1/public/shares/s_000000000000000000000000')).status, 404)
    assert.equal((await offApi.post(`/v1/artifacts/${meta.id}/share`)).status, 404)
    await off.app.close({ timeoutMs: 500 })
  })

  test('ARTIFACT_MARKET_ENABLED=0：分享链接照常，只是没有广场', async () => {
    const off = await startServer(dataDir, buildConfig(dataDir, { market: false }))
    const offApi = client(off.base)
    const meta = await off.artifacts.create({
      username: 'u1', sessionKey: 's_1', kind: 'web', title: 't', files: FILES,
    })
    const token = (await offApi.post(`/v1/artifacts/${meta.id}/share`)).body.artifact.share.token

    assert.equal((await offApi.anon(`/v1/public/shares/${token}`)).status, 200)
    assert.equal((await offApi.anon('/v1/public/market')).status, 404)
    assert.equal((await offApi.patch(`/v1/artifacts/${meta.id}/share`, { market: true })).status, 400)
    await off.app.close({ timeoutMs: 500 })
  })

  test('作品功能本身关掉时，分享不会变成一个"开着但永远 404"的开关', async () => {
    const config = buildConfig(dataDir, { enabled: false })
    const artifacts = createArtifactStore({ storage: testStorage, config, logger: silentLogger })
    assert.equal(createShareStore({ storage: testStorage, config, logger: silentLogger, artifacts }).enabled, false)
  })
})
