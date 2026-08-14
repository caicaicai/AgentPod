/**
 * Token 用量的**算法与口径**。
 *
 * 存储那一层有自己的契约用例（storage-drivers.test.js 的「token 用量」一组），
 * 接口那一层也有（accounts-api.test.js 的「Token 用量」一组）。这里测的是夹在
 * 中间、两边都测不到的那些判断：
 *
 *   1. **口径** —— `tokens` 是不是把缓存读入算进去了。它算进去的话，界面上那个
 *      "总用量"既不等于花的钱、也不等于模型看的字数，而两头都对不上的数字
 *      没人会发现是错的，只会觉得"这个数好像有点怪"。
 *   2. **记账不能弄坏对话** —— 库抖一下不该让一次已经答完的对话变成一条报错。
 *   3. **左连接** —— 没跑过 run 的账号要有一行 0，被删掉的账号留下的账不能藏。
 *   4. **文案** —— 数字怎么写给人看（前端那两个函数）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createUsageStore, pivot, resolveSince, sumBuckets } from '../src/telemetry/usage-store.js'
import { formatSince, formatTokens } from '../web/src/lib/format.js'
import { createMemoryStorage } from './helpers/memory-storage.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-08-14T12:00:00.000Z')

describe('时间窗', () => {
  test('days=0 表示不限时间（界面上那个「全部」）', () => {
    assert.equal(resolveSince(0, { now: NOW }), null)
    assert.equal(resolveSince('0', { now: NOW }), null)
  })

  test('正常值就是"往前推这么多天"', () => {
    assert.equal(resolveSince(7, { now: NOW }).toISOString(), '2026-08-07T12:00:00.000Z')
    assert.equal(resolveSince('30', { now: NOW }).toISOString(), '2026-07-15T12:00:00.000Z')
  })

  /**
   * 一个查询参数填错不值得回 400 —— 那只是让人多点一次。
   *
   * `null` 和 `''` 在这条用例里最要紧：`searchParams.get('days')` 参数缺席时回的
   * 就是 null，而 `Number(null) === 0`。真按 0 处理的话，一次不带参数的请求
   * （最常走的那条）会悄悄变成"要全部历史"，也就是一次全表扫。
   */
  test('乱填、没传都退回默认 30 天，不抛，也不当成"全部"', () => {
    for (const bad of [undefined, null, '', '  ', 'abc', -5, NaN, {}]) {
      assert.equal(resolveSince(bad, { now: NOW })?.toISOString(), '2026-07-15T12:00:00.000Z', `坏值：${String(bad)}`)
    }
  })

  test('上限一年 —— 无上限等于允许一次全表扫', () => {
    assert.equal(resolveSince(99999, { now: NOW }).getTime(), NOW - 365 * DAY)
  })
})

describe('合计口径', () => {
  test('tokens = 输入 + 输出，**不含缓存读入**', () => {
    const total = sumBuckets([
      { runs: 1, input: 100, output: 20, cacheRead: 900 },
      { runs: 2, input: 300, output: 40, cacheRead: 100 },
    ])
    assert.deepEqual(total, { runs: 3, input: 400, output: 60, cacheRead: 1000, tokens: 460 })
  })

  test('空数组是一堆 0，不是 null —— 界面直接读 .tokens', () => {
    assert.deepEqual(sumBuckets([]), { runs: 0, input: 0, output: 0, cacheRead: 0, tokens: 0 })
  })
})

describe('落库', () => {
  const build = () => {
    const storage = createMemoryStorage()
    return { storage, usage: createUsageStore({ storage, logger: silentLogger }) }
  }

  test('没接存储时整块关掉，调用它也不炸', async () => {
    const usage = createUsageStore({ storage: null, logger: silentLogger })
    assert.equal(usage.enabled, false)
    assert.equal(await usage.record({ username: 'zhangsan', runId: 'r1', input: 1 }), false)
    assert.deepEqual((await usage.summary({ accounts: [{ username: 'zhangsan' }] })).users, [])
  })

  /**
   * 一次 run 一分 token 都没花（faux 模型、纯工具轮）就不记。
   * 记了只是给账上添零行，而那些行会让"run 次数"看起来比实际用量多。
   */
  test('零用量的 run 不记账', async () => {
    const { usage, storage } = build()
    assert.equal(await usage.record({ username: 'zhangsan', runId: 'r1', input: 0, output: 0, cacheRead: 0 }), false)
    assert.deepEqual(await storage.usage.byUserAndModel(), [])
    assert.equal(await usage.record({ username: 'zhangsan', runId: 'r2', input: 0, output: 0, cacheRead: 12 }), true)
    assert.equal((await storage.usage.byUserAndModel())[0].cacheRead, 12, '只命中缓存也是用量')
  })

  test('少了 username 或 runId 就不写 —— 一条记不到人头上的账没有用', async () => {
    const { usage } = build()
    assert.equal(await usage.record({ runId: 'r1', input: 5 }), false)
    assert.equal(await usage.record({ username: 'zhangsan', input: 5 }), false)
  })

  /**
   * 这条是这个模块存在的主要理由之一：`record` **永不抛**。
   * 调用方（run-service）不 await、也不 catch —— 它抛了就会变成一条
   * unhandled rejection，而那是在一次已经成功的对话之后。
   */
  test('库抖一下不该让对话失败：record 吞掉异常并回 false', async () => {
    const usage = createUsageStore({
      storage: { usage: { record() { throw new Error('库挂了') } } },
      logger: silentLogger,
    })
    assert.equal(await usage.record({ username: 'zhangsan', runId: 'r1', input: 1 }), false)
  })
})

/**
 * ── 转置 ────────────────────────────────────────────────────────────────
 *
 * 「按用户」和「按模型」是同一份交叉表的两种折叠，共用 pivot()。
 * 这一组钉的就是"折哪一维都不改变总数" —— 两页合计对不上是这个功能最难查的错：
 * 谁也说不清哪一页是对的。
 */
describe('按维度转置', () => {
  const rows = [
    { username: 'zhangsan', modelId: 'opus', runs: 2, input: 1000, output: 200, cacheRead: 30, lastAt: '2026-08-13T00:00:00.000Z' },
    { username: 'zhangsan', modelId: 'haiku', runs: 5, input: 50, output: 10, cacheRead: 0, lastAt: '2026-08-14T00:00:00.000Z' },
    { username: 'lisi', modelId: 'opus', runs: 1, input: 300, output: 60, cacheRead: 5, lastAt: '2026-08-12T00:00:00.000Z' },
  ]

  test('按用户折：每个人一行，模型进 children', () => {
    const users = pivot(rows, 'username')
    assert.deepEqual(users.map((row) => row.username), ['zhangsan', 'lisi'])
    assert.equal(users[0].tokens, 1260)
    assert.equal(users[0].runs, 7)
    assert.deepEqual(users[0].children.map((child) => child.modelId), ['opus', 'haiku'], '大的在前')
    assert.equal(users[0].lastAt, '2026-08-14T00:00:00.000Z', '取这一维里最近的那一次')
  })

  test('按模型折：每个模型一行，用户进 children', () => {
    const models = pivot(rows, 'modelId')
    assert.deepEqual(models.map((row) => row.modelId), ['opus', 'haiku'])
    assert.equal(models[0].tokens, 1560)
    assert.deepEqual(models[0].children.map((child) => child.username), ['zhangsan', 'lisi'])
  })

  test('两个方向的合计相等 —— 折叠不该改变总数', () => {
    const byUser = sumBuckets(pivot(rows, 'username'))
    const byModel = sumBuckets(pivot(rows, 'modelId'))
    assert.deepEqual(byUser, byModel)
    assert.equal(byUser.tokens, 1620)
  })
})

describe('总表拼装', () => {
  const build = async () => {
    const storage = createMemoryStorage()
    const usage = createUsageStore({ storage, logger: silentLogger })
    await storage.usage.record({
      username: 'zhangsan', runId: 'r1', modelId: 'opus', input: 1000, output: 200, cacheRead: 30,
      createdAt: new Date(NOW - 2 * DAY),
    })
    await storage.usage.record({
      username: 'zhangsan', runId: 'r2', modelId: 'haiku', input: 40, output: 10,
      createdAt: new Date(NOW - 1 * DAY),
    })
    await storage.usage.record({
      username: 'gone', runId: 'r3', modelId: 'opus', input: 5, output: 1,
      createdAt: new Date(NOW - 2 * DAY),
    })
    return { storage, usage }
  }

  test('没跑过的账号也有一行 0 —— 否则"没用过"和"不存在"长得一样', async () => {
    const { usage } = await build()
    const summary = await usage.summary({
      accounts: [{ username: 'zhangsan', role: 'admin' }, { username: 'lisi', role: 'user', disabled: true }],
      days: 30,
      now: NOW,
    })
    assert.equal(summary.group, 'user')
    const rows = new Map(summary.users.map((row) => [row.username, row]))
    assert.equal(rows.get('zhangsan').tokens, 1250)
    assert.equal(rows.get('zhangsan').role, 'admin')
    assert.equal(rows.get('lisi').tokens, 0)
    assert.equal(rows.get('lisi').runs, 0)
    assert.equal(rows.get('lisi').lastAt, null)
    assert.deepEqual(rows.get('lisi').models, [], '没用过就是一个空数组，不是 undefined —— 界面直接 .length')
    assert.equal(rows.get('lisi').disabled, true, '禁用状态要带上：界面把这一行压暗')
  })

  /**
   * 这条是这次改动的要点：**模型拆分跟着总表一起下来**，展开不再打一次接口。
   * 分两次取的话，中间又跑了一轮就会出现"表里 1,250、展开后 1,310"。
   */
  test('每个用户行都带着他用过的模型（大的在前）', async () => {
    const { usage } = await build()
    const summary = await usage.summary({ accounts: [{ username: 'zhangsan' }], days: 30, now: NOW })
    const mine = summary.users.find((row) => row.username === 'zhangsan')
    assert.deepEqual(mine.models.map((row) => [row.modelId, row.tokens]), [['opus', 1200], ['haiku', 50]])
    assert.equal(mine.models.reduce((sum, row) => sum + row.tokens, 0), mine.tokens, '拆分必须加得回总数')
  })

  test('按模型看：每个模型一行，带上用了它的人', async () => {
    const { usage } = await build()
    const summary = await usage.summary({ accounts: [{ username: 'zhangsan' }], group: 'model', days: 30, now: NOW })
    assert.equal(summary.group, 'model')
    assert.deepEqual(summary.models.map((row) => [row.modelId, row.tokens]), [['opus', 1206], ['haiku', 50]])
    assert.deepEqual(summary.models[0].users.map((row) => row.username), ['zhangsan', 'gone'])
    assert.equal(summary.users, undefined, '按模型看就不回 users 那一份，省得前端拿错')
  })

  test('两个维度的合计一模一样 —— 换个维度总数不能变', async () => {
    const { usage } = await build()
    const accounts = [{ username: 'zhangsan' }]
    const asUser = await usage.summary({ accounts, group: 'user', days: 30, now: NOW })
    const asModel = await usage.summary({ accounts, group: 'model', days: 30, now: NOW })
    assert.deepEqual(asUser.total, asModel.total)
    /**
     * 「用了几个模型」两页都要有。只在按模型那页算的话（`models.length`），
     * 切到按用户页时界面上那一格会凭空消失。
     */
    assert.equal(asUser.modelCount, 2)
    assert.equal(asModel.modelCount, 2)
  })

  /** 账号删了，它的账还在。藏起来只会让合计对不上 */
  test('台账里有、账号清单里没有的，标成 orphan 留在表里', async () => {
    const { usage } = await build()
    const summary = await usage.summary({ accounts: [{ username: 'zhangsan' }], days: 30, now: NOW })
    const orphan = summary.users.find((row) => row.username === 'gone')
    assert.equal(orphan.orphan, true)
    assert.equal(orphan.tokens, 6)
    assert.equal(summary.total.tokens, 1256, '合计含它 —— 那些 token 是真的花掉了')
  })

  test('按 token 降序；一样多的按名字排（顺序不能每次刷新都变）', async () => {
    const storage = createMemoryStorage()
    const usage = createUsageStore({ storage, logger: silentLogger })
    const accounts = [{ username: 'bob' }, { username: 'alice' }, { username: 'carol' }]
    await storage.usage.record({ username: 'carol', runId: 'r1', modelId: 'opus', input: 10, output: 0 })

    const summary = await usage.summary({ accounts, days: 30, now: NOW })
    assert.deepEqual(summary.users.map((row) => row.username), ['carol', 'alice', 'bob'])
  })

  test('时间窗外的行不算进来', async () => {
    const storage = createMemoryStorage()
    const usage = createUsageStore({ storage, logger: silentLogger })
    await storage.usage.record({ username: 'zhangsan', runId: 'old', input: 999, createdAt: new Date(NOW - 40 * DAY) })
    await storage.usage.record({ username: 'zhangsan', runId: 'new', input: 7, createdAt: new Date(NOW - 1 * DAY) })

    assert.equal((await usage.summary({ days: 7, now: NOW })).total.tokens, 7)
    assert.equal((await usage.summary({ days: 0, now: NOW })).total.tokens, 1006)
  })
})

describe('按天趋势', () => {
  const build = async () => {
    const storage = createMemoryStorage()
    const usage = createUsageStore({ storage, logger: silentLogger })
    const day = (iso) => new Date(`${iso}T06:00:00.000Z`)
    await storage.usage.record({ username: 'zhangsan', runId: 'r1', modelId: 'opus', input: 1000, output: 200, createdAt: day('2026-08-12') })
    await storage.usage.record({ username: 'zhangsan', runId: 'r2', modelId: 'haiku', input: 40, output: 10, createdAt: day('2026-08-13') })
    await storage.usage.record({ username: 'lisi', runId: 'r3', modelId: 'opus', input: 300, output: 60, createdAt: day('2026-08-13') })
    return usage
  }

  test('一个人：全部模型加起来，按天旧到新', async () => {
    const trend = await (await build()).trend({ username: 'zhangsan', days: 0, now: NOW })
    assert.deepEqual(trend.daily.map((row) => [row.day, row.tokens]), [['2026-08-12', 1200], ['2026-08-13', 50]])
    assert.equal(trend.total.tokens, 1250)
  })

  test('一个人 + 一个模型：只看这条线（换模型前后的对比）', async () => {
    const trend = await (await build()).trend({ username: 'zhangsan', modelId: 'opus', days: 0, now: NOW })
    assert.deepEqual(trend.daily.map((row) => [row.day, row.tokens]), [['2026-08-12', 1200]])
  })

  test('一个模型：全体用户合起来', async () => {
    const trend = await (await build()).trend({ modelId: 'opus', days: 0, now: NOW })
    assert.deepEqual(trend.daily.map((row) => [row.day, row.tokens]), [['2026-08-12', 1200], ['2026-08-13', 360]])
    assert.equal(trend.total.tokens, 1560)
  })
})

describe('数字怎么写给人看', () => {
  /**
   * 千位分隔而不是 `1.2M`：这张表是用来**对比几个人**的，缩写会把 980k 和 1.1M
   * 摆成两个看起来差不多的短字符串，而它们差一个量级。
   */
  test('token 数带千位分隔', () => {
    assert.equal(formatTokens(0), '0')
    assert.equal(formatTokens(1200), '1,200')
    assert.equal(formatTokens(1234567), '1,234,567')
    assert.equal(formatTokens(null), '0', '没有数据也要写出一个数，不能是 "null"')
  })

  test('「最近一次」：今天/昨天说人话，更早给日期', () => {
    const now = Date.now()
    assert.equal(formatSince(''), '—')
    assert.match(formatSince(new Date(now - 60 * 1000)), /^今天 \d\d:\d\d$/)
    assert.match(formatSince(new Date(now - 30 * 60 * 60 * 1000)), /^昨天 \d\d:\d\d$/)
    assert.match(formatSince(new Date(now - 10 * DAY)), /^\d+\/\d+ \d\d:\d\d$/)
  })
})
