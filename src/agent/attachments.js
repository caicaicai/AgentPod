/**
 * 用户附件 → 这一轮真正喂给模型的东西。
 *
 * 两类附件在这里走两条完全不同的路，而不是笼统地"传给模型"：
 *
 *   - **文本**（日志、代码、粘贴过来的一大段）拼进 prompt 正文。任何模型都能读，
 *     不挑视觉能力，也不占额外的多模态配额。
 *   - **图片**走 pi 的 image content part。只有模型本身支持视觉时才发 ——
 *     不支持还硬发，网关那边多半直接 400，用户看到的是"发消息失败"，
 *     完全联想不到是因为带了张图。所以这种情况改成在正文里说明"图没能发出去"，
 *     模型至少能回一句"我看不到这张图"，而不是装作看见了。
 *
 * 图片走的是 pi 的 `session.prompt(text, { images })` —— 注意**不是**把
 * content part 数组传给第一个参数。`AgentSession.prompt()` 的签名是
 * `(text: string, options?: PromptOptions)`，传数组进去会被当字符串用掉，
 * 表现是模型收到一段 `[object Object]`。`PromptOptions.images` 收的
 * `ImageContent` 形状就是下面产出的这个（`{ type, data, mimeType }`，
 * 见 pi-ai 的 types.d.ts）。
 */
import { Errors } from '../errors.js'
import { ALLOWED_IMAGE_MIME, BASE64_RE } from './events.js'

/** 一条消息最多带几个附件。与前端 attachments.js 的 MAX_FILES 对齐 */
const MAX_ATTACHMENTS = 8
/** 单张图的 base64 上限 ≈ 3MB 原始字节。前端也拦一道，这里是不信前端的那一道 */
const MAX_IMAGE_BASE64 = 4_200_000
/**
 * 所有图片加起来的上限。
 *
 * 单张的限制挡不住"八张各 2.9MB"——那会是一条 23MB 的请求，先撞上的将是
 * 请求体上限，而那条报错说不出"是附件太大了"。这一档就是为了让报错说得清。
 */
const MAX_TOTAL_IMAGE_BASE64 = 8_000_000
/** 单个文本附件进 prompt 的字符上限。超了截断并写明，而不是整条请求打回 */
const MAX_DOCUMENT_CHARS = 40_000
/** 所有文本附件加起来的上限。防的是"十个文件各 39,000 字"把上下文一次撑爆 */
const MAX_TOTAL_DOCUMENT_CHARS = 100_000

/**
 * 文件名会原样拼进 prompt，所以先收一道。
 *
 * 去掉换行和反引号：前者能把「【附件 x】」那行截断，后者能提前收掉正文的围栏 ——
 * 两者都会让模型读到一个结构错位的 prompt。空白折成一个：不折的话
 * `a\n```b` 会变成中间四个空格的怪名字。
 */
function safeName(name) {
  return String(name || '未命名')
    .replace(/[\r\n`]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim() || '未命名'
}

/**
 * 校验并归一化请求体里的 attachments。
 *
 * 这一层不信任前端的任何字段：`kind` 是客户端自己填的，`mimeType` 也是。
 * 图片的 mime 走白名单（同 events.js 出站那份），base64 校验字符集 ——
 * 这段字节最终会进模型请求，放开了等于让调用方决定往上游发什么。
 *
 * @returns {Array<{kind:'image'|'document', name:string, mimeType:string, data:string, text:string}>}
 */
export function normalizeAttachments(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw Errors.badRequest('attachments 必须是数组')
  if (raw.length > MAX_ATTACHMENTS) {
    throw Errors.badRequest(`一条消息最多带 ${MAX_ATTACHMENTS} 个附件，收到 ${raw.length} 个`)
  }

  const out = []
  let totalChars = 0
  let totalImageChars = 0

  for (const item of raw) {
    if (!item || typeof item !== 'object') throw Errors.badRequest('attachments 里有不是对象的元素')
    const name = safeName(item.name)

    if (item.kind === 'image') {
      const mimeType = String(item.mimeType || '')
      if (!ALLOWED_IMAGE_MIME.has(mimeType)) {
        throw Errors.badRequest(`「${name}」的类型 ${mimeType || '(空)'} 不支持，只接受 PNG / JPEG / WebP / GIF`)
      }
      const data = String(item.data || '')
      if (!data || !BASE64_RE.test(data)) throw Errors.badRequest(`「${name}」的图片数据不是合法 base64`)
      if (data.length > MAX_IMAGE_BASE64) {
        throw Errors.badRequest(`「${name}」超过单张图片上限（约 ${Math.round(MAX_IMAGE_BASE64 / 1_400_000)}MB）`)
      }
      totalImageChars += data.length
      if (totalImageChars > MAX_TOTAL_IMAGE_BASE64) {
        throw Errors.badRequest(`这条消息里的图片加起来超过约 ${Math.round(MAX_TOTAL_IMAGE_BASE64 / 1_400_000)}MB，请分几次发`)
      }
      out.push({ kind: 'image', name, mimeType, data, text: '' })
      continue
    }

    if (item.kind === 'document') {
      let text = String(item.text ?? '')
      if (!text) continue // 空文件不值得占一段 prompt，也不值得报错
      let note = ''
      if (text.length > MAX_DOCUMENT_CHARS) {
        text = text.slice(0, MAX_DOCUMENT_CHARS)
        note = `（内容过长，只带了前 ${MAX_DOCUMENT_CHARS} 个字符）`
      }
      if (totalChars + text.length > MAX_TOTAL_DOCUMENT_CHARS) {
        const left = Math.max(0, MAX_TOTAL_DOCUMENT_CHARS - totalChars)
        if (left < 200) {
          // 剩的空间连一段有意义的内容都放不下，与其塞个零头不如说清楚它被丢了
          out.push({ kind: 'document', name, mimeType: 'text/plain', data: '', text: '', dropped: true })
          continue
        }
        text = text.slice(0, left)
        note = `（多个附件合计过长，只带了前 ${left} 个字符）`
      }
      totalChars += text.length
      out.push({ kind: 'document', name, mimeType: String(item.mimeType || 'text/plain'), data: '', text, note })
      continue
    }

    throw Errors.badRequest(`「${name}」的 kind 只能是 image 或 document`)
  }

  return out
}

/**
 * 把 prompt 与附件拆成 `session.prompt(text, { images })` 要的两半。
 *
 * @param {string} prompt
 * @param {Array} attachments  normalizeAttachments() 的产物
 * @param {boolean} imageCapable  本轮选的模型支不支持视觉
 * @returns {{text: string, images: Array<{type:'image', data:string, mimeType:string}>}}
 */
export function buildPromptContent(prompt, attachments = [], { imageCapable = false } = {}) {
  if (!attachments.length) return { text: prompt, images: [] }

  const documents = attachments.filter((item) => item.kind === 'document')
  const images = attachments.filter((item) => item.kind === 'image')
  const sections = [prompt]

  for (const doc of documents) {
    if (doc.dropped) {
      sections.push(`【附件 ${doc.name}】因总长度超限没有带上，需要的话请让我单独发一次。`)
      continue
    }
    // 围栏用四个反引号：附件正文里出现 ``` 是常事（贴的就是 markdown 或代码），
    // 用三个的话整段结构会在第一处就断掉。
    sections.push(`【附件 ${doc.name}】${doc.note || ''}\n\`\`\`\`\n${doc.text}\n\`\`\`\``)
  }

  if (images.length && !imageCapable) {
    // 说出来，而不是静默丢掉：模型知道"有张图但我看不到"才会去问，
    // 不知道就会照着文字硬答，而用户以为它看过了。
    const names = images.map((image) => image.name).join('、')
    sections.push(`【附件 ${names}】是图片，但当前模型不支持读图，所以没有发送。请告诉我换个支持视觉的模型再试。`)
  }

  return {
    text: sections.filter(Boolean).join('\n\n'),
    images: imageCapable
      ? images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }))
      : [],
  }
}

/** 日志用：只记形状，不记内容 */
export function describeAttachments(attachments = []) {
  if (!attachments.length) return null
  return {
    count: attachments.length,
    images: attachments.filter((item) => item.kind === 'image').length,
    documents: attachments.filter((item) => item.kind === 'document').length,
    bytes: attachments.reduce((sum, item) => sum + (item.data.length || item.text.length), 0),
  }
}
