/**
 * 作品预览的前端规则。
 *
 * 这里钉住的是**两道防线**，它们各挡各的（理由见 web/src/modules/artifacts/artifact-view.js 文件头）：
 *   1. iframe sandbox 绝不含 allow-same-origin —— 防读（模型生成的脚本读不到登录令牌）
 *   2. 文档内 CSP 默认 `default-src 'none'` —— 防写（脚本没法把看到的东西发出去）
 *
 * 以及多文件的那条：**沙箱里没有服务器**，`<script src="app.js">` 得在这里内联进去，
 * 否则多文件作品一预览就是白屏。
 *
 * Vue 与 mermaid 两条路不在这里测：前者要 Vite 的 `?raw` 才拿得到运行时源码，
 * 后者要浏览器 DOM 才能测量文本 —— 都不是 node 里跑得起来的东西。
 * 它们各自的纯函数（路径解析）单独测。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  ARTIFACT_RECIPES, KIND_META, PREVIEW_SANDBOX, buildPreviewDoc, composeArtifactPrompt,
  composeElementPrompt, filterArtifacts, kindLabel, needsFrame, parsePickedElement, supportsInspect,
} from '../web/src/modules/artifacts/artifact-view.js'
import { resolvePath } from '../web/src/modules/artifacts/artifact-vue.js'
import { layoutBlocks, readArtifactCard, toolBrief } from '../web/src/modules/chat/tools.js'

const build = (over = {}) => buildPreviewDoc({
  kind: 'web',
  files: [{ path: 'index.html', content: '<div>hi</div>' }],
  entry: 'index.html',
  ...over,
})

describe('沙箱属性', () => {
  /**
   * `allow-scripts` + `allow-same-origin` 一起给**等于什么都没给** —— 页面能自己
   * 把 iframe 的 sandbox 属性摘掉。这条是整套设计里最要紧的一行，
   * 所以单独一个用例钉死它。
   */
  test('绝不出现 allow-same-origin', () => {
    assert.equal(PREVIEW_SANDBOX.includes('allow-same-origin'), false)
    assert.match(PREVIEW_SANDBOX, /allow-scripts/)
  })

  test('只有 code 不进 iframe（它只展示源码）', () => {
    for (const kind of ['web', 'vue', 'markdown', 'mermaid', 'svg']) {
      assert.equal(needsFrame(kind), true, kind)
    }
    assert.equal(needsFrame('code'), false)
  })
})

describe('文档内 CSP', () => {
  test('默认全封：连不上任何外部地址', async () => {
    const { html } = await build()
    assert.match(html, /default-src 'none'/)
    assert.match(html, /connect-src 'none'/)
    assert.match(html, /form-action 'none'/)
    assert.match(html, /base-uri 'none'/)
  })

  test('配了白名单才放行，且脚本/样式/连接都跟着放', async () => {
    const { html } = await build({ allowedOrigins: ['https://cdn.example.com'] })
    assert.match(html, /script-src 'unsafe-inline' 'unsafe-eval' blob: https:\/\/cdn\.example\.com/)
    assert.match(html, /style-src 'unsafe-inline' https:\/\/cdn\.example\.com/)
    assert.match(html, /connect-src https:\/\/cdn\.example\.com/)
  })

  /**
   * CSP meta 只对**它后面**的内容生效。插晚了，前面那些 `<script src>` 就已经放行了
   * —— 而这种漏法在界面上完全看不出来（页面照常显示，只是防线没了）。
   */
  test('插在 head 的最前面，早于任何资源标签', async () => {
    const { html } = await build({
      files: [{
        path: 'index.html',
        content: '<!doctype html><html><head><script src="https://evil.example/x.js"></script></head><body>x</body></html>',
      }],
    })
    assert.ok(
      html.indexOf('Content-Security-Policy') < html.indexOf('evil.example'),
      'CSP 必须排在外部脚本之前',
    )
  })

  test('有 html 没 head 时也插得进去', async () => {
    const { html } = await build({ files: [{ path: 'index.html', content: '<html><body>x</body></html>' }] })
    assert.match(html, /<html><meta http-equiv="Content-Security-Policy"/)
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<body>'))
  })

  test('完整文档除了那条 meta 一个字不改', async () => {
    const source = '<!doctype html><html><head><title>t</title></head><body><p>正文</p></body></html>'
    const { html } = await build({ files: [{ path: 'index.html', content: source }] })
    assert.match(html, /<title>t<\/title>/)
    assert.match(html, /<p>正文<\/p>/)
    assert.equal(html.match(/<html/g).length, 1, '没有被套上第二层 <html>')
  })
})

/**
 * 沙箱里没有服务器，相对引用没人解析 —— 不内联的话，多文件作品一预览就是白屏，
 * 而这在"单文件时明明是好的"的映衬下极难联想到原因。
 */
describe('多文件：把作品内的引用内联进去', () => {
  const site = (html) => build({
    entry: 'index.html',
    files: [
      { path: 'index.html', content: html },
      { path: 'style.css', content: 'body { color: red }' },
      { path: 'app.js', content: 'console.log("hi")' },
      { path: 'logo.svg', content: '<svg/>' },
    ],
  })

  test('样式表变成 <style>', async () => {
    const { html } = await site('<link rel="stylesheet" href="style.css"><p>x</p>')
    assert.match(html, /<style data-from="style\.css">\s*body \{ color: red \}/)
    assert.equal(html.includes('<link'), false)
  })

  test('脚本变成内联脚本，./ 前缀也认', async () => {
    const { html } = await site('<script src="./app.js"></script>')
    assert.match(html, /<script data-from="app\.js">\s*console\.log\("hi"\)/)
  })

  test('type=module 的脚本保持 module', async () => {
    const { html } = await site('<script type="module" src="app.js"></script>')
    assert.match(html, /<script type="module" data-from="app\.js">/)
  })

  test('img 之类换成 data: URI', async () => {
    const { html } = await site('<img src="logo.svg">')
    assert.match(html, /src="data:image\/svg\+xml;charset=utf-8,/)
  })

  /**
   * 作品之外的地址**原样留着**，让 CSP 去拦。抹掉的话控制台里干干净净，
   * 没人看得出"这个页面本来想加载点什么"。
   */
  test('外部地址不动，交给 CSP 拦', async () => {
    const { html } = await site('<script src="https://cdn.example.com/x.js"></script>')
    assert.match(html, /src="https:\/\/cdn\.example\.com\/x\.js"/)
  })
})

describe('文档类预览', () => {
  test('markdown 渲染成一份独立排版的文档', async () => {
    const { html, error } = await buildPreviewDoc({
      kind: 'markdown',
      entry: 'README.md',
      files: [{ path: 'README.md', content: '# 标题\n\n- 一\n- 二\n' }],
    })
    assert.equal(error, '')
    assert.match(html, /<h1>标题<\/h1>/)
    assert.match(html, /<li>一<\/li>/)
    assert.match(html, /class="doc"/)
  })

  /** markdown 走的是转义优先的渲染器，模型写的 HTML 不会变成真标签 */
  test('markdown 里的裸 HTML 被转义，不会当标签跑', async () => {
    const { html } = await buildPreviewDoc({
      kind: 'markdown',
      entry: 'README.md',
      files: [{ path: 'README.md', content: '正文 <img src=x onerror=alert(1)>' }],
    })
    assert.equal(html.includes('<img src=x'), false)
    assert.match(html, /&lt;img src=x/)
  })

  test('svg 直接摆进沙箱居中显示', async () => {
    const { html } = await buildPreviewDoc({
      kind: 'svg',
      entry: 'image.svg',
      files: [{ path: 'image.svg', content: '<svg viewBox="0 0 10 10"></svg>' }],
    })
    assert.match(html, /<svg viewBox="0 0 10 10">/)
    assert.match(html, /default-src 'none'/)
  })

  test('不认识的类型不画空白，给一句说明', async () => {
    const { html, error } = await buildPreviewDoc({ kind: 'code', files: [], entry: '' })
    assert.match(error, /不支持预览的类型/)
    assert.equal(html, '')
  })
})

describe('Vue 的路径解析', () => {
  test('相对路径按当前文件所在目录算', () => {
    assert.equal(resolvePath('App.vue', './components/Chart.vue'), 'components/Chart.vue')
    assert.equal(resolvePath('components/Chart.vue', '../utils/format.js'), 'utils/format.js')
    assert.equal(resolvePath('a/b/c.vue', './d.js'), 'a/b/d.js')
  })

  test('裸包名原样返回（vue 由调用方接住）', () => {
    assert.equal(resolvePath('App.vue', 'vue'), 'vue')
  })
})

describe('对话里的作品卡片', () => {
  const done = (preview, args = {}) => ({ type: 'tool', toolName: 'artifact', status: 'done', preview, args })

  test('成功的 create / update 画卡片，带上版本号和文件数', () => {
    const card = readArtifactCard(done(
      JSON.stringify({
        ok: true,
        artifact: { id: 'a_1', title: '看板', kind: 'web', version: 2, files: ['index.html', 'app.js'] },
      }),
      { action: 'update' },
    ))
    assert.equal(card.id, 'a_1')
    assert.equal(card.version, 2)
    assert.deepEqual(card.files, ['index.html', 'app.js'])
  })

  test('还在跑时先画占位卡，并把正在铺的文件名显示出来', () => {
    const card = readArtifactCard({
      type: 'tool',
      toolName: 'artifact',
      status: 'running',
      args: { action: 'create', title: '周报', kind: 'markdown', files: [{ path: 'README.md', content: 'x' }] },
    })
    assert.equal(card.pending, true)
    assert.equal(card.title, '周报')
    assert.deepEqual(card.files, ['README.md'])
  })

  /**
   * read 是模型自己读回内容，没有任何产出。画成卡片的话，用户会以为
   * "它又生成了一份一样的东西"。
   */
  test('read / 失败 / 结果解析不出来时不画卡片，退回普通工具卡', () => {
    assert.equal(readArtifactCard(done('{"ok":true,"artifact":{"id":"a_1"}}', { action: 'read' })), null)
    assert.equal(readArtifactCard(done('{"ok":false,"error":"old_str 找不到"}', { action: 'update' })), null)
    assert.equal(readArtifactCard(done('{"ok":true,"artifact":{"id":"a_1"', { action: 'create' })), null)
  })

  test('layoutBlocks 把它换成 artifact 项，失败的那次仍是工具卡', () => {
    const items = layoutBlocks([
      { type: 'text', text: '这就做' },
      done(JSON.stringify({ ok: true, artifact: { id: 'a_1', title: 'x', kind: 'web', version: 1 } }), { action: 'create' }),
      done('{"ok":false,"error":"boom"}', { action: 'write' }),
    ])
    assert.deepEqual(items.map((item) => item.kind), ['text', 'artifact', 'tool'])
  })

  /**
   * 摘要行绝不能落到通用的 `JSON.stringify(args)` —— create 的入参里躺着整份作品，
   * 几百 KB 拼成一行塞进卡片会把这一屏卡住。
   */
  test('摘要只取 action 和标题/路径，不碰文件内容', () => {
    assert.equal(
      toolBrief('artifact', { action: 'create', title: '销售看板', files: [{ path: 'a', content: 'x'.repeat(200000) }] }),
      'create 销售看板',
    )
    assert.equal(toolBrief('artifact', { action: 'update', id: 'a_1', path: 'app.js' }), 'update app.js')
    assert.equal(
      toolBrief('artifact', { action: 'write', id: 'a_1', files: [{ path: 'app.js', content: 'x' }] }),
      'write app.js',
    )
  })
})

describe('类型标签', () => {
  test('code 显示语言，其余显示中文类型名', () => {
    assert.equal(kindLabel({ kind: 'code', language: 'python' }), 'python')
    assert.equal(kindLabel({ kind: 'web' }), '网页')
    assert.equal(kindLabel({ kind: 'vue' }), 'Vue 组件')
    assert.equal(kindLabel({ kind: 'markdown' }), '文档')
  })
})

/**
 * 作品库的筛选。这是那个页面唯一有逻辑的地方，而它决定"我的东西找不找得到" ——
 * 搜不到比没有搜索更糟：用户会以为作品被删了。
 */
describe('作品库', () => {
  const list = [
    {
      id: 'a1', title: '销售看板', kind: 'web', version: 2,
      versions: [{ n: 1, files: [] }, { n: 2, files: [{ path: 'index.html' }, { path: 'app.js' }] }],
    },
    {
      id: 'a2', title: '周报', kind: 'markdown', version: 1,
      versions: [{ n: 1, files: [{ path: 'README.md' }] }],
    },
    {
      id: 'a3', title: '组件库', kind: 'vue', version: 1,
      versions: [{ n: 1, files: [{ path: 'App.vue' }, { path: 'components/Chart.vue' }] }],
    },
  ]
  const ids = (result) => result.map((item) => item.id)

  test('不传条件就是全部', () => {
    assert.equal(filterArtifacts(list).length, 3)
    assert.equal(filterArtifacts(list, { q: '  ', kind: '' }).length, 3)
  })

  test('按类型筛', () => {
    assert.deepEqual(ids(filterArtifacts(list, { kind: 'vue' })), ['a3'])
  })

  /** 记不住标题但记得"那个 Chart.vue"是很常见的，只搜标题会让人以为作品没了 */
  test('搜索同时匹配标题和文件名，且大小写不敏感', () => {
    assert.deepEqual(ids(filterArtifacts(list, { q: '看板' })), ['a1'])
    assert.deepEqual(ids(filterArtifacts(list, { q: 'chart.VUE' })), ['a3'])
    assert.deepEqual(ids(filterArtifacts(list, { q: '.md' })), ['a2'])
  })

  /** 只看当前版本的文件：旧版里删掉的文件不该再把作品搜出来 */
  test('文件名只匹配当前版本', () => {
    assert.deepEqual(ids(filterArtifacts(list, { q: 'index.html' })), ['a1'])
    assert.equal(filterArtifacts([{ ...list[0], version: 1 }], { q: 'index.html' }).length, 0)
  })

  test('类型与关键词是且的关系', () => {
    assert.equal(filterArtifacts(list, { q: '看板', kind: 'markdown' }).length, 0)
  })

  /**
   * 作品没有"新建"按钮（它是模型产出的）。所以向导必须**覆盖每一种能产出的类型** ——
   * 少一种，用户就永远不知道平台能做那件事。
   */
  test('向导的配方覆盖全部类型，每条都说得清它擅长什么', () => {
    assert.deepEqual(
      ARTIFACT_RECIPES.map((item) => item.kind).sort(),
      Object.keys(KIND_META).sort(),
      '配方表和能渲染的类型必须一一对上',
    )
    for (const item of ARTIFACT_RECIPES) {
      assert.ok(item.blurb.length > 8, `${item.kind} 的说明太短`)
      assert.ok(item.lead, `${item.kind} 少了话术前缀`)
      assert.ok(item.examples.length >= 2, `${item.kind} 的例子少于两条`)
      for (const example of item.examples) {
        assert.ok(example.length > 10, `${item.kind} 的例子太短，像功能名而不像人话`)
      }
    }
  })

  /**
   * 拼歪了的表现是"我选了画图，它给我写了段代码"—— 而用户完全看不出是哪一步错的。
   */
  test('拼话术：把类型说进去，空描述不拼，已经说过的不重复说', () => {
    assert.equal(
      composeArtifactPrompt('mermaid', '下单到发货的流程'),
      '画一张图：下单到发货的流程。',
    )
    assert.match(composeArtifactPrompt('vue', '一个数据表格'), /^用 Vue 3 写一个组件：一个数据表格/)
    assert.match(composeArtifactPrompt('vue', '一个数据表格'), /components\/ 下的子组件。$/)

    // 空描述拼不出话，按钮也该是禁用的
    assert.equal(composeArtifactPrompt('web', '   '), '')
    // 用户自己把话说全了就别再套一层
    const full = '帮我做一个网页：贷款计算器'
    assert.equal(composeArtifactPrompt('web', full), full)
    // 不认识的类型退化成原样，不吞掉用户的话
    assert.equal(composeArtifactPrompt('nope', '随便什么'), '随便什么')
  })
})

/**
 * 预览里的元素拾取：点一个元素，让助手只改那一处。
 *
 * 拾取器本身跑在沙箱里（要 DOM，node 测不了），这里钉住的是它的**契约**：
 * 哪些类型给这个能力、拾取器有没有被注入、以及选完之后拼给模型的那段话。
 */
describe('元素拾取', () => {
  const web = (over = {}) => buildPreviewDoc({
    kind: 'web',
    files: [{ path: 'index.html', content: '<button class="go">提交</button>' }],
    entry: 'index.html',
    ...over,
  })

  test('只有真的有 DOM 的类型才给这个能力', () => {
    assert.equal(supportsInspect('web'), true)
    assert.equal(supportsInspect('vue'), true)
    assert.equal(supportsInspect('svg'), true)
    // markdown / mermaid 的源码是文本和图语法，点中的节点在源码里不是一段可定位的标记
    assert.equal(supportsInspect('markdown'), false)
    assert.equal(supportsInspect('mermaid'), false)
    assert.equal(supportsInspect('code'), false)
  })

  test('拾取器注入进网页预览，且回报走 postMessage', async () => {
    const { html } = await web()
    assert.match(html, /__ap: 'picked'/)
    assert.match(html, /parent\.postMessage/)
    // 装在 </body> 之前：正文都在了它才初始化
    assert.ok(html.indexOf("__ap: 'picked'") < html.indexOf('</body>'))
  })

  test('模型自带完整文档时也注入得进去', async () => {
    const { html } = await web({
      files: [{ path: 'index.html', content: '<!doctype html><html><body><p>x</p></body></html>' }],
    })
    assert.match(html, /__ap: 'picked'/)
  })

  test('文档类预览不注入 —— 那里选了也没用', async () => {
    const { html } = await buildPreviewDoc({
      kind: 'markdown', entry: 'a.md', files: [{ path: 'a.md', content: '# x' }],
    })
    assert.equal(html.includes("__ap: 'picked'"), false)
  })

  /**
   * 拼给模型的话里，`html` 那一段是关键：`update` 要求 old_str 在文件里**唯一**出现，
   * 而元素的 outerHTML 正好是最可能唯一、又最好定位的那一段。
   */
  test('选中之后的话术带上定位信息和原文片段', () => {
    const prompt = composeElementPrompt({
      meta: { id: 'a_1', title: '看板', kind: 'web' },
      pick: { label: 'button.go', selector: 'div > button', html: '<button class="go">提交</button>', text: '提交' },
    })
    assert.match(prompt, /作品「看板」（id: a_1）/)
    assert.match(prompt, /button\.go/)
    assert.match(prompt, /div > button/)
    assert.match(prompt, /<button class="go">提交<\/button>/)
    assert.match(prompt, /update 定点修改/)
  })

  /**
   * Vue 的 DOM 是渲染出来的，源码里不存在一模一样的字符串。不说这句的话，
   * 模型会拿渲染结果当 old_str，然后收到"找不到"，再瞎改几轮。
   */
  test('Vue 要多说一句：那是渲染结果，去模板里找对应片段', () => {
    const prompt = composeElementPrompt({
      meta: { id: 'a_2', title: '组件', kind: 'vue' },
      pick: { label: 'button', selector: 'button', html: '<button>x</button>', text: 'x' },
    })
    assert.match(prompt, /渲染出来的 DOM/)
    assert.match(prompt, /\.vue 组件/)
  })

  test('缺少作品或选中信息时不拼半截话', () => {
    assert.equal(composeElementPrompt({ meta: null, pick: { label: 'a' } }), '')
    assert.equal(composeElementPrompt({ meta: { id: 'a' }, pick: null }), '')
  })

  /**
   * 发出去的是完整提示词，**显示出来的是结构化的东西** —— 与附件同一个套路。
   * 这一对必须能来回走：折不回来的话，刷新之后那条消息会从"一句话 + 一枚 chip"
   * 变成一堵机器写给机器的标记墙。
   */
  test('话术能折回成 chip：正文只剩用户自己说的那句', () => {
    const prompt = composeElementPrompt({
      meta: { id: 'a_1', title: '看板', kind: 'web' },
      pick: { label: 'button.go', selector: 'div > button', html: '<button class="go">提交</button>', text: '提交' },
      instruction: '把它改成蓝色的',
    })
    const { text, element } = parsePickedElement(prompt)
    assert.equal(text, '把它改成蓝色的')
    assert.equal(element.label, 'button.go')
    assert.equal(element.html, '<button class="go">提交</button>')
    assert.match(element.info, /作品「看板」/)
  })

  test('没有标记的普通消息原样返回，不误伤', () => {
    const plain = '帮我看看这段代码'
    assert.deepEqual(parsePickedElement(plain), { text: plain, element: null })
  })

  /**
   * 元素的 outerHTML 里出现三个反引号是可能的（页面里贴了段 markdown 示例）。
   * 围栏用四个就是为了不被自己的内容提前闭合 —— 闭早了，后面整段都会被当成正文。
   */
  test('内容里带三个反引号也不会把围栏撑破', () => {
    const html = '<pre>```js\nx\n```</pre>'
    const prompt = composeElementPrompt({
      meta: { id: 'a_1', title: 't', kind: 'web' },
      pick: { label: 'pre', selector: 'pre', html, text: '' },
      instruction: '删掉它',
    })
    const parsed = parsePickedElement(prompt)
    assert.equal(parsed.element.html, html)
    assert.equal(parsed.text, '删掉它')
  })
})
