/**
 * 定时任务存储（按 username 隔离）。
 *
 *   <dataDir>/users/<username>/cron/<id>.json
 *
 * 一条任务长这样：
 *
 *   { id, title, task, schedule, sessionMode, projectId, enabled, archived,
 *     createdAt, updatedAt, lastFiredAt, nextFireAt, fireLog: [...] }
 *
 * ── 两个刻意的设计 ──────────────────────────────────────────────────────
 *
 * **nextFireAt 落盘。** 可以每次都从 schedule 现算，但落盘之后重启不会"漏掉一拍"，
 * 也让 `due()` 变成一次纯比较而不是几百次 cron 求解。算不出来时还能从 lastFiredAt
 * 兜底重建（recoverNextFireAt）。
 *
 * **claimSlot 先占坑再执行。** 先把 nextFireAt 推到下一格、再去跑，而不是跑完再推。
 * 顺序反过来的话，一次跑了五分钟的任务在这五分钟里会被下一次 tick 反复认为"到期了"。
 * 代价是任务崩溃时这一格就跳过了 —— 用 unclaim 在失败路径上退回来。
 */
import { randomUUID } from 'node:crypto'

import { createScopedMaps } from '../persistence/file-map.js'
import { advanceNextFireAt, isCalendarSchedule, normalizeSchedule, recoverNextFireAt } from './schedule.js'

const TITLE_MAX = 60
const TASK_MAX = 4000

/** 每条任务保留多少次触发记录。够看清"最近怎么样"，又不会让文件无限长 */
const FIRE_LOG_MAX = 20

/** 一次触发记录里回复正文留多长 */
const REPLY_MAX = 1000

function cleanTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
}

function truncate(text, max) {
  const flat = String(text || '')
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function newCronId() {
  return `c_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function createCronStore({ config, logger = console }) {
  const maps = createScopedMaps({ dataDir: config.dataDir, collection: 'cron', logger })
  const enabled = config.cron?.enabled !== false

  return {
    enabled,

    async create({ username, title, task, schedule, sessionMode = 'new', projectId = '', enabled: on = true }) {
      const cleanTask = String(task || '').trim().slice(0, TASK_MAX)
      if (!cleanTask) throw new Error('定时任务的指令内容不能为空')
      const now = Date.now()
      const normalized = normalizeSchedule(schedule, now)
      const record = {
        id: newCronId(),
        username,
        title: cleanTitle(title) || truncate(cleanTask.split('\n')[0], TITLE_MAX),
        task: cleanTask,
        schedule: normalized.schedule,
        /**
         * 每次触发用哪个会话：
         *   new    每次开一个新会话（默认）—— 触发之间互不干扰，也不会把一条会话撑到几百轮
         *   shared 固定一条会话，历次触发在同一条上下文里累积
         */
        sessionMode: sessionMode === 'shared' ? 'shared' : 'new',
        projectId: String(projectId || ''),
        enabled: on !== false,
        archived: false,
        createdAt: now,
        updatedAt: now,
        nextFireAt: normalized.nextFireAt,
        fireLog: [],
      }
      await maps.for(username).put(record.id, record)
      return record
    },

    get: ({ username, id }) => maps.for(username).get(id),

    async list({ username, includeArchived = false } = {}) {
      const all = await maps.for(username).all()
      return all
        .filter((cron) => includeArchived || !cron.archived)
        .sort((a, b) => (a.nextFireAt || Infinity) - (b.nextFireAt || Infinity))
    },

    /**
     * 局部更新。逐字段取，**不展开请求体** —— 展开的话请求体里塞个 `username` 就能改归属。
     * 改了排期就顺手把 nextFireAt 重算，否则新排期要等下一次触发才生效。
     */
    async update({ username, id, title, task, schedule, sessionMode, projectId, enabled: on, archived }) {
      const fields = { updatedAt: Date.now() }
      if (title !== undefined) fields.title = cleanTitle(title)
      if (task !== undefined) {
        const cleanTask = String(task).trim().slice(0, TASK_MAX)
        if (!cleanTask) throw new Error('定时任务的指令内容不能为空')
        fields.task = cleanTask
      }
      if (schedule !== undefined) {
        const normalized = normalizeSchedule(schedule, Date.now())
        fields.schedule = normalized.schedule
        fields.nextFireAt = normalized.nextFireAt
      }
      if (sessionMode !== undefined) fields.sessionMode = sessionMode === 'shared' ? 'shared' : 'new'
      if (projectId !== undefined) fields.projectId = String(projectId || '')
      if (on !== undefined) {
        fields.enabled = Boolean(on)
        // 重新启用时把下一拍算到"从现在起"，否则会立刻补触发一次停用期间欠下的
        if (on) fields.nextFireAt = advanceNextFireAt(
          (await maps.for(username).get(id))?.schedule || {},
          Date.now(),
        )
      }
      if (archived !== undefined) {
        fields.archived = Boolean(archived)
        if (archived) fields.enabled = false // 归档的任务不该还在跑
      }
      return maps.for(username).merge(id, fields)
    },

    remove: ({ username, id }) => maps.for(username).delete(id),

    /**
     * 占坑：把 nextFireAt 推到下一格，返回是否占到。
     *
     * 只有"当前该触发的那一格正好等于 scheduledAt"时才算占到 —— 于是同一格
     * 不会被两次 tick 各跑一遍（同一进程内由 file-map 的串行队列保证）。
     */
    async claimSlot({ username, id, scheduledAt, at }) {
      let claimed = false
      await maps.for(username).update(id, (cron) => {
        claimed = false
        if (cron.archived || !cron.enabled) return cron
        if (recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) !== scheduledAt) return cron
        claimed = true
        /**
         * 往后推到**下一个未来的**格子，而不是机械地加一格。
         *
         * 日历排期取 `max(计划时刻, 现在)`：
         *   - 正常情况下两者只差几秒，等价于"从计划时刻推"——每天 9 点的任务
         *     晚触发两秒，下一格仍然是明天 9 点，不会漂成 9:00:02；
         *   - 服务停了三天再起来时，两者差很多。这时若从计划时刻推，补出来的
         *     下一格仍在过去，于是**每个 tick 都判定到期**，三天的欠账会在几分钟里
         *     连着轰出来。对"每天汇总告警"这种任务，那是三份重复的打扰；对
         *     每分钟轮询的任务，那是几百个 run 瞬间打满并发预算。
         *     宕机之后补跑**一次**是合理的，补跑 N 次不是。
         *
         * 间隔排期本来就从"实际触发时刻"推（它要的是"距上次多久"），天然没这个问题。
         */
        const advanceFrom = isCalendarSchedule(cron.schedule) ? Math.max(scheduledAt, at) : at
        return { ...cron, lastFiredAt: at, nextFireAt: advanceNextFireAt(cron.schedule, advanceFrom) }
      })
      return claimed
    },

    /** 占了坑但没跑成时退回来，别把这一格白白吃掉 */
    async unclaimSlot({ username, id, scheduledAt, at, priorLastFiredAt }) {
      await maps.for(username).update(id, (cron) => {
        if (cron.lastFiredAt !== at) return cron // 已经被别的路径改过，不动
        return { ...cron, lastFiredAt: priorLastFiredAt, nextFireAt: scheduledAt }
      })
    },

    /** 记一次触发结果。只留最近 FIRE_LOG_MAX 条 */
    async recordFire({ username, id, entry }) {
      await maps.for(username).update(id, (cron) => {
        const log = [...(cron.fireLog || []), {
          ...entry,
          reply: entry.reply === undefined ? undefined : truncate(entry.reply, REPLY_MAX),
          note: entry.note === undefined ? undefined : truncate(entry.note, REPLY_MAX),
        }]
        return { ...cron, fireLog: log.slice(-FIRE_LOG_MAX) }
      })
    },

    /**
     * 全体用户里到期的任务。
     *
     * 这是**唯一**一个跨 username 的读取口，调度器必须能看到所有人的任务。
     * 它回的每条都带 username，下游据此拿到正确的作用域 —— 隔离仍然成立，
     * 只是"谁能调用它"收窄到了调度器一个地方。
     */
    async due(now) {
      const out = []
      for (const username of await maps.usernames()) {
        let crons
        try {
          crons = await maps.for(username).all()
        } catch (error) {
          logger.warn?.('读取用户定时任务失败，跳过', { username, err: error?.message })
          continue
        }
        for (const cron of crons) {
          if (cron.archived || !cron.enabled) continue
          const scheduledAt = recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt)
          if (scheduledAt !== undefined && now >= scheduledAt) out.push({ ...cron, username, scheduledAt })
        }
      }
      return out.sort((a, b) => a.scheduledAt - b.scheduledAt)
    },
  }
}
