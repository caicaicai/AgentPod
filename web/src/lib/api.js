/**
 * 后端接口封装。
 *
 * 身份：
 *   - AUTH_MODE=password 时前端通过登录框获取 JWT，后续请求带 Authorization 头；
 *   - AUTH_MODE=dev 时后端信任 `X-Username` 头，界面上那个输入框就是喂它的。
 * 两种模式下都不会有凭据落到前端。
 *
 * 未登录时后端回 401，password 模式弹登录框，见下面 handleUnauthorized()。
 */

const DEV_USERNAME_KEY = 'ap.devUsername'
const AUTH_TOKEN_KEY = 'ap.authToken'

const SSO_RETRY_PARAM = 'sso_retry'

let redirecting = false

/** 界面别的地方据此把"报错"换成"正在跳转"的说法 */
export function isRedirectingToLogin() {
  return redirecting
}

/**
 * 登录成功之后把地址栏上的标记抹掉。
 *
 * 不抹的话它会一直留在 URL 里，于是**下一次**登录态过期时前端会以为
 * "已经试过一次了"而拒绝跳转，只给用户看一条错误 —— 明明重新登录就能好。
 * 用 replaceState 是为了不往历史里塞一条记录（用户按返回键不该回到带标记的地址）。
 */
export function clearSsoRetryMarker() {
  const url = new URL(location.href)
  if (!url.searchParams.has(SSO_RETRY_PARAM)) return
  url.searchParams.delete(SSO_RETRY_PARAM)
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

/** password 模式下 401 时由前端弹登录框，不跳 SSO */
let needLoginCallback = null

export function onNeedLogin(callback) {
  needLoginCallback = callback
}

/**
 * 401 时弹出前端登录框（password 模式）。
 */
function handleUnauthorized(status, payload) {
  if (status !== 401 || redirecting) return ''

  // password 模式：清掉过期 token，通知前端弹登录框
  if (payload?.details?.authMode === 'password') {
    setAuthToken('')
    needLoginCallback?.()
    return '需要登录'
  }

  const loginUrl = payload?.details?.loginUrl
  if (!loginUrl) return ''
  if (new URLSearchParams(location.search).has(SSO_RETRY_PARAM)) {
    // 刚从 SSO 回来就又 401，说明不是"没登录"而是别的问题（票验不过、
    // Cookie 没到服务端…）。这时候必须把真实原因显示出来，再跳一次只会转圈。
    return ''
  }
  redirecting = true
  location.replace(loginUrl)
  return '登录态已失效，正在跳转到登录页…'
}

export function getDevUsername() {
  return localStorage.getItem(DEV_USERNAME_KEY) || ''
}

export function setDevUsername(username) {
  if (username) localStorage.setItem(DEV_USERNAME_KEY, username)
  else localStorage.removeItem(DEV_USERNAME_KEY)
}

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || ''
}

export function setAuthToken(token) {
  if (token) localStorage.setItem(AUTH_TOKEN_KEY, token)
  else localStorage.removeItem(AUTH_TOKEN_KEY)
}

function headers(extra = {}) {
  const result = { ...extra }
  const devUser = getDevUsername()
  if (devUser) result['X-Username'] = devUser
  const token = getAuthToken()
  if (token) result['Authorization'] = `Bearer ${token}`
  return result
}

/**
 * 后端出错时的响应体是 `{ code, message, requestId }`。
 * 把这三样都带进 Error：用户来问某条报错时，凭 requestId 就能在日志里定位到那次请求。
 */
export class ApiError extends Error {
  constructor(message, { code = '', status = 0, requestId = '', details = null, redirecting = false } = {}) {
    super(message)
    this.code = code
    this.status = status
    this.requestId = requestId
    this.details = details
    /** 正在跳登录页 —— 界面不该把它当成一次真的失败 */
    this.redirecting = redirecting
  }
}

/**
 * 最近的请求问题，给「复制调试信息」用。
 *
 * 只记**形状**：方法、路径、状态码、错误码、消息、requestId、traceId。
 * **不记请求体也不记响应体** —— 那里面是用户的对话内容，会话正文该由调试信息里
 * 专门那一节按原样带上（用户自己知道自己在分享什么），不该在这里再偷偷存一份。
 *
 * requestId / traceId 是最有用的两个：拿它们能直接去服务端日志里定位这一次请求。
 */
const MAX_EVENTS = 20
const recentEvents = []

function recordEvent(entry) {
  recentEvents.push({ at: Date.now(), ...entry })
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift()
}

export function getRecentEvents() {
  return recentEvents.slice()
}

/**
 * 最近一次流式对话的**节奏**：每一帧是什么时候到的。
 *
 * ── 为什么要记 ────────────────────────────────────────────────────────
 *
 * "感觉有点卡顿、说了半句就停住、然后一大段一起蹦出来"是最难查的一类反馈：
 * 卡在哪一段完全看不出来 —— 可能是上游模型/网关在憋（帧根本没来），
 * 也可能是帧来得好好的、浏览器没画出来。这两件事的修法南辕北辙，
 * 而只要有每帧的到达时刻，一眼就能分开：**帧之间有几秒空档 = 上游；
 * 帧密密麻麻但界面不动 = 渲染**。
 *
 * 只记**时刻和类型，不记内容**：正文该由调试信息里专门那一节按原样带上，
 * 不该在这里再偷偷存一份。
 *
 * 上限 4000 帧，到顶就**停止记录、保留最早的那些**（只记个溢出条数）。
 * 保留头部而不是尾部是有意的：这份记录是用来找"第一次不对劲发生在哪儿"的，
 * 而开头那段（首字延迟、前几十帧的节奏）恰恰是判断的依据。
 */
const MAX_TRACE_FRAMES = 4000
let streamTrace = null

export function getStreamTrace() {
  return streamTrace
}

/** 两处（普通请求 / SSE 流）用同一套 401 处理与记账，别各写一遍 */
function toApiError(response, payload, text, { method = 'GET', path = '' } = {}) {
  recordEvent({
    method,
    path,
    status: response.status,
    code: payload?.code || '',
    message: payload?.message || String(text || '').slice(0, 200),
    requestId: payload?.requestId || response.headers.get('x-request-id') || '',
    traceId: response.headers.get('x-trace-id') || '',
  })
  const redirectMessage = handleUnauthorized(response.status, payload)
  return new ApiError(redirectMessage || payload?.message || text || `HTTP ${response.status}`, {
    code: payload?.code || '',
    status: response.status,
    requestId: payload?.requestId || response.headers.get('x-request-id') || '',
    details: payload?.details || null,
    redirecting: Boolean(redirectMessage),
  })
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'include', // sso 模式全靠它把登录态 cookie 带上
    headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    // 不是 JSON（网关的错误页之类），把原文当消息
  }
  if (!response.ok) throw toApiError(response, payload, text, { method, path })
  return payload
}

const q = (params) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    // 空串是有意义的取值（projectId='' = 只要未分组的），只丢 undefined/null
    if (value === undefined || value === null) continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const api = {
  health: () => request('/healthz'),
  login: (username, password) => request('/v1/auth/login', { method: 'POST', body: { username, password } }),
  models: (refresh = false) => request(`/v1/models${refresh ? '?refresh=1' : ''}`),
  skills: () => request('/v1/skills'),

  listSessions: (params = {}) => request(`/v1/sessions${q(params)}`),
  getSession: (key) => request(`/v1/sessions/${encodeURIComponent(key)}`),
  renameSession: (key, title) => request(`/v1/sessions/${encodeURIComponent(key)}`, { method: 'PATCH', body: { title } }),
  /** 置顶 / 归档 / 改项目归属。与重命名同一个 PATCH，字段各取所需 */
  patchSession: (key, patch) => request(`/v1/sessions/${encodeURIComponent(key)}`, { method: 'PATCH', body: patch }),
  deleteSession: (key) => request(`/v1/sessions/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  /** 标题 + 正文全文搜索。与 listSessions 分开：它要读会话正文，比列表贵得多 */
  searchSessions: (keyword) => request(`/v1/search${q({ q: keyword })}`),

  listProjects: () => request('/v1/projects'),
  createProject: (body) => request('/v1/projects', { method: 'POST', body }),
  updateProject: (id, body) => request(`/v1/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteProject: (id) => request(`/v1/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getMemory: (projectId = '') => request(`/v1/memory${q({ projectId })}`),
  saveMemory: (projectId, content, revision) =>
    request(`/v1/memory${q({ projectId })}`, { method: 'PUT', body: { content, revision } }),

  /**
   * 作品。
   *
   * 详情**带正文**（预览要用），所以别拿它当清单刷 —— 清单接口是专门不带正文的。
   * 原文另有 `/v1/artifacts/:id/raw`，界面用不上（正文已经在详情里了，
   * 下载走 Blob，见 lib/artifact-view.js 的 downloadText）。
   */
  listArtifacts: (sessionKey = '') => request(`/v1/artifacts${q({ sessionKey })}`),
  getArtifact: (id, version = 0) => request(`/v1/artifacts/${encodeURIComponent(id)}${q({ v: version || undefined })}`),
  deleteArtifact: (id) => request(`/v1/artifacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listCrons: () => request('/v1/crons'),
  createCron: (body) => request('/v1/crons', { method: 'POST', body }),
  updateCron: (id, body) => request(`/v1/crons/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteCron: (id) => request(`/v1/crons/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runCron: (id) => request(`/v1/crons/${encodeURIComponent(id)}/run`, { method: 'POST' }),

  abort: (runId) => request(`/v1/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' }),
}

/**
 * 发起一轮对话，按帧回调。
 *
 * 用 fetch + ReadableStream 而不是 EventSource：EventSource 只能 GET，
 * 带不了请求体，也塞不了 X-Username 头。
 *
 * `attachments` 是 attachments.js 里 `toWire()` 出来的形状
 * （`{ name, mimeType, kind, size, data, text }`），服务端在 /v1/chat/stream 收。
 *
 * @returns {Promise<void>} 流结束时 resolve。中止请调用方持有 AbortController。
 */
export async function streamChat({ prompt, sessionKey, model, projectId, attachments = [], signal }, onFrame) {
  const startedAt = performance.now()
  streamTrace = { startedAt: Date.now(), frames: [], bytes: 0, dropped: 0, endedAt: 0 }

  const response = await fetch('/v1/chat/stream', {
    method: 'POST',
    credentials: 'include',
    headers: headers({ 'Content-Type': 'application/json' }),
    // projectId 只在会话第一轮生效（服务端以存储里的归属为准），所以每轮都带上也无害
    body: JSON.stringify({
      prompt,
      sessionKey,
      model,
      projectId: projectId || '',
      source: 'web',
      ...(attachments.length ? { attachments } : {}),
    }),
    signal,
  })

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    let payload = null
    try { payload = JSON.parse(text) } catch { /* 非 JSON 就用原文 */ }
    throw toApiError(response, payload, text, { method: 'POST', path: '/v1/chat/stream' })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    streamTrace.bytes += value.length
    buffer += decoder.decode(value, { stream: true })

    // SSE 以空行分隔事件；最后一段可能不完整，留在 buffer 里等下一批
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      let type = 'message'
      const dataLines = []
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (!dataLines.length) continue
      /**
       * 到达时刻要在 onFrame **之前**取。
       *
       * 放到后面的话记下来的就成了"这一帧处理完的时刻"，于是渲染自己变慢
       * 会伪装成"上游变慢"—— 而区分这两件事正是这份记录唯一的用途。
       */
      if (streamTrace.frames.length < MAX_TRACE_FRAMES) {
        streamTrace.frames.push({ at: Math.round(performance.now() - startedAt), type })
      } else {
        streamTrace.dropped += 1
      }
      try {
        onFrame(type, JSON.parse(dataLines.join('\n')))
      } catch {
        // 单帧解析失败不该中断整条流
      }
    }
  }
  streamTrace.endedAt = Math.round(performance.now() - startedAt)
}
