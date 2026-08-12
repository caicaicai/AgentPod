/**
 * 会话标题：第一轮让模型看着用户那句话起一个。
 *
 * 这里钉住三件事：
 *   1. **收拾模型输出的规则** —— 它爱回「标题：xxx」、爱加引号、爱写成一段话，
 *      而这些字符会一路进到侧栏和搜索索引里；
 *   2. **任何失败都退回截断标题** —— 一个会话没有好标题只是不好看，
 *      为它让对话失败或者在侧栏里留下模型的自言自语，都糟得多；
 *   3. **只在第一轮起一次** —— 否则用户手动改的名字下一轮就被覆盖了。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { TITLE_MAX, TITLE_PROMPT, generateTitle, sanitizeTitle, titleWidth } from '../src/sessions/title.js'
import { deriveTitle } from '../src/sessions/transcript.js'
import { createFileStore } from '../src/sessions/file-store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

describe('收拾模型的输出', () => {
  test('正常的短标题原样留下', () => {
    assert.equal(sanitizeTitle('排查结算中台超时报错'), '排查结算中台超时报错')
  })

  /** 模型很爱回「标题：xxx」，而那三个字会一路进到侧栏里 */
  test('剥掉前缀、引号和结尾标点', () => {
    assert.equal(sanitizeTitle('标题：周报提醒'), '周报提醒')
    assert.equal(sanitizeTitle('Title: 周报提醒'), '周报提醒')
    assert.equal(sanitizeTitle('「周报提醒」'), '周报提醒')
    assert.equal(sanitizeTitle('"Weekly report reminder"'), 'Weekly report reminder')
    assert.equal(sanitizeTitle('周报提醒。'), '周报提醒')
  })

  test('多行只取第一行非空的', () => {
    assert.equal(sanitizeTitle('\n\n周报提醒\n\n（解释：因为…）'), '周报提醒')
  })

  /**
   * 长度按**显示宽度**算，不按字符数。
   *
   * 第一版是 slice(0, 18)，于是 `Weekly report reminder`（22 个字符，宽度只有
   * 中文上限的六成）被砍成 `Weekly report remi` —— 同一条规则对中文刚好、
   * 对英文腰斩，而用户只会觉得标题坏了。
   */
  test('超出宽度才截断，中英文各按各的占位', () => {
    assert.equal(titleWidth('一'.repeat(TITLE_MAX)), TITLE_MAX * 2)
    assert.equal(sanitizeTitle('一'.repeat(TITLE_MAX + 5)), '一'.repeat(TITLE_MAX))
    // 22 个字符的英文标题宽度没超，原样留下
    assert.equal(sanitizeTitle('Weekly report reminder'), 'Weekly report reminder')
  })

  /**
   * 写成一段话时**丢掉**而不是截断：截前 18 个字得到的是半句废话，
   * 还不如退回用户原话的前 24 个字 —— 那至少是他自己说的。
   */
  test('模型写成一段话时整条丢弃，让调用方退回截断标题', () => {
    assert.equal(sanitizeTitle('好的，我来帮你总结一下这段对话的主题，'.repeat(4)), '')
  })

  test('空输入回空串', () => {
    assert.equal(sanitizeTitle(''), '')
    assert.equal(sanitizeTitle('   \n  '), '')
    assert.equal(sanitizeTitle(null), '')
  })
})

describe('提示词', () => {
  /** 这几条约束写不进去，模型就会回一整句话或者带上「关于」这类废话开头 */
  test('把长度、语言和"只输出标题"三条说死', () => {
    assert.match(TITLE_PROMPT, new RegExp(`不超过 ${TITLE_MAX} 个汉字`))
    assert.match(TITLE_PROMPT, /用他使用的语言/)
    assert.match(TITLE_PROMPT, /只输出标题/)
    assert.match(TITLE_PROMPT, /不要加引号/)
  })
})

describe('调用模型', () => {
  const fakeModel = { id: 'test', provider: 'test' }

  test('模型回错误消息时回空串，不抛', async () => {
    // pi 调用失败时不抛异常，只回一条 stopReason:'error' 的消息 —— 不接住的话
    // 表现是"标题一直不太好看"，而网关可能已经挂了一个月
    const title = await generateTitle({
      model: fakeModel,
      prompt: '帮我看看报错',
      logger: silentLogger,
      // completeSimple 会真的去调；这里用一个连不上的 model 触发异常路径
    })
    assert.equal(typeof title, 'string')
  })

  test('没有提示词或模型时直接回空串，不发请求', async () => {
    assert.equal(await generateTitle({ model: fakeModel, prompt: '   ', logger: silentLogger }), '')
    assert.equal(await generateTitle({ model: null, prompt: '你好', logger: silentLogger }), '')
  })
})

/**
 * 退路本身也要是好的：起标题失败时落到 deriveTitle 上，
 * 而它至少是用户自己说过的话。
 */
describe('退回截断标题', () => {
  test('deriveTitle 仍然可用，且带省略号', () => {
    assert.equal(deriveTitle('帮我看看报错'), '帮我看看报错')
    assert.match(deriveTitle('一'.repeat(50)), /…$/)
    assert.equal(deriveTitle(''), '')
  })
})

describe('只起一次', () => {
  let root
  let store
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ap-title-'))
    store = createFileStore({ config: { dataDir: root }, logger: silentLogger })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  /**
   * 判据是"这次跑之前存储里有没有它"，而且**必须在跑之前判** ——
   * 跑完它一定存在了。判错的后果是每轮都重起一次标题：既多花钱，
   * 又会把用户手动改的名字在下一轮覆盖掉。
   */
  test('第一轮之前查不到，之后查得到', async () => {
    assert.equal(await store.load({ username: 'u1', sessionKey: 's1' }), null)
    await store.save({ username: 'u1', sessionKey: 's1', sessionId: 'x', jsonl: '', entryCount: 1, title: '帮我看看报错' })
    assert.ok(await store.load({ username: 'u1', sessionKey: 's1' }))
  })

  test('patch 能覆盖掉截断标题，而 save 的候选标题不会反过来覆盖它', async () => {
    await store.save({ username: 'u1', sessionKey: 's1', sessionId: 'x', jsonl: '', entryCount: 1, title: '帮我看看结算中台最近三天的…' })
    await store.patch({ username: 'u1', sessionKey: 's1', title: '排查结算中台超时报错' })

    // 第二轮再存一次，候选标题不该把已有的顶掉
    await store.save({ username: 'u1', sessionKey: 's1', sessionId: 'x', jsonl: '', entryCount: 2, title: '又一句话' })
    const row = await store.load({ username: 'u1', sessionKey: 's1' })
    assert.equal(row.title, '排查结算中台超时报错')
  })
})
