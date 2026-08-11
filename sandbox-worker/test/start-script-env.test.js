/**
 * `bin/start.sh` 基本结构检查。
 *
 * 标准 Docker 部署下，start.sh 只是一个轻量 wrapper，
 * 主要入口是 Dockerfile 的 ENTRYPOINT 直接运行 node。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const startScript = await readFile(path.join(here, '..', 'bin', 'start.sh'), 'utf8')

describe('start.sh 基本结构', () => {
  test('脚本头部是 bash shebang', () => {
    assert.match(startScript, /^#!\/bin\/bash/)
  })

  test('脚本使用 set -uo pipefail', () => {
    assert.match(startScript, /set -uo pipefail/)
  })

  test('脚本启动 node 进程', () => {
    assert.match(startScript, /node.*src\/index\.js/)
  })

  test('没有 容器节点 特有的 sleep 保活', () => {
    assert.equal(/sleep\s+9999999d/.test(startScript), false, '不应包含 容器节点 的 sleep 保活')
  })

  test('没有 sshd 启动', () => {
    assert.equal(/sshd/.test(startScript), false, '不应包含 sshd 启动')
  })

  test('没有 /export/App 路径', () => {
    assert.equal(/\/export\/App/.test(startScript), false, '不应包含 容器节点 的 /export/App 路径')
  })
})
