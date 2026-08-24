/**
 * 文档里指向**仓库内文件**的链接，得真的指到东西上。
 *
 * ── 为什么值得有这一条 ──────────────────────────────────────────────────
 *
 * 加它的那一刻，仓库里同时躺着两个已经断掉的链接，而且都不是无关紧要的：
 *
 *   1. 两份 README 的结尾都写着 `[MIT](LICENSE)` —— **而 LICENSE 文件不存在**。
 *      一个对外开源、README 里还写了 Contributing 流程的项目，仓库里没有许可证
 *      文本，法律上等于"保留所有权利"：任何人都不能合法使用它。这不是排版问题。
 *
 *   2. `docs/ARCHITECTURE.md` 有两处指向 `MIGRATION.md`，其中一处是
 *      "见 MIGRATION.md 的**进度表**" —— 也就是把"这个项目还没做什么"这个问题
 *      整个外包给了一个不存在的文件。`managed-skills/README.md` 还指了第三次。
 *
 * 两者的失效方式是一样的：**在本地什么都不会报错**。Markdown 渲染器照常把它画成
 * 一个蓝色的链接，只有点下去的人才知道是空的，而那个人通常是第一次来的读者。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 *
 * 只管**相对链接**（仓库内的文件），因为只有这种能在离线、无网络的测试里判定。
 * http(s):// 外链、纯锚点（`#section`）都跳过 —— 前者要联网，后者是页面内跳转，
 * 各有各的失效方式，不在这一条的射程里。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 不进去翻的目录：要么是依赖，要么是构建产物，都不是我们写的文档 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.github'])

function collectMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectMarkdown(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

/**
 * `[文字](目标)` 里的目标。
 *
 * 排除掉图片（`![]()`）之外的东西没必要 —— 图片同样该存在。真正要排除的是
 * **行内代码里的示例**，比如讲解语法时写的 `[foo](bar)`：那不是链接，是文档内容。
 * 用一个粗糙但够用的办法：先把成对反引号之间的内容抹掉，再找链接。
 */
function linkTargets(markdown) {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, '') // 围栏代码块
    .replace(/`[^`\n]*`/g, '') // 行内代码
  return [...withoutCode.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1])
}

function isRelative(target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false // http:, https:, mailto:, …
  if (target.startsWith('#')) return false // 页面内锚点
  if (target.startsWith('//')) return false // 协议相对
  return true
}

describe('文档里的仓库内链接都指到了真实文件', () => {
  const files = collectMarkdown(ROOT)

  test('至少扫到了几份文档（否则这条用例是在空跑）', () => {
    assert.ok(files.length >= 5, `只扫到 ${files.length} 份 markdown，收集逻辑多半坏了`)
  })

  for (const file of files) {
    const rel = path.relative(ROOT, file)
    test(rel, () => {
      const source = readFileSync(file, 'utf8')
      const broken = []
      for (const target of linkTargets(source)) {
        if (!isRelative(target)) continue
        // 去掉链接末尾的锚点：README.md#section 指的还是 README.md 这个文件
        const [filePart] = target.split('#')
        if (!filePart) continue
        const resolved = path.resolve(path.dirname(file), decodeURIComponent(filePart))
        if (!existsSync(resolved)) broken.push(target)
      }
      assert.deepEqual(
        broken,
        [],
        `${rel} 里这些链接指向的文件不存在（要么补上文件，要么改掉链接）：\n  ${broken.join('\n  ')}`,
      )
    })
  }

  /**
   * LICENSE 单独再断言一次。
   *
   * 上面那条已经能抓到"README 链接到不存在的 LICENSE"，但它的成立依赖于
   * **README 里恰好有那个链接**。哪天有人把链接删了（而不是把文件补上），
   * 上面就变绿了，而问题反而更严重了：许可证既不在文件里、也不在文档里。
   */
  test('LICENSE 文件存在且非空', () => {
    const license = path.join(ROOT, 'LICENSE')
    assert.ok(existsSync(license), '仓库根缺 LICENSE —— 没有它，"MIT" 只是一句说法')
    assert.ok(statSync(license).size > 500, 'LICENSE 短得不像一份完整的许可证文本')
    assert.match(readFileSync(license, 'utf8'), /MIT License/, 'LICENSE 的内容与 README 声明的 MIT 对不上')
  })

  /** package.json 的 license 字段：工具链（npm、SBOM 扫描、依赖审计）读的是它，不是 LICENSE 文件 */
  test('package.json 声明了 license', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    assert.equal(pkg.license, 'MIT', 'package.json 的 license 字段应与 LICENSE 文件一致')
  })
})
