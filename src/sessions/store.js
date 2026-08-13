/**
 * 会话存储接口。
 *
 * 隔离契约 #4：**所有读写都必须带 username**。接口层面就把 username 设成必填，
 * 避免出现 `WHERE session_key = ?` 这种"猜到 key 就能读别人会话"的实现。
 *
 * 会话本身是 pi 的 append-only JSONL 树（entry 有 id/parentId），
 * 所以落库应当只追加新行，而不是每轮重写整段。
 *
 * @typedef {Object} SessionStore
 * @property {(q: {username: string, sessionKey: string}) => Promise<{sessionId: string, jsonl: string, entryCount: number, title?: string}|null>} load
 * @property {(row: {username: string, sessionKey: string, sessionId: string, jsonl: string, entryCount: number, title?: string}) => Promise<void>} save
 * @property {(q: {username: string, projectId?: string, includeArchived?: boolean}) => Promise<Array>} list
 * @property {(q: {username: string, sessionKey: string, title: string}) => Promise<boolean>} rename
 * @property {(q: {username: string, sessionKey: string}) => Promise<boolean>} remove
 * @property {(q: {username: string, sessionKey: string, title?: string, pinned?: boolean, archived?: boolean, projectId?: string}) => Promise<object|null>} patch
 * @property {(q: {username: string, q: string, limit?: number}) => Promise<Array>} search
 * @property {() => Promise<void>} [close]
 */

function assertScoped(query, where) {
  if (!query?.username) throw new Error(`${where}: 缺少 username —— 会话读写必须按用户隔离（隔离契约 #4）`)
}

/** 标题列是 VARCHAR(255)，超了 MySQL 会截断或报错，统一在写入前收口 */
const TITLE_MAX_CHARS = 80
export function normalizeTitle(title) {
  return String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS)
}

/** MySQL 的一行 → 列表行。列名映射只写一次，list / patch / search 共用 */
function toListRow(username) {
  return (row) => ({
    username,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    title: row.title || '',
    entryCount: row.entry_count,
    projectId: row.project_id || '',
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    createdAt: row.created_at ? new Date(row.created_at).getTime() : 0,
    updatedAt: new Date(row.updated_at).getTime(),
  })
}

/**
 * MySQL 实现：表结构见 ./schema.sql。
 * 只追加新增的 JSONL 行（按已存行数比对），避免每轮重写整段会话。
 *
 * 曾经这里还有 memory（进程内）与 file（落 DATA_DIR）两个驱动。本服务现在
 * **只支持 MySQL**（理由见 src/persistence/storage.js 文件头：同时维护两套后端的
 * 成本落在每一处改动上，而文件那套永远只能是"单副本时能用"）。
 */
/**
 * @param {object} params
 * @param {object} [params.pool] 共用的连接池（storage 已经建好时传进来）。
 *   不传就自己建一个 —— 只有直接拿这个 store 单测时才走那条路。
 *   **正常启动路径一定是传进来的**：一个进程一个池，理由见 src/persistence/mysql.js。
 */
export async function createMysqlStore({ config, logger, pool: sharedPool = null }) {
  let pool = sharedPool
  let ownsPool = false
  if (!pool) {
    const { createPool } = await import('../persistence/mysql.js')
    pool = await createPool({ config, logger })
    ownsPool = true
  }

  async function loadRow(username, sessionKey) {
    const [rows] = await pool.query(
      'SELECT session_id, entry_count, title FROM ap_cloud_session WHERE username = ? AND session_key = ? LIMIT 1',
      [username, sessionKey],
    )
    return rows[0] || null
  }

  return {
    driver: 'mysql',
    async load(query) {
      assertScoped(query, 'store.load')
      const head = await loadRow(query.username, query.sessionKey)
      if (!head) return null
      const [lines] = await pool.query(
        'SELECT payload FROM ap_cloud_session_entry WHERE username = ? AND session_key = ? ORDER BY seq ASC',
        [query.username, query.sessionKey],
      )
      return {
        sessionId: head.session_id,
        entryCount: head.entry_count,
        title: head.title || '',
        jsonl: lines.map((row) => row.payload).join('\n') + (lines.length ? '\n' : ''),
      }
    },

    async save(row) {
      assertScoped(row, 'store.save')
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const [existing] = await conn.query(
          'SELECT COUNT(*) AS n FROM ap_cloud_session_entry WHERE username = ? AND session_key = ?',
          [row.username, row.sessionKey],
        )
        const already = Number(existing[0]?.n || 0)
        const lines = String(row.jsonl || '').split('\n').filter(Boolean)

        // 只写新增部分：pi 的会话是 append-only，历史行不会被改写
        for (let i = already; i < lines.length; i += 1) {
          await conn.query(
            'INSERT INTO ap_cloud_session_entry (username, session_key, seq, payload) VALUES (?, ?, ?, ?)',
            [row.username, row.sessionKey, i, lines[i]],
          )
        }

        // COALESCE 保住已有标题：save 每轮都带一个候选标题，若它能覆盖，
        // 用户改过的名字会在下一轮对话后被悄悄改回去（rename 才是显式改名的入口）。
        await conn.query(
          `INSERT INTO ap_cloud_session (username, session_key, session_id, title, entry_count, updated_at)
           VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE session_id = VALUES(session_id), entry_count = VALUES(entry_count),
             title = COALESCE(NULLIF(title, ''), VALUES(title)), updated_at = UTC_TIMESTAMP()`,
          [row.username, row.sessionKey, row.sessionId, normalizeTitle(row.title) || null, row.entryCount],
        )
        await conn.commit()
        if (lines.length > already) logger.debug('会话增量落库', { username: row.username, appended: lines.length - already })
      } catch (error) {
        await conn.rollback()
        throw error
      } finally {
        conn.release()
      }
    },

    async list(query) {
      assertScoped(query, 'store.list')
      const where = ['username = ?']
      const params = [query.username]
      if (query.projectId !== undefined) {
        where.push('project_id = ?')
        params.push(String(query.projectId || ''))
      }
      if (!query.includeArchived) where.push('archived = 0')
      const [rows] = await pool.query(
        `SELECT session_key, session_id, title, entry_count, project_id, pinned, archived, created_at, updated_at
         FROM ap_cloud_session WHERE ${where.join(' AND ')}
         ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
        [...params, Number(query.limit) || 200],
      )
      return rows.map(toListRow(query.username))
    },

    /** 置顶 / 归档 / 改项目归属。三样合成一条 UPDATE，避免并发下互相覆盖 */
    async patch(query) {
      assertScoped(query, 'store.patch')
      const sets = []
      const params = []
      if (query.title !== undefined) {
        sets.push('title = ?', 'updated_at = UTC_TIMESTAMP()')
        params.push(normalizeTitle(query.title) || null)
      }
      if (query.pinned !== undefined) { sets.push('pinned = ?'); params.push(query.pinned ? 1 : 0) }
      if (query.archived !== undefined) { sets.push('archived = ?'); params.push(query.archived ? 1 : 0) }
      if (query.projectId !== undefined) { sets.push('project_id = ?'); params.push(String(query.projectId || '')) }
      if (!sets.length) return null
      await pool.query(
        `UPDATE ap_cloud_session SET ${sets.join(', ')} WHERE username = ? AND session_key = ?`,
        [...params, query.username, query.sessionKey],
      )
      const [rows] = await pool.query(
        `SELECT session_key, session_id, title, entry_count, project_id, pinned, archived, created_at, updated_at
         FROM ap_cloud_session WHERE username = ? AND session_key = ? LIMIT 1`,
        [query.username, query.sessionKey],
      )
      return rows[0] ? toListRow(query.username)(rows[0]) : null
    },

    /**
     * 搜索。标题走元数据表，正文走 entry 表的 LIKE。
     *
     * 没有全文索引，靠 `username` 把扫描面收在一个人的数据里 —— 个人量级下够用。
     * 真到需要跨人搜索的那天，该上的是 ES 而不是把 LIKE 写得更花哨。
     */
    async search(query) {
      assertScoped(query, 'store.search')
      const keyword = String(query.q || '').trim()
      if (!keyword) return []
      const like = `%${keyword.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`
      const limit = Number(query.limit) || 50
      const [rows] = await pool.query(
        `SELECT s.session_key, s.session_id, s.title, s.entry_count, s.project_id, s.pinned, s.archived,
                s.created_at, s.updated_at,
                (s.title LIKE ? ESCAPE '\\\\') AS title_hit
         FROM ap_cloud_session s
         WHERE s.username = ? AND (
           s.title LIKE ? ESCAPE '\\\\'
           OR EXISTS (SELECT 1 FROM ap_cloud_session_entry e
                      WHERE e.username = s.username AND e.session_key = s.session_key AND e.payload LIKE ? ESCAPE '\\\\')
         )
         ORDER BY s.pinned DESC, s.updated_at DESC LIMIT ?`,
        [like, query.username, like, like, limit],
      )
      return rows.map((row) => ({
        ...toListRow(query.username)(row),
        matchedIn: row.title_hit ? 'title' : 'content',
        snippet: '',
      }))
    },

    async rename(query) {
      assertScoped(query, 'store.rename')
      const [result] = await pool.query(
        'UPDATE ap_cloud_session SET title = ? WHERE username = ? AND session_key = ?',
        [normalizeTitle(query.title) || null, query.username, query.sessionKey],
      )
      return result.affectedRows > 0
    },

    async remove(query) {
      assertScoped(query, 'store.remove')
      await pool.query('DELETE FROM ap_cloud_session_entry WHERE username = ? AND session_key = ?', [query.username, query.sessionKey])
      const [result] = await pool.query('DELETE FROM ap_cloud_session WHERE username = ? AND session_key = ?', [query.username, query.sessionKey])
      return result.affectedRows > 0
    },

    async close() {
      // 池是借来的就别关：storage 还在用它存项目、作品、账号
      if (ownsPool) await pool.end()
    },
  }
}

/**
 * 会话存储。**只有 MySQL 一种**，所以这里没有分支 —— 保留这个工厂是为了
 * 让调用方不必关心池是借来的还是自己建的。
 */
export async function createSessionStore({ config, logger, pool = null }) {
  return createMysqlStore({ config, logger, pool })
}
