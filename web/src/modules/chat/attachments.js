/**
 * 附件：从 File / 剪贴板拿到字节，判类型，交给发送流程。
 *
 * 两类附件在链路上是**两种东西**，这里就分开，不要到后端再猜：
 *   - `image`    —— 走 pi 的 image content part，模型真的能"看"到（前提是所选模型支持视觉）
 *   - `document` —— 文本内容被拼进 prompt。二进制文档（pdf/docx…）没有可拼的文本，
 *                   这一层直接拒收，而不是拼一段乱码上去让模型自己猜。
 *
 * 为什么不做"上传到服务端再给个 URL"：那需要对象存储、生命周期、鉴权三件事，
 * 而当前后端连一个文件表都没有。先把"能带一张图 / 一段日志进对话"这件事做通，
 * 大文件仍然走沙盒（让助手自己 curl / read）。
 */

/**
 * 单个附件上限。三个数字要跟服务端对齐（src/agent/attachments.js）：
 * 那边是**不信前端**的那一道，这边是"别等传完 3MB 才告诉你不行"的那一道。
 * base64 之后体积涨 1/3，服务端的 MAX_IMAGE_BASE64 是按这个换算过来的。
 */
export const MAX_FILE_BYTES = 3 * 1024 * 1024
/** 一次带的图片总量上限，与服务端 MAX_TOTAL_IMAGE_BASE64 对齐 */
export const MAX_TOTAL_IMAGE_BYTES = 5.5 * 1024 * 1024
/** 一条消息最多带几个。再多就该考虑让助手去沙盒里读了 */
export const MAX_FILES = 8

/**
 * 粘贴多长的文本才自动转成附件。
 *
 * 阈值存在的理由：贴一段两千行的日志进输入框，输入框会撑成一堵墙，用户想在
 * 后面补一句"这个报错什么意思"都找不到光标。转成附件之后输入框还是干净的，
 * 内容也一个字没少。
 */
export const LARGE_PASTE_CHARS = 2000

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 没有 mimeType 的文本文件很常见（.log/.md/.py 在很多系统上就是空字符串） */
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'ini',
  'conf', 'cfg', 'env', 'sql', 'sh', 'bash', 'zsh', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'vue', 'py', 'go', 'java', 'kt', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift',
  'html', 'css', 'scss', 'less', 'toml', 'properties', 'gradle', 'dockerfile', 'diff', 'patch',
])

function extensionOf(name = '') {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function looksTextual(file) {
  const mime = String(file.type || '')
  if (mime.startsWith('text/')) return true
  if (/^application\/(json|xml|javascript|x-yaml|x-sh|sql)/.test(mime)) return true
  return TEXT_EXT.has(extensionOf(file.name))
}

export function isImageMime(mime) {
  return IMAGE_MIME.has(String(mime || ''))
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

/** Uint8Array → base64。分片是因为 String.fromCharCode 对几 MB 的展开会爆栈 */
export function bytesToBase64(bytes) {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

let seq = 0
function nextId(prefix) {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}`
}

export class AttachmentError extends Error {}

/**
 * File → 附件对象。
 *
 * @returns {Promise<{id,name,mimeType,kind,size,data,text,previewUrl}>}
 *   `data` 是 base64（图片走它），`text` 是解出来的正文（文本类走它）。
 */
export async function readAttachment(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new AttachmentError(`「${file.name}」有 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_FILE_BYTES)} 上限`)
  }

  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const mimeType = file.type || ''

  if (isImageMime(mimeType)) {
    const data = bytesToBase64(bytes)
    return {
      id: nextId('img'),
      name: file.name || '截图.png',
      mimeType,
      kind: 'image',
      size: file.size,
      data,
      text: '',
      previewUrl: `data:${mimeType};base64,${data}`,
    }
  }

  if (mimeType.startsWith('image/')) {
    // 服务端只认那四种（与 events.js 的 ALLOWED_IMAGE_MIME 同一份白名单）。
    // 说清楚是格式的问题，别让用户以为"图片不支持"。
    throw new AttachmentError(`「${file.name}」是 ${mimeType}，只支持 PNG / JPEG / WebP / GIF`)
  }

  if (!looksTextual(file)) {
    throw new AttachmentError(
      `「${file.name}」不是文本或图片，暂时带不进对话。可以先转成文本，或者让助手在沙盒里自己去读。`,
    )
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return {
    id: nextId('doc'),
    name: file.name || '未命名.txt',
    mimeType: mimeType || 'text/plain',
    kind: 'document',
    size: file.size,
    data: '',
    text,
    previewUrl: '',
  }
}

/** 一大段粘贴文本 → 附件。名字带序号，免得贴两次之后两个 chip 长得一模一样 */
export function textToAttachment(text, existingNames = []) {
  const taken = new Set(existingNames)
  let n = 1
  let name = '粘贴的文本.txt'
  while (taken.has(name)) {
    n += 1
    name = `粘贴的文本-${n}.txt`
  }
  return {
    id: nextId('paste'),
    name,
    mimeType: 'text/plain',
    kind: 'document',
    size: new TextEncoder().encode(text).length,
    data: '',
    text,
    previewUrl: '',
    pasted: true,
  }
}

/**
 * 发给服务端的形状。
 *
 * `previewUrl` 刻意不带上：它只是同一份 base64 前面拼了个 `data:` 头，
 * 带上等于把每张图的体积翻倍。
 */
export function toWire(attachment) {
  return {
    name: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.size,
    ...(attachment.kind === 'image' ? { data: attachment.data } : { text: attachment.text }),
  }
}

/* ═══════════════ 历史里的附件 ═══════════════ */

/**
 * 把服务端拼进 prompt 的附件段落还原成 chip。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *
 * 文本附件是**拼进 prompt 正文**发出去的（服务端 src/agent/attachments.js），
 * 会话里存的就是那一整段。不还原的话：刚发完看到的是两个干净的 chip，
 * 一刷新就变成一堵四千字的墙 —— 正是这个项目一直在避免的
 * "刚发完好好的、一刷新就变样"。
 *
 * 反解是可靠的，因为格式两端都是我们自己定的（见服务端的 buildPromptContent）。
 * 用户手打出一模一样的四反引号围栏当然也会被折起来，但那时折起来的
 * 仍然是他自己写的那段内容，读起来不会更差。
 */
const INLINE_DOC_RE = /【附件 ([^】]+)】([^\n]*)\n````\n([\s\S]*?)\n````/g
const INLINE_IMAGE_NOTE_RE = /【附件 ([^】]+)】是图片，但当前模型不支持读图[^\n]*/g
const INLINE_DROPPED_RE = /【附件 ([^】]+)】因总长度超限没有带上[^\n]*/g

export function parseInlinedAttachments(raw) {
  const text = String(raw || '')
  if (!text.includes('【附件 ')) return { text, files: [] }

  const files = []
  let rest = text

  rest = rest.replace(INLINE_DOC_RE, (match, name, note, body) => {
    files.push({
      id: `hist_${files.length}`,
      name,
      mimeType: 'text/plain',
      kind: 'document',
      size: new TextEncoder().encode(body).length,
      text: body,
      note: note.trim(),
      previewUrl: '',
    })
    return ''
  })

  rest = rest.replace(INLINE_IMAGE_NOTE_RE, (match, names) => {
    // 服务端把多张图并成一句，名字之间是「、」
    for (const name of names.split('、')) {
      files.push({
        id: `hist_${files.length}`,
        name: name.trim(),
        mimeType: 'image/*',
        kind: 'image',
        size: 0,
        text: '',
        // 说清楚这张图**没发出去**，否则用户会以为模型看过了
        note: '未发送（模型不支持读图）',
        previewUrl: '',
      })
    }
    return ''
  })

  rest = rest.replace(INLINE_DROPPED_RE, (match, name) => {
    files.push({
      id: `hist_${files.length}`,
      name,
      mimeType: 'text/plain',
      kind: 'document',
      size: 0,
      text: '',
      note: '未发送（总长度超限）',
      previewUrl: '',
    })
    return ''
  })

  // 段落之间原本是空行，摘掉几段之后会留下一串空行
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), files }
}

/**
 * 从 DataTransfer / input.files 里取文件，逐个读。
 *
 * 一个读失败不该让整批都白读：拖十个文件进来、其中一个是 pdf，正确的结果是
 * 九个进来了 + 一条说明，而不是十个都没进来。
 *
 * @param {File[]} files
 * @param {{existing?: Array}} options `existing` 是已经在输入框里的那些，用来算总量
 */
export async function readAll(files, { existing = [] } = {}) {
  const ok = []
  const errors = []
  let imageBytes = existing
    .filter((item) => item.kind === 'image')
    .reduce((sum, item) => sum + (item.size || 0), 0)

  for (const file of files) {
    if (existing.length + ok.length >= MAX_FILES) {
      errors.push(`一条消息最多带 ${MAX_FILES} 个附件，多出来的没有加进来`)
      break
    }
    try {
      const attachment = await readAttachment(file)
      if (attachment.kind === 'image') {
        if (imageBytes + attachment.size > MAX_TOTAL_IMAGE_BYTES) {
          errors.push(`图片总量超过 ${formatBytes(MAX_TOTAL_IMAGE_BYTES)}，「${file.name}」没有加进来`)
          continue
        }
        imageBytes += attachment.size
      }
      ok.push(attachment)
    } catch (error) {
      errors.push(error instanceof AttachmentError ? error.message : `「${file.name}」读取失败：${error.message}`)
    }
  }
  return { attachments: ok, errors }
}
