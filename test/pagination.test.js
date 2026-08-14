/**
 * 会话列表的 keyset 翻页。
 *
 * 从前这里是一句硬编的 `LIMIT 200`，没有任何续页手段 —— 重度用户的第 201 条
 * 对话就此再也翻不到，而且**是静默的**：既没有"没有更多了"也没有"还有更多"，
 * 界面上看起来他就只有 200 条。
 *
 * 用 keyset 而不是 OFFSET，是因为这张表按 `updated_at DESC` 排，而每说一句话
 * 就会有一条记录跳到最前面。OFFSET 翻页在那半秒里会整体右移一格 ——
 * 用户重新看到上一页的最后一条，而真正的下一条被跳过了。
 * 分页里最难查的一类 bug 正是这种"偶尔少一条"，所以下面专门有一条钉它。
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { encodeCursor, decodeCursor, cursorClause, normalizeLimit, PAGE_MAX } from '../src/sessions/cursor.js'
import { createMemorySessionStore } from './helpers/memory-session-store.js'

describe('游标编解码', () => {
  test('编进去什么就解出什么', () => {
    const cursor = encodeCursor({ pinned: true, updatedAt: 1_700_000_000_000, sessionKey: 's_abc' })
    assert.deepEqual(decodeCursor(cursor), { pinned: 1, updatedAt: 1_700_000_000_000, sessionKey: 's_abc' })
  })

  test('两种行形状都认 —— SQL 回的是蛇形列名，替身回的是驼峰', () => {
    const fromSql = decodeCursor(encodeCursor({ pinned: 0, updated_at: new Date(1_700_000_000_000), session_key: 'k' }))
    assert.equal(fromSql.updatedAt, 1_700_000_000_000)
    assert.equal(fromSql.sessionKey, 'k')
  })

  /**
   * 解不开就退回第一页，**不抛错**。游标会经过地址栏、会被收藏、会在版本升级
   * 之后被带回来 —— 为一个过期的游标回 400，用户看到的是"列表打不开了"，
   * 而他能做的只有清缓存。
   */
  test('坏游标一律当没有，而不是报错', () => {
    for (const bad of ['', null, undefined, 'not-base64!!', Buffer.from('{}').toString('base64url'),
      Buffer.from('{"u":"x","k":"a"}').toString('base64url'),
      Buffer.from('{"u":1,"k":""}').toString('base64url')]) {
      assert.equal(decodeCursor(bad), null, `${bad} 该被当成没有游标`)
    }
  })

  test('SQL 片段展开成 OR —— 行值比较用不上索引', () => {
    const { sql, params } = cursorClause({ pinned: 1, updatedAt: 1000, sessionKey: 'k' })
    assert.match(sql, /pinned < \?/)
    assert.match(sql, /pinned = \? AND updated_at < \?/)
    assert.match(sql, /pinned = \? AND updated_at = \? AND session_key < \?/)
    assert.equal(params.length, 6)
  })

  test('没有游标就没有片段', () => {
    assert.deepEqual(cursorClause(null), { sql: '', params: [] })
  })
})

describe('limit 收口', () => {
  test('不传给默认值', () => {
    assert.equal(normalizeLimit(undefined), 50)
    assert.equal(normalizeLimit(''), 50)
  })

  test('有上限 —— 一条 ?limit=1000000 不该把内存拉满', () => {
    assert.equal(normalizeLimit(1_000_000), PAGE_MAX)
  })

  test('负数、零、非数字都退回默认值', () => {
    for (const bad of [-1, 0, 'abc', NaN, Infinity]) assert.equal(normalizeLimit(bad), 50)
  })

  test('小数取整', () => {
    assert.equal(normalizeLimit(10.9), 10)
  })
})

describe('翻页', () => {
  let store

  /** 造 n 条会话，updatedAt 递增（所以列表里是倒序） */
  async function seed(n, { username = 'alice' } = {}) {
    for (let i = 0; i < n; i += 1) {
      await store.save({
        username, sessionKey: `s${String(i).padStart(3, '0')}`, sessionId: `id${i}`,
        jsonl: '', entryCount: 1, title: `第 ${i} 条`,
      })
      // save 用 Date.now()，同一毫秒里造出来的会撞在一起 —— 那正是决胜键要解决的，
      // 但这一组用例要的是**确定的**顺序，所以手工把时间掰开
      const row = await store.load({ username, sessionKey: `s${String(i).padStart(3, '0')}` })
      row.updatedAt = 1_700_000_000_000 + i * 1000
    }
  }

  /** 一页一页翻到底，回所有条目 */
  async function drain(query) {
    const all = []
    let cursor = ''
    let guard = 0
    do {
      const page = await store.list({ ...query, cursor })
      all.push(...page.items)
      cursor = page.nextCursor
      guard += 1
      assert.ok(guard < 100, '翻页没有收敛 —— 多半是游标没往前走')
    } while (cursor)
    return all
  }

  beforeEach(() => { store = createMemorySessionStore() })

  test('翻完拿到全部，且一条不重不漏', async () => {
    await seed(25)
    const all = await drain({ username: 'alice', limit: 10 })

    assert.equal(all.length, 25)
    assert.equal(new Set(all.map((row) => row.sessionKey)).size, 25, '不该有重复')
  })

  test('nextCursor 为空才是到底，不靠"这一页装满了没"判断', async () => {
    await seed(20)
    // 20 条、每页 10：第二页恰好装满，但后面没有了 —— 这时 hasMore 必须是 false
    const first = await store.list({ username: 'alice', limit: 10 })
    assert.equal(first.hasMore, true)

    const second = await store.list({ username: 'alice', limit: 10, cursor: first.nextCursor })
    assert.equal(second.items.length, 10)
    assert.equal(second.hasMore, false, '最后一页恰好装满时不该说还有更多')
    assert.equal(second.nextCursor, '')
  })

  test('置顶的排在最前，翻页跨过分界线也不乱', async () => {
    await seed(12)
    await store.patch({ username: 'alice', sessionKey: 's000', pinned: true })
    await store.patch({ username: 'alice', sessionKey: 's001', pinned: true })

    const all = await drain({ username: 'alice', limit: 5 })
    assert.equal(all.length, 12)
    assert.deepEqual(all.slice(0, 2).map((row) => row.pinned), [true, true], '置顶的该在最前面')
    assert.ok(all.slice(2).every((row) => !row.pinned))
  })

  /**
   * 这一条就是 OFFSET 翻页那个 bug 的最小复现。
   *
   * 翻页途中有一条会话被更新（跳到列表最前面）。OFFSET 的话，整个序列右移一格，
   * 第二页会重新给出第一页的最后一条，而真正的下一条被跳过。
   * keyset 把位置编码成排序键本身，序列怎么变都不影响"排在这个位置之后的是谁"。
   */
  test('翻页途中有会话被更新，也不会漏掉任何一条', async () => {
    await seed(20)

    const first = await store.list({ username: 'alice', limit: 10 })
    assert.equal(first.items.length, 10)

    // 最老的那条被更新了，跳到列表最前面 —— 序列整体右移
    await store.patch({ username: 'alice', sessionKey: 's000', title: '刚聊过' })

    const second = await store.list({ username: 'alice', limit: 10, cursor: first.nextCursor })

    const seen = [...first.items, ...second.items].map((row) => row.sessionKey)
    // s000 跳到了第一页之前，所以这一趟看不到它 —— 但**其余 19 条一条都不能少**
    const missing = Array.from({ length: 20 }, (_, i) => `s${String(i).padStart(3, '0')}`)
      .filter((key) => key !== 's000' && !seen.includes(key))
    assert.deepEqual(missing, [], `漏掉了 ${missing.join(', ')}`)
  })

  test('翻页不会串到别人的数据上', async () => {
    await seed(15, { username: 'alice' })
    await seed(15, { username: 'bob' })

    const all = await drain({ username: 'alice', limit: 5 })
    assert.equal(all.length, 15)
    assert.ok(all.every((row) => row.username === 'alice'))
  })

  test('按项目过滤时翻页照常', async () => {
    await seed(12)
    for (let i = 0; i < 5; i += 1) {
      await store.patch({ username: 'alice', sessionKey: `s${String(i).padStart(3, '0')}`, projectId: 'p1' })
    }

    const inProject = await drain({ username: 'alice', projectId: 'p1', limit: 2 })
    assert.equal(inProject.length, 5)
    assert.ok(inProject.every((row) => row.projectId === 'p1'))
  })

  test('空列表回一个干净的空页，而不是 undefined', async () => {
    const page = await store.list({ username: 'nobody' })
    assert.deepEqual(page.items, [])
    assert.equal(page.hasMore, false)
    assert.equal(page.nextCursor, '')
  })
})
