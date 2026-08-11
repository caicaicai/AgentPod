/**
 * 会话存储：文件驱动。
 *
 * 重点在三件事：
 *   1. **只追加** —— 每轮重写整段会话在长会话上是每轮几 MB 的无谓 IO
 *   2. **隔离** —— 所有读写必须带 username（隔离契约 #4）
 *   3. **标题不被覆盖** —— save 每轮都带候选标题，用户改过的名字不能被悄悄改回去
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createFileStore } from '../src/sessions/file-store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

/** 造一段像样的 pi JSONL */
function jsonl(...texts) {
  return texts
    .map((text, index) => JSON.stringify({
      type: 'message',
      timestamp: 1700000000000 + index * 1000,
      message: { role: index % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text }] },
    }))
    .join('\n') + '\n'
}

let root
let store
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ap-sess-'))
  store = createFileStore({ config: { dataDir: root }, logger: silentLogger })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('基本读写', () => {
  test('存下来的会话重启也还在（这正是 memory 驱动做不到的那件事）', async () => {
    await store.save({ username: 'zhangsan', sessionKey: 'main', sessionId: 's1', jsonl: jsonl('你好'), entryCount: 1, title: '你好' })

    // 换一个 store 实例 = 模拟进程重启
    const reborn = createFileStore({ config: { dataDir: root }, logger: silentLogger })
    const row = await reborn.load({ username: 'zhangsan', sessionKey: 'main' })
    assert.equal(row.sessionId, 's1')
    assert.equal(row.title, '你好')
    assert.match(row.jsonl, /你好/)
  })

  test('不存在的会话回 null，不抛', async () => {
    assert.equal(await store.load({ username: 'zhangsan', sessionKey: 'nope' }), null)
    assert.deepEqual(await store.list({ username: 'newcomer' }), [], '新用户还没有目录，应回空数组')
  })

  test('缺 username 一律拒绝 —— 隔离契约 #4 在接口层就挡住', async () => {
    for (const call of [
      () => store.load({ sessionKey: 'main' }),
      () => store.save({ sessionKey: 'main', jsonl: '' }),
      () => store.list({}),
      () => store.rename({ sessionKey: 'main', title: 'x' }),
      () => store.remove({ sessionKey: 'main' }),
      () => store.patch({ sessionKey: 'main', pinned: true }),
      () => store.search({ q: 'x' }),
    ]) {
      await assert.rejects(call, /缺少 username/)
    }
  })
})

describe('只追加', () => {
  test('第二轮只写新增的行，不重写整段', async () => {
    const username = 'zhangsan'
    await store.save({ username, sessionKey: 'main', sessionId: 's1', jsonl: jsonl('一'), entryCount: 1 })
    const file = path.join(root, 'users', username, 'sessions', 'main', 'session.jsonl')
    const firstInode = (await stat(file)).ino

    await store.save({ username, sessionKey: 'main', sessionId: 's1', jsonl: jsonl('一', '二', '三'), entryCount: 3 })

    const content = await readFile(file, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    assert.equal(lines.length, 3, '应该是 3 行，多了说明重复追加了')
    assert.equal((await stat(file)).ino, firstInode, '文件应被原地追加，而不是整体重写')
    // 第一行必须还是原来那一条（没被覆盖过）
    assert.match(lines[0], /一/)
  })

  test('同一段内容反复 save 不会把历史写重', async () => {
    const username = 'zhangsan'
    const body = jsonl('一', '二')
    await store.save({ username, sessionKey: 'main', sessionId: 's1', jsonl: body, entryCount: 2 })
    await store.save({ username, sessionKey: 'main', sessionId: 's1', jsonl: body, entryCount: 2 })
    const row = await store.load({ username, sessionKey: 'main' })
    assert.equal(row.jsonl.split('\n').filter(Boolean).length, 2)
  })
})

describe('标题', () => {
  test('用户改过的名字不会被下一轮的候选标题覆盖', async () => {
    const username = 'zhangsan'
    await store.save({ username, sessionKey: 'main', sessionId: 's1', jsonl: jsonl('一'), entryCount: 1, title: '第一句' })
    await store.rename({ username, sessionKey: 'main', title: '我自己起的名字' })
    await store.save({ username, sessionKey: 'main', sessionId: 's1', jsonl: jsonl('一', '二'), entryCount: 2, title: '第二句' })

    const row = await store.load({ username, sessionKey: 'main' })
    assert.equal(row.title, '我自己起的名字')
  })

  test('rename 不存在的会话回 false', async () => {
    assert.equal(await store.rename({ username: 'zhangsan', sessionKey: 'nope', title: 'x' }), false)
  })
})

describe('置顶 / 归档 / 项目归属', () => {
  beforeEach(async () => {
    for (const key of ['a', 'b', 'c']) {
      await store.save({ username: 'zhangsan', sessionKey: key, sessionId: key, jsonl: jsonl(key), entryCount: 1, title: key })
      // 拉开 updatedAt，否则排序结果不稳定
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })

  test('置顶的排最前，其余按最近更新', async () => {
    await store.patch({ username: 'zhangsan', sessionKey: 'a', pinned: true })
    const list = await store.list({ username: 'zhangsan' })
    assert.equal(list[0].sessionKey, 'a')
    assert.equal(list[1].sessionKey, 'c', 'c 最后写，应排在 b 前面')
  })

  test('置顶不改 updatedAt —— 它表达的是"最近聊过"，不是"刚点了个按钮"', async () => {
    const before = (await store.load({ username: 'zhangsan', sessionKey: 'a' })).updatedAt
    await new Promise((resolve) => setTimeout(resolve, 10))
    await store.patch({ username: 'zhangsan', sessionKey: 'a', pinned: true })
    assert.equal((await store.load({ username: 'zhangsan', sessionKey: 'a' })).updatedAt, before)
  })

  test('归档的默认不在列表里，includeArchived 才出来', async () => {
    await store.patch({ username: 'zhangsan', sessionKey: 'b', archived: true })
    assert.equal((await store.list({ username: 'zhangsan' })).length, 2)
    assert.equal((await store.list({ username: 'zhangsan', includeArchived: true })).length, 3)
  })

  test('按项目过滤：不传=全部，传空串=只要未分组', async () => {
    await store.patch({ username: 'zhangsan', sessionKey: 'a', projectId: 'p1' })
    assert.equal((await store.list({ username: 'zhangsan' })).length, 3, '不传 projectId 应回全部')
    assert.equal((await store.list({ username: 'zhangsan', projectId: 'p1' })).length, 1)
    assert.equal((await store.list({ username: 'zhangsan', projectId: '' })).length, 2, '空串应只回未分组的')
  })

  test('save 不会把已有的项目归属冲掉', async () => {
    await store.patch({ username: 'zhangsan', sessionKey: 'a', projectId: 'p1' })
    await store.save({ username: 'zhangsan', sessionKey: 'a', sessionId: 'a', jsonl: jsonl('a', 'a2'), entryCount: 2 })
    assert.equal((await store.load({ username: 'zhangsan', sessionKey: 'a' })).projectId, 'p1')
  })
})

describe('搜索', () => {
  beforeEach(async () => {
    await store.save({
      username: 'zhangsan', sessionKey: 's1', sessionId: 's1', entryCount: 2,
      jsonl: jsonl('结算中台今天的告警怎么处理', '建议先看看限流配置'), title: '结算中台告警',
    })
    await store.save({
      username: 'zhangsan', sessionKey: 's2', sessionId: 's2', entryCount: 2,
      jsonl: jsonl('帮我看看这段代码', '这里有个空指针风险'), title: '看代码',
    })
  })

  test('标题命中', async () => {
    const hits = await store.search({ username: 'zhangsan', q: '告警' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].matchedIn, 'title')
  })

  test('正文命中并给出可读片段（不是转义后的 JSON）', async () => {
    const hits = await store.search({ username: 'zhangsan', q: '空指针' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].sessionKey, 's2')
    assert.equal(hits[0].matchedIn, 'content')
    assert.match(hits[0].snippet, /这里有个空指针风险/)
    assert.doesNotMatch(hits[0].snippet, /"type"|"text":/, '片段里不该出现 JSON 结构')
  })

  test('空关键词回空数组，而不是把所有会话都倒出来', async () => {
    assert.deepEqual(await store.search({ username: 'zhangsan', q: '   ' }), [])
  })

  test('搜不到别人的会话', async () => {
    await store.save({ username: 'lisi', sessionKey: 'x', sessionId: 'x', jsonl: jsonl('结算中台的秘密'), entryCount: 1 })
    const hits = await store.search({ username: 'zhangsan', q: '秘密' })
    assert.equal(hits.length, 0)
  })
})

describe('跨用户隔离', () => {
  test('同名 sessionKey 落在各自的目录里，互不可见', async () => {
    await store.save({ username: 'zhangsan', sessionKey: 'main', sessionId: 'a', jsonl: jsonl('张三的秘密'), entryCount: 1 })
    await store.save({ username: 'lisi', sessionKey: 'main', sessionId: 'b', jsonl: jsonl('李四的秘密'), entryCount: 1 })

    const zhangsan = await store.load({ username: 'zhangsan', sessionKey: 'main' })
    assert.match(zhangsan.jsonl, /张三的秘密/)
    assert.doesNotMatch(zhangsan.jsonl, /李四/)
    assert.equal((await store.list({ username: 'zhangsan' })).length, 1)
  })

  test('sessionKey 拼不出越界路径', async () => {
    await assert.rejects(
      () => store.load({ username: 'zhangsan', sessionKey: '../../lisi/sessions/main' }),
      /不能作为目录名/,
    )
  })

  test('删除只删自己那一份', async () => {
    await store.save({ username: 'zhangsan', sessionKey: 'main', sessionId: 'a', jsonl: jsonl('x'), entryCount: 1 })
    await store.save({ username: 'lisi', sessionKey: 'main', sessionId: 'b', jsonl: jsonl('y'), entryCount: 1 })
    assert.equal(await store.remove({ username: 'zhangsan', sessionKey: 'main' }), true)
    assert.equal(await store.load({ username: 'zhangsan', sessionKey: 'main' }), null)
    assert.notEqual(await store.load({ username: 'lisi', sessionKey: 'main' }), null)
  })

  test('删不存在的会话回 false（而不是假装删掉了）', async () => {
    assert.equal(await store.remove({ username: 'zhangsan', sessionKey: 'nope' }), false)
  })
})
