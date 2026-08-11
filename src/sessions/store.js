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

export function createMemoryStore() {
  const rows = new Map() // `${username}::${sessionKey}` -> row

  return {
    driver: 'memory',
    async load(query) {
      assertScoped(query, 'store.load')
      return rows.get(`${query.username}::${query.sessionKey}`) || null
    },
    async save(row) {
      assertScoped(row, 'store.save')
      const key = `${row.username}::${row.sessionKey}`
      const existing = rows.get(key)
      rows.set(key, {
        username: row.username,
        sessionKey: row.sessionKey,
        sessionId: row.sessionId,
        jsonl: row.jsonl,
        entryCount: row.entryCount,
        // 已有标题永远优先：save 每轮都会带一个"从本轮提问推出来的"候选标题，
        // 若它能覆盖，用户改过的名字会在下一轮对话后被悄悄改回去。
        title: existing?.title || normalizeTitle(row.title),
        projectId: existing?.projectId || row.projectId || '',
        pinned: Boolean(existing?.pinned),
        archived: Boolean(existing?.archived),
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
      })
    },

    async rename(query) {
      assertScoped(query, 'store.rename')
      const row = rows.get(`${query.username}::${query.sessionKey}`)
      if (!row) return false
      row.title = normalizeTitle(query.title)
      return true
    },
    async list(query) {
      assertScoped(query, 'store.list')
      return [...rows.values()]
        .filter((row) => row.username === query.username)
        .filter((row) => query.projectId === undefined || (row.projectId || '') === (query.projectId || ''))
        .filter((row) => query.includeArchived || !row.archived)
        .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt))
        .map(({ jsonl, ...rest }) => rest) // 列表不带正文
    },
    async remove(query) {
      assertScoped(query, 'store.remove')
      return rows.delete(`${query.username}::${query.sessionKey}`)
    },

    /** 与 file 驱动同签名，见 sessions/file-store.js 的说明 */
    async patch(query) {
      assertScoped(query, 'store.patch')
      const row = rows.get(`${query.username}::${query.sessionKey}`)
      if (!row) return null
      if (query.title !== undefined) { row.title = normalizeTitle(query.title); row.updatedAt = Date.now() }
      if (query.pinned !== undefined) row.pinned = Boolean(query.pinned)
      if (query.archived !== undefined) row.archived = Boolean(query.archived)
      if (query.projectId !== undefined) row.projectId = String(query.projectId || '')
      const { jsonl, ...rest } = row
      return rest
    },

    async search(query) {
      assertScoped(query, 'store.search')
      const keyword = String(query.q || '').trim().toLowerCase()
      if (!keyword) return []
      const hits = []
      for (const row of [...rows.values()].filter((item) => item.username === query.username)) {
        const { jsonl, ...rest } = row
        if ((row.title || '').toLowerCase().includes(keyword)) {
          hits.push({ ...rest, matchedIn: 'title', snippet: '' })
          continue
        }
        const at = String(jsonl || '').toLowerCase().indexOf(keyword)
        if (at < 0) continue
        hits.push({
          ...rest,
          matchedIn: 'content',
          snippet: jsonl.slice(Math.max(0, at - 40), at + keyword.length + 60).replace(/\s+/g, ' '),
        })
      }
      return hits
        .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt))
        .slice(0, query.limit || 50)
    },
  }
}

/**
 * MySQL 实现骨架：表结构见 ./schema.sql。
 * 只追加新增的 JSONL 行（按已存行数比对），避免每轮重写整段会话。
 * mysql2 是可选依赖，用不到 mysql 时不必安装。
 */
export async function createMysqlStore({ config, logger }) {
  let mysql
  try {
    mysql = await import('mysql2/promise')
  } catch {
    throw new Error('SESSION_STORE=mysql 需要安装可选依赖 mysql2：npm i mysql2')
  }

  const pool = mysql.createPool({
    host: config.sessions.mysql.host,
    port: config.sessions.mysql.port,
    user: config.sessions.mysql.user,
    password: config.sessions.mysql.password,
    database: config.sessions.mysql.database,
    connectionLimit: 10,
    charset: 'utf8mb4',
    timezone: 'Z',
  })

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
      await pool.end()
    },
  }
}

export async function createSessionStore({ config, logger }) {
  if (config.sessions.driver === 'mysql') return createMysqlStore({ config, logger })
  if (config.sessions.driver === 'file') {
    // 动态 import：memory / mysql 部署不需要为了一个用不到的驱动去解析文件存储那套依赖
    const { createFileStore } = await import('./file-store.js')
    return createFileStore({ config, logger })
  }
  return createMemoryStore()
}
