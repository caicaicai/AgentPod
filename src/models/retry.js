/**
 * 让 pi 的退避重试认得**我们这个网关**的偶发故障。
 *
 * ── 先说清楚 pi 已经做了什么 ────────────────────────────────────────
 *
 * 重试不需要我们从头写。`AgentSession._handleRetryableError` 已经有一整套：
 *   - 指数退避 `baseDelayMs * 2^(n-1)`，可中止
 *   - **重试前把失败的那条助手消息从 agent 状态里摘掉** —— 所以不会重复输出，
 *     也不会重跑已经完成的工具调用（工具结果留在状态里）
 *   - 发 `auto_retry_start` / `auto_retry_end` 事件
 *   - 明确跳过上下文溢出（那个该走压缩，不该重试）
 * 默认 enabled、3 次、2000ms 起步，我们用 `SettingsManager.inMemory({})`，所以一直开着。
 *
 * ── 那为什么还是不重试 ──────────────────────────────────────────────
 *
 * 判定入口 `_isRetryableError(message)` 是拿一条正则去匹配错误文本，认的是
 * `429 / 500 / 502 / 503 / 504 / rate limit / timeout / connection reset` 这些**标准**说法。
 *
 * 而我们的网关把偶发故障回成 **HTTP 400**，文案还是中文：
 *     400 模型服务调用失败
 *     400 {"error":{"message":"Already borrowed","type":"BadRequestError","code":400}}
 * 两条都在正则之外 —— 一次都不会重试。用户侧的表现就是"这东西偶尔会失败"。
 *
 * 所以这里只补一件事：**在 pi 说"不可重试"之后，再用我们自己的特征匹配一次**。
 * pi 说可以重试的照旧，我们只做加法，不做减法。
 */

/**
 * 看着像"上下文超了"的错误：**绝不能重试**。
 *
 * pi 自己在正则之前就挡掉了这一类（该走压缩），但它挡的方式我们够不着
 * （`isContextOverflow` 没导出）。我们的补充特征万一撞上这类文案，
 * 重试就是拿同样超长的上下文再打三次，三次都必然失败，还白等 14 秒。
 */
const CONTEXT_OVERFLOW_RE = /context.?length|context.?window|too many tokens|maximum context|prompt is too long|reduce the length/i

/** 把配置里的字符串特征编译成正则；写坏一条不影响其余的 */
export function compilePatterns(patterns, logger = null) {
  const compiled = []
  for (const raw of patterns || []) {
    const source = String(raw || '').trim()
    if (!source) continue
    try {
      compiled.push(new RegExp(source, 'i'))
    } catch (error) {
      // 配置写错不该让服务起不来 —— 少一条特征只是少重试一种错误
      logger?.warn?.('LLM_RETRY_EXTRA_PATTERNS 里有一条不是合法正则，已跳过', {
        pattern: source, err: error?.message,
      })
    }
  }
  return compiled
}

/**
 * 这条错误是否命中我们补充的特征。
 * 与 pi 的判断相互独立，方便单测。
 */
export function matchesExtraPattern(errorMessage, compiledPatterns) {
  const text = String(errorMessage || '')
  if (!text) return false
  if (CONTEXT_OVERFLOW_RE.test(text)) return false
  return compiledPatterns.some((re) => re.test(text))
}

/**
 * 给这一次 run 的 session 装上补充判定。
 *
 * ⚠️ 这里包的是 pi 的**私有方法** `_isRetryableError`。这是个取舍：
 * 判定逻辑（正则）是写死在 pi 里的，既没做成配置项也没留 hook，
 * 而"网关用 400 表达偶发故障"这件事只有我们知道。
 * 换成自己在外面重跑一轮的代价大得多：要么重复输出，要么重跑工具。
 *
 * 代价是升级 pi 时这个方法可能改名。所以：
 *   - 找不到就**告警并原样返回**，不抛 —— 少了重试而已，不该让对话跑不起来
 *   - `test/llm-retry.test.js` 里有一条专门盯着这个方法还在不在，改名了会红
 *
 * @returns {boolean} 是否真的装上了
 */
export function installRetryPolicy(session, { patterns = [], logger = null } = {}) {
  const original = session?._isRetryableError

  if (typeof original !== 'function') {
    logger?.warn?.('pi 的 _isRetryableError 不见了，网关特有的可重试错误将不会重试（pi 升级后改名？）')
    return false
  }
  if (!patterns.length) return false

  session._isRetryableError = function patched(message) {
    // pi 说可以就可以 —— 它还负责挡上下文溢出那一类，那个判断必须先跑
    if (original.call(this, message)) return true
    return matchesExtraPattern(message?.errorMessage, patterns)
  }
  return true
}
