/**
 * pi 的 AgentEvent → 对外事件帧。
 *
 * pi 的事件名是 message_start / message_update / message_end /
 * tool_execution_start / tool_execution_update / tool_execution_end（见 pi-agent-core types）。
 * 对外我们只暴露一组稳定的语义帧，免得上游改名就把所有客户端打挂。
 */
import { describeStop } from '../stop-reason.js'

export const CLIENT_EVENTS = [
  'run_start', 'model', 'thinking', 'text', 'text_end', 'tool_call', 'tool_result',
  'retry', 'usage', 'final', 'error',
]

function assistantParts(message, type, field = 'text') {
  if (message?.role !== 'assistant') return ''
  return (message.content || [])
    .filter((part) => part?.type === type && part[field])
    .map((part) => part[field])
    .join('')
}

const assistantText = (message) => assistantParts(message, 'text')
const assistantThinking = (message) => assistantParts(message, 'thinking', 'thinking')

/**
 * 一条流式正文（text 或 thinking）的增量编码器。
 *
 * ── 为什么不能直接发全文 ──────────────────────────────────────────────
 *
 * pi 的 message_update 给的是**到目前为止的整条消息**，所以最直白的写法是每次
 * 把全文发出去、客户端整体替换。那样每个 token 都要重发前面所有 token，
 * 一条回复的传输量是 O(n²)。
 *
 * 实测（本地假上游，1.6KB 的回复 / 909 帧）：**491KB**。其中
 *   - text 帧：414 帧 × 平均半篇全文 ≈ 330KB
 *   - thinking 帧：489 帧，而思考只有 148 字 —— 思考早就结束了，
 *     后面每来一个正文 token 都把整段思考原封不动再发一遍，414 帧是纯重复
 *
 * 300 倍放大在 localhost 上看不出来（帧间隔最大 16ms），但在真实网络上就是
 * 用户看到的那个现象：**开头顺畅（帧还小），越往后越慢（帧越来越大），
 * 最后憋一大段一起出来**（小包被 TCP 攒成整段一次交付）。一条 10KB 的长回复
 * 按这个算法要发 20MB。
 *
 * 所以：首帧发全文（`text`，客户端整体替换），之后只发增量（`delta`，客户端追加）。
 * 内容不是纯追加时（模型重写、重试摘掉了半条消息）退回一次全文替换 ——
 * 宁可多发一次，也不能让客户端拼出一段错的正文。
 */
function createChunker() {
  let sent = ''
  return {
    /** @returns {object|null} 要发的帧数据；内容没变时返回 null（这一帧整个不发） */
    next(full) {
      if (!full || full === sent) return null
      // 首帧、或者不是纯追加 —— 整体替换
      if (!sent || !full.startsWith(sent)) {
        sent = full
        return { text: full }
      }
      const delta = full.slice(sent.length)
      sent = full
      return { delta }
    },
    reset() {
      sent = ''
    },
  }
}

/**
 * 有状态的帧编码器：一条 SSE 流一个。
 *
 * 状态就是"这条助手消息我已经发到哪儿了"，`message_end` 时清掉 ——
 * 一轮里可能有好几条助手消息（先说"我查一下"再调工具），各自从头开始。
 */
export function createFrameEncoder() {
  const text = createChunker()
  const thinking = createChunker()

  return function encode(event, emit) {
    return toClientFrames(event, emit, { text, thinking })
  }
}

/**
 * @param {object} event pi AgentEvent
 * @param {(type: string, data: object) => void} emit
 * @param {object} [chunkers] 增量编码状态。不传就每次现造一个 —— 也就是每帧都发全文，
 *   单元测试里正是要这个（一次调用一个事件，不必攒状态）。
 */
export function toClientFrames(event, emit, chunkers = null) {
  const text = chunkers?.text || createChunker()
  const thinking = chunkers?.thinking || createChunker()

  switch (event.type) {
    case 'message_update':
    case 'message_end': {
      /**
       * 首帧带 `text`（全文，整体替换），后续帧带 `delta`（追加）。
       * 两个字段互斥，客户端按哪个字段在决定怎么处理。
       */
      const thinkingFrame = thinking.next(assistantThinking(event.message))
      if (thinkingFrame) emit('thinking', thinkingFrame)
      const textFrame = text.next(assistantText(event.message))
      if (textFrame) emit('text', textFrame)
      /**
       * 边界只给**助手**消息。
       *
       * pi 对工具结果消息也发 message_end，从前这里不看 role 一律发 text_end，
       * 于是每轮都多出几个空边界帧。今天它们碰巧无害（客户端那边块已经封口了），
       * 但增量编码之后边界就有了真实作用 —— 它要重置"已经发到哪儿了"，
       * 发错地方会让下一条助手消息的首帧变成一段无处可追加的 delta。
       */
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        if (event.message?.usage) {
          emit('usage', {
            input: event.message.usage.input ?? null,
            output: event.message.usage.output ?? null,
            cacheRead: event.message.usage.cacheRead ?? null,
          })
        }
        /**
         * 一条助手消息到此为止。
         *
         * 一轮里可能有好几条（先说"我查一下"并调工具，拿到结果再说结论）。
         * 没有这个边界，客户端只能靠"下一帧 text 变短了"来猜，猜错就是前一句
         * 被后一句直接盖掉 —— 用户看到的是助手把自己刚说的话吞了。
         *
         * `errorMessage` 也挂在这里：模型或网关出错时 pi **不抛异常**，
         * 而是正常结束一条 stopReason='error' 的消息。不把它带出去，
         * 界面上就是一个空空的回复气泡 —— 用户完全看不出发生了什么。
         */
        const stop = describeStop(event.message)
        emit('text_end', {
          stopReason: event.message?.stopReason || '',
          errorMessage: stop.error,
          // `length`（撞 max_tokens 被截断）走这里。它不是错误 —— 这一轮有输出、
          // 还会继续调工具 —— 但结果可能是残的，必须让用户看见。
          warning: stop.warning,
        })
        // 下一条助手消息从头开始：它的首帧必须是全文替换，而不是接在这条后面的 delta
        text.reset()
        thinking.reset()
      }
      return
    }
    /**
     * 退避重试的进度。
     *
     * 不转出去的话，一次 3 连重试就是**十几秒完全没有任何动静** —— 用户不知道
     * 是在等模型、卡住了、还是已经挂了，多半会去点停止或者刷新。
     *
     * 只带次数与等待时长：`errorMessage` 是网关回的原文，最终失败时会走 error 帧，
     * 不必在重试过程中把它反复推给前端。
     */
    case 'auto_retry_start':
      return emit('retry', {
        state: 'start',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
      })
    case 'auto_retry_end':
      return emit('retry', { state: 'end', attempt: event.attempt, success: Boolean(event.success) })

    case 'tool_execution_start':
      return emit('tool_call', { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args })
    case 'tool_execution_end':
      return emit('tool_result', {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: Boolean(event.isError),
        ...toolResultPreview(event.result),
      })
    default:
      return
  }
}

/** 工具结果预览的字节上限。够看清"技能到底跑出了什么"，又不至于把一条 `find /` 的输出灌进浏览器 */
const TOOL_PREVIEW_MAX = 4000

/**
 * 工具结果里的图片（截图）也要送到界面上。
 *
 * 从前这里把 image part 一律换成 `[image]` 占位，理由是"别把 base64 灌进浏览器"。
 * 代价是**用户让助手截个图，界面上只能看到一行 `[image]`** —— 而截图这个动作本身
 * 就是为了给人看的，看不到等于这个能力不存在。
 *
 * 成本其实早就付过了：pi 把 image part 原样写进会话 JSONL（实测确认），
 * 也就是说这张图**已经在存储里**了，这里只是决定要不要转发给浏览器。
 *
 * 上限还是要有：整页截图可以到几 MB，一条历史里堆几张就够让页面卡住。
 * 超限的那张退回占位并写明尺寸，不是静默丢掉。
 */
const MAX_IMAGES_PER_RESULT = 4
const MAX_IMAGE_BASE64 = 1_500_000 // ≈ 1.1MB 原始字节

/**
 * mimeType 会被拼进浏览器里的 `data:<mime>;base64,…`。它来自工具返回值，
 * 收口成白名单而不是原样透传 —— data: URL 的类型决定浏览器怎么解析这段字节，
 * 放开了等于让工具决定"这段 base64 按什么执行"。
 */
export const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** base64 的合法字符集。混进别的字符说明这不是一段干净的 base64，不往浏览器送 */
export const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

function collectImages(parts) {
  const images = []
  let skipped = 0
  for (const part of parts) {
    if (part?.type !== 'image' || !part.data) continue
    const data = String(part.data)
    const mimeType = String(part.mimeType || 'image/png')
    const usable = ALLOWED_IMAGE_MIME.has(mimeType) && BASE64_RE.test(data)
    if (!usable || images.length >= MAX_IMAGES_PER_RESULT || data.length > MAX_IMAGE_BASE64) {
      skipped += 1
      continue
    }
    images.push({ mimeType, data })
  }
  return { images, skipped }
}

/**
 * 工具结果的**文本预览**。
 *
 * 从前 `tool_result` 只回一个 `isError` 布尔值，于是前端只能显示"成功/失败" ——
 * 而"这个技能到底跑出了什么"恰恰是判断它有没有真的工作的唯一依据。
 * 只看到一排绿勾，没法把"真跑通了"和"工具被调用了但返回一堆空"区分开。
 *
 * 内容是**发起这一轮的用户自己的**运行输出（与 `text` 帧同一性质），
 * 不跨用户，所以不是新的泄漏面；截断上限是为了不把浏览器打爆。
 */
export function toolResultPreview(result) {
  if (result === undefined || result === null) return {}

  let text
  let images = []
  let skipped = 0
  if (typeof result === 'string') text = result
  else if (Array.isArray(result?.content)) {
    // pi 的工具结果是 content part 数组。文本原样留，图片单独抽出来（见上面的说明），
    // 其余类型仍然只留个占位。
    ;({ images, skipped } = collectImages(result.content))
    text = result.content
      .map((part) => {
        if (part?.type === 'text') return part.text || ''
        if (part?.type === 'image') return '' // 图片走 images 字段，正文里不再留占位
        return `[${part?.type || 'unknown'}]`
      })
      .filter((line) => line !== '')
      .join('\n')
  } else {
    try { text = JSON.stringify(result) } catch { text = String(result) }
  }

  text = String(text ?? '')
  if (skipped) text += `${text ? '\n' : ''}（另有 ${skipped} 张图片过大或超出数量上限，未在界面上显示）`

  const extra = images.length ? { images } : {}
  if (text.length <= TOOL_PREVIEW_MAX) return { preview: text, ...extra }
  return { preview: text.slice(0, TOOL_PREVIEW_MAX), previewTruncated: true, resultLength: text.length, ...extra }
}

/** 从事件流里抽最终回复文本 */
export function extractFinalText(events) {
  const chunks = []
  for (const event of events) {
    if (event.type === 'message_end') {
      const text = assistantText(event.message)
      if (text) chunks.push(text)
    }
  }
  return chunks.join('\n').trim()
}

/** 汇总 token 用量，供任务台账与成本归因 */
export function extractUsage(events) {
  const usage = { input: 0, output: 0, cacheRead: 0 }
  for (const event of events) {
    if (event.type !== 'message_end') continue
    const u = event.message?.usage
    if (!u) continue
    usage.input += Number(u.input) || 0
    usage.output += Number(u.output) || 0
    usage.cacheRead += Number(u.cacheRead) || 0
  }
  return usage
}
