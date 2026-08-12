/**
 * 作品的渲染规则：一组文件 → 一份能塞进预览沙箱的完整文档。
 *
 * ── 这个文件是整套功能的安全支点 ────────────────────────────────────────
 *
 * 作品的内容是**模型生成的**，而模型的输入里有用户的邮件、网页、文档 —— 也就是说
 * 「页面里跑什么脚本」这件事，攻击者只要发一封诱导邮件就能参与决定
 * （prompt injection）。所以预览必须建立在两道**互相独立**的防线上：
 *
 *   1. **iframe sandbox，且绝不给 allow-same-origin。**
 *      没有它，那段脚本与本页同源 —— localStorage 里的登录令牌一读就走。
 *      加上它之后，文档处于「不透明源」：读不到父页面、读不到我们的 Cookie，
 *      连它自己的 localStorage 都没有。
 *      ⚠️ `allow-scripts` 和 `allow-same-origin` **同时给等于没给**，
 *      那样页面能自己把 sandbox 属性摘掉。要么不给脚本，要么不给同源。
 *
 *   2. **文档内的 CSP。** 挡的是另一件事：外带。没有它，脚本虽然读不到令牌，
 *      仍然可以把它能看到的东西（页面里的数据、用户在表单里填的字）POST 到任意地址。
 *      默认 `default-src 'none'`，白名单由服务端配置下发（ARTIFACT_ALLOWED_ORIGINS）。
 *
 * 两道都不是"多一层保险"：第一道防读、第二道防写，各挡各的。
 * 由此得到一条贯穿全局的规则：**模型生成的标记只在沙箱里被解释，父页面只经手字符串。**
 * （唯一的例外是 mermaid 的测量渲染，代价与缓解见 artifact-mermaid.js。）
 *
 * ── 多文件怎么进沙箱 ────────────────────────────────────────────────────
 *
 * 沙箱里没有服务器，`<script src="app.js">` 这种相对引用没人能解析。两条路：
 *   - 给作品的文件开一个 HTTP 端点 → **不行**，那等于让本服务以 text/html 的
 *     身份吐出模型生成的内容，第 1 道防线当场作废；
 *   - 在这里把引用**内联**进去 → 就是下面 buildWebDoc 做的事。
 * Vue 走的是另一条：编译成 ESM，在沙箱内部用 blob URL 组成模块图（见 artifact-vue.js）。
 */
import { compileVueProject, MODULE_TOKEN } from './artifact-vue.js'
import { renderMermaid, MERMAID_FENCE, hasMermaid } from './artifact-mermaid.js'
import { escapeHtml, renderMarkdown } from './markdown.js'

/** iframe 的 sandbox 属性。**不要加 allow-same-origin**，见文件头 */
export const PREVIEW_SANDBOX = 'allow-scripts allow-modals allow-forms'

export const KIND_META = {
  web: { label: '网页', icon: 'globe' },
  vue: { label: 'Vue 组件', icon: 'app-window' },
  markdown: { label: '文档', icon: 'book' },
  mermaid: { label: '图', icon: 'tasks' },
  svg: { label: '矢量图', icon: 'image' },
  code: { label: '代码', icon: 'terminal' },
}

export function kindLabel(meta) {
  const base = KIND_META[meta?.kind]?.label || meta?.kind || ''
  return meta?.kind === 'code' && meta?.language ? meta.language : base
}

export function kindIcon(kind) {
  return KIND_META[kind]?.icon || 'file'
}

/** 只有 code 不进沙箱：它本来就只展示源码，用 <pre> 比套个 iframe 更好读 */
export function needsFrame(kind) {
  return kind !== 'code'
}

/**
 * 作品库的筛选。
 *
 * 抽成纯函数而不是写在组件的 computed 里：它决定"我的东西找不找得到"，
 * 是这个页面唯一真正有逻辑的地方，值得被测试直接盯住。
 *
 * 搜索同时匹配**标题和文件名** —— 记不住标题但记得"那个 Chart.vue"是很常见的，
 * 只搜标题会让人以为作品被删了。
 */
export function filterArtifacts(list = [], { q = '', kind = '' } = {}) {
  const keyword = String(q).trim().toLowerCase()
  return list.filter((item) => {
    if (kind && item.kind !== kind) return false
    if (!keyword) return true
    if (String(item.title || '').toLowerCase().includes(keyword)) return true
    const current = (item.versions || []).find((version) => version.n === item.version)
    return (current?.files || []).some((file) => file.path.toLowerCase().includes(keyword))
  })
}

/**
 * 创建指引。
 *
 * ── 为什么这一页必须存在 ────────────────────────────────────────────────
 *
 * 作品是**模型产出的**，没有"新建"按钮。用户打开一个空列表时，本能是找那个按钮，
 * 找不到就得出结论"这功能还没做好"。所以空状态不能只写一句"还没有作品"——
 * 它得把"怎么来的"讲清楚，并且给几句能**直接点**的话术。
 *
 * 每条都写成用户会真的说出口的样子，而不是功能名的罗列。
 */
export const ARTIFACT_STARTERS = [
  {
    kind: 'web',
    title: '做一个能用的小工具',
    prompt: '帮我做一个网页版的贷款计算器：输入本金、年利率、期数，实时算出月供和总利息，样式简洁一点。',
  },
  {
    kind: 'vue',
    title: '写一个 Vue 组件',
    prompt: '用 Vue 3 写一个可复用的数据表格组件：支持排序、分页和空状态，拆成 App.vue + components/ 下的子组件。',
  },
  {
    kind: 'markdown',
    title: '整理一份文档',
    prompt: '把我们刚才聊的内容整理成一份方案文档，要有背景、目标、方案对比表格和落地步骤。',
  },
  {
    kind: 'mermaid',
    title: '画一张流程图',
    prompt: '把用户下单到发货的流程画成一张流程图，包含支付失败和缺货两个分支。',
  },
]

/**
 * 文档内的 CSP。
 *
 * `'unsafe-inline'` / `'unsafe-eval'` 是必须给的：作品本来就是一份内联脚本的
 * 单文件页面，不给就等于不能预览。它们在这里不构成额外风险 —— 脚本能不能跑，
 * 本来就由第一道防线（不透明源）兜着；CSP 在这儿的职责只有一个：**别让它出网**。
 *
 * `blob:` 是 Vue 作品要的：编译出来的模块在沙箱内部造成 blob URL 再 import。
 * 它同样不放大能力 —— 页面已经能跑内联脚本，blob 只是同一段代码换个装法。
 */
function contentSecurityPolicy(allowedOrigins = []) {
  const external = allowedOrigins.join(' ')
  const plus = (base) => (external ? `${base} ${external}` : base)
  return [
    "default-src 'none'",
    plus("script-src 'unsafe-inline' 'unsafe-eval' blob:"),
    plus("style-src 'unsafe-inline'"),
    plus('img-src data: blob:'),
    plus('font-src data:'),
    'media-src data: blob:',
    external ? `connect-src ${external}` : "connect-src 'none'",
    // 表单提交与 <base> 改写都是"把东西送出去"的另一条路，一并封掉
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

function cspMeta(allowedOrigins) {
  return `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(allowedOrigins)}">`
}

/** 没有外壳的片段（裸 SVG、markdown 产物）套上的那层最小文档 */
const BASE_STYLE = `
  html, body { margin: 0; padding: 0; }
  body { background: #fff; color: #111;
         font: 14px/1.65 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
`

/**
 * 文档类预览（markdown / mermaid / svg）的排版。
 *
 * 刻意**不复用**聊天里那套 `.md` 样式：那是给气泡里的一段话设计的（窄、紧凑、
 * 跟着主题变色），而作品是一份要打印、要发给别人的文档 —— 白底、留白、
 * 标题层级分明才对。两者的目标不同，共用一份只会让两边都别扭。
 */
const DOC_STYLE = `
  body { padding: 32px 40px; }
  .doc { max-width: 760px; margin: 0 auto; }
  .doc > *:first-child { margin-top: 0; }
  h1, h2, h3, h4 { margin: 1.6em 0 0.6em; line-height: 1.3; font-weight: 650; }
  h1 { font-size: 1.9em; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.3em; }
  h2 { font-size: 1.45em; }
  h3 { font-size: 1.2em; }
  p, li { font-size: 15px; }
  ul, ol { padding-left: 1.5em; }
  li { margin: 0.25em 0; }
  blockquote { margin: 1em 0; padding: 0.4em 1em; border-left: 3px solid #d4d4d8;
               background: #fafafa; color: #52525b; }
  hr { border: 0; border-top: 1px solid #e5e5e5; margin: 2em 0; }
  a { color: #2563eb; }
  code { padding: 0.15em 0.4em; border-radius: 4px; background: #f4f4f5;
         font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
  pre { padding: 14px 16px; border-radius: 8px; background: #18181b; color: #e4e4e7; overflow: auto; }
  pre code { padding: 0; background: none; color: inherit; font-size: 12.5px; line-height: 1.6; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  th, td { padding: 7px 11px; border: 1px solid #e5e5e5; text-align: left; font-size: 14px; }
  th { background: #fafafa; font-weight: 600; }
  .table-wrap { overflow-x: auto; }
  .mermaid-figure { margin: 1.4em 0; text-align: center; }
  .mermaid-figure svg { max-width: 100%; height: auto; }
  .render-error { margin: 1.2em 0; padding: 10px 12px; border-radius: 6px;
                  background: #fef2f2; color: #b91c1c; font-size: 13px; white-space: pre-wrap; }
`

function wrapDoc({ body, allowedOrigins, style = '' }) {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    cspMeta(allowedOrigins),
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${BASE_STYLE}${style}</style>`,
    '</head><body>',
    body,
    '</body></html>',
  ].join('')
}

/* ═══════════════ web：多文件静态网页 ═══════════════ */

/** 后缀 → data: URI 的 MIME。只覆盖作品里可能出现的那几种文本资源 */
const DATA_MIME = {
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
}

function toDataUri(path, content) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  const mime = DATA_MIME[ext] || 'text/plain'
  // encodeURIComponent 而不是 base64：内容是文本，这样出问题时在开发者工具里还看得懂
  return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`
}

/**
 * 把同一份作品内的相对引用内联进 HTML。
 *
 * 覆盖三种最常见的写法：`<link rel=stylesheet href=…>`、`<script src=…>`、
 * `src=…`（img/iframe/audio 等）。引用作品之外的地址一律原样留着 —— 它会被
 * CSP 拦下，而**留着比抹掉好**：控制台里能看到是哪一条被拦了。
 */
function inlineRefs(html, byPath) {
  const pick = (raw) => {
    const clean = String(raw || '').trim().replace(/^\.\//, '')
    return byPath.has(clean) ? { path: clean, content: byPath.get(clean) } : null
  }

  return html
    .replace(/<link\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi, (match, href) => {
      if (!/stylesheet/i.test(match)) return match
      const hit = pick(href)
      return hit ? `<style data-from="${escapeHtml(hit.path)}">\n${hit.content}\n</style>` : match
    })
    .replace(/<script\b([^>]*?)\ssrc\s*=\s*["']([^"']+)["']([^>]*)><\/script>/gi, (match, before, src, after) => {
      const hit = pick(src)
      if (!hit) return match
      const isModule = /type\s*=\s*["']module["']/i.test(before + after)
      return `<script${isModule ? ' type="module"' : ''} data-from="${escapeHtml(hit.path)}">\n${hit.content}\n</script>`
    })
    .replace(/\ssrc\s*=\s*["']([^"']+)["']/gi, (match, src) => {
      const hit = pick(src)
      // 上面已经把 <script src> 换掉了，这里剩下的是 img/iframe/audio 这类
      return hit ? ` src="${toDataUri(hit.path, hit.content)}"` : match
    })
}

function buildWebDoc({ files, entry, allowedOrigins }) {
  const byPath = new Map(files.map((file) => [file.path, file.content]))
  const html = byPath.get(entry) ?? files[0]?.content ?? ''
  const inlined = inlineRefs(html, byPath)
  const meta = cspMeta(allowedOrigins)

  /**
   * CSP meta 只对**它后面**的内容生效，所以要插在 `<head>` 的最前面 ——
   * 插晚了，前面那些 `<script src>` 就已经放行了，而这种漏法在界面上
   * 完全看不出来（页面照常显示，只是防线没了）。
   */
  if (/<head[\s>]/i.test(inlined)) return inlined.replace(/<head([^>]*)>/i, `<head$1>${meta}`)
  if (/<html[\s>]/i.test(inlined)) return inlined.replace(/<html([^>]*)>/i, `<html$1>${meta}`)
  return wrapDoc({ body: inlined, allowedOrigins })
}

/* ═══════════════ vue：沙箱内组装模块图 ═══════════════ */

/**
 * 在沙箱里把编译产物拼成可运行的模块图。
 *
 * blob URL **只能在沙箱内部造** —— 它按源隔离，父页面造的那个，不透明源的
 * iframe 根本用不了。所以这段代码必须以字符串形式随文档发过去。
 *
 * 依赖顺序靠递归解决：先把自己依赖的模块造出来拿到 URL，替换掉占位符，
 * 再造自己 —— 天然就是拓扑序。循环依赖会撞上 stack 检查，明确报错而不是栈溢出。
 */
const VUE_LOADER = `
  const payload = JSON.parse(document.getElementById('ap-vue-payload').textContent)
  const SOURCES = payload.sources
  const urls = {}

  function urlFor(path, stack) {
    if (urls[path]) return urls[path]
    if (stack.includes(path)) throw new Error('循环依赖：' + stack.concat(path).join(' → '))
    if (!(path in SOURCES)) throw new Error('找不到模块：' + path)
    // 先把依赖造出来拿到 URL 再造自己 —— 这个递归天然就是拓扑序
    const code = SOURCES[path].replace(
      /\\u0000MOD:(.*?)\\u0000/g,
      (m, dep) => urlFor(dep, stack.concat(path)),
    )
    urls[path] = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    return urls[path]
  }

  function fail(err) {
    // 用 textContent 而不是 innerHTML：报错信息里可能带着模型写的代码片段
    const box = document.createElement('pre')
    box.className = 'boot-error'
    box.textContent = '预览失败：' + ((err && err.message) || err)
    document.body.appendChild(box)
  }

  try {
    Promise.all([import(urlFor(payload.entry, [])), import(urlFor('vue', []))])
      .then(([app, vue]) => { vue.createApp(app.default).mount('#app') })
      .catch(fail)
  } catch (err) { fail(err) }
`

/**
 * 把编译产物嵌进文档。
 *
 * 源码走 `<script type="application/json">` 而不是拼进 JS 字面量：模块正文里
 * 什么引号、反引号、`${}` 都可能出现，拼字面量迟早被一段模型写的代码撬开。
 * JSON 块唯一要躲的是 `</script`（HTML 解析器不认识 JSON，见了就闭合），
 * 顺手把 `<!--` 一起转义掉。
 */
function jsonForScriptTag(value) {
  return JSON.stringify(value)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
}

async function buildVueDoc({ files, entry, allowedOrigins }) {
  const { modules, styles } = await compileVueProject(files, entry)

  return wrapDoc({
    allowedOrigins,
    style: `${styles}\n.boot-error{padding:16px;color:#b91c1c;white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace}`,
    body: [
      '<div id="app"></div>',
      // 占位符里的 NUL 被 JSON.stringify 转义成 \u0000，与 loader 里的正则正好对上
      `<script type="application/json" id="ap-vue-payload">${jsonForScriptTag({ sources: modules, entry })}</script>`,
      `<script type="module">${VUE_LOADER}</script>`,
    ].join('\n'),
  })
}

/* ═══════════════ markdown / mermaid / svg ═══════════════ */

async function buildMarkdownDoc({ files, entry, allowedOrigins }) {
  const source = files.find((file) => file.path === entry)?.content ?? files[0]?.content ?? ''

  /**
   * 先把 mermaid 围栏挖出来单独渲染，再走 markdown。
   *
   * 顺序不能反：renderMarkdown 会把围栏变成 `<pre><code>`，那时候图已经
   * 是一段被转义的文本了，再想认出来就只能去解析我们自己生成的 HTML。
   */
  const diagrams = []
  MERMAID_FENCE.lastIndex = 0
  const staged = source.replace(MERMAID_FENCE, (match, code) => {
    diagrams.push(code)
    return `\n\u0000MMD${diagrams.length - 1}\u0000\n`
  })

  const rendered = await Promise.all(diagrams.map(async (code) => {
    try {
      return `<div class="mermaid-figure">${await renderMermaid(code)}</div>`
    } catch (error) {
      // 一张图画不出来不该把整篇文档带走：就地显示错误，其余照常渲染
      return `<div class="render-error">${escapeHtml(error.message)}</div>`
    }
  }))

  const body = renderMarkdown(staged).replace(/\u0000MMD(\d+)\u0000/g, (match, index) => rendered[Number(index)])
  return wrapDoc({ body: `<div class="doc">${body}</div>`, allowedOrigins, style: DOC_STYLE })
}

async function buildMermaidDoc({ files, entry, allowedOrigins }) {
  const source = files.find((file) => file.path === entry)?.content ?? files[0]?.content ?? ''
  let body
  try {
    body = `<div class="mermaid-figure">${await renderMermaid(source)}</div>`
  } catch (error) {
    body = `<div class="render-error">${escapeHtml(error.message)}</div>`
  }
  return wrapDoc({ body: `<div class="doc">${body}</div>`, allowedOrigins, style: DOC_STYLE })
}

function buildSvgDoc({ files, entry, allowedOrigins }) {
  const source = files.find((file) => file.path === entry)?.content ?? files[0]?.content ?? ''
  return wrapDoc({
    body: source,
    allowedOrigins,
    style: 'body{display:flex;align-items:center;justify-content:center;min-height:100vh}svg{max-width:100%;max-height:100vh;height:auto}',
  })
}

/**
 * 一份作品 → 预览文档。
 *
 * 异步是因为 Vue 要编译、mermaid 要渲染，两者的依赖都是按需加载的
 * （加起来几 MB，不该让没用到的人也付这个首屏成本）。
 *
 * @returns {Promise<{html: string, error: string}>} 出错时 html 是一份说明页，
 *   而不是空白 —— "预览区一片白"是最难查的一种失败。
 */
export async function buildPreviewDoc({ kind, files = [], entry = '', allowedOrigins = [] }) {
  const context = { files, entry: entry || files[0]?.path || '', allowedOrigins }
  try {
    if (kind === 'web') return { html: buildWebDoc(context), error: '' }
    if (kind === 'vue') return { html: await buildVueDoc(context), error: '' }
    if (kind === 'markdown') return { html: await buildMarkdownDoc(context), error: '' }
    if (kind === 'mermaid') return { html: await buildMermaidDoc(context), error: '' }
    if (kind === 'svg') return { html: buildSvgDoc(context), error: '' }
    return { html: '', error: `不支持预览的类型：${kind}` }
  } catch (error) {
    const message = error?.message || String(error)
    return {
      error: message,
      html: wrapDoc({
        allowedOrigins,
        style: DOC_STYLE,
        body: `<div class="doc"><div class="render-error">${escapeHtml(message)}</div></div>`,
      }),
    }
  }
}

/**
 * 存成文件。
 *
 * 用手里已经有的内容造 Blob，而**不是**给 `/v1/artifacts/:id/raw` 挂一个 `<a href>`。
 * 两个理由，第二个是硬的：
 *   1. 内容早就随详情接口回来了，再请求一次是白跑；
 *   2. `<a href>` 发出去的请求**带不上 Authorization 头**（令牌在 localStorage 里，
 *      不是 Cookie）—— 那条链接在 password 模式下必然 401。
 *
 * raw 接口仍然留着：它是给 curl / 脚本这类能自己带头的调用方用的。
 */
export function downloadText({ content, fileName }) {
  const url = URL.createObjectURL(new Blob([String(content ?? '')], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName || 'artifact.txt'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 立刻 revoke 会让部分浏览器的下载来不及取到数据，延后一拍
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export { hasMermaid, MODULE_TOKEN }
