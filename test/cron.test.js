/**
 * 定时任务：排期解析、存储、调度。
 *
 * 排期那部分的测试用例挑的都是"看着对、其实差一点"的地方：
 *   - 时区（服务器跑在 UTC 容器里，用户在北京）
 *   - 夏令时（春季那一小时根本不存在，秋季那一小时出现两次）
 *   - cron 那条反直觉的规则：日与星期都限制时是「或」
 *   - 占坑：一个跑了五分钟的任务，不能在这五分钟里被反复认为"到期了"
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  parseCron, nextFireAfter, normalizeSchedule, advanceNextFireAt, recoverNextFireAt,
  describeSchedule, isCalendarSchedule, MIN_EVERY_MS,
} from '../src/cron/schedule.js'
import { createCronStore } from '../src/cron/store.js'
import { createCronCredentialVault } from '../src/cron/credentials.js'
import { createScheduler } from '../src/cron/scheduler.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }
const TZ = 'Asia/Shanghai'

/** 某时区的墙上时间，便于断言 */
const wall = (ts, timeZone = TZ) => new Date(ts).toLocaleString('sv-SE', { timeZone })

describe('cron 表达式解析', () => {
  test('五段之外一律拒绝', () => {
    assert.throws(() => parseCron('0 0 * *'), /必须是 5 段/)
    assert.throws(() => parseCron('0 0 * * * *'), /必须是 5 段/)
    assert.throws(() => parseCron(''), /必须是 5 段/)
  })

  test('超出取值范围要报清楚是哪个字段', () => {
    assert.throws(() => parseCron('99 0 * * *'), /「分钟」.*0-59/)
    assert.throws(() => parseCron('0 25 * * *'), /「小时」.*0-23/)
    assert.throws(() => parseCron('0 0 32 * *'), /「日」/)
    assert.throws(() => parseCron('0 0 * 13 *'), /「月」/)
  })

  test('支持 * / 步长 / 区间 / 枚举 / 英文缩写', () => {
    assert.equal(parseCron('*/15 * * * *').minute.size, 4)
    assert.equal(parseCron('0 9-17 * * *').hour.size, 9)
    assert.equal(parseCron('0 9,12,18 * * *').hour.size, 3)
    assert.equal(parseCron('0 0 * * mon-fri').dow.size, 5)
    assert.equal(parseCron('0 0 1 jan *').month.has(1), true)
  })

  test('星期 7 与 0 都是周日', () => {
    assert.equal(parseCron('0 0 * * 7').dow.has(0), true)
  })
})

describe('下一次触发时间', () => {
  // 2026-08-07 09:00 北京
  const base = Date.parse('2026-08-07T01:00:00Z')

  test('每天 9:30', () => {
    assert.equal(wall(nextFireAfter('30 9 * * *', TZ, base)), '2026-08-07 09:30:00')
  })

  test('工作日 8:00 —— 周五之后跳到下周一', () => {
    assert.equal(wall(nextFireAfter('0 8 * * 1-5', TZ, base)), '2026-08-10 08:00:00')
  })

  test('时区是真的按墙上时间算的，不是服务器本地时间', () => {
    const shanghai = nextFireAfter('0 9 * * *', 'Asia/Shanghai', base)
    const newYork = nextFireAfter('0 9 * * *', 'America/New_York', base)
    assert.equal(wall(shanghai, 'Asia/Shanghai'), '2026-08-08 09:00:00')
    assert.equal(wall(newYork, 'America/New_York'), '2026-08-07 09:00:00')
    assert.notEqual(shanghai, newYork, '两个时区的 9 点不该是同一个瞬间')
  })

  test('日与星期都限制时是「或」（cron 那条反直觉的规则）', () => {
    // 每月 1 号 **或** 每周一
    const next = nextFireAfter('0 0 1 * 1', TZ, base)
    assert.equal(wall(next), '2026-08-10 00:00:00', '8/10 是周一，早于 9/1')
  })

  test('夏令时春季跳过的那一小时不会触发', () => {
    // 2027-03-14 纽约 2:00→3:00，2:30 这个墙上时间不存在
    const next = nextFireAfter('30 2 * * *', 'America/New_York', Date.parse('2027-03-14T00:00:00Z'))
    assert.equal(wall(next, 'America/New_York'), '2027-03-15 02:30:00', '应顺延到第二天，而不是在 3:30 触发')
  })

  test('一年内不会触发的表达式回 undefined，而不是死循环', () => {
    // 2026-08 之后一年内没有 2月30日，也没有闰日
    assert.equal(nextFireAfter('0 0 30 2 *', TZ, base), undefined)
  })

  test('严格大于 —— 同一分钟不重复触发', () => {
    const at930 = Date.parse('2026-08-07T01:30:00Z')
    assert.equal(wall(nextFireAfter('30 9 * * *', TZ, at930)), '2026-08-08 09:30:00')
  })
})

describe('排期归一化', () => {
  const now = Date.parse('2026-08-07T01:00:00Z')

  test('cron 与 everyMs 只能二选一', () => {
    assert.throws(() => normalizeSchedule({ cron: '0 9 * * *', everyMs: 60000 }, now), /二选一/)
  })

  test('everyMs 有下限', () => {
    assert.throws(() => normalizeSchedule({ everyMs: 1000 }, now), new RegExp(String(MIN_EVERY_MS)))
  })

  /**
   * 这条限制是有理由的，不是洁癖：everyMs 锚在一个随机起点上、没有时区、
   * 还会被夏令时推着漂。而写 everyMs=86400000 的人，想要的几乎总是"每天某个点"。
   */
  test('everyMs >= 24 小时被拦下，并告诉你该用什么', () => {
    assert.throws(() => normalizeSchedule({ everyMs: 24 * 3600 * 1000 }, now), /请改用 cron/)
  })

  test('timezone 只对 cron 有意义', () => {
    assert.throws(() => normalizeSchedule({ everyMs: 60000, timezone: TZ }, now), /只对 cron 有意义/)
  })

  test('不认识的时区当场拒绝，而不是等到第一次该触发时', () => {
    assert.throws(() => normalizeSchedule({ cron: '0 9 * * *', timezone: 'Mars/Olympus' }, now), /不认识的时区/)
  })

  test('语法错误在创建时就抛', () => {
    assert.throws(() => normalizeSchedule({ cron: '0 99 * * *' }, now), /「小时」/)
  })

  test('归一化会补上默认时区并压掉多余空格', () => {
    const { schedule } = normalizeSchedule({ cron: '30   9  *  * *' }, now)
    assert.equal(schedule.cron, '30 9 * * *')
    assert.equal(schedule.timezone, TZ)
  })
})

describe('推进与恢复', () => {
  test('日历排期从「计划时刻」推，间隔排期从「实际触发时刻」推', () => {
    const at = Date.parse('2026-08-07T01:30:05Z') // 比计划晚了 5 秒
    const calendar = advanceNextFireAt({ cron: '30 9 * * *', timezone: TZ }, at)
    assert.equal(wall(calendar), '2026-08-08 09:30:00', '晚了两秒也还是明天 9:30 那一格')

    const interval = advanceNextFireAt({ everyMs: 60000 }, at)
    assert.equal(interval, at + 60000, '间隔要的是"距上次多久"')
  })

  test('落盘的 nextFireAt 优先；丢了能按 lastFiredAt 重建', () => {
    const schedule = { cron: '30 9 * * *', timezone: TZ }
    const created = Date.parse('2026-08-01T00:00:00Z')
    const lastFired = Date.parse('2026-08-07T01:30:00Z')

    assert.equal(recoverNextFireAt(schedule, created, lastFired, 12345), 12345)
    assert.equal(wall(recoverNextFireAt(schedule, created, lastFired, undefined)), '2026-08-08 09:30:00')
    assert.equal(wall(recoverNextFireAt(schedule, created, undefined, undefined)), '2026-08-01 09:30:00')
  })

  test('描述文案', () => {
    assert.match(describeSchedule({ cron: '30 9 * * *', timezone: TZ }), /30 9 \* \* \*/)
    assert.equal(describeSchedule({ everyMs: 300000 }), '每 5 分钟')
    assert.equal(describeSchedule({ everyMs: 7200000 }), '每 2 小时')
    assert.equal(isCalendarSchedule({ cron: 'x' }), true)
    assert.equal(isCalendarSchedule({ everyMs: 1 }), false)
  })
})

describe('存储', () => {
  let root
  let crons
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ap-cron-'))
    crons = createCronStore({ config: { dataDir: root, cron: { enabled: true } }, logger: silentLogger })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const make = (username = 'zhangsan', extra = {}) => crons.create({
    username, title: '每日汇总', task: '汇总昨天的告警',
    schedule: { cron: '30 9 * * *', timezone: TZ }, ...extra,
  })

  test('创建后能查到，nextFireAt 已经算好', async () => {
    const cron = await make()
    assert.ok(cron.nextFireAt > Date.now())
    assert.equal((await crons.get({ username: 'zhangsan', id: cron.id })).title, '每日汇总')
  })

  test('指令内容不能为空', async () => {
    await assert.rejects(() => make('zhangsan', { task: '   ' }), /不能为空/)
  })

  test('没给标题时从指令首行截一个', async () => {
    const cron = await make('zhangsan', { title: '', task: '汇总昨天的告警\n第二行' })
    assert.equal(cron.title, '汇总昨天的告警')
  })

  test('别的用户看不见，也改不了', async () => {
    const cron = await make('zhangsan')
    assert.equal((await crons.list({ username: 'lisi' })).length, 0)
    assert.equal(await crons.get({ username: 'lisi', id: cron.id }), null)
    assert.equal(await crons.update({ username: 'lisi', id: cron.id, title: '被改了' }), null)
    assert.equal((await crons.get({ username: 'zhangsan', id: cron.id })).title, '每日汇总')
  })

  test('改排期会立刻重算 nextFireAt，而不是等下一次触发才生效', async () => {
    const cron = await make()
    const updated = await crons.update({
      username: 'zhangsan', id: cron.id, schedule: { cron: '0 3 * * *', timezone: TZ },
    })
    assert.equal(new Date(updated.nextFireAt).toLocaleString('sv-SE', { timeZone: TZ }).slice(11), '03:00:00')
  })

  test('归档会顺带停用 —— 归档的任务不该还在跑', async () => {
    const cron = await make()
    const updated = await crons.update({ username: 'zhangsan', id: cron.id, archived: true })
    assert.equal(updated.enabled, false)
    assert.equal((await crons.list({ username: 'zhangsan' })).length, 0)
    assert.equal((await crons.list({ username: 'zhangsan', includeArchived: true })).length, 1)
  })

  test('due() 只回到期且启用的，且带上 username', async () => {
    const past = { cron: '* * * * *', timezone: TZ } // 每分钟，必然很快到期
    const cron = await crons.create({ username: 'zhangsan', title: 'x', task: 'x', schedule: past })
    await crons.update({ username: 'zhangsan', id: cron.id, schedule: past })

    const due = await crons.due(Date.now() + 10 * 60000)
    assert.equal(due.length, 1)
    assert.equal(due[0].username, 'zhangsan', 'due 是唯一的跨用户读取口，必须带 username 让下游能拿对作用域')

    await crons.update({ username: 'zhangsan', id: cron.id, enabled: false })
    assert.equal((await crons.due(Date.now() + 10 * 60000)).length, 0)
  })

  /**
   * 占坑是"先把下一拍推走、再去执行"。顺序反过来的话，一个跑了五分钟的任务
   * 在这五分钟里会被每一次 tick 反复认为"到期了"。
   */
  test('同一格只能被占一次', async () => {
    const cron = await crons.create({
      username: 'zhangsan', title: 'x', task: 'x', schedule: { cron: '* * * * *', timezone: TZ },
    })
    const now = Date.now() + 10 * 60000
    const [due] = await crons.due(now)

    assert.equal(await crons.claimSlot({ username: 'zhangsan', id: cron.id, scheduledAt: due.scheduledAt, at: now }), true)
    assert.equal(
      await crons.claimSlot({ username: 'zhangsan', id: cron.id, scheduledAt: due.scheduledAt, at: now }),
      false,
      '第二次必须占不到，否则同一格会被跑两遍',
    )
  })

  test('占了坑没跑成可以退回来', async () => {
    const cron = await crons.create({
      username: 'zhangsan', title: 'x', task: 'x', schedule: { cron: '* * * * *', timezone: TZ },
    })
    const now = Date.now() + 10 * 60000
    const [due] = await crons.due(now)
    await crons.claimSlot({ username: 'zhangsan', id: cron.id, scheduledAt: due.scheduledAt, at: now })
    await crons.unclaimSlot({ username: 'zhangsan', id: cron.id, scheduledAt: due.scheduledAt, at: now, priorLastFiredAt: undefined })

    assert.equal(await crons.claimSlot({ username: 'zhangsan', id: cron.id, scheduledAt: due.scheduledAt, at: now }), true)
  })

  test('触发记录只留最近 20 条', async () => {
    const cron = await make()
    for (let i = 0; i < 25; i += 1) {
      await crons.recordFire({ username: 'zhangsan', id: cron.id, entry: { firedAt: i, status: 'ok' } })
    }
    const stored = await crons.get({ username: 'zhangsan', id: cron.id })
    assert.equal(stored.fireLog.length, 20)
    assert.equal(stored.fireLog[0].firedAt, 5, '留的应该是最近的那 20 条')
  })
})

describe('凭据留存', () => {
  let root
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ap-vault-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('默认 none：什么都不存，也就取不出来', async () => {
    const vault = createCronCredentialVault({ config: { dataDir: root, cron: {} }, logger: silentLogger })
    assert.equal(vault.mode, 'none')
    assert.equal(vault.enabled, false)
    assert.equal(await vault.remember({ username: 'zhangsan', credential: 'sso=abc' }), false)
    assert.equal(await vault.resolve({ username: 'zhangsan' }), '')
  })

  test('stored：存得进、取得出、清得掉，且按 username 隔离', async () => {
    const vault = createCronCredentialVault({
      config: { dataDir: root, cron: { credentialMode: 'stored' } }, logger: silentLogger,
    })
    assert.equal(vault.enabled, true)
    await vault.remember({ username: 'zhangsan', credential: 'sso=abc' })
    assert.equal(await vault.resolve({ username: 'zhangsan' }), 'sso=abc')
    assert.equal(await vault.resolve({ username: 'lisi' }), '', '别人的凭据一个字节都不该看到')

    await vault.forget({ username: 'zhangsan' })
    assert.equal(await vault.resolve({ username: 'zhangsan' }), '')
  })

  /**
   * Windows 不实现 POSIX 权限位：同一份文件 Node 一律报 0666，`chmod` 也改不动它。
   * 这条守的是真实部署（linux 容器）上的性质，在 Windows 上**无从观测** ——
   * 所以跳过，而不是把它改成一个在哪儿都成立、也就什么都不保证的断言。
   */
  test('落盘权限必须是 0600', { skip: process.platform === 'win32' ? 'Windows 没有 POSIX 权限位，此性质只在 linux 上可观测' : false }, async () => {
    const { stat } = await import('node:fs/promises')
    const vault = createCronCredentialVault({
      config: { dataDir: root, cron: { credentialMode: 'stored' } }, logger: silentLogger,
    })
    await vault.remember({ username: 'zhangsan', credential: 'sso=abc' })
    const mode = (await stat(path.join(root, 'users', 'zhangsan', 'cron-credential.json'))).mode & 0o777
    assert.equal(mode, 0o600, `凭据文件权限应为 600，实际 ${mode.toString(8)}`)
  })
})

describe('调度', () => {
  let root
  let crons
  let scheduler
  let executed

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ap-sched-'))
    crons = createCronStore({ config: { dataDir: root, cron: { enabled: true } }, logger: silentLogger })
    executed = []
    scheduler = createScheduler({
      // llm.mode=faux → 不需要用户凭据也能跑，正好把"缺登录态"那条路径隔开单独测
      config: { dataDir: root, cron: { enabled: true }, llm: { mode: 'faux' } },
      logger: silentLogger,
      crons,
      vault: createCronCredentialVault({ config: { dataDir: root, cron: {} }, logger: silentLogger }),
      runService: {
        async execute(request) {
          executed.push(request)
          return { runId: 'r1', durationMs: 5, finalText: '干完了' }
        },
      },
    })
  })
  afterEach(async () => { scheduler.stop(); await rm(root, { recursive: true, force: true }) })

  test('到期就跑，跑完记一笔', async () => {
    const cron = await crons.create({
      username: 'zhangsan', title: 'x', task: '汇总告警', schedule: { cron: '* * * * *', timezone: TZ },
    })
    await scheduler.tick(Date.now() + 10 * 60000)

    assert.equal(executed.length, 1)
    assert.equal(executed[0].source, 'cron')
    assert.equal(executed[0].subject.username, 'zhangsan')
    assert.match(executed[0].prompt, /汇总告警/)
    assert.match(executed[0].prompt, /没有人在对面/, '必须告诉模型这是无人值守的触发')

    const stored = await crons.get({ username: 'zhangsan', id: cron.id })
    assert.equal(stored.fireLog.at(-1).status, 'ok')
  })

  test('同一格不会跑两遍（连着 tick 两次）', async () => {
    await crons.create({ username: 'zhangsan', title: 'x', task: 'x', schedule: { cron: '* * * * *', timezone: TZ } })
    const at = Date.now() + 10 * 60000
    await scheduler.tick(at)
    await scheduler.tick(at)
    assert.equal(executed.length, 1)
  })

  /**
   * 停机之后欠下的那些格子只补跑**一次**。
   *
   * 这里故意让 tick 落在"该任务已经错过 10 拍"的时刻（每分钟一次的任务，晚了 10 分钟）。
   * 若推进是机械地加一格，补出来的下一格仍在过去，于是每个 tick 都判定到期 ——
   * 十分钟的欠账会在几秒内连着轰出来。
   */
  test('停机后不补跑欠下的每一拍', async () => {
    await crons.create({ username: 'zhangsan', title: 'x', task: 'x', schedule: { cron: '* * * * *', timezone: TZ } })
    const late = Date.now() + 10 * 60000
    for (let i = 0; i < 5; i += 1) await scheduler.tick(late)
    assert.equal(executed.length, 1, `补跑了 ${executed.length} 次 —— 欠账应该被折叠成一次`)
  })

  test('每次触发默认开新会话，sessionKey 落在合法字符集里', async () => {
    await crons.create({ username: 'zhangsan', title: 'x', task: 'x', schedule: { cron: '* * * * *', timezone: TZ } })
    await scheduler.tick(Date.now() + 10 * 60000)
    // 与 http/server.js 的 SESSION_KEY_RE 一致，否则界面点开会 400
    assert.match(executed[0].sessionKey, /^[A-Za-z0-9_-]{1,128}$/)
  })

  test('shared 模式历次触发共用一条会话', async () => {
    const cron = await crons.create({
      username: 'zhangsan', title: 'x', task: 'x', sessionMode: 'shared',
      schedule: { cron: '* * * * *', timezone: TZ },
    })
    await scheduler.tick(Date.now() + 10 * 60000)
    await scheduler.tick(Date.now() + 20 * 60000)
    assert.equal(executed.length, 2)
    assert.equal(executed[0].sessionKey, executed[1].sessionKey)
    assert.equal(executed[0].sessionKey, `cron_${cron.id}`)
  })

  test('停用的任务不跑', async () => {
    const cron = await crons.create({ username: 'zhangsan', title: 'x', task: 'x', schedule: { cron: '* * * * *', timezone: TZ } })
    await crons.update({ username: 'zhangsan', id: cron.id, enabled: false })
    await scheduler.tick(Date.now() + 10 * 60000)
    assert.equal(executed.length, 0)
  })

  test('执行失败记成 error，但不退回这一格（否则每个 tick 都重试一次）', async () => {
    const cron = await crons.create({ username: 'zhangsan', title: 'x', task: 'x', schedule: { cron: '* * * * *', timezone: TZ } })
    const failing = createScheduler({
      config: { dataDir: root, cron: { enabled: true }, llm: { mode: 'faux' } },
      logger: silentLogger,
      crons,
      vault: createCronCredentialVault({ config: { dataDir: root, cron: {} }, logger: silentLogger }),
      runService: { async execute() { throw Object.assign(new Error('沙盒满了'), { code: 'BUSY' }) } },
    })
    const at = Date.now() + 10 * 60000
    await failing.tick(at)
    const stored = await crons.get({ username: 'zhangsan', id: cron.id })
    assert.equal(stored.fireLog.at(-1).status, 'error')
    assert.match(stored.fireLog.at(-1).note, /沙盒满了/)
    assert.ok(stored.nextFireAt > at, '这一格必须已经被推走，不能原地重试')
  })

  test('LLM_MODE=platform 且没有凭据时记 needs_reauth，而不是白跑一个 run', async () => {
    await crons.create({ username: 'zhangsan', title: 'x', task: 'x', schedule: { cron: '* * * * *', timezone: TZ } })
    const noCred = createScheduler({
      config: { dataDir: root, cron: { enabled: true }, llm: { mode: 'platform' } },
      logger: silentLogger,
      crons,
      vault: createCronCredentialVault({ config: { dataDir: root, cron: {} }, logger: silentLogger }),
      runService: { async execute(request) { executed.push(request); return { runId: 'r', durationMs: 1, finalText: '' } } },
    })
    await noCred.tick(Date.now() + 10 * 60000)
    assert.equal(executed.length, 0, '拿不到登录态就别开 run')
    const [cron] = await crons.list({ username: 'zhangsan' })
    const last = cron.fireLog.at(-1)
    assert.equal(last.status, 'needs_reauth')
    assert.match(last.note, /CRON_CREDENTIAL_MODE/, '要告诉运维缺的是哪个开关')
  })

  test('两个用户的任务各跑各的', async () => {
    await crons.create({ username: 'zhangsan', title: 'x', task: '张三的活', schedule: { cron: '* * * * *', timezone: TZ } })
    await crons.create({ username: 'lisi', title: 'y', task: '李四的活', schedule: { cron: '* * * * *', timezone: TZ } })
    await scheduler.tick(Date.now() + 10 * 60000)

    assert.equal(executed.length, 2)
    const byUsername = Object.fromEntries(executed.map((request) => [request.subject.username, request.prompt]))
    assert.match(byUsername.zhangsan, /张三的活/)
    assert.match(byUsername.lisi, /李四的活/)
    assert.doesNotMatch(byUsername.zhangsan, /李四/)
  })
})
