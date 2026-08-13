/**
 * 存储契约：**测试替身与真 MySQL 必须表现得一模一样。**
 *
 * ── 为什么要有这一套 ────────────────────────────────────────────────────
 *
 * 生产代码只有 MySQL 一种后端。但整套用例不能要求每个人先起一个数据库，
 * 所以 test/helpers/memory-storage.js 提供了一个内存替身。
 *
 * 替身最大的风险是"它自己对了，但跟真的不一样"—— 于是几百条用例全绿而生产出问题。
 * 最容易漂的恰恰是边角：
 *   - 记录不存在时，一个回 null 一个抛；
 *   - merge 传 undefined，一个删字段一个存了个 null；
 *   - 删掉一版之后，一个连元信息一起没了一个还留着。
 *
 * 所以下面每一条用例都**跑两遍**，同一份断言喂给替身和真库。
 * 只要 CI 上挂着 MySQL，任何一处漂移都会当场变红。
 *
 * ── 本地没有 MySQL 时 ───────────────────────────────────────────────────
 *
 * mysql 那一遍整块跳过，并且**说出来**；替身那一遍照跑，所以刚 clone 下来的仓库
 * `npm test` 仍然全绿。CI 上把 AP_TEST_MYSQL_URL 指到一个测试库就能跑全：
 *
 *   AP_TEST_MYSQL_URL=mysql://aptest:aptest@127.0.0.1:13306/agentpod_test npm test
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from '../src/persistence/storage.js'
import { createMemoryStorage } from './helpers/memory-storage.js'
import { createArtifactStore } from '../src/artifacts/store.js'
import { createShareStore } from '../src/artifacts/shares.js'
import { createProjectStore } from '../src/projects/store.js'
import { createMemoryStore } from '../src/memory/store.js'
import { createUserStore } from '../src/identity/user-store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

/** `mysql://user:pass@host:port/db` → config.mysql 那几个字段 */
function parseMysqlUrl(raw) {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      connectionLimit: 4,
    }
  } catch {
    return null
  }
}

const MYSQL = parseMysqlUrl(process.env.AP_TEST_MYSQL_URL)

function buildConfig() {
  return {
    mysql: MYSQL || { host: '', port: 3306, user: '', password: '', database: '', connectionLimit: 4 },
    auth: { mode: 'password', password: { users: '', sessionTtlHours: 24, allowRegister: false } },
    memory: { enabled: true },
    projects: { enabled: true },
    cron: { enabled: true },
    artifacts: { enabled: true, maxBytes: 256 * 1024, maxVersions: 3, maxFiles: 40, allowedOrigins: [] },
  }
}

/** 每个用例前把上一条留下的东西清干净，两边各按各的方式 */
async function wipe(driver, storage) {
  if (driver !== 'mysql') return storage.reset()
  for (const table of ['ap_kv', 'ap_doc', 'ap_artifact_file']) {
    await storage.pool.query(`DELETE FROM ${table}`)
  }
  return undefined
}

/** 同一份用例，替身与真库各跑一遍 */
function forEachDriver(title, define) {
  for (const driver of ['memory', 'mysql']) {
    const skip = driver === 'mysql' && !MYSQL
      ? '未设置 AP_TEST_MYSQL_URL —— 跳过真库那一遍（本地没有数据库时这是正常的；CI 上必须跑）'
      : false

    describe(`${title}（${driver}）`, { skip }, () => {
      let storage

      before(async () => {
        storage = driver === 'mysql'
          ? await createStorage({ config: buildConfig(driver), logger: silentLogger })
          : createMemoryStorage()
      })
      after(async () => {
        /**
         * 走之前把表清掉。测试库是**共用**的，留下的行会跟着别的东西跑 ——
         * 真发生过：这一组最后那条播种用例留下了一个改过密码的 admin，
         * 之后手工起服务连同一个库时登不进去，而"只播种一次"的行为完全正确，
         * 排查时却指向了账号功能本身。
         */
        if (storage) await wipe(driver, storage).catch(() => {})
        await storage?.close?.()
      })
      beforeEach(() => wipe(driver, storage))

      define({
        driver,
        config: () => buildConfig(driver),
        storage: () => storage,
      })
    })
  }
}

/* ═══════════════ map：项目 / 定时任务 / 作品元信息 / 分享指针 ═══════════════ */

forEachDriver('通用 map', ({ storage }) => {
  const mapOf = () => storage().mapFor('projects', 'zhangsan')

  test('存了能读回来，没有的回 null（而不是抛）', async () => {
    assert.equal(await mapOf().get('nope'), null)
    await mapOf().put('p1', { id: 'p1', name: '结算中台' })
    assert.deepEqual(await mapOf().get('p1'), { id: 'p1', name: '结算中台' })
  })

  test('all 回全部，顺序稳定', async () => {
    await mapOf().put('p2', { id: 'p2' })
    await mapOf().put('p1', { id: 'p1' })
    assert.deepEqual((await mapOf().all()).map((item) => item.id), ['p1', 'p2'])
  })

  test('merge 是局部更新；undefined 表示删字段，与"值为 null"分得开', async () => {
    await mapOf().put('p1', { id: 'p1', name: 'a', note: 'keep', drop: 'x' })
    const next = await mapOf().merge('p1', { name: 'b', drop: undefined, nulled: null })
    assert.equal(next.name, 'b')
    assert.equal(next.note, 'keep', '没提到的字段要原样留着')
    assert.equal('drop' in next, false, 'undefined 应当把字段删掉')
    assert.equal(next.nulled, null, 'null 是一个正经的值，不该被当成删除')
  })

  test('merge / update 记录不存在时回 null，**不凭空造一条**', async () => {
    assert.equal(await mapOf().merge('ghost', { a: 1 }), null)
    assert.equal(await mapOf().update('ghost', (x) => x), null)
  })

  test('putIfAbsent 已存在就回已有的那条（创建的幂等靠它）', async () => {
    await mapOf().putIfAbsent('p1', { id: 'p1', v: 1 })
    const again = await mapOf().putIfAbsent('p1', { id: 'p1', v: 2 })
    assert.equal(again.v, 1)
  })

  test('take 取走并删掉；delete 之后 get 是 null', async () => {
    await mapOf().put('p1', { id: 'p1' })
    assert.deepEqual(await mapOf().take('p1'), { id: 'p1' })
    assert.equal(await mapOf().get('p1'), null)
    assert.equal(await mapOf().take('p1'), null, '取一个不存在的回 null')
  })

  /** 隔离契约 #4：拿到的永远是"某个人的表"，不是全局表 */
  test('两个人的同名 id 互不干扰', async () => {
    await storage().mapFor('projects', 'zhangsan').put('same', { who: 'zhangsan' })
    await storage().mapFor('projects', 'lisi').put('same', { who: 'lisi' })
    assert.equal((await storage().mapFor('projects', 'zhangsan').get('same')).who, 'zhangsan')
    assert.equal((await storage().mapFor('projects', 'lisi').get('same')).who, 'lisi')
    assert.equal((await storage().mapFor('projects', 'zhangsan').all()).length, 1)
  })

  test('不同集合互不干扰', async () => {
    await storage().mapFor('projects', 'zhangsan').put('x', { c: 'projects' })
    await storage().mapFor('cron', 'zhangsan').put('x', { c: 'cron' })
    assert.equal((await storage().mapFor('cron', 'zhangsan').get('x')).c, 'cron')
  })

  test('usernames 扫得出这个集合下有哪些人（调度要用）', async () => {
    await storage().mapFor('cron', 'zhangsan').put('c1', { id: 'c1' })
    await storage().mapFor('cron', 'lisi').put('c1', { id: 'c1' })
    assert.deepEqual((await storage().usernames('cron')).sort(), ['lisi', 'zhangsan'])
  })

  test('全局 map 不按人分（分享指针表就靠它）', async () => {
    await storage().globalMap('shares').put('s_1', { token: 's_1', username: 'zhangsan' })
    assert.equal((await storage().globalMap('shares').get('s_1')).username, 'zhangsan')
  })
})

/* ═══════════════ docs：长期记忆 ═══════════════ */

forEachDriver('长期记忆', ({ config, storage }) => {
  const memoryOf = () => createMemoryStore({ config: config(), storage: storage(), logger: silentLogger })

  test('写了能读回来；没写过是空串', async () => {
    const memory = memoryOf()
    assert.equal(await memory.recall({ username: 'zhangsan' }), '')
    await memory.capture({ username: 'zhangsan' }, ['我负责结算中台'])
    assert.match(await memory.recall({ username: 'zhangsan' }), /我负责结算中台/)
  })

  test('个人与项目是两份，互不串', async () => {
    const memory = memoryOf()
    await memory.capture({ username: 'zhangsan' }, ['个人的事'])
    await memory.capture({ username: 'zhangsan', projectId: 'p_1' }, ['项目的事'])

    assert.match(await memory.recall({ username: 'zhangsan' }), /个人的事/)
    assert.doesNotMatch(await memory.recall({ username: 'zhangsan' }), /项目的事/)
    assert.match(await memory.recall({ username: 'zhangsan', projectId: 'p_1' }), /项目的事/)
  })

  test('两个人的记忆互不串', async () => {
    const memory = memoryOf()
    await memory.capture({ username: 'zhangsan' }, ['张三的事'])
    assert.equal(await memory.recall({ username: 'lisi' }), '')
  })

  test('乐观锁：revision 对不上就拒绝，不硬覆盖', async () => {
    const memory = memoryOf()
    await memory.capture({ username: 'zhangsan' }, ['第一条'])
    const { revision } = await memory.read({ username: 'zhangsan' })

    assert.equal(await memory.replace({ username: 'zhangsan' }, '# Memory\n\n- 换成这个', 'stale-revision'), false)
    assert.match(await memory.recall({ username: 'zhangsan' }), /第一条/, '拒绝之后正文不该变')
    assert.equal(await memory.replace({ username: 'zhangsan' }, '# Memory\n\n- 换成这个', revision), true)
    assert.match(await memory.recall({ username: 'zhangsan' }), /换成这个/)
  })

  test('清空 = 删掉，读回来是空串', async () => {
    const memory = memoryOf()
    await memory.capture({ username: 'zhangsan' }, ['要被清掉'])
    const { revision } = await memory.read({ username: 'zhangsan' })
    assert.equal(await memory.replace({ username: 'zhangsan' }, '', revision), true)
    assert.equal(await memory.recall({ username: 'zhangsan' }), '')
  })

  test('项目删了，项目记忆跟着没', async () => {
    const memory = memoryOf()
    const projects = createProjectStore({ config: config(), storage: storage(), logger: silentLogger })
    const project = await projects.create({ username: 'zhangsan', name: '结算中台' })
    await memory.capture({ username: 'zhangsan', projectId: project.id }, ['本项目下周上线'])

    await projects.remove({ username: 'zhangsan', projectId: project.id })
    assert.equal(await memory.recall({ username: 'zhangsan', projectId: project.id }), '')
  })
})

/* ═══════════════ blobs：作品的文件正文 ═══════════════ */

forEachDriver('作品', ({ config, storage }) => {
  const artifactsOf = () => createArtifactStore({ config: config(), storage: storage(), logger: silentLogger })

  const make = (store, over = {}) => store.create({
    username: 'zhangsan',
    sessionKey: 's_1',
    kind: 'web',
    title: '季度看板',
    files: [
      { path: 'index.html', content: '<h1>季度看板</h1>' },
      { path: 'app.js', content: 'console.log(1)' },
    ],
    ...over,
  })

  test('建了能连正文一起读回来', async () => {
    const artifacts = artifactsOf()
    const meta = await make(artifacts)
    const current = await artifacts.read({ username: 'zhangsan', id: meta.id })
    assert.deepEqual(current.files.map((f) => f.path).sort(), ['app.js', 'index.html'])
    assert.match(current.files.find((f) => f.path === 'index.html').content, /季度看板/)
  })

  test('子目录的层级原样保留', async () => {
    const artifacts = artifactsOf()
    const meta = await make(artifacts, {
      kind: 'vue',
      files: [
        { path: 'App.vue', content: '<template><Chart /></template>' },
        { path: 'components/Chart.vue', content: '<template><i /></template>' },
      ],
    })
    const current = await artifacts.read({ username: 'zhangsan', id: meta.id })
    assert.equal(current.files.find((f) => f.path === 'components/Chart.vue').content, '<template><i /></template>')
  })

  test('write 是合并：没提到的文件原样带到新版本，旧版本仍读得到', async () => {
    const artifacts = artifactsOf()
    const meta = await make(artifacts)
    await artifacts.write({ username: 'zhangsan', id: meta.id, files: [{ path: 'app.js', content: 'console.log(2)' }] })

    const now = await artifacts.read({ username: 'zhangsan', id: meta.id })
    assert.equal(now.version, 2)
    assert.equal(now.files.find((f) => f.path === 'app.js').content, 'console.log(2)')
    assert.match(now.files.find((f) => f.path === 'index.html').content, /季度看板/, '没提到的文件要原样保留')

    const first = await artifacts.read({ username: 'zhangsan', id: meta.id, version: 1 })
    assert.equal(first.files.find((f) => f.path === 'app.js').content, 'console.log(1)')
  })

  test('超出保留窗口的旧版本正文被清掉、元信息留着', async () => {
    const artifacts = artifactsOf() // maxVersions = 3
    const meta = await make(artifacts)
    for (const n of [2, 3, 4]) {
      await artifacts.write({ username: 'zhangsan', id: meta.id, files: [{ path: 'app.js', content: `v${n}` }] })
    }
    const record = await artifacts.get({ username: 'zhangsan', id: meta.id })
    assert.equal(record.version, 4)
    assert.equal(record.versions.length, 4, '元信息四版都在')
    assert.equal(record.versions[0].pruned, true)
    await assert.rejects(() => artifacts.read({ username: 'zhangsan', id: meta.id, version: 1 }), /已被清理/)
    assert.equal((await artifacts.read({ username: 'zhangsan', id: meta.id, version: 2 })).files.find((f) => f.path === 'app.js').content, 'v2')
  })

  test('定点替换只动那一个文件', async () => {
    const artifacts = artifactsOf()
    const meta = await make(artifacts)
    await artifacts.replace({
      username: 'zhangsan', id: meta.id, path: 'index.html', oldStr: '季度看板', newStr: '年度看板',
    })
    const current = await artifacts.read({ username: 'zhangsan', id: meta.id })
    assert.match(current.files.find((f) => f.path === 'index.html').content, /年度看板/)
    assert.equal(current.files.find((f) => f.path === 'app.js').content, 'console.log(1)')
  })

  test('删了作品，正文跟着没，不留孤儿', async () => {
    const artifacts = artifactsOf()
    const meta = await make(artifacts)
    assert.equal(await artifacts.remove({ username: 'zhangsan', id: meta.id }), true)
    assert.equal(await artifacts.read({ username: 'zhangsan', id: meta.id }), null)
    assert.deepEqual(await artifacts.listOnDisk({ username: 'zhangsan', id: meta.id, version: 1 }).catch(() => []), [])
  })

  test('别人的作品看不见、读不到、改不了、删不掉', async () => {
    const artifacts = artifactsOf()
    const meta = await make(artifacts)
    assert.equal((await artifacts.list({ username: 'lisi' })).length, 0)
    assert.equal(await artifacts.read({ username: 'lisi', id: meta.id }), null)
    assert.equal(await artifacts.remove({ username: 'lisi', id: meta.id }), false)
  })

  test('中文文件名与中文正文原样往返', async () => {
    const artifacts = artifactsOf()
    const meta = await make(artifacts, { kind: 'markdown', files: [{ path: '交接文档.md', content: '# 交接\n\n一二三' }] })
    const current = await artifacts.read({ username: 'zhangsan', id: meta.id })
    assert.equal(current.files[0].path, '交接文档.md')
    assert.match(current.files[0].content, /一二三/)
  })
})

/* ═══════════════ 分享 / 市场 ═══════════════ */

forEachDriver('分享与市场', ({ config, storage }) => {
  test('分享 → 匿名解析 → 上市场 → 撤销', async () => {
    const artifacts = createArtifactStore({ config: config(), storage: storage(), logger: silentLogger })
    const shares = createShareStore({ config: config(), storage: storage(), logger: silentLogger, artifacts })

    const meta = await artifacts.create({
      username: 'zhangsan', sessionKey: 's_1', kind: 'web', title: '看板',
      files: [{ path: 'index.html', content: '<h1>hi</h1>' }],
    })

    const shared = await shares.create({ username: 'zhangsan', artifactId: meta.id })
    const token = shared.share.token
    assert.match(token, /^s_[0-9a-f]{24}$/)

    // 只凭 token 就能打开（访客没有 username）
    const opened = await shares.open(token)
    assert.equal(opened.meta.title, '看板')
    assert.equal(opened.share.author, 'zhangsan')

    // 生成链接 ≠ 上广场
    assert.deepEqual(await shares.listMarket(), [])
    await shares.setMarket({ username: 'zhangsan', artifactId: meta.id, market: true, summary: '一张看板' })
    const items = await shares.listMarket()
    assert.equal(items.length, 1)
    assert.equal(items[0].summary, '一张看板')

    // 撤销后链接与市场条目一起消失
    await shares.revoke({ username: 'zhangsan', artifactId: meta.id })
    assert.equal(await shares.open(token), null)
    assert.deepEqual(await shares.listMarket(), [])
  })

  test('作品删了，指针自愈（读的那一刻就失效）', async () => {
    const artifacts = createArtifactStore({ config: config(), storage: storage(), logger: silentLogger })
    const shares = createShareStore({ config: config(), storage: storage(), logger: silentLogger, artifacts })

    const meta = await artifacts.create({
      username: 'zhangsan', sessionKey: 's_1', kind: 'web', title: 't',
      files: [{ path: 'index.html', content: 'x' }],
    })
    const token = (await shares.create({ username: 'zhangsan', artifactId: meta.id })).share.token
    await artifacts.remove({ username: 'zhangsan', id: meta.id })
    assert.equal(await shares.open(token), null)
  })
})

/* ═══════════════ 账号 ═══════════════ */

forEachDriver('账号', ({ config, storage }) => {
  const usersOf = (over = {}) => createUserStore({
    config: { ...config(), auth: { mode: 'password', password: { users: '', ...over } } },
    storage: storage(),
    logger: silentLogger,
  })

  test('建了能登录；密码错、用户不存在都回 ok:false', async () => {
    const users = usersOf()
    await users.create({ username: 'zhangsan', password: 'correct-horse' })
    assert.equal((await users.verify('zhangsan', 'correct-horse')).ok, true)
    assert.equal((await users.verify('zhangsan', 'wrong')).ok, false)
    assert.equal((await users.verify('nobody', 'whatever')).ok, false)
  })

  /** 存的是派生结果和盐，**明文一个字都不能落库** */
  test('落库的记录里没有明文密码', async () => {
    const users = usersOf()
    await users.create({ username: 'zhangsan', password: 'super-secret-pw' })
    const raw = await storage().globalMap('accounts').get('zhangsan')
    assert.equal(JSON.stringify(raw).includes('super-secret-pw'), false, '明文密码进了存储')
    assert.ok(raw.salt && raw.passwordHash)
  })

  test('同样的密码，两个人的哈希不一样（每人独立的盐）', async () => {
    const users = usersOf()
    await users.create({ username: 'zhangsan', password: 'same-password' })
    await users.create({ username: 'lisi', password: 'same-password' })
    const a = await storage().globalMap('accounts').get('zhangsan')
    const b = await storage().globalMap('accounts').get('lisi')
    assert.notEqual(a.passwordHash, b.passwordHash)
    assert.notEqual(a.salt, b.salt)
  })

  test('用户名重复注册不了（并发下也不会互相覆盖）', async () => {
    const users = usersOf()
    await users.create({ username: 'zhangsan', password: 'password-one' })
    await assert.rejects(() => users.create({ username: 'zhangsan', password: 'password-two' }), /已被占用/)
    assert.equal((await users.verify('zhangsan', 'password-one')).ok, true, '原密码必须还能用')
  })

  test('改密要旧密码；改完旧的失效新的生效', async () => {
    const users = usersOf()
    await users.create({ username: 'zhangsan', password: 'old-password' })

    assert.equal((await users.changePassword({ username: 'zhangsan', oldPassword: 'wrong', newPassword: 'new-password' })).ok, false)
    assert.equal((await users.verify('zhangsan', 'old-password')).ok, true, '验错旧密码时不该改动任何东西')

    assert.equal((await users.changePassword({ username: 'zhangsan', oldPassword: 'old-password', newPassword: 'new-password' })).ok, true)
    assert.equal((await users.verify('zhangsan', 'old-password')).ok, false)
    assert.equal((await users.verify('zhangsan', 'new-password')).ok, true)
  })

  test('太短的密码建不了、也改不成', async () => {
    const users = usersOf()
    await assert.rejects(() => users.create({ username: 'zhangsan', password: 'short' }), /至少 8 位/)
    await users.create({ username: 'zhangsan', password: 'long-enough' })
    await assert.rejects(
      () => users.changePassword({ username: 'zhangsan', oldPassword: 'long-enough', newPassword: 'x' }),
      /至少 8 位/,
    )
  })

  test('禁用之后登录不上，但数据还在（不是删账号）', async () => {
    const users = usersOf()
    await users.create({ username: 'zhangsan', password: 'password-one' })
    await users.setDisabled({ username: 'zhangsan', disabled: true })

    const result = await users.verify('zhangsan', 'password-one')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'disabled', '密码是对的，拒绝的原因是禁用')
    assert.ok(await users.get('zhangsan'), '账号记录该留着')

    await users.setDisabled({ username: 'zhangsan', disabled: false })
    assert.equal((await users.verify('zhangsan', 'password-one')).ok, true)
  })

  test('CONSOLE_USERS 只播种一次：改过的密码不会被重启打回去', async () => {
    const seeded = usersOf({ users: 'admin:seedpass,bob:seedpass2' })
    assert.deepEqual(await seeded.seedFromEnv(), { seeded: 2, skipped: 0 })
    assert.equal((await seeded.get('admin')).role, 'admin', '全新部署里第一个是管理员')
    assert.equal((await seeded.get('bob')).role, 'user')

    await seeded.changePassword({ username: 'admin', oldPassword: 'seedpass', newPassword: 'changed-by-user' })

    // 再启动一次
    assert.deepEqual(await usersOf({ users: 'admin:seedpass,bob:seedpass2' }).seedFromEnv(), { seeded: 0, skipped: 2 })
    assert.equal((await seeded.verify('admin', 'changed-by-user')).ok, true, '用户改过的密码被环境变量覆盖回去了')
    assert.equal((await seeded.verify('admin', 'seedpass')).ok, false)
  })
})
