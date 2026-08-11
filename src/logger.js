/**
 * 结构化日志。
 *
 * 铁律：**任何日志都不许打印凭据内容**（cookie、llmToken、Authorization、me_token…），
 * 只能打长度或指纹。所以这里提供 fingerprint()，并在 serialize 时兜底脱敏。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

const SECRET_KEY_PATTERN = /(cookie|token|secret|password|authorization|apikey|api_key|credential)/i
// 常见凭据形态：me_token=xxx / Bearer xxx
const SECRET_VALUE_PATTERN = /((?:me_token|iam_token|token|Authorization|Bearer)\s*[=:]?\s*)([A-Za-z0-9._\-+/=]{8,})/gi

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

function redactValue(value) {
  if (typeof value !== 'string') return value
  return value.replace(SECRET_VALUE_PATTERN, (_m, prefix) => `${prefix}[已脱敏]`)
}

function redact(fields) {
  const out = {}
  for (const [key, value] of Object.entries(fields || {})) {
    if (SECRET_KEY_PATTERN.test(key)) {
      // 键名一看就是凭据 —— 只留指纹，绝不留值
      out[key] = typeof value === 'string' ? fingerprint(value) : '[已脱敏]'
      continue
    }
    out[key] = typeof value === 'string' ? redactValue(value) : value
  }
  return out
}

export function createLogger({ level = 'info', stream = process.stdout, base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info

  function emit(levelName, message, fields) {
    if ((LEVELS[levelName] ?? 0) < threshold) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: levelName,
      msg: message,
      ...base,
      ...redact(fields),
    })
    stream.write(`${line}\n`)
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    /** 派生带固定字段的子 logger（例如整条 run 都带 runId / username） */
    child: (childBase) => createLogger({ level, stream, base: { ...base, ...childBase } }),
  }
}
