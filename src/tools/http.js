/**
 * 进程内工具的出站 HTTP。
 *
 * 直接使用 Node.js 原生 fetch，不再经过 Cloud Bridge 的 egress 引擎。
 * 返回体形状与之前保持一致：`{ok, status, statusText, headers, body, truncated, url}`。
 */
import { Errors } from '../errors.js'

const DEFAULT_HEADERS = Object.freeze({ 'x-api-from': 'ap' })
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding'])

const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

function normalizeHeaders(headers) {
  const out = { ...DEFAULT_HEADERS }
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === null || value === undefined) continue
    if (FORBIDDEN_HEADERS.has(String(key).toLowerCase())) continue
    out[String(key)] = String(value)
  }
  return out
}

function encodeBody({ body, bodyEncoding, form }, headers) {
  if (form) {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    return Buffer.from(form, 'utf8')
  }
  if (body === null || body === undefined) return null
  const encoding = String(bodyEncoding || (typeof body === 'object' ? 'json' : 'utf8')).toLowerCase()
  if (encoding === 'json') {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
    }
    return Buffer.from(JSON.stringify(body), 'utf8')
  }
  if (encoding === 'base64') return Buffer.from(String(body), 'base64')
  return Buffer.from(String(body), 'utf8')
}

function sanitizeResponseHeaders(raw) {
  const out = {}
  const skip = new Set(['set-cookie', 'set-cookie2'])
  for (const [key, value] of Object.entries(raw || {})) {
    if (skip.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

export function createToolHttp({ logger, runId, username }) {
  async function request(spec) {
    const {
      url,
      method = 'GET',
      headers: rawHeaders,
      responseType = 'json',
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxBytes = DEFAULT_MAX_BYTES,
      followRedirects = true,
    } = spec

    if (!url) throw Errors.badRequest('工具出站请求缺少 url')

    const headers = normalizeHeaders(rawHeaders)
    const body = encodeBody(spec, headers)
    const startedAt = Date.now()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response
    try {
      response = await fetch(url, {
        method: String(method).toUpperCase(),
        headers,
        body,
        signal: controller.signal,
        redirect: followRedirects ? 'follow' : 'manual',
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw Errors.timeout(`工具出站请求超时（${timeoutMs}ms）`)
      }
      throw Errors.upstream(`工具出站请求失败：${error?.message || error}`)
    } finally {
      clearTimeout(timer)
    }

    const chunks = []
    let size = 0
    let truncated = false
    try {
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > maxBytes) {
          truncated = true
          break
        }
        chunks.push(chunk)
      }
    } catch {
      // body 读取中断不算致命错误，已读到的部分照常返回
    }
    const buffer = Buffer.concat(chunks)

    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      host = '?'
    }
    logger.info?.('工具出站', { runId, username, method, host, status: response.status, durationMs: Date.now() - startedAt })

    const text = buffer.toString('utf8')
    let parsed = text
    if (responseType === 'json') {
      try {
        parsed = text.length ? JSON.parse(text) : null
      } catch {
        parsed = text
      }
    } else if (responseType === 'base64') {
      parsed = buffer.toString('base64')
    }

    const resHeaders = {}
    response.headers.forEach((value, key) => { resHeaders[key] = value })

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeResponseHeaders(resHeaders),
      body: parsed,
      truncated,
      url: response.url || url,
    }
  }

  return {
    request,
    get: (url, options = {}) => request({ ...options, url, method: 'GET' }),
    post: (url, body, options = {}) => request({ ...options, url, method: 'POST', body }),
    put: (url, body, options = {}) => request({ ...options, url, method: 'PUT', body }),
    delete: (url, options = {}) => request({ ...options, url, method: 'DELETE' }),
  }
}
