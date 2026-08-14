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
import { watch } from 'vue'

import {
  api, getDevUsername, setDevUsername, getAuthToken, setAuthToken,
  isRedirectingToLogin, clearSsoRetryMarker, onNeedLogin,
} from '../lib/api.js'
import { ADMIN_TABS, parsePath, pathFor } from '../lib/route.js'

// 常量与全局 state 已搬到 ./state.js —— 它是所有领域模块的共同依赖，
// 留在这儿会让任何拆分都撞上循环 import（见那个文件的开头）
export { state } from './state.js'
import { state } from './state.js'
import { MODEL_KEY, PROJECT_KEY, THEME_KEY, newSessionKey } from './state.js'



// 横幅与加载失败的处理搬到了 ./ui.js —— 几乎每个领域模块都要用它，
// 留在这儿会让它们全都反过来依赖 app.js（见那个文件的开头）
export { showBanner, hideBanner } from './ui.js'
import { showBanner, hideBanner, reportLoadError } from './ui.js'


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

/**
 * 会话（历史归一化 / 草稿 / 列表翻页 / 打开、新建、删除、搜索）搬到了 ./sessions.js。
 * 与作品、对话之间互相 import 的理由见那个文件的开头。
 */
export {
  toTurns, saveDraft, currentSession, findSession, threadTitle, refreshSessions, loadMoreSessions,
  openSession, startNewSession, clearActiveSession, deleteSession, renameSession, patchSession,
  scheduleSearch,
} from './sessions.js'
import { refreshSessions, openSession, startNewSession, loadDraft } from './sessions.js'

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

/**
 * 作品（清单 / 向导 / 元素拾取 / 分享 / 市场）搬到了 ./artifacts.js。
 * 它与 sessions.js 互相 import，理由见 sessions.js 开头。
 */
export {
  refreshArtifacts, openArtifact, deleteArtifact, openArtifactSession, openLibrary, closeLibrary,
  startArtifactFrom, openWizard, closeWizard, setWizardKind, toggleArtifactFull, setArtifactWidth,
  closeArtifactDetail, setPicking, clearPick, setPick, askAboutElement,
  shareArtifact, unshareArtifact, setArtifactMarket, openMarket, closeMarket, refreshMarket,
} from './artifacts.js'
import { refreshArtifacts, openLibrary, openMarket, openArtifact } from './artifacts.js'

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
    const result = await api.changePassword(oldPassword, newPassword)

    /**
     * ⚠️ **必须收下这张新令牌**。
     *
     * 改密会把账号的 tokenVersion 推一格，于是**所有**已签发的令牌当场作废 ——
     * 包括本页正拿着的这一张。服务端为此回了一张新的（它知道发起改密的人刚
     * 证明过自己知道旧密码）。不换的话，下一个请求就是 401，表现是"改完密码
     * 界面突然把我踢出去了"，而用户什么也没做错。
     */
    if (result?.token) setAuthToken(result.token)

    state.accountNote = result?.tokensRevoked
      ? '密码已更新。其它设备上的登录已全部退出'
      : '密码已更新'
    return true
  } catch (error) {
    state.accountNote = error.message
    state.accountNoteWarn = true
    return false
  } finally {
    state.accountBusy = false
  }
}

/**
 * 管理员控制台（账号 / 分组 / 模型 / 用量）搬到了 ./admin.js。
 *
 * 这里**原样再导出一遍**，是为了让组件的 import 一行都不用改 ——
 * 组件那边一律从本文件（stores/app.js）取。拆分要解决的是"这个文件太大没人敢动"，
 * 不该顺带变成一次几十个文件的 import 大搬家。
 *
 * openAdmin / setAdminTab 另外 import 一次：本文件的路由那一段要调它们。
 */
export {
  refreshUsers, openAdmin, closeAdmin,
  refreshUsage, setUsageDays, setUsageGroup, openUsageRow,
  refreshModels, createModel, updateModel, setModelEnabled, deleteModel,
  refreshGroups, createGroup, updateGroup, deleteGroup, setUserGroup,
  setAdminTab, createUser, setUserDisabled, setUserRole, resetUserPassword,
} from './admin.js'
import { openAdmin, setAdminTab } from './admin.js'


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
  // 用量是按人名列出来的，属于上一个人才看得到的东西：跟账号清单一起清
  state.adminUsage = null
  state.adminUsageOpen = ''
  state.adminUsageTrend = null
  state.adminUsageGroup = 'user'
  state.adminTab = 'users'
  state.view = 'chat'
  state.sessions = []
  state.turns = []
  /**
   * 会话也归零，顺带把地址退回 `/`。
   * 不退的话地址栏上还挂着上一个人的会话 id —— 换个人登录进来第一眼看到的
   * 就是别人的链接，而刷新一下还会真的去请求它（然后 404 或者 403）。
   */
  state.activeKey = newSessionKey()
  state.pendingNew = true
  state.models = []
  state.skills = []
}

export { getDevUsername, setDevUsername }

/**
 * 本地有没有身份的痕迹。**同步**，只用来在 `/market` 上分岔（见 App.vue）。
 *
 * 它回答不了"这个人现在登录着没有" —— sso 模式的登录态是一个 HttpOnly Cookie，
 * JS 看不见。所以它只在 password / dev 两种模式下说得准，而这正好是需要它的场合：
 * 分不清的时候按访客算，代价是 sso 用户在市场页刷新会看到那个不带侧栏的版本，
 * 内容一模一样，页上也有回应用的入口。反过来猜错的代价大得多 ——
 * 一个真访客会被 401 踢去 SSO 登录页，而那一页存在的意义就是不用登录也能看。
 */
export function hasStoredIdentity() {
  return Boolean(getAuthToken() || getDevUsername())
}

/**
 * 发送与流式（含断线重连）搬到了 ./chat.js。
 * 它与 sessions.js / artifacts.js 互相 import，理由见 sessions.js 开头。
 */
export { send, stop, resumeActiveRun } from './chat.js'

/* ═══════════════ 地址栏 ═══════════════ */

/**
 * 正在按地址改状态。**这期间不许反向写地址**：
 * 切一次会话要经过好几个中间态（先 view='chat'，再换 activeKey），
 * 每个中间态都写一次的话，用户按一下返回键，历史里会多出两三条他没去过的地址。
 */
let applyingUrl = false

/**
 * 状态 → 地址。
 *
 * `search` 和 `hash` 原样留着：里面可能有别处在管的标记（sso_retry 见 lib/api.js），
 * 这里只负责 pathname 那一段。
 */
function syncUrl({ replace = false } = {}) {
  const path = pathFor(state)
  if (path === location.pathname) return
  history[replace ? 'replaceState' : 'pushState'](null, '', `${path}${location.search}${location.hash}`)
}

/**
 * 状态一变就把地址跟上。**在这里盯着，而不是在每个入口后面补一行 pushState** ——
 * 能改变去处的地方有十几个（侧栏、作品卡片上的"继续改它"、Esc、向导、删除当前会话…），
 * 逐个补一定会漏，而漏掉的那条的表现是"地址栏在说一个我已经离开的页面"。
 *
 * 取值函数直接用 pathFor：它读哪几个字段，这个 watch 就跟哪几个字段，不用另抄一份依赖清单。
 */
watch(
  /**
   * 加载中不算数。
   *
   * 会话是"先切过去、再等历史回来"的（见 openSession），而切过去的那一刻
   * `pendingNew` 可能还是 true —— 本地列表里没有它（搜索结果、别的项目、已归档）。
   * 这时候写地址会写出一条 `/`，等历史回来再写一条 `/c/<key>`：
   * 用户点了一次，历史里多出两条，按返回键第一下像是没反应。
   */
  () => (state.loadingSession ? '' : pathFor(state)),
  (path) => {
    // booted 之前地址是**输入**不是输出（见 bootAfterLogin 末尾那次 replace）
    if (path && state.booted && !applyingUrl) syncUrl()
  },
)

/**
 * 地址 → 状态。冷启动、登录之后、浏览器前进/后退都走这一条。
 *
 * 认不出或者去不了（功能没开、不是管理员）时一律落回对话：
 * 一个打不开的地址应该退化成"进到了首页"，而不是一块空白。
 */
async function applyRoute(route) {
  applyingUrl = true
  try {
    if (route.name === 'artifacts' && state.features.artifacts) {
      await openLibrary()
      // 直接摊开某一份。取不到（删了、换了账号）时 openArtifact 自己会在库里留一句话
      if (route.artifactId) await openArtifact(route.artifactId)
      return
    }
    if (route.name === 'market' && state.features.artifactMarket) {
      await openMarket()
      return
    }
    /**
     * 管理台要**先确认自己是管理员**再进。
     * 判定当然在服务端（这里少判一次只是界面难看，服务端少判一次是越权），
     * 但不判的话，普通用户手敲 /admin 会进到一个所有接口都 403 的空表 ——
     * 那比"回到对话"更让人以为是坏了。
     */
    if (route.name === 'admin' && state.account?.role === 'admin') {
      state.adminTab = ADMIN_TABS.includes(route.tab) ? route.tab : ADMIN_TABS[0]
      await openAdmin()
      await setAdminTab(state.adminTab)
      return
    }

    state.view = 'chat'
    state.panel = ''
    const key = route.name === 'chat' ? route.sessionKey : ''
    if (key && key === state.activeKey) return
    /**
     * 这一轮还在跑：openSession 和 startNewSession 都会拒绝（切走会把流式结果丢在半路）。
     * **必须在这里说一声**，否则用户按了返回键什么都没发生，看起来就是页面卡住了。
     * 地址由调用方改回状态真正在的那一条（见 onPopState）。
     */
    if (state.live) {
      showBanner('这一轮还在跑，想切走的话先按停止')
      return
    }
    if (key) {
      if (!await openSession(key)) showBanner('这条对话打不开了 —— 可能已被删除，或者服务重启后它没有留存')
      return
    }
    /**
     * `/` = 新对话。**已经在一条没落库的新对话上时什么都不做** ——
     * 那时候再开一条只会把刚打了一半的草稿换到另一个键下面，看起来就是"字没了"。
     */
    if (!state.pendingNew) startNewSession()
  } finally {
    applyingUrl = false
  }
}

/** 浏览器的前进/后退。地址已经变好了，这里只负责把状态搬过去 */
async function onPopState() {
  await applyRoute(parsePath())
  /**
   * 状态没跟上时把地址改回来（这一轮还在跑时 openSession 会拒绝切换）。
   * 不改的话，地址栏在说一件没有发生的事 —— 而下一次刷新就会当真。
   */
  syncUrl({ replace: true })
}

/* ═══════════════ 启动 ═══════════════ */

/**
 * healthz 之后拉取全部数据的公共逻辑。
 * 登录成功后和首次 boot 都走这里。
 *
 * `route` 是这次要落到哪一页。默认读地址栏 —— 冷启动读的是用户粘进来的那条链接，
 * 登录之后读的是他被拦下来之前想去的那条（登录框不改地址，所以它还在）。
 */
async function bootAfterLogin(route = parsePath()) {
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

  /**
   * 先把对话摆好，再盖上要去的那一页。
   *
   * 顺序不能反：作品库、市场、管理台都不是"另一个应用"，从它们退回来（Esc、关闭按钮）
   * 落到的是对话 —— 那时候后面得有东西，不能是一片空白。
   */
  if (route.name === 'chat' && route.sessionKey) {
    if (!await openSession(route.sessionKey)) {
      showBanner('这条对话打不开了 —— 可能已被删除，或者服务重启后它没有留存')
    }
  } else {
    const last = state.sessions[0]
    if (last) await openSession(last.sessionKey)
    else loadDraft()
  }
  if (route.name !== 'chat') await applyRoute(route)

  state.booted = true
  /**
   * 对齐一次：`/admin` 补成 `/admin/users`、功能没开的那些落回 `/`、
   * 落在 `/` 上时补成刚打开的那条会话的地址（于是这一页从此可以复制给别人）。
   *
   * **replace 而不是 push**：这仍然是用户的同一次进入，不该在历史里多出一条 ——
   * 不然按一下返回键会回到"同一个页面的上一个写法"，看起来像什么都没发生。
   */
  syncUrl({ replace: true })
}

export async function boot() {
  // 前进/后退。只在应用外壳里挂 —— 分享页没有第二个去处可去
  window.addEventListener('popstate', onPopState)

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
