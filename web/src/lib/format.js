/**
 * 时间与统计的文案。
 *
 * 单独一份的理由：同一个数字要在实时那一轮和刷新后的历史里长得**一模一样**，
 * 各写一遍迟早漂移（"3.2 秒"和"3秒"混在一屏里，看起来像两种不同的东西）。
 */

const pad = (n) => String(n).padStart(2, '0')

/** 会话列表里的时间戳：今天只给时分，往前给月日，再往前带上年 */
export function formatTime(ts) {
  if (!ts) return ''
  const date = new Date(ts)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/** 定时任务的「下次触发」：要精确到分，日期也不能省 */
export function formatDateTime(ts) {
  if (!ts) return ''
  const date = new Date(ts)
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 消息气泡上的绝对时间 */
export function formatClock(ts) {
  if (!ts) return ''
  const date = new Date(ts)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 本轮的「耗时 · 工具调用次数」。
 *
 * 数字由服务端算（sessions/transcript.js 的 attachTurnStats），这里只管怎么写成一句话 ——
 * 实时那一轮和刷新后的历史都调这一个函数，所以两边**长得也一样**，不只是数值一样。
 */
export function formatTurnStats(stats) {
  if (!stats) return ''
  const parts = []
  const ms = stats.durationMs
  if (typeof ms === 'number' && ms >= 0) {
    // 一分钟以内给一位小数（3.2 秒比"3 秒"更有信息量），超过就换成分秒
    parts.push(ms < 60000
      ? `耗时 ${(ms / 1000).toFixed(1)} 秒`
      : `耗时 ${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`)
  }
  // 0 次也要显示：那说明这一轮模型是直接答的，没动任何工具 —— 这是有意义的信息，
  // 而"不显示"会和"这条历史太老、算不出来"混在一起。
  parts.push(`工具调用 ${stats.toolCalls || 0} 次`)
  return parts.join(' · ')
}

/**
 * Token 数。
 *
 * 千位分隔而不是 `1.2M`：管理台那张表是用来**对比几个人**的，缩写会把
 * 980k 和 1.1M 摆成看起来差不多的两个短字符串，而它们差一个量级。
 * 表格里配 `tabular-nums`，位数对齐之后长短本身就是信息。
 */
export function formatTokens(n) {
  const value = Number(n) || 0
  return value.toLocaleString('en-US')
}

/**
 * 用量表里的"最近一次"。
 *
 * 与 formatTime 分开：那个函数今天之内只给时分（会话列表里够用，因为旁边就有
 * 一句正文），而这里一列全是时间，只写 `09:30` 看不出是哪天。
 */
export function formatSince(ts) {
  if (!ts) return '—'
  const date = new Date(ts)
  const days = Math.floor((Date.now() - date.getTime()) / 86400000)
  if (days <= 0) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days === 1) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return formatDateTime(ts)
}

/** 与服务端 describeSchedule 同口径。前端也要能独立渲染，不为一句话再加一个字段 */
export function describeSchedule(schedule) {
  if (schedule?.cron) return `${schedule.cron}（${schedule.timezone || 'Asia/Shanghai'}）`
  if (schedule?.everyMs) {
    const minutes = Math.round(schedule.everyMs / 60000)
    return minutes >= 60 && minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`
  }
  return '未设置'
}
