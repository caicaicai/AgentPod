/**
 * 分享的两条**真实地址**：`/s/<token>` 与 `/market`。
 *
 * 这个界面没有路由器（见 web/src/lib/route.js 的说明），所以"当前是不是一条公开路径"
 * 全靠一次对 `location.pathname` 的判断。判错的后果分两种，都不会报错：
 *   - 该认没认 → 访客拿到的是普通应用外壳，也就是一个弹着登录框的分享页；
 *   - 不该认认了 → 用户自己的对话页被当成分享页，整块界面消失。
 *
 * 两种都只有人点进去才看得见，所以值得钉住。
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { MARKET_PATH, publicRoute, shareUrl } from '../web/src/lib/route.js'

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

describe('公开路径识别', () => {
  test('/s/<token> 认出来，并把 token 取干净', () => {
    at('/s/s_112233445566778899aabbcc')
    assert.deepEqual(publicRoute(), { name: 'share', token: 's_112233445566778899aabbcc' })
  })

  test('末尾多一条斜杠也认 —— 用户复制链接时很容易带上', () => {
    at('/s/s_112233445566778899aabbcc/')
    assert.equal(publicRoute().token, 's_112233445566778899aabbcc')
  })

  test('百分号编码解回来；解不开时不抛异常，交给下游当"查无此链接"', () => {
    at('/s/s_%31%32%33')
    assert.equal(publicRoute().token, 's_123')
    at('/s/%E0%A4%A')
    assert.equal(publicRoute().name, 'share', '坏编码不该让整个界面白屏')
  })

  test('/market 认出来，带不带尾斜杠都一样', () => {
    at(MARKET_PATH)
    assert.deepEqual(publicRoute(), { name: 'market' })
    at(`${MARKET_PATH}/`)
    assert.deepEqual(publicRoute(), { name: 'market' })
  })

  test('普通路径一律回 null —— 认错了会把用户自己的界面整块换掉', () => {
    for (const path of ['/', '/index.html', '/marketing', '/s', '/session/s_1', '/assets/index.js']) {
      at(path)
      assert.equal(publicRoute(), null, `${path} 不该被当成公开页`)
    }
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
