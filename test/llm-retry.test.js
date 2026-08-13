/**
 * 模型调用的退避重试。
 *
 * ── 前提：pi 已经有一整套，我们只补判定 ──────────────────────────────
 *
 * `AgentSession._handleRetryableError` 负责指数退避、发 auto_retry 事件、
 * **重试前把失败的助手消息摘掉**（所以不会重复输出、不会重跑工具）。默认就开着。
 *
 * 卡住的是判定：`_isRetryableError` 拿正则匹配错误文本，只认
 * `429 / 5xx / rate limit / timeout / connection reset` 这些标准说法。
 * 而我们的网关把偶发故障回成 **400 + 中文文案**：
 *     400 模型服务调用失败
 *     400 {"error":{"message":"Already borrowed","type":"BadRequestError","code":400}}
 * 一条都匹配不上 —— 于是一次都不重试，用户看到的是"这东西偶尔会失败"。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { SettingsManager } from '@mariozechner/pi-coding-agent'

import { compilePatterns, matchesExtraPattern, installRetryPolicy } from '../src/models/retry.js'
import { loadConfig } from '../src/config.js'
import { toClientFrames, CLIENT_EVENTS } from '../src/agent/events.js'

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }
/**
 * 测**匹配机制**用的样例，不是默认配置。
 * `模型服务调用失败` 已经从默认值里拿掉了（见下面「网关的通用包装文案不能当可重试特征」），
 * 但机制本身得对任何配进来的特征都成立，所以这里仍拿它当被匹配的样本。
 */
const PATTERNS = compilePatterns(['模型服务调用失败', 'Already borrowed'])

describe('网关特有的可重试错误', () => {
  test('线上真实遇到的两条都认得', () => {
    // 逐字来自调试信息
    assert.equal(matchesExtraPattern('400 模型服务调用失败', PATTERNS), true)
    assert.equal(
      matchesExtraPattern('400 {"error": {"message": "Already borrowed", "code": 400}}', PATTERNS),
      true,
    )
  })

  test('不认识的错误不碰 —— 重试一个真·参数错误只是白等', () => {
    for (const message of [
      '400 model not found: gpt-9',
      '401 Unauthorized',
      'invalid request: messages must not be empty',
      '',
      undefined,
    ]) {
      assert.equal(matchesExtraPattern(message, PATTERNS), false, String(message))
    }
  })

  /**
   * 上下文超了要走压缩，不是重试 —— 拿同样超长的上下文再打三次，
   * 三次必然都失败，还白等 14 秒。pi 自己挡了这一类，我们的补充不能把它放回来。
   */
  test('看着像上下文超限的一律不重试，哪怕撞上了我们的特征词', () => {
    const nasty = compilePatterns(['模型服务调用失败'])
    assert.equal(
      matchesExtraPattern('模型服务调用失败: context length exceeded', nasty),
      false,
      '上下文溢出被当成可重试了',
    )
    assert.equal(matchesExtraPattern('prompt is too long', PATTERNS), false)
  })

  test('写坏的正则被跳过，不影响其余特征，也不抛', () => {
    const compiled = compilePatterns(['Already borrowed', '([unclosed', ''], silent)
    assert.equal(compiled.length, 1)
    assert.equal(matchesExtraPattern('Already borrowed', compiled), true)
  })
})

/**
 * 这一条盯的是**我们包了 pi 的私有方法**这件事。
 * pi 升级把 `_isRetryableError` 改名了，这里会红 —— 而不是线上悄悄不再重试。
 */
describe('挂到 pi 的判定上', () => {
  const makeSession = () => ({
    _isRetryableError(message) {
      return /429|rate.?limit|timeout/i.test(String(message?.errorMessage || ''))
    },
  })

  test('pi 说可以重试的，照旧可以（我们只做加法）', () => {
    const session = makeSession()
    installRetryPolicy(session, { patterns: PATTERNS, logger: silent })
    assert.equal(session._isRetryableError({ errorMessage: '429 rate limit' }), true)
  })

  test('pi 说不行、但命中我们的特征 → 重试', () => {
    const session = makeSession()
    assert.equal(session._isRetryableError({ errorMessage: '400 模型服务调用失败' }), false, '前提变了')
    installRetryPolicy(session, { patterns: PATTERNS, logger: silent })
    assert.equal(session._isRetryableError({ errorMessage: '400 模型服务调用失败' }), true)
  })

  test('两边都不认的，还是不重试', () => {
    const session = makeSession()
    installRetryPolicy(session, { patterns: PATTERNS, logger: silent })
    assert.equal(session._isRetryableError({ errorMessage: '401 Unauthorized' }), false)
  })

  test('方法不在了就告警返回 false，不抛 —— 少了重试也不能让对话跑不起来', () => {
    const warnings = []
    const loud = { ...silent, warn: (msg) => warnings.push(msg) }
    assert.equal(installRetryPolicy({}, { patterns: PATTERNS, logger: loud }), false)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /_isRetryableError/)
  })

  test('没有补充特征时不去动 pi 的方法', () => {
    const session = makeSession()
    const before = session._isRetryableError
    assert.equal(installRetryPolicy(session, { patterns: [], logger: silent }), false)
    assert.equal(session._isRetryableError, before, '不该无谓地包一层')
  })

  /**
   * 上面用的是手写的假 session。这条确认**真的 AgentSession 上这个方法还在**，
   * 否则前面几条测的就是一个我们自己造的东西。
   */
  test('真的 AgentSession 原型上确实有这个方法', async () => {
    const { AgentSession } = await import('@mariozechner/pi-coding-agent')
    assert.equal(
      typeof AgentSession?.prototype?._isRetryableError,
      'function',
      'pi 把 _isRetryableError 改名/删了 —— src/models/retry.js 要跟着改',
    )
  })
})

describe('重试的次数与间隔可配置', () => {
  test('pi 认我们塞进去的 retry 设置', () => {
    const manager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 5, baseDelayMs: 500 } })
    assert.deepEqual(manager.getRetrySettings(), { enabled: true, maxRetries: 5, baseDelayMs: 500 })
  })

  // 只求校验能过：这一组测的是 retry，不是沙盒
  // AUTH_MODE / LLM_MODE 的默认值（password / platform）各自还有必填项，
  // 不显式给一对就会在读到重试配置之前被校验拦下
  const BASE = { SANDBOX_MODE: 'none', AUTH_MODE: 'dev', LLM_MODE: 'faux' }

  test('config 默认值：开、3 次、2 秒起步', () => {
    const config = loadConfig({ env: { ...BASE }, cwd: '/nonexistent' })
    assert.equal(config.llm.retry.enabled, true)
    assert.equal(config.llm.retry.maxRetries, 3)
    assert.equal(config.llm.retry.baseDelayMs, 2000)
    assert.ok(config.llm.retry.extraPatterns.includes('Already borrowed'))
  })

  /**
   * 这条守的是一次**被证伪的判断**。
   *
   * `模型服务调用失败` 一度是默认特征之一 —— 当时以为它是"网关在表达偶发故障"。
   * 追到上游日志才看清：它是网关对**任何**上游失败的统一包装，第一个抓到的实例
   * 是彻头彻尾的永久性错误（系统提示发成了 `role: "developer"`，上游 schema 不认）。
   * 拿它当可重试特征 = 对着一个必然失败的请求白等 14 秒，还多打三次上游。
   */
  test('网关的通用包装文案不能当可重试特征', () => {
    const config = loadConfig({ env: { ...BASE }, cwd: '/nonexistent' })
    assert.ok(
      !config.llm.retry.extraPatterns.includes('模型服务调用失败'),
      '通用包装文案抹掉了"这次失败与请求内容有没有关系"这个区分，不能据此重试',
    )
  })

  test('环境变量能覆盖，包括整个关掉', () => {
    const off = loadConfig({ env: { ...BASE, LLM_RETRY_ENABLED: '0' }, cwd: '/nonexistent' })
    assert.equal(off.llm.retry.enabled, false)

    const tuned = loadConfig({
      env: { ...BASE, LLM_RETRY_MAX: '5', LLM_RETRY_BASE_MS: '500', LLM_RETRY_EXTRA_PATTERNS: 'foo,bar' },
      cwd: '/nonexistent',
    })
    assert.equal(tuned.llm.retry.maxRetries, 5)
    assert.equal(tuned.llm.retry.baseDelayMs, 500)
    assert.deepEqual(tuned.llm.retry.extraPatterns, ['foo', 'bar'], '自定义特征应当整体替换默认值')
  })
})

/**
 * 重试期间界面上必须有动静。
 * 3 次退避是 2+4+8=14 秒 —— 这十几秒里什么都不显示的话，用户只会去点停止或刷新。
 */
describe('重试进度转给前端', () => {
  const framesOf = (event) => {
    const out = []
    toClientFrames(event, (type, data) => out.push({ type, data }))
    return out
  }

  test('retry 是对外承认的帧类型', () => {
    assert.ok(CLIENT_EVENTS.includes('retry'))
  })

  test('auto_retry_start → retry 帧，带次数与等待时长', () => {
    const [frame] = framesOf({
      type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: '400 模型服务调用失败',
    })
    assert.equal(frame.type, 'retry')
    assert.equal(frame.data.state, 'start')
    assert.equal(frame.data.attempt, 2)
    assert.equal(frame.data.maxAttempts, 3)
    assert.equal(frame.data.delayMs, 4000)
  })

  test('重试帧里不带网关原文 —— 最终失败会走 error 帧，不必反复推', () => {
    const [frame] = framesOf({
      type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'SECRET-ish 原文',
    })
    assert.ok(!JSON.stringify(frame.data).includes('SECRET-ish'))
  })

  test('auto_retry_end → retry 帧收尾，界面好把提示撤掉', () => {
    const [frame] = framesOf({ type: 'auto_retry_end', attempt: 3, success: false })
    assert.equal(frame.type, 'retry')
    assert.equal(frame.data.state, 'end')
    assert.equal(frame.data.success, false)
  })
})
