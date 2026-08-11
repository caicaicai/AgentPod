/**
 * 短期票据校验。签发端是 `sandbox-manager/modules/ticket.lua`，
 * **两边的编码必须逐字节一致**，否则现象是"调度成功但所有租约申请 401"，
 * 而两边各自的日志看起来都正常。协议见 sandbox-manager/docs/PROTOCOL.md §1。
 *
 * 格式：base64url(payload_json) + "." + base64url(hmac_sha256(secret, payload_b64))
 * 注意 HMAC 算的是**已经 base64url 编码过的 payload 字符串**，不是原始 JSON ——
 * 先编码后签名，校验时就不需要复现一次 JSON 序列化（键顺序、空格、Unicode
 * 转义在两种语言里都不可能保证一致，拿重新序列化的结果去验签必然失败）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** base64url 的两个字符是 `-` 和 `_`，正好都不是正则元字符里需要转义的 */
const TOKEN_SHAPE = /^([A-Za-z0-9\-_]+)\.([A-Za-z0-9\-_]+)$/

/**
 * 校验一张票据。
 *
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 *   reason 是给日志用的稳定标识；**不要**把它原样回给调用方 ——
 *   "签名不对"和"不是签给本节点的"这种区分能帮攻击者定位问题，
 *   对外一律 401 + unauthorized。
 */
export function verifyTicket({ token, secret, nodeId, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'no-secret-configured' }
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' }

  const shape = TOKEN_SHAPE.exec(token)
  if (!shape) return { ok: false, reason: 'malformed' }
  const [, body, signature] = shape

  const expected = base64url(createHmac('sha256', secret).update(body).digest())
  // 定长比较：长度不同时 timingSafeEqual 会直接抛，先自己挡一道
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad-signature' }
  }

  let payload
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return { ok: false, reason: 'bad-payload' }
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad-payload' }

  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    return { ok: false, reason: 'expired' }
  }
  if (nodeId && payload.nid !== nodeId) {
    return { ok: false, reason: 'wrong-node' }
  }
  if (typeof payload.username !== 'string' || !payload.username) {
    return { ok: false, reason: 'missing-username' }
  }
  return { ok: true, payload }
}

/**
 * 票据的用途。签在载荷里，所以改不了。
 *
 * `lease` 换租约（今天所有票据的用途），`admin` 调运维接口（看占用、杀占用）。
 * **两者互斥，不是包含关系。** 管理台的运维票据不能拿去占一个槽位，
 * 调用方的租约票据也不能拿去杀别人的租约。写成"admin 包含 lease"看着更方便，
 * 但那等于让一个只该"看和杀"的凭据顺便获得了执行权限。
 *
 * 字段缺席按 `lease` 处理 —— 这是老 manager 签出来的票据的样子，
 * 不能因为升级顺序把所有正常调度打断。
 */
export function ticketScope(payload) {
  const raw = payload?.scp
  return raw === 'admin' ? 'admin' : 'lease'
}

/**
 * 一次性校验：同一张票据只能换一次租约。
 *
 * 表的规模是「票据 TTL 窗口内的租约申请数」，60 秒的窗口下可以忽略。
 * 惰性清理就够了，不需要定时器 —— 每次记录时顺手扫一遍已过期的。
 *
 * **重启会丢掉这张表**，重启后旧票据可能被重放一次。可接受：重放的后果只是
 * 多占一个槽位，且票据本身 60 秒内就过期。为这点风险引入外部存储不值得。
 */
export function createTicketGuard() {
  const seen = new Map() // jti -> exp(ms)

  return {
    /** @returns true 表示这张票据没用过（并已记下）；false 表示重放 */
    claim(jti, exp, now = Date.now()) {
      if (typeof jti !== 'string' || !jti) return false
      if (seen.has(jti)) return false

      if (seen.size > 64) {
        for (const [key, expiresAt] of seen) {
          if (expiresAt <= now) seen.delete(key)
        }
      }
      seen.set(jti, exp)
      return true
    },
    size: () => seen.size,
  }
}

export const _internal = { base64url }
