/**
 * cron —— 让模型直接把"以后每天帮我…"变成一条定时任务。
 *
 * ── 为什么给模型而不是只给界面 ──────────────────────────────────────────
 *
 * "每周一早上把上周的工单汇总发我"这句话，用户是在对话里说的。要求他说完再去
 * 另一个面板把同一件事重新填一遍表单（还得自己写 cron 表达式），是把系统的实现
 * 方式当成了用户的负担。模型把这句话翻译成排期，本来就是它擅长的事。
 *
 * 界面那条路仍然保留（改和删更适合点，而不是描述），两者写的是同一份存储。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 *
 * 作用域由 ctx 决定，参数里没有 username：模型改不到别人的任务（隔离契约 #4）。
 * 触发时能不能拿到登录态是另一回事 —— 见 src/cron/credentials.js。
 */
import { jsonResult } from './plugin-api.js'
import { describeSchedule } from '../cron/schedule.js'

const DESCRIPTION = [
  '创建/查看/修改/删除**定时任务**：到点了系统会自动叫醒你，把 task 里的指令执行一遍。',
  '什么时候用：用户表达了"以后每天/每周…帮我…"、"定时提醒我…"、"每隔一段时间检查一下…"。',
  '',
  'action 取值：list / create / update / remove。',
  '',
  '排期二选一：',
  '- schedule.cron：5 段表达式「分 时 日 月 星期」，配合 schedule.timezone（默认 Asia/Shanghai）。',
  '  例：每天 9:30 → "30 9 * * *"；工作日 8 点 → "0 8 * * 1-5"；每月 1 号 → "0 0 1 * *"。',
  '- schedule.everyMs：固定间隔（毫秒），**只用于不到一天的轮询**，最小 60000。',
  '  想要"每天某个点"一律用 cron —— 用间隔表达会漂。',
  '',
  'task 要写成**给未来的自己看的完整指令**：那次触发没有本次对话的上下文，',
  '所以背景、目标、输出形式都要写进去，不能写成"照上面说的做"。',
  '',
  '创建成功后请把「任务名 + 下次触发时间」告诉用户，让他知道确实建上了。',
].join('\n')

const SCHEDULE_SCHEMA = {
  type: 'object',
  properties: {
    cron: { type: 'string', description: '5 段 cron 表达式，如 "30 9 * * 1-5"' },
    timezone: { type: 'string', description: 'IANA 时区名，默认 Asia/Shanghai' },
    everyMs: { type: 'number', description: '固定间隔毫秒数，最小 60000，且必须小于 24 小时' },
  },
}

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'create', 'update', 'remove'], description: '要做什么' },
    id: { type: 'string', description: 'update / remove 时的任务 id（先用 list 查）' },
    title: { type: 'string', description: '任务名，一句话，如「每周工单汇总」' },
    task: { type: 'string', description: '到点要执行的完整指令（触发时没有本次对话的上下文）' },
    schedule: SCHEDULE_SCHEMA,
    sessionMode: {
      type: 'string',
      enum: ['new', 'shared'],
      description: 'new=每次开新会话（默认，各次互不干扰）/ shared=历次触发共用一条会话（需要连续上下文时用）',
    },
    enabled: { type: 'boolean', description: 'update 时用于启用/停用' },
  },
  required: ['action'],
}

function toPublic(cron) {
  return {
    id: cron.id,
    title: cron.title,
    task: cron.task,
    schedule: describeSchedule(cron.schedule),
    sessionMode: cron.sessionMode,
    enabled: cron.enabled,
    nextFireAt: cron.nextFireAt ? new Date(cron.nextFireAt).toISOString() : null,
    lastFiredAt: cron.lastFiredAt ? new Date(cron.lastFiredAt).toISOString() : null,
    // 最近一次跑得怎么样。模型据此回答"我那个定时任务正常吗"
    lastStatus: cron.fireLog?.length ? cron.fireLog[cron.fireLog.length - 1].status : null,
  }
}

export function registerCronTool(api) {
  api.registerTool({
    name: 'cron',
    label: '定时任务',
    description: DESCRIPTION,
    parameters: SCHEMA,
    async execute(_toolCallId, params) {
      const crons = api.ctx.crons
      if (!crons?.available) return jsonResult({ ok: false, error: '本部署未启用定时任务' })

      const action = String(params?.action || '').trim()

      try {
        if (action === 'list') {
          const all = await crons.list()
          return jsonResult({ ok: true, count: all.length, crons: all.map(toPublic) })
        }

        if (action === 'create') {
          const task = String(params?.task || '').trim()
          if (!task) return jsonResult({ ok: false, error: 'create 需要 task（到点要执行的指令）' })
          if (!params?.schedule) return jsonResult({ ok: false, error: 'create 需要 schedule（cron 或 everyMs）' })
          const created = await crons.create({
            title: params.title,
            task,
            schedule: params.schedule,
            sessionMode: params.sessionMode,
          })
          return jsonResult({ ok: true, cron: toPublic(created) })
        }

        if (action === 'update') {
          const id = String(params?.id || '').trim()
          if (!id) return jsonResult({ ok: false, error: 'update 需要 id（先用 list 查）' })
          const updated = await crons.update({ ...params, id })
          if (!updated) return jsonResult({ ok: false, error: `没有这条定时任务：${id}` })
          return jsonResult({ ok: true, cron: toPublic(updated) })
        }

        if (action === 'remove') {
          const id = String(params?.id || '').trim()
          if (!id) return jsonResult({ ok: false, error: 'remove 需要 id（先用 list 查）' })
          await crons.remove(id)
          return jsonResult({ ok: true, removed: id })
        }

        return jsonResult({ ok: false, error: `未知 action：${action}` })
      } catch (error) {
        /**
         * 排期写错是**最常见**的失败，而错误信息里已经写清了该怎么改
         * （见 src/cron/schedule.js 的报错文案）。原样回给模型，它下一次就能改对；
         * 包成一句"创建失败"等于让它盲猜。
         */
        return jsonResult({ ok: false, error: error?.message || String(error) })
      }
    },
  })
}

export const cronPlugin = {
  id: 'ap-cron',
  register: registerCronTool,
}
