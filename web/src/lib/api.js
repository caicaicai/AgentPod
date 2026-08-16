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
const AUTH_MODE_KEY = 'ap.authMode'

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
 *
 * `sentToken` 是**这次请求实际带出去的那个令牌**。它存在是为了挡住一类竞态：
 * 页面加载时会并发打好几个接口，如果 localStorage 里躺着一个失效令牌
 * （服务端没配 SESSION_SECRET 时，重启就会让所有旧令牌失效），这几个请求会**一起** 401。
 * 第一条把令牌清掉、弹出登录框；用户登录成功之后，**后到的那几条 401 仍在路上** ——
 * 不判一下就会把刚登录好的人又踢回登录框。
 *
 * 判据是"令牌变过没有"：变过就说明这条 401 说的是一个我们已经扔掉的身份，与现在无关。
 */
function handleUnauthorized(status, payload, sentToken) {
  if (status !== 401 || redirecting) return ''
  if (sentToken && sentToken !== getAuthToken()) return ''

  // password 模式：清掉过期 token，通知前端弹登录框
  if (payload?.details?.authMode === 'password') {
    setAuthToken('')
    setCachedAuthMode('password')
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

/**
 * 这个部署上一次说的登录方式（`password` / `sso` / `dev` / `none`）。
 *
 * ── 它存在的唯一理由：第一帧就知道该不该画登录框 ──────────────────────
 *
 * 真正的答案在 `/healthz` 里，而那是一次网络请求。在它回来之前，界面只有两个选择：
 * 先画应用（猜"已登录"），或者先画登录框（猜"没登录"）—— 猜错的那一下就是用户看到的
 * "先闪一下聊天页再跳登录"。而**登录方式是部署的属性，不是这个人的状态**：
 * 一个部署配成 password 就一直是 password，记在本地几乎不会过时。
 *
 * 所以配上"本地有没有令牌"（getAuthToken），冷启动那一刻就能答得上来：
 * 记着是 password 且手里没令牌 → 直接画登录框，一帧都不闪。
 *
 * **它不是凭据，也不参与任何判定** —— 服务端该 401 照样 401。猜错的代价只是
 * 多闪一下（比如部署真的从 password 换成了 sso），boot 拿到 healthz 就会当场纠正。
 * 退出登录时**不清它**：换个人登录进来，登录方式还是同一个。
 */
export function getCachedAuthMode() {
  return localStorage.getItem(AUTH_MODE_KEY) || ''
}

export function setCachedAuthMode(mode) {
  if (mode) localStorage.setItem(AUTH_MODE_KEY, mode)
  else localStorage.removeItem(AUTH_MODE_KEY)
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
function toApiError(response, payload, text, { method = 'GET', path = '', sentToken = '' } = {}) {
  recordEvent({
    method,
    path,
    status: response.status,
    code: payload?.code || '',
    message: payload?.message || String(text || '').slice(0, 200),
    requestId: payload?.requestId || response.headers.get('x-request-id') || '',
    traceId: response.headers.get('x-trace-id') || '',
  })
  const redirectMessage = handleUnauthorized(response.status, payload, sentToken)
  return new ApiError(redirectMessage || payload?.message || text || `HTTP ${response.status}`, {
    code: payload?.code || '',
    status: response.status,
    requestId: payload?.requestId || response.headers.get('x-request-id') || '',
    details: payload?.details || null,
    redirecting: Boolean(redirectMessage),
  })
}

async function request(path, { method = 'GET', body } = {}) {
  // 发出去之前记下用的是哪个令牌 —— 回来时要靠它判断这条 401 还算不算数
  const sentToken = getAuthToken()
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
  if (!response.ok) throw toApiError(response, payload, text, { method, path, sentToken })
  return payload
}

/**
 * 公开接口（`/v1/public/*`）。与上面那个 `request` **刻意不共用**。
 *
 * 差别不在少发几个头，而在两条不能混的行为：
 *
 *   1. **不带任何身份**。分享页要能在无痕窗口里打开 —— 这是它存在的全部意义。
 *      顺手带上 Authorization 的话，"忘了登录会怎样"这件事在开发机上永远试不出来
 *      （开发者自己总是登着的），于是分享链接发出去才发现对方打不开。
 *   2. **401 不弹登录框**。公开接口本来就不该回 401；万一回了（比如反向代理
 *      在前面加了一层网关认证），正确的反应是把错误如实显示出来，
 *      而不是弹一个登录框 —— 访客根本没有这个平台的账号，弹了也没用。
 */
async function publicRequest(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    // 不是 JSON（网关的错误页之类），把原文当消息
  }
  if (!response.ok) {
    recordEvent({
      method: 'GET',
      path,
      status: response.status,
      code: payload?.code || '',
      message: payload?.message || String(text || '').slice(0, 200),
      requestId: payload?.requestId || response.headers.get('x-request-id') || '',
      traceId: response.headers.get('x-trace-id') || '',
    })
    throw new ApiError(payload?.message || text || `HTTP ${response.status}`, {
      code: payload?.code || '',
      status: response.status,
      requestId: payload?.requestId || response.headers.get('x-request-id') || '',
    })
  }
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
  /**
   * 注册。`email` 只在部署要求时才有值（healthz 的 features.registerEmail）。
   *
   * 开了邮箱验证码的部署上，这条回的是 **202 + pendingActivation**，
   * **没有 token** —— 账号还没激活，要先拿验证码去换（activateAccount）。
   */
  register: (username, password, email = '') =>
    request('/v1/auth/register', { method: 'POST', body: { username, password, ...(email ? { email } : {}) } }),
  activateAccount: (username, code) => request('/v1/auth/activate', { method: 'POST', body: { username, code } }),
  resendActivationCode: (username) => request('/v1/auth/activation/resend', { method: 'POST', body: { username } }),
  /** 改自己的密码。**必须带旧密码** —— 只凭令牌就能改密等于把"临时借用"变成"永久接管" */
  changePassword: (oldPassword, newPassword) =>
    request('/v1/auth/password', { method: 'POST', body: { oldPassword, newPassword } }),
  me: () => request('/v1/auth/me'),

  /**
   * 这个人手上还有哪些 run 在跑。**刷新页面之后靠它把断掉的那条找回来** ——
   * 会话正文要等一轮结束才落库，所以刷新后的历史里没有正在生成的那一轮，
   * 不问一句的话，用户看到的是"我刚发的那句话之后就没了"。
   */
  runs: (sessionKey = '') => request(`/v1/runs${sessionKey ? q({ sessionKey }) : ''}`),

  /**
   * 手动压缩一条会话的上下文。
   *
   * 普通 POST 而不是 SSE：中间没有任何可流式的东西（模型在写摘要，一个字都不吐），
   * 只有一个结果。但它**要调一次模型，可能十几秒** —— 调用方必须自己转圈。
   *
   * 路径是 `/v1/compact` 而不是 `/v1/sessions/:key/compact`：那个前缀把剩下的
   * 整段都当 sessionKey 解析（同一个理由让会话搜索去了 `/v1/search`）。
   */
  compactSession: (sessionKey = 'main', instructions = '') =>
    request('/v1/compact', { method: 'POST', body: { sessionKey, ...(instructions ? { instructions } : {}) } }),

  /**
   * 管理员接口。前端画不画入口由 `/v1/auth/me` 回的 `account.role` 决定，
   * 但**真正的判定在服务端** —— 这里少判一次只是界面难看，服务端少判一次是越权。
   */
  /**
   * 账号清单，**分页**（与会话列表同一套：回 `{ items, hasMore, nextCursor }`
   * 形状的东西，界面画「加载更多」）。
   *
   * `q` 的筛选**在服务端做**。从前是前端在已加载的清单上 filter —— 分页之后
   * 那等于"只搜当前这一页"，而搜不到的人看起来就像不存在。
   */
  adminListUsers: ({ cursor = '', limit = 0, q: keyword = '' } = {}) =>
    // 空值传 undefined 而不是空串：`q()` 会如实写出空串（那对别的接口是有意义的取值），
    // 而这里一串 `?cursor=&limit=0&q=` 只会让日志和地址栏难读
    request(`/v1/admin/users${q({ cursor: cursor || undefined, limit: limit || undefined, q: keyword || undefined })}`),
  adminCreateUser: (body) => request('/v1/admin/users', { method: 'POST', body }),
  adminPatchUser: (username, body) =>
    request(`/v1/admin/users/${encodeURIComponent(username)}`, { method: 'PATCH', body }),
  /**
   * Token 用量。`days=0` 表示不限时间，`group` 是 'user' 或 'model'。
   *
   * 回的只有聚合数（次数 / 输入 / 输出 / 缓存读入 / 最近一次），**没有任何对话内容** ——
   * 服务端也是这么实现的，不是靠前端不显示。
   *
   * 每行都带着另一维的拆分（用户行带 `models`、模型行带 `users`），所以展开一行
   * 不需要再请求一次；下面两个只用来取**按天曲线**。
   */
  /**
   * 模型配置（LLM_MODE=db 的那份清单）。
   *
   * **key 只回掩码**（`keyMask` / `hasKey`），完整的 key 从来不下发；
   * 修改时不传 `key` 就是"不动它"，传 `key: null` 才是清空 —— 服务端如此，
   * 因为界面上那个输入框平时本来就是空的，空串当清空的话每次改个上下文长度
   * 都会顺手把 key 抹掉。
   */
  adminListModels: ({ cursor = '', limit = 0 } = {}) =>
    request(`/v1/admin/models${q({ cursor: cursor || undefined, limit: limit || undefined })}`),
  adminCreateModel: (body) => request('/v1/admin/models', { method: 'POST', body }),
  adminPatchModel: (id, body) => request(`/v1/admin/models/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  adminDeleteModel: (id) => request(`/v1/admin/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** 用户分组。它只决定"能用哪些模型"，与角色（能不能管别人）是两回事 */
  adminListGroups: ({ cursor = '', limit = 0 } = {}) =>
    request(`/v1/admin/groups${q({ cursor: cursor || undefined, limit: limit || undefined })}`),
  adminCreateGroup: (body) => request('/v1/admin/groups', { method: 'POST', body }),
  adminPatchGroup: (id, body) => request(`/v1/admin/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  adminDeleteGroup: (id) => request(`/v1/admin/groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * 用量总表。**行是分页的，顶上那几个合计不是** —— 合计始终是整个时间窗的数。
   * 一张"合计只算了当前这一页"的表会让人每翻一页看到一个不同的总数。
   */
  adminUsage: (days, group, { cursor = '', limit = 0 } = {}) =>
    request(`/v1/admin/usage${q({ days, group, cursor: cursor || undefined, limit: limit || undefined })}`),
  adminUserTrend: (username, days, modelId) =>
    request(`/v1/admin/usage/user/${encodeURIComponent(username)}${q({ days, modelId })}`),
  adminModelTrend: (modelId, days) =>
    request(`/v1/admin/usage/model/${encodeURIComponent(modelId)}${q({ days })}`),
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
   * 下载走 Blob，见 modules/artifacts/artifact-view.js 的 downloadText）。
   */
  listArtifacts: (sessionKey = '') => request(`/v1/artifacts${q({ sessionKey })}`),
  getArtifact: (id, version = 0) => request(`/v1/artifacts/${encodeURIComponent(id)}${q({ v: version || undefined })}`),
  deleteArtifact: (id) => request(`/v1/artifacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * 分享（作者侧，要登录）。三个动词分得很开，因为是三件事：
   * 生成链接（幂等）／上下市场与改简介／撤销。
   */
  shareArtifact: (id) => request(`/v1/artifacts/${encodeURIComponent(id)}/share`, { method: 'POST' }),
  updateShare: (id, body) => request(`/v1/artifacts/${encodeURIComponent(id)}/share`, { method: 'PATCH', body }),
  unshareArtifact: (id) => request(`/v1/artifacts/${encodeURIComponent(id)}/share`, { method: 'DELETE' }),

  listCrons: () => request('/v1/crons'),
  createCron: (body) => request('/v1/crons', { method: 'POST', body }),
  updateCron: (id, body) => request(`/v1/crons/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteCron: (id) => request(`/v1/crons/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runCron: (id) => request(`/v1/crons/${encodeURIComponent(id)}/run`, { method: 'POST' }),

  abort: (runId) => request(`/v1/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' }),
}

/** 免登录的那几条。单独一个对象，免得哪天有人顺手把它们挪进上面那个带身份的封装里 */
export const publicApi = {
  getShare: (token) => publicRequest(`/v1/public/shares/${encodeURIComponent(token)}`),
  market: (params = {}) => publicRequest(`/v1/public/market${q(params)}`),
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

  await readSseStream(response, onFrame, startedAt)
  streamTrace.endedAt = Math.round(performance.now() - startedAt)
}

/**
 * 把一条 SSE 响应读到底，按帧回调。
 *
 * 抽出来是因为现在有**两条**流走同一套解析：一条是发起新一轮的
 * `/v1/chat/stream`（POST），一条是断线之后接回去的 `/v1/runs/:id/events`（GET）。
 * 复制一份的话，两边迟早只改了其中一边 —— 而"重连回来的那条流少解析了一种帧"
 * 这种毛病，只会在真的断过线的用户身上出现。
 *
 * `id:` 那一行是**断点**（服务端写的是 run 缓冲里的序号，见 src/agent/run-registry.js）。
 * 从前这一行是被忽略的，因为没有任何东西需要它。
 */
async function readSseStream(response, onFrame, startedAt = performance.now()) {
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
      let seq = 0
      const dataLines = []
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim()
        else if (line.startsWith('id:')) seq = Number(line.slice(3).trim()) || 0
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
        onFrame(type, JSON.parse(dataLines.join('\n')), seq)
      } catch {
        // 单帧解析失败不该中断整条流
      }
    }
  }
}

/**
 * 断线之后接回一条**还在跑**的流。
 *
 * @param {string} runId  从 run_start 帧里拿到的
 * @param {number} from   已经收到的最后一帧序号；服务端只重放它之后的
 *
 * 与 streamChat 是两条不同的路，这一点很要紧：那条是 POST（"跑一轮新的"），
 * 拿它做重连的话，一次网络抖动就会变成又跑一轮、又烧一份 token。
 */
export async function resumeRun({ runId, from = 0, signal }, onFrame) {
  const response = await fetch(`/v1/runs/${encodeURIComponent(runId)}/events?from=${from}`, {
    method: 'GET',
    credentials: 'include',
    headers: headers(),
    signal,
  })

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    let payload = null
    try { payload = JSON.parse(text) } catch { /* 非 JSON 就用原文 */ }
    throw toApiError(response, payload, text, { method: 'GET', path: `/v1/runs/${runId}/events` })
  }

  await readSseStream(response, onFrame)
}
