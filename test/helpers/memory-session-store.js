/**
 * 会话存储的**测试替身**：全在内存里。
 *
 * 与 test/helpers/memory-storage.js 同一个道理 —— 生产只有 MySQL 一种会话驱动
 * （见 src/sessions/store.js），但 HTTP 层的用例大多只是"要有一个 store 能塞进去"，
 * 不该为此要求每个人先起一个数据库。
 *
 * 这份实现原来就住在 src/sessions/store.js 里（`SESSION_STORE=memory` 驱动）。
 * 只支持数据库之后它从生产代码里删掉了，原样搬到这儿继续给测试用。
 */
import { normalizeTitle } from '../../src/sessions/store.js'
// 游标编解码与真实驱动共用同一份 —— 替身自己实现一套的话，
// 两边的翻页语义会慢慢长歪，而用例照样全绿
import { encodeCursor, decodeCursor, normalizeLimit } from '../../src/sessions/cursor.js'

/**
 * 与 src/sessions/store.js 里那个同名函数一致（那边没导出）。
 * **别把它省掉**：隔离契约 #4 要求所有会话读写都带 username，
 * 替身不检查的话，"忘了带 username"这类 bug 会在测试里一路绿灯。
 */
function assertScoped(query, where) {
  if (!query?.username) throw new Error(`${where}: 缺少 username —— 会话读写必须按用户隔离（隔离契约 #4）`)
}

export function createMemorySessionStore() {
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
    /**
     * 与 mysql 驱动同契约：回 `{ items, nextCursor, hasMore }`，keyset 翻页。
     *
     * 替身也要**真的翻页**，不能图省事一次性全回。契约里"到底了 nextCursor
     * 才为空"这条，只有替身也照做，用例才有可能发现调用方漏翻页的错 ——
     * 而漏翻页的表现（删项目时只摘干净了前 50 条）在生产上极难注意到。
     *
     * 排序键与真实驱动逐字对齐，包括第三段的决胜键 sessionKey。
     */
    async list(query) {
      assertScoped(query, 'store.list')
      const all = [...rows.values()]
        .filter((row) => row.username === query.username)
        .filter((row) => query.projectId === undefined || (row.projectId || '') === (query.projectId || ''))
        .filter((row) => query.includeArchived || !row.archived)
        .sort((a, b) => (Number(b.pinned) - Number(a.pinned))
          || (b.updatedAt - a.updatedAt)
          || b.sessionKey.localeCompare(a.sessionKey))
        .map(({ jsonl, ...rest }) => rest) // 列表不带正文

      const cursor = decodeCursor(query.cursor)
      const after = cursor
        ? all.filter((row) => {
          const pinned = row.pinned ? 1 : 0
          if (pinned !== cursor.pinned) return pinned < cursor.pinned
          if (row.updatedAt !== cursor.updatedAt) return row.updatedAt < cursor.updatedAt
          return row.sessionKey < cursor.sessionKey
        })
        : all

      const limit = normalizeLimit(query.limit)
      const hasMore = after.length > limit
      const items = after.slice(0, limit)
      return { items, hasMore, nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : '' }
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
