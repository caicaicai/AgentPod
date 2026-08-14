/**
 * 移植过来的工具的回归测试。
 *
 * 重点不是"工具能返回结果"，而是**移植过程中最容易搞砸的那件事**：
 * 桌面端的工具靠 process.env / 模块级变量拿凭据，一用户一进程时没问题，
 * 搬进共享进程就是串号。所以这里花最多篇幅测的是凭据边界：
 *   - 工具上下文里根本没有 credential 字段（取不到就不可能泄）
 *   - 凭据不会被带进工具的出站请求（目标地址是模型说了算的）
 *
 * ⚠️ 从前这里还测"各自的出站请求带各自的凭据"和"工具自设的 Cookie 会被丢掉"——
 * 那是 Cloud Bridge 的 egress 引擎注入凭据时的契约。Bridge 已经移除
 * （见 src/tools/http.js 开头），出站改走 Node 原生 fetch 且**不带凭据**，
 * 于是那两条说的事情不存在了。详见下面那段说明。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createToolContext, describeCredential } from '../src/tools/context.js'
import { createPluginApi, normalizeToolResult } from '../src/tools/plugin-api.js'
import { buildApTools } from '../src/tools/index.js'
import { registerTaskPlanTool } from '../src/tools/task-plan.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

let upstream
let upstreamPort
const hits = []

/** 会议室网关的假实现：回显收到的 cookie，并按 functionId 给出对应响应 */
before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url, 'http://upstream.local')
      const body = Buffer.concat(chunks).toString('utf8')
      const functionId = url.searchParams.get('functionId') || ''
      hits.push({ functionId, cookie: req.headers.cookie || null, loginType: req.headers.logintype || null, headers: req.headers, body, query: Object.fromEntries(url.searchParams) })

      const reply = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ resultCode: 1, message: 'ok', data }))
      }

      if (functionId === 'auth.user.init') {
        return reply({
          headers: { 'jms-real-name': '%E5%BC%A0%E4%B8%89', 'jms-tenant-code': 'JD' },
          profile: { branch_code: '13', region_code: '13', room_floor: '3' },
          isInGroup: '1',
          favoriteRooms: [{ meetingCode: 'R1', sortNo: 1 }],
        })
      }
      if (functionId === 'jmrs.district.list') {
        return reply([{ districtCode: '13', districtName: '北京' }])
      }
      if (functionId === 'get.workplace.list') {
        // 用一个特殊 districtCode 触发上游业务失败，测错误分支
        if (body.includes('BAD_DISTRICT')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ resultCode: 0, message: '地区代码不存在' }))
        }
        return reply({ workplaces: [{ workplaceCode: '1001000052', workplaceName: '亦庄科创', districtCode: '13' }] })
      }
      if (functionId === 'gateway.error.probe') {
        // 网关层错误：同时带 code 和 echo（与桌面端判定一致）
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ code: 'B1001', echo: '登录态已失效' }))
      }
      if (functionId === 'query.meeting.list') {
        return reply({
          total: 1,
          rows: [{
            meetingCode: 'R1', meetingName: '会议室 A', meetingAddress: '3层', floorNo: '3', maxContainCount: 10,
            oriRoomMeetingOrder: [{ meetingEstimateStime: 900, meetingEstimateEtime: 1030, meetingSubject: '周会' }],
          }],
        })
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ resultCode: 0, message: `unknown functionId ${functionId}` }))
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = upstream.address().port

})

after(async () => {
  await new Promise((resolve) => upstream.close(resolve))
})

beforeEach(() => {
  hits.length = 0
})

function makeCtx({ username = 'zhangsan', credential = 'sso.xiaocaicai.com=COOKIE_A' } = {}) {
  return createToolContext({ runId: 'run_1', username, credential, logger: silentLogger })
}

describe('工具上下文 / 凭据边界', () => {
  test('上下文里没有 credential 字段 —— 工具根本取不到凭据', () => {
    const ctx = makeCtx({ credential: 'sso.xiaocaicai.com=SUPER_SECRET' })
    assert.equal(ctx.credential, undefined)
    const serialized = JSON.stringify(ctx, (key, value) => (typeof value === 'function' ? '[fn]' : value))
    assert.ok(!serialized.includes('SUPER_SECRET'), '凭据出现在了工具上下文里')
  })

  test('credentialFacts 只回布尔值，不回内容', () => {
    // 曾经还有一个 hasSsoToken。SSO 那套登录随 AUTH_MODE 一起去掉了
    // （现在只有 password|dev，见 src/identity/index.js），这个字段也就没了。
    // deepEqual 是有意的：**多出**一个字段同样该判红 —— 这里的规矩是
    // "只回关于凭据的非机密事实"，多一个字段就是多一条可能泄的内容。
    assert.deepEqual(describeCredential('me_token=abc; other=1'), { present: true, hasMeToken: true })
    assert.deepEqual(describeCredential('sso.xiaocaicai.com=xyz'), { present: true, hasMeToken: false })
    assert.deepEqual(describeCredential(''), { present: false, hasMeToken: false })
  })

  test('缺 username 直接抛错（隔离契约 #4）', () => {
    assert.throws(() => createToolContext({ runId: 'r', username: '', logger: silentLogger }), /username/)
  })

  /**
   * ── 这三条随 Cloud Bridge 一起变了，说明留在这儿 ────────────────────────
   *
   * 从前工具出站要过 egress 引擎，由它**注入用户凭据**并按白名单放行，所以原来钉的是：
   *   1. 凭据由服务端注入，工具自设的 Cookie 会被丢掉；
   *   2. 并发两个用户各带各的凭据（不串号）；
   *   3. 白名单外的域名出不去。
   *
   * 现在 `ctx.http` 直接用 Node 原生 fetch（见 src/tools/http.js 开头），
   * `createToolHttp({ logger, runId, username })` **根本不接收 credential** ——
   * 于是 1 和 2 说的那件事不存在了（没有可串的东西），3 也不再成立。
   *
   * 保留一条断言，钉的是**现在这个契约**：出站请求里不带用户凭据。
   * 它防的是有人哪天"顺手"把凭据加回注入路径 —— 那等于把用户的 SSO Cookie
   * 发给模型指定的任意地址。
   *
   * ⚠️ 白名单没有了：进程内工具现在能连任意主机。这是当初移除 Bridge 时
   * 一并去掉的能力，不是这里漏测的东西。要收回来得在 http.js 上做，
   * 而不是在这个文件里断言一个不存在的行为。
   */
  test('出站请求不带用户凭据 —— 凭据只进闭包，不上网', async () => {
    const ctx = makeCtx({ credential: 'sso.xiaocaicai.com=REAL_COOKIE' })
    await ctx.http.request({
      url: `http://127.0.0.1:${upstreamPort}/api?functionId=jmrs.district.list`,
      method: 'GET',
      headers: { 'x-custom': 'kept' },
    })
    assert.ok(
      !String(hits[0].cookie || '').includes('REAL_COOKIE'),
      '用户凭据被带到了工具的出站请求里 —— 目标地址是模型说了算的',
    )
    assert.equal(hits[0].headers['x-custom'], 'kept', '调用方自己的头没透传过去')
  })
})

describe('openclaw 插件兼容层', () => {
  test('两种返回形状都归一成 pi 的 AgentToolResult', () => {
    assert.deepEqual(normalizeToolResult({ type: 'text', text: 'hi' }).content, [{ type: 'text', text: 'hi' }])
    assert.deepEqual(normalizeToolResult({ content: [{ type: 'text', text: 'x' }], details: 1 }).details, 1)
    assert.deepEqual(normalizeToolResult('plain').content, [{ type: 'text', text: 'plain' }])
    assert.equal(JSON.parse(normalizeToolResult({ a: 1 }).content[0].text).a, 1)
  })

  test('registerTool 产出 pi ToolDefinition，参数位置对得上', async () => {
    const ctx = makeCtx()
    const { api, collect } = createPluginApi({ ctx })
    let seen = null
    api.registerTool({
      name: 'probe',
      label: '探针',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      async execute(toolCallId, params) {
        seen = { toolCallId, params }
        return { type: 'text', text: 'done' }
      },
    })
    const [tool] = collect()
    assert.equal(tool.name, 'probe')
    const result = await tool.execute('call_1', { a: 1 })
    assert.deepEqual(seen, { toolCallId: 'call_1', params: { a: 1 } })
    assert.deepEqual(result.content, [{ type: 'text', text: 'done' }])
  })

  test('不支持的事件订阅会被明确忽略而不是静默丢掉', () => {
    const warnings = []
    const ctx = { ...makeCtx(), logger: { ...silentLogger, warn: (msg, f) => warnings.push(f?.event) } }
    const { api } = createPluginApi({ ctx })
    api.on('gateway_start', () => {})
    assert.deepEqual(warnings, ['gateway_start'])
  })
})

describe('task_plan（移植自 ap-skills）', () => {
  function buildTool() {
    const { api, collect } = createPluginApi({ ctx: makeCtx() })
    registerTaskPlanTool(api)
    return collect()[0]
  }

  test('规范化任务并统计完成数', async () => {
    const tool = buildTool()
    const out = JSON.parse((await tool.execute('c', {
      title: '实现计划',
      tasks: [
        { content: '设计', status: 'completed' },
        { content: '编码', status: 'in_progress' },
        { content: '', status: 'pending' }, // 空 content 会被丢掉
        { content: '测试', status: '乱填' }, // 非法状态回落 pending
      ],
    })).content[0].text)

    assert.equal(out.ok, true)
    assert.equal(out.plan.total, 3)
    assert.equal(out.plan.completed, 1)
    assert.equal(out.plan.tasks[2].status, 'pending')
    assert.match(out.plan.id, /^plan_/)
  })

  test('复用传入的 id（渲染端靠它原地更新同一张卡）', async () => {
    const tool = buildTool()
    const out = JSON.parse((await tool.execute('c', { id: 'plan_fixed', tasks: [{ content: 'a', status: 'pending' }] })).content[0].text)
    assert.equal(out.plan.id, 'plan_fixed')
  })

  test('空清单给出可读错误', async () => {
    const tool = buildTool()
    const out = JSON.parse((await tool.execute('c', { tasks: [] })).content[0].text)
    assert.equal(out.ok, false)
    assert.match(out.error, /tasks/)
  })
})

/**
 * 这里曾经有两块用例：joyme_conference_room 工具本身（四步管道、错误分支、loginType
 * 由 credentialFacts 决定），以及它导出的时间纠正纯函数。
 *
 * src/tools/joyme/ 整个目录在开源时移除了，那两块测的是不存在的模块 ——
 * 表现是**整个文件 ERR_MODULE_NOT_FOUND**，连带上面那 15 条也一起跑不了。
 * 要接回内部工具时，从 git 历史里取回这两块即可。
 */

describe('工具装配的能力闸门', () => {
  const names = (result) => result.tools.map((t) => t.name).sort()
  /** 按插件 id 找，别按下标 —— 注册表里加一个新插件就会把下标全挪位 */
  const missingFor = (result, pluginId) => result.skipped.find((entry) => entry.plugin === pluginId)?.missing

  /**
   * 这条原来用的样本是 joyme_conference_room（`requires: ['credential']`）。
   * 那个插件随内部工具一起移除了，而**现在没有任何插件依赖 credential** ——
   * 也就是说 `credential` 这个能力位当下没有使用者。
   *
   * 换成 memory 作样本：闸门机制本身没变，"缺依赖就不注册、并在 skipped 里
   * 说清缺什么"才是要守的东西。注册了却每次必失败，对模型来说是最难办的一种
   * 工具 —— 它看得见、调得动、永远拿不到结果。
   */
  test('缺依赖的工具不注册，而不是注册了每次必失败', () => {
    const withMemory = buildApTools({
      runId: 'r', username: 'e', logger: silentLogger, memory: { enabled: true },
    })
    const without = buildApTools({ runId: 'r', username: 'e', logger: silentLogger })

    assert.ok(names(withMemory).includes('memory'))
    assert.ok(!names(without).includes('memory'))
    // task_plan 无依赖，两种情况都在
    assert.ok(names(withMemory).includes('task_plan'))
    assert.ok(names(without).includes('task_plan'))
    // 缺什么要说得出来，否则排查时只知道"工具没了"
    assert.deepEqual(missingFor(without, 'ap-memory'), ['memory'])
  })

  test('没有用户工作空间时不给 skill_save —— 沙盒里写的东西根本存不下来', () => {
    const sandboxSession = { async listFiles() { return { items: [] } }, async getFiles() { return [] } }
    const off = buildApTools({ runId: 'r', username: 'e', credential: '', logger: silentLogger, sandboxSession })
    assert.ok(!names(off).includes('skill_save'))
    assert.deepEqual(missingFor(off, 'ap-skill-save'), ['skills'])

    const on = buildApTools({
      runId: 'r',
      username: 'e',
      credential: '',
      
      logger: silentLogger,
      sandboxSession,
      workspace: { enabled: true, async writeSkillFiles() {} },
    })
    assert.ok(names(on).includes('skill_save'))
  })

  test('没有沙盒时也不给 skill_save —— 技能文件是从沙盒里读出来的', () => {
    const noSandbox = buildApTools({
      runId: 'r',
      username: 'e',
      credential: '',
      
      logger: silentLogger,
      workspace: { enabled: true, async writeSkillFiles() {} },
    })
    assert.ok(!names(noSandbox).includes('skill_save'))
  })
})
