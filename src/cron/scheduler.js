/**
 * 调度器：到点了就把任务当成一次普通的 run 交给 runService。
 *
 * ── 为什么走 runService 而不是自己拼一遍 ────────────────────────────────
 *
 * 并发预算、每用户配额、活跃 run 登记、指标、票据签发与吊销 —— 这些定时任务
 * 一样都不能少。绕过去自己 new 一个 runTurn，等于把这些规则复制一份，然后
 * 让它慢慢和主路径长歪。runService 的注释里本来就写着"后面还有定时任务"。
 *
 * ── 多副本 ──────────────────────────────────────────────────────────────
 *
 * **可以在多个副本上同时打开。** 抢占由 `crons.claimSlot` 负责，而它落在
 * `map.update()` 上 —— MySQL 驱动下那是一段 `SELECT ... FOR UPDATE` 的事务
 * （见 src/persistence/mysql-map.js 的 mutate）：读、比对、推进 nextFireAt
 * 全在同一个事务里，行锁由数据库持有。于是两个副本同时对同一条任务下手时，
 * 后到的那个会**阻塞到先到的提交**，然后读到已经被推走的 nextFireAt，
 * 比对不上，claimed=false —— 恰好一个副本跑，另一个安静地跳过。
 *
 * ⚠️ 这段历史值得记一笔：这里原本写着"CRON_ENABLED 只应在一个副本上打开"，
 * 因为那时还有一个文件存储驱动，它的读改写只在进程内串行、跨副本没有锁。
 * 那个驱动后来被整个删掉了（见 src/persistence/storage.js 的文件头），
 * 于是限制的前提消失了 —— 但注释和启动告警留了下来，继续要求运维做一件
 * 已经不必要的事。**限制比代码活得久**，所以它值得一条用例钉着
 * （test/cron.test.js 的「多副本抢占」一组）。
 *
 * 仍然成立的边界：`MAX_FIRES_PER_TICK` 是**每副本**的，N 个副本一拍最多点 5N 个。
 * 那是限流的粒度问题，不是正确性问题。
 *
 * ── 失败不退格 ──────────────────────────────────────────────────────────
 *
 * 占坑是"先把下一拍推走，再去执行"。执行失败时**不退回**这一格：退回来的话，
 * 一个永远失败的任务会在每个 tick 上重试一次，把并发预算吃光，日志刷满，
 * 而且用户看到的是同一条报错刷屏。失败记进 fireLog，等下一格正常触发。
 */
import { describeSchedule } from './schedule.js'

/** 一次 tick 最多点几个，避免一堆任务撞在同一分钟把并发预算吃光 */
const MAX_FIRES_PER_TICK = 5

/** 连续失败多少次就自动停用。避免一个坏掉的任务永远地每天报一次错 */
const MAX_CONSECUTIVE_FAILURES = 10

/**
 * 触发时给模型的运行时上下文。
 *
 * 不说清楚"你是被定时唤醒的、这是一条全新会话"，模型会按对话习惯回一句
 * "好的，我这就去办" —— 而根本没有人在等这句话。它必须知道：没有人在对面，
 * 要做的事就是下面这段存下来的指令，做完把结果写下来。
 */
function renderFireInput(cron) {
  return [
    '[定时任务运行时上下文]',
    `任务：${cron.title || cron.id}（id: ${cron.id}，${describeSchedule(cron.schedule)}）`,
    '你是被定时器唤醒的，**没有人在对面等着回话**，也没有上一次触发的记忆。',
    cron.sessionMode === 'shared'
      ? '本任务的历次触发共用同一条会话，所以你能看到上几次的对话记录。'
      : '每次触发都是一条全新会话。需要跨次留存的东西（进度、清单、检查点）请写进工作区文件。',
    '直接执行下面的指令并给出结果；不要反问、不要等待确认。',
    '[上下文结束]',
    '',
    '任务指令：',
    cron.task,
  ].join('\n')
}

/**
 * 本次触发用哪个会话。
 *
 * 必须落在 http 层的 SESSION_KEY_RE（字母数字下划线连字符）里，否则界面点开会 400。
 */
function sessionKeyFor(cron, scheduledAt) {
  if (cron.sessionMode === 'shared') return `cron_${cron.id}`
  return `cron_${cron.id}_${Number(scheduledAt || Date.now()).toString(36)}`
}

export function createScheduler({ config, logger, crons, vault, runService, sessionStore = null }) {
  const settings = config.cron || {}
  const enabled = settings.enabled !== false && settings.scheduler !== false
  const tickMs = settings.tickMs || 30000

  /** 同一时刻只允许一个 tick 在跑：上一轮还没结束就再来一轮，会重复点同一批任务 */
  let ticking = false
  let timer = null

  async function fire(cron, { scheduledAt, manual = false }) {
    const at = Date.now()
    const sessionKey = sessionKeyFor(cron, scheduledAt)
    const fireLogger = logger.child ? logger.child({ cronId: cron.id, username: cron.username }) : logger

    const credential = await vault.resolve({ username: cron.username }).catch(() => '')
    /**
     * 没有凭据不算"失败"，算"缺前提"。
     *
     * 区分开是有意义的：失败要看日志查原因，缺前提是一句用户（或运维）自己就能
     * 解决的话。混成一类，用户只会看到一条"执行失败"然后来问我们。
     *
     * 只在**真的需要**用户凭据时才拦：LLM_MODE=faux/direct 用的是服务端自己的
     * 模型访问权，定时任务不需要谁的登录态也能跑。
     */
    const requiresCredential = config.llm?.mode === 'platform'
    if (!credential && requiresCredential) {
      await crons.recordFire({
        username: cron.username,
        id: cron.id,
        entry: {
          firedAt: at, scheduledAt, status: 'needs_reauth',
          note: vault.mode === 'stored'
            ? '登录态已失效：在网页上重新登录一次，并重新保存这条定时任务即可恢复'
            : '服务端未开启定时任务凭据留存（CRON_CREDENTIAL_MODE=stored），无人值守时拿不到登录态',
        },
      })
      return { ok: false, status: 'needs_reauth' }
    }

    const subject = {
      username: cron.username,
      credential,
      // 触发不是用户请求；username 来自任务记录，而任务记录
      // 是当初经过身份校验的人自己建的（隔离契约 #4 仍然成立）
      verified: true,
      source: 'cron',
    }

    try {
      const result = await runService.execute({
        subject,
        sessionKey,
        prompt: renderFireInput(cron),
        source: 'cron',
      })
      // 定时任务产生的会话默认归到任务所属项目下，界面上就能跟人工对话分开看
      if (cron.projectId && sessionStore?.patch) {
        await sessionStore.patch({ username: cron.username, sessionKey, projectId: cron.projectId }).catch(() => {})
      }
      await crons.recordFire({
        username: cron.username,
        id: cron.id,
        entry: {
          firedAt: at, scheduledAt, status: 'ok', manual: manual || undefined,
          sessionKey, runId: result.runId, durationMs: result.durationMs, reply: result.finalText,
        },
      })
      fireLogger.info?.('定时任务已执行', { sessionKey, durationMs: result.durationMs })
      return { ok: true }
    } catch (error) {
      await crons.recordFire({
        username: cron.username,
        id: cron.id,
        entry: {
          firedAt: at, scheduledAt, status: 'error', manual: manual || undefined,
          sessionKey, note: `${error.code || 'ERROR'}: ${error.message || error}`,
        },
      })
      fireLogger.warn?.('定时任务执行失败', { code: error.code, message: error.message })
      return { ok: false, status: 'error' }
    }
  }

  /** 连续失败太多就自动停用，并在 fireLog 里留下停用原因 */
  async function disableIfHopeless(cron) {
    const record = await crons.get({ username: cron.username, id: cron.id })
    const log = record?.fireLog || []
    const tail = log.slice(-MAX_CONSECUTIVE_FAILURES)
    if (tail.length < MAX_CONSECUTIVE_FAILURES) return
    if (tail.some((entry) => entry.status === 'ok')) return
    await crons.update({ username: cron.username, id: cron.id, enabled: false })
    await crons.recordFire({
      username: cron.username,
      id: cron.id,
      entry: {
        firedAt: Date.now(), status: 'disabled',
        note: `连续 ${MAX_CONSECUTIVE_FAILURES} 次未成功，已自动停用。修好后在界面上重新启用即可`,
      },
    })
    logger.warn?.('定时任务连续失败已自动停用', { cronId: cron.id, username: cron.username })
  }

  async function tick(now = Date.now()) {
    if (ticking) return { skipped: true }
    ticking = true
    let fired = 0
    try {
      const due = await crons.due(now)
      for (const cron of due.slice(0, MAX_FIRES_PER_TICK)) {
        const claimed = await crons.claimSlot({ username: cron.username, id: cron.id, scheduledAt: cron.scheduledAt, at: now })
        if (!claimed) continue
        fired += 1
        const outcome = await fire(cron, { scheduledAt: cron.scheduledAt })
        if (!outcome.ok) await disableIfHopeless(cron).catch(() => {})
      }
      if (due.length > MAX_FIRES_PER_TICK) {
        // 剩下的下一拍再点。它们的 nextFireAt 没被推走，所以不会丢
        logger.warn?.('本轮到期任务过多，已限流', { due: due.length, fired })
      }
    } catch (error) {
      logger.error?.('定时任务调度失败', { err: error?.message })
    } finally {
      ticking = false
    }
    return { fired }
  }

  return {
    enabled,
    tickMs,

    tick,

    /** 界面上的「立即执行一次」。不占排期格，也不影响 nextFireAt */
    async runNow({ username, id }) {
      const cron = await crons.get({ username, id })
      if (!cron) throw new Error('定时任务不存在')
      return fire({ ...cron, username }, { scheduledAt: undefined, manual: true })
    },

    start() {
      if (!enabled || timer) return false
      timer = setInterval(() => { void tick() }, tickMs)
      // 调度器不该拖着进程不让退出：优雅停机时它自己就该停
      timer.unref?.()
      // 键名刻意不叫 credentialMode：logger 会把带 credential 的键整个脱敏成
      // 指纹，于是日志里显示的是 fp_xxx 而不是 none/stored —— 一个纯粹的运维困惑
      logger.info?.('定时任务调度已启动', { tickMs, 凭据模式: vault.mode })
      return true
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
