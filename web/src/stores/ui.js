/**
 * 最底层的界面反馈：顶部横幅，以及"加载失败该不该弹横幅"这条规则。
 *
 * 单独一个文件是因为**几乎每个领域模块都要用它**（会话、作品、管理台、
 * 定时任务都在 catch 里报一句）。留在 app.js 里的话，任何一个模块想报错
 * 都得反过来 import app.js —— 而 app.js 又要 import 它们，环就成了。
 *
 * 与 state.js 同一条纪律：**这个文件只许依赖 state**。它一旦开始 import
 * 某个领域模块，就不再是叶子，上面那个环会原样回来。
 */
import { state } from './state.js'

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
export function reportLoadError(prefix, error) {
  if (error?.status === 401 || error?.redirecting) return
  showBanner(`${prefix}：${error.message}`)
}
