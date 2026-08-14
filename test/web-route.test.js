/**
 * 界面的地址：`/`、`/c/<key>`、`/artifacts[/<id>]`、`/admin[/<tab>]`、`/market`、`/s/<token>`。
 *
 * 这两个纯函数（parsePath / pathFor）是地址与界面状态之间**唯一**的一层翻译，
 * 而它们错了都不会报错，只会让人看到一个说不通的界面：
 *   - 认错公开路径 → 访客拿到普通应用外壳，也就是一个弹着登录框的分享页；
 *     或者反过来，用户自己的对话页被当成分享页，整块界面消失；
 *   - 认错应用路径 → 刷新之后落到另一页（或者干脆落回首页，那正是这套地址要解决的事）；
 *   - 两边对不上（parsePath 认得、pathFor 拼不出来）→ 地址栏和界面各说各的，
 *     而**下一次刷新会以地址栏为准**，于是一个能看的页面刷新之后就没了。
 *
 * 服务端那份白名单（src/http/server.js 的 APP_PATHS）必须跟着这里走：
 * 这边认了而那边没回 HTML 的话，应用里点得进去、刷新就 404。
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { ADMIN_TABS, MARKET_PATH, parsePath, pathFor, shareUrl } from '../web/src/lib/route.js'

/**
 * route.js 只读 `location` 的两个字段，所以给一个最小替身就够 ——
 * 为这个引一整套 jsdom，是拿一个大依赖去换两行属性。
 */
const original = globalThis.location
function at(pathname, origin = 'https://pod.example.com') {
  globalThis.location = { pathname, origin }
}
afterEach(() => {
  if (original === undefined) delete globalThis.location
  else globalThis.location = original
})

describe('地址 → 路由', () => {
  test('/s/<token> 认出来，并把 token 取干净', () => {
    assert.deepEqual(parsePath('/s/s_112233445566778899aabbcc'), {
      name: 'share', token: 's_112233445566778899aabbcc',
    })
  })

  test('末尾多一条斜杠也认 —— 用户复制链接时很容易带上', () => {
    assert.equal(parsePath('/s/s_112233445566778899aabbcc/').token, 's_112233445566778899aabbcc')
    assert.deepEqual(parsePath(`${MARKET_PATH}/`), { name: 'market' })
    assert.deepEqual(parsePath('/artifacts/'), { name: 'artifacts', artifactId: '' })
  })

  test('百分号编码解回来；解不开时不抛异常，交给下游当"查无此物"', () => {
    assert.equal(parsePath('/s/s_%31%32%33').token, 's_123')
    assert.equal(parsePath('/s/%E0%A4%A').name, 'share', '坏编码不该让整个界面白屏')
    assert.equal(parsePath('/c/s_%31').sessionKey, 's_1')
  })

  test('对话：/ 是新对话，/c/<key> 是某一条', () => {
    assert.deepEqual(parsePath('/'), { name: 'chat', sessionKey: '' })
    assert.deepEqual(parsePath('/c/s_abc'), { name: 'chat', sessionKey: 's_abc' })
  })

  test('作品库：带不带 id 都认', () => {
    assert.deepEqual(parsePath('/artifacts'), { name: 'artifacts', artifactId: '' })
    assert.deepEqual(parsePath('/artifacts/a_1'), { name: 'artifacts', artifactId: 'a_1' })
  })

  /** 手改地址、旧链接、拼错的页名都会走到这里。落到第一页，而不是一块空白 */
  test('管理台：不认识的页名落回第一页', () => {
    assert.deepEqual(parsePath('/admin'), { name: 'admin', tab: 'users' })
    for (const tab of ADMIN_TABS) assert.equal(parsePath(`/admin/${tab}`).tab, tab)
    assert.equal(parsePath('/admin/nope').tab, 'users')
  })

  /**
   * 认不出来的一律当"回到对话"。
   * 空白页或者报错页都不合适：这时候用户手里那条链接已经没救了，
   * 而"进到了首页"是他一定看得懂的结果。
   */
  test('认不出来的路径落回对话', () => {
    for (const path of ['/index.html', '/marketing', '/s', '/session/s_1', '/nope/nope']) {
      assert.deepEqual(parsePath(path), { name: 'chat', sessionKey: '' }, `${path} 该落回对话`)
    }
  })
})

/**
 * 访客外壳（不登录也能看的那两页）由 App.vue 按 `name` 判：`share` 一定是，
 * `market` 看本地有没有身份痕迹。所以这里钉的是**别的路径不能被认成这两个** ——
 * 认错了的表现是用户自己的对话页整块变成一份别人的分享。
 */
describe('访客能落在哪几条上', () => {
  test('只有 /s/<token> 和 /market', () => {
    assert.equal(parsePath('/s/s_abc').name, 'share')
    assert.equal(parsePath(MARKET_PATH).name, 'market')
    for (const path of ['/', '/c/s_1', '/artifacts', '/artifacts/a_1', '/admin/users', '/marketing']) {
      const { name } = parsePath(path)
      assert.ok(name !== 'share' && name !== 'market', `${path} 不该被当成公开页`)
    }
  })
})

describe('状态 → 地址', () => {
  const base = { view: 'chat', pendingNew: false, activeKey: 's_abc', adminTab: 'users', artifactDetail: null }

  test('对话：落库了才给真地址', () => {
    assert.equal(pathFor(base), '/c/s_abc')
    /**
     * 新对话的键这时候只存在于前端：复制出去别人打不开，刷新自己也回不来。
     * 一个只有当事人那一个标签页认得的地址，不该出现在地址栏里。
     */
    assert.equal(pathFor({ ...base, pendingNew: true }), '/')
    assert.equal(pathFor({ ...base, activeKey: '' }), '/')
  })

  test('作品库：摊开哪一份就带哪一个 id', () => {
    assert.equal(pathFor({ ...base, view: 'artifacts' }), '/artifacts')
    assert.equal(
      pathFor({ ...base, view: 'artifacts', artifactDetail: { meta: { id: 'a_1' } } }),
      '/artifacts/a_1',
    )
  })

  test('市场与管理台', () => {
    assert.equal(pathFor({ ...base, view: 'market' }), MARKET_PATH)
    assert.equal(pathFor({ ...base, view: 'admin', adminTab: 'usage' }), '/admin/usage')
    assert.equal(pathFor({ ...base, view: 'admin', adminTab: 'nope' }), '/admin/users')
  })

  /**
   * 两个方向必须闭合：pathFor 拼出来的每一条，parsePath 都要认回同一件事。
   * 对不上的表现是"点进去好好的，刷新之后到了别处"—— 而那正是这套地址要消灭的东西。
   */
  test('拼出来的地址一定认得回来', () => {
    const cases = [
      [base, 'chat'],
      [{ ...base, pendingNew: true }, 'chat'],
      [{ ...base, view: 'artifacts' }, 'artifacts'],
      [{ ...base, view: 'artifacts', artifactDetail: { meta: { id: 'a_1' } } }, 'artifacts'],
      [{ ...base, view: 'market' }, 'market'],
      [{ ...base, view: 'admin', adminTab: 'groups' }, 'admin'],
    ]
    for (const [state, name] of cases) {
      const route = parsePath(pathFor(state))
      assert.equal(route.name, name, pathFor(state))
      if (name === 'chat') assert.equal(route.sessionKey, state.pendingNew ? '' : state.activeKey)
      if (name === 'artifacts') assert.equal(route.artifactId, state.artifactDetail?.meta?.id || '')
      if (name === 'admin') assert.equal(route.tab, state.adminTab)
    }
  })

  test('带特殊字符的键不会把地址拆断', () => {
    const path = pathFor({ ...base, activeKey: 's_a/b' })
    assert.equal(path, '/c/s_a%2Fb')
    assert.equal(parsePath(path).sessionKey, 's_a/b')
  })
})

describe('链接拼装', () => {
  /**
   * 用 `location.origin` 而不是服务端下发的地址：反向代理后面，
   * 服务端看到的 Host 可能是内网名字，而访客要复制的是**他自己浏览器里那个**域名。
   */
  test('跟着当前 origin 走', () => {
    at('/', 'https://pod.example.com')
    assert.equal(shareUrl('s_abc'), 'https://pod.example.com/s/s_abc')
    at('/', 'http://127.0.0.1:8787')
    assert.equal(shareUrl('s_abc'), 'http://127.0.0.1:8787/s/s_abc')
  })
})
