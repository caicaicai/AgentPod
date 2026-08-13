/**
 * 粘性租约表：谁能拿回上一轮驻留下来的那个沙盒句柄。
 *
 * ── 为什么这个文件值得单独存在 ──────────────────────────────────────────
 *
 * 这张表交出去的是 `{ leaseId, leaseToken, workerBase }` —— 直接 attach 到一个
 * **还活着、还挂着别人工作区**的沙盒所需要的全部东西。所以键怎么算不是实现细节，
 * 是隔离边界本身。
 *
 * 它真的错过一次：`claim/keep/drop/forget` 的形参当时叫 `erp`，而所有调用方
 * （sandbox/client.js）传的都是 `username`。解构出来永远是 undefined，键退化成
 * `"undefined<分隔符>sessionKey"` —— 也就是**只按 sessionKey 分**。而 sessionKey
 * 是客户端自己选的，于是"报上别人的 sessionKey 就能拿到别人的沙盒"。
 *
 * 那次谁都没发现，因为：
 *   - 没有一条用例直接调这几个方法（上层用例只跑单用户，单用户下退化的键照样自洽）；
 *   - 文件里有字面 NUL 字节当分隔符，ripgrep 把它判成二进制**整个跳过**，
 *     搜 `erp` 时它一条都不回。
 *
 * 所以这里从**两个用户**入手，而不是从"功能好不好使"入手。
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { createStickyLeases } from '../src/sandbox/sticky.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

let sticky
beforeEach(() => { sticky = createStickyLeases({ logger: silentLogger }) })

/** 走一遍"认领 → 驻留"，把一个句柄存进去 */
function park({ username, sessionKey, runId, leaseId }) {
  const claim = sticky.claim({ username, sessionKey, runId })
  assert.equal(claim.owner, true, `${username} 没拿到认领权`)
  assert.equal(sticky.keep({ username, sessionKey, runId, handle: { leaseId, expiresAt: Date.now() + 60_000 } }), true)
  return claim
}

describe('键里必须有 username', () => {
  /**
   * 这一条就是那次事故的形状。**sessionKey 完全相同**是刻意的：
   * 它是客户端自己选的，攻击者想撞就能撞。
   */
  test('两个人用同一个 sessionKey，互相拿不到对方的句柄', () => {
    park({ username: 'zhangsan', sessionKey: 's_same', runId: 'r1', leaseId: 'lease-of-zhangsan' })

    // 李四报上完全一样的 sessionKey
    const stolen = sticky.claim({ username: 'lisi', sessionKey: 's_same', runId: 'r2' })
    assert.equal(stolen.owner, true, '李四该正常走自己的新建路径')
    assert.equal(stolen.handle, null, '把张三的租约句柄交出去了 —— 这是跨租户接管')

    // 张三自己回来还拿得到
    const mine = sticky.claim({ username: 'zhangsan', sessionKey: 's_same', runId: 'r3' })
    assert.equal(mine.handle?.leaseId, 'lease-of-zhangsan')
  })

  test('李四也覆盖不掉张三那一条', () => {
    park({ username: 'zhangsan', sessionKey: 's_same', runId: 'r1', leaseId: 'lease-of-zhangsan' })
    park({ username: 'lisi', sessionKey: 's_same', runId: 'r2', leaseId: 'lease-of-lisi' })

    assert.equal(sticky.claim({ username: 'zhangsan', sessionKey: 's_same', runId: 'r3' }).handle?.leaseId, 'lease-of-zhangsan')
    assert.equal(sticky.claim({ username: 'lisi', sessionKey: 's_same', runId: 'r4' }).handle?.leaseId, 'lease-of-lisi')
  })

  /**
   * username 缺失时**不能退化成"大家共用一条"**。
   *
   * 退化正是上一次的表现：所有人的键前缀都是 `undefined`，于是同 sessionKey 即同一条。
   * 真出现这种调用（漏传参数）时，宁可各自独立、句柄拿不回来（顶多少一次复用），
   * 也不能让两个人共用一条。
   */
  test('漏传 username 时不会让所有人共用一条', () => {
    park({ username: undefined, sessionKey: 's_same', runId: 'r1', leaseId: 'orphan' })
    // 有名有姓的那个人不该看见它
    assert.equal(sticky.claim({ username: 'zhangsan', sessionKey: 's_same', runId: 'r2' }).handle, null)
  })

  test('同一个人的不同会话也互不干扰', () => {
    park({ username: 'zhangsan', sessionKey: 's_a', runId: 'r1', leaseId: 'lease-a' })
    park({ username: 'zhangsan', sessionKey: 's_b', runId: 'r2', leaseId: 'lease-b' })

    assert.equal(sticky.claim({ username: 'zhangsan', sessionKey: 's_a', runId: 'r3' }).handle?.leaseId, 'lease-a')
    assert.equal(sticky.claim({ username: 'zhangsan', sessionKey: 's_b', runId: 'r4' }).handle?.leaseId, 'lease-b')
  })

  /**
   * 拼键的分隔符要挡住"错位相同"：`a|b` + `c` 与 `a` + `b|c` 不能是同一个键。
   * username 的字符集本来就窄（见 persistence/paths.js 的 SEGMENT_RE），
   * 但 sessionKey 宽得多，所以这条不是纯理论。
   */
  test('分隔符挡得住错位拼接', () => {
    park({ username: 'ab', sessionKey: 'c', runId: 'r1', leaseId: 'first' })
    assert.equal(sticky.claim({ username: 'a', sessionKey: 'bc', runId: 'r2' }).handle, null)
  })
})

describe('认领权', () => {
  test('另一个 run 正占着时，第二个拿不到认领权，也就不该驻留', () => {
    sticky.claim({ username: 'zhangsan', sessionKey: 's_1', runId: 'r1' })
    const second = sticky.claim({ username: 'zhangsan', sessionKey: 's_1', runId: 'r2' })
    assert.deepEqual(second, { owner: false, handle: null })

    // 没认领权就写不进去 —— 否则它会盖掉 r1 刚驻留好的沙盒
    assert.equal(sticky.keep({ username: 'zhangsan', sessionKey: 's_1', runId: 'r2', handle: { leaseId: 'x' } }), false)
  })

  test('过期的句柄当作没有，让本轮走干净的新建路径', () => {
    sticky.claim({ username: 'zhangsan', sessionKey: 's_1', runId: 'r1' })
    sticky.keep({ username: 'zhangsan', sessionKey: 's_1', runId: 'r1', handle: { leaseId: 'old', expiresAt: Date.now() - 1 } })

    assert.equal(sticky.claim({ username: 'zhangsan', sessionKey: 's_1', runId: 'r2' }).handle, null)
  })

  test('drop 清掉句柄并解锁，之后别人才拿得到这个键', () => {
    park({ username: 'zhangsan', sessionKey: 's_1', runId: 'r1', leaseId: 'l1' })
    sticky.claim({ username: 'zhangsan', sessionKey: 's_1', runId: 'r2' })
    assert.equal(sticky.drop({ username: 'zhangsan', sessionKey: 's_1', runId: 'r2' }), true)
    assert.equal(sticky.claim({ username: 'zhangsan', sessionKey: 's_1', runId: 'r3' }).handle, null)
  })
})
