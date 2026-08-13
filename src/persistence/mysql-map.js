/**
 * MySQL 版的「可持久化 Map」。
 *
 * **接口与 src/persistence/file-map.js 逐字对齐**（all/entries/get/put/putIfAbsent/
 * merge/update/delete/take）。那个文件的开头写着"将来换 MySQL / Redis 时上层一行
 * 不用动"——这里就是把那句话兑现掉，所以**不许在这儿加方法**：
 * 加了就只有 mysql 驱动有，上层一旦用上，文件驱动的部署会在运行时才发现少了东西。
 *
 * ── 它比文件版强在哪 ────────────────────────────────────────────────────
 *
 * 文件版的 read-modify-write 只在**进程内**串行（一把按 key 的队列），跨副本没有锁：
 * 两个副本同时 merge 同一条，后写的会盖掉先写的。文件版的文件头把这条边界写得很
 * 清楚，也说明了为什么在当前部署形态下够用。
 *
 * 这里用 `SELECT ... FOR UPDATE` 把这件事真正解决掉：读改写整段在一个事务里，
 * 行锁由数据库持有，**跨副本成立**。于是 STORAGE_DRIVER=mysql 顺带解锁了
 * "多副本同时写同一条记录"这个文件驱动做不到的场景。
 */

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
