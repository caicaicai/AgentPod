/**
 * 身份解析：把一次 HTTP 请求变成一个**服务端验证过的**主体 { username, credential }。
 *
 * 两种模式：
 *   password（推荐）：内置账号密码 + JWT 会话，Authorization: Bearer <token>。
 *   dev（仅本地）   ：信任 X-Username 头。config.js 会在 NODE_ENV=production 时拒绝启动。
 */
import { Errors } from '../errors.js'
import { parseUsers, verifyToken } from './password-auth.js'

export function createIdentityResolver({ config, logger }) {
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

  /** AUTH_MODE=password：Authorization: Bearer <jwt> → username */
  function resolveByPassword(req) {
    const authHeader = String(req.headers.authorization || '')
    if (!authHeader.startsWith('Bearer ')) {
      throw Errors.unauthenticated('需要登录', { authMode: 'password' })
    }
    const token = authHeader.slice(7)
    const result = verifyToken(token, passwordSecret)
    if (!result) {
      throw Errors.unauthenticated('会话已过期或无效，请重新登录', { authMode: 'password' })
    }
    return {
      username: result.username,
      user: { username: result.username },
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
  }
}
