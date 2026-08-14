/**
 * 流式渲染在**浏览器那一侧**的两条硬约定。
 *
 * 为什么值得单独有一个文件：这两件事服务端全对也照样会坏，而坏掉的样子
 * 恰恰会被误判成网络或上游的问题 —— 界面冻住十几秒、最后整段一起蹦出来，
 * 而服务端日志、SSE 抓包、帧到达时刻全都正常。查这个 bug 的成本极高，
 * 所以把它钉在测试里，而不是靠"记得别那么写"。
 *
 * vue 装在 web/node_modules 下（前端是独立的 npm 工程），所以从那儿解析。
 * 解析不到就跳过：根目录 `npm test` 不该因为没跑过 `npm run web:install` 就红。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web')
const require = createRequire(path.join(webDir, 'noop.js'))

let vue = null
try {
  /**
   * `pathToFileURL` 不能省：Windows 上 `require.resolve` 回的是 `C:\…`，
   * 而 ESM 的 import() 只认 file://。少了它这里会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME，
   * 被下面这个 catch 吞掉 —— 于是整组用例在 Windows 上**一直是跳过的**，
   * 而跳过的理由显示成"没装 web/node_modules"，谁也不会去查。
   */
  vue = await import(pathToFileURL(require.resolve('vue')).href)
} catch {
  vue = null
}

describe('流式渲染（浏览器侧）', { skip: vue ? false : '没装 web/node_modules（先跑 npm run web:install）' }, () => {
  const { reactive, effect } = vue || {}

  /** 数一次渲染要读的那些字段被改动之后重绘了几次 */
  const counter = () => {
    const live = reactive({ blocks: [], meta: '' })
    let renders = 0
    effect(() => {
      // 与 AssistantMessage.vue 读的是同一批字段
      live.blocks.map((b) => b.text ?? b.status)
      renders += 1
    })
    return { live, renders: () => renders }
  }

  /**
   * 这一条就是那个 bug 的最小复现。
   *
   * `push` 进去的是原始对象，`reactive` 只在**读取**时才包代理，
   * 所以手里那个引用改多少次都不触发。
   */
  test('攥着 push 进去的原始对象改 —— 一次重绘都没有（错误写法）', () => {
    const { live, renders } = counter()
    const raw = { type: 'text', text: '' }
    live.blocks.push(raw)

    const after = renders()
    raw.text += '你好'
    raw.text += '，我可以帮你做很多事'
    raw.text += '……（后面还有 100 帧）'
    assert.equal(renders() - after, 0, '这里一旦变成非 0，说明 Vue 改了语义，下面那条约定可以放宽')
  })

  test('用数组里取回的引用改 —— 每次赋值都重绘（正确写法）', () => {
    const { live, renders } = counter()
    live.blocks.push({ type: 'text', text: '' })
    const block = live.blocks[live.blocks.length - 1]

    const after = renders()
    block.text += '你好'
    block.text += '，我可以帮你做很多事'
    assert.equal(renders() - after, 2)
  })

  /**
   * 冻住的**形状**：只有首帧和收尾能看见，中间全部丢掉。
   * 用户的原话是"输出思考、输出你好，卡住，然后突然全吐出来" —— 就是这个。
   */
  test('错误写法下界面只在首帧和收尾动，中间十几秒是死的', () => {
    const { live, renders } = counter()
    const raw = { type: 'text', text: '' }
    live.blocks.push(raw) // 首帧：数组变更，看得见
    const afterFirst = renders()
    for (let i = 0; i < 200; i += 1) raw.text += '字'
    assert.equal(renders() - afterFirst, 0, '中间 200 帧一次都没画')

    live.meta = '耗时 14.3 秒' // 收尾：这才把整段一起带出来
    assert.equal(renders() - afterFirst, 0, 'meta 不在渲染读的字段里，这里不该动')
  })

  /**
   * 工具卡片一直是好的 —— `find()` 走数组的 get 陷阱，拿到的是代理。
   * 正因为它是好的，正文冻住很容易被误判成"上游/网络在憋"而不是渲染。
   */
  test('工具卡片走 find() 拿到的是代理，所以一直正常 —— 这正是误诊的来源', () => {
    const { live, renders } = counter()
    live.blocks.push({ type: 'tool', toolCallId: 'c1', status: 'running' })

    const after = renders()
    const block = live.blocks.find((b) => b.toolCallId === 'c1')
    block.status = 'done'
    assert.equal(renders() - after, 1)
  })
})
