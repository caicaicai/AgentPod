/**
 * 在浏览器里把一组 `.vue` 单文件组件编译成能在预览沙箱里跑的模块图。
 *
 * ── 为什么必须自己编译 ──────────────────────────────────────────────────
 *
 * `.vue` 不是浏览器认识的东西，正常流程里它由构建工具（vite / webpack）处理掉。
 * 预览沙箱里没有构建工具，也**不能上网去拿一个**（CSP 默认全封，见 artifact-view.js）。
 * 所以编译这一步只能发生在这里：`@vue/compiler-sfc` 有浏览器构建，
 * Vue 官方的 SFC Playground 走的就是这条路。
 *
 * 依赖是**按需加载**的：compiler-sfc 一个人 1.7MB，只有真的预览 Vue 作品时才拉。
 *
 * ── 产出是什么 ──────────────────────────────────────────────────────────
 *
 * 一组 ESM 源码（路径 → 代码），其中彼此之间的 import 已经被换成占位符。
 * 真正的 URL 只能在沙箱**内部**生成 —— blob URL 是按源隔离的，父页面造的那个，
 * 不透明源的 iframe 根本用不了。所以这里只负责"编译 + 把依赖关系标出来"，
 * 拼 blob 的那几行跑在 iframe 里（见 artifact-view.js 的 VUE_LOADER）。
 */

/**
 * 依赖占位符：`\u0000MOD:<路径>\u0000`。
 *
 * 用 NUL 兜边，因为正常代码里不可能出现它，不会被模型写的内容撞上。
 * 写成转义序列而不是直接敲那个不可见字符：源码里看得见，才改得对、diff 得出来。
 */
export const MODULE_TOKEN = (specifier) => `\u0000MOD:${specifier}\u0000`

let compilerPromise = null
let runtimePromise = null

/** compiler-sfc 与 Vue 运行时都只在真的要用时才拉（各自 1.7MB / 170KB） */
function loadCompiler() {
  if (!compilerPromise) compilerPromise = import('@vue/compiler-sfc')
  return compilerPromise
}
function loadRuntimeSource() {
  // `?raw` 拿到的是**源码字符串**：它要作为一个模块塞进沙箱里，而不是在本页执行
  if (!runtimePromise) runtimePromise = import('vue/dist/vue.esm-browser.prod.js?raw').then((m) => m.default)
  return runtimePromise
}

/** `./components/Foo.vue` + 当前文件路径 → 作品内的绝对路径 */
export function resolvePath(from, specifier) {
  if (!specifier.startsWith('.')) return specifier // 裸包名（vue），交给调用方处理
  const base = from.split('/').slice(0, -1)
  const out = []
  for (const part of [...base, ...specifier.split('/')]) {
    if (part === '.' || part === '') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/**
 * 把模块里的 import/export 说明符换成占位符，并收集依赖。
 *
 * 用正则而不是解析 AST：这里要处理的只有 `from '…'` 和 `import '…'` 两种形态，
 * 而引一个 parser 是为了几行字符串替换再加几百 KB。代价是字符串字面量里出现
 * `from 'x'` 这样的内容会被误伤 —— 概率极低，且后果是"预览报错"而不是"悄悄错"。
 */
function rewriteImports(code, fromPath, onDep) {
  return code.replace(
    /(\bfrom\s*|\bimport\s*|\bimport\(\s*)(['"])([^'"]+)\2/g,
    (match, head, quote, specifier) => {
      const resolved = specifier.startsWith('.') ? resolvePath(fromPath, specifier) : specifier
      onDep(resolved)
      return `${head}${quote}${MODULE_TOKEN(resolved)}${quote}`
    },
  )
}

/**
 * 编译一份 Vue 作品。
 *
 * @param {Array<{path: string, content: string}>} files
 * @param {string} entry  入口，通常是 App.vue
 * @returns {Promise<{modules: Record<string,string>, styles: string, entry: string}>}
 */
export async function compileVueProject(files, entry) {
  const compiler = await loadCompiler()
  const byPath = new Map(files.map((file) => [file.path, file.content]))
  const modules = {}
  const styles = []
  const missing = new Set()

  const noteDep = (specifier) => {
    if (specifier === 'vue') return
    if (!byPath.has(specifier)) missing.add(specifier)
  }

  for (const file of files) {
    if (file.path.endsWith('.vue')) {
      modules[file.path] = compileSfc(compiler, file, styles, noteDep)
    } else if (file.path.endsWith('.js') || file.path.endsWith('.mjs')) {
      modules[file.path] = rewriteImports(file.content, file.path, noteDep)
    } else if (file.path.endsWith('.css')) {
      styles.push(file.content)
    }
    // 其余（.json/.md 之类）不进模块图：能 import 它们需要一整套 loader 语义，
    // 而 Vue 作品里真正需要的是组件和工具函数
  }

  if (missing.size) {
    /**
     * 把"缺什么"当场说清楚。
     *
     * 最常见的两种都在这儿：模型 import 了一个第三方包（沙箱里没有 npm），
     * 或者路径写错了。不报的话表现是白屏 + 控制台一句 `Failed to fetch
     * dynamically imported module`，而那句话指不到是哪个文件写错了。
     */
    throw new Error(
      `这些依赖在作品里找不到：${[...missing].join('、')}。`
      + '预览沙箱里没有 npm，除 vue 外不能 import 第三方包；相对路径请对照文件列表检查。',
    )
  }

  // Vue 运行时作为一个普通模块塞进图里，`import ... from 'vue'` 就自然解析到它
  modules.vue = await loadRuntimeSource()

  return { modules, styles: styles.join('\n'), entry }
}

/**
 * 单个 SFC → ESM。
 *
 * `<script setup>` 和 `<template>` 由 compiler-sfc 分别编译，再拼成一个模块：
 * 前者产出组件对象，后者产出 render 函数，最后挂上去。这正是构建工具在做的事，
 * 只是这里省掉了 HMR、sourcemap、scoped id 稳定性那些只有工程化才需要的部分。
 */
function compileSfc(compiler, file, styles, noteDep) {
  const { descriptor, errors } = compiler.parse(file.content, { filename: file.path })
  if (errors?.length) throw new Error(`${file.path} 解析失败：${errors[0].message}`)

  // scoped 样式要靠这个 id 把组件和 CSS 对上。用路径的哈希而不是随机数：
  // 同一份作品每次预览生成的 id 一样，改一行不会让整棵树的 class 全变
  const id = hashId(file.path)

  const hasScoped = descriptor.styles.some((style) => style.scoped)
  const script = compiler.compileScript(descriptor, { id, inlineTemplate: false })

  /**
   * 先把 `export default …` 变成 `const _sfc_main = …`，**再**往后拼 render。
   *
   * 顺序反了就白做：拼在后面的 `export default _sfc_main` 会和 compileScript
   * 自己那句 `export default` 撞成"重复的默认导出"，模块直接解析失败。
   * （`<script setup>` 产出的是 `export default _defineComponent({…})`，
   * 普通 `<script>` 产出的是 `export default {…}`，两种都要接住。）
   */
  let code = rewriteImports(script.content, file.path, noteDep)
    .replace(/export default (\/\*[^*]*\*\/\s*)?_defineComponent/, 'const _sfc_main = $1_defineComponent')
    .replace(/export default \{/, 'const _sfc_main = {')
  if (!/\bconst _sfc_main\b/.test(code)) {
    // 没接住说明 compiler 换了产物形状。宁可当场报出来，也不要产出一个
    // 没有默认导出的模块 —— 那表现成"白屏 + 一句 undefined is not a component"
    throw new Error(`${file.path} 的 <script> 产物没认出来，无法预览（组件需要一个默认导出）`)
  }

  if (descriptor.template) {
    const template = compiler.compileTemplate({
      id,
      filename: file.path,
      source: descriptor.template.content,
      scoped: hasScoped,
      compilerOptions: { scopeId: hasScoped ? `data-v-${id}` : undefined },
    })
    if (template.errors?.length) {
      throw new Error(`${file.path} 的 template 编译失败：${template.errors[0].message || template.errors[0]}`)
    }
    /**
     * template 产物自己也 `import { … } from "vue"` 并 `export function render`。
     * 前者要一起走占位符改写（否则沙箱里解析不到 vue），
     * 后者要降级成局部函数（一个模块里只能有一份默认导出，render 不该外泄）。
     */
    const rendered = rewriteImports(template.code, file.path, noteDep)
      .replace(/export function render/, 'function render')
    code += `\n${rendered}\n_sfc_main.render = render\n`
  }
  if (hasScoped) code += `_sfc_main.__scopeId = "data-v-${id}"\n`
  code += 'export default _sfc_main\n'

  for (const style of descriptor.styles) {
    const compiled = compiler.compileStyle({
      id, filename: file.path, source: style.content, scoped: style.scoped,
    })
    if (compiled.errors?.length) throw new Error(`${file.path} 的 style 编译失败：${compiled.errors[0].message}`)
    styles.push(compiled.code)
  }

  return code
}

/** 路径 → 稳定的短 id（scoped 样式的 data-v-xxx） */
function hashId(text) {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36).slice(0, 8)
}
