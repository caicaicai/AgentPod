/**
 * 冷启动的第一帧落在哪一页（`initRoute`）。
 *
 * ── 为什么要钉住它 ──────────────────────────────────────────────────────
 *
 * 这套界面的"页面"是一份状态，而**状态的初值不是地址**。从前地址要等 boot 那一串
 * 请求排完才被读进来（healthz、模型、技能、会话列表…），中间界面已经画出来了，
 * 画的是初值 —— 也就是聊天页。于是刷新 `/admin/models` 的观感是"先开对话，
 * 再跳过去"，跟地址栏是装饰品没有区别。
 *
 * `initRoute()` 把这件事提到 mount 之前同步做完（见 web/src/main.js）。它坏掉不会
 * 报任何错：构建照绿、跑起来也能用，只是每次刷新都先闪一下别的页面 ——
 * 这正是没有用例就一定会悄悄回退的那类行为。
 *
 * 另一半（状态 → 地址）在 web-url-sync.test.js，翻译层在 web-route.test.js。
 *
 * vue 装在 web/node_modules 下（前端是独立的 npm 工程），解析不到就跳过：
 * 根目录 `npm test` 不该因为没跑过 `npm run web:install` 就红。
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web')
const require = createRequire(path.join(webDir, 'noop.js'))

/**
 * store 在**模块加载时**就要读 localStorage 和 document（主题、面板宽度），
 * 所以这几个全局得先摆好。摆的是最小替身而不是 jsdom，理由见 web-url-sync.test.js。
 */
const cells = new Map()
function installBrowserGlobals() {
  globalThis.localStorage = {
    getItem: (key) => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => cells.set(key, String(value)),
    removeItem: (key) => cells.delete(key),
  }
  globalThis.document = {
    documentElement: { dataset: {} },
    createElement: () => ({ content: {}, setAttribute() {}, innerHTML: '' }),
  }
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.location = { pathname: '/', search: '', hash: '', origin: 'http://127.0.0.1:8787' }
  globalThis.history = { pushState() {}, replaceState() {} }
}

let store = null
try {
  require.resolve('vue')
  installBrowserGlobals()
  store = await import('../web/src/stores/app.js')
} catch {
  store = null
}

describe('冷启动落在地址说的那一页', { skip: store ? false : '没装 web/node_modules（先跑 npm run web:install）' }, () => {
  const { state, initRoute, authUnknown } = store || {}

  /**
   * 每个用例都从"刚 import 完 state.js"那一刻开始：`initRoute` 改的就是这几个字段，
   * 上一个用例留下的值会让下一个用例测了个寂寞。
   */
  beforeEach(() => {
    cells.clear()
    globalThis.location.pathname = '/'
    Object.assign(state, {
      booted: false,
      authReady: false,
      needLogin: false,
      view: 'chat',
      adminTab: 'users',
      activeKey: 's_initial',
      pendingNew: true,
      loadingSession: false,
    })
  })

  test('/admin/<tab>：第一帧就是管理台的那一页', () => {
    globalThis.location.pathname = '/admin/models'
    initRoute()
    assert.equal(state.view, 'admin')
    assert.equal(state.adminTab, 'models')
  })

  test('地址里写了不认识的管理台页 → 落到第一页，而不是空白', () => {
    globalThis.location.pathname = '/admin/nope'
    initRoute()
    assert.equal(state.view, 'admin')
    assert.equal(state.adminTab, 'users')
  })

  test('/artifacts 与 /market 同理', () => {
    globalThis.location.pathname = '/artifacts/a_1'
    initRoute()
    assert.equal(state.view, 'artifacts')

    state.view = 'chat'
    globalThis.location.pathname = '/market'
    initRoute()
    assert.equal(state.view, 'market')
  })

  /**
   * `/c/<key>` 得连"是哪一条"一起带进来：只把视图设成 chat 的话，第一帧画的是
   * 新对话那屏引导语，等历史回来再被顶掉 —— 同样是画错了页，只是错得不那么显眼。
   */
  test('/c/<key>：会话键当场就位，并且显示成加载中', () => {
    globalThis.location.pathname = '/c/s_target'
    initRoute()
    assert.equal(state.view, 'chat')
    assert.equal(state.activeKey, 's_target')
    assert.equal(state.pendingNew, false, '地址点名了某一条，就不是没落库的新对话')
    assert.equal(state.loadingSession, true)
  })

  test('/ 也是加载中 —— boot 会去开最近那条会话', () => {
    initRoute()
    assert.equal(state.view, 'chat')
    assert.equal(state.loadingSession, true)
    assert.equal(state.activeKey, 's_initial', '没点名哪一条就别动那个键')
  })

  /**
   * 分享页是公开的，它连登录框都不该参与（见 App.vue）。所以 initRoute 在这条
   * 地址上什么都不碰 —— 尤其是不能因为本地记着 password 就把 needLogin 点亮。
   */
  test('/s/<token>：一个字段都不碰', () => {
    cells.set('ap.authMode', 'password')
    globalThis.location.pathname = '/s/tok_1'
    initRoute()
    assert.equal(state.view, 'chat')
    assert.equal(state.needLogin, false)
    assert.equal(state.loadingSession, false)
  })

  describe('要不要先画登录框', () => {
    test('记着是 password 且手里没令牌 → 直接画，不先闪一下应用', () => {
      cells.set('ap.authMode', 'password')
      initRoute()
      assert.equal(state.needLogin, true)
    })

    test('有令牌就当已登录 —— 真过期了由 401 把登录框叫出来', () => {
      cells.set('ap.authMode', 'password')
      cells.set('ap.authToken', 'jwt')
      initRoute()
      assert.equal(state.needLogin, false)
    })

    test('sso 的登录态是看不见的 Cookie，猜不得', () => {
      cells.set('ap.authMode', 'sso')
      initRoute()
      assert.equal(state.needLogin, false)
    })

    /**
     * 第一次访问：既没有本地身份也没记着登录方式。这时候画应用是赌"已登录"、
     * 画登录框是赌"没登录"，赌输的那一下就是用户看到的闪烁 —— 所以先什么都不画。
     */
    test('第一次访问：healthz 回来之前，答不上就说答不上', () => {
      assert.equal(authUnknown(), true)

      state.authReady = true
      assert.equal(authUnknown(), false, 'healthz 说了就以它为准')

      state.authReady = false
      cells.set('ap.authMode', 'password')
      assert.equal(authUnknown(), false, '上次记下的登录方式就够了')
    })

    test('本地有身份痕迹时不必等 —— 直接画应用', () => {
      cells.set('ap.authToken', 'jwt')
      assert.equal(authUnknown(), false)
    })
  })
})
