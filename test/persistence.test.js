/**
 * 文件存储底座（persistence/）。
 *
 * 这里每一条测的都是"坏了会安静地坏"的地方：
 *   1. **并发丢更新** —— read-modify-write 在 async 里天然撕裂，只在并发时出错
 *   2. **跨用户越界** —— username / id 都会成为路径的一段
 *   3. **坏文件** —— 一条记录损坏不该让整个清单打不开
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createFileMap, createScopedMaps } from '../src/persistence/file-map.js'
import { assertSegment, safeJoin } from '../src/persistence/paths.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

let root
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ap-persist-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('路径收口', () => {
  test('越界的段名一律拒绝', () => {
    for (const bad of ['..', '.', 'a/b', '../etc', '', 'a'.repeat(65), 'a b']) {
      assert.throws(() => assertSegment(bad, 'x'), /不能作为目录名/, `应拒绝：${JSON.stringify(bad)}`)
    }
  })

  test('safeJoin 在解析之后判边界 —— 编码与多重分隔符都摊平了才算数', () => {
    /**
     * 根要先 `resolve` 一次。
     *
     * safeJoin 内部拿 `path.resolve(root, ...)` 的结果去比 `root` 前缀，所以传进去的
     * root 必须已经是**本平台的绝对路径**。直接写 `'/data'` 在 Windows 上会解析成
     * `C:\data\a\b`，而前缀比的是字面量 `/data` —— 于是一次完全正常的拼接被判成越界，
     * 报错还是"路径越界：a/b"，看着像被测代码有 bug。
     */
    const ROOT = path.resolve('/data')
    assert.throws(() => safeJoin(ROOT, '..', 'other'), /路径越界/)
    assert.throws(() => safeJoin(ROOT, 'a/../../b'), /路径越界/)
    assert.equal(safeJoin(ROOT, 'a', 'b'), path.join(ROOT, 'a', 'b'))
  })
})

describe('文件版 Map', () => {
  test('增删改查与列举', async () => {
    const map = createFileMap({ dir: path.join(root, 'things'), logger: silentLogger })
    assert.deepEqual(await map.all(), [], '目录不存在时应回空数组而不是抛')

    await map.put('a', { id: 'a', n: 1 })
    await map.put('b', { id: 'b', n: 2 })
    assert.equal((await map.get('a')).n, 1)
    assert.equal((await map.all()).length, 2)

    assert.deepEqual((await map.merge('a', { n: 9 })).n, 9)
    assert.equal(await map.merge('nope', { n: 1 }), null, '记录不存在时 merge 不该凭空造一条')

    // undefined 表示删字段，与"值为 null"区分开
    await map.merge('a', { n: undefined })
    assert.equal('n' in (await map.get('a')), false)

    await map.delete('a')
    assert.equal(await map.get('a'), null)
  })

  test('putIfAbsent 是幂等的 —— 已存在时回已有的那条', async () => {
    const map = createFileMap({ dir: path.join(root, 'things'), logger: silentLogger })
    await map.putIfAbsent('x', { v: 'first' })
    const again = await map.putIfAbsent('x', { v: 'second' })
    assert.equal(again.v, 'first')
  })

  /**
   * 这条是这个模块存在的核心理由。
   * 没有串行队列时，十个并发 merge 里只有最后一个的改动会留下 —— 其余九个
   * 读到的都是同一份旧值。而且只在并发时出错，单测不写就永远发现不了。
   */
  test('并发 merge 不丢更新', async () => {
    const map = createFileMap({ dir: path.join(root, 'things'), logger: silentLogger })
    await map.put('counter', { hits: [] })
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => map.update('counter', (value) => ({ hits: [...value.hits, i] }))),
    )
    const final = await map.get('counter')
    assert.equal(final.hits.length, 20, `期望 20 条，实际 ${final.hits.length} —— 说明有并发写被覆盖了`)
    assert.deepEqual([...final.hits].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i))
  })

  test('坏掉的单条记录被跳过，不影响其余', async () => {
    const dir = path.join(root, 'things')
    const map = createFileMap({ dir, logger: silentLogger })
    await map.put('good', { id: 'good' })
    await writeFile(path.join(dir, 'broken.json'), '{ 这不是 JSON')
    const all = await map.all()
    assert.equal(all.length, 1)
    assert.equal(all[0].id, 'good')
  })

  test('写入是原子的 —— 目录里不留半成品', async () => {
    const dir = path.join(root, 'things')
    const map = createFileMap({ dir, logger: silentLogger })
    await map.put('a', { big: 'x'.repeat(100000) })
    const files = await readdir(dir)
    assert.deepEqual(files, ['a.json'], `不该留下临时文件：${files.join(', ')}`)
  })

  test('id 不能拼出越界路径', async () => {
    const map = createFileMap({ dir: path.join(root, 'things'), logger: silentLogger })
    await assert.rejects(() => map.put('../escape', {}), /不能作为目录名/)
  })
})

describe('按 username 分区', () => {
  test('两个用户的同名记录互不可见', async () => {
    const maps = createScopedMaps({ dataDir: root, collection: 'cron', logger: silentLogger })
    await maps.for('zhangsan').put('c1', { owner: 'zhangsan' })
    await maps.for('lisi').put('c1', { owner: 'lisi' })

    assert.equal((await maps.for('zhangsan').get('c1')).owner, 'zhangsan')
    assert.equal((await maps.for('lisi').get('c1')).owner, 'lisi')
    assert.equal((await maps.for('zhangsan').all()).length, 1)
  })

  test('usernames() 只列出真的建过目录的用户', async () => {
    const maps = createScopedMaps({ dataDir: root, collection: 'cron', logger: silentLogger })
    assert.deepEqual(await maps.usernames(), [], '没有 users/ 时应回空数组')
    await maps.for('zhangsan').put('c1', {})
    await mkdir(path.join(root, 'users', 'wangwu'), { recursive: true })
    assert.deepEqual((await maps.usernames()).sort(), ['wangwu', 'zhangsan'])
  })

  test('非法 username 拿不到 map', () => {
    const maps = createScopedMaps({ dataDir: root, collection: 'cron', logger: silentLogger })
    assert.throws(() => maps.for('../../etc'), /不能作为目录名/)
  })
})
