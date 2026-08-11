/**
 * playwright 加载路径的回归测试。
 *
 * 盯的是一个真实事故：底包用 `npm install -g` 装 playwright，靠
 * NODE_PATH 让它可解析，但 **NODE_PATH 只对 CJS require 生效，ESM import
 * 不看它**，而本项目是 "type": "module"。线上表现是浏览器能力整块不可用，
 * 报错却说"找不到包"，而包明明装着。
 *
 * 所以测试必须在**子进程**里跑：NODE_PATH 是进程启动时读的，在当前进程里
 * 改 process.env 不会影响模块解析，那样测出来的是假的。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const loaderSource = path.join(here, '..', 'src', 'browser', 'load-playwright.js')

/**
 * 造一棵隔离的目录树。
 *
 * **loader 必须复制进这棵树里跑**：它用的是 `createRequire(import.meta.url)`，
 * 解析基准是 loader 文件自己的位置，不是 cwd。留在仓库里跑的话，向上一层就
 * 找到了本仓库真实安装的 playwright，假包根本用不上 —— 测试会"通过"，
 * 但什么都没验证到。
 */
function makeTree({ withGlobalPlaywright }) {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-resolve-'))

  // 目录名必须是 node_modules：真实全局安装就在 /usr/local/lib/node_modules，
  // 这也是它能解析自己传递依赖的原因（向上找时正好命中同一个目录）。
  const globalDir = path.join(root, 'lib', 'node_modules')
  if (withGlobalPlaywright) {
    mkdirSync(path.join(globalDir, 'playwright'), { recursive: true })
    mkdirSync(path.join(globalDir, 'playwright-core'), { recursive: true })

    writeFileSync(path.join(globalDir, 'playwright-core', 'package.json'),
      JSON.stringify({ name: 'playwright-core', version: '0.0.0', main: 'index.js' }))
    writeFileSync(path.join(globalDir, 'playwright-core', 'index.js'),
      'module.exports = { marker: "core" }')

    writeFileSync(path.join(globalDir, 'playwright', 'package.json'),
      JSON.stringify({ name: 'playwright', version: '0.0.0', main: 'index.js' }))
    writeFileSync(path.join(globalDir, 'playwright', 'index.js'),
      'const core = require("playwright-core");\n' +
      'module.exports = { chromium: { name: "fake" }, coreMarker: core.marker }')
  }

  // 与容器一致的深度：/app/src/browser/load-playwright.js
  const appDir = path.join(root, 'App')
  const browserDir = path.join(appDir, 'src', 'browser')
  mkdirSync(browserDir, { recursive: true })
  writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ type: 'module' }))
  const loader = path.join(browserDir, 'load-playwright.js')
  copyFileSync(loaderSource, loader)

  return { root, globalDir, browserDir, loader }
}

function runNode(script, { cwd, nodePath }) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: { ...process.env, NODE_PATH: nodePath ?? '' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function lastLine(out) {
  return out.trim().split('\n').pop()
}

describe('playwright 加载', () => {
  test('只装在全局（仅 NODE_PATH 可达）时也能加载', () => {
    const t = makeTree({ withGlobalPlaywright: true })
    try {
      const out = runNode(
        `const { loadPlaywright } = await import(${JSON.stringify(t.loader)});\n` +
        'const pw = await loadPlaywright();\n' +
        'console.log(JSON.stringify({ chromium: Boolean(pw.chromium), core: pw.coreMarker }));',
        { cwd: t.browserDir, nodePath: t.globalDir },
      )
      const result = JSON.parse(lastLine(out))
      assert.equal(result.chromium, true, '应拿到 playwright 且带 chromium')
      assert.equal(result.core, 'core', '传递依赖 playwright-core 也应解析到')
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })

  test('裸 ESM import 在同样条件下是失败的（证明上一条不是白测）', () => {
    // 这条不是多余的：如果哪天 Node 让 ESM 也认 NODE_PATH，上一条就失去了
    // 意义而不会有人察觉。这里把"当年为什么要加 CJS 回退"钉住。
    const t = makeTree({ withGlobalPlaywright: true })
    try {
      let failed = false
      let message = ''
      try {
        runNode('await import("playwright")', { cwd: t.browserDir, nodePath: t.globalDir })
      } catch (error) {
        failed = true
        message = String(error.stderr || '')
      }
      assert.equal(failed, true, 'ESM import 不该认 NODE_PATH')
      assert.match(message, /Cannot find package 'playwright'/,
        '报错应正是线上看到的那句"找不到包"')
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })

  test('放进 node_modules 后 ESM 直接可解析（底包软链走的就是这条）', () => {
    const t = makeTree({ withGlobalPlaywright: true })
    try {
      // 模拟 Dockerfile 里的 /node_modules/playwright 软链
      const nm = path.join(t.root, 'node_modules')
      mkdirSync(nm, { recursive: true })
      symlinkSync(path.join(t.globalDir, 'playwright'), path.join(nm, 'playwright'))

      const out = runNode(
        'const pw = await import("playwright");\n' +
        'const m = pw.default ?? pw;\n' +
        'console.log(JSON.stringify({ chromium: Boolean(m.chromium), core: m.coreMarker }));',
        { cwd: t.browserDir, nodePath: '' },   // 注意：不给 NODE_PATH
      )
      const result = JSON.parse(lastLine(out))
      assert.equal(result.chromium, true, '软链之后 ESM 应能直接解析')
      assert.equal(result.core, 'core',
        '传递依赖也应解析到 —— Node 把软链解析成真实路径，正好命中全局目录')
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })

  test('两条路都失败时错误信息把两个原因都带上', () => {
    const t = makeTree({ withGlobalPlaywright: false })
    try {
      const out = runNode(
        `const { loadPlaywright } = await import(${JSON.stringify(t.loader)});\n` +
        'try { await loadPlaywright(); console.log("UNEXPECTED_OK") }\n' +
        'catch (e) { console.log(JSON.stringify(e.message)) }',
        { cwd: t.browserDir, nodePath: '' },
      )
      const raw = lastLine(out)
      assert.notEqual(raw, 'UNEXPECTED_OK', '树里没有 playwright，不该加载成功')
      const message = JSON.parse(raw)
      assert.match(message, /ESM import 失败/, '要说明 ESM 那条路怎么失败的')
      assert.match(message, /CJS require 失败/, '也要说明 CJS 那条路怎么失败的')
      assert.match(message, /docker\/base\/Dockerfile/, '要指向该去哪儿修')
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })
})
