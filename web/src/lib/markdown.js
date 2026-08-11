/**
 * 极简 markdown 渲染。
 *
 * 安全策略：**先整体 HTML 转义，再做 markdown 变换**。模型输出里的 <script>
 * 之类在第一步就变成了实体，后续变换只会产出我们自己拼的标签。链接协议走白名单。
 * 顺序反过来（先变换再转义）会把我们自己生成的标签也转义掉，那样才是真的不能用。
 *
 * 为什么不引 marked/highlight.js：聊天场景要的就是这些常见语法，这一份够用，
 * 而 marked + highlight.js + DOMPurify 是三个包、几百 KB 的首屏成本。
 */
import { copyToClipboard } from './debug-bundle.js'

export function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function renderInline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) =>
      /^(https?:|mailto:)/i.test(href) ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>` : m)
}

export function renderMarkdown(src) {
  if (!src) return ''
  let text = escapeHtml(src)

  // 流式过程中常出现"开了 ``` 还没闭合"，先虚拟闭合，避免整段代码块闪成普通文本
  if ((text.match(/```/g) || []).length % 2 === 1) text += '\n```'

  // 围栏代码块先摘出来占位，避免里面的内容被后续规则改写。
  // 占位符用 NUL 兜边：正文里不可能出现它，不会被模型输出的普通文字撞上。
  const codeBlocks = []
  text = text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const label = escapeHtml(String(lang || '').trim()) || 'code'
    codeBlocks.push(
      `<div class="code-block"><div class="code-head"><span>${label}</span>` +
        `<button type="button" class="code-copy" data-copy>复制</button></div>` +
        `<pre><code>${code.replace(/\n$/, '')}</code></pre></div>`,
    )
    return `\u0000CODE${codeBlocks.length - 1}\u0000`
  })
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>')

  const lines = text.split('\n')
  const out = []
  let list = null // 'ul' | 'ol'
  let para = []
  let quote = []
  let table = null // 行 html 数组

  // 聊天场景按 GFM 软换行处理：单个换行就断行，不像标准 markdown 那样并成一段
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(renderInline).join('<br>')}</p>`); para = [] } }
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null } }
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`); quote = [] } }
  const flushTable = () => { if (table) { out.push(`<div class="table-wrap"><table>${table.join('')}</table></div>`); table = null } }
  const flushAll = () => { flushPara(); flushList(); flushQuote(); flushTable() }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (/^\u0000CODE\d+\u0000$/.test(line.trim())) { flushAll(); out.push(line.trim()); continue }
    if (!line.trim()) { flushAll(); continue }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushAll(); out.push('<hr>'); continue }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) { flushAll(); const n = heading[1].length; out.push(`<h${n}>${renderInline(heading[2])}</h${n}>`); continue }

    // 转义之后 `>` 已经是 `&gt;`
    const quoted = line.match(/^&gt;\s?(.*)$/)
    if (quoted) { flushPara(); flushList(); quote.push(quoted[1]); continue }
    flushQuote()

    // 表格：| a | b | 后跟 |---|---|
    if (/^\|.*\|$/.test(line.trim())) {
      flushPara(); flushList()
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim())
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue // 分隔行，跳过
      const tag = table === null ? 'th' : 'td' // 第一行当表头
      if (table === null) table = []
      table.push(`<tr>${cells.map((c) => `<${tag}>${renderInline(c)}</${tag}>`).join('')}</tr>`)
      continue
    }
    flushTable()

    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      flushPara()
      const want = ul ? 'ul' : 'ol'
      if (list !== want) { flushList(); out.push(`<${want}>`); list = want }
      out.push(`<li>${renderInline((ul || ol)[1])}</li>`)
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flushAll()

  return out.join('').replace(/\u0000CODE(\d+)\u0000/g, (m, i) => codeBlocks[Number(i)])
}

/**
 * 代码块「复制」按钮。
 *
 * 事件委托而不是逐个绑定：正文是 `v-html` 注进去的，Vue 每次重绘都会换掉那批
 * DOM 节点，绑在按钮自己身上的监听会跟着消失。
 *
 * 复制走 copyToClipboard 而不是直接 `navigator.clipboard` —— 线上是
 * `http://内网域名`，那里 `navigator.clipboard` 根本不存在（非安全上下文），
 * 直接用的话按钮点了没反应。
 */
export function installCodeCopy(root = document) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]')
    if (!button) return
    const code = button.closest('.code-block')?.querySelector('code')
    if (!code) return
    const ok = await copyToClipboard(code.textContent)
    button.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => { button.textContent = '复制' }, 1500)
  })
}
