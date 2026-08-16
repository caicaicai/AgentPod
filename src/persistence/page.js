/**
 * 翻页的公共部件：一页多大、游标怎么编解码。
 *
 * ── 为什么要有这么一个文件 ──────────────────────────────────────────────
 *
 * 这套东西最早只长在会话列表上（src/sessions/cursor.js）。管理台要分页时，
 * 摆在面前的是两条路：从 `sessions/` 里 import 一个叫 cursor 的东西（于是账号
 * 存储反向依赖了会话模块，只因为那里先写了一个 `normalizeLimit`），
 * 或者在管理台再抄一份。
 *
 * 两条都不好，而且坏在同一个地方：**上限会漂**。抄一份的话，哪天有人把会话那边
 * 的 PAGE_MAX 从 200 调到 500，管理台还是 200，而"为什么这个列表翻不动"要查两个
 * 文件才看得出来。所以把与"翻页"本身有关、与"翻什么"无关的那几样搬到这里，
 * 会话那边改成从这儿 re-export —— **全库只有一处定义**。
 *
 * 留在 sessions/cursor.js 的是会话独有的那部分：三段排序键的展开
 * （pinned / updated_at / session_key）。那个跟这里没有关系。
 *
 * ── 游标不签名，也不加密 ────────────────────────────────────────────────
 *
 * 它编码的只是"我看到哪儿了"。伪造它最多是翻到另一个位置，翻不出权限：
 * 真正的边界在 SQL 的 `username = ?` 上（用户数据），以及路由里那句
 * `role !== 'admin'` 上（管理台）。为它上签名等于给一个不是边界的东西
 * 加一层要维护的密钥。
 */

/** 一页最多多少条，以及不传 limit 时给多少 */
export const PAGE_MAX = 200
export const PAGE_DEFAULT = 50

/**
 * 收口客户端传来的 limit。给个上限，免得一条 `?limit=1000000` 把内存拉满。
 *
 * 非法输入（负数、NaN、`'; DROP TABLE'`）一律退回默认值而**不报错**：
 * 这是个查询参数，为它回一条 400 只是让人多点一次。
 */
export function normalizeLimit(raw, fallback = PAGE_DEFAULT) {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), PAGE_MAX)
}

/**
 * 把一个小对象编成游标。**空值编出空串**（= 没有下一页）。
 *
 * @param {object|null} payload 排序键的那几个字段，键名尽量短 —— 它要进 URL
 * @returns {string} base64url，调用方原样带回来即可
 */
export function encodeCursor(payload) {
  if (!payload) return ''
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

/**
 * 解开游标。**解不开就当没有**（回 null，也就是从头开始），不抛错。
 *
 * 不抛错是有意的：游标会经过地址栏、会被收藏、会在一次版本升级之后被带回来。
 * 为一个过期或者截断的游标回 400，用户看到的是"这个列表打不开了"，
 * 而他能做的只有清缓存 —— 退回第一页是个明显更好的降级。
 *
 * @param {string} raw
 * @param {(parsed: object) => boolean} [validate] 形状检查。**必须传**一个真的
 *   会挑剔的判据：解出来是合法 JSON 不等于它是这张表的游标（换了个列表把上一个
 *   列表的游标粘过来，字段全对不上，但 JSON.parse 不会有意见）。
 */
export function decodeCursor(raw, validate = () => true) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return validate(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 「多取一条」的收尾，所有 keyset 分页共用。
 *
 * 为什么是多取一条而不是 `COUNT(*)`：调用方真正想知道的从来不是"总共几条"，
 * 是"还要不要画那个『加载更多』"。而 COUNT 要多扫一遍全表去回答一个
 * 只需要一个布尔的问题。
 *
 * ⚠️ 调用方**不要**靠 `items.length < limit` 判断到底 —— 那在"最后一页恰好
 * 装满"时会多问一次空页，而且这里的 items 还可能因为坏记录被过滤掉几条，
 * 那时候它连"装没装满"都算不准。`hasMore` 是唯一权威。
 *
 * ⚠️ 它**不负责编码**：`toCursor` 回什么，`nextCursor` 就是什么。
 * 排序键只有一段（比如 `ap_kv` 按 id 翻页）时那就是一个 id 字符串，存储层内部
 * 直接拿它当下一页的起点用，白白 base64 一道只会让日志里那一行没法读；
 * 排序键有好几段（用量表的 段 + token 数 + 名字）时上层再 `encodeCursor` 一下
 * 交给浏览器。**到底要不要编码，是"这个游标要不要出网"决定的，不是这里。**
 *
 * @param {any[]} rows      查询回来的行，长度最多 limit + 1
 * @param {number} limit    这一页要几条
 * @param {(row: any) => any} toCursor 拿这一页最后一行算出下一页的游标
 * @returns {{ page: any[], hasMore: boolean, nextCursor: any }} 没有下一页时 `''`
 */
export function finishPage(rows, limit, toCursor) {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return {
    page,
    hasMore,
    nextCursor: hasMore && page.length ? toCursor(page[page.length - 1]) : '',
  }
}

/**
 * `LIKE` 的通配符转义。
 *
 * 参数化查询挡的是注入，**挡不住通配符**：用户在搜索框里打一个 `%`，
 * 拼进 `LIKE '%…%'` 之后就是"匹配全部" —— 一次本该缩小范围的搜索
 * 反而把整张表捞了回来。下划线同理（它是"任意一个字符"）。
 *
 * 转义符显式声明成 `\`（SQL 里要写成 `ESCAPE '\\'`），别指望默认值：
 * 它在不同的 SQL 模式下不一样。
 */
export function escapeLike(input) {
  return String(input ?? '').replace(/[\\%_]/g, (char) => `\\${char}`)
}
