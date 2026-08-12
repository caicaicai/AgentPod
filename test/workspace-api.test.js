/**
 * 项目 / 记忆 / 定时任务的 HTTP 接口。
 *
 * 这一层测的不是存储逻辑（那些在各自的单测里），而是**只有经过 HTTP 才会犯的错**：
 *   1. 请求体里塞 `username` 能不能改到别人的东西（反面教材见 http/server.js 的注释）
 *   2. 能力关掉时是 404 还是崩掉
 *   3. 乐观锁撞车回的是不是 409（而不是 400 或者静默覆盖）
 *   4. 悬空引用：把会话挂到一个不存在的项目上
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createServer } from '../src/http/server.js'
import { createFileStore } from '../src/sessions/file-store.js'
import { createMemoryStore } from '../src/memory/store.js'
import { createProjectStore } from '../src/projects/store.js'
import { createCronStore } from '../src/cron/store.js'
import { createCronCredentialVault } from '../src/cron/credentials.js'
import { createArtifactStore } from '../src/artifacts/store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

function buildConfig(dataDir, overrides = {}) {
  return {
    dataDir,
    auth: { mode: 'dev' },
    llm: { mode: 'faux' },
    sandbox: { mode: 'none' },
    bridge: { enabled: false, browserCookieDomains: [] },
    limits: { bodyLimitBytes: 256 * 1024, maxConcurrentRuns: 8, maxRunsPerUser: 2 },
    cron: { enabled: true, scheduler: true, tickMs: 30000, credentialMode: 'none' },
    memory: { enabled: true, capture: false },
    projects: { enabled: true },
    artifacts: { enabled: true, maxBytes: 256 * 1024, maxVersions: 20, allowedOrigins: [] },
    devConsole: false,
    webUi: false,
    ...overrides,
  }
}

async function startServer(dataDir, { config = buildConfig(dataDir), stores = {} } = {}) {
  const store = stores.store ?? createFileStore({ config, logger: silentLogger })
  const memory = stores.memory ?? createMemoryStore({ config, logger: silentLogger })
  const projects = stores.projects ?? createProjectStore({ config, logger: silentLogger })
  const crons = stores.crons ?? createCronStore({ config, logger: silentLogger })
  const cronVault = stores.cronVault ?? createCronCredentialVault({ config, logger: silentLogger })
  const artifacts = stores.artifacts ?? createArtifactStore({ config, logger: silentLogger })

  const app = createServer({
    config,
    logger: silentLogger,
    identity: { resolve: async (req) => ({ username: req.headers['x-username'] || 'u1', credential: 'sso=fake' }) },
    broker: { getLlmAccess: async () => ({ models: [], user: null }), invalidate() {} },
    runService: {
      snapshot: () => ({ activeRuns: 0, budget: 8, perUserLimit: 2, users: [] }),
      listSkills: () => [], abort: () => ({ ok: true }), execute: async () => ({ runId: 'r', durationMs: 1, finalText: '' }),
    },
    store, memory, projects, crons, cronVault, artifacts,
    scheduler: { enabled: true, runNow: async () => ({ ok: true }) },
    llmInfoClient: null,
    metrics: { snapshot: () => ({}) },
  })
  await app.listen(0)
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, store, memory, projects, crons, artifacts }
}

/** 三个动词的薄封装，省得每处都拼一遍 headers */
function client(base) {
  const call = async (method, url, body, username = 'u1') => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'X-Username': username, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  return {
    get: (url, username) => call('GET', url, null, username),
    post: (url, body, username) => call('POST', url, body, username),
    patch: (url, body, username) => call('PATCH', url, body, username),
    put: (url, body, username) => call('PUT', url, body, username),
    del: (url, username) => call('DELETE', url, null, username),
  }
}

let dataDir
let server
let api

beforeEach(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  dataDir = await mkdtemp(path.join(tmpdir(), 'ap-api-'))
  server = await startServer(dataDir)
  api = client(server.base)
})
after(async () => {
  if (server) await server.app.close({ timeoutMs: 500 })
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

describe('能力宣告', () => {
  test('healthz 告诉界面哪些块该画', async () => {
    const { body } = await api.get('/healthz')
    assert.deepEqual(body.features, {
      sessionStore: 'file',
      memory: true,
      projects: true,
      cron: true,
      cronScheduler: true,
      cronCredentialMode: 'none',
      artifacts: true,
    })
  })

  test('关掉的能力回 404，而不是崩在一个 undefined 上', async () => {
    const off = await startServer(dataDir, {
      config: buildConfig(dataDir, {
        memory: { enabled: false }, projects: { enabled: false }, cron: { enabled: false, credentialMode: 'none' },
        artifacts: { enabled: false, allowedOrigins: [] },
      }),
    })
    const offApi = client(off.base)
    assert.equal((await offApi.get('/v1/projects')).status, 404)
    assert.equal((await offApi.get('/v1/memory')).status, 404)
    assert.equal((await offApi.get('/v1/crons')).status, 404)
    assert.equal((await offApi.get('/v1/artifacts')).status, 404)
    await off.app.close({ timeoutMs: 500 })
  })
})

describe('作品接口', () => {
  const seed = (over = {}) => server.artifacts.create({
    username: 'u1',
    sessionKey: 's_1',
    kind: 'web',
    title: '看板',
    files: [{ path: 'index.html', content: '<h1>hi</h1>' }, { path: 'app.js', content: 'let a = 1' }],
    ...over,
  })

  test('清单按会话过滤，并把预览约束一起回给前端', async () => {
    await seed()
    await seed({ sessionKey: 's_2', title: '别的会话' })

    const all = await api.get('/v1/artifacts')
    assert.equal(all.body.artifacts.length, 2)
    // 前端要拿它拼预览 iframe 的 CSP。硬编在前端的话，改了服务端配置而前端没跟上，
    // 表现是"配了 CDN 却还是加载不到"，两边谁也看不出来
    assert.deepEqual(all.body.preview, { allowedOrigins: [] })

    const one = await api.get('/v1/artifacts?sessionKey=s_1')
    assert.equal(one.body.artifacts.length, 1)
    assert.equal(one.body.artifacts[0].title, '看板')
  })

  test('详情带全部文件；指定版本读旧版', async () => {
    const meta = await seed()
    await server.artifacts.write({
      username: 'u1', id: meta.id, files: [{ path: 'index.html', content: '<h1>v2</h1>' }],
    })

    const latest = await api.get(`/v1/artifacts/${meta.id}`)
    assert.equal(latest.body.version, 2)
    assert.deepEqual(latest.body.files.map((file) => file.path).sort(), ['app.js', 'index.html'])
    assert.equal(latest.body.files.find((file) => file.path === 'index.html').content, '<h1>v2</h1>')
    assert.equal(latest.body.meta.entry, 'index.html')

    const old = await api.get(`/v1/artifacts/${meta.id}?v=1`)
    assert.equal(old.body.files.find((file) => file.path === 'index.html').content, '<h1>hi</h1>')
  })

  /**
   * 这条是整个功能的安全支点。
   *
   * 正文是**模型生成的 HTML**：只要它能以 `text/html` 从本服务的源上吐出来，
   * 这个 URL 就是一个同源页面，能读走 localStorage 里的登录令牌 —— 而触发它
   * 只需要一封诱导邮件。预览走的是另一条路（正文进 JSON，前端塞进不带
   * allow-same-origin 的 sandbox iframe），所以这里永远不需要 text/html。
   */
  test('raw 一律 text/plain + nosniff —— 绝不以 HTML 的身份吐出模型生成的内容', async () => {
    const meta = await seed({ files: [{ path: 'index.html', content: '<script>alert(1)</script>' }] })
    const response = await fetch(`${server.base}/v1/artifacts/${meta.id}/raw`, { headers: { 'X-Username': 'u1' } })

    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(await response.text(), '<script>alert(1)</script>')
  })

  test('raw 按 path 取单个文件，不传取入口', async () => {
    const meta = await seed()
    const one = await fetch(`${server.base}/v1/artifacts/${meta.id}/raw?path=app.js`, { headers: { 'X-Username': 'u1' } })
    assert.equal(await one.text(), 'let a = 1')

    const missing = await fetch(`${server.base}/v1/artifacts/${meta.id}/raw?path=nope.js`, { headers: { 'X-Username': 'u1' } })
    assert.equal(missing.status, 404)
  })

  test('中文文件名走 RFC 6266 两段式 —— 直接塞进头会让 Node 抛错', async () => {
    const meta = await seed({ kind: 'markdown', files: [{ path: '方案.md', content: '# x' }] })
    const download = await fetch(`${server.base}/v1/artifacts/${meta.id}/raw?download=1`, { headers: { 'X-Username': 'u1' } })
    const disposition = download.headers.get('content-disposition')
    assert.match(disposition, /^attachment; filename="__\.md"/)
    assert.match(disposition, /filename\*=UTF-8''%E6%96%B9%E6%A1%88\.md$/)
  })

  test('别人的作品：查不到、删不掉', async () => {
    const meta = await seed()
    assert.equal((await api.get('/v1/artifacts', 'u2')).body.artifacts.length, 0)
    assert.equal((await api.get(`/v1/artifacts/${meta.id}`, 'u2')).status, 404)
    assert.equal((await api.del(`/v1/artifacts/${meta.id}`, 'u2')).status, 404)
    assert.equal((await api.get(`/v1/artifacts/${meta.id}`, 'u1')).status, 200)
  })

  /**
   * "作品不存在"和"这一版太老、正文已经被清理了"是两件事。都糊成 404 的话，
   * 用户看到的是"作品不存在"——而他明明在列表里看得见它。
   */
  test('版本不对回 400 并说清原因，与"没这个作品"分开', async () => {
    const meta = await seed()
    const bad = await api.get(`/v1/artifacts/${meta.id}?v=9`)
    assert.equal(bad.status, 400)
    assert.match(bad.body.message, /没有第 9 版/)
    assert.equal((await api.get('/v1/artifacts/a_nope')).status, 404)
  })

  test('删会话时它名下的作品跟着走，别的会话不受影响', async () => {
    const gone = await seed()
    const keep = await seed({ sessionKey: 's_2' })
    // 会话得先真的存在，否则删的是一条不存在的记录
    await server.store.save({ username: 'u1', sessionKey: 's_1', sessionId: 'x', jsonl: '', entryCount: 0, title: 't' })

    assert.equal((await api.del('/v1/sessions/s_1')).status, 200)
    assert.equal((await api.get(`/v1/artifacts/${gone.id}`)).status, 404)
    assert.equal((await api.get(`/v1/artifacts/${keep.id}`)).status, 200)
  })
})

describe('项目接口', () => {
  test('建、查、改、删', async () => {
    const created = await api.post('/v1/projects', { name: '结算中台', instructions: '附带风险点' })
    assert.equal(created.status, 201)
    const id = created.body.project.id

    assert.equal((await api.get('/v1/projects')).body.projects.length, 1)
    assert.equal((await api.get(`/v1/projects/${id}`)).body.project.instructions, '附带风险点')

    const patched = await api.patch(`/v1/projects/${id}`, { name: '结算中台 v2' })
    assert.equal(patched.body.project.name, '结算中台 v2')

    assert.equal((await api.del(`/v1/projects/${id}`)).status, 200)
    assert.equal((await api.get(`/v1/projects/${id}`)).status, 404)
  })

  test('空名字回 400 而不是 500', async () => {
    assert.equal((await api.post('/v1/projects', { name: '  ' })).status, 400)
  })

  /**
   * 反面教材写在 http/server.js 里：`{ username: subject.username, ...body }` ——
   * 请求体里的 username 会把登录态解析出来的那个覆盖掉。
   */
  test('请求体里塞 username 改不到别人的项目', async () => {
    const mine = await api.post('/v1/projects', { name: '我的项目' }, 'u1')
    const id = mine.body.project.id

    const attempt = await api.patch(`/v1/projects/${id}`, { username: 'u1', name: '被 u2 改了' }, 'u2')
    assert.equal(attempt.status, 404, 'u2 不该能改到 u1 的项目')
    assert.equal((await api.get(`/v1/projects/${id}`, 'u1')).body.project.name, '我的项目')
  })

  test('别人的项目列表看不到', async () => {
    await api.post('/v1/projects', { name: 'u1 的' }, 'u1')
    assert.equal((await api.get('/v1/projects', 'u2')).body.projects.length, 0)
  })

  /**
   * 删项目会把它下面的会话退回"未分组"，而不是跟着删。
   * 连着几十轮对话一起删是不可逆的，也没有任何提示能让人预料到。
   */
  test('删项目不删对话，会话退回未分组', async () => {
    const { body } = await api.post('/v1/projects', { name: '结算中台' })
    const id = body.project.id
    await server.store.save({ username: 'u1', sessionKey: 'k1', sessionId: 's1', jsonl: '{}\n', entryCount: 1, title: '一次对话' })
    await api.patch('/v1/sessions/k1', { projectId: id })

    const removed = await api.del(`/v1/projects/${id}`)
    assert.equal(removed.body.releasedSessions, 1)

    const session = (await api.get('/v1/sessions')).body.sessions.find((item) => item.sessionKey === 'k1')
    assert.ok(session, '会话必须还在')
    assert.equal(session.projectId, '', '归属应退回未分组')
  })
})

describe('会话归属与置顶归档', () => {
  beforeEach(async () => {
    await server.store.save({ username: 'u1', sessionKey: 'k1', sessionId: 's1', jsonl: '{}\n', entryCount: 1, title: '对话一' })
  })

  test('挂到不存在的项目上要拦下 —— 否则会话会从两个视图里同时消失', async () => {
    const response = await api.patch('/v1/sessions/k1', { projectId: 'p_nonexistent' })
    assert.equal(response.status, 404)
    assert.match(response.body.message, /项目不存在/)
  })

  test('置顶 / 归档 / 改归属走同一个 PATCH', async () => {
    assert.equal((await api.patch('/v1/sessions/k1', { pinned: true })).body.session.pinned, true)
    assert.equal((await api.patch('/v1/sessions/k1', { archived: true })).body.session.archived, true)
    // 归档之后默认列表里就没有它了
    assert.equal((await api.get('/v1/sessions')).body.sessions.length, 0)
    assert.equal((await api.get('/v1/sessions?includeArchived=1')).body.sessions.length, 1)
  })

  test('没有可更新的字段时回 400，而不是假装改了', async () => {
    assert.equal((await api.patch('/v1/sessions/k1', { 乱写: 1 })).status, 400)
  })

  test('搜索按 username 隔离', async () => {
    await server.store.save({
      username: 'u2', sessionKey: 'k9', sessionId: 's9', entryCount: 1, title: 'u2 的秘密',
      jsonl: `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '秘密内容' }] } })}\n`,
    })
    assert.equal((await api.get('/v1/search?q=' + encodeURIComponent('秘密'), 'u1')).body.sessions.length, 0)
    assert.equal((await api.get('/v1/search?q=' + encodeURIComponent('秘密'), 'u2')).body.sessions.length, 1)
  })
})

describe('记忆接口', () => {
  test('读写与项目作用域', async () => {
    assert.equal((await api.get('/v1/memory')).body.count, 0)

    const saved = await api.put('/v1/memory', { content: '# Memory\n\n- 负责结算中台\n' })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.count, 1)
    assert.equal(saved.body.scope, 'personal', '返回形状要和 GET 一致，前端才能直接拿去刷新状态')

    const { body: project } = await api.post('/v1/projects', { name: 'p' })
    await api.put(`/v1/memory?projectId=${project.project.id}`, { content: '- 项目专属\n' })
    assert.equal((await api.get(`/v1/memory?projectId=${project.project.id}`)).body.scope, 'project')
    assert.doesNotMatch((await api.get('/v1/memory')).body.content, /项目专属/)
  })

  /**
   * 乐观锁必须回 409 而不是 400：调用方的处理方式完全不同 ——
   * 这个要"重新加载再改"，不是"参数写错了"。
   */
  test('revision 撞车回 409，且内容不被覆盖', async () => {
    await api.put('/v1/memory', { content: '- 原始内容\n' })
    const stale = await api.put('/v1/memory', { content: '- 覆盖\n', revision: 'stale' })
    assert.equal(stale.status, 409)
    assert.match((await api.get('/v1/memory')).body.content, /原始内容/)

    const { revision } = (await api.get('/v1/memory')).body
    assert.equal((await api.put('/v1/memory', { content: '- 新内容\n', revision })).status, 200)
  })

  test('content 必须是字符串', async () => {
    assert.equal((await api.put('/v1/memory', { content: 123 })).status, 400)
  })

  test('别人的记忆读不到、也写不脏', async () => {
    await api.put('/v1/memory', { content: '- u1 的记忆\n' }, 'u1')
    assert.equal((await api.get('/v1/memory', 'u2')).body.count, 0)
    await api.put('/v1/memory', { content: '- u2 的记忆\n' }, 'u2')
    assert.match((await api.get('/v1/memory', 'u1')).body.content, /u1 的记忆/)
  })
})

describe('定时任务接口', () => {
  const daily = { cron: '30 9 * * 1-5', timezone: 'Asia/Shanghai' }

  test('建、查、改、删、立即执行', async () => {
    const created = await api.post('/v1/crons', { title: '每日汇总', task: '汇总告警', schedule: daily })
    assert.equal(created.status, 201)
    const id = created.body.cron.id
    assert.ok(created.body.cron.nextFireAt > Date.now())

    const list = await api.get('/v1/crons')
    assert.equal(list.body.crons.length, 1)
    assert.equal(list.body.scheduler.running, true)
    assert.equal(list.body.scheduler.credentialMode, 'none')

    assert.equal((await api.patch(`/v1/crons/${id}`, { enabled: false })).body.cron.enabled, false)
    assert.equal((await api.post(`/v1/crons/${id}/run`)).body.ok, true)
    assert.equal((await api.del(`/v1/crons/${id}`)).status, 200)
    assert.equal((await api.get('/v1/crons')).body.crons.length, 0)
  })

  test('排期写错回 400，且报错说清是哪个字段', async () => {
    const bad = await api.post('/v1/crons', { task: 'x', schedule: { cron: '99 9 * * *' } })
    assert.equal(bad.status, 400)
    assert.match(bad.body.message, /「分钟」/)

    const daily24 = await api.post('/v1/crons', { task: 'x', schedule: { everyMs: 86400000 } })
    assert.equal(daily24.status, 400)
    assert.match(daily24.body.message, /请改用 cron/)
  })

  test('指令为空回 400', async () => {
    assert.equal((await api.post('/v1/crons', { task: '   ', schedule: daily })).status, 400)
  })

  test('别人的任务看不到也改不了', async () => {
    const mine = await api.post('/v1/crons', { task: 'u1 的任务', schedule: daily }, 'u1')
    const id = mine.body.cron.id
    assert.equal((await api.get('/v1/crons', 'u2')).body.crons.length, 0)
    assert.equal((await api.get(`/v1/crons/${id}`, 'u2')).status, 404)
    assert.equal((await api.patch(`/v1/crons/${id}`, { username: 'u1', title: '被改了' }, 'u2')).status, 404)
  })

  test('CRON_CREDENTIAL_MODE=stored 时写操作会留存登录态，删光之后清掉', async () => {
    const withVault = await startServer(dataDir, {
      config: buildConfig(dataDir, { cron: { enabled: true, scheduler: true, tickMs: 30000, credentialMode: 'stored' } }),
    })
    const vaultApi = client(withVault.base)
    const created = await vaultApi.post('/v1/crons', { task: 'x', schedule: daily })

    const vault = createCronCredentialVault({
      config: buildConfig(dataDir, { cron: { credentialMode: 'stored' } }), logger: silentLogger,
    })
    assert.equal(await vault.resolve({ username: 'u1' }), 'sso=fake', '建任务时应把当时的登录态留下来')

    await vaultApi.del(`/v1/crons/${created.body.cron.id}`)
    assert.equal(await vault.resolve({ username: 'u1' }), '', '最后一条任务删掉后，留存的凭据就没用途了')
    await withVault.app.close({ timeoutMs: 500 })
  })
})
