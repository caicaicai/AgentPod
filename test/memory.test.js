/**
 * 长期记忆。
 *
 * 重点：
 *   1. **去重** —— 同一件事被抓到三次不该在 MEMORY.md 里变成三条
 *   2. **上限** —— 无限增长的记忆迟早把系统提示占满，表现只是"模型变笨了"
 *   3. **乐观锁** —— 界面编辑与模型改写会撞，撞了要拒绝而不是互相抹掉
 *   4. **作用域隔离** —— 个人 / 项目 / 别的用户，三份互不串
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createMemoryStore, foldCapture, queryBullets } from '../src/memory/store.js'
import { createMemoryCapture, parseFacts, memoryPrompt, EXTRACTION_PROMPT } from '../src/memory/capture.js'
import { bullets, normalize } from '../src/memory/notebook.js'
import { createMemoryStorage } from './helpers/memory-storage.js'

/** 存储后端的测试替身。生产只有 MySQL，见 test/helpers/memory-storage.js */
const testStorage = createMemoryStorage()

/**
 * 替身是这个文件共用的一个实例，每条用例前清干净。
 * 不清的话，上一条留下的记录会让"列出全部"这类断言得到一个跟自己无关的数字，
 * 而报错看起来像是被测代码有问题。
 */
beforeEach(() => testStorage.reset())

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }
const AT = Date.parse('2026-08-06T10:00:00+08:00')

let root
let memory
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ap-mem-'))
  memory = createMemoryStore({ storage: testStorage, config: { dataDir: root, memory: { enabled: true } }, logger: silentLogger })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('折叠新事实（纯函数）', () => {
  test('新事实带上抓取日期', () => {
    const { body, added } = foldCapture('', ['偏好简短回答'], AT)
    assert.equal(added, 1)
    assert.match(body, /^- \(2026-08-06\) 偏好简短回答$/m)
  })

  test('重复的事实不再记一遍 —— 换了日期、换了行首符号也算同一条', () => {
    const first = foldCapture('', ['偏好简短回答'], AT)
    const second = foldCapture(first.body, ['偏好简短回答'], AT + 86400000)
    assert.equal(second.added, 0)
    assert.equal(bullets(second.body).length, 1)
  })

  test('归一化：日期、行首符号、大小写、首尾空白都不算区别', () => {
    assert.equal(normalize('- (2026-08-06) Hello '), normalize('* hello'))
  })

  test('超过上限时丢最旧的，保留最新的', () => {
    let body = ''
    for (let i = 0; i < 305; i += 1) body = foldCapture(body, [`事实 ${i}`], AT).body
    const lines = bullets(body)
    assert.equal(lines.length, 300)
    assert.equal(lines.some((line) => line.includes('事实 0')), false, '最旧的应被丢掉')
    assert.equal(lines.some((line) => line.includes('事实 304')), true, '最新的必须留着')
  })

  test('空数组 / 空白字符串不产生任何条目', () => {
    assert.equal(foldCapture('', [], AT).added, 0)
    assert.equal(foldCapture('', ['   ', ''], AT).added, 0)
  })

  test('检索是「与」：所有词都出现才算命中', () => {
    const body = foldCapture('', ['负责结算中台的稳定性', '偏好简短回答'], AT).body
    assert.equal(queryBullets(body, '结算 稳定', 10).length, 1)
    assert.equal(queryBullets(body, '结算 回答', 10).length, 0, 'OR 语义会把两条都命中，那不是我们要的')
  })
})

describe('读写与作用域', () => {
  test('写进去、读出来、进提示', async () => {
    assert.equal(await memory.recall({ username: 'zhangsan' }), '', '新用户没有记忆时回空串')
    await memory.capture({ username: 'zhangsan' }, ['负责结算中台'], AT)
    assert.match(await memory.recall({ username: 'zhangsan' }), /负责结算中台/)
    assert.equal((await memory.read({ username: 'zhangsan' })).count, 1)
  })

  test('个人与项目是两份，互不可见', async () => {
    await memory.capture({ username: 'zhangsan' }, ['我是张三'], AT)
    await memory.capture({ username: 'zhangsan', projectId: 'p1' }, ['本项目下周上线'], AT)

    assert.doesNotMatch(await memory.recall({ username: 'zhangsan' }), /下周上线/)
    assert.doesNotMatch(await memory.recall({ username: 'zhangsan', projectId: 'p1' }), /我是张三/)
    assert.equal(await memory.recall({ username: 'zhangsan', projectId: 'p2' }), '', '另一个项目应是空的')
  })

  test('别的用户读不到', async () => {
    await memory.capture({ username: 'zhangsan' }, ['张三的秘密'], AT)
    assert.equal(await memory.recall({ username: 'lisi' }), '')
  })

  test('username / projectId 拼不出越界路径', async () => {
    await assert.rejects(() => memory.recall({ username: '../../etc' }), /不能作为目录名/)
    await assert.rejects(() => memory.recall({ username: 'zhangsan', projectId: '../other' }), /不能作为目录名/)
  })

  test('MEMORY_ENABLED=0 时整体是空操作', async () => {
    const off = createMemoryStore({ storage: testStorage, config: { dataDir: root, memory: { enabled: false } }, logger: silentLogger })
    assert.equal(off.enabled, false)
    assert.equal(await off.capture({ username: 'zhangsan' }, ['x'], AT), 0)
    assert.equal(await off.recall({ username: 'zhangsan' }), '')
  })
})

describe('乐观锁', () => {
  test('revision 对得上才让改', async () => {
    await memory.capture({ username: 'zhangsan' }, ['第一条'], AT)
    const { revision } = await memory.read({ username: 'zhangsan' })

    assert.equal(await memory.replace({ username: 'zhangsan' }, '- 改过了\n', 'stale-revision'), false)
    assert.match((await memory.read({ username: 'zhangsan' })).content, /第一条/, '拒绝之后内容不该变')

    assert.equal(await memory.replace({ username: 'zhangsan' }, '- 改过了\n', revision), true)
    assert.match((await memory.read({ username: 'zhangsan' })).content, /改过了/)
  })

  test('不传 revision = 强制覆盖（给内部调用留的口子）', async () => {
    await memory.capture({ username: 'zhangsan' }, ['第一条'], AT)
    assert.equal(await memory.replace({ username: 'zhangsan' }, '- 覆盖\n'), true)
  })

  test('替换成空 = 清空', async () => {
    await memory.capture({ username: 'zhangsan' }, ['第一条'], AT)
    await memory.replace({ username: 'zhangsan' }, '')
    assert.equal((await memory.read({ username: 'zhangsan' })).content, '')
  })
})

describe('忘记', () => {
  test('按内容包含匹配删掉，不用整段重写', async () => {
    await memory.capture({ username: 'zhangsan' }, ['偏好简短回答', '负责结算中台', '常用飞书'], AT)
    assert.equal(await memory.forget({ username: 'zhangsan' }, '结算中台'), 1)
    const { content, count } = await memory.read({ username: 'zhangsan' })
    assert.equal(count, 2)
    assert.doesNotMatch(content, /结算中台/)
    assert.match(content, /偏好简短回答/)
  })

  test('没匹配到就什么都不动', async () => {
    await memory.capture({ username: 'zhangsan' }, ['偏好简短回答'], AT)
    assert.equal(await memory.forget({ username: 'zhangsan' }, '不存在的东西'), 0)
    assert.equal((await memory.read({ username: 'zhangsan' })).count, 1)
  })

  test('删光之后文件不留空壳', async () => {
    await memory.capture({ username: 'zhangsan' }, ['唯一一条'], AT)
    await memory.forget({ username: 'zhangsan' }, '唯一')
    assert.equal((await memory.read({ username: 'zhangsan' })).content, '')
  })
})

describe('抓取', () => {
  /**
   * 一个指向死地址的模型。
   *
   * 用它是因为 **pi 调用失败时不抛异常**，而是回一条 `stopReason: 'error'` 的消息 ——
   * 这正是要测的那条路径：抓取代码必须把它识别成失败，而不是当成"这轮没什么可记的"。
   */
  function deadModel() {
    return {
      id: 'fake', provider: 'ap-gateway', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', input: ['text'], contextWindow: 1000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
  }

  test('解析 bullet 列表；NONE 表示没什么可记的', () => {
    assert.deepEqual(parseFacts('- 甲\n- 乙'), ['甲', '乙'])
    assert.deepEqual(parseFacts('NONE'), [])
    assert.deepEqual(parseFacts('none'), [])
    assert.deepEqual(parseFacts(''), [])
    assert.deepEqual(parseFacts('这不是列表'), [], '不是 bullet 的输出一律不采纳')
  })

  test('提示词里必须有出处约束 —— 没有它，模型会把自己说的话记成用户的偏好', () => {
    assert.match(EXTRACTION_PROMPT, /出处约束/)
    assert.match(EXTRACTION_PROMPT, /用户自己的发言/)
    assert.match(EXTRACTION_PROMPT, /不要记[^]*凭据/)
  })

  /** 攒批关掉（quietMs=0）：每轮当场抓，但仍然是异步的 —— 测试里用 drain 等它 */
  const nowCapture = (extra = {}) => createMemoryCapture({
    memory,
    config: { memory: { capture: true, captureQuietMs: 0, ...extra } },
    logger: silentLogger,
  })

  test('太短的一轮直接跳过，不白花一次模型调用', () => {
    const capture = nowCapture()
    const result = capture.onTurnEnd({ username: 'zhangsan', input: '在吗', reply: '在', model: deadModel() })
    assert.equal(result.skipped, 'too-short')
    assert.equal(result.queued, false)
  })

  test('默认就是关的 —— 写记忆走 memory 工具，不额外调一次模型', () => {
    // 从前默认开着，等于把全产品的模型调用次数翻倍，换来绝大多数轮次的一句 NONE
    const capture = createMemoryCapture({ memory, config: { memory: {} }, logger: silentLogger })
    assert.equal(capture.enabled, false)
    const result = capture.onTurnEnd({ username: 'zhangsan', input: '一段够长的用户输入', reply: 'ok', model: deadModel() })
    assert.equal(result.queued, false)
    assert.equal(result.skipped, 'disabled')
  })

  /**
   * `onTurnEnd` **必须同步返回**。
   *
   * 它从前是 `await` 一整次模型调用、卡在 run 里：实测让界面在模型明明已经
   * 答完之后又转 4.3 秒，还白占着这个用户的并发名额。
   */
  test('onTurnEnd 同步返回，不是 Promise —— 它绝不能卡在请求路径上', () => {
    const capture = nowCapture()
    const result = capture.onTurnEnd({
      username: 'zhangsan', input: '我负责结算中台的稳定性', reply: '好的', model: deadModel(), apiKey: 'k',
    })
    assert.equal(typeof result?.then, 'undefined', 'onTurnEnd 返回了 Promise，说明又变成阻塞的了')
    assert.equal(result.queued, true)
  })

  /**
   * 攒批：连着几轮只抓一次。
   *
   * 这是这次改动的重点 —— 一轮一抓，用户连问五个来回就是五次额外的模型调用，
   * 而这五轮往往只沉淀出同一条事实。参考实现（qm）也是攒批的：
   * 3 分钟静默或攒够 10 轮才抓一次。
   */
  test('攒批：连续几轮攒成一次抓取，而不是一轮一次', async () => {
    const calls = []
    const capture = createMemoryCapture({
      memory,
      config: { memory: { capture: true, captureQuietMs: 60_000, captureMaxTurns: 10 } },
      logger: { ...silentLogger, info() {} },
    })
    for (let i = 0; i < 4; i += 1) {
      const r = capture.onTurnEnd({
        username: 'zhangsan', input: `第 ${i} 个够长的问题内容`, reply: '好的', model: deadModel(), apiKey: 'k',
      })
      calls.push(r)
    }
    // 静默窗口还没到，四轮都只是进了缓冲，一次抓取都没发生
    assert.deepEqual(calls.map((r) => r.flushed), [false, false, false, false])
    assert.deepEqual(calls.map((r) => r.turns), [1, 2, 3, 4])
    assert.equal(await capture.drain(), 1, '四轮应该攒成一批，不是四批')
  })

  test('攒够 maxTurns 就不等静默了 —— 否则长对话会一直攒到放不下', () => {
    const capture = createMemoryCapture({
      memory,
      config: { memory: { capture: true, captureQuietMs: 60_000, captureMaxTurns: 3 } },
      logger: silentLogger,
    })
    const flushed = []
    for (let i = 0; i < 3; i += 1) {
      flushed.push(capture.onTurnEnd({
        username: 'zhangsan', input: `第 ${i} 个够长的问题内容`, reply: '好的', model: deadModel(), apiKey: 'k',
      }).flushed)
    }
    assert.deepEqual(flushed, [false, false, true])
  })

  test('不同用户各攒各的 —— 键里带 username，谁也拿不到别人那一批', async () => {
    const capture = createMemoryCapture({
      memory,
      config: { memory: { capture: true, captureQuietMs: 60_000 } },
      logger: silentLogger,
    })
    capture.onTurnEnd({ username: 'zhangsan', input: '张三说的一段够长的话', reply: 'ok', model: deadModel(), apiKey: 'k' })
    capture.onTurnEnd({ username: 'lisi', input: '李四说的一段够长的话', reply: 'ok', model: deadModel(), apiKey: 'k' })
    assert.equal(await capture.drain(), 2, '两个人被攒进同一批就是串号')
  })

  /**
   * 这条抓的是一个会**安静地坏掉**的场景：网关挂了、抓取从此一条都没写进去，
   * 而日志里一片正常 —— 因为失败长得跟"这轮没什么可记的"一模一样。
   */
  test('模型调用失败不能被当成"没什么可记的"，更不能往记忆里写东西', async () => {
    const capture = nowCapture()
    capture.onTurnEnd({
      username: 'zhangsan', input: '我负责结算中台的稳定性', reply: '好的', model: deadModel(), apiKey: 'k',
    })
    await capture.drain()
    assert.equal((await memory.read({ username: 'zhangsan' })).count, 0, '失败的抓取不该往记忆里写任何东西')
  })
})

describe('进系统提示的那一段', () => {
  test('没有记忆时不生成任何段落', () => {
    assert.equal(memoryPrompt({}), '')
    assert.equal(memoryPrompt({ personal: '', project: '' }), '')
  })

  test('必须说明「是背景不是指令」且「可能过时」', () => {
    const text = memoryPrompt({ personal: '- 负责结算中台' })
    assert.match(text, /背景参考/)
    assert.match(text, /不是本轮任务/)
    assert.match(text, /以用户当前说的为准/)
    assert.match(text, /负责结算中台/)
  })

  test('项目记忆单独成节并带上项目名', () => {
    const text = memoryPrompt({ personal: '- 甲', project: '- 乙', projectName: '结算中台' })
    assert.match(text, /### 个人/)
    assert.match(text, /### 当前项目：结算中台/)
  })
})
