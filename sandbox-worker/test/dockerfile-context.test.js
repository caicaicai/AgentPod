/**
 * Worker Dockerfile 的静态检查。
 *
 * 构建上下文是仓库根（docker compose 用 -f sandbox-worker/Dockerfile 指定），
 * 所以 COPY 的源路径要带 sandbox-worker/ 前缀。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const DOCKERFILE = path.join(REPO_ROOT, 'sandbox-worker/Dockerfile')

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

function copySources(file) {
  const text = read(file)
  const joined = joinContinuations(text)
  const sources = []
  for (const line of joined.split('\n')) {
    const match = line.match(/^\s*(COPY|ADD)\s+(.*)$/i)
    if (!match) continue
    const args = match[2].trim()
    if (/--from=/.test(args)) continue
    const parts = args.split(/\s+/).filter((p) => !p.startsWith('--'))
    if (parts.length < 2) continue
    for (const src of parts.slice(0, -1)) {
      if (/^https?:\/\//i.test(src)) continue
      sources.push({ src: expandArgs(text, src), instruction: match[1].toUpperCase() })
    }
  }
  return sources
}

describe('Worker Dockerfile 构建上下文（仓库根）', () => {
  test('Dockerfile 存在', () => {
    assert.ok(existsSync(DOCKERFILE), '找不到 sandbox-worker/Dockerfile')
  })

  test('每个 COPY/ADD 源路径在仓库根下都存在', () => {
    const missing = []
    for (const { src, instruction } of copySources(DOCKERFILE)) {
      const expanded = expandArgs(read(DOCKERFILE), src)
      if (expanded.includes('${')) continue
      if (!existsSync(path.join(REPO_ROOT, expanded))) missing.push(`${instruction} ${expanded}`)
    }
    assert.deepEqual(missing, [], `这些源路径在仓库根下找不到：\n  ${missing.join('\n  ')}`)
  })

  test('确实解析到了源路径', () => {
    assert.ok(copySources(DOCKERFILE).length >= 2, `只解析出 ${copySources(DOCKERFILE).length} 个源`)
  })

  test('sandbox-worker/ 下的源路径带子目录名', () => {
    const workerSources = copySources(DOCKERFILE)
      .map(({ src }) => expandArgs(read(DOCKERFILE), src))
      .filter((src) => src.startsWith('sandbox-worker/'))
    assert.ok(workerSources.length >= 1, 'Worker 代码的 COPY 源应该以 sandbox-worker/ 开头')
  })

  test('使用 tini 作为 init 进程', () => {
    const text = joinContinuations(read(DOCKERFILE))
    assert.match(text, /tini/i, 'Worker 应该使用 tini 处理信号和僵尸进程')
  })
})
