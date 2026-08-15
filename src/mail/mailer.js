/**
 * 发信口。业务代码只认这一个接口，不认 SMTP。
 *
 * ── 为什么中间要隔一层 ──────────────────────────────────────────────────
 *
 * 1. **没配发信账号也要能起服务**。绝大多数部署不开注册验证码，那时候
 *    `enabled=false`，调用方据此决定"这条路走不走得通"，而不是等到发信时炸。
 * 2. **本地开发要看得见验证码**。`MAIL_TRANSPORT=log` 把信打进日志而不发出去，
 *    于是开发不用为了点一次注册去申请一个邮箱授权码。生产下这个值会被配置校验
 *    直接拒绝（见 config.js）—— 它等于把验证码交给每一个能看日志的人。
 * 3. **测试要能断言"发了什么"**。单测传一个假的 transport 进来就行，
 *    不必起 SMTP 服务器。
 *
 * ⚠️ 除了 log 传输，**任何日志都不许带验证码原文**。这是这个文件里唯一
 * 不能商量的一条：验证码是一次性凭据，进了日志就等于进了日志平台、
 * 进了备份、进了所有能查日志的人的视野。
 */
import { sendMail } from './smtp.js'

/**
 * @param {object} params
 * @param {object} params.config 全量配置，取 config.mail
 * @param {(mail) => Promise<any>} [params.transport] 覆盖真实发信。**只给测试用**
 */
export function createMailer({ config, logger = console, transport = null }) {
  const mail = config.mail || {}
  const useLog = mail.transport === 'log'
  /**
   * 能不能发信。注入了 transport（测试）或走 log 传输时恒为 true；
   * 真发信则要求至少有服务器地址和发件人 —— 少一个都发不出去，
   * 与其在运行时抛，不如让调用方一开始就知道这条路是关的。
   */
  const enabled = Boolean(transport) || useLog || Boolean(mail.host && mail.from)

  async function send({ to, subject, text = '', html = '' }) {
    if (!enabled) throw new Error('本部署没有配置发信账号（MAIL_SMTP_HOST / MAIL_FROM）')
    if (transport) return transport({ to, subject, text, html })
    if (useLog) {
      // 只有这一处允许带正文（也就带上了验证码），理由见文件头
      logger.warn?.('[MAIL_TRANSPORT=log] 邮件没有真的发出去', { to, subject, text })
      return { ok: true, logged: true }
    }
    return sendMail({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      user: mail.user,
      pass: mail.pass,
      from: mail.from,
      fromName: mail.fromName,
      to,
      subject,
      text,
      html,
      timeoutMs: mail.timeoutMs,
      rejectUnauthorized: mail.rejectUnauthorized,
    })
  }

  return {
    enabled,
    transport: transport ? 'custom' : mail.transport,
    send,

    /**
     * 注册验证码。
     *
     * 信里**不放链接**，只放一串数字。一次性链接要么带着令牌（那就是把凭据
     * 交给邮件网关的预取器 —— 不少企业邮箱会替用户点开每一个链接，那一点就
     * 把账号激活了），要么还得再回来填一次，那还不如一开始就填数字。
     */
    async sendActivationCode({ to, username, code, ttlMinutes, brand = 'AgentPod' }) {
      const subject = `${brand} 注册验证码：${code}`
      const text = [
        `你好 ${username}，`,
        '',
        `你的 ${brand} 注册验证码是：${code}`,
        `验证码 ${ttlMinutes} 分钟内有效，只能用一次。`,
        '',
        '如果这不是你本人的操作，忽略这封邮件即可 —— 没有验证码，这个账号不会被激活。',
      ].join('\n')
      const html = [
        '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;font-size:15px;line-height:1.7;color:#1f2328">',
        `<p>你好 ${escapeHtml(username)}，</p>`,
        `<p>你的 ${escapeHtml(brand)} 注册验证码是：</p>`,
        `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:20px 0">${escapeHtml(code)}</p>`,
        `<p>验证码 ${Number(ttlMinutes)} 分钟内有效，只能用一次。</p>`,
        '<p style="color:#656d76;font-size:13px">如果这不是你本人的操作，忽略这封邮件即可 —— 没有验证码，这个账号不会被激活。</p>',
        '</div>',
      ].join('')
      return send({ to, subject, text, html })
    },
  }
}

/** 用户名会原样进 HTML 正文。它的字符集本来就不含 `<`，但别把这条依赖留给下一个改字符集的人 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}
