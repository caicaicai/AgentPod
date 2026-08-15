/**
 * 分组的 token 额度：**判据**与**日界**。
 *
 * 这个功能最容易错的不是"超了拦不拦"，是它旁边那几件事：
 *
 *   1. **口径** —— 额度算的是 input+output，不含缓存读入。与管理台那张表同一个
 *      口径，否则会出现"用量页写着 80 万、人却在 100 万的额度上被拦了"。
 *   2. **日界** —— "今天"从哪一刻开始。台账按 UTC 存，直接拿 UTC 的天当今天，
 *      每日额度会在北京时间早上八点归零：没人猜得到，也没人报得出这个 bug。
 *   3. **报什么错** —— 总额度是 403（等下去没用），当日额度是 429 带 retryAfterMs
 *      （过了零点自己就好）。定时任务据此决定"退避重试"还是"别再打了"。
 *   4. **没配额度的部署一个查询都不发** —— 这道闸门排在每一次对话前面。
 *   5. **库挂了放行** —— 它防的是预算被烧光，不是安全边界。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createQuotaGuard, startOfDay, nextDayStart } from '../src/telemetry/quota.js'
import { createGroupStore } from '../src/identity/group-store.js'
import { createRunService } from '../src/agent/run-service.js'
import { createMemoryStorage } from './helpers/memory-storage.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }
const TZ = 'Asia/Shanghai'
/** 北京时间 2026-08-15 09:00（= UTC 01:00）。当天的零点在 UTC 前一天 16:00 */
const NOW = Date.parse('2026-08-15T01:00:00.000Z')

/** 只用到 `get`，不必搬整个 user-store 进来 */
const fakeUsers = (map) => ({ async get(username) { return map[username] || null } })

async function build({ quota = {}, rows = [], user = { groupId: '' } } = {}) {
  const storage = createMemoryStorage()
  const groups = createGroupStore({ storage, logger: silentLogger })
  const group = await groups.create({ name: '试用', ...quota })
  for (const [index, row] of rows.entries()) {
    await storage.usage.record({ username: 'zhangsan', runId: `r${index}`, ...row })
  }
  const users = fakeUsers({ zhangsan: { username: 'zhangsan', groupId: user.groupId === 'self' ? group.id : user.groupId } })
  return {
    storage,
    groups,
    group,
    guard: createQuotaGuard({ storage, users, groups, timezone: TZ, logger: silentLogger }),
  }
}

describe('日界', () => {
  test('"今天"按配置的时区算，不是 UTC 的天', () => {
    // 北京时间 8/15 09:00 的当天零点 = UTC 8/14 16:00
    assert.equal(startOfDay(NOW, TZ).toISOString(), '2026-08-14T16:00:00.000Z')
    // 同一刻在 UTC 下算出来差了八小时 —— 正是这个差让额度在早上八点归零
    assert.equal(startOfDay(NOW, 'UTC').toISOString(), '2026-08-15T00:00:00.000Z')
  })

  test('刚过当地零点一分钟，也算新的一天', () => {
    const justAfter = Date.parse('2026-08-14T16:01:00.000Z') // 北京 8/15 00:01
    assert.equal(startOfDay(justAfter, TZ).toISOString(), '2026-08-14T16:00:00.000Z')
  })

  test('当地零点整这一刻，属于新的一天（下界是闭区间）', () => {
    const midnight = Date.parse('2026-08-14T16:00:00.000Z')
    assert.equal(startOfDay(midnight, TZ).getTime(), midnight)
  })

  test('下一个当地零点是 24 小时后（无夏令时的时区）', () => {
    assert.equal(nextDayStart(startOfDay(NOW, TZ), TZ).toISOString(), '2026-08-15T16:00:00.000Z')
  })

  /**
   * 有夏令时的时区：切换那天当地的一天是 23 或 25 小时。直接 +24 小时会落到
   * 当天 23 点或次日 1 点，于是"明天几点恢复"那句话会写错一小时。
   */
  test('夏令时那天，下一个零点仍然是当地的零点', () => {
    const tz = 'America/New_York'
    // 2026-03-08 是美东夏令时开始那天（当地只有 23 小时）
    const dayStart = startOfDay(Date.parse('2026-03-08T12:00:00.000Z'), tz)
    assert.equal(dayStart.toISOString(), '2026-03-08T05:00:00.000Z', '当地 3/8 零点 = UTC 05:00')
    assert.equal(nextDayStart(dayStart, tz).toISOString(), '2026-03-09T04:00:00.000Z', '当地 3/9 零点 = UTC 04:00')
  })

  test('时区名写错不让服务起不来：退回默认时区', () => {
    const guard = createQuotaGuard({ timezone: '火星/黄石', logger: silentLogger })
    assert.equal(guard.timezone, 'Asia/Shanghai')
  })
})

describe('什么时候整块不生效', () => {
  test('缺任何一个依赖就是"这个部署不做额度"，而且是放行不是拦住', async () => {
    const storage = createMemoryStorage()
    for (const deps of [
      { storage, users: fakeUsers({}), groups: null },
      { storage, users: null, groups: {} },
      { storage: null, users: fakeUsers({}), groups: {} },
    ]) {
      const guard = createQuotaGuard({ ...deps, logger: silentLogger })
      assert.equal(guard.enabled, false)
      assert.equal((await guard.check('zhangsan')).ok, true)
      await guard.assert('zhangsan')
    }
  })

  test('没有分组的人不受限 —— 与"没建分组也能跑"一致', async () => {
    const { guard } = await build({
      quota: { tokenQuota: 100 },
      rows: [{ input: 9999, output: 9999 }],
      user: { groupId: '' },
    })
    assert.equal((await guard.check('zhangsan', { now: NOW })).ok, true)
  })

  /**
   * 这条钉的是**代价**：绝大多数部署一个额度都没配，那它们不该为每一次对话
   * 多付一次跨全部历史的 SUM。用一个会抛的台账替身来证明"根本没查"。
   */
  test('两个额度都没配就一个查询都不发', async () => {
    const groups = createGroupStore({ storage: createMemoryStorage(), logger: silentLogger })
    const group = await groups.create({ name: '默认' })
    const guard = createQuotaGuard({
      storage: { usage: { totalsForUser() { throw new Error('不该查台账') } } },
      users: fakeUsers({ zhangsan: { groupId: group.id } }),
      groups,
      logger: silentLogger,
    })
    assert.equal((await guard.check('zhangsan', { now: NOW })).ok, true)
  })
})

describe('总额度（累计，永不重置）', () => {
  test('没到上限就放行，并把已用/上限一起回出去', async () => {
    const { guard } = await build({
      quota: { tokenQuota: 1000 },
      rows: [{ input: 300, output: 200 }],
      user: { groupId: 'self' },
    })
    const verdict = await guard.check('zhangsan', { now: NOW })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.usedTotal, 500)
    assert.equal(verdict.totalLimit, 1000)
    /**
     * 只配了总额度时"今天用了多少"是 **null，不是 0 也不是 500**：那一半根本没查
     * （省掉一次条件 SUM）。回 500 的话，照着它画"今天已用"的人会得到一个静悄悄的错数。
     */
    assert.equal(verdict.usedToday, null)
  })

  test('到了上限就拦（等于也算超 —— 剩 0 个 token 不该再放一轮进去）', async () => {
    const { guard } = await build({
      quota: { tokenQuota: 1000 },
      rows: [{ input: 600, output: 400 }],
      user: { groupId: 'self' },
    })
    assert.equal((await guard.check('zhangsan', { now: NOW })).scope, 'total')
  })

  test('缓存读入不算进额度 —— 与用量页那张表同一个口径', async () => {
    const { guard } = await build({
      quota: { tokenQuota: 1000 },
      rows: [{ input: 100, output: 100, cacheRead: 5000 }],
      user: { groupId: 'self' },
    })
    assert.equal((await guard.check('zhangsan', { now: NOW })).usedTotal, 200)
  })

  test('多久以前的账都算 —— "总额度"不是"最近 30 天"', async () => {
    const { guard } = await build({
      quota: { tokenQuota: 1000 },
      rows: [
        { input: 900, output: 0, createdAt: new Date(NOW - 300 * 24 * 60 * 60 * 1000) },
        { input: 100, output: 0 },
      ],
      user: { groupId: 'self' },
    })
    assert.equal((await guard.check('zhangsan', { now: NOW })).scope, 'total')
  })

  test('别人的账不算在这个人头上', async () => {
    const { storage, guard } = await build({
      quota: { tokenQuota: 1000 },
      rows: [{ input: 100, output: 0 }],
      user: { groupId: 'self' },
    })
    await storage.usage.record({ username: 'lisi', runId: 'other', input: 99999, output: 99999 })
    assert.equal((await guard.check('zhangsan', { now: NOW })).ok, true)
  })

  test('拦下来是 403：等下去没有用，只有管理员调高上限才行', async () => {
    const { guard } = await build({
      quota: { tokenQuota: 1000 },
      rows: [{ input: 1200, output: 0 }],
      user: { groupId: 'self' },
    })
    await assert.rejects(() => guard.assert('zhangsan', { now: NOW }), (error) => {
      assert.equal(error.status, 403)
      assert.equal(error.code, 'FORBIDDEN')
      assert.equal(error.details.scope, 'total')
      assert.match(error.message, /1,200 \/ 1,000 tokens/, '数字要带千位分隔，直接写给用户看')
      assert.match(error.message, /试用/, '要说清是哪个分组的额度')
      return true
    })
  })
})

describe('每日额度', () => {
  const rowsAcross = [
    // 北京时间昨天 23:00（UTC 15:00）—— 不该算进"今天"
    { input: 800, output: 0, createdAt: new Date(Date.parse('2026-08-14T15:00:00.000Z')) },
    // 北京时间今天 08:00（UTC 00:00）
    { input: 300, output: 0, createdAt: new Date(Date.parse('2026-08-15T00:00:00.000Z')) },
  ]

  test('昨天的量不算进今天', async () => {
    const { guard } = await build({
      quota: { dailyTokenQuota: 500 },
      rows: rowsAcross,
      user: { groupId: 'self' },
    })
    const verdict = await guard.check('zhangsan', { now: NOW })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.usedToday, 300)
    assert.equal(verdict.usedTotal, 1100, '累计那一半照样把昨天的算进去')
  })

  test('今天用超了就拦，429 + 到点恢复', async () => {
    const { guard } = await build({
      quota: { dailyTokenQuota: 200 },
      rows: rowsAcross,
      user: { groupId: 'self' },
    })
    await assert.rejects(() => guard.assert('zhangsan', { now: NOW }), (error) => {
      assert.equal(error.status, 429)
      assert.equal(error.code, 'RATE_LIMITED')
      assert.equal(error.retryable, true)
      assert.equal(error.details.scope, 'daily')
      assert.equal(error.details.resetAt, '2026-08-15T16:00:00.000Z', '下一个北京时间零点')
      assert.equal(error.details.retryAfterMs, 15 * 60 * 60 * 1000, '从 09:00 到次日 00:00 是 15 小时')
      assert.match(error.message, /00:00 之后恢复/)
      return true
    })
  })

  /** 跨过当地零点，同一批账就不再算数了 —— 这是"每天"两个字的全部含义 */
  test('过了当地零点自动恢复，不需要任何人做什么', async () => {
    const { guard } = await build({
      quota: { dailyTokenQuota: 200 },
      rows: rowsAcross,
      user: { groupId: 'self' },
    })
    const tomorrow = Date.parse('2026-08-15T16:30:00.000Z') // 北京 8/16 00:30
    assert.equal((await guard.check('zhangsan', { now: tomorrow })).ok, true)
  })

  test('两个额度一起配：总额度先拦（那个等下去也不会好）', async () => {
    const { guard } = await build({
      quota: { tokenQuota: 1000, dailyTokenQuota: 100 },
      rows: [{ input: 2000, output: 0 }],
      user: { groupId: 'self' },
    })
    await assert.rejects(() => guard.assert('zhangsan', { now: NOW }), (error) => {
      assert.equal(error.status, 403)
      return true
    })
  })
})

describe('查不到就放行', () => {
  test('台账挂了不拦人：额度防的是预算被烧光，不是安全边界', async () => {
    const groups = createGroupStore({ storage: createMemoryStorage(), logger: silentLogger })
    const group = await groups.create({ name: '试用', tokenQuota: 1 })
    const guard = createQuotaGuard({
      storage: { usage: { totalsForUser() { throw new Error('库挂了') } } },
      users: fakeUsers({ zhangsan: { groupId: group.id } }),
      groups,
      logger: silentLogger,
    })
    assert.equal((await guard.check('zhangsan', { now: NOW })).ok, true)
    await guard.assert('zhangsan', { now: NOW })
  })

  test('查不到账号或分组也放行', async () => {
    const storage = createMemoryStorage()
    const guard = createQuotaGuard({
      storage,
      users: { async get() { throw new Error('账号库挂了') } },
      groups: createGroupStore({ storage, logger: silentLogger }),
      logger: silentLogger,
    })
    assert.equal((await guard.check('zhangsan', { now: NOW })).ok, true)
  })

  /** 分组被删了、账号上那个 id 还留着（正常路径不该出现，出现了也不能把人锁死） */
  test('指着一个不存在的分组时不受限', async () => {
    const storage = createMemoryStorage()
    const guard = createQuotaGuard({
      storage,
      users: fakeUsers({ zhangsan: { groupId: 'grp_gone' } }),
      groups: createGroupStore({ storage, logger: silentLogger }),
      logger: silentLogger,
    })
    assert.equal((await guard.check('zhangsan', { now: NOW })).ok, true)
  })
})

describe('额度怎么存', () => {
  const store = () => createGroupStore({ storage: createMemoryStorage(), logger: silentLogger })

  test('默认不限（0），老记录也当 0 —— 升级上来不该凭空多出一道闸', async () => {
    const groups = store()
    const created = await groups.create({ name: '研发' })
    assert.equal(created.tokenQuota, 0)
    assert.equal(created.dailyTokenQuota, 0)
  })

  test('空串 = 不限（界面上把数字框清空就是这个意思）', async () => {
    const groups = store()
    const created = await groups.create({ name: '研发', tokenQuota: '', dailyTokenQuota: '  ' })
    assert.equal(created.tokenQuota, 0)
    assert.equal(created.dailyTokenQuota, 0)
  })

  test('数字串照收，小数向下取整', async () => {
    const groups = store()
    const created = await groups.create({ name: '研发', tokenQuota: '1000000', dailyTokenQuota: 99.9 })
    assert.equal(created.tokenQuota, 1000000)
    assert.equal(created.dailyTokenQuota, 99)
  })

  /**
   * 乱填**要报错**，不能像查询参数那样悄悄退回默认值：这里的默认值是"不限"，
   * 管理员少打一个字得到的会是"这个组从此不限量"，而界面上会如实写着「不限」，
   * 没有任何地方提示他刚才那一下没生效。
   */
  test('乱填要报错，不能悄悄变成"不限"', async () => {
    const groups = store()
    for (const bad of ['abc', -1, '-5', Infinity, NaN]) {
      await assert.rejects(() => groups.create({ name: '研发', tokenQuota: bad }), /总额度|太大/, `坏值：${String(bad)}`)
    }
    await assert.rejects(() => groups.create({ name: '研发', dailyTokenQuota: 'x' }), /每日额度/)
  })

  test('改额度只改额度，不碰名字和默认标记', async () => {
    const groups = store()
    const created = await groups.create({ name: '研发', description: '给研发的', isDefault: true, tokenQuota: 100 })
    const updated = await groups.update(created.id, { dailyTokenQuota: 50 })
    assert.equal(updated.dailyTokenQuota, 50)
    assert.equal(updated.tokenQuota, 100)
    assert.equal(updated.name, '研发')
    assert.equal(updated.isDefault, true)
  })

  test('把额度改回 0 就是解开限制', async () => {
    const groups = store()
    const created = await groups.create({ name: '研发', tokenQuota: 100 })
    assert.equal((await groups.update(created.id, { tokenQuota: 0 })).tokenQuota, 0)
  })
})

/**
 * ── 闸门真的装在 run 上了吗 ─────────────────────────────────────────────
 *
 * 上面那些只证明 `assert()` 会算、会抛。**装没装**是另一回事：
 * 少写一行 `await quota.assert(...)`，上面全部照绿，而生产上没有任何东西被拦住 ——
 * 与 context-prompt.test.js 里那条"整条链"的理由一模一样。
 *
 * 顺带钉住它在管线上的**位置**：排在申请并发槽位之前、排在调模型之前。
 */
describe('装在 run 上（整条链）', () => {
  const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

  async function serviceWith(quotaFields) {
    const storage = createMemoryStorage()
    const groups = createGroupStore({ storage, logger: silent })
    const group = await groups.create({ name: '试用', ...quotaFields })
    await storage.usage.record({ username: 'zhangsan', runId: 'spent', input: 5000, output: 5000 })

    const runService = createRunService({
      config: {
        limits: { maxConcurrentRuns: 8, maxRunsPerUser: 2, runTimeoutMs: 30000 },
        skills: { dirs: [], libsDir: '' },
        sandbox: { mode: 'none' },
        llm: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1, extraPatterns: [] } },
      },
      logger: silent,
      store: { async load() { return { messages: [] } } },
      sandbox: { mode: 'none' },
      // 被拦住的 run 一次模型都不该问 —— 问了就说明闸门装晚了
      broker: { getLlmAccess() { throw new Error('不该走到取模型这一步') } },
      metrics: { recordRun() {} },
      quota: createQuotaGuard({
        storage,
        users: fakeUsers({ zhangsan: { groupId: group.id } }),
        groups,
        timezone: TZ,
        logger: silent,
      }),
    })
    return runService
  }

  const run = (runService) => runService.execute({
    subject: { username: 'zhangsan', credential: '' },
    sessionKey: 'main',
    prompt: '你好',
  })

  test('额度用完的人开不了新的一轮', async () => {
    const runService = await serviceWith({ tokenQuota: 1000 })
    await assert.rejects(() => run(runService), (error) => {
      assert.equal(error.status, 403)
      assert.match(error.message, /总额度已用完/)
      return true
    })
  })

  /**
   * 拦下来**不能占着槽位**：额度是"这个人还能不能用"，槽位是"这会儿有没有位子"。
   * 顺序反了的话，每次被拦都白占一次，并发满的时候那一下会把别人挤成 429。
   */
  test('被拦下来的一轮不占并发槽位', async () => {
    const runService = await serviceWith({ tokenQuota: 1000 })
    await assert.rejects(() => run(runService))
    assert.equal(runService.snapshot().activeRuns, 0)
    assert.deepEqual(runService.snapshot().users, [], '这个人身上也不该留下计数')
  })

  test('没配额度的分组照常放行（放行之后才轮到取模型那一步）', async () => {
    const runService = await serviceWith({})
    // 走到 broker 那句才抛，说明额度这一关是过了的
    await assert.rejects(() => run(runService), /不该走到取模型这一步/)
  })
})
