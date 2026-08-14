/**
 * 作品（artifact）：助手产出的、独立于对话正文的成品。**一份作品是一组文件。**
 *
 * 重点：
 *   1. **版本是完整快照** —— 改坏了要能退回去，清理旧版就只是删一个目录
 *   2. **write 是合并语义** —— 模型只发改动的文件，没提到的原样带过去（这是多文件省 token 的来源）
 *   3. **定点替换要求唯一** —— 出现多次时宁可失败，不做"改第一处"的猜测
 *   4. **路径收口** —— 它会变成盘上真实的路径，字符集与越界要各挡一道
 *   5. **隔离** —— username / sessionKey 关在闭包里，模型传什么都改不到别人的
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createArtifactStore, artifactFileName, assertRelPath } from '../src/artifacts/store.js'
import { createToolContext } from '../src/tools/context.js'
import { createPluginApi } from '../src/tools/plugin-api.js'
import { artifactPlugin } from '../src/tools/artifact.js'
import { buildApTools } from '../src/tools/index.js'
import { createMemoryStorage } from './helpers/memory-storage.js'

/** 存储后端的测试替身。生产只有 MySQL，见 test/helpers/memory-storage.js */
const testStorage = createMemoryStorage()

/**
 * 替身是这个文件共用的一个实例，每条用例前清干净。
 * 不清的话，上一条留下的记录会让"列出全部"这类断言得到一个跟自己无关的数字，
 * 而报错看起来像是被测代码有问题。
 */
beforeEach(() => testStorage.reset())

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

let root
let artifacts
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ap-artifact-'))
  artifacts = createArtifactStore({ storage: testStorage, config: { dataDir: root, artifacts: { enabled: true } }, logger: silentLogger })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const make = (over = {}) => artifacts.create({
  username: 'zhangsan',
  sessionKey: 's_1',
  kind: 'web',
  title: '销售看板',
  files: [
    { path: 'index.html', content: '<h1>hello</h1>\n<script src="app.js"></script>' },
    { path: 'app.js', content: 'console.log(1)' },
  ],
  ...over,
})

const pathsOf = (result) => result.files.map((file) => file.path).sort()

describe('增删改查', () => {
  test('建了能读回来，文件按原样的名字和后缀落盘', async () => {
    const meta = await make()
    assert.equal(meta.version, 1)
    assert.equal(meta.entry, 'index.html', 'web 的默认入口')

    const current = await artifacts.read({ username: 'zhangsan', id: meta.id })
    assert.deepEqual(pathsOf(current), ['app.js', 'index.html'])
    assert.equal(current.files.find((file) => file.path === 'app.js').content, 'console.log(1)')

    // 盘上就是真实的目录结构 —— 运维直接把 v1/ 拷出来就能用
    assert.deepEqual(await artifacts.listOnDisk({ username: 'zhangsan', id: meta.id, version: 1 }), ['app.js', 'index.html'])
  })

  test('支持子目录，层级结构原样保留', async () => {
    const meta = await make({
      kind: 'vue',
      files: [
        { path: 'App.vue', content: '<template><Chart /></template>' },
        { path: 'components/Chart.vue', content: '<template><i /></template>' },
        { path: 'utils/format.js', content: 'export const f = 1' },
      ],
    })
    assert.equal(meta.entry, 'App.vue', 'vue 的默认入口')
    assert.deepEqual(
      await artifacts.listOnDisk({ username: 'zhangsan', id: meta.id, version: 1 }),
      ['App.vue', 'components/Chart.vue', 'utils/format.js'],
    )
    // 正文按原样的路径存着。断言走 store 自己的接口 —— 从前这里是拼一条真实路径
    // 再 readFile，那把用例绑死在"作品一定是磁盘上的目录树"上，而现在它是库里的行
    const current = await artifacts.read({ username: 'zhangsan', id: meta.id })
    assert.equal(current.files.find((file) => file.path === 'components/Chart.vue').content, '<template><i /></template>')
  })

  test('entry 可以显式指定，指到不存在的文件当场报错', async () => {
    const meta = await make({ entry: 'app.js' })
    assert.equal(meta.entry, 'app.js')
    await assert.rejects(() => make({ entry: 'nope.html' }), /不在文件列表里/)
  })

  test('没有惯例名时按后缀挑，再不行取第一个 —— 入口不能没有', async () => {
    const md = await make({ kind: 'markdown', files: [{ path: '方案.md', content: '# x' }] })
    assert.equal(md.entry, '方案.md')
    const code = await make({ kind: 'code', files: [{ path: 'q.sql', content: 'select 1' }] })
    assert.equal(code.entry, 'q.sql')
  })

  test('清单按会话过滤，且不带文件正文', async () => {
    await make()
    await make({ sessionKey: 's_2', title: '另一条会话的' })

    assert.equal((await artifacts.list({ username: 'zhangsan', sessionKey: 's_1' })).length, 1)
    assert.equal((await artifacts.list({ username: 'zhangsan' })).length, 2)

    const [item] = await artifacts.list({ username: 'zhangsan', sessionKey: 's_1' })
    // 清单里只有文件名和大小，没有内容 —— 一次列几十条不该传几 MB
    assert.deepEqual(item.versions[0].files.map((file) => file.path).sort(), ['app.js', 'index.html'])
    assert.equal(item.versions[0].files[0].content, undefined)
  })

  test('CRLF 落盘前统一成 LF', async () => {
    const meta = await make({ files: [{ path: 'index.html', content: 'a\r\nb\r\n' }] })
    assert.equal((await artifacts.read({ username: 'zhangsan', id: meta.id })).files[0].content, 'a\nb\n')
  })

  test('删了作品，正文跟着走，不留孤儿', async () => {
    const meta = await make()
    assert.deepEqual(
      await artifacts.listOnDisk({ username: 'zhangsan', id: meta.id, version: 1 }),
      ['app.js', 'index.html'],
      '前提：正文确实存进去了',
    )

    assert.equal(await artifacts.remove({ username: 'zhangsan', id: meta.id }), true)
    assert.equal(await artifacts.read({ username: 'zhangsan', id: meta.id }), null)
    assert.deepEqual(
      await artifacts.listOnDisk({ username: 'zhangsan', id: meta.id, version: 1 }),
      [],
      '元信息删了但正文还在 —— 那就是一份谁也访问不到、却还占着地方的孤儿',
    )
  })

  test('会话删了，它名下的作品跟着删，别的会话不受影响', async () => {
    await make()
    await make()
    const keep = await make({ sessionKey: 's_2' })

    assert.equal(await artifacts.removeSession({ username: 'zhangsan', sessionKey: 's_1' }), 2)
    assert.equal((await artifacts.list({ username: 'zhangsan' })).length, 1)
    assert.ok(await artifacts.read({ username: 'zhangsan', id: keep.id }))
  })

  test('入参不合法时报得具体', async () => {
    await assert.rejects(() => make({ kind: 'pdf' }), /kind 只能是/)
    await assert.rejects(() => make({ title: '  ' }), /标题不能为空/)
    await assert.rejects(() => make({ files: [] }), /必须是非空数组/)
    await assert.rejects(() => make({ files: [{ path: 'a.js', content: '  ' }] }), /所有文件都是空的/)
    await assert.rejects(
      () => make({ files: [{ path: 'a.js', content: 'x' }, { path: 'a.js', content: 'y' }] }),
      /出现了两个 a.js/,
    )
  })

  test('文件数与总体积有上限', async () => {
    const store = createArtifactStore({ storage: testStorage, config: { dataDir: root, artifacts: { enabled: true, maxFiles: 2, maxBytes: 100 } },
      logger: silentLogger,
    })
    const seed = (files) => store.create({ username: 'lisi', kind: 'code', title: 't', files })
    await assert.rejects(
      () => seed([{ path: 'a', content: 'x' }, { path: 'b', content: 'x' }, { path: 'c', content: 'x' }]),
      /文件数 3 超过上限 2/,
    )
    await assert.rejects(() => seed([{ path: 'a', content: 'x'.repeat(200) }]), /超过单版上限/)
  })
})

/**
 * 路径会**变成盘上真实的路径**，所以两道防线：字符集在这里当场拦（让模型看得懂
 * 自己写错了什么），越界由解析后的 safeJoin 兜底。
 */
describe('路径收口', () => {
  test('正常的相对路径放行，反斜杠归一成正斜杠', () => {
    assert.equal(assertRelPath('index.html'), 'index.html')
    assert.equal(assertRelPath('components/Chart.vue'), 'components/Chart.vue')
    assert.equal(assertRelPath('components\\Chart.vue'), 'components/Chart.vue')
  })

  test('越界、绝对路径、怪字符一律挡掉', () => {
    assert.throws(() => assertRelPath('../../etc/passwd'), /不允许跳出作品自己的目录/)
    assert.throws(() => assertRelPath('/etc/passwd'), /必须是相对路径/)
    assert.throws(() => assertRelPath('a/../../b'), /不允许跳出作品自己的目录/)
    assert.throws(() => assertRelPath(''), /不能为空/)
    assert.throws(() => assertRelPath('a/b/c/d/e/f/g/h'), /层级超过/)
    assert.throws(() => assertRelPath('a<b.js'), /不能用的字符/)
    assert.throws(() => assertRelPath('a.'), /不能以点或空格结尾/)
  })

  test('存的时候也挡 —— 光在校验函数里挡不算数', async () => {
    await assert.rejects(() => make({ files: [{ path: '../escape.html', content: 'x' }] }), /不允许跳出/)
  })
})

describe('版本', () => {
  test('write 是合并：只传改动的文件，没提到的原样带到新版本', async () => {
    const meta = await make()
    const after = await artifacts.write({
      username: 'zhangsan',
      id: meta.id,
      files: [{ path: 'app.js', content: 'console.log(2)' }],
    })
    assert.equal(after.version, 2)

    const current = await artifacts.read({ username: 'zhangsan', id: meta.id })
    assert.deepEqual(pathsOf(current), ['app.js', 'index.html'])
    assert.equal(current.files.find((file) => file.path === 'app.js').content, 'console.log(2)')
    assert.match(current.files.find((file) => file.path === 'index.html').content, /hello/, '没提到的文件原样保留')

    // 旧版本还完整躺着，随时能退回去
    const first = await artifacts.read({ username: 'zhangsan', id: meta.id, version: 1 })
    assert.equal(first.files.find((file) => file.path === 'app.js').content, 'console.log(1)')
  })

  test('write 能新增文件和删文件', async () => {
    const meta = await make()
    await artifacts.write({ username: 'zhangsan', id: meta.id, files: [{ path: 'style.css', content: 'body{}' }] })
    assert.deepEqual(pathsOf(await artifacts.read({ username: 'zhangsan', id: meta.id })), ['app.js', 'index.html', 'style.css'])

    await artifacts.write({ username: 'zhangsan', id: meta.id, remove: ['app.js'] })
    assert.deepEqual(pathsOf(await artifacts.read({ username: 'zhangsan', id: meta.id })), ['index.html', 'style.css'])

    await assert.rejects(
      () => artifacts.write({ username: 'zhangsan', id: meta.id, remove: ['nope.js'] }),
      /要删的 nope.js 不在当前版本里/,
    )
  })

  test('删掉入口文件时会重新挑一个 —— 入口不能悬空', async () => {
    const meta = await make()
    const after = await artifacts.write({
      username: 'zhangsan', id: meta.id, files: [{ path: 'main.html', content: '<p>新的</p>' }], remove: ['index.html'],
    })
    assert.equal(after.entry, 'main.html')
  })

  test('不能把文件全删光', async () => {
    const meta = await make()
    await assert.rejects(
      () => artifacts.write({ username: 'zhangsan', id: meta.id, remove: ['index.html', 'app.js'] }),
      /不能把作品的文件全删光/,
    )
  })

  /**
   * 定点替换是这个工具真正省 token 的地方：改一个颜色不用把整个文件重发一遍。
   * 但它的前提是**替换点唯一** —— 模型看不到替换结果，猜错了它不会知道。
   */
  test('定点替换：命中某个文件里唯一的片段', async () => {
    const meta = await make()
    const after = await artifacts.replace({
      username: 'zhangsan', id: meta.id, path: 'index.html', oldStr: '<h1>hello</h1>', newStr: '<h1>你好</h1>',
    })
    assert.equal(after.version, 2)
    const current = await artifacts.read({ username: 'zhangsan', id: meta.id })
    assert.match(current.files.find((file) => file.path === 'index.html').content, /你好/)
    assert.equal(current.files.find((file) => file.path === 'app.js').content, 'console.log(1)', '别的文件不受影响')
  })

  test('定点替换：找不到 / 不唯一 / 文件不存在时失败，且说清为什么', async () => {
    const meta = await make({ files: [{ path: 'index.html', content: '<p>a</p>\n<p>a</p>' }] })
    const call = (over) => artifacts.replace({
      username: 'zhangsan', id: meta.id, path: 'index.html', oldStr: '<p>b</p>', newStr: 'x', ...over,
    })
    await assert.rejects(() => call(), /找不到/)
    await assert.rejects(() => call({ oldStr: '<p>a</p>' }), /出现了 2 次/)
    await assert.rejects(() => call({ path: 'nope.js' }), /当前版本没有 nope.js/)
    // 三次都失败了，所以还停在第 1 版 —— 失败的修改不该留下一个空版本
    assert.equal((await artifacts.get({ username: 'zhangsan', id: meta.id })).version, 1)
  })

  /**
   * 文件全留着就是拿盘换一个几乎没人回头看的历史。
   * 但**元信息要留**：不然"第 1 版是什么时候生成的、有哪些文件"这条线索会直接断掉。
   */
  test('超出保留窗口的旧版本删目录、留元信息', async () => {
    const store = createArtifactStore({ storage: testStorage, config: { dataDir: root, artifacts: { enabled: true, maxVersions: 2 } },
      logger: silentLogger,
    })
    const meta = await store.create({ username: 'lisi', kind: 'code', title: 't', files: [{ path: 'a.js', content: 'v1' }] })
    await store.write({ username: 'lisi', id: meta.id, files: [{ path: 'a.js', content: 'v2' }] })
    const third = await store.write({ username: 'lisi', id: meta.id, files: [{ path: 'a.js', content: 'v3' }] })

    assert.equal(third.versions.length, 3, '元信息三版都在')
    assert.equal(third.versions[0].pruned, true)
    assert.deepEqual(third.versions[0].files.map((file) => file.path), ['a.js'], '文件清单也留着')
    await assert.rejects(() => store.read({ username: 'lisi', id: meta.id, version: 1 }), /已被清理/)
    assert.equal((await store.read({ username: 'lisi', id: meta.id, version: 2 })).files[0].content, 'v2')
  })

  test('读不存在的版本报错，不静默回最新版', async () => {
    const meta = await make()
    await assert.rejects(() => artifacts.read({ username: 'zhangsan', id: meta.id, version: 9 }), /没有第 9 版/)
  })
})

describe('隔离', () => {
  test('别人的作品看不见、读不到、改不了、删不掉', async () => {
    const meta = await make()

    assert.equal((await artifacts.list({ username: 'lisi' })).length, 0)
    assert.equal(await artifacts.read({ username: 'lisi', id: meta.id }), null)
    assert.equal(await artifacts.write({ username: 'lisi', id: meta.id, files: [{ path: 'x.js', content: 'x' }] }), null)
    assert.equal(
      await artifacts.replace({ username: 'lisi', id: meta.id, path: 'index.html', oldStr: 'hello', newStr: 'x' }),
      null,
    )
    assert.equal(await artifacts.remove({ username: 'lisi', id: meta.id }), false)

    const mine = await artifacts.read({ username: 'zhangsan', id: meta.id })
    assert.match(mine.files.find((file) => file.path === 'index.html').content, /hello/)
  })

  test('id / username 拼不出越界路径', async () => {
    await assert.rejects(() => artifacts.read({ username: 'zhangsan', id: '../../lisi' }), /不能作为目录名/)
    await assert.rejects(() => artifacts.list({ username: '../../etc' }), /不能作为目录名/)
  })

  /**
   * 工具拿到的是闭包，不是 store：模型把 username / sessionKey 当参数传进来也没用。
   * 反面教材见 http/server.js 里 PATCH 那段注释（`{...body}` 覆盖掉登录态解析出的 username）。
   */
  test('工具上下文里，username 与 sessionKey 由服务端说了算', async () => {
    const ctx = createToolContext({
      runId: 'r1', username: 'zhangsan', sessionKey: 's_1', logger: silentLogger, artifacts,
    })
    const meta = await ctx.artifacts.create({
      kind: 'code', title: 't', files: [{ path: 'a.js', content: 'x' }],
      // 下面这些都不该被采纳
      username: 'lisi', sessionKey: 's_hacked',
    })
    assert.equal(meta.sessionKey, 's_1')
    assert.equal((await artifacts.list({ username: 'lisi' })).length, 0)
    assert.equal((await artifacts.list({ username: 'zhangsan' })).length, 1)
  })
})

/** 工具与界面的契约：结果里有 `artifact` 字段，界面据此画卡片（与 task_plan 回 plan 同理） */
function runTool(ctx, params) {
  const { api, collect } = createPluginApi({ ctx, config: { artifacts: { allowedOrigins: [] } } })
  artifactPlugin.register(api)
  const [tool] = collect()
  return tool.execute('call_1', params).then((result) => JSON.parse(result.content[0].text))
}

describe('artifact 工具', () => {
  let ctx
  beforeEach(() => {
    ctx = createToolContext({ runId: 'r1', username: 'zhangsan', sessionKey: 's_1', logger: silentLogger, artifacts })
  })

  const create = (over = {}) => runTool(ctx, {
    action: 'create',
    kind: 'web',
    title: '看板',
    files: [{ path: 'index.html', content: '<h1>hi</h1>' }, { path: 'app.js', content: 'let a = 1' }],
    ...over,
  })

  test('create 回元信息与文件清单，但**不回正文** —— 同一份内容不该在上下文里躺两份', async () => {
    const out = await create()
    assert.equal(out.ok, true)
    assert.ok(out.artifact.id)
    assert.equal(out.artifact.version, 1)
    assert.deepEqual(out.artifact.files, ['index.html', 'app.js'])
    assert.equal(out.artifact.entry, 'index.html')
    assert.equal(out.files, undefined)
  })

  test('update 定点改某个文件，write 增删文件', async () => {
    const created = await create()
    const id = created.artifact.id

    const updated = await runTool(ctx, { action: 'update', id, path: 'index.html', old_str: 'hi', new_str: '你好' })
    assert.equal(updated.artifact.version, 2)

    const written = await runTool(ctx, {
      action: 'write', id, files: [{ path: 'style.css', content: 'body{}' }], remove: ['app.js'],
    })
    assert.deepEqual(written.artifact.files.sort(), ['index.html', 'style.css'])

    const current = await artifacts.read({ username: 'zhangsan', id })
    assert.match(current.files.find((file) => file.path === 'index.html').content, /你好/)
  })

  test('read 不带 path 回清单+正文，带 path 只回那一个文件', async () => {
    const created = await create()
    const all = await runTool(ctx, { action: 'read', id: created.artifact.id })
    assert.deepEqual(all.files.map((file) => file.path), ['index.html', 'app.js'])
    assert.match(all.files[0].content, /hi/)

    const one = await runTool(ctx, { action: 'read', id: created.artifact.id, path: 'app.js' })
    assert.equal(one.content, 'let a = 1')
    assert.match((await runTool(ctx, { action: 'read', id: created.artifact.id, path: 'nope' })).error, /没有 nope/)
  })

  /**
   * 工具结果在事件流里有 4000 字符的预览上限（events.js 的 TOOL_PREVIEW_MAX）。
   * 一旦被截断，前端就解析不出 `artifact` 字段，对话里那张作品卡片会**凭空消失** ——
   * 而"改到第十几版之后卡片不见了"这个现象，跟版本数看起来毫无关系。
   */
  test('结果里不带 versions 全表，改多少版都不会把预览顶爆', async () => {
    const created = await create()
    for (let i = 0; i < 20; i += 1) {
      await runTool(ctx, { action: 'write', id: created.artifact.id, files: [{ path: 'app.js', content: `let a = ${i}` }] })
    }
    const out = await runTool(ctx, { action: 'write', id: created.artifact.id, files: [{ path: 'app.js', content: 'done' }] })
    assert.equal(out.artifact.version, 22)
    assert.equal(out.artifact.versions, undefined)
    assert.ok(JSON.stringify(out, null, 2).length < 4000)
  })

  /**
   * 这些错模型下一步就能自己改对（对齐缩进、换个更长的片段、改个路径）。
   * 抛出去的话 pi 会生成 isError 的结果，界面上是一张红卡片 —— 而用户
   * 根本不需要看到"模型第一次没对齐缩进"。
   */
  test('校验失败回 ok:false，不抛异常、不算工具出错', async () => {
    const created = await create({ files: [{ path: 'index.html', content: '<p>a</p><p>a</p>' }] })
    const dup = await runTool(ctx, {
      action: 'update', id: created.artifact.id, path: 'index.html', old_str: '<p>a</p>', new_str: 'x',
    })
    assert.equal(dup.ok, false)
    assert.match(dup.error, /出现了 2 次/)

    assert.match((await runTool(ctx, { action: 'update', path: 'a', old_str: 'a', new_str: 'b' })).error, /必须带 id/)
    assert.match((await runTool(ctx, { action: 'flip', id: 'a_x' })).error, /未知 action/)
    assert.match((await runTool(ctx, { action: 'read', id: 'a_nope' })).error, /没有这个作品/)
    assert.match((await create({ kind: 'pdf' })).error, /kind 只能是/)
    assert.match((await create({ files: [{ path: '../x', content: 'y' }] })).error, /不允许跳出/)
  })

  test('没接作品存储时整个工具不注册（能力闸门）', () => {
    const withStore = buildApTools({
      runId: 'r1', username: 'zhangsan', sessionKey: 's_1', logger: silentLogger, artifacts,
    })
    assert.ok(withStore.tools.some((tool) => tool.name === 'artifact'))

    const without = buildApTools({ runId: 'r1', username: 'zhangsan', logger: silentLogger })
    assert.equal(without.tools.some((tool) => tool.name === 'artifact'), false)
    assert.ok(without.skipped.some((item) => item.plugin === 'ap-artifact' && item.missing.includes('artifacts')))
  })

  test('ARTIFACTS_ENABLED=0 时也不注册', () => {
    const off = createArtifactStore({ storage: testStorage, config: { dataDir: root, artifacts: { enabled: false } }, logger: silentLogger })
    const { tools } = buildApTools({ runId: 'r1', username: 'zhangsan', logger: silentLogger, artifacts: off })
    assert.equal(tools.some((tool) => tool.name === 'artifact'), false)
  })

  /**
   * 提示词里那几条硬约束，写不对的后果都是"预览白屏而模型看不见"。
   * 所以它们不是文案，是功能的一部分，值得钉住。
   */
  test('工具描述把多文件与预览环境的约束讲给模型听', () => {
    const { api, collect } = createPluginApi({ ctx, config: { artifacts: { allowedOrigins: [] } } })
    artifactPlugin.register(api)
    const [tool] = collect()

    assert.match(tool.description, /localStorage/, '不说的话模型会用它，然后白屏')
    assert.match(tool.description, /加载不了任何外部资源/)
    assert.match(tool.description, /一份作品是一组文件/)
    assert.match(tool.description, /怎么拆文件/)
    assert.match(tool.description, /components\/\*\.vue/, 'Vue 的拆分形态要给例子')
    assert.match(tool.description, /mermaid/)
    assert.match(tool.description, /除 `vue` 外不能 import 任何第三方包/, '沙箱里没有 npm，必须说死')

    const { api: api2, collect: collect2 } = createPluginApi({
      ctx, config: { artifacts: { allowedOrigins: ['https://cdn.example.com'] } },
    })
    artifactPlugin.register(api2)
    assert.match(collect2()[0].description, /https:\/\/cdn\.example\.com/)
  })
})

describe('下载文件名', () => {
  test('取入口文件的最后一段，脏字符抹掉', () => {
    assert.equal(artifactFileName({ title: '看板', entry: 'index.html' }), 'index.html')
    assert.equal(artifactFileName({ title: '看板', entry: 'components/Chart.vue' }), 'Chart.vue')
    assert.equal(artifactFileName({ title: 'a/b:c', entry: '' }), 'a-b-c.txt')
  })
})
