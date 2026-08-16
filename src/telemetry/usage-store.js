/**
 * Token 用量：落库 + 给管理台的汇总。
 *
 * ── 为什么不能只靠 metrics.js ───────────────────────────────────────────
 *
 * telemetry/metrics.js 里已经有一份 `usageByUser`，但它是**进程内的 Map**：
 * 重启就没了、多副本各记一半、`/metrics.json` 上只回一个 `distinctUsers` 的计数
 * （有意的：那个端点没有鉴权，不该按人名把用量摊在外面）。
 * 管理员要问的是"这个月谁烧了多少"，那必须是落了库、跨副本、跨重启的数。
 * 所以这一层与 metrics 并存，各回答各的问题：metrics 看这一刻的健康度，
 * 这里看一段时间的账。
 *
 * ── 记账不能拖慢对话，也不能弄坏对话 ────────────────────────────────────
 *
 * `record()` **永不抛**：一次记账失败（库抖了一下）不该让一次已经成功的对话
 * 变成一条错误。写不进去的表现是那一行账不见了，而那比"模型答完了却报错"轻得多。
 * 调用方也**不 await**（见 agent/run-service.js），所以它同时也不占响应时延。
 *
 * ── 要往计费走的话，缺的是什么 ──────────────────────────────────────────
 *
 * 台账这一侧**已经够了**：最小可计价单元是「一个用户 × 一个模型 × 一天 ×
 * (input, output, cacheRead)」，`ap_usage` 每行都带着这些，而且 run_id 上有唯一键
 * （对账时不会重复计费）。三种 token 分开存也是为了这个 —— 缓存读入与新输入
 * **不同价**，合成一个数之后就再也拆不开了。
 *
 * 缺的只有**单价**，而单价不该由这一层猜：它是一张随时间变的表（谁的价、什么币种、
 * 哪天生效、有没有阶梯），要么来自平台的模型清单，要么来自一份配置。真要接的时候，
 * 成本 = Σ(每个模型的 input/output/cacheRead × 该模型当期单价)，用的就是
 * `summary({ group: 'model' })` 已经算出来的那几个数，不必再动这里的聚合。
 *
 * ── 单价现在接上了（`prices` 参数）────────────────────────────────────
 *
 * 上面那段话仍然成立，而且是照着做的：单价来自**模型配置**（管理员在控制台填，
 * 见 models/model-store.js），由调用方查好了传进来；折算那一步整个住在
 * telemetry/pricing.js 里，**这一层的聚合一行没动**。不传 `prices` 时行为与从前
 * 完全一致（没有 cost 字段），所以 LLM_MODE 不是 db 的部署不受影响。
 *
 * 折算本身的三条边界（没有价格历史 / 未定价不等于 0 / 压缩的 token 不在账上）
 * 写在 pricing.js 的文件头，不在这儿重复。
 *
 * ⚠️ 另外一句必须写明白：**这不是账单，是可归因的用量。** 计费的真源在模型网关
 * （llm_requests 表）—— 那边记的是它真的向上游发了什么。这张表记的是我们这边
 * 看到的用量，两者在正常情况下相等，但网关重试、上游改价、我们这边进程被 kill
 * 掉的那一瞬间都会让它们差一点。对外收钱要以网关那份为准。
 */

import { PAGE_DEFAULT, decodeCursor, encodeCursor, finishPage } from '../persistence/page.js'

import { costOf, costOfRows, priceRow, round } from './pricing.js'

/** 时间窗的上限：一年。再往前的账翻起来意义不大，而无上限等于允许一次全表扫 */
const MAX_DAYS = 365

/**
 * 一行最多带几个 children。
 *
 * 只有**按模型看**那一页真的需要这个上限：那一页的 children 是"用了这个模型的人"，
 * 会跟着人数涨，而它是内嵌在每一行里下发的 —— 也就是说光把行分页并不能把
 * 响应体收住，一个被所有人使用的模型自己就能拖回整个用户表。
 *
 * 按用户看那一页不受影响（children 是"他用过的模型"，本来就是十几个的量级），
 * 但也走同一个上限：两边不同的话，`childrenTruncated` 这个标记在哪一页上会出现
 * 就成了要去查代码才知道的事。
 */
const CHILD_MAX = 20

/**
 * idle 段最多探几页账号。见 summary 里那一段 —— 它挡的是"绝大多数账号都有用量"
 * 时，为了凑满一页而无限翻账号表。
 */
const IDLE_PROBE_MAX = 10

/**
 * 用量表的游标。三段：
 *
 *   used   有台账记录的人，按 token 降序（`t` 是 token 数，`u` 是决胜的用户名）
 *   idle   台账里一行都没有的账号，按用户名升序（`u` 是上一页最后一个用户名）
 *   model  按模型看那一页（`t` + 决胜的模型 id `m`）
 *
 * 为什么用户维要分成两段：这张表以**账号**为准做左连接（没跑过任何 run 的人
 * 也要有一行 0，否则"这个人没用过"和"这个人不存在"在界面上长得一样），
 * 而那两拨人住在两张表里、按两个不同的键排序。合成一条 SQL 要跨 ap_usage 和
 * ap_kv 做 LEFT JOIN —— 那等于让用量这一层知道账号存在哪张表里，
 * 而它现在连这件事都不需要知道（账号是调用方以回调的形式传进来的）。
 */
const validCursor = (value) => ['used', 'idle', 'model'].includes(value.s)

/**
 * `days` 收口成一个 Date（或 null=不限时间）。
 *
 * `days=0` 明确表示"全部"，而不是"最近 0 天" —— 界面上那个「全部」选项就是它。
 * 非法输入（负数、NaN、'; DROP TABLE'）一律退回默认 30 天，不报错：
 * 这是个查询参数，为它回一条 400 只是让人多点一次。
 *
 * ⚠️ **"0"和"没传"必须分开判。** `Number(null)` 和 `Number('')` 都是 0，
 * 而 `searchParams.get('days')` 在参数缺席时回的正是 null ——
 * 只判 `=== 0` 的话，一次不带参数的 `GET /v1/admin/usage` 会被当成"要全部历史"，
 * 于是最常走的那条路径悄悄变成了一次全表扫。
 */
export function resolveSince(days, { now = Date.now(), fallback = 30 } = {}) {
  const text = String(days ?? '').trim()
  const raw = text ? Number(text) : NaN
  if (raw === 0) return null
  const window = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_DAYS) : fallback
  return new Date(now - window * 24 * 60 * 60 * 1000)
}

/** 一组汇总行的合计。界面顶上那一行"本部署总计"用它，不再各自加一遍 */
export function sumBuckets(rows) {
  const total = { runs: 0, input: 0, output: 0, cacheRead: 0, tokens: 0 }
  for (const row of rows) {
    total.runs += row.runs || 0
    total.input += row.input || 0
    total.output += row.output || 0
    total.cacheRead += row.cacheRead || 0
  }
  /**
   * `tokens` = input + output，**不含 cacheRead**。
   *
   * 缓存读入是另一档计价（便宜一个数量级），加进总数会让"总用量"这个数字
   * 既不等于花的钱、也不等于模型看的字数 —— 两头都对不上。所以单列。
   */
  total.tokens = total.input + total.output
  return total
}

/** 给每一行补上 `tokens`，口径与 sumBuckets 一致（前端不再自己加） */
const withTokens = (rows) => rows.map((row) => ({ ...row, tokens: (row.input || 0) + (row.output || 0) }))

/** 大的在前；一样多的按名字，否则每次刷新的顺序都可能不一样 */
const byTokensThen = (key) => (a, b) => b.tokens - a.tokens || (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0)

/**
 * 把「用户 × 模型」的明细行按 `dimension` 归堆，供上层挂到对应的行下面。
 *
 * ── 它替掉的是从前那个 pivot() ──────────────────────────────────────────
 *
 * pivot 做两件事：归堆 children，**顺带把父行的数也加出来**。那在"一次把整张
 * 交叉表捞回来"的年代是对的 —— 父行的数除了从 children 加，没有别的来源。
 *
 * 分页之后父行的数来自 SQL 的聚合（`topUsers` / `byModel`），是**全窗口**的口径；
 * 而 children 可能是截断过的（见 CHILD_MAX）。这时候再去从 children 加一遍父行，
 * 加出来的会是一个偏小、且看起来很正常的数字。所以这个函数只归堆，不求和 ——
 * 父行的数只有一个来源，也就不存在两个来源对不上的可能。
 *
 * @param {string} dimension 归堆用的键（'username' 或 'modelId'）
 * @param {string} other     另一维，写进每个 child 里
 * @returns {Map<string, object[]>} 每堆内部按 token 降序（同数按名字）
 */
export function groupChildren(rows, dimension, other) {
  const out = new Map()
  for (const row of rows || []) {
    const list = out.get(row[dimension]) || []
    list.push({
      [other]: row[other],
      runs: row.runs || 0,
      input: row.input || 0,
      output: row.output || 0,
      cacheRead: row.cacheRead || 0,
      lastAt: row.lastAt || null,
      tokens: (row.input || 0) + (row.output || 0),
    })
    out.set(row[dimension], list)
  }
  for (const list of out.values()) list.sort(byTokensThen(other))
  return out
}

export function createUsageStore({ storage = null, logger = console } = {}) {
  const ledger = storage?.usage || null

  /**
   * 按模型看的那一页。
   *
   * 行来自 `byModel()`，**已经全取回来了**（行数 = 窗口里出现过的模型数，有界，
   * 而且合计和计价本来就要用它），所以这里在内存里按游标切一段就够 ——
   * 再往数据库跑一趟只是重复同一个聚合。
   *
   * children 就完全不一样了：那是"用了这个模型的人"，跟着人数涨。它走
   * `topUsersPerModel()` 一个有界的 top-N 查询，多取一条用来判断截没截断。
   */
  async function modelPage({ modelRows, since, prices, cursor, limit }) {
    const from = cursor?.s === 'model'
      ? { tokens: Number(cursor.t) || 0, modelId: String(cursor.u || '') }
      : null
    // modelRows 已经是 (tokens 降序, modelId 升序)，过滤保序，不必重排
    const rest = from
      ? modelRows.filter((row) => row.tokens < from.tokens
        || (row.tokens === from.tokens && row.modelId > from.modelId))
      : modelRows
    // 这个游标要交给浏览器，所以在这里编码（finishPage 只算，不编码）
    const { page, hasMore, nextCursor } = finishPage(
      rest.slice(0, limit + 1),
      limit,
      (row) => encodeCursor({ s: 'model', t: row.tokens, u: row.modelId }),
    )

    const kids = page.length
      ? await ledger.topUsersPerModel({ since, modelIds: page.map((row) => row.modelId), limit: CHILD_MAX + 1 })
      : []
    const grouped = groupChildren(kids, 'modelId', 'username')
    const models = page.map((row) => {
      const all = grouped.get(row.modelId) || []
      /**
       * 截断只影响**展示的那一串人**，不影响这一行的钱：按模型看时
       * `priceRow` 的金额是从行自己的 token 数乘出来的（一行一个模型一个价），
       * 与列了几个人无关。所以先截断再计价是安全的 —— 按用户看那一页不是这样，
       * 见 decorateUsed。
       */
      const withKids = {
        ...row,
        users: all.slice(0, CHILD_MAX),
        usersTruncated: all.length > CHILD_MAX,
      }
      return prices ? priceRow(withKids, prices, 'users') : withKids
    })
    // 只回 models 这一份，不带一个空的 users —— 前端就不可能拿错那一维
    return { models, hasMore, nextCursor }
  }

  /** 台账里有记录的那些人 → 界面上的一行（补上 role / disabled / children） */
  async function decorateUsed(rows, { since, prices, accounts }) {
    if (!rows.length) return []
    const names = rows.map((row) => row.username)
    const [kids, known] = await Promise.all([
      ledger.byUserAndModel({ since, usernames: names }),
      accounts?.many ? accounts.many(names) : Promise.resolve([]),
    ])
    const grouped = groupChildren(kids, 'username', 'modelId')
    const info = new Map(known.map((account) => [account.username, account]))

    return rows.map((row) => {
      const all = grouped.get(row.username) || []
      /**
       * ⚠️ **先计价，再截断。**
       *
       * 按用户看时这一行的钱是从 children 加出来的（各模型单价不同，见
       * pricing.priceRow），所以拿截断后的 children 去算，会得到一个偏小、
       * 却看起来完全正常的金额 —— pricing.js 文件头把这类错单列了一条。
       * children 这一维本来就有界（一个部署里的模型是十几个），
       * 真的截断是极端情况，但金额不能赌它不发生。
       */
      const priced = prices
        ? priceRow({ ...row, models: all }, prices, 'models')
        : { ...row, models: all }
      const account = info.get(row.username)
      return {
        ...priced,
        // 账号已经不在、账还留着：标出来。藏起来只会让合计对不上
        ...(account ? { role: account.role || 'user', disabled: Boolean(account.disabled) } : { role: '', disabled: false, orphan: true }),
        models: priced.models.slice(0, CHILD_MAX),
        modelsTruncated: priced.models.length > CHILD_MAX,
      }
    })
  }

  /**
   * 按用户看的那一页。**跨两段拼出来**（见文件上方 validCursor 那段的说明）：
   *
   *   used  台账里有记录的人，token 降序
   *   idle  台账里一行都没有的账号，用户名升序，各补一行 0
   *
   * 两段在**同一次请求里接上**，而不是让 used 段走完之后回一页空的 ——
   * 用户点"加载更多"点出一页空白，看起来就是坏了。
   */
  async function userPage({ accounts, since, prices, cursor, limit }) {
    /**
     * 没跑过任何 run 的账号补的那一行零。
     *
     * 计价开着时它的 `cost` 是 **0 而不是 null**：这个人确实一分钱没花，
     * 那是一个已知的事实，不是"不知道多少钱"。反过来写成 null，界面上
     * 就会给一排从没用过的账号标"未定价"，而那与单价填没填毫无关系。
     */
    const blank = {
      runs: 0, input: 0, output: 0, cacheRead: 0, tokens: 0, lastAt: null,
      models: [], modelsTruncated: false,
      ...(prices ? { cost: 0, costPartial: false, unpricedModels: [] } : {}),
    }

    // 多凑一条，最后交给 finishPage 判断"还有没有下一页"
    const target = limit + 1
    const out = []
    let state = cursor?.s === 'used' || cursor?.s === 'idle' ? cursor : { s: 'used' }
    let probes = 0

    while (out.length < target) {
      const need = target - out.length

      if (state.s === 'used') {
        const from = state.t === undefined || state.t === null
          ? null
          : { tokens: Number(state.t) || 0, username: String(state.u || '') }
        // 存储层自己会多取一条，所以 rows.length > need 才表示这一段还没完
        const rows = await ledger.topUsers({ since, cursor: from, limit: need })
        const got = rows.slice(0, need)
        for (const row of await decorateUsed(got, { since, prices, accounts })) {
          out.push({ row, cursor: { s: 'used', t: row.tokens, u: row.username } })
        }
        if (rows.length > need) break
        // 这一段翻完了，接着翻另一段
        state = { s: 'idle', u: '' }
        continue
      }

      /* ── idle 段 ── */
      if (!accounts?.page) break
      probes += 1
      const probe = await accounts.page({ cursor: String(state.u || ''), limit: need })
      /**
       * 这一批账号里，哪些在窗口内有台账记录 —— 有的已经在 used 段出现过了，
       * 这里必须跳过，否则同一个人会出现两次。
       *
       * 判据是"有没有台账行"，而不是"token 是不是 0"：一个只产生过缓存读入的人
       * token 是 0，但他在 used 段里（那一段不筛 token），漏判就会重复。
       */
      const names = probe.items.map((item) => item.username)
      const seen = new Set((await ledger.byUserAndModel({ since, usernames: names })).map((row) => row.username))
      for (const account of probe.items) {
        if (seen.has(account.username)) continue
        out.push({
          row: {
            username: account.username,
            role: account.role || 'user',
            disabled: Boolean(account.disabled),
            ...blank,
          },
          cursor: { s: 'idle', u: account.username },
        })
      }

      if (!probe.hasMore) break
      state = { s: 'idle', u: probe.nextCursor }
      /**
       * 这一页凑不满就再探一页账号 —— 但**探的次数要有上限**。
       *
       * 极端情况是"几乎所有账号在这个窗口里都有用量"：那时候每探一页账号
       * 几乎全被上面那句 `seen.has` 滤掉，为了凑满 50 行可以一直探到账号表末尾，
       * 而那正是这次改动要消灭的东西。探满 IDLE_PROBE_MAX 次就带着现有的行返回，
       * `hasMore` 照实回 true —— 一页短一点是可以接受的，一次请求把全表翻一遍不是。
       */
      if (probes >= IDLE_PROBE_MAX) {
        return {
          users: out.slice(0, limit).map((item) => item.row),
          hasMore: true,
          nextCursor: encodeCursor(out.length > limit ? out[limit - 1].cursor : state),
        }
      }
    }

    const { page, hasMore, nextCursor } = finishPage(out, limit, (item) => encodeCursor(item.cursor))
    return { users: page.map((item) => item.row), hasMore, nextCursor }
  }

  return {
    /** 没有台账能力时整块关掉：接口回 `enabled: false`，界面画一句说明而不是空表 */
    enabled: Boolean(ledger),

    /**
     * 记一次 run 的用量。不抛、不需要 await。
     *
     * 只在 run **成功跑完**时调用（失败的 run 没有可归因的用量：模型要么没被调到，
     * 要么调用本身就失败了，网关那边也不会计费）。
     */
    async record(row) {
      if (!ledger || !row?.username || !row?.runId) return false
      // 一次都没花 token 的 run 不记（faux 模型、纯工具轮）：记了只是给账上添零行
      if (!(row.input || row.output || row.cacheRead)) return false
      try {
        await ledger.record(row)
        return true
      } catch (error) {
        logger.warn?.('token 用量落库失败，这一行账丢了', {
          username: row.username, runId: row.runId, err: error?.message,
        })
        return false
      }
    },

    /**
     * 管理台总表，**一页一页地取**。两个视图：
     *
     *   group='user'   每个账号一行，`models` 是他用过的模型
     *   group='model'  每个模型一行，`users` 是用了它的人
     *
     * 两个方向都要有，因为要问的是两个问题：分账时问"这个人该付多少"，
     * 选型和定价时问"这个模型吃掉了多少"。
     *
     * ── 从"一次查完再在 Node 里 pivot"改成分页，改了什么 ──────────────────
     *
     * 从前这里是一句 `byUserAndModel({ since })`：把窗口内**全部**的
     * (用户 × 模型) 组合捞回来，在 JS 里 pivot、排序、再和**全部账号**做左连接。
     * 行数跟着人数涨，而管理员点开这一页要等的就是它 —— 而且那份等待会
     * 随时间线性变长，上线时完全看不出来。
     *
     * 现在：
     *   - **行**按需取。用户维走 `ledger.topUsers()`（聚合上的 keyset 翻页），
     *     模型维走 `ledger.byModel()`（行数天然有界，在这里切片）。
     *   - **children** 只给这一页的行取，各自有界（见 CHILD_MAX）。
     *   - **合计仍然是全局的**，见下面 `byModel` 那一段。
     *
     * ── 合计为什么还是准的 ──────────────────────────────────────────────
     *
     * `total` / `pricing` / `modelCount` 全部从 `ledger.byModel()` 那一个查询来。
     * 台账里**每一行都带 model_id**，所以"按模型分组求和"加起来就是全窗口的总量 ——
     * 不是这一页的总量。这一点必须是这样：一张"合计只算了当前这一页"的用量表
     * 会让管理员每翻一页看到一个不同的总数，而他没有任何办法看出哪个是对的。
     *
     * 顺带的好处是那一个查询同时喂了三件事（合计、计价、按模型看的那一页），
     * 于是它们之间**不可能对不上**。
     *
     * @param {object} params.accounts 账号侧的两个回调 —— `page({cursor, limit})`
     *   与 `many(usernames)`。**传的是回调而不是账号数组**：数组的写法要求调用方
     *   先把全部账号取出来，而那正是这次要消灭的东西。用回调也让这一层
     *   继续不知道账号存在哪张表里（合成一条跨表 LEFT JOIN 就得知道了）。
     * @param {string} [params.cursor] 上一页回的 nextCursor
     * @returns {Promise<object>} 除了原有字段，多 `hasMore` / `nextCursor`
     */
    async summary({
      accounts = null, days = 30, group = 'user', prices = null, currency = '',
      now = Date.now(), cursor: rawCursor = '', limit: rawLimit = PAGE_DEFAULT,
    } = {}) {
      const since = resolveSince(days, { now })
      const view = group === 'model' ? 'model' : 'user'
      const limit = Math.max(1, Math.floor(Number(rawLimit) || PAGE_DEFAULT))
      if (!ledger) {
        return {
          enabled: false, group: view, since: null, users: [], models: [],
          modelCount: 0, userCount: 0, total: sumBuckets([]), hasMore: false, nextCursor: '',
        }
      }

      /**
       * 一个有界的查询（每个模型一行），同时承担全局合计、计价、以及按模型看的那一页。
       *
       * 未定价清单也从这里收，而不是从拼好的行里收：后者含补零的账号行，
       * 会把"从来没用过任何模型"的人也算成一次未定价。
       */
      const [modelRows, userCount] = await Promise.all([
        ledger.byModel({ since }),
        ledger.countActiveUsers({ since }),
      ])
      const money = prices ? costOfRows(modelRows, prices) : null
      const base = {
        enabled: true,
        group: view,
        since: since ? since.toISOString() : null,
        /**
         * 计价这一块整体开不开。关着的时候界面上一列金额都不画 ——
         * 画一列全是"—"只会让人以为是数据没加载出来。
         */
        pricing: money
          ? {
            enabled: true,
            currency,
            cost: money.cost,
            /** 有一部分模型没定价：这个金额是**偏小**的，界面必须说出来 */
            partial: money.partial,
            unpricedModels: money.unpriced,
          }
          : { enabled: false },
        /** ⚠️ 全窗口的合计，不是这一页的 —— 见方法头 */
        total: sumBuckets(modelRows),
        /**
         * 这个窗口里出现过几个模型。**两个视图都回**：按用户看的时候，
         * "这段时间在用几个模型"同样是管理员要知道的一个数，
         * 而那一页的行是按人分的，自己数不出来。
         */
        modelCount: modelRows.length,
        /**
         * 这个窗口里有几个人产生过用量。与 modelCount 同一个理由 ——
         * 表头那句"N 人在用"从前是数 `users.filter(tokens > 0).length`，
         * 分页之后那会变成"当前加载了几行"，每点一次加载更多就涨一截。
         */
        userCount,
      }

      const cursor = decodeCursor(rawCursor, validCursor)

      if (view === 'model') return { ...base, ...await modelPage({ modelRows, since, prices, cursor, limit }) }
      return { ...base, ...await userPage({ accounts, since, prices, cursor, limit }) }
    },

    /**
     * 点开一行看趋势。
     *
     * 两种点开法共用这一个入口：
     *   { username }            这个人所有模型加起来的按天曲线
     *   { username, modelId }   这个人在这个模型上的按天曲线（换模型前后的对比）
     *   { modelId }             这个模型全体用户的按天曲线
     *
     * 按模型/按人的**汇总**不在这儿 —— 它已经在 summary 的每一行里带下来了，
     * 展开时不必再打一次接口（也就不会出现"表里 450,092、展开后 450,091"这种）。
     */
    async trend({ username = '', modelId = '', days = 30, prices = null, currency = '', now = Date.now() } = {}) {
      const since = resolveSince(days, { now })
      const scope = { username, modelId, since: null }
      if (!ledger) return { enabled: false, ...scope, daily: [], total: sumBuckets([]) }

      /**
       * 三种口径里，只有"一个人的全部模型"这一种需要**多查一维**。
       *
       * 另外两种（钉死了模型的）一整条曲线共用一个单价，直接乘就行；而这一种
       * 每天可能混着好几个模型，一天的合计 token 里拆不出各自是谁的
       * —— 所以计价开着时改走 `dailyForUserByModel`，按天折之前先把钱算完。
       * 计价关着时仍然走原来那条查询：多带一维只会让行数变多而没有任何用处。
       */
      const perModel = Boolean(prices) && Boolean(username) && !modelId
      const raw = perModel
        ? await ledger.dailyForUserByModel({ username, since })
        : username
          ? await ledger.dailyForUser({ username, modelId, since })
          : await ledger.dailyForModel({ modelId, since })

      const daily = perModel ? foldByDay(raw, prices) : withTokens(raw)
      /**
       * 合计从**日行**加，而不是把全窗口的 token 再乘一次价。
       *
       * 两种算法在数学上相等，但只有前者保证"上面那个总数 = 下面这些日子加起来"。
       * 各算各的话，四舍五入会让它们差几分钱，而一张自己加不起来的表
       * 会让人怀疑的是整个数据，不是最后一位小数。
       */
      const priceOfRow = modelId ? prices?.get?.(modelId) : null
      const withCost = prices && !perModel
        ? daily.map((row) => ({ ...row, cost: costOf(row, priceOfRow) }))
        : daily
      return {
        enabled: true,
        username,
        modelId,
        since: since ? since.toISOString() : null,
        total: sumBuckets(daily),
        ...(prices ? { pricing: rollupDaily(withCost, currency) } : {}),
        daily: withCost,
      }
    },
  }
}

/**
 * 「一天 × 一个模型」的行 → 一天一行，钱在折之前就按各自的单价算完。
 *
 * 这是"一个人每天花多少"唯一算得对的顺序：先按模型乘价、再按天加。
 * 反过来（先把一天的 token 加起来再乘一个价）要么得挑一个模型的价来代表全天，
 * 要么得编一个平均价 —— 两者都是在造数字。
 *
 * 一天里只要有一个模型没定价，这一天就 `costPartial: true`：那天的金额是
 * **偏小**的，而在一条曲线上，偏小的那几个点看起来只是"那天用得少"。
 */
function foldByDay(rows, prices) {
  const days = new Map()
  for (const row of rows) {
    const current = days.get(row.day)
      || { day: row.day, runs: 0, input: 0, output: 0, cacheRead: 0, cost: null, costPartial: false }
    current.runs += row.runs || 0
    current.input += row.input || 0
    current.output += row.output || 0
    current.cacheRead += row.cacheRead || 0
    const amount = costOf(row, prices?.get?.(row.modelId))
    if (amount === null) {
      if (row.input || row.output || row.cacheRead) current.costPartial = true
    } else {
      current.cost = round((current.cost || 0) + amount)
    }
    days.set(row.day, current)
  }
  return withTokens([...days.values()]).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
}

/** 一条曲线的金额合计。口径与 foldByDay 一致：日行加起来，缺一天就是缺一天 */
function rollupDaily(daily, currency) {
  let total = 0
  let known = 0
  let partial = false
  for (const row of daily) {
    if (row.costPartial) partial = true
    if (typeof row.cost !== 'number') {
      if (row.input || row.output || row.cacheRead) partial = true
      continue
    }
    total += row.cost
    known += 1
  }
  return { enabled: true, currency, cost: known ? round(total) : null, partial }
}
