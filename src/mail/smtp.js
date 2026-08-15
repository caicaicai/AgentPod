/**
 * 一个刚好够用的 SMTP 客户端。
 *
 * ── 为什么不装 nodemailer ──────────────────────────────────────────────
 *
 * 这个服务的运行时依赖只有 pi 那两个包（见 package.json 的取舍）。我们要发的
 * 是一封纯文本 + HTML 的通知信，用到的是 SMTP 里最老实的那几条命令：
 * EHLO / STARTTLS / AUTH / MAIL FROM / RCPT TO / DATA。为这些引入一棵新的
 * 依赖树，换来的是一份要长期跟着升级的攻击面。
 *
 * ── 这里**没有**实现什么 ───────────────────────────────────────────────
 *
 * 连接池、重试、队列、DKIM 签名、附件、多收件人。都不做，因为今天唯一的调用方
 * 是"注册验证码"：一次一封、失败就当场告诉用户重发。哪天要发第二种信之前，
 * 先问的应该是"是不是该交给专门的发信服务"，而不是把这个文件写大。
 *
 * ── 协议上容易写错的两处 ───────────────────────────────────────────────
 *
 *   1. **多行应答**。`250-SIZE` 后面还有，`250 SIZE` 才是最后一行 —— 判据是
 *      三位数字后面跟的是空格还是连字符。只读第一行的实现会在 EHLO 之后
 *      把剩下的能力行当成下一条命令的应答，于是整个对话错位一格。
 *   2. **DATA 的结束标记**是单独一行 `.`，因此正文里任何以 `.` 开头的行都要
 *      再补一个点（dot-stuffing）。我们的正文一律 base64，天然不会出现这种行，
 *      但 buildMessage() 仍然做了这一步 —— 它是个通用函数，下一个调用方
 *      未必记得这条。
 */
import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'

/**
 * 把一个 socket 包成"发一条命令、等一个应答"的对话通道。
 *
 * 应答是异步来的、可能被 TCP 切成任意块，所以这里自己缓冲、自己判断一条应答
 * 到哪儿算完，而不是假设"一次 data 事件 = 一条应答"（那在慢链路上必然出错）。
 */
function createChannel(socket, timeoutMs) {
  let buffer = ''
  /** 已经收完、还没人来取的应答 */
  const ready = []
  /** 已经在等、还没等到应答的读取方 */
  const waiting = []
  let failure = null

  function fail(error) {
    if (failure) return
    failure = error
    while (waiting.length) waiting.shift().reject(error)
  }

  /** 从缓冲里切出一条完整应答；不完整就回 null，等下一块数据 */
  function takeReply() {
    const lines = buffer.split('\r\n')
    // 最后一段是还没收到换行的残片，永远不参与判断
    for (let i = 0; i < lines.length - 1; i += 1) {
      // 终止行：三位数字后面是空格（或什么都没有），连字符表示"后面还有"
      if (!/^\d{3}([ ]|$)/.test(lines[i])) continue
      const used = lines.slice(0, i + 1)
      buffer = lines.slice(i + 1).join('\r\n')
      return { code: Number(used[used.length - 1].slice(0, 3)), text: used.join('\n') }
    }
    return null
  }

  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const reply = takeReply()
      if (!reply) break
      if (waiting.length) waiting.shift().resolve(reply)
      else ready.push(reply)
    }
  })
  socket.on('error', (error) => fail(error))
  // 对端在对话中途关掉连接：等应答的那一方必须醒过来，否则这次发信会一直挂着
  socket.on('close', () => fail(new Error('SMTP 连接被对端关闭')))
  socket.setTimeout(timeoutMs, () => {
    fail(new Error(`SMTP 超时（${timeoutMs}ms 内没有应答）`))
    socket.destroy()
  })

  return {
    read() {
      if (ready.length) return Promise.resolve(ready.shift())
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
    },
    write(line) {
      if (failure) throw failure
      socket.write(`${line}\r\n`)
    },
    /** 缓冲里还没被消费掉的部分。STARTTLS 升级时要交接给新通道 */
    rest() {
      return buffer
    },
  }
}

/** 发一条命令并断言应答码。不在期望里就抛，把对端的原话带上 —— 那是排查发信问题唯一有用的东西 */
async function command(channel, line, expected, { secret = false } = {}) {
  channel.write(line)
  const reply = await channel.read()
  if (!expected.includes(reply.code)) {
    // 认证那两行是 base64 的账号密码，**绝不能进报错信息**
    const shown = secret ? '<hidden>' : line
    throw new Error(`SMTP 命令失败：${shown} → ${reply.text}`)
  }
  return reply
}

function connectPlain({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => resolve(socket))
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`连接 ${host}:${port} 超时`)) })
    socket.once('error', reject)
  })
}

function upgradeTls({ socket, host, rejectUnauthorized, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized })
    secure.setTimeout(timeoutMs)
    secure.once('secureConnect', () => resolve(secure))
    secure.once('timeout', () => { secure.destroy(); reject(new Error('TLS 握手超时')) })
    secure.once('error', reject)
  })
}

/** RFC 2047：信头里的非 ASCII 必须编码，否则中文标题在多数客户端上是一串乱码 */
export function encodeHeaderWord(value) {
  const text = String(value ?? '')
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/** `名字 <a@b.c>`。名字为空就只回地址 —— 别留下一个空的尖括号前缀 */
function formatAddress(address, name) {
  if (!name) return address
  return `${encodeHeaderWord(name)} <${address}>`
}

/** base64 正文按 76 列折行（RFC 2045）。不折的话，长行会被某些中继自行截断 */
function base64Body(text) {
  return (Buffer.from(String(text ?? ''), 'utf8').toString('base64').match(/.{1,76}/g) || ['']).join('\r\n')
}

/**
 * 拼出一封信的完整报文（信头 + 正文）。
 *
 * 纯函数，不碰网络 —— 于是"信长什么样"可以被单测直接断言，
 * 而不需要在测试里起一个 SMTP 服务器。
 */
export function buildMessage({ from, fromName = '', to, subject, text = '', html = '', date = new Date(), messageId = '' }) {
  const id = messageId || `<${randomBytes(12).toString('hex')}@${String(from).split('@')[1] || 'localhost'}>`
  const headers = [
    `From: ${formatAddress(from, fromName)}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
  ]

  let body
  if (text && html) {
    /**
     * 两份都给：纯文本给命令行邮件客户端和读屏软件，HTML 给其余。
     * 只发 HTML 的信在不少反垃圾评分里是要扣分的。
     */
    const boundary = `--=_${randomBytes(12).toString('hex')}`
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(html),
      `--${boundary}--`,
    ].join('\r\n')
  } else {
    headers.push(`Content-Type: text/${html ? 'html' : 'plain'}; charset=UTF-8`)
    headers.push('Content-Transfer-Encoding: base64')
    body = base64Body(html || text)
  }

  // dot-stuffing：以 `.` 开头的行会被当成 DATA 的结束标记，见文件头第 2 点
  return `${headers.join('\r\n')}\r\n\r\n${body}`.replace(/\r?\n\./g, '\r\n..')
}

/**
 * 发一封信。
 *
 * @param {object} params
 * @param {boolean} params.secure true = 连上就是 TLS（465）；false = 明文连上后
 *   走 STARTTLS 升级（587）。**服务端不支持 STARTTLS 时直接失败**，
 *   不悄悄用明文继续 —— 那会让账号密码和验证码裸奔在网上，而调用方以为加密了。
 */
export async function sendMail({
  host, port, secure = true, user = '', pass = '',
  from, fromName = '', to, subject, text = '', html = '',
  timeoutMs = 15000, rejectUnauthorized = true,
}) {
  if (!host) throw new Error('未配置 SMTP 服务器地址')
  if (!from) throw new Error('未配置发件人地址')
  if (!to) throw new Error('收件人不能为空')

  let socket = await connectPlain({ host, port, timeoutMs })
  if (secure) socket = await upgradeTls({ socket, host, rejectUnauthorized, timeoutMs })
  let channel = createChannel(socket, timeoutMs)

  try {
    const greeting = await channel.read()
    if (greeting.code !== 220) throw new Error(`SMTP 服务端拒绝连接：${greeting.text}`)

    // 用发件域名做 EHLO 参数：不少服务商会拿它做基本的合规检查
    const helo = `EHLO ${String(from).split('@')[1] || 'localhost'}`
    let ehlo = await command(channel, helo, [250])

    if (!secure) {
      if (!/\bSTARTTLS\b/i.test(ehlo.text)) {
        throw new Error('SMTP 服务端不支持 STARTTLS，而明文发信会让账号密码和验证码裸奔；请改用 465 端口（MAIL_SMTP_SECURE=1）')
      }
      await command(channel, 'STARTTLS', [220])
      if (channel.rest()) throw new Error('STARTTLS 之前收到了多余数据，可能存在中间人') // RFC 3207 要求丢弃并中止
      socket = await upgradeTls({ socket, host, rejectUnauthorized, timeoutMs })
      channel = createChannel(socket, timeoutMs)
      // 升级之后必须重新 EHLO：加密前后的能力清单是两回事（AUTH 常常只在加密后宣告）
      ehlo = await command(channel, helo, [250])
    }

    if (user) {
      /**
       * AUTH LOGIN 与 AUTH PLAIN 都是"把账号密码 base64 一下"，没有强弱之分 ——
       * 挑哪个只看对端宣告了哪个。两个都没有就直接报错，而不是跳过认证：
       * 跳过的表现是"发信成功但对方没收到"（多数服务商会静默丢弃未认证的信）。
       */
      if (/\bAUTH\b[^\n]*\bPLAIN\b/i.test(ehlo.text)) {
        const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')
        await command(channel, `AUTH PLAIN ${token}`, [235], { secret: true })
      } else if (/\bAUTH\b[^\n]*\bLOGIN\b/i.test(ehlo.text)) {
        await command(channel, 'AUTH LOGIN', [334])
        await command(channel, Buffer.from(user, 'utf8').toString('base64'), [334], { secret: true })
        await command(channel, Buffer.from(pass, 'utf8').toString('base64'), [235], { secret: true })
      } else {
        throw new Error('SMTP 服务端没有宣告 AUTH PLAIN / AUTH LOGIN，无法用账号密码发信')
      }
    }

    await command(channel, `MAIL FROM:<${from}>`, [250])
    await command(channel, `RCPT TO:<${to}>`, [250, 251])
    await command(channel, 'DATA', [354])
    channel.write(buildMessage({ from, fromName, to, subject, text, html }))
    await command(channel, '.', [250])
    // QUIT 失败不算失败：信已经被对端收下了（250），这时候再抛错只会让调用方
    // 以为没发出去，然后重发一封一模一样的
    await command(channel, 'QUIT', [221]).catch(() => {})
  } finally {
    socket.destroy()
  }

  return { ok: true }
}
