/**
 * 滑动窗口 + 指数退避的限流原语。
 *
 * ── 为什么本服务需要它 ──────────────────────────────────────────────────
 *
 * 密码校验走 scrypt（N=16384，见 src/identity/user-store.js），**一次约 50~100ms
 * CPU 且吃掉约 16MB 内存**。那是给离线爆破设的门槛，但在一个不限流的登录接口上
 * 它反过来成了放大器：几十个并发的未鉴权请求就能把进程压住 —— 攻击者花一次
 * HTTP 请求的代价，换我们 100ms 的 CPU。
 *
 * 所以这里挡的是两件事，它们的计数口径**不一样**，别合成一个：
 *
 *   按 IP   —— 每次尝试都计数（不管成没成功）。这是那道 DoS 闸门，必须在读
 *              请求体、更在 scrypt 之前就拦下来。
 *   按用户名 —— 只有失败才计数，成功就清零。这是防爆破的那道。用"尝试数"计
 *              会误伤：一个人在几个标签页里同时登录是正常的，而**连续失败**
 *              二十次不是。
 *
 * 两种口径共用下面这一个原语，区别只在调用方什么时候调 consume()。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 *
 * 计数在**进程内**。多副本部署时每个副本各挡各的，实际额度是 N 倍 —— 对
 * "别让一台机器被打死"这个目的够用，对"全局精确配额"不够。真要跨副本，
 * 该上的是 Redis 而不是把这份 Map 写得更花哨。
 */

/**
 * @param {object} params
 * @param {number} params.windowMs    窗口长度
 * @param {number} params.max         窗口内允许多少次
 * @param {number} params.baseBlockMs first 次超限的封禁时长，之后每次翻倍
 * @param {number} params.maxBlockMs  封禁时长上限
 * @param {number} [params.maxKeys]   最多跟踪多少个 key，见下面的清扫说明
 */
export function createRateLimiter({
  windowMs,
  max,
  baseBlockMs,
  maxBlockMs,
  maxKeys = 10000,
  now = () => Date.now(),
}) {
  /** key -> { stamps: number[], strikes: number, blockedUntil: number } */
  const entries = new Map()

  function entryFor(key) {
    let entry = entries.get(key)
    if (!entry) {
      entry = { stamps: [], strikes: 0, blockedUntil: 0 }
      entries.set(key, entry)
    }
    return entry
  }

  /** 这个 key 什么时候可以被忘掉（窗口空了且封禁已过） */
  function expiryOf(entry) {
    const lastStamp = entry.stamps.length ? entry.stamps[entry.stamps.length - 1] : 0
    return Math.max(entry.blockedUntil, lastStamp + windowMs)
  }

  /**
   * 清扫。**这本身是一条攻击面**：不清扫的话，攻击者换着用户名（或伪造 XFF）
   * 打过来，每个都在 Map 里留一条，内存就这么涨上去 —— 那是用限流器实现了
   * 一个更省事的 DoS。
   *
   * 淘汰顺序按"到期时间从早到晚"，所以**正在封禁中的 key 最后才被淘汰**。
   * 反过来（比如按插入顺序淘汰）就意味着：灌够多的新 key 就能把自己的封禁冲掉。
   */
  function sweep(at) {
    for (const [key, entry] of entries) {
      if (expiryOf(entry) <= at) entries.delete(key)
    }
    if (entries.size <= maxKeys) return
    const byExpiry = [...entries.entries()].sort((a, b) => expiryOf(a[1]) - expiryOf(b[1]))
    for (const [key] of byExpiry.slice(0, entries.size - maxKeys)) entries.delete(key)
  }

  return {
    /**
     * 记一次事件，并回答"现在还能不能过"。
     * @returns {{ ok: boolean, retryAfterMs: number }}
     */
    consume(key) {
      const at = now()
      if (entries.size >= maxKeys) sweep(at)
      const entry = entryFor(key)

      if (entry.blockedUntil > at) {
        return { ok: false, retryAfterMs: entry.blockedUntil - at }
      }

      // 窗口是滑动的：把落在窗口外的那些丢掉，剩下的才算数
      const floor = at - windowMs
      entry.stamps = entry.stamps.filter((stamp) => stamp > floor)
      entry.stamps.push(at)

      if (entry.stamps.length > max) {
        /**
         * 退避翻倍而不是固定时长：固定时长下攻击者只要按那个节奏发就行，
         * 限流退化成一个稳定速率的通道。翻倍会让持续攻击很快变得不划算，
         * 而误触的正常用户第一次只等 baseBlockMs。
         */
        entry.strikes += 1
        const blockMs = Math.min(baseBlockMs * 2 ** (entry.strikes - 1), maxBlockMs)
        entry.blockedUntil = at + blockMs
        // 封禁期间不再累计窗口 —— 否则解封瞬间就因为旧时间戳又被判超限
        entry.stamps = []
        return { ok: false, retryAfterMs: blockMs }
      }

      return { ok: true, retryAfterMs: 0 }
    },

    /**
     * 不计数，只问"现在是不是正被封着"。
     * 用在读请求体之前 —— 被封的连接不该还能让我们去读它的 body。
     */
    peek(key) {
      const entry = entries.get(key)
      const at = now()
      if (!entry || entry.blockedUntil <= at) return { ok: true, retryAfterMs: 0 }
      return { ok: false, retryAfterMs: entry.blockedUntil - at }
    },

    /**
     * 清零。登录成功时对该用户名调 —— 之前那几次手滑不该留在账上，
     * 否则"输错三次再输对"的人下一次登录会莫名其妙地更接近被封。
     */
    reset(key) {
      entries.delete(key)
    },

    /** 给测试和 /metrics.json 用 */
    size() {
      return entries.size
    },
  }
}

/**
 * 取客户端 IP。
 *
 * ⚠️ **默认不信任 `X-Forwarded-For`**。信任它的话，限流器就等于没有：
 * 攻击者每个请求换一个伪造的头，就是一个全新的 key、一份全新的额度。
 * 只有当运维明确说了"我前面确实有一层自己的反代"（TRUST_PROXY=1）才采信 ——
 * 那时是反代负责把伪造的头覆盖掉。
 *
 * 取最左边那个：反代按规范往右追加，最左边是原始客户端。这在多层反代下
 * 可能被最外层的客户端污染，但 TRUST_PROXY 的语义本来就是"我信我这条链"。
 */
export function clientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (forwarded) return forwarded
  }
  return req.socket?.remoteAddress || 'unknown'
}
