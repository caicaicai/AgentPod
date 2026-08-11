/**
 * 项目：会话分组 + 项目级指令与记忆。
 *
 * 重点：
 *   1. **归属不可被请求体改写** —— 逐字段取而不是展开，否则塞个 username 就能搬走别人的项目
 *   2. **上限** —— instructions 每轮都进系统提示，不设上限就是"模型莫名变笨"
 *   3. **删项目不删对话** —— 那是不可逆的，而且没人能预料到
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createProjectStore, projectPrompt } from '../src/projects/store.js'
import { createMemoryStore } from '../src/memory/store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

let root
let projects
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ap-proj-'))
  projects = createProjectStore({ config: { dataDir: root, projects: { enabled: true } }, logger: silentLogger })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('增删改查', () => {
  test('建了能查到，按最近更新排序', async () => {
    const first = await projects.create({ username: 'zhangsan', name: '结算中台' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await projects.create({ username: 'zhangsan', name: '风控实验' })

    const list = await projects.list({ username: 'zhangsan' })
    assert.equal(list.length, 2)
    assert.equal(list[0].id, second.id, '最近更新的排前面')
    assert.equal((await projects.get({ username: 'zhangsan', projectId: first.id })).name, '结算中台')
  })

  test('项目名不能为空', async () => {
    await assert.rejects(() => projects.create({ username: 'zhangsan', name: '   ' }), /不能为空/)
    const project = await projects.create({ username: 'zhangsan', name: '正常' })
    await assert.rejects(() => projects.update({ username: 'zhangsan', projectId: project.id, name: '' }), /不能为空/)
  })

  test('名字里的多余空白被压掉', async () => {
    const project = await projects.create({ username: 'zhangsan', name: '  结算   中台  ' })
    assert.equal(project.name, '结算 中台')
  })

  /**
   * instructions 每一轮都要进系统提示。不设上限的话，一段几万字的"项目背景"
   * 会把上下文吃掉大半 —— 而现象只是"模型变笨了"，没人会想到是这里。
   */
  test('instructions 有长度上限', async () => {
    const project = await projects.create({ username: 'zhangsan', name: 'x', instructions: 'a'.repeat(20000) })
    assert.equal(project.instructions.length, 8000)
  })

  test('归档的默认不在列表里', async () => {
    const project = await projects.create({ username: 'zhangsan', name: 'x' })
    await projects.update({ username: 'zhangsan', projectId: project.id, archived: true })
    assert.equal((await projects.list({ username: 'zhangsan' })).length, 0)
    assert.equal((await projects.list({ username: 'zhangsan', includeArchived: true })).length, 1)
  })

  test('查不存在的项目回 null，不抛', async () => {
    assert.equal(await projects.get({ username: 'zhangsan', projectId: 'p_nope' }), null)
    assert.equal(await projects.get({ username: 'zhangsan', projectId: '' }), null)
    assert.equal(await projects.update({ username: 'zhangsan', projectId: 'p_nope', name: 'x' }), null)
    assert.equal(await projects.remove({ username: 'zhangsan', projectId: 'p_nope' }), false)
  })
})

describe('隔离', () => {
  test('别人的项目看不见、查不到、改不了、删不掉', async () => {
    const project = await projects.create({ username: 'zhangsan', name: '结算中台' })

    assert.equal((await projects.list({ username: 'lisi' })).length, 0)
    assert.equal(await projects.get({ username: 'lisi', projectId: project.id }), null)
    assert.equal(await projects.update({ username: 'lisi', projectId: project.id, name: '被改了' }), null)
    assert.equal(await projects.remove({ username: 'lisi', projectId: project.id }), false)

    assert.equal((await projects.get({ username: 'zhangsan', projectId: project.id })).name, '结算中台')
  })

  /**
   * 反面教材在 http/server.js 的注释里：`{ username: subject.username, ...body }` ——
   * 请求体里的 username 会覆盖掉登录态解析出来的那个。
   */
  test('update 只认白名单字段，塞别的进去不生效', async () => {
    const project = await projects.create({ username: 'zhangsan', name: '结算中台' })
    await projects.update({
      username: 'zhangsan', projectId: project.id, name: '改过了',
      // 下面这些都不该被采纳
      id: 'p_hacked', createdAt: 0, archived: undefined,
    })
    const after = await projects.get({ username: 'zhangsan', projectId: project.id })
    assert.equal(after.id, project.id, 'id 不该被请求体改掉')
    assert.equal(after.name, '改过了')
    assert.equal(after.createdAt, project.createdAt)
  })

  test('projectId / username 拼不出越界路径', async () => {
    await assert.rejects(() => projects.get({ username: 'zhangsan', projectId: '../../lisi' }), /不能作为目录名/)
    await assert.rejects(() => projects.list({ username: '../../etc' }), /不能作为目录名/)
  })
})

describe('删项目', () => {
  test('项目记忆跟着删，别留孤儿文件', async () => {
    const memory = createMemoryStore({ config: { dataDir: root, memory: { enabled: true } }, logger: silentLogger })
    const project = await projects.create({ username: 'zhangsan', name: '结算中台' })
    await memory.capture({ username: 'zhangsan', projectId: project.id }, ['本项目下周上线'])

    const memoryFile = memory.fileFor({ username: 'zhangsan', projectId: project.id })
    assert.ok(await stat(memoryFile), '前提：项目记忆确实写出来了')

    assert.equal(await projects.remove({ username: 'zhangsan', projectId: project.id }), true)
    await assert.rejects(() => stat(memoryFile), /ENOENT/)
  })

  test('个人记忆不受影响', async () => {
    const memory = createMemoryStore({ config: { dataDir: root, memory: { enabled: true } }, logger: silentLogger })
    const project = await projects.create({ username: 'zhangsan', name: 'x' })
    await memory.capture({ username: 'zhangsan' }, ['我是张三'])
    await projects.remove({ username: 'zhangsan', projectId: project.id })
    assert.match(await memory.recall({ username: 'zhangsan' }), /我是张三/)
  })
})

describe('进系统提示的那一段', () => {
  test('没有 instructions 就不生成任何段落', () => {
    assert.equal(projectPrompt(null), '')
    assert.equal(projectPrompt({ name: 'x', instructions: '' }), '')
  })

  test('说明是「长期要求」，与记忆那段的措辞区分开', () => {
    const text = projectPrompt({ name: '结算中台', description: '日常维护', instructions: '回答附带风险点。' })
    assert.match(text, /## 当前项目：结算中台/)
    assert.match(text, /日常维护/)
    assert.match(text, /长期要求/)
    assert.match(text, /回答附带风险点。/)
  })
})
