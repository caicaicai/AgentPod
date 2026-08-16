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

import { costOf, costOfRows, priceRow, round } from './pricing.js'

/** 时间窗的上限：一年。再往前的账翻起来意义不大，而无上限等于允许一次全表扫 */
const MAX_DAYS = 365

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
 * 把「用户 × 模型」的交叉表按某一维折叠起来。
 *
 * `dimension` 是要留下的那一维（'username' 或 'modelId'），另一维成为每行里的
 * `children`。两个视图（按用户 / 按模型）**共用这一个函数**，所以它们的口径
 * 不可能对不上 —— 各写一遍的话，"两页的总计差了一点"这种错谁也说不清哪页是对的。
 */
export function pivot(rows, dimension) {
  const other = dimension === 'username' ? 'modelId' : 'username'
  const groups = new Map()
  for (const row of rows) {
    const key = row[dimension]
    const current = groups.get(key)
      || { [dimension]: key, runs: 0, input: 0, output: 0, cacheRead: 0, lastAt: null, children: [] }
    current.runs += row.runs || 0
    current.input += row.input || 0
    current.output += row.output || 0
    current.cacheRead += row.cacheRead || 0
    // 时间是 ISO 串，字典序就是时间序 —— 不必解析成 Date 再比
    if (row.lastAt && (!current.lastAt || row.lastAt > current.lastAt)) current.lastAt = row.lastAt
    current.children.push({
      [other]: row[other],
      runs: row.runs || 0,
      input: row.input || 0,
      output: row.output || 0,
      cacheRead: row.cacheRead || 0,
      lastAt: row.lastAt || null,
      tokens: (row.input || 0) + (row.output || 0),
    })
    groups.set(key, current)
  }
  return withTokens([...groups.values()])
    .map((row) => ({ ...row, children: row.children.sort(byTokensThen(other)) }))
    .sort(byTokensThen(dimension))
}

export function createUsageStore({ storage = null, logger = console } = {}) {
  const ledger = storage?.usage || null

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
     * 管理台总表。一次查询（用户 × 模型的交叉表），转置成两个视图：
     *
     *   group='user'   每个账号一行，`models` 是他用过的模型
     *   group='model'  每个模型一行，`users` 是用了它的人
     *
     * 两个方向都要有，因为要问的是两个问题：分账时问"这个人该付多少"，
     * 选型和定价时问"这个模型吃掉了多少"。同一份交叉表转置得来，
     * 所以两页的合计**天然相等**。
     *
     * `accounts` 是账号清单（`users.list()` 的结果），只在 group='user' 时用得上：
     * **以账号为准做左连接** —— 一个没跑过任何 run 的人也要出现在表里（一行 0），
     * 否则"这个人没用过"和"这个人不存在"在界面上长得一样。反过来，台账里有而
     * 账号清单里没有的用户名也要留着（标 orphan）—— 那是被删掉的账号留下的账，
     * 藏起来只会让合计对不上。
     *
     * ⚠️ 模型这一维**没有**对应的左连接：可用模型清单是每个用户各自从 llminfo 拿的
     * （见 credentials/broker.js），服务端没有一份"本部署有哪些模型"的权威清单。
     * 所以这一页只列**真的被用过**的模型 —— 那也正是要算钱的那些。
     */
    async summary({ accounts = [], days = 30, group = 'user', prices = null, currency = '', now = Date.now() } = {}) {
      const since = resolveSince(days, { now })
      const view = group === 'model' ? 'model' : 'user'
      if (!ledger) {
        return { enabled: false, group: view, since: null, users: [], models: [], modelCount: 0, total: sumBuckets([]) }
      }

      const rows = await ledger.byUserAndModel({ since })
      /**
       * 全局的金额与"哪些模型没定价"都从**台账原始行**算，不从拼好的行算。
       *
       * 与 `total` 从 rows 算是同一个理由：拼出来的行含补零的账号行，
       * 加起来一样，但少一次"补零补错了"的可能。未定价清单尤其如此 ——
       * 从补零行里收，会把"从来没用过任何模型"的人也算成一次未定价。
       */
      const money = prices ? costOfRows(rows, prices) : null
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
        /**
         * 合计只从台账行来，不从拼出来的行来。
         * 后者含补零的行，加起来一样 —— 但少一次"补零补错了"的可能。
         */
        total: sumBuckets(rows),
        /**
         * 这个窗口里出现过几个模型。**两个视图都回**：按用户看的时候，
         * "这段时间在用几个模型"同样是管理员要知道的一个数（多模型切换开起来之后
         * 它会变），而那一页的行是按人分的，自己数不出来。
         */
        modelCount: new Set(rows.map((row) => row.modelId)).size,
      }

      if (view === 'model') {
        const models = pivot(rows, 'modelId')
          .map((row) => renameChildren(row, 'users'))
          .map((row) => (prices ? priceRow(row, prices, 'users') : row))
        return { ...base, models }
      }

      const users = pivot(rows, 'username')
        .map((row) => renameChildren(row, 'models'))
        .map((row) => (prices ? priceRow(row, prices, 'models') : row))
      const seen = new Map(users.map((row) => [row.username, row]))
      /**
       * 没跑过任何 run 的账号补的那一行零。
       *
       * 计价开着时它的 `cost` 是 **0 而不是 null**：这个人确实一分钱没花，
       * 那是一个已知的事实，不是"不知道多少钱"。反过来写成 null，界面上
       * 就会给一排从没用过的账号标"未定价"，而那与单价填没填毫无关系。
       */
      const blank = {
        runs: 0, input: 0, output: 0, cacheRead: 0, tokens: 0, lastAt: null, models: [],
        ...(prices ? { cost: 0, costPartial: false, unpricedModels: [] } : {}),
      }
      const merged = accounts.map((account) => {
        const row = seen.get(account.username)
        seen.delete(account.username)
        return {
          username: account.username,
          role: account.role || 'user',
          disabled: Boolean(account.disabled),
          ...(row || blank),
        }
      })
      // 剩下的就是账号已经不在、账还留着的
      for (const row of seen.values()) merged.push({ role: '', disabled: false, orphan: true, ...row })

      return { ...base, users: merged.sort(byTokensThen('username')) }
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

/**
 * `children` 换成一个说得清是什么的名字（`models` / `users`）。
 *
 * pivot 用的是中性的 `children`（它不知道自己在折哪一维），但接口回出去的字段名
 * 是给人读的：`users[0].models` 一眼看得懂，`users[0].children` 要猜。
 */
function renameChildren(row, name) {
  const { children, ...rest } = row
  return { ...rest, [name]: children }
}
