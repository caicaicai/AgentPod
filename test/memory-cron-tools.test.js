/**
 * memory / cron 两个工具，以及它们在 ctx 上的作用域绑定。
 *
 * 最要紧的一条：**参数里没有 username**。模型能改的永远只有"自己这个用户"的东西 ——
 * 这是隔离契约 #4 在工具层的落法，与 ctx.http「拿得到能力、拿不到凭据」同一个套路。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createToolContext } from '../src/tools/context.js'
import { createPluginApi } from '../src/tools/plugin-api.js'
import { memoryPlugin } from '../src/tools/memory.js'
import { cronPlugin } from '../src/tools/cron.js'
import { createMemoryStore } from '../src/memory/store.js'
import { createCronStore } from '../src/cron/store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }
const fakeEgress = { async request() { throw new Error('本测试不该出网') } }

/** 装配一个工具并返回它的 execute，外加共享的存储实例 */
function build(plugin, { username = 'zhangsan', projectId = '', memory = null, crons = null } = {}) {
  const ctx = createToolContext({
    runId: 'r1', username, credential: '', egress: fakeEgress, logger: silentLogger, memory, crons, projectId,
  })
  const { api, collect } = createPluginApi({ ctx, config: {} })
  plugin.register(api)
  const [tool] = collect()
  return {
    ctx,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async call(params) {
      const result = await tool.execute('call-1', params)
      return JSON.parse(result.content.map((part) => part.text).join(''))
    },
  }
}

let root
let memory
let crons
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ap-tools-'))
  memory = createMemoryStore({ config: { dataDir: root, memory: { enabled: true } }, logger: silentLogger })
  crons = createCronStore({ config: { dataDir: root, cron: { enabled: true } }, logger: silentLogger })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('memory 工具', () => {
  test('能力没开时明说，而不是假装成功', async () => {
    const tool = build(memoryPlugin, { memory: null })
    const result = await tool.call({ action: 'read' })
    assert.equal(result.ok, false)
    assert.match(result.error, /未启用长期记忆/)
  })

  test('remember → read → search → forget 一条链走通', async () => {
    const tool = build(memoryPlugin, { memory })

    const added = await tool.call({ action: 'remember', facts: ['偏好简短回答', '负责结算中台'] })
    assert.equal(added.added, 2)

    const read = await tool.call({ action: 'read' })
    assert.match(read.content, /偏好简短回答/)

    const found = await tool.call({ action: 'search', query: '结算' })
    assert.equal(found.count, 1)

    const forgot = await tool.call({ action: 'forget', text: '结算' })
    assert.equal(forgot.removed, 1)
    assert.equal((await tool.call({ action: 'read' })).count, 1)
  })

  /**
   * added=0 不是失败，是"这些都已经记过了"。不说清楚的话模型会以为没生效，
   * 于是原地重试几次 —— 每次都白花一轮工具调用。
   */
  test('重复记录时告诉模型"已经记过了"', async () => {
    const tool = build(memoryPlugin, { memory })
    await tool.call({ action: 'remember', facts: ['偏好简短回答'] })
    const again = await tool.call({ action: 'remember', facts: ['偏好简短回答'] })
    assert.equal(again.ok, true)
    assert.equal(again.added, 0)
    assert.match(again.note, /已经在记忆里/)
  })

  test('缺参数时给出能让模型自我纠正的报错', async () => {
    const tool = build(memoryPlugin, { memory })
    assert.match((await tool.call({ action: 'search' })).error, /需要 query/)
    assert.match((await tool.call({ action: 'remember', facts: [] })).error, /需要非空的 facts/)
    assert.match((await tool.call({ action: 'forget' })).error, /需要 text/)
    assert.match((await tool.call({ action: '乱写' })).error, /未知 action/)
  })

  test('在项目里写的是项目记忆；scope=personal 可以指定写个人', async () => {
    const tool = build(memoryPlugin, { memory, projectId: 'p1' })
    assert.equal(tool.ctx.memory.scope, 'project')

    await tool.call({ action: 'remember', facts: ['本项目下周上线'] })
    await tool.call({ action: 'remember', facts: ['我常用飞书'], scope: 'personal' })

    assert.match(await memory.recall({ username: 'zhangsan', projectId: 'p1' }), /下周上线/)
    assert.doesNotMatch(await memory.recall({ username: 'zhangsan', projectId: 'p1' }), /飞书/)
    assert.match(await memory.recall({ username: 'zhangsan' }), /我常用飞书/)
  })

  test('项目会话里 read 会把个人那份也带上（否则"我是谁"在项目里反而答不上来）', async () => {
    await memory.capture({ username: 'zhangsan' }, ['我是张三'])
    const tool = build(memoryPlugin, { memory, projectId: 'p1' })
    const read = await tool.call({ action: 'read' })
    assert.match(read.personal.content, /我是张三/)
  })

  test('工具改不到别人的记忆 —— 参数里根本没有 username 这个入口', async () => {
    const tool = build(memoryPlugin, { memory, username: 'zhangsan' })
    await tool.call({ action: 'remember', facts: ['张三的事实'], username: 'lisi', scope: 'personal' })
    assert.equal(await memory.recall({ username: 'lisi' }), '', '李四的记忆必须仍然是空的')
    assert.match(await memory.recall({ username: 'zhangsan' }), /张三的事实/)
  })
})

describe('cron 工具', () => {
  test('能力没开时明说', async () => {
    const tool = build(cronPlugin, { crons: null })
    assert.match((await tool.call({ action: 'list' })).error, /未启用定时任务/)
  })

  test('create → list → update → remove', async () => {
    const tool = build(cronPlugin, { crons })

    const created = await tool.call({
      action: 'create', title: '每日汇总', task: '汇总昨天的告警',
      schedule: { cron: '30 9 * * *', timezone: 'Asia/Shanghai' },
    })
    assert.equal(created.ok, true)
    assert.ok(created.cron.nextFireAt, '回给模型的应该是可读的 ISO 时间，好让它转述给用户')

    assert.equal((await tool.call({ action: 'list' })).count, 1)

    const off = await tool.call({ action: 'update', id: created.cron.id, enabled: false })
    assert.equal(off.cron.enabled, false)

    await tool.call({ action: 'remove', id: created.cron.id })
    assert.equal((await tool.call({ action: 'list' })).count, 0)
  })

  /**
   * 排期写错是最常见的失败，而服务端的报错里已经写清了该怎么改。
   * 包成一句"创建失败"等于让模型盲猜下一次该写什么。
   */
  test('排期写错时把可纠正的原文回给模型', async () => {
    const tool = build(cronPlugin, { crons })
    const bad = await tool.call({ action: 'create', task: 'x', schedule: { cron: '99 9 * * *' } })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /「分钟」.*0-59/)

    const daily = await tool.call({ action: 'create', task: 'x', schedule: { everyMs: 86400000 } })
    assert.match(daily.error, /请改用 cron/)
  })

  test('缺参数时说清楚缺什么', async () => {
    const tool = build(cronPlugin, { crons })
    assert.match((await tool.call({ action: 'create', task: 'x' })).error, /需要 schedule/)
    assert.match((await tool.call({ action: 'create', schedule: { cron: '0 9 * * *' } })).error, /需要 task/)
    assert.match((await tool.call({ action: 'update' })).error, /需要 id/)
  })

  test('改不存在的任务不会凭空造一条', async () => {
    const tool = build(cronPlugin, { crons })
    assert.match((await tool.call({ action: 'update', id: 'c_nope', title: 'x' })).error, /没有这条定时任务/)
  })

  test('工具改不到别人的任务', async () => {
    const mine = await crons.create({
      username: 'lisi', title: '李四的任务', task: 'x', schedule: { cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
    })
    const tool = build(cronPlugin, { crons, username: 'zhangsan' })

    assert.equal((await tool.call({ action: 'list' })).count, 0, '看不到李四的任务')
    // 就算把 id 猜对了，作用域也不是它的
    assert.match((await tool.call({ action: 'update', id: mine.id, title: '被改了' })).error, /没有这条定时任务/)
    assert.equal((await crons.get({ username: 'lisi', id: mine.id })).title, '李四的任务')
  })

  test('在项目里建的任务自动归到该项目', async () => {
    const tool = build(cronPlugin, { crons, projectId: 'p1' })
    const created = await tool.call({ action: 'create', task: 'x', schedule: { cron: '0 9 * * *' } })
    assert.equal((await crons.get({ username: 'zhangsan', id: created.cron.id })).projectId, 'p1')
  })
})

/**
 * 工具描述就是与模型之间的契约 —— 它决定模型什么时候想起来调、参数怎么填。
 * 这些断言锁住的是几条"删掉之后会安静地退化"的关键说明。
 */
describe('工具描述', () => {
  test('memory：要求"用户明说时立刻调用"，并划清不该记什么', () => {
    const tool = build(memoryPlugin, { memory })
    assert.equal(tool.name, 'memory')
    // 少了这句，模型会口头答应"好的我记住了"然后什么都不做
    assert.match(tool.description, /立刻调用/)
    assert.match(tool.description, /不要记[^]*凭据/)
    assert.deepEqual(tool.parameters.required, ['action'])
    assert.deepEqual(tool.parameters.properties.action.enum, ['search', 'read', 'remember', 'forget'])
    assert.equal('username' in tool.parameters.properties, false, '参数里不该有 username —— 作用域由 ctx 决定')
  })

  test('cron：要说清 task 是给未来的自己看的，以及每天某点该用 cron', () => {
    const tool = build(cronPlugin, { crons })
    assert.equal(tool.name, 'cron')
    // 少了这句，模型会把 task 写成"照上面说的做"——而那次触发没有本次对话的上下文
    assert.match(tool.description, /给未来的自己看的完整指令/)
    assert.match(tool.description, /每天某个点.*一律用 cron/s)
    assert.equal('username' in tool.parameters.properties, false, '参数里不该有 username')
  })
})
