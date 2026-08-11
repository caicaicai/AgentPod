/**
 * Dockerfile 的静态检查：COPY/ADD 源路径存在性 + 基本约定。
 *
 * 构建上下文是仓库根。路径写错时 docker build 报的是
 *   COPY failed: file not found in build context
 * 而构建可能很慢（装依赖 + 构建前端），这里用几毫秒挡在提交之前。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile')

const read = (file) => readFileSync(file, 'utf8')
const joinContinuations = (text) => text.replace(/\\\r?\n\s*/g, ' ')

function expandArgs(text, value) {
  const defaults = new Map()
  for (const m of text.matchAll(/^\s*(?:ARG|ENV)\s+([A-Za-z_][A-Za-z0-9_]*)=("?)([^"\n]*)\2\s*$/gm)) {
    defaults.set(m[1], m[3])
  }
  let out = value
  for (let i = 0; i < 10; i += 1) {
    const next = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) => defaults.get(name) ?? whole)
    if (next === out) break
    out = next
  }
  return out
}

function copyPairs(file) {
  const text = read(file)
  const pairs = []
  for (const line of joinContinuations(text).split('\n')) {
    const match = line.match(/^\s*(COPY|ADD)\s+(.*)$/i)
    if (!match) continue
    const args = match[2].trim()
    if (/--from=/.test(args)) continue
    const parts = args.split(/\s+/).filter((p) => !p.startsWith('--'))
    if (parts.length < 2) continue
    const dest = parts[parts.length - 1]
    for (const src of parts.slice(0, -1)) {
      if (/^https?:\/\//i.test(src)) continue
      pairs.push({ instruction: match[1].toUpperCase(), src: expandArgs(text, src), dest: expandArgs(text, dest) })
    }
  }
  return pairs
}

describe('Agent Dockerfile 构建上下文（仓库根）', () => {
  test('Dockerfile 存在', () => {
    assert.ok(existsSync(DOCKERFILE), '仓库根下找不到 Dockerfile')
  })

  test('每个 COPY/ADD 源路径在仓库根下都存在', () => {
    const missing = []
    for (const { src, instruction } of copyPairs(DOCKERFILE)) {
      if (src.includes('${')) continue
      if (!existsSync(path.join(REPO_ROOT, src))) missing.push(`${instruction} ${src}`)
    }
    assert.deepEqual(missing, [], `这些源路径在仓库根下找不到：\n  ${missing.join('\n  ')}`)
  })

  test('确实解析到了源路径', () => {
    assert.ok(copyPairs(DOCKERFILE).length >= 1, '一个 COPY/ADD 源都没解析出来')
  })

  test('不能整个目录 COPY —— 仓库根下有 .env', () => {
    const wildcards = copyPairs(DOCKERFILE).filter(({ src }) => src === '.' || src === './' || src === '*')
    assert.deepEqual(wildcards, [], 'Dockerfile 里出现了整目录拷贝')
  })

  test('使用多阶段构建', () => {
    const text = read(DOCKERFILE)
    assert.match(text, /FROM\s+\S+\s+AS\s+/i, '没有检测到多阶段构建（FROM ... AS ...）')
  })

  test('最终阶段使用非 root 用户', () => {
    const text = read(DOCKERFILE)
    assert.match(text, /^USER\s+(?!root)/m, '最终镜像应该使用非 root 用户运行')
  })

  test('使用 tini 作为 init 进程', () => {
    const text = joinContinuations(read(DOCKERFILE))
    assert.match(text, /tini/i, '应该使用 tini 处理信号和僵尸进程')
  })

  test('启动脚本存在', () => {
    for (const name of ['start.sh', 'stop.sh']) {
      const file = path.join(REPO_ROOT, 'bin', name)
      assert.ok(existsSync(file), `缺 bin/${name}`)
    }
  })
})
