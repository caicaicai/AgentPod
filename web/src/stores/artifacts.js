/**
 * 作品：清单与详情、创建向导、预览里的元素拾取、分享链接、作品市场。
 *
 * 四块放在一个文件里而不是四个，是因为它们**共用同一份 state 与同一套跳转**：
 * 拾取要往草稿里塞一枚 chip，分享要改作品记录上的 share 字段，市场只是分享的
 * 一个展示面。拆成四个的话，四个文件之间的 import 会比它们各自的内容还多。
 *
 * 与 sessions.js 互相 import（那边打开会话要切作品，这边"继续改它"要跳会话），
 * 环为什么是安全的、以及那条"不许在模块顶层跨模块调用"的纪律，见 sessions.js 开头。
 */
import { watch } from 'vue'

import { api, publicApi } from '../lib/api.js'
import { state, ARTIFACT_WIDTH_KEY } from './state.js'
import { showBanner } from './ui.js'
import { openSession, startNewSession } from './sessions.js'
// 「问问这块元素」拼好提示词之后要直接发出去 —— 与 sessions.js 同一个环，同样安全
import { send } from './chat.js'

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
export function syncSessionArtifacts() {
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
