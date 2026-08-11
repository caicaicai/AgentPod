/**
 * 结构化日志。与 agent service 同规则：**任何日志都不许打印凭据内容**。
 *
 * 沙盒这边还多一条：**绝不记录被执行的命令全文与输出内容**。
 * 命令行里常常直接带着用户数据（邮件正文、文档内容），把它们抄进日志
 * 等于在集群日志系统里复制一份用户隐私。只记长度与摘要。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const SECRET_KEY_PATTERN = /(cookie|token|secret|password|authorization|apikey|api_key|credential|command|stdout|stderr)/i

export function fingerprint(value) {
  const str = String(value ?? '')
  if (!str) return 'none'
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fp_${hash.toString(16)}_${str.length}b`
}

function redact(fields) {
  const out = {}
  for (const [key, value] of Object.entries(fields || {})) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = typeof value === 'string' ? fingerprint(value) : '[已脱敏]'
      continue
    }
    out[key] = value
  }
  return out
}

export function createLogger({ level = 'info', stream = process.stdout, base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info

  function emit(levelName, message, fields) {
    if ((LEVELS[levelName] ?? 0) < threshold) return
    stream.write(`${JSON.stringify({
      ts: new Date().toISOString(),
      level: levelName,
      msg: message,
      ...base,
      ...redact(fields),
    })}\n`)
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (childBase) => createLogger({ level, stream, base: { ...base, ...childBase } }),
  }
}
