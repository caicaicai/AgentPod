/**
 * 会话标题：让模型看着用户的第一句话起一个。
 *
 * ── 为什么值得为它多调一次模型 ──────────────────────────────────────────
 *
 * 从前的标题是把第一句话**截前 24 个字**（`deriveTitle`）。问题不是难看，是
 * 会话列表因此丧失了区分度：一个人连着问三次同一个系统的事，侧栏里就是
 * 「帮我看看结算中台最近的报错，昨天…」「帮我看看结算中台这个月的对账差…」——
 * 前十几个字一模一样，而"上次聊到哪儿"恰恰要靠这一行认。
 *
 * 代价必须算清楚：**一个会话一次**（不是一轮一次）。这与 memory capture 那个
 * 被默认关掉的开关是两个量级 —— 那个是每轮都抓，等于把全产品的调用次数翻倍；
 * 这个是每条对话一次、几十个 token、而且**与本轮并行**（见 run-service），
 * 所以用户感觉不到延迟。
 *
 * ── 失败一律退回截断标题 ────────────────────────────────────────────────
 *
 * 网关抖动、模型胡说、返回一整段话 —— 任何一种都退回 `deriveTitle`。
 * 一个会话没有好标题只是不好看；而为了标题让一次对话失败，或者让侧栏里
 * 出现一行模型的自言自语，都比"不好看"糟。
 */
import { completeSimple } from '@mariozechner/pi-ai'

/**
 * 标题上限。**按显示宽度算，不按字符数。**
 *
 * 定 18 个汉字是照着侧栏那一行的实际宽度来的：再长就会被 CSS 截成省略号，
 * 那等于让模型白写、也让"约束长度"这件事失去意义。
 *
 * ── 为什么不能直接数字符 ────────────────────────────────────────────────
 *
 * 第一版是 `slice(0, 18)`，于是 `Weekly report reminder`（22 个字符，但只有
 * 18 个汉字宽度的六成）被砍成了 `Weekly report remi`。同一条规则对中文刚好、
 * 对英文腰斩 —— 而用户不会觉得"这是长度限制"，只会觉得标题坏了。
 * CJK 一个字占两格，拉丁字母占一格，按格数量才是两种语言都对的口径。
 */
export const TITLE_MAX = 18
const TITLE_MAX_WIDTH = TITLE_MAX * 2

/** 全角区间（CJK、假名、谚文、全角标点）—— 这些字符一个占两格 */
const WIDE_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/

export function titleWidth(text) {
  let width = 0
  for (const ch of String(text || '')) width += WIDE_RE.test(ch) ? 2 : 1
  return width
}

/** 按宽度截断，绝不把一个字符切一半 */
function clampWidth(text, max) {
  let width = 0
  let out = ''
  for (const ch of text) {
    const step = WIDE_RE.test(ch) ? 2 : 1
    if (width + step > max) break
    out += ch
    width += step
  }
  return out
}

/** 给模型的额度。留一点余量给它不听话时多写的那几个字，但不足以让它写成一段话 */
const MAX_TOKENS = 48

export const TITLE_PROMPT = [
  '你给一段对话起标题。用户会给你他的第一条消息，你只回标题本身。',
  '',
  `要求：不超过 ${TITLE_MAX} 个汉字（英文约 ${TITLE_MAX * 2} 个字符）；概括**他想做的事**，不是复述他的原话；`,
  '用他使用的语言；不要加引号、书名号、句号，也不要写「关于」「讨论」这类废话开头。',
  '',
  '例子：',
  '「帮我看看结算中台最近三天的报错，重点是超时那一类」→ 排查结算中台超时报错',
  '「用 vue3 写一个能排序和分页的表格组件」→ Vue3 可排序分页表格',
  '「明天上午十点提醒我交周报」→ 周报提醒',
  '',
  '只输出标题，不要任何解释、前缀或标点包裹。',
].join('\n')

/**
 * 收拾模型的输出。
 *
 * 这一步不是洁癖：模型很爱回「标题：排查结算中台超时报错」或者给整句加引号，
 * 而那些字符会一路进到侧栏、进到搜索索引里。就地清掉比事后解释便宜。
 */
export function sanitizeTitle(raw) {
  let text = String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line) || ''

  text = text
    .replace(/^(标题|title)\s*[:：]\s*/i, '')
    .replace(/^[「『"'“”‘’《【[(]+/, '')
    .replace(/[」』"'“”‘’》】\])]+$/, '')
    .replace(/[。.!！?？、,，;；]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return ''
  // 超长就**丢掉**而不是截断：模型写成一段话时，截出来的是半句废话，
  // 还不如退回用户原话的前几个字（那至少是他自己说的）
  if (titleWidth(text) > TITLE_MAX_WIDTH * 2) return ''
  return clampWidth(text, TITLE_MAX_WIDTH)
}

/**
 * 起一个标题。**任何失败都回空串**，由调用方退回截断标题。
 *
 * @param {object} params
 * @param {object} params.model    pi Model
 * @param {string} params.apiKey   该用户这一轮的模型凭据
 * @param {string} params.prompt   用户的第一条消息
 * @returns {Promise<string>}
 */
export async function generateTitle({ model, apiKey, prompt, logger = console }) {
  const text = String(prompt || '').trim()
  if (!text || !model) return ''

  try {
    const message = await completeSimple(
      model,
      {
        systemPrompt: TITLE_PROMPT,
        // 只送第一条消息，而且截断：起标题不需要读完一篇贴进来的文档，
        // 送全文只是白花 token（附件正文可能有几万字）
        messages: [{ role: 'user', content: text.slice(0, 1000) }],
      },
      { apiKey, maxTokens: MAX_TOKENS, temperature: 0 },
    )

    /**
     * ⚠️ **pi 调用失败时不抛异常**，只是回一条 `stopReason: 'error'` 的消息
     * （与 run-turn.js / memory/capture.js 那两处是同一个坑）。
     * 不显式接住的话，content 是空数组 → 标题是空串 → 静默退回截断标题，
     * 于是"网关挂了一个月"表现成"标题一直不太好看"，没人会去查。
     */
    if (message?.stopReason === 'error') {
      logger.warn?.('起标题的模型调用失败，退回截断标题', {
        err: String(message.errorMessage || '').slice(0, 200),
      })
      return ''
    }

    const out = (message?.content || [])
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('')
    return sanitizeTitle(out)
  } catch (error) {
    // 起标题是锦上添花：它失败时那一轮早就答完了，不该冒泡到任何地方
    logger.debug?.('起标题异常，退回截断标题', { err: error?.message })
    return ''
  }
}
