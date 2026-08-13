/**
 * 全局状态与动作。
 *
 * 一条设计线贯穿全文：**历史与流式共用同一套数据形状**。
 * 服务端 `/v1/sessions/:key` 回的消息形状与 SSE 帧刻意对齐，这里再把两者都
 * 归一成同一种 turn / block 序列（thinking / text / tool），所以"刚发完好好的、
 * 一刷新就变样"这类问题在结构上就不会出现 —— 组件只有一套渲染逻辑。
 *
 * 用 reactive 单例而不是 Pinia：这个界面只有一份状态、没有服务端渲染，
 * 引一个状态库要换来的只是多一层 API。
 */
import { reactive, watch } from 'vue'

import {
  api, publicApi, streamChat, getDevUsername, setDevUsername, getAuthToken, setAuthToken, ApiError,
  isRedirectingToLogin, clearSsoRetryMarker, onNeedLogin,
} from '../lib/api.js'
import { formatTurnStats } from '../lib/format.js'
import { parseInlinedAttachments, toWire } from '../lib/attachments.js'
import { composeElementPrompt, parsePickedElement } from '../lib/artifact-view.js'

const MODEL_KEY = 'ap.model'
const PROJECT_KEY = 'ap.projectId'
const THEME_KEY = 'ap.theme'
const ARTIFACT_WIDTH_KEY = 'ap.artifactWidth'
const DRAFT_PREFIX = 'ap.draft.'

function newSessionKey() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export const state = reactive({
  health: null,
  /** 服务端开了哪些能力。关掉的那些整块不显示，而不是点了没反应 */
  features: {},
  booted: false,
  /** password 模式下为 true 时显示登录框 */
  needLogin: false,
  loginError: '',
  banner: '',
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',

  models: [],
  modelId: '',
  user: null,

  skills: [],
  skillsUsable: true,
  skillsNote: '',
  skillsNoteWarn: false,

  sessions: [],
  activeKey: newSessionKey(),
  /** 当前会话已落库的消息（已按"连续的助手消息合成一轮"分好组） */
  turns: [],
  /** 正在跑的这一轮：{ blocks, error, done, runId, controller } */
  live: null,
  /** 新会话在发出第一条消息之前只存在于前端，列表里也就没有它 */
  pendingNew: true,
  loadingSession: false,

  search: '',
  /** 搜索结果（走后端全文），为 null 表示当前不在搜索态 */
  searchHits: null,

  // ── 输入区 ──
  draft: '',
  attachments: [],
  composerError: '',
  /**
   * 结构化的引用上下文：现在只有"预览里选中的那个元素"一种。
   * `{ meta, pick }`。
   *
   * **与 draft 分开存**，因为它不是用户打的字：拼成提示词塞进输入框的话，
   * 用户自己那句"把它改成蓝色的"会被埋在十几行标记中间，改也不好改、看也不好看。
   * 发送时才拼（见 send），显示时折回一枚 chip（见 parsePickedElement）。
   */
  composerContext: null,

  // ── 项目 ──
  projects: [],
  /** 当前项目。空串 = 全部对话 */
  projectId: '',

  // ── 记忆 ──
  memoryScope: 'personal',
  memory: { content: '', revision: '', count: 0 },
  memoryDraft: '',
  memoryNote: '',
  memoryNoteWarn: false,

  // ── 定时任务 ──
  crons: [],
  cronNote: '',
  cronNoteWarn: false,

  // ── 作品 ──
  /**
   * 主视图。`chat` = 对话，`artifacts` = 作品库，`market` = 作品市场。
   *
   * 作品库是**独立入口**而不是又一个抽屉：抽屉是"边聊边看这一轮的产出"，
   * 而"上周做的那个报表在哪"是另一件事 —— 它跟当前聊到哪儿没有关系，
   * 挤在对话右边那条缝里也翻不动。市场同理，而且它连"我的"都不是。
   */
  view: 'chat',
  /** 当前会话的作品清单（不含正文） */
  artifacts: [],
  /** 作品库里的全部作品（跨会话）。与上面那份分开存，因为口径不同 */
  libraryArtifacts: [],
  librarySearch: '',
  /** 类型筛选，空串 = 全部 */
  libraryKind: '',
  libraryLoading: false,
  /**
   * 预览里选中的那个元素：{ selector, label, html, text }。
   *
   * ⚠️ 这四个字段来自沙箱文档的 postMessage，**是不可信输入** ——
   * 那份文档是模型生成的，可以伪造。所以只当字符串用（模板插值会转义），
   * 长度在收进来那一刻就截断，见 onPreviewMessage。
   */
  artifactPick: null,
  /** 元素拾取模式开着没有 */
  artifactPicking: false,
  /** 创建向导：选类型 + 写一句描述 → 拼成给模型的话 */
  wizardOpen: false,
  wizardKind: 'web',
  wizardDraft: '',
  /** 服务端下发的预览约束，前端拿它拼 iframe 的 CSP，不在这边硬编 */
  artifactPreview: { allowedOrigins: [] },
  /** 面板里打开的那一份：{ meta, version, content, fileName } */
  artifactDetail: null,
  artifactLoading: false,
  artifactNote: '',
  /**
   * 作品面板铺满整个界面。**一次性的：抽屉一关就复位。**
   *
   * 曾经记在 localStorage 里，理由是"偏好全屏的人每次都想要全屏"。
   * 那个理由站不住：全屏是为了**把眼前这一份看清楚**（一个整页网页、一张大图），
   * 而不是一种长期口味。记下来之后，下次打开一份小作品也是满屏，
   * 而用户完全不记得自己什么时候"设置"过 —— 于是它表现得像个 bug。
   *
   * 宽度（artifactWidth）仍然记盘：那是"这个抽屉在我屏幕上该多宽"，
   * 确实是长期偏好，两者性质不同。
   */
  artifactFull: false,
  /** 用户拖出来的面板宽度（像素）。0 = 用默认档位。同样记盘，理由同上 */
  artifactWidth: Number(localStorage.getItem(ARTIFACT_WIDTH_KEY)) || 0,

  // ── 分享 ──
  /** 三个分享动作共用一个在途标记：同一时刻只可能在做其中一件 */
  shareBusy: false,
  shareNote: '',
  /**
   * 作品市场。**它是公开数据**，走的是免登录那条接口 —— 应用内看到的和
   * 访客在 /market 上看到的是同一份，不会出现"登录后才发现少了几条"。
   */
  marketItems: [],
  marketSearch: '',
  marketKind: '',
  marketLoading: false,
  marketNote: '',

  // ── 账号 ──
  /**
   * 我自己那条账号记录（`{ username, role, disabled, createdAt }`）。
   * 没接账号存储时是 null —— 界面据此不画「我的账号」和管理员入口。
   */
  account: null,
  accountBusy: false,
  accountNote: '',
  accountNoteWarn: false,

  /** 管理员控制台 */
  adminUsers: [],
  adminSearch: '',
  adminLoading: false,
  adminBusy: false,
  adminNote: '',
  adminNoteWarn: false,

  // ── 界面开关 ──
  sidebarCollapsed: false,
  panel: '', // '' | 'skills' | 'memory' | 'cron' | 'project' | 'debug' | 'artifact'
  debugText: '',
  debugNote: '',
  lightbox: '',
})

/**
 * 待发附件按会话分开存。
 *
 * 不放进 state 是因为它得跟着 activeKey 走：切走再切回来，那几个还没发出去的
 * 文件应该还在。也不落 localStorage —— 一张截图的 base64 就能把 5MB 配额吃掉，
 * 而"关掉浏览器之后附件还在"并不是谁真正需要的东西。
 */
const attachmentDrafts = new Map()
/** 引用上下文也按会话存：切走再切回来，那枚 chip 该还在 */
const contextDrafts = new Map()

export function showBanner(text) {
  state.banner = text
}
export function hideBanner() {
  state.banner = ''
}

/**
 * 加载类失败 → 横幅。**但 401 不算**。
 *
 * ── 这条规则是从一个真实现象里来的 ────────────────────────────────────
 *
 * 服务端没配 SESSION_SECRET 时，签名密钥每次启动随机生成，于是重启之后
 * localStorage 里那个令牌就失效了。而 `boot()` 只看"有没有令牌"、不看它还灵不灵，
 * 所以会带着这个死令牌把首屏那一批接口全打出去 —— 六条一起 401。
 * 第一条弹出登录框，同时 `refreshSessions` 的 catch 画出一条
 * 「会话列表加载失败：需要登录」。用户登录成功、一切正常之后，**那条横幅还挂在上面**。
 *
 * 根子上 401 就不该走横幅这条路：它不是一个用户能处理的错误，
 * 而"要登录"这件事已经由登录框本身表达了。横幅只会盖在它上面变成噪音。
 */
function reportLoadError(prefix, error) {
  if (error?.status === 401 || error?.redirecting) return
  showBanner(`${prefix}：${error.message}`)
}

export function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = state.theme
  localStorage.setItem(THEME_KEY, state.theme)
}

export function togglePanel(name) {
  state.panel = state.panel === name ? '' : name
  if (state.panel === 'memory') loadMemory()
  if (state.panel === 'cron') refreshCrons()
  if (state.panel === 'artifact') refreshArtifacts()
}
export function closePanel() {
  state.panel = ''
}

/* ═══════════════ 消息 → turn / block 序列 ═══════════════ */

/**
 * 把服务端回的消息列表归一成"轮"。
 *
 * 连续的助手消息合成一轮：一次提问里模型往往先说"我查一下"并调工具、
 * 拿到结果再说结论，那是**一条**回复的两段，不该在界面上裂成两个头像块。
 */
export function toTurns(messages = []) {
  const turns = []
  for (const message of messages) {
    if (message.role === 'user') {
      // 文本附件是拼进 prompt 正文发出去的，这里把它折回 chip ——
      // 否则刷新之后同一条消息会从"两个附件"变成一堵几千字的墙
      // 两层都要折回来：选中的元素、以及拼进正文的文本附件。
      // 不折的话，刷新之后这条消息会从"一句话 + 两枚 chip"变成一堵标记墙
      const picked = parsePickedElement(message.text)
      const { text, files } = parseInlinedAttachments(picked.text)
      turns.push({
        role: 'user',
        text,
        images: message.images || 0,
        files,
        element: picked.element,
        timestamp: message.timestamp || 0,
      })
      continue
    }
    let turn = turns[turns.length - 1]
    if (!turn || turn.role !== 'assistant') {
      turn = { role: 'assistant', blocks: [], error: '', warning: '', done: true, timestamp: message.timestamp || 0 }
      turns.push(turn)
    }
    // 服务端把统计挂在一轮的最后一条 assistant 消息上，正好落到这一轮的 turn 上
    if (message.turnStats) {
      turn.meta = formatTurnStats(message.turnStats)
      turn.stats = message.turnStats // 原始数字留给「复制调试信息」
    }
    if (message.thinking) turn.blocks.push({ type: 'thinking', text: message.thinking })
    if (message.text) turn.blocks.push({ type: 'text', text: message.text })
    for (const call of message.toolCalls || []) {
      turn.blocks.push({
        type: 'tool',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.args || {},
        // pending 说明那一轮跑到一半断了（关页面/超时），结果永远不会来了
        status: call.pending ? 'aborted' : call.isError ? 'error' : 'done',
        preview: call.preview || '',
        previewTruncated: Boolean(call.previewTruncated),
        resultLength: call.resultLength || 0,
        images: call.images || [],
      })
    }
    if (message.error) turn.error = message.error
    if (message.warning) turn.warning = message.warning
  }
  return turns
}

/* ═══════════════ 草稿 ═══════════════ */

/**
 * 每个会话各存一份草稿。
 *
 * 没有它的话，"写了半屏 → 想起来要翻上一次的结论 → 切过去看一眼 → 切回来"
 * 这条极常见的路径会把输入框清空。存 localStorage 而不是服务端：草稿是本机的
 * 临时状态，同步上去反而要处理"两个标签页同时在写"这种没人关心的问题。
 */
export function saveDraft() {
  const text = state.draft
  if (text.trim()) localStorage.setItem(DRAFT_PREFIX + state.activeKey, text)
  else localStorage.removeItem(DRAFT_PREFIX + state.activeKey)
  if (state.attachments.length) attachmentDrafts.set(state.activeKey, state.attachments.slice())
  else attachmentDrafts.delete(state.activeKey)
  if (state.composerContext) contextDrafts.set(state.activeKey, state.composerContext)
  else contextDrafts.delete(state.activeKey)
}

function loadDraft() {
  state.draft = localStorage.getItem(DRAFT_PREFIX + state.activeKey) || ''
  state.attachments = attachmentDrafts.get(state.activeKey) || []
  state.composerContext = contextDrafts.get(state.activeKey) || null
  state.composerError = ''
}

function clearDraft(key) {
  localStorage.removeItem(DRAFT_PREFIX + key)
  attachmentDrafts.delete(key)
  contextDrafts.delete(key)
}

/* ═══════════════ 会话 ═══════════════ */

export function currentSession() {
  return state.sessions.find((item) => item.sessionKey === state.activeKey) || null
}

/** 会话可能来自列表，也可能来自搜索结果（属于别的项目 / 已归档） */
export function findSession(key) {
  return state.sessions.find((item) => item.sessionKey === key)
    || state.searchHits?.find((item) => item.sessionKey === key)
    || null
}

export function threadTitle() {
  const session = currentSession()
  return session?.title || (state.turns.length ? '未命名会话' : '新对话')
}

export async function refreshSessions() {
  try {
    const { sessions } = await api.listSessions({
      // 有项目时只看该项目；没选项目时**看全部**（而不是只看未分组）——
      // "全部对话"是默认视图，把项目里的藏起来会让人以为对话丢了
      projectId: state.projectId || undefined,
      includeArchived: '1',
    })
    state.sessions = sessions || []
    // 当前会话已经落库了，"新对话"那行就该消失
    if (state.sessions.some((session) => session.sessionKey === state.activeKey)) state.pendingNew = false
  } catch (error) {
    reportLoadError('会话列表加载失败', error)
  }
}

export async function openSession(key) {
  if (state.live) return // 正在跑的时候切会话会把流式结果丢在半路
  // 在作品库里点会话列表 = "我要去看那条对话"，得先回到对话视图
  state.view = 'chat'
  saveDraft() // 先把当前这条的草稿收好，再换人
  state.activeKey = key
  state.turns = []
  // 作品跟着会话走。先按缓存本地算一遍（立刻就对），再后台拉一次兜住别处的改动
  syncSessionArtifacts()
  state.artifactDetail = null
  loadDraft()
  refreshArtifacts()

  /**
   * **不再因为"本地列表里没有"就直接不加载。**
   *
   * 从前这里是 `if (!findSession(key)) return` —— 本意是省掉一次必然 404 的请求。
   * 但能点到 openSession 的地方越来越多（搜索结果、作品库里的"继续改它"），
   * 而那些入口指向的会话**完全可能不在当前列表里**：属于别的项目、已归档、
   * 或者列表还没刷新。于是表现是"点了之后进到一个空白的聊天框"，
   * 没有加载中、没有报错、什么都没有 —— 这是最难查的一类失败。
   *
   * 现在一律去问服务端，404 才认定它不存在，并**把这件事说出来**（回 false，
   * 由调用方决定怎么补救）。多打一次必然失败的请求，换掉一个静默的空白页，划算。
   */
  state.pendingNew = !findSession(key)
  state.loadingSession = true
  try {
    const detail = await api.getSession(key)
    // 请求飞行途中用户又切走了：这份历史已经不属于当前会话，丢掉
    if (state.activeKey !== key) return false
    state.turns = toTurns(detail.messages || [])
    state.pendingNew = false
    return true
  } catch (error) {
    if (error.status !== 404) {
      reportLoadError('会话加载失败', error)
      return false
    }
    // 服务端没有这条会话。留在这个 key 上当新对话用，让调用方决定要不要提示
    state.pendingNew = true
    return false
  } finally {
    if (state.activeKey === key) state.loadingSession = false
  }
}

export function startNewSession() {
  if (state.live) return
  state.view = 'chat'
  saveDraft()
  state.activeKey = newSessionKey()
  state.pendingNew = true
  state.turns = []
  // 新会话名下还没有作品，本地过滤自然得到空列表
  syncSessionArtifacts()
  state.artifactDetail = null
  loadDraft()
}

export async function deleteSession(key) {
  try {
    await api.deleteSession(key)
  } catch (error) {
    showBanner(`删除失败：${error.message}`)
  }
  clearDraft(key)
  if (key === state.activeKey) startNewSession()
  await refreshSessions()
}

export async function renameSession(key, title) {
  try {
    await api.renameSession(key, title)
  } catch (error) {
    showBanner(`重命名失败：${error.message}`)
  }
  await refreshSessions()
  if (state.searchHits) await runSearch()
}

export async function patchSession(key, patch) {
  try {
    await api.patchSession(key, patch)
  } catch (error) {
    showBanner(`操作失败：${error.message}`)
  }
  await refreshSessions()
  if (state.searchHits) await runSearch()
}

export async function clearActiveSession() {
  if (state.live) return
  const session = currentSession()
  if (!session) return
  await deleteSession(session.sessionKey)
}

/**
 * 搜索走后端（标题 + 正文），本地只做防抖。
 *
 * 之前是纯前端按标题过滤 —— 而标题是从第一句话截出来的，"上次聊 Redis 那次"
 * 十有八九不在标题里。搜不到的体验比没有搜索更糟：用户会以为会话被删了。
 */
let searchTimer = null

async function runSearch() {
  const keyword = state.search.trim()
  if (!keyword) { state.searchHits = null; return }
  try {
    const { sessions } = await api.searchSessions(keyword)
    // 输入框在请求飞行途中又变了：这次结果已经过时，丢掉
    if (state.search.trim() !== keyword) return
    state.searchHits = sessions || []
  } catch (error) {
    showBanner(`搜索失败：${error.message}`)
  }
}

export function scheduleSearch() {
  clearTimeout(searchTimer)
  if (!state.search.trim()) { state.searchHits = null; return }
  searchTimer = setTimeout(runSearch, 250)
}

/* ═══════════════ 项目 ═══════════════ */

export function currentProject() {
  return state.projects.find((project) => project.id === state.projectId) || null
}

export async function refreshProjects() {
  if (!state.features.projects) return
  try {
    const { projects } = await api.listProjects()
    state.projects = projects || []
    // 上次选的项目被删了：退回"全部对话"，而不是卡在一个查不到的 id 上
    if (state.projectId && !state.projects.some((project) => project.id === state.projectId)) {
      state.projectId = ''
      localStorage.removeItem(PROJECT_KEY)
    }
  } catch (error) {
    reportLoadError('项目列表加载失败', error)
  }
}

export async function switchProject(projectId) {
  if (state.live) return
  state.projectId = projectId
  if (projectId) localStorage.setItem(PROJECT_KEY, projectId)
  else localStorage.removeItem(PROJECT_KEY)
  await refreshSessions()
  // 切项目就是换了个工作面，停在一条属于别的项目的会话上会很困惑
  startNewSession()
}

export async function createProject(name) {
  if (!name?.trim()) return null
  try {
    const { project } = await api.createProject({ name: name.trim() })
    await refreshProjects()
    await switchProject(project.id)
    return project
  } catch (error) {
    showBanner(`创建项目失败：${error.message}`)
    return null
  }
}

export async function saveProject(patch) {
  const project = currentProject()
  if (!project) return false
  try {
    await api.updateProject(project.id, patch)
    await refreshProjects()
    return true
  } catch (error) {
    showBanner(`保存项目失败：${error.message}`)
    return false
  }
}

export async function deleteProject() {
  const project = currentProject()
  if (!project) return
  try {
    await api.deleteProject(project.id)
    closePanel()
    await refreshProjects()
    await switchProject('')
  } catch (error) {
    showBanner(`删除项目失败：${error.message}`)
  }
}

/* ═══════════════ 长期记忆 ═══════════════ */

/**
 * @param {boolean} [force] 用户点「重新加载」时为 true —— 那是明确要求丢掉本地改动
 */
export async function loadMemory(force = false) {
  if (!state.features.memory) return
  const projectId = state.memoryScope === 'project' ? state.projectId : ''
  /**
   * 用户正在编辑就别覆盖他的输入框。
   *
   * 这个函数有两个调用方：用户主动打开/刷新面板，以及**每轮对话结束后刷新条数**。
   * 后者不设防的话，"打开记忆面板改了几行 → 顺手发了条消息 → 改动被静默还原"
   * 就会发生，而且看起来像是保存失败。条数照常更新，只是不动正文。
   */
  const editing = state.panel === 'memory' && state.memoryDraft !== state.memory.content
  try {
    const data = await api.getMemory(projectId)
    const count = data.count || 0
    // 侧栏那个数字始终显示**个人**记忆条数：项目记忆随项目切换，放同一个位置会跳
    if (!projectId) state.memory.count = count

    if (!force && editing) {
      /**
       * ⚠️ 这条分支里**不更新 revision**。
       *
       * 更新了的话，用户接着点保存就会拿着新 revision 过去 —— 服务端认为没冲突，
       * 于是把别处刚写的那条静默盖掉。而乐观锁的全部意义就是不让这件事发生。
       * 保持旧 revision，保存时会正常撞出 409，用户再决定要不要放弃自己的改动。
       */
      state.memoryNote = `记忆已在别处更新（现共 ${count} 条）。你的改动还在，保存时会提示冲突；点「重新加载」放弃改动取用新的。`
      state.memoryNoteWarn = true
      return
    }

    state.memory = { content: data.content || '', revision: data.revision || '', count }
    state.memoryDraft = state.memory.content
    state.memoryNote = state.memoryScope === 'project'
      ? `当前项目的记忆，共 ${count} 条。只有这个项目下的对话会带上它。`
      : `个人记忆，共 ${count} 条。每一轮对话都会带上，助手也可以自己增删。`
    state.memoryNoteWarn = false
  } catch (error) {
    state.memoryNote = `记忆加载失败：${error.message}`
    state.memoryNoteWarn = true
  }
}

export async function saveMemory() {
  const projectId = state.memoryScope === 'project' ? state.projectId : ''
  try {
    const data = await api.saveMemory(projectId, state.memoryDraft, state.memory.revision)
    state.memory = { content: data.content || '', revision: data.revision || '', count: data.count || 0 }
    state.memoryDraft = state.memory.content
    state.memoryNote = `已保存，共 ${state.memory.count} 条`
    state.memoryNoteWarn = false
  } catch (error) {
    /**
     * 409 是"你读到之后有人改过了"（多半是助手自己在对话里记了一条）。
     * 直接覆盖会把那条抹掉，所以只能提示重新加载 —— 这正是 revision 存在的意义。
     */
    state.memoryNote = error.status === 409
      ? '记忆在你编辑期间被改过了（助手可能刚记了一条）。请点「重新加载」后再改。'
      : `保存失败：${error.message}`
    state.memoryNoteWarn = true
  }
}

export function setMemoryScope(scope) {
  state.memoryScope = scope
  // 换作用域必须强制加载：这时候文本框里是**另一份**记忆的内容，
  // 保护它反而会让人看着个人记忆以为是项目记忆
  loadMemory(true)
}

/* ═══════════════ 定时任务 ═══════════════ */

export async function refreshCrons() {
  if (!state.features.cron) return
  try {
    const data = await api.listCrons()
    state.crons = data.crons || []
    /**
     * 调度没开 / 没有凭据来源时必须说清楚。
     *
     * 否则表现是"任务建好了、时间也对，就是永远不响"——用户会以为是 bug，
     * 而实际上是一个部署开关。这类"配置没开"的沉默失败最费排查时间。
     */
    if (!data.scheduler?.running) {
      state.cronNote = '本副本未开启调度（CRON_SCHEDULER=0），任务不会自动触发。'
      state.cronNoteWarn = true
    } else if (data.scheduler?.credentialMode === 'none' && state.health?.llmMode === 'platform') {
      state.cronNote = '服务端未开启定时任务凭据留存（CRON_CREDENTIAL_MODE=stored），无人值守时拿不到登录态，触发会失败。'
      state.cronNoteWarn = true
    } else {
      state.cronNote = '到点后系统会自动叫醒助手执行。也可以直接在对话里说「以后每周一帮我…」。'
      state.cronNoteWarn = false
    }
  } catch (error) {
    state.cronNote = `定时任务加载失败：${error.message}`
    state.cronNoteWarn = true
  }
}

export async function createCron(body) {
  try {
    await api.createCron({ ...body, projectId: state.projectId || undefined })
    await refreshCrons()
    return true
  } catch (error) {
    // 排期写错时服务端的报错里已经写清了该怎么改，原样显示，别包成"创建失败"
    state.cronNote = error.message
    state.cronNoteWarn = true
    return false
  }
}

export async function cronAction(cron, action) {
  try {
    if (action === 'toggle') await api.updateCron(cron.id, { enabled: !cron.enabled })
    if (action === 'delete') await api.deleteCron(cron.id)
    if (action === 'run') {
      state.cronNote = '正在执行…'
      state.cronNoteWarn = false
      const outcome = await api.runCron(cron.id)
      state.cronNote = outcome.ok
        ? '已执行一次，结果见下方「上次」和会话列表'
        : `执行未成功：${outcome.status}`
      state.cronNoteWarn = !outcome.ok
      await refreshSessions()
    }
    await refreshCrons()
  } catch (error) {
    state.cronNote = `操作失败：${error.message}`
    state.cronNoteWarn = true
  }
}

/* ═══════════════ 作品 ═══════════════ */

/**
 * 作品清单：**一次请求，一份真相**。
 *
 * ── 为什么不按会话去拉 ──────────────────────────────────────────────────
 *
 * 起初是两份：侧栏/库读"全部"，对话抽屉读"当前会话"，各有各的请求。
 * 于是它们会不一致 —— 侧栏那个数字要等你**点进作品库**才被填上，在那之前
 * 明明有作品却显示 0；删掉一份也得记着两处都刷，漏一处就留下一张已经没了的卡片。
 *
 * 清单接口本来就不带正文（很轻），所以一次全取回来，
 * "当前会话那份"退化成一次本地过滤。两个数字从此不可能对不上。
 */
export async function refreshArtifacts() {
  if (!state.features.artifacts) return
  state.libraryLoading = true
  try {
    // 不传 sessionKey = 这个人的全部作品
    const data = await api.listArtifacts()
    state.libraryArtifacts = data.artifacts || []
    state.artifactPreview = data.preview || { allowedOrigins: [] }
    syncSessionArtifacts()
    state.artifactNote = ''
  } catch (error) {
    // 401 由登录框负责表达，见 reportLoadError 的说明
    if (error?.status !== 401) state.artifactNote = `作品清单加载失败：${error.message}`
  } finally {
    state.libraryLoading = false
  }
}

/** 当前会话那份 = 全量的过滤结果。切会话时先本地算一次，界面不用等请求回来 */
function syncSessionArtifacts() {
  state.artifacts = state.libraryArtifacts.filter((item) => item.sessionKey === state.activeKey)
}

/**
 * 打开某一份（或某一版）。
 *
 * 详情**带正文**，可能几百 KB，所以只在真的要看时才取，不随清单一起下来。
 */
export async function openArtifact(id, version = 0) {
  if (!id) return
  // 作品库里是就地展开成整页，不该再弹一个抽屉出来盖住自己
  if (state.view !== 'artifacts') state.panel = 'artifact'
  state.artifactLoading = true
  state.artifactNote = ''
  try {
    const detail = await api.getArtifact(id, version)
    // 请求飞行途中用户把抽屉关了：这份内容已经不是他要看的了，丢掉
    if (state.view !== 'artifacts' && state.panel !== 'artifact') return
    state.artifactDetail = detail
  } catch (error) {
    state.artifactDetail = null
    state.artifactNote = `打开失败：${error.message}`
  } finally {
    state.artifactLoading = false
  }
}

/* ── 作品库（独立入口）── */

/**
 * 打开作品库。
 *
 * **进来先清掉正在看的那一份**：从对话侧栏点进来时，抽屉里可能还停在上一次
 * 打开的作品上，不清的话用户会看到一个跟他刚点的动作对不上的详情页。
 */
export async function openLibrary() {
  state.view = 'artifacts'
  state.panel = ''
  state.artifactDetail = null
  await refreshArtifacts()
}

export function closeLibrary() {
  state.view = 'chat'
  state.artifactDetail = null
}


/**
 * 「继续改它」：回到产出这份作品的那条对话。
 *
 * 首选是回到原对话 —— 那里有上下文（当初为什么这么做、用户的偏好），
 * 接着说"把标题改成…"模型就懂。
 *
 * ── 原对话不在了怎么办 ──────────────────────────────────────────────────
 *
 * 这不是边角情况：`SESSION_STORE=memory`（默认值）下，服务一重启对话就全没了，
 * 而作品落在 DATA_DIR 上活得好好的 —— 于是作品指向一条不存在的会话。
 *
 * 好在**作品是按用户存的，不绑会话**：read / update / write 只按 username + id
 * 取，所以在任意一条新对话里，模型照样改得动它。所以这里退化成"开一条新对话，
 * 把作品 id 放进输入框"，而不是把人丢在一个空白页面上自己猜。
 */
export async function openArtifactSession(meta) {
  closeLibrary()
  if (meta?.sessionKey && await openSession(meta.sessionKey)) return

  startNewSession()
  state.draft = `继续修改作品「${meta.title}」（id: ${meta.id}）：`
  showBanner(
    '产出这份作品的对话已经不在了，已为你开一条新对话（作品 id 在输入框里，助手可以直接接着改）。'
    + '会话默认只存在内存里，重启即丢 —— 想留住历史请把 SESSION_STORE 设成 file。',
  )
}

/**
 * 照着指引开一份新的。
 *
 * **没有"新建作品"按钮**，因为作品是模型产出的，不是用户手填的表单。
 * 所以这里做的是：回到对话、开一条新的、把话术填进输入框 —— 让用户看到
 * "原来是这么要的"，而不是对着一个空列表猜。
 *
 * 刻意**不自动发送**：那句话多半还要改一改（换个数据、加个条件），
 * 替他按下回车等于剥夺了这一步。
 */
export function startArtifactFrom(prompt) {
  closeWizard()
  closeLibrary()
  startNewSession()
  state.draft = prompt
}

/* ── 创建向导 ── */

/**
 * 打开创建向导。
 *
 * 它不创建任何东西 —— 只是把"选类型 + 写一句想要什么"拼成一句给模型的话。
 * 存在的理由见 artifact-view.js 里 ARTIFACT_RECIPES 上面那段：
 * 指引只画在空状态里的话，做出第一份作品之后就再也没人知道还能做别的了。
 */
export function openWizard(kind = 'web') {
  state.wizardKind = kind
  state.wizardDraft = ''
  state.wizardOpen = true
}

export function closeWizard() {
  state.wizardOpen = false
}

export function setWizardKind(kind) {
  state.wizardKind = kind
}

export function toggleArtifactFull() {
  state.artifactFull = !state.artifactFull
}

/**
 * 抽屉一关就退出全屏。
 *
 * 用 watch 盯着 `panel` 而不是在每个关闭点各写一行：关掉它的路径有好几条
 * （关闭按钮、togglePanel、Esc 直接改 state.panel、切去作品库…），
 * 逐个补迟早漏一个 —— 而漏掉的那条正好就是"我明明关了它怎么还是全屏"。
 */
watch(
  () => state.panel,
  (panel, previous) => {
    if (previous === 'artifact' && panel !== 'artifact') state.artifactFull = false
  },
)

/**
 * 拖出来的宽度。
 *
 * 每次 pointermove 都写一次 localStorage 看着很浪费，但这是**同步的本地写入、
 * 值只有几个字节**，实测比一次重排还便宜；而换来的是拖到一半刷新页面也不会丢。
 * 真要省，省的应该是别的地方。
 */
export function setArtifactWidth(px) {
  state.artifactWidth = px
  if (px) localStorage.setItem(ARTIFACT_WIDTH_KEY, String(px))
  else localStorage.removeItem(ARTIFACT_WIDTH_KEY)
}

/** 回到清单（面板不关）：作品往往不止一份，看完一个多半要看下一个 */
export function closeArtifactDetail() {
  state.artifactDetail = null
  clearPick()
}

/* ── 预览里的元素拾取 ── */

export function setPicking(on) {
  state.artifactPicking = on
  if (!on) return
  // 开始重新选时先把上一个清掉：否则界面上会同时挂着"已选中"和"正在选"，
  // 用户不知道点下去替换的是哪一个
  state.artifactPick = null
}

export function clearPick() {
  state.artifactPick = null
  state.artifactPicking = false
}

/** 沙箱报上来的选中结果。**长度在这里截断**，来源校验在组件里（要比对 iframe 身份） */
export function setPick(raw) {
  const text = (value, max) => String(value ?? '').slice(0, max)
  state.artifactPick = {
    label: text(raw?.label, 80) || '元素',
    selector: text(raw?.selector, 300),
    html: text(raw?.html, 2000),
    text: text(raw?.text, 200),
  }
  state.artifactPicking = false
}

/**
 * 「让助手改这里」：带着选中的元素回到那条对话。
 *
 * 与「继续改它」同一条退路 —— 原对话不在了就开一条新的（作品按用户存，不绑会话）。
 * 话术里带着元素的 outerHTML，模型基本可以直接拿它当 update 的 old_str。
 */
export async function askAboutElement(instruction = '') {
  const meta = state.artifactDetail?.meta
  const pick = state.artifactPick
  if (!meta || !pick) return

  const context = { meta: { id: meta.id, title: meta.title, kind: meta.kind }, pick }
  const said = String(instruction || '').trim()
  /**
   * **把预览留住。**
   *
   * `openSession` 会清掉 artifactDetail（切会话时该清），但这条路径正相反：
   * 用户刚在预览里点了一个元素，接下来要看着它被改。从前这里还顺手
   * `state.panel = ''` 把抽屉也关了 —— 于是人被甩到一个没有预览的页面上，
   * 而他本来正盯着那个元素。快照下来，跳完再放回去。
   */
  const keepOpen = state.artifactDetail
  clearPick()
  closeLibrary()

  if (meta.sessionKey && !(await openSession(meta.sessionKey))) startNewSession()
  else if (!meta.sessionKey) startNewSession()

  state.artifactDetail = keepOpen
  state.panel = 'artifact'
  state.composerContext = context

  /**
   * 说了要改什么就直接发，没说就只把它挂到输入框上。
   *
   * 不自动发的那一支是有用的：有人习惯在大输入框里慢慢写，浮层里那两行不够。
   * 正在跑一轮时也不发 —— send 本来就会拒绝，静默失败还不如留着让他自己发。
   */
  if (!said || state.live) {
    state.draft = said
    return
  }
  state.draft = said
  await send()
}

export async function deleteArtifact(id) {
  try {
    await api.deleteArtifact(id)
  } catch (error) {
    state.artifactNote = `删除失败：${error.message}`
    return
  }
  if (state.artifactDetail?.meta?.id === id) state.artifactDetail = null
  // 只有一份清单，刷一次两处都跟上（侧栏计数、库、抽屉列表）
  await refreshArtifacts()
}

/* ═══════════════ 分享 ═══════════════ */

/**
 * 服务端回的是**整份作品的新元信息**，所以三处一起换掉：正在看的那一份、
 * 库里那一条、当前会话那一条。
 *
 * 只改 artifactDetail 的话，退回列表会看到一张还标着"未分享"的卡片 ——
 * 而用户刚刚亲手分享过它。这类"改了但别处没跟上"的不一致，
 * 在这个 store 里一律用"拿服务端回的那份覆盖所有副本"来解决，不做局部打补丁。
 */
function applyArtifactMeta(meta) {
  if (!meta) return
  const swap = (item) => (item.id === meta.id ? meta : item)
  state.libraryArtifacts = state.libraryArtifacts.map(swap)
  state.artifacts = state.artifacts.map(swap)
  if (state.artifactDetail?.meta?.id === meta.id) {
    state.artifactDetail = { ...state.artifactDetail, meta }
  }
}

/** 包一层：三个分享动作的错误出口和"更新所有副本"是同一套，别写三遍 */
async function runShareAction(call) {
  state.shareBusy = true
  state.shareNote = ''
  try {
    const data = await call()
    if (data?.artifact) applyArtifactMeta(data.artifact)
    return true
  } catch (error) {
    state.shareNote = error.message
    return false
  } finally {
    state.shareBusy = false
  }
}

/** 生成分享链接。幂等 —— 已经分享过的作品再点一次，拿回的还是原来那条 */
export function shareArtifact(id) {
  return runShareAction(() => api.shareArtifact(id))
}

export function setArtifactMarket(id, body) {
  return runShareAction(() => api.updateShare(id, body))
}

/**
 * 撤销。DELETE 不回作品，所以这里自己把 share 抹掉 ——
 * 不然界面上那个链接会一直挂到下次刷新清单为止，而它其实已经打不开了。
 */
export async function unshareArtifact(id) {
  const ok = await runShareAction(async () => {
    await api.unshareArtifact(id)
    const current = state.libraryArtifacts.find((item) => item.id === id)
    return { artifact: current ? { ...current, share: null } : null }
  })
  return ok
}

/* ── 作品市场 ── */

/**
 * 刷市场。**这里不判 features** —— 独立的 /market 页面根本没跑过 boot()，
 * 那份能力宣告是空的，判了就等于访客永远看到一个空广场。
 * "该不该显示这个入口"由调用方决定，接口关掉时这里如实报错。
 */
export async function refreshMarket() {
  state.marketLoading = true
  try {
    const data = await publicApi.market({ q: state.marketSearch || undefined, kind: state.marketKind || undefined })
    state.marketItems = data.items || []
    state.marketNote = ''
  } catch (error) {
    state.marketNote = `市场加载失败：${error.message}`
  } finally {
    state.marketLoading = false
  }
}

export async function openMarket() {
  state.view = 'market'
  state.panel = ''
  state.artifactDetail = null
  await refreshMarket()
}

export function closeMarket() {
  state.view = 'chat'
}

/* ═══════════════ 模型 / 技能 / 身份 ═══════════════ */

export async function loadModels() {
  try {
    const data = await api.models()
    // 对外的模型字段是 `id`（见 toPublicModels）；llmToken 那些永不下发
    state.models = data.models || []
    const saved = localStorage.getItem(MODEL_KEY)
    state.modelId = state.models.some((model) => model.id === saved) ? saved : state.models[0]?.id || ''
    state.user = data.user || null
    if (data.stale) showBanner('模型清单来自缓存（平台暂时取不到最新的），可继续使用')
  } catch (error) {
    reportLoadError(
      '模型清单获取失败',
      // requestId 拼进消息里：用户拿一条报错来问时，凭它就能在服务端日志里定位那次请求
      { ...error, message: `${error.message}${error.requestId ? `（requestId ${error.requestId}）` : ''}` },
    )
  }
}

export function setModel(id) {
  state.modelId = id
  localStorage.setItem(MODEL_KEY, id)
}

export async function loadSkills() {
  try {
    const data = await api.skills()
    state.skills = data.skills || []
    state.skillsUsable = data.usable !== false

    if (!state.skills.length) {
      state.skillsNote = '没有装载任何技能（检查服务端 SKILL_DIRS）'
      state.skillsNoteWarn = true
      return
    }
    if (!state.skillsUsable) {
      // 技能正文全是沙盒命令，没有执行端时 runTurn 压根不会把它们宣告给模型
      state.skillsNote = `当前 SANDBOX_MODE=${data.sandboxMode}，没有执行端，技能不会宣告给模型`
      state.skillsNoteWarn = true
    } else if (data.canCreate) {
      state.skillsNote = '模型会按描述自行判断是否使用；点一条可填进输入框。想要新技能，直接说「帮我做一个……技能」。'
      state.skillsNoteWarn = false
    } else {
      // 没有用户工作空间时，模型在沙盒里做出来的技能会随 slot 一起销毁
      state.skillsNote = '模型会按描述自行判断是否使用。当前未配置用户工作空间，无法保存自建技能。'
      state.skillsNoteWarn = false
    }
  } catch (error) {
    state.skillsNote = `技能清单获取失败：${error.message}`
    state.skillsNoteWarn = true
  }
}

export function identityName() {
  return state.user?.fullname || state.user?.username || ''
}

/* ═══════════════ 账号 ═══════════════ */

/** 我是谁、什么角色。失败不弹横幅 —— 拿不到角色只是不画管理员入口，别的照常用 */
export async function loadAccount() {
  try {
    state.account = (await api.me()).account || null
  } catch {
    state.account = null
  }
}

export const isAdmin = () => state.account?.role === 'admin'

/** 改自己的密码。**要旧密码** —— 服务端也这么要求，这里只是提前把话说清楚 */
export async function changePassword(oldPassword, newPassword) {
  state.accountBusy = true
  state.accountNote = ''
  state.accountNoteWarn = false
  try {
    await api.changePassword(oldPassword, newPassword)
    /**
     * 已签发的令牌**不会失效**（签名密钥没变）。如实说出来 ——
     * 不说的话，用户会以为改完密码就把别处的登录踢掉了，而那是两件事。
     */
    state.accountNote = '密码已更新。已经登录的其它设备不会被踢下线（令牌到期前仍然有效）'
    return true
  } catch (error) {
    state.accountNote = error.message
    state.accountNoteWarn = true
    return false
  } finally {
    state.accountBusy = false
  }
}

/* ── 管理员控制台 ── */

export async function refreshUsers() {
  if (!state.features.accounts) return
  state.adminLoading = true
  try {
    state.adminUsers = (await api.adminListUsers()).users || []
    state.adminNote = ''
    state.adminNoteWarn = false
  } catch (error) {
    state.adminNote = `账号清单加载失败：${error.message}`
    state.adminNoteWarn = true
  } finally {
    state.adminLoading = false
  }
}

export async function openAdmin() {
  state.view = 'admin'
  state.panel = ''
  await refreshUsers()
}

export function closeAdmin() {
  state.view = 'chat'
}

/**
 * 三个管理动作的公共出口：跑完都要刷新清单。
 *
 * 不在本地改一份状态而是重取，是因为服务端有它自己的规则（不许禁用自己、
 * 不许撤销自己的管理员身份）—— 本地猜一遍就等于把那套规则抄两份，迟早对不上。
 */
async function runAdminAction(call, okNote) {
  state.adminBusy = true
  state.adminNote = ''
  state.adminNoteWarn = false
  try {
    await call()
    await refreshUsers()
    state.adminNote = okNote
    state.adminNoteWarn = false
    return true
  } catch (error) {
    state.adminNote = error.message
    state.adminNoteWarn = true
    return false
  } finally {
    state.adminBusy = false
  }
}

export function createUser({ username, password, role }) {
  return runAdminAction(() => api.adminCreateUser({ username, password, role }), `已创建账号 ${username}`)
}

export function setUserDisabled(username, disabled) {
  return runAdminAction(
    () => api.adminPatchUser(username, { disabled }),
    disabled ? `${username} 已禁用（数据保留，随时可以启用）` : `${username} 已启用`,
  )
}

export function setUserRole(username, role) {
  return runAdminAction(
    () => api.adminPatchUser(username, { role }),
    role === 'admin' ? `${username} 已设为管理员` : `${username} 已改回普通用户`,
  )
}

export function resetUserPassword(username, newPassword) {
  return runAdminAction(
    () => api.adminPatchUser(username, { newPassword }),
    `${username} 的密码已重置 —— 请通过可靠渠道告诉他，并让他登录后自行修改`,
  )
}

export async function login(username, password) {
  state.loginError = ''
  try {
    const data = await api.login(username, password)
    setAuthToken(data.token)
    state.needLogin = false
    state.loginError = ''
    await bootAfterLogin()
  } catch (error) {
    state.loginError = error.message || '登录失败'
  }
}

export function logout() {
  setAuthToken('')
  state.needLogin = true
  state.user = null
  // 角色跟着清：不清的话，换个人登录进来会先看到上一个人的管理员入口
  state.account = null
  state.adminUsers = []
  state.view = 'chat'
  state.sessions = []
  state.turns = []
  state.models = []
  state.skills = []
}

export { getDevUsername, setDevUsername }

/* ═══════════════ 发送与流式 ═══════════════ */

/**
 * 把一帧 text / thinking 落到块上。
 *
 * 服务端首帧发 `text`（全文，整体替换），之后发 `delta`（追加）—— 两个字段互斥。
 * 从前每帧都是全文，传输量是 O(n²)：1.6KB 的回复实测发了 491KB，
 * 现象就是"开头顺畅、越往后越卡、最后一大段一起蹦出来"。见 src/agent/events.js。
 *
 * 先判 `text`：它是权威值，服务端在内容不是纯追加时（模型重写、重试摘掉半条消息）
 * 会退回一次全文替换，那一帧必须覆盖而不是追加。
 */
function applyChunk(block, data) {
  if (typeof data.text === 'string') block.text = data.text
  else if (typeof data.delta === 'string') block.text += data.delta
}

/**
 * 往 live.blocks 里加一块，**并把数组里那个响应式代理还回来**。
 *
 * ── 不这么写会怎样 ────────────────────────────────────────────────────
 *
 * `const b = { type:'text', text:'' }; live.blocks.push(b)` 之后手里的 `b`
 * 仍然是**原始对象**：`reactive()` 是在读取时才包代理的，push 进去的东西
 * 原样存着。而响应式只在代理的 set 陷阱里触发 —— 直接改原始对象，
 * **一次重绘都不会发生**。（实测：3 次赋值，0 次重绘。）
 *
 * 这个 bug 的表现极具迷惑性，因为它不是"完全不更新"：
 *   - push 本身是数组变更，会触发一次重绘 → 第一帧看得见
 *   - 之后每一帧都是原始对象赋值 → **界面冻住**
 *   - 一轮结束时 `live.meta = …`、`state.turns.push(live)` 又触发 → **整段一起蹦出来**
 *
 * 于是用户看到的正是："输出了思考、输出了「你好」，卡住，然后突然全吐出来"。
 * 而工具卡片一直是好的 —— 那条路走的是 `live.blocks.find(…)`，
 * 数组的 get 陷阱会把元素包成代理，所以改的是代理。正因为工具是好的，
 * 这个问题很容易被误判成"网络/上游在憋"。
 */
function pushBlock(live, block) {
  live.blocks.push(block)
  return live.blocks[live.blocks.length - 1]
}

export async function send() {
  const typed = state.draft.trim()
  const attachments = state.attachments.slice()
  const context = state.composerContext
  if ((!typed && !attachments.length) || state.live) return

  /**
   * 引用上下文在**这一刻**才拼进正文。
   *
   * 发出去的是完整提示词（模型要那些标记才知道改哪儿），而界面上留下的是
   * "一句话 + 一枚 chip" —— 两者形状不同是有意的，折回来的规则见 parsePickedElement。
   */
  const prompt = context ? composeElementPrompt({ ...context, instruction: typed }) : typed

  state.draft = ''
  state.attachments = []
  state.composerContext = null
  state.composerError = ''
  clearDraft(state.activeKey) // 已经发出去了，草稿不该再留着
  hideBanner()

  state.turns.push({
    role: 'user',
    text: typed,
    images: 0,
    files: attachments,
    element: context ? { label: context.pick.label, info: '', html: context.pick.html } : null,
    timestamp: Date.now(),
  })

  const controller = new AbortController()
  const live = reactive({
    role: 'assistant',
    blocks: [],
    error: '',
    warning: '',
    requestId: '',
    done: false,
    runId: '',
    retry: null,
    retriedCount: 0,
    timestamp: Date.now(),
    controller,
  })
  state.live = live

  /** 当前敞着的那个文本/思考块；text_end 一到就封口，下一段另起一块 */
  let openText = null
  let openThinking = null

  /**
   * 收尾：停转圈、把这一轮挪进历史、放开输入框。
   *
   * **`final` 帧一到就调，不等流关闭。** 服务端在发完 final 之后还要抓记忆
   * （另一次模型调用），从前这里只在流关闭时收尾，于是正文早就停了、
   * final 也到了，界面还要再转好几秒 —— 实测 4.3 秒，而 final 距最后一个
   * 正文帧只有 14ms。信息一直在，是这里没用。
   *
   * 幂等，因为两条路都要走：正常收到 final 走这里；出错、中止、连接断了
   * 收不到 final，就由 finally 兜底。
   */
  let settled = false
  function settle() {
    if (settled) return
    settled = true
    live.done = true
    // 跑到一半断掉的工具，状态停在"执行中"会一直转圈，改成"未完成"
    for (const block of live.blocks) if (block.status === 'running') block.status = 'aborted'
    state.turns.push(live)
    state.live = null
  }

  try {
    await streamChat(
      {
        prompt,
        sessionKey: state.activeKey,
        model: state.modelId || undefined,
        // 只在会话第一轮生效，服务端以存储里的归属为准
        projectId: state.projectId,
        attachments: attachments.map(toWire),
        signal: controller.signal,
      },
      (type, data) => {
        switch (type) {
          case 'run_start':
            live.runId = data.runId
            break
          case 'model':
            live.meta = data.id
            break
          case 'thinking':
            // 必须用 pushBlock 的返回值（数组里的响应式代理）—— 见它的说明，
            // 拿着 push 进去的那个原始对象改，界面从第二帧起就不动了
            if (!openThinking) openThinking = pushBlock(live, { type: 'thinking', text: '' })
            applyChunk(openThinking, data)
            break
          case 'text':
            if (!openText) openText = pushBlock(live, { type: 'text', text: '' })
            applyChunk(openText, data)
            break
          case 'text_end':
            openText = null
            openThinking = null
            // 模型/网关出错时 pi 不抛异常，只是结束一条 stopReason='error' 的消息。
            // 不在这里接住，界面上就是个空气泡。
            if (data.errorMessage) live.error = data.errorMessage
            // 截断（stopReason='length'）不是错误：这一轮有输出、还会继续调工具。
            // 但结果可能是残的，用户必须看见 —— 否则表现就是"模型突然变笨了"。
            if (data.warning) live.warning = data.warning
            break
          case 'retry':
            if (data.state === 'start') {
              live.retry = { attempt: data.attempt, maxAttempts: data.maxAttempts, delayMs: data.delayMs }
              // 记总次数：重试结束后 live.retry 会清掉，但"这轮重试过"值得留在气泡上 ——
              // 用户回头看耗时为什么是 20 秒时，这是唯一的解释。
              live.retriedCount += 1
            } else {
              live.retry = null
            }
            break
          case 'tool_call':
            live.blocks.push({
              type: 'tool',
              toolCallId: data.toolCallId,
              toolName: data.toolName,
              args: data.args || {},
              status: 'running',
              preview: '',
              images: [],
            })
            break
          case 'tool_result': {
            const block = live.blocks.find(
              (item) => item.type === 'tool' && item.toolCallId === data.toolCallId,
            )
            if (!block) break
            block.status = data.isError ? 'error' : 'done'
            block.preview = data.preview || ''
            block.previewTruncated = Boolean(data.previewTruncated)
            block.resultLength = data.resultLength || 0
            block.images = data.images || []
            /**
             * 作品是刚刚才存下来的，清单得当场跟上 —— 等到这一轮结束再刷的话，
             * 模型一边写第二份、用户一边看着侧栏只有第一份，会以为没存上。
             */
            if (block.toolName === 'artifact' && !data.isError) refreshArtifacts()
            break
          }
          case 'final':
            // 与历史走同一个格式化函数、同一份服务端算出来的数 —— 刷新前后不会变样
            live.meta = formatTurnStats(data.turnStats)
            live.stats = data.turnStats
            // final 就是最后一帧，这一轮到此为止 —— 不要再等流关闭（见 settle）
            settle()
            break
          case 'error':
            live.error = data.message || '执行失败'
            break
          default:
            break
        }
      },
    )
  } catch (error) {
    /**
     * 已经收到 final 就不再记错误。
     *
     * 这一轮已经成功了，之后连接上再出什么岔子（收尾阶段断线之类）都与结果无关，
     * 记上去就是在一条好好的回复下面挂一条红字。往上抛也不行 —— send() 没人
     * 接，那就是一个未捕获的 rejection。丢掉是对的。
     */
    if (!settled) {
      if (error.name === 'AbortError') live.error = live.error || '已停止'
      else if (error instanceof ApiError) { live.error = error.message; live.requestId = error.requestId }
      else live.error = error.message || String(error)
    }
  } finally {
    // 兜底：出错、中止、连接断了都收不到 final
    settle()
    await refreshSessions()
    /**
     * 这一轮可能刚往记忆里写了几条，侧栏那个数字要跟上。
     *
     * 助手自己调 memory 工具写的那些，在 final 之前就落库了，这里一定读得到。
     * 但**自动抓取**是排在 final 之后的（另一次模型调用），这时候多半还没跑完 ——
     * 那个数字会晚一轮。这是为了不让界面陪着它多转几秒而付的代价，
     * 而且用户真去开记忆面板时 togglePanel 会重新拉一次，看到的是准的。
     */
    if (state.features.memory && state.memoryScope === 'personal') loadMemory()
  }
}

export async function stop() {
  const live = state.live
  if (!live) return
  try {
    // 先让服务端中止（沙盒里的进程要停），流会自己收尾
    if (live.runId) await api.abort(live.runId)
    else live.controller.abort()
  } catch {
    live.controller.abort()
  }
}

/* ═══════════════ 启动 ═══════════════ */

/**
 * healthz 之后拉取全部数据的公共逻辑。
 * 登录成功后和首次 boot 都走这里。
 */
async function bootAfterLogin() {
  state.features = state.health?.features || {}
  state.projectId = localStorage.getItem(PROJECT_KEY) || ''

  await refreshProjects()
  await Promise.all([
    loadModels(),
    loadSkills(),
    refreshSessions(),
    // 拿自己的角色。管理员入口画不画靠它 —— 而**判定在服务端**，
    // 这里少判一次只是界面难看，服务端少判一次是越权
    state.features.accounts ? loadAccount() : null,
    state.features.memory ? loadMemory() : null,
    state.features.cron ? refreshCrons() : null,
    // 不拉的话，侧栏「作品」后面那个数字要等用户点进作品库才变准
    state.features.artifacts ? refreshArtifacts() : null,
  ])

  if (!isRedirectingToLogin()) clearSsoRetryMarker()

  const last = state.sessions[0]
  if (last) await openSession(last.sessionKey)
  else loadDraft()

  state.booted = true
}

export async function boot() {
  // password 模式下，401 时不跳 SSO 而是弹登录框
  onNeedLogin(() => {
    state.needLogin = true
    // 登录框一出来就把横幅清掉：这时候屏幕上挂着的多半是"因为没登录"才失败的那几条，
    // 它们全都会在登录之后自动好，留着只会让人以为登录之后还有别的问题
    hideBanner()
  })

  try {
    state.health = await api.health()
  } catch {
    showBanner('服务端连不上，检查 agent 是否在跑')
  }

  // dev 模式下先给个默认身份，否则首屏所有接口都会 401，而改身份的输入框就在下面
  if (state.health?.authMode === 'dev' && !getDevUsername()) setDevUsername('dev')

  // password 模式：没有存储的 token 时直接显示登录框，不往下走
  if (state.health?.authMode === 'password' && !getAuthToken()) {
    state.needLogin = true
    state.booted = true
    return
  }

  await bootAfterLogin()
}
