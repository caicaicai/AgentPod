/**
 * 源码高亮：把一段代码切成有类型的片段。
 *
 * ── 为什么不引 highlight.js / shiki ──────────────────────────────────────
 *
 * 两个理由，第二个才是决定性的：
 *
 * 1. **体积**。作品的源码页是"顺手看一眼"的地方，文件通常一两百行。
 *    为它拉一个百 KB 到几 MB 的分块，代价与收益不成比例。
 *    （markdown.js 当初拒绝 marked + highlight.js 也是同一笔账。）
 *
 * 2. **它们的产物是 HTML 字符串。** 那意味着要在**父页面**里 `v-html` 一段
 *    由模型生成的内容加工出来的标记 —— 而这套设计从头到尾守着一条相反的规矩：
 *    模型生成的标记只在沙箱 iframe 里被解释，父页面只经手字符串
 *    （见 artifact-view.js 文件头）。库本身会转义、通常没问题，但那是把一条
 *    结构性的保证换成了"依赖它没 bug"。
 *
 * 所以这里产出的是**词法片段数组**，由 Vue 用插值渲染成 `<span>` —— 全程没有
 * 一处 v-html，那条规矩一个字都不用改。
 *
 * ── 它做不到什么（写在前面，免得被当成缺陷）────────────────────────────
 *
 * 这是词法级的着色，不做语法分析：泛型里的 `<`、正则字面量里的引号、
 * 模板字符串里嵌的表达式，都可能着错色。对"读懂一份两百行的作品"够用，
 * 对当 IDE 用不够 —— 后者本来也不是这个页面的目标。
 *
 * ── 唯一一条硬约束 ──────────────────────────────────────────────────────
 *
 * **所有片段拼起来必须原样等于输入。** 高亮可以着错色，但绝不能吞字、
 * 重排或多吐一个字符 —— 那样用户复制走的源码就是坏的，而这种坏法
 * 极难被发现（看起来只是"颜色有点怪"）。test/highlight.test.js 逐条钉着它。
 */

/** 超过这个长度就不着色了：几十万字符的着色只会让页面卡住，而它本来就没人逐行读 */
const MAX_CHARS = 200_000

const KEYWORDS = {
  js: 'as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self',
  sql: 'select from where group by order having join left right inner outer full on as insert into values update set delete create table view drop alter add column index primary key foreign references not null default distinct limit offset union all case when then else end with asc desc between like in exists',
  sh: 'if then else elif fi for while do done case esac function return exit export local readonly source echo cd set unset trap shift',
  yaml: 'true false null yes no on off',
}

/** 词法规则：[类型, 粘性正则]，按顺序试，先中者胜 */
const RULES = {
  code: (keywords) => [
    ['com', /\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
    ['str', /`(?:\\[\s\S]|[^`\\])*`|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'/y],
    ['num', /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y],
    ['word', new RegExp(`\\b(?:${keywords.split(' ').join('|')})\\b`, 'y')],
    ['fn', /[A-Za-z_$][\w$]*(?=\s*\()/y],
    ['ident', /[A-Za-z_$][\w$]*/y],
    ['punc', /[{}[\]()<>;,.:?!+\-*/%=&|^~]+/y],
  ],
  hash: (keywords) => [
    ['com', /#[^\n]*/y],
    ['str', /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'/y],
    ['num', /\b\d+(?:\.\d+)?\b/y],
    ['word', new RegExp(`\\b(?:${keywords.split(' ').join('|')})\\b`, 'y')],
    ['fn', /[A-Za-z_][\w]*(?=\s*\()/y],
    ['ident', /[A-Za-z_][\w]*/y],
    ['punc', /[{}[\]():,.=+\-*/%<>!&|]+/y],
  ],
  sql: (keywords) => [
    ['com', /--[^\n]*|\/\*[\s\S]*?\*\//y],
    ['str', /'(?:''|[^'])*'|"(?:""|[^"])*"/y],
    ['num', /\b\d+(?:\.\d+)?\b/y],
    ['word', new RegExp(`\\b(?:${keywords.split(' ').join('|')})\\b`, 'iy')],
    ['fn', /[A-Za-z_][\w]*(?=\s*\()/y],
    ['ident', /[A-Za-z_][\w.]*/y],
    ['punc', /[(),;*=<>+\-/|]+/y],
  ],
  css: () => [
    ['com', /\/\*[\s\S]*?\*\//y],
    ['str', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/y],
    ['word', /@[A-Za-z-]+/y],
    ['num', /[+-]?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch)?\b|#[\da-fA-F]{3,8}\b/y],
    ['attr', /[A-Za-z-]+(?=\s*:)/y],
    ['fn', /[A-Za-z-]+(?=\s*\()/y],
    ['ident', /[.#]?[A-Za-z_][\w-]*/y],
    ['punc', /[{}();:,>+~*]+/y],
  ],
  markup: () => [
    ['com', /<!--[\s\S]*?-->/y],
    ['tag', /<\/?[A-Za-z][\w:-]*|\/?>/y],
    ['str', /"(?:[^"]*)"|'(?:[^']*)'/y],
    ['attr', /[@:.#A-Za-z_-][\w:.-]*(?==)/y],
    ['punc', /[=]+/y],
  ],
  md: () => [
    ['com', /^>[^\n]*/my],
    ['word', /^#{1,6} [^\n]*/my],
    ['str', /```[\s\S]*?```|`[^`\n]+`/y],
    ['fn', /\[[^\]\n]*\]\([^)\n]*\)/y],
    ['num', /\*\*[^*\n]+\*\*|^\s*[-*+] |^\s*\d+\. /my],
  ],
}

/** 一个关键词（后缀或语言名）→ 规则集。认不出来回空串 */
function fromKey(key) {
  if (!key) return ''
  if (['html', 'htm', 'xml', 'svg', 'vue'].includes(key)) return 'markup'
  if (['css', 'scss', 'less'].includes(key)) return 'css'
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'javascript', 'typescript'].includes(key)) return 'js'
  if (['py', 'python'].includes(key)) return 'py'
  if (['sql'].includes(key)) return 'sql'
  if (['sh', 'bash', 'zsh', 'shell'].includes(key)) return 'sh'
  if (['yml', 'yaml', 'toml', 'ini', 'conf', 'env'].includes(key)) return 'yaml'
  if (['md', 'markdown', 'mmd'].includes(key)) return 'md'
  return ''
}

/**
 * 用哪套规则。先看后缀，再看模型标的语言。
 *
 * 后缀要**真的有一个点**才算：`Dockerfile` 的 `lastIndexOf('.')` 是 -1，
 * 照着 `slice(index + 1)` 取会得到整个文件名当"后缀"，于是 `language: sh`
 * 这条线索被一个不存在的后缀挡住 —— 而 kind=code 的作品恰恰常常没有后缀。
 * `.gitignore` 同理（点在第 0 位，那是隐藏文件不是后缀）。
 */
export function detectLanguage(path = '', language = '') {
  const name = String(path || '')
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return fromKey(ext) || fromKey(String(language || '').toLowerCase().trim()) || 'text'
}

function rulesFor(lang) {
  if (lang === 'markup') return RULES.markup()
  if (lang === 'css') return RULES.css()
  if (lang === 'md') return RULES.md()
  if (lang === 'sql') return RULES.sql(KEYWORDS.sql)
  if (lang === 'py') return RULES.hash(KEYWORDS.py)
  if (lang === 'sh') return RULES.hash(KEYWORDS.sh)
  if (lang === 'yaml') return RULES.hash(KEYWORDS.yaml)
  if (lang === 'js') return RULES.code(KEYWORDS.js)
  return null
}

/** 扫一段文本，产出片段。没有规则命中的字符原样进 `''` 类型的片段 */
function scan(text, rules, out) {
  let index = 0
  let plain = ''
  const flush = () => { if (plain) { out.push({ t: '', text: plain }); plain = '' } }

  while (index < text.length) {
    let hit = null
    for (const [type, regex] of rules) {
      regex.lastIndex = index
      const match = regex.exec(text)
      if (match && match.index === index && match[0]) { hit = { type, text: match[0] }; break }
    }
    if (!hit) { plain += text[index]; index += 1; continue }
    flush()
    out.push({ t: hit.type, text: hit.text })
    index += hit.text.length
  }
  flush()
}

/**
 * HTML / Vue 里嵌的 `<script>` 与 `<style>` 换用对应的规则。
 *
 * 不这么做的话，一份 `.vue` 里最该看清楚的那段 `<script setup>` 会被当成标记，
 * 通篇没有一个关键字着色 —— 而 Vue 作品恰恰是这个页面的主要用途之一。
 */
const EMBED_RE = /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi

function tokenizeMarkup(code) {
  const out = []
  const markup = RULES.markup()
  let last = 0

  for (const match of code.matchAll(EMBED_RE)) {
    const [whole, open, tag, body, close] = match
    scan(code.slice(last, match.index), markup, out)
    scan(open, markup, out)
    scan(body, tag.toLowerCase() === 'style' ? RULES.css() : RULES.code(KEYWORDS.js), out)
    scan(close, markup, out)
    last = match.index + whole.length
  }
  scan(code.slice(last), markup, out)
  return out
}

/**
 * @returns {Array<{t: string, text: string}>} 片段序列。
 *   **拼起来永远等于输入** —— 见文件头那条硬约束。
 */
export function tokenize(code, lang) {
  const text = String(code ?? '')
  if (!text) return []
  // 太长就整段当普通文本：着色一份几十万字符的文件只会让页面卡住
  if (text.length > MAX_CHARS) return [{ t: '', text }]

  if (lang === 'markup') return tokenizeMarkup(text)
  const rules = rulesFor(lang)
  if (!rules) return [{ t: '', text }]

  const out = []
  scan(text, rules, out)
  return out
}
