/**
 * 用量表要的「账号侧」两个回调，用一个现成的数组顶上。
 *
 * ── 为什么用例需要这么一个东西 ──────────────────────────────────────────
 *
 * `usage.summary()` 从前收的是一份**取好的账号清单**（`accounts: [...]`）。
 * 那个签名本身就是问题的一部分：它要求调用方先把全部账号取出来，
 * 而管理台打开一次用量页就是一次全表搬运。现在它收的是两个回调
 * （`page` 翻页、`many` 按名字批量取），于是用量那一层可以按需一页一页地要。
 *
 * 用例里没有真的账号存储，也不该为了测一句金额去搭一个 —— 这个函数就是那层壳：
 * 给它一个数组，它表现得像一个**按用户名升序、支持 keyset 翻页**的账号存储。
 *
 * ⚠️ 翻页语义要与真的那个一致（`cursor` 是"上一页最后一个用户名"，
 * 取的是**严格大于**它的那些），否则用例会在一个替身自己编出来的语义上全绿。
 */
import { PAGE_DEFAULT, finishPage } from '../../src/persistence/page.js'

export function fakeAccounts(list = []) {
  const sorted = [...list]
    .map((account) => ({ role: 'user', disabled: false, ...account }))
    .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0))

  return {
    async page({ cursor = '', limit = PAGE_DEFAULT } = {}) {
      const rest = cursor ? sorted.filter((account) => account.username > String(cursor)) : sorted
      const { page, hasMore, nextCursor } = finishPage(
        rest.slice(0, limit + 1),
        limit,
        (account) => account.username,
      )
      return { items: page, hasMore, nextCursor }
    },

    async many(usernames) {
      const want = new Set((usernames || []).map(String))
      return sorted.filter((account) => want.has(account.username))
    },
  }
}
