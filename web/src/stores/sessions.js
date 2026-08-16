/**
 * 会话：历史消息的归一化、草稿、列表与翻页、打开 / 新建 / 删除 / 搜索。
 *
 * ── 与作品、对话之间是**互相 import** 的，这是有意的 ──────────────────
 *
 *   本模块 → artifacts.js   打开一条会话要把它名下的作品跟着切过去
 *   本模块 → chat.js        打开一条会话要看看有没有还在跑的一轮要接回来
 *   artifacts.js → 本模块   作品卡片上的"继续改它"要跳到那条会话
 *   chat.js      → 本模块   一轮跑完要刷新列表
 *
 * ESM 处理得了这种环，但**前提是跨模块的调用都发生在运行时**：这几个都是
 * `export function` 声明（会提升，模块体执行前就绑好了），而真正被调用是在
 * 用户点了什么之后 —— 那时整张模块图早就加载完了。
 *
 * ⚠️ 所以这里有一条纪律：**不许在模块顶层直接调用另一个模块的函数**。
 * 那会在加载顺序上撞见一个还没初始化的绑定，而报错信息（`X is not a function`）
 * 完全指不到"import 成环"这件事上。
 */
import { api } from '../lib/api.js'
import { formatTokens, formatTurnStats } from '../lib/format.js'
import { parseInlinedAttachments } from '../modules/chat/attachments.js'
import { parsePickedElement } from '../modules/artifacts/artifact-view.js'
import { state, DRAFT_PREFIX, newSessionKey } from './state.js'
import { showBanner, reportLoadError } from './ui.js'
import { refreshArtifacts, syncSessionArtifacts } from './artifacts.js'
import { resumeActiveRun } from './chat.js'

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
    /**
     * 压缩点自成一"轮"（其实是一条分隔线）。
     *
     * **必须打断合并**：它落在两条助手消息中间时，如果只是被忽略，
     * 上下两段就会被合成一个气泡 —— 而那两段之间恰恰隔着一次"模型的记忆被换掉了"。
     */
    if (message.role === 'compaction') {
      turns.push({ role: 'compaction', tokensBefore: message.tokensBefore || 0, timestamp: message.timestamp || 0 })
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

export function loadDraft() {
  state.draft = localStorage.getItem(DRAFT_PREFIX + state.activeKey) || ''
  state.attachments = attachmentDrafts.get(state.activeKey) || []
  state.composerContext = contextDrafts.get(state.activeKey) || null
  state.composerError = ''
}

export function clearDraft(key) {
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
    const page = await api.listSessions({
      // 有项目时只看该项目；没选项目时**看全部**（而不是只看未分组）——
      // "全部对话"是默认视图，把项目里的藏起来会让人以为对话丢了
      projectId: state.projectId || undefined,
      includeArchived: '1',
    })
    state.sessions = page.sessions || []
    /**
     * 翻页位置。**每次刷新都从头开始** —— 这个函数的调用时机是"列表可能变了"
     * （发完一轮、改了项目、删了会话），那时候旧游标指向的位置已经不作数了。
     * 想加载更多的人再点一次就是。
     */
    state.sessionsCursor = page.nextCursor || ''
    state.sessionsHasMore = Boolean(page.hasMore)
    // 当前会话已经落库了，"新对话"那行就该消失
    if (state.sessions.some((session) => session.sessionKey === state.activeKey)) state.pendingNew = false
  } catch (error) {
    reportLoadError('会话列表加载失败', error)
  }
}

/**
 * 再取一页会话，**追加**在现有列表后面。
 *
 * 从前没有这个东西：服务端硬编 `LIMIT 200` 且没有续页手段，一个重度用户的
 * 第 201 条对话就此再也翻不到 —— 而且是静默的，界面上看起来他就只有 200 条。
 *
 * 去重是必须的：翻页途中若有一轮对话结束，那条会话会跳到列表最前面，
 * 于是它既在第一页里、又可能出现在这一页里。keyset 翻页把这种重复压到了
 * 极少数情况（见 src/sessions/cursor.js），但"极少"不是"没有"，
 * 而 Vue 的 :key 撞车会让整段列表渲染错乱。
 */
export async function loadMoreSessions() {
  if (!state.sessionsHasMore || state.sessionsLoadingMore) return
  state.sessionsLoadingMore = true
  try {
    const page = await api.listSessions({
      projectId: state.projectId || undefined,
      includeArchived: '1',
      cursor: state.sessionsCursor,
    })
    const seen = new Set(state.sessions.map((session) => session.sessionKey))
    state.sessions = [...state.sessions, ...(page.sessions || []).filter((session) => !seen.has(session.sessionKey))]
    state.sessionsCursor = page.nextCursor || ''
    state.sessionsHasMore = Boolean(page.hasMore)
  } catch (error) {
    reportLoadError('加载更多会话失败', error)
  } finally {
    state.sessionsLoadingMore = false
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
    /**
     * 历史归位之后，看看这条会话上还有没有正在跑的一轮要接回来。
     * **不 await** —— 那是一条可能挂着好几分钟的流，await 它等于让
     * "切到这条会话"这个动作一直转圈。
     */
    resumeActiveRun(key)
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

/**
 * 手动压缩当前会话的上下文。
 *
 * ── 用户为什么会需要这个 ────────────────────────────────────────────────
 *
 * 自动压缩是在**快撑满**的时候才触发的，也就是说它总是发生在一轮对话中间 ——
 * 用户正等着回答，却先要等十几秒的摘要。手动这条路让人可以挑一个自己不着急的
 * 时刻先压掉（比如刚聊完一个话题、准备换下一个），下一轮就不会被打断。
 *
 * ── 三件事必须做对 ──────────────────────────────────────────────────────
 *
 * 1. **正在跑的时候不许压。** 服务端那边 compact() 会先 abort 掉当前操作，
 *    也就是把用户正在等的那一轮打断 —— 而他按的是"压缩"，不是"停止"。
 * 2. **压完要重新加载历史。** 压缩往会话里追加了一条 compaction 条目，
 *    不重载的话那条分隔线要等下次刷新才出现，用户会以为没生效。
 * 3. **失败要说人话。** "会话太短"和"刚压过"都不是错误，是"没什么可做的"，
 *    服务端已经翻译好了（见 agent/compact-turn.js），这里原样转达即可。
 */
export async function compactCurrentSession() {
  if (state.live) {
    showBanner('这一轮还在跑，等它结束再压缩 —— 现在压会把正在等的回答打断')
    return false
  }
  if (state.pendingNew) {
    showBanner('这是一条新对话，还没有内容可以压缩')
    return false
  }
  const key = state.activeKey
  state.compacting = true
  try {
    const result = await api.compactSession(key)
    // 请求飞行途中用户切走了：这份结果已经不属于当前会话，别去动它的历史
    if (state.activeKey !== key) return true
    await openSession(key)
    showBanner(
      result.tokensBefore
        ? `上下文已压缩（压缩前约 ${formatTokens(result.tokensBefore)} tokens）—— 更早的对话模型只保留了摘要`
        : '上下文已压缩 —— 更早的对话模型只保留了摘要',
    )
    return true
  } catch (error) {
    showBanner(`压缩失败：${error.message}`)
    return false
  } finally {
    state.compacting = false
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
