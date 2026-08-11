/**
 * 事实抓取：一轮对话结束后，从中挑出"以后还成立"的事实写进 MEMORY.md。
 *
 * ── 时机：为什么是"每轮跑完当场抓"，而不是攒一批 ────────────────────────
 *
 * 参考实现（qm 的 per-turn 策略）用了一个静默窗口把连续几轮攒成一批再抓，
 * 省调用次数。**这里刻意没有照搬**，原因是隔离契约 #1：抓取要调模型，
 * 调模型要用户的 `apiKey`；攒批就意味着把一个用户的凭据在进程里留到几分钟后，
 * 横跨若干个别人的 run。省下的那几次调用，不值得换来一个"凭据在内存里存活多久"
 * 说不清楚的系统。
 *
 * 所以这里是：**在 run 的生命周期内，把答案推给用户之后再抓**。
 * 用户不会因此多等（final 帧已经发出去了），凭据也不会活过这个 run。
 *
 * ── 抓什么 ──────────────────────────────────────────────────────────────
 *
 * 提示词是这套机制的核心，直接决定 MEMORY.md 三个月后是有用还是全是噪音。
 * 三条硬约束：出处必须是用户自己说的、排除机制性细节、宁缺毋滥。
 */
import { completeSimple } from '@mariozechner/pi-ai'

import { bullets } from './notebook.js'

/**
 * 抓取提示词。
 *
 * PROVENANCE 那一段是最要紧的：没有它，模型会把**自己**说的话当成用户的偏好记下来
 * （"好的，我以后都用简短回复" → 记成"用户偏好简短回复"），几轮之后 MEMORY.md
 * 就变成了模型的自我暗示，而且再也说不清哪条是用户真讲过的。
 */
export const EXTRACTION_PROMPT = [
  // "一段"而不是"一轮"：攒批之后送进来的是连续几轮，用 --- 分隔
  '你从一段对话（可能包含连续多轮，用 --- 分隔）里挑出**以后仍然成立**、值得长期记住的事实。',
  '',
  '只输出 markdown 无序列表（`- 事实`），一行一条，每条独立成句、用第三人称陈述。',
  '例如：`- 偏好简短直接的回答`、`- 负责结算中台的稳定性`、`- 正在做 Q3 大促的压测`。',
  '',
  '要记：偏好与工作方式、长期承担的职责、正在进行的项目、稳定的身份信息（团队、系统、常用环境）。',
  '',
  '出处约束（最重要的一条）：一条偏好/意图/约定，只有在**用户自己的发言**里明确说了才算数。',
  '绝不能从助手的回复里推断 —— 助手说"我以后都简短回答"不构成"用户偏好简短回答"。',
  '也不要记第三方的转述。',
  '',
  '不要记：密码、token、cookie 等任何凭据；一次性的琐碎信息；显而易见的常识；',
  '以及可以随时查到的机制细节（接口地址、请求头、文件路径、工具参数、表结构）。',
  '用户依赖的某个长期机制（一个定时任务、一个集成），只记它**存在和用途**，不记它怎么实现。',
  '',
  '如果这轮没有任何值得记的，就只输出：NONE',
].join('\n')

/** 送进抓取模型的对话文本上限。一轮里工具输出可能很长，全塞进去既贵又没用 */
const TRANSCRIPT_MAX_CHARS = 6000

/** 太短的一轮不值得跑一次抓取（"在吗" / "好的"） */
const MIN_INPUT_CHARS = 8

/** 抓取本身的输出上限：十几条 bullet 足够，给大了只会让它开始编 */
const EXTRACTION_MAX_TOKENS = 512

export function parseFacts(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed || /^none$/i.test(trimmed)) return []
  return bullets(trimmed).filter(Boolean)
}

/** AssistantMessage → 纯文本（pi 回的是 content part 数组） */
function textOf(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return (message.content || [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('')
}

function clip(text, max) {
  const flat = String(text || '')
  return flat.length <= max ? flat : `${flat.slice(0, max)}\n…（已截断）`
}

/**
 * @param {object} params
 * @param {object} params.memory  createMemoryStore() 的返回
 * @param {object} params.config  需要 config.memory
 */
export function createMemoryCapture({ memory, config, logger = console }) {
  const settings = config.memory || {}
  // 默认**关**：写记忆走 memory 工具，由模型自己决定。见 config.js 那段说明。
  const enabled = memory.enabled && settings.capture === true
  const quietMs = Number.isFinite(settings.captureQuietMs) ? settings.captureQuietMs : 180_000
  const maxTurns = Number.isFinite(settings.captureMaxTurns) ? settings.captureMaxTurns : 10

  /**
   * 攒批缓冲：`erp + projectId` → 这段时间里累积的几轮对话。
   *
   * 为什么要攒：一轮一次抓取，用户连着问五个来回就是五次额外的模型调用，
   * 而这五轮往往只沉淀出同一条事实。攒起来一次抓，调用次数降一个数量级，
   * 抓出来的东西反而更准 —— 模型看到的是一段完整上下文，不是被切碎的单轮。
   *
   * 键里带 projectId：同一个人在项目里和项目外说的话属于两份记忆，不能混。
   */
  const bursts = new Map()

  /**
   * 缓冲里存着这个用户的 apiKey，最长活到 quietMs（默认 3 分钟）。
   *
   * 这**不违反隔离契约 #1** —— 那条约束的是"绝不进 process.env"（并发用户会互相
   * 覆盖），而这里是一个按 erp 分键的 Map，任何一条都取不到别人的 key。
   * 代价是两个，都可接受：
   *   1. 凭据在内存里比一个 run 活得久；
   *   2. llmToken 可能在攒批期间过期 → 那次抓取失败并记日志。抓记忆是尽力而为，
   *      丢一次不影响任何一轮已经答完的对话。
   *
   * 早先的版本正是为了避开第 1 点才改成"每轮当场抓"，那是拿全产品翻倍的模型
   * 调用去换一个几分钟的凭据驻留 —— 换反了。
   */
  function remember(key, ctx) {
    const pending = bursts.get(key)
    if (pending) {
      pending.turns.push({ input: ctx.input, reply: ctx.reply })
      // 每轮都换成最新的凭据：攒批期间用户可能刚续过票
      pending.model = ctx.model
      pending.apiKey = ctx.apiKey
      clearTimeout(pending.timer)
      return pending
    }
    const burst = {
      erp: ctx.erp,
      projectId: ctx.projectId,
      model: ctx.model,
      apiKey: ctx.apiKey,
      turns: [{ input: ctx.input, reply: ctx.reply }],
      timer: null,
    }
    bursts.set(key, burst)
    return burst
  }

  /** 真正去抓。**不抛异常** —— 它跑在请求之外，没人接得住 */
  async function flush(burst) {
    const { erp, projectId, model, apiKey, turns } = burst
    const transcript = clip(
      turns.map(({ input, reply }) => `用户说：\n${input}\n\n助手回答：\n${reply || '（无正文回复）'}`)
        .join('\n\n---\n\n'),
      TRANSCRIPT_MAX_CHARS,
    )
    return runExtraction({ erp, projectId, transcript, model, apiKey, turns: turns.length })
  }

  return {
    enabled,

    /**
     * 一轮结束后调用。
     *
     * **同步返回，绝不 await 出去。** 它只是把这一轮塞进缓冲、重排一个定时器；
     * 真正的抓取发生在静默窗口之后，跑在请求之外。从前这里是 `await` 一整次
     * 模型调用，卡在 run 里 —— 实测让界面在模型明明已经答完之后又转了 4.3 秒，
     * 还白占着这个用户的并发名额。
     *
     * @param {object} ctx
     * @param {string} ctx.erp
     * @param {string} [ctx.projectId]  有项目就记进项目作用域，否则记个人
     * @param {string} ctx.input        用户这轮说的话
     * @param {string} ctx.reply        助手这轮的最终回答
     * @param {object} ctx.model        pi Model（复用本 run 已经构造好的那个）
     * @param {string} ctx.apiKey
     */
    onTurnEnd({ erp, projectId = '', input, reply, model, apiKey }) {
      if (!enabled || !erp || !model) return { queued: false, skipped: 'disabled' }
      if (String(input || '').trim().length < MIN_INPUT_CHARS) return { queued: false, skipped: 'too-short' }

      const key = `${erp} ${projectId}`
      const burst = remember(key, { erp, projectId, input, reply, model, apiKey })

      // 不攒批（quietMs<=0）或者已经攒够了 —— 立刻抓，但仍然不等它
      if (quietMs <= 0 || burst.turns.length >= maxTurns) {
        clearTimeout(burst.timer)
        bursts.delete(key)
        flush(burst).catch((error) => logger.debug?.('记忆抓取异常', { erp, err: error?.message }))
        return { queued: true, flushed: true, turns: burst.turns.length }
      }

      /**
       * `unref()` 不能省：没有它，一个还在攒批的定时器会**吊着整个进程不退出**，
       * 优雅停机要多等最多 3 分钟。代价是停机时那一批就丢了 —— 抓记忆是尽力而为，
       * 拿它去换"停不下来的服务"不值得。
       */
      burst.timer = setTimeout(() => {
        bursts.delete(key)
        flush(burst).catch((error) => logger.debug?.('记忆抓取异常', { erp, err: error?.message }))
      }, quietMs)
      burst.timer.unref?.()
      return { queued: true, flushed: false, turns: burst.turns.length }
    },

    /** 测试与停机用：把还在攒的立刻抓完 */
    async drain() {
      const pending = [...bursts.values()]
      bursts.clear()
      for (const burst of pending) clearTimeout(burst.timer)
      await Promise.all(pending.map((burst) => flush(burst).catch(() => {})))
      return pending.length
    },
  }

  async function runExtraction({ erp, projectId, transcript, model, apiKey, turns }) {
    let facts = []
    try {
      const message = await completeSimple(
          model,
        { systemPrompt: EXTRACTION_PROMPT, messages: [{ role: 'user', content: transcript }] },
        { apiKey, maxTokens: EXTRACTION_MAX_TOKENS, temperature: 0 },
      )
      /**
       * ⚠️ **pi 调用失败时不抛异常**，只是回一条 `stopReason: 'error'` 的消息
       * （与 run-turn.js / events.js 那条 text_end 是同一个坑）。
       *
       * 不显式接住的话，`content` 是空数组 → 抽不出事实 → 走"这轮没什么可记的"
       * 那条正常分支。于是网关挂了一个月、一条记忆都没写进去，日志里一片安静。
       */
      if (message?.stopReason === 'error') {
        logger.warn?.('记忆抓取的模型调用失败，跳过这一批', {
          erp,
          err: String(message.errorMessage || '').slice(0, 200),
        })
        return { added: 0, skipped: 'model-error' }
      }
      facts = parseFacts(textOf(message))
    } catch (error) {
      // 抓取是锦上添花。它失败时用户那些轮早就答完了，不该冒泡到任何地方。
      logger.debug?.('记忆抓取异常，跳过这一批', { erp, err: error?.message })
      return { added: 0, skipped: 'error' }
    }

    if (!facts.length) return { added: 0 }

    try {
      const added = await memory.capture({ erp, projectId }, facts)
      if (added) logger.info?.('已写入长期记忆', { erp, projectId: projectId || null, added, turns })
      return { added }
    } catch (error) {
      logger.warn?.('记忆写入失败', { erp, err: error?.message })
      return { added: 0, skipped: 'write-error' }
    }
  }
}

/**
 * memory 进系统提示的那一段。
 *
 * 措辞上两件事必须说清楚，否则会出现很具体的坏结果：
 *   1. **这是背景不是指令** —— 不说的话，模型会把"正在做 Q3 压测"当成本轮任务；
 *   2. **可能过时** —— 记忆是历史快照，用户当场说的永远优先，否则它会拿三个月前
 *      的一条偏好去反驳用户此刻的要求。
 */
export function memoryPrompt({ personal = '', project = '', projectName = '', curator = false } = {}) {
  // curator 模式下即使一条记忆都还没有也要出这一段 —— 新用户的第一轮恰恰是
  // 最该记点什么的时候，而那时 personal/project 都是空的
  if (!personal && !project && !curator) return ''
  const parts = [
    '## 关于这位用户（长期记忆）',
    '',
    '以下是过往对话里沉淀下来的事实，**作为背景参考**，不是本轮任务。',
    '它们可能已经过时：与用户当前说法冲突时，一律以用户当前说的为准。',
  ]
  if (personal) parts.push('', '### 个人', '', personal)
  if (project) parts.push('', `### 当前项目${projectName ? `：${projectName}` : ''}`, '', project)
  if (!personal && !project) parts.push('', '（还没有记录任何事实。）')
  if (curator) parts.push('', ...CURATOR_LINES)
  return parts.join('\n')
}

/**
 * 「这份记忆归你管」那一段。
 *
 * 只在**关掉自动抓取**时进系统提示，也就是默认情况。没有它，关掉自动抓取
 * 等于把记忆写入整个关掉了 —— 模型不会知道自己有这个责任，`memory` 工具的
 * 描述里那句"可以主动 remember"太弱，实测它几乎不会主动调。
 *
 * 措辞借自 qm 的 agent-only 策略（"you are its sole curator"）：要点是把
 * **"不记就永远没了"**这件事讲明白，光说"你可以记"不管用。
 */
const CURATOR_LINES = [
  '**没有任何东西会被自动记住 —— 记什么由你决定，通过 `memory` 工具写入。**',
  '',
  '- 用户明确要求记住/忘掉某事：**立刻调用**，不要只是口头答应"好的我记住了"（那是假的）',
  '- 对话里出现明显长期成立的事实（职责、长期项目、稳定偏好）：顺手 remember 一条',
  '- 只对本轮有意义的东西不要记；已经在上面列出来的不要重复记',
  '- 发现某条记错了或已过时：先 forget 掉旧的，再记新的，不要留两条互相打架的',
]
