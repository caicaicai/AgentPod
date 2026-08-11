/**
 * 向 sandbox-manager 自注册并周期心跳。
 *
 * 一条贯穿全文件的原则：**管理端不可达绝不能影响本节点的服务能力。**
 * 注册失败、心跳失败、manager 整个挂掉——已经建立的租约照常执行，新的租约
 * 只要调用方拿得到有效票据也照常受理。这里的所有错误都只记日志、下次重试，
 * 没有任何一条路径会让 worker 退出或拒绝服务。
 *
 * 反过来说：节点从注册表里消失只意味着"不再被调度到"，不意味着"不能用"。
 * 协议见 sandbox-manager/docs/PROTOCOL.md §2。
 */

/** 注册失败的退避序列。到顶之后按最后一档一直重试，不放弃——manager 可能只是在发版。 */
const REGISTER_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]

async function postJson({ url, code, body, timeoutMs = 5000 }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-SecurityCode': code },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text().catch(() => '')
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* 不是 JSON 就留 null */ }
  return { status: res.status, ok: res.ok, body: parsed, text }
}

export function createManagerClient({ config, logger, leaseManager, slotPool, browserManager, egressPolicy }) {
  const { manager } = config
  let heartbeatTimer = null
  let registerTimer = null
  let stopped = false
  let registered = false
  // manager 在注册/心跳响应里告诉我们该多久心跳一次，不硬编码——
  // 判活的 TTL 在它那边，间隔也该由它说了算，否则两边配置漂移会导致节点
  // 被误判成死的（心跳比 TTL 还慢）。
  let intervalMs = manager.heartbeatIntervalMs
  // 管理端下发的对象存储主机名。节点据此自动放行 slot 出站 ——
  // **有意不让运维在管理端和每个节点各配一遍**：配置漂移的现象是
  // "产物上传莫名其妙连不上"，而两边的配置看起来都对。
  let artifactHost = ''

  /**
   * 把对象存储加进所有 slot 的出站白名单。
   *
   * 幂等：主机名没变就什么也不做。变了（或第一次拿到）就重新挂一遍 ——
   * iptables 规则重复挂一条是无害的，漏挂则是"产物上传连不上"。
   */
  async function applyArtifactHost(host) {
    const next = String(host || '').trim()
    if (!next || next === artifactHost) return
    if (typeof slotPool.allowEgressAll !== 'function') return
    try {
      await slotPool.allowEgressAll([{ host: next, ports: [443] }])
      artifactHost = next
      logger.info('已按管理端下发放行对象存储，沙盒可直传产物', { host: next })
    } catch (error) {
      // 放行失败不能影响节点服务能力：产物上传是可选功能，
      // 而这台机器上正在跑的租约不该因此受影响。
      logger.error('放行对象存储失败，产物直传将不可用', { host: next, err: error?.message })
    }
  }

  /**
   * 收下管理端下发的出站策略并落到各 slot 上。
   *
   * 与 artifactHost 同一条原则：**下发失败绝不能影响本节点的服务能力**。
   * 但它比 artifactHost 严重得多 —— artifactHost 挂不上只是产物传不了，
   * 这里挂不上意味着这台机器的隔离强度和集群里其他机器不一样，
   * 所以失败要 error 且要能从心跳上报里看出来（pendingSlots）。
   */
  async function applyEgressPolicy(incoming) {
    if (!egressPolicy) return
    const { changed, policy, reason } = egressPolicy.update(incoming)
    if (!changed) return
    if (typeof slotPool.applyPolicy !== 'function') return
    try {
      const result = await slotPool.applyPolicy()
      const detail = { reason, mode: policy.enforce ? 'allowlist' : 'open', revision: policy.revision, ...result }
      // 从"拦"切到"不拦"是一件必须留痕的事，不管它是不是运维本人操作的。
      if (policy.enforce) logger.info('已按管理端下发更新沙盒出站策略', detail)
      else logger.error('管理端下发关闭出站拦截：沙盒可访问本机能访问的任意网络目标，用户登录态可被带出', detail)
      if (result.pending) {
        logger.warn('部分 slot 正在被租用，新的出站策略要等它们释放后才生效', {
          pending: result.pending, revision: policy.revision,
        })
      }
    } catch (error) {
      logger.error('出站策略下发后重编排失败，本节点仍在用旧策略', { err: error?.message })
    }
  }

  function capabilities() {
    const status = slotPool.status()
    return {
      browser: Boolean(config.browser.enabled),
      cgroup: status.cgroupVersion || 'none',
      python: Boolean(config.runtime.pythonBin),
    }
  }

  function loadSnapshot() {
    const slots = leaseManager.slots()
    return {
      nodeId: manager.nodeId,
      slots,
      leases: leaseManager.count(),
      // 按人计数，给管理端做"单 username 最大并发租约"。真相在节点手里：
      // 管理端签出去的票据不一定被换成租约，租约何时释放它也不知道。
      leaseUsers: leaseManager.countByUser(),
      /**
       * 其中有多少是**驻留**（在等用户回来，没人在跑）。
       *
       * `leases` 里已经含着它们了 —— 驻留照常占 slot，也照常计入配额。
       * 单列一个数是因为调度侧看到的"满了"有两种成因：真的都在跑（要扩容），
       * 还是一半在等人回来（要调 LEASE_PARK_TTL_MS）。这两者的处置完全相反。
       */
      parkedLeases: leaseManager.parkedCount?.() || 0,
      healthy: true,
      // draining 由停机流程置位：收到 SIGTERM 之后先摘流量，再等在途请求跑完
      draining: stopped,
      browser: browserManager?.status?.() || undefined,
      caps: capabilities(),
      version: manager.version,
      // 指纹（sha256 前 8 位，不可逆）随心跳上报，管理台就能把整个集群的密钥
      // 配置横向比一遍。不上报的话，"调度成功但所有租约申请 401"只能靠人肉
      // 去每台机器 grep 启动日志。**密钥本身永远不出网。**
      ticketSecretFp: manager.ticketSecretFingerprint,
      // 出站策略在本节点的**实际**生效情况。管理端据此判断"我改的策略铺开了吗"——
      // 没有这个回报，下发就是单向的：改完只能去每台机器上翻日志确认。
      // 只报模式/版本/还差几个 slot，不报放行的主机名。
      egress: slotPool.egressState?.() || undefined,
    }
  }

  async function register() {
    const payload = {
      nodeId: manager.nodeId,
      base: config.advertiseBase,
      pool: manager.pool,
      capacity: { slots: config.slots },
      labels: manager.labels,
      caps: capabilities(),
      version: manager.version,
      ticketSecretFp: manager.ticketSecretFingerprint,
      egress: slotPool.egressState?.() || undefined,
    }
    const res = await postJson({
      url: `${manager.url}/api/v1/sandbox/nodes/register`,
      code: manager.code,
      body: payload,
    })
    if (!res.ok) {
      throw Object.assign(new Error(`注册被拒绝（HTTP ${res.status}）：${res.text.slice(0, 200)}`), { status: res.status })
    }
    if (Number(res.body?.heartbeatIntervalMs) > 0) intervalMs = Number(res.body.heartbeatIntervalMs)
    // 出站策略排在 artifactHost 之前：它可能把整条链重编排一遍，
    // 而 artifactHost 是往链里插一条。反过来的话那一条会被随后的重编排冲掉
    // （虽然重编排本身会带上 persistentEgress，但依赖那个巧合不如把顺序写对）。
    await applyEgressPolicy(res.body?.egress)
    await applyArtifactHost(res.body?.artifactHost)
    return res.body
  }

  async function heartbeat() {
    const res = await postJson({
      url: `${manager.url}/api/v1/sandbox/nodes/heartbeat`,
      code: manager.code,
      body: loadSnapshot(),
    })
    // 409 = 注册表里没有本节点（心跳断过 30 秒以上，明细键已过期）。
    // 这不是错误，是预期内的状态：重新注册即可，不要当异常刷日志。
    if (res.status === 409) {
      logger.info('心跳发现本节点已从注册表过期，重新注册')
      registered = false
      scheduleRegister(0)
      return
    }
    if (!res.ok) {
      throw Object.assign(new Error(`心跳被拒绝（HTTP ${res.status}）：${res.text.slice(0, 200)}`), { status: res.status })
    }
    // 心跳也认：管理端改了出站策略/中途开启产物功能时都不必等节点重启。
    // 这正是"worker 不需要任何配置"能成立的地方 —— 策略是活的，跟着心跳走。
    await applyEgressPolicy(res.body?.egress)
    await applyArtifactHost(res.body?.artifactHost)
    if (Number(res.body?.heartbeatIntervalMs) > 0) intervalMs = Number(res.body.heartbeatIntervalMs)
  }

  function scheduleHeartbeat() {
    clearTimeout(heartbeatTimer)
    if (stopped) return
    heartbeatTimer = setTimeout(async () => {
      try {
        await heartbeat()
      } catch (error) {
        // 心跳失败只影响"会不会被调度到"，不影响已有租约。降级为 warn，
        // 不重试、不退出——下一个周期自然会再试一次。
        logger.warn('心跳失败，本节点可能暂时不会被调度到', { err: error?.message })
      }
      scheduleHeartbeat()
    }, intervalMs)
    heartbeatTimer.unref?.()
  }

  function scheduleRegister(attempt = 0) {
    clearTimeout(registerTimer)
    if (stopped) return
    const delay = attempt === 0 ? 0 : REGISTER_BACKOFF_MS[Math.min(attempt - 1, REGISTER_BACKOFF_MS.length - 1)]
    registerTimer = setTimeout(async () => {
      try {
        await register()
        registered = true
        logger.info('已注册到 sandbox-manager', {
          manager: manager.url,
          nodeId: manager.nodeId,
          pool: manager.pool,
          heartbeatIntervalMs: intervalMs,
        })
        scheduleHeartbeat()
      } catch (error) {
        logger.warn('注册失败，稍后重试（本节点仍可正常服务已有租约）', {
          manager: manager.url,
          attempt: attempt + 1,
          err: error?.message,
        })
        scheduleRegister(attempt + 1)
      }
    }, delay)
    registerTimer.unref?.()
  }

  return {
    get registered() { return registered },

    /**
     * 单次注册。`start()` 内部的重试循环用它，测试也用它 ——
     * 它本来就是一个完整的操作，不是为测试凿的洞。
     */
    registerOnce: register,

    /**
     * 单次心跳。同上。
     *
     * 注册和心跳带的字段是**各自组装**的（register 的 payload 是静态信息，
     * 心跳的 loadSnapshot 是会变的负载），所以"注册带了某个字段"推不出
     * "心跳也带了"—— 这两条路径必须各自测到。
     */
    heartbeatOnce: heartbeat,

    start() {
      logger.info('开始向 sandbox-manager 注册', {
        manager: manager.url,
        nodeId: manager.nodeId,
        pool: manager.pool,
        base: config.advertiseBase,
        // 密钥指纹两边一比就知道配没配对。两边不一致的现象是"调度成功但
        // 所有租约申请 401"，各自日志都正常，不打指纹很难定位。
        ticketSecretFp: manager.ticketSecretFingerprint,
      })
      scheduleRegister(0)
    },

    /** 停机：先摘流量再退出，省掉调度还往一个正在关闭的节点上派活的窗口 */
    async stop() {
      stopped = true
      clearTimeout(heartbeatTimer)
      clearTimeout(registerTimer)
      if (!registered) return
      try {
        await postJson({
          url: `${manager.url}/api/v1/sandbox/nodes/deregister`,
          code: manager.code,
          body: { nodeId: manager.nodeId },
          timeoutMs: 2000,
        })
        logger.info('已从 sandbox-manager 注销')
      } catch (error) {
        // 注销失败无所谓：不心跳 30 秒后注册表里的明细键自然过期。
        // 唯一代价是那 30 秒里调度可能还会挑中本节点。
        logger.warn('注销失败，将由注册表 TTL 兜底', { err: error?.message })
      }
    },
  }
}
