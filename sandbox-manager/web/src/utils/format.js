export function relativeTime(ts) {
  const delta = Date.now() - ts
  if (delta < 2000) return '刚刚'
  if (delta < 60000) return `${Math.round(delta / 1000)} 秒前`
  if (delta < 3600000) return `${Math.round(delta / 60000)} 分钟前`
  return `${Math.round(delta / 3600000)} 小时前`
}

export function duration(ms) {
  if (ms === undefined || ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}h`
  return `${Math.round(ms / 86400000)}d`
}

export function percent(value) {
  return `${Math.round(value * 100)}%`
}

/**
 * 节点被排除的原因 → 人话。
 *
 * 后端返回的是稳定的机器标识（pool / draining / full / caps:browser …），
 * 翻译放在前端而不是后端：那些标识同时进日志和接口，改成中文会让日志
 * 检索跟着一起变，得不偿失。
 */
const REASONS = {
  pool: '不在目标资源池',
  draining: '已摘除',
  unhealthy: '节点自报不健康',
  full: '槽位已满',
  'no-capacity': '未上报容量',
  missing: '注册表里没有明细',
  unknown: '未知',
}

/**
 * base64 ↔ 文本。
 *
 * 不能直接 btoa(str)：btoa 只接受 latin1，中文会抛 InvalidCharacterError。
 * 必须先按 UTF-8 编码成字节。
 */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export function fromBase64(b64) {
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** 解析节点 exec 回的 NDJSON。坏行跳过而不是整体失败 —— 流被截断时前面的输出仍然有用。 */
export function parseNdjson(text) {
  const frames = []
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      frames.push(JSON.parse(trimmed))
    } catch {
      frames.push({ type: 'stderr', data: `[无法解析的帧] ${trimmed}\n` })
    }
  }
  return frames
}

export function explainReason(why) {
  if (!why) return '—'
  if (why.startsWith('caps:')) return `缺少能力：${why.slice(5)}`
  return REASONS[why] || why
}
