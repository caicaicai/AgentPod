/**
 * 地址栏 ↔ 界面状态。**仍然不是一个路由器库，但地址是真的。**
 *
 * ── 为什么不装 vue-router ────────────────────────────────────────────────
 *
 * 这个界面的"页面"是一份 reactive 状态（view / activeKey / adminTab），组件按状态渲染。
 * vue-router 要换的是另一套心智：路由表、`<router-view>`、每个入口改成 `router.push`。
 * 为了让地址栏跟上，这些**都不是必需的** —— 需要的只有两条：
 *   1. 状态变了，把地址改成对应的那一条（history.pushState）；
 *   2. 冷启动或按下浏览器返回键时，把地址读回状态。
 * 下面这两个纯函数（parsePath / pathFor）就是这两条的全部，路由表在 store 里只是
 * 一个 switch。真正的复杂度在"进这一页要先取哪些数"，那部分谁来做路由都省不掉。
 *
 * ── 地址长什么样 ──────────────────────────────────────────────────────
 *
 *   /                    新对话（还没发出第一条消息，服务端没有它）
 *   /c/<sessionKey>      某一条对话
 *   /artifacts           作品库
 *   /artifacts/<id>      作品库，并摊开某一份
 *   /market              作品市场（**也是访客能直接打开的那条**）
 *   /admin/<tab>         管理台的某一页
 *   /s/<token>           分享页（公开）
 *
 * 抽屉（技能、记忆、定时任务、账号…）**故意不进地址**：它们是"在当前这页上顺手翻一眼"，
 * 不是一个去处。进了地址就得回答"分享一条带抽屉的链接是什么意思"，而那件事没人需要。
 *
 * 服务端那边对应的是 src/http/server.js 里那段"把 index.html 回给这几条路径"——
 * 两边都改才算数：这里认了但服务端没回 HTML，直接访问或刷新会得到 404。
 */

/** 分享页的地址。**只由前端拼**，因为 location.origin 才是访客真正看到的那个域名 */
export function shareUrl(token) {
  return `${location.origin}/s/${encodeURIComponent(token || '')}`
}

export const MARKET_PATH = '/market'

/** 管理台认得的几页。地址里写了别的（手改、旧链接）一律落到第一页，而不是空白 */
export const ADMIN_TABS = ['users', 'models', 'groups', 'usage']

/** 坏编码不该让整个界面白屏：解不开就按原样用，交给下游当"查无此物" */
function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 地址 → 路由。
 *
 * @returns {{name: 'share', token: string}
 *   | {name: 'market'}
 *   | {name: 'artifacts', artifactId: string}
 *   | {name: 'admin', tab: string}
 *   | {name: 'chat', sessionKey: string}}
 *   认不出来的路径当 `/` 处理 —— 那是"回到对话"，是所有情况下都成立的兜底
 */
export function parsePath(pathname = location.pathname) {
  const path = pathname.replace(/\/+$/, '') || '/'

  if (path === MARKET_PATH) return { name: 'market' }
  if (path.startsWith('/s/')) return { name: 'share', token: decode(path.slice('/s/'.length)) }
  if (path === '/artifacts' || path.startsWith('/artifacts/')) {
    return { name: 'artifacts', artifactId: decode(path.slice('/artifacts/'.length)) }
  }
  if (path === '/admin' || path.startsWith('/admin/')) {
    const tab = path.slice('/admin/'.length)
    return { name: 'admin', tab: ADMIN_TABS.includes(tab) ? tab : ADMIN_TABS[0] }
  }
  if (path.startsWith('/c/')) return { name: 'chat', sessionKey: decode(path.slice('/c/'.length)) }
  return { name: 'chat', sessionKey: '' }
}

/**
 * 状态 → 地址。**唯一的一处**，pushState 和 replaceState 都从这里取值。
 *
 * 新对话回 `/` 而不是 `/c/<新键>`：那个键这时候只存在于前端，
 * 复制出去别人打不开，刷新自己也回不来 —— 一个只有当事人那一个标签页认得的地址，
 * 不该出现在地址栏里。第一条消息发出去、会话落库之后（pendingNew 转 false），
 * 这里自然就换成真地址了。
 */
export function pathFor(state) {
  if (state.view === 'admin') return `/admin/${ADMIN_TABS.includes(state.adminTab) ? state.adminTab : ADMIN_TABS[0]}`
  if (state.view === 'market') return MARKET_PATH
  if (state.view === 'artifacts') {
    const id = state.artifactDetail?.meta?.id
    return id ? `/artifacts/${encodeURIComponent(id)}` : '/artifacts'
  }
  if (state.pendingNew || !state.activeKey) return '/'
  return `/c/${encodeURIComponent(state.activeKey)}`
}
