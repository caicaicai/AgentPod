/**
 * 用量 → 金额的折算。
 *
 * 这一组测的全部是**"未知"不能被当成 0** 的各种形态。算术本身（token × 单价 ÷ 百万）
 * 一眼就能验，真正会出错、且出错之后没人看得出来的是另一件事：
 *
 *   一个没定价的模型，如果在某一步被悄悄当成 0 元，那么整张账单会**偏小** ——
 *   而偏小的账单不会有人来质疑。它和"这个月大家用得少"长得一模一样。
 *
 * 所以下面每一条用例的断言重点都不是那个数字，而是 `null` / `partial` /
 * `unpriced` 这三个标记有没有一路传到头。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { costOf, costOfRows, priceRow, round } from '../src/telemetry/pricing.js'
import { createUsageStore } from '../src/telemetry/usage-store.js'
import { createModelStore } from '../src/models/model-store.js'
import { createMemoryStorage } from './helpers/memory-storage.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

/** 每百万：输入 3、输出 15、缓存读入 0.3 —— 一个当代模型的典型价位 */
const SONNET = { input: 3, output: 15, cacheRead: 0.3 }

describe('单次折算', () => {
  test('三档各自乘各自的价，单位是每百万', () => {
    // 1M × 3 + 100k × 15 + 2M × 0.3 = 3 + 1.5 + 0.6
    const amount = costOf({ input: 1_000_000, output: 100_000, cacheRead: 2_000_000 }, SONNET)
    assert.equal(amount, 5.1)
  })

  /**
   * 这一条是整个模块存在的理由。
   *
   * 没有单价 = **算不出来**，不是"零元"。回 0 的话，一个忘了填价的模型会让
   * 它那部分用量在账单上彻底消失，而页面上没有任何地方看得出少了东西。
   */
  test('没有单价回 null，不是 0', () => {
    assert.equal(costOf({ input: 1_000_000, output: 1_000_000 }, null), null)
    assert.equal(costOf({ input: 1_000_000, output: 1_000_000 }, undefined), null)
  })

  /**
   * 反过来，**填了 0 就是真的免费**（自建模型、包月的私有部署）。
   * 它必须与"没填"分开 —— 合成一个值的话，这两句完全不同的话在账单上一模一样。
   */
  test('单价填 0 = 免费，算出来是 0（而不是"未定价"）', () => {
    const amount = costOf({ input: 9_999_999, output: 9_999_999 }, { input: 0, output: 0, cacheRead: 0 })
    assert.equal(amount, 0)
  })

  test('浮点尾巴收掉 —— 累加几千行之后它会长出一串 0000004', () => {
    assert.equal(round(0.1 + 0.2), 0.3)
  })
})

describe('多行汇总', () => {
  const rows = [
    { modelId: 'sonnet', input: 1_000_000, output: 100_000, cacheRead: 0 },
    { modelId: 'mystery', input: 5_000_000, output: 500_000, cacheRead: 0 },
  ]
  const prices = new Map([['sonnet', SONNET]])

  test('未定价的那一行被点名，而不是被当 0 加进去', () => {
    const out = costOfRows(rows, prices)
    assert.equal(out.cost, 4.5) // 只有 sonnet 那一行
    assert.equal(out.partial, true)
    assert.deepEqual(out.unpriced, ['mystery'])
  })

  test('一条都定不了价时回 null —— "不要钱"和"不知道多少钱"必须分开', () => {
    const out = costOfRows(rows, new Map())
    assert.equal(out.cost, null)
    assert.equal(out.partial, false) // 一条都算不出来，没有"部分"可言
    assert.deepEqual(out.unpriced, ['sonnet', 'mystery'].sort())
  })

  /**
   * 补零行（账号存在但没跑过任何 run）**不算"未定价"**。
   *
   * 它没有任何成本要算，点名它只会让界面上凭空多出一串"这些模型没定价"，
   * 而管理员照着去填价时会发现那些模型根本没人用过。
   */
  test('0 token 的补零行不算未定价', () => {
    const out = costOfRows([{ modelId: 'zero', input: 0, output: 0, cacheRead: 0 }], new Map())
    assert.deepEqual(out.unpriced, [])
  })
})

describe('两个视图的行', () => {
  const prices = new Map([['sonnet', SONNET]])

  test('按用户看：每个模型各自查价，行是它们的和', () => {
    const row = priceRow({
      username: 'zhangsan',
      models: [
        { modelId: 'sonnet', input: 1_000_000, output: 0, cacheRead: 0 },
        { modelId: 'mystery', input: 1_000_000, output: 0, cacheRead: 0 },
      ],
    }, prices, 'models')

    assert.equal(row.models[0].cost, 3)
    assert.equal(row.models[1].cost, null)
    assert.equal(row.cost, 3)
    assert.equal(row.costPartial, true)
    assert.deepEqual(row.unpricedModels, ['mystery'])
  })

  test('按模型看：整行一个价，每个使用者用同一个', () => {
    const row = priceRow({
      modelId: 'sonnet',
      input: 2_000_000,
      output: 0,
      cacheRead: 0,
      users: [
        { username: 'a', input: 1_500_000, output: 0, cacheRead: 0 },
        { username: 'b', input: 500_000, output: 0, cacheRead: 0 },
      ],
    }, prices, 'users')

    assert.equal(row.cost, 6)
    // 行的金额必须等于它 children 的和 —— 对不上的表就没人信了
    assert.equal(round(row.users[0].cost + row.users[1].cost), row.cost)
  })

  test('按模型看：这个模型没定价，整行连同每个使用者都是未定价', () => {
    const row = priceRow({
      modelId: 'mystery',
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      users: [{ username: 'a', input: 1_000_000, output: 0, cacheRead: 0 }],
    }, prices, 'users')

    assert.equal(row.cost, null)
    assert.equal(row.users[0].cost, null)
    assert.deepEqual(row.unpricedModels, ['mystery'])
  })
})

describe('模型配置里的单价', () => {
  const newStore = () => createModelStore({ storage: createMemoryStorage(), logger: silent })
  const base = { name: 'S', model: 'sonnet', baseUrl: 'https://x/v1' }

  test('不填 = 未定价（null），不是 0', async () => {
    const store = newStore()
    const model = await store.create(base)
    assert.equal(model.priceInput, null)
    assert.equal(model.priced, false)
    // 价目表里干脆没有它 —— 于是折算那一层自然回 null
    assert.equal((await store.prices()).size, 0)
  })

  test('填了就进价目表，键是发给上游的那个 model 名（台账按它记账）', async () => {
    const store = newStore()
    await store.create({ ...base, priceInput: 3, priceOutput: 15, priceCacheRead: 0.3 })
    const prices = await store.prices()
    assert.deepEqual(prices.get('sonnet'), SONNET)
  })

  /**
   * 只填一半是合法的（有些上游不单独计缓存读入），但要**标出来** ——
   * 没填的那一档按 0 计，成本因此偏小，而界面必须有依据写那句提示。
   */
  test('只填一部分：算得出价，但标成"不完整"', async () => {
    const store = newStore()
    const model = await store.create({ ...base, priceInput: 3, priceOutput: 15 })
    assert.equal(model.priced, true)
    assert.equal(model.priceComplete, false)
    assert.equal((await store.prices()).get('sonnet').cacheRead, 0)
  })

  test('停用的模型也要有价 —— 它过去的用量还在账上', async () => {
    const store = newStore()
    const model = await store.create({ ...base, priceInput: 3, priceOutput: 15, enabled: false })
    assert.equal(model.enabled, false)
    assert.ok((await store.prices()).has('sonnet'))
  })

  /**
   * 单价填错**抛错而不是兜底**。
   *
   * 其余字段兜底是因为兜错了顶多行为不对；单价兜错了会把一条模型从"定价 3 元"
   * 悄悄变成"未定价"，而账单上少一块钱谁也不会去查配置。
   */
  test('负数、非数字、以及"当成每 token 填"的那种量级，都当场报错', async () => {
    const store = newStore()
    await assert.rejects(() => store.create({ ...base, priceInput: -1 }), /不能是负数/)
    await assert.rejects(() => store.create({ ...base, priceInput: 'abc' }), /必须是数字/)
    // 每百万 3 元的模型，按每 token 填就是 0.000003；反过来填成 3000000 是同一类手滑
    await assert.rejects(() => store.create({ ...base, priceInput: 3_000_000 }), /每百万/)
  })

  test('改的时候不传单价 = 不动它（PATCH 的常规语义）', async () => {
    const store = newStore()
    const created = await store.create({ ...base, priceInput: 3, priceOutput: 15 })
    const updated = await store.update(created.id, { contextWindow: 200000 })
    assert.equal(updated.priceInput, 3)
    assert.equal(updated.priceOutput, 15)
  })

  test('传空串 = 撤销定价，回到"未定价"', async () => {
    const store = newStore()
    const created = await store.create({ ...base, priceInput: 3, priceOutput: 15 })
    const updated = await store.update(created.id, { priceInput: '', priceOutput: '' })
    assert.equal(updated.priceInput, null)
    assert.equal(updated.priced, false)
  })
})

describe('汇总接口带上金额', () => {
  async function seed() {
    const storage = createMemoryStorage()
    const models = createModelStore({ storage, logger: silent })
    await models.create({ name: 'S', model: 'sonnet', baseUrl: 'https://x/v1', priceInput: 3, priceOutput: 15, priceCacheRead: 0.3 })
    await models.create({ name: 'M', model: 'mystery', baseUrl: 'https://x/v1' })

    const usage = createUsageStore({ storage, logger: silent })
    await usage.record({ username: 'zhangsan', runId: 'r1', modelId: 'sonnet', input: 1_000_000, output: 100_000, cacheRead: 0 })
    await usage.record({ username: 'zhangsan', runId: 'r2', modelId: 'mystery', input: 1_000_000, output: 0, cacheRead: 0 })
    return { usage, prices: await models.prices() }
  }

  test('不传 prices 时形状与从前完全一致 —— 没配价的部署不受影响', async () => {
    const { usage } = await seed()
    const summary = await usage.summary({ accounts: [{ username: 'zhangsan' }] })
    assert.equal(summary.pricing.enabled, false)
    assert.equal('cost' in summary.users[0], false)
  })

  test('传了就每行带金额，未定价的模型点名回来', async () => {
    const { usage, prices } = await seed()
    const summary = await usage.summary({ accounts: [{ username: 'zhangsan' }], prices, currency: 'USD' })

    assert.equal(summary.pricing.enabled, true)
    assert.equal(summary.pricing.currency, 'USD')
    assert.equal(summary.pricing.cost, 4.5)
    assert.equal(summary.pricing.partial, true)
    assert.deepEqual(summary.pricing.unpricedModels, ['mystery'])
    assert.equal(summary.users[0].cost, 4.5)
    assert.equal(summary.users[0].costPartial, true)
  })

  /**
   * 从没跑过 run 的账号，金额是 **0 而不是"未定价"**。
   *
   * 他确实一分钱没花，那是个已知的事实。写成 null 的话，一排从没用过的账号
   * 会被标上"未定价"，而那与单价填没填毫无关系 —— 管理员会去翻模型配置找问题。
   */
  test('补零的账号金额是 0，不是"未定价"', async () => {
    const { usage, prices } = await seed()
    const summary = await usage.summary({
      accounts: [{ username: 'zhangsan' }, { username: 'lisi' }],
      prices,
      currency: 'USD',
    })
    const lisi = summary.users.find((row) => row.username === 'lisi')
    assert.equal(lisi.cost, 0)
    assert.equal(lisi.costPartial, false)
  })

  test('两个视图的合计相等 —— 它们是同一份交叉表的转置', async () => {
    const { usage, prices } = await seed()
    const byUser = await usage.summary({ accounts: [{ username: 'zhangsan' }], prices, group: 'user' })
    const byModel = await usage.summary({ accounts: [{ username: 'zhangsan' }], prices, group: 'model' })
    assert.equal(byUser.pricing.cost, byModel.pricing.cost)
  })

  /**
   * 「一个人每天花多少」是唯一需要**多查一维**的口径：一天里混着好几个模型，
   * 从当天的合计 token 里再也拆不出各自是谁的。先按模型乘价、再按天加，
   * 是这条曲线唯一算得对的顺序。
   */
  test('按天曲线：先按模型乘价再按天加，混着未定价的那天标 partial', async () => {
    const { usage, prices } = await seed()
    const trend = await usage.trend({ username: 'zhangsan', prices, currency: 'USD' })

    assert.equal(trend.daily.length, 1)
    assert.equal(trend.daily[0].cost, 4.5) // 只有 sonnet 那部分
    assert.equal(trend.daily[0].costPartial, true)
    // 合计从日行加起来 —— 表必须自己加得起来
    assert.equal(trend.pricing.cost, 4.5)
    assert.equal(trend.pricing.partial, true)
  })

  test('钉死了模型的曲线：一个价管到底', async () => {
    const { usage, prices } = await seed()
    const trend = await usage.trend({ username: 'zhangsan', modelId: 'sonnet', prices, currency: 'USD' })
    assert.equal(trend.daily[0].cost, 4.5)
    assert.equal(trend.pricing.partial, false)
  })
})
