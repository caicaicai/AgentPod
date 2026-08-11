/**
 * 排期解析：5 段 cron 表达式（带时区）与固定间隔两种。
 *
 * ── 为什么自己写而不是装个 croner ───────────────────────────────────────
 *
 * 本项目的运行依赖只有 pi 那两个包（见 package.json）。为一个几十行的表达式解析
 * 引入一条新依赖链，换来的是"部署时多一个要审的包"和"升级时多一个会漂的版本"。
 * 而 cron 表达式这件事的语义三十年没变过，写死比跟着别人升级更省心。
 *
 * ── 时区必须是显式的 ────────────────────────────────────────────────────
 *
 * "每天早上 9 点"这句话没有时区就没有意义。服务器可能跑在 UTC 容器里，
 * 用户在北京。所以 cron 一律带 `timezone`（IANA 名，默认 Asia/Shanghai），
 * 计算下一次触发时间时按那个时区的**墙上时间**来匹配。
 *
 * 反过来，固定间隔（everyMs）**不允许 >= 24 小时**：那种需求十有八九其实是
 * "每天某个点"，用间隔表达会锚在一个随机的起点上、还会被夏令时推着漂。
 * 这条限制是从 qm 那边照搬的，理由完全一样。
 */

export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/** 最短间隔。比这更密的轮询该用长连接或 webhook，不该是定时任务 */
export const MIN_EVERY_MS = 60 * 1000

/** 往后最多找多少天。找不到就是这条表达式在未来一年内不会触发（如 2月30日） */
const SEARCH_DAYS = 366

const FIELD_RANGES = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '星期', min: 0, max: 7 }, // 7 与 0 都表示周日
]

const MONTH_ALIASES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DOW_ALIASES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function aliasToNumber(token, index) {
  const lower = token.toLowerCase()
  if (index === 3) {
    const at = MONTH_ALIASES.indexOf(lower)
    if (at >= 0) return String(at + 1)
  }
  if (index === 4) {
    const at = DOW_ALIASES.indexOf(lower)
    if (at >= 0) return String(at)
  }
  return token
}

/** 一个字段 → 允许值的集合 */
function parseField(raw, index) {
  const { name, min, max } = FIELD_RANGES[index]
  const allowed = new Set()

  for (const part of String(raw).split(',')) {
    const piece = part.trim()
    if (!piece) throw new Error(`cron 的「${name}」字段有空项`)

    const [rangeText, stepText] = piece.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`cron 的「${name}」字段步长必须是正整数：${piece}`)

    let from
    let to
    if (rangeText === '*') {
      from = min
      to = max
    } else {
      const [a, b] = rangeText.split('-').map((token) => Number(aliasToNumber(token.trim(), index)))
      if (!Number.isInteger(a)) throw new Error(`cron 的「${name}」字段看不懂：${piece}`)
      from = a
      to = b === undefined ? (stepText === undefined ? a : max) : b
      if (!Number.isInteger(to)) throw new Error(`cron 的「${name}」字段看不懂：${piece}`)
    }
    if (from < min || to > max || from > to) {
      throw new Error(`cron 的「${name}」字段超出范围 ${min}-${max}：${piece}`)
    }
    for (let value = from; value <= to; value += step) allowed.add(value)
  }

  // 星期字段把 7 归一成 0，后面匹配时只认 0-6
  if (index === 4 && allowed.has(7)) {
    allowed.delete(7)
    allowed.add(0)
  }
  return allowed
}

/**
 * 解析 5 段表达式。返回 5 个集合 + 两个"是不是通配"的标记。
 *
 * `domRestricted` / `dowRestricted` 要单独留着：cron 有一条反直觉的规则 ——
 * **日和星期都被限制时，两者是「或」的关系**（`0 0 1 * 1` = 每月 1 号**以及**每周一）。
 * 不记这两个标记就没法区分"没限制"和"限制成了全集"。
 */
export function parseCron(expression) {
  const fields = String(expression || '').trim().replace(/\s+/g, ' ').split(' ')
  if (fields.length !== 5) {
    throw new Error(`cron 必须是 5 段（分 时 日 月 星期），当前 ${fields.length} 段：${expression}`)
  }
  return {
    minute: parseField(fields[0], 0),
    hour: parseField(fields[1], 1),
    dom: parseField(fields[2], 2),
    month: parseField(fields[3], 3),
    dow: parseField(fields[4], 4),
    domRestricted: fields[2].trim() !== '*',
    dowRestricted: fields[4].trim() !== '*',
  }
}

export function assertTimezone(timezone) {
  const tz = String(timezone || '').trim() || DEFAULT_TIMEZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    throw new Error(`不认识的时区（要 IANA 名，如 Asia/Shanghai）：${tz}`)
  }
  return tz
}

const partsFormatterCache = new Map()
function partsFormatter(timezone) {
  let formatter = partsFormatterCache.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    partsFormatterCache.set(timezone, formatter)
  }
  return formatter
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** 某个瞬间在某时区的墙上时间 */
export function wallClock(ts, timezone) {
  const parts = {}
  for (const part of partsFormatter(timezone).formatToParts(new Date(ts))) parts[part.type] = part.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour), // 某些 ICU 版本把午夜给成 24
    minute: Number(parts.minute),
    second: Number(parts.second),
    dow: WEEKDAY_INDEX[parts.weekday] ?? 0,
  }
}

/** 该时区在某个瞬间的 UTC 偏移（毫秒） */
function offsetAt(ts, timezone) {
  const wall = wallClock(ts, timezone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return asUtc - Math.floor(ts / 1000) * 1000
}

/**
 * 墙上时间 → UTC 瞬间。
 *
 * 先按 UTC 猜一个，再用那个瞬间的真实偏移修正，最后复核一次 —— 夏令时切换那两个
 * 小时里，第一次猜出来的偏移可能属于切换前。不复核的话，每年有两天会差一小时。
 */
function utcFromWall({ year, month, day, hour, minute }, timezone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  const first = guess - offsetAt(guess, timezone)
  const second = guess - offsetAt(first, timezone)
  return second
}

function matchesDay(fields, wall) {
  if (!fields.month.has(wall.month)) return false
  // 日与星期都被限制时是「或」，否则各自必须匹配
  if (fields.domRestricted && fields.dowRestricted) {
    return fields.dom.has(wall.day) || fields.dow.has(wall.dow)
  }
  return fields.dom.has(wall.day) && fields.dow.has(wall.dow)
}

/**
 * `after` 之后的下一次触发（严格大于）。找不到返回 undefined。
 *
 * 按「天 → 小时 → 分钟」逐层收缩，而不是一分钟一分钟地试：最坏情况下
 * 366 + 24 + 60 次判断，而逐分钟要 52 万次（每次都要过一遍 Intl，会真的卡住）。
 */
export function nextFireAfter(cron, timezone, after) {
  const fields = parseCron(cron)
  const tz = assertTimezone(timezone)

  // 从下一整分钟开始找：同一分钟内不重复触发
  let cursor = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  const startWall = wallClock(cursor, tz)
  let { year, month, day } = startWall
  let fromHour = startWall.hour
  let fromMinute = startWall.minute

  for (let dayIndex = 0; dayIndex < SEARCH_DAYS; dayIndex += 1) {
    const dayWall = wallClock(utcFromWall({ year, month, day, hour: 12, minute: 0 }, tz), tz)
    if (matchesDay(fields, dayWall)) {
      for (let hour = fromHour; hour <= 23; hour += 1) {
        if (!fields.hour.has(hour)) continue
        const minuteStart = hour === fromHour ? fromMinute : 0
        for (let minute = minuteStart; minute <= 59; minute += 1) {
          if (!fields.minute.has(minute)) continue
          const ts = utcFromWall({ year, month, day, hour, minute }, tz)
          /**
           * 复核一遍落回墙上时间是否真的是这个点。
           *
           * 夏令时"春季跳过"的那一小时里，2:30 这样的墙上时间根本不存在，
           * utcFromWall 会给出一个落在 3:30 的瞬间。不复核就会在不该触发的时刻触发。
           */
          const back = wallClock(ts, tz)
          if (back.hour !== hour || back.minute !== minute) continue
          if (ts > after) return ts
        }
      }
    }
    // 下一天。用 UTC 日历推进，再折回该时区读一次，避免自己处理月末与闰年
    const nextDay = wallClock(utcFromWall({ year, month, day, hour: 12, minute: 0 }, tz) + DAY_MS, tz)
    year = nextDay.year
    month = nextDay.month
    day = nextDay.day
    fromHour = 0
    fromMinute = 0
  }
  return undefined
}

/**
 * 校验并归一化用户提交的排期，同时算出第一次触发时间。
 *
 * @param {{cron?: string, timezone?: string, everyMs?: number, firstFireAt?: number}} input
 * @returns {{schedule: object, nextFireAt: number|undefined}}
 */
export function normalizeSchedule(input, now = Date.now()) {
  const hasCron = input?.cron !== undefined && String(input.cron).trim() !== ''
  const hasEvery = input?.everyMs !== undefined && input.everyMs !== null

  if (hasCron) {
    if (hasEvery) throw new Error('cron 与 everyMs 只能二选一')
    const timezone = assertTimezone(input.timezone)
    const cron = String(input.cron).trim().replace(/\s+/g, ' ')
    parseCron(cron) // 语法错误在这里就抛，而不是等到第一次该触发时才发现
    const nextFireAt = nextFireAfter(cron, timezone, now)
    if (nextFireAt === undefined) throw new Error(`这条 cron 在未来一年内不会触发：${cron}`)
    return { schedule: { cron, timezone }, nextFireAt }
  }

  if (!hasEvery) throw new Error('必须给出 cron 或 everyMs')
  if (input.timezone) throw new Error('timezone 只对 cron 有意义（固定间隔不看墙上时间）')

  const everyMs = Number(input.everyMs)
  if (!Number.isSafeInteger(everyMs) || everyMs <= 0) throw new Error('everyMs 必须是正整数（毫秒）')
  if (everyMs < MIN_EVERY_MS) throw new Error(`everyMs 不能小于 ${MIN_EVERY_MS} 毫秒`)
  if (everyMs >= DAY_MS) {
    throw new Error(
      'everyMs >= 24 小时几乎总是"其实想要每天某个点"：它锚在一个随机起点上、没有时区、' +
      '还会被夏令时推着漂。请改用 cron，例如 { cron: "30 9 * * 1-5", timezone: "Asia/Shanghai" }。',
    )
  }

  const firstFireAt = Number.isSafeInteger(input.firstFireAt) ? input.firstFireAt : now + everyMs
  return { schedule: { everyMs, firstFireAt }, nextFireAt: firstFireAt }
}

export function isCalendarSchedule(schedule) {
  return Boolean(schedule?.cron)
}

/** 触发之后，下一次是什么时候 */
export function advanceNextFireAt(schedule, firedAt) {
  if (isCalendarSchedule(schedule)) return nextFireAfter(schedule.cron, schedule.timezone, firedAt)
  if (!schedule?.everyMs) return undefined
  return firedAt + schedule.everyMs
}

/**
 * 从落盘的记录里恢复"下一次该什么时候触发"。
 *
 * 有存下来的 nextFireAt 就用它；没有（老记录、或写盘时崩了）就按排期重算 ——
 * 重算的基准是"上次触发时间"，没触发过就用创建时间。
 */
export function recoverNextFireAt(schedule, createdAt, lastFiredAt, nextFireAt) {
  if (Number.isSafeInteger(nextFireAt)) return nextFireAt
  if (isCalendarSchedule(schedule)) return nextFireAfter(schedule.cron, schedule.timezone, lastFiredAt ?? createdAt)
  if (!schedule?.everyMs) return undefined
  if (lastFiredAt === undefined) return schedule.firstFireAt ?? createdAt
  return lastFiredAt + schedule.everyMs
}

/** 给界面用的一句话描述 */
export function describeSchedule(schedule) {
  if (isCalendarSchedule(schedule)) return `cron ${schedule.cron}（${schedule.timezone}）`
  if (!schedule?.everyMs) return '未设置'
  const minutes = Math.round(schedule.everyMs / MINUTE_MS)
  return minutes >= 60 && minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`
}
