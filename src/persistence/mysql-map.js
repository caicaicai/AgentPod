/**
 * MySQL 版的「可持久化 Map」。
 *
 * ── 关于"不许在这儿加方法"那条老规矩 ────────────────────────────────────
 *
 * 这个文件的开头曾经写着：接口必须与 `src/persistence/file-map.js` 逐字对齐，
 * **不许加方法** —— 加了就只有 mysql 驱动有，而文件驱动的部署会在运行时
 * 才发现少了东西。
 *
 * 那条规矩的前提没有了：文件驱动已经整个移除，现在只剩 MySQL 一种后端
 * （理由见 src/persistence/storage.js 文件头）。规矩本身**换了个约束对象**，
 * 但没有消失：test/helpers/memory-storage.js 那个测试替身还在，
 * 而它的存在理由是"刚 clone 下来的仓库跑 npm test 应该全绿"。
 *
 * ⚠️ 所以：**这里加一个方法，替身那边就要同时加一个**，并且在
 * test/storage-drivers.test.js 里补一条契约用例（那套用例对替身和真 MySQL
 * 各跑一遍）。漏了的表现是用例全绿而生产上少一个方法 —— 正是从前那条规矩
 * 想挡住的那种错。
 *
 * ── 它比文件版强在哪 ────────────────────────────────────────────────────
 *
 * 文件版的 read-modify-write 只在**进程内**串行（一把按 key 的队列），跨副本没有锁：
 * 两个副本同时 merge 同一条，后写的会盖掉先写的。
 *
 * 这里用 `SELECT ... FOR UPDATE` 把这件事真正解决掉：读改写整段在一个事务里，
 * 行锁由数据库持有，**跨副本成立**。
 *
 * ── all() 与 page()：什么时候该用哪个 ───────────────────────────────────
 *
 * `all()` 把这个集合整个读进内存。对**天然有上限**的集合（一个部署里的模型是
 * 十几条、分组是几条）那没问题，而且有些调用点本来就需要全量
 * （model-store 的 resolveForGroup 要按 sort 排出完整优先级）。
 *
 * 对**会跟着使用量涨**的集合（账号）它是错的：管理台点开一次账号页，
 * 就是把每个人的记录（含 scrypt 派生结果、盐）整个搬进 Node 再排一遍序。
 * 那种集合走 `page()` —— 主键是 `(collection, owner, id)`，
 * 按 id 升序的 keyset 翻页正好走这条索引，一页就是一次范围扫描。
 */
import { PAGE_DEFAULT, escapeLike, finishPage } from './page.js'

/**
 * @param {object} params
 * @param {object} params.pool        mysql2 连接池
 * @param {string} params.collection  集合名（projects | cron | artifacts | shares）
 * @param {string} params.owner       username；全局集合传空串
 */
export function createMysqlMap({ pool, collection, owner = '', logger = console }) {
  const scope = [collection, owner]

  function parse(row) {
    if (!row) return null
    try {
      return JSON.parse(row.payload)
    } catch {
      /**
       * 单条坏掉不该让整个清单打不开 —— 与文件版同一个取舍。
       * 走到这儿说明有人手工改过这一行：正常写入路径永远是 JSON.stringify 的结果。
       */
      logger.warn?.('存储记录不是合法 JSON，已跳过', { collection, owner, id: row.id })
      return null
    }
  }

  async function readOne(id) {
    const [rows] = await pool.query(
      'SELECT id, payload FROM ap_kv WHERE collection = ? AND owner = ? AND id = ? LIMIT 1',
      [...scope, String(id)],
    )
    return parse(rows[0])
  }

  async function writeOne(id, value) {
    await pool.query(
      'INSERT INTO ap_kv (collection, owner, id, payload) VALUES (?, ?, ?, ?)'
      + ' ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = CURRENT_TIMESTAMP',
      [...scope, String(id), JSON.stringify(value)],
    )
  }

  /**
   * 读改写：事务 + 行锁。
   *
   * `FOR UPDATE` 只在行存在时才锁得住 —— 记录不存在时这两个方法本来就返回 null
   * 而不是凭空造一条（与文件版一致），所以不需要处理"锁一个还不存在的行"。
   */
  async function mutate(id, apply) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const [rows] = await conn.query(
        'SELECT payload FROM ap_kv WHERE collection = ? AND owner = ? AND id = ? FOR UPDATE',
        [...scope, String(id)],
      )
      if (!rows.length) {
        await conn.rollback()
        return null
      }
      let current
      try {
        current = JSON.parse(rows[0].payload)
      } catch {
        await conn.rollback()
        logger.warn?.('存储记录不是合法 JSON，拒绝在其上做增量更新', { collection, owner, id })
        return null
      }
      const next = apply(current)
      await conn.query(
        'UPDATE ap_kv SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE collection = ? AND owner = ? AND id = ?',
        [JSON.stringify(next), ...scope, String(id)],
      )
      await conn.commit()
      return next
    } catch (error) {
      await conn.rollback().catch(() => {})
      throw error
    } finally {
      conn.release()
    }
  }

  /** 与文件版的 applyPatch 同语义：undefined 表示删字段，与"值为 null"区分开 */
  function applyPatch(value, patch) {
    const next = { ...value }
    for (const [key, item] of Object.entries(patch)) {
      if (item === undefined) delete next[key]
      else next[key] = item
    }
    return next
  }

  return {
    /** 文件版这里是目录路径。保留同名字段，日志里能一眼看出数据落在哪 */
    dir: `mysql:ap_kv/${collection}/${owner || '*'}`,

    async all() {
      const [rows] = await pool.query(
        'SELECT id, payload FROM ap_kv WHERE collection = ? AND owner = ? ORDER BY id ASC',
        scope,
      )
      return rows.map(parse).filter(Boolean)
    },

    async entries() {
      const [rows] = await pool.query(
        'SELECT id, payload FROM ap_kv WHERE collection = ? AND owner = ? ORDER BY id ASC',
        scope,
      )
      return rows.map((row) => [row.id, parse(row)]).filter(([, value]) => value)
    },

    /**
     * 按 id 升序翻一页。**主键序 = 排序序**，所以这是一次纯范围扫描。
     *
     * @param {string} [params.cursor]   上一页最后一条的 id；空 = 从头
     * @param {number} [params.limit]    这一页要几条
     * @param {string} [params.contains] id 的子串筛选（账号页那个搜索框）
     * @returns {Promise<{ items, hasMore, nextCursor }>} `nextCursor` 是**下一页的
     *   起点 id**，不是 base64 —— 上层各自决定要不要再包一层游标编码。
     */
    async page({ cursor = '', limit = PAGE_DEFAULT, contains = '' } = {}) {
      const where = ['collection = ?', 'owner = ?']
      const params = [...scope]
      if (cursor) {
        where.push('id > ?')
        params.push(String(cursor))
      }
      /**
       * 子串搜索用不上索引（`LIKE '%x%'` 的前缀是通配的），扫的是
       * `(collection, owner)` 这一段范围。这是子串搜索固有的代价，不是这里写坏了：
       * 换成前缀匹配就能走索引，但那样搜 "zhang" 找不到 "li.zhang"，
       * 而管理员在搜索框里打的多半正是名字中间那一截。
       *
       * 通配符必须转义，否则一个 `%` 就是"匹配全部"（见 escapeLike）。
       */
      if (contains) {
        where.push("id LIKE ? ESCAPE '\\\\'")
        params.push(`%${escapeLike(contains)}%`)
      }
      const [rows] = await pool.query(
        `SELECT id, payload FROM ap_kv WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`,
        [...params, limit + 1],
      )
      /**
       * 游标从**行的 id**算，不从解析后的记录算。差别在坏记录上：payload 坏掉的
       * 那一条会被 parse 过滤成 null，如果游标取自 items 的最后一个，
       * 一页末尾若恰好全是坏记录，下一页就会从更早的位置重新开始 —— 死循环。
       */
      const { page, hasMore, nextCursor } = finishPage(rows, limit, (row) => row.id)
      return { items: page.map(parse).filter(Boolean), hasMore, nextCursor }
    },

    /**
     * 一次取一批 id。给"翻到这一页之后，再去补上这些人的详情"用。
     *
     * 有它才不用在循环里打 N 次 `get()` —— 那在一页 50 条时是 50 次往返，
     * 而它们扫的是同一段主键。**ids 由调用方保证是有界的**（一页的量），
     * 这里不设上限：设了就会变成一个安静地少返回几条的方法。
     */
    async many(ids) {
      const list = [...new Set((ids || []).map((id) => String(id)))].filter(Boolean)
      if (!list.length) return []
      const [rows] = await pool.query(
        `SELECT id, payload FROM ap_kv WHERE collection = ? AND owner = ? AND id IN (${list.map(() => '?').join(',')})`
        + ' ORDER BY id ASC',
        [...scope, ...list],
      )
      return rows.map(parse).filter(Boolean)
    },

    /** 这个集合有多少条（可带同样的子串筛选）。表头那个"共 N 个账号"用它 */
    async count({ contains = '' } = {}) {
      const where = ['collection = ?', 'owner = ?']
      const params = [...scope]
      if (contains) {
        where.push("id LIKE ? ESCAPE '\\\\'")
        params.push(`%${escapeLike(contains)}%`)
      }
      const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ap_kv WHERE ${where.join(' AND ')}`, params)
      return Number(rows[0]?.n) || 0
    },

    /**
     * 按 payload 里某个**顶层字段**分组计数，回 `Map<值, 条数>`。
     *
     * ── 这一处是 schema.sql 里那条"从不在 SQL 里查 JSON 内部"的明确例外 ──
     *
     * 那条原则的理由是：payload 存成 MEDIUMTEXT，在 SQL 里拆 JSON 既没有索引、
     * 又把"能不能跑"绑死在 MySQL 版本上。两条都还成立，这里也没打算推翻它 ——
     * 但对照的另一头更糟：分组页要显示"每个组几个人"，而从前的算法是
     * **把全部账号记录读进 Node，再在 JS 里 filter 一遍**，每打开一次页面一次。
     *
     * 换成这一句之后，扫描还是 O(账号数)（JSON 拆不出索引，这没法绕），
     * 但它整个发生在数据库里，回来的是**每组一行**而不是每人一条记录。
     * 省掉的是网络搬运和 N 个 JS 对象 —— 那才是它在生产上会先垮掉的地方。
     *
     * 真长到这一句也慢的规模，该做的是给账号拆一张有 group_id 列和索引的正经表
     * （schema.sql 里那条"长出自己的查询需求时再拆表"说的就是这一刻）。
     *
     * `field` 只允许标识符字符：它要拼进 JSON path，而 path 不是能参数化的位置。
     */
    async countByField(field) {
      const name = String(field || '')
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`字段名不合法：${field}`)
      /**
       * ⚠️ `COALESCE(..., '')` 是必须的，不是防御性冗余。
       *
       * 字段不存在时 `JSON_EXTRACT` 回的是 **SQL NULL**，而 NULL 和空串在
       * `GROUP BY` 里是**两个不同的档**。不合并的话这里会回两行（一行键是 null、
       * 一行键是 ''），而业务上它们是同一件事："这个人没有分组"
       * （见 user-store.toPublicUser 里 `record.groupId || ''`）。
       *
       * 这条正是契约用例在真 MySQL 上抓出来的：替身那边 `?.[name] ?? ''`
       * 天然就把两者并成了一档，于是内存里全绿、真库上分组页的人数少一半。
       */
      const [rows] = await pool.query(
        `SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.${name}')), '') AS value, COUNT(*) AS n`
        + ' FROM ap_kv WHERE collection = ? AND owner = ? AND JSON_VALID(payload) GROUP BY value',
        scope,
      )
      const out = new Map()
      // 累加而不是覆盖：上面那个 COALESCE 已经保证一个键只有一行，
      // 但写成累加就不必依赖它 —— 依赖一个别处的保证是这条 bug 当初的成因
      for (const row of rows) {
        const key = row.value ?? ''
        out.set(key, (out.get(key) || 0) + (Number(row.n) || 0))
      }
      return out
    },

    /**
     * 数出**同时**满足几个 payload 字段条件的记录数。与 countByField 同一处例外，
     * 理由也一样：回来的是一个整数，而不是一堆记录。
     *
     * 值一律按**字符串**比（`JSON_UNQUOTE` 出来的永远是字符串，`false` 就是
     * `'false'`），所以调用方传 JS 值即可，这里统一 `String()` 一次。
     *
     * @param {object} [equals]    字段 = 值
     * @param {object} [notEquals] 字段 ≠ 值。**字段缺席也算"不等于"** ——
     *   这不是细节：老账号记录里可能压根没有 `disabled` 这个字段，
     *   写成 `<> 'true'` 而不带 IS NULL 的话，SQL 三值逻辑会让那些行既不满足
     *   等于也不满足不等于，于是它们从两边的计数里同时消失。
     */
    async countMatching(equals = {}, notEquals = {}) {
      const where = ['collection = ?', 'owner = ?', 'JSON_VALID(payload)']
      const params = [...scope]
      const pathOf = (field) => {
        const name = String(field || '')
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`字段名不合法：${field}`)
        return `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.${name}'))`
      }
      for (const [field, value] of Object.entries(equals)) {
        where.push(`${pathOf(field)} = ?`)
        params.push(String(value))
      }
      for (const [field, value] of Object.entries(notEquals)) {
        const expr = pathOf(field)
        where.push(`(${expr} IS NULL OR ${expr} <> ?)`)
        params.push(String(value))
      }
      const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ap_kv WHERE ${where.join(' AND ')}`, params)
      return Number(rows[0]?.n) || 0
    },

    get: (id) => readOne(id),

    put: async (id, value) => { await writeOne(id, value) },

    /** 已存在就原样返回已有的那条 —— 用来做"创建一次"的幂等 */
    putIfAbsent: async (id, value) => {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const [rows] = await conn.query(
          'SELECT payload FROM ap_kv WHERE collection = ? AND owner = ? AND id = ? FOR UPDATE',
          [...scope, String(id)],
        )
        if (rows.length) {
          await conn.commit()
          return parse(rows[0])
        }
        await conn.query(
          'INSERT INTO ap_kv (collection, owner, id, payload) VALUES (?, ?, ?, ?)',
          [...scope, String(id), JSON.stringify(value)],
        )
        await conn.commit()
        return value
      } catch (error) {
        await conn.rollback().catch(() => {})
        throw error
      } finally {
        conn.release()
      }
    },

    /** 局部更新。记录不存在返回 null（而不是凭空造一条） */
    merge: (id, patch) => mutate(id, (current) => applyPatch(current, patch)),

    /** 需要读旧值才能算出新值时用它 */
    update: (id, fn) => mutate(id, fn),

    delete: async (id) => {
      await pool.query('DELETE FROM ap_kv WHERE collection = ? AND owner = ? AND id = ?', [...scope, String(id)])
    },

    take: async (id) => {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const [rows] = await conn.query(
          'SELECT payload FROM ap_kv WHERE collection = ? AND owner = ? AND id = ? FOR UPDATE',
          [...scope, String(id)],
        )
        if (!rows.length) {
          await conn.commit()
          return null
        }
        await conn.query('DELETE FROM ap_kv WHERE collection = ? AND owner = ? AND id = ?', [...scope, String(id)])
        await conn.commit()
        return parse(rows[0])
      } catch (error) {
        await conn.rollback().catch(() => {})
        throw error
      } finally {
        conn.release()
      }
    },
  }
}

/** 有哪些用户在这个集合下存过东西。只给定时任务的跨用户扫描用，与文件版 usernames() 对应 */
export async function listOwners({ pool, collection }) {
  const [rows] = await pool.query(
    'SELECT DISTINCT owner FROM ap_kv WHERE collection = ? AND owner <> \'\'',
    [collection],
  )
  return rows.map((row) => row.owner)
}
