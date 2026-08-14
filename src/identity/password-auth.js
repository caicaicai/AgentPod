/**
 * 内置账号密码认证。
 *
 * 用户名:密码对 通过 CONSOLE_USERS 环境变量配置（逗号分隔），
 * 登录后签发 HS256 JWT，后续请求通过 Authorization: Bearer 带上。
 *
 * password 模式只提供**身份认定**（"你是谁"），credential 为空。
 * 适用于 LLM_MODE=direct 或 LLM_MODE=faux 的独立部署。
 */
import crypto from 'node:crypto'

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * 解析 CONSOLE_USERS 环境变量。
 *
 * 格式：`user1:pass1,user2:pass2`。密码里可以有冒号（第一个冒号之后的全部算密码），
 * 不允许逗号（它是分隔符）。
 */
export function parseUsers(raw) {
  const users = new Map()
  for (const pair of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = pair.indexOf(':')
    if (sep < 0) continue
    const username = pair.slice(0, sep).trim()
    const password = pair.slice(sep + 1)
    if (!username || !password) continue
    if (!USERNAME_RE.test(username)) continue
    users.set(username, password)
  }
  return users
}

/**
 * 常量时间密码比较。
 *
 * HMAC 归一化长度：直接比原文时，长度不同要先判 length（暴露差异信息），
 * 哈希一遍之后两边永远 32 字节，timingSafeEqual 直接比。
 */
export function validateCredentials(users, username, password) {
  const expected = users.get(username)
  if (!expected) {
    hmacDigest(password)
    hmacDigest('dummy')
    return false
  }
  return crypto.timingSafeEqual(hmacDigest(password), hmacDigest(expected))
}

function hmacDigest(value) {
  return crypto.createHmac('sha256', 'credential-compare').update(value).digest()
}

/**
 * 签发。
 *
 * `ver` 是**令牌代数**（账号记录里的 tokenVersion）：改密码或禁用账号会把它
 * 推一格，于是这之前签出去的令牌在下一次请求时就对不上号了。没有它的话，
 * JWT 是纯无状态的 —— 签出去就收不回来，"改密码"和"禁用某人"都只能等它过期
 * （默认 24 小时）。见 src/identity/index.js 的校验那一侧。
 */
export function signToken(username, secret, ttlSec, tokenVersion = 0) {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + ttlSec
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    sub: username, iat: now, exp, ver: Number(tokenVersion) || 0,
  })).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return { token: `${header}.${payload}.${sig}`, expiresAt: exp * 1000 }
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts

  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (typeof data.sub !== 'string' || !data.sub) return null
    if (typeof data.exp === 'number' && data.exp < Math.floor(Date.now() / 1000)) return null
    if (!USERNAME_RE.test(data.sub)) return null
    /**
     * 老令牌（这个功能上线之前签的）没有 ver 字段，当 0 —— 与账号记录里
     * 缺字段时当 0 对上，于是升级当天没有人被踢下线。
     */
    return { username: data.sub, tokenVersion: Number(data.ver) || 0 }
  } catch {
    return null
  }
}
