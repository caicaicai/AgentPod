/**
 * 三条路径的识别。**这不是路由器。**
 *
 * ── 为什么不装 vue-router ────────────────────────────────────────────────
 *
 * 这个界面只有一个"页面"：对话。作品库、面板、向导全是同一页上的状态切换，
 * 地址栏从头到尾不动 —— 引一个路由库要换来的只是多一层 API 和一份需要维护的路由表。
 *
 * 分享打破的只有一点：`/s/<token>` 和 `/market` 必须是**真实的地址**，
 * 因为它们要能被复制、被转发、被收藏。而这两条路径的特点是**只在首屏判一次**：
 * 访客落在分享页上就一直在分享页，不会在应用内部导航过去。
 * 一个在启动时读一遍 `location.pathname` 的函数就够了。
 *
 * 服务端那边对应的是 src/http/server.js 里那段"把 index.html 回给 /s/* 和 /market"——
 * 两边都改才算数：这里认了但服务端没回 HTML，直接访问会得到 404。
 */

/** 分享页的地址。**只由前端拼**，因为 location.origin 才是访客真正看到的那个域名 */
export function shareUrl(token) {
  return `${location.origin}/s/${encodeURIComponent(token || '')}`
}

export const MARKET_PATH = '/market'

/**
 * 当前是不是一条公开路径。
 *
 * @returns {{name: 'share', token: string} | {name: 'market'} | null}
 *   null = 普通的应用页面，照常走登录与 boot()
 */
export function publicRoute() {
  const path = location.pathname
  if (path === MARKET_PATH || path === `${MARKET_PATH}/`) return { name: 'market' }
  if (!path.startsWith('/s/')) return null

  let token = path.slice('/s/'.length).replace(/\/$/, '')
  try {
    token = decodeURIComponent(token)
  } catch {
    // 不合法的百分号编码。当成一个查无此人的 token 交给下游 ——
    // 那条路径上已经有一份"这个链接不存在"的说法，不必在这里再造一种失败
  }
  return { name: 'share', token }
}
