/**
 * 租约 = 一个用户在这个副本上的一段独占时间 + 一份工作区。
 *
 * 为什么要租约而不是"一次 exec 一次请求"：技能的第二条命令常常要读第一条写的文件，
 * 而经 Service 轮询的第二次请求可能落到别的副本。详见 PROTOCOL.md。
 *
 * 一个租约背后绑定一个 slot（见 [namespace/slot-pool.js](namespace/slot-pool.js)）——
 * 工作区不是"给这个租约现挖一个目录"，而是"认领一个已经建好 namespace 的 slot，
 * 把它已经准备好的工作区目录报出来"；释放时也不是 rm -rf，而是把整个 slot 销毁重建
 * （见 slot-pool.js 顶部注释：这是"用完不留痕迹"的保证来源）。
 *
 * `lease.workspace` 的顶层字段（rootDir/baseDir/homeDir/tmpDir）永远是
 * **host 视角的真实路径**——server.js 的文件上下行接口跑在 worker 自己的进程里
 * （没有进任何 slot 的 namespace），只能也只该操作这些路径。
 * `lease.workspace.guest` 是**job 视角**看到的路径：slot 私有 mount namespace
 * 里的固定挂载点，执行命令（[executor.js](executor.js)）用这一份。
 *
 * ── 租约的三种结局 ──────────────────────────────────────────────────
 *
 * 从前只有一种：`release`，slot 销毁重建。对一次性脚本没问题，对**需要连续
 * 操作**的任务不成立 —— 浏览器登录态、已装的依赖、后台进程全在 slot 里，
 * 释放就等于下一轮从头再来（见 docs/SANDBOX-LIFECYCLE.md）。
 *
 *   release —— 立即释放。默认。
 *   park    —— 驻留：中止前台 exec，但**不动 slot、不关浏览器**，换一个更短的
 *              窗口挂起，等下一轮 attach 回来。
 *   attach  —— 接管一个驻留中的租约，轮换凭据，窗口回到正常的 idle。
 *
 * 驻留是"占着 slot 不干活"，所以它必须同时满足三条，缺一条都不该开：
 *   1. 窗口比 idle 短（config 里校验）；
 *   2. 池子满时**可被抢占**（见 `acquire` 里的 oldestParked 分支）；
 *   3. 每个 username 有驻留上限（见 `park`）。
 * 硬顶 `hardExpiresAt` 对驻留一视同仁 —— park 和 attach 都推不过去。
 */
import { randomBytes } from 'node:crypto'

export function createLeaseManager({ config, logger, slotPool }) {
  const leases = new Map() // leaseId -> lease
  let sweeper = null

  function slotsUsed() {
    return leases.size
  }

  /**
   * 把到期时刻往后推。两条约束缺一不可：
   *
   *   1. **绝不越过硬顶**（createdAt + maxLifetimeMs）。没有这条，"活跃即续"
   *      就等于"只要一直发请求就能永久占住一个 slot"。
   *   2. **绝不把已经更晚的到期时刻往前挪**。调用方显式续到了 +30 分钟之后，
   *      紧接着一个普通请求不该把它缩回 +10 分钟的滑动窗口 —— 那会让
   *      "续期"变成一个用了还不如不用的接口。
   */
  function extend(lease, windowMs, now = Date.now()) {
    const wanted = Math.min(now + windowMs, lease.hardExpiresAt)
    if (wanted > lease.expiresAt) lease.expiresAt = wanted
    return lease.expiresAt
  }

  /** 回给调用方的租约视图。**不含 leaseToken** —— 它是执行权限本身，只在创建时回一次。 */
  function describe(lease, now = Date.now()) {
    return {
      leaseId: lease.leaseId,
      runId: lease.runId,
      username: lease.username,
      createdAt: lease.createdAt,
      expiresAt: lease.expiresAt,
      hardExpiresAt: lease.hardExpiresAt,
      remainingMs: Math.max(0, lease.expiresAt - now),
      /** 续期最多还能买到多少 —— 调用方据此决定是接着干还是趁早把产物取走 */
      maxRemainingMs: Math.max(0, lease.hardExpiresAt - now),
      execCount: lease.execCount,
      running: lease.running.size,
      // 只回域名与端口，不回解析出来的 IP —— 调用方要的是"我申请的开了没有"
      egress: (lease.egress || []).map((e) => `${e.host}:${e.ports.join('/')}`),
      /**
       * 浏览器上下文还在不在。attach 之后调用方**必须**据此告诉模型
       * "登录态还在，不用重新登录" —— 不说的话它会照着"全新沙盒"的默认假设
       * 再登一遍，驻留付出的代价就白花了。
       */
      browser: Boolean(lease.browser),
      parked: Boolean(lease.parked),
      parkedAt: lease.parkedAt || 0,
    }
  }

  /**
   * 运维视角的占用详情：**谁**占着这个槽位、占了多久、正在跑什么、吃了多少资源。
   *
   * ── 为什么这里没有命令原文 ──────────────────────────────────────
   *
   * 命令文本和输出是**用户数据**。整个 worker 的日志都遵守这条（只记形状与长度），
   * 管理台的转发层也写着同一句（`sandbox_call.lua`："只记形状，不记命令文本和输出"）。
   * 管控台的管理员不是这个租约的用户 —— 让他们读到别人正在跑的命令，和让日志
   * 系统读到是同一件事，只是受众换了一批人。
   *
   * 所以这里给的是**身份 + 形状**：
   *   - 身份：`username` 是谁，`runId` 是哪一次 agent run。runId 才是真正的连接点 ——
   *     "这个人在干什么"的答案在 agent 那边（会话本来就按 username 隔离），
   *     不该在沙盒这层重新暴露一遍。
   *   - 形状：跑了多久、几条命令、产出多少字节、CPU/内存/进程数。
   *
   * 而"该不该杀"恰恰只需要形状：跑了 8 分钟的 `npm install` 和跑 8 分钟的死循环，
   * 命令原文帮不上忙，这几个数字才分得开。
   */
  async function inspect(now = Date.now()) {
    const out = []
    for (const lease of leases.values()) {
      // 资源读失败不能让整张表打不开 —— 一个 slot 的 cgroup 有问题时，
      // 运维**更**需要看到其它占用，而不是看到一个 500。
      let resources = null
      try {
        resources = (await lease.slot?.cgroup?.stats?.()) || null
      } catch (error) {
        logger.warn('读取 slot 资源用量失败', { slotIndex: lease.slot?.index, err: error?.message })
      }
      out.push({
        slotIndex: lease.slot?.index ?? null,
        leaseId: lease.leaseId,
        username: lease.username,
        runId: lease.runId,
        createdAt: lease.createdAt,
        ageMs: Math.max(0, now - lease.createdAt),
        lastUsedAt: lease.lastUsedAt,
        // 多久没有新请求了。判断"agent 是不是已经不在了"最直接的一个数字。
        idleMs: Math.max(0, now - lease.lastUsedAt),
        expiresAt: lease.expiresAt,
        remainingMs: Math.max(0, lease.expiresAt - now),
        hardExpiresAt: lease.hardExpiresAt,
        execCount: lease.execCount,
        running: lease.running.size,
        browser: Boolean(lease.browser),
        /**
         * 驻留中的占用要和"正在跑"分得开。运维看到一个 8 分钟没动静的 slot，
         * "它在等用户回来"和"agent 已经不在了"是两个完全不同的处置。
         */
        parked: Boolean(lease.parked),
        parkedAt: lease.parkedAt || 0,
        egress: (lease.egress || []).map((e) => `${e.host}:${e.ports.join('/')}`),
        // 只回**还在跑**的那些：已结束的任务对"要不要杀这个占用"没有参考价值，
        // 而且 EXEC_RETAIN_JOBS 会让列表里混进一堆几分钟前就结束的东西。
        execs: [...(lease.execs?.values() || [])]
          .filter((job) => job.status === 'running')
          .map((job) => ({
            execId: job.execId,
            startedAt: job.startedAt,
            durationMs: Math.max(0, now - job.startedAt),
            outputBytes: job.outputBytes,
          })),
        resources,
      })
    }
    out.sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0))
    return out
  }

  function workspaceFromSlot(slot) {
    return {
      rootDir: slot.hostWorkspace.workDir,
      baseDir: slot.hostWorkspace.baseDir,
      homeDir: slot.hostWorkspace.homeDir,
      tmpDir: slot.hostWorkspace.tmpDir,
      guest: { rootDir: slot.guest.workDir, homeDir: slot.guest.homeDir, tmpDir: slot.guest.tmpDir },
    }
  }

  /** 释放：先杀进程，再回收 slot，最后放开槽位。顺序不能换。 */
  async function releaseLease(leaseId, { reason = 'client' } = {}) {
    const lease = leases.get(leaseId)
    if (!lease) return false
    leases.delete(leaseId)
    lease.released = true

    for (const controller of lease.running) {
      try {
        controller.abort()
      } catch {
        // 已经结束了
      }
    }
    // 浏览器上下文里有该用户的 cookie 与页面状态，必须跟着租约一起消失
    if (lease.browser) {
      await lease.browser.close().catch((error) => {
        logger.error('浏览器上下文关闭失败，该用户的登录态可能还留在内存里', {
          leaseId, username: lease.username, err: error?.message,
        })
      })
      lease.browser = null
    }
    // 给 SIGTERM→SIGKILL 一点时间落地，再回收 slot
    if (lease.running.size) await new Promise((resolve) => setTimeout(resolve, config.exec.killGraceMs + 200))

    // slotPool.release 会杀掉 sentinel（内核连带回收 namespace 内的一切）、
    // 删掉工作区、再建一套全新的——这是"零残留"的保证来源，不是 rm -rf 能替代的
    await slotPool.release(lease.slot.index).catch((error) => {
      logger.error('slot 回收失败——这个 slot 可能已经不安全复用，需要人工介入', {
        leaseId, username: lease.username, slotIndex: lease.slot.index, err: error?.message,
      })
    })

    logger.info('租约已释放', {
      leaseId, runId: lease.runId, username: lease.username, reason,
      // 驻留过的租约要能一眼看出来：它的 livedMs 里有一段是没人在用的，
      // 拿去算"平均占用时长"会把这个指标带偏。
      parked: Boolean(lease.parked),
      execCount: lease.execCount, livedMs: Date.now() - lease.createdAt, slots: slotsUsed(),
    })
    return true
  }

  /**
   * 可以被抢占的驻留租约里最老的那个（没有就是 null）。
   *
   * `parkGraceMs` 是保护窗：刚驻留下来就被抢走，用户的体感是"我按了发送，
   * 上一轮的登录态就没了"——那比压根不做驻留更难解释。宁可让这一次申请
   * 拿 429 去试别的节点。
   */
  function oldestParked(now = Date.now()) {
    let victim = null
    for (const lease of leases.values()) {
      if (!lease.parked) continue
      if (now - lease.parkedAt < config.lease.parkGraceMs) continue
      if (!victim || lease.parkedAt < victim.parkedAt) victim = lease
    }
    return victim
  }

  /** 某个 username 当前驻留着的租约，最老的排前面 */
  function parkedOf(username) {
    return [...leases.values()]
      .filter((lease) => lease.parked && lease.username === username)
      .sort((a, b) => a.parkedAt - b.parkedAt)
  }

  return {
    slots: () => ({ used: slotsUsed(), total: config.slots }),

    /**
     * @param {object} [params.logger] 请求上下文的 logger（带 requestId/traceId）。
     *   不传就用建管理器时那份 —— 但那样这条日志就少了链路标识，
     *   "这次租约属于哪一次请求"只能靠 runId 反推。
     * @returns {lease|null} null 表示槽位已满
     */
    async acquire({ runId = '', username = '', ttlMs, logger: reqLogger = logger }) {
      const leaseId = `lease_${randomBytes(12).toString('hex')}`
      let slot = slotPool.acquire(leaseId)
      if (!slot) {
        /**
         * 池子满了 —— 先看有没有驻留租约可以顶掉。
         *
         * **这一段是驻留能上生产的前提。** 驻留的本质是"占着 slot 不干活"，
         * 没有抢占的话，一个在等用户回来的 slot 会让真正要干活的人排队；
         * 有了抢占，驻留在压力大时自动让路，对容量就是零伤害。
         */
        const victim = oldestParked()
        if (victim) {
          reqLogger.info('槽位已满，抢占最老的驻留租约', {
            victim: victim.leaseId,
            victimUser: victim.username,
            parkedMs: Date.now() - victim.parkedAt,
            forUser: username,
            forRun: runId,
          })
          await releaseLease(victim.leaseId, { reason: 'preempted' })
          slot = slotPool.acquire(leaseId)
        }
      }
      if (!slot) return null // 全部 slot 都占用中，且没有可抢占的驻留租约

      const now = Date.now()
      const hardExpiresAt = now + config.lease.maxLifetimeMs
      const requested = Number(ttlMs)
      const initialWindow = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, config.lease.ttlMs)
        : config.lease.ttlMs
      const lease = {
        leaseId,
        /**
         * 这个租约自己的凭据，只在创建响应里回一次，之后的 exec/文件/浏览器
         * 都用它鉴权。
         *
         * 为什么不能继续用 leaseId 当凭据：它出现在 URL 路径里
         * （`/v1/leases/<id>/exec`），会被反向代理、网关、access log 一路记下来。
         * 凭据不该走那条路。
         *
         * 为什么不能继续只用全局 SANDBOX_TOKEN：那样任何持有它的调用方都能操作
         * **别人的**租约（leaseId 并不难从日志里捡到）。改成一租约一凭据之后，
         * 调用方只能碰自己那一个 —— 这一条即使不接管理端也是净收益。
         */
        leaseToken: randomBytes(24).toString('hex'),
        runId,
        username,
        workspace: workspaceFromSlot(slot),
        slot,
        createdAt: now,
        lastUsedAt: now,
        /** 到期时刻。**会随活动往后滑**（见 extend），不是从创建算死的绝对墙。 */
        expiresAt: Math.min(now + initialWindow, hardExpiresAt),
        /** 硬顶。续期推不过去，滑动也滑不过去。 */
        hardExpiresAt,
        running: new Set(), // 正在跑的 AbortController
        execCount: 0,
        browser: null, // 懒创建的 BrowserSession；释放时一起关掉（驻留时**不**关）
        /** 本租约额外开的出站目标（若有）。释放时随 slot 销毁重建一起消失。 */
        egress: [],
        released: false,
        /** 驻留中 = 没有任何 run 在用它，但 slot 留着等下一轮 attach。见 `park` */
        parked: false,
        parkedAt: 0,
      }
      leases.set(leaseId, lease)
      reqLogger.info('租约已建立', { leaseId, runId, username, slots: slotsUsed(), total: config.slots, slotIndex: slot.index })
      return lease
    },

    /**
     * 取租约。**同时算一次活动**：到期时刻往后滑一个 idle 窗口。
     *
     * server.js 里每一个带凭据的租约内请求都会先走这里，所以"还在用的租约不会
     * 到期"这条性质是由这一行保证的，不需要调用方额外做什么。
     */
    get(leaseId) {
      const lease = leases.get(leaseId)
      if (!lease) return null
      const now = Date.now()
      if (lease.expiresAt <= now) return null
      lease.lastUsedAt = now
      /**
       * 驻留中的租约只滑驻留窗口，**不能滑到 idle 窗口去**。
       *
       * 正常情况下驻留期间只会收到 attach 和 DELETE 两种请求，但"正常情况"
       * 不该是安全性质的依据：一个崩掉的 agent 留下的重试、一条走岔了的
       * 保活请求，都会经过这里。按 idle 续，一个没人用的 slot 就能靠零星
       * 噪声一直续下去 —— 驻留窗口比 idle 短这条保证当场作废。
       */
      extend(lease, lease.parked ? config.lease.parkTtlMs : config.lease.idleTimeoutMs, now)
      return lease
    },

    describe,
    inspect,

    /**
     * 显式续期。用于调用方**明知**接下来要长时间不发请求（比如模型正在长思考、
     * 或者本地在跑一段不经沙盒的逻辑）时，先把租约的命续上。
     *
     * 单次最多买 `ttlMs`，且一样推不过硬顶。已经更晚的到期时刻不会被缩短。
     */
    renew(lease, { extendMs } = {}) {
      const requested = Number(extendMs)
      // 驻留中的租约照样封在驻留窗口里：显式续期是"我接下来要长时间不发请求"
      // 的意思，而驻留是"我这一轮已经结束了"。后者不该能买到前者的额度。
      const cap = lease.parked ? config.lease.parkTtlMs : config.lease.ttlMs
      const window = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, cap)
        : cap
      const now = Date.now()
      extend(lease, window, now)
      lease.lastUsedAt = now
      return describe(lease, now)
    },

    release: (leaseId, options = {}) => releaseLease(leaseId, options),

    /**
     * 驻留：这一轮结束了，但**不要销毁 slot**，等下一轮 attach 回来。
     *
     * 与 release 的差别只有一句话：不碰 slot，也就不关浏览器、不杀后台进程、
     * 不删已装的依赖。前台 exec 照样中止 —— 一轮结束了，不该有命令继续往一个
     * 没人在看的流里写（这一条和 release 保持一致，不是新语义）。
     *
     * @returns {{parked: boolean, reason?: string}} 拒绝时 parked=false，
     *   调用方**必须**退回 release —— 宁可丢连续性，不能泄漏槽位。
     */
    async park(lease, { reason = 'turn-end', logger: reqLogger = logger } = {}) {
      if (config.lease.maxParkedPerUser <= 0) return { parked: false, reason: 'park-disabled' }

      const now = Date.now()
      // 硬顶已经近在眼前时驻留没有意义：下一轮 attach 回来也活不了多久，
      // 还白占一个 slot。剩不到一个保护窗就直接让调用方释放。
      if (lease.hardExpiresAt - now <= config.lease.parkGraceMs) {
        return { parked: false, reason: 'max-lifetime-near' }
      }

      // 配额：顶掉这个 username **自己**最老的那些。顶自己的不顶别人的 ——
      // 一个人的连续会话不该以别人的槽位为代价。
      const mine = parkedOf(lease.username).filter((item) => item.leaseId !== lease.leaseId)
      const overflow = mine.length - (config.lease.maxParkedPerUser - 1)
      for (let i = 0; i < overflow; i += 1) {
        reqLogger.info('驻留数超过每用户上限，顶掉自己最老的一个', {
          leaseId: mine[i].leaseId, username: lease.username, limit: config.lease.maxParkedPerUser,
        })
        await releaseLease(mine[i].leaseId, { reason: 'park-quota' })
      }

      for (const controller of lease.running) {
        try {
          controller.abort()
        } catch {
          // 已经结束了
        }
      }

      lease.parked = true
      lease.parkedAt = now
      lease.lastUsedAt = now
      // 到期时刻**改用驻留窗口**，而且是往前挪：驻留比在用短，不能让上一轮
      // 活动滑出来的那个更晚的 expiresAt 继续生效（extend 只会往后推，
      // 这里必须直接赋值）。硬顶照旧管着。
      lease.expiresAt = Math.min(now + config.lease.parkTtlMs, lease.hardExpiresAt)

      reqLogger.info('租约已驻留', {
        leaseId: lease.leaseId,
        runId: lease.runId,
        username: lease.username,
        reason,
        browser: Boolean(lease.browser),
        // 下一轮要在这个时刻之前回来，否则被清扫掉
        expiresAt: lease.expiresAt,
        maxRemainingMs: Math.max(0, lease.hardExpiresAt - now),
      })
      return { parked: true, expiresAt: lease.expiresAt }
    },

    /**
     * 接管一个驻留中的租约。
     *
     * **凭据要轮换。** 粘性句柄在调用方那儿躺了十几分钟等下一轮，旧 token 的
     * 泄漏窗口比一个普通租约长得多；attach 是唯一一个能顺手把它换掉的时刻，
     * 代价是零。
     */
    attach(lease, { runId = '', logger: reqLogger = logger } = {}) {
      const now = Date.now()
      const wasParked = Boolean(lease.parked)
      const parkedAt = lease.parkedAt || now
      lease.parked = false
      lease.parkedAt = 0
      // runId 换成新一轮的：它是 trace 的连接点，留着上一轮的会让
      // "这条出网请求是谁发的"指向一次已经结束的 run。
      if (runId) lease.runId = runId
      lease.lastUsedAt = now
      lease.leaseToken = randomBytes(24).toString('hex')
      extend(lease, config.lease.idleTimeoutMs, now)

      reqLogger.info('租约已接管', {
        leaseId: lease.leaseId, runId: lease.runId, username: lease.username,
        wasParked, browser: Boolean(lease.browser),
        // 驻留了多久才被接回去。park 命中率之外，这个数字是调 LEASE_PARK_TTL_MS
        // 的唯一依据：绝大多数 attach 都在两分钟内，那 10 分钟的窗口就是浪费。
        parkedMs: wasParked ? Math.max(0, now - parkedAt) : 0,
      })
      return { ...describe(lease, now), leaseToken: lease.leaseToken }
    },

    /**
     * 回收到期的租约。agent service 崩了也不会把槽位永久占住。
     *
     * **正在跑的命令算活动。** 否则一条 12 分钟的 `npm install` 会在第 10 分钟
     * 被 idle 判定杀掉 —— 而那恰恰是最不该判定为"没人了"的时刻：exec 是一个
     * 长连接请求，从发出到结束期间 get() 一次都不会再被调用。
     *
     * 这条只受硬顶约束：真跑了 4 小时还没完的东西，该停。
     */
    async sweep(now = Date.now()) {
      const dead = []
      for (const lease of leases.values()) {
        // 驻留中的租约不吃这条豁免：它身上不该有还在跑的命令（park 已经全部中止），
        // 万一有，那也是残留而不是"有人在用"，不能靠它把驻留窗口一直续下去。
        if (lease.running.size && !lease.parked) extend(lease, config.lease.idleTimeoutMs, now)
        if (now < lease.expiresAt) continue
        // 三种到期说的是三件完全不同的事，日志里必须能分开：
        // 撞硬顶（该停了）、没人理了（agent 可能崩了）、驻留超时（用户没回来）。
        // 混在一起就调不动 TTL —— 分不清 parked-idle 的比例，改窗口是在瞎猜。
        const reason = lease.expiresAt >= lease.hardExpiresAt
          ? 'max-lifetime'
          : lease.parked ? 'parked-idle' : 'idle'
        dead.push([lease.leaseId, reason])
      }
      for (const [leaseId, reason] of dead) {
        // 驻留到期是**预期内**的结局（用户没在窗口内回来），不是事故，
        // 用 info；另外两种仍然是 warn。
        const line = { leaseId, reason }
        if (reason === 'parked-idle') logger.info('驻留租约到期，已回收', line)
        else logger.warn('回收未主动释放的租约', line)
        await releaseLease(leaseId, { reason })
      }
      return dead.length
    },

    startSweeper() {
      if (sweeper) return
      sweeper = setInterval(() => {
        this.sweep().catch((error) => logger.error('租约清扫失败', { err: error?.message }))
      }, config.lease.sweepIntervalMs)
      sweeper.unref?.()
    },

    stopSweeper() {
      if (sweeper) clearInterval(sweeper)
      sweeper = null
    },

    /** 停机用：把所有租约释放掉，别把用户数据留在磁盘上 */
    async releaseAll(reason = 'shutdown') {
      const ids = [...leases.keys()]
      for (const leaseId of ids) await releaseLease(leaseId, { reason })
      return ids.length
    },

    count: () => leases.size,

    /**
     * 按 username 统计当前租约数，随心跳上报给管理端做配额。
     *
     * **真相只在节点手里** —— 管理端签出去的票据不一定被换成租约，
     * 租约什么时候释放它也不知道。所以配额的依据必须由节点报上来。
     *
     * **驻留中的租约照常计入。** 它确实占着一个 slot，不算进去等于在配额上
     * 开了个口子 —— 一个人可以一边驻留一边申请，占满整个池子还不超配额。
     */
    countByUser() {
      const byUser = {}
      for (const lease of leases.values()) {
        const key = lease.username || ''
        if (!key) continue
        byUser[key] = (byUser[key] || 0) + 1
      }
      return byUser
    },

    /** 驻留中的租约数，随心跳上报 —— park 命中率之外，容量侧就看这一个数 */
    parkedCount() {
      let count = 0
      for (const lease of leases.values()) if (lease.parked) count += 1
      return count
    },
  }
}
