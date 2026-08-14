/**
 * artifact —— 作品：把「产出物」从对话正文里拆出来单独存、单独渲染。
 *
 * ── 这个工具的收益在哪 ──────────────────────────────────────────────────
 *
 * 不是"多一个存文件的地方"。真正省下来的是**改一版的代价**：
 * 贴在对话里的 200 行 HTML，改一个颜色也要整段重发（模型输出翻倍、还容易在重贴
 * 时把别处改坏）；而作品有 id + 文件路径，改一处就发 `update` + 那一小段 old/new。
 *
 * ── 与 write / bash 的分工 ──────────────────────────────────────────────
 *
 * `write` 写的是**沙盒工作区里的文件**：给脚本读、给命令跑，用户看不见。
 * `artifact` 存的是**给人看的成品**：会在界面上渲染成可预览、可下载、有版本的卡片。
 * 一份东西属于哪边，判据是"下一步是被程序读，还是被人读"。
 *
 * ── 返回值刻意不含正文 ──────────────────────────────────────────────────
 *
 * 正文在入参里已经过了一遍，工具结果再回一份就是同样的内容在上下文里躺两份。
 * 所以只回 `{ id, version, title, files }`。这也是界面识别作品卡片的正信号
 * （与 task_plan 回 `plan` 同一个套路）。
 */
import { jsonResult } from './plugin-api.js'
import { ARTIFACT_KINDS } from '../artifacts/store.js'

/**
 * 预览环境的硬约束，要**讲给模型听**。
 *
 * 界面把作品放进一个不带 `allow-same-origin` 的 sandbox iframe 里渲染
 * （见 web/src/modules/artifacts/artifact-view.js：它是这套设计里唯一挡住"模型生成的脚本读走
 * 用户登录态"的东西）。代价是那个文档处于**不透明源**：`localStorage`、
 * `document.cookie`、`indexedDB` 一碰就抛。
 *
 * 不讲的话，模型会照着写网页的常识去用 localStorage 存状态，然后页面在预览里
 * 白屏 —— 而它完全看不到这个结果，只会反复"修"一个根本不在它那儿的问题。
 */
function previewRules(allowedOrigins) {
  return [
    '**预览环境（写代码前必读）**：作品跑在一个隔离的 iframe 里（不透明源），有两条硬约束：',
    '1. **不能用 localStorage / sessionStorage / document.cookie / indexedDB** —— 一碰就抛异常导致白屏。要保存状态就用内存变量。',
    allowedOrigins.length
      ? `2. 外部资源只允许来自：${allowedOrigins.join('、')}。除此之外的 CDN、图片、字体、接口一律加载不到。`
      : '2. **加载不了任何外部资源**（CDN 脚本、外链图片/字体、fetch 请求全部被拦）。所有依赖必须自带，图片用 data: URI 或直接画 SVG。',
  ].join('\n')
}

/** 各类型的写法要求。写不对的后果都是"预览白屏而模型看不见"，所以逐条说死 */
const KIND_RULES = [
  '**web** — 多文件静态网页。入口 `index.html`；`<link rel="stylesheet" href="style.css">`、',
  '`<script src="app.js">`、`<img src="logo.svg">` 这类**同作品内的相对引用会被自动内联**，',
  '所以尽管按正常的多文件方式写。不要引用作品之外的任何地址。',
  '',
  '**vue** — Vue 3 单文件组件项目。入口 `App.vue`，可以拆成 `components/Xxx.vue`、`utils/foo.js`。',
  '用 `<script setup>`；组件之间用相对路径 `import Foo from "./components/Foo.vue"`；',
  '`import { ref } from "vue"` 可用（运行时是内置的）。**除 `vue` 外不能 import 任何第三方包** ——',
  '没有 npm、没有 CDN，装不上就是白屏。`<style scoped>` 支持。',
  '',
  '**markdown** — 文档。支持表格、代码块，以及 ```mermaid 围栏（会渲染成图）。适合报告、方案、说明书。',
  '',
  '**mermaid** — 单张图，文件内容就是 mermaid 语法本身（`.mmd`），不要再套 ``` 围栏。',
  'flowchart / sequenceDiagram / gantt / classDiagram / stateDiagram / erDiagram / pie 都支持。',
  '',
  '**svg** — 手写矢量图。',
  '',
  '**code** — 代码或配置（脚本、SQL、YAML…）。只展示源码不预览，用 language 标明语言。',
].join('\n')

function describe(allowedOrigins) {
  return [
    '把一份**给人看的成品**存成「作品」：它会在对话旁边渲染成可预览、可切版本、可下载的卡片，而不是一堵贴在聊天里的代码墙。',
    '**一份作品是一组文件**（不是一段文本），所以复杂一点的东西该怎么拆就怎么拆。',
    '',
    '**什么时候用**：产出的东西同时满足「篇幅较长（约 15 行以上）」「自成一体，脱离这次对话也有用」「用户多半会保存、反复看或继续改」。',
    '',
    '**什么时候不要用**：解释性的说明、几行示例代码、命令行片段、对问题的直接回答 —— 这些直接写在回复正文里，放进作品反而要用户多点一下才能看到。',
    '给脚本读、给命令跑的中间文件也不要用，那是 `write` 的事。',
    '',
    `**kind 取值**：${ARTIFACT_KINDS.join(' / ')}`,
    '',
    KIND_RULES,
    '',
    '**怎么拆文件**：单文件放得下就别硬拆；但只要出现「多个组件」「样式和逻辑各成一块」「有可复用的工具函数」，就拆开 ——',
    '拆开之后改一处只需重发那一个文件，而且用户在面板里能按文件读。',
    '常见形态：`index.html` + `style.css` + `app.js`；`App.vue` + `components/*.vue` + `utils/*.js`。',
    '',
    '**改已有作品用 update / write，不要重新 create。** 重建会丢掉版本历史，界面上还会多出一张孤零零的旧卡片。',
    '- `update`：改某个文件里的一小段（定点替换，最省）。old_str 必须在**那个文件里唯一**出现，缩进和换行要一模一样。',
    '- `write`：新增文件、整份替换某个文件、或删文件（`remove`）。**只传改动的文件**，没提到的原样保留。',
    '- 不确定当前内容是什么就先 `read`（不带 path 回文件清单，带 path 回该文件正文）。',
    '',
    previewRules(allowedOrigins),
    '',
    '**存完之后不要在回复里把正文再贴一遍** —— 用户已经能在旁边看到了。只说一句你做了什么、改了哪里。',
  ].join('\n')
}

const FILE_ITEM = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: '相对路径，如 index.html / components/Chart.vue。只能用字母数字和 . _ - /，最多 6 层。',
    },
    content: { type: 'string', description: '该文件的完整内容。' },
  },
  required: ['path', 'content'],
}

const SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'update', 'write', 'read'],
      description: 'create=新建 / update=改某文件里的一小段 / write=增删或整份替换文件 / read=读回当前内容',
    },
    id: { type: 'string', description: '作品 id。create 之外的操作必填，取自 create 的返回值。' },
    kind: {
      type: 'string',
      enum: ARTIFACT_KINDS,
      description: 'create 必填。web=多文件网页 / vue=Vue 组件项目 / markdown=文档 / mermaid=图 / svg=矢量图 / code=代码',
    },
    title: { type: 'string', description: 'create 必填：一句话标题，会显示在卡片上。write 时可顺带改名。' },
    files: { type: 'array', description: 'create / write 的文件列表。write 时只传改动的那几个。', items: FILE_ITEM },
    entry: { type: 'string', description: '预览入口文件，不传按类型取惯例（web→index.html，vue→App.vue…）。' },
    remove: { type: 'array', description: 'write：要删掉的文件路径。', items: { type: 'string' } },
    path: { type: 'string', description: 'update 必填：改哪个文件。read 时传它表示只要这一个文件的正文。' },
    old_str: { type: 'string', description: 'update：要被替换掉的原文片段，必须在该文件里唯一出现。' },
    new_str: { type: 'string', description: 'update：替换成的新片段。删除一段就传空串。' },
    language: { type: 'string', description: 'kind=code 时的语言，如 python / sql / yaml。' },
    version: { type: 'number', description: 'read：要读第几版，不传读最新版。' },
  },
  required: ['action'],
}

/** 单次 read 回多少正文。再多就把上下文顶满了 —— 要看细节应该按 path 逐个读 */
const READ_MAX_CHARS = 60000

/**
 * 回给模型 / 界面的那份元信息，**刻意比 store 的 toPublic 更薄**。
 *
 * 砍掉的是 `versions` 全表（每版还带文件清单，摊开很大）。两个理由，第二个是硬的：
 *   1. 模型不需要它 —— 它只关心"现在是第几版、有哪些文件"；
 *   2. 工具结果在事件流里有 4000 字符的预览上限（events.js 的 TOOL_PREVIEW_MAX），
 *      一旦被截断，前端解析不出 `artifact` 字段，对话里那张作品卡片就画不出来了 ——
 *      表现是"改了几版之后卡片突然不见了"，而这跟改了几版看起来毫无关系。
 */
function toCardMeta(meta) {
  const current = meta.versions.find((item) => item.n === meta.version)
  return {
    id: meta.id,
    title: meta.title,
    kind: meta.kind,
    language: meta.language || undefined,
    entry: meta.entry,
    version: meta.version,
    files: (current?.files || []).map((file) => file.path),
  }
}

export function registerArtifactTool(api) {
  const artifacts = api.ctx.artifacts
  const allowedOrigins = api.config?.artifacts?.allowedOrigins || []

  api.registerTool({
    name: 'artifact',
    label: '作品',
    description: describe(allowedOrigins),
    parameters: SCHEMA,
    async execute(_toolCallId, params) {
      const action = String(params?.action || '').trim()
      const id = String(params?.id || '').trim()

      try {
        if (action === 'create') {
          const meta = await artifacts.create({
            kind: String(params?.kind || '').trim(),
            title: params?.title,
            files: params?.files,
            entry: params?.entry,
            language: params?.language,
          })
          return jsonResult({
            ok: true,
            artifact: toCardMeta(meta),
            note: '已经在界面上渲染出来了，回复里不用再贴一遍内容。后续修改带上这个 id 调 update / write。',
          })
        }

        if (!id) return jsonResult({ ok: false, error: `action=${action} 必须带 id（create 的返回值里有）` })

        if (action === 'read') {
          const current = await artifacts.read({ id, version: params?.version })
          if (!current) return jsonResult({ ok: false, error: `没有这个作品：${id}` })

          const wanted = String(params?.path || '').trim()
          if (wanted) {
            const file = current.files.find((item) => item.path === wanted)
            if (!file) {
              return jsonResult({
                ok: false,
                error: `第 ${current.version} 版没有 ${wanted}（现有：${current.files.map((item) => item.path).join('、')}）`,
              })
            }
            return jsonResult({
              ok: true,
              artifact: toCardMeta(current.meta),
              version: current.version,
              path: file.path,
              ...clip(file.content),
            })
          }

          /**
           * 不带 path 时回**清单 + 能装下的正文**。
           *
           * 单文件作品（多数情况）一次就读全了；文件多的时候只回清单，让模型
           * 按 path 逐个读 —— 比一股脑塞进去然后被截断强，截断之后它拿半截正文
           * 去拼 old_str，必然匹配不上，而它看不出原因。
           */
          const total = current.files.reduce((sum, file) => sum + file.content.length, 0)
          return jsonResult({
            ok: true,
            artifact: toCardMeta(current.meta),
            version: current.version,
            files: total <= READ_MAX_CHARS
              ? current.files.map((file) => ({ path: file.path, content: file.content }))
              : current.files.map((file) => ({ path: file.path, chars: file.content.length })),
            ...(total > READ_MAX_CHARS
              ? { note: `全部文件共 ${total} 字符，超过一次读取上限，只回了清单。要正文请带 path 逐个读。` }
              : {}),
          })
        }

        if (action === 'update') {
          const meta = await artifacts.replace({
            id, path: params?.path, oldStr: params?.old_str, newStr: params?.new_str ?? '',
          })
          if (!meta) return jsonResult({ ok: false, error: `没有这个作品：${id}` })
          return jsonResult({ ok: true, artifact: toCardMeta(meta) })
        }

        if (action === 'write') {
          const meta = await artifacts.write({
            id,
            files: params?.files || [],
            remove: params?.remove || [],
            entry: params?.entry,
            title: params?.title,
          })
          if (!meta) return jsonResult({ ok: false, error: `没有这个作品：${id}` })
          return jsonResult({ ok: true, artifact: toCardMeta(meta) })
        }

        return jsonResult({ ok: false, error: `未知 action：${action}（只能是 create / update / write / read）` })
      } catch (error) {
        /**
         * 校验类失败走 `{ok:false}` 而不是抛异常。
         *
         * 这些错误（old_str 不唯一、路径不合法、超上限、类型不对）**全都是模型下一步
         * 能自己改对的**，原话回给它就行。抛出去的话 pi 会生成一条 isError 的工具结果，
         * 界面上是一张红卡片 —— 而用户根本不需要看到"模型第一次没对齐缩进"。
         */
        return jsonResult({ ok: false, error: error?.message || String(error) })
      }
    },
  })
}

/** 单个文件太长时截断并说明白 —— 不说的话模型会拿半截正文去拼 old_str */
function clip(content) {
  if (content.length <= READ_MAX_CHARS) return { content }
  return {
    content: content.slice(0, READ_MAX_CHARS),
    truncated: true,
    note: `该文件共 ${content.length} 字符，只回了前 ${READ_MAX_CHARS} 字符`,
  }
}

export const artifactPlugin = {
  id: 'ap-artifact',
  register: registerArtifactTool,
}
