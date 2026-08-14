/**
 * 身份解析：把一次 HTTP 请求变成一个**服务端验证过的**主体 { username, credential }。
 *
 * 两种模式：
 *   password（推荐）：内置账号密码 + JWT 会话，Authorization: Bearer <token>。
 *   dev（仅本地）   ：信任 X-Username 头。config.js 会在 NODE_ENV=production 时拒绝启动。
 */
import { Errors } from '../errors.js'
import { parseUsers, verifyToken } from './password-auth.js'

/**
 * @param {object} params
 * @param {object} [params.users] 账号存储（src/identity/user-store.js）。
 *   有它就以库里的账号为准；没有（比如某些单测）才退回 CONSOLE_USERS 的明文比对。
 */
export function createIdentityResolver({ config, logger, users = null }) {
  const passwordUsers = config.auth.mode === 'password' ? parseUsers(config.auth.password.users) : null
  const passwordSecret = config.auth.mode === 'password'
    ? (config.auth.password.sessionSecret || config.platform.fallbackCookie || `auto-${Date.now()}-${Math.random()}`)
    : ''
  if (config.auth.mode === 'password' && !config.auth.password.sessionSecret) {
    logger.warn('SESSION_SECRET 未配置，使用自动生成的密钥（进程重启后所有会话失效）')
  }

  async function resolve(req) {
    if (config.auth.mode === 'dev') {
      const username = String(req.headers['x-username'] || '').trim()
      if (!username) throw Errors.unauthenticated('dev 模式需要 X-Username 头')
      return { username, credential: '', credentialSource: 'X-Username 头', verified: false }
    }

    if (config.auth.mode === 'password') return resolveByPassword(req)

    throw Errors.unauthenticated('不支持的认证模式')
  }

  /**
   * 账号状态的短期缓存：username -> { state, at }。
   *
   * 为什么要缓存：令牌校验在**每一个请求**上都会走，而它现在要问一次存储
   * "这个人的 tokenVersion 是几、有没有被禁用"。不缓存的话，每个请求多一次
   * 数据库往返 —— SSE 那条长连接倒是只付一次，但界面上那些密集的小接口
   * 会把这份开销放大得很明显。
   *
   * 为什么 TTL 可以很短就够：**同一个副本内的变更是当场生效的** ——
   * 改密 / 禁用的处理器会直接调 invalidate() 把这条踢掉。TTL 兜住的只是
   * "另一个副本上改的"这种情况，那本来就有传播延迟。
   */
  const authStateCache = new Map()
  const AUTH_STATE_TTL_MS = 10_000

  async function currentAuthState(username) {
    if (!users) return null
    const hit = authStateCache.get(username)
    if (hit && Date.now() - hit.at < AUTH_STATE_TTL_MS) return hit.state
    const state = await users.authState(username)
    authStateCache.set(username, { state, at: Date.now() })
    /**
     * 顺手清一批过期的。不清的话，这张表会随着"登录过的用户名总数"一直涨 ——
     * 开了自助注册的部署上，那个数没有上界。
     */
    if (authStateCache.size > 1000) {
      const floor = Date.now() - AUTH_STATE_TTL_MS
      for (const [key, entry] of authStateCache) if (entry.at < floor) authStateCache.delete(key)
    }
    return state
  }

  /** AUTH_MODE=password：Authorization: Bearer <jwt> → username */
  async function resolveByPassword(req) {
    const authHeader = String(req.headers.authorization || '')
    if (!authHeader.startsWith('Bearer ')) {
      throw Errors.unauthenticated('需要登录', { authMode: 'password' })
    }
    const token = authHeader.slice(7)
    const result = verifyToken(token, passwordSecret)
    if (!result) {
      throw Errors.unauthenticated('会话已过期或无效，请重新登录', { authMode: 'password' })
    }

    /**
     * 签名对了还不够 —— 还要问一句"这个令牌现在是不是还算数"。
     *
     * 没有这一段的话，JWT 是签出去就收不回来的：禁用一个账号只挡住新登录，
     * 那个人手里的令牌能一直用到过期（默认 24 小时）；改密码同理。
     * 也就是说"把某人踢下线"这个操作**根本不存在**，而管理台上看起来它成功了。
     *
     * 没接账号存储（某些单测）时跳过这一段，行为与从前一致。
     */
    const state = await currentAuthState(result.username)
    if (users) {
      // 账号被删了：令牌跟着失效，而不是变成一张认不出主人的通行证
      if (!state) throw Errors.unauthenticated('账号不存在，请重新登录', { authMode: 'password' })
      if (state.disabled) throw Errors.unauthenticated('该账号已被禁用', { authMode: 'password' })
      if (state.tokenVersion !== result.tokenVersion) {
        throw Errors.unauthenticated('登录状态已失效（密码已修改或账号被禁用过），请重新登录', { authMode: 'password' })
      }
    }

    return {
      username: result.username,
      user: { username: result.username, ...(state ? { role: state.role } : {}) },
      credential: '',
      credentialSource: 'Bearer token（password 模式）',
      verified: true,
      cached: false,
    }
  }

  return {
    resolve,
    navigationRedirect: () => '',
    loginUrlFor: () => '',
    readCredential: () => ({ credential: '', source: '无' }),
    clear: () => {},
    passwordUsers, passwordSecret,
    /**
     * 把某个人的账号状态缓存踢掉，让下一个请求重新读库。
     *
     * 改密 / 禁用 / 改角色的处理器改完之后要调一下 —— 否则本副本上最长会有
     * 一个 TTL 的时间窗，里面那个人还拿着旧状态在跑。**跨副本仍然靠 TTL 收敛**，
     * 这是进程内缓存的固有边界，不是这里漏了什么。
     */
    invalidateUser(username) {
      authStateCache.delete(String(username || ''))
    },
    /** 账号存储。HTTP 层的登录/注册/改密都从这里拿，避免各处再 import 一遍 */
    users,
  }
}
