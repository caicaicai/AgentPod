/**
 * 文件工具落到沙盒，而不是 agent 本地。
 *
 * 这是隔离契约 #2 的直接延伸：pi 内置的 write/read/edit 默认在**当前进程**读写文件，
 * 多租户服务里等于把别人的临时目录、服务配置交给模型。所以内置版被全关，
 * 换成打到沙盒的这一套。
 *
 * 最要紧的两条：
 *   1. 写进去的东西**真的在沙盒里**，agent 本地的工作目录一个字节都不该多；
 *   2. `/etc/passwd`、`../` 这类路径必须**明确报错**，不能静默改写成工作区内的路径 ——
 *      静默改写更糟，模型会以为自己读到了那个文件。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildTools } from '../src/agent/tools.js'
import { toWorkspaceRelative, SANDBOX_WORKSPACE_ROOT } from '../src/agent/sandbox-files.js'

/** 只记"被要求写/读了什么"，用一个 Map 当沙盒工作区 */
function fakeSandbox() {
  const files = new Map()
  const calls = []
  return {
    files,
    calls,
    mode: 'http',
    async putFile({ path: p, content }) {
      calls.push({ op: 'put', path: p })
      files.set(p, Buffer.from(content))
      return { ok: true }
    },
    async getFile({ path: p }) {
      calls.push({ op: 'get', path: p })
      if (!files.has(p)) {
        const error = new Error(`沙盒里没有文件 ${p}`)
        error.code = 'NOT_FOUND'
        throw error
      }
      return { path: p, content: files.get(p) }
    },
    async statFile({ path: p }) {
      calls.push({ op: 'stat', path: p })
      if (!files.has(p)) {
        const error = new Error(`沙盒里没有 ${p}`)
        error.code = 'NOT_FOUND'
        throw error
      }
      return { path: p, kind: 'file', size: files.get(p).length }
    },
    async exec() { return { exitCode: 0 } },
  }
}

describe('工作区相对路径的换算', () => {
  const cwd = '/tmp/ap-run-x/workspace'

  test('cwd 之内的路径换算成相对路径', () => {
    assert.equal(toWorkspaceRelative(`${cwd}/a.py`, cwd), 'a.py')
    assert.equal(toWorkspaceRelative(`${cwd}/sub/dir/a.py`, cwd), 'sub/dir/a.py')
  })

  test('跑出 cwd 的一律报错，不静默改写', () => {
    // 静默改写成工作区内的路径更糟：模型会以为自己读到了 /etc/passwd。
    for (const bad of ['/etc/passwd', '/tmp/ap-run-x/agent/secrets', `${cwd}/../escape`]) {
      assert.throws(() => toWorkspaceRelative(bad, cwd), /超出沙盒工作区/, `${bad} 应当被拒`)
    }
  })

  /**
   * 模型手里同时有两个绝对路径，**都是我们给的**：系统提示里的 agent 侧 cwd，
   * 和它自己 `pwd` 看到的沙盒路径。只认前者时，真实会话里出现过这一幕 ——
   * 模型 pwd 之后改用沙盒真路径，被我们回了「路径超出沙盒工作区」。
   */
  test('沙盒侧的绝对路径也认 —— 那是模型 pwd 看到的那个', () => {
    assert.equal(toWorkspaceRelative(`${SANDBOX_WORKSPACE_ROOT}/a.py`, cwd), 'a.py')
    assert.equal(toWorkspaceRelative(`${SANDBOX_WORKSPACE_ROOT}/sub/dir/a.py`, cwd), 'sub/dir/a.py')
    assert.equal(toWorkspaceRelative(SANDBOX_WORKSPACE_ROOT, cwd), '')
  })

  test('认了沙盒根之后，越界的仍然要拒', () => {
    for (const bad of [
      '/sandbox-root/home/.ssh/id_rsa',   // 同在 guest 挂载点下，但不是工作区
      '/sandbox-root/worktree/x',          // 前缀像 /sandbox-root/work 但不是它
      `${SANDBOX_WORKSPACE_ROOT}/../etc/passwd`,
    ]) {
      assert.throws(() => toWorkspaceRelative(bad, cwd), /超出沙盒工作区/, `${bad} 应当被拒`)
    }
  })

  test('报错信息要给出可用的写法，不能只说不行', () => {
    // 模型拿到「不许」但不知道「该怎么写」，下一步只会再猜一个绝对路径。
    assert.throws(() => toWorkspaceRelative('/etc/passwd', cwd), (error) => {
      assert.match(error.message, /相对路径/)
      assert.ok(error.message.includes(SANDBOX_WORKSPACE_ROOT), '没告诉模型工作区根在哪')
      return true
    })
  })
})

describe('write / read / edit 落到沙盒', () => {
  let cwd
  let sandbox
  let tools

  const call = (name, params) => {
    const tool = tools.find((t) => t.name === name)
    assert.ok(tool, `没有注册 ${name} 工具`)
    return tool.execute(`c-${name}`, params, undefined, () => {}, {})
  }

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'sbxfiles-'))
    sandbox = fakeSandbox()
    tools = buildTools({ cwd, sandbox, runContext: { runId: 'r1', username: 'e' } })
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('三个文件工具都注册了 —— 否则脚本只能靠 heredoc 进沙盒', () => {
    const names = tools.map((t) => t.name)
    for (const expected of ['bash', 'write', 'read', 'edit']) {
      assert.ok(names.includes(expected), `缺 ${expected}`)
    }
  })

  test('write 写进沙盒，agent 本地一个文件都不留', async () => {
    await call('write', { path: 'analyze.py', content: 'print("hi")\n' })

    assert.equal(sandbox.files.get('analyze.py').toString(), 'print("hi")\n')
    // 这一条是隔离契约：内置版会往这里写，换过来的这套不该碰它
    assert.deepEqual(await readdir(cwd), [], 'agent 本地工作目录被写入了')
  })

  test('写到多层子目录也能成功（worker 侧会自动建父目录）', async () => {
    // ops.mkdir 是有意的空操作，靠 worker 的 `mkdir -p`。这条用例守着那个假设：
    // worker 那边真改了，这里会红。
    await call('write', { path: 'src/tools/run.py', content: 'x' })
    assert.equal(sandbox.files.get('src/tools/run.py').toString(), 'x')
  })

  test('read 读得回来', async () => {
    await call('write', { path: 'a.txt', content: 'line1\nline2\n' })
    const result = await call('read', { path: 'a.txt' })
    const text = result.content.map((c) => c.text || '').join('')
    assert.match(text, /line1/)
    assert.match(text, /line2/)
  })

  test('edit 改的是沙盒里那份', async () => {
    await call('write', { path: 'run.sh', content: 'echo old\n' })
    await call('edit', { path: 'run.sh', edits: [{ oldText: 'old', newText: 'new' }] })
    assert.equal(sandbox.files.get('run.sh').toString(), 'echo new\n')
    assert.deepEqual(await readdir(cwd), [], 'agent 本地不该出现文件')
  })

  test('绝对路径逃逸被挡住', async () => {
    await assert.rejects(
      () => call('write', { path: '/etc/passwd', content: 'pwned' }),
      /超出沙盒工作区/,
    )
    // 也不能悄悄落到沙盒里的某个路径上
    assert.equal(sandbox.files.size, 0)
  })

  test('相对路径逃逸被挡住', async () => {
    await assert.rejects(
      () => call('write', { path: '../../escape.txt', content: 'x' }),
      /超出沙盒工作区/,
    )
    assert.equal(sandbox.files.size, 0)
  })

  test('读不存在的文件报得明确，不是空内容', async () => {
    await assert.rejects(() => call('read', { path: 'missing.py' }))
  })

  test('沙盒不可用时不注册文件工具 —— 免得模型对着一个必然失败的工具反复试', () => {
    const none = buildTools({ cwd, sandbox: { mode: 'none' }, runContext: { runId: 'r' } })
    assert.deepEqual(none.map((t) => t.name), [])
  })
})
