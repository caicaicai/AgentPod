/**
 * 前端的目录约定（见 web/README.md 的「结构」一节）。
 *
 * 这两条都不会在 `npm run build` 里报出来，而坏掉的方式很难查：
 *
 *   1. **`.js` 里不许用 `@/` 别名**。那是 Vite 的东西，node 不认 —— 而
 *      `test/artifact-preview.test.js`、`test/attachments.test.js` 这些用例是用 node
 *      直接 import 那些 .js 的。写了别名，构建照样绿，报错却出现在一组
 *      看起来毫不相干的用例里，指向 node 的模块解析。
 *   2. **每条 import 都得指向真实存在的文件**。搬文件是这套结构的日常
 *      （某个零件从一个模块挪到另一个、或者上升到 components/），漏改一条的话
 *      Vite 会在打包时报，但如果那条路径只在某个懒加载分支里，就要等到用户点到才炸。
 *
 * 这里只做静态检查，不 import 任何前端代码，所以不需要 web/node_modules。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/src')

async function* walk(dir = '') {
  for (const entry of await readdir(path.join(SRC, dir), { withFileTypes: true })) {
    const child = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* walk(child)
    else if (child.endsWith('.vue') || child.endsWith('.js')) yield child
  }
}

/** 每个文件里的 `from '…'`，只留下指向本仓库的那些（裸包名不管） */
async function localImports() {
  const found = []
  for await (const file of walk()) {
    const source = await readFile(path.join(SRC, file), 'utf8')
    for (const [, spec] of source.matchAll(/from\s+'([^']+)'/g)) {
      if (spec.startsWith('.') || spec.startsWith('@/')) found.push({ file, spec })
    }
  }
  return found
}

describe('前端目录约定', () => {
  test('.js 里不用 @/ 别名 —— node 跑的那些用例不认它', async () => {
    const offenders = (await localImports())
      .filter(({ file, spec }) => file.endsWith('.js') && spec.startsWith('@/'))
      .map(({ file, spec }) => `${file} → ${spec}`)
    assert.deepEqual(offenders, [], '这些 .js 改成相对路径（见 web/README.md）')
  })

  test('每条 import 都指向真实存在的文件', async () => {
    const broken = []
    for (const { file, spec } of await localImports()) {
      const target = spec.startsWith('@/')
        ? path.join(SRC, spec.slice(2))
        : path.resolve(SRC, path.dirname(file), spec)
      if (!existsSync(target)) broken.push(`${file} → ${spec}`)
    }
    assert.deepEqual(broken, [])
  })

  /**
   * 页面只能待在 pages/。
   *
   * 这一条守的是这次重构本身：**页面曾经和零件混在一个平铺的 components/ 里**，
   * 于是"这个文件是一整页还是页上的一块"只能靠打开它来判断。
   * 新加一页时很容易顺手放回 modules/，那样这个目录过一年就又回到原样了。
   */
  test('pages/ 里就是那几页，别处没有 Page', async () => {
    const pages = []
    for await (const file of walk()) {
      if (file.endsWith('Page.vue')) pages.push(file)
    }
    assert.deepEqual(pages.sort(), [
      'pages/AdminPage.vue',
      'pages/ArtifactsPage.vue',
      'pages/ChatPage.vue',
      'pages/MarketPage.vue',
      'pages/SharePage.vue',
    ])
  })
})
