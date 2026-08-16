/**
 * 会话列表的翻页游标。
 *
 * ── 为什么是 keyset 而不是 OFFSET ───────────────────────────────────────
 *
 * `LIMIT ? OFFSET ?` 在这张表上是错的，不只是慢：列表按 `updated_at DESC` 排，
 * 而**每说一句话就会有一条记录跳到最前面**。用户翻到第二页的那半秒里若有一轮
 * 对话结束，整个序列右移一格 —— 他会重新看到第一页最后那条，而真正的第 21 条
 * 被跳过了。分页里最难查的一类 bug 正是这种"偶尔少一条"。
 *
 * keyset（也叫 seek）翻页把"我看到哪儿了"编码成**排序键本身**，而不是序号。
 * 序列怎么变都不影响：下一页永远是"排在这个位置之后的那些"。
 *
 * ── 排序键为什么是三段 ──────────────────────────────────────────────────
 *
 * 列表的序是 `pinned DESC, updated_at DESC`，但这两个**加起来仍然不唯一** ——
 * 同一秒里更新的两条会话（批量归档、一次 patch 改多条）会撞在一起。
 * 键不唯一的 keyset 翻页会在边界上要么漏、要么重。所以补上 `session_key`
 * 当决胜键：它在一个人的范围内是主键的一半，天然唯一。
 *
 * 游标本身不加密也不签名：它编码的是**用户自己那一页的位置**，
 * 伪造它最多是翻到自己数据的另一个位置。真正的隔离在 SQL 的 `username = ?` 上。
 *
 * ── 与 src/persistence/page.js 的分工 ───────────────────────────────────
 *
 * 「一页多大」「游标怎么编成 base64url」这些与**翻什么**无关，管理台也要用，
 * 所以搬去了 persistence/page.js，这里只 re-export（导入路径不变，
 * 全库只有一处定义，调上限时不会漏掉一边）。留在这个文件里的是会话独有的：
 * `(pinned, updated_at, session_key)` 这个三段排序键怎么展开成 SQL。
 */
import { decodeCursor as decodeBase, encodeCursor as encodeBase } from '../persistence/page.js'

export { PAGE_DEFAULT, PAGE_MAX, normalizeLimit } from '../persistence/page.js'

/**
 * 把一行编码成游标。
 * @returns {string} base64url，前端原样带回来即可
 */
export function encodeCursor(row) {
  if (!row) return ''
  return encodeBase({
    p: row.pinned ? 1 : 0,
    u: new Date(row.updatedAt || row.updated_at).getTime(),
    k: row.sessionKey || row.session_key,
  })
}

/**
 * 解开游标。**解不开就当没有**（回 null，也就是从头开始）。
 *
 * 不抛错是有意的：游标会经过地址栏、会被收藏、会在版本升级后被带回来。
 * 为一个过期或截断的游标回 400，用户看到的是"列表打不开了"，
 * 而他能做的只有清缓存 —— 退回第一页是个明显更好的降级。
 */
export function decodeCursor(raw) {
  const parsed = decodeBase(
    raw,
    (value) => Number.isFinite(Number(value.u)) && typeof value.k === 'string' && Boolean(value.k),
  )
  if (!parsed) return null
  return { pinned: parsed.p ? 1 : 0, updatedAt: Number(parsed.u), sessionKey: parsed.k }
}

/**
 * 游标 → SQL 片段。
 *
 * 这段展开的是"在 (pinned, updated_at, session_key) 这个三元组的降序里，
 * 严格排在游标之后"。写成一条 `(a,b,c) < (?,?,?)` 的行值比较更短，
 * 但 MySQL 对行值比较用不上索引 —— 展开成 OR 才走得到 idx_username_updated。
 *
 * @returns {{ sql: string, params: any[] }}
 */
export function cursorClause(cursor) {
  if (!cursor) return { sql: '', params: [] }
  const updatedAt = new Date(cursor.updatedAt)
  return {
    sql: '(pinned < ? OR (pinned = ? AND updated_at < ?) OR (pinned = ? AND updated_at = ? AND session_key < ?))',
    params: [cursor.pinned, cursor.pinned, updatedAt, cursor.pinned, updatedAt, cursor.sessionKey],
  }
}
