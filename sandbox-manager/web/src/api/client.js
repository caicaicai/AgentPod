/**
 * 管理台 API 客户端。
 *
 * 认证方式：JWT Bearer token。
 * 用户通过 /login 接口获取 token，前端存入 localStorage 并在每次请求中
 * 通过 Authorization: Bearer 头发送。管理台单独走 /ui/* 而不是复用
 * /api/v1/sandbox/nodes 那批 require_security_code 接口。
 */

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN || ''
const API_PREFIX = import.meta.env.VITE_API_PREFIX ?? ''

const BASE = `${API_ORIGIN}${API_PREFIX}/api/v1/sandbox/ui`

/** dev 默认打假后端；`npm run dev:live` 才连真的；生产构建永远是真的。 */
export const USE_MOCK = import.meta.env.DEV && import.meta.env.MODE !== 'live'

const TOKEN_KEY = 'sandbox-manager-token'
const TOKEN_EXPIRES_KEY = 'sandbox-manager-token-expires'

export function getToken() {
  const token = localStorage.getItem(TOKEN_KEY)
  const expires = Number(localStorage.getItem(TOKEN_EXPIRES_KEY) || '0')
  if (!token || (expires && Date.now() > expires)) {
    clearToken()
    return null
  }
  return token
}

export function setToken(token, expiresAt) {
  localStorage.setItem(TOKEN_KEY, token)
  if (expiresAt) localStorage.setItem(TOKEN_EXPIRES_KEY, String(expiresAt))
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(TOKEN_EXPIRES_KEY)
}

/** 会话失效。UI 捕获它去提示重新登录，而不是把 401 混在普通错误里。 */
export class SessionExpiredError extends Error {
  constructor() {
    super('登录态已失效')
    this.name = 'SessionExpiredError'
  }
}

export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

let mockPromise = null
function mock() {
  if (!mockPromise) mockPromise = import('./mock.js').then((m) => m.createMockBackend())
  return mockPromise
}

async function request(path, { method = 'GET', body, query } = {}) {
  if (USE_MOCK) return (await mock()).handle(path, { method, body, query })

  const url = new URL(BASE + path, window.location.origin)
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
  }

  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    throw new ApiError(`网络错误：${error.message}`, { code: 'network' })
  }

  if (res.status === 401) {
    clearToken()
    throw new SessionExpiredError()
  }

  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    clearToken()
    throw new SessionExpiredError()
  }

  const payload = await res.json().catch(() => null)
  if (!res.ok || !payload || payload.ok === false) {
    throw new ApiError(payload?.message || payload?.error || `请求失败（HTTP ${res.status}）`, {
      status: res.status,
      code: payload?.error,
    })
  }
  return payload
}

/**
 * 登录接口（不走 request —— 登录时还没有 token）。
 */
export async function login(username, password) {
  const url = `${API_ORIGIN}${API_PREFIX}/api/v1/sandbox/ui/login`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const payload = await res.json().catch(() => null)
  if (!res.ok || !payload || !payload.ok) {
    throw new ApiError(payload?.message || '登录失败', {
      status: res.status,
      code: payload?.error,
    })
  }
  setToken(payload.token, payload.expiresAt)
  return { username: payload.username }
}

export function logout() {
  clearToken()
}

export const api = {
  whoami: () => request('/whoami'),
  nodes: (pool) => request('/nodes', { query: { pool } }),
  config: () => request('/config'),
  simulate: (payload) => request('/simulate', { method: 'POST', body: payload }),
  drain: (nodeId, drained, reason) =>
    request('/drain', { method: 'POST', body: { nodeId, drained, reason } }),
  evict: (nodeId) => request('/evict', { method: 'POST', body: { nodeId } }),
  occupancy: (nodeId) => request('/occupancy', { query: { nodeId } }),
  kill: (nodeId, leaseId) => request('/kill', { method: 'POST', body: { nodeId, leaseId } }),
  sandboxOpen: (nodeId) => request('/sandbox/open', { method: 'POST', body: { nodeId } }),
  sandboxCall: (sessionId, op, payload) =>
    request('/sandbox/call', { method: 'POST', body: { sessionId, op, payload } }),
  sandboxClose: (sessionId) => request('/sandbox/close', { method: 'POST', body: { sessionId } }),
}
