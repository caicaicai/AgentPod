/**
 * pi 会话 JSONL → 可渲染的消息列表。
 *
 * 为什么要有这一层：刷新页面之后历史必须能重现出**和流式时一样**的样子 ——
 * 用户气泡、助手正文、以及中间那些工具调用。pi 存的是 append-only 的 entry 树
 * （message / compaction / label / custom …），把它原样丢给前端，等于让前端
 * 再实现一遍 pi 的会话语义。
 *
 * 输出形状刻意与 SSE 帧对齐（text / tool_call / tool_result 三类信息落在同一个
 * message 对象上），这样前端只有**一套**渲染器：历史和实时走同一条路，
 * 不会出现"刚发完好好的，一刷新就变样"。
 */
import { toolResultPreview } from '../agent/events.js'
import { describeStop } from '../stop-reason.js'

/** 一次最多回多少条消息。够看完一段完整对话，又不至于把几百轮的历史一次性灌进浏览器 */
const MAX_MESSAGES = 400

function toMillis(value) {
  if (typeof value === 'number') return value
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** user 消息的 content 可能是字符串，也可能是 text/image 混排的 part 数组 */
function readUserContent(content) {
  if (typeof content === 'string') return { text: content, images: 0 }
  let text = ''
  let images = 0
  for (const part of content || []) {
    if (part?.type === 'text') text += part.text || ''
    else if (part?.type === 'image') images += 1
  }
  return { text, images }
}

/**
 * @param {string} jsonl pi 的会话文件内容
 * @returns {{sessionId: string, messages: Array}}
 */
export function parseTranscript(jsonl = '') {
  const messages = []
  const callsById = new Map() // toolCallId -> 挂在某条 assistant 上的 toolCall 对象
  let sessionId = ''

  for (const line of String(jsonl || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let entry
    try {
      entry = JSON.parse(trimmed)
    } catch {
      // 单独一行坏掉不该让整段历史打不开 —— 跳过它，剩下的照常展示
      continue
    }

    if (entry.type === 'session') {
      sessionId = entry.id || sessionId
      continue
    }
    /**
     * 压缩点。**历史本身没有被删掉** —— JSONL 是 append-only，上面那些消息一条不少 ——
     * 被换掉的只是**下一轮发给模型的那份上下文**：这个点之前的对话，模型看到的
     * 是一段摘要。
     *
     * 所以这条分隔线是历史里唯一说得清那件事的东西。没有它，用户看着满屏
     * 完整的对话，却发现模型"忘了"上面聊过的细节 —— 而屏幕上的一切都在说
     * 它不该忘。归因只能落到"这个模型不行"。
     *
     * `tokensBefore` 一起带上：它是"压缩之前上下文有多大"，也就是这条会话
     * 长到了什么程度，比一句干巴巴的"这里压缩过"有用。
     */
    if (entry.type === 'compaction') {
      messages.push({
        role: 'compaction',
        tokensBefore: Number(entry.tokensBefore) || 0,
        timestamp: toMillis(entry.timestamp),
      })
      continue
    }
    // thinking_level_change / model_change / label / custom 等都不进对话流
    if (entry.type !== 'message') continue

    const message = entry.message
    if (!message?.role) continue
    const timestamp = toMillis(entry.timestamp) || message.timestamp || 0

    if (message.role === 'user') {
      const { text, images } = readUserContent(message.content)
      if (!text.trim() && !images) continue
      messages.push({ role: 'user', text, images, timestamp })
      continue
    }

    if (message.role === 'assistant') {
      let text = ''
      let thinking = ''
      const toolCalls = []
      for (const part of message.content || []) {
        if (part?.type === 'text') text += part.text || ''
        else if (part?.type === 'thinking') thinking += part.thinking || ''
        else if (part?.type === 'toolCall') {
          const call = {
            toolCallId: part.id,
            toolName: part.name,
            args: part.arguments || {},
            // 结果由后面的 toolResult 条目回填。一直是 pending 说明那轮跑到一半断了
            pending: true,
          }
          toolCalls.push(call)
          if (part.id) callsById.set(part.id, call)
        }
      }
      // 与实时那条路（agent/events.js）共用同一个函数：否则同一轮对话刷新前后
      // 显示的提示会不一样 —— 跟 turnStats 是同一个教训。
      const { error: errorMessage, warning } = describeStop(message)
      if (!text.trim() && !thinking.trim() && !toolCalls.length && !errorMessage && !warning) continue
      messages.push({
        role: 'assistant',
        text,
        thinking,
        toolCalls,
        model: message.model || '',
        usage: message.usage || null,
        error: errorMessage,
        warning,
        timestamp,
      })
      continue
    }

    if (message.role === 'toolResult') {
      const call = callsById.get(message.toolCallId)
      if (!call) continue // 结果找不到对应的调用（会话被截断过），丢掉而不是凭空造一条
      call.pending = false
      call.isError = Boolean(message.isError)
      Object.assign(call, toolResultPreview({ content: message.content }))
    }
  }

  return { sessionId, messages: attachTurnStats(messages.slice(-MAX_MESSAGES)) }
}

/**
 * 给每一轮算「耗时 + 工具调用次数」，挂在该轮**最后一条** assistant 消息上。
 *
 * 一轮的口径：一条 user 消息 + 其后连续的 assistant 消息（与前端 toTurns() 的分组规则
 * 一致，也与"先说我查一下、调工具、再说结论"是**一条**回复这个事实一致）。
 *
 * ── 为什么这个函数必须是唯一的算法 ────────────────────────────────────
 *
 * 这两个数字要在两个地方出现：刚跑完的那一轮（走 SSE 的 final 帧）和刷新之后的历史
 * （走这里）。两边各算各的，就会出现"刚发完显示 12.3 秒、一刷新变成 11.8 秒"——
 * 用户会当成 bug 报上来，而且没法解释。
 *
 * 所以服务端跑完一轮之后**也调 parseTranscript** 拿这两个数（见 run-turn.js），
 * 而不是用它自己手里的 `Date.now() - startedAt`。后者包含了拿沙盒租约、铺技能的
 * 时间，跟这里从消息时间戳算出来的必然对不上。同一个函数、同一份数据，
 * 才是"两边一定相等"的唯一保证。
 *
 * 时间戳缺失（老会话、被截断过的历史）时给 null，界面上就不显示 —— 不要拿 0 冒充。
 */
export function attachTurnStats(messages) {
  let turnStart = 0 // 本轮 user 消息的时间
  let toolCalls = 0
  let lastAssistant = null

  const flush = () => {
    if (!lastAssistant) return
    const duration = turnStart > 0 && lastAssistant.timestamp > 0 ? lastAssistant.timestamp - turnStart : -1
    lastAssistant.turnStats = {
      // 负数说明时钟不对（多副本机器之间有偏差）—— 宁可不显示，也别显示一个负的耗时
      durationMs: duration >= 0 ? duration : null,
      toolCalls,
    }
    lastAssistant = null
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flush() // 上一轮到此为止
      turnStart = message.timestamp || 0
      toolCalls = 0
      continue
    }
    if (message.role !== 'assistant') continue
    toolCalls += (message.toolCalls || []).length
    lastAssistant = message
  }
  flush()

  return messages
}

/** 标题最多显示多少字 */
const TITLE_MAX = 24

/**
 * 从一句话里取一个会话标题。
 * 只做压缩空白 + 截断：任何"聪明"的摘要都要再调一次模型，不值当。
 */
export function deriveTitle(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX)}…`
}
