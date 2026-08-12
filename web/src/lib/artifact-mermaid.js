/**
 * mermaid 图 → SVG 字符串。
 *
 * ── 为什么在父页面渲染，而不是把 mermaid 塞进沙箱 ──────────────────────
 *
 * mermaid 的单文件 UMD 构建是 3.5MB。要在沙箱里跑，就得把这 3.5MB 内联进
 * `srcdoc` —— 每开一次预览、每张图一份。而它的 ESM 构建是**按图种分包**的
 * （用到时才拉那一块），只有走正常的模块加载才享受得到。
 *
 * 所以分工是：**在这里渲染成 SVG，把 SVG 交给沙箱去显示**。
 * 那条"模型生成的标记只在沙箱里被解释"的规则没有破 —— 产出的 SVG 仍然只在
 * iframe 里落地，父页面从头到尾只经手字符串。
 *
 * ⚠️ 残留风险要说清楚：mermaid 在测量文本时会把图**短暂**挂进本页 DOM。
 * 也就是说，图的语法是模型（也就可能是一封诱导邮件）决定的，而解析它的是本页的
 * mermaid。缓解手段是 `securityLevel: 'strict'`（mermaid 内置 DOMPurify，
 * 标签里的 HTML 会被转义，点击事件被禁用）——这正是 mermaid 为"不可信输入"
 * 提供的档位。这与"把 3.5MB 内联进每一次预览"之间，选了前者。
 */

let mermaidPromise = null

async function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        // 见文件头：图的内容不可信，这个档位是专门为此设的
        securityLevel: 'strict',
        theme: 'default',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      })
      return mermaid
    })
  }
  return mermaidPromise
}

/** 同一份图文本渲染出的 id 要稳定，否则每次预览 SVG 里的 id 全变，diff 起来没法看 */
let seq = 0

/**
 * @returns {Promise<string>} SVG 源码；失败时抛出带 mermaid 原话的错误
 */
export async function renderMermaid(source) {
  const mermaid = await loadMermaid()
  const text = String(source || '').trim()
  if (!text) return ''
  seq += 1
  try {
    const { svg } = await mermaid.render(`ap-mmd-${seq}`, text)
    return svg
  } catch (error) {
    /**
     * 把 mermaid 的原话带出来。
     *
     * 它的报错通常直接指到第几行第几个 token，对写图的人（这里是模型，
     * 下一轮会看到用户转述）最有用。包成一句"图渲染失败"等于把线索扔了。
     */
    throw new Error(`mermaid 语法有误：${error?.message || error}`)
  }
}

/** markdown 里的 ```mermaid 围栏 */
export const MERMAID_FENCE = /```mermaid\s*\n([\s\S]*?)```/g

/** 文本里有没有 mermaid 围栏 —— 有才值得去拉那个几 MB 的依赖 */
export function hasMermaid(text) {
  MERMAID_FENCE.lastIndex = 0
  return MERMAID_FENCE.test(String(text || ''))
}
