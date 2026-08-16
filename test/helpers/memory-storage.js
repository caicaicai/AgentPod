/**
 * 存储后端的**测试替身**：全在内存里的 Map。
 *
 * ── 它不是第二个驱动 ────────────────────────────────────────────────────
 *
 * 生产代码只有 MySQL 一种后端（见 src/persistence/storage.js 文件头）。
 * 这个文件住在 test/ 下、不从 src/ 导出、没有任何环境变量能把它接进服务里。
 * 它存在的唯一理由是：**刚 clone 下来的仓库跑 `npm test` 应该全绿**，
 * 而不是要求每个人先起一个数据库才能验证一行业务逻辑。
 *
 * ── 怎么防止它和真后端漂移 ──────────────────────────────────────────────
 *
 * 替身最大的风险是"它自己对了，但跟真的不一样"，于是用例全绿而生产出问题。
 * 所以 test/storage-drivers.test.js 里那套**契约用例对它和真 MySQL 各跑一遍**：
 *
 *   替身   总是跑
 *   MySQL  设了 AP_TEST_MYSQL_URL 时跑
 *
 * 只要 CI 上挂着一个 MySQL，任何一处漂移都会在那边当场变红。
 * 加方法时**两边一起加**，否则契约用例会先告诉你少了什么。
 */

import { PAGE_DEFAULT, finishPage } from '../../src/persistence/page.js'
import { assertSegment } from '../../src/persistence/paths.js'
// 形状从真后端那边 import，不在这里再拼一遍 —— 少一处能漂移的地方
import { toTotals } from '../../src/persistence/storage.js'

/**
 * 拼键的分隔符。写成转义而不是字面 NUL —— 后者会让 ripgrep 把整个文件判成
 * 二进制并整个跳过（src/sandbox/sticky.js 上真踩过这个坑）。
 * 用它而不是空格：作品的文件路径里是允许有空格的。
 */
const SEP = '\u0000'

/** 深拷贝一次再交出去：调用方改了返回值不该影响存着的那份（真后端天然如此） */
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/** 与 mysql-map 的 applyPatch 同语义：undefined 删字段，与"值为 null"分得开 */
function applyPatch(value, patch) {
  const next = { ...value }
  for (const [key, item] of Object.entries(patch)) {
    if (item === undefined) delete next[key]
    else next[key] = item
  }
  return next
}

/** 用量台账的时间窗过滤，对应真后端的 `WHERE (? IS NULL OR created_at >= ?)` */
function rowsSince(usage, since) {
  const from = since ? new Date(since) : null
  return [...usage.values()].filter((row) => !from || row.createdAt >= from)
}

/**
 * 按某一维分组求和，对应真后端的 `GROUP BY <维度>`。
 *
 * 带 `tokens`（= input + output，**不含 cacheRead**）—— 与真后端 SELECT 里那一列
 * 同一个口径，也与 telemetry/usage-store.js 的 sumBuckets 一致。
 */
function foldUsage(rows, dimension) {
  const groups = new Map()
  for (const row of rows) {
    const key = row[dimension]
    const current = groups.get(key)
      || { [dimension]: key, runs: 0, input: 0, output: 0, cacheRead: 0, lastAt: null }
    current.runs += 1
    current.input += row.input
    current.output += row.output
    current.cacheRead += row.cacheRead
    if (!current.lastAt || row.createdAt > current.lastAt) current.lastAt = row.createdAt
    groups.set(key, current)
  }
  return [...groups.values()].map((row) => ({
    ...row,
    tokens: row.input + row.output,
    lastAt: row.lastAt ? row.lastAt.toISOString() : null,
  }))
}

/** 按天汇总，旧到新。与真后端的 DATE_FORMAT 一致：分的是 **UTC** 的天（连接上 timezone='Z'） */
/**
 * 按天折。`subField` 不传就是一天一行（对应 `GROUP BY day`）；传了就再按这个字段
 * 拆一层（对应 `GROUP BY day, model_id`），字段本身原样写进结果行里。
 */
function daily(rows, subField = '') {
  const groups = new Map()
  for (const row of rows) {
    const day = row.createdAt.toISOString().slice(0, 10)
    const sub = subField ? row[subField] : ''
    const key = `${day}${SEP}${sub}`
    const current = groups.get(key)
      || { day, ...(subField ? { [subField]: sub } : {}), runs: 0, input: 0, output: 0, cacheRead: 0 }
    current.runs += 1
    current.input += row.input
    current.output += row.output
    current.cacheRead += row.cacheRead
    groups.set(key, current)
  }
  return [...groups.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
}

function createMap(store, collection, owner) {
  const prefix = `${collection}${SEP}${owner}${SEP}`
  const keyOf = (id) => `${prefix}${id}`

  /** 这个集合+owner 下的全部条目，按 id 升序 —— 与 SQL 的 ORDER BY id 对齐 */
  function ownEntries() {
    return [...store.kv.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  }

  return {
    dir: `memory:${collection}/${owner || '*'}`,

    async all() {
      return ownEntries().map(([, value]) => clone(value))
    },
    async entries() {
      return ownEntries().map(([id, value]) => [id, clone(value)])
    },

    /**
     * 与真后端的 `ORDER BY id ASC LIMIT ?` 对应。
     *
     * ⚠️ `contains` 这里用的是 `includes`，而真后端是 `LIKE '%…%' ESCAPE '\\'` ——
     * 两者只有在**通配符被转义之后**才等价，所以真后端那边少一句 escapeLike
     * 就会在契约用例里现形（那条用例专门搜一个带 `%` 的名字）。
     */
    async page({ cursor = '', limit = PAGE_DEFAULT, contains = '' } = {}) {
      const keyword = String(contains || '')
      const rows = ownEntries()
        .filter(([id]) => (!cursor || id > String(cursor)) && (!keyword || id.includes(keyword)))
      const { page, hasMore, nextCursor } = finishPage(rows.slice(0, limit + 1), limit, ([id]) => id)
      return { items: page.map(([, value]) => clone(value)), hasMore, nextCursor }
    },

    /** 与真后端的 `id IN (…)` 对应：回的顺序按 id 升序，不按传进来的顺序 */
    async many(ids) {
      const want = new Set([...new Set((ids || []).map((id) => String(id)))].filter(Boolean))
      if (!want.size) return []
      return ownEntries().filter(([id]) => want.has(id)).map(([, value]) => clone(value))
    },

    async count({ contains = '' } = {}) {
      const keyword = String(contains || '')
      return ownEntries().filter(([id]) => !keyword || id.includes(keyword)).length
    },

    /**
     * 与真后端的 `GROUP BY JSON_EXTRACT(payload, '$.<field>')` 对应。
     *
     * 字段名的合法性判据也要一样：真后端那边它要拼进 JSON path（拼不得随便什么
     * 字符串），替身这边技术上无所谓 —— 但两边不一致的话，一个非法字段名
     * 在用例里静静地通过，到了生产才抛。
     */
    async countByField(field) {
      const name = String(field || '')
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`字段名不合法：${field}`)
      const out = new Map()
      for (const [, value] of ownEntries()) {
        /**
         * 字段缺席时真后端回 SQL NULL，一并归到空串那一档。
         *
         * 其余一律 `String()`：JSON_UNQUOTE 回的**永远是字符串**（`false` 出来是
         * `'false'`），不转的话替身会拿布尔当 Map 的键，于是同一份数据在两个后端上
         * 分出不同的档。这个方法只保证**字符串字段**的语义（目前只有 groupId），
         * 拿它去数布尔字段是可以的，但要知道键是 `'true'` / `'false'`。
         */
        const raw = value?.[name]
        const key = raw === undefined || raw === null ? '' : String(raw)
        out.set(key, (out.get(key) || 0) + 1)
      }
      return out
    },

    /**
     * 与真后端的多字段计数对应。⚠️ `notEquals` 上**字段缺席算"不等于"** ——
     * 真后端那边靠一句 `IS NULL OR <> ?` 保证（不写的话 SQL 三值逻辑会让缺字段的
     * 行从两边计数里一起消失），这边靠 `raw === undefined` 这一支。
     */
    async countMatching(equals = {}, notEquals = {}) {
      const assertField = (field) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(field || ''))) throw new Error(`字段名不合法：${field}`)
      }
      /**
       * ⚠️ 字段名要**在遍历之前**全部校验一遍。
       *
       * 真后端那边是拼 SQL 时校验的，也就是说**一条记录都没有它照样抛**。
       * 只在 filter 回调里校验的话，空集合上这个方法会安静地回 0 ——
       * 而那正是契约用例最容易漏掉的形态（用例里的库常常是空的）。
       */
      for (const field of [...Object.keys(equals), ...Object.keys(notEquals)]) assertField(field)
      const read = (value, field) => {
        const raw = value?.[field]
        return raw === undefined || raw === null ? null : String(raw)
      }
      return ownEntries().filter(([, value]) => {
        for (const [field, want] of Object.entries(equals)) {
          if (read(value, field) !== String(want)) return false
        }
        for (const [field, want] of Object.entries(notEquals)) {
          const actual = read(value, field)
          if (actual !== null && actual === String(want)) return false
        }
        return true
      }).length
    },
    async get(id) {
      return clone(store.kv.get(keyOf(id))) ?? null
    },
    async put(id, value) {
      store.kv.set(keyOf(id), clone(value))
    },
    async putIfAbsent(id, value) {
      const existing = store.kv.get(keyOf(id))
      if (existing) return clone(existing)
      store.kv.set(keyOf(id), clone(value))
      return value
    },
    async merge(id, patch) {
      const current = store.kv.get(keyOf(id))
      if (!current) return null
      const next = applyPatch(current, patch)
      store.kv.set(keyOf(id), clone(next))
      return clone(next)
    },
    async update(id, fn) {
      const current = store.kv.get(keyOf(id))
      if (!current) return null
      const next = fn(clone(current))
      store.kv.set(keyOf(id), clone(next))
      return clone(next)
    },
    async delete(id) {
      store.kv.delete(keyOf(id))
    },
    async take(id) {
      const current = store.kv.get(keyOf(id))
      if (!current) return null
      store.kv.delete(keyOf(id))
      return clone(current)
    },
  }
}

/**
 * @returns 与 createStorage() 同形状的后端。`driver` 报 `memory`，
 *   于是万一它被误接进生产路径，`/healthz` 上会**立刻看得出来**。
 */
export function createMemoryStorage() {
  const store = {
    kv: new Map(), // `${collection}\0${owner}\0${id}` -> 记录
    docs: new Map(), // `${username}\0${kind}\0${scope}` -> 正文
    blobs: new Map(), // `${username}\0${id}\0${version}\0${path}` -> 正文
    usage: new Map(), // runId -> 一次 run 的用量明细（与 ap_usage 一行对应）
  }

  /**
   * ⚠️ 这里的 assertSegment 与真后端**必须一致**：少了它，"username 拼不出越界"
   * 这类用例在替身上会一路绿灯，而真库那边才拦。校验本身是共用的那一个函数。
   */
  const docKey = ({ username, scope = '', kind = 'memory' }) => {
    assertSegment(username, 'username')
    if (scope) assertSegment(scope, 'scope')
    return `${username}${SEP}${kind}${SEP}${scope}`
  }
  const blobPrefix = (username, id, version) => `${username}${SEP}${id}${SEP}${version}${SEP}`

  return {
    driver: 'memory',
    pool: null,

    mapFor: (collection, username) => createMap(store, collection, assertSegment(username, 'username')),
    globalMap: (collection) => createMap(store, collection, ''),

    async usernames(collection) {
      const prefix = `${collection}${SEP}`
      const out = new Set()
      for (const key of store.kv.keys()) {
        if (!key.startsWith(prefix)) continue
        const owner = key.slice(prefix.length).split(SEP)[0]
        if (owner) out.add(owner)
      }
      return [...out]
    },

    docs: {
      async read(scope) {
        return store.docs.get(docKey(scope)) ?? ''
      },
      async write(scope, content) {
        store.docs.set(docKey(scope), String(content))
      },
      async remove(scope) {
        store.docs.delete(docKey(scope))
      },
      /** 与真后端一致：不挑 kind，这个作用域下所有文档一起清 */
      async dropScope({ username, scope }) {
        if (!scope) return
        assertSegment(username, 'username')
        assertSegment(scope, 'scope')
        for (const key of [...store.docs.keys()]) {
          const [owner, , docScope] = key.split(SEP)
          if (owner === username && docScope === scope) store.docs.delete(key)
        }
      },
    },

    blobs: {
      async writeVersion({ username, id, version, files }) {
        for (const file of files) {
          store.blobs.set(`${blobPrefix(username, id, version)}${file.path}`, String(file.content))
        }
      },
      async readVersion({ username, id, version, paths }) {
        const out = new Map()
        for (const relPath of paths) {
          const content = store.blobs.get(`${blobPrefix(username, id, version)}${relPath}`)
          // 报错文案与真后端逐字一致：用例会去匹配它
          if (content === undefined) throw new Error(`第 ${version} 版的 ${relPath} 不存在（可能被手工删除）`)
          out.set(relPath, content)
        }
        return out
      },
      async removeVersion({ username, id, version }) {
        const prefix = blobPrefix(username, id, version)
        for (const key of [...store.blobs.keys()]) if (key.startsWith(prefix)) store.blobs.delete(key)
      },
      async removeArtifact({ username, id }) {
        const prefix = `${username}${SEP}${id}${SEP}`
        for (const key of [...store.blobs.keys()]) if (key.startsWith(prefix)) store.blobs.delete(key)
      },
      async listVersion({ username, id, version }) {
        const prefix = blobPrefix(username, id, version)
        return [...store.blobs.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length))
          .sort()
      },
    },

    /**
     * Token 用量台账。与真后端**逐字段同形状**：数字是 number、时间是 ISO 串、
     * 排序规则一致（总 token 降序 / 天升序），否则契约用例会在这几处炸。
     */
    usage: {
      async record({
        username, runId, source = 'web', modelId = '',
        input = 0, output = 0, cacheRead = 0, durationMs = 0, createdAt = null,
      }) {
        assertSegment(username, 'username')
        // 与真后端的 INSERT IGNORE 一致：同一个 runId 记第二次原样忽略
        if (store.usage.has(String(runId))) return
        store.usage.set(String(runId), {
          username,
          runId: String(runId),
          source: String(source).slice(0, 32),
          modelId: String(modelId || '').slice(0, 128),
          input: Math.max(0, Math.round(Number(input) || 0)),
          output: Math.max(0, Math.round(Number(output) || 0)),
          cacheRead: Math.max(0, Math.round(Number(cacheRead) || 0)),
          durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
          /**
           * `createdAt` 只有用例会传（真后端那边是 CURRENT_TIMESTAMP，写不进去）。
           * 有它才测得了时间窗过滤 —— 否则要让用例等一天。
           */
          createdAt: createdAt ? new Date(createdAt) : new Date(),
        })
      },

      /** `usernames` 与真后端一致：不传 = 全部，传空数组 = 空（不是全部） */
      async byUserAndModel({ since = null, usernames = null } = {}) {
        if (usernames && !usernames.length) return []
        const want = usernames ? new Set(usernames.map(String)) : null
        const groups = new Map()
        for (const row of rowsSince(store.usage, since)) {
          if (want && !want.has(row.username)) continue
          const key = `${row.username}${SEP}${row.modelId}`
          const current = groups.get(key)
            || { username: row.username, modelId: row.modelId, runs: 0, input: 0, output: 0, cacheRead: 0, lastAt: null }
          current.runs += 1
          current.input += row.input
          current.output += row.output
          current.cacheRead += row.cacheRead
          if (!current.lastAt || row.createdAt > current.lastAt) current.lastAt = row.createdAt
          groups.set(key, current)
        }
        return [...groups.values()]
          .map((row) => ({ ...row, lastAt: row.lastAt ? row.lastAt.toISOString() : null }))
          .sort((a, b) => (b.input + b.output) - (a.input + a.output))
      },

      /** 与真后端的 `COUNT(DISTINCT username)` 对应 */
      async countActiveUsers({ since = null } = {}) {
        return new Set(rowsSince(store.usage, since).map((row) => row.username)).size
      },

      /** 与真后端的 `GROUP BY model_id` 对应，含 `tokens` 这一列（= input + output） */
      async byModel({ since = null } = {}) {
        return foldUsage(rowsSince(store.usage, since), 'modelId')
          .sort((a, b) => b.tokens - a.tokens || (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0))
      },

      /**
       * 与真后端的 keyset 聚合分页对应：token 降序、同数按用户名升序，多取一条。
       *
       * ⚠️ 排序与游标判据必须与那边**逐字一致**，否则"翻页漏一条"这种错会只在
       * 真库上出现 —— 而那是最难查的一类 bug，专门有一条契约用例钉它。
       */
      async topUsers({ since = null, cursor = null, limit = 50 } = {}) {
        const at = cursor ? Number(cursor.tokens) || 0 : null
        const from = cursor ? String(cursor.username) : ''
        return foldUsage(rowsSince(store.usage, since), 'username')
          .filter((row) => at === null || row.tokens < at || (row.tokens === at && row.username > from))
          .sort((a, b) => b.tokens - a.tokens || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0))
          .slice(0, limit + 1)
      },

      /**
       * 与真后端那句 ROW_NUMBER() 对应：每个模型取前 limit 个人。
       * 结果按 (modelId 升序, tokens 降序, username 升序) 排 —— 与那边逐字一致。
       */
      async topUsersPerModel({ since = null, modelIds = [], limit = 20 } = {}) {
        if (!modelIds.length) return []
        const want = new Set(modelIds.map(String))
        const out = []
        for (const modelId of [...want].sort()) {
          const rows = foldUsage(rowsSince(store.usage, since).filter((row) => row.modelId === modelId), 'username')
            .sort((a, b) => b.tokens - a.tokens || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0))
            .slice(0, limit)
          out.push(...rows.map((row) => ({ ...row, modelId })))
        }
        return out
      },

      /** 与真后端一致：`modelId` 空串 = 不筛模型（不是"筛模型为空串的那些行"） */
      async dailyForUser({ username, modelId = '', since = null }) {
        assertSegment(username, 'username')
        return daily(rowsSince(store.usage, since).filter(
          (row) => row.username === username && (!modelId || row.modelId === modelId),
        ))
      },

      /** 与真后端的 `GROUP BY day, model_id` 对应：一天里用过几个模型就有几行 */
      async dailyForUserByModel({ username, since = null }) {
        assertSegment(username, 'username')
        return daily(rowsSince(store.usage, since).filter((row) => row.username === username), 'modelId')
      },

      async dailyForModel({ modelId, since = null }) {
        return daily(rowsSince(store.usage, since).filter((row) => row.modelId === String(modelId || '')))
      },

      /** 与真后端的条件 SUM 对应：累计一份、`dayStart` 之后一份，同一次遍历里算 */
      async totalsForUser({ username, dayStart = null }) {
        assertSegment(username, 'username')
        const from = dayStart ? new Date(dayStart) : null
        const acc = { totalInput: 0, totalOutput: 0, dayInput: 0, dayOutput: 0 }
        for (const row of store.usage.values()) {
          if (row.username !== username) continue
          acc.totalInput += row.input
          acc.totalOutput += row.output
          if (!from || row.createdAt >= from) {
            acc.dayInput += row.input
            acc.dayOutput += row.output
          }
        }
        return toTotals(acc)
      },
    },

    async close() {},

    /** 契约用例每条之前清一次，与 mysql 那边 DELETE 各表对应 */
    reset() {
      store.kv.clear()
      store.docs.clear()
      store.blobs.clear()
      store.usage.clear()
    },
  }
}
