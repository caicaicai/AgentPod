/**
 * 沙盒客户端：把工具执行送出本进程。协议见 sandbox-worker/PROTOCOL.md。
 *
 * 隔离契约 #2：pi 内置的 bash/read/write/edit 默认在**当前进程**执行 —— 在多租户服务里
 * 等于把其他用户的临时目录、服务配置、K8s ServiceAccount token 全都交给模型。
 *
 * 四种模式：
 *   manager —— 生产（目标形态）：向 sandbox-manager 要一组候选节点 + 短期票据，
 *              拿票据直连节点换租约。**本进程不持有任何长期凭据。**
 *   http    —— 生产（迁移前）：拿静态 SANDBOX_TOKEN 直接向 worker 池申请租约
 *   local   —— 仅本地开发：在本进程 spawn（config.js 会在生产拒绝启动）
 *   none    —— 不提供执行能力（纯对话场景）
 *
 * **租约是懒申请的**：绝大多数轮次根本不调 bash，每轮都占一个槽位会把池子白白耗光。
 * 第一次真的要执行命令时才去要，run 结束时释放。
 *
 * **但连续型任务是例外**：上一轮驻留（park）下来的沙盒，这一轮开头就 attach 回去
 * （`resume()`）。看着像是破了懒申请的规矩，其实不是 —— 那个 slot 本来就还占着，
 * attach 只是把我们已经在付的东西拿回来用；而且必须在开头做，否则这一轮的系统
 * 提示没法告诉模型"登录态还在"。见 src/sandbox/sticky.js 与 docs/SANDBOX-LIFECYCLE.md。
 */
import { Errors } from '../errors.js'
import { createStickyLeases } from './sticky.js'

/**
 * 429 = 槽位满。两种模式的重试语义不同：
 *   http    —— 重试同一个 Service 地址，指望被分到别的副本
 *   manager —— 先把 manager 给的候选依次试完，都满了才重新调度一轮
 */
const LEASE_RETRY_DELAYS_MS = [0, 200, 600, 1500]

export function createHttpSandbox({ config, logger }) {
  const staticAuthHeader = config.sandbox.token ? { Authorization: `Bearer ${config.sandbox.token}` } : {}
  const viaManager = config.sandbox.mode === 'manager'
  // 跨 run 存活，所以挂在这一层而不是 session 上
  const sticky = createStickyLeases({ logger })

  /**
   * 租约内操作（exec / 文件 / 浏览器）的凭据。
   *
   * worker 在租约响应里回一枚 `leaseToken`，只对这一个租约有效，也不进 URL。
   * 老版本 worker 没有这个字段，退回静态 token —— 滚动发布期间两种 worker
   * 会同时在线，不兜住这一层会有一批请求 401。
   */
  function leaseAuthHeader(session) {
    // runId 同时当 traceId 传给节点：它本来就贯穿 agent 的一次运行、票据载荷和
    // 桥的调用，让节点也记上同一个值，"这条出网请求是谁发的"才答得出来。
    // 我们让模型在沙盒里跑任意代码，这个问题必须答得出。
    const trace = session.runId ? { 'x-trace-id': String(session.runId) } : {}
    if (session.leaseToken) return { Authorization: `Bearer ${session.leaseToken}`, ...trace }
    return { ...staticAuthHeader, ...trace }
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

  /**
   * 租约保活。
   *
   * worker 侧已经做到"活跃即续"：每个租约内请求都会把到期时刻往后滑一个窗口。
   * 但那只覆盖得住**一直在发请求**的情况 —— 一轮里模型长思考、或者本地在跑
   * 一段不经沙盒的逻辑时，沙盒会安静十几分钟，正好撞上 idle 回收。
   * 用户回来时工作区已经没了。
   *
   * 这个定时器表达的是"**这个 run 还活着**"，比"最近有没有请求"更接近真相；
   * agent 进程崩了它跟着一起死，槽位照常被回收，没有削弱回收能力。
   */
  function stopKeepalive(session) {
    if (session.keepalive) clearInterval(session.keepalive)
    session.keepalive = null
  }

  /** 租约没了/换了之后要把凭据一起丢掉：它只对那一个租约有效 */
  function forgetLease(session) {
    stopKeepalive(session)
    session.leaseId = null
    session.leaseToken = ''
  }

  async function renewLease(session) {
    if (!session.leaseId) return
    let res
    try {
      res = await fetch(`${session.workerBase}/v1/leases/${session.leaseId}/renew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...leaseAuthHeader(session) },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      })
    } catch (error) {
      // 单次失败不要紧：续期周期远小于滑动窗口，下一次还有机会。
      logger.warn('沙盒租约续期失败，等下一次', { leaseId: session.leaseId, err: error?.message })
      return
    }
    if (res.status !== 404) return

    const body = await res.json().catch(() => ({}))
    // 老版本 worker 根本没有这个路由，回的是路由级 not-found；租约真没了回的是
    // lease-not-found-or-expired。滚动发布期间两种 worker 同时在线，不区分的话
    // 日志里会每分钟刷一条误导性的"租约被回收了"。
    if (body.error === 'not-found') {
      logger.info('沙盒节点不支持租约续期（旧版本），停止保活', { worker: session.workerBase })
      stopKeepalive(session)
      return
    }
    logger.warn('沙盒租约已被回收，停止保活', { leaseId: session.leaseId })
    stopKeepalive(session)
  }

  function startKeepalive(session, idleTimeoutMs) {
    if (!config.sandbox.keepalive) return
    stopKeepalive(session)
    // 节奏由 worker 在租约响应里下发的滑动窗口决定，**不硬编码**：两边各存一份、
    // 其中一边改了配置，现象是租约在 agent 眼里"莫名其妙提前没了"，两边日志都正常。
    // 取三分之一是为了容一次失败；老版本 worker 不回这个字段时退到 10 分钟档。
    const period = clamp(Math.floor((Number(idleTimeoutMs) || 600000) / 3), 30_000, 300_000)
    session.keepalive = setInterval(() => {
      renewLease(session).catch(() => {})
    }, period)
    // 不能让保活定时器把进程钉住
    session.keepalive.unref?.()
  }

  /**
   * 异步执行 + 断线续传。
   *
   * 同步 exec 是一条长连接，中途断了这条命令就没了 —— 在桌面端无所谓（连接断了
   * 就是用户关了窗口），但 B/S 之后网络抖一下、网关掐一次空闲连接，一条跑了四分钟的
   * `npm install` 就白跑，而且工作区里留下的是**半装完的 node_modules**。
   *
   * 这里改成：命令在节点上后台跑，输出按 `seq` 编号攒着；连接断了就带着
   * 最后收到的 seq 重连，从断点接着取。节点侧断开不杀命令，只有显式
   * `DELETE /execs/{execId}` 才杀 —— 所以调用方真的要放弃时必须说出来。
   */
  const RESUME_DELAYS_MS = [0, 300, 800, 2000]

  async function execViaAsyncJob({ session, payload, signal, onData }) {
    const startRes = await fetch(`${session.workerBase}/v1/leases/${session.leaseId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...leaseAuthHeader(session) },
      body: JSON.stringify({ ...payload, async: true }),
      signal: AbortSignal.timeout(15000),
    })
    if (startRes.status === 404) {
      forgetLease(session)
      throw Errors.upstream('沙盒租约已过期或被回收，请重试')
    }
    if (!startRes.ok) throw Errors.upstream(`沙盒返回 ${startRes.status}`)
    const { execId } = await startRes.json()

    /** 调用方主动放弃（用户取消了这一轮）才通知节点杀命令 */
    const abandon = () => fetch(`${session.workerBase}/v1/leases/${session.leaseId}/execs/${execId}`, {
      method: 'DELETE',
      headers: leaseAuthHeader(session),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})

    let lastSeq = 0
    let outcome = null

    for (const delay of RESUME_DELAYS_MS) {
      if (signal?.aborted) {
        await abandon()
        throw Errors.timeout('沙盒执行超时或被中止')
      }
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))

      try {
        const res = await fetch(
          `${session.workerBase}/v1/leases/${session.leaseId}/execs/${execId}/events?fromSeq=${lastSeq}`,
          { headers: leaseAuthHeader(session), signal },
        )
        if (res.status === 404) {
          // 任务被淘汰或租约没了 —— 重连也没用
          throw Errors.upstream('沙盒任务的输出已不可用（租约可能已被回收）')
        }
        if (!res.ok) throw Errors.upstream(`沙盒返回 ${res.status}`)

        outcome = await readNdjson(res, onData, (seq) => { lastSeq = Math.max(lastSeq, seq) })
        if (outcome.sawExit) break
        // 流断在半路（没收到 exit 帧）：命令多半还在跑，带着断点回去接着取
        logger.warn('沙盒事件流中断，准备续传', { runId: session.runId, execId, lastSeq })
      } catch (error) {
        if (signal?.aborted) {
          await abandon()
          throw Errors.timeout('沙盒执行超时或被中止')
        }
        if (error?.code) throw error
        logger.warn('沙盒事件流读取失败，准备续传', { runId: session.runId, execId, lastSeq, err: error?.message })
      }
    }

    if (!outcome?.sawExit) {
      // 重试都用完了还没等到终止帧。命令可能还在节点上跑着 —— 明确放弃掉，
      // 不然它会一直占着这个租约的资源直到自己超时。
      await abandon()
      throw Errors.upstream('沙盒事件流反复中断，已放弃本次执行')
    }
    return outcome
  }

  /** 向 manager 要候选节点。每个候选自带一张只对它有效的票据。 */
  async function scheduleCandidates({ runId, username }) {
    const res = await fetch(`${config.sandbox.managerUrl}/api/v1/sandbox/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-SecurityCode': config.sandbox.managerCode },
      // 不跟重定向：这枚长期令牌在自定义请求头里，跨源跳转时**不会**像
      // Authorization 那样被剥掉，跟着 302 就发到别的主机去了。
      // 管理端是内网固定地址，正常情况下不该有跳转，宁可明确失败。
      redirect: 'error',
      body: JSON.stringify({
        runId,
        username,
        pool: config.sandbox.pool,
        ...(config.sandbox.needBrowser ? { need: { browser: true } } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (res.status === 503) return [] // 没有空闲节点，交给外层重试
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw Errors.upstream(`沙盒调度失败（HTTP ${res.status}）：${text.slice(0, 200)}`)
    }
    const body = await res.json()
    return Array.isArray(body.candidates) ? body.candidates : []
  }

  /** 拿票据向某个节点换租约。@returns 租约 | null（这个节点满了，试下一个） */
  async function redeemTicket(candidate, { runId }) {
    const res = await fetch(`${candidate.base}/v1/leases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${candidate.ticket}`,
        ...(runId ? { 'x-trace-id': String(runId) } : {}),
      },
      // 有意**不传 username**：节点从票据载荷里读它。传了只会多一次一致性校验，
      // 传错了还会被 400 挡掉，而票据里那份才是 manager 断言过的。
      body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(10000),
    })

    if (res.status === 429) return null
    if (res.status === 401) {
      // 票据被拒。最常见的原因是 manager 与节点的 SANDBOX_TICKET_SECRET 不一致 ——
      // 那种情况下换任何一个候选都是 401，但这里不提前放弃：也可能只是这个节点
      // 恰好在换密钥。把它当成"这个节点不可用"，继续试下一个。
      logger.warn('沙盒节点拒绝票据（检查 manager 与节点的 SANDBOX_TICKET_SECRET 是否一致）', {
        node: candidate.nodeId,
      })
      return null
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw Errors.upstream(`沙盒租约申请失败（HTTP ${res.status}）：${text.slice(0, 200)}`)
    }

    const body = await res.json()
    return {
      leaseId: body.leaseId,
      leaseToken: body.leaseToken || '',
      workerBase: body.workerBase || candidate.base,
      nodeId: candidate.nodeId,
      idleTimeoutMs: body.idleTimeoutMs,
      features: body.features || {},
    }
  }

  /** manager 模式：调度一轮 → 依次试候选 → 都满了再调度下一轮 */
  async function acquireViaManager({ runId, username }) {
    let sawCandidate = false
    for (const delay of LEASE_RETRY_DELAYS_MS) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))

      let candidates
      try {
        candidates = await scheduleCandidates({ runId, username })
      } catch (error) {
        if (error?.code) throw error
        logger.warn('沙盒调度请求失败', { runId, username, err: error?.message })
        continue
      }
      if (!candidates.length) continue
      sawCandidate = true

      for (const candidate of candidates) {
        try {
          const lease = await redeemTicket(candidate, { runId })
          if (lease) return lease
        } catch (error) {
          if (error?.code) throw error
          // 单个节点连不上不该让整轮失败：manager 的视图最多陈旧一个心跳周期，
          // 它可能刚挂掉还没从注册表里过期。试下一个候选。
          logger.warn('沙盒候选节点不可达，试下一个', { node: candidate.nodeId, err: error?.message })
        }
      }
    }
    throw Errors.busy(
      sawCandidate
        ? '沙盒池当前没有空闲槽位，请稍后重试'
        : '沙盒调度不可用或集群内没有可调度节点，请稍后重试',
    )
  }

  async function acquireLease({ runId, username }) {
    if (viaManager) return acquireViaManager({ runId, username })
    return acquireViaService({ runId, username })
  }

  async function acquireViaService({ runId, username }) {
    let lastStatus = 0
    for (const delay of LEASE_RETRY_DELAYS_MS) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      let res
      try {
        res = await fetch(`${config.sandbox.url}/v1/leases`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...staticAuthHeader,
            ...(runId ? { 'x-trace-id': String(runId) } : {}),
          },
          body: JSON.stringify({ runId, username }),
          signal: AbortSignal.timeout(10000),
        })
      } catch (error) {
        logger.warn('申请沙盒租约失败', { runId, username, err: error?.message })
        lastStatus = 0
        continue
      }
      if (res.ok) {
        const body = await res.json()
        // worker 在响应里回报自己的地址；之后所有请求直连它，否则工作区找不到
        return {
          leaseId: body.leaseId,
          leaseToken: body.leaseToken || '',
          workerBase: body.workerBase || config.sandbox.url,
          idleTimeoutMs: body.idleTimeoutMs,
          features: body.features || {},
        }
      }
      lastStatus = res.status
      if (res.status !== 429) {
        const text = await res.text().catch(() => '')
        throw Errors.upstream(`沙盒租约申请失败（HTTP ${res.status}）：${text.slice(0, 200)}`)
      }
    }
    throw Errors.busy(
      lastStatus === 429
        ? '沙盒池当前没有空闲槽位，请稍后重试'
        : '沙盒服务不可达，请稍后重试',
    )
  }

  async function releaseLease(session) {
    stopKeepalive(session)
    if (!session.leaseId) return
    try {
      await fetch(`${session.workerBase}/v1/leases/${session.leaseId}`, {
        method: 'DELETE',
        headers: leaseAuthHeader(session),
        signal: AbortSignal.timeout(10000),
      })
    } catch (error) {
      // 释放失败不影响本轮结果，但 worker 侧的 idle 清扫要过一会儿才收 —— 值得记一笔
      logger.warn('沙盒租约释放失败，等 worker 侧清扫回收', { leaseId: session.leaseId, err: error?.message })
    }
  }

  /**
   * 接管上一轮驻留下来的租约。
   *
   * **一次不成就放弃，绝不重试。** attach 会在 worker 侧轮换 leaseToken：
   * 重试用的是已经作废的旧凭据，必然 401；更糟的是第一次可能其实已经成功了
   * （只是响应丢在路上），重试等于把一个刚接管好的租约丢在没人认领的状态。
   * 退回新建租约是完全可用的路径，代价只是这一轮要重新登录。
   *
   * @returns 租约 | null（null = 用新的，不是错误）
   */
  async function attachLease(handle, { runId, username }) {
    let res
    try {
      res = await fetch(`${handle.workerBase}/v1/leases/${handle.leaseId}/attach`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${handle.leaseToken}`,
          ...(runId ? { 'x-trace-id': String(runId) } : {}),
        },
        // username 让节点再核一遍归属。它验的是"这个句柄是不是这个人的"——
        // 静态 token 模式下这是唯一拦着"捡个 leaseId 就接管别人沙盒"的一层。
        body: JSON.stringify({ runId, username }),
        signal: AbortSignal.timeout(10000),
      })
    } catch (error) {
      logger.warn('驻留沙盒不可达，本轮改用新沙盒', { leaseId: handle.leaseId, err: error?.message })
      return null
    }

    if (!res.ok) {
      // 404 = 驻留超时/被抢占/节点重启过；409 = 同会话的另一个 run 正用着；
      // 401/403 = 凭据轮换过或归属对不上。四种都退回新建，**都不是错误**。
      logger.info('接管驻留沙盒未成功，本轮改用新沙盒', { leaseId: handle.leaseId, status: res.status })
      return null
    }

    const body = await res.json().catch(() => null)
    if (!body?.leaseId) return null
    return {
      leaseId: body.leaseId,
      leaseToken: body.leaseToken || '',
      workerBase: body.workerBase || handle.workerBase,
      nodeId: handle.nodeId,
      idleTimeoutMs: body.idleTimeoutMs,
      features: body.features || {},
      browser: Boolean(body.browser),
      maxRemainingMs: Number(body.maxRemainingMs) || 0,
    }
  }

  /**
   * 驻留：这一轮结束了，但让 worker 把 slot 留着等下一轮。
   * @returns {{parked: boolean, expiresAt?: number}} parked=false 时调用方必须退回释放
   */
  async function parkLease(session, { reason = 'turn-end' } = {}) {
    // 保活先停：驻留窗口由 worker 侧的清扫说了算，我们不该在一轮结束后
    // 还替一个没人用的租约续命。
    stopKeepalive(session)
    if (!session.leaseId) return { parked: false }
    try {
      const res = await fetch(`${session.workerBase}/v1/leases/${session.leaseId}/park`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...leaseAuthHeader(session) },
        body: JSON.stringify({ reason }),
        signal: AbortSignal.timeout(10000),
      })
      // 老版本 worker 没有这个路由，回 404。滚动发布期间这是**正常**的，
      // 不该在日志里刷错误 —— 退回释放，行为就是今天的行为。
      if (!res.ok) return { parked: false }
      const body = await res.json().catch(() => ({}))
      return { parked: Boolean(body.parked), expiresAt: Number(body.expiresAt) || 0 }
    } catch (error) {
      logger.warn('沙盒驻留请求失败，退回释放', { leaseId: session.leaseId, err: error?.message })
      return { parked: false }
    }
  }

  return {
    mode: config.sandbox.mode,

    /** 一次 run 一个 session；租约在第一次 exec 时才真正申请（除非能接管上一轮的） */
    createSession({ runId, username, sessionKey = 'main' }) {
      const session = {
        leaseId: null, leaseToken: '', workerBase: null, runId, username, keepalive: null, features: {},
        /** 这一轮里浏览器上下文是不是活的（本轮开过，或从上一轮接管过来时就开着） */
        browserLive: false,
        attached: false,
      }
      let acquiring = null

      /**
       * 粘性句柄的认领权。**同步认领**（见 sticky.js）：两个并发 run 抢同一个
       * 会话时，第二个拿到 owner=false，它照常干活，只是结束时不驻留 ——
       * 否则它会把第一个 run 的句柄覆盖掉。
       */
      const parkEnabled = config.sandbox.park !== 'off'
      const claim = parkEnabled
        ? sticky.claim({ username, sessionKey, runId })
        : { owner: false, handle: null }

      /** 把一个租约（新申请的或接管来的）装到 session 上 */
      function adopt(lease) {
        session.leaseId = lease.leaseId
        // 租约级凭据。**不进日志** —— 它就是这个租约的执行权限本身。
        session.leaseToken = lease.leaseToken || ''
        session.workerBase = lease.workerBase
        session.nodeId = lease.nodeId || null
        session.features = lease.features || {}
        startKeepalive(session, lease.idleTimeoutMs)
        return session
      }

      async function ensureLease() {
        if (session.leaseId) return session
        if (!acquiring) {
          acquiring = acquireLease({ runId, username })
            .then((lease) => {
              adopt(lease)
              logger.info('已获得沙盒租约', {
                runId,
                username,
                worker: lease.workerBase,
                node: lease.nodeId || null,
                // 记"有没有拿到租约级凭据"而不是凭据本身：滚动发布期间
                // 混着老版本 worker 时，这一条能直接看出走的是哪条路
                scopedAuth: Boolean(lease.leaseToken),
              })
              return session
            })
            .finally(() => {
              acquiring = null
            })
        }
        return acquiring
      }

      return {
        mode: config.sandbox.mode,

        /**
         * 接管上一轮驻留下来的沙盒。**在 run 开头调，早于系统提示的装配。**
         *
         * 为什么这一步不能懒：这一轮要不要重新登录、要不要把共享盘上的工作区
         * 再铺一遍、系统提示里该写"登录态还在"还是"已经没了" —— 三件事都得在
         * 模型说第一句话之前定下来。而且它并不违反懒申请的初衷：那个 slot 本来
         * 就还占着（是我们上一轮主动留下的），attach 没有多占任何东西。
         *
         * @returns {null|{attached: boolean, browser?: boolean, maxRemainingMs?: number, lost?: boolean}}
         *   null = 没有可接管的（新会话/关了驻留），照常懒申请；
         *   `lost: true` = 上一轮驻留过但已经没了 —— 调用方**必须**把这件事讲给模型听。
         */
        async resume() {
          if (!claim.handle) return null
          const lease = await attachLease(claim.handle, { runId, username })
          if (!lease) {
            // 句柄作废了。清掉内容但**保留认领权**：本轮走正常新建，结束时
            // 照样可以驻留 —— 让出键的话，那个新驻留的租约就没人认领了。
            sticky.forget({ username, sessionKey, runId })
            claim.handle = null
            return { attached: false, lost: true }
          }
          adopt(lease)
          session.attached = true
          session.browserLive = lease.browser
          logger.info('已接管上一轮的沙盒', {
            runId, username, sessionKey, worker: lease.workerBase, browser: lease.browser,
          })
          return { attached: true, browser: lease.browser, maxRemainingMs: lease.maxRemainingMs }
        },

        /**
         * 这一轮到底有没有真的占过槽位。
         *
         * 收尾时要用：租约是**懒申请**的，纯聊天的 run 从头到尾没碰过沙盒。
         * 收尾逻辑（比如把工作区同步回共享盘）如果直接调 listFiles，
         * `ensureLease` 会在这时候现申请一个租约 —— 为了同步一个必然是空的
         * 工作区，白占一个槽位再释放。
         */
        get leased() {
          return Boolean(session.leaseId)
        },

        /** 这一轮的沙盒是接管来的，不是新开的。调用方据此决定要不要重铺工作区 */
        get attached() {
          return session.attached
        },

        /**
         * 浏览器上下文是不是活的。
         *
         * 这是"要不要驻留"的判据（见 run-turn.js）：**本轮开过**算，
         * **从上一轮接管过来时就开着**也算。少了后半句，一个接管了浏览器却只跑了
         * 段脚本的轮次会把上一轮辛苦登好的浏览器直接销毁掉。
         */
        get browserLive() {
          return session.browserLive
        },

        // onData 可以不传：不是每个调用方都关心输出（比如技能搬运时建软链接那一步）。
        // 之前它是必填的**隐式**契约 —— 不传也能过，直到命令真的往 stdout/stderr
        // 写了一个字节，才在 readNdjson 里炸成 "onData is not a function"。
        /**
         * ⚠️ `timeoutMs` 就是**毫秒**，名字里带单位是有原因的。
         *
         * 以前这个参数叫 `timeout`，而唯一的调用方（agent/tools.js）直接把 pi 的
         * `options.timeout` 塞了进来 —— 那玩意儿的单位是**秒**（pi 的 schema 原文是
         * "Timeout in seconds"，它自己的执行器写的是 `timeout * 1000`）。
         * 于是模型要 30 秒，worker 收到的是 30 毫秒。详见 agent/tools.js 里的换算。
         */
        async exec({ command, cwd, env, signal, timeoutMs, onData = () => {} }) {
          await ensureLease()

          const controller = new AbortController()
          const abort = () => controller.abort()
          signal?.addEventListener('abort', abort, { once: true })
          const effectiveMs = timeoutMs || config.sandbox.timeoutMs
          // 比 worker 自己的上限多给 5 秒：让节点先按它的规则收尾（它会回 TIMEOUT 帧
          // 说明原因），我们这层只是兜底，别抢在它前面把连接掐了
          const timer = setTimeout(abort, effectiveMs + 5000)
          // cwd 只传相对路径：agent 侧的绝对路径在 worker 容器里不存在
          const payload = { command, cwd: toRelativeCwd(cwd), env, timeoutMs: effectiveMs }

          try {
            // 节点支持就走异步 + 断线续传。靠节点自报能力而不是"试一下看会不会 404"：
            // 滚动发布期间后者会在正常路径上刷一片吓人的错误日志。
            if (config.sandbox.execAsync && session.features?.execAsync) {
              return await execViaAsyncJob({ session, payload, signal: controller.signal, onData })
            }

            const res = await fetch(`${session.workerBase}/v1/leases/${session.leaseId}/exec`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...leaseAuthHeader(session) },
              body: JSON.stringify(payload),
              signal: controller.signal,
            })
            if (res.status === 404) {
              // 租约被清扫掉了（agent 卡了很久）。说清原因，别让人对着 404 猜。
              // 凭据要跟着一起清：它只对这一个租约有效，留着会拿旧凭据去打新租约。
              forgetLease(session)
              throw Errors.upstream('沙盒租约已过期或被回收，请重试')
            }
            if (!res.ok) throw Errors.upstream(`沙盒返回 ${res.status}`)

            return await readNdjson(res, onData)
          } catch (error) {
            if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw Errors.timeout('沙盒执行超时或被中止')
            if (error?.code) throw error
            logger.warn('沙盒执行失败', { runId, username, err: error?.message })
            throw Errors.upstream(`沙盒执行失败：${error?.message || error}`)
          } finally {
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
          }
        },

        /**
         * 浏览器动作。契约与桌面端 `/tools/workstation.*` 对齐。
         *
         * `cookies` 是本设计里凭据**唯一一次**离开 agent service：浏览器自动化本质上
         * 需要浏览器自己持有登录态，代发请求替代不了。约束写在 tools/context.js。
         */
        async browserAction(action, payload = {}) {
          await ensureLease()
          const res = await fetch(`${session.workerBase}/v1/leases/${session.leaseId}/browser/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...leaseAuthHeader(session) },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(config.sandbox.browserTimeoutMs || 90000),
          })
          if (res.status === 501) throw Errors.upstream('沙盒未启用浏览器能力（BROWSER_ENABLED=0）')
          if (res.status === 404) {
            forgetLease(session)
            throw Errors.upstream('沙盒租约已过期或被回收，请重试')
          }
          if (!res.ok) throw Errors.upstream(`浏览器动作失败（HTTP ${res.status}）`)
          /**
           * 这一轮真的碰过浏览器 = 这个会话很可能要连续操作。**驻留判据就这一个**。
           *
           * 它来自已经发生的事实，不来自模型的声明 —— 问模型"要不要保留沙盒"，
           * 它会永远说要：它没有容量视角，也不知道下一轮还来不来。
           *
           * 记在动作**成功之后**：501（节点没开浏览器）和 404（租约没了）都会走到
           * 上面的 throw，那两种情况下压根没有浏览器上下文可留。
           */
          session.browserLive = true
          return res.json()
        },

        /** 上传文件进工作区（file-upload 之类要用） */
        async putFile({ path: filePath, content }) {
          await ensureLease()
          const res = await fetch(`${session.workerBase}/v1/leases/${session.leaseId}/files`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...leaseAuthHeader(session) },
            body: JSON.stringify({ path: filePath, contentBase64: Buffer.from(content).toString('base64') }),
          })
          if (!res.ok) throw await fileOpError(res, '写入沙盒文件失败')
          return res.json()
        },

        /** 批量写。一次 run 里铺二十个小文件是常态，二十个来回比传输本身还贵。 */
        async putFiles(files) {
          await ensureLease()
          const res = await fetch(`${session.workerBase}/v1/leases/${session.leaseId}/files/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...leaseAuthHeader(session) },
            body: JSON.stringify({
              files: files.map((f) => ({ path: f.path, contentBase64: Buffer.from(f.content).toString('base64') })),
            }),
          })
          if (!res.ok) throw await fileOpError(res, '批量写入沙盒文件失败')
          return res.json()
        },

        /** 列工作区。回结构化条目，调用方不用再解析 `ls` 的文本输出。 */
        async listFiles({ path: dir = '.', recursive = false, includeHidden = false } = {}) {
          await ensureLease()
          const query = new URLSearchParams({
            path: dir,
            ...(recursive ? { recursive: '1' } : {}),
            ...(includeHidden ? { includeHidden: '1' } : {}),
          })
          const res = await fetch(`${session.workerBase}/v1/leases/${session.leaseId}/files/list?${query}`, {
            headers: leaseAuthHeader(session),
          })
          if (res.status === 404) throw Errors.notFound(`沙盒里没有目录 ${dir}`)
          if (!res.ok) throw await fileOpError(res, '列沙盒目录失败')
          return res.json()
        },

        async statFile({ path: filePath }) {
          await ensureLease()
          const res = await fetch(
            `${session.workerBase}/v1/leases/${session.leaseId}/files/stat?path=${encodeURIComponent(filePath)}`,
            { headers: leaseAuthHeader(session) },
          )
          if (res.status === 404) throw Errors.notFound(`沙盒里没有 ${filePath}`)
          if (!res.ok) throw await fileOpError(res, '查询沙盒文件失败')
          return res.json()
        },

        async deleteFile({ path: filePath, recursive = false }) {
          await ensureLease()
          const query = new URLSearchParams({ path: filePath, ...(recursive ? { recursive: '1' } : {}) })
          const res = await fetch(`${session.workerBase}/v1/leases/${session.leaseId}/files?${query}`, {
            method: 'DELETE',
            headers: leaseAuthHeader(session),
          })
          if (!res.ok) throw await fileOpError(res, '删除沙盒文件失败')
          return res.json()
        },

        /** 批量读。缺一个不影响其余 —— 逐条带自己的 ok/error。 */
        async getFiles(paths) {
          await ensureLease()
          const res = await fetch(`${session.workerBase}/v1/leases/${session.leaseId}/files/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...leaseAuthHeader(session) },
            body: JSON.stringify({ paths }),
          })
          if (!res.ok) throw await fileOpError(res, '批量读取沙盒文件失败')
          const body = await res.json()
          return body.files.map((f) => (f.ok
            ? { path: f.path, ok: true, content: Buffer.from(f.contentBase64, 'base64') }
            : { path: f.path, ok: false, error: f.error }))
        },

        /**
         * 取产物的**裸流**。用于大文件：base64 那条路要把整个文件在两端各变成
         * 三份内存（Buffer + base64 串 + JSON 串），30 MB 的产物就是 90 MB。
         * 回的是 `Response`，调用方自己决定是转存还是直接往下游 pipe。
         */
        async getFileStream({ path: filePath }) {
          await ensureLease()
          const res = await fetch(
            `${session.workerBase}/v1/leases/${session.leaseId}/files/raw?path=${encodeURIComponent(filePath)}`,
            { headers: leaseAuthHeader(session) },
          )
          if (res.status === 404) throw Errors.notFound(`沙盒里没有文件 ${filePath}`)
          if (res.status === 413) throw Errors.upstream(`产物超过沙盒的单文件上限：${filePath}`)
          if (!res.ok) throw await fileOpError(res, '下载沙盒产物失败')
          return res
        },

        /** 取回产物 */
        async getFile({ path: filePath }) {
          if (!session.leaseId) throw Errors.notFound('本轮还没有沙盒工作区')
          const res = await fetch(
            `${session.workerBase}/v1/leases/${session.leaseId}/files?path=${encodeURIComponent(filePath)}`,
            { headers: leaseAuthHeader(session) },
          )
          if (res.status === 404) throw Errors.notFound(`沙盒里没有文件 ${filePath}`)
          if (!res.ok) throw await fileOpError(res, '读取沙盒文件失败')
          const body = await res.json()
          return { path: body.path, content: Buffer.from(body.contentBase64, 'base64') }
        },

        /**
         * run 结束必须调：不然槽位要等 idle 清扫才放开。
         *
         * @param {boolean} [park] 驻留而不是释放。**只是请求**：worker 可以拒绝
         *   （驻留数超限、快撞硬顶、老版本没这个路由），任何一种拒绝都退回释放。
         *   宁可丢连续性，不能泄漏槽位。
         */
        async finish({ park = false } = {}) {
          try {
            /**
             * 这一轮压根没占过槽位（纯聊天，租约是懒申请的）。
             *
             * 关键是**不要**顺手把粘性句柄删掉：上一轮驻留下来的沙盒在 worker
             * 那边还好好活着，删了句柄它就变成没人认领的孤儿，白占一个 slot
             * 直到驻留窗口到期。原样还回去。
             */
            if (!session.leaseId) {
              if (claim.owner && claim.handle) sticky.keep({ username, sessionKey, runId, handle: claim.handle })
              else if (claim.owner) sticky.drop({ username, sessionKey, runId })
              return { parked: false, untouched: true }
            }

            if (park && claim.owner) {
              const result = await parkLease(session, { reason: 'turn-end' })
              if (result.parked) {
                sticky.keep({
                  username,
                  sessionKey,
                  runId,
                  handle: {
                    leaseId: session.leaseId,
                    // attach 时 worker 轮换过凭据，存的必须是**当前这一枚**
                    leaseToken: session.leaseToken,
                    workerBase: session.workerBase,
                    nodeId: session.nodeId || null,
                    expiresAt: result.expiresAt,
                    browser: session.browserLive,
                  },
                })
                logger.info('沙盒已驻留，下一轮可接着用', {
                  runId, username, sessionKey, browser: session.browserLive, expiresAt: result.expiresAt,
                })
                return { parked: true }
              }
              logger.info('沙盒驻留未被接受，改为释放', { runId, username, sessionKey })
            }

            await releaseLease(session)
            if (claim.owner) sticky.drop({ username, sessionKey, runId })
            return { parked: false }
          } finally {
            // 驻留成功时也要断开本地这一份：凭据已经交给粘性句柄保管，
            // session 对象随这一轮一起作废，不该再留着能操作那个租约的东西。
            forgetLease(session)
          }
        },

        /**
         * 兼容旧调用方：等价于 `finish({ park: false })`。
         *
         * 认领权**必须**在这里也还回去 —— 漏了的话这个会话的键就永久锁死，
         * 之后每一轮都拿 owner=false，驻留功能对它悄悄失效，而日志里什么都看不到。
         */
        async release() {
          await releaseLease(session)
          if (claim.owner) sticky.drop({ username, sessionKey, runId })
        },
      }
    },
  }
}

/** agent 侧的绝对 cwd 在 worker 里没有意义，只保留相对部分 */
function toRelativeCwd(cwd) {
  const raw = String(cwd || '').trim()
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return ''
  return raw
}

/**
 * 被信号打死时该报什么退出码。
 *
 * 走 shell 的老规矩 `128 + signum`：这样 `SIGKILL` 是 137、`SIGTERM` 是 143，
 * 和用户在终端里看到的一致。关键是**必须是个非零的数**，不能留 null ——
 * 见 markSignalKill 的说明。
 */
const SIGNAL_EXIT_CODES = { SIGKILL: 137, SIGTERM: 143, SIGINT: 130, SIGQUIT: 131, SIGSEGV: 139, SIGABRT: 134 }

/**
 * 工作区文件操作失败时，把 worker 给的原因**原样带上**。
 *
 * 这几个接口的 4xx 都是"这个请求本身不对"：路径越界、路径里有软链接（worker 的
 * 文件接口不跟随软链接，见 `sandbox-worker/src/workspace-fs.js`）、文件太大、
 * 目标不是目录。这些最终都会走到模型眼前 —— 只回一句"HTTP 400"的话，它看不出
 * 自己哪里做错了，多半原样重试一遍，然后在同一个地方卡到本轮结束。
 *
 * 5xx 不带细节：那是节点自己的问题，对模型没有可操作性，也不该把内部信息喂出去。
 */
async function fileOpError(res, what) {
  const detail = await res.json().then((body) => (typeof body?.error === 'string' ? body.error : ''), () => '')
  if (res.status >= 400 && res.status < 500 && detail) return Errors.upstream(`${what}：${detail}`)
  return Errors.upstream(`${what}（HTTP ${res.status}）`)
}

/**
 * 把"被信号打死"翻译成模型看得懂的失败。
 *
 * ── 这条是从一次 76 次工具调用的会话里挖出来的 ──────────────────────
 *
 * 沙盒里的进程被 SIGKILL 之后，worker 回的是 `exitCode: null, signal: 'SIGKILL'`。
 * 我们这边只取了 exitCode，signal 直接丢掉。而 pi 的 bash 工具判失败是：
 *
 *     if (exitCode !== 0 && exitCode !== null) throw ...     // bash.js:294
 *
 * `null` 被**显式当成成功**。于是一次硬杀在模型眼里长这样：命令成功、没有输出。
 *
 * 后果不是"少了一条错误信息"，而是模型会去解释一个不存在的现象。实测那一轮里
 * 它先后猜过「stdout 被缓冲吞了」「加 -u」「重定向到文件再 cat」「改用 stderr」
 * 「换 curl」「沙盒禁网了」，写了七八版脚本，76 次调用、302 秒 —— 每一步推理
 * 都合理，因为唯一能证伪它们的那个事实被我们藏起来了。
 */
function markSignalKill({ exitCode, signal }, onData) {
  if (exitCode !== null && exitCode !== undefined) return exitCode
  if (!signal) return exitCode ?? null

  onData(Buffer.from(
    `\n[sandbox] 进程被 ${signal} 终止（没有正常退出）。`
    + '输出可能不完整，命令的副作用（写文件等）也可能没发生。\n',
  ))
  return SIGNAL_EXIT_CODES[signal] || 128
}

async function readNdjson(res, onData, onSeq = null) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let exitCode = null
  let truncated = false
  let execError = null
  let sawExit = false
  // worker 一直在发这三个，只是以前没人接。少了它们，"被杀"和"正常跑完且没输出"
  // 在调用方眼里完全一样。
  let signal = null
  let timedOut = false
  let aborted = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      // 心跳只用来证明连接还活着，不是任务的输出，也不占 seq
      if (frame.type === 'heartbeat') continue

      if (frame.type === 'stdout' || frame.type === 'stderr') onData(Buffer.from(frame.data || ''))
      else if (frame.type === 'exit') {
        sawExit = true
        exitCode = frame.exitCode ?? null
        truncated = Boolean(frame.truncated)
        signal = frame.signal || null
        // 老版本 worker 不发这两个字段，缺了就是 false —— 不影响 signal 那条主路径
        timedOut = Boolean(frame.timedOut)
        aborted = Boolean(frame.aborted)
      } else if (frame.type === 'error') {
        execError = frame
        // 执行期的错误也让模型看见 —— 它需要据此决定是改命令还是换路子
        onData(Buffer.from(`\n[sandbox] ${frame.message || frame.code}\n`))
      }

      // **处理完这一帧之后**才记 seq：先记的话，中途抛异常就等于把这帧
      // 标成"已收到"，续传时会跳过它，表现为输出凭空少一段。
      if (onSeq && Number.isFinite(frame.seq)) onSeq(frame.seq)
    }
  }
  // sawExit 是续传的判据：**流正常结束不等于命令跑完了**。连接被网关掐掉时
  // reader 也会 done，两者在这一层长得一模一样，只有收没收到终止帧能区分。
  // 只在真的收到终止帧时翻译：没收到 exit 帧说明流断在半路（续传会接着取），
  // 那时 exitCode 本来就是 null，不能当成"被杀"。
  if (sawExit) exitCode = markSignalKill({ exitCode, signal }, onData)
  if (timedOut) onData(Buffer.from('\n[sandbox] 命令超过时间上限被中止\n'))
  if (aborted) onData(Buffer.from('\n[sandbox] 命令被中止（调用方放弃或连接断开）\n'))

  return { exitCode, truncated, error: execError, sawExit, signal, timedOut, aborted }
}

/** 仅本地开发：在服务进程内执行。生产环境 config.js 会拒绝启动。 */
export function createLocalSandbox({ logger }) {
  logger.warn('沙盒为 local 模式：命令将在服务进程内执行，仅限本地开发')
  const impl = {
    mode: 'local',
    async exec({ command, cwd, env, signal, onData = () => {} }) {
      const { spawn } = await import('node:child_process')
      return new Promise((resolve, reject) => {
        const child = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, ...env } })
        const kill = () => child.kill('SIGKILL')
        signal?.addEventListener('abort', kill, { once: true })
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        child.on('error', reject)
        child.on('close', (code) => {
          signal?.removeEventListener('abort', kill)
          resolve({ exitCode: code })
        })
      })
    },
    // 本地模式没有租约，也就没有"驻留/接管"这回事 —— 进程内的东西本来就跨轮活着。
    // 但这两个方法必须在：调用方对四种模式一视同仁地调它们。
    async resume() { return null },
    async finish() { return { parked: false } },
    async release() {},
  }
  return { mode: 'local', createSession: () => impl }
}

export function createNullSandbox() {
  const impl = {
    mode: 'none',
    async exec({ onData = () => {} }) {
      onData(Buffer.from('[sandbox] 本服务未启用执行能力（SANDBOX_MODE=none）\n'))
      return { exitCode: 1 }
    },
    async resume() { return null },
    async finish() { return { parked: false } },
    async release() {},
  }
  return { mode: 'none', createSession: () => impl }
}

export function createSandbox({ config, logger }) {
  // manager 与 http 共用一套实现：两者只在"怎么拿到租约"这一步不同，
  // 拿到之后的 exec/文件/浏览器完全一样（都是直连持有工作区的那个节点）。
  if (config.sandbox.mode === 'manager' || config.sandbox.mode === 'http') {
    return createHttpSandbox({ config, logger })
  }
  if (config.sandbox.mode === 'local') return createLocalSandbox({ logger })
  return createNullSandbox()
}
