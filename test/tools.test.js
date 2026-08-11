/**
 * 移植过来的工具的回归测试。
 *
 * 重点不是"工具能返回结果"，而是**移植过程中最容易搞砸的那件事**：
 * 桌面端的工具靠 process.env / 模块级变量拿凭据，一用户一进程时没问题，
 * 搬进共享进程就是串号。所以这里花最多篇幅测的是凭据边界：
 *   - 工具上下文里根本没有 credential 字段（取不到就不可能泄）
 *   - 并发两个用户，各自的出站请求带各自的凭据
 *   - 工具自己设的 Cookie 头会被丢掉，冒充不了别人
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createEgress } from '../src/bridge/egress.js'
import { createToolContext, describeCredential } from '../src/tools/context.js'
import { createPluginApi, normalizeToolResult, jsonResult } from '../src/tools/plugin-api.js'
import { buildApTools } from '../src/tools/index.js'
import { registerTaskPlanTool } from '../src/tools/task-plan.js'
import { registerConferenceRoomTool, ensureValidQueryDateTime, formatTimeFromInteger, localDateString } from '../src/tools/joyme/conference-room.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

let upstream
let upstreamPort
const hits = []
let egress

/** 会议室网关的假实现：回显收到的 cookie，并按 functionId 给出对应响应 */
before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url, 'http://upstream.local')
      const body = Buffer.concat(chunks).toString('utf8')
      const functionId = url.searchParams.get('functionId') || ''
      hits.push({ functionId, cookie: req.headers.cookie || null, loginType: req.headers.logintype || null, body, query: Object.fromEntries(url.searchParams) })

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

  egress = createEgress({
    config: {
      bridge: {
        egressMode: 'allowlist', allowHosts: ['127.0.0.1'], allowPrivateNetwork: true,
        maxRedirects: 3, timeoutMs: 5000, maxResponseBytes: 1024 * 1024,
      },
    },
    logger: silentLogger,
  })
})

after(async () => {
  await new Promise((resolve) => upstream.close(resolve))
})

beforeEach(() => {
  hits.length = 0
})

function makeCtx({ username = 'zhangsan', credential = 'sso.xiaocaicai.com=COOKIE_A' } = {}) {
  return createToolContext({ runId: 'run_1', username, credential, egress, logger: silentLogger })
}

/** 会议室工具默认打 api.m.xiaocaicai.com，测试里用配置把网关指到本地上游 */
function makeConferenceTool(ctx) {
  const { api, collect } = createPluginApi({ ctx, config: { joyme: { colorHost: `http://127.0.0.1:${upstreamPort}` } } })
  registerConferenceRoomTool(api)
  return collect()[0]
}

describe('工具上下文 / 凭据边界', () => {
  test('上下文里没有 credential 字段 —— 工具根本取不到凭据', () => {
    const ctx = makeCtx({ credential: 'sso.xiaocaicai.com=SUPER_SECRET' })
    assert.equal(ctx.credential, undefined)
    const serialized = JSON.stringify(ctx, (key, value) => (typeof value === 'function' ? '[fn]' : value))
    assert.ok(!serialized.includes('SUPER_SECRET'), '凭据出现在了工具上下文里')
  })

  test('credentialFacts 只回布尔值，不回内容', () => {
    assert.deepEqual(describeCredential('me_token=abc; other=1'), { present: true, hasMeToken: true, hasSsoToken: false })
    assert.deepEqual(describeCredential('sso.xiaocaicai.com=xyz'), { present: true, hasMeToken: false, hasSsoToken: true })
    assert.deepEqual(describeCredential(''), { present: false, hasMeToken: false, hasSsoToken: false })
  })

  test('缺 username 直接抛错（隔离契约 #4）', () => {
    assert.throws(() => createToolContext({ runId: 'r', username: '', egress, logger: silentLogger }), /username/)
  })

  test('工具出站由 egress 注入凭据；工具自设的 Cookie 会被丢掉', async () => {
    const ctx = makeCtx({ credential: 'sso.xiaocaicai.com=REAL_COOKIE' })
    await ctx.http.request({
      url: `http://127.0.0.1:${upstreamPort}/api?functionId=jmrs.district.list`,
      method: 'GET',
      headers: { Cookie: 'sso.xiaocaicai.com=FORGED', 'x-custom': 'kept' },
    })
    assert.equal(hits[0].cookie, 'sso.xiaocaicai.com=REAL_COOKIE', '工具伪造的 Cookie 覆盖了服务端注入的凭据')
  })

  test('并发两个用户：各自的出站请求带各自的凭据', async () => {
    const a = makeCtx({ username: 'userA', credential: 'sso.xiaocaicai.com=CRED_A' })
    const b = makeCtx({ username: 'userB', credential: 'sso.xiaocaicai.com=CRED_B' })
    await Promise.all([
      a.http.get(`http://127.0.0.1:${upstreamPort}/api?functionId=jmrs.district.list&who=a`),
      b.http.get(`http://127.0.0.1:${upstreamPort}/api?functionId=jmrs.district.list&who=b`),
    ])
    const hitA = hits.find((h) => h.query.who === 'a')
    const hitB = hits.find((h) => h.query.who === 'b')
    assert.equal(hitA.cookie, 'sso.xiaocaicai.com=CRED_A')
    assert.equal(hitB.cookie, 'sso.xiaocaicai.com=CRED_B', '并发下工具凭据串号')
  })

  test('白名单外的域名，工具也出不去', async () => {
    const ctx = makeCtx()
    await assert.rejects(() => ctx.http.get('http://evil.example.com/'), /白名单/)
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

describe('joyme_conference_room（移植自 joyme 扩展）', () => {
  test('loginType 由 credentialFacts 决定，不读 process.env', async () => {
    const meCtx = makeCtx({ credential: 'me_token=X' })
    const tool = makeConferenceTool(meCtx)
    await tool.execute('c', { action: 'query_district_list' })
    assert.equal(hits[0].loginType, '15', '有 me_token 时 loginType 应为 15')

    hits.length = 0
    const ssoTool = makeConferenceTool(makeCtx({ credential: 'sso.xiaocaicai.com=Y' }))
    await ssoTool.execute('c', { action: 'query_district_list' })
    assert.equal(hits[0].loginType, '7', '只有 sso 时 loginType 应为 7')
  })

  test('四步管道：档案 / 地区 / 楼宇 / 会议室', async () => {
    const tool = makeConferenceTool(makeCtx())

    const profile = JSON.parse((await tool.execute('c', { action: 'query_user_conference_profile' })).content[0].text)
    assert.equal(profile.ok, true)
    assert.equal(profile.data.headers.jmsRealName, '张三', 'URL-encoded 的姓名没有解码')

    const districts = JSON.parse((await tool.execute('c', { action: 'query_district_list' })).content[0].text)
    assert.deepEqual(districts.data, [{ districtCode: '13', districtName: '北京' }])

    const workplaces = JSON.parse((await tool.execute('c', { action: 'query_workplace_list', districtCode: '13' })).content[0].text)
    assert.equal(workplaces.data[0].workplaceCode, '1001000052')

    const rooms = JSON.parse((await tool.execute('c', {
      action: 'query_meeting_list',
      districtCode: '13',
      workplaceCode: '1001000052',
      floorNo: '3',
      meetingEstimateDate: '2099-01-01',
      meetingEstimateStime: 900,
      meetingEstimateEtime: 1800,
    })).content[0].text)
    assert.equal(rooms.data.rooms[0].meetingName, '会议室 A')
    assert.deepEqual(rooms.data.rooms[0].booked, [{ start: '09:00', end: '10:30', subject: '周会' }])
  })

  test('缺前置参数时报错指路，而不是发一个必然失败的请求', async () => {
    const tool = makeConferenceTool(makeCtx())
    const out = JSON.parse((await tool.execute('c', { action: 'query_meeting_list', floorNo: '3' })).content[0].text)
    assert.equal(out.ok, false)
    assert.match(out.error, /districtCode/)
    assert.match(out.error, /四步管道/)
    assert.equal(hits.length, 0, '参数不全就不该打上游')
  })

  test('上游业务失败（resultCode≠1）转成可读错误，不抛栈', async () => {
    const tool = makeConferenceTool(makeCtx())
    const out = JSON.parse((await tool.execute('c', { action: 'query_workplace_list', districtCode: 'BAD_DISTRICT' })).content[0].text)
    assert.equal(out.ok, false)
    assert.equal(out.error, '地区代码不存在', '没有把上游的失败原因透出来')
  })

  test('网关层错误（code+echo）保留错误码', async () => {
    const ctx = makeCtx()
    const { createColorGateway } = await import('../src/tools/joyme/color-gateway.js')
    const gateway = createColorGateway({ ctx, host: `http://127.0.0.1:${upstreamPort}` })
    const [data, error] = await gateway.request({ functionId: 'gateway.error.probe', contentType: 'application/json' })
    assert.equal(data, null)
    assert.equal(error.code, 'B1001')
    assert.match(error.message, /登录态已失效/)
  })
})

describe('查询时间自动纠正（修了桌面端的跨时区 bug）', () => {
  test('过去的日期前移到今天', () => {
    const now = new Date(2026, 6, 30, 14, 30) // 本地时间 2026-07-30 14:30
    const result = ensureValidQueryDateTime('2026-07-01', 900, now)
    assert.equal(result.wasAdjusted, true)
    assert.equal(result.adjustedDate, '2026-07-30')
    assert.equal(result.adjustedTime, 1430)
  })

  test('今天但时间已过 → 前移到当前时刻', () => {
    const now = new Date(2026, 6, 30, 14, 30)
    const result = ensureValidQueryDateTime('2026-07-30', 900, now)
    assert.equal(result.wasAdjusted, true)
    assert.equal(result.adjustedTime, 1430)
  })

  test('将来的时间不动', () => {
    const now = new Date(2026, 6, 30, 14, 30)
    const result = ensureValidQueryDateTime('2026-08-01', 900, now)
    assert.equal(result.wasAdjusted, false)
    assert.equal(result.adjustedDate, '2026-08-01')
  })

  test('东八区凌晨不会把今天误判成过去 —— 桌面端用 UTC 日期比本地小时，这里修掉了', () => {
    // 本地 2026-07-30 01:00；若按 UTC 取日期会得到 2026-07-29，从而误判"今天"是过去
    const now = new Date(2026, 6, 30, 1, 0)
    assert.equal(localDateString(now), '2026-07-30')
    const result = ensureValidQueryDateTime('2026-07-30', 2000, now)
    assert.equal(result.wasAdjusted, false, '把用户查询的今天误判成了过去的日期')
  })

  test('HHMM 格式化', () => {
    assert.equal(formatTimeFromInteger(900), '09:00')
    assert.equal(formatTimeFromInteger(1530), '15:30')
    assert.equal(formatTimeFromInteger(undefined), '')
    assert.equal(formatTimeFromInteger(9999), '')
  })
})

describe('工具装配的能力闸门', () => {
  const names = (result) => result.tools.map((t) => t.name).sort()
  /** 按插件 id 找，别按下标 —— 注册表里加一个新插件就会把下标全挪位 */
  const missingFor = (result, pluginId) => result.skipped.find((entry) => entry.plugin === pluginId)?.missing

  test('没有凭据时，需要凭据的工具不注册（而不是注册了每次必失败）', () => {
    const withCred = buildApTools({ runId: 'r', username: 'e', credential: 'sso.xiaocaicai.com=X', egress, logger: silentLogger })
    const noCred = buildApTools({ runId: 'r', username: 'e', credential: '', egress, logger: silentLogger })

    assert.ok(names(withCred).includes('joyme_conference_room'))
    assert.ok(!names(noCred).includes('joyme_conference_room'))
    // task_plan 无依赖，两种情况都在
    assert.ok(names(withCred).includes('task_plan'))
    assert.ok(names(noCred).includes('task_plan'))
    assert.deepEqual(missingFor(noCred, 'joyme-conference-room'), ['credential'])
  })

  test('没有用户工作空间时不给 skill_save —— 沙盒里写的东西根本存不下来', () => {
    const sandboxSession = { async listFiles() { return { items: [] } }, async getFiles() { return [] } }
    const off = buildApTools({ runId: 'r', username: 'e', credential: '', egress, logger: silentLogger, sandboxSession })
    assert.ok(!names(off).includes('skill_save'))
    assert.deepEqual(missingFor(off, 'ap-skill-save'), ['skills'])

    const on = buildApTools({
      runId: 'r',
      username: 'e',
      credential: '',
      egress,
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
      egress,
      logger: silentLogger,
      workspace: { enabled: true, async writeSkillFiles() {} },
    })
    assert.ok(!names(noSandbox).includes('skill_save'))
  })
})
