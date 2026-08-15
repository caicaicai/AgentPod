/**
 * Token 额度闸门：一次对话开始之前，问一句"这个人还有额度吗"。
 *
 * ── 额度住在分组上 ──────────────────────────────────────────────────────
 *
 * 配在哪、口径是什么，写在 src/identity/group-store.js 的文件头（一句话：
 * **按人算，不是全组共用一个池子**；0 = 不限；没有分组的人不受限）。
 * 这里只负责**执行**它。
 *
 * ── 为什么是"开始前拦"，不是"超了就掐断" ────────────────────────────────
 *
 * 用量是这一轮**跑完**才知道的（模型返回里才有 usage）。所以额度必然是一道
 * 事前闸门，判据是"截至上一轮为止已经用掉多少"：
 *
 *   - 它**会超**。最后那一轮开始时还剩 1 个 token，也照样让它跑完 ——
 *     超出的那部分记在账上、下一轮被拦住。想做到一个 token 都不超，
 *     得在流式输出中途掐断模型，那对用户是"答到一半没了"，
 *     而省下来的那点量买不到这个体验。
 *   - 它**不因失败而扣**。失败的 run 本来就不记账（见 run-service 的 usage.record
 *     只在成功路径上调），所以重试不会白扣额度。
 *
 * ── 拦下来时报什么错，是有讲究的 ────────────────────────────────────────
 *
 *   总额度用完   403 FORBIDDEN     —— 等下去没有用，只有管理员调高上限才行
 *   当日额度用完 429 RATE_LIMITED  —— 过了零点自己就好了，带上 retryAfterMs
 *
 * 分开不是为了好看：定时任务（src/cron）拿到 429 会退避重试，而拿到 403 就该
 * 停下来别再打了。两个都报成同一个码的话，一个总额度烧光的账号下面挂的定时任务
 * 会一直重试到永远，每次都失败。
 *
 * ── 库挂了怎么办：放行 ──────────────────────────────────────────────────
 *
 * 查不到用量就当没超。理由是这道闸门防的是"跑飞的任务把预算烧光"，不是安全边界
 * （见 group-store 文件头：把人移出分组就解开了限制）。而库真挂了的时候，
 * 会话、记忆、作品本来也都读不出来 —— 让所有人**额外**再收一条"额度查不到"的
 * 报错，只是把一次故障放大成两种表现。
 */
import { Errors } from '../errors.js'
/**
 * 时区换算借 cron 那一套。
 *
 * 它们本来就是同一件事（"当地的某个钟点是哪个瞬间"），而这件事有一个每年会咬人
 * 两次的坑：夏令时切换那两个小时里，按 UTC 猜出来的偏移可能属于切换前。
 * schedule.js 里那个两遍复核已经把它处理掉了，再写一份只是让部署多一个
 * 每年错两天的地方 —— 而且两份会在**不同的两天**出错。
 */
import { wallClock, utcFromWall, assertTimezone } from '../cron/schedule.js'

/** 兜底时区。与 cron 的默认值一致（src/cron/schedule.js：用户在北京） */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/**
 * 「今天从哪一刻开始」——回的是一个**瞬间**（Date），不是日期字符串。
 *
 * 台账那边是按 UTC 存的，但"今天"是按人理解的：直接拿 UTC 的天当今天，
 * 每日额度会在北京时间早上八点归零。所以这一步必须过时区。
 */
export function startOfDay(ts, timezone = DEFAULT_TIMEZONE) {
  const wall = wallClock(ts, timezone)
  return new Date(utcFromWall({ ...wall, hour: 0, minute: 0 }, timezone))
}

/**
 * 下一个当地零点。用"当天 + 1 天"的**日历加法**，不是 +24 小时 ——
 * 夏令时那天当地的一天是 23 或 25 小时，加 24 会落到当天 23 点或次日 1 点，
 * 于是"几点恢复"那句话会差一小时。
 *
 * `day + 1` 溢出（31 号、12 月）交给 `Date.UTC` 自己进位，那是它的既定行为。
 */
export function nextDayStart(dayStart, timezone = DEFAULT_TIMEZONE) {
  const wall = wallClock(dayStart.getTime(), timezone)
  return new Date(utcFromWall({ ...wall, day: wall.day + 1, hour: 0, minute: 0 }, timezone))
}

/** 与界面上的写法一致：千位分隔，不缩写（980k 和 1.1M 摆在一起看不出差一个量级） */
const fmt = (value) => Number(value || 0).toLocaleString('en-US')

/** 当地时间的 HH:MM，写进"什么时候恢复"那句话里 */
function localTime(date, timezone) {
  const wall = wallClock(date.getTime(), timezone)
  return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`
}

/**
 * @param {object} params
 * @param {object} params.storage  只用它的 `usage`（没有就是这个部署没在记账 → 整块关掉）
 * @param {object} params.users    查这个人在哪个分组。dev 鉴权模式下是 null → 整块关掉
 * @param {object} params.groups   查那个分组配了多少额度
 */
export function createQuotaGuard({ storage = null, users = null, groups = null, timezone = DEFAULT_TIMEZONE, logger = console } = {}) {
  /**
   * 三个依赖缺一不可，缺了就是"这个部署不做额度"：
   * 没台账 = 不知道用了多少，没账号库 = 不知道谁属于哪个组，没分组 = 没地方配。
   * 关掉时**不是拦住所有人**，是放行所有人 —— 与"没建分组"的语义一致。
   */
  const enabled = Boolean(storage?.usage?.totalsForUser && users && groups)

  let zone = DEFAULT_TIMEZONE
  try {
    zone = assertTimezone(timezone || DEFAULT_TIMEZONE)
  } catch {
    // 时区名写错了不该让服务起不来：退回默认的那个，但要吵一声 ——
    // 否则表现是"每天的额度在一个谁也说不清的时刻归零"
    logger.warn?.('QUOTA_TIMEZONE 不是一个合法的时区名，每日额度按默认时区归零', { timezone, fallback: DEFAULT_TIMEZONE })
    zone = DEFAULT_TIMEZONE
  }

  /**
   * 查一次额度，**不抛**。回一个判据对象，`assert()` 才把它翻成错误。
   *
   * 分成两个方法是为了让"要不要拦"这件事**可以被读出来**：将来界面上要画
   * 一条"本月已用 82%"的进度条，用的就是这里回的 used/limit，
   * 不必再写一份口径可能对不上的计算。
   */
  async function check(username, { now = Date.now() } = {}) {
    const idle = { ok: true, limited: false }
    if (!enabled || !username) return idle

    let group = null
    try {
      const user = await users.get(username)
      // 没有分组 = 不限（合法状态，见 group-store 文件头）
      if (!user?.groupId) return idle
      group = await groups.get(user.groupId)
    } catch (error) {
      logger.warn?.('读不到分组，本轮不做额度检查', { username, err: error?.message })
      return idle
    }

    const totalLimit = Number(group?.tokenQuota) || 0
    const dailyLimit = Number(group?.dailyTokenQuota) || 0
    /**
     * 两个额度都没配就**一个查询都不发**。
     *
     * 这是这道闸门在绝大多数部署上的实际代价：零。不这样写的话，
     * 一个从来没配过额度的部署也要为每一次对话多付一次跨用户历史的 SUM。
     */
    if (!totalLimit && !dailyLimit) return idle

    let used
    try {
      used = await storage.usage.totalsForUser({
        username,
        // 没配每日额度就不算当日那一半，省掉条件 SUM
        dayStart: dailyLimit ? startOfDay(now, zone) : null,
      })
    } catch (error) {
      logger.warn?.('读不到用量台账，本轮放行（额度不是安全边界）', { username, err: error?.message })
      return idle
    }

    const shared = { group: group.name, groupId: group.id }
    if (totalLimit && used.total.tokens >= totalLimit) {
      return { ok: false, limited: true, scope: 'total', limit: totalLimit, used: used.total.tokens, ...shared }
    }
    if (dailyLimit && used.today.tokens >= dailyLimit) {
      const resetAt = nextDayStart(startOfDay(now, zone), zone)
      return {
        ok: false, limited: true, scope: 'daily', limit: dailyLimit, used: used.today.tokens, resetAt, ...shared,
      }
    }
    return {
      ok: true,
      limited: false,
      ...shared,
      totalLimit,
      dailyLimit,
      usedTotal: used.total.tokens,
      /**
       * 没配每日额度时这里是 **null，不是 0，也不是那个数**：上面为了省一次条件 SUM
       * 没有传 dayStart，于是台账回的"当日"其实等于累计。原样交出去的话，
       * 将来照着它画"今天已用"的人会得到一个静悄悄的错数。
       */
      usedToday: dailyLimit ? used.today.tokens : null,
    }
  }

  return {
    enabled,
    timezone: zone,
    check,

    /** 超了就抛。run 开始前调它（见 agent/run-service.js） */
    async assert(username, options = {}) {
      const now = options.now ?? Date.now()
      const verdict = await check(username, { ...options, now })
      if (verdict.ok) return verdict

      const scale = `${fmt(verdict.used)} / ${fmt(verdict.limit)} tokens`
      if (verdict.scope === 'total') {
        throw Errors.forbidden(
          `你所在的分组「${verdict.group}」的总额度已用完（${scale}），请联系管理员调整`,
          { scope: 'total', limit: verdict.limit, used: verdict.used, group: verdict.group },
        )
      }
      throw Errors.rateLimited(
        `你所在的分组「${verdict.group}」今天的额度已用完（${scale}），${localTime(verdict.resetAt, zone)} 之后恢复`,
        {
          scope: 'daily',
          limit: verdict.limit,
          used: verdict.used,
          group: verdict.group,
          resetAt: verdict.resetAt.toISOString(),
          // 定时任务据此退避到明天，而不是每分钟再试一次
          retryAfterMs: Math.max(0, verdict.resetAt.getTime() - now),
        },
      )
    },
  }
}
