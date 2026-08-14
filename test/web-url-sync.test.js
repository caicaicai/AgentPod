/**
 * 地址栏跟着界面走（浏览器那一侧）。
 *
 * 翻译那一层（parsePath / pathFor）由 web-route.test.js 钉着，这里钉的是**另一半**：
 * 状态变了之后，那个 watch 有没有把地址写出去、写了几条。
 *
 * 为什么值得单独有一个文件：这两类错都不会报错，只会让人看到一个说不通的浏览器 ——
 *   - 该写没写 → 用户点进作品库、刷新，又回到了对话（这套地址就是为了消灭这件事）；
 *   - 写多了 → 点一次进去，按返回键要按两下才出来（中间那条是加载途中的半截状态）。
 *
 * 这里**不调 store 里那些动作**（openLibrary 之类都要打接口），只直接改状态：
 * 要测的是"状态 → 地址"这一条线，接口拉没拉到数与它无关。
 *
 * vue 装在 web/node_modules 下（前端是独立的 npm 工程），解析不到就跳过：
 * 根目录 `npm test` 不该因为没跑过 `npm run web:install` 就红。
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web')
const require = createRequire(path.join(webDir, 'noop.js'))

/**
 * store 在**模块加载时**就会读 localStorage 和 document（主题、面板宽度），
 * 所以这几个全局必须先摆好，import 才不会当场抛。
 *
 * 摆的是最小替身而不是 jsdom：要用到的就是下面这几个字段，
 * 为它们引一整套 DOM 实现，是拿一个大依赖换二十行属性。
 */
const history = []
function installBrowserGlobals() {
  const cells = new Map()
  globalThis.localStorage = {
    getItem: (key) => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => cells.set(key, String(value)),
    removeItem: (key) => cells.delete(key),
  }
  /**
   * `createElement` 是给 vue 的 runtime-dom 用的：它在**模块加载时**就要建一个
   * `<template>` 拿来当 innerHTML 的容器。回一个空壳就够 —— 这里没有要渲染的组件。
   */
  globalThis.document = {
    documentElement: { dataset: {} },
    createElement: () => ({ content: {}, setAttribute() {}, innerHTML: '' }),
  }
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.location = { pathname: '/', search: '', hash: '', origin: 'http://127.0.0.1:8787' }
  // 真浏览器里 pushState 会改 location，替身也得改 —— syncUrl 就是靠"和现在这条一样吗"去重的
  const write = (kind) => (_state, _title, url) => {
    history.push({ kind, url })
    globalThis.location.pathname = String(url).split('?')[0].split('#')[0]
  }
  globalThis.history = { pushState: write('push'), replaceState: write('replace') }
}

let store = null
try {
  require.resolve('vue')
  installBrowserGlobals()
  store = await import('../web/src/stores/app.js')
} catch {
  store = null
}
/**
 * `pathToFileURL` 不能省：Windows 上 `require.resolve` 回的是 `C:\…`，
 * 而 ESM 的 import() 只认 file:// —— 直接喂进去会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME。
 */
const vue = store ? await import(pathToFileURL(require.resolve('vue')).href) : null

describe('地址栏与界面同步', { skip: store ? false : '没装 web/node_modules（先跑 npm run web:install）' }, () => {
  const { state } = store || {}
  const { nextTick } = vue || {}

  /** watch 是攒到下一个 tick 才跑的，所以每次断言前都要让它跑完 */
  const settle = async () => { await nextTick(); await nextTick() }

  beforeEach(async () => {
    Object.assign(state, {
      booted: true,
      view: 'chat',
      panel: '',
      activeKey: 's_first',
      pendingNew: false,
      loadingSession: false,
      artifactDetail: null,
      adminTab: 'users',
    })
    await settle()
    globalThis.location.pathname = '/c/s_first'
    history.length = 0
  })

  test('换会话 → 地址跟着换，而且只多一条历史', async () => {
    state.activeKey = 's_second'
    await settle()
    assert.deepEqual(history, [{ kind: 'push', url: '/c/s_second' }])
  })

  test('新对话回 /，第一条消息落库之后才换成真地址', async () => {
    state.pendingNew = true
    state.activeKey = 's_draft'
    await settle()
    assert.equal(location.pathname, '/', '还没落库的键不该出现在地址栏里')

    // send() 之后 refreshSessions 会把 pendingNew 抹掉，这时候它才是一条能发给别人的地址
    state.pendingNew = false
    await settle()
    assert.equal(location.pathname, '/c/s_draft')
  })

  test('作品库：进去、摊开一份、退回清单，各是一条', async () => {
    state.view = 'artifacts'
    await settle()
    state.artifactDetail = { meta: { id: 'a_1' } }
    await settle()
    state.artifactDetail = null
    await settle()
    assert.deepEqual(history.map((entry) => entry.url), ['/artifacts', '/artifacts/a_1', '/artifacts'])
  })

  test('管理台换页也是换地址 —— 刷新之后还在同一页', async () => {
    state.view = 'admin'
    state.adminTab = 'usage'
    await settle()
    assert.equal(location.pathname, '/admin/usage')
  })

  /**
   * 会话是"先切过去、再等历史回来"的。切过去那一刻 `pendingNew` 可能还是 true
   * （本地列表里没有它：搜索结果、别的项目、已归档），照直写就会先写出一条 `/`，
   * 等历史回来再写一条 `/c/<key>` —— 用户点了一次，返回键要按两下。
   */
  test('加载途中的半截状态不写进历史', async () => {
    state.loadingSession = true
    state.activeKey = 's_from_search'
    state.pendingNew = true
    await settle()
    assert.deepEqual(history, [], '加载中不该写地址')

    state.pendingNew = false
    state.loadingSession = false
    await settle()
    assert.deepEqual(history, [{ kind: 'push', url: '/c/s_from_search' }], '落定之后只写一条')
  })

  /**
   * 启动那一段地址是**输入**不是输出：那时候正照着地址往状态上搬
   * （见 bootAfterLogin），反手再写一遍就会把用户粘进来的那条链接顶掉。
   */
  test('booted 之前一个字都不写', async () => {
    state.booted = false
    state.view = 'artifacts'
    await settle()
    assert.deepEqual(history, [])
  })
})
