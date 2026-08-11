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

export function signToken(username, secret, ttlSec) {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + ttlSec
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: username, iat: now, exp })).toString('base64url')
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
    return { username: data.sub }
  } catch {
    return null
  }
}
