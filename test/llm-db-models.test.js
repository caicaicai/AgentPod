/**
 * 管理员在控制台里配的那份模型清单（LLM_MODE=db）与用户分组。
 *
 * 这里要钉住的是**这套东西之所以敢用一把共享 key 的那几条前提**：
 *
 *   1. key 从来不下发浏览器（接口只回掩码），加密入库时换个密钥也不会
 *      让整个部署的对话一起失败；
 *   2. 一个人能看见哪些模型**只由他的分组决定** —— 这是"给一部分人开贵模型"
 *      这件事唯一的实现，前端少判一次只是界面难看，服务端少判一次是越权；
 *   3. 删分组要把引用摘干净，否则库里会留下一批指向不存在分组的账号和模型，
 *      而那种不一致只在"这个人怎么突然少了两个模型"时才现形。
 */
import { test, describe, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { createServer } from '../src/http/server.js'
import { createIdentityResolver } from '../src/identity/index.js'
import { createUserStore } from '../src/identity/user-store.js'
import { createGroupStore } from '../src/identity/group-store.js'
import { createModelStore } from '../src/models/model-store.js'
import { createDbBroker } from '../src/credentials/broker.js'
import { createSecretBox, maskKey } from '../src/credentials/secret-box.js'
import { createMemoryStorage } from './helpers/memory-storage.js'
import { createMemorySessionStore } from './helpers/memory-session-store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

function buildConfig(over = {}) {
  return {
    auth: {
      mode: 'password',
      password: {
        users: 'admin:changeme',
        sessionSecret: 'test-secret-for-llm-db',
        sessionTtlHours: 24,
        allowRegister: false,
      },
    },
    llm: { mode: 'db', configSecret: '', ...over.llm },
    sandbox: { mode: 'none' },
    limits: { bodyLimitBytes: 256 * 1024, maxConcurrentRuns: 8, maxRunsPerUser: 2 },
    cron: { enabled: false, scheduler: false, credentialMode: 'none' },
    memory: { enabled: false },
    projects: { enabled: false },
    artifacts: { enabled: false, allowedOrigins: [] },
    devConsole: false,
    webUi: false,
    ...over,
  }
}

/** 一条能直接存进去的模型配置。用例里只改它关心的那几个字段 */
const sampleModel = (over = {}) => ({
  name: '生产 Claude',
  model: 'claude-sonnet-5',
  baseUrl: 'https://api.example.com/v1',
  key: 'sk-live-abcdefghijklmnop',
  ...over,
})

/* ═════════════════ 存储层 ═════════════════ */

describe('模型配置存储', () => {
  let storage
  let models

  beforeEach(() => {
    storage = createMemoryStorage()
    models = createModelStore({ config: buildConfig(), storage, logger: silentLogger })
  })

  test('存进去、列出来，key 只回掩码', async () => {
    const created = await models.create(sampleModel())
    assert.equal(created.model, 'claude-sonnet-5')
    assert.equal(created.hasKey, true)
    // 掩码里绝不能出现中间那一段
    assert.ok(!created.keyMask.includes('efghijkl'))
    assert.equal(created.keyMask, maskKey('sk-live-abcdefghijklmnop'))

    const list = await models.list()
    assert.equal(list.length, 1)
    // 整个对外形状里**没有 key 这个字段**，不是"有但被清空了"
    assert.equal('key' in list[0], false)
  })

  /**
   * 从上游文档里复制过来的地址十有八九带着 /chat/completions，
   * 而 OpenAI SDK 会自己拼后半段 —— 不兜这一下，真实请求会打到
   * `/v1/chat/completions/chat/completions`，回来一个 404。
   */
  test('接口地址会把结尾的 /chat/completions 和多余斜杠去掉', async () => {
    const created = await models.create(sampleModel({ baseUrl: 'https://api.example.com/v1/chat/completions/' }))
    assert.equal(created.baseUrl, 'https://api.example.com/v1')
  })

  test('不是 http/https 的地址直接拒绝', async () => {
    await assert.rejects(
      () => models.create(sampleModel({ baseUrl: 'ftp://api.example.com' })),
      /http/,
    )
  })

  /**
   * 模型 id 是这套东西对外的身份：用户选模型传的是它，用量台账按它记账。
   * 允许重名的话，选了 `gpt-4o` 拿到的是"先出现的那条"，而两条的用量在台账里
   * 会合成一行再也分不开。
   */
  test('模型 ID 在整个部署里唯一', async () => {
    await models.create(sampleModel())
    await assert.rejects(() => models.create(sampleModel({ name: '另一个' })), /已经被另一条配置占用/)
  })

  test('改一条时留空 key = 不动它，传 null 才是清空', async () => {
    const created = await models.create(sampleModel())

    // 只改上下文长度，key 不该受影响 —— 否则每次无关的小改动都会把 key 抹掉
    const touched = await models.update(created.id, { contextWindow: 200000 })
    assert.equal(touched.contextWindow, 200000)
    assert.equal(touched.hasKey, true)
    assert.equal(touched.keyMask, created.keyMask)

    const cleared = await models.update(created.id, { key: null })
    assert.equal(cleared.hasKey, false)
  })

  test('停用的模型不出现在解析结果里，但仍然列得出来（管理台要看得见）', async () => {
    const created = await models.create(sampleModel({ enabled: false }))
    assert.equal((await models.list()).length, 1)
    assert.equal((await models.resolveForGroup('')).length, 0)

    await models.update(created.id, { enabled: true })
    assert.equal((await models.resolveForGroup('')).length, 1)
  })

  /**
   * 解析结果的形状必须与 llminfo 回的那种记录逐字段对齐 ——
   * buildModel / pickModel / run-service 认的就是这个形状，
   * 差一个字段名的表现是"模型跑起来了但上下文窗口不对"。
   */
  test('解析结果带明文 key，形状与 llminfo 的记录一致', async () => {
    await models.create(sampleModel({ contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'] }))
    const [llm] = await models.resolveForGroup('')
    assert.equal(llm.model, 'claude-sonnet-5')
    assert.equal(llm.server, 'https://api.example.com/v1')
    assert.equal(llm.key, 'sk-live-abcdefghijklmnop')
    assert.equal(llm.contextWindow, 200000)
    assert.equal(llm.maxTokens, 8192)
    assert.deepEqual(llm.input, ['text', 'image'])
  })

  /**
   * 排序不是装饰：**清单里的第一个就是用户没指定模型时用的那个**
   * （见 model-factory.js:pickModel）。所以"哪个是默认模型"必须由管理员决定，
   * 而不是取决于记录 id 的字典序。
   */
  test('按 sort 排序 —— 第一个就是默认模型', async () => {
    await models.create(sampleModel({ name: '备用', model: 'backup', sort: 10 }))
    await models.create(sampleModel({ name: '主力', model: 'primary', sort: 1 }))
    const resolved = await models.resolveForGroup('')
    assert.deepEqual(resolved.map((item) => item.model), ['primary', 'backup'])
  })
})

/* ═════════════════ 可用范围 ═════════════════ */

describe('模型按分组开放', () => {
  let storage
  let models
  let groups

  beforeEach(async () => {
    storage = createMemoryStorage()
    models = createModelStore({ config: buildConfig(), storage, logger: silentLogger })
    groups = createGroupStore({ storage, logger: silentLogger })
  })

  /**
   * 空 groups = 所有分组可用，而不是"谁也用不了"。
   *
   * 这个默认值是有取舍的：忘了限制范围的后果是多几个人看得到，那在管理台上
   * 一眼就能看见并改掉；而反过来，管理员配完第一个模型会发现所有人都没模型可用，
   * 界面上完全看不出原因。让不显眼的错变成显眼的错，是选它的唯一理由。
   */
  test('不限范围的模型对所有人可见，包括没有分组的人', async () => {
    await models.create(sampleModel())
    assert.equal((await models.resolveForGroup('')).length, 1)
    assert.equal((await models.resolveForGroup('grp_whatever')).length, 1)
  })

  test('限了范围的模型只对组里的人可见', async () => {
    const vip = await groups.create({ name: '内部' })
    const other = await groups.create({ name: '试用' })
    await models.create(sampleModel({ model: 'expensive', groups: [vip.id] }))

    assert.deepEqual((await models.resolveForGroup(vip.id)).map((m) => m.model), ['expensive'])
    assert.deepEqual((await models.resolveForGroup(other.id)).map((m) => m.model), [])
    // 没有分组的人**尤其**不能看到限了范围的模型 —— 否则限制等于没做
    assert.deepEqual((await models.resolveForGroup('')).map((m) => m.model), [])
  })

  test('删分组时要把它从模型的可用范围里摘掉，不留悬空 id', async () => {
    const vip = await groups.create({ name: '内部' })
    const created = await models.create(sampleModel({ groups: [vip.id] }))

    await models.dropGroup(vip.id)
    const after = await models.get(created.id)
    assert.deepEqual(after.groups, [])
    /**
     * 摘完之后它变成"不限范围" —— 也就是所有人都能用。
     * 这是 dropGroup 的**真实后果**，写在用例里是为了让改这段代码的人
     * 先看见它：如果哪天认为该改成"跟着分组一起停用"，这条会先红。
     */
    assert.equal((await models.resolveForGroup('')).length, 1)
  })

  test('最多一个默认分组：设了新的，旧的自动取消', async () => {
    const first = await groups.create({ name: '甲', isDefault: true })
    const second = await groups.create({ name: '乙', isDefault: true })
    assert.equal(await groups.defaultGroupId(), second.id)
    assert.equal((await groups.get(first.id)).isDefault, false)
  })
})

/* ═════════════════ key 的加壳 ═════════════════ */

describe('模型 Key 的加密存储', () => {
  test('加密后能原样读回来，而库里存的不是明文', async () => {
    const storage = createMemoryStorage()
    const config = buildConfig({ llm: { mode: 'db', configSecret: 'a-strong-passphrase' } })
    const models = createModelStore({ config, storage, logger: silentLogger })

    await models.create(sampleModel())
    const [llm] = await models.resolveForGroup('')
    assert.equal(llm.key, 'sk-live-abcdefghijklmnop')

    // 直接翻库：这一行里不该出现明文 key
    const [raw] = await storage.globalMap('llm_models').all()
    assert.ok(!String(raw.key).includes('sk-live-abcdefghijklmnop'))
    assert.ok(String(raw.key).startsWith('gcm1:'))
  })

  /**
   * 换掉 LLM_CONFIG_SECRET 之后，解不开的那几条要被**跳过**，
   * 而不是让整个清单失败 —— 一部分记录用旧密钥写的部署里，
   * 让那几条拖垮所有人的对话是不成比例的。
   */
  test('密钥换掉之后：解不开的那条被跳过，其余照常可用', async () => {
    const storage = createMemoryStorage()
    const withOld = createModelStore({
      config: buildConfig({ llm: { mode: 'db', configSecret: 'old-passphrase' } }),
      storage,
      logger: silentLogger,
    })
    await withOld.create(sampleModel())

    const withNew = createModelStore({
      config: buildConfig({ llm: { mode: 'db', configSecret: 'new-passphrase' } }),
      storage,
      logger: silentLogger,
    })
    // 这条模型是配着的，但这个进程读不出它的 key
    assert.equal((await withNew.resolveForGroup('')).length, 0)
    // 管理台上仍然列得出来，并且标着"解不开" —— 否则管理员看到的是一个
    // 配置齐全却一直调不通的模型
    const [listed] = await withNew.list()
    assert.equal(listed.keyBroken, true)
    assert.equal(listed.hasKey, true)
  })

  test('没配密钥时明文入库，但读回来一致（老部署升上来不用做任何事）', async () => {
    const box = createSecretBox({ passphrase: '' })
    assert.equal(box.enabled, false)
    assert.equal(box.open(box.seal('sk-plain')), 'sk-plain')
    // 加壳之前写进去的裸串（没有任何前缀）也要读得出来
    assert.equal(box.open('sk-legacy-no-prefix'), 'sk-legacy-no-prefix')
  })

  test('密文被改过一个字节就解不开，而不是解出一段乱码发给上游', () => {
    const box = createSecretBox({ passphrase: 'p' })
    const sealed = box.seal('sk-live-1234')
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('A') ? 'B' : 'A'}=`
    assert.throws(() => box.open(tampered), /解密失败/)
  })
})

/* ═════════════════ broker ═════════════════ */

describe('LLM_MODE=db 的 broker', () => {
  test('按这个人的分组给模型', async () => {
    const storage = createMemoryStorage()
    const config = buildConfig()
    const groups = createGroupStore({ storage, logger: silentLogger })
    const models = createModelStore({ config, storage, logger: silentLogger })
    const users = createUserStore({ config, storage, groups, logger: silentLogger })

    const vip = await groups.create({ name: '内部' })
    await models.create(sampleModel({ model: 'shared' }))
    await models.create(sampleModel({ name: '贵的', model: 'expensive', groups: [vip.id] }))

    await users.create({ username: 'zhangsan', password: 'password123', groupId: vip.id })
    await users.create({ username: 'lisi', password: 'password123', groupId: '' })

    const broker = createDbBroker({ modelStore: models, users, logger: silentLogger })

    const vipAccess = await broker.getLlmAccess({ username: 'zhangsan' })
    /**
     * 比的是**看得见哪些**，所以排序过再比。
     *
     * 这两条是同一个 sort（都没设），先后取决于 createdAt —— 而它是毫秒，
     * 两条在同一毫秒里建出来是常态。在这条用例里断言顺序，钉住的就不是
     * "分组决定可见性"这件事，而是一个与它无关的巧合。顺序有它自己的用例。
     */
    assert.deepEqual(vipAccess.models.map((m) => m.model).sort(), ['expensive', 'shared'])
    // 第一条的 key 兜底给 run-service 用（每条记录自己也带 key）
    assert.equal(vipAccess.apiKey, 'sk-live-abcdefghijklmnop')

    const plainAccess = await broker.getLlmAccess({ username: 'lisi' })
    assert.deepEqual(plainAccess.models.map((m) => m.model), ['shared'])
  })

  /**
   * 账号库里没有这个人也不能抛错：AUTH_MODE 不是 password 的部署里
   * （平台 SSO 透传），username 是外部给的，账号库里根本没有这条记录。
   * 那种部署照样应该能用不限范围的模型。
   */
  test('账号库里没有的主体按"无分组"处理，而不是失败', async () => {
    const storage = createMemoryStorage()
    const models = createModelStore({ config: buildConfig(), storage, logger: silentLogger })
    await models.create(sampleModel())

    const broker = createDbBroker({ modelStore: models, users: null, logger: silentLogger })
    const access = await broker.getLlmAccess({ username: 'from-sso' })
    assert.equal(access.models.length, 1)
  })

  test('新建的账号自动进默认分组', async () => {
    const storage = createMemoryStorage()
    const config = buildConfig()
    const groups = createGroupStore({ storage, logger: silentLogger })
    const users = createUserStore({ config, storage, groups, logger: silentLogger })

    const standard = await groups.create({ name: '标准', isDefault: true })
    const created = await users.create({ username: 'wangwu', password: 'password123' })
    assert.equal(created.groupId, standard.id)

    // 显式传空串 = 明确不进任何分组，与"没传"要分得开
    const loner = await users.create({ username: 'zhaoliu', password: 'password123', groupId: '' })
    assert.equal(loner.groupId, '')
  })
})

/* ═════════════════ HTTP ═════════════════ */

function client(base) {
  return async (method, path, { token = '', body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    return { status: response.status, body: parsed, text }
  }
}

describe('管理接口：模型与分组', () => {
  let server
  let call
  let stores

  async function startServer(config = buildConfig()) {
    const storage = createMemoryStorage()
    const groups = createGroupStore({ storage, logger: silentLogger })
    const modelStore = createModelStore({ config, storage, logger: silentLogger })
    const users = createUserStore({ config, storage, groups, logger: silentLogger })
    await users.seedFromEnv()
    const identity = createIdentityResolver({ config, logger: silentLogger, users })
    const broker = createDbBroker({ modelStore, users, logger: silentLogger })

    const app = createServer({
      config,
      logger: silentLogger,
      identity,
      users,
      groups,
      modelStore,
      broker,
      store: createMemorySessionStore(),
      runService: {
        snapshot: () => ({ activeRuns: 0, budget: 8, perUserLimit: 2, users: [] }),
        listSkills: () => [], abort: () => ({ ok: true }), execute: async () => ({ runId: 'r', durationMs: 1, finalText: '' }),
      },
      scheduler: { enabled: false, runNow: async () => ({ ok: true }) },
      llmInfoClient: null,
      metrics: { snapshot: () => ({}) },
      usage: null,
    })
    await app.listen(0)
    return { app, base: `http://127.0.0.1:${app.server.address().port}`, stores: { users, groups, modelStore } }
  }

  beforeEach(async () => {
    if (server) await server.app.close({ timeoutMs: 500 })
    server = await startServer()
    stores = server.stores
    call = client(server.base)
  })
  after(async () => {
    if (server) await server.app.close({ timeoutMs: 500 })
  })

  const adminToken = async () => (await call('POST', '/v1/auth/login', { body: { username: 'admin', password: 'changeme' } })).body.token

  async function normalUser(username = 'normal') {
    const token = await adminToken()
    await call('POST', '/v1/admin/users', { token, body: { username, password: 'password123' } })
    const login = await call('POST', '/v1/auth/login', { body: { username, password: 'password123' } })
    return login.body.token
  }

  test('普通用户碰不到这两组接口', async () => {
    const token = await normalUser()
    for (const path of ['/v1/admin/models', '/v1/admin/groups']) {
      const { status } = await call('GET', path, { token })
      assert.equal(status, 403)
    }
    const created = await call('POST', '/v1/admin/models', { token, body: sampleModel() })
    assert.equal(created.status, 403)
  })

  test('匿名请求同样进不来', async () => {
    const { status } = await call('GET', '/v1/admin/models')
    assert.ok(status === 401 || status === 403)
  })

  /**
   * **整个响应体里不能出现明文 key**。用整段 JSON 去搜而不是逐字段断言：
   * 将来加字段时，一个不小心带上 key 的新字段会被这条抓住，
   * 而逐字段的断言只会继续绿着。
   */
  test('模型清单不下发明文 key', async () => {
    const token = await adminToken()
    await call('POST', '/v1/admin/models', { token, body: sampleModel() })
    const listed = await call('GET', '/v1/admin/models', { token })
    assert.equal(listed.status, 200)
    assert.ok(!listed.text.includes('sk-live-abcdefghijklmnop'))
    assert.equal(listed.body.models[0].hasKey, true)
  })

  /**
   * 这份清单在 LLM_MODE≠db 时**配了也不生效**，而界面上看不出任何区别。
   * `effective` 就是那条提示的依据 —— 少了它，管理员会配完之后以为好了。
   */
  test('回 effective 告诉界面这份清单现在生不生效', async () => {
    const token = await adminToken()
    assert.equal((await call('GET', '/v1/admin/models', { token })).body.effective, true)

    await server.app.close({ timeoutMs: 500 })
    server = await startServer(buildConfig({ llm: { mode: 'platform', configSecret: '' } }))
    call = client(server.base)
    const other = await adminToken()
    const data = (await call('GET', '/v1/admin/models', { token: other })).body
    assert.equal(data.effective, false)
    assert.equal(data.llmMode, 'platform')
  })

  test('增删改一条模型', async () => {
    const token = await adminToken()
    const created = await call('POST', '/v1/admin/models', { token, body: sampleModel() })
    assert.equal(created.status, 201)

    const id = created.body.model.id
    const patched = await call('PATCH', `/v1/admin/models/${id}`, { token, body: { enabled: false } })
    assert.equal(patched.body.model.enabled, false)

    assert.equal((await call('DELETE', `/v1/admin/models/${id}`, { token })).status, 200)
    assert.equal((await call('GET', '/v1/admin/models', { token })).body.models.length, 0)
  })

  test('改到一条不存在的模型是 404，不是 500', async () => {
    const token = await adminToken()
    assert.equal((await call('PATCH', '/v1/admin/models/mdl_nope', { token, body: { enabled: false } })).status, 404)
    assert.equal((await call('DELETE', '/v1/admin/models/mdl_nope', { token })).status, 404)
  })

  test('给用户改分组；指向不存在的分组要被拦下', async () => {
    const token = await adminToken()
    await normalUser('zhangsan')
    const group = (await call('POST', '/v1/admin/groups', { token, body: { name: '内部' } })).body.group

    const ok = await call('PATCH', '/v1/admin/users/zhangsan', { token, body: { groupId: group.id } })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.user.groupId, group.id)

    /**
     * 打错的 id 必须当场拒绝。写进去的话，现象是那个人能用的模型变少了 ——
     * 而界面上只是一个显示不出名字的分组，谁也不会把这两件事联系起来。
     */
    const bad = await call('PATCH', '/v1/admin/users/zhangsan', { token, body: { groupId: 'grp_typo' } })
    assert.equal(bad.status, 400)

    // 空串是合法的：退出分组
    const out = await call('PATCH', '/v1/admin/users/zhangsan', { token, body: { groupId: '' } })
    assert.equal(out.body.user.groupId, '')
  })

  test('删分组要把账号和模型上的引用一起摘干净', async () => {
    const token = await adminToken()
    const group = (await call('POST', '/v1/admin/groups', { token, body: { name: '内部' } })).body.group
    await normalUser('zhangsan')
    await call('PATCH', '/v1/admin/users/zhangsan', { token, body: { groupId: group.id } })
    await call('POST', '/v1/admin/models', { token, body: sampleModel({ groups: [group.id] }) })

    const removed = await call('DELETE', `/v1/admin/groups/${group.id}`, { token })
    assert.equal(removed.status, 200)
    assert.equal(removed.body.detachedUsers, 1)
    assert.equal(removed.body.detachedModels, 1)

    assert.equal((await stores.users.get('zhangsan')).groupId, '')
    assert.deepEqual((await stores.modelStore.list())[0].groups, [])
  })

  test('分组清单带着人数与可用模型数（0 是要在界面上示警的那个数）', async () => {
    const token = await adminToken()
    const empty = (await call('POST', '/v1/admin/groups', { token, body: { name: '空组' } })).body.group
    const vip = (await call('POST', '/v1/admin/groups', { token, body: { name: '内部' } })).body.group
    await call('POST', '/v1/admin/models', { token, body: sampleModel({ groups: [vip.id] }) })
    await normalUser('zhangsan')
    await call('PATCH', '/v1/admin/users/zhangsan', { token, body: { groupId: vip.id } })

    const data = (await call('GET', '/v1/admin/groups', { token })).body
    const byId = Object.fromEntries(data.groups.map((group) => [group.id, group]))
    assert.equal(byId[vip.id].userCount, 1)
    assert.equal(byId[vip.id].modelCount, 1)
    assert.equal(byId[empty.id].userCount, 0)
    // 这个组一个模型都开不到 —— 组里的人打开对话框会是空的
    assert.equal(byId[empty.id].modelCount, 0)
    // 无分组的人也要算得出来，否则各组人数加起来对不上账号总数
    assert.equal(data.ungrouped, 1)
  })

  /**
   * /v1/models 是**用户**那条路，与管理接口分开测：
   * 越权的判定在管理接口那边，这里要保证普通用户拿到的是**他那一份**，
   * 且同样不含 key。
   */
  test('普通用户的 /v1/models 只回他分组能用的，且不含 key', async () => {
    const token = await adminToken()
    const vip = (await call('POST', '/v1/admin/groups', { token, body: { name: '内部' } })).body.group
    // sort 显式错开：下面要断言顺序（第一个就是这个人的默认模型）
    await call('POST', '/v1/admin/models', { token, body: sampleModel({ model: 'shared', sort: 1 }) })
    await call('POST', '/v1/admin/models', { token, body: sampleModel({ name: '贵的', model: 'expensive', groups: [vip.id], sort: 2 }) })

    const userToken = await normalUser('zhangsan')
    const mine = await call('GET', '/v1/models', { token: userToken })
    assert.deepEqual(mine.body.models.map((m) => m.id), ['shared'])
    assert.ok(!mine.text.includes('sk-live'))
    // 管理员给他的那个人类名字要带下来（对话框里显示它而不是一串 id）
    assert.equal(mine.body.models[0].name, '生产 Claude')

    await call('PATCH', '/v1/admin/users/zhangsan', { token, body: { groupId: vip.id } })
    const after = await call('GET', '/v1/models', { token: userToken })
    assert.deepEqual(after.body.models.map((m) => m.id), ['shared', 'expensive'])
  })
})
