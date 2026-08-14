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
 * ⚠️ 另外一句必须写明白：**这不是账单，是可归因的用量。** 计费的真源在模型网关
 * （llm_requests 表）—— 那边记的是它真的向上游发了什么。这张表记的是我们这边
 * 看到的用量，两者在正常情况下相等，但网关重试、上游改价、我们这边进程被 kill
 * 掉的那一瞬间都会让它们差一点。对外收钱要以网关那份为准。
 */

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
    async summary({ accounts = [], days = 30, group = 'user', now = Date.now() } = {}) {
      const since = resolveSince(days, { now })
      const view = group === 'model' ? 'model' : 'user'
      if (!ledger) {
        return { enabled: false, group: view, since: null, users: [], models: [], modelCount: 0, total: sumBuckets([]) }
      }

      const rows = await ledger.byUserAndModel({ since })
      const base = {
        enabled: true,
        group: view,
        since: since ? since.toISOString() : null,
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
        return { ...base, models: pivot(rows, 'modelId').map((row) => renameChildren(row, 'users')) }
      }

      const users = pivot(rows, 'username').map((row) => renameChildren(row, 'models'))
      const seen = new Map(users.map((row) => [row.username, row]))
      const merged = accounts.map((account) => {
        const row = seen.get(account.username)
        seen.delete(account.username)
        return {
          username: account.username,
          role: account.role || 'user',
          disabled: Boolean(account.disabled),
          ...(row || { runs: 0, input: 0, output: 0, cacheRead: 0, tokens: 0, lastAt: null, models: [] }),
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
    async trend({ username = '', modelId = '', days = 30, now = Date.now() } = {}) {
      const since = resolveSince(days, { now })
      const scope = { username, modelId, since: null }
      if (!ledger) return { enabled: false, ...scope, daily: [], total: sumBuckets([]) }

      const daily = username
        ? await ledger.dailyForUser({ username, modelId, since })
        : await ledger.dailyForModel({ modelId, since })
      return {
        enabled: true,
        username,
        modelId,
        since: since ? since.toISOString() : null,
        total: sumBuckets(daily),
        daily: withTokens(daily),
      }
    },
  }
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
